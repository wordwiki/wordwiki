/**
 * Schema-driven variant (orthography) policy: which relation tags carry a
 * variant field, and with which flags (fix-orthographies.md "The target
 * model").  Shared by the scan subcommand and the validator invariants —
 * consumers that must agree exactly on what a tag's variant column may hold.
 * (The central variantMatches rendering/query predicate joins them here in
 * stage 2.)
 */
import * as model from './model.ts';

export interface TagVariantPolicy {
    tag: string;
    relationName: string;
    /** The variant field's flags, or null if the relation has no variant
     *  field at all. */
    flags: model.VariantFlags | null;
}

export function variantPolicyByTag(schema: model.Schema): Map<string, TagVariantPolicy> {
    const out = new Map<string, TagVariantPolicy>();
    for(const rel of schema.descendantAndSelfRelations) {
        const v = rel.modelFields.find(f => f instanceof model.VariantField) as
            model.VariantField | undefined;
        out.set(rel.tag, {tag: rel.tag, relationName: rel.name,
                          flags: v ? v.variantFlags : null});
    }
    return out;
}

/**
 * The values a variant column may hold under these flags: the orthography
 * vocabulary, minus the 'mm' wildcard unless $allowAll grants it.
 */
export function allowedVariantValues(flags: model.VariantFlags,
                                     vocabulary: Iterable<string>): Set<string> {
    const allowed = new Set(vocabulary);
    if(!flags.allowAll)
        allowed.delete('mm');
    return allowed;
}

/** Blank (NULL and '' both occur in the data) — one predicate for both. */
export function isBlankVariant(v: string | null | undefined): boolean {
    return v == null || v === '';
}

/**
 * A stored value that stands for EVERY orthography: the 'mm' ("All
 * Mig'maq-Mi'kmaq") wildcard, and — until the migration backfills them — a
 * legacy blank.  (Blank-as-wild is the pre-migration tolerance: the corpus
 * predates orthography stamping, and treating a blank as scoped to nothing
 * would silently hide legacy content.  Post-migration the validator flips to
 * throw-on-load and blanks cease to exist.)
 */
export function isWildVariant(v: string | null | undefined): boolean {
    return isBlankVariant(v) || v === 'mm';
}

/**
 * THE central 'mm' predicate (fix-orthographies.md "The target model"): does
 * a stored variant value match orthography `orthography`?  Rendering, search,
 * publish and duplicate-spelling detection must agree exactly on this — do
 * not re-derive it inline.
 */
export function variantMatches(fieldVariant: string | null | undefined,
                               orthography: string): boolean {
    return isWildVariant(fieldVariant) || fieldVariant === orthography;
}

/**
 * Do two stored variant values match in SOME shared orthography?  (The pair
 * form of variantMatches: true iff ∃O with variantMatches(a,O) ∧
 * variantMatches(b,O) — a wildcard overlaps everything, otherwise exact.)
 * Duplicate detection's "same orthography" is this, not raw equality: 'mm'
 * vs 'mm-li' IS a same-orthography pair.
 */
export function variantsOverlap(a: string | null | undefined,
                                b: string | null | undefined): boolean {
    return isWildVariant(a) || isWildVariant(b) || a === b;
}

/**
 * The SQL twin of variantMatches, shaped per tag by $allowAll
 * (fix-orthographies.md: $allowAll is a QUERY-PLANNING fact): a tag without
 * it keeps the tight, index-friendly exact form; an $allowAll tag must query
 * exact-or-wildcard.  `column`/`orthographyParam` are spliced verbatim —
 * pass identifiers/named params, never data.
 *
 * (Target-model semantics: no legacy-blank tolerance here.  Pre-migration
 * SQL consumers must handle blanks explicitly if they need them.)
 */
export function variantMatchSql(flags: model.VariantFlags, column: string,
                                orthographyParam: string): string {
    return flags.allowAll
        ? `${column} IN (${orthographyParam}, 'mm')`
        : `${column} = ${orthographyParam}`;
}
