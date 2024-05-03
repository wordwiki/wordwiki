/**
 * 'Raw' importer for the MMO legacy format.
 *
 * This imports directly into the DB format - we have a nicer path
 * via model.ts - this is scaffolding so we don't have to get that fully
 * working yet.
 */
import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import * as utils from "../utils/utils.ts";
import * as strings from "../utils/strings.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import {block} from "../utils/strings.ts";
import { ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt, Assertion, assertionFieldNames } from './schema.ts';
import * as config from "./config.ts";
import * as timestamp from "../utils/timestamp.ts";
import * as orderkey from '../utils/orderkey.ts';
import * as content from "../utils/content-store.ts";
import {DictTag, EntryTag, StatusTag, SpellingTag, SubentryTag, TodoTag,
        NoteTag, TranslationTag, DefinitionTag, GlossTag, ExampleTag,
        ExampleTextTag, ExampleTranslationTag, ExampleRecordingTag,
        PronunciationGuideTag, CategoryTag, RelatedEntryTag, AlternateGrammaticalFormTag,
        AlternateFormTextTag, OtherRegionalFormTag, PictureTag, AttrTag,
        DocumentReferenceTag, RefTranscriptionTag, RefExpandedTranscriptionTag,
        RefTransliterationTag, RefNoteTag, SupportingEvidenceTag, RecordingTag} from './entry-schema.ts';

// TODO: CLI, read the json in.
// TODO: recursively build structure


function dirTree(root: string, out: string[]): string[] {
    const entries = Deno.readDirSync(root);
    for(const e of entries) {
        if(e.isFile)
            out.push(root+'/'+e.name);
        else
            dirTree(root+'/'+e.name, out);
    }
    return out;
}

async function importMMO() {
    // XXX TODO move this file/path into our import tree.
    //const entries = JSON.parse(await Deno.readTextFile("/home/dziegler/wordwiki/importer/mikmaq/entry-tuples.json")) as Entry[];
    const entries = JSON.parse(await Deno.readTextFile("imports/LegacyMmo/entries.json")) as Entry[];
    console.info('entry count', entries.length);

    if(true) {

        const allWavFiles = dirTree('imports/LegacyMmo/media', [])
            .filter(f=>f.endsWith('.wav'))
            .filter(f=>Deno.statSync(f).size !== 44)
            .filter(f=>!f.includes('('))
            .map(f=>strings.stripRequiredPrefix(f, 'imports/LegacyMmo/'));
        console.info(allWavFiles);
        const unusedWavFiles = new Set(allWavFiles);
        
        // We need to load the recordings into our content store - which has
        // an async api - so we pre-do the loading here so the main transform
        // passes don't have to be async.
        const importedPaths = [];
        for(const e of entries) {
            const spelling = e.spelling[0]?.text;
            for(const r of e.recording) {
                if(!unusedWavFiles.delete(r.recording))
                    console.info(`missing ${r.recording} (1)`);
                r.recording = await importAudioContent('imports/LegacyMmo', r.recording, r.speaker, spelling) ?? '';
                if(r.recording !== '')
                    importedPaths.push(r.recording);
            }
            for(const s of e.subentry) {
                for(const e of s.example) {
                    for(const r of e.example_recording) {
                        if(!unusedWavFiles.delete(r.recording))
                            console.info(`missing ${r.recording}`);
                        r.recording = await importAudioContent('imports/LegacyMmo', r.recording, r.speaker, spelling) ?? ''
                        if(r.recording !== '')
                            importedPaths.push(r.recording);
                    }
                }
            }
        }

        console.info('Imported recording paths', importedPaths);
        const importedHashes = [];
        for(const p of importedPaths)
            importedHashes.push(await content.digestFileUsingExternalCmd(p));
        console.info('IMPORTED HASHES', importedHashes);
        const importedHashesSet = new Set(importedHashes);
        
        console.info('UNUSED wav files:');
        const recovered = new Set();
        const missing = [];
        for(const p of unusedWavFiles) {
            const hash = await content.digestFileUsingExternalCmd('imports/LegacyMmo/'+p);
            if(importedHashesSet.has(hash))
                recovered.add(p);
            else
                missing.push(p);
        }
        
        console.info('RECOVERED', recovered.size);
        console.info('UNBOUND FILES', missing.length);
        for(const f of missing.toSorted()) {
            console.info('***', f);
            const p = 'imports/LegacyMmo/'+f;
            if(!await fs.exists(p, {isFile: true}))
                throw new Error('expected '+p+' to exist');
        }
    }
    //return;
    
    //console.info(entries.map(e=>e.entry_id).toSorted());

    db().beginTransaction();
    db().execute('DELETE FROM dict', {});

    // Add the top level 'dct' assertion.
    const dictAssertion = createAssertion(undefined, 0, 0, DictTag, orderkey.new_range_start_string, true, {});
    console.info('dict assertion', JSON.stringify(dictAssertion, undefined, 2));
    insertAssertion(dictAssertion);
    
    //entries.forEach(e=>true ? importEntry(e) : undefined);

    importEach(entries, (s,k)=>importEntry(s, k));    
    
    db().endTransaction();
}

