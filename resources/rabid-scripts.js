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

function showModalEditor() {
    getModalEditor().show();
}

function hideModalEditor() {
    getModalEditor().hide();
    getModalTitleElem().innerText = '';
    getModalBodyElem().innerHtml = '';
}

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
    getModalBodyElem().innerHtml = modalBodyHtmlText;
    showModalEditor();
} 

function reload(elementSelectorArray, eventName='reload', detail={}) {
    console.info('reloadElementsBySelector', elementSelectorArray);
    for(const s of elementSelectorArray) {
        console.info('- ', s, Array.from(document.querySelectorAll(s)));
    }
    const rootElems = Array.from(
        elementSelectorArray.flatMap(selector=>Array.from(document.querySelectorAll(selector))));
    console.info('  elems are', rootElems);
    reloadElements(rootElems, eventName, detail);
}

function reloadElements(rootElements, eventName='reload', detail={}) {
    for(const elem of removeContainedRoots(rootElements)) {
        console.info('reloading', elem);
        htmx.trigger(elem, eventName, detail);
    }
}

/**
 * Given a array of root elements, filters out those elements that are
 * contained within another of the elements.
 *
 * When we are reloading a set of elements, there is no point in reloading
 * elements that are contained within a parent that we are also reloading.
 */
function removeContainedRoots(roots) {
    // --- Build a Set of all roots.
    const rootSet = new Set(roots);
    
    // --- Filter out all roots that have an ancestor in the set of roots.
    return roots.filter(element => {
        // Check all ancestors of the current element
        let parent = element.parentElement;
        while (parent) {
            // If any ancestor is in the root set, this element is contained
            if (rootSet.has(parent)) {
                return false;
            }
            parent = parent.parentElement;
        }
        // No ancestors found in the root set, so keep this element
        return true;
    });
}

/**
 * Non-blocking replacement for window.alert (used by tx()).
 *
 * Native alert() blocks the browser event loop until the user dismisses it,
 * which stalls automation: neither puppeteer nor our own browser-test bridge can
 * make progress while an alert is up.  Instead we show the message as a Bootstrap
 * toast (non-blocking) and record it in window.current_alert while it is on
 * screen, so a test can read/assert on the message.  If the toast cannot be shown
 * (no Bootstrap, an exception, or it never actually becomes visible) we fall back
 * to the native alert so a message is never silently lost.
 */
let alertSeq = 0;
function showAlert(message) {
    const text = message == null ? '' : String(message);

    // Record immediately so a test can observe the message regardless of how it
    // is ultimately displayed (toast or fallback).
    window.current_alert = text;

    let bootstrapInst;
    try { bootstrapInst = getGlobalBoostrapInst(); } catch (_e) { bootstrapInst = undefined; }
    if (!bootstrapInst || !bootstrapInst.Toast) {
        fallbackAlert(text);
        return;
    }

    try {
        const container = getAlertContainer();
        const toastEl = document.createElement('div');
        toastEl.id = 'alert-toast-' + (++alertSeq);
        toastEl.className = 'toast align-items-center text-bg-danger border-0';
        toastEl.setAttribute('role', 'alert');
        toastEl.setAttribute('aria-live', 'assertive');
        toastEl.setAttribute('aria-atomic', 'true');
        toastEl.innerHTML =
            '<div class="d-flex">' +
              '<div class="toast-body"></div>' +
              '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>' +
            '</div>';
        // textContent (not innerHTML) so the message can't inject markup.
        toastEl.querySelector('.toast-body').textContent = text;
        container.appendChild(toastEl);

        const toast = bootstrapInst.Toast.getOrCreateInstance(toastEl, {autohide: false});

        // Clear the global only while *this* message is the one still on screen.
        toastEl.addEventListener('hidden.bs.toast', () => {
            toastEl.remove();
            if (window.current_alert === text) window.current_alert = null;
        });

        let shown = false;
        toastEl.addEventListener('shown.bs.toast', () => { shown = true; });
        toast.show();

        // Verify it actually displayed; if not (e.g. CSS missing), fall back to a
        // native alert.  We watch the shown event and the .show class rather than
        // offsetParent, which is always null for the position-fixed container.
        setTimeout(() => {
            if (!shown && !toastEl.classList.contains('show')) {
                try { toast.dispose(); } catch (_e) { /* ignore */ }
                toastEl.remove();
                fallbackAlert(text);
            }
        }, 400);
    } catch (_e) {
        fallbackAlert(text);
    }
}

