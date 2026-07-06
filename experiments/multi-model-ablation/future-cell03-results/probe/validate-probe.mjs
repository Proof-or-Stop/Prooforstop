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
  assert(row.retrySupersession?.attemptIndex === 1, "attempt index mismatch");
  assert(row.retrySupersession?.retryOfRowId === null, "unexpected retry source");
  assert(row.provenance?.contractStoryId === STORY_ID, "contract story mismatch");
  assert(row.provenance?.executionStoryId === STORY_ID, "provenance story mismatch");
  assert(row.provenance?.executionWindowId === WINDOW_ID, "provenance window mismatch");
  assert(row.provenance?.contractVersion === "cell03-formal-row-v1", "contract version mismatch");
  assert(["final", "failed", "retried", "superseded", "void"].includes(row.rowStatus), "invalid row status");
  if (row.rowStatus === "final") {
    assert(row.formal === true, "final row must be formal");
    assert(row.usable === true, "final row must be usable");
    assert(row.providerReportedUsage, "final row must carry provider usage");
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "providerName", "providerModelId", "reportedAt"]) {
      assert(Object.prototype.hasOwnProperty.call(row.providerReportedUsage, key), `usage missing ${key}`);
    }
    assert(row.providerReportedUsage.providerModelId === CODEX_MODEL_ID, "usage provider model mismatch");
    assert(row.providerReportedUsage.providerModelIdSource !== "host_label", "usage provider model must not come from a host label");
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
assert(summary.fullRunUnlocked === rows.every((row) => row.rowStatus === "final" && row.providerReportedUsage), "summary unlock mismatch");

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

console.log(`Cell 03 probe validator passed: ${assertions} assertions; ${negativeControls} negative controls rejected`);
console.log(`rows=${summary.rowCount} finalRows=${summary.finalRows} failedRows=${summary.failedRows} providerUsageRows=${summary.providerUsageRows}`);
console.log(`fullRunUnlocked=${summary.fullRunUnlocked}`);
