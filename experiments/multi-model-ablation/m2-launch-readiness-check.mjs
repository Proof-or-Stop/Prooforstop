#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER_RESEARCH_BOUNDARY = Object.freeze({
  providerCallsMade: false,
  containsOutcomeData: false,
  phase1OrPhase2CellsRun: false,
  productGateImpact: "none",
});

const REQUIRED_PHASE1_CELL_NUMBERS = Object.freeze(["③", "⑥", "②"]);
const OPTIONAL_CELL_4 = "④";
const M1_SEED_MANIFEST_ARTIFACT = "seed-manifest.m1.json";
const M1_CELL_MATRIX_ARTIFACT = "cell-matrix.m1.json";
const M1_TASK_SLOT_MAPPING_POLICY = "ordinal_identity_sorted_task_ids";
const EXPECTED_SEED_FIELDS_IN_ORDER = Object.freeze([
  "protocolDigest",
  "cellNumber",
  "taskSlot",
  "scenarioSlot",
  "repeatSlot",
]);
const EXPECTED_SEED_INPUT_FORMAT = "${protocolDigest}|${cellNumber}|${taskSlot}|${scenarioSlot}|${repeatSlot}";
const TASK_DIGEST_PREFIX = "m2-task-inventory-v1\n";
const CORPUS_DIGEST_PREFIX = "m2-task-corpus-v1\n";
const FORBIDDEN_RECORDS_FILE = "records-multi-model-ablation.jsonl";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const paths = Object.freeze({
  launch: "m2-launch-readiness.json",
  snapshots: "model-snapshot-lock.m2.json",
  inventory: "task-inventory.m2.json",
  runnerManifest: "phase1-runner-manifest.m2.json",
  seedManifest: M1_SEED_MANIFEST_ARTIFACT,
  cellMatrix: M1_CELL_MATRIX_ARTIFACT,
  launchReadiness: "phase1-launch-readiness.m2.json",
  status: "m2-status.md",
});

let assertionCount = 0;
let negativeControlRejectCount = 0;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  assertionCount += 1;
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertBoundary(doc, name) {
  const boundary = doc.researchBoundary;
  assert(boundary && typeof boundary === "object", `${name} missing researchBoundary`);
  for (const [key, expected] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(
      boundary[key] === expected,
      `${name} researchBoundary.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(boundary[key])}`,
    );
  }
}

function assertNoOutcomeOrRecordsPath(value, location = "document") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOutcomeOrRecordsPath(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "outcome") fail(`${location} contains forbidden outcome field`);
    if (["recordsPath", "recordsOutputPath", "recordPath"].includes(key)) {
      fail(`${location} contains forbidden records path field ${key}`);
    }
    if (typeof child === "string" && child.includes(FORBIDDEN_RECORDS_FILE)) {
      fail(`${location}.${key} contains forbidden records path`);
    }
    assertNoOutcomeOrRecordsPath(child, `${location}.${key}`);
  }
}

function assertNoRecordsFileExists() {
  assert(
    fs.existsSync(path.join(__dirname, FORBIDDEN_RECORDS_FILE)) === false,
    `${FORBIDDEN_RECORDS_FILE} must not exist`,
  );
}

function isHostLabel(value) {
  if (typeof value !== "string") return false;
  return /\b(Codex|Claude Code|Antigravity|agy|CLI|host|adapter|App)\b/i.test(value);
}

function byId(entries, key) {
  return new Map((entries || []).map((entry) => [entry[key], entry]));
}

function assertJsonEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function sortedDirectoryNames(relativeRoot) {
  return fs
    .readdirSync(path.join(repoRoot, relativeRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sortedFileNames(relativeDir) {
  return fs
    .readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function computeTaskDigest(relativeDir, files) {
  const hash = crypto.createHash("sha256");
  hash.update(TASK_DIGEST_PREFIX);
  for (const fileName of files) {
    const bytes = fs.readFileSync(path.join(repoRoot, relativeDir, fileName));
    hash.update(`${fileName}\0${bytes.length}\0${sha256(bytes)}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function computeCorpusDigest(tasks) {
  const hash = crypto.createHash("sha256");
  hash.update(CORPUS_DIGEST_PREFIX);
  for (const task of tasks) {
    hash.update(`${task.taskId}\0${task.contentDigest}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function validateLaunch(launch) {
  assert(launch.artifact === "m2-launch-readiness", "launch artifact mismatch");
  assert(launch.storyId === "B-fe25", "launch storyId must be B-fe25");
  assert(launch.preparedOn === "2026-07-05", "launch readiness must record 2026-07-05 boundary");
  assertBoundary(launch, "m2 launch readiness");
  const boundary = launch.authorizationBoundary || {};
  assert(boundary.readinessApprovalRecorded === true, "readiness approval must be recorded");
  assert(boundary.providerExecutionAuthorized === false, "provider execution must not be authorized");
  assert(boundary.phase1CampaignAuthorized === false, "Phase 1 campaign must not be authorized");
  assert(boundary.phase2CampaignAuthorized === false, "Phase 2 campaign must not be authorized");
  assert(boundary.formalPhase1UseAllowed === false, "formal Phase 1 use must remain disabled");
  assert(boundary.providerCallEnabled === false, "provider calls must remain disabled");
  assert(launch.claimBoundary?.hM1Proven === false, "launch must not claim H-M1 is proven");
  assert(launch.claimBoundary?.hM3Proven === false, "launch must not claim H-M3 is proven");
  assert(
    launch.claimBoundary?.modelAgnosticPaperClaimUnlocked === false,
    "launch must not unlock model-agnostic paper claim",
  );
}

function validateSnapshots(snapshotLock) {
  assert(snapshotLock.artifact === "model-snapshot-lock.m2", "snapshot lock artifact mismatch");
  assertBoundary(snapshotLock, "m2 model snapshot lock");
  assert(
    snapshotLock.snapshotReadinessBoundary?.datedReadinessDeclarationsPresent === true,
    "snapshot readiness declarations must be present",
  );
  assert(
    snapshotLock.snapshotReadinessBoundary?.providerExecutionLocked === false,
    "snapshot lock must not claim provider execution lock",
  );
  assert(
    snapshotLock.snapshotReadinessBoundary?.providerRunMetadataPresent === false,
    "snapshot lock must not claim provider run metadata",
  );

  const families = byId(snapshotLock.modelFamilies, "familyId");
  const e1 = families.get("E1");
  const e2 = families.get("E2");
  assert(e1, "snapshot lock missing E1");
  assert(e2, "snapshot lock missing E2");
  assert(/Anthropic|Claude/i.test(e1.providerFamily), "E1 provider family must be Anthropic/Claude");
  assert(/OpenAI|GPT/i.test(e2.providerFamily), "E2 provider family must be OpenAI/GPT");
  assert(e1.providerFamily !== e2.providerFamily, "E1 and E2 provider families must be distinct");
  for (const family of [e1, e2]) {
    assert(!isHostLabel(family.providerFamily), `${family.familyId} providerFamily must not be a host label`);
    assert(family.hostKindIsModelFamily === false, `${family.familyId} must not treat hostKind as model family`);
    assert(family.providerCallsEnabled === false, `${family.familyId} must keep provider calls disabled`);
    assert(family.formalPhase1UseAllowed === false, `${family.familyId} must not allow formal Phase 1 use`);
    assert(
      family.datedReadinessSnapshot?.snapshotDate === "2026-07-05",
      `${family.familyId} readiness snapshot date must be 2026-07-05`,
    );
    assert(
      family.datedReadinessSnapshot?.declarationOnly === true,
      `${family.familyId} readiness snapshot must be declaration-only`,
    );
    assert(
      family.datedReadinessSnapshot?.providerRunMetadataAbsent === true,
      `${family.familyId} provider run metadata must be absent`,
    );
  }
  assert(
    snapshotLock.separationAssertion?.hostKindMayNotSubstituteForProviderFamily === true,
    "snapshot lock must reject hostKind as provider family",
  );
}

function validateM1LineageBinding(binding, seedManifest, cellMatrix, expectedProtocolDigest, name) {
  assert(binding && typeof binding === "object", `${name} missing M1 lineage binding`);
  assert(binding.seedManifestArtifact === M1_SEED_MANIFEST_ARTIFACT, `${name} must bind seed-manifest.m1.json`);
  assert(binding.seedManifestId === seedManifest.artifact, `${name} seed manifest id mismatch`);
  assert(binding.cellMatrixArtifact === M1_CELL_MATRIX_ARTIFACT, `${name} must bind cell-matrix.m1.json`);
  assert(binding.cellMatrixId === cellMatrix.artifact, `${name} cell matrix id mismatch`);
  assert(binding.protocolDigest === expectedProtocolDigest, `${name} M1 binding protocolDigest mismatch`);
  assert(seedManifest.protocolDigest === expectedProtocolDigest, `${name} M1 seed protocolDigest mismatch`);
  assert(cellMatrix.protocolDigest === expectedProtocolDigest, `${name} M1 cell matrix protocolDigest mismatch`);

  const seedPolicy = seedManifest.seedDerivationPolicy || {};
  const boundSeedPolicy = binding.seedDerivationPolicy || {};
  assert(seedPolicy.algorithm === "sha256", `${name} M1 seed algorithm must be sha256`);
  assert(boundSeedPolicy.algorithm === seedPolicy.algorithm, `${name} seed algorithm binding mismatch`);
  assert(seedPolicy.protocolDigest === expectedProtocolDigest, `${name} M1 seed policy protocolDigest mismatch`);
  assertJsonEqual(
    seedPolicy.fieldsInOrder,
    EXPECTED_SEED_FIELDS_IN_ORDER,
    `${name} M1 seed derivation fields are not frozen`,
  );
  assertJsonEqual(
    boundSeedPolicy.fieldsInOrder,
    seedPolicy.fieldsInOrder,
    `${name} seed derivation field binding mismatch`,
  );
  assert(seedPolicy.inputFormat === EXPECTED_SEED_INPUT_FORMAT, `${name} M1 seed input format drift`);
  assert(boundSeedPolicy.inputFormat === seedPolicy.inputFormat, `${name} seed input format binding mismatch`);
}

function validateM1TaskSlotBinding(inventory, seedManifest) {
  const taskPolicy = inventory.bindingPolicy?.m1TaskSlotMappingPolicy || {};
  assert(taskPolicy.policy === M1_TASK_SLOT_MAPPING_POLICY, "task inventory M1 task-slot mapping policy mismatch");
  assert(taskPolicy.sourceOrdinalField === "tasks[].ordinal", "task inventory M1 mapping ordinal source mismatch");
  assert(
    taskPolicy.targetSlotSource === "seed-manifest.m1.json planningDimensions.taskSlots.slotIds[ordinal - 1]",
    "task inventory M1 mapping target source mismatch",
  );
  assert(taskPolicy.taskSlotField === "tasks[].m1TaskSlot", "task inventory M1 mapping task slot field mismatch");
  assert(taskPolicy.slotIdFormat === "task-slot-%02d", "task inventory M1 task slot format mismatch");

  const taskSlots = seedManifest.planningDimensions?.taskSlots?.slotIds || [];
  assert(taskSlots.length === 24, "M1 seed manifest must expose 24 task slots for M2 binding");
  const seenTaskSlots = new Set();
  for (const [index, task] of (inventory.tasks || []).entries()) {
    const expectedTaskSlot = taskSlots[index];
    assert(task.m1TaskSlot === expectedTaskSlot, `task ${task.taskId} must bind M1 ${expectedTaskSlot}`);
    assert(!seenTaskSlots.has(task.m1TaskSlot), `duplicate M1 task slot binding: ${task.m1TaskSlot}`);
    seenTaskSlots.add(task.m1TaskSlot);
  }
  assert(seenTaskSlots.size === taskSlots.length, "task inventory must bind every M1 task slot exactly once");
}

function validateM1DimensionBinding(manifest, inventory, seedManifest, cellMatrix) {
  const seedDimensions = seedManifest.planningDimensions || {};
  const taskSlots = seedDimensions.taskSlots || {};
  const scenarioSlots = seedDimensions.scenarioSlots || {};
  const repeatSlots = seedDimensions.repeatSlots || {};
  const matrixDimensions = cellMatrix.dimensions || {};
  assert(taskSlots.count === 24, "M1 seed task slot count must be 24");
  assert(scenarioSlots.count === 16, "M1 seed scenario slot count must be 16");
  assert(repeatSlots.count === 3, "M1 seed repeat slot count must be 3");
  assert(matrixDimensions.taskSlots === taskSlots.count, "M1 matrix task slot count must match M1 seed");
  assert(matrixDimensions.scenarioSlots === scenarioSlots.count, "M1 matrix scenario slot count must match M1 seed");
  assert(matrixDimensions.repeatSlots === repeatSlots.count, "M1 matrix repeat slot count must match M1 seed");
  assert(manifest.dimensions?.taskDirectories === taskSlots.count, "M2 runner task count must match M1 task slots");
  assert(inventory.tasks?.length === taskSlots.count, "M2 inventory task count must match M1 task slots");
  assert(manifest.dimensions?.scenarioSlots === scenarioSlots.count, "M2 runner scenario slots must match M1 seed");
  assert(manifest.dimensions?.repeatSlots === repeatSlots.count, "M2 runner repeat slots must match M1 seed");
  assert(
    manifest.dimensions?.rowsPerPhase1Cell === matrixDimensions.rowsPerPhase1Cell,
    "M2 runner rows per Phase 1 cell must match M1 matrix",
  );
}

function validateM1CellSemantics(manifest, cellMatrix) {
  const m1CellsByNumber = byId(cellMatrix.phase1Cells, "cellNumber");
  const m2CellsByNumber = byId(manifest.phase1Cells, "cellNumber");
  const optionalCell4Present = m2CellsByNumber.has(OPTIONAL_CELL_4);
  for (const cellNumber of [...REQUIRED_PHASE1_CELL_NUMBERS, OPTIONAL_CELL_4]) {
    const m2Cell = m2CellsByNumber.get(cellNumber);
    if (!m2Cell && cellNumber === OPTIONAL_CELL_4) continue;
    const m1Cell = m1CellsByNumber.get(cellNumber);
    assert(m1Cell, `M1 cell matrix missing cell ${cellNumber}`);
    assert(m2Cell, `M2 runner manifest missing cell ${cellNumber}`);
    const binding = m2Cell.m1CellMatrixBinding || {};
    assert(binding.artifact === M1_CELL_MATRIX_ARTIFACT, `${cellNumber} must bind M1 cell matrix artifact`);
    assert(binding.cellNumber === m1Cell.cellNumber, `${cellNumber} M1 cell binding number mismatch`);
    for (const field of ["phase1Status", "arm", "executorFamily", "reviewerFamily"]) {
      assert(m2Cell[field] === m1Cell[field], `${cellNumber} M2 ${field} must match M1 cell matrix`);
      assert(binding[field] === m1Cell[field], `${cellNumber} M1 binding ${field} mismatch`);
    }
    assert(m1Cell.providerExecutionAllowedInM1 === false, `${cellNumber} M1 provider execution must remain disabled`);
    assert(binding.providerExecutionAllowedInM1 === false, `${cellNumber} M1 binding must keep provider execution disabled`);
    assert(m2Cell.rows === cellMatrix.dimensions?.rowsPerPhase1Cell, `${cellNumber} rows must match M1 rows per cell`);
  }

  assertJsonEqual(
    manifest.plannedCounts?.requiredCellNumbers,
    cellMatrix.plannedCounts?.requiredCellNumbers,
    "M2 required cell numbers must match M1 planned counts",
  );
  const expectedOptionalCellNumbers = optionalCell4Present ? cellMatrix.plannedCounts?.optionalCellNumbers || [] : [];
  const expectedOptionalRows = optionalCell4Present ? cellMatrix.plannedCounts?.optionalRowsAddedByCell4 : 0;
  const expectedRequiredPlusOptionalRows = (cellMatrix.plannedCounts?.requiredRows || 0) + expectedOptionalRows;
  assertJsonEqual(
    manifest.plannedCounts?.optionalCellNumbers || [],
    expectedOptionalCellNumbers,
    "M2 optional cell numbers must match M1 planned counts",
  );
  assert(manifest.plannedCounts?.requiredCells === cellMatrix.plannedCounts?.requiredCells, "M2 required cell count must match M1");
  assert(manifest.plannedCounts?.requiredRows === cellMatrix.plannedCounts?.requiredRows, "M2 required rows must match M1");
  assert(
    manifest.plannedCounts?.optionalRowsAddedByCell4 === expectedOptionalRows,
    "M2 optional ④ rows must match M1",
  );
  assert(
    manifest.plannedCounts?.requiredPlusOptionalRows === expectedRequiredPlusOptionalRows,
    "M2 required plus optional rows must match M1",
  );

  const matrixBinding = manifest.m1LineageBinding?.cellMatrixBinding || {};
  assertJsonEqual(
    matrixBinding.requiredCellNumbers,
    cellMatrix.plannedCounts?.requiredCellNumbers,
    "M2 M1 binding required cell numbers mismatch",
  );
  assertJsonEqual(
    matrixBinding.optionalCellNumbers,
    expectedOptionalCellNumbers,
    "M2 M1 binding optional cell numbers mismatch",
  );
  assert(
    matrixBinding.cellKeyFormat === cellMatrix.enumerationPolicy?.cellKeyFormat,
    "M2 M1 binding cell key format mismatch",
  );
}

function validateA2PrimeGateBinding(manifest, cellMatrix) {
  const gate = cellMatrix.a2PrimeCell6Gate || {};
  const binding = manifest.a2PrimeGateBinding || {};
  assert(binding.source === "cell-matrix.m1.json a2PrimeCell6Gate", "M2 A2prime gate source mismatch");
  for (const field of [
    "cellNumber",
    "arm",
    "currentlyBlocked",
    "executionAllowedBeforeBudgetLock",
    "matchingBudgetLockPresent",
    "budgetLockRequired",
  ]) {
    assert(binding[field] === gate[field], `M2 A2prime gate ${field} must match M1`);
  }
  for (const field of ["cellNumber", "arm", "executorFamily", "reviewerFamily", "sameFamilyCalibrationRequired"]) {
    assert(
      binding.requiredSourceCalibration?.[field] === gate.requiredSourceCalibration?.[field],
      `M2 A2prime source calibration ${field} must match M1`,
    );
  }
  for (const field of ["cellNumber", "arm", "executorFamily", "reviewerFamily"]) {
    assert(binding.appliesTo?.[field] === gate.appliesTo?.[field], `M2 A2prime applies-to ${field} must match M1`);
  }
}

function validateTaskInventory(inventory, seedManifest, cellMatrix) {
  assert(inventory.artifact === "task-inventory.m2", "task inventory artifact mismatch");
  assertBoundary(inventory, "m2 task inventory");
  assert(inventory.sourceRoot === "experiments/recovery-runner/tasks", "task source root mismatch");
  assert(inventory.bindingPolicy?.readOnlyBinding === true, "task inventory must be read-only binding");
  assert(inventory.bindingPolicy?.taskDefinitionsModifiedByM2 === false, "task inventory must not modify task definitions");
  assert(inventory.bindingPolicy?.taskDirectoriesExpected === 24, "task inventory expected count must be 24");
  assert(inventory.bindingPolicy?.taskDirectoriesBound === 24, "task inventory bound count must be 24");
  validateM1LineageBinding(inventory.m1LineageBinding, seedManifest, cellMatrix, inventory.protocolDigest, "task inventory");

  const tasks = inventory.tasks || [];
  assert(tasks.length === 24, "task inventory must bind exactly 24 tasks");
  const actualTaskIds = sortedDirectoryNames(inventory.sourceRoot);
  const inventoryTaskIds = tasks.map((task) => task.taskId);
  assert(JSON.stringify(inventoryTaskIds) === JSON.stringify([...inventoryTaskIds].sort()), "tasks must be sorted by taskId");
  assert(new Set(inventoryTaskIds).size === 24, "task inventory must not contain duplicate task ids");
  assert(JSON.stringify(inventoryTaskIds) === JSON.stringify(actualTaskIds), "task inventory must match actual task directories");

  tasks.forEach((task, index) => {
    assert(task.ordinal === index + 1, `task ordinal mismatch for ${task.taskId}`);
    assert(task.path === `${inventory.sourceRoot}/${task.taskId}`, `task path mismatch for ${task.taskId}`);
    assert(task.readOnly === true, `task must be read-only bound: ${task.taskId}`);
    const actualFiles = sortedFileNames(task.path);
    assert(JSON.stringify(task.files) === JSON.stringify(actualFiles), `task file list mismatch for ${task.taskId}`);
    assert(task.fileCount === actualFiles.length, `task fileCount mismatch for ${task.taskId}`);
    assert(task.contentDigest === computeTaskDigest(task.path, task.files), `task content digest mismatch for ${task.taskId}`);
  });

  validateM1TaskSlotBinding(inventory, seedManifest);
  assert(inventory.corpusDigest === computeCorpusDigest(tasks), "task corpus digest mismatch");
}

function validateRunnerManifest(manifest, inventory, seedManifest, cellMatrix) {
  assert(manifest.artifact === "phase1-runner-manifest.m2", "runner manifest artifact mismatch");
  assertBoundary(manifest, "m2 phase1 runner manifest");
  assert(manifest.taskInventoryArtifact === "task-inventory.m2.json", "runner manifest must bind task inventory artifact");
  assert(manifest.taskInventoryDigest === inventory.corpusDigest, "runner manifest task inventory digest mismatch");
  assert(manifest.protocolDigest === inventory.protocolDigest, "runner manifest protocolDigest must match task inventory");
  validateM1LineageBinding(manifest.m1LineageBinding, seedManifest, cellMatrix, manifest.protocolDigest, "runner manifest");
  validateM1DimensionBinding(manifest, inventory, seedManifest, cellMatrix);
  assert(manifest.dimensions?.taskDirectories === 24, "runner manifest task count must be 24");
  assert(manifest.dimensions?.scenarioSlots === 16, "runner manifest scenario slots must be 16");
  assert(manifest.dimensions?.repeatSlots === 3, "runner manifest repeat slots must be 3");
  assert(manifest.dimensions?.rowsPerPhase1Cell === 1152, "runner manifest rows per cell must be 1,152");

  const runners = byId(manifest.runners, "runnerId");
  const cells = manifest.phase1Cells || [];
  const cellsByNumber = byId(cells, "cellNumber");
  for (const requiredCell of REQUIRED_PHASE1_CELL_NUMBERS) {
    const cell = cellsByNumber.get(requiredCell);
    assert(cell, `runner manifest missing required cell ${requiredCell}`);
    assert(cell.phase1Status === "required", `${requiredCell} must be required`);
    assert(cell.requiredForLaunchReadiness === true, `${requiredCell} must be required for launch readiness`);
    assert(cell.providerExecutionAllowedInM2 === false, `${requiredCell} must keep provider execution disabled`);
    assert(runners.has(cell.runnerId), `${requiredCell} references missing runner ${cell.runnerId}`);
  }
  const requiredCells = cells.filter((cell) => cell.phase1Status === "required");
  assert(requiredCells.length === 3, "runner manifest must require exactly three Phase 1 cells");
  assert(!requiredCells.some((cell) => cell.cellNumber === OPTIONAL_CELL_4), "optional ④ must not be required");
  const optionalCell4 = cellsByNumber.get(OPTIONAL_CELL_4);
  if (optionalCell4) {
    assert(optionalCell4.phase1Status === "optional_budget_permitting", "④ must be optional budget-permitting");
    assert(optionalCell4.requiredForLaunchReadiness === false, "④ must not be required for M2 launch readiness");
  }

  const expectedOptionalCells = optionalCell4 ? [OPTIONAL_CELL_4] : [];
  const expectedOptionalRows = optionalCell4 ? 1152 : 0;
  const counts = manifest.plannedCounts || {};
  assert(counts.requiredCells === 3, "planned required cell count must be 3");
  assert(
    JSON.stringify(counts.requiredCellNumbers) === JSON.stringify(REQUIRED_PHASE1_CELL_NUMBERS),
    "required cell number order must be ③/⑥/②",
  );
  assert(
    JSON.stringify(counts.optionalCellNumbers) === JSON.stringify(expectedOptionalCells),
    "optional cell numbers must match optional ④ presence",
  );
  assert(counts.requiredRows === 3456, "required rows must be 3,456");
  assert(counts.optionalRowsAddedByCell4 === expectedOptionalRows, "optional ④ rows mismatch");
  assert(counts.requiredPlusOptionalRows === 3456 + expectedOptionalRows, "required plus optional rows mismatch");

  for (const runner of manifest.runners || []) {
    assert(runner.providerCallEnabled === false, `runner must keep provider calls disabled: ${runner.runnerId}`);
    assert(runner.eligibleForResultRows === false, `runner must not be result-eligible: ${runner.runnerId}`);
    assert(["E1", "E2"].includes(runner.providerModelFamily), `runner providerModelFamily invalid: ${runner.runnerId}`);
    assert(!isHostLabel(runner.providerModelFamily), `runner provider model family must not be a host label: ${runner.runnerId}`);
  }

  const ownershipKeys = new Set();
  const ownedCells = new Set();
  for (const ownership of manifest.cellOwnership || []) {
    assert(!ownershipKeys.has(ownership.ownershipKey), `duplicate ownership key: ${ownership.ownershipKey}`);
    ownershipKeys.add(ownership.ownershipKey);
    assert(ownership.duplicateOwnershipAllowed === false, `duplicate ownership must be disabled: ${ownership.ownershipKey}`);
    assert(runners.has(ownership.runnerId), `ownership references missing runner: ${ownership.ownershipKey}`);
    assert(cellsByNumber.has(ownership.cellNumber), `ownership references missing cell: ${ownership.ownershipKey}`);
    assert(!ownedCells.has(ownership.cellNumber), `duplicate runner ownership for cell ${ownership.cellNumber}`);
    ownedCells.add(ownership.cellNumber);
  }

  const contrasts = byId(manifest.confirmatoryContrasts, "contrastId");
  assert(contrasts.get("③-vs-⑥")?.legalConfirmatory === true, "③-vs-⑥ must be legal confirmatory");
  assert(contrasts.get("①-vs-②")?.legalConfirmatory === true, "①-vs-② must be legal with same-window condition");
  assert(
    (contrasts.get("①-vs-②")?.conditions || []).some((condition) => /same-window ① anchor/.test(condition)),
    "①-vs-② must require same-window ① anchor",
  );
  if (optionalCell4) {
    assert(contrasts.get("③-vs-④")?.legalConfirmatory === true, "③-vs-④ must be legal when optional ④ exists");
  }
  if (contrasts.has("②-vs-④")) {
    assert(contrasts.get("②-vs-④")?.legalConfirmatory === false, "②-vs-④ must be rejected as confirmatory");
  }

  validateM1CellSemantics(manifest, cellMatrix);
  validateA2PrimeGateBinding(manifest, cellMatrix);
}

function validateLaunchReadiness(readiness) {
  assert(readiness.artifact === "phase1-launch-readiness.m2", "launch readiness artifact mismatch");
  assertBoundary(readiness, "m2 phase1 launch readiness");
  assert(readiness.staticReadiness?.prepared === true, "static readiness must be prepared");
  assert(readiness.staticReadiness?.providerExecutionAllowed === false, "provider execution must not be allowed");
  assert(readiness.staticReadiness?.formalPhase1MayRun === false, "formal Phase 1 must not be runnable");
  assert(readiness.staticReadiness?.phase1CellsExecuted === false, "Phase 1 cells must not have executed");
  assert(readiness.staticReadiness?.phase2CellsExecuted === false, "Phase 2 cells must not have executed");

  const checks = byId(readiness.readinessChecks, "checkId");
  const calibration = checks.get("③-a4-calibration");
  assert(calibration?.cellNumber === "③", "A4 calibration must be cell ③");
  assert(calibration?.arm === "A4", "③ calibration arm must be A4");
  assert(calibration?.status === "pending_execution", "③ A4 calibration must remain pending execution");
  assert(calibration?.executionEvidencePresent === false, "③ A4 calibration must not have execution evidence");
  assert(calibration?.blocksA2prime === true, "③ A4 calibration must block A2prime until complete");

  const budgetLock = checks.get("real-budget-lock");
  assert(budgetLock?.status === "pending_execution", "real budget lock must remain pending execution");
  assert(budgetLock?.realBudgetLockPresent === false, "real budget lock must be absent");
  assert(
    budgetLock?.m0ExampleBudgetLockAcceptedAsFormalEvidence === false,
    "M0 example budget lock must not be accepted as formal evidence",
  );
  assert(budgetLock?.sourceCellNumber === "③", "real budget lock source must be ③");
  assert(budgetLock?.appliesToCellNumber === "⑥", "real budget lock applies-to cell must be ⑥");

  const a2prime = checks.get("⑥-a2prime-sequencing");
  assert(a2prime?.cellNumber === "⑥", "A2prime sequencing must apply to ⑥");
  assert(a2prime?.arm === "A2prime", "⑥ sequencing arm must be A2prime");
  assert(a2prime?.status === "blocked_until_real_budget_lock", "⑥ A2prime must remain blocked until real budget lock");
  assert(a2prime?.executionAllowed === false, "⑥ A2prime execution must not be allowed");
  assert(a2prime?.sequencingSatisfied === false, "⑥ A2prime sequencing must not be satisfied");
  assert(a2prime?.matchingRealBudgetLockPresent === false, "⑥ A2prime must not claim matching budget lock");

  assert(readiness.claimBoundary?.hM1Proven === false, "launch readiness must not claim H-M1 is proven");
  assert(readiness.claimBoundary?.hM3Proven === false, "launch readiness must not claim H-M3 is proven");
  assert(
    readiness.claimBoundary?.phase1DirectionalReadoutPresent === false,
    "launch readiness must not claim Phase 1 directional readout",
  );
  assert(
    readiness.claimBoundary?.modelAgnosticPaperClaimUnlocked === false,
    "launch readiness must not unlock model-agnostic claim",
  );
}

function validateStatus(statusText) {
  for (const [key, value] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(statusText.includes(`${key}=${JSON.stringify(value)}`), `status missing ${key}=${JSON.stringify(value)}`);
  }
  for (const requiredLine of [
    "| M0 research smoke | COMPLETE |",
    "| M1 protocol freeze | COMPLETE |",
    "| M2 launch readiness | PREPARED |",
    "| Formal M2 execution | NOT STARTED |",
    "| ③ A4 calibration | PENDING EXECUTION |",
    "| ⑥ A2prime | BLOCKED |",
    "| M3 Phase 2 decision | PENDING |",
    "| M4 powered matrix | PENDING |",
    "| M5 analysis and recompute | PENDING |",
    "| M6 wording guard | PENDING |"
  ]) {
    assert(statusText.includes(requiredLine), `status missing row: ${requiredLine}`);
  }
  const forbiddenClaims = [
    /Phase 1 has run/i,
    /Phase 1 ran/i,
    /Phase 1 results are present/i,
    /Phase 1 outcome data exists/i,
    /H-M1\s*\|\s*PROVEN/i,
    /H-M3\s*\|\s*PROVEN/i,
    /model-agnostic results are proven/i,
  ];
  for (const pattern of forbiddenClaims) {
    assert(!pattern.test(statusText), `status contains forbidden claim matching ${pattern}`);
  }
  assert(/H-M1\/H-M3 claims are not proven/i.test(statusText), "status must state H-M1/H-M3 are not proven");
  assert(/no model-agnostic paper claim is unlocked/i.test(statusText), "status must keep model-agnostic claim locked");
}

function loadArtifacts() {
  return {
    launch: readJson(paths.launch),
    snapshots: readJson(paths.snapshots),
    inventory: readJson(paths.inventory),
    runnerManifest: readJson(paths.runnerManifest),
    seedManifest: readJson(paths.seedManifest),
    cellMatrix: readJson(paths.cellMatrix),
    launchReadiness: readJson(paths.launchReadiness),
    status: readText(paths.status),
  };
}

function validateAll(artifacts) {
  for (const [name, doc] of Object.entries({
    launch: artifacts.launch,
    snapshots: artifacts.snapshots,
    inventory: artifacts.inventory,
    runnerManifest: artifacts.runnerManifest,
    seedManifest: artifacts.seedManifest,
    cellMatrix: artifacts.cellMatrix,
    launchReadiness: artifacts.launchReadiness,
  })) {
    assertBoundary(doc, name);
    assertNoOutcomeOrRecordsPath(doc, name);
  }
  assertNoRecordsFileExists();
  validateLaunch(artifacts.launch);
  validateSnapshots(artifacts.snapshots);
  validateTaskInventory(artifacts.inventory, artifacts.seedManifest, artifacts.cellMatrix);
  validateRunnerManifest(artifacts.runnerManifest, artifacts.inventory, artifacts.seedManifest, artifacts.cellMatrix);
  validateLaunchReadiness(artifacts.launchReadiness);
  validateStatus(artifacts.status);
}

function removeOptionalCell4(artifacts) {
  artifacts.runnerManifest.phase1Cells = artifacts.runnerManifest.phase1Cells.filter(
    (cell) => cell.cellNumber !== OPTIONAL_CELL_4,
  );
  artifacts.runnerManifest.runners = artifacts.runnerManifest.runners.filter(
    (runner) => runner.runnerId !== "m2-future-cell-04-e2-a4-cross",
  );
  artifacts.runnerManifest.cellOwnership = artifacts.runnerManifest.cellOwnership.filter(
    (ownership) => ownership.cellNumber !== OPTIONAL_CELL_4,
  );
  artifacts.runnerManifest.confirmatoryContrasts = artifacts.runnerManifest.confirmatoryContrasts.filter(
    (contrast) => !["③-vs-④", "②-vs-④"].includes(contrast.contrastId),
  );
  artifacts.runnerManifest.plannedCounts.optionalCellNumbers = [];
  artifacts.runnerManifest.plannedCounts.optionalRowsAddedByCell4 = 0;
  artifacts.runnerManifest.plannedCounts.requiredPlusOptionalRows = 3456;
  artifacts.runnerManifest.m1LineageBinding.cellMatrixBinding.optionalCellNumbers = [];
}

function expectReject(label, mutate, pattern) {
  const artifacts = deepClone(baseArtifacts);
  mutate(artifacts);
  const countBefore = assertionCount;
  try {
    validateAll(artifacts);
  } catch (error) {
    assertionCount = countBefore;
    if (pattern) {
      assert(pattern.test(error.message), `negative control ${label} rejected with wrong error: ${error.message}`);
    }
    negativeControlRejectCount += 1;
    return;
  }
  assertionCount = countBefore;
  fail(`negative control was not rejected: ${label}`);
}

function expectPass(label, mutate) {
  const artifacts = deepClone(baseArtifacts);
  mutate(artifacts);
  try {
    validateAll(artifacts);
  } catch (error) {
    fail(`positive control was rejected: ${label}: ${error.message}`);
  }
}

const baseArtifacts = loadArtifacts();

validateAll(baseArtifacts);

expectPass("required-only Phase 1 readiness without optional ④", (artifacts) => {
  removeOptionalCell4(artifacts);
});

expectReject(
  "providerCallsMade=true",
  (artifacts) => {
    artifacts.launch.researchBoundary.providerCallsMade = true;
  },
  /providerCallsMade/,
);

expectReject(
  "E2 provider family is host label",
  (artifacts) => {
    artifacts.snapshots.modelFamilies.find((family) => family.familyId === "E2").providerFamily = "Codex CLI";
  },
  /E2 provider family/,
);

expectReject(
  "E1 and E2 provider families not distinct",
  (artifacts) => {
    artifacts.snapshots.modelFamilies.find((family) => family.familyId === "E2").providerFamily = "Anthropic Claude";
  },
  /OpenAI\/GPT|distinct/,
);

expectReject(
  "missing task directory binding",
  (artifacts) => {
    artifacts.inventory.tasks = artifacts.inventory.tasks.slice(1);
  },
  /exactly 24/,
);

expectReject(
  "duplicate task id",
  (artifacts) => {
    artifacts.inventory.tasks[1] = deepClone(artifacts.inventory.tasks[0]);
    artifacts.inventory.tasks[1].ordinal = 2;
  },
  /duplicate task ids|actual task directories/,
);

expectReject(
  "task digest drift",
  (artifacts) => {
    artifacts.inventory.tasks[0].contentDigest = "sha256:" + "0".repeat(64);
  },
  /task content digest mismatch/,
);

expectReject(
  "missing runner M1 lineage binding",
  (artifacts) => {
    delete artifacts.runnerManifest.m1LineageBinding;
  },
  /missing M1 lineage binding/,
);

expectReject(
  "M1 seed input format drift",
  (artifacts) => {
    artifacts.seedManifest.seedDerivationPolicy.inputFormat = "${cellNumber}|${taskSlot}|${scenarioSlot}|${repeatSlot}";
  },
  /M1 seed input format drift/,
);

expectReject(
  "runner seed input binding drift",
  (artifacts) => {
    artifacts.runnerManifest.m1LineageBinding.seedDerivationPolicy.inputFormat =
      "${protocolDigest}:${cellNumber}:${taskSlot}:${scenarioSlot}:${repeatSlot}";
  },
  /seed input format binding mismatch/,
);

expectReject(
  "wrong M1 task-slot mapping",
  (artifacts) => {
    artifacts.inventory.tasks[0].m1TaskSlot = "task-slot-02";
  },
  /task bf-datediff must bind M1 task-slot-01|duplicate M1 task slot/,
);

expectReject(
  "missing required ②",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells = artifacts.runnerManifest.phase1Cells.filter(
      (cell) => cell.cellNumber !== "②",
    );
  },
  /missing required cell ②/,
);

expectReject(
  "M2 cell reviewer family drift from M1",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells.find((cell) => cell.cellNumber === "③").reviewerFamily = "cross";
  },
  /③ M2 reviewerFamily must match M1 cell matrix/,
);

expectReject(
  "A2prime gate applies-to drift from M1",
  (artifacts) => {
    artifacts.runnerManifest.a2PrimeGateBinding.appliesTo.reviewerFamily = "same";
  },
  /M2 A2prime applies-to reviewerFamily must match M1/,
);

expectReject(
  "optional ④ marked required",
  (artifacts) => {
    const cell4 = artifacts.runnerManifest.phase1Cells.find((cell) => cell.cellNumber === OPTIONAL_CELL_4);
    cell4.phase1Status = "required";
    cell4.requiredForLaunchReadiness = true;
  },
  /exactly three Phase 1 cells|optional ④ must not be required/,
);

expectReject(
  "illegal ②-vs-④ confirmatory",
  (artifacts) => {
    artifacts.runnerManifest.confirmatoryContrasts.find(
      (contrast) => contrast.contrastId === "②-vs-④",
    ).legalConfirmatory = true;
  },
  /②-vs-④ must be rejected/,
);

expectReject(
  "③ calibration marked complete",
  (artifacts) => {
    artifacts.launchReadiness.readinessChecks.find((check) => check.checkId === "③-a4-calibration").status = "complete";
  },
  /pending execution/,
);

expectReject(
  "⑥ A2prime allowed before real budget lock",
  (artifacts) => {
    const a2prime = artifacts.launchReadiness.readinessChecks.find((check) => check.checkId === "⑥-a2prime-sequencing");
    a2prime.status = "ready";
    a2prime.executionAllowed = true;
    a2prime.sequencingSatisfied = true;
  },
  /blocked until real budget lock|must not be allowed|must not be satisfied/,
);

expectReject(
  "forbidden outcome field",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells[0].outcome = "amplified";
  },
  /forbidden outcome field/,
);

expectReject(
  "forbidden records path field",
  (artifacts) => {
    artifacts.launchReadiness.recordsPath = FORBIDDEN_RECORDS_FILE;
  },
  /records path/,
);

expectReject(
  "status claims Phase 1 has run",
  (artifacts) => {
    artifacts.status += "\nPhase 1 has run.\n";
  },
  /forbidden claim/,
);

expectReject(
  "status claims model-agnostic results proven",
  (artifacts) => {
    artifacts.status += "\nmodel-agnostic results are proven.\n";
  },
  /forbidden claim/,
);

console.log(
  `M2 launch readiness checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`,
);
console.log("M2 provider-free launch readiness artifacts passed local checks");
console.log("Negative controls rejected as expected");
