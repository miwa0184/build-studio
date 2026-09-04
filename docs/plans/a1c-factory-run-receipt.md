# Plan: A1c — the factory-run receipt

> **Status: implemented 2026-09-04.** A per-run, write-once receipt that
> proves a candidate was produced by one admitted run and reached the
> existing Egress Hold with its technical evidence intact. This slice
> prepares a later reviewed PR egress and installs none: no push, PR, merge,
> tag, deployment, default-branch checkout or branch deletion exists behind
> it. Third technical slice of the A1a/A1b/A1c track; no product change.

Owner request: before any reviewed landing transaction can be built, the
factory must be able to prove its own output. The Egress Hold (A1c Commit 1)
parks every candidate; nothing yet records, durably and per run, *which*
candidate sat at that hold, produced by *which* admitted run, with *which*
evidence. A landing transaction built without that record would be landing
on a workflow file that snapshot restore can rewrite.

## What a receipt proves

One file per run, `.build-studio/run-receipt/<runId>.json`, schema version 1,
finalized only by the project server and only when every check below holds
at the moment of finalization:

- **Admitted identity.** The run has a schema-2 run aggregate whose identity
  cross-links to an `ADMITTED` registry entry, and the workflow's own
  admission record agrees with both. Lane, lineage, admitted head, admitted
  repository and the admission request digest are bound.
- **No terminal or coverage authority against it.** No TECHNICAL_STOP in the
  aggregate or the workflow, no acceptance gap, no blocking task, every task
  state `done` with acceptance coverage not withdrawn.
- **The hold was reached.** The run is at `merge_to_main`, every earlier step
  is `completed` (an owner-skipped manual gate is tolerated and listed), and
  `merge_to_main` is blocked by `LOCAL_MERGE_REMOVED` and carries the candidate
  branch, default branch and candidate sha frozen by that hold. A valid frozen
  identity is write-once: re-entering the hold preserves it rather than binding
  later evidence to a moved candidate. A legacy hold already parked without a
  sha remains unfrozen on every later advance; current branch state is never
  substituted for missing historical evidence. A pending or pre-freeze hold
  cannot produce a receipt.
- **The effective sequence.** The sequence resolved for this workflow type is
  recorded with its source, review gates and the small allowlist of dynamic
  repair steps. The durable run must carry that base sequence in the same
  order; an absent or unexpected gate refuses rather than becoming invisible.
- **The exact candidate.** The candidate branch resolves to one commit; that
  commit equals the sha the hold froze (recorded when the run parks), equals
  any sha the caller stated, and descends from the admitted head. The default
  branch tip is recorded as the base.
- **The committed packet.** The workflow's packet path is the packet the run
  was admitted against, it exists in the candidate's committed tree, and its
  blob id and content digest are bound.
- **QA authority.** When exact-count QA is configured, the persisted server
  verdict passes the same gate the approve route and the tick use, recomputed
  on the spot; with Apple result authority the log and `.xcresult` manifest
  digests must agree between the verdict and its artifact record AND be
  re-digested from disk. Without exact-count QA, the QA agent's own verdict is
  read; an operator override of the strict gate refuses.
- **Review verdicts.** Every review gate in the effective sequence must precede
  the Egress Hold, be `completed`, and hold at least one agent-provenance
  verdict whose anchored structured marker parses as approved with an explicit
  zero blocking count. A structured count field must contain exactly one
  integer; hedges such as `0 or 1`, slash alternatives, suffixes and incomplete
  templates refuse. Quoted examples, fenced templates, unrecognized values,
  Markdown-indented code examples, contradictory markers and prose such as
  "not approved" also refuse. A fenced example closes only with the same
  delimiter character at least as long as its opening fence.
  Operator-generated feedback is never a verdict.
- **Effective configuration.** An allowlisted projection of what the resolver
  returned: preset, builder strategy, CLI slots, review settings, the QA
  contract, the disabled egress policy, and the CLI/model/effort every agent
  actually launched with, per step and task. Its canonical digest is bound.

Everything is bound by content digests (`evidenceDigest`, `configDigest`,
`receiptDigest`) a later reader can recompute. The file is validated to an
exact key set on every read; a tampered or truncated receipt reads as
`RECEIPT_UNREADABLE` and is never repaired or replaced.

## What a receipt does NOT prove

- **Not product acceptance.** Founder or owner acceptance is a separate
  decision the receipt records nothing about. The fields
  `productAcceptance: false` and `mergeAuthorization: false` are asserted as
  data so a reader holding only the file reaches the same conclusion.
- **Not a merge or push authorization.** PR egress remains disabled. With or
  without a receipt, `merge_to_main` answers `LOCAL_MERGE_REMOVED`, the tick
  parks, deployment push and CI-fix acceptance refuse, exactly as before.
