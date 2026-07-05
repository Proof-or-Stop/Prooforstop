# Product Capability Release And Playbook Lineage Execution Plan

> Revision 2 (audited). This revision resolves the findings of the 2026-07-05 adversarial
> audit of revision 1: the two blockers (undefined `capabilityDigest`; live-`.lattice` M0
> red test), the four high-severity gaps (`mainCommit` in the idempotency key; classifier
> wired to only one DONE site; `capabilityId`/`capabilityVersion` left as open questions;
> unenforced `authority`/`gateEvidence`), and the scope/consistency findings. Open Questions
> 1 and 2 are now normative (see "Resolved Decisions"). Scope is the V1 first story; M6/M7
> are preserve-and-assert invariants (already enforced in code); the standalone
> `capability_release_backfill` command and full M6/M7 build are a named follow-up story.

## Why This Document Exists

Story B-785e proved that Proofbound can finish a non-runtime product capability story, record an artifact release, and ingest the DONE experience into playbook learning. The live evidence is real (one-time manual observation, captured here as motivation — it is NOT a test input; see M0):

- `.lattice/artifact-releases.jsonl` contains an artifact release for `B-785e` (`AR-4e885ed0209e5a32330cdc33`) with five released docs/experiment paths.
- `.lattice/learning/playbook-promotion-health.jsonl` records `DONE candidate ingest applied; proposedCount=1; candidateCreatedCount=1`.
- `.lattice/learning/playbooks.json` contains `PBP-882`, titled `Playbook: DONE experience B-785e`, with lineage `sourceStoryId=B-785e`, `sourceFindingId=B-785e:DONE-EXPERIENCE`, and `sourceSignature=done_experience`.

That proves DONE learning ingestion is working. It also exposes a product semantics gap:

```text
artifact release exists
DONE experience candidate exists
but no first-class product capability release is linked to the playbook lineage
```

The result is that Proofbound remembers "a DONE story produced a lesson", but it does not yet remember "a reusable product capability version was released and this playbook candidate is about that capability".

This document defines the execution plan to close that gap without weakening the existing safety boundary that candidate playbooks are inert until explicitly exposed, evaluated, and promoted by evidence.

## Current State

### What Is Already Working

| Layer | Current evidence | Status |
| --- | --- | --- |
| Artifact release | `AR-4e885ed0209e5a32330cdc33` in `.lattice/artifact-releases.jsonl` (git-tracked) | Working |
| DONE learning settlement | `post-done-learning-settlement:B-785e` | Working |
| DONE candidate ingestion | `candidateCreatedCount=1` | Working |
| Candidate playbook | `PBP-882` in `.lattice/learning/playbooks.json` (git-ignored, host-local) | Working |
| Active runtime consumption | `PBP-882.usage.surfacedCount=0` | Not consumed yet |
| Outcome evidence | no `B-785e` / `PBP-882` rows in `playbook-outcomes.jsonl` | No outcome yet |
| Promotion / activation | `PBP-882.status=candidate` | Not active |
| Candidate exclusion from active surfacing | `matchActivePlaybook` returns null unless `status==='active'` (`core/playbook-runtime-memory.ts:343`) | **Already enforced** |
| DONE-success is not `helped` | outcome counting gated on `!doneSettlement` (`core/learning-store.ts:1233-1241`); `validatePlaybookOutcomeEvent` hard-rejects malformed outcomes (`:924`) | **Already enforced** |

The last two rows are load-bearing for scope: the safety invariants that M6/M7 of revision 1 proposed to "build" are already enforced in code. This plan therefore treats them as preserve-and-assert, not new build work (see "Scope And Governing Story").

### Is This A Problem?

The fact that `PBP-882` is a candidate and not an active playbook is not a bug by itself. It is the correct safety behavior:

- DONE success alone must not count as `helped`.
- Candidate playbooks must not be active runtime guidance.
- A candidate needs concrete exposure and structured outcome before evidence-based promotion.

The real problem is narrower:

```text
PBP-882 remembers B-785e as DONE experience,
but it does not carry a first-class capabilityReleaseId / capabilityVersion / artifactReleaseId lineage.
```

That means later hosts can see a generic lesson, but cannot reliably answer:

- Which product capability did this story release?
- Which artifact release digest backs it?
- Which capability version should future tasks consume?
- Is this lesson about a reusable product surface or just a story-local note?
- Has this capability candidate ever been exposed, evaluated, or promoted?

