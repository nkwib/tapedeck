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
import type { CassetteResponse } from '../src/cassette.js';
import {
  compareCassetteResponses,
  formatCompareResult,
  summarizeResponse,
  type CassetteCompareResult,
} from '../src/compare.js';
import { CassetteDriftError, CassetteMissError } from '../src/errors.js';
import { cassetteMiddleware } from '../src/middleware.js';

// ---- fixtures ---------------------------------------------------------------

const PROMPT: LanguageModelV3CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'find me a shirt' }] },
];
const CALL: LanguageModelV3CallOptions = { prompt: PROMPT };

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
};

const CONTEXT = {
  hash: 'sha256:abc',
  cassettePath: './cassettes/abc.cassette.json',
  modelProvider: 'mock-provider',
  modelId: 'mock-model-id',
};

function generateResponse(
  overrides: Partial<Extract<CassetteResponse, { type: 'generate' }>> = {},
): CassetteResponse {
  return {
    type: 'generate',
    content: [{ type: 'text', text: 'Here you go.' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
    ...overrides,
  };
}

function toolCall(toolName: string, input: string) {
  return { type: 'tool-call' as const, toolCallId: `call_${toolName}`, toolName, input };
}

function compare(a: CassetteResponse, b: CassetteResponse): CassetteCompareResult {
  return compareCassetteResponses(a, b, CONTEXT);
}

// ---- the comparison engine --------------------------------------------------

describe('compareCassetteResponses: text', () => {
  it('reports an exact match', () => {
    const result = compare(generateResponse(), generateResponse());
    expect(result.equal).toBe(true);
    expect(result.text.status).toBe('exact');
    expect(result.kindChanged).toBe(false);
  });

  it('reports a normalized match and does not call it drift', () => {
    const result = compare(
      generateResponse({ content: [{ type: 'text', text: 'Here you go.' }] }),
      generateResponse({ content: [{ type: 'text', text: '  HERE   you\n go. ' }] }),
    );
    expect(result.text.status).toBe('normalized');
    expect(result.equal).toBe(true);
  });

  it('reports different text as drift', () => {
    const result = compare(
      generateResponse(),
      generateResponse({ content: [{ type: 'text', text: 'Nothing found.' }] }),
    );
    expect(result.text.status).toBe('different');
    expect(result.equal).toBe(false);
  });
});

describe('compareCassetteResponses: tool trajectory', () => {
  it('matches identical trajectories', () => {
    const content = [toolCall('search', '{"q":"shirt"}'), toolCall('checkout', '{"id":1}')];
    const result = compare(generateResponse({ content }), generateResponse({ content }));
    expect(result.toolCalls.equal).toBe(true);
    expect(result.toolCalls.divergedAt).toBeNull();
  });

  it('ignores tool input key order', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', '{"q":"shirt","size":"M"}')] }),
      generateResponse({ content: [toolCall('search', '{"size":"M","q":"shirt"}')] }),
    );
    expect(result.toolCalls.equal).toBe(true);
    expect(result.equal).toBe(true);
  });

  it('pinpoints a changed tool name', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', '{}'), toolCall('checkout', '{}')] }),
      generateResponse({ content: [toolCall('search', '{}'), toolCall('refund', '{}')] }),
    );
    expect(result.equal).toBe(false);
    expect(result.toolCalls.divergedAt).toBe(1);
    expect(result.toolCalls.reason).toContain("call 2: tool 'checkout' != 'refund'");
  });

  it('pinpoints a changed tool input', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', '{"q":"shirt"}')] }),
      generateResponse({ content: [toolCall('search', '{"q":"shoes"}')] }),
    );
    expect(result.equal).toBe(false);
    expect(result.toolCalls.reason).toContain("call 1 ('search'): input changed");
  });

  it('reports a trajectory that got longer', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', '{}')] }),
      generateResponse({ content: [toolCall('search', '{}'), toolCall('checkout', '{}')] }),
    );
    expect(result.equal).toBe(false);
    expect(result.toolCalls.divergedAt).toBe(1);
    expect(result.toolCalls.reason).toContain('cassette stopped');
  });

  it('keeps a non-JSON tool input verbatim', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', 'not json')] }),
      generateResponse({ content: [toolCall('search', 'not json')] }),
    );
    expect(result.toolCalls.recorded[0]?.input).toBe('not json');
    expect(result.toolCalls.equal).toBe(true);
  });
});

