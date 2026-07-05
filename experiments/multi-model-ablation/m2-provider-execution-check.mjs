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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const paths = Object.freeze({
  m2LaunchReadiness: "m2-launch-readiness.json",
  snapshots: "model-snapshot-lock.m2.json",
  inventory: "task-inventory.m2.json",
  runnerManifest: "phase1-runner-manifest.m2.json",
  phase1Readiness: "phase1-launch-readiness.m2.json",
  providerLaunch: "m2-provider-execution-launch.json",
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
    "| M2 provider execution launch gate | PREPARED |",
    "| M2 provider execution checker | PREPARED |",
    "| Formal M2 execution | NOT STARTED |",
    "| ③ A4 calibration | PENDING EXECUTION |",
    "| ⑥ A2prime | BLOCKED |",
  ]) {
    assert(statusText.includes(requiredLine), `status missing row: ${requiredLine}`);
  }
  assert(statusText.includes("providerExecutionAuthorized=false"), "status must report providerExecutionAuthorized=false");
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
    status: readText(paths.status),
  };
}

function validateAll(artifacts) {
  validateExistingM2Artifacts(artifacts);
  validateProviderLaunch(artifacts.providerLaunch);
  assertNoOutcomeOrRecordsPath(artifacts.providerLaunch, "providerLaunch");
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

console.log(
  `M2 provider execution checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`,
);
console.log("nextPermittedFormalStep=cell-03-calibration");
console.log("cell-06-a2prime-blocked");
console.log("Provider execution remains disabled; no provider calls made; no outcome records present");