So the right fix is not "activate every DONE candidate". The right fix is to make product capability releases first-class, bind them to artifact releases and playbook candidates, then expose candidates under a controlled pending-learning path that can collect outcomes.

## Design Principles

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness and product-semantics issues.
4. Preserve consistency of logic across DONE, artifact release, capability release, and playbook promotion.
5. Keep Lattice / Proofbound host-neutral. No capability release or playbook lifecycle step may belong to Codex, Claude, Antigravity, or any one host namespace. **The cross-host source of truth is the git-tracked `capability-releases.jsonl` ledger, not the git-ignored `playbooks.json`** (see M4/M8 durability model).
6. Do not conflate runtime semver with non-runtime product capability releases.
7. Do not make candidate playbooks active runtime guidance without exposure and outcome evidence.
8. Every persisted identity (record id, idempotency key, capability digest, version) MUST be deterministic and merge-stable — reproducible on a fresh clean checkout, and identical across a DONE re-merge / recovery of the same content. No identity may embed a volatile input (merge SHA, wall-clock, stateful counter).

## Target Model

```text
DONE story
  -> artifact release provenance
  -> product capability release record        (git-tracked ledger: cross-host source of truth)
  -> playbook candidate lineage references capabilityReleaseId   (host-local pointer)
  -> pending-learning exposure when relevant   (follow-up story)
  -> structured outcome                        (follow-up story)
  -> promotion recommendation / evidence activation
  -> active runtime playbook consumption
```

## Scope And Governing Story

This plan is delivered in two stories. **The governing first story is B-8128, scoped to V1.**

**V1 (story B-8128) — the entire genuinely-new capability tier:**

- M0 Red evidence (hermetic)
- M1 Capability release schema + ledger + read-time safety
- M2 DONE capability classification
- M3 Release binding
- M4 Playbook lineage binding
- M5 Read-only inspection
- M6/M7 as **assert-invariant** rows (a smoke that pins the already-enforced candidate-inert and DONE-success-≠-helped guarantees; no new mechanism)
- A **lightweight hermetic backfill proof** (fixture dry-run/apply/idempotency), so the "do not declare the lifecycle closed without a B-785e backfill proof" caveat is met even though the standalone CLI command is deferred.

**Follow-up story (to be opened; referenced by id once created):**

- M8 standalone `capability_release_backfill` CLI command (dry-run/apply against real host state).
- M6 candidate pending-learning exposure surfaces + exposure records.
- M7 structured-outcome/promotion command surfaces.

Rationale for the split (all code-verified):

- **M6 is already structurally enforced.** `matchActivePlaybook` (`core/playbook-runtime-memory.ts:336`) returns `null` unless `playbook.status === 'active'` (`:343`), so a `status='candidate'` playbook can never enter `MemoryFreshnessPack.results.playbookIds`. V1 asserts this invariant with a smoke; it does not build a new guard.
- **M7's core rule is already enforced.** Outcome counting in `core/learning-store.ts:1233-1241` gates `helped`/`dismissed`/`harmful` on `!doneSettlement`, and `validatePlaybookOutcomeEvent` (`:924`) hard-rejects malformed events. V1 asserts this; the structured-exposure/promotion command surfaces are follow-up.
- V1 therefore ships everything new (the capability release ledger, classifier, binding, lineage, read CLI) while keeping the M6/M7 guarantees provably intact.

The V1 story MUST NOT be run as an ambiguous 9-milestone story. The blockers below are fixed in this spec text regardless of scope.

## Non-Goals

- Do not bump `@lattice/core` package semver for docs/experiment-only capability releases unless watched runtime or capability-contract inputs changed.
- Do not make `artifact_release_*` commands mutate capability state.
- Do not treat DONE success as a positive playbook outcome.
- Do not auto-activate `PBP-882` or any existing candidate during V1.
- Do not use candidate playbooks as gate evidence.
- Do not require provider execution for B-785e retroactively; B-785e intentionally shipped a launch-control base, not provider experiment results.
- Do not wire `capability-releases.jsonl` into any gate, DONE guard, delivery-check, or validate reader (enforced by a guard test; see M1).
- Do not reuse or extend the existing host-capability command family (`capability_list`, `capability_probe`, `capability_claim_evaluate/formal_evaluate`); the new commands are `capability_release_*` and are a distinct namespace.

## Milestones

