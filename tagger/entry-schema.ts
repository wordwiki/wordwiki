// deno-lint-ignore-file no-unused-vars, no-explicit-any

//import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
//import { DbSystem, Db, PreparedQuery } from "./db.ts";
//import {startRpcDbServer} from './rpc-db.ts';

//import * as denoSqliteDb from "./denoSqliteDb.ts";
import * as model from './model.ts';
//import * as persistence from './persistence.ts';
import * as utils from "../utils/utils.ts";
import * as timestamp from '../utils/timestamp.ts';
//import * as render from './render.tsx';
//import * as templates from './templates.ts';
import ContextMenu from '../utils/context-menu.js';
import { renderStandaloneGroup, singleBoundingGroupEditorURL } from './render-page-editor.ts'; // REMOVE_FOR_WEB
import * as audio from './audio.ts';  // REMOVE_FOR_WEB

export const DictTag = 'dct';          // dict
export const EntryTag = 'ent';         // entr
export const StatusTag = 'sta';        // stat
export const SpellingTag = 'spl'       // spel
export const SubentryTag = 'sub';      // sub
export const TodoTag = 'tdo';          // todo
export const NoteTag = 'nte';          // note
export const TranslationTag = 'tra';   // tran
export const DefinitionTag = 'def';    // def
export const GlossTag = 'gls';         // glos
export const ExampleTag = 'exa';       // exam
export const ExampleTextTag = 'etx';   // extx
export const ExampleTranslationTag = 'etr'; // extr
export const ExampleRecordingTag = 'erc';   // exrc
export const PronunciationGuideTag = 'prn'; // pron
export const CategoryTag = 'cat';           // cat
export const RelatedEntryTag = 'rel';       // rel
export const AlternateGrammaticalFormTag = 'alt';  // alt
export const AlternateFormTextTag = 'alx';  // altx
export const OtherRegionalFormTag = 'orf';  // orf
export const PictureTag = 'pic';            // pic
export const AttrTag = 'att';                // attr
export const DocumentReferenceTag = 'ref';   // ref
export const RefTranscriptionTag = 'rtr';    // rftr
export const RefExpandedTranscriptionTag = 'rex';  // rf
export const RefTransliterationTag = 'rtl';
export const RefNoteTag = 'rnt';
export const SourceTag = 'src';
export const RecordingTag = 'rec';

// XXX HACK HACK
export const users = {
    '___': 'No User Selected',
    'ecm': 'Emma Metallic',
    'ewm': 'Eunice Metallic',
    'dmm': 'Diane Mitchell',
    'gml': 'Gmarie Laroque',
    'jnw': 'Joe Wilmot',
    'kam': 'Karen Martin',
    'mmm': 'Maddie Metallic',
    'yli': 'Yasmine Isaac',
    'mch': 'Michel (Listuguj)',
    'mjp': 'Josephine (Wagmatcook)',
    'kjd': 'Kirsten (Eskasoni)',
    'djz': 'David Ziegler'
};

export const states = {
    'Unknown': 'Unknown Status',
    'Completed': 'Completed',
    'CompletedAsPDMOnly': 'Completed As PDM Only',
    'InProcess': 'In Process',
    'InProcessPDMOnly': 'In Process - For PDM Only',
    'OnHold': 'On Hold - To Be Processed',
    'Archived': 'Archived',
    'ArchivedIncomplete': 'Archived - Incomplete',
    'ArchivedNotAWord': 'Archived - Not A Word',
};

export const todos = {
    'Todo': 'Todo',
    'NeedsResearchGroupReview': 'Needs Research Group Review',
    'NeedsSpeakerGroupReview': 'Needs Speaker Group Review',
    'NeedsRecording': 'Needs Recording',
    'NeedsApproval': 'Needs Approval',
};

export const variants = {
    'mm-li': 'Listuguj',
    'mm-sf': 'Smith-Francis',
    'mm-mp': 'Modified Pacifique',
    'mm-pm': 'Pacifique Manuscript',
    'mm': "All Mig'maq-Mi'kmaq",
};

