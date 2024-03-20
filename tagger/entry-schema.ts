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
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'string'}
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
            },
            gloss: {
                $type: 'relation',
                $tag: 'gl',
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'}
            },
            example: {
                $type: 'relation',
                $tag: 'ex',
                example_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1'},
                example_text: {
                    $type: 'relation',
                    $tag: 'et',
                    example_text_id: {$type: 'primary_key'},
                    text: {$type: 'string', $bind: 'attr1'},
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
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'string'},
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
                    variant: {$type: 'string'}
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
