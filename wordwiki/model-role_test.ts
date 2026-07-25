// deno-lint-ignore-file no-explicit-any
/**
 * Semantic $role declarations (multi-dictionary-survey.md phase 1): a
 * relation declares WHICH behavioral role it plays (lifecycle, publicGate,
 * ...) so core code asks the schema instead of hard-coding tags.  Parse
 * validation, one-relation-per-role, field references, round trip.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";

function schemaJson(entryExtra: any): any {
    return {
        $type: 'schema', $name: 'tst', $tag: 'tst',
        entry: {
            $type: 'relation', $tag: 'ent',
            entry_id: {$type: 'primary_key'},
            ...entryExtra,
        },
    };
}

function parse(json: any): model.Schema {
    return model.Schema.parseSchemaFromCompactJson('role-test', json);
}

const LIFECYCLE = {
    $type: 'relation', $tag: 'sta',
    status_id: {$type: 'primary_key'},
    status: {$type: 'enum', $bind: 'attr1'},
    $role: {name: 'lifecycle', field: 'status', archivedPrefix: 'Archived'},
};

test("$role: string shorthand and object form both parse onto the relation", () => {
    const s = parse(schemaJson({
        status: LIFECYCLE,
        public: {$type: 'relation', $tag: 'pub',
                 public_id: {$type: 'primary_key'}, $role: 'publicGate'},
    }));
    assertEquals(s.relationsByRole.lifecycle?.tag, 'sta');
    assertEquals(s.relationsByRole.lifecycle?.role?.archivedPrefix, 'Archived');
    assertEquals(s.relationsByRole.publicGate?.tag, 'pub');
    assertEquals(s.relationsByRole.workflowTag, undefined);
});

test("$role: unknown role name / unknown key / bad field are parse errors", () => {
    assertThrows(() => parse(schemaJson({
        status: {...LIFECYCLE, $role: 'lifecycles'}})),
        Error, "unknown $role name");
    assertThrows(() => parse(schemaJson({
        status: {...LIFECYCLE, $role: {name: 'lifecycle', prefix: 'X'}}})),
        Error, "unknown $role key 'prefix'");
    assertThrows(() => parse(schemaJson({
        status: {...LIFECYCLE, $role: {name: 'lifecycle', field: 'no_such'}}})),
        Error, "names unknown field 'no_such'");
    assertThrows(() => parse(schemaJson({
        public: {$type: 'relation', $tag: 'pub', public_id: {$type: 'primary_key'},
                 $role: {name: 'publicGate', archivedPrefix: 'X'}}})),
        Error, "only meaningful on the 'lifecycle' role");
});

test("$role: two relations claiming one role is a schema error", () => {
    assertThrows(() => parse(schemaJson({
        status: LIFECYCLE,
        status2: {...LIFECYCLE, $tag: 'st2'},
    })), Error, "at most one relation");
});

test("$role round-trips through schemaToCompactJson", () => {
    const s1 = parse(schemaJson({
        status: LIFECYCLE,
        public: {$type: 'relation', $tag: 'pub',
                 public_id: {$type: 'primary_key'}, $role: 'publicGate'},
    }));
    const j = s1.schemaToCompactJson();
    // string shorthand for a bare role, object form when params are set
    assertEquals(j.entry.public.$role, 'publicGate');
    assertEquals(j.entry.status.$role,
                 {name: 'lifecycle', field: 'status', archivedPrefix: 'Archived'});
    const s2 = parse(j);
    assertEquals(s2.relationsByRole.lifecycle?.role, s1.relationsByRole.lifecycle?.role);
});
