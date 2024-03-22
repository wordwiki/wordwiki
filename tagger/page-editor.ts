// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function pageEditorMouseDown(event: MouseEvent) {

    // --- Adjust event target to be ancestor or self element of application interest.
    const target = adjustEventTarget(event.target);
    if(!target) return;
    const widgetKind = getWidgetKind(target);

    // --- If we have an active drag operation - abort it
    dragTxAbort();

    switch(true) {
    case event.shiftKey: {
        // --- Holding down shift allows drawing new boxes even
        //     if the click action would normally be interpreted
        //     by another widget in that space.
        newBoxMouseDown(event, target, event.ctrlKey);
        break;
    }

    default: {
        // --- Dispatch the click based on widget kind
        switch(widgetKind) {
        case 'box': {
            if(event.ctrlKey) {
                // --- Ctrl click on a box adds the clicked on box to the currently selected group
                const currentlySelectedGroup = getSelectedGroup();
                if(currentlySelectedGroup) {
                    addBoxToGroup(target, currentlySelectedGroup);
                }
            } else {
                // --- Normal click on a box begins a new selection with just
                //     this box (and the containing group in the group level selection).
                selectBox(target);
            }
            break;
        };
        case 'ref-box': {
            const addToCurrentGroup = event.ctrlKey;
            if(addToCurrentGroup) {
                const currentlySelectedGroup = getSelectedGroup();
                if(currentlySelectedGroup) {
                    migrateRefBoxToExistingGroup(target, currentlySelectedGroup);
                    selectBox(target);
                }
            } else {
                migrateRefBoxToNewGroup(target);
                selectBox(target);
            }
            break;
        }
        case 'grabber': grabberMouseDown(event, target); break;
        default: newBoxMouseDown(event, target, event.ctrlKey); break;
        }
        break;
    }}
}

function pageEditorMouseMove(event: MouseEvent) {
    const target = adjustEventTarget(event.target);
    if(!target) return;
    dragTxOnMouseMove(event, target);
}

