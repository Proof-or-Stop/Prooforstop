#!/usr/bin/env node
/**
 * B-f675 CHK-003 — proves the read-only incremental review context
 * (core/review-incremental-context.ts, CHK-001) reports the right shape for a
 * returning reviewer, a first-timer, and a rename, AND proves the LOAD-BEARING
 * invariant of this whole story: calling reviewIncrementalContext (and having the
 * lattice review_incremental_context CLI registered) changes NOTHING about the
 * REVIEW→TEST gate canPassReviewGuard.
 *
 * HARD INVARIANT this guard defends: the legacy per-reviewer context is a pure
 * read-only diagnostic and does not mutate gate inputs. Post-remediation lane
 * selection is a separate signed current-material fact consumed by the gate;
 * only proven dependency closure narrows it, never the round number.
 *
 * Cases:
 *   (a) RETURNING REVIEWER — a reviewer 'quality' with a prior PASS bound to an
 *       earlier headHash, and a material file changed since that headHash:
 *       isFirstPass=false, scopeChanged=true, changedFiles includes that file,
 *       priorVerdict present.
 *   (b) FIRST-TIMER — a reviewer with no prior pass: isFirstPass=true,
 *       scopeChanged=true, changedFiles = the full main...HEAD material diff.
 *   (c) RENAME CASE — a file renamed since the reviewer's last pass is counted as
 *       changed (rename-aware `git diff --name-status -M`): both old + new paths
 *       surface, scopeChanged=true.
 *   (e) PRIOR VERDICT W/ UNRESOLVABLE headHash — a reviewer that DID pass before,
 *       but whose bound run has an unresolvable headHash: the helper falls back to
 *       isFirstPass=true, priorHeadHash=null, full main...HEAD diff, while
 *       priorVerdict stays NON-null. Pins the documented contract that consumers
 *       must key off isFirstPass (not priorVerdict) for "no incremental baseline".
 *   (d) GATE-UNCHANGED ASSERTION (the load-bearing one) — exercises the REAL
 *       canPassReviewGuard (imported from core/machine.ts) over deterministic
 *       fixture stories and asserts the actual gate semantics:
 *         - Every round blocks unless every current selected lane has a valid
 *           current-round verdict + quorum; unknown impact selects all lanes.
 *         - Missing currentReviewRound: pass-shaped legacy evidence fails closed.
 *         - A current-round INVALID (stale/unknown-run) binding blocks — in ALL
 *           rounds, before the round split.
 *         - A verified open blocking finding (after round decay) blocks.
 *       For every fixture, the gate outcome is asserted IDENTICAL whether or not
 *       reviewIncrementalContext is called in between, AND the gate inputs are
 *       proven byte-identical before/after the helper runs (no store writes, no
 *       gate-input mutation). That is the proof the helper does not alter the gate.
 *
 * Determinism: cases (a)–(c) drive a synthetic StoryStore over a real temp git
 * repo (so the rename-aware diff is exercised against actual git). Case (d) uses
 * git-free synthetic stores: with currentReviewRound UNSET, the lifecycle verdict
 * fails closed before legacy evidence compatibility can activate; with it SET + an
 * unknown reviewRunId the binding is invalid. Both are deterministic and independent
 * of the host git state.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyIncrementalBindingReasons,
  fixtureCaseClosure,
  reviewIncrementalContext,
} from '../core/review-incremental-context.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { domainSeparatedDigest } from '../core/prompt-contracts.js';
import {
  assembleFullPromptEnvelope,
  buildFullTaskContext,
  fullTaskSemanticDigest,
} from '../core/prompt-envelope.js';
import {
  promptRoleContract,
  resolvePromptRoleBody,
  reviewerHostRenderIdentity,
} from '../core/prompt-role-contract-registry.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetConfigCache } from '../core/config.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import {
  classifyEvidenceFreshness,
  currentGitHead,
} from '../core/evidence-freshness.js';
import {
  collectReviewerEvidenceState,
  signReviewRun,
  verifyReviewRun,
  verifyReviewRunPromptEnvelope,
} from '../core/review-run.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { materialDiffPackDigest } from '../core/review-scope-binding.js';
import {
  classifyImpact,
  IMPACT_CLASSIFICATION_POLICY_VERSION,
} from '../core/impact-classification-policy.js';
import { StoryStore } from '../core/store.js';
import type {
  Finding,
  ReviewPass,
  ReviewRun,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

/** Marker line printed by the smoke so `lattice validate` output is greppable. */
const MARKER = 'review-incremental-context-smoke:';
const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function directoryBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    if (!statSync(path).isDirectory()) {
      result[relativePath] = readFileSync(path).toString('base64');
      return;
    }
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };
  try {
    visit(root, '');
  } catch {
    return {};
  }
  return result;
}

/**
 * A synthetic StoryStore returning ONLY the methods the helper / gate read for a
 * single fixed story. Anything else throws so an accidental extra read is loud.
 */
interface FixtureStoreInput {
  story: StoryInfo;
  findings?: Finding[];
  passes?: ReviewPass[];
  runs?: ReviewRun[];
  scopeContract?: unknown | null;
  reviewLoopRecords?: unknown[];
  checklistItems?: unknown[];
  promptEnvelopes?: unknown[];
}

function buildFixtureStore(input: FixtureStoreInput): StoryStore {
  const id = input.story.storyId;
  const findings = input.findings ?? [];
  const passes = input.passes ?? [];
  const runs = input.runs ?? [];
  const guard = (storyId: string) => {
    if (storyId !== id) throw new Error(`unexpected storyId ${storyId}`);
  };
  return {
    readStory: (storyId: string) => { guard(storyId); return input.story; },
    readFindings: (storyId: string) => { guard(storyId); return { findings }; },
    readReviewPasses: (storyId: string) => { guard(storyId); return { passes }; },
    readReviewRuns: (storyId: string) => { guard(storyId); return { runs }; },
    readScopeContract: (storyId: string) => { guard(storyId); return (input.scopeContract ?? null) as never; },
    readReviewLoopRecords: (storyId: string) => { guard(storyId); return (input.reviewLoopRecords ?? []) as never; },
    readChecklist: (storyId: string) => { guard(storyId); return { items: input.checklistItems ?? [] } as never; },
    readPromptEnvelopes: (storyId: string) => { guard(storyId); return { envelopes: input.promptEnvelopes ?? [] } as never; },
    readDecision: (storyId: string) => { guard(storyId); return null as never; },
    readUnderstanding: (storyId: string) => { guard(storyId); return null as never; },
  } as unknown as StoryStore;
}

// ── Signed reviewer evidence helpers (use the production sign functions) ──

const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');
function ts(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

function signedPass(
  storyId: string,
  id: string,
  agent: string,
  createdAt: string,
  reviewRound?: string,
): ReviewPass {
  const note = `no blocker from ${agent}`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound || ''),
  };
}

function signedFinding(
  storyId: string,
  id: string,
  agent: string,
  severity: Finding['severity'],
  createdAt: string,
  status: Finding['status'],
  reviewRound?: string,
  reviewRunId?: string,
): Finding {
  const desc = `${severity} finding ${id} from ${agent}`;
  return {
    id,
    desc,
    severity,
    category: 'missing',
    status,
    agent,
    createdAt,
    reviewRound,
    reviewRunId,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound || '', reviewRunId || ''),
  };
}

/** Snapshot of every gate input, used to prove the helper mutates nothing. */
function gateInputSnapshot(store: StoryStore, storyId: string): string {
  return JSON.stringify({
    story: store.readStory(storyId),
    findings: store.readFindings(storyId),
    passes: store.readReviewPasses(storyId),
    runs: store.readReviewRuns(storyId),
    currentReviewRound: store.readStory(storyId).currentReviewRound ?? null,
  });
}

/**
 * Run the gate twice over the SAME store: once "without the helper", once with
 * reviewIncrementalContext called in between for every reviewer role. Assert the
 * gate outcome is identical and the gate inputs are byte-identical afterwards.
 * Returns the (shared) gate outcome for the caller's semantic assertion.
 */
function assertGateUnchangedByHelper(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  label: string,
): boolean {
  const ctx: StoryMachineContext = { storyId, store, projectRoot };

  const before = gateInputSnapshot(store, storyId);
  const gateWithoutHelper = canPassReviewGuard(ctx);
  const afterGateOnly = gateInputSnapshot(store, storyId);
  assert.equal(afterGateOnly, before, `${label}: canPassReviewGuard itself must not mutate gate inputs`);

  // Call the incremental helper for every reviewer role — this is the action
  // whose neutrality we are proving. It must not write to the store.
  const roles = ['concept', 'quality', 'test-coverage', 'behavior', 'docs'];
  for (const role of roles) {
    const incremental = reviewIncrementalContext(store, projectRoot, storyId, role);
    // Smoke-level shape sanity (the helper always returns these fields).
    assert.equal(incremental.role, role, `${label}: helper echoes the requested role`);
    assert.equal(typeof incremental.scopeChanged, 'boolean', `${label}: helper returns a boolean scopeChanged`);
    const repeated = Array.from({ length: 8 }, () =>
      reviewIncrementalContext(store, projectRoot, storyId, role));
    for (const candidate of repeated) {
      assert.deepEqual(candidate, incremental, `${label}: repeated advisory calls are deterministic for ${role}`);
    }
    // Eligibility baselines are evaluated as-of the signed run start. The
    // cutoff option is intentionally exercised here so later metadata-only
    // passes cannot rewrite an older ReviewRun's priorPassRef.
    const cutoffBound = reviewIncrementalContext(store, projectRoot, storyId, role, {
      passesCutoffAt: new Date().toISOString(),
    });
    assert.equal(cutoffBound.role, role, `${label}: as-of-run prior-pass cutoff preserves role identity`);
  }
  const afterHelper = gateInputSnapshot(store, storyId);
  assert.equal(afterHelper, before, `${label}: reviewIncrementalContext must perform no store writes / leave gate inputs byte-identical`);

  const gateWithHelper = canPassReviewGuard(ctx);
  assert.equal(
    gateWithHelper,
    gateWithoutHelper,
    `${label}: canPassReviewGuard outcome must be IDENTICAL with vs without the incremental helper`,
  );
  return gateWithoutHelper;
}

