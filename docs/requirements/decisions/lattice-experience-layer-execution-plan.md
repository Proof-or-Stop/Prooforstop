# Proof-or-Stop Experience Layer Execution Plan

> Story: B-1480
> Scope: future execution plan only. This document does not implement source
> code, CLI commands, handlers, core modules, runtime registries, or gate
> behavior. It is a code-verified decision record that describes a future
> execution path; every command and module named here is a plan, not an
> implemented artifact.
>
> Source: faithful English translation of the corrected v1.1 specification
> (`Proof-or-Stop Experience Layer: an auditable experience-reuse mechanism keyed on
> story outcomes`, v1.1 Implementation Draft, code-verified revision). The v1.1
> revision is itself a correction of v1.0 after mapping the draft against the
> real Proof-or-Stop codebase, adversarial review, and a ClawCreek reference
> cross-check. The design has not yet been implementation-verified.

## Problem Statement

Proof-or-Stop already accumulates a large volume of structured data with outcomes:
findings and their final state, `checklist.json`, `decision.json`, story
background, and `activity.jsonl`. Today this data only
serves the current story; it is never reused across stories.

What makes Proof-or-Stop different from ordinary agent memory is that it knows, for
any given problem, which story it appeared in, how the reviewer judged it at the
time, whether it was finally resolved / dismissed / accepted-as-risk, whether it
passed the gate, and whether it caused rework or a rollback. That is verified,
outcome-bearing evidence, not a guess.

The Experience Layer turns this verified history into an auditable,
rollback-able, explainable layer of **review hints** and **process playbooks**.
It does not make any agent "smarter" on its own; it makes past, verified evidence
appear on time and auditably at the next review. The one-line positioning is:

> **Learning suggests. Human and gate decide.**

The core principle is unchanged from v1.0: Proof-or-Stop does not let an agent be
clever on its own; Proof-or-Stop lets evidence that has actually happened and has been
verified appear, on time and auditably, at the next review.

## Principles

1. **Advisory only; never decide.** The layer may only influence the reviewer
   prompt, PLAN precedents, the session brief, and checklist suggestions. It must
   never automatically `finding_add`, `finding_resolve`, change a gate, change
   story state, change a mandatory checklist item, auto-merge, roll back, or
   approve. It never touches gate logic or any deterministic decision path.
2. **Explainable, traceable, rollback-able.** Every hint and playbook must carry
   lineage (`sourceStoryId` / `sourceFindingId` / `sourceDecisionId?` /
   `createdAt` / `createdBy` / `status` / `signalScore` / `support` / `lastSeen`
   / `usageCount` / `resolvedHits` / `dismissedHits`). No lineage means it never
   becomes active.
3. **Lineage-backed.** A signal or playbook without traceable provenance does not
   surface. Support must always be displayed alongside any score.
4. **Reuse over rebuild.** Extend existing facilities rather than building
   parallel ones. Failure-then-recovery is a first-class learning input.
5. **Per-project only — no cross-project learning, by design; structured first, embedding later.**
   v1 does not even do full-text search — purely structured fields.
6. **Plan-only and naming discipline.** This document is plan-only. Use the names
   `Experience Layer` / `Evidence-backed Review Playbooks` / `Workflow Memory`;
   never `Self-learning Agent` or similar. The document follows the English
   house format used by the other execution plans in this directory.

## Architecture

The three semantic levels are:

- **L1 Finding Signals.** Derive structured signals from findings plus their
  outcomes, aggregated by a deterministic local signature, producing
  recurring-issue and common-false-positive hints.
- **L2 Story Recall.** When opening a new story, or during PLAN / REVIEW /
  session brief, recall similar historical stories by structured fields. No
  full-text search and no derived story-index in v1 (see below).
- **L3 Process Playbooks.** Promote a resolved finding through a staged,
  human-reviewed lifecycle into a reusable playbook
  (`proposed -> candidate -> active -> stale -> archived`, with restore from
  archive).

### Module decomposition

The decomposition follows the usage-ledger isolation style: one-way INWARD
coupling only (handler -> core -> types), and ZERO outward imports from existing
code into this layer. Modules converge to **4 core + 2 handler** (signature
lookup is folded into `learning-store` until a second consumer appears).

