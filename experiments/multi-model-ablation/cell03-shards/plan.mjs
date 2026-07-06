#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MULTI_MODEL_ROOT = path.resolve(__dirname, "..");
const DEFAULT_ROOT = path.resolve(MULTI_MODEL_ROOT, "..", "..");

export const CELL03_SHARD_SCHEMA = "cell03-shard-plan-v1";
export const CELL03_ROW_SCHEMA = "cell03-shard-row-v1";
export const CELL03_SHARD_MANIFEST_SCHEMA = "cell03-shard-manifest-v1";
export const DEFAULT_EXECUTION_WINDOW_ID = "cell03-shards-fixture-window-v1";

const rel = {
  seedManifest: "experiments/multi-model-ablation/seed-manifest.m1.json",
  taskInventory: "experiments/multi-model-ablation/task-inventory.m2.json",
  cellMatrix: "experiments/multi-model-ablation/cell-matrix.m1.json",
  envelope: "experiments/multi-model-ablation/m2-cell03-execution-envelope.json",
};

export function sha256Text(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

export function sha256File(filePath) {
  return sha256Text(fs.readFileSync(filePath, "utf8"));
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function repoPath(root, relativePath) {
  return path.join(root, relativePath);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildCell03Binding(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const envelope = readJson(repoPath(root, rel.envelope));
  const taskInventory = readJson(repoPath(root, rel.taskInventory));
  const seedManifest = readJson(repoPath(root, rel.seedManifest));
  const cellMatrix = readJson(repoPath(root, rel.cellMatrix));

  const promptPath = envelope.promptArtifact?.path;
  const toolPath = envelope.toolSurfaceArtifact?.path;
  if (!promptPath || !toolPath) throw new Error("Cell03 envelope is missing prompt/tool artifacts");

  const promptDigest = sha256File(repoPath(root, promptPath));
  const toolSurfaceDigest = sha256File(repoPath(root, toolPath));
  if (promptDigest !== envelope.promptArtifact.sha256) {
    throw new Error(`prompt digest drift: expected ${envelope.promptArtifact.sha256}, got ${promptDigest}`);
  }
  if (toolSurfaceDigest !== envelope.toolSurfaceArtifact.sha256) {
    throw new Error(`tool-surface digest drift: expected ${envelope.toolSurfaceArtifact.sha256}, got ${toolSurfaceDigest}`);
  }
  if (taskInventory.corpusDigest !== envelope.cellScope.taskInventoryDigest) {
    throw new Error(`task inventory digest drift: expected ${envelope.cellScope.taskInventoryDigest}, got ${taskInventory.corpusDigest}`);
  }
  if (seedManifest.protocolDigest !== envelope.protocolDigest || cellMatrix.protocolDigest !== envelope.protocolDigest) {
    throw new Error("protocol digest drift between Cell03 envelope, seed manifest, and cell matrix");
  }

  return {
    schema: CELL03_SHARD_SCHEMA,
    protocolDigest: envelope.protocolDigest,
    taskInventoryDigest: taskInventory.corpusDigest,
    seedManifestId: seedManifest.artifact,
    seedManifestStoryId: seedManifest.storyId,
    cellMatrixId: cellMatrix.artifact,
    executionEnvelopeRef: rel.envelope,
    promptDigest,
    toolSurfaceDigest,
    runnerId: options.runnerId || envelope.cellScope.runnerId,
    executionWindowId: options.executionWindowId || DEFAULT_EXECUTION_WINDOW_ID,
    executorSnapshot: options.executorSnapshot || envelope.targetSnapshots.executorTargetSnapshot.snapshotId,
    reviewerSnapshot: options.reviewerSnapshot || envelope.targetSnapshots.reviewerTargetSnapshot.snapshotId,
    snapshotDate: envelope.targetSnapshots.snapshotDate,
    cellNumber: envelope.cellScope.protocolCellNumber,
    cellNumberAscii: envelope.cellScope.cellNumber,
    arm: envelope.cellScope.arm,
    executorFamily: envelope.cellScope.executorFamily,
    reviewerFamily: envelope.cellScope.reviewerFamily,
  };
}

export function expectedCell03Rows(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const binding = options.binding || buildCell03Binding({ root, ...options });
  const seedManifest = readJson(repoPath(root, rel.seedManifest));
  const taskInventory = readJson(repoPath(root, rel.taskInventory));

  const scenarioSlots = seedManifest.planningDimensions?.scenarioSlots?.slotIds || [];
  const repeatSlots = seedManifest.planningDimensions?.repeatSlots?.slotIds || [];
  const tasks = [...(taskInventory.tasks || [])].sort((a, b) => a.ordinal - b.ordinal);
  if (tasks.length !== 24) throw new Error(`expected 24 tasks, got ${tasks.length}`);
  if (scenarioSlots.length !== 16) throw new Error(`expected 16 scenario slots, got ${scenarioSlots.length}`);
  if (repeatSlots.length !== 3) throw new Error(`expected 3 repeat slots, got ${repeatSlots.length}`);

  const rows = [];
  let orderedIndex = 0;
  for (const task of tasks) {
    for (const scenarioSlot of scenarioSlots) {
      for (const repeatSlot of repeatSlots) {
        const taskSlot = task.m1TaskSlot;
        const cellKey = [
          binding.cellNumber,
          binding.arm,
          taskSlot,
          scenarioSlot,
          repeatSlot,
          binding.executorFamily,
          binding.reviewerFamily,
        ].join("|");
        const seedInput = [
          binding.protocolDigest,
          binding.cellNumber,
          taskSlot,
          scenarioSlot,
          repeatSlot,
        ].join("|");
        rows.push({
          cellKey,
          orderedIndex,
          rowSeed: sha256Text(seedInput),
          taskId: task.taskId,
          taskSlot,
          scenarioSlot,
          repeatSlot,
          contentDigest: task.contentDigest,
        });
        orderedIndex += 1;
      }
    }
  }
  if (rows.length !== 1152) throw new Error(`expected 1152 Cell03 rows, got ${rows.length}`);
  return rows;
}

export function assertShardArgs(shardCount, shardIndex = 0) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error(`invalid shardCount: ${shardCount}`);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`invalid shardIndex ${shardIndex}; expected 0 <= shardIndex < ${shardCount}`);
  }
}

