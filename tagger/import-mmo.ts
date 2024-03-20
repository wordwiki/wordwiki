/**
 * 'Raw' importer for the MMO legacy format.
 *
 * This imports directly into the DB format - we have a nicer path
 * via model.ts - this is scaffolding so we don't have to get that fully
 * working yet.
 */
import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import {block} from "../utils/strings.ts";
import { ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt, Assertion, assertionFieldNames } from './schema.ts';
import * as config from "./config.ts";
import * as timestamp from "../utils/timestamp.ts";

// TODO: CLI, read the json in.
// TODO: recursively build structure

async function importMMO() {
    // XXX TODO move this file/path into our import tree.
    const entries = JSON.parse(await Deno.readTextFile("/home/dziegler/wordwiki/importer/mikmaq/entry-tuples.json")) as Entry[];

    console.info('entry count', entries.length);

    console.info(entries.map(e=>e.entry_id).toSorted());

    db().beginTransaction();
    db().execute('DELETE FROM assertion', {});

    entries.forEach(e=>true ? importEntry(e) : undefined);
    
    db().endTransaction();
}

function insertAssertion(assertion: Assertion): Assertion {
    //console.info('inserting assertion', assertion);
    db().execute<Assertion>(
        `INSERT INTO assertion (${assertionFieldNames.join(',')}) VALUES (${assertionFieldNames.map(f=>':'+f).join(',')}) RETURNING assertion_id AS id`, assertion);
    return assertion;
}

function createAssertion(parent: Assertion|undefined, depth: number,
                         id: number, ty: string, fields: Partial<Assertion>) {
    return Object.assign({
        assertion_id: id,
        valid_from: timestamp.BEGIN_TIME,
        valid_to: timestamp.END_TIME,
        //parent_id: parent?.id,
        id: id,
        ty: ty,
        depth: depth,
        ty1: parent?.ty1,
        id1: parent?.id1,
        ty2: parent?.ty2,
        id2: parent?.id2,
        ty3: parent?.ty3,
        id3: parent?.id3,
        ty4: parent?.ty4,
        id4: parent?.id4,
        ty5: parent?.ty5,
        id5: parent?.id5,
        [`id${depth}`]: id,
        [`ty${depth}`]: ty,
    }, fields);
}

interface Entry {
    entry_id: number;
    spelling: Spelling[];
    subentry: Subentry[];
    internal_note: string;
    public_note: string;
}

function importEntry(entry: Entry) {
    const entryAssertion = insertAssertion(createAssertion(
        undefined, 1, entry.entry_id, 'en',
        {
            internal_note: entry.internal_note,
            public_note: entry.public_note,
        }));
    entry.spelling.forEach(s=>importSpelling(entryAssertion, s));
    entry.subentry.forEach(s=>importSubentry(entryAssertion, s));
}

interface Spelling {
    spelling_id: number;
    text: string;
    variant: string;
}

function importSpelling(parent: Assertion, spelling: Spelling) {
    insertAssertion(createAssertion(
        parent, 2, spelling.spelling_id, 'sp',
        {
            attr1: spelling.text,
            locale_expr: spelling.variant,
        }));
}

interface Subentry {
    subentry_id: number;
    part_of_speech: string;
    definition: Definition[];
    gloss: Gloss[];
    example: Example[];
    pronunciation_guide: PronunciationGuide[];
    category: Category[];
    related_entry: RelatedEntry[];
    alternate_grammatical_form: AlternateGrammaticalForm[];
    other_regional_form: OtherRegionalForm[];
    attr: Attr[];
    //status: Status[];
}

function importSubentry(parent: Assertion, subentry: Subentry) {
    const subentryAssertion = insertAssertion(createAssertion(
        parent, 2, subentry.subentry_id, 'se',
        {
            attr1: subentry.part_of_speech,
        }));
    subentry.definition.forEach(s=>importDefinition(subentryAssertion, s));
    subentry.gloss.forEach(s=>importGloss(subentryAssertion, s));
    subentry.example.forEach(s=>importExample(subentryAssertion, s));
    subentry.pronunciation_guide.forEach(s=>importPronunciationGuide(subentryAssertion, s));
    subentry.category.forEach(s=>importCategory(subentryAssertion, s));
    subentry.related_entry.forEach(s=>importRelatedEntry(subentryAssertion, s));
    subentry.alternate_grammatical_form.forEach(s=>importAlternateGrammaticalForm(subentryAssertion, s));
    subentry.other_regional_form.forEach(s=>importOtherRegionalForm(subentryAssertion, s));
    subentry.attr.forEach(s=>importAttr(subentryAssertion, s));
    // console.info('STATUS', subentry);
    // subentry.status.forEach(s=>importStatus(subentryAssertion, s));
}

interface Definition {
    definition_id: number;
    definition: string;
}

