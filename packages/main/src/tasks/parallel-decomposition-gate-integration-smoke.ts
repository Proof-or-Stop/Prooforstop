#!/usr/bin/env node
/**
 * B-086b (Story 5): parallel-decomposition hard PLAN→DEV gate INTEGRATION smoke.
 *
 * Drives the REAL machine.ts oracle (canStartDevGuard) and the REAL message renderer
 * (getGuardFailureReason(storyId, store, 'DEV', root)) through a hermetic temp git repo +
 * StoryStore, exactly the proven seam used by evidence-state-gate-smoke.ts.
 *
 * The single most important property under test is FAIL-OPEN (assertion #6): a gate/config
 * infra error inside the parallel sub-check must NEVER block PLAN→DEV when the review is clean.
 *
 * Matrix (each asserted below):
 *   1. literal tier-1 overlap + mode=block + clean review  -> guard FALSE + message names peer/path
 *   2. disjoint write-sets    + mode=block + clean review  -> guard TRUE + no parallel message
 *   3. SAME overlap under mode=advise AND mode=off         -> guard TRUE (advise/off never block)
 *   4. broad glob (src/**) + parallelSafe=yes + active peer + mode=block + broadGlobBlocks=true
 *                                                          -> guard FALSE (broad_glob_unprovable_parallel)
 *   5. unclean / missing review (blockerCount>0 / none)    -> guard FALSE regardless of parallel cfg
 *   6. FAIL-OPEN: parallel sub-check THROWS (corrupt peer index.json) + clean review
 *                                                          -> guard TRUE + parallel message null  [KEY]
 *   7. decision/message parity: blocked => both fire; clean => neither.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { canStartDevGuard, canSkipPlanGuard, canReenterDevGuard, getGuardFailureReason } from '../core/machine.js';
import type { StoryMachineContext } from '../core/machine.js';
import type { ChecklistData, ReviewData, ScopeCheckData, ScopeContractData, StoryInfo } from '../core/types.js';
import type { ParallelGateMode } from '../core/parallel-decomposition.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    console.error(`✗ ${name}`);
    throw new Error(`parallel-decomposition-gate-integration assertion failed: ${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';
const SELF_ID = 'B-self';
const PEER_ID = 'B-peer';
const NOW = '2026-06-19T12:00:00.000Z';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A clean (zero-blocker), correctly-signed review.json that passes canStartDevGuard's review gate. */
function cleanReview(storyId: string): ReviewData {
  const timestamp = NOW;
  const issueCount = 0;
  const blockerCount = 0;
  const hashInput = `${storyId}:${timestamp}:${issueCount}:${blockerCount}:${REVIEW_SALT}`;
  const _hash = createHash('sha256').update(hashInput).digest('hex');
  return { reviews: [{ timestamp, issueCount, blockerCount, issues: [], _hash }] };
}

/** A correctly-signed but UNCLEAN review (blockerCount>0) — the existing review gate must block. */
function blockerReview(storyId: string): ReviewData {
  const timestamp = NOW;
  const issueCount = 1;
  const blockerCount = 1;
  const hashInput = `${storyId}:${timestamp}:${issueCount}:${blockerCount}:${REVIEW_SALT}`;
  const _hash = createHash('sha256').update(hashInput).digest('hex');
  return {
    reviews: [{ timestamp, issueCount, blockerCount, issues: [{ severity: 'high', message: 'open blocker' } as never], _hash }],
  };
}

/** A correctly-signed review with an arbitrary (possibly negative) blockerCount. The F-002
 *  `> 0` bug would have let blockerCount=-1 pass as clean; strict `!== 0` must reject it. */
function signedReview(storyId: string, issueCount: number, blockerCount: number): ReviewData {
  const timestamp = NOW;
  const hashInput = `${storyId}:${timestamp}:${issueCount}:${blockerCount}:${REVIEW_SALT}`;
  const _hash = createHash('sha256').update(hashInput).digest('hex');
  return { reviews: [{ timestamp, issueCount, blockerCount, issues: [], _hash }] };
}

