import assert from 'node:assert/strict';


import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from "../../core/config.js";
import { COMMIT_SUBJECT_PREFIX } from "../../core/auto-commit-metadata.js";
import { PROOF_OR_STOP_STORY_DIR } from "../../core/proof-or-stop-paths.js";

import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from "../../core/evidence-freshness.js";

import { managedHostRunReceipt, getManagedHostRunStatus } from "../../core/managed-host-run.js";
import { verifyManagedReviewLiveBinding } from "../../core/managed-review-evidence.js";




import { assertCurrentReviewRunForEvidence, signReviewRun } from "../../core/review-run.js";








import type { ReviewRun } from "../../core/types.js";


import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { seedReviewStory, git, write, bindCurrentReviewEnvelope, managedReadEvidence, eventually, addCurrentReviewRun, refreshCandidateArtifact } from "./fixtures.js";
import { STORY_ID, REVIEW_RUN_ID, LANE, REVIEW_ROUND, MANAGED_REVIEW_FIXTURE_DEADLINE_MS, CONCEPT_LANE, CONCEPT_REVIEW_RUN_ID } from "./environment.js";

export async function assertManagedImportRejectsLiveMaterialDrift(brokerPublicKey: string): Promise<void> {
  const driftRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-live-drift-'));
  try {
    const { store, run } = seedReviewStory(driftRoot, brokerPublicKey);
    git(driftRoot, ['checkout', '-b', 'story/managed-import-drift']);
    write(driftRoot, 'packages/main/src/story-owned.ts', 'export const storyOwned = true;\n');
    git(driftRoot, ['add', 'packages/main/src/story-owned.ts']);
    git(driftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story material']);
    // A fresh ReviewRun follows candidate_spec_route on the new material.
    refreshCandidateArtifact(driftRoot, store, 'shadow');
    const snapshotHead = currentGitHead(driftRoot)!;
    const snapshotMaterial = currentMaterialHash(driftRoot)!;
    const snapshotStoryFiles = currentStoryFilesHash(driftRoot)!;
    const updatedRun: ReviewRun = {
      ...run,
      headHash: snapshotHead,
      materialHash: snapshotMaterial,
      storyFilesHash: snapshotStoryFiles,
      _hash: signReviewRun(
        STORY_ID, REVIEW_RUN_ID, LANE, LANE, REVIEW_ROUND, REVIEW_ROUND,
        snapshotHead, snapshotMaterial, run.promptHash,
        undefined, undefined, snapshotStoryFiles,
      ),
    };
    bindCurrentReviewEnvelope(driftRoot, store, updatedRun);
    store.writeReviewRuns(STORY_ID, { runs: [updatedRun] });
    // Create the managed run while the signed review tuple still names the
    // canonical HEAD. The negative control is about import-time live material
    // drift, not about bypassing scratch creation's separate exact-HEAD guard.
    const hostHandlers = createHostRunHandlers(
      { store, root: driftRoot, scanRoot: join(driftRoot, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
          storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN_ID,
          conclusion: 'pass', note: 'The old review tuple must not become evidence after live material drift.',
          ...managedReadEvidence(driftRoot, ['packages/main/src/story-owned.ts']),
        }),
        finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
      }) },
    );
    const runResult = await hostHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    git(driftRoot, ['checkout', 'main']);
    write(driftRoot, 'packages/main/src/unrelated-main-change.ts', 'export const unrelatedMainChange = true;\n');
    git(driftRoot, ['add', 'packages/main/src/unrelated-main-change.ts']);
    git(driftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'unrelated main material']);
    git(driftRoot, ['checkout', 'story/managed-import-drift']);
    git(driftRoot, ['merge', '--no-edit', 'main']);
    resetConfigCache();
    // The older ReviewRun freshness reader intentionally accepts this exact
    // whole-tree drift under its storyFilesHash advisory. Import is stricter:
    // it creates immutable gate evidence and must reject the old tuple.
    assert.doesNotThrow(() => assertCurrentReviewRunForEvidence(store, store.readStory(STORY_ID), driftRoot, LANE, REVIEW_RUN_ID),
      'control: advisory ReviewRun freshness accepts unrelated merged material drift');
    await eventually(async () => (await getManagedHostRunStatus({ root: driftRoot, runId: runResult.run.runId })).run.terminal !== null,
      'drift control managed reviewer did not complete');
    const receipt = managedHostRunReceipt(driftRoot, runResult.run.runId);
    assert.equal(verifyManagedReviewLiveBinding({
      gitCwd: driftRoot,
      metadataRoot: driftRoot,
      storyId: STORY_ID,
      expected: {
        headHash: updatedRun.headHash,
        materialHash: updatedRun.materialHash,
        storyFilesHash: updatedRun.storyFilesHash ?? '',
      },
    }).valid, false, 'canonical managed live binding rejects the advisory-stale source tree');
    const importHandlers = createManagedReviewEvidenceHandlers({ store, root: driftRoot, scanRoot: join(driftRoot, 'packages/main') });
    assert.throws(
      () => importHandlers.managed_review_evidence_import({ runId: runResult.run.runId, receiptId: receipt.receiptId }),
      /managed_review_live_(?:material_stale|head_lineage_invalid)/,
      'managed import must fail closed instead of accepting an advisory-stale ReviewRun tuple',
    );
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 0, 'rejected live drift creates no review evidence');
  } finally {
    resetConfigCache();
    rmSync(driftRoot, { recursive: true, force: true });
  }
}