export const dictSchemaJson = {
    $type: 'schema',
    $name: 'dict',
    $tag: DictTag,
    entry: {
        $type: 'relation',
        $tag: EntryTag,
        $prompt: 'Entry',
        entry_id: {$type: 'primary_key'},
        $style: { $shape: 'container' },
        spelling: {
            $type: 'relation',
            $tag: SpellingTag,
            //$style: { $prompt: 'SPELLING!' },
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
            $style: { $shape: 'titledValue' },
        },
        status: {
            $type: 'relation',
            $tag: StatusTag,
            //$style: { $prompt: 'SPELLING!' },
            status_id: {$type: 'primary_key'},
            status: {$type: 'enum', $bind: 'attr1', $style: { $options: states} },
            details: {$type: 'string', $bind: 'attr2' },
            variant: {$type: 'variant'},
            $style: { $shape: 'titledValue' },
        },
        todo: {
            $type: 'relation',
            $tag: TodoTag,
            ref_note_id: {$type: 'primary_key'},
            todo: {$type: 'enum', $bind: 'attr1',
                   $style: { $options: todos}},
            details: {$type: 'string', $bind: 'attr2', $style: { $width: 30 }},
            assigned_to: {$type: 'enum', $bind: 'attr3', $style: {$options: users}},
            done: {$type: 'boolean', $bind: 'attr4'},
            variant: {$type: 'variant'},
            $style: { $shape: 'titledValue' },
        },
        note: {
            $type: 'relation',
            $tag: NoteTag,
            note_id: {$type: 'primary_key'},
            note: {$type: 'string', $bind: 'attr1', $style: { $width: 80 }},
            $style: { $shape: 'titledValue' },
        },
        subentry: {
            $type: 'relation',
            $tag: SubentryTag,
            subentry_id: {$type: 'primary_key'},
            part_of_speech: {$type: 'string', $bind: 'attr1'},
            $style: { $shape: 'container' },
            // probably should have variant here TODO
            // translation TODO
            translation: {
                $type: 'relation',
                $tag: TranslationTag,
                translation_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'titledValue' },
            },
            /*definition: {
                $type: 'relation',
                $tag: DefinitionTag,
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'titledValue' },
                //variant: {$type: 'string'}
                // same issue as for gloss variant!!!
                // - need two locales for definition - where it is applicable,
                //   and the language of the definition as well.
                // - this is a complication of wanting multiple target langugages
                //   maybe should drop for now (we will need a bit model redo
                //   at some point).
                // - expressive power needed:
                //    - for source languge facts, we can use locale to specify
                //      their applicability.
                //    - target language facts also have a locale (like most facts) BUT
                //      also have a target language and both have to match.
                //    - for most dictionaries, the target can be defaulted (for
                //      example to 'en', - so user does not need to be aware of this).
                // - this is a low confusion item (the hard part is appling to example)
            },*/
            gloss: {
                $type: 'relation',
                $tag: GlossTag,
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                //variant: {$type: 'string'} - COMPLICATED
                // the gloss is (for example) in english, but may want to have
                // a different gloss for SF than LI?  How to model?
                $style: { $shape: 'valueList' },
            },
            example: {
                $type: 'relation',
                $tag: ExampleTag,
                example_id: {$type: 'primary_key'},
                $style: { $shape: 'container' },

                //translation: {$type: 'string', $bind: 'attr1'},
                // Probably move translation into a sub relation (so can have variants)
                // Thiunk about pairings of tranlation and example.

                // Recordings of example sentences have tricky modelling WRT
                // variants as well (for example the simplest models don't allow
                // a recording to be shared by mutiple locales that have a different
                // orthography - which is not OK.

                // Have the same problem with using locale for the translation as we
                // do for gloss - the locale should probably be WRT the source
                // language of the dictionary.

                // Add target_loccale to the top level translatoin, and we are fine.
                // (having one be privledged is a win to prevent drift, and have
                // a more understandable model - can still to NxN pariings).
                example_text: {
                    $type: 'relation',
                    $tag: ExampleTextTag,
                    example_text_id: {$type: 'primary_key'},
                    example_text: {$type: 'string', $bind: 'attr1', $style: { $width: 70 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'titledValue' },
                },

                example_translation: {
                    $type: 'relation',
                    $tag: ExampleTranslationTag,
                    example_translation_id: {$type: 'primary_key'},
                    example_translation: {$type: 'string', $bind: 'attr1', $style: { $width: 70 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'titledValue' },
                },

                // Recordings of example sentence need to be pulled out of the
                // varianted examples because often is just spelling difference, or
                // is good enough.

                // Variant needs support for saying things like 'mm/sf' - meaning usable
                // for smith francis, but not ideal.  Easy enough.
                example_recording: {
                    $type: 'relation',
                    $tag: ExampleRecordingTag,
                    example_recording_id: {$type: 'primary_key'},
                    recording: {$type: 'audio', $bind: 'attr1'},
                    speaker: {$type: 'enum', $bind: 'attr2', $style: {$options: users}},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'titledValue' },
                },
            },

            // recording: {
            //     $type: 'subrelation',
            //     speaker: {$type: 'string'},
            //     recording: {$type: 'string'},
            //     variant: {$type: 'string'}
            // },
            pronunciation_guide: {
                $type: 'relation',
                $tag: PronunciationGuideTag,
                pronunciation_guide_id: {$type: 'primary_key'},
                pronunciation_guide: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
                $style: { $shape: 'titledValue' },
            },
            category: {
                $type: 'relation',
                $tag: CategoryTag,
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'attr1'},
                $style: { $shape: 'titledValue' },
            },
            related_entry: {
                $type: 'relation',
                $tag: RelatedEntryTag,
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'attr1'},
                $style: { $shape: 'valueList' },
            },

            // Probably same variant treatment here as we are doing for examples
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'alt',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'},
                grammatical_form: {$type: 'string', $bind: 'attr2'},
                $style: { $shape: 'container' },
                alternate_form_text: {
                    $type: 'relation',
                    $tag: AlternateFormTextTag,
                    alternate_form_text_id: {$type: 'primary_key'},
                    alternate_form_text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'valueList' },
                },
            },
            other_regional_form: {
                $type: 'relation',
                $tag: OtherRegionalFormTag,
                other_regional_form_id: {$type: 'primary_key'},
                other_regional_form_text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
                $style: { $shape: 'valueList' },
            },
            picture: {
                $type: 'relation',
                $tag: PictureTag,
                picture_id: {$type: 'primary_key'},
                picture: {$type: 'image', $bind: 'attr1'},
                title: {$type: 'string', $bind: 'attr2'},
                credit: {$type: 'string', $bind: 'attr3'},
                $style: { $shape: 'valueList' },
            },
            attr: {
                $type: 'relation',
                $tag: AttrTag,
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'attr1'},
                value: {$type: 'string', $bind: 'attr2', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'valueList' },
            },
            document_reference: {
                $type: 'relation',
                $tag: DocumentReferenceTag,
                document_reference_id: {$type: 'primary_key'},
                bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                    $style: { $shape: 'boundingGroup'}},
                $style: { $shape: 'container' },
                transcription: {
                    $type: 'relation',
                    $tag: RefTranscriptionTag,
                    ref_transcription_id: {$type: 'primary_key'},
                    transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'titledValue' },
                },
                expanded_transcription: {
                    $type: 'relation',
                    $tag: RefExpandedTranscriptionTag,
                    ref_expanded_transcription_id: {$type: 'primary_key'},
                    expanded_transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'titledValue' },
                },
                transliteration: {
                    $type: 'relation',
                    $tag: RefTransliterationTag,
                    ref_text_id: {$type: 'primary_key'},
                    transliteration: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'titledValue' },
                },
                note: {
                    $type: 'relation',
                    $tag: RefNoteTag,
                    ref_note_id: {$type: 'primary_key'},
                    note: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'titledValue' },
                },
            },
            source: {
                $type: 'relation',
                $tag: SourceTag,
                source_id: {$type: 'primary_key'},
                source: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'valueList' },
            },
        },
        recording: {
            $type: 'relation',
            $tag: RecordingTag,
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            speaker: {$type: 'enum', $bind: 'attr2', $style: {$options: users}},
            variant: {$type: 'variant'},
            $style: { $shape: 'valueList' },
        },
    },
};

