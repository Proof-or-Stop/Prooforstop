#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER_RESEARCH_BOUNDARY = Object.freeze({
  providerCallsMade: false,
  containsOutcomeData: false,
  phase1OrPhase2CellsRun: false,
  productGateImpact: "none",
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const paths = {
  smoke: "m0-research-smoke.json",
  registry: "runner-registry.m0.json",
  snapshots: "model-snapshot-lock.m0.json",
  manifest: "cell-manifest.m0.json",
  budget: "phase1-budget-lock.m0.json",
  status: "m0-status.md",
  exampleRegistry: "runner-registry.example.json",
  exampleManifest: "cell-manifest.example.json",
  exampleBudget: "phase1-budget-lock.example.json",
};

const failures = [];
let assertionCount = 0;
let negativeControlRejectCount = 0;

function fail(message) {
  throw new Error(message);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameText(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

function includesText(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function assert(condition, message) {
  if (!condition) fail(message);
  assertionCount += 1;
}

function assertBoundary(doc, name) {
  const boundary = doc.researchBoundary;
  assert(boundary, `${name} missing researchBoundary`);
  for (const [key, expected] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(
      boundary[key] === expected,
      `${name} researchBoundary.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(boundary[key])}`,
    );
  }
}

function assertNoOutcomeFields(value, location = "document") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOutcomeFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "outcome") fail(`${location} contains forbidden outcome field`);
    assertNoOutcomeFields(child, `${location}.${key}`);
  }
}

function validateSmoke(smoke) {
  assertBoundary(smoke, "m0 research smoke");
  assert(smoke.scope?.providerModelCallsForbidden === true, "m0 research smoke must forbid provider calls");
  assert(smoke.scope?.phase1CampaignForbidden === true, "m0 research smoke must forbid Phase 1 campaigns");
  assert(smoke.scope?.phase2CampaignForbidden === true, "m0 research smoke must forbid Phase 2 campaigns");
  assert(smoke.scope?.outcomeRecordsWritten === false, "m0 research smoke must not write outcome records");
  assert(smoke.scope?.productGateChanges === "none", "m0 research smoke must have no product gate changes");
  assert(smoke.m0ExitBoundary?.phase1MayStart === false, "M0 smoke must not allow Phase 1 start");
  const required = [
    "m0-smoke-check.mjs",
    "m0-research-smoke.json",
    "m0-status.md",
    "runner-registry.m0.json",
    "model-snapshot-lock.m0.json",
    "cell-manifest.m0.json",
    "phase1-budget-lock.m0.json",
  ];
  for (const artifact of required) {
    assert(smoke.ownedArtifacts?.includes(artifact), `m0 research smoke missing owned artifact ${artifact}`);
  }
}

