#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const probeRoot = path.join(repoRoot, "experiments/multi-model-ablation/future-cell03-results/probe");
const rowsPath = path.join(probeRoot, "probe-rows.jsonl");
const summaryPath = path.join(probeRoot, "probe-summary.json");

const WINDOW_ID = "B-991d-cell03-execution-window-001";
const STORY_ID = "B-991d";
const RUNNER_ID = "m2-future-cell-03-e2-a4-same";
const SNAPSHOT_ID = "openai-gpt-family-readiness-2026-07-05";
const PROMPT_DIGEST = "sha256:b1f7c70a48cf2f2c12b99bedb0f0d4259bfe334276ebf27cd1164903d33a5fa6";
const TOOL_DIGEST = "sha256:c42696e2c4b36d0d1a85656000a0fc63bc5aee7158361a1f4da1279afc50beb9";
const TASK_DIGEST = "sha256:344845e8b2d4d974544fbd182c4061eff958350388133c0d08cfaa0aae4cedd4";
const CODEX_MODEL_ID = "gpt-5.5";
const PROVIDER_VISIBLE_TASK_FILES = Object.freeze(["prompt.md", "acceptance.mjs", "task.json"]);
const PROVIDER_HIDDEN_TASK_FILES = Object.freeze([
  "ground-truth.mjs",
  "reference-solution.mjs",
  "subtle-wrong-output.mjs",
  "payload-subtle.mjs",
]);

let assertions = 0;
let negativeControls = 0;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  assertions++;
}

