#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { buildAcceptanceMatrixReport } from '../core/acceptance-topology.js';
import { StoryStore } from '../core/store.js';
import type {
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  ProofStoryContractData,
  ScopeCheckData,
  ScopeContractData,
  StoryInfo,
} from '../core/types.js';
import { signScopeCheck } from '../handlers/scope-check.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const repositoryRoot = resolve(packageRoot, '../../..');
const storyId = 'B-topology-gate-smoke';
const now = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function bytes(root: string, rel: string): string {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '<missing>';
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, LATTICE_SESSION_ID: 'topology-gate-smoke', LATTICE_AGENT: 'lattice-implementer' },
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (!allowFailure && result.status !== 0) throw new Error(output);
  return output;
}

function config(mode: 'observe' | 'warn' | 'enforce'): string {
  return JSON.stringify({
    storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures',
    proofStory: { devGateMode: mode },
  }, null, 2);
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-TOPOLOGY', relation: 'producer_to_consumer' as const,
  producer: {
    id: 'EP-P', role: 'producer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produce',
    fileDeclarationRef: 'CHK-001:files:create:0',
  },
  consumers: [{
    id: 'EP-C', role: 'consumer' as const, expectedArtifactKind: 'process_fact' as const,
    expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consume',
    fileDeclarationRef: 'CHK-001:files:create:1',
  }],
  outputFactRef: 'process-fact:topology-smoke',
};

function topology(): AcceptanceVerificationTopologyV1 {
  return {
    schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-TOPOLOGY:VPP-TOPOLOGY', endpointRef: 'EP-P' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-TOPOLOGY:VPP-TOPOLOGY', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    commandRefs: [
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
    ],
  };
}

function checklist(): ChecklistData {
  return { items: [{
    id: 'CHK-001', title: 'topology', context: 'focused smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: {
      happy: [{ id: 'INT-TOPOLOGY', desc: 'producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [structuredClone(declaration)] }],
      edge: [], adversarial: [],
    },
  }] };
}

function contract(value = topology()): ProofStoryContractData {
  return {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-TOPOLOGY', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-TOPOLOGY'], milestoneIds: [], verificationTopology: value }],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  };
}

function scopeContract(): ScopeContractData {
  return {
    storyId, mode: 'local', allowedModify: ['packages/main/src/handlers/proofstory.ts'],
    allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [],
    protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: now, updatedAt: now,
  };
}

function scopeCheck(root: string): ScopeCheckData {
  const base = {
    storyId, checkedAt: now, reviewRound: '', agentId: 'lattice-review-scope-plan', issues: [], features: [],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 },
  } as unknown as ScopeCheckData;
  const previous = process.cwd();
  process.chdir(root);
  try { return { ...base, _hash: signScopeCheck(storyId, now, 0, 1, '') }; }
  finally { process.chdir(previous); }
}

function writeDiscoveryRegistration(root: string): void {
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS = [',
    "  { name: 'acceptance_basis' },",
    "  { name: 'acceptance_basis_generate' },",
    "  { name: 'acceptance_topology_check' },",
    '];', '',
  ].join('\n'));
  write(root, 'packages/main/src/registry.ts', [
    "import { createProofStoryHandlers } from './handlers/proofstory.js';",
    'const registry = { registerBatch: (_handlers: unknown) => undefined };',
    'const ctx = {};',
    'registry.registerBatch(createProofStoryHandlers(ctx));', '',
  ].join('\n'));
  write(root, 'packages/main/src/handlers/proofstory.ts', [
    'export function createProofStoryHandlers() { return {',
    '  acceptance_basis() { return true; },',
    '  acceptance_basis_generate() { return true; },',
    '  acceptance_topology_check() { return true; },',
    '}; }', '',
  ].join('\n'));
  write(root, 'packages/main/src/core/process-fact-registry.ts',
    'export const acceptance_topology_check = "acceptance_basis acceptance_basis_generate transition-orchestrator PLAN to DEV structural gate";\n');
  write(root, 'packages/main/src/core/acceptance-topology.ts',
    'export const evaluateAcceptanceTopologyCheck = () => "PLAN to DEV structural gate";\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts',
    'export const evaluateAcceptanceTopologyForContext = () => "acceptance_topology_check";\n');
  write(root, 'scripts/verify-process-fact-contract.mjs',
    'export const acceptance_topology_check = "acceptance_basis acceptance_basis_generate transition-orchestrator PLAN to DEV structural gate";\n');
}

