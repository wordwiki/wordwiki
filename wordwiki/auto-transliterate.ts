// deno-lint-ignore-file no-explicit-any
/**
 * Auto-transliteration (fix-orthographies.md "Auto-transliteration" — THE
 * motivation for the orthography fix): the editor's per-word button proposes
 * Smith-Francis siblings for a word's Listuguj texts, as NORMAL UNAPPROVED
 * facts authored by the `~auto-transliterate` system identity — so the
 * standard review machinery does the safety work, and the two-person rule
 * comes free (the author is a robot; ANY human approver satisfies it).
 *
 * BUTTON RULES (each dz-settled):
 *  - ONE WORD AT A TIME, at edit time — never a bulk pass (transliterator
 *    improvements made while working word n reach word n+1, and the review
 *    queue only carries words someone is actively working on).
 *  - FILL GAPS ONLY: a relation with ANY live Smith-Francis fact (human or
 *    auto) is never touched.
 *  - NEVER RE-PROPOSE A REJECTED transliteration unless the auto OUTPUT has
 *    changed since: a rejected proposal is a tombstoned robot-authored fact;
 *    re-offering the same wrong answer erodes the trust the workflow
 *    depends on.
 *  - The TRANSLITERATOR_VERSION is stamped in change_arg on every proposal
 *    (per-version quality stats + the retroactive-undo tool need it).
 *  - v1 scope: PURE variant text relations only (schema-driven: a variant
 *    field with no $mixed/$notVariant/$metaVariant + a plain string content
 *    field) — mixed English/Mi'gmaq text is a different, harder problem.
 *    related_entry.unresolved_text is naturally out (no variant field).
 *
 * THE FEEDBACK LOOP IS DATA-DRIVEN: every human correction of an auto fact
 * is mechanically harvestable from the assertion history (a non-robot
 * version superseding a robot version, with the Listuguj source in the
 * sibling fact) — the corrections report below lists them, and that corpus
 * IS the transliterator's regression suite.  The report also measures the
 * CURRENT rules against every human-authored li/sf pair in the dictionary.
 */
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { Markup } from '../liminal/markup.ts';
import { route, authenticated } from '../liminal/security.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as model from './model.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import { Assertion, assertionPathToFields, getAssertionPath } from './assertion.ts';
import { VersionedTuple, VersionedRelation, generateAtEndOrderKey } from './workspace.ts';
import { newId, placeholderTxTime } from './lexeme-ops.ts';
import { transliterateLiToSf, transliterateLiToSfScored, TRANSLITERATOR_VERSION,
         CANDIDATE_TRANSLITERATORS } from './transliterate.ts';
import { variantPolicyByTag } from './variant-policy.ts';
import type { WordWiki } from './wordwiki.ts';

export const AUTO_TRANSLITERATE_USERNAME = '~auto-transliterate';

/** The clean-pair filter for the TRANSLITERATION ORACLE (the harness): a
 *  pair with editorial junk in either side (parentheticals, '?', TBA/TBD,
 *  'or'-lists in single-word tags) teaches the rules nothing but noise.
 *  Kept conservative and REPORTED - the export names what it excluded. */
export function pairJunkReason(li: string, sf: string, tag: string): string | undefined {
    for(const [side, text] of [['li', li], ['sf', sf]] as const) {
        if(text.trim() === '') return `${side} empty`;
        if(/[()\[\]{};]|\?/.test(text)) return `${side} has editorial punctuation`;
        if(/TBA|TBD/i.test(text)) return `${side} has a TBA/TBD placeholder`;
        if(text.includes('\n')) return `${side} is multi-line`;
        if(tag !== 'etx' && /,| or /.test(text)) return `${side} looks like a list (single-word tag)`;
    }
    // An sf IDENTICAL to its li DESPITE containing g is almost certainly an
    // unconverted copy-paste, not real Smith-Francis (g never survives the
    // li->sf conversion in the attested rules) - it teaches the rules the
    // opposite of the truth.  Identical pairs WITHOUT such letters are kept:
    // orthographies legitimately coincide on many words.
    if(li === sf && /[gG]/.test(li)) return 'identical despite g (suspected unconverted copy)';
    return undefined;
}
export const SOURCE_ORTHOGRAPHY = 'mm-li';
export const TARGET_ORTHOGRAPHY = 'mm-sf';

const EOT = timestamp.END_OF_TIME;

