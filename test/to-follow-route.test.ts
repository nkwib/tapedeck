// toFollowRoute: trajectory legality against a ToolRoute-shaped router.
// The router argument is structural — these tests use a hand-built adjacency
// matching what toolroute's createRouterFromTools produces.

import { describe, expect, it } from 'vitest';
import { toFollowRoute, type RouteLike } from '../src/to-follow-route.js';

expect.extend({ toFollowRoute });

// search → (fetch | summarize), fetch → summarize, summarize → terminal.
// Entry tools (toolroute semantics): every tool with a non-empty nextAllowed.
const router: RouteLike = {
  adjacency: {
    search: ['fetch', 'summarize'],
    fetch: ['summarize'],
    summarize: [],
  },
  routerVersion: 'toolroute@0.2.0+ai@6.0.0',
};

describe('toFollowRoute', () => {
  it('passes a legal trajectory of bare tool names', () => {
    expect(['search', 'fetch', 'summarize']).toFollowRoute(router);
  });

  it('passes an empty trajectory (no transitions to violate)', () => {
    expect([]).toFollowRoute(router);
  });

  it('accepts AI SDK result.steps shape (toolCalls per step)', () => {
    const steps = [
      { toolCalls: [{ toolName: 'search' }, { toolName: 'fetch' }] },
      { toolCalls: [{ toolName: 'summarize' }] },
      { toolCalls: [] },
    ];
    expect(steps).toFollowRoute(router);
  });

  it('accepts a flat list of { toolName } calls', () => {
    expect([{ toolName: 'search' }, { toolName: 'summarize' }]).toFollowRoute(router);
  });

  it('fails on an illegal transition with a pinpointed message', () => {
    const result = toFollowRoute(['search', 'fetch', 'fetch'], router);
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("call 3 ('fetch' after 'fetch') is illegal");
    expect(result.message()).toContain('legal next: [summarize]');
    expect(result.message()).toContain('search → fetch → fetch');
    expect(() => expect(['search', 'fetch', 'fetch']).toFollowRoute(router)).toThrow();
  });

  it('fails when the first call is not an entry tool', () => {
    // 'summarize' has an empty nextAllowed, so toolroute does not treat it
    // as an entry point.
    const result = toFollowRoute(['summarize'], router);
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("'summarize' after <start>");
  });

  it('flags tools that are not in the router at all', () => {
    const result = toFollowRoute(['search', 'deleteEverything'], router);
    expect(result.pass).toBe(false);
    expect(result.message()).toContain('tool is not in the router');
  });

  it('supports .not for intentionally-illegal trajectories', () => {
    expect(['summarize']).not.toFollowRoute(router);
  });

  it('rejects unrecognized trajectory shapes with a clear error', () => {
    expect(toFollowRoute('search', router).pass).toBe(false);
    expect(toFollowRoute([42], router).pass).toBe(false);
    expect(toFollowRoute([42], router).message()).toContain('unrecognized element at index 0');
  });

  it('rejects a router without an adjacency map', () => {
    const result = toFollowRoute(['search'], {} as RouteLike);
    expect(result.pass).toBe(false);
    expect(result.message()).toContain('adjacency');
  });
});
