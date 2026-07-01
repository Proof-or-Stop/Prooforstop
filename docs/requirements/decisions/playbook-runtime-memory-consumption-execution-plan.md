# Playbook Runtime Memory Consumption Execution Plan

Status: revised draft after 4-host audit (Claude CLI x2, Codex CLI, agy CLI)

## 1. Problem

Proofbound currently has two useful experience mechanisms, but they do not yet
form a reliable "remember before acting" runtime:

- `dev_memory_*` stores and searches non-authoritative experience entries.
- `playbook_*` can distil resolved findings into staged playbook candidates.

The verified gap is not storage loss. The gap is runtime consumption.

| Current surface | Verified state | Effect |
|---|---|---|
| Project/global dev-memory | Present and searchable | A host can retrieve lessons only if it remembers to search or preflight. |
| `dev_memory_preflight` | Works when called manually; host dispatch already snapshots it in one path | Not guaranteed to run at every session, story intake, DONE closure, or as a unified freshness-checked runtime pack. |
| Playbook lifecycle | `propose/diff/approve/reject` exist | Approved playbooks are candidates only. They are not active runtime guidance. |
| Playbook consumers | Not wired into gates or entrypoints | `session_brief`, handoff, story intake, and DONE closure do not consume playbooks. |
| Usage accounting | Shape exists (`surfacedCount`, `resolvedHits`, `dismissedHits`) | There is no real consumer that increments or reports those counters. |

The practical failure mode is that a future host can still act as if it has no
memory even when the right lesson exists on disk.

## 2. Target Outcome

Every normal Proofbound development entrypoint must receive the latest relevant
experience context before making claims or starting work:

1. Live facts from `session_brief` and story state remain the source of truth.
2. Dev-memory supplies current non-authoritative lessons.
3. Active playbooks supply executable reminders or checks derived from prior
   failures.
4. A freshness digest proves whether the host is working from the latest
   memory/playbook pack.
5. Large-scale baseline tests prove the runtime still works with 1,000,000
   generated experience records.

Short version:

> Memory must move from "available if searched" to "automatically consumed at
> the Proofbound entrypoints where forgetting causes mistakes."

## 3. Non-Goals

- Do not let dev-memory or playbooks satisfy review, validation, delivery,
  receipt, DONE, release, or production evidence gates.
- Do not reintroduce retired Authority Server completion semantics.
- Do not commit a 1,000,000-row generated data file to git.
- Do not make every advisory reminder a hard blocker.
- Do not turn ordinary experience into law. Blocking playbooks are exceptional
  and unavailable in the initial MVP rollout.
- Do not revive retired Koala terminology as a memory alias. Deprecated brand
  terms are scanner test inputs only, not default recall terms.

## 4. Core Contract

### 4.1 Source-Of-Truth Order

Runtime consumers must rank sources in this order:

1. Current lifecycle facts: `session_brief`, story phase, checklist, findings,
   validation, DONE readiness.
2. Fresh structured evidence, ProofStory/roadmap facts, and machine-readable
   truth-first supersession frontmatter such as `completedByStory`,
   `completionCommit`, and `supersededBy`.
3. Active playbook runtime hints.
4. Dev-memory preflight entries.
5. Historical docs and stale plan prose that do not carry valid machine-readable
   completion or supersession evidence.

Memory and playbooks can change host behavior, but cannot overrule current
facts or gate evidence. A truth-first playbook may remind a host to inspect
supersession frontmatter; it must not replace that frontmatter or treat memory
as completion proof.

### 4.2 Memory Freshness Pack

Every runtime consumption point emits or records a bounded pack:

```ts
interface MemoryFreshnessPack {
  schemaVersion: 'proofbound.memory-pack.v1';
  generatedAt: string;
  projectRoot: string;
  query: string;
  sourceDigests: {
    projectDevMemoryDigest: string | null;
    globalDevMemoryDigest: string | null;
    playbookDigest: string | null;
    signatureRegistryDigest: string | null;
  };
  results: {
    devMemoryEntryIds: string[];
    playbookIds: string[];
    suppressedSupersededIds: string[];
    deprecatedTermHits: string[];
    contributingSourceRefs: string[];
  };
  freshness: {
    stale: boolean;
    class: 'fresh' | 'stale-relevant' | 'stale-irrelevant';
    reason?: string;
  };
  render: {
    maxLines: 60;
    omittedCount: number;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}
```

