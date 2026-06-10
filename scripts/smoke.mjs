#!/usr/bin/env node
// Post-build smoke test against ./dist — the things unit tests can't catch.
//
// Crucially this imports `cassetteMiddleware` from dist/index.js and
// `withCassette` from dist/vitest.js, the way a consumer does. The two entry
// points are separate bundles, so this catches cross-bundle regressions (e.g.
// the ambient AsyncLocalStorage context not being shared — a bug class that is
// invisible to the vitest suite, which imports everything from src/ in one
// module graph).
//
// Usage: pnpm build && node scripts/smoke.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { cassetteMiddleware, parseCassette, isMultiCassette } from '../dist/index.js';
import { withCassette } from '../dist/vitest.js';
import { readFile } from 'node:fs/promises';

function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), 'tapedeck-smoke-'));
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

let live = true; // flipped off for the replay phase
const model = wrapLanguageModel({
  model: new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!live) fail('live model called during replay');
      const part = options.prompt[0]?.content[0];
      return {
        content: [{ type: 'text', text: `echo:${part && 'text' in part ? part.text : '?'}` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  }),
  middleware: cassetteMiddleware({ cassetteDir: dir }),
});
const ask = async (text) => {
  const r = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
  });
  return r.content[0].text;
};

// record a 3-call test into one named cassette
await withCassette(
  'flow.json',
  async () => {
    for (const step of ['one', 'two', 'three']) await ask(step);
  },
  { mode: 'record' },
);

const file = parseCassette(await readFile(join(dir, 'flow.json'), 'utf8'), 'flow.json');
if (!isMultiCassette(file)) fail('named cassette is not multi-interaction');
if (file.interactions.length !== 3) fail(`expected 3 interactions, got ${file.interactions.length}`);

// replay out of order, live model fenced off
live = false;
await withCassette('flow.json', async () => {
  for (const [step, expected] of [['two', 'echo:two'], ['one', 'echo:one'], ['three', 'echo:three']]) {
    const got = await ask(step);
    if (got !== expected) fail(`replay '${step}': expected '${expected}', got '${got}'`);
  }
});

await rm(dir, { recursive: true, force: true });
console.log('smoke: PASS — cross-bundle withCassette record/replay (multi-interaction)');
