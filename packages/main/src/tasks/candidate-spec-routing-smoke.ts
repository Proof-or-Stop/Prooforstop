import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  candidateReadBindingDiagnostics,
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
import {
  candidateHostFailureReason,
  currentReviewerFullyReadPaths,
  currentStoryRoutingInput,
  renderCandidateSpecRouteText,
  withUnattendedReadiness,
} from '../handlers/candidate-spec-routing.js';
import { resetConfigCache } from '../core/config.js';
import { renderDeliveryContextPackReport, type DeliveryContextPackReport } from '../handlers/delivery-context-pack.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { createMainRegistry } from '../registry.js';

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
    schemaVersion: 'proof-or-stop.keyword-proposal.v1',
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
    assert.equal(first.schemaVersion, 'proof-or-stop.corpus-index.v1');
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
    assert.equal(artifact.queryFiltering.maxDocumentFrequencyRatio, 0.4);
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
      relatedDocs: ['docs/requirements/decisions/auth-session.md'],
      files: { modify: ['packages/main/src/auth/session.ts'], create: [], test: [] },
    }] });
    store.writeCandidateSpecSet(story.storyId, artifact);
    const snapshotGit = (args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'pipe' }); };
    snapshotGit(['init', '-b', 'main']);
    snapshotGit(['config', 'user.name', 'Harmonynet']);
    snapshotGit(['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com']);
    snapshotGit(['add', 'docs/requirements/decisions']);
    snapshotGit(['commit', '-m', 'Seed canonical routing dispatch snapshot']);
    const dispatch = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    const planPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'proof-or-stop-review-scope-plan' }).prompt;
    assert.match(planPrompt, new RegExp(artifact.artifactDigest));
    assert.match(planPrompt, new RegExp(artifact.corpusDigest));
    assert.match(planPrompt, /candidateSpecSetDigest/);
    assert.equal(planPrompt.includes('Rotating credentials safely'), false, 'PLAN dispatch must not embed corpus bodies');
    store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'REVIEW', currentReviewRound: '2026-07-12T00:01:00.000Z' });
    const reviewPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'proof-or-stop-review-quality' }).prompt;
    assert.match(reviewPrompt, new RegExp(artifact.artifactDigest));
    assert.match(reviewPrompt, /review_run_start/);
    assert.match(reviewPrompt, /candidateSpecSetDigest/);
    assert.deepEqual(currentReviewerFullyReadPaths({
      valid: [{
        id: 'RP-valid', kind: 'pass', agent: 'proof-or-stop-review-quality',
        pass: {
          id: 'RP-valid', agent: 'proof-or-stop-review-quality', note: 'valid signed/current projection supplied by collector', createdAt: new Date().toISOString(),
          readManifest: {
            filesReadFully: ['docs/requirements/decisions/auth-session.md'],
            filesTriagedByName: ['docs/requirements/decisions/noise.md'],
            scanEscalationReason: null,
          },
        },
      }],
      invalid: [],
    }), ['docs/requirements/decisions/auth-session.md'], 'only fully-read paths from collector-valid evidence are promoted; triage is never authority');
    assert.deepEqual(currentReviewerFullyReadPaths({
      valid: [],
      invalid: [{ code: 'stale_run_hash', kind: 'pass', evidenceId: 'RP-stale', agent: 'proof-or-stop-review-quality', message: 'stale/unbound evidence' }],
    }), [], 'collector-invalid stale/unbound reviewer evidence contributes no protected path');
    mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
    writeFileSync(join(root, 'packages/main/src/core/machine.ts'), 'export const machine = true;\n');
    const collectorRoot = join(tmpdir(), `candidate-routing-collector-${process.pid}-${Date.now()}`);
    mkdirSync(join(collectorRoot, 'packages/main/src'), { recursive: true });
    mkdirSync(join(collectorRoot, 'docs/requirements/decisions'), { recursive: true });
    writeFileSync(join(collectorRoot, '.gitignore'), '.proof-or-stop/\n');
    writeFileSync(join(collectorRoot, 'proof-or-stop.config.json'), JSON.stringify({ requirementsDir: 'docs/requirements' }));
    writeFileSync(join(collectorRoot, 'packages/main/src/reviewer-full.ts'), 'export const reviewerFull = true;\n');
    writeFileSync(join(collectorRoot, 'docs/requirements/decisions/noise.md'), '# Noise\n');
    const git = (args: string[]): string => execFileSync('git', args, { cwd: collectorRoot, encoding: 'utf8' }).trim();
    git(['init']);
    git(['checkout', '-B', 'main']);
    git(['add', '.']);
    git(['-c', 'user.name=proof-or-stop-test', '-c', 'user.email=proof-or-stop-test@proof-or-stop.local', 'commit', '-m', 'collector base']);
    const collectorStore = new StoryStore(collectorRoot);
    const collectorRound = '2026-07-12T00:02:00.000Z';
    collectorStore.writeStory(story.storyId, {
      storyId: story.storyId, name: 'collector-integration', title: 'Collector integration', description: 'Signed current reviewer evidence',
      type: 'feature', phase: 'REVIEW', priority: 'medium', createdAt: '2026-07-12T00:00:00.000Z', startedAt: '2026-07-12T00:00:00.000Z', endedAt: null,
      currentReviewRound: collectorRound, events: [],
    });
    collectorStore.writeChecklist(story.storyId, { items: [] });
    const reviewAgent = 'proof-or-stop-review-quality';
    const collectorRegistry = createMainRegistry({ root: collectorRoot, store: collectorStore, scanRoot: join(collectorRoot, 'packages/main') });
    collectorRegistry.get('dispatch')!({ storyId: story.storyId, agentType: reviewAgent });
    const startedRun = String(collectorRegistry.get('review_run_start')!({ storyId: story.storyId, agent: reviewAgent }));
    const reviewRunId = startedRun.match(/Review run (\S+) started/)?.[1];
    assert.ok(reviewRunId, 'the production reviewer-run producer emits canonical bound evidence');
    collectorRegistry.get('review_pass_set')!({
      storyId: story.storyId,
      agent: reviewAgent,
      note: 'collector integration pass',
      reviewRunId,
      readManifest: {
        filesReadFully: ['packages/main/src/reviewer-full.ts'],
        filesTriagedByName: ['docs/requirements/decisions/noise.md'],
        scanEscalationReason: null,
      },
    });
    resetConfigCache();
    const collectorEvidence = collectReviewerEvidenceState(collectorStore, story.storyId, collectorRoot);
    assert.equal(collectorEvidence.invalid.length, 0, JSON.stringify(collectorEvidence.invalid, null, 2));
    const collectorBoundInput = currentStoryRoutingInput({ store: collectorStore, root: collectorRoot, scanRoot: join(collectorRoot, 'packages/main') }, story.storyId);
    assert.ok(collectorBoundInput.protectedSources?.some(source => source.kind === 'reviewer-evidence' && source.path === 'packages/main/src/reviewer-full.ts'), 'handler consumes current collector-valid filesReadFully');
    assert.equal(collectorBoundInput.protectedSources?.some(source => source.path === 'docs/requirements/decisions/noise.md' && source.kind === 'reviewer-evidence'), false, 'collector triage never becomes protected authority');
    writeFileSync(join(collectorRoot, 'packages/main/src/reviewer-full.ts'), 'export const reviewerFull = false;\n');
    git(['add', '.']);
    git(['-c', 'user.name=proof-or-stop-test', '-c', 'user.email=proof-or-stop-test@proof-or-stop.local', 'commit', '-m', 'make reviewer evidence stale']);
    const collectorStaleInput = currentStoryRoutingInput({ store: collectorStore, root: collectorRoot, scanRoot: join(collectorRoot, 'packages/main') }, story.storyId);
    assert.equal(collectorStaleInput.protectedSources?.some(source => source.kind === 'reviewer-evidence'), false, 'stale/unbound collector evidence is rejected by ordinary handler input');
    rmSync(collectorRoot, { recursive: true, force: true });
    store.writeStory(story.storyId, {
      ...store.readStory(story.storyId),
      riskSignals: [
        { category: 'Security/Credentials', matched: 'auth' },
        { category: 'Production/Emergency', matched: 'production' },
        { category: 'State Machine/Gate', matched: 'machine.ts' },
      ],
    });
    const realInput = currentStoryRoutingInput({ store, root, scanRoot: join(root, 'packages/main') }, story.storyId);
    assert.deepEqual(realInput.riskSignals, ['Security/Credentials:auth', 'Production/Emergency:production', 'State Machine/Gate:machine.ts']);
    assert.ok(realInput.protectedSources?.some(source => source.kind === 'related-doc' && source.path === 'docs/requirements/decisions/auth-session.md'));
    assert.deepEqual(realInput.protectedSources?.filter(source => source.kind === 'typed-risk').map(source => source.path), ['packages/main/src/core/machine.ts'], 'only a canonical structured source path is protected; generic typed risks fabricate nothing');
    const structuredRiskRoute = routeCandidateSpecs({ projectRoot: root, storyId: story.storyId, corpus: first, seeds: buildKeywordSeeds(realInput), riskSignals: realInput.riskSignals, protectedSources: realInput.protectedSources });
    assert.ok(structuredRiskRoute.escalationReasons.includes('high_risk_structured_signal'));
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
    } as unknown as DeliveryContextPackReport);
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
    assert.equal(verifyCandidateSpecSet({ ...artifact, candidates: 'not-an-array' }), false, 'a persisted string candidates field must fail closed before consumers dereference it');
    assert.equal(verifyCandidateSpecSet({ ...artifact, candidates: { path: 'not-an-array' } }), false, 'a persisted object candidates field must fail closed before consumers dereference it');
    for (const [label, malformedCandidates] of [
      ['string', 'not-an-array'],
      ['object', { path: 'not-an-array' }],
    ] as const) {
      const { artifactDigest: _staleArtifactDigest, ...validBase } = artifact;
      const malformedBase = { ...validBase, candidates: malformedCandidates };
      const signedMalformedArtifact = {
        ...malformedBase,
        artifactDigest: digestCandidateRoutingValue(malformedBase),
      };
      assert.equal(verifyCandidateSpecSet(signedMalformedArtifact), false, `a persisted ${label} candidates field with a recomputed artifactDigest must still fail structural verification`);
    }
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
    console.log('B-8af0 artifactDigest tamper guard: PASS');
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
      maxDocumentFrequencyRatio: 1,
    });
    assert.equal(truncatedRoute.requiresEscalation, true, 'ranking-affecting truncation must require an explicit escalation decision');
    assert.ok(truncatedRoute.escalationReasons.includes('ranking_affecting_query_truncation'));
    assert.ok(truncatedRoute.queryTruncation.some(row => row.omittedMaxScore === row.selectedCutoffScore && row.classification === 'ranking_affecting'), 'a score tied at the selected cutoff must be ranking-affecting');
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
    assert.deepEqual(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: truncatedRoute, mode: 'shadow' }), [], 'shadow is observational even when a digest is supplied');
    assert.deepEqual(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: truncatedRoute, mode: 'warn' }), [], 'warn is advisory even when a digest is supplied');
    const pendingCliText = renderCandidateSpecRouteText(truncatedRoute, first.entries.length, []);
    assert.match(pendingCliText, /BLOCKED_PENDING_ESCALATION/);
    assert.match(pendingCliText, /fullScanReason/);

    const frequencyFilteredRoute = routeCandidateSpecs({
      projectRoot: root,
      storyId: story.storyId,
      corpus: first,
      seeds: buildKeywordSeeds({
        storyId: story.storyId,
        title: 'decision auth session',
        relatedDocs: ['docs/requirements/decisions/auth-session.md'],
      }),
      rawHitsPerGroup: 1,
    });
    assert.ok(frequencyFilteredRoute.queryFiltering.filteredTerms.some(term => term.term === 'decision' && term.documentCount === first.entries.length));
    assert.ok(!frequencyFilteredRoute.escalationReasons.includes('ranking_affecting_query_truncation'), 'overbroad terms must not trigger ranking truncation');
    assert.equal(frequencyFilteredRoute.fullScan, false);
    assert.ok(frequencyFilteredRoute.candidateSpecSet.includes('docs/requirements/decisions/auth-session.md'), 'explicit relatedDocs bypass frequency filtering');
    assert.match(renderCandidateSpecRouteText(frequencyFilteredRoute, first.entries.length, []), /queryFiltering=maxDocumentFrequencyRatio=0\.4 filtered=.*decision:3/);

    const genericOnly = routeCandidateSpecs({
      projectRoot: root,
      storyId: story.storyId,
      corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'decision decision decision' }),
    });
    assert.ok(genericOnly.queryFiltering.filteredTerms.some(term => term.term === 'decision'));
    assert.ok(genericOnly.ambiguitySignals.includes('generic_only_filtered_bounded'));
    assert.ok(!genericOnly.ambiguitySignals.includes('zero_candidates'));
    assert.equal(genericOnly.requiresEscalation, false, 'generic-only filtered vocabulary is bounded without full-scan pressure');
    assert.equal(genericOnly.fullScan, false);

    const dfRoot = join(tmpdir(), `candidate-routing-df-${process.pid}-${Date.now()}`);
    mkdirSync(join(dfRoot, 'docs/requirements/decisions'), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(dfRoot, `docs/requirements/decisions/df-${index}.md`), `# DF ${index}\n${index < 2 ? 'boundaryterm boundaryterm boundaryterm' : ''}${index < 3 ? ' aboveterm' : ''}\n`);
    }
    const dfCorpus = buildCorpusIndex(dfRoot);
    const dfBoundary = routeCandidateSpecs({
      projectRoot: dfRoot, storyId: story.storyId, corpus: dfCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'boundaryterm aboveterm' }),
      maxDocumentFrequencyRatio: 0.4,
    });
    const boundaryRow = dfBoundary.queryFiltering.filteredTerms.find(row => row.term === 'boundaryterm');
    const aboveRow = dfBoundary.queryFiltering.filteredTerms.find(row => row.term === 'aboveterm');
    assert.equal(boundaryRow, undefined, 'exactly 2/5 stays eligible at the 0.4 boundary despite duplicate occurrences');
    assert.deepEqual(aboveRow && { count: aboveRow.documentCount, ratio: aboveRow.documentFrequencyRatio }, { count: 3, ratio: 0.6 });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(dfRoot, `docs/requirements/decisions/df-${index}.md`), `# DF ${index}\n${Array.from({ length: 12 }, (_, term) => `generic${String(term).padStart(2, '0')}`).join(' ')}${index === 0 ? ' firstonlyterm' : ''}${index === 4 ? ' zzspecificsurvivor' : ''}\n`);
    }
    const starvationCorpus = buildCorpusIndex(dfRoot);
    const starvationRoute = routeCandidateSpecs({
      projectRoot: dfRoot,
      storyId: story.storyId,
      corpus: starvationCorpus,
      seeds: buildKeywordSeeds({
        storyId: story.storyId,
        keywords: [...Array.from({ length: 12 }, (_, index) => `generic${String(index).padStart(2, '0')}`), 'zzspecificsurvivor'],
      }),
      queryGroupBudget: 4,
      maxDocumentFrequencyRatio: 0.4,
    });
    assert.ok(starvationRoute.queryFiltering.filteredTerms.length >= 12, 'generic terms are audited even though they do not spend query budget');
    assert.deepEqual(starvationRoute.queryGroups, [['zzspecificsurvivor']], 'specific term receives budget after generic DF filtering');
    assert.ok(starvationRoute.candidateSpecSet.includes('docs/requirements/decisions/df-4.md'), 'specific candidate survives >budget generic seeds');
    const zeroHitStarvation = routeCandidateSpecs({
      projectRoot: dfRoot,
      storyId: story.storyId,
      corpus: starvationCorpus,
      seeds: buildKeywordSeeds({
        storyId: story.storyId,
        keywords: [...Array.from({ length: 12 }, (_, index) => `aaazerohit${String(index).padStart(2, '0')}`), 'zzspecificsurvivor'],
      }),
      queryGroupBudget: 2,
      maxDocumentFrequencyRatio: 1,
    });
    assert.deepEqual(zeroHitStarvation.queryGroups, [['zzspecificsurvivor']], 'many ordered zero-hit groups do not spend budget before a later rare matching term');
    assert.equal(zeroHitStarvation.queryFiltering.filteredTerms.filter(term => term.reason === 'zero_hits').length, 12, 'every skipped zero-hit term remains in deterministic signed audit metrics');
    assert.ok(zeroHitStarvation.candidateSpecSet.includes('docs/requirements/decisions/df-4.md'));
    const emptyIntersection = routeCandidateSpecs({
      projectRoot: dfRoot, storyId: story.storyId, corpus: starvationCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, keywords: ['firstonlyterm', 'zzspecificsurvivor'] }),
      queryGroupBudget: 3, maxDocumentFrequencyRatio: 1,
    });
    assert.deepEqual(emptyIntersection.queryGroups, [['firstonlyterm'], ['zzspecificsurvivor']], 'a generated multi-term group with no intersection does not consume spare budget');
    rmSync(dfRoot, { recursive: true, force: true });

    const protectedKinds = ['related-doc', 'exact-path', 'registry-ref', 'typed-risk', 'reviewer-evidence'] as const;
    const protectedSources = Array.from({ length: 10 }, (_, index) => {
      const kind = protectedKinds[index % protectedKinds.length];
      const path = `docs/requirements/decisions/protected-${index}.md`;
      writeFileSync(join(root, path), `# Protected ${index}\n\nproofOrStop core handlers proof-or-stop\n`);
      return { kind, path, sourceRef: `typed.${kind}` };
    });
    const protectedCorpus = buildCorpusIndex(root);
    const protectedRoute = routeCandidateSpecs({
      projectRoot: root,
      storyId: story.storyId,
      corpus: protectedCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'zz-no-ordinary-match' }),
      protectedSources,
      candidateBudget: 8,
    });
    for (const source of protectedSources) {
      assert.ok(protectedRoute.candidateSpecSet.includes(source.path), `${source.kind} exact source survives generic filtering`);
      assert.ok(protectedRoute.candidateBasis[source.path]?.some(reason => reason.kind === source.kind && reason.source === source.sourceRef));
    }
    assert.equal(protectedRoute.fullScan, false);
    assert.equal(protectedRoute.protectedRouting.protectedCount, 10);
    assert.equal(protectedRoute.protectedRouting.exceedsOrdinaryBudget, true);
    assert.equal(protectedRoute.candidateSpecSet.filter(path => path.includes('protected-')).length, 10, 'mandatory protected candidates may exceed ordinary budget without loss');
    assert.equal(protectedRoute.escalationReasons.includes('candidate_cutoff_tie'), false, 'protected count never participates in ordinary cutoff ties');
    assert.equal(protectedRoute.escalationReasons.includes('weak_source_class_coverage'), false, 'protected-only source concentration never requests a broad scan');
    assert.equal(protectedRoute.requiresEscalation, false, 'ten valid mandatory protected candidates with zero ordinary matches remain bounded and valid');
    for (const source of protectedSources) rmSync(join(root, source.path));

    mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
    const externalRegistry = 'packages/main/src/core/process-fact-registry.ts';
    writeFileSync(join(root, externalRegistry), 'export const PROCESS_FACT = true;\n');
    const externalProtected = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA,
      protectedSources: [
        { kind: 'registry-ref', path: externalRegistry, sourceRef: 'understanding.touchpoints[0]' },
        { kind: 'exact-path', path: 'packages/main/src/missing.ts', sourceRef: 'changedPaths[1]' },
      ],
    });
    assert.ok(externalProtected.candidateSpecSet.includes(externalRegistry));
    assert.match(externalProtected.candidates.find(candidate => candidate.path === externalRegistry)?.contentHash ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(externalProtected.protectedRouting.missing, [{ kind: 'exact-path', path: 'packages/main/src/missing.ts', sourceRef: 'changedPaths[1]', reason: 'missing' }]);
    assert.ok(externalProtected.escalationReasons.some(reason => reason.startsWith('missing_protected_source:missing:')));

    writeFileSync(join(root, 'docs/requirements/decisions/aaa-incidentalcommonterm.md'), '# Strong First\n\nincidentalcommonterm\n');
    writeFileSync(join(root, 'docs/requirements/decisions/common-b.md'), '# Common B\n\nincidentalcommonterm\n');
    writeFileSync(join(root, 'docs/requirements/decisions/common-c.md'), '# Common C\n\nincidentalcommonterm\n');
    const safeTruncationCorpus = buildCorpusIndex(root);
    const safeTruncation = routeCandidateSpecs({
      projectRoot: root,
      storyId: story.storyId,
      corpus: safeTruncationCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'incidentalcommonterm' }),
      candidateBudget: 1,
      rawHitsPerGroup: 1,
      maxDocumentFrequencyRatio: 1,
    });
    assert.ok(safeTruncation.queryTruncation.some(row => row.classification === 'safe_below_cutoff' && row.omittedMaxScore === 8 && row.selectedCutoffScore === 20));
    assert.ok(!safeTruncation.escalationReasons.includes('ranking_affecting_query_truncation'), 'raw overflow below the selected cutoff is diagnostic-only');
    assert.equal(verifyCandidateSpecSet({
      ...safeTruncation,
      queryTruncation: safeTruncation.queryTruncation.map((row, index) => index === 0 ? { ...row, omittedMaxScore: Number.NaN } : row),
    }), false, 'non-finite truncation evidence fails closed instead of claiming safe or ranking-affecting');
    const firstTruncation = safeTruncation.queryTruncation[0];
    assert.ok(firstTruncation);
    assert.equal(verifyCandidateSpecSet({
      ...safeTruncation,
      queryTruncation: [{ ...firstTruncation, omittedHits: firstTruncation.omittedHits + 1 }, ...safeTruncation.queryTruncation.slice(1)],
    }), false, 'inconsistent retained/omitted counts fail closed');
    assert.equal(verifyCandidateSpecSet({
      ...safeTruncation,
      queryTruncation: [{ ...firstTruncation, selectedCutoffScore: null }, ...safeTruncation.queryTruncation.slice(1)],
    }), false, 'missing cutoff cannot claim safe truncation');
    assert.equal(verifyCandidateSpecSet({
      ...safeTruncation,
      queryTruncation: [{ ...firstTruncation, selectedCutoffScore: (firstTruncation.selectedCutoffScore ?? 0) + 1 }, ...safeTruncation.queryTruncation.slice(1)],
    }), false, 'independently recomputed artifact digest rejects finite cutoff tampering');
    for (const name of ['aaa-incidentalcommonterm.md', 'common-b.md', 'common-c.md']) rmSync(join(root, `docs/requirements/decisions/${name}`));

    const routesByMode = Object.fromEntries((['shadow', 'warn', 'enforce'] as const).map(mode => [mode, routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'decision' }), rawHitsPerGroup: 1,
      maxDocumentFrequencyRatio: 1, mode,
    })])) as Record<'shadow' | 'warn' | 'enforce', typeof truncatedRoute>;
    const enforceText = renderCandidateSpecRouteText(routesByMode.enforce, first.entries.length, []);
    const warnText = renderCandidateSpecRouteText(routesByMode.warn, first.entries.length, []);
    const shadowText = renderCandidateSpecRouteText(routesByMode.shadow, first.entries.length, []);
    assert.match(enforceText, /BLOCKED_PENDING_ESCALATION/);
    assert.match(warnText, /WARNING_PENDING_ESCALATION/);
    assert.doesNotMatch(warnText, /BLOCKED|STOP/);
    assert.match(shadowText, /SHADOW_RECORDED/);
    assert.doesNotMatch(shadowText, /BLOCKED|STOP/);
    const decisionProjection = (value: typeof truncatedRoute) => {
      const { mode: _mode, artifactDigest: _digest, ...decision } = value;
      return decision;
    };
    assert.deepEqual(decisionProjection(routesByMode.shadow), decisionProjection(routesByMode.warn));
    assert.deepEqual(decisionProjection(routesByMode.warn), decisionProjection(routesByMode.enforce));
    assert.throws(() => renderCandidateSpecRouteText(routesByMode.shadow, first.entries.length, [], 'enforce'), /mode disagreement/);
    assert.match(renderCandidateSpecRouteText(routesByMode.enforce, first.entries.length, [], 'warn'), /WARNING_MODE_MISMATCH/);
    assert.match(renderCandidateSpecRouteText(routesByMode.enforce, first.entries.length, [], 'shadow'), /SHADOW_MODE_MISMATCH_RECORDED/);
    assert.deepEqual(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: routesByMode.shadow, mode: 'shadow' }), []);
    assert.deepEqual(candidateReadBindingErrors({ manifest: truncatedManifest, artifact: routesByMode.warn, mode: 'warn' }), []);
    assert.deepEqual(candidateReadBindingDiagnostics({ manifest: { ...truncatedManifest, candidateSpecSetDigest: routesByMode.enforce.artifactDigest }, artifact: routesByMode.enforce, mode: 'shadow' })
      .filter(diagnostic => diagnostic.code === 'mode_mismatch'), [{ code: 'mode_mismatch', message: 'candidate artifact mode=enforce does not match configured mode=shadow; rerun candidate_spec_route', blocking: false }]);
    assert.equal(candidateReadBindingDiagnostics({ manifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, artifact: routesByMode.enforce, mode: 'warn' })
      .find(diagnostic => diagnostic.code === 'mode_mismatch')?.blocking, false, 'mode mismatch remains observable even when advisory evidence omitted its digest');
    assert.equal(candidateReadBindingDiagnostics({ manifest: { ...truncatedManifest, candidateSpecSetDigest: routesByMode.enforce.artifactDigest }, artifact: routesByMode.enforce, mode: 'warn' })
      .find(diagnostic => diagnostic.code === 'mode_mismatch')?.blocking, false);
    assert.equal(candidateReadBindingDiagnostics({ manifest: { ...truncatedManifest, candidateSpecSetDigest: routesByMode.shadow.artifactDigest }, artifact: routesByMode.shadow, mode: 'enforce' })
      .find(diagnostic => diagnostic.code === 'mode_mismatch')?.blocking, true);
    assert.match(candidateReadBindingErrors({ manifest: { ...truncatedManifest, candidateSpecSetDigest: routesByMode.enforce.artifactDigest }, artifact: routesByMode.enforce, mode: 'enforce' }).join(' '), /escalation is unresolved/);
    for (const mode of ['shadow', 'warn', 'enforce'] as const) {
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ candidateSpecRouting: { mode } }));
      resetConfigCache();
      store.writeCandidateSpecSet(story.storyId, routesByMode[mode]);
      const modePrompt = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') })
        .dispatch({ storyId: story.storyId, agentType: 'proof-or-stop-review-quality' }).prompt;
      store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'DEV' });
      const itemModePrompt = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') })
        .dispatch({ storyId: story.storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-implementer' }).prompt;
      store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'REVIEW' });
      if (mode === 'shadow') {
        assert.match(modePrompt, /SHADOW/);
        assert.doesNotMatch(modePrompt, /STOP — candidate routing/);
        assert.doesNotMatch(itemModePrompt, /STOP — candidate routing/);
      } else if (mode === 'warn') {
        assert.match(modePrompt, /WARNING/);
        assert.doesNotMatch(modePrompt, /STOP — candidate routing/);
        assert.doesNotMatch(itemModePrompt, /STOP — candidate routing/);
      } else {
        assert.match(modePrompt, /STOP — candidate routing/);
        assert.match(itemModePrompt, /STOP — candidate routing/);
      }
    }
    for (const mode of ['shadow', 'warn', 'enforce'] as const) {
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ candidateSpecRouting: { mode } }));
      resetConfigCache();
      store.writeCandidateSpecSet(story.storyId, mode === 'enforce' ? routesByMode.shadow : routesByMode.enforce);
      for (const itemId of [undefined, 'CHK-001'] as const) {
        store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: itemId ? 'DEV' : 'REVIEW' });
        const mismatchPrompt = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') })
          .dispatch({ storyId: story.storyId, ...(itemId ? { itemId } : {}), agentType: itemId ? 'proof-or-stop-implementer' : 'proof-or-stop-review-quality' }).prompt;
        assert.match(mismatchPrompt, /MODE_MISMATCH/);
        if (mode === 'enforce') assert.match(mismatchPrompt, /STOP — MODE_MISMATCH/);
        else assert.doesNotMatch(mismatchPrompt, /STOP — MODE_MISMATCH/);
      }
    }
    store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'REVIEW' });
    rmSync(join(root, 'proof-or-stop.config.json'), { force: true });
    resetConfigCache();

    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(root, `docs/requirements/decisions/body-only-${index}.md`), `# Unique ${index}\n\nincidentalbodysignal\n`);
    }
    const bodyTieCorpus = buildCorpusIndex(root);
    const bodyTieRoute = routeCandidateSpecs({
      projectRoot: root,
      storyId: story.storyId,
      corpus: bodyTieCorpus,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'incidentalbodysignal' }),
      candidateBudget: 2,
      maxDocumentFrequencyRatio: 1,
    });
    assert.ok(bodyTieRoute.candidates.every(candidate => candidate.score === 8));
    assert.ok(!bodyTieRoute.escalationReasons.includes('candidate_cutoff_tie'), 'body-only score ties use deterministic truncation and must not force a broad scan');
    assert.equal(bodyTieRoute.rankingPolicy.minRankingAffectingCutoffScore, 15);
    for (let index = 0; index < 8; index += 1) rmSync(join(root, `docs/requirements/decisions/body-only-${index}.md`));

    const resolvedTruncation = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'decision' }), rawHitsPerGroup: 1,
      maxDocumentFrequencyRatio: 1,
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
      seeds: buildKeywordSeeds({ storyId: story.storyId, title: 'legacy login' }),
    });
    assert.ok(weakCoverage.escalationReasons.includes('weak_source_class_coverage'));
    assert.equal(weakCoverage.fullScan, false);

    const explicitRelatedOnly = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first,
      seeds: buildKeywordSeeds({ storyId: story.storyId, relatedDocs: ['docs/requirements/decisions/noise.md'] }),
    });
    assert.equal(explicitRelatedOnly.requiresEscalation, false, 'an explicit relatedDoc is a strong source and must not require a second weaker source class');
    assert.deepEqual(explicitRelatedOnly.candidateSpecSet, ['docs/requirements/decisions/noise.md']);

    const hostDisagreement = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA, hostDisagreement: true,
    });
    assert.ok(hostDisagreement.escalationReasons.includes('primary_host_disagreement'));
    assert.equal(hostDisagreement.fullScan, false);

    const highRisk = routeCandidateSpecs({
      projectRoot: root, storyId: story.storyId, corpus: first, seeds: seedsA,
      riskSignals: ['State Machine/Gate:process-fact global rename'],
    });
    store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'PLAN' });
    assert.ok(highRisk.escalationReasons.includes('high_risk_structured_signal'));
    assert.equal(highRisk.fullScan, false);
    store.writeCandidateSpecSet(story.storyId, highRisk);
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ candidateSpecRouting: { mode: 'enforce' } }));
    resetConfigCache();
    const pendingPlanPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'proof-or-stop-review-scope-plan' }).prompt;
    assert.match(pendingPlanPrompt, /STOP — candidate routing escalation is unresolved/);
    assert.match(pendingPlanPrompt, /high_risk_structured_signal/);
    assert.match(pendingPlanPrompt, /fullScanReason/);
    store.writeStory(story.storyId, { ...store.readStory(story.storyId), phase: 'REVIEW' });
    const pendingReviewPrompt = dispatch.dispatch({ storyId: story.storyId, agentType: 'proof-or-stop-review-quality' }).prompt;
    assert.match(pendingReviewPrompt, /Do not submit review_pass_set or finding evidence/);
    assert.match(pendingReviewPrompt, /high_risk_structured_signal/);
    rmSync(join(root, 'proof-or-stop.config.json'), { force: true });
    resetConfigCache();

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

    const readinessBase = {
      launcherOk: true,
      reviewReady: true,
      progressMode: 'jsonl' as const,
      diagnostic: undefined,
      remediation: '',
    };
    let missingRowCalls = 0;
    const missingRowExecutor = withUnattendedReadiness(async () => { missingRowCalls += 1; return {}; }, []);
    await assert.rejects(() => missingRowExecutor({ host: 'codex-cli', storyId: story.storyId, sanitizedPayload: {}, promptDigest: 'p', seedDigest: 's' }), /readiness_missing.*skipped pre-spawn/);
    assert.equal(missingRowCalls, 0);
    for (const row of [
      { launcherSupport: 'unverified' as const, launcherOk: false, executionReady: false, failureKind: 'missing_executable' as const, progressMode: 'jsonl' as const },
      { launcherSupport: 'unverified' as const, executionReady: false, failureKind: 'unknown' as const },
      { launcherSupport: 'unsupported' as const, executionReady: false, failureKind: 'unsupported' as const },
      { launcherSupport: 'wrong_launcher' as const, launcherOk: false, executionReady: false, failureKind: 'wrong_launcher' as const, progressMode: 'jsonl' as const },
      { launcherSupport: 'supported' as const, launcherOk: false, executionReady: false, failureKind: 'wrong_launcher' as const, progressMode: 'jsonl' as const },
      { launcherSupport: 'supported' as const, executionReady: false, failureKind: 'auth' as const },
      { launcherSupport: 'supported' as const, executionReady: false, failureKind: 'interactive' as const },
      { launcherSupport: 'supported' as const, executionReady: false, failureKind: 'timeout' as const },
      { launcherSupport: 'supported' as const, executionReady: true, failureKind: 'none' as const, progressMode: 'none' as const },
    ]) {
      let spawnCalls = 0;
      const admitted = withUnattendedReadiness(async () => { spawnCalls += 1; return {}; }, [{ host: 'codex', ...readinessBase, ...row }]);
      await assert.rejects(() => admitted({ host: 'codex-cli', storyId: story.storyId, sanitizedPayload: {}, promptDigest: 'p', seedDigest: 's' }), /skipped pre-spawn/);
      assert.equal(spawnCalls, 0, `${row.launcherSupport}/${row.failureKind} refuses with zero executor calls`);
    }
    let readyCalls = 0;
    const readyExecutor = withUnattendedReadiness(async () => { readyCalls += 1; return { ok: true }; }, [{
      host: 'codex', ...readinessBase, launcherSupport: 'supported', executionReady: true, failureKind: 'none',
    }]);
    assert.deepEqual(await readyExecutor({ host: 'codex-cli', storyId: story.storyId, sanitizedPayload: {}, promptDigest: 'p', seedDigest: 's' }), { ok: true });
    assert.equal(readyCalls, 1);

    const failedRunBase = {
      blocked: false, refusalReason: null, timedOut: false, timeoutKind: null,
      firstOutputMs: 2, durationMs: 8, exitCode: 1, terminalReason: 'exit_nonzero' as const,
    };
    assert.equal(candidateHostFailureReason({ ...failedRunBase, failureKind: 'auth' }), 'post_readiness_auth_required');
    assert.equal(candidateHostFailureReason({ ...failedRunBase, failureKind: 'interactive' }), 'post_readiness_interactive_required');
    assert.equal(candidateHostFailureReason({ ...failedRunBase, timedOut: true, timeoutKind: 'total_timeout', failureKind: 'auth' }), 'post_readiness_auth_required', 'sticky actionable classification outranks a later generic timeout');
    assert.equal(candidateHostFailureReason({ ...failedRunBase, firstOutputMs: null, failureKind: 'unknown' }), 'post_readiness_no_output');
    assert.equal(candidateHostFailureReason({ ...failedRunBase, terminalReason: 'spawn_error', failureKind: 'missing_executable' }), 'post_readiness_spawn_error:missing_executable');

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
