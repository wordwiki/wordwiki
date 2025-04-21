// deno-lint-ignore-file no-unused-vars, no-unreachable, no-explicit-any


function onContentLoaded() {

    const scannedPage = document.getElementById('scanned-page')
        ?? panic('failed to bind to page editor');

    initInfoBoxes();

    console.info('Done onContentLoaded');
}

// Having this be top level code is gross XXX FIX
addEventListener("DOMContentLoaded", _event=>onContentLoaded());

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function scannedPageMouseDown(event: MouseEvent) {

    const prevSelectedGroupId = getSelectedGroup()?.id;
    console.info('pageEditorMouseDown', new Date(), {
        prevSelectedGroupId: prevSelectedGroupId});

    // --- Adjust event target to be ancestor or self element of application interest.
    const target = adjustEventTarget(event.target);
    if(!target) return;
    const widgetKind = getWidgetKind(target);

    // --- If not clicking on a box, dismiss current popup
    if(widgetKind !== 'box') {
        dismissInfoBox();
        return;
    };

    // --- Select the box (which will also select the group)
    selectBox(target);
    const selectedGroupId = getSelectedGroup()?.id;

    // --- If no group selected, dismiss the info box and done.
    if(!selectedGroupId) {
        dismissInfoBox();
        return;
    }

    // --- If the selected group has changed, dismiss the current one.
    //     (these two operations will race if we do it for the same group)
    // if(prevSelectedGroupId !== selectedGroupId) {
    //     // --- If the info box is up, remove it.
    //     dismissInfoBox();
    // }

    // --- Popup the new info box (dismisses existing info box if there is one)
    console.info('SELECTED GROUP IS', selectedGroupId);
    popupInfoBox(selectedGroupId);
}

function scannedPageMouseMove(event: MouseEvent) {
    const target = adjustEventTarget(event.target);
    if(!target) return;
}

function scannedPageMouseUp(event: MouseEvent) {
    const target = adjustEventTarget(event.target);
    if(!target) return;
}

/**
 * Sometimes the element of interest to the application will be occluded
 * by a child decoration element.  Normally this is handled by registering
 * the event handler on the element of interest, and allowing the event
 * to bubble up to it.
 *
 * But we have chosen to forgo bubbling and handle all events at the svg page
 * level, so we need to deal with this occlusion problem some other way.
 *
 * This function is called at the beginning of every event handler to
 * adjust the event target to the nearest containing element of application
 * interest.
 */
function adjustEventTarget(target: EventTarget|null): Element|null {
    if(!(target instanceof Element))
        return null;
    switch(true) {
    case target?.tagName === 'rect' && target?.classList?.contains('frame'):
            return target.parentElement;
    default:
        return target;
    }
}

function boxMouseDown(event: MouseEvent, target: Element) {
    selectBox(target);
}


// ---------------------------------------------------------------------------------
// --- Bounding Box/Group operations -----------------------------------------------
// ---------------------------------------------------------------------------------

function getBoxId(box: Element): number {
    isBox(box) || panic('expected box');
    const idStr = box.id || panic('box is missing id');
    return safeParseInt(stripRequiredPrefix(idStr, 'bb_'));
}

function getGroupId(group: Element): number {
    isGroup(group) || panic('expected group');
    const idStr = group.id || panic('group is missing id');
    return safeParseInt(stripRequiredPrefix(idStr, 'bg_'));
}


// ---------------------------------------------------------------------------
// --- Selection Model -------------------------------------------------------
// ---------------------------------------------------------------------------

/*
 * The page editor selection model mirrors the data containment model.
 *
 * At any one time there can be an active boundingBoxGroup and active
 * boundingBox and an active grabber.
 *
 * Selecting a child element always also select the containing elements.
 * (for example, selecting a grabber will also select the containing
 * boundingBox and boundingBoxGroup)
 *
 * When a group is selected, we also move the <svg> element for that group
 * to the bottom of the list of groups.
 *
 * When a box is selected, we also move the <svg> element for that box to
 * the bottom of the list of boxes within the containing group.
 *
 * These two moves mean that the group and the box are last painted - thus
 * having the highest z-index - thus being non occluded by any other element
 * so that they can be interacted with.
 */