// The fixed top-right container that holds alert toasts (created lazily so no
// template change is needed).
function getAlertContainer() {
    let c = document.getElementById('alert-toast-container');
    if (!c) {
        c = document.createElement('div');
        c.id = 'alert-toast-container';
        c.className = 'toast-container position-fixed top-0 end-0 p-3';
        c.style.zIndex = '2000';
        document.body.appendChild(c);
    }
    return c;
}

// Last-resort native alert: blocks until confirmed, so clear the global right
// after it returns (it only names a message while that message is on screen).
function fallbackAlert(text) {
    window.alert(text);
    if (window.current_alert === text) window.current_alert = null;
}

/**
 *
 */
async function tx(rpcExprSegments /*:ReadonlyArray<string>*/, ...args /*: any[]*/) /*: Promise<any>*/ {
    let response;
    try {
        response = await rpc(rpcExprSegments, ...args);
        console.info('GOT RPC2 response', response);
    } catch(e) {
        showAlert(e instanceof Error ? e.message : String(e));
        return;
    }
    
    if(typeof response.action !== 'string')
        throw new Error('Expected rpc response with an action');
    const action = response.action;

    
    switch(action) {
    case 'reload': {
        if(!Array.isArray(response.targets))
            throw new Error('Expected "reload" targets to be an array');
        hideModalEditor(); // XXX TODO BETTER FACTORING.
        reload(response.targets);
        break;
    }

    case 'alert': {
        const message = response.message ?? "Unknown error while processing request";
        showAlert(message);
        break;
    }

    default: {
        throw new Error(`Unexpected response action ${action}`);
    }
    }
}

/**
 *
 */
async function rpc(rpcExprSegments /*:ReadonlyArray<string>*/, ...args /*: any[]*/) /*: Promise<any>*/ {

    console.info('RPC', rpcExprSegments, args);

    const {rpcExpr, argsObj} = rpcUrl(rpcExprSegments, ...args);

    // --- Make the request with expr as the URL and the
    //     args json as the post body.
    //     XXX embedding the /rr/ prefix here is BAD
    const request = await new Request(rpcExpr, {
        method: "POST",
        body: JSON.stringify(argsObj)});

    const response = await fetch(request);

    console.info('RPC response', response);

    if(!response.ok) {
        let errorJson = undefined;
        try {
            errorJson = await response.json();
        } catch (_e) {
            console.info('failed to read error json');
        }
        // Log the full context for debugging, but throw a clean, user-facing
        // message: prefer the server's error text, stripped of a leading
        // "Error: " prefix (added by String(e) on the server), and fall back to
        // the HTTP status if there is no message.
        console.info(`RPC to ${rpcExpr} with args ${JSON.stringify(argsObj)} failed -`, errorJson);
        const serverMessage = errorJson && typeof errorJson.error === 'string' ? errorJson.error : undefined;
        const message = (serverMessage || `Request failed (${response.status})`).replace(/^Error:\s*/, '');
        throw new Error(message);
    }

    return await response.json();
}

// Once get this working - make a layer on top that interprets responses.

function rpcUrl(rpcExprSegments /*: ReadonlyArray<string>*/, ...args/*: any[]*/)/*: { rpcExpr: string, argsObj: Record<string, any>}*/ {

    console.info('RPC', rpcExprSegments, args);

    // --- Replace ${} in this tagged template expr with arg
    //     references, and hoist the args into an arg {}.
    let rpcExpr = rpcExprSegments[0];
    const argsObj /*: Record<string, any>*/ = {};
    args.forEach((argVal, i) => {
        const argName = `$arg${i}`;
        argsObj[argName] = argVal;
        rpcExpr += `(${argName})`;
        rpcExpr += rpcExprSegments[i+1];
    });

    return {rpcExpr, argsObj};
}