export async function assertManagedImportAllowsSameMaterialMetadataAdvance(brokerPublicKey: string): Promise<void> {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-metadata-advance-'));
  try {
    const { store } = seedReviewStory(metadataRoot, brokerPublicKey);
    git(metadataRoot, ['checkout', '-b', 'story/managed-import-metadata-advance']);
    addCurrentReviewRun(metadataRoot, store, CONCEPT_LANE, CONCEPT_REVIEW_RUN_ID);
    refreshCandidateArtifact(metadataRoot, store, 'shadow');
    const completeReceipt = async (lane: string, reviewRunId: string): Promise<{ runId: string; receiptId: string }> => {
      const hostHandlers = createHostRunHandlers(
        { store, root: metadataRoot, scanRoot: join(metadataRoot, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: JSON.stringify({
            schemaVersion: 'lattice.managed_review_final_proposal.v1',
            storyId: STORY_ID,
            providerAgent: lane,
            lane,
            reviewRunId,
            conclusion: 'pass',
            note: `The ${lane} provider reviewed the signed managed tuple.`,
            ...managedReadEvidence(metadataRoot),
          }),
          finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
        }) },
      );
      const submitted = await hostHandlers.host_run({
        host: 'codex', storyId: STORY_ID, agentType: lane, reviewRunId, lane,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root: metadataRoot, runId: submitted.run.runId })).run.state === 'completed',
        `${lane} managed reviewer did not complete`);
      const receipt = managedHostRunReceipt(metadataRoot, submitted.run.runId);
      return { runId: submitted.run.runId, receiptId: receipt.receiptId };
    };

    const conceptReceipt = await completeReceipt(CONCEPT_LANE, CONCEPT_REVIEW_RUN_ID);
    const qualityReceipt = await completeReceipt(LANE, REVIEW_RUN_ID);
    const importHandlers = createManagedReviewEvidenceHandlers({
      store,
      root: metadataRoot,
      scanRoot: join(metadataRoot, 'packages/main'),
    });
    const reviewHeadBeforeImport = currentGitHead(metadataRoot)!;
    const reviewedMaterial = currentMaterialHash(metadataRoot)!;

    assert.match(
      importHandlers.managed_review_evidence_import(conceptReceipt),
      /Managed review evidence imported/,
      'the first lane receipt imports and records only story metadata',
    );
    assert.notEqual(currentGitHead(metadataRoot), reviewHeadBeforeImport,
      'the first import auto-commits its story metadata and advances HEAD');
    assert.equal(
      git(metadataRoot, ['show', '-s', '--format=%s', 'HEAD']),
      `${COMMIT_SUBJECT_PREFIX} record ${STORY_ID} managed_review_evidence_import metadata`,
      'the first metadata advance must be the canonical managed importer commit',
    );
    const firstImporterFiles = git(metadataRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n');
    assert.ok(firstImporterFiles.every(path => path.startsWith(`${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/`)),
      `canonical importer scope is story-local: ${firstImporterFiles.join(', ')}`);
    assert.ok(firstImporterFiles.includes(`${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/review-passes.json`), firstImporterFiles.join(', '));
    assert.equal(currentMaterialHash(metadataRoot), reviewedMaterial,
      'the metadata-only import commit preserves the reviewed material hash');
    const adjacentDirtyStory = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...adjacentDirtyStory, description: `${adjacentDirtyStory.description} adjacent importer dirt` });
    git(metadataRoot, ['add', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    assert.throws(
      () => importHandlers.managed_review_evidence_import(qualityReceipt),
      /story metadata has staged changes/,
      'receipt importer rejects pre-staged adjacent story metadata instead of sweeping it into an importer commit',
    );
    git(metadataRoot, ['reset', 'HEAD', '--', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    store.writeStory(STORY_ID, adjacentDirtyStory);
    assert.match(
      importHandlers.managed_review_evidence_import(qualityReceipt),
      /Managed review evidence imported/,
      'a second same-round receipt remains admissible after the first lane metadata commit',
    );
    assert.deepEqual(
      store.readReviewPasses(STORY_ID).passes.map(pass => pass.agent).sort(),
      [CONCEPT_LANE, LANE].sort(),
      'each required reviewer lane keeps its own receipt-bound review pass',
    );

    const manualStory = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...manualStory, description: `${manualStory.description} Manual metadata drift.` });
    git(metadataRoot, ['add', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    git(metadataRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'manual same-material metadata drift']);
    assert.equal(currentMaterialHash(metadataRoot), reviewedMaterial,
      'control: the manual metadata-only commit preserves materialHash');
    assert.throws(
      () => importHandlers.managed_review_evidence_import(qualityReceipt),
      /managed_review_live_head_lineage_invalid/,
      'a same-material non-importer commit cannot admit an old managed receipt',
    );

    // F-235: the matching importer subject is insufficient when another
    // metadata tree happens to use the same story id and basename. Only the
    // configured canonical story directory owns an admissible importer advance.
    const beforeForeignLookalike = currentGitHead(metadataRoot)!;
    write(metadataRoot, `.lattice/foreign/${STORY_ID}/review-passes.json`, '{"forged":true}\n');
    git(metadataRoot, ['add', `.lattice/foreign/${STORY_ID}/review-passes.json`]);
    git(metadataRoot, [
      '-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit',
      '-m', `${COMMIT_SUBJECT_PREFIX} record ${STORY_ID} managed_review_evidence_import metadata`,
    ]);
    assert.equal(verifyManagedReviewLiveBinding({
      gitCwd: metadataRoot,
      metadataRoot,
      storyId: STORY_ID,
      expected: {
        headHash: beforeForeignLookalike,
        materialHash: reviewedMaterial,
        storyFilesHash: '',
      },
    }).valid, false,
    'same-subject lookalike metadata outside the configured story directory cannot advance managed receipt lineage');

    // assertManagedImportRejectsLiveMaterialDrift covers source/material drift.
    // This fixture isolates F-219's same-material non-importer lineage break.
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 2,
      'the rejected same-material lineage receipt creates no review pass');
  } finally {
    resetConfigCache();
    rmSync(metadataRoot, { recursive: true, force: true });
  }
}

