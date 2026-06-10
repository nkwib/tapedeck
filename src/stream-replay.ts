// tapedeck — stream replay
//
// Recorded stream parts are replayed as a genuine `ReadableStream` via the SDK's
// own `simulateReadableStream`, so downstream code (streamText, UI message
// streams, etc.) sees exactly the same surface it would from a live provider.
// Delays are nulled out: replay is instantaneous and deterministic.

import { simulateReadableStream } from 'ai';
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';

/** Build a live-shaped stream from recorded chunks. */
export function streamFromChunks(
  chunks: Array<LanguageModelV3StreamPart>,
): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream<LanguageModelV3StreamPart>({
    chunks,
    initialDelayInMs: null,
    chunkDelayInMs: null,
  });
}

/** Build a full `doStream` result from recorded chunks. */
export function replayStreamResult(
  chunks: Array<LanguageModelV3StreamPart>,
): LanguageModelV3StreamResult {
  return { stream: streamFromChunks(chunks) };
}

/**
 * Drain a live stream into an array while preserving the parts verbatim. Used in
 * record mode to capture what the provider emitted before re-serving it.
 */
export async function collectStreamChunks(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<Array<LanguageModelV3StreamPart>> {
  const chunks: Array<LanguageModelV3StreamPart> = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}
