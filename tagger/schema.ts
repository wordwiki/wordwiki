import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {block} from "../utils/strings.ts";
import * as orderkey from '../utils/orderkey.ts';
import * as timestamp from '../utils/timestamp.ts';

export const routes = ()=> ({
});

// --------------------------------------------------------------------------------
// --- User -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface User {
    user_id: number;

    name: string;
    username: string;
    email?: string;

    /**
     * We disable users rather than deleting them because the
     * dictionary change history is joined to users, so deleting the
     * user would destroy the change history.  Depending on policy and
     * situation, one may choose to change the user, username and
     * email to some anon string on semantic 'delete'.
     */
    disabled?: boolnum;
    
    password_salt: string;
    password_hash: string;
}

export type UserOpt = Partial<User>;
export const userFieldNames:Array<keyof User> = [
    'user_id', 'name', 'username', 'email', 'disabled',
    'password_salt', 'password_hash'];

const createUserDml = block`
/**/   CREATE TABLE IF NOT EXISTS user(
/**/       user_id INTEGER PRIMARY KEY ASC,
/**/       name TEXT NOT NULL,
/**/       username TEXT NOT NULL,
/**/       email TEXT NOT NULL,
/**/       disabled NUMBER,
/**/       password_salt TEXT,
/**/       password_hash TEXT);
/**/   
/**/   CREATE UNIQUE INDEX IF NOT EXISTS user_by_username ON user(username);
/**/   CREATE UNIQUE INDEX IF NOT EXISTS user_by_email ON user(email);
/**/   `

assertDmlContainsAllFields(createUserDml, userFieldNames);


// --------------------------------------------------------------------------------
// --- Scanned Document -----------------------------------------------------------
// --------------------------------------------------------------------------------

export interface ScannedDocument {
    document_id: number;

    /**
     * Document id's spill out into URLs and into user-visible directory names
     * on the file system (for associated resources).
     *
     * To make this more pleasant, document also have a 'friendly_document_id'
     * that is pleasant for humans.
     *
     * To allow this id to be used in URLs and filenames without escaping,
     * we restrict this id to: '[a-zA-Z][a-zA-Z0-9_]*'
     *
     * Manual fixups will be required if this is changed once data is entered
     * into the system (for example renaming content directories).
     */
    friendly_document_id: string;

    /**
     * Document title.
     */
    title?: string;

    /**
     * URL for the source document if this document is imported from
     * an external source.  This (and all the the other source_ fields
     * are used to give credit to the source).  (In addition to this
     * being good form - this is a requirement from one of our sources).
     */
    source_url?: string;
    source_title?: string;
    source_credit?: string;
    source_notes?: string;

    /**
     * Root url for resolving relative source_url's in pages.
     */
    source_page_root_url?: string;
}
export type ScannedDocumentOpt = Partial<ScannedDocument>;
export const scannedDocumentFieldNames:Array<keyof ScannedDocument> = [
    'document_id', 'friendly_document_id', 'title',
    'source_url', 'source_title', 'source_credit', 'source_notes',
    'source_page_root_url'];

const createDocumentDml = block`
/**/   CREATE TABLE IF NOT EXISTS scanned_document(
/**/       document_id INTEGER PRIMARY KEY ASC,
/**/       friendly_document_id TEXT NOT NULL,
/**/       title TEXT NOT NULL,
/**/       source_url TEXT,
/**/       source_title TEXT,
/**/       source_credit TEXT,
/**/       source_notes TEXT,
/**/       source_page_root_url TEXT);
/**/   CREATE UNIQUE INDEX IF NOT EXISTS scanned_document_by_friendly_id ON scanned_document(friendly_document_id);
/**/   `

assertDmlContainsAllFields(createDocumentDml, scannedDocumentFieldNames);

export const selectScannedDocument = ()=>db().prepare<ScannedDocument, {document_id: number}>(block`
/**/   SELECT ${scannedDocumentFieldNames.join()}
/**/          FROM scanned_document
/**/          WHERE document_id = :document_id`);

export const selectScannedDocumentByFriendlyId = ()=>db().prepare<ScannedDocument, {friendly_document_id: string}>(block`
/**/   SELECT ${scannedDocumentFieldNames.join()}
/**/          FROM scanned_document
/**/          WHERE friendly_document_id = :friendly_document_id`);

// --------------------------------------------------------------------------------
// --- Scanned Page ---------------------------------------------------------------
// --------------------------------------------------------------------------------

/**
 * A scanned document is a sequence of numbered scanned pages.
 */
export interface ScannedPage {
    page_id: number;

    /**
     * Pages exist within a document.
     */
    document_id: number;

    /**
     * 1-based page number within the containing document.
     */
    page_number: number;

    /**
     * This is a URL to the scanned page on the source site (if it exists).
     * If this is a relative URL it will be resolved relative to the
     * scanned_document source_page_root_url.
     *
     * Giving a back link to the imported page is a request of one of our
     * partners.
     */
    source_url?: string;