/**
 * Clear the group, box and grabber selections.
 */
function clearSelection() {
    // Note: there should never be more than one group/box/grabber active at a time,
    // we are doing querySelectorAll instead of querySelector because
    // paranoia is good policy for code running in the browser.
    Array.from(document.querySelectorAll('svg.group.active')).
        map(e=>e.classList.remove('active'));
    Array.from(document.querySelectorAll('svg.box.active')).
        map(e=>e.classList.remove('active'));
    Array.from(document.querySelectorAll('circle.grabber.active')).
        map(e=>e.classList.remove('active'));
}

/**
 * Select a group.
 */
function selectGroup(group: Element) {
    isGroup(group) || panic('select group called on non-group');
    if(group.classList.contains('ref'))
        throw new Error('A reference group should never be the selected group');
    clearSelection();
    group.classList.add('active');
    moveElementToEndOfParent(group);
    //updateMultiTaggingAnnotations(getScannedPageForElement(group));
}

/**
 * Select a box and the containing group.
 */
function selectBox(box: Element) {
    isBox(box) || panic('select box called on non-box');
    if(box.classList.contains('ref'))
        throw new Error('A reference box should never be the selected box');
    selectGroup(box.parentElement || panic());
    box.classList.add('active');
    moveElementToEndOfParent(box);
    //updateMultiTaggingAnnotations(getScannedPageForElement(box));
}

// const idCollator = Intl.Collator('en');

// function selectBoxOrRotateSelectionIfAlreadySelectedMultiselect(box: Element) {
//     const group = getGroupForBox(box);

//     // --- If the group this box is in is not already selected, do a normal selection
//     if(getSelectedGroup() !== group) {
//         selectBox(box);
//         return;
//     }

//     // --- If we are doing a second select on a selected multi-select box,
//     //     rotate to the next group that selected that box
//     if(isMultiSelectedBox(box)) {
//         const page = getScannedPageForElement(box);
//         const boxesInGroup =
//             Array.from(findBoxesWithSharedLocation(page).boxesWithSharedLocation.values())
//                 .filter(v=>v.some(b=>b===box))[0]
//             ?.toSorted((a,b)=>idCollator.compare(a.id, b.id));

//         console.info('BOXES IN GROUP', boxesInGroup);
//         const currentBoxIndexInSelectionGroup = boxesInGroup.indexOf(box);
//         if(currentBoxIndexInSelectionGroup === -1)
//             throw new Error('unable to find expected box in multi select group');
//         const nextBoxToSelect = boxesInGroup[
//             (currentBoxIndexInSelectionGroup+1) % boxesInGroup.length];

//         console.info('Selecting next box in multi select group', nextBoxToSelect);
//         selectBox(nextBoxToSelect);
//     }
// }

/**
 * Select a grabber and the containing box and group.
 */
function selectBoxGrabber(grabber: Element) {
    isGrabber(grabber) || panic('select grabber called on non-grabber');
    selectBox(grabber.parentElement || panic());
    grabber.classList.add('active');
}

/*
 * Prefer using these getter/is functions over doing
 * direct querySelectors in the rest of this editor - this
 * will reduce the blast radius if we need to make
 * structural changes to the markup.
 */
function getSelectedGroup(): Element|null {
    const group = document.querySelector('svg.group.active');
    if(group && group.classList.contains('ref'))
        throw new Error('A reference group should never be the selected group');
    return group;
}

function getBoxesForGroup(group: Element) {
    isGroup(group) || panic();
    return Array.from(group.querySelectorAll('svg.box'));
}

function getGroupForBox(box: Element) {
    return box.parentElement;
}

function getSelectedBox() {
    return document.querySelector('svg.box.active');
}

function getSelectedGrabber() {
    return document.querySelector('circle.grabber.active');
}

function isGroup(elem: Element): boolean {
    return elem.classList.contains('group');
}

function isBox(elem: Element): boolean {
    return elem.classList.contains('box');
}