function validateRunnerRegistry(registry, { requireM0Hosts = false } = {}) {
  assertBoundary(registry, registry.artifact || "runner registry");
  assert(
    /hostKind/i.test(registry.hostModelSeparationRule || "") &&
      /executorSnapshot/i.test(registry.hostModelSeparationRule || "") &&
      /reviewerSnapshot/i.test(registry.hostModelSeparationRule || ""),
    `${registry.artifact || "runner registry"} must state host/model separation`,
  );

  if (requireM0Hosts) {
    const observed = new Map(
      (registry.localHostAvailabilityObservedByMain || []).map((host) => [host.hostKind, host]),
    );
    const requiredHosts = [
      ["codex-cli", "0.141.0"],
      ["Claude Code", "2.1.201"],
      ["agy", "1.0.16"],
    ];
    for (const [hostKind, version] of requiredHosts) {
      const host = observed.get(hostKind);
      assert(host, `missing local host availability for ${hostKind}`);
      assert(host.observedVersion === version, `${hostKind} version must be ${version}`);
      assert(
        host.hostKindClassification === "host_or_adapter_not_model_family",
        `${hostKind} must be classified as a host, not a model family`,
      );
    }
    assert(registry.snapshotReadiness?.formalPhase1Readiness === false, "runner registry must not claim Phase 1 readiness");
    assert(registry.snapshotReadiness?.providerExecutionLocked === false, "M0 runner registry must not claim execution-locked snapshots");
  }

  const runnersById = new Map();
  for (const runner of registry.runners || []) {
    assert(runner.runnerId, "runner missing runnerId");
    assert(!runnersById.has(runner.runnerId), `duplicate runnerId: ${runner.runnerId}`);
    runnersById.set(runner.runnerId, runner);

    assert(runner.hostKind, `runner missing hostKind: ${runner.runnerId}`);
    assert(runner.executorSnapshot, `runner missing executorSnapshot: ${runner.runnerId}`);
    assert(runner.hostKindClassification !== "model_family", `hostKind treated as model family: ${runner.runnerId}`);
    assert(!sameText(runner.hostKind, runner.executorSnapshot), `hostKind reused as executorSnapshot: ${runner.runnerId}`);
    if (runner.reviewerSnapshot) {
      assert(!sameText(runner.hostKind, runner.reviewerSnapshot), `hostKind reused as reviewerSnapshot: ${runner.runnerId}`);
    }
    if (runner.reviewerFamily === "same" || runner.reviewerFamily === "cross") {
      assert(runner.reviewerSnapshot, `reviewerSnapshot required for ${runner.reviewerFamily} runner: ${runner.runnerId}`);
    }
    if (runner.reviewerFamily === "not_applicable") {
      assert(runner.reviewerSnapshot === null, `not_applicable runner must keep reviewerSnapshot null: ${runner.runnerId}`);
    }
    assert(runner.providerCallEnabled === false, `runner must keep provider calls disabled: ${runner.runnerId}`);
    assert(runner.eligibleForOutcomeRecords === false, `runner must not be eligible for outcome records: ${runner.runnerId}`);
  }
}

function validateSnapshotLock(snapshotLock) {
  assertBoundary(snapshotLock, "model snapshot lock");
  assert(snapshotLock.phase1FormalReadiness === false, "model snapshot lock must not claim formal Phase 1 readiness");
  assert(snapshotLock.providerExecutionLocked === false, "model snapshot lock must not claim provider execution locks");

  const families = new Map((snapshotLock.modelFamilies || []).map((family) => [family.familyId, family]));
  const e1 = families.get("E1");
  const e2 = families.get("E2");
  assert(e1, "model snapshot lock missing E1");
  assert(e2, "model snapshot lock missing E2");
  assert(includesText(e1.providerFamily, /Anthropic|Claude/i), "E1 must be Anthropic/Claude family");
  assert(includesText(e2.providerFamily, /OpenAI|GPT/i), "E2 must be OpenAI/GPT family");
  assert(e1.providerFamily !== e2.providerFamily, "E1 and E2 provider families must be distinct");
  for (const family of [e1, e2]) {
    assert(family.hostKindIsModelFamily === false, `${family.familyId} must not treat hostKind as model family`);
    assert(family.formalPhase1UseAllowed === false, `${family.familyId} must not be Phase 1 executable in M0`);
    assert(
      String(family.datedExecutionSnapshotLockState || "").includes("blocked"),
      `${family.familyId} dated snapshot lock state must be blocked in M0`,
    );
  }
  assert(
    snapshotLock.separationAssertion?.hostKindMayNotSubstituteForProviderFamily === true,
    "snapshot lock must state hostKind cannot substitute for provider family",
  );
}

