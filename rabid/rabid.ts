// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as server from '../liminal/http-server.ts';
import * as strings from "../liminal/strings.ts";
import * as config from './config.ts';
import * as templates from './templates.ts';
import {db} from "../liminal/db.ts";
import {Markup, h} from '../liminal/markup.ts';
import {exists as fileExists} from "std/fs/mod.ts"
import * as home from './home-page.ts';
import * as volunteer from './volunteer.ts';
import * as timesheet from './timesheet.ts';
import * as event from './event.ts';
import * as commitment from './commitment.ts';
import * as table from '../liminal/table.ts';
import {serialize, path} from "../liminal/serializable.ts";
import {lazy} from '../liminal/lazy.ts';
import {activityReport, dailyActivityReport} from './activity_report.ts';
import { Temporal } from 'temporal-polyfill';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';
import * as security from '../liminal/security.ts';
import {LiminalApp, type LiminalServerConfig, type TestClientSession, type TestCase} from '../liminal/liminal.ts';
import {TEST_RUNS} from './browser_test_demo.ts';

// Kept for compatibility; the generic server config now lives in liminal.
export type RabidServerConfig = LiminalServerConfig;

const constructorRoutes: Record<any, any> = {
    TableView: table.TableView,
};

/**
 * The Red Raccoon volunteer app.  All the generic server/framework machinery -
 * route dispatch, the HTTP handler, server lifecycle, the browser-test bridge and
 * the /eval endpoint - lives in LiminalApp; Rabid supplies the app-specific bits
 * (its tables, route scope, login/auth, page template) through the hooks below.
 */
export class Rabid extends LiminalApp {

    routes: Record<string, any>;
    pages: Record<string, any>;

    @path get config() { return new config.ConfigTable(); }
    @path get volunteer() { return new volunteer.VolunteerTable(); }
    @path get passwordHash() { return new volunteer.PasswordHashTable(); }
    @path get volunteerLoginSession() { return new volunteer.VolunteerLoginSessionTable(); }
    @path get timesheet_entry() { return new timesheet.TimesheetEntryTable(); }
    @path get event() { return new event.EventTable(); }
    @path get event_commitment() { return new commitment.EventCommitmentTable(); }

    @lazy
    get tables() {
        return [this.config, this.volunteer, this.passwordHash, this.volunteerLoginSession, this.timesheet_entry, this.event, this.event_commitment];
    }

    home() { return templates.page('home', home.home()); }
    volunteers() { return templates.page('Volunteers', this.volunteer.renderSearchableVolunteers()); }

    constructor() {
        super();
        this.pages = {
            home:()=>this.home(),
            volunteers:()=>this.volunteers(),
            activityReport:()=>templates.page('Activity Report', activityReport()),
            dailyActivityReport:()=>templates.page(
                'Daily Activity Report',
                dailyActivityReport(
                    Temporal.Now.plainDateISO().subtract({ days: 30 }),
                    Temporal.Now.plainDateISO()
                )
            ),
        };

        this.routes = Object.assign(
            {},
            {rabid: this},
            this.pages,
            constructorRoutes,
        );
    }

    [serialize](): string {
        return 'rabid';
    }

    // ----- LiminalApp hooks --------------------------------------------------

    get appName(): string { return 'rabid'; }

    // Resolve the session token into the request's security context (one trusted
    // lookup of the actor's own record, before any actor context exists).
    resolveSecurityContext(session_token: string | undefined): security.SecurityContext {
        return security.runSystem(() => {
            const session = session_token ? this.volunteerLoginSession.getBySessionToken.first({session_token}) : undefined;
            const actor = session ? this.volunteer.getById(session.volunteer_id) : undefined;
            return {
                actorId: session?.volunteer_id,
                roles: security.rolesFromPermissionsField(actor?.permissions),
            };
        });
    }

    // Always read the db_purpose marker as a trusted op (the config query must not
    // be subject to the caller's field-read guards).
    getDbPurpose(): string | undefined {
        try { return security.runSystem(() => this.config.getDbPurpose()); }
        catch { return undefined; }
    }

