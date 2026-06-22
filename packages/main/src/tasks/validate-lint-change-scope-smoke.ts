#!/usr/bin/env node

/**
 * B-a749 CHK-003 smoke: `lattice validate --lint` must be change-aware so a
 * backend-only change is not blocked by an unrelated frontend package whose
 * deps are absent in a fresh worktree (the ClawCreek TS2307 false-block).
 *
 * Covers the verificationIntent for CHK-001/002/003:
 *  - (a) happy: backend-only changedFiles → frontend tsconfig reported skipped
 *        (out of scope, deps absent); backend tsconfig is run (tsc invoked).
 *  - (b) edge: an IN-SCOPE frontend change still type-checks AND still surfaces
 *        a real injected tsc error as a fail (the gate still bites).
 *  - (c) edge: no change-scope (undefined changedFiles) keeps FULL recursive
 *        tsc — tsc invoked for EVERY tsconfig, no deps-absent skipping.
 *  - (d) edge: the changed-files reader throws → fall back to full recursive
 *        tsc (never skip-all).
 *  - adversarial: out-of-scope WITH node_modules present → still type-checked
 *        (defense-in-depth); a changed file under no tsconfig subtree is treated
 *        in-scope (fail-closed) so nothing is silently skipped.
 *
 * Uses the CommandRunner DI seam (never spawns real tsc), an injected
 * changed-files reader, and a real tmp fixture tree (so findTsconfigs +
 * the node_modules probe run against deterministic fs state). Sub-second.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkLint,
  resolveChangedFiles,
  type CommandRunner,
  type ChangedFilesReader,
} from '../handlers/validate-lint.js';

const base = mkdtempSync(join(tmpdir(), 'lint-change-scope-smoke-'));

/**
 * Build a monorepo-ish fixture:
 *   <root>/backend/tsconfig.json        (+ package.json + node_modules)
 *   <root>/frontend/tsconfig.json       (+ package.json, NO node_modules by default)
 * Returns the absolute root path. `frontendDeps` controls whether the frontend
 * package gets a node_modules dir (to exercise out-of-scope WITH deps present).
 */
