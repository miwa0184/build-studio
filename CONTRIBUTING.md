# Contributing to Build Studio

Thanks for your interest in contributing! This document covers how to propose
changes and the one legal requirement we ask of every contributor.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a CLA. The DCO is a lightweight statement that you wrote the
patch, or otherwise have the right to submit it under the project's license.

You certify the DCO by adding a `Signed-off-by` line to every commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

Git can add this automatically with the `-s` flag:

```bash
git commit -s -m "fix: correct the thing"
```

The name and email must match your real identity (no anonymous or fictitious
contributions). Pull requests whose commits are not signed off will be asked to
amend before merge.

### Full DCO text

The certification you make by signing off is the standard DCO 1.1, available in
full at <https://developercertificate.org/>.

## How to contribute

1. **Open an issue first** for anything beyond a small fix, so we can agree on
   the approach before you invest time.
2. **Fork and branch** from `main`.
3. **Keep changes focused.** One logical change per pull request. Don't mix
   unrelated refactors into a feature or fix.
4. **Match the existing style.** Inline styles + CSS variables in the hub,
   the `createXRouter(config)` pattern in project-server. See `CLAUDE.md` for
   conventions and architecture.
5. **Add or update tests** for behavior changes. Run the project-server test
   suite before opening a PR.
6. **Sign off your commits** (see DCO above).

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): short description` — e.g. `fix(workflow): correct auto-advance timer`.
Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened.
Include your OS, Node version, and relevant logs (with any secrets redacted).

## Fork discipline

Two rules this fork adds on top of upstream. Both are checked by the
`fork-discipline` CI job on every pull request, because a rule that lives only
in prose is a promise, and this project has learned what promises are worth.

### 1. Every commit explains itself

- Subject: `type(scope): summary`, scope optional, one of
  feat / fix / test / docs / chore / refactor / perf / build / ci / revert.
  Let the subject carry the reason, not only the action: "record the sha, so
  the re-review diff is not dead code" beats "record the sha".
- Body: at least fifteen words of prose, trailers excluded. Say what was wrong,
  why the obvious fix does not work if it does not, and what would have to be
  true for the change to be wrong.
- No `Claude-Session:` URLs. The log is public and the link tells a reader
  nothing.

Measured 2026-09-04: none of upstream's last forty-five commits lacked a body;
ten of this fork's thirty-three did, and all ten were recent. The gate exists so
that trend cannot resume quietly.

### 2. The factory stays product-agnostic

Build Studio is a factory. A product's names, test targets, expected counts,
schemes and destinations belong in that product's own tracked configuration, in
that product's repository. None of them belong in factory source or fixtures.

Two reasons, one of each kind. Normative: a correctness contract must be
versioned next to the thing it governs, not scattered through the tool that runs
it. Practical: this repository is public and a product repository may not be, so
anything named here is published.

The check runs on ADDED lines only, so it is a ratchet rather than a sweep.
Existing occurrences are cleaned up by whoever next touches that file, and no
new one can enter.
