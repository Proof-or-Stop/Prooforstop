import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  normalizeHostProposal,
  routeCandidateSpecs,
  sanitizeHostPayload,
  verifyCandidateSpecSet,
  type HostKeywordProposal,
} from '../core/candidate-spec-routing.js';

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

export function runCandidateSpecRoutingSmoke(): void {
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

    console.log('candidate-spec-routing smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runCandidateSpecRoutingSmoke();
