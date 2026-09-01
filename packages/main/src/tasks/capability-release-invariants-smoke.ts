#!/usr/bin/env node

/**
 * B-8128 M6/M7 + BACKFILL invariant smoke (hermetic).
 *
 * Asserts three ALREADY-ENFORCED capability-release invariants — this file adds
 * NO new mechanism, it only pins the existing guards so a regression is caught:
 *
 *  GROUP M6 — a candidate capability playbook is EXCLUDED from active runtime
 *    surfacing. `matchActivePlaybook` (playbook-runtime-memory.ts:343) returns
 *    null for any playbook whose status !== 'active', so a status:'candidate'
 *    playbook (even one carrying a capabilityReleaseId in its lineage) never
 *    appears in matchRuntimePlaybooks / MemoryFreshnessPack.results.playbookIds.
 *    Flipping the SAME playbook to status:'active' is what makes it surface —
 *    proving the status==='active' guard is the actual gate.
 *
 *  GROUP M7 — a DONE success never counts as helped. A helped verdict whose
 *    verdictSource is 'done-settlement' is NOT a positive helped outcome
 *    (isPositiveHelpedPlaybookOutcome === false); a structured, non-done
 *    helped outcome IS. aggregatePlaybookPromotion's decisiveSamples excludes
 *    done-settlement / neutral / unknown events.
 *
 *  GROUP BACKFILL PROOF — the fixture-level backfill semantics (the standalone
 *    capability_release_backfill CLI command is DEFERRED to a follow-up). Using
 *    enrichSeedWithCapabilityLineage as the backfill primitive: DRY-RUN detects
 *    exactly one eligible seed, APPLY enriches exactly one, and a second APPLY is
 *    a no-op. The candidate status STAYS 'candidate', usage.surfacedCount stays
 *    unchanged, and no 'helped' outcome is produced anywhere.
 *
 * Fully hermetic: every fixture lives in a mkdtemp dir; no live repo-root
 * .proof-or-stop state is read.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createCapabilityReleaseRecordForTest,
  writeCapabilityReleaseLedgerForTest,
} from '../core/capability-release.js';
import type { Playbook, PlaybookOutcomeEvent } from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  isPositiveHelpedPlaybookOutcome,
  validatePlaybookOutcomeEvent,
  writePlaybooks,
} from '../core/learning-store.js';
import {
  buildMemoryFreshnessPack,
  matchRuntimePlaybooks,
} from '../core/playbook-runtime-memory.js';
import {
  candidatePlaybookFromProposal,
  enrichSeedWithCapabilityLineage,
  lineageFromSeed,
  type PlaybookSeedCandidate,
} from '../core/playbook-seed.js';
import { StoryStore } from '../core/store.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

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

const cleanup: string[] = [];

/** A capability-flavored playbook (its lineage carries a capabilityReleaseId). */
function makeCapabilityPlaybook(status: Playbook['status']): Playbook {
  return {
    id: 'PBP-cap-m6',
    title: 'Playbook: capability release provenance for B-785e',
    trigger: {
      keywords: ['capability', 'release', 'provenance'],
      fileKinds: ['jsonl'],
      storyPhases: ['DONE', 'REVIEW'],
    },
    check: 'Before similar work, confirm the capability release provenance binding.',
    pitfalls: ['Do not treat capability release seed material as authoritative gate evidence.'],
    verification: ['Confirm the source condition behind B-785e:DONE-EXPERIENCE cannot recur'],
    lineage: {
      sourceStoryId: 'B-785e',
      sourceFindingId: 'B-785e:DONE-EXPERIENCE',
      sourceSignature: 'done_experience',
      capabilityReleaseId: 'PCR-capability-release-m6',
      capabilityId: 'experiments-multi-model-ablation',
      capabilityVersion: '9896bd874641',
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

/** A validatable PlaybookOutcomeEvent with a caller-chosen verdictSource. */
function makeHelpedOutcome(verdictSource: string, eventId: string): PlaybookOutcomeEvent {
  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId,
    idempotencyKey: `idem-${eventId}`,
    observedAt: '2026-07-05T00:00:00.000Z',
    storyId: 'B-785e',
    playbookId: 'PBP-cap-m6',
    playbookStatusAtObservation: 'candidate',
    exposureMode: 'candidate-inspection',
    consumer: 'dev_memory_start',
    context: { fileKinds: ['jsonl'], triggerClasses: ['delivery'] },
    outcome: {
      verdict: 'helped',
      verdictSource,
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
    },
    bindings: {},
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

try {
  // ── GROUP M6 ────────────────────────────────────────────────────────────────
  // A query that matches the playbook's trigger keywords / text, so the ONLY
  // reason it could be excluded is the status guard (not a scoring miss).
  const m6Query = 'capability release provenance';

  check('M6: a capability-flavored candidate playbook is excluded from matchRuntimePlaybooks', () => {
    const candidate = makeCapabilityPlaybook('candidate');
    // Sanity: the lineage really does carry the capability release id (so we are
    // testing the status guard, not a mis-built fixture that lacks lineage).
    assert.equal(candidate.lineage.capabilityReleaseId, 'PCR-capability-release-m6');
    const matches = matchRuntimePlaybooks(
      { projectRoot: '/nonexistent-hermetic', query: m6Query },
      [candidate],
    );
    assert.equal(matches.length, 0, 'a status:candidate playbook must never surface as an active match');
    assert.equal(
      matches.some((m) => m.playbook.id === candidate.id),
      false,
    );
  });

  check('M6: a candidate capability playbook is absent from MemoryFreshnessPack.results.playbookIds', () => {
    const packRoot = mkdtemp('capability-invariants-m6-pack-');
    cleanup.push(packRoot);
    write(packRoot, 'proof-or-stop.config.json', '{}');
    const candidate = makeCapabilityPlaybook('candidate');
    writePlaybooks(packRoot, [candidate]);
    const pack = buildMemoryFreshnessPack({
      projectRoot: packRoot,
      query: m6Query,
      consumer: 'session_brief',
      generatedAt: '2026-07-05T00:00:00.000Z',
    });
    assert.equal(pack.results.playbookIds.includes(candidate.id), false);
    assert.equal(pack.items.playbooks.some((p) => p.id === candidate.id), false);
  });

  check('M6: flipping the SAME playbook to active proves status===active is the gate', () => {
    const active = makeCapabilityPlaybook('active');
    // Same id, same trigger, same query — the ONLY difference vs the candidate is
    // status:'active' — so surfacing here proves the status guard is the gate.
    const matches = matchRuntimePlaybooks(
      { projectRoot: '/nonexistent-hermetic', query: m6Query },
      [active],
    );
    assert.equal(matches.length, 1, 'an active capability playbook with a matching query must surface');
    assert.equal(matches[0].playbook.id, active.id);

    // And it now appears in the MemoryFreshnessPack.results.playbookIds too.
    const packRoot = mkdtemp('capability-invariants-m6-active-');
    cleanup.push(packRoot);
    write(packRoot, 'proof-or-stop.config.json', '{}');
    writePlaybooks(packRoot, [active]);
    const pack = buildMemoryFreshnessPack({
      projectRoot: packRoot,
      query: m6Query,
      consumer: 'session_brief',
      generatedAt: '2026-07-05T00:00:00.000Z',
    });
    assert.equal(pack.results.playbookIds.includes(active.id), true);
  });

  check('M5: playbook_promotion_status surfaces a candidate\'s capability-release lineage (text + json)', () => {
    const statusRoot = mkdtemp('capability-invariants-m5-status-');
    cleanup.push(statusRoot);
    write(statusRoot, 'proof-or-stop.config.json', '{}');
    const candidate = makeCapabilityPlaybook('candidate');
    writePlaybooks(statusRoot, [candidate]);

    const handlers = createPlaybookHandlers({
      root: statusRoot,
      store: new StoryStore(statusRoot),
      scanRoot: join(statusRoot, 'packages/main'),
    });

    // TEXT render must carry a per-candidate capabilityRelease segment sourced
    // ONLY from the lineage already on the loaded playbook (no new import).
    const text = handlers.playbook_promotion_status({}) as string;
    assert.ok(
      text.includes(`capabilityRelease=${candidate.lineage.capabilityReleaseId}`),
      'text status must surface the candidate capabilityReleaseId',
    );
    assert.ok(
      text.includes(`(${candidate.lineage.capabilityId} v${candidate.lineage.capabilityVersion})`),
      'text status must surface capabilityId + capabilityVersion',
    );

    // JSON render must expose the same capabilityRelease fields on pendingLearning.
    const json = JSON.parse(handlers.playbook_promotion_status({ json: true }) as string) as {
      pendingLearning: Array<{
        playbookId: string;
        capabilityRelease?: { capabilityReleaseId: string; capabilityId?: string; capabilityVersion?: string };
      }>;
    };
    const row = json.pendingLearning.find((p) => p.playbookId === candidate.id);
    assert.ok(row, 'candidate must appear in pendingLearning');
    assert.equal(row?.capabilityRelease?.capabilityReleaseId, candidate.lineage.capabilityReleaseId);
    assert.equal(row?.capabilityRelease?.capabilityId, candidate.lineage.capabilityId);
    assert.equal(row?.capabilityRelease?.capabilityVersion, candidate.lineage.capabilityVersion);
  });

  // ── GROUP M7 ────────────────────────────────────────────────────────────────
  check('M7: a done-settlement helped outcome is NOT a positive helped outcome', () => {
    const doneSettlement = makeHelpedOutcome('done-settlement', 'ev-done');
    const validated = validatePlaybookOutcomeEvent(doneSettlement);
    assert.equal(validated.ok, true, 'done-settlement outcome must still validate as a well-formed event');
    assert.equal(
      isPositiveHelpedPlaybookOutcome(doneSettlement),
      false,
      'DONE success (verdictSource=done-settlement) must never count as a positive helped outcome',
    );
  });

  check('M7: a structured non-done helped outcome IS a positive helped outcome', () => {
    const structured = makeHelpedOutcome('reviewer-confirmation', 'ev-structured');
    const validated = validatePlaybookOutcomeEvent(structured);
    assert.equal(validated.ok, true);
    assert.equal(
      isPositiveHelpedPlaybookOutcome(structured),
      true,
      'a structured (non done-settlement) helped outcome must count as a positive helped outcome',
    );
  });

  check('M7: aggregatePlaybookPromotion.decisiveSamples excludes done-settlement/neutral/unknown', () => {
    const playbook = makeCapabilityPlaybook('candidate');
    const structuredHelped = makeHelpedOutcome('reviewer-confirmation', 'agg-helped');
    const doneSettlement = makeHelpedOutcome('done-settlement', 'agg-done');
    const neutral: PlaybookOutcomeEvent = {
      ...makeHelpedOutcome('reviewer-confirmation', 'agg-neutral'),
      exposureMode: 'active-advisory',
      outcome: {
        verdict: 'neutral',
        verdictSource: 'reviewer-confirmation',
        causedNoise: false,
        causedWrongClaim: false,
        preventedRepeatFinding: false,
      },
    };
    const unknown: PlaybookOutcomeEvent = {
      ...makeHelpedOutcome('reviewer-confirmation', 'agg-unknown'),
      exposureMode: 'none',
      outcome: {
        verdict: 'unknown',
        verdictSource: 'reviewer-confirmation',
        causedNoise: false,
        causedWrongClaim: false,
        preventedRepeatFinding: false,
      },
    };
    // Confirm every event we feed in is well-formed (so the aggregate reflects
    // its exclusion logic, not a validation drop).
    for (const ev of [structuredHelped, doneSettlement, neutral, unknown]) {
      assert.equal(validatePlaybookOutcomeEvent(ev).ok, true);
    }
    const aggregate = aggregatePlaybookPromotion(playbook, [
      structuredHelped,
      doneSettlement,
      neutral,
      unknown,
    ]);
    // Only the single structured helped event is decisive. decisiveSamples is
    // helpedCount + dismissedCount + harmfulCount — so done-settlement, neutral,
    // and unknown all sit OUTSIDE it.
    assert.equal(aggregate.helpedCount, 1);
    assert.equal(aggregate.dismissedCount, 0);
    assert.equal(aggregate.harmfulCount, 0);
    assert.equal(aggregate.decisiveSamples, 1);
    assert.equal(aggregate.neutralCount, 1);
    // The done-settlement helped event is guarded out of every decisive branch
    // (all `!doneSettlement`) and its verdict !== 'neutral', so it falls through
    // to the non-decisive unknown bucket alongside the explicit unknown event.
    assert.equal(aggregate.unknownCount, 2);
    // done-settlement / neutral / unknown contributed to NEITHER helped nor
    // decisive samples: decisiveSamples equals the decisive-verdict sum exactly.
    assert.equal(
      aggregate.decisiveSamples,
      aggregate.helpedCount + aggregate.dismissedCount + aggregate.harmfulCount,
    );
  });

  // ── GROUP BACKFILL PROOF (hermetic) ──────────────────────────────────────────
  // enrichSeedWithCapabilityLineage is the backfill primitive. We stage a
  // B-785e capability release + a B-785e seed lacking capability lineage, then:
  //   DRY-RUN   = detect exactly one eligible seed
  //   APPLY     = enrich exactly one seed
  //   IDEMPOTENT = a second apply is a no-op
  // …while proving status stays 'candidate', usage.surfacedCount is unchanged,
  // and no 'helped' outcome is produced anywhere.
  check('BACKFILL: dry-run detects exactly one eligible seed lacking capability lineage', () => {
    const root = mkdtemp('capability-invariants-backfill-');
    cleanup.push(root);

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
      now: '2026-07-05T00:00:00.000Z',
    });
    writeCapabilityReleaseLedgerForTest(root, [capabilityRelease]);

    // Two seeds: one for B-785e (eligible — a capability release exists and its
    // lineage lacks capabilityReleaseId), one for B-9999 (no release → ineligible).
    const eligibleSeed: PlaybookSeedCandidate = {
      seedId: 'PBS-b785edoneexp001',
      sourceArtifactKind: 'done_experience',
      sourceArtifactId: 'B-785e',
      sourceRef: 'done-experience/B-785e',
      canonicalSourceKey: 'done_experience:B-785e',
      canonicalSourceKeyVersion: 'v1',
      canonicalizationPolicyHash: 'sha256:policy-hash',
      sourceStoryId: 'B-785e',
      sourceFindingId: 'B-785e:DONE-EXPERIENCE',
      sourceSignature: 'done_experience',
      sourceSummary: 'DONE experience for B-785e',
      priority: 3,
      priorityReason: 'DONE experience source priority 3',
    };
    const ineligibleSeed: PlaybookSeedCandidate = {
      ...eligibleSeed,
      seedId: 'PBS-b9999doneexp001',
      sourceArtifactId: 'B-9999',
      sourceRef: 'done-experience/B-9999',
      canonicalSourceKey: 'done_experience:B-9999',
      sourceStoryId: 'B-9999',
      sourceFindingId: 'B-9999:DONE-EXPERIENCE',
      sourceSummary: 'DONE experience for B-9999',
    };

    const seeds = [eligibleSeed, ineligibleSeed];

    // DRY-RUN: an eligible seed is one whose lineage lacks capabilityReleaseId AND
    // whose enrichment WOULD add it (a capability release exists for its story).
    const dryRunEligible = seeds.filter((seed) => {
      const before = lineageFromSeed(seed);
      if (before.capabilityReleaseId) return false; // already bound → not eligible
      const enriched = enrichSeedWithCapabilityLineage(root, seed);
      return lineageFromSeed(enriched).capabilityReleaseId !== undefined;
    });
    assert.equal(dryRunEligible.length, 1, 'exactly one seed (B-785e) must be backfill-eligible');
    assert.equal(dryRunEligible[0].seedId, 'PBS-b785edoneexp001');

    // DRY-RUN must not mutate the ineligible seed (no release for B-9999).
    const ineligibleEnriched = enrichSeedWithCapabilityLineage(root, ineligibleSeed);
    assert.equal(lineageFromSeed(ineligibleEnriched).capabilityReleaseId, undefined);

    // APPLY: enrich exactly one seed; the candidate now binds its capability release.
    const appliedSeed = enrichSeedWithCapabilityLineage(root, eligibleSeed);
    const appliedLineage = lineageFromSeed(appliedSeed);
    assert.equal(appliedLineage.capabilityReleaseId, capabilityRelease.id);
    assert.equal(appliedLineage.capabilityId, capabilityRelease.capabilityId);
    assert.equal(appliedLineage.capabilityVersion, capabilityRelease.capabilityVersion);
    assert.equal(appliedLineage.artifactReleaseId, capabilityRelease.artifactReleaseId);
    assert.equal(appliedLineage.artifactSetDigest, capabilityRelease.artifactSetDigest);

    // IDEMPOTENT: a second apply is a pure no-op (lineage already has the field;
    // no duplicate binding, identical result).
    const reappliedSeed = enrichSeedWithCapabilityLineage(root, appliedSeed);
    assert.deepEqual(lineageFromSeed(reappliedSeed), appliedLineage);
    assert.equal(reappliedSeed.capabilityReleaseId, capabilityRelease.id);

    // The candidate playbook distilled from the enriched seed stays 'candidate'
    // and its usage.surfacedCount is unchanged (backfill never surfaces / promotes).
    const candidate = candidatePlaybookFromProposal({
      id: 'PBP-882',
      title: 'Playbook: DONE experience B-785e',
      trigger: { keywords: ['b-785e'], fileKinds: [], storyPhases: ['DONE', 'REVIEW'] },
      check: 'Before similar work, apply this DONE experience.',
      pitfalls: ['Do not treat DONE experience seed material as authoritative gate evidence.'],
      verification: ['Confirm the source condition behind B-785e:DONE-EXPERIENCE cannot recur'],
      lineage: appliedLineage,
      seed: {
        sourceArtifactKind: eligibleSeed.sourceArtifactKind,
        sourceArtifactId: eligibleSeed.sourceArtifactId,
        sourceRef: eligibleSeed.sourceRef,
        canonicalSourceKey: eligibleSeed.canonicalSourceKey,
        canonicalSourceKeyVersion: eligibleSeed.canonicalSourceKeyVersion,
        canonicalizationPolicyHash: eligibleSeed.canonicalizationPolicyHash,
      },
      status: 'proposed',
      proposalDigest: '',
    });
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.usage.surfacedCount, 0);
    assert.equal(candidate.usage.resolvedHits, 0);
    assert.equal(candidate.usage.dismissedHits, 0);
    // And its lineage carries the capability release binding produced by backfill.
    assert.equal(candidate.lineage.capabilityReleaseId, capabilityRelease.id);

    // No 'helped' outcome is produced anywhere: the enrichment is a pure lineage
    // transform — it returns a seed, never a PlaybookOutcomeEvent. There is no
    // outcomes ledger written by the backfill path.
    assert.equal((appliedSeed as { outcome?: unknown }).outcome, undefined);
  });

  console.log(`capability-release-invariants smoke passed: ${passed} checks`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
