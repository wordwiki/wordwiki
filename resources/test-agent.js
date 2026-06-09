/**
 * Browser-side half of the test bridge (see liminal/browser-agent.ts and the
 * rabid.testClient* routes).  When this loads (only on the test-client page, an
 * explicit opt-in) it:
 *   1. POSTs testClientOptIn  -> this session becomes the most-recent test client.
 *   2. long-polls testClientPoll for a command (a chunk of JS),
 *   3. runs it as the body of an async function, serializes the result, and POSTs
 *      it back via testClientResult.
 *
 * session_token is resolved server-side from the cookie (it is a bound name in
 * the route scope), so it never appears in these URLs - we just name it.
 *
 * Not a security hole: the server already authors and ships the JS this page
 * runs.  The new capability is gated server-side to the 'testing' permission and
 * to non-production databases.
 */
(function () {
    'use strict';

    const OPT_IN  = '/rabid/rabid.testClientOptIn(session_token)';
    const POLL    = '/rabid/rabid.testClientPoll(session_token)';
    const RESULT  = '/rabid/rabid.testClientResult(session_token,$arg0,$arg1)';

    let stopped = false;
    let lastExecuted = null;   // {cmdId, envelope} - for idempotent re-send if a result post is lost

    function setStatus(text, cls) {
        const el = document.getElementById('test-agent-status');
        if(!el) return;
        el.textContent = text;
        el.className = 'alert ' + (cls || 'alert-secondary');
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function post(expr, args) {
        const r = await fetch(expr, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            credentials: 'same-origin',
            body: JSON.stringify(args || {}),
        });
        if(!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    }

    // Structured serialization of an arbitrary browser value into JSON-safe form.
    // JSON.stringify is lossy (drops undefined, mangles NaN/Infinity, throws on
    // cycles, has no idea what a DOM node is), so we tag the awkward cases instead.
    function serialize(v) {
        const seen = new WeakSet();
        function ser(x, depth) {
            if(x === undefined) return {__undefined: true};
            if(x === null) return null;
            const t = typeof x;
            if(t === 'number') return Number.isFinite(x) ? x : {__number: String(x)};   // NaN / ±Infinity
            if(t === 'string' || t === 'boolean') return x;
            if(t === 'bigint') return {__bigint: x.toString()};
            if(t === 'function') return {__function: x.name || '(anonymous)'};
            if(t === 'symbol') return {__symbol: String(x)};
            if(x instanceof Date) return {__date: x.toISOString()};
            if(typeof Node !== 'undefined' && x instanceof Node) {
                const el = x.nodeType === 1 ? x : null;
                return {
                    __dom: el ? el.tagName.toLowerCase() : x.nodeName,
                    id: (el && el.id) || undefined,
                    class: (el && el.className) || undefined,
                    text: (x.textContent || '').slice(0, 200),
                    outerHTML: el ? el.outerHTML.slice(0, 1000) : undefined,
                };
            }
            if(depth > 6) return {__truncated: true};
            if(seen.has(x)) return {__circular: true};
            seen.add(x);
            if(Array.isArray(x)) return x.slice(0, 1000).map(e => ser(e, depth + 1));
            // NodeList / HTMLCollection and other array-likes with item().
            if(typeof x.length === 'number' && typeof x.item === 'function')
                return Array.from(x).slice(0, 1000).map(e => ser(e, depth + 1));
            const out = {};
            for(const k of Object.keys(x)) out[k] = ser(x[k], depth + 1);
            return out;
        }
        return ser(v, 0);
    }

    async function runCommand(cmd) {
        // Idempotent re-delivery: if we already ran this exact command (its result
        // post may have been lost), just re-send the cached envelope - never re-run.
        if(lastExecuted && lastExecuted.cmdId === cmd.cmdId) {
            await post(RESULT, {$arg0: cmd.cmdId, $arg1: lastExecuted.envelope});
            return;
        }
        let envelope;
        try {
            // Eval as the body of an async function so test JS can `await` and
            // `return` a value.
            const fn = new Function('return (async () => {\n' + cmd.js + '\n})();');
            const value = await fn();
            envelope = {ok: true, value: serialize(value)};
        } catch(e) {
            envelope = {ok: false, error: {
                name: (e && e.name) || 'Error',
                message: (e && e.message) || String(e),
                stack: e && e.stack,
            }};
        }
        lastExecuted = {cmdId: cmd.cmdId, envelope};
        await post(RESULT, {$arg0: cmd.cmdId, $arg1: envelope});
    }

    async function loop() {
        try { await post(OPT_IN); }
        catch(_e) { /* the poll loop will retry; opt-in is also implied by polling */ }

        while(!stopped) {
            let resp;
            try {
                resp = await post(POLL);
            } catch(_e) {
                // Server restarting / network blip: back off and retry (this is how
                // the client survives a server restart - it just re-parks a poll).
                setStatus('reconnecting…', 'alert-warning');
                await sleep(2000);
                continue;
            }
            if(resp && resp.stale) {
                setStatus('superseded by a newer test client — stopped', 'alert-secondary');
                stopped = true;
                break;
            }
            if(resp && resp.cmd) {
                setStatus('running command ' + resp.cmd.cmdId + '…', 'alert-info');
                await runCommand(resp.cmd);
                setStatus('connected', 'alert-success');
            } else {
                setStatus('connected (idle)', 'alert-success');
            }
        }
    }

    function start() { loop(); }
    if(document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start);
    else
        start();
})();
