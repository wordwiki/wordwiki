# Variant (orthography) migration

> **⚠ Point-in-time report — generated 2026-07-07T16:11:14.608Z from `/home/dziegler/projects/wordwiki/mmo/database/db.db [db_purpose: dev]`.**
> This is a record of that moment, not a live view; re-run the generator for current data.

**5 finding(s)** across 3 section(s):

- Preconditions: 0 finding(s)
- Actions applied (current rows, mute-in-place): 0 finding(s)
- Hand-triage remainder (deliberately untouched): 5 finding(s)

## Preconditions

- flagged schema in force
- scan-variants drop gate: PASS
- backfill mapping covers every keeper tag with blanks (13 keepers)

## Actions applied (current rows, mute-in-place)


| action | tag | new value | rows |
|---|---|---|---|
| normalize-blank | spl | NULL | 191 |
| normalize-blank | sta | NULL | 432 |
| normalize-blank | tdo | NULL | 585 |
| normalize-blank | tra | NULL | 651 |
| null-literal | tra | NULL | 1 |
| normalize-blank | gls | NULL | 1031 |
| null-literal | gls | NULL | 2 |
| normalize-blank | etx | NULL | 31 |
| normalize-blank | etr | NULL | 547 |
| normalize-blank | erc | NULL | 12 |
| normalize-blank | prn | NULL | 13 |
| normalize-blank | alx | NULL | 154 |
| normalize-blank | orf | NULL | 15 |
| normalize-blank | att | NULL | 18 |
| normalize-blank | rtl | NULL | 353 |
| normalize-blank | rse | NULL | 44 |
| normalize-blank | rne | NULL | 46 |
| normalize-blank | rfr | NULL | 1 |
| normalize-blank | src | NULL | 5 |
| normalize-blank | rec | NULL | 29 |
| drop-notVariant | tra | NULL | 35 |
| drop-notVariant | gls | NULL | 24 |
| drop-notVariant | etr | NULL | 12 |
| drop-notVariant | erc | NULL | 531 |
| drop-notVariant | prn | NULL | 8321 |
| drop-notVariant | rec | NULL | 1629 |
| value-fix | rse | mm-pm | 15 |
| value-fix | orf | mm-li | 2 |
| value-fix | spl | mm-li | 1 |
| backfill-blank | spl | mm-li | 192 |
| backfill-blank | sta | mm-li | 433 |
| backfill-blank | tdo | mm | 585 |
| backfill-blank | etx | mm-li | 31 |
| backfill-blank | alx | mm-li | 154 |
| backfill-blank | orf | mm-li | 1724 |
| backfill-blank | att | mm | 12739 |
| backfill-blank | rtl | mm-li | 353 |
| backfill-blank | rse | mm-li | 44 |
| backfill-blank | rne | mm-li | 46 |
| backfill-blank | rfr | mm-li | 1 |
| backfill-blank | rnp | mm | 368 |
| backfill-blank | src | mm | 783 |

- 32184 row(s) changed

## Hand-triage remainder (deliberately untouched)

- **`spl` [gaqigiwto’qwamgwitg](/ww/wordwiki.entry(6600191186939385)): variant 'gaqigiwto’qwamgitg' needs a human decision**
- **`spl` [panilja'sit](/ww/wordwiki.entry(8827091097655615)): variant 'panipja'sit' needs a human decision**
- **`spl` [mpugugwe'l](/ww/wordwiki.entry(6025112336228945)): variant 'mp'gigwe'l' needs a human decision**
- **`spl` [us'seg](/ww/wordwiki.entry(3692627557683377)): variant 'us's'g' needs a human decision**
- **`spl` [ugs'semual](/ww/wordwiki.entry(5586271656062367)): variant 'ugs's'mual' needs a human decision**
