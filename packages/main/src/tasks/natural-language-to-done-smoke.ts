#!/usr/bin/env node

// =============================================================================
// M15 — Natural-Language-To-DONE E2E
//
// Proves the WHOLE Stage B loop end to end through the REAL planner handler:
//
//   natural-language request (one sentence AND requestFile)
//     -> planner draft + adversarial review
//     -> real Lattice Story created/reused
//     -> typed Authority JobPlan (plannedSteps[])
//     -> executePlannedSteps: provider (fake deterministic) -> validate ->
//        evidence/run-events upload -> gate.evaluate -> native gate_decision
//        receipt verification
//     -> final JSON: authorityDone / fullAuthorityDone or a precise blocked stop.
//
// The Authority server is the only thing stubbed, through the SAME injectable seam
// production uses (`resolveAuthorityGateEvaluator`'s `{ env, fetchImpl, now }`,
// surfaced on HandlerContext.authorityGateOptions). The stub mints a properly
// Ed25519-signed native receipt bound to the planner-generated project/story — the
// verifier still runs for real. Injecting the seam never relaxes the gate: the
// blocked and reject scenarios below prove authority DONE stays fail-closed without
// a verified receipt.
//
// Source-Aligned Redevelopment is covered as a local E2E: the workflow runs to a
// completed plannedSteps execution but is NEVER redevelopment-DONE-eligible, because
// the deterministic projection captures no target-runnable parity evidence (no
// overclaim when the target adapter / parity oracle cannot be run).
// =============================================================================

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { createPlannerHandlers } from '../handlers/planner.js';
import type { HandlerContext } from '../handlers/context.js';
import { buildPlannerDraft, buildJobPlan, type PlannerStoreLike } from '../core/planner.js';
import { buildGateEvidenceRefResolver } from '../core/evidence-uploader.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import type { BoundedProviderExecutor, ProviderExecRequest } from '../providers/types.js';
import type { GitRunner } from '../core/worktree-policy.js';
import { resolveAuthorityGateEvaluator, type AuthorityFetch, type AuthorityGateEvaluatorOptions } from '../core/authority-client.js';
import {
  canonicalDigest,
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';

type JsonObject = Record<string, any>;

const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
const SERVER_KEY_ID = 'server-key-m15';

const keypair = generateEd25519KeyPair();
const serverPublicKeyHex = Buffer.from(keypair.publicKey, 'base64').toString('hex');
const runnerActorKeypair = generateEd25519KeyPair();
const gateActorKeypair = generateEd25519KeyPair();

const root = mkdtempSync(join(tmpdir(), 'lattice-nl-to-done-'));

function writeConfig(): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/requirements/decisions/lattice-authority-live-integration.md'), '# Requirements\n');
  resetConfigCache();
}

/** A real handler context (real Story store), with an optional authority gate seam. */
function makeContext(authorityGateOptions?: AuthorityGateEvaluatorOptions): HandlerContext {
  const config = loadConfig(root);
  return {
    store: new StoryStore(root),
    root,
    scanRoot: join(root, config.scanRoot),
    authorityGateOptions,
  };
}

function planner(authorityGateOptions?: AuthorityGateEvaluatorOptions) {
  return createPlannerHandlers(makeContext(authorityGateOptions));
}

function authorityEnv(): Record<string, string | undefined> {
  return {
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.test',
    LATTICE_AUTHORITY_SERVER_KEY_ID: SERVER_KEY_ID,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    LATTICE_AUTHORITY_ACTOR_ID: 'lattice-runner-m15',
    LATTICE_AUTHORITY_ACTOR_ROLE: 'runner',
    LATTICE_AUTHORITY_ACTOR_KEY: runnerActorKeypair.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_GATE_ACTOR_ID: 'lattice-main-m15',
    LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
    LATTICE_AUTHORITY_GATE_ACTOR_KEY: gateActorKeypair.privateKey,
    LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
  };
}

