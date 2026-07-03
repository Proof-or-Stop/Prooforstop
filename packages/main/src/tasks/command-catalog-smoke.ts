#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { buildQuantumClaimCheckCase } from '../core/claim-admissibility/quantum.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const repoRoot = join(pkgRoot, '..', '..');

const toolNames = MAIN_TOOLS.map(tool => tool.name);
const toolByName = new Map(MAIN_TOOLS.map(tool => [tool.name, tool]));

function findTool(name: string) {
  const tool = toolByName.get(name);
  assert.ok(tool, `expected command in MAIN_TOOLS: ${name}`);
  return tool;
}

function schemaDescription(command: string, key: string): string {
  const schema = findTool(command).schema[key] as { description?: unknown } | undefined;
  return typeof schema?.description === 'string' ? schema.description : '';
}

function schemaAccepts(command: string, key: string, value: unknown): boolean {
  const schema = findTool(command).schema[key] as { safeParse?: (input: unknown) => { success: boolean } } | undefined;
  const safeParse = schema?.safeParse;
  assert.equal(typeof safeParse, 'function', `${command}.${key} should expose a Zod safeParse`);
  if (typeof safeParse !== 'function') return false;
  return safeParse(value).success;
}

function runCli(args: string[]): string {
  const distCli = join(pkgRoot, 'dist', 'cli.js');
  return execFileSync('node', [distCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
  });
}

function runDistCli(args: string[]): string {
  const distCli = join(pkgRoot, 'dist', 'cli.js');
  return execFileSync('node', [distCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
  });
}

