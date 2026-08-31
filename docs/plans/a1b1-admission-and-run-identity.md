# Plan: A1b.1 — execution admission and durable run identity

> **Status: implemented 2026-09-01.** A server-side admission gate in front of
> every run start, a server-generated GateVerdict, explicit run registration
> with lineage metadata, durable nonce/replay protection, and a guard
> lifecycle that can tell a new run from a run whose history was deleted.
> Second slice of the A1a/A1b/A1c track; no product change.

> **Admission-boundary repair, 2026-09-01.** The first implementation compared
> `req.path` to canonical strings while the Express routers were case
> insensitive and accepted one optional trailing slash. The real server
> therefore routed spellings the seam did not classify. Route classification
> now compiles every start and mutation route through an Express route layer
> with the same defaults as the real routers; query strings remain irrelevant,
> one trailing slash and case variants are admitted to the gate, and double
> trailing slashes or encoded route-literal spellings remain ordinary 404s.
> `/workflow/start` also has a direct-mount backstop before its first state read,
> and a common server error boundary serialises typed admission failures from
> workflow, run, and server routes without recasting ordinary bugs as refusals.

Owner request: before successor repair runs (A1b.2) and egress control (A1c)
are built, give the engine a real front door. A run must be admitted by the
server against the project's actual git state before its first work-related
side effect, its identity must be registered durably, and nothing — not the
UI, not a replayed request, not a deleted file — may mint or renew a run's
authority.

What this is NOT: user authentication or a complete security boundary. A
process that can write this machine's files can forge anything below. The
boundary enforced is that no HTTP caller — the hub included — can assert its
own admission. It is execution admission and evidence classification, nothing
more.

## The ingress inventory, re-measured

The old inventory was not trusted; every start path was re-measured on the
exact merge base of this branch. Findings that shaped the design:

- **Two run-start ingresses.** `POST /api/workflow/start` (first side effect:
  the run-branch checkout for execution/bugfix, else the state save) and
  `POST /api/launch` (first side effect: worktree/log directory creation, then
  worktree + tmux per task). `/workflow/start` launches no agents itself — the
  first launch always comes from an advance.
- **One launch funnel.** All 33 agent-launch call sites go through
  `launchWorkflowAgents`, which reaches `createWorktree` (execution steps) and
  the real tmux spawn (`ensureWindow` + `send-keys`). One additional worktree
  path bypasses gitOps: `ensureReviewWorktree` shells `git worktree add`
  directly.
- **Autonomous entries** (the 8s auto-advance timer, the feedback route's
  auto-advance) reach the same `POST /api/workflow/advance` over loopback
  HTTP, so a route-level gate covers them by construction.
