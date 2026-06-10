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
}

const storage = new AsyncLocalStorage<CassetteContext>();

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