// interface Dictionary extends TupleVersionT {
// }

export interface Entry {
    entry_id: number,
    spelling: Spelling[],
    status: Status[],
    subentry: Subentry[],
    recording: Recording[],
}

export interface Status {
    status_id: number,
    status: string,
    details: string,
    variant: string,
}

export interface Spelling {
    spelling_id: number,
    text: string,
    variant: string,
}

export interface Subentry {
    subentry_id: number,
    translation: Translation[],
    definition: Definition[],
    gloss: Gloss[],
    example: Example[],
    //recording: Recording[],
    pronunciation_guide: PronunciationGuide[],
    category: Category[],
    related_entry: RelatedEntry[],
    alternate_grammatical_form: AlternateGrammaticalForm[],
    other_regional_form: OtherRegionalForm[],
    attr: Attr[],
    document_reference: DocumentReference[],
    source: Source[],
}

export interface Translation {
    translation_id: number,
    translation: string,
}

export interface Definition {
    definition_id: number,
    definition: string,
}

export interface Gloss {
    gloss_id: number,
    gloss: string,
}

export interface Example {
    example_id: number,
    translation: string,
    example_text: ExampleText[],
    example_translation: ExampleTranslation[],
    example_recording: ExampleRecording[],
}

export interface ExampleText {
    example_text_id: number,
    example_text: string,
    variant: string,
}

