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
            text: {$type: 'string', $bind: 'srctxt'},
            variant: {$type: 'string'}
        },
        subentry: {
            $type: 'relation',
            $tag: 'se',
            subentry_id: {$type: 'primary_key'},
            part_of_speech: {$type: 'string', $bind: 'label'},
            definition: {
                $type: 'relation',
                $tag: 'de',
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'targettxt'},
                //variant: {$type: 'string'}
            },
            gloss: {
                $type: 'relation',
                $tag: 'gl',
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'targettxt'}
            },
            example: {
                $type: 'relation',
                $tag: 'ex',
                example_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'targettxt'},
                example_text: {
                    $type: 'relation',
                    $tag: 'et',
                    example_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'targettxt'},
                    variant: {$type: 'string'}
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
                $tag: 'pg',
                pronunciation_guide_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'txt'},
                variant: {$type: 'string'},
            },
            category: {
                $type: 'relation',
                $tag: 'ct',
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'label'},
            },
            related_entry: {
                $type: 'relation',
                $tag: 're',
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'txt'},
            },
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'ag',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'targettxt'},
                grammatical_form: {$type: 'string', $bind: 'label'},
                alternate_form_text: {
                    $type: 'relation',
                    $tag: 'ax',
                    alternate_form_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'srctxt'},
                    variant: {$type: 'string'}
                },
            },
            other_regional_form: {
                $type: 'relation',
                $tag: 'rf',
                other_regional_form_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'srctxt'},
            },
            attr: {
                $type: 'relation',
                $tag: 'at',
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'label'},
                value: {$type: 'string', $bind: 'value'},
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