The pack is fresh only when all source digests that contributed surfaced
results still match at consumption time. A mutation to an unrelated global memory
row may make the broad source digest differ, but consumers must classify that as
`stale-irrelevant` unless it changes a surfaced result, suppressed supersession
row, active playbook, or signature registry row used by the pack. This avoids
turning ordinary append-only memory churn into constant false stale warnings.

### 4.3 Active Playbook Runtime

Candidate playbooks are inert. Only active playbooks can surface.

```ts
type RuntimePlaybookStatus = 'proposed' | 'candidate' | 'active' | 'stale' | 'archived';
type RuntimeSeverity = 'advisory' | 'warn' | 'blocking';
type RuntimeConsumer =
  | 'session_brief'
  | 'dev_memory_start'
  | 'host_handoff'
  | 'story_create'
  | 'story_advance'
  | 'done_prepare'
  | 'done_closure'
  | 'final_response_check';
```

The runtime must use an allowlist: `status === 'active'` is the only playbook
status that may surface. `proposed`, `candidate`, `stale`, and `archived` are
always inert.

Blocking behavior never comes from a memory entry or playbook by itself.
Blocking behavior can only come from a committed, reviewable consumer policy row
registered in process-fact/command-policy style infrastructure. Such a row says
that a specific consumer may treat a specific active playbook class as blocking.
The blocked action still does not receive a proof receipt from memory:

- the memory pack remains `gateEvidence:false`;
- the playbook remains `authority:non_authoritative`;
- the consumer policy, not the memory content, owns the blocking decision;
- registered blocking consumers must expose an operator-visible bypass or
  downgrade path with a reason;
- unregistered playbooks, candidate playbooks, and caller-provided policy fields
  cannot create blocking behavior.

Rollout severity defaults:

| Stage | Allowed severity | Intended use |
|---|---|---|
| MVP | `advisory` only | Prove pack generation, surfacing, and freshness without changing lifecycle outcomes. |
| Warn rollout | `advisory` + `warn` | Stale pack, high-risk known traps, and known false-DONE patterns. |
| Enforce rollout | narrowly registered `blocking` | Only after review, process-fact registration, and 1M correctness baseline pass. |

Candidate blocking examples are intentionally rare:

- deprecated host-policy wording that would cause a false host claim;
- parent-roadmap full-complete wording traps;
- stale-doc supersession traps before DONE.

Ordinary playbooks stay advisory.

`final_response_check` is advisory only. Proofbound CLI can provide a check that
hosts should run before making a final claim, but it cannot mechanically intercept
an arbitrary LLM final response outside Proofbound entrypoints.

### 4.4 Parent And Child Milestone Model

This plan is a parent roadmap, not a single implementation story.

| Level | Meaning | Closure rule |
|---|---|---|
| Parent milestone | A workstream that can own several implementation stories. | Closed only when every child milestone is completed, superseded, or explicitly deferred with human approval. |
| Child milestone | A concrete implementation slice suitable for one focused story. | Closed by code/docs/tests/evidence for that slice. |

Parent milestones:

| Parent | Child milestones | Purpose |
|---|---|---|
| P0 Red/Repro Baseline | M0 | Prove the current non-consumption gap before fixes. |
| P1 Runtime Core | M1-M3 | Activation, matching, freshness, and non-authoritative boundaries. |
| P2 Baseline Harness | M9-M10 | Generate and verify the 1,000,000-row correctness/performance baseline. |
| P3 Entry Consumers | M4-M7 | Session, handoff, story intake, DONE, and final-response advisory check. |
| P4 Capture Loop | M8 | Ensure new lessons are captured or intentionally skipped. |
| P5 Health And Drift | M11 | Inspect runtime wiring, configured runtime memory classes, and deprecated terms. |
| P6 Rollout And Multi-Host | M12 | Rollout, Codex/Claude 3x2 verification, and agy fallback proof. |