export interface ExampleTranslation {
    example_translation_id: number,
    example_translation: string,
    variant: string,
}

export interface ExampleRecording {
    recording_id: number,
    speaker: string,
    recording: string,
    variant: string,
}

export interface PronunciationGuide {
    pronunciation_guide_id: number,
    pronunciation_guide: string,
    variant: string,
}

export interface Category {
    category_id: number,
    category: string,
}

export interface RelatedEntry {
    related_entry_id: number,
    unresolved_text: string,
}

export interface AlternateGrammaticalForm {
    alternate_grammatical_form_id: number,
    gloss: string,
    grammatical_form: string,
    alternate_form_text: AlternateFormText[],
}

export interface AlternateFormText {
    alternate_form_text_id: number,
    text: string,
    variant: string,
}

export interface OtherRegionalForm {
    other_regional_form_id: number,
    text: string,
}

export interface Attr {
    attr_id: number,
    attr: string,
    value: string,
}

export interface DocumentReference {
    document_reference_id: number,
    bounding_group_id: number,
    transcription: RefTranscription[],
    expanded_transcription: RefExpandedTranscription[],
    transliteration: RefTransliteration[],
    note: RefNote[],
}

export interface RefTranscription {
    ref_transcription_id: number,
    transcription: string,
}

export interface RefExpandedTranscription {
    ref_expanded_transcription_id: number,
    expanded_transcription: string,
}

export interface RefTransliteration {
    ref_text_id: number,
    transliteration: string,
}

export interface RefNote {
    ref_note_id: number,
    note: string,
}

export interface Source {
    source_id: number,
    text: string,
    variant: string,
}

export interface Recording {
    recording_id: number,
    speaker: string,
    recording: string,
    variant: string,
}

/**
 *
 */
export function renderEntryCompactSummary(e: Entry): any {
    // TODO handle dialects here.
    const spellings = e.spelling.map(s=>s.text);
    const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
    return ['div', {}, ['strong', {}, spellings.join(', ')], ' : ', glosses.join(' / ')];
}

function test() {
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    console.info('Schema', dictSchema);
    const dumpedEntrySchemaJson = dictSchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);
}

// TODO Generizise the entry rendering, then do the whole lexeme.
// TODO Figure out research section.


function contextMenuPlay(): any {
    const items = [
        { name: 'Cut', fn: function(target:Element) { console.log('Cut!', target); }},
        { name: 'Copy', fn: function(target:Element) { console.log('Copy!', target); }},
        { name: 'Paste', fn: function(target:Element) { console.log('Paste!', target); }},
        {},
        { name: 'Select All', fn: function(target:Element) { console.log('Select All!', target); }},
    ];

    const cm1 = new ContextMenu('.has-context-menu', items);

    return ['div', {class: 'has-context-menu'}, 'CTX ME!'];
}

/**
 *
 * Switch to mm-li query for now.
 */
export function renderEntry(e: Entry): any {
    const editSpellings = `imports.popupEntryEditor('Edit Spellings', ${e.entry_id}, 'ent', ${e.entry_id}, 'spl')`;
    const editEntry = `imports.popupEntryEditor('Edit Entry', ${e.entry_id}, 'ent', ${e.entry_id})`;
    return [
        //contextMenuPlay(),
        ['h1', {class: 'editable', onclick: editEntry}, renderEntrySpellings(e, e.spelling)],
        renderEntryRecordings(e, e.recording),
        renderSubentriesCompact(e, e.subentry),
    ];
}

export function renderEntrySpellings(e: Entry, spellings: Spelling[]): string {
    return spellings.map(s=>s.text).join('/') || 'No Spellings';
}