- **No new start paths since the upstream base** — the A1a diff added gates
  and removed one (the overseer's loopback advance).
- **Four GET routes mutate state as a side effect** (pre-existing, out of
  scope here, recorded so nobody mistakes them for read-only): `GET
  /api/backlog` rewrites item files and `project-state.md`; `GET
  /api/deployment` schedules a background `git fetch`; the two ops-uitests
  listing GETs rewrite run metadata and can spawn the clone reaper; `GET
  /api/support/reports/:id/triage/status` can materialise a backlog item and
  git-commit it. None of them can start or advance a run.
- **Separate one-shot agent ingresses exist and are NOT yet admitted**:
  `POST /api/deployment/ci-investigate`, `POST /api/support/reports/:id/triage`
  (both spawn a `claude` process directly), `POST /api/demo-setup/run`,
  `POST /api/ops/uitests/run`. They are not runs, they do not touch the
  worktree/agent funnel this slice backstops, and admitting them is a later
  slice. Recorded as an open edge, not silently.

## What was built

**A versioned RunRequest, verified against reality.** Exactly eight top-level
fields (`version`, `repo`, `head`, `task_packet`, `claims`, `issued_at`,
`expires_at`, `nonce`); any other field refuses, and fields shaped like a
client-made verdict/approval/bypass refuse with their own code. `repo` must
match the project's origin; `head` must be the *current* head — a fabricated
sha and a stale-but-real sha refuse differently but both refuse; `task_packet`
must exist in the committed tree at that head (the working tree does not
count); validity is bounded at fifteen minutes; the nonce is single-use,
durably.

**Claims are classified evidence, never authority.** `MEASURED` without a
structured receipt refuses. `DERIVED` is accepted only for a method the
validator recomputes itself (`sha256_hex`), and a wrong result refuses even
over correct operands. `INFERENCE`/`HYPOTHESIS`/`UNKNOWN` are transported and
recorded, and the repo/head/packet verification never reads claims — so no
claim can stand in for a failed check. An empty claims array is valid.

**A server-generated GateVerdict, bound to a registered run.** Created only
server-side, machine-readable, carrying the verified repo/head/packet/nonce, a
canonical request digest and timestamp. It rides the start response as
information; the authority is the registry entry it is stored in.

**The central Express seam, mounted before every router.** Three classes:
start ingress (verify RunRequest, register the run, only then let the handler
run), mutation of a registered active run (the server loads and verifies the
*stored* admission context; the client neither needs nor may send a
RunRequest or verdict — sending one refuses), and reads (always pass, so a
refused or stopped run stays explainable in the hub). A UI click and a direct
curl meet the same verdict because they meet the same middleware. Any
exception inside the seam — validator missing, git timeout, corrupt store —
refuses; it never falls open into the handler.

Deliberately exempt: cancel, finish, open, dismiss, nudge. The A1a reviews
found the same regression twice — fail-closed applied to the operator's
escape hatch — and this slice keeps the lesson: cancel must keep working on
exactly the runs everything else refuses.

**Durable registration and replay protection.** One registry file
(`admission/registry.json`) holds consumed nonces and registered runs, with
the run-guard's write discipline: unique temp + rename, monotonic revision,
lost-update refusal. One atomic write consumes the nonce AND registers the
run, which pins the transaction order: verification is read-only; the guard
file is created next (a failure here spends nothing); the registry write is
the commit point (a failure here spends nothing either — the guard file left
behind is an inert orphan, because a run *is* its registry entry). There is no
delete and no retention policy in this store, deliberately: entries are small
JSON, and forgetting a spent nonce is A1b.2's decision to make with a real
archiving model.

**Run identity with lineage, from the root run.** Registration writes
`runId`, `lineageId` (= runId), `predecessorRunId` (= null),
`successorOrdinal` (= 0), `registeredAt`, the admission request digest, and
the admitted head/repo into the run guard. No successor mechanics exist yet;
the fields exist so A1b.2 does not have to retrofit identity onto runs that
never had one.

**The guard lifecycle distinction.** `register` is the only way a guard file
comes into existence for a registered run; plain `load` never writes. A
*registered* run whose guard file is missing now fails closed with a typed
`RUN_GUARD_MISSING` — no fresh budget, no transition, no restore, no launch;
the state authority renders it (`guardUnverifiable`) but refuses every save.
An *unregistered* id with no file keeps the old in-memory-empty meaning, which
is what lets pre-A1b.1 state on disk keep rendering. And the mtime prune is
gone: the measured defect was that the 41st run silently deleted the oldest
run's guard, which — combined with missing-file-means-new — was a budget
rewind the store performed on itself. Guard files now stay until A1b.2 can
retire them without forgetting what they proved.

**Backstops at the consumption points.** `createWorktree`, the launch funnel
(`launchWorkflowAgents`, before its first side effect), `startDevServers`,
`ensureReviewWorktree`, and the real tmux spawn window (`ensureWindow`) each
refuse without a verified, server-issued admission context (an in-process
brand; not forgeable over HTTP). These are defence in depth: a request that
only a backstop stops is a primary-gate defect by definition, and the tests
treat it as one.

## What was decided, and what was rejected

**The seam lives in server.js, not inside each router.** One mount point in
front of everything is the property "UI and API meet the same verdict" made
structural. Rejected: per-route admission calls in handlers — that is the
pattern whose forgotten thirty-fourth call site the backstops exist to catch.

**The registry is the run's existence; the guard file is its history.** Two
stores, one commit point. Rejected: registering runs by creating the guard
file alone — then a failed second write could leave a spent nonce with
nothing to show for it, and file deletion would be identity deletion.

**Task packets for spec-less starts anchor on a tracked file.** A bugfix run's
packet is its bug file; review/execution runs use their PRD. Kickoff,
onboarding and execution-tab launches have no committed spec by design yet,
so their packet anchors on a stable tracked file (config, README, vision) so
the binding "this request was made against this exact tree" still holds.
Recorded as interim: a later slice gives those flows a real committed packet.
Consequence, stated plainly: a review of an *uncommitted* PRD draft and a
kickoff in a repo with no tracked anchor now refuse until the file is
committed. A factory verifies committed state; that is the point of the gate.

**Legacy runs refuse, except cancel.** A run started before this slice has no
registration, so every work-advancing mutation on it refuses fail-closed with
`RUN_NOT_ADMITTED`. Cancel remains open. The changelog carries the upgrade
step: finish or cancel active runs before updating.

## Red-first evidence

The acceptance file (`a1b1-acceptance.test.js`) spawns the real server and
imports nothing from the new modules, so the identical file ran against the
unchanged pre-slice head in a temporary worktree: 15 of its 18 tests fail
there, each on behaviour — every refusal case answers `200` with a full
workflow record on disk, `/api/launch` accepts and records a run with no
RunRequest, the start response carries no GateVerdict, a replayed nonce is
accepted after a restart, the admission context endpoint does not exist, and
a mutation of an unregistered run succeeds. A probe against the unchanged
guard store recorded the two lifecycle defects directly: after deleting a
guard with two spent review rounds, `load()` returned a fresh document
(revision 0, empty counters, no stop), and creating 46 runs left 40 files —
six runs' history auto-deleted. The lifecycle tests (`a1b1-identity.test.js`)
and admission unit tests pin the closed behaviour.

The route-boundary repair has its own real-server contract
(`a1b1-route-boundary.test.js`). Run unchanged against parent
`804409bf00a195013f336bb1ac3357d96dc42b32` in a detached temporary worktree,
the suite failed on the actual bypasses: `workflow/start/` answered 200, wrote
workflow state and created/checked out `exec/PRD-001`; trailing-slash
model-override and auto-advance answered 200 and changed the planted legacy
state; case-variant run merge reached its handler and answered 200. The direct
workflow-router mount likewise started and branched without admission. Control
cases established that query strings do not change classification and that
double slashes plus the tested encoded route-literal spellings are 404s in the
real Express server. The repaired suite covers R1-R18, including a typed
`ADMISSION_BACKSTOP` injection and a plain `TypeError` control.

## Deliberately not in A1b.1

Successor repair runs and lineage-wide budgets (A1b.2), wallclock/token/cost
budgets and progress fingerprinting, acceptance receipts, PR egress (A1c),
platform onboarding, dependency triage, a multi-lane scheduler, admission for
the one-shot agent ingresses listed above, and any retention/archiving of
admission or guard records. Also not built: any product policy in this fork —
the fork owns enforcement and the runtime verdicts it generates, nothing else.

## Known limits

- The registry file grows without bound (one small JSON entry per admitted
  run and per nonce). Accepted until A1b.2's archiving model; inventing an
  interim retention rule here would reintroduce forgetting.
- A refusal *after* admission (a handler-level 409, say) leaves a registered
  run and its guard with no workflow attached. Harmless and inert — a run is
  only reachable through its registration, and these have no workflow state —
  but they are visible on disk, and A1b.2's lineage model should account for
  them.
- The four mutating GETs and the four unadmitted one-shot ingresses recorded
  in the inventory are unchanged. They cannot start or advance runs, but they
  are real writes on paths named like reads, and they should not survive
  A1c's egress work unexamined.
- `tmuxOps.sendKeys` itself is not gated — the backstop is on window
  creation (`ensureWindow`), which every agent spawn needs first. The
  watchdog's auto-resume legitimately sends keys into existing windows of
  admitted runs and must keep doing so.
