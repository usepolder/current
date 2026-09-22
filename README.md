# Current

Component health for design systems. One quadrant answers: **which components are solid in code but weak in Figma, and which are the other way round?**

Runs on your machine or your CI. No server, no account, no database, no telemetry. Nothing leaves your machine except the calls to the Figma API you configure with your own token.

## Try it

```sh
npx @usepolder/current
```

```
Current — component health

Overall: 71.4%   (code 66.7%, design 82.1%, docs 65.3%)

   18 healthy      4 moderate
    6 critical     4 monitor

  Component        Code  Design    Docs  Quadrant
  Accordion       44.0%  100.0%   56.0%  Critical
  Badge           83.0%  100.0%   71.0%  Healthy
  Button          50.0%   91.0%   56.0%  Critical

Report written to current-report.html
```

The HTML report is the thing you actually share: a quadrant of every component, a sortable table, and the exact evidence behind every automated answer.

## The quadrant

X is code health, Y is design health.

```
          design ▲
   CRITICAL      │      HEALTHY
  design ahead   │    strong in both
   of code       │
  ──────────────┼──────────────▶ code
   MONITOR       │      MODERATE
  weak in both   │   code ahead of
                 │      design
```

**Critical is the top-left**, not the bottom-left. A component that looks finished in Figma but is half-built in code is the expensive kind of broken: it has been signed off, it is being referenced in new designs, and the gap is invisible until someone tries to use it. Weak-in-both is only *Monitor* because nobody is being misled.

Dot colour is documentation health. A dotted outline means fewer than three metrics were answered on an axis, so the score is real but thin.

## The metrics

32 checks across three categories, transcribed from a real design system audit: 12 code, 11 design, 9 documentation. They roll up per category as:

```
score = Yes / (Yes + No)        N/A is excluded from the denominator
```

That is deliberately the same arithmetic a spreadsheet audit uses, because the point is to replace the spreadsheet without changing what the number means.

About 20 of the 32 are checked automatically. The rest need a person, and Current does not pretend otherwise: it reads your answers for those from a file you own.

**Checked automatically** — ARIA attributes present, text alternatives on non-text content, hardcoded colours and px values, component naming, code/Figma property parity, colour + type + spacing + radius token binding, layer naming, Auto Layout, prototype wiring, and whether each documented section exists.

**Left to a human** — interaction-state coverage, keyboard and screenreader behaviour, colour contrast, responsiveness, localisation, whether layers are *necessary*, and whether the docs are any good. Figma's REST API exposes no accessibility annotations (its `AnnotationsTrait` is an empty placeholder in the published OpenAPI spec), so anything resting on that is manual by necessity, not by laziness.

Every automated answer records *why*, visible in the report and in `--verbose`.

## Setup

### 1. Map your components

`.current.yml`:

```yaml
version: 1

figma:
  file_key: "aBcDeFgHiJkLmNoP"

components:
  Button:
    code: "src/components/Button/Button.tsx"
    figma: "1:24"
    docs: "docs/button.mdx"
  Badge:
    code: "src/components/Badge/Badge.tsx"
    figma: "1:37"
```

Names in code, Figma and docs drift apart constantly, so Current will not guess the mapping — an explicit map is a one-time cost and a wrong guess is a permanent lie. A component missing from one side is reported as missing, never silently dropped.

### 2. Get your Figma node ids

```sh
export CURRENT_FIGMA_TOKEN=figd_your_token
npx @usepolder/current figma list
```

This walks the entire document tree, so it finds components nested inside pages, sections and frames, and prints them ready to paste:

```
# Components
  Button:    { figma: "1:24" }  # component set
  Badge:     { figma: "1:37" }
```

The token is read from the environment only. It is never written to a config file.

### 3. Answer the manual metrics

`.current.answers.yml`:

```yaml
Button:
  CO1: Yes      # all interaction states present
  CO3: Yes      # keyboard accessible
  DE2: No       # contrast fails AA
  DO1: "N/A"
```

Commit this. It is the audit trail — the record of what a human checked and when, reviewable in a PR like anything else.

## Configuration

```yaml
version: 1                  # config schema version

quadrant:
  threshold: 60             # percent at or above which an axis counts as strong

min_confidence: 3           # below this many answered metrics, flag the axis as thin
fail_under: 0               # CI gate: exit non-zero below this overall score. 0 = off

metrics:
  disable: ["CO11"]         # drop metrics that do not apply to you
  manual: ["DO5"]           # force an automated metric to manual entry
```

## CLI

```
npx @usepolder/current [dir] [options]
npx @usepolder/current figma list [dir]

--json             Full report as JSON
--out <file>       Where to write the HTML report (default current-report.html)
--no-report        Skip the HTML report
--record-history   Append this run's scores to .current/history.jsonl
--verbose, -v      Trace every metric's resolution to stderr
```

`--verbose` prints one line per metric with the evidence behind it. If you file an issue, paste that.

## GitHub Action

```yaml
name: Current
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: current-history-${{ github.ref }}
  cancel-in-progress: false

jobs:
  current:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: usepolder/current@v1
        env:
          CURRENT_FIGMA_TOKEN: ${{ secrets.CURRENT_FIGMA_TOKEN }}
```

On a pull request it posts one comment, updated in place on every push, with the score and the delta against the base branch. On a push to the default branch it appends a history entry and refreshes the badge.

A PR run **never** writes to the history log. A trend line polluted with speculative branch scores looks authoritative and is wrong.

The `concurrency` block is not optional if you want the history log to survive two pushes landing at once.

## Trend over time

`--record-history` (or a push to your default branch, via the Action) appends one line to `.current/history.jsonl`, and the report draws the trend.

If you change the metric set, the trend line breaks visibly at that point rather than joining two scores that measure different rubrics.

## Badge

The Action writes `.current/badge.json` and `.current/badge.svg` on pushes to the default branch. No hosted service.

```md
<!-- public repos -->
![Current](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/main/.current/badge.json)

<!-- private repos, where shields.io cannot read your raw files -->
![Current](.current/badge.svg)
```

## What it does not do

- **React and TypeScript only**, for the code half. The scanner parses `.ts`/`.tsx`. A Vue or Web Components design system still gets design and documentation scoring, but no automated code metrics.
- **No hosted dashboard.** The report is a file. Put it wherever you put files.
- **No opinion about your rubric.** Every metric can be disabled or made manual. The scoring arithmetic is fixed, because a score you can quietly tune is a score nobody should trust.

## Repo layout

npm workspaces:

- `packages/core` — [`@usepolder/current-core`](https://www.npmjs.com/package/@usepolder/current-core), the scoring engine
- `packages/current-cli` — [`@usepolder/current`](https://www.npmjs.com/package/@usepolder/current), the CLI
- `packages/current-action` — the GitHub Action, bundled with ncc

```sh
npm install
npm test
npm run current -- <path-to-design-system>
```

Releasing: tag `vX.Y.Z` and push. The release workflow runs the suite, verifies the committed Action bundle matches the source, publishes to npm, and cuts the GitHub release.

## Related

[Polder Reach](https://github.com/usepolder/reach) answers a different question about the same design system: of all the UI your product renders, how much came from the system at all? Reach measures adoption; Current measures whether what got adopted is any good.

## Licence

Apache-2.0
