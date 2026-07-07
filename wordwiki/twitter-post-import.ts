// deno-lint-ignore-file no-explicit-any
/**
 * Twitter-post import: backfill the `twitter-post` attribute from the RETIRED
 * legacy Shoebox dictionary (legacy-mmo.txt).
 *
 * A language-team member kept posting a word-a-day (twitter + bluesky) in the
 * old system for ~2 years after we retired it, stamping each posted lexeme's
 * `\tp` field.  Those posts never made it here, so the word-a-day picker
 * (wordADayPicker) keeps re-offering already-posted words.  This pass reads
 * the legacy dump and, for each lexeme it can match UNAMBIGUOUSLY to a current
 * entry that has NO twitter-post yet, adds one - stamped `~twitter-post-import`
 * (the automated-identity convention: kept out of the change feed / activity
 * report, and marks the provenance).
 *
 * The legacy file is SFM/Shoebox: backslash field markers, close tags inferred,
 * CRLF line endings, one lexeme per block (a blank line then `\lx SPELLING`).
 * The parse is deliberately narrow - we extract only (`\lx` Listuguj spelling,
 * first `\tp` value) per block; nothing else in the grammar matters here.
 *
 * MATCHING (measured on the real data, 2026-07): 4324 legacy lexemes carry a
 * `\tp`; 4296 match a current entry by Listuguj spelling exactly, of which
 * ~3764 already have a twitter-post (skipped) and ~532 are the real backfill.
 * The 28 leftovers are homonyms (one spelling, several distinct entries) or
 * spellings absent/garbled in the current data - all SKIPPED and logged by
 * spelling for a human to place; auto-guessing a homonym would be wrong.
 *
 * Idempotent: a matched entry that already has a twitter-post is never touched,
 * so a re-run adds nothing (the migration recipe's --expect-no-changes proof).
 * Runs BEFORE backfill-publication in importWordWikiV1Db.sh, so the new attribute
 * rows get born-approved into the published dimension (the word-a-day picker
 * reads publishedEntries) - exactly like the category/lexical-form imports.
 */
import { Assertion, getAssertionPath, assertionPathToFields } from './assertion.ts';
import { VersionedTuple, CurrentTupleQuery, currentTuplesForVersionedRelation } from './workspace.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import type { WordWiki } from './wordwiki.ts';

export const TWITTER_POST_ATTR = 'twitter-post';
export const TWITTER_POST_IMPORT_USER = '~twitter-post-import';

// The Listuguj spelling variants a legacy `\lx` matches (the default variant
// and the explicit Listuguj code; see entry-schema.ts variants).
const LISTUGUJ_VARIANTS = new Set(['', 'mm-li']);

// --- Parsing (pure) ---------------------------------------------------------

/** Parse the legacy SFM dump to a spelling -> twitter-post-value map.  One
 *  entry per lexeme block, keyed by the `\lx` Listuguj spelling; the FIRST
 *  `\tp` in the block wins (a handful carry several).  Blocks with an empty
 *  `\lx` or no `\tp` are skipped.  CRLF-tolerant.  A duplicate `\lx` spelling
 *  keeps its first block's value (matching is by spelling anyway).  Pure. */
export function parseLegacyTwitterPosts(text: string): Map<string, string> {
    const out = new Map<string, string>();
    let lx: string | undefined;
    let tp: string | undefined;
    const flush = () => {
        if(lx && tp && !out.has(lx)) out.set(lx, tp);
        lx = undefined; tp = undefined;
    };
    for(const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if(line.startsWith('\\lx')) {          // a new block begins
            flush();
            lx = line.slice(3).trim();
        } else if(line.startsWith('\\tp') && tp === undefined) {
            const v = line.slice(3).trim();
            if(v !== '') tp = v;
        }
    }
    flush();
    return out;
}

// --- Import over the workspace ----------------------------------------------

/** One skipped legacy post, carried in the stats so the hand-off report
 *  (renderSkippedReport) can name the word, its post entry, and - for a
 *  homonym - every candidate entry with its gloss. */
export interface SkippedPost {
    spelling: string;
    post: string;                    // the legacy \tp value
    candidates: {entryId: number, gloss: string}[];   // empty when unmatched
}

export interface TwitterPostImportStats {
    legacyLexemesWithPost: number;   // (lx, tp) pairs parsed
    added: number;                   // twitter-post rows inserted
    alreadyPresent: number;          // matched entry already had one
    ambiguous: number;               // spelling -> several entries (skipped)
    unmatched: number;               // spelling not found here (skipped)
    ambiguousSpellings: string[];    // logged for a human
    unmatchedSpellings: string[];
    ambiguousDetail: SkippedPost[];  // for the hand-off report
    unmatchedDetail: SkippedPost[];
}

function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/** A map of current Listuguj spelling -> the entry ids carrying it, and the
 *  set of entry ids that already have a twitter-post on any subentry. */
