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

export const dictSchemaJson = {
    $type: 'schema',
    $name: 'dict',
    $tag: 'dct',
    entry: {
        $type: 'relation',
        $tag: 'ent',
        $prompt: 'Entry',
        entry_id: {$type: 'primary_key'},
        spelling: {
            $type: 'relation',
            $tag: 'spl',
            $style: { $prompt: 'SPELLING!' },
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'}
        },
        subentry: {
            $type: 'relation',
            $tag: 'sub',
            subentry_id: {$type: 'primary_key'},
            part_of_speech: {$type: 'string', $bind: 'attr1'},
            // probably should have variant here TODO
            // translation TODO
            translation: {
                $type: 'relation',
                $tag: 'tra',
                translation_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'}
            },
            definition: {
                $type: 'relation',
                $tag: 'def',
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'}
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
            },
            gloss: {
                $type: 'relation',
                $tag: 'gls',
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'}
                //variant: {$type: 'string'} - COMPLICATED
                // the gloss is (for example) in english, but may want to have
                // a different gloss for SF than LI?  How to model?
            },
            example: {
                $type: 'relation',
                $tag: 'exa',
                example_id: {$type: 'primary_key'},
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
                    $tag: 'etx',
                    example_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'}
                },

                example_translation: {
                    $type: 'relation',
                    $tag: 'etr',
                    example_translation_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'}
                },
                
                // Recordings of example sentence need to be pulled out of the
                // varianted examples because often is just spelling difference, or
                // is good enough.

                // Variant needs support for saying things like 'mm/sf' - meaning usable
                // for smith francis, but not ideal.  Easy enough.
                example_recording: {
                    $type: 'relation',
                    $tag: 'erc',
                    example_recording_id: {$type: 'primary_key'},
                    recording: {$type: 'audio', $bind: 'attr1'},
                    speaker: {$type: 'string', $bind: 'attr2'},
                    variant: {$type: 'variant'}
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
                $tag: 'prn',
                pronunciation_guide_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
            },
            category: {
                $type: 'relation',
                $tag: 'cat',
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'attr1'},
            },
            related_entry: {
                $type: 'relation',
                $tag: 'rel',
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'attr1'},
            },

            // Probably same variant treatment here as we are doing for examples
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'alt',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'},
                grammatical_form: {$type: 'string', $bind: 'attr2'},
                alternate_form_text: {
                    $type: 'relation',
                    $tag: 'alx',
                    alternate_form_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'}
                },
            },
            other_regional_form: {
                $type: 'relation',
                $tag: 'orf',
                other_regional_form_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
            },
            attr: {
                $type: 'relation',
                $tag: 'att',
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'attr1'},
                value: {$type: 'string', $bind: 'attr2'},
                variant: {$type: 'variant'},
            },
            document_reference: {
                $type: 'relation',
                $tag: 'doc', // doc
                document_reference_id: {$type: 'primary_key'},
                layer_id: {$type: 'integer', $bind: 'attr1'},
                transcription: {
                    $type: 'relation',
                    $tag: 'dtr',
                    transcription_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: '$attr1'},
                },
                expanded_transcription: {
                    $type: 'relation',
                    $tag: 'dex',
                    expanded_transcription_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: '$attr1'},
                },
                text: {
                    $type: 'relation',
                    $tag: 'dtx',
                    text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: '$attr1'},
                    variant: {$type: 'variant'},
                },
                notes: {
                    $type: 'relation',
                    $tag: 'dnt',
                    notes_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: '$attr1'},
                },
            },
            supporting_evidence: {
                $type: 'relation',
                $tag: 'eve',
                supporting_evidence_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'}
            },
        },
        recording: {
            $type: 'relation',
            $tag: 'rec',
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            speaker: {$type: 'string', $bind: 'attr2'},
            variant: {$type: 'variant'}
        },
    },
};

// interface Dictionary extends TupleVersionT {
// }

export interface Entry {
    entry_id: number,
    spelling: Spelling[],
    subentry: Subentry[],
    recording: Recording[],
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
    pronunication_guide: PronunciationGuide[],
    category: Category[],
    related_entry: RelatedEntry[],
    alternate_grammatical_form: AlternateGrammaticalForm[],
    other_regional_form: OtherRegionalForm[],
    attr: Attr[],
    image_reference: DocumentReference[],
    supporting_evidence: SupportingEvidence[],
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
    text: string,
    variant: string,
}

export interface ExampleTranslation {
    example_translation_id: number,
    text: string,
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
    text: string,
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
    layer_id: number,
    transcription: string,
    expanded_transcription: string,
    translation: string,
    notes: string,
}

export interface SupportingEvidence {
    supporting_evidence_id: number,
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
    let dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    console.info('Schema', dictSchema);
    let dumpedEntrySchemaJson = dictSchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);
}

/**
 *
 * Switch to mm-li query for now.
 */
export function renderEntry(e: Entry): any {
    return [
        ['h1', {}, renderEntrySpellings(e, e.spelling)],
        // note
        renderSubentriesCompact(e, e.subentry),
    ];
}

export function renderEntrySpellings(e: Entry, spellings: Spelling[]): any {
    return spellings.map(s=>s.text).join('/')    
}


export function renderSubentriesCompact(e: Entry, subentries: Subentry[]): any {
    switch(subentries.length) {
        case 0:
            return ['p', {}, 'No entries'];
        case 1:
            return renderSubentry(e, subentries[0]);
        default:
            return renderSubentries(e, subentries);
    }
}

export function renderSubentries(e: Entry, s: Subentry[]): any {
    return [
        ['ol', {},
         s.map(s=>['li', {}, renderSubentry(e, s)])]];
}

export function renderSubentry(e: Entry, s: Subentry): any {
    return [
        s.translation.map(t=>renderTranslation(e, t)),
        s.definition.map(t=>[['div', {}, ['b', {}, 'Definition: '], t.definition]]),
        renderGlosses(e, s.gloss),
        s.example.map(x=>renderExample(e, x)),
    ];
}

export function renderTranslation(e: Entry, t: Translation): any {
    //const onclick = `imports.popupEntryEditor(${e.entry_id}, )`;
    const onclick = '';
    return [['div', {onclick}, ['b', {}, 'Translation: '], t.translation]];
}

export function renderGlosses(e: Entry, glosses: Gloss[]): any {
    if(glosses.length === 0) return [];
     return [
         ['div', {},
          ['b', {}, 'Meanings:'],
          ['ul', {},
           glosses.map(g=>['li', {}, g.gloss])]
         ]
     ];
}

export function renderExample(e: Entry, example: Example): any { 
    return [];
    //     ['b', {}, 'Example of word used in sentence'],
    //     ['ul', {},
    //      s.gloss.map(g=>['li', {}, g.gloss])]
    // ];
}


if (import.meta.main)
    //await bunny();
    await test();