| Module | Responsibility | New / change | Coupling |
| --- | --- | --- | --- |
| `core/experience-layer-types.ts` | All types (leaf module) | new | none |
| `core/learning-store.ts` (incl. signature lookup / dedup) | Read/write `.proof-or-stop/learning/*` (source-of-truth + derived cache) | new | -> types |
| `core/finding-signals.ts` | Derive `finding-signals.json` from findings (read-only, derived) | new | -> store; reads findings through the finding port |
| `core/experience-hint-loader.ts` | Top-N hint ranking / filtering / progressive disclosure | new | -> store (read-only) |
| `handlers/learning.ts` | `learning_scan` / `learning_hints` / `learning_signals_*` | new | -> core |
| `handlers/playbook.ts` | `playbook_propose` / `playbook_diff` / `playbook_approve` / `playbook_reject` / `recall` | new | -> core |

Existing code that must change (surgical and additive only):

- `cli-engine.ts` `MAIN_TOOLS`: append `ToolDef`s only (extend the array, never
  touch dispatch). New commands use flat underscore names so the `aliasMap` does
  not need editing.
- `registry.ts`: one `registerBatch()` line per new handler group.
- `runtime-artifact-registry.ts`: ONE new entry registering
  `finding-signals.json` plus `learning-log.jsonl` as
  `materialHash: 'exclude', volatile: true`. This is the gate-safety lever and
  must not be skipped.
- `story-review.ts` (around the focus-guidance block, near the existing
  `grillSection` at ~567-598): inject a `hintSection` after the base focus
  guidance, mirroring the existing advisory-only `grillSection`.
- `types.ts` `Finding`: the audit-only fields below; plus (deferrable) a
  citation field `playbookIds?: string[]`.

Explicitly NOT touched: `advisory.ts`, `finding-verify.ts`, `review-run.ts` gate
logic, `evidence-freshness.ts`, and `scope-contract.ts`. Once the registry entry
is added, these automatically exclude the learning files with zero gate-logic
change.

### Reuse, don't rebuild

The v1.0 draft re-built three facilities that already exist. v1.1 reuses them:

- **Capture: extend `dev-memory.ts`.** `dev-memory.ts` is already ~80% of the
  capture layer. Extend it (add `status: candidate -> active -> stale ->
  archived` plus `promotionHistory`) rather than building a new store. The
  earlier `proposed` state of the full lifecycle lives as a staged proposal in
  `.proof-or-stop/learning/proposals/<id>.json`; a dev-memory entry begins only once a
  proposal is human-approved into `candidate`, so this `status` enum is the
  post-approval subset of the full
  `proposed -> candidate -> active -> stale -> archived` lifecycle. Because
  `dev-memory` entries derive their id from the content sha7, the mutable
  `status` / `promotionHistory` fields MUST be excluded from the id-hash domain
  (folding mutable state into the id would break dedup / idempotency). Promotion
  writes a side-band index and never rewrites append-only JSONL lines.
- **Playbook digest: clone the `decision-doc-promotion.ts` digest pattern.**
  Clone its `proposalDigest = SHA256(canonical-JSON minus digest/saves)` plus
  `sourceDigest` freshness binding plus `assertTargetInScope`, rather than
  inventing a new scheme. Before Phase 2, extract the canonical-JSON-digest
  helper out of `decision-doc-promotion.ts` into a leaf `core/digest.ts` so both
  decision-doc and playbook can import it, avoiding a `handlers/playbook.ts ->
  handlers/decision-doc-promotion.ts` handler-to-handler import (a coupling
  violation).
- **Learning log: reuse `activity-log.ts` `appendActivityLog`.** Use the
  existing JSONL appender for the learning log instead of building a new one.
- **Grill: read-only input.** `grill_get` is read-only input to a playbook; do
  not build a parallel session lifecycle.

Semantic rule:
`Story lifecycle remains deterministic. Experience Layer remains advisory.`

### Cut full-text search (FTS) for v1

The v1.0 draft claimed Proof-or-Stop already had reusable FTS infrastructure. That was
verified false: there is no SQLite, BM25, or inverted index anywhere in the
repository, and `story_list` is only a filesystem scan plus enum filtering.