- **Not authenticity.** The digests are integrity bindings, not signatures.
  A process that can write this machine's files can write a receipt. The
  boundary enforced is the same as A1b.1's: no HTTP caller can assert a
  receipt, and no field a client sends can make finalization succeed.
- **Not proof that the artifacts still exist tomorrow.** Native QA artifacts
  live under an ignored `tmp/` directory. Finalization re-digests them on
  disk; a later reader holds the digests, not the bundle.

## The store

`lib/authority-store.js` now holds the primitives run-guard.js introduced —
canonical digest, unique temp file + fsync + rename + directory fsync, and
the per-key lease with the proved-dead reclaim protocol — extracted verbatim
so the receipt and the aggregate share one write discipline. The receipt
store adds one primitive: an exclusive publish via `link(2)`, which fails
when the target exists, so two writers can never both believe they created
the file.

The first complete Egress Hold identity is separate durable authority at
`.build-studio/run-guard/<runId>.egress-hold.json`. The run aggregate writes a
monotonic presence marker before the digested document is published; a crash,
deletion or mismatch therefore fails closed instead of looking like a run that
was never frozen. The state authority projects this identity over every
workflow load and save, so `relaunch`, snapshot restore and stale workflow
writes cannot reset the step or bind a later candidate. Receipt finalization
also reads this authority directly and refuses a workflow-carried hold when the
durable record is absent or any of its three identity fields disagrees.

Finalization gathers every piece of evidence first, verifies that storage is
untracked and ignored, then under the run's receipt lease re-reads and
re-gathers the full material evidence (still eligible, same effective
sequence, same packet and reviews, same QA artifacts, same bound branch tip).
Material drift refuses with `RECEIPT_EVIDENCE_DRIFT`. A run-aggregate revision
increment that changes no receipt-relevant evidence is observational churn,
not a different receipt. A second finalization with identical evidence returns
the existing file byte-for-byte; different evidence for the same run refuses
with `RECEIPT_CONFLICT`. Three processes finalizing at once produce one file.

For projects onboarded before receipt storage was added, the server installs
the ignore rule in Git's repository-local `info/exclude`; it never edits the
product's tracked `.gitignore`. It reads the result back through Git before
creating a receipt directory or lease. If the path is already tracked, a
higher-priority negation keeps it visible, or Git cannot prove the policy, the
operation refuses with `RECEIPT_STORAGE_UNPROTECTED` and recovery guidance.

