/* liminal - generic framework client-side support.
   Loaded before the app's own scripts (e.g. rabid-scripts.js). */

/**
 * Back-button freshness: liminal pages are live views of the db (navigate to
 * an editor, edit, press Back - the list you came from must show the edit).
 * Dynamic pages are served Cache-Control: no-store, which keeps them out of
 * the back/forward cache on Chrome/Firefox; Safari restores from bfcache
 * regardless, so when a page is shown from a bfcache snapshot (e.persisted)
 * we reload it from the server.
 */
window.addEventListener('pageshow', (e) => {
    if (e.persisted)
        location.reload();
});

/**
 * Mobile navbar dismissal: nav links are htmx-boosted, so following one does
 * NOT reload the page - and the expanded hamburger menu would simply stay
 * open over the new content.  Collapse it whenever a navigation link inside
 * the open collapse is activated.  Delegated on document (works however the
 * navbar arrives); toggles (data-bs-toggle, e.g. the user dropdown inside the
 * navbar) are excluded - opening a sub-menu must not close the nav.
 */
document.addEventListener('click', (e) => {
    const link = e.target.closest('.navbar-collapse.show a:not([data-bs-toggle])');
    if (!link) return;
    const collapse = link.closest('.navbar-collapse');
    if (collapse && window.bootstrap)
        window.bootstrap.Collapse.getOrCreateInstance(collapse).hide();
});

/**
 * Click handler for an "editable surface" (class .lm-editable,
 * onclick="lmEditableClick(event)").  List rows no longer use this - they are
 * navigable surfaces (lmNavigableClick below) with pencil-only editing; it
 * remains for hand-rolled tap-to-edit surfaces with no detail page to drill
 * into (e.g. the wordwiki lexeme editor's fact rows).
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
    if (event.target.closest('.lm-editable, .lm-navigable') !== item)
        return; // nested tappable surface owns this click
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.type === 'Range')
        return; // user is selecting text, not tapping the row
    const button = item.querySelector('button.edit');
    if (button && button.closest('.lm-editable') === item)
        button.click();
}

/**
 * Click handler for a "navigable surface" (an element rendered with
 * Table.detailItemProps - class .lm-navigable, onclick="lmNavigableClick(event)").
 *
 * The surface's *whole area* navigates to the record's detail page, by
 * delegating to the row's own nav link (the <a class="lm-nav-link"> - a real
 * link, so keyboard/screen-reader access and middle-click-on-the-name never
 * depend on this handler).  Editing is NOT on this path: the pencil <button>
 * handles itself, and we decline its clicks below.  Same declines as
 * lmEditableClick:
 *   - an inner interactive element (the pencil, a mailto link, the nav link
 *     itself) keeps its own behaviour;
 *   - a text-selection drag (someone copying an email address off the row);
 *   - a click that originated inside a nested tappable surface.
 */
function lmNavigableClick(event) {
    const item = event.currentTarget;
    if (event.target.closest('a, button, input, select, textarea, label'))
        return;
    if (event.target.closest('.lm-navigable, .lm-editable') !== item)
        return; // nested tappable surface owns this click
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.type === 'Range')
        return; // user is selecting text, not tapping the row
    const link = item.querySelector('a.lm-nav-link');
    if (link && link.closest('.lm-navigable') === item)
        link.click();
}

// (Removed: lmNavigateFormRoute - the client-side "build a route expression
// from a form and navigate" helper.  Filter dialogs now do this SERVER-side
// via a FieldSet: the dialog dispatches a route (e.g.
// rabid.volunteer.applySearch) that runs parseFormValues → literal and
// returns {action:'navigate', url}.  That path gives canonical URLs - default
// values omitted, unknown keys rejected, values type-coerced - which the JS
// builder couldn't.  See liminal.md § On-page view state.)

/**
 * Refresh participation gate.
 *
 * The refresh machinery exists to reflect a page's OWN edits back into the
 * page - it is not a live-update system.  A context that renders a shared
 * editable view read-only (a report embedding a checklist, say) wraps it in
 * class "lm-read-only": everything under such an element is excluded from
 * refresh participation - it is neither collected as a speculated section
 * nor reload-triggered.  This suppresses REFRESH only, not affordances: a
 * read-only context should also be rendering the view affordance-less via
 * the usual canEdit paths.
 */
function lmRefreshable(el) {
    return !el.closest('.lm-read-only');
}

/* ---------------------------------------------------------------------------
   Refresh debug mode.

   For evaluating how much OVER-refreshing the reload/speculation machinery
   does: when enabled, every fragment refreshed in the most recent tx round is
   visually marked - green outline = refreshed and actually different,
   yellow = refreshed but byte-identical (pure over-revalidation) - and a
   fixed badge reports the round's path (1-trip speculative vs 2-trip
   fallback, with the miss reason) and counts.  Marks persist until the next
   round so the page can be inspected at leisure.

   Toggle from the console: lmDebugRefresh(true|false) (or no arg to flip);
   persisted in localStorage so it survives navigation while evaluating.
   Everything here no-ops when disabled.
--------------------------------------------------------------------------- */

