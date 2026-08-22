# Plan: the spec corpus serves LLM readers — trim what agents re-read, not what they need

> **Status: proposed 2026-08-17.**

Owner request: the PRDs and companion specs a workflow produces are consumed
almost entirely by LLM agents — the owner sometimes reads the PRD, rarely the
companions. Is human-oriented markdown the right format? Would an internal
LLM-optimized representation, rendered to a human-readable view on demand
(the compiler analogy: agents read the "assembler", the owner reads the
"source"), be cheaper — or even better, by focusing on what the LLM needs?

The short answer this plan records: **the format is already right; the waste is
in what gets re-read.** Four improvements follow, none of which introduce a
second representation.

## What was measured

One recent item's full document set, from a project with many completed runs:

| document | size |
|---|---|
| PRD | 42 KB |
| QA / test-plan spec | 69 KB |
| ADR | 53 KB |
| UX spec | 26 KB |
| copy spec | 21 KB |
| QA handoff | 9 KB |
| **total** | **221 KB ≈ 55k tokens** |

Two findings from reading them:

- **The documents are already LLM-shaped.** Stable addressable IDs (`AC-9b`,
  `D-16`, `F-11`, `§4.2`), exact `file:line` references, exact constants,
  explicit rulings. The machine-readable layer exists, embedded in markdown.
- **The dead weight is history, not prose.** Roughly a quarter of the 69 KB QA
  spec is closed or struck findings kept inline as tombstones
  (`~~STRUCK~~ …`, `✅ CLOSED by …`), plus a struck test section. The PRD
  restates ADR decisions; the QA spec quotes PRD ACs back. None of that is
  there for the owner — it accreted across review rounds.

## Ruled out, and why

**A dual representation (canonical LLM format + human rendering).** Three
independent reasons, any one sufficient:

1. A compiler proves semantics preservation; the "renderer" here would be an
   LLM producing a paraphrase. The owner would approve a *rendering* while
   agents execute the *canonical form* — approval of a document nobody read.
2. Six reviewers and a PM edit these documents across rounds. Two writable
   representations drift; one writable plus a cached rendering goes stale.
3. Benchmarks consistently show markdown at or near the top for LLM
   comprehension — it dominates the training distribution. "LLM-optimized"
   is not terser; the human format *is* the LLM format.

