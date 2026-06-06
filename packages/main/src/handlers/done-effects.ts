/**
 * B-9027 (Lifecycle Phase 2, Story 3b): done-effects — the DONE merge /
 * worktree cleanup pipeline of story_advance.
 *
 * The DONE pipeline was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — step order, output
 * text, and failure semantics are byte-identical before and after the move
 * (Option A behavior-preserving extraction). After the B-6974 refactor,
 * handlers/transition-orchestrator.ts is the direct caller: its
 * runStoryTransition invokes the two exported functions at the exact same
 * call sites the DONE pipeline used to run them inline.
 *
 * The DONE pipeline straddles the actor.send boundary, so it is split into two
 * exported functions called at the same timing as the inline originals:
 *
 *   - runDonePreMergeGate    — block A: pre-merge gates that must run BEFORE
 *                              phase=DONE is persisted. Runs the done-oracle
 *                              gate, the F-020 stray-file dry-run, and the
 *                              merge-tree dry-run. Any failure throws while the
 *                              story is still TEST. Returns the rendered DONE
 *                              checklist string as an explicit value — the
 *                              caller holds it in a local variable across the
 *                              actor.send boundary (replaces the old global
 *                              cross-actor.send stash).
 *   - applyDoneMergeEffects  — block B: the real merge / worktree cleanup that
 *                              runs AFTER writeStory(phase=DONE). Step1 clears
 *                              the worktree field, Step2 commits metadata,
 *                              Step2.5 cleans stray whitelist files, Step3
 *                              merges the story branch, Step4 removes the
 *                              worktree, Step5 deletes the branch, then a
 *                              cleanupFailure throw and a non-blocking
 *                              maybeTriggerAudit. The caller passes in the
 *                              rendered checklist held since block A.
 *
 * Layering: this module lives in handlers/ (NOT core/) on purpose. It depends
 * on handler-only modules (phase-gates.ts, stray-file-cleanup.ts,
 * worktree.ts) and shares the layer with transition-orchestrator.ts. It must
 * NOT import handlers/transition-orchestrator.js (no circular import);
 * transition-orchestrator imports done-effects, never the reverse.
 */