// --------------------------------------------------------------------------
// --- The pure-variant-text relations (v1 scope), schema-driven -------------
// --------------------------------------------------------------------------

export interface PureTextRelation { tag: string; contentField: model.ScalarField; }

/** The relations the transliterator may propose into: a PURE variant field
 *  (orthography required, no $mixed) plus exactly one plain-text content
 *  scalar.  Schema-driven, so a new pure text relation joins automatically. */
export function pureTextRelations(schema: model.Schema): Map<string, PureTextRelation> {
    const out = new Map<string, PureTextRelation>();
    for(const [tag, p] of variantPolicyByTag(schema)) {
        if(!p.flags || p.flags.notVariant || p.flags.mixed || p.flags.metaVariant) continue;
        const rel = schema.relationsByTag[tag];
        const texts = rel.scalarFields.filter(f =>
            f instanceof model.StringField
            && !(f instanceof model.EnumField)          // Variant < Enum < String
            && !(f instanceof model.BlobField));        // audio/image < blob
        if(texts.length !== 1) continue;
        out.set(tag, {tag, contentField: texts[0]});
    }
    return out;
}

// --------------------------------------------------------------------------
// --- The proposal op --------------------------------------------------------
// --------------------------------------------------------------------------

export interface ProposalStats {
    proposed: number;
    /** Relations skipped because a live Smith-Francis fact already exists. */
    filledAlready: number;
    /** Proposals withheld because a human rejected the same output before. */
    rejectedBefore: number;
}

/**
 * Propose Smith-Francis siblings for every GAP in one entry (the button's
 * engine).  Facts are authored by the robot identity and queue for normal
 * review; the caller (LexemeEditor.transliterate) supplies reload targets.
 */
/** The entry's part of speech via the SINGLE-SUBENTRY 1-1 (dz): pos lives
 *  on the subentry; when the entry has exactly one, every field of the
 *  entry shares it (97% of entries).  Multi-subentry entries: undefined.
 *  THE one lookup shared by the proposal op, the pick verb and the chips -
 *  their candidate INDEXES must agree. */
export function singleSubentryPos(app: WordWiki, entry_id: number): string | undefined {
    const entryTuple = app.lexemeOps.entryTuple(entry_id);
    const subs = Object.values(entryTuple.childRelations)
        .filter(rel => (rel as VersionedRelation).schema.tag === 'sub')
        .flatMap(rel => [...(rel as VersionedRelation).tuples.values()])
        .map(t => t.mostRecentTuple)
        .filter(tv => tv?.isCurrent);
    if(subs.length !== 1) return undefined;
    return (subs[0]!.assertion.attr1 as string | null) ?? undefined;
}