Supersession is not an in-place transition. A receipt carries
`supersedes: null`; a successor run (A1b's recovery model) will carry its
predecessor's receipt digest there. Nothing rewrites a finalized file.

## The surface

- `POST /api/workflow/receipt/finalize` — the active run; body accepts only
  an optional `candidateSha`, which can make finalization refuse and never
  make it succeed. Classified as a mutation of the admitted run by the
  admission seam, so a legacy run is refused before the handler. Refusals
  are typed (`RECEIPT_*`) and answer 409; malformed bodies 400; no active run
  or no receipt 404.
- `GET /api/workflow/receipt` and `GET /api/workflow/receipt/:runId` — the
  validated receipt plus a live check of whether the candidate branch still
  sits at the bound sha.

The hub is unchanged in this slice. A later slice may render the receipt.

## Red-first evidence

The independent frozen-head review identified five repair classes after the
initial implementation. The permanent repair suite
`lib/run-receipt-repair.test.js`, together with the strict verdict-parser
tests, was exercised before the receipt production repair was completed: 14
of 27 focused checks failed and no receipt repair was accepted from that
state. After the repair, the same 27 checks pass. A subsequent independent
review added three red-first checks for malformed blocking counts and review
gates that were incomplete or placed after the hold; all three now pass. The
combined focused surface was 30/30 at that head. A further independent review
found that a repeated advance rewrote an already frozen candidate identity and
that Markdown-indented examples were still parsed as verdict markers. Two
permanent checks reproduced both defects against the unchanged production
code, then passed after the write-once hold and indented-code repairs. The
next frozen-head review found the same boundary still refroze a legacy parked
hold whose historical sha was absent. A third permanent check reproduced that
path before the repair and proves the hold stays unfrozen. A subsequent review
executed two more bypasses: step relaunch and restore of the engine's own
pre-park snapshot. Both reproduced a false receipt before the durable-authority
repair; permanent tests now prove the first freeze survives both. A third
red-first test proves deletion of the registered authority fails closed rather
than enabling a re-freeze. The final combined parser, repair, receipt and
HTTP-hold surface is 65/65. A final pair of red-first checks then reproduced a
mismatched Markdown fence exposing example markers and a valid-looking mutable
hold without durable Egress Hold authority; both now fail closed. These
checks cover refusal precedence
in verdict parsing, mandatory frozen hold identity, effective sequence and
review-gate coverage, safe storage for older projects, and material-drift versus
benign-revision idempotence.

`lib/run-receipt.test.js` (23 tests) and
`lib/api/run-receipt-egress-hold.test.js` (now 10 tests) were written before the
implementation and run in a disposable detached worktree at the frozen start
sha `b90dce9fc7c2fc684d47fb6bde3d686fbb05e3f1`: both files fail to load
(`Cannot find module './run-receipt'`), 2 tests, 0 passed. After
implementation each falsification property was also checked by a controlled
mutation of the production code that removes the check under test; the
corresponding test fails and the file is restored byte-for-byte. Where a
property is defended twice (the admitted-identity check is backed by the
registry decision, the stop check by the blocking-task list), both defences
were removed together, because removing one alone is correctly invisible.

| Mutation (check removed) | Test that fails |
| --- | --- |
| schema-2 identity and registry `ADMITTED` decision | R1 no admitted identity |
| held-sha comparison; caller-stated sha comparison | R2 drift (each) |
| ancestry of the admitted head | R2 not descended |
| committed-blob lookup | R2 packet not committed |
| technical stop and blocking-task list | R3 stopped run |
| aggregate gaps and task-state coverage | R3 acceptance gap |
| current-step and completed-step checks | R3 not at hold |
| blocked verdict and verified-code checks | R4 exact and Apple |
| on-disk re-digest comparison | R4 Apple artifact tampering |
| operator-override refusal | R4 operator override |
| approved/blocking refusal; provenance and parse refusals | R5 (each) |
| resolver value replaced by local.json value | R6 effective config |
| projection safety assertions plus a leaked state path | R7 leakage |
| existing-receipt and exclusive-publish checks | R8 idempotent and concurrent |
| receipt validation on read | R9 tamper detection |
| finalize handler advancing the run | hold keeps refusing |
| a `git tag` call in the read path | R11 structural and behavioural |
| hold no longer records the frozen sha | hold records candidate sha |
| launch no longer records effort | launched agent records effort |

The properties pinned: no receipt without an admitted identity; candidate
drift, non-descent and uncommitted or mismatched packets refuse; a stop, an
acceptance gap and a run short of the hold refuse; missing, failed,
count-stale, language-stale, stdout/xcresult-contradicted, digest-inconsistent
and on-disk-tampered QA authority refuse; blocking, unapproved,
operator-provenance-only and unparsable review evidence refuse; the config
projection records the resolver's value for a key local.json cannot set;
environment values, secret-shaped config, raw paths and forbidden keys never
appear; duplicate finalization is byte-identical and concurrent cross-process
finalization yields one file; stale saves, snapshot restore, restart and
changed evidence cannot remove or rewrite it; the hold keeps refusing with a
receipt present; and finalization's Git subprocesses are limited to the
read-only `rev-parse`, `merge-base`, `cat-file`, `check-ignore` and `ls-files`
subcommands, changing no local or remote ref. The only compatibility write is
the explicit repository-local `info/exclude` migration described above.

## Deliberately not in this slice

- The PR-egress state machine, push, PR creation, CI polling, merge,
  verification, and every retry budget around them.
- Founder acceptance classes and the acceptance receipt.
- A hub surface for the receipt.
- Projection of the receipt onto `workflow-state.json`. The receipt is read
  from its own store; the workflow file is not made to carry a claim about
  it.
- Hardening of `.build-studio/local.json`: keys the resolver ignores stay
  silently ignored. The receipt records what the resolver returned, which is
  the honest value today, and the local-key schema is a successor slice
  together with the duplicated `final_review` default.
- Retention of receipt files and of the token-specific lease claims.

## Known limits

- Runs launched before this slice carry no `effort` on their agent records;
  the projection records `null` for them rather than inferring one.
- A run parked before this slice has no frozen sha on its hold step and cannot
  be receipted. It needs a new admitted run; current branch state is never
  substituted for missing historical hold evidence.
- The receipt binds the review verdict text by digest, not the findings
  themselves. A later reader can prove the text has not changed, not that it
  was right.
- Repository-local ignore migration deliberately cannot repair a receipt path
  that is already tracked or explicitly unignored by a higher-priority rule;
  those states refuse and require an explicit repository repair.
- A contrived dangling symlink at Git's `info/exclude` path is a separately
  recorded storage-hardening follow-up: the current existence check follows
  the link before the symbolic-link guard. This B1/M1 repair does not widen
  into that H4 migration path.
