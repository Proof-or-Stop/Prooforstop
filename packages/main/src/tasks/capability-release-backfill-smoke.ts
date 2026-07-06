#!/usr/bin/env node
/**
 * @task B-c389
 * @checklist CHK-001
 * @title capability_release_backfill CLI (dry-run/apply/--digest) smoke
 * @type feature
 * @priority high
 * @description
 *   Hermetic proof of the M8 capability_release_backfill record-then-bind migration
 *   via the real handler (createCapabilityReleaseBackfillHandlers).
 *
 *   CASE A — 'bind' (a capability release already exists):
 *     - dry-run detects EXACTLY ONE eligible under-bound candidate and a STABLE digest;
 *     - apply with the WRONG / MISSING --digest is refused;
 *     - apply with the RIGHT --digest enriches EXACTLY ONE candidate's lineage;
 *     - a second run finds 0 eligible (idempotent);
 *     - status stays 'candidate', usage.surfacedCount unchanged, no outcome written,
 *       the capability-releases ledger is byte-identical (no new PCR for a pure bind).
 *
 *   CASE B — 'record-then-bind' (an ARTIFACT release exists but NO capability release,
 *   the real PBP-882/B-785e shape):
 *     - dry-run reports the candidate as eligible with plan='record-then-bind' and the
 *       PCR it WOULD record (id/version derived from the artifact release's paths);
 *     - apply RECORDS the capability release into .lattice/capability-releases.jsonl
 *       (git add -f + commit — verified tracked), THEN binds the candidate;
 *     - re-run is idempotent (PCR now exists, candidate bound → 0 eligible);
 *     - status/usage invariants hold and no outcome is written.
 * @changes
 *   - [CHK-001] Cover capability_release_backfill dry-run/apply/--digest + invariants.
 *   - [CHK-001] Add the record-then-bind migration case (artifact release → recorded PCR).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createArtifactReleaseRecordForTest,
  writeArtifactReleaseLedgerForTest,
} from '../core/artifact-release.js';
import {
  capabilityReleaseLedgerPath,
  createCapabilityReleaseRecordForTest,
  readCapabilityReleaseLedger,
  writeCapabilityReleaseLedgerForTest,
} from '../core/capability-release.js';
import type { Playbook } from '../core/experience-layer-types.js';
import {
  readPlaybookOutcomeEvents,
  readPlaybooks,
  resolvePlaybookOutcomesPath,
  writePlaybooks,
} from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import { createCapabilityReleaseBackfillHandlers } from '../handlers/capability-release-backfill.js';

const NOW = '2026-07-05T00:00:00.000Z';

function mkdtemp(prefix: string): string {
  return execFileSync('mktemp', ['-d', join(tmpdir(), `${prefix}XXXXXX`)], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Initialize a hermetic git repo so the record-then-bind commit path is real. */
