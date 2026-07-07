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
