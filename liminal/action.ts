// deno-lint-ignore-file no-explicit-any
/**
 * Actions: the write side of the UI model.
 *
 * Every mutation (and every parameterised query) in this system is "an action
 * with a parameter list", surfaced as a button in one of three forms:
 *
 *   - immediate : clicking the button performs the action at once.
 *   - confirm   : clicking asks for confirmation, then performs the action.
 *   - modal     : clicking opens a small dialog that collects the *arguments to
 *                 the action*, and performs it when the dialog is submitted.
 *
 * The modal form is two round-trips, both through the normal route/expr
 * mechanism:
 *   1. The button asks a server function (named by a route expression, with any
 *      fixed parameters baked in) to *generate* the dialog.  The dialog is built
 *      from the same Field widgets as the tables, and may include hidden fields
 *      for parameters that are fixed by the button and not user-editable, but
 *      that still ride along on submit.
 *   2. Submitting the dialog performs the action with the combined visible +
 *      hidden values.
 *
 * This is the general case of TableEditForm: editing a record is just the
 * instance where the parameters are a row's columns (and the primary key is a
 * hidden field); "search the volunteers by a term" is the instance where the
 * visible parameter is a search string and the search scope is a hidden field.
 *
 * What happens to the result is decided by the dialog's *dispatch attributes*:
 *   - a data mutation submits via onsubmit="tx`expr(getFormJSON(event.target))`"
 *     and the server returns {action:'reload'|'alert', ...} (see rabid-scripts.js).
 *   - a query/view action submits via hx-get/hx-post with an hx-target, and the
 *     server returns the rendered view to swap into that target.
 */
import type {Field, Tuple, FieldRenderContext} from './table.ts';
import {h} from './markup.ts';
import type {Markup} from './markup.ts';

// ----------------------------------------------------------------------------
// --- Action buttons ---------------------------------------------------------
// ----------------------------------------------------------------------------

export type ActionMode =
    // Run tx`expr` immediately on click.  expr is a client-evaluated JS
    // expression, typically a tx`...` target like 'rabid.foo.bar(7)'.
    | {kind: 'immediate', expr: string}
    // Same, but gated behind a confirm() dialog.
    | {kind: 'confirm', expr: string, message: string}
    // Ask the server (via dialogUrl, a normal route expression that may carry
    // fixed parameters) to generate a parameter dialog, and load it into the
    // shared modal editor.  The dialog dispatches the action when submitted.
    | {kind: 'modal', dialogUrl: string};

/**
 * Render a button that invokes an action in one of the three supported forms.
 * extraProps merge into the button's attributes - e.g. an aria-label for
 * icon-only buttons ('×').
 */
export function actionButton(label: Markup, mode: ActionMode,
                             btnClass: string = 'btn btn-primary',
                             extraProps: Record<string, string> = {}): Markup {
    switch(mode.kind) {
        case 'immediate':
            return [h.button, {type:'button', class:btnClass,
                               onclick:`tx\`${mode.expr}\``, ...extraProps}, label];
        case 'confirm':
            return [h.button, {type:'button', class:btnClass,
                               onclick:`if(confirm(${JSON.stringify(mode.message)})) tx\`${mode.expr}\``,
                               ...extraProps}, label];
        case 'modal':
            // Same wiring as table.editButtonProps, minus the record-edit 'edit'
            // class: load the generated dialog into the modal body, then show it.
            return [h.button, {type:'button', class:btnClass,
                               'hx-get': mode.dialogUrl,
                               'hx-target': '#modalEditorBody',
                               'hx-swap': 'innerHTML',
                               'hx-on::after-request': 'showModalEditor()', ...extraProps}, label];
    }
}

/**
 * A quiet ☰ menu for a line's LESS-COMMON actions (the common ones stay as
 * the pencil and inline buttons): an icon-only button popping a Bootstrap
 * dropdown of action items, each in one of the three standard action forms.
 * This keeps rarely-used affordances from occupying permanent space - pages
 * should read as documents that present their information, coincidentally
 * editable.  (Bootstrap's dropdown data-api is delegation-based, so menus
 * inside htmx-swapped fragments work without re-initialization.)
 */
