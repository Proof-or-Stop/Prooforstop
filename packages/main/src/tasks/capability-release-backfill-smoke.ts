#!/usr/bin/env node
/**
 * @task B-c389
 * @checklist CHK-001
 * @title capability_release_backfill CLI (dry-run/apply/--digest) smoke
 * @type feature
 * @priority high
 * @description
 *   Hermetic proof of the M8 capability_release_backfill command semantics via the
 *   real handler (createCapabilityReleaseBackfillHandlers):
 *     - dry-run detects EXACTLY ONE eligible under-bound candidate (its
 *       lineage.sourceStoryId has a capability release but lacks
 *       capabilityReleaseId) and emits a STABLE plan digest;
 *     - apply with the WRONG --digest is refused (drift);
 *     - apply with the RIGHT --digest enriches EXACTLY ONE candidate's lineage
 *       (capabilityReleaseId/capabilityId/capabilityVersion/artifactReleaseId);
 *     - a second apply finds 0 eligible (idempotent);
 *     - the candidate status stays 'candidate' and usage.surfacedCount is
 *       unchanged; no playbook-outcome row is written; the capability-releases
 *       ledger is byte-identical before/after.
 * @changes
 *   - [CHK-001] Cover capability_release_backfill dry-run/apply/--digest + invariants.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  capabilityReleaseLedgerPath,
  createCapabilityReleaseRecordForTest,
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
  const root = mkdtemp('capability-release-backfill-smoke-');
  cleanup.push(root);
  write(root, 'lattice.config.json', '{}');

  // ── Fixture: one capability release for B-785e; four candidate playbooks ──────
  //   PBP-882  → B-785e, UNBOUND    → the single eligible candidate.
  //   PBP-bound→ B-785e, ALREADY BOUND (capabilityReleaseId present) → ineligible.
  //   PBP-nostory → B-9999, UNBOUND but NO capability release exists → ineligible.
  //   PBP-active is NOT created (all four fixtures are candidates by design; the
  //   status guard is asserted below by re-reading persisted status).
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
    assert.equal(row.capabilityReleaseId, capabilityRelease.id);
    assert.equal(row.capabilityId, capabilityRelease.capabilityId);
    assert.equal(row.capabilityVersion, capabilityRelease.capabilityVersion);
    assert.equal(row.artifactReleaseId, capabilityRelease.artifactReleaseId);
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

  console.log(`capability-release-backfill smoke passed: ${passed} checks`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
