#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const experimentRoot = path.join(repoRoot, "experiments/multi-model-ablation");
const fullRoot = path.join(experimentRoot, "future-cell03-results/full");
const artifactWorkspaceRoot = path.join(fullRoot, "workspaces");
const scratchWorkspaceRoot = process.env.B991D_CELL03_SCRATCH_ROOT ||
  path.join(os.tmpdir(), "proof-or-stop-b991d-cell03-full");
const rowsPath = path.join(fullRoot, "cell03-rows.jsonl");
const summaryPath = path.join(fullRoot, "cell03-summary.json");
const expectedManifestPath = path.join(fullRoot, "expected-cell03-keys.json");
const parallelRoot = path.join(fullRoot, "parallel");
const parallelClaimRoot = path.join(parallelRoot, "claims");
const parallelShardRoot = path.join(parallelRoot, "shards");

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
const PROTOCOL_DIGEST = "sha256:4eddb3ff30682a5c2ec3a5b5c81f1dd36b63e9d5bf73bcfda77ee845291317d2";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function argValue(flag, defaultValue = null) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return defaultValue;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sanitizeId(value) {
  ensure(/^[A-Za-z0-9._-]{1,80}$/.test(value), "runner instance id must be 1-80 chars of A-Z a-z 0-9 . _ -");
  return value;
}

function readExistingRows() {
  if (!fs.existsSync(rowsPath)) return [];
  return fs.readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readRowsFrom(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function shardRowsPath(runnerInstanceId) {
  return path.join(parallelShardRoot, `cell03-rows.${runnerInstanceId}.jsonl`);
}

function readShardRows() {
  if (!fs.existsSync(parallelShardRoot)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(parallelShardRoot).sort()) {
    if (!entry.startsWith("cell03-rows.") || !entry.endsWith(".jsonl")) continue;
    for (const row of readRowsFrom(path.join(parallelShardRoot, entry))) {
      rows.push(row);
    }
  }
  return rows;
}

function readPlanningRows() {
  return [...readExistingRows(), ...readShardRows()];
}

function safeEnv() {
  const keep = ["PATH", "HOME", "USER", "TMPDIR", "SHELL", "CODEX_HOME", "LANG", "LC_ALL"];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsage(item);
      if (found) return found;
    }
    return null;
  }
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  if (
    (own(value, "prompt_tokens") || own(value, "completion_tokens") || own(value, "total_tokens")) ||
    (own(value, "input_tokens") || own(value, "output_tokens") || own(value, "total_tokens")) ||
    (own(value, "inputTokens") || own(value, "outputTokens") || own(value, "totalTokens"))
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    const found = findUsage(child);
    if (found) return found;
  }
  return null;
}

function findModel(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModel(item);
      if (found) return found;
    }
    return null;
  }
  for (const key of ["model", "model_id", "modelId"]) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findModel(child);
    if (found) return found;
  }
  return null;
}

function normalizeUsage(raw, modelId) {
  if (!raw) return null;
  const inputTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens);
  const outputTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? (inputTokens + outputTokens));
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    providerName: "openai",
    providerModelId: modelId || CODEX_MODEL_ID,
    providerModelIdSource: modelId ? "codex_jsonl" : "codex_cli_arg",
    reportedAt: new Date().toISOString(),
  };
}

function parseCodexJsonl(stdout) {
  let usage = null;
  let model = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      usage ??= findUsage(parsed);
      model ??= findModel(parsed);
    } catch {
      // Non-JSON lines are ignored; the response digest still binds them.
    }
  }
  return { usage: normalizeUsage(usage, model), model };
}

function parseReviewerVerdict(stdout) {
  const match = stdout.match(/VERDICT:\s*(SHIP|BLOCK)\b/i);
  if (!match) return "INVALID";
  return match[1].toUpperCase();
}

function combineUsage(executorUsage, reviewerUsage) {
  if (!executorUsage || !reviewerUsage) return null;
  return {
    inputTokens: executorUsage.inputTokens + reviewerUsage.inputTokens,
    outputTokens: executorUsage.outputTokens + reviewerUsage.outputTokens,
    totalTokens: executorUsage.totalTokens + reviewerUsage.totalTokens,
    providerName: "openai",
    providerModelId: CODEX_MODEL_ID,
    providerModelIdSource: "codex_cli_arg",
    reportedAt: new Date().toISOString(),
  };
}

function deriveCellSeed(taskSlot, scenarioSlot, repeatSlot) {
  return sha256(`${PROTOCOL_DIGEST}|③|${taskSlot}|${scenarioSlot}|${repeatSlot}`);
}