Implementation stories should target one child milestone or a tightly coupled
pair. A parent story may track the ledger, but it must not claim full roadmap
completion while any child milestone remains open.

## 5. 1,000,000-Record Baseline Requirement

The million-row baseline is required because memory systems often work with ten
entries and fail when retrieval, supersession, stale filtering, and ranking run
against realistic noise.

### 5.1 Storage Rule

The baseline is generated, not checked in:

- generator source is committed;
- deterministic seed and manifest are committed;
- generated data defaults to an explicit temp directory;
- project-local output under `.lattice/benchmarks/memory-playbook/` is opt-in,
  no-overwrite, cleanup-able, and must be registered as a runtime artifact with
  materialHash exclusion;
- `.gitignore` must exclude generated JSONL/object payloads and any optional
  index payloads;
- summary metrics and small manifests may be committed.

Full 1,000,000-row verification is an opt-in local/nightly/release profile, not
routine validation. Routine CI should use a smaller deterministic profile that
exercises the same code paths.

### 5.2 Dataset Shape

Use a deterministic generator with a fixed seed.

| Partition | Rows | Purpose |
|---|---:|---|
| General irrelevant experience | 520,000 | Noise floor for ranking and latency. |
| Tool quirks and workflow lessons | 120,000 | Normal reusable memory. |
| Supersession chains | 100,000 | Prove latest entries outrank superseded entries. |
| Host-policy records | 60,000 | Codex CLI / Claude Code CLI / Antigravity CLI (`agy`) recall. |
| Stale-doc / truth-first records | 60,000 | Prove hosts do not claim "missing" from stale docs. |
| Repro-first / red-spike-story records | 50,000 | Prove code-verifiable story intake policy can surface. |
| Parent roadmap totality records | 40,000 | Prove full-roadmap vs partial-parent lessons surface. |
| Playbook candidates | 30,000 | Prove inert candidates do not surface as active guidance. |
| Active playbooks | 15,000 | Prove runtime playbook matching at scale. |
| Malformed/adversarial records | 5,000 | Prove strict reader skips bad rows without crashing. |
| **Total** | **1,000,000** |  |

### 5.3 Gold Query Set

The generator must output a gold file with at least these query classes:

| Query class | Expected result |
|---|---|
| `codex claude agy fallback` | Current host-policy memory and active host-policy playbook in top results. |
| `old plan says task missing already done` | Truth-first stale-doc lesson and playbook surface. |
| `parent roadmap all milestones complete` | Intent-totality playbook surface; partial-parent records do not allow full-complete wording. |
| `red repro spike story gate` | Repro-first lesson/playbook surface. |
| `playbook candidate only` | Candidate playbooks are not surfaced as active runtime guidance. |
| `memory pack stale digest` | Stale pack is detected after source mutation. |
| `superseded memory default` | Superseded entries are not surfaced by default and are listed only in `suppressedSupersededIds`. |
| `source digest mutation matrix` | Project memory, global memory, playbooks, and signature registry mutations each produce the expected freshness class. |
| deprecated brand residue query | No deprecated brand record is surfaced as current guidance. |

### 5.4 Baseline Metrics

| Metric | Required baseline |
|---|---:|
| Gold query recall@10 | >= 0.99 |
| Current-over-superseded ranking | >= 0.995 |
| Candidate playbook false-surface rate | 0 |
| Deprecated brand current-surface rate | 0 |
| Malformed row crash rate | 0 |
| Freshness stale-detection false negative | 0 |
| Pack generation p95 latency on 1M rows | report first; target <= 2s after indexing before enforce rollout |
| Peak additional RSS / heap on 1M rows | report first; hard budget required before enforce rollout |
| Generator time on 1M rows | report with profile-specific timeout |
| Pack render line cap | <= 60 lines |
| Memory file mutation after pack creation | stale detected |
| Irrelevant append-only churn | classified as `stale-irrelevant`, not a hard block |

