#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildShardPlan } from "./plan.mjs";
import { mergeShardOutputs } from "./merge.mjs";
import { acquireShardLock, shardDir, writeShardOutput } from "./shard-runner.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(label, fn) {
  try {
    fn();
  } catch {
    return true;
  }
  throw new Error(`${label} did not fail closed`);
}

function mutateFirstRow(rowsPath, mutator) {
  const rows = fs.readFileSync(rowsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  rows[0] = mutator(rows[0]);
  fs.writeFileSync(rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function copyFixture(srcDir, dstDir) {
  fs.cpSync(srcDir, dstDir, { recursive: true });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cell03-shards-selfcheck-"));
const shardCount = 8;
const canonicalRowsPath = path.resolve("experiments/multi-model-ablation/future-cell03-results/full/cell03-rows.jsonl");
const canonicalBefore = fs.existsSync(canonicalRowsPath) ? fs.readFileSync(canonicalRowsPath, "utf8") : null;

try {
  const plan = buildShardPlan({ shardCount });
  assert(plan.totalRows === 1152, `expected 1152 rows, got ${plan.totalRows}`);
  assert(plan.uniqueRows === 1152, `expected 1152 unique rows, got ${plan.uniqueRows}`);
  assert(plan.shards.length === shardCount, `expected ${shardCount} shards`);
  assert(plan.shards.reduce((sum, shard) => sum + shard.rowCount, 0) === 1152, "shard row counts do not sum to 1152");
  expectThrow("invalid shard index", () => buildShardPlan({ shardCount: 0 }));

  const lockDir = shardDir(path.join(tempRoot, "lock"), shardCount, 0);
  const release = acquireShardLock(lockDir, { selfcheck: true });
  try {
    expectThrow("same-shard lock", () => writeShardOutput({ outDir: path.join(tempRoot, "lock"), shardCount, shardIndex: 0 }));
  } finally {
    release();
  }

  const completeDir = path.join(tempRoot, "complete");
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    writeShardOutput({ outDir: completeDir, shardCount, shardIndex });
  }
  expectThrow("completed shard overwrite", () => writeShardOutput({ outDir: completeDir, shardCount, shardIndex: 0 }));
  const mergeSummary = mergeShardOutputs({ inputDir: completeDir, requireComplete: true });
  assert(mergeSummary.mergedRows === 1152, `expected merged rows=1152, got ${mergeSummary.mergedRows}`);

  const duplicateDir = path.join(tempRoot, "duplicate");
  copyFixture(completeDir, duplicateDir);
  const duplicateRowsPath = path.join(shardDir(duplicateDir, shardCount, 0), "rows.jsonl");
  fs.appendFileSync(duplicateRowsPath, fs.readFileSync(duplicateRowsPath, "utf8").split(/\r?\n/).filter(Boolean)[0] + "\n");
  const duplicateManifestPath = path.join(shardDir(duplicateDir, shardCount, 0), "shard-manifest.json");
  const duplicateManifest = JSON.parse(fs.readFileSync(duplicateManifestPath, "utf8"));
  duplicateManifest.rowCount += 1;
  fs.writeFileSync(duplicateManifestPath, JSON.stringify(duplicateManifest, null, 2));
  expectThrow("duplicate final row", () => mergeShardOutputs({ inputDir: duplicateDir, requireComplete: true }));

  const missingDir = path.join(tempRoot, "missing");
  copyFixture(completeDir, missingDir);
  fs.rmSync(shardDir(missingDir, shardCount, 1), { recursive: true, force: true });
  expectThrow("missing shard", () => mergeShardOutputs({ inputDir: missingDir, requireComplete: true }));

  const driftDir = path.join(tempRoot, "drift");
  copyFixture(completeDir, driftDir);
  const driftRowsPath = path.join(shardDir(driftDir, shardCount, 2), "rows.jsonl");
  mutateFirstRow(driftRowsPath, (row) => ({
    ...row,
    binding: {
      ...row.binding,
      toolSurfaceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  }));
  expectThrow("digest drift", () => mergeShardOutputs({ inputDir: driftDir, requireComplete: true }));

  const canonicalAfter = fs.existsSync(canonicalRowsPath) ? fs.readFileSync(canonicalRowsPath, "utf8") : null;
  assert(canonicalBefore === canonicalAfter, "canonical Cell03 rows changed during selfcheck");

  console.log("cell03-shards selfcheck PASS: coverage=1152 shards=8 lockReject=pass rerunReject=pass mergeComplete=pass duplicateReject=pass missingReject=pass digestDriftReject=pass canonicalUntouched=pass");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