export function proposeTransliterations(app: WordWiki, entry_id: number): ProposalStats {
    const stats: ProposalStats = { proposed: 0, filledAlready: 0, rejectedBefore: 0 };
    const pure = pureTextRelations(app.dictSchema);
    const entryTuple = app.lexemeOps.entryTuple(entry_id);
    const pos = singleSubentryPos(app, entry_id);
    const proposals: Assertion[] = [];

    const walk = (tuple: VersionedTuple) => {
        for(const rel of Object.values(tuple.childRelations) as VersionedRelation[]) {
            const spec = pure.get(rel.schema.tag);
            if(spec) visitRelation(rel, spec, tuple);
            for(const child of rel.tuples.values()) walk(child);
        }
    };

    const visitRelation = (rel: VersionedRelation, spec: PureTextRelation,
                           parent: VersionedTuple) => {
        const tuples = [...rel.tuples.values()];
        const current = tuples
            .map(t => t.mostRecentTuple)
            .filter(tv => tv?.isCurrent)
            .map(tv => tv!.assertion);
        // FILL GAPS ONLY: any live SF fact (human or auto) closes the relation.
        if(current.some(a => a.variant === TARGET_ORTHOGRAPHY)) {
            stats.filledAlready++;
            return;
        }
        const liTexts = current
            .filter(a => a.variant === SOURCE_ORTHOGRAPHY)
            .map(a => (a as any)[spec.contentField.bind] as string | null)
            .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
        // Rejected proposals: tombstoned robot-authored facts in this
        // relation; their PROPOSED text (the robot version's content).
        const rejectedTexts = new Set<string>();
        for(const t of tuples) {
            if(t.mostRecentTuple?.isCurrent) continue;   // live: not a rejection
            for(const v of t.tupleVersions)
                if(v.assertion.change_by_username === AUTO_TRANSLITERATE_USERNAME
                   && v.assertion.variant === TARGET_ORTHOGRAPHY)
                    rejectedTexts.add(String((v.assertion as any)[spec.contentField.bind] ?? ''));
        }
        const parentAssertion = parent.currentAssertion;
        if(!parentAssertion) return;   // deleted parent: nothing to hang off
        const proposedHere = new Set<string>();
        for(const li of liTexts) {
            const scored = transliterateLiToSfScored(li, {pos});
            const sf = scored.text;
            if(rejectedTexts.has(sf)) { stats.rejectedBefore++; continue; }   // same output, said no
            if(proposedHere.has(sf)) continue;   // two li texts, one sf output
            proposedHere.add(sf);
            // change_arg carries the version AND the calibrated confidence +
            // risk markers (queryable forever: per-band correction rates,
            // the review row's band label, the undo tool's targeting).
            const changeArg = `${TRANSLITERATOR_VERSION} conf=${Math.round(scored.confidence * 100)} ` +
                              `band=${scored.band} markers=${scored.markers.join('+') || 'clean'}`;
            const id = newId();
            proposals.push({
                ...assertionPathToFields([...getAssertionPath(parentAssertion),
                                          [spec.tag, id]]),
                assertion_id: id, id, ty: spec.tag,
                valid_from: placeholderTxTime(), valid_to: EOT,
                order_key: generateAtEndOrderKey(rel),
                [spec.contentField.bind]: sf,
                variant: TARGET_ORTHOGRAPHY,
                change_by_username: AUTO_TRANSLITERATE_USERNAME,
                change_arg: changeArg,
            } as Assertion);
            stats.proposed++;
        }
    };

    walk(entryTuple);
    for(const a of proposals)
        app.applyTransaction([a], {quiet: true});
    return stats;
}

// --------------------------------------------------------------------------
// --- SF readiness (the SF-site prototype - dz 2026-07-08) ------------------
// --------------------------------------------------------------------------

export const SF_AUTO_PUBLISH_USERNAME = '~sf-auto-publish';

export interface SfReadiness {
    entry_id: number;
    /** Pure-text relation instances holding live mm-li content. */
    liRelations: number;
    /** Of those, how many also hold a live mm-sf fact. */
    sfFilled: number;
    /** Already public in mm-sf (published gate). */
    sfPublic: boolean;
}

/** A word is SF-READY when every pure-text relation instance holding live
 *  mm-li content also holds a live mm-sf fact. */
export const isSfReady = (r: SfReadiness): boolean =>
    r.liRelations > 0 && r.sfFilled === r.liRelations;

/** Scan the LI-PUBLIC words for SF readiness.  The coverage notion is the
 *  transliterator's own (pureTextRelations + its filled test), so the
 *  readiness report and the gap-filling proposals can never disagree about
 *  "done".  PENDING (unapproved) SF facts count: readiness guides review,
 *  and the testing auto-publish runs on freshly imported data. */
export function sfReadinessScan(app: WordWiki): SfReadiness[] {
    const pure = pureTextRelations(app.dictSchema);
    const out: SfReadiness[] = [];
    for(const e of app.site(SOURCE_ORTHOGRAPHY).publicEntries) {
        let liRelations = 0, sfFilled = 0;
        const walk = (tuple: VersionedTuple) => {
            for(const rel of Object.values(tuple.childRelations) as VersionedRelation[]) {
                const spec = pure.get(rel.schema.tag);
                if(spec) {
                    const current = [...rel.tuples.values()]
                        .map(t => t.mostRecentTuple)
                        .filter(tv => tv?.isCurrent)
                        .map(tv => tv!.assertion);
                    const hasLi = current.some(a => a.variant === SOURCE_ORTHOGRAPHY
                        && String((a as any)[spec.contentField.bind] ?? '').trim() !== '');
                    if(hasLi) {
                        liRelations++;
                        if(current.some(a => a.variant === TARGET_ORTHOGRAPHY))
                            sfFilled++;
                    }
                }
                for(const child of rel.tuples.values()) walk(child);
            }
        };
        walk(app.lexemeOps.entryTuple(e.entry_id));
        out.push({entry_id: e.entry_id, liRelations, sfFilled,
                  sfPublic: entrySchema.entryIsPublicIn(e, TARGET_ORTHOGRAPHY)});
    }
    return out;
}

