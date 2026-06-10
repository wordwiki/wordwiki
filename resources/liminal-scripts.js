/* liminal - generic framework client-side support.
   Loaded before the app's own scripts (e.g. rabid-scripts.js). */

/**
 * Click handler for an "editable surface" (an element rendered with
 * Table.editableItemProps - class .lm-editable, onclick="lmEditableClick(event)").
 *
 * The surface's *whole area* opens the record's edit dialog, by delegating to
 * the surface's own pencil/edit <button> (a real button, so keyboard and
 * screen-reader access never depend on this handler).  We decline the click
 * when it belongs to something else:
 *   - an inner interactive element (a link, the pencil itself, a form control)
 *     keeps its own behaviour - and since the pencil is a <button>, this also
 *     prevents double-firing when it is clicked directly;
 *   - a text-selection drag (someone copying an email address off the row);
 *   - a click that originated inside a *nested* editable surface (the inner
 *     surface's own handler deals with it; without this check the event would
 *     bubble up and open both dialogs).
 */
function lmEditableClick(event) {
    const item = event.currentTarget;
    if (event.target.closest('a, button, input, select, textarea, label'))
        return;
    if (event.target.closest('.lm-editable') !== item)
        return; // nested editable surface owns this click
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.type === 'Range')
        return; // user is selecting text, not tapping the row
    const button = item.querySelector('button.edit');
    if (button && button.closest('.lm-editable') === item)
        button.click();
}

/**
 * Dialog dispatch for "the action is a NAVIGATION": build a route expression
 * from the form's values and navigate to it, so the resulting page has a
 * real URL (sharable, back-button-able, refresh-stable).  E.g. a search
 * dialog with text="Dav" and an only_active checkbox navigates to
 *   /rabid.volunteer.search({text:"Dav",only_active:true})
 *
 * Wire it as the form's dispatch:
 *   onsubmit="lmNavigateFormRoute(event, 'rabid.volunteer.search')"
 *
 * Text-ish fields contribute JSON-escaped string args (safe: the route
 * interpreter parses them as literals - there is no eval); empty ones are
 * omitted.  Checkboxes contribute true/false.
 */
function lmNavigateFormRoute(event, routeFn) {
    event.preventDefault();
    const parts = [];
    for (const el of event.target.elements) {
        if (!el.name || el.type === 'submit' || el.type === 'button') continue;
        if (el.type === 'checkbox')
            parts.push(`${el.name}:${el.checked}`);
        else if (el.value !== '')
            parts.push(`${el.name}:${JSON.stringify(el.value)}`);
    }
    hideModalEditor();
    window.location.assign(`/${routeFn}({${parts.join(',')}})`);
}

/* ---------------------------------------------------------------------------
   Modal editor (the shared dialog that hosts edit forms / parameter dialogs;
   skeleton rendered by the app's page template, content loaded into
   #modalEditorBody by editButtonProps / actionButton hx-gets).
--------------------------------------------------------------------------- */

/**
 * Expects to run in an environment where the bootstrap JS code
 * has been loaded as a script.  This function packages accessing the bootstrap
 * global inst via the browser window object.
 */
function getGlobalBoostrapInst() {
    const bootstrap = window?.bootstrap;
    if(!bootstrap)
        throw new Error("can't find global bootstrap inst");
    return bootstrap;
}

function getModalEditor() {
    return getGlobalBoostrapInst().Modal.getOrCreateInstance('#modalEditor');
}

/* Discard protection: closing the dialog (the X) with unsaved edits asks
   before throwing them away.  Guarded forms are exactly the record-edit ones -
   they carry hidden before-* fields (the lock-free conflict snapshots), which
   doubles as the marker that closing loses real work.  Parameter dialogs
   (search etc.) have no before-* fields and close silently. */
let lmModalInitialState = null;   // form snapshot at show; null = unguarded
let lmModalDiscardOk = false;     // set while a clean (post-save) hide runs

function lmModalFormState() {
    const form = getModalBodyElem().querySelector('form');
    if (!form || !form.querySelector('input[name^="before-"]'))
        return null;
    return JSON.stringify(Array.from(new FormData(form).entries()));
}

function showModalEditor() {
    // A dialog names itself inline (.lm-dialog-title, rendered by liminal's
    // renderParamForm).  Lift that into the modal's fixed header, where it
    // stays visible while the form scrolls - and where it replaces whatever
    // the previous dialog left behind.
    // When the body has no inline title (e.g. showModalEditor is re-run after
    // the title was already lifted), keep the existing header rather than
    // blanking it - dialog content may arrive via more than one mechanism
    // (a page button's after-request, or an inline script in content swapped
    // from WITHIN the modal, where the issuing button is detached by its own
    // swap before after-request can fire on it).
    const inlineTitle = getModalBodyElem().querySelector('.lm-dialog-title');
    if (inlineTitle) {
        getModalTitleElem().innerText = inlineTitle.textContent.trim();
        inlineTitle.remove();
    }
    lmModalInitialState = lmModalFormState();
    getModalEditor().show();
}

