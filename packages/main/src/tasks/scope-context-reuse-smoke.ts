#!/usr/bin/env node
/**
 * Lab scope-context-reuse: collectReviewerEvidenceState (core/review-run.ts)
 * computes the live scope context (scope contract + a full scope diff pack:
 * committed, unstaged, staged and untracked diffs) once per collection, then
 * every lane whose run carries a workspaceBinding rebuilt the same context at
 * its signed workspace root inside the same synchronous collection. When that
 * root is the collection's own root the inputs are identical, so each lane
 * repeated ~7 git commands; in the e2e harness that was ~140 spawns in
 * story_advance TEST and ~170 in story_advance DONE.
 *
 * Budget: one collection over N workspace-bound lanes builds one scope diff
 * pack. A changed scope contract or a changed diff is still seen by the next
 * collection (stale_scope_binding).
 *
 * Fixture adapted from semantic-scope-guard-smoke case 13 (brokered native
 * passes), with each run bound to the story's resolved signed workspace.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistData, ReviewRun, ReviewRunWorkspaceBinding, ScopeContractData, StoryInfo } from '../core/types.js';
import { computeReviewScopeBinding } from '../core/review-scope-binding.js';
import { assembleFullPromptEnvelope, buildFullTaskContext } from '../core/prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { buildReviewRunWorkspaceBinding, collectReviewerEvidenceState, hashReviewPrompt, signReviewRun } from '../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody, promptRoleContract } from '../core/prompt-role-contract-registry.js';
import { signReviewPass } from '../core/finding-verify.js';
import { issueBrokeredNativeReviewBinding, nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity } from './native-review-fixture.js';
import { createMainRegistry } from '../registry.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { resolveStorySignedWorkspace } from '../core/story-signed-workspace-resolution.js';

function workspaceBindingFor(root: string, store: StoryStore, storyId: string, headHash: string, materialHash: string): ReviewRunWorkspaceBinding {
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: root });
  assert.ok(resolution.resolved && resolution.signedWorkspaceRoot, `fixture story resolves a signed workspace: ${resolution.unresolvedReason ?? ''}`);
  return buildReviewRunWorkspaceBinding({
    metadataRoot: resolution.metadataRoot,
    invocationCwd: resolution.signedWorkspaceRoot,
    repoRoot: resolution.repoRoot ?? undefined,
    signedWorkspaceRoot: resolution.signedWorkspaceRoot,
    workspaceMode: resolution.resolutionSource,
    headHash,
    materialHash,
  });
}

const BASELINE_LANES = ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage'];

function writeScopeStory(root: string, opts: { withContract: boolean }): { store: StoryStore; storyId: string; reviewRound: string; contract: ScopeContractData | null } {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    // B-137a: register the fixture host brokers so the brokered native
    // attestation has a uniquely registered issuer. Without this,
    // issueNativeReviewEvidenceBinding rejects with "issuer is not one uniquely
    // registered host broker" -- the same real check production relies on, so it
    // is satisfied rather than bypassed.
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }));
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'scope@example.invalid'], ['config', 'user.name', 'Scope Fixture'], ['add', '.'], ['commit', '-m', 'scope fixture baseline']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-scopebind';
  const now = '2026-05-23T12:00:00.000Z';
  const reviewRound = '2026-05-23T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'scope-binding-smoke',
    title: 'Scope binding smoke',
    description: 'Synthetic scope-protected story for CHK-005 gate coverage.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      verificationIntent: { happy: [{ desc: 'Reviewer evidence remains bound to the current semantic scope', type: 'logic' as const, priority: 'must' as const }], edge: [], adversarial: [] },
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Bind reviewer evidence to scope',
    outcome: 'Gate rejects stale scope bindings',
    facts: [], constraints: [], unknowns: [],
    touchpoints: ['packages/main/src/core/review-run.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['bind evidence mechanically', 'stay backward compatible', 'reuse the review run binding'],
    drivers: ['scope-protected review gate'],
    options: [
      { name: 'A: run-level binding', pros: ['single source'], cons: ['needs sig change'] },
      { name: 'B: per-evidence binding', pros: ['granular'], cons: ['duplication'] },
    ],
    chosen: 'A: run-level binding',
    rationale: 'binding the run covers all findings/passes that reference it',
    timestamp: now,
  });
  let contract: ScopeContractData | null = null;
  if (opts.withContract) {
    contract = {
      storyId,
      mode: 'enforce',
      allowedModify: ['packages/main/src/core/review-run.ts'],
      allowedCreate: ['packages/main/src/core/review-scope-binding.ts'],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      createdAt: now,
      updatedAt: now,
    };
    store.writeScopeContract(storyId, contract);
  }
  return { store, storyId, reviewRound, contract };
}

function seedScopeRuns(
  root: string,
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  opts: { binding: boolean },
): Map<string, string> {
  const contract = store.readScopeContract(storyId);
  const binding = opts.binding && contract
    ? computeReviewScopeBinding({ contract, diffPack: buildScopeDiffPack(root) }) ?? undefined
    : undefined;
  const runs: ReviewRun[] = BASELINE_LANES.map((agent, index) => {
    const reviewRunId = `${storyId}:RR-${String(index + 1).padStart(3, '0')}`;
    const startedAt = `2026-05-23T12:1${index}:00.000Z`;
    const headHash = currentGitHead(root)!;
    const materialHash = currentMaterialHash(root)!;
    const promptHash = hashReviewPrompt(resolvePromptRoleBody(agent, {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: { [agent]: 'full-envelope' },
    }).body);
    return {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash,
      ...(binding ? { scopeBinding: binding } : {}),
      workspaceBinding: workspaceBindingFor(root, store, storyId, headHash, materialHash),
      _hash: '',
    };
  });
  for (const run of runs) {
    run.storyFilesHash = run.workspaceBinding!.storyFilesHash;
    run._hash = signReviewRun(storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt, run.headHash, run.materialHash,
      run.promptHash, run.scopeBinding?.bindingHash, run.workspaceBinding?.bindingHash, run.storyFilesHash);
  }
  store.writeReviewRuns(storyId, { runs });
  return new Map(runs.map((run) => [run.agent, run.reviewRunId]));
}

/**
 * B-137a: seed reviewer passes WITH execution-authority attestations.
 *
 * This fixture predates the review-execution-authority requirement, so it used
 * to write bare passes carrying neither a managed receipt nor a registered-broker
 * native invocation attestation. collectReviewerEvidenceState therefore rejected
 * every one of them with review_execution_authority_missing, and case 13a failed
 * ("fresh scope binding yields no invalid evidence") -- on main as well as here,
 * proven by a controlled comparison with all B-137a changes stashed. It went
 * unnoticed because this suite is absent from lattice.config.json
 * validate.commands and from the package.json scripts, so nothing gated it.
 *
 * The repair mirrors the working pattern in flow-stability-smoke: drive the REAL
 * dispatch handler under a fixture host identity to create the signed dispatch
 * binding that issueBrokeredNativeReviewBinding requires, then attach the
 * brokered native binding to each pass. No production code changes, and the
 * authority requirement is satisfied genuinely rather than bypassed.
 */
