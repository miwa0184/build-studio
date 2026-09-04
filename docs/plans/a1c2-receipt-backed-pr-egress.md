# Plan: A1c.2 — receipt-backed PR egress

> **Status: implemented locally 2026-09-04.** This slice turns a finalized
> factory-run receipt into one candidate-branch push, one exact pull request
> and one exact-SHA `factory-run-receipt` commit status. It contains no merge,
> tag, deployment, force-push or branch-deletion capability.

## Authority boundary

The request supplies exactly one field: the expected 40-hex candidate SHA.
Repository, branch, base and receipt digest come only from the finalized
receipt and tracked project configuration. Before any remote write, the
server re-verifies all of the following:

- the active admitted run can still finalize the same immutable receipt;
- the local candidate branch still equals the frozen receipt SHA;
- `deployment.repo`, the admitted repository and `origin` name the same
  GitHub repository;
- GitHub reports that repository, its default branch and write permission;
- the tracked worktree is clean;
- a fresh fetch shows the remote default branch still equals the receipt base;
- the exact candidate object exists locally.
- the candidate branch is not the default branch, and any reused PR originates
  from the admitted repository rather than a same-named branch in a fork.

Any disagreement refuses before the first remote mutation.

## Transaction and recovery

Delivery is serialized by the receipt's per-run filesystem lease. Its recovery
journal lives under the already ignored `.build-studio/run-receipt/egress/`
directory and binds run, repository, base, candidate and receipt digest.

External effects are reconciled before they are attempted:

1. If the remote candidate branch is absent, push the exact object with
   `<sha>:refs/heads/<branch>`. If it exists at another SHA, refuse.
2. Reuse an existing open PR only when its head branch, head SHA and base all
   match. Otherwise create one and read it back from GitHub.
3. Publish `factory-run-receipt: success` only after that exact PR is proven.
   The status description binds the receipt digest and the target URL is the
   PR. An exact existing status is reused.

A crash after any external effect is retry-safe: the next call observes the
exact branch, PR or status and continues without creating a second PR or
changing authority. A conflicting retry refuses.

## Deliberately absent

- no default-branch push;
- no merge, auto-merge or founder-acceptance claim;
- no tag or deploy;
- no force-push;
- no local or remote branch deletion;
- no client-selected repository, branch, base, status context or PR number.

GitHub branch protection remains the merge authority. After this slice lands,
`factory-run-receipt` can be made a required status on a managed product
repository and falsified with a negative control.

The first version uses GitHub's commit-status API rather than a Check Run. It
therefore works with the existing authenticated `gh` credential when that
credential has push/PR and commit-status write access; it does not require a
new GitHub App. Every external command is bounded by a 30-second timeout.

## Verification contract

Permanent tests cover pre-mutation drift refusal, exact refspec construction,
status-after-PR ordering, partial-failure replay, conflicting remote branches
and PRs, client-authority rejection, the HTTP body contract and admission-seam
classification. Existing receipt, hold and parser tests remain unchanged and
green.
