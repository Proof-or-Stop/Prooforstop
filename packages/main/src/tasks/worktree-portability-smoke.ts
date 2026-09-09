#!/usr/bin/env node

/**
 * B-231d smoke: worktree/host portability of story-scoped validation coordination.
 *
 * Proves the three deliverables against a REAL temp repository with a REAL linked
 * git worktree (so `git rev-parse --git-common-dir` genuinely resolves the shared
 * root for both roots), plus a non-git temp dir for the fallback path:
 *
 *   CHK-001  validationExecutionLockPath roots the lock at the shared git-common-dir
 *            repo root, so two worktrees of the same story mint ONE lock; different
 *            storyIds still differ; a non-git dir falls back without throwing.
 *   CHK-002  buildDoneRequiredCommandSpecEnvelope digests a repo-relative logical
 *            cwd, so the same logical command digests identically under two roots;
 *            genuinely different commands differ; a legacy absolute-cwd (v1) receipt
 *            still verifies under the migration.
 *   CHK-003  resolvedCwd records the absolute physical path but is EXCLUDED from the
 *            digest — changing only provenance leaves the digest equal.
 *
 * Plus regression coverage for the REVIEW fixes:
 *   F-001    a receipt written under worktree root A verifies (no receipt-cwd-mismatch)
 *            under main root B via validateRequiredReceiptCoverage; a genuinely
 *            different logical cwd still mismatches.
 *   F-002    varying ONLY the logical cwd (command/args/shell/env fixed) changes the
 *            digest — a regression dropping cwd from the payload would be caught.
 *   F-005    the digest binds the EXECUTED cwd, so a command configured for one cwd
 *            but run at another digests to where it really ran and is caught by
 *            receipt coverage (receipt-cwd-mismatch) while staying digest-consistent.
 *   F-006    CORRESPONDING absolute in-workspace cwds (built relative to EACH worktree
 *            root, anchored at each projectRoot) digest identically; an out-of-
 *            workspace absolute cwd keeps a stable '..'-prefixed logical cwd
 *            (documented inherent limitation), never anchored at the shared root.
 *   F-007    the lifecycle-control runtime status probe resolves the SAME shared-root
 *            validation lock path across two worktrees (no worktree-local divergence).
 *   F-009    validateCommandSpecDigestCoverage reconstructs the expected v2 digest
 *            from the receipt's STORED logical cwd (not receipt.cwd re-anchored on the
 *            current root), so a worktree-written receipt passes digest-COVERAGE under
 *            the main root; a receipt with a forged/inconsistent cwd is still rejected.
 *   F-010    the AGGREGATE cross-root path (BOTH validateRequiredReceiptCoverage AND
 *            validateCommandSpecDigestCoverage, which evaluateDoneRequiredEvidence
 *            requires) accepts the worktree-written receipt from the main root, and
 *            still rejects a genuinely-different logical cwd (receipt-cwd-mismatch).
 *
 * Prints ✓/✗ per check; exits non-zero on the first failure; final line
 * "worktree-portability smoke passed".
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validationExecutionLockPath } from '../core/validation-execution-lock.js';
import {
  buildDoneRequiredCommandSpecEnvelope,
  buildLegacyAbsoluteCwdCommandSpecEnvelope,
  validateCommandSpecDigestCoverage,
  validateRequiredReceiptCoverage,
} from '../core/done-required-validation.js';
import { projectRuntimeClosure } from '../core/lifecycle-control/runtime/index.js';
import { StoryStore } from '../core/store.js';
import type { DoneRequiredCommandReceipt, ValidationCommand } from '../core/validation-types.js';
import type { StoryInfo } from '../core/types.js';

const cleanups: Array<() => void> = [];
function cleanupAll(): void {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* best-effort */ }
  }
}

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`✓ ${label}`);
    return;
  }
  console.error(`✗ ${label}${detail ? ' — ' + detail : ''}`);
  cleanupAll();
  process.exit(1);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  // ── Real repo + real linked worktree (shared git-common-dir) ────────────────
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-portability-smoke-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));

  const mainRoot = join(base, 'repo');
  mkdirSync(mainRoot, { recursive: true });
  git(['init', '-b', 'main'], mainRoot);
  git(['config', 'user.email', 'smoke@test.local'], mainRoot);
  git(['config', 'user.name', 'smoke'], mainRoot);
  git(['config', 'commit.gpgsign', 'false'], mainRoot);
  writeFileSync(join(mainRoot, 'seed.txt'), 'seed\n');
  git(['add', 'seed.txt'], mainRoot);
  git(['commit', '-m', 'seed'], mainRoot);

  // A linked worktree of the SAME repo/story, at a different physical root.
  const worktreeRoot = join(mainRoot, '.worktrees', 'B-port');
  git(['worktree', 'add', '-b', 'story/B-port', worktreeRoot], mainRoot);

  const STORY = 'B-port';

  // ── CHK-001: shared validation lock root ────────────────────────────────────
  const lockMain = validationExecutionLockPath(mainRoot, STORY);
  const lockWorktree = validationExecutionLockPath(worktreeRoot, STORY);
  check(
    'CHK-001 lock identity is shared across two worktree roots of the same story',
    lockMain === lockWorktree,
    `${lockMain} vs ${lockWorktree}`,
  );
  check(
    'CHK-001 different storyIds still get different locks',
    validationExecutionLockPath(mainRoot, 'B-aaaa') !== validationExecutionLockPath(mainRoot, 'B-bbbb'),
  );

  // Non-git temp dir: resolveSharedLockRoot must fall back to root verbatim
  // without throwing (plain-repo behavior unchanged).
  const nonGit = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-portability-nogit-')));
  cleanups.push(() => rmSync(nonGit, { recursive: true, force: true }));
  let nonGitThrew = false;
  let nonGitLock = '';
  try {
    nonGitLock = validationExecutionLockPath(nonGit, STORY);
  } catch {
    nonGitThrew = true;
  }
  check(
    'CHK-001 non-git dir falls back to root without throwing',
    !nonGitThrew && nonGitLock.startsWith(nonGit),
    nonGitThrew ? 'threw' : nonGitLock,
  );

  // ── F-007: lifecycle-control runtime probe uses the SHARED lock root ─────────
  // The runtime closure's validationLock status is derived from a lock PATH. That
  // path used to be hand-rolled off each worktree's OWN root, so a linked worktree
  // reported a genuinely-held lock as 'free', silently defeating cross-worktree
  // lock visibility. Prove the probe run FROM the worktree now observes a lock held
  // at the shared (main) root — i.e. it resolves the same canonical path that
  // validationExecutionLockPath returns.
  const worktreeStore = new StoryStore(worktreeRoot);
  const runtimeStory: StoryInfo = {
    storyId: STORY,
    name: 'worktree-portability',
    title: 'Worktree portability runtime lock probe',
    description: 'Synthetic story for F-007 cross-worktree validation-lock visibility.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
  };
  worktreeStore.writeStory(STORY, runtimeStory);
  worktreeStore.writeChecklist(STORY, {
    items: [{ id: 'CHK-001', title: 'x', context: 'x', status: 'in_progress', startTime: '2026-01-01T00:00:00.000Z', endTime: null }],
  });

  const freeRow = projectRuntimeClosure(worktreeStore, worktreeRoot, { storyId: STORY }).stories.find((row) => row.storyId === STORY);
  check(
    'F-007 runtime closure resolves the story row for the worktree probe',
    Boolean(freeRow),
    'no B-port row projected',
  );
  check(
    'F-007 with no lock held the worktree runtime probe reports validationLock free',
    freeRow?.locks.validationLock === 'free',
    String(freeRow?.locks.validationLock),
  );

  // Hold the lock at the SHARED (main-root) canonical path.
  const sharedLockPath = validationExecutionLockPath(mainRoot, STORY);
  check(
    'F-007 shared validation lock path is anchored at the main root, not the worktree',
    sharedLockPath.startsWith(mainRoot) && !sharedLockPath.includes('.worktrees'),
    sharedLockPath,
  );
  mkdirSync(sharedLockPath, { recursive: true });
  const heldRow = projectRuntimeClosure(worktreeStore, worktreeRoot, { storyId: STORY }).stories.find((row) => row.storyId === STORY);
  check(
    'F-007 a lock held at the shared root is SEEN as active by the WORKTREE runtime probe (hand-rolled worktree-local path reported free)',
    heldRow?.locks.validationLock === 'active',
    String(heldRow?.locks.validationLock),
  );

  // ── CHK-002: repo-relative logical cwd in the digest ────────────────────────
  const cmd: ValidationCommand = { label: 'suite', command: 'npm', args: ['test'], cwd: '.', shell: false, env: {} };
  const envMain = buildDoneRequiredCommandSpecEnvelope(mainRoot, cmd);
  const envWorktree = buildDoneRequiredCommandSpecEnvelope(worktreeRoot, cmd);
  check(
    'CHK-002 digest identical for the same logical command under two worktree roots',
    envMain.digest === envWorktree.digest,
    `${envMain.digest} vs ${envWorktree.digest}`,
  );
  check(
    'CHK-002 envelope is schema v2 with a repo-relative logical cwd',
    envMain.schema === 'proof-or-stop.command-spec.v2' && envMain.cwd === '.' && envWorktree.cwd === '.',
    `${envMain.schema} cwd=${envMain.cwd}/${envWorktree.cwd}`,
  );

  const differentCmd: ValidationCommand = { label: 'build', command: 'npm', args: ['run', 'build'], cwd: 'packages/main', shell: false, env: {} };
  check(
    'CHK-002 genuinely different commands digest differently',
    buildDoneRequiredCommandSpecEnvelope(mainRoot, differentCmd).digest !== envMain.digest,
  );

  // Legacy absolute-cwd (v1) receipt, produced by the migration builder, must
  // still verify under validateCommandSpecDigestCoverage.
  const legacyEnv = buildLegacyAbsoluteCwdCommandSpecEnvelope(worktreeRoot, cmd, {
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot,
  });
  check(
    'CHK-002 legacy envelope is schema v1 with an absolute cwd',
    legacyEnv.schema === 'proof-or-stop.command-spec.v1' && legacyEnv.cwd.startsWith(worktreeRoot),
    `${legacyEnv.schema} cwd=${legacyEnv.cwd}`,
  );
  const legacyReceipt: DoneRequiredCommandReceipt = {
    label: 'suite',
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot,
    commandSpec: legacyEnv,
    shell: false,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'x',
    outputTail: '',
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:00:00.001Z',
  };
  const legacyCoverage = validateCommandSpecDigestCoverage({ receipts: [legacyReceipt] }, worktreeRoot, [cmd]);
  check(
    'CHK-002 legacy absolute-cwd receipt still verifies under the migration',
    legacyCoverage.valid === true,
    JSON.stringify(legacyCoverage.reasons),
  );

  // ── CHK-003: physical cwd is non-digested provenance ────────────────────────
  check(
    'CHK-003 resolvedCwd records the absolute physical workspace path',
    envMain.resolvedCwd === mainRoot && envWorktree.resolvedCwd === worktreeRoot,
    `${envMain.resolvedCwd} / ${envWorktree.resolvedCwd}`,
  );
  check(
    'CHK-003 resolvedCwd is excluded from the digest (differs while digest stays equal)',
    envMain.resolvedCwd !== envWorktree.resolvedCwd && envMain.digest === envWorktree.digest,
    `${envMain.resolvedCwd} vs ${envWorktree.resolvedCwd}`,
  );

  // ── F-002: adversarial isolation of the logical cwd in the digest ───────────
  // Hold command/args/shell/env/timeout fixed and vary ONLY the logical cwd; the
  // digest MUST differ. This isolates cwd (the existing "different commands"
  // check above varies args AND cwd together), so a regression that drops `cwd`
  // from commandSpecDigestPayload would flip this to equal and be caught.
  const cwdDotCmd: ValidationCommand = { label: 'iso', command: 'npm', args: ['test'], cwd: '.', shell: false, env: {} };
  const cwdSubCmd: ValidationCommand = { label: 'iso', command: 'npm', args: ['test'], cwd: 'packages/main', shell: false, env: {} };
  const digDot = buildDoneRequiredCommandSpecEnvelope(mainRoot, cwdDotCmd).digest;
  const digSub = buildDoneRequiredCommandSpecEnvelope(mainRoot, cwdSubCmd).digest;
  check(
    'F-002 digest changes when ONLY the logical cwd varies (regression guard for dropping cwd from the payload)',
    digDot !== digSub,
    `${digDot} vs ${digSub}`,
  );

  // ── F-006: CORRESPONDING absolute in-workspace cwds are portable ────────────
  // The absolute cwd is built RELATIVE TO EACH ROOT — the real physical path a
  // command would run at in THAT worktree — not one root's path reused for both
  // (which is what the previous smoke did, so it never tested cross-worktree
  // absolute paths). Anchored at each projectRoot, both map to the SAME logical
  // 'packages/main', so the digests MUST be equal. The reverted shared-root
  // anchoring would relativize the worktree's path to '.worktrees/B-port/…'.
  const absSubMain = join(mainRoot, 'packages', 'main');
  const absSubWorktree = join(worktreeRoot, 'packages', 'main');
  const absEnvMain = buildDoneRequiredCommandSpecEnvelope(mainRoot, {
    label: 'abs', command: 'npm', args: ['run', 'build'], cwd: absSubMain, shell: false, env: {},
  });
  const absEnvWorktree = buildDoneRequiredCommandSpecEnvelope(worktreeRoot, {
    label: 'abs', command: 'npm', args: ['run', 'build'], cwd: absSubWorktree, shell: false, env: {},
  });
  check(
    'F-006 corresponding absolute in-workspace cwds digest identically across two worktree roots',
    absEnvMain.digest === absEnvWorktree.digest,
    `${absEnvMain.digest} (${absEnvMain.cwd}) vs ${absEnvWorktree.digest} (${absEnvWorktree.cwd})`,
  );
  check(
    'F-006 absolute in-workspace cwd normalizes to a projectRoot-relative logical cwd (packages/main)',
    absEnvMain.cwd === 'packages/main' && absEnvWorktree.cwd === 'packages/main',
    `${absEnvMain.cwd} / ${absEnvWorktree.cwd}`,
  );
  check(
    'F-006 worktree absolute cwd is NOT anchored at the shared root (no .worktrees prefix)',
    !absEnvWorktree.cwd.includes('.worktrees'),
    absEnvWorktree.cwd,
  );
  // An absolute path equal to the workspace root normalizes to the SAME canonical
  // '.' as a relative '.', so the two forms digest identically.
  const absRootEnv = buildDoneRequiredCommandSpecEnvelope(mainRoot, {
    label: 'absroot', command: 'npm', args: ['test'], cwd: mainRoot, shell: false, env: {},
  });
  check(
    'F-006 absolute path equal to the workspace root normalizes identically to relative `.`',
    absRootEnv.cwd === '.' && absRootEnv.digest === envMain.digest,
    `${absRootEnv.cwd} / ${absRootEnv.digest} vs ${envMain.digest}`,
  );

  // ── F-006: OUT-of-workspace absolute cwd — documented inherent limitation ────
  // A cwd outside the story's workspace genuinely cannot be made cross-root
  // portable. It must relativize to a STABLE '..'-prefixed representation (NOT
  // force-anchored into an in-workspace 'packages/main'), and remain distinct from
  // the in-workspace case.
  const outsideAbs = join(base, 'external-tool'); // sibling of mainRoot, outside the repo
  const outsideEnv = buildDoneRequiredCommandSpecEnvelope(mainRoot, {
    label: 'outside', command: 'npm', args: ['test'], cwd: outsideAbs, shell: false, env: {},
  });
  check(
    'F-006 out-of-workspace absolute cwd keeps a stable `..`-prefixed logical cwd (documented limitation)',
    outsideEnv.cwd.startsWith('..') && outsideEnv.cwd !== 'packages/main' && outsideEnv.digest !== absEnvMain.digest,
    outsideEnv.cwd,
  );

  // ── F-005: digest binds the EXECUTED cwd; configured-vs-executed drift caught ─
  // Policy configures the command for 'packages/main', but the receipt records it
  // actually running at the workspace ROOT. The receipt is internally consistent
  // (its digest faithfully binds the executed root), yet coverage MUST reject it
  // because executed('.') != configured('packages/main').
  const configuredCommand: ValidationCommand = { label: 'suite', command: 'npm', args: ['test'], cwd: 'packages/main', shell: false, env: {} };
  const ranAtRootSpec = buildDoneRequiredCommandSpecEnvelope(
    mainRoot,
    configuredCommand,
    { command: 'npm', args: ['test'], shell: false, cwd: mainRoot }, // EXECUTED at root, not packages/main
  );
  check(
    'F-005 command-spec digest binds the EXECUTED cwd (root -> `.`), not the configured `packages/main`',
    ranAtRootSpec.cwd === '.',
    ranAtRootSpec.cwd,
  );
  const ranAtRootReceipt: DoneRequiredCommandReceipt = {
    label: 'suite',
    command: 'npm',
    args: ['test'],
    cwd: mainRoot, // executed physical cwd = workspace root
    commandSpec: ranAtRootSpec,
    shell: false,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'x',
    outputTail: '',
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:00:00.001Z',
  };
  const f005DigestCoverage = validateCommandSpecDigestCoverage({ receipts: [ranAtRootReceipt] }, mainRoot, [configuredCommand]);
  check(
    'F-005 executed-cwd receipt stays internally digest-consistent (honest binding of where it ran)',
    f005DigestCoverage.valid === true,
    JSON.stringify(f005DigestCoverage.reasons),
  );
  const f005CoverageReasons = validateRequiredReceiptCoverage({ receipts: [ranAtRootReceipt] }, mainRoot, [configuredCommand]);
  check(
    'F-005 executed cwd differing from the configured cwd is caught (receipt-cwd-mismatch)',
    f005CoverageReasons.some((reason) => reason.startsWith('receipt-cwd-mismatch')),
    JSON.stringify(f005CoverageReasons),
  );

  // ── F-001: cross-root receipt coverage (receipt from worktree, verified under main) ──
  const suiteCommand: ValidationCommand = { label: 'suite', command: 'npm', args: ['test'], cwd: '.', shell: false, env: {} };
  const receiptSpecA = buildDoneRequiredCommandSpecEnvelope(worktreeRoot, suiteCommand, {
    command: 'npm', args: ['test'], shell: false, cwd: worktreeRoot,
  });
  const crossRootReceipt: DoneRequiredCommandReceipt = {
    label: 'suite',
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot, // absolute PHYSICAL path of the writing worktree (root A)
    commandSpec: receiptSpecA,
    shell: false,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'x',
    outputTail: '',
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:00:00.001Z',
  };
  const crossRootReasons = validateRequiredReceiptCoverage({ receipts: [crossRootReceipt] }, mainRoot, [suiteCommand]);
  check(
    'F-001 receipt written under worktree root verifies (no cwd-mismatch) under main root',
    crossRootReasons.length === 0,
    JSON.stringify(crossRootReasons),
  );

  // Distinguishability preserved: a receipt whose LOGICAL cwd genuinely differs
  // from the policy command still reports receipt-cwd-mismatch across roots.
  const wrongCwdSpec = buildDoneRequiredCommandSpecEnvelope(
    worktreeRoot,
    { label: 'suite', command: 'npm', args: ['test'], cwd: 'packages/main', shell: false, env: {} },
    { command: 'npm', args: ['test'], shell: false, cwd: join(worktreeRoot, 'packages', 'main') },
  );
  const wrongCwdReceipt: DoneRequiredCommandReceipt = {
    ...crossRootReceipt,
    cwd: join(worktreeRoot, 'packages', 'main'),
    commandSpec: wrongCwdSpec,
  };
  const wrongCwdReasons = validateRequiredReceiptCoverage({ receipts: [wrongCwdReceipt] }, mainRoot, [suiteCommand]);
  check(
    'F-001 genuinely different logical cwd still reports receipt-cwd-mismatch across roots',
    wrongCwdReasons.some((reason) => reason.startsWith('receipt-cwd-mismatch')),
    JSON.stringify(wrongCwdReasons),
  );

  // ── F-009/F-010: cross-root FULL command-spec digest-COVERAGE + aggregate ────
  // validateRequiredReceiptCoverage (F-001, above) accepted a cross-worktree
  // receipt, but validateCommandSpecDigestCoverage RE-normalized receipt.cwd
  // against the verifying projectRoot and wrongly rejected the SAME receipt as
  // command-spec-digest-mismatch. evaluateDoneRequiredEvidence needs BOTH paths,
  // so cross-root DONE-required verification stayed broken and the earlier smoke
  // (which never called digest-coverage cross-root) gave false confidence.
  // The receipt is built under the WORKTREE root and verified from the MAIN root.
  const digestSuiteCommand: ValidationCommand = { label: 'suite', command: 'npm', args: ['test'], cwd: '.', shell: false, env: {} };
  const worktreeReceiptSpec = buildDoneRequiredCommandSpecEnvelope(worktreeRoot, digestSuiteCommand, {
    command: 'npm', args: ['test'], shell: false, cwd: worktreeRoot,
  });
  const worktreeWrittenReceipt: DoneRequiredCommandReceipt = {
    label: 'suite',
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot, // ABSOLUTE physical path of the writing worktree (root A)
    commandSpec: worktreeReceiptSpec,
    shell: false,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'x',
    outputTail: '',
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:00:00.001Z',
  };
  const crossRootDigestCoverage = validateCommandSpecDigestCoverage(
    { receipts: [worktreeWrittenReceipt] }, mainRoot, [digestSuiteCommand],
  );
  check(
    'F-009 worktree-written receipt passes command-spec digest-COVERAGE under the main root (no command-spec-digest-mismatch)',
    crossRootDigestCoverage.valid === true
      && !crossRootDigestCoverage.reasons.some((reason) => reason.startsWith('command-spec-digest-mismatch')),
    JSON.stringify(crossRootDigestCoverage),
  );
  // The aggregate evaluateDoneRequiredEvidence requires BOTH coverage paths; prove
  // the cross-root receipt is accepted by BOTH (receipt-coverage AND digest-coverage)
  // from the main root — exactly the aggregate's cross-root acceptance decision.
  const crossRootReceiptCoverage = validateRequiredReceiptCoverage(
    { receipts: [worktreeWrittenReceipt] }, mainRoot, [digestSuiteCommand],
  );
  check(
    'F-010 aggregate cross-root: BOTH receipt-coverage AND digest-coverage accept the worktree-written receipt under the main root',
    crossRootReceiptCoverage.length === 0 && crossRootDigestCoverage.valid === true,
    `receiptCoverage=${JSON.stringify(crossRootReceiptCoverage)} digestValid=${crossRootDigestCoverage.valid}`,
  );

  // Negative 1 (digest still has teeth): a v2 receipt whose stored logical cwd is
  // FORGED — swapped to '.' AFTER the digest was computed for 'packages/main'. The
  // fix trusts spec.cwd for reconstruction, but the recomputed digest no longer
  // matches the intact stored digest, so a silently-swapped cwd field is rejected.
  const honestSubSpec = buildDoneRequiredCommandSpecEnvelope(
    worktreeRoot,
    { label: 'suite', command: 'npm', args: ['test'], cwd: 'packages/main', shell: false, env: {} },
    { command: 'npm', args: ['test'], shell: false, cwd: join(worktreeRoot, 'packages', 'main') },
  );
  const forgedCwdReceipt: DoneRequiredCommandReceipt = {
    ...worktreeWrittenReceipt,
    cwd: join(worktreeRoot, 'packages', 'main'),
    commandSpec: { ...honestSubSpec, cwd: '.' }, // cwd field swapped, digest left intact
  };
  const forgedCoverage = validateCommandSpecDigestCoverage(
    { receipts: [forgedCwdReceipt] }, mainRoot, [digestSuiteCommand],
  );
  check(
    'F-009 a receipt with a FORGED logical cwd (digest no longer matches the swapped cwd) is still rejected (command-spec-digest-mismatch)',
    forgedCoverage.valid === false
      && forgedCoverage.reasons.some((reason) => reason.startsWith('command-spec-digest-mismatch')),
    JSON.stringify(forgedCoverage),
  );

  // Negative 2 (aggregate still has teeth): a receipt whose logical cwd HONESTLY
  // differs from the policy (ran in packages/main, policy wants '.') is internally
  // digest-consistent (digest-coverage valid), yet the AGGREGATE still REJECTS it
  // because validateRequiredReceiptCoverage reports receipt-cwd-mismatch cross-root.
  const honestSubReceipt: DoneRequiredCommandReceipt = {
    ...worktreeWrittenReceipt,
    cwd: join(worktreeRoot, 'packages', 'main'),
    commandSpec: honestSubSpec,
  };
  const honestSubDigest = validateCommandSpecDigestCoverage(
    { receipts: [honestSubReceipt] }, mainRoot, [digestSuiteCommand],
  );
  const honestSubReceiptCoverage = validateRequiredReceiptCoverage(
    { receipts: [honestSubReceipt] }, mainRoot, [digestSuiteCommand],
  );
  check(
    'F-010 a genuinely-different logical cwd is internally digest-consistent yet the AGGREGATE still rejects it (receipt-cwd-mismatch)',
    honestSubDigest.valid === true
      && honestSubReceiptCoverage.some((reason) => reason.startsWith('receipt-cwd-mismatch')),
    `digest=${JSON.stringify(honestSubDigest)} receiptCoverage=${JSON.stringify(honestSubReceiptCoverage)}`,
  );

  cleanupAll();
  console.log('worktree-portability smoke passed');
} catch (err) {
  console.error('✗ worktree-portability smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  cleanupAll();
  process.exit(1);
}
