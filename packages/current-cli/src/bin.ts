#!/usr/bin/env node
import { run } from './cli';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  version: pkg.version,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    // Anything reaching here is a bug in Current, not bad user input — those
    // are CurrentErrors and were already printed cleanly by run().
    process.stderr.write(`Unexpected error: ${err.stack ?? err.message}\n`);
    process.stderr.write('Please report this at https://github.com/usepolder/current/issues\n');
    process.exitCode = 70;
  });