function pageEditorMouseUp(event: MouseEvent) {
    const target = adjustEventTarget(event.target);
    if(!target) return;
    dragTxCommit(event, target);
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

/**
 * Handles the dragging operation of a box grabber.
 *
 * Registers a dragTx, and subsequent mouse operations are routed to
 * the dragTx until the operation is completed or aborted.
 *
 * The extraAbortAction parameter is used when creating new boxes
 * to remove the box if it has not yet reached a viable size.
 */
function grabberMouseDown(event: MouseEvent, grabber: Element, extraAbortAction:()=>void|undefined=(()=>void 0)) {

    // --- Store the drag start mouse X and Y
    const dragStartClientX = event.clientX;
    const dragStartClientY = event.clientY;
    
    // --- Select the grabber (and containing box and group).
    selectBoxGrabber(grabber);

    // --- Find the box that contains this grabber.
    const box = getSelectedBox() ?? panic('failed to get box for grabber');
    const group = getSelectedGroup() ?? panic('failed to get group for grabber');

    // --- Store the initial coordinates of the box in case we need to abort.
    const initialX = getIntAttribute(box, 'x');
    const initialY = getIntAttribute(box, 'y');
    const initialWidth = getIntAttribute(box, 'width');
    const initialHeight = getIntAttribute(box, 'height');

    // --- Figure out which of the four grabbers this is
    const isTop = grabber.getAttribute('cy') === '0';
    const isLeft = grabber.getAttribute('cx') === '0';

    const minWidth = 20;
    const minHeight = 20;

    // --- Add 'drag-in-progress' class to #annotatedPage to disable some
    //     hover behaviour that would be annoying during a drag.
    document.getElementById('annotatedPage')?.classList.add('drag-in-progress');
    
    // --- Register the drag tx - handles mouseMove events until the mouseDown (or abort)
    dragTxBegin({
        onMouseMove(event: MouseEvent, target: Element) {
            const deltaX = event.clientX-dragStartClientX;
            const deltaY = event.clientY-dragStartClientY;
            switch(true) {
            case isTop && isLeft: {  // top left grabber
                const clampedDeltaX = Math.min(deltaX, initialWidth-minWidth);
                const clampedDeltaY = Math.min(deltaY, initialHeight-minHeight);
                box.setAttribute('x', String(initialX + clampedDeltaX));
                box.setAttribute('y', String(initialY + clampedDeltaY));
                box.setAttribute('width', String(initialWidth - clampedDeltaX));
                box.setAttribute('height', String(initialHeight - clampedDeltaY));
                break;
            }
            case isTop && !isLeft: { // top right grabber
                const clampedDeltaY = Math.min(deltaY, initialHeight-minHeight);
                box.setAttribute('y', String(initialY + clampedDeltaY));
                box.setAttribute('width', String(Math.max(initialWidth + deltaX, minWidth)));
                box.setAttribute('height', String(initialHeight - clampedDeltaY));
                break;
            }
            case !isTop && isLeft: { // bottom left grabber
                const clampedDeltaX = Math.min(deltaX, initialWidth-minWidth);
                const clampedDeltaY = Math.min(deltaY, initialHeight-minHeight);
                box.setAttribute('x', String(initialX + clampedDeltaX));
                box.setAttribute('width', String(Math.max(initialWidth - deltaX, minWidth)));
                box.setAttribute('height', String(Math.max(initialHeight + deltaY, minHeight)));
                break;
            }
            case !isTop && !isLeft: { // bottom right grabber
                box.setAttribute('width', String(Math.max(initialWidth + deltaX, minWidth)));
                box.setAttribute('height', String(Math.max(initialHeight + deltaY, minHeight)));
                break;
            }
            }
            updateGroupDimensions(group);
        },
        onCommit(event: MouseEvent, target: Element) {
            // --- If we are about to commit an invalid change, abort instead
            //     (in practice, this only occurs for new box draws, where they
            //     go though a larval stage where they are too small to be a
            //     valid box - for existing boxes, we don't allow the UI to shrink
            //     below viable)
            if(getIntAttribute(box, 'width') < minWidth ||
               getIntAttribute(box, 'height') < minHeight) {
                this.onAbort();
                return;
            }

            document.getElementById('annotatedPage')?.classList.remove('drag-in-progress');

            const bounding_box_id = (box.id && safeParseInt(stripRequiredPrefix(box.id, 'bb_'))) || undefined;
            const x = getIntAttribute(box, 'x');
            const y = getIntAttribute(box, 'y');
            const w = getIntAttribute(box, 'width');
            const h = getIntAttribute(box, 'height');
            if(!bounding_box_id) {
                // fetch(`/newBoundingBoxInNewGroup({x:${x},y:${y},w:${w},h:${h}})`, {options:'POST'}).then(
                //     response=>{ console.info('added new box', response); },
                //     error=>{ this.onAbort(); alert('Failed to add new box'); });
                rpc`newBoundingBoxInNewGroup({x:${x},y:${y},w:${w},h:${h}})`.then(
                    response=>{ console.info('added new box', response); },
                    error=>{ this.onAbort(); alert('Failed to add new box'); });
            } else {
                (async ()=>{
                    try {
                        await rpc`updateBoundingBoxShape(${bounding_box_id}, {x:${x},y:${y},w:${w},h:${h}})`;
                    } catch (e) {
                        alert(`Failed to resize bounding box ${e}`);
                        this.onAbort();
                    }
                })();
                // fetch(`/updateBoundingBoxShape(${bounding_box_id}, {x:${x},y:${y},w:${w},h:${h}})`, {options:'POST'}).then(
                //     successValue=>{
                //         console.info('SUCCESS', successValue);
                //     },
                //     failValue=>{
                //         this.onAbort(); alert('Failed to resize bounding box');
                //     });
            }
        },
        onAbort() {
            document.getElementById('annotatedPage')?.classList.remove('drag-in-progress');
            box.setAttribute('x', String(initialX));
            box.setAttribute('y', String(initialY));
            box.setAttribute('width', String(initialWidth));
            box.setAttribute('height', String(initialHeight));
            updateGroupDimensions(group);

            // Used for new boxes that have not yet reached viable dimensions.
            if(extraAbortAction)
                extraAbortAction();
        }
    });
}

/**
 *
 */
function newBoxMouseDown(event:MouseEvent, target:Element, addToCurrentGroup:boolean) {
    
    const scannedPageSvg = document.getElementById('scanned-page') ??
          panic('unable to find scanned page element');
    const scannedPageSvgLocation = scannedPageSvg.getBoundingClientRect();
    
    // --- Compute initial size and position for box
    const x = event.clientX - scannedPageSvgLocation.x;
    const y = event.clientY - scannedPageSvgLocation.y;
    const width = 0;
    const height = 0;

    // --- Create the boundingBox
    const boundingBox = createNewBoundingBox(x, y, width, height);
    const lowerLeftGrabber = boundingBox.querySelector('circle.grabber[cx="100%"][cy="100%"]');
    if(!lowerLeftGrabber)
        throw new Error('failed to find lower left grabber in newly created bounding box');

    const selectedGroup = getSelectedGroup();
    if(addToCurrentGroup && selectedGroup) {
        // --- Add our new box to the active group
        selectedGroup.appendChild(boundingBox);

        // --- Start a resize on our new box, dropping the box on abort
        grabberMouseDown(event, lowerLeftGrabber, ()=>boundingBox.remove());

    } else {
        // --- Create the parent bounding group
        const boundingGroup = createNewBoundingGroup(chooseNewGroupColor(x, y));

        // --- Add our new box as the initial box in our new group
        boundingGroup.appendChild(boundingBox);

        // --- Add the new group to the document
        scannedPageSvg.appendChild(boundingGroup);

        // --- Resize the bounding group frame
        updateGroupDimensions(boundingGroup);

        // --- Start a resize on our new box, dropping the whole group on abort
        grabberMouseDown(event, lowerLeftGrabber, ()=>boundingGroup.remove());
    }    
}

// ---------------------------------------------------------------------------------
// --- Bounding Box/Group operations -----------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * Creates a new bounding group (not yet added to DOM).
 */
function createNewBoundingGroup(color?:string): SVGSVGElement {
    const boundingGroup = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if(color)
        boundingGroup.setAttribute('stroke', color);
    boundingGroup.classList.add('group');

    // --- Create bounding group frame
    const groupFrame = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    groupFrame.classList.add('group-frame');
    groupFrame.setAttribute('x', '0')
    groupFrame.setAttribute('y', '0')
    groupFrame.setAttribute('width', '0');
    groupFrame.setAttribute('height', '0');
    boundingGroup.appendChild(groupFrame);

    return boundingGroup;
}

/**
 * Creates a new bounding box (not yet added to the DOM).
 */
function createNewBoundingBox(x:number, y:number, width:number, height:number): SVGSVGElement {
    const grabberRadius = 12;

    // --- Create the boundingBox
    const boundingBox = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    boundingBox.classList.add('box');
    boundingBox.setAttribute('x', String(x))
    boundingBox.setAttribute('y', String(y))
    boundingBox.setAttribute('width', String(width))
    boundingBox.setAttribute('height', String(height))
    
    // --- Add the frame rect
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frame.classList.add('frame');
    frame.setAttribute('x', '0')
    frame.setAttribute('y', '0')
    frame.setAttribute('width', '100%')
    frame.setAttribute('height', '100%')
    boundingBox.appendChild(frame);
    
    // --- Add the four corner grabber circles
    const grabbers = [];
    for(const cx of ['0', '100%']) {
        for(const cy of ['0', '100%']) {
            const grabber = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            grabber.classList.add('grabber');
            grabber.setAttribute('cx', cx)
            grabber.setAttribute('cy', cy)
            grabber.setAttribute('r', String(grabberRadius))
            boundingBox.appendChild(grabber);
        }
    }

    return boundingBox;
}    

/**
 *
 */
function migrateRefBoxToExistingGroup(box: Element, group: Element) {
    isRefBox(box) || panic('expected ref box');
    isGroup(group) || panic('expected group');

    box.classList.remove('ref');
    group.appendChild(box);
    // XXX TODO do RPC, update ID
}

/**
 *
 */
function migrateRefBoxToNewGroup(box: Element) {
    isRefBox(box) || panic('expected ref box');

    box.classList.remove('ref');
    
    const newGroup = createNewBoundingGroup(chooseNewGroupColor(getIntAttribute(box, 'x'),
                                                                getIntAttribute(box, 'y')));
    newGroup.appendChild(box);
    updateGroupDimensions(newGroup);

    const scannedPageSvg = document.getElementById('scanned-page') ??
          panic('unable to find scanned page element');

    scannedPageSvg.appendChild(newGroup);

    // (async ()=>{
    //     try {
    //         const {new_group_Id, new_box_id} = await rpc`copyRefBoxToNewGroup(${getIntAttribute(box, 'id')})`;
    //         newGroupId.id = newGroupId;
    //         box.id = newBoxId;
    //     } catch (e) {
    //         // XXX rollback logic here.
    //         // XXX we also have to worry about race conditions with a subseqent resize ???
    //         alert(`Failed create new box ${e}`);
    //     }
    // })();
    
    // XXX TODO RPC, update ID
}


/**
 * If there is a currently selected group, add the specified
 * box to that group.
 *
 * TODO more work once we get layers working.
 */
function addBoxToGroup(box: Element, group: Element) {
    isBox(box) && isGroup(group) || panic();
    const fromGroup = box.parentElement || panic();
    isGroup(fromGroup) || panic();
    
    group.appendChild(box);
    updateGroupDimensions(group);
    
    if(getBoxesForGroup(fromGroup).length === 0) {
        fromGroup.remove();
    } else {
        updateGroupDimensions(fromGroup);
    }
            
    // TODO: update db
    // TODO: deal with empty source gropu
    // TODO: resize source group if still non-empty
    // TODO: deal with layers (ie. maybe copy etc).
    
}


/**
 * Updates a groups dimensions to contain all of the groups boxes +
 * a margin.
 *
 * This should be called after altering any contained bounding boxes.
 */
function updateGroupDimensions(group: Element) {
    isGroup(group) || panic();

    // --- Get page width and height
    const pageImage = document.getElementById('scanned-page') ?? panic();
    const pageWidth = getIntAttribute(pageImage, 'width');
    const pageHeight = getIntAttribute(pageImage, 'height');
    
    // --- Query the dimensions for all boxes in this group.
    const boxDimensions = getBoxesForGroup(group).
          map(box=>({x: getIntAttribute(box, 'x'),
                     y: getIntAttribute(box, 'y'),
                     w: getIntAttribute(box, 'width'),
                     h: getIntAttribute(box, 'height')}));
    
    // --- Group frame contains all boxes + a margin.
    const groupMargin = 10;
    const groupX = Math.max(Math.min(...boxDimensions.map(b=>b.x)) - groupMargin, 0);
    const groupY = Math.max(Math.min(...boxDimensions.map(b=>b.y)) - groupMargin, 0);
    const groupLeft = Math.min(Math.max(...boxDimensions.map(b=>b.x+b.w)) + groupMargin, pageWidth);
    const groupBottom = Math.min(Math.max(...boxDimensions.map(b=>b.y+b.h)) + groupMargin, pageHeight);

    // --- Update group frame dimensions
    const groupFrame = group.querySelector('rect.group-frame') ??
          panic('could not find group frame');
    setAttributeIfChanged(groupFrame, 'x', String(groupX));
    setAttributeIfChanged(groupFrame, 'y', String(groupY));
    setAttributeIfChanged(groupFrame, 'width', String(groupLeft-groupX));
    setAttributeIfChanged(groupFrame, 'height', String(groupBottom-groupY));
}

const groupColors = [
    'crimson', 'palevioletred', 'darkorange', 'gold', 'darkkhaki',
    'seagreen', 'steelblue', 'dodgerblue', 'peru', 'tan', 'rebeccapurple'];

/**
 *
 */
function chooseNewGroupColor(x: number, y: number) {
    return groupColors[randomInt(groupColors.length)];
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
    clearSelection();
    group.classList.add('active');
    moveElementToEndOfParent(group);
}

/**
 * Select a box and the containing group.
 */
function selectBox(box: Element) {
    isBox(box) || panic('select box called on non-box');
    selectGroup(box.parentElement || panic());
    box.classList.add('active');
    moveElementToEndOfParent(box);
}

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
function getSelectedGroup() {
    return document.querySelector('svg.group.active');
}

function getBoxesForGroup(group: Element) {
    isGroup(group) || panic();
    return Array.from(group.querySelectorAll('svg.box'));
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

// ------------------------------------------------------------------------
// --- Bookkeeping for an active drag operation ---------------------------
// ------------------------------------------------------------------------

interface DragTx {
    onMouseMove: (event: MouseEvent, target: Element)=>void;
    onCommit: (event: MouseEvent, target: Element)=>void;
    onAbort: ()=>void;
};

let activeDragTx: DragTx|undefined = undefined;

function dragTxValidate(dragTx: DragTx) {
    if(!(dragTx.onMouseMove instanceof Function) ||
       !(dragTx.onCommit instanceof Function) ||
       !(dragTx.onAbort instanceof Function))
        throw new Error('malformed dragTx');
}

function dragTxBegin(dragTx: DragTx) {
    dragTxAbort();
    dragTxValidate(dragTx);
    activeDragTx = dragTx;
}

function dragTxOnMouseMove(event: MouseEvent, target: Element) {
    activeDragTx?.onMouseMove(event, target);
}

function dragTxCommit(event: MouseEvent, target: Element) {
    activeDragTx?.onCommit(event, target);
    activeDragTx = undefined;
}

function dragTxAbort() {
    activeDragTx?.onAbort();
    activeDragTx = undefined;
}

// -----------------------------------------------------------------------
// --- Misc --------------------------------------------------------------
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
    const request = await new Request('/'+rpcExpr, {
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