function expectedCells(inventory, seedManifest) {
  const scenarioSlots = seedManifest.planningDimensions?.scenarioSlots?.slotIds ?? [];
  const repeatSlots = seedManifest.planningDimensions?.repeatSlots?.slotIds ?? [];
  ensure(scenarioSlots.length === 16, "seed manifest scenario slot count drift");
  ensure(repeatSlots.length === 3, "seed manifest repeat slot count drift");
  ensure(inventory.tasks.length === 24, "task inventory must contain 24 tasks");
  const cells = [];
  for (const task of inventory.tasks.slice().sort((a, b) => a.ordinal - b.ordinal)) {
    for (const scenarioSlot of scenarioSlots) {
      for (let repeatIndex = 1; repeatIndex <= repeatSlots.length; repeatIndex++) {
        const repeatSlot = repeatSlots[repeatIndex - 1];
        cells.push({
          taskId: task.taskId,
          taskSlot: task.m1TaskSlot,
          scenarioId: scenarioSlot,
          repeatIndex,
          repeatSlot,
          cellSeed: deriveCellSeed(task.m1TaskSlot, scenarioSlot, repeatSlot),
        });
      }
    }
  }
  cells.sort((a, b) => a.cellSeed.localeCompare(b.cellSeed));
  return cells;
}

function copyTaskWorkspace(task, workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const fileName of PROVIDER_VISIBLE_TASK_FILES) {
    fs.copyFileSync(path.join(repoRoot, task.path, fileName), path.join(workspace, fileName));
  }
  fs.rmSync(path.join(workspace, "solution.mjs"), { force: true });
}

async function applyScenarioInjection(cell, task, workspace) {
  if (cell.scenarioId === "scenario-null") {
    return {
      applied: false,
      scenarioId: cell.scenarioId,
      injector: null,
      result: null,
      solutionDigestAfterInjection: fs.existsSync(path.join(workspace, "solution.mjs"))
        ? sha256(fs.readFileSync(path.join(workspace, "solution.mjs")))
        : null,
    };
  }
  const injectorPath = path.join(repoRoot, task.path, "subtle-wrong-output.mjs");
  ensure(fs.existsSync(injectorPath), `missing injector for ${task.taskId}`);
  const taskJson = JSON.parse(fs.readFileSync(path.join(repoRoot, task.path, "task.json"), "utf8"));
  const before = fs.existsSync(path.join(workspace, taskJson.outputFile))
    ? sha256(fs.readFileSync(path.join(workspace, taskJson.outputFile)))
    : null;
  const mod = await import(`${pathToFileUrl(injectorPath)}?b991d=${Date.now()}-${Math.random()}`);
  ensure(mod.default && typeof mod.default.inject === "function", `invalid injector for ${task.taskId}`);
  const result = mod.default.inject(workspace, taskJson);
  const outputPath = path.join(workspace, taskJson.outputFile);
  ensure(fs.existsSync(outputPath), `injector did not create ${taskJson.outputFile} for ${task.taskId}`);
  const after = sha256(fs.readFileSync(outputPath));
  ensure(before !== after, `injector made no material change for ${task.taskId}/${cell.scenarioId}`);
  return {
    applied: true,
    scenarioId: cell.scenarioId,
    injector: "subtle-wrong-output.mjs",
    result,
    solutionDigestAfterInjection: after,
  };
}

function pathToFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function taskPrompt(task) {
  return fs.readFileSync(path.join(repoRoot, task.path, "prompt.md"), "utf8");
}

function promptForCell(cell, task) {
  const scenarioLine = cell.scenarioId === "scenario-null"
    ? "This is the null scenario: no starting solution is provided unless you create one."
    : `This is recovery scenario ${cell.scenarioId}: solution.mjs may already contain an injected subtle defect. Repair it without reading hidden oracle files.`;
  return [
    "You are executing one Proof-or-Stop B-991d Cell 03 full-run row.",
    "Only solve the task in the current working directory.",
    "Create or modify only solution.mjs. Do not edit any other file.",
    scenarioLine,
    "Do not run Cell 02, Cell 04, Cell 06, Phase 2, or any optional cell.",
    `cellKey: ③|A4|${cell.taskId}|${cell.scenarioId}|${cell.repeatIndex}|E2|same`,
    `executionWindowId: ${WINDOW_ID}`,
    `executionStoryId: ${STORY_ID}`,
    `runnerId: ${RUNNER_ID}`,
    `executorSnapshotId: ${SNAPSHOT_ID}`,
    `reviewerSnapshotId: ${SNAPSHOT_ID}`,
    `promptDigest: ${PROMPT_DIGEST}`,
    `toolSurfaceDigest: ${TOOL_DIGEST}`,
    "",
    taskPrompt(task),
  ].join("\n");
}

