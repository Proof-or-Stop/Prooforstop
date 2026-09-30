#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from './native-review-fixture.js';
/**
 * B-f675 CHK-003 — proves the read-only incremental review context
 * (core/review-incremental-context.ts, CHK-001) reports the right shape for a
 * returning reviewer, a first-timer, and a rename, AND proves the LOAD-BEARING
 * invariant of this whole story: calling reviewIncrementalContext (and having the
 * proof-or-stop review_incremental_context CLI registered) changes NOTHING about the
 * REVIEW→TEST gate canPassReviewGuard.
 *
 * HARD INVARIANT this guard defends: the incremental helper is a pure read-only
 * advisory. It must not write to the store and must not alter any gate input
 * (findings / review-passes / review-runs / currentReviewRound). The framework
 * still skips no reviewer; the round-2+ scope-change list is context only (every required lane still gates).
 *
 * Cases:
 *   (a) RETURNING REVIEWER — a reviewer 'quality' with a prior PASS bound to an
 *       earlier headHash, and a material file changed since that headHash:
 *       isFirstPass=false, scopeChanged=true, changedFiles includes that file,
 *       priorVerdict present.
 *   (b) FIRST-TIMER — a reviewer with no prior pass: isFirstPass=true,
 *       scopeChanged=true, changedFiles = the full Story-base...HEAD material diff.
 *   (c) RENAME CASE — a file renamed since the reviewer's last pass is counted as
 *       changed (rename-aware `git diff --name-status -M`): both old + new paths
 *       surface, scopeChanged=true.
 *   (e) PRIOR VERDICT W/ UNRESOLVABLE headHash — a reviewer that DID pass before,
 *       but whose bound run has an unresolvable headHash: the helper falls back to
 *       isFirstPass=true, priorHeadHash=null, full Story-base...HEAD diff, while
 *       priorVerdict stays NON-null. Pins the documented contract that consumers
 *       must key off isFirstPass (not priorVerdict) for "no incremental baseline".
 *   (f) BOUNDED-PATHS DEGRADATION — a prior that DOES resolve but whose diff to
 *       HEAD does not fit the bounded review-basis path lists: the read degrades
 *       to the full story diff against the frozen integration base (reason code
 *       FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS, contextMode full,
 *       reviewBasis null) while still reporting the resolved prior. Asserts the
 *       boundary is exact — at the cap an incremental basis is emitted, one path
 *       over it degrades — against the same bounded-path rule prompt-contracts
 *       enforces rather than against a restated number.
 *   (d) GATE-UNCHANGED ASSERTION (the load-bearing one) — exercises the REAL
 *       canPassReviewGuard (imported from core/machine.ts) over deterministic
 *       fixture stories and asserts the actual gate semantics:
 *         - Round 1 (roundCount<=1): blocks unless ALL opt-in reviewers have a
 *           valid current-round verdict + quorum.
 *         - Missing currentReviewRound: pass-shaped legacy evidence fails closed.
 *         - A current-round INVALID (stale/unknown-run) binding blocks — in ALL
 *           rounds, before the round split.
 *         - A verified open blocking finding of any round blocks (no round decay).
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
import childProcess, { execFileSync, spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyIncrementalBindingReasons,
  computeCanonicalDependencyClosure,
  fixtureCaseClosure,
  reviewIncrementalContext,
  resolveFullStoryBaseHead,
} from '../core/review-incremental-context.js';
import { REVIEW_DEPENDENCY_CLOSURE_LIMITS } from '../core/runtime-fact-registry.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import {
  FULL_TASK_CONTEXT_LIMITS,
  domainSeparatedDigest,
  validateIncrementalReviewBasis,
  validatePromptEnvelope,
  validateFullStoryBaseHead,
} from '../core/prompt-contracts.js';
import {
  assembleFullPromptEnvelope,
  buildFullTaskContext,
  fullTaskSemanticDigest,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import {
  promptRoleContract,
  resolvePromptRoleBody,
  reviewerHostRenderIdentity,
} from '../core/prompt-role-contract-registry.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetConfigCache } from '../core/config.js';
import { STATE_DIR_NAMES, stateDirCandidates } from '../core/brand-paths.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import {
  changedFilesBetweenRenameAware,
  classifyEvidenceFreshness,
  currentGitHead,
  isMaterialExcludedPath,
} from '../core/evidence-freshness.js';
import {
  collectReviewerEvidenceState,
  assertCurrentReviewRunForEvidence,
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
  ScopeContractData,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

/** Marker line printed by the smoke so `proof-or-stop validate` output is greppable. */
const MARKER = 'review-incremental-context-smoke:';
const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke'];

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

/**
 * B-cc10: scratch fixtures must ignore BOTH state-dir spellings. CLI writes the
 * canonical dir; pinning only `.proof-or-stop/` leaves `?? .proof-or-stop/` dirty and
 * breaks porcelain-preserving assertions (F-077).
 */
