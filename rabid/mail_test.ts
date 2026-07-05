// Outbound email (liminal/mail.ts) and its wiring into the host reset-link
// flow.  loadMailer's degrade-to-LogMailer branches are exercised with temp
// credential files; the reset-link path is driven THROUGH the strict route
// interpreter (resetLinkView is a mutation reached via hx-post), which also
// pins that it stays a declared route.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, asUser, asAnon } from "./testing.ts";
import { findByTestId } from "../liminal/testing/markup-assert.ts";
import { getRabid, rabid } from "./rabid.ts";
import { loadMailer, LogMailer, SmtpMailer, RecordingMailer } from "../liminal/mail.ts";

// Dispatch resetLinkView the way the dialog's hx-post does: a POST with the
// volunteer_id in the body.
function generateLink(hostId: number, volunteerId: number): Promise<any> {
    return asUser(hostId, () => getRabid().dispatch(
        'rabid.resetLinkView(bodyArgs)',
        {bodyArgs: {volunteer_id: String(volunteerId)}, httpMethod: 'POST'}));
}

// Run `fn` with a temp `<app>-mail-credential.json` in cwd, cleaned up after.
async function withCredentialFile(app: string, contents: string, fn: () => void): Promise<void> {
    const file = `${app}-mail-credential.json`;
    await Deno.writeTextFile(file, contents);
    try { fn(); } finally { await Deno.remove(file); }
}

test("loadMailer: absent credential -> LogMailer (never throws)", () => {
    const m = loadMailer('no-such-app-zzz');
    assert(m instanceof LogMailer);
    assertEquals(m.deliversRealMail, false);
});

test("loadMailer: a complete smtp credential -> SmtpMailer", async () => {
    await withCredentialFile('zzmailtest', JSON.stringify({
        transport: 'smtp', host: 'smtp.gmail.com', port: 465,
        username: 'noreply@example.org', password: 'app-pw', from: 'Org <noreply@example.org>',
    }), () => {
        const m = loadMailer('zzmailtest');
        assert(m instanceof SmtpMailer);
        assertEquals(m.deliversRealMail, true);
    });
});

test("loadMailer: incomplete / unparseable credentials -> LogMailer", async () => {
    await withCredentialFile('zzmailtest', JSON.stringify({host: 'smtp.gmail.com'}), () => {
        assert(loadMailer('zzmailtest') instanceof LogMailer);   // missing username/password/from
    });
    await withCredentialFile('zzmailtest', 'not json at all', () => {
        assert(loadMailer('zzmailtest') instanceof LogMailer);
    });
});

test("host generating a reset link emails it to the volunteer (via the interpreter)", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const app = getRabid();
        const prevMailer = app.mailer, prevBase = app.baseUrl;
        const rec = new RecordingMailer();
        app.mailer = rec;
        app.baseUrl = 'https://rabid.example.org/';
        try {
            const markup = await generateLink(alice, carol);   // alice=host, carol=private-email

            // Exactly one message, to carol, carrying the ABSOLUTE reset link.
            assertEquals(rec.sent.length, 1);
            assertEquals(rec.last!.to, 'carol@test.example');
            assertStringIncludes(rec.last!.subject, 'password');
            assertStringIncludes(rec.last!.text, 'https://rabid.example.org/rabid.resetPassword(');

            // The host UI confirms the send (and still offers the copy fallback).
            assert(findByTestId(markup, 'reset-emailed'), 'shows the "emailed to" note');
            assert(findByTestId(markup, 'reset-link'), 'still shows the copy-link box');
        } finally {
            app.mailer = prevMailer;
            app.baseUrl = prevBase;
        }
    });
});

test("with the default LogMailer, nothing is sent and the copy-only note shows", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const app = getRabid();
        const prevMailer = app.mailer;
        app.mailer = new LogMailer('test');            // deliversRealMail === false
        try {
            const markup = await generateLink(alice, carol);
            assertEquals(findByTestId(markup, 'reset-emailed'), undefined);  // no "emailed to"
            assert(findByTestId(markup, 'reset-link'), 'copy-link box still present');
        } finally {
            app.mailer = prevMailer;
        }
    });
});

test("resetLinkView is host-gated: a regular volunteer and anon are refused", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const dispatch = () => getRabid().dispatch('rabid.resetLinkView(bodyArgs)',
            {bodyArgs: {volunteer_id: String(carol)}, httpMethod: 'POST'});
        await asUser(bob, () => assertRejects(dispatch, Error));   // regular volunteer
        await asAnon(() => assertRejects(dispatch, Error));        // not logged in
    });
});