    // Test-client durable identity lives on the login-session row.
    stampTestClientOptIn(session_token: string, now: string): void {
        this.volunteerLoginSession.stampTestClientOptIn(session_token, now);
    }
    stampTestClientHeartbeat(session_token: string, now: string): void {
        this.volunteerLoginSession.stampTestClientHeartbeat(session_token, now);
    }
    mostRecentTestClient(): TestClientSession | undefined {
        return this.volunteerLoginSession.mostRecentTestClient.first({});
    }

    makePage(title: any, body: any): any { return templates.page(title, body); }

    async resourceContentDirs(): Promise<Record<string, string>> {
        return {'/resources/': await findResourceDir('resources') + '/'};
    }

    testRuns(): Record<string, TestCase[]> { return TEST_RUNS; }

    // Wrap a page() in the site document (full load) or reduce it to body-only +
    // <title> (htmx partial swap).  The test-client nav link is gated on isTestDb.
    protected override coercePageResult(result: any, isHtmxRequest: boolean): any {
        if(templates.isPage(result))
            return isHtmxRequest
                ? [[h.title, {}, result.title], result.body]
                : templates.pageTemplate({title: result.title, body: result.body, showTestClientLink: this.isTestDb});
        return result;
    }

    // Unauthenticated requests are sent to the login page (except the login POST).
    protected override rewriteUnauthenticatedRoute(jsExprSrc: string, ctx: security.SecurityContext, requestUrl: string): string | undefined {
        const allowedWithoutLogin = new Set(['rabid.loginRequest(bodyArgs)']);
        const loggedIn = ctx.actorId !== undefined;
        if(loggedIn || allowedWithoutLogin.has(jsExprSrc)) return undefined;
        return `rabid.login(${JSON.stringify(requestUrl)})`;
    }

    // Override so /eval server-target code sees RABID's lexical scope (its tables
    // etc.), not liminal's - direct eval only reaches names visible at this site.
    protected override evalServer(js: string): Promise<any> {
        const rabid = this; // exposed to the eval'd code
        return security.runSystem(() =>
            // deno-lint-ignore no-eval
            eval(`(async () => { ${js}\n})()`));
    }

    // ----- Login / logout (app-specific auth) --------------------------------

