# Deferred

Things considered and consciously set aside, with the reason. Not a backlog:
an issue implies intent to do, and these are explicitly *not now*. The point of
writing them down is so the same ground is not re-litigated from scratch — if
you are about to argue for one of these, argue against the reason given here.

Revisiting one is cheap. Each entry says what would have to change first.

## Validating the automated checks against something other than ourselves

25 of the 28 metrics are automated, and nothing independent has ever confirmed
that any of them agrees with a human. The dogfood answers file covers the
*manual* metrics, deliberately — so it cannot double as ground truth for the
automated ones. The README now states the confidence per axis rather than
implying the whole score is measured (code 9/11, design 8/9, docs 8/8).

#36 is what looking rather than validating turns up: DE1, DE4 and DE5 were
scoring Figma's own component-set chrome as raw values, answering No on
components whose every shipped layer bound a token. One bug, found by reading
the checks. Nothing says it is the only one.

Closed as #4. Not reopened as a task, because it is not a coding task: it needs
a design system with both public source and an independent human audit of the
same components, so the two can be compared. Revisit when such a system is to
hand — a client engagement where the audit already exists is the likely way in.

## Non-React code scanners

`walk-ast.ts` parses `.ts` and `.tsx` only. Point Current at a Vue, Svelte or
Web Components system and the code axis comes back blank, which is half the
quadrant missing — worse than refusing, because the number still renders.

Deferred because widening the market before the React case is proven is the
wrong order. Revisit when a non-React team actually asks; until then the honest
move is to say which frameworks are supported, not to half-support more.

## `npx polder` — one entry point for the suite

Run Drift, Reach and Current from one command and print one picture. This is
the strongest item on the roadmap: a shared `.polder.yml` already exists, and
Current already consumes Reach's JSON to rank fixes.

It was blocked on #2 — a suite entry point cannot orchestrate a member that
404s on npm. **That blocker is gone:** all five packages publish via npm trusted
publishing and a weekly audit (`scripts/check-published.mjs`) fails loudly if any
of them stops reaching the registry. What remains is a product decision about
what the combined picture is actually *for*, which no amount of plumbing settles.

## Dashboard revival

Removed from the tree in #7; the implementation lives in a separate repository
and the README had been claiming there wasn't one. Revisit only if a
stakeholder-facing surface becomes a demonstrated need rather than an assumed
one. The HTML report is already shareable, which is the need people usually
mean when they ask for a dashboard.

## Mirroring work into `current-archive`

The private repo keeps the original history and the client demo that cannot be
sanitised. It is an **archive**: features are not mirrored into it. Two repos
with no common ancestor means every mirror is a hand-merge, and a hand-merge
into a repo that holds client data is exactly where that data leaks back out.

Revisit only if something in the archive needs to run, rather than be kept.

## i18n key coverage, orphaned by CO11

CO11 ("component is usable in all supported languages") was dropped from the
rubric in #31: it is language testing, it belongs to the design process, and
its own note conceded it could "only be checked in production".

Removing it orphans one thing that *was* automatable. Checking that every i18n
key a component references resolves in the translation catalogue is a real,
static, answerable claim — `i18n-unused` and friends already do it — and
unlike CO11 it can be answered where the audit runs.

It does not get a metric on the strength of being adjacent to one that was
deleted. Two things would have to change first: a way to discover the
catalogue's location from `.polder.yml` without adding a config key for it
(every new key is a thing an adopter has to learn and a thing this project has
to keep), and someone actually asking for it. A missing-key check nobody
requested would be a norm scoring every adopter on a concern they never
raised, which is precisely what DO1 was.

Not an issue. An issue implies intent to do.

## Small polish

Each is an afternoon at most. None blocks anyone, which is why none has been
done.

- `--open` to open the report after writing it.
- Name the 0%-code Critical components in the terminal summary, not just the count.
- `current diff <a> <b>` over the history log.
- Copy-to-clipboard on the report's evidence cell.
- An exit-code legend in `--help` for the `fail_under` gate.