function indexCurrentEntries(ww: WordWiki):
        {bySpelling: Map<string, Set<number>>, haveTp: Set<number>,
         firstSubOf: Map<number, CurrentTupleQuery>, glossOf: Map<number, string>} {
    const dict = ww.workspace.getTableByTag(entrySchema.DictTag);
    const entries = dict.childRelations[entrySchema.EntryTag]?.tuples
        ?? new Map<number, VersionedTuple>();
    const bySpelling = new Map<string, Set<number>>();
    const haveTp = new Set<number>();
    const firstSubOf = new Map<number, CurrentTupleQuery>();
    const glossOf = new Map<number, string>();   // first gloss, for the report

    for(const [entry_id, entryTuple] of entries) {
        if(!entryTuple.currentAssertion) continue;   // deleted entry

        // Spellings hang off the ENTRY (dct/ent/spl); index the Listuguj ones.
        const splRel = entryTuple.childRelations[entrySchema.SpellingTag];
        for(const spl of splRel ? currentTuplesForVersionedRelation(splRel) : []) {
            const a = spl.mostRecentTupleVersion!.assertion as any;
            if(!LISTUGUJ_VARIANTS.has(a.variant ?? '')) continue;
            const text = (a.attr1 as string ?? '').trim();
            if(text === '') continue;
            if(!bySpelling.has(text)) bySpelling.set(text, new Set());
            bySpelling.get(text)!.add(entry_id);
        }

        // twitter-post attributes AND glosses hang off SUBENTRIES
        // (dct/ent/sub/att, dct/ent/sub/gls).
        const subRel = entryTuple.childRelations[entrySchema.SubentryTag];
        const subentries = subRel ? currentTuplesForVersionedRelation(subRel) : [];
        if(subentries.length > 0) firstSubOf.set(entry_id, subentries[0]);
        for(const sub of subentries) {
            const attRel = sub.src.childRelations[entrySchema.AttrTag];
            for(const att of attRel ? currentTuplesForVersionedRelation(attRel) : [])
                if(((att.mostRecentTupleVersion!.assertion as any).attr1 as string) === TWITTER_POST_ATTR)
                    haveTp.add(entry_id);
            if(!glossOf.has(entry_id)) {
                const glsRel = sub.src.childRelations[entrySchema.GlossTag];
                const gls = glsRel ? currentTuplesForVersionedRelation(glsRel) : [];
                const g = gls.length > 0
                    ? ((gls[0].mostRecentTupleVersion!.assertion as any).attr1 as string ?? '').trim() : '';
                if(g !== '') glossOf.set(entry_id, g);
            }
        }
    }
    return {bySpelling, haveTp, firstSubOf, glossOf};
}

export function importTwitterPosts(
        ww: WordWiki, legacyText: string,
        opts: {username?: string, log?: (msg: string) => void} = {}): TwitterPostImportStats {

    const username = opts.username ?? TWITTER_POST_IMPORT_USER;
    const log = opts.log ?? (() => undefined);
    const posts = parseLegacyTwitterPosts(legacyText);
    const {bySpelling, haveTp, firstSubOf, glossOf} = indexCurrentEntries(ww);

    const stats: TwitterPostImportStats = {
        legacyLexemesWithPost: posts.size, added: 0, alreadyPresent: 0,
        ambiguous: 0, unmatched: 0, ambiguousSpellings: [], unmatchedSpellings: [],
        ambiguousDetail: [], unmatchedDetail: [],
    };
    const skipUnmatched = (spelling: string, post: string) => {
        stats.unmatched++; stats.unmatchedSpellings.push(spelling);
        stats.unmatchedDetail.push({spelling, post, candidates: []});
    };

    // applyTransaction requires strictly increasing timestamps, so each
    // assertion is applied in its own tx (which allocates its real server
    // timestamp - the placeholder here is only ordering); mirrors
    // category-import.
    const batchTime = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);

    for(const [spelling, tpValue] of posts) {
        const ids = bySpelling.get(spelling);
        if(!ids || ids.size === 0) { skipUnmatched(spelling, tpValue); continue; }
        if(ids.size > 1) {
            stats.ambiguous++; stats.ambiguousSpellings.push(spelling);
            stats.ambiguousDetail.push({spelling, post: tpValue,
                candidates: [...ids].map(id => ({entryId: id, gloss: glossOf.get(id) ?? '(no gloss)'}))});
            continue;
        }
        const entry_id = [...ids][0];
        if(haveTp.has(entry_id)) { stats.alreadyPresent++; continue; }

        const sub = firstSubOf.get(entry_id);
        if(!sub) {   // an entry with a spelling but no subentry to carry the att
            skipUnmatched(spelling, tpValue); continue;
        }
        const subAssertion = sub.mostRecentTupleVersion!.assertion;
        const id = newId();
        ww.applyTransaction([{
            ...assertionPathToFields([...getAssertionPath(subAssertion),
                                      [entrySchema.AttrTag, id]]),
            ty: entrySchema.AttrTag,
            id,
            assertion_id: id,
            valid_from: batchTime,
            valid_to: timestamp.END_OF_TIME,
            attr1: TWITTER_POST_ATTR,
            attr2: tpValue,
            order_key: '0.51',
            change_by_username: username,
        } as Assertion], {quiet: true});
        haveTp.add(entry_id);   // guard against a duplicate legacy spelling
        stats.added++;
    }

    log(`twitter-post import: ${stats.added} added, ${stats.alreadyPresent} already present, ` +
        `${stats.ambiguous} ambiguous (skipped), ${stats.unmatched} unmatched (skipped) ` +
        `of ${stats.legacyLexemesWithPost} legacy posts`);
    if(stats.ambiguousSpellings.length > 0)
        log(`  ambiguous (homonyms - place by hand): ${stats.ambiguousSpellings.join(', ')}`);
    if(stats.unmatchedSpellings.length > 0)
        log(`  unmatched (not in current data): ${stats.unmatchedSpellings.join(', ')}`);
    return stats;
}

