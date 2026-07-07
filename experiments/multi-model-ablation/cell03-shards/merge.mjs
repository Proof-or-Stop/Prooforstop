#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  CELL03_SHARD_MANIFEST_SCHEMA,
  buildShardPlan,
  canonicalJson,
  parseArgs,
  sha256Text,
} from "./plan.mjs";

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

function readShardManifest(dir) {
  const manifestPath = path.join(dir, "shard-manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`missing shard manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== CELL03_SHARD_MANIFEST_SCHEMA) throw new Error(`unsupported shard manifest schema in ${manifestPath}`);
  return { dir, manifest, manifestPath };
}

function assertSafeOutputPath(outputPath) {
  if (!outputPath) return;
  if (path.basename(outputPath) === "cell03-rows.jsonl") {
    throw new Error("refusing to write merged output to canonical cell03-rows.jsonl");
  }
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite existing output: ${outputPath}`);
}

export function mergeShardOutputs(options = {}) {
  const inputDir = options.inputDir;
  if (!inputDir) throw new Error("inputDir is required");
  const shardDirs = fs.readdirSync(inputDir)
    .filter((entry) => /^shard-\d+-of-\d+$/.test(entry))
    .map((entry) => path.join(inputDir, entry))
    .sort();
  if (shardDirs.length === 0) throw new Error(`no shard directories found in ${inputDir}`);

  const manifests = shardDirs.map(readShardManifest);
  const shardCount = manifests[0].manifest.shardCount;
  const plan = buildShardPlan({ ...options, shardCount, includeRows: true });
  // Anchor binding verification to the live envelope-derived plan.binding, not to a
  // peer manifest. Comparing shards only against each other lets a fully-consistent
  // but stale/forged binding across every shard pass; CHK-003 requires the merged set
  // to match the true protocol/prompt/tool/snapshot binding, which plan.binding carries
  // (buildCell03Binding verifies the envelope digests). Only the operator-supplied
  // runnerId/executionWindowId are not envelope-derived, but they must still be uniform,
  // which anchoring to plan.binding (built from the same options) also enforces.
  const bindingJson = canonicalJson({
    protocolDigest: plan.binding.protocolDigest,
    taskInventoryDigest: plan.binding.taskInventoryDigest,
    promptDigest: plan.binding.promptDigest,
    toolSurfaceDigest: plan.binding.toolSurfaceDigest,
    runnerId: plan.binding.runnerId,
    executionWindowId: plan.binding.executionWindowId,
    executorSnapshot: plan.binding.executorSnapshot,
    reviewerSnapshot: plan.binding.reviewerSnapshot,
    snapshotDate: plan.binding.snapshotDate,
  });
  const manifestByShard = new Map();

  for (const item of manifests) {
    const { manifest, manifestPath } = item;
    if (manifest.shardCount !== shardCount) throw new Error(`shard-count drift in ${manifestPath}`);
    if (manifestByShard.has(manifest.shardIndex)) throw new Error(`duplicate shard manifest for shard ${manifest.shardIndex}`);
    if (canonicalJson(manifest.binding) !== bindingJson) throw new Error(`binding digest drift in ${manifestPath}`);
    const expected = plan.shards[manifest.shardIndex];
    if (!expected) throw new Error(`unexpected shard index ${manifest.shardIndex} in ${manifestPath}`);
    if (manifest.expectedCellKeyDigest !== expected.expectedCellKeyDigest) {
      throw new Error(`expected key digest drift for shard ${manifest.shardIndex}`);
    }
    manifestByShard.set(manifest.shardIndex, item);
  }

  if (options.requireComplete !== false) {
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
      if (!manifestByShard.has(shardIndex)) throw new Error(`missing shard output: ${shardIndex}`);
    }
  }

  const expectedByKey = new Map();
  for (const shard of plan.shards) {
    for (const row of shard.rows || []) expectedByKey.set(row.cellKey, shard.shardIndex);
  }

  const rowsByKey = new Map();
  const mergedRows = [];
  for (const item of manifests) {
    const { dir, manifest } = item;
    const rowsFile = path.join(dir, manifest.rowsFile || "rows.jsonl");
    const rowLines = readLines(rowsFile);
    if (rowLines.length !== manifest.rowCount) {
      throw new Error(`row count drift for shard ${manifest.shardIndex}: manifest=${manifest.rowCount} actual=${rowLines.length}`);
    }
    const parsedRows = rowLines.map((line) => JSON.parse(line));
    const actualRowsDigest = sha256Text(parsedRows.map((row) => canonicalJson(row)).join("\n"));
    if (manifest.rowsDigest !== actualRowsDigest) {
      throw new Error(`row digest drift for shard ${manifest.shardIndex}`);
    }
    for (const row of parsedRows) {
      if (row.rowStatus !== "final") throw new Error(`non-final row cannot be merged: ${row.cellKey || "(missing cellKey)"}`);
      if (row.shardIndex !== manifest.shardIndex || row.shardCount !== shardCount) {
        throw new Error(`row shard binding drift: ${row.cellKey}`);
      }
      if (canonicalJson(row.binding) !== bindingJson) throw new Error(`row binding drift: ${row.cellKey}`);
      const expectedShard = expectedByKey.get(row.cellKey);
      if (expectedShard == null) throw new Error(`unexpected cellKey: ${row.cellKey}`);
      if (expectedShard !== manifest.shardIndex) throw new Error(`cellKey assigned to wrong shard: ${row.cellKey}`);
      if (rowsByKey.has(row.cellKey)) throw new Error(`duplicate final row: ${row.cellKey}`);
      rowsByKey.set(row.cellKey, row);
      mergedRows.push(row);
    }
  }

  const missing = [];
  if (options.requireComplete !== false) {
    for (const cellKey of expectedByKey.keys()) {
      if (!rowsByKey.has(cellKey)) missing.push(cellKey);
    }
    if (missing.length > 0) throw new Error(`missing final rows: ${missing.length}`);
  }

  mergedRows.sort((a, b) => a.orderedIndex - b.orderedIndex);
  const summary = {
    schema: "cell03-shard-merge-summary-v1",
    inputDir,
    shardCount,
    shardOutputs: manifests.length,
    mergedRows: mergedRows.length,
    expectedRows: plan.totalRows,
    missingRows: missing.length,
    duplicateRows: 0,
    allExpectedCellKeyDigest: plan.allExpectedCellKeyDigest,
    mergedRowsDigest: sha256Text(mergedRows.map((row) => canonicalJson(row)).join("\n")),
  };

  if (options.output) {
    assertSafeOutputPath(options.output);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${mergedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    summary.output = options.output;
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const summary = mergeShardOutputs({
    inputDir: args.inputDir,
    output: args.output,
    requireComplete: args.requireComplete !== "false",
    executionWindowId: args.executionWindowId,
    runnerId: args.runnerId,
  });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`Cell03 shard merge validated: rows=${summary.mergedRows}/${summary.expectedRows} shards=${summary.shardOutputs}/${summary.shardCount}`);
}