function runDistCliProbe(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const distCli = join(pkgRoot, 'dist', 'cli.js');
  const result = spawnSync('node', [distCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const duplicateNames = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
assert.deepEqual([...new Set(duplicateNames)], [], 'MAIN_TOOLS must not contain duplicate commands');

assert.deepEqual(toolNames.slice(0, 8), [
  'story_create',
  'story_advance',
  'story_update',
  'story_get',
  'story_list',
  'story_resolve',
  'story_reconcile',
  'story_discard',
], 'MAIN_TOOLS leading command order changed');

assert.deepEqual(toolNames.slice(-6), [
  'spike_record',
  'spike_review_set',
  'red_green_relation_create',
  'red_green_relation_evaluate',
  'regression_matrix_review_set',
  'story_create_from_repro',
], 'MAIN_TOOLS trailing command order changed');

for (const command of [
  'story_create',
  'story_advance',
  'validate',
  'global_control_status',
  'runtime_closure_status',
  'admissibility_waterline',
  'queue_governance_status',
  'queue_exception_set',
  'conduit_status',
  'quorum_submit',
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_policy_create',
  'dispatch_auto',
]) {
  findTool(command);
}

for (const retiredCommand of [
  'authority_status',
  'authority_enforce_policy',
  'authority_receipt_verify',
  'authority_enforce_runner',
  'authority_receipt_fetch',
  'authority_verdict_submit',
  'authority_job_create',
  'authority_verdict_list',
  'authority_job_status',
] as const) {
  assert.equal(toolByName.has(retiredCommand), false, `${retiredCommand} must remain retired from MAIN_TOOLS`);
}

const quantumCompleteEvidence = buildQuantumClaimCheckCase('complete');
const quantumCompleteEvidenceJson = JSON.stringify(quantumCompleteEvidence);
assert.equal(schemaAccepts('quantum_claim_check', 'evidenceJson', quantumCompleteEvidenceJson), true, 'quantum evidenceJson schema accepts inline JSON strings');
assert.equal(schemaAccepts('quantum_claim_check', 'evidenceJson', quantumCompleteEvidence), true, 'quantum evidenceJson schema accepts parser-produced JSON objects');
assert.equal(schemaAccepts('quantum_claim_check', 'evidenceJson', [quantumCompleteEvidence]), false, 'quantum evidenceJson schema rejects arrays');
assert.equal(schemaAccepts('quantum_claim_check', 'evidenceJson', 1), false, 'quantum evidenceJson schema rejects scalar non-JSON values');
assert.equal(schemaAccepts('quantum_claim_check', 'evidencePath', '/tmp/complete-q5.json'), true, 'quantum evidencePath schema accepts file path strings');
assert.equal(schemaAccepts('quantum_claim_check', 'evidencePath', quantumCompleteEvidence), false, 'quantum evidencePath schema rejects parser-produced JSON objects');
assert.equal(schemaAccepts('quantum_claim_check', 'productionClaim', true), false, 'quantum command schema keeps productionClaim unsupported');
assert.equal(schemaAccepts('quantum_claim_benchmark', 'json', true), true, 'quantum benchmark schema accepts --json');
assert.equal(schemaAccepts('quantum_claim_benchmark', 'productionClaim', true), false, 'quantum benchmark schema keeps productionClaim unsupported');
assert.equal(schemaAccepts('quantum_claim_benchmark', 'runCommands', true), false, 'quantum benchmark schema rejects runCommands side-effect flag');
assert.equal(schemaAccepts('quantum_claim_report', 'format', 'text'), true, 'quantum report schema accepts text format');
assert.equal(schemaAccepts('quantum_claim_report', 'authorityClaim', true), false, 'quantum report schema keeps authorityClaim unsupported');
assert.equal(schemaAccepts('quantum_claim_report', 'writeEvidence', true), false, 'quantum report schema rejects writeEvidence side-effect flag');

const currentHostText = [
  findTool('host_runtime_list').description,
  findTool('host_runtime_probe').description,
  schemaDescription('host_runtime_probe', 'host'),
  schemaDescription('dispatch_policy_create', 'allowedHosts'),
  findTool('dispatch_auto').description,
].join('\n').toLowerCase();

assert.match(currentHostText, /antigravity/, 'current host text should include antigravity');
assert.match(currentHostText, /\bagy\b/, 'current host text should include agy alias');
assert.match(currentHostText, /gemini is legacy-only/, 'Gemini should be described only as legacy host text');
assert.doesNotMatch(
  currentHostText,
  /current[^\n.]*gemini|gemini[^\n.]*current/,
  'Gemini must not be advertised as a current host',
);

const commandHelpExpectations: Array<{ args: string[]; includes: string[] }> = [
  {
    args: ['story_create', '--help'],
    includes: ['Proofbound CLI', 'lattice story_create', '--checklist', '--scopeBoundary'],
  },
  {
    args: ['story_advance', '--help'],
    includes: [
      'Proofbound CLI',
      'lattice story_advance',
      '--phase',
      'INIT_CHECK',
      '--dryRun',
      'Dry-run: optional via --dryRun',
      'Owner lease meta options',
      '--takeover',
      '--forceTakeover',
    ],
  },
  {
    args: ['validate', '--help'],
    includes: ['Proofbound CLI', 'lattice validate', '--story', '--json'],
  },
  {
    args: ['conduit_status', '--help'],
    includes: ['Proofbound CLI', 'lattice conduit_status', '--format'],
  },
];

for (const { args, includes } of commandHelpExpectations) {
  const output = runCli(args);
  for (const expected of includes) {
    assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')} missing ${expected}`);
  }
}

const helpOutput = runCli(['help']);
assert.match(helpOutput, /Proofbound CLI/, 'lattice help should retain Proofbound branding');
assert.match(helpOutput, /host_runtime_probe/, 'lattice help should include host runtime commands');
assert.match(helpOutput, /antigravity/, 'lattice help should include antigravity host text');

const quantumCliOutput = runDistCli([
  '--root',
  repoRoot,
  'quantum_claim_check',
  '--evidenceJson',
  quantumCompleteEvidenceJson,
  '--requestedStrength=production',
  '--json',
]);
const quantumCliResult = JSON.parse(quantumCliOutput) as {
  decision?: unknown;
  allowed?: unknown;
  reason?: unknown;
  reasons?: unknown;
};
assert.equal(quantumCliResult.decision, 'stop', 'real CLI quantum evidenceJson requestedStrength=production stops');
assert.equal(quantumCliResult.allowed, false, 'real CLI quantum evidenceJson requestedStrength=production is not allowed');
assert.equal(
  Array.isArray(quantumCliResult.reasons) && quantumCliResult.reasons.includes('claim_boundary_violation:requestedStrength.production'),
  true,
  'real CLI quantum evidenceJson requestedStrength=production reports the production overclaim reason',
);

const quantumBenchmarkCliOutput = runDistCli([
  '--root',
  repoRoot,
  'quantum_claim_benchmark',
  '--json',
]);
const quantumBenchmarkCliResult = JSON.parse(quantumBenchmarkCliOutput) as {
  suiteStatus?: unknown;
  supportedCaseTotal?: unknown;
  failureInjectionTotal?: unknown;
  metrics?: { unsupportedAdvanceRate?: { rate?: unknown }; gateEvidence?: unknown; mutatesLifecycle?: unknown };
};
assert.equal(quantumBenchmarkCliResult.suiteStatus, 'PASS', 'real CLI quantum benchmark passes');
assert.equal(quantumBenchmarkCliResult.supportedCaseTotal, 4, 'real CLI quantum benchmark includes A1-A4');
assert.equal(quantumBenchmarkCliResult.failureInjectionTotal, 15, 'real CLI quantum benchmark includes B1-B15');
assert.equal(quantumBenchmarkCliResult.metrics?.unsupportedAdvanceRate?.rate, 0, 'real CLI quantum benchmark has zero unsupported advance rate');
assert.equal(quantumBenchmarkCliResult.metrics?.gateEvidence, false, 'real CLI quantum benchmark is not gate evidence');
assert.equal(quantumBenchmarkCliResult.metrics?.mutatesLifecycle, false, 'real CLI quantum benchmark mutates no lifecycle state');

const quantumReportCliOutput = runDistCli([
  '--root',
  repoRoot,
  'quantum_claim_report',
]);
assert.match(quantumReportCliOutput, /Quantum claim governance report/, 'real CLI quantum report renders text');
assert.match(quantumReportCliOutput, /failureInjectionsBlocked: 15\/15/, 'real CLI quantum report summarizes B1-B15');
assert.match(quantumReportCliOutput, /productionClaim: false/, 'real CLI quantum report keeps production claim false');

const emptyEvidenceJsonProbe = runDistCliProbe([
  '--root',
  repoRoot,
  'quantum_claim_check',
  '--evidenceJson',
  '',
  '--json',
]);
assert.notEqual(emptyEvidenceJsonProbe.status, 0, 'real CLI quantum empty evidenceJson exits nonzero instead of falling back to complete evidence');
assert.match(
  emptyEvidenceJsonProbe.stderr,
  /evidenceJson must be a non-empty JSON object/,
  'real CLI quantum empty evidenceJson reports the fail-closed input error',
);

const quantumEvidencePathRoot = mkdtempSync(join(tmpdir(), 'quantum-command-catalog-'));
try {
  const quantumCompleteEvidencePath = join(quantumEvidencePathRoot, 'complete-q5.json');
  writeFileSync(quantumCompleteEvidencePath, quantumCompleteEvidenceJson);
  const quantumEvidencePathOutput = runDistCli([
    '--root',
    repoRoot,
    'quantum_claim_check',
    '--evidencePath',
    quantumCompleteEvidencePath,
    '--requestedStrength=production',
    '--json',
  ]);
  const quantumEvidencePathResult = JSON.parse(quantumEvidencePathOutput) as {
    decision?: unknown;
    allowed?: unknown;
    reasons?: unknown;
  };
  assert.equal(quantumEvidencePathResult.decision, 'stop', 'real CLI quantum evidencePath requestedStrength=production stops');
  assert.equal(quantumEvidencePathResult.allowed, false, 'real CLI quantum evidencePath requestedStrength=production is not allowed');
  assert.equal(
    Array.isArray(quantumEvidencePathResult.reasons)
      && quantumEvidencePathResult.reasons.includes('claim_boundary_violation:requestedStrength.production'),
    true,
    'real CLI quantum evidencePath requestedStrength=production reports the production overclaim reason',
  );
} finally {
  rmSync(quantumEvidencePathRoot, { recursive: true, force: true });
}

process.stdout.write(`command catalog smoke passed: ${MAIN_TOOLS.length} commands\n`);