function importEach<T>(v: T[], f: (a:T, okey:string)=>void) {
    if(!Array.isArray(v)) throw new Error(`expected array of elems to import - got ${typeof v} - ${v}`);
    const order_keys = orderkey.initial(v.length);
    v.forEach((a,idx)=>f(a, order_keys[idx]));
}

function insertAssertion(assertion: Assertion): Assertion {
    //console.info('inserting assertion', assertion);
    db().execute<Assertion>(
        `INSERT INTO dict (${assertionFieldNames.join(',')}) VALUES (${assertionFieldNames.map(f=>':'+f).join(',')}) RETURNING assertion_id AS id`, assertion);
    return assertion;
}

function createAssertion(parent: Assertion|undefined, depth: number,
                         id: number, ty: string, order_key: string,
                         published: boolean,
                         fields: Partial<Assertion>) {
    const assertion = Object.assign({
        assertion_id: id,
        valid_from: timestamp.BEGINNING_OF_TIME,
        valid_to: timestamp.END_OF_TIME,
        //parent_id: parent?.id,
        id: id,
        ty: ty,
        //depth: depth,
        ty0: 'dct',
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
        //[`id${depth}`]: id,
        [`ty${depth}`]: ty,
        order_key,
        ...(published
            ? {
                published_from: timestamp.BEGINNING_OF_TIME,
                published_to: timestamp.END_OF_TIME,
            }
            : {})
    }, fields);

    if(depth === 0)
        utils.assert(id === 0, 'root assertion has fixed id 0');
    else
        (assertion as any)[`id${depth}`] = id;
    
    return assertion;
}

interface Entry {
    entry_id: number;
    published: boolean;
    status: Status[];
    spelling: Spelling[];
    recording: Recording[];
    subentry: Subentry[];
    internal_note: string;
    public_note: string;
}

function importEntry(entry: Entry, order_key: string) {
    if(typeof entry.published !== 'boolean')
        throw new Error('expected published to be boolean');
    const published: boolean = entry.published;
    const entryAssertion = insertAssertion(createAssertion(
        undefined, 1, entry.entry_id, EntryTag, order_key, published,
        {
            // TODO: audit this
            note: entry.internal_note + entry.public_note,
        }));
    importEach(entry.spelling, (s,k)=>importSpelling(entryAssertion, s, k, published));
    importEach(entry.recording.filter(r=>r.recording!==''), (s,k)=>importRecording(entryAssertion, s, k, published));
    importEach(entry.subentry, (s,k)=>importSubentry(entryAssertion, s, k, published));
    // console.info('STATUS', subentry);
    importEach(entry.status, (s,k)=>importStatus(entryAssertion, s, k, published));
    
}

interface Spelling {
    spelling_id: number;
    text: string;
    variant: string;
}

function importSpelling(parent: Assertion, spelling: Spelling, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 2, spelling.spelling_id, SpellingTag, order_key, published,
        {
            attr1: spelling.text,
            locale_expr: spelling.variant,
        }));
}

interface Recording {
    recording_id: number;
    recording: string;
    speaker: string;
}

function importRecording(parent: Assertion, recording: Recording, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 2, recording.recording_id, RecordingTag, order_key, published,
        {
            attr1: recording.recording,
            attr2: recording.speaker,
        }));
}

interface Subentry {
    subentry_id: number;
    part_of_speech: string;
    translation: Translation[];
    gloss: Gloss[];
    example: Example[];
    pronunciation_guide: PronunciationGuide[];
    category: Category[];
    related_entry: RelatedEntry[];
    alternate_grammatical_form: AlternateGrammaticalForm[];
    other_regional_form: OtherRegionalForm[];
    attr: Attr[];
    note: Note[],
    picture: Picture[],
}