function importDefinition(parent: Assertion, definition: Definition) {
    insertAssertion(createAssertion(
        parent, 3, definition.definition_id, 'de',
        {
            attr1: definition.definition,
        }));
}

interface Gloss {
    gloss_id: number;
    gloss: string;
}

function importGloss(parent: Assertion, gloss: Gloss) {
    insertAssertion(createAssertion(
        parent, 3, gloss.gloss_id, 'gl',
        {
            attr1: gloss.gloss,
        }));
}

interface Example {
    example_id: number;
    translation: string;
    example_text: ExampleText[];
}

function importExample(parent: Assertion, example: Example) {
    const exampleAssertion = insertAssertion(createAssertion(
        parent, 3, example.example_id, 'ex',
        {
            attr1: example.translation,
        }));
    example.example_text.forEach(s=>importExampleText(exampleAssertion, s));
}

interface ExampleText {
    example_text_id: number;
    text: string;
    variant: string;
}

function importExampleText(parent: Assertion, exampleText: ExampleText) {
    insertAssertion(createAssertion(
        parent, 4, exampleText.example_text_id, 'et',
        {
            attr1: exampleText.text,
            locale_expr: exampleText.variant,
        }));
}

interface PronunciationGuide {
    pronunciation_guide_id: number;
    text: string;
    variant: string;
}

function importPronunciationGuide(parent: Assertion, pronunciationGuide: PronunciationGuide) {
    insertAssertion(createAssertion(
        parent, 3, pronunciationGuide.pronunciation_guide_id, 'pg',
        {
            attr1: pronunciationGuide.text,
            locale_expr: pronunciationGuide.variant,
        }));
}

interface Category {
    category_id: number;
    category: string;
}

function importCategory(parent: Assertion, category: Category) {
    insertAssertion(createAssertion(
        parent, 3, category.category_id, 'ct',
        {
            attr1: category.category,
        }));
}

interface RelatedEntry {
    related_entry_id: number;
    unresolved_text: string;
}

function importRelatedEntry(parent: Assertion, relatedEntry: RelatedEntry) {
    insertAssertion(createAssertion(
        parent, 3, relatedEntry.related_entry_id, 're',
        {
            attr1: relatedEntry.unresolved_text, // ??? ??? TODO WTF ??? XXX ???
        }));
}

interface AlternateGrammaticalForm {
    alternate_grammatical_form_id: number;
    gloss: string;
    grammatical_form: string;
    alternate_form_text: AlternateFormText[];
}

function importAlternateGrammaticalForm(parent: Assertion, alternateGrammaticalForm: AlternateGrammaticalForm) {
    const alternateGrammaticalFormAssertion = insertAssertion(createAssertion(
        parent, 3, alternateGrammaticalForm.alternate_grammatical_form_id, 'ag',
        {
            attr1: alternateGrammaticalForm.grammatical_form,
            attr2: alternateGrammaticalForm.gloss,
        }));
    alternateGrammaticalForm.alternate_form_text.forEach(s=>importAlternateFormText(alternateGrammaticalFormAssertion, s));
}

interface AlternateFormText {
    alternate_form_text_id: number;
    text: string;
    variant: string;
}

function importAlternateFormText(parent: Assertion, alternateFormText: AlternateFormText) {
    insertAssertion(createAssertion(
        parent, 4, alternateFormText.alternate_form_text_id, 'ax',
        {
            attr1: alternateFormText.text,
            locale_expr: alternateFormText.variant,
        }));
}

interface OtherRegionalForm {
    other_regional_form_id: number;
    text: string;
}

function importOtherRegionalForm(parent: Assertion, otherRegionalForm: OtherRegionalForm) {
    insertAssertion(createAssertion(
        parent, 3, otherRegionalForm.other_regional_form_id, 'rf',
        {
            attr1: otherRegionalForm.text,
        }));
}

interface Attr {
    attr_id: number;
    attr: string;
    value: string;
}

function importAttr(parent: Assertion, attr: Attr) {
    insertAssertion(createAssertion(
        parent, 3, attr.attr_id, 'at',
        {
            attr1: attr.attr,
            attr2: attr.value,
        }));
}

// interface Status {
//     status_id: number;
//     variant: string;
//     status: string;
//     details: string;
// }

// function importStatus(parent: Assertion, status: Status) {
//     insertAssertion(createAssertion(
//         parent, 3, status.status_id, 'st',
//         {
//             attr1: status.status,
//             attr2: status.details,
//             locale_expr: status.variant,
//         }));
// }

async function main(args: string[]) {
    const [command, ...commandArgs] = args;
    switch(command) {
        case 'ImportMMO': await importMMO(); break;
        default: throw new Error('bad usage');
    }
}

if (import.meta.main) {
    await main(Deno.args);
}