Correctness thresholds are required. Performance thresholds are report-only in
the first implementation and become enforceable only before warn/enforce
rollout. This keeps early consumer wiring from being blocked by optimization
work while still preventing a "complete" claim before the full scale baseline
is understood.

## 6. Execution Milestones

### M0. Red/Repro Baseline Before Implementation

Goal: prove the current problem before changing code.

Deliverables:

- Red smoke: a seeded `status:"active"` playbook fixture exists, but
  `session_brief`, story intake, and DONE closure do not surface it.
- Red smoke: a candidate playbook exists and does not surface; this proves the
  existing inert-candidate contract, not the runtime consumption gap.
- Red smoke: `dev_memory_preflight` finds a lesson, but `session_brief` does
  not include a freshness pack.
- Red smoke: stale memory pack is not detectable because no pack digest exists.
- Documented expected failures.

Exit criteria:

- A failing test or smoke demonstrates runtime non-consumption.
- The active-playbook failure is separate from the candidate-inert behavior.
- The failure is not caused by missing memory files.

### M1. Playbook Activation Boundary

Goal: add a human-explicit transition from candidate to active.

Deliverables:

- `playbook_activate` command or equivalent explicit activation surface.
- `computePlaybookDigest` or equivalent canonical digest over the approved
  playbook domain.
- Fail-closed `expectedPlaybookDigest` check, matching `playbook_approve` style.
- Active status stored in `playbooks.json`.
- Candidate remains inert until activated.
- Cross-process write safety through main-write-lock, compare-and-swap, or an
  equivalent no-lost-update mechanism.

Tests:

- candidate does not surface;
- active surfaces;
- stale activation digest rejects;
- malformed playbook rejects.
- concurrent activate/append attempts cannot lose a playbook row.

### M2. Runtime Matcher And Trigger Taxonomy

Goal: match active playbooks deterministically across entrypoints.

Deliverables:

- Pure matcher over query text, story phase, touched paths, host, and consumer.
- Trigger taxonomy for host-policy, stale-doc, repro-first, intent-totality,
  delivery, review, and deprecated-term guard.
- Result includes match reason and confidence class.
- Fielded/tokenized retrieval or an explicitly bounded index plan sufficient to
  meet the M10 recall target.

Tests:

- exact triggers match;
- small noisy fixture finds gold records; the full 1M assertion is deferred to
  M10 after the generator exists;
- candidates and archived/stale playbooks do not match.

### M3. Memory Freshness Pack

Goal: make memory context freshness machine-checkable.

Deliverables:

- `MemoryFreshnessPack` builder.
- Source digests for project dev-memory, global dev-memory, playbooks, and
  signature registry.
- Pack stale checker.
- Superseded-memory suppression by default, with explicit debug mode to show it.

Tests:

- generated pack is fresh immediately;
- source append makes old pack stale;
- source delete/mutate checks cover project memory, global memory, playbooks,
  and signature registry independently;
- superseded entries are suppressed by default, recorded in
  `suppressedSupersededIds`, and visible only in debug mode;
- canonical no-op rewrites do not create a false stale warning;
- pack remains non-authoritative.

### M4. Session Entrypoint Consumption

Goal: make every normal session start see relevant memory.

Deliverables:

- `session_brief` includes a bounded memory/playbook section by default.
- `dev_memory_start` emits the same pack with agent-specific guidance.
- Output is capped and cannot flood the terminal.
- Empty state is explicit.

Tests:

- host-policy memory appears for host-related query/context;
- output remains <= 60 lines in a small fixture; the 1M flood test is deferred
  to M10;
- stale pack warning appears when source digest changes.

### M5. Handoff And Host Entry Consumption

Goal: stop host handoff from forgetting stale-doc and host-policy lessons.

Deliverables:

- `handoff_create` / `handoff_resume` / dispatch preflight includes
  memory/playbook pack. Existing host-dispatch dev-memory snapshots are reused
  but upgraded with freshness digest, playbook hits, and digest parity.