function isMultiSelectedBox(elem: Element): boolean {
    return isBox(elem) && elem.classList.contains('multi');
}

function isRef(elem: Element): boolean {
    return elem.classList.contains('ref');
}

function isRefBox(elem: Element): boolean {
    return isBox(elem) && isRef(elem);
}

function isGrabber(elem: Element): boolean {
    return elem.classList.contains('grabber');
}

function getWidgetKind(elem: Element) {
    const classList = elem.classList;
    const isInRefLayer = isRef(elem);
    switch(true) {
    case classList.contains('group'): return isInRefLayer ? 'ref-group' : 'group';
    case classList.contains('box'): return isInRefLayer ? 'ref-box' : 'box';
    case classList.contains('grabber'): return 'grabber';
    default: return undefined;
    }
}

/**
 * This + our use of id's is what would prevent us form having two taggers
 * active on a page at once - so we factor it to make it easier to fix that.
 *
 * (to fix this, we will need to scope all our box, box-group and scanned-page
 * ids)
 *
 * I no longer think this is worth it (supporting multiple editors per
 * page) - so I will be stripping this rather than pushing the support
 * the rest of the way through. XXX
 */
function getScannedPageForElement(e: Element) {
    return getScannedPage();
}

function getScannedPage() {
    return document.getElementById('scanned-page')
        ?? panic('unable to find scanned page');
}

function getContainingLayerId(e: Element): number {
    return getIntAttribute(getScannedPageForElement(e), 'data-layer-id');
}

function getContainingPageId(e: Element): number {
    return getIntAttribute(getScannedPageForElement(e), 'data-page-id');
}

function getContainingScaleFactor(e: Element): number {
    return getIntAttribute(getScannedPageForElement(e), 'data-scale-factor');
}

function getLockedBoundingGroupId(): string|null {
    return getScannedPage().getAttribute('data-locked-bounding-group-id');
}

function getHighlightRefBoundingBoxId(): string|null {
    return getScannedPage().getAttribute('data-highlight-ref-bounding-box-id');
}

// -----------------------------------------------------------------------
// --- Info Boxes --------------------------------------------------------
// -----------------------------------------------------------------------

let infoBoxesById: Record<string, any> = {};
let currentInfoBoxId: string|undefined = undefined;
let currentInfoBox: any = undefined;

function initInfoBoxes() {
    const bootstrap = getGlobalBoostrapInst();
    const groups = [...document.querySelectorAll('.group:not(.ref)')];
    infoBoxesById = new Map(groups.map(group => {
        const popover = new bootstrap.Popover(group, {
            container:'body',
            //toggle:'popover',
            trigger: 'manual',
            placement:'bottom',
            html: true,
            title: `<button onclick='dismissInfoBox()'>Close</button>`,
            content: infoBoxesById[group.id] ?? undefined,
            sanitizeFn(content: string) { return content; },
        });
        //popover.toggleEnabled(false);
        return [group.id, popover];
    }));
}

function dismissInfoBox() {
    if(currentInfoBox != undefined) {
        console.info('  dismissing info box ', currentInfoBox?.id);
        currentInfoBox.hide();
        currentInfoBox = undefined;
        currentInfoBoxId = undefined;
    }
}

function popupInfoBox(id: string) {
    console.info('popup info box', {id, currentInfoBoxId, currentInfoBox});
    if(currentInfoBoxId === id) {
        console.info('  already has correct id popped up');
        return;
    }
    if(currentInfoBox !== undefined) {
        dismissInfoBox();
    }
    const infoBox = infoBoxesById.get(id);
    if(infoBox === undefined) {
        const error = `Error: failed to find info box for id ${id}`;
        alert(error);
        throw new Error(error);
    }
    console.info('  showing info box ', id);
    infoBox.show();
    currentInfoBox = infoBox;
    currentInfoBoxId = id;
}

/**
 * This viewer expects to run in an environment where the bootstrap JS code
 * has been loaded as a script.  This function packages accessing the bootstrap
 * global inst via the browser window object.
 */
