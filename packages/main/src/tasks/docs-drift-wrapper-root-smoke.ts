/**
 * docs-drift-wrapper-root-smoke (B-f882 CHK-002)
 *
 * Regression for the wrapper-root (metadataRoot != gitRoot) false-block in the
 * docs-drift REVIEW→TEST preflight gate. This is the protection that was MISSING
 * — the two B-a7b0 docs-drift smokes are fully DI'd (in-memory md + injected
 * pathExists/grepLiteral) and never construct a metadataRoot!=gitRoot split, so a
 * gate wired to the wrong root (deps.projectRoot/metadataRoot instead of the
 * resolved gitCwd) is invisible to them.
 *
 * Defect class (background.md / plan.md): in review-preflight.ts the docs-drift
 * gate is the only git-invoking REVIEW→TEST gate; CHK-001 threaded the resolved
 * `gitCwd` into its `repoRoot` (the same value the channel/concept/lint/english
 * gates already use). Before the fix it passed `deps.projectRoot` (metadataRoot).
 * On wrapper-root layouts runDocsDriftGate -> checkPathDrift -> scanPathDrift runs
 * `fs.existsSync(join(repoRoot, p))` AND `git grep -F -l -- <p>` with `cwd: repoRoot`;
 * scanning from the non-git metadataRoot makes a file that EXISTS under the gitRoot
 * look absent -> false missing-path drift -> docs-drift FAIL -> false REVIEW→TEST block.
 *
 * Fixture (real disk, cleaned up; DI/store-stub only — NO dependence on the host
 * machine's directory layout). This mirrors a real wrapper-root project: an OUTER
 * "wrapper" git repo whose metadata lives at the top, with the real source gitRoot
 * in a configured subdir. The wrapper repo deliberately does NOT track the doc, so
 * `git grep` from it runs cleanly but finds nothing (the swallowed-fallback class):
 *   metadataRoot/                <- OUTER wrapper git repo (the wrapper root); tracks
 *                                   only proof-or-stop.config.json + .gitignore (NOT repo/)
 *     .gitignore                 <- ignores `repo/` so the inner gitRoot stays separate
 *     proof-or-stop.config.json        <- { gitRoot: "repo" } so resolveGitCwd resolves to the
 *                                   subdir gitRoot via the configured-git-root branch
 *                                   (which the resolver consults BEFORE metadata-git-root)
 *     repo/                      <- the REAL inner `git init` repo (the gitRoot), one commit
 *       dev-notes/wrapper-doc.md <- a doc that EXISTS ONLY under the gitRoot, committed
 *                                   so `git grep` from the gitRoot can find it
 * The CLAUDE.md (in-memory) references `dev-notes/wrapper-doc.md`. That path exists
 * (and is git-tracked) under the gitRoot subdir but is absent + untracked from the
 * outer metadataRoot repo, so:
 *   - scanned from the gitRoot  -> found (fs-exists) -> NOT missing -> docs-drift PASS
 *   - scanned from metadataRoot -> absent + no git grep hit (outer repo lacks it) -> missing -> docs-drift FAIL
 *
 * Two proofs, so the regression is BOTH end-to-end and root-selection-faithful:
 *   (1) PRIMARY end-to-end: drive runReviewCliGates with a stub StoryStore + a real
 *       proof-or-stop.config.json whose `gitRoot` resolves to the subdir, inject the other
 *       gate readers so only docs-drift exercises real fs/git, and assert the
 *       docs-drift gate is `pass`. Reverting CHK-001 (`repoRoot: gitCwd` ->
 *       `repoRoot: deps.projectRoot`) flips this assertion RED — proving the exact
 *       token is load-bearing through the whole preflight.
 *   (2) SECONDARY root-selection contrast: drive runDocsDriftGate DIRECTLY with real
 *       fs + real `git grep` (no stubbing of pathExists/grepLiteral) at repoRoot=gitRoot
 *       (PASS) vs repoRoot=metadataRoot (FAIL). This proves root selection is
 *       load-bearing independent of the stub-store fidelity in proof (1).
 *
 * On success prints `docs-drift wrapper-root smoke passed`; any assert failure
 * throws -> exit 1.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runReviewCliGates, type PreflightDeps } from '../handlers/review-preflight.js';
import { runDocsDriftGate } from '../handlers/validate-docs-drift.js';
import {
  resetConfigCache,
  resolveProofOrStopResiduePreflightMode,
} from '../core/config.js';
import type { StoryStore } from '../core/store.js';

// Path that exists ONLY under the gitRoot subdir. Must match scanPathDrift's
// pathRe (lowercase a/b/c.ext with >=1 slash, ext in json|md|ts|js|py) and must
// NOT start with `docs/story/` (those are ignored) nor be in DOCS_DRIFT_PATH_ALLOWLIST.
const ONLY_UNDER_GITROOT = 'dev-notes/wrapper-doc.md';

const STORY_ID = 'B-f882';

// CLAUDE.md content (in-memory) referencing the gitRoot-only path. The bash block
// uses only registered command names so the command-name scan stays clean and the
// only possible drift is the path-reference check we are exercising.
const WRAPPER_CLAUDE_MD = [
  '# Wrapper-root fixture doc',
  '',
  'See `dev-notes/wrapper-doc.md` for the wrapper notes.',
  '',
  '```bash',
  'proof-or-stop validate',
  '```',
  '',
].join('\n');

const REGISTRY = new Set<string>(['validate', 'story_create', 'story_advance']);

assert.equal(
  resolveProofOrStopResiduePreflightMode(process.cwd()),
  'enforce',
  'the Proof-or-Stop source repository must keep its residue maintenance preflight enabled',
);

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
    },
  });
}

/**
 * Build the wrapper-root fixture on real disk. Returns the temp metadataRoot
 * (the NON-git parent) and the gitRoot subdir inside it.
 */
