#!/usr/bin/env node
// tapedeck — CLI
//
//   tapedeck record <script> [args...]   run a script with CASSETTE_MODE=record
//   tapedeck replay <script> [args...]   run a script with CASSETTE_MODE=replay
//   tapedeck ls [dir]                    list cassettes in a directory
//   tapedeck diff <a> <b>                semantic diff of two cassette files
//   tapedeck merge <src> <dest>          merge cassette directories (--force overwrites conflicts)
//
// The CLI is Node-only (it spawns processes and reads the filesystem); the
// library core stays edge-safe.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { parseCassette, cassettePathForName } from './cassette.js';
import { diffCassettes, formatCassetteDiff } from './diff.js';
import { CassetteError } from './errors.js';
import { mergeCassetteDirs } from './merge.js';
import { fileCassetteStore } from './store.js';

const HELP = `tapedeck — record/replay cassettes for the Vercel AI SDK

Usage:
  tapedeck record <script> [args...]   Run <script> with CASSETTE_MODE=record
  tapedeck replay <script> [args...]   Run <script> with CASSETTE_MODE=replay
  tapedeck ls [dir]                    List cassettes (default: ./cassettes)
  tapedeck diff <a> <b>                Semantic diff of two cassette files
  tapedeck merge <src> <dest>          Merge cassettes from <src> into <dest>
    --force                            Overwrite conflicting cassettes

Options:
  -h, --help                           Show this help
  -v, --version                        Show the tapedeck version

<script> is run with Node if it is a file path; otherwise it is treated as a
command on PATH (e.g. \`tapedeck record pnpm test\`).
`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

/** Run a script/command with CASSETTE_MODE set; resolves to its exit code. */
function runWithMode(mode: 'record' | 'replay', argv: string[]): Promise<number> {
  const [script, ...args] = argv;
  if (!script) {
    process.stderr.write(`tapedeck ${mode}: missing <script>\n\n${HELP}`);
    return Promise.resolve(2);
  }
  // A file path runs under Node; anything else is a command on PATH.
  const isFile = existsSync(script);
  const command = isFile ? process.execPath : script;
  const commandArgs = isFile ? [script, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: { ...process.env, CASSETTE_MODE: mode },
    });
    child.on('error', (err) => {
      process.stderr.write(`tapedeck ${mode}: failed to start ${command}: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

async function ls(dir = './cassettes'): Promise<number> {
  const store = fileCassetteStore();
  const names = (await store.list?.(dir)) ?? [];
  if (names.length === 0) {
    process.stdout.write(`No cassettes in ${dir}\n`);
    return 0;
  }
  for (const name of names) {
    const path = cassettePathForName(dir, name);
    const raw = await store.read(path);
    if (raw === null) continue;
    try {
      const c = parseCassette(raw, path);
      const kind = c.response.type === 'stream' ? 'stream  ' : 'generate';
      process.stdout.write(
        `${kind}  ${c.request.modelProvider}/${c.request.modelId}  ${c.recordedAt}  ${name}\n`,
      );
    } catch {
      process.stdout.write(`corrupt   ${name}\n`);
    }
  }
  return 0;
}

async function diff(aPath?: string, bPath?: string): Promise<number> {
  if (!aPath || !bPath) {
    process.stderr.write(`tapedeck diff: expected two cassette paths\n\n${HELP}`);
    return 2;
  }
  const store = fileCassetteStore();
  const [rawA, rawB] = await Promise.all([store.read(aPath), store.read(bPath)]);
  if (rawA === null || rawB === null) {
    process.stderr.write(`tapedeck diff: no such file: ${rawA === null ? aPath : bPath}\n`);
    return 2;
  }
  const result = diffCassettes(parseCassette(rawA, aPath), parseCassette(rawB, bPath));
  process.stdout.write(`${formatCassetteDiff(result)}\n`);
  return result.equal ? 0 : 1;
}

async function merge(argv: string[]): Promise<number> {
  const force = argv.includes('--force');
  const [src, dest] = argv.filter((a) => a !== '--force');
  if (!src || !dest) {
    process.stderr.write(`tapedeck merge: expected <src> and <dest> directories\n\n${HELP}`);
    return 2;
  }
  const result = await mergeCassetteDirs(src, dest, { force });
  process.stdout.write(
    `Merged ${src} → ${dest}: ${result.copied.length} copied, ` +
      `${result.identical.length} identical, ${result.conflicts.length} conflict(s)` +
      `${result.conflicts.length > 0 && force ? ' (overwritten)' : ''}\n`,
  );
  for (const name of result.conflicts) {
    process.stdout.write(`  conflict: ${name}\n`);
  }
  // Unresolved conflicts are a failure so CI can catch a bad merge.
  return result.conflicts.length > 0 && !force ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return command ? 0 : 2;
    case '-v':
    case '--version':
      process.stdout.write(`${version()}\n`);
      return 0;
    case 'record':
    case 'replay':
      return runWithMode(command, rest);
    case 'ls':
      return ls(rest[0]);
    case 'diff':
      return diff(rest[0], rest[1]);
    case 'merge':
      return merge(rest);
    default:
      process.stderr.write(`tapedeck: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof CassetteError ? err.message : String(err?.stack ?? err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
