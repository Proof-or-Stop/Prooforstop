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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const paths = Object.freeze({
  protocolLock: "protocol.lock.json",
  seedManifest: "seed-manifest.m1.json",
  cellMatrix: "cell-matrix.m1.json",
  launchGate: "phase1-launch-gate.m1.json",
  status: "m1-status.md",
  protocolDoc: path.join("docs", "requirements", "decisions", "multi-model-ablation-replication.md"),
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

function protocolSha256() {
  const bytes = fs.readFileSync(path.join(repoRoot, paths.protocolDoc));
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

function byId(entries, idKey) {
  return new Map((entries || []).map((entry) => [entry[idKey], entry]));
}

function validateProtocolLock(lock, expectedSha) {
  assert(lock.artifact === "protocol.lock.m1", "protocol lock artifact mismatch");
  assert(lock.storyId === "B-806b", "protocol lock storyId must be B-806b");
  assert(lock.status === "m1_done_provider_free_launch_blocked", "protocol lock status must keep launch blocked");
  assert(lock.protocolPath === paths.protocolDoc, "protocol path mismatch");
  assert(lock.digestAlgorithm === "sha256", "protocol lock digestAlgorithm must be sha256");
  assert(lock.protocolSha256 === expectedSha, "protocol lock SHA-256 does not match protocol document");
  assert(lock.protocolDigest === `sha256:${expectedSha}`, "protocolDigest must bind the protocol SHA-256");
  assert(lock.freezeScope?.providerFreeProtocolFreeze === true, "protocol lock must be provider-free");
  assert(lock.freezeScope?.datedProviderSnapshotsLocked === false, "protocol lock must not claim dated snapshots");
  assert(lock.freezeScope?.formalPhase1ReadinessClaimed === false, "protocol lock must not claim formal Phase 1 readiness");
  assert(lock.freezeScope?.phase1LaunchAllowed === false, "protocol lock must not allow Phase 1 launch");
  assert(lock.freezeScope?.providerCallEnabled === false, "protocol lock must not enable provider calls");
}

function validateSeedManifest(seed, expectedDigest) {
  assert(seed.artifact === "seed-manifest.m1", "seed manifest artifact mismatch");
  assert(seed.storyId === "B-806b", "seed manifest storyId must be B-806b");
  assert(seed.providerFree === true, "seed manifest must be provider-free");
  assert(seed.outcomeFree === true, "seed manifest must be outcome-free");
  assert(seed.protocolDigest === expectedDigest, "seed manifest protocolDigest mismatch");

  const taskSlots = seed.planningDimensions?.taskSlots;
  const scenarioSlots = seed.planningDimensions?.scenarioSlots;
  const repeatSlots = seed.planningDimensions?.repeatSlots;
  assert(taskSlots?.count === 24, "seed manifest must define 24 task slots");
  assert(Array.isArray(taskSlots.slotIds) && taskSlots.slotIds.length === 24, "seed manifest task slot ids must total 24");
  assert(taskSlots.concreteInventoryLocked === false, "seed manifest must not claim concrete tasks are locked");
  assert(scenarioSlots?.count === 16, "seed manifest must define 16 scenario slots");
  assert(Array.isArray(scenarioSlots.slotIds) && scenarioSlots.slotIds.length === 16, "seed manifest scenario slot ids must total 16");
  assert(repeatSlots?.count === 3, "seed manifest must define 3 repeats");
  assert(Array.isArray(repeatSlots.slotIds) && repeatSlots.slotIds.length === 3, "seed manifest repeat slot ids must total 3");

  const policy = seed.seedDerivationPolicy || {};
  assert(policy.algorithm === "sha256", "seed derivation must use sha256");
  assert(policy.protocolDigest === expectedDigest, "seed derivation policy protocol digest mismatch");
  const expectedFields = ["protocolDigest", "cellNumber", "taskSlot", "scenarioSlot", "repeatSlot"];
  assert(JSON.stringify(policy.fieldsInOrder) === JSON.stringify(expectedFields), "seed derivation fields are not frozen");
  assert(
    policy.inputFormat === "${protocolDigest}|${cellNumber}|${taskSlot}|${scenarioSlot}|${repeatSlot}",
    "seed derivation input format must include protocol digest + cell/task/scenario/repeat",
  );
  assert(seed.taskCorpusInventory?.launchBlocker === true, "task corpus inventory must block launch while concrete tasks are absent");
  assert(seed.taskCorpusInventory?.concreteTasksLocked === false, "task corpus inventory must not be locked in M1");
}

function validateCellMatrix(matrix, expectedDigest) {
  assert(matrix.artifact === "cell-matrix.m1", "cell matrix artifact mismatch");
  assert(matrix.storyId === "B-806b", "cell matrix storyId must be B-806b");
  assert(matrix.providerFree === true, "cell matrix must be provider-free");
  assert(matrix.outcomeFree === true, "cell matrix must be outcome-free");
  assert(matrix.protocolDigest === expectedDigest, "cell matrix protocolDigest mismatch");

  const dimensions = matrix.dimensions || {};
  assert(dimensions.taskSlots === 24, "cell matrix must use 24 task slots");
  assert(dimensions.scenarioSlots === 16, "cell matrix must use 16 scenario slots");
  assert(dimensions.repeatSlots === 3, "cell matrix must use 3 repeat slots");
  const rowsPerCell = dimensions.taskSlots * dimensions.scenarioSlots * dimensions.repeatSlots;
  assert(rowsPerCell === 1152, "rows per Phase 1 cell must be 1,152");
  assert(dimensions.rowsPerPhase1Cell === rowsPerCell, "rowsPerPhase1Cell must derive from dimensions");

  const cells = matrix.phase1Cells || [];
  const cellsByNumber = byId(cells, "cellNumber");
  for (const requiredCell of ["③", "⑥", "②"]) {
    assert(cellsByNumber.get(requiredCell)?.phase1Status === "required", `${requiredCell} must be a required Phase 1 cell`);
  }
  assert(cellsByNumber.get("④")?.phase1Status === "optional_budget_permitting", "④ must be optional budget-permitting");
  const requiredCells = cells.filter((cell) => cell.phase1Status === "required");
  assert(requiredCells.length === 3, "required Phase 1 cell count must be 3");
  assert(!requiredCells.some((cell) => cell.cellNumber === "④"), "④ must not be required");

  const counts = matrix.plannedCounts || {};
  assert(counts.requiredCells === 3, "plannedCounts.requiredCells must be 3");
  assert(JSON.stringify(counts.requiredCellNumbers) === JSON.stringify(["③", "⑥", "②"]), "required cell number order must be frozen");
  assert(JSON.stringify(counts.optionalCellNumbers) === JSON.stringify(["④"]), "optional cell number set must be ④ only");
  assert(counts.requiredRows === requiredCells.length * rowsPerCell, "requiredRows must derive from required cells and dimensions");
  assert(counts.requiredRows === 3456, "required Phase 1 rows must be 3,456");
  assert(counts.optionalRowsAddedByCell4 === rowsPerCell, "optional ④ rows must add 1,152");
  assert(counts.requiredPlusOptionalRows === counts.requiredRows + counts.optionalRowsAddedByCell4, "required plus optional count must derive");
  assert(counts.requiredPlusOptionalRows === 4608, "required plus optional rows must be 4,608");

  const contrasts = byId(matrix.confirmatoryContrasts, "contrastId");
  assert(contrasts.get("③-vs-⑥")?.legalConfirmatory === true, "③-vs-⑥ must be legal confirmatory");
  assert(contrasts.get("①-vs-②")?.legalConfirmatory === true, "①-vs-② must be legal confirmatory with same-window anchor");
  assert(
    (contrasts.get("①-vs-②")?.conditions || []).some((condition) => /same-window ① anchor/.test(condition)),
    "①-vs-② must require same-window ① anchor",
  );
  assert(contrasts.get("③-vs-④")?.legalConfirmatory === true, "③-vs-④ must be legal confirmatory when ④ exists");
  assert(contrasts.get("②-vs-④")?.legalConfirmatory === false, "②-vs-④ must be illegal as confirmatory");

  const gate = matrix.a2PrimeCell6Gate || {};
  assert(gate.cellNumber === "⑥", "A2prime gate must apply to ⑥");
  assert(gate.arm === "A2prime", "A2prime gate arm must be A2prime");
  assert(gate.currentlyBlocked === true, "A2prime ⑥ must be blocked in M1");
  assert(gate.executionAllowedBeforeBudgetLock === false, "A2prime ⑥ must not be allowed before budget lock");
  assert(gate.matchingBudgetLockPresent === false, "M1 must not claim matching A2prime budget lock is present");
  assert(gate.budgetLockRequired === true, "A2prime ⑥ must require a budget lock");
  assert(gate.requiredSourceCalibration?.cellNumber === "③", "A2prime ⑥ source calibration must be ③");
  assert(gate.requiredSourceCalibration?.arm === "A4", "A2prime ⑥ source calibration must be A4");
  assert(gate.requiredSourceCalibration?.reviewerFamily === "same", "A2prime ⑥ source calibration must be same-family");
  assert(gate.requiredSourceCalibration?.sameFamilyCalibrationRequired === true, "A2prime ⑥ must require same-family calibration");
}

function validateLaunchGate(gate, expectedDigest) {
  assert(gate.artifact === "phase1-launch-gate.m1", "launch gate artifact mismatch");
  assert(gate.storyId === "B-806b", "launch gate storyId must be B-806b");
  assert(gate.protocolDigest === expectedDigest, "launch gate protocolDigest mismatch");
  assert(gate.launchAllowed === false, "launchAllowed must be false");
  assert(gate.providerCallEnabled === false, "providerCallEnabled must be false");
  assert(gate.formalPhase1UseAllowed === false, "formalPhase1UseAllowed must be false");
  assert(gate.authorizationBoundary?.m1DoneAuthorizesProviderExecution === false, "M1 must not authorize provider execution");
  assert(gate.authorizationBoundary?.m1DoneAuthorizesPhase1Campaign === false, "M1 must not authorize Phase 1 campaign");
  assert(gate.authorizationBoundary?.m1DoneAuthorizesFormalPhase1Use === false, "M1 must not authorize formal Phase 1 use");

  const blockers = byId(gate.blockers, "blockerId");
  for (const blockerId of [
    "human-approval-absent",
    "dated-snapshots-absent",
    "concrete-task-inventory-absent",
    "a4-budget-lock-absent",
    "a2prime-sequencing-not-satisfied",
  ]) {
    assert(blockers.get(blockerId)?.blocksLaunch === true, `launch gate missing blocker ${blockerId}`);
  }
  assert(gate.nextAllowedState?.m2MayStart === false, "M2 must remain blocked by M1 launch gate");
}

function validateStatus(statusText) {
  assert(/M1 protocol digest lock \| DONE/.test(statusText), "status must mark protocol lock DONE");
  assert(/M1 seed planning manifest \| DONE/.test(statusText), "status must mark seed manifest DONE");
  assert(/M1 Phase 1 cell matrix \| DONE/.test(statusText), "status must mark cell matrix DONE");
  assert(/M1 launch gate \| DONE/.test(statusText), "status must mark launch gate DONE");
  assert(/M2 provider execution \| BLOCKED/.test(statusText), "status must mark M2 provider execution BLOCKED");
  assert(/Provider execution \| OFF/.test(statusText), "status must mark provider execution OFF");
  assert(/Outcome data \| ABSENT/.test(statusText), "status must mark outcome data ABSENT");
}

function loadArtifacts() {
  return {
    protocolLock: readJson(paths.protocolLock),
    seedManifest: readJson(paths.seedManifest),
    cellMatrix: readJson(paths.cellMatrix),
    launchGate: readJson(paths.launchGate),
    status: readText(paths.status),
  };
}

function validateAll(artifacts, expectedSha = protocolSha256()) {
  const expectedDigest = `sha256:${expectedSha}`;
  for (const [name, doc] of Object.entries({
    protocolLock: artifacts.protocolLock,
    seedManifest: artifacts.seedManifest,
    cellMatrix: artifacts.cellMatrix,
    launchGate: artifacts.launchGate,
  })) {
    assertBoundary(doc, name);
    assertNoOutcomeFields(doc, name);
  }
  validateProtocolLock(artifacts.protocolLock, expectedSha);
  validateSeedManifest(artifacts.seedManifest, expectedDigest);
  validateCellMatrix(artifacts.cellMatrix, expectedDigest);
  validateLaunchGate(artifacts.launchGate, expectedDigest);
  validateStatus(artifacts.status);
}

function expectReject(label, mutate) {
  const artifacts = deepClone(baseArtifacts);
  mutate(artifacts);
  const countBefore = assertionCount;
  try {
    validateAll(artifacts, baseProtocolSha);
  } catch {
    assertionCount = countBefore;
    negativeControlRejectCount += 1;
    return;
  }
  assertionCount = countBefore;
  fail(`negative control was not rejected: ${label}`);
}

const baseProtocolSha = protocolSha256();
const baseArtifacts = loadArtifacts();

validateAll(baseArtifacts, baseProtocolSha);

expectReject("drifted protocol digest", (artifacts) => {
  artifacts.protocolLock.protocolSha256 = "0".repeat(64);
  artifacts.protocolLock.protocolDigest = `sha256:${"0".repeat(64)}`;
});

expectReject("launchAllowed=true", (artifacts) => {
  artifacts.launchGate.launchAllowed = true;
});

expectReject("providerCallEnabled=true", (artifacts) => {
  artifacts.launchGate.providerCallEnabled = true;
});

expectReject("forbidden outcome field", (artifacts) => {
  artifacts.seedManifest.outcome = "amplified";
});

expectReject("missing required ②", (artifacts) => {
  artifacts.cellMatrix.phase1Cells = artifacts.cellMatrix.phase1Cells.filter((cell) => cell.cellNumber !== "②");
});

expectReject("A2prime allowed before budget", (artifacts) => {
  artifacts.cellMatrix.a2PrimeCell6Gate.currentlyBlocked = false;
  artifacts.cellMatrix.a2PrimeCell6Gate.executionAllowedBeforeBudgetLock = true;
});

expectReject("②-vs-④ legalConfirmatory=true", (artifacts) => {
  const contrast = artifacts.cellMatrix.confirmatoryContrasts.find((entry) => entry.contrastId === "②-vs-④");
  contrast.legalConfirmatory = true;
});

console.log(
  `M1 freeze checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`,
);
