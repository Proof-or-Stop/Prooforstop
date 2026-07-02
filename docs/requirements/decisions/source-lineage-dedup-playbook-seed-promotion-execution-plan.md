# Source Lineage Dedup And Historical Playbook Seed Promotion Execution Plan

Status: execution plan
Created: 2026-07-02
Current implementation: B-01df implements M1 only, the read-only
`source_lineage_audit --domain=learning` audit. Later milestones in this
document are not implemented by B-01df unless a later story explicitly says so.

Naming note: public project naming is Proof-or-Stop. Current internal documents
may still use Proofbound, and the current CLI binary and storage paths may still
use legacy `lattice` / `.lattice` names until the runtime rename migration is
completed.

## 1. Why This Exists

Proofbound has useful historical experience, but that experience is not yet
connected to the playbook promotion loop in a complete and auditable way.

Current state:

- `.lattice/dev-memory/experience.jsonl` exists and is consumed as
  non-authoritative runtime memory.
- `.lattice/learning/finding-signals.json` exists and contains historical
  finding-derived signals.
- `playbook_propose` can create a proposal directly from a raw finding.
- `playbook_promotion_observe` can report candidate, consumption, and
  recommendation posture.
- Before B-01df there was no generic source-lineage or dedup audit command.
- There is still no bridge that turns historical `dev-memory` /
  `finding-signals` into deduped playbook seeds.

This creates two correctness problems:

1. Historical experience is useful for session context, but it is not yet a
   first-class source for playbook candidate creation.
2. If raw findings, finding-signals, and dev-memory are later wired into
   proposal generation independently, the same underlying fact can be counted
   multiple times as if it were independent evidence.

The goal is not optimization for its own sake. The goal is a correctness
boundary for learning systems:

```text
A derived artifact must not be treated as independent evidence when it shares
the same canonical source as another artifact.
```

## 2. Concrete Failure Mode

Historical experience can remain passive prose. If an agent does not search,
remember, promote, or consume the right lesson at the right time, it can still
make a false current-capability claim.

Example incorrect claim:

```text
Authority Server / production receipt / Layer4 customerKeyRef are live.
```

Correct bounded claim:

```text
The completed work is local Proofbound CLI / roadmap closure scope. Retired
Authority Server, external production receipt, and Layer4 customerKeyRef
capabilities require current receipt-backed evidence before they can be claimed
as live.
```

The fix is not merely "store more memory." The memory has to be audited,
deduped, promoted only through explicit thresholds, and then consumed by the
runtime entrypoints where false claims are made.

Target chain:

```text
historical facts / dev-memory / finding-signals
  -> source lineage dedup
  -> seed observe
  -> proposal / candidate
  -> explicit outcome and promotion recommendation
  -> active advisory playbook
  -> runtime consumer warning before final claims
```

## 3. Product Goal

Turn historical experience into useful candidate playbooks without losing the
proof boundary.

```text
raw findings / story facts
  -> experience distillation
  -> dev-memory / finding-signals
  -> source-lineage and dedup audit
  -> one chosen playbook seed per canonical source
  -> proposal / candidate playbook
  -> explicit exposure + structured outcome
  -> promotion recommendation
  -> controlled advisory auto-promotion only after evidence thresholds
```

Short version:

```text
Historical experience should become candidate material, but only through a
deduped, lineage-backed, non-authoritative learning path.
```

## 4. Non-Goals

- Do not let dev-memory, finding-signals, seed audits, playbook candidates, or
  promotion decisions satisfy review, validation, delivery, DONE, receipt,
  release, or production gates.
- Do not bulk-activate playbooks from history.
- Do not treat DONE success as proof that a playbook helped.
- Do not claim semantic dedup is perfect. V1 guarantees structured lineage
  dedup and only warns on semantic similarity.
