// The pluggable store is what makes tapedeck edge-safe: a full record→replay
// round trip must work against an in-memory store with no filesystem at all.

import { createHash } from 'node:crypto';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { cassetteMiddleware } from '../src/middleware.js';
import { memoryCassetteStore } from '../src/store.js';
import { computeCassetteHash, stableStringify } from '../src/hash.js';

const PROMPT: LanguageModelV3CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];
const CALL: LanguageModelV3CallOptions = { prompt: PROMPT };

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
};

const result: LanguageModelV3GenerateResult = {
  content: [{ type: 'text', text: 'Hi there!' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
};

describe('memoryCassetteStore', () => {
  it('records and replays without touching the filesystem', async () => {
    const store = memoryCassetteStore();

    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => result }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: 'mem', store }),
    }).doGenerate(CALL);

    expect(store.entries.size).toBe(1);
    const [path] = [...store.entries.keys()];
    expect(path).toMatch(/^mem\/.*\.cassette\.json$/);

    const replayed = await wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('live model must not be called during replay');
        },
      }),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: 'mem', store }),
    }).doGenerate(CALL);

    expect(replayed.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  it('lists entries under a directory prefix', async () => {
    const store = memoryCassetteStore({
      'mem/a.cassette.json': '{}',
      'mem/b.json': '{}',
      'other/c.json': '{}',
    });
    expect(await store.list('mem')).toEqual(['a.cassette.json', 'b.json']);
  });
});

describe('computeCassetteHash (WebCrypto)', () => {
  it('produces the same digest as node:crypto SHA-256 (cassette back-compat)', async () => {
    const key = {
      modelProvider: 'mock-provider',
      modelId: 'mock-model-id',
      prompt: PROMPT,
      temperature: 0.7,
    };
    const hash = await computeCassetteHash(key);
    const expected = createHash('sha256')
      .update(
        stableStringify({
          modelProvider: key.modelProvider,
          modelId: key.modelId,
          prompt: key.prompt,
          tools: undefined,
          maxOutputTokens: undefined,
          temperature: key.temperature,
          topP: undefined,
        }),
      )
      .digest('hex');
    expect(hash).toBe(expected);
  });
});
