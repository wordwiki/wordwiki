// deno-lint-ignore-file no-explicit-any
/**
 * A tiny, fully deterministic fixture for tests: four named volunteers with known
 * roles and contact-visibility choices, so tests can assert against them by name.
 * (Distinct from fake_data.ts, whose job is realistic *volume* - here every value
 * is chosen to exercise a specific rule.)
 *
 *   alice - host;  hides her own phone (a host who hasn't opted in)
 *   bob   - regular; shares phone AND email
 *   carol - regular; hides phone AND email (the fully-private volunteer)
 *   dave  - admin
 */
import type { Rabid } from "./rabid.ts";

export interface Fixture {
    alice: number;   // host
    bob: number;     // regular, shares contact
    carol: number;   // regular, private
    dave: number;    // admin
}

// A complete volunteer row with sensible defaults; override what a case cares about.
function vol(over: Record<string, any>): any {
    return {
        join_date: "2024-01-01",
        name: "Unnamed",
        email: "unnamed@test.example",
        email_visible_to_all_volunteers: 1,
        phone: "(555) 000-0000",
        phone_number_visible_to_all_volunteers: 0,
        skills: "",
        emergency_contact_name: "",
        emergency_contact_phone: "",
        permissions: "",
        archived: 0,
        archived_date: undefined,
        exit_feedback_requested: 0,
        exit_reason: undefined,
        exit_feedback: undefined,
        deleted: 0,
        ...over,
    };
}

// Insert the fixture and return the assigned ids.  Call inside a system context
// (the inserts/reads shouldn't be subject to the field guards).
export function buildFixture(rabid: Rabid): Fixture {
    const alice = rabid.volunteer.insert(vol({
        name: "Alice Host",
        email: "alice@test.example",
        permissions: "host",
        phone: "(555) 111-1111",
        phone_number_visible_to_all_volunteers: 0,   // host, but hides her own phone
        emergency_contact_name: "Morgan Reyes",
        emergency_contact_phone: "(555) 111-9999",
    }));
    const bob = rabid.volunteer.insert(vol({
        name: "Bob Shares",
        email: "bob@test.example",
        phone: "(555) 222-2222",
        phone_number_visible_to_all_volunteers: 1,    // shares phone
        email_visible_to_all_volunteers: 1,            // shares email
        emergency_contact_name: "Jamie Tran",
        emergency_contact_phone: "(555) 222-9999",
    }));
    const carol = rabid.volunteer.insert(vol({
        name: "Carol Private",
        email: "carol@test.example",
        phone: "(555) 333-3333",
        phone_number_visible_to_all_volunteers: 0,     // hides phone
        email_visible_to_all_volunteers: 0,            // hides email
        emergency_contact_name: "Pat Okafor",
        emergency_contact_phone: "(555) 333-9999",
    }));
    const dave = rabid.volunteer.insert(vol({
        name: "Dave Admin",
        email: "dave@test.example",
        permissions: "admin",
        phone: "(555) 444-4444",
    }));
    return { alice, bob, carol, dave };
}
