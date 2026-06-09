// deno-lint-ignore-file no-explicit-any
/**
 * A small sample browser-test suite, to demonstrate the bridge.  Each test may
 * freely INTERMIX two kinds of check:
 *   - in-process: query the db / dispatch a route directly (no HTTP, no browser),
 *   - in-browser: call rabid.evalInBrowser(js) to run JS in the live test client
 *     and assert on the structured value it returns.
 *
 * This is the v1 demonstration, driven by the "Run demo tests" button on the
 * test-client page.  Real browser tests will follow the same shape but run under
 * a named test-run launched with the server (a later step).
 *
 * Takes the Rabid instance as a parameter (type-only import) so this module does
 * not create a runtime import cycle with rabid.ts.
 */
import type {Rabid} from './rabid.ts';
import {h, type Markup} from '../liminal/markup.ts';
import * as security from '../liminal/security.ts';

interface TestCase { name: string; run: (rabid: Rabid) => Promise<void>; }
interface TestResult { name: string; ok: boolean; error?: string; }

function assert(cond: any, msg: string): void {
    if(!cond) throw new Error(msg);
}
function assertEquals(actual: any, expected: any, msg?: string): void {
    if(actual !== expected)
        throw new Error(`${msg ?? 'assertEquals'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const TESTS: TestCase[] = [
    {
        name: 'browser evaluates arithmetic and returns the value',
        run: async (rabid) => {
            const two = await rabid.evalInBrowser('return 1 + 1;');
            assertEquals(two, 2, 'browser 1+1');
        },
    },
    {
        name: 'browser sees the real DOM (page title + navbar links)',
        run: async (rabid) => {
            const title = await rabid.evalInBrowser('return document.title;');
            assert(typeof title === 'string' && title.includes('Test client'),
                   `expected page title to include "Test client", got ${JSON.stringify(title)}`);
            const navLinks = await rabid.evalInBrowser("return document.querySelectorAll('nav a').length;");
            assert(navLinks > 0, 'expected at least one navbar link in the live DOM');
        },
    },
    {
        name: 'browser errors surface as a thrown error server-side',
        run: async (rabid) => {
            let threw = false;
            try { await rabid.evalInBrowser("throw new Error('boom from browser');"); }
            catch(e) { threw = true; assert(String(e).includes('boom from browser'), 'error message should propagate'); }
            assert(threw, 'evalInBrowser should reject when the browser eval throws');
        },
    },
    {
        name: 'intermixed: in-process volunteer count agrees with an in-browser computation',
        run: async (rabid) => {
            // In-process: read straight from the db (system context - just counting).
            const count = security.runSystem(() => rabid.volunteer.activeVolunteersByName.all({}).length);
            // In-browser: do an independent computation and round-trip a structured value.
            const echoed = await rabid.evalInBrowser(`return {count: ${count}, doubled: ${count} * 2};`);
            assertEquals(echoed.count, count, 'round-tripped count');
            assertEquals(echoed.doubled, count * 2, 'browser arithmetic on the count');
        },
    },
    {
        name: 'structured serialization: undefined / NaN survive the round-trip as tagged values',
        run: async (rabid) => {
            const u = await rabid.evalInBrowser('return undefined;');
            assert(u && u.__undefined === true, 'undefined should round-trip as {__undefined:true}');
            const n = await rabid.evalInBrowser('return NaN;');
            assert(n && n.__number === 'NaN', 'NaN should round-trip as {__number:"NaN"}');
        },
    },
];

export async function runBrowserDemo(rabid: Rabid): Promise<Markup> {
    const results: TestResult[] = [];
    for(const t of TESTS) {
        try {
            await t.run(rabid);
            results.push({name: t.name, ok: true});
        } catch(e) {
            results.push({name: t.name, ok: false, error: e instanceof Error ? e.message : String(e)});
        }
    }

    const passed = results.filter(r => r.ok).length;
    const allOk = passed === results.length;
    return [h.div, {},
        [h.p, {class: allOk ? 'fw-bold text-success' : 'fw-bold text-danger'},
         `${passed}/${results.length} browser tests passed`],
        [h.ul, {class: 'list-group'},
         results.map(r => [h.li, {class: 'list-group-item d-flex justify-content-between align-items-start'},
             [h.span, {}, (r.ok ? '✓ ' : '✗ ') + r.name],
             r.ok ? undefined : [h.code, {class: 'text-danger ms-2'}, r.error],
         ]),
        ],
    ];
}