function parseJsonOutput(output: string): any {
  const start = output.indexOf('{');
  const errorStart = output.indexOf('\nError:', start);
  const end = (errorStart >= 0 ? output.slice(0, errorStart) : output).lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`JSON output missing: ${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

function assertCompatibilityMatrix(type: 'docs' | 'logic'): void {
  const intentId = `INT-${type.toUpperCase()}`;
  const item: ChecklistData = { items: [{
    id: 'CHK-001', title: type, context: 'compatibility', status: 'pending', startTime: null, endTime: null,
    verificationIntent: { happy: [{ id: intentId, desc: `${type} single outcome`, type, priority: 'must' }], edge: [], adversarial: [] },
  }] };
  const minimal: AcceptanceVerificationTopologyV1 = {
    schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'existing', canonicalSourceRef: 'checklist:CHK-001' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'existing', canonicalSourceRef: 'checklist:CHK-001' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: `intent:${intentId}` }, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [], transcriptAssertionRefs: [], commandRefs: [],
  };
  const report = buildAcceptanceMatrixReport({
    storyId: `B-${type}`, checklist: item, ledger: null,
    contract: {
      schemaVersion: 'proofstory.contract.v1', storyId: `B-${type}`, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
      acceptanceBindings: [{ id: `AC-${type}`, checklistRefs: ['CHK-001'], verificationIntentRefs: [intentId], milestoneIds: [], verificationTopology: minimal }],
      diagnosticGaps: [], createdAt: now, updatedAt: now,
    },
  });
  assert.deepEqual(report.diagnostics, [], `${type} compatibility must not fabricate runtime mutation/transcript/command obligations`);
}

assertCompatibilityMatrix('docs');
assertCompatibilityMatrix('logic');
const legacyMatrix = buildAcceptanceMatrixReport({
  storyId: 'B-legacy', checklist: { items: [] }, ledger: null,
  contract: {
    schemaVersion: 'proofstory.contract.v1', storyId: 'B-legacy', diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-legacy', checklistRefs: [], verificationIntentRefs: [], milestoneIds: [] }],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  },
});
assert.equal(legacyMatrix.rows[0]?.topologyState, 'legacy_missing', 'legacy topology remains readable and explicit');

const root = mkdtempSync(join(tmpdir(), 'proofstory-topology-gate-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'topology-smoke@example.test']);
  git(root, ['config', 'user.name', 'Topology Smoke']);
  write(root, 'lattice.config.json', config('observe'));
  write(root, 'tsconfig.json', '{}\n');
  write(root, 'packages/main/src/producer.ts', 'export const produce = () => true;\n');
  write(root, 'packages/main/src/consumer.ts', 'export const consume = () => true;\n');
  writeDiscoveryRegistration(root);
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'structural-plan-smoke', title: 'Structural plan smoke', description: 'focused production chain',
    type: 'feature', phase: 'PLAN', priority: 'low', createdAt: now, startedAt: now, endedAt: null,
    events: [], parallelSafe: 'no',
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
  store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed topology gate smoke']);

  run(root, 'original_intent_snapshot_set', {
    storyId,
    sourceText: 'Verify the structural plan path before development.',
    normalizedOutcome: 'A complete structural plan can enter development.',
    acceptanceClaim: 'The production transition consumes the same structural evaluator as the read-only check.',
  });
  const generatedOutput = run(root, 'acceptance_basis_generate', { storyId, json: true });
  const cleanObserve = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.equal(cleanObserve.structuralPass, true, `${generatedOutput}\n${JSON.stringify(cleanObserve.diagnostics)}`);
  assert.equal(cleanObserve.blocking, false);
  assert.equal(cleanObserve.authority, 'diagnostic_only');
  assert.equal(cleanObserve.evidentiary, false);
  const cleanText = run(root, 'acceptance_topology_check', { storyId });
  assert.match(cleanText, /PLAN structural semantics only/);

  const forged = run(root, 'acceptance_topology_check', { storyId, status: 'pass', mode: 'observe', authority: 'production' }, true);
  assert.match(forged, /Argument validation failed|Forbidden|invalid/i, 'caller cannot forge status, mode, or authority');

  const contractPath = `.lattice/story/actives/${storyId}/proofstory.json`;
  const artifactPath = `.lattice/story/actives/${storyId}/acceptance-basis.json`;
  const cleanContractBytes = bytes(root, contractPath);
  const cleanArtifactBytes = bytes(root, artifactPath);

  // Clean → topology-only omission while the independently derived basis keeps C2 → restore → clean.
  const omitted = JSON.parse(cleanContractBytes) as ProofStoryContractData;
  omitted.acceptanceBindings[0].verificationTopology!.commandRefs = omitted.acceptanceBindings[0].verificationTopology!.commandRefs
    .filter(ref => !(ref.refKind === 'existing' && ref.canonicalSourceRef === 'process-fact:acceptance_topology_check'));
  write(root, contractPath, `${JSON.stringify(omitted, null, 2)}\n`);
  const omittedReport = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.ok(omittedReport.diagnostics.some((item: any) => item.code === 'AT_UNMAPPED_SCOPE_REF'), 'C2 omission bites while basis remains unchanged');
  write(root, contractPath, cleanContractBytes);
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'exact omission restoration returns clean pass');

  const invented = JSON.parse(cleanContractBytes) as ProofStoryContractData;
  invented.acceptanceBindings[0].verificationTopology!.commandRefs.push({ refKind: 'existing', canonicalSourceRef: 'basis-path:path:not-real' });
  write(root, contractPath, `${JSON.stringify(invented, null, 2)}\n`);
  const inventedReport = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.ok(inventedReport.diagnostics.some((item: any) => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' || item.code === 'AT_UNKNOWN_REF'));
  write(root, contractPath, cleanContractBytes);
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'exact invention restoration returns clean pass');

  const tampered = JSON.parse(cleanArtifactBytes);
  tampered.basis.status = 'partial';
  tampered.basis.adapterResults.pop();
  write(root, artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedReport = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.ok(tamperedReport.diagnostics.some((item: any) => item.code === 'AT_COVERAGE_BASIS_PARTIAL'));
  assert.ok(tamperedReport.diagnostics.some((item: any) => item.code === 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'));
  write(root, artifactPath, cleanArtifactBytes);
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'exact basis restoration returns clean pass');

  for (const mode of ['observe', 'warn', 'enforce'] as const) {
    write(root, 'lattice.config.json', config(mode));
    run(root, 'acceptance_basis_generate', { storyId, json: true });
    const report = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
    assert.equal(report.mode, mode);
    assert.equal(report.structuralPass, true, `mode-only change preserves structural result in ${mode}`);
    assert.deepEqual(report.diagnostics, cleanObserve.diagnostics, `mode-only change preserves diagnostics in ${mode}`);
  }

  const changedDiscoveryConfig = JSON.parse(config('enforce'));
  changedDiscoveryConfig.rootDir = 'different-source-root';
  write(root, 'lattice.config.json', JSON.stringify(changedDiscoveryConfig, null, 2));
  const discoveryConfigDrift = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }, true));
  assert.equal(discoveryConfigDrift.structuralPass, false, 'scanRoot/rootDir changes remain structural freshness changes');
  assert.ok(discoveryConfigDrift.diagnostics.some((item: any) =>
    item.code === 'AT_COVERAGE_BASIS_STALE'
      || item.code === 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'
      || item.code === 'AT_COVERAGE_BASIS_PARTIAL'));
  write(root, 'lattice.config.json', config('enforce'));
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'discovery-config restoration returns clean pass');

  // Real PLAN→DEV production route. A valid story_review plus the current
  // verifier receipt admits DEV in enforce mode without executable evidence.
  write(root, 'lattice.config.json', config('enforce'));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'enable enforce mode']);
  const reviewAt = '2026-07-22T00:00:01.000Z';
  const reviewHash = createHash('sha256').update(`${storyId}:${reviewAt}:0:0:lattice-review-integrity-v1`).digest('hex');
  store.writeReview(storyId, { reviews: [{ timestamp: reviewAt, issueCount: 0, blockerCount: 0, issues: [], _hash: reviewHash }] } as any);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'record clean plan review']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  const advance = run(root, 'story_advance', { storyId, phase: 'DEV' });
  assert.match(advance, /advanced to DEV/);
  assert.equal(store.readStory(storyId).phase, 'DEV');

  assert.equal(bytes(root, contractPath), cleanContractBytes, 'topology mutations restore exact contract bytes');
  assert.equal(bytes(root, 'lattice.config.json'), config('enforce'), 'configuration mutations restore exact enforce bytes');
  assert.equal(bytes(root, 'packages/main/src/producer.ts'), 'export const produce = () => true;\n');
  assert.equal(bytes(root, 'packages/main/src/consumer.ts'), 'export const consume = () => true;\n');

  for (const mutation of ['drop-acceptance-topology-prompt', 'drop-acceptance-topology-handler', 'drop-acceptance-topology-gate']) {
    const result = spawnSync(process.execPath, ['scripts/verify-process-fact-contract.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, LATTICE_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${mutation} must make the real process-fact contract fail`);
    assert.match(`${result.stdout || ''}${result.stderr || ''}`, /acceptance topology contract|Process fact contract failed/);
  }

  console.log('proofstory acceptance topology gate smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