    /**
     * To import a book, we first mirror the entire book in a local directory.
     * The import path is the (relative) path within our 'import' dir for
     * the source image.
     */
    import_path?: string;

    /**
     * The path to imported (and potentially resized etc) image in our content store.
     * For documents that are directly entered into the system (ie. not imported from
     * an external source), this may be the primary copy.  For imported content this
     * will be derived from the import source by the import batch job.
     *
     * The image file referred to by this image_ref is considered to be the
     * primary copy of this image in the system.
     *
     * Derived copies may exist (for example thumbnails) but these are
     * handled by the content store derivation system and do not need to be
     * stored.
     *
     * Note that because this a reference into a content store, and content
     * store references are based on the sha256 of the image content - if the
     * image content changes, so will this field value.
     */
    image_ref: string;

    /**
     * Width of (the primary copy) of this page in pixels.
     */
    width: number;

    /**
     * Height of this page in pixels.
     */
    height: number;

    /**
     * A short description of the page.  Intended to make it easier to find the
     * page you want in a long document without viewing the scan of every page.
     *
     * There is a second more sophisticated mechanism implemented with bounding
     * groups in a special layer that can implement a full table of contents, even
     * in the presence of multiple columns.
     */
    description?: string;
};
export type ScannedPageOpt = Partial<ScannedPage>;
export const scannedPageFieldNames: Array<keyof ScannedPage> = [
    'page_id', 'document_id', 'page_number',
    'source_url', 'import_path', 'image_ref', 
    'width', 'height',
    'description'];

const createPageDml = block`
/**/   CREATE TABLE IF NOT EXISTS scanned_page(
/**/       page_id INTEGER PRIMARY KEY ASC,
/**/       document_id INTEGER NOT NULL,
/**/       page_number INTEGER NOT NULL,
/**/       source_url TEXT,
/**/       import_path TEXT,
/**/       image_ref TEXT,
/**/       width INTEGER,
/**/       height INTEGER,
/**/       description TEXT,
/**/       FOREIGN KEY(document_id) REFERENCES scanned_document(document_id));
/**/
/**/   CREATE UNIQUE INDEX IF NOT EXISTS page_by_document_page_number ON scanned_page(document_id, page_number);
/**/   `;
assertDmlContainsAllFields(createPageDml, scannedPageFieldNames);

export const selectScannedPage = ()=>db().prepare<ScannedPage, {page_id: number}>(block`
/**/   SELECT ${scannedPageFieldNames.join()}
/**/          FROM scanned_page
/**/          WHERE page_id = :page_id`);

export const selectScannedPageByPageNumber = ()=>db().prepare<ScannedPage, {document_id: number, page_number: number}>(block`
/**/   SELECT ${scannedPageFieldNames.join()}
/**/          FROM scanned_page
/**/          WHERE document_id = :document_id AND page_number = :page_number`);

export const selectScannedPagesForDocument = ()=>db().prepare<ScannedPage, {document_id: number}>(block`
/**/   SELECT ${scannedPageFieldNames.join()}
/**/          FROM scanned_page
/**/          WHERE document_id = :document_id
/**/          ORDER BY page_number`);

export const maxPageNumberForDocument = ()=>db().prepare<{max_page_number: number}, {document_id: number}>(block`
/**/   SELECT MAX(page_number) as max_page_number
/**/          FROM scanned_page
/**/          WHERE document_id = :document_id`);

// --------------------------------------------------------------------------------
// --- Layer ----------------------------------------------------------------------
// --------------------------------------------------------------------------------

/**
 * A document may have many layers of image tagging.  All bounding
 * boxes exist within a single layer, but a user may import (copy)
 * boxes from 'reference_layers' as part of their editing process.
 * (reference layers are things like OCR generated bounding boxes that
 * may be useful in constructing multiple layers).
 *
 * Example layers:
 * - textract-line (OCR layer)
 * - textract-word (OCR layer)
 * - google cloud vision-word (OCR layer)
 * - table of contents layer (used to make a table of contents to jump around doc)
 * - main dictionary tagging layer (all the dictionary content partitioned into groups)
 * - secondary resource tagging layer for the word 'cat' - this layer would tag
 *     uses of the word cat in a secondary resource.
 * - secondary resource tagging layer for the word 'dog' - this layer would tag
 *     uses of the word cat in a secondary resource.  Note that this is a separate
 *     layer than the 'dog' tagging layer - so the 'cat' tags will not show up
 *     when editing this layer.
 *
 * A layer can also be thought of as a allocation plane - sometimes when tagging
 * we want to be aware of all the other tags in the same document (for example
 * when we want to fully partition a document) - other times seeing the other
 * tagging is just noise (for example, the above cat/dog secondary reference
 * tagging).
 *
 * Another purpose of separating OCR stuff into layers is that we can tag informed
 * by multiple OCR layers (if we want to re-import from an OCR source, we will have
 * to make new layers - reference layers should mostly be immutable)
 *
 * The UI will somehow have to deal with not showing both the (visible) reference layer
 * and the copied version + trickier cases where we import a box, then edit is slightly,
 * or re-import the base layer.
 *
 * When a bounding-box is copied from a reference layer, the new bounding box
 * will have the 'imported_from_bounding_box_id' field set to track this lineage.
 */