/** TESTING ONLY (dz): auto-publish every SF-ready word as mm-sf, with a
 *  born-published gate (the cutover convention - the gate IS the
 *  approval).  On the production flow this decision belongs to the staff,
 *  guided by the SF-ready report; this exists so the freshly imported
 *  test db has an SF site to look at.  Idempotent: an entry with ANY
 *  current mm-sf gate row (published or pending) is left alone. */
export function autoPublishSf(app: WordWiki, opts: {log?: (m: string) => void} = {})
        : {published: number, alreadyGated: number, notReady: number} {
    const log = opts.log ?? ((m: string) => console.info(m));
    const scan = sfReadinessScan(app);
    let published = 0, alreadyGated = 0, notReady = 0;
    db().transaction(() => {
        for(const r of scan) {
            if(!isSfReady(r)) { notReady++; continue; }
            const gates = db().all<{n: number}, any>(
                `SELECT COUNT(*) AS n FROM dict
                 WHERE valid_to = :eot AND ty = '${entrySchema.PublicTag}'
                   AND id1 = :e AND variant = :v`,
                {eot: EOT, e: r.entry_id, v: TARGET_ORTHOGRAPHY})[0].n;
            if(gates > 0) { alreadyGated++; continue; }
            const ts = app.allocTxTimestamps(1, {quiet: true});
            const id = newId();
            db().insert<Assertion, 'assertion_id'>('dict', {
                ty0: entrySchema.DictTag, ty1: entrySchema.EntryTag, id1: r.entry_id,
                ty2: entrySchema.PublicTag, id2: id,
                assertion_id: id, id, ty: entrySchema.PublicTag,
                valid_from: ts, valid_to: EOT,
                published_from: ts, published_to: EOT,   // born-published: the gate IS approval
                order_key: '0.5',
                variant: TARGET_ORTHOGRAPHY,
                change_by_username: SF_AUTO_PUBLISH_USERNAME,
            } as Assertion, 'assertion_id');
            published++;
        }
    });
    if(published > 0) app.requestWorkspaceReload();
    log(`auto-publish-sf: ${published} word(s) newly public in ${TARGET_ORTHOGRAPHY}; ` +
        `${alreadyGated} already gated; ${notReady} of ${scan.length} li-public words not SF-ready`);
    return {published, alreadyGated, notReady};
}

// --------------------------------------------------------------------------
// --- The corrections report + rules accuracy (the development loop) --------
// --------------------------------------------------------------------------

interface CorrectionRow {
    entry_id: number; tag: string; li: string;
    auto: string; version: string | null;
    outcome: 'corrected' | 'rejected' | 'approved-unchanged' | 'pending';
    current: string | null; by: string | null; note: string | null;
}

export class TransliterationReports {
    constructor(private app: WordWiki) {}

    /** Every robot proposal ever made, classified from the assertion history:
     *  corrected (the regression corpus), rejected, approved unchanged, or
     *  still pending. */
    corrections(): CorrectionRow[] {
        const autos = db().all<any, any>(block`
/**/       SELECT * FROM dict
/**/       WHERE change_by_username = '${AUTO_TRANSLITERATE_USERNAME}'
/**/       ORDER BY valid_from`, {});
        const rows: CorrectionRow[] = [];
        const seen = new Set<string>();
        for(const auto of autos) {
            const key = `${auto.ty}:${auto.id}`;
            if(seen.has(key)) continue;
            seen.add(key);
            const versions = db().all<any, any>(
                `SELECT * FROM dict WHERE ty = :ty AND id = :id ORDER BY valid_from, assertion_id`,
                {ty: auto.ty, id: auto.id});
            const last = versions[versions.length - 1];
            const autoText = String(auto.attr1 ?? '');
            const li = this.liSiblingText(auto) ?? '';
            let outcome: CorrectionRow['outcome'];
            let current: string | null = null, by: string | null = null, note: string | null = null;
            if(last.valid_from === last.valid_to) {
                outcome = 'rejected';
                by = last.change_by_username ?? null;
                note = last.change_note ?? null;
            } else if(String(last.attr1 ?? '') !== autoText) {
                outcome = 'corrected';
                current = String(last.attr1 ?? '');
                // The correcting human: the first non-robot version that
                // changed the text (approvals re-assert unchanged text).
                const corrector = versions.find(v =>
                    v.change_by_username !== AUTO_TRANSLITERATE_USERNAME
                    && String(v.attr1 ?? '') !== autoText);
                by = corrector?.change_by_username ?? last.change_by_username ?? null;
                note = corrector?.change_note ?? null;
            } else if(last.change_by_username !== AUTO_TRANSLITERATE_USERNAME) {
                outcome = 'approved-unchanged';
                by = last.change_by_username ?? null;
            } else {
                outcome = 'pending';
            }
            rows.push({entry_id: auto.id1, tag: auto.ty, li, auto: autoText,
                       version: auto.change_arg ?? null, outcome, current, by, note});
        }
        return rows;
    }

