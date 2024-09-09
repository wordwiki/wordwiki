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
import { renderStandaloneGroup, singleBoundingGroupEditorURL, singlePublicBoundingGroupEditorURL, imageRefDescription } from './render-page-editor.ts'; // REMOVE_FOR_WEB
import * as audio from './audio.ts';  // REMOVE_FOR_WEB
import * as random from '../utils/random.ts';

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
export const RefSourceAsEntryTag = 'rse';
export const RefNormalizedSourceAsEntryTag = 'rne';
export const RefForeignReferenceTag = 'rfr';
export const RefNoteTag = 'rnt';
export const RefPublicNoteTag = 'rnp';
export const SourceTag = 'src';
export const RecordingTag = 'rec';

// XXX HACK HACK
export const users: Record<string, string> = {
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
    'djz': 'David Ziegler',
    'mmo': 'MMO Team',
};

export const states: Record<string, string> = {
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

export const todos: Record<string, string> = {
    'Todo': 'Todo',
    'NeedsResearchGroupReview': 'Needs Research Group Review',
    'NeedsSpeakerGroupReview': 'Needs Speaker Group Review',
    'NeedsRecording': 'Needs Recording',
    'NeedsApproval': 'Needs Approval',
};

export const variants: Record<string, string> = {
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
        $style: { $shape: 'containerRelation' },
        spelling: {
            $type: 'relation',
            $tag: SpellingTag,
            //$style: { $prompt: 'SPELLING!' },
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
            $style: { $shape: 'compactInlineListRelation' },
        },

        status: {
            $type: 'relation',
            $tag: StatusTag,
            //$style: { $prompt: 'SPELLING!' },
            status_id: {$type: 'primary_key'},
            status: {$type: 'enum', $bind: 'attr1', $style: { $options: states} },
            details: {$type: 'string', $bind: 'attr2' },
            variant: {$type: 'variant'},
            $style: { $shape: 'compactInlineListRelation' },
        },

        todo: {
            $type: 'relation',
            $tag: TodoTag,
            todo_id: {$type: 'primary_key'},
            todo: {$type: 'enum', $bind: 'attr1',
                   $style: { $options: todos}},
            details: {$type: 'string', $bind: 'attr2', $style: { $width: 30 }},
            assigned_to: {$type: 'enum', $bind: 'attr3', $style: {$options: users}},
            done: {$type: 'boolean', $bind: 'attr4'},
            variant: {$type: 'variant'},
            $style: { $shape: 'compactInlineListRelation' },
        },

        note: {
            $type: 'relation',
            $tag: NoteTag,
            note_id: {$type: 'primary_key'},
            note: {$type: 'string', $bind: 'attr1', $style: { $width: 80 }},
            $style: { $shape: 'compactInlineListRelation' },
        },

        subentry: {
            $type: 'relation',
            $tag: SubentryTag,
            subentry_id: {$type: 'primary_key'},
            part_of_speech: {$type: 'string', $bind: 'attr1'},
            $style: { $shape: 'containerRelation' },
            // probably should have variant here TODO
            // translation TODO

            translation: {
                $type: 'relation',
                $tag: TranslationTag,
                translation_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'compactInlineListRelation' },
            },

            /*definition: {
                $type: 'relation',
                $tag: DefinitionTag,
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'compactInlineListRelation' },
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
                $style: { $shape: 'inlineListRelation' },
            },

            example: {
                $type: 'relation',
                $tag: ExampleTag,
                example_id: {$type: 'primary_key'},
                $style: { $shape: 'containerRelation' },

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
                    $style: { $shape: 'compactInlineListRelation' },
                },

                example_translation: {
                    $type: 'relation',
                    $tag: ExampleTranslationTag,
                    example_translation_id: {$type: 'primary_key'},
                    example_translation: {$type: 'string', $bind: 'attr1', $style: { $width: 70 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation' },
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
                    $style: { $shape: 'compactInlineListRelation' },
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
                $style: { $shape: 'compactInlineListRelation' },
            },

            category: {
                $type: 'relation',
                $tag: CategoryTag,
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'attr1'},
                $style: { $shape: 'compactInlineListRelation' },
            },

            related_entry: {
                $type: 'relation',
                $tag: RelatedEntryTag,
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'attr1'},
                $style: { $shape: 'inlineListRelation' },
            },

            // Probably same variant treatment here as we are doing for examples
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'alt',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'},
                grammatical_form: {$type: 'string', $bind: 'attr2'},
                $style: { $shape: 'containerRelation' },

                alternate_form_text: {
                    $type: 'relation',
                    $tag: AlternateFormTextTag,
                    alternate_form_text_id: {$type: 'primary_key'},
                    alternate_form_text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'inlineListRelation' },
                },
            },

            other_regional_form: {
                $type: 'relation',
                $tag: OtherRegionalFormTag,
                other_regional_form_id: {$type: 'primary_key'},
                other_regional_form_text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
                $style: { $shape: 'inlineListRelation' },
            },

            picture: {
                $type: 'relation',
                $tag: PictureTag,
                picture_id: {$type: 'primary_key'},
                picture: {$type: 'image', $bind: 'attr1'},
                title: {$type: 'string', $bind: 'attr2'},
                credit: {$type: 'string', $bind: 'attr3'},
                $style: { $shape: 'inlineListRelation' },
            },

            attr: {
                $type: 'relation',
                $tag: AttrTag,
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'attr1'},
                value: {$type: 'string', $bind: 'attr2', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'inlineListRelation' },
            },

            document_reference: {
                $type: 'relation',
                $tag: DocumentReferenceTag,
                document_reference_id: {$type: 'primary_key'},
                bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                    $style: { $shape: 'boundingGroup'}},
                $style: { $shape: 'containerRelation' },

                transcription: {
                    $type: 'relation',
                    $tag: RefTranscriptionTag,
                    transcription_id: {$type: 'primary_key'},
                    transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                expanded_transcription: {
                    $type: 'relation',
                    $tag: RefExpandedTranscriptionTag,
                    expanded_transcription_id: {$type: 'primary_key'},
                    expanded_transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                transliteration: {
                    $type: 'relation',
                    $tag: RefTransliterationTag,
                    transliteration_id: {$type: 'primary_key'},
                    transliteration: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                source_as_entry: {
                    $type: 'relation',
                    $tag: RefSourceAsEntryTag,
                    source_as_entry_id: {$type: 'primary_key'},
                    source_as_entry: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                normalized_source_as_entry: {
                    $type: 'relation',
                    $tag: RefNormalizedSourceAsEntryTag,
                    normalized_source_as_entry_id: {$type: 'primary_key'},
                    normalized_source_as_entry: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                foreign_reference: {
                    $type: 'relation',
                    $tag: RefForeignReferenceTag,
                    foreign_reference_id: {$type: 'primary_key'},
                    foreign_reference: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                note: {
                    $type: 'relation',
                    $tag: RefNoteTag,
                    note_id: {$type: 'primary_key'},
                    note: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'compactInlineListRelation' },
                },

                public_note: {
                    $type: 'relation',
                    $tag: RefPublicNoteTag,
                    public_note_id: {$type: 'primary_key'},
                    public_note: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    $style: { $shape: 'compactInlineListRelation' },
                },
                
                // note: {
                //     $type: 'relation',
                //     $tag: RefNoteTag,
                //     ref_note_id: {$type: 'primary_key'},
                //     note: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                //     $style: { $shape: 'compactInlineListRelation' },
                // },
            },

            source: {
                $type: 'relation',
                $tag: SourceTag,
                source_id: {$type: 'primary_key'},
                source: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'inlineListRelation' },
            },
        },

        recording: {
            $type: 'relation',
            $tag: RecordingTag,
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            speaker: {$type: 'enum', $bind: 'attr2', $style: {$options: users}},
            variant: {$type: 'variant'},
            $style: { $shape: 'inlineListRelation' },
        },
    },
};

// interface Dictionary extends TupleVersionT {
// }

export interface Entry {
    entry_id: number,
    spelling: Spelling[],
    status: Status[],
    todo: Todo[],
    subentry: Subentry[],
    recording: Recording[],
}

export interface Status {
    status_id: number,
    status: string,
    details: string,
    variant: string,
}

export interface Todo {
    todo_id: number,
    todo: string,
    details: string,
    assigned_to: string,
    done: number,
    variant: string,
}

export interface Spelling {
    spelling_id: number,
    text: string,
    variant: string,
}

export interface Subentry {
    subentry_id: number,
    part_of_speech: string,
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
    source_as_entry: RefSourceAsEntry[],
    normalized_source_as_entry: RefNormalizedSourceAsEntry[],
    foreign_reference: RefForeignReference[],
    note: RefNote[],
    public_note: RefPublicNote[],
}

export interface RefTranscription {
    transcription_id: number,
    transcription: string,
}

export interface RefExpandedTranscription {
    expanded_transcription_id: number,
    expanded_transcription: string,
}

export interface RefTransliteration {
    transliteration_id: number,
    transliteration: string,
}

export interface RefSourceAsEntry {
    source_as_entry_id: number,
    source_as_entry: string,
}

export interface RefNormalizedSourceAsEntry {
    normalized_source_as_entry_id: number,
    normalized_source_as_entry: string,
}

export interface RefForeignReference {
    foreign_reference_id: number,
    foreign_reference: string,
}

export interface RefNote {
    note_id: number,
    note: string,
}

export interface RefPublicNote {
    public_note_id: number,
    public_note: string,
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

export function isPublished(e: Entry): boolean {
    return e.status.some(s=>s.status === 'Completed' || s.status === 'CompletedAsPDMOnly');
}

/**
 *
 */
export function computeNormalizedSearchTerms(e: Entry): string[] {
    // XXX crap - fix, think harder etc.
    const spellings = e.spelling.map(s=>s.text).map(s=>s.replaceAll(/[^A-Za-z0-9_]/g, "_"));
    const glosses = e.subentry.flatMap(se=>se.gloss.flatMap(gl=>gl.gloss.split(' ').map(word=>word.replaceAll(/[^A-Za-z0-9_]/g, "_"))));
    const allTermsAsAString = (spellings.join(' ')+' '+glosses.join(' ')).toLowerCase();
    const allTerms = allTermsAsAString.split(' ');
    return allTerms;
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

/**
 *
 */
export function renderEntryTitle(e: Entry): string {
    // TODO handle dialects here.
    const spellings = e.spelling.map(s=>s.text);
    const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
    // TODO mikmaq online text here should come from config XXXX
    return `${spellings.join(', ')} :: ${glosses.join(' / ')} -- Mi'gmaq/Mi'kmaq Online`;
}

export function renderEntrySpellingsSummary(e: Entry): string {
    return e.spelling.map(s=>s.text).join('/');
}

/**
 * Pick one recording to feature in situations where there is only space
 * to render one recording link.
 * 
 * Choice is based on entry_id so that choice is stable.
 * 
 * Currently ignoring variant + should have other controls.  XXX TODO
 */
export function getStableFeaturedRecording(e: Entry): Recording|undefined {
    return e.recording.length === 0
        ? undefined
        : e.recording[e.entry_id % e.recording.length];
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

// later, will add dialect.
interface RenderCtx {
    rootPath: string;
    suppressReferenceImages?: boolean;
    renderInternalNotes?: boolean,
    noTargetOnRefImages?: boolean;
    docRefsFirst?: boolean;
}

/**
 *
 * Switch to mm-li query for now.
 */
export function renderEntry(ctx: RenderCtx, e: Entry): any {
    return [
        //contextMenuPlay(),
        ['h1', {class: 'entry-scope'}, renderEntrySpellings(ctx, e, e.spelling)],
        renderEntryRecordings(ctx, e, e.recording),
        renderSubentriesCompact(ctx, e, e.subentry),
    ];
}

export function renderEntrySpellings(ctx: RenderCtx, e: Entry, spellings: Spelling[]): string {
    return spellings.map(s=>s.text).join('/') || 'No Spellings';
}

export function renderEntryRecordings(ctx: RenderCtx, e: Entry, recordings: Recording[]): any {
    return recordings.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Recordings:'],
         ['ul', {},
          recordings.length === 0
             ? ['li', {}, 'No recordings']
             : recordings.map(r=>['li', {},
                                  audio.renderAudio(r.recording, `Recording by ${r.speaker}`, undefined, ctx.rootPath)])
         ] // ul
        ]
    ];
}

export function renderSubentriesCompact(ctx: RenderCtx, e: Entry, subentries: Subentry[]): any {
    switch(subentries.length) {
        case 0:
            return ['p', {class: 'entry-scope'}, 'No entries'];
        case 1:
            return renderSubentry(ctx, e, subentries[0]);
        default:
            return renderSubentries(ctx, e, subentries);
    }
}

export function renderSubentries(ctx: RenderCtx, e: Entry, s: Subentry[]): any {
    return [
        ['ul', {},
         s.map((s, idx)=>['li', {}, [
             ['h3', {}, `Subentry ${idx+1}`], renderSubentry(ctx, e, s)]])]];
}

export function renderSubentry(ctx: RenderCtx, e: Entry, s: Subentry): any {
    return [
        // renderSource(e, s, s.source),
        ctx.docRefsFirst ? renderDocumentReferences(ctx, e, s, s.document_reference) : undefined,
        renderPartOfSpeech(ctx, e, s, s.part_of_speech),
        renderPronunciationGuides(ctx, e, s, s.pronunciation_guide),
        renderTranslations(ctx, e, s, s.translation),
        //s.definition.map(t=>[['div', {}, ['b', {}, 'Definition: '], t.definition]]),
        renderGlosses(ctx, e, s, s.gloss),
        //s.example.map(x=>renderExample(e, x)),
        renderExamples(ctx, e, s, s.example),
        renderRelatedEntries(ctx, e, s, s.related_entry),
        renderBorrowedWords(ctx, e, s, s.attr),
        !ctx.docRefsFirst ? renderDocumentReferences(ctx, e, s, s.document_reference) : undefined,
    ];
}

export const partsOfSpeech: Record<string, string> = {
    "na": "noun animate",
    "ni": "noun inanimate",
    "vii": "verb inanimate intransitive",
    "vai": "verb animate intransitive",
    "vit": "verb inanimate transitive",
    "vat": "verb animate transitive",
    "PTCL": "particle",
    "PCTL": "particle",
    "adv": "adverb",
    "n": "noun",
    "pn": "pronoun",
    "pna": "pronoun animate",
    "pni": "pronoun inanimate",
    "unclassified": "unclassified part of speech",
};


export function renderPartOfSpeech(ctx: RenderCtx, e: Entry, s: Subentry, part_of_speech: string): any {
    return ['div', {},  ['b', {}, 'Part of Speech: '], partsOfSpeech[part_of_speech] ?? part_of_speech];
}

export function renderPronunciationGuides(ctx: RenderCtx, e: Entry, s: Subentry,
                                          pronunciationGuides: PronunciationGuide[]): any {
    if(!pronunciationGuides)
        throw new Error('missing pron guides');
    return [['div', {class: 'entry-scope'},
             pronunciationGuides.map(p=>renderPronunciationGuide(ctx, e, s, p))
            ]];
}

export function renderPronunciationGuide(ctx: RenderCtx, e: Entry, s: Subentry, p: PronunciationGuide): any {
    return [['div', {},  ['b', {}, 'Pronunciation Guide: '], p.pronunciation_guide]];
}

export function renderTranslations(ctx: RenderCtx, e: Entry, s: Subentry, translations: Translation[]): any {
    return [['div', {class: 'entry-scope'},
             translations.map(t=>renderTranslation(ctx, e, s, t))
            ]];
}

export function renderTranslation(ctx: RenderCtx, e: Entry, s: Subentry, t: Translation): any {
    return [['div', {},  ['b', {}, 'Translation: '], t.translation]];
}
// export function renderCompactList(e: Entry,
//                                   parentId: number,
//                                   parentRelationTag: string,

export function renderGlosses(ctx: RenderCtx, e: Entry, s: Subentry, glosses: Gloss[]): any {
    return glosses.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Meanings:'],
          ['ul', {},
           glosses.length === 0
              ? ['li', {}, 'No glosses']
              : glosses.map(g=>['li', {}, g.gloss])]
         ]
     ];
}

