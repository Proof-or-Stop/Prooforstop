# Multi-Model Ablation Research Artifacts

This directory contains provider-free research scaffolding for the protocol in `docs/requirements/decisions/multi-model-ablation-replication.md`.

These files are not executable Phase 1 or Phase 2 result artifacts. They do not call providers, do not contain ablation results, do not unlock product gates, and do not alter DONE, playbook, runtime, or default agent guidance.

## Files

### M2 Launch Readiness

- `m2-launch-readiness.json` records the 2026-07-05 provider-free readiness boundary while keeping provider execution disabled.
- `model-snapshot-lock.m2.json` declares dated E1/E2 provider-family readiness and keeps host labels separate from model families.
- `task-inventory.m2.json` binds the 24 existing `experiments/recovery-runner/tasks` directories read-only by digest without editing those tasks.
- `phase1-runner-manifest.m2.json` represents required Phase 1 cells ③, ⑥, and ②, with optional ④ kept budget-permitting, and mechanically binds those cells plus task-slot lineage back to `seed-manifest.m1.json` and `cell-matrix.m1.json`.
- `phase1-launch-readiness.m2.json` keeps ③ A4 calibration pending and ⑥ A2prime blocked until a real ③-derived budget lock exists.
- `m2-provider-execution-launch.json` records the disabled-by-default provider execution authorization boundary with `providerExecutionAuthorized=false`, required metadata blockers, cell 03 as the planning-only next step, and cell 06 still blocked.
- `m2-provider-execution-authorization.json` records the B-11be metadata-only authorization boundary: provider spend USD 0.00, no provider cells ran, no result rows exist, cell 03 is next, and cell 06 remains blocked.
- `m2-cell03-provider-launch-authorization.json` records the B-c25c Cell 03 launch guardrail: exact spend approval is absent, `providerSpendAllowed=false`, `providerCallEnabled=false`, amount/currency/approvalSource/approvedBy/approvalDate remain required before any nonzero budget approval, no outcome rows exist, and cell 06 remains blocked.
- `m2-status.md` summarizes M0/M1 completion, M2 readiness, and the still-pending M3-M6 research work.
- `m2-launch-readiness-check.mjs` validates the M2 artifacts and in-memory negative controls without running provider cells.
- `m2-provider-execution-check.mjs` validates the provider execution launch boundary plus the B-11be metadata-only authorization artifact and the B-c25c Cell 03 guardrail, including accidental authorization, invented or unbound budget approval, zero-budget spend allowance, missing exact approval fields, host-label-only snapshot, provider fallback, duplicate or extra runner ownership, no outcome/result rows, no provider calls, and cell 03/cell 06 sequencing negative controls.

### M1 Freeze

- `protocol.lock.json` binds the protocol document by SHA-256.
- `seed-manifest.m1.json` freezes task/scenario/repeat slots and deterministic seed policy.
- `cell-matrix.m1.json` freezes the provider-free Phase 1 cell matrix.
- `phase1-launch-gate.m1.json` keeps Phase 1 launch blocked.
- `m1-freeze-check.mjs` validates the M1 freeze layer.

### M0 Examples

- `cell-manifest.example.json` shows formal, unique `cellKey` rows for ③, ⑥, ②, and optional ④. It also encodes the required ordering: ③ E2 A4 calibration precedes the ⑥ E2 A2prime row, and A2prime requires a `budgetLockDigest`.
- `runner-registry.example.json` shows runner pre-registration while keeping `hostKind` separate from `executorSnapshot` and `reviewerSnapshot`.
- `phase1-budget-lock.example.json` shows the Phase 1 budget-lock shape and ordering constraints without provider-derived budget or outcome data.

## Provider-Free Local Checks

Parse the JSON examples:

```bash
node -e 'const fs=require("node:fs"); for (const f of ["experiments/multi-model-ablation/cell-manifest.example.json","experiments/multi-model-ablation/runner-registry.example.json","experiments/multi-model-ablation/phase1-budget-lock.example.json"]) { JSON.parse(fs.readFileSync(f,"utf8")); console.log("parsed", f); }'
```

Check the protocol and examples mention the M0 boundary, budget lock, and host/model separation:

```bash
rg -n "research / paper-evidence|M0|Tier-C|M-crypto|③|⑥|②|④|budgetLockDigest|executorSnapshotDigest|reviewerSnapshotDigest|toolSurfaceDigest|promptDigest|protocolLockDigest|calibrationWindow|snapshotDate|hostKind|executorSnapshot|reviewerSnapshot|eligibleForOutcomeRecords|product gates|DONE|playbook|runtime" docs/requirements/decisions/multi-model-ablation-replication.md experiments/multi-model-ablation
```

Check example invariants without running cells:

```bash
node <<'NODE'
const fs = require("node:fs");

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const manifest = readJson("experiments/multi-model-ablation/cell-manifest.example.json");
const registry = readJson("experiments/multi-model-ablation/runner-registry.example.json");
const budgetLock = readJson("experiments/multi-model-ablation/phase1-budget-lock.example.json");

const assertBoundary = (doc, name) => {
  const boundary = doc.researchBoundary;
  if (!boundary) throw new Error(`${name} missing researchBoundary`);
  if (boundary.providerCallsMade !== false) throw new Error(`${name} must not call providers`);
  if (boundary.containsOutcomeData !== false) throw new Error(`${name} must not contain outcome data`);
  if (boundary.phase1OrPhase2CellsRun !== false) throw new Error(`${name} must not run Phase 1/2 cells`);
  if (boundary.productGateImpact !== "none") throw new Error(`${name} must not affect product gates`);
};

const digestFields = [
  "budgetLockDigest",
  "executorSnapshotDigest",
  "toolSurfaceDigest",
  "promptDigest",
  "protocolLockDigest",
];
const isShaExample = (value) => typeof value === "string" && value.startsWith("sha256:example-");
const sameText = (a, b) => (
  typeof a === "string" &&
  typeof b === "string" &&
  a.trim().toLowerCase() === b.trim().toLowerCase()
);

assertBoundary(manifest, "cell manifest");
assertBoundary(registry, "runner registry");
assertBoundary(budgetLock, "budget lock");

const cellsByKey = new Map();
const a2PrimeCellsByKey = new Map();
for (const cell of manifest.cells) {
  if (cellsByKey.has(cell.cellKey)) throw new Error(`duplicate cellKey: ${cell.cellKey}`);
  cellsByKey.set(cell.cellKey, cell);
  if (cell.arm === "A2prime" && !cell.budgetLockDigest) {
    throw new Error(`A2prime row missing budgetLockDigest: ${cell.cellKey}`);
  }
  if (cell.arm === "A2prime") a2PrimeCellsByKey.set(cell.cellKey, cell);
  if ("outcome" in cell) throw new Error(`example cell must not include outcome: ${cell.cellKey}`);
}

const runnersById = new Map();
for (const runner of registry.runners) {
  if (!runner.runnerId) throw new Error("runner missing runnerId");
  if (runnersById.has(runner.runnerId)) throw new Error(`duplicate runnerId: ${runner.runnerId}`);
  runnersById.set(runner.runnerId, runner);
  if (!runner.hostKind || !runner.executorSnapshot) {
    throw new Error(`runner missing host/model separation: ${runner.runnerId}`);
  }
  if (sameText(runner.hostKind, runner.executorSnapshot)) {
    throw new Error(`hostKind reused as executorSnapshot: ${runner.runnerId}`);
  }
  if (runner.reviewerSnapshot && sameText(runner.hostKind, runner.reviewerSnapshot)) {
    throw new Error(`hostKind reused as reviewerSnapshot: ${runner.runnerId}`);
  }
  if ((runner.reviewerFamily === "same" || runner.reviewerFamily === "cross") && !runner.reviewerSnapshot) {
    throw new Error(`reviewerSnapshot required for ${runner.reviewerFamily} runner: ${runner.runnerId}`);
  }
  if (runner.reviewerFamily === "not_applicable" && runner.reviewerSnapshot !== null) {
    throw new Error(`not_applicable runner must keep reviewerSnapshot null: ${runner.runnerId}`);
  }
  if (runner.providerCallEnabled !== false) {
    throw new Error(`example runner must keep provider calls disabled: ${runner.runnerId}`);
  }
  if (runner.eligibleForOutcomeRecords !== false) {
    throw new Error(`example runner must not be eligible for outcome records: ${runner.runnerId}`);
  }
}

const a2PrimeClaimsByCellKey = new Map();
for (const lock of budgetLock.locks) {
  for (const field of digestFields) {
    if (!isShaExample(lock[field])) throw new Error(`budget lock ${lock.lockKey} missing example digest field: ${field}`);
  }
  if (!lock.executorSnapshot) throw new Error(`budget lock missing executorSnapshot: ${lock.lockKey}`);
  if (!lock.calibrationWindow || !lock.calibrationWindow.start || !lock.calibrationWindow.end) {
    throw new Error(`budget lock missing calibrationWindow: ${lock.lockKey}`);
  }
  if (!lock.snapshotDate) throw new Error(`budget lock missing snapshotDate: ${lock.lockKey}`);
  if (lock.sourceReviewerFamily === "same" || lock.sourceReviewerFamily === "cross") {
    if (!lock.reviewerSnapshot || !isShaExample(lock.reviewerSnapshotDigest)) {
      throw new Error(`budget lock missing reviewer snapshot digest: ${lock.lockKey}`);
    }
  }
  if (lock.appliesToReviewerFamily === "not_applicable") {
    if (lock.appliesToReviewerSnapshot !== null || lock.appliesToReviewerSnapshotDigest !== null) {
      throw new Error(`A2prime lock must keep applies-to reviewer snapshot not_applicable: ${lock.lockKey}`);
    }
    if (!String(lock.appliesToReviewerSnapshotSemantics).includes("not_applicable")) {
      throw new Error(`budget lock missing not_applicable reviewer semantics: ${lock.lockKey}`);
    }
  }
  if (lock.a2PrimeExecutionAllowed !== false) {
    throw new Error(`example budget lock must not enable A2prime execution: ${lock.lockKey}`);
  }
  if (lock.medianSpendFromA4Calibration !== null) {
    throw new Error(`example budget lock must not include provider-derived spend: ${lock.lockKey}`);
  }
  if (!Array.isArray(lock.appliesToCellKeys)) {
    throw new Error(`budget lock missing appliesToCellKeys: ${lock.lockKey}`);
  }
  const appliesToCellKeysInLock = new Set();
  for (const appliesToKey of lock.appliesToCellKeys) {
    if (appliesToCellKeysInLock.has(appliesToKey)) {
      throw new Error(`duplicate appliesToCellKey in budget lock ${lock.lockKey}: ${appliesToKey}`);
    }
    appliesToCellKeysInLock.add(appliesToKey);

    const appliesToCell = cellsByKey.get(appliesToKey);
    if (!appliesToCell) {
      throw new Error(`budget lock appliesToCellKeys references missing manifest row: ${lock.lockKey} -> ${appliesToKey}`);
    }
    if (appliesToCell.arm !== "A2prime") {
      throw new Error(`budget lock appliesToCellKeys references non-A2prime manifest row: ${lock.lockKey} -> ${appliesToKey}`);
    }
    if (appliesToCell.budgetLockDigest !== lock.budgetLockDigest) {
      throw new Error(`A2prime budgetLockDigest does not match budget lock: ${appliesToKey} -> ${lock.lockKey}`);
    }

    const claims = a2PrimeClaimsByCellKey.get(appliesToKey) || [];
    claims.push(lock.lockKey);
    a2PrimeClaimsByCellKey.set(appliesToKey, claims);
  }
  for (const sourceKey of lock.sourceCellKeys) {
    const sourceCell = cellsByKey.get(sourceKey);
    const sourceRunner = sourceCell && runnersById.get(sourceCell.runnerId);
    if (!sourceRunner) throw new Error(`budget lock source missing runner binding: ${sourceKey}`);
    if (sourceRunner.executorSnapshot !== lock.executorSnapshot) {
      throw new Error(`budget lock executorSnapshot does not match source runner: ${lock.lockKey}`);
    }
    if ((lock.sourceReviewerFamily === "same" || lock.sourceReviewerFamily === "cross") && sourceRunner.reviewerSnapshot !== lock.reviewerSnapshot) {
      throw new Error(`budget lock reviewerSnapshot does not match source runner: ${lock.lockKey}`);
    }
  }
}

for (const [cellKey] of a2PrimeCellsByKey) {
  const claims = a2PrimeClaimsByCellKey.get(cellKey) || [];
  if (claims.length === 0) {
    throw new Error(`A2prime row missing from all budget lock appliesToCellKeys: ${cellKey}`);
  }
  if (claims.length > 1) {
    throw new Error(`A2prime row claimed by multiple budget locks: ${cellKey} (${claims.join(", ")})`);
  }
}

console.log("example invariants passed");
NODE
```