export interface Layer {
    layer_id: number;
    document_id: number;

    /**
     * An optional human-friendly layer name.
     */
    layer_name?: string;

    /**
     * A reference layer is presented to the user as an optional overlay layer
     * when working on another layer.  Items from the reference layer can
     * be imported (copied) into the work layer.
     *
     * The intent is that bounding boxes from OCR tools are placed into reference
     * layers (for example textract-line, textract-word) and then used in the
     * construction of other layers.
     */
    is_reference_layer: boolnum;
}
export type LayerOpt = Partial<Layer>;
export const layerFieldNames: Array<keyof Layer> = [
    'layer_id', 'document_id', 'layer_name', 'is_reference_layer'];

const createLayerDml = block`
/**/   CREATE TABLE IF NOT EXISTS layer(
/**/       layer_id INTEGER PRIMARY KEY ASC,
/**/       document_id INTEGER NOT NULL,
/**/       layer_name TEXT,
/**/       is_reference_layer INTEGER NOT NULL,
/**/       FOREIGN KEY(document_id) REFERENCES scanned_document(document_id));
/**/
/**/   CREATE INDEX IF NOT EXISTS layer_by_document_id ON layer(document_id);
/**/   CREATE UNIQUE INDEX IF NOT EXISTS layer_by_layer_name ON layer(document_id, layer_name);
/**/   `;
assertDmlContainsAllFields(createLayerDml, layerFieldNames);

export const selectLayer = ()=>db().prepare<Layer, {layer_id: number}>(block`
/**/   SELECT ${layerFieldNames.join()}
/**/          FROM layer
/**/          WHERE layer_id = :layer_id`);

export const selectLayerByLayerName = ()=>db().prepare<Layer, {document_id: number, layer_name: string}>(block`
/**/   SELECT ${layerFieldNames.join()}
/**/          FROM layer
/**/          WHERE document_id = :document_id AND layer_name = :layer_name`);

/**
 * Find a named reference layer, creating it if it does not yet exist.
 */
export function getOrCreateNamedLayer(document_id: number, layer_name: string, is_reference_layer: boolnum): number {
    const alreadyExistingLayer = selectLayerByLayerName().first({document_id, layer_name});
    if(alreadyExistingLayer) {
        if(alreadyExistingLayer.is_reference_layer !== is_reference_layer)
            throw new Error(`Expected is_reference_layer to be ${is_reference_layer} for layer ${layer_name} in document ${document_id}`);
        else
            return alreadyExistingLayer.layer_id;
    } else {
        return db().insert<Layer, 'layer_id'>(
            'layer', {document_id, layer_name, is_reference_layer}, 'layer_id');
    }
}

export function deleteLayer(layer_id: number) {
    db().execute<{layer_id: number}>
        ('DELETE FROM TABLE bounding_box WHERE layer_id = :layer_id',
         {layer_id});

    db().execute<{layer_id: number}>
        ('DELETE FROM TABLE bounding_group WHERE layer_id = :layer_id',
         {layer_id});

    db().execute<{layer_id: number}>
        ('DELETE FROM TABLE layer WHERE layer_id = :layer_id',
         {layer_id});
}

// --------------------------------------------------------------------------------
// --- Bounding Group -------------------------------------------------------------
// --------------------------------------------------------------------------------

/**
 *
 * Note that a bounding group is not constrained to a single page.
 */
export interface BoundingGroup {
    bounding_group_id: number;
    document_id: number;

    /**
     * A bounding group exists within a layer.
     */
    layer_id: number;

    /**
     *
     */
    color?: string;
    
    /**
     * The order of a bounding group within a document is based on the order of
     * (page_number_of_first_box, column_number, x_of_first_box, y_of_first_box).
     *
     * Inserting column number in the order allows correct flow order in
     * multi-column documents (like some of the dictionaries we are importing).
     */
    column_number?: number;

    /**
     * If the heading_level and heading are specified then this bounding box
     * is tagging a heading.  Combined with the bounding_box order (above)
     * this will define a (multi-column) table of contents for a scanned document
     * (usually defined in a special layer).
     *
     * For the dictionary project this will can be used to label the document with
     * start pairs of letters.
     */
    heading_level?: number;
    heading?: string;

    /**
     * Optional string separated tags (searched using fts)
     */
    tags?: string;

    /**
     * Transcription of the text in this bounding group.
     */
    transcription?: string;

