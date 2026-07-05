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

const HOST_LABELS = Object.freeze([
  "Codex CLI",
  "Codex App",
  "Claude Code CLI",
  "Antigravity CLI",
  "agy",
]);

const FORBIDDEN_BUDGET_GATE_KEYS = Object.freeze([
  "budgetcap",
  "exactbudgetapproval",
  "exactbudgetapprovalstatus",
  "requiresexactnonzerobudgetapproval",
  "requiredapprovalfields",
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

const EXPECTED_PROMPT_DIGEST = "sha256:b1f7c70a48cf2f2c12b99bedb0f0d4259bfe334276ebf27cd1164903d33a5fa6";
const EXPECTED_TOOL_SURFACE_DIGEST =
  "sha256:c42696e2c4b36d0d1a85656000a0fc63bc5aee7158361a1f4da1279afc50beb9";
const CELL03_ENVELOPE_REF = "experiments/multi-model-ablation/m2-cell03-execution-envelope.json";
const CELL03_USAGE_POLICY_REF =
  "experiments/multi-model-ablation/m2-cell03-usage-accounting-policy.json";
const CELL03_RESULT_POLICY_REF =
  "experiments/multi-model-ablation/m2-cell03-result-write-policy.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const paths = Object.freeze({
  m2LaunchReadiness: "m2-launch-readiness.json",
  snapshots: "model-snapshot-lock.m2.json",
  runnerManifest: "phase1-runner-manifest.m2.json",
  phase1Readiness: "phase1-launch-readiness.m2.json",
  providerLaunch: "m2-provider-execution-launch.json",
  providerAuthorization: "m2-provider-execution-authorization.json",
  cell03LaunchGuardrail: "m2-cell03-provider-launch-authorization.json",
  cell03Envelope: "m2-cell03-execution-envelope.json",
  usagePolicy: "m2-cell03-usage-accounting-policy.json",
  prompt: "m2-cell03-execution-prompt.md",
  toolSurface: "m2-cell03-tool-surface.json",
  resultWritePolicy: "m2-cell03-result-write-policy.json",
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

function sha256Text(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function byId(entries, key) {
  return new Map((entries || []).map((entry) => [entry[key], entry]));
}

function isHostLabel(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return HOST_LABELS.some((label) => label.toLowerCase() === normalized) || /\b(cli|host|adapter|app)\b/i.test(value);
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

function assertNoOldBudgetGateKeys(value, location = "document") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOldBudgetGateKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    assert(!FORBIDDEN_BUDGET_GATE_KEYS.includes(normalizedKey), `${location} contains old budget gate key ${key}`);
    if (normalizedKey === "fieldid") {
      const normalizedValue = normalizeKey(child);
      assert(!FORBIDDEN_BUDGET_GATE_KEYS.includes(normalizedValue), `${location} contains old budget gate field ${child}`);
    }
    assertNoOldBudgetGateKeys(child, `${location}.${key}`);
  }
}

function assertNoEnabledProviderCalls(value, location = "document") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEnabledProviderCalls(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    if (
      [
        "providercallenabled",
        "providerexecutionauthorized",
        "formalphase1useallowed",
        "phase1campaignauthorized",
        "phase2campaignauthorized",
        "providerspendallowed",
      ].includes(normalizedKey)
    ) {
      assert(child === false, `${location}.${key} must remain false`);
    }
    assertNoEnabledProviderCalls(child, `${location}.${key}`);
  }
}

function assertHostLabelsRejected(doc, location) {
  assert(doc.hostModelSeparation?.hostLabelOnlySnapshotsAccepted === false, `${location} must reject host-label snapshots`);
  for (const label of HOST_LABELS) {
    assert(
      doc.hostModelSeparation?.hostLabelsRejectedAsSnapshots?.includes(label),
      `${location} must reject host label as snapshot: ${label}`,
    );
  }
}

function assertTargetSnapshot(snapshot, label) {
  assert(snapshot?.familyId === "E2", `${label} must target E2`);
  assert(snapshot.providerFamily === "OpenAI GPT", `${label} provider family mismatch`);
  assert(snapshot.snapshotId === "openai-gpt-family-readiness-2026-07-05", `${label} snapshot id mismatch`);
  assert(snapshot.hostLabelAccepted === false, `${label} must reject host labels`);
  assert(snapshot.providerRunMetadataPresent === false, `${label} must not claim provider run metadata`);
  for (const value of [snapshot.providerFamily, snapshot.snapshotId]) {
    assert(!isHostLabel(value), `${label} must not be a host label`);
  }
}

function validateEnvelope(envelope, promptText, toolSurfaceText) {
  assert(envelope.artifact === "m2-cell03-execution-envelope", "Cell 03 envelope artifact mismatch");
  assert(envelope.storyId === "B-6529", "Cell 03 envelope storyId must be B-6529");
  assert(envelope.status === "authorization_ready_execution_not_run", "Cell 03 envelope status mismatch");
  assertBoundary(envelope, "Cell 03 execution envelope");
  assert(envelope.executionState?.envelopeFrozen === true, "Cell 03 execution envelope must be frozen");
  assert(envelope.executionState?.providerExecutionAuthorized === false, "envelope must not authorize provider execution");
  assert(envelope.executionState?.providerCallEnabled === false, "envelope must keep provider calls disabled");
  assert(envelope.executionState?.formalPhase1UseAllowed === false, "envelope must keep formal Phase 1 disabled");
  assert(envelope.executionState?.providerCallsFromThisStory === "disabled", "provider calls from this story must be disabled");

  const scope = envelope.cellScope || {};
  assert(scope.cellNumber === "03", "envelope cell number mismatch");
  assert(scope.protocolCellNumber === "③", "envelope protocol cell mismatch");
  assert(scope.arm === "A4", "envelope arm mismatch");
  assert(scope.executorFamily === "E2", "envelope executor family mismatch");
  assert(scope.reviewerFamily === "same", "envelope reviewer family mismatch");
  assert(scope.runnerId === "m2-future-cell-03-e2-a4-same", "envelope runner mismatch");
  assert(scope.taskCount === 24, "envelope task count must be 24");
  assert(scope.scenarioSlots === 16, "envelope scenario slots must be 16");
  assert(scope.repeatSlots === 3, "envelope repeat slots must be 3");
  assert(scope.plannedRows === 1152, "envelope planned rows must be 1152");
  for (const excluded of ["02", "04", "06", "Phase 2"]) {
    assert(scope.otherCellsExcluded?.includes(excluded), `envelope must exclude ${excluded}`);
  }

  const limits = envelope.limits || {};
  assert(limits.maxProviderCalls === 1152, "envelope max provider calls must be bounded to 1152");
  assert(limits.maxAttemptsPerCellKey === 2, "envelope max attempts per cell key mismatch");
  assert(limits.maxRetriesPerCellKey === 1, "envelope max retries per cell key mismatch");
  assert(limits.maxWallClockHours === 24, "envelope wall-clock bound mismatch");
  assert(limits.maxInputTokensPerAttempt === 12000, "envelope input token bound mismatch");
  assert(limits.maxOutputTokensPerAttempt === 6000, "envelope output token bound mismatch");
  assert(limits.maxTotalOutputRows === 1152, "envelope output row bound mismatch");
  assert(limits.preRunDollarGuessRequired === false, "pre-run dollar guess must not be required");
  assert(limits.preRunDollarCapRequired === false, "pre-run dollar cap must not be required");
  assert(limits.preRunDollarAmount === null, "pre-run dollar amount must stay null");

  for (const phrase of [
    "providerCallEnabled is false",
    "provider fallback occurs",
    "host label",
    "provider-reported usage",
  ]) {
    assert(
      (envelope.stopConditions || []).some((condition) => condition.includes(phrase)),
      `envelope missing stop condition containing ${phrase}`,
    );
  }

  assert(envelope.targetSnapshots?.hostLabelOnlySnapshotsAccepted === false, "target snapshots must reject host labels");
  assertTargetSnapshot(envelope.targetSnapshots?.executorTargetSnapshot, "envelope executor target snapshot");
  assertTargetSnapshot(envelope.targetSnapshots?.reviewerTargetSnapshot, "envelope reviewer target snapshot");

  assert(envelope.promptArtifact?.path === "experiments/multi-model-ablation/m2-cell03-execution-prompt.md", "prompt path mismatch");
  assert(envelope.promptArtifact?.sha256 === EXPECTED_PROMPT_DIGEST, "prompt digest mismatch in envelope");
  assert(envelope.promptArtifact?.sha256 === sha256Text(promptText), "prompt digest must match file bytes");
  assert(envelope.toolSurfaceArtifact?.path === "experiments/multi-model-ablation/m2-cell03-tool-surface.json", "tool path mismatch");
  assert(envelope.toolSurfaceArtifact?.sha256 === EXPECTED_TOOL_SURFACE_DIGEST, "tool-surface digest mismatch in envelope");
  assert(envelope.toolSurfaceArtifact?.sha256 === sha256Text(toolSurfaceText), "tool-surface digest must match file bytes");

  assert(envelope.usageAccountingPolicyRef === CELL03_USAGE_POLICY_REF, "usage accounting policy ref mismatch");
  assert(envelope.resultWritePolicyRef === CELL03_RESULT_POLICY_REF, "result write policy ref mismatch");
  assert(envelope.runnerOwnership?.ownerRecorded === true, "runner ownership must be recorded");
  assert(envelope.runnerOwnership?.runnerId === "m2-future-cell-03-e2-a4-same", "runner ownership id mismatch");
  assert(envelope.runnerOwnership?.ownershipKey === "③|A4|E2|same", "runner ownership key mismatch");
  assert(envelope.runnerOwnership?.duplicateOwnershipAllowed === false, "duplicate ownership must be rejected");
  assert(envelope.duplicatePolicy?.duplicateCellKeysAllowed === false, "duplicate cell keys must be rejected");
  assert(envelope.postflightUsageAccounting?.providerReportedUsageRequiredAfterExecution === true, "postflight provider usage must be required");
  assert(envelope.postflightUsageAccounting?.estimateUse === "diagnostic_only", "estimate use must be diagnostic only");
  assert(envelope.postflightUsageAccounting?.estimateMayBeFinalUsage === false, "estimate must not be final usage");
  assert(envelope.postflightUsageAccounting?.estimateMayGateLaunch === false, "estimate must not gate launch");
  assertCell06Blocked(envelope.cell06A2primeGate, "envelope Cell 06 gate");
}

function assertCell06Blocked(gate, label) {
  assert(gate?.state === "cell-06-a2prime-blocked", `${label} state mismatch`);
  assert(gate.blocked === true, `${label} must be blocked`);
  assert(gate.executionAllowed === false, `${label} execution must be disabled`);
  assert(gate.matchingRealBudgetLockPresent !== true, `${label} must not claim a real budget lock`);
  assert(gate.matchingRealUsageLockPresent !== true, `${label} must not claim a real usage lock`);
}

function validateUsagePolicy(policy) {
  assert(policy.artifact === "m2-cell03-usage-accounting-policy", "usage policy artifact mismatch");
  assert(policy.storyId === "B-6529", "usage policy storyId mismatch");
  assert(policy.status === "postflight_provider_reported_usage_required", "usage policy status mismatch");
  assert(policy.appliesToEnvelopeRef === CELL03_ENVELOPE_REF, "usage policy envelope ref mismatch");
  assert(policy.providerCallEnabled === false, "usage policy provider calls must be disabled");
  assert(policy.preRunDollarGuessRequired === false, "usage policy must not require a pre-run dollar guess");
  assert(policy.preRunDollarCapAsLaunchGate === false, "usage policy must not use a dollar cap as launch gate");
  const accounting = policy.postflightUsageAccounting || {};
  assert(accounting.requiredAfterFutureExecution === true, "postflight usage must be required");
  assert(accounting.finalUsageSource === "provider_reported_usage", "final usage source must be provider reported");
  assert(accounting.providerReportedUsageRequired === true, "provider-reported usage must be required");
  assert(accounting.estimateUse === "diagnostic_only", "estimate must be diagnostic only");
  assert(accounting.estimateMayBeFinalUsage === false, "estimate must not be final usage");
  assert(accounting.estimateMayGateLaunch === false, "estimate must not gate launch");
  assert(policy.cell06Dependency?.blocked === true, "usage policy must keep Cell 06 blocked");
  assert(policy.cell06Dependency?.matchingRealBudgetOrUsageLockPresent === false, "usage policy must not claim Cell 06 lock");
}

function validateResultPolicy(policy) {
  assert(policy.artifact === "m2-cell03-result-write-policy", "result write policy artifact mismatch");
  assert(policy.storyId === "B-6529", "result write policy storyId mismatch");
  assert(policy.appliesToEnvelopeRef === CELL03_ENVELOPE_REF, "result write policy envelope ref mismatch");
  assert(policy.providerCallEnabled === false, "result write policy provider calls must be disabled");
  assert(policy.resultRowsAllowedInThisStory === false, "result rows must not be allowed in this story");
  assert(policy.outcomeRecordsAllowedInThisStory === false, "outcome records must not be allowed in this story");
  assert(policy.futureResultOutputPolicy?.rowCountExpectedAfterFutureExecution === 1152, "future result row count mismatch");
  assert(policy.futureResultOutputPolicy?.mustIncludeProviderReportedUsage === true, "future rows must include provider usage");
  assert(policy.duplicatePolicy?.duplicateCellKeysAllowed === false, "result write duplicate cell keys must be rejected");
}

function validateToolSurface(toolSurface) {
  assert(toolSurface.artifact === "m2-cell03-tool-surface", "tool surface artifact mismatch");
  assert(toolSurface.storyId === "B-6529", "tool surface storyId mismatch");
  assert(toolSurface.status === "frozen_execution_not_run", "tool surface status mismatch");
  assert(toolSurface.appliesToEnvelopeRef === CELL03_ENVELOPE_REF, "tool surface envelope ref mismatch");
  assert(toolSurface.providerCallsFromThisStory === "disabled", "tool surface must disable provider calls from this story");
  assert(toolSurface.providerCallEnabled === false, "tool surface provider calls must be disabled");
  assert(toolSurface.formalPhase1UseAllowed === false, "tool surface formal Phase 1 use must be disabled");
  assert(toolSurface.toolSurface?.futureProviderInvocation?.allowedOnlyAfterSeparateExecutionAuthorization === true, "future provider invocation must require separate authorization");
  assert(toolSurface.toolSurface?.futureProviderInvocation?.runnerId === "m2-future-cell-03-e2-a4-same", "tool surface runner mismatch");
  assert(toolSurface.toolSurface?.writePolicyRef === CELL03_RESULT_POLICY_REF, "tool surface write policy ref mismatch");
  assert((toolSurface.toolSurface?.forbiddenInThisStory || []).includes("provider API calls"), "tool surface must forbid provider API calls in this story");
  assertHostLabelsRejected(toolSurface, "tool surface");
}

function validateProviderAuthorization(authorization) {
  assert(authorization.artifact === "m2-provider-execution-authorization", "provider authorization artifact mismatch");
  assert(authorization.storyId === "B-11be", "provider authorization storyId mismatch");
  assert(
    authorization.status === "metadata_authorization_recorded_provider_execution_still_disabled",
    "provider authorization status mismatch",
  );
  assert(
    authorization.launchArtifactRef === "experiments/multi-model-ablation/m2-provider-execution-launch.json",
    "provider authorization launch ref mismatch",
  );
  assertBoundary(authorization, "provider authorization");

  const boundary = authorization.authorizationBoundary || {};
  assert(boundary.metadataAuthorizationRecorded === true, "provider authorization metadata must be recorded");
  assert(boundary.humanApprovalRecorded === true, "provider authorization human approval must be recorded");
  assert(boundary.approvalSource === "user-chat-authorization-2026-07-05", "provider authorization source mismatch");
  assert(boundary.approvedBy === "jek", "provider authorization approver mismatch");
  assert(boundary.approvalDate === "2026-07-05", "provider authorization approval date mismatch");
  assert(boundary.appliesToStoryId === "B-11be", "provider authorization applies-to story mismatch");
  assert(!("providerBudgetCap" in boundary), "provider authorization must not use providerBudgetCap as a future launch cap");

  const spendBoundary = boundary.providerSpendBoundary || {};
  assert(spendBoundary.currency === "USD", "provider authorization spend boundary currency mismatch");
  assert(spendBoundary.amount === 0, "provider authorization spend boundary must record zero spend");
  assert(spendBoundary.providerSpendAllowed === false, "provider authorization must not allow provider spend");
  assert(
    /not a future launch cap/.test(spendBoundary.meaning || ""),
    "provider authorization spend boundary must not become a future launch cap",
  );

  assert(boundary.providerExecutionAuthorized === false, "provider authorization must not authorize execution");
  assert(boundary.providerCallEnabled === false, "provider authorization must keep provider calls disabled");
  assert(boundary.formalPhase1UseAllowed === false, "provider authorization must keep formal Phase 1 disabled");
  assert(boundary.phase1CampaignAuthorized === false, "provider authorization must not authorize Phase 1");
  assert(boundary.phase2CampaignAuthorized === false, "provider authorization must not authorize Phase 2");
  assert(boundary.resultRowsAllowed === false, "provider authorization must not allow result rows");
  assert(boundary.outcomeRecordsAllowed === false, "provider authorization must not allow outcome records");
  assert(boundary.resultRowsPresent === false, "provider authorization must not claim result rows");
  assert(boundary.outcomeRecordsPresent === false, "provider authorization must not claim outcome records");
  assert(boundary.providerFallbackAllowed === false, "provider authorization must reject provider fallback");
  assert(boundary.productGateImpact === "none", "provider authorization product gate impact mismatch");
  assert(authorization.executionWindow?.allowsProviderCells === false, "provider authorization window must not allow provider cells");
  assert(authorization.executionWindow?.allowsLocalChecks === true, "provider authorization window must allow local checks");

  const fields = byId(authorization.requiredFutureExecutionMetadata, "fieldId");
  for (const forbidden of ["nonzeroProviderBudgetCap", "budgetCap", "exactBudgetApproval"]) {
    assert(!fields.has(forbidden), `provider authorization must not require ${forbidden}`);
  }
  for (const fieldId of [
    "humanApproval",
    "datedExecutorSnapshot",
    "datedReviewerSnapshot",
    "promptDigest",
    "toolSurfaceDigest",
    "runnerOwnership",
    "boundedExecutionEnvelope",
    "duplicatePolicy",
    "resultOutputPolicy",
    "postflightUsageAccountingPolicy",
  ]) {
    assert(fields.has(fieldId), `provider authorization missing future metadata ${fieldId}`);
  }
  assert(fields.get("boundedExecutionEnvelope")?.value === CELL03_ENVELOPE_REF, "provider authorization envelope ref mismatch");
  assert(
    fields.get("resultOutputPolicy")?.value === CELL03_RESULT_POLICY_REF,
    "provider authorization result policy ref mismatch",
  );
  assert(
    fields.get("postflightUsageAccountingPolicy")?.value === CELL03_USAGE_POLICY_REF,
    "provider authorization usage policy ref mismatch",
  );

  const cell03 = authorization.sequencing?.cell03Calibration || {};
  assert(authorization.sequencing?.nextPermittedFormalStep === "cell-03-calibration", "provider authorization next step mismatch");
  assert(cell03.status === "authorized_for_future_metadata_preparation_only", "provider authorization Cell 03 status mismatch");
  assert(cell03.providerExecutionAllowedInB11be === false, "provider authorization must not allow Cell 03 in B-11be");
  assert(cell03.requiresSeparateProviderExecutionStory === true, "provider authorization must require a separate execution story");
  assert(cell03.requiresNonzeroBudgetApproval === false, "provider authorization must not require nonzero budget approval");
  assert(cell03.requiresBoundedExecutionEnvelope === true, "provider authorization must require bounded execution envelope");
  assert(
    cell03.requiresPostflightProviderReportedUsageAccounting === true,
    "provider authorization must require postflight provider usage accounting",
  );
  assert(cell03.executionEvidencePresent === false, "provider authorization must not claim execution evidence");

  const lock = authorization.sequencing?.realCell03DerivedBudgetOrUsageLock || {};
  assert(lock.present === false, "provider authorization must not claim real Cell 03-derived budget/usage lock");
  assert(lock.sourceCell === "03", "provider authorization lock source mismatch");
  assert(lock.appliesToCell === "06", "provider authorization lock target mismatch");
  assert(lock.m0ExampleBudgetLockAcceptedAsFormalEvidence === false, "M0 example lock must not count as formal evidence");
  assertCell06Blocked(authorization.sequencing?.cell06A2primeGate, "provider authorization Cell 06 gate");
  assert(
    authorization.sequencing?.cell06A2primeGate?.matchingRealUsageLockPresent !== true,
    "provider authorization must not claim matching real usage lock",
  );
  assertHostLabelsRejected(authorization, "provider authorization");
  assert(authorization.claimBoundary?.hM1Proven === false, "provider authorization must not prove H-M1");
  assert(authorization.claimBoundary?.hM3Proven === false, "provider authorization must not prove H-M3");
  assert(authorization.claimBoundary?.modelAgnosticPaperClaimUnlocked === false, "provider authorization must not unlock paper claims");
  assert(authorization.claimBoundary?.productGateImpact === "none", "provider authorization claim boundary product impact mismatch");
}

function validateProviderLaunch(launch, envelope) {
  assert(launch.artifact === "m2-provider-execution-launch", "provider launch artifact mismatch");
  assert(launch.storyId === "B-6529", "provider launch storyId mismatch");
  assert(launch.status === "authorization_ready_execution_not_run", "provider launch status mismatch");
  assertBoundary(launch, "provider launch");
  assert(launch.launchState?.mode === "authorization_ready_execution_not_run", "provider launch mode mismatch");
  assert(launch.launchState?.cell03ExecutionEnvelopeFrozen === true, "provider launch must freeze Cell 03 envelope");
  assert(launch.authorization?.allRequiredMetadataPresent === true, "provider launch metadata must be ready");
  assert(launch.authorization?.preRunDollarGuessRequired === false, "provider launch must not require a pre-run dollar guess");
  assert(launch.authorization?.preRunDollarCapAsSoleGateAllowed === false, "provider launch must reject dollar cap as sole gate");
  assert(launch.authorization?.providerCallsFromThisAuthorizationStory === "disabled", "provider calls from this story must be disabled");

  const fields = byId(launch.authorization?.required, "fieldId");
  for (const fieldId of [
    "frozenExecutionEnvelope",
    "datedExecutorTargetSnapshot",
    "datedReviewerTargetSnapshot",
    "promptDigest",
    "toolSurfaceDigest",
    "runnerOwnership",
    "duplicatePolicy",
    "resultOutputPolicy",
    "postflightUsageAccountingPolicy",
    "providerCallEnablement",
  ]) {
    assert(fields.has(fieldId), `provider launch missing authorization field ${fieldId}`);
  }
  assert(fields.get("frozenExecutionEnvelope")?.value === CELL03_ENVELOPE_REF, "launch envelope field mismatch");
  assert(fields.get("promptDigest")?.value === EXPECTED_PROMPT_DIGEST, "launch prompt digest field mismatch");
  assert(fields.get("toolSurfaceDigest")?.value === EXPECTED_TOOL_SURFACE_DIGEST, "launch tool digest field mismatch");
  assert(fields.get("providerCallEnablement")?.status === "disabled_by_this_story", "provider call enablement must be disabled");
  assert(fields.get("providerCallEnablement")?.blocksProviderExecution === true, "provider call enablement must block execution");

  assert(launch.executionEnvelope?.recorded === true, "launch must record execution envelope");
  assert(launch.executionEnvelope?.artifactRef === CELL03_ENVELOPE_REF, "launch execution envelope ref mismatch");
  assert(launch.executionEnvelope?.taskCount === envelope.cellScope.taskCount, "launch envelope task count mismatch");
  assert(launch.executionEnvelope?.plannedRows === envelope.cellScope.plannedRows, "launch envelope row count mismatch");
  assert(launch.executionEnvelope?.promptDigest === EXPECTED_PROMPT_DIGEST, "launch envelope prompt digest mismatch");
  assert(launch.executionEnvelope?.toolSurfaceDigest === EXPECTED_TOOL_SURFACE_DIGEST, "launch envelope tool digest mismatch");
  assert(launch.executionEnvelope?.preRunDollarGuessRequired === false, "launch envelope must not require pre-run dollar guess");
  assert(launch.executionEnvelope?.providerCallEnabled === false, "launch envelope must keep provider calls disabled");

  assert(launch.usageAccounting?.policyRef === CELL03_USAGE_POLICY_REF, "launch usage policy ref mismatch");
  assert(launch.usageAccounting?.postflightProviderReportedUsageRequired === true, "launch must require postflight usage");
  assert(launch.usageAccounting?.estimateUse === "diagnostic_only", "launch estimate use must be diagnostic only");
  assert(launch.usageAccounting?.estimateMayBeFinalUsage === false, "launch estimate must not be final usage");
  assert(launch.usageAccounting?.estimateMayGateLaunch === false, "launch estimate must not gate launch");

  const guardrailRef = launch.guardrails?.cell03ProviderLaunchAuthorization || {};
  assert(guardrailRef.storyId === "B-6529", "Cell 03 guardrail story ref mismatch");
  assert(guardrailRef.status === "authorization_ready_execution_not_run", "Cell 03 guardrail ref status mismatch");
  assert(guardrailRef.executionEnvelopeFrozen === true, "Cell 03 guardrail ref must freeze envelope");
  assert(guardrailRef.preRunDollarGuessRequired === false, "Cell 03 guardrail ref must not require pre-run dollar guess");
  assert(guardrailRef.postflightProviderReportedUsageRequired === true, "Cell 03 guardrail ref must require postflight usage");
  assert(launch.sequencing?.nextPermittedFormalStep === "cell-03-calibration", "cell 03 must be next formal step");
  assert(launch.sequencing?.nextPermittedFormalStepMode === "authorization_ready_execution_not_run", "cell 03 must remain execution-not-run");
  assert(launch.sequencing?.cell03Calibration?.status === "authorization_ready_execution_not_run", "cell 03 sequencing status mismatch");
  assert(launch.sequencing?.cell03Calibration?.providerExecutionAllowed === false, "cell 03 provider execution must be disabled");
  assert(launch.sequencing?.realCell03DerivedBudgetLock?.present === false, "real Cell 03-derived budget lock must be absent");
  assertCell06Blocked(launch.sequencing?.cell06A2primeGate, "launch Cell 06 gate");

  assert(launch.runnerAuthorization?.providerCallEnabledRunnerCount === 0, "no provider-call enabled runners are allowed");
  assert(launch.runnerAuthorization?.resultRowsEnabledRunnerCount === 0, "no result-row enabled runners are allowed");
  for (const runner of launch.runnerAuthorization?.runners || []) {
    assert(runner.providerCallEnabled === false, `runner provider calls must stay disabled: ${runner.runnerId}`);
    assert(runner.eligibleForResultRows === false, `runner result rows must stay disabled: ${runner.runnerId}`);
    if (runner.runnerId === "m2-future-cell-03-e2-a4-same") {
      assert(runner.executorSnapshot === "openai-gpt-family-readiness-2026-07-05", "Cell 03 runner executor snapshot mismatch");
      assert(runner.reviewerSnapshot === "openai-gpt-family-readiness-2026-07-05", "Cell 03 runner reviewer snapshot mismatch");
      assert(runner.promptDigest === EXPECTED_PROMPT_DIGEST, "Cell 03 runner prompt digest mismatch");
      assert(runner.toolSurfaceDigest === EXPECTED_TOOL_SURFACE_DIGEST, "Cell 03 runner tool digest mismatch");
    }
    assert(!isHostLabel(runner.executorSnapshot), `${runner.runnerId}.executorSnapshot must not be a host label`);
    assert(!isHostLabel(runner.reviewerSnapshot), `${runner.runnerId}.reviewerSnapshot must not be a host label`);
  }
  assertHostLabelsRejected(launch, "provider launch");
}

function validateCell03Guardrail(guardrail, envelope) {
  assert(guardrail.artifact === "m2-cell03-provider-launch-authorization", "Cell 03 guardrail artifact mismatch");
  assert(guardrail.storyId === "B-6529", "Cell 03 guardrail storyId mismatch");
  assert(guardrail.status === "authorization_ready_execution_not_run", "Cell 03 guardrail status mismatch");
  assertBoundary(guardrail, "Cell 03 guardrail");
  assert(guardrail.executionEnvelopeRef === CELL03_ENVELOPE_REF, "Cell 03 guardrail envelope ref mismatch");
  assert(guardrail.usageAccountingPolicyRef === CELL03_USAGE_POLICY_REF, "Cell 03 guardrail usage policy ref mismatch");
  assert(guardrail.resultWritePolicyRef === CELL03_RESULT_POLICY_REF, "Cell 03 guardrail result policy ref mismatch");
  assert(guardrail.guardrailBoundary?.executionEnvelopeFrozen === true, "Cell 03 guardrail must freeze envelope");
  assert(guardrail.guardrailBoundary?.preRunDollarGuessRequired === false, "Cell 03 guardrail must not require a pre-run dollar guess");
  assert(guardrail.guardrailBoundary?.preRunDollarCapAsSoleGateAllowed === false, "Cell 03 guardrail must reject dollar cap as sole gate");
  assert(guardrail.executionEnvelope?.status === "frozen", "Cell 03 embedded envelope status mismatch");
  assert(guardrail.executionEnvelope?.artifactRef === CELL03_ENVELOPE_REF, "Cell 03 embedded envelope ref mismatch");
  assert(guardrail.executionEnvelope?.taskCount === envelope.cellScope.taskCount, "Cell 03 envelope task count mismatch");
  assert(guardrail.executionEnvelope?.plannedRows === envelope.cellScope.plannedRows, "Cell 03 envelope planned rows mismatch");
  assert(guardrail.executionEnvelope?.maxTotalOutputRows === envelope.limits.maxTotalOutputRows, "Cell 03 envelope output bound mismatch");
  assert(guardrail.executionEnvelope?.promptDigest === EXPECTED_PROMPT_DIGEST, "Cell 03 prompt digest mismatch");
  assert(guardrail.executionEnvelope?.toolSurfaceDigest === EXPECTED_TOOL_SURFACE_DIGEST, "Cell 03 tool digest mismatch");

  const preRun = guardrail.preRunDollarBudget || {};
  assert(preRun.guessRequired === false, "Cell 03 pre-run dollar guess must not be required");
  assert(preRun.dollarApprovalRequiredAsLaunchGate === false, "Cell 03 dollar approval must not be a launch gate");
  assert(preRun.amount === null, "Cell 03 pre-run dollar amount must remain null");
  assert(preRun.currency === null, "Cell 03 pre-run dollar currency must remain null");
  assert(preRun.estimateUse === "diagnostic_only", "Cell 03 estimate use must be diagnostic only");
  assert(preRun.estimateMayBeFinalUsage === false, "Cell 03 estimate must not be final usage");
  assert(preRun.estimateMayGateLaunch === false, "Cell 03 estimate must not gate launch");

  const usage = guardrail.postflightUsageAccounting || {};
  assert(usage.providerReportedUsageRequiredAfterExecution === true, "Cell 03 provider-reported usage must be required");
  assert(usage.finalUsageSource === "provider_reported_usage", "Cell 03 final usage source mismatch");
  assert(usage.estimateMayBeFinalUsage === false, "Cell 03 postflight estimate must not be final usage");
  assert(usage.estimateMayGateLaunch === false, "Cell 03 postflight estimate must not gate launch");

  const fields = byId(guardrail.requiredMetadata, "fieldId");
  for (const fieldId of [
    "frozenExecutionEnvelope",
    "datedExecutorTargetSnapshot",
    "datedReviewerTargetSnapshot",
    "promptDigest",
    "toolSurfaceDigest",
    "runnerOwnership",
    "duplicatePolicy",
    "resultOutputPolicy",
    "postflightUsageAccountingPolicy",
    "providerCallEnablement",
  ]) {
    assert(fields.has(fieldId), `Cell 03 guardrail missing metadata ${fieldId}`);
  }
  assert(fields.get("providerCallEnablement")?.status === "disabled_by_this_story", "Cell 03 provider call enablement must be disabled");
  assert(fields.get("providerCallEnablement")?.blocksProviderExecution === true, "Cell 03 provider call enablement must block execution");

  assertTargetSnapshot(guardrail.snapshotMetadata?.datedExecutorTargetSnapshot, "Cell 03 executor target snapshot");
  assertTargetSnapshot(guardrail.snapshotMetadata?.datedReviewerTargetSnapshot, "Cell 03 reviewer target snapshot");
  assert(guardrail.runnerOwnershipGuard?.ownershipRecorded === true, "Cell 03 runner ownership must be recorded");
  assert(guardrail.runnerOwnershipGuard?.runnerId === "m2-future-cell-03-e2-a4-same", "Cell 03 runner ownership mismatch");
  assert(guardrail.runnerOwnershipGuard?.duplicateOwnershipAllowed === false, "Cell 03 duplicate ownership must be rejected");
  assert(guardrail.sequencing?.nextPermittedFormalStep === "cell-03-calibration", "Cell 03 guardrail next step mismatch");
  assert(guardrail.sequencing?.cell03Calibration?.status === "authorization_ready_execution_not_run", "Cell 03 guardrail sequencing status mismatch");
  assert(guardrail.sequencing?.cell03Calibration?.providerExecutionAllowed === false, "Cell 03 guardrail must keep execution disabled");
  assertCell06Blocked(guardrail.sequencing?.cell06A2primeGate, "Cell 03 guardrail Cell 06 gate");
  assertHostLabelsRejected(guardrail, "Cell 03 guardrail");
}

function validateSnapshotLock(snapshotLock) {
  assertBoundary(snapshotLock, "snapshot lock");
  assert(snapshotLock.snapshotReadinessBoundary?.providerExecutionLocked === false, "snapshot lock must not claim provider execution lock");
  assert(snapshotLock.snapshotReadinessBoundary?.providerRunMetadataPresent === false, "snapshot lock must not claim provider run metadata");
  for (const family of snapshotLock.modelFamilies || []) {
    assert(!isHostLabel(family.providerFamily), `${family.familyId} provider family must not be a host label`);
    assert(family.hostKindIsModelFamily === false, `${family.familyId} host kind must not be model family`);
    assert(family.providerCallsEnabled === false, `${family.familyId} provider calls must be disabled`);
    assert(family.formalPhase1UseAllowed === false, `${family.familyId} formal Phase 1 must be disabled`);
  }
  const target = snapshotLock.cell03ExecutionTargetSnapshots || {};
  assert(target.status === "target_snapshots_frozen_execution_not_run", "Cell 03 target snapshot status mismatch");
  assert(target.appliesToEnvelopeRef === CELL03_ENVELOPE_REF, "Cell 03 target snapshot envelope ref mismatch");
  assertTargetSnapshot(target.executorTargetSnapshot, "snapshot lock Cell 03 executor target");
  assertTargetSnapshot(target.reviewerTargetSnapshot, "snapshot lock Cell 03 reviewer target");
}

function validateRunnerManifest(manifest) {
  assertBoundary(manifest, "runner manifest");
  const binding = manifest.cell03ExecutionEnvelopeBinding || {};
  assert(binding.status === "authorization_ready_execution_not_run", "runner manifest Cell 03 envelope status mismatch");
  assert(binding.artifactRef === CELL03_ENVELOPE_REF, "runner manifest Cell 03 envelope ref mismatch");
  assert(binding.runnerId === "m2-future-cell-03-e2-a4-same", "runner manifest Cell 03 runner mismatch");
  assert(binding.plannedRows === 1152, "runner manifest Cell 03 rows mismatch");
  assert(binding.providerCallEnabled === false, "runner manifest Cell 03 provider calls must be disabled");
  assert(binding.eligibleForResultRows === false, "runner manifest Cell 03 result rows must be disabled");
  const cell03 = (manifest.phase1Cells || []).find((cell) => cell.runnerId === "m2-future-cell-03-e2-a4-same");
  assert(cell03?.executionStatus === "authorization_ready_execution_not_run", "Cell 03 manifest execution status mismatch");
  assert(cell03?.executionEnvelopeRef === CELL03_ENVELOPE_REF, "Cell 03 manifest envelope ref mismatch");
  const cell06 = (manifest.phase1Cells || []).find((cell) => cell.runnerId === "m2-future-cell-06-e2-a2prime");
  assert(cell06?.executionStatus === "blocked_until_real_③_A4_budget_lock", "Cell 06 must remain blocked in manifest");
  assert(cell06?.providerExecutionAllowedInM2 === false, "Cell 06 provider execution must remain disabled");
  for (const runner of manifest.runners || []) {
    assert(runner.providerCallEnabled === false, `manifest runner provider calls must be disabled: ${runner.runnerId}`);
    assert(runner.eligibleForResultRows === false, `manifest runner result rows must be disabled: ${runner.runnerId}`);
    assert(!isHostLabel(runner.providerModelFamily), `manifest runner provider family must not be host label: ${runner.runnerId}`);
  }
  assert(manifest.a2PrimeGateBinding?.currentlyBlocked === true, "manifest A2prime must remain blocked");
  assert(manifest.a2PrimeGateBinding?.executionAllowedBeforeBudgetLock === false, "manifest A2prime execution must stay disabled");
  assert(manifest.a2PrimeGateBinding?.matchingBudgetLockPresent === false, "manifest A2prime must not claim budget lock");
}

function validateExistingReadiness(launchReadiness, phase1Readiness) {
  assert(launchReadiness.authorizationBoundary?.providerExecutionAuthorized === false, "M2 readiness must not authorize provider execution");
  assert(launchReadiness.authorizationBoundary?.providerCallEnabled === false, "M2 readiness must keep provider calls disabled");
  const readinessChecks = byId(phase1Readiness.readinessChecks, "checkId");
  const calibration = readinessChecks.get("③-a4-calibration");
  assert(calibration?.status === "pending_execution", "Cell 03 calibration must remain pending execution");
  assert(calibration?.executionEvidencePresent === false, "Cell 03 calibration must not have execution evidence");
  const budgetLock = readinessChecks.get("real-budget-lock");
  assert(budgetLock?.realBudgetLockPresent === false, "real budget lock must remain absent");
  const a2prime = readinessChecks.get("⑥-a2prime-sequencing");
  assert(a2prime?.status === "blocked_until_real_budget_lock", "Cell 06 must remain blocked in readiness");
  assert(a2prime?.executionAllowed === false, "Cell 06 execution must remain disabled in readiness");
}

function validateStatus(statusText) {
  for (const [key, value] of Object.entries(CHECKER_RESEARCH_BOUNDARY)) {
    assert(statusText.includes(`${key}=${JSON.stringify(value)}`), `status missing ${key}=${JSON.stringify(value)}`);
  }
  for (const requiredLine of [
    "| M2 provider execution launch gate | PREPARED |",
    "| Cell 03 execution envelope | FROZEN |",
    "| Cell 03 usage accounting | POSTFLIGHT REQUIRED |",
    "| Cell 03 launch guardrail | RECORDED |",
    "| Formal M2 execution | NOT STARTED |",
    "| ③ A4 calibration | PENDING EXECUTION |",
    "| ⑥ A2prime | BLOCKED |",
    "Cell 03 execution envelope: frozen",
    "Pre-run dollar guess: not required",
    "Provider calls from this authorization story: disabled",
    "Postflight usage accounting: provider-reported usage required after execution",
    "Cell 06 A2prime: blocked",
  ]) {
    assert(statusText.includes(requiredLine), `status missing text: ${requiredLine}`);
  }
  assert(statusText.includes("providerExecutionAuthorized=false"), "status must report providerExecutionAuthorized=false");
  assert(statusText.includes("providerCallEnabled=false"), "status must report providerCallEnabled=false");
  assert(statusText.includes("no claim unlock"), "status must state no claim unlock");
  assert(statusText.includes("no product gate impact"), "status must state no product gate impact");
}

function validateAll(artifacts) {
  for (const [name, doc] of Object.entries({
    m2LaunchReadiness: artifacts.m2LaunchReadiness,
    snapshots: artifacts.snapshots,
    runnerManifest: artifacts.runnerManifest,
    phase1Readiness: artifacts.phase1Readiness,
    providerLaunch: artifacts.providerLaunch,
    providerAuthorization: artifacts.providerAuthorization,
    cell03LaunchGuardrail: artifacts.cell03LaunchGuardrail,
    cell03Envelope: artifacts.cell03Envelope,
  })) {
    assertBoundary(doc, name);
    assertNoOutcomeOrRecordsPath(doc, name);
  }
  for (const [name, doc] of Object.entries({
    providerLaunch: artifacts.providerLaunch,
    providerAuthorization: artifacts.providerAuthorization,
    cell03LaunchGuardrail: artifacts.cell03LaunchGuardrail,
    cell03Envelope: artifacts.cell03Envelope,
  })) {
    assertNoOldBudgetGateKeys(doc, name);
  }
  for (const [name, doc] of Object.entries({
    providerLaunch: artifacts.providerLaunch,
    providerAuthorization: artifacts.providerAuthorization,
    cell03LaunchGuardrail: artifacts.cell03LaunchGuardrail,
    cell03Envelope: artifacts.cell03Envelope,
    usagePolicy: artifacts.usagePolicy,
    resultWritePolicy: artifacts.resultWritePolicy,
    toolSurface: artifacts.toolSurface,
    runnerManifest: artifacts.runnerManifest,
  })) {
    assertNoEnabledProviderCalls(doc, name);
    assertNoOutcomeOrRecordsPath(doc, name);
  }
  assertNoRecordsFileExists();
  validateEnvelope(artifacts.cell03Envelope, artifacts.promptText, artifacts.toolSurfaceText);
  validateUsagePolicy(artifacts.usagePolicy);
  validateResultPolicy(artifacts.resultWritePolicy);
  validateToolSurface(artifacts.toolSurface);
  validateProviderAuthorization(artifacts.providerAuthorization);
  validateProviderLaunch(artifacts.providerLaunch, artifacts.cell03Envelope);
  validateCell03Guardrail(artifacts.cell03LaunchGuardrail, artifacts.cell03Envelope);
  validateSnapshotLock(artifacts.snapshots);
  validateRunnerManifest(artifacts.runnerManifest);
  validateExistingReadiness(artifacts.m2LaunchReadiness, artifacts.phase1Readiness);
  validateStatus(artifacts.status);
}

function loadArtifacts() {
  const promptText = readText(paths.prompt);
  const toolSurfaceText = readText(paths.toolSurface);
  return {
    m2LaunchReadiness: readJson(paths.m2LaunchReadiness),
    snapshots: readJson(paths.snapshots),
    runnerManifest: readJson(paths.runnerManifest),
    phase1Readiness: readJson(paths.phase1Readiness),
    providerLaunch: readJson(paths.providerLaunch),
    providerAuthorization: readJson(paths.providerAuthorization),
    cell03LaunchGuardrail: readJson(paths.cell03LaunchGuardrail),
    cell03Envelope: readJson(paths.cell03Envelope),
    usagePolicy: readJson(paths.usagePolicy),
    promptText,
    toolSurfaceText,
    toolSurface: JSON.parse(toolSurfaceText),
    resultWritePolicy: readJson(paths.resultWritePolicy),
    status: readText(paths.status),
  };
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
  "missing envelope bounds",
  (artifacts) => {
    delete artifacts.cell03Envelope.limits.maxTotalOutputRows;
  },
  /output row bound/,
);

expectReject(
  "pre-run dollar cap as sole gate",
  (artifacts) => {
    artifacts.providerLaunch.authorization.preRunDollarCapAsSoleGateAllowed = true;
  },
  /dollar cap as sole gate/,
);

expectReject(
  "old exact budget gate restored",
  (artifacts) => {
    artifacts.cell03LaunchGuardrail.exactBudgetApproval = { status: "present", amount: 25, currency: "USD" };
  },
  /old budget gate key exactBudgetApproval/,
);

expectReject(
  "metadata authorization resurrects nonzero budget cap",
  (artifacts) => {
    artifacts.providerAuthorization.requiredFutureExecutionMetadata.push({
      fieldId: "nonzeroProviderBudgetCap",
      status: "still_required_for_real_provider_execution",
      value: null,
      blocksProviderExecution: true,
    });
  },
  /must not require nonzeroProviderBudgetCap/,
);

expectReject(
  "metadata authorization restores providerBudgetCap",
  (artifacts) => {
    artifacts.providerAuthorization.authorizationBoundary.providerBudgetCap = {
      currency: "USD",
      amount: 20,
      providerSpendAllowed: false,
    };
  },
  /providerBudgetCap as a future launch cap/,
);

expectReject(
  "estimate treated as final usage",
  (artifacts) => {
    artifacts.usagePolicy.postflightUsageAccounting.estimateMayBeFinalUsage = true;
  },
  /estimate must not be final usage/,
);

expectReject(
  "provider calls enabled in this story",
  (artifacts) => {
    artifacts.providerLaunch.launchState.providerCallEnabled = true;
  },
  /providerCallEnabled must remain false/,
);

expectReject(
  "host label snapshot in envelope",
  (artifacts) => {
    artifacts.cell03Envelope.targetSnapshots.executorTargetSnapshot.snapshotId = "Codex CLI";
  },
  /must not be a host label|snapshot id mismatch/,
);

expectReject(
  "Cell 06 unblocked",
  (artifacts) => {
    artifacts.providerLaunch.sequencing.cell06A2primeGate.state = "ready";
    artifacts.providerLaunch.sequencing.cell06A2primeGate.blocked = false;
    artifacts.providerLaunch.sequencing.cell06A2primeGate.executionAllowed = true;
  },
  /Cell 06 gate state mismatch|must be blocked|execution must be disabled/,
);

expectReject(
  "prompt digest drift",
  (artifacts) => {
    artifacts.cell03Envelope.promptArtifact.sha256 = "sha256:" + "0".repeat(64);
  },
  /prompt digest/,
);

expectReject(
  "tool-surface digest drift",
  (artifacts) => {
    artifacts.cell03Envelope.toolSurfaceArtifact.sha256 = "sha256:" + "0".repeat(64);
  },
  /tool-surface digest/,
);

expectReject(
  "result rows added",
  (artifacts) => {
    artifacts.cell03LaunchGuardrail.resultRows = [{ score: 1 }];
  },
  /forbidden result\/outcome data field/,
);

console.log(
  `M2 provider execution checker passed: ${assertionCount} assertions; ${negativeControlRejectCount} negative controls rejected`,
);
console.log("Cell 03 execution envelope: frozen");
console.log("Pre-run dollar guess: not required");
console.log("Provider calls from this authorization story: disabled");
console.log("Postflight usage accounting: provider-reported usage required after execution");
console.log("Cell 06 A2prime: blocked");
console.log("Provider execution remains disabled; no provider calls made; no outcome records present");
