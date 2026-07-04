/* lexeme-editor - client-side support for the v2 (server-side htmx) lexeme
   editor.  Loaded after liminal-scripts.js / rabid-scripts.js (uses rpc()). */

/**
 * Eager audio upload for the AudioUploadField widget: picking a file uploads
 * it immediately to the existing uploadRecording endpoint and writes the
 * returned content-store path into the field's hidden input, so the dialog's
 * normal (JSON) submit just carries a path string.  An abandoned dialog
 * leaves an orphaned blob in the content-addressed store - harmless.
 */
async function lmAudioUploadChange(event, hiddenInputId) {
    const fileInput = event.target;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileInput.disabled = true;
    try {
        const recordingBytesAsBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('failed to read file'));
            reader.onload = e => resolve(e.target.result.split(',')[1]);
            reader.readAsDataURL(file);
        });
        await lmUploadRecordingBase64(hiddenInputId, recordingBytesAsBase64, file.name);
    } catch (_e) {
        /* status already set by lmUploadRecordingBase64 */
    } finally {
        fileInput.disabled = false;
    }
}

/**
 * Shared upload core for BOTH the file picker and the in-browser recorder: POST
 * the base64 bytes to the existing uploadRecording endpoint, write the returned
 * content-store path into the field's hidden input, and report status.  `noun`
 * names the thing being uploaded (a filename, or 'recording').
 *
 * The in-flight op registers in lmAudioPending so the SAVE GUARD (below) can
 * await it: submitting the dialog mid-upload must attach the recording, not
 * silently save the stale/empty hidden value.
 */
function lmUploadRecordingBase64(hiddenInputId, recordingBytesAsBase64, noun) {
    const status = document.getElementById(hiddenInputId + '-status');
    if (status) status.textContent = 'Uploading ' + noun + '…';
    const op = (async () => {
        const {audioPath} = await rpc`wordwiki.audio.uploadRecording(${{recordingBytesAsBase64}})`;
        document.getElementById(hiddenInputId).value = audioPath;
        if (status) status.textContent = noun + ' uploaded — will be attached when you save.';
        return audioPath;
    })();
    lmAudioPending[hiddenInputId] = {state: 'uploading', op};
    op.then(
        () => { delete lmAudioPending[hiddenInputId]; },
        (e) => {
            if (status) status.textContent = 'Upload failed: ' + (e && e.message ? e.message : e);
            // A recorder still holding the take can re-upload on Save/Use;
            // a failed file-picker upload has nothing client-side to retry.
            const recId = lmAudioRecIdFor(hiddenInputId);
            if (recId) lmAudioPending[hiddenInputId] = {state: 'recorded', recId};
            else delete lmAudioPending[hiddenInputId];
        });
    return op;
}

// The recorder (if any) holding a re-uploadable take for a hidden input.
function lmAudioRecIdFor(hiddenInputId) {
    return Object.keys(lmRecorders).find(recId => {
        const st = lmRecorders[recId];
        return st && st.hiddenInputId === hiddenInputId && st.wavBlob;
    });
}

// ---------------------------------------------------------------------------
// In-browser recording (approach A): capture with MediaRecorder, decode whatever
// the browser produced (webm/opus, mp4/aac, …) via the Web Audio API, then
// re-encode to a 16-bit PCM WAV client-side so the unchanged uploadRecording
// endpoint (which requires a RIFF/WAV) accepts it.  Decoding-then-re-encoding
// sidesteps every cross-browser MediaRecorder container quirk (incl. iOS Safari).
// Per-widget state, keyed by the record-container id.
// ---------------------------------------------------------------------------
const lmRecorders = {};

// Unfinished audio work per hidden-input id, for the save guard:
//   {state:'recording', recId}   - the mic is live
//   {state:'recorded',  recId}   - a take exists client-side, not yet uploaded
//   {state:'uploading', op}      - an upload RPC is in flight
// An entry is REMOVED once the hidden input holds the uploaded path (or there
// is nothing usable to attach), so no-entry = the form is safe to submit.
const lmAudioPending = {};

async function lmAudioRecordToggle(hiddenInputId, recId) {
    const st = lmRecorders[recId];
    if (st && st.recording) { lmAudioStopRecording(recId); return; }
    const status = document.getElementById(hiddenInputId + '-status');
    const recBtn = document.getElementById(recId + '-rec');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        if (status) status.textContent = 'Recording is not supported in this browser — use the file picker.';
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({audio: true});
        const chunks = [];
        const mr = new MediaRecorder(stream);
        const s = lmRecorders[recId] = {stream, mr, chunks, recording: true, hiddenInputId, t0: Date.now(), timer: null, wavBlob: null};
        // The save guard awaits this to know the take is decoded (or failed).
        s.finalized = new Promise(res => { s.finalizedResolve = res; });
        lmAudioPending[hiddenInputId] = {state: 'recording', recId};
        mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => lmAudioFinalizeRecording(recId);
        mr.start();
        if (recBtn) { recBtn.textContent = '■ Stop'; recBtn.classList.add('active'); }
        if (status) status.textContent = 'Recording…';
        s.timer = setInterval(() => {
            const el = document.getElementById(recId + '-timer');
            if (el) el.textContent = lmFmtSecs((Date.now() - s.t0) / 1000);
        }, 250);
    } catch (e) {
        if (status) status.textContent = 'Microphone unavailable: ' + (e && e.message ? e.message : e);
    }
}

