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
    const inlineTitle = getModalBodyElem().querySelector('.lm-dialog-title');
    getModalTitleElem().innerText = inlineTitle ? inlineTitle.textContent.trim() : '';
    if (inlineTitle)
        inlineTitle.remove();
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
