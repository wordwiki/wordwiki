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
    $tag: 'di',
    entry: {
        $type: 'relation',
        $tag: 'en',
        $prompt: 'Entry',
        entry_id: {$type: 'primary_key'},
        spelling: {
            $type: 'relation',
            $tag: 'sp',
            $style: { $prompt: 'SPELLING!' },
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'}
        },
        subentry: {
            $type: 'relation',
            $tag: 'se',
            subentry_id: {$type: 'primary_key'},
            part_of_speech: {$type: 'string', $bind: 'attr1'},
            // probably should have variant here TODO
            definition: {
                $type: 'relation',
                $tag: 'de',
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'attr1'},
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
                $tag: 'gl',
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'}
                //variant: {$type: 'string'} - COMPLICATED
                // the gloss is (for example) in english, but may want to have
                // a different gloss for SF than LI?  How to model?
            },
            example: {
                $type: 'relation',
                $tag: 'ex',
                example_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1'},
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
                    $tag: 'et',
                    example_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'}
                },

                // Recordings of example sentence need to be pulled out of the
                // varianted examples because often is just spelling difference, or
                // is good enough.

                // Variant needs support for saying things like 'mm/sf' - meaning usable
                // for smith francis, but not ideal.  Easy enough.
            },

            // recording: {
            //     $type: 'subrelation',
            //     speaker: {$type: 'string'},
            //     recording: {$type: 'string'},
            //     variant: {$type: 'string'}
            // },
            pronunciation_guide: {
                $type: 'relation',
                $tag: 'pg',
                pronunciation_guide_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
            },
            category: {
                $type: 'relation',
                $tag: 'ct',
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'attr1'},
            },
            related_entry: {
                $type: 'relation',
                $tag: 're',
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'attr1'},
            },

            // Probably same variant treatment here as we are doing for examples
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'ag',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'},
                grammatical_form: {$type: 'string', $bind: 'attr2'},
                alternate_form_text: {
                    $type: 'relation',
                    $tag: 'ax',
                    alternate_form_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'}
                },
            },
            other_regional_form: {
                $type: 'relation',
                $tag: 'rf',
                other_regional_form_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
            },
            attr: {
                $type: 'relation',
                $tag: 'at',
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'attr1'},
                value: {$type: 'string', $bind: 'attr2'},
            },
            image_reference: {
                $type: 'relation',
                $tag: 'ev',
                reference_id: {$type: 'primary_key'},
                bounding_box_id: {$type: 'integer', $bind: 'attr1'},
                transcription: {$type: 'string', $bind: '$attr2'},
                expandedTranscription: {$type: 'string', $bind: '$attr3'},
                translation: {$type: 'string', $bind: '$attr4'},
                notes: {$type: 'string', $bind: 'attr5'},
            },
            supporting_evidence: {
                $type: 'relation',
                $tag: 'ev',
                evidence_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'}
            },
        },
    }
};

function test() {
    let dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    console.info('Schema', dictSchema);
    let dumpedEntrySchemaJson = dictSchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);
}

if (import.meta.main)
    //await bunny();
    await test();
