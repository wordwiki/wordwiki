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
    const status = document.getElementById(hiddenInputId + '-status');
    if (!file) return;
    if (status) status.textContent = 'Uploading ' + file.name + '…';
    fileInput.disabled = true;
    try {
        const recordingBytesAsBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('failed to read file'));
            reader.onload = e => resolve(e.target.result.split(',')[1]);
            reader.readAsDataURL(file);
        });
        const {audioPath} = await rpc`wordwiki.audio.uploadRecording(${{recordingBytesAsBase64}})`;
        document.getElementById(hiddenInputId).value = audioPath;
        if (status) status.textContent = 'Uploaded ' + file.name + ' — will be attached when you save.';
    } catch (e) {
        if (status) status.textContent = 'Upload failed: ' + (e && e.message ? e.message : e);
    } finally {
        fileInput.disabled = false;
    }
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