function lmAudioStopRecording(recId) {
    const st = lmRecorders[recId];
    if (!st || !st.recording) return;
    st.recording = false;
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    try { st.mr.stop(); } catch (_e) { /* already stopped */ }
    const recBtn = document.getElementById(recId + '-rec');
    if (recBtn) { recBtn.textContent = '● Record'; recBtn.classList.remove('active'); }
}

async function lmAudioFinalizeRecording(recId) {
    const st = lmRecorders[recId];
    if (!st) return;
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());   // release the mic
    if (st.aborted) { if (st.finalizedResolve) st.finalizedResolve(); return; }   // dialog closed mid-record
    const status = document.getElementById(st.hiddenInputId + '-status');
    try {
        const blob = new Blob(st.chunks, {type: st.mr.mimeType || 'audio/webm'});
        const arrayBuffer = await blob.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        if (ctx.close) ctx.close();
        const wavBlob = new Blob([lmEncodeWavFromAudioBuffer(audioBuffer)], {type: 'audio/wav'});
        st.wavBlob = wavBlob;
        lmAudioPending[st.hiddenInputId] = {state: 'recorded', recId};
        const preview = document.getElementById(recId + '-preview');
        if (preview) { preview.src = URL.createObjectURL(wavBlob); preview.style.display = ''; }
        const useBtn = document.getElementById(recId + '-use');
        if (useBtn) { useBtn.style.display = ''; useBtn.disabled = false; }
        if (status) status.textContent = 'Recorded — Save will attach it (preview or re-record first if you like).';
    } catch (e) {
        // Nothing usable came out of the take: clear the guard so Save is not
        // blocked forever - the status shows what happened, re-record to retry.
        delete lmAudioPending[st.hiddenInputId];
        if (status) status.textContent = 'Could not process recording: ' + (e && e.message ? e.message : e);
    } finally {
        if (st.finalizedResolve) st.finalizedResolve();
    }
}

async function lmAudioUseRecording(hiddenInputId, recId) {
    const st = lmRecorders[recId];
    if (!st || !st.wavBlob) return;
    const useBtn = document.getElementById(recId + '-use');
    if (useBtn) useBtn.disabled = true;
    try {
        const arrayBuffer = await st.wavBlob.arrayBuffer();
        await lmUploadRecordingBase64(hiddenInputId, lmArrayBufferToBase64(arrayBuffer), 'recording');
    } catch (_e) {
        if (useBtn) useBtn.disabled = false;   // let them retry; status already set
    }
}