    /**
     * Optional version of the transcription with abbreviations expanded, elided
     * words added etc.
     */
    expandedTranscription?: string;

    /**
     * Optional translated version of the textual contents of this bounding box.
     * Translation main include transliteration (changing orthographies).
     */
    translation?: string;

    // - how to model research.
    // - how to model approvals + decisions like whether to record - related to
    //   modelling of approvals.
    // - how to model dictionary entry.
    //   - for cut0, can just be a research fact that is a in SFM format (wtih
    //     validtaion using our Java lib)
    //   - later, we will write the dictionary part as well and will have proper
    //     modelling.
    // - a single versioned table?

    /**
     * Optional content and notes for the bounding group.
     */
    notes?: string;
}
export type BoundingGroupOpt = Partial<BoundingGroup>;
export const boundingGroupFieldNames: Array<keyof BoundingGroup> = [
    'bounding_group_id', 'document_id',
    'layer_id', 'color', 'column_number',
    'heading_level', 'heading', 'tags',
    'transcription', 'expandedTranscription', 'translation',
    'notes'];

const createBoundingGroupDml = block`
/**/   CREATE TABLE IF NOT EXISTS bounding_group(
/**/       bounding_group_id INTEGER PRIMARY KEY ASC,
/**/       document_id INTEGER NOT NULL,
/**/       layer_id INTEGER NOT NULL,
/**/       color TEXT,
/**/       column_number INTEGER,
/**/       heading_level INTEGER,
/**/       heading INTEGER,
/**/       tags TEXT,
/**/       transcription TEXT,
/**/       expandedTranscription TEXT,
/**/       translation TEXT,
/**/       notes TEXT,
/**/       FOREIGN KEY(document_id) REFERENCES scanned_document(document_id),
/**/       FOREIGN KEY(layer_id) REFERENCES layer(layer_id));
/**/   `;
assertDmlContainsAllFields(createBoundingGroupDml, boundingGroupFieldNames);

export const selectBoundingGroup = ()=>db().prepare<BoundingGroup, {bounding_group_id: number}>(block`
/**/   SELECT ${boundingGroupFieldNames.join()}
/**/          FROM bounding_group
/**/          WHERE bounding_group_id = :bounding_group_id`);


// --------------------------------------------------------------------------------
// --- Bounding Box ---------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface BoundingBox {
    bounding_box_id: number;

    /**
     * When a bounding box is copied from a reference layer we track that
     * lineage here.  Note that the boxes may subsequently diverge (for example,
     * because the user has edited the dimensions).
     */
    imported_from_bounding_box_id?: number;
    
    /**
     * Bounding always exist within a group.
     */
    bounding_group_id: number;

    /**
     * Document_id and layer_ids are denormalized out of the group
     * to speed some queries (they are immutable in the group anyway, so
     * no update issues, and we have such a tiny update rate and total data
     * size that having some extra indexes does not matter).
     */
    document_id: number;
    layer_id: number;
    
    /**
     * Bounding boxes are entirely in one page (though a group may
     * have boxes from muliple pages).
     */
    page_id: number;

    /**
     * Bounding box coordinates within the page.
     */
    x: number;
    y: number;
    w: number;
    h: number;

    /**
     * The color of this bounding box.
     *
     * I am really divided on this one - looking at the data the users prepared
     * by hand before this software was written, they use color tagging extensively.
     *
     * I believe that all the tagging should be semantic - and there is no place
     * for this 'color' field - but on the other hand, I also know the users will
     * really like it.  On the third hand this will immediately become one of those
     * ugly escape hatches that dog every data model, and cause endless problems later.
     */
    color?: string;

    /**
     * Placeholder for semantic modelling we haven't figured out yet.
     * (for example, when tagging an entry, they want to tag some of the bits
     * as 'references' - should this be part of the tagging of the entry - or a
     * whole separate group ???)
     */
    tags?: string;

    /**
     * Optional transliteration of the content of this bounding box.
     * It is expected that the primary transliteration will occur at the
     * bounding group level.
     *
     * Note for OCR layers (like TextractLine) this will contain the OCR
     * generate text.  This OCR generated text should not usually be copied
     * through when a bounding box is imported from a reference layer to a
     * user layer.
     *
     * Indexes are maintained so that this text can be searched using full
     * text search.
     */
    text?: string;

    /**
     * Optional notes about the content of this bounding box.
     */
    notes?: string;
}
export type BoundingBoxOpt = Partial<BoundingBox>;
export const boundingBoxFieldNames: Array<keyof BoundingBox> = [
    'bounding_box_id', 'imported_from_bounding_box_id', 'bounding_group_id',
    'document_id', 'layer_id', 
    'page_id', 'x', 'y', 'w', 'h', 'color', 'tags', 'text', 'notes'];

export interface Shape {
    x: number;
    y: number;
    w: number;
    h: number;
}

