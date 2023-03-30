import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
import * as schema from '../../model/schema.ts';

export const entrySchemaJson = {
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
    let entrySchema = schema.RelationField.parseSchemaFromCompactJson('entry', 'entry', entrySchemaJson);
    console.info('Schema', entrySchema);
    let dumpedEntrySchemaJson = entrySchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);

    const createSchemaDml = entrySchema.createDbTables();
    console.info('CREATE SCHEMA');
    createSchemaDml.forEach(s => console.info(s));
    
    const db = new DB('dict.db');
    createSchemaDml.forEach(dml => db.execute(dml));

    const entries =
        JSON.parse(await Deno.readTextFile("importer/mikmaq/entries.json"));

    entrySchema.validate('root', entries);

    //console.info('autocommit', db.autocommit);

    console.time('insert entries');
    db.execute("BEGIN TRANSACTION;");
    entries.forEach((entry:any) => entrySchema.insert(db, entry));
    db.execute("COMMIT;");
    console.timeEnd('insert entries');
}

if (import.meta.main)
    await main();
