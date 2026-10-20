# @usepolder/current-core

The scoring engine behind [Current](https://github.com/usepolder/current), component health for design systems.

Most people want the CLI instead:

```sh
npx @usepolder/current
```

This package exists so the CLI and the GitHub Action share one engine, and so other tools can score a design system programmatically.

```ts
import { parseConfig, parseAnswers, scanRepo } from '@usepolder/current-core';

const report = await scanRepo({
  repoRoot: process.cwd(),
  config: parseConfig(fs.readFileSync('.polder.yml', 'utf8')),
  answers: parseAnswers(fs.readFileSync('.current.answers.yml', 'utf8')),
});

report.totals;      // { code, design, documentation, overall, basis }
report.components;  // per component: scores, quadrant, every metric with its evidence
```

## What it does

Resolves an explicit component identity map (code path, Figma node id, docs path or URL), runs the automated checks over each source, merges in human answers, and scores each category as `Yes / (Yes + No)` with N/A excluded.

Some deliberate behaviour worth knowing before you build on it:

- **A human answer always beats an automated check.** Nothing silently overrides a person.
- **An unanswerable axis scores `null`, never `0`.** "Nothing applied here" and "everything failed" are different claims.
- **A score resting on too few answered metrics is flagged and left out of the totals**, so a source that could not be read cannot make a system look healthier than it is.
- **Every automated answer carries its evidence**, so no number is a black box.

Reading hosted documentation needs a `PageRenderer`; `createPlaywrightRenderer()` provides one if `playwright` is installed. Without it, URL-mapped docs report N/A rather than being scored wrong.

Full documentation: **https://github.com/usepolder/current**

## Licence

Apache-2.0
