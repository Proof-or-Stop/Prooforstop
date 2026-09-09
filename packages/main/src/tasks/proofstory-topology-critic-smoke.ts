#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { adapterSessionEnv, adapterSessionId, withAdapterSessionEnv } from './adapter-session-env.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import {
  buildReviewerRunBootstrapBody,
  extractTemplateFrontmatter,
  MODULAR_ROLE_BODY_MARKER,
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { exportPublicKeyRaw, importPrivateKeyRaw, signCanonical } from '../core/authority-signing.js';
import {
  findRuntimeArtifactEntry,
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';
import type { AcceptanceVerificationTopologyV1, ChecklistData, ProofStoryContractData, ScopeCheckData, ScopeContractData, StoryInfo, TopologyCriticReceiptV1 } from '../core/types.js';
import { ADAPTER_DIR_NAMES } from '../core/brand-paths.js';
import {
  canonicalTopologyReceiptContext,
  currentImplementationBusinessCommit,
  deriveImplementationProvenance,
  deriveRoleProvenance,
  independenceMatrix,
  issueTopologyCriticReceipt,
  issueTopologyExclusionApproval,
  TOPOLOGY_CRITIC_ROLE,
  TOPOLOGY_EXCLUSION_APPROVER_ROLE,
  topologyDispatchBusinessAuthor,
  verifyTopologyCriticReceipt,
  verifyTopologyExclusionApproval,
} from '../core/topology-critic-receipt.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, '..');
const repositoryRoot = resolve(sourceRoot, '..', '..');
const proofOrStopBin = join(repositoryRoot, 'bin/proof-or-stop.js');
const storyId = 'B-topology-critic-smoke';
const now = '2026-07-22T00:00:00.000Z';
const smokeArgs = process.argv.slice(2);
if (smokeArgs.length > 1 || (smokeArgs.length === 1 && !['--live-happy', '--author-identity'].includes(smokeArgs[0]))) {
  throw new Error(`unsupported proofstory topology critic smoke arguments: ${smokeArgs.join(' ') || '<none>'}`);
}

function assertTopologyCriticHostBootstrap(
  actual: string,
  expected: string,
  file: string,
  host: 'Claude' | 'Codex',
): void {
  assert.equal(actual, expected, `${host} topology critic bootstrap matches the canonical host render`);
  assert.equal(extractTemplateFrontmatter(actual, file).name, TOPOLOGY_CRITIC_ROLE, `${host} bootstrap preserves the topology critic role`);
  assert.ok(actual.includes(buildReviewerRunBootstrapBody(TOPOLOGY_CRITIC_ROLE)), `${host} bootstrap delegates to the canonical review_run_start body`);
  assert.equal(actual.includes(MODULAR_ROLE_BODY_MARKER), false, `${host} bootstrap does not embed the modular role body`);
}
const liveHappy = smokeArgs[0] === '--live-happy';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Synthetic isolated repository: these author spellings are test inputs, not
// the identity used for any product implementation commit in this worktree.
function assertCanonicalBusinessAuthorIdentity(): void {
  const authorRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-topology-author-'));
  const retiredRole = ['lat', 'tice-implementer'].join('');
  const retiredAuthor = `${retiredRole} <${retiredRole}@noreply.local>`;
  const canonicalRole = 'proof-or-stop-implementer';
  const canonicalAuthor = `${canonicalRole} <${canonicalRole}@noreply.local>`;
  try {
    git(authorRoot, ['init', '-b', 'main']);
    git(authorRoot, ['config', 'user.name', retiredRole]);
    git(authorRoot, ['config', 'user.email', `${retiredRole}@noreply.local`]);
    git(authorRoot, ['commit', '--allow-empty', '-m', 'synthetic retired author fixture']);
    assert.throws(() => currentImplementationBusinessCommit(authorRoot), /missing a business commit authored by proof-or-stop-implementer/,
      'a retired author must never be promoted to canonical implementation provenance');
    assert.equal(topologyDispatchBusinessAuthor(authorRoot), retiredAuthor,
      'dispatch author evidence must preserve the real identity rather than remapping a retired spelling');
    git(authorRoot, ['commit', '--allow-empty', `--author=${canonicalAuthor}`, '-m', 'synthetic canonical author fixture']);
    const canonical = currentImplementationBusinessCommit(authorRoot);
    assert.equal(canonical.businessCommitAuthor, canonicalAuthor);
    assert.equal(canonical.businessCommit, git(authorRoot, ['rev-parse', 'HEAD']));
    console.log('topology author identity: retired rejection, raw identity, canonical acceptance PASS');
  } finally {
    rmSync(authorRoot, { recursive: true, force: true });
  }
}

assertCanonicalBusinessAuthorIdentity();
if (smokeArgs[0] === '--author-identity') process.exit(0);

/**
 * `sessionTask` is a task LABEL, not a session id. The signing guard in `deriveRoleProvenance`
 * refuses `explicit-env`, so a fixture cannot name its own session; it names the task it is acting
 * as and lets the adapter derive the id. `sessionIdFor` recomputes that derived value wherever an
 * assertion needs to match it.
 */
function sessionIdFor(root: string, sessionTask: string, agent: string): string {
  return adapterSessionId(root, sessionTask, agent);
}

function asSession<T>(agent: string, sessionTask: string, fn: () => T): T {
  const priorAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = agent;
  resetSessionIdForTest();
  try {
    return withAdapterSessionEnv(sessionTask, agent, () => {
      resetSessionIdForTest();
      try { return fn(); }
      finally { resetSessionIdForTest(); }
    });
  }
  finally {
    if (priorAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT; else process.env.PROOF_OR_STOP_AGENT = priorAgent;
    resetSessionIdForTest();
  }
}

function cli(root: string, command: string, args: Record<string, unknown>, agent?: string, sessionTask?: string): string {
  return execFileSync(process.execPath, [proofOrStopBin, '--root', root, command, JSON.stringify(args)], {
    cwd: root,
    env: {
      ...process.env,
      ...(agent ? { PROOF_OR_STOP_AGENT: agent } : {}),
      ...(sessionTask ? adapterSessionEnv(sessionTask, agent ?? 'main') : {}),
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function resign<T extends { signature: string }>(value: T, privateKey: string): T {
  const { signature: _signature, ...unsigned } = value;
  return { ...value, signature: signCanonical(unsigned, privateKey) };
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-CRITIC', relation: 'producer_to_consumer' as const,
  producer: { id: 'EP-P', role: 'producer' as const, expectedArtifactKind: 'handler' as const, expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produce', fileDeclarationRef: 'CHK-001:files:create:0' },
  consumers: [{ id: 'EP-C', role: 'consumer' as const, expectedArtifactKind: 'handler' as const, expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consume', fileDeclarationRef: 'CHK-001:files:create:1' }],
  outputFactRef: 'process-fact:topology-critic',
};

const topology: AcceptanceVerificationTopologyV1 = {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-1:VPP-CRITIC', endpointRef: 'EP-P' } }],
  consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-1:VPP-CRITIC', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
  positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  commandRefs: [
    { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
    { refKind: 'existing', canonicalSourceRef: 'basis-path:path:static-call:packages/main/src/producer.ts#produce->consumer:packages/main/src/consumer.ts#produce' },
  ],
};

function checklist(): ChecklistData {
  return { items: [{ id: 'CHK-001', title: 'critic', context: 'smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: { happy: [{ id: 'INT-1', desc: 'producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }], edge: [], adversarial: [] },
  }] };
}

function contract(): ProofStoryContractData {
  return { schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'high_assurance', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-1'], milestoneIds: [], verificationTopology: topology }],
    diagnosticGaps: [], createdAt: now, updatedAt: now };
}

function scopeContract(): ScopeContractData {
  return { storyId, mode: 'local', allowedModify: [], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: now, updatedAt: now };
}

function scopeCheck(root: string): ScopeCheckData {
  const base = { storyId, checkedAt: now, reviewRound: '', agentId: 'proof-or-stop-review-scope-plan', issues: [], features: [], summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 } } as unknown as ScopeCheckData;
  const cwd = process.cwd(); process.chdir(root);
  try { return { ...base, _hash: signScopeCheck(storyId, now, 0, 1, '') }; }
  finally { process.chdir(cwd); }
}

function writeDiscoveryRegistration(root: string): void {
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS=[',
    "  {name:'acceptance_basis'},",
    "  {name:'acceptance_basis_generate'},",
    "  {name:'acceptance_topology_check'},",
    "  {name:'topology_critic_receipt_set'},",
    "  {name:'topology_critic_receipt_check'},",
    '];',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/registry.ts', [
    "import {createProofStoryHandlers} from './handlers/proofstory.js';",
    'const registry={registerBatch(_:unknown){}};',
    'const ctx={} as any;',
    'registry.registerBatch(createProofStoryHandlers(ctx));',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/handlers/proofstory.ts', "export function createProofStoryHandlers(){return{acceptance_basis(){},acceptance_basis_generate(){},acceptance_topology_check(){},topology_critic_receipt_set(){},topology_critic_receipt_check(){}}}\n");
  write(root, 'packages/main/src/core/process-fact-registry.ts', "export const facts=['acceptance_basis','acceptance_basis_generate','topology_critic_receipt_set','topology_critic_receipt_check','artifact:acceptance-basis.json'];\n");
  write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['acceptance_basis','acceptance_basis_generate','topology_critic_receipt_set','topology_critic_receipt_check','artifact:acceptance-basis.json'];\n");
  write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology=true;\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const topologyCriticRole=true;\n');
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck=true;\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof=true;\n');
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs', 'export const preReviewLiveProofRunner=true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCriticReceipt=true;\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export const topologyConsumer=true;\n');
  // Acceptance-basis discovery includes the rollout verifier pair in its
  // repository snapshot even though this focused fixture does not exercise
  // rollout behavior. Keep the scratch repository structurally complete so the
  // topology receipt assertions test critic authority rather than snapshot
  // absence.
  write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout=true;\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutRunner=true;\n');
  write(root, 'packages/main/src/core/machine.ts', 'export const machine=true;\n');
  write(root, 'packages/main/src/core/review-inventory-epoch.ts', 'export const reviewInventoryEpoch=true;\n');
  write(root, 'packages/main/src/handlers/review-inventory.ts', 'export const reviewInventory=true;\n');
}

const root = mkdtempSync(join(tmpdir(), 'proofstory-topology-critic-'));
const originalCwd = process.cwd();

/**
 * Session TASK labels. These are inputs to the adapter's derivation, not session ids: the guard in
 * `deriveRoleProvenance` refuses `explicit-env`, so no fixture may name the id it signs under.
 * Distinct labels still yield distinct ids, which is what the independence matrix asserts on.
 */
const CRITIC_SESSION_TASK = 'sess-critic';
const IMPLEMENTER_SESSION_TASK = 'sess-impl';
const SCOPE_SESSION_TASK = 'sess-scope';
const criticSessionId = sessionIdFor(root, CRITIC_SESSION_TASK, TOPOLOGY_CRITIC_ROLE);
const implementerSessionId = sessionIdFor(root, IMPLEMENTER_SESSION_TASK, 'proof-or-stop-implementer');
const scopeSessionId = sessionIdFor(root, SCOPE_SESSION_TASK, TOPOLOGY_EXCLUSION_APPROVER_ROLE);
smokeSuite: try {
  write(root, '.gitignore', [
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
    ...listRuntimeArtifactIgnorePatterns(),
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
    '',
  ].join('\n'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    proofStory: { acceptanceTopologyGateMode: 'enforce' },
  }));
  write(root, 'tsconfig.json', '{}\n');
  writeDiscoveryRegistration(root);
  write(root, 'packages/main/src/producer.ts', 'export const produce=()=>true;\n');
  write(root, 'packages/main/src/consumer.ts', "import {produce} from './producer.js'; export const consume=()=>produce(); export const invokeConsumer=()=>consume();\n");
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Independent Reviewer']);
  git(root, ['config', 'user.email', 'reviewer@noreply.local']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'base']);
  git(root, ['switch', '-c', `story/${storyId}`]);
  write(root, 'packages/main/src/implementation.ts', 'export const implemented=true;\n');
  git(root, ['add', '.']); git(root, ['commit', '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>', '-m', 'implement topology critic fixture']);
  process.chdir(root);

  resetConfigCache();
  const store = new StoryStore(root);
  const story = { storyId, name: storyId, title: 'smoke', description: 'smoke', type: 'feature', priority: 'high', phase: 'PLAN', createdAt: now, startedAt: null, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: now } } as StoryInfo;
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
  store.writeScopeCheck(storyId, scopeCheck(root));
  const reviewAt = '2026-07-22T00:00:01.000Z';
  const reviewHash = createHash('sha256').update(`${storyId}:${reviewAt}:0:0:proof-or-stop-review-integrity-v1`).digest('hex');
  store.writeReview(storyId, { reviews: [{ timestamp: reviewAt, issueCount: 0, blockerCount: 0, issues: [], _hash: reviewHash }] } as any);
  git(root, ['config', 'user.name', 'Scope Reviewer']);
  git(root, ['config', 'user.email', 'scope@noreply.local']);
  cli(root, 'dispatch', { storyId, agentType: TOPOLOGY_EXCLUSION_APPROVER_ROLE }, TOPOLOGY_EXCLUSION_APPROVER_ROLE, SCOPE_SESSION_TASK);
  const planBasisOutput = cli(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.equal(JSON.parse(planBasisOutput).artifact.basis.status, 'complete', planBasisOutput);
  assert.equal(store.readTopologyCriticReceipt(storyId), null, 'Wave 2A receipt is absent before the normal PLAN to DEV transition');
  cli(root, 'dev_memory_preflight_ack', { storyId });
  const planToDevTranscript = cli(root, 'story_advance', { storyId, phase: 'DEV' });
  assert.equal(store.readStory(storyId).phase, 'DEV', planToDevTranscript);
  assert.match(planToDevTranscript, /Acceptance topology check:[\s\S]*mode=enforce; status=pass; structuralPass=true; blocking=false/, 'normal story_advance consumes the existing Wave 2 structural gate');
  assert.doesNotMatch(planToDevTranscript, /topology critic|receipt/i, 'Wave 2A adds no PLAN to DEV receipt requirement');
  const ctx = { root, scanRoot: join(root, 'packages/main'), store };
  const dispatch = createStoryDispatchHandlers(ctx);
  asSession('proof-or-stop-implementer', IMPLEMENTER_SESSION_TASK, () => dispatch.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-implementer' }));
  git(root, ['config', 'user.name', 'Critic Reviewer']);
  git(root, ['config', 'user.email', 'critic@noreply.local']);
  cli(root, 'dispatch', { storyId, agentType: TOPOLOGY_CRITIC_ROLE }, TOPOLOGY_CRITIC_ROLE, CRITIC_SESSION_TASK);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'record story inputs and dispatch provenance']);

  const handlers = createProofStoryHandlers(ctx);
  const basisOutput = planBasisOutput;
  assert.equal(JSON.parse(basisOutput).artifact.basis.status, 'complete', basisOutput);
  const producerOutput = cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, TOPOLOGY_CRITIC_ROLE, CRITIC_SESSION_TASK);
  const producerResult = JSON.parse(producerOutput);
  assert.equal(producerResult.verification.ok, true, producerOutput);
  const checkOutput = cli(root, 'topology_critic_receipt_check', { storyId, json: true });
  const checkResult = JSON.parse(checkOutput);
  assert.equal(checkResult.verification.ok, true, checkOutput);
  if (liveHappy) {
    assert.equal(producerResult.receipt.criticRole, TOPOLOGY_CRITIC_ROLE, 'live critic receipt uses the registered canonical role');
    assert.deepEqual(producerResult.verification.independence, { agent: true, session: true, dispatch: true, businessCommitAuthor: true }, 'live critic remains independent in all four dimensions');
    assert.equal(checkResult.verification.code, 'ok', checkOutput);
    console.log('Topology critic eligibility: PASS role=proof-or-stop-review-topology-critic independence=agent:true,session:true,dispatch:true,businessCommitAuthor:true');
    console.log(`Topology critic receipt: PASS check=${checkResult.verification.code} semanticOk=${checkResult.verification.ok}`);
    break smokeSuite;
  }
  git(root, ['config', 'user.name', 'proof-or-stop-implementer']);
  git(root, ['config', 'user.email', 'proof-or-stop-implementer@noreply.local']);
  cli(root, 'dispatch', { storyId, agentType: TOPOLOGY_CRITIC_ROLE }, TOPOLOGY_CRITIC_ROLE, 'sess-critic-business-collision');
  assert.throws(() => cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, TOPOLOGY_CRITIC_ROLE, 'sess-critic-business-collision'), 'production producer rejects a critic whose real git business author equals the implementer author');
  git(root, ['config', 'user.name', 'Critic Reviewer']);
  git(root, ['config', 'user.email', 'critic@noreply.local']);

  const artifact = store.readAcceptanceBasis(storyId)!;
  const receipt = store.readTopologyCriticReceipt(storyId)!;
  const events = store.readProcessEvents(storyId);
  const context = canonicalTopologyReceiptContext({ storyId, basisStatus: artifact.basis.status, basisDigest: artifact.basis.basisDigest,
    topologyDigest: receipt.topologyDigest, scopeCheckDigest: artifact.basis.binding.scopeCheckDigest,
    ...(artifact.basis.binding.scopeContractDigest ? { scopeContractDigest: artifact.basis.binding.scopeContractDigest } : {}),
    storyFilesHash: artifact.basis.binding.storyFilesHash, closureFilesHash: artifact.basis.binding.closureFilesHash, exclusions: [], findingRefs: [] });
  const implementation = deriveImplementationProvenance(root, events, context);
  const verify = (candidate: TopologyCriticReceiptV1 | null, nextContext = context, approvals: any[] = []) => verifyTopologyCriticReceipt({ gitCwd: root, context: nextContext, receipt: candidate, approvals, implementation, events });
  assert.equal(verify(receipt).ok, true, 'clean production receipt passes');

  const promptEntry = readPromptRegistry(join(sourceRoot, 'templates/agents')).agents.find(entry => entry.agentId === TOPOLOGY_CRITIC_ROLE);
  assert.ok(promptEntry, 'registered topology critic prompt is discoverable');
  assert.equal(extractTemplateFrontmatter(readFileSync(promptEntry!.sourcePath, 'utf8'), promptEntry!.sourcePath).name, TOPOLOGY_CRITIC_ROLE, 'real prompt parser accepts topology critic frontmatter');
  const canonicalPrompt = readFileSync(join(sourceRoot, 'templates/agents/proof-or-stop-review-topology-critic.md'), 'utf8');
  assert.equal(canonicalPrompt.includes(MODULAR_ROLE_BODY_MARKER), true, 'package canonical prompt retains the independently selected modular role body');
  const claudePromptPath = join(repositoryRoot, '.claude/agents/proof-or-stop-review-topology-critic.md');
  const claudeBootstrap = readFileSync(claudePromptPath, 'utf8');
  // B-cc10 F-029: assert against whichever adapter-dir spelling actually exists on disk.
  // This hardcoded the deprecated path against the REAL repo root (not a scratch fixture),
  // so after the rename the readFileSync threw ENOENT instead of comparing anything.
  const codexPromptPath = ADAPTER_DIR_NAMES
    .map((dir) => join(repositoryRoot, `${dir}/agents/proof-or-stop-review-topology-critic.md`))
    .find((candidate) => existsSync(candidate));
  assert.ok(codexPromptPath, `no Codex prompt mirror found under any of: ${ADAPTER_DIR_NAMES.join(', ')}`);
  const codexBootstrap = readFileSync(codexPromptPath, 'utf8');
  const expectedClaudeBootstrap = renderPromptEntryForHost(promptEntry!, 'claude');
  const expectedCodexBootstrap = renderPromptEntryForHost(promptEntry!, 'codex');
  assertTopologyCriticHostBootstrap(claudeBootstrap, expectedClaudeBootstrap, claudePromptPath, 'Claude');
  assertTopologyCriticHostBootstrap(codexBootstrap, expectedCodexBootstrap, codexPromptPath, 'Codex');
  assert.equal(
    claudeBootstrap === codexBootstrap,
    expectedClaudeBootstrap === expectedCodexBootstrap,
    'host bootstrap equality follows the canonical host renderers and does not require artificial byte differences',
  );
  assert.notEqual(claudeBootstrap, canonicalPrompt, 'host bootstrap remains distinct from the package canonical full template');

  const delegationBody = buildReviewerRunBootstrapBody(TOPOLOGY_CRITIC_ROLE);
  assert.throws(
    () => assertTopologyCriticHostBootstrap(claudeBootstrap.replace(delegationBody, ''), expectedClaudeBootstrap, claudePromptPath, 'Claude'),
    'missing review_run_start delegation bites the host bootstrap contract',
  );
  assert.throws(
    () => assertTopologyCriticHostBootstrap(claudeBootstrap.replace('review_run_start', 'review_run_begin'), expectedClaudeBootstrap, claudePromptPath, 'Claude'),
    'malformed review_run_start delegation bites the host bootstrap contract',
  );
  assert.throws(
    () => assertTopologyCriticHostBootstrap(`${claudeBootstrap}${canonicalPrompt}`, expectedClaudeBootstrap, claudePromptPath, 'Claude'),
    'injecting the full modular role body bites the body-free host bootstrap contract',
  );

  const topLevelFields = ['schemaVersion', 'storyId', 'criticIdentity', 'criticRole', 'criticProvenance', 'implementationProvenance', 'basisDigest', 'topologyDigest', 'scopeCheckDigest', 'scopeContractDigest', 'storyFilesHash', 'closureFilesHash', 'findingRefs', 'approvedExclusionRefs', 'verdict', 'issuedAt', 'signerPublicKey', 'signature'] as const satisfies readonly (keyof TopologyCriticReceiptV1)[];
  assert.deepEqual([...topLevelFields].sort(), Object.keys(receipt).sort(), 'receipt field inventory stays exact with the actual TopologyCriticReceiptV1 artifact');
  for (const field of topLevelFields) {
    const changed = structuredClone(receipt) as any;
    if (field === 'signature') changed[field] = 'forged';
    else if (field === 'findingRefs' || field === 'approvedExclusionRefs') changed[field] = ['forged'];
    else if (field === 'criticProvenance' || field === 'implementationProvenance') changed[field] = { ...changed[field], sessionId: 'forged' };
    else if (field === 'scopeContractDigest') changed[field] = 'sha256:forged';
    else changed[field] = `${String(changed[field])}-forged`;
    assert.equal(verify(changed).ok, false, `tampering ${field} must fail`);
    const deleted = structuredClone(receipt) as any;
    delete deleted[field];
    assert.equal(verify(deleted).ok, false, `deleting ${field} must fail`);
  }

  const commonDirRaw = git(root, ['rev-parse', '--git-common-dir']);
  const commonDir = resolve(root, commonDirRaw);
  const criticPrivateKey = readFileSync(join(commonDir, `proofstory-${TOPOLOGY_CRITIC_ROLE}-v1.key`), 'utf8').trim();
  const untrustedPrivateKey = randomBytes(32).toString('base64');
  const untrusted = structuredClone(receipt);
  untrusted.signerPublicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(untrustedPrivateKey)));
  assert.equal(verify(resign(untrusted, untrustedPrivateKey)).ok, false, 'payload re-signed by an untrusted key fails');
  for (const field of ['storyId', 'criticIdentity', 'issuedAt'] as const) {
    const replay = structuredClone(receipt) as any;
    replay[field] = `${replay[field]}-other`;
    replay.signature = receipt.signature;
    assert.equal(verify(replay).ok, false, `cross-${field} signature replay fails`);
  }

  const criticProvenanceDimensions = [
    ['agent', 'agentId'],
    ['session', 'sessionId'],
    ['dispatch', 'dispatchId'],
    ['businessCommitAuthor', 'businessCommitAuthor'],
  ] as const;
  const actorProvenanceFields = [
    ['agentId', 'agent'],
    ['sessionId', 'session'],
    ['dispatchId', 'dispatch'],
    ['storyId', 'storyId'],
    ['headHash', 'headHash'],
    ['storyFilesHash', 'storyFilesHash'],
    ['businessCommit', 'businessCommit'],
    ['businessCommitAuthor', 'businessCommitAuthor'],
    ['businessCommitAuthorSource', 'businessCommitAuthorSource'],
    ['businessIdentity', 'businessIdentity'],
  ] as const;
  for (const [dimension, field] of criticProvenanceDimensions) {
    for (const missingValue of [undefined, ''] as const) {
      const missing = structuredClone(receipt) as any;
      if (missingValue === undefined) delete missing.criticProvenance[field];
      else missing.criticProvenance[field] = missingValue;
      const result = verify(resign(missing, criticPrivateKey));
      assert.equal(result.ok, false, `verifier rejects ${missingValue === undefined ? 'missing' : 'blank'} critic ${dimension} provenance`);
      assert.ok(result.diagnostics.includes(`topology critic provenance missing or unverifiable: ${dimension}`), `verifier emits field-specific ${dimension} provenance diagnostic`);
      assert.deepEqual(Object.entries(result.independence).filter(([, ok]) => !ok).map(([name]) => name), [dimension], `only missing critic ${dimension} fails the 4D independence projection`);
    }
    const unverifiable = structuredClone(receipt) as any;
    unverifiable.criticProvenance[field] = `unverifiable-${dimension}`;
    const unverifiableResult = verify(resign(unverifiable, criticPrivateKey));
    assert.equal(unverifiableResult.ok, false, `verifier rejects unverifiable critic ${dimension} provenance`);
    assert.ok(unverifiableResult.diagnostics.includes(`topology critic provenance missing or unverifiable: ${dimension}`), `verifier identifies unverifiable ${dimension} against registered dispatch`);
    const collided = structuredClone(receipt) as any;
    collided.criticProvenance[field] = implementation[field];
    const collisionResult = verify(resign(collided, criticPrivateKey));
    assert.equal(collisionResult.ok, false, `freshly re-signed critic ${dimension} collision fails verifier`);
    assert.ok(collisionResult.diagnostics.includes(`topology critic independence failed: ${dimension}`), `verifier emits dimension-specific critic ${dimension} collision`);
  }
  for (const [field, diagnosticName] of actorProvenanceFields) {
    const tampered = structuredClone(receipt) as any;
    tampered.criticProvenance[field] = `${String(tampered.criticProvenance[field])}-tampered`;
    const result = verify(resign(tampered, criticPrivateKey));
    assert.equal(result.ok, false, `trusted-key re-signed critic provenance mutation fails: ${field}`);
    assert.ok(result.diagnostics.includes(`topology critic provenance missing or unverifiable: ${diagnosticName}`), `critic provenance mutation identifies ${field}`);
  }
  assert.equal(verify(receipt).ok, true, 'unchanged critic provenance control remains valid after full nested-field mutation table');
  for (const [dimension, field] of criticProvenanceDimensions) {
    for (const replacement of [undefined, '', `unverifiable-${dimension}`] as const) {
      const malformed = structuredClone(receipt) as any;
      if (replacement === undefined) delete malformed.implementationProvenance[field];
      else malformed.implementationProvenance[field] = replacement;
      const result = verify(resign(malformed, criticPrivateKey));
      assert.equal(result.ok, false, `verifier rejects ${replacement === undefined ? 'missing' : replacement === '' ? 'blank' : 'unverifiable'} implementation ${dimension} provenance`);
      assert.ok(result.diagnostics.includes(`implementation provenance missing or unverifiable: ${dimension}`), `verifier emits field-specific implementation ${dimension} provenance diagnostic`);
    }
  }
  const noEventsCritic = verifyTopologyCriticReceipt({ gitCwd: root, context, receipt, approvals: [], implementation, events: undefined } as any);
  assert.equal(noEventsCritic.ok, false, 'critic verifier fails closed without registered dispatch events');
  for (const [dimension] of criticProvenanceDimensions) {
    assert.ok(noEventsCritic.diagnostics.includes(`topology critic provenance missing or unverifiable: ${dimension}`), `no-events critic diagnostic covers ${dimension}`);
  }

  const canonicalContext = canonicalTopologyReceiptContext({ ...context, findingRefs: ['B-2', 'B-1', 'B-1'] });
  const canonicalReceipt = issueTopologyCriticReceipt({ gitCwd: root, context: canonicalContext, critic: receipt.criticProvenance, implementation, approvals: [], events, verdict: 'pass' });
  assert.deepEqual(canonicalReceipt.findingRefs, ['B-1', 'B-2'], 'producer canonicalizes finding refs');
  for (const refs of [['B-1'], ['B-1', 'B-2', 'B-2'], ['B-1', 'B-2', 'B-nonexistent']] as string[][]) {
    const malformed = resign({ ...canonicalReceipt, findingRefs: refs }, criticPrivateKey);
    assert.equal(verifyTopologyCriticReceipt({ gitCwd: root, context: canonicalContext, receipt: malformed, approvals: [], implementation, events }).ok, false, `finding ref omission/duplicate/invention fails: ${refs.join(',')}`);
  }

  assert.throws(() => deriveImplementationProvenance(root, events.filter(event => event.agentType !== 'proof-or-stop-implementer'), context), /missing a session-bound/);
  for (const missingField of ['headHash', 'businessCommitAuthor', 'storyFilesHash'] as const) {
    const brokenEvents = structuredClone(events);
    const event = [...brokenEvents].reverse().find(candidate => candidate.agentType === TOPOLOGY_CRITIC_ROLE && candidate.sessionId === criticSessionId)!;
    delete (event as any)[missingField];
    assert.throws(() => deriveRoleProvenance({ gitCwd: root, events: brokenEvents, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: criticSessionId, sessionSource: 'host-adapter', context, implementation }), /no current registered dispatch provenance|missing or unverifiable/);
  }
  for (const field of ['basisDigest', 'topologyDigest', 'scopeCheckDigest', 'scopeContractDigest', 'storyFilesHash', 'closureFilesHash'] as const) {
    const drifted = { ...context, [field]: 'sha256:drift' };
    assert.equal(verify(receipt, drifted).ok, false, `${field} freshness drift must fail`);
  }
  for (const dimension of ['agentId', 'sessionId', 'dispatchId', 'businessCommitAuthor'] as const) {
    const collided = { ...receipt.criticProvenance, [dimension]: implementation[dimension] };
    assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context, critic: collided, implementation, approvals: [], events, verdict: 'pass' }), /independence failed/, `${dimension} collision must fail before signing`);
  }
  assert.deepEqual(independenceMatrix(receipt.criticProvenance, implementation), { agent: true, session: true, dispatch: true, businessCommitAuthor: true });
  assert.throws(() => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: 'proof-or-stop-review-topology-critic-spoof', sessionId: criticSessionId, sessionSource: 'host-adapter', context, implementation }), /role eligibility failed/);
  assert.throws(() => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: implementerSessionId, sessionSource: 'host-adapter', context, implementation }), /no current registered dispatch provenance/);

  // CHK-003 / CHK-005: the signing guard bites on session SOURCE, independently of every other
  // eligibility check above. Same role, same registered dispatch, same session id — only the
  // source differs. Accepted sources are hash-derived behind a provider+task+agent gate; refused
  // ones are mintable by the party under review.
  for (const refusedSource of ['explicit-env', 'derived-ppid'] as const) {
    assert.throws(
      () => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: criticSessionId, sessionSource: refusedSource, context, implementation }),
      new RegExp(`must sign from a host-adapter session, received "${refusedSource}"`),
      `${refusedSource} is forgeable and must not sign a topology receipt`,
    );
    assert.throws(
      () => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE, actor: TOPOLOGY_EXCLUSION_APPROVER_ROLE, sessionId: scopeSessionId, sessionSource: refusedSource, context, implementation }),
      new RegExp(`must sign from a host-adapter session, received "${refusedSource}"`),
      `${refusedSource} is forgeable and must not sign an exclusion approval`,
    );
  }
  for (const acceptedSource of ['host-adapter', 'generated-token'] as const) {
    assert.equal(
      deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: criticSessionId, sessionSource: acceptedSource, context, implementation }).sessionId,
      criticSessionId,
      `${acceptedSource} clears the same provider+task+agent gate and must still sign`,
    );
  }
  assert.equal(verify(receipt, { ...context, basisStatus: 'partial' }).ok, false, 'critic cannot override partial');
  assert.equal(verify(receipt, { ...context, basisStatus: 'unsupported' }).ok, false, 'critic cannot override unsupported');

  const basisPath = join(root, '.proof-or-stop/story/actives', storyId, 'acceptance-basis.json');
  const cleanBasisBytes = readFileSync(basisPath, 'utf8');
  rmSync(basisPath);
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, false, 'missing basis fails production CLI verification');
  writeFileSync(basisPath, cleanBasisBytes, 'utf8');
  const tamperedBasis = JSON.parse(cleanBasisBytes); tamperedBasis.basis.basisDigest = 'sha256:tampered';
  writeFileSync(basisPath, JSON.stringify(tamperedBasis, null, 2) + '\n', 'utf8');
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, false, 'tampered basis fails production CLI verification');
  writeFileSync(basisPath, cleanBasisBytes, 'utf8');
  const cleanConsumerBytes = readFileSync(join(root, 'packages/main/src/consumer.ts'), 'utf8');
  writeFileSync(join(root, 'packages/main/src/consumer.ts'), `${cleanConsumerBytes}// drift\n`, 'utf8');
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, false, 'stale source/basis binding fails production CLI verification');
  writeFileSync(join(root, 'packages/main/src/consumer.ts'), cleanConsumerBytes, 'utf8');
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, true, 'exact basis/source restoration returns production CLI verification to pass');

  const scopeActor = deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE, actor: TOPOLOGY_EXCLUSION_APPROVER_ROLE, sessionId: scopeSessionId, sessionSource: 'host-adapter', context, implementation });
  const criticActor = receipt.criticProvenance;
  const excludedContext = canonicalTopologyReceiptContext({ ...context, exclusions: [{ pathRef: 'scope:C2', decisionRef: 'decision:C2' }] });
  const approval = issueTopologyExclusionApproval({ gitCwd: root, context: excludedContext, exclusionRef: 'decision:C2', actor: scopeActor, implementation });
  const excludedReceipt = issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [approval], events, verdict: 'pass' });
  assert.equal(verify(excludedReceipt, excludedContext, [approval]).ok, true, 'one-to-one independent exclusion passes');
  assert.deepEqual(verifyTopologyExclusionApproval({ gitCwd: root, context: excludedContext, approval, implementation, critic: criticActor, events }), [], 'distinct scope-plan approver passes direct production verification');
  const noEventsApproval = verifyTopologyExclusionApproval({ gitCwd: root, context: excludedContext, approval, implementation, critic: criticActor, events: undefined } as any);
  for (const [dimension] of criticProvenanceDimensions) {
    assert.ok(noEventsApproval.includes(`exclusion approver provenance missing or unverifiable: ${dimension}`), `no-events exclusion approval diagnostic covers ${dimension}`);
  }
  const scopePrivateKey = readFileSync(join(commonDir, `proofstory-${TOPOLOGY_EXCLUSION_APPROVER_ROLE}-v1.key`), 'utf8').trim();
  for (const [field, diagnosticName] of actorProvenanceFields) {
    const tampered = structuredClone(approval) as any;
    tampered.approverProvenance[field] = `${String(tampered.approverProvenance[field])}-tampered`;
    const diagnostics = verifyTopologyExclusionApproval({
      gitCwd: root,
      context: excludedContext,
      approval: resign(tampered, scopePrivateKey),
      implementation,
      critic: criticActor,
      events,
    });
    assert.ok(diagnostics.includes(`exclusion approver provenance missing or unverifiable: ${diagnosticName}`), `trusted-key re-signed exclusion approver provenance mutation identifies ${field}`);
  }
  assert.deepEqual(verifyTopologyExclusionApproval({ gitCwd: root, context: excludedContext, approval, implementation, critic: criticActor, events }), [], 'unchanged exclusion approver provenance control remains valid after full nested-field mutation table');
  for (const [dimension, field] of criticProvenanceDimensions) {
    const implementationCollision = structuredClone(approval) as any;
    implementationCollision.approverProvenance[field] = implementation[field];
    const implementationCollisionDiagnostics = verifyTopologyExclusionApproval({
      gitCwd: root,
      context: excludedContext,
      approval: resign(implementationCollision, scopePrivateKey),
      implementation,
      critic: criticActor,
      events,
    });
    assert.ok(implementationCollisionDiagnostics.includes(`exclusion approver is not independent: ${dimension}`), `re-signed exclusion verifier rejects approver-vs-implementer ${dimension} collision`);

    const criticCollision = structuredClone(approval) as any;
    criticCollision.approverProvenance[field] = criticActor[field];
    const criticCollisionDiagnostics = verifyTopologyExclusionApproval({
      gitCwd: root,
      context: excludedContext,
      approval: resign(criticCollision, scopePrivateKey),
      implementation,
      critic: criticActor,
      events,
    });
    assert.ok(criticCollisionDiagnostics.includes('exclusion approver is not independent from topology critic'), `re-signed exclusion verifier rejects approver-vs-critic ${dimension} collision`);
  }
  assert.throws(() => cli(root, 'topology_exclusion_approval_set', { storyId, exclusionRef: 'decision:C2', json: true }, 'proof-or-stop-implementer', IMPLEMENTER_SESSION_TASK), 'implementer cannot exercise exclusion approval authority');
  assert.throws(() => cli(root, 'topology_exclusion_approval_set', { storyId, exclusionRef: 'decision:C2', json: true }, TOPOLOGY_CRITIC_ROLE, CRITIC_SESSION_TASK), 'ineligible critic role cannot exercise scope-plan exclusion authority');
  for (const [, field] of criticProvenanceDimensions) {
    const collidedApprover = { ...scopeActor, [field]: implementation[field] };
    assert.throws(
      () => issueTopologyExclusionApproval({ gitCwd: root, context: excludedContext, exclusionRef: 'decision:C2', actor: collidedApprover, implementation }),
      /independence failed/,
      `exclusion authority rejects approver ${field} collision with implementation before signing`,
    );
  }
  assert.equal(verify(receipt, context, []).ok, true, 'zero-exclusion control does not fabricate an approval requirement');
  const multipleContext = canonicalTopologyReceiptContext({ ...context, exclusions: [
    { pathRef: 'scope:C2', decisionRef: 'decision:C2' },
    { pathRef: 'scope:C3', decisionRef: 'decision:C3' },
  ] });
  const approvals = multipleContext.exclusions.map(exclusion => issueTopologyExclusionApproval({ gitCwd: root, context: multipleContext, exclusionRef: exclusion.decisionRef, actor: scopeActor, implementation }));
  const multipleReceipt = issueTopologyCriticReceipt({ gitCwd: root, context: multipleContext, critic: criticActor, implementation, approvals, events, verdict: 'pass' });
  assert.equal(verify(multipleReceipt, multipleContext, approvals).ok, true, 'multiple exclusions require and accept exact one-to-one approvals');
  assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [], events, verdict: 'pass' }), /one-to-one/);
  assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [approval, approval], events, verdict: 'pass' }), /one-to-one/);
  assert.equal(verify(excludedReceipt, excludedContext, []).ok, false, 'missing approval fails persisted verification');
  const forgedApproval = structuredClone(approval); forgedApproval.scopeRef = 'scope:forged';
  assert.equal(verify(excludedReceipt, excludedContext, [forgedApproval]).ok, false, 'forged approval fails');
  for (const refs of [[], [approval.approvalRef, approval.approvalRef], ['TEA-nonexistent']] as string[][]) {
    const malformed = resign({ ...excludedReceipt, approvedExclusionRefs: refs }, criticPrivateKey);
    assert.equal(verify(malformed, excludedContext, [approval]).ok, false, `approval ref omission/duplicate/invention fails: ${refs.join(',') || '<empty>'}`);
  }
  assert.equal(verify(excludedReceipt, { ...excludedContext, storyId: 'B-cross-story' }, [approval]).ok, false, 'cross-story approval fails');
  assert.equal(verify(excludedReceipt, { ...excludedContext, basisDigest: 'sha256:stale' }, [approval]).ok, false, 'stale approval fails');
  assert.equal(verify(excludedReceipt, { ...excludedContext, exclusions: [{ pathRef: 'scope:orphan', decisionRef: 'decision:orphan' }] }, [approval]).ok, false, 'orphan approval fails');
  const criticCollidingApprover = { ...scopeActor, sessionId: criticActor.sessionId };
  const criticCollidingApproval = issueTopologyExclusionApproval({ gitCwd: root, context: excludedContext, exclusionRef: 'decision:C2', actor: criticCollidingApprover, implementation });
  assert.ok(verifyTopologyCriticReceipt({ gitCwd: root, context: excludedContext, receipt: excludedReceipt, approvals: [criticCollidingApproval], implementation, events }).diagnostics.some(item => item.includes('not independent from topology critic')), 'approver-vs-critic session collision fails');
  assert.throws(() => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: scopeSessionId, sessionSource: 'host-adapter', context, implementation }), /role eligibility failed/, 'forged scope-plan label fails');
  assert.throws(() => cli(root, 'topology_exclusion_approval_set', { storyId, exclusionRef: 'decision:nonexistent', json: true }, TOPOLOGY_EXCLUSION_APPROVER_ROLE, SCOPE_SESSION_TASK), 'production CLI rejects nonexistent exclusion approval');
  assert.equal(verify(excludedReceipt, excludedContext, [approval]).ok, true, 'exact restoration passes without residue');

  git(root, ['commit', '--allow-empty', '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>', '-m', 'new implementation business commit']);
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, false, 'old dispatch and receipt cannot replay across a new business commit');
  git(root, ['config', 'user.name', 'Critic Reviewer']);
  git(root, ['config', 'user.email', 'critic@noreply.local']);
  cli(root, 'dispatch', { storyId, agentType: TOPOLOGY_CRITIC_ROLE }, TOPOLOGY_CRITIC_ROLE, 'sess-critic-fresh');
  const refreshed = JSON.parse(cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, TOPOLOGY_CRITIC_ROLE, 'sess-critic-fresh'));
  assert.equal(refreshed.verification.ok, true, 'fresh current-commit dispatch can re-attest after replay rejection');
  assert.equal(JSON.parse(cli(root, 'topology_critic_receipt_check', { storyId, json: true })).verification.ok, true, 'fresh receipt restores production verification after business-commit replay mutation');

  const handlerSource = readFileSync(join(sourceRoot, 'src/handlers/proofstory.ts'), 'utf8');
  const catalogSource = readFileSync(join(sourceRoot, 'src/cli/command-catalog.ts'), 'utf8');
  for (const forbidden of ['evaluatePlannedToActual', 'selective_applicability_check', 'rollout_telemetry']) {
    assert.equal(handlerSource.includes(forbidden) || catalogSource.includes(forbidden), false, `Wave 3 must not leak ${forbidden}`);
  }
  for (const mutation of ['drop-topology-critic-prompt', 'drop-topology-critic-handler', 'drop-topology-critic-cli-schema', 'drop-topology-critic-verifier', 'add-topology-critic-lifecycle-consumer', 'weaken-topology-critic-incomplete-basis']) {
    assert.throws(() => execFileSync(process.execPath, [join(repositoryRoot, 'scripts/verify-process-fact-contract.mjs')], {
      cwd: repositoryRoot,
      env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }), `process-fact mutation ${mutation} must bite`);
  }
  assert.equal(findRuntimeArtifactEntry('.proof-or-stop/activity.jsonl')?.id, 'runtime-activity-log', 'activity log is classified by the production runtime-artifact registry');
  assert.equal(git(root, ['ls-files', '.proof-or-stop/activity.jsonl']), '', 'runtime activity log is never tracked in the business baseline');
  execFileSync('git', ['check-ignore', '-q', '.proof-or-stop/activity.jsonl'], { cwd: root, stdio: 'ignore' });
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', `.proof-or-stop/story/actives/${storyId}/topology-critic-receipt.json`], { cwd: root, stdio: 'ignore' }), 'gate-consumed critic proof remains visible rather than hidden by a broad .proof-or-stop ignore');
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', `.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`], { cwd: root, stdio: 'ignore' }), 'gate-consumed basis proof remains visible rather than hidden by a broad .proof-or-stop ignore');
  const persistedReceiptBytes = readFileSync(join(root, '.proof-or-stop/story/actives', storyId, 'topology-critic-receipt.json'), 'utf8');
  assert.doesNotMatch(persistedReceiptBytes, /forged|tampered|nonexistent/, 'no forged or mutated critic proof remains reusable');
  assert.equal(store.readTopologyExclusionApprovals(storyId).approvals.length, 0, 'no synthetic exclusion approval remains persisted');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '', 'all proof mutations restore exactly; only registered ignored runtime artifacts may remain');
  assert.ok(existsSync(join(sourceRoot, 'src/core/topology-critic-receipt.ts')));
  console.log('ProofStory topology critic smoke: PASS');
  console.log('  real PLAN to DEV structural gate transcript without critic receipt requirement: PASS');
  console.log('  real bin/proof-or-stop dispatch + producer + read-only CLI verifier: PASS');
  console.log('  alter/delete fields, signatures, provenance, freshness, replay, canonical refs: PASS');
  console.log('  zero/one/multiple exclusions + authority/freshness/one-to-one + restoration: PASS');
  console.log('  prompt/schema/handler/verifier/no-lifecycle-gate/incomplete-basis mutations: PASS');
  console.log('  Wave 3/3A/4 leakage: absent');
} finally {
  resetConfigCache();
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