function reviewerPromptForCell(cell) {
  return [
    "You are the independent same-family reviewer for one Proof-or-Stop B-991d Cell 03 A4 full-run row.",
    "Do not edit files. Review only the current working directory.",
    "Read prompt.md and solution.mjs. Decide whether the submitted solution should ship for this task.",
    "Return the first line exactly as either `VERDICT: SHIP` or `VERDICT: BLOCK`.",
    "After the first line, add one concise reason.",
    "Do not run Cell 02, Cell 04, Cell 06, Phase 2, or any optional cell.",
    `cellKey: ③|A4|${cell.taskId}|${cell.scenarioId}|${cell.repeatIndex}|E2|same`,
    `executionWindowId: ${WINDOW_ID}`,
    `executionStoryId: ${STORY_ID}`,
    `runnerId: ${RUNNER_ID}`,
    `reviewerSnapshotId: ${SNAPSHOT_ID}`,
    `promptDigest: ${PROMPT_DIGEST}`,
    `toolSurfaceDigest: ${TOOL_DIGEST}`,
  ].join("\n");
}

function runNodeCheck(workspace, scriptPath) {
  const out = spawnSync("node", [scriptPath, workspace], {
    cwd: workspace,
    env: safeEnv(),
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    exitCode: out.status,
    timedOut: out.signal === "SIGTERM" || out.signal === "SIGKILL",
    stdoutDigest: sha256(out.stdout || ""),
    stderrDigest: sha256(out.stderr || ""),
    stdoutBytes: Buffer.byteLength(out.stdout || ""),
    stderrBytes: Buffer.byteLength(out.stderr || ""),
  };
}

function runAcceptance(workspace) {
  return runNodeCheck(workspace, path.join(workspace, "acceptance.mjs"));
}

function runGroundTruth(task, workspace) {
  return runNodeCheck(workspace, path.join(repoRoot, task.path, "ground-truth.mjs"));
}

function runExecutor(cell, task, workspace) {
  const prompt = promptForCell(cell, task);
  const started = Date.now();
  const out = spawnSync(
    "codex",
    [
      "-a",
      "never",
      "-m",
      CODEX_MODEL_ID,
      "-s",
      "workspace-write",
      "-C",
      workspace,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      prompt,
    ],
    {
      cwd: workspace,
      env: safeEnv(),
      input: "",
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const durationMs = Date.now() - started;
  const stdout = out.stdout || "";
  const stderr = out.stderr || "";
  const parsed = parseCodexJsonl(stdout);
  return {
    exitCode: out.status,
    timedOut: out.signal === "SIGTERM" || out.signal === "SIGKILL",
    spawnError: out.error?.code === "ENOENT",
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    durationMs,
    reportedUsage: parsed.usage,
    model: parsed.model,
  };
}

function runReviewer(cell, workspace) {
  const prompt = reviewerPromptForCell(cell);
  const started = Date.now();
  const out = spawnSync(
    "codex",
    [
      "-a",
      "never",
      "-m",
      CODEX_MODEL_ID,
      "-s",
      "read-only",
      "-C",
      workspace,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      prompt,
    ],
    {
      cwd: workspace,
      env: safeEnv(),
      input: "",
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const durationMs = Date.now() - started;
  const stdout = out.stdout || "";
  const stderr = out.stderr || "";
  const parsed = parseCodexJsonl(stdout);
  return {
    exitCode: out.status,
    timedOut: out.signal === "SIGTERM" || out.signal === "SIGKILL",
    spawnError: out.error?.code === "ENOENT",
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    durationMs,
    reportedUsage: parsed.usage,
    model: parsed.model,
    verdict: parseReviewerVerdict(stdout),
  };
}

function adjudicate({ executorOk, reviewerOk, acceptanceOk, groundTruthOk, reviewerVerdict, scenarioId }) {
  if (!executorOk) return "failed";
  if (!reviewerOk || reviewerVerdict === "INVALID") return "review-invalid";
  if (reviewerVerdict === "BLOCK") return "safe-stop";
  if (!acceptanceOk) return "safe-stop";
  if (!groundTruthOk) return "amplified";
  return scenarioId === "scenario-null" ? "completed" : "recovered";
}

function rowFor(cell, task, executor, reviewer, acceptance, groundTruth, injection, attemptIndex, previousRowId) {
  const cellKey = cellKeyFor(cell);
  const executorOk = executor.exitCode === 0 && !executor.timedOut && !executor.spawnError;
  const reviewerOk = reviewer.exitCode === 0 && !reviewer.timedOut && !reviewer.spawnError && ["SHIP", "BLOCK"].includes(reviewer.verdict);
  const providerUsage = combineUsage(executor.reportedUsage, reviewer.reportedUsage);
  const hasUsage = !!providerUsage;
  const acceptanceOk = acceptance.exitCode === 0 && !acceptance.timedOut;
  const groundTruthOk = groundTruth.exitCode === 0 && !groundTruth.timedOut;
  const adjudicatedOutcome = adjudicate({
    executorOk,
    reviewerOk,
    acceptanceOk,
    groundTruthOk,
    reviewerVerdict: reviewer.verdict,
    scenarioId: cell.scenarioId,
  });
  const formalRow = executorOk && reviewerOk && hasUsage;
  const rowId = `B-991d-cell03-${cell.taskId}-${cell.scenarioId}-r${cell.repeatIndex}-a${attemptIndex}`;
  return {
    rowId,
    cellKey,
    cellNumber: "03",
    arm: "A4",
    taskId: cell.taskId,
    taskInventoryArtifact: "experiments/multi-model-ablation/task-inventory.m2.json",
    taskInventoryDigest: TASK_DIGEST,
    scenarioId: cell.scenarioId,
    repeatIndex: cell.repeatIndex,
    runnerId: RUNNER_ID,
    executionWindowId: WINDOW_ID,
    executionStoryId: STORY_ID,
    executorFamily: "E2",
    reviewerFamily: "same",
    executorSnapshotId: SNAPSHOT_ID,
    reviewerSnapshotId: SNAPSHOT_ID,
    providerConfiguredModelId: CODEX_MODEL_ID,
    promptArtifact: "experiments/multi-model-ablation/m2-cell03-execution-prompt.md",
    promptDigest: PROMPT_DIGEST,
    toolSurfaceArtifact: "experiments/multi-model-ablation/m2-cell03-tool-surface.json",
    toolSurfaceDigest: TOOL_DIGEST,
    providerResponseDigest: sha256(`${executor.stdoutDigest}\n${reviewer.stdoutDigest}`),
    executorResponseDigest: executor.stdoutDigest,
    executorReportedUsage: executor.reportedUsage,
    providerReportedUsage: providerUsage,
    rowStatus: formalRow ? "final" : "failed",
    formal: formalRow,
    usable: formalRow,
    validationPass: acceptanceOk && groundTruthOk && reviewer.verdict === "SHIP",
    adjudicatedOutcome,
    reviewGate: {
      required: true,
      ran: true,
      freshContext: true,
      reviewerFamily: "same",
      providerName: "openai",
      providerModelId: CODEX_MODEL_ID,
      providerConfiguredModelId: CODEX_MODEL_ID,
      providerModelIdFromCli: reviewer.model ?? null,
      verdict: reviewer.verdict,
      responseDigest: reviewer.stdoutDigest,
      stderrDigest: reviewer.stderrDigest,
      stdoutBytes: reviewer.stdoutBytes,
      stderrBytes: reviewer.stderrBytes,
      durationMs: reviewer.durationMs,
      exitCode: reviewer.exitCode,
      timedOut: reviewer.timedOut,
      spawnError: reviewer.spawnError,
      reportedUsage: reviewer.reportedUsage,
    },
    checks: {
      acceptance,
      groundTruth,
    },
    retrySupersession: {
      attemptIndex,
      retryOfRowId: previousRowId,
      supersedesRowId: null,
      supersededByRowId: null,
      supersessionReason: previousRowId ? "retry_after_nonformal_or_failed_attempt" : null,
    },
    injection,
    fullRun: {
      taskPath: task.path,
      taskContentDigest: task.contentDigest,
      providerExitCode: executor.exitCode,
      providerTimedOut: executor.timedOut,
      providerSpawnError: executor.spawnError,
      providerStdoutDigest: executor.stdoutDigest,
      providerStderrDigest: executor.stderrDigest,
      providerStdoutBytes: executor.stdoutBytes,
      providerStderrBytes: executor.stderrBytes,
      providerDurationMs: executor.durationMs,
      providerModelFromCli: executor.model ?? null,
      workspacePolicy: executor.workspacePolicy,
    },
    provenance: {
      contractStoryId: STORY_ID,
      contractArtifact: "experiments/multi-model-ablation/m2-cell03-result-write-policy.json",
      contractVersion: "cell03-formal-row-v1",
      sourceEnvelopeRef: "experiments/multi-model-ablation/m2-cell03-execution-envelope.json",
      executionStoryId: STORY_ID,
      executionWindowId: WINDOW_ID,
      createdAt: new Date().toISOString(),
      createdBy: "codex-main",
    },
  };
}

function isProviderUnavailable(row) {
  if (row.providerReportedUsage) return false;
  return (
    row.fullRun?.providerExitCode !== 0 ||
    row.fullRun?.providerTimedOut ||
    row.fullRun?.providerSpawnError ||
    row.reviewGate?.exitCode !== 0 ||
    row.reviewGate?.timedOut ||
    row.reviewGate?.spawnError
  );
}

function cellKeyFor(cell) {
  return `③|A4|${cell.taskId}|${cell.scenarioId}|${cell.repeatIndex}|E2|same`;
}

function claimDigest(cellKey) {
  return crypto.createHash("sha256").update(cellKey).digest("hex");
}

function claimCell(cellKey, runnerInstanceId, ttlMs) {
  fs.mkdirSync(parallelClaimRoot, { recursive: true });
  const claimDir = path.join(parallelClaimRoot, claimDigest(cellKey));
  const claimPath = path.join(claimDir, "claim.json");
  const now = Date.now();
  try {
    fs.mkdirSync(claimDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const claim = JSON.parse(fs.readFileSync(claimPath, "utf8"));
      stale = Number.isFinite(Date.parse(claim.createdAt)) && now - Date.parse(claim.createdAt) > ttlMs;
    } catch {
      stale = true;
    }
    if (!stale) return null;
    fs.rmSync(claimDir, { recursive: true, force: true });
    fs.mkdirSync(claimDir);
  }
  const claim = {
    artifact: "B-991d-cell03-row-claim",
    storyId: STORY_ID,
    executionWindowId: WINDOW_ID,
    runnerId: RUNNER_ID,
    runnerInstanceId,
    cellKey,
    createdAt: new Date(now).toISOString(),
    claimTtlMs: ttlMs,
  };
  fs.writeFileSync(claimPath, JSON.stringify(claim, null, 2) + "\n");
  return { claimDir, claim };
}

function releaseClaim(claim) {
  if (claim) fs.rmSync(claim.claimDir, { recursive: true, force: true });
}

function writeExpectedManifest(cells) {
  const manifest = {
    artifact: "B-991d-cell03-expected-keys",
    storyId: STORY_ID,
    executionWindowId: WINDOW_ID,
    expectedRows: cells.length,
    ordering: "sha256(protocolDigest|③|taskSlot|scenarioSlot|repeatSlot) ascending",
    createdAt: new Date().toISOString(),
    cells: cells.map((cell) => ({
      cellKey: cellKeyFor(cell),
      taskId: cell.taskId,
      taskSlot: cell.taskSlot,
      scenarioId: cell.scenarioId,
      repeatIndex: cell.repeatIndex,
      repeatSlot: cell.repeatSlot,
      cellSeed: cell.cellSeed,
    })),
  };
  if (fs.existsSync(expectedManifestPath)) {
    const existing = JSON.parse(fs.readFileSync(expectedManifestPath, "utf8"));
    if (JSON.stringify(existing.cells) === JSON.stringify(manifest.cells)) return;
  }
  fs.writeFileSync(expectedManifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function assertMergeSafe(rows) {
  const rowsById = new Map();
  const attemptsByCell = new Map();
  const finalByCell = new Map();
  for (const row of rows) {
    const prior = rowsById.get(row.rowId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new Error(`conflicting duplicate rowId: ${row.rowId}`);
    }
    if (prior) continue;
    rowsById.set(row.rowId, row);
    const attempts = attemptsByCell.get(row.cellKey) ?? 0;
    attemptsByCell.set(row.cellKey, attempts + 1);
    if (attempts + 1 > 2) throw new Error(`too many attempts for cell key: ${row.cellKey}`);
    if (row.rowStatus === "final") {
      const final = finalByCell.get(row.cellKey);
      if (final && final.rowId !== row.rowId) throw new Error(`duplicate final row for cell key: ${row.cellKey}`);
      finalByCell.set(row.cellKey, row);
    }
  }
}

function mergeShards(cells) {
  const mainRows = readExistingRows();
  const mainByRowId = new Map(mainRows.map((row) => [row.rowId, row]));
  const rowsToAppend = [];
  for (const shardRow of readShardRows()) {
    const existing = mainByRowId.get(shardRow.rowId);
    if (existing) {
      ensure(JSON.stringify(existing) === JSON.stringify(shardRow), `conflicting already-merged rowId: ${shardRow.rowId}`);
      continue;
    }
    rowsToAppend.push(shardRow);
  }
  const mergedRows = [...mainRows, ...rowsToAppend];
  assertMergeSafe(mergedRows);
  if (rowsToAppend.length) {
    fs.writeFileSync(rowsPath, mergedRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.rmSync(parallelShardRoot, { recursive: true, force: true });
  }
  const summary = summarizeRows(cells, mergedRows, rowsToAppend);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Merged ${rowsToAppend.length} shard row(s) into ${path.relative(repoRoot, rowsPath)}`);
  console.log(`finalRows=${summary.finalRows}/${summary.expectedRows} terminalExhaustedRows=${summary.terminalExhaustedRows} pendingExecutableRows=${summary.pendingExecutableRows} failedRows=${summary.failedRows} providerUsageRows=${summary.providerUsageRows}`);
  if (!summary.executionComplete) process.exitCode = 2;
}

function summarizeRows(cells, rows, newRows) {
  const finalRows = rows.filter((row) => row.rowStatus === "final");
  const finalKeys = new Set(finalRows.map((row) => row.cellKey));
  const rowsByCell = new Map();
  for (const row of rows) {
    const attempts = rowsByCell.get(row.cellKey) ?? [];
    attempts.push(row);
    rowsByCell.set(row.cellKey, attempts);
  }
  const expectedKeys = cells.map(cellKeyFor);
  const missingFinalKeys = expectedKeys.filter((cellKey) => !finalKeys.has(cellKey));
  const terminalExhaustedKeys = missingFinalKeys.filter((cellKey) => (rowsByCell.get(cellKey) ?? []).length >= 2);
  const pendingExecutableKeys = missingFinalKeys.filter((cellKey) => (rowsByCell.get(cellKey) ?? []).length < 2);
  const executionComplete = pendingExecutableKeys.length === 0;
  const formalComplete = missingFinalKeys.length === 0 && finalRows.length === cells.length;
  return {
    artifact: "B-991d-cell03-full-summary",
    storyId: STORY_ID,
    executionWindowId: WINDOW_ID,
    expectedRows: cells.length,
    rowCount: rows.length,
    finalRows: finalRows.length,
    formalFinalRows: finalRows.length,
    terminalExhaustedRows: terminalExhaustedKeys.length,
    pendingExecutableRows: pendingExecutableKeys.length,
    failedRows: rows.filter((row) => row.rowStatus !== "final").length,
    validationPassRows: rows.filter((row) => row.validationPass).length,
    providerUsageRows: rows.filter((row) => row.providerReportedUsage).length,
    reviewedRows: rows.filter((row) => row.reviewGate?.verdict === "SHIP" || row.reviewGate?.verdict === "BLOCK").length,
    groundTruthPassRows: rows.filter((row) => row.checks?.groundTruth?.exitCode === 0).length,
    outcomeCounts: rows.reduce((acc, row) => {
      acc[row.adjudicatedOutcome] = (acc[row.adjudicatedOutcome] ?? 0) + 1;
      return acc;
    }, {}),
    missingFinalRows: missingFinalKeys.length,
    missingFinalCellKeys: missingFinalKeys.slice(0, 50),
    terminalExhaustedCellKeys: terminalExhaustedKeys.slice(0, 50),
    pendingExecutableCellKeys: pendingExecutableKeys.slice(0, 50),
    newRowsThisRun: newRows.length,
    totalProviderUsage: rows.reduce((acc, row) => {
      if (!row.providerReportedUsage) return acc;
      acc.inputTokens += row.providerReportedUsage.inputTokens;
      acc.outputTokens += row.providerReportedUsage.outputTokens;
      acc.totalTokens += row.providerReportedUsage.totalTokens;
      return acc;
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    complete: executionComplete,
    executionComplete,
    formalComplete,
    fullRunUnlockReason: "CHK-006 completes when every expected Cell 03 cell key has either one final formal row or an auditable retry-exhausted terminal non-final row; only final formal rows count toward analysis.",
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  const force = process.argv.includes("--force");
  const dryRun = hasFlag("--dryRun");
  const refreshSummary = hasFlag("--refreshSummary");
  const mergeOnly = hasFlag("--mergeShards");
  const runnerInstanceRaw = argValue("--runnerInstanceId", null);
  const runnerInstanceId = runnerInstanceRaw == null ? null : sanitizeId(runnerInstanceRaw);
  const shardIndexRaw = argValue("--shardIndex", null);
  const shardCountRaw = argValue("--shardCount", null);
  const claimTtlMsRaw = argValue("--claimTtlMs", "7200000");
  const claimTtlMs = Number(claimTtlMsRaw);
  const limitRaw = argValue("--limit", null);
  const limit = limitRaw == null ? null : Number(limitRaw);
  if (limitRaw != null) ensure(Number.isInteger(limit) && limit > 0, "--limit must be a positive integer");
  ensure(Number.isInteger(claimTtlMs) && claimTtlMs >= 600000, "--claimTtlMs must be an integer >= 600000");
  const parallelMode = runnerInstanceId != null || shardIndexRaw != null || shardCountRaw != null;
  if (parallelMode) {
    ensure(runnerInstanceId != null, "--runnerInstanceId is required for parallel mode");
    ensure(shardIndexRaw != null && shardCountRaw != null, "--shardIndex and --shardCount are required for parallel mode");
  }
  const shardIndex = shardIndexRaw == null ? null : Number(shardIndexRaw);
  const shardCount = shardCountRaw == null ? null : Number(shardCountRaw);
  if (parallelMode) {
    ensure(Number.isInteger(shardIndex) && Number.isInteger(shardCount), "--shardIndex and --shardCount must be integers");
    ensure(shardCount >= 2 && shardCount <= 16, "--shardCount must be between 2 and 16");
    ensure(shardIndex >= 0 && shardIndex < shardCount, "--shardIndex must be in [0, shardCount)");
    ensure(!force, "--force is not allowed in parallel mode");
    ensure(!refreshSummary, "--refreshSummary is not allowed in parallel mode");
    ensure(!mergeOnly, "--mergeShards cannot be combined with parallel mode");
  }
  if (!force && (fs.existsSync(rowsPath) || fs.existsSync(summaryPath))) {
    // Existing rows are resumable. The runner skips final cell keys and retries failed keys
    // only up to the row-contract limit.
  }
  if (force) {
    fs.rmSync(rowsPath, { force: true });
    fs.rmSync(summaryPath, { force: true });
    fs.rmSync(expectedManifestPath, { force: true });
    fs.rmSync(artifactWorkspaceRoot, { recursive: true, force: true });
  }
  ensure(sha256(readText("experiments/multi-model-ablation/m2-cell03-execution-prompt.md")) === PROMPT_DIGEST, "prompt digest drift");
  ensure(sha256(readText("experiments/multi-model-ablation/m2-cell03-tool-surface.json")) === TOOL_DIGEST, "tool-surface digest drift");
  const inventory = readJson("experiments/multi-model-ablation/task-inventory.m2.json");
  const seedManifest = readJson("experiments/multi-model-ablation/seed-manifest.m1.json");
  ensure(inventory.corpusDigest === TASK_DIGEST, "task inventory digest drift");
  const tasksById = new Map(inventory.tasks.map((task) => [task.taskId, task]));
  const cells = expectedCells(inventory, seedManifest);
  ensure(cells.length === 1152, `expected 1152 Cell 03 rows, got ${cells.length}`);
  fs.mkdirSync(fullRoot, { recursive: true });
  fs.mkdirSync(artifactWorkspaceRoot, { recursive: true });
  fs.mkdirSync(scratchWorkspaceRoot, { recursive: true });
  writeExpectedManifest(cells);

  if (dryRun) {
    console.log(`Cell 03 full dry run: expectedRows=${cells.length}`);
    console.log(`Expected manifest: ${path.relative(repoRoot, expectedManifestPath)}`);
    if (parallelMode) console.log(`Parallel worker ${runnerInstanceId}: shard ${shardIndex}/${shardCount}`);
    return;
  }

  if (mergeOnly) {
    mergeShards(cells);
    return;
  }

  const existingRows = parallelMode ? readPlanningRows() : readExistingRows();
  const byCell = new Map();
  for (const row of existingRows) {
    const rows = byCell.get(row.cellKey) ?? [];
    rows.push(row);
    byCell.set(row.cellKey, rows);
  }
  if (refreshSummary) {
    const summary = summarizeRows(cells, existingRows, []);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    console.log(`Refreshed ${path.relative(repoRoot, summaryPath)}`);
    console.log(`finalRows=${summary.finalRows}/${summary.expectedRows} terminalExhaustedRows=${summary.terminalExhaustedRows} pendingExecutableRows=${summary.pendingExecutableRows}`);
    return;
  }

  const newRows = [];
  let attempted = 0;
  const candidateCells = parallelMode ? cells.filter((_, index) => index % shardCount === shardIndex) : cells;
  const outputRowsPath = parallelMode ? shardRowsPath(runnerInstanceId) : rowsPath;
  if (parallelMode) {
    fs.mkdirSync(parallelShardRoot, { recursive: true });
    console.log(`Parallel worker ${runnerInstanceId}: shard ${shardIndex}/${shardCount}, output=${path.relative(repoRoot, outputRowsPath)}`);
  }
  for (const cell of candidateCells) {
    if (limit != null && attempted >= limit) break;
    const cellKey = cellKeyFor(cell);
    const prior = byCell.get(cellKey) ?? [];
    if (prior.some((row) => row.rowStatus === "final")) continue;
    if (prior.length >= 2) continue;
    const claim = parallelMode ? claimCell(cellKey, runnerInstanceId, claimTtlMs) : null;
    if (parallelMode && !claim) continue;
    const task = tasksById.get(cell.taskId);
    ensure(task, `unknown task ${cell.taskId}`);
    const workspaceName = `${cell.taskId}-${cell.scenarioId}-r${cell.repeatIndex}`;
    const scratchWorkspaceName = parallelMode ? `${runnerInstanceId}-${workspaceName}` : workspaceName;
    const scratchWorkspace = path.join(scratchWorkspaceRoot, scratchWorkspaceName);
    const artifactWorkspace = path.join(artifactWorkspaceRoot, workspaceName);
    try {
      copyTaskWorkspace(task, scratchWorkspace);
      const injection = await applyScenarioInjection(cell, task, scratchWorkspace);
      const executor = runExecutor(cell, task, scratchWorkspace);
      const acceptance = runAcceptance(scratchWorkspace);
      const reviewer = runReviewer(cell, scratchWorkspace);
      const groundTruth = runGroundTruth(task, scratchWorkspace);
      executor.workspacePolicy = {
        providerCwdKind: "external_scratch",
        parentRepoRulesVisible: false,
        hiddenOracleFilesVisible: false,
        visibleTaskFiles: PROVIDER_VISIBLE_TASK_FILES,
        hiddenTaskFiles: PROVIDER_HIDDEN_TASK_FILES,
        artifactWorkspace: path.relative(repoRoot, artifactWorkspace),
      };
      const previousRowId = prior.length ? prior[prior.length - 1].rowId : null;
      const row = rowFor(cell, task, executor, reviewer, acceptance, groundTruth, injection, prior.length + 1, previousRowId);
      if (parallelMode) {
        row.provenance.createdBy = runnerInstanceId;
        row.provenance.parallelExecution = {
          runnerInstanceId,
          shardIndex,
          shardCount,
          claimArtifact: claim.claim.artifact,
        };
      }
      if (isProviderUnavailable(row)) {
        console.error(`[provider-unavailable] ${cellKey} executorExit=${row.fullRun.providerExitCode} reviewerExit=${row.reviewGate.exitCode}; row not written; stopping runner`);
        process.exitCode = 75;
        break;
      }
      fs.rmSync(artifactWorkspace, { recursive: true, force: true });
      fs.cpSync(scratchWorkspace, artifactWorkspace, { recursive: true });
      newRows.push(row);
      byCell.set(cellKey, [...prior, row]);
      fs.appendFileSync(outputRowsPath, JSON.stringify(row) + "\n");
      attempted += 1;
      console.log(`[${attempted}${limit ? `/${limit}` : ""}] ${cellKey} -> ${row.rowStatus}/${row.adjudicatedOutcome}`);
    } finally {
      releaseClaim(claim);
    }
  }

  if (parallelMode) {
    console.log(`Wrote ${newRows.length} shard row(s) to ${path.relative(repoRoot, outputRowsPath)}`);
    if (limit != null && newRows.length < limit && process.exitCode == null) process.exitCode = 2;
    return;
  }

  const rows = readExistingRows();
  const summary = summarizeRows(cells, rows, newRows);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Wrote ${newRows.length} new full row(s) to ${path.relative(repoRoot, rowsPath)}`);
  console.log(`finalRows=${summary.finalRows}/${summary.expectedRows} terminalExhaustedRows=${summary.terminalExhaustedRows} pendingExecutableRows=${summary.pendingExecutableRows} failedRows=${summary.failedRows} providerUsageRows=${summary.providerUsageRows}`);
  if (!summary.executionComplete) process.exitCode = 2;
}

main();