const createBoundingBoxDml = block`
/**/   CREATE TABLE IF NOT EXISTS bounding_box(
/**/       bounding_box_id INTEGER PRIMARY KEY ASC,
/**/       imported_from_bounding_box_id INTEGER,
/**/       bounding_group_id INTEGER,
/**/       document_id INTEGER NOT NULL,
/**/       layer_id INTEGER NOT NULL,
/**/       page_id INTEGER NOT NULL,
/**/       x INTEGER NOT NULL,
/**/       y INTEGER NOT NULL,
/**/       w INTEGER NOT NULL,
/**/       h INTEGER NOT NULL,
/**/       color TEXT,
/**/       tags TEXT,
/**/       text TEXT,
/**/       notes TEXT,
/**/       FOREIGN KEY(document_id) REFERENCES scanned_document(document_id),
/**/       FOREIGN KEY(page_id) REFERENCES scanned_page(page_id),
/**/       FOREIGN KEY(bounding_group_id) REFERENCES bounding_group(bounding_group_id));
/**/
/**/   CREATE UNIQUE INDEX IF NOT EXISTS bounding_box_by_page ON bounding_box(page_id, bounding_box_id);
/**/   CREATE UNIQUE INDEX IF NOT EXISTS bounding_box_by_group ON bounding_box(bounding_group_id, bounding_box_id);
/**/
/**/   -- Magical incantations to build full text index on the text field
/**/   -- see section 4.4.3 of https://www.sqlite.org/fts5.html
/**/   -- TODO: move this text generation to a function once we have tested this example.
/**/   -- TODO: as a peer to this function, make an index rebuilder.
/**/   -- TODO: probably also want a second one with using the trigram tokenizer
/**/   --       (because of prefixes in mikmaq)
/**/   CREATE VIRTUAL TABLE IF NOT EXISTS bounding_box_fts USING FTS5(
/**/       bounding_box_id, text, layer_id, content='bounding_box', content_rowid='bounding_box_id');
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_insert AFTER INSERT ON bounding_box BEGIN
/**/        INSERT INTO bounding_box_fts(rowid, text, layer_id) VALUES (new.bounding_box_id, new.text, new.layer_id);
/**/   END;
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_delete AFTER DELETE ON bounding_box BEGIN
/**/       INSERT INTO bounding_box_fts(bounding_box_fts, rowid, text, layer_id) VALUES('delete', old.bounding_box_id, old.text, old.layer_id);
/**/   END;
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_update AFTER UPDATE ON bounding_box BEGIN
/**/       INSERT INTO bounding_box_fts(bounding_box_fts, rowid, text, layer_id) VALUES('delete', old.bounding_box_id, old.text, old.layer_id);
/**/       INSERT INTO bounding_box_fts(rowid, text, layer_id) VALUES (new.bounding_box_id, new.text, new.layer_id);
/**/  END;
/**/   `;
assertDmlContainsAllFields(createBoundingBoxDml, boundingBoxFieldNames);

export const selectBoundingBox = ()=>db().prepare<BoundingBox, {bounding_box_id: number}>(block`
/**/   SELECT ${boundingBoxFieldNames.join()}
/**/          FROM bounding_box
/**/          WHERE bounding_box_id = :bounding_box_id`);

export function updateBoundingBox<T extends Partial<BoundingBox>>(bounding_box_id: number,fieldNames:Array<keyof T>, fields: T) {
    return db().update<T>('bounding_box', 'bounding_box_id', fieldNames, bounding_box_id, fields);
}

export const selectBoundingBoxesForGroup = ()=>db().prepare<BoundingBox, {bounding_group_id: number}>(block`
/**/   SELECT ${boundingBoxFieldNames.join()}
/**/          FROM bounding_box
/**/          WHERE bounding_group_id = :bounding_group_id`);

// --------------------------------------------------------------------------------
// --- ChangeLog ------------------------------------------------------------------
// --------------------------------------------------------------------------------

/**
 * 
 */
interface ChangeLog {
    change_log_id: number;
    user_id: number;

    bounding_group_id?: number;

    change_time: number;
    change_description: string;
    change_json: string;
}
export type ChangeLogOpt = Partial<ChangeLog>;
export const changeLogFieldNames: Array<keyof ChangeLog> = [
    'change_log_id', 'user_id',
    'bounding_group_id',
    'change_time', 'change_description', 'change_json'];

const createChangeLogDml = block`
/**/   CREATE TABLE IF NOT EXISTS change_log(
/**/       change_log_id INTEGER PRIMARY KEY ASC,
/**/       user_id INTEGER,
/**/       bounding_group_id INTEGER,
/**/       change_time INTEGER,
/**/       change_description TEXT,
/**/       change_json TEXT,
/**/       FOREIGN KEY(user_id) REFERENCES user(user_id),
/**/       FOREIGN KEY(bounding_group_id) REFERENCES bounding_group(bounding_group_id));
/**/   `;
assertDmlContainsAllFields(createChangeLogDml, changeLogFieldNames);

