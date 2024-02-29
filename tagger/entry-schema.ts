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

export const entrySchemaJson = {
    $type: 'relation',
    $prompt: 'Entry',
    entry_id: {$type: 'primary_key'},
    spelling: {
        $type: 'relation',
        spelling_id: {$type: 'primary_key'},
        text: {$type: 'string'},
        variant: {$type: 'string'}
    },
    subentry: {
        $type: 'relation',
        subentry_id: {$type: 'primary_key'},
        part_of_speech: {$type: 'string'},
        definition: {
            $type: 'relation',
            definition_id: {$type: 'primary_key'},
            definition: {$type: 'string'},
            //variant: {$type: 'string'}
        },
        gloss: {
            $type: 'relation',
            gloss_id: {$type: 'primary_key'},
            gloss: {$type: 'string'}
        },
        example: {
            $type: 'relation',
            example_id: {$type: 'primary_key'},
            translation: {$type: 'string'},
            example_text: {
                $type: 'relation',
                example_text_id: {$type: 'primary_key'},
                text: {$type: 'string'},
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
            pronunciation_guide_id: {$type: 'primary_key'},
            text: {$type: 'string'},
            variant: {$type: 'string'},
        },
        category: {
            $type: 'relation',
            category_id: {$type: 'primary_key'},
            category: {$type: 'string'},
        },
        related_entry: {
            $type: 'relation',
            related_entry_id: {$type: 'primary_key'},
            unresolved_text: {$type: 'string'},
        },
        alternate_grammatical_form: {
            $type: 'relation',
            alternate_grammatical_form_id: {$type: 'primary_key'},
            gloss: {$type: 'string'},
            grammatical_form: {$type: 'string'},
            alternate_form_text: {
                $type: 'relation',
                alternate_form_text_id: {$type: 'primary_key'},
                text: {$type: 'string'},
                variant: {$type: 'string'}
            },
        },
        other_regional_form: {
            $type: 'relation',
            other_regional_form_id: {$type: 'primary_key'},
            text: {$type: 'string'},
        },
        attr: {
            $type: 'relation',
            attr_id: {$type: 'primary_key'},
            attr: {$type: 'string'},
            value: {$type: 'string'},
        },
    },
  internal_note: {$type: 'string'},
  public_note: {$type: 'string' },
}

function test() {
    let entrySchema = model.RelationField.parseSchemaFromCompactJson('entry', 'entry', entrySchemaJson);
    entrySchema.resolve();
    entrySchema.validateSchema('entry');
    console.info('Schema', entrySchema);
    let dumpedEntrySchemaJson = entrySchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);
}

if (import.meta.main)
    //await bunny();
    await test();