### V1 milestones (story B-8128)

| Milestone | Problem solved | Deliverable | Evidence |
| --- | --- | --- | --- |
| M0 Red Evidence | Prove the gap on a controlled fixture: a candidate whose lineage lacks capability release binding. | A failing **hermetic** smoke (`product-capability-release-red-smoke`) over a `mkdtemp` `.lattice` fixture modeling B-785e's shape. | Red test fails on the fixture candidate; goes green once M4 lineage binding is applied to the same fixture. |
| M1 Capability Release Schema | There is no first-class non-runtime product capability release record, and no read-time enforcement of its non-authoritative status. | `ProductCapabilityReleaseRecord` schema + `.lattice/capability-releases.jsonl` ledger (git-tracked) + fail-closed reader + gate-import guard test. | Unit tests: parse, deterministic `capabilityDigest`/`idempotencyKey`/id (fixed input→value), idempotent append, malformed-row rejection, fail-closed on `gateEvidence:true`/non-`non_authoritative` rows, guard test that no gate path imports the reader. |
| M2 DONE Capability Classification | DONE distinguishes runtime semver vs artifact release, but not reusable product capability release. | A **pure classifier fn in `core/`** (mirroring `selectArtifactReleasePathsV1`) invoked from **both** DONE completion sites. | Fixtures for B-785e-like docs/experiments, plain docs, runtime code, story-metadata-only; conservative-uncertain → advisory + no record. |
| M3 Release Binding | Artifact releases and capability releases can drift, and recovery re-merge must not duplicate. | Capability record binds `storyId`, `mainCommit` (provenance), `artifactReleaseId?`, `artifactSetDigest?`, `capabilityId`, `capabilityVersion`, `capabilityDigest`, `changedPaths`; dedup on a merge-stable key. | Smoke proves deterministic binding and **no duplicate record when re-run with a different `mainCommit`** (recovery path). |
| M4 Playbook Lineage Binding | Candidate playbooks know only `DONE-EXPERIENCE`, not the capability they came from. | `PlaybookLineage` gains **optional** capability fields (existing 3-field rows stay valid); DONE candidate ingest attaches them when a capability release exists; idempotency defined on the stable source key, not digest equality. | `PBP-882`-style fixture includes `lineage.capabilityReleaseId`/`artifactReleaseId`; pre-existing 3-field lineage still parses; re-apply is a no-op that does not trip stale-proposal rejection. |
| M5 Read-Only Inspection | Users cannot see product capability releases or their candidate lineage. | `capability_release_list` / `capability_release_status` as **pure ledger clones** of `handlers/artifact-release.ts`, registered in all four command sites + process-fact-levels; candidate lineage shown in `playbook_promotion_status`. | CLI smoke verifies read-only behavior, command-policy `readOnly/none/all`, and exact rendering. |
| M6 Assert (candidate inert) | Regression-proof that candidates never enter active runtime surfacing. | A smoke asserting `matchActivePlaybook` excludes a `status=candidate` capability playbook. | Runtime memory test proves the candidate is absent from `MemoryFreshnessPack.results.playbookIds`. |
| M7 Assert (DONE ≠ helped) | Regression-proof that DONE success cannot become `helped`. | A smoke asserting a DONE-settlement outcome does not increment `helped`/`decisiveSamples`. | Test rejects DONE-only helped; `decisiveSamples = helped + dismissed + harmful` over non-done-settlement events. |
| Backfill proof (hermetic) | Meet the "no lifecycle-closed without a B-785e backfill proof" caveat without the standalone command. | A fixture-based dry-run/apply/idempotency proof over a B-785e-shaped `.lattice`. | Dry-run detects exactly one eligible candidate; apply enriches exactly one; repeated apply idempotent; candidate stays `status=candidate`; `surfacedCount` unchanged. |

### Follow-up milestones (separate story)

| Milestone | Deferred deliverable |
| --- | --- |
| M8 command | Standalone `capability_release_backfill --dryRun/--apply` CLI over real host state, with a `--digest` confirm gate. |
| M6 exposure | Candidate pending-learning exposure surfaces (`pendingLearning`/`promotionRecommendations`/`candidate-inspection`) + exposure records. |
| M7 promotion | Structured-outcome and promotion-recommendation command surfaces. |

## Data Model (M1, normative)

Ledger path (git-tracked, committed at DONE — mirrors `.lattice/artifact-releases.jsonl`):

