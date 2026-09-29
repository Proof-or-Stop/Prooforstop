import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';

import { resetConfigCache } from "../../core/config.js";

import { PROOF_OR_STOP_STORY_DIR } from "../../core/proof-or-stop-paths.js";

import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from "../../core/evidence-freshness.js";
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  digestCandidateRoutingValue,
  routeCandidateSpecs,
} from "../../core/candidate-spec-routing.js";


import { promptRoleContract, reviewerHostRenderIdentity, resolvePromptRoleBody } from "../../core/prompt-role-contract-registry.js";
import { assembleFullPromptEnvelope, buildFullTaskContext } from "../../core/prompt-envelope.js";
import { BASELINE_RUNTIME_CONTRACT } from "../../core/prompt-measurement.js";
import { reviewerDispatchBindingDigest, reviewerDispatchPromptDigest } from "../../core/prompt-contracts.js";
import { captureReviewRunSnapshot, hashReviewPrompt, signReviewRun } from "../../core/review-run.js";






import { StoryStore } from "../../core/store.js";

import type { ChecklistData, ReviewRun, StoryInfo } from "../../core/types.js";

import { currentStoryRoutingInput } from "../../handlers/candidate-spec-routing.js";


import { STORY_ID, LANE, CONCEPT_LANE, REVIEW_ROUND, REVIEW_RUN_ID } from "./environment.js";