function getGlobalBoostrapInst() {
    return (window as any)?.bootstrap
        ?? panic("can't find global bootstrap inst");
}

// -----------------------------------------------------------------------
// --- Misc Utils --------------------------------------------------------
// -----------------------------------------------------------------------

function safeParseInt(v: string) {
    const r = Number.parseInt(v);
    if(Number.isNaN(r))
        throw new Error(`expected integer, got ${v}`);
    return r;
}

function getIntAttribute(elem: Element, name: string) {
    const attrText = elem.getAttribute(name);
    if(!attrText) // missing attr is represented as "" or null as per the spec
        throw new Error(`missing required integer attribute ${name} on elem ${elem}`);
    const attrVal = Number.parseInt(attrText);
    if(Number.isNaN(attrVal))
        throw new Error(`expected integer valued attribute ${name} on elem ${elem} - got ${String(attrVal)}`);
    return attrVal;
}

/**
 * Moves an element to be the last child of the containing element.
 *
 * Does nothing if already last element (so cheap to repeatedly call).
 *
 * This is used for z-order reasons in our svg based editor (ie. we
 * want the selected item to have the highest z-order so that it is
 * fully interactive)
 */
function moveElementToEndOfParent(elem: Element) {
    // --- If we are already last element in parent - nothing to do.
    if(!elem.nextSibling)
        return;

    // --- If we have no parent - nothing to do.
    const parent = elem.parentElement;
    if(!parent)
        return;

    // --- Relocate element to end of parent element
    //     (note that appendChild is defined to remove the node if it already
    //     exists in the document - so this is a move operation)
    parent.appendChild(elem);
}

/**
 * This is used in conjunction with the ?? operator to deal with unexpected
 * nulls.
 *
 * For example:
 *
 * document.getElementById('scanned-page') ?? panic('unable to find scanned page');
 */
function panic(message: string = 'internal error'): never {
    throw new Error('panic: '+message);
}

function stripRequiredPrefix (s: string, prefix: string): string {
    if (s.startsWith (prefix))
        return s.substring (prefix.length);
    else
        throw new Error(`expected string "${s}" to have prefix "${prefix}"`);
}

/**
 * We set some attrs at high frequency, and often we are setting them to
 * the same value.  The browser DOM code probably recognizes this and does
 * not register it as a change - but just in case, this function can be
 * used that avoid doing the set if the value (after conversion to string
 * as per DOM convention) has not changed.
 */
function setAttributeIfChanged(elem: Element, attrName: string, newValue: string) {
    const prevValueString = elem.getAttribute(attrName);
    const newValueString = newValue == undefined ? '' : String(newValue);
    if(newValueString !== prevValueString)
        elem.setAttribute(attrName, newValueString);
}

// TODO: use utils.rpc once we have switched how this page is loaded
//       (we can't import at the moment) XXX TODO XXX TODO
/**
 *
 */
async function rpc(rpcExprSegments: ReadonlyArray<string>, ...args: any[]) {

    console.info('RPC', rpcExprSegments, args);

    // --- Replace ${} in this tagged template expr with arg
    //     references, and hoist the args into an arg {}.
    let rpcExpr = rpcExprSegments[0];
    const argsObj: Record<string, any> = {};
    args.forEach((argVal, i) => {
        const argName = `$arg${i}`;
        argsObj[argName] = argVal;
        rpcExpr += `(${argName})`;
        rpcExpr += rpcExprSegments[i+1];
    });

    // --- Make the request with expr as the URL and the
    //     args json as the post body.
    const request = await new Request('/ww/'+rpcExpr, {
        method: "POST",
        body: JSON.stringify(argsObj)});

    const response = await fetch(request);

    console.info('RPC response', response);

    if(!response.ok) {
        let errorJson = undefined;
        try {
            errorJson = await response.json();
        } catch (e) {
            console.info('failed to read error json');
        }
        throw new Error(`RPC to ${rpcExpr} with args ${JSON.stringify(argsObj)} failed - ${JSON.stringify(errorJson)}`);
    }

    return await response.json();
}

function randomInt(max: number): number {
    return Math.floor(Math.random() * max);
}