    /** The li sibling's current text (the evidence / regression input). */
    private liSiblingText(a: any): string | undefined {
        // The sibling shares the fact's PARENT id (the deepest idN above its
        // own) and its tag.
        const ids = [[a.ty1, a.id1], [a.ty2, a.id2], [a.ty3, a.id3],
                     [a.ty4, a.id4], [a.ty5, a.id5]].filter(([t, _]) => t != null);
        const parentId = ids.length >= 2 ? ids[ids.length - 2][1] : 0;
        const parentCol = `id${ids.length - 1}`;
        return db().first<{attr1: string}>(block`
/**/       SELECT attr1 FROM dict
/**/       WHERE valid_to = ${EOT} AND ty = :ty AND variant = '${SOURCE_ORTHOGRAPHY}'
/**/             AND ${parentCol} = :pid AND attr1 IS NOT NULL LIMIT 1`,
            {ty: a.ty, pid: parentId})?.attr1;
    }

    /** Rules accuracy against EVERY human-authored li/sf sibling pair in the
     *  dictionary — the seed corpus (1,627 pairs at build time) plus every
     *  approved transliteration since. */
    rulesAccuracy(): {pairs: number, exact: number} {
        const {pairs} = this.corpusPairs();
        const exact = pairs.filter(p => transliterateLiToSf(p.li, {pos: p.pos}) === p.sf).length;
        return {pairs: pairs.length, exact};
    }

    /** Every candidate scored against the same corpus - the comparison
     *  dashboard for rules development (incl. the ported previous-generation
     *  transliterators). */
    candidateScores(): Array<{name: string, exact: number, pairs: number}> {
        const {pairs} = this.corpusPairs();
        return CANDIDATE_TRANSLITERATORS.map(c => ({
            name: c.name,
            exact: pairs.filter(p => c.fn(p.li, {pos: p.pos}) === p.sf).length,
            pairs: pairs.length,
        }));
    }

    corpusPairs(): {pairs: Array<{li: string, sf: string, tag: string, pos?: string}>} {
        const pure = pureTextRelations(this.app.dictSchema);
        // PART OF SPEECH via the single-subentry 1-1 (dz): part_of_speech
        // lives on the subentry, not beside the spelling - but 97% of
        // entries have exactly ONE subentry, and there every field of the
        // entry is 1-1 with that sub's POS.  Multi-subentry entries get no
        // pos (ambiguous).  The old expert rules conditioned ey-handling on
        // noun-ness (Transliterate.java rule 100), so the rule finder wants
        // this column.
        const posByEntry = new Map<number, string|undefined>();
        for(const r of db().all<any, any>(block`
/**/           SELECT id1, attr1 FROM dict WHERE ty = 'sub' AND valid_to = ${EOT}`, {})) {
            posByEntry.set(r.id1, posByEntry.has(r.id1) ? undefined : (r.attr1 ?? undefined));
        }
        const out: Array<{li: string, sf: string, tag: string, pos?: string}> = [];
        for(const [tag, spec] of pure) {
            const rows = db().all<any, any>(block`
/**/           SELECT ty1,id1,ty2,id2,ty3,id3,ty4,id4,ty5,id5, variant, ${spec.contentField.bind} AS text
/**/           FROM dict
/**/           WHERE ty = :ty AND valid_to = ${EOT} AND ${spec.contentField.bind} IS NOT NULL
/**/                 AND variant IN ('${SOURCE_ORTHOGRAPHY}', '${TARGET_ORTHOGRAPHY}')`, {ty: tag});
            const groups = new Map<string, {li: string[], sf: string[], entry: number}>();
            for(const r of rows) {
                const ids = [[r.ty1, r.id1], [r.ty2, r.id2], [r.ty3, r.id3],
                             [r.ty4, r.id4], [r.ty5, r.id5]].filter(([t, _]) => t != null);
                const key = ids.slice(0, -1).map(([t, i]) => `${t}:${i}`).join('/') + '/' + tag;
                if(!groups.has(key)) groups.set(key, {li: [], sf: [], entry: r.id1});
                groups.get(key)![r.variant === SOURCE_ORTHOGRAPHY ? 'li' : 'sf'].push(r.text);
            }
            for(const g of groups.values())
                if(g.li.length === 1 && g.sf.length === 1)
                    out.push({li: g.li[0], sf: g.sf[0], tag,
                              pos: posByEntry.get(g.entry) ?? undefined});
        }
        return {pairs: out};
    }

