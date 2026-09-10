#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS } from '../cli-engine.js';
import { buildQuantumClaimCheckCase } from '../core/claim-admissibility/quantum.js';
import {
  AGENT_DISPATCH_ACCEPTED_TYPES,
  AGENT_DISPATCH_REGISTRY,
  validateAgentDispatchRequest,
} from '../core/agent-dispatch-registry.js';

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
      PROOF_OR_STOP_NO_HOOKS: '1',
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
      PROOF_OR_STOP_NO_HOOKS: '1',
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
      PROOF_OR_STOP_NO_HOOKS: '1',
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

assert.deepEqual(toolNames.slice(0, 10), [
  'story_create',
  'story_advance',
  'story_update',
  'story_resume',
  'story_get',
  'story_list',
  'story_resolve',
  'story_reconcile',
  'identity_state_migrate',
  'story_discard',
], 'MAIN_TOOLS leading command order changed');

assert.deepEqual(toolNames.slice(-10), [
  'spike_record',
  'spike_review_set',
  'red_green_relation_create',
  'red_green_relation_evaluate',
  'regression_matrix_review_set',
  'story_create_from_repro',
  // W2b (B-e10d): red_evidence_binding_set; W2c (B-506e): the two chain-control
  // commands; W2d (B-9ff1): the read-only envelope pre-flight. Appended as the
  // trailing commands.
  'red_evidence_binding_set',
  'red_evidence_quarantine',
  'red_evidence_recover',
  'red_evidence_envelope_check',
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
  'autopilot_review_submit',
  'quorum_submit',
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_policy_create',
  'dispatch_auto',
  'dispatch',
]) {
  findTool(command);
}

assert.equal(schemaAccepts('autopilot_review_submit', 'deriveBindings', true), true, 'explicit deriveBindings flag accepts true');
assert.equal(schemaAccepts('autopilot_review_submit', 'deriveBindings', 'true'), false, 'deriveBindings does not accept string coercion at schema level');
assert.match(schemaDescription('autopilot_review_submit', 'deriveBindings'), /complete canonical binding envelope|current PASS evidence/i);