describe('compareCassetteResponses: finish reason', () => {
  it('reports a changed finish reason', () => {
    const result = compare(
      generateResponse(),
      generateResponse({ finishReason: { unified: 'length', raw: 'max_tokens' } }),
    );
    expect(result.equal).toBe(false);
    expect(result.finishReason).toMatchObject({ equal: false, recorded: 'stop', live: 'length' });
  });

  it('ignores a changed provider-raw finish reason', () => {
    const result = compare(
      generateResponse(),
      generateResponse({ finishReason: { unified: 'stop', raw: 'end_turn' } }),
    );
    expect(result.finishReason.equal).toBe(true);
    expect(result.equal).toBe(true);
  });

  it('reads a bare-string finish reason from an older cassette', () => {
    // Pre-v3 recordings stored `finishReason: 'stop'` rather than { unified, raw }.
    const legacy = generateResponse({
      finishReason: 'stop' as unknown as LanguageModelV3GenerateResult['finishReason'],
    });
    expect(summarizeResponse(legacy).finishReason).toBe('stop');
    expect(compare(legacy, generateResponse()).finishReason.equal).toBe(true);
  });
});

describe('compareCassetteResponses: streams', () => {
  const chunks = (deltas: string[], tools: string[] = []): CassetteResponse => ({
    type: 'stream',
    chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '0' },
      ...deltas.map((delta) => ({ type: 'text-delta' as const, id: '0', delta })),
      { type: 'text-end', id: '0' },
      ...tools.map((name) => toolCall(name, '{}')),
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ] as LanguageModelV3StreamPart[],
  });

  it('concatenates deltas before comparing text', () => {
    const result = compare(chunks(['Hello', ' world']), chunks(['Hello world']));
    expect(result.text.status).toBe('exact');
    expect(result.kind).toBe('stream');
  });

  it('compares the streamed tool trajectory', () => {
    const result = compare(chunks(['hi'], ['search']), chunks(['hi'], ['search', 'checkout']));
    expect(result.equal).toBe(false);
    expect(result.toolCalls.divergedAt).toBe(1);
  });

  it('flags a cassette recorded in the other kind', () => {
    const result = compare(generateResponse(), chunks(['Here you go.']));
    expect(result.kindChanged).toBe(true);
    expect(result.equal).toBe(false);
  });
});

describe('formatCompareResult', () => {
  it('renders the trajectory and the first divergence', () => {
    const result = compare(
      generateResponse({ content: [toolCall('search', '{"q":"shirt"}')] }),
      generateResponse({ content: [toolCall('refund', '{"q":"shirt"}')] }),
    );
    const text = formatCompareResult(result);
    expect(text).toContain("call 1: tool 'search' != 'refund'");
    expect(text).toContain('cassette: search(');
    expect(text).toContain('live:     refund(');
  });

  it('says so when there is no drift', () => {
    expect(formatCompareResult(compare(generateResponse(), generateResponse()))).toContain(
      'No drift',
    );
  });
});

// ---- compare mode through the middleware ------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapedeck-compare-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function modelReturning(result: () => LanguageModelV3GenerateResult, mode: string, extra = {}) {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({ doGenerate: async () => result() }),
    middleware: cassetteMiddleware({ mode, cassetteDir: dir, ...extra }),
  });
}