function readRows() {
  assert(fs.existsSync(rowsPath), "probe rows file missing");
  return fs.readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function validateRow(row) {
  assert(row.cellNumber === "03", "row must be Cell 03");
  assert(row.arm === "A4", "row arm mismatch");
  assert(row.cellKey === `③|A4|${row.taskId}|${row.scenarioId}|${row.repeatIndex}|E2|same`, "cell key mismatch");
  assert(row.taskInventoryArtifact === "experiments/multi-model-ablation/task-inventory.m2.json", "task inventory ref mismatch");
  assert(row.taskInventoryDigest === TASK_DIGEST, "task inventory digest mismatch");
  assert(row.runnerId === RUNNER_ID, "runner mismatch");
  assert(row.executionWindowId === WINDOW_ID, "window mismatch");
  assert(row.executionStoryId === STORY_ID, "story mismatch");
  assert(row.executorFamily === "E2", "executor family mismatch");
  assert(row.reviewerFamily === "same", "reviewer family mismatch");
  assert(row.executorSnapshotId === SNAPSHOT_ID, "executor snapshot mismatch");
  assert(row.reviewerSnapshotId === SNAPSHOT_ID, "reviewer snapshot mismatch");
  assert(row.providerConfiguredModelId === CODEX_MODEL_ID, "configured provider model mismatch");
  assert(row.promptDigest === PROMPT_DIGEST, "prompt digest mismatch");
  assert(row.toolSurfaceDigest === TOOL_DIGEST, "tool digest mismatch");
  assert(typeof row.providerResponseDigest === "string" && row.providerResponseDigest.startsWith("sha256:"), "provider digest missing");
  assert(typeof row.executorResponseDigest === "string" && row.executorResponseDigest.startsWith("sha256:"), "executor digest missing");
  assert(row.retrySupersession?.attemptIndex === 1, "attempt index mismatch");
  assert(row.retrySupersession?.retryOfRowId === null, "unexpected retry source");
  assert(row.provenance?.contractStoryId === STORY_ID, "contract story mismatch");
  assert(row.provenance?.executionStoryId === STORY_ID, "provenance story mismatch");
  assert(row.provenance?.executionWindowId === WINDOW_ID, "provenance window mismatch");
  assert(row.provenance?.contractVersion === "cell03-formal-row-v1", "contract version mismatch");
  assert(row.probe?.workspacePolicy?.providerCwdKind === "external_scratch", "provider workspace must be external scratch");
  assert(row.probe?.workspacePolicy?.parentRepoRulesVisible === false, "parent repo rules must not be visible to provider workspace");
  assert(row.probe?.workspacePolicy?.hiddenOracleFilesVisible === false, "hidden oracle files must not be visible to provider workspace");
  assert(
    JSON.stringify(row.probe?.workspacePolicy?.visibleTaskFiles) === JSON.stringify(PROVIDER_VISIBLE_TASK_FILES),
    "visible task files mismatch",
  );
  assert(
    JSON.stringify(row.probe?.workspacePolicy?.hiddenTaskFiles) === JSON.stringify(PROVIDER_HIDDEN_TASK_FILES),
    "hidden task files mismatch",
  );
  assert(
    typeof row.probe?.workspacePolicy?.artifactWorkspace === "string" &&
      row.probe.workspacePolicy.artifactWorkspace.startsWith("experiments/multi-model-ablation/future-cell03-results/probe/workspaces/"),
    "artifact workspace path mismatch",
  );
  const artifactWorkspace = path.join(repoRoot, row.probe.workspacePolicy.artifactWorkspace);
  for (const visible of PROVIDER_VISIBLE_TASK_FILES) {
    assert(fs.existsSync(path.join(artifactWorkspace, visible)), `artifact workspace missing visible file ${visible}`);
  }
  for (const hidden of PROVIDER_HIDDEN_TASK_FILES) {
    assert(!fs.existsSync(path.join(artifactWorkspace, hidden)), `artifact workspace exposes hidden file ${hidden}`);
  }
  assert(["final", "failed", "retried", "superseded", "void"].includes(row.rowStatus), "invalid row status");
  assert(
    ["completed", "recovered", "safe-stop", "amplified", "failed", "review-invalid"].includes(row.adjudicatedOutcome),
    "invalid adjudicated outcome",
  );
  assert(row.checks?.acceptance, "acceptance check missing");
  assert(row.checks?.groundTruth, "ground truth check missing");
  for (const checkName of ["acceptance", "groundTruth"]) {
    const check = row.checks[checkName];
    assert(Number.isInteger(check.exitCode) || check.exitCode === null, `${checkName} exit code missing`);
    assert(typeof check.stdoutDigest === "string" && check.stdoutDigest.startsWith("sha256:"), `${checkName} stdout digest missing`);
    assert(typeof check.stderrDigest === "string" && check.stderrDigest.startsWith("sha256:"), `${checkName} stderr digest missing`);
  }
  if (row.rowStatus === "final") {
    assert(row.formal === true, "final row must be formal");
    assert(row.usable === true, "final row must be usable");
    assert(row.providerReportedUsage, "final row must carry provider usage");
    assert(row.executorReportedUsage, "final row must carry executor usage");
    assert(row.reviewGate, "final row must carry review gate");
    assert(row.reviewGate.required === true, "review gate must be required");
    assert(row.reviewGate.ran === true, "review gate must have run");
    assert(row.reviewGate.freshContext === true, "review gate must use fresh context");
    assert(row.reviewGate.reviewerFamily === "same", "reviewer family must be same");
    assert(row.reviewGate.providerName === "openai", "review provider mismatch");
    assert(row.reviewGate.providerModelId === CODEX_MODEL_ID, "review provider model mismatch");
    assert(row.reviewGate.providerConfiguredModelId === CODEX_MODEL_ID, "review configured model mismatch");
    assert(["SHIP", "BLOCK"].includes(row.reviewGate.verdict), "invalid review verdict");
    assert(typeof row.reviewGate.responseDigest === "string" && row.reviewGate.responseDigest.startsWith("sha256:"), "review response digest missing");
    assert(row.reviewGate.reportedUsage, "reviewer usage missing");
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "providerName", "providerModelId", "reportedAt"]) {
      assert(Object.prototype.hasOwnProperty.call(row.providerReportedUsage, key), `usage missing ${key}`);
    }
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "providerName", "providerModelId", "reportedAt"]) {
      assert(Object.prototype.hasOwnProperty.call(row.executorReportedUsage, key), `executor usage missing ${key}`);
      assert(Object.prototype.hasOwnProperty.call(row.reviewGate.reportedUsage, key), `review usage missing ${key}`);
    }
    assert(row.providerReportedUsage.providerModelId === CODEX_MODEL_ID, "usage provider model mismatch");
    assert(row.providerReportedUsage.providerModelIdSource !== "host_label", "usage provider model must not come from a host label");
    assert(row.executorReportedUsage.providerModelId === CODEX_MODEL_ID, "executor usage provider model mismatch");
    assert(row.reviewGate.reportedUsage.providerModelId === CODEX_MODEL_ID, "review usage provider model mismatch");
    assert(
      row.providerReportedUsage.inputTokens === row.executorReportedUsage.inputTokens + row.reviewGate.reportedUsage.inputTokens,
      "aggregate input usage mismatch",
    );
    assert(
      row.providerReportedUsage.outputTokens === row.executorReportedUsage.outputTokens + row.reviewGate.reportedUsage.outputTokens,
      "aggregate output usage mismatch",
    );
    assert(
      row.providerReportedUsage.totalTokens === row.executorReportedUsage.totalTokens + row.reviewGate.reportedUsage.totalTokens,
      "aggregate total usage mismatch",
    );
    assert(row.reviewGate.verdict === "SHIP", "probe final rows must ship through reviewer");
    assert(row.checks.acceptance.exitCode === 0, "probe final rows must pass acceptance");
    assert(row.checks.groundTruth.exitCode === 0, "probe final rows must pass ground truth");
    assert(row.validationPass === true, "probe final rows must set validationPass");
  } else {
    assert(row.formal === false, "non-final row must be non-formal");
    assert(row.usable === false, "non-final row must be unusable");
  }
}

