// The schema-upgrade comparisons against the REAL rabid model: a db built from
// the declared tables must plan clean (this round-trips every field type's DML
// through PRAGMA - enum/boolean defaults, FKs, managed columns, PKs - and will
// catch any field whose created shape doesn't match its declared one).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb } from "./testing.ts";
import { planUpgrade, schemaMatches, formatPlan } from "../liminal/schema-upgrade.ts";
import { rabid } from "./rabid.ts";

test("a db created from the rabid model plans clean (no actions, no issues at all)", async () => {
    await withTestDb(() => {
        const plan = planUpgrade(rabid.tables);
        assert(schemaMatches(plan), formatPlan(plan));
        // Stronger than schemaMatches: our own schema shouldn't even have notes.
        assertEquals(plan.issues, [], formatPlan(plan));
    });
});