/** Sign a native gate_decision receipt bound to the exact gate input being evaluated. */
function signReceipt(projectId: string, storyId: string, decisionDigest: string, inputDigest: string): JsonObject {
  const base: JsonObject & { signature?: string } = {
    receiptId: `rcpt-${storyId}`,
    kind: 'gate_decision',
    projectId,
    storyId,
    actorId: 'lattice-authority-server',
    role: 'server',
    stateVersion: 1,
    policyVersion: 'policy-v1',
    inputDigest,
    decisionDigest,
    issuedAt: FIXED_NOW.toISOString(),
    serverKeyId: SERVER_KEY_ID,
  };
  const signature = Buffer.from(signCanonical(stripSignature(base), keypair.privateKey), 'base64').toString('hex');
  return { ...base, signature };
}

function compareJsonKeyByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const max = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (aPoints[index]?.codePointAt(0) ?? 0) - (bPoints[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

function normalizePythonDigestJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizePythonDigestJson).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareJsonKeyByCodePoint(a, b))) {
      const normalized = normalizePythonDigestJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function authorityReceiptInputDigest(decision: JsonObject): string {
  const input: JsonObject = { ...decision };
  if (input.repo && typeof input.repo === 'object' && !Array.isArray(input.repo)) {
    const raw = input.repo as JsonObject;
    input.repo = {
      headHash: raw.headHash,
      materialHash: raw.materialHash,
      baseHash: raw.baseHash ?? null,
      treeHash: raw.treeHash ?? null,
      diffHash: raw.diffHash ?? null,
      manifestHash: raw.manifestHash ?? null,
      dirty: raw.dirty ?? false,
    };
  }
  return createHash('sha256').update(JSON.stringify(normalizePythonDigestJson(input)), 'utf8').digest('hex');
}

/**
 * A stub Authority server. Accepts run-events + evidence uploads, then answers the
 * gate evaluate call. For `approve` it mints a verified native receipt bound to the
 * exact project/story in the gate request; for `reject` it returns a bare verdict
 * (no receipt) so the verifier — and thus authority DONE — fails closed.
 */
function authorityFetch(decision: 'approve' | 'reject'): AuthorityFetch {
  return async (input, init) => {
    const url = String(input);
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (url.endsWith('/events') && init.method === 'POST') return ok({});
    if (url.includes('/v1/evidence/batch') && init.method === 'POST') {
      return ok({ accepted: true, results: [{ accepted: true }] });
    }
    if (url.includes('/v1/gates/evaluate') && init.method === 'POST') {
      if (decision === 'reject') {
        return ok({ decision: 'reject', reason: 'validation evidence insufficient for authority DONE' });
      }
      const req = JSON.parse(init.body ?? '{}') as {
        projectId?: string;
        storyId?: string;
        gateInputDigest?: string;
        decision?: { projectId?: string; storyId?: string; decisionId?: string };
      };
      const projectId = req.decision?.projectId ?? req.projectId;
      const storyId = req.decision?.storyId ?? req.storyId;
      const decisionPayload = (req.decision && typeof req.decision === 'object') ? req.decision as JsonObject : {};
      const gateInputDigest = decisionPayload.decisionId ?? req.gateInputDigest ?? '';
      assert(projectId, 'signed gate envelope must bind projectId');
      assert(storyId, 'signed gate envelope must bind storyId');
      const decisionDigest = canonicalDigest({ approve: true, gateInputDigest });
      const receipt = signReceipt(projectId, storyId, decisionDigest, authorityReceiptInputDigest(decisionPayload));
      return ok({ decision: 'approve', decisionDigest, receipt });
    }
    throw Object.assign(new Error(`network must not be called: ${init.method} ${url}`), { code: 'ENONET' });
  };
}

const noNetworkFetch: AuthorityFetch = async (input, init) => {
  throw Object.assign(new Error(`network must not be called: ${init.method} ${String(input)}`), { code: 'ENONET' });
};

function gateOptions(decision: 'approve' | 'reject'): AuthorityGateEvaluatorOptions {
  return { env: authorityEnv(), fetchImpl: authorityFetch(decision), now: () => FIXED_NOW };
}

try {
  writeConfig();

  // === 1. One-sentence NL request -> per-run authorityDone, final DONE still gated ===
  const oneSentence = 'Add a bounded unattended health-check command with validation evidence';
  const approveRun = planner(gateOptions('approve')).planner_run({
    request: oneSentence,
    mode: 'authority',
    until: 'DONE',
    projectId: 'proj-m15',
    allowUnattendedPlanning: true,
    json: true,
  }) as Promise<JsonObject>;
  const approved = await approveRun;
  assert.equal(approved.schemaVersion, 'lattice.planner_run.v1');
  assert.equal(approved.status, 'blocked', 'a verified native gate_decision receipt unlocks per-run authorityDone, but final DONE waits for multi-host certification');
  assert.match(approved.storyId, /^B-[0-9a-f]{4,6}$/i, 'the NL request creates a real Lattice Story');
  assert.equal(approved.jobPlan.storyId, approved.storyId, 'the JobPlan binds the created Story');
  assert.equal(approved.jobPlan.mode, 'authority');
  const exec = approved.execution as JsonObject;
  assert.equal(exec.storyId, approved.storyId, 'plannedSteps execution binds the same Story end to end');
  assert.equal(exec.receiptVerified, true, 'the executor surfaces the verified native gate_decision receipt');
  assert.equal(exec.authorityDone, true, 'per-run authorityDone is projected ONLY on the verified receipt + completed run');
  assert.equal(exec.fullAuthorityDone, false, 'fullAuthorityDone stays false: multi-host certification is owned elsewhere');
  assert.equal(exec.multiHostVerified, false, 'a single authority run never claims multi-host verification');
  assert.equal(exec.localDone, false, 'an authority job never claims local lifecycle DONE');

  // The single fail-closed completion verdict is surfaced in planner run JSON and is
  // the canonical source of authorityDone / fullAuthorityDone. The per-run authority
  // gate passed on a verified native receipt (authorityDone=true), but full authority
  // DONE additionally requires the policy's multi-host reconciliation, which planner
  // run never performs — so fullAuthorityDone / completed stay false and the verdict
  // points the operator at the missing multi-host certification.
  const completion = approved.completion as JsonObject;
  assert.equal(completion.schemaVersion, 'lattice.authority_completion.v1', 'planner run surfaces the completion verdict');
  assert.equal(completion.authorityDone, true, 'completion verdict mints per-run authorityDone ONLY from the verified native gate_decision receipt');
  assert.equal(completion.fullAuthorityDone, false, 'fullAuthorityDone stays false without the required multi-host reconciliation');
  assert.equal(completion.multiHostRequired, true, 'authority/DONE policy requires multi-host certification for full DONE');
  assert.equal(completion.completed, false, 'the job is not fully complete until multi-host reconciliation lands');
  assert.deepEqual(completion.blockingReasons, ['multi_host_verification_incomplete'], 'the only block is the missing multi-host reconciliation');
  assert.deepEqual(approved.blockingReasons, completion.blockingReasons, 'planner run echoes the verdict blockingReasons at top level');
  const receiptRefs = completion.receiptRefs as JsonObject[];
  assert.equal(receiptRefs.length, 1, 'the verified gate_decision receipt is recorded as a receipt ref');
  assert.equal(receiptRefs[0].kind, 'gate_decision');
  assert.equal(receiptRefs[0].verified, true, 'the surfaced receipt ref is a verified-approve native receipt');
  assert.deepEqual(approved.receiptRefs, completion.receiptRefs, 'planner run echoes receiptRefs at top level');
  assert.deepEqual(completion.hostVerdictRefs, [], 'no host verdicts were reconciled in a single planner run');
  assert.deepEqual(approved.hostVerdictRefs, [], 'planner run echoes hostVerdictRefs at top level');
  assert.match(approved.nextAction as string, /multi-host/i, 'the final nextAction tells the operator to collect the required independent host verdicts');

  // The loop is non-vacuous: provider (fake) + validation run, then the gate passes on the receipt.
  const steps = exec.steps as JsonObject[];
  assert(steps.some(s => s.type === 'provider.fake' && s.status === 'passed'), 'a deterministic fake provider step runs');
  assert(steps.some(s => s.type === 'validate.run' && s.status === 'passed'), 'validation runs before the gate');
  const gate = steps.find(s => s.type === 'gate.evaluate');
  assert(gate && gate.status === 'passed', 'the authority gate step passes on the verified receipt');
  assert.equal(gate!.summary.receiptVerified, true, 'the gate evidence records a verified receipt');
  assert.equal(steps[steps.length - 1].type, 'stop.summary', 'a completed authority run reaches the terminal stop.summary step');
  // The fake provider can never be promoted into production authority evidence.
  const fake = steps.find(s => s.type === 'provider.fake');
  assert.equal(fake!.summary.productionAuthorityEligible, false, 'fake provider evidence is production-authority-ineligible');

  // === 2. requestFile parity: identical intake text reaches the same gated outcome ===
  writeFileSync(join(root, 'intake.md'), oneSentence);
  const fileApproved = await (planner(gateOptions('approve')).planner_run({
    requestFile: 'intake.md',
    mode: 'authority',
    until: 'DONE',
    projectId: 'proj-m15',
    allowUnattendedPlanning: true,
    json: true,
  }) as Promise<JsonObject>);
  assert.equal(fileApproved.status, 'blocked', 'a requestFile request reaches the same multi-host-gated authority outcome');
  assert.equal(fileApproved.execution.authorityDone, true);
  assert.equal(fileApproved.execution.fullAuthorityDone, false);
  assert.deepEqual(fileApproved.blockingReasons, ['multi_host_verification_incomplete']);
  // Identical intake text (inline vs requestFile) is one idempotent scope: same run + reused Story.
  assert.equal(fileApproved.plannerRunId, approved.plannerRunId, 'requestFile + identical inline text share one deterministic plannerRunId');
  assert.equal(fileApproved.storyId, approved.storyId, 'a duplicate intake reuses the same Story, it does not fork a second one');

  // === 3. Fail-closed: no authority server configured -> blocked, never DONE ===
  const blocked = await (planner({ env: {}, fetchImpl: noNetworkFetch, now: () => FIXED_NOW }).planner_run({
    request: 'Ship the unattended billing migration runner until DONE',
    mode: 'authority',
    until: 'DONE',
    projectId: 'proj-m15',
    allowUnattendedPlanning: true,
    json: true,
  }) as Promise<JsonObject>);
  assert.equal(blocked.status, 'blocked', 'authority DONE fails closed with no server config');
  assert.match(blocked.storyId, /^B-[0-9a-f]{4,6}$/i, 'a blocked authority run still creates the Story + JobPlan from the request');
  assert.equal(blocked.execution.stopReason, 'authority_gate_decision_receipt_required');
  assert.equal(blocked.execution.authorityDone, false);
  assert.equal(blocked.execution.receiptVerified, false);
  const blockedSteps = blocked.execution.steps as JsonObject[];
  const blockedGateIndex = blockedSteps.findIndex(s => s.type === 'gate.evaluate');
  assert.equal(blockedSteps[blockedGateIndex].status, 'blocked', 'execution blocks precisely at the gate');
  assert(blockedSteps.slice(0, blockedGateIndex).every(s => s.status === 'passed'), 'the block is non-vacuous: bounded work runs before the gate refuses');
  assert.equal(blockedGateIndex, blockedSteps.length - 1, 'nothing advances Story lifecycle after a receipt block');
  assert(blocked.execution.nextActions.some((a: string) => /gate_decision receipt/i.test(a)), 'the operator is pointed at native receipt issuance');
  // The completion verdict fails closed: no verified receipt -> no authority DONE,
  // and the receipt requirement is the FIRST recorded block reason with no receiptRefs.
  assert.equal(blocked.completion.authorityDone, false, 'a receipt-blocked run never mints authorityDone in the verdict');
  assert.equal(blocked.completion.fullAuthorityDone, false);
  assert.equal(blocked.completion.completed, false);
  assert.equal(blocked.completion.blockingReasons[0], 'authority_gate_decision_receipt_required', 'the verified-receipt requirement is the first block reason');
  assert.deepEqual(blocked.completion.receiptRefs, [], 'no native gate_decision receipt was issued, so no receipt ref is surfaced');
  assert.deepEqual(blocked.receiptRefs, [], 'planner run echoes the empty receiptRefs at top level');

  // === 4. Reject decision: server answers, but no verified receipt -> blocked ===
  const rejected = await (planner(gateOptions('reject')).planner_run({
    request: 'Ship the unattended export pipeline until DONE with a contested gate',
    mode: 'authority',
    until: 'DONE',
    projectId: 'proj-m15',
    allowUnattendedPlanning: true,
    json: true,
  }) as Promise<JsonObject>);
  assert.equal(rejected.status, 'blocked', 'a rejected gate decision never reaches authority DONE');
  assert.equal(rejected.execution.stopReason, 'authority_gate_decision_rejected');
  assert.equal(rejected.execution.authorityDone, false, 'a reject can never be laundered into authorityDone');
  assert.equal(rejected.execution.receiptVerified, false);

  // === 5. Source-Aligned Redevelopment E2E: runs, but never overclaims parity ===
  mkdirSync(join(root, 'source/src'), { recursive: true });
  writeFileSync(join(root, 'source/src/index.ts'), 'export function add(a:number,b:number){ return a + b; }\n');
  const redev = await (planner().planner_run({
    workflow: 'source-aligned-redevelopment',
    request: 'Rewrite the source project into Rust with behavior parity',
    sourceRepo: 'source',
    targetProject: 'target',
    targetProjectName: 'target-rs',
    sourceLanguage: 'typescript',
    targetLanguage: 'rust',
    includedPaths: 'src',
    languageAdapterPolicy: '{"adapterRegistryRef":"local","requiredAdapters":["typescript","rust"],"adapterUnavailableBehavior":"block"}',
    semanticMappingPolicy: '{"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}',
    parityOraclePolicy: '{"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}',
    alignmentVerificationIntent: 'build parity,target runnable tests',
    mode: 'local',
    until: 'DONE',
    json: true,
  }) as Promise<JsonObject>);
  assert.equal(redev.status, 'done', 'the redevelopment plannedSteps run completes');
  const summary = redev.execution.redevelopment as JsonObject;
  assert(summary, 'a redevelopment run surfaces a redevelopment evidence summary');
  assert.equal(summary.sourceLanguage, 'typescript');
  assert.equal(summary.targetLanguage, 'rust');
  // The crux: NO overclaim. The projection runs no target build/test, so target-runnable
  // parity is not captured and the run is not redevelopment-DONE-eligible.
  assert.equal(summary.targetRunnableEvidenceCaptured, false, 'the projection captures no target-runnable parity evidence');
  assert.equal(summary.targetParityVerified, false, 'target parity is never asserted without target-runnable evidence');
  assert(summary.gapCount > 0, 'source-only / unverified-parity surfaces are recorded as gaps, not silently dropped');
  assert.equal(summary.doneEligible, false, 'redevelopment DONE eligibility requires verified parity + zero gaps');
  assert(redev.execution.nextActions.some((a: string) => /target-runnable parity/i.test(a)), 'the operator is told parity evidence + gaps block redevelopment DONE');
  // Local mode never projects any authority DONE flag, even on a completed run: the
  // completion verdict completes on local validation alone and leaves both authority
  // flags false with no multi-host requirement and no receipt refs.
  assert.equal(redev.completion.authorityDone, false, 'local mode must never project authorityDone');
  assert.equal(redev.completion.fullAuthorityDone, false, 'local mode must never project fullAuthorityDone');
  assert.equal(redev.completion.multiHostRequired, false, 'local mode carries no authority multi-host requirement');
  assert.equal(redev.completion.completed, true, 'a local run completes on local validation alone');
  assert.deepEqual(redev.completion.receiptRefs, [], 'a local run has no native gate_decision receipt');

  // missing redevelopment policies block at review — the parity discipline is non-vacuous.
  const missingPolicy = await (planner().planner_run({
    workflow: 'source-aligned-redevelopment',
    request: 'Rewrite the source project into Go with behavior parity',
    sourceRepo: 'source',
    targetProject: 'target',
    targetProjectName: 'target-go',
    sourceLanguage: 'typescript',
    targetLanguage: 'go',
    includedPaths: 'src',
    mode: 'local',
    until: 'DONE',
    json: true,
  }) as Promise<JsonObject>);
  assert.equal(missingPolicy.status, 'blocked', 'a redevelopment request missing adapter/parity policy blocks at review');
  assert(missingPolicy.review, 'the block carries the review issues');
  assert(missingPolicy.review.issues.some((i: JsonObject) => i.id === 'SRC-parityOraclePolicy'), 'the missing parity-oracle policy is named');

  // === 6. REAL provider runner path: NL -> planner emits provider.codex (NOT fake) ===
  //
  // The happy path here does NOT use provider.fake. The natural-language request is
  // planned with an explicit provider policy that allows codex, so the planner emits
  // a bounded `provider.codex` step. That step runs through the SAME bounded executor
  // production uses, via an injected executor seam + injected git runner — no real
  // Codex binary, login, or repository is required. The proof is twofold:
  //   (a) provider output is captured as digests and is NEVER validation/gate evidence;
  //   (b) the verified native gate_decision receipt — not the provider — controls DONE.
  const providerDraft = buildPlannerDraft(root, {
    request: 'Add a bounded health-check command and implement it through the Codex provider',
    mode: 'authority',
    until: 'DONE',
    allowUnattendedPlanning: true,
    // Explicit opt-in: without this the planner stays fail-closed on provider.fake.
    providerPolicy: {
      primaryProvider: 'codex',
      allowedProviders: ['codex'],
      productionDoneProviders: ['codex'],
      credentialsEnvAllowlist: ['CODEX_KEY'],
    },
  });
  // The planner only emits a real provider step on explicit opt-in; fake stays the
  // fail-closed default (proven by scenarios 1-4 above, which never opt a provider in).
  assert.equal(providerDraft.providerPolicy.primaryProvider, 'codex', 'the draft carries the opted-in codex provider policy');
  assert.equal(providerDraft.providerPolicy.allowFakeProviderForProductionDone, false, 'fake is never silently promoted to a production-DONE provider');
  const defaultDraft = buildPlannerDraft(root, { request: 'Add a plain bounded command with validation evidence', mode: 'authority', until: 'DONE', allowUnattendedPlanning: true });
  assert.equal(defaultDraft.providerPolicy.primaryProvider, 'fake', 'with no provider opt-in the planner defaults to the fail-closed fake provider');

  const providerStoryId = 'B-prov1';
  const providerJobPlan = buildJobPlan(providerDraft, providerStoryId, 'proj-m15', {});
  const codexStep = providerJobPlan.plannedSteps.find(s => s.type === 'provider.codex');
  assert(codexStep, 'the planner emits a provider.codex step when the provider policy allows codex');
  assert(!providerJobPlan.plannedSteps.some(s => s.type === 'provider.fake'), 'the opted-in real-provider plan does NOT fall back to provider.fake');
  assert.deepEqual(providerJobPlan.providerPolicy?.allowedProviders, ['codex'], 'the JobPlan provider policy agrees with the emitted step');
  assert(Array.isArray(codexStep!.args.argv) && (codexStep!.args.argv as unknown[]).length > 0, 'the codex step declares a bounded argv (shell strings are rejected by the executor)');

  // A story that has reached an authoritative worktree (post INIT_CHECK). The injected
  // git runner reports a clean worktree, so authority worktree enforcement passes
  // deterministically without shelling out to a real git.
  const providerStore = {
    readStory: () => ({ phase: 'DEV', worktree: { path: join(root, '.worktrees', providerStoryId) } } as JsonObject),
    storyExists: () => true,
    listStoryIds: () => [] as string[],
    appendProcessEvent: () => {},
  } as unknown as PlannerStoreLike;
  const cleanGit: GitRunner = () => ({ code: 0, stdout: '', stderr: '', spawnError: false });

  const PROVIDER_RAW_TRANSCRIPT = 'CODEX_RAW_TRANSCRIPT_must_not_leak';
  let capturedReq: ProviderExecRequest | null = null;
  const fakeExecutor: BoundedProviderExecutor = {
    available: () => true,
    run: (req) => {
      capturedReq = req;
      return {
        provider: req.provider,
        model: 'codex-injected-model',
        argvDigest: 'codex-argv-digest',
        exitCode: 0,
        stdoutDigest: 'codex-stdout-digest',
        stderrDigest: 'codex-stderr-digest',
        stdoutBytes: PROVIDER_RAW_TRANSCRIPT.length,
        stderrBytes: 0,
        durationMs: 5,
        attempts: 1,
        timedOut: false,
        spawnError: false,
      };
    },
  };
  // The executor reads provider credentials from this env; only the allowlisted
  // CODEX_KEY should reach the child, never UNRELATED_SECRET.
  const providerEnv = { ...authorityEnv(), PATH: '/usr/bin', CODEX_KEY: 'codex-credential-secret', UNRELATED_SECRET: 'do-not-leak' };

  // approve -> a REAL Ed25519-signed native receipt is minted + verified (same seam as
  // scenario 1). The provider step ran, but DONE is driven by the receipt, not by it.
  const approveGate = await resolveAuthorityGateEvaluator(providerJobPlan, gateOptions('approve'));
  assert(approveGate.evaluator, 'the authority gate evaluator resolves for the approve scenario');
  const providerRun = executePlannedSteps({
    root,
    store: providerStore,
    jobPlan: providerJobPlan,
    env: providerEnv,
    providerExecutor: fakeExecutor,
    gitRunner: cleanGit,
    authorityGate: approveGate.evaluator,
    gateEvidenceRefResolver: buildGateEvidenceRefResolver(providerJobPlan),
  }) as unknown as JsonObject;

  const ranStep = (providerRun.steps as JsonObject[]).find(s => s.type === 'provider.codex')!;
  assert.equal(ranStep.status, 'passed', 'the bounded codex provider step runs and passes through the injected executor');
  assert.equal(ranStep.summary.provider, 'codex');
  assert.equal(ranStep.summary.validationSatisfied, false, 'provider output is NEVER validation evidence');
  assert.equal(ranStep.summary.providerProseAcceptedAsEvidence, false, 'provider prose is NEVER accepted as evidence');
  assert.equal(ranStep.summary.productionAuthorityEligible, false, 'provider output is NEVER production-authority evidence');
  // Provider evidence is mechanically distinct from validation and gate evidence.
  const validateStep = (providerRun.steps as JsonObject[]).find(s => s.type === 'validate.run')!;
  const gateStepRan = (providerRun.steps as JsonObject[]).find(s => s.type === 'gate.evaluate')!;
  assert.equal(validateStep.status, 'passed', 'validation runs as its own step, separate from the provider');
  assert.equal(gateStepRan.status, 'passed', 'the gate passes on the verified receipt');
  assert.notEqual(ranStep.evidenceDigest, validateStep.evidenceDigest, 'provider evidence digest != validation evidence digest');
  assert.notEqual(ranStep.evidenceDigest, gateStepRan.evidenceDigest, 'provider evidence digest != gate evidence digest');
  assert.equal(gateStepRan.summary.receiptVerified, true, 'DONE rests on a verified native receipt, not on provider output');
  // The verified receipt — not the provider — is what unlocks authority DONE.
  assert.equal(providerRun.receiptVerified, true, 'the executor surfaces the verified native gate_decision receipt');
  assert.equal(providerRun.authorityDone, true, 'authority DONE requires the verified receipt plus the completed real-provider run');
  assert.equal(providerRun.fullAuthorityDone, false, 'fullAuthorityDone stays false: multi-host certification is owned elsewhere');
  // No raw transcript or credential ever escapes into the structured evidence.
  const serialized = JSON.stringify(providerRun);
  assert(!serialized.includes('codex-credential-secret'), 'raw credential must never surface in execution evidence');
  assert(!serialized.includes('do-not-leak'), 'a non-allowlisted secret value must never surface in execution evidence');
  assert.equal(capturedReq!.env.CODEX_KEY, 'codex-credential-secret', 'the allowlisted credential reaches the bounded provider process');
  assert.equal(capturedReq!.env.UNRELATED_SECRET, undefined, 'a non-allowlisted env var is redacted out of the provider projection');
  assert.equal(capturedReq!.provider, 'codex');
  assert.deepEqual(capturedReq!.argv, codexStep!.args.argv, 'the planner-emitted bounded argv reaches the executor verbatim');

  // reject -> no verified receipt. The SAME real provider step still runs, but DONE
  // stays closed: the gate receipt — not the provider — controls DONE.
  const rejectGate = await resolveAuthorityGateEvaluator(providerJobPlan, gateOptions('reject'));
  const providerBlockedRun = executePlannedSteps({
    root,
    store: providerStore,
    jobPlan: providerJobPlan,
    env: providerEnv,
    providerExecutor: fakeExecutor,
    gitRunner: cleanGit,
    authorityGate: rejectGate.evaluator,
    gateEvidenceRefResolver: buildGateEvidenceRefResolver(providerJobPlan),
  }) as unknown as JsonObject;
  const ranThenBlocked = (providerBlockedRun.steps as JsonObject[]).find(s => s.type === 'provider.codex')!;
  assert.equal(ranThenBlocked.status, 'passed', 'the real provider step still runs even when the gate will block DONE');
  assert.equal(providerBlockedRun.stopReason, 'authority_gate_decision_rejected', 'execution blocks precisely at the gate decision');
  assert.equal(providerBlockedRun.authorityDone, false, 'no verified receipt -> authority DONE stays closed despite the provider having run');
  assert.equal(providerBlockedRun.receiptVerified, false, 'a rejected decision is never laundered into a verified receipt');
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ natural-language-to-done E2E (M15) passed: one-sentence + requestFile NL -> Story -> typed Authority JobPlan -> provider/validate/evidence/gate -> verified native receipt -> authorityDone (fullAuthorityDone stays false), fail-closed blocked without a server, reject never minted into DONE, duplicate intake reuses one Story, source-aligned redevelopment runs without overclaiming target-runnable parity, and a REAL provider runner path (NL -> planner-emitted provider.codex, NOT fake -> bounded executor via injected executor+git seams, no Codex login) where provider output is never validation/gate evidence and the verified receipt — not the provider — controls DONE');
