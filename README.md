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

## What to fix first

*Critical* says how a component is broken, not how much it matters. A broken Divider and a broken Button land in the same corner, and only one of them is on every screen you ship.

Give Current a [Reach](https://github.com/usepolder/reach) report and it ranks what is actually in use:

```bash
npx @usepolder/reach --json > reach.json
npx @usepolder/current --usage reach.json
```

```
Fix first (weakest of code/design, weighted by use):
  1. Button   code 50.0%     9 uses (47.4% of DS usage)  priority 50.0
  2. Tag      code 57.1%     3 uses (15.8% of DS usage)  priority 14.3
```

`priority = (100 − weakest of code and design) × uses ÷ uses of the busiest component`. It is linear, so you can check it by hand, and the raw counts are printed beside it. Documentation is left out: a thin doc page is worth fixing, but it is not what makes a component urgent.

Only components below the quadrant threshold on code or design, and actually used, are listed. A weak component nothing renders is not on the list. Usage changes the ranking and nothing else: axis scores, quadrants and the headline total are identical with or without it.

Components Reach saw in use that are not mapped in `.polder.yml` are named, since a heavily used component nobody is scoring is its own finding. Set `usage: "reach.json"` under `current:` to make it permanent, and it is what the Action uses. It needs Reach's report from schema 2 onwards (the one with a `usage` object). An older report is rejected rather than read as "nothing is used".

## The metrics

32 checks across three categories, transcribed from a real design system audit: 12 code, 11 design, 9 documentation. They roll up per category as:

```
score = Yes / (Yes + No)        N/A is excluded from the denominator
```

That is deliberately the same arithmetic a spreadsheet audit uses, because the point is to replace the spreadsheet without changing what the number means.

About 20 of the 32 are checked automatically. (This is the default set; [you can change it](#your-own-norms).) The rest need a person, and Current does not pretend otherwise: it reads your answers for those from a file you own.

**Checked automatically** — ARIA attributes present, text alternatives on non-text content, hardcoded colours and px values, component naming, code/Figma property parity, colour + type + spacing + radius token binding, layer naming, Auto Layout, prototype wiring, and whether each documented section exists.

**Left to a human** — interaction-state coverage, keyboard and screenreader behaviour, colour contrast, responsiveness, localisation, whether layers are *necessary*, and whether the docs are any good. Figma's REST API exposes no accessibility annotations (its `AnnotationsTrait` is an empty placeholder in the published OpenAPI spec), so anything resting on that is manual by necessity, not by laziness.

The documentation checks look for a matching section heading, with synonyms and a tolerance for plurals. That proves a section exists, not that it says anything useful — a heading check is the honest ceiling for static analysis of prose. Matching is anchored to the start of a heading, so Button's "Icon Usage" does not satisfy "usage guidelines are documented". One thing it structurally cannot do is tell **not applicable** from **not documented**; only the person auditing knows which, which is why the manual answer always wins.

Every automated answer records *why*, visible in the report and in `--verbose`.

**What the code checks read.** The file named in `code:`, plus the files it imports from its own directory, followed transitively: `Button.styles.ts`, `Button.module.css`, a `./variants` folder. That is what the hardcoded-value check scans, and its evidence says how many files it read. It does not follow imports out of the component's directory, such as a shared `../tokens` or another component, and it never counts a file that is mapped as a different component. Property parity reads the component's own parameter and its `Props` type, so a hook's destructured return value is not mistaken for a prop. ARIA and text-alternative checks still look at the entry file only.

## Setup

### 1. Map your components

Current reads `.polder.yml` — the same file [Drift](https://github.com/usepolder/drift) and [Reach](https://github.com/usepolder/reach) read — under a `current:` key:

```yaml
component_library: "@acme/design-system"   # Drift and Reach; Current ignores it

current:
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

One toolchain, one config file. A repo already set up for Drift or Reach gains a block rather than a second file.

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

### 3. Point at your documentation

`docs:` takes either a path in the repo or a URL:

```yaml
components:
  Button:
    docs: "docs/button.mdx"                              # markdown in the repo
  Badge:
    docs: "https://your.styleguide.com/p/123-badge"      # a hosted page
```

Hosted pages need a renderer, because tools like ZeroHeight, Supernova and Storybook build their pages in the browser — fetching the HTML gets you an empty shell. Install it once:

```sh
npm i -D playwright && npx playwright install chromium
```

In the GitHub Action you install nothing: when a `docs:` entry is a URL, the Action fetches `playwright-core` (pinned, about 2 MB, no install scripts) into the runner's temp directory and drives the Chrome that GitHub-hosted runners already ship, downloading Chromium only if there is none. If that setup fails, for instance with no network, the docs metrics report N/A with the reason in the evidence and the run adds a warning; the job does not fail. A repo with only local docs never triggers any of this.

For the CLI it is an **optional** dependency. If you document in the repo, or you do not score documentation at all, you never install it and `npx @usepolder/current` stays small. Without it, URL-mapped docs report as N/A with that hint — never as "undocumented", because "we could not look" and "we looked and found nothing" are different answers.

### 4. Answer the manual metrics

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
current:
  version: 1                  # config schema version

  quadrant:
    threshold: 60             # percent at or above which an axis counts as strong

  min_confidence: 3           # below this many answered metrics, an axis is "thin":
                              # flagged per component, and left out of the headline
                              # average so an unmeasurable component cannot inflate it
  fail_under: 0               # CI gate: exit non-zero below this overall score. 0 = off
  usage: "reach.json"         # Reach JSON report; ranks "fix first" by use. Repo-relative

  metrics:
    disable: ["CO11"]         # drop metrics that do not apply to you
    manual: ["DO5"]           # force an automated metric to manual entry
```

## Your own norms

The 32 metrics are a starting point, not a standard you have to adopt. Every organisation prioritises different things, so all of them can be changed, and you can add your own.

```yaml
current:
  metrics:
    # Reword or re-tune a built-in norm
    override:
      DO2:
        guideline: "Usage guidance lives in the styleguide"
        params: { headings: ["usage", "best practices", "when to use"] }

    # Add norms of your own
    custom:
      - id: ORG1
        category: code                  # code | design | documentation
        subcategory: Security           # optional
        guideline: "Never injects raw HTML"
        check: code.forbids             # automated...
        params: { text: ["dangerouslySetInnerHTML"] }

      - id: ORG2
        category: documentation
        guideline: "Migration notes are documented"
        check: docs.section
        params: { headings: ["migration", "upgrading"] }

      - id: ORG3
        category: design
        guideline: "Has a dark-mode variant"    # ...or no `check`: answered by a person
```

**If it can be checked automatically, it is. If not, a person answers it.** A custom norm with no `check` is manual: it appears in the report like any other, and its answers go in `.current.answers.yml` next to the built-in manual ones.

```yaml
Button:
  ORG3: Yes
```

The checks a norm can name:

| Check | Yes when | `params` |
|---|---|---|
| `docs.section` | the docs have a heading starting with one of these | `headings: [...]` |
| `code.contains` | the component's source contains at least one of these | `text: [...]` |
| `code.forbids` | the component's source contains none of these | `text: [...]` |
| `code.aria-attributes`, `code.text-alternatives`, `code.token-usage`, `code.semantic-name`, `code.figma-prop-parity` | as in [the metrics](#the-metrics) | none |
| `design.color-tokens`, `design.type-tokens`, `design.spacing-tokens`, `design.radius-tokens`, `design.layer-names`, `design.prototyping`, `design.auto-layout` | as in [the metrics](#the-metrics) | none |

A check must match its category: `code.*` scores a code norm, `design.*` a design norm, `docs.*` a documentation norm.

Things worth knowing:

- **`code.contains` and `code.forbids` match literal text**, case-sensitively, across the entry file and the files it imports from its own directory (the same files the hardcoded-value check reads). Comments are ignored, so "// never use dangerouslySetInnerHTML" is not a use of it. They are not regexes: this config is read straight off pull-request branches, including forks, and a pattern from a fork can hang the runner.
- **`override` replaces, it does not extend.** Setting `params` swaps the whole list, so to add one heading to DO2 you repeat the defaults. Setting `check` without `params` on a check that needs them is an error.
- **`override` changes what a built-in checks, not how it is scored.** You can reword it, re-tune its params, or point it at a different check. To move a norm to another category, disable it and add a custom one.
- **Typos are errors, not silent no-ops.** An unknown key, an unknown check, a duplicate id, or a `check` in the wrong category fails with the path of the norm at fault.
- **Changing what is measured breaks the trend line**, the same as adding or removing a metric. Adding a norm, changing an override's `check` or `params`, or forcing a built-in to manual all count. Rewording a guideline does not.

## CLI

```
npx @usepolder/current [dir] [options]
npx @usepolder/current figma list [dir]

--json             Full report as JSON
--out <file>       Where to write the HTML report (default current-report.html)
--usage <file>     Reach JSON report, to rank what to fix first by use
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
      - uses: usepolder/current@v0.1.0
        env:
          CURRENT_FIGMA_TOKEN: ${{ secrets.CURRENT_FIGMA_TOKEN }}
```

On a pull request it posts one comment, updated in place on every push, with the score and the delta against the base branch. On a push to the default branch it appends a history entry, refreshes the badge, and **commits and pushes** those files (`.current/history.jsonl`, `badge.json`, `badge.svg`) as `github-actions[bot]`, with `[skip ci]` in the message. That commit is what gives later PRs a base to compare against.

This needs `permissions: contents: write` and the credentials `actions/checkout` leaves in place (its default). If your default branch is protected, allow `github-actions[bot]` to push to it. When the push fails the run still reports the score and adds a warning saying why; it does not fail the job.

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

- **Tell "not applicable" from "not documented".** A missing section is a missing section; whether it *should* be there is a judgement only you can make. Answer it by hand and Current will defer to you.
- **React and TypeScript only**, for the code half. The scanner parses `.ts`/`.tsx`. A Vue or Web Components design system still gets design and documentation scoring, but no automated code metrics.
- **No hosted dashboard.** The report is a file. Put it wherever you put files.
- **No opinion about your rubric.** Every metric can be disabled, made manual, reworded or re-tuned, and you can [add your own](#your-own-norms). The scoring arithmetic is fixed, and every norm counts equally: a score you can quietly tune is a score nobody should trust. To make something matter more, add more norms about it.

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

Three tools, three subjects:

| | Looks at | Answers |
|---|---|---|
| [**Drift**](https://github.com/usepolder/drift) | your product code | which lines bypass the design system? |
| [**Reach**](https://github.com/usepolder/reach) | your product code | how much of the UI you render came from it? |
| **Current** | the design system itself | is each component actually any good? |

Drift and Reach ask whether people are adopting the system. Current asks whether it is worth adopting. All three read the same `.polder.yml`.

## Licence

Apache-2.0
