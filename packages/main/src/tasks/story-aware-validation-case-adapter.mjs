#!/usr/bin/env node

/*
 * Registered DYN-5 adapter.  The handler binds this exact entrypoint to the
 * catalog command and verifies the evidence files emitted here.  The adapter
 * therefore cannot make a generic command look like a case-aware runner by
 * merely echoing the expected markers.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const registryPath = env.LATTICE_VALIDATION_SHARD_CASE_REGISTRY;
const shardDir = env.LATTICE_VALIDATION_SHARD_DIR;
const domain = env.LATTICE_VALIDATION_SHARD_DOMAIN;
const shardId = env.LATTICE_VALIDATION_SHARD_ID;
const sentinelCaseId = env.LATTICE_VALIDATION_SHARD_SENTINEL;
const registryDigest = env.LATTICE_VALIDATION_SHARD_CASE_REGISTRY_DIGEST;
const adapterDigest = env.LATTICE_VALIDATION_SHARD_ADAPTER_DIGEST;
const requestedIds = (env.LATTICE_VALIDATION_SHARD_CASE_IDS || '').split(',').filter(Boolean);

if (!registryPath || !shardDir || !domain || !shardId || !sentinelCaseId || !registryDigest || !adapterDigest) {
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
  };
  writeFileSync(`${shardDir}/${encodeURIComponent(caseId)}.case.json`, JSON.stringify({
    ...evidence,
    evidenceDigest: digest(evidence),
  }) + '\n', 'utf8');
}
process.stdout.write(`PROOF_OR_STOP_CASES:${requestedIds.join(',')}\n`);
process.stdout.write(`PROOF_OR_STOP_SENTINEL:${sentinelCaseId}\n`);
