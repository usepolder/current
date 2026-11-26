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

Current asks one question of a design system: **is it built robustly enough to be reused without drifting?** Drift is what happens when a component cannot be used as-is. Someone detaches the Figma instance, wraps or forks the code, or works from docs that describe an API that no longer exists, and from then on the system and the product disagree. The norms measure the things that prevent that: tokens applied, the component API, and agreement between code, Figma and docs.

29 norms across three categories: 11 code, 10 design, 8 documentation. They roll up per category as:

```
score = Yes / (Yes + No)        N/A is excluded from the denominator
```

That is deliberately the same arithmetic a spreadsheet audit uses, because the point is to replace the spreadsheet without changing what the number means.

All 29 are checked automatically. (This is the default set; [you can change it](#your-own-norms).) Where a check cannot settle a case it says so and hands that case to a person, and Current reads their answer from a file you own.

**What is not here, and why.** The rubric started as a real design system's audit sheet of 32 norms. Twelve have gone, and the gaps in the ids are the record; ids are never reused, so an answers file always points at the norm it was written for.

- **Accessibility audits** (CO1–CO5, CO13, DE2, DO9). Whether a component's *output* is accessible — what renders, what a screen reader announces, what contrast a pixel has — is product quality, and axe, Lighthouse and testing with assistive technology answer it better than a rubric can. Scoring it here made the number mean two things at once. The checks are not deleted; [add them back](#accessibility-checks-opt-in) if you want them scored. ([#39](https://github.com/usepolder/current/issues/39))
- **DE8** "all layers, groups and frames are necessary" was tidiness: nobody acts on it from a quadrant and no API field answers it.
- **DE11** "Figma component reflects what's in code" asked exactly what **CO12** asks from the other side, and scoring one claim twice weights it twice. CO12 keeps it, [answered from Code Connect](#5-connect-code-to-figma-optional).
- **CO11** "usable in all supported languages" was language testing, and its own note said it "can only be checked in production". A norm that cannot be answered where the audit runs is a reminder, not a norm.
- **DO1** "component statuses are up to date" was a relic of one system's status taxonomy, which most systems do not have.

The axes are not equally trustworthy:

| Axis | Automated | Checked against a human verdict? |
| --- | --- | --- |
| Code | 11 of 11 | **No.** Never, on any component. Three of the eleven do not read source at all: CO6 and CO10 probe a browser, CO12 reads your Code Connect mappings. |
| Design | 10 of 10 | Yes for DE1–DE10, per metric, against a hand-audited production system. **Not DE12 or DE13**, which are newer and rest on Figma fields this project has not yet seen on a live file (below). |
| Documentation | 8 of 8 | Not separately. Its checks match a heading, and the evidence string shows which heading matched. |

The code axis is the only one whose automation has never been compared
against a person answering the same question on real source. Validating it
needs a design system with both its source and an independent human audit of
the same components, which this project does not yet have
([#4](https://github.com/usepolder/current/issues/4)).

That matters more than it sounds, because code is the X axis: the quadrant's
central claim is that a system can be designed consistently and built
inconsistently, and the half carrying that claim is the half with no evidence
behind its automation. The design-axis validation, by contrast, found a real
bug — a check reading Figma bound-variable keys that Figma never emits, wrong
on every component it looked at.

One design check carries a version of that same risk right now. **DE6** reads
`variantOptions` off a variant property, which Figma's published OpenAPI spec
declares on both `ComponentNode` and `ComponentSetNode` — but no run of this
tool has yet seen that field come back from a real file, because the example
system it dogfoods against has no Figma file behind it. The field is in the
contract and the check is tested against the shape the contract describes;
until a real file confirms it, that is a spec-backed check and not a
file-backed one, which is a weaker thing. **DE12** is in the same position
and more so: it reads `componentPropertyReferences` (with its `characters`
and `mainComponent` keys) to tell whether a label or nested instance is bound
to a property, and **DE13** reads `layoutSizingHorizontal`, `maxWidth` and
the text style's `textAutoResize` and `textTruncation`. The spec declares
all of them; no run has observed them. Until one does, treat a DE12 or DE13
`No` as worth checking by hand before acting on it. The `#1:2` suffix on property keys
is the mirror image: observed on every real file, documented nowhere, so every
reader here strips it when present and none requires it.

**Checked automatically** — hardcoded colours and px values, whether a component can be extended without forking it (ref forwarded, unknown props passed on, `className` merged), whether it hardcodes copy a consumer cannot change, whether its imports stay inside the system and go through other components' entry points, component naming, code/Figma property parity in names, variant values and defaults, whether the code declares which Figma node it implements, colour + type + spacing + radius token binding, layer naming, Auto Layout, whether labels and nested instances are exposed as component properties rather than needing a detach, whether the Figma layout survives longer text, which interaction states the Figma component declares, whether those states are wired up, whether each documented section exists, whether a local props table lists the props the code actually accepts, and — for components with a `preview:` URL — breakpoint overflow and whether the layout survives 40% more text, probed in a real browser.

### Answering what automation hands back

No default norm needs a person by design, but two kinds of question still reach one: a case a check declines to settle, and any norm you [flip to manual](#configuration). The main one in the default set is **DE6**, when a Figma component declares no interaction states at all — the API cannot tell a Divider that needs none from a Button that forgot its hover state.

On a large system that is still a lot of typing into YAML, so `current export` writes exactly the questions outstanding to a CSV, with the automated findings for that component's axis beside each one:

| component | metric | guideline | answer | automated_evidence |
| --- | --- | --- | --- | --- |
| Badge | DE6 | Includes interaction states | | DE1 Yes: all 4 relevant layer(s) bind colour tokens \| DE10 Yes: layoutMode is HORIZONTAL |

Fill in the answer column, then `current import` folds it back into
`.polder.answers.yml`. Three things follow from that shape:

- **The review splits across people.** Questions carry their category, so the
  code ones can go to an engineer and the design ones to a designer at once.
- **A blank cell stays unanswered.** It does not become `N/A`. The report keeps
  saying nobody has judged it, which is the honest thing for it to say.
- **Resume is free.** Re-export after an import and the answered rows are gone:
  the file only ever contains what is still outstanding.

Columns are read by name, so sorting or adding columns in a spreadsheet is safe.

The documentation checks look for a matching section heading, with synonyms and a tolerance for plurals. That proves a section exists, not that it says anything useful — a heading check is the honest ceiling for static analysis of prose. Matching is anchored to the start of a heading, so Button's "Icon Usage" does not satisfy "usage guidelines are documented". One thing it structurally cannot do is tell **not applicable** from **not documented**; only the person auditing knows which, which is why the manual answer always wins.

Every automated answer records *why*, visible in the report and in `--verbose`.

**What the code checks read.** The file named in `code:`, plus the files it imports from its own directory, followed transitively: `Button.styles.ts`, `Button.module.css`, a `./variants` folder. That is what the hardcoded-value check scans, and its evidence says how many files it read. It does not follow imports out of the component's directory, such as a shared `../tokens` or another component, and it never counts a file that is mapped as a different component. Property parity reads the component's own parameter and its `Props` type, so a hook's destructured return value is not mistaken for a prop. ARIA and text-alternative checks still look at the entry file only.

## Setup

### 0. Or let it write the mapping for you

```sh
export CURRENT_FIGMA_TOKEN=figd_your_token
npx @usepolder/current init --figma aBcDeFgHiJkLmNoP
```

`init` scans for component source, walks the Figma file, and writes the
`current:` block with the two matched up. It is the fastest way to a first
score, and it is careful about four things:

- **It never overwrites.** No `.polder.yml` means it writes one; an existing
  file without a `current:` block gains one and nothing else is touched; a file
  that already has one is refused, so running it twice cannot clobber your
  mapping. That matters because the file is shared with Drift and Reach.
- **It only maps exact name matches.** Anything softer — `ButtonGroup` against
  Figma's `Button Group`, or two Figma components with the same name — is
  written **commented out** with the reason, for you to confirm. A guess that
  looks like a decision is worse than a gap.
- **It accounts for both sides.** A Figma component that matched no source
  file is written in too, commented out and with no invented `code:` path, and
  counted and named in the summary. Design finished ahead of code is the
  critical corner of the quadrant; it would be a strange tool that scaffolded
  your config by quietly leaving it out.
- **It writes once, at the end.** A Figma walk that fails leaves nothing behind.

Everything below is the same file written by hand. Read it either way: `init`
gives you a starting point, not a finished config.

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
      preview: "http://localhost:6006/iframe.html?id=button--primary"
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

Pages are rendered four at a time in one browser, so run time no longer grows linearly with the number of documented components, and two components pointing at the same page cost one render. A page that fails still fails on its own: the rest of the pages are rendered, and only the components mapped to that page go N/A.

For the CLI it is an **optional** dependency. If you document in the repo, or you do not score documentation at all, you never install it and `npx @usepolder/current` stays small. Without it, URL-mapped docs report as N/A with that hint — never as "undocumented", because "we could not look" and "we looked and found nothing" are different answers.

### 4. Point at a rendered preview (optional)

Two norms cannot be answered from source at all. Whether a component survives 320px does not follow from its CSS, because that depends on its fonts and its content. And whether its bounds hold is not visible in its CSS either, because it depends on the length of the text that ends up in it. So those two are *probed*: give a component a URL that renders it in isolation and Current drives a real browser at it.

```yaml
components:
  Button:
    code: "src/components/Button/Button.tsx"
    preview: "http://localhost:6006/iframe.html?id=button--primary"   # a Storybook story
```

- **CO6, breakpoints.** Loads the preview at each width in `params: { widths: [...] }`, default `320, 375, 768, 1024, 1280, 1920`, and fails any width where the document scrolls sideways or an element's right edge sits past the viewport. `position: fixed` elements are exempt, so a tooltip pinned to the edge is not a finding. Probe the edges of *your* breakpoints: a layout breaks at a boundary, not in the middle of a range.
- **CO10, declared bounds.** Re-renders the preview with its text pseudo-localized — every word swapped for an accented look-alike and grown about 40%, so `Save changes` becomes `[Śàṽéàé ćĥàńĝéśàéî]` — and measures what that broke, at every CO6 width. Content that now pushes the viewport sideways is a `No`. Content that now spills out of a container which neither clips nor scrolls is a `No`. Text that is now cut off is a `No` **only when nothing declared it may be**: a `text-overflow: ellipsis`, a line clamp, a `max-width` or a `max-height` is the author saying this text truncates, which is CO10 being satisfied rather than failed. Same for `overflow: auto` — that is the author saying the content may exceed the box.

Neither claims a layout is *good*: CO6 only that nothing overflows, which is the part a machine can see; CO10 only that bounds exist and hold, never that they are the *right* bounds. CO10 says nothing about whether the component is translated, translatable or RTL-safe, and nothing about text a consumer passes in, which is part of why the expansion is proportional to the text that is actually there.

Every CO10 finding is a **difference** against the same measurement taken before the text was touched. That is not a refinement, it is the whole validity of the check: measured against real markup, a flex row whose children already spilled and a button whose label was already clipped both showed up, and charging CO10 for breakage that pre-dates the expansion would be reporting another norm's bug under this one.

It is not a localisation metric. Pseudo-localization never tests a language — its output is not a language. It is a text-expansion stress test, and text expansion is the force that reveals whether bounds were declared at all.

No `preview:`, no browser launched and both norms report `N/A` — and so does a preview that will not load, with the navigation error in the evidence. A broken Storybook build must never read as a system that fails its breakpoints norm.

One caveat worth stating plainly: point this at a *component*, not at a page. A whole-page URL measures the page's chrome along with the component.

#### Accessibility checks (opt-in)

The default rubric does not score accessibility ([why](#the-metrics)), but every accessibility check Current has is still there. A custom norm can name any check, so to have them scored, add this to `.polder.yml`:

```yaml
current:
  metrics:
    custom:
      - { id: A11Y1, category: code, subcategory: A11y, check: code.states,
          guideline: "Component encompasses and displays all necessary interaction states" }
      - { id: A11Y2, category: code, subcategory: A11y, check: code.aria-attributes,
          guideline: "ARIA attributes are defined" }
      - { id: A11Y3, category: code, subcategory: A11y, check: code.keyboard,
          guideline: "Component is accessible by keyboard" }
      - { id: A11Y4, category: code, subcategory: A11y, check: code.screenreader,
          guideline: "Component is accessible by screenreader" }
      - { id: A11Y5, category: code, subcategory: A11y, check: code.text-alternatives,
          guideline: "Non-text content has a text alternative that serves the equivalent purpose" }
      - { id: A11Y6, category: code, subcategory: A11y, check: code.contrast,
          guideline: "Text contrast meets WCAG AA in the rendered component" }
      - { id: A11Y7, category: documentation, subcategory: A11y, check: docs.section,
          guideline: "A11y guidelines are documented",
          params: { headings: [accessibility, a11y, aria] } }
```

They take new ids on purpose. CO1–CO5, CO13 and DO9 are retired, and Current refuses a custom norm that reuses a retired id: an answers file written for the old norm would silently answer the new one.

The rendered ones need a `preview:` URL like CO6 and CO10, and each is an **optional** dependency resolved lazily: not installed, and the norm reports `N/A` with the install hint. In the Action, the browser, the virtual screen reader and the contrast engine are fetched on demand (pinned, no install scripts), and a failed fetch reports `N/A` with a warning rather than failing the run.

- **`code.states`, interaction states.** Forces `:hover` and `:hover:active` on each interactive element — the same thing DevTools' "force element state" does, over CDP, so no `mousedown` fires and the probe never trips the component's own handlers — and compares the result with that element's resting style. A control that looks identical on hover is a `No`; so is one that looks identical while pressed, and so is one whose focus state is invisible. Transitions and animations are switched off first, or a hover behind `transition: background 200ms` would read as no change at all. It never answers `Yes`: three of the nine states can be forced on a rendered element, and loading, selected, active, error and disabled need the component driven through its props, which one URL cannot do. A clean probe is an `N/A` that says what it verified, and stays in the questions `current export` writes out.
- **`code.keyboard`.** Tabs through the preview. An interactive element Tab never reaches is a `No`. A Tab stop whose appearance does not change when focused is a `No` (WCAG 2.4.7) — an outline, a ring shadow, an inverted background or a thicker border all count. It does not claim Space, Enter and the arrow keys *do the right thing*: a preview of native controls is `Yes` because the platform supplies those semantics, and one with a custom widget is `N/A` with the widget named.
- **`code.screenreader`.** Drives [`@guidepup/virtual-screen-reader`](https://github.com/guidepup/virtual-screen-reader) over the preview — a screen reader implemented in JavaScript against the accessibility tree — and reports what it announced. An interactive element with no accessible name is a `No`: announced as a bare `button`. One with interaction wired to it but no role is a `No`: a focusable `<div>` sounds exactly like a paragraph. A control that declares a state the reader never announces is a `No` — `<a href aria-pressed="true">` announces `link, More`. An element the reader never announced at all is named in the evidence but not scored, since hiding a duplicate from the tree is sometimes right.
- **`code.contrast`.** Runs [`accessibility-checker-engine`](https://github.com/IBMa/equal-access) (IBM Equal Access, Apache-2.0) in the page and keeps **only** its WCAG 1.4.3 findings, so it never double-scores what the other checks own. Text below the AA ratio for its size and weight is a `No`, with the engine's own number in the evidence. Where the background cannot be determined — text over an image, text with a shadow, the same colour both ways — the engine declines to guess and so does the check: those elements are `N/A` and named. Text only: the engine has no WCAG 1.4.11 rule, so icon contrast is measured by nothing here. It reads the rendered code, never the Figma design.
- **`code.aria-attributes`, `code.text-alternatives`.** Read the component's source for `aria-*` attributes and for `alt` text and labels on non-text content.

**`code.screenreader` answers `Yes` only from real assistive technology.** A virtual reader can prove a component is *not* screen-reader accessible and cannot prove it is, so a clean virtual read is an `N/A`. To earn the `Yes`, add `params: { driver: real }` to that norm. That also drives the platform's own screen reader through [`@guidepup/guidepup`](https://github.com/guidepup/guidepup) — **VoiceOver** on macOS, **NVDA** on Windows, **Orca** on Linux — over the same page, and a walk it completes is what turns a clean read into a `Yes`. The virtual reader still produces every finding, because real assistive technology hands back spoken phrases with no DOM node to attribute a finding to. It needs a visible, frontmost browser, so it is for your own machine or a self-hosted runner, not `ubuntu-latest`, and the Action does not fetch it: `npm i -D @guidepup/guidepup` where you want it. Asking for it where it is unavailable is not a failure — the virtual reader answers and the evidence says why.

### 5. Connect code to Figma (optional)

CO12 asks whether a component's composition mirrors the Figma component it is built from. That is the one norm where the two sides of the audit have to agree with each other, and [Figma Code Connect](https://developers.figma.com/docs/code-connect/) is where a team writes that agreement down:

```tsx
// src/components/Button/Button.figma.tsx
import figma from '@figma/code-connect/react';
import { Button } from './Button';

figma.connect(Button, 'https://www.figma.com/design/<file-key>/DS?node-id=1-24', {
  props: { label: figma.string('Label'), size: figma.enum('Size', { Small: 'small' }) },
  example: ({ label, size }) => <Button size={size}>{label}</Button>,
});
```

Current reads those calls out of the repo and answers CO12 from them:

- **Yes** — a `figma.connect()` names this component and points at the node `.polder.yml` maps it to. The evidence names the file and the node, so the answer is checkable.
- **No** — the repo uses Code Connect and this component has no mapping, or its mapping points at a *different* node than the one being audited. That second case is the interesting one: it catches a component whose Figma counterpart was swapped, renamed or forked while the code kept pointing at the old node.
- **N/A** — the repo has no Code Connect at all. It needs a paid Figma plan and a publish step, so "this team does not use it" and "this component is missing its mapping" are different findings, and only the second is a `No`. Answer CO12 by hand, as before, and nothing about your score changes.

Two things to know about how the mappings are found. They are read from the repo, not from Figma, because no REST endpoint reports published Code Connect mappings — and the repo holds the source `figma connect publish` reads anyway, so this answers the same question one step earlier. And they are found by Code Connect's own convention: files named `*.figma.ts`/`*.figma.tsx` anywhere in the repo (`node_modules` and build directories excluded), plus any `figma.connect()` written into the component's own file. Custom `codeConnect.include` globs in `figma.config.json` are not expanded, so a repo that keeps its mappings somewhere else entirely reports N/A rather than a wrong No.

### 6. Answer what automation hands back

`.polder.answers.yml`:

```yaml
Badge:
  DE6: "N/A"    # a static label: it needs no interaction states
Button:
  CO10: "N/A"   # takes whatever width it is given; nothing to declare
```

An answer here wins over the automated one, so it is also how a team records a judgment the check could not make.

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
    disable: ["DO7"]          # drop metrics that do not apply to you
    manual: ["DO5"]           # force an automated metric to manual entry
```

## Your own norms

The 29 metrics are a starting point, not a standard you have to adopt. Every organisation prioritises different things, so all of them can be changed, and you can add your own.

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

**If it can be checked automatically, it is. If not, a person answers it.** A custom norm with no `check` is manual: it appears in the report like any other, and its answers go in `.polder.answers.yml` next to the built-in manual ones.

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
| `code.aria-attributes`, `code.text-alternatives`, `code.token-usage`, `code.semantic-name`, `code.figma-prop-parity`, `code.figma-connect` | as in [the metrics](#the-metrics) | none |
| `design.color-tokens`, `design.type-tokens`, `design.spacing-tokens`, `design.radius-tokens` | as in [the metrics](#the-metrics) | `min_bound: 100` (optional) |
| `code.keyboard`, `code.states` | as in [a rendered preview](#4-point-at-a-rendered-preview-optional) — `code.states` never answers `Yes` | none |
| `code.screenreader` | a real screen reader walked the page and the virtual one found no defect; `virtual` alone never answers `Yes` | `driver: "virtual" \| "real"` (optional) |
| `code.breakpoints` | nothing overflows the viewport at any of these widths | `widths: [320, 375, 768, 1024, 1280, 1920]` (optional) |
| `code.text-expansion` | the layout holds with every word grown ~40% | the widths from `code.breakpoints` |
| `code.contrast` | every text element meets the WCAG AA ratio for its size | none |
| `design.interaction-states` | the Figma component declares every state in this list | `states: [hover, pressed, disabled]` (optional) |
| `design.layer-names`, `design.prototyping`, `design.auto-layout` | as in [the metrics](#the-metrics) | none |

A check must match its category: `code.*` scores a code norm, `design.*` a design norm, `docs.*` a documentation norm.

Things worth knowing:

- **`code.contains` and `code.forbids` match literal text**, case-sensitively, across the entry file and the files it imports from its own directory (the same files the hardcoded-value check reads). Comments are ignored, so "// never use dangerouslySetInnerHTML" is not a use of it. They are not regexes: this config is read straight off pull-request branches, including forks, and a pattern from a fork can hang the runner.
- **The four token checks answer Yes only when *every* relevant layer binds a token.** That is `min_bound: 100`, the default, and it is strict on purpose: one hardcoded colour among four hundred layers is still a hardcoded colour. It also means these checks ask a narrower question than a hand audit usually does — an auditor looking at a component that is 97% tokenised will often call it tokenised, and Current will not. Set `min_bound` to the percent you actually mean:

  ```yaml
  current:
    metrics:
      override:
        DE1: { params: { min_bound: 90 } }   # 90% of layers is good enough
  ```

  The evidence names the ratio either way, so `11 of 151 layer(s) use raw radius tokens` is visible whichever side of the threshold it falls. A threshold is rejected outside 1-100: at 0 a component binding nothing would answer Yes.
- **The token checks measure the layers that ship, not Figma's own chrome.** Figma strokes a component set's wrapper in `#9747FF`, spaces its variants out with raw `itemSpacing`, and gives it a corner radius; it paints a `SECTION` the same purple. None of that was designed and none of it renders anywhere a user can see, so `COMPONENT_SET`, `SECTION` and `SLICE` nodes are left out of what DE1, DE3, DE4 and DE5 count — the population is the variants inside and their layers. This matters more than it sounds at `min_bound: 100`, where one wrapper was enough to answer `No` on a component whose every real layer bound a token. If your layer counts are lower than they used to be, this is why.
- **`design.interaction-states` asks for three states, not nine.** DE6's guideline lists nine; the check defaults to `hover, pressed, disabled`, the ones anything a pointer can act on has to have. Asking for all of them would report a `No` on nearly every component in a healthy system, because most components legitimately need only some — which is exactly why this norm used to be a human's. Name the set your system actually models:

  ```yaml
  current:
    metrics:
      override:
        DE6: { params: { states: [hover, pressed, focus, disabled, loading] } }
  ```

  A state counts as declared when a variant option names it (`State=Hover`) or a boolean property's name does (`Disabled`), matched against a synonym list — `active` is read as pressed, `busy` as loading, `checked` as selected, `invalid` as error. `focus` is not in the default because Figma files very often draw a focus ring as a shared overlay rather than a variant, and CO1 probes focus from the browser where it is actually visible. The evidence names which property expressed which state, and a component that declares **no** interaction state anywhere answers `N/A`, not `No`: nothing in the API distinguishes a Divider that needs none from a Button that forgot them.
- **DE6 and DE9 ask different questions.** DE6 is *which states exist*, read off the component's property definitions. DE9 is *is this thing interactive at all* — satisfied by one state-named variant option, a `State` property, or a prototype interaction a user can trigger. A set whose only property is `Size` no longer satisfies DE9; it used to, which left the "interaction states" half of that guideline unenforced.
- **`override` replaces, it does not extend.** Setting `params` swaps the whole list, so to add one heading to DO2 you repeat the defaults. Setting `check` without `params` on a check that needs them is an error.
- **`override` changes what a built-in checks, not how it is scored.** You can reword it, re-tune its params, or point it at a different check. To move a norm to another category, disable it and add a custom one.
- **Typos are errors, not silent no-ops.** An unknown key, an unknown check, a duplicate id, or a `check` in the wrong category fails with the path of the norm at fault.
- **Changing what is measured breaks the trend line**, the same as adding or removing a metric. Adding a norm, changing an override's `check` or `params`, or forcing a built-in to manual all count — `min_bound` included, since re-tuning it changes what the score means. So does **upgrading Current itself**, when the release changes what a built-in norm checks: a norm that moves from a human's answer to an automated check measures something different afterwards, and the line resets rather than joining the two. Rewording a guideline does not.

## CLI

```
npx @usepolder/current [dir] [options]
npx @usepolder/current init [dir] [--figma <file-key>]
npx @usepolder/current export [dir] [--file <csv>]
npx @usepolder/current import [dir] [--file <csv>]
npx @usepolder/current figma list [dir]

--json             Full report as JSON
--figma <key>      init only: match component names against this Figma file
--file <csv>       export/import only: the CSV path (default current-answers.csv)
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
      - uses: usepolder/current@v0.5.0
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

[TODOS.md](TODOS.md) records what else was considered and set aside, and what would have to change for each one to be worth doing.

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

`npm test` launches no browser, by design: every test injects a fake prober, so CI needs no browser binary. That leaves the preview checks — CO6 and CO10 by default, and the opt-in accessibility checks — with the one part of their correctness that lives outside TypeScript, since their findings depend on what Chromium builds and, for the screen reader and contrast checks, on what a third-party engine says about it. `scripts/probe-fixtures.mjs` covers that gap against real HTML in a real browser, and it is not decoration: it caught two screen-reader bugs and three silently unstyled CO10 fixtures that every local test passed. Run it after touching anything on the probe path.

One thing it does **not** cover: the screen-reader check's `driver: real` is exercised with the screen readers faked. Driving VoiceOver, NVDA or Orca for real needs a desktop session, so the gate, the fall-back and the verdict are tested and the readers themselves are not.

```sh
npm i -D playwright && npx playwright install chromium
npm run build && node scripts/probe-fixtures.mjs
```

Releasing: tag `vX.Y.Z` and push. The release workflow runs the suite, builds the Action bundle, commits it on top of the tagged commit and **moves the tag onto that commit**, then publishes to npm and cuts the GitHub release.

The bundle is not committed to `main` — `current.yml` builds it per run, so nothing in the repo has to be kept in step with the source by hand. But `action.yml` names `packages/current-action/dist/index.js` as its entry point and GitHub builds nothing for a consuming workflow, so the bundle has to be in the tree a consumer resolves. Hence the tag move: `uses: usepolder/current@vX.Y.Z` keeps working, at the cost of a published tag that is not immutable. If you fetched a release tag in the seconds before the workflow moved it, `git fetch --tags --force` gets you the real one, and the commit a release tag points at is deliberately not on `main`.

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
