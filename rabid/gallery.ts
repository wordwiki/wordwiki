// deno-lint-ignore-file no-explicit-any
//
// A generic PHOTO GALLERY, attachable to any owner record - the exact
// (owner_table, owner_id) pattern that projects/tasks use.  Factored out of the
// event page (it started as EventPhotoTable): an ordered list of captioned photos,
// each a card with the full generic photo editor (upload / crop / remove), a
// caption + photographer, positional insert/reorder/delete (handy for fixing up a
// scanned batch), and a "+" to add one straight from the file picker.
//
// Attach it to a detail page with:  rabid.gallery_photo.renderGallery('service', id)
//
// Reloadable-fragment scheme (liminal.md): a photo attaches to a COMPOSITE owner,
// so there's no single fk to hang a shape key on (unlike a task's project_id).  We
// hand-mint an owner-scoped shape key `-gallery_photo-<owner_table>-<owner_id>-shape-`
// for the section (add/remove/reorder) and use the plain row key for a card
// (caption/crop edit).  Same-browser refresh rides the explicit reload targets the
// mutations return; cross-browser liveness rides the same key recorded into the
// dirty log (dirty.record) - the DML can't auto-emit it since owner is composite.

import { db } from "../liminal/db.ts";
import { Table, PrimaryKeyField, StringField, IntegerField, ImageField,
         pencilIcon, editButtonProps, liveReloadableProps } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import { route, routeMutation, authenticated } from "../liminal/security.ts";
import * as dirty from "../liminal/dirty.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { block } from "../liminal/strings.ts";
import { path } from "../liminal/serializable.ts";
import { Markup, h } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import { parsePhotoValue } from "../liminal/photo.ts";
import { ownerCanEdit } from "./owned.ts";
import { rabid } from "./rabid.ts";

// A framework-managed order column: hidden from the form, set by insert()/moves.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

export interface GalleryPhoto {
    gallery_photo_id: number;
    owner_table: string;
    owner_id: number;
    // Which gallery on the owner: '' is the default (e.g. an event's photos), a
    // named scope is a SEPARATE gallery on the same owner (e.g. 'service-sheets').
    // Permission still follows (owner_table, owner_id); the scope only partitions.
    scope: string;
    caption: string;
    photographer: string;
    order_key: string;
    photo?: string;
}
export type GalleryPhotoOpt = Partial<GalleryPhoto>;

// A photo edit is permitted exactly when the OWNER record may be edited (resolved
// generically via owned.ts / tableByName) - a service photo defers to the service's
// permission, a committee photo to the committee's, etc.
function assertOwnerEdit(owner_table: string, owner_id: number): void {
    if(!ownerCanEdit(owner_table, owner_id))
        throw new Error('Not permitted to edit this gallery');
}

// Gallery scopes whose cards show the WHOLE image (contain-fit) instead of a
// cover-crop - for full document scans (service record sheets) that must stay
// readable, not clipped.
const CONTAIN_SCOPES = new Set(['service-sheets']);

export class GalleryPhotoTable extends Table<GalleryPhoto> {
    constructor() {
        super('gallery_photo', [
            new PrimaryKeyField('gallery_photo_id', {}),
            // The owner this photo hangs off, a (owner_table, owner_id) pair (like
            // project/task).  Bound - not user-editable.
            new StringField('owner_table', {edit: security.never}),
            new IntegerField('owner_id', {indexed: true, edit: security.never}),
            // The gallery scope on the owner ('' = default).  Bound, not editable.
            new StringField('scope', {default: '', edit: security.never}),
            new StringField('caption', {default: '', prompt: 'Caption'}),
            new StringField('photographer', {default: '', prompt: 'Photographer'}),
            // Sibling order within one owner's gallery (orderkey.ts); a shape column,
            // so moves reload the section.  Managed - set by insert()/moves.
            new ManagedStringField('order_key', {default: ''}),
            new ImageField('photo', 'rabid.photo', {aspect: 'landscape', nullable: true, prompt: 'Photo'}),
        ]);
    }

    // A photo's edit permission follows its owner record's.
    override canEditRecord(record: GalleryPhoto): boolean {
        return ownerCanEdit(record.owner_table, record.owner_id);
    }
    override formTitle(_p: GalleryPhoto): string { return 'Edit photo'; }

    // Sheet scopes display contain-fit (whole image), so the edit modal must NOT
    // offer cover-crop framing, and its preview shows the whole (rotatable) image.
    protected override offersCropFraming(record: GalleryPhoto, _field: ImageField): boolean {
        return !CONTAIN_SCOPES.has(record.scope);
    }
    protected override renderPhotoPreview(record: GalleryPhoto, field: ImageField, value: string): Markup {
        return CONTAIN_SCOPES.has(record.scope)
            ? rabid.photo.containedImg(value, 1024, 1024, {class: 'lm-photo-preview'})
            : super.renderPhotoPreview(record, field, value);
    }