- Pack records canonical host label and display label:
  `codex-cli`, `claude-cli`, or `antigravity` / `agy-cli`.
- `agy-cli` surfaces as fallback only after programmatic primary-host status
  reports unavailable, quota-limited, timed out, or explicitly substituted.
- Host output includes pack digest and top hit IDs.

Tests:

- Codex/Claude primary host policy surfaces;
- agy fallback rule surfaces but is not primary;
- fallback status includes the concrete primary-host failure signal;
- stale-doc truth-first playbook appears before "task missing" claims.

### M6. Story Intake And Lifecycle Consumers

Goal: make story entrypoints consume experience where forgetting causes bugs.

Deliverables:

- `story_create` / repro-first intake can surface active playbooks.
- `story_advance` can surface phase-appropriate playbooks without turning them
  into gate evidence.
- Repro-first playbook can be advisory or blocking according to registered
  policy.
- Blocking policy rows are committed, reviewable, process-fact registered, and
  cannot be created by memory/playbook content.

Tests:

- code-verifiable story sees repro-first playbook;
- document-only story does not get irrelevant blocking;
- blocking policy cannot be set by unregistered playbooks.
- registered blocking consumers have a reasoned bypass/downgrade path.

### M7. DONE / Final Response Consumption

Goal: stop false completion claims from bypassing memory lessons.

Deliverables:

- `done_prepare` / `done_closure` display active intent-totality and delivery
  playbooks.
- Final response check projects "memory facts considered" when available.
- Final response check is advisory because Proofbound cannot mechanically
  intercept arbitrary host final text.
- Parent roadmap full-complete wording is checked against
  `ParentRollupResult` / current structured facts. The active intent-totality
  playbook only reminds the host to run or inspect that evaluator.

Tests:

- partial parent cannot sound like full roadmap complete;
- DONE closure still relies on structured evidence, not memory;
- output says "advisory memory considered" rather than "memory proved".

### M8. Capture-Or-Noop Decision

Goal: prevent new lessons from being lost after each major story.

Deliverables:

- A lightweight end-of-work command or reminder that records:
  `captured`, `no-reusable-lesson`, or `defer-with-reason`.
- Story-scoped memory candidates remain reviewable.
- No automatic promotion to project/global memory without human or explicit
  command.

Tests:

- missing decision is visible in runbook/advisory output;
- no-op decision is accepted with reason;
- captured candidate remains non-authoritative.

### M9. Million-Record Baseline Generator

Goal: generate and validate 1,000,000 deterministic records.

Deliverables:

- `memory_playbook_baseline_generate` or package script.
- Seeded manifest:
  - seed;
  - row counts by partition;
  - digest;
  - gold queries;
  - expected IDs.
- `.gitignore` entries for generated payloads.
- runtime-artifact-registry entry for project-local generated payloads when
  project-local output is enabled.
- opt-in full profile and small routine profile.

Tests:

- exactly 1,000,000 records generated;
- manifest digest is stable for the same seed;
- corrupted rows are included and reader skips them safely.
- generated payloads do not dirty materialHash or story evidence.

### M10. Million-Record Correctness And Performance Verification

Goal: prove the runtime still behaves with large memory.

Deliverables:

- `memory_playbook_baseline_verify` or equivalent smoke.
- Correctness report:
  - recall@10;
  - current-over-superseded rate;
  - false-surface rates;
  - stale detection.
- Performance report:
  - pack generation latency;
  - memory usage;
  - optional index build time.
- Profile report:
  - small routine profile;
  - full 1M opt-in/nightly/release profile;
  - peak RSS / heap;
  - timeout.

Tests:

- all correctness thresholds pass;
- performance numbers are recorded;
- line cap is respected.
- peak memory remains under the configured profile budget before enforce rollout.

### M11. Health Command And Drift Scanner

Goal: make memory/runtime health inspectable.

Deliverables:

- `dev_memory_health` or `playbook_runtime_health` command.
- Health checks:
  - config-driven required runtime memory classes are present;
  - active playbooks load;
  - no deprecated brand current guidance;
  - session/handoff consumers are wired;
  - million baseline can run in CI/local profile.

