// tapedeck — error types
//
// Every error tapedeck throws extends `CassetteError` so consumers can catch the
// whole family with a single `instanceof` check, while still being able to
// discriminate on the concrete subclass for tailored handling.

/** Base class for all tapedeck errors. */
export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown in `replay` mode when no cassette matches the request.
 *
 * The message embeds the computed hash and a recovery hint so a failing CI run
 * tells the developer exactly what to re-record.
 */
export class CassetteMissError extends CassetteError {
  readonly hash: string;
  readonly cassetteDir: string;
  /** The file tapedeck looked for (hash- or name-addressed). */
  readonly cassettePath: string;

  constructor(args: { hash: string; cassetteDir: string; cassettePath: string }) {
    super(
      `tapedeck: no cassette found for hash "${args.hash}".\n` +
        `  Looked for: ${args.cassettePath}\n` +
        `  Cassette dir: ${args.cassetteDir}\n` +
        `  The request changed or was never recorded. Re-run this test with ` +
        `CASSETTE_MODE=record against the live API, then commit the cassette.`,
    );
    this.hash = args.hash;
    this.cassetteDir = args.cassetteDir;
    this.cassettePath = args.cassettePath;
  }
}

/**
 * Thrown when a cassette being replayed still contains values that the redact
 * matchers would have stripped — i.e. a secret leaked into a committed cassette.
 */
export class CassetteSecretError extends CassetteError {
  /** Dotted paths within the cassette where unredacted secrets were detected. */
  readonly paths: string[];
  readonly cassettePath: string | undefined;

  constructor(args: { paths: string[]; cassettePath?: string }) {
    super(
      `tapedeck: unredacted secrets detected in cassette` +
        (args.cassettePath ? ` (${args.cassettePath})` : '') +
        `.\n  Offending fields: ${args.paths.join(', ')}\n` +
        `  Re-record with matching \`redact\` matchers before committing.`,
    );
    this.paths = args.paths;
    this.cassettePath = args.cassettePath;
  }
}

/** Thrown when a cassette file is unreadable: bad JSON, wrong version, or malformed. */
export class CassetteCorruptError extends CassetteError {
  readonly cassettePath: string;
  readonly reason: string;

  constructor(args: { cassettePath: string; reason: string }) {
    super(`tapedeck: corrupt cassette at ${args.cassettePath}: ${args.reason}`);
    this.cassettePath = args.cassettePath;
    this.reason = args.reason;
  }
}

/** Thrown when an invalid mode string is supplied to the middleware. */
export class CassetteModeError extends CassetteError {
  readonly mode: string;

  constructor(mode: string) {
    super(
      `tapedeck: invalid mode "${mode}". Expected one of: record, replay, live.`,
    );
    this.mode = mode;
  }
}
