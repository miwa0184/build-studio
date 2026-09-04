# Plan: A1c.2 — receipt-backed PR egress

> **Status: implemented locally 2026-09-04.** This slice turns a finalized
> factory-run receipt into one candidate-branch push, one exact pull request
> and one exact-SHA `factory-run-receipt` commit status. It contains no merge,
> tag, deployment, existing-ref update or branch-deletion capability.

## Authority boundary

The request supplies exactly one field: the expected 40-hex candidate SHA.
Repository, branch, base and receipt digest come only from the finalized
receipt and tracked project configuration. Before any remote write, the
server re-verifies all of the following:

- the active admitted run can still finalize the same immutable receipt;
- the local candidate branch still equals the frozen receipt SHA;
- `deployment.repo`, the admitted repository and the single effective fetch
  and push URLs for `origin` name the same GitHub repository;
- neither effective URL matches another active `insteadOf` or `pushInsteadOf`
  prefix, preventing Git from rewriting a URL a second time at transport;
- GitHub reports that repository, its default branch and write permission;
- the tracked worktree is clean;
- a fresh fetch shows the remote default branch still equals the receipt base;
- the exact candidate object exists locally.
- the candidate branch is not the default branch, and any reused PR originates
  from the admitted repository rather than a same-named branch in a fork.

Any disagreement refuses before the first remote mutation.
Typed delivery refusals identify the installed capability as
`receipt_pr_delivery`; they must not reuse the earlier `not_installed` marker.

## Transaction and recovery

Delivery is serialized by the receipt's per-run filesystem lease. Its recovery
journal lives under the already ignored `.build-studio/run-receipt/egress/`
directory and binds run, repository, base, candidate and receipt digest. The
journal is an append-only chain of exclusive per-stage files. Each stage binds
the digest of its predecessor; the complete chain is re-read immediately before
every external mutation. Unknown entries, gaps, overwritten evidence and any
symlink in the real receipt or journal authority path fail closed.

External effects are reconciled before they are attempted:

1. If the remote candidate branch is absent, push the exact object with a
   zero-old-value `--force-with-lease=<ref>:` compare-and-swap. Despite Git's
   option name this can only create an absent ref; it cannot update any
   existing branch. The verified URL is passed directly, so a separate
   `remote.origin.pushurl` cannot redirect the write.
2. Reuse a PR only when it is open and its repository, head branch, head SHA,
   base branch and base SHA all match. A closed or merged PR for the branch is
   a conflict and is never replaced.
3. Publish `factory-run-receipt: success` only after that exact PR is proven.
   Before publication, a durable `status_pending` journal step creates a
   random nonce. The status description binds the full receipt digest and that
   nonce; its target URL is the PR. All commit-status pages are read before a
   decision, so an older conflicting context cannot hide beyond page one. A
   retry may reuse only that journal-bound status, and reads it back before
   recording delivery.

A crash after any external effect is retry-safe: the next call observes the
exact branch, PR or status and continues without creating a second PR or
changing authority. A conflicting retry refuses.

## Deliberately absent

- no default-branch push;
- no merge, auto-merge or founder-acceptance claim;
- no tag or deploy;
- no update, forced or otherwise, of an existing remote branch; the sole
  lease-shaped Git option is a create-only zero-old-value CAS;
- no local or remote branch deletion;
- no client-selected repository, branch, base, status context or PR number.

GitHub branch protection remains the merge authority. After this slice lands,
`factory-run-receipt` can be made a required status on a managed product
repository and falsified with a negative control.

The first version uses GitHub's commit-status API rather than a Check Run. It
therefore works with the existing authenticated `gh` credential when that
credential has push/PR and commit-status write access; it does not require a
new GitHub App. This protects against accidental or stale status reuse, not a
malicious repository writer who deliberately impersonates the same context;
the receipt itself likewise claims integrity, not cryptographic authenticity.
Every external command is bounded by a 30-second timeout.

## Verification contract

Permanent tests cover pre-mutation drift refusal, mismatched push URLs, a real
two-stage Git URL rewrite, active-run and local-tip rebinding, a real
bare-repository create race, base-SHA drift, closed-PR recovery, append-only
journal tampering before status publication, direct/dangling/intermediate
authority symlinks plus symlinked `.locks` and receipt-file leaves against the
real receipt store, a conflicting receipt status on page two, nonce-bound status
recovery, client-authority rejection, the HTTP contract and admission-seam
classification.
