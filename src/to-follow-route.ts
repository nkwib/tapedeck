// tapedeck — `toFollowRoute` vitest matcher (ToolRoute integration)
//
// Asserts that an agent's recorded tool-call trajectory only makes transitions a
// ToolRoute router allows. The router is typed *structurally* (`adjacency` +
// `routerVersion`, the public data on toolroute's `Router`), so tapedeck has no
// dependency on toolroute — pass a real router and it just works.
//
// Pairing: guard in production with ToolRoute, replay in CI with tapedeck,
// assert the trajectory with this matcher.

/** Structural subset of a toolroute `Router`. */
export interface RouteLike {
  /** Tool name → legal successor names. */
  adjacency: Readonly<Record<string, readonly string[]>>;
  /** Included in failure messages when present. */
  routerVersion?: string;
}

/**
 * Trajectories the matcher accepts:
 * - `string[]` — bare tool names
 * - `{ toolName }[]` — e.g. a flat list of tool calls
 * - `{ toolCalls: { toolName }[] }[]` — AI SDK `result.steps`
 */
export type ToolTrajectory =
  | readonly string[]
  | ReadonlyArray<{ toolName: string }>
  | ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string }> }>;

/** Mirrors toolroute's `legalNextFor`: entry tools are those with successors. */
function legalNextFor(
  adjacency: RouteLike['adjacency'],
  prev: string | null,
): readonly string[] {
  if (prev === null) {
    return Object.entries(adjacency)
      .filter(([, next]) => next.length > 0)
      .map(([name]) => name);
  }
  return adjacency[prev] ?? [];
}

/** Flatten any accepted trajectory shape into ordered tool names. */
function extractToolNames(received: unknown): string[] | { error: string } {
  if (!Array.isArray(received)) {
    return { error: `expected an array of steps or tool names, got ${typeof received}` };
  }
  const names: string[] = [];
  for (const [i, item] of received.entries()) {
    if (typeof item === 'string') {
      names.push(item);
    } else if (item !== null && typeof item === 'object' && 'toolName' in item) {
      names.push(String((item as { toolName: unknown }).toolName));
    } else if (item !== null && typeof item === 'object' && 'toolCalls' in item) {
      const calls = (item as { toolCalls?: unknown }).toolCalls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (call !== null && typeof call === 'object' && 'toolName' in call) {
            names.push(String((call as { toolName: unknown }).toolName));
          }
        }
      }
    } else {
      return {
        error:
          `unrecognized element at index ${i}: expected a tool name string, ` +
          `{ toolName }, or a step with toolCalls`,
      };
    }
  }
  return names;
}

export interface ToFollowRouteResult {
  pass: boolean;
  message: () => string;
}

/**
 * Vitest matcher: `expect(result.steps).toFollowRoute(router)`.
 *
 * Register it once in a setup file:
 * ```typescript
 * import { expect } from 'vitest';
 * import { toFollowRoute } from 'tapedeck/vitest';
 * expect.extend({ toFollowRoute });
 * ```
 */
export function toFollowRoute(received: unknown, router: RouteLike): ToFollowRouteResult {
  if (!router || typeof router !== 'object' || !isPlainObject(router.adjacency)) {
    return {
      pass: false,
      message: () =>
        'toFollowRoute: expected a router with an adjacency map ' +
        '(e.g. the result of toolroute\'s createRouterFromTools)',
    };
  }

  const names = extractToolNames(received);
  if (!Array.isArray(names)) {
    return { pass: false, message: () => `toFollowRoute: ${names.error}` };
  }

  const version = router.routerVersion ? ` (${router.routerVersion})` : '';
  let prev: string | null = null;
  for (const [i, next] of names.entries()) {
    const legalNext = legalNextFor(router.adjacency, prev);
    if (!legalNext.includes(next)) {
      const from = prev === null ? '<start>' : `'${prev}'`;
      const legal = legalNext.length === 0 ? '<terminal>' : legalNext.join(', ');
      const unknown = !(next in router.adjacency) ? ' — tool is not in the router' : '';
      return {
        pass: false,
        message: () =>
          `expected trajectory to follow route${version}, but call ${i + 1} ` +
          `('${next}' after ${from}) is illegal; legal next: [${legal}]${unknown}\n` +
          `  trajectory: ${names.join(' → ') || '(empty)'}`,
      };
    }
    prev = next;
  }

  return {
    pass: true,
    message: () =>
      `expected trajectory NOT to follow route${version}, but every transition is legal\n` +
      `  trajectory: ${names.join(' → ') || '(empty)'}`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Module-augmentation helper: extend vitest's `Assertion` with this interface
 * in your own `.d.ts` if you want `expect(steps).toFollowRoute(router)` typed.
 */
export interface ToolRouteMatchers {
  toFollowRoute(router: RouteLike): void;
}