function seedScopePasses(
  root: string,
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  runIds: Map<string, string>,
): void {
  const registry = createMainRegistry({ root, store, scanRoot: join(root, 'packages/main') });
  const dispatch = registry.get('dispatch');
  assert.ok(dispatch, 'scope-binding fixture requires the dispatch handler');
  for (const agent of BASELINE_LANES) {
    withNativeReviewFixtureHostIdentity({
      agent,
      invoke: () => dispatch!({ storyId, agentType: agent }),
    });
  }
  // Bind the preserved scope-test snapshots to the current real dispatch and
  // actual canonical prompt producer; do not change scopeBinding or hashes.
  const currentRuns = store.readReviewRuns(storyId).runs;
  for (const run of currentRuns) {
    const event = [...store.readProcessEvents(storyId)].reverse().find(row =>
      row.type === 'dispatch' && row.agentType === run.lane && row.reviewRound === run.reviewRound);
    assert.ok(event && typeof event.dispatchPrompt === 'string' && typeof event.dispatchBindingDigest === 'string'
      && typeof event.hostRenderIdentityDigest === 'string', 'real current dispatch must be present');
    const assembly = assembleFullPromptEnvelope({
      roleContract: promptRoleContract(run.lane), runtimeContract: BASELINE_RUNTIME_CONTRACT,
      rolePrompt: resolvePromptRoleBody(run.lane, { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { [run.lane]: 'full-envelope' } }).body,
      taskContext: buildFullTaskContext({ story: store.readStory(storyId), checklist: store.readChecklist(storyId),
        headHash: run.headHash, materialHash: run.materialHash, storyFilesHash: run.storyFilesHash }),
      dispatchKind: 'review-run', reviewRunId: run.reviewRunId, reviewRound: run.reviewRound, lane: run.lane,
      dispatchPrompt: event.dispatchPrompt, hostRenderIdentityDigest: event.hostRenderIdentityDigest,
      reviewerDispatchBindingDigest: event.dispatchBindingDigest,
      launcherSpec: { reviewedIntentRefs: [], dispatchBindingDigest: event.dispatchBindingDigest, hostRenderHost: event.hostRenderHost as 'codex' | 'claude' },
      createdAt: run.startedAt,
    });
    run.envelopeId = assembly.envelope.envelopeId;
    run.promptHash = assembly.envelope.assembledPromptDigest;
    run.assembledPromptRef = store.writeReviewPromptBody(storyId, assembly.prompt, run.promptHash);
    run._hash = signReviewRun(storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
      run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash, run.workspaceBinding?.bindingHash,
      run.storyFilesHash, run.envelopeId);
    const prior = store.readPromptEnvelopes(storyId);
    store.writePromptEnvelopes(storyId, { envelopes: [...prior.envelopes.filter(row => row.envelopeId !== run.envelopeId), assembly.envelope] });
  }
  store.writeReviewRuns(storyId, { runs: currentRuns });
  const passes = BASELINE_LANES.map((agent, index) => {
    const id = `${storyId}:RP-${String(index + 1).padStart(3, '0')}`;
    const createdAt = `2026-05-23T12:2${index}:00.000Z`;
    const note = `${agent} reviewed the scope-protected diff and found no blocking issue`;
    const reviewRunId = runIds.get(agent)!;
    const envelopeId = currentRuns.find(run => run.reviewRunId === reviewRunId)!.envelopeId;
    const nativeEvidenceBinding = issueBrokeredNativeReviewBinding({
      root, store, storyId, agent, reviewRunId,
    });
    // Provenance is DERIVED from the brokered binding, never invented: the
    // writer session is part of the signed domain, so a fabricated value would
    // sign a pass that no real invocation produced.
    const provenance = {
      writerSessionId: nativeEvidenceBinding.writerSessionId,
      sessionSource: nativeEvidenceBinding.sessionSource,
    };
    return {
      id, agent, note, createdAt, reviewRound, reviewRunId, envelopeId,
      nativeEvidenceBinding,
      writerSessionId: nativeEvidenceBinding.writerSessionId,
      sessionSource: nativeEvidenceBinding.sessionSource,
      _hash: signReviewPass(
        storyId, id, agent, note, createdAt, reviewRound, reviewRunId,
        undefined, undefined, undefined,
        provenance,
        envelopeId, undefined, nativeEvidenceBinding,
      ),
    };
  });
  store.writeReviewPasses(storyId, { passes });
}

