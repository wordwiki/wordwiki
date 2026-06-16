// deno-lint-ignore-file no-explicit-any
/**
 * Shared htmx page configuration for liminal-based apps (rabid, wordwiki, and
 * any future liminal project).  Centralised here so the subtle bits - above all
 * the back-button / history behaviour - are fixed in ONE place rather than
 * copied (and drifting) per app.
 */
import { h } from './markup.ts';

// The htmx version every liminal app loads, in one place to bump.
export const HTMX_VERSION = '2.0.4';
export const htmxScriptSrc = `https://unpkg.com/htmx.org@${HTMX_VERSION}`;

// htmx global config, rendered into <meta name="htmx-config"> in <head>.
//
//  - scrollIntoViewOnBoost:false - a boosted nav swaps #content (not <body>),
//    so htmx's default would scroll #content's top to the viewport top, hiding
//    the navbar above it.  Off => a boosted nav leaves the navbar in view.
//
//  - historyCacheSize:0 + refreshOnHistoryMiss:true - THE BACK-BUTTON FIX.
//    htmx's default Back restores a saved DOM snapshot, which (a) shows stale
//    data on live pages and (b) resurrects widget state that Bootstrap no
//    longer tracks - the navbar ☰ dropdowns / pulldown menus came back
//    inoperable, and other JS hookups were dead.  With the snapshot cache OFF
//    and refreshOnHistoryMiss ON, Back is a real page load: always fresh, so
//    every script and Bootstrap component re-initialises cleanly.
export const htmxConfig = {
    scrollIntoViewOnBoost: false,
    historyCacheSize: 0,
    refreshOnHistoryMiss: true,
};

// The <meta name="htmx-config"> node - put this in every liminal page's <head>.
export function htmxConfigMeta(): any {
    return [h.meta, {name: 'htmx-config', content: JSON.stringify(htmxConfig)}];
}

// The htmx <script> tag - load it in <head> before app scripts.
export function htmxScriptTag(): any {
    return [h.script, {src: htmxScriptSrc}];
}
