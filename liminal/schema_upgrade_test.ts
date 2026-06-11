// deno-lint-ignore-file no-explicit-any
// schema-upgrade.ts: the additive-or-hands-off contract, against synthetic
// tables on private throwaway dbs (the rabid-side test covers the real model).
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import { Db, db, setDefaultDb } from "./db.ts";
import { Table, PrimaryKeyField, StringField, IntegerField, BooleanField, DateTimeField } from "./table.ts";
import { planUpgrade, applyUpgrade, schemaMatches, formatPlan, checkDbMatchesSchema,
         upgradeDbCommand } from "./schema-upgrade.ts";

// Run fn against a fresh private in-memory db as the ambient db().
async function withScratchDb(fn: (d: Db) => void | Promise<void>): Promise<void> {
    const scratch = Db.openMemory();
    setDefaultDb(scratch);
    try { await fn(scratch); }
    finally { setDefaultDb(undefined); scratch.close(); }
}

// The "yesterday" model and the "today" model of the same table: today adds a
// defaulted string, a nullable integer, and an index.
const oldWidget = () => new Table('widget', [
    new PrimaryKeyField('widget_id', {}),
    new StringField('name', {}),
]);
const newWidget = () => new Table('widget', [
    new PrimaryKeyField('widget_id', {}),
    new StringField('name', {}),
    new StringField('color', {default: ''}),
    new IntegerField('weight', {nullable: true}),
], [
    'CREATE INDEX IF NOT EXISTS widget_by_name ON widget(name);',
]);

test("missing columns/indexes are added; data and defaults survive; idempotent", async () => {
    await withScratchDb(() => {
        db().executeStatements(oldWidget().createDMLString());
        db().execute(`INSERT INTO widget(name) VALUES ('w1')`);

        const plan = planUpgrade([newWidget()]);
        assertEquals(plan.actions.map(a => a.kind).sort(),
                     ['add-column', 'add-column', 'create-index']);
        assert(!schemaMatches(plan));
        applyUpgrade(plan);

        // Existing row preserved; the new defaulted column reads its default.
        const row = db().required<{name: string, color: string, weight: number|null}, {}>(
            'SELECT name, color, weight FROM widget');
        assertEquals(row, {name: 'w1', color: '', weight: null});
        assert(db().first<{name: string}, {}>(
            `SELECT name FROM sqlite_master WHERE type='index' AND name='widget_by_name'`));

        // Second run: nothing left to do.
        assert(schemaMatches(planUpgrade([newWidget()])));
    });
});

test("a missing table is created whole (columns + indexes)", async () => {
    await withScratchDb(() => {
        const plan = planUpgrade([newWidget()]);
        assertEquals(plan.actions.map(a => a.kind), ['create-table']);
        applyUpgrade(plan);
        assert(schemaMatches(planUpgrade([newWidget()])));
        assert(db().first<{name: string}, {}>(
            `SELECT name FROM sqlite_master WHERE type='index' AND name='widget_by_name'`));
    });
});

test("NOT NULL without default refused as a blocker (the ADD COLUMN rule)", async () => {
    await withScratchDb(() => {
        db().executeStatements(oldWidget().createDMLString());
        const model = new Table('widget', [
            new PrimaryKeyField('widget_id', {}),
            new StringField('name', {}),
            new DateTimeField('stamp', {}),   // NOT NULL, no default - un-addable
        ]);
        const plan = planUpgrade([model]);
        assertEquals(plan.actions.length, 0);
        const blockers = plan.issues.filter(i => i.severity === 'blocker');
        assertEquals(blockers.length, 1);
        assert(blockers[0].message.includes('widget.stamp'));
        assert(blockers[0].message.includes('NOT NULL'));
    });
});

test("shape mismatches are blockers, reported never acted on", async () => {
    await withScratchDb(() => {
        // Hand-written legacy table: name has the wrong type and is nullable.
        db().executeStatements(`CREATE TABLE widget(
            widget_id INTEGER PRIMARY KEY ASC NOT NULL,
            name INTEGER);`);
        const plan = planUpgrade([oldWidget()]);
        assertEquals(plan.actions.length, 0);
        const messages = plan.issues.filter(i => i.severity === 'blocker').map(i => i.message);
        assertEquals(messages.length, 2);
        assert(messages.some(m => m.includes('type mismatch')));
        assert(messages.some(m => m.includes('nullability mismatch')));
    });
});

