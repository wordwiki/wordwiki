// deno-lint-ignore-file no-explicit-any
/**
 * Role-driven access to the ENTRY JSON PROJECTION (multi-dictionary-survey.md
 * phase 1): the generic implementations behind the helpers that used to
 * hard-code the MMO relation names (entryIsPublicIn walking `.status` and
 * `.public`, getSpellings walking `.spelling`, ...).  Everything here takes
 * the parsed model.Schema and asks it - which relation plays the lifecycle
 * role, what that relation's value field is called, what the name-path from
 * the entry root down to a relation is - so a second dictionary with a
 * different schema gets these behaviors from its own declarations.
 *
 * BEHAVIOR-IDENTICAL discipline: each function replicates the exact
 * semantics of the hand helper it generalizes (down to getSpellings' loose
 * `== orthography || blank` lane test vs entryIsPublicIn's variantMatches -
 * two deliberately different notions), locked by the suite and the
 * publish-tree byte comparison.
 */
import * as model from './model.ts';
import { variantMatches } from './variant-policy.ts';
import { panic } from '../liminal/utils.ts';

/** The child-relation NAME path from the entry root relation down to
 *  `target` (exclusive of the root), e.g. subentry/category -> ['subentry',
 *  'category'].  ancestorRelations = [Schema, entryRoot, ...parents]. */
function namePathFromEntry(target: model.RelationField): string[] {
    const chain = [...target.ancestorRelations, target];
    if(chain.length < 2)
        throw new Error(`relation '${target.name}' is not under an entry root`);
    return chain.slice(2).map(r => r.name);
}

/** Every tuple of `target` under this entry (all branches), [] when the
 *  relation is absent from the projection or undeclared. */
export function collectTuples(entryJson: any, target: model.RelationField|undefined): any[] {
    if(!target) return [];
    let nodes: any[] = [entryJson];
    for(const name of namePathFromEntry(target))
        nodes = nodes.flatMap(node => (node?.[name] ?? []) as any[]);
    return nodes;
}

/** The role's declared VALUE field name ($role.field - explicit, never
 *  guessed). */
function roleValueField(rel: model.RelationField): string {
    return rel.role?.field
        ?? panic(`relation '${rel.name}' role '${rel.role?.name}' declares no field`);
}

/** The relation's variant (orthography) field name, if it has one. */
function variantFieldName(rel: model.RelationField): string|undefined {
    return rel.scalarFields.find(f => f instanceof model.VariantField)?.name;
}

/** The tuple's text under its relation's text field (see textFieldName). */
export function tupleText(rel: model.RelationField, tuple: any): string {
    return tuple[textFieldName(rel)];
}

/** The relation's text-carrying field: the first non-key, non-variant
 *  string scalar (the shape every text-bearing leaf relation here has). */
function textFieldName(rel: model.RelationField): string {
    return rel.scalarFields.find(f =>
        !(f instanceof model.PrimaryKeyField) && !(f instanceof model.VariantField)
            && f.jsTypename() === 'string')?.name
        ?? panic(`relation '${rel.name}' has no text field`);
}

// --- Title-role relations (headword / gloss - $view.titleRole) ---------------

export function headwordRelation(schema: model.Schema): model.RelationField|undefined {
    return schema.descendantAndSelfRelations.find(r => r.style.$view?.titleRole === 'headword');
}

export function glossRelation(schema: model.Schema): model.RelationField|undefined {
    return schema.descendantAndSelfRelations.find(r => r.style.$view?.titleRole === 'gloss');
}

/** The entry's headword tuples in ONE orthography lane; legacy blanks count
 *  as every lane.  (The EXACT lane test of the old getSpellings: loose
 *  equality + blank - NOT the 'mm'-aware variantMatches; headword lanes
 *  never store the wildcard.) */
export function headwordTuplesIn(schema: model.Schema, entryJson: any, orthography: string): any[] {
    const rel = headwordRelation(schema);
    if(!rel) return [];
    const v = variantFieldName(rel);
    return collectTuples(entryJson, rel)
        .filter(s => v === undefined || s[v] == orthography || !s[v]);
}

