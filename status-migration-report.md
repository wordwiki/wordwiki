# Status remodel migration

> **⚠ Point-in-time report — generated 2026-07-07T18:37:26.415Z from `/home/dziegler/projects/wordwiki/mmo/database/db.db [db_purpose: dev]`.**
> This is a record of that moment, not a live view; re-run the generator for current data.

**1 finding(s)** across 6 section(s):

- Preconditions: 0 finding(s)
- Actions applied: 0 finding(s)
- The publish gates created: 0 finding(s)
- CompleteAsPDMOnly — deliberately NO gate (leaves the public site): 1 finding(s)
- Entries with no status: lifecycle synthesized as 'Unknown': 0 finding(s)
- Post-checks: 0 finding(s)

## Preconditions

- no done-marker: migrating

## Actions applied

- rename-lifecycle: Completed → Complete ×6973
- rename-lifecycle: CompletedAsPDMOnly → CompleteAsPDMOnly ×1
- blank-sta-variant: ×7917
- 22847 change(s)

## The publish gates created


| word | public in |
|---|---|
| [agase'wa'latl](/ww/wordwiki.entry(133)) | mm-li |
| [agase'wa'toq](/ww/wordwiki.entry(160)) | mm-li |
| [agase'wit](/ww/wordwiki.entry(194)) | mm-li |
| [agnimatl](/ww/wordwiki.entry(224)) | mm-li |
| [agnimuet](/ww/wordwiki.entry(251)) | mm-li |
| [agnutg](/ww/wordwiki.entry(278)) | mm-li |
| [agnutmajig](/ww/wordwiki.entry(302)) | mm-li |
| [agnutmaqan](/ww/wordwiki.entry(327)) | mm-li |
| [agnutmuatl](/ww/wordwiki.entry(353)) | mm-li |
| [agumegw](/ww/wordwiki.entry(399)) | mm-li |

- … and 6963 more
- 6973 gate(s) created

## CompleteAsPDMOnly — deliberately NO gate (leaves the public site)

- **[lalispam](/ww/wordwiki.entry(1041723266610859)) is Complete-As-PDM-Only: no gate — it will NOT be on the public site (was included by the old rule)**

## Entries with no status: lifecycle synthesized as 'Unknown'

- 983 entries had no status fact - each got a born-published 'Unknown' (stamped ~status-migrate, so a future decision change can find the unedited ones): e.g. [gesmateg](/ww/wordwiki.entry(41878)), [musgu'tat](/ww/wordwiki.entry(80585)), [entry 102928](/ww/wordwiki.entry(102928)), [welo'tmasit](/ww/wordwiki.entry(158047)), [welo'tmat](/ww/wordwiki.entry(158069)), [entry 11500962673525](/ww/wordwiki.entry(11500962673525)), [lamalgeg](/ww/wordwiki.entry(24597464331622)), [entry 31356504080750](/ww/wordwiki.entry(31356504080750)), [sipitoquet](/ww/wordwiki.entry(33725022322257)), [ewlamugsit](/ww/wordwiki.entry(40555038045441))

## Post-checks

- entries without a lifecycle after migration: 0 (want 0); entries with >1: 0 (want 0)