export async function assertManagedImportRejectsLateLiveMaterialDrift(brokerPublicKey: string): Promise<void> {
  const lateDriftRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-late-live-drift-'));
  try {
    const { store } = seedReviewStory(lateDriftRoot, brokerPublicKey);
    const hostHandlers = createHostRunHandlers(
      { store, root: lateDriftRoot, scanRoot: join(lateDriftRoot, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
          storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN_ID,
          conclusion: 'pass', note: 'An authentic receipt is safe only for its exact live review tuple.',
          ...managedReadEvidence(lateDriftRoot),
        }),
        finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
      }) },
    );
    const submitted = await hostHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: lateDriftRoot, runId: submitted.run.runId })).run.state === 'completed',
      'late-drift managed reviewer did not complete');
    const receipt = managedHostRunReceipt(lateDriftRoot, submitted.run.runId);
    const handlers = createManagedReviewEvidenceHandlers({ store, root: lateDriftRoot, scanRoot: join(lateDriftRoot, 'packages/main') });
    assert.match(
      handlers.managed_review_evidence_import({ runId: submitted.run.runId, receiptId: receipt.receiptId }),
      /Managed review evidence imported/,
      'control: the exact current managed receipt imports before the late commit',
    );

    const originalReadFindings = store.readFindings.bind(store);
    let committedDuringLockedImport = false;
    store.readFindings = ((storyId: string) => {
      const data = originalReadFindings(storyId);
      if (!committedDuringLockedImport) {
        committedDuringLockedImport = true;
        write(lateDriftRoot, 'packages/main/src/late-import-drift.ts', 'export const lateImportDrift = true;\n');
        git(lateDriftRoot, ['add', 'packages/main/src/late-import-drift.ts']);
        git(lateDriftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'late import material drift']);
        resetConfigCache();
      }
      return data;
    }) as typeof store.readFindings;
    try {
      assert.throws(
        () => handlers.managed_review_evidence_import({ runId: submitted.run.runId, receiptId: receipt.receiptId }),
        /managed_review_live_material_stale/,
        'a commit after preflight but before reuse-side persistence must fail closed',
      );
    } finally {
      store.readFindings = originalReadFindings;
    }
    assert.equal(committedDuringLockedImport, true, 'the late source commit was injected from the locked import path');
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 1,
      'late drift cannot create or duplicate review evidence during idempotent receipt reuse');
  } finally {
    resetConfigCache();
    rmSync(lateDriftRoot, { recursive: true, force: true });
  }
}

