import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cassetteMiddleware } from '../src/middleware.js';
import { withCassette } from '../src/with-cassette.js';
import {
  CassetteMissError,
  CassetteModeError,
  CassetteSecretError,
} from '../src/errors.js';
import { computeCassetteHash } from '../src/hash.js';
import { writeCassetteFile, cassettePathForHash, CASSETTE_VERSION } from '../src/cassette.js';

// ---- fixtures ---------------------------------------------------------------

const PROMPT: LanguageModelV3CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

const CALL: LanguageModelV3CallOptions = { prompt: PROMPT };

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
};

function generateResult(
  overrides: Partial<LanguageModelV3GenerateResult> = {},
): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text: 'Hi there!' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
    ...overrides,
  };
}

function streamChunks(): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'Hello' },
    { type: 'text-delta', id: '0', delta: ' world' },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

// ---- harness ----------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapedeck-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---- tests ------------------------------------------------------------------

describe('cassetteMiddleware — record', () => {
  it('writes a cassette and returns the live result', async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => generateResult() }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: dir }),
    });

    const result = await model.doGenerate(CALL);

    expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.cassette\.json$/);

    const cassette = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'));
    expect(cassette.version).toBe(CASSETTE_VERSION);
    expect(cassette.hash).toMatch(/^sha256:/);
    expect(cassette.response.type).toBe('generate');
    expect(cassette.response.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
    expect(cassette.request.modelProvider).toBe('mock-provider');
  });
});

describe('cassetteMiddleware — replay', () => {
  it('returns the recorded response without calling the model', async () => {
    // record
    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => generateResult() }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: dir }),
    }).doGenerate(CALL);

    // replay against a model that explodes if invoked
    const replayModel = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('live model must not be called during replay');
        },
      }),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: dir }),
    });

    const result = await replayModel.doGenerate(CALL);
    expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
    expect(result.usage).toEqual(usage);
  });

  it('throws CassetteMissError when no cassette matches', async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => generateResult() }),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: dir }),
    });

    await expect(model.doGenerate(CALL)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('records and replays a stream', async () => {
    await wrapLanguageModel({
      model: new MockLanguageModelV3({
        doStream: async () => ({ stream: arrayToStream(streamChunks()) }),
      }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: dir }),
    }).doStream(CALL);

    const replayModel = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doStream: async () => {
          throw new Error('live model must not be called during replay');
        },
      }),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: dir }),
    });

    const { stream } = await replayModel.doStream(CALL);
    const parts = await drain(stream);
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(2);
    expect(parts.at(-1)?.type).toBe('finish');
  });
});

describe('cassetteMiddleware — live', () => {
  it('passes through and writes nothing', async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => generateResult() }),
      middleware: cassetteMiddleware({ mode: 'live', cassetteDir: dir }),
    });

    const result = await model.doGenerate(CALL);
    expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
    expect(await readdir(dir)).toHaveLength(0);
  });
});

describe('cassetteMiddleware — secret redaction', () => {
  it('redacts matched fields at record time', async () => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () =>
          generateResult({
            response: { headers: { authorization: 'Bearer super-secret-token' } },
          }),
      }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: dir }),
    });

    await model.doGenerate(CALL);

    const files = await readdir(dir);
    const raw = await readFile(join(dir, files[0]!), 'utf8');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).toContain('[REDACTED]');
  });

  it('throws CassetteSecretError when replaying a leaky cassette', async () => {
    const hash = computeCassetteHash({
      modelProvider: 'mock-provider',
      modelId: 'mock-model-id',
      prompt: PROMPT,
    });
    await writeCassetteFile(cassettePathForHash(dir, hash), {
      version: CASSETTE_VERSION,
      hash: `sha256:${hash}`,
      recordedAt: '2026-06-10T12:00:00Z',
      request: { modelProvider: 'mock-provider', modelId: 'mock-model-id', prompt: PROMPT },
      response: {
        type: 'generate',
        content: [{ type: 'text', text: 'hi' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
        metadata: { headers: { authorization: 'Bearer leaked' } },
      },
    });

    const model = wrapLanguageModel({
      model: new MockLanguageModelV3(),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: dir }),
    });

    await expect(model.doGenerate(CALL)).rejects.toBeInstanceOf(CassetteSecretError);
  });
});

describe('cassetteMiddleware — modes & helpers', () => {
  it('rejects an invalid mode eagerly', () => {
    expect(() => cassetteMiddleware({ mode: 'bogus' })).toThrow(CassetteModeError);
  });

  it('withCassette pins a named cassette and forces replay', async () => {
    // record into a fixed name via an explicit cassetteName
    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => generateResult() }),
      middleware: cassetteMiddleware({
        mode: 'record',
        cassetteDir: dir,
        cassetteName: 'checkout-flow.json',
      }),
    }).doGenerate(CALL);

    const files = await readdir(dir);
    expect(files).toContain('checkout-flow.json');

    // replay it through withCassette without touching the live model
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('must not be called');
        },
      }),
      middleware: cassetteMiddleware({ mode: 'live', cassetteDir: dir }),
    });

    const content = await withCassette(
      'checkout-flow.json',
      async () => {
        const r = await model.doGenerate(CALL);
        return r.content;
      },
      { cassetteDir: dir },
    );

    expect(content).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });
});

// Helper: build a ReadableStream from an array of stream parts.
function arrayToStream(
  parts: LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