export function buildShardPlan(options = {}) {
  const shardCount = Number(options.shardCount ?? 1);
  assertShardArgs(shardCount, options.shardIndex == null ? 0 : Number(options.shardIndex));
  const binding = buildCell03Binding(options);
  const rows = expectedCell03Rows({ ...options, binding });
  const allExpectedCellKeyDigest = sha256Text(rows.map((row) => row.cellKey).join("\n"));
  const shards = Array.from({ length: shardCount }, (_, shardIndex) => {
    const shardRows = rows.filter((row) => row.orderedIndex % shardCount === shardIndex);
    return {
      shardIndex,
      shardCount,
      rowCount: shardRows.length,
      firstCellKey: shardRows[0]?.cellKey || null,
      lastCellKey: shardRows.at(-1)?.cellKey || null,
      expectedCellKeyDigest: sha256Text(shardRows.map((row) => row.cellKey).join("\n")),
      rows: options.includeRows ? shardRows : undefined,
    };
  });
  const totalRows = shards.reduce((sum, shard) => sum + shard.rowCount, 0);
  const uniqueRows = new Set(rows.map((row) => row.cellKey)).size;
  if (totalRows !== rows.length || uniqueRows !== rows.length) {
    throw new Error(`invalid shard coverage: total=${totalRows}, unique=${uniqueRows}, expected=${rows.length}`);
  }
  return {
    schema: CELL03_SHARD_SCHEMA,
    binding,
    shardCount,
    totalRows,
    uniqueRows,
    allExpectedCellKeyDigest,
    shards,
  };
}

export function rowsForShard(options = {}) {
  const shardCount = Number(options.shardCount ?? 1);
  const shardIndex = Number(options.shardIndex ?? 0);
  assertShardArgs(shardCount, shardIndex);
  const binding = buildCell03Binding(options);
  return expectedCell03Rows({ ...options, binding }).filter((row) => row.orderedIndex % shardCount === shardIndex);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--includeRows") args.includeRows = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const plan = buildShardPlan({
    shardCount: Number(args.shards || args.shardCount || 1),
    includeRows: Boolean(args.includeRows),
    executionWindowId: args.executionWindowId,
    runnerId: args.runnerId,
  });
  const output = {
    schema: plan.schema,
    shardCount: plan.shardCount,
    totalRows: plan.totalRows,
    uniqueRows: plan.uniqueRows,
    allExpectedCellKeyDigest: plan.allExpectedCellKeyDigest,
    binding: plan.binding,
    shards: plan.shards,
  };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Cell03 shard plan: shards=${plan.shardCount} rows=${plan.totalRows} unique=${plan.uniqueRows}`);
    console.log(`allExpectedCellKeyDigest=${plan.allExpectedCellKeyDigest}`);
  }
}