export function actionMenu(items: Array<{label: string, mode: ActionMode}>,
                           opts: {ariaLabel?: string} = {}): Markup {
    return [h.div, {class: 'dropdown lm-action-menu'},
        [h.button, {type: 'button', class: 'lm-menu-button',
                    'data-bs-toggle': 'dropdown', 'aria-expanded': 'false',
                    'aria-label': opts.ariaLabel ?? 'More actions'},
         menuIcon()],
        [h.ul, {class: 'dropdown-menu'},
         items.map(it => [h.li, {}, actionButton(it.label, it.mode, 'dropdown-item')])]];
}

// Three-bars menu glyph (Bootstrap Icons "list", MIT), inlined like pencilIcon.
function menuIcon(): Markup {
    return ['svg', {viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true'},
            ['path', {d: 'M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z'}]];
}

// Plus glyph (Bootstrap Icons "plus-lg", MIT) - for icon-only "new/add"
// buttons (pass to actionButton with the lm-menu-button class and an
// aria-label; pair with an actionMenu carrying the same action by name).
export function plusIcon(): Markup {
    return ['svg', {viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true'},
            ['path', {d: 'M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z'}]];
}

// ----------------------------------------------------------------------------
// --- Parameter dialogs (the general case of TableEditForm) ------------------
// ----------------------------------------------------------------------------

export interface ParamFormOptions {
    title?: string;
    submitLabel?: string;
    /**
     * Parameters fixed by whoever generated the dialog and not editable by the
     * user (e.g. a record id, or a search scope).  Rendered as hidden inputs so
     * they ride along when the dialog is submitted.
     */
    hidden?: Record<string, any>;
    /**
     * Optional context forwarded to each field's renderInput (e.g. the owning
     * table's route path, which foreign-key fields use to build their remote
     * picker route).
     */
    fieldContext?: FieldRenderContext;
    /**
     * Attributes placed on the <form> that decide how the action is dispatched
     * and where its result goes.  Two common shapes:
     *   - mutation: {onsubmit: "event.preventDefault(); tx`expr(getFormJSON(event.target))`"}
     *   - query:    {'hx-get': "...route(queryArgs)", 'hx-target': '#results', 'hx-swap': 'innerHTML'}
     */
    dispatch: Record<string, any>;
}

/**
 * Render a dialog that collects the arguments to an action.
 *
 * Each visible parameter is rendered with its Field widget (so dates get date
 * pickers, enums get selects, etc.), pre-filled from `defaults`.
 */
export function renderParamForm(params: Field[], defaults: Tuple, opts: ParamFormOptions): Markup {
    return [
        h.form, Object.assign({class: 'row g-3'}, opts.dispatch),

        // lm-dialog-title: when this form is shown in the shared modal editor,
        // showModalEditor() lifts this element's text into the modal's fixed
        // header (and removes it from the body).  Rendered standalone (outside
        // the modal) it simply stays here as the form's heading.
        opts.title !== undefined
            ? [h.h2, {class: 'lm-dialog-title h5 col-12'}, opts.title]
            : undefined,

        // Hidden (non-user-editable) parameters supplied by the dialog generator.
        // Value is passed raw: the markup renderer coerces numbers to strings and
        // omits the attribute entirely for null/undefined (which then submits as
        // ""), matching the before-value wire format the record editor relies on.
        Object.entries(opts.hidden ?? {}).map(([name, value]) =>
            [h.input, {type: 'hidden', name, value}]),

        // One input per visible parameter (reuses the record-field widgets).
        params.map(p => p.renderInput(defaults[p.name], opts.fieldContext)),

        // lm-form-actions: when the dialog scrolls (long edit forms on a phone),
        // this row sticks to the bottom of the scrollport so the submit is
        // always reachable without scrolling (style in liminal.css).
        [h.div, {class: 'lm-form-actions col-12'},
         [h.button, {type: 'submit', class: 'btn btn-primary'}, opts.submitLabel ?? 'Submit']],
    ];
}
