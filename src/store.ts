// tapedeck — pluggable cassette storage
//
// The middleware reads/writes cassettes through a `CassetteStore`, not the
// filesystem directly. The default store is filesystem-backed (Node), but the
// abstraction is what makes tapedeck usable on edge runtimes: pass a
// `memoryCassetteStore` (or a KV/R2-backed implementation) and the core never
// touches `node:fs`. The filesystem module is loaded lazily, on first use, so
// importing tapedeck has no Node-only side effects.

/**
 * Storage backend for cassettes. Keys are the paths the middleware computes
 * (`<cassetteDir>/<hash>.cassette.json` or a named file); values are the raw
 * pretty-printed JSON text of a cassette.
 */
export interface CassetteStore {
  /** Return the raw cassette text at `path`, or `null` if it does not exist. */
  read(path: string): Promise<string | null>;
  /** Persist raw cassette text at `path`, creating parents as needed. */
  write(path: string, data: string): Promise<void>;
  /** Optional: list cassette paths under `dir` (used by tooling, not replay). */
  list?(dir: string): Promise<string[]>;
}

/** Last path separator (either `/` or `\`), or -1 if none. */
function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/**
 * The default store: cassettes as files on disk. `node:fs` is imported lazily
 * inside each method so the module itself stays edge-importable.
 */
export function fileCassetteStore(): CassetteStore {
  return {
    async read(path) {
      const { readFile } = await import('node:fs/promises');
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async write(path, data) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const sep = lastSeparator(path);
      if (sep > 0) await mkdir(path.slice(0, sep), { recursive: true });
      await writeFile(path, data, 'utf8');
    },

    async list(dir) {
      const { readdir } = await import('node:fs/promises');
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      return entries.filter((name) => name.endsWith('.json')).sort();
    },
  };
}

/**
 * An in-memory store. Useful for tests and for edge runtimes where cassettes
 * are bundled with the worker (seed the map at build time) rather than read
 * from disk.
 */
export function memoryCassetteStore(
  seed?: Record<string, string> | Map<string, string>,
): CassetteStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>(
    seed instanceof Map ? seed : Object.entries(seed ?? {}),
  );
  return {
    entries,
    async read(path) {
      return entries.get(path) ?? null;
    },
    async write(path, data) {
      entries.set(path, data);
    },
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...entries.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
  };
}
