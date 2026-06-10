// The password-reset flow: host-minted single-use expiring links; the token in
// the link IS the authentication, and is stored only as a SHA-256 hash.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asAnon, asSystem } from "./testing.ts";
import { find, tagOf, attr, findByTestId } from "../liminal/testing/markup-assert.ts";
import { rabid, getRabid } from "./rabid.ts";
import * as passwordUtils from "../liminal/password.ts";

// Mint a link as `hostId` and return the raw token from the path.
async function mintToken(hostId: number, volunteerId: number, expiryDays?: number): Promise<string> {
    const path = await asUser(hostId, () => rabid.makeResetLinkPath(volunteerId, expiryDays));
    const m = path.match(/resetPassword\("([^"]+)"\)/);
    assert(m, `unexpected reset path: ${path}`);
    return m![1];
}

// Redeem a token (as the anonymous link-holder).
function redeem(token: string, password: string, password2 = password): Promise<any> {
    return asAnon(() => getRabid().dispatch('rabid.resetPasswordRequest(bodyArgs)',
                                            {bodyArgs: {token, password, password2}}));
}

test("host mints a link; the volunteer sets a password and is logged straight in", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const token = await mintToken(alice, bob);

        // The db stores only the hash of the token, never the token.
        const hash = await passwordUtils.sha256Hex(token);
        const row = asSystem(() => rabid.passwordReset.byTokenHash.first({reset_token_hash: hash}));
        assert(row, "reset row found by token HASH");
        assert(row!.reset_token_hash !== token);
        assertEquals(row!.created_by_volunteer_id, alice);

        // The link renders the set-password form for the anonymous holder.
        const page = await asAnon(() => renderRoute(`rabid.resetPassword(${JSON.stringify(token)})`));
        assert(find(page, n => tagOf(n) === "input" && attr(n, "name") === "password"));

        // Redeeming sets the password and responds with a fresh session cookie.
        const res = await redeem(token, "brandnewpassword");
        assertStringIncludes(String(res.headers["Set-Cookie"]), "RABID_SESSION_TOKEN=");

        const ph = asSystem(() => rabid.passwordHash.byVolunteerId.first({volunteer_id: bob}));
        assert(ph?.password_salt && ph?.password_hash);
        assert(passwordUtils.constantTimeEqual(
            passwordUtils.hashPassword("brandnewpassword", ph!.password_salt!), ph!.password_hash!));
    });
});

test("a reset is single-use, consumes ALL outstanding links, and ends existing sessions", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const token1 = await mintToken(alice, bob);
        const token2 = await mintToken(alice, bob);

        // bob has a live session that must not survive the reset.
        asSystem(() => rabid.volunteerLoginSession.insert({
            session_token: "stale-session", volunteer_id: bob,
            start_time: "2026-01-01 00:00:00", last_resume_time: "2026-01-01 00:00:00", last_ip: ""}));

        await redeem(token1, "brandnewpassword");

        assertEquals(asSystem(() => rabid.volunteerLoginSession.getBySessionToken.first(
            {session_token: "stale-session"})), undefined);

        // Both the used token and the OTHER outstanding token are dead now.
        const again = await asAnon(() => renderRoute(`rabid.resetPassword(${JSON.stringify(token1)})`));
        assert(findByTestId(again, "reset-invalid"));
        const other = await asAnon(() => renderRoute(`rabid.resetPassword(${JSON.stringify(token2)})`));
        assert(findByTestId(other, "reset-invalid"));
    });
});

test("expired and garbage tokens get one generic invalid page", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const expired = await mintToken(alice, bob, 0);  // expires immediately
        const page = await asAnon(() => renderRoute(`rabid.resetPassword(${JSON.stringify(expired)})`));
        assert(findByTestId(page, "reset-invalid"));
        const garbage = await asAnon(() => renderRoute(`rabid.resetPassword("no-such-token")`));
        assert(findByTestId(garbage, "reset-invalid"));
    });
});

test("weak or mismatched passwords re-render the form and leave the token redeemable", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const token = await mintToken(alice, bob);

        const short = await redeem(token, "short");
        assert(find(short.body ?? short, n => tagOf(n) === "div" && String(attr(n, "class")).includes("alert-danger")));

        const mismatch = await redeem(token, "brandnewpassword", "differentpassword");
        assert(find(mismatch.body ?? mismatch, n => tagOf(n) === "div" && String(attr(n, "class")).includes("alert-danger")));

        // Failures did not consume the token.
        const res = await redeem(token, "brandnewpassword");
        assertStringIncludes(String(res.headers["Set-Cookie"]), "RABID_SESSION_TOKEN=");
    });
});

test("only hosts/admins can mint reset links", async () => {
    await withTestDb(async ({ bob, carol, dave }) => {
        await asUser(bob, () => assertRejects(() => rabid.makeResetLinkPath(carol), Error, "Not permitted"));
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.resetLinkDialog(${carol})`), Error, "Not permitted"));
        // admin (and host, covered above via alice in other tests) may.
        const path = await asUser(dave, () => rabid.makeResetLinkPath(carol));
        assertStringIncludes(path, "rabid.resetPassword(");
    });
});