import type { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { maybeTriggerAudit } from '../core/audit-trigger.js';
import { execFileSync, execSync } from 'child_process';
import { dirname, resolve, join } from 'path';
import { existsSync, rmSync } from 'fs';
import { cleanStrayWorktreeFiles } from './stray-file-cleanup.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from './worktree.js';
import { reportHealthIssue } from '../core/health.js';
import { runDoneOracleGate } from './phase-gates.js';
import type { AcquiredMkdirLock } from '../core/mkdir-lock.js';
import { acquireMainWriteLockRegistered, mainWriteLockPath } from '../core/main-write-lock.js';

// B-c622 CHK-004: DONE phase auto-sync main — detect divergence + auto merge main.
// checkMainDivergence is defined in core/done-oracle.ts and imported by
// handlers/transition-orchestrator.ts (it is a DONE pre-check that runs before
// actor.can() / before this module's gate); autoSyncMain lives here as a
// DONE-only helper.

/** Auto-sync main into the current branch. Returns success/failure + message. */
export function autoSyncMain(projectRoot: string): { ok: boolean; message: string } {
  // Try to fetch origin main first (fails silently for local-only repos)
  try {
    execSync('git fetch origin main:main', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* local-only repo or no remote — skip fetch */ }
  try {
    execSync('git merge main --no-edit', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, message: 'main has been automatically synced to the current branch' };
  } catch {
    // conflict — abort merge to keep branch clean
    try {
      execSync('git merge --abort', {
        cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* abort failed — already clean */ }
    return { ok: false, message: 'merge main has conflicts (aborted to keep branch clean).\n→ Run git merge main, resolve conflicts then git add + git commit, then rerun story_advance DONE' };
  }
}

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const target = worktreePath.replace(/\\/g, '/');
    return raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
      .includes(target);
  } catch {
    return false;
  }
}

function pruneWorktreeRegistry(repoRoot: string): void {
  execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type DoneWorktreeContext = {
  invocationCwd: string;
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
};

/**
 * Resolve the main repo root the DONE main write lock contends on. DONE may be
 * invoked from inside a story worktree (or a nested subdir of it); the lock
 * must always live at the *main* repo root so the worktree and the main
 * checkout serialize on one directory.
 */
function resolveDoneLockMainRepoRoot(projectRoot: string, invocationCwd = process.cwd()): string {
  const doneWorktree = detectDoneStoryWorktreeContext(invocationCwd);
  return doneWorktree?.mainRepoRoot ?? projectRoot;
}

/**
 * Canonical DONE main write lock directory.
 *
 * B-f60c CHK-001: this now resolves to the unified main write lock path
 * (`.koala/locks/main-write.lock/`). The former DONE-specific
 * `.koala/runtime/done-main-merge.lock` path is retired with no alias.
 */
export function doneMainMergeLockPath(projectRoot: string, invocationCwd = process.cwd()): string {
  return mainWriteLockPath(resolveDoneLockMainRepoRoot(projectRoot, invocationCwd));
}

/**
 * Acquire the unified main write lock for the DONE merge / worktree cleanup
 * critical section. Behavior-preserving wrapper over
 * `acquireMainWriteLockRegistered`: the operator-facing held message keeps the
 * legacy "DONE main merge lock is held" wording so external CLI output is
 * byte-identical.
 *
 * B-f60c CHK-003: uses the *registered* acquire so the in-process reentrancy
 * registry knows the DONE flow holds the lock. The DONE pipeline runs
 * `audit` in-process (`applyDoneMergeEffects` → `maybeTriggerAudit` →
 * full-auto `runAuditInProcess`); now that `audit` also takes the main write
 * lock, that nested call would self-deadlock on the on-disk mkdir lock. With
 * the registry, the nested `audit`'s `withReentrantMainWriteLock` sees the
 * DONE-held path and becomes a pass-through.
 */
export function acquireDoneMainMergeLock(
  storyId: string,
  projectRoot: string,
  invocationCwd = process.cwd(),
): AcquiredMkdirLock {
  const mainRepoRoot = resolveDoneLockMainRepoRoot(projectRoot, invocationCwd);
  return acquireMainWriteLockRegistered(mainRepoRoot, {
    label: 'DONE main merge',
    heldMessage:
      `DONE main merge lock is held by another Koala operation; story ${storyId} phase was not changed. ` +
      `Retry after the active DONE merge finishes.`,
  });
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/') === resolve(b).replace(/\\/g, '/');
}

export function detectDoneStoryWorktreeContext(invocationCwd = process.cwd()): DoneWorktreeContext | null {
  try {
    const resolvedInvocationCwd = resolve(invocationCwd);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDirRaw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRepoRoot = dirname(commonDirRaw);
    if (samePath(worktreeRoot, mainRepoRoot)) return null;

    return {
      invocationCwd: resolvedInvocationCwd,
      worktreeRoot: resolve(worktreeRoot),
      mainRepoRoot: resolve(mainRepoRoot),
      branch,
    };
  } catch {
    // PROBE: not in a git worktree or git metadata is unavailable.
    return null;
  }
}

export function assertDoneStoryBranchMatches(storyId: string, branch: string): void {
  const expectedBranch = `story/${storyId}`;
  if (branch !== expectedBranch) {
    throw new Error(
      `refusing DONE cleanup: detected branch ${branch} but expected ${expectedBranch}; ` +
      `merge/delete aborted before mutating story state.`,
    );
  }
}

function assertSafeResidualWorktreeRm(ctx: DoneWorktreeContext, target: string, wasRegisteredWorktree: boolean): void {
  if (!samePath(target, ctx.worktreeRoot)) {
    throw new Error(`refusing residual cleanup outside canonical worktree root: ${target}`);
  }
  if (!wasRegisteredWorktree) {
    throw new Error(`refusing residual cleanup for unregistered worktree path: ${target}`);
  }
  if (!samePath(ctx.invocationCwd, ctx.worktreeRoot) && samePath(target, ctx.invocationCwd)) {
    throw new Error(`refusing residual cleanup of nested invocation cwd: ${target}`);
  }
}

function assertDoneMergeCanApplyBeforeStateMutation(storyId: string, worktreePath: string, mainRepoRoot: string): void {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e);
    throw new Error(
      `Cannot enter DONE: story/${storyId} cannot yet cleanly merge into main; story phase not modified.\n` +
      `${detail}\n\n` +
      `→ Resolve merge conflicts with main inside the worktree first, then rerun story_advance --phase=DONE.\n` +
      `→ Run: cd "${worktreePath}" && git merge main\n` +
      `→ Main repo: ${mainRepoRoot}`,
    );
  }
}

/**
 * Block A — DONE pre-merge gate.
 *
 * Runs BEFORE phase=DONE is persisted (transition-orchestrator.ts calls this
 * just before actor.send). Runs the done-oracle gate, the F-020 stray-file
 * dry-run, and the merge-tree dry-run. Any pre-merge gate failure throws while
 * the story is still TEST — phase=DONE is never written on failure.
 *
 * Returns the rendered DONE checklist string so the caller can hold it in a
 * local variable and pass it to applyDoneMergeEffects (replaces the old
 * cross-actor.send global stash).
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path. The `actor` parameter is kept for signature
 * stability and is forwarded to runDoneOracleGate (which also no longer stops
 * it).
 */
export async function runDonePreMergeGate(
  storyId: string,
  store: StoryStore,
  root: string,
  actor: ReturnType<typeof import('../core/machine.js').createStoryActor>,
): Promise<string> {
  // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.

  const rendered = runDoneOracleGate(storyId, store, root, actor);

  // F-020 (B-9d95 Round 1 review): stray-file detection moved earlier, before phase=DONE is persisted
  // to disk. The original implementation (Step 2.5, around line 632) ran after story.phase=DONE +
  // story.worktree=undefined had already been writeStory'd; if it threw (non-whitelist
  // untracked files) the story would be stuck at DONE (merge had not happened, worktree still alive, no
  // koala self-healing path). Here we pre-check: dry-run detection, throw immediately when an offender
  // is found, keeping the phase=TEST state so the main agent can fix per the error prompt and rerun.
  //
  // whitelist files are **not deleted** here — this only handles early interception. The actual rm is deferred to
  // Step 2.5 (the merge flow after actor.send), because only then do we know the merge will definitely
  // happen. The pre-check only looks at "is there an offender":
  //   - offender exists → throw (keep files, do not persist DONE)
  //   - no offender → continue the full flow, whitelist rm executes at Step 2.5
  try {
    const doneWorktree = detectDoneStoryWorktreeContext();
    if (doneWorktree) {
      assertDoneStoryBranchMatches(storyId, doneWorktree.branch);
      // dry-run only: use git ls-files to read untracked files, classify by whitelist.
      // Offender found → throw (story.phase is still TEST at this point). No offender
      // → return without deleting anything; the actual rm of whitelist files happens later in Step 2.5.
      const { mainRepoRoot, worktreeRoot } = doneWorktree;
      const storyDir = `${store.storyDirRel()}/${storyId}/`;
      if (existsSync(join(mainRepoRoot, storyDir))) {
        let raw = '';
        try {
          raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', storyDir], {
            cwd: mainRepoRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();
        } catch { /* PROBE: ignore, let Step 2.5 handle it */ }
        const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const { STRAY_FILE_WHITELIST: WL } = await import('./stray-file-cleanup.js');
        const offenders = relPaths.filter(rel => !WL.includes(rel.split('/').pop() || rel));
        if (offenders.length > 0) {
          // Reuse cleanStrayWorktreeFiles's throw message (single source of truth),
          // passing in worktreePath so the message includes git worktree remove / branch -d guidance.
          // B-6974: the actor-stop call this path used to make was removed —
          // actor lifecycle is owned solely by transition-orchestrator.ts,
          // which stops it in a single finally on every exit path (including
          // this thrown-error path).
          cleanStrayWorktreeFiles(mainRepoRoot, storyId, worktreeRoot);
          // cleanStrayWorktreeFiles must throw when there are offenders; reaching this line
          // means logic has deviated, fallback: actively throw to prevent phase from being persisted by default.
          throw new Error(
            `Story ${storyId} DONE pre-merge stray check: detected non-whitelisted untracked files but cleanStrayWorktreeFiles did not throw (internal state deviation), blocking advance.`,
          );
        }
      }
      assertDoneMergeCanApplyBeforeStateMutation(storyId, worktreeRoot, mainRepoRoot);
    }
  } catch (e: any) {
    // The thrown error message (including stash / worktree remove guidance) propagates directly to the caller,
    // not swallowed. Only non-throw failures of the git probe itself are caught above.
    if (
      e?.message?.startsWith(`Story ${storyId} DONE `)
      || e?.message?.startsWith('Cannot enter DONE:')
      || e?.message?.startsWith('refusing DONE cleanup:')
    ) {
      throw e;
    }
    // Other unexpected cases (e.g. import failure / unknown) are converted to visible errors
    throw new Error(`DONE pre-merge precheck failed: ${e?.message ?? e}`);
  }

  return rendered;
}

/**
 * Block B — DONE merge / worktree cleanup effects.
 *
 * Runs AFTER writeStory(phase=DONE) (transition-orchestrator.ts calls this in
 * the DONE return segment). Performs the real git merge / worktree cleanup in
 * the exact step order of the inline original:
 *   Step1 clear story.worktree + writeStory
 *   Step2 commit story metadata
 *   Step2.5 cleanStrayWorktreeFiles (whitelist rm)
 *   Step3 git merge story branch into main
 *   Step4 worktree remove (+ rm -rf residue + prune)
 *   Step5 git branch -d
 *   cleanupFailure throw
 *   maybeTriggerAudit (non-blocking)
 *
 * `renderedChecklist` is the string returned by runDonePreMergeGate, held by
 * the caller across the actor.send boundary; it is prefixed onto the success
 * message via the returned `doneChecklistPrefix`.
 *
 * Returns the report pieces for the caller to splice into the advance success
 * message: `doneChecklistPrefix` (rendered checklist + blank lines) and
 * `doneMergeReport` (the merge log + optional audit hint).
 */
export async function applyDoneMergeEffects(
  storyId: string,
  store: StoryStore,
  story: StoryInfo,
  renderedChecklist: string | undefined,
): Promise<{ doneChecklistPrefix: string; doneMergeReport: string }> {
  let doneChecklistPrefix = '';
  let doneMergeReport = '';
  if (renderedChecklist) {
    doneChecklistPrefix = `${renderedChecklist}\n\n`;
  }

  // B-7eed: After DONE succeeds, automatically git merge back to main + clean worktree + delete branch.
  // CLAUDE.md promised "internal auto-merge" but the old code never implemented it, requiring manual cleanup every DONE.
  // Reuses dev_merge's logic (worktree.ts:208) but triggered via the story_advance command path (coordinated through transition-orchestrator).
  //
  // Critical execution order (cannot be reordered):
  //   1. Clear story.worktree field + writeStory (within the worktree fs)
  //   2. git add + git commit to land this step plus the prior phase=DONE changes onto the story branch
  //   3. cd to the main repo root, git merge the story branch (cannot merge itself from within the worktree)
  //   4. worktree remove
  //   5. branch -d
  // Note: cannot rely on the story.worktree field — INIT_CHECK wrote this field into the main
  // repo's index.json, but the version checked out inside the worktree is pre-INIT_CHECK,
  // does not have this field. So readStory(from worktree) always gets worktree=undefined.
  // Changed to infer from actual git state: call cwd, git top-level worktree, current branch, git common dir.
  // DONE can be triggered from worktree subdirectories, so the cleanup target must be the git top-level,
  // process.cwd() must not be treated as a deletable path.
  const doneWorktree = detectDoneStoryWorktreeContext();

  if (doneWorktree) {
    const mergeLines: string[] = [];
    const { branch, mainRepoRoot, worktreeRoot: wtPathAbs } = doneWorktree;
    assertDoneStoryBranchMatches(storyId, branch);
    {
      const runGitArgs = (gitArgs: string[], cwd: string): string =>
        execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

      // Step 1: Clear story.worktree field + endedAt + writeStory, persist metadata to disk
      story.worktree = undefined;
      story.endedAt = story.endedAt || new Date().toISOString();
      store.writeStory(storyId, story);

      // Step 2: commit all story metadata (phase=DONE + worktree=undefined +
      // endedAt + reviewer/test artifacts). dev_merge:228 uses the same trick.
      try {
        runGitArgs(['add', store.storyDirRel()], wtPathAbs);
        const staged = runGitArgs(['diff', '--cached', '--name-only'], wtPathAbs);
        if (staged) {
          runGitArgs(
            ['-c', 'commit.gpgsign=false', 'commit', '-m', `koala: mark ${storyId} DONE + clear worktree`],
            wtPathAbs,
          );
        }
      } catch { /* PROBE: nothing to commit is fine */ }

      // Step 2.5 (B-9d95 CHK-003): clean stray whitelist files before merge.
      // F-020: non-whitelist offender detection has been moved earlier to the DONE gate (before phase persistence),
      // here only handles whitelist auto rm; in theory offenders cannot reach this line (already
      // thrown above), but the throw path is kept as defense-in-depth. The third parameter
      // wtPathAbs is used for the worktree cleanup guidance in the error message (F-014).
      const strayReport = cleanStrayWorktreeFiles(mainRepoRoot, storyId, wtPathAbs);
      for (const line of strayReport) mergeLines.push(line);

      // Step 3: merge story branch from main repo root. Merge conflicts are thrown directly to the upper layer
      // to let the agent see detailed manual cleanup steps — phase is already DONE, no rollback, but
      // the user must be informed there is still manual finishing work to do.
      const mainBranch = runGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot);
      try {
        runGitArgs(
          ['-c', 'commit.gpgsign=false', 'merge', branch, '--no-ff', '-m', `merge: ${storyId} ${story.title}`],
          mainRepoRoot,
        );
        mergeLines.push(`✓ Branch ${branch} merged into ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `Story ${storyId} has been marked DONE but auto-merge failed:\n` +
          `${e.stderr?.toString() || e.message}\n\n` +
          `Please complete manually:\n` +
          `  cd "${mainRepoRoot}"\n` +
          `  git merge ${branch}\n` +
          `  git worktree remove --force "${wtPathAbs}"\n` +
          `  git branch -d ${branch}`,
        );
      }

      // Step 4: clean up worktree
      let cleanupFailure: string | null = null;
      //
      // Two-step cleanup: `git worktree remove` deregisters the worktree
      // from git's internal list (so `git worktree list` no longer shows
      // it), then we `rm -rf` the directory to catch leftover files
      // that git didn't clean. Why the second step is needed:
      //
      // - activity.jsonl (Claude Code hook), tmp/llmlog.json and other
      //   gitignored runtime files are invisible to `git status` so git
      //   considers the worktree "dirty but all gitignored"
      // - with --force, git removes the worktree entry but leaves the
      //   directory (Windows + hook holding a file handle) or empty
      //   skeleton dirs behind
      // - result: `git worktree list` is clean but `.worktrees/B-xxx/`
      //   still exists with stray files
      //
      // The rm -rf is safe here because DONE gate already checked that
      // the working tree is clean AND the branch is merged into main —
      // anything left in the worktree is either gitignored runtime
      // state or genuine leakage we want to erase.
      if (existsSync(wtPathAbs) || isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
        const wasRegisteredWorktree = isRegisteredWorktree(mainRepoRoot, wtPathAbs);
        const repair = repairGlobalKoalaLinkBeforeWorktreeDelete(wtPathAbs, mainRepoRoot);
        if (repair.action === 'relinked') mergeLines.push(repair.message);
        let removeFailure: string | null = null;
        try {
          runGitArgs(['worktree', 'remove', wtPathAbs], mainRepoRoot);
          mergeLines.push(`✓ Worktree ${wtPathAbs} cleaned up`);
        } catch {
          // remove rejects when the worktree contains runtime artifacts like tmp/ or llmlog, use --force
          try {
            runGitArgs(['worktree', 'remove', '--force', wtPathAbs], mainRepoRoot);
            mergeLines.push(`✓ Worktree ${wtPathAbs} force-cleaned`);
          } catch (e: any) {
            removeFailure = `git worktree remove failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree not cleaned: ${e.message}`);
          }
        }
        // Second step: rm -rf the directory if git left it behind.
        // This is the fix for "worktree folder still exists after
        // DONE merge" caused by activity.jsonl-style gitignored
        // leftovers from Claude Code hooks.
        if (existsSync(wtPathAbs)) {
          try {
            assertSafeResidualWorktreeRm(doneWorktree, wtPathAbs, wasRegisteredWorktree);
            rmSync(wtPathAbs, { recursive: true, force: true });
            mergeLines.push(`✓ Worktree directory residue cleared`);
          } catch (e: any) {
            cleanupFailure = `worktree directory cleanup failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree directory residue cleanup failed: ${e.message}`);
          }
        }
        try {
          pruneWorktreeRegistry(mainRepoRoot);
          if (removeFailure && !existsSync(wtPathAbs) && !isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
            mergeLines.push(`✓ stale worktree registry pruned`);
          }
        } catch (e: any) {
          mergeLines.push(`⚠ git worktree prune failed: ${e.message}`);
        }
        if (existsSync(wtPathAbs) && !cleanupFailure) {
          cleanupFailure = `worktree path still exists after cleanup: ${wtPathAbs}`;
        }
        if (isRegisteredWorktree(mainRepoRoot, wtPathAbs) && !cleanupFailure) {
          cleanupFailure = removeFailure || `worktree is still registered after cleanup: ${wtPathAbs}`;
          mergeLines.push(`⚠ Worktree still in git registry: ${wtPathAbs}`);
        }
      }

      // Step 5: delete the branch
      try {
        runGitArgs(['branch', '-d', branch], mainRepoRoot);
        mergeLines.push(`✓ Branch ${branch} deleted`);
      } catch {
        mergeLines.push(`⚠ Branch ${branch} not deleted (may have unmerged commits)`);
      }

      if (cleanupFailure) {
        const err = new Error(cleanupFailure);
        reportHealthIssue('mutation:worktreeCleanup', err, {
          storyId,
          branch,
          worktreePath: wtPathAbs,
          mainRepoRoot,
        });
        throw new Error(
          `Story ${storyId} merged, but worktree cleanup did not complete: ${cleanupFailure}\n` +
          `→ Run koala doctor to inspect, or run koala doctor --repair to clean up terminal-state worktree residue.`,
        );
      }
    }

    if (mergeLines.length > 0) {
      doneMergeReport = `\n\n${mergeLines.join('\n')}`;
    }

    // B-9bd9 CHK-003: after DONE merge succeeds, try to trigger framework audit.
    // maybeTriggerAudit already has internal try/catch + meta-story guard + mode=off fallback;
    // wrap one more defensive layer here to ensure any audit-trigger path exception does not affect the DONE success message.
    // projectRoot uses mainRepoRoot (the root of the main repo, not the already-cleaned worktree).
    try {
      const auditResult = await maybeTriggerAudit(storyId, mainRepoRoot);
      if (auditResult.hint) {
        // semi-auto hint line: blank line before and after as its own paragraph, avoid being crammed together with mergeLines/docsHint
        doneMergeReport += `\n${auditResult.hint}`;
      }
    } catch (e: any) {
      console.warn(`[audit-trigger] DONE hook failed: ${e?.message || e}`);
    }
  }

  return { doneChecklistPrefix, doneMergeReport };
}
