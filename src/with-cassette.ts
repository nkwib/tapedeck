// tapedeck/vitest — test helper
//
// Wrap a test body in `withCassette` to pin it to a named cassette and force a
// mode (replay by default). It publishes an ambient context that any
// `cassetteMiddleware` instance picks up for the duration of the body, then tears
// it down automatically — no global setup/teardown required.

import { runWithCassetteContext } from './context.js';
import type { CassetteMode } from './middleware.js';

export interface WithCassetteOptions {
  /** Directory the cassette lives in. Defaults to the middleware's own setting. */
  cassetteDir?: string;
  /** Override the mode. Defaults to `'replay'`. */
  mode?: CassetteMode;
}

/**
 * Run `testFn` with the named cassette active.
 *
 * @example
 * await withCassette('checkout-flow.json', async () => {
 *   const result = await runAgent({ prompt: 'buy a t-shirt' });
 *   expect(result.steps).toHaveLength(3);
 * });
 */
export function withCassette<T>(
  cassetteName: string,
  testFn: () => T | Promise<T>,
  options: WithCassetteOptions = {},
): Promise<T> {
  return runWithCassetteContext(
    {
      cassetteName,
      mode: options.mode ?? 'replay',
      cassetteDir: options.cassetteDir,
      // Each withCassette run is one recording session: re-recording a test
      // starts its named cassette fresh instead of accumulating stale entries.
      recordSession: { written: false },
    },
    testFn,
  );
}
