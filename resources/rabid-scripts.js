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
 *
 */
async function tx(rpcExprSegments /*:ReadonlyArray<string>*/, ...args /*: any[]*/) /*: Promise<any>*/ {
    let response;
    try {
        response = await rpc(rpcExprSegments, ...args);
        console.info('GOT RPC2 response', response);
    } catch(e) {
        alert(String(e));
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
        alert(message);
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
        throw new Error(`RPC to ${rpcExpr} with args ${JSON.stringify(argsObj)} failed - ${JSON.stringify(errorJson)}`);
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

