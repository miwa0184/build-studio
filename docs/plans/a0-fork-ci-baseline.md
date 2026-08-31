# Plan: A0 — bootstrap this fork's own PR/CI baseline

> **Status: implemented 2026-08-31.** Measured the full baseline from a clean
> `npm ci` on the fork's `main` before any protection or workflow change was
> considered. See *What was measured* below for the result and why this PR
> carries no source fix.

Owner request: before any admission, egress, or platform-onboarding work lands
on this fork, establish that it has its own true, green, protected baseline —
independent of upstream's CI state — and that changes can only reach `main`
through a pull request with a required, up-to-date CI check.

## What was measured

From a clean linked worktree at the fork's `main` head, before this commit:

- `npm ci` — clean install, no tracked file modified.
- `packages/project-server`: `node --test` — **807 passed, 0 failed, 0
  cancelled, 0 skipped, 0 todo**, exit 0, process exited on its own (no
  lingering handle).
- `packages/hub`: `npx next build` — compiled successfully, typechecked,
  static pages generated, exit 0.
- `npm audit --json` — 0 critical, 10 high, 1 moderate, 0 low, across 888
  resolved dependencies. Tool output only; no severity judgement or waiver is
  made here — a human or a separate security-focused pass owns that decision.

An earlier, informal local run had begun reproducing a handful of red tests in
`packages/project-server`, and this fork's upstream is red at the same commit
this fork is pinned to. Neither of those was treated as a fact going in — the
whole baseline was re-run clean, and none of it reproduced: no failing test,
no build error, no state left behind by `npm ci`. Whatever produced the
earlier partial red run did not reproduce here and is not a source defect in
the code at this commit as far as this baseline can show.

This PR therefore carries no test or source fix — there was nothing bounded to
fix. What it does carry is this record, and the CI-protection setup that
depends on a real pull-request run existing to attach a required check to (see
the PR body for the exact GitHub configuration and its before/after state).

## What this does not cover

- Whether Actions' own `ubuntu-latest` + Node 22 environment reproduces
  something this local run (different OS, different Node major) could not —
  that is exactly what this PR's own CI run is for, and any fork-specific gap
  it surfaces gets a bounded, evidenced fix on this same branch rather than a
  guess made ahead of time.
- The dependency advisories `npm audit` reported. Recorded, not triaged here.
- Any admission, egress, or managed-project-facing surface. This PR only
  establishes that changes to this fork arrive through a reviewed pull request
  with a passing, up-to-date CI check — nothing about what that pull request
  is allowed to touch.