function validateCellManifest(manifest, registry, { requireM0Semantics = false } = {}) {
  assertBoundary(manifest, manifest.artifact || "cell manifest");
  const runnersById = new Map((registry.runners || []).map((runner) => [runner.runnerId, runner]));
  const cellsByKey = new Map();

  for (const cell of manifest.cells || []) {
    assert(cell.cellKey, "cell missing cellKey");
    assert(!cellsByKey.has(cell.cellKey), `duplicate cellKey: ${cell.cellKey}`);
    cellsByKey.set(cell.cellKey, cell);
    assert(runnersById.has(cell.runnerId), `cell references missing runnerId: ${cell.cellKey}`);
    assert(!Object.prototype.hasOwnProperty.call(cell, "outcome"), `cell must not include outcome: ${cell.cellKey}`);

    if (cell.arm === "A2prime") {
      assert(cell.requiresBudgetLockDigest === true, `A2prime row must require budgetLockDigest: ${cell.cellKey}`);
      assert(cell.budgetLockDigest, `A2prime row missing budgetLockDigest: ${cell.cellKey}`);
      assert(cell.reviewerFamily === "not_applicable", `A2prime reviewerFamily must be not_applicable: ${cell.cellKey}`);
    }
  }

  if (requireM0Semantics) {
    const semantics = new Map((manifest.cellSemantics || []).map((entry) => [entry.cellNumber, entry]));
    for (const cellNumber of ["①", "②", "③", "④", "⑤", "⑥"]) {
      assert(semantics.has(cellNumber), `missing cell semantics for ${cellNumber}`);
    }

    const contrasts = new Map((manifest.confirmatoryContrasts || []).map((contrast) => [contrast.contrastId, contrast]));
    for (const contrastId of ["③-vs-⑥", "①-vs-②", "③-vs-④"]) {
      assert(contrasts.get(contrastId)?.legalConfirmatory === true, `${contrastId} must be legal confirmatory`);
    }
    assert(contrasts.get("②-vs-④")?.legalConfirmatory === false, "②-vs-④ must be rejected as confirmatory");

    const orderByCell = new Map((manifest.phase1ExecutionOrder || []).map((step) => [step.cellNumber, step.order]));
    assert(orderByCell.get("③") < orderByCell.get("budget-lock"), "③ must precede budget-lock");
    assert(orderByCell.get("budget-lock") < orderByCell.get("⑥"), "budget-lock must precede ⑥");
  }

  return { cellsByKey };
}

