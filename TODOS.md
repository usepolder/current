# Deferred

Things considered and consciously set aside, with the reason. Not a backlog:
an issue implies intent to do, and these are explicitly *not now*. The point of
writing them down is so the same ground is not re-litigated from scratch — if
you are about to argue for one of these, argue against the reason given here.

Revisiting one is cheap. Each entry says what would have to change first.

## Validating the automated checks against something other than ourselves

20 of the 32 metrics are automated, and nothing independent has ever confirmed
that any of them agrees with a human. The dogfood answers file covers the 12
*manual* metrics, deliberately — so it cannot double as ground truth for the
automated ones. The README now states the confidence per axis rather than
implying the whole score is measured (code 5/12, design 7/11, docs 8/9).

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

## Small polish

Each is an afternoon at most. None blocks anyone, which is why none has been
done.

- `--open` to open the report after writing it.
- Name the 0%-code Critical components in the terminal summary, not just the count.
- `current diff <a> <b>` over the history log.
- Copy-to-clipboard on the report's evidence cell.
- An exit-code legend in `--help` for the `fail_under` gate.
