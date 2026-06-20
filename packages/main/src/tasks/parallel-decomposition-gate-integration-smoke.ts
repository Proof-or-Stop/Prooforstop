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
import { canStartDevGuard, getGuardFailureReason } from '../core/machine.js';
import type { StoryMachineContext } from '../core/machine.js';
import type { ChecklistData, ReviewData, ScopeContractData, StoryInfo } from '../core/types.js';
import type { ParallelGateMode } from '../core/parallel-decomposition.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    console.error(`✗ ${name}`);
    throw new Error(`parallel-decomposition-gate-integration assertion failed: ${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

const REVIEW_SALT = 'koala-review-integrity-v1';
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
 * Build a hermetic temp repo: lattice.config.json (balanced profile), an optional
 * .lattice/audit-config.json carrying parallelGate, the self story + a peer, their scope
 * contracts, and the self story's review.json. Returns the root + store + context.
 */
function buildRepo(opts: {
  parallelMode?: ParallelGateMode;
  broadGlobBlocks?: boolean;
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
}): { root: string; store: StoryStore; context: StoryMachineContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-pdgi-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }));
  if (opts.parallelMode) {
    write(root, '.lattice/audit-config.json', JSON.stringify({
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
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  store.writeStory(SELF_ID, story(SELF_ID, 'PLAN', opts.selfParallelSafe));
  store.writeChecklist(SELF_ID, doneChecklist);
  store.writeScopeContract(SELF_ID, contract(SELF_ID, opts.selfModify, opts.selfCreate));
  if (opts.review) store.writeReview(SELF_ID, opts.review);

  store.writeStory(PEER_ID, story(PEER_ID, 'DEV', opts.peerParallelSafe));
  if (!opts.omitPeerContract) store.writeScopeContract(PEER_ID, contract(PEER_ID, opts.peerModify, opts.peerCreate));

  if (opts.corruptPeerStory) {
    // index.json EXISTS (so the id is still listed) but is NOT valid JSON => store.readStory throws.
    write(root, '.lattice/story/actives/' + PEER_ID + '/index.json', '{ this is not valid json ::::');
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

assertOverlapBlocks();
assertDisjointPasses();
assertAdviseAndOffDoNotBlock();
assertBroadGlobBlocksUnderStrict();
assertUncleanReviewStillBlocks();
assertFailOpen();
assertParity();
assertPeerContractUnreadableBlocks();

console.log(`parallel-decomposition-gate-integration smoke passed: ${passed} assertions`);
