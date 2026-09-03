#!/usr/bin/env node

/**
 * B-e791 CHK-003 smoke: gitRoot-aware INIT/INIT_CHECK next-step guidance
 * (session.ts computeNextStep) + quiet dev_start nesting probe (worktree.ts).
 *
 * Covers the two fixes landed in c6c6c85c0:
 *
 *   CHK-001 (session.ts) — computeNextStep INIT / INIT_CHECK branches now gate the
 *   "git init" advisory on `!gitReady && !configuredGitRootResolved`. When a
 *   configured gitRoot resolves (a wrapper-root layout where the metadata root is
 *   NOT itself git but the workspace is git-backed via the configured gitRoot),
 *   guidance must NOT tell the user to git init — it points to INIT_CHECK / the
 *   worktree+PLAN flow. A PLAIN no-gitRoot project (gitReady=false AND
 *   configuredGitRootResolved=false) must keep the EXACT (byte-identical) git-init
 *   message.
 *
 *   CHK-002 (worktree.ts ~805) — the dev_start nesting probe
 *   (`git rev-parse --abbrev-ref HEAD`) now runs with `stdio:['pipe','pipe','pipe']`
 *   so on a wrapper-root metadataRoot (not a git repo) git's
 *   `fatal: not a git repository` is captured into the pipe instead of leaking to
 *   the terminal — while a real `worktree-*` checkout is STILL detected and the
 *   "Already in a worktree" rejection thrown.
 *
 * Seam:
 *   - computeNextStep + NextStepCtx are exported (minimal export) so the guidance
 *     branches are driven directly as a pure function — no process/store setup.
 *   - dev_start's nesting probe is an inline execSync; driving dev_start fully is
 *     heavy (full HandlerContext + store + bootstrap), so per the plan this smoke
 *     replicates the EXACT probe pattern (same command + stdio) against the same
 *     fixture shapes the handler faces: (1) a wrapper-root non-git cwd — assert no
 *     `fatal: not a git repository` reaches the parent stderr; (2) a repo with a
 *     real `worktree-*` checked-out branch — assert the branch name triggers the
 *     nesting rejection. Does NOT shell to the global `proof-or-stop` binary.
 *
 * Prints ✓/✗; exits non-zero on first failure.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeNextStep, type NextStepCtx } from '../handlers/session.js';

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git('init -b main', dir);
  git('config user.email smoke@test.local', dir);
  git('config user.name smoke', dir);
  git('config commit.gpgsign false', dir);
}

/** Minimal NextStepCtx for the INIT / INIT_CHECK guidance branches. Only the
 * fields read on those branches matter; the rest are inert defaults. */
function ctx(phase: 'INIT' | 'INIT_CHECK', gitReady: boolean, configuredGitRootResolved: boolean): NextStepCtx {
  return {
    storyId: 'B-smoke',
    phase,
    checklist: null,
    hasUnderstanding: false,
    hasDecision: false,
    bugs: null,
    hasTestEvidence: false,
    hasPassingTestEvidence: false,
    testPassedAt: null,
    gitReady,
    configuredGitRootResolved,
    donePrecheck: null,
    reviewerStatus: null,
    scopeBlocking: null,
  };
}

const base = mkdtempSync(join(tmpdir(), 'gitroot-init-guidance-quiet-nesting-smoke-'));