```text
.lattice/capability-releases.jsonl
```

Record:

```ts
type ProductCapabilityReleaseRecord = {
  schemaVersion: 'proofbound.product-capability-release.v1';
  id: string;                 // `PCR-${sha256Hex(idempotencyKey).slice(0,24)}` — mirrors AR- derivation
  idempotencyKey: string;     // see below; MERGE-STABLE
  storyId: string;
  createdAt: string;          // provenance only, never in any digest/key
  mainCommit: string;         // provenance only, EXCLUDED from idempotencyKey
  capabilityId: string;       // see Resolved Decisions OQ1
  capabilityName?: string;    // optional display label (default: story title); NOT in any digest/key
  capabilityVersion: string;  // digest-derived; see Resolved Decisions OQ2
  capabilityKind: 'experiment-launch-control' | 'workflow-control' | 'evidence-control' | 'memory-control' | 'documentation-control' | 'other';
  capabilityDigest: string;   // see below; MERGE-STABLE
  artifactReleaseId?: string; // present only when the story also produced an artifact release
  artifactSetDigest?: string; // provenance; folded into capabilityDigest, so absence is safe
  changedPaths: string[];     // FULL DONE-time changed-path list (so backfill needs no git replay)
  runtimeSemverChanged: boolean;
  activationBoundary: 'non-runtime-capability' | 'runtime-capability';
  authority: 'non_authoritative';
  gateEvidence: false;
  notes: string[];
};
```

Naming note: this record intentionally uses `changedPaths` (the full DONE-time list, needed by the classifier and backfill) and the new `activationBoundary` enum — distinct from the artifact record's `paths` (selected subset) and `claimBoundary` string. `capability_release_status` renders both ledgers; keep the field labels visibly distinct so the two are not confused.

### capabilityDigest (blocker B1)

`capabilityDigest` is the merge-stable identity of the released capability. It is defined as:

```text
capabilityDigest = 'sha256:' + sha256Hex(JSON.stringify({
  capabilityId,
  capabilityKind,
  changedPaths: <capability-declaring changedPaths, sorted, deduped>,
  artifactSetDigest: artifactSetDigest ?? null,
}))
```

Reuse `sha256Hex` and the canonical-JSON approach from `core/artifact-release.ts:84,117` (`computeArtifactSetDigest`). It hashes only merge-stable inputs (no `mainCommit`, no timestamps, no counters), so it is identical across a DONE re-merge/recovery and reproducible on a clean checkout. `artifactSetDigest` is folded in here (not a standalone mandatory key component), which is why the artifact-less case (`artifactSetDigest` absent → `null`) is safe. M1 MUST include a determinism unit test with a fixed input → fixed `capabilityDigest` reference value.

### idempotencyKey and id (blocker B1 + high H1)

```text
idempotencyKey = `${storyId}:${capabilityId}:${capabilityDigest}`
id             = `PCR-${sha256Hex(idempotencyKey).slice(0,24)}`
```

