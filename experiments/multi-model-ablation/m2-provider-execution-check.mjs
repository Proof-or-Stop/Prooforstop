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

const REQUIRED_AUTHORIZATION_FIELDS = Object.freeze([
  "humanApproval",
  "datedExecutorSnapshot",
  "datedReviewerSnapshot",
  "promptDigest",
  "toolSurfaceDigest",
  "runnerOwnership",
  "budgetCap",
  "duplicatePolicy",
]);

const HOST_LABELS = Object.freeze([
  "Codex CLI",
  "Codex App",
  "Claude Code CLI",
  "Antigravity CLI",
  "agy",
]);

const FORBIDDEN_RECORDS_FILE = "records-multi-model-ablation.jsonl";
const FORBIDDEN_OUTCOME_DATA_KEYS = Object.freeze([
  "resultrows",
  "outcomerecords",
  "phase1results",
  "phase2results",
]);
const OUTCOME_DATA_PRESENT_FLAGS = Object.freeze([
  "resultrowspresent",
  "outcomerecordspresent",
  "containsoutcomedata",
]);
const FORBIDDEN_RECORD_PATH_KEYS = Object.freeze([
  "recordpath",
  "recordspath",
  "recordsoutputpath",
  "resultrowspath",
  "outcomerecordspath",
  "phase1resultspath",
  "phase2resultspath",
]);
const PROVIDER_LAUNCH_RUNNER_BINDINGS = Object.freeze([
  Object.freeze({
    runnerId: "m2-future-cell-03-e2-a4-same",
    cellNumber: "03",
    protocolCellNumber: "③",
    arm: "A4",
    providerModelFamily: "E2",
    reviewerFamily: "same",
    reviewerSnapshotFamily: "E2",
    phase1Status: "required",
    requiredForLaunchReadiness: true,
    optional: false,
  }),
  Object.freeze({
    runnerId: "m2-future-cell-06-e2-a2prime",
    cellNumber: "06",
    protocolCellNumber: "⑥",
    arm: "A2prime",
    providerModelFamily: "E2",
    reviewerFamily: "not_applicable",
    reviewerSnapshotFamily: "not_applicable",
    phase1Status: "required",
    requiredForLaunchReadiness: true,
    optional: false,
  }),
  Object.freeze({
    runnerId: "m2-future-cell-02-e1-a4-cross",
    cellNumber: "02",
    protocolCellNumber: "②",
    arm: "A4",
    providerModelFamily: "E1",
    reviewerFamily: "cross",
    reviewerSnapshotFamily: "E2",
    phase1Status: "required",
    requiredForLaunchReadiness: true,
    optional: false,
  }),
  Object.freeze({
    runnerId: "m2-future-cell-04-e2-a4-cross",
    cellNumber: "04",
    protocolCellNumber: "④",
    arm: "A4",
    providerModelFamily: "E2",
    reviewerFamily: "cross",
    reviewerSnapshotFamily: "E1",
    phase1Status: "optional_budget_permitting",
    requiredForLaunchReadiness: false,
    optional: true,
  }),
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const paths = Object.freeze({
  m2LaunchReadiness: "m2-launch-readiness.json",
  snapshots: "model-snapshot-lock.m2.json",
  inventory: "task-inventory.m2.json",
  runnerManifest: "phase1-runner-manifest.m2.json",
  phase1Readiness: "phase1-launch-readiness.m2.json",
  providerLaunch: "m2-provider-execution-launch.json",
  providerAuthorization: "m2-provider-execution-authorization.json",
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

function byId(entries, key) {
  return new Map((entries || []).map((entry) => [entry[key], entry]));
}

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isHostLabel(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return HOST_LABELS.some((label) => label.toLowerCase() === normalized) || /\b(cli|host|adapter)\b/i.test(value);
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
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === "outcome" || normalizedKey === "outcomes") {
      fail(`${location} contains forbidden outcome field ${key}`);
    }
    if (FORBIDDEN_OUTCOME_DATA_KEYS.includes(normalizedKey)) {
      fail(`${location} contains forbidden result/outcome data field ${key}`);
    }
    if (OUTCOME_DATA_PRESENT_FLAGS.includes(normalizedKey) && child === true) {
      fail(`${location}.${key} asserts result/outcome data present`);
    }
    if (FORBIDDEN_RECORD_PATH_KEYS.includes(normalizedKey)) {
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

function assertMissingAuthorizationField(field) {
  assert(field && typeof field === "object", "authorization field entry missing");
  assert(field.status === "missing", `${field.fieldId} must remain missing in disabled launch state`);
  assert(field.value === null, `${field.fieldId} value must remain null in disabled launch state`);
  assert(field.blocksProviderExecution === true, `${field.fieldId} must block provider execution`);
}

function assertSnapshotValueIsNotHostLabel(value, label) {
  if (value === null || value === undefined) return;
  assert(typeof value === "string", `${label} must be a string when present`);
  assert(!isHostLabel(value), `${label} must not be a host label`);
}

function mapByRequiredId(entries, key, label) {
  assert(Array.isArray(entries), `${label} must be an array`);
  const mapped = new Map();
  entries.forEach((entry, index) => {
    assert(entry && typeof entry === "object", `${label}[${index}] missing entry`);
    const id = entry[key];
    assert(typeof id === "string" && id.length > 0, `${label}[${index}] missing ${key}`);
    assert(!mapped.has(id), `${label} duplicate ${key}: ${id}`);
    mapped.set(id, entry);
  });
  return mapped;
}

function assertOptionalFieldMatches(entry, field, expected, label) {
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return;
  assert(entry[field] === expected, `${label} ${field} mismatch`);
}

function assertManifestCellMatchesBinding(cell, binding, label) {
  assert(cell.cellNumber === binding.protocolCellNumber, `${label} manifest cellNumber mismatch`);
  assert(cell.arm === binding.arm, `${label} manifest arm mismatch`);
  assert(cell.executorFamily === binding.providerModelFamily, `${label} manifest executorFamily mismatch`);
  assert(cell.reviewerFamily === binding.reviewerFamily, `${label} manifest reviewerFamily mismatch`);
  assert(cell.phase1Status === binding.phase1Status, `${label} manifest phase1Status mismatch`);
  assert(
    cell.requiredForLaunchReadiness === binding.requiredForLaunchReadiness,
    `${label} manifest requiredForLaunchReadiness mismatch`,
  );
  assert(cell.providerExecutionAllowedInM2 === false, `${label} manifest provider execution must stay disabled`);
  assert(
    cell.cellKeyFamily ===
      `${binding.protocolCellNumber}|${binding.arm}|{taskId}|{scenarioSlot}|{repeatSlot}|${binding.providerModelFamily}|${binding.reviewerFamily}`,
    `${label} manifest cellKeyFamily mismatch`,
  );

  const m1Binding = cell.m1CellMatrixBinding || {};
  assert(m1Binding.cellNumber === binding.protocolCellNumber, `${label} M1 cell binding number mismatch`);
  assert(m1Binding.arm === binding.arm, `${label} M1 cell binding arm mismatch`);
  assert(m1Binding.executorFamily === binding.providerModelFamily, `${label} M1 cell binding executorFamily mismatch`);
  assert(m1Binding.reviewerFamily === binding.reviewerFamily, `${label} M1 cell binding reviewerFamily mismatch`);
  assert(m1Binding.providerExecutionAllowedInM1 === false, `${label} M1 cell binding provider execution must stay disabled`);
}

function validateProviderLaunchRunnerBindings(launch, runnerManifest) {
  const expectedByRunnerId = new Map(PROVIDER_LAUNCH_RUNNER_BINDINGS.map((binding) => [binding.runnerId, binding]));
  const expectedByProtocolCellNumber = new Map(
    PROVIDER_LAUNCH_RUNNER_BINDINGS.map((binding) => [binding.protocolCellNumber, binding]),
  );
  const launchRunnerById = mapByRequiredId(
    launch.runnerAuthorization?.runners,
    "runnerId",
    "provider launch runnerAuthorization.runners",
  );
  const manifestRunnerById = mapByRequiredId(runnerManifest.runners, "runnerId", "phase1 runner manifest runners");
  const manifestCellByRunnerId = mapByRequiredId(
    runnerManifest.phase1Cells,
    "runnerId",
    "phase1 runner manifest phase1Cells",
  );
  const ownershipByRunnerId = mapByRequiredId(
    runnerManifest.cellOwnership,
    "runnerId",
    "phase1 runner manifest cellOwnership",
  );

  for (const binding of PROVIDER_LAUNCH_RUNNER_BINDINGS) {
    assert(launchRunnerById.has(binding.runnerId), `provider launch missing runner ${binding.runnerId}`);
    assert(manifestRunnerById.has(binding.runnerId), `phase1 manifest missing runner ${binding.runnerId}`);
    assert(manifestCellByRunnerId.has(binding.runnerId), `phase1 manifest missing cell for runner ${binding.runnerId}`);
    assert(ownershipByRunnerId.has(binding.runnerId), `phase1 manifest missing ownership for runner ${binding.runnerId}`);
  }
  for (const runnerId of launchRunnerById.keys()) {
    assert(expectedByRunnerId.has(runnerId), `provider launch has extra runner ${runnerId}`);
  }
  for (const runnerId of manifestRunnerById.keys()) {
    assert(expectedByRunnerId.has(runnerId), `phase1 manifest has extra runner ${runnerId}`);
  }
  for (const runnerId of manifestCellByRunnerId.keys()) {
    assert(expectedByRunnerId.has(runnerId), `phase1 manifest has extra cell runner ${runnerId}`);
  }
  assert(
    launchRunnerById.size === expectedByRunnerId.size,
    "provider launch runner count must match phase1 manifest bindings",
  );
  assert(manifestRunnerById.size === expectedByRunnerId.size, "phase1 manifest runner count must match launch bindings");
  assert(manifestCellByRunnerId.size === expectedByRunnerId.size, "phase1 manifest cell count must match launch bindings");

  for (const binding of PROVIDER_LAUNCH_RUNNER_BINDINGS) {
    const label = `cell ${binding.cellNumber} runner ${binding.runnerId}`;
    const launchRunner = launchRunnerById.get(binding.runnerId);
    const manifestRunner = manifestRunnerById.get(binding.runnerId);
    const manifestCell = manifestCellByRunnerId.get(binding.runnerId);
    const ownership = ownershipByRunnerId.get(binding.runnerId);

    assert(launchRunner.cellNumber === binding.cellNumber, `${label} launch cellNumber mismatch`);
    assert(launchRunner.protocolCellNumber === binding.protocolCellNumber, `${label} launch protocolCellNumber mismatch`);
    assert(launchRunner.providerCallEnabled === false, `${label} launch provider calls must stay disabled`);
    assert(launchRunner.eligibleForResultRows === false, `${label} launch result rows must stay disabled`);
    if (binding.optional) {
      assert(launchRunner.optional === true, `${label} launch optional flag mismatch`);
    } else {
      assert(launchRunner.optional !== true, `${label} launch optional flag mismatch`);
    }
    assertOptionalFieldMatches(launchRunner, "arm", binding.arm, label);
    assertOptionalFieldMatches(launchRunner, "providerModelFamily", binding.providerModelFamily, label);
    assertOptionalFieldMatches(launchRunner, "executorFamily", binding.providerModelFamily, label);
    assertOptionalFieldMatches(launchRunner, "reviewerFamily", binding.reviewerFamily, label);

    assertManifestCellMatchesBinding(manifestCell, binding, label);
    assert(manifestRunner.providerModelFamily === binding.providerModelFamily, `${label} providerModelFamily mismatch`);
    assert(manifestRunner.executorSnapshotFamily === binding.providerModelFamily, `${label} executorSnapshotFamily mismatch`);
    assert(
      manifestRunner.reviewerSnapshotFamily === binding.reviewerSnapshotFamily,
      `${label} reviewerSnapshotFamily mismatch`,
    );
    assert(manifestRunner.providerCallEnabled === false, `${label} manifest provider calls must stay disabled`);
    assert(manifestRunner.eligibleForResultRows === false, `${label} manifest result rows must stay disabled`);

    assert(ownership.cellNumber === binding.protocolCellNumber, `${label} ownership cellNumber mismatch`);
    assert(
      ownership.ownershipKey ===
        `${binding.protocolCellNumber}|${binding.arm}|${binding.providerModelFamily}|${binding.reviewerFamily}`,
      `${label} ownershipKey mismatch`,
    );
    assert(ownership.duplicateOwnershipAllowed === false, `${label} duplicate ownership must stay disabled`);
  }

  const cell03 = expectedByProtocolCellNumber.get("③");
  const launchCell03 = launch.sequencing?.cell03Calibration || {};
  assert(launchCell03.cellNumber === cell03.cellNumber, "cell 03 sequencing cellNumber mismatch");
  assert(launchCell03.protocolCellNumber === cell03.protocolCellNumber, "cell 03 sequencing protocolCellNumber mismatch");
  assert(launchCell03.arm === cell03.arm, "cell 03 sequencing arm mismatch");
  assert(launchCell03.executorFamily === cell03.providerModelFamily, "cell 03 sequencing executorFamily mismatch");
  assert(launchCell03.reviewerFamily === cell03.reviewerFamily, "cell 03 sequencing reviewerFamily mismatch");

  const cell06 = expectedByProtocolCellNumber.get("⑥");
  const launchCell06 = launch.sequencing?.cell06A2primeGate || {};
  assert(launchCell06.cellNumber === cell06.cellNumber, "cell 06 sequencing cellNumber mismatch");
  assert(launchCell06.protocolCellNumber === cell06.protocolCellNumber, "cell 06 sequencing protocolCellNumber mismatch");
  assert(launchCell06.arm === cell06.arm, "cell 06 sequencing arm mismatch");
  assert(launchCell06.executorFamily === cell06.providerModelFamily, "cell 06 sequencing executorFamily mismatch");
  assert(launchCell06.reviewerFamily === cell06.reviewerFamily, "cell 06 sequencing reviewerFamily mismatch");
}

function validateProviderLaunch(launch) {
  assert(launch.artifact === "m2-provider-execution-launch", "provider launch artifact mismatch");
  assert(launch.storyId === "B-785e", "provider launch storyId must be B-785e");
  assertBoundary(launch, "m2 provider execution launch");

  assert(launch.launchState?.mode === "planning_only", "provider launch must remain planning-only");
  assert(launch.launchState?.defaultProviderExecutionState === "disabled", "provider execution must be disabled by default");
  assert(launch.providerExecutionAuthorized !== true, "top-level provider execution must not be accidentally authorized");
  assert(launch.launchState?.providerExecutionAuthorized === false, "providerExecutionAuthorized must be false");
  assert(launch.authorization?.providerExecutionAuthorized === false, "authorization providerExecutionAuthorized must be false");
  assert(launch.launchState?.providerCallEnabled === false, "provider calls must remain disabled");
  assert(launch.launchState?.formalPhase1UseAllowed === false, "formal Phase 1 use must remain disabled");
  assert(launch.launchState?.phase1CampaignAuthorized === false, "Phase 1 campaign must not be authorized");
  assert(launch.launchState?.phase2CampaignAuthorized === false, "Phase 2 campaign must not be authorized");
  assert(launch.launchState?.outcomeRecordsPresent === false, "outcome records must remain absent");
  assert(launch.launchState?.resultRowsPresent === false, "result rows must remain absent");
  assert(launch.launchState?.productGateImpact === "none", "provider launch must have no product gate impact");
  assert(launch.authorization?.providerFallbackAllowed === false, "provider fallback must be rejected");

  const required = byId(launch.authorization?.required, "fieldId");
  for (const fieldId of REQUIRED_AUTHORIZATION_FIELDS) {
    assert(required.has(fieldId), `provider launch missing authorization field ${fieldId}`);
    assertMissingAuthorizationField(required.get(fieldId));
  }
  assert(launch.authorization?.allRequiredMetadataPresent === false, "required authorization metadata must be incomplete");

  const allRequiredPresent = REQUIRED_AUTHORIZATION_FIELDS.every(
    (fieldId) => required.get(fieldId)?.status === "present" && required.get(fieldId)?.value,
  );
  const providerExecutionRequested =
    launch.launchState?.providerExecutionAuthorized === true ||
    launch.authorization?.providerExecutionAuthorized === true ||
    launch.launchState?.providerCallEnabled === true ||
    (launch.runnerAuthorization?.runners || []).some((runner) => runner.providerCallEnabled === true);
  assert(!providerExecutionRequested || allRequiredPresent, "provider execution cannot be authorized without required metadata");

  assert(launch.sequencing?.nextPermittedFormalStep === "cell-03-calibration", "cell 03 must be the next permitted formal step");
  assert(launch.sequencing?.nextPermittedFormalStepMode === "planning_only", "cell 03 must remain planning-only");
  assert(launch.sequencing?.cell03Calibration?.providerExecutionAllowed === false, "cell 03 provider execution must be disabled");
  assert(launch.sequencing?.cell03Calibration?.executionEvidencePresent === false, "cell 03 must have no execution evidence");
  assert(launch.sequencing?.realCell03DerivedBudgetLock?.present === false, "real cell-03-derived budget lock must be absent");
  assert(
    launch.sequencing?.realCell03DerivedBudgetLock?.m0ExampleBudgetLockAcceptedAsFormalEvidence === false,
    "M0 example budget lock must not count as formal evidence",
  );
  assert(launch.sequencing?.cell06A2primeGate?.state === "cell-06-a2prime-blocked", "cell 06 blocked state mismatch");
  assert(launch.sequencing?.cell06A2primeGate?.blocked === true, "cell 06 must be blocked");
  assert(launch.sequencing?.cell06A2primeGate?.executionAllowed === false, "cell 06 execution must be disabled");
  assert(
    launch.sequencing?.cell06A2primeGate?.matchingRealBudgetLockPresent === false,
    "cell 06 must not claim a matching real budget lock",
  );

  assert(launch.runnerAuthorization?.providerCallEnabledRunnerCount === 0, "no provider-call enabled runners are allowed");
  assert(launch.runnerAuthorization?.resultRowsEnabledRunnerCount === 0, "no result-row enabled runners are allowed");
  for (const runner of launch.runnerAuthorization?.runners || []) {
    assert(runner.providerCallEnabled === false, `runner provider calls must be disabled: ${runner.runnerId}`);
    assert(runner.eligibleForResultRows === false, `runner result rows must be disabled: ${runner.runnerId}`);
    assertSnapshotValueIsNotHostLabel(runner.executorSnapshot, `${runner.runnerId}.executorSnapshot`);
    assertSnapshotValueIsNotHostLabel(runner.reviewerSnapshot, `${runner.runnerId}.reviewerSnapshot`);
  }

  assert(launch.hostModelSeparation?.hostLabelOnlySnapshotsAccepted === false, "host-label-only snapshots must be rejected");
  assert(launch.hostModelSeparation?.providerFallbackAllowed === false, "host/model separation must reject provider fallback");
  for (const label of HOST_LABELS) {
    assert(
      launch.hostModelSeparation?.hostLabelsRejectedAsSnapshots?.includes(label),
      `host label must be explicitly rejected as snapshot: ${label}`,
    );
  }

  assert(launch.claimBoundary?.hM1Proven === false, "provider launch must not prove H-M1");
  assert(launch.claimBoundary?.hM3Proven === false, "provider launch must not prove H-M3");
  assert(
    launch.claimBoundary?.phase1DirectionalReadoutPresent === false,
    "provider launch must not claim a Phase 1 directional readout",
  );
  assert(
    launch.claimBoundary?.modelAgnosticPaperClaimUnlocked === false,
    "provider launch must not unlock model-agnostic wording",
  );
  assert(launch.claimBoundary?.productGateImpact === "none", "provider launch must not affect product gates");
}

function validateProviderAuthorization(authorization, launch) {
  assert(
    authorization.artifact === "m2-provider-execution-authorization",
    "provider authorization artifact mismatch",
  );
  assert(authorization.storyId === "B-11be", "provider authorization storyId must be B-11be");
  assert(
    authorization.status === "metadata_authorization_recorded_provider_execution_still_disabled",
    "provider authorization status mismatch",
  );
  assertBoundary(authorization, "m2 provider execution authorization");
  assert(
    authorization.launchArtifactRef === "experiments/multi-model-ablation/m2-provider-execution-launch.json",
    "provider authorization launchArtifactRef mismatch",
  );

  const boundary = authorization.authorizationBoundary || {};
  assert(boundary.metadataAuthorizationRecorded === true, "metadata authorization must be recorded");
  assert(boundary.humanApprovalRecorded === true, "human approval must be recorded");
  assert(boundary.approvalSource === "user-chat-authorization-2026-07-05", "approval source mismatch");
  assert(boundary.appliesToStoryId === "B-11be", "approval must apply to B-11be");
  assert(boundary.providerBudgetCap?.currency === "USD", "provider budget currency must be USD");
  assert(boundary.providerBudgetCap?.amount === 0, "provider budget cap must be USD 0.00");
  assert(boundary.providerBudgetCap?.providerSpendAllowed === false, "provider spend must not be allowed");
  assert(boundary.providerExecutionAuthorized === false, "provider execution must remain unauthorized");
  assert(boundary.providerCallEnabled === false, "provider calls must remain disabled");
  assert(boundary.formalPhase1UseAllowed === false, "formal Phase 1 must remain disabled");
  assert(boundary.phase1CampaignAuthorized === false, "Phase 1 campaign must remain unauthorized");
  assert(boundary.phase2CampaignAuthorized === false, "Phase 2 campaign must remain unauthorized");
  assert(boundary.resultRowsAllowed === false, "result rows must not be allowed");
  assert(boundary.outcomeRecordsAllowed === false, "outcome records must not be allowed");
  assert(boundary.resultRowsPresent === false, "result rows must remain absent");
  assert(boundary.outcomeRecordsPresent === false, "outcome records must remain absent");
  assert(boundary.providerFallbackAllowed === false, "provider fallback must be rejected");
  assert(boundary.productGateImpact === "none", "provider authorization must have no product gate impact");

  assert(authorization.executionWindow?.allowsProviderCells === false, "B-11be execution window must not allow provider cells");
  assert(authorization.executionWindow?.allowsLocalChecks === true, "B-11be execution window must allow local checks");

  const futureFields = byId(authorization.requiredFutureExecutionMetadata, "fieldId");
  assert(
    futureFields.get("humanApproval")?.status === "recorded_for_metadata_only",
    "human approval must be metadata-only",
  );
  for (const fieldId of [
    "datedExecutorSnapshot",
    "datedReviewerSnapshot",
    "promptDigest",
    "toolSurfaceDigest",
    "runnerOwnership",
    "nonzeroProviderBudgetCap",
    "duplicatePolicy",
  ]) {
    const field = futureFields.get(fieldId);
    assert(field, `provider authorization missing future execution field ${fieldId}`);
    assert(
      field.status === "still_required_for_real_provider_execution",
      `${fieldId} must remain required for real provider execution`,
    );
    assert(field.value === null, `${fieldId} value must remain null`);
    assert(field.blocksProviderExecution === true, `${fieldId} must block provider execution`);
  }

  assert(
    authorization.sequencing?.nextPermittedFormalStep === "cell-03-calibration",
    "authorization must keep cell 03 as next permitted formal step",
  );
  assert(
    authorization.sequencing?.nextPermittedFormalStepMode === "separate_story_required",
    "authorization must require a separate provider-execution story",
  );
  assert(
    authorization.sequencing?.cell03Calibration?.providerExecutionAllowedInB11be === false,
    "cell 03 provider execution must not be allowed in B-11be",
  );
  assert(
    authorization.sequencing?.cell03Calibration?.requiresSeparateProviderExecutionStory === true,
    "cell 03 must require a separate provider-execution story",
  );
  assert(
    authorization.sequencing?.cell03Calibration?.requiresNonzeroBudgetApproval === true,
    "cell 03 must require nonzero budget approval before real execution",
  );
  assert(
    authorization.sequencing?.cell03Calibration?.executionEvidencePresent === false,
    "cell 03 execution evidence must remain absent",
  );
  assert(
    authorization.sequencing?.realCell03DerivedBudgetLock?.present === false,
    "authorization must not claim a real cell-03-derived budget lock",
  );
  assert(
    authorization.sequencing?.realCell03DerivedBudgetLock?.m0ExampleBudgetLockAcceptedAsFormalEvidence === false,
    "authorization must not accept M0 example budget lock as formal evidence",
  );
  assert(
    authorization.sequencing?.cell06A2primeGate?.state === "cell-06-a2prime-blocked",
    "authorization cell 06 blocked state mismatch",
  );
  assert(authorization.sequencing?.cell06A2primeGate?.blocked === true, "authorization must keep cell 06 blocked");
  assert(
    authorization.sequencing?.cell06A2primeGate?.executionAllowed === false,
    "authorization must keep cell 06 execution disabled",
  );
  assert(
    authorization.sequencing?.cell06A2primeGate?.matchingRealBudgetLockPresent === false,
    "authorization must not claim a matching real budget lock",
  );

  assert(
    authorization.hostModelSeparation?.hostLabelOnlySnapshotsAccepted === false,
    "authorization must reject host-label-only snapshots",
  );
  assert(
    authorization.hostModelSeparation?.providerFallbackAllowed === false,
    "authorization must reject provider fallback",
  );
  for (const label of HOST_LABELS) {
    assert(
      authorization.hostModelSeparation?.hostLabelsRejectedAsSnapshots?.includes(label),
      `authorization must explicitly reject host label as snapshot: ${label}`,
    );
  }
  for (const field of authorization.hostModelSeparation?.snapshotFieldsStillRequiredForRealExecution || []) {
    assert(!isHostLabel(field), `authorization snapshot field name must not be a host label: ${field}`);
  }

  assert(authorization.claimBoundary?.hM1Proven === false, "authorization must not prove H-M1");
  assert(authorization.claimBoundary?.hM3Proven === false, "authorization must not prove H-M3");
  assert(
    authorization.claimBoundary?.phase1DirectionalReadoutPresent === false,
    "authorization must not claim a Phase 1 directional readout",
  );
  assert(
    authorization.claimBoundary?.modelAgnosticPaperClaimUnlocked === false,
    "authorization must not unlock model-agnostic wording",
  );
  assert(authorization.claimBoundary?.productGateImpact === "none", "authorization must not affect product gates");

  assert(launch.launchState?.providerCallEnabled === false, "authorization must not override disabled launch state");
  assert(
    launch.sequencing?.cell06A2primeGate?.blocked === true,
    "authorization must not override launch cell 06 blocked state",
  );
}

function validateExistingM2Artifacts(artifacts) {
  for (const [name, doc] of Object.entries({
    m2LaunchReadiness: artifacts.m2LaunchReadiness,
    snapshots: artifacts.snapshots,
    inventory: artifacts.inventory,
    runnerManifest: artifacts.runnerManifest,
    phase1Readiness: artifacts.phase1Readiness,
  })) {
    assertBoundary(doc, name);
    assertNoOutcomeOrRecordsPath(doc, name);
  }

  assert(artifacts.m2LaunchReadiness.authorizationBoundary?.providerExecutionAuthorized === false, "M2 readiness must not authorize provider execution");
  assert(artifacts.m2LaunchReadiness.authorizationBoundary?.providerCallEnabled === false, "M2 readiness must keep provider calls disabled");

  for (const family of artifacts.snapshots.modelFamilies || []) {
    assert(!isHostLabel(family.providerFamily), `${family.familyId} providerFamily must not be a host label`);
    assert(family.hostKindIsModelFamily === false, `${family.familyId} must not treat hostKind as model family`);
    assert(family.providerCallsEnabled === false, `${family.familyId} provider calls must be disabled`);
    assert(family.formalPhase1UseAllowed === false, `${family.familyId} formal Phase 1 use must be disabled`);
  }
  assert(artifacts.snapshots.snapshotReadinessBoundary?.providerFallbackAllowed === false, "snapshot readiness must reject provider fallback");
  assert(
    artifacts.snapshots.separationAssertion?.hostKindMayNotSubstituteForProviderFamily === true,
    "snapshot readiness must reject hostKind as provider family",
  );

  for (const runner of artifacts.runnerManifest.runners || []) {
    assert(runner.providerCallEnabled === false, `M2 runner provider calls must be disabled: ${runner.runnerId}`);
    assert(runner.eligibleForResultRows === false, `M2 runner result rows must be disabled: ${runner.runnerId}`);
    assert(!isHostLabel(runner.providerModelFamily), `runner providerModelFamily must not be a host label: ${runner.runnerId}`);
  }

  const readinessChecks = byId(artifacts.phase1Readiness.readinessChecks, "checkId");
  const calibration = readinessChecks.get("③-a4-calibration");
  assert(calibration?.cellNumber === "③", "phase1 readiness must identify cell 03 calibration");
  assert(calibration?.status === "pending_execution", "cell 03 calibration must remain pending execution");
  assert(calibration?.executionEvidencePresent === false, "cell 03 calibration must not have execution evidence");
  assert(calibration?.blocksA2prime === true, "cell 03 calibration must block A2prime");

  const budgetLock = readinessChecks.get("real-budget-lock");
  assert(budgetLock?.realBudgetLockPresent === false, "real budget lock must remain absent");
  assert(
    budgetLock?.m0ExampleBudgetLockAcceptedAsFormalEvidence === false,
    "example budget lock must not be accepted as formal evidence",
  );

  const a2prime = readinessChecks.get("⑥-a2prime-sequencing");
  assert(a2prime?.status === "blocked_until_real_budget_lock", "cell 06 must remain blocked until real budget lock");
  assert(a2prime?.executionAllowed === false, "cell 06 execution must not be allowed");
  assert(a2prime?.matchingRealBudgetLockPresent === false, "cell 06 must not claim a matching real budget lock");
}

function validateStatus(statusText) {
  for (const [key, value] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(statusText.includes(`${key}=${JSON.stringify(value)}`), `status missing ${key}=${JSON.stringify(value)}`);
  }
  for (const requiredLine of [
    "| M2-provider authorization metadata | DONE |",
    "| M2 provider execution launch gate | PREPARED |",
    "| M2 provider execution checker | PREPARED |",
    "| Formal M2 execution | NOT STARTED |",
    "| ③ A4 calibration | PENDING EXECUTION |",
    "| ⑥ A2prime | BLOCKED |",
  ]) {
    assert(statusText.includes(requiredLine), `status missing row: ${requiredLine}`);
  }
  assert(statusText.includes("providerExecutionAuthorized=false"), "status must report providerExecutionAuthorized=false");
  assert(statusText.includes("M2-provider authorization metadata: DONE"), "status must report authorization metadata done");
  assert(statusText.includes("provider spend USD 0.00"), "status must report provider spend USD 0.00");
  assert(statusText.includes("no provider cells ran"), "status must report no provider cells ran");
  assert(statusText.includes("no result rows exist"), "status must report no result rows exist");
  assert(statusText.includes("cell 03 is next"), "status must report cell 03 is next");
  assert(statusText.includes("cell 06 remains blocked"), "status must report cell 06 remains blocked");
  assert(statusText.includes("nextPermittedFormalStep=cell-03-calibration"), "status must report cell 03 as next permitted step");
  assert(statusText.includes("cell-06-a2prime-blocked"), "status must report cell 06 blocked state");
  assert(/no claim unlock/i.test(statusText), "status must state no claim unlock");
  assert(/no product gate impact/i.test(statusText), "status must state no product gate impact");
}

function loadArtifacts() {
  return {
    m2LaunchReadiness: readJson(paths.m2LaunchReadiness),
    snapshots: readJson(paths.snapshots),
    inventory: readJson(paths.inventory),
    runnerManifest: readJson(paths.runnerManifest),
    phase1Readiness: readJson(paths.phase1Readiness),
    providerLaunch: readJson(paths.providerLaunch),
    providerAuthorization: readJson(paths.providerAuthorization),
    status: readText(paths.status),
  };
}

function validateAll(artifacts) {
  validateExistingM2Artifacts(artifacts);
  validateProviderLaunch(artifacts.providerLaunch);
  validateProviderAuthorization(artifacts.providerAuthorization, artifacts.providerLaunch);
  validateProviderLaunchRunnerBindings(artifacts.providerLaunch, artifacts.runnerManifest);
  assertNoOutcomeOrRecordsPath(artifacts.providerLaunch, "providerLaunch");
  assertNoOutcomeOrRecordsPath(artifacts.providerAuthorization, "providerAuthorization");
  assertNoRecordsFileExists();
  validateStatus(artifacts.status);
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

const baseArtifacts = loadArtifacts();

validateAll(baseArtifacts);

expectReject(
  "accidental provider authorization without required metadata",
  (artifacts) => {
    artifacts.providerLaunch.launchState.providerExecutionAuthorized = true;
    artifacts.providerLaunch.authorization.providerExecutionAuthorized = true;
  },
  /providerExecutionAuthorized must be false|cannot be authorized without required metadata/,
);

expectReject(
  "provider-call enabled runner without authorization metadata",
  (artifacts) => {
    const runner = artifacts.providerLaunch.runnerAuthorization.runners[0];
    runner.providerCallEnabled = true;
    artifacts.providerLaunch.runnerAuthorization.providerCallEnabledRunnerCount = 1;
  },
  /provider execution cannot be authorized without required metadata|no provider-call enabled runners|provider calls must be disabled/,
);

expectReject(
  "host-label-only executor snapshot",
  (artifacts) => {
    const runner = artifacts.providerLaunch.runnerAuthorization.runners[0];
    runner.executorSnapshot = "Codex CLI";
  },
  /executorSnapshot must not be a host label/,
);

expectReject(
  "host-label-only reviewer snapshot",
  (artifacts) => {
    const runner = artifacts.providerLaunch.runnerAuthorization.runners[0];
    runner.reviewerSnapshot = "Claude Code CLI";
  },
  /reviewerSnapshot must not be a host label/,
);

expectReject(
  "snapshot lock provider family replaced by host label",
  (artifacts) => {
    artifacts.snapshots.modelFamilies.find((family) => family.familyId === "E2").providerFamily = "Codex CLI";
  },
  /providerFamily must not be a host label/,
);

expectReject(
  "provider fallback allowed",
  (artifacts) => {
    artifacts.providerLaunch.authorization.providerFallbackAllowed = true;
  },
  /provider fallback must be rejected/,
);

expectReject(
  "authorization provider budget made nonzero",
  (artifacts) => {
    artifacts.providerAuthorization.authorizationBoundary.providerBudgetCap.amount = 1;
    artifacts.providerAuthorization.authorizationBoundary.providerBudgetCap.providerSpendAllowed = true;
  },
  /provider budget cap must be USD 0\.00|provider spend must not be allowed/,
);

expectReject(
  "authorization provider calls enabled",
  (artifacts) => {
    artifacts.providerAuthorization.authorizationBoundary.providerCallEnabled = true;
  },
  /provider calls must remain disabled/,
);

expectReject(
  "authorization real provider execution enabled",
  (artifacts) => {
    artifacts.providerAuthorization.authorizationBoundary.providerExecutionAuthorized = true;
  },
  /provider execution must remain unauthorized/,
);

expectReject(
  "authorization missing future executor snapshot blocker",
  (artifacts) => {
    artifacts.providerAuthorization.requiredFutureExecutionMetadata =
      artifacts.providerAuthorization.requiredFutureExecutionMetadata.filter(
        (field) => field.fieldId !== "datedExecutorSnapshot",
      );
  },
  /missing future execution field datedExecutorSnapshot/,
);

expectReject(
  "authorization host label accepted as snapshot",
  (artifacts) => {
    artifacts.providerAuthorization.hostModelSeparation.hostLabelOnlySnapshotsAccepted = true;
  },
  /reject host-label-only snapshots/,
);

expectReject(
  "authorization host label rejection list missing Codex CLI",
  (artifacts) => {
    artifacts.providerAuthorization.hostModelSeparation.hostLabelsRejectedAsSnapshots =
      artifacts.providerAuthorization.hostModelSeparation.hostLabelsRejectedAsSnapshots.filter(
        (label) => label !== "Codex CLI",
      );
  },
  /explicitly reject host label as snapshot: Codex CLI/,
);

expectReject(
  "authorization cell 03 execution allowed in B-11be",
  (artifacts) => {
    artifacts.providerAuthorization.sequencing.cell03Calibration.providerExecutionAllowedInB11be = true;
  },
  /cell 03 provider execution must not be allowed in B-11be/,
);

expectReject(
  "authorization cell 06 unblocked",
  (artifacts) => {
    artifacts.providerAuthorization.sequencing.cell06A2primeGate.state = "ready";
    artifacts.providerAuthorization.sequencing.cell06A2primeGate.blocked = false;
    artifacts.providerAuthorization.sequencing.cell06A2primeGate.executionAllowed = true;
  },
  /authorization cell 06 blocked state mismatch|authorization must keep cell 06 blocked|authorization must keep cell 06 execution disabled/,
);

expectReject(
  "authorization outcome records path added",
  (artifacts) => {
    artifacts.providerAuthorization.authorizationBoundary.outcomeRecordsPath = "records-multi-model-ablation.jsonl";
  },
  /forbidden records path field|contains forbidden records path/,
);

expectReject(
  "cell 03 no longer next formal step",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.nextPermittedFormalStep = "cell-06-a2prime";
  },
  /cell 03 must be the next permitted formal step/,
);

expectReject(
  "cell 06 unblocked without real budget lock",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.cell06A2primeGate.state = "ready";
    artifacts.providerLaunch.sequencing.cell06A2primeGate.blocked = false;
    artifacts.providerLaunch.sequencing.cell06A2primeGate.executionAllowed = true;
  },
  /cell 06 blocked state mismatch|cell 06 must be blocked|cell 06 execution must be disabled/,
);

expectReject(
  "real budget lock falsely present",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.realCell03DerivedBudgetLock.present = true;
  },
  /real cell-03-derived budget lock must be absent/,
);

expectReject(
  "outcome data accidentally added",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.runners[0].outcome = "amplified";
  },
  /forbidden outcome field/,
);

expectReject(
  "result rows accidentally added",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.runners[0].resultRows = [{ score: 1 }];
  },
  /forbidden result\/outcome data field/,
);

expectReject(
  "outcome records accidentally added",
  (artifacts) => {
    artifacts.providerLaunch.outcomeRecords = [{ cell: "03" }];
  },
  /forbidden result\/outcome data field/,
);

expectReject(
  "phase 1 results accidentally added",
  (artifacts) => {
    artifacts.providerLaunch.phase1Results = [{ cell: "03" }];
  },
  /forbidden result\/outcome data field/,
);

expectReject(
  "phase 2 results accidentally added",
  (artifacts) => {
    artifacts.providerLaunch.phase2Results = [{ cell: "phase2" }];
  },
  /forbidden result\/outcome data field/,
);

expectReject(
  "result rows presence flag flipped",
  (artifacts) => {
    artifacts.providerLaunch.launchState.resultRowsPresent = true;
  },
  /result\/outcome data present|result rows must remain absent/,
);

expectReject(
  "outcome records presence flag flipped",
  (artifacts) => {
    artifacts.providerLaunch.launchState.outcomeRecordsPresent = true;
  },
  /result\/outcome data present|outcome records must remain absent/,
);

expectReject(
  "contains outcome data flag flipped outside researchBoundary",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.containsOutcomeData = true;
  },
  /result\/outcome data present/,
);