export function renderExamples(ctx: RenderCtx, e: Entry, s: Subentry, examples: Example[]): any {
    return examples.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Example of word used in a sentence:'],
         ['ul', {},
          examples.length === 0
             ? ['li', {}, 'No examples']
             : examples.map(example=>['li', {}, renderExample(ctx, e, example)])]
        ]
    ];
}

export function renderExample(ctx: RenderCtx, e: Entry, example: Example): any {
    return [
        example.example_text.map(t=>['div', {}, ['b', {}, 'Text: '], t.example_text]),
        example.example_translation.map(t=>['div', {}, ['b', {}, 'Translation: '], ['i', {}, t.example_translation]]),
        example.example_recording.map(r=>['div', {}, ['b', {}, 'Recording: '], audio.renderAudio(r.recording, `Recording by ${r.speaker} 🔉`, undefined, ctx.rootPath)])
    ];
}

export function renderRelatedEntries(ctx: RenderCtx, e: Entry, s: Subentry,
                                     relatedEntries: RelatedEntry[]): any {
    if(!relatedEntries)
        throw new Error('missing related entries');
    return [['div', {class: 'entry-scope'},
             relatedEntries.map(r=>renderRelatedEntry(ctx, e, s, r))
            ]];
}

export function renderRelatedEntry(ctx: RenderCtx, e: Entry, s: Subentry, r: RelatedEntry): any {
    return [['div', {},  ['b', {}, 'Related Entry: '], r.unresolved_text]];
}