function expectReject(label, mutate, pattern) {
  const rows = readRows().map((row) => JSON.parse(JSON.stringify(row)));
  mutate(rows);
  const before = assertions;
  try {
    validateRows(rows);
  } catch (error) {
    assertions = before;
    assert(pattern.test(error.message), `${label} rejected with wrong error: ${error.message}`);
    negativeControls++;
    return;
  }
  assertions = before;
  fail(`negative control was not rejected: ${label}`);
}

function validateRows(rows) {
  assert(rows.length === 2, "probe must contain exactly two rows");
  const keys = new Set();
  for (const row of rows) {
    assert(!keys.has(row.cellKey), `duplicate cell key ${row.cellKey}`);
    keys.add(row.cellKey);
    validateRow(row);
  }
}

const rows = readRows();
validateRows(rows);

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
assert(summary.storyId === STORY_ID, "summary story mismatch");
assert(summary.executionWindowId === WINDOW_ID, "summary window mismatch");
assert(summary.rowCount === rows.length, "summary row count mismatch");
assert(summary.finalRows === rows.filter((row) => row.rowStatus === "final").length, "summary final count mismatch");
assert(summary.failedRows === rows.filter((row) => row.rowStatus !== "final").length, "summary failed count mismatch");
assert(summary.providerUsageRows === rows.filter((row) => row.providerReportedUsage).length, "summary usage count mismatch");
assert(summary.reviewedRows === rows.filter((row) => ["SHIP", "BLOCK"].includes(row.reviewGate?.verdict)).length, "summary reviewed count mismatch");
assert(summary.groundTruthPassRows === rows.filter((row) => row.checks?.groundTruth?.exitCode === 0).length, "summary ground truth count mismatch");
assert(summary.totalProviderUsage?.totalTokens === rows.reduce((sum, row) => sum + (row.providerReportedUsage?.totalTokens ?? 0), 0), "summary total usage mismatch");
assert(
  summary.fullRunUnlocked === rows.every((row) =>
    row.rowStatus === "final" &&
    row.providerReportedUsage &&
    row.executorReportedUsage &&
    row.reviewGate?.reportedUsage &&
    row.reviewGate?.verdict === "SHIP" &&
    row.validationPass === true
  ),
  "summary unlock mismatch",
);

const failedProbeSimulation = rows.map((row) => JSON.parse(JSON.stringify(row)));
failedProbeSimulation[0].rowStatus = "failed";
failedProbeSimulation[0].formal = false;
failedProbeSimulation[0].usable = false;
delete failedProbeSimulation[0].providerReportedUsage;
assert(
  failedProbeSimulation.every((row) => row.rowStatus === "final" && row.providerReportedUsage) === false,
  "failed probe simulation must not unlock full run",
);

expectReject("duplicate cell key", (mut) => { mut[1].cellKey = mut[0].cellKey; }, /duplicate cell key/);
expectReject("Cell 06 row", (mut) => { mut[0].cellNumber = "06"; }, /Cell 03/);
expectReject("missing B-991d provenance", (mut) => { mut[0].executionStoryId = "B-6529"; }, /story mismatch/);
expectReject("missing provider usage on final row", (mut) => { mut[0].rowStatus = "final"; delete mut[0].providerReportedUsage; }, /provider usage/);
expectReject("fallback runner", (mut) => { mut[0].runnerId = "m2-future-cell-06-e2-a2prime"; }, /runner mismatch/);
expectReject("missing reviewer snapshot", (mut) => { mut[0].reviewerSnapshotId = null; }, /reviewer snapshot mismatch/);
expectReject("provider workspace sees parent repo rules", (mut) => { mut[0].probe.workspacePolicy.parentRepoRulesVisible = true; }, /parent repo rules/);
expectReject("provider workspace sees hidden oracle files", (mut) => { mut[0].probe.workspacePolicy.hiddenOracleFilesVisible = true; }, /hidden oracle/);
expectReject("hidden file listed as visible", (mut) => { mut[0].probe.workspacePolicy.visibleTaskFiles.push("ground-truth.mjs"); }, /visible task files/);
expectReject("missing review gate", (mut) => { delete mut[0].reviewGate; }, /review gate/);
expectReject("reviewer family drift", (mut) => { mut[0].reviewGate.reviewerFamily = "cross"; }, /reviewer family/);
expectReject("invalid review verdict", (mut) => { mut[0].reviewGate.verdict = "MAYBE"; }, /review verdict/);
expectReject("missing reviewer usage", (mut) => { delete mut[0].reviewGate.reportedUsage; }, /reviewer usage/);
expectReject("reviewer context not fresh", (mut) => { mut[0].reviewGate.freshContext = false; }, /fresh context/);
expectReject("missing ground truth", (mut) => { delete mut[0].checks.groundTruth; }, /ground truth/);

console.log(`Cell 03 probe validator passed: ${assertions} assertions; ${negativeControls} negative controls rejected`);
console.log(`rows=${summary.rowCount} finalRows=${summary.finalRows} failedRows=${summary.failedRows} providerUsageRows=${summary.providerUsageRows}`);
console.log(`fullRunUnlocked=${summary.fullRunUnlocked}`);