expectReject(
  "provider launch missing runner",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.runners = artifacts.providerLaunch.runnerAuthorization.runners.filter(
      (runner) => runner.runnerId !== "m2-future-cell-03-e2-a4-same",
    );
  },
  /provider launch missing runner/,
);

expectReject(
  "provider launch extra runner",
  (artifacts) => {
    const extraRunner = deepClone(artifacts.providerLaunch.runnerAuthorization.runners[0]);
    extraRunner.runnerId = "m2-future-cell-99-extra";
    extraRunner.cellNumber = "99";
    extraRunner.protocolCellNumber = "⑨";
    artifacts.providerLaunch.runnerAuthorization.runners.push(extraRunner);
  },
  /provider launch has extra runner/,
);

expectReject(
  "provider launch runner cell number drift",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.runners.find(
      (runner) => runner.runnerId === "m2-future-cell-03-e2-a4-same",
    ).cellNumber = "06";
  },
  /cell 03 runner .* launch cellNumber mismatch/,
);

expectReject(
  "provider launch runner protocol cell drift",
  (artifacts) => {
    artifacts.providerLaunch.runnerAuthorization.runners.find(
      (runner) => runner.runnerId === "m2-future-cell-06-e2-a2prime",
    ).protocolCellNumber = "③";
  },
  /cell 06 runner .* launch protocolCellNumber mismatch/,
);