function lmDebugRefreshEnabled() {
    // DEFAULT ON for now (dz 2026-07-03: getting a feel for the refresh
    // system's behaviour).  lmDebugRefresh(false) in the console turns it off
    // per-browser; flip the '!== '0'' back to '=== '1'' to make off the
    // default again.
    try { return localStorage.getItem('lmDebugRefresh') !== '0'; }
    catch(_e) { return true; }
}

function lmDebugRefresh(on) {
    if(on === undefined) on = !lmDebugRefreshEnabled();
    try { localStorage.setItem('lmDebugRefresh', on ? '1' : '0'); }
    catch(_e) { /* private mode etc. - just don't persist */ }
    if(!on) {
        lmDebugClearMarks();
        const badge = document.getElementById('lm-debug-badge');
        if(badge) badge.remove();
        lmDebugRoundStats = null;
    }
    console.info('refresh debug mode', on ? 'ON' : 'OFF');
    return on;
}

let lmDebugRoundStats = null;   // {path, speculation, changed, same} for the current round

function lmDebugClearMarks() {
    document.querySelectorAll('.lm-debug-refreshed-changed, .lm-debug-refreshed-same')
        .forEach(el => el.classList.remove('lm-debug-refreshed-changed', 'lm-debug-refreshed-same'));
}

/* Start a round: clear the previous round's marks and reset the badge.
   info: {path: '1-trip'|'2-trip', speculation?: 'miss'|'error'|'skipped'|'lost'} */
function lmDebugRoundStart(info) {
    if(!lmDebugRefreshEnabled()) return;
    lmDebugClearMarks();
    lmDebugRoundStats = {path: info.path, speculation: info.speculation,
                         changed: 0, same: 0, stragglers: 0};
    lmDebugUpdateBadge();
}

/* A 1-trip round had leftover (unanticipated) dirty keys that MATCHED
   something on the page and were reloaded the two-trip way.  (Leftover keys
   matching nothing are pruned before this is called - routine emission noise
   like a new row's pk or a provenance fk value must not read as under-
   speculation.) */
function lmDebugNoteStragglers(count) {
    if(!lmDebugRefreshEnabled() || !lmDebugRoundStats) return;
    lmDebugRoundStats.speculation = 'partial';
    lmDebugRoundStats.stragglers += count;
    lmDebugUpdateBadge();
}

/* Mark one swapped-in element as changed / identical and bump the badge. */
function lmDebugMark(el, changed) {
    if(!lmDebugRefreshEnabled() || !lmDebugRoundStats) return;
    el.classList.add(changed ? 'lm-debug-refreshed-changed' : 'lm-debug-refreshed-same');
    lmDebugRoundStats[changed ? 'changed' : 'same']++;
    lmDebugUpdateBadge();
}

function lmDebugUpdateBadge() {
    let badge = document.getElementById('lm-debug-badge');
    if(!badge) {
        badge = document.createElement('div');
        badge.id = 'lm-debug-badge';
        document.body.appendChild(badge);
    }
    const s = lmDebugRoundStats;
    const base = s.path === '1-trip' ? '1-trip'
        : s.path === 'live' ? 'live' : '2-trip fallback';
    const spec = s.speculation ? ` (${s.speculation}${s.stragglers ? ` +${s.stragglers} reload` : ''})` : '';
    badge.textContent = `refresh: ${base}${spec} · ${s.changed} changed · ${s.same} unchanged`;
}

/* DOM-level equality for the changed/identical verdict.  String comparison of
   outerHTML is unreliable (server serializer vs browser normalization, and
   htmx's transient htmx-settling/htmx-added classes), so compare cloned nodes
   with our marks and htmx's transient classes stripped. */
const LM_DEBUG_TRANSIENT_CLASSES = ['lm-debug-refreshed-changed', 'lm-debug-refreshed-same',
                                    'htmx-settling', 'htmx-added', 'htmx-swapping', 'htmx-request'];
function lmDebugStrippedClone(el) {
    const clone = el.cloneNode(true);
    for(const n of [clone, ...clone.querySelectorAll('*')]) {
        if(!n.classList) continue;
        n.classList.remove(...LM_DEBUG_TRANSIENT_CLASSES);
        if(n.getAttribute('class') === '')
            n.removeAttribute('class');   // class="" vs no attribute: isEqualNode cares
    }
    return clone;
}
function lmDebugNodesEqual(oldEl, newEl) {
    if(!(oldEl instanceof Element) || !(newEl instanceof Element)) return false;
    return lmDebugStrippedClone(oldEl).isEqualNode(lmDebugStrippedClone(newEl));
}

/* changed-verdict for a manual (speculative-swap) replacement, judged BEFORE
   the swap.  newNodes is the parsed replacement node list; a single-element
   replacement compares node-for-node, anything else counts as changed. */
