// tapedeck — ambient cassette context
//
// `withCassette` needs to steer a middleware instance that was already wired into
// a model at module-load time (mode read from env, etc). Rather than thread a
// handle through the call stack, it publishes an ambient context via
// AsyncLocalStorage; the middleware consults it on each call and lets it override
// the static options for the duration of the wrapped test.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CassetteMode } from './middleware.js';

export interface CassetteContext {
  /** Force a specific named cassette file instead of hash-addressed lookup. */
  cassetteName?: string;
  /** Override the middleware mode for this scope. */
  mode?: CassetteMode;
  /** Override the cassette directory for this scope. */
  cassetteDir?: string;
  /**
   * Record-session marker, created per `withCassette` invocation. The first
   * write of a session starts the named cassette fresh (no stale interactions
   * from a previous recording); subsequent writes within the session append.
   */
  recordSession?: { written: boolean };
}

// The storage instance is registered on globalThis under a well-known symbol.
// The package ships dual ESM/CJS with two entry points (`.` and `./vitest`),
// so the same module can be instantiated more than once in a process (separate
// bundles, or the ESM/CJS dual-package hazard). `withCassette` publishing into
// one copy while the middleware reads another would silently disable the
// ambient context — Symbol.for guarantees every copy shares one instance.
const STORAGE_KEY = Symbol.for('tapedeck.cassette-context');
const registry = globalThis as { [STORAGE_KEY]?: AsyncLocalStorage<CassetteContext> };
const storage: AsyncLocalStorage<CassetteContext> = (registry[STORAGE_KEY] ??=
  new AsyncLocalStorage<CassetteContext>());

/** Run `fn` with `ctx` active; the context is torn down automatically on return. */
export function runWithCassetteContext<T>(
  ctx: CassetteContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return storage.run(ctx, async () => fn());
}

/** The context active for the current async execution, if any. */
export function getActiveCassetteContext(): CassetteContext | undefined {
  return storage.getStore();
}
