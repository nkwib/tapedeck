// Multi-interaction named cassettes: the flagship `withCassette` scenario — an
// agent that makes several model calls inside one test — must record every
// call into the named file and replay each one distinctly, keyed by hash.

import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  CASSETTE_VERSION,
  MULTI_CASSETTE_VERSION,
  type MultiCassette,
  serializeCassette,
} from '../src/cassette.js';
import { CassetteMissError, CassetteSecretError } from '../src/errors.js';
import { computeCassetteHash } from '../src/hash.js';
import { cassetteMiddleware } from '../src/middleware.js';
import { memoryCassetteStore } from '../src/store.js';
import { withCassette } from '../src/with-cassette.js';

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
};

function prompt(text: string): LanguageModelV3CallOptions['prompt'] {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

function reply(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

/** A mock model that answers each prompt with `echo:<prompt text>`. */
function echoModel() {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const part = options.prompt[0]?.content[0];
      const text = part && 'text' in part ? part.text : '?';
      return reply(`echo:${text}`);
    },
  });
}

function explodingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('live model must not be called during replay');
    },
    doStream: async () => {
      throw new Error('live model must not be called during replay');
    },
  });
}

const NAME = 'checkout-flow.json';
const PATH = `mem/${NAME}`;

describe('multi-interaction named cassettes', () => {
  it('records every call of a multi-step test and replays each distinctly', async () => {
    const store = memoryCassetteStore();
    const record = wrapLanguageModel({
      model: echoModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });

    await withCassette(
      NAME,
      async () => {
        await record.doGenerate({ prompt: prompt('step one') });
        await record.doGenerate({ prompt: prompt('step two') });
        await record.doGenerate({ prompt: prompt('step three') });
      },
      { mode: 'record' },
    );

    const file = JSON.parse(store.entries.get(PATH)!) as MultiCassette;
    expect(file.version).toBe(MULTI_CASSETTE_VERSION);
    expect(file.interactions).toHaveLength(3);

    // replay out of call order — lookups are hash-keyed, not positional
    const replayModel = wrapLanguageModel({
      model: explodingModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    await withCassette(NAME, async () => {
      const two = await replayModel.doGenerate({ prompt: prompt('step two') });
      const one = await replayModel.doGenerate({ prompt: prompt('step one') });
      expect(two.content).toEqual([{ type: 'text', text: 'echo:step two' }]);
      expect(one.content).toEqual([{ type: 'text', text: 'echo:step one' }]);
    });
  });

  it('re-recording starts the named cassette fresh (no stale interactions)', async () => {
    const store = memoryCassetteStore();
    const model = wrapLanguageModel({
      model: echoModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });

    await withCassette(
      NAME,
      async () => {
        await model.doGenerate({ prompt: prompt('old call A') });
        await model.doGenerate({ prompt: prompt('old call B') });
      },
      { mode: 'record' },
    );
    await withCassette(
      NAME,
      async () => {
        await model.doGenerate({ prompt: prompt('new call') });
      },
      { mode: 'record' },
    );

    const file = JSON.parse(store.entries.get(PATH)!) as MultiCassette;
    expect(file.interactions).toHaveLength(1);
  });

  it('a static cassetteName (no session) upserts instead of resetting', async () => {
    const store = memoryCassetteStore();
    const model = wrapLanguageModel({
      model: echoModel(),
      middleware: cassetteMiddleware({
        mode: 'record',
        cassetteDir: 'mem',
        cassetteName: NAME,
        store,
      }),
    });

    await model.doGenerate({ prompt: prompt('first') });
    await model.doGenerate({ prompt: prompt('second') });
    await model.doGenerate({ prompt: prompt('first') }); // same hash → replaced, not duplicated

    const file = JSON.parse(store.entries.get(PATH)!) as MultiCassette;
    expect(file.interactions).toHaveLength(2);
  });

  it('replays legacy single-interaction named cassettes as-is (v1 back-compat)', async () => {
    const store = memoryCassetteStore({
      [PATH]: serializeCassette({
        version: CASSETTE_VERSION,
        hash: 'sha256:does-not-match-anything',
        recordedAt: '2026-06-10T12:00:00Z',
        request: {
          modelProvider: 'mock-provider',
          modelId: 'mock-model-id',
          prompt: prompt('whatever'),
        },
        response: {
          type: 'generate',
          content: [{ type: 'text', text: 'legacy reply' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      }),
    });

    const model = wrapLanguageModel({
      model: explodingModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    const result = await withCassette(NAME, () =>
      model.doGenerate({ prompt: prompt('any request at all') }),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'legacy reply' }]);
  });

  it('throws CassetteMissError for an unrecorded call within a multi cassette', async () => {
    const store = memoryCassetteStore();
    const record = wrapLanguageModel({
      model: echoModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    await withCassette(NAME, () => record.doGenerate({ prompt: prompt('recorded') }), {
      mode: 'record',
    });

    const replay = wrapLanguageModel({
      model: explodingModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    await expect(
      withCassette(NAME, () => replay.doGenerate({ prompt: prompt('never recorded') })),
    ).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('handles mixed generate and stream interactions in one named cassette', async () => {
    const store = memoryCassetteStore();
    const chunks: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'streamed' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ];
    const record = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => reply('generated'),
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              for (const part of chunks) c.enqueue(part);
              c.close();
            },
          }),
        }),
      }),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });

    await withCassette(
      NAME,
      async () => {
        await record.doGenerate({ prompt: prompt('one-shot') });
        await record.doStream({ prompt: prompt('streaming') });
      },
      { mode: 'record' },
    );

    const replay = wrapLanguageModel({
      model: explodingModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    await withCassette(NAME, async () => {
      const generated = await replay.doGenerate({ prompt: prompt('one-shot') });
      expect(generated.content).toEqual([{ type: 'text', text: 'generated' }]);

      const { stream } = await replay.doStream({ prompt: prompt('streaming') });
      const reader = stream.getReader();
      const parts: LanguageModelV3StreamPart[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(1);
    });
  });

  it('detects unredacted secrets inside any interaction on replay', async () => {
    const hash = await computeCassetteHash({
      modelProvider: 'mock-provider',
      modelId: 'mock-model-id',
      prompt: prompt('leaky'),
    });
    const store = memoryCassetteStore({
      [PATH]: serializeCassette({
        version: MULTI_CASSETTE_VERSION,
        recordedAt: '2026-06-10T12:00:00Z',
        interactions: [
          {
            hash: `sha256:${hash}`,
            request: {
              modelProvider: 'mock-provider',
              modelId: 'mock-model-id',
              prompt: prompt('leaky'),
            },
            response: {
              type: 'generate',
              content: [{ type: 'text', text: 'hi' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
              warnings: [],
              metadata: { headers: { authorization: 'Bearer leaked' } },
            },
          },
        ],
      }),
    });

    const model = wrapLanguageModel({
      model: explodingModel(),
      middleware: cassetteMiddleware({ cassetteDir: 'mem', store }),
    });
    await expect(
      withCassette(NAME, () => model.doGenerate({ prompt: prompt('leaky') })),
    ).rejects.toBeInstanceOf(CassetteSecretError);
  });
});