function lmDebugSwapChanged(oldEl, newNodes) {
    if(!lmDebugRefreshEnabled()) return true;
    const newElems = newNodes.filter(n => n.nodeType === Node.ELEMENT_NODE);
    if(newElems.length !== 1) return true;
    return !lmDebugNodesEqual(oldEl, newElems[0]);
}

/* Fallback-path (htmx-driven) marking: reload() re-fetches each dirtied
   fragment via its hx-trigger='reload' hx-get, and htmx fires afterSwap ON
   the swapped-IN element (event.target = new node; detail.target = the old,
   now-detached node).  Filter to reload-triggered swaps so boosted navs and
   modal loads aren't marked. */
document.addEventListener('htmx:afterSwap', (event) => {
    if(!lmDebugRefreshEnabled() || !lmDebugRoundStats) return;
    const trigger = event.detail?.requestConfig?.triggeringEvent;
    if(!trigger || trigger.type !== 'reload') return;
    if(!(event.target instanceof Element)) return;
    lmDebugMark(event.target, !lmDebugNodesEqual(event.detail?.target, event.target));
});

/* ---------------------------------------------------------------------------
   Long-poll liveness (opt-in; see liminal.md and liminal/live.ts).

   Fragments that should track OTHER actors' edits carry class "lm-live"
   (server-side: liveReloadableProps).  When such a fragment is on the page,
   this poller long-polls the app's livePoll route with the union of the live
   fragments' dependency keys; when the server reports intersecting changes,
   the changed keys run through the ordinary reload() front door - so pruning,
   lm-read-only gating, and debug marking behave exactly like the page's own
   refresh rounds.

   Design points (each earned - don't simplify away):
   - PLAIN fetch, never rpc(): a parked 25s poll would count against the rpc
     storm watchdog's in-flight threshold.
   - The content-type header must be EXACTLY 'application/json' (the server
     matches the literal string; a charset suffix silently drops the body).
   - A 2xx response that isn't a poll answer means the session expired: denied
     anonymous requests bounce to the LOGIN PAGE as 200 HTML, not 401.  Both
     that and 401/403 PERMANENTLY stop the poller.
   - Echo suppression: this tab's own mutations come back on the poll too.
     Mutation responses carry the live-log `seq`; txCore feeds it to
     lmLiveNoteOwnSeq, and the drain skips entries with noted seqs.  Because
     the poll answer can RACE the mutation's own response, entries are queued
     and the drain defers while any rpc is in flight (lmRpcInFlight).
   - Disruption control: the drain also defers while the modal editor is open
     or while focus / a live text selection sits inside an affected fragment.
   - Lifecycle is event-driven: the loop runs only while the page is visible
     AND a live fragment exists; htmx:afterSwap and visibilitychange restart
     it.  Pages without lm-live fragments never contact the server.
--------------------------------------------------------------------------- */

let lmLiveState = null;             // {epoch, cursor, running, stopped}; null until booted
const lmLiveOwnSeqs = [];           // this tab's own mutation seqs (bounded ring)
const LM_LIVE_OWN_SEQS_MAX = 32;
let lmLivePendingEntries = [];      // queued {seq, keys} awaiting a safe drain
let lmLiveDrainTimer = null;

const lmLiveSleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Called by txCore with the `seq` a mutation response carried. */
function lmLiveNoteOwnSeq(seq) {
    if (typeof seq !== 'number') return;
    lmLiveOwnSeqs.push(seq);
    if (lmLiveOwnSeqs.length > LM_LIVE_OWN_SEQS_MAX) lmLiveOwnSeqs.shift();
}

/* The union of dep keys (dotted selector form) on live, refreshable fragments.
   Dep keys are recognizable as the '-...-'-shaped class tokens (see the key
   convention in liminal/table.ts). */
function lmLiveWatchKeys() {
    const keys = [];
    for (const el of document.querySelectorAll('.lm-live')) {
        if (!lmRefreshable(el)) continue;
        for (const cls of el.classList)
            if (/^-.+-$/.test(cls) && !keys.includes('.' + cls))
                keys.push('.' + cls);
    }
    return keys;
}

/* One poll round trip.  Returns the answer, or {authFailed:true} when the
   session is gone (401/403, or the 200 login page / any non-answer 2xx). */
async function lmLivePost(body) {
    const r = await fetch(window.__liminalLive.poll, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify({$arg0: body}),
    });
    if (r.status === 401 || r.status === 403) return {authFailed: true};
    if (!r.ok) throw new Error('live poll failed: ' + r.status);
    let answer = null;
    try { answer = await r.json(); } catch (_e) { /* HTML login page etc. */ }
    if (!answer || typeof answer.epoch !== 'string' || typeof answer.seq !== 'number')
        return {authFailed: true};
    return answer;
}