- Do not create blocking lifecycle policy from playbook content.
- Do not make historical experience mandatory for ordinary story completion.
- Do not make all dev-memory entries into playbooks. Some lessons should remain
  memory-only.

## 5. Core Distinction

Historical experience has three layers:

| Layer | Example | Purpose | Authority |
| --- | --- | --- | --- |
| Raw source | finding, review note, story summary, delivery result | factual provenance | current lifecycle authority, but noisy |
| Distilled experience | dev-memory, finding-signal, story recall profile | reusable context / seed material | non-authoritative |
| Playbook | candidate / active advisory rule | operational checklist or reminder | non-authoritative |

`dev-memory` is not useless. It is the intended middle layer. The gap is that it
does not yet become the preferred source for playbook seeds.

## 6. Source Priority

When multiple artifacts point to the same underlying issue, Proofbound should
choose one primary proposal source.

Recommended priority:

1. `dev-memory` with explicit `sourceStoryId` and `evidenceRefs`.
2. `finding-signal` with support above a configured threshold and valid anchors.
3. Raw finding with stable `sourceStoryId` / `sourceFindingId`.
4. Manual operator source with explicit reason.

Rules:

- A raw finding may be used as fallback when no better distilled source exists.
- A finding-signal may propose an aggregate playbook, not many duplicate
  per-finding playbooks for the same canonical source.
- A dev-memory entry may propose a playbook only when it has enough lineage to
  trace back to source facts.
- A source marked `non_promotable` must not generate another candidate unless an
  explicit override reason is recorded.
- `non_promotable` means "this source must not generate a playbook candidate."
  Legacy runtime names such as `non_deducible` / `mark_non_deducible` are
  compatibility spellings until the runtime rename is completed.

## 7. Generic Source Lineage Model

The lineage model should be generic enough for other projects using
Proofbound / Lattice CLI, not just this repository.

Every derived learning artifact should project a normalized source record:

```ts
interface SourceLineageRecord {
  artifactId: string;
  artifactKind: string;
  sourceRefs: string[];
  canonicalSourceKey: string;
  canonicalSourceKeyVersion: string;
  canonicalizationPolicyHash: string;
  derivationKind: string;
  authority: 'non_authoritative' | 'authoritative';
  gateEvidence: boolean;
  confidence?: number;
  support?: number;
  supersedes?: string[];
  derivedFrom?: string[];
}
```

For Proofbound learning, `canonicalSourceKey` is derived from:

```text
sourceStoryId + sourceFindingId + optional normalized signature
```

`canonicalSourceKeyVersion` and `canonicalizationPolicyHash` are required audit
fields. They make old keys interpretable after source normalization rules
change.

Other projects can define their own source identity:

- GitHub issue id
- log incident id
- test failure id
- requirement paragraph id
- review comment id
- bug report id
- design note id
- agent memory id with evidence refs

## 8. Commands

### 8.1 `source_lineage_audit`

Generic read-only audit.

```bash
lattice source_lineage_audit --domain=learning --json
```

Reports:

- source record count;
- missing lineage count;
- duplicate canonical source groups;
- downstream artifacts per canonical source;
- diagnostics for missing or malformed stores;
- `authority: non_authoritative`;
- `gateEvidence: false`.

This command writes nothing and remains host-neutral. It does not create seeds,
proposals, candidates, outcomes, promotion decisions, active playbooks, runtime
blocking policy, or DONE settlement rows.

B-01df implements this command for `--domain=learning`. Unsupported domains
must fail clearly.

### 8.2 `playbook_seed_observe`

Future Proofbound learning-specific read-only view built on top of
`source_lineage_audit`.

```bash
lattice playbook_seed_observe --json
lattice playbook_seed_observe --source=dev-memory --json
lattice playbook_seed_observe --source=finding-signals --json
```

Reports:

- proposable dev-memory seeds;
- proposable finding-signal seeds;
- raw findings without distilled experience;
- duplicate seed groups;
- seeds blocked by missing lineage;
- seeds blocked by `non_promotable`;
- seeds already represented by a proposal / candidate / active playbook;
- `observeDigest` over the reviewed seed set.

### 8.3 `playbook_seed_propose_batch`

Future command for creating proposals from deduped historical seeds. Default
must be dry-run.

```bash
lattice playbook_seed_propose_batch --dryRun --limit=20
lattice playbook_seed_propose_batch --apply --source=dev-memory --limit=20 --observeDigest=<digest>
```

Rules:

- uses the primary source selected by `playbook_seed_observe`;
- records the seed source and canonical source key;
- `--apply` requires `--observeDigest` from `playbook_seed_observe`;
- `--apply` fails if the current observe digest differs from the reviewed
  observe digest;
- never creates active playbooks;
- never writes outcome rows;
- refuses missing lineage unless an explicit manual override is supplied;
- refuses duplicate canonical sources unless the existing artifact is stale or
  archived and the command records a replacement reason.

### 8.4 Promotion And Auto-Promotion

Existing promotion commands remain part of the loop:

```bash
lattice playbook_outcome_record ...
lattice playbook_promotion_sweep --dryRun
lattice playbook_promotion_sweep --apply
lattice playbook_promotion_observe --since=14d --json
lattice playbook_promotion_status --json
```

V1 behavior:

- `playbook_promotion_sweep --apply` may write recommendation rows.
- It must not activate candidates.
- It may recommend activation, reject, archive, recommend demotion, or mark a
  source as `non_promotable`.

V2 controlled advisory auto-promotion is future-only:

```bash
lattice playbook_auto_promotion_apply --dryRun
lattice playbook_auto_promotion_apply --apply
```

Allowed only when:

- `PLAYBOOK_AUTO_ACTIVE_ENABLED=true`;
- the candidate has explicit exposure records;
- decisive samples meet the configured threshold;
- helped / dismissed / harmful counts meet evaluator thresholds;
- no unresolved harmful / wrong-claim signal exists;
- source lineage audit has no duplicate-source or missing-lineage blocker for
  that candidate;
- activation writes only advisory `active` playbook status, never gate evidence.

Execution phase boundary:

- V1 implementation stops at recommendation rows and runtime-consumption
  verification.
- V2 auto-promotion must remain disabled until V1 has real outcome records and a
  human-reviewed threshold policy.
- First-stage development must not enable automatic `candidate -> active`
  mutation.

## 9. Runtime Consumer Closure

An active playbook does not solve a failure mode unless the right runtime
entrypoints consume it.

Required consumers:

```text
session_brief
dev_memory_start
story_create / story_advance
done_prepare / done_closure
final_response_check
```

Future minimum closure command:

```bash
lattice playbook_runtime_consumption_verify --json
```

It must prove:

- active playbooks matching the current query appear in the memory freshness
  pack;
- candidate playbooks remain inert;
- `final_response_check` receives active playbook warnings before an operator or
  host makes a final capability claim;
- DONE closure still relies on structured evidence, not memory;
- missing or stale runtime consumption is reported according to rollout policy.

## 10. DONE Settlement Rollout

`PLAYBOOK_DONE_SETTLEMENT_ENABLED` should not be enabled by default until it has
clear product value.

Current safe but limited behavior:

```text
DONE durable
  -> optional non-blocking health row
  -> no helped outcome inferred from DONE success
```

Rollout criteria before default-on:

1. `playbook_promotion_status` clearly displays settlement health and retention.
2. Settlement rows are compacted or bounded.
3. No DONE lock contention, stale evidence loop, or measurable DONE delay is
   observed.
4. At least one real candidate consumption path exists, so settlement health is
   not the only learning output.
5. Documentation states that settlement does not prove usefulness.

Until then, the flag may be used in experimental local runs only.

## 11. Milestones

### M0. Red / Observation Baseline