export async function assertManagedImportEnforcesCandidateReadBinding(brokerPublicKey: string): Promise<void> {
  for (const scenario of ['pass', 'findings', 'complete'] as const) {
  const candidateRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-candidate-binding-'));
  try {
    const { store } = seedReviewStory(candidateRoot, brokerPublicKey, { candidateRoutingMode: 'enforce' });
    const artifact = store.readCandidateSpecSet(STORY_ID);
    assert.ok(artifact && artifact.candidateSpecSet.length > 0,
      'candidate-binding fixture requires at least one routed document');
    const manifest = (filesReadFully: string[]) => ({
      filesReadFully,
      filesTriagedByName: [],
      scanEscalationReason: artifact!.scanEscalationReason,
      candidateSpecSetDigest: artifact!.artifactDigest,
      corpusDigest: artifact!.corpusDigest,
    });
    const completeReceipt = async (envelope: Record<string, unknown> | (() => Record<string, unknown>)): Promise<{ runId: string; receiptId: string }> => {
      const submitted = await createHostRunHandlers(
        { store, root: candidateRoot, scanRoot: join(candidateRoot, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: JSON.stringify(typeof envelope === 'function' ? envelope() : envelope),
          finalAssistantResultCount: 1,
          finalAssistantResultTruncated: false,
        }) },
      ).host_run({
        host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root: candidateRoot, runId: submitted.run.runId })).run.terminal !== null,
        'candidate-binding managed reviewer did not reach terminal');
      const status = await getManagedHostRunStatus({ root: candidateRoot, runId: submitted.run.runId });
      assert.equal(status.run.terminal?.state, 'completed',
        `candidate-binding managed reviewer must complete: ${status.run.terminal?.reason}`);
      return { runId: submitted.run.runId, receiptId: managedHostRunReceipt(candidateRoot, submitted.run.runId).receiptId };
    };
    const envelope = (conclusion: 'pass' | 'findings', readManifest: ReturnType<typeof manifest>) => ({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      conclusion,
      ...(conclusion === 'pass'
        ? { note: 'The provider completed the candidate-bound managed review.' }
        : { findings: [{
          desc: 'The provider found a candidate-bound managed review defect.',
          severity: 'medium',
          category: 'missing',
        }] }),
      readManifest,
      readLog: {
        filesReadFully: readManifest.filesReadFully,
        filesTriagedByName: [],
        summary: { readCount: readManifest.filesReadFully.length, tokenCount: null },
        digest: 'a'.repeat(64),
      },
    });
    const handlers = createManagedReviewEvidenceHandlers({
      store,
      root: candidateRoot,
      scanRoot: join(candidateRoot, 'packages/main'),
    });

    if (scenario !== 'complete') {
      const rejected = await completeReceipt(envelope(scenario, manifest(['packages/main/src/example.ts'])));
      assert.throws(
        () => handlers.managed_review_evidence_import(rejected),
        /candidate routing evidence rejected: read manifest is missing candidate full reads/,
        `a managed ${scenario} with matching routing digests but no full candidate read is rejected`,
      );
      assert.equal(store.readReviewPasses(STORY_ID).passes.length, 0,
        'candidate-incomplete managed evidence creates no REVIEW pass');
      assert.equal(store.readFindings(STORY_ID).findings.length, 0,
        'candidate-incomplete managed evidence creates no REVIEW finding');
      continue;
    }

    const acceptedPass = await completeReceipt(() => ({
      ...envelope('pass', manifest([])),
      ...managedReadEvidence(candidateRoot),
    }));
    assert.match(
      handlers.managed_review_evidence_import(acceptedPass),
      /Managed review evidence imported/,
      'a managed pass that fully reads every routed candidate imports successfully',
    );
    assert.match(
      handlers.managed_review_evidence_import(acceptedPass),
      /already imported/,
      'retry preserves a prior valid candidate-bound managed receipt without allocating duplicate evidence',
    );
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 1,
      'candidate-bound retry leaves exactly one imported managed pass');
  } finally {
    resetConfigCache();
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}
}
