// deno-lint-ignore-file no-explicit-any
/**
 * Users, passwords and login sessions - in the rabid-standard liminal style.
 *
 * The user's `username` is the short code (e.g. 'djz') that the assertion
 * model stores in attribute values (recording speaker, todo assigned_to,
 * change_by_username), so the codes in entry-schema.ts's hardcoded `users`
 * map become usernames here.  `seedUsersFromEntrySchema` migrates that map
 * into the table; the map itself stays (for now) as the display-label source
 * for the soft schema's enum options.
 *
 * Roles (in the `permissions` field, comma separated):
 *   - admin:   manage users/roles, everything (implies all roles below);
 *   - publish: may publish the public site (replaces the canUserPublish hack);
 *   - testing: may act as a browser test client;
 *   - approve: may approve/revert lexeme changes (lexeme-ops.ts);
 *   - edit-users: may manage user records (create, edit others, disable) -
 *     but NOT the permissions field itself, which stays admin-only so the
 *     grant cannot escalate itself;
 *   - edit-categories / edit-lexical-forms: may curate those vocabularies
 *     (category.ts / lexical-form.ts).
 *
 * Password hashes live in their own table (not on user) so an error in a SQL
 * query involving the user table cannot accidentally leak a hash.  Sessions
 * are server-revocable rows; deleting one ends the session regardless of the
 * cookie.
 */
import { db, boolnum } from "../liminal/db.ts";
import { Table, PrimaryKeyField, ForeignKeyField, BooleanField, StringField,
         EmailField, SecretField, DateTimeField, navChevron } from "../liminal/table.ts";
import { path } from "../liminal/serializable.ts";
import { block } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import * as passwordUtils from "../liminal/password.ts";
import * as date from "../liminal/date.ts";
import * as entrySchema from './entry-schema.ts';
import * as templates from './templates.ts';

const admin = security.hasRole('admin');
// User management is its own grant: 'edit-users' can be given to a non-admin
// manager; 'admin' implies it (the approve-role convention).  The permissions
// FIELD stays admin-only (see the roles comment above).
const editUsers = security.or(security.hasRole('edit-users'), admin);
const selfOrEditUsers = security.or(security.isSelf, editUsers);
// The username is the short code the ASSERTION DATA stores (speaker,
// assigned_to, change_by_username - initials were a deliberate choice so the
// dictionary reads standalone in 1000 years); renaming one would strand that
// data.  Editable only at CREATE, like category/lexical-form slugs.
const usernameOnCreateOnly: security.Permission = a =>
    editUsers(a) && !(a.record as User|undefined)?.user_id;

// --------------------------------------------------------------------------------
// --- User -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface User {
    user_id: number;

    // The short code stored in assertion attributes (speaker, assigned_to,
    // change_by_username) - changing one requires a data migration, so treat
    // usernames as stable once in use.
    username: string;

    name: string;
    email?: string;

    // Comma-separated roles: admin / publish / testing.
    permissions?: string;

    /**
     * We disable users rather than deleting them because the dictionary
     * change history references usernames - deleting the user would orphan
     * the change history.
     */
    disabled: boolnum;
}
export type UserOpt = Partial<User>;

export class UserTable extends Table<User> {

    constructor() {
        super('user', [
            new PrimaryKeyField('user_id', {}),
            new StringField('username', {indexed: true, unique: true, edit: usernameOnCreateOnly,
                                         prompt: 'Username (short code stored in dictionary data - cannot be changed later)'}),
            new StringField('name', {}),
            new EmailField('email', {nullable: true}),
            new StringField('permissions', {nullable: true, edit: admin,
                                            prompt: 'Permissions (admin, publish, testing, approve, ' +
                                                    'edit-users, edit-categories, edit-lexical-forms)'}),
            new BooleanField('disabled', {default: 0}),
        ]);
    }

    ownerId(u: User): number|undefined { return u.user_id; }