    /** The report page: rules accuracy, per-version outcome stats, and the
     *  corrections list (the regression corpus, newest data first). */
    /** The SF-READINESS report (the SF-site prototype): which li-public
     *  words have ALL their li content transliterated to SF - on the
     *  production flow this guides the staff to the words that are
     *  SF-publishable.  Actionable list = ready but not yet SF-public. */
    @route(authenticated)
    sfReadyReport(): any {
        const scan = sfReadinessScan(this.app);
        const ready = scan.filter(isSfReady);
        const actionable = ready.filter(r => !r.sfPublic);
        const title = 'SF-ready words';
        const body = [
            ['h1', {}, title],
            ['p', {class: 'text-muted'},
             `Words published in Listuguj whose Listuguj content is FULLY matched ` +
             `by Smith-Francis facts (pending ones count - readiness guides review). ` +
             `The coverage rule is the transliterator's own, so this report and the ` +
             `gap-filling proposals always agree.`],
            ['ul', {},
             ['li', {}, `${scan.length} words public in Listuguj`],
             ['li', {}, `${ready.length} fully transliterated to Smith-Francis`],
             ['li', {}, `${ready.length - actionable.length} of those already public in Smith-Francis`],
             ['li', {}, ['b', {}, `${actionable.length} ready to be made public in Smith-Francis`]]],
            actionable.length === 0
                ? ['p', {class: 'text-muted'}, 'Nothing actionable.']
                : ['ul', {},
                   // The normal word-link presentation, FORCED to the SF lane
                   // (dz: people prioritizing from this list need the English
                   // gloss, and should see the word as the SF site will show
                   // it).  Every actionable word has SF spellings by
                   // definition - readiness requires the spelling slot filled.
                   actionable.map(r => {
                       const e = this.app.store.entriesById.get(r.entry_id);
                       return ['li', {},
                           e ? templates.lexemeLink(r.entry_id,
                                   entrySchema.renderEntryCompactSummary(
                                       e, {orthography: TARGET_ORTHOGRAPHY}),
                                   {viewOrthography: TARGET_ORTHOGRAPHY})
                             : templates.lexemeLink(r.entry_id, `entry ${r.entry_id}`)];
                   })],
        ];
        return templates.pageTemplate({title, body});
    }

