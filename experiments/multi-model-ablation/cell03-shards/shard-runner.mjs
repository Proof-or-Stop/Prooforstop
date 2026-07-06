#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CELL03_ROW_SCHEMA,
  CELL03_SHARD_MANIFEST_SCHEMA,
  buildCell03Binding,
  buildShardPlan,
  canonicalJson,
  parseArgs,
  rowsForShard,
  sha256Text,
} from "./plan.mjs";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function shardDir(baseDir, shardCount, shardIndex) {
  return path.join(baseDir, `shard-${String(shardIndex).padStart(2, "0")}-of-${String(shardCount).padStart(2, "0")}`);
}

export function acquireShardLock(dir, owner = {}) {
  ensureDir(dir);
  const lockDir = path.join(dir, ".lock");
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error && error.code === "EEXIST") throw new Error(`shard lock already exists: ${lockDir}`);
    throw error;
  }
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    schema: "cell03-shard-lock-v1",
    acquiredAt: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    ...owner,
  }, null, 2));
  return () => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  };
}

export function makeFixtureRows({ root, shardCount, shardIndex, executionWindowId, runnerId }) {
  const binding = buildCell03Binding({ root, executionWindowId, runnerId });
  return rowsForShard({ root, shardCount, shardIndex, binding }).map((row) => ({
    schema: CELL03_ROW_SCHEMA,
    rowStatus: "final",
    fixture: true,
    cellKey: row.cellKey,
    orderedIndex: row.orderedIndex,
    shardIndex,
    shardCount,
    taskId: row.taskId,
    taskSlot: row.taskSlot,
    scenarioSlot: row.scenarioSlot,
    repeatSlot: row.repeatSlot,
    rowSeed: row.rowSeed,
    binding: {
      protocolDigest: binding.protocolDigest,
      taskInventoryDigest: binding.taskInventoryDigest,
      promptDigest: binding.promptDigest,
      toolSurfaceDigest: binding.toolSurfaceDigest,
      runnerId: binding.runnerId,
      executionWindowId: binding.executionWindowId,
      executorSnapshot: binding.executorSnapshot,
      reviewerSnapshot: binding.reviewerSnapshot,
      snapshotDate: binding.snapshotDate,
    },
  }));
}

export function writeShardOutput(options = {}) {
  const shardCount = Number(options.shardCount ?? 1);
  const shardIndex = Number(options.shardIndex ?? 0);
  const outDir = options.outDir || path.join(os.tmpdir(), "cell03-shards");
  const targetDir = shardDir(outDir, shardCount, shardIndex);
  const release = acquireShardLock(targetDir, { shardCount, shardIndex, runnerId: options.runnerId || null });
  try {
    // Overwrite refusal must run inside the lock: an unlocked pre-check is a
    // TOCTOU window where a second writer whose check saw an empty dir can win
    // the lock after the first writer finishes and silently clobber its output.
    if (!options.allowOverwrite) {
      for (const fileName of ["shard-manifest.json", "rows.jsonl"]) {
        const existing = path.join(targetDir, fileName);
        if (fs.existsSync(existing)) throw new Error(`refusing to overwrite existing shard output: ${existing}`);
      }
    }
    const plan = buildShardPlan({ ...options, shardCount, shardIndex });
    const shard = plan.shards[shardIndex];
    const rows = options.fixtureRows === false ? [] : makeFixtureRows({ ...options, shardCount, shardIndex });
    const rowsPath = path.join(targetDir, "rows.jsonl");
    const manifest = {
      schema: CELL03_SHARD_MANIFEST_SCHEMA,
      createdAt: new Date().toISOString(),
      shardIndex,
      shardCount,
      rowCount: rows.length,
      plannedRowCount: shard.rowCount,
      allExpectedCellKeyDigest: plan.allExpectedCellKeyDigest,
      expectedCellKeyDigest: shard.expectedCellKeyDigest,
      binding: {
        protocolDigest: plan.binding.protocolDigest,
        taskInventoryDigest: plan.binding.taskInventoryDigest,
        promptDigest: plan.binding.promptDigest,
        toolSurfaceDigest: plan.binding.toolSurfaceDigest,
        runnerId: plan.binding.runnerId,
        executionWindowId: plan.binding.executionWindowId,
        executorSnapshot: plan.binding.executorSnapshot,
        reviewerSnapshot: plan.binding.reviewerSnapshot,
        snapshotDate: plan.binding.snapshotDate,
      },
      rowsFile: "rows.jsonl",
      rowsDigest: sha256Text(rows.map((row) => canonicalJson(row)).join("\n")),
    };
    fs.writeFileSync(rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    fs.writeFileSync(path.join(targetDir, "shard-manifest.json"), JSON.stringify(manifest, null, 2));
    return {
      targetDir,
      rowsPath,
      manifestPath: path.join(targetDir, "shard-manifest.json"),
      rowCount: rows.length,
      plannedRowCount: shard.rowCount,
      expectedCellKeyDigest: shard.expectedCellKeyDigest,
    };
  } finally {
    release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.executeProvider) throw new Error("provider execution is out of scope for cell03-shards");
  const result = writeShardOutput({
    shardCount: Number(args.shards || args.shardCount || 1),
    shardIndex: Number(args.shard || args.shardIndex || 0),
    outDir: args.outDir,
    executionWindowId: args.executionWindowId,
    runnerId: args.runnerId,
    fixtureRows: args.fixtureRows !== "false",
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Cell03 shard written: ${result.targetDir} rows=${result.rowCount}`);
}
