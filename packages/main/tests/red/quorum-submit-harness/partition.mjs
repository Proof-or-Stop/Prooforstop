







import ts from "typescript";
import { readJsonTarget, loadBuiltTarget } from "./selection.mjs";
import { manifestPath, EXPECTED_CASES, catalogSourcePath, catalogDistPath } from "./support.mjs";
import { manifestRows } from "./coordinator-wiring.mjs";
import { contract, json } from "./owned-files.mjs";
import { expectRejected, runPositiveRealCli } from "./selection-contracts.mjs";
import { gitStatus } from "./callback-inventory.mjs";
import { resultCaseId } from "./worker-coordination.mjs";
import { proveRealCoordinatorFaultSeam } from "./resource-traces.mjs";

export function countDomains(rows) {
  return Object.fromEntries(["pure", "integration", "prune"].map((domain) => [
    domain,
    rows.filter((row) => row.domain === domain).length,
  ]));
}

export async function partitionContract() {
  const manifest = readJsonTarget(manifestPath, "partition-contract");
  const rows = manifestRows(manifest);
  const counts = countDomains(rows);
  contract(
    counts.pure === 6 && counts.integration === 46 && counts.prune === 21,
    "partition counts must be pure=6 integration=46 prune=21; actual=" + json(counts),
  );

  const expectedDomains = new Map(EXPECTED_CASES.map((row) => [row.id, row.domain]));
  for (const row of rows) {
    contract(
      expectedDomains.get(row.id) === row.domain,
      "case " + row.id + " is routed to " + row.domain + " instead of " + expectedDomains.get(row.id),
    );
    contract(
      typeof row.shard === "string" && row.shard.trim().length > 0,
      "case " + row.id + " has no explicit shard",
    );
    contract(Array.isArray(row.capabilities), "case " + row.id + " has no observed capabilities array");
  }

  const requiredCapabilityWitnesses = new Map([
    ["qsm-001", "lock"],
    ["qsm-006", "cli"],
    ["qsm-008", "environment"],
    ["qsm-013", "git"],
    ["qsm-014", "signature"],
    ["qsm-039", "concurrency"],
    ["qsm-046", "large-file"],
  ]);
  for (const [id, capability] of requiredCapabilityWitnesses) {
    const row = rows.find((candidate) => candidate.id === id);
    contract(
      row?.domain === "integration" && row.capabilities.includes(capability),
      id + " must witness integration capability " + capability,
    );
  }
  const integrationCapabilities = new Set([
    "git", "cli", "lock", "concurrency", "environment", "signature", "large-file",
  ]);
  for (const row of rows.filter((candidate) => candidate.domain === "pure")) {
    contract(
      row.capabilities.every((capability) => !integrationCapabilities.has(capability)),
      "pure case " + row.id + " carries an integration capability: " + json(row.capabilities),
    );
  }

  const shardIds = [...new Set(rows.map((row) => row.shard))].sort();
  contract(
    shardIds.length >= 3 && shardIds.length <= 4,
    "canonical inventory must form three or four shards; actual=" + json(shardIds),
  );
  const sentinels = shardIds.map((shard) => rows.find(
    (row) => row.shard === shard && row.sentinel === "real",
  ));
  contract(
    sentinels.every(Boolean),
    "every shard must name a real case-body sentinel; shards=" + json(shardIds),
  );
  contract(
    new Set(sentinels.map((row) => row.domain)).size === 3,
    "real sentinels must cover pure, integration, and prune domains",
  );

  const catalog = await loadBuiltTarget(
    catalogSourcePath,
    catalogDistPath,
    "partition-contract",
  );
  contract(
    typeof catalog.validateQuorumSmokePartitions === "function",
    "catalog module must export validateQuorumSmokePartitions",
  );
  const validate = (cases) => catalog.validateQuorumSmokePartitions({ cases });
  await validate(rows);

  const removedShard = shardIds[0];
  await expectRejected(
    () => validate(rows.filter((row) => row.shard !== removedShard)),
    new RegExp("missing.*" + removedShard + "|" + removedShard + ".*missing", "i"),
    "deleted shard mutation",
  );
  await expectRejected(
    () => validate([...rows, { ...rows[0] }]),
    /duplicate.*qsm-001|qsm-001.*duplicate/i,
    "duplicate partition identity mutation",
  );
  await expectRejected(
    () => validate(rows.map((row) => (
      row.id === "qsm-002" ? { ...row, domain: "integration" } : row
    ))),
    /qsm-002.*(pure|integration)|(pure|integration).*qsm-002/i,
    "wrong-domain routing mutation",
  );
  const staticShard = shardIds[0];
  await expectRejected(
    () => validate(rows.map((row) => (
      row.shard === staticShard && row.sentinel === "real"
        ? { ...row, sentinel: "static-pass" }
        : row
    ))),
    new RegExp(staticShard + ".*(real|static)|(?:real|static).*" + staticShard, "i"),
    "static PASS sentinel mutation",
  );

  const before = gitStatus();
  const shardRuntimeIds = [];
  for (const shard of shardIds) {
    const expectedShardIds = rows
      .filter((row) => row.shard === shard)
      .map((row) => row.id);
    const expectedShardSentinels = sentinels
      .filter((row) => row.shard === shard)
      .map((row) => row.id);
    const { report } = await runPositiveRealCli(
      ["--shard=" + shard, "--report=json"],
      expectedShardIds,
      "real shard " + shard,
      { timeoutMs: 20 * 60_000, expectedSentinels: expectedShardSentinels },
    );
    contract(report.mode === "shard" && report.shardId === shard, "shard CLI report did not bind " + shard);
    shardRuntimeIds.push(...report.results.map(resultCaseId));
  }
  contract(
    json([...shardRuntimeIds].sort()) === json(EXPECTED_CASES.map((row) => row.id).sort()),
    "real shard execution union was not the canonical 73-case set",
  );

  await proveRealCoordinatorFaultSeam();

  contract(gitStatus() === before, "real shard sentinels left repository residue");

  console.log(
    "PARTITION_PASS shards=" + shardIds.length
    + " cases=73 missing=0 duplicate=0 residue=0",
  );
}
