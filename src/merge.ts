// tapedeck — cassette directory merge
//
// Combine cassettes recorded on different machines/branches into one directory
// (the common case: two teammates re-record different tests, both commit, one
// directory wins). Identical files are skipped; same-name files with different
// content are conflicts and are left untouched unless `force` is set.

import { parseCassette, cassettePathForName } from './cassette.js';
import { type CassetteStore, fileCassetteStore } from './store.js';

export interface MergeCassettesOptions {
  /** Overwrite conflicting destination cassettes with the source version. */
  force?: boolean;
  /** Storage backend. Defaults to the filesystem. */
  store?: CassetteStore;
}

export interface MergeCassettesResult {
  /** Cassette filenames copied into the destination. */
  copied: string[];
  /** Filenames present in both directories with identical content. */
  identical: string[];
  /** Filenames present in both with *different* content (overwritten if `force`). */
  conflicts: string[];
}

/**
 * Merge every cassette in `srcDir` into `destDir`. Source files must be valid
 * cassettes (a corrupt one throws `CassetteCorruptError` — better to fail the
 * merge than propagate a broken fixture).
 */
export async function mergeCassetteDirs(
  srcDir: string,
  destDir: string,
  options: MergeCassettesOptions = {},
): Promise<MergeCassettesResult> {
  const store = options.store ?? fileCassetteStore();
  if (!store.list) throw new Error('tapedeck: merge requires a store with list()');

  const result: MergeCassettesResult = { copied: [], identical: [], conflicts: [] };

  for (const name of await store.list(srcDir)) {
    const srcPath = cassettePathForName(srcDir, name);
    const raw = await store.read(srcPath);
    if (raw === null) continue; // raced deletion; nothing to merge
    parseCassette(raw, srcPath); // validate before propagating

    const destPath = cassettePathForName(destDir, name);
    const existing = await store.read(destPath);

    if (existing === null) {
      await store.write(destPath, raw);
      result.copied.push(name);
    } else if (existing === raw) {
      result.identical.push(name);
    } else {
      result.conflicts.push(name);
      if (options.force) await store.write(destPath, raw);
    }
  }

  return result;
}
