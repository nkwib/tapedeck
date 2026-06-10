// Span emission: a fake tracer captures what an OTel tracer would receive.

import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { cassetteMiddleware } from '../src/middleware.js';
import { memoryCassetteStore } from '../src/store.js';
import { CassetteMissError } from '../src/errors.js';
import {
  SPAN_STATUS_ERROR,
  SPAN_STATUS_OK,
  type TapedeckTracer,
} from '../src/telemetry.js';

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

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
  ended: boolean;
}

function fakeTracer(): { tracer: TapedeckTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: TapedeckTracer = {
    startSpan(name) {
      const span: RecordedSpan = { name, attributes: {}, exceptions: [], ended: false };
      spans.push(span);
      return {
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        recordException(exception) {
          span.exceptions.push(exception);
        },
        setStatus(status) {
          span.status = status;
        },
        end() {
          span.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

describe('telemetry', () => {
  it('emits an OK span with mode/hash attributes on record', async () => {
    const { tracer, spans } = fakeTracer();
    const store = memoryCassetteStore();

    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => result }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: 'mem', store, tracer }),
    }).doGenerate(CALL);

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('tapedeck.generate');
    expect(span.attributes['tapedeck.mode']).toBe('record');
    expect(span.attributes['tapedeck.hash']).toMatch(/^sha256:/);
    expect(span.attributes['tapedeck.model_id']).toBe('mock-model-id');
    expect(span.status?.code).toBe(SPAN_STATUS_OK);
    expect(span.ended).toBe(true);
  });

  it('marks a replay hit and records chunk counts for streams', async () => {
    const { tracer, spans } = fakeTracer();
    const store = memoryCassetteStore();

    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => result }),
      middleware: cassetteMiddleware({ mode: 'record', cassetteDir: 'mem', store }),
    }).doGenerate(CALL);

    await wrapLanguageModel({
      model: new MockLanguageModelV3(),
      middleware: cassetteMiddleware({ mode: 'replay', cassetteDir: 'mem', store, tracer }),
    }).doGenerate(CALL);

    const span = spans[0]!;
    expect(span.attributes['tapedeck.mode']).toBe('replay');
    expect(span.attributes['tapedeck.cassette_hit']).toBe(true);
    expect(span.status?.code).toBe(SPAN_STATUS_OK);
  });

  it('records the exception and an error status on a miss', async () => {
    const { tracer, spans } = fakeTracer();

    const model = wrapLanguageModel({
      model: new MockLanguageModelV3(),
      middleware: cassetteMiddleware({
        mode: 'replay',
        cassetteDir: 'mem',
        store: memoryCassetteStore(),
        tracer,
      }),
    });

    await expect(model.doGenerate(CALL)).rejects.toBeInstanceOf(CassetteMissError);

    const span = spans[0]!;
    expect(span.attributes['tapedeck.cassette_hit']).toBe(false);
    expect(span.status?.code).toBe(SPAN_STATUS_ERROR);
    expect(span.exceptions[0]).toBeInstanceOf(CassetteMissError);
    expect(span.ended).toBe(true);
  });

  it('emits no spans in live mode or without a tracer', async () => {
    const { tracer, spans } = fakeTracer();

    await wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => result }),
      middleware: cassetteMiddleware({ mode: 'live', tracer }),
    }).doGenerate(CALL);

    expect(spans).toHaveLength(0);
  });
});