export function renderBorrowedWords(ctx: RenderCtx, e: Entry, s: Subentry,
                                    attrs: Attr[]): any {
    if(!attrs)
        throw new Error('missing attrs');
    return [['div', {class: 'entry-scope'},
             attrs
             .filter(a=>a.attr === 'borrowed-word')
                 .map(r=>renderBorrowedWord(ctx, e, s, r))
            ]];
}

export function renderBorrowedWord(ctx: RenderCtx, e: Entry, s: Subentry, b: Attr): any {
    return [['div', {},  ['b', {}, 'Borrowed Word: '], b.value]];
}

export function renderDocumentReferences(ctx: RenderCtx, e: Entry, s: Subentry,
                                         documentReferences: DocumentReference[]): any {
    return documentReferences.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Document References:'],
         ['ul', {},
          documentReferences.length === 0
             ? ['li', {}, 'No references']
             : documentReferences.map(ref=>['li', {}, renderDocumentReference(ctx, e, ref)]),
         ]
        ]
    ];
}

export function renderDocumentReference(ctx: RenderCtx, e: Entry, ref: DocumentReference): any {
    // XXX BAD THIS BIT OF FACTORING IS A CRAP HACK TO GET OUT THE DOOR.
    // XXX THE LINE with REMOVE_FOR_WEB is removed by transpile.sh so
    //     we don't try to pull client-side only deps on the web.
    let standaloneGroupRender: any = [];
    if(!ctx.suppressReferenceImages)
        standaloneGroupRender = renderStandaloneGroup(ctx.rootPath, ref.bounding_group_id); // REMOVE_FOR_WEB
    const title = 'Title';
    let refUrl: string;
    try {
        refUrl = singlePublicBoundingGroupEditorURL(ctx.rootPath, ref.bounding_group_id, title); // REMOVE_FOR_WEB
    } catch(ex) {
        refUrl = '';
    }
    //refUrl = ''; // REMOVE REMOVE REMOVE

    let refDescription: string;
    try {
        refDescription = imageRefDescription(ref.bounding_group_id); // REMOVE_FOR_WEB
    } catch(ex) {
        refDescription = '';
    }

    const noBody =
        ref.transcription.length === 0 &&
        ref.expanded_transcription.length === 0 &&
        ref.transcription.length === 0 &&
        ref.note.length === 0;
    return [
        ['div', {},
         ctx.noTargetOnRefImages
            ? standaloneGroupRender
            : ['a', {href:refUrl /*, target:'_blank', rel:'opener'*/}, standaloneGroupRender]],

        ['div', {},
         ctx.noTargetOnRefImages
            ? refDescription
            : ['a', {href:refUrl /*, target:'_blank', rel:'opener'*/}, refDescription]],

        ['div', {},
         /*noBody ? ['b', {}, 'No Transcription']:*/ undefined,
        ],
        ['table', {},
         ['tbody', {},
          // TODO move this style stuff to the stylesheet
          ref.transcription.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Transcription:'], ['td', {}, t.transcription]]),
          ref.expanded_transcription.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Expanded:'], ['td', {}, t.expanded_transcription]]),
          ref.transliteration.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Transliteration:'], ['td', {}, t.transliteration]]),
          ref.source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Source as entry:'], ['td', {}, t.source_as_entry]]),          
          ref.normalized_source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Normalized source as entry:'], ['td', {}, t.normalized_source_as_entry]]),
          ref.foreign_reference.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Foreign reference:'], ['td', {}, t.foreign_reference]]),
          
          ctx.renderInternalNotes ? ref.note.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Note:'], ['td', {}, t.note]]) : [],
          ref.public_note.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Public Note:'], ['td', {}, t.public_note]]),
          //ref.transcription.map(t=>['div', {}, ['b', {}, 'Transcription: '], t.text]),
          //ref.expanded_transcription.map(t=>['div', {}, ['b', {}, 'Expanded Transcription: '], t.text]),
          //ref.text.map(t=>['div', {}, ['b', {}, 'Text: '], t.text]),
          //ref.note.map(t=>['div', {}, ['b', {}, 'Note: '], t.text]),
    ]]];
}


if (import.meta.main)
    //await bunny();
    await test();
