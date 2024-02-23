import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import { db } from "./db.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {importScannedDocument} from "./import-scanned-document.ts";
import {stripRequiredPrefix, stripRequiredSuffix} from '../utils/strings.ts';

/**
 * Custom importer for the slightly idiosyncratic layout of the PDM manuscript project.
 * (weird page naming convention, some page numbers are skipped, divided into
 * volumes that we want to flatten into one document).
 */
async function importPDM() {
    const friendly_document_id = 'PDM'
    
    // --- Find the page files for the PDM manuscript project
    const pageFiles = [];
    for (const volume of ['P1', 'P2', 'P3', 'P4']) {
        for await (const volumeFile of await Deno.readDir(`imports/${friendly_document_id}/${volume}`)) {
            if(volumeFile.isFile && volumeFile.name.endsWith('.tif')) {
                pageFiles.push(`${volume}/${volumeFile.name}`);
            }
        }
    }
    pageFiles.sort();

    await importScannedDocument({
        friendly_document_id:'PDM',
        title: 'Pacifique Dictionary Manuscript',
    }, pageFiles);
}

/**
 * Custom importer for the Rand dictionary.
 */
async function importRAND() {
    const friendly_document_id = 'Rand'

    const pageFiles = (await Array.fromAsync(await Deno.readDir(`imports/${friendly_document_id}`))).
        filter(f=>f.isFile).
        map(f=>f.name).
        filter(f=>/^dictionaryoflang00rand_0_orig_[0-9][0-9][0-9][0-9][.]jp2$/.test(f)).
        toSorted();

    console.info('Rand page files', pageFiles);
    
    await importScannedDocument({
        friendly_document_id,
        title: 'Dictionary of the language of the Micmac Indians : who reside in Nova Scotia, New Brunswick, Prince Edward Island, Cape Breton and Newfoundland',
    }, pageFiles);
}

/**
 *
 */
async function importPacifiquesGeography() {
    importPDF('PacifiquesGeography',
              'pacifiques-geography-', '.png',
              "Pacifique's Geography");
}

/**
 * Custom importer for resources that have been converted from PDF to image
 * pages by imagemagik.
 */
async function importPDF(friendly_document_id: string,
                         pageNamePrefix: string,
                         pageExtension: string,
                         title: string) {

    const pageFiles = (await Array.fromAsync(await Deno.readDir(`imports/${friendly_document_id}`))).
        filter(f=>f.isFile).
        map(f=>f.name).
        filter(f=>f.startsWith(pageNamePrefix) && f.endsWith(pageExtension)).
        toSorted((a:string, b:string) =>
            parseInt(stripRequiredPrefix(stripRequiredSuffix(a, pageExtension), pageNamePrefix)) -
            parseInt(stripRequiredPrefix(stripRequiredSuffix(b, pageExtension), pageNamePrefix)));
    console.info('PDF page files', pageFiles);
    
    await importScannedDocument({
        friendly_document_id,
        title,
    }, pageFiles);
}

/**
 * Simple CLI to invoke the custom importers from the command line.
 */
async function main() {
    const [command, friendly_document_id] = Deno.args;
    if(command !== 'import' || !friendly_document_id)
        throw new Error('incorrect usage');
    db().beginTransaction();
    switch(friendly_document_id) {
        case 'PDM': await importPDM(); break;
        case 'RAND': await importRAND(); break;
        case 'PacifiquesGeography': await importPacifiquesGeography(); break;
        default:
            throw new Error(`unknown book "${friendly_document_id}"`);
    }
    db().endTransaction();
    db().close();
}

if (import.meta.main)
    await main();
