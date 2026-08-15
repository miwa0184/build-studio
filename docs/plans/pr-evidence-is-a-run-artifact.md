# Plan: treat PR evidence as a run artifact, not a source artifact

> **Status: parts 1 and 2 implemented 2026-08-12; part 3 PARKED 2026-08-15.**
> The ignore rule and the untracking landed here and in every managed project.
> Four days later the growth is confirmed stopped — zero tracked evidence
> binaries anywhere, and no commit has touched evidence since the untracking
> commit itself, across several runs. `.git` is unchanged (1.5 GB and 206 MB in
> the two worst cases), exactly as predicted.
>
> **Owner decision: do not rewrite history.** ~1 GB reclaimed against rewriting
> every commit id in two repositories under active terminal work, plus re-clones
> and rebases for anything in flight. Static dead weight is cheap; the
> compounding was the problem and it is fixed. Revisit only if a hosting limit
> or a clone time actually starts to hurt — and pick a moment with no work in
> flight in those repos.
>
> **Status: proposed 2026-08-11.** Measured across the managed projects; the
> verifier compatibility question below is answered, the history-rewrite half is
> deliberately deferred.

Workflow runs capture visual smoke screenshots into
`docs/pr-evidence/<PRD-basename>/visual/` and the engine **commits them**. The
capture is valuable. The permanent retention is not, and it is the dominant
cost in the repositories that have run the most visual PRDs.

## What was measured

Across the managed projects, `.git` size against evidence in the working tree:

| project | `.git` | evidence | note |
|---|---|---|---|
| A (iOS) | 1583 MB | 272 MB | 1 060 MB of evidence PNGs *in history* |
| B | 206 MB | 189 MB | evidence is ~92% of the repository |
| C | 130 MB | 1 MB | |
| D–I | 3–66 MB | 1–4 MB | few visual runs so far |

Project A in detail:

- evidence PNGs in history — **1 060 MB**; snapshot-test PNGs — 196 MB
- **480 evidence blobs, 368 MB, added in one fortnight** — roughly a quarter of
  the repository's entire history
- up to **21 committed versions of a single ~2 MB screenshot**

PNGs do not delta-compress, so each regeneration is a full blob retained
forever. The growth is not capture volume; it is **re-capture**. At the observed
rate A crosses the common 5 GB hosting limit within months.

Projects D–I are small only because they have run fewer visual PRDs. Nothing
protects them; they receive the same instruction.

## Nothing reads it

In project A every reference to `docs/pr-evidence/` outside `docs/` is a
**writer** — UI test targets that render screenshots into those directories. No
test asserts against them, no CI job consumes them, no script validates them.
The writers use absolute machine-local paths, which is itself evidence they were
never a portable artifact.

The distinction that matters: **snapshot-test baselines are not this.** Those are
fixtures a test compares against and must stay versioned. Only the evidence
directories are in question.

## What the evidence is actually for

The instruction couples three things into the word *commit*:

1. **Generate** the screenshots — the visual smoke itself. Needed.
2. **Make them readable during the run** — the AC verifier checks cited artifact
   paths, and the owner may want to look. Needed.
3. **Retain them in history forever** — nothing consumes this.

Only (3) is in question, and only (3) has a cost. The plausible justifications
do not survive contact with the repositories: historical visual reference is
better served by snapshot tests (versioned for exactly that, at a fifth the
size), review context is transient and belongs on the PR or in a CI artifact
with a retention policy, and no managed project carries an audit requirement
that names these files.

## The compatibility question, answered

**The AC verifier is filesystem-based, not git-based.** It resolves each cited
path and calls `exists()`:

```js
const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
if (exists(abs)) foundAny = true;
```

A generated-then-ignored file is present in the worktree that produced it, so
ignoring evidence does **not** break visual ACs. This was the one thing capable
of turning a disk-hygiene change into nine simultaneously failing runs, so it
was checked before proposing anything.

The current retention path is the `merge_to_main` auto-commit: cross-PRD drift
is reverted (that guard already exists), then `git add -A -- docs` sweeps
whatever remains, including this run's own evidence. Once evidence is ignored,
the sweep skips it naturally and the cross-PRD revert becomes a no-op for it —
there is nothing tracked left to drift.

## Proposal

**1. Stop the growth (this repository).** Change the capture instruction from
"commit screenshots to …" to "write screenshots to …, which is ignored", and add
the ignore rule to the project scaffold so newly onboarded projects never begin
accumulating. Keep the markdown notes that reference evidence — prose is cheap
and is the part that gets read.

**2. Stop the growth (each managed project).** Add the ignore rule and untrack
the existing files. One command per project; it changes no history and is
reversible.

**3. Reclaim history — deferred, deliberately.** A rewrite recovers ~1 GB in the
worst-affected project, but rewrites every commit id. That is a coordination
cost across forks, open PRs and unpushed local work, and it should not ride
along with a hygiene change. Land 1 and 2, confirm the curve flattens, then
decide. Static dead weight is tolerable in a way that compounding dead weight is
not, and the decision is much easier once nothing new is landing.

## Downstream impact — the changelog has to carry this

This changes behaviour in repositories that are **not** this one, which is the
step most easily missed. The entry must say, explicitly:

- **In Build Studio** — rebuild, inject, restart.
- **In each managed project** — the ignore rule to add, the untrack command to
  run, and that untracking removes the files from future commits but **not from
  history**.
- **The history question** — state plainly that existing evidence stays in
  history and that reclaiming it requires a rewrite the puller must choose
  deliberately. Give the measurement command so a reader can size their own
  problem rather than guess, and name the risk (every commit id changes) rather
  than linking a tool and leaving them to discover it.

A reader who pulls this and only adds the ignore rule has stopped their growth
and lost nothing. That should be the default path, with the rewrite presented as
an opt-in for whoever has actually accumulated a problem.

## Open questions

- **Is any evidence worth keeping?** A single "current state" screenshot per
  surface, overwritten in place, would cost almost nothing and might serve the
  historical-reference case the run artifacts do not. Worth deciding before
  ignoring the directory wholesale, because reintroducing it later means
  re-authoring the capture step.
- **Retention on disk.** Ignored evidence accumulates in working trees instead of
  history. Harmless at current sizes, but a sweep of old run directories may be
  worth offering once the ignore lands.
- **The `path.isAbsolute(rel) ? rel : …` in the verifier** honours absolute
  paths from agent-authored feedback. It only calls `exists()` and returns the
  path in a "missing" list, so it discloses existence and nothing more — noted
  here rather than filed, since the same pattern in a reader was a real finding.
