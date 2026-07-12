import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  candidateReadBindingErrors,
  collectHostKeywordProposals,
  digestCandidateRoutingValue,
  evaluateCandidateRoutingPromotion,
  normalizeHostProposal,
  routeCandidateSpecs,
  sanitizeHostPayload,
  verifyCandidateSpecSet,
  type HostKeywordProposal,
} from '../core/candidate-spec-routing.js';
import { StoryStore } from '../core/store.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { renderCandidateSpecRouteText } from '../handlers/candidate-spec-routing.js';
import { renderDeliveryContextPackReport } from '../handlers/delivery-context-pack.js';

function fixtureRoot(): string {
  const root = join(tmpdir(), `candidate-routing-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/requirements/decisions/auth-session.md'), '# Auth Session\n\n## Token Rotation\nRotating credentials safely.\n');
  writeFileSync(join(root, 'docs/requirements/decisions/legacy-login.md'), '# Legacy Login\n\nHistorical authentication synonym.\n');
  writeFileSync(join(root, 'docs/requirements/decisions/noise.md'), '# Painting Guide\n\nUnrelated colors.\n');
  return root;
}

function proposal(storyId: string, digest: string): HostKeywordProposal {
  return {
    schemaVersion: 'proofbound.keyword-proposal.v1',
    storyId,
    host: 'codex-cli',
    proposalId: 'p1',
    promptDigest: 'prompt-1',
    deterministicSeedDigest: digest,
    terms: [{
      term: 'legacy login',
      rationale: 'historic synonym',
      kind: 'legacy-term',
      derivedFrom: ['auth session'],
      confidence: 'high',
    }],
    rejectedSeeds: [],
    ambiguitySignals: [],
  };
}

export async function runCandidateSpecRoutingSmoke(): Promise<void> {
  const root = fixtureRoot();
  try {
    const first = buildCorpusIndex(root);
    const second = buildCorpusIndex(root);
    assert.deepEqual(second, first, 'corpus index must be byte-deterministic for identical inputs');
    assert.equal(first.schemaVersion, 'proofbound.corpus-index.v1');
    assert.deepEqual(first.entries.map(entry => entry.path), [...first.entries.map(entry => entry.path)].sort());

    const reorderedRoot = join(tmpdir(), `candidate-routing-order-${process.pid}-${Date.now()}`);
    mkdirSync(join(reorderedRoot, 'docs/requirements/decisions'), { recursive: true });
    for (const entry of [...first.entries].reverse()) writeFileSync(join(reorderedRoot, entry.path), readFileSync(join(root, entry.path)));
    assert.deepEqual(buildCorpusIndex(reorderedRoot).entries, first.entries, 'filesystem creation order must not affect corpus enumeration');
    rmSync(reorderedRoot, { recursive: true, force: true });

    const outside = join(tmpdir(), `candidate-routing-outside-${process.pid}.md`);
    writeFileSync(outside, '# Outside\n');
    symlinkSync(outside, join(root, 'docs/requirements/decisions/escape.md'));
    assert.throws(() => buildCorpusIndex(root), /symlink escapes project root/);
    rmSync(join(root, 'docs/requirements/decisions/escape.md'), { force: true });
    rmSync(outside, { force: true });

    const story = {
      storyId: 'B-test',
      title: 'Rotate authSession tokens',
      description: 'Implement `auth_session` and --rotate-token behavior',
      relatedDocs: ['docs/requirements/decisions/auth-session.md'],
      checklist: [{ id: 'CHK-001', title: 'Preserve AuthSession behavior' }],
      understanding: { touchpoints: ['packages/main/src/auth/session.ts'] },
    };
    const seedsA = buildKeywordSeeds(story);
    const seedsB = buildKeywordSeeds({ ...story });
    assert.deepEqual(seedsB, seedsA, 'seed artifacts must be deterministic');
    assert.ok(seedsA.seeds.some(seed => seed.term === 'auth_session' && seed.normalized === 'auth session'));
    assert.ok(seedsA.seeds.some(seed => seed.term === 'authSession' && seed.normalized === 'auth session'));

    const rawProposal = proposal(story.storyId, seedsA.seedDigest);
    const validProposal = normalizeHostProposal(rawProposal, {
      storyId: story.storyId,
      host: 'codex-cli',
      seedDigest: seedsA.seedDigest,
    });
    const artifact = routeCandidateSpecs({ projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, proposals: [validProposal] });
    assert.equal(verifyCandidateSpecSet(artifact), true);
    assert.equal(artifact.candidateSpecSet[0], 'docs/requirements/decisions/auth-session.md');
    assert.ok(artifact.candidateSpecSet.includes('docs/requirements/decisions/legacy-login.md'));
    assert.ok(artifact.candidateSpecSet.length <= 8);
    assert.ok(artifact.queryGroups.length <= 10);
    assert.equal(JSON.stringify(artifact).includes('Rotating credentials safely'), false, 'artifact must not contain document bodies');

    const store = new StoryStore(root);
    store.writeStory(story.storyId, {
      storyId: story.storyId,
      name: 'candidate-routing-smoke',
      title: story.title,
      description: story.description,
      type: 'feature',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: '2026-07-12T00:00:00.000Z',
      startedAt: '2026-07-12T00:00:00.000Z',
      endedAt: null,
      events: [],
    });
    store.writeChecklist(story.storyId, { items: [{
      id: 'CHK-001', title: 'Preserve AuthSession behavior', context: 'Review routed auth specifications.',
      status: 'pending', startTime: null, endTime: null,
      files: { modify: ['packages/main/src/auth/session.ts'], create: [], test: [] },
    }] });
    store.writeCandidateSpecSet(story.storyId, artifact);
    const dispatch = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    const planPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'lattice-review-scope-plan' }).prompt;
    assert.match(planPrompt, new RegExp(artifact.artifactDigest));
    assert.match(planPrompt, new RegExp(artifact.corpusDigest));
    assert.match(planPrompt, /candidateSpecSetDigest/);
    assert.equal(planPrompt.includes('Rotating credentials safely'), false, 'PLAN dispatch must not embed corpus bodies');
    const reviewPrompt = dispatch.dispatch({ storyId: story.storyId, itemId: 'CHK-001', agentType: 'lattice-review-quality' }).prompt;
    assert.match(reviewPrompt, new RegExp(artifact.artifactDigest));
    assert.match(reviewPrompt, /review_run_start/);
    assert.match(reviewPrompt, /candidateSpecSetDigest/);
    const deliveryText = renderDeliveryContextPackReport({
      storyId: story.storyId, generatedFor: 'delivery-review', phase: 'REVIEW',
      mode: { runCommands: false, writeEvidence: false },
      diff: { changedFiles: [], summary: '' }, docsPromises: [],
      realMachineTests: { transcriptDiff: false, testFiles: [], evidenceCommands: [] },
      candidateRouting: { artifactDigest: artifact.artifactDigest, corpusDigest: artifact.corpusDigest, candidateSpecSet: artifact.candidateSpecSet, ambiguitySignals: artifact.ambiguitySignals },
      validation: null, reviewRound: null,
      deliveryCheck: { status: 'missing', ref: null }, waiver: { status: 'none', ref: null },
      deliveryReadinessRow: null, isSigner: false,
      write: { requested: false, persisted: false, artifactPath: null },
      claims: { authorityDone: false, fullAuthorityDone: false, productionDone: false },
    });
    assert.match(deliveryText, new RegExp(artifact.artifactDigest));

    const sanitized = sanitizeHostPayload({ description: 'api_key=super-secret', sourceRef: 'token: abc123' });
    assert.equal(sanitized.safe, true);
    assert.equal(JSON.stringify(sanitized.value).includes('super-secret'), false);
    assert.equal(JSON.stringify(sanitized.value).includes('abc123'), false);
    assert.ok(sanitized.redactionCount >= 2);

    const uncertain = sanitizeHostPayload({ description: '-----BEGIN PRIVATE KEY-----' });
    assert.equal(uncertain.safe, false);
    assert.equal(uncertain.reason, 'uncertain_secret_classification');

    const tampered = { ...artifact, candidateSpecSet: ['docs/requirements/decisions/noise.md'] };
    assert.equal(verifyCandidateSpecSet(tampered), false, 'tampered candidate artifact must fail verification');
    const manifest = {
      filesReadFully: artifact.candidateSpecSet,
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: artifact.artifactDigest,
      corpusDigest: artifact.corpusDigest,
    };
    assert.deepEqual(candidateReadBindingErrors({ manifest, artifact, mode: 'enforce' }), []);
    assert.match(candidateReadBindingErrors({ manifest: { ...manifest, candidateSpecSetDigest: '0'.repeat(64) }, artifact, mode: 'enforce' }).join(' '), /does not match/);
    assert.match(candidateReadBindingErrors({ manifest, artifact: null, mode: 'enforce' }).join(' '), /missing/);
    assert.match(candidateReadBindingErrors({ manifest, artifact, mode: 'enforce', currentMaterialHash: 'different' }).join(' '), /materialHash is stale/);
    const fullyBound = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA,
      storyInputDigest: digestCandidateRoutingValue(story), storyFilesHash: 'story-files-a',
    });
    const fullyBoundManifest = { ...manifest, candidateSpecSetDigest: fullyBound.artifactDigest };
    assert.match(candidateReadBindingErrors({ manifest: fullyBoundManifest, artifact: fullyBound, mode: 'enforce', currentStoryFilesHash: 'story-files-b' }).join(' '), /storyFilesHash is stale/);
    assert.match(candidateReadBindingErrors({ manifest: fullyBoundManifest, artifact: fullyBound, mode: 'enforce', currentStoryInputDigest: digestCandidateRoutingValue({ ...story, checklist: [{ title: 'changed promise' }] }) }).join(' '), /storyInputDigest is stale/);
    assert.deepEqual(candidateReadBindingErrors({ manifest: fullyBoundManifest, artifact: fullyBound, mode: 'enforce', currentStoryInputDigest: digestCandidateRoutingValue(story) }), []);
    assert.equal(verifyCandidateSpecSet({ ...artifact, promptDigests: ['forged'] }), false, 'prompt digest tampering must invalidate artifact');
    assert.equal(verifyCandidateSpecSet({ ...artifact, candidates: artifact.candidates.map((candidate, index) => index === 0 ? { ...candidate, contentHash: 'forged' } : candidate) }), false, 'candidate content hash tampering must invalidate artifact');
    assert.deepEqual(candidateReadBindingErrors({
      manifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
      artifact: null,
      mode: 'shadow',
    }), [], 'shadow mode must not require candidate binding');
    assert.match(candidateReadBindingErrors({
      manifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
      artifact: null,
      mode: 'enforce',
    }).join(' '), /required in enforce/);

    const zero = routeCandidateSpecs({
      projectRoot: root,
      storyId: 'B-zero',
      corpus: first,
      seeds: buildKeywordSeeds({ storyId: 'B-zero', title: 'zzzz-no-match-value' }),
    });
    assert.ok(zero.ambiguitySignals.includes('zero_candidates'));
    assert.equal(zero.fullScan, false);
    assert.equal(zero.scanEscalationReason, null);
    const forcedZero = routeCandidateSpecs({
      projectRoot: root, storyId: 'B-zero', corpus: first,
      seeds: buildKeywordSeeds({ storyId: 'B-zero', title: 'zzzz-no-match-value' }),
      forceFullScanReason: 'zero_candidate_manual_escalation',
    });
    assert.equal(forcedZero.fullScan, true);
    assert.deepEqual([...forcedZero.candidateSpecSet].sort(), first.entries.map(entry => entry.path).sort(), 'full scan must enumerate the complete corpus even with zero matches');
    const forcedManifest = {
      filesReadFully: forcedZero.candidateSpecSet,
      filesTriagedByName: [],
      scanEscalationReason: forcedZero.scanEscalationReason,
      candidateSpecSetDigest: forcedZero.artifactDigest,
      corpusDigest: forcedZero.corpusDigest,
    };
    assert.deepEqual(candidateReadBindingErrors({ manifest: forcedManifest, artifact: forcedZero, mode: 'enforce' }), []);
    assert.match(candidateReadBindingErrors({ manifest: { ...forcedManifest, filesReadFully: [] }, artifact: forcedZero, mode: 'enforce' }).join(' '), /missing candidate full reads/);
    assert.match(candidateReadBindingErrors({ manifest: { ...forcedManifest, scanEscalationReason: 'different' }, artifact: forcedZero, mode: 'enforce' }).join(' '), /scanEscalationReason does not match/);

    const truncatedRoute = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'decision' }), rawHitsPerGroup: 1,
    });
    assert.equal(truncatedRoute.requiresEscalation, true, 'ranking-affecting truncation must require an explicit escalation decision');
    assert.ok(truncatedRoute.escalationReasons.includes('ranking_affecting_query_truncation'));
    assert.equal(truncatedRoute.fullScan, false, 'common-term truncation must never authorize full-corpus reads');
    assert.equal(truncatedRoute.scanEscalationReason, null);
    assert.ok(truncatedRoute.candidateSpecSet.length <= truncatedRoute.budgets.candidates);
    const truncatedManifest = {
      filesReadFully: truncatedRoute.candidateSpecSet,
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: truncatedRoute.artifactDigest,
      corpusDigest: truncatedRoute.corpusDigest,
    };
    assert.match(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: truncatedRoute, mode: 'enforce' }).join(' '), /escalation is unresolved/);
    assert.match(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: truncatedRoute, mode: 'shadow' }).join(' '), /escalation is unresolved/, 'supplying a digest makes shadow evidence subject to the same fail-closed binding');
    const pendingCliText = renderCandidateSpecRouteText(truncatedRoute, first.entries.length, []);
    assert.match(pendingCliText, /BLOCKED_PENDING_ESCALATION/);
    assert.match(pendingCliText, /fullScanReason/);

    const resolvedTruncation = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'decision' }), rawHitsPerGroup: 1,
      forceFullScanReason: 'common decision term truncated bounded ranking; reviewer approved tool-driven corpus scan',
    });
    const resolvedManifest = {
      filesReadFully: resolvedTruncation.candidateSpecSet,
      filesTriagedByName: [],
      scanEscalationReason: resolvedTruncation.scanEscalationReason,
      candidateSpecSetDigest: resolvedTruncation.artifactDigest,
      corpusDigest: resolvedTruncation.corpusDigest,
    };
    assert.equal(resolvedTruncation.requiresEscalation, true);
    assert.equal(resolvedTruncation.fullScan, true);
    assert.deepEqual(candidateReadBindingErrors({ manifest: resolvedManifest, artifact: resolvedTruncation, mode: 'enforce' }), [], 'explicit justified full scan resolves pending escalation for gate consumption');

    writeFileSync(join(root, 'docs/requirements/decisions/tie-a.md'), '# Shared Signal\n');
    writeFileSync(join(root, 'docs/requirements/decisions/tie-b.md'), '# Shared Signal\n');
    const tiedCorpus = buildCorpusIndex(root);
    const tiedRoute = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: tiedCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'shared signal' }), candidateBudget: 1,
    });
    assert.equal(tiedRoute.requiresEscalation, true, 'a tied cutoff must require an explicit escalation decision');
    assert.ok(tiedRoute.escalationReasons.includes('candidate_cutoff_tie'));
    assert.equal(tiedRoute.fullScan, false);
    assert.ok(tiedRoute.candidateSpecSet.length <= 1);
    rmSync(join(root, 'docs/requirements/decisions/tie-a.md'));
    rmSync(join(root, 'docs/requirements/decisions/tie-b.md'));

    const weakCoverage = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, relatedDocs: ['docs/requirements/decisions/noise.md'] }),
    });
    assert.ok(weakCoverage.escalationReasons.includes('weak_source_class_coverage'));
    assert.equal(weakCoverage.fullScan, false);

    const hostDisagreement = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, hostDisagreement: true,
    });
    assert.ok(hostDisagreement.escalationReasons.includes('primary_host_disagreement'));
    assert.equal(hostDisagreement.fullScan, false);

    const highRisk = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA,
      riskSignals: ['State Machine/Gate:process-fact global rename'],
    });
    assert.ok(highRisk.escalationReasons.includes('high_risk_lifecycle_gate_process_fact_or_global_rename'));
    assert.equal(highRisk.fullScan, false);
    store.writeCandidateSpecSet(story.storyId, highRisk);
    const pendingPlanPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'lattice-review-scope-plan' }).prompt;
    assert.match(pendingPlanPrompt, /STOP — candidate routing escalation is unresolved/);
    assert.match(pendingPlanPrompt, /high_risk_lifecycle_gate_process_fact_or_global_rename/);
    assert.match(pendingPlanPrompt, /fullScanReason/);
    const pendingReviewPrompt = dispatch.dispatch({ storyId: story.storyId, itemId: 'CHK-001', agentType: 'lattice-review-quality' }).prompt;
    assert.match(pendingReviewPrompt, /Do not submit review_pass_set or finding evidence/);
    assert.match(pendingReviewPrompt, /high_risk_lifecycle_gate_process_fact_or_global_rename/);

    const unmatchedLegacyProposal: HostKeywordProposal = {
      ...validProposal,
      terms: [{ ...validProposal.terms[0], term: 'obsolete-unmatched-protocol-name', kind: 'legacy-term', confidence: 'high' }],
    };
    const unmatchedLegacy = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, proposals: [unmatchedLegacyProposal],
    });
    assert.ok(unmatchedLegacy.escalationReasons.some(reason => reason.startsWith('unmatched_high_confidence_legacy_term:')));
    assert.equal(unmatchedLegacy.fullScan, false);

    writeFileSync(join(root, 'docs/requirements/decisions/huge-irrelevant.md'), `# Irrelevant Giant\n${'x'.repeat(5 * 1024 * 1024)}`);
    const largeCorpus = buildCorpusIndex(root);
    const withLargeIrrelevant = routeCandidateSpecs({ projectRoot: root, storyId: story.storyId, corpus: largeCorpus, seeds: seedsA, proposals: [validProposal] });
    assert.deepEqual(withLargeIrrelevant.candidateSpecSet, artifact.candidateSpecSet, 'an irrelevant 5 MB document must not flood or reorder bounded candidates');
    rmSync(join(root, 'docs/requirements/decisions/huge-irrelevant.md'));

    assert.throws(() => buildCorpusIndex(root, '../outside'), /traversal|unsafe/);
    assert.throws(() => normalizeHostProposal({ ...rawProposal, terms: Array.from({ length: 21 }, () => rawProposal.terms[0]) }, {
      storyId: story.storyId,
      host: 'codex-cli',
      seedDigest: seedsA.seedDigest,
    }), /budget exceeded/);

    const calls: string[] = [];
    const collected = await collectHostKeywordProposals({
      storyId: story.storyId,
      payload: { title: story.title, description: story.description, seeds: seedsA.seeds },
      seeds: seedsA,
      execute: async ({ host, promptDigest, seedDigest }) => {
        calls.push(host);
        if (host === 'claude-cli') throw new Error('quota limited');
        return { ...proposal(story.storyId, seedDigest), host, promptDigest, proposalId: `proposal-${host}` };
      },
    });
    assert.deepEqual(calls.sort(), ['agy-cli', 'claude-cli', 'codex-cli']);
    assert.equal(collected.accepted.length, 2);
    assert.equal(collected.attempts.find(attempt => attempt.host === 'claude-cli')?.status, 'quota-limited');

    const collectWithDelays = async (delays: Record<string, number>) => collectHostKeywordProposals({
      storyId: story.storyId, payload: { title: story.title }, seeds: seedsA,
      execute: async ({ host, promptDigest, seedDigest }) => {
        await new Promise(resolve => setTimeout(resolve, delays[host] ?? 0));
        return { ...proposal(story.storyId, seedDigest), host, promptDigest, proposalId: `proposal-${host}` };
      },
    });
    const codexSlow = await collectWithDelays({ 'codex-cli': 20, 'claude-cli': 0 });
    const claudeSlow = await collectWithDelays({ 'codex-cli': 0, 'claude-cli': 20 });
    assert.deepEqual(codexSlow.attempts.map(attempt => attempt.host), ['codex-cli', 'claude-cli']);
    assert.deepEqual(claudeSlow.attempts, codexSlow.attempts, 'host completion latency must not affect proposal ordering');
    assert.deepEqual(
      routeCandidateSpecs({ projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, proposals: codexSlow.accepted }),
      routeCandidateSpecs({ projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, proposals: claudeSlow.accepted }),
      'latency inversion must produce the same signed artifact',
    );

    let unsafeCalls = 0;
    const unsafe = await collectHostKeywordProposals({
      storyId: story.storyId,
      payload: { privateKey: '-----BEGIN PRIVATE KEY-----' },
      seeds: seedsA,
      execute: async () => { unsafeCalls += 1; return rawProposal; },
    });
    assert.equal(unsafeCalls, 0);
    assert.ok(unsafe.attempts.every(attempt => attempt.status === 'skipped-unsafe'));

    const passingWindow = (id: string) => ({
      id,
      criticalHighRecall: 1,
      overallRecall: 0.99,
      findingEquivalent: true,
      promptByteReduction: 0.95,
      p95LatencyMs: 1000,
      readMismatchCount: 0,
      unjustifiedFullScanCount: 0,
    });
    const promotion = evaluateCandidateRoutingPromotion({ from: 'shadow', to: 'warn', windows: [passingWindow('w1'), passingWindow('w2')] });
    assert.equal(promotion.allowed, true);
    assert.equal(promotion.corpusPromptInjectionAllowed, false);
    const failedPromotion = evaluateCandidateRoutingPromotion({
      from: 'warn',
      to: 'enforce',
      windows: [passingWindow('w1'), { ...passingWindow('w2'), criticalHighRecall: 0.99 }],
    });
    assert.equal(failedPromotion.allowed, false);
    assert.match(failedPromotion.blockers.join(' '), /critical\/high recall/);
    const rollback = evaluateCandidateRoutingPromotion({ from: 'enforce', to: 'shadow', windows: [] });
    assert.equal(rollback.allowed, true);
    assert.equal(rollback.rollback, 'tool-driven-broad-review-with-recorded-escalation');

    console.log('candidate-spec-routing smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runCandidateSpecRoutingSmoke();