function lmFmtSecs(s) {
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// The SAVE GUARD: a dialog submit must never lose audio work.  Without this,
// two windows silently dropped a recording: a take that was recorded but never
// uploaded (the old "Use this recording" foot-gun), and an upload still in
// flight when Save was clicked (seconds wide on a slow link - the hidden input
// only receives the content path when the RPC returns).  A capture-phase
// listener runs BEFORE the form's own inline onsubmit; when this form has
// pending audio work it suppresses the submit, resolves the work (stop the
// mic, upload the take, await the in-flight RPC - Save implies "use"), then
// re-submits with a pass flag.  On failure the dialog stays open with the
// status showing why; a second Save then proceeds without the failed take
// (the failure handlers clear the pending entry).
// ---------------------------------------------------------------------------
document.addEventListener('submit', (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.__lmAudioGuardPassed) { delete form.__lmAudioGuardPassed; return; }
    const pendingIds = Object.keys(lmAudioPending).filter(id => {
        const el = document.getElementById(id);
        return el && form.contains(el);
    });
    if (pendingIds.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();   // capture phase: the form's inline onsubmit never runs
    lmAudioResolveThenSubmit(form, pendingIds);
}, true);

async function lmAudioResolveThenSubmit(form, pendingIds) {
    const submitBtn = form.querySelector('button[type=submit]');
    if (submitBtn) submitBtn.disabled = true;
    try {
        for (const id of pendingIds) await lmAudioResolvePending(id);
        form.__lmAudioGuardPassed = true;
        form.requestSubmit();
    } catch (_e) {
        /* status already set by the failing step; dialog stays open */
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

/** Bring one field's audio work to rest: no pending entry when we return
 *  means the hidden input holds whatever should be saved. */
async function lmAudioResolvePending(id) {
    const p = lmAudioPending[id];
    if (!p) return;
    const status = document.getElementById(id + '-status');
    if (status) status.textContent = 'Attaching recording…';
    switch (p.state) {
        case 'recording': {
            const st = lmRecorders[p.recId];
            lmAudioStopRecording(p.recId);
            if (st && st.finalized) await st.finalized;   // decode/encode done (ok or not)
            return lmAudioResolvePending(id);             // now 'recorded' or cleared
        }
        case 'recorded': {
            const st = lmRecorders[p.recId];
            if (!st || !st.wavBlob) { delete lmAudioPending[id]; return; }
            const arrayBuffer = await st.wavBlob.arrayBuffer();
            await lmUploadRecordingBase64(id, lmArrayBufferToBase64(arrayBuffer), 'recording');
            return;
        }
        case 'uploading':
            await p.op;
            return;
    }
}

/** Downmix an AudioBuffer to mono and serialize it as a 16-bit PCM WAV (RIFF). */
function lmEncodeWavFromAudioBuffer(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const numChannels = audioBuffer.numberOfChannels;
    // Downmix to mono (pronunciation clips; keeps the upload small).
    const mono = new Float32Array(numFrames);
    for (let c = 0; c < numChannels; c++) {
        const ch = audioBuffer.getChannelData(c);
        for (let i = 0; i < numFrames; i++) mono[i] += ch[i] / numChannels;
    }
    const bytesPerSample = 2, blockAlign = bytesPerSample;   // mono
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let p = 0;
    const str = s => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
    const u32 = v => { view.setUint32(p, v, true); p += 4; };
    const u16 = v => { view.setUint16(p, v, true); p += 2; };
    str('RIFF'); u32(36 + dataSize); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * blockAlign); u16(blockAlign); u16(16);
    str('data'); u32(dataSize);
    for (let i = 0; i < numFrames; i++) {
        const s = Math.max(-1, Math.min(1, mono[i]));
        view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        p += 2;
    }
    return buffer;
}

function lmArrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;   // avoid arg-count limits on String.fromCharCode
    for (let i = 0; i < bytes.length; i += chunk)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
}

/**
 * Tear a recorder down: release the microphone, stop the timer, drop the
 * MediaRecorder, revoke the preview blob URL, and forget the state.  Safe to
 * call at any phase (recording, recorded-not-yet-used, or already finished).
 * `aborted` makes a still-pending onstop/finalize bail without touching the DOM.
 */
function lmAudioCleanupRecorder(recId) {
    const st = lmRecorders[recId];
    if (!st) return;
    st.aborted = true;
    st.recording = false;
    delete lmAudioPending[st.hiddenInputId];
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    try { if (st.mr && st.mr.state !== 'inactive') st.mr.stop(); } catch (_e) { /* already stopped */ }
    if (st.stream) { try { st.stream.getTracks().forEach(t => t.stop()); } catch (_e) {} }
    const preview = document.getElementById(recId + '-preview');
    if (preview && preview.src && preview.src.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(preview.src); } catch (_e) {}
    }
    delete lmRecorders[recId];
}

function lmAudioCleanupAllRecorders() {
    Object.keys(lmRecorders).forEach(lmAudioCleanupRecorder);
    // Also forget pending entries with no recorder (a file-picker upload in
    // flight when the dialog closed): input ids repeat across dialogs
    // ('input-<field>'), so a stale entry would block the NEXT dialog's save.
    Object.keys(lmAudioPending).forEach(id => { delete lmAudioPending[id]; });
}

// Release the mic (and recorder state) whenever the shared modal editor closes -
// ANY path: the X, Escape, a backdrop click, or a programmatic hide after save.
// Without this, closing the dialog while still recording leaves the microphone
// track live (and its in-use indicator on) until GC.  hidden.bs.modal fires
// after the dialog is fully closed; the modal skeleton is in the page template,
// loaded before this script.  Pages without the modal skip silently.
(() => {
    const modal = document.getElementById('modalEditor');
    if (modal) modal.addEventListener('hidden.bs.modal', lmAudioCleanupAllRecorders);
})();

/**
 * The page tagger popup posts {action:'reloadBoundingGroup', boundingGroupId}
 * to its opener when the user clicks "Done editing reference".  Find the
 * reference image(s) showing that group and reload their enclosing fragment,
 * so the new bounding boxes appear without a manual refresh.
 */
window.addEventListener('message', (e) => {
    if (e.origin !== window.origin) return;
    const m = e.data;
    if (!m || m.action !== 'reloadBoundingGroup') return;
    document.querySelectorAll('object[type="image/svg+xml"]').forEach(o => {
        const data = o.getAttribute('data') || '';
        if (data.includes(', ' + m.boundingGroupId + ')')) {
            const fragment = o.closest('[hx-trigger="reload"]');
            if (fragment && window.htmx) htmx.trigger(fragment, 'reload');
        }
    });
});
