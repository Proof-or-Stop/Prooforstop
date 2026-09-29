import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from "../../core/config.js";





import { managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus, readManagedReviewEvidenceProposal, readManagedHostRunResult, readManagedHostRunBinding, runManagedHostRunWorker, submitManagedHostRun, writeManagedReviewEvidenceProposal } from "../../core/managed-host-run.js";





import { captureReviewRunSnapshot, hashReviewPrompt } from "../../core/review-run.js";


import { generateEd25519KeyPair } from "../../core/authority-signing.js";




import { defaultHostRunRunner, type HostRunRunner } from "../../core/host-run.js";



import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { withoutManagedAmbientAuthority, withoutReviewerDispatchAuthority, STORY_ID, REVIEW_ROUND, LANE } from "./environment.js";
import { git, seedReviewStory, bindCurrentReviewEnvelope, managedReadEvidence } from "./fixtures.js";

export async function grokIsolatedIntegrationRegression(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Grok readonly integration requires the registered macOS adapter');
  const { realpathSync } = await import('node:fs');
  const { createReviewInventoryHandlers } = await import("../../handlers/review-inventory.js");
  const { deriveReviewerBatchSubject } = await import("../../core/reviewer-batch-subject.js");
  const { admitReviewerBatch } = await import("../../core/reviewer-batch-producer.js");
  const { prepareManagedSingletonAdmission, bindManagedSingletonSubmission } = await import("../../core/managed-launch-admission.js");
  const { ACCEPTANCE_REVIEW_PROFILE, ACCEPTANCE_REVIEW_LANE, ACCEPTANCE_REVIEW_FINAL_SCHEMA } = await import("../../core/acceptance-amendment-review.js");
  const { readManagedAcceptanceReviewReceipt, managedAcceptanceReviewPublicKey } = await import("../../core/managed-host-run.js");
  const { resetSessionIdForTest } = await import("../../core/owner-session.js");
  const repo = realpathSync(fileURLToPath(new URL("../../../../../", import.meta.url)));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'grok-isolated-integration-')));
  const original = { ...process.env }, originalCwd = process.cwd();
  const binaryDir = join(base, 'bin'); mkdirSync(binaryDir);
  execFileSync('cc', [join(repo, 'scripts/lab/u08-batch-admission/provider-grok-fixture.c'), '-o', join(binaryDir, 'grok')]);
  const workers: Promise<unknown>[] = [];
  const scratches: string[] = [];
  try {
    const allCases = ['review-pass', 'compat-late-error', 'compat-missing', 'acceptance-pass', 'acceptance-late-error'];
    const selected = process.argv[3] ? process.argv[3].split(',') : allCases;
    assert(selected.length > 0 && selected.every(name => allCases.includes(name)));
    for (const scenario of selected) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, withoutManagedAmbientAuthority(withoutReviewerDispatchAuthority(original)));
      process.env.PROOF_OR_STOP_SESSION_ID = 'grok-isolated-fixture';
      process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex'; resetSessionIdForTest();
      const root = join(base, scenario);
      execFileSync('git', ['clone', '--shared', '--no-checkout', repo, root], { stdio: 'pipe' });
      git(root, ['checkout', '-B', 'main', git(repo, ['rev-parse', 'HEAD'])]);
      git(root, ['config', 'user.name', 'Grok fixture']); git(root, ['config', 'user.email', 'grok@example.invalid']);
      process.chdir(root); resetConfigCache();
      const { store, run } = seedReviewStory(root, generateEd25519KeyPair().publicKey, { readonlyIsolation: true });
      const auth = join(base, scenario + '-auth'); mkdirSync(auth, { mode: 0o700 });
      const authText = JSON.stringify({ fixture: { key: 'synthetic-token', auth_mode: 'oidc' } });
      writeFileSync(join(auth, 'auth.json'), authText, { mode: 0o600 });
      writeFileSync(join(auth, 'config.toml'), '[cli]\nuse_leader = true\nauto_update = true\n');
      const acceptance = scenario.startsWith('acceptance');
      if (!acceptance) {
        createReviewInventoryHandlers({ root, store, scanRoot: join(root, 'packages/main') }).review_inventory_begin({ storyId: STORY_ID });
        // A new sequence, not a re-dated pre-wave run, is required by the real epoch boundary.
        const priorRun = structuredClone(run);
        const fresh = captureReviewRunSnapshot(root, { storyId: STORY_ID, storyPhase: 'REVIEW', currentReviewRound: REVIEW_ROUND }, root);
        Object.assign(run, { reviewRunId: STORY_ID + ':RR-002', startedAt: new Date().toISOString(), headHash: fresh.headHash, materialHash: fresh.materialHash, storyFilesHash: fresh.storyFilesHash });
        bindCurrentReviewEnvelope(root, store, run); store.writeReviewRuns(STORY_ID, { runs: [priorRun, run] });
      }
      const evidence = managedReadEvidence(root);
      const proposal = { storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: run.reviewRunId,
        conclusion: 'pass' as const, note: 'Synthetic Grok transport fixture inspected the declared files.', ...evidence };
      const subject = { amendmentId: 'AM-grok-fixture', amendmentDigest: 'a'.repeat(64), baseDigest: 'b'.repeat(64), submitterSessionId: 'fixture-owner' };
      const final = acceptance ? { schemaVersion: ACCEPTANCE_REVIEW_FINAL_SCHEMA, runId: 'FIXTURE_RUN_ID', storyId: STORY_ID,
        ...subject, decision: 'reject', rationale: 'Synthetic transport rejection only; no product amendment authority.', readRefs: ['packages/main/src/example.ts'] }
        : { schemaVersion: 'lattice.managed_review_final_proposal.v1', ...proposal };
      Object.assign(process.env, { PATH: binaryDir + ':' + original.PATH, GROK_HOME: auth,
        GROK_FIXTURE_ORIGINAL_HOME: auth, GROK_FIXTURE_FINAL: JSON.stringify(final),
        GROK_FIXTURE_MODE: scenario.includes('late-error') ? 'late-error' : scenario.includes('missing') ? 'missing' : 'success',
        GROK_FIXTURE_READ_FILES: evidence.readManifest.filesReadFully.join('\n') });
      if (acceptance) process.env.GROK_FIXTURE_ACCEPTANCE = '1';
      let worker: Promise<unknown> | undefined;
      const dependencies = {
        managedReviewScratchParentFactory: () => { const p = mkdtempSync(join(tmpdir(), 'lattice-managed-review-')); scratches.push(p); return p; },
        launchWorker: async (request: Parameters<typeof runManagedHostRunWorker>[0]) => {
          worker = runManagedHostRunWorker(request, { env: process.env,
            ...(scenario.startsWith('compat') ? { runner: async (plan: Parameters<HostRunRunner>[0]) => {
              // Controller-owned compatibility fixture, using the existing explicit injected-runner capability.
              writeManagedReviewEvidenceProposal({ root, runId: request.runId, proposal, environment: plan.env });
              return defaultHostRunRunner(plan);
            } } : {}) });
          workers.push(worker); return { pid: process.pid };
        },
      };
      let runId: string;
      const context = { root, store, scanRoot: join(root, 'packages/main') };
      if (!acceptance) {
        const batch = deriveReviewerBatchSubject(store, root, { storyId: STORY_ID });
        const admitted = await admitReviewerBatch({ root, store, storyId: STORY_ID, epochId: batch.subject.binding.epochId,
          wave: batch.subject.binding.wave, assignments: batch.requiredLanes.map(lane => ({ lane, kind: 'managed' as const, host: 'grok' })) });
        assert.equal(admitted.state, 'ADMITTED');
        const launched = await createHostRunHandlers(context, dependencies).host_run({ host: 'grok', storyId: STORY_ID,
          agentType: LANE, lane: LANE, reviewRunId: run.reviewRunId, managedReview: true, detach: true,
          deadlineMs: 600000, timeoutMs: 30000, json: true }) as HostRunDetachResult;
        runId = launched.run.runId;
      } else {
        store.writeStory(STORY_ID, { ...store.readStory(STORY_ID), phase: 'DEV' });
        const identity = 'sha256:' + 'd'.repeat(64);
        const token = await prepareManagedSingletonAdmission({ root, storyId: STORY_ID, host: 'grok', profile: ACCEPTANCE_REVIEW_PROFILE,
          lane: ACCEPTANCE_REVIEW_LANE, subjectIdentity: identity, deriveSubjectIdentity: () => identity, effectiveBaseEnvironment: { ...process.env } });
        const prompt = 'Synthetic bound acceptance review; return only the declared fixture rejection.';
        const snapshot = captureReviewRunSnapshot(root, { storyId: STORY_ID, storyPhase: 'DEV' }, root);
        const submitted = await submitManagedHostRun(bindManagedSingletonSubmission({ root, cwd: root, host: 'grok', storyId: STORY_ID,
          phase: 'DEV', agentType: ACCEPTANCE_REVIEW_LANE, lane: ACCEPTANCE_REVIEW_LANE, reviewRunId: STORY_ID + ':AMR-fixture',
          profile: ACCEPTANCE_REVIEW_PROFILE, isolateManagedReview: true, acceptanceReviewBinding: subject, promptText: prompt,
          deadlineMs: 600000, timeoutMs: 30000, projectRootHash: 'sha256:fixture', environment: { ...process.env },
          reviewBinding: { headHash: git(root, ['rev-parse', 'HEAD']), materialHash: snapshot.materialHash!, storyFilesHash: snapshot.storyFilesHash!,
            promptHash: hashReviewPrompt(prompt), managedPromptDigest: 'sha256:' + hashReviewPrompt(prompt), envelopeId: null } }, token), dependencies);
        runId = submitted.runId;
      }
      assert.ok(worker, 'a real admitted worker must launch'); await worker;
      const fixtureSpec = JSON.parse(readFileSync(join(managedHostRunDirectory(root, runId), 'spec.json'), 'utf8'));
      if (fixtureSpec.managedReviewScratch?.parent) assert.equal(existsSync(fixtureSpec.managedReviewScratch.parent), false, 'actual worker scratch was removed');
      const receipt = managedHostRunReceipt(root, runId);
      const positive = scenario === 'review-pass' || scenario === 'acceptance-pass';
      assert.equal(receipt.state, positive ? 'completed' : 'failed', JSON.stringify({ scenario, receipt, result: readManagedHostRunResult(root, runId) }));
      assert.equal(receipt.processCleanup?.reaped, true);
      assert.equal(readManagedHostRunBinding(root, runId).host, 'grok');
      assert.match(readFileSync(join(managedHostRunDirectory(root, runId), 'live-output.jsonl'), 'utf8'), /GROK_FIXTURE_PRIVATE_HOME_VERIFIED/);
      assert.equal(readFileSync(join(auth, 'auth.json'), 'utf8'), authText);
      assert.match(readFileSync(join(auth, 'config.toml'), 'utf8'), /use_leader = true/);
      if (scenario === 'review-pass') {
        assert.match(createManagedReviewEvidenceHandlers(context).managed_review_evidence_import({ runId, receiptId: receipt.receiptId }), /Managed review evidence imported/);
        const pass = store.readReviewPasses(STORY_ID).passes.find(row => row.managedEvidenceBinding?.runId === runId);
        assert.equal(pass?.managedEvidenceBinding?.providerHost, 'grok');
      } else if (scenario.startsWith('compat')) {
        assert.ok(readManagedReviewEvidenceProposal(root, runId), 'valid compatibility proposal was actually written');
        assert.equal((await getManagedHostRunStatus({ root, runId })).run.terminal?.reason, 'grok_compatibility_proposal_unsupported');
        assert.throws(() => createManagedReviewEvidenceHandlers(context).managed_review_evidence_import({ runId, receiptId: receipt.receiptId }), /failed|completed|terminal|receipt|signature_invalid,producer_owned_required/);
      } else {
        const expected = { ...subject, storyId: STORY_ID, promptDigest: readManagedHostRunBinding(root, runId).promptDigest,
          publicKey: managedAcceptanceReviewPublicKey(root, runId)! };
        if (positive) assert.equal(readManagedAcceptanceReviewReceipt(root, runId, expected).proposal.decision, 'reject');
        else assert.throws(() => readManagedAcceptanceReviewReceipt(root, runId, expected), /proposal|receipt|completed|terminal/);
      }
      assert.equal(scratches.every(p => !existsSync(p)), true, 'all owned readonly lanes are cleaned');
      console.log('GROK_ISOLATED_INTEGRATION_CASE_PASS', scenario);
    }
    console.log(process.argv[3] ? 'GROK_ISOLATED_SELECTED_CASES_PASS' : 'GROK_ISOLATED_ADMISSION_WORKER_IMPORT_ACCEPTANCE_PASS');
  } finally {
    await Promise.allSettled(workers);
    process.chdir(originalCwd); resetConfigCache(); resetSessionIdForTest();
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original);
    for (const p of scratches) rmSync(p, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true });
  }
}