export function headwordTextsIn(schema: model.Schema, entryJson: any, orthography: string): string[] {
    const rel = headwordRelation(schema);
    return rel ? headwordTuplesIn(schema, entryJson, orthography).map(s => s[textFieldName(rel)]) : [];
}

export function glossTexts(schema: model.Schema, entryJson: any): string[] {
    const rel = glossRelation(schema);
    return rel ? collectTuples(entryJson, rel).map(g => g[textFieldName(rel)]) : [];
}

/** The FIRST headword tuple in ANY lane, keys normalized to {text, variant}
 *  - the cross-orthography fallback when the selected lane is empty (dz:
 *  wrong-orthography text beats a blank headword). */
export function headwordFallback(schema: model.Schema, entryJson: any):
        {text: string, variant: string|undefined} | undefined {
    const rel = headwordRelation(schema);
    if(!rel) return undefined;
    const first = collectTuples(entryJson, rel)[0];
    if(first === undefined) return undefined;
    const v = variantFieldName(rel);
    return {text: first[textFieldName(rel)],
            variant: v !== undefined ? first[v] : undefined};
}

// --- Lifecycle + publish gate -------------------------------------------------

/** Is this slug in the lifecycle role's ARCHIVED family?  A schema with no
 *  lifecycle role (or no archivedPrefix) has no archived notion. */
export function isArchivedSlug(schema: model.Schema, slug: string): boolean {
    const prefix = schema.relationsByRole.lifecycle?.role?.archivedPrefix;
    return prefix !== undefined && slug.startsWith(prefix);
}

/** Whether the entry carries ANY archived lifecycle tuple (an entry oddly
 *  holding both an archived and a live status counts as archived). */
export function entryIsArchived(schema: model.Schema, entryJson: any): boolean {
    const rel = schema.relationsByRole.lifecycle;
    if(!rel) return false;
    const field = roleValueField(rel);
    return collectTuples(entryJson, rel).some(s => isArchivedSlug(schema, s[field]));
}

/** THE COMPOSITION RULE (fix-orthographies.md "Status"): public in
 *  orthography O iff not archived AND a publicGate tuple matches O
 *  (variantMatches - the gate honours the 'mm' wildcard).  A schema with no
 *  publicGate role publishes nothing through this predicate. */
export function entryIsPublicIn(schema: model.Schema, entryJson: any, orthography: string): boolean {
    const gate = schema.relationsByRole.publicGate;
    if(!gate) return false;
    if(entryIsArchived(schema, entryJson)) return false;
    const v = variantFieldName(gate);
    return collectTuples(entryJson, gate)
        .some(p => variantMatches(v !== undefined ? p[v] : undefined, orthography));
}

// --- Category + document references -------------------------------------------

/** The entry's category slugs (category role), in tuple order. */
export function categoryValues(schema: model.Schema, entryJson: any): string[] {
    const rel = schema.relationsByRole.category;
    if(!rel) return [];
    const field = roleValueField(rel);
    return collectTuples(entryJson, rel).map(c => c[field]);
}

export function entryHasCategory(schema: model.Schema, entryJson: any, category: string): boolean {
    const rel = schema.relationsByRole.category;
    if(!rel) return false;
    const field = roleValueField(rel);
    return collectTuples(entryJson, rel).some(c => c[field] === category);
}

/** The headword sort key: the FIRST headword tuple's text, any lane (the
 *  old `spelling[0]?.text ?? ''`). */
export function headwordSortKey(schema: model.Schema, entryJson: any): string {
    return headwordFallback(schema, entryJson)?.text ?? '';
}

/** The documentReference role's bounding-group id field: the scalar marked
 *  $shape 'boundingGroup' (the same marker the renderers dispatch on). */
function boundingGroupFieldName(rel: model.RelationField): string {
    return rel.scalarFields.find(f => f.style.$shape === 'boundingGroup')?.name
        ?? panic(`relation '${rel.name}' has no boundingGroup field`);
}