/**
 * Creates a json object including fields in the form
 *
 * @param {HTMLElement} form The form element to convert
 * @return {Object} The form data
 */
const getFormJSON = (form) => {
    const data = new FormData(form);
    return Array.from(data.keys()).reduce((result, key) => {
        result[key] = data.get(key);
        return result;
    }, {});
};

/**
 * Given an element, locate the shallowest contained button with the specified
 * class, and fire a click event against that button.
 *
 * We use this primarily to provide click-to-edit behaviour on elements that
 * already are using their 'hx-get' for refresh.  We also want to have an edit
 * button anyway, so this reduces redundancy.
 *
 * The shallowest part is for when we are rendering children that also have
 * edit buttons.
 */
function clickContainedButton(elem, buttonClass='edit') {
    // Find all buttons with the specified class within the element
    const buttons = elem.querySelectorAll(`.${buttonClass}`);
    
    // If no buttons found, return early
    if (!buttons || buttons.length === 0) {
        console.info(`No buttons with class '${buttonClass}' found within element`, elem);
        return;
    }
    
    // Find the shallowest button (the one with the shortest path to the element)
    let shallowestButton = buttons[0];
    let shortestDepth = getDepth(buttons[0], elem);
    
    for (let i = 1; i < buttons.length; i++) {
        const depth = getDepth(buttons[i], elem);
        if (depth < shortestDepth) {
            shortestDepth = depth;
            shallowestButton = buttons[i];
        }
    }
    
    // Click the shallowest button
    console.info(`Clicking ${buttonClass} button`, shallowestButton);
    shallowestButton.click();
}

/**
 * Helper function to calculate the depth of a node relative to an ancestor
 * @param {HTMLElement} node - The node to measure depth from
 * @param {HTMLElement} ancestor - The ancestor element to measure to
 * @return {number} The depth (number of parent traversals needed)
 */
function getDepth(node, ancestor) {
    let depth = 0;
    let current = node;
    
    while (current && current !== ancestor) {
        depth++;
        current = current.parentElement;
    }
    
    // If we didn't find the ancestor, return a very high number
    if (!current) {
        return Number.MAX_SAFE_INTEGER;
    }

    return depth;
}

/**
 * Enhance any not-yet-enhanced `select.ts-picker` elements into filterable
 * Tom Select pickers.
 *
 * We run this on initial load and after every htmx swap, because edit dialogs
 * (which is where foreign-key pickers live) are loaded into the modal by htmx
 * and so do not exist at page load.  Tom Select keeps the underlying <select>
 * in sync, so getFormJSON() still reads the selected id and the save path is
 * unchanged.  The `el.tomselect` guard makes re-running this idempotent.
 */
function initPickers(root) {
    if (typeof TomSelect === 'undefined') return;
    (root || document).querySelectorAll('select.ts-picker').forEach(el => {
        if (el.tomselect) return; // already enhanced
        const config = {
            allowEmptyOption: true,   // keep the blank option (to clear a nullable FK)
            dropdownParent: 'body',   // avoid the dropdown being clipped inside the modal
        };
        // Remote mode: if the select carries a data-load-url, fetch matching
        // options from the server as the user types (rather than shipping every
        // row).  The selected option is already inline, so the current value shows
        // immediately.  Server returns [{id, label}, ...].
        const loadUrl = el.dataset.loadUrl;
        if (loadUrl) {
            config.valueField = 'id';
            config.labelField = 'label';
            config.searchField = 'label';
            config.preload = true;         // load the initial option list when the picker initializes
            config.load = (query, callback) => {
                const url = loadUrl + (loadUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query);
                fetch(url, {credentials: 'same-origin'})
                    .then(r => r.json())
                    .then(rows => callback(Array.isArray(rows) ? rows : []))
                    .catch(() => callback());
            };
        }
        new TomSelect(el, config);
    });
}

document.addEventListener('DOMContentLoaded', () => initPickers(document));
// htmx:afterSwap fires after htmx replaces content (e.g. loading a form into the
// modal); re-scan so freshly-inserted pickers get enhanced.
document.body.addEventListener('htmx:afterSwap', () => initPickers(document));