function makeFixture(name: string, opts: { frontendDeps?: boolean } = {}): string {
  const root = join(base, name);
  for (const pkg of ['backend', 'frontend']) {
    const dir = join(root, pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
  }
  // backend always has deps; frontend only if requested.
  mkdirSync(join(root, 'backend', 'node_modules'), { recursive: true });
  if (opts.frontendDeps) {
    mkdirSync(join(root, 'frontend', 'node_modules'), { recursive: true });
  }
  return root;
}

/** A CommandRunner that records which tsconfig dirs tsc was invoked against, and always passes. */
function recordingRunnerOk(): { run: CommandRunner; invokedFor: string[] } {
  const invokedFor: string[] = [];
  const run: CommandRunner = (_cmd, args) => {
    // args look like: ['--no-install','tsc','--noEmit','-p',<tsconfigPath>] or ['--noEmit','-p',<path>]
    const pIdx = args.indexOf('-p');
    if (pIdx >= 0 && args[pIdx + 1]) invokedFor.push(args[pIdx + 1]);
    return { code: 0, output: '', spawnError: false };
  };
  return { run, invokedFor };
}

/** A CommandRunner that fails (real tsc error) for any tsconfig matching `failSubstr`, else passes. */
function failingRunnerFor(failSubstr: string): { run: CommandRunner; invokedFor: string[] } {
  const invokedFor: string[] = [];
  const run: CommandRunner = (_cmd, args) => {
    const pIdx = args.indexOf('-p');
    const target = pIdx >= 0 ? (args[pIdx + 1] ?? '') : '';
    if (target) invokedFor.push(target);
    if (target.includes(failSubstr)) {
      return { code: 2, output: `${target}: error TS2304: injected tsc error`, spawnError: false };
    }
    return { code: 0, output: '', spawnError: false };
  };
  return { run, invokedFor };
}

const okReader = (files: string[]): ChangedFilesReader => () => files.join('\n');
const throwingReader: ChangedFilesReader = () => {
  throw new Error('no merge-base with main (orphan branch)');
};

try {
  // ── (a) happy: backend-only change → frontend skipped (out of scope, deps absent) ──
  {
    const root = makeFixture('a-backend-only');
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: okReader(['backend/src/api.ts']),
    });
    assert.deepEqual(changedFiles, ['backend/src/api.ts'], 'resolver returns backend-only scope');
    const result = checkLint({ projectRoot: root, run, changedFiles });

    const frontendSkip = result.details.find(
      (d) => d.includes('frontend/tsconfig.json') && d.includes('(out of scope, deps absent)'),
    );
    assert.ok(
      frontendSkip,
      `frontend must be reported skipped (out of scope, deps absent); details=${JSON.stringify(result.details)}`,
    );
    assert.equal(
      frontendSkip,
      `[lint] skipped: ${join('frontend', 'tsconfig.json')} (out of scope, deps absent)`,
      'exact skip detail line must match the documented format',
    );
    // backend tsc WAS invoked; frontend tsc was NOT.
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'backend tsconfig must be type-checked',
    );
    assert.ok(
      !invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'frontend tsconfig must NOT be type-checked (scoped out + deps absent)',
    );
    // skip != fail: overall status stays pass.
    assert.equal(result.status, 'pass', 'scope-skip must not flip overall lint to fail');
  }

  // ── (b) edge: in-scope frontend change still type-checks AND fails on injected tsc error ──
  {
    const root = makeFixture('b-frontend-inscope', { frontendDeps: true });
    const { run, invokedFor } = failingRunnerFor(join('frontend', 'tsconfig.json'));
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: okReader(['frontend/src/app.tsx']),
    });
    const result = checkLint({ projectRoot: root, run, changedFiles });
    assert.ok(
      invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'in-scope frontend tsconfig must be type-checked',
    );
    assert.equal(result.status, 'fail', 'in-scope tsc error must make the lint gate bite (fail)');
    assert.equal(result.checks.tsc?.status, 'fail', 'tsc sub-check must be fail');
  }

  // ── (c) edge: no change-scope (undefined) → full recursive tsc, no deps-absent skipping ──
  {
    const root = makeFixture('c-no-scope'); // frontend has NO node_modules
    const { run, invokedFor } = recordingRunnerOk();
    const result = checkLint({ projectRoot: root, run, changedFiles: undefined });
    // EVERY tsconfig invoked — including the deps-absent frontend.
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'no-scope: backend tsconfig must be type-checked',
    );
    assert.ok(
      invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'no-scope: frontend tsconfig must ALSO be type-checked (no scope → full recursive)',
    );
    // No deps-absent skips at all.
    assert.ok(
      !result.details.some((d) => d.includes('(out of scope, deps absent)')),
      'no-scope mode must not deps-absent-skip anything',
    );
    assert.equal(result.status, 'pass', 'no-scope full recursive run passes when runner passes');
    // Legacy output string preserved exactly when nothing scope-skipped.
    assert.match(
      result.checks.tsc?.output ?? '',
      /^tsc: checked 2 tsconfigs$/,
      'legacy "tsc: checked N tsconfigs" output preserved in no-scope mode',
    );
  }

  // ── (d) edge: diff/changed-files reader throws → fall back to full recursive tsc (never skip-all) ──
  {
    const root = makeFixture('d-reader-throws'); // frontend has NO node_modules
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: throwingReader,
    });
    assert.equal(changedFiles, undefined, 'throwing reader must resolve to undefined (no scope)');
    const result = checkLint({ projectRoot: root, run, changedFiles });
    // Full recursive: both tsconfigs invoked, nothing skipped (NEVER skip-all).
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'reader-throws fallback: backend tsconfig type-checked',
    );
    assert.ok(
      invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'reader-throws fallback: frontend tsconfig type-checked (full recursive, never skip-all)',
    );
    assert.ok(
      !result.details.some((d) => d.includes('(out of scope, deps absent)')),
      'reader-throws fallback must not skip any package',
    );
  }

  // ── adversarial 1: out-of-scope WITH node_modules present → still type-checked (defense-in-depth) ──
  {
    const root = makeFixture('adv-deps-present', { frontendDeps: true }); // frontend HAS node_modules
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: okReader(['backend/src/api.ts']),
    });
    const result = checkLint({ projectRoot: root, run, changedFiles });
    // frontend is out of scope, but its deps ARE present → tsc must still run.
    assert.ok(
      invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'out-of-scope WITH node_modules present must still be type-checked (B-5a28 spirit)',
    );
    assert.ok(
      !result.details.some((d) => d.includes('(out of scope, deps absent)')),
      'no deps-absent skip when deps are present',
    );
    assert.equal(result.status, 'pass', 'all-present run passes');
  }

  // ── adversarial 2: changed file under NO tsconfig subtree → fail-closed, everything in-scope ──
  {
    const root = makeFixture('adv-fail-closed'); // frontend has NO node_modules
    const { run, invokedFor } = recordingRunnerOk();
    // 'docs/readme.md' lives under neither backend/ nor frontend/ → ambiguous → fail-closed.
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: okReader(['docs/readme.md']),
    });
    const result = checkLint({ projectRoot: root, run, changedFiles });
    // Fail-closed: BOTH tsconfigs treated in-scope → both type-checked, nothing skipped.
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'fail-closed: backend type-checked',
    );
    assert.ok(
      invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'fail-closed: frontend type-checked even though deps absent (changed file maps to no tsconfig)',
    );
    assert.ok(
      !result.details.some((d) => d.includes('(out of scope, deps absent)')),
      'fail-closed must not skip any package when a changed file maps to no tsconfig subtree',
    );
  }

  // ── boundary: empty change-scope (nothing changed vs base) is a REAL scope, not undefined ──
  {
    const root = makeFixture('boundary-empty-scope'); // frontend has NO node_modules
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: okReader([]), // git diff --name-only printed nothing
    });
    assert.deepEqual(changedFiles, [], 'empty diff resolves to [] (a real scope), not undefined');
    const result = checkLint({ projectRoot: root, run, changedFiles });
    // Every tsconfig is out of scope; deps-absent frontend is skipped, backend (deps present) runs.
    assert.ok(
      result.details.some(
        (d) => d.includes('frontend/tsconfig.json') && d.includes('(out of scope, deps absent)'),
      ),
      'empty scope: deps-absent frontend skipped',
    );
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'empty scope: backend (deps present) still type-checked even though out of scope',
    );
    assert.notEqual(result.status, 'fail', 'empty-scope skips must not flip overall lint to fail');
  }

  // ════════════════════════════════════════════════════════════════════════
  // B-0740 CHK-002: thread the resolved gitCwd into resolveChangedFiles and
  // rebase gitRoot-relative diff paths to projectRoot-relative so the single
  // projectRoot relativity base used downstream is preserved on wrapper-root.
  // ════════════════════════════════════════════════════════════════════════

  // A reader that asserts the threaded gitCwd, then emits gitRoot-relative paths
  // (what real `git diff --name-only` run from the gitRoot would print).
  const gitRootReader =
    (expectGitCwd: string | undefined, gitRootRelPaths: string[]): ChangedFilesReader =>
    ({ gitCwd }) => {
      assert.equal(gitCwd, expectGitCwd, 'reader must receive the threaded gitCwd');
      return gitRootRelPaths.join('\n');
    };

  // ── (e) happy: wrapper-root rebase — gitRoot-relative paths → projectRoot-relative ──
  {
    // gitRoot = /<root>, projectRoot (metadataRoot) = /<root>/wrapper.
    // makeFixture lays backend/ + frontend/ DIRECTLY under projectRoot, so the
    // gitRoot-relative form of those files is prefixed with "wrapper/".
    // All changed files here are backend-only (all under projectRoot) so the
    // out-of-scope SET is unambiguous: frontend is correctly skipped.
    const gitRoot = join(base, 'e-wrapper-root');
    const projectRoot = makeFixture(join('e-wrapper-root', 'wrapper'));
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot,
      gitCwd: gitRoot,
      // gitRoot-relative output: both files live under projectRoot's backend/.
      changedFilesReader: gitRootReader(gitRoot, [
        'wrapper/backend/src/api.ts',
        'wrapper/backend/src/util.ts',
      ]),
    });
    // Rebase strips the `wrapper/` prefix → projectRoot-relative backend paths.
    assert.deepEqual(
      changedFiles,
      [join('backend', 'src', 'api.ts'), join('backend', 'src', 'util.ts')],
      'wrapper-root: gitRoot-relative paths rebased to projectRoot-relative (wrapper/ prefix stripped)',
    );
    const result = checkLint({ projectRoot, run, changedFiles });
    // backend is in-scope (changed files live under it) → type-checked.
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))),
      'wrapper-root: in-scope backend tsconfig type-checked after rebase',
    );
    // frontend has NO changed file under it AND no deps → out of scope, skipped.
    assert.ok(
      result.details.some(
        (d) => d.includes('frontend/tsconfig.json') && d.includes('(out of scope, deps absent)'),
      ),
      'wrapper-root: out-of-scope frontend skipped (correct out-of-scope set after rebase)',
    );
    assert.ok(
      !invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'wrapper-root: out-of-scope frontend NOT type-checked',
    );
    assert.equal(result.status, 'pass', 'wrapper-root scope-skip must not flip lint to fail');
  }

  // ── (e2) wrapper-root: a file OUTSIDE projectRoot rebases to a `..`-prefixed path ──
  {
    // A gitRoot-relative path that lives OUTSIDE projectRoot (sibling of wrapper/)
    // must rebase to a `..`-prefixed projectRoot-relative path. isPathUnderDir
    // then never matches it → it is correctly out-of-scope for projectRoot tsconfigs,
    // and (per the documented fail-closed rule) a changed file mapping to NO
    // tsconfig subtree forces everything in-scope (conservative "when in doubt").
    const gitRoot = join(base, 'e2-outside-projectroot');
    const projectRoot = makeFixture(join('e2-outside-projectroot', 'wrapper'));
    const { run, invokedFor } = recordingRunnerOk();
    const changedFiles = resolveChangedFiles({
      projectRoot,
      gitCwd: gitRoot,
      changedFilesReader: gitRootReader(gitRoot, ['packages/b/y.ts']),
    });
    assert.deepEqual(
      changedFiles,
      [join('..', 'packages', 'b', 'y.ts')],
      'wrapper-root: out-of-projectRoot path rebases to a `..`-prefixed path',
    );
    const result = checkLint({ projectRoot, run, changedFiles });
    // Fail-closed: the `..` file maps to no tsconfig subtree → both tsconfigs run.
    assert.ok(
      invokedFor.some((p) => p.includes(join('backend', 'tsconfig.json'))) &&
        invokedFor.some((p) => p.includes(join('frontend', 'tsconfig.json'))),
      'wrapper-root: `..`-prefixed file (no tsconfig subtree) → fail-closed, everything in-scope',
    );
    assert.ok(
      !result.details.some((d) => d.includes('(out of scope, deps absent)')),
      'wrapper-root fail-closed must not skip any package',
    );
  }

  // ── (f) plain-repo identity: gitCwd == projectRoot → byte-identical to gitCwd omitted ──
  {
    const root = makeFixture('f-identity-equal');
    const reader = okReader(['backend/src/api.ts']);
    const withEqualGitCwd = resolveChangedFiles({
      projectRoot: root,
      gitCwd: root, // equals projectRoot → identity rebase
      changedFilesReader: reader,
    });
    const withoutGitCwd = resolveChangedFiles({
      projectRoot: root,
      changedFilesReader: reader, // gitCwd omitted → identity
    });
    assert.deepEqual(
      withEqualGitCwd,
      ['backend/src/api.ts'],
      'gitCwd == projectRoot is the identity transform',
    );
    assert.deepEqual(
      withEqualGitCwd,
      withoutGitCwd,
      'gitCwd == projectRoot output is byte-identical to gitCwd omitted',
    );
  }

  // ── (g) throwing reader WITH gitCwd set → undefined (full tsc, never skip-all) ──
  {
    const root = join(base, 'g-throw-wrapper');
    const projectRoot = makeFixture(join('g-throw-wrapper', 'wrapper'));
    const changedFiles = resolveChangedFiles({
      projectRoot,
      gitCwd: root, // wrapper-root + throwing reader
      changedFilesReader: throwingReader,
    });
    assert.equal(
      changedFiles,
      undefined,
      'throwing reader must resolve to undefined even with gitCwd set (rebase never converts a throw into [])',
    );
  }

  // ── (h) empty diff WITH gitCwd set → [] (valid empty scope; throw/empty distinction survives rebase) ──
  {
    const root = join(base, 'h-empty-wrapper');
    const projectRoot = makeFixture(join('h-empty-wrapper', 'wrapper'));
    const changedFiles = resolveChangedFiles({
      projectRoot,
      gitCwd: root, // wrapper-root + empty diff
      changedFilesReader: gitRootReader(root, []), // git diff printed nothing
    });
    assert.deepEqual(
      changedFiles,
      [],
      'empty diff resolves to [] (a real empty scope) even with gitCwd set, distinct from undefined',
    );
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log('✓ validate-lint change-scope smoke passed');
