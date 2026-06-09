// The db_purpose marker + the destructive-op guard decision.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertFalse } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { checkWipeAllowed } from "./config.ts";

test("config table stores and upserts db_purpose", async () => {
    await withTestDb(() => {
        asSystem(() => {
            const c = getRabid().config;
            assertEquals(c.getDbPurpose(), undefined);   // unset initially
            c.setDbPurpose("test");
            assertEquals(c.getDbPurpose(), "test");
            c.setDbPurpose("production");                 // upsert, not duplicate
            assertEquals(c.getDbPurpose(), "production");
            assertEquals(c.get("db_purpose"), "production");
        });
    });
});

test("wipe is refused only for a production-marked db", () => {
    assertFalse(checkWipeAllowed("production").allowed);  // protected
    assert(checkWipeAllowed("dev").allowed);
    assert(checkWipeAllowed("test").allowed);
    assert(checkWipeAllowed(undefined).allowed);          // unmarked: allowed, but warns
    assert(checkWipeAllowed(undefined).reason);            // ...with a reason
});