async function lmLiveLoop() {
    const st = lmLiveState;
    while (!st.stopped) {
        if (document.hidden || lmLiveWatchKeys().length === 0) {
            st.running = false;      // restarted by visibilitychange / afterSwap
            return;
        }
        let answer;
        try {
            answer = await lmLivePost({epoch: st.epoch, sinceSeq: st.cursor,
                                       keys: lmLiveWatchKeys()});
        } catch (_e) {
            await lmLiveSleep(2000); // network hiccup / server restarting
            continue;
        }
        if (answer.authFailed) {
            st.stopped = true;
            st.running = false;
            console.info('liveness poller stopped: session no longer authenticated');
            return;
        }
        st.epoch = answer.epoch;
        st.cursor = answer.seq;
        if (answer.resync) {
            // The cursor couldn't be honoured (restart / overflow): reload
            // everything we watch.  seq -1 is never a noted own seq.
            lmLivePendingEntries.push({seq: -1, keys: lmLiveWatchKeys()});
            lmLiveDrainSoon();
        } else if (Array.isArray(answer.entries) && answer.entries.length > 0) {
            lmLivePendingEntries.push(...answer.entries);
            lmLiveDrainSoon();
        }
        // Loop straight back into the next poll (the park IS the wait).
    }
    st.running = false;
}

function lmLiveDrainSoon() {
    if (lmLiveDrainTimer) return;
    lmLiveDrainTimer = setTimeout(lmLiveDrain, 0);
}

/* Whether applying `keys` now would disrupt the user or race our own mutation. */
function lmLiveDeferred(keys) {
    if (typeof lmRpcInFlight !== 'undefined' && lmRpcInFlight > 0) return true;
    if (document.querySelector('.modal.show')) return true;
    const active = document.activeElement;
    const sel = window.getSelection ? window.getSelection() : null;
    for (const k of keys) {
        let els;
        try { els = document.querySelectorAll(k); } catch (_e) { continue; }
        for (const el of els) {
            if (active && active !== document.body && el.contains(active)) return true;
            if (sel && sel.type === 'Range' && sel.anchorNode && el.contains(sel.anchorNode)) return true;
        }
    }
    return false;
}

function lmLiveDrain() {
    lmLiveDrainTimer = null;
    if (lmLivePendingEntries.length === 0) return;
    const fresh = lmLivePendingEntries.filter(e => !lmLiveOwnSeqs.includes(e.seq));
    if (fresh.length === 0) { lmLivePendingEntries = []; return; }
    const keys = [];
    for (const e of fresh)
        for (const k of e.keys)
            if (!keys.includes(k)) keys.push(k);
    if (lmLiveDeferred(keys)) {
        lmLiveDrainTimer = setTimeout(lmLiveDrain, 1500);
        return;
    }
    lmLivePendingEntries = [];
    lmDebugRoundStart({path: 'live'});
    reload(keys);   // rabid-scripts.js front door (loaded by drain time)
}

function lmLiveEnsureRunning() {
    const st = lmLiveState;
    if (!st || st.stopped || st.running) return;
    if (document.hidden || !document.querySelector('.lm-live')) return;
    st.running = true;
    lmLiveLoop();
}

(() => {
    const boot = () => {
        if (!window.__liminalLive) return;
        lmLiveState = {epoch: window.__liminalLive.epoch,
                       cursor: window.__liminalLive.seq,
                       running: false, stopped: false};
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) lmLiveEnsureRunning();
        });
        document.addEventListener('htmx:afterSwap', lmLiveEnsureRunning);
        lmLiveEnsureRunning();
    };
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
})();

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
    // When the body has no inline title (e.g. showModalEditor is re-run after
    // the title was already lifted), keep the existing header rather than
    // blanking it - dialog content may arrive via more than one mechanism
    // (a page button's after-request, or an inline script in content swapped
    // from WITHIN the modal, where the issuing button is detached by its own
    // swap before after-request can fire on it).
    const inlineTitle = getModalBodyElem().querySelector('.lm-dialog-title');
    if (inlineTitle) {
        getModalTitleElem().innerText = inlineTitle.textContent.trim();
        inlineTitle.remove();
    }
    lmModalInitialState = lmModalFormState();
    getModalEditor().show();
    lmModalFocusFirstField();
}

/**
 * Focus the dialog's FIRST visible field, so "tap +, type the gloss, press
 * Enter" works without an extra click on the field.  Skips invisible fields
 * (a closed <details> like the change-note disclosure; hidden inputs).
 * Bootstrap moves focus to the modal on show, so on a FRESH open we must
 * focus after its shown.bs.modal event; when the modal is already open
 * (dialog-within-dialog swaps re-run showModalEditor), focus directly.
 */