const root = mkdtempSync(join(tmpdir(), 'scope-context-reuse-'));
const shimDir = `${root}-shim`;
const log = join(shimDir, 'git.log');
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
try {
  const { store, storyId, reviewRound, contract } = writeScopeStory(root, { withContract: true });
  // A real story diff for the pack to carry.
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/review-run.ts'), 'export const reviewRun = 1;\n');
  const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: true });
  seedScopePasses(root, store, storyId, reviewRound, runIds);

  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  const rows = (): string[] => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  // One unified-diff read of the untracked/unstaged work tree marks one scope diff pack.
  const packs = (argv: string[]) => argv.filter(row => row === 'diff --find-renames --find-copies --unified=20').length;

  const before = rows().length;
  const state = collectReviewerEvidenceState(store, storyId, root);
  const built = packs(rows().slice(before));
  console.log(`scope diff packs in one collection over ${BASELINE_LANES.length} workspace-bound lanes: ${built}`);
  assert.equal(state.invalid.length, 0, `fresh workspace-bound scope bindings stay valid: ${JSON.stringify(state.invalid.map(i => i.message))}`);
  assert.equal(state.valid.length, BASELINE_LANES.length, 'every workspace-bound lane is valid');
  assert.equal(built, 1, `one collection built ${built} identical scope diff packs (budget 1)`);

  // Freshness: a scope contract change is seen by the next collection.
  store.writeScopeContract(storyId, { ...contract!, allowedModify: [...contract!.allowedModify, 'packages/main/src/cli-engine.ts'], updatedAt: '2026-05-23T13:00:00.000Z' });
  const stale = collectReviewerEvidenceState(store, storyId, root);
  assert.ok(stale.invalid.length > 0 && stale.invalid.every(issue => issue.code === 'stale_scope_binding'),
    `a changed scope contract invalidates every workspace-bound lane: ${JSON.stringify(stale.invalid.map(i => i.code))}`);
  store.writeScopeContract(storyId, contract!);
  // Freshness: a changed diff is seen by the next collection.
  writeFileSync(join(root, 'packages/main/src/core/review-run.ts'), 'export const reviewRun = 2;\n');
  const moved = collectReviewerEvidenceState(store, storyId, root);
  assert.ok(moved.invalid.length > 0 && moved.invalid.every(issue => issue.code === 'stale_scope_binding'),
    `a changed diff invalidates every workspace-bound lane: ${JSON.stringify(moved.invalid.map(i => i.code))}`);
  console.log('scope-context-reuse-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
}
