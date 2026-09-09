#!/usr/bin/env node
/**
 * review-pass-provenance-smoke — B-3b05 CHK-002.
 *
 * Proves the review_pass_set writer-session provenance layer end to end against
 * the REAL CLI binary plus direct logic assertions:
 *   1. non-owner-session pass records writerSessionId/sessionSource, verifies,
 *      and carries NO provenanceFlag (both the distinct-lease and no-lease cases);
 *   2. owner-session pass in warn mode (DEFAULT) persists with
 *      provenanceFlag=same_session_write plus a stderr warning naming BOTH ids;
 *   3. enforce mode (opt-in config) rejects the owner-session pass naming both
 *      ids and persists nothing — while a distinct session still passes;
 *   4. a REAL retired-domain pre-change record (copied verbatim from
 *      tmp/bf458-forensics-2026-07-14/story-metadata/review-passes.json) without
 *      writerSessionId is rejected, while a current-domain record without
 *      writer provenance remains valid;
 *   5. absent / invalid config resolves the mode to warn (hardcoded fallback);
 *   6. tampering the persisted writerSessionId (or stripping provenance fields)
 *      breaks signature verification — and (F-002) so does tampering the
 *      provenanceFlag itself: ADDING a flag to an unflagged signed record,
 *      STRIPPING the flag from a flagged signed record, or FLIPPING its value
 *      all fail verification (asserted against both locally-signed records and
 *      the record the REAL CLI persisted in scenario 2);
 *   7. an explicit-env session id is recorded with sessionSource=explicit-env
 *      (spoof stays a visible coordination-level claim), and a scrubbed env
 *      degrades to sessionSource=derived-ppid.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ReviewPass, StoryInfo } from '../core/types.js';
import { signReviewPass, verifyReviewPass } from '../core/finding-verify.js';
import {
  evaluateReviewPassProvenance,
  resolveReviewPassProvenanceMode,
  SAME_SESSION_WRITE_FLAG,
} from '../core/review-pass-provenance.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

/** Real pre-change pass record, copied VERBATIM from tmp/bf458-forensics-2026-07-14/story-metadata/review-passes.json (RP-001). */
const LEGACY_FIXTURE_STORY_ID = 'B-f458';
const LEGACY_FIXTURE_JSON = "{\"id\":\"B-f458:RP-001\",\"agent\":\"proof-or-stop-review-test-coverage\",\"note\":\"Round-3 coverage PASS: npm run test:closeout-trust passes after build. The smoke executes every closeout writer/path through real handlers and asserts manual artifact+receipt co-commit rejection with a wrong Ed25519 key, mismatched private-key rejection, old-round key rejection, signer rotation with signer-scoped sequence reset, missing-key fail-closed guidance, replay/copy/reorder rejection, and wrapper-root autoCommit plus receipt validation. All 15 happy/edge/adversarial intents have passing evidence bound to 065b7dde13 and storyFilesHash 70f0205.\",\"createdAt\":\"2026-07-13T09:58:41.024Z\",\"reviewRound\":\"2026-07-13T09:54:55.250Z\",\"reviewRunId\":\"B-f458:RR-009\",\"readManifest\":{\"filesReadFully\":[\"packages/main/src/core/closeout-trust.ts\",\"packages/main/src/tasks/closeout-trust-smoke.ts\"],\"filesTriagedByName\":[\"package.json\",\"packages/main/src/core/auto-commit-metadata.ts\",\"packages/main/src/core/review-run.ts\",\"packages/main/src/core/runtime-artifact-registry.ts\",\"packages/main/src/handlers/review-run.ts\",\"scripts/verify-process-fact-contract.mjs\",\"scripts/verify-runtime-fact-contract.mjs\"],\"scanEscalationReason\":null},\"_hash\":\"87c2657491764a98ee8e2f14d86b28ba2f9f2572842b72e4164bbc5ce880f31e\"}";

/** Session-identity env vars scrubbed from every spawned CLI so each scenario controls resolution. */
const SESSION_ENV_KEYS = [
  'PROOF_OR_STOP_SESSION_ID',
  'PROOF_OR_STOP_ACTIVITY_SOURCE',
  'PROOF_OR_STOP_ACTIVITY_SESSION',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_SESSION',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  'TERM_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'AGY_SESSION_ID',
] as const;