export function write(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function managedReadEvidence(root: string, requestedFiles?: string[]) {
  const artifact = new StoryStore(root).readCandidateSpecSet(STORY_ID);
  assert.ok(artifact, 'managed review fixture requires a candidate artifact');
  // Positive fixture worker actually reads all current required candidate files.
  // Explicit subsets remain untouched for rejection and drift controls.
  const filesReadFully = requestedFiles ?? [...new Set(['packages/main/src/example.ts', ...artifact.candidateSpecSet])].sort();
  for (const file of filesReadFully) readFileSync(join(root, file));
  return {
    readManifest: {
      filesReadFully,
      filesTriagedByName: [],
      scanEscalationReason: artifact.scanEscalationReason,
      candidateSpecSetDigest: artifact.artifactDigest,
      corpusDigest: artifact.corpusDigest,
    },
    readLog: {
      filesReadFully,
      filesTriagedByName: [],
      summary: { readCount: filesReadFully.length, tokenCount: null },
      digest: 'a'.repeat(64),
    },
  };
}

export function refreshCandidateArtifact(root: string, store: StoryStore, mode: 'shadow' | 'enforce'): void {
  const routingContext = { store, root, scanRoot: join(root, 'packages/main') };
  const story = store.readStory(STORY_ID);
  const routingInput = currentStoryRoutingInput(routingContext, STORY_ID);
  const routingSnapshot = captureReviewRunSnapshot(root, { storyId: STORY_ID, storyPhase: story.phase });
  store.writeCandidateSpecSet(STORY_ID, routeCandidateSpecs({
    projectRoot: root,
    storyId: STORY_ID,
    corpus: buildCorpusIndex(root),
    seeds: buildKeywordSeeds(routingInput),
    protectedSources: routingInput.protectedSources,
    mode,
    storyInputDigest: digestCandidateRoutingValue(routingInput),
    ...routingSnapshot,
  }));
}

export function seedReviewStory(
  root: string,
  brokerPublicKey: string,
  options: { candidateRoutingMode?: 'shadow' | 'enforce'; readonlyIsolation?: boolean } = {},
): {
  store: StoryStore;
  run: ReviewRun;
  nativeDispatch: { dispatchPromptDigest: string; hostRenderIdentityDigest: string; dispatchBindingDigest: string };
} {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    ...(options.readonlyIsolation ? {outDir:'packages/main/dist',managedReviewIsolation:{mode:'readonly-build',adapter:'prooforstop-main-v1'}} : {}),
    storyDir: PROOF_OR_STOP_STORY_DIR,
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    promptEnvelope: {
      version: 'proof-or-stop.prompt-envelope-rollout.v1',
      roles: {
        [LANE]: 'full-envelope',
        [CONCEPT_LANE]: 'full-envelope',
      },
    },
    nativeReviewInvocation: {
      brokers: [{
        brokerId: 'smoke-codex-broker',
        adapterId: 'codex-desktop',
        host: 'codex',
        publicKey: brokerPublicKey,
      }],
    },
    candidateSpecRouting: { mode: options.candidateRoutingMode ?? 'shadow' },
  }));
  write(root, 'docs/requirements/decisions/managed-review-evidence.md', '# Managed Review Evidence\n\nCandidate routing fixture.\n');
  write(root, 'packages/main/src/example.ts', 'export const example = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'managed-review-evidence-smoke',
    title: 'Managed review evidence smoke',
    description: 'Exercise provider proposal, terminal seal, importer, and REVIEW gate.',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    createdAt: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    endedAt: null,
    currentReviewRound: REVIEW_ROUND,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Managed evidence is admissible',
      context: 'Synthetic end-to-end managed review evidence.',
      status: 'done',
      startTime: REVIEW_ROUND,
      endTime: REVIEW_ROUND,
      relatedDocs: ['docs/requirements/decisions/managed-review-evidence.md'],
    }],
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
  const dispatchPrompt = 'Perform the exact native-host review for this story.';
  const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
  const hostIdentity = reviewerHostRenderIdentity(root, LANE, 'codex', 'full-envelope');
  const dispatchBindingDigest = reviewerDispatchBindingDigest({
    storyId: STORY_ID,
    lane: LANE,
    reviewRound: REVIEW_ROUND,
    dispatchPromptDigest,
    hostRenderIdentityDigest: hostIdentity.identityDigest,
  });
  store.appendProcessEvent(STORY_ID, {
    type: 'dispatch',
    storyId: STORY_ID,
    agentType: LANE,
    targetKind: 'story-review',
    reviewRound: REVIEW_ROUND,
    dispatchPrompt,
    dispatchPromptDigest,
    hostRenderHost: 'codex',
    hostRenderIdentityDigest: hostIdentity.identityDigest,
    dispatchBindingDigest,
  });

  const currentRoleBody = resolvePromptRoleBody(LANE, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [LANE]: 'full-envelope' },
  });
  const headHash = currentGitHead(root)!;
  const materialHash = currentMaterialHash(root)!;
  const storyFilesHash = currentStoryFilesHash(root)!;
  const run: ReviewRun = {
    reviewRunId: REVIEW_RUN_ID,
    storyId: STORY_ID,
    agent: LANE,
    lane: LANE,
    reviewRound: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    headHash,
    materialHash,
    storyFilesHash,
    promptHash: hashReviewPrompt(currentRoleBody.body),
    _hash: signReviewRun(
      STORY_ID,
      REVIEW_RUN_ID,
      LANE,
      LANE,
      REVIEW_ROUND,
      REVIEW_ROUND,
      headHash,
      materialHash,
      hashReviewPrompt(currentRoleBody.body),
      undefined,
      undefined,
      storyFilesHash,
    ),
  };
  bindCurrentReviewEnvelope(root, store, run);
  store.writeReviewRuns(STORY_ID, { runs: [run] });
  refreshCandidateArtifact(root, store, options.candidateRoutingMode ?? 'shadow');
  return {
    store,
    run,
    nativeDispatch: {
      dispatchPromptDigest,
      hostRenderIdentityDigest: hostIdentity.identityDigest,
      dispatchBindingDigest,
    },
  };
}