function importSubentry(parent: Assertion, subentry: Subentry, order_key: string, published: boolean) {
    const subentryAssertion = insertAssertion(createAssertion(
        parent, 2, subentry.subentry_id, SubentryTag, order_key, published,
        {
            attr1: subentry.part_of_speech,
        }));
    importEach(subentry.translation, (s,k)=>importTranslation(subentryAssertion, s, k, published));
    importEach(subentry.gloss, (s,k)=>importGloss(subentryAssertion, s, k, published));
    importEach(subentry.example, (s,k)=>importExample(subentryAssertion, s, k, published));
    importEach(subentry.pronunciation_guide, (s,k)=>importPronunciationGuide(subentryAssertion, s, k, published));
    importEach(subentry.category, (s,k)=>importCategory(subentryAssertion, s, k, published));
    importEach(subentry.related_entry, (s,k)=>importRelatedEntry(subentryAssertion, s, k, published));
    importEach(subentry.alternate_grammatical_form, (s,k)=>importAlternateGrammaticalForm(subentryAssertion, s, k, published));
    importEach(subentry.other_regional_form, (s,k)=>importOtherRegionalForm(subentryAssertion, s, k, published));
    //importEach(subentry.picture, (s,k)=>importPicture(subentryAssertion, s, k, published));    
    importEach(subentry.attr, (s,k)=>importAttr(subentryAssertion, s, k, published));
}

interface Translation {
    translation_id: number;
    translation: string;
}

function importTranslation(parent: Assertion, translation: Translation, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, translation.translation_id, TranslationTag, order_key, published,
        {
            attr1: translation.translation,
        }));
}

interface Gloss {
    gloss_id: number;
    gloss: string;
}

function importGloss(parent: Assertion, gloss: Gloss, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, gloss.gloss_id, GlossTag, order_key, published,
        {
            attr1: gloss.gloss,
        }));
}

interface Example {
    example_id: number;
    example_text: ExampleText[];
    example_translation: ExampleTranslation[];
    example_recording: ExampleRecording[];
}

function importExample(parent: Assertion, example: Example, order_key: string, published: boolean) {
    const exampleAssertion = insertAssertion(createAssertion(
        parent, 3, example.example_id, ExampleTag, order_key, published,
        {
        }));
    importEach(example.example_text, (s,k)=>importExampleText(exampleAssertion, s, k, published));
    importEach(example.example_translation, (s,k)=>importExampleTranslation(exampleAssertion, s, k, published));
    importEach(example.example_recording.filter(r=>r.recording!==''), (s,k)=>importExampleRecording(exampleAssertion, s, k, published));
}

interface ExampleText {
    example_text_id: number;
    text: string;
    variant: string;
}

function importExampleText(parent: Assertion, exampleText: ExampleText, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 4, exampleText.example_text_id, ExampleTextTag, order_key, published,
        {
            attr1: exampleText.text,
            locale_expr: exampleText.variant,
        }));
}

interface ExampleTranslation {
    example_translation_id: number;
    text: string;
}

function importExampleTranslation(parent: Assertion, exampleTranslation: ExampleTranslation, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 4, exampleTranslation.example_translation_id, ExampleTranslationTag, order_key, published,
        {
            attr1: exampleTranslation.text,
        }));
}


interface ExampleRecording {
    example_recording_id: number;
    recording: string;
    speaker: string;
}

function importExampleRecording(parent: Assertion, exampleRecording: ExampleRecording, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 4, exampleRecording.example_recording_id, ExampleRecordingTag, order_key, published,
        {
            attr1: exampleRecording.recording,
            attr2: exampleRecording.speaker,
        }));
}

interface PronunciationGuide {
    pronunciation_guide_id: number;
    text: string;
    variant: string;
}

function importPronunciationGuide(parent: Assertion, pronunciationGuide: PronunciationGuide, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, pronunciationGuide.pronunciation_guide_id, PronunciationGuideTag, order_key, published,
        {
            attr1: pronunciationGuide.text,
            locale_expr: pronunciationGuide.variant,
        }));
}

interface Category {
    category_id: number;
    category: string;
}

function importCategory(parent: Assertion, category: Category, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, category.category_id, CategoryTag, order_key, published,
        {
            attr1: category.category,
        }));
}

interface RelatedEntry {
    related_entry_id: number;
    unresolved_text: string;
}

