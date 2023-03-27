import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
import * as schema from '../../model/schema.ts';

export const entry_schema_json = {
    $type: 'relation',
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
        status: {
            $type: 'relation',
            status_id: {$type: 'primary_key'},
            variant: {$type: 'string'},
            status: {$type: 'string'},
            details: {$type: 'string'},
        },
    },
  internal_note: {$type: 'string'},
  public_note: {$type: 'string' },
}

// [[part_of_speech]]
//    $type: 'string'
// [[subentry]]
//    $type: 'relation'
//    [[spelling]]
//      $type: 'relation'
//      [[text]]
//        $type: 'string'
//      [[variant]]
//        $type: 'string'
//    [[definition]]
//      $type: 'relation'
//      [[definition]]
//        $type: 'string',
//      [[variant]]
//        $type: 'string',


async function main() {
    let entry_schema = schema.RelationField.parse_schema('entry', 'entry', entry_schema_json);
    console.info('Schema', entry_schema);
    let dumped_entry_schema_json = entry_schema.schema_to_json();
    console.info('Schema again', dumped_entry_schema_json);

    const create_schema_dml = entry_schema.create_db_tables();
    console.info('CREATE SCHEMA');
    create_schema_dml.forEach(s => console.info(s));
    
    const db = new DB('dict.db');
    create_schema_dml.forEach(dml => db.execute(dml));

    const entries =
        JSON.parse(await Deno.readTextFile("importer/mikmaq/entries.json"));

    entry_schema.validate('root', entries);

    //console.info('autocommit', db.autocommit);
    
    db.execute("BEGIN TRANSACTION;");
    entries.forEach((entry:any) => entry_schema.insert(db, entry));
    db.execute("COMMIT;");
}

if (import.meta.main)
    await main();
