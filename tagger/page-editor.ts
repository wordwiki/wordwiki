// deno-lint-ignore-file no-unused-vars, no-unreachable, no-explicit-any

function onContentLoaded() {

    const lockedBoundingGroupId = getLockedBoundingGroupId();
    if(lockedBoundingGroupId) {
        selectGroup(document.getElementById(lockedBoundingGroupId)
            ?? panic('unable to find locked bounding group'));
    }

    const scannedPage = document.getElementById('scanned-page')
        ?? panic('failed to bind to page editor');

    updateDerivedDom(scannedPage);

    // XXX we should not be doing this here - but we don't have a user
    //     session yet, and setting the cookie on the server would be
    //     more work - remove remove REMOVE
    document.cookie = `page-for-doc-${scannedPage.getAttribute('data-document-id')}=${scannedPage.getAttribute('data-page-number')}`;

    console.info('Done onContentLoaded');
}

// Having this be top level code is gross XXX FIX
addEventListener("DOMContentLoaded", _event=>onContentLoaded());

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function pageEditorMouseDown(event: MouseEvent) {

    // --- We are building exactly one group when in single group edit mode.
    const lockedBoundingGroupId = getLockedBoundingGroupId();
    const selectedGroup = getSelectedGroup();
    const singleGroupMode =
        (lockedBoundingGroupId != null && selectedGroup != null &&
            selectedGroup.id === lockedBoundingGroupId);

    console.info('pageEditorMouseDown', {
        lockedBoundingGroupId,
        selectedGroup: selectedGroup && selectedGroup.id,
        singleGroupMode});

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
        // ZZZ - ctrlKey adds to current box
        newBoxMouseDown(event, target, event.ctrlKey || singleGroupMode);
        break;
    }

    default: {
        // --- Dispatch the click based on widget kind
        switch(widgetKind) {
        case 'box': {
            if(event.ctrlKey || singleGroupMode) {
                // --- Ctrl click on a box adds the clicked on box to the
                //     currently selected group
                // ZZZ always have a currently selected group
                const currentlySelectedGroup = getSelectedGroup();
                if(currentlySelectedGroup) {
                    // This changes based on whether in group already - removes if is
                    // in, and otherwise does copyBoxToGroup
                    // if client gets out of sync with server, this will be a bit wonky.
                    isBox(target) ?? panic('expected box');
                    //const targetGroup = target.parentElement ?? panic('box has no parent');
                    //isGroup(targetGroup) ?? panic('expected parent of box to be group');
                    // Issue: the box that got the click may be an alias for
                    //        our own box (because of multi tagging).
                    // - so what we really want to know is if we have a box in our group
                    //   that has the exact same location - in which case we will
                    //   proceed as if we are operating on that box.

                    const updatedTarget:Element = Array.from(currentlySelectedGroup.querySelectorAll('svg.box:not(.ref)'))
                        .filter(groupBox=>
                            getIntAttribute(groupBox, 'x')===getIntAttribute(target, 'x') &&
                            getIntAttribute(groupBox, 'y')===getIntAttribute(target, 'y') &&
                            getIntAttribute(groupBox, 'width')===getIntAttribute(target, 'width') &&
                            getIntAttribute(groupBox, 'height')===getIntAttribute(target, 'height'))
                    [0] ?? target;

                    // --- If target box is already in the selected group, then
                    //     toggle the selection (ie. deselect it)
                    const updatedTargetGroup = getGroupForBox(updatedTarget);
                    if(updatedTargetGroup === currentlySelectedGroup) {
                        console.info('TODO: REMOVE FROM GROUP', updatedTarget);
                        // If box is no longer in any groups will also delete box.
                        // - if was a ref box, goes back to being a ref box.
                        // - if was hand drawn box, goes away.
                        // - do the mult-select case (and rendering) first!
                        removeBoxFromGroup(currentlySelectedGroup, updatedTarget);
                    } else {
                        copyBoxToGroup(currentlySelectedGroup, updatedTarget);
                    }
                }
            } else {
                // --- Normal click on a non-ref box begins a new selection with just
                //     this box (and the containing group in the group level selection).
                selectBoxOrRotateSelectionIfAlreadySelectedMultiselect(target);
            }
            break;
        };
        case 'ref-box': {
            const addToCurrentGroup = event.ctrlKey || singleGroupMode
            if(addToCurrentGroup) {
                const currentlySelectedGroup = getSelectedGroup();
                if(currentlySelectedGroup) {
                    copyRefBoxToExistingGroup(target, currentlySelectedGroup);
                    //selectBox(target);
                }
            } else {
                copyRefBoxToNewGroup(target);
                //selectBox(target);
            }
            break;
        }
        case 'grabber': grabberMouseDown(event, target); break;
        default: newBoxMouseDown(event, target, event.ctrlKey || singleGroupMode); break;
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
            const scaleFactor = getContainingScaleFactor(target);
            const deltaX = (event.clientX-dragStartClientX) * scaleFactor;
            const deltaY = (event.clientY-dragStartClientY) * scaleFactor;
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

            const x = getIntAttribute(box, 'x');
            const y = getIntAttribute(box, 'y');
            const w = getIntAttribute(box, 'width');
            const h = getIntAttribute(box, 'height');
            if(!box.id) {
                  if(group.id)
                    newBoundingBoxInExistingGroup(group, box, x, y, w, h, this.onAbort);
                else
                    newBoundingBoxInNewGroup(group, box, x, y, w, h, this.onAbort);
            } else {
                updateBoundingBoxShape(box, x, y, w, h, this.onAbort);
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
    const scaleFactor = getContainingScaleFactor(target);
    const x = (event.clientX - scannedPageSvgLocation.x) * scaleFactor;
    const y = (event.clientY - scannedPageSvgLocation.y) * scaleFactor;
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

const groupColors = [
    'crimson', 'palevioletred', 'darkorange', 'gold', 'darkkhaki',
    'seagreen', 'steelblue', /*'dodgerblue',*/ 'peru', /*'tan',*/ 'rebeccapurple'];

/**
 * Picks a color for a new group.
 *
 * If all the colors are not already in use on the page, randomly picks from
 * the unused colors.
 *
 * If all the colors are already in use on the page, picks the color whose
 * nearest use (currently using upper left x,y of box) is furthest from the
 * proposed new point.
 */
function chooseNewGroupColor(x: number, y: number) {
    const unusedGroupColors = new Set(groupColors);
    const distanceByColor: Map<string, number> = new Map();
    // TODO this shold be scoped to the single svg page under edit - not whole document
    const nonRefGroups = document.querySelectorAll('svg.group:not(.ref)');
    for(const group of nonRefGroups) {
        const groupColor = group.getAttribute('stroke');
        if(!groupColor)
            continue;
        unusedGroupColors.delete(groupColor);
        for(const box of group.children) {
            // Skip the group frame
            if(!box.classList.contains('box')) continue;

            const distance = Math.hypot(x-getIntAttribute(box, 'x'), y-getIntAttribute(box, 'y'));
            if(distance < (distanceByColor.get(groupColor)??Number.MAX_SAFE_INTEGER)) {
                distanceByColor.set(groupColor, distance);
            }
        }
    }

    if(unusedGroupColors.size > 0) {
        const unusedGroupColorsArray = Array.from(unusedGroupColors);
        const unusedColor =  unusedGroupColorsArray[randomInt(unusedGroupColorsArray.length)];
        console.info('choosing unused color', unusedColor,
                     'from', unusedGroupColorsArray);
        return unusedColor;
    } else {
        const colorsByDistance = Array.from(distanceByColor.entries())
            .toSorted(([color1, distance1], [color2, distance2])=>distance1-distance2);
        console.info('colorsByDistance', colorsByDistance);
        if(colorsByDistance.length === 0)
            panic('new color chooser is borked (should have chosen an unused color)');
        const furthestColor = colorsByDistance[colorsByDistance.length-1][0];
        console.info('furthestColor', furthestColor);
        return furthestColor
    }
}

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
    updateMultiTaggingAnnotations(getScannedPageForElement(group));
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
    updateMultiTaggingAnnotations(getScannedPageForElement(box));
}

const idCollator = Intl.Collator('en');

function selectBoxOrRotateSelectionIfAlreadySelectedMultiselect(box: Element) {
    const group = getGroupForBox(box);

    // --- If the group this box is in is not already selected, do a normal selection
    if(getSelectedGroup() !== group) {
        selectBox(box);
        return;
    }

    // --- If we are doing a second select on a selected multi-select box,
    //     rotate to the next group that selected that box
    if(isMultiSelectedBox(box)) {
        const page = getScannedPageForElement(box);
        const boxesInGroup =
            Array.from(findBoxesWithSharedLocation(page).boxesWithSharedLocation.values())
                .filter(v=>v.some(b=>b===box))[0]
            ?.toSorted((a,b)=>idCollator.compare(a.id, b.id));

        console.info('BOXES IN GROUP', boxesInGroup);
        const currentBoxIndexInSelectionGroup = boxesInGroup.indexOf(box);
        if(currentBoxIndexInSelectionGroup === -1)
            throw new Error('unable to find expected box in multi select group');
        const nextBoxToSelect = boxesInGroup[
            (currentBoxIndexInSelectionGroup+1) % boxesInGroup.length];

        console.info('Selecting next box in multi select group', nextBoxToSelect);
        selectBox(nextBoxToSelect);
    }
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

// ------------------------------------------------------------------------
// --- Derived markup upkeep ----------------------------------------------
// ------------------------------------------------------------------------


/**
 * Updates a groups dimensions to contain all of the groups boxes +
 * a margin.
 *
 * This should be called after altering any contained bounding boxes.
 */
function updateGroupDimensions(group: Element) {
    // Currently disabled do to bug (and not really using anyway) TODO TODO XXX
    return;
    isGroup(group) || panic();

    // --- Get page width and height
    const pageImage = getScannedPageForElement(group);
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

/**
 * A common situation is to have multiple bounding groups contain the
 * exact same bounding box (for example, because a shared prefix of
 * a definition is shared by multiple definitions).
 *
 * This function runs on the SVG DOM, identifying these situations and
 * updating class tags to allow this to render in a reasonable way
 * (and have some custom behaviour).
 */
function updateMultiTaggingAnnotations(page: Element) {

    const {boxesWithSharedLocation, boxesWithNonSharedLocation} =
        findBoxesWithSharedLocation(page);

    // --- If any non-shared boxes have multi-tags, remove the multi-tags.
    for(const nonSharedBox of boxesWithNonSharedLocation.values()) {
        removeMultiTag(nonSharedBox);
    }

    // --- For shared boxes, update the 'multi' tags
    for(const [locationSignature, boxes] of
        Array.from(boxesWithSharedLocation.entries()).toReversed()) {
        console.info('Shared location group:', boxes);
        boxes.forEach((box, index) => {
            if(!box.classList.contains(`multi-${index}`)) {
                removeMultiTag(box);
                box.classList.add('multi');
                box.classList.add(`multi-${index}`);
            }
        });
    }
}

interface MultiBoxes {
    boxesWithSharedLocation: Map<string, Element[]>;
    boxesWithNonSharedLocation: Element[];
}

/**
 *
 */
function findBoxesWithSharedLocation(page: Element): MultiBoxes {

    // --- Partition bounding boxes by their complete coordinates
    const boundingBoxes = page.querySelectorAll('svg.box:not(.ref)');
    const groupedByLocation = Map.groupBy(
        boundingBoxes,
        box => `${getIntAttribute(box, 'x')}_${getIntAttribute(box, 'y')}_${getIntAttribute(box, 'width')}_${getIntAttribute(box, 'height')}`);
    const boxesWithNonSharedLocation = Array.from(groupedByLocation.entries())
        .filter(([id, boxes]) => boxes.length === 1).map(([id, boxes]) => boxes[0]);
    const boxesWithSharedLocation = new Map(Array.from(groupedByLocation.entries())
        .filter(([id, boxes]) => boxes.length > 1));

    return {boxesWithSharedLocation, boxesWithNonSharedLocation};
}

function removeMultiTag(box: Element) {
    if(box.classList.contains('multi')) {
        box.classList.remove('multi');
        const multiTags =
            Array.from(box.classList).filter(c=>c.startsWith('multi-'));
        multiTags.forEach(m=>box.classList.remove(m));
    }
}

function updateDerivedDom(refElem: Element) {
    console.time('updateDerivedDom');
    updateMultiTaggingAnnotations(getScannedPageForElement(refElem));
    console.timeEnd('updateDerivedDom');
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

// ---------------------------------------------------------------------------
// --- RPC -------------------------------------------------------------------
// ---------------------------------------------------------------------------

// Note: these are not 'clean' RPCs, they are the end part of an action
//       that may have already been done on the DOM (and therefore needs
//       to be undone if the RPC fails).
// TODO DOC BETTER, AND MAYBE MOVE CLOSER TO THE ACTIONS RATHER THAN IN
//      AN 'RPC' section (the crime is not the mix of dom and RPC, it is
//      factoring it out)

/**
 *
 */
function updateBoundingBoxShape(box: Element,
                                x: number, y: number, w: number, h: number,
                                onAbort: ()=>void) {
    updateDerivedDom(box);
    (async ()=>{
        const box_id = getBoxId(box);
        try {
            await rpc`updateBoundingBoxShape(${box_id}, {x:${x},y:${y},w:${w},h:${h}})`;
        } catch (e) {
            onAbort();
            updateDerivedDom(box);
            alert(`Failed to resize bounding box ${e}`);
            throw e;
        }
    })();
}

/**
 *
 */
function newBoundingBoxInNewGroup(group: Element, box: Element,
                                  x: number, y: number, w: number, h: number,
                                  onAbort: ()=>void) {
    updateDerivedDom(box);
    (async() => {
        if(group.id)
            throw new Error('new group already has id');
        if(box.id)
            throw new Error('new box already has id');

        const page_id = getContainingPageId(box);
        const layer_id = getContainingLayerId(box);
        const color = group.getAttribute('stroke');

        try {
            const response = await rpc`newBoundingBoxInNewGroup(${page_id}, ${layer_id}, {x:${x},y:${y},w:${w},h:${h}}, ${color})`;
            console.info('added new box', response);
            if(!Object.hasOwn(response, 'bounding_group_id') ||
                !Object.hasOwn(response, 'bounding_box_id'))
                throw new Error(`new bounding box rpc had malformed response`);
            if(box.id || group.id)
                throw new Error(`bounding box has already been added to another group`);
            group.setAttribute('id', `bg_${response.bounding_group_id}`);
            box.setAttribute('id', `bb_${response.bounding_box_id}`);
        } catch (e) {
            onAbort();
            updateDerivedDom(box);
            alert(`Failed to add new box in new group: ${e}`);
            throw e;
        }
    })();
}

/**
 *
 */
function newBoundingBoxInExistingGroup(group: Element, box: Element,
                                       x: number, y: number, w: number, h: number,
                                       onAbort: ()=>void) {
    updateDerivedDom(box);
    (async() => {
        if(!group.id)
            throw new Error('existing group is missing id');
        if(box.id)
            throw new Error('new box already has id');

        try {
            const page_id = getContainingPageId(box);
            const response = await rpc`newBoundingBoxInExistingGroup(${page_id}, ${getGroupId(group)}, {x:${x},y:${y},w:${w},h:${h}})`;
            console.info('added new box to existing group', response);
            if(!Object.hasOwn(response, 'bounding_box_id'))
                throw new Error(`new bounding box in existing group rpc had malformed response`);
            if(box.id)
                throw new Error(`bounding box has already been added to another group`);
            box.setAttribute('id', `bb_${response.bounding_box_id}`);
        } catch (e) {
            onAbort();
            updateDerivedDom(box);
            alert(`Failed to add new box in existing group: ${e}`);
            throw e;
        }
    })();
}

/**
 *
 */
function copyRefBoxToNewGroup(box: Element) {
    isRefBox(box) || panic('expected ref box');

    // TODO roll this back if RPC fails!
    const color = chooseNewGroupColor(getIntAttribute(box, 'x'),
                                      getIntAttribute(box, 'y'));
    const newGroup = createNewBoundingGroup(color);
    newGroup.appendChild(box);
    box.classList.remove('ref');
    updateGroupDimensions(newGroup);
    getScannedPageForElement(box).appendChild(newGroup);
    selectBox(box);
    updateDerivedDom(box);

    (async() => {
        try {
            const refBoxId = getBoxId(box);
            const layer_id = getContainingLayerId(box);
            const response = await rpc`copyRefBoxToNewGroup(${refBoxId}, ${layer_id}, ${color})`;
            console.info('copied ref box to new group', response);
            if(!Object.hasOwn(response, 'bounding_group_id') ||
                !Object.hasOwn(response, 'bounding_box_id'))
                throw new Error(`copy ref box to new group rpc had malformed response`);

            newGroup.setAttribute('id', `bg_${response.bounding_group_id}`);
            box.setAttribute('id', `bb_${response.bounding_box_id}`);
        } catch (e) {
            // TODO XXX insufficient rollback logic here
            updateDerivedDom(box);
            alert(`Failed to add new group based on ref box: ${e}`);
            throw e;
        }
    })();
}

/**
 *
 *
 */
function copyRefBoxToExistingGroup(box: Element, group: Element) {
    isRefBox(box) || panic('expected ref box');
    isGroup(group) || panic('expected group');
    isRef(group) && panic('expected non-ref group');

    // TODO roll this back if RPC fails!
    // TODO try just copying the ref box for now.
    group.appendChild(box);
    box.classList.remove('ref');
    updateGroupDimensions(group);
    selectBox(box);
    updateDerivedDom(box);

    (async() => {
        try {
            const response = await rpc`copyRefBoxToExistingGroup(${getGroupId(group)}, ${getBoxId(box)})`;
            console.info('copied ref box to group', response);
            if(!Object.hasOwn(response, 'bounding_box_id'))
                throw new Error(`copy ref box to group rpc had malformed response`);
            box.setAttribute('id', `bb_${response.bounding_box_id}`);
        } catch (e) {
            // TODO XXX insufficient rollback logic here
            updateDerivedDom(box);
            alert(`Failed to add ref box to group: ${e}`);
            throw e;
        }
    })();
}


/**
 * Copy the specified non-ref box to another group
 *
 */
function copyBoxToGroup(toGroup: Element, srcBox: Element) {
    isBox(srcBox) && isGroup(toGroup) || panic();
    isRefBox(srcBox) && panic("use copyRefBoxToGroup for ref boxes");
    const srcGroup = srcBox.parentElement || panic();
    isGroup(srcGroup) || panic();

    // TODO roll this back if RPC fails!
    const newBox =
        createNewBoundingBox(
            getIntAttribute(srcBox, 'x'),
            getIntAttribute(srcBox, 'y'),
            getIntAttribute(srcBox, 'width'),
            getIntAttribute(srcBox, 'height'));

    toGroup.appendChild(newBox);

    updateGroupDimensions(toGroup);
    updateDerivedDom(newBox);

    (async() => {
        try {
            const response = await rpc`copyBoxToExistingGroup(${getGroupId(toGroup)}, ${getBoxId(srcBox)})`;
            console.info('copied box to group', response);
            newBox.setAttribute('id', `bb_${response.bounding_box_id}`);
        } catch (e) {
            updateDerivedDom(srcBox);
            alert(`Failed to copy box to group: ${e}`);
            throw e;
        }
    })();
}

/**
 * Remove a box from a group (possibly also removing the group
 * if it no longer has any boxes?)
 *
 * TODO: if was based on a ref box, we want the ref box to
 *       be restored (for now user will have to do a page refresh) XXX
 */
function removeBoxFromGroup(group: Element, box: Element) {
    isBox(box) && isGroup(group) || panic();

    // TODO roll this back if RPC fails!
    group.removeChild(box);
    updateGroupDimensions(group);
    updateDerivedDom(group);

    (async() => {
        try {
            const response = await rpc`removeBoxFromGroup(${getBoxId(box)})`;
            console.info('removed box from group', response);
            // TODO: consider also removing group based on return value?
        } catch (e) {
            alert(`Failed to remove box from group: ${e}`);
            throw e;
        }
    })();
}

/**
 * Migrate a (non-ref) box to a new group.
 *
 * We are not presently using this (removed from the UI)
 */
function migrateBoxToGroup(box: Element, group: Element) {
    isBox(box) && isGroup(group) || panic();
    const fromGroup = box.parentElement || panic();
    isGroup(fromGroup) || panic();

    // TODO roll this back if RPC fails!
    group.appendChild(box);
    updateGroupDimensions(group);

    if(getBoxesForGroup(fromGroup).length === 0) {
        fromGroup.remove();
    } else {
        updateGroupDimensions(fromGroup);
    }

    updateDerivedDom(box);

    (async() => {
        try {
            const response = await rpc`migrateBoxToGroup(${getGroupId(group)}, ${getBoxId(box)})`;
            console.info('migrated box to group', response);
        } catch (e) {
            updateDerivedDom(box);
            alert(`Failed to migrate box to group: ${e}`);
            throw e;
        }
    })();
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
