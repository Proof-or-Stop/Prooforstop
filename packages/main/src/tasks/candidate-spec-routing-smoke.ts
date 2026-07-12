import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  candidateReadBindingErrors,
  collectHostKeywordProposals,
  evaluateCandidateRoutingPromotion,
  normalizeHostProposal,
  routeCandidateSpecs,
  sanitizeHostPayload,
  verifyCandidateSpecSet,
  type HostKeywordProposal,
} from '../core/candidate-spec-routing.js';
import { StoryStore } from '../core/store.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
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