Prove the current gap without changing behavior:

- baseline transcript showing existing dev-memory, finding-signals, and empty
  playbook proposal/candidate/outcome state;
- red test or smoke proving no generic lineage audit command exists;
- red test proving `playbook_propose` only accepts raw finding source.

### M1. Generic Source Lineage Audit

Provide project-neutral read-only source lineage inspection.

Deliverables:

- source lineage record types;
- source collectors for Proofbound learning artifacts;
- `source_lineage_audit --domain=learning --json`;
- duplicate canonical source grouping;
- missing lineage diagnostics;
- no writes and no gate evidence.

Tests:

- one raw source with two derived artifacts is reported as one duplicate group;
- missing lineage is reported, not silently ignored;
- non-authoritative derived artifacts cannot appear as gate evidence;
- command is read-only and host-neutral.

B-01df implements M1.

### M2. Playbook Seed Observe

Make historical experience useful without creating candidates yet.

### M3. Historical Batch Proposal

Create proposals from deduped historical seeds with dry-run default and
`--observeDigest` apply protection.

### M4. Batch Candidate Approval

Let reviewed historical proposals become inert candidate playbooks through a
manifest digest.

### M5. Promotion Evidence Loop

Connect candidate outcomes to promotion recommendations without treating DONE
success as helped.

### M6. Runtime Consumer Closure

Ensure active playbooks are consumed by `session_brief`, DONE closure, and
`final_response_check`.

### M7. Health, Retention, And External Project Readiness

Make the mechanism reusable outside this repository.

### M8. Controlled Auto-Promotion (V2+)

Enable advisory auto-activation only after V1 has real outcome records and a
human-reviewed threshold policy.

## 12. Acceptance Criteria

- Historical experience can be observed as candidate material without mutation.
- Batch historical candidate creation is possible only after source dedup.
- A single canonical source cannot silently create multiple active proposal
  paths.
- `dev-memory` becomes a preferred seed source when it has sufficient lineage.
- Raw finding proposal remains available as fallback/manual path.
- Automatic advisory activation is disabled by default and cannot bypass
  lineage, exposure, outcome, or safety thresholds.
- Active playbooks are verified as consumed by `session_brief`, DONE closure,
  and `final_response_check`.
- No learning artifact can satisfy lifecycle gate evidence.
- The generic lineage audit can be used by other projects with non-Proofbound
  source kinds.

## 13. Why Existing CLI Did Not Catch This

Existing checks cover:

- code correctness;
- lifecycle evidence;
- review quorum;
- DONE readiness;
- stale evidence;
- command policy;
- runtime authority boundary;
- candidate-vs-active playbook runtime behavior.

They do not yet cover:

- multiple derived learning artifacts sharing one canonical source;
- source priority conflicts;
- proposal creation from a lower-quality source when a better distilled source
  exists;
- double-counting derived experience as independent evidence;
- whether a promoted active playbook is actually consumed by the final-response
  or DONE-closure entrypoint that needed it;
- cross-project lineage dedup for external issue/log/test-memory systems.

This plan adds that missing audit layer.

## 14. Safety Rules

- Source lineage audit is read-only.
- Seed observe is read-only.
- Batch proposal defaults to dry-run.
- Batch candidate approval requires manifest digest.
- Promotion sweep writes recommendation rows only.
- Auto-promotion requires an explicit feature flag and can only activate
  advisory playbooks.
- DONE settlement remains non-blocking and cannot infer helped from DONE
  success.

## 15. Related Documents

- `docs/requirements/decisions/dev-memory.md`
- `docs/requirements/decisions/lattice-experience-layer-execution-plan.md`
- `docs/requirements/decisions/lattice-experience-layer-effectiveness-record.md`
- `docs/requirements/decisions/playbook-promotion-worker-execution-plan.md`
- `docs/requirements/decisions/playbook-runtime-memory-consumption-execution-plan.md`
