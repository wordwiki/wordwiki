// deno-lint-ignore-file no-explicit-any
/**
 * SFM (shoebox/toolbox Standard Format Marker) parsing - the TypeScript
 * port of dz's Sfm.java (the front end of the original shoebox-MMO java
 * pipeline; the .java rides in wordwiki/ as the port source).  This is the front half of the .typ import
 * (multi-dictionary-survey.md phase 5): read a .typ marker hierarchy, read
 * an SFM lexicon file, and recover each record's TREE - SFM has NO close
 * tags, so nesting is entirely inferred from the .typ's mkrOverThis
 * parentage (pop to the nearest ancestor, synthesizing missing levels).
 *
 * Deliberate departures from the Java (each noted in place):
 *  - ENCODING is the caller's problem: everything here parses STRINGS.
 *    (The Java hard-read ISO-8859-1, which would MANGLE the Watson drop -
 *    the data files are UTF-8 while MDF.typ is cp1252-ish; use
 *    decodeSfmFile below.)
 *  - LENIENT tree recovery: real shoebox data violates its own .typ
 *    (undeclared/out-of-place markers).  Where the Java threw, lenient
 *    mode records a PROBLEM and attaches the field somewhere sensible -
 *    the import report is part of the importer's contract (survey §4:
 *    literal import + report, no silent cleanup).
 *  - The record marker comes from the .typ header's \mkrRecord (the Java
 *    hard-coded "lx"); 'lx' stays the fallback.
 *  - Two small Java bugs not reproduced: empty field content at EOF
 *    crashed (StringBuffer.charAt(-1)), and getDepth() dropped its +1
 *    (unused by the recovery - isAncestorOf does the walking).
 */

// --- The flat layer: fields and records ---------------------------------------

export interface SfmField {
    name: string;
    content: string;
    /** Bound by applySchema. */
    node?: SfmSchemaNode;
    children: SfmField[];
}

export interface SfmRecord {
    fields: SfmField[];       // flat, in file order (fields[0] = the record marker)
    root?: SfmField;          // set by applySchema
}

export interface SfmDatabase {
    /** Everything before the first record marker (the \_sh line; the
     *  Watson "Final" files put a blank TEMPLATE record here instead -
     *  headerless files are a leniency case, not an error). */
    headerRecord: SfmRecord | undefined;
    records: SfmRecord[];
}

/**
 * The field lexer, faithfully: a field is `\name` + optional one space +
 * content running until EOF or a backslash that immediately follows a
 * newline (so multi-line content works and mid-line backslashes are
 * data); CRs are invisible (CRLF files behave as LF); ONE trailing
 * newline is stripped per field.
 */
export function* readFields(text: string): Generator<{name: string, content: string}> {
    let i = 0;
    const n = text.length;
    // Skip to the first backslash (leading junk tolerated, like the Java's
    // initial read of the introducing '\').
    while(i < n && text[i] !== '\\') i++;
    while(i < n) {
        i++;   // the '\'
        let name = '';
        while(i < n && text[i] !== ' ' && text[i] !== '\n' && text[i] !== '\r' && text[i] !== '\\') {
            name += text[i];
            i++;
        }
        if(text[i] === ' ') i++;   // the single name/content separator
        let content = '';
        let last = '';
        while(i < n) {
            const c = text[i];
            if(c === '\\' && last === '\n') break;
            if(c !== '\r') { last = c; content += c; }
            i++;
        }
        if(content.endsWith('\n')) content = content.slice(0, -1);
        yield {name, content};
    }
}

/** Split a field stream into records on `recordMarker`, replicating the
 *  Java's record-level behavior: the LAST field of each record loses one
 *  more trailing newline (the blank separator line between records -
 *  "behaviour identical to shoebox"). */
export function readDatabase(text: string, recordMarker: string,
                             opts: {stopAfterCount?: number} = {}): SfmDatabase {
    const stop = opts.stopAfterCount ?? Infinity;
    const records: SfmRecord[] = [];
    let current: SfmField[] = [];
    let headerRecord: SfmRecord | undefined = undefined;
    const finish = () => {
        if(current.length === 0) return;
        const last = current[current.length - 1];
        if(last.content.endsWith('\n')) last.content = last.content.slice(0, -1);
        const record: SfmRecord = {fields: current};
        if(headerRecord === undefined) headerRecord = record;
        else records.push(record);
        current = [];
    };
    for(const {name, content} of readFields(text)) {
        if(name === recordMarker && current.length > 0) {
            finish();
            if(records.length >= stop) return {headerRecord, records};
        }
        // The header "record" opens implicitly with the first field even
        // when that field IS the record marker (the Java reads the header
        // unconditionally first - a file starting \lx puts that first
        // record in the header slot; the Watson Final files' blank
        // template record lands there, exactly like the Java).
        current.push({name, content, children: []});
    }
    finish();
    return {headerRecord, records};
}

// --- The .typ schema -----------------------------------------------------------

export interface SfmSchemaNode {
    tagName: string;
    parentTagName: string | undefined;
    name: string | undefined;         // \nam
    desc: string | undefined;         // \desc
    language: string | undefined;     // \lng
    parent: SfmSchemaNode | undefined;
    children: SfmSchemaNode[];
}

export interface SfmSchema {
    /** The record marker, from the .typ header's \mkrRecord ('lx' fallback). */
    recordMarker: string;
    root: SfmSchemaNode | undefined;
    nodes: Map<string, SfmSchemaNode>;
    problems: string[];               // parentage gaps found while binding
}