    // The owner+scope shape key (hand-minted - owner is composite, no single fk).
    // Default scope keeps the pre-scope key unchanged.
    private ownerShapeKey(owner_table: string, owner_id: number, scope: string): string {
        return `-gallery_photo-${owner_table}-${owner_id}${scope ? '-' + scope : ''}-shape-`;
    }

    // Append at the end of this owner+scope's order; an explicit order_key wins.
    override insert<P extends GalleryPhotoOpt>(tuple: P): number {
        const withManaged: any = {order_key: this.nextOrderKey(
            String(tuple.owner_table), Number(tuple.owner_id), String((tuple as any).scope ?? '')), ...tuple};
        return super.insert(withManaged);
    }
    private nextOrderKey(owner_table: string, owner_id: number, scope: string): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {owner_table: string, owner_id: number, scope: string}>(
            'SELECT MAX(order_key) AS k FROM gallery_photo WHERE owner_table = :owner_table AND owner_id = :owner_id AND scope = :scope')
            .first({owner_table, owner_id, scope}));
        return orderkey.between(last?.k, undefined);
    }

    @path
    get forOwner() {
        return this.prepare<GalleryPhoto, {owner_table: string, owner_id: number, scope: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM gallery_photo
/**/          WHERE owner_table = :owner_table AND owner_id = :owner_id AND scope = :scope
/**/          ORDER BY order_key, gallery_photo_id`);
    }

    // Reload the owner+scope's section: same-browser via the returned target,
    // cross-browser via the dirty log (recorded here since the composite owner has
    // no auto-emitted shape key).
    private reloadOwner(owner_table: string, owner_id: number, scope: string): Markup {
        const key = this.ownerShapeKey(owner_table, owner_id, scope);
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }

    // ------------------------------------------------------------------------
    // --- The gallery section (attach this to any detail page) ----------------
    // ------------------------------------------------------------------------

    // A "Photos" section for one owner: a live, shape-keyed fragment (add/delete
    // refresh it) with a "+" to add straight from the picker.  Renders nothing for
    // a non-editor with no photos.
    // A gallery section for one owner+scope: a live, shape-keyed fragment (add/delete
    // refresh it) with a "+" to add straight from the picker.  Renders nothing for a
    // non-editor with no photos.  `scope` selects one of several galleries on an owner
    // (''=default); `title` is the section heading.
    @route(authenticated)
    renderGallery(owner_table: string, owner_id: number, scope: string = '', title: string = 'Photos'): Markup {
        const photos = security.runSystem(() => this.forOwner.all({owner_table, owner_id, scope}));
        const canAdd = ownerCanEdit(owner_table, owner_id);
        if(!canAdd && photos.length === 0) return undefined as unknown as Markup;
        const props = liveReloadableProps([this.ownerShapeKey(owner_table, owner_id, scope)],
            `rabid.gallery_photo.renderGallery('${owner_table}', ${owner_id}, '${scope}', '${title}')`);
        const domId = scope ? `photos-${scope}` : 'photos';
        return [h.div, {...props, id: domId, 'data-testid': `gallery-${owner_table}-${owner_id}${scope ? '-' + scope : ''}`},
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, title],
             canAdd ? this.renderGalleryAdd(owner_table, owner_id, scope, title) : undefined],
            [h.div, {class: 'lm-subsection'},
             photos.length
                 ? photos.map(p => this.renderPhotoCard(p))
                 : [h.p, {class: 'text-muted small mb-0'}, 'No photos yet.']]];
    }

    // The section header's add affordance.  A plain gallery gets a bare "+".  A
    // sheet-scope gallery gets a ☰ menu instead, so the future "Import scanned
    // records…" (scan → extract) action has a home beside "Add photo…".
    private renderGalleryAdd(owner_table: string, owner_id: number, scope: string, title: string): Markup {
        const addDialog = `/rabid.gallery_photo.newPhotoDialog('${owner_table}', ${owner_id}, '${scope}')`;
        if(CONTAIN_SCOPES.has(scope)) {
            const items: action.ActionMenuItem[] = [{label: 'Add photo…', mode: {kind: 'modal', dialogUrl: addDialog}}];
            // Service-sheets on an event: kick a scan -> extract import of the photos
            // into service rows (scan-extract.md).  owner_id is the event_id.
            if(scope === 'service-sheets' && owner_table === 'event')
                items.push({label: 'Import scanned records…',
                    mode: {kind: 'confirm', message: 'Read service records from these sheet photos? This runs in the background.',
                           expr: `rabid.extraction_job.startServiceImport(${owner_id})`}});
            return action.actionMenu(items, {ariaLabel: `${title} actions`});
        }
        return action.actionButton(action.plusIcon(), {kind: 'modal', dialogUrl: addDialog},
            'lm-menu-button', {'aria-label': `Add to ${title}`, title: `Add to ${title}`});
    }

    // The add dialog: pick a photo (the ImageField's file picker uploads to the
    // content store on select) + caption + photographer; submit creates the card.
    @route(authenticated)
    newPhotoDialog(owner_table: string, owner_id: number, scope: string = ''): Markup {
        assertOwnerEdit(owner_table, owner_id);
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.photo, f.caption, f.photographer], {} as Partial<GalleryPhoto>,
            {
                title: 'Add photo',
                submitLabel: 'Add',
                hidden: {owner_table, owner_id, scope},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.gallery_photo.addPhoto(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(authenticated)
    addPhoto(args: {owner_table?: string, owner_id?: string|number, scope?: string, photo?: string,
                    caption?: string, photographer?: string}): Markup {
        const owner_table = String(args?.owner_table ?? '');
        const owner_id = Number(args?.owner_id);
        const scope = String(args?.scope ?? '');
        if(!owner_table || !Number.isInteger(owner_id) || !owner_id) throw new Error('Missing owner');
        assertOwnerEdit(owner_table, owner_id);
        this.insert({
            owner_table, owner_id, scope,
            photo: (args.photo ?? '') || undefined,
            caption: (args.caption ?? '').trim(),
            photographer: (args.photographer ?? '').trim(),
        } as GalleryPhotoOpt);
        return this.reloadOwner(owner_table, owner_id, scope);
    }

    // Insert a new (empty) card directly before/after an anchor, in place; upload
    // + caption it via its own Edit Photo.
    @routeMutation(authenticated)
    insertRelative(anchor_id: number, position: string): Markup {
        const anchor = this.getById(anchor_id);
        assertOwnerEdit(anchor.owner_table, anchor.owner_id);
        const sibs = security.runSystem(() => this.forOwner.all(
            {owner_table: anchor.owner_table, owner_id: anchor.owner_id, scope: anchor.scope}));
        const i = sibs.findIndex(s => s.gallery_photo_id === anchor_id);
        const order_key = position === 'before'
            ? orderkey.between(sibs[i-1]?.order_key, sibs[i]?.order_key)
            : orderkey.between(sibs[i]?.order_key, sibs[i+1]?.order_key);
        this.insert({owner_table: anchor.owner_table, owner_id: anchor.owner_id, scope: anchor.scope,
                     caption: '', photographer: '', order_key} as GalleryPhotoOpt);
        return this.reloadOwner(anchor.owner_table, anchor.owner_id, anchor.scope);
    }

    @routeMutation(authenticated)
    moveUp(id: number): Markup { return this.moveBy(id, -1); }
    @routeMutation(authenticated)
    moveDown(id: number): Markup { return this.moveBy(id, +1); }
    private moveBy(id: number, dir: -1|1): Markup {
        const p = this.getById(id);
        assertOwnerEdit(p.owner_table, p.owner_id);
        const sibs = security.runSystem(() => this.forOwner.all(
            {owner_table: p.owner_table, owner_id: p.owner_id, scope: p.scope}));
        const i = sibs.findIndex(s => s.gallery_photo_id === id);
        const j = i + dir;
        if(i >= 0 && j >= 0 && j < sibs.length) {
            const order_key = dir < 0
                ? orderkey.between(sibs[j-1]?.order_key, sibs[j].order_key)
                : orderkey.between(sibs[j].order_key, sibs[j+1]?.order_key);
            this.update(id, {order_key} as any);
        }
        return this.reloadOwner(p.owner_table, p.owner_id, p.scope);
    }

    @routeMutation(authenticated)
    remove(id: number): Markup {
        const p = this.getById(id);
        assertOwnerEdit(p.owner_table, p.owner_id);
        this.delete(id);
        return this.reloadOwner(p.owner_table, p.owner_id, p.scope);
    }

    // The Edit Photo modal: the generic photo editor (upload / crop / remove) plus,
    // when a photo is set, a link to the full-quality original.  (Caption/photographer
    // are edited in their OWN modal - renderDetailsForm - so we never stack two forms
    // in one modal, which broke editing.)
    @route(authenticated)
    override async renderPhotoEditForm(id: number, fieldName: string): Promise<Markup> {
        const record = this.getById(id);
        if(!record || !this.canEditRecord(record))
            throw new Error(`Not permitted to edit this ${this.name}`);
        const body = await super.renderPhotoEditForm(id, fieldName);
        const value = (record as any)[fieldName];
        const original = (typeof value === 'string' && value !== '')
            ? [h.div, {class: 'mt-2'},
               [h.a, {href: '/' + parsePhotoValue(value).path, target: '_blank', rel: 'noopener',
                      class: 'small'}, 'Original photo (full quality)']]
            : undefined;
        return [h.div, {}, body, original];
    }

    // The caption + photographer editor, opened from a card's ☰ "Edit caption…".
    @route(authenticated)
    renderDetailsForm(gallery_photo_id: number): Markup {
        return this.renderEditForm(this.getById(gallery_photo_id), ['caption', 'photographer']);
    }

    // One photo card: its own reloadable fragment (ROW key), so a caption/crop edit
    // refreshes only this card - the section is on the owner SHAPE key, so it stays
    // put (reloads only when a card is added/removed/reordered).  Layout: the image,
    // then the caption, then the photographer credit, with a pencil (-> Edit Photo)
    // and a ☰ for editors.
    @route(authenticated)
    renderPhotoCardById(gallery_photo_id: number): Markup {
        return this.renderPhotoCard(this.getById(gallery_photo_id));
    }
    renderPhotoCard(p: GalleryPhoto): Markup {
        const id = p.gallery_photo_id;
        const has = typeof p.photo === 'string' && p.photo !== '';
        const canEdit = this.canEditRecord(p);
        // LIVE on the row key: another actor's caption/crop edit propagates here.
        const props = liveReloadableProps([this.rowKey(id)], `rabid.gallery_photo.renderPhotoCardById(${id})`);
        const editPhotoUrl = `/rabid.gallery_photo.renderPhotoEditForm(${id},"photo")`;
        const editDetailsUrl = `/rabid.gallery_photo.renderDetailsForm(${id})`;
        // Sheet-style scopes show the WHOLE image (contain-fit, uncropped) so a
        // full document scan is readable; other galleries cover-crop for a tidy card.
        const img = has
            ? (CONTAIN_SCOPES.has(p.scope)
                ? rabid.photo.containedImg(p.photo!, 1024, 1024, {class: 'lm-photo-detail'})
                : rabid.photo.aspectImg(p.photo!, 'landscape', 'detail', {class: 'lm-photo-detail'}))
            : undefined;
        // Clicking the image opens Edit photo (a convenience alongside the ☰).
        const image = (img && canEdit)
            ? action.actionButton(img, {kind: 'modal', dialogUrl: editPhotoUrl},
                'btn p-0 border-0 bg-transparent', {'aria-label': 'Edit photo'})
            : img;
        const pencil = canEdit
            ? [h.button, {...editButtonProps(editPhotoUrl),
                          class: 'edit lm-edit-pencil', type: 'button', 'aria-label': 'Edit photo'},
               pencilIcon()]
            : undefined;
        const menu = canEdit ? action.actionMenu([
            {label: has ? 'Edit photo…' : 'Add photo…', mode: {kind: 'modal', dialogUrl: editPhotoUrl}},
            {label: 'Edit caption…', mode: {kind: 'modal', dialogUrl: editDetailsUrl}},
            {label: 'Insert before', mode: {kind: 'immediate', expr: `rabid.gallery_photo.insertRelative(${id}, 'before')`}},
            {label: 'Insert after', mode: {kind: 'immediate', expr: `rabid.gallery_photo.insertRelative(${id}, 'after')`}},
            {label: 'Move up', mode: {kind: 'immediate', expr: `rabid.gallery_photo.moveUp(${id})`}},
            {label: 'Move down', mode: {kind: 'immediate', expr: `rabid.gallery_photo.moveDown(${id})`}},
            {label: 'Delete', mode: {kind: 'confirm', message: 'Delete this photo?', expr: `rabid.gallery_photo.remove(${id})`}},
        ], {ariaLabel: 'Photo actions'}) : undefined;

        return [h.div, {...props, class: props.class + ' mb-4', 'data-testid': `gallery-photo-${id}`},
            image,
            [h.div, {class: 'mt-1 d-flex align-items-center gap-2'},
             p.caption ? [h.span, {}, p.caption] : undefined, pencil, menu],
            p.photographer ? [h.div, {class: 'text-muted small'}, `Photo: ${p.photographer}`] : undefined];
    }
}

export const galleryPhotoMetaData = new GalleryPhotoTable();
export const allDml = galleryPhotoMetaData.createDMLString();
