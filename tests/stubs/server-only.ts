/**
 * `server-only` throws when imported outside a React Server Components bundle,
 * which includes Vitest. Unit tests still need to reach pure helpers that live
 * in server modules, so the test configs alias the package here.
 *
 * This weakens nothing in the shipped app: the real guard is enforced by
 * Next.js at build time, where this stub is not in play.
 */
export {};