function lmModalFocusFirstField() {
    const focus = () => {
        const field = [...getModalBodyElem().querySelectorAll('input, textarea, select')]
            .find(f => f.type !== 'hidden' && !f.disabled && f.offsetParent !== null);
        if (!field) return;
        field.focus();
        // Caret at the END of the existing value - "open and keep typing"
        // appends, it doesn't prepend.  (Throws on non-text input types;
        // those just keep their default.)
        try { field.setSelectionRange(field.value.length, field.value.length); }
        catch (_e) { /* selects, numbers, ... */ }
    };
    const modalEl = document.getElementById('modalEditor');
    if (!modalEl) return;
    if (modalEl.classList.contains('show')) focus();
    else modalEl.addEventListener('shown.bs.modal', focus, {once: true});
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

/**
 * Bootstrap replacement for window.confirm (the confirm action mode and the
 * modal discard guard).  Native confirm blocks the event loop - stalling
 * automation, exactly like native alert (see showAlert) - and looks nothing
 * like the app.  Returns a Promise<boolean>.  The OK button is focused, so
 * Enter confirms (native confirm's Enter=OK); Esc / backdrop / Cancel
 * decline.  Stacks above an open #modalEditor (appended later in the DOM, so
 * it paints above at Bootstrap's shared modal z-index); on close, body's
 * modal-open is restored if another modal is still up (Bootstrap drops it
 * when ANY modal hides).  Falls back to native confirm if Bootstrap is
 * unavailable or anything throws - a question must never be silently lost.
 */
let lmConfirmEl = null;
function lmConfirm(message) {
    try {
        if (typeof bootstrap === 'undefined') return Promise.resolve(confirm(message));
        if (!lmConfirmEl) {
            lmConfirmEl = document.createElement('div');
            lmConfirmEl.className = 'modal fade';
            lmConfirmEl.id = 'lmConfirmModal';
            lmConfirmEl.setAttribute('tabindex', '-1');
            lmConfirmEl.innerHTML =
                '<div class="modal-dialog modal-dialog-centered modal-sm">'
                + '<div class="modal-content">'
                + '<div class="modal-body lm-confirm-message"></div>'
                + '<div class="modal-footer border-0 pt-0">'
                + '<button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>'
                + '<button type="button" class="btn btn-sm btn-primary lm-confirm-ok">OK</button>'
                + '</div></div></div>';
            document.body.appendChild(lmConfirmEl);
        }
        lmConfirmEl.querySelector('.lm-confirm-message').textContent = message;
        const okBtn = lmConfirmEl.querySelector('.lm-confirm-ok');
        const modal = bootstrap.Modal.getOrCreateInstance(lmConfirmEl);
        return new Promise((resolve) => {
            let ok = false;
            const onOk = () => { ok = true; modal.hide(); };
            okBtn.addEventListener('click', onOk, {once: true});
            lmConfirmEl.addEventListener('shown.bs.modal', () => okBtn.focus(), {once: true});
            lmConfirmEl.addEventListener('hidden.bs.modal', () => {
                okBtn.removeEventListener('click', onOk);
                if (document.querySelector('.modal.show'))
                    document.body.classList.add('modal-open');
                resolve(ok);
            }, {once: true});
            modal.show();
        });
    } catch (e) {
        console.error('lmConfirm failed - falling back to native confirm', e);
        return Promise.resolve(confirm(message));
    }
}

// Wire the discard guard.  hide.bs.modal is cancelable: preventDefault keeps
// the dialog open; the (async, Bootstrap) confirm then either re-hides via
// hideModalEditor (which sets the discard flag) or leaves the dialog up.
// (This script loads at the end of <body>, after the modal skeleton; pages
// without a modal editor skip silently.)
(() => {
    const modal = document.getElementById('modalEditor');
    if (modal) modal.addEventListener('hide.bs.modal', (event) => {
        if (lmModalDiscardOk || lmModalInitialState === null)
            return;
        if (lmModalFormState() !== lmModalInitialState) {
            event.preventDefault();
            const returnFocus = document.activeElement;
            lmConfirm('Discard changes?').then((ok) => {
                if (ok) { hideModalEditor(); return; }
                // Keep editing: put focus back where it was (the confirm
                // took it; the user expects to just keep typing - and the
                // next Esc must reach the dialog, not fall on <body>).
                if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
                    returnFocus.focus();
                else
                    lmModalFocusFirstField();
            });
        }
    });
})();

/* Ctrl/Cmd+Enter submits the dialog from ANY field - the standard binding
   for the places plain Enter is taken (a textarea's Enter inserts a
   newline; single-line inputs and selects already submit implicitly).
   requestSubmit runs validation and the form's own onsubmit dispatch, so
   it is exactly the Save button. */
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const form = e.target instanceof Element && e.target.closest('#modalEditorBody form');
    if (form) { e.preventDefault(); form.requestSubmit(); }
});

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

/* ---------------------------------------------------------------------------
   Keyboard-driven editing (keyboard-driven-editing.md).

   The "focused assertion" is literally DOM focus: an app stamps class
   lm-kbd-stop (+ tabindex="-1" + a stable data-kbd identity) on each editable
   surface, and this controller supplies roving tabindex (one stop holds
   tabindex="0", so the whole widget is a single Tab stop from outside),
   key dispatch, and focus restoration across the refresh machinery's swaps.

   Keys act ONLY when the event target IS a stop - focus in a dialog field,
   the search box, or a dropdown item never reaches this handler, so the
   single-letter binds are safe.  Verbs dispatch by clicking the stop's OWN
   rendered buttons (found by stable class - the same delegation trick as
   lmEditableClick), so txd deps / lmConfirm gating / dialog URLs stay single
   source of truth.
--------------------------------------------------------------------------- */