function gitInit(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@noreply.local']);
  git(root, ['config', 'user.name', 'smoke']);
  git(root, ['config', 'commit.gpgsign', 'false']);
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function candidatePlaybook(id: string, sourceStoryId: string, bound: boolean): Playbook {
  return {
    id,
    title: `Playbook: DONE experience ${sourceStoryId}`,
    trigger: { keywords: [sourceStoryId.toLowerCase()], fileKinds: [], storyPhases: ['DONE', 'REVIEW'] },
    check: 'Before similar work, apply this DONE experience.',
    pitfalls: ['Do not treat DONE experience seed material as authoritative gate evidence.'],
    verification: [`Confirm the source condition behind ${sourceStoryId}:DONE-EXPERIENCE cannot recur`],
    lineage: {
      sourceStoryId,
      sourceFindingId: `${sourceStoryId}:DONE-EXPERIENCE`,
      sourceSignature: 'done_experience',
      // `bound` candidates already carry a capabilityReleaseId (must be ignored).
      ...(bound
        ? { capabilityReleaseId: 'PCR-preexisting', capabilityId: 'x', capabilityVersion: 'yyyyyyyyyyyy' }
        : {}),
    },
    status: 'candidate',
    usage: { surfacedCount: 7, resolvedHits: 0, dismissedHits: 0 },
  };
}

const cleanup: string[] = [];

try {
  // ════════════════════════════════════════════════════════════════════════════
  // CASE A — 'bind' (a capability release already exists for the story)
  // ════════════════════════════════════════════════════════════════════════════
  const root = mkdtemp('capability-release-backfill-smoke-');
  cleanup.push(root);
  write(root, 'lattice.config.json', '{}');

  // ── Fixture: one capability release for B-785e; three candidate playbooks ─────
  //   PBP-882  → B-785e, UNBOUND    → the single eligible candidate (plan='bind').
  //   PBP-bound→ B-785e, ALREADY BOUND (capabilityReleaseId present) → ineligible.
  //   PBP-nostory → B-9999, UNBOUND, NO capability AND NO artifact release → ineligible.
  const capabilityRelease = createCapabilityReleaseRecordForTest({
    root,
    storyId: 'B-785e',
    mainCommit: 'a'.repeat(40),
    capabilityId: 'experiments-multi-model-ablation',
    capabilityKind: 'experiment-launch-control',
    changedPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
    capabilityPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
    artifactReleaseId: 'AR-4e885ed0209e5a32330cdc33',
    artifactSetDigest:
      'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
    runtimeSemverChanged: false,
    now: NOW,
  });
  writeCapabilityReleaseLedgerForTest(root, [capabilityRelease]);
  const ledgerPath = capabilityReleaseLedgerPath(root);
  const ledgerBefore = readFileSync(ledgerPath, 'utf-8');

  writePlaybooks(root, [
    candidatePlaybook('PBP-882', 'B-785e', false),
    candidatePlaybook('PBP-bound', 'B-785e', true),
    candidatePlaybook('PBP-nostory', 'B-9999', false),
  ]);

  const handlers = createCapabilityReleaseBackfillHandlers({ store: new StoryStore(root), root, scanRoot: root });
  const backfill = handlers.capability_release_backfill;

  // ── DRY-RUN: exactly one eligible + stable plan digest ────────────────────────
  let dryDigest = '';
  check('dry-run detects exactly one eligible under-bound candidate + a plan digest', () => {
    const report = JSON.parse(backfill({ json: true }));
    assert.equal(report.dryRun, true);
    assert.equal(report.applied, false);
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
    assert.equal(report.eligibleCount, 1, 'only PBP-882 (unbound, has a release) is eligible');
    assert.equal(report.eligible.length, 1);
    const row = report.eligible[0];
    assert.equal(row.playbookId, 'PBP-882');
    assert.equal(row.sourceStoryId, 'B-785e');
    assert.equal(row.plan, 'bind', 'a pre-existing capability release is a pure bind');
    assert.equal(row.capabilityReleaseId, capabilityRelease.id);
    assert.equal(row.capabilityId, capabilityRelease.capabilityId);
    assert.equal(row.capabilityVersion, capabilityRelease.capabilityVersion);
    assert.equal(row.artifactReleaseId, capabilityRelease.artifactReleaseId);
    assert.equal(report.recordThenBindCount, 0, 'CASE A has no record-then-bind rows');
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(report.planDigest), 'planDigest is a sha256');
    dryDigest = report.planDigest;
  });

  check('dry-run plan digest is stable across re-runs (deterministic)', () => {
    const a = JSON.parse(backfill({ json: true })).planDigest;
    const b = JSON.parse(backfill({ json: true })).planDigest;
    assert.equal(a, b);
    assert.equal(a, dryDigest);
  });

  check('dry-run writes NOTHING (playbooks unchanged, no outcome, ledger intact)', () => {
    const pbs = readPlaybooks(root);
    assert.equal(pbs.find((p) => p.id === 'PBP-882')?.lineage.capabilityReleaseId, undefined);
    assert.equal(readPlaybookOutcomeEvents(root).length, 0);
    assert.equal(readFileSync(ledgerPath, 'utf-8'), ledgerBefore);
  });

  // ── APPLY with the WRONG digest is refused ────────────────────────────────────
  check('apply with the WRONG --digest is refused (drift)', () => {
    assert.throws(
      () => backfill({ apply: true, digest: 'sha256:' + '0'.repeat(64) }),
      /plan digest drift/,
    );
    // Nothing was written by the refused apply.
    assert.equal(readPlaybooks(root).find((p) => p.id === 'PBP-882')?.lineage.capabilityReleaseId, undefined);
  });

  check('apply WITHOUT a --digest is refused', () => {
    assert.throws(() => backfill({ apply: true }), /requires --digest/);
  });

  // ── APPLY with the RIGHT digest enriches EXACTLY one ──────────────────────────
  check('apply with the RIGHT --digest enriches exactly one candidate', () => {
    const report = JSON.parse(backfill({ apply: true, digest: dryDigest, json: true }));
    assert.equal(report.dryRun, false);
    assert.equal(report.applied, true);
    assert.equal(report.eligibleCount, 1);
    assert.equal(report.enrichedCount, 1);
    assert.equal(report.recordedReleaseCount, 0, 'a pure bind records no new capability release');

    const pbs = readPlaybooks(root);
    const enriched = pbs.find((p) => p.id === 'PBP-882')!;
    assert.equal(enriched.lineage.capabilityReleaseId, capabilityRelease.id);
    assert.equal(enriched.lineage.capabilityId, capabilityRelease.capabilityId);
    assert.equal(enriched.lineage.capabilityVersion, capabilityRelease.capabilityVersion);
    assert.equal(enriched.lineage.artifactReleaseId, capabilityRelease.artifactReleaseId);

    // INVARIANTS: status stays candidate; usage.surfacedCount unchanged (was 7).
    assert.equal(enriched.status, 'candidate');
    assert.equal(enriched.usage.surfacedCount, 7);
    assert.equal(enriched.usage.resolvedHits, 0);
    assert.equal(enriched.usage.dismissedHits, 0);

    // The already-bound and the no-release candidates are untouched.
    const bound = pbs.find((p) => p.id === 'PBP-bound')!;
    assert.equal(bound.lineage.capabilityReleaseId, 'PCR-preexisting');
    const noStory = pbs.find((p) => p.id === 'PBP-nostory')!;
    assert.equal(noStory.lineage.capabilityReleaseId, undefined);

    // No outcome row was written; the capability-releases ledger is byte-identical.
    assert.equal(readPlaybookOutcomeEvents(root).length, 0);
    assert.equal(readFileSync(ledgerPath, 'utf-8'), ledgerBefore);
  });

  // ── IDEMPOTENT: second run finds 0 eligible ───────────────────────────────────
  check('second dry-run finds 0 eligible (idempotent)', () => {
    const report = JSON.parse(backfill({ json: true }));
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.eligible.length, 0);
  });

  check('re-apply is a no-op: 0 eligible, empty-plan digest, enrichedCount 0', () => {
    const empty = JSON.parse(backfill({ json: true }));
    // Re-applying against the current (empty) plan digest touches nothing.
    const report = JSON.parse(backfill({ apply: true, digest: empty.planDigest, json: true }));
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.enrichedCount, 0);
    assert.equal(readPlaybookOutcomeEvents(root).length, 0);
    assert.equal(readFileSync(ledgerPath, 'utf-8'), ledgerBefore);
  });

  // ── --storyId filter narrows to one story ─────────────────────────────────────
  check('--storyId filter scopes to a single story (no eligible after full apply)', () => {
    const report = JSON.parse(backfill({ storyId: 'B-785e', json: true }));
    assert.equal(report.storyFilter, 'B-785e');
    assert.equal(report.eligibleCount, 0, 'B-785e already fully bound');
    // A filter for a story with no under-bound candidate is trivially empty.
    const other = JSON.parse(backfill({ storyId: 'B-9999', json: true }));
    assert.equal(other.eligibleCount, 0, 'B-9999 has no capability release');
  });

  // Sanity: outcomes ledger was never even created by the backfill path.
  check('no playbook-outcome ledger file was ever written by backfill', () => {
    assert.equal(existsSync(resolvePlaybookOutcomesPath(root)), false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CASE B — 'record-then-bind' (artifact release exists, NO capability release)
  //   This is the real PBP-882/B-785e shape: B-785e DONE'd before the capability
  //   release feature, so it has AR-… but no PCR. The migration must RECORD the
  //   missing PCR (from the artifact release's paths), commit it, then bind.
  // ════════════════════════════════════════════════════════════════════════════
  const rootB = mkdtemp('capability-release-recordbind-smoke-');
  cleanup.push(rootB);
  write(rootB, 'lattice.config.json', '{}');
  gitInit(rootB);

  // An ARTIFACT release for B-785e whose paths declare a reusable capability, but
  // NO capability release for B-785e (the classifier will derive one).
  const artifactRelease = createArtifactReleaseRecordForTest({
    root: rootB,
    storyId: 'B-785e',
    mainCommit: 'b'.repeat(40),
    changedPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
    runtimeSemverChanged: false,
    now: NOW,
  });
  writeArtifactReleaseLedgerForTest(rootB, [artifactRelease]);
  git(rootB, ['add', '-f', '.lattice/artifact-releases.jsonl', 'lattice.config.json']);
  git(rootB, ['commit', '-q', '-m', 'fixture: artifact release + config']);

  writePlaybooks(rootB, [candidatePlaybook('PBP-882', 'B-785e', false)]);

  const handlersB = createCapabilityReleaseBackfillHandlers({ store: new StoryStore(rootB), root: rootB, scanRoot: rootB });
  const backfillB = handlersB.capability_release_backfill;

  let recordBindDigest = '';
  let plannedPcrId = '';
  check('record-then-bind: dry-run reports one eligible with plan=record-then-bind + the PCR it would record', () => {
    const report = JSON.parse(backfillB({ json: true }));
    assert.equal(report.eligibleCount, 1);
    assert.equal(report.recordThenBindCount, 1);
    assert.equal(report.recordedReleaseCount, 0, 'dry-run records nothing');
    const row = report.eligible[0];
    assert.equal(row.playbookId, 'PBP-882');
    assert.equal(row.sourceStoryId, 'B-785e');
    assert.equal(row.plan, 'record-then-bind');
    assert.ok(/^PCR-[0-9a-f]{24}$/.test(row.capabilityReleaseId), 'a concrete PCR id is planned');
    assert.equal(row.fromArtifactReleaseId, artifactRelease.id, 'derived from the artifact release');
    assert.equal(row.artifactReleaseId, artifactRelease.id);
    // No capability release exists yet; the candidate is still unbound on disk.
    assert.equal(readCapabilityReleaseLedger(rootB).length, 0);
    assert.equal(readPlaybooks(rootB)[0].lineage.capabilityReleaseId, undefined);
    recordBindDigest = report.planDigest;
    plannedPcrId = row.capabilityReleaseId;
  });

  check('record-then-bind: apply records the capability release (committed) then binds the candidate', () => {
    const report = JSON.parse(backfillB({ apply: true, digest: recordBindDigest, json: true }));
    assert.equal(report.applied, true);
    assert.equal(report.eligibleCount, 1);
    assert.equal(report.recordedReleaseCount, 1, 'exactly one capability release recorded');
    assert.equal(report.enrichedCount, 1);

    // The capability release now exists in the ledger with the planned id.
    const releases = readCapabilityReleaseLedger(rootB);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].storyId, 'B-785e');
    assert.equal(releases[0].id, plannedPcrId);
    assert.equal(releases[0].artifactReleaseId, artifactRelease.id);
    assert.equal(releases[0].authority, 'non_authoritative');
    assert.equal(releases[0].gateEvidence, false);

    // The candidate is now bound to the freshly-recorded PCR.
    const pb = readPlaybooks(rootB)[0];
    assert.equal(pb.lineage.capabilityReleaseId, plannedPcrId);
    assert.equal(pb.status, 'candidate');
    assert.equal(pb.usage.surfacedCount, 7);

    // The ledger file is TRACKED and COMMITTED (git add -f + commit ran).
    const tracked = git(rootB, ['ls-files', '--', '.lattice/capability-releases.jsonl']);
    assert.equal(tracked, '.lattice/capability-releases.jsonl', 'capability ledger is tracked');
    const status = git(rootB, ['status', '--porcelain', '--', '.lattice/capability-releases.jsonl']);
    assert.equal(status, '', 'capability ledger has no uncommitted changes (was committed)');

    // No outcome row was written by the record-then-bind path.
    assert.equal(existsSync(resolvePlaybookOutcomesPath(rootB)), false);
  });

  check('record-then-bind: re-run is idempotent (PCR exists + candidate bound → 0 eligible)', () => {
    const report = JSON.parse(backfillB({ json: true }));
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.recordThenBindCount, 0);
    // A second apply against the empty plan records/binds nothing.
    const applied = JSON.parse(backfillB({ apply: true, digest: report.planDigest, json: true }));
    assert.equal(applied.recordedReleaseCount, 0);
    assert.equal(applied.enrichedCount, 0);
    assert.equal(readCapabilityReleaseLedger(rootB).length, 1, 'no duplicate PCR');
  });

  check('record-then-bind: an under-bound candidate whose story has NEITHER a capability NOR an artifact release is not eligible', () => {
    const rootC = mkdtemp('capability-release-noart-smoke-');
    cleanup.push(rootC);
    write(rootC, 'lattice.config.json', '{}');
    // No capability release and no artifact release for B-noart → nothing to record
    // from → conservatively not eligible (the migration never invents a binding).
    writePlaybooks(rootC, [candidatePlaybook('PBP-x', 'B-noart', false)]);
    const hC = createCapabilityReleaseBackfillHandlers({ store: new StoryStore(rootC), root: rootC, scanRoot: rootC });
    const report = JSON.parse(hC.capability_release_backfill({ json: true }));
    assert.equal(report.eligibleCount, 0, 'no artifact release for the story → not eligible');
    assert.equal(report.candidateCount, 1, 'the candidate was scanned but not eligible');
  });

  console.log(`capability-release-backfill smoke passed: ${passed} checks`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
