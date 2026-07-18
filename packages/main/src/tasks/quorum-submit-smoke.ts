#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../core/authority-signing.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signReviewPass } from '../core/finding-verify.js';
import { signReviewRun, verifyReviewRunPromptEnvelope } from '../core/review-run.js';
import {
  deriveCanonicalHostKeyId,
  deriveHostVerdictBindings,
  HOST_VERDICT_PROMPT_DIGEST_SCHEMA,
  HOST_VERDICT_PROMPT_PURPOSE,
  HOST_VERDICT_VALIDATION_DIGEST_SCHEMA,
} from '../core/host-verdict-bindings.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { computePromptEnvelopeId } from '../core/prompt-envelope.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../core/prompt-role-contract-registry.js';
import { readPromptRegistry, renderPromptEntryForHost, type PromptHost } from '../core/prompt-registry.js';
import { StoryStore } from '../core/store.js';
import { listVerdicts, summarizeVerdicts } from '../core/verdicts.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import { reviewerPromptHostForProvider } from '../handlers/story-dispatch.js';
import type { ChecklistData, ReviewPass, ReviewRun, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-quorum-smoke';
const REVIEW_ROUND = '2026-06-22T10:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=quorum-smoke@example.test', '-c', 'user.name=Quorum Submit Smoke'];
const REVIEW_LANES = [
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-test-coverage',
] as const;

function reviewerReadManifest(lane: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${lane}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    proofAdmissibility: {
      mode: 'enforce',
      enforcedConsumers: ['REVIEW'],
    },
    promptEnvelope: {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: Object.fromEntries(REVIEW_LANES.map(lane => [lane, 'full-envelope'])),
    },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'quorum-submit-smoke',
    title: 'quorum_submit smoke',
    description: 'Synthetic REVIEW story for quorum_submit smoke coverage.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    createdAt: '2026-06-22T09:00:00.000Z',
    startedAt: '2026-06-22T09:10:00.000Z',
    endedAt: null,
    events: [
      { phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND },
    ],
  } as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'submit local quorum',
      context: 'Smoke fixture item already implemented.',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
}

function makeFixture(
  assetMode: 'global-thin' | 'full' = 'global-thin',
  selectedHost: PromptHost = 'codex',
): { root: string; store: StoryStore; ctx: HandlerContext; registry: ReturnType<typeof createMainRegistry> } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-quorum-submit-'));
  writeConfig(root);
  write(root, '.lattice/lattice.json', `${JSON.stringify({ assetMode }, null, 2)}\n`);
  if (assetMode === 'full') {
    const promptRegistry = readPromptRegistry();
    const assetDir = selectedHost === 'codex' ? '.lattice-codex/agents' : '.claude/agents';
    for (const lane of REVIEW_LANES) {
      const entry = promptRegistry.agents.find(candidate => candidate.agentId === lane)!;
      write(root, `${assetDir}/${entry.file}`, renderPromptEntryForHost(entry, selectedHost));
    }
  }
  write(root, 'README.md', 'quorum submit smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed']);
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = 1;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story code change']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, checklist());
  store.writeTestEvidence(STORY_ID, {
    result: 'PASS',
    command: 'quorum-submit-smoke-validation',
    output: 'synthetic validation passed',
    timestamp: '2026-06-22T09:30:00.000Z',
  });
  git(root, ['add', '.lattice/story', 'lattice.config.json']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story review metadata']);

  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  return { root, store, ctx, registry };
}

function hostVerdictEventCount(store: StoryStore): number {
  return store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict').length;
}

function verdictFileCount(root: string): number {
  return listVerdicts(root, 'local', STORY_ID).length;
}

function assertQuorumRefuses(registry: ReturnType<typeof createMainRegistry>, store: StoryStore, root: string, label: string): void {
  const beforeEvents = hostVerdictEventCount(store);
  const beforeVerdicts = verdictFileCount(root);
  const handler = registry.get('quorum_submit');
  assert.ok(handler, 'quorum_submit handler is registered');
  assert.throws(
    () => handler({
      storyId: STORY_ID,
      hostA: 'host-a',
      hostB: 'host-b',
      format: 'json',
    }),
    /quorum_submit refuses: no current reviewer pass evidence for the required lanes/,
    label,
  );
  assert.equal(hostVerdictEventCount(store), beforeEvents, `${label}: no host_verdict process events written`);
  assert.equal(verdictFileCount(root), beforeVerdicts, `${label}: no verdict files written`);
}