let lmKbdCurrent = null;   // {key, index} of the last-focused stop

function lmKbdStops() {
    return [...document.querySelectorAll('.lm-kbd-stop')].filter(lmRefreshable);
}

/* Make `stop` the roving tabindex="0" holder. */
function lmKbdSetRoving(stop) {
    for (const el of document.querySelectorAll('.lm-kbd-stop[tabindex="0"]'))
        if (el !== stop) el.setAttribute('tabindex', '-1');
    stop.setAttribute('tabindex', '0');
}

/* Some stop must hold tabindex="0" or Tab can't enter the widget at all
   (server renders every stop -1; swapped-in fragments arrive -1 too). */
function lmKbdEnsureRoving() {
    const stops = lmKbdStops();
    if (stops.length === 0 || stops.some(s => s.getAttribute('tabindex') === '0'))
        return;
    const preferred = lmKbdCurrent?.key
        && stops.find(s => s.dataset.kbd === lmKbdCurrent.key);
    (preferred || stops[0]).setAttribute('tabindex', '0');
}

/* Track the last-focused stop - by key (survives swaps) and by index (the
   fallback when the key is gone: a deleted row's index names the row that
   slid into its place). */
document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof Element) || !e.target.classList.contains('lm-kbd-stop'))
        return;
    lmKbdSetRoving(e.target);
    lmKbdCurrent = {key: e.target.dataset.kbd ?? null,
                    index: lmKbdStops().indexOf(e.target)};
});

function lmKbdMove(from, delta) {
    const stops = lmKbdStops();
    const target = stops[stops.indexOf(from) + delta];
    if (!target) return false;   // at the edge - let a Tab fall through natively
    target.focus();
    return true;
}

/* A button INSIDE this stop (not inside a nested stop). */
function lmKbdButton(stop, selector) {
    return [...stop.querySelectorAll(selector)]
        .find(b => b.closest('.lm-kbd-stop') === stop) ?? null;
}

function lmKbdClick(stop, selector) {
    const b = lmKbdButton(stop, selector);
    if (b) b.click();
}

/* Enter: the row's primary action.  button.edit (the tap-to-edit target;
   an empty slot's + carries it too), else the ☰ (a fields-less example row
   has no Edit - offer its menu), else the first button (the document-
   reference empty slot's per-book add). */
function lmKbdPrimary(stop) {
    const edit = lmKbdButton(stop, 'button.edit');
    if (edit) return edit.click();
    if (lmKbdButton(stop, '.lm-menu-button[data-bs-toggle="dropdown"]'))
        return lmKbdOpenMenu(stop);
    lmKbdClick(stop, 'button');
}

/* Open the stop's ☰ and focus its first item, so Bootstrap's own dropdown
   keyboard handling (arrows/Esc) takes over from there. */
function lmKbdOpenMenu(stop) {
    const toggle = lmKbdButton(stop, '.lm-menu-button[data-bs-toggle="dropdown"]');
    if (!toggle) return;
    const dd = toggle.closest('.dropdown') ?? stop;
    const focusFirst = () => dd.querySelector('.dropdown-menu .dropdown-item')?.focus();
    if (dd.querySelector('.dropdown-menu.show')) focusFirst();
    else dd.addEventListener('shown.bs.dropdown', focusFirst, {once: true});
    toggle.click();
}

/* When a stop's dropdown closes with focus still inside the stop (Esc, or a
   menu item just ran), hand focus back to the stop so the keyboard flow
   continues.  A close caused by clicking elsewhere moved focus already -
   contains() declines, no stealing. */
document.addEventListener('hidden.bs.dropdown', (e) => {
    const stop = e.target instanceof Element && e.target.closest('.lm-kbd-stop');
    if (stop && stop.contains(document.activeElement))
        stop.focus();
});

document.addEventListener('keydown', (e) => {
    const stop = e.target instanceof Element && e.target.classList.contains('lm-kbd-stop')
        ? e.target : null;
    if (!stop || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
        case 'Tab':
            if (e.altKey) return;
            if (lmKbdMove(stop, e.shiftKey ? -1 : 1)) e.preventDefault();
            return;
        case 'ArrowDown':
        case 'ArrowUp': {
            const down = e.key === 'ArrowDown';
            if (e.altKey) lmKbdClick(stop, down ? '.lm-act-move-down' : '.lm-act-move-up');
            else lmKbdMove(stop, down ? 1 : -1);
            e.preventDefault();
            return;
        }
        case 'Enter': lmKbdPrimary(stop); e.preventDefault(); return;
        case '+': case 'o': lmKbdClick(stop, '.lm-act-insert-after'); e.preventDefault(); return;
        case 'O': lmKbdClick(stop, '.lm-act-insert-before'); e.preventDefault(); return;
        case 'Delete': case '#': lmKbdClick(stop, '.lm-act-delete'); e.preventDefault(); return;
        case 'h': lmKbdClick(stop, '.lm-act-history'); e.preventDefault(); return;
        case 'm': lmKbdOpenMenu(stop); e.preventDefault(); return;
        case '?': lmKbdHelp(); e.preventDefault(); return;
    }
});

