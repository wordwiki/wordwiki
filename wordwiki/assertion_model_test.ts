// deno-lint-ignore-file no-explicit-any
/**
 * Assertion-model tests, db-backed end: applyTransaction (timestamp
 * allocation, persistence, predecessor stamping), persistence round-trips
 * through SQLite, restart behaviour, and the v2 lexeme editor's
 * render→act→render flows.  The pure in-memory model is covered in
 * datawiki/workspace_test.ts.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertExists, assertThrows, assertRejects,
         assertNotEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { hasText, text, findAll, attr } from "../liminal/testing/markup-assert.ts";
import { withTestDb, as, renderRoute, invoke,
         TestTimeline, mkEntry, mkChild, mkEdit, mkTombstone, type Fixture } from './testing.ts';
import { WordWiki } from './wordwiki.ts';
import { Assertion } from './schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { db } from '../liminal/db.ts';
import * as security from '../liminal/security.ts';

// All db rows for a fact, oldest first.
function dbVersions(id: number): Assertion[] {
    return db().prepare<Assertion, {id: number}>(
        'SELECT * FROM dict WHERE id = :id ORDER BY valid_from, assertion_id').all({id});
}

// Seed a minimal entry (id 1000) with one spelling (1001) and one subentry
// (1002) + gloss (1003), via applyTransaction like the editor would.
function seedEntry(ww: WordWiki): {entry: Assertion, spelling: Assertion, sub: Assertion, gloss: Assertion} {
    const tl = new TestTimeline();
    const entry = mkEntry(1000, tl.next());
    const spelling = mkChild(entry, 'spl', 1001, tl.next(), {attr1: 'cat', variant: 'mm-li', order_key: '0.5'});
    const sub = mkChild(entry, 'sub', 1002, tl.next(), {attr1: 'n'});
    const gloss = mkChild(sub, 'gls', 1003, tl.next(), {attr1: 'a cat'});
    // Distinct valid_from per assertion => four tx groups in one call.
    ww.applyTransaction([entry]);
    ww.applyTransaction([spelling]);
    ww.applyTransaction([sub]);
    ww.applyTransaction([gloss]);
    return {entry, spelling, sub, gloss};
}

// The current (END_OF_TIME) version of a fact from the live workspace.
function currentOf(ww: WordWiki, fact_id: number): Assertion {
    return ww.workspace.getTableByTag('dct').findRequiredVersionedTupleById(fact_id)
        .currentAssertion ?? (() => { throw new Error(`no current version of ${fact_id}`); })();
}

// ---------------------------------------------------------------------------
// --- applyTransaction ----------------------------------------------------------
// ---------------------------------------------------------------------------

test("tx: timestamps are rewritten to fresh server timestamps and persist", async () => {
    await withTestDb(({ww}) => {
        // An unambiguous client placeholder (one tick past the 2020 epoch
        // start) that a server allocation can never legitimately produce now.
        const placeholder = timestamp.BEGINNING_OF_TIME + 1;
        ww.applyTransaction([mkEntry(1000, placeholder)]);

        const rows = dbVersions(1000);
        assertEquals(rows.length, 1);
        // The placeholder is gone: the persisted valid_from is a freshly
        // allocated server timestamp.
        assert(rows[0].valid_from > placeholder,
               `persisted ${rows[0].valid_from} should be far above placeholder ${placeholder}`);
        assertEquals(rows[0].valid_to, timestamp.END_OF_TIME);
        // Workspace and db agree.
        assertEquals(currentOf(ww, 1000).valid_from, rows[0].valid_from);
    });
});

test("tx: an edit stamps the predecessor's valid_to IN THE DATABASE", async () => {
    await withTestDb(({ww}) => {
        const {spelling} = seedEntry(ww);
        const live = currentOf(ww, 1001);
        ww.applyTransaction([mkEdit(live, 2001, new TestTimeline().next(), {attr1: 'caat'})]);

        const rows = dbVersions(1001);
        assertEquals(rows.length, 2);
        const [v1, v2] = rows;
        assertEquals(v1.assertion_id, spelling.assertion_id);
        assertEquals(v2.replaces_assertion_id, v1.assertion_id);
        // The chain invariant the load path depends on:
        assertEquals(v1.valid_to, v2.valid_from);
        assertEquals(v2.valid_to, timestamp.END_OF_TIME);
        assertEquals(v2.attr1, 'caat');
    });
});

test("tx: timestamps allocated across transactions are strictly increasing", async () => {
    await withTestDb(({ww}) => {
        const tl = new TestTimeline();
        ww.applyTransaction([mkEntry(1000, tl.next())]);
        ww.applyTransaction([mkEntry(2000, tl.next())]);
        ww.applyTransaction([mkEntry(3000, tl.next())]);
        const times = [1000, 2000, 3000].map(id => dbVersions(id)[0].valid_from);
        assert(times[0] < times[1] && times[1] < times[2], `not increasing: ${times}`);
    });
});

test("tx: a multi-group applyTransactions call applies in order (entry + child)", async () => {
    await withTestDb(({ww}) => {
        // Like addNewLexeme: two assertions with distinct placeholder
        // timestamps, submitted in one call.
        const tl = new TestTimeline();
        const entry = mkEntry(1000, tl.next());
        const sub = mkChild(entry, 'sub', 1001, tl.next());
        ww.applyTransactions([entry, sub]);

        assertEquals(dbVersions(1000).length, 1);
        assertEquals(dbVersions(1001).length, 1);
        assert(dbVersions(1000)[0].valid_from < dbVersions(1001)[0].valid_from);
    });
});

test("tx: out-of-order tx groups are rejected", async () => {
    await withTestDb(({ww}) => {
        const tl = new TestTimeline();
        const t1 = tl.next(), t2 = tl.next();
        const entry = mkEntry(1000, t2);
        const entry2 = mkEntry(2000, t1);  // earlier placeholder AFTER a later one
        assertThrows(() => ww.applyTransactions([entry, entry2]),
                     Error, 'must be in valid_from order');
    });
});

test("tx: a failed apply leaves no partial state (workspace reloads from db)", async () => {
    await withTestDb(({ww}) => {
        seedEntry(ww);
        const live = currentOf(ww, 1001);

        // A broken replaces chain fails the apply...
        const bad = mkEdit(live, 2001, new TestTimeline().next(), {attr1: 'broken'});
        bad.replaces_assertion_id = 999999;
        assertThrows(() => ww.applyTransaction([bad]));

        // ...the db is untouched and the (reloaded) workspace agrees with it.
        assertEquals(dbVersions(1001).length, 1);
        assertEquals(currentOf(ww, 1001).attr1, 'cat');

        // And the system still accepts a good edit afterwards.
        ww.applyTransaction([mkEdit(currentOf(ww, 1001), 2002, new TestTimeline().next(), {attr1: 'caat'})]);
        assertEquals(currentOf(ww, 1001).attr1, 'caat');
    });
});

// ---------------------------------------------------------------------------
// --- Persistence round-trips ----------------------------------------------------
// ---------------------------------------------------------------------------

test("round-trip: a built-up entry reloads from the db identically", async () => {
    await withTestDb(({ww}) => {
        seedEntry(ww);
        // Exercise every mutation kind: edit, move, delete, restore.
        const tl = new TestTimeline();
        ww.applyTransaction([mkEdit(currentOf(ww, 1001), 2001, tl.next(), {attr1: 'caat'})]);
        ww.applyTransaction([mkEdit(currentOf(ww, 1001), 2002, tl.next(), {order_key: '0.7'})]);
        ww.applyTransaction([mkTombstone(currentOf(ww, 1003), 2003, tl.next())]);

        const before = JSON.parse(JSON.stringify(ww.entries));

        // Reload everything from the db (as a server restart would).
        ww.requestWorkspaceReload();
        const after = JSON.parse(JSON.stringify(ww.entries));

        assertEquals(after, before);
        // And the deleted gloss is really gone from the reloaded view.
        assertEquals(after[0].subentry[0].gloss.length, 0);
    });
});

test("round-trip: delete-then-restore (a valid-time gap) survives reload", async () => {
    await withTestDb(({ww}) => {
        seedEntry(ww);
        const tl = new TestTimeline();
        const live = currentOf(ww, 1001);
        ww.applyTransaction([mkTombstone(live, 2001, tl.next())]);
        const tombstone = dbVersions(1001).at(-1)!;
        const restore = mkEdit(tombstone, 2002, tl.next(), {attr1: 'cat'});
        restore.valid_to = timestamp.END_OF_TIME;
        ww.applyTransaction([restore]);

        ww.requestWorkspaceReload();
        assertEquals(currentOf(ww, 1001).attr1, 'cat');
        // Three persisted versions: original (closed), tombstone, restore.
        const rows = dbVersions(1001);
        assertEquals(rows.length, 3);
        assert(rows[1].valid_from === rows[1].valid_to, 'middle version is a tombstone');
        assert(rows[2].valid_from > rows[1].valid_to, 'restore starts after the gap');
    });
});

test("restart: a fresh server's allocated timestamps stay above everything persisted", async () => {
    // THE demon this guards: if a restarted server re-allocated old
    // timestamps, new edits would interleave into history and break chains.
    await withTestDb(({ww}) => {
        seedEntry(ww);
        ww.applyTransaction([mkEdit(currentOf(ww, 1001), 2001, new TestTimeline().next(), {attr1: 'caat'})]);
        const maxPersisted = db().prepare<{m: number}, {}>(
            'SELECT MAX(valid_from) AS m FROM dict').required({}).m;

        // A second WordWiki over the same db = a restarted server.
        const ww2 = new WordWiki();
        const fresh = ww2.allocTxTimestamps(1);
        assert(fresh > maxPersisted, `restart allocated ${fresh} <= persisted ${maxPersisted}`);
    });
});

test("restart: tombstone-final facts do not confuse the restart timestamp", async () => {
    // highestTimestamp considers valid_to as well as valid_from: a tombstone
    // (whose valid_to is not END_OF_TIME) must push the restart clock forward.
    await withTestDb(({ww}) => {
        seedEntry(ww);
        ww.applyTransaction([mkTombstone(currentOf(ww, 1001), 2001, new TestTimeline().next())]);
        const maxPersisted = db().prepare<{m: number}, {}>(
            'SELECT MAX(valid_from) AS m FROM dict').required({}).m;
        const ww2 = new WordWiki();
        assert(ww2.allocTxTimestamps(1) > maxPersisted);
    });
});

// ---------------------------------------------------------------------------
// --- The v2 lexeme editor: render -> act -> render ------------------------------
// ---------------------------------------------------------------------------

test("editor: renderEntry shows the seeded entry", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const markup = await as(fx, 'djz', () => renderRoute(fx.ww, 'wordwiki.lexeme.renderEntry(1000)'));
        assert(hasText(markup, 'cat'), 'spelling rendered');
        assert(hasText(markup, 'a cat'), 'gloss rendered');
    });
});

test("editor: edit dialog carries current values + the conflict guard", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const dialog = await as(fx, 'djz', () => renderRoute(fx.ww, 'wordwiki.lexeme.editDialog(1000, 1001)'));
        const inputs = findAll(dialog, n => n[0] === 'input');
        const byName = Object.fromEntries(inputs.map(i => [attr(i, 'name'), attr(i, 'value')]));
        assertEquals(byName['text'], 'cat');
        assertEquals(String(byName['replaces_assertion_id']), '1001');
        assertEquals(String(byName['fact_id']), '1001');
    });
});

test("editor: saveTuple edits, stamps the author, and scopes the reload", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        // A spelling edit widens to the whole-entry (root) reload.
        const r1 = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: '1001',
            'before-text': 'cat', text: 'caat', 'before-variant': 'mm-li', variant: 'mm-li',
        }));
        assertEquals(r1, {action: 'reload', targets: ['.-entry-1000-']});
        assertEquals(currentOf(fx.ww, 1001).attr1, 'caat');
        assertEquals(currentOf(fx.ww, 1001).change_by_username, 'djz');

        // A gloss edit scopes to the tuple itself.
        const r2 = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1003', replaces_assertion_id: '1003',
            'before-gloss': 'a cat', gloss: 'the cat', 'before-variant': '', variant: '',
        }));
        assertEquals(r2, {action: 'reload', targets: ['.-fact-1003-']});

        const markup = await as(fx, 'djz', () => renderRoute(fx.ww, 'wordwiki.lexeme.renderEntry(1000)'));
        assert(hasText(markup, 'caat') && hasText(markup, 'the cat'));
    });
});

test("editor: a stale dialog (conflict) is refused with an alert, not applied", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const form = {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: '1001',
            'before-text': 'cat', text: 'first-writer', 'before-variant': 'mm-li', variant: 'mm-li',
        };
        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', form));
        // Replaying the same (now stale) dialog must not clobber.
        const r = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)',
            {...form, text: 'second-writer'}));
        assertEquals(r.action, 'alert');
        assertEquals(currentOf(fx.ww, 1001).attr1, 'first-writer');
    });
});

test("editor: insert at end, move up, delete, list deleted, restore", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const djz = <T,>(fn: () => T) => as(fx, 'djz', fn);

        // Insert a second spelling (lands at the end).
        const rIns = await djz(() => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', parent_fact_id: '1000', child_tag: 'spl',
            'before-text': '', text: 'kat', 'before-variant': '', variant: 'mm-sf',
        }));
        assertEquals(rIns, {action: 'reload', targets: ['.-entry-1000-']});
        let e = JSON.parse(JSON.stringify(fx.ww.entries))[0];
        assertEquals(e.spelling.map((s: any) => s.text), ['cat', 'kat']);
        const katId = e.spelling[1].spelling_id;

        // Move it up.
        await djz(() => invoke(fx.ww, `wordwiki.lexeme.move(1000, ${katId}, 'up')`));
        e = JSON.parse(JSON.stringify(fx.ww.entries))[0];
        assertEquals(e.spelling.map((s: any) => s.text), ['kat', 'cat']);

        // Moving up again refuses (already first).
        const rTop = await djz(() => invoke(fx.ww, `wordwiki.lexeme.move(1000, ${katId}, 'up')`));
        assertEquals(rTop.action, 'alert');

        // Delete it; it leaves the current view and appears in the deleted list.
        await djz(() => invoke(fx.ww, `wordwiki.lexeme.deleteTuple(1000, ${katId})`));
        e = JSON.parse(JSON.stringify(fx.ww.entries))[0];
        assertEquals(e.spelling.map((s: any) => s.text), ['cat']);

        const deletedDialog = await djz(() => renderRoute(fx.ww, `wordwiki.lexeme.deletedDialog(1000, 1000, 'spl')`));
        assert(hasText(deletedDialog, 'kat'), 'deleted dialog lists the deleted spelling');

        // Restore it from its last real version.
        const lastReal = dbVersions(katId).filter(v => v.valid_from !== v.valid_to).at(-1)!;
        await djz(() => invoke(fx.ww, `wordwiki.lexeme.restoreVersion(1000, ${katId}, ${lastReal.assertion_id})`));
        e = JSON.parse(JSON.stringify(fx.ww.entries))[0];
        assertEquals(e.spelling.map((s: any) => s.text).toSorted(), ['cat', 'kat']);
    });
});

test("editor: deleting an item with live children is refused", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const r = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.deleteTuple(1000, 1002)'));
        assertEquals(r.action, 'alert');
        assertStringIncludes(r.message, 'child items');
        assertExists(currentOf(fx.ww, 1002));
    });
});

test("editor: history lists versions newest-first with one Current badge", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const tl = new TestTimeline();
        fx.ww.applyTransaction([mkEdit(currentOf(fx.ww, 1001), 2001, tl.next(), {attr1: 'caat'})]);
        fx.ww.applyTransaction([mkEdit(currentOf(fx.ww, 1001), 2002, tl.next(), {attr1: 'caaat'})]);

        const dialog = await as(fx, 'djz', () => renderRoute(fx.ww, 'wordwiki.lexeme.historyDialog(1000, 1001)'));
        assert(hasText(dialog, 'cat') && hasText(dialog, 'caat') && hasText(dialog, 'caaat'));
        const badges = findAll(dialog, n => text(n) === 'Current' && n[0] === 'span');
        assertEquals(badges.length, 1);
        const restores = findAll(dialog, n => n[0] === 'button' && text(n) === 'Restore');
        assertEquals(restores.length, 2);
    });
});

test("editor: restoring an old version re-asserts it (and is itself undoable)", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        fx.ww.applyTransaction([mkEdit(currentOf(fx.ww, 1001), 2001, new TestTimeline().next(), {attr1: 'caat'})]);

        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.restoreVersion(1000, 1001, 1001)'));
        assertEquals(currentOf(fx.ww, 1001).attr1, 'cat');
        // Nothing was mutated: the history now has THREE versions.
        assertEquals(dbVersions(1001).length, 3);
    });
});

// ---------------------------------------------------------------------------
// --- Users / sessions / login -----------------------------------------------
// ---------------------------------------------------------------------------

test("users: seeded from the entry-schema map with the expected roles", async () => {
    await withTestDb(({ww, userIds}) => {
        as({ww, userIds}, 'djz', () => {
            const djz = ww.users.getById(userIds['djz']);
            assertEquals(djz.username, 'djz');
            assertEquals(djz.permissions, 'admin,publish,testing');
            // The '___' placeholder is not a user.
            assertEquals(ww.users.byUsername.first({username: '___'}), undefined);
        });
    });
});

test("users: a non-admin cannot grant themselves roles", async () => {
    await withTestDb((fx) => {
        const {ww, userIds} = fx;
        // djb (no roles) edits their own record: name is fine...
        as(fx, 'djb', () => {
            ww.users.saveForm({
                user_id: String(userIds['djb']),
                'before-name': 'Dolly Barnaby', name: 'Dolly B.',
            });
        });
        as(fx, 'system', () =>
            assertEquals(ww.users.getById(userIds['djb']).name, 'Dolly B.'));

        // ...but the permissions field is admin-only.
        assertThrows(() =>
            as(fx, 'djb', () => ww.users.saveForm({
                user_id: String(userIds['djb']),
                'before-permissions': '', permissions: 'admin',
            })), Error, 'Not permitted');
        as(fx, 'system', () =>
            assertEquals(ww.users.getById(userIds['djb']).permissions, ''));
    });
});

test("users: a non-admin cannot edit someone else's record", async () => {
    await withTestDb((fx) => {
        assertThrows(() =>
            as(fx, 'djb', () => fx.ww.users.saveForm({
                user_id: String(fx.userIds['dmm']),
                'before-name': 'Diane Mitchell', name: 'Hacked',
            })), Error, 'Not permitted');
    });
});

test("login: correct password creates a session; wrong password does not", async () => {
    await withTestDb((fx) => {
        const {ww, userIds} = fx;
        const good: any = ww.loginRequest({username: 'djz', password: 'test-password'});
        assertExists(good.headers?.['Set-Cookie'], 'login responds with a session cookie');
        assertStringIncludes(good.headers['Set-Cookie'], 'WORDWIKI_SESSION_TOKEN=');

        const token = good.headers['Set-Cookie'].match(/WORDWIKI_SESSION_TOKEN=([^;]+)/)![1];
        const ctx = ww.resolveSecurityContext(token);
        assertEquals(ctx.actorId, userIds['djz']);
        assert(ctx.roles.has('admin'));

        // Wrong password: re-rendered login page, no session.
        const bad: any = ww.loginRequest({username: 'djz', password: 'nope'});
        assert(!bad.headers?.['Set-Cookie']);

        // Logout revokes the session server-side.
        ww.logout(token);
        assertEquals(ww.resolveSecurityContext(token).actorId, undefined);
    });
});
