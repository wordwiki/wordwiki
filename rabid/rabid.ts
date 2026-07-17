// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as server from '../liminal/http-server.ts';
import * as strings from "../liminal/strings.ts";
import {block} from "../liminal/strings.ts";
import * as action from "../liminal/action.ts";
import * as config from './config.ts';
import * as templates from './templates.ts';
import {db} from "../liminal/db.ts";
import {Markup, h} from '../liminal/markup.ts';
import {exists as fileExists} from "std/fs/mod.ts"
import * as home from './home-page.ts';
import * as volunteer from './volunteer.ts';
import * as timesheet from './timesheet.ts';
import * as event from './event.ts';
import * as volunteer_time from './volunteer_time.ts';
import * as sale from './sale.ts';
import * as service from './service.ts';
import * as group from './group.ts';
import * as committee from './committee.ts';
import * as task from './task.ts';
import * as gallery from './gallery.ts';
import * as extractionJob from './extraction_job.ts';
import * as site from '../components/site.ts';
import * as rabidSite from './rabid-site.ts';   // mounts RabidSiteView + registers rabid blocks
import { Llm, loadLlm } from '../liminal/llm.ts';
import * as photo from '../liminal/photo.ts';
import {ensureDir} from "std/fs/mod.ts";
import * as table from '../liminal/table.ts';
import {serialize, path} from "../liminal/serializable.ts";
import {lazy} from '../liminal/lazy.ts';
import {activityReport, dailyActivityReport, activityRangeQuery} from './activity_report.ts';
import * as pageQueries from './page-queries.ts';
import { Temporal } from 'temporal-polyfill';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';
import * as security from '../liminal/security.ts';
import {route, routeMutation, authenticated, hostOrAdmin, publicRoute} from '../liminal/security.ts';
import {RouteDeniedError} from '../liminal/routeterp.ts';
import {LiminalApp, type LiminalServerConfig, type TestClientSession, type TestCase} from '../liminal/liminal.ts';
import * as schemaUpgrade from '../liminal/schema-upgrade.ts';
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
    // Service getters are navigation: reaching any table requires a login (the
    // leaf method then carries its own route perm).  The internal auth tables
    // (passwordHash/passwordReset/volunteerLoginSession) are deliberately NOT
    // exposed as routes - they stay unreachable from a URL.
    @route(authenticated) @path get volunteer() { return new volunteer.VolunteerTable(); }
    @path get passwordHash() { return new volunteer.PasswordHashTable(); }
    @path get passwordReset() { return new volunteer.PasswordResetTable(); }
    @path get volunteerLoginSession() { return new volunteer.VolunteerLoginSessionTable(); }
    @route(authenticated) @path get timesheet_entry() { return new timesheet.TimesheetEntryTable(); }
    @route(authenticated) @path get event() { return new event.EventTable(); }
    @route(authenticated) @path get event_commitment() { return new event.EventCommitmentTable(); }
    @route(authenticated) @path get event_checkin() { return new event.EventCheckinTable(); }
    @route(authenticated) @path get gallery_photo() { return new gallery.GalleryPhotoTable(); }
    @route(authenticated) @path get extraction_job() { return new extractionJob.ExtractionJobTable(); }
    @route(authenticated) @path get event_retrospective() { return new event.EventRetrospectiveTable(); }
    // A view-service (not a table): the reconciled per-volunteer time view.
    @route(authenticated) @path get volunteer_time() { return new volunteer_time.VolunteerTimeService(); }
    @route(authenticated) @path get sale() { return new sale.SaleTable(); }
    @route(authenticated) @path get service() { return new service.ServiceTable(); }
    @route(authenticated) @path get volunteer_group() { return new group.VolunteerGroupTable(); }
    @route(authenticated) @path get group_member() { return new group.GroupMemberTable(); }
    @route(authenticated) @path get committee() { return new committee.CommitteeTable(); }
    @route(authenticated) @path get project() { return new task.ProjectTable(); }
    @route(authenticated) @path get task() { return new task.TaskTable(); }
    @route(authenticated) @path get subtask() { return new task.SubtaskTable(); }

    // The shared site editor (components/): editable content pages built from a flat
    // flow of registry-dispatched blocks.  siteView is rabid's SiteView subclass
    // (edit policy + chrome + rabid blocks - see rabid-site.ts); it coordinates the
    // three schema tables, which are mounted so their query/FK routes resolve.
    @route(authenticated) @path get site() { return new site.SiteTable(); }
    @route(authenticated) @path get sitePage() { return new site.PageTable(); }
    @route(authenticated) @path get block() { return new site.BlockTable(); }
    @route(authenticated) @path get siteView() { return new rabidSite.RabidSiteView(this.site, this.sitePage, this.block); }

    // The LLM client for scan -> extract (liminal/llm.ts).  Lazy, like the mailer:
    // reads rabid-anthropic-credential.json, degrading to a DisabledLlm when absent.
    // The setter lets tests inject a fake (no network / no key).
    private _llm: Llm | undefined = undefined;
    get llm(): Llm { return this._llm ??= loadLlm('rabid'); }
    set llm(l: Llm) { this._llm = l; }

    // Photo upload + on-demand presentation sizing (liminal/photo.ts).  The
    // stores live beside the db: they are data, not code.
    @route(authenticated) @path get photo() {
        return new photo.PhotoService({
            contentDir: 'database/content',
            derivedDir: 'database/derived',
            mountPath: 'rabid.photo',
        });
    }

    // Admin maintenance: drop every derived photo size so they regenerate with
    // the current derivation (run after changing the crop/resize logic - the
    // derived store is closure-keyed, so a changed derivation is stale until
    // cleared).  A mutation (deletes cached files); originals are untouched and
    // the cache rebuilds lazily on next view.
    @routeMutation(security.hasRole('admin'))
    async rebuildPhotoDerivatives() {
        const {cleared} = await this.photo.clearDerivedStore();
        return {action: 'alert',
                message: `Cleared photo cache (${cleared.join(', ') || 'nothing to clear'}). ` +
                         `Images regenerate as they are viewed.`};
    }

    @lazy
    get tables() {
        return [this.config, this.volunteer, this.passwordHash, this.passwordReset, this.volunteerLoginSession, this.timesheet_entry, this.event, this.event_commitment, this.event_checkin, this.event_retrospective, this.sale, this.service, this.volunteer_group, this.group_member, this.committee, this.project, this.task, this.subtask, this.gallery_photo, this.extraction_job, this.site, this.sitePage, this.block];
    }

    // Pages that carry route-borne view state (page-state; liminal.md § On-page
    // view state) take the `{}` argument the dispatch passes through from the
    // route expression, e.g. /timesheets({from:"2025-01-01"}).
    home() { return templates.page('home', home.home()); }
    volunteers() { return templates.page('Volunteers', this.volunteer.renderVolunteersPage()); }
    events(up?: Record<string, any>, past?: Record<string, any>) { return templates.page('Events', this.event.renderEventsPage(up, past)); }
    sales(q?: Record<string, any>) { return templates.page('Sales', this.sale.renderSalesPage(q)); }
    servicePage(q?: Record<string, any>) { return templates.page('Service', this.service.renderServicePage(q)); }
    timesheets(q?: Record<string, any>) { return templates.page('Timesheets', this.timesheet_entry.renderTimesheetsPage(q)); }
    committees(q?: Record<string, any>) { return templates.page('Committees', this.committee.renderCommitteesPage(q)); }
    projects(q?: Record<string, any>) { return templates.page('Projects', this.project.renderProjectsPage(q)); }
    tasksPage(q?: Record<string, any>) { return templates.page('Tasks', this.task.renderTasksPage(q)); }
    templatesPage() { return templates.page('Checklist templates', this.project.renderTemplatesPage()); }
    // "Today's Ad-hoc": the day's Ad-hoc catch-all event, materialised on demand
    // (1-1 per day, race-safe).  Host/admin only - it's where drop-in activity
    // (services/sales not tied to a scheduled event) gets recorded.  A stable URL
    // that re-resolves "today" each day.  (Named for the catch-all it lands on -
    // NOT "today's log", which would imply a log of ALL of today's activity.)
    todaysLog() {
        const ctx = security.current();
        if(!(ctx?.system || ctx?.roles.has('host') || ctx?.roles.has('admin')))
            throw new RouteDeniedError('page');
        const id = this.event.catchAllForToday(/*create*/ true)!;
        return templates.page("Today's Ad-hoc", this.event.renderEventDetail(id));
    }

    constructor() {
        super();
        // Single-venue org (a durable assumption): all stored dates/times are
        // wall-clock at the venue.  Pin the org zone so "now"/"today"
        // (date.orgNow/orgToday) are right regardless of the server's zone.
        date.setOrgTimeZone('America/Toronto');
        this.pages = {
            home:()=>this.home(),
            volunteers:()=>this.volunteers(),
            events:(up?: any, past?: any)=>this.events(up, past),
            sales:(q?: any)=>this.sales(q),
            // ('service' the page vs this.service the table: the page binding
            // name is what appears in the URL, the method avoids the collision.)
            service:(q?: any)=>this.servicePage(q),
            // The yearly services-by-area map (Reports); windowed like /service.
            serviceMap:(q?: any)=>templates.page('Services by area', this.service.renderServiceMapPage(q)),
            timesheets:(q?: any)=>this.timesheets(q),
            committees:(q?: any)=>this.committees(q),
            projects:(q?: any)=>this.projects(q),
            // ('tasks' the page vs this.task the table - same naming move as
            // service/servicePage.)
            tasks:(q?: any)=>this.tasksPage(q),
            templates:()=>this.templatesPage(),
            todaysLog:()=>this.todaysLog(),
            activityReport:(q?: any)=>templates.page('Activity Report', activityReport(q)),
            // The range now rides the route as a {} arg (default: last 120 days,
            // drifting) instead of being frozen here - see activity_report.ts.
            dailyActivityReport:(q?: any)=>templates.page(
                'Daily Activity Report', dailyActivityReport(q)),
        };

        // Page routes are bare identifiers (auto-invoked by dispatch), so they are
        // NOT @route-gated like the rabid.* member routes.  Wrap each to require a
        // login, so anonymous page nav throws RouteDeniedError and is bounced to
        // login uniformly.  No page is public; the anonymous entry points are
        // member routes (rabid.login / loginRequest / resetPassword*).
        const requireLogin = (fn: (...a: any[]) => any) =>
            (...args: any[]) => {
                const ctx = security.current();
                if(!ctx?.system && ctx?.actorId === undefined)
                    throw new RouteDeniedError('page');
                return fn(...args);
            };
        const gatedPages = Object.fromEntries(
            Object.entries(this.pages).map(([name, fn]) => [name, requireLogin(fn as any)]));

        this.routes = Object.assign(
            {},
            {rabid: this},
            gatedPages,
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
        // The photo stores are served as plain files: the sha256 path IS the
        // capability (unguessable), and the authenticated rabid.photo.serve
        // route is the only thing that hands the URLs out.
        await ensureDir('database/content');
        await ensureDir('database/derived');
        return {
            '/resources/': await findResourceDir('resources') + '/',
            '/content/': 'database/content/',
            '/derived/': 'database/derived/',
        };
    }

    testRuns(): Record<string, TestCase[]> { return TEST_RUNS; }

    // Wrap a page() in the site document (full load) or reduce it to body-only +
    // <title> (htmx partial swap).  The test-client nav link is gated on isTestDb.
    protected override coercePageResult(result: any, isHtmxRequest: boolean): any {
        if(templates.isPage(result))
            return isHtmxRequest
                ? [[h.title, {}, result.title], result.body]
                : templates.pageTemplate({title: result.title, body: result.body,
                                          showTestClientLink: this.isTestDb,
                                          isAdmin: security.current()?.roles.has('admin') ?? false,
                                          isHostOrAdmin: (security.current()?.roles.has('host')
                                              || security.current()?.roles.has('admin')) ?? false,
                                          liveConfig: this.liveClientConfig(),
                                          // Drive-any-page test agent: only for a testing viewer on a
                                          // non-production db (the poll/opt-in routes self-gate the same way).
                                          testAgent: (this.isTestDb && (security.current()?.roles.has('testing') ?? false))
                                              ? this.testClientRoutes() : undefined});
        return result;
    }

    // Unauthenticated requests are sent to the login page (except the login POST -
    // and, on NON-PRODUCTION dbs only, the GET form of the login, so a
    // puppeteer/test session can log in with a single navigation:
    //   /rabid.loginRequest(queryArgs)?email=rocky@redraccoon.org&password=rcky
    // Kept off production because a GET puts the password in the URL, which
    // transits the server log (the route interpreter logs each expr) and
    // browser history.
    // Where anonymous, denied requests are sent.  The PUBLIC entry points
    // (login / loginRequest / password reset) are no longer listed here - they
    // carry @route(publicRoute(...)), so the strict route interpreter lets them
    // through and only NON-public routes reach this bounce.  (The puppeteer GET
    // login shortcut still works: loginRequest is publicRoute.)
    protected override loginRouteFor(requestUrl: string): string | undefined {
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

    // The daily activity report's date-range filter (page-state; the report is
    // a bare page function, so its filter dialog / apply live here on the app,
    // reached as rabid.dailyReportFilterDialog / rabid.applyDailyReportFilter).
    @route(authenticated)
    dailyReportFilterDialog(q?: Record<string, any>): any {
        return pageQueries.renderFilterDialog(
            activityRangeQuery, activityRangeQuery.normalize(q),
            'rabid.applyDailyReportFilter', {title: 'Report date range'});
    }
    @route(authenticated)
    applyDailyReportFilter(form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(activityRangeQuery, form, 'dailyActivityReport');
    }

    // Same date-range filter for the monthly activity report.
    @route(authenticated)
    activityReportFilterDialog(q?: Record<string, any>): any {
        return pageQueries.renderFilterDialog(
            activityRangeQuery, activityRangeQuery.normalize(q),
            'rabid.applyActivityReportFilter', {title: 'Report date range'});
    }
    @route(authenticated)
    applyActivityReportFilter(form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(activityRangeQuery, form, 'activityReport');
    }

    // ----- Login / logout (app-specific auth) --------------------------------

    @route(publicRoute('login page — the unauthenticated entry point'))
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


    // NOT a routeMutation: the dev/puppeteer GET-login shortcut posts via the URL
    // (kept off production separately, where a GET would leak the password).
    @route(publicRoute('login form submit — authenticates the user'))
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
        if(!passwordUtils.constantTimeEqual(hashedSuppliedPassword, password_hash))
            return reRenderWithError('Incorrect password');

        return this.createSessionResponse(volunteer.volunteer_id, targetUrl);
    }

    // Cookie attributes for the session cookie.  Secure on a production db
    // (which is served over HTTPS); dev runs on plain http://localhost, where
    // Secure would make the cookie vanish.
    private sessionCookieAttrs(): string {
        const secure = this.getDbPurpose() === 'production' ? '; Secure' : '';
        return `Path=/; HttpOnly; SameSite=Lax${secure}`;
    }

    // Start a fresh session for a volunteer and respond with the session
    // cookie + a forward.  Shared by login and the password-reset flow.
    private createSessionResponse(volunteer_id: number, targetUrl: string): server.Response {
        const now = date.currentSqliteDateTime();
        const session_token = passwordUtils.generateSessionToken();
        rabid.volunteerLoginSession.insert({
            session_token,
            volunteer_id,
            start_time: now,
            last_resume_time: now,
            last_ip: '', // TODO
        });

        const response = server.forwardResponse(targetUrl);
        // Max-Age is the 400-day browser cap; the authoritative session lifetime is
        // the volunteer_session row (deleting it ends the session regardless).
        const fourHundredDaysInSeconds = 400 * 24 * 60 * 60;
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=${session_token}; ${this.sessionCookieAttrs()}; Max-Age=${fourHundredDaysInSeconds}`;
        return response;
    }

    /**
     * Log out: clear the session (server record + client cookie) and redirect home.
     */
    @route(publicRoute('logout — clears the session; harmless when anonymous'))
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
            `${this.sessionCookieName}=; ${this.sessionCookieAttrs()}; Max-Age=0`;
        return response;
    }

    // ----- Password reset (host-issued, single-use links) --------------------
    //
    // The onboarding/recovery model for an org with no email-sending (yet):
    // a host generates a reset link from the volunteer's detail page and
    // delivers it out-of-band (text, in person, their own email).  For bulk
    // onboarding ("import emails, no passwords") `./rabid.sh reset-links
    // <baseUrl>` emits an email,name,link CSV for a mail merge.  The token in
    // the link is the authentication: single-use, expiring, and stored only
    // as a SHA-256 hash (see PasswordResetTable).

    private assertHostOrSystem(): void {
        const ctx = security.current();
        if(!ctx || ctx.system) return;
        if(!(ctx.roles.has('host') || ctx.roles.has('admin')))
            throw new Error('Not permitted: hosts/admins only');
    }

    // Mint a reset token and return the link PATH.  The caller supplies the
    // origin: the host UI uses the browser's own location.origin (so no
    // base-URL config is needed), the batch CSV takes a baseUrl parameter.
    async makeResetLinkPath(volunteer_id: number, expiryDays: number = 7): Promise<string> {
        this.assertHostOrSystem();
        const createdBy = security.current()?.actorId;
        const token = passwordUtils.generateUrlToken();
        const reset_token_hash = await passwordUtils.sha256Hex(token);
        const now = date.orgNow();
        security.runSystem(() => rabid.passwordReset.insert({
            volunteer_id,
            reset_token_hash,
            created_time: date.temporalToSqliteDateTime(now),
            expires_time: date.temporalToSqliteDateTime(now.add({days: expiryDays})),
            used_time: undefined,
            created_by_volunteer_id: createdBy,
        }));
        return `/rabid.resetPassword(${JSON.stringify(token)})`;
    }

    // Step 1 (generator): confirmation dialog for issuing a reset link.
    @route(hostOrAdmin)
    resetLinkDialog(volunteer_id: number): Markup {
        this.assertHostOrSystem();
        const v = rabid.volunteer.getById(volunteer_id);
        return action.renderParamForm([], {}, {
            title: `Password-reset link for ${v.name}`,
            submitLabel: 'Generate link',
            hidden: {volunteer_id},
            dispatch: {
                // POST: minting a token is a mutation - it must not live on a
                // prefetchable GET.  The response (the link view) replaces the
                // dialog in the modal.
                'hx-post': '/rabid.resetLinkView(bodyArgs)',
                'hx-target': '#modalEditorBody',
                'hx-swap': 'innerHTML',
            },
        });
    }

    // Step 2 (action): mint the token, EMAIL it to the volunteer if we can, and
    // show the link so a host can also deliver it by hand (the ONE time it is
    // visible - only its hash is stored).  The inline script (htmx runs scripts
    // in swapped content) prepends the browser's origin to the path.  Minting a
    // token is a mutation, so this is POST-only (matches the dialog's hx-post).
    @routeMutation(hostOrAdmin)
    async resetLinkView(args: {volunteer_id?: string}): Promise<Markup> {
        this.assertHostOrSystem();
        const volunteer_id = Number(args?.volunteer_id);
        const v = rabid.volunteer.getById(volunteer_id);
        const path = await this.makeResetLinkPath(volunteer_id);

        // Try to email the link.  We always ATTEMPT a send when there's an
        // address (the default LogMailer just logs it - handy in dev), but only
        // claim "emailed" in the UI when the transport really delivers.  A
        // missing address or a send failure must NOT block the host: the copy
        // box below is always the fallback delivery channel.  Read the email
        // under a system context (it may be a field the host can't view).
        const email = security.runSystem(() => rabid.volunteer.getById(volunteer_id).email);
        let emailedTo: string | undefined;
        if(typeof email === 'string' && email.includes('@')) {
            const link = this.absoluteUrl(path);
            try {
                await this.mailer.send({
                    to: email,
                    subject: 'Set your password',
                    text: `Hi ${v.name},\n\n` +
                        `Use this single-use link to set your password (it expires in 7 days):\n\n` +
                        `${link}\n\n` +
                        `If you weren't expecting this, you can ignore this email.\n`,
                });
                if(this.mailer.deliversRealMail) emailedTo = email;
            } catch(e) {
                console.error(`failed to email reset link to ${email}: ${e}`);
            }
        }
        return [
            [h.h2, {class: 'h5'}, `Password-reset link for ${v.name}`],
            emailedTo
                ? [h.p, {class: 'text-success small', 'data-testid': 'reset-emailed'},
                   `Emailed to ${emailedTo}.  You can also copy the link below to deliver it another way.`]
                : [h.p, {class: 'text-muted small'},
                   'Single use, expires in 7 days.  Copy it now - it is not stored and cannot be shown again.'],
            [h.div, {class: 'input-group'},
             [h.input, {type: 'text', readonly: '', class: 'form-control', id: 'reset-link-out',
                        'data-path': path, 'data-testid': 'reset-link'}],
             [h.button, {type: 'button', class: 'btn btn-outline-primary',
                         onclick: "navigator.clipboard.writeText(document.getElementById('reset-link-out').value)"},
              'Copy']],
            [h.script, {},
             "document.getElementById('reset-link-out').value = " +
             "location.origin + document.getElementById('reset-link-out').dataset.path;"],
        ];
    }

    // A reset record redeemable right now, or undefined.  One generic failure
    // (invalid / expired / already used are deliberately indistinguishable).
    private async validResetRecord(token: unknown): Promise<volunteer.PasswordReset | undefined> {
        if(typeof token !== 'string' || !token) return undefined;
        const reset_token_hash = await passwordUtils.sha256Hex(token);
        const r = security.runSystem(() => rabid.passwordReset.byTokenHash.first({reset_token_hash}));
        if(!r || r.used_time) return undefined;
        if(r.expires_time <= date.currentSqliteDateTime()) return undefined;  // ISO strings compare correctly
        return r;
    }

    // The volunteer-facing set-your-password page (unauthenticated: the token
    // is the authentication).
    @route(publicRoute('password reset — the emailed single-use token is the auth'))
    async resetPassword(token: string, errorMessage?: string): Promise<templates.Page> {
        const reset = await this.validResetRecord(token);
        if(!reset) {
            return templates.page('Password reset', [
                [h.div, {class: 'container mt-5 text-center'},
                 [h.h1, {class: 'mb-3'}, 'Password reset'],
                 [h.p, {'data-testid': 'reset-invalid'},
                  'This password-reset link is invalid, expired, or has already been used.'],
                 [h.p, {class: 'text-muted'}, 'Ask a host to generate a new one for you.']],
            ]);
        }
        const v = security.runSystem(() => rabid.volunteer.getById(reset.volunteer_id));
        return templates.page('Set your password', [
            [h.div, {class: 'container mt-5'},
             [h.div, {class: 'row justify-content-center'},
              [h.div, {class: 'col-md-6 col-lg-5'},
               [h.div, {class: 'card shadow'},
                [h.div, {class: 'card-body p-5'},
                 [h.h1, {class: 'text-center mb-2'}, 'Set your password'],
                 [h.p, {class: 'text-center text-muted mb-4'}, `for ${v.name}`],
                 errorMessage
                     ? [h.div, {class: 'alert alert-danger', role: 'alert'}, errorMessage]
                     : undefined,
                 [h.form, {name: 'reset', method: 'post', action: 'rabid.resetPasswordRequest(bodyArgs)'},
                  [h.div, {class: 'form-group mb-3'},
                   [h.label, {for: 'password'}, 'New password'],
                   [h.input, {type: 'password', class: 'form-control', name: 'password', id: 'password',
                              minlength: '8', required: true}]],
                  [h.div, {class: 'form-group mb-4'},
                   [h.label, {for: 'password2'}, 'New password again'],
                   [h.input, {type: 'password', class: 'form-control', name: 'password2', id: 'password2',
                              minlength: '8', required: true}]],
                  [h.input, {type: 'hidden', name: 'token', value: token}],
                  [h.button, {type: 'submit', class: 'btn btn-primary btn-block w-100'}, 'Set password'],
                 ]]]]]],
        ]);
    }

    // Redeem: set the password, consume ALL the volunteer's outstanding reset
    // tokens, end any existing sessions, and log them straight in.
    @routeMutation(publicRoute('password reset submit — token-authenticated'))
    async resetPasswordRequest(args: {token?: string, password?: string, password2?: string}) {
        const token = args?.token ?? '';
        const reset = await this.validResetRecord(token);
        if(!reset)
            return this.resetPassword(token);  // renders the generic invalid page

        const password = args?.password ?? '';
        if(password.length < 8)
            return this.resetPassword(token, 'Please choose a password of at least 8 characters');
        if(password !== (args?.password2 ?? ''))
            return this.resetPassword(token, 'The two passwords do not match');

        const volunteer_id = reset.volunteer_id;
        const now = date.currentSqliteDateTime();
        const password_salt = passwordUtils.generateSalt();
        const password_hash = passwordUtils.hashPassword(password, password_salt);
        security.runSystem(() => {
            const existing = rabid.passwordHash.byVolunteerId.first({volunteer_id});
            if(existing)
                rabid.passwordHash.updateNamedFields(existing.password_hash_id,
                    ['password_salt', 'password_hash', 'last_change_time'],
                    {password_salt, password_hash, last_change_time: now});
            else
                rabid.passwordHash.insert({volunteer_id, password_salt, password_hash, last_change_time: now});
            rabid.passwordReset.markAllUsedForVolunteer(volunteer_id, now);
            // A password change invalidates every existing session (a stolen or
            // forgotten-open session shouldn't survive the reset).
            db().execute<{volunteer_id: number}>(
                'DELETE FROM volunteer_session WHERE volunteer_id = :volunteer_id', {volunteer_id});
        });
        return this.createSessionResponse(volunteer_id, '/');
    }

    // Bulk onboarding: mint reset links for every non-deleted volunteer with
    // no working password and emit email,name,link CSV (for a mail merge from
    // your own email account - no SMTP integration needed).
    //   ./rabid.sh reset-links https://rabid.example.org [expiryDays]
    // (Stop the server first: this writes tokens and SQLite has one writer.)
    async resetLinksCsvForPasswordlessVolunteers(baseUrl: string, expiryDays: number = 7): Promise<string> {
        this.assertHostOrSystem();
        const passwordless = security.runSystem(() =>
            db().prepare<{volunteer_id: number, name: string, email: string}, {}>(block`
/**/   SELECT v.volunteer_id, v.name, v.email
/**/          FROM volunteer v LEFT JOIN password_hash ph USING (volunteer_id)
/**/          WHERE v.deleted = 0
/**/            AND (ph.password_hash IS NULL OR ph.password_salt IS NULL)
/**/          ORDER BY v.name`).all({}));
        const lines = ['email,name,link'];
        for(const v of passwordless) {
            const path = await this.makeResetLinkPath(v.volunteer_id, expiryDays);
            lines.push(`${v.email},${JSON.stringify(v.name)},${baseUrl}${path}`);
        }
        return lines.join('\n');
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
    // Listen port comes from $RABID_PORT (set by rabid.sh from the checkout's
    // --N suffix / port file), defaulting to 8888 when unset.
    const port = Number(Deno.env.get('RABID_PORT') ?? '8888');
    switch(command) {
        case 'serve':
            rabid.startServer({hostname: 'localhost', port,
                               allowSchemaMismatch: args.includes('--allow-schema-mismatch')});
            break;

        // Compare the db against the declared table model; with --apply, bring
        // it up to date (additive changes only - see liminal/schema-upgrade.ts;
        // a backup is taken first).  Stop the server before --apply (SQLite
        // single writer); `./rabid.sh upgrade-db --apply` does that for you.
        case 'upgrade-db': {
            const code = security.runSystem(() =>
                schemaUpgrade.upgradeDbCommand(rabid.tables, args.slice(1)));
            Deno.exit(code);
            break;
        }
        case 'test-run': {
            // Start the server, run the named browser test run against a connected
            // client, then exit with a pass/fail code.  startServer() resolves once
            // Deno.serve is listening, so the run and the server run concurrently.
            const runName = args[1] ?? 'demo';
            await rabid.startServer({hostname: 'localhost', port});
            const code = await rabid.runNamedTestRun(runName);
            Deno.exit(code);
            break;
        }
        case 'reset-links': {
            // Bulk onboarding: emit email,name,link CSV of password-reset links
            // for every volunteer without a working password (mail-merge it from
            // your own email account).  Written to a FILE because stdout is full
            // of db logging.  Stop the server first (SQLite single writer).
            // Usage: reset-links <baseUrl> <out.csv> [expiryDays]
            const [baseUrl, outFile] = [args[1], args[2]];
            if(!baseUrl || !outFile) throw new Error('usage: reset-links <baseUrl> <out.csv> [expiryDays]');
            const expiryDays = args[3] ? Number(args[3]) : 7;
            const csv = await security.runSystem(() =>
                rabid.resetLinksCsvForPasswordlessVolunteers(baseUrl, expiryDays));
            Deno.writeTextFileSync(outFile, csv + '\n');
            console.info(`wrote ${csv.split('\n').length - 1} reset links to ${outFile}`);
            Deno.exit(0);
            break;
        }
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