const dispatchTool = findTool('dispatch');
assert.match(dispatchTool.description, /story-only or exactly-one/, 'dispatch catalog description must explain registry-defined cardinality');
for (const agentType of AGENT_DISPATCH_ACCEPTED_TYPES) {
  assert.equal(schemaAccepts('dispatch', 'agentType', agentType), true, `dispatch schema must accept registered type/alias ${agentType}`);
}
for (const invalidAgentType of ['unknown-reviewer', '', null]) {
  assert.equal(schemaAccepts('dispatch', 'agentType', invalidAgentType), false, `dispatch schema must reject ${JSON.stringify(invalidAgentType)}`);
}
assert.equal(schemaAccepts('dispatch', 'agentType', undefined), true, 'dispatch schema deliberately permits omitted agentType for implementer default');
for (const identifier of ['itemId', 'findingId', 'clusterId'] as const) {
  assert.equal(schemaAccepts('dispatch', identifier, undefined), true, `dispatch.${identifier} is optional`);
  assert.equal(schemaAccepts('dispatch', identifier, null), false, `dispatch.${identifier} must omit absent values instead of accepting null`);
  assert.match(schemaDescription('dispatch', identifier), /story-only|mutually exclusive|registered/, `dispatch.${identifier} must explain conditional cardinality`);
}
// The dispatch agentType enum is derived from AGENT_DISPATCH_ACCEPTED_TYPES, which
// deliberately omits agents that are retired from runtime dispatch (e.g.
// proof-or-stop-review-channel, kept in the registry only for historical classification).
// Guard bidirectional consistency between the public schema and that registry so
// neither a stale non-dispatchable agent leaks into the enum, nor a retired lane is
// wrongly accepted.
const dispatchableCanonicalNames = new Set<string>(AGENT_DISPATCH_ACCEPTED_TYPES);
for (const entry of AGENT_DISPATCH_REGISTRY) {
  const dispatchable = dispatchableCanonicalNames.has(entry.canonicalName);
  const example = {
    storyId: 'B-example',
    agentType: entry.canonicalName,
    ...(entry.targetCardinality === 'exactly-one' ? { [entry.identifierKinds[0]]: 'EXAMPLE-001' } : {}),
  };
  if (dispatchable) {
    // Forward direction: a dispatchable registry entry's canonical example must be
    // accepted by the public dispatch schema AND satisfy the shared runtime contract.
    for (const [key, value] of Object.entries(example)) {
      assert.equal(schemaAccepts('dispatch', key, value), true, `dispatchable ${entry.canonicalName} example field ${key} must be schema-valid`);
    }
    assert.equal(
      validateAgentDispatchRequest({ ...example, phase: entry.allowedPhases[0] }).entry,
      entry,
      `public ${entry.canonicalName} example must also satisfy the shared runtime contract`,
    );
  } else {
    // Reverse direction: a registry entry retired from dispatch must be rejected by
    // BOTH the public dispatch agentType schema AND the shared runtime contract.
    assert.equal(
      schemaAccepts('dispatch', 'agentType', entry.canonicalName),
      false,
      `retired ${entry.canonicalName} must be rejected by the dispatch agentType schema`,
    );
    assert.throws(
      () => validateAgentDispatchRequest({ ...example, phase: entry.allowedPhases[0] }),
      /retired|unknown/i,
      `retired ${entry.canonicalName} must be rejected by the shared runtime contract`,
    );
  }
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
assert.equal(schemaAccepts('validate', 'reuseFreshRoutinePass', true), true);
assert.equal(schemaAccepts('validate', 'reuseFreshRoutinePass', false), true);
assert.equal(schemaAccepts('validate', 'reuseFreshRoutinePass', 'true'), false);
assert.equal(schemaAccepts('done_prepare', 'reuseFreshDoneRequired', true), true, 'done_prepare accepts explicit DONE-required reuse opt-in');
assert.equal(schemaAccepts('done_prepare', 'reuseFreshDoneRequired', false), true, 'done_prepare accepts independent DONE-required reuse disable');

// F-245: the compatibility proposal callback must reject an omitted readLog at
// the public CLI schema boundary. The runtime remains responsible for
// validating the provider-authored log's full shape.
assert.equal(schemaAccepts('managed_review_proposal_set', 'readLog', {}), true,
  'managed_review_proposal_set keeps readLog shape validation at the runtime boundary');
assert.match(schemaDescription('managed_review_proposal_set', 'readLog'), /required.*read-log.*coherence/i,
  'managed_review_proposal_set documents readLog as required evidence');
const managedProposalSchema = z.object(findTool('managed_review_proposal_set').schema);
const managedProposalWithoutReadLog = {
  storyId: 'B-schema-smoke',
  providerAgent: 'lattice-review-quality',
  lane: 'lattice-review-quality',
  reviewRunId: 'B-schema-smoke:RR-001',
  conclusion: 'pass',
  note: 'Schema boundary rejects a missing managed proposal read log.',
  readManifest: {},
};
assert.equal(managedProposalSchema.safeParse(managedProposalWithoutReadLog).success, false,
  'managed_review_proposal_set rejects a missing readLog at the CLI schema boundary');
assert.equal(managedProposalSchema.safeParse({ ...managedProposalWithoutReadLog, readLog: {} }).success, true,
  'managed_review_proposal_set accepts a supplied readLog for runtime shape validation');

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

const managedHostRunHelp = runCli(['host_run', '--help']);
assert.doesNotMatch(
  managedHostRunHelp,
  /\bagy\b|antigravity|agyPrintTimeout/i,
  'managed host_run must not advertise the retired argv-only agy execution path',
);
const candidateSpecRouteHelp = runCli(['candidate_spec_route', '--help']);
assert.doesNotMatch(
  candidateSpecRouteHelp,
  /requestAgy|\bagy\b|antigravity/i,
  'candidate_spec_route must not advertise an agy proposer that managed execution cannot launch',
);

const commandHelpExpectations: Array<{ args: string[]; includes: string[] }> = [
  {
    args: ['story_create', '--help'],
    includes: ['Proof-or-Stop', 'proof-or-stop story_create', '--checklist', '--scopeBoundary'],
  },
  {
    args: ['story_advance', '--help'],
    includes: [
      'Proof-or-Stop',
      'proof-or-stop story_advance',
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
    includes: ['Proof-or-Stop', 'proof-or-stop validate', '--story', '--json'],
  },
  {
    args: ['conduit_status', '--help'],
    // B-cdf6 CHK-002: conduit_status has no longHelp block, so its only usage
    // line is the renderer-generated one, which now mirrors the invoked bin.
    includes: ['Proof-or-Stop', 'proof-or-stop conduit_status', '--format'],
  },
];

for (const { args, includes } of commandHelpExpectations) {
  const output = runCli(args);
  for (const expected of includes) {
    assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')} missing ${expected}`);
  }
}

const helpOutput = runCli(['help']);
// B-cdf6 CHK-002: the product name is now Proof-or-Stop (the legacy 'Proofbound'
// spelling was ruled RENAMED, not an approved prose form), and help usage lines
// mirror the invoked bin token.
assert.match(helpOutput, /Proof-or-Stop/, 'help should carry Proof-or-Stop branding');
// The legacy spelling must appear NOWHERE in help output. CHK-006 completed the
// prose sweep, so this is now total rather than banner-only: the literal below is
// deliberately the pre-rename spelling and must NOT be normalized — normalizing it
// would make this line assert the absence of the CURRENT brand, inverting the guard.
assert.doesNotMatch(helpOutput, /Proofbound/, 'help must not print the legacy Proofbound product name anywhere');
assert.doesNotMatch(helpOutput, /Usage: proofOrStop /, 'help must not teach the deprecated bin as the usage form');
assert.match(helpOutput, /host_runtime_probe/, 'proof-or-stop help should include host runtime commands');
assert.match(runCli(['help', '--full']), /antigravity/, 'proof-or-stop help --full should include antigravity host text');

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