test("drift is noted, never touched: extra columns/tables/indexes; default differences", async () => {
    await withScratchDb(() => {
        db().executeStatements(newWidget().createDMLString());
        db().executeStatements(`
            ALTER TABLE widget ADD COLUMN legacy_thing TEXT;
            CREATE TABLE old_junk(x INTEGER PRIMARY KEY);
            CREATE INDEX widget_by_color ON widget(color);`);
        const plan = planUpgrade([newWidget()]);
        assertEquals(plan.actions.length, 0);
        assert(schemaMatches(plan));   // notes don't block
        const notes = plan.issues.map(i => i.message);
        assert(notes.some(m => m.includes('widget.legacy_thing')));
        assert(notes.some(m => m.includes(`'old_junk'`)));
        assert(notes.some(m => m.includes(`'widget_by_color'`)));

        // A default-value difference is a note (current model says '', db says 'red').
        const redDefault = new Table('widget', [
            new PrimaryKeyField('widget_id', {}),
            new StringField('name', {}),
            new StringField('color', {default: 'red'}),
            new IntegerField('weight', {nullable: true}),
        ], ['CREATE INDEX IF NOT EXISTS widget_by_name ON widget(name);']);
        const plan2 = planUpgrade([redDefault]);
        assert(schemaMatches(plan2));
        assert(plan2.issues.some(i => i.severity === 'note' && i.message.includes('default differs')));
    });
});

test("non-index extraDML is never auto-applied (noted as unverifiable)", async () => {
    await withScratchDb(() => {
        db().executeStatements(oldWidget().createDMLString());
        const withTrigger = new Table('widget', [
            new PrimaryKeyField('widget_id', {}),
            new StringField('name', {}),
        ], [
            'CREATE TRIGGER IF NOT EXISTS widget_trig AFTER INSERT ON widget BEGIN SELECT 1; END;',
        ]);
        const plan = planUpgrade([withTrigger]);
        assertEquals(plan.actions.length, 0);
        assert(plan.issues.some(i => i.severity === 'note' && i.message.includes('not verified')));
    });
});

test("startup gate: throws on mismatch, passes with override, quiet when clean", async () => {
    await withScratchDb(() => {
        db().executeStatements(oldWidget().createDMLString());
        assertThrows(() => checkDbMatchesSchema([newWidget()], 'testapp', false),
                     Error, 'does not match');
        // Override: warns and continues.
        checkDbMatchesSchema([newWidget()], 'testapp', true);
        // Clean db: no throw, no override needed.
        applyUpgrade(planUpgrade([newWidget()]));
        checkDbMatchesSchema([newWidget()], 'testapp', false);
    });
});

test("upgrade-db command: plan-only by default; --apply backs up first; exit codes", async () => {
    const dir = await Deno.makeTempDir({prefix: 'schema_upgrade_test_'});
    const dbPath = `${dir}/test.db`;
    const fileDb = Db.open(dbPath);
    setDefaultDb(fileDb);
    try {
        db().executeStatements(oldWidget().createDMLString());
        db().execute(`INSERT INTO widget(name) VALUES ('w1')`);

        // Plan mode: pending changes -> exit 1, nothing applied, no backup.
        assertEquals(upgradeDbCommand([newWidget()], [], {dbPath}), 1);
        assertEquals(db().all<{name: string}, {}>(`SELECT name FROM pragma_table_info('widget')`).length, 2);

        // Apply: backup file appears, changes land, exit 0.
        assertEquals(upgradeDbCommand([newWidget()], ['--apply'], {dbPath}), 0);
        const backups = [...Deno.readDirSync(dir)].filter(e => e.name.startsWith('test.db.backup-'));
        assertEquals(backups.length, 1);
        assertEquals(db().required<{color: string}, {}>('SELECT color FROM widget').color, '');

        // Now clean: exit 0 in plan mode too.
        assertEquals(upgradeDbCommand([newWidget()], [], {dbPath}), 0);
    } finally {
        setDefaultDb(undefined);
        fileDb.close();
        await Deno.remove(dir, {recursive: true});
    }
});