function hideModalEditor() {
    // A programmatic hide is a clean close (tx() calls this after a successful
    // save) - the form is dirty relative to its snapshot by definition, so
    // bypass the discard guard.
    lmModalDiscardOk = true;
    try { getModalEditor().hide(); } finally { lmModalDiscardOk = false; }
    getModalTitleElem().innerText = '';
    getModalBodyElem().innerHTML = '';
}

// Wire the discard guard.  hide.bs.modal is cancelable: preventDefault keeps
// the dialog open.  (This script loads at the end of <body>, after the modal
// skeleton; pages without a modal editor skip silently.)
(() => {
    const modal = document.getElementById('modalEditor');
    if (modal) modal.addEventListener('hide.bs.modal', (event) => {
        if (lmModalDiscardOk || lmModalInitialState === null)
            return;
        if (lmModalFormState() !== lmModalInitialState && !confirm('Discard changes?'))
            event.preventDefault();
    });
})();

function getModalTitleElem() {
    const modalTitleElem = document.querySelector(`#modalEditorLabel`);
    if(!modalTitleElem)
        throw new Error('unable to find modal editor label for dialog');
    return modalTitleElem;
}

function getModalBodyElem() {
    const modalBodyElem = document.querySelector(`#modalEditorBody`);
    if(!modalBodyElem)
        throw new Error('unable to find modal editor body for dialog');
    return modalBodyElem;
}

function popupModalEditor(modalTitleText, modalBodyHtmlText) {
    getModalTitleElem().innerText = modalTitleText;
    getModalBodyElem().innerHTML = modalBodyHtmlText;
    showModalEditor();
}

/* ----------------------------------------------------------------------------
   Photo field (liminal/table.ts ImageField).

   On file pick: downscale/re-encode the image in the browser (canvas -> JPEG,
   which also STRIPS EXIF incl. GPS and bakes in the EXIF orientation), upload
   it to the app's PhotoService route, and set the field's hidden input to the
   returned content path.  Saving the record is then a plain string-field save;
   nothing is attached to the record until the user presses Save.
---------------------------------------------------------------------------- */

const LM_PHOTO_MAX_DIM = 1600;       // longest side of the stored original
const LM_PHOTO_JPEG_QUALITY = 0.85;

async function lmPhotoFieldChange(event, photoServicePath, fieldName) {
    const fileInput = event.target;
    const file = fileInput.files && fileInput.files[0];
    if(!file) return;
    const status = document.getElementById('photo-status-' + fieldName);
    const setStatus = (t) => { if(status) status.textContent = t; };
    try {
        setStatus('Preparing photo…');
        const jpegBlob = await lmDownscaleImageToJpeg(file, LM_PHOTO_MAX_DIM, LM_PHOTO_JPEG_QUALITY);
        setStatus('Uploading…');
        const imageBytesAsBase64 = await lmBlobToBase64(jpegBlob);
        // rpc (resources/rabid-scripts.js) is a tagged template - call its
        // (segments, ...args) convention directly since the route path is a
        // runtime value here.
        const result = await rpc([photoServicePath + '.upload(', ')'], {imageBytesAsBase64});
        const photoPath = result.photoPath;

        document.getElementById('input-' + fieldName).value = photoPath;
        const preview = document.getElementById('photo-preview-' + fieldName);
        if(preview) {
            preview.src = '/' + photoServicePath + '.serve(' + JSON.stringify(photoPath) + ',256)';
            preview.classList.remove('d-none');
        }
        const removeBtn = document.getElementById('photo-remove-' + fieldName);
        if(removeBtn) removeBtn.classList.remove('d-none');
        setStatus('Photo ready — press Save to keep it.');
    } catch(e) {
        console.error('photo upload failed', e);
        setStatus('Photo upload failed: ' + ((e && e.message) || e));
        fileInput.value = '';
    }
}

function lmPhotoFieldClear(fieldName) {
    document.getElementById('input-' + fieldName).value = '';
    const preview = document.getElementById('photo-preview-' + fieldName);
    if(preview) { preview.src = ''; preview.classList.add('d-none'); }
    const removeBtn = document.getElementById('photo-remove-' + fieldName);
    if(removeBtn) removeBtn.classList.add('d-none');
    const fileInput = document.getElementById('photo-file-' + fieldName);
    if(fileInput) fileInput.value = '';
    const status = document.getElementById('photo-status-' + fieldName);
    if(status) status.textContent = 'Photo removed — press Save to keep the change.';
}

// Decode + downscale to a JPEG blob.  imageOrientation:'from-image' bakes the
// EXIF rotation into the pixels where supported (older Safari: fall back to a
// plain decode).  A file the browser can't decode (e.g. HEIC on Chrome)
// throws, surfacing as the field's failure status.
async function lmDownscaleImageToJpeg(file, maxDim, quality) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
    catch(_e) { bitmap = await createImageBitmap(file); }
    try {
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        return await new Promise((resolve, reject) =>
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('image encode failed')),
                          'image/jpeg', quality));
    } finally {
        if(bitmap.close) bitmap.close();
    }
}

function lmBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        // result is a data: URL - strip the prefix to get plain base64.
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
