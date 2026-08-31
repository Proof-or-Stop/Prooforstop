#!/usr/bin/env node

/*
 * Registered DYN-5 adapter.  The handler binds this exact entrypoint to the
 * catalog command and verifies the evidence files emitted here.  The adapter
 * therefore cannot make a generic command look like a case-aware runner by
 * merely echoing the expected markers.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;
// B-45a0 F-447: read BOTH spellings, preferring the canonical PROOF_OR_STOP_*
// name, per brand-rename-mapping.md's rule for LATTICE_* env vars ("Read both
// names, preferring the new one. Never require the new name."). The producer in
// handlers/story-aware-validation.ts now emits the canonical names; the
// deprecated spelling stays readable so an already-exported env keeps working.
const readShardEnv = (suffix) =>
  env[`PROOF_OR_STOP_VALIDATION_${suffix}`] ?? env[`LATTICE_VALIDATION_${suffix}`];
const registryPath = readShardEnv('SHARD_CASE_REGISTRY');
const shardDir = readShardEnv('SHARD_DIR');
const domain = readShardEnv('SHARD_DOMAIN');
const shardId = readShardEnv('SHARD_ID');
const sentinelCaseId = readShardEnv('SHARD_SENTINEL');
const registryDigest = readShardEnv('SHARD_CASE_REGISTRY_DIGEST');
const adapterDigest = readShardEnv('SHARD_ADAPTER_DIGEST');
const requestedIds = (readShardEnv('SHARD_CASE_IDS') || '').split(',').filter(Boolean);
const projectRoot = readShardEnv('PROJECT_ROOT');

if (!registryPath || !shardDir || !domain || !shardId || !sentinelCaseId || !registryDigest || !adapterDigest || !projectRoot) {
  throw new Error('DYN-5 adapter environment is incomplete');
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
if (!Array.isArray(registry)) throw new Error('DYN-5 case registry must be an array');
const cases = registry.filter((entry) => entry && entry.domain === domain && typeof entry.caseId === 'string');
const byId = new Map(cases.map((entry) => [entry.caseId, entry]));
if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
  throw new Error('DYN-5 shard case IDs are empty or duplicated');
}
if (requestedIds.some((id) => !byId.has(id))) throw new Error('DYN-5 shard routes an unknown case');
if (!requestedIds.includes(sentinelCaseId)) throw new Error('DYN-5 sentinel is outside the shard');
if (byId.get(sentinelCaseId)?.sentinel !== true) throw new Error('DYN-5 sentinel is not declared by the registry');

function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

mkdirSync(shardDir, { recursive: true });
for (const caseId of requestedIds) {
  const testCase = byId.get(caseId);
  const runner = testCase?.runner;
  if (!runner || typeof runner.command !== 'string' || !Array.isArray(runner.args)) {
    throw new Error(`DYN-5 case ${caseId} has no executable runner`);
  }
  const runnerCwd = runner.cwd ? resolve(projectRoot, runner.cwd) : projectRoot;
  const runnerEnv = { ...process.env, ...(runner.env || {}) };
  const execution = spawnSync(runner.command, runner.args, {
    cwd: runnerCwd,
    env: runnerEnv,
    encoding: 'utf8',
    timeout: Number(readShardEnv('CASE_TIMEOUT_MS') || 120000),
  });
  const output = `${execution.stdout || ''}${execution.stderr || ''}`;
  const successMarker = runner.successMarker || `PROOF_OR_STOP_CASE_EXECUTED:${caseId}`;
  if (execution.error || execution.status !== 0 || !output.includes(successMarker)) {
    throw new Error(`DYN-5 case ${caseId} did not execute successfully: ${execution.error?.message || output || `exit ${execution.status}`}`);
  }
  const evidence = {
    schema: 'proof-or-stop.validation-shard-case-evidence.v1',
    adapter: 'case-registry-output-v1',
    adapterDigest,
    registryDigest,
    shardId,
    domain,
    caseId,
    sentinel: caseId === sentinelCaseId,
    executed: true,
    exitCode: execution.status,
    outputDigest: digest(output),
    successMarker,
  };
  writeFileSync(`${shardDir}/${encodeURIComponent(caseId)}.case.json`, JSON.stringify({
    ...evidence,
    evidenceDigest: digest(evidence),
  }) + '\n', 'utf8');
  process.stdout.write(`PROOF_OR_STOP_CASE_EXECUTED:${caseId}\n`);
}
process.stdout.write(`PROOF_OR_STOP_CASES:${requestedIds.join(',')}\n`);
process.stdout.write(`PROOF_OR_STOP_SENTINEL:${sentinelCaseId}\n`);