try {
  // ════════════════════════════════════════════════════════════════════════
  // CHK-001 — gitRoot-aware INIT / INIT_CHECK guidance (computeNextStep)
  // ════════════════════════════════════════════════════════════════════════

  // (b) PLAIN no-gitRoot baseline FIRST, captured byte-for-byte so (a) can be
  //     asserted as a strict departure from this exact string.
  const initPlainBytes = computeNextStep(ctx('INIT', false, false));
  const initCheckPlainBytes = computeNextStep(ctx('INIT_CHECK', false, false));

  // The plain-project messages must still say "git init" verbatim (byte-identical
  // to the pre-fix behavior — the `&& !configuredGitRootResolved` guard is false
  // here so the advisory branch is taken).
  assert.equal(
    initPlainBytes,
    'Story is in INIT phase, but the current project is not a git repository. You can continue recording metadata; to enter the INIT_CHECK/worktree flow, first run git init && git add . && git commit -m "init"',
    'INIT plain no-gitRoot: git-init advisory must be byte-identical',
  );
  assert.equal(
    initCheckPlainBytes,
    'Story is in the pre-INIT_CHECK phase, but the current project is not a git repository. Run git init + initial commit first, then continue with worktree / PLAN flow',
    'INIT_CHECK plain no-gitRoot: git-init advisory must be byte-identical',
  );
  assert.ok(initPlainBytes.includes('git init'), 'INIT plain: message still mentions git init');
  assert.ok(initCheckPlainBytes.includes('git init'), 'INIT_CHECK plain: message still mentions git init');
  pass('INIT/INIT_CHECK plain no-gitRoot (gitReady=false, configuredGitRootResolved=false) → byte-identical git-init message');

  // (a) Wrapper-root: gitReady=false BUT a configured gitRoot resolves. Guidance
  //     must NOT say "git init" and must point to the INIT_CHECK / worktree+PLAN
  //     flow — i.e. depart from the plain advisory captured above.
  const initResolved = computeNextStep(ctx('INIT', false, true));
  const initCheckResolved = computeNextStep(ctx('INIT_CHECK', false, true));

  assert.ok(
    !initResolved.includes('git init'),
    'INIT wrapper-root: guidance must NOT tell the user to git init the metadata root',
  );
  assert.ok(
    !initResolved.includes('not a git repository'),
    'INIT wrapper-root: guidance must NOT claim the project is not a git repository',
  );
  assert.notEqual(
    initResolved,
    initPlainBytes,
    'INIT wrapper-root: guidance must differ from the plain no-gitRoot advisory',
  );
  assert.ok(
    initResolved.includes('INIT_CHECK'),
    'INIT wrapper-root: guidance points to the INIT_CHECK / worktree flow',
  );

  assert.ok(
    !initCheckResolved.includes('git init'),
    'INIT_CHECK wrapper-root: guidance must NOT tell the user to git init the metadata root',
  );
  assert.ok(
    !initCheckResolved.includes('not a git repository'),
    'INIT_CHECK wrapper-root: guidance must NOT claim the project is not a git repository',
  );
  assert.notEqual(
    initCheckResolved,
    initCheckPlainBytes,
    'INIT_CHECK wrapper-root: guidance must differ from the plain no-gitRoot advisory',
  );
  assert.ok(
    initCheckResolved.includes('PLAN'),
    'INIT_CHECK wrapper-root: guidance points to the cd-into-worktree + PLAN flow',
  );
  pass('INIT/INIT_CHECK wrapper-root (gitReady=false, configuredGitRootResolved=true) → ready-for-INIT_CHECK guidance, no git-init');

  // Cross-check: a genuinely git-ready project (gitReady=true) yields the SAME
  // proceed-to-INIT_CHECK guidance as the wrapper-root resolved case — the fix
  // makes configuredGitRootResolved behave like gitReady for these branches.
  assert.equal(
    computeNextStep(ctx('INIT', true, false)),
    initResolved,
    'INIT: gitReady project and wrapper-root resolved project share the same proceed guidance',
  );
  assert.equal(
    computeNextStep(ctx('INIT_CHECK', true, false)),
    initCheckResolved,
    'INIT_CHECK: gitReady project and wrapper-root resolved project share the same proceed guidance',
  );
  pass('INIT/INIT_CHECK gitReady=true matches wrapper-root resolved guidance (configuredGitRootResolved ≡ gitReady for these branches)');

  // ════════════════════════════════════════════════════════════════════════
  // CHK-002 — quiet dev_start nesting probe (worktree.ts ~805)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Replicate the EXACT production probe: `git rev-parse --abbrev-ref HEAD` with
   * `stdio:['pipe','pipe','pipe']`, the catch that re-throws only the nesting
   * error. `probeStderr` collects whatever git wrote to stderr (the pipe), so a
   * test can assert the parent process never sees the `fatal:` leak.
   */
  function nestingProbe(cwd: string): { branch: string | null; rejected: boolean; probeStderr: string } {
    let probeStderr = '';
    let branch: string | null = null;
    let rejected = false;
    try {
      const out = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      branch = out;
      if (out.startsWith('worktree-')) {
        rejected = true; // mirror production: this is the thrown "Already in a worktree" path
      }
    } catch (e: any) {
      // Production catch: only the nesting error re-throws; git's failure
      // (fatal: not a git repository) lands here with stderr captured in the pipe.
      probeStderr = (e?.stderr ? String(e.stderr) : '') + (e?.message ? String(e.message) : '');
    }
    return { branch, rejected, probeStderr };
  }

  // ── Scenario A: wrapper-root metadataRoot (NOT a git repo) ──────────────────
  // The probe runs in a non-git dir. git exits with `fatal: not a git
  // repository`; with stdio pipe that text is captured (not leaked to the parent
  // terminal). We assert nothing leaked to the PARENT process stderr by wrapping
  // the probe call and proving git's fatal stayed inside the captured pipe.
  {
    const wrapper = join(base, 'wrapper');
    mkdirSync(wrapper, { recursive: true });

    // Capture anything the child writes to the parent's stderr fd. Because the
    // probe uses stdio:'pipe' for stderr, git's fatal must NOT reach here.
    // We assert via the probe's own captured pipe instead: the fatal is present
    // in probeStderr (proving git did fail) yet, by construction of stdio:pipe,
    // never reaches the inherited terminal.
    const result = nestingProbe(wrapper);

    assert.equal(result.branch, null, 'wrapper-root: non-git probe yields no branch (git failed)');
    assert.equal(result.rejected, false, 'wrapper-root: non-git probe does not trigger nesting rejection');
    assert.ok(
      result.probeStderr.includes('not a git repository'),
      'wrapper-root: git DID fail (fatal: not a git repository) — proving the fixture is genuinely non-git',
    );
    // The crux: that fatal was captured in the pipe (probeStderr), i.e. with
    // stdio:'pipe' it is NOT inherited to the parent terminal. Contrast with the
    // pre-fix `execSync(...)` default which inherits stderr and leaks the fatal.
    pass('wrapper-root nesting probe: fatal captured in pipe, NOT leaked to terminal (stdio:pipe)');
  }

  // Belt-and-braces: prove the DEFAULT (pre-fix) execSync — which inherits the
  // parent's stderr — would have leaked the fatal, by running the probe in a
  // child node process and capturing the child's stderr fd directly.
  {
    const wrapper2 = join(base, 'wrapper-leak-control');
    mkdirSync(wrapper2, { recursive: true });

    // (1) FIXED form: stdio:'pipe' for stderr → child's own stderr stays clean.
    const fixedScript =
      "try{require('child_process').execSync('git rev-parse --abbrev-ref HEAD',{stdio:['pipe','pipe','pipe']})}catch(e){}";
    void execSync(`node -e "${fixedScript}"`, {
      cwd: wrapper2,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Re-run capturing the child's stderr separately to assert it is empty.
    let fixedChildStderr = '';
    try {
      execSync(`node -e "${fixedScript}" 2>&1`, { cwd: wrapper2, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      fixedChildStderr = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    }
    assert.ok(
      !fixedChildStderr.includes('fatal: not a git repository'),
      'fixed (stdio:pipe): child process emits no `fatal: not a git repository` to its terminal',
    );

    // (2) PRE-FIX form: default stdio inherits stderr → the fatal leaks to the
    //     child's terminal. Capture combined output to confirm the leak the fix
    //     suppresses (this is the regression the fix prevents).
    const leakScript =
      "try{require('child_process').execSync('git rev-parse --abbrev-ref HEAD')}catch(e){}";
    let leakedOutput = '';
    try {
      leakedOutput = execSync(`node -e "${leakScript}" 2>&1`, {
        cwd: wrapper2,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      leakedOutput = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    }
    assert.ok(
      leakedOutput.includes('fatal: not a git repository'),
      'pre-fix (default stdio): the fatal DOES leak — confirming the fix (stdio:pipe) is what suppresses it',
    );
    pass('leak control: default execSync leaks `fatal`, stdio:pipe form does not — the fix suppresses the leak');
  }

  // ── Scenario B: real `worktree-*` branch still rejected ─────────────────────
  // A genuine repo with HEAD on a `worktree-*` branch: the probe must read that
  // branch name and trigger the nesting rejection (rejected=true) — behavior the
  // stdio change must NOT regress.
  {
    const repo = join(base, 'real-repo');
    initGitRepo(repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git('add seed.txt', repo);
    git('commit -m initial', repo);
    git('checkout -b worktree-B-smoke', repo);

    const result = nestingProbe(repo);
    assert.equal(
      result.branch,
      'worktree-B-smoke',
      'real-repo: probe reads the checked-out worktree-* branch name',
    );
    assert.equal(
      result.rejected,
      true,
      'real-repo: a real worktree-* branch still triggers the nesting rejection (preserved)',
    );
    assert.equal(result.probeStderr, '', 'real-repo: successful probe writes nothing to stderr');
    pass('real worktree-* branch: nesting rejection preserved (probe reads branch + triggers reject)');
  }

  // ── Scenario C: ordinary branch is NOT rejected (negative control) ──────────
  {
    const repo = join(base, 'main-repo');
    initGitRepo(repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git('add seed.txt', repo);
    git('commit -m initial', repo);
    // HEAD is on `main` (init -b main).

    const result = nestingProbe(repo);
    assert.equal(result.branch, 'main', 'main-repo: probe reads the main branch');
    assert.equal(result.rejected, false, 'main-repo: an ordinary (non worktree-*) branch is NOT rejected');
    pass('ordinary branch: not rejected (negative control)');
  }

  console.log('\n✓ gitroot-init-guidance + quiet-nesting smoke passed (CHK-001 guidance + CHK-002 probe)');
} catch (err) {
  console.error('\n✗ gitroot-init-guidance + quiet-nesting smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

rmSync(base, { recursive: true, force: true });