These commands are intentionally limited to `rg` and local `node` parsing. They do not run Phase 1/2 cells and do not contact model providers.

## M2 Local Checks

Run the M2 launch-readiness checker:

```bash
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
```

The checker recomputes task digests, verifies E1/E2 provider-family separation, confirms required cells ③/⑥/②, compares M2 seed/task-slot/cell lineage to the frozen M1 seed and cell matrix, preserves ③ and ⑥ execution blockers, and rejects in-memory negative controls. It is local-only and does not contact providers.

Run the M2 provider-execution launch checker:

```bash
node experiments/multi-model-ablation/m2-provider-execution-check.mjs
```

The checker reads the existing M2 readiness artifacts plus `m2-provider-execution-launch.json`, `m2-provider-execution-authorization.json`, and `m2-cell03-provider-launch-authorization.json`. It keeps provider execution disabled, records B-11be metadata authorization with provider spend USD 0.00, records the B-c25c Cell 03 guardrail with exact budget approval absent, requires exact amount/currency/approvalSource/approvedBy/approvalDate before any nonzero Cell 03 spend approval, rejects host-label-only snapshots, provider fallback, invented budget approval, duplicate or extra runner ownership, and outcome/result rows, reports `nextPermittedFormalStep=cell-03-calibration`, and keeps `cell-06-a2prime-blocked` until a real cell-03-derived budget lock exists. It is local-only and does not contact providers.
