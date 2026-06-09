// deno-lint-ignore-file no-explicit-any
/**
 * Thin indirection over the runtime's test registrar, so test files never name a
 * specific framework.  This is the ONE module that mentions `Deno`; migrating to
 * node:test / vitest / bun:test is a change here, not across every test file.
 *
 *   import { test } from "../liminal/testing/test.ts";
 *   test("does the thing", async () => { ... });
 */
export type TestFn = () => void | Promise<void>;

export const test = Object.assign(
    (name: string, fn: TestFn): void => { (globalThis as any).Deno.test(name, fn); },
    {
        only:   (name: string, fn: TestFn): void => { (globalThis as any).Deno.test.only(name, fn); },
        ignore: (name: string, fn: TestFn): void => { (globalThis as any).Deno.test.ignore(name, fn); },
    },
);
