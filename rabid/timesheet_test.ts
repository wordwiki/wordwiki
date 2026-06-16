// The late-paid-entry warning: a PAID timesheet entry first recorded, or last
// edited, more than 24h after the work ended is a hazy reconstruction and must
// be flagged loudly.  Non-paid time is never flagged.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { hasText, findByTestId } from "../liminal/testing/markup-assert.ts";
import { latePaidReconstruction, latePaidBadge, latePaidAlert } from "./timesheet.ts";

const END = '2026-06-01 12:00:00';
const entry = (o: Partial<{is_paid_time: number, end_time: string|null,
                           entry_creation_time: string, entry_last_edit_time: string}>) =>
    ({is_paid_time: 1, end_time: END, entry_creation_time: END, entry_last_edit_time: END, ...o});

test("paid + entered >24h after end -> 'entered' warning", () => {
    const d = latePaidReconstruction(entry({entry_creation_time: '2026-06-04 12:00:00',   // 3 days
                                            entry_last_edit_time: '2026-06-04 12:00:00'}));
    assert(d);  assertEquals(d!.kind, 'entered');  assertEquals(Math.round(d!.daysLate), 3);
});

test("paid + entered on time but edited >24h after end -> 'edited' warning", () => {
    const d = latePaidReconstruction(entry({entry_creation_time: '2026-06-01 13:00:00',   // prompt
                                            entry_last_edit_time: '2026-06-10 09:00:00'})); // late edit
    assert(d);  assertEquals(d!.kind, 'edited');
});

test("paid + recorded within 24h -> no warning", () => {
    assertEquals(latePaidReconstruction(entry({entry_creation_time: '2026-06-02 09:00:00',
                                               entry_last_edit_time: '2026-06-02 09:00:00'})), null);
});

test("UNPAID entered very late -> no warning (only paid time matters)", () => {
    assertEquals(latePaidReconstruction(entry({is_paid_time: 0,
                                               entry_creation_time: '2026-07-01 12:00:00',
                                               entry_last_edit_time: '2026-07-01 12:00:00'})), null);
});

test("open paid entry (no end_time) -> no warning yet", () => {
    assertEquals(latePaidReconstruction(entry({end_time: null,
                                               entry_creation_time: '2026-07-01 12:00:00'})), null);
});

test("renderers: badge/alert present for a finding, absent (undefined) otherwise", () => {
    const d = latePaidReconstruction(entry({entry_creation_time: '2026-06-05 12:00:00',
                                            entry_last_edit_time: '2026-06-05 12:00:00'}))!;
    const badge = latePaidBadge(d);
    assert(findByTestId(badge, 'late-paid'), 'badge renders');
    assert(hasText(badge, 'late paid'));
    assert(hasText(latePaidAlert(d), 'hazy reconstructions'));
    assertEquals(latePaidBadge(null), undefined);
    assertEquals(latePaidAlert(null), undefined);
});