function validateBudgetLock(budgetLock, manifest, registry, { requireM0Ordering = false } = {}) {
  assertBoundary(budgetLock, budgetLock.artifact || "budget lock");
  assert(budgetLock.bindingPolicy?.providerDerivedValuesPresent === false, "budget lock must not contain provider-derived values");
  assert(budgetLock.bindingPolicy?.formalPhase1Readiness !== true, "budget lock must not claim Phase 1 readiness");

  const cellsByKey = new Map((manifest.cells || []).map((cell) => [cell.cellKey, cell]));
  const runnersById = new Map((registry.runners || []).map((runner) => [runner.runnerId, runner]));
  const a2PrimeClaimsByCellKey = new Map();

  function assertCellOrder(orderEntries, sourceCell, appliesToCell, lock, label) {
    if (!Array.isArray(orderEntries)) return;
    const orderByCell = new Map(orderEntries.map((step) => [step.cellNumber, step.order]));
    const sourceOrder = orderByCell.get(sourceCell.cellNumber);
    const lockOrder = orderByCell.get("budget-lock");
    const appliesToOrder = orderByCell.get(appliesToCell.cellNumber);
    if (sourceOrder === undefined || lockOrder === undefined || appliesToOrder === undefined) return;
    assert(sourceOrder < lockOrder, `${label} must order source cell before budget-lock: ${lock.lockKey}`);
    assert(lockOrder < appliesToOrder, `${label} must order budget-lock before applies-to cell: ${lock.lockKey}`);
  }

  if (requireM0Ordering) {
    const orderByCell = new Map((budgetLock.phase1ExecutionOrder || []).map((step) => [step.cellNumber, step.order]));
    assert(orderByCell.get("③") < orderByCell.get("budget-lock"), "budget lock order must put ③ before budget-lock");
    assert(orderByCell.get("budget-lock") < orderByCell.get("⑥"), "budget lock order must put budget-lock before ⑥");
  }

  for (const lock of budgetLock.locks || []) {
    assert(lock.budgetLockDigest?.startsWith("sha256:"), `budget lock missing sha256 digest: ${lock.lockKey}`);
    assert(lock.protocolLockDigest?.startsWith("sha256:"), `budget lock missing protocolLockDigest: ${lock.lockKey}`);
    assert(lock.executorSnapshotDigest?.startsWith("sha256:"), `budget lock missing executorSnapshotDigest: ${lock.lockKey}`);
    assert(lock.toolSurfaceDigest?.startsWith("sha256:"), `budget lock missing toolSurfaceDigest: ${lock.lockKey}`);
    assert(lock.promptDigest?.startsWith("sha256:"), `budget lock missing promptDigest: ${lock.lockKey}`);
    assert(lock.a2PrimeExecutionAllowed === false, `M0 budget lock must not allow A2prime execution: ${lock.lockKey}`);
    assert(lock.medianSpendFromA4Calibration === null, `M0 budget lock must not include calibration spend: ${lock.lockKey}`);
    assert(Array.isArray(lock.sourceCellKeys), `budget lock missing sourceCellKeys: ${lock.lockKey}`);
    assert(Array.isArray(lock.appliesToCellKeys), `budget lock missing appliesToCellKeys: ${lock.lockKey}`);
    assert(lock.sourceArm === "A4", `budget lock sourceArm must be A4: ${lock.lockKey}`);
    assert(lock.appliesToArm === "A2prime", `budget lock appliesToArm must be A2prime: ${lock.lockKey}`);
    assert(
      lock.appliesToReviewerFamily === "not_applicable",
      `budget lock appliesToReviewerFamily must be not_applicable: ${lock.lockKey}`,
    );

    const appliesToCells = [];
    for (const appliesToKey of lock.appliesToCellKeys) {
      const appliesToCell = cellsByKey.get(appliesToKey);
      assert(appliesToCell, `budget lock appliesToCellKeys references missing manifest row: ${lock.lockKey} -> ${appliesToKey}`);
      appliesToCells.push(appliesToCell);
      assert(
        appliesToCell.cellNumber === lock.appliesToCellNumber,
        `budget lock appliesToCellNumber does not match appliesToCellKeys row: ${lock.lockKey} -> ${appliesToKey}`,
      );
      assert(
        appliesToCell.arm === lock.appliesToArm,
        `budget lock appliesToArm does not match appliesToCellKeys row: ${lock.lockKey} -> ${appliesToKey}`,
      );
      assert(
        appliesToCell.reviewerFamily === lock.appliesToReviewerFamily,
        `budget lock appliesToReviewerFamily does not match appliesToCellKeys row: ${lock.lockKey} -> ${appliesToKey}`,
      );
      assert(
        appliesToCell.executorFamily === lock.executorFamily,
        `budget lock executorFamily does not match appliesToCellKeys row: ${lock.lockKey} -> ${appliesToKey}`,
      );
      assert(
        appliesToCell.task === lock.task,
        `budget lock task does not match appliesToCellKeys row: ${lock.lockKey} -> ${appliesToKey}`,
      );
      assert(
        appliesToCell.budgetLockDigest === lock.budgetLockDigest,
        `A2prime budgetLockDigest does not match budget lock: ${appliesToKey} -> ${lock.lockKey}`,
      );
      const claims = a2PrimeClaimsByCellKey.get(appliesToKey) || [];
      claims.push(lock.lockKey);
      a2PrimeClaimsByCellKey.set(appliesToKey, claims);
    }

    const sourceCells = [];
    for (const sourceKey of lock.sourceCellKeys) {
      const sourceCell = cellsByKey.get(sourceKey);
      assert(sourceCell, `budget lock sourceCellKeys references missing manifest row: ${lock.lockKey} -> ${sourceKey}`);
      sourceCells.push(sourceCell);
      assert(
        sourceCell.cellNumber === lock.sourceCellNumber,
        `budget lock sourceCellNumber does not match sourceCellKeys row: ${lock.lockKey} -> ${sourceKey}`,
      );
      assert(
        sourceCell.arm === lock.sourceArm,
        `budget lock sourceArm does not match sourceCellKeys row: ${lock.lockKey} -> ${sourceKey}`,
      );
      assert(
        sourceCell.reviewerFamily === lock.sourceReviewerFamily,
        `budget lock sourceReviewerFamily does not match sourceCellKeys row: ${lock.lockKey} -> ${sourceKey}`,
      );
      assert(
        sourceCell.executorFamily === lock.executorFamily,
        `budget lock executorFamily does not match sourceCellKeys row: ${lock.lockKey} -> ${sourceKey}`,
      );
      assert(
        sourceCell.task === lock.task,
        `budget lock task does not match sourceCellKeys row: ${lock.lockKey} -> ${sourceKey}`,
      );
      assert(
        sourceCell.isCalibrationSourceForBudgetLock === true,
        `budget lock sourceCellKeys row is not an A4 calibration source: ${lock.lockKey} -> ${sourceKey}`,
      );
      const sourceRunner = runnersById.get(sourceCell.runnerId);
      assert(sourceRunner, `budget lock source missing runner binding: ${sourceKey}`);
      assert(
        sourceRunner.executorSnapshot === lock.executorSnapshot,
        `budget lock executorSnapshot does not match source runner: ${lock.lockKey}`,
      );
      if (lock.sourceReviewerFamily === "same" || lock.sourceReviewerFamily === "cross") {
        assert(lock.reviewerSnapshotDigest?.startsWith("sha256:"), `budget lock missing reviewerSnapshotDigest: ${lock.lockKey}`);
        assert(
          sourceRunner.reviewerSnapshot === lock.reviewerSnapshot,
          `budget lock reviewerSnapshot does not match source runner: ${lock.lockKey}`,
        );
      }
    }

    for (const sourceCell of sourceCells) {
      for (const appliesToCell of appliesToCells) {
        assertCellOrder(manifest.phase1ExecutionOrder, sourceCell, appliesToCell, lock, "manifest phase1ExecutionOrder");
        assertCellOrder(budgetLock.phase1ExecutionOrder, sourceCell, appliesToCell, lock, "budget lock phase1ExecutionOrder");
      }
    }
  }

  for (const cell of manifest.cells || []) {
    if (cell.arm !== "A2prime") continue;
    const claims = a2PrimeClaimsByCellKey.get(cell.cellKey) || [];
    assert(claims.length > 0, `A2prime row missing from all budget lock appliesToCellKeys: ${cell.cellKey}`);
    assert(claims.length === 1, `A2prime row claimed by multiple budget locks: ${cell.cellKey}`);
  }
}