Therefore v1 cuts FTS entirely. Level 2 recall = structured field filtering
(tags / fileKinds / touchpoints / storyType / phase / riskSignal) reusing the
existing `story_list` filesystem-scan path. No derived story-index is built in v1
— the data volume does not yet justify an index. An index (and, even later, an
embedding option) is considered only when the scan is measurably slow with real
performance evidence, and only as its own separate story.

## Determinism Guardrails

There are exactly THREE determinism guardrails.

1. **Audit-only finding fields must be excluded from any gate read.** The new
   fields `signatureTag`, `resolutionType`, `dismissReasonType`,
   `resolveEvidenceStrength`, and `dismissEvidenceStrength` are all audit-only.
   They must be annotated in `types.ts` as
   `// audit-only — MUST NOT be read by any gate`, must not enter the finding
   signature domain (`finding-verify.ts` stays a passthrough, unchanged), and
   must never be read by `advisory.ts` or any gate logic for confidence
   weighting. The real gate consumption point,
   `advisory.ts:isEvidenceStateBlocking`, only looks at
   `evidenceState === 'verified'`; the new fields must never enter that judgment.
   Gate behavior must be unaffected by any learning field.
2. **Finding-signals must read findings through the stable accessor.**
   `finding-signals.ts` MUST read through the finding subsystem's stable
   accessor `store.readFindings(storyId)`, and MUST NEVER directly
   `JSON.parse(.../findings.json)`. `findings.json` is governed by the finding
   subsystem plus the lifecycle-registry allow-list plus the main-write-lock;
   parsing it directly would couple this layer to an on-disk format that can
   change and silently break, and would violate the zero-outward-coupling bar.
   "Read through a port" is written into the Phase 1a story invariants.
3. **Reviewer hints must be excluded from the `promptHash` domain.** The real
   `reviewRunId` signature includes `promptHash`. If `hintSection` were spliced
   into the review prompt and participated in `promptHash`, then
   learning-derived hints (which grow as `dev-memory` grows) would make the same
   code/material produce a different `reviewRunId` binding, breaking the
   reproducibility and freshness/replay equivalence of the run binding. Two
   options (Phase 1.5 must pick one explicitly): (A) inject hints as an
   independent advisory channel that does not enter the `promptHash` computation
   domain; or (B) snapshot-pin the hint set per `reviewRunId` so that run's
   `promptHash` stays stable. (A) is recommended. Either way, accumulated
   learning must never change a gate-adjacent deterministic input.

### Back-compatibility

- `dismissReasonType` is optional. It must never be introduced as a required new
  parameter, because making it required would break every existing
  `finding_dismiss` caller on day one. The same back-compat rule applies to all
  new finding outcome fields: additive and optional only.
- New command names are flat underscore names (for example `learning_scan`,
  `playbook_propose`). Multi-word forms would force `aliasMap` edits and violate
  the pure-additive goal.
- `evidenceStrength` is split into two independent fields,
  `resolveEvidenceStrength` and `dismissEvidenceStrength`, to avoid
  last-write-wins semantics across resolve/dismiss.

## Roadmap

Everything runs through the Proof-or-Stop story workflow (one story per coherent
slice).

- **Phase 1a (FIRST STORY) — finding-signals vertical slice (minimal but truly
  verifiable).** Build `core/experience-layer-types.ts` +
  `core/learning-store.ts` (minimal) + `core/finding-signals.ts` (reading
  through the `store.readFindings` port). It actually derives and writes
  `finding-signals.json` AND, in the same story, registers the derived-cache path
  in `runtime-artifact-registry.ts` (`materialHash: exclude`, `volatile`).
  Acceptance is a real behavior test, not a string-matcher tautology: after
  writing the cache, `currentMaterialHash()` is unchanged; there are zero
  cross-module outward imports; and gate / evidence paths do not see the learning
  files. (Rough size: small. The v1.0 "register path + empty skeleton" Phase 0
  was rejected because its gate-exclusion smoke was only a string match that
  proved nothing.)
- **Phase 1b — finding structured outcome enums (independent, self-contained).**
  `resolutionType` / `dismissReasonType` (optional) /
  `resolveEvidenceStrength` | `dismissEvidenceStrength` + `signatureTag` +
  signature-registry (folded into `learning-store`); all audit-only and barred
  from gate reads; migration stays compatible with old findings. (Rough size:
  small.)