**Token-level prompt compression** (LLMLingua-style, or filler-stripping à la
caveman). The published wins are on QA/summarization over retrieved context. A
normative spec is different: a dropped qualifier ("must **not** silently fall
back to …") inverts a requirement, and the compression tools themselves
exempt negations, numbers, code, and exact strings — which in a spec is most
of the text. The failure cost is also asymmetric: one extra review round
caused by a lost nuance costs more than every token the compression saved.

**Terse serialization formats** (TOON, markdown-KV, etc.). Measured savings
(~40%) apply to *uniform tabular data* only, and accuracy is flat-to-worse
versus markdown. Specs are argument and contract, not tables.

References: [LLMLingua](https://arxiv.org/abs/2310.05736),
[TOON benchmarks](https://www.improvingagents.com/blog/toon-benchmarks/),
[format-vs-accuracy study](https://arxiv.org/abs/2603.03306),
[SDD tooling survey](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
— the spec-driven-development tools have all converged on structured markdown
("the spec is the prompt"); none run a dual-representation pipeline.

**Also ruled out: cutting rationale to save tokens.** Narrative rationale —
why the rejected alternative was rejected, what the ruling was reacting to —
reads as human-oriented but is load-bearing for convergence: review rounds
loop precisely when a later reviewer re-litigates a decided question.
Rationale is what stops that. It stays.

## The four improvements

### 1. Specs state the present; history moves to an archive

**Rule:** a spec asserts what is true *now*. Closed findings, struck sections,
superseded rulings, and per-round narrative move to a sibling history file
(`docs/qa/QA-NNN-history.md`, same pattern per doc type) that **no workflow
prompt ever lists as reading material**. Open findings never move — only
resolved state does.

Why it pays twice: agents stop re-reading dead text every round (the measured
~25% of the largest document), and attention stops being diluted by it —
long-context degradation from irrelevant material is a real, measured effect.

(An earlier draft claimed a third benefit — that archiving tombstones would
stop them tripping a pre-start scan for human-only requirements. That scan has
since been removed as unsalvageably noisy, so the benefit no longer exists.)

Mechanics:

- **Prompt change (Build Studio):** the spec-owner and PM-revision prompts in
  `packages/project-server/lib/api/workflow.js` gain an archive instruction
  alongside the existing "REVISION DISCIPLINE" block (which already forbids
  append-only revision *within* the PRD — this extends the same idea to
  resolved content). The instruction: when closing or striking a finding,
  move the body to the history file and leave a one-line pointer
  (`F-5 struck 2026-08-17 → QA-NNN-history.md`).
- **Migration (each managed project):** lazy. No bulk rewrite — the next
  agent to revise a document archives its existing tombstones, prompted by
  the same instruction. Documents never revised again keep their tombstones
  harmlessly; nothing reads a finished item's spec.
- **Guard:** the AC-verifier and review flows resolve cited paths; history
  files are ordinary committed markdown, so links from the live spec resolve
  for the rare human who follows them.

Risk: an agent archives an *open* finding to make a document look clean. The
instruction states the rule in the polarity that fails safe (only `CLOSED` /
`STRUCK` / `RESOLVED` items move), and reviewers verify closure claims
against the diff already (the targeted re-review flow).

### 2. Normative / informative marking inside the document

**Rule:** sections are normative by default. A section whose content is
context rather than contract — background narrative, the record of a
decision's reasoning, worked examples — may be marked informative with a
heading suffix: `## 3. Why this matters *(informative)*`.

Verifying roles (AC verification, QA execution, code review) are told they may
skip informative sections; judging roles (spec reviewers, architect, PM) read
everything. Default-normative is the safe polarity: an unmarked section is
read by everyone, so a forgotten marker costs tokens, never correctness.

Mechanics:

- **Template (Build Studio):** `templates/default/docs/prds/TEMPLATE.md`
  documents the marker and pre-marks the sections that are structurally
  informative (Problem & Goal narrative, Revision History).
- **Prompt change:** the verifier/QA/code-review instructions in
  `workflow.js` gain one line: "sections marked *(informative)* provide
  context; requirements never live there — if a sentence in one reads as a
  requirement, flag it as misplaced rather than obeying it."
- **No parser.** The marker is a convention agents apply while reading, not
  something the engine enforces. That keeps the change prompt-and-template
  only, and means a malformed marker degrades to "everyone reads it".

Risk: a requirement gets written into an informative section and skipped by a
verifier. Mitigated by the flag-as-misplaced instruction, and by reviewers
(who read everything) checking placement — the same division that already
exists between judging and verifying roles.

### 3. Role-scoped reading lists

**Today:** `buildTaskContext()` in `workflow.js` emits one flat
`## Companion Specs (read these):` list — every Done spec, to every dev agent
on every task. The copy spec goes to the agent clamping arithmetic.

**Change:** scope the list by the reading agent's role, derived from the spec
type it already knows (the table's Owner column and path):

| spec type | read by |
|---|---|
| ADR | all dev roles |
| UX spec | UI-touching dev roles, QA |
| copy/brand spec | UI-touching dev roles, brand review |
| QA / test plan | QA, code review |
| security spec | all dev roles, security review |

Unlisted specs are named with a one-line scope note ("exists, read if your
task touches …") rather than silently omitted — the agent can still pull it,
which keeps the failure mode "read too much", never "couldn't find it".

Mechanics:

- **Consolidate first.** The companion-table parsing regex currently exists at
  four sites in `workflow.js` (launcher, §-status updater, execution gate,
  task context). Extract one `parseCompanionTable(prdContent)` helper with the
  existing tests' fixtures before touching semantics — a four-copy regex is
  how this drifts.
- **Type inference** from Owner + path (`docs/ux/` → UX, `docs/adrs/` → ADR,
  …), with an optional `Audience` column in the table for overrides. Missing
  column ⇒ current behaviour (everyone reads everything) — old PRDs keep
  working unchanged.
- **Precedent:** this is the same move as the targeted re-review flow
  (`lib/review-rereview.js`), which scoped *rounds*; this scopes *roles*. That
  change is what made review converge, which is the evidence that scoping
  reads is where the real win is.

Risk: an agent misses a spec that mattered to its task. The scope note (name
every spec, scope the *instruction*) bounds this — the list never hides a
document, it de-prioritizes it.

### 4. Reference, never restate — across documents

The PRD template already commands this *within* the PRD ("state each
requirement once … other sections reference it"). The same rule is absent
*between* documents, and the measured corpus shows the result: the QA spec
quoting PRD ACs, the PRD restating ADR rulings. Restating is worse than the
tokens: two copies drift, and drifted copies produce findings (the measured
set contained exactly that — a MEDIUM finding for source references that had
drifted).

**Rule:** across documents, cite by anchor — `per PRD §6 AC-3`,
`per ADR-NNN D-16` — and quote at most the clause under test. The one
exception: a document may restate a value it *gates on* if drift detection is
the point (a constants-gate spec listing the expected literal).

Mechanics:

- **Prompt change (Build Studio):** the companion-spec-owner instructions in
  `workflow.js` gain a cross-document clause parallel to the PRD's existing
  revision-discipline block; spec reviewer instructions gain "restated
  content from another document is a finding (MEDIUM), not a convenience".
- **Template:** one line in `TEMPLATE.md` §10 guidance extending "reference,
  never restate" to companion specs explicitly.
- **No lint.** A mechanical restatement detector would be fuzzy-matching
  prose across files — high effort, low precision. Reviewers already read
  both documents; making restatement a named finding is enough.

## Order of landing

1. **#4 and #1** — prompt + template changes only, no engine code. Cheapest,
   and they stop the corpus growing the wrong way while the rest lands.
2. **#2** — template + prompt, one convention to document.
3. **#3** — the only one touching engine code; do the four-site parser
   consolidation as its own commit first.

Each lands with tests where it touches code (#3's parser helper), and all four
are independently revertible.

## What success looks like

Not primarily token spend — spec reads are a minority of agent input (code,
diffs, build output dominate), and input tokens are the cheap kind. The
measures that matter, comparable before/after across runs:

- **Bytes of live spec per item** (total minus history files) — should stop
  growing monotonically across rounds.
- **Review rounds to approval** — the real cost driver; #1 and #4 attack the
  drift-and-relitigate loops that inflate it.
- **Findings caused by document drift** — should go to zero once single-copy
  discipline holds.

## Changelog obligations at implementation time

This changes documents in repositories that are not this one. The entry must
split, per the changelog convention:

- **In Build Studio** — rebuild, inject, restart (prompt changes ride the
  bundle).
- **In each managed project** — nothing mandatory: migration is lazy and
  agent-driven. Say so explicitly, and name the optional step (pre-marking
  informative sections in in-flight PRDs) for whoever wants the benefit
  immediately.
- **Notes for forks** — the companion-table parser consolidation moves a
  four-site regex behind one helper; forks that patched any of the four
  sites need to re-point their patch.

## Open questions

- **Does the history file need a retention story?** It grows monotonically by
  design. Probably fine — it is prose, it delta-compresses, and nothing reads
  it — but worth a look after a few months, same posture as the evidence-
  directory question in the PR-evidence plan.
- **Should the audience column (#3) be authored by the PM up front,** or is
  type inference enough? Start with inference; add the column only if a real
  mis-scoping shows up. Authoring burden on every PRD is a standing cost;
  inference is free.
- **Do reviewer roles ever need history?** A reviewer verifying "was this
  finding really closed?" may want the archived body. The targeted re-review
  context already carries the finding text forward in the round history, so
  probably not — but if it comes up, the fix is "read the history file", not
  "move history back".
