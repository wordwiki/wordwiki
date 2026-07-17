// The block-kind registry: registration guards, dispatch, and the payload
// read/write path (parse -> migrate -> hydrate; write stamps the version).
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { FieldSet, StringField, EnumField, IntegerField } from "../liminal/table.ts";
import {
    registerBlockKind, unregisterBlockKind, blockKind, allBlockKinds,
    readPayload, writePayload, type BlockKind,
} from "./block-registry.ts";

function titleKind(over: Partial<BlockKind> = {}): BlockKind {
    return {
        kind: 'test-title', label: 'Title', category: 'content',
        schema: new FieldSet('test-title', [
            new EnumField('level', {h1:'h1', h2:'h2'}, {default: 'h2'}),
            new StringField('text', {default: ''}),
        ]),
        render: (p) => ['h2', {}, p.text],
        ...over,
    };
}

// Each test cleans up its own registrations (module-global Map).
function withKind(k: BlockKind, body: () => void) {
    registerBlockKind(k);
    try { body(); } finally { unregisterBlockKind(k.kind); }
}

test("register + lookup: kind is dispatchable by key; allBlockKinds lists it", () => {
    const k = titleKind();
    withKind(k, () => {
        assertEquals(blockKind('test-title'), k);
        assertEquals(allBlockKinds().some(x => x.kind === 'test-title'), true);
    });
    assertEquals(blockKind('test-title'), undefined);   // cleaned up
});

test("register: duplicate kind is rejected", () => {
    withKind(titleKind(), () => {
        assertThrows(() => registerBlockKind(titleKind()), Error, "duplicate block kind 'test-title'");
    });
});

test("register: a non-hydratable payload schema is rejected at registration", () => {
    const bad = titleKind({
        kind: 'test-bad',
        schema: new FieldSet('test-bad', [ new StringField('required_no_default') ]),
    });
    assertThrows(() => registerBlockKind(bad), Error, 'required_no_default');
    assertEquals(blockKind('test-bad'), undefined);
});

test("readPayload: hydrates a stored blob (absent -> default, unknown dropped)", () => {
    const k = titleKind();
    // Old blob: no `text`, and a stray removed field.
    assertEquals(readPayload(k, JSON.stringify({level: 'h1', gone: 'x'})),
        {level: 'h1', text: ''});
    // Garbage / empty -> all defaults.
    assertEquals(readPayload(k, ''), {level: 'h2', text: ''});
    assertEquals(readPayload(k, null), {level: 'h2', text: ''});
});

test("writePayload -> readPayload round-trips and stamps version; v never leaks into the tuple", () => {
    const k = titleKind();
    const stored = writePayload(k, {level: 'h1', text: 'Hi'});
    assertEquals(JSON.parse(stored).v, 0);                 // version stamped
    assertEquals(readPayload(k, stored), {level: 'h1', text: 'Hi'});  // no `v` in the hydrated tuple
});

test("migratePayload: an older-versioned blob is migrated before hydrate", () => {
    // v1 renamed `text` -> `body`; migrate copies it forward.
    const k = titleKind({
        kind: 'test-migrated',
        payloadVersion: 1,
        schema: new FieldSet('test-migrated', [
            new EnumField('level', {h1:'h1', h2:'h2'}, {default: 'h2'}),
            new StringField('body', {default: ''}),
        ]),
        migratePayload: (p, from) => from < 1 ? {...p, body: p.text ?? ''} : p,
    });
    withKind(k, () => {
        // A v0 blob (no `v`) with the old `text` field.
        assertEquals(readPayload(k, JSON.stringify({level: 'h1', text: 'old'})),
            {level: 'h1', body: 'old'});
        // A current-version blob is not re-migrated.
        assertEquals(readPayload(k, writePayload(k, {level: 'h2', body: 'new'})),
            {level: 'h2', body: 'new'});
    });
});

test("readPayload: a present-but-stale value survives (no throw)", () => {
    const k = titleKind();
    assertEquals(readPayload(k, JSON.stringify({level: 'h9', text: 't'})).level, 'h9');
});

test("integer payload field hydrates too (nullable, no default)", () => {
    const k = titleKind({
        kind: 'test-int',
        schema: new FieldSet('test-int', [ new IntegerField('n', {nullable: true}) ]),
    });
    withKind(k, () => {
        assertEquals(readPayload(k, '{}'), {n: null});
        assertEquals(readPayload(k, JSON.stringify({n: 3})), {n: 3});
    });
});