    // Small dictionary team, open books: any logged-in user sees users.
    defaultFieldView: security.Permission = security.loggedIn;
    // Users edit their own record; 'edit-users' holders (admin implies) edit
    // anyone (the permissions field stays admin-only above).
    defaultFieldEdit: security.Permission = selfOrEditUsers;
    override get recordEdit(): security.Permission { return selfOrEditUsers; }

    override formTitle(u: User): string {
        return u.user_id ? `Edit ${u.name || u.username || 'user'}` : 'New user';
    }

    @path
    get byUsername() {
        return this.prepare<User, {username: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM user
/**/          WHERE username = :username`);
    }

    @path
    get activeUsersByName() {
        return this.prepare<User, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM user
/**/          WHERE disabled = 0
/**/          ORDER BY name`);
    }

    @path
    get allUsersByName() {
        return this.prepare<User, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM user
/**/          ORDER BY disabled, name`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the rabid UI standard) -----------------
    // ------------------------------------------------------------------------

    renderUsersPage(): Markup {
        const canCreate = this.canEditRecord({} as User);
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Users'],
             canCreate
                 ? action.actionButton('New user',
                     {kind: 'modal', dialogUrl: '/ww/wordwiki.users.newDialog()'},
                     'btn btn-outline-primary btn-sm')
                 : undefined],
            this.renderUserList(),
        ];
    }

    // The list as a reloadable fragment: a "New user" insert reloads `.-user-`
    // (the pk-less reload target the base saveForm emits), which is this wrapper.
    renderUserList(): Markup {
        const users = this.allUsersByName.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.users.renderUserList()`);
        return ['div', props,
            users.length === 0
                ? ['p', {class: 'text-muted'}, 'No users yet.']
                : ['div', {class: 'list-group lm-list'},
                   users.map(u => this.renderUserRow(u))]];
    }

    renderUserRow(u: User): Markup {
        const id = u.user_id;
        const secondary = [u.username, u.email, u.permissions,
                           u.disabled ? 'disabled' : '']
            .filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `/ww/wordwiki.users.renderUserRowById(${id})`);
        return ['div', {...item, 'data-testid': `user-row-${id}`},
            ['div', {class: 'lm-item-body'},
             ['div', {class: 'lm-item-primary'},
              ['a', {...templates.pageLinkProps(`/ww/wordwiki.users.detailPage(${id})`),
                     class: 'lm-nav-link'}, u.name || u.username]],
             ['div', {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(u) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    renderUserRowById(id: number): Markup {
        return this.renderUserRow(this.getById(id));
    }

    // ------------------------------------------------------------------------
    // --- User detail page ----------------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one user (navigated to by tapping the list row).  For now
    // the same info as the row, plus the pencil; domain-specific detail
    // (assertions authored, assignments, ...) comes later.
    detailPage(user_id: number): templates.Page {
        const u = this.getById(user_id);
        return templates.page(`${u.name || u.username} — User`, this.renderDetail(user_id));
    }

    // The detail body, as a reloadable fragment (an edit save re-renders it).
    renderDetail(user_id: number): Markup {
        const u = this.getById(user_id);
        const props = this.reloadableItemProps(user_id, `/ww/wordwiki.users.renderDetail(${user_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [['dt', {class: 'col-sm-3'}, label], ['dd', {class: 'col-sm-9'}, value]];
        return ['div', props,
            ['div', {class: 'd-flex align-items-center gap-2 mb-3'},
             ['h2', {class: 'mb-0'}, u.name || u.username],
             u.disabled ? ['span', {class: 'badge text-bg-secondary'}, 'Disabled'] : undefined,
             this.canEditRecord(u) ? this.editPencil(user_id) : undefined],
            ['dl', {class: 'row mb-0'},
             row('Username', u.username),
             row('Email', u.email || '—'),
             row('Permissions', u.permissions || '—'),
            ],
        ];
    }

    // The create dialog: the record form over an empty record (renderForm
    // gates on recordEdit server-side too).
    newDialog(): Markup {
        return this.renderForm({} as User);
    }
}

// Seed the user table from the hardcoded users map in entry-schema.ts (the
// '___' placeholder code is skipped).  Idempotent: existing usernames are
// left untouched.  djz/dmm get the roles matching the old canUserPublish hack.
// The '~' prefix marks an AUTOMATED identity (mirroring the internal-
// category slug convention): batch imports/migrations stamp their
// assertions with one of these so history UI can collapse/badge the runs
// and restore can refuse to cross a migration boundary.  This is THE test
// - never a bare startsWith elsewhere.
export function isAutomatedUsername(username: string|null|undefined): boolean {
    return typeof username === 'string' && username.startsWith('~');
}

// The reserved automation identities, seeded (disabled - they can never log
// in) by the same user seeding the post-pull recipe already runs.
export const SYSTEM_USERS: {username: string, name: string}[] = [
    {username: '~category-import',     name: 'Category import (automated)'},
    {username: '~lexical-form-import', name: 'Lexical form import (automated)'},
];

// The dedicated test identity: tests and smoke checks log in as THIS user,
// never as a human's account (a human leaving the project must not break the
// test code).  Seeded enabled with only the 'testing' role; it can actually
// log in only where user-passwords.json supplies a password for it.  Not
// '~'-prefixed: that convention marks batch-migration identities that can
// never log in, while this one exists precisely to log in.
export const TEST_USER = {username: 'test', name: 'Test robot (automated tests)',
                          permissions: 'testing'};

export function seedUsersFromEntrySchema(users: UserTable): {inserted: number, skipped: number} {
    const initialPermissions: Record<string, string> = {
        'djz': 'admin,publish,testing',
        'dmm': 'admin,publish',
    };
    let inserted = 0, skipped = 0;
    for(const [username, name] of Object.entries(entrySchema.users)) {
        if(username === '___') continue;
        if(users.byUsername.first({username})) { skipped++; continue; }
        users.insert({username, name, permissions: initialPermissions[username] ?? '', disabled: 0});
        inserted++;
    }
    for(const {username, name} of SYSTEM_USERS) {
        if(users.byUsername.first({username})) { skipped++; continue; }
        users.insert({username, name, permissions: '', disabled: 1});
        inserted++;
    }
    if(!users.byUsername.first({username: TEST_USER.username})) {
        users.insert({...TEST_USER, disabled: 0});
        inserted++;
    } else skipped++;
    return {inserted, skipped};
}

// Seed passwords from a (never-checked-in) JSON file mapping username ->
// plaintext password (<repo>/user-passwords.json, originally carried over
// from the old basic-auth caddy config so the team keeps the passwords they
// had on the old version).  Only fills in users who have NO password yet: a
// password someone has since changed is never overwritten.  The file is the
// ONLY copy of the team's passwords, so a checkout without it must FAIL the
// seeding recipes (post-pull/upgrade-users) rather than quietly produce
// passwordless team accounts - copy the file over by hand.
export function seedPasswordsFromFile(users: UserTable, passwordHash: PasswordHashTable,
                                      jsonPath: string):
        {set: number, kept: number, unknown: string[]} {
    let text: string;
    try { text = Deno.readTextFileSync(jsonPath); }
    catch (_e) {
        throw new Error(`password seed file ${jsonPath} is missing - it is gitignored ` +
                        `(plaintext passwords) and must be copied to this checkout by hand`);
    }
    const passwords = JSON.parse(text) as Record<string, unknown>;
    let set = 0, kept = 0;
    const unknown: string[] = [];
    for(const [username, password] of Object.entries(passwords)) {
        if(typeof password !== 'string' || password === '')
            throw new Error(`${jsonPath}: password for '${username}' is not a non-empty string`);
        const u = users.byUsername.first({username});
        if(!u) { unknown.push(username); continue; }
        if(passwordHash.byUserId.first({user_id: u.user_id})) { kept++; continue; }
        passwordHash.setPassword(u.user_id, password);
        set++;
    }
    if(unknown.length > 0)
        console.info(`password seed file names users not in the user table ` +
                     `(ignored): ${unknown.join(', ')}`);
    return {set, kept, unknown};
}

// --------------------------------------------------------------------------------
// --- PasswordHash ----------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface PasswordHash {
    password_hash_id: number,
    user_id: number,
    password_salt?: string;
    password_hash?: string;
    last_change_time: string,
}

export class PasswordHashTable extends Table<PasswordHash> {

    constructor() {
        super('password_hash', [
            new PrimaryKeyField('password_hash_id', {}),
            new ForeignKeyField('user_id', 'user', 'user_id', {indexed: true, unique: true}),
            new SecretField('password_salt', {nullable: true}),
            new SecretField('password_hash', {nullable: true}),
            new DateTimeField('last_change_time', {}),
        ], [
            'CREATE UNIQUE INDEX IF NOT EXISTS password_hash_by_user_id ON password_hash(user_id);'
        ]);
    }

    @path
    get byUserId() {
        return db().prepare<PasswordHash, {user_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM password_hash
/**/          WHERE user_id = :user_id`);
    }

    // Set (or replace) a user's password.  Used by the set-password CLI and
    // (later) a self-serve change-password dialog / reset links.
    setPassword(user_id: number, password: string): void {
        const now = date.currentSqliteDateTime();
        const password_salt = passwordUtils.generateSalt();
        const password_hash = passwordUtils.hashPassword(password, password_salt);
        const existing = this.byUserId.first({user_id});
        if(existing)
            this.updateNamedFields(existing.password_hash_id,
                ['password_salt', 'password_hash', 'last_change_time'],
                {password_salt, password_hash, last_change_time: now});
        else
            this.insert({user_id, password_salt, password_hash, last_change_time: now});
    }
}

// --------------------------------------------------------------------------------
// --- UserSession -----------------------------------------------------------------
// --------------------------------------------------------------------------------

// Session tokens are dropped as cookies in browsers.  To end a session, erase
// the user_session record.

export interface UserSession {
    session_id: number;
    session_token: string;
    user_id: number;
    start_time: string;
    last_resume_time: string;
    last_ip: string;

    // Browser-test bridge identity/liveness (see liminal/browser-agent.ts) -
    // stamped only when this session opts in as a test client.
    last_test_client_opt_in?: string;
    last_test_client_heartbeat?: string;
}

export class UserSessionTable extends Table<UserSession> {

    constructor() {
        super('user_session', [
            new PrimaryKeyField('session_id', {}),
            new StringField('session_token', {indexed: true, unique: true}),
            new ForeignKeyField('user_id', 'user', 'user_id', {indexed: true}),
            new DateTimeField('start_time', {}),
            new DateTimeField('last_resume_time', {}),
            new StringField('last_ip', {default: ''}),
            new DateTimeField('last_test_client_opt_in', {nullable: true}),
            new DateTimeField('last_test_client_heartbeat', {nullable: true}),
        ]);
    }

    @path
    get getBySessionToken() {
        return this.prepare<UserSession, {session_token: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM user_session
/**/          WHERE session_token = :session_token`);
    }

    @path
    get mostRecentTestClient() {
        return this.prepare<UserSession, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM user_session
/**/          WHERE last_test_client_opt_in IS NOT NULL
/**/          ORDER BY last_test_client_opt_in DESC
/**/          LIMIT 1`);
    }

    stampTestClientOptIn(session_token: string, now: string): void {
        db().execute<{session_token: string, now: string}>(block`
/**/   UPDATE user_session
/**/          SET last_test_client_opt_in = :now, last_test_client_heartbeat = :now
/**/          WHERE session_token = :session_token`, {session_token, now});
    }

    stampTestClientHeartbeat(session_token: string, now: string): void {
        db().execute<{session_token: string, now: string}>(block`
/**/   UPDATE user_session
/**/          SET last_test_client_heartbeat = :now
/**/          WHERE session_token = :session_token`, {session_token, now});
    }

    deleteBySessionToken(session_token: string): void {
        db().execute<{session_token: string}>(
            'DELETE FROM user_session WHERE session_token = :session_token', {session_token});
    }

    deleteAllForUser(user_id: number): void {
        db().execute<{user_id: number}>(
            'DELETE FROM user_session WHERE user_id = :user_id', {user_id});
    }
}