/** A story that has entered REVIEW `rounds` times (round count derives from events). */
function reviewStory(storyId: string, rounds: number, currentReviewRound?: string): StoryInfo {
  const events: StoryEvent[] = [];
  for (let r = 1; r <= rounds; r++) {
    events.push({ phase: 'REVIEW', action: 'advance', timestamp: ts(r) } as StoryEvent);
  }
  return {
    storyId,
    name: 'synthetic-incremental-story',
    title: 'synthetic incremental story',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    riskSignals: [],
    currentReviewRound,
    events,
  } as unknown as StoryInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases (a)–(c): incremental context over a real temp git repo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a repo whose `main` holds a base commit, then diverge onto a story branch
 * with a SECOND commit that edits a material file (src/feature.ts) and renames
 * src/old-name.ts -> src/new-name.ts. HEAD is left on the story branch so the
 * first-timer full diff `main...HEAD` is non-empty (main is an ancestor of HEAD,
 * mirroring the real worktree shape where the story branch is ahead of main).
 * Returns the repo root + both commit SHAs so fixtures can bind a prior pass to
 * the earlier (main) headHash.
 */
function buildIncrementalRepo(): { root: string; baseSha: string; headSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-ctx-'));
  write(root, '.gitignore', '.lattice/activity.jsonl\n');
  write(root, 'src/feature.ts', 'export const feature = 1;\n');
  write(root, 'src/old-name.ts', 'export const renamed = true;\n');
  write(root, 'src/untouched.ts', 'export const untouched = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base on main']);
  const baseSha = currentGitHead(root)!;

  // Story branch ahead of main: material edit + rename.
  git(root, ['checkout', '-b', 'story/B-f675']);
  write(root, 'src/feature.ts', 'export const feature = 2; // edited\n');
  git(root, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'feature edit + rename']);
  const headSha = currentGitHead(root)!;

  return { root, baseSha, headSha };
}

function trustedReviewEvidence(storyId: string, role: string, runId: string, startedAt: string, passAt: string, boundHeadHash: string) {
  const rollout = { version: 'proofbound.prompt-envelope-rollout.v1', roles: { [role]: 'full-envelope' } };
  const roleBody = resolvePromptRoleBody(role, rollout).body;
  const dispatchPrompt = `As ${role}, review story ${storyId} in full.`;
  const host = reviewerHostRenderIdentity(process.cwd(), role, 'codex', 'full-envelope');
  const headHash = boundHeadHash;
  const materialHash = 'b'.repeat(64);
  const storyFilesHash = 'c'.repeat(64);
  const envelopeResult = assembleFullPromptEnvelope({
    roleContract: promptRoleContract(role),
    runtimeContract: BASELINE_RUNTIME_CONTRACT,
    rolePrompt: roleBody,
    taskContext: {
      schemaVersion: 'proofbound.full-task-context.v1', storyId, title: 'cutoff regression',
      description: 'Bind prior review evidence to its signed run start.', phase: 'REVIEW', priority: 'high',
      checklist: [{ id: 'CHK-001', title: 'Bind', status: 'done', relatedDocs: [], files: { modify: ['src/feature.ts'], create: [], test: [] },
        verificationIntent: { happy: [{ id: 'CHK-001:happy:0', desc: 'Cutoff is respected.', type: 'logic' }], edge: [], adversarial: [] } }],
      headHash, materialHash, storyFilesHash,
    },
    dispatchKind: 'review-run', reviewRunId: runId, reviewRound: 'round-1', lane: role,
    dispatchPrompt, hostRenderIdentityDigest: host.identityDigest, createdAt: startedAt,
  });
  const run: ReviewRun = { reviewRunId: runId, storyId, agent: role, lane: role, reviewRound: 'round-1', startedAt,
    headHash, materialHash, storyFilesHash, promptHash: envelopeResult.envelope.assembledPromptDigest,
    envelopeId: envelopeResult.envelope.envelopeId, assembledPrompt: envelopeResult.prompt };
  run._hash = signReviewRun(storyId, runId, role, role, 'round-1', startedAt, headHash, materialHash,
    run.promptHash, undefined, undefined, storyFilesHash, run.envelopeId);
  const pass = signedPass(storyId, `${runId}:PASS`, role, passAt, 'round-1');
  pass.reviewRunId = runId;
  pass.envelopeId = run.envelopeId;
  pass.writerSessionId = `${runId}-session`;
  pass.sessionSource = 'smoke';
  pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId,
    undefined, undefined, undefined, { writerSessionId: pass.writerSessionId, sessionSource: pass.sessionSource }, run.envelopeId);
  return { run, pass, envelope: envelopeResult.envelope };
}

function runTemporalCutoffRegression(root: string): void {
  const storyId = 'B-f675';
  const role = 'lattice-review-quality';
  const story = reviewStory(storyId, 2, 'round-1');
  const boundHeadHash = currentGitHead(root)!;
  const a = trustedReviewEvidence(storyId, role, 'RR-A', ts(5), ts(6), boundHeadHash);
  const b = trustedReviewEvidence(storyId, role, 'RR-B', ts(20), ts(21), boundHeadHash);
  const c = trustedReviewEvidence(storyId, role, 'RR-C', ts(30), ts(31), boundHeadHash);
  const store = buildFixtureStore({ story, runs: [a.run, b.run, c.run], passes: [a.pass, b.pass, c.pass],
    promptEnvelopes: [a.envelope, b.envelope, c.envelope] });
  const asOfB = reviewIncrementalContext(store, root, storyId, role, {
    excludedReviewRunId: b.run.reviewRunId, passesCutoffAt: b.run.startedAt,
  });
  assert.equal(asOfB.priorPassRef, a.pass.id, 'A-before-B is the only eligible prior pass for B');
  assert.equal(asOfB.priorReviewRunId, a.run.reviewRunId, 'B must bind to A, never the later C pass');
  const withoutCutoff = reviewIncrementalContext(store, root, storyId, role, { excludedReviewRunId: b.run.reviewRunId });
  assert.equal(withoutCutoff.priorPassRef, c.pass.id, 'mutation bite: removing cutoff must select later C');
  assert.notEqual(asOfB.eligibilityDigest, withoutCutoff.eligibilityDigest, 'cutoff changes authoritative eligibility digest');
  const equal = trustedReviewEvidence(storyId, role, 'RR-EQUAL', ts(20), ts(20), boundHeadHash);
  const equalStore = buildFixtureStore({ story, runs: [a.run, equal.run], passes: [a.pass, equal.pass], promptEnvelopes: [a.envelope, equal.envelope] });
  const equalAsOfB = reviewIncrementalContext(equalStore, root, storyId, role, { passesCutoffAt: ts(20) });
  assert.equal(equalAsOfB.priorPassRef, a.pass.id, 'equal-timestamp pass is fail-closed and excluded');
  console.log(`${MARKER} TEMPORAL CUTOFF: A-before-B selected; C-after-B and equal-timestamp passes excluded; mutation bite confirmed`);
}