function importRelatedEntry(parent: Assertion, relatedEntry: RelatedEntry, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, relatedEntry.related_entry_id, RelatedEntryTag, order_key, published,
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

function importAlternateGrammaticalForm(parent: Assertion, alternateGrammaticalForm: AlternateGrammaticalForm, order_key: string, published: boolean) {
    const alternateGrammaticalFormAssertion = insertAssertion(createAssertion(
        parent, 3, alternateGrammaticalForm.alternate_grammatical_form_id, AlternateGrammaticalFormTag, order_key, published,
        {
            attr1: alternateGrammaticalForm.grammatical_form,
            attr2: alternateGrammaticalForm.gloss,
        }));
    importEach(alternateGrammaticalForm.alternate_form_text, (s,k)=>importAlternateFormText(alternateGrammaticalFormAssertion, s, k, published));
}

interface AlternateFormText {
    alternate_form_text_id: number;
    text: string;
    variant: string;
}

function importAlternateFormText(parent: Assertion, alternateFormText: AlternateFormText, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 4, alternateFormText.alternate_form_text_id, AlternateFormTextTag, order_key, published,
        {
            attr1: alternateFormText.text,
            locale_expr: alternateFormText.variant,
        }));
}

interface OtherRegionalForm {
    other_regional_form_id: number;
    text: string;
}

function importOtherRegionalForm(parent: Assertion, otherRegionalForm: OtherRegionalForm, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, otherRegionalForm.other_regional_form_id, OtherRegionalFormTag, order_key, published,
        {
            attr1: otherRegionalForm.text,
        }));
}

interface Attr {
    attr_id: number;
    attr: string;
    value: string;
}

function importAttr(parent: Assertion, attr: Attr, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, attr.attr_id, AttrTag, order_key, published,
        {
            attr1: attr.attr,
            attr2: attr.value,
        }));
}

interface Status {
    status_id: number;
    variant: string;
    status: string;
    details: string;
}

function importStatus(parent: Assertion, status: Status, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 2, status.status_id, StatusTag, order_key, published,
        {
            attr1: status.status,
            attr2: status.details,
            locale_expr: status.variant,
        }));
}

interface Note {
    note_id: number;
    note: string;
}

function importNote(parent: Assertion, note: Note, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, note.note_id, NoteTag, order_key, published,
        {
            attr1: note.note,
        }));
}

interface Picture {
    picture_id: number;
    picture: string;
}

function importPicture(parent: Assertion, picture: Picture, order_key: string, published: boolean) {
    insertAssertion(createAssertion(
        parent, 3, picture.picture_id, PictureTag, order_key, published,
        {
            attr1: picture.picture,
        }));
}


// CRAP CRAP - BUT rUN ONCE ONLY - SO PROBABLY OK
async function importAudioContent(root: string, relPath: string, speaker: string, altSpelling: string): Promise<string> {
    //console.info('*** Importing audio from ', path);
    let path = root+'/'+relPath;
    try {
        if(!await fs.exists(path, {isFile: true})) {
            let new_path =
                path.slice(0, 'imports/LegacyMmo/media/'.length)
                +altSpelling.toLowerCase().slice(0,1)+'/'
                +altSpelling.toLowerCase()
                +path.slice(path.lastIndexOf('/'));
            new_path = new_path.replaceAll('*', '');
            
            if(new_path !== path && await fs.exists(new_path, {isFile: true})) {
                //console.info('new path is', new_path);
                path = new_path;
            } else {
                // XXX this is a failure !!!XXX
                let msg = 'Missing '+path.slice('imports/LegacyMmo/media/'.length);
                if(new_path != path)
                    msg += ' or '+new_path.slice('imports/LegacyMmo/media/'.length);
                msg += ' for lexeme '+altSpelling;
                msg += ' by speaker '+speaker;
                console.info(msg);
                // console.info(path, await fs.exists(path, {isFile: true}));
                // if(new_path !== path)
                //     console.info(new_path, await fs.exists(new_path, {isFile: true}));
                return '';
            }
        }
    } catch(e) {
        console.info('XXX failed to import ', path, e);
    }

    try {
        const fileSize = await (await Deno.stat(path)).size;
        if(fileSize === 44)
            console.info('Empty recording ', path.slice('imports/LegacyMmo/media/'.length), 'for lexeme', altSpelling,
                         'by speaker', speaker);
    } catch(e) {
        console.info('failed to stat', path, e);
    }
    
    try {
        const audio_ref = 'content/'+
            await content.addFile('content/Recordings', path);
        return audio_ref;
    } catch(e) {
        console.info('XXX failed to import ', path, e);
        // RETURNING STOCK PATH IS WRONG HERE
        return '';
    }
}


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