/**
 * Focus restoration across the refresh machinery (the real work of the
 * feature - every mutation swaps the focused row out of the DOM, dropping
 * focus to <body>, which would kill the flow after every single edit).
 * Called after any churn: htmx afterSettle, the end of a speculative
 * lmApplySwap (rabid-scripts.js calls in), and the modal editor's
 * hidden.bs.modal (Bootstrap's fade drops focus to body AFTER our swaps -
 * the modal path must restore then).  Restores only when focus was actually
 * lost (on body / disconnected) and no dialog is open.
 */
/* A mutation response's focus hint (txCore notes it): the data-kbd key of
   the stop focus should land on once the refresh brings it to the page -
   an insert names its NEW row, so + flows straight into the new item.
   Short-lived: if the row never materializes (insert into a collapsed
   view, say), the hint must not fire on some later unrelated churn. */
let lmKbdFocusNext = null;    // {key, at}
function lmKbdNoteFocusHint(key) {
    lmKbdFocusNext = {key: String(key), at: Date.now()};
}

function lmKbdAfterChurn() {
    lmKbdEnsureRoving();
    // The focus hint outranks the was-focus-lost restore: it is an explicit
    // "the flow continues HERE" from the mutation.  Not yet findable (the
    // 2-trip path's churns can run before the fragment lands) -> keep it for
    // the next churn; a dialog on screen also defers it.
    if (lmKbdFocusNext && Date.now() - lmKbdFocusNext.at < 3000) {
        const t = lmKbdStops().find(s => s.dataset.kbd === lmKbdFocusNext.key);
        if (t && !document.querySelector('.modal.show')) {
            lmKbdFocusNext = null;
            t.focus();
            return;
        }
    } else
        lmKbdFocusNext = null;
    if (!lmKbdCurrent) return;
    // Focus counts as LOST when it sits on body, on a detached element, or
    // on an element that is no longer visible (offsetParent null - e.g. a
    // field inside the now-display:none dialog after an Esc close, which
    // stays CONNECTED because only hideModalEditor clears the modal body).
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected
        && !(active instanceof HTMLElement && active.offsetParent === null))
        return;
    if (document.querySelector('.modal.show')) return;
    const stops = lmKbdStops();
    if (stops.length === 0) return;
    const target = (lmKbdCurrent.key
        && stops.find(s => s.dataset.kbd === lmKbdCurrent.key))
        || stops[Math.max(0, Math.min(lmKbdCurrent.index ?? 0, stops.length - 1))];
    target.focus();
}

/* Land keyboard focus on the first stop when an editing page ARRIVES (fresh
   load or a boosted page swap): without this, entering the keyboard flow
   needs a mouse click or a Tab march through the navbar (dz).  preventScroll
   - the page just arrived at its natural/restored scroll position; the focus
   ring marks the spot without yanking. */
function lmKbdFocusInitial() {
    lmKbdEnsureRoving();
    const s = document.querySelector('.lm-kbd-stop[tabindex="0"]');
    if (s) s.focus({preventScroll: true});
}

document.addEventListener('htmx:afterSettle', (e) => {
    if (e.detail?.target === document.body || e.target === document.body)
        lmKbdFocusInitial();       // a boosted page swap = a page arrival
    else
        lmKbdAfterChurn();
});
/* A boosted whole-page navigation invalidates the memory - a stale index
   must not yank focus (and scroll) to an arbitrary stop on the new page. */
document.addEventListener('htmx:beforeSwap', (e) => {
    if (e.detail?.target === document.body) lmKbdCurrent = null;
});

/* ANY modal closing can strand focus on <body> - the editor's fade ends
   after our swaps, a cancelled lmConfirm, the help sheet.  Bootstrap modal
   events bubble, so one document-level hook covers them all; the churn
   guards make it a no-op when focus is legitimately elsewhere.  Deferred a
   tick: at hidden.bs.modal time the browser can still report the dialog's
   (now-hidden) field as activeElement - focus settles onto <body> just
   after, and the churn must judge THAT state. */
document.addEventListener('hidden.bs.modal', () => setTimeout(lmKbdAfterChurn, 0));

(() => {
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', lmKbdFocusInitial);
    else
        lmKbdFocusInitial();
})();