function startRunAndPass(registry: ReturnType<typeof createMainRegistry>, lane: string): void {
  const dispatch = registry.get('dispatch');
  const start = registry.get('review_run_start');
  const pass = registry.get('review_pass_set');
  assert.ok(dispatch, 'dispatch handler is registered');
  assert.ok(start, 'review_run_start handler is registered');
  assert.ok(pass, 'review_pass_set handler is registered');
  const dispatched = dispatch({ storyId: STORY_ID, agentType: lane }) as { prompt: string };
  assert.match(dispatched.prompt, new RegExp(`Review lane: ${lane}`));
  const output = String(start({
    storyId: STORY_ID,
    agent: lane,
  }));
  const match = output.match(/Review run (\S+) started/);
  assert.ok(match?.[1], `review_run_start output contains reviewRunId for ${lane}`);
  assert.match(output, /BEGIN EXACT ASSEMBLED REVIEW PROMPT/, 'review_run_start delivers the exact bound prompt bytes');
  pass({
    storyId: STORY_ID,
    agent: lane,
    reviewRunId: match[1],
    note: `No blocking issue found by ${lane} for quorum_submit smoke.`,
    readManifest: reviewerReadManifest(lane),
  });
}

const SESSION_ENV_KEYS = [
  'LATTICE_SESSION_ID',
  'LATTICE_ACTIVITY_SOURCE',
  'LATTICE_ACTIVITY_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
  'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_TASK',
  'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
  'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'AGY_SESSION_ID',
] as const;