export function bindCurrentReviewEnvelope(root: string, store: StoryStore, run: ReviewRun): ReviewRun {
  const dispatch = [...store.readProcessEvents(run.storyId)].reverse().find(event =>
    event.type === 'dispatch' && event.agentType === run.lane && event.reviewRound === run.reviewRound);
  if (!dispatch || typeof dispatch.dispatchPrompt !== 'string' || typeof dispatch.dispatchBindingDigest !== 'string'
    || typeof dispatch.hostRenderIdentityDigest !== 'string') throw new Error('fixture requires a current bound dispatch');
  const assembly = assembleFullPromptEnvelope({
    roleContract: promptRoleContract(run.lane), runtimeContract: BASELINE_RUNTIME_CONTRACT,
    rolePrompt: resolvePromptRoleBody(run.lane, {
      version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { [run.lane]: 'full-envelope' },
    }).body,
    taskContext: buildFullTaskContext({ story: store.readStory(run.storyId), checklist: store.readChecklist(run.storyId),
      headHash: run.headHash, materialHash: run.materialHash, storyFilesHash: run.storyFilesHash }),
    dispatchKind: 'review-run', reviewRunId: run.reviewRunId, reviewRound: run.reviewRound, lane: run.lane,
    dispatchPrompt: dispatch.dispatchPrompt, hostRenderIdentityDigest: dispatch.hostRenderIdentityDigest,
    reviewerDispatchBindingDigest: dispatch.dispatchBindingDigest,
    launcherSpec: { reviewedIntentRefs: [], dispatchBindingDigest: dispatch.dispatchBindingDigest, hostRenderHost: 'codex' },
    createdAt: run.startedAt,
  });
  run.envelopeId = assembly.envelope.envelopeId;
  run.assembledPrompt = assembly.prompt;
  run.promptHash = assembly.envelope.assembledPromptDigest;
  run._hash = signReviewRun(run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash, run.workspaceBinding?.bindingHash,
    run.storyFilesHash, run.envelopeId, run.reviewerEscalationReason, run.reviewPurpose, run.inventoryBinding);
  const prior = store.readPromptEnvelopes(run.storyId);
  store.writePromptEnvelopes(run.storyId, { envelopes: [...prior.envelopes.filter(item => item.envelopeId !== run.envelopeId), assembly.envelope] });
  return run;
}

export function addCurrentReviewRun(root: string, store: StoryStore, lane: string, reviewRunId: string): ReviewRun {
  const dispatchPrompt = `Perform the exact native-host review for ${lane}.`;
  const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
  const hostIdentity = reviewerHostRenderIdentity(root, lane, 'codex', 'full-envelope');
  const dispatchBindingDigest = reviewerDispatchBindingDigest({
    storyId: STORY_ID,
    lane,
    reviewRound: REVIEW_ROUND,
    dispatchPromptDigest,
    hostRenderIdentityDigest: hostIdentity.identityDigest,
  });
  store.appendProcessEvent(STORY_ID, {
    type: 'dispatch',
    storyId: STORY_ID,
    agentType: lane,
    targetKind: 'story-review',
    reviewRound: REVIEW_ROUND,
    dispatchPrompt,
    dispatchPromptDigest,
    hostRenderHost: 'codex',
    hostRenderIdentityDigest: hostIdentity.identityDigest,
    dispatchBindingDigest,
  });
  const currentRoleBody = resolvePromptRoleBody(lane, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [lane]: 'full-envelope' },
  });
  const headHash = currentGitHead(root)!;
  const materialHash = currentMaterialHash(root)!;
  const storyFilesHash = currentStoryFilesHash(root)!;
  const run: ReviewRun = {
    reviewRunId,
    storyId: STORY_ID,
    agent: lane,
    lane,
    reviewRound: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    headHash,
    materialHash,
    storyFilesHash,
    promptHash: hashReviewPrompt(currentRoleBody.body),
    _hash: signReviewRun(
      STORY_ID,
      reviewRunId,
      lane,
      lane,
      REVIEW_ROUND,
      REVIEW_ROUND,
      headHash,
      materialHash,
      hashReviewPrompt(currentRoleBody.body),
      undefined,
      undefined,
      storyFilesHash,
    ),
  };
  bindCurrentReviewEnvelope(root, store, run);
  const reviewRuns = store.readReviewRuns(STORY_ID);
  store.writeReviewRuns(STORY_ID, { runs: [...reviewRuns.runs, run] });
  return run;
}

export async function eventually(predicate: () => Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

export function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}