`mainCommit` is **excluded** from the key (high H1): the existing artifact-release key at `core/artifact-release.ts:169` embeds `mainCommit`, which changes on a DONE recovery re-merge and would defeat the very "no duplicate on recovery" guarantee M3 promises. `capabilityDigest` already folds in `artifactSetDigest` and the capability paths, so the key needs only `storyId + capabilityId + capabilityDigest`. Append dedup reads the existing ledger and matches on `idempotencyKey` (mirror `core/artifact-release.ts:192-193). M3 MUST include a test that re-runs binding with a different `mainCommit` and asserts `already_recorded`.

### Read-time safety (high — unenforced authority/gateEvidence)

The reader (modeled on `readArtifactReleaseLedger`, `:141`) MUST fail closed, mirroring `validatePlaybookOutcomeEvent` (`core/learning-store.ts:924`):

- A row whose `authority !== 'non_authoritative'` or `gateEvidence !== false` (including absent) MUST cause the reader to **throw**, not silently drop — a tampered ledger is an error, not a filtered noise row.
- Negative invariant + guard test: no gate, DONE guard, delivery-check, or validate module may import the capability-releases reader symbol. Add a test that greps those modules and fails if the symbol appears. This makes "gateEvidence=false" an enforced property, not just a data field.

## Detailed Execution

### M0. Red Evidence (blocker B2 — hermetic)

Create a **hermetic** read-only smoke over a `mkdtemp` `.lattice` fixture (mirror `makePartialDoneRecoveryFixture` / `makeGitFixture` in `artifact-release-ledger-smoke.ts`). The fixture contains:

- a B-785e-shaped row in `artifact-releases.jsonl`
- a `PBP-882`-shaped candidate in `learning/playbooks.json` whose `lineage` has `sourceStoryId`/`sourceFindingId`/`sourceSignature` but **no** `capabilityReleaseId`

The test asserts the gap ON THE FIXTURE:

```text
FAIL: fixture candidate exists but lineage lacks capabilityReleaseId / artifactReleaseId
```

It MUST NOT read the repo-root live `.lattice` (revision 1's defect): those files are mutable, two of them (`playbooks.json`, `playbook-promotion-health.jsonl`) are git-ignored and absent on a clean clone, `run-all-smokes.ts:123` auto-discovers `dist/tasks/*-smoke.js` so a live-reading smoke would run against mutable state in `test:all`, and — fatally — M4/backfill would enrich the very field M0 asserts missing, flipping the live test permanently green (self-invalidation). The hermetic fixture makes M0 re-runnable: it stays red until the M4 binding is applied to the same fixture, then goes green — a proper red→green pin. The live observation stays only as one-time motivation in "Why This Document Exists".

### M1. Capability Release Schema

Implement the record, ledger, deterministic identity, and fail-closed reader per "Data Model" above. Put the pure schema/parse/digest/idempotency helpers in `core/` (mirror `core/artifact-release.ts`).

### M2. DONE Capability Classification (high H2 — both sites)

Add a **pure classifier fn in `core/`** (mirror `selectArtifactReleasePathsV1`) that decides, from the story's changed paths + metadata, whether a reusable product capability was released and of which `capabilityKind`.

| Changed paths | Classification |
| --- | --- |
| `experiments/multi-model-ablation/m2-provider-execution-check.mjs` + launch artifact + execution plan | `experiment-launch-control` |
| ordinary typo-only doc | no capability release |
| `packages/main/src/**` watched runtime input | runtime semver path may apply |
| `.lattice/story/**` metadata only | no capability release |

The classifier is invoked from **both** DONE completion sites — `runArtifactReleaseLedgerAfterDoneMerge`'s callers at `handlers/done-effects.ts:1167` **and** `handlers/done-recover.ts:116` — importing one source so the two paths cannot diverge. The classifier must be conservative: uncertain → no record + advisory.

### M3. Release Binding (high H1)

When a capability release is created, bind `storyId`, `mainCommit` (provenance), artifact release id + set digest when present, `capabilityDigest`, `capabilityId`, `capabilityVersion`, and the full `changedPaths`. Dedup on `idempotencyKey` (merge-stable; excludes `mainCommit`). This makes the recovery re-merge a no-op instead of a duplicate.

### M4. Playbook Lineage Binding (high H2 + interface-widening)

`PlaybookLineage` (`core/experience-layer-types.ts:130`) is a persisted, multi-consumer interface (consumed by `buildPlaybookSourceReference` at `core/learning-store.ts:1164`, source-lineage-audit, `handlers/playbook.ts`; constructed by `lineageFromSeed` at `playbook-seed.ts:853`). M4 therefore:

1. Adds the 5 capability fields as **OPTIONAL** at `experience-layer-types.ts:130` — existing 3-field rows stay valid (make revision 1's "remain valid" normative + add a fixture asserting a pre-existing 3-field lineage still parses).
2. Threads the capability record through `PlaybookSeedCandidate → proposalFromSeed → lineageFromSeed` so DONE candidate ingest attaches lineage when a capability release exists for the story.
3. Because `computePlaybookProposalDigest`/`computePlaybookDigest` hash the entire lineage object, enrichment CHANGES those digests. Idempotency MUST be defined on the stable source key (`PBSRC-…`) or an explicit "capability-lineage-already-present" check — **not** digest equality — and enrichment RECOMPUTES the digests without tripping stale-proposal rejection (`playbook-seed.ts:1103/1248`). Add a smoke asserting re-apply is a no-op.

Recover-path decision (high H2): `handlers/done-recover.ts` records artifact releases but does **not** run `runPostDoneLearningSettlement`/candidate ingest, so a recover-completed story has no candidate for M4 to bind. V1 scopes this explicitly: **recover-completed stories get artifact + capability provenance in the committed ledger, but no candidate playbook; binding their lineage is left to backfill.** (Adding candidate ingest to the recover path is out of V1 scope.) The capability smoke includes a recover-path fixture asserting a capability release is recorded and no candidate is created.

Existing candidates without capability lineage remain valid but are reported as under-bound.

### M5. Read-Only Inspection (medium — command registration + scope)

Add two read-only commands as **pure ledger clones** of `handlers/artifact-release.ts` (its json/text renderers + read-only boundary asserts):

```bash
lattice capability_release_list --json
lattice capability_release_status --storyId=B-785e --json
```

Register each across all five mechanical sites (command-catalog schema/description, registry `registerBatch`, handler, `command-policy.ts` — mirror the `artifact_release_*` entries at `command-policy.ts:180-181` with `ownershipClass:'readOnly', destructiveRisk:'none', allowedPhases:'all'`, and `core/config.ts` `DEFAULT_PHASE_TOOLS['*']` — add a `'capability_release_*'` wildcard mirroring the `'artifact_release_*'` entry at `config.ts:225`) plus `process-fact-levels.ts` L0 entries (mirror `:80-81`). Without the policy entry `getCommandPolicy` returns undefined and the commands lose their read-only guarantees; without the `DEFAULT_PHASE_TOOLS` entry the commands are not exposed across phases even though `allowedPhases:'all'` — the phase-tool whitelist gates availability independently of command-policy.

`playbook_promotion_status` gains a candidate-lineage display column. The five-line unified view separating

```text
runtimeVersion / artifactRelease / productCapabilityRelease / playbookCandidate / activePlaybook
```

is a **net-new cross-subsystem aggregation** (it reads the version source, both ledgers, and the learning store — no existing reader does this). Keep `capability_release_list/status` as pure single-ledger clones; deliver the unified view as a clearly-scoped separate reader (or defer it to the follow-up story). Do not present the unified view as a trivial clone.

### M6 / M7. Assert Invariants (V1: preserve-and-assert)

These are already enforced in code (see "Current State"). V1 adds regression smokes only:

- M6 smoke: a `status='candidate'` capability playbook is excluded by `matchActivePlaybook` (`playbook-runtime-memory.ts:343`) and never appears in `MemoryFreshnessPack.results.playbookIds`.
- M7 smoke: a DONE-settlement outcome (`verdictSource='done-settlement'`) does not increment `helped`/`decisiveSamples` (`learning-store.ts:1233-1241`); a structured non-done-settlement outcome does.

The follow-up story builds the exposure surfaces (M6) and promotion-recommendation commands (M7); the forbidden/allowed surface lists below are the follow-up's contract.

Allowed candidate exposure surfaces (follow-up): `pendingLearning`, `promotionRecommendations`, `candidate-inspection`.
Forbidden: `MemoryFreshnessPack.results.playbookIds`, active runtime guidance, gate evidence, DONE validation proof.
Every follow-up exposure writes a record with: `playbookId`, `capabilityReleaseId`, `exposureMode`, `surface`, `storyId`/`sessionId`, `observedAt`.

### Backfill proof (V1, hermetic) and M8 command (follow-up)

**V1 keeps only a hermetic backfill proof** (a fixture dry-run/apply/idempotency test, NOT the live `PBP-882`): dry-run detects exactly one eligible candidate, apply enriches exactly one, repeated apply is idempotent, candidate stays `status=candidate`, `surfacedCount` unchanged, no `helped` inferred.

**Durability model (medium):** the capability ledger is git-tracked and committed at DONE (mirror `commitArtifactReleaseLedgerIfNeeded`, `handlers/done-effects.ts:238`) — this is the cross-host source of truth (Design Principle 5). For the tracking to actually hold, the mirror MUST replicate BOTH parts of the artifact-ledger pattern, not just the commit call: (a) add a `.gitignore` un-ignore rule `!.lattice/capability-releases.jsonl` immediately after the existing `!.lattice/artifact-releases.jsonl` (`.gitignore:9`), since `.lattice/*` (`.gitignore:8`) ignores it by default; and (b) stage it with `git add -f` (mirror `done-effects.ts:246`). Both are required — the un-ignore rule keeps it tracked on ordinary `git add`, and `-f` force-stages the first commit. The candidate playbook lineage lives in the git-ignored `playbooks.json` and is therefore host-local; that is acceptable because the committed ledger, keyed by `storyId`/`capabilityId`, lets any host reconstruct "which capability" without the local playbook file. Backfill re-runs the classifier from the record's persisted full `changedPaths` (stored at DONE time), so it needs no git replay.

**The standalone `capability_release_backfill` command (M8) is the follow-up story:**

```bash
lattice capability_release_backfill --dryRun --storyId=B-785e --json
lattice capability_release_backfill --apply --storyId=B-785e --digest=<dry-run-digest> --json
```

Backfill rules: may enrich existing candidate lineage; must not create duplicate candidates; must not activate candidates; must not infer `helped`; must be idempotent; `--apply` requires a `--digest` matching the dry-run plan digest or refuses (a write-guard, since backfill mutates the ledger and enriches candidates; classify its `destructiveRisk`/`allowedPhases` deliberately as a writer, not read-only).

For B-785e, the expected after-state (once the follow-up backfill runs):

```text
artifact release: present
capability release: present (committed ledger)
PBP-882: candidate, enriched with capabilityReleaseId and artifactReleaseId (host-local)
surfacedCount: still 0 until future exposure
outcome rows: still 0 until future structured outcome
```

## Acceptance Criteria (V1)

- A **hermetic** red test proves the lineage gap on a fixture before implementation, and goes green when M4 binds the same fixture.
- DONE records a product capability release (in the git-tracked ledger) for non-runtime product capabilities, from **both** completion sites, deduped merge-stably.
- `capabilityDigest`, `idempotencyKey`, and `id` are deterministic and merge-stable (fixed input → fixed value test); a different `mainCommit` does not create a duplicate.
- The reader fails closed on `authority`/`gateEvidence` violations, and no gate path imports it (guard test).
- B-785e-like stories do not force `@lattice/core` semver bumps unless runtime inputs changed.
- Capability release and artifact release are both visible through read-only CLI commands with `readOnly/none/all` policy.
- DONE candidate ingest binds playbook lineage to a capability release when available; pre-existing 3-field lineage still parses; re-apply is a no-op.
- Candidate playbooks remain inert (M6 smoke) and DONE success never counts as `helped` (M7 smoke).
- A hermetic B-785e-shaped backfill proof detects/enriches exactly one candidate, idempotently, without activation or `helped` inference.

## Validation Checklist

### V1 subset (story B-8128)

```bash
node packages/main/dist/tasks/product-capability-release-red-smoke.js       # M0 (hermetic, red→green)
node packages/main/dist/tasks/product-capability-release-smoke.js            # M1-M3: schema/ledger/digest/idempotency/reader-fail-closed
node packages/main/dist/tasks/playbook-capability-lineage-smoke.js           # M4: optional-field parse, enrichment, re-apply no-op, recover-path
node packages/main/dist/tasks/capability-release-invariants-smoke.js         # M6/M7 assert + hermetic backfill proof
lattice capability_release_status --storyId=B-785e --json                    # M5 read CLI (renders; no live mutation)
lattice playbook_promotion_status --json                                     # M5 candidate-lineage column
lattice validate --json
```

Expected proofs (each tagged to its milestone):

- (M1) product capability release ledger parse passes; malformed capability rows are rejected; fail-closed on `gateEvidence:true`.
- (M1) `capabilityDigest`/`idempotencyKey`/`id` fixed-input reference values match; gate-import guard test passes.
- (M3) re-run with a different `mainCommit` yields `already_recorded` (no duplicate).
- (M4) pre-existing 3-field lineage parses; enrichment attaches capability fields; re-apply is a no-op; recover-path records a release with no candidate.
- (M6) candidate absent from `MemoryFreshnessPack.results.playbookIds`.
- (M7) DONE-settlement outcome does not increment `helped`; no `helped` inferred from DONE.
- (backfill proof) fixture dry-run detects exactly one; apply enriches exactly one; repeated apply idempotent; candidate stays `status=candidate`; `surfacedCount` unchanged.

### Follow-up subset (separate story)

```bash
lattice capability_release_backfill --dryRun --storyId=B-785e --json
lattice capability_release_backfill --apply --storyId=B-785e --digest=<dry-run-digest> --json
```

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Capability releases become a second package semver | Keep package semver and product capability release separate in schema and CLI output. |
| Candidate gets promoted without evidence | Keep candidate inert (`matchActivePlaybook` active-only guard); require exposure and structured outcome. |
| Backfill creates duplicate playbooks | Dedup on the stable source key + `idempotencyKey`; enrichment defined as no-op when capability lineage already present. |
| Artifact releases are mistaken for activation | Keep `authority=non_authoritative`, `gateEvidence=false` (reader fail-closed), and explicit `activationBoundary`. |
| Semantic classifier overreaches | Conservative classification; uncertain cases produce advisory only. |
| Idempotency key embeds a volatile input | Merge-stable key (`storyId+capabilityId+capabilityDigest`); `mainCommit` is provenance only; Design Principle 8. |
| Classifier wired to one of two DONE sites | Pure `core/` classifier imported by both `done-effects.ts:1167` and `done-recover.ts:116`; recover-path fixture assertion. |
| Lineage widening breaks digest-based idempotency | Optional fields; idempotency on source key not digest equality; enrichment recomputes digests; re-apply-no-op smoke. |
| Capability ledger wired into a gate later | Negative-invariant guard test greps gate/DONE/validate/delivery modules for the reader symbol. |
| Cross-host binding lost (git-ignored playbooks.json) | Committed `capability-releases.jsonl` is the cross-host source of truth; local lineage is a convenience pointer. |

## Resolved Decisions (formerly Open Questions)

**OQ1 — capabilityId source (now normative in M1/M2/M3).** `capabilityId` is an explicit optional story-scope declaration with a **deterministic changed-path-derived slug fallback** — the only host-neutral option reproducible on a clean checkout. Fallback rule: from the capability-declaring `changedPaths`, take the shallowest shared directory under `experiments/` or `docs/` and slugify it (lowercase, `/`→`-`, non-alnum→`-`, collapse repeats). Continuity/collision rule: the same `capabilityId` across stories denotes the same product surface (a new version of it), not a collision. For B-785e (paths under `experiments/multi-model-ablation/…`), the fallback yields `capabilityId = experiments-multi-model-ablation`, making backfill reproducible.

**OQ2 — capabilityVersion semantics (now normative in M1/M3).** `capabilityVersion` is **digest-derived** (stateless, reproducible on a clean checkout): the 12 hex characters of `capabilityDigest` immediately after its `sha256:` prefix, i.e. `capabilityVersion = capabilityDigest.slice('sha256:'.length, 'sha256:'.length + 12)` (a stable 12-char slice of `capabilityDigest`). A monotonic-per-id counter is rejected: it is read-modify-write under lock, differs on a fresh checkout, and would perturb the idempotency key → duplicate records. The M4 example's hardcoded `"1"` is replaced by this 12-hex value.

**OQ3 — artifact_release_status linkage (deferred, default set).** Keep capability inspection in the separate `capability_release_*` commands for V1 (preserves the clean read-only clone of `handlers/artifact-release.ts` and command-policy parity). Cross-linking inside `artifact_release_status` is an optional later enhancement; it does not affect the schema or idempotency contracts.

**OQ4 — pending-learning exposure in session_brief (deferred to follow-up, default set).** Default to "only when explicitly requested" (safest; preserves the candidate-inert non-goal). This lives entirely in the follow-up M6 exposure work and is settled there.

## M4 Lineage Example (illustrative)

Real, byte-exact B-785e values are marked; classifier outputs are illustrative until produced by the resolved OQ1/OQ2 rules.

```jsonc
{
  "lineage": {
    // real, existing 3-field lineage (must still parse without the fields below):
    "sourceStoryId": "B-785e",
    "sourceFindingId": "B-785e:DONE-EXPERIENCE",
    "sourceSignature": "done_experience",
    // new OPTIONAL capability fields:
    "capabilityReleaseId": "PCR-…",                    // illustrative (PCR- derivation, M3)
    "capabilityId": "experiments-multi-model-ablation", // illustrative (OQ1 slug rule)
    "capabilityVersion": "…12-hex…",                    // illustrative (OQ2 digest-derived)
    "artifactReleaseId": "AR-4e885ed0209e5a32330cdc33", // REAL B-785e value
    "artifactSetDigest": "sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9" // REAL B-785e value
  }
}
```

## Follow-up Story

Open a follow-up story (reference its id here once created) for: the standalone `capability_release_backfill` CLI (M8), candidate pending-learning exposure surfaces + exposure records (M6), and structured-outcome/promotion command surfaces (M7). Do not declare the capability-release lifecycle fully closed until that story's real-host B-785e backfill runs; V1's hermetic backfill proof is sufficient to ship V1.
