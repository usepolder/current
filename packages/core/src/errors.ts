/**
 * Every failure a user can cause is one of these. The CLI prints `message`
 * and exits with `exitCode` — no stack traces reach the terminal, because a
 * YAML indent typo should read like a lint error, not a Node crash.
 */
export class CurrentError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** A YAML or source file could not be parsed. Carries file:line when known. */
export class ParseError extends CurrentError {
  constructor(file: string, detail: string, line?: number, column?: number) {
    const at = line === undefined ? file : `${file}:${line}${column === undefined ? '' : `:${column}`}`;
    super(`${at} — ${detail}`);
  }
}

/** Config parsed fine but says something impossible. */
export class ConfigValidationError extends CurrentError {}

/** A `code:` or `docs:` path escaped the repo root. */
export class PathTraversalError extends CurrentError {
  constructor(field: string, component: string, value: string) {
    super(
      `${component}.${field}: "${value}" resolves outside the repo root. ` +
        'Paths must stay inside the repository — absolute paths and `..` escapes are rejected.',
    );
  }
}

/** Nothing to score. Almost always a missing `components:` block. */
export class NoComponentsError extends CurrentError {
  constructor(configPath: string) {
    super(
      `No components are mapped in ${configPath}. ` +
        'Add a `components:` block mapping each component to its code path and Figma node id. ' +
        'Run `current figma list` to get the node ids.',
    );
  }
}

/** Figma said no. `retryable` drives the backoff loop; `degradable` drives code-only fallback. */
export class FigmaError extends CurrentError {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    opts: { status?: number | null; retryable?: boolean; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}