expectReject(
  "cell 03 manifest arm binding drift",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells.find((cell) => cell.runnerId === "m2-future-cell-03-e2-a4-same").arm =
      "A2prime";
  },
  /cell 03 runner .* manifest arm mismatch/,
);

expectReject(
  "cell 06 manifest reviewer binding drift",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells.find((cell) => cell.runnerId === "m2-future-cell-06-e2-a2prime").reviewerFamily =
      "same";
  },
  /cell 06 runner .* manifest reviewerFamily mismatch/,
);

expectReject(
  "cell 02 provider model family binding drift",
  (artifacts) => {
    artifacts.runnerManifest.runners.find((runner) => runner.runnerId === "m2-future-cell-02-e1-a4-cross").providerModelFamily =
      "E2";
  },
  /cell 02 runner .* providerModelFamily mismatch/,
);

expectReject(
  "cell 04 manifest reviewer binding drift",
  (artifacts) => {
    artifacts.runnerManifest.phase1Cells.find((cell) => cell.runnerId === "m2-future-cell-04-e2-a4-cross").reviewerFamily =
      "same";
  },
  /cell 04 runner .* manifest reviewerFamily mismatch/,
);

expectReject(
  "cell 03 sequencing arm binding drift",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.cell03Calibration.arm = "A2prime";
  },
  /cell 03 sequencing arm mismatch/,
);

expectReject(
  "cell 06 sequencing protocol binding drift",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.cell06A2primeGate.protocolCellNumber = "③";
  },
  /cell 06 sequencing protocolCellNumber mismatch/,
);

console.log(
  `M2 provider execution checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`,
);
console.log("M2-provider authorization metadata: Done");
console.log("Provider spend in B-11be: USD 0.00");
console.log("Provider cells run in B-11be: none");
console.log("nextPermittedFormalStep=cell-03-calibration");
console.log("cell-06-a2prime-blocked");
console.log("Cell 06 A2prime: blocked");
console.log("Provider execution remains disabled; no provider calls made; no outcome records present");