function validateStatusMarkdown(markdown) {
  for (const [key, value] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(markdown.includes(`${key}=${JSON.stringify(value)}`), `status markdown missing ${key}=${JSON.stringify(value)}`);
  }
  for (const milestone of ["M0.1", "M0.2", "M0.3", "M0.4", "M0.5", "M0.6", "M0.7"]) {
    assert(markdown.includes(`| ${milestone} `), `status markdown missing milestone ${milestone}`);
  }
  assert(markdown.includes("✓"), "status markdown must include checkmarks");
  assert(/blocker/i.test(markdown), "status markdown must include blocker labels");
  assert(
    /Phase 1 may start only after human approval and execution-locked dated snapshots\/budget/.test(markdown),
    "status markdown missing Phase 1 next-step gate",
  );
}

function expectReject(label, mutateAndValidate, pattern) {
  try {
    mutateAndValidate();
  } catch (error) {
    assert(pattern.test(error.message), `negative control ${label} rejected with wrong error: ${error.message}`);
    negativeControlRejectCount += 1;
    return;
  }
  fail(`negative control did not reject: ${label}`);
}

function runNegativeControls({ registry, manifest, budget }) {
  expectReject(
    "hostKind reused as executorSnapshot",
    () => {
      const badRegistry = deepClone(registry);
      badRegistry.runners[0].executorSnapshot = badRegistry.runners[0].hostKind;
      validateRunnerRegistry(badRegistry, { requireM0Hosts: true });
    },
    /hostKind reused as executorSnapshot/,
  );

  expectReject(
    "missing reviewerSnapshot for same reviewer",
    () => {
      const badRegistry = deepClone(registry);
      badRegistry.runners.find((runner) => runner.reviewerFamily === "same").reviewerSnapshot = null;
      validateRunnerRegistry(badRegistry, { requireM0Hosts: true });
    },
    /reviewerSnapshot required/,
  );

  expectReject(
    "missing reviewerSnapshot for cross reviewer",
    () => {
      const badRegistry = deepClone(registry);
      badRegistry.runners.find((runner) => runner.reviewerFamily === "cross").reviewerSnapshot = null;
      validateRunnerRegistry(badRegistry, { requireM0Hosts: true });
    },
    /reviewerSnapshot required/,
  );

  expectReject(
    "A2prime missing budgetLockDigest",
    () => {
      const badManifest = deepClone(manifest);
      const a2Prime = badManifest.cells.find((cell) => cell.arm === "A2prime");
      a2Prime.budgetLockDigest = null;
      validateCellManifest(badManifest, registry, { requireM0Semantics: true });
    },
    /A2prime row missing budgetLockDigest/,
  );

  expectReject(
    "budget lock not matching A2prime row",
    () => {
      const badBudget = deepClone(budget);
      badBudget.locks.find((lock) => lock.executorFamily === "E2").budgetLockDigest = "sha256:m0-intentional-mismatch";
      validateBudgetLock(badBudget, manifest, registry, { requireM0Ordering: true });
    },
    /A2prime budgetLockDigest does not match budget lock/,
  );

  expectReject(
    "E2 budget lock forged from ⑥/A2prime",
    () => {
      const badBudget = deepClone(budget);
      const lock = badBudget.locks.find((item) => item.executorFamily === "E2");
      lock.sourceCellNumber = lock.appliesToCellNumber;
      lock.sourceReviewerFamily = lock.appliesToReviewerFamily;
      lock.sourceCellKeys = [...lock.appliesToCellKeys];
      validateBudgetLock(badBudget, manifest, registry, { requireM0Ordering: true });
    },
    /sourceArm does not match sourceCellKeys row/,
  );

  expectReject(
    "budget lock sourceCellNumber/source key mismatch",
    () => {
      const badBudget = deepClone(budget);
      badBudget.locks.find((lock) => lock.executorFamily === "E2").sourceCellNumber = "②";
      validateBudgetLock(badBudget, manifest, registry, { requireM0Ordering: true });
    },
    /sourceCellNumber does not match sourceCellKeys row/,
  );

  expectReject(
    "budget lock sourceArm is not A4",
    () => {
      const badBudget = deepClone(budget);
      badBudget.locks.find((lock) => lock.executorFamily === "E2").sourceArm = "A3";
      validateBudgetLock(badBudget, manifest, registry, { requireM0Ordering: true });
    },
    /sourceArm must be A4/,
  );

  expectReject(
    "illegal ② vs ④ marked confirmatory",
    () => {
      const badManifest = deepClone(manifest);
      badManifest.confirmatoryContrasts.find((contrast) => contrast.contrastId === "②-vs-④").legalConfirmatory = true;
      validateCellManifest(badManifest, registry, { requireM0Semantics: true });
    },
    /②-vs-④ must be rejected as confirmatory/,
  );
}