/* The '?' keybind sheet - a singleton Bootstrap modal like lmConfirm's. */
let lmKbdHelpEl = null;
function lmKbdHelp() {
    if (typeof bootstrap === 'undefined') return;
    if (!lmKbdHelpEl) {
        const row = (k, v) => `<tr><td class="pe-3 text-nowrap font-monospace">${k}</td><td>${v}</td></tr>`;
        lmKbdHelpEl = document.createElement('div');
        lmKbdHelpEl.className = 'modal fade';
        lmKbdHelpEl.id = 'lmKbdHelpModal';
        lmKbdHelpEl.setAttribute('tabindex', '-1');
        lmKbdHelpEl.innerHTML =
            '<div class="modal-dialog modal-dialog-centered">'
            + '<div class="modal-content"><div class="modal-header">'
            + '<h5 class="modal-title">Keyboard editing</h5>'
            + '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>'
            + '</div><div class="modal-body"><table class="table table-sm mb-0"><tbody>'
            + row('Tab / ↓', 'next row') + row('Shift-Tab / ↑', 'previous row')
            + row('Enter', 'edit') + row('+ or o', 'insert after') + row('O', 'insert before')
            + row('Alt+↓ / Alt+↑', 'move down / up') + row('Delete or #', 'delete')
            + row('h', 'history') + row('m', 'menu') + row('?', 'this help')
            + '<tr><td colspan="2" class="text-muted small pt-2">In an edit dialog:</td></tr>'
            + row('Enter / Ctrl+Enter', 'save (Ctrl also works from a note)')
            + row('Esc', 'close (asks before discarding changes)')
            + '</tbody></table></div></div></div>';
        document.body.appendChild(lmKbdHelpEl);
    }
    bootstrap.Modal.getOrCreateInstance(lmKbdHelpEl).show();
}

/* ----------------------------------------------------------------------------
   Photo field (liminal/table.ts ImageField).

   On file pick: downscale/re-encode the image in the browser (canvas -> JPEG,
   which also STRIPS EXIF incl. GPS and bakes in the EXIF orientation), upload
   it to the app's PhotoService route, and set the field's hidden input to the
   returned content path.  Saving the record is then a plain string-field save;
   nothing is attached to the record until the user presses Save.
---------------------------------------------------------------------------- */

const LM_PHOTO_MAX_DIM = 1600;       // longest side of the stored original
const LM_PHOTO_JPEG_QUALITY = 0.85;

async function lmPhotoFieldChange(event, photoServicePath, fieldName) {
    const fileInput = event.target;
    const file = fileInput.files && fileInput.files[0];
    if(!file) return;
    const status = document.getElementById('photo-status-' + fieldName);
    const setStatus = (t) => { if(status) status.textContent = t; };
    try {
        setStatus('Preparing photo…');
        const jpegBlob = await lmDownscaleImageToJpeg(file, LM_PHOTO_MAX_DIM, LM_PHOTO_JPEG_QUALITY);
        setStatus('Uploading…');
        const imageBytesAsBase64 = await lmBlobToBase64(jpegBlob);
        // rpc (resources/rabid-scripts.js) is a tagged template - call its
        // (segments, ...args) convention directly since the route path is a
        // runtime value here.
        const result = await rpc([photoServicePath + '.upload(', ')'], {imageBytesAsBase64});
        const photoPath = result.photoPath;

        document.getElementById('input-' + fieldName).value = photoPath;
        const preview = document.getElementById('photo-preview-' + fieldName);
        if(preview) {
            preview.src = '/' + photoServicePath + '.serve(' + JSON.stringify(photoPath) + ',256)';
            preview.classList.remove('d-none');
        }
        const removeBtn = document.getElementById('photo-remove-' + fieldName);
        if(removeBtn) removeBtn.classList.remove('d-none');
        setStatus('Photo ready — press Save to keep it.');
    } catch(e) {
        console.error('photo upload failed', e);
        setStatus('Photo upload failed: ' + ((e && e.message) || e));
        fileInput.value = '';
    }
}

function lmPhotoFieldClear(fieldName) {
    document.getElementById('input-' + fieldName).value = '';
    const preview = document.getElementById('photo-preview-' + fieldName);
    if(preview) { preview.src = ''; preview.classList.add('d-none'); }
    const removeBtn = document.getElementById('photo-remove-' + fieldName);
    if(removeBtn) removeBtn.classList.add('d-none');
    const fileInput = document.getElementById('photo-file-' + fieldName);
    if(fileInput) fileInput.value = '';
    const status = document.getElementById('photo-status-' + fieldName);
    if(status) status.textContent = 'Photo removed — press Save to keep the change.';
}

// Decode + downscale to a JPEG blob.  imageOrientation:'from-image' bakes the
// EXIF rotation into the pixels where supported (older Safari: fall back to a
// plain decode).  A file the browser can't decode (e.g. HEIC on Chrome)
// throws, surfacing as the field's failure status.
async function lmDownscaleImageToJpeg(file, maxDim, quality) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
    catch(_e) { bitmap = await createImageBitmap(file); }
    try {
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        return await new Promise((resolve, reject) =>
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('image encode failed')),
                          'image/jpeg', quality));
    } finally {
        if(bitmap.close) bitmap.close();
    }
}

function lmBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        // result is a data: URL - strip the prefix to get plain base64.
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