    login(targetUrl: string, errorMessage?: string): Markup {

        // TODO: rendering the login page while already logged in is confusing - probably 301 to the
        //       home page if already logged in.

        const body = [
            [h.div, {class: 'container mt-5'},
                [h.div, {class: 'row justify-content-center'},
                    [h.div, {class: 'col-md-6 col-lg-5'},
                        [h.div, {class: 'card shadow'},
                            [h.div, {class: 'card-body p-5'},
                                [h.h1, {class: 'text-center mb-2'}, 'Welcome to Rabid'],
                                [h.p, {class: 'text-center text-muted mb-4'}, 'The Red Raccoon Volunteer System'],

                                errorMessage
                                    ? [h.div, {class: 'alert alert-danger', role: 'alert'}, errorMessage]
                                    : undefined,

                                [h.form, {name: 'login', method: 'post', action:'rabid.loginRequest(bodyArgs)'},
                                    [h.div, {class:"form-group mb-3"},
                                        [h.label, {for:"email"}, 'Email address'],
                                        [h.input, {
                                            type:"email",
                                            class:"form-control",
                                            name:"email",
                                            id:"email",
                                            placeholder:"volunteer@example.com",
                                            required: true
                                        }],
                                    ],

                                    [h.div, {class:"form-group mb-4"},
                                        [h.label, {for:"password"}, 'Password'],
                                        [h.input, {
                                            type:"password",
                                            class:"form-control",
                                            name:"password",
                                            id:"password",
                                            placeholder:"Enter your password",
                                            required: true
                                        }]
                                    ],

                                    [h.input, {type:'hidden', name: 'targetUrl', value: targetUrl}],

                                    [h.button, {type:"submit", class:"btn btn-primary btn-block w-100"}, 'Sign In'],

                                    [h.div, {class: 'text-center mt-3'},
                                       [h.a, {href: 'mailto:info@redraccoon.org', class: 'text-decoration-none'}, 'Contact info@redraccoon.org for password help']
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ];

        return templates.page('Login', body);
    }


    loginRequest(args: {email?: string, password?: string, targetUrl?: string}) {

        const {email, password} = args;
        const targetUrl = args.targetUrl || '/';

        const reRenderWithError = (message: string) =>
            this.login(targetUrl, message);

        if(!email)
            return reRenderWithError('Please enter your email address');
        if(!password)
            return reRenderWithError('Please enter your password');

        // --- Lookup volunteer by email (before the actor is known - trusted op).
        const volunteer = security.runSystem(() => rabid.volunteer.byEmail.first({email}));
        if(!volunteer)
            return reRenderWithError('No account was found for that email address');

        const passwordHashRecord = rabid.passwordHash.byVolunteerId.first({volunteer_id: volunteer.volunteer_id});
        const {password_salt, password_hash} = passwordHashRecord ?? {};
        if(!password_salt || !password_hash)
            return reRenderWithError('No password has been set for this account');

        const hashedSuppliedPassword = passwordUtils.hashPassword(password, password_salt);
        if(hashedSuppliedPassword !== password_hash)
            return reRenderWithError('Incorrect password');

        const now = date.currentSqliteDateTime();
        const session_token = passwordUtils.generateSessionToken();
        const sessionId = rabid.volunteerLoginSession.insert({
            session_token,
            volunteer_id: volunteer.volunteer_id,
            start_time: now,
            last_resume_time: now,
            last_ip: '', // TODO
        });

        const response = server.forwardResponse(targetUrl);
        // Max-Age is the 400-day browser cap; the authoritative session lifetime is
        // the volunteer_session row (deleting it ends the session regardless).
        const fourHundredDaysInSeconds = 400 * 24 * 60 * 60;
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=${session_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${fourHundredDaysInSeconds}`;
        return response;
    }

    /**
     * Log out: clear the session (server record + client cookie) and redirect home.
     */
    logout(session_token?: string): server.Response {
        if(session_token) {
            // If this session was a test client, drop its in-memory channel state.
            try { this.testClientChannel.drop(session_token); } catch(_e) { /* ignore */ }
            db().execute<{session_token: string}>(
                'DELETE FROM volunteer_session WHERE session_token = :session_token',
                {session_token});
        }
        const response = server.forwardResponse('/');
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
        return response;
    }
}

/**
 * Locate the in-source-tree resource directory (.js/.css/images) relative to this
 * file, so it can be served as static content.  Only file: urls are supported.
 */
async function findResourceDir(resourceDirName: string = 'resources') {
    const serverFileUrl = new URL(import.meta.url);
    if(serverFileUrl.protocol !== 'file:')
        throw new Error(`rabid server can only be run (for now) with it's code on the local filesystem (to allow access to resource files) - got server file url - ${serverFileUrl} with protocol ${serverFileUrl.protocol}`);
    const serverFilePath = decodeURIComponent(serverFileUrl.pathname);
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/rabid/rabid.ts')+'/'+resourceDirName;
    const resourceMarkerPath = resourceDir+'/'+'resource_dir_marker.txt';
    if(!await fileExists(resourceMarkerPath))
        throw new Error(`resource directory ${resourceDir} is missing marker file ${resourceMarkerPath}`);

    return resourceDir;
}

export let rabid: Rabid = undefined as unknown as Rabid;

export function getRabid(): Rabid {
    return rabid ??= new Rabid();
}

if (import.meta.main) {
    let rabid = getRabid();
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'serve':
            rabid.startServer({hostname: 'localhost', port: 8888});
            break;
        case 'test-run': {
            // Start the server, run the named browser test run against a connected
            // client, then exit with a pass/fail code.  startServer() resolves once
            // Deno.serve is listening, so the run and the server run concurrently.
            const runName = args[1] ?? 'demo';
            await rabid.startServer({hostname: 'localhost', port: 8888});
            const code = await rabid.runNamedTestRun(runName);
            Deno.exit(code);
            break;
        }
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