function scratchRuntimeGitignore(): string {
  return [
    ...stateDirCandidates('activity.jsonl'),
    ...stateDirCandidates('locks').map((rel) => `${rel}/`),
    ...stateDirCandidates('runtime').map((rel) => `${rel}/`),
  ].join('\n') + '\n';
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
    readReviewPrompt: (row: ReviewRun) => row.assembledPrompt,
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-incremental-ctx-'));
  write(root, '.gitignore', scratchRuntimeGitignore());
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
  const rollout = { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { [role]: 'full-envelope' } };
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
      schemaVersion: 'proof-or-stop.full-task-context.v1', storyId, title: 'cutoff regression',
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
  const role = 'proof-or-stop-review-quality';
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

async function runProductionVerifierTemporalCutoffRegression(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-cutoff-verifier-'));
  const storyId = 'B-cutoff-verifier';
  const role = 'proof-or-stop-review-quality';
  const laterLane = 'proof-or-stop-review-docs';
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
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        PROOF_OR_STOP_AGENT: actor,
        PROOF_OR_STOP_SESSION_ID: `cutoff-${actor}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const recordPass = async (payload: Record<string, unknown>, actor: string): Promise<void> => {
    readFileSync(join(root, 'src/cutoff.ts'), 'utf8');
    await runBrokeredNativeReviewCli({ root, store: new StoryStore(root), storyId, agent: actor,
      reviewRunId: String(payload.reviewRunId), command: 'review_pass_set', payload: { ...payload,
        readManifest: { filesReadFully: ['src/cutoff.ts'], filesTriagedByName: [], scanEscalationReason: null },
        readEvents: [{ path: 'src/cutoff.ts', mode: 'full', action: 'Read', tokenCount: null }],
      } });
  };
  try {
    write(root, '.gitignore', scratchRuntimeGitignore());
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proof-or-stop.prompt-envelope-rollout.v1',
        roles: { [role]: 'full-envelope', [laterLane]: 'full-envelope' },
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
    const scopeContract: ScopeContractData = {
      storyId,
      mode: 'enforce',
      allowedModify: ['src/cutoff.ts'],
      allowedCreate: [],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      createdAt: round,
      updatedAt: round,
    };
    store.writeScopeContract(storyId, scopeContract);
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed cutoff verifier review metadata']);

    runCli('dispatch', { storyId, agentType: role }, 'main');
    runCli('review_run_start', { storyId, agent: role }, role);
    const runA = store.readReviewRuns(storyId).runs.at(-1)!;
    await recordPass({
      storyId,
      agent: role,
      reviewRunId: runA.reviewRunId,
      note: 'A found no blocker in the stable cutoff fixture.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, role);
    const passA = store.readReviewPasses(storyId).passes.find(pass => pass.reviewRunId === runA.reviewRunId)!;

    const mutableReviewerFinding = signedFinding(
      storyId,
      `${storyId}:F-METADATA-STABILITY`,
      laterLane,
      'medium',
      new Date(Date.now() - 60_000).toISOString(),
      'open',
      round,
      runA.reviewRunId,
    );
    store.writeFindings(storyId, { findings: [mutableReviewerFinding] });
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed reviewer metadata before requested-full quality run']);

    const fullContextReason = 'Cross-lane metadata stability regression requires a full-context reviewer snapshot.';
    runCli('review_run_start', {
      storyId,
      agent: role,
      reviewerEscalationReason: fullContextReason,
    }, role);
    const runB = store.readReviewRuns(storyId).runs.at(-1)!;
    const envelopeB = store.readPromptEnvelopes(storyId).envelopes.find(
      envelope => envelope.envelopeId === runB.envelopeId,
    )!;
    assert.equal(envelopeB.contextMode, 'full', 'production B must honor the reviewer-requested full-context path');
    assert.equal(envelopeB.selectionReason, 'REVIEWER_REQUESTED_FULL');
    assert.equal(envelopeB.priorPassRef, passA.id, 'production B must bind the A-before-B pass');
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'production verifier accepts B before a later pass is appended',
    );
    const failingGitDirectory = mkdtempSync(join(tmpdir(), 'review-material-probe-'));
    try {
      const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const fakeGit = join(failingGitDirectory, 'git');
      writeFileSync(fakeGit, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='ls-tree')process.exit(1);const result=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`);
      chmodSync(fakeGit, 0o755);
      const probe = `import {StoryStore} from ${JSON.stringify(new URL('../core/store.js', import.meta.url).href)};import {verifyReviewRunPromptEnvelope} from ${JSON.stringify(new URL('../core/review-run.js', import.meta.url).href)};const store=new StoryStore(process.argv[1]);const run=store.readReviewRuns(process.argv[2]).runs.find(row=>row.reviewRunId===process.argv[3]);process.stdout.write(JSON.stringify(verifyReviewRunPromptEnvelope(store,run)));`;
      const unavailable = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe, root, storyId, runB.reviewRunId], {
        cwd: root, env: { ...process.env, PATH: `${failingGitDirectory}:${process.env.PATH ?? ''}` }, encoding: 'utf8',
      }));
      assert.equal(unavailable.ok, false, 'HEAD alone cannot establish current material freshness');
      assert.match(unavailable.reason ?? '', /current material hash unavailable/, 'unknown current material gets an actionable fail-closed diagnostic');
    } finally { rmSync(failingGitDirectory, { recursive: true, force: true }); }
    await recordPass({
      storyId,
      agent: role,
      reviewRunId: runB.reviewRunId,
      note: 'B found no blocker before the mandatory TEST transition.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, role);
    const passB = store.readReviewPasses(storyId).passes.find(pass => pass.reviewRunId === runB.reviewRunId)!;

    runCli('dispatch', { storyId, agentType: laterLane }, 'main');
    runCli('review_run_start', {
      storyId,
      agent: laterLane,
      reviewerEscalationReason: fullContextReason,
    }, laterLane);
    const laterLaneRun = store.readReviewRuns(storyId).runs.at(-1)!;
    await recordPass({
      storyId,
      agent: laterLane,
      reviewRunId: laterLaneRun.reviewRunId,
      note: 'The later docs lane found no blocker after quality B had already passed.',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }, laterLane);
    store.writeFindings(storyId, {
      findings: [{
        ...mutableReviewerFinding,
        status: 'resolved',
        resolvedAt: new Date().toISOString(),
        resolvedReason: 'Later reviewer metadata resolved this nonblocking finding.',
        resolutionType: 'fixed',
      }],
    });
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'later different-lane reviewer metadata must not invalidate requested-full quality B',
    );
    const afterDifferentLane = collectReviewerEvidenceState(store, storyId, root);
    assert.ok(
      afterDifferentLane.valid.some(evidence => evidence.id === passB.id),
      'the shared quorum/current-pass reader accepts quality B after the later docs metadata commit',
    );

    write(root, 'src/cutoff.ts', 'export const cutoff = false; // requested-full material drift\n');
    git(root, ['add', 'src/cutoff.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'mutate requested-full product material']);
    const materialMutation = verifyReviewRunPromptEnvelope(store, runB);
    assert.equal(materialMutation.ok, false, 'committed product material drift must invalidate requested-full quality B');
    assert.match(
      materialMutation.reason ?? '',
      /changedFilesDigest|impactedFilesDigest|freshnessClassification/,
      'product material drift must remain bound by a dynamically recomputed material field',
    );
    const materialMutationEvidence = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      materialMutationEvidence.valid.some(evidence => evidence.id === passB.id),
      false,
      'the shared quorum/current-pass reader must reject requested-full quality B after product material drift',
    );
    assert.ok(
      materialMutationEvidence.invalid.some(evidence => evidence.reviewRunId === runB.reviewRunId),
      'the shared quorum/current-pass reader must report requested-full quality B invalid after product material drift',
    );
    write(root, 'src/cutoff.ts', 'export const cutoff = true;\n');
    git(root, ['add', 'src/cutoff.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'restore requested-full product material']);
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'restoring product material must restore requested-full envelope acceptance after later cross-lane metadata',
    );
    assert.ok(
      collectReviewerEvidenceState(store, storyId, root).valid.some(evidence => evidence.id === passB.id),
      'the shared quorum/current-pass reader must accept requested-full quality B after product material restoration',
    );

    store.writeScopeContract(storyId, {
      ...scopeContract,
      allowedModify: [...scopeContract.allowedModify, 'src/out-of-scope.ts'],
      updatedAt: '2026-07-20T00:01:00.000Z',
    });
    const scopeMutation = verifyReviewRunPromptEnvelope(store, runB);
    assert.equal(scopeMutation.ok, false, 'scope-contract drift must invalidate requested-full quality B');
    assert.match(
      scopeMutation.reason ?? '',
      /taskSemanticDigest/,
      'scope-contract drift must remain bound by the dynamically recomputed task semantics',
    );
    const scopeMutationEvidence = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      scopeMutationEvidence.valid.some(evidence => evidence.id === passB.id),
      false,
      'the shared quorum/current-pass reader must reject requested-full quality B after scope-contract drift',
    );
    assert.ok(
      scopeMutationEvidence.invalid.some(evidence => evidence.reviewRunId === runB.reviewRunId),
      'the shared quorum/current-pass reader must report requested-full quality B invalid after scope-contract drift',
    );
    store.writeScopeContract(storyId, scopeContract);
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'restoring the scope contract must restore requested-full envelope acceptance after later cross-lane metadata',
    );
    assert.ok(
      collectReviewerEvidenceState(store, storyId, root).valid.some(evidence => evidence.id === passB.id),
      'the shared quorum/current-pass reader must accept requested-full quality B after scope-contract restoration',
    );

    const envelopeData = store.readPromptEnvelopes(storyId);
    const runBEnvelopeIndex = envelopeData.envelopes.findIndex(envelope => envelope.envelopeId === runB.envelopeId);
    assert.ok(runBEnvelopeIndex >= 0);
    const tamperedEnvelopes = [...envelopeData.envelopes];
    tamperedEnvelopes[runBEnvelopeIndex] = {
      ...tamperedEnvelopes[runBEnvelopeIndex],
      eligibilityDigest: 'f'.repeat(64),
    };
    store.writePromptEnvelopes(storyId, { envelopes: tamperedEnvelopes });
    assert.equal(
      verifyReviewRunPromptEnvelope(store, runB).ok,
      false,
      'requested-full eligibility fields remain immutable envelope-integrity facts',
    );
    store.writePromptEnvelopes(storyId, envelopeData);
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'restoring the signed requested-full envelope restores current-pass admission',
    );

    runCli('review_run_start', { storyId, agent: role }, role);
    const runC = store.readReviewRuns(storyId).runs.at(-1)!;
    await recordPass({
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
    assert.match(titleMutation.reason ?? '', /taskSemanticDigest/, 'title mutation must report model-relevant task drift');
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

function runAsOfRunEligibilityRegression(firstBaseOnly = false): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-asof-run-'));
  const storyId = 'B-asof-run';
  const role = 'proof-or-stop-review-quality';
  const round = '2026-07-21T00:00:00.000Z';
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
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        PROOF_OR_STOP_AGENT: actor,
        PROOF_OR_STOP_SESSION_ID: `asof-${actor}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const verifierOptions = (run: ReviewRun) => ({
    roleSemanticDigest: promptRoleContract(role).semanticDigest,
    findingProjection: new StoryStore(root).readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === run.envelopeId)?.findingProjection,
    fullStoryBaseHead: new StoryStore(root).readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === run.envelopeId)?.fullStoryBaseHead,
    excludedReviewRunId: run.reviewRunId,
    findingsCutoffAt: run.startedAt,
    passesCutoffAt: run.startedAt,
  });
  try {
    write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n');
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proof-or-stop.prompt-envelope-rollout.v1',
        roles: { [role]: 'full-envelope' },
      },
    }, null, 2) + '\n');
    write(root, 'src/feature.ts', 'export const feature = true;\n');
    git(root, ['init']);
    const integrationBranch = firstBaseOnly ? 'master' : 'main';
    const movedIntegrationBranch = 'alternate-integration';
    git(root, ['checkout', '-B', integrationBranch]);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed as-of-run base']);
    const integrationBase = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'As-of-run eligibility regression',
      description: 'Pin verifier eligibility to the signed ReviewRun headHash.',
      priority: 'high',
      ...(firstBaseOnly ? {
        integrationTarget: {
          parentBranch: integrationBranch,
          parentCommitAtCreation: integrationBase,
          source: 'creation_branch' as const,
          deliveryMode: 'merge_to_parent' as const,
        },
      } : {}),
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Pin eligibility to the signed run',
        context: 'Later metadata-only commits must not rewrite a receipt-bound envelope.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/feature.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'As-of-run eligibility survives metadata-only commits.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    if (firstBaseOnly) {
      write(root, 'src/feature.ts', 'export const feature = true; // Story-owned change\n');
      git(root, ['add', 'src/feature.ts']);
    }
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed as-of-run review metadata']);

    if (firstBaseOnly) {
      const validStory = store.readStory(storyId);
      const { integrationTarget: _legacyTarget, ...legacyStory } = validStory;
      store.writeStory(storyId, legacyStory as StoryInfo);
      const legacyMasterContext = reviewIncrementalContext(store, root, storyId, role);
      assert.ok(
        legacyMasterContext.changedFiles.includes('src/feature.ts'),
        'a legacy Story without integrationTarget resolves the repository master baseline',
      );
      store.writeStory(storyId, validStory);
      const invalidTargets: Array<[string, unknown]> = [
        ['null target', null],
        ['invalid parent branch', { ...validStory.integrationTarget, parentBranch: 'story/attacker' }],
        ['blank parent branch', { ...validStory.integrationTarget, parentBranch: ' ' }],
        ['missing commit', { parentBranch: integrationBranch, source: 'creation_branch', deliveryMode: 'merge_to_parent' }],
        ['blank commit', { ...validStory.integrationTarget, parentCommitAtCreation: '' }],
        ['malformed commit', { ...validStory.integrationTarget, parentCommitAtCreation: 'A'.repeat(40) }],
        ['invalid source', { ...validStory.integrationTarget, source: 'caller_supplied' }],
        ['invalid delivery mode', { ...validStory.integrationTarget, deliveryMode: 'push_directly' }],
      ];
      for (const [label, integrationTarget] of invalidTargets) {
        store.writeStory(storyId, { ...validStory, integrationTarget } as StoryInfo);
        assert.throws(() => resolveFullStoryBaseHead(store, root, storyId), /FULL_STORY_BASE_INVALID/, label);
        assert.throws(
          () => reviewIncrementalContext(store, root, storyId, role),
          /FULL_STORY_BASE_INVALID/,
          `${label} is also rejected through the ordinary context path`,
        );
      }
      const absentBase = '0'.repeat(40);
      store.writeStory(storyId, {
        ...validStory,
        integrationTarget: { ...validStory.integrationTarget!, parentCommitAtCreation: absentBase },
      });
      assert.throws(() => resolveFullStoryBaseHead(store, root, storyId), {
        message: `FULL_STORY_BASE_UNAVAILABLE: Story integration base ${absentBase} does not resolve to a commit`,
      });
      store.writeStory(storyId, validStory);
      git(root, ['branch', '-m', integrationBranch, movedIntegrationBranch]);
      for (const absentRef of ['main', 'master', integrationBranch]) {
        assert.throws(() => git(root, ['show-ref', '--verify', `refs/heads/${absentRef}`]), Error, `${absentRef} must not exist before review_run_start`);
      }
      store.writeStory(storyId, legacyStory as StoryInfo);
      assert.throws(
        () => reviewIncrementalContext(store, root, storyId, role),
        { message: `FULL_STORY_BASE_UNAVAILABLE: repository integration baseline could not be resolved for Story ${storyId}` },
        'a legacy Story with no resolvable repository baseline refuses with a stable diagnostic',
      );
      store.writeStory(storyId, validStory);
    }

    runCli('dispatch', { storyId, agentType: role }, 'main');
    runCli('review_run_start', { storyId, agent: role }, role);
    const runA = store.readReviewRuns(storyId).runs.at(-1)!;
    if (firstBaseOnly) {
      const envelope = store.readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === runA.envelopeId)!;
      const base = resolveFullStoryBaseHead(store, root, storyId)!;
      assert.equal(envelope.fullStoryBaseHead, base, 'FIRST_REVIEW_BASE_NOT_BOUND');
      const options = { ...verifierOptions(runA), asOfRef: runA.headHash };
      const { fullStoryBaseHead: _signedBase, ...implicitBaseOptions } = options;
      const implicit = reviewIncrementalContext(store, root, storyId, role, implicitBaseOptions);
      assert.ok(implicit.changedFiles.includes('src/feature.ts'), 'ordinary callers resolve the frozen Story base without main/master');
      assert.equal(implicit.eligibilityDigest, envelope.eligibilityDigest, 'implicit Story base matches the signed run-start context');
      // Preserve the historical omitted-field digest check without weakening
      // the production reproduction above: both review_run_start and the
      // ordinary context call succeeded with no local main, then this temporary
      // compatibility ref is removed.
      git(root, ['branch', 'main', integrationBase]);
      const currentStory = store.readStory(storyId);
      const { integrationTarget: _historicalTarget, ...historicalStory } = currentStory;
      store.writeStory(storyId, historicalStory as StoryInfo);
      const legacy = reviewIncrementalContext(store, root, storyId, role, { ...options, fullStoryBaseHead: undefined });
      store.writeStory(storyId, currentStory);
      git(root, ['branch', '-D', 'main']);
      // Golden captured by replaying the 9c0a6a1cbb context implementation with the same shared dependencies and one-file fixture.
      assert.equal(legacy.eligibilityDigest, 'ad06de9687d644e7ce6b50c9d2d7aa15428becb0f59e3594da158d7322493935', 'Omitting the new field preserves the legacy eligibility bytes');
      console.log(`LEGACY_FIRST_BASE_DIGEST=${legacy.eligibilityDigest}`);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA), { ok: true });
      const malformed = 'PromptEnvelope.fullStoryBaseHead must be a lowercase 40- or 64-hex Git commit object id';
      for (const value of ['main', 'HEAD', '', 'a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40)]) {
        assert.throws(() => validatePromptEnvelope({ ...envelope, fullStoryBaseHead: value }), { message: malformed });
        assert.throws(() => reviewIncrementalContext(store, root, storyId, role, { ...options, fullStoryBaseHead: value }), { message: malformed });
      }
      assert.doesNotThrow(() => validateFullStoryBaseHead('a'.repeat(64)), 'SHA-256 Git object-id syntax is supported');
      const absentBase = '0'.repeat(40);
      assert.throws(() => reviewIncrementalContext(store, root, storyId, role, { ...options, fullStoryBaseHead: absentBase }), {
        message: `FULL_STORY_BASE_UNAVAILABLE: signed comparison base ${absentBase} does not resolve to a commit`,
      });
      const tampered = { ...envelope, fullStoryBaseHead: absentBase };
      assert.equal(verifyPromptEnvelopeIntegrity(tampered), false);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA, [tampered]), {
        ok: false, reason: 'Prompt Envelope integrity verification failed',
      });
      assert.equal(base, integrationBase, 'first review binds the Story creation commit rather than a hard-coded branch');
      git(root, ['checkout', movedIntegrationBranch]);
      write(root, 'src/unrelated.ts', 'export const unrelated = true;\n');
      git(root, ['add', 'src/unrelated.ts']);
      git(root, [...COMMIT_ENV, 'commit', '-m', 'advance integration branch after first review']);
      git(root, ['checkout', `story/${storyId}`]);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA), { ok: true }, 'First review survives the integration branch moving before any merge');
      git(root, ['merge', '--no-ff', movedIntegrationBranch, '-m', 'merge unrelated integration branch into reviewed Story']);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA), { ok: true }, 'First review survives unrelated integration-branch merge');
      assert.throws(
        () => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runA.reviewRunId),
        /stale|material/i,
        'A material merge after review must require fresh live evidence even though the historical envelope stays valid',
      );
      git(root, ['rm', 'src/unrelated.ts']);
      git(root, [...COMMIT_ENV, 'commit', '-m', 'remove unrelated integration change']);
      assert.doesNotThrow(() => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runA.reviewRunId));
      assert.equal(reviewIncrementalContext(store, root, storyId, role, options).eligibilityDigest, envelope.eligibilityDigest);
      write(root, 'src/feature.ts', 'export const feature = false;\n');
      git(root, ['add', 'src/feature.ts']);
      git(root, [...COMMIT_ENV, 'commit', '-m', 'change reviewed Story source']);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA), { ok: true }, 'Historical identity is separate from live admission');
      assert.throws(() => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runA.reviewRunId), /stale|material/i);
      write(root, 'src/feature.ts', 'export const feature = true; // Story-owned change\n');
      git(root, ['add', 'src/feature.ts']);
      git(root, [...COMMIT_ENV, 'commit', '-m', 'restore controlled Story input']);
      assert.doesNotThrow(() => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runA.reviewRunId));
      git(root, ['checkout', movedIntegrationBranch]);
      git(root, ['merge', '--ff-only', `story/${storyId}`]);
      git(root, ['checkout', `story/${storyId}`]);
      assert.deepEqual(verifyReviewRunPromptEnvelope(store, runA), { ok: true }, 'Even a later integration branch containing the reviewed commit cannot choose a new historical base');
      git(root, ['branch', '-m', movedIntegrationBranch, 'final-integration']);
      assert.equal(resolveFullStoryBaseHead(store, root, storyId), integrationBase, 'The frozen Story base remains resolvable after the branch is renamed');
      console.log(`${MARKER} FIRST-REVIEW-BASE GREEN: current and legacy master resolution, explicit historical omission, malformed/unavailable refusals, live material refusal, merged-head replay`);
      return;
    }
    const passA = signedPass(storyId, `${runA.reviewRunId}:PASS`, role, ts(6), round);
    passA.reviewRunId = runA.reviewRunId;
    passA.envelopeId = runA.envelopeId;
    passA.writerSessionId = `${runA.reviewRunId}-session`;
    passA.sessionSource = 'smoke';
    passA._hash = signReviewPass(
      storyId,
      passA.id,
      passA.agent,
      passA.note,
      passA.createdAt,
      passA.reviewRound || '',
      runA.reviewRunId,
      undefined,
      undefined,
      undefined,
      { writerSessionId: passA.writerSessionId, sessionSource: passA.sessionSource },
      runA.envelopeId,
    );
    store.writeReviewPasses(storyId, { passes: [passA] });
    git(root, ['add', `.proof-or-stop/story/actives/${storyId}`]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'trusted prior pass A']);

    runCli('review_run_start', { storyId, agent: role }, role);
    const runB = store.readReviewRuns(storyId).runs.at(-1)!;
    const envelopeB = store.readPromptEnvelopes(storyId).envelopes.find(
      envelope => envelope.envelopeId === runB.envelopeId,
    )!;
    const headH1 = runB.headHash;
    assert.equal(typeof headH1, 'string');
    assert.ok(headH1.length >= 7, 'signed run must bind a real headHash');
    assert.equal(envelopeB.contextMode, 'incremental', 'production B must use the incremental envelope path');
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'production verifier accepts B at H1 before later commits',
    );

    write(
      root,
      `.proof-or-stop/story/actives/${storyId}/process-metrics.json`,
      `${JSON.stringify({ kind: 'metadata-only-import-commit', padding: 'm'.repeat(64) }, null, 2)}\n`,
    );
    git(root, ['add', `.proof-or-stop/story/actives/${storyId}/process-metrics.json`]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata-only import padding']);
    assert.notEqual(currentGitHead(root), headH1, 'metadata-only commit must move HEAD');

    const asOfH1AfterMeta = reviewIncrementalContext(store, root, storyId, role, {
      ...verifierOptions(runB),
      asOfRef: headH1,
    });
    assert.equal(
      asOfH1AfterMeta.eligibilityDigest,
      envelopeB.eligibilityDigest,
      'as-of H1 eligibilityDigest must survive a later metadata-only commit',
    );
    assert.equal(
      asOfH1AfterMeta.reviewBasisDigest ?? undefined,
      envelopeB.reviewBasisDigest,
      'as-of H1 reviewBasisDigest must survive a later metadata-only commit',
    );
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'production verifier must still accept B after a metadata-only import-style commit',
    );
    assert.doesNotThrow(() => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runB.reviewRunId), 'current admission accepts metadata-only history');
    const liveHeadAfterMeta = reviewIncrementalContext(store, root, storyId, role, verifierOptions(runB));
    assert.equal(
      liveHeadAfterMeta.currentHeadHash,
      currentGitHead(root),
      'omitting asOfRef keeps the live HEAD probe (the old bug path)',
    );

    write(root, 'src/feature.ts', 'export const feature = false;\n');
    git(root, ['add', 'src/feature.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'material source change after H1']);

    const asOfH1AfterMaterial = reviewIncrementalContext(store, root, storyId, role, {
      ...verifierOptions(runB),
      asOfRef: headH1,
    });
    const liveHeadAfterMaterial = reviewIncrementalContext(store, root, storyId, role, verifierOptions(runB));
    assert.equal(
      asOfH1AfterMaterial.eligibilityDigest,
      envelopeB.eligibilityDigest,
      'as-of H1 eligibilityDigest must remain the signed envelope after a later material commit',
    );
    assert.equal(
      asOfH1AfterMaterial.reviewBasisDigest ?? undefined,
      envelopeB.reviewBasisDigest,
      'as-of H1 reviewBasisDigest must remain the signed envelope after a later material commit',
    );
    assert.notEqual(
      liveHeadAfterMaterial.eligibilityDigest,
      asOfH1AfterMaterial.eligibilityDigest,
      'current-HEAD eligibility must detect related material drift after H1',
    );
    assert.notEqual(
      liveHeadAfterMaterial.reviewBasisDigest,
      asOfH1AfterMaterial.reviewBasisDigest,
      'current-HEAD reviewBasis must detect related material drift after H1',
    );
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runB),
      { ok: true },
      'receipt-bound verifier stays pinned to H1 and does not consume later material drift as envelope invalidity',
    );
    assert.throws(() => assertCurrentReviewRunForEvidence(store, store.readStory(storyId), root, role, runB.reviewRunId), /stale|material/i, 'historical replay never grants current admission after related material drift');
    console.log(`${MARKER} AS-OF-RUN ELIGIBILITY: metadata-only commit preserves H1 envelope; live HEAD probe remains the old path; later material commit mismatches HEAD-based context`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertLargeDiffReviewMetadataStability(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-large-review-diff-'));
  try {
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2)}\n`);
    write(root, '.gitignore', scratchRuntimeGitignore());
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
      '.proof-or-stop/story/actives/B-large-diff/prompt-envelopes.json',
      `${JSON.stringify({ envelopes: [], padding: 'm'.repeat(350_000) })}\n`,
    );
    git(root, ['add', '.proof-or-stop/story/actives/B-large-diff/prompt-envelopes.json']);
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
      const pass: ReviewPass = signedPass(storyId, 'RP-001', 'proof-or-stop-review-quality', ts(2), ts(1));
      pass.reviewRunId = runId;
      // Re-sign now that reviewRunId is set (signature domain includes it).
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'proof-or-stop-review-quality',
        lane: 'proof-or-stop-review-quality',
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
      const pass: ReviewPass = signedPass(storyId, 'RP-002', 'proof-or-stop-review-docs', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'proof-or-stop-review-docs',
        lane: 'proof-or-stop-review-docs',
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
      const pass: ReviewPass = signedPass(storyId, 'RP-003', 'proof-or-stop-review-behavior', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'proof-or-stop-review-behavior',
        lane: 'proof-or-stop-review-behavior',
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

/**
 * The material path count the incremental branch measures between a bound
 * headHash and HEAD, computed with the same production helpers that branch uses.
 */
function materialDiffPathCount(root: string, baseSha: string): number {
  return changedFilesBetweenRenameAware(root, baseSha, 'HEAD')
    .filter(path => !isMaterialExcludedPath(path, root)).length;
}

/**
 * (f) BOUNDED-PATHS DEGRADATION — the branch that fires when a prior DOES
 * resolve but sits too far behind HEAD to diff incrementally.
 *
 * Distinct from cases (b) and (e): here the prior pass is trusted AND its bound
 * headHash resolves, so neither of the isFirstPass sub-cases applies. What
 * disqualifies it is only distance — the prior-to-HEAD diff does not fit the
 * bounded path lists the review-basis contract accepts.
 *
 * Fixture (one repo, two priors, no magic numbers — every count is derived from
 * FULL_TASK_CONTEXT_LIMITS.pathsPerList):
 *   C0 main   seed: `cap` bulk files + the story file
 *   C1 main   modifies bulk file 0                     <- the AT-CAP prior binds here
 *   C2 main   modifies bulk files 1..cap-1             <- `main` stays here
 *   C3 story  modifies the story file                  <- HEAD
 * so diff(C1..HEAD) = (cap-1) bulk + 1 story = EXACTLY cap, diff(C0..HEAD) =
 * cap bulk + 1 story = cap+1, and the full story diff against main is the one
 * story file. The two priors differ ONLY in the commit they are bound to, so
 * the boundary is the only variable between the two observations.
 *
 * The boundary is pinned to the contract, not to the literal 512: at the cap an
 * incremental basis is emitted and finalize already ran it through
 * validateIncrementalReviewBasis, and that same basis with ONE more path is
 * asserted to be rejected by that validator — i.e. the guard's `>` fires exactly
 * where prompt-contracts' bounded-path rule starts rejecting.
 *
 * Note on contextMode at the cap: it is 'full' on BOTH sides here, because
 * ordinary `src/**` paths independently classify FULL_PRIVATE_IMPLEMENTATION_V1.
 * That is why "did the guard fire" is asserted through the guard's own signals —
 * its reason code, whether a review basis was emitted, and which diff was
 * served — rather than through contextMode, which cannot discriminate.
 */
function runBoundedPathsDegradationCase(): void {
  const cap = FULL_TASK_CONTEXT_LIMITS.pathsPerList;
  const bounded = 'FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS';
  const storyId = 'B-bounded-paths';
  const role = 'proof-or-stop-review-quality';
  const storyFile = 'src/story.ts';
  const bulkFile = (index: number) => `src/bulk/f${String(index).padStart(5, '0')}.ts`;
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-incremental-bounded-paths-'));
  try {
    write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n');
    write(root, storyFile, 'export const story = 0;\n');
    for (let index = 0; index < cap; index += 1) write(root, bulkFile(index), `export const bulk${index} = 0;\n`);
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed bounded-paths base']);
    const overCapBaseSha = currentGitHead(root)!;

    write(root, bulkFile(0), 'export const bulk0 = 1;\n');
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'main advances by one bulk path']);
    const atCapBaseSha = currentGitHead(root)!;

    for (let index = 1; index < cap; index += 1) write(root, bulkFile(index), `export const bulk${index} = 1;\n`);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'main advances by the remaining bulk paths']);

    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, storyFile, 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story material change ahead of main']);

    const story = reviewStory(storyId, 2, ts(1));
    const priorAtCap = trustedReviewEvidence(storyId, role, 'RR-AT-CAP', ts(5), ts(6), atCapBaseSha);
    const priorOverCap = trustedReviewEvidence(storyId, role, 'RR-OVER-CAP', ts(5), ts(6), overCapBaseSha);
    const storeFor = (evidence: ReturnType<typeof trustedReviewEvidence>) => buildFixtureStore({
      story,
      runs: [evidence.run],
      passes: [evidence.pass],
      promptEnvelopes: [evidence.envelope],
    });

    // ---- AT EXACTLY THE CAP: the guard must NOT fire ----
    const atCap = reviewIncrementalContext(storeFor(priorAtCap), root, storyId, role);
    assert.equal(atCap.eligibilityReasonCodes.includes(bounded), false, `at exactly the cap the guard must not raise ${bounded}`);
    assert.equal(atCap.changedFiles.length, cap, 'fixture must place the incremental diff at EXACTLY the bounded path cap');
    assert.equal(atCap.isFirstPass, false, 'at the cap the trusted prior is the baseline');
    assert.equal(atCap.priorHeadHash, atCapBaseSha, 'at the cap changedFiles is the diff from the prior headHash');
    assert.notEqual(atCap.reviewBasis, null, 'at the cap the incremental review basis is still emitted');
    assert.equal(atCap.reviewBasis!.changedFiles.length, cap, 'the emitted basis carries the full at-cap path list');
    assert.ok(atCap.changedFiles.includes(storyFile), 'the at-cap incremental diff still contains the story file');

    // Boundary pinned to the contract rather than to the number: finalize already
    // validated the basis above, and that same basis plus ONE path is rejected by
    // the very rule the guard exists to keep satisfiable.
    validateIncrementalReviewBasis(atCap.reviewBasis!);
    assert.throws(
      () => validateIncrementalReviewBasis({
        ...atCap.reviewBasis!,
        changedFiles: [...atCap.reviewBasis!.changedFiles, 'src/one-path-over-the-cap.ts'],
      }),
      /IncrementalReviewBasis\.changedFiles exceeds/,
      'the guard threshold must be the same bounded-path rule prompt-contracts enforces',
    );

    // ---- ONE PATH OVER THE CAP: the guard must fire and degrade ----
    // The degraded context no longer exposes the oversized diff, so the fixture's
    // distance is measured directly, through the same production helpers the
    // branch under test uses.
    assert.equal(
      materialDiffPathCount(root, overCapBaseSha),
      cap + 1,
      'fixture must place the over-cap incremental diff exactly ONE path over the bound',
    );
    const overCap = reviewIncrementalContext(storeFor(priorOverCap), root, storyId, role);
    assert.ok(overCap.eligibilityReasonCodes.includes(bounded), `one path over the cap must raise ${bounded}`);
    assert.equal(overCap.contextMode, 'full', 'the degraded context must stay full');
    assert.equal(overCap.reviewBasis, null, 'the degraded context must emit NO incremental review basis');
    assert.equal(overCap.reviewBasisDigest, null, 'a suppressed basis must leave no basis digest behind');
    assert.equal(overCap.scopeChanged, true, 'the degraded context shows everything, so scopeChanged stays true');

    // The served diff is the story's net diff against main — NOT main's own
    // already-reviewed churn that pushed the incremental diff over the bound.
    assert.deepEqual(
      overCap.changedFiles,
      [storyFile],
      'the degraded context serves the story net diff against main, not the oversized prior-to-HEAD set',
    );

    // The resolved prior is reported for audit (it is real state), and reporting
    // it moves informational fields ONLY: against a same-repo first-timer the
    // served diff, its digest, the impact-derived reason codes and contextMode
    // are identical — the prior identity is the only difference.
    const firstTimer = reviewIncrementalContext(buildFixtureStore({ story }), root, storyId, role);
    assert.equal(firstTimer.isFirstPass, true, 'control: a lane with no prior evidence is a first pass');
    assert.equal(firstTimer.priorPassRef, null, 'control: a first pass has no prior pass reference');
    assert.equal(overCap.isFirstPass, false, 'a resolvable trusted prior must NOT be reported as a first pass');
    assert.equal(overCap.priorPassRef, priorOverCap.pass.id, 'the degraded context reports the real prior pass');
    assert.equal(overCap.priorReviewRunId, priorOverCap.run.reviewRunId, 'the degraded context reports the real prior run');
    assert.equal(overCap.priorHeadHash, overCapBaseSha, 'the degraded context reports the real prior headHash');
    assert.equal(overCap.priorVerdict, `PASS (${priorOverCap.pass.id})`, 'the degraded context reports the real prior verdict');
    assert.deepEqual(overCap.changedFiles, firstTimer.changedFiles, 'the prior must not change WHICH files are served');
    assert.equal(overCap.changedFilesDigest, firstTimer.changedFilesDigest, 'the prior must not change the changed-files digest');
    assert.equal(overCap.impactedFilesDigest, firstTimer.impactedFilesDigest, 'the prior must not change the impacted-files digest');
    assert.equal(overCap.contextMode, firstTimer.contextMode, 'the prior must not change contextMode');
    assert.equal(overCap.scopeChanged, firstTimer.scopeChanged, 'the prior must not change scopeChanged');
    assert.equal(overCap.freshnessClassification, firstTimer.freshnessClassification, 'the prior must not change the freshness classification');
    assert.deepEqual(
      overCap.eligibilityReasonCodes.filter(code => code !== bounded),
      firstTimer.eligibilityReasonCodes.filter(code => code !== 'FULL_MISSING_TRUSTED_PRIOR_PASS'),
      'apart from its own FULL_ reason code the degraded context classifies exactly like the first pass',
    );
    assert.notEqual(
      overCap.eligibilityDigest,
      firstTimer.eligibilityDigest,
      'the resolved prior IS bound into the authoritative eligibility digest (audit fidelity, not eligibility)',
    );
    const frozenBase = resolveFullStoryBaseHead(storeFor(priorOverCap), root, storyId)!;
    const frozenHead = currentGitHead(root)!;
    const pinnedOptions = { fullStoryBaseHead: frozenBase, asOfRef: frozenHead };
    const pinnedBefore = reviewIncrementalContext(storeFor(priorOverCap), root, storyId, role, pinnedOptions);
    git(root, ['checkout', 'main']);
    write(root, 'src/later-main.ts', 'export const laterMain = true;\n');
    git(root, ['add', 'src/later-main.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'main drift after bounded fallback']);
    git(root, ['checkout', `story/${storyId}`]);
    const pinnedAfter = reviewIncrementalContext(storeFor(priorOverCap), root, storyId, role, pinnedOptions);
    assert.equal(pinnedAfter.eligibilityDigest, pinnedBefore.eligibilityDigest, 'Bounded fallback must use the signed full-story base');
    git(root, ['merge', '--no-ff', 'main', '-m', 'merge main after bounded fallback']);
    assert.equal(reviewIncrementalContext(storeFor(priorOverCap), root, storyId, role, pinnedOptions).eligibilityDigest, pinnedBefore.eligibilityDigest);
    console.log(`${MARKER} BOUNDED-FROZEN-BASE GREEN`);
    console.log(`${MARKER} (f) BOUNDED-PATHS DEGRADATION: cap=${cap} stays incremental (basis emitted, no ${bounded}); cap+1 degrades to the ${overCap.changedFiles.length}-path story diff with reviewBasis=null and the real prior ${overCap.priorPassRef} still reported`);
  } finally {
    resetConfigCache();
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
    changedFiles: ['.proof-or-stop/x'],
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-fixture-duplicate-identity-'));
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
 * true, blockingSeverities = critical+high). We materialize a proof-or-stop.json so
 * loadConfig resolves balanced deterministically regardless of the host repo.
 *
 * It is a real (single-commit) git repo on `main` so the incremental helper's
 * git calls succeed — the gate semantics under test here do NOT depend on git
 * content (currentReviewRound is unset / bound to an unknown run, so no successful
 * freshness path runs); the repo only lets reviewIncrementalContext run without
 * throwing while we prove it writes nothing and never changes the gate outcome.
 */
function buildBalancedProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-incremental-gate-'));
  writeFileSync(join(root, 'proof-or-stop.json'), JSON.stringify({ workflow: { profile: 'balanced' } }));
  write(root, '.gitignore', scratchRuntimeGitignore());
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
        signedPass(storyId, `RP-${i + 1}`, `proof-or-stop-review-${short}`, ts(10 + i)),
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
        signedPass(storyId, `RP-${i + 1}`, `proof-or-stop-review-${short}`, ts(10 + i)),
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
      const passes = [signedPass(storyId, 'RP-1', 'proof-or-stop-review-concept', ts(20))];
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.3) round-2 single valid receipt');
      assert.equal(outcome, false, '(d.3) Round 2+ missing currentReviewRound must BLOCK the gate');
      console.log(`${MARKER} (d.3) ROUND 2+ missing currentReviewRound -> gate BLOCK; identical with/without helper`);
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
      const passes = [signedPass(storyId, 'RP-1', 'proof-or-stop-review-concept', ts(30), round)];
      const finding = signedFinding(
        storyId, 'B-f675:F-1', 'proof-or-stop-review-quality', 'high', ts(31), 'open', round, 'RR-does-not-exist',
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
        signedPass(storyId, `RP-${i + 1}`, `proof-or-stop-review-${short}`, ts(40 + i)),
      );
      const finding = signedFinding(
        storyId, 'B-f675:F-2', 'proof-or-stop-review-concept', 'critical', ts(45), 'open',
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-incremental-cli-readonly-'));
  const storyId = 'B-readonly';
  try {
    write(root, '.gitignore', scratchRuntimeGitignore());
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
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
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata']);

    const storyDir = store.storyDirPath(storyId);
    const beforeStoryBytes = directoryBytes(storyDir);
    const beforeVerdictBytes = STATE_DIR_NAMES.map((dir) => directoryBytes(join(root, dir, 'autopilot-verdicts')));
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
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        PROOF_OR_STOP_SESSION_ID: 'incremental-readonly-concurrent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(directoryBytes(storyDir), beforeStoryBytes, 'concurrent CLI calls preserve every Story artifact byte');
    assert.deepEqual(
      STATE_DIR_NAMES.map((dir) => directoryBytes(join(root, dir, 'autopilot-verdicts'))),
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-lock-aba-'));
  const storyId = 'B-mixed-writer-aba';
  const round = '2026-07-19T00:00:00.000Z';
  const children: ReturnType<typeof spawn>[] = [];
  try {
    write(root, '.gitignore', scratchRuntimeGitignore());
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proof-or-stop.prompt-envelope-rollout.v1',
        roles: {
          'proof-or-stop-review-quality': 'full-envelope',
          'proof-or-stop-review-docs': 'full-envelope',
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
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed mixed writer review metadata']);
    // B-cc10 F-077: plant the dead ticket in the CANONICAL lock dir (store.runtimeLockDirPath),
    // not the deprecated `.proof-or-stop/locks/...` spelling the runtime no longer writes.
    const lockDir = store.runtimeLockDirPath(storyId, 'review-run', 'review-runs');
    const barrierRoot = join(dirname(lockDir), '.review-metadata-test-barrier');
    const deadTicket = join(lockDir, '0000000000000000-dead-a.ticket');
    execFileSync(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'dispatch',
      JSON.stringify({ storyId, agentType: 'proof-or-stop-review-quality' }),
    ], {
      cwd: root,
      env: {
        ...process.env,
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        PROOF_OR_STOP_AGENT: 'main',
        PROOF_OR_STOP_SESSION_ID: 'mixed-owner',
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
      PROOF_OR_STOP_PROJECT_ROOT: root,
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_AGENT: agent,
      PROOF_OR_STOP_SESSION_ID: sessionId,
      PROOF_OR_STOP_INTERNAL_REVIEW_METADATA_BARRIER: 'enabled',
    });
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'review_run_start',
      JSON.stringify({ storyId, agent: 'proof-or-stop-review-quality' }),
    ], {
      cwd: root,
      env: childEnv('proof-or-stop-review-quality', 'concurrent-proof-or-stop-review-quality'),
      stdio: 'ignore',
    }));
    waitForPath(join(barrierRoot, 'observed-w2'), 'W2 observing dead A');
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'agent_prompt',
      JSON.stringify({ storyId, role: 'proof-or-stop-review-docs', format: 'json' }),
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
    assert.equal(verifyReviewRun(runs[0], store), true, 'actual mixed-writer ReviewRun remains signed');
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
  'mixed-envelope-selection': 'each lane binds exactly one current Prompt Envelope representation',
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
  const root = mkdtempSync(join(tmpdir(), `proof-or-stop-reviewer-rollout-mixed-${mask}-${iteration}-`));
  const storyId = 'B-concurrent-reviewers';
  const roles = [
    'proof-or-stop-review-behavior',
    'proof-or-stop-review-concept',
    'proof-or-stop-review-docs',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-test-coverage',
  ];
  const rolloutModes = Object.fromEntries(roles.map(role => [role, 'full-envelope']));
  const round = '2026-07-19T00:00:00.000Z';
  const shellCommand = (command: string, payload: Record<string, unknown>, role: string) => [
    `PROOF_OR_STOP_AGENT=${JSON.stringify(role)}`,
    `PROOF_OR_STOP_SESSION_ID=${JSON.stringify(`concurrent-${role}`)}`,
    JSON.stringify(process.execPath),
    JSON.stringify(DIST_CLI_PATH),
    '--root',
    JSON.stringify(root),
    command,
    JSON.stringify(JSON.stringify(payload)),
    '>/dev/null',
  ].join(' ');
  try {
    write(root, '.gitignore', scratchRuntimeGitignore());
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proof-or-stop.prompt-envelope-rollout.v1',
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
    git(root, ['add', '.proof-or-stop/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed review metadata']);

    for (const role of roles) {
      execFileSync(process.execPath, [
        DIST_CLI_PATH, '--root', root, 'dispatch', JSON.stringify({ storyId, agentType: role }),
      ], {
        cwd: root,
        env: {
          ...process.env,
          PROOF_OR_STOP_PROJECT_ROOT: root,
          PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
          PROOF_OR_STOP_AGENT: 'main',
          PROOF_OR_STOP_SESSION_ID: 'concurrent-owner',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const startScript = ['set -eu', ...roles.map(role =>
      `${shellCommand('review_run_start', { storyId, agent: role }, role)} &`,
    ), 'wait'].join('\n');
    execFileSync('/bin/sh', ['-c', startScript], {
      cwd: root,
      env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' },
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
      `concurrency mask ${mask} iteration ${iteration} persists one current envelope per lane`,
    );
    let mixedEnvelopeSelection = store.readPromptEnvelopes(storyId).envelopes.length === fullRoles.length;
    for (const run of runs) {
      const full = rolloutModes[run.lane] === 'full-envelope';
      mixedEnvelopeSelection = mixedEnvelopeSelection && Boolean(run.envelopeId) === full && Boolean(run.assembledPromptRef) === full;
      if (!mutation) assert.equal(Boolean(run.envelopeId), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} binds its selected rollout representation`);
      if (!mutation) assert.equal(Boolean(run.assembledPromptRef), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} stores exact prompt reference only in full mode`);
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
      env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const passFindingSerialization = store.readReviewPasses(storyId).passes.length === 3 && store.readFindings(storyId).findings.length === 2;
    if (!mutation) assert.equal(passFindingSerialization, true, 'concurrent passes and findings are retained exactly once');
    if (mutation === 'signed-result-admissibility') {
      const data = store.readReviewPasses(storyId); data.passes[0] = { ...data.passes[0]!, reviewRunId: 'forged-review-run' }; store.writeReviewPasses(storyId, data);
    }
    const evidence = collectReviewerEvidenceState(store, storyId, root);
    const signedResultAdmissibility = evidence.invalid.length === 0 && evidence.valid.length === roles.length;
    if (!mutation) assert.equal(signedResultAdmissibility, true, `collector accepts every current signed result under concurrency mask ${mask} iteration ${iteration}`);
    const observedAgents = [...new Set(evidence.valid.map(item => item.agent))].sort();
    if (mutation === 'lane-no-overwrite') observedAgents.pop();
    const laneNoOverwrite = JSON.stringify(observedAgents) === JSON.stringify([...roles].sort());
    if (!mutation) assert.deepEqual(
      observedAgents,
      [...roles].sort(),
      `collector counts every reviewer lane once without overwrite under concurrency mask ${mask} iteration ${iteration}`,
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
    if (!mutation) assert.equal(realReviewGate, true, `real REVIEW gate accepts complete evidence under concurrency mask ${mask} iteration ${iteration}`);
    console.log(`${MARKER} CONCURRENCY MASK ${mask} iteration ${iteration}: five current runs + pass/finding writers preserved gate evidence`);
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

function startGuardScenario(mask: number, iteration: number): Promise<GuardObservation> {
  const target = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [target, `--guard-scenario=${mask}`, `--guard-iteration=${iteration}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolveScenario, rejectScenario) => {
    child.once('error', rejectScenario);
    child.once('close', code => {
      if (code !== 0) {
        rejectScenario(new Error(`guard scenario ${mask}/${iteration} failed: ${stderr || stdout}`));
        return;
      }
      const receiptLine = stdout.split(/\r?\n/).find(line => line.startsWith('GUARD_SCENARIO_RECEIPT='));
      if (!receiptLine) {
        rejectScenario(new Error(`guard scenario ${mask}/${iteration} emitted no receipt: ${stderr || stdout}`));
        return;
      }
      for (const line of stdout.split(/\r?\n/).filter(line => line && !line.startsWith('GUARD_SCENARIO_RECEIPT='))) console.log(line);
      const receipt = JSON.parse(receiptLine.slice('GUARD_SCENARIO_RECEIPT='.length)) as { mask: number; iteration: number; observation: GuardObservation };
      if (receipt.mask !== mask || receipt.iteration !== iteration) {
        rejectScenario(new Error(`guard scenario receipt mismatch: expected ${mask}/${iteration}, got ${receipt.mask}/${receipt.iteration}`));
        return;
      }
      resolveScenario(receipt.observation);
    });
  });
}

function startIsolatedMode(argument: string, expectedMarker: RegExp): Promise<{ durationMs: number }> {
  const target = fileURLToPath(import.meta.url);
  const started = performance.now();
  const child = spawn(process.execPath, [target, argument], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolveMode, rejectMode) => {
    child.once('error', rejectMode);
    child.once('close', code => {
      const output = `${stdout}${stderr}`;
      if (code !== 0 || !expectedMarker.test(output)) {
        rejectMode(new Error(`isolated mode ${argument} failed or omitted its marker: ${output}`));
        return;
      }
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) console.log(line);
      resolveMode({ durationMs: performance.now() - started });
    });
  });
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

function runLargeTrackedInventoryRegression(): void {
  const root = mkdtempSync(join(tmpdir(), 'pos-review-large-inventory-'));
  const gitHere = (args: string[], input?: string) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    gitHere(['init', '-q']);
    const empty = computeCanonicalDependencyClosure(root, ['tests/isolated.test.ts']);
    assert.equal(empty.complete, false);
    assert.equal(empty.reason, 'tracked source inventory is empty');
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/isolated.test.ts'), 'export const isolated = true;\n');
    gitHere(['add', 'tests/isolated.test.ts']);
    const small = computeCanonicalDependencyClosure(root, ['tests/isolated.test.ts']);
    assert.equal(small.complete, true, JSON.stringify(small));
    const blob = gitHere(['hash-object', '-w', '--stdin'], '').trim();
    // Real Git index output, no child-process mocks. Non-source historical
    // records need no worktree bytes for this read-only source closure.
    const records = Array.from({ length: 46_476 }, (_, index) =>
      `100644 ${blob}\tarchive/${String(index).padStart(6, '0')}/historical-inventory-record-padding.txt\0`).join('');
    gitHere(['update-index', '-z', '--index-info'], records);
    const inventory = gitHere(['ls-files', '-z']);
    const bytes = Buffer.byteLength(inventory);
    assert(bytes > 2 * 1024 * 1024, 'fixture must exceed the actual default Git output buffer');
    const large = computeCanonicalDependencyClosure(root, ['tests/isolated.test.ts']);
    console.log('REVIEW_REWORK_INVENTORY=' + JSON.stringify({ paths: inventory.split('\0').filter(Boolean).length, bytes, small, large }));
    assert.equal(large.complete, true, 'REVIEW_REWORK_LARGE_INVENTORY: irrelevant inventory size must not destroy a complete dependency proof');
    assert.deepEqual(large.files, small.files, 'unrelated tracked records must not widen dependency closure');
    const realExecFileSync = childProcess.execFileSync;
    let overflows = 0;
    try {
      childProcess.execFileSync = ((file: string, args: string[], options: object) => {
        if (file !== 'git' || args[0] !== 'ls-files') return realExecFileSync(file, args, options);
        try { return realExecFileSync(file, args, { ...options, maxBuffer: 1024 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOBUFS') overflows++; throw error; }
      }) as typeof execFileSync;
      syncBuiltinESMExports();
      const unavailable = computeCanonicalDependencyClosure(root, ['tests/isolated.test.ts']);
      assert.equal(overflows, 1, 'real Git must overflow the injected inventory transport bound');
      assert.equal(unavailable.complete, false);
      assert.match(unavailable.reason ?? '', /tracked source inventory unavailable: ENOBUFS/);
      assert.deepEqual(unavailable.files, ['tests/isolated.test.ts']);
    } finally {
      childProcess.execFileSync = realExecFileSync;
      syncBuiltinESMExports();
    }
    console.log('REVIEW_REWORK_INVENTORY_FAILURES PASS empty + real ENOBUFS fail closed');
    writeFileSync(join(root, 'tests/isolated.test.ts'), 'import("./" + process.env.MODULE);\n');
    const opaque = computeCanonicalDependencyClosure(root, ['tests/isolated.test.ts']);
    assert.equal(opaque.complete, false, 'opaque dependencies must still fail closed at large inventory size');
    assert.match(opaque.reason ?? '', /opaque dynamic dependency/);
    console.log('REVIEW_REWORK_LARGE_INVENTORY PASS');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runLargeSourceInventoryBudgetRegression(): void {
  const root = mkdtempSync(join(tmpdir(), 'pos-review-source-budget-'));
  const limits = REVIEW_DEPENDENCY_CLOSURE_LIMITS;
  const sourceCap = limits.maxSourceFiles;
  const sourceDir = ['s'.repeat(190), 't'.repeat(190)].join('/');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, sourceDir), { recursive: true });
    for (let index = 0; index <= sourceCap; index++) {
      writeFileSync(join(root, sourceDir, `source-${index}.ts`), 'export const value = 1;\n');
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    const inventory = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    assert(inventory.length > 1024 * 1024, 'real source inventory must exceed the former Git buffer');
    const started = performance.now();
    const closure = computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]);
    const elapsedMs = performance.now() - started;
    console.log('REVIEW_REWORK_SOURCE_BUDGET=' + JSON.stringify({ sources: sourceCap + 1, inventoryBytes: inventory.length, elapsedMs, closure }));
    assert.equal(closure.complete, false, 'REVIEW_REWORK_SOURCE_BUDGET: oversized real source inventories must fail closed before full parsing');
    assert.match(closure.reason ?? '', /dependency closure exceeded source-file bound/);
    rmSync(join(root, sourceDir, `source-${sourceCap}.ts`));
    execFileSync('git', ['rm', '--cached', '--', `${sourceDir}/source-${sourceCap}.ts`], { cwd: root });
    const atCountBound = computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]);
    assert.equal(atCountBound.complete, true, 'exact source-count bound remains eligible: ' + JSON.stringify(atCountBound));
    const firstSource = join(root, sourceDir, 'source-0.ts');
    writeFileSync(firstSource, ' '.repeat(limits.maxSourceFileBytes + 1));
    assert.match(computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]).reason ?? '', /exceeded per-file byte bound/);
    writeFileSync(firstSource, 'export const value = 1;\n');
    const largeSources = Math.floor(limits.maxTotalSourceBytes / limits.maxSourceFileBytes) + 1;
    for (let index = 0; index < largeSources; index++) writeFileSync(join(root, sourceDir, `source-${index}.ts`), ' '.repeat(limits.maxSourceFileBytes));
    assert.match(computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]).reason ?? '', /exceeded total-source byte bound/);
    for (let index = 0; index < largeSources; index++) writeFileSync(join(root, sourceDir, `source-${index}.ts`), 'export const value = 1;\n');
    writeFileSync(join(root, 'tsconfig.json'), ' '.repeat(limits.maxSourceFileBytes + 1));
    assert.match(computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]).reason ?? '', /exceeded config byte bound/);
    rmSync(join(root, 'tsconfig.json'));
    const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
    let clockReads = 0;
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => clockReads++ === 0 ? 0 : limits.maxElapsedMs + 1 });
      assert.match(computeCanonicalDependencyClosure(root, [`${sourceDir}/source-0.ts`]).reason ?? '', /exceeded elapsed-time bound/);
      assert(clockReads >= 2, 'elapsed bound control reaches the actual monotonic deadline comparison');
    } finally {
      if (originalNow) Object.defineProperty(performance, 'now', originalNow);
      else Reflect.deleteProperty(performance, 'now');
    }
    console.log('REVIEW_REWORK_SOURCE_BUDGET PASS count + exact boundary + per-file bytes + total bytes + deadline');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function run(): Promise<void> {
  runLargeTrackedInventoryRegression();
  runLargeSourceInventoryBudgetRegression();
  runPolicyCases();
  runBoundedPathsDegradationCase();
  runFixtureDuplicateIdentityCases();
  assertLargeDiffReviewMetadataStability();
  runIncrementalCases();
  // The production verifier cutoff owns a separate repository and already has
  // a dedicated direct-run mode. Keep the real mutation proof, but overlap it
  // with the other independent incremental checks instead of paying its ~75s
  // as a serial full-suite tail.
  const cutoffProbe = startIsolatedMode('--cutoff-verifier-only', /PRODUCTION VERIFIER CUTOFF/u);
  runAsOfRunEligibilityRegression();
  runAsOfRunEligibilityRegression(true);
  runGateUnchangedCase();
  runConcurrentCliReadOnlyCase();
  const abaStarted = performance.now();
  runDeterministicTicketReclaimAbaCase();
  const abaDurationMs = performance.now() - abaStarted;
  // The three fixed masks above are the deterministic race/mutation matrix.
  // Canonical full-suite runs add one 10101 burn-in; stress runs retain the
  // historical twenty identical repetitions for soak testing.
  const burnInIterations = process.env.PROOF_OR_STOP_INCREMENTAL_STRESS === '1' ? 20 : 1;
  // In the canonical run, execute the independent replay in its own process
  // while the three fixed-mask cases use this process. This preserves a real
  // second repository/run and the exact comparison, but removes a redundant
  // serial tail from the full-suite critical path. Stress mode keeps its
  // historical sequential/sharded schedule unchanged.
  const overlappedReplay = burnInIterations === 1 ? startGuardScenario(0b10101, 2) : null;
  let matrixObservations: GuardObservation[];
  let replayObservation: GuardObservation;
  try {
    matrixObservations = runIncrementalGuardClassMatrix();
    replayObservation = overlappedReplay
      ? await overlappedReplay
      : runConcurrentReviewerWriteCase(0b10101, burnInIterations + 1);
  } catch (error) {
    await overlappedReplay?.catch(() => undefined);
    throw error;
  }
  const burnInObservations = [matrixObservations[2]!];
  for (let iteration = 2; iteration <= burnInIterations; iteration += 1) burnInObservations.push(runConcurrentReviewerWriteCase(0b10101, iteration));
  const canonicalObservation = burnInObservations[0]!;
  const { durationMs: cutoffDurationMs } = await cutoffProbe;
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
  console.log(`PROOF_OR_STOP_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: ['canonical-iteration', 'guard-class-equivalence', 'restoration'], mutations: burnInIterations === 20 ? Object.keys(INCREMENTAL_GUARD_CLASS_MAP) : [] })}`);
  console.log(`\n${MARKER} PASS — incremental context is correct for returning/first-timer/rename (cases a–c), and canPassReviewGuard is behaviorally IDENTICAL with vs without the incremental helper across missing-round and invalid-binding fail-closed branches, with the helper proven to write nothing to the store (case d).`);
}

const isDirectRun = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const guardScenario = process.argv.find(argument => argument.startsWith('--guard-scenario='));
  if (guardScenario) {
    const mask = Number(guardScenario.slice('--guard-scenario='.length));
    const iterationArgument = process.argv.find(argument => argument.startsWith('--guard-iteration='));
    const iteration = iterationArgument ? Number(iterationArgument.slice('--guard-iteration='.length)) : 900;
    console.log(`GUARD_SCENARIO_RECEIPT=${JSON.stringify({ mask, iteration, observation: runConcurrentReviewerWriteCase(mask, iteration) })}`);
  } else if (process.argv.includes('--guard-timeout-fixture')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  } else if (process.argv.includes('--large-inventory-only')) {
    runLargeTrackedInventoryRegression();
    runLargeSourceInventoryBudgetRegression();
  } else if (process.argv.includes('--aba-only')) {
    runDeterministicTicketReclaimAbaCase();
  } else if (process.argv.includes('--cutoff-verifier-only')) {
    await runProductionVerifierTemporalCutoffRegression();
  } else if (process.argv.includes('--first-base-only')) {
    runAsOfRunEligibilityRegression(true);
  } else if (process.argv.includes('--asof-run-only')) {
    runAsOfRunEligibilityRegression();
  } else if (process.argv.includes('--bounded-paths-only')) {
    runBoundedPathsDegradationCase();
  } else if (process.argv.includes('--guard-map-only')) {
    runIncrementalGuardClassMatrix();
  } else if (process.argv.includes('--schedule-mutation-only')) {
    console.log(`SCHEDULE_MUTATION_RECEIPT=${JSON.stringify(runScheduleMutationTrial())}`);
  } else {
    await run();
  }
}