function story(id: string, phase: StoryInfo['phase'], parallelSafe: StoryInfo['parallelSafe']): StoryInfo {
  return {
    storyId: id,
    name: `${id}-name`,
    title: `${id} title`,
    description: 'integration smoke synthetic story',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    parallelSafe,
  };
}

function contract(id: string, allowedModify: string[], allowedCreate: string[]): ScopeContractData {
  return {
    storyId: id,
    mode: 'enforce',
    allowedModify,
    allowedCreate,
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const doneChecklist: ChecklistData = {
  items: [{ id: 'CHK-001', title: 'done', context: 'synthetic', status: 'done', startTime: NOW, endTime: NOW }],
};

/**
 * Build a hermetic temp repo: proof-or-stop.config.json (balanced profile), an optional
 * .proof-or-stop/audit-config.json carrying parallelGate, the self story + a peer, their scope
 * contracts, and the self story's review.json. Returns the root + store + context.
 */
function buildRepo(opts: {
  profile?: 'light' | 'balanced' | 'strict';
  parallelMode?: ParallelGateMode;
  broadGlobBlocks?: boolean;
  selfPhase?: StoryInfo['phase'];
  selfChecklist?: ChecklistData;
  selfParallelSafe: StoryInfo['parallelSafe'];
  peerParallelSafe: StoryInfo['parallelSafe'];
  selfModify: string[];
  selfCreate: string[];
  peerModify: string[];
  peerCreate: string[];
  review: ReviewData | null;
  /** When set, write a CORRUPT (non-JSON) peer index.json AFTER a valid one to force a throw. */
  corruptPeerStory?: boolean;
  /** Omit the peer's scope-contract.json entirely (peer_contract_unreadable test). */
  omitPeerContract?: boolean;
  /** An optional EXTRA terminal (DONE) parallel peer that also overlaps self — used to prove the
   *  failure message names the ACTIVE peer, not the terminal one. Sorts earlier than B-peer. */
  doneOverlapPeerId?: string;
  /** Additional ACTIVE (phase=DEV) parallelSafe=yes peers with explicit write-sets — for F-007
   *  (a tier-2-wildcard-only peer that must NOT be named as a literal collision). */
  extraPeers?: Array<{ id: string; modify: string[]; create: string[] }>;
}): { root: string; store: StoryStore; context: StoryMachineContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-pdgi-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: opts.profile ?? 'balanced' },
  }));
  if (opts.parallelMode) {
    // B-cc10: resolveAuditConfig reads `${PROOF_OR_STOP_DIR}/audit-config.json`, so writing
    // it under the deprecated dir meant the parallelGate config never loaded and
    // canStartDevGuard returned FALSE — the fixture was configuring a file nobody read.
    write(root, `${PROOF_OR_STOP_STATE_DIR}/audit-config.json`, JSON.stringify({
      parallelGate: {
        mode: opts.parallelMode,
        maxConcurrentReview: 3,
        broadGlobBlocks: opts.broadGlobBlocks ?? false,
      },
    }));
  }
  write(root, 'README.md', 'parallel-decomposition gate integration smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  store.writeStory(SELF_ID, story(SELF_ID, opts.selfPhase ?? 'PLAN', opts.selfParallelSafe));
  // B-a7c5 CHK-001: canStartDevGuard/canSkipPlanGuard/canReenterDevGuard now ALSO
  // require a dev-memory preflight acknowledgement. This file exists to test the
  // PARALLEL-decomposition block specifically, so every fixture writes a
  // satisfying ack up front — otherwise every DEV-door assertion below would
  // observe missing_dev_memory_preflight_ack instead of the parallel-specific
  // block/message this file exists to test.
  store.writeDevMemoryPreflightAck(SELF_ID, {
    schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1',
    storyId: SELF_ID,
    packDigest: 'parallel-decomposition-gate-integration-smoke-synthetic-digest',
    topHitIds: [],
    acknowledgedAt: NOW,
    acknowledgedBy: 'parallel-decomposition-gate-integration-smoke',
  });
  store.writeChecklist(SELF_ID, opts.selfChecklist ?? doneChecklist);
  store.writeScopeContract(SELF_ID, contract(SELF_ID, opts.selfModify, opts.selfCreate));
  if (opts.review) store.writeReview(SELF_ID, opts.review);
  // Run 16 (lab scope-check-required): balanced/strict PLAN→DEV also requires the
  // scope-plan reviewer verdict, checked before the parallel block. This file tests
  // the parallel block, so every fixture carries a scope-check.json (presence is
  // what the DEV guard reads; its signature is story_review's check).
  store.writeScopeCheck(SELF_ID, {
    storyId: SELF_ID, checkedAt: NOW, reviewRound: '', agentId: 'proof-or-stop-review-scope-plan',
    issues: [], features: [], summary: { total: 0, covered: 0, excluded: 0, gaps: 0 },
  } as unknown as ScopeCheckData);

  store.writeStory(PEER_ID, story(PEER_ID, 'DEV', opts.peerParallelSafe));
  if (!opts.omitPeerContract) store.writeScopeContract(PEER_ID, contract(PEER_ID, opts.peerModify, opts.peerCreate));

  if (opts.doneOverlapPeerId) {
    // A DONE (terminal) parallelSafe=yes peer whose write-set ALSO literally overlaps self.
    store.writeStory(opts.doneOverlapPeerId, story(opts.doneOverlapPeerId, 'DONE', 'yes'));
    store.writeScopeContract(opts.doneOverlapPeerId, contract(opts.doneOverlapPeerId, opts.selfModify, []));
  }

  for (const extra of opts.extraPeers ?? []) {
    store.writeStory(extra.id, story(extra.id, 'DEV', 'yes'));
    store.writeScopeContract(extra.id, contract(extra.id, extra.modify, extra.create));
  }

  if (opts.corruptPeerStory) {
    // index.json EXISTS (so the id is still listed) but is NOT valid JSON => store.readStory throws.
    write(root, '.proof-or-stop/story/actives/' + PEER_ID + '/index.json', '{ this is not valid json ::::');
  }

  const context: StoryMachineContext = { storyId: SELF_ID, store, projectRoot: root };
  return { root, store, context };
}