const fieldOf = (r: SfmRecord, name: string): string | undefined =>
    r.fields.find(f => f.name === name)?.content;

/** Parse a .typ file's marker hierarchy: one node per \+mkr record,
 *  parentage from \mkrOverThis. */
export function parseTyp(text: string): SfmSchema {
    const db = readDatabase(text, '+mkr');
    const recordMarker =
        (db.headerRecord && fieldOf(db.headerRecord, 'mkrRecord')?.trim()) || 'lx';
    const nodes = new Map<string, SfmSchemaNode>();
    const problems: string[] = [];
    for(const r of db.records) {
        const tagName = fieldOf(r, '+mkr')?.trim();
        if(!tagName) { problems.push('a +mkr record with no marker name'); continue; }
        nodes.set(tagName, {
            tagName,
            parentTagName: fieldOf(r, 'mkrOverThis')?.trim() || undefined,
            name: fieldOf(r, 'nam'),
            desc: fieldOf(r, 'desc'),
            language: fieldOf(r, 'lng'),
            parent: undefined, children: [],
        });
    }
    const root = nodes.get(recordMarker);
    if(!root) problems.push(`the record marker '${recordMarker}' has no +mkr definition`);
    for(const node of nodes.values()) {
        if(node === root) continue;
        const parent = node.parentTagName !== undefined
            ? nodes.get(node.parentTagName) : undefined;
        if(!parent) {
            problems.push(`marker '${node.tagName}' has ${node.parentTagName === undefined
                ? 'no mkrOverThis' : `unknown parent '${node.parentTagName}'`}`);
            continue;
        }
        node.parent = parent;
        parent.children.push(node);
    }
    return {recordMarker, root, nodes, problems};
}

const isAncestorOf = (a: SfmSchemaNode, other: SfmSchemaNode): boolean => {
    for(let p = other.parent; p; p = p.parent)
        if(p === a) return true;
    return false;
};

// --- Tree recovery ---------------------------------------------------------------

export interface SfmProblem {
    recordIndex: number;              // index into db.records
    recordMarkerContent: string;      // the record's headword-ish identity
    kind: 'unknown-marker' | 'misplaced-root' | 'no-ancestor';
    marker: string;
    detail: string;
}

/**
 * Recover one record's tree from its flat field list (the Java
 * applySchema): walk the fields keeping a stack of open levels; for each
 * field pop until the top is a .typ ANCESTOR of it, synthesizing any
 * missing intermediate levels as empty fields.  In lenient mode a field
 * whose marker the .typ does not know (or that fits nowhere) attaches to
 * the RECORD ROOT and is reported; strict mode throws (Java parity).
 */
export function applySchema(db: SfmDatabase, schema: SfmSchema,
                            opts: {lenient?: boolean} = {}): SfmProblem[] {
    const problems: SfmProblem[] = [];
    db.records.forEach((record, recordIndex) => {
        if(record.fields.length === 0) return;
        const rootField = record.fields[0];
        const report = (kind: SfmProblem['kind'], marker: string, detail: string) => {
            if(!opts.lenient) throw new Error(
                `sfm record ${recordIndex} ('${rootField.content}'): ${detail}`);
            problems.push({recordIndex, recordMarkerContent: rootField.content,
                           kind, marker, detail});
        };
        const rootNode = schema.nodes.get(rootField.name);
        if(!rootNode) {
            report('misplaced-root', rootField.name,
                   `record starts with unknown marker '\\${rootField.name}'`);
            return;
        }
        rootField.node = rootNode;
        rootField.children = [];
        record.root = rootField;
        const stack: SfmField[] = [rootField];

        for(let i = 1; i < record.fields.length; i++) {
            const field = record.fields[i];
            field.children = [];
            const node = schema.nodes.get(field.name);
            if(!node) {
                report('unknown-marker', field.name,
                       `marker '\\${field.name}' is not in the .typ - attached to the record root`);
                rootField.children.push(field);
                continue;
            }
            field.node = node;

            // Pop until the top is an ancestor of this field's node.
            let top = stack[stack.length - 1];
            while(stack.length > 0 && !isAncestorOf(top.node!, node)) {
                stack.pop();
                top = stack[stack.length - 1];
            }
            if(stack.length === 0) {
                report('no-ancestor', field.name,
                       `marker '\\${field.name}' fits under no open level - attached to the record root`);
                rootField.children.push(field);
                stack.push(rootField);
                continue;
            }

            // Synthesize any missing levels between the found ancestor and
            // this field's declared parent (empty content, like the Java).
            const missing: SfmSchemaNode[] = [];
            for(let t = node.parent; t && t !== top.node; t = t.parent)
                missing.push(t);
            missing.reverse();
            for(const m of missing) {
                const synthesized: SfmField = {name: m.tagName, content: '', node: m, children: []};
                stack[stack.length - 1].children.push(synthesized);
                stack.push(synthesized);
            }

            stack[stack.length - 1].children.push(field);
            stack.push(field);
        }
    });
    return problems;
}

// --- File decoding ----------------------------------------------------------------

/** Decode an SFM/.typ file's bytes with an explicit encoding - the Watson
 *  drop mixes UTF-8 data files with a cp1252-ish MDF.typ, so the choice is
 *  per file, never a constant (the Java's fixed ISO-8859-1 is exactly the
 *  trap). */
export function decodeSfmBytes(bytes: Uint8Array,
                               encoding: 'utf-8' | 'windows-1252' = 'utf-8'): string {
    return new TextDecoder(encoding).decode(bytes);
}