Required runtime memory classes must be project-configurable, not hard-coded
globally. Example:

```yaml
required_runtime_memory:
  - host-policy
  - truth-first-supersession
  - parent-roadmap-totality
```

Different projects may choose different required classes. A project-local
experience lesson must not silently become a global requirement.

Tests:

- health passes on clean repo;
- health fails when a configured runtime memory class, such as `host-policy`, is missing;
- health fails on active playbook reader drift.
- health fails if session/handoff/story/DONE consumers stop including the
  runtime pack.

### M12. Rollout And 3x2 Verification

Goal: deploy without surprising operators.

Deliverables:

- Rollout stages:
  - advisory only;
  - warn on stale/missing pack;
  - blocking only for registered critical consumers.
- 3 rounds x 2 host verification:
  - primary hosts: Codex CLI and Claude Code CLI;
  - fallback only: Antigravity CLI (`agy-cli`) when primary host is unavailable
    or quota-limited.
- Operator runbook and troubleshooting notes.

Tests:

- Codex/Claude both see the same pack digest and top hit IDs;
- agy fallback path reports fallback status;
- no gate treats memory as evidence.
- Codex/Claude digest parity is checked against the same source snapshot or an
  explicit stale classification when memory changed between runs.

## 7. Implementation Order

Recommended order:

1. P0 / M0 red/repro.
2. P1 / M1-M3 core runtime data model with small fixtures.
3. P3-lite / M4-M7 entry consumers on small fixtures, advisory only.
4. P2 / M9 generator, then M10 full 1M baseline verifier.
5. P3-enforce / consumer warn/enforce rollout only after the 1M correctness
   baseline passes.
6. P4 / M8 capture-or-noop.
7. P5 / M11 health.
8. P6 / M12 rollout and multi-host verification.

The million-row baseline should land before declaring runtime consumption
complete or enabling warn/enforce rollout. It should not block early advisory
consumer wiring, because without real consumers the 1M baseline only proves the
matcher/storage layer rather than end-to-end runtime consumption.

## 7.1 MVP Slices

### MVP 1. Runtime Pack And Session Consumption

Scope:

- M0 red/repro;
- M1 active playbook boundary;
- M2 matcher with small fixtures;
- M3 `MemoryFreshnessPack`;
- M4 `session_brief` bounded pack.

Required proof:

- active playbook appears;
- candidate playbook does not appear;
- pack has source digest;
- pack remains `gateEvidence:false` and `authority:non_authoritative`;
- 60-line cap works;
- relevant source mutation is detected.

### MVP 2. Handoff, Story, And DONE Consumers

Scope:

- M5 handoff pack;
- M6 story intake / `story_advance` pack;
- M7 `done_prepare` / `done_closure` pack and advisory final-response check.

Required proof:

- host-policy is surfaced;
- stale-doc lesson is surfaced before "task missing" claims;
- parent-roadmap totality lesson is surfaced;
- DONE still relies on structured evidence, not memory.

### MVP 3. Scale Baseline And Rollout

Scope:

- M9 generator;
- M10 correctness/performance verifier;
- M11 health;
- M12 rollout.

Required proof:

- 1,000,000 records generated in the full profile;
- correctness thresholds pass;
- performance is reported and later budgeted before enforce rollout;
- Codex CLI and Claude Code CLI agree on pack digest or explain stale drift;
- agy-cli remains fallback only.

## 8. Acceptance Table