export function renderEntryRecordings(e: Entry, recordings: Recording[]): any {
    const edit = `imports.popupEntryEditor('Edit Recordings', ${e.entry_id}, 'ent', ${e.entry_id}, 'rec')`;
    return [
        ['div', {class: 'editable', onclick: edit},
         ['b', {}, 'Recordings:'],
         ['ul', {},
          recordings.length === 0
             ? ['li', {}, 'No recordings']
             : recordings.map(r=>['li', {},
                                  renderAudio(r.recording, `Recording by ${r.speaker}`)])
         ] // ul
        ]
    ];
}

export function renderSubentriesCompact(e: Entry, subentries: Subentry[]): any {
    const editSubentries = `imports.popupEntryEditor('Edit Subentries', ${e.entry_id}, 'ent', ${e.entry_id}, 'sub')`;
    switch(subentries.length) {
        case 0:
            return ['p', {class: 'editable', onclick: editSubentries}, 'No entries'];
        case 1:
            return renderSubentry(e, subentries[0]);
        default:
            return renderSubentries(e, subentries);
    }
}

export function renderSubentries(e: Entry, s: Subentry[]): any {
    return [
        ['ul', {},
         s.map((s, idx)=>['li', {}, [
             ['h3', {}, `Subentry ${idx+1}`], renderSubentry(e, s)]])]];
}

export function renderSubentry(e: Entry, s: Subentry): any {
    console.info('SUBENTRY', JSON.stringify(s, undefined, 2))
    console.info('PRON', JSON.stringify(s.pronunciation_guide, undefined, 2));
    //                                    pronunciation_guide

    console.info('cat', Object.entries(s));
    return [
        // renderSource(e, s, s.source),
        renderPronunciationGuides(e, s, s.pronunciation_guide),
        renderTranslations(e, s, s.translation),
        //s.definition.map(t=>[['div', {}, ['b', {}, 'Definition: '], t.definition]]),
        renderGlosses(e, s, s.gloss),
        //s.example.map(x=>renderExample(e, x)),
        renderExamples(e, s, s.example),
        renderDocumentReferences(e, s, s.document_reference),
    ];
}

export function renderPronunciationGuides(e: Entry, s: Subentry,
                                          pronunciationGuides: PronunciationGuide[]): any {
    if(!pronunciationGuides)
        throw new Error('missing pron guides');
    const onclick = `imports.popupEntryEditor('Edit Pronunciations', ${e.entry_id}, 'sub', ${s.subentry_id}, 'prn')`;
    return [['div', {class: 'editable', onclick},
             pronunciationGuides.map(p=>renderPronunciationGuide(e, s, p))
            ]];
}

export function renderPronunciationGuide(e: Entry, s: Subentry, p: PronunciationGuide): any {
    return [['div', {},  ['b', {}, 'Pronunciation Guide: '], p.pronunciation_guide]];
}

export function renderTranslations(e: Entry, s: Subentry, translations: Translation[]): any {
    const onclick = `imports.popupEntryEditor('Edit Translations', ${e.entry_id}, 'sub', ${s.subentry_id}, 'tra')`;
    return [['div', {class: 'editable', onclick},
             translations.map(t=>renderTranslation(e, s, t))
            ]];
}

export function renderTranslation(e: Entry, s: Subentry, t: Translation): any {
    return [['div', {},  ['b', {}, 'Translation: '], t.translation]];
}
// export function renderCompactList(e: Entry,
//                                   parentId: number,
//                                   parentRelationTag: string,






export function renderGlosses(e: Entry, s: Subentry, glosses: Gloss[]): any {
    const edit = `imports.popupEntryEditor('Edit Glosses', ${e.entry_id}, 'sub', ${s.subentry_id}, 'gls')`;
    return [
        ['div', {class: 'editable', onclick: edit},
         ['b', {}, 'Meanings:'],
          ['ul', {},
           glosses.length === 0
              ? ['li', {}, 'No glosses']
              : glosses.map(g=>['li', {}, g.gloss])]
         ]
     ];
}

export function renderExamples(e: Entry, s: Subentry, examples: Example[]): any {
    console.info('IN RENDER EXAMPLES', examples);
    const edit = `imports.popupEntryEditor('Edit Examples', ${e.entry_id}, 'sub', ${s.subentry_id}, 'exa')`;
    return [
        ['div', {class: 'editable', onclick: edit},
         ['b', {}, 'Example of word used in a sentence:'],
         ['ul', {},
          examples.length === 0
             ? ['li', {}, 'No examples']
             : examples.map(example=>['li', {}, renderExample(e, example)])]
        ]
    ];
}