// --------------------------------------------------------------------------------
// --- Assertion ------------------------------------------------------------------
// --------------------------------------------------------------------------------

// TODO: there needs to be multiple tables with this schema (we will load them
//       as SQLite attached databases.   - this will be a much nicer model
//       of working with multiple dictionaries than merging them into one
//       table.

// TODO: make assertion_id allocation scheme that clusters assertion_ids for
//       all assertions in a tree (made less important by the fact that most
//       of our DBs are small enough that they will end up entirely in RAM -
//       but still good to do)

/**
 *
 */
export interface Assertion {
    assertion_id: number;

    /**
     * The timestamp at which this assertion was made.
     *
     * May choose to switch to 0 as beginning of time for less special
     * casing.
     */
    valid_from: number;

    /**
     * The timestamp at which this assertion was retracted (an edit if
     * a subsequent assertion with the same 'id' is made, or a delete if not)
     */
    valid_to: number;

    /**
     * The timestamp at which this assertion was published.
     *
     * TODO Think about null here (we have removed from valid_from modelling).
     */
    published_from?: number;

    /**
     * The timestamp at which the publish of this assertion was retracted
     * (either because it was deleted, or it was replaced with a newer publish)
     */
    published_to?: number;
    
    /**
     * Parent fact id (not assertion id).
     */
    //parent_id?: number,

    /**
     * Fact id
     */
    id: number;

    /**
     * Fact type
     */
    ty: string;
    
    /**
     * (Denormalized) Flattening of the ancestor and self ids and types.
     */
    ty0?: string;
    ty1?: string;
    id1?: number;
    ty2?: string;
    id2?: number;
    ty3?: string;
    id3?: number;
    ty4?: string;
    id4?: number;
    ty5?: string;
    id5?: number;

    /**
     * Fields for the assertion.  Interpreted as per ty.
     */
    attr1?: any;
    attr2?: any;
    attr3?: any;
    attr4?: any;
    attr5?: any;
    attr6?: any;
    attr7?: any;
    attr8?: any;
    attr9?: any;
    attr10?: any;
    attr11?: any;
    attr12?: any;
    attr13?: any;
    attr14?: any;
    attr15?: any;

    /**
     * User tags.
     */
    tags?: string;
    
    /**
     * Key used to order this assertion within its peers (same parent_id and ty).
     *
     * (see utils/order_key for more details)
     */
    order_key?: string;

    /**
     * Locale expression for which this assertion hosts.
     */
    locale_expr?: string;

    /**
     * Expression of the level of confidence we have that this assertion is true.
     */
    confidence_expr?: string;
    
    /**
     * Notes on this assertion
     */
    note?: string;
    
    /**
     * Our present level of confidence (0-10) in this fact.
     *
     * This is critical because when gathering dictionary information, we
     * may collect an assertion 'I think "cat" had a secondary meaning ...',
     * or we may be collecting information from the public, without vetting.
     */
    //confidence?: number;
    //confidence_note?: string;
    
    /**
     * More thought here about approval, priorities, discussion etc.
     */
    change_by_username?: string;
    change_action?: string;
    change_arg?: string;
    change_note?: string;
}

export type AssertionPath = [string, number][];

/**
 *
 */
export function getAssertionPath(a: Assertion): AssertionPath {
    const path: [string, number][] = [];
    if(a.ty0==null) throw new Error(`Invalid assertion, missing ty0`);
    path.push([a.ty0, 0]);
    if(a.ty1==null || a.id1==null) return path;
    path.push([a.ty1, a.id1]);
    if(a.ty2==null || a.id2==null) return path;
    path.push([a.ty2, a.id2]);
    if(a.ty3==null || a.id3==null) return path;
    path.push([a.ty3, a.id3]);
    if(a.ty4==null || a.id4==null) return path;
    path.push([a.ty4, a.id4]);
    if(a.ty5==null || a.id5==null) return path;
    path.push([a.ty5, a.id5]);
    return path;
}

export function assertionPathToFields(p: AssertionPath): Pick<Assertion, 'ty0'|'ty1'|'id1'|'ty2'|'id2'|'ty3'|'id3'|'ty4'|'id4'|'ty5'|'id5'> {
    const a: ReturnType<typeof assertionPathToFields> = {};
    const l = p.length;
    if(l >= 1) {
        a.ty0 = p[0][0];
        utils.assert(p[0][1] === 0);
    }
    if(l >= 2) {
        a.ty1 = p[1][0];
        a.id1 = p[1][1];
    }
    if(l >= 3) {
        a.ty2 = p[2][0];
        a.id2 = p[2][1];
    }
    if(l >= 4) {
        a.ty3 = p[3][0];
        a.id3 = p[3][1];
    }
    if(l >= 5) {
        a.ty4 = p[4][0];
        a.id4 = p[4][1];
    }
    if(l >= 6) {
        a.ty5 = p[5][0];
        a.id5 = p[5][1];
    }
    if(l >= 14) {
        throw new Error('assertion path overflow!');
    }
    return a;
}

