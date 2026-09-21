import assert from 'node:assert/strict';


import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from "../../core/config.js";

import { PROOF_OR_STOP_STORY_DIR } from "../../core/proof-or-stop-paths.js";

import { currentMaterialHash } from "../../core/evidence-freshness.js";

import { managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus } from "../../core/managed-host-run.js";





import { classifyManagedLiveBindingFailure, collectReviewerEvidenceState } from "../../core/review-run.js";
import { signReviewPass, verifyReviewPass } from "../../core/finding-verify.js";

import { generateEd25519KeyPair } from "../../core/authority-signing.js";





import type { ReviewRun } from "../../core/types.js";
import { createFindingHandlers } from "../../handlers/finding.js";

import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { seedReviewStory, managedReadEvidence, eventually, addCurrentReviewRun, write, git, refreshCandidateArtifact } from "./fixtures.js";
import { STORY_ID, MANAGED_REVIEW_FIXTURE_DEADLINE_MS, LANE, CONCEPT_LANE, withHostOwnedMutationEnv } from "./environment.js";

export async function managedSupersessionRegression(): Promise<void> {
  const material = `managed_review_live_material_stale:reviewed=${'a'.repeat(64)}:live=${'b'.repeat(64)}`;
  const lineage = (left: number, right: number) =>
    `managed_review_live_head_lineage_invalid:reviewed=${'a'.repeat(left)}:live=${'b'.repeat(right)}`;
  for (const reason of [material, lineage(40, 40), lineage(40, 64), lineage(64, 40), lineage(64, 64)]) {
    assert.equal(classifyManagedLiveBindingFailure(reason, false), 'stale_run_hash', reason);
    assert.equal(classifyManagedLiveBindingFailure(reason, true), 'managed_receipt_invalid', `dual binding: ${reason}`);
  }
  for (const reason of ['', 'unknown_failure', 'managed_review_live_head_unavailable',
    'managed_review_live_material_unavailable', 'managed_review_live_material_stale',
    `managed_review_live_material_stale:reviewed=${'a'.repeat(64)}:live=unavailable`,
    material.replace('a'.repeat(64), 'A'.repeat(64)), material.replace('b'.repeat(64), 'b'.repeat(63)),
    'prefix:' + material, material + ':suffix', material + '\n', lineage(39, 40), lineage(40, 65),
    lineage(40, 40).replace('b'.repeat(40), 'B'.repeat(40)), lineage(40, 40) + ':suffix']) {
    assert.equal(classifyManagedLiveBindingFailure(reason, false), 'managed_receipt_invalid', reason);
  }
  const root = mkdtempSync(join(tmpdir(), 'managed-review-supersession-'));
  const beforeCwd = process.cwd();
  try {
    process.chdir(root);
    const { publicKey } = generateEd25519KeyPair();
    const { store, run } = seedReviewStory(root, publicKey);
    const context = { store, root, scanRoot: join(root, 'packages/main') };
    const importer = createManagedReviewEvidenceHandlers(context);
    const importResult = async (review: ReviewRun, conclusion: 'pass' | 'findings' = 'pass') => {
      const launched = await createHostRunHandlers(context, {
        runner: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false,
          terminalReason: 'completed', finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
          finalAssistantResult: JSON.stringify({ schemaVersion: 'lattice.managed_review_final_proposal.v1',
            storyId: STORY_ID, providerAgent: review.agent, lane: review.lane,
            reviewRunId: review.reviewRunId, conclusion,
            ...(conclusion === 'pass' ? { note: 'The exact fixture candidate has no blocking quality defect.' }
              : { findings: [{ desc: 'The fixture records an open defect that a later pass must not hide.', severity: 'high', category: 'missing' }] }),
            ...managedReadEvidence(root),
          }),
        }),
      }).host_run({ host: 'codex', storyId: STORY_ID, agentType: review.agent,
        reviewRunId: review.reviewRunId, lane: review.lane, managedReview: true,
        detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root, runId: launched.run.runId })).run.terminal !== null,
        'supersession fixture must reach a sealed terminal');
      const status = await getManagedHostRunStatus({ root, runId: launched.run.runId });
      assert.equal(status.run.state, 'completed', 'supersession fixture provider must complete');
      const receipt = managedHostRunReceipt(root, launched.run.runId);
      assert.match(importer.managed_review_evidence_import({ runId: launched.run.runId, receiptId: receipt.receiptId }),
        /Managed review evidence imported/);
    };
    await importResult(run);
    const oldPass = structuredClone(store.readReviewPasses(STORY_ID).passes[0]!);
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).valid.some(e => e.id === oldPass.id),
      'control: the original imported managed pass is authentic and current');
    const findingsRun = addCurrentReviewRun(root, store, LANE, `${STORY_ID}:RR-002`);
    await importResult(findingsRun, 'findings');
    const openFindings = structuredClone(store.readFindings(STORY_ID));
    assert.equal(openFindings.findings.length, 1, 'control: the open finding must be genuinely imported');
    // Keep the independent finding control out of the positive PASS-only assertion.
    store.writeFindings(STORY_ID, { findings: [] });
    write(root, 'packages/main/src/example.ts', 'export const example = false;\n');
    git(root, ['add', 'packages/main/src/example.ts']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', 'commit', '-m', 'change reviewed fixture material']);
    resetConfigCache();
    refreshCandidateArtifact(root, store, 'shadow');
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e =>
      e.evidenceId === oldPass.id && e.code === 'stale_run_hash'
      && e.message.includes('managed_review_live_material_stale')),
      'the original PASS reaches the material-drift classifier before replacement');
    const latestRun = addCurrentReviewRun(root, store, LANE, `${STORY_ID}:RR-003`);
    await importResult(latestRun);
    const allPasses = structuredClone(store.readReviewPasses(STORY_ID));
    const newPass = allPasses.passes.find(p => p.id !== oldPass.id)!;
    assert.ok(newPass && Date.parse(newPass.createdAt) > Date.parse(oldPass.createdAt));
    const positive = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(positive.valid.some(e => e.id === newPass.id), 'control: the replacement is a fully valid current same-lane pass');
    assert.ok(!positive.valid.some(e => e.id === oldPass.id), 'historical PASS must never regain current authority');
    assert.ok(!positive.invalid.some(e => e.evidenceId === oldPass.id),
      'MANAGED_SUPERSESSION_RED: an authenticated material-stale PASS must be superseded by a newer valid same-lane PASS');
    assert.deepEqual(store.readReviewPasses(STORY_ID), allPasses, 'projection preserves both signed historical records');
    store.writeReviewPasses(STORY_ID, { passes: [oldPass] });
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === oldPass.id),
      'without a valid replacement the old PASS still blocks');
    store.writeReviewPasses(STORY_ID, allPasses);
    store.writeFindings(STORY_ID, openFindings);
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.kind === 'finding'),
      'a newer PASS cannot hide the genuinely imported open finding');
    store.writeFindings(STORY_ID, { findings: [] });
    // An authentic outer signature is insufficient if the sealed managed artifact was modified.
    const receiptDirectory = managedHostRunDirectory(root, oldPass.managedEvidenceBinding!.runId);
    const terminalPath = join(receiptDirectory, 'terminal.json');
    const terminalBytes = readFileSync(terminalPath);
    try {
      writeFileSync(terminalPath, Buffer.concat([terminalBytes, Buffer.from(' ')]));
      assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e =>
        e.evidenceId === oldPass.id && e.code === 'managed_receipt_invalid'),
      'tampered managed terminal must not be forgiven as ordinary stale evidence');
    } finally { writeFileSync(terminalPath, terminalBytes); }
    assert.ok(!collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === oldPass.id),
      'restoring the exact sealed terminal restores historical supersession only');
    const resignPass = (pass: typeof oldPass) => {
      pass._hash = signReviewPass(STORY_ID, pass.id, pass.agent, pass.note, pass.createdAt,
        pass.reviewRound ?? '', pass.reviewRunId ?? '', pass.readManifest, pass.readLog,
        pass.readDiagnostics, { writerSessionId: pass.writerSessionId!, sessionSource: pass.sessionSource! },
        pass.envelopeId, pass.managedEvidenceBinding, pass.nativeEvidenceBinding);
      return pass;
    };
    const unbound = structuredClone(oldPass);
    delete unbound.managedEvidenceBinding;
    store.writeReviewPasses(STORY_ID, { passes: [resignPass(unbound), newPass] });
    assert.ok(!collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === oldPass.id),
      'legacy stale unbound PASS keeps its existing supersession behavior');
    store.writeReviewPasses(STORY_ID, { passes: [unbound] });
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === oldPass.id),
      'stale unbound PASS still blocks without valid newer evidence');
    const conflicting = structuredClone(oldPass);
    // verifyReviewPass rejects dual bindings before computing any digest. No
    // caller-authored hash can make this record reach the later authority guard.
    // Pin the actual consumer boundary; do not claim coverage of an unreachable
    // valid-signature dual-PASS branch.
    conflicting.nativeEvidenceBinding = { invocationNonce: 'conflicting-fixture' } as NonNullable<typeof conflicting.nativeEvidenceBinding>;
    assert.throws(() => resignPass(conflicting), /managed and native evidence bindings are mutually exclusive/,
      'the public signer refuses to mint a conflicting authority record');
    assert.equal(verifyReviewPass(STORY_ID, conflicting), false,
      'dual binding is refused independently of any caller-computed outer digest');
    store.writeReviewPasses(STORY_ID, { passes: [conflicting, newPass] });
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e =>
      e.evidenceId === oldPass.id && e.code === 'invalid_evidence_signature'),
      'stale dual PASS is rejected at the exact outer consumer boundary despite valid replacement');
    const freshConflict = structuredClone(newPass);
    freshConflict.nativeEvidenceBinding = conflicting.nativeEvidenceBinding;
    assert.equal(verifyReviewPass(STORY_ID, freshConflict), false);
    store.writeReviewPasses(STORY_ID, { passes: [freshConflict] });
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e =>
      e.evidenceId === newPass.id && e.code === 'invalid_evidence_signature'),
      'fresh dual PASS is rejected at the same outer boundary');
    store.writeReviewPasses(STORY_ID, allPasses);
    const badReplacement = structuredClone(newPass);
    badReplacement._hash = '0'.repeat(64);
    store.writeReviewPasses(STORY_ID, { passes: [oldPass, badReplacement] });
    const invalidReplacement = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(invalidReplacement.invalid.some(e => e.evidenceId === oldPass.id),
      'an invalid newer replacement cannot forgive the stale PASS');
    store.writeReviewPasses(STORY_ID, allPasses);
    const otherLane = addCurrentReviewRun(root, store, CONCEPT_LANE, `${STORY_ID}:RR-004`);
    await importResult(otherLane);
    const withOtherLane = structuredClone(store.readReviewPasses(STORY_ID));
    const otherPass = withOtherLane.passes.find(p => p.agent === CONCEPT_LANE)!;
    assert.ok(otherPass, 'control: the other lane has a genuine imported PASS');
    store.writeReviewPasses(STORY_ID, { passes: [oldPass, otherPass] });
    const wrongLane = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(wrongLane.valid.some(e => e.id === otherPass.id), 'control: different-lane replacement is valid');
    assert.ok(wrongLane.invalid.some(e => e.evidenceId === oldPass.id),
      'a valid record from another lane cannot forgive the old PASS');
    store.writeReviewPasses(STORY_ID, withOtherLane);
    const materialBefore = currentMaterialHash(root);
    const metadataPath = `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/summary.md`;
    write(root, metadataPath, 'Fixture-only unrecognized metadata commit.\n');
    git(root, ['add', metadataPath]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', 'commit', '-m', 'fixture non-importer metadata movement']);
    assert.equal(currentMaterialHash(root), materialBefore, 'lineage control must preserve material identity');
    const beforeReplacement = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(beforeReplacement.invalid.some(e => e.evidenceId === newPass.id
      && e.message.includes('managed_review_live_head_lineage_invalid')),
      'control: same-material non-importer movement invalidates the old live lineage');
    const latestLineage = addCurrentReviewRun(root, store, LANE, `${STORY_ID}:RR-005`);
    await importResult(latestLineage);
    const lineage = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(lineage.valid.some(e => e.reviewRunId === latestLineage.reviewRunId),
      'control: the replacement binds the new lineage');
    assert.ok(!lineage.invalid.some(e => e.evidenceId === oldPass.id || e.evidenceId === newPass.id),
      'authenticated material and lineage staleness are superseded only by current same-lane evidence');
    // Keep this finding on the latest lane run, so the test reaches managed
    // authentication rather than the older F-019 stale_run short circuit.
    const terminalRun = addCurrentReviewRun(root, store, LANE, `${STORY_ID}:RR-006`);
    await importResult(terminalRun, 'findings');
    const terminalFinding = store.readFindings(STORY_ID).findings[0]!;
    withHostOwnedMutationEnv(() => createFindingHandlers(context).finding_resolve({
      storyId: STORY_ID, findingId: terminalFinding.id,
      resolution: 'Disposable regression resolution through the official handler; this is not a real Story finding.',
    }));
    const resolvedFindings = structuredClone(store.readFindings(STORY_ID));
    assert.equal(resolvedFindings.findings[0]!.status, 'resolved');
    write(root, 'packages/main/src/example.ts', 'export const example = null;\n');
    git(root, ['add', 'packages/main/src/example.ts']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', 'commit', '-m', 'terminal finding material drift']);
    store.writeReviewPasses(STORY_ID, { passes: [] });
    const resolvedId = resolvedFindings.findings[0]!.id;
    assert.ok(!collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === resolvedId),
      'authenticated resolved managed finding follows F-019 without a replacement on its lane');
    const findingTerminal = join(managedHostRunDirectory(root,
      resolvedFindings.findings[0]!.managedEvidenceBinding!.runId), 'terminal.json');
    const findingTerminalBytes = readFileSync(findingTerminal);
    try {
      writeFileSync(findingTerminal, Buffer.concat([findingTerminalBytes, Buffer.from(' ')]));
      assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e =>
        e.evidenceId === resolvedId && e.code === 'managed_receipt_invalid'),
      'F-019 must not forgive a resolved managed finding with a tampered terminal');
    } finally { writeFileSync(findingTerminal, findingTerminalBytes); }
    assert.ok(!collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(e => e.evidenceId === resolvedId),
      'exact terminal restoration restores resolved-finding forgiveness');
    console.log('MANAGED_SUPERSESSION_PASS');
  } finally {
    process.chdir(beforeCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}
