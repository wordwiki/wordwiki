// FieldSet as a page-query codec (table.ts): one {}-literal route argument in,
// normalized typed value; value out, canonical literal string.  Plus the
// TimestampField representation mapping (HLC number <-> datetime-local).
import { test } from "./testing/test.ts";
import { assertEquals, assertThrows, assertStringIncludes } from "./testing/assert.ts";
import { FieldSet, IntegerField, StringField, EnumField, TimestampField } from "./table.ts";
import * as timestamp from "./timestamp.ts";

const q = new FieldSet('test_query', [
    new TimestampField('from_time', {nullable: true}),
    new TimestampField('to_time', {nullable: true}),
    new EnumField('color', {red: 'Red', blue: 'Blue'}, {nullable: true}),
    new StringField('who', {nullable: true}),
    new IntegerField('max_rows', {nullable: true, default: 50}),
]);

test("normalize: absent fields take their default (or null); literals type-checked", () => {
    assertEquals(q.normalize(undefined),
        {from_time: null, to_time: null, color: null, who: null, max_rows: 50});
    assertEquals(q.normalize({to_time: 123, who: 'djz'}).to_time, 123);
    assertEquals(q.normalize({max_rows: 10}).max_rows, 10);
    assertThrows(() => q.normalize({bogus: 1}), Error, 'unknown fields');
    assertThrows(() => q.normalize({to_time: 'soon'}), Error, 'timestamp');
    assertThrows(() => q.normalize({max_rows: 1.5}), Error, 'integer');
    assertThrows(() => q.normalize({color: 'green'}), Error, 'red|blue');
    assertThrows(() => q.normalize([1] as any), Error, 'expected a {}');
});

test("literal: canonical {} - declaration order, null and default-valued fields omitted", () => {
    assertEquals(q.literal(q.normalize(undefined)), '{}');
    assertEquals(q.literal({to_time: 123, max_rows: 50, who: null}), '{to_time:123}');
    assertEquals(q.literal({who: 'dj\'z', to_time: 5, max_rows: 60}),
                 '{to_time:5,who:"dj\'z",max_rows:60}');
});

test("normalize/literal round-trip: equal views produce equal URLs", () => {
    const v = q.normalize({to_time: 99, who: 'sally'});
    assertEquals(q.normalize(eval(`(${q.literal(v)})`)), v);
});

test("parseFormValues: the complete posted state, empty falling back to default/null", () => {
    const v = q.parseFormValues({color: 'red', who: '', max_rows: '25'});
    assertEquals(v.color, 'red');
    assertEquals(v.who, null);        // clearing a text input clears the filter
    assertEquals(v.max_rows, 25);
    assertEquals(v.from_time, null);
    const empties = q.parseFormValues({max_rows: ''});
    assertEquals(empties.max_rows, 50);   // empty -> the field's default
});

test("TimestampField: HLC number <-> datetime-local, round-trip at minute precision", () => {
    const f = new TimestampField('t', {nullable: true});
    const t = timestamp.makeTimestamp(
        Math.floor((Date.UTC(2026, 5, 15, 12, 34, 56) - timestamp.LOCAL_EPOCH_START)/1000), 7);
    const formValue = f.toFormValue(t) as string;
    assertStringIncludes(formValue, 'T');            // datetime-local shape
    assertEquals(formValue.length, 16);              // minute precision
    // Parsing the form value back lands on the same minute (seconds + the
    // HLC counter are display-truncated, as DateTimeField does).
    const back = f.parseSimpleInput(formValue) as number;
    assertEquals(f.toFormValue(back), formValue);
    assertEquals(Math.abs(timestamp.extractTimeFromTimestamp(back)
                          - timestamp.extractTimeFromTimestamp(t)) < 120, true);
    assertEquals(f.parseSimpleInput(''), null);
    assertThrows(() => f.parseSimpleInput('whenever'), Error, 'Invalid date');
});

// hydrate: the read-path for stored JSON payloads (schema-over-JSON blocks).
// A payload schema whose fields are all nullable-or-defaulted.
const payload = new FieldSet('title_payload', [
    new EnumField('level', {h1:'h1', h2:'h2', h3:'h3'}, {default: 'h2'}),
    new StringField('text', {default: ''}),
    new IntegerField('weight', {nullable: true}),
]);

test("hydrate: absent/null fields take default (or null); present values pass through", () => {
    // A blob written before `text` and `weight` existed: absent -> default/null.
    assertEquals(payload.hydrate({level: 'h1'}),
        {level: 'h1', text: '', weight: null});
    // A present value is passed through unchanged.
    assertEquals(payload.hydrate({level: 'h3', text: 'Hi', weight: 5}),
        {level: 'h3', text: 'Hi', weight: 5});
    // Explicit null is treated as absent -> default.
    assertEquals(payload.hydrate({level: null, text: 'x'}).level, 'h2');
});

test("hydrate: unknown keys are DROPPED, not rejected (a removed field)", () => {
    // `subtitle` was removed from the schema; an old blob still carries it.
    assertEquals(payload.hydrate({level: 'h2', text: 'T', subtitle: 'old'}),
        {level: 'h2', text: 'T', weight: null});
});

test("hydrate: a present-but-STALE value is left intact (unlike normalize/fromLiteral)", () => {
    // 'h4' is no longer a valid level (vocabulary shrank).  hydrate must NOT
    // throw - the value survives for the renderer to handle / the form to
    // re-validate on save.  normalize, by contrast, would reject it.
    assertEquals(payload.hydrate({level: 'h4', text: 'x'}).level, 'h4');
    assertThrows(() => payload.normalize({level: 'h4'}), Error, 'h1|h2|h3');
});

test("hydrate: non-object / garbage input yields the all-defaults value", () => {
    const d = {level: 'h2', text: '', weight: null};
    assertEquals(payload.hydrate(undefined), d);
    assertEquals(payload.hydrate(null), d);
    assertEquals(payload.hydrate('nope' as any), d);
    assertEquals(payload.hydrate([1, 2] as any), d);
    assertEquals(payload.defaults(), d);
});

test("assertHydratable: passes when every field is nullable-or-defaulted, else throws listing them", () => {
    payload.assertHydratable();   // no throw
    const bad = new FieldSet('bad_payload', [
        new StringField('ok', {default: ''}),
        new StringField('needs_value'),          // neither nullable nor defaulted
        new IntegerField('also_bad'),            // ditto
    ]);
    assertThrows(() => bad.assertHydratable(), Error, 'needs_value, also_bad');
});
