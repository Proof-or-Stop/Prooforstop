# Multi-Model Ablation M0 Examples

This directory contains M0-only research scaffolding for the protocol in `docs/requirements/decisions/multi-model-ablation-replication.md`.

These files are examples, not executable Phase 1 or Phase 2 artifacts. They do not call providers, do not contain ablation outcomes, do not unlock product gates, and do not alter DONE, playbook, runtime, or default agent guidance.

## Files

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
for (const cell of manifest.cells) {
  if (cellsByKey.has(cell.cellKey)) throw new Error(`duplicate cellKey: ${cell.cellKey}`);
  cellsByKey.set(cell.cellKey, cell);
  if (cell.arm === "A2prime" && !cell.budgetLockDigest) {
    throw new Error(`A2prime row missing budgetLockDigest: ${cell.cellKey}`);
  }
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

console.log("example invariants passed");
NODE
```

These commands are intentionally limited to `rg` and local `node` parsing. They do not run Phase 1/2 cells and do not contact model providers.