    @route(authenticated)
    correctionsReport(): any {
        const rows = this.corrections();
        const acc = this.rulesAccuracy();
        const byVersion = new Map<string, {corrected: number, rejected: number,
                                           approved: number, pending: number}>();
        for(const r of rows) {
            const v = (r.version ?? '(unstamped)').split(' ')[0];
            if(!byVersion.has(v)) byVersion.set(v, {corrected: 0, rejected: 0, approved: 0, pending: 0});
            const g = byVersion.get(v)!;
            if(r.outcome === 'corrected') g.corrected++;
            else if(r.outcome === 'rejected') g.rejected++;
            else if(r.outcome === 'approved-unchanged') g.approved++;
            else g.pending++;
        }
        const title = 'Transliteration Report';
        const outcomeRows = rows.filter(r => r.outcome === 'corrected' || r.outcome === 'rejected');
        const link = (r: CorrectionRow) =>
            ['a', {...templates.pageLinkProps(`/ww/wordwiki.entry(${r.entry_id})`),
                   class: 'lm-nav-link'}, r.li || `entry ${r.entry_id}`];
        const body: Markup = [
            ['h1', {}, title],
            ['p', {class: 'text-muted'},
             `Current rules (${TRANSLITERATOR_VERSION}): ${acc.exact} of ${acc.pairs} ` +
             'human-written Listuguj/Smith-Francis pairs transliterate exactly — every human ' +
             'correction below is a regression case for the next rules version.'],
            ['h2', {class: 'h5 mt-4'}, 'Candidate transliterators vs the corpus'],
            ['table', {class: 'lm-data-table'},
             ['thead', {}, ['tr', {}, ['th', {}, 'Candidate'], ['th', {}, 'Exact'],
              ['th', {}, 'Accuracy']]],
             ['tbody', {}, this.candidateScores().map(c =>
              ['tr', {}, ['td', {}, c.name],
               ['td', {}, `${c.exact}/${c.pairs}`],
               ['td', {}, `${c.pairs > 0 ? Math.round(c.exact * 1000 / c.pairs) / 10 : 0}%`]])]],
            ['h2', {class: 'h5 mt-4'}, 'Outcomes by confidence band'],
            ['p', {class: 'text-muted small mb-1'},
             'The calibration check: a band\u2019s correction rate should track its predicted ' +
             'error rate - a \u201chigh\u201d band corrected often means the calibration is wrong.'],
            (() => {
                const byBand = new Map<string, {corrected: number, rejected: number,
                                                approved: number, pending: number}>();
                for(const r of rows) {
                    const band = /band=(\w+)/.exec(r.version ?? '')?.[1] ?? '(unscored)';
                    if(!byBand.has(band)) byBand.set(band, {corrected: 0, rejected: 0, approved: 0, pending: 0});
                    const g = byBand.get(band)!;
                    if(r.outcome === 'corrected') g.corrected++;
                    else if(r.outcome === 'rejected') g.rejected++;
                    else if(r.outcome === 'approved-unchanged') g.approved++;
                    else g.pending++;
                }
                return ['table', {class: 'lm-data-table'},
                    ['thead', {}, ['tr', {},
                     ['th', {}, 'Band'], ['th', {}, 'Approved unchanged'], ['th', {}, 'Corrected'],
                     ['th', {}, 'Rejected'], ['th', {}, 'Pending'], ['th', {}, 'Correction rate']]],
                    ['tbody', {}, [...byBand.entries()].map(([band, g]) => {
                        const settled = g.approved + g.corrected;
                        return ['tr', {}, ['td', {}, band], ['td', {}, String(g.approved)],
                            ['td', {}, String(g.corrected)], ['td', {}, String(g.rejected)],
                            ['td', {}, String(g.pending)],
                            ['td', {}, settled > 0 ? `${Math.round(g.corrected * 100 / settled)}%` : '\u2014']];
                    })]];
            })(),
            ['h2', {class: 'h5 mt-4'}, 'Proposals by transliterator version'],
            ['table', {class: 'lm-data-table'},
             ['thead', {}, ['tr', {},
              ['th', {}, 'Version'], ['th', {}, 'Approved unchanged'], ['th', {}, 'Corrected'],
              ['th', {}, 'Rejected'], ['th', {}, 'Pending']]],
             ['tbody', {}, [...byVersion.entries()].map(([v, g]) =>
              ['tr', {}, ['td', {}, v], ['td', {}, String(g.approved)],
               ['td', {}, String(g.corrected)], ['td', {}, String(g.rejected)],
               ['td', {}, String(g.pending)]])]],
            ['h2', {class: 'h5 mt-4'}, 'Corrections + rejections (the regression corpus)'],
            outcomeRows.length === 0
                ? ['p', {class: 'text-muted'}, 'None yet.']
                : ['table', {class: 'lm-data-table'},
                   ['thead', {}, ['tr', {},
                    ['th', {}, 'Listuguj source'], ['th', {}, 'Auto proposal'],
                    ['th', {}, 'Human result'], ['th', {}, 'By'], ['th', {}, 'Why (note)']]],
                   ['tbody', {}, outcomeRows.map(r =>
                    ['tr', {},
                     ['td', {}, link(r)],
                     ['td', {class: 'text-muted'}, r.auto],
                     ['td', {}, r.outcome === 'rejected'
                         ? ['span', {class: 'badge text-bg-secondary'}, 'rejected']
                         : (r.current ?? '')],
                     ['td', {class: 'text-muted'}, r.by ?? ''],
                     ['td', {class: 'text-muted'}, r.note ?? '']])]],
        ];
        return templates.pageTemplate({title, body});
    }
}