// --- The hand-off report (pure) ---------------------------------------------

// The live editor page for an entry on the production site - the language team
// records the post there, and the fix flows back in on the next migrate pull.
const PRODUCTION_ENTRY_URL = 'https://mikmaqonline.org/ww/wordwiki.entry';

/** Render the skipped-post hand-off list as GitHub-flavored markdown: each
 *  homonym's candidate entries as LIVE links into the production editor (with
 *  glosses to pick by), and each unmatched spelling with its post.  Pure -
 *  the CLI writes it to --report-skipped, so the committed
 *  skipped-twitter-posts.md refreshes every migrate as the list shrinks. */
export function renderSkippedReport(stats: TwitterPostImportStats,
                                    opts: {baseUrl?: string} = {}): string {
    const base = opts.baseUrl ?? PRODUCTION_ENTRY_URL;
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    // Angle-bracket link destination so the parens in entry(N) don't end it.
    const link = (id: number) => `[${id}](<${base}(${id})>)`;
    const total = stats.ambiguous + stats.unmatched;
    const byName = (a: SkippedPost, b: SkippedPost) => a.spelling.localeCompare(b.spelling);
    const ambig = [...stats.ambiguousDetail].sort(byName);
    const unmatched = [...stats.unmatchedDetail].sort(byName);

    const L: string[] = [];
    L.push('# Word-a-day posts that need to be recorded by hand', '');
    L.push('For ~2 years after the old (Shoebox) dictionary was retired, the word-a-day');
    L.push('kept being posted there. We reloaded those posts into the dictionary so the');
    L.push('word-a-day picker stops re-offering already-posted words. Most matched a word');
    L.push(`automatically. These **${total}** did not, so they need a person to record them.`, '');
    L.push('**What to do:** open the correct word on the live site with the link in the');
    L.push('table and mark it posted there (record its twitter-post - the same thing the old');
    L.push('`\\tp` field was). Do it in the **current production system**');
    L.push('(mikmaqonline.org) - those edits are picked up automatically the next time we');
    L.push('reload, and this list shrinks until it is empty before the switch to the new');
    L.push('version.', '');
    L.push('The **post** column is the original entry from the old system (the `#NNNNN` is');
    L.push('the running post number, then the date it was posted).', '');
    L.push('> This file is regenerated by `wordwiki.sh import-twitter-posts', '');
    L.push('> --report-skipped=...` on every migrate, so it stays current as words are fixed.', '');
    L.push(`## Homonyms (${ambig.length}) — one spelling, several words`, '');
    L.push('The spelling belongs to more than one word, so we cannot tell which one was');
    L.push('posted. Open the candidates and mark the right one. In most cases one candidate');
    L.push('is a real word and the other is an empty *(no gloss)* stub - the one with a');
    L.push('meaning is usually right.', '');
    L.push('| Spelling | Post | Which word? (open each, then mark the right one) |');
    L.push('| --- | --- | --- |');
    for(const a of ambig)
        L.push(`| ${esc(a.spelling)} | ${esc(a.post)} | ` +
               `${a.candidates.map(c => `${link(c.entryId)} — ${esc(c.gloss)}`).join('<br>')} |`);
    L.push('');
    L.push(`## Not found (${unmatched.length}) — spelling not in the dictionary`, '');
    L.push('No word on the site has this Listuguj spelling. It may be spelled differently');
    L.push('now, or the word may not have an entry yet. (A garbled character is a glitch in');
    L.push('the old file.) These have no link; find or create the word on the site and mark');
    L.push('it posted.', '');
    L.push('| Spelling | Post |');
    L.push('| --- | --- |');
    for(const u of unmatched)
        L.push(`| ${esc(u.spelling)} | ${esc(u.post)} |`);
    L.push('');
    return L.join('\n');
}