function reviewerReadManifest(agent: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${agent}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

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

function initRepo(prefix: string, configExtras: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    ...configExtras,
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '**/activity.jsonl',
    '.proof-or-stop/*',
    '!.proof-or-stop/story/',
    '!.proof-or-stop/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}

function writeReviewStory(root: string, storyId: string): void {
  const store = new StoryStore(root);
  const now = '2026-07-14T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'review-pass-provenance-smoke',
    title: 'Review pass provenance smoke',
    description: 'Synthetic story for writer-session provenance assertions.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: '2026-07-14T10:01:00.000Z',
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic done item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

/** Write a valid story owner lease with the given sessionId (readOwnerLease-normalizable). */
function writeOwnerLease(root: string, storyId: string, sessionId: string): void {
  const storyDir = new StoryStore(root).storyDirPath(storyId);
  const now = new Date().toISOString();
  writeFileSync(join(storyDir, 'owner-lease.json'), JSON.stringify({
    sessionId,
    sessionSource: 'explicit-env',
    hostname: 'smoke-host',
    pid: process.pid,
    cwd: root,
    command: 'story_advance',
    acquiredAt: now,
    heartbeatAt: now,
  }, null, 2));
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProofOrStop(
  root: string,
  command: string,
  args: Record<string, unknown>,
  sessionEnv: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise<CliResult>((resolvePromise, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root };
    for (const key of SESSION_ENV_KEYS) delete env[key];
    Object.assign(env, sessionEnv);
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function extractReviewRunId(output: string): string {
  const match = output.match(/B-[^:\s]+:RR-\d+/);
  assert.ok(match?.[0], `expected review run id in output: ${output}`);
  return match![0];
}

async function startReviewRun(root: string, storyId: string, agent: string, sessionEnv: Record<string, string> = {}): Promise<string> {
  const activityEnv = { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', ...sessionEnv };
  const leasePath = join(new StoryStore(root).storyDirPath(storyId), 'owner-lease.json');
  const ownerSessionId = existsSync(leasePath)
    ? (JSON.parse(readFileSync(leasePath, 'utf8')) as { sessionId?: string }).sessionId
    : undefined;
  const dispatchEnv = ownerSessionId
    ? { ...activityEnv, PROOF_OR_STOP_SESSION_ID: ownerSessionId }
    : { ...activityEnv, PROOF_OR_STOP_SESSION_ID: 'sess-review-provenance-bootstrap' };
  const dispatched = await runProofOrStop(root, 'dispatch', { storyId, agentType: agent }, dispatchEnv);
  assert.equal(dispatched.code, 0, `dispatch should succeed: ${dispatched.stderr}`);
  if (!ownerSessionId) rmSync(leasePath, { force: true });
  const reviewRunEnv = ownerSessionId
    ? activityEnv
    : { ...activityEnv, PROOF_OR_STOP_SESSION_ID: 'sess-review-provenance-bootstrap' };
  const result = await runProofOrStop(root, 'review_run_start', { storyId, agent }, reviewRunEnv);
  assert.equal(result.code, 0, `review_run_start should succeed: ${result.stderr}`);
  if (!ownerSessionId) rmSync(leasePath, { force: true });
  return extractReviewRunId(result.stdout);
}

async function recordPass(
  root: string,
  storyId: string,
  agent: string,
  sessionEnv: Record<string, string> = {},
): Promise<CliResult> {
  const reviewRunId = await startReviewRun(root, storyId, agent, sessionEnv);
  return runProofOrStop(root, 'review_pass_set', {
    storyId,
    agent,
    reviewRunId,
    note: `${agent} checked its assigned review surface and found no blocker.`,
    readManifest: reviewerReadManifest(agent),
  }, sessionEnv);
}

function passesOf(root: string, storyId: string): ReviewPass[] {
  return new StoryStore(root).readReviewPasses(storyId).passes;
}

// ── 1 + 7: non-owner session records identity (explicit-env spoof stays visible), no flag ──
async function assertNonOwnerSessionRecordsIdentityWithoutFlag(): Promise<void> {
  const root = initRepo('proof-or-stop-provenance-nonowner-');
  try {
    const storyId = 'B-prov1';
    writeReviewStory(root, storyId);
    writeOwnerLease(root, storyId, 'sess-owner-distinct');

    const result = await recordPass(root, storyId, 'proof-or-stop-review-quality', { PROOF_OR_STOP_SESSION_ID: 'sess-reviewer-thread' });
    assert.equal(result.code, 0, `non-owner review_pass_set should succeed: ${result.stderr}`);
    const pass = passesOf(root, storyId).find(p => p.agent === 'proof-or-stop-review-quality');
    assert.ok(pass, 'pass should persist');
    assert.equal(pass!.writerSessionId, 'sess-reviewer-thread', 'writerSessionId recorded');
    assert.equal(pass!.sessionSource, 'explicit-env', 'explicit-env spoof/override is recorded as sessionSource=explicit-env');
    assert.equal(pass!.provenanceFlag, undefined, 'distinct writer session must not be flagged');
    assert.equal(verifyReviewPass(storyId, pass!), true, 'provenance-inclusive record verifies');
    assert.ok(!result.stdout.includes(SAME_SESSION_WRITE_FLAG), 'stdout has no same-session flag for a distinct session');
    // F-002: fabricating a flag on the CLI-persisted UNFLAGGED record must fail.
    assert.equal(
      verifyReviewPass(storyId, { ...pass!, provenanceFlag: SAME_SESSION_WRITE_FLAG }),
      false,
      'adding provenanceFlag to the CLI-persisted unflagged record breaks verification',
    );
    console.log('  ✓ non-owner session records identity + verifies + no flag (sessionSource=explicit-env visible)');
    console.log('  ✓ CLI-persisted unflagged record: fabricated provenanceFlag add breaks verification (F-002)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 1b + 7b: no lease → identity only (scrubbed env degrades to derived-ppid) ──
async function assertNoLeaseRecordsIdentityOnly(): Promise<void> {
  const root = initRepo('proof-or-stop-provenance-nolease-');
  try {
    const storyId = 'B-prov2';
    writeReviewStory(root, storyId);

    const result = await recordPass(root, storyId, 'proof-or-stop-review-concept', {});
    assert.equal(result.code, 0, `no-lease review_pass_set should succeed: ${result.stderr}`);
    const pass = passesOf(root, storyId).find(p => p.agent === 'proof-or-stop-review-concept');
    assert.ok(pass, 'pass should persist');
    assert.match(pass!.writerSessionId ?? '', /^sess-[0-9a-f]{16}$/, 'scrubbed env derives a local session id');
    assert.equal(pass!.sessionSource, 'derived-ppid', 'scrubbed env degrades to sessionSource=derived-ppid');
    assert.equal(pass!.provenanceFlag, undefined, 'no lease → nothing to compare → no flag');
    assert.equal(verifyReviewPass(storyId, pass!), true, 'derived-ppid record verifies');
    console.log('  ✓ no lease records identity only (sessionSource=derived-ppid), no flag');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 2: owner-session pass in warn mode (DEFAULT config) persists with flag + stderr warning ──
async function assertOwnerSessionWarnModeFlagsAndWarns(): Promise<void> {
  const root = initRepo('proof-or-stop-provenance-warn-');
  try {
    const storyId = 'B-prov3';
    const ownerSession = 'sess-owner-selfwrite';
    writeReviewStory(root, storyId);
    writeOwnerLease(root, storyId, ownerSession);

    const result = await recordPass(root, storyId, 'proof-or-stop-review-quality', { PROOF_OR_STOP_SESSION_ID: ownerSession });
    assert.equal(result.code, 0, `warn-mode owner-session review_pass_set should still succeed: ${result.stderr}`);
    const pass = passesOf(root, storyId).find(p => p.agent === 'proof-or-stop-review-quality');
    assert.ok(pass, 'flagged pass should persist');
    assert.equal(pass!.writerSessionId, ownerSession, 'writerSessionId recorded');
    assert.equal(pass!.provenanceFlag, SAME_SESSION_WRITE_FLAG, 'same-session write persists provenanceFlag');
    assert.equal(verifyReviewPass(storyId, pass!), true, 'flagged record verifies');
    assert.ok(
      result.stderr.includes(`writer session ${ownerSession}`) && result.stderr.includes(`owner lease session ${ownerSession}`),
      `stderr warning must name BOTH session ids: ${result.stderr}`,
    );
    assert.ok(result.stderr.includes('subagent-or-self'), 'stderr warning keeps neutral EXP-001 wording');
    assert.ok(result.stdout.includes(`provenanceFlag=${SAME_SESSION_WRITE_FLAG}`), 'operator-facing stdout shows the flag');
    // F-002: tamper the record the REAL CLI just signed — the flag is hash-bound.
    const cliStripped = { ...pass! } as Record<string, unknown>;
    delete cliStripped.provenanceFlag;
    assert.equal(
      verifyReviewPass(storyId, cliStripped as unknown as ReviewPass),
      false,
      'stripping provenanceFlag from the CLI-persisted flagged record breaks verification',
    );
    assert.equal(
      verifyReviewPass(storyId, { ...pass!, provenanceFlag: 'relabeled_flag' as unknown as ReviewPass['provenanceFlag'] }),
      false,
      'flipping provenanceFlag on the CLI-persisted flagged record breaks verification',
    );
    console.log('  ✓ owner-session warn mode persists with same_session_write flag + stderr warning naming both ids');
    console.log('  ✓ CLI-persisted flagged record: provenanceFlag strip/flip breaks verification (F-002)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 3: enforce mode rejects the owner-session pass naming both ids; distinct session still passes ──
async function assertEnforceModeRejectsOwnerSession(): Promise<void> {
  const root = initRepo('proof-or-stop-provenance-enforce-', { reviewPassProvenance: { mode: 'enforce' } });
  try {
    const storyId = 'B-prov4';
    const ownerSession = 'sess-owner-enforced';
    writeReviewStory(root, storyId);
    writeOwnerLease(root, storyId, ownerSession);

    const rejected = await recordPass(root, storyId, 'proof-or-stop-review-quality', { PROOF_OR_STOP_SESSION_ID: ownerSession });
    assert.notEqual(rejected.code, 0, 'enforce mode must reject the owner-session pass');
    assert.ok(
      rejected.stderr.includes(`writer session ${ownerSession}`) && rejected.stderr.includes(`owner lease session ${ownerSession}`),
      `enforce rejection must name BOTH session ids: ${rejected.stderr}`,
    );
    assert.equal(passesOf(root, storyId).length, 0, 'enforce rejection must persist NOTHING');

    const allowed = await recordPass(root, storyId, 'proof-or-stop-review-concept', { PROOF_OR_STOP_SESSION_ID: 'sess-other-thread' });
    assert.equal(allowed.code, 0, `enforce mode must still accept a distinct session: ${allowed.stderr}`);
    const pass = passesOf(root, storyId).find(p => p.agent === 'proof-or-stop-review-concept');
    assert.ok(pass, 'distinct-session pass persists under enforce');
    assert.equal(pass!.provenanceFlag, undefined, 'distinct-session pass is unflagged under enforce');
    console.log('  ✓ enforce mode rejects owner-session pass naming both ids (nothing persisted); distinct session still passes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 5: default mode resolves to warn on absent/invalid config (logic + real CLI) ──
async function assertDefaultModeResolvesToWarn(): Promise<void> {
  // Pure resolver: hardcoded warn fallback (decision.json preMortem 1 mitigation).
  const warnings: string[] = [];
  const capture = (message: string) => { warnings.push(message); };
  assert.equal(resolveReviewPassProvenanceMode(undefined, capture), 'warn', 'absent section → warn');
  assert.equal(resolveReviewPassProvenanceMode(null, capture), 'warn', 'null section → warn');
  assert.equal(resolveReviewPassProvenanceMode({}, capture), 'warn', 'absent mode → warn');
  assert.equal(resolveReviewPassProvenanceMode({ mode: 'enforce' }, capture), 'enforce', 'explicit enforce respected');
  assert.equal(resolveReviewPassProvenanceMode({ mode: 'warn' }, capture), 'warn', 'explicit warn respected');
  assert.equal(warnings.length, 0, 'valid/absent config warns nothing');
  assert.equal(resolveReviewPassProvenanceMode({ mode: 'block' }, capture), 'warn', 'invalid mode → warn fallback');
  assert.equal(resolveReviewPassProvenanceMode('enforce', capture), 'warn', 'non-object section → warn fallback (a bare string cannot opt in)');
  assert.equal(resolveReviewPassProvenanceMode({ mode: 'ENFORCE' }, capture), 'warn', 'case-mismatched mode → warn fallback');
  assert.equal(warnings.length, 3, 'invalid config paths emit a fallback warning');

  // Evaluate-side runtime re-validation: an out-of-enum mode smuggled past the
  // resolver still degrades to warn (flag, not rejection).
  const evaluated = evaluateReviewPassProvenance({
    command: 'review_pass_set',
    writer: { sessionId: 'sess-same', sessionSource: 'explicit-env' },
    leaseSessionId: 'sess-same',
    mode: 'block' as unknown as 'warn',
  });
  assert.equal(evaluated.provenanceFlag, SAME_SESSION_WRITE_FLAG, 'invalid mode at evaluate-time degrades to warn (flags)');
  assert.equal(evaluated.rejection, undefined, 'invalid mode never accidentally enforces');

  // Real CLI: invalid config mode + owner-session write behaves as warn (persists flagged).
  const root = initRepo('proof-or-stop-provenance-invalidcfg-', { reviewPassProvenance: { mode: 'block' } });
  try {
    const storyId = 'B-prov5';
    const ownerSession = 'sess-owner-invalidcfg';
    writeReviewStory(root, storyId);
    writeOwnerLease(root, storyId, ownerSession);
    const result = await recordPass(root, storyId, 'proof-or-stop-review-quality', { PROOF_OR_STOP_SESSION_ID: ownerSession });
    assert.equal(result.code, 0, `invalid config must fall back to warn (persist): ${result.stderr}`);
    const pass = passesOf(root, storyId).find(p => p.agent === 'proof-or-stop-review-quality');
    assert.equal(pass?.provenanceFlag, SAME_SESSION_WRITE_FLAG, 'invalid config resolves to warn: flagged persist');
    console.log('  ✓ default/invalid config resolves to warn (resolver, evaluator, and real CLI)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 4: retired signing domains fail closed; current no-provenance records remain valid ──
function assertRetiredDomainRejectedAndCurrentPreProvenanceVerifies(): void {
  const legacy = JSON.parse(LEGACY_FIXTURE_JSON) as ReviewPass;
  assert.equal(legacy.writerSessionId, undefined, 'fixture is genuinely pre-provenance');
  assert.equal(verifyReviewPass(LEGACY_FIXTURE_STORY_ID, legacy), false, 'retired-domain fixture is rejected by the active reader');

  // Synthetic pre-change signing path (no provenance argument) also still verifies.
  const syntheticLegacy: ReviewPass = {
    id: 'B-old:RP-001',
    agent: 'proof-or-stop-review-quality',
    note: 'Legacy-path pass without writer provenance.',
    createdAt: '2026-07-01T00:00:00.000Z',
    reviewRound: '2026-07-01T00:00:00.000Z',
    reviewRunId: 'B-old:RR-001',
  };
  syntheticLegacy._hash = signReviewPass(
    'B-old',
    syntheticLegacy.id,
    syntheticLegacy.agent,
    syntheticLegacy.note,
    syntheticLegacy.createdAt,
    syntheticLegacy.reviewRound!,
    syntheticLegacy.reviewRunId,
  );
  assert.equal(verifyReviewPass('B-old', syntheticLegacy), true, 'current-domain record without writer provenance verifies');
  console.log('  ✓ retired signing domains fail closed while current-domain records without writer provenance still verify');
}

// ── 6: tampering writerSessionId / stripping provenance breaks verification ──
function assertTamperBreaksSignature(): void {
  const manifest = reviewerReadManifest('proof-or-stop-review-quality');
  const base: ReviewPass = {
    id: 'B-tamper:RP-001',
    agent: 'proof-or-stop-review-quality',
    note: 'Provenance-signed pass for tamper assertions.',
    createdAt: '2026-07-14T11:00:00.000Z',
    reviewRound: '2026-07-14T10:59:00.000Z',
    reviewRunId: 'B-tamper:RR-001',
    writerSessionId: 'sess-genuine-writer',
    sessionSource: 'explicit-env',
    readManifest: manifest as unknown as ReviewPass['readManifest'],
  };
  base._hash = signReviewPass(
    'B-tamper',
    base.id,
    base.agent,
    base.note,
    base.createdAt,
    base.reviewRound!,
    base.reviewRunId,
    base.readManifest,
    undefined,
    undefined,
    { writerSessionId: base.writerSessionId!, sessionSource: base.sessionSource! },
  );
  assert.equal(verifyReviewPass('B-tamper', base), true, 'untampered provenance record verifies');

  assert.equal(
    verifyReviewPass('B-tamper', { ...base, writerSessionId: 'sess-forged-writer' }),
    false,
    'tampered writerSessionId breaks the signature',
  );
  assert.equal(
    verifyReviewPass('B-tamper', { ...base, sessionSource: 'derived-ppid' }),
    false,
    'tampered sessionSource breaks the signature',
  );
  const stripped = { ...base } as Record<string, unknown>;
  delete stripped.writerSessionId;
  assert.equal(
    verifyReviewPass('B-tamper', stripped as unknown as ReviewPass),
    false,
    'stripping writerSessionId (leaving sessionSource) fails closed',
  );
  delete stripped.sessionSource;
  assert.equal(
    verifyReviewPass('B-tamper', stripped as unknown as ReviewPass),
    false,
    'stripping BOTH provenance fields cannot fall back to a legacy domain for a v3-signed hash',
  );

  // ── F-002: the provenanceFlag itself is signed. ──
  // ADD: fabricating a flag on an unflagged signed record must fail.
  assert.equal(
    verifyReviewPass('B-tamper', { ...base, provenanceFlag: SAME_SESSION_WRITE_FLAG }),
    false,
    'ADDING provenanceFlag to an unflagged signed record breaks the signature (fabricated self-sign evidence)',
  );

  // A record signed WITH the flag (owner-session warn-mode shape).
  const flagged: ReviewPass = {
    ...base,
    id: 'B-tamper:RP-002',
    writerSessionId: 'sess-owner-selfsigned',
    provenanceFlag: SAME_SESSION_WRITE_FLAG,
  };
  flagged._hash = signReviewPass(
    'B-tamper',
    flagged.id,
    flagged.agent,
    flagged.note,
    flagged.createdAt,
    flagged.reviewRound!,
    flagged.reviewRunId,
    flagged.readManifest,
    undefined,
    undefined,
    {
      writerSessionId: flagged.writerSessionId!,
      sessionSource: flagged.sessionSource!,
      provenanceFlag: flagged.provenanceFlag,
    },
  );
  assert.equal(verifyReviewPass('B-tamper', flagged), true, 'untampered FLAGGED provenance record verifies');
  // STRIP: erasing the self-sign audit flag post-write must fail.
  const flagStripped = { ...flagged } as Record<string, unknown>;
  delete flagStripped.provenanceFlag;
  assert.equal(
    verifyReviewPass('B-tamper', flagStripped as unknown as ReviewPass),
    false,
    'STRIPPING provenanceFlag from a flagged signed record breaks the signature (erased self-sign evidence)',
  );
  // FLIP: rewriting the flag to any other value must fail.
  assert.equal(
    verifyReviewPass('B-tamper', { ...flagged, provenanceFlag: 'relabeled_flag' as unknown as ReviewPass['provenanceFlag'] }),
    false,
    'FLIPPING provenanceFlag on a flagged signed record breaks the signature',
  );
  console.log('  ✓ writerSessionId/sessionSource tamper or strip breaks signature verification');
  console.log('  ✓ provenanceFlag add/strip/flip on a signed record breaks signature verification (F-002)');
}

async function main(): Promise<void> {
  console.log('review-pass-provenance-smoke (B-3b05 CHK-002)');
  assertRetiredDomainRejectedAndCurrentPreProvenanceVerifies();
  assertTamperBreaksSignature();
  await assertDefaultModeResolvesToWarn();
  await assertNonOwnerSessionRecordsIdentityWithoutFlag();
  await assertNoLeaseRecordsIdentityOnly();
  await assertOwnerSessionWarnModeFlagsAndWarns();
  await assertEnforceModeRejectsOwnerSession();
  console.log('review-pass-provenance-smoke: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