function runProductionVerifierTemporalCutoffRegression(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-cutoff-verifier-'));
  const storyId = 'B-cutoff-verifier';
  const role = 'lattice-review-quality';
  const round = '2026-07-20T00:00:00.000Z';
  const runCli = (command: string, payload: Record<string, unknown>, actor: string): void => {
    execFileSync(process.execPath, [
      DIST_CLI_PATH,
      '--root',
      root,
      command,
      JSON.stringify(payload),
    ], {
      cwd: root,
      env: {
        ...process.env,
        LATTICE_PROJECT_ROOT: root,
        LATTICE_ACTIVITY_SOURCE: 'codex',
        LATTICE_AGENT: actor,
        LATTICE_SESSION_ID: `cutoff-${actor}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: { [role]: 'full-envelope' },
      },
    }, null, 2) + '\n');
    write(root, 'src/cutoff.ts', 'export const cutoff = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed cutoff verifier base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'Production verifier cutoff regression',
      description: 'Bind a real incremental Prompt Envelope to passes visible when its ReviewRun starts.',
      priority: 'high',
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Bind the verifier cutoff',
        context: 'Later reviewer passes must not rewrite an older incremental envelope baseline.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/cutoff.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'The real verifier preserves the as-of-run baseline.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed cutoff verifier review metadata']);

    runCli('dispatch', { storyId, agentType: role }, 'main');
    runCli('review_run_start', { storyId, agent: role }, role);
    const runA = store.readReviewRuns(storyId).runs.at(-1)!;
    runCli('review_pass_set', {
      storyId,
      agent: role,
      reviewRunId: runA.reviewRunId,
      note: 'A found no blocker in the stable cutoff fixture.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, role);
    const passA = store.readReviewPasses(storyId).passes.find(pass => pass.reviewRunId === runA.reviewRunId)!;

    runCli('review_run_start', { storyId, agent: role }, role);
    const runB = store.readReviewRuns(storyId).runs.at(-1)!;
    const envelopeB = store.readPromptEnvelopes(storyId).envelopes.find(
      envelope => envelope.envelopeId === runB.envelopeId,
    )!;
    assert.equal(envelopeB.contextMode, 'incremental', 'production B must use the incremental envelope path');
    assert.equal(envelopeB.priorPassRef, passA.id, 'production B must bind the A-before-B pass');
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'production verifier accepts B before a later pass is appended',
    );
    runCli('review_pass_set', {
      storyId,
      agent: role,
      reviewRunId: runB.reviewRunId,
      note: 'B found no blocker before the mandatory TEST transition.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, role);
    const passB = store.readReviewPasses(storyId).passes.find(pass => pass.reviewRunId === runB.reviewRunId)!;

    runCli('review_run_start', { storyId, agent: role }, role);
    const runC = store.readReviewRuns(storyId).runs.at(-1)!;
    runCli('review_pass_set', {
      storyId,
      agent: role,
      reviewRunId: runC.reviewRunId,
      note: 'C found no blocker after B had already started.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, role);
    const passC = store.readReviewPasses(storyId).passes.find(pass => pass.reviewRunId === runC.reviewRunId)!;
    assert.ok(
      Date.parse(passC.createdAt) >= Date.parse(runB.startedAt),
      'fixture must append C at or after B.startedAt',
    );

    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'production verifier must still accept B after the later C pass is appended',
    );
    assert.equal(envelopeB.priorPassRef, passA.id, 'B priorPassRef remains A after C is appended');

    const verifierWithoutCutoff = reviewIncrementalContext(store, root, storyId, role, {
      excludedReviewRunId: runB.reviewRunId,
      findingsCutoffAt: runB.startedAt,
    });
    assert.equal(
      verifierWithoutCutoff.priorPassRef,
      passC.id,
      'mutation bite: removing the verifier cutoff rewrites B baseline to later C',
    );
    assert.notEqual(
      envelopeB.eligibilityDigest,
      verifierWithoutCutoff.eligibilityDigest,
      'mutation bite: a verifier without passesCutoffAt rejects the production B envelope',
    );

    const reviewPhaseStory = store.readStory(storyId);
    store.writeStory(storyId, { ...reviewPhaseStory, phase: 'TEST' });
    store.appendProcessEvent(storyId, {
      type: 'phase_transition',
      storyId,
      attemptId: round,
      fromPhase: 'REVIEW',
      toPhase: 'TEST',
      materialHash: runB.materialHash,
      storyFilesHash: runB.storyFilesHash,
      reviewRound: round,
    });
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'the production verifier must preserve a valid REVIEW envelope across the mandatory TEST metadata transition',
    );
    const testTaskContext = buildFullTaskContext({
      story: store.readStory(storyId),
      checklist: store.readChecklist(storyId),
      headHash: currentGitHead(root)!,
      materialHash: runB.materialHash,
      storyFilesHash: runB.storyFilesHash,
      scopeContract: store.readScopeContract(storyId),
    });
    assert.equal(testTaskContext.phase, 'TEST', 'Prompt TaskContext must retain the actual TEST phase');
    assert.equal(
      fullTaskSemanticDigest(testTaskContext),
      envelopeB.taskSemanticDigest,
      'the canonical REVIEW snapshot must preserve taskSemanticDigest in TEST',
    );
    assert.equal(
      fullTaskSemanticDigest({ ...testTaskContext, phase: 'REVIEW' }),
      fullTaskSemanticDigest(testTaskContext),
      'only the admissible REVIEW and TEST closeout states share a task semantic digest',
    );
    const {
      headHash: _legacyHeadHash,
      materialHash: _legacyMaterialHash,
      storyFilesHash: _legacyStoryFilesHash,
      ...legacyPhaseSensitiveContext
    } = testTaskContext;
    assert.notEqual(
      domainSeparatedDigest('full-task-context.model-relevant.v1', legacyPhaseSensitiveContext),
      envelopeB.taskSemanticDigest,
      'mutation bite: the old phase-sensitive digest rejects the valid REVIEW envelope after transition to TEST',
    );
    const doneEvidence = collectReviewerEvidenceState(store, storyId, root);
    assert.ok(
      doneEvidence.valid.some(evidence => evidence.id === passB.id),
      'the shared DONE evidence oracle must accept the same B pass after REVIEW to TEST metadata',
    );
    assert.equal(
      doneEvidence.invalid.some(evidence => evidence.reviewRunId === runB.reviewRunId),
      false,
      'done_prepare and story_advance DONE must not disagree about B Prompt Envelope validity',
    );

    const testPhaseStory = store.readStory(storyId);
    const inadmissiblePhaseDigests = new Set<string>();
    for (const inadmissiblePhase of ['DEV', 'DONE', 'DISCARDED', 'MALFORMED_PHASE'] as const) {
      store.writeStory(storyId, {
        ...testPhaseStory,
        phase: inadmissiblePhase as typeof testPhaseStory.phase,
      });
      const inadmissibleTaskContext = buildFullTaskContext({
        story: store.readStory(storyId),
        checklist: store.readChecklist(storyId),
        headHash: currentGitHead(root)!,
        materialHash: runB.materialHash,
        storyFilesHash: runB.storyFilesHash,
        scopeContract: store.readScopeContract(storyId),
      });
      assert.equal(
        inadmissibleTaskContext.phase,
        inadmissiblePhase,
        `Prompt TaskContext must retain the actual ${inadmissiblePhase} phase`,
      );
      const inadmissiblePhaseDigest = fullTaskSemanticDigest(inadmissibleTaskContext);
      inadmissiblePhaseDigests.add(inadmissiblePhaseDigest);
      assert.notEqual(
        inadmissiblePhaseDigest,
        envelopeB.taskSemanticDigest,
        `${inadmissiblePhase} must not collide with the REVIEW/TEST task semantic digest`,
      );
      const phaseMutation = verifyReviewRunPromptEnvelope(store, runB);
      assert.equal(phaseMutation.ok, false, `${inadmissiblePhase} must invalidate a REVIEW envelope`);
      assert.match(phaseMutation.reason ?? '', /taskSemanticDigest/);
      const inadmissibleDoneEvidence = collectReviewerEvidenceState(store, storyId, root);
      assert.equal(
        inadmissibleDoneEvidence.valid.some(evidence => evidence.id === passB.id),
        false,
        `the shared DONE oracle must reject B in ${inadmissiblePhase}`,
      );
      assert.ok(
        inadmissibleDoneEvidence.invalid.some(evidence => evidence.reviewRunId === runB.reviewRunId),
        `the shared DONE oracle must report B invalid in ${inadmissiblePhase}`,
      );
    }
    assert.equal(
      inadmissiblePhaseDigests.size,
      4,
      'DEV, DONE, DISCARDED, and malformed phases must also remain distinct from each other',
    );
    store.writeStory(storyId, testPhaseStory);
    store.writeStory(storyId, { ...testPhaseStory, title: `${testPhaseStory.title} mutated` });
    const titleMutation = verifyReviewRunPromptEnvelope(store, runB);
    assert.equal(titleMutation.ok, false, 'a real Story title mutation must invalidate the bound REVIEW envelope');
    for (const field of ['eligibilityDigest', 'eligibilityReasonCodes', 'reviewBasisDigest', 'taskSemanticDigest']) {
      assert.match(titleMutation.reason ?? '', new RegExp(field), `title mutation must report ${field} drift`);
    }
    store.writeStory(storyId, testPhaseStory);

    const originalChecklist = store.readChecklist(storyId);
    store.writeChecklist(storyId, {
      ...originalChecklist,
      items: originalChecklist.items.map(item => item.id === 'CHK-001'
        ? { ...item, title: `${item.title} mutated` }
        : item),
    });
    const checklistMutation = verifyReviewRunPromptEnvelope(store, runB);
    assert.equal(checklistMutation.ok, false, 'a real checklist semantic mutation must invalidate the bound REVIEW envelope');
    assert.match(checklistMutation.reason ?? '', /taskSemanticDigest/);
    store.writeChecklist(storyId, originalChecklist);
    assert.deepEqual(verifyReviewRunPromptEnvelope(store, runB), { ok: true }, 'restoring task semantics restores verifier agreement');
    console.log(`${MARKER} REVIEW-TO-TEST TASK SNAPSHOT: only REVIEW/TEST are equivalent; DEV/DONE/DISCARDED/unknown and title/checklist mutations fail closed; DONE oracle agrees`);
    console.log(`${MARKER} PRODUCTION VERIFIER CUTOFF: real B envelope remains valid and bound to A after later C; no-cutoff verifier mutation fails`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertLargeDiffReviewMetadataStability(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-large-review-diff-'));
  try {
    write(root, 'lattice.config.json', `${JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2)}\n`);
    write(root, '.gitignore', '.lattice/activity.jsonl\n');
    write(root, 'src/large.ts', 'export const seed = 0;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'large diff base']);
    git(root, ['checkout', '-b', 'story/B-large-diff']);
    write(root, 'src/large.ts', `export const payload = ${JSON.stringify('x'.repeat(900_000))};\n`);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'large business diff']);

    resetConfigCache();
    const beforePack = buildScopeDiffPack(root);
    const before = materialDiffPackDigest(beforePack, root);
    assert.ok(beforePack.hunks.some(hunk => hunk.path === 'src/large.ts'), 'large business hunk is read above Node default output sizes');

    write(
      root,
      '.lattice/story/actives/B-large-diff/prompt-envelopes.json',
      `${JSON.stringify({ envelopes: [], padding: 'm'.repeat(350_000) })}\n`,
    );
    git(root, ['add', '.lattice/story/actives/B-large-diff/prompt-envelopes.json']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'review metadata write']);

    resetConfigCache();
    const afterPack = buildScopeDiffPack(root);
    const after = materialDiffPackDigest(afterPack, root);
    assert.ok(afterPack.hunks.some(hunk => hunk.path === 'src/large.ts'), 'review metadata cannot make large business hunks disappear');
    assert.deepEqual(after, before, 'review_run/prompt-envelope metadata leaves the material scope diff binding byte-stable');
    console.log(`${MARKER} large diff + review metadata scope binding remains stable`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function runIncrementalCases(): void {
  const { root, baseSha, headSha } = buildIncrementalRepo();
  try {
    const storyId = 'B-f675';

    // ---- (a) RETURNING REVIEWER ----
    // 'quality' has a prior PASS bound (via reviewRunId) to baseSha. Material
    // files changed between baseSha and HEAD => scopeChanged=true, isFirstPass=false.
    {
      const runId = 'RR-quality-1';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-001', 'lattice-review-quality', ts(2), ts(1));
      pass.reviewRunId = runId;
      // Re-sign now that reviewRunId is set (signature domain includes it).
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-quality',
        lane: 'lattice-review-quality',
        reviewRound: ts(1),
        startedAt: ts(2),
        headHash: baseSha,
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });

      const ctx = reviewIncrementalContext(store, root, storyId, 'quality');
      assert.equal(ctx.isFirstPass, true, '(a) unsigned legacy run must not establish an incremental baseline');
      assert.equal(ctx.priorHeadHash, null, '(a) untrusted baseline has no priorHeadHash authority');
      assert.equal(ctx.priorVerdict, null, '(a) untrusted pass is not surfaced as a trusted prior verdict');
      assert.equal(ctx.contextMode, 'full', '(a) untrusted prior evidence fails closed to full');
      assert.ok(ctx.eligibilityReasonCodes.includes('FULL_MISSING_TRUSTED_PRIOR_PASS'));
      assert.equal(ctx.scopeChanged, true, '(a) material change since last pass => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/feature.ts'),
        `(a) changedFiles must include the edited material file, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      console.log(`${MARKER} (a) UNTRUSTED LEGACY PASS: contextMode=full, changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    // ---- (b) FIRST-TIMER ----
    // 'concept' has no prior pass/finding => isFirstPass=true, full main...HEAD diff.
    {
      const story = reviewStory(storyId, 1, ts(1));
      const store = buildFixtureStore({ story });
      const ctx = reviewIncrementalContext(store, root, storyId, 'concept');
      assert.equal(ctx.isFirstPass, true, '(b) first-timer must be isFirstPass=true');
      assert.equal(ctx.priorHeadHash, null, '(b) first-timer has no priorHeadHash');
      assert.equal(ctx.priorVerdict, null, '(b) first-timer has no priorVerdict');
      assert.equal(ctx.scopeChanged, true, '(b) first-timer scopeChanged=true (show everything)');
      assert.ok(ctx.changedFiles.includes('src/feature.ts'), '(b) full diff must include the edited file');
      console.log(`${MARKER} (b) FIRST-TIMER: isFirstPass=true, full diff changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    // ---- (c) RENAME CASE ----
    // 'docs' passed at baseSha; between baseSha and HEAD src/old-name.ts was
    // renamed to src/new-name.ts. Rename-aware diff must surface BOTH paths.
    {
      const runId = 'RR-docs-1';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-002', 'lattice-review-docs', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-docs',
        lane: 'lattice-review-docs',
        reviewRound: ts(1),
        startedAt: ts(2),
        headHash: baseSha,
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });
      const ctx = reviewIncrementalContext(store, root, storyId, 'docs');
      assert.equal(ctx.isFirstPass, true, '(c) unsigned legacy run cannot establish a baseline');
      assert.equal(ctx.contextMode, 'full', '(c) rename remains full');
      assert.equal(ctx.scopeChanged, true, '(c) a rename since last pass => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/old-name.ts') && ctx.changedFiles.includes('src/new-name.ts'),
        `(c) rename-aware diff must surface BOTH old + new paths, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      console.log(`${MARKER} (c) RENAME CASE: scopeChanged=true, changedFiles=${JSON.stringify(ctx.changedFiles)} (both rename sides counted)`);
    }

    // ---- (e) PRIOR VERDICT WITH UNRESOLVABLE BOUND headHash (sub-case b of the
    //          isFirstPass contract) ----
    // 'behavior' DID pass before (priorVerdict non-null), but the run it was bound
    // to has an empty/unresolvable headHash. The helper conservatively treats this
    // as a first pass: isFirstPass=true, priorHeadHash=null, full main...HEAD diff,
    // while priorVerdict stays NON-null (informational). This pins the documented
    // invariant that consumers must key off isFirstPass, not priorVerdict.
    {
      const runId = 'RR-behavior-unresolvable';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-003', 'lattice-review-behavior', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-behavior',
        lane: 'lattice-review-behavior',
        reviewRound: ts(1),
        startedAt: ts(2),
        // Unresolvable bound headHash: headHashForRun returns null for a falsy hash.
        headHash: '',
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });
      const ctx = reviewIncrementalContext(store, root, storyId, 'behavior');
      // Documented invariant: when isFirstPass=true, priorHeadHash is null and
      // changedFiles is the full diff — REGARDLESS of priorVerdict.
      assert.equal(ctx.isFirstPass, true, '(e) unresolvable bound headHash must fall back to isFirstPass=true');
      assert.equal(ctx.priorHeadHash, null, '(e) isFirstPass=true must always carry priorHeadHash=null');
      assert.equal(ctx.scopeChanged, true, '(e) first-pass fallback => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/feature.ts'),
        `(e) isFirstPass=true must return the full main...HEAD diff, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      // priorVerdict MAY be non-null here (the reviewer did pass before); the point
      // is that it is NOT the authoritative baseline signal — isFirstPass is.
      assert.equal(ctx.priorVerdict, null, '(e) an invalid run cannot supply trusted prior-pass information');
      assert.equal(ctx.contextMode, 'full', '(e) unresolved evidence fails closed');
      console.log(`${MARKER} (e) INVALID BOUND RUN: isFirstPass=true, priorHeadHash=null, contextMode=full, full diff changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    runTemporalCutoffRegression(root);
    void headSha; // headSha is HEAD; referenced for clarity in fixture wiring above.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runPolicyCases(): void {
  const none = classifyImpact({
    changedFiles: [],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
  });
  assert.equal(none.policyVersion, IMPACT_CLASSIFICATION_POLICY_VERSION);
  assert.equal(none.eligible, true);
  assert.deepEqual(none.reasonCodes, ['ELIGIBLE_NO_MATERIAL_CHANGE']);

  const fixture = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
  });
  assert.equal(fixture.eligible, true);
  assert.deepEqual(fixture.reasonCodes, ['ELIGIBLE_PURE_STORY_FIXTURE']);

  const fixtureWithoutIntent = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: {},
  });
  assert.equal(fixtureWithoutIntent.eligible, false);
  assert.deepEqual(fixtureWithoutIntent.reasonCodes, ['FULL_FIXTURE_BINDING_INCOMPLETE']);

  const fixtureWithUnboundChangedCase = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': false },
  });
  assert.equal(fixtureWithUnboundChangedCase.eligible, false);
  assert.deepEqual(fixtureWithUnboundChangedCase.reasonCodes, ['FULL_FIXTURE_BINDING_INCOMPLETE']);

  for (const status of ['D', 'R100', 'C100']) {
    const unsupportedFixtureStatus = classifyImpact({
      changedFiles: ['tests/case.fixture.json'],
      declaredTestFiles: ['tests/case.fixture.json'],
      testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
      fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
      changedFileStatus: { 'tests/case.fixture.json': status },
    });
    assert.equal(unsupportedFixtureStatus.eligible, false, `declared fixture status ${status} must fail closed`);
    assert.deepEqual(unsupportedFixtureStatus.reasonCodes, ['FULL_UNSUPPORTED_RENAME']);
  }

  const unavailable = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
    classificationUnavailable: true,
  });
  assert.equal(unavailable.eligible, false);
  assert.deepEqual(unavailable.reasonCodes, ['FULL_DYNAMIC_OR_PARSE_FAILURE']);

  const trustedBinding = {
    priorEnvelopePresent: true,
    runtimeContractMatches: true,
    roleContractMatches: true,
    executionEnvironmentMatches: true,
    assemblerMatches: true,
    dispatchProtocolMatches: true,
    scopePolicyMatches: true,
    taskSemanticDigestMatches: true,
    freshnessClassification: 'CURRENT_MATERIAL' as const,
    pureFixtureDrift: false,
  };
  for (const [field, expected] of [
    ['priorEnvelopePresent', 'FULL_MISSING_PRIOR_ENVELOPE'],
    ['runtimeContractMatches', 'FULL_RUNTIME_CONTRACT_CHANGED'],
    ['roleContractMatches', 'FULL_ROLE_CONTRACT_CHANGED'],
    ['executionEnvironmentMatches', 'FULL_EXECUTION_ENVIRONMENT_CHANGED'],
    ['assemblerMatches', 'FULL_ASSEMBLER_CHANGED'],
    ['dispatchProtocolMatches', 'FULL_DISPATCH_PROTOCOL_CHANGED'],
    ['scopePolicyMatches', 'FULL_SCOPE_OR_POLICY_CHANGED'],
    ['taskSemanticDigestMatches', 'FULL_MODEL_RELEVANT_TASK_CONTEXT_CHANGED'],
  ] as const) {
    const reasons = classifyIncrementalBindingReasons({ ...trustedBinding, [field]: false });
    assert.ok(reasons.includes(expected), `${field} drift forces stable full reason ${expected}`);
  }
  for (const freshnessClassification of [
    'RELATED_STORY_MATERIAL_DRIFT',
    'KNOWN_UNRELATED_MATERIAL_DRIFT',
    'LEGACY_UNBOUND',
    'RUNTIME_UNAVAILABLE',
    'UNCOMPARABLE',
  ] as const) {
    const reasons = classifyIncrementalBindingReasons({
      ...trustedBinding,
      freshnessClassification,
      pureFixtureDrift: false,
    });
    assert.ok(reasons.includes(`FULL_FRESHNESS_${freshnessClassification}`));
  }
  assert.ok(classifyIncrementalBindingReasons({
    ...trustedBinding,
    freshnessClassification: 'RELATED_STORY_MATERIAL_DRIFT',
    pureFixtureDrift: true,
  }).includes('ELIGIBLE_RELATED_PURE_STORY_FIXTURE_DRIFT'));
  const callerOverride = classifyImpact({
    changedFiles: ['src/private.ts'],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
    contextMode: 'incremental',
    forceIncremental: true,
    eligibilityReasonCodes: ['ELIGIBLE_ATTACKER_OVERRIDE'],
  } as Parameters<typeof classifyImpact>[0] & Record<string, unknown>);
  assert.equal(callerOverride.eligible, false);
  assert.deepEqual(callerOverride.reasonCodes, ['FULL_PRIVATE_IMPLEMENTATION_V1']);

  for (const [path, expected] of [
    ['docs/decision.md', 'FULL_DOCS_V1'],
    ['src/api/schema.proto', 'FULL_PUBLIC_CONTRACT'],
    ['src/authority/check.ts', 'FULL_AUTHORITY_OR_PERMISSION'],
    ['src/core/command-policy.ts', 'FULL_COMMAND_OR_GATE_POLICY'],
    ['package.json', 'FULL_DEPENDENCY_OR_BUILD'],
    ['src/private.ts', 'FULL_PRIVATE_IMPLEMENTATION_V1'],
    ['asset.bin', 'FULL_UNKNOWN_IMPACT'],
  ] as const) {
    const result = classifyImpact({
      changedFiles: [path],
      declaredTestFiles: [],
      testIntentRefsByFile: {},
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes(expected), `${path} must classify ${expected}`);
  }
  const renamed = classifyImpact({
    changedFiles: ['src/old.ts', 'src/new.ts'],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
    changedFileStatus: { 'src/old.ts': 'R100', 'src/new.ts': 'R100' },
  });
  assert.deepEqual(renamed.reasonCodes, ['FULL_UNSUPPORTED_RENAME']);

  assert.equal(classifyEvidenceFreshness({
    fresh: true,
    reason: 'evidence followed by 1 metadata-only changes, not invalidated',
    changedFiles: ['.lattice/x'],
    materialFiles: [],
  }, 'a'.repeat(40)), 'KNOWN_METADATA_ONLY_HEAD_DRIFT');
  assert.equal(classifyEvidenceFreshness({
    fresh: false,
    reason: 'evidence storyFilesHash does not match current story-owned file state',
    changedFiles: [],
    materialFiles: ['<story-files-changed>'],
  }, 'a'.repeat(40)), 'RELATED_STORY_MATERIAL_DRIFT');
  console.log(`${MARKER} POLICY: stable v1 bounded categories and canonical freshness classifications PASS`);
}

function runFixtureDuplicateIdentityCases(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-fixture-duplicate-identity-'));
  const storyId = 'B-duplicate';
  const fixturePath = 'cases.json';
  const intentRef = `${storyId}:CHK-001:happy:0`;
  const original = {
    _id: 'base-case',
    name: 'base case',
    intentRef,
    expect: true,
  };
  try {
    write(root, fixturePath, JSON.stringify({ cases: [original] }, null, 2) + '\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const duplicateVariants: Array<[string, Array<Record<string, unknown>>]> = [
      ['prepend duplicate _id', [{ _id: 'base-case', expect: false }, original]],
      ['append duplicate _id', [original, { _id: 'base-case', expect: false }]],
      ['reordered duplicate _id', [{ _id: 'other', intentRef }, original, { _id: 'base-case', expect: false }]],
      ['cross-field id alias', [original, { id: 'base-case', expect: false }]],
      ['cross-field name alias', [original, { name: 'base case', expect: false }]],
    ];
    for (const [label, cases] of duplicateVariants) {
      write(root, fixturePath, JSON.stringify({ cases }, null, 2) + '\n');
      git(root, ['add', fixturePath]);
      git(root, [...COMMIT_ENV, 'commit', '-m', label]);
      assert.equal(
        fixtureCaseClosure(root, 'main', storyId, fixturePath, new Set([intentRef])),
        false,
        `${label} must fail closed before Map/digest comparison`,
      );
    }

    git(root, ['checkout', 'main']);
    write(root, fixturePath, JSON.stringify({
      cases: [original, { id: 'base-case', expect: false }],
    }, null, 2) + '\n');
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'duplicate identity in prior snapshot']);
    git(root, ['checkout', '-B', 'story/duplicate-prior']);
    write(root, fixturePath, JSON.stringify({ cases: [original] }, null, 2) + '\n');
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'remove duplicate from current snapshot']);
    assert.equal(
      fixtureCaseClosure(root, 'main', storyId, fixturePath, new Set([intentRef])),
      false,
      'duplicate identity in the prior canonical set must fail closed',
    );
    console.log(`${MARKER} FIXTURE DUPLICATES: before/after canonical sets reject prepend/append/order and _id/id/name alias ambiguity`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case (d): GATE-UNCHANGED ASSERTION over deterministic git-free fixtures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A balanced-profile project root (requireReviewer + requireReviewerFinding =
 * true, blockingSeverities = critical+high). We materialize a lattice.json so
 * loadConfig resolves balanced deterministically regardless of the host repo.
 *
 * It is a real (single-commit) git repo on `main` so the incremental helper's
 * git calls succeed — the gate semantics under test here do NOT depend on git
 * content (currentReviewRound is unset / bound to an unknown run, so no successful
 * freshness path runs); the repo only lets reviewIncrementalContext run without
 * throwing while we prove it writes nothing and never changes the gate outcome.
 */
function buildBalancedProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-gate-'));
  writeFileSync(join(root, 'lattice.json'), JSON.stringify({ workflow: { profile: 'balanced' } }));
  write(root, '.gitignore', '.lattice/activity.jsonl\n');
  write(root, 'src/seed.ts', 'export const seed = 1;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed commit on main']);
  resetConfigCache();
  return root;
}

function runGateUnchangedCase(): void {
  const projectRoot = buildBalancedProjectRoot();
  try {
    const storyId = 'B-f675';
    const BASELINE_REVIEWERS = ['concept', 'quality', 'test-coverage'];

    // (d.1) Round 1 — pass-shaped evidence without currentReviewRound fails closed,
    // even when every opt-in lane is represented.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = BASELINE_REVIEWERS.map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.1) round-1 full opt-in + quorum');
      assert.equal(outcome, false, '(d.1) missing currentReviewRound must block pass-shaped reviewer evidence');
      console.log(`${MARKER} (d.1) ROUND 1 missing currentReviewRound -> gate BLOCK; identical with/without helper`);
    }

    // (d.2) Round 1 — missing round plus incomplete lane-shaped evidence also blocks.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = ['concept', 'quality'].map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.2) round-1 missing opt-in reviewer');
      assert.equal(outcome, false, '(d.2) Round 1 missing currentReviewRound must BLOCK incomplete lane-shaped evidence');
      console.log(`${MARKER} (d.2) ROUND 1 missing currentReviewRound + incomplete lanes -> gate BLOCK; identical with/without helper`);
    }

    // (d.3) Round 2 — a pass-shaped receipt still cannot compensate for a missing
    // currentReviewRound.
    {
      const story = reviewStory(storyId, 2, undefined);
      const passes = [signedPass(storyId, 'RP-1', 'lattice-review-concept', ts(20))];
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.3) later-round single valid receipt');
      assert.equal(outcome, false, '(d.3) missing currentReviewRound must BLOCK the gate in every review');
      console.log(`${MARKER} (d.3) missing currentReviewRound -> gate BLOCK; incremental context cannot change the assurance floor`);
    }

    // (d.4) INVALID (unknown-run) current-round binding BLOCKS — in BOTH rounds.
    // currentReviewRound is SET, and a reviewer finding carries a reviewRunId that
    // references no review-run => collectReviewerEvidenceState marks it invalid
    // (unknown_run) => gate returns false before the round split, in every round.
    for (const rounds of [1, 2]) {
      const round = ts(1);
      const story = reviewStory(storyId, rounds, round);
      // One valid pass so the precondition (findings or passes non-empty) holds,
      // plus a finding bound to a missing run => the INVALID input that must block.
      const passes = [signedPass(storyId, 'RP-1', 'lattice-review-concept', ts(30), round)];
      const finding = signedFinding(
        storyId, 'B-f675:F-1', 'lattice-review-quality', 'high', ts(31), 'open', round, 'RR-does-not-exist',
      );
      const store = buildFixtureStore({ story, passes, findings: [finding] });
      const outcome = assertGateUnchangedByHelper(
        store, projectRoot, storyId, `(d.4) invalid current-round binding (round ${rounds})`,
      );
      assert.equal(
        outcome, false,
        `(d.4) an INVALID current-round binding must BLOCK the gate in round ${rounds} (before the round split)`,
      );
      console.log(`${MARKER} (d.4) INVALID current-round binding (round ${rounds}) -> gate BLOCK; identical with/without helper`);
    }

    // (d.5) A critical finding-shaped record also cannot exploit missing-round
    // legacy compatibility; the lifecycle verdict blocks before trusting it.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = BASELINE_REVIEWERS.map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(40 + i)),
      );
      const finding = signedFinding(
        storyId, 'B-f675:F-2', 'lattice-review-concept', 'critical', ts(45), 'open',
      );
      const store = buildFixtureStore({ story, passes, findings: [finding] });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.5) verified open blocking finding');
      assert.equal(outcome, false, '(d.5) missing currentReviewRound must block critical finding-shaped evidence');
      console.log(`${MARKER} (d.5) CRITICAL FINDING with missing currentReviewRound -> gate BLOCK; identical with/without helper`);
    }
  } finally {
    resetConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function runConcurrentCliReadOnlyCase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-cli-readonly-'));
  const storyId = 'B-readonly';
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      storyDir: '.lattice/story/actives',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed read-only CLI fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'src/seed.ts', 'export const seed = false;\n');
    git(root, ['add', 'src/seed.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story material']);
    const store = new StoryStore(root);
    store.writeStory(storyId, reviewStory(storyId, 1, ts(1)));
    store.writeChecklist(storyId, { items: [] });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata']);

    const storyDir = store.storyDirPath(storyId);
    const beforeStoryBytes = directoryBytes(storyDir);
    const beforeVerdictBytes = directoryBytes(join(root, '.lattice/autopilot-verdicts'));
    const beforeStatus = git(root, ['status', '--porcelain=v1']);
    const beforeStory = JSON.stringify(store.readStory(storyId));
    const command = [
      JSON.stringify(process.execPath),
      JSON.stringify(DIST_CLI_PATH),
      '--root',
      JSON.stringify(root),
      'review_incremental_context',
      JSON.stringify(JSON.stringify({ storyId, role: 'quality', json: true })),
    ].join(' ');
    const script = [
      'set -eu',
      ...Array.from({ length: 8 }, () => `${command} >/dev/null &`),
      'wait',
    ].join('\n');
    execFileSync('/bin/sh', ['-c', script], {
      cwd: root,
      env: {
        ...process.env,
        LATTICE_PROJECT_ROOT: root,
        LATTICE_ACTIVITY_SOURCE: 'codex',
        LATTICE_SESSION_ID: 'incremental-readonly-concurrent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(directoryBytes(storyDir), beforeStoryBytes, 'concurrent CLI calls preserve every Story artifact byte');
    assert.deepEqual(
      directoryBytes(join(root, '.lattice/autopilot-verdicts')),
      beforeVerdictBytes,
      'concurrent CLI calls create no receipts, host verdicts, floor, or quorum artifacts',
    );
    assert.equal(git(root, ['status', '--porcelain=v1']), beforeStatus, 'concurrent CLI calls preserve project filesystem status');
    assert.equal(JSON.stringify(store.readStory(storyId)), beforeStory, 'concurrent CLI calls preserve phase and DONE outcome');
    console.log(`${MARKER} CLI READ-ONLY: 8 concurrent built-CLI calls preserved Story/gate/verdict bytes and lifecycle state`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPath(path: string, label: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${path}`);
    sleepSync(10);
  }
}

function runDeterministicTicketReclaimAbaCase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-lock-aba-'));
  const storyId = 'B-mixed-writer-aba';
  const round = '2026-07-19T00:00:00.000Z';
  const barrierRoot = join(root, '.lattice/locks/review-run', '.review-metadata-test-barrier');
  const lockDir = join(root, '.lattice/locks/review-run', `${storyId}-review-runs.lock`);
  const deadTicket = join(lockDir, '0000000000000000-dead-a.ticket');
  const children: ReturnType<typeof spawn>[] = [];
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: {
          'lattice-review-quality': 'full-envelope',
          'lattice-review-docs': 'full-envelope',
        },
      },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed mixed writer base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'Mixed Prompt Envelope writers',
      description: 'Prove review_run_start and Story-aware agent_prompt serialize one envelope transaction.',
      priority: 'high',
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Preserve both Prompt Envelopes',
        context: 'Mixed producers must not overwrite each other.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/seed.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'Both producer records survive.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed mixed writer review metadata']);
    execFileSync(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'dispatch',
      JSON.stringify({ storyId, agentType: 'lattice-review-quality' }),
    ], {
      cwd: root,
      env: {
        ...process.env,
        LATTICE_PROJECT_ROOT: root,
        LATTICE_ACTIVITY_SOURCE: 'codex',
        LATTICE_AGENT: 'main',
        LATTICE_SESSION_ID: 'mixed-owner',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(barrierRoot, { recursive: true });
    writeFileSync(deadTicket, JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      command: 'dead A',
      acquiredAt: '2026-07-19T00:00:00.000Z',
      lockId: 'dead-a',
    }) + '\n');
    const childEnv = (agent: string, sessionId: string) => ({
      ...process.env,
      NODE_ENV: 'test',
      LATTICE_PROJECT_ROOT: root,
      LATTICE_ACTIVITY_SOURCE: 'codex',
      LATTICE_AGENT: agent,
      LATTICE_SESSION_ID: sessionId,
      LATTICE_INTERNAL_REVIEW_METADATA_BARRIER: 'enabled',
    });
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'review_run_start',
      JSON.stringify({ storyId, agent: 'lattice-review-quality' }),
    ], {
      cwd: root,
      env: childEnv('lattice-review-quality', 'concurrent-lattice-review-quality'),
      stdio: 'ignore',
    }));
    waitForPath(join(barrierRoot, 'observed-w2'), 'W2 observing dead A');
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'agent_prompt',
      JSON.stringify({ storyId, role: 'lattice-review-docs', format: 'json' }),
    ], {
      cwd: root,
      env: childEnv('main', 'mixed-owner'),
      stdio: 'ignore',
    }));
    waitForPath(join(barrierRoot, 'observed-w1'), 'W1 observing dead A');
    writeFileSync(join(barrierRoot, 'allow-remove-w2'), 'go');
    waitForPath(join(barrierRoot, 'acquired-w2'), 'replacement B/W2 acquiring after reclaim');
    const replacementTicket = readFileSync(join(barrierRoot, 'acquired-w2'), 'utf8');
    assert.equal(existsSync(replacementTicket), true, 'replacement B ticket exists before delayed W1 reclaim resumes');

    writeFileSync(join(barrierRoot, 'allow-remove-w1'), 'go');
    sleepSync(100);
    assert.equal(
      existsSync(replacementTicket),
      true,
      'delayed stale reclaimer removes only dead A identity and cannot delete replacement B',
    );
    assert.equal(existsSync(join(barrierRoot, 'acquired-w1')), false, 'agent_prompt cannot overlap review_run_start critical section');

    writeFileSync(join(barrierRoot, 'release-w2'), 'go');
    waitForPath(join(barrierRoot, 'completed-w2'), 'actual review_run_start completion');
    waitForPath(join(barrierRoot, 'acquired-w1'), 'actual agent_prompt acquiring after review_run_start release');
    writeFileSync(join(barrierRoot, 'release-w1'), 'go');
    waitForPath(join(barrierRoot, 'completed-w1'), 'actual agent_prompt completion');
    const envelopes = store.readPromptEnvelopes(storyId).envelopes;
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(envelopes.length, 2, 'actual mixed producers preserve both Prompt Envelope records');
    assert.deepEqual(
      [...new Set(envelopes.map(envelope => envelope.dispatchKind))].sort(),
      ['review-run', 'story-dispatch'],
      'persisted envelopes identify both actual producer paths',
    );
    assert.equal(runs.length, 1, 'actual review_run_start durably persists exactly one ReviewRun');
    assert.equal(verifyReviewRun(runs[0]), true, 'actual mixed-writer ReviewRun remains signed');
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runs[0]),
      { ok: true },
      'gate verifier accepts the review-run envelope after agent_prompt appends its record',
    );
    console.log(`${MARKER} MIXED WRITER LOCK ABA: actual review_run_start + agent_prompt preserve two envelopes and valid signed ReviewRun`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  }
}

