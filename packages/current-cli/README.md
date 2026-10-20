# @usepolder/current

Component health for design systems. One quadrant answers: **which components are solid in code but weak in Figma, and which are the other way round?**

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

Report written to current-report.html
```

Runs on your machine or in your CI. No server, no account, no database, no telemetry. Nothing leaves your machine except the calls to the Figma API and documentation site you configure.

## What it scores

32 checks across three categories — code, design, documentation — scored per component as `Yes / (Yes + No)`, with N/A excluded. About twenty are checked automatically; the rest need a person, and Current reads those answers from a file you own rather than guessing.

Checks run against your real sources: the component's TypeScript (following its local imports), its Figma node, and its documentation page — including hosted styleguides like ZeroHeight, which are rendered rather than fetched.

**Critical is the top-left of the quadrant**, not the bottom-left. A component that looks finished in Figma but is half-built in code has been signed off and is being referenced in new designs, and the gap is invisible until someone tries to use it.

## Setup

Current reads `.polder.yml`, the same file [Drift](https://github.com/usepolder/drift) and [Reach](https://github.com/usepolder/reach) read, under a `current:` key:

```yaml
current:
  figma:
    file_key: "aBcDeFgHiJkLmNoP"
  components:
    Button:
      code: "src/components/Button/Button.tsx"
      figma: "1:24"
      docs: "docs/button.mdx"        # or a URL to a hosted page
```

```sh
export CURRENT_FIGMA_TOKEN=figd_your_token
npx @usepolder/current figma list      # prints every component with its node id
```

Answers for the metrics that cannot be automated go in `.current.answers.yml`, committed alongside your code as the audit trail.

## Options

```
--json             Full report as JSON
--out <file>       Where to write the HTML report
--no-report        Skip the HTML report
--record-history   Append this run's scores to .current/history.jsonl
--verbose, -v      Trace every metric's resolution to stderr
```

Hosted documentation needs a renderer: `npm i -D playwright && npx playwright install chromium`. It is optional — without it, URL-mapped docs report N/A rather than being scored wrong.

Full documentation, the GitHub Action, and the metric list: **https://github.com/usepolder/current**

## Licence

Apache-2.0