function buildFixture(): { metadataRoot: string; gitRoot: string } {
  // metadataRoot = the OUTER wrapper git repo (the wrapper root). realpathSync via
  // resolveStorySignedWorkspace canonicalizes /var -> /private/var on macOS, so use
  // the canonical path everywhere to keep the resolver's gitRoot prefix-match stable.
  const metadataRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-wrapper-root-'));

  // Outer wrapper repo: tracks only config + .gitignore (and NOT repo/), so a
  // `git grep` from the metadataRoot runs cleanly but never finds the doc — the
  // exact swallowed-fallback false-block the wrapper-root wiring causes.
  git(metadataRoot, ['init']);
  git(metadataRoot, ['checkout', '-b', 'wrapper-main']);
  // Ignore the inner gitRoot subdir so the outer repo does not track its files.
  writeFileSync(join(metadataRoot, '.gitignore'), 'repo/\n', 'utf-8');
  // proof-or-stop.config.json points gitRoot at the subdir. This is what makes
  // resolveGitCwd (via resolveStorySignedWorkspace's configured-git-root branch,
  // which is consulted BEFORE the metadata-git-root branch) resolve to the subdir.
  writeFileSync(
    join(metadataRoot, 'proof-or-stop.config.json'),
    JSON.stringify({ gitRoot: 'repo' }, null, 2),
    'utf-8',
  );
  git(metadataRoot, ['add', '.gitignore', 'proof-or-stop.config.json']);
  git(metadataRoot, ['commit', '-m', 'wrapper root config']);

  // gitRoot = a real INNER git repo in a subdir of metadataRoot (inside the
  // metadata root, which resolveConfiguredGitRoot requires).
  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init']);
  // Name the inner branch `main` so the english-artifact gate's (non-injectable)
  // `git log main..HEAD` resolves to an empty range cleanly instead of printing a
  // harmless `fatal: ambiguous argument 'main..HEAD'` to stderr.
  git(gitRoot, ['checkout', '-b', 'main']);

  // The doc that exists (and is git-tracked) ONLY under the gitRoot subdir.
  const docAbs = join(gitRoot, ONLY_UNDER_GITROOT);
  mkdirSync(join(gitRoot, 'dev-notes'), { recursive: true });
  writeFileSync(docAbs, '# Wrapper doc\n\nEnglish-only fixture content.\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'add wrapper doc']);

  return { metadataRoot, gitRoot };
}

/**
 * Stub StoryStore exposing only what runReviewCliGates transitively touches:
 * readStory / readChecklist (channel detection + codex), readDecision /
 * readProcessEvents (channel gate), storyDirPath / storyDirRel (resolveGitCwd +
 * english gate). The story is NORMAL channel (>5 checklist items, no riskSignals,
 * no Codex tokens), so the CLI gates actually RUN (express channel would skip them).
 */
function makeStubStore(metadataRoot: string): StoryStore {
  // >5 items so detectFastChannel/isNormalChannel classify NORMAL (gates run).
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `CHK-00${i + 1}`,
    title: `Item ${i + 1}`,
    context: 'fixture',
    status: 'done',
  }));
  const story = {
    storyId: STORY_ID,
    name: 'wrapper-root-fixture',
    title: 'Wrapper root fixture story',
    description: 'Drive the docs-drift preflight gate over a wrapper-root layout.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'high',
    createdAt: '2026-06-17T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    riskSignals: [],
    // NO worktree binding -> resolveStorySignedWorkspace falls through to the
    // configured-git-root branch (driven by proof-or-stop.config.json gitRoot).
  };
  const stub = {
    readStory: () => story,
    readChecklist: () => ({ items }),
    // reviewerEvidenceAdvisoryGate → collectReviewerEvidenceState reads these
    // (empty fixture has no reviewer evidence; null scope contract = unprotected).
    readReviewRuns: () => ({ runs: [] }),
    readFindings: () => ({ findings: [] }),
    readReviewPasses: () => ({ passes: [] }),
    readScopeContract: () => null,
    readDecision: () => null,
    readProcessEvents: () => [],
    storyExists: () => true,
    storyDirRel: () => '.proof-or-stop/story/actives',
    storyDirPath: (id: string) => join(metadataRoot, '.proof-or-stop/story/actives', id),
  };
  return stub as unknown as StoryStore;
}

