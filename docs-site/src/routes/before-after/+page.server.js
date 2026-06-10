import { highlight } from "$lib/highlight.js";

export const prerender = true;

const beforeCode = `import { describe, it, expect } from 'vitest';
import { openai } from '@ai-sdk/openai';
import { runCheckoutAgent } from '../src/agent';

// Option A: let the test call the live model in CI.
describe('checkout agent', () => {
  it('runs the checkout flow', async () => {
    // Needs OPENAI_API_KEY wired into CI secrets — auth hygiene on
    // every runner. Each run bills real tokens: $ per push, per retry.
    const result = await runCheckoutAgent({
      model: openai('gpt-4o'),
      prompt: 'buy a t-shirt',
    });

    // The model is nondeterministic. It picked three steps on your laptop;
    // tonight it adds a clarifying turn and this assertion flips red.
    expect(result.steps).toHaveLength(3);

    // 3am: an upstream latency spike times the request out. The build
    // goes red, nobody touched the code. "Works on my machine." Re-run.
  });
});

// Option B: hand-write a MockLanguageModelV3 for every turn instead.
// No network — but you author each chunk by hand, it doesn't replay a
// real stream, and the next \`ai\` SDK bump rewrites the part shapes out
// from under you. Brittle boilerplate that rots the day you stop looking.`;

const afterCode = `import { describe, it, expect } from 'vitest';
import { openai } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { withCassette } from '@nkwib/tapedeck/vitest';
import { cassetteMiddleware } from '@nkwib/tapedeck';

// Wrap the model once. Behaviour switches on one env var — nothing else.
const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: cassetteMiddleware({
    mode: process.env.CASSETTE_MODE ?? 'live', // record | replay | live
    cassetteDir: './cassettes',
    redact: ['apiKey', 'authorization', /token/i],
  }),
});

describe('checkout agent', () => {
  it('runs the checkout flow', async () => {
    // Recorded once with CASSETTE_MODE=record against the live API.
    // withCassette pins this fixture and forces replay for its duration.
    await withCassette('checkout-flow.json', async () => {
      const result = await runCheckoutAgent({ model, prompt: 'buy a t-shirt' });

      // Deterministic, offline, free — and stream-accurate: the recorded
      // parts replay as a genuine ReadableStream, so streamText sees what
      // it would live, down to the chunk boundaries.
      expect(result.steps).toHaveLength(3);
    });
  });
});

// Change the prompt or a tool schema and the hash changes — replay
// misses and the test fails loudly:
//   CassetteMissError: no cassette for sha256:abc123… in ./cassettes
// Re-record, commit the new cassette, move on. (tapedeck@0.1.0+ai@6)`;

const diffCode = `- const result = await runCheckoutAgent({
-   model: openai('gpt-4o'),
-   prompt: 'buy a t-shirt',
- });
+ const model = wrapLanguageModel({
+   model: openai('gpt-4o'),
+   middleware: cassetteMiddleware({ mode: process.env.CASSETTE_MODE ?? 'live' }),
+ });
+ await withCassette('checkout-flow.json', async () => {
+   const result = await runCheckoutAgent({ model, prompt: 'buy a t-shirt' });
+   expect(result.steps).toHaveLength(3);
+ });`;

export function load() {
  return {
    before: highlight(beforeCode, "typescript"),
    after: highlight(afterCode, "typescript"),
    diff: highlight(diffCode, "diff"),
  };
}
