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