function main() {
  const smoke = readJson(paths.smoke);
  const registry = readJson(paths.registry);
  const snapshots = readJson(paths.snapshots);
  const manifest = readJson(paths.manifest);
  const budget = readJson(paths.budget);
  const status = readText(paths.status);

  for (const [name, doc] of [
    ["m0 research smoke", smoke],
    ["m0 runner registry", registry],
    ["m0 model snapshot lock", snapshots],
    ["m0 cell manifest", manifest],
    ["m0 budget lock", budget],
  ]) {
    assertNoOutcomeFields(doc, name);
  }

  validateSmoke(smoke);
  validateRunnerRegistry(registry, { requireM0Hosts: true });
  validateSnapshotLock(snapshots);
  validateCellManifest(manifest, registry, { requireM0Semantics: true });
  validateBudgetLock(budget, manifest, registry, { requireM0Ordering: true });
  validateStatusMarkdown(status);
  runNegativeControls({ registry, manifest, budget });

  const exampleRegistry = readJson(paths.exampleRegistry);
  const exampleManifest = readJson(paths.exampleManifest);
  const exampleBudget = readJson(paths.exampleBudget);
  validateRunnerRegistry(exampleRegistry);
  validateCellManifest(exampleManifest, exampleRegistry);
  validateBudgetLock(exampleBudget, exampleManifest, exampleRegistry);

  console.log(`M0 smoke checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`);
  console.log("M0 smoke artifacts passed provider-safe local checks");
  console.log("Negative controls rejected as expected");
  console.log("Existing example artifacts passed local invariant checks");
}

try {
  main();
} catch (error) {
  failures.push(error);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.stack || failure.message);
  }
  process.exit(1);
}
