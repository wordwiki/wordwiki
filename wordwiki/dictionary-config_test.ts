// deno-lint-ignore-file no-explicit-any
/**
 * The dictionary config TABLE PAIR (dictionary-config.ts): the schema
 * lives in `<table>_config` beside its assertions - synced from the
 * literal (transitional), read by the store, discovered by convention.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as model from "./model.ts";
import * as entrySchema from "./entry-schema.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import { withTestDb } from "./testing.ts";
import * as timestamp from "../liminal/timestamp.ts";

const ensure = () => dictionaryConfig.ensureDictionaryConfig(
    'dict', entrySchema.dictSchemaJson, {slug: 'mmo'});

test("dict_config: ensure writes the canonical schema row, idempotently", async () => {
    await withTestDb(() => security.runSystem(() => {
        ensure();
        const stored = dictionaryConfig.readConfigValue('dict', 'schema')!;
        // Canonical = the round-trip fixed point of the literal.
        assertEquals(stored, dictionaryConfig.canonicalSchemaJsonText(
            'dict', entrySchema.dictSchemaJson));
        // A second ensure changes nothing; a corrupted row is re-synced.
        ensure();
        assertEquals(dictionaryConfig.readConfigValue('dict', 'schema'), stored);
        dictionaryConfig.writeConfigValue('dict', 'schema', '{"corrupt": true}');
        ensure();
        assertEquals(dictionaryConfig.readConfigValue('dict', 'schema'), stored);
    }));
});

test("dict_config: metadata seeds once and edits are never overwritten", async () => {
    await withTestDb(() => security.runSystem(() => {
        ensure();
        assertEquals(dictionaryConfig.readConfigValue('dict', 'slug'), 'mmo');
        dictionaryConfig.writeConfigValue('dict', 'slug', 'renamed');
        ensure();
        assertEquals(dictionaryConfig.readConfigValue('dict', 'slug'), 'renamed');
    }));
});

test("dict_config: the store reads its schema from the config row", async () => {
    await withTestDb(({ww}) => security.runSystem(() => {
        ensure();
        // The stored schema parses to the same shape as the literal.
        assertEquals(Object.keys(ww.store.dictSchema.relationsByTag).sort(),
                     Object.keys(entrySchema.parsedDictSchema().relationsByTag).sort());
        // Edit the STORED schema (an extra entry-level string field);
        // a workspace reload picks it up - the config row is the authority.
        const json = JSON.parse(dictionaryConfig.readConfigValue('dict', 'schema')!);
        json.entry.test_extra = {$type: 'string', $bind: 'attr9', $optional: true};
        dictionaryConfig.writeConfigValue('dict', 'schema', JSON.stringify(json));
        ww.store.requestWorkspaceReload();
        const entryRel = ww.store.dictSchema.relationsByTag[entrySchema.EntryTag];
        assertEquals(entryRel.fieldsByName['test_extra'] instanceof model.StringField, true);
    }));
});

// The gate's workspace-load hook, as the CLI wires it (a fresh workspace
// over the table's assertions under the proposed schema + the store
// validator).
import * as workspaceMod from "./workspace.ts";
import { selectAllAssertions, type Assertion } from "./assertion.ts";
import { assertVersionedDbValid } from "./versioned-db-validate.ts";
const loadWorkspace = (schema: model.Schema) => {
    const ws = new workspaceMod.VersionedDb([schema]);
    selectAllAssertions('dict').all().forEach((a: Assertion) => ws.untrackedApplyAssertion(a));
    assertVersionedDbValid(ws);
};

test("schema gate: add-field passes; removals with data at rest fail", async () => {
    const { mkEntry, mkChild, TestTimeline } = await import("./testing.ts");
    await withTestDb(({ww}) => {
        // Data at rest: one entry with a spelling and a gloss.
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next(), {change_by_username: 'djz'});
        security.runSystem(() => {
            ww.applyTransaction([e], {quiet: true});
            const sub = mkChild(e, 'sub', 1200, tl.next(), {change_by_username: 'djz'});
            ww.applyTransaction([
                mkChild(e, 'spl', 1100, tl.next(),
                        {attr1: "gwan'tal", variant: 'mm-li', change_by_username: 'djz'})],
                {quiet: true});
            ww.applyTransaction([sub], {quiet: true});
            ww.applyTransaction([
                mkChild(sub, 'gls', 1210, tl.next(),
                        {attr1: 'a word', change_by_username: 'djz'})], {quiet: true});
        });

        return security.runSystem(() => {
            const base = JSON.parse(dictionaryConfig.readConfigValue('dict', 'schema')
                ?? dictionaryConfig.canonicalSchemaJsonText('dict', entrySchema.dictSchemaJson));

            // ADD a field: compatible.
            const added = structuredClone(base);
            added.entry.test_extra = {$type: 'string', $bind: 'attr9', $optional: true};
            assertEquals(dictionaryConfig.checkProposedSchema('dict', added,
                {loadWorkspace}).problems, []);

            // REMOVE a field carrying data (the spelling text): fails w/ count.
            const noText = structuredClone(base);
            delete noText.entry.spelling.text;
            const r1 = dictionaryConfig.checkProposedSchema('dict', noText, {loadWorkspace});
            assertEquals(r1.problems.length > 0, true);
            assertEquals(r1.problems[0].includes('attr1'), true);

            // REMOVE a relation with data (gloss): fails wholesale.
            const noGloss = structuredClone(base);
            delete noGloss.entry.subentry.gloss;
            const r2 = dictionaryConfig.checkProposedSchema('dict', noGloss, {loadWorkspace});
            assertEquals(r2.problems.some(p => p.includes("ty 'gls'")), true);

            // A malformed proposal (typo'd $view key) fails at parse.
            const typo = structuredClone(base);
            typo.entry.spelling.$style.$view.bornAproved = true;
            const r3 = dictionaryConfig.checkProposedSchema('dict', typo, {loadWorkspace});
            assertEquals(r3.schema, undefined);
            assertEquals(r3.problems[0].includes("unknown $view key"), true);
        });
    });
});

// A minimal second dictionary: one relation, one text field.  No variant,
// no roles beyond the headword title role - the point is that EVERYTHING
// it needs rides in its own declarations.
const TOY_SCHEMA = {
    $type: 'schema', $name: 'toy', $tag: 'toy',
    // Two-level (entry container + headword child): the meta renderer's
    // structural convention - title roles live on DESCENDANT relations of
    // the entry root.  (A root-level headword FIELD - the shoebox \lx
    // shape - is a .typ-mapping decision for phase 5.)
    entry: {
        $type: 'relation', $tag: 'ten',
        $style: {$shape: 'containerRelation'},
        entry_id: {$type: 'primary_key'},
        word: {
            $type: 'relation', $tag: 'twd',
            $style: {$view: {titleRole: 'headword', label: 'inline'}},
            word_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
        },
    },
};

test("two dictionaries coexist: a toy store edits beside MMO", async () => {
    const { mkEntry, TestTimeline, as, renderRoute } = await import("./testing.ts");
    const schemaRoles = await import("./schema-roles.ts");
    await withTestDb(async (fx) => {
      const {ww} = fx;
      try {
        security.runSystem(() => {
        ensure();
        dictionaryConfig.createDictionary('toy', TOY_SCHEMA, {slug: 'toy'});
        assertEquals(ww.dictionaries(), ['dict', 'toy']);

        // The toy store loads ITS schema from ITS config pair.
        const toy = ww.storeFor('toy');
        assertEquals(toy.assertionTable, 'toy');
        assertEquals(toy.dictSchema.tag, 'toy');
        // (descendantAndSelfRelations includes the schema root itself)
        assertEquals(Object.keys(toy.dictSchema.relationsByTag).sort(),
                     ['ten', 'toy', 'twd']);

        // Edit the toy dictionary THROUGH ITS OWN STORE...
        const tl = new TestTimeline();
        toy.applyTransaction([{
            assertion_id: 5000, id: 5000, ty: 'ten',
            ty0: 'toy', ty1: 'ten', id1: 5000,
            valid_from: tl.next(),
            valid_to: timestamp.END_OF_TIME, order_key: '0.5',
            change_by_username: 'djz'} as any], {quiet: true});
        toy.applyTransaction([{
            assertion_id: 5100, id: 5100, ty: 'twd',
            ty0: 'toy', ty1: 'ten', id1: 5000, ty2: 'twd', id2: 5100,
            attr1: 'hello', valid_from: tl.next(),
            valid_to: timestamp.END_OF_TIME, order_key: '0.5',
            change_by_username: 'djz'} as any], {quiet: true});
        // ...and the projection keys off ITS schema (root relation 'entry').
        const words = toy.entries as any[];
        assertEquals(words.length, 1);
        assertEquals(words[0].word[0].text, 'hello');
        // Role-driven access works from the toy's own declarations.
        assertEquals(schemaRoles.headwordTextsIn(toy.dictSchema, words[0], ''), ['hello']);

        // ...while MMO's store is a different, unaffected world.
        assertEquals(ww.store.assertionTable, 'dict');
        assertEquals(ww.store.entries.length, 0);
        const e = mkEntry(1000, tl.next(), {change_by_username: 'djz'});
        ww.applyTransaction([e], {quiet: true});
        assertEquals(ww.store.entries.length, 1);
        assertEquals((toy.entries as any[]).length, 1);
        });

        // THE FACADE: the toy dictionary's pages dispatch through routeterp
        // (dict() authorized on WordWiki, home/word on the fresh handle).
        const home = JSON.stringify(await as(fx, 'djz',
            () => renderRoute(ww, `wordwiki.dict('toy').home()`)));
        assertEquals(home.includes('hello'), true);
        assertEquals(home.includes('.word(5000)'), true);
        const word = JSON.stringify(await as(fx, 'djz',
            () => renderRoute(ww, `wordwiki.dict('toy').word(5000)`)));
        assertEquals(word.includes('hello'), true);
        // An UNKNOWN dictionary refuses (dispatch wraps the throw into an
        // error response; the refusal semantics live in storeFor).
        let refused = false;
        try { ww.storeFor('nope'); } catch(_e) { refused = true; }
        assertEquals(refused, true);

      } finally {
        // Cleanup so later tests' discovery sees only the default pair.
        security.runSystem(() =>
            db().executeStatements('DROP TABLE IF EXISTS toy; DROP TABLE IF EXISTS toy_dict_config;'));
      }
    });
});

test("dict_config: discovery by the config-pair convention", async () => {
    await withTestDb(() => security.runSystem(() => {
        ensure();
        assertEquals(dictionaryConfig.discoverDictionaries(), ['dict']);
        // A second pair dropped into the db appears; a config table
        // WITHOUT a schema row does not.
        db().executeStatements(dictionaryConfig.createConfigDml('rand'));
        assertEquals(dictionaryConfig.discoverDictionaries(), ['dict']);
        dictionaryConfig.writeConfigValue('rand', 'schema',
            dictionaryConfig.readConfigValue('dict', 'schema')!);
        assertEquals(dictionaryConfig.discoverDictionaries().sort(), ['dict', 'rand']);
        db().executeStatements('DROP TABLE rand_dict_config;');
    }));
});
