import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cassette } from '../src/cassette.js';
import { CASSETTE_VERSION, serializeCassette } from '../src/cassette.js';
import { diffCassettes, formatCassetteDiff } from '../src/diff.js';
import { mergeCassetteDirs } from '../src/merge.js';
import { CassetteCorruptError } from '../src/errors.js';

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
};

function cassette(overrides: { text?: string; prompt?: string; hash?: string } = {}): Cassette {
  return {
    version: CASSETTE_VERSION,
    hash: overrides.hash ?? 'sha256:aaa',
    recordedAt: '2026-06-10T12:00:00Z',
    request: {
      modelProvider: 'mock-provider',
      modelId: 'mock-model-id',
      prompt: [
        { role: 'user', content: [{ type: 'text', text: overrides.prompt ?? 'hello' }] },
      ],
    },
    response: {
      type: 'generate',
      content: [{ type: 'text', text: overrides.text ?? 'Hi there!' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  };
}

describe('diffCassettes', () => {
  it('treats identical cassettes (modulo recordedAt) as equal', () => {
    const a = cassette();
    const b = { ...cassette(), recordedAt: '2027-01-01T00:00:00Z' };
    const diff = diffCassettes(a, b);
    expect(diff.equal).toBe(true);
    expect(formatCassetteDiff(diff)).toMatch(/identical/);
  });

  it('pinpoints a changed prompt with a dotted path', () => {
    const diff = diffCassettes(
      cassette(),
      cassette({ prompt: 'goodbye', hash: 'sha256:bbb' }),
    );
    expect(diff.equal).toBe(false);
    expect(diff.hashChanged).toBe(true);
    expect(diff.request).toEqual([
      { path: 'request.prompt[0].content[0].text', a: 'hello', b: 'goodbye' },
    ]);
    expect(diff.response).toEqual([]);
    expect(formatCassetteDiff(diff)).toContain('request.prompt[0].content[0].text');
  });

  it('reports absent fields and response divergence', () => {
    const diff = diffCassettes(cassette(), cassette({ text: 'Bye!' }));
    expect(diff.hashChanged).toBe(false);
    expect(diff.response).toEqual([
      { path: 'response.content[0].text', a: 'Hi there!', b: 'Bye!' },
    ]);
  });
});

describe('mergeCassetteDirs', () => {
  let src: string;
  let dest: string;

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), 'tapedeck-src-'));
    dest = await mkdtemp(join(tmpdir(), 'tapedeck-dest-'));
  });

  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  });

  async function put(dir: string, name: string, c: Cassette): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), serializeCassette(c), 'utf8');
  }

  it('copies new, skips identical, reports conflicts', async () => {
    await put(src, 'new.cassette.json', cassette());
    await put(src, 'same.cassette.json', cassette());
    await put(dest, 'same.cassette.json', cassette());
    await put(src, 'clash.cassette.json', cassette({ text: 'src version' }));
    await put(dest, 'clash.cassette.json', cassette({ text: 'dest version' }));

    const result = await mergeCassetteDirs(src, dest);
    expect(result.copied).toEqual(['new.cassette.json']);
    expect(result.identical).toEqual(['same.cassette.json']);
    expect(result.conflicts).toEqual(['clash.cassette.json']);

    // conflict untouched without force
    const kept = JSON.parse(await readFile(join(dest, 'clash.cassette.json'), 'utf8'));
    expect(kept.response.content[0].text).toBe('dest version');
  });

  it('overwrites conflicts with force', async () => {
    await put(src, 'clash.cassette.json', cassette({ text: 'src version' }));
    await put(dest, 'clash.cassette.json', cassette({ text: 'dest version' }));

    const result = await mergeCassetteDirs(src, dest, { force: true });
    expect(result.conflicts).toEqual(['clash.cassette.json']);

    const overwritten = JSON.parse(await readFile(join(dest, 'clash.cassette.json'), 'utf8'));
    expect(overwritten.response.content[0].text).toBe('src version');
  });

  it('refuses to propagate a corrupt source cassette', async () => {
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'bad.cassette.json'), '{ not json', 'utf8');
    await expect(mergeCassetteDirs(src, dest)).rejects.toBeInstanceOf(CassetteCorruptError);
  });
});