- **Phase 1.5 — advisory hint injection.** `experience-hint-loader` +
  `story-review.ts` `hintSection`. Must explicitly pick the option that keeps
  hints out of `promptHash` (see Determinism Guardrails). (Rough size: small,
  high ROI.)
- **Digest-extraction refactor (before Phase 2).** Extract `core/digest.ts` from
  `decision-doc-promotion.ts` so decision-doc and playbook share it. (Rough size:
  very small.)
- **Phase 2 — playbook lifecycle.** `handlers/playbook.ts` (cloning the
  decision-doc digest pattern) + `dev-memory` `status` / `promotionHistory`
  (excluded from the id-hash domain, side-band index). (Rough size: medium.)
- **Phase 3 — Story Recall (L2).** Structured filtering + reuse of the
  `story_list` scan. No FTS, no derived index. (Rough size: medium.)

Recommended order: do the FIRST STORY + Phase 1b + Phase 1.5 first — the data is
already on hand, coupling is low, the reviewer immediately gets more accurate,
dirty-data assumptions are fixed, signatures are stable at the source, and
gate-safety is locked down by a real test. Push Phase 2+ only after the value is
proven.

Note: degraded review escalation (the 3x1 fallback) is out of scope for this
document.

## What not to do

- No automatic `finding_add` / `finding_resolve` / `finding_dismiss`. The layer
  surfaces; humans and reviewers decide.
- No gate edits. `advisory.ts`, `finding-verify.ts`, `review-run.ts` gate logic,
  `evidence-freshness.ts`, and `scope-contract.ts` are not modified.
- No FTS, no embedding, no reinforcement learning, no DSPy/GEPA, no LLM curator
  pass, and no cross-project aggregation (per-project only, by design — not a future item).
- Audit fields (`signatureTag`, `resolutionType`, `dismissReasonType`,
  `resolveEvidenceStrength`, `dismissEvidenceStrength`) never feed any gate.
- Hints never enter the `promptHash` domain (or are snapshot-pinned per
  `reviewRunId`).
- No auto-promotion to active playbook by an agent; `signalScore` must always
  carry `support`.
- Do not treat `dismissed` as a false positive, `resolved` as a true problem, or
  `unclear` as negative feedback.
- Do not say "Proof-or-Stop becomes smarter on its own." Say: reuses evidence from
  completed stories / turns verified experience into review-time hints / makes
  workflow memory auditable.

## Appendix: Code Anchors

Every path below was verified to exist in the repository at planning time. Line
ranges are indicative anchors from the v1.1 cross-check and may drift as the code
evolves; the symbol names are the stable references.

| Concern | Path | Anchor |
| --- | --- | --- |
| Finding type (audit-only fields added here) | `packages/main/src/core/types.ts` | `Finding` type |
| `finding_add` / `finding_resolve` / `finding_dismiss` + validation pattern to reuse | `packages/main/src/handlers/finding.ts` | validation pattern, main-write-lock |
| Finding signature (stays passthrough, unchanged) | `packages/main/src/core/finding-verify.ts` | signature passthrough |
| Gate consumption (only `verified` blocks; must not read learning fields) | `packages/main/src/core/advisory.ts` | `isEvidenceStateBlocking` |
| Findings port (signals MUST read through this) | `packages/main/src/core/store.ts` | `readFindings` |
| Material-exclusion mechanism (derived cache excluded here) | `packages/main/src/core/evidence-freshness.ts` | `isMaterialExcludedPath`, `currentMaterialHash` |
| Scope contract (auto-excludes registered learning files) | `packages/main/src/core/scope-contract.ts` | scope filtering |
| Capture layer to extend | `packages/main/src/core/dev-memory.ts` | content-sha7 id |
| Digest pattern to clone / extract into `core/digest.ts` | `packages/main/src/handlers/decision-doc-promotion.ts` | canonical-JSON digest |
| JSONL appender to reuse | `packages/main/src/core/activity-log.ts` | `appendActivityLog` |
| Hint injection point (mirror `grillSection`) | `packages/main/src/handlers/story-review.ts` | `grillSection` -> new `hintSection` |
| Runtime artifact classification (one new entry) | `packages/main/src/core/runtime-artifact-registry.ts` | `materialHash: exclude`, `volatile` |