/**
 *
 */
export function parentAssertionPath(a: AssertionPath): AssertionPath {
    return a.slice(0, -1);
}


/**
 * Compares two Assertions by user defined order_key.
 *
 * When there are duplicate order keys (which occurs when not pre-filtering
 * by a particular time), provides stable results, and attempts to make
 * them as pleasant as possible - but they still will be a bit weird
 * if the item has been moved in the list.
 *
 * Handles null/undefined order_keys.
 */
export function compareAssertionsByOrderKey(a: Assertion, b: Assertion): number {
    return orderkey.compareOrderKeys(a.order_key, b.order_key) ||
        a.id - b.id ||               // if order keys same - next order by fact id
        a.valid_to - b.valid_to ||   // if facts ids are the same, next by assertion time
        a.assertion_id - b.assertion_id  // Finally by assertion_id (always unique)
}

/**
 * Compares to assertions based on how recently they were made.  For assertions
 * made at the same time, falls back to id, then assertion_id so always have
 * a stable sort.
 */
export function compareAssertionsByRecentness(a: Assertion, b: Assertion): number {
    return a.valid_from - b.valid_from ||
        a.id - b.id ||
        a.assertion_id - b.assertion_id;
}

export function getAssertionPathFields(a: Assertion): Pick<Assertion, 'ty0'|'ty1'|'id1'|'ty2'|'id2'|'ty3'|'id3'|'ty4'|'id4'|'ty5'|'id5'> {
    return {
        ty0: a.ty0,
        ty1: a.ty1, id1: a.id1,
        ty2: a.ty2, id2: a.id2,
        ty3: a.ty3, id3: a.id3,
        ty4: a.ty4, id4: a.id4,
        ty5: a.ty5, id5: a.id5,
    };
}

export function copyAssertionPath(src: Assertion, target: Assertion): Assertion {
    target.ty0 = src.ty0;
    target.ty1 = src.ty1;
    target.id1 = src.id1;
    target.ty2 = src.ty2;
    target.id2 = src.id2;
    target.ty3 = src.ty3;
    target.id3 = src.id3;
    target.ty4 = src.ty4;
    target.id4 = src.id4;
    target.ty5 = src.ty5;
    target.id5 = src.id5;
    return target;
}

export function getAssertionTypeN(a: Assertion, n: number): string|undefined {
    switch(n) {
        case 0: return a.ty0;
        case 1: return a.ty1;
        case 2: return a.ty2;
        case 3: return a.ty3;
        case 4: return a.ty4;
        case 5: return a.ty5;
        default: return undefined;
    }
}

export function getAssertionIdN(a: Assertion, n: number): number|undefined {
    switch(n) {
        case 0: return 0; // id0 is the root of a table and always 0
        case 1: return a.id1;
        case 2: return a.id2;
        case 3: return a.id3;
        case 4: return a.id4;
        case 5: return a.id5;
        default: return undefined;
    }
}

export type AssertionPartial = Partial<Assertion>;
export const assertionFieldNames: Array<keyof Assertion> = [
    "assertion_id",

    "valid_from", "valid_to",
    "published_from", "published_to",

    "id", "ty",

    "ty0",
    "ty1", "id1",
    "ty2", "id2",
    "ty3", "id3",
    "ty4", "id4",
    "ty5", "id5",

    "attr1", "attr2", "attr3", "attr4", "attr5", "attr6", "attr7", "attr8",
    "attr9", "attr10", "attr11", "attr12", "attr13", "attr14", "attr15",

    "tags",

    "order_key", "locale_expr", "confidence_expr",

    "note",
    
    "change_by_username", "change_action", "change_arg", "change_note",
    ];


