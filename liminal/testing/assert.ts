/**
 * Single choke-point for assertion imports.  Tests import from here, not directly
 * from the std lib, so migrating off Deno (to node:test/vitest/bun) is a one-file
 * change rather than a sweep across every test.
 */
export {
    assert,
    assertEquals,
    assertExists,
    assertFalse,
    assertMatch,
    assertNotEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "std/assert/mod.ts";
