import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {block} from "../utils/strings.ts";

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
/**/       bounding_box_id, text, content='bounding_box', content_rowid='bounding_box_id');
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_insert AFTER INSERT ON bounding_box BEGIN
/**/        INSERT INTO bounding_box_fts(rowid, text) VALUES (new.bounding_box_id, new.text);
/**/   END;
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_delete AFTER DELETE ON bounding_box BEGIN
/**/       INSERT INTO bounding_box_fts(bounding_box_fts, rowid, text) VALUES('delete', old.bounding_box_id, old.text);
/**/   END;
/**/   CREATE TRIGGER IF NOT EXISTS bounding_box_fts_update AFTER UPDATE ON bounding_box BEGIN
/**/       INSERT INTO bounding_box_fts(bounding_box_fts, rowid, text) VALUES('delete', old.bounding_box_id, old.text);
/**/       INSERT INTO bounding_box_fts(rowid, text) VALUES (new.bounding_box_id, new.text);
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
     * depth
     */
    depth: number;
    
    /**
     * (Denormalized) Flattening of the ancestor and self ids and types.
     */
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
    
    /**
     * Notes on this assertion (public and internal)
     */
    public_note?: string;
    internal_note?: string;
    
    /**
     * Locale expression for which this assertion hosts.
     */
    locale_expr?: string;

    /**
     * (Denormalized) Expansion of the locale expression into the
     * specific locales for which this assertion holds.
     */
    expanded_locale_list?: string;

    /**
     * (Denormalized) Boolean fields corresponding to whether this
     * assertion holds in a few application specified locales.
     *
     * PROBABLY DROP THIS W NEW PER-LOCALE TABLE COPY.
     */
    is_locale1?: boolnum;
    is_locale2?: boolnum;
    is_locale3?: boolnum;
    is_locale4?: boolnum;

    /**
     * Our present level of confidence (0-10) in this fact.
     *
     * This is critical because when gathering dictionary information, we
     * may collect an assertion 'I think "cat" had a secondary meaning ...',
     * or we may be collecting information from the public, without vetting.
     */
    confidence?: number;
    confidence_note?: string;
    
    /**
     * Key used to order this assertion within its peers (same parent_id and ty).
     *
     * (see utils/order_key for more details)
     */
    order_key?: string;

    /**
     *
     */
    published?: boolnum;

    /**
     * More thought here about approval, priorities, discussion etc.
     */
    change_by_username?: string;
    change_action?: string;
    change_arg?: string;
    change_note?: string;
}

export function getAssertionPath(a: Assertion): [string, number][] {
    const depth = a.depth;
    const path: [string, number][] = [];
    path.push([a.ty1!, a.id1!]);
    if(depth===1) return path;
    path.push([a.ty2!, a.id2!]);
    if(depth===2) return path;
    path.push([a.ty3!, a.id3!]);
    if(depth===3) return path;
    path.push([a.ty4!, a.id4!]);
    if(depth===4) return path;
    path.push([a.ty5!, a.id5!]);
    if(depth===5) return path;
    utils.panic('unexpected depth');
}

export function getAssertionTypeN(a: Assertion, n: number): string|undefined {
    switch(n) {
        case 0: return a.ty1;
        case 1: return a.ty2;
        case 2: return a.ty3;
        case 3: return a.ty4;
        case 4: return a.ty5;
        default: return undefined;
    }
}

export function getAssertionIdN(a: Assertion, n: number): number|undefined {
    switch(n) {
        case 0: return a.id1;
        case 1: return a.id2;
        case 2: return a.id3;
        case 3: return a.id4;
        case 4: return a.id5;
        default: return undefined;
    }
}

export type AssertionPartial = Partial<Assertion>;
export const assertionFieldNames: Array<keyof Assertion> = [
    "assertion_id",

    "valid_from", "valid_to",
    "published_from", "published_to",

    "id", "ty", "depth",
    
    "ty1", "id1",
    "ty2", "id2",
    "ty3", "id3",
    "ty4", "id4",
    "ty5", "id5",

    //"srctxt", "targettxt", "label", "value", "txt", "num", "ref",
    "attr1", "attr2", "attr3", "attr4", "attr5", "attr6", "attr7", "attr8",
    
    "public_note", "internal_note",
    
    "locale_expr", "expanded_locale_list",
    "is_locale1", "is_locale2", "is_locale3", "is_locale4",

    "confidence", "confidence_note",

    "order_key",

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
/**/       depth INTEGER,
/**/
/**/       ty1 TEXT NOT NULL,
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
/**/       -- srctxt TEXT,
/**/       -- targettxt TEXT,
/**/       -- label TEXT,
/**/       -- value TEXT,
/**/       -- txt TEXT,
/**/       -- num NUMBER,
/**/       -- ref NUMBER,
/**/
/**/       attr1,
/**/       attr2,
/**/       attr3,
/**/       attr4,
/**/       attr5,
/**/       attr6,
/**/       attr7,
/**/       attr8,
/**/
/**/       public_note NUMBER,
/**/       internal_note NUMBER,
/**/
/**/       locale_expr TEXT,
/**/       -- TODO probably drop all but locale_expr once we have per-local denorm copies.
/**/       expanded_locale_list TEXT,
/**/       is_locale1 INTEGER,
/**/       is_locale2 INTEGER,
/**/       is_locale3 INTEGER,
/**/       is_locale4 INTEGER,
/**/
/**/       confidence INTEGER,
/**/       confidence_note TEXT,
/**/
/**/       order_key TEXT,
/**/
/**/       change_by_username NUMBER,
/**/       change_action TEXT,
/**/       change_arg TEXT,
/**/       change_note TEXT);
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
/**/   CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/   CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/   CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/   CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/   CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/
/**/   CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   `;


assertDmlContainsAllFields(createAssertionDml('__test__'), assertionFieldNames);

export const selectAssertionsForTopLevelFact = (tableName: string)=>db().prepare<Assertion, {id1: number}>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          WHERE id1 = :id1
/**/          ORDER BY valid_from, id`);

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
