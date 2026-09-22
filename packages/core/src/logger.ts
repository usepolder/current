/**
 * Verbose tracing. As the maintainer of an OSS tool you can never see a
 * user's private repo or Figma file — the only diagnostic you will ever get
 * is what they paste into an issue. `--verbose` makes that paste useful.
 */
export interface Logger {
  trace(message: string): void;
  enabled: boolean;
}

export function createLogger(enabled: boolean, sink: (line: string) => void = defaultSink): Logger {
  return {
    enabled,
    trace(message: string) {
      if (enabled) sink(message);
    },
  };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const silentLogger: Logger = createLogger(false, () => {});
