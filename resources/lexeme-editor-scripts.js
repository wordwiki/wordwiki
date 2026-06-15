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
 */
async function lmUploadRecordingBase64(hiddenInputId, recordingBytesAsBase64, noun) {
    const status = document.getElementById(hiddenInputId + '-status');
    if (status) status.textContent = 'Uploading ' + noun + '…';
    try {
        const {audioPath} = await rpc`wordwiki.audio.uploadRecording(${{recordingBytesAsBase64}})`;
        document.getElementById(hiddenInputId).value = audioPath;
        if (status) status.textContent = noun + ' uploaded — will be attached when you save.';
        return audioPath;
    } catch (e) {
        if (status) status.textContent = 'Upload failed: ' + (e && e.message ? e.message : e);
        throw e;
    }
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
    const status = document.getElementById(st.hiddenInputId + '-status');
    try {
        const blob = new Blob(st.chunks, {type: st.mr.mimeType || 'audio/webm'});
        const arrayBuffer = await blob.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        if (ctx.close) ctx.close();
        const wavBlob = new Blob([lmEncodeWavFromAudioBuffer(audioBuffer)], {type: 'audio/wav'});
        st.wavBlob = wavBlob;
        const preview = document.getElementById(recId + '-preview');
        if (preview) { preview.src = URL.createObjectURL(wavBlob); preview.style.display = ''; }
        const useBtn = document.getElementById(recId + '-use');
        if (useBtn) { useBtn.style.display = ''; useBtn.disabled = false; }
        if (status) status.textContent = 'Recorded — preview it, then “Use this recording”.';
    } catch (e) {
        if (status) status.textContent = 'Could not process recording: ' + (e && e.message ? e.message : e);
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
