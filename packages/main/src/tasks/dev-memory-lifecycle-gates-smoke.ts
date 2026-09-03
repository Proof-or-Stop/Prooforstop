#!/usr/bin/env node
/**
 * B-a7c5: dev-memory lifecycle gates smoke.
 *
 * Covers all three gates this story adds around Proofbound's previously
 * 100%-voluntary dev-memory system, each against a fresh temp-git fixture
 * (mkdtempSync + git init, mirroring quorum-submit-smoke.ts's makeFixture /
 * parallel-decomposition-gate-integration-smoke.ts's buildRepo pattern):
 *
 *   CHK-001: dev-memory preflight-ack DEV-entry gate — refusal-then-pass
 *   across all four doors into DEV (canStartDevGuard PLAN->DEV,
 *   canSkipPlanGuard INIT_CHECK->DEV express, canReenterDevGuard from REVIEW
 *   and from TEST), plus the --reason reasoned-downgrade bypass path and the
 *   fail-closed corrupt/hand-crafted-artifact adversarial cases.
 *
 *   CHK-002: non-blocking finding_resolve advisory reminder — advisory text
 *   present after a successful resolve, and a forced memory-subsystem throw
 *   (experience.jsonl replaced by a directory, forcing readFileSync to throw
 *   EISDIR) does not break finding_resolve.
 *
 *   CHK-003: dev_memory_finish_decision DONE-gate requirement — refusal-then-
 *   pass for all three decision values, plus the fail-closed corrupt-record
 *   case (malformed JSON must be treated as absent, not crash).
 *
 * Every gate assertion is a genuine refusal-THEN-pass pair: each is first
 * asserted false/blocking WITHOUT the artifact, then true/passing AFTER it is
 * written — never only the pass-after-write half.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache, loadConfig } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import {
  canStartDevGuard,
  canSkipPlanGuard,
  canReenterDevGuard,
  canFinishGuard,
  evaluateDevMemoryPreflightGate,
  getGuardFailureReason,
  type StoryMachineContext,
} from '../core/machine.js';
import { readDevMemoryFinishDecision } from '../core/playbook-runtime-memory.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { persistFinalizedReviewInventory } from '../core/review-inventory-epoch.js';
import { findRuntimeArtifactEntry } from '../core/runtime-artifact-registry.js';
import type { StoryInfo } from '../core/types.js';
import { createDevMemoryHandlers } from '../handlers/dev-memory.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import type { HandlerContext } from '../handlers/context.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';

const NOW = '2026-08-14T12:00:00.000Z';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    console.error(`✗ ${name}`);
    throw new Error(`dev-memory-lifecycle-gates-smoke assertion failed: ${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dev-memory-lifecycle-gates-smoke',
      GIT_AUTHOR_EMAIL: 'dev-memory-lifecycle-gates-smoke@example.invalid',
      GIT_COMMITTER_NAME: 'dev-memory-lifecycle-gates-smoke',
      GIT_COMMITTER_EMAIL: 'dev-memory-lifecycle-gates-smoke@example.invalid',
    },
  });
}

function writeConfig(root: string): void {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  }, null, 2) + '\n');
  resetConfigCache();
}

function mkCtx(root: string): HandlerContext {
  const config = loadConfig(root);
  return { store: new StoryStore(root), root, scanRoot: join(root, config.scanRoot), log: () => {} };
}

function syntheticStory(storyId: string, phase: StoryInfo['phase']): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: 'dev-memory lifecycle gates smoke story',
    description: 'Synthetic story for B-a7c5 dev-memory lifecycle gates smoke.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CHK-001: dev-memory preflight-ack DEV-entry gate
// ─────────────────────────────────────────────────────────────────────────

/** A hermetic temp git repo + StoryStore + machine context for one DEV door. */
function buildDoorRepo(storyId: string, phase: StoryInfo['phase']): { root: string; store: StoryStore; context: StoryMachineContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-devmem-door-'));
  writeConfig(root);
  write(root, 'README.md', 'dev-memory lifecycle gates smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(storyId, syntheticStory(storyId, phase));
  // Small (empty) checklist so canSkipPlanGuard's quickPath.maxChecklistItems
  // check never becomes the blocking factor under test.
  store.writeChecklist(storyId, { items: [] });
  if (phase === 'REVIEW') {
    const headHash = currentGitHead(root);
    const materialHash = currentMaterialHash(root, 'HEAD', root);
    const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
    if (!headHash || !materialHash || !storyFilesHash) {
      throw new Error('dev-memory door fixture: missing HEAD/material/storyFiles hashes');
    }
    persistFinalizedReviewInventory({
      store,
      storyId,
      reviewRound: '',
      cutoff: { headHash, materialHash, storyFilesHash },
    });
  }

  const context: StoryMachineContext = { storyId, store, projectRoot: root };
  return { root, store, context };
}

function ackHandler(root: string) {
  return createDevMemoryHandlers(mkCtx(root)).dev_memory_preflight_ack;
}

/** CHK-001 happy + adversarial: refusal-then-pass for one named DEV door. */
function assertDoorRefusalThenPass(
  doorLabel: string,
  storyId: string,
  phase: StoryInfo['phase'],
  guard: (context: StoryMachineContext) => boolean,
): void {
  const { root, store, context } = buildDoorRepo(storyId, phase);
  try {
    check(`CHK-001 ${doorLabel}: refuses without dev-memory-preflight-ack.json`, guard(context) === false);
    const reasonBefore = getGuardFailureReason(storyId, store, 'DEV', root);
    check(`CHK-001 ${doorLabel}: getGuardFailureReason tags missing_dev_memory_preflight_ack`,
      /\[missing_dev_memory_preflight_ack\]/.test(reasonBefore ?? ''));
    check(`CHK-001 ${doorLabel}: refusal message names the run-command hint`,
      /(?:proof-or-stop|proofOrStop) dev_memory_preflight_ack --storyId=/.test(reasonBefore ?? ''));

    const out = ackHandler(root)({ storyId });
    check(`CHK-001 ${doorLabel}: dev_memory_preflight_ack writes the ack artifact`, /acknowledged/.test(out));

    check(`CHK-001 ${doorLabel}: passes after ack is written`, guard(context) === true);
    const reasonAfter = getGuardFailureReason(storyId, store, 'DEV', root);
    check(`CHK-001 ${doorLabel}: getGuardFailureReason no longer names missing_dev_memory_preflight_ack`,
      !/missing_dev_memory_preflight_ack/.test(reasonAfter ?? ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertAllFourDevDoorsGated(): void {
  assertDoorRefusalThenPass('door1 canStartDevGuard (PLAN->DEV)', 'B-devmem-d1', 'PLAN', canStartDevGuard);
  assertDoorRefusalThenPass('door2 canSkipPlanGuard (INIT_CHECK->DEV express)', 'B-devmem-d2', 'INIT_CHECK', canSkipPlanGuard);
  assertDoorRefusalThenPass('door3 canReenterDevGuard (REVIEW->DEV rollback)', 'B-devmem-d3', 'REVIEW', canReenterDevGuard);
  assertDoorRefusalThenPass('door4 canReenterDevGuard (TEST->DEV rollback)', 'B-devmem-d4', 'TEST', canReenterDevGuard);
}

/** CHK-001 edge: round-trip schema + existence-only semantics (content-agnostic). */
function assertAckRoundTripAndExistenceOnly(): void {
  const storyId = 'B-devmem-roundtrip';
  const { root, store, context } = buildDoorRepo(storyId, 'PLAN');
  try {
    ackHandler(root)({ storyId, query: 'roundtrip smoke query' });
    const ack = store.readDevMemoryPreflightAck(storyId);
    check('CHK-001 edge: ack has correct schemaVersion', ack?.schemaVersion === 'lattice.dev_memory_preflight_ack.v1');
    check('CHK-001 edge: ack.storyId matches', ack?.storyId === storyId);
    check('CHK-001 edge: ack.topHitIds is an array', Array.isArray(ack?.topHitIds));
    check('CHK-001 edge: ack.acknowledgedAt is a non-empty string', typeof ack?.acknowledgedAt === 'string' && ack.acknowledgedAt.length > 0);
    check('CHK-001 edge: ack.acknowledgedBy is a non-empty string', typeof ack?.acknowledgedBy === 'string' && ack.acknowledgedBy.length > 0);
    check('CHK-001 edge: evaluateDevMemoryPreflightGate reads it back as true regardless of content', evaluateDevMemoryPreflightGate(storyId, store) === true);
    check('CHK-001 edge: canStartDevGuard passes on the round-tripped ack', canStartDevGuard(context) === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** CHK-001 adversarial: fail-closed on missing/corrupt/hand-crafted artifacts. */
function assertAckFailClosedOnCorruption(): void {
  const storyId = 'B-devmem-corrupt';
  const { root, store, context } = buildDoorRepo(storyId, 'PLAN');
  try {
    check('CHK-001 adversarial: gate false before any artifact exists', evaluateDevMemoryPreflightGate(storyId, store) === false);

    const ackPath = `.proof-or-stop/story/actives/${storyId}/dev-memory-preflight-ack.json`;

    write(root, ackPath, '{}');
    check('CHK-001 adversarial: empty object {} treated as absent (fail-closed)', evaluateDevMemoryPreflightGate(storyId, store) === false);

    write(root, ackPath, JSON.stringify({ schemaVersion: 'wrong.version', storyId, packDigest: null, topHitIds: [], acknowledgedAt: NOW, acknowledgedBy: 'x' }));
    check('CHK-001 adversarial: wrong schemaVersion treated as absent (fail-closed)', evaluateDevMemoryPreflightGate(storyId, store) === false);

    write(root, ackPath, '{ this is not valid json ::::');
    check('CHK-001 adversarial: truncated/invalid JSON treated as absent (fail-closed)', evaluateDevMemoryPreflightGate(storyId, store) === false);
    check('CHK-001 adversarial: canStartDevGuard also refuses on corrupt artifact', canStartDevGuard(context) === false);

    // Write a genuinely valid ack, confirm it passes, then delete/corrupt again
    // to prove the gate re-reads from disk every time (no caching).
    ackHandler(root)({ storyId });
    check('CHK-001 adversarial: valid ack passes', evaluateDevMemoryPreflightGate(storyId, store) === true);
    write(root, ackPath, 'truncated-again-not-json');
    check('CHK-001 adversarial: re-corrupting after a valid ack blocks again (no caching)', evaluateDevMemoryPreflightGate(storyId, store) === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-001 adversarial: a genuine unexpected read fault on the ack artifact
 * (not a missing/malformed file) must propagate to each door's OWN outer
 * catch, not be swallowed as an ordinary "absent" case. canReenterDevGuard's
 * outer catch is fail-OPEN by design (F-006/spec §4.8: a rollback must never
 * be stranded by a gate/config error); canStartDevGuard's is fail-CLOSED.
 * Regression coverage for a real finding: an earlier version of
 * evaluateDevMemoryPreflightGate caught every error class unconditionally,
 * silently defeating canReenterDevGuard's fail-open guarantee for this one
 * check (found by REVIEW quality lane via exactly this EISDIR reproduction).
 */
function assertGenuineIoFaultPropagatesToDoorFailOpen(): void {
  const storyId = 'B-devmem-iofault';
  const { root, store } = buildDoorRepo(storyId, 'REVIEW');
  try {
    const ackPath = join(root, '.proof-or-stop', 'story', 'actives', storyId, 'dev-memory-preflight-ack.json');
    // Force EISDIR: make the ack path a directory instead of a file, so
    // readFileSync throws a genuine fs error, not ENOENT/SyntaxError.
    mkdirSync(ackPath, { recursive: true });

    const context: StoryMachineContext = { storyId, store, projectRoot: root, gitCwd: root };
    check(
      'CHK-001 adversarial: canReenterDevGuard fail-OPENs on a genuine I/O fault reading the ack (EISDIR), not silently blocked',
      canReenterDevGuard(context) === true,
    );
    check(
      'CHK-001 adversarial: canStartDevGuard still fail-CLOSEs on the same genuine I/O fault (unchanged safety for the primary DEV door)',
      canStartDevGuard(context) === false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** CHK-001 edge/adversarial: the section-4.3-compliant --reason downgrade bypass path. */
function assertReasonedDowngradeBypass(): void {
  const storyId = 'B-devmem-downgrade';
  const { root, store, context } = buildDoorRepo(storyId, 'PLAN');
  try {
    // Force the preflight pack build itself to throw: replace the project
    // experience.jsonl FILE with a DIRECTORY so readFileSync throws EISDIR
    // (same forced-throw pattern used elsewhere in this codebase, e.g.
    // experience-layer-review-dispatch-hint-smoke.ts).
    // B-cc10: plant the sabotage where the runtime READS. At the deprecated path this was
    // a silent no-op after the rename: the pack build succeeded, so the expected exception
    // never fired and the test stopped exercising its own scenario.
    mkdirSync(join(root, PROOF_OR_STOP_STATE_DIR, 'dev-memory', 'experience.jsonl'), { recursive: true });

    assert.throws(
      () => ackHandler(root)({ storyId }),
      /preflight pack build failed/,
      'without --reason, a failing pack build must fail the command (no silent ack)',
    );
    check('CHK-001 downgrade: no ack written when build fails without --reason', evaluateDevMemoryPreflightGate(storyId, store) === false);
    check('CHK-001 downgrade: canStartDevGuard still refuses', canStartDevGuard(context) === false);

    assert.throws(
      () => ackHandler(root)({ storyId, reason: 'ab' }),
      /preflight pack build failed/,
      'a too-short --reason (<5 chars) must not satisfy the downgrade path',
    );
    check('CHK-001 downgrade: still refused after a too-short --reason', evaluateDevMemoryPreflightGate(storyId, store) === false);

    const out = ackHandler(root)({ storyId, reason: 'experience.jsonl is unreadable in this fixture' });
    check('CHK-001 downgrade: --reason (>=5 chars) records the downgrade', /reasoned downgrade/.test(out));

    const ack = store.readDevMemoryPreflightAck(storyId);
    check('CHK-001 downgrade: packDigest is null on the downgrade path', ack?.packDigest === null);
    check('CHK-001 downgrade: topHitIds is empty on the downgrade path', Array.isArray(ack?.topHitIds) && ack.topHitIds.length === 0);
    check('CHK-001 downgrade: downgradeReason is recorded', ack?.downgradeReason === 'experience.jsonl is unreadable in this fixture');
    check('CHK-001 downgrade: gate still passes on the reasoned downgrade', evaluateDevMemoryPreflightGate(storyId, store) === true);
    check('CHK-001 downgrade: canStartDevGuard passes on the reasoned downgrade', canStartDevGuard(context) === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CHK-002: non-blocking finding_resolve advisory
// ─────────────────────────────────────────────────────────────────────────

function mkFindingProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-devmem-finding-'));
  writeConfig(root);
  return root;
}

function seedFindingStory(store: StoryStore, storyId: string): void {
  store.writeStory(storyId, { ...syntheticStory(storyId, 'REVIEW'), events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }] });
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings: [] });
}

function extractFindingId(addOutput: string): string {
  const match = addOutput.match(/Finding (\S+) created/);
  assert.ok(match, `finding_add output did not contain a finding id: ${addOutput}`);
  return match![1];
}

function assertFindingResolveAdvisory(): void {
  const savedAgent = process.env.PROOF_OR_STOP_AGENT;
  delete process.env.PROOF_OR_STOP_AGENT; // agent='main' avoids the reviewer review-run binding requirement
  try {
    // ── happy path: advisory text present, commitHint preserved as a prefix ──
    {
      const root = mkFindingProject();
      try {
        const ctx = mkCtx(root);
        const findingHandlers = createFindingHandlers(ctx);
        const storyId = 'B-devmem-find-happy';
        seedFindingStory(ctx.store, storyId);
        const addOut = findingHandlers.finding_add({ storyId, desc: 'a real bug worth remembering', severity: 'medium', category: 'edge', agent: 'main' });
        const fid = extractFindingId(addOut);
        const resolveOut: string = findingHandlers.finding_resolve({ storyId, findingId: fid, resolution: 'fixed the root cause' });
        check('CHK-002 happy: finding_resolve output still reports resolved', /Finding .* resolved/.test(resolveOut));
        check('CHK-002 happy: advisory text mentions dev_memory_capture', /dev_memory_capture/.test(resolveOut));
        check('CHK-002 happy: advisory text is a suffix AFTER the base "resolved" text, not a replacement',
          resolveOut.indexOf('resolved') < resolveOut.indexOf('dev_memory_capture'));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    // ── scoped: no other command emits the advisory ──
    {
      const root = mkFindingProject();
      try {
        const ctx = mkCtx(root);
        const findingHandlers = createFindingHandlers(ctx);
        const storyId = 'B-devmem-find-scope';
        seedFindingStory(ctx.store, storyId);
        const addOut = findingHandlers.finding_add({ storyId, desc: 'unrelated finding', severity: 'low', category: 'edge', agent: 'main' });
        check('CHK-002 scope: finding_add output does NOT carry the dev_memory_capture advisory', !/dev_memory_capture/.test(addOut));
        const listOut = JSON.stringify(findingHandlers.finding_list({ storyId }));
        check('CHK-002 scope: finding_list output does NOT carry the dev_memory_capture advisory', !/dev_memory_capture/.test(listOut));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    // ── adversarial fail-safe: memory-subsystem throw must not break finding_resolve ──
    {
      const root = mkFindingProject();
      try {
        // Force buildMemoryFreshnessPack to throw: replace experience.jsonl with a
        // DIRECTORY so readFileSync throws EISDIR deep inside readProjectMemoryEntries.
        // B-cc10: sabotage the CANONICAL path — at the deprecated one this fail-safe test
        // was a silent no-op, so the advisory assertion below was never really exercised.
        mkdirSync(join(root, PROOF_OR_STOP_STATE_DIR, 'dev-memory', 'experience.jsonl'), { recursive: true });
        const ctx = mkCtx(root);
        const findingHandlers = createFindingHandlers(ctx);
        const storyId = 'B-devmem-find-failsafe';
        seedFindingStory(ctx.store, storyId);
        const addOut = findingHandlers.finding_add({ storyId, desc: 'trivial typo fix', severity: 'low', category: 'edge', agent: 'main' });
        const fid = extractFindingId(addOut);

        let resolveOut = '';
        let threw = false;
        try {
          resolveOut = findingHandlers.finding_resolve({ storyId, findingId: fid });
        } catch {
          threw = true;
        }
        check('CHK-002 fail-safe: finding_resolve did NOT throw despite the forced memory-subsystem failure', threw === false);
        check('CHK-002 fail-safe: finding_resolve output still reports resolved', /Finding .* resolved/.test(resolveOut));
        check('CHK-002 fail-safe: advisory silently became empty (no dev_memory_capture text) on throw', !/dev_memory_capture/.test(resolveOut));
        const stored = ctx.store.readFindings(storyId).findings.find(f => f.id === fid);
        check('CHK-002 fail-safe: the finding mutation itself was NOT blocked by the memory-subsystem failure', stored?.status === 'resolved');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    // ── adversarial: an invalid findingId error is not masked by the advisory path ──
    {
      const root = mkFindingProject();
      try {
        const ctx = mkCtx(root);
        const findingHandlers = createFindingHandlers(ctx);
        const storyId = 'B-devmem-find-invalid';
        seedFindingStory(ctx.store, storyId);
        assert.throws(
          () => findingHandlers.finding_resolve({ storyId, findingId: 'F-does-not-exist' }),
          /not found/,
          'an invalid findingId must still surface the real finding_resolve error',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = savedAgent;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CHK-003: dev_memory_finish_decision DONE-gate requirement
// ─────────────────────────────────────────────────────────────────────────

/**
 * A fully DONE-ready fixture EXCEPT for the finish-decision record: PASS test
 * evidence, a signed fresh delivery-check, and a DOCS-ONLY story-owned diff
 * (so review-assurance-floor / review-escalation see zero material code and
 * require zero host-verdict rounds) — isolating dev_memory_finish_decision as
 * the ONLY toggled blocking factor under test.
 */
function buildDoneReadyFixture(storyId: string): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-devmem-done-'));
  writeConfig(root);
  write(root, 'README.md', '# dev-memory lifecycle gates smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'docs/requirements/decisions/smoke-note.md', '# smoke note\n');
  git(root, ['add', 'docs/requirements/decisions/smoke-note.md']);
  git(root, ['commit', '-m', 'docs note']);

  const store = new StoryStore(root);
  store.writeStory(storyId, syntheticStory(storyId, 'TEST'));
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a materialHash');
  store.writeTestEvidence(storyId, {
    command: 'dev-memory-lifecycle-gates-smoke',
    output: JSON.stringify({ allPass: true, summary: 'dev-memory-lifecycle-gates smoke validation passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
  });

  const deliveryHandlers = createDeliveryCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  deliveryHandlers.delivery_check_set({
    storyId,
    docsPromises: [],
    realMachineTests: [{ featureId: 'CHK-003', transcript: 'dev-memory finish-decision DONE gate smoke transcript' }],
    closingSelfCheck: {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'Smoke covers real DONE-gate behavior end to end.',
    },
    agentId: 'proof-or-stop-review-delivery',
  });

  return { root, store };
}

function assertDoneGateFinishDecision(): void {
  const storyId = 'B-devmem-done';
  const { root, store } = buildDoneReadyFixture(storyId);
  try {
    const context: StoryMachineContext = { storyId, store, projectRoot: root, gitCwd: root };

    check('CHK-003 refusal: fixture has no finish-decision record yet', readDevMemoryFinishDecision(root, storyId) === null);
    check('CHK-003 refusal: canFinishGuard is false with no finish-decision record', canFinishGuard(context) === false);
    const reasonBefore = getGuardFailureReason(storyId, store, 'DONE', root, root);
    check('CHK-003 refusal: message tags missing_dev_memory_finish_decision',
      /\[missing_dev_memory_finish_decision\]/.test(reasonBefore ?? ''));
    check('CHK-003 refusal: message names the run-command hint',
      /(?:proof-or-stop|proofOrStop) dev_memory_finish_decision --storyId=/.test(reasonBefore ?? ''));

    const runtimeHandlers = createPlaybookRuntimeMemoryHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    const decisions: Array<{ decision: 'captured' | 'no-reusable-lesson' | 'defer-with-reason'; reason?: string }> = [
      { decision: 'captured' },
      { decision: 'no-reusable-lesson', reason: 'nothing here was a genuinely reusable lesson' },
      { decision: 'defer-with-reason', reason: 'deferring capture until a follow-up story' },
    ];
    const materialHashBeforeAnyDecision = currentMaterialHash(root, 'HEAD', root);
    for (const { decision, reason } of decisions) {
      runtimeHandlers.dev_memory_finish_decision({ storyId, decision, ...(reason ? { reason } : {}) });
      check(`CHK-003 pass: canFinishGuard is true after decision=${decision}`, canFinishGuard(context) === true);
      const reasonAfter = getGuardFailureReason(storyId, store, 'DONE', root, root);
      check(`CHK-003 pass: getGuardFailureReason no longer names missing_dev_memory_finish_decision (decision=${decision})`,
        !/missing_dev_memory_finish_decision/.test(reasonAfter ?? ''));
    }
    // F-005 regression: finishDecisionPath writes OUTSIDE the story dir, where
    // autoCommitStoryMetadata never reaches it -- left unclassified, an
    // uncommitted write here previously fell through to unexpected_dirty_files
    // (blocking review_run_start and other dirty-tree gates, found live during
    // B-a7c5's own REVIEW round 3). The runtime-artifact-registry entry must
    // recognize the path as a non-blocking runtime artifact AND exclude it from
    // materialHash so an already-signed delivery-check/test-evidence binding
    // is never retroactively invalidated by writing this file.
    const registryEntry = findRuntimeArtifactEntry(`${PROOF_OR_STOP_STATE_DIR}/dev-memory/finish-decisions/${storyId}.json`);
    check('CHK-003 F-005: finish-decision path is a recognized runtime-artifact-registry entry (non-blocking, not unexpected_dirty_files)',
      registryEntry?.id === 'dev-memory-finish-decision');
    check('CHK-003 F-005: finish-decision path is materialHash-excluded',
      registryEntry?.materialHash === 'exclude');
    const materialHashAfterDecisions = currentMaterialHash(root, 'HEAD', root);
    check('CHK-003 F-005: writing/updating the finish-decision record 3x never perturbs currentMaterialHash (write-only, before any commit)',
      materialHashAfterDecisions === materialHashBeforeAnyDecision);
    // F-006 (round-4 quality finding): a write-only check is non-discriminating
    // -- currentMaterialHash reads git ls-tree (committed state), so it passes
    // identically whether or not the registry exclusion exists, since a bare
    // writeFileSync never touches HEAD either way. The REAL regression this
    // guards against only manifests once the file is actually COMMITTED (the
    // reverted auto-commit draft moved HEAD and broke delivery-check
    // freshness). Commit the finish-decision file here and re-check
    // materialHash across that commit -- this is the assertion that would have
    // caught the reverted approach and now proves the registry exclusion still
    // holds even if the file is committed by some other means (e.g. a future
    // autoCommitStoryMetadata sweep of the story dir, or a manual commit).
    git(root, ['add', '--', `${PROOF_OR_STOP_STATE_DIR}/dev-memory/finish-decisions/${storyId}.json`]);
    git(root, ['commit', '-m', 'commit the finish-decision record for the F-005/F-006 regression check']);
    const materialHashAfterCommit = currentMaterialHash(root, 'HEAD', root);
    check('CHK-003 F-006: materialHash is unchanged even after the finish-decision file is actually COMMITTED (the real regression scenario)',
      materialHashAfterCommit === materialHashBeforeAnyDecision);
    check('CHK-003 F-006: canFinishGuard remains true after the finish-decision file is committed (no retroactive staleness from the commit)',
      canFinishGuard(context) === true);

    // ── adversarial: fail-closed on a corrupt record ──
    const finishDecisionPath = `${PROOF_OR_STOP_STATE_DIR}/dev-memory/finish-decisions/${storyId}.json`;
    write(root, finishDecisionPath, '{ not valid json ::::');
    check('CHK-003 adversarial: readDevMemoryFinishDecision treats corrupt JSON as absent (fail-closed)',
      readDevMemoryFinishDecision(root, storyId) === null);
    check('CHK-003 adversarial: canFinishGuard is false again on a corrupt finish-decision record', canFinishGuard(context) === false);

    // ── adversarial: wrong decision value / missing decision field ──
    write(root, finishDecisionPath, JSON.stringify({ schemaVersion: 'proofbound.dev-memory-finish-decision.v1', storyId, decision: 'invented-value', reason: 'x'.repeat(10), recordedAt: NOW }));
    check('CHK-003 adversarial: an invented decision value is treated as absent', readDevMemoryFinishDecision(root, storyId) === null);
    check('CHK-003 adversarial: canFinishGuard is false on an invented decision value', canFinishGuard(context) === false);

    // ── adversarial: cross-story record cannot satisfy this story's gate ──
    write(root, finishDecisionPath, JSON.stringify({ schemaVersion: 'proofbound.dev-memory-finish-decision.v1', storyId: 'B-someone-else', decision: 'captured', reason: '', recordedAt: NOW }));
    check('CHK-003 adversarial: a record naming a DIFFERENT storyId is treated as absent', readDevMemoryFinishDecision(root, storyId) === null);
    check('CHK-003 adversarial: canFinishGuard is false on a cross-story record', canFinishGuard(context) === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────

assertAllFourDevDoorsGated();
assertAckRoundTripAndExistenceOnly();
assertAckFailClosedOnCorruption();
assertGenuineIoFaultPropagatesToDoorFailOpen();
assertReasonedDowngradeBypass();
assertFindingResolveAdvisory();
assertDoneGateFinishDecision();

console.log(`dev-memory-lifecycle-gates smoke passed: ${passed} assertions`);
