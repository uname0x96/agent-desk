/**
 * Test-only. React Query decides `isServer` from `typeof window` when the
 * module first loads, and disables every refetch interval when it is a server.
 * The Run view runs in a browser, so a test that exercises the 2 s poll has to
 * give the module graph a window before React Query is imported.
 *
 * Import this module *first* in such a test; ES modules evaluate in order.
 */
const globals = globalThis as { window?: unknown }
globals.window ??= globalThis

export {}