/** Injected gate readers so ONLY docs-drift exercises real fs/git. */
function makeDeps(metadataRoot: string): PreflightDeps {
  return {
    store: makeStubStore(metadataRoot),
    projectRoot: metadataRoot,
    // channel: empty git log -> "no commits" -> pass.
    gitLogReader: () => '',
    // concept: empty diff -> no deleted symbols -> pass.
    gitDiffReader: () => '',
    // concept grep: empty output -> no residual references.
    grepReader: () => '',
    // lint: tsc reports success, no spawn error -> pass.
    run: () => ({ code: 0, output: '', spawnError: false }),
    // lint change-scope: no changed files (empty newline-separated list).
    changedFilesReader: () => '',
    // docs-drift: registry + the wrapper CLAUDE.md (references the gitRoot-only path).
    registryNames: REGISTRY,
    mdFileReader: () => [WRAPPER_CLAUDE_MD],
  };
}

function gateByName(result: ReturnType<typeof runReviewCliGates>, name: string) {
  const g = result.gates.find((entry) => entry.name === name);
  assert.ok(g, `expected a '${name}' gate in the preflight result`);
  return g!;
}

// ════════════════════════════════════════════════════════════════════════════
// (1) PRIMARY end-to-end proof: runReviewCliGates over the wrapper-root fixture.
//     With CHK-001 (`repoRoot: gitCwd`) the docs-drift gate PASSES because the
//     existing-under-gitRoot path is found from the resolved gitRoot. Reverting
//     to `repoRoot: deps.projectRoot` makes it FAIL (path looks missing) — this
//     assertion is the RED/GREEN witness for the fix.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildFixture();
  try {
    const deps = makeDeps(metadataRoot);
    const result = runReviewCliGates(STORY_ID, deps);

    // Sanity: this MUST be the normal-channel path (gates actually ran), otherwise
    // a forced-skip would make the docs-drift pass meaningless.
    assert.equal(
      result.fastChannel,
      false,
      'fixture must be normal channel so the CLI gates actually run (express would skip docs-drift)',
    );

    const docsDrift = gateByName(result, 'docs-drift');
    // The gate must have actually run (not the registry-absent skip).
    assert.notEqual(
      docsDrift.summary,
      'registry command name not provided, skipping docs-drift check',
      'docs-drift gate must run (registry was provided)',
    );

    // The existing-under-gitRoot path must NOT be reported missing → gate passes.
    assert.equal(
      docsDrift.ok,
      true,
      `PRIMARY: docs-drift gate must PASS on wrapper-root (got status=${docsDrift.status}, details=${JSON.stringify(docsDrift.details)}). ` +
        `A FAIL here means repoRoot was scanned from the non-git metadataRoot (the pre-CHK-001 wiring).`,
    );

    const residue = gateByName(result, 'proof-or-stop-residue');
    assert.equal(
      residue.ok,
      true,
      'LAB_RED: consumer repositories without the PoS maintenance script must not be blocked',
    );
    assert.equal(
      residue.status,
      'skipped',
      'consumer repositories must report the PoS-only residue maintenance gate as skipped',
    );
    assert.ok(
      docsDrift.status === 'pass' || docsDrift.status === 'skipped',
      `PRIMARY: docs-drift status must be pass/skipped (got '${docsDrift.status}')`,
    );
    assert.deepEqual(
      (result.docsDrift?.missingPaths ?? []),
      [],
      `PRIMARY: ${ONLY_UNDER_GITROOT} must not be reported missing when scanned from the gitRoot ` +
        `(got ${JSON.stringify(result.docsDrift?.missingPaths)})`,
    );

    writeFileSync(
      join(metadataRoot, 'proof-or-stop.config.json'),
      JSON.stringify({
        gitRoot: 'repo',
        reviewPreflight: { proofOrStopResidue: 'enforce' },
      }, null, 2),
      'utf-8',
    );
    resetConfigCache();
    const optedIn = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(optedIn.ok, false, 'explicit PoS residue maintenance opt-in must fail closed');
    assert.equal(optedIn.status, 'fail', 'missing opted-in residue script must remain a failure');
    assert.match(
      optedIn.summary,
      /gate script missing/,
      'explicit opt-in must preserve the missing-script diagnostic',
    );

    const residueScriptDir = join(metadataRoot, 'scripts');
    const residueScript = join(residueScriptDir, 'verify-proof-or-stop-residue.mjs');
    mkdirSync(residueScriptDir, { recursive: true });
    writeFileSync(residueScript, "console.log('fixture residue pass');\n", 'utf-8');
    const passingOptIn = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(passingOptIn.status, 'pass', 'opted-in projects must execute a passing residue gate');

    writeFileSync(
      residueScript,
      "console.log('fixture residue detected'); process.exitCode = 1;\n",
      'utf-8',
    );
    const failingOptIn = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(failingOptIn.status, 'fail', 'opted-in projects must block on detected residue');
    assert.match(failingOptIn.summary, /brand residue: 1 hit/, 'detector output must remain visible');

    writeFileSync(
      join(metadataRoot, 'proof-or-stop.config.json'),
      JSON.stringify({
        gitRoot: 'repo',
        reviewPreflight: { proofOrStopResidue: 'off' },
      }, null, 2),
      'utf-8',
    );
    resetConfigCache();
    const explicitlyOff = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(explicitlyOff.status, 'skipped', 'explicit off must skip even with a failing script');

    writeFileSync(
      join(metadataRoot, 'proof-or-stop.config.json'),
      JSON.stringify({
        gitRoot: 'repo',
        reviewPreflight: { proofOrStopResidue: 'warn' },
      }, null, 2),
      'utf-8',
    );
    resetConfigCache();
    const invalidMode = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(invalidMode.status, 'fail', 'unknown residue policy modes must fail closed');

    for (const invalidReviewPreflight of ['enforce', null, []]) {
      writeFileSync(
        join(metadataRoot, 'proof-or-stop.config.json'),
        JSON.stringify({ gitRoot: 'repo', reviewPreflight: invalidReviewPreflight }, null, 2),
        'utf-8',
      );
      resetConfigCache();
      const invalidShape = gateByName(
        runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
        'proof-or-stop-residue',
      );
      assert.equal(
        invalidShape.status,
        'fail',
        'LAB_RED: malformed reviewPreflight configuration must fail closed',
      );
    }

    writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), '{ invalid json', 'utf-8');
    resetConfigCache();
    const invalidJson = gateByName(
      runReviewCliGates(STORY_ID, makeDeps(metadataRoot)),
      'proof-or-stop-residue',
    );
    assert.equal(
      invalidJson.status,
      'fail',
      'LAB_RED: malformed project JSON must not silently disable an enforced residue gate',
    );

    void gitRoot;
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (2) SECONDARY root-selection contrast: runDocsDriftGate DIRECTLY, real fs +
//     real `git grep`, NO stubbing of pathExists/grepLiteral. Proves the SAME
//     gate distinguishes the two roots — the existing-only-under-gitRoot path is
//     found at repoRoot=gitRoot (PASS) and missing at repoRoot=metadataRoot (FAIL).
//     This proof does not depend on the stub-store fidelity used in proof (1).
// ════════════════════════════════════════════════════════════════════════════
{
  const { metadataRoot, gitRoot } = buildFixture();
  try {
    // repoRoot = gitRoot subdir (the correct, CHK-001 wiring): path found → PASS.
    const atGitRoot = runDocsDriftGate([WRAPPER_CLAUDE_MD], REGISTRY, {
      repoRoot: gitRoot,
    });
    assert.equal(
      atGitRoot.status,
      'pass',
      `SECONDARY/gitRoot: docs-drift must PASS scanning from the gitRoot (got status=${atGitRoot.status}, missingPaths=${JSON.stringify(atGitRoot.missingPaths)})`,
    );
    assert.deepEqual(
      atGitRoot.missingPaths,
      [],
      `SECONDARY/gitRoot: ${ONLY_UNDER_GITROOT} must not be missing when scanned from the gitRoot`,
    );

    // repoRoot = metadataRoot (the pre-CHK-001 wrong wiring): the file does NOT
    // exist there and `git grep` from a non-git root finds nothing → missing → FAIL.
    const atMetadataRoot = runDocsDriftGate([WRAPPER_CLAUDE_MD], REGISTRY, {
      repoRoot: metadataRoot,
    });
    assert.equal(
      atMetadataRoot.status,
      'fail',
      `SECONDARY/metadataRoot: docs-drift must FAIL scanning from the non-git metadataRoot ` +
        `(got status=${atMetadataRoot.status}). This is exactly the wrapper-root false-block CHK-001 fixes.`,
    );
    assert.ok(
      atMetadataRoot.missingPaths.includes(ONLY_UNDER_GITROOT),
      `SECONDARY/metadataRoot: ${ONLY_UNDER_GITROOT} must be reported missing when scanned from metadataRoot ` +
        `(got ${JSON.stringify(atMetadataRoot.missingPaths)})`,
    );

    // The two roots MUST differ — that is the whole point: root selection is load-bearing.
    assert.notEqual(
      atGitRoot.status,
      atMetadataRoot.status,
      'SECONDARY: gitRoot vs metadataRoot must produce DIFFERENT docs-drift outcomes (root selection is load-bearing)',
    );
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
  }
}

console.log('docs-drift wrapper-root smoke passed');