// ── 1. literal tier-1 overlap + mode=block + clean review -> guard FALSE + message names peer/path ──
function assertOverlapBlocks(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: ['src/core/self-only.ts'],
    peerModify: ['src/core/shared.ts'], // tier-1 literal collision
    peerCreate: ['src/core/peer-only.ts'],
    review: cleanReview(SELF_ID),
  });
  try {
    check('1: overlap+block+clean review -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('1: overlap message is non-null', reason !== null);
    check('1: overlap message names the block reason', /overlap_declared_parallel/.test(reason ?? ''));
    check('1: overlap message names the peer', (reason ?? '').includes(PEER_ID));
    check('1: overlap message names the colliding path', (reason ?? '').includes('src/core/shared.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 2. disjoint write-sets + mode=block + clean review -> guard TRUE + no parallel message ──
function assertDisjointPasses(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/self-a.ts'],
    selfCreate: ['src/core/self-b.ts'],
    peerModify: ['src/core/peer-a.ts'],
    peerCreate: ['src/core/peer-b.ts'],
    review: cleanReview(SELF_ID),
  });
  try {
    check('2: disjoint+block+clean -> canStartDevGuard TRUE', canStartDevGuard(context) === true);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('2: disjoint -> no parallel-decomposition message', !/parallel-decomposition/.test(reason ?? ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 3. SAME overlap under mode=advise AND mode=off -> guard TRUE (advise/off never hard-block) ──
function assertAdviseAndOffDoNotBlock(): void {
  for (const mode of ['advise', 'off'] as const) {
    const { root, store, context } = buildRepo({
      parallelMode: mode,
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/shared.ts'],
      selfCreate: [],
      peerModify: ['src/core/shared.ts'],
      peerCreate: [],
      review: cleanReview(SELF_ID),
    });
    try {
      check(`3: overlap under mode=${mode} -> canStartDevGuard TRUE`, canStartDevGuard(context) === true);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      check(`3: overlap under mode=${mode} -> no parallel block message`, !/parallel-decomposition/.test(reason ?? ''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ── 4. broad glob + parallelSafe=yes + active peer + mode=block + broadGlobBlocks=true -> guard FALSE ──
function assertBroadGlobBlocksUnderStrict(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    broadGlobBlocks: true,
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: [],
    selfCreate: ['src/**'], // broad subtree at near-root => classifyBroadness => broad
    peerModify: ['docs/other.ts'],
    peerCreate: ['docs/peer.ts'],
    review: cleanReview(SELF_ID),
  });
  try {
    check('4: broad glob + broadGlobBlocks -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('4: broad glob message names broad_glob_unprovable_parallel', /broad_glob_unprovable_parallel/.test(reason ?? ''));
    check('4: broad glob message names the broad glob', (reason ?? '').includes('src/**'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 5. unclean / missing review -> guard FALSE regardless of parallel config (no regression) ──
function assertUncleanReviewStillBlocks(): void {
  // 5a: blocker review present + DISJOINT write-sets (parallel would pass) => still blocked by review gate.
  {
    const { root, store, context } = buildRepo({
      parallelMode: 'block',
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/self-a.ts'],
      selfCreate: [],
      peerModify: ['src/core/peer-a.ts'],
      peerCreate: [],
      review: blockerReview(SELF_ID),
    });
    try {
      check('5a: unclean review -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      check('5a: unclean review -> reason names the review blocker (not parallel)', /unresolved blocker/.test(reason ?? ''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // 5b: no review at all => review gate blocks.
  {
    const { root, store, context } = buildRepo({
      parallelMode: 'block',
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/self-a.ts'],
      selfCreate: [],
      peerModify: ['src/core/peer-a.ts'],
      peerCreate: [],
      review: null,
    });
    try {
      check('5b: missing review -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      check('5b: missing review -> reason non-null (review gate)', reason !== null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ── 6. FAIL-OPEN [KEY]: parallel sub-check THROWS + clean review -> guard TRUE + parallel message null ──
function assertFailOpen(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'], // would overlap if the gate ran...
    selfCreate: [],
    peerModify: ['src/core/shared.ts'],
    peerCreate: [],
    review: cleanReview(SELF_ID),
    corruptPeerStory: true, // ...but store.readStory(peer) THROWS inside the helper => fail-open
  });
  try {
    // The corrupt peer index.json makes parallelDecompositionEnforcedBlock throw; the OWN nested
    // catch in canStartDevGuard must swallow it and fall through to `return true`.
    check('6: FAIL-OPEN: parallel sub-check throws + clean review -> canStartDevGuard TRUE', canStartDevGuard(context) === true);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('6: FAIL-OPEN: getGuardFailureReason returns null for the parallel branch on a gate error', reason === null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 7. decision/message parity: blocked => both fire; clean => neither ──
function assertParity(): void {
  // blocked case (overlap): canStartDevGuard FALSE AND message non-null about the block.
  {
    const { root, store, context } = buildRepo({
      parallelMode: 'block',
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/shared.ts'],
      selfCreate: [],
      peerModify: ['src/core/shared.ts'],
      peerCreate: [],
      review: cleanReview(SELF_ID),
    });
    try {
      const guard = canStartDevGuard(context);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      check('7: parity blocked -> guard FALSE && parallel message present',
        guard === false && /parallel-decomposition/.test(reason ?? ''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // clean case (disjoint): canStartDevGuard TRUE AND no parallel message.
  {
    const { root, store, context } = buildRepo({
      parallelMode: 'block',
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/self-a.ts'],
      selfCreate: [],
      peerModify: ['src/core/peer-a.ts'],
      peerCreate: [],
      review: cleanReview(SELF_ID),
    });
    try {
      const guard = canStartDevGuard(context);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      check('7: parity clean -> guard TRUE && no parallel message',
        guard === true && !/parallel-decomposition/.test(reason ?? ''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ── bonus: unreadable peer contract under mode=block => peer_contract_unreadable_parallel block ──
function assertPeerContractUnreadableBlocks(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/self-a.ts'],
    selfCreate: [],
    peerModify: [],
    peerCreate: [],
    review: cleanReview(SELF_ID),
    omitPeerContract: true, // peer asserts parallel but its contract is unreadable (missing) => fail-CLOSED block
  });
  try {
    check('bonus: unreadable peer contract -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('bonus: unreadable peer contract -> peer_contract_unreadable_parallel message',
      /peer_contract_unreadable_parallel/.test(reason ?? ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── F-001: light profile (requireStoryReview=false) + mode=block + overlap -> guard FALSE ──
// The pre-fix early `return true` when !requireStoryReview made the hard block bypassable.
function assertLightProfileStillEnforces(): void {
  const { root, store, context } = buildRepo({
    profile: 'light', // requireStoryReview=false => NO review record needed; parallel check must still run
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'], // tier-1 literal collision
    peerCreate: [],
    review: null, // light profile does not require a review record
  });
  try {
    check('F-001: light profile (no review required) + overlap -> canStartDevGuard FALSE',
      canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('F-001: light profile -> parallel block message present + names peer',
      /overlap_declared_parallel/.test(reason ?? '') && (reason ?? '').includes(PEER_ID));
    // sanity: the SAME repo with disjoint write-sets passes (proves it is the overlap blocking, not light itself)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // companion: light profile + disjoint -> guard TRUE (no review, no overlap => allowed)
  const ok = buildRepo({
    profile: 'light',
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/self-a.ts'],
    selfCreate: [],
    peerModify: ['src/core/peer-a.ts'],
    peerCreate: [],
    review: null,
  });
  try {
    check('F-001: light profile + disjoint (no review) -> canStartDevGuard TRUE', canStartDevGuard(ok.context) === true);
  } finally {
    rmSync(ok.root, { recursive: true, force: true });
  }
}

// ── F-003: express channel (INIT_CHECK->DEV via canSkipPlanGuard) must enforce the same block ──
function assertExpressChannelEnforces(): void {
  const { root, store, context } = buildRepo({
    profile: 'balanced', // quickPath enabled, maxChecklistItems=2
    parallelMode: 'block',
    selfPhase: 'INIT_CHECK',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'], // overlap
    peerCreate: [],
    review: null, // express channel does not consult review
  });
  try {
    check('F-003: express channel + overlap -> canSkipPlanGuard FALSE (gate not bypassed)',
      canSkipPlanGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('F-003: express channel -> getGuardFailureReason renders the parallel block',
      /overlap_declared_parallel/.test(reason ?? '') && (reason ?? '').includes(PEER_ID));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // companion: express channel + disjoint -> canSkipPlanGuard TRUE (no phantom block)
  const ok = buildRepo({
    profile: 'balanced',
    parallelMode: 'block',
    selfPhase: 'INIT_CHECK',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/self-a.ts'],
    selfCreate: [],
    peerModify: ['src/core/peer-a.ts'],
    peerCreate: [],
    review: null,
  });
  try {
    check('F-003: express channel + disjoint -> canSkipPlanGuard TRUE', canSkipPlanGuard(ok.context) === true);
  } finally {
    rmSync(ok.root, { recursive: true, force: true });
  }
  // FAIL-OPEN companion: express channel + corrupt peer (gate throws) -> canSkipPlanGuard TRUE
  const fo = buildRepo({
    profile: 'balanced',
    parallelMode: 'block',
    selfPhase: 'INIT_CHECK',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'],
    peerCreate: [],
    review: null,
    corruptPeerStory: true,
  });
  try {
    check('F-003: express channel FAIL-OPEN (gate throws) -> canSkipPlanGuard TRUE', canSkipPlanGuard(fo.context) === true);
  } finally {
    rmSync(fo.root, { recursive: true, force: true });
  }
}

// ── F-002: signed review with blockerCount=-1 must NOT pass (the `> 0` bug would have let it through) ──
function assertNegativeBlockerCountStillBlocks(): void {
  const { root, store, context } = buildRepo({
    parallelMode: 'off', // isolate the review gate; parallel must not interfere
    selfParallelSafe: 'no',
    peerParallelSafe: 'no',
    selfModify: ['src/core/self-a.ts'],
    selfCreate: [],
    peerModify: ['src/core/peer-a.ts'],
    peerCreate: [],
    review: signedReview(SELF_ID, 0, -1), // correctly signed, blockerCount = -1
  });
  try {
    check('F-002: signed review blockerCount=-1 -> canStartDevGuard FALSE (strict !== 0)',
      canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
    check('F-002: blockerCount=-1 -> getGuardFailureReason names the unresolved blocker(s)',
      /unresolved blocker/.test(reason ?? ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── F-004: when self overlaps BOTH a DONE peer (sorts earlier) and an ACTIVE peer, the message
//          names the ACTIVE peer (gate's activePeers filter), never the terminal one. ──
function assertTerminalPeerNotNamed(): void {
  const DONE_PEER = 'B-aaaa'; // sorts before B-peer in listStoryIds()
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'], // active peer overlaps
    peerCreate: [],
    review: cleanReview(SELF_ID),
    doneOverlapPeerId: DONE_PEER, // DONE peer ALSO overlaps on src/core/shared.ts and sorts earlier
  });
  try {
    check('F-004: terminal-peer case -> canStartDevGuard FALSE (active peer overlap)', canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root) ?? '';
    check('F-004: message names the ACTIVE peer', reason.includes(PEER_ID));
    check('F-004: message does NOT name the DONE/terminal peer', !reason.includes(DONE_PEER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── F-006: ROLLBACK doors REVIEW→DEV and TEST→DEV must enforce the parallel block too ──
function assertRollbackDoorsEnforce(): void {
  for (const phase of ['REVIEW', 'TEST'] as const) {
    // overlap + mode=block => canReenterDevGuard FALSE AND getGuardFailureReason renders the block.
    const { root, store, context } = buildRepo({
      parallelMode: 'block',
      selfPhase: phase,
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/shared.ts'],
      selfCreate: [],
      peerModify: ['src/core/shared.ts'], // tier-1 literal collision
      peerCreate: [],
      review: cleanReview(SELF_ID), // a real rollback story may carry a clean review; must be IGNORED
    });
    try {
      check(`F-006: ${phase}→DEV rollback + overlap -> canReenterDevGuard FALSE`, canReenterDevGuard(context) === false);
      const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root);
      if (phase === 'REVIEW') {
        check('F-006: REVIEW→DEV missing inventory fails closed before legacy parallel rendering',
          /review inventory|review_inventory/i.test(reason ?? ''));
      } else {
        check('F-006: TEST→DEV rollback -> getGuardFailureReason renders the parallel block + names peer',
          /overlap_declared_parallel/.test(reason ?? '') && (reason ?? '').includes(PEER_ID));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // disjoint => allowed (no phantom block on a clean rollback).
    const ok = buildRepo({
      parallelMode: 'block',
      selfPhase: phase,
      selfParallelSafe: 'yes',
      peerParallelSafe: 'yes',
      selfModify: ['src/core/self-a.ts'],
      selfCreate: [],
      peerModify: ['src/core/peer-a.ts'],
      peerCreate: [],
      review: cleanReview(SELF_ID),
    });
    try {
      check(`F-006: ${phase}→DEV rollback + disjoint -> expected inventory/legacy outcome`,
        canReenterDevGuard(ok.context) === (phase === 'TEST'));
      const reason = getGuardFailureReason(SELF_ID, ok.store, 'DEV', ok.root);
      check(`F-006: ${phase}→DEV rollback + disjoint -> no parallel message`, !/parallel-decomposition/.test(reason ?? ''));
    } finally {
      rmSync(ok.root, { recursive: true, force: true });
    }
  }
  // REVIEW inventory is fail-closed even though the legacy peer/config rollback
  // sub-gates remain fail-open for TEST→DEV.
  const fo = buildRepo({
    parallelMode: 'block',
    selfPhase: 'REVIEW',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'],
    peerCreate: [],
    review: cleanReview(SELF_ID),
    corruptPeerStory: true,
  });
  try {
    check('F-006: REVIEW inventory missing + corrupt peer -> canReenterDevGuard FALSE', canReenterDevGuard(fo.context) === false);
    const reason = getGuardFailureReason(SELF_ID, fo.store, 'DEV', fo.root);
    check('F-006: REVIEW inventory failure is rendered before legacy fail-open branch',
      reason !== null && !/parallel-decomposition/.test(reason));
    fo.store.readReviewInventoryEpochs = (() => { throw new Error('corrupt inventory json'); }) as typeof fo.store.readReviewInventoryEpochs;
    check('F-006: unreadable REVIEW inventory artifact fails closed', canReenterDevGuard(fo.context) === false);
    check('F-006: unreadable REVIEW inventory artifact renders recovery',
      /inventory evidence is unreadable or invalid/.test(getGuardFailureReason(SELF_ID, fo.store, 'DEV', fo.root) ?? ''));
  } finally {
    rmSync(fo.root, { recursive: true, force: true });
  }
}

// ── F-007: the formatter must name the TIER-1 LITERAL-collision peer, not a tier-2 wildcard peer ──
// A wildcard-only peer (B-aaaa, sorts earliest) shares an identical wildcard with self (src/x/*) —
// a tier-2 pair where a===b — but has NO literal collision. The real block is B-peer's literal
// collision. The old `pairs.find(([a,b])=>a===b)` would mis-name B-aaaa; the fix names B-peer.
function assertFormatterNamesLiteralPeer(): void {
  const WILDCARD_PEER = 'B-aaaa'; // sorts before B-peer; shares src/x/* (tier-2 only)
  const { root, store, context } = buildRepo({
    parallelMode: 'block',
    selfParallelSafe: 'yes',
    peerParallelSafe: 'yes',
    selfModify: ['src/x/*', 'src/core/shared.ts'],
    selfCreate: [],
    peerModify: ['src/core/shared.ts'], // B-peer: genuine tier-1 literal collision
    peerCreate: [],
    review: cleanReview(SELF_ID),
    extraPeers: [{ id: WILDCARD_PEER, modify: ['src/x/*'], create: [] }], // tier-2 wildcard only, no literal
  });
  try {
    check('F-007: literal-collision -> canStartDevGuard FALSE', canStartDevGuard(context) === false);
    const reason = getGuardFailureReason(SELF_ID, store, 'DEV', root) ?? '';
    check('F-007: message names the LITERAL-collision peer (B-peer)', reason.includes(PEER_ID));
    check('F-007: message cites the literal path, not the wildcard', reason.includes('src/core/shared.ts'));
    check('F-007: message does NOT name the tier-2 wildcard-only peer', !reason.includes(WILDCARD_PEER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertOverlapBlocks();
assertDisjointPasses();
assertAdviseAndOffDoNotBlock();
assertBroadGlobBlocksUnderStrict();
assertUncleanReviewStillBlocks();
assertFailOpen();
assertParity();
assertPeerContractUnreadableBlocks();
assertLightProfileStillEnforces();
assertExpressChannelEnforces();
assertNegativeBlockerCountStillBlocks();
assertTerminalPeerNotNamed();
assertRollbackDoorsEnforce();
assertFormatterNamesLiteralPeer();

console.log(`parallel-decomposition-gate-integration smoke passed: ${passed} assertions`);