| Capability | Required proof |
|---|---|
| Current memory is loaded | `session_brief` emits bounded memory/playbook pack with digest. |
| Latest memory is used | Pack stale checker distinguishes `fresh`, `stale-relevant`, and `stale-irrelevant` after source mutation. |
| Playbooks are consumed | Active playbook appears in session/handoff/story/DONE consumers. |
| Candidates stay inert | Candidate playbook never surfaces in runtime consumers. |
| Host policy remembered | Codex + Claude are primary; agy is fallback only. |
| Stale-doc lesson remembered | Host cannot claim pending work from plan prose before checking truth-first supersession frontmatter and live facts. |
| Parent roadmap lesson remembered | Full-roadmap claim blocked/warned by ParentRollupResult/current facts; playbook only prompts that check. |
| Repro-first lesson remembered | Code-verifiable story sees repro/red-spike-story guidance. |
| 1M baseline works | Generator creates exactly 1,000,000 records and verifier passes thresholds. |
| No evidence confusion | All packs remain `gateEvidence:false` and `authority:non_authoritative`. |
| Parent/child closure | Parent milestone cannot claim full completion while any child milestone is open. |

## 9. Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Memory output floods every session | Hard line cap, top-N hits, explicit omitted count. |
| Advisory memory becomes fake evidence | Pack schema hardcodes `gateEvidence:false`; process-fact registry marks consumers as non-gate unless explicitly registered. |
| Over-triggering slows development | Start advisory; blocking only by registered consumer + policy row. |
| 1M JSONL scan is too slow | Add deterministic lightweight index or streaming reader after correctness baseline; report pre/post latency and peak memory. |
| 1M output pollutes repo/material hash | Default to temp output; project-local output requires runtime artifact registration, gitignore, cleanup, and materialHash exclusion. |
| Multi-host writes lose rows | Use main-write-lock, compare-and-swap, or equivalent no-lost-update semantics for playbook activation and generated project-local artifacts. |
| Old or wrong memory misleads hosts | Freshness digests, supersession preference, active playbook review, stale/deprecate lifecycle. |
| Host bypasses Proofbound entrypoints | Wrapper/handoff guidance plus health check; cannot solve bypass outside Proofbound without operator discipline. |

## 10. Definition Of Done

This plan is complete only when:

1. M0 red/repro failures are demonstrated first.
2. Parent milestones P0-P6 are closed only when their child milestones are
   completed, superseded, or explicitly deferred with human approval.
3. M1-M12 are implemented or explicitly deferred with human approval.
4. `session_brief`, handoff, story intake, and DONE closure all consume the same
   memory/playbook runtime pack.
5. Advisory consumers may ship before the 1,000,000-record baseline, but full
   runtime-memory-consumption completion and warn/enforce rollout require the
   1,000,000-record baseline verifier to pass correctness thresholds.
6. Multi-host verification confirms Codex CLI and Claude Code CLI see the same
   active memory/playbook guidance; agy-cli remains fallback only.
7. Documentation and command help state clearly that memory/playbooks are
   advisory context, not proof evidence.

## 11. Runtime Runbook

Operational commands:

- `lattice memory_playbook_baseline_generate '{"profile":"small"}'` creates a
  quick deterministic corpus; `profile:"full"` creates exactly 1,000,000
  records. Output is benchmark/runtime material only.
- `lattice memory_playbook_baseline_verify '{"profile":"full"}'` generates and
  verifies the full million-record profile when `inputDir` is omitted. It
  reports correctness thresholds, stale detection, false-surface rates, elapsed
  time, RSS, and heap before any rollout claim.
- `lattice playbook_runtime_health` checks configured required memory classes
  and consumer wiring drift. It is advisory; missing memory cannot create a DONE
  blocker by itself.
- `lattice dev_memory_finish_decision '{"decision":"captured"}'` or
  `no-reusable-lesson` / `defer-with-reason` records the end-of-work memory
  decision. It never promotes project/global memory automatically.

Host policy:

- Codex CLI and Claude Code CLI are the primary independent hosts for pack
  comparison and handoff/runtime-memory verification.
- `agy-cli` / Antigravity is fallback only. Handoff and dispatch surfaces require
  a concrete primary failure signal such as `unavailable`, `quota-limited`,
  `timed-out`, or `explicitly-substituted` before accepting that fallback.
- Every `MemoryFreshnessPack` stays `authority=non_authoritative` and
  `gateEvidence=false`; completion claims must cite ParentRollupResult/current
  structured facts, validation, review, and DONE oracle rows rather than memory.