export function renderExample(e: Entry, example: Example): any {
    return [
        example.example_text.map(t=>['div', {}, ['b', {}, 'Text: '], t.example_text]),
        example.example_translation.map(t=>['div', {}, ['b', {}, 'Translation: '], ['i', {}, t.example_translation]]),
        example.example_recording.map(r=>['div', {}, ['b', {}, 'Recording: '], renderAudio(r.recording, `Recording by ${r.speaker}`)])
    ];
}

export function renderAudio(recording: string, label: string): any {
    return (async ()=>{
        try {
            let audioUrl = '';
            audioUrl = await audio.getCompressedRecordingPath(recording);  // REMOVE_FOR_WEB
            return ['a',
                    {onclick: `event.preventDefault(); event.stopPropagation(); playAudio('${audioUrl}');`, href: audioUrl},
                    label]
        } catch(ex) {
            // DO better here TODO
            return ['b', {}, 'Failed to load recording: ', ex];
        }
    })();
}

export function renderDocumentReferences(e: Entry, s: Subentry,
                                         documentReferences: DocumentReference[]): any {
    const edit = `imports.popupEntryEditor('Edit Document References', ${e.entry_id}, 'sub', ${s.subentry_id}, 'ref')`;
    return [
        ['div', {class: 'editable', onclick: edit},
         ['b', {}, 'Document References:'],
         ['ul', {},
          documentReferences.length === 0
             ? ['li', {}, 'No references']
             : documentReferences.map(ref=>['li', {}, renderDocumentReference(e, ref)]),
          ['li', {},
           ['PDM', 'Rand', 'Clark', 'RandFirstReadingBook'].map(b=>
               ['button', {onclick:`event.stopPropagation(); imports.launchAddNewDocumentReference(${e.entry_id}, ${s.subentry_id}, ${JSON.stringify(b)}, ${JSON.stringify("Editing reference for "+renderEntrySpellings(e, e.spelling))})`}, 'Add ', b])
          ]
         ]
        ]
    ];
}

export function renderDocumentReference(e: Entry, ref: DocumentReference): any {
    // XXX BAD THIS BIT OF FACTORING IS A CRAP HACK TO GET OUT THE DOOR.
    // XXX THE LINE with REMOVE_FOR_WEB is removed by transpile.sh so
    //     we don't try to pull client-side only deps on the web.
    let standaloneGroupRender: any = [];
    standaloneGroupRender = renderStandaloneGroup(ref.bounding_group_id); // REMOVE_FOR_WEB
    const title = 'Title';
    let refUrl: string;
    try {
        refUrl = singleBoundingGroupEditorURL(ref.bounding_group_id, title); // REMOVE_FOR_WEB
    } catch(ex) {
        refUrl = '';
    }
    const noBody =
        ref.transcription.length === 0 &&
        ref.expanded_transcription.length === 0 &&
        ref.transcription.length === 0 &&
        ref.note.length === 0;
    return [
        ['a', {href:refUrl, target:'_blank', rel:'opener'}, standaloneGroupRender],
        ['div', {},
         noBody ? ['b', {}, 'No Transcription']: undefined,
        ],
        ['table', {},
         ['tbody', {},
          ref.transcription.map(t=>['tr', {}, ['th', {}, 'Transcription:'], ['td', {}, t.transcription]]),
          ref.expanded_transcription.map(t=>['tr', {}, ['th', {}, 'Expanded:'], ['td', {}, t.expanded_transcription]]),
          ref.transliteration.map(t=>['tr', {}, ['th', {}, 'Transliteration:'], ['td', {}, t.transliteration]]),
          ref.note.map(t=>['tr', {}, ['th', {}, 'Note:'], ['td', {}, t.note]]),
          //ref.transcription.map(t=>['div', {}, ['b', {}, 'Transcription: '], t.text]),
          //ref.expanded_transcription.map(t=>['div', {}, ['b', {}, 'Expanded Transcription: '], t.text]),
          //ref.text.map(t=>['div', {}, ['b', {}, 'Text: '], t.text]),
          //ref.note.map(t=>['div', {}, ['b', {}, 'Note: '], t.text]),
    ]]];
}


if (import.meta.main)
    //await bunny();
    await test();