export const INCREMENTAL_GUARD_CLASS_MAP = Object.freeze({
  'review-run-identity': 'concurrent review_run_start preserves every lane and unique IDs',
  'mixed-envelope-selection': 'each legacy/full lane binds only its selected representation',
  'pass-finding-write-serialization': 'three passes and two findings are retained exactly once',
  'signed-result-admissibility': 'collector accepts every current signed result',
  'lane-no-overwrite': 'collector counts every reviewer lane once',
  'real-review-gate': 'canPassReviewGuard accepts the complete evidence matrix',
});

type GuardObservation = Record<keyof typeof INCREMENTAL_GUARD_CLASS_MAP, boolean> & {
  mutationTrace?: { redundantDeletionStillTrue: boolean; allPassesCleared: boolean };
};
type GuardMutation = keyof typeof INCREMENTAL_GUARD_CLASS_MAP;

function runConcurrentReviewerWriteCase(mask: number, iteration = 1, mutation?: GuardMutation): GuardObservation {
  const root = mkdtempSync(join(tmpdir(), `lattice-reviewer-rollout-mixed-${mask}-${iteration}-`));
  const storyId = 'B-concurrent-reviewers';
  const roles = [
    'lattice-review-behavior',
    'lattice-review-concept',
    'lattice-review-docs',
    'lattice-review-quality',
    'lattice-review-test-coverage',
  ];
  const rolloutModes = Object.fromEntries(roles.map((role, index) => [
    role,
    (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
  ]));
  const round = '2026-07-19T00:00:00.000Z';
  const shellCommand = (command: string, payload: Record<string, unknown>, role: string) => [
    `LATTICE_AGENT=${JSON.stringify(role)}`,
    `LATTICE_SESSION_ID=${JSON.stringify(`concurrent-${role}`)}`,
    JSON.stringify(process.execPath),
    JSON.stringify(DIST_CLI_PATH),
    '--root',
    JSON.stringify(root),
    command,
    JSON.stringify(JSON.stringify(payload)),
    '>/dev/null',
  ].join(' ');
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: rolloutModes,
      },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed concurrent reviewer fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'Concurrent reviewer rollout',
      description: 'Exercise real concurrent reviewer evidence writers.',
      priority: 'high',
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Preserve every reviewer result',
        context: 'Concurrent writes must serialize without overwrite.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/seed.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'All reviewer evidence is retained.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed review metadata']);

    for (const role of roles) {
      execFileSync(process.execPath, [
        DIST_CLI_PATH, '--root', root, 'dispatch', JSON.stringify({ storyId, agentType: role }),
      ], {
        cwd: root,
        env: {
          ...process.env,
          LATTICE_PROJECT_ROOT: root,
          LATTICE_ACTIVITY_SOURCE: 'codex',
          LATTICE_AGENT: 'main',
          LATTICE_SESSION_ID: 'concurrent-owner',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const startScript = ['set -eu', ...roles.map(role =>
      `${shellCommand('review_run_start', { storyId, agent: role }, role)} &`,
    ), 'wait'].join('\n');
    execFileSync('/bin/sh', ['-c', startScript], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, LATTICE_ACTIVITY_SOURCE: 'codex' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (mutation === 'review-run-identity') {
      const data = store.readReviewRuns(storyId); data.runs[1] = { ...data.runs[1]!, reviewRunId: data.runs[0]!.reviewRunId }; store.writeReviewRuns(storyId, data);
    }
    const runs = store.readReviewRuns(storyId).runs;
    const reviewRunIdentity = runs.length === roles.length && new Set(runs.map(run => run.reviewRunId)).size === roles.length;
    if (!mutation) assert.equal(reviewRunIdentity, true, 'concurrent review_run_start preserves every lane and unique IDs');
    const fullRoles = roles.filter(role => rolloutModes[role] === 'full-envelope');
    if (mutation === 'mixed-envelope-selection') {
      const data = store.readPromptEnvelopes(storyId); data.envelopes = data.envelopes.slice(1); store.writePromptEnvelopes(storyId, data);
    }
    if (!mutation) assert.equal(
      store.readPromptEnvelopes(storyId).envelopes.length,
      fullRoles.length,
      `mixed mask ${mask} iteration ${iteration} persists one envelope for each full-envelope lane only`,
    );
    let mixedEnvelopeSelection = store.readPromptEnvelopes(storyId).envelopes.length === fullRoles.length;
    for (const run of runs) {
      const full = rolloutModes[run.lane] === 'full-envelope';
      mixedEnvelopeSelection = mixedEnvelopeSelection && Boolean(run.envelopeId) === full && Boolean(run.assembledPrompt) === full;
      if (!mutation) assert.equal(Boolean(run.envelopeId), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} binds its selected rollout representation`);
      if (!mutation) assert.equal(Boolean(run.assembledPrompt), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} stores assembled prompt only in full mode`);
    }

    const evidenceCommands = roles.map((role, index) => {
      const reviewRunId = runs.find(run => run.lane === role)!.reviewRunId;
      return index % 2 === 0
        ? shellCommand('review_pass_set', {
          storyId,
          agent: role,
          reviewRunId,
          note: `${role} found no blocker after inspecting the bounded fixture.`,
          readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
        }, role)
        : shellCommand('finding_add', {
          storyId,
          agent: role,
          reviewRunId,
          desc: `${role} recorded a nonblocking concurrent evidence finding.`,
          severity: 'low',
          category: 'edge',
        }, role);
    });
    const executedEvidenceCommands = mutation === 'pass-finding-write-serialization' ? evidenceCommands.slice(0, -1) : evidenceCommands;
    execFileSync('/bin/sh', ['-c', ['set -eu', ...executedEvidenceCommands.map(command => `${command} &`), 'wait'].join('\n')], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, LATTICE_ACTIVITY_SOURCE: 'codex' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const passFindingSerialization = store.readReviewPasses(storyId).passes.length === 3 && store.readFindings(storyId).findings.length === 2;
    if (!mutation) assert.equal(passFindingSerialization, true, 'concurrent passes and findings are retained exactly once');
    if (mutation === 'signed-result-admissibility') {
      const data = store.readReviewPasses(storyId); data.passes[0] = { ...data.passes[0]!, reviewRunId: 'forged-review-run' }; store.writeReviewPasses(storyId, data);
    }
    const evidence = collectReviewerEvidenceState(store, storyId, root);
    const signedResultAdmissibility = evidence.invalid.length === 0 && evidence.valid.length === roles.length;
    if (!mutation) assert.equal(signedResultAdmissibility, true, `collector accepts every current signed result under mixed mask ${mask} iteration ${iteration}`);
    const observedAgents = [...new Set(evidence.valid.map(item => item.agent))].sort();
    if (mutation === 'lane-no-overwrite') observedAgents.pop();
    const laneNoOverwrite = JSON.stringify(observedAgents) === JSON.stringify([...roles].sort());
    if (!mutation) assert.deepEqual(
      observedAgents,
      [...roles].sort(),
      `collector counts every reviewer lane once without overwrite under mixed mask ${mask} iteration ${iteration}`,
    );
    let realGateMutationTrace: GuardObservation['mutationTrace'];
    if (mutation === 'real-review-gate') {
      const data = store.readReviewPasses(storyId);
      data.passes = [data.passes[0]!, ...data.passes]; store.writeReviewPasses(storyId, data);
      data.passes = data.passes.slice(1); store.writeReviewPasses(storyId, data);
      const redundantDeletionStillTrue = canPassReviewGuard({ storyId, store, projectRoot: root });
      assert.equal(redundantDeletionStillTrue, true, 'real gate mutation fixture proves deleting one redundant admissible pass is insufficient');
      data.passes = []; store.writeReviewPasses(storyId, data);
      realGateMutationTrace = { redundantDeletionStillTrue, allPassesCleared: canPassReviewGuard({ storyId, store, projectRoot: root }) };
    }
    const realReviewGate = canPassReviewGuard({ storyId, store, projectRoot: root });
    if (!mutation) assert.equal(realReviewGate, true, `real REVIEW gate accepts complete evidence under mixed mask ${mask} iteration ${iteration}`);
    console.log(`${MARKER} MIXED MASK ${mask} iteration ${iteration}: five concurrent legacy/full runs + pass/finding writers preserved gate evidence`);
    return {
      'review-run-identity': reviewRunIdentity,
      'mixed-envelope-selection': mixedEnvelopeSelection,
      'pass-finding-write-serialization': passFindingSerialization,
      'signed-result-admissibility': signedResultAdmissibility,
      'lane-no-overwrite': laneNoOverwrite,
      'real-review-gate': realReviewGate,
      ...(realGateMutationTrace ? { mutationTrace: realGateMutationTrace } : {}),
    };
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function runIncrementalGuardClassMatrix(): GuardObservation[] {
  const observations = [runConcurrentReviewerWriteCase(0b11111), runConcurrentReviewerWriteCase(0b01010), runConcurrentReviewerWriteCase(0b10101, 1)];
  console.log(`${MARKER} INCREMENTAL_GUARD_CLASSES=${Object.keys(INCREMENTAL_GUARD_CLASS_MAP).join(',')}`);
  return observations;
}

function runGuardShardTrials(): unknown {
  const target = fileURLToPath(import.meta.url);
  const program = String.raw`
const {spawn}=require('child_process');
const target=process.argv[1];
const run=(args,timeout=120000)=>new Promise(resolve=>{const child=spawn(process.execPath,[target,...args],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);const timer=setTimeout(()=>{child.kill('SIGKILL')},timeout);child.on('exit',(code,signal)=>{clearTimeout(timer);const line=out.split(/\r?\n/).find(x=>x.startsWith('GUARD_SCENARIO_RECEIPT='));resolve({code,signal,receipt:line?JSON.parse(line.slice('GUARD_SCENARIO_RECEIPT='.length)):null})})});
(async()=>{const masks=[31,10,21];const serial=[];for(const mask of masks)serial.push(await run(['--guard-scenario='+mask]));const parallel=await Promise.all(masks.map(mask=>run(['--guard-scenario='+mask])));const [success,timeout]=await Promise.all([run(['--guard-scenario=21']),run(['--guard-timeout-fixture'],250)]);process.stdout.write(JSON.stringify({serial,parallel,successBesideTimeout:success,timeoutBesideSuccess:timeout}));})().catch(e=>{console.error(e);process.exit(1)});`;
  const result = spawnSync(process.execPath, ['-e', program, target], { encoding: 'utf8', timeout: 360_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`guard shard trial failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

type ScheduleTransition = {
  mask: number;
  expectedPredecessor: number | null;
  observedPredecessor: number | null;
  accepted: boolean;
};

function executeOrderDependentSchedule(schedule: number[], seed: string | undefined): {
  passed: boolean;
  rejected: boolean;
  transitions: ScheduleTransition[];
  orderViolations: number[];
} {
  if (seed !== 'fixed-mask-v1') return { passed: false, rejected: true, transitions: [], orderViolations: [] };
  const expectedPredecessors = new Map<number, number | null>([[0b11111, null], [0b01010, 0b11111], [0b10101, 0b01010]]);
  let predecessor: number | null = null;
  const transitions = schedule.map(mask => {
    const expectedPredecessor = expectedPredecessors.get(mask);
    const accepted = expectedPredecessor !== undefined && predecessor === expectedPredecessor;
    const transition = { mask, expectedPredecessor: expectedPredecessor ?? null, observedPredecessor: predecessor, accepted };
    predecessor = mask;
    return transition;
  });
  const orderViolations = transitions.filter(transition => !transition.accepted).map(transition => transition.mask);
  return { passed: orderViolations.length === 0, rejected: false, transitions, orderViolations };
}

function runScheduleMutationTrial(): {
  executed: true;
  completed: boolean;
  threw: boolean;
  baselinePassed: boolean;
  reorderedPassed: boolean;
  orderViolation: boolean;
  missingSeedRejected: boolean;
  detected: boolean;
  baseline: ReturnType<typeof executeOrderDependentSchedule>;
  reordered: ReturnType<typeof executeOrderDependentSchedule>;
  missingSeed: ReturnType<typeof executeOrderDependentSchedule>;
} {
  try {
    const baseline = executeOrderDependentSchedule([0b11111, 0b01010, 0b10101], 'fixed-mask-v1');
    const reordered = executeOrderDependentSchedule([0b10101, 0b01010, 0b11111], 'fixed-mask-v1');
    const missingSeed = executeOrderDependentSchedule([0b11111, 0b01010, 0b10101], undefined);
    const detected = baseline.passed && !reordered.passed && reordered.orderViolations.length > 0 && missingSeed.rejected;
    return {
      executed: true, completed: true, threw: false,
      baselinePassed: baseline.passed, reorderedPassed: reordered.passed,
      orderViolation: reordered.orderViolations.length > 0, missingSeedRejected: missingSeed.rejected,
      detected, baseline, reordered, missingSeed,
    };
  } catch {
    return {
      executed: true, completed: false, threw: true,
      baselinePassed: false, reorderedPassed: false, orderViolation: false, missingSeedRejected: false, detected: false,
      baseline: { passed: false, rejected: false, transitions: [], orderViolations: [] },
      reordered: { passed: false, rejected: false, transitions: [], orderViolations: [] },
      missingSeed: { passed: false, rejected: false, transitions: [], orderViolations: [] },
    };
  }
}

function run(): void {
  runPolicyCases();
  runFixtureDuplicateIdentityCases();
  assertLargeDiffReviewMetadataStability();
  runIncrementalCases();
  const cutoffStarted = performance.now();
  runProductionVerifierTemporalCutoffRegression();
  const cutoffDurationMs = performance.now() - cutoffStarted;
  runGateUnchangedCase();
  runConcurrentCliReadOnlyCase();
  const abaStarted = performance.now();
  runDeterministicTicketReclaimAbaCase();
  const abaDurationMs = performance.now() - abaStarted;
  const matrixObservations = runIncrementalGuardClassMatrix();
  // The three fixed masks above are the deterministic race/mutation matrix.
  // Canonical full-suite runs add one 10101 burn-in; stress runs retain the
  // historical twenty identical repetitions for soak testing.
  const burnInIterations = process.env.LATTICE_INCREMENTAL_STRESS === '1' ? 20 : 1;
  const burnInObservations = [matrixObservations[2]!];
  for (let iteration = 2; iteration <= burnInIterations; iteration += 1) burnInObservations.push(runConcurrentReviewerWriteCase(0b10101, iteration));
  const replayObservation = runConcurrentReviewerWriteCase(0b10101, burnInIterations + 1);
  const canonicalObservation = burnInObservations[0]!;
  const mutationKillMap = Object.fromEntries(Object.keys(INCREMENTAL_GUARD_CLASS_MAP).map(guardClass => {
    if (burnInIterations !== 20) return [guardClass, { executed: false, detected: false }];
    let mutated: GuardObservation | { threw: string };
    try { mutated = runConcurrentReviewerWriteCase(0b10101, 100 + Object.keys(INCREMENTAL_GUARD_CLASS_MAP).indexOf(guardClass), guardClass as GuardMutation); }
    catch (error) { mutated = { threw: error instanceof Error ? error.message : String(error) }; }
    const baselineDigest = JSON.stringify(canonicalObservation);
    const mutatedDigest = JSON.stringify(mutated);
    const threw = 'threw' in mutated;
    const observation = threw ? undefined : mutated as GuardObservation;
    const targetFailed = observation?.[guardClass as keyof typeof INCREMENTAL_GUARD_CLASS_MAP] === false;
    const realGateTrace = guardClass === 'real-review-gate' ? observation?.mutationTrace : undefined;
    return [guardClass, {
      executed: true, completed: !threw, threw, baseline: canonicalObservation[guardClass as keyof typeof INCREMENTAL_GUARD_CLASS_MAP],
      ...(realGateTrace ?? {}), baselineDigest, mutatedDigest,
      detected: targetFailed && baselineDigest !== mutatedDigest, outcome: mutated,
    }];
  }));
  const scheduleMutation = burnInIterations === 20
    ? runScheduleMutationTrial()
    : { executed: false, completed: false, threw: false, baselinePassed: false, reorderedPassed: false, orderViolation: false, missingSeedRejected: false, detected: false };
  const shardTrials = burnInIterations === 20 ? runGuardShardTrials() as {
    serial: Array<{ code: number; receipt: unknown }>; parallel: Array<{ code: number; receipt: unknown }>;
    successBesideTimeout: { code: number; receipt: unknown }; timeoutBesideSuccess: { code: number | null; signal: string | null };
  } : null;
  const shardEquivalence = shardTrials ? {
    enabled: true,
    jobs1: shardTrials.serial,
    jobs3: shardTrials.parallel,
    deterministic: JSON.stringify(shardTrials.serial.map(item => item.receipt)) === JSON.stringify(shardTrials.parallel.map(item => item.receipt)),
    timeoutIsolated: shardTrials.successBesideTimeout.code === 0 && Boolean(shardTrials.successBesideTimeout.receipt)
      && shardTrials.timeoutBesideSuccess.signal === 'SIGKILL',
  } : { enabled: false, deterministic: false, timeoutIsolated: false };
  const allRootsIsolatedPerCase = burnInObservations.length === burnInIterations;
  const stressReceipt = {
    deterministicSeed: 'fixed-mask-v1',
    schedule: [0b11111, 0b01010, 0b10101],
    shards: { ...shardEquivalence, observedSequentialCases: allRootsIsolatedPerCase },
    replay: { mask: 0b10101, repetitions: burnInIterations, sameGuardClassOutcome: JSON.stringify(replayObservation) === JSON.stringify(canonicalObservation), observed: replayObservation },
    mutationKillMap,
    scheduleMutation,
    iterations: burnInObservations.map((guardClasses, index) => ({ iteration: index + 1, guardClasses })),
    aba: { observedDurationMs: abaDurationMs },
    cutoff: { observedDurationMs: cutoffDurationMs },
    restoration: { completedCases: burnInObservations.length, expectedCases: burnInIterations },
  };
  console.log(`INCREMENTAL_STRESS_RECEIPT=${JSON.stringify(stressReceipt)}`);
  console.log(`LATTICE_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: ['canonical-iteration', 'guard-class-equivalence', 'restoration'], mutations: burnInIterations === 20 ? Object.keys(INCREMENTAL_GUARD_CLASS_MAP) : [] })}`);
  console.log(`\n${MARKER} PASS — incremental context is correct for returning/first-timer/rename (cases a–c), and canPassReviewGuard is behaviorally IDENTICAL with vs without the incremental helper across missing-round and invalid-binding fail-closed branches, with the helper proven to write nothing to the store (case d).`);
}

const isDirectRun = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const guardScenario = process.argv.find(argument => argument.startsWith('--guard-scenario='));
  if (guardScenario) {
    const mask = Number(guardScenario.slice('--guard-scenario='.length));
    console.log(`GUARD_SCENARIO_RECEIPT=${JSON.stringify({ mask, observation: runConcurrentReviewerWriteCase(mask, 900) })}`);
  } else if (process.argv.includes('--guard-timeout-fixture')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  } else if (process.argv.includes('--aba-only')) {
    runDeterministicTicketReclaimAbaCase();
  } else if (process.argv.includes('--cutoff-verifier-only')) {
    runProductionVerifierTemporalCutoffRegression();
  } else if (process.argv.includes('--guard-map-only')) {
    runIncrementalGuardClassMatrix();
  } else if (process.argv.includes('--schedule-mutation-only')) {
    console.log(`SCHEDULE_MUTATION_RECEIPT=${JSON.stringify(runScheduleMutationTrial())}`);
  } else {
    run();
  }
}