function withSessionProvider<T>(provider: string | undefined, fn: () => T): T {
  const previous = Object.fromEntries(SESSION_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of SESSION_ENV_KEYS) delete process.env[key];
  process.env.LATTICE_SESSION_ID = `sess-quorum-${provider ?? 'absent'}`;
  if (provider !== undefined) process.env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER = provider;
  resetSessionIdForTest();
  try {
    return fn();
  } finally {
    for (const key of SESSION_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionIdForTest();
  }
}

function recordReviewerPasses(
  registry: ReturnType<typeof createMainRegistry>,
  provider: 'codex' | 'claude-code' | 'codex-cli' | 'claude-cli' = 'codex',
): void {
  withSessionProvider(provider, () => {
    for (const lane of REVIEW_LANES) startRunAndPass(registry, lane);
  });
}

let materialChangeCounter = 1;
function commitMaterialChange(root: string): void {
  // Each call must produce a DISTINCT materialDigest (a new commit with new content), so the
  // counter guarantees the file content actually changes even across repeated calls.
  materialChangeCounter += 1;
  write(root, 'packages/main/src/index.ts', `export const seed = true;\nexport const changed = ${materialChangeCounter};\n`);
  // Stage the whole tree so any verdict/process-event files written by a prior quorum are
  // committed too, leaving a clean working tree for the next review_run_start preflight.
  git(root, ['add', '-A']);
  git(root, [...COMMIT_ENV, 'commit', '-m', `material change ${materialChangeCounter}`]);
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const previousCwd = process.cwd();
const { root, store, registry } = makeFixture();

try {
  process.chdir(root);

  check('reviewer provider mapping is explicit and unsupported providers fail closed', () => {
    assert.equal(reviewerPromptHostForProvider('codex'), 'codex');
    assert.equal(reviewerPromptHostForProvider('codex-cli'), 'codex');
    assert.equal(reviewerPromptHostForProvider('claude-code'), 'claude');
    assert.equal(reviewerPromptHostForProvider('claude-cli'), 'claude');
    for (const provider of ['antigravity', 'fake', 'unknown', undefined] as const) {
      assert.throws(
        () => reviewerPromptHostForProvider(provider),
        new RegExp(`unsupported session host provider "${provider ?? 'absent'}"`),
      );
    }
  });

  check('unsupported session providers cannot enter the dispatch-to-review-run-to-gate chain', () => {
    const cases = [
      { provider: 'agy', diagnostic: 'antigravity' },
      { provider: 'antigravity', diagnostic: 'antigravity' },
      { provider: 'fake', diagnostic: 'fake' },
      { provider: 'unknown', diagnostic: 'unknown' },
      { provider: undefined, diagnostic: 'absent' },
    ] as const;
    const primaryCwd = process.cwd();
    for (const testCase of cases) {
      const unsupported = makeFixture('global-thin');
      try {
        process.chdir(unsupported.root);
        withSessionProvider(testCase.provider, () => {
          const dispatch = unsupported.registry.get('dispatch');
          const start = unsupported.registry.get('review_run_start');
          assert.ok(dispatch, 'dispatch handler is registered');
          assert.ok(start, 'review_run_start handler is registered');
          assert.throws(
            () => dispatch({ storyId: STORY_ID, agentType: 'lattice-review-quality' }),
            new RegExp(`unsupported session host provider "${testCase.diagnostic}"`),
            `${testCase.provider ?? 'absent'} dispatch fails closed`,
          );
          assert.throws(
            () => start({ storyId: STORY_ID, agent: 'lattice-review-quality' }),
            /no trusted story-review dispatch binding/,
            `${testCase.provider ?? 'absent'} cannot start a review run without supported dispatch provenance`,
          );
          assert.equal(
            canPassReviewGuard({
              storyId: STORY_ID,
              store: unsupported.store,
              projectRoot: unsupported.root,
              gitCwd: unsupported.root,
            }),
            false,
            `${testCase.provider ?? 'absent'} cannot satisfy the REVIEW gate`,
          );
          assert.equal(unsupported.store.readReviewRuns(STORY_ID).runs.length, 0);
          assert.equal(unsupported.store.readPromptEnvelopes(STORY_ID).envelopes.length, 0);
        });
      } finally {
        process.chdir(primaryCwd);
        rmSync(unsupported.root, { recursive: true, force: true });
        resetConfigCache();
      }
    }
  });

  check('Codex and Claude CLI provider aliases complete the thin zero-asset review chain', () => {
    const primaryCwd = process.cwd();
    for (const selected of [
      { provider: 'codex-cli', host: 'codex' },
      { provider: 'claude-cli', host: 'claude' },
    ] as const) {
      const thin = makeFixture('global-thin');
      try {
        process.chdir(thin.root);
        assert.equal(existsSync(join(thin.root, '.lattice-codex/agents')), false);
        assert.equal(existsSync(join(thin.root, '.claude/agents')), false);
        recordReviewerPasses(thin.registry, selected.provider);
        const qualityDispatch = [...thin.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'lattice-review-quality',
        );
        assert.equal(qualityDispatch?.hostRenderHost, selected.host);
        assert.equal(
          canPassReviewGuard({
            storyId: STORY_ID,
            store: thin.store,
            projectRoot: thin.root,
            gitCwd: thin.root,
          }),
          true,
          `${selected.provider} completes dispatch, review_run_start and REVIEW gate without host assets`,
        );
      } finally {
        process.chdir(primaryCwd);
        rmSync(thin.root, { recursive: true, force: true });
        resetConfigCache();
      }
    }
  });

  check('shared binding derivation is byte-identical to the former quorum envelopes', () => {
    const vector = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS', command: 'vector' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const keyId = `quorum:${STORY_ID}:host-vector:key`;
    const actual = deriveHostVerdictBindings(vector);
    assert.equal(actual.keyId, keyId);
    assert.equal(actual.keyId, deriveCanonicalHostKeyId(STORY_ID, 'host-vector'));
    assert.equal(actual.validationDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: vector.testEvidence,
    }));
    assert.equal(actual.promptDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.prompt_digest.v1',
      purpose: 'local voluntary 3x2 review quorum after signed reviewer passes',
      storyId: STORY_ID,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
    }));
    assert.equal(HOST_VERDICT_VALIDATION_DIGEST_SCHEMA, 'lattice.quorum_submit.validation_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_DIGEST_SCHEMA, 'lattice.quorum_submit.prompt_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_PURPOSE, 'local voluntary 3x2 review quorum after signed reviewer passes');
  });

  check('shared derivation preserves optional-head and missing-evidence envelopes', () => {
    const base = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const absent = deriveHostVerdictBindings({ ...base, testEvidence: null });
    assert.equal(absent.validationDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: undefined,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
    }));
    const present = deriveHostVerdictBindings({ ...base, headHash: 'head-vector', testEvidence: { result: 'PASS' } });
    assert.notEqual(absent.validationDigest, present.validationDigest);
  });

  check('shared derivation fails closed on every required envelope field', () => {
    const valid = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    for (const field of ['storyId', 'materialDigest', 'storyFilesHash', 'hostId', 'provider', 'sessionId', 'keyId'] as const) {
      assert.throws(() => deriveHostVerdictBindings({ ...valid, [field]: ' ' }), new RegExp(field));
    }
    assert.throws(() => deriveHostVerdictBindings({ ...valid, storyId: '../not-a-story' }), /canonical storyId/);
    assert.throws(() => deriveCanonicalHostKeyId('../not-a-story', 'host-vector'), /canonical storyId/);
  });

  check('shared derivation binds every replay-sensitive input', () => {
    const base = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    const original = deriveHostVerdictBindings(base);
    for (const [field, value] of Object.entries({
      storyId: 'B-other', headHash: 'other-head', materialDigest: 'other-material',
      storyFilesHash: 'other-story-files', hostId: 'other-host', provider: 'claude',
      sessionId: 'other-session', keyId: 'other-key',
    })) {
      const changed = deriveHostVerdictBindings({ ...base, [field]: value });
      assert.ok(changed.validationDigest !== original.validationDigest || changed.promptDigest !== original.promptDigest, `${field} changes a canonical digest`);
    }
    const changedEvidence = deriveHostVerdictBindings({ ...base, testEvidence: { result: 'FAIL' } });
    assert.notEqual(changedEvidence.validationDigest, original.validationDigest);
  });

  check('refuses when required reviewer passes are absent and writes no verdicts', () => {
    assertQuorumRefuses(registry, store, root, 'absent reviewer pass refusal');
  });

  check('numerically sufficient compatibility/retired-only receipts cannot authorize quorum', () => {
    const headHash = currentGitHead(root)!;
    const materialHash = currentMaterialHash(root)!;
    const storyFilesHash = currentStoryFilesHash(root)!;
    const aliases = ['implementation-reviewer', 'test-intent', 'lattice-review-channel'];
    const runs: ReviewRun[] = aliases.map((agent, index) => {
      const run: ReviewRun = {
        reviewRunId: `${STORY_ID}:COMPAT-${index + 1}`,
        storyId: STORY_ID,
        agent,
        lane: agent,
        reviewRound: REVIEW_ROUND,
        startedAt: `2026-06-22T09:4${index}:00.000Z`,
        headHash,
        materialHash,
        storyFilesHash,
        promptHash: `compatibility-only-${index}`,
      };
      run._hash = signReviewRun(
        run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound,
        run.startedAt, run.headHash, run.materialHash, run.promptHash,
        undefined, undefined, run.storyFilesHash,
      );
      return run;
    });
    const passes: ReviewPass[] = runs.map((run, index) => {
      const pass: ReviewPass = {
        id: `${STORY_ID}:COMPAT-RP-${index + 1}`,
        agent: run.agent,
        note: 'Compatibility-only receipt must remain non-authoritative.',
        createdAt: `2026-06-22T09:5${index}:00.000Z`,
        reviewRound: REVIEW_ROUND,
        reviewRunId: run.reviewRunId,
      };
      pass._hash = signReviewPass(
        STORY_ID, pass.id, pass.agent, pass.note, pass.createdAt,
        REVIEW_ROUND, pass.reviewRunId,
      );
      return pass;
    });
    store.writeReviewRuns(STORY_ID, { runs });
    store.writeReviewPasses(STORY_ID, { passes });
    assertQuorumRefuses(registry, store, root, 'compatibility-only quorum refusal');
    const floor = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: store.readStory(STORY_ID),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: store.readProcessEvents(STORY_ID),
      materialHash,
      storyFilesHash,
    });
    assert.equal(floor.ok, false, 'rejected compatibility-only receipts cannot cross the quorum boundary into floor evidence');
    assert.equal(floor.localRounds.validRounds.length, 0, 'quorum refusal leaves no countable host-verdict round');
    assert.equal(floor.proofAdmissibility.artifactKind, 'host-verdict');
    store.writeReviewRuns(STORY_ID, { runs: [] });
    store.writeReviewPasses(STORY_ID, { passes: [] });
  });

  check('refuses when reviewer passes are stale and writes no verdicts', () => {
    recordReviewerPasses(registry);
    commitMaterialChange(root);
    assertQuorumRefuses(registry, store, root, 'stale reviewer pass refusal');
  });

  check('machine REVIEW and quorum consume the same full-envelope replay/tamper proof', () => {
    recordReviewerPasses(registry);
    const machineContext: StoryMachineContext = {
      storyId: STORY_ID,
      store,
      projectRoot: root,
      gitCwd: root,
    };
    assert.equal(canPassReviewGuard(machineContext), true, 'current canonical full-envelope evidence passes REVIEW');
    const qualityRun = [...store.readReviewRuns(STORY_ID).runs]
      .reverse()
      .find(run => run.lane === 'lattice-review-quality');
    assert.ok(qualityRun, 'quality reviewer run exists for thin host-render verification');
    assert.equal(
      verifyReviewRunPromptEnvelope(store, qualityRun).ok,
      true,
      'global-thin full-envelope dispatch and review-run verification need no project host prompt assets',
    );
    const data = store.readPromptEnvelopes(STORY_ID);
    const original = data.envelopes[0];
    assert.ok(original, 'full-envelope reviewer run persists an envelope');
    const replayed = {
      ...original,
      reviewRound: 'replayed-round',
    };
    replayed.envelopeId = computePromptEnvelopeId(replayed);
    store.writePromptEnvelopes(STORY_ID, {
      envelopes: [replayed, ...data.envelopes.slice(1)],
    });
    assert.equal(canPassReviewGuard(machineContext), false, 'machine REVIEW rejects a replayed envelope');
    assertQuorumRefuses(registry, store, root, 'quorum rejects the same replayed envelope');
    store.writePromptEnvelopes(STORY_ID, data);
    assert.equal(canPassReviewGuard(machineContext), true, 'restoring exact envelope bytes restores REVIEW evidence');
  });

  check('explicit full-asset mode binds Claude and Codex independently and rejects selected-host drift', () => {
    const primaryCwd = process.cwd();
    for (const selected of [
      {
        host: 'codex',
        provider: 'codex',
        assetPath: '.lattice-codex/agents/lattice-review-quality.md',
        otherAssetDir: '.claude/agents',
      },
      {
        host: 'claude',
        provider: 'claude-code',
        assetPath: '.claude/agents/lattice-review-quality.md',
        otherAssetDir: '.lattice-codex/agents',
      },
    ] as const) {
      const full = makeFixture('full', selected.host);
      try {
        process.chdir(full.root);
        assert.equal(existsSync(join(full.root, selected.otherAssetDir)), false, `${selected.host} fixture has no other-host assets`);
        recordReviewerPasses(full.registry, selected.provider);
        const machineContext: StoryMachineContext = {
          storyId: STORY_ID,
          store: full.store,
          projectRoot: full.root,
          gitCwd: full.root,
        };
        assert.equal(canPassReviewGuard(machineContext), true, `${selected.host}-only full-asset reviewer evidence passes`);
        const qualityRun = [...full.store.readReviewRuns(STORY_ID).runs]
          .reverse()
          .find(run => run.lane === 'lattice-review-quality');
        assert.ok(qualityRun, `${selected.host} quality reviewer run exists for full-asset drift verification`);
        const qualityDispatch = [...full.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'lattice-review-quality',
        );
        assert.equal(
          qualityDispatch?.hostRenderHost,
          selected.host,
          `dispatch provenance records the selected ${selected.host} host`,
        );
        const originalQualityAsset = readFileSync(join(full.root, selected.assetPath), 'utf8');
        write(full.root, selected.assetPath, `${originalQualityAsset}\n<!-- selected-host drift -->\n`);
        const driftedHostVerification = verifyReviewRunPromptEnvelope(full.store, qualityRun);
        assert.equal(driftedHostVerification.ok, false, `${selected.host} asset drift invalidates the bound Prompt Envelope`);
        assert.match(
          driftedHostVerification.reason ?? '',
          new RegExp(`host render identity|${selected.host} reviewer prompt asset drift`),
          `full-asset drift is rejected by the selected ${selected.host} render boundary`,
        );
        assert.equal(canPassReviewGuard(machineContext), false, `machine REVIEW rejects selected ${selected.host} asset drift`);
        write(full.root, selected.assetPath, originalQualityAsset);
        assert.equal(canPassReviewGuard(machineContext), true, `restoring exact ${selected.host} bytes restores REVIEW evidence`);
      } finally {
        process.chdir(primaryCwd);
        rmSync(full.root, { recursive: true, force: true });
        resetConfigCache();
      }
    }
  });

  let result: any;
  check('emits exactly rounds x 2 verdicts after current reviewer passes', () => {
    recordReviewerPasses(registry);
    const handler = registry.get('quorum_submit');
    assert.ok(handler, 'quorum_submit handler is registered');
    result = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke local voluntary quorum',
      format: 'json',
    });
    assert.equal(result.schemaVersion, 'lattice.quorum_submit.v1');
    assert.equal(result.emittedCount, 6);
    assert.equal(result.verdictIds.length, 6);
    assert.deepEqual(result.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]);
    assert.equal(listVerdicts(root, 'local', STORY_ID).length, 6);
  });

  check('review_escalation_status and review assurance floor report complete voluntary 3x2 rounds', () => {
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound, 2);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.complete, true);

    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'current material hash exists');
    store.appendProcessEvent(STORY_ID, {
      type: 'review_escalation_policy',
      storyId: STORY_ID,
      command: 'quorum-submit-smoke',
      timestamp: '2026-06-22T10:10:00.000Z',
      policyId: `${STORY_ID}:POL-quorum-smoke`,
      predicate: 'explicitlyConfiguredHighRiskPolicyRequires3x2',
      requires3x2: true,
      policyVersion: 'quorum-submit-smoke.v1',
      riskClass: 'process-fact',
      sourcePolicyRef: 'packages/main/src/tasks/quorum-submit-smoke.ts',
      rolloutStage: 'enforced',
      degradedFallbackAllowed: true,
      issuer: 'quorum-submit-smoke',
      issuedAt: '2026-06-22T10:10:00.000Z',
      headHash: git(root, ['rev-parse', 'HEAD']),
      materialHash,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    });
    const status = registry.get('review_escalation_status');
    assert.ok(status, 'review_escalation_status handler is registered');
    const escalation = status({ storyId: STORY_ID, json: true }) as any;
    assert.equal(escalation.required, true);
    assert.equal(escalation.ok, true);
    assert.equal(escalation.assuranceLevel, 'full-3x2');
    assert.equal(escalation.proofAdmissibility.allowed, true);
    assert.equal(escalation.proofAdmissibility.overall, 'pass');

    const assurance = evaluateReviewAssuranceFloor({
      projectRoot: root,
      storyId: STORY_ID,
      store,
      changedFiles: ['packages/main/src/core/process-fact-registry.ts'],
      materialHash,
    });
    assert.equal(assurance.localRounds.validRounds.length, 3);
    assert.equal(assurance.localRounds.requiredRounds, 3);
    assert.equal(assurance.localRounds.requiredPassingHostsPerRound, 2);
    assert.equal(assurance.localRounds.ok, true);
  });

  check('auto-computed materialDigest and storyFilesHash match current helpers', () => {
    assert.equal(result.materialDigest, currentMaterialHash(root));
    assert.equal(result.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root));
    assert.match(result.validationDigest, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostA, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostB, /^[0-9a-f]{64}$/);
  });

  check('hosts are independent by hostId, sessionId, and keyId', () => {
    const { hostA, hostB } = result.hosts;
    assert.notEqual(hostA.hostId.toLowerCase(), hostB.hostId.toLowerCase());
    assert.notEqual(hostA.sessionId.toLowerCase(), hostB.sessionId.toLowerCase());
    assert.notEqual(hostA.keyId.toLowerCase(), hostB.keyId.toLowerCase());
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
      assert.equal(summary.duplicateVerdicts, 0);
    }
  });

  check('never sets authorityDone, fullAuthorityDone, or productionDone', () => {
    assert.equal(result.authorityDone, false);
    assert.equal(result.fullAuthorityDone, false);
    assert.equal(result.productionDone, false);
    assert.equal(result.reviewEscalationStatus.authorityDone, false);
    assert.equal(result.reviewEscalationStatus.fullAuthorityDone, false);
    assert.equal(result.reviewEscalationStatus.productionDone, false);
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.authorityDone, false);
      assert.equal(summary.fullAuthorityDone, false);
      assert.equal(summary.multiHostVerified, false);
    }
  });

  check('refuses a same-material re-submit and writes no new verdicts', () => {
    // No material change since the rounds=3 quorum above, so runIds r1..r3 already carry
    // verdicts at the current materialDigest. A second quorum_submit must refuse instead of
    // silently piling duplicate verdicts onto the same runIds.
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'claude-host',
        hostB: 'codex-host',
        rounds: 3,
        providerA: 'claude',
        providerB: 'codex',
        note: 'quorum_submit smoke same-material re-submit',
        format: 'json',
      }),
      /quorum_submit refuses: verdicts already exist for runId/,
      'same-material re-submit is refused',
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents, 'same-material refusal writes no host_verdict events');
    assert.equal(verdictFileCount(root), beforeVerdicts, 'same-material refusal writes no verdict files');
  });

  check('allows a fresh quorum after a material change', () => {
    // A real material change (new commit) yields a different materialDigest, so the guard
    // does not collide and a fresh quorum is allowed for the same runIds.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const freshResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke fresh-material re-quorum',
      format: 'json',
    });
    assert.equal(freshResult.emittedCount, 6, 'fresh-material re-quorum emits rounds x 2 verdicts');
    assert.equal(verdictFileCount(root) - beforeVerdicts, 6, 'fresh-material re-quorum writes new verdict files');
    for (const runId of freshResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2, {
        currentAnchor: { materialDigest: freshResult.materialDigest },
      });
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
  });

  check('--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds', () => {
    // INIT product-reviewer advisory: prove the rounds knob is honored for N != 3.
    // Advance the material first so the rounds=2 quorum runs at a fresh materialDigest and
    // does not collide with the r1/r2 verdicts already written at earlier materials.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const customRounds = 2;
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const customResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: customRounds,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke custom-rounds quorum',
      format: 'json',
    });
    assert.equal(customResult.rounds, customRounds, '--rounds=N is reflected in result.rounds');
    assert.equal(customResult.emittedCount, customRounds * 2, '--rounds=N emits N x 2 verdicts');
    assert.equal(customResult.verdictIds.length, customRounds * 2);
    assert.deepEqual(customResult.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`]);
    // exactly N x 2 new host_verdict events and verdict files were added by this call.
    assert.equal(hostVerdictEventCount(store) - beforeEvents, customRounds * 2, '--rounds=N writes N x 2 host_verdict events');
    assert.equal(verdictFileCount(root) - beforeVerdicts, customRounds * 2, '--rounds=N writes N x 2 verdict files');
    for (const runId of customResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
    assert.equal(customResult.authorityDone, false);
    assert.equal(customResult.fullAuthorityDone, false);
    assert.equal(customResult.productionDone, false);
  });

  check('rejects non-independent host identity before writing additional verdicts', () => {
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'same-host',
        hostB: 'different-host',
        sessionA: 'shared-session',
        sessionB: 'shared-session',
        format: 'json',
      }),
      /hostA and hostB must be independent/,
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents);
    assert.equal(verdictFileCount(root), beforeVerdicts);
  });

  console.log(`\n✓ quorum_submit smoke passed (${passed} checks)`);
} finally {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}