function live(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

async function recordOnce(text: string): Promise<void> {
  await modelReturning(() => live(text), 'record').doGenerate(CALL);
}

describe('cassetteMiddleware: compare mode', () => {
  it('reports a matching response and leaves the cassette untouched', async () => {
    await recordOnce('Here you go.');
    const [name] = await readdir(dir);
    const before = await readFile(join(dir, name!), 'utf8');

    const reports: CassetteCompareResult[] = [];
    const result = await modelReturning(() => live('Here you go.'), 'compare', {
      onCompare: (r: CassetteCompareResult) => reports.push(r),
    }).doGenerate(CALL);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.equal).toBe(true);
    expect(reports[0]?.cassettePath).toContain('.cassette.json');
    expect(result.content).toEqual([{ type: 'text', text: 'Here you go.' }]);
    expect(await readFile(join(dir, name!), 'utf8')).toBe(before);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('throws CassetteDriftError when nothing handles the report', async () => {
    await recordOnce('Here you go.');
    const model = modelReturning(() => live('Nothing found.'), 'compare');

    await expect(model.doGenerate(CALL)).rejects.toBeInstanceOf(CassetteDriftError);
  });

  it('carries the structured report on the error', async () => {
    await recordOnce('Here you go.');
    const model = modelReturning(() => live('Nothing found.'), 'compare');

    const error = await model.doGenerate(CALL).catch((e: unknown) => e as CassetteDriftError);
    expect(error).toBeInstanceOf(CassetteDriftError);
    expect(error.result.text).toMatchObject({
      status: 'different',
      recorded: 'Here you go.',
      live: 'Nothing found.',
    });
    expect(error.message).toContain('CASSETTE_MODE=record');
  });

  it('hands the failure policy to onCompare instead of throwing', async () => {
    await recordOnce('Here you go.');
    const reports: CassetteCompareResult[] = [];
    const result = await modelReturning(() => live('Nothing found.'), 'compare', {
      onCompare: (r: CassetteCompareResult) => reports.push(r),
    }).doGenerate(CALL);

    expect(reports[0]?.equal).toBe(false);
    // compare returns the LIVE response: it is a live run with a drift check.
    expect(result.content).toEqual([{ type: 'text', text: 'Nothing found.' }]);
  });

  it('treats a missing cassette as a miss, not as a pass', async () => {
    const model = modelReturning(() => live('Here you go.'), 'compare');
    await expect(model.doGenerate(CALL)).rejects.toBeInstanceOf(CassetteMissError);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('compares streams and still serves the live stream to the caller', async () => {
    const streamOf = (deltas: string[]) => async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          for (const delta of deltas) controller.enqueue({ type: 'text-delta', id: '0', delta });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
          controller.close();
        },
      }),
    });

    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doStream: streamOf(['Hello', ' world']) }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: dir }),
    }).doStream(CALL);

    const reports: CassetteCompareResult[] = [];
    const { stream } = await wrapLanguageModel({
      model: new MockLanguageModelV3({ doStream: streamOf(['Goodbye']) }),
      middleware: cassetteMiddleware({
        mode: 'compare',
        cassetteDir: dir,
        onCompare: (r) => reports.push(r),
      }),
    }).doStream(CALL);

    const parts: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    expect(reports[0]?.kind).toBe('stream');
    expect(reports[0]?.equal).toBe(false);
    expect(reports[0]?.text).toMatchObject({ recorded: 'Hello world', live: 'Goodbye' });
    // The caller still receives the live stream, verbatim.
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('compares an interaction inside a named multi-cassette', async () => {
    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => live('Here you go.') }),
      middleware: cassetteMiddleware({
        mode: 'record',
        cassetteDir: dir,
        cassetteName: 'flow.json',
      }),
    }).doGenerate(CALL);

    const reports: CassetteCompareResult[] = [];
    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => live('Here you go.') }),
      middleware: cassetteMiddleware({
        mode: 'compare',
        cassetteDir: dir,
        cassetteName: 'flow.json',
        onCompare: (r) => reports.push(r),
      }),
    }).doGenerate(CALL);

    expect(reports[0]?.equal).toBe(true);
    expect(reports[0]?.cassettePath).toContain('flow.json');
  });
});
