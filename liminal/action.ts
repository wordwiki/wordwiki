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
 */
export function actionButton(label: string, mode: ActionMode,
                             btnClass: string = 'btn btn-primary'): Markup {
    switch(mode.kind) {
        case 'immediate':
            return [h.button, {type:'button', class:btnClass,
                               onclick:`tx\`${mode.expr}\``}, label];
        case 'confirm':
            return [h.button, {type:'button', class:btnClass,
                               onclick:`if(confirm(${JSON.stringify(mode.message)})) tx\`${mode.expr}\``}, label];
        case 'modal':
            // Same wiring as table.editButtonProps, minus the record-edit 'edit'
            // class: load the generated dialog into the modal body, then show it.
            return [h.button, {type:'button', class:btnClass,
                               'hx-get': mode.dialogUrl,
                               'hx-target': '#modalEditorBody',
                               'hx-swap': 'innerHTML',
                               'hx-on::after-request': 'showModalEditor()'}, label];
    }
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

        opts.title !== undefined
            ? [h.h2, {class: 'h5 col-12'}, opts.title]
            : undefined,

        // Hidden (non-user-editable) parameters supplied by the dialog generator.
        // Value is passed raw: the markup renderer coerces numbers to strings and
        // omits the attribute entirely for null/undefined (which then submits as
        // ""), matching the before-value wire format the record editor relies on.
        Object.entries(opts.hidden ?? {}).map(([name, value]) =>
            [h.input, {type: 'hidden', name, value}]),

        // One input per visible parameter (reuses the record-field widgets).
        params.map(p => p.renderInput(defaults[p.name], opts.fieldContext)),

        [h.div, {class: 'col-12'},
         [h.button, {type: 'submit', class: 'btn btn-primary'}, opts.submitLabel ?? 'Submit']],
    ];
}