/** Every referenced bounding-group id on the entry, in tuple order. */
export function referenceGroupIds(schema: model.Schema, entryJson: any): number[] {
    const rel = schema.relationsByRole.documentReference;
    if(!rel) return [];
    const field = boundingGroupFieldName(rel);
    return collectTuples(entryJson, rel).map(d => d[field]);
}

// --- Workflow tags ---------------------------------------------------------------

/** The entry's workflowTag tuples, optionally only those whose tag value is
 *  `slug`. */
export function workflowTagTuples(schema: model.Schema, entryJson: any, slug?: string): any[] {
    const rel = schema.relationsByRole.workflowTag;
    if(!rel) return [];
    const field = roleValueField(rel);
    const tuples = collectTuples(entryJson, rel);
    return slug === undefined ? tuples : tuples.filter(t => t[field] === slug);
}

// --- Audio-bearing relations ------------------------------------------------------

/** Every relation carrying an audio field (entry recordings, example
 *  recordings, whatever a schema declares) - for sweeps like the publish
 *  missing-audio warnings. */
export function audioRelations(schema: model.Schema): model.RelationField[] {
    return schema.descendantAndSelfRelations.filter(r =>
        r.scalarFields.some(f => f instanceof model.AudioField));
}

export function audioFieldName(rel: model.RelationField): string {
    return rel.scalarFields.find(f => f instanceof model.AudioField)?.name
        ?? panic(`relation '${rel.name}' has no audio field`);
}

/** The speaker-style label field: the first enum that is not the
 *  orthography (speaker on the MMO recording relations). */
export function speakerFieldName(rel: model.RelationField): string|undefined {
    return rel.scalarFields.find(f =>
        f instanceof model.EnumField && !(f instanceof model.VariantField))?.name;
}

/** The first headword text stored EXACTLY in `lane` (strict equality - the
 *  public-id rule: no blank pass-through, no wildcard), undefined if none. */
export function firstHeadwordTextInExactLane(schema: model.Schema, entryJson: any,
                                             lane: string): string|undefined {
    const rel = headwordRelation(schema);
    if(!rel) return undefined;
    const v = variantFieldName(rel);
    const hit = collectTuples(entryJson, rel)
        .filter(s => v !== undefined && s[v] === lane)[0];
    return hit !== undefined ? hit[textFieldName(rel)] : undefined;
}

// --- Featured recording ---------------------------------------------------------

/** One stable recording tuple to feature (choice keyed on the entry's
 *  primary key so it never jitters), undefined when none / no role. */
export function stableFeaturedRecording(schema: model.Schema, entryJson: any): any|undefined {
    const rel = schema.relationsByRole.recording;
    if(!rel) return undefined;
    const recordings = collectTuples(entryJson, rel);
    if(recordings.length === 0) return undefined;
    const entryRoot = schema.relationFields[0];
    const pk = entryJson[entryRoot.primaryKeyField.name] as number;
    return recordings[pk % recordings.length];
}

// --- Search terms ----------------------------------------------------------------

/** The normalized search-term list: every headword lane's text + every
 *  gloss word.  (The normalization itself - ASCII word chars, lowercase -
 *  is the OLD rule verbatim; per-orthography normalization is the search
 *  replacement's concern, survey §2.7.) */
export function normalizedSearchTerms(schema: model.Schema, entryJson: any): string[] {
    const hw = headwordRelation(schema);
    const spellings = (hw ? collectTuples(entryJson, hw).map(s => s[textFieldName(hw)]) : [])
        .map((s: string) => s.replaceAll(/[^A-Za-z0-9_]/g, "_"));
    const glosses = glossTexts(schema, entryJson)
        .flatMap(gl => gl.split(' ').map(word => word.replaceAll(/[^A-Za-z0-9_]/g, "_")));
    return (spellings.join(' ')+' '+glosses.join(' ')).toLowerCase().split(' ');
}