const createAssertionDml = (tableName:string)=>block`
/**/   CREATE TABLE IF NOT EXISTS ${tableName}(
/**/       assertion_id INTEGER PRIMARY KEY ASC,
/**/
/**/       valid_from INTEGER NOT NULL,
/**/       valid_to INTEGER NOT NULL,
/**/
/**/       published_from INTEGER,
/**/       published_to INTEGER,
/**/
/**/       id INTEGER NOT NULL,
/**/       ty TEXT NOT NULL,
/**/
/**/       ty0 TEXT NOT NULL,
/**/       ty1 TEXT,
/**/       id1 INTEGER,
/**/       ty2 TEXT,
/**/       id2 INTEGER,
/**/       ty3 TEXT,
/**/       id3 INTEGER,
/**/       ty4 TEXT,
/**/       id4 INTEGER,
/**/       ty5 TEXT,
/**/       id5 INTEGER,
/**/
/**/       attr1,
/**/       attr2,
/**/       attr3,
/**/       attr4,
/**/       attr5,
/**/       attr6,
/**/       attr7,
/**/       attr8,
/**/       attr9,
/**/       attr10,
/**/       attr11,
/**/       attr12,
/**/       attr13,
/**/       attr14,
/**/       attr15,
/**/
/**/       tags TEXT,
/**/
/**/       order_key TEXT,
/**/
/**/       locale_expr TEXT,
/**/       confidence_expr TEXT,
/**/
/**/       note TEXT,
/**/
/**/       change_by_username TEXT,
/**/       change_action TEXT,
/**/       change_arg TEXT,
/**/       change_note TEXT);
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_valid_from ON ${tableName}(valid_from);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_valid_to ON ${tableName}(valid_to) WHERE valid_to != ${timestamp.END_OF_TIME};
/**/
/**/   CREATE UNIQUE INDEX IF NOT EXISTS current_${tableName}_by_id_ty ON ${tableName}(id, ty) WHERE valid_to = NULL;
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty1 ON ${tableName}(ty1);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty2 ON ${tableName}(ty2);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty3 ON ${tableName}(ty3);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty4 ON ${tableName}(ty4);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty5 ON ${tableName}(ty5);
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty1 ON ${tableName}(id1, ty1);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty2 ON ${tableName}(id2, ty2);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty3 ON ${tableName}(id3, ty3);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty4 ON ${tableName}(id4, ty4);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty5 ON ${tableName}(id5, ty5);
/**/
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE valid_to = NULL;
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE valid_to = NULL;
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE valid_to = NULL;
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE valid_to = NULL;
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE valid_to = NULL;
/**/
/**/ -- NEED SOME MODEL CHANGE SO CAN INDEX LATEST PUBLISHED XXX TODO XXX TODO
/**/
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   `;


assertDmlContainsAllFields(createAssertionDml('__test__'), assertionFieldNames);

export const selectAssertionsForTopLevelFact = (tableName: string)=>db().prepare<Assertion, {id1: number}>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          WHERE id1 = :id1
/**/          ORDER BY valid_from, id`);

export const selectAllAssertions = (tableName: string)=>db().prepare<Assertion>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          ORDER BY valid_from, id`);

export function updateAssertion<T extends Partial<Assertion>>(tableName: string, assertion_id: number,fieldNames:Array<keyof T>, fields: T) {
    return db().update<T>(tableName, 'assertion_id', fieldNames, assertion_id, fields);
}

//const highestValueTo = (tableName: string)=>

/**
 * Returns the highest timestamp in a table.
 *
 */
export function highestTimestamp(tableName: string): number {
    console.info('AAA', db().prepare<Assertion, {}>(`SELECT MAX(valid_from) AS max_valid_from FROM ${tableName}`).required({}));
    const maxValidFrom = db().prepare<{max_valid_from: number}, {}>(`SELECT MAX(valid_from) AS max_valid_from FROM ${tableName}`).required({}).max_valid_from;
    // TODO we have an index that matches this, but not sure if sqlite will use it!
    //      not causing problems at the moment, becase we are reading this once at
    //      startup - but should investigate.
//console.info('FFF', db().prepare<{max_valid_to: number}, {}>(`SELECT * FROM ${tableName} WHERE valid_to != ${timestamp.END_OF_TIME}`).all({}));
    const maxValidTo = db().prepare<{max_valid_to: number}, {}>(`SELECT MAX(valid_to) AS max_valid_to FROM ${tableName} WHERE valid_to != ${timestamp.END_OF_TIME}`).required({}).max_valid_to;
    console.info('maxValidTo', maxValidTo, 'maxValidFrom', maxValidFrom);
    return Math.max(maxValidTo ?? timestamp.BEGINNING_OF_TIME,
                    maxValidFrom ?? timestamp.BEGINNING_OF_TIME);
}

// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

const allSchemaDml =
    createUserDml + createDocumentDml + createPageDml + createLayerDml +
    createBoundingGroupDml + createBoundingBoxDml + createChangeLogDml +
    createAssertionDml('dict');

export function createAllTables() {
    console.info('ALL SCHEMA DML', allSchemaDml);
    db().executeStatements(allSchemaDml);
    console.info('db created');
}

// await db.prepare<{}, {layer_id: number}>
//     ('UPDATE TABLE bounding_box SET bounding_group_id = NULL WHERE layer_id = :layer_id')
//     .allEntries();


// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

async function main(args: string[]) {
    const cmd = args[0];
    switch(cmd) {
        case 'createDb': // TODO REMOVE THIS ONCE WE ARE MORE STABLE (TOO DANGER!)
            console.info('DELETING DB');
            Db.deleteDb(defaultDbPath);
            createAllTables();
            break;
        default:
            console.info('BAD COMMAND!');
            break;
    }    
}

if (import.meta.main)
    await main(Deno.args);
