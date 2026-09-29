import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadConfig, resetConfigCache } from '../../core/config.js';

import { classifyGitStatusRows, dirtyWorktreeClassifierOptionsForStory, dirtyWorktreeClassifierOptionsFromConfig } from '../../core/dirty-worktree.js';
import { evaluateDirtyGate } from '../../core/dirty-gate-policy.js';
import { evaluateDeclaredArtifactReferences } from '../../core/declared-artifact-gate.js';
import { createArtifactDeclareHandlers } from '../../handlers/artifact-declare.js';

import { autoCommitStoryMetadata, AUTO_COMMIT_METADATA_PREFIX } from '../../core/auto-commit-metadata.js';
import { readHealthIssues } from '../../core/health.js';

import { StoryStore } from '../../core/store.js';
import type { ChecklistData, StoryInfo } from '../../core/types.js';

import { buildDoneChecklist } from '../../core/done-oracle.js';

import { repairGlobalProofOrStopLinkBeforeWorktreeDelete } from '../../handlers/worktree.js';

import { write, git } from './support.js';

export function assertGlobalLinkRepair(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-link-'));
  try {
    const mainRepo = join(root, 'repo');
    const worktree = join(root, 'repo', '.worktrees', 'B-smoke');
    const worktreePackage = join(worktree, 'packages', 'main');
    const mainPackage = join(mainRepo, 'packages', 'main');
    const globalPackage = join(root, 'global', 'node_modules', '@proofOrStop', 'core');
    mkdirSync(worktreePackage, { recursive: true });
    mkdirSync(mainPackage, { recursive: true });
    mkdirSync(dirname(globalPackage), { recursive: true });
    symlinkSync(worktreePackage, globalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const repaired = repairGlobalProofOrStopLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: globalPackage });
    assert.equal(repaired.action, 'relinked');
    assert.equal(lstatSync(globalPackage).isSymbolicLink(), true);
    assert.equal(resolve(dirname(globalPackage), readlinkSync(globalPackage)), resolve(mainPackage));

    const otherPackage = join(root, 'other', 'packages', 'main');
    const otherGlobalPackage = join(root, 'other-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(otherPackage, { recursive: true });
    mkdirSync(dirname(otherGlobalPackage), { recursive: true });
    symlinkSync(otherPackage, otherGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const skipped = repairGlobalProofOrStopLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: otherGlobalPackage });
    assert.equal(skipped.action, 'skipped');
    assert.equal(resolve(dirname(otherGlobalPackage), readlinkSync(otherGlobalPackage)), resolve(otherPackage));

    const normalInstall = join(root, 'normal-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(normalInstall, { recursive: true });
    const normalSkipped = repairGlobalProofOrStopLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: normalInstall });
    assert.equal(normalSkipped.action, 'skipped');
    assert.equal(existsSync(normalInstall), true);
    assert.equal(lstatSync(normalInstall).isDirectory(), true);

    const failingGlobalPackage = join(root, 'failing-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(dirname(failingGlobalPackage), { recursive: true });
    symlinkSync(worktreePackage, failingGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => repairGlobalProofOrStopLinkBeforeWorktreeDelete(worktree, mainRepo, {
        globalPackagePath: failingGlobalPackage,
        unlinkImpl: () => {
          throw new Error('mock unlink failure');
        },
      }),
      /Blocked deletion of .*mock unlink failure/,
    );
    assert.equal(resolve(dirname(failingGlobalPackage), readlinkSync(failingGlobalPackage)), resolve(worktreePackage));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function gitConfig(root: string, key: string, value: string): void {
  execFileSync('git', ['config', key, value], { cwd: root, stdio: 'ignore' });
}

export function gitCheckoutNewBranch(root: string, branch: string): void {
  execFileSync('git', ['checkout', '-b', branch], { cwd: root, stdio: 'ignore' });
}

export function gitCheckoutExistingBranch(root: string, branch: string): void {
  execFileSync('git', ['checkout', branch], { cwd: root, stdio: 'ignore' });
}

export function gitCurrentBranch(root: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function gitCommitCount(root: string): number {
  return parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim(), 10);
}

export function gitLastSubject(root: string): string {
  return execFileSync('git', ['log', '-1', '--pretty=%s'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function gitStatusPorcelain(root: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function setupAutoCommitFixture(): { root: string; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-auto-commit-'));
  // Init git repo + initial commit on main so branch checkout works
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  gitConfig(root, 'user.email', 'smoke@proofOrStop.test');
  gitConfig(root, 'user.name', 'smoke');
  gitConfig(root, 'commit.gpgsign', 'false');
  // proof-or-stop.config.json so loadConfig picks our story dir
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return { root, storyId: 'B-test1' };
}

export function writeFakeMetadata(root: string, storyId: string, content = '{"x":1}'): void {
  write(root, `.proof-or-stop/story/actives/${storyId}/findings.json`, content);
}

export function writeMaterialFile(root: string, content = 'export const X = 1;\n'): void {
  write(root, 'packages/main/src/foo.ts', content);
}

export function assertAutoCommitMetadataAcrossHandlers(): void {
  // Test 1 (happy): story/B-test1 branch, write fake metadata → helper commits
  // it and the user-visible hint matches the canonical prefix + reason + sha7.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), `auto-commit hint must start with the canonical prefix; got: ${JSON.stringify(out)}`);
      assert.match(out, /proof-or-stop: record B-test1 finding_add metadata/);
      assert.match(out, /\([0-9a-f]{7}\)/, 'auto-commit hint must include short sha (7 hex chars)');
      assert.equal(gitCommitCount(root), commitsBefore + 1);
      assert.match(gitLastSubject(root), /^proof-or-stop: record B-test1 finding_add metadata$/);
      assert.ok(!out.includes('untouched'), `no coexisting non-metadata dirt → tail-note must be omitted; got: ${JSON.stringify(out)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 2 (coexist): material source change coexists → metadata committed,
  // tail-note announces untouched non-metadata categories, material file
  // stays dirty on disk + git status confirms still M / ??.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeMaterialFile(root); // packages/main/src/foo.ts → material_source_changes
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'review_pass_set');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), 'prefix must match');
      assert.match(out, /proof-or-stop: record B-test1 review_pass_set metadata/);
      assert.match(out, /\(coexisting non-metadata dirt left untouched: [^)]*material_source_changes=1[^)]*\)/);
      assert.equal(gitCommitCount(root), commitsBefore + 1);
      // material file still dirty
      const status = gitStatusPorcelain(root);
      assert.ok(status.includes('packages/main/src/foo.ts'), `material file must remain dirty after helper; status: ${JSON.stringify(status)}`);
      // Classifier vocabulary parity (preMortem #3 — same words user sees)
      const classification = classifyGitStatusRows(
        status.split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      assert.equal(classification.groups.material_source_changes.length, 1);
      assert.equal(classification.groups.proof_or_stop_metadata_changes.length, 0, 'metadata category must be empty after auto-commit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 3 (no coexist): nothing else dirty → output has NO `untouched`
  // tail-note (CHK-002 edge — do not print empty parens / left-untouched: ).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const out = autoCommitStoryMetadata(root, storyId, 'summary_set');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX));
      assert.ok(!out.includes('untouched'), `no non-metadata dirt → tail-note must be omitted; got: ${JSON.stringify(out)}`);
      assert.ok(!out.includes('left-untouched'));
      assert.ok(!out.includes('()'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 4 (idempotent): consecutive calls produce at most one commit.
  // Second invocation with nothing staged returns '' and does not commit again.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const first = autoCommitStoryMetadata(root, storyId, 'checklist_update');
      assert.ok(first.startsWith(AUTO_COMMIT_METADATA_PREFIX));
      const commitsAfterFirst = gitCommitCount(root);
      const second = autoCommitStoryMetadata(root, storyId, 'checklist_update');
      assert.equal(second, '', `idempotent re-call must return empty; got: ${JSON.stringify(second)}`);
      assert.equal(gitCommitCount(root), commitsAfterFirst, 'no second commit when nothing is staged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 5 (main branch): on non-story/* branch helper returns '' silently
  // and does NOT produce a commit.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      assert.equal(gitCurrentBranch(root), 'main');
      writeFakeMetadata(root, storyId);
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.equal(out, '', `on main branch helper must be silent; got: ${JSON.stringify(out)}`);
      assert.equal(gitCommitCount(root), commitsBefore, 'no commit on main branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 6 (non-git temp root): validation/e2e fixtures that are not git
  // repos should return '' and should not create mutation:storyMetadataCommit
  // health noise.
  {
    const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-auto-commit-nongit-'));
    const previousHealthPath = process.env.PROOF_OR_STOP_HEALTH_PATH;
    process.env.PROOF_OR_STOP_HEALTH_PATH = join(root, 'health.jsonl');
    try {
      writeFakeMetadata(root, 'B-test1');
      const out = autoCommitStoryMetadata(root, 'B-test1', 'artifact_declare');
      assert.equal(out, '', `non-git roots should be treated as non-story workspaces; got: ${JSON.stringify(out)}`);
      assert.equal(
        readHealthIssues().filter(issue => issue.category === 'mutation:storyMetadataCommit').length,
        0,
        'non-git roots must not produce mutation:storyMetadataCommit health issues',
      );
    } finally {
      if (previousHealthPath === undefined) delete process.env.PROOF_OR_STOP_HEALTH_PATH;
      else process.env.PROOF_OR_STOP_HEALTH_PATH = previousHealthPath;
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 7 (real git failure): once inside a story/* checkout, staging/commit
  // failures remain health-reportable mutation failures.
  {
    const { root, storyId } = setupAutoCommitFixture();
    const previousHealthPath = process.env.PROOF_OR_STOP_HEALTH_PATH;
    process.env.PROOF_OR_STOP_HEALTH_PATH = join(root, 'health.jsonl');
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeFileSync(join(root, '.git', 'index.lock'), 'locked');
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.match(out, /proof-or-stop metadata auto-commit failed/, 'real git failures still return the user-visible warning');
      assert.doesNotMatch(out, /\bproofOrStop metadata auto-commit failed/, 'failure warning must not teach the deprecated brand');
      const issues = readHealthIssues().filter(issue => issue.category === 'mutation:storyMetadataCommit');
      assert.equal(issues.length, 1, 'real git checkout failures still produce one metadata health issue');
      assert.equal(issues[0].context.storyId, storyId);
      assert.equal(issues[0].context.reason, 'finding_add');
      assert.equal(issues[0].context.projectRoot, root);
    } finally {
      rmSync(join(root, '.git', 'index.lock'), { force: true });
      if (previousHealthPath === undefined) delete process.env.PROOF_OR_STOP_HEALTH_PATH;
      else process.env.PROOF_OR_STOP_HEALTH_PATH = previousHealthPath;
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 8 (path broaden): non-canonical storyId form throws synchronously
  // BEFORE any git invocation (preMortem #1 anchor). We probe path-traversal
  // (`../foo`), shell-metachar injection (`B-xx@injected`, `B-xx/yy`), and
  // empty / wrong-prefix inputs.
  {
    const { root } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, 'story/B-test1');
      for (const bad of ['B-xx@injected', '../foo', '', 'B-xx/yy', 'B-xx..yy', 'A-test1', 'B-', 'B- test', 'B-xx\\yy']) {
        assert.throws(
          () => autoCommitStoryMetadata(root, bad, 'finding_add'),
          /storyId must match/,
          `storyId=${JSON.stringify(bad)} should be rejected`,
        );
      }
      // Also confirm helper does not write a commit for these failures
      const startCommits = gitCommitCount(root);
      try { autoCommitStoryMetadata(root, '../foo', 'finding_add'); } catch { /* expected */ }
      assert.equal(gitCommitCount(root), startCommits, 'failed validation must not leave a commit behind');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 9 (prefix vocabulary parity with story-advance precedent — CHK-003
  // adversarial: byte-equal prefix `\n✓ proof-or-stop metadata auto-committed:`).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const out = autoCommitStoryMetadata(root, storyId, 'init_check_set');
      // Use indexOf instead of startsWith for crystal-clear failure message
      assert.equal(
        out.slice(0, AUTO_COMMIT_METADATA_PREFIX.length),
        AUTO_COMMIT_METADATA_PREFIX,
        'user-visible prefix must be byte-equal `\\n✓ proof-or-stop metadata auto-committed:`',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 10 (3+ handler reasons covered — CHK-004 happy): the same fixture +
  // 3 different reasons all produce the canonical hint format. Verifies the
  // helper is reason-agnostic, not hardcoded to a single phase like the old
  // story-advance copy.
  {
    const reasons = ['finding_add', 'checklist_update', 'summary_set'] as const;
    for (const reason of reasons) {
      const { root, storyId } = setupAutoCommitFixture();
      try {
        gitCheckoutNewBranch(root, `story/${storyId}`);
        writeFakeMetadata(root, storyId, `{"reason":"${reason}"}`);
        const out = autoCommitStoryMetadata(root, storyId, reason);
        assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), `reason=${reason} prefix mismatch`);
        assert.match(out, new RegExp(`proof-or-stop: record B-test1 ${reason} metadata`));
        assert.match(gitLastSubject(root), new RegExp(`^proof-or-stop: record B-test1 ${reason} metadata$`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  // Test 11 (classifier parity — CHK-004 adversarial): classifyDirtyWorktree
  // returns the same category counts whether helper was called or not for
  // non-metadata categories (auto-commit must not mask material/fixture/
  // unexpected dirt).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeMaterialFile(root);
      // Add an unexpected file too (outside src/ and tests/fixtures/)
      write(root, 'packages/main/tests/output/x', 'unexpected');

      const before = classifyGitStatusRows(
        gitStatusPorcelain(root).split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      const materialBefore = before.groups.material_source_changes.length;
      const unexpectedBefore = before.groups.unexpected_dirty_files.length;

      autoCommitStoryMetadata(root, storyId, 'finding_add');

      const after = classifyGitStatusRows(
        gitStatusPorcelain(root).split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      assert.equal(after.groups.material_source_changes.length, materialBefore, 'material dirt count unchanged by auto-commit');
      assert.equal(after.groups.unexpected_dirty_files.length, unexpectedBefore, 'unexpected dirt count unchanged by auto-commit');
      assert.equal(after.groups.proof_or_stop_metadata_changes.length, 0, 'metadata category drains to zero after auto-commit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export function assertDeclaredArtifactsChannel(): void {
  const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-declared-artifacts-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();
    const store = new StoryStore(root);

    // Seed a story so artifact_declare's storyExists check passes.
    const storyId = 'B-cftest';
    const now = '2026-05-15T18:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'declared-artifacts-smoke',
      title: 'Declared artifacts smoke',
      description: 'Per-story declared product artifact registration regression.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Declared item',
        context: 'happy intent for the BL21 viewer.',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'cli regenerates viewer', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    const handlers = createArtifactDeclareHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });

    // === Scenario 1 (happy): declare → classifier groups as declared_artifact_changes ===
    handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification',
      relatedIntent: 'CHK-001:happy:0',
    });
    const config = loadConfig(root);
    const dirtyLines = [`?? ${BL21}`];
    const declared = classifyGitStatusRows(
      dirtyLines,
      dirtyWorktreeClassifierOptionsForStory(config, storyId, store),
    );
    assert.equal(
      declared.groups.declared_artifact_changes.length,
      1,
      'declared artifact must land in declared_artifact_changes when story declared it',
    );
    assert.equal(declared.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(
      declared.groups.unexpected_dirty_files.length,
      0,
      'declared path must not leak into unexpected_dirty_files',
    );

    // === Scenario 2 (happy): same path WITHOUT declaration → unexpected_dirty_files ===
    const undeclared = classifyGitStatusRows(
      dirtyLines,
      dirtyWorktreeClassifierOptionsFromConfig(config),
    );
    assert.equal(
      undeclared.groups.declared_artifact_changes.length,
      0,
      'without per-story injection the declared_artifact_changes category must stay empty',
    );
    assert.equal(undeclared.groups.unexpected_dirty_files.length, 1, 'BL21 viewer falls through to unexpected by default');
    assert.equal(undeclared.groups.unexpected_dirty_files[0].path, BL21);

    // === Scenario 2b: a sibling undeclared path under same prefix STAYS unexpected ===
    const sibling = `${BL21.replace('prodenovo_viewer.json', 'other_snapshot.json')}`;
    const mixedDirty = [`?? ${BL21}`, `?? ${sibling}`];
    const mixed = classifyGitStatusRows(
      mixedDirty,
      dirtyWorktreeClassifierOptionsForStory(config, storyId, store),
    );
    assert.equal(mixed.groups.declared_artifact_changes.length, 1, 'only the declared path flips category');
    assert.equal(mixed.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(mixed.groups.unexpected_dirty_files.length, 1, 'sibling path stays in unexpected_dirty_files');
    assert.equal(mixed.groups.unexpected_dirty_files[0].path, sibling);

    // === Scenario 3 (edge/adversarial): malicious paths throw ===
    const malicious: string[] = [
      'tests/output/*',
      'tests/output/**/*.json',
      '../escape.json',
      'tests/output/../escape.json',
      '/abs/path.json',
      'tests/output/foo?.json',
      'tests/output/[abc].json',
    ];
    for (const evil of malicious) {
      assert.throws(
        () => handlers.artifact_declare({
          storyId,
          path: evil,
          reason: 'should not be allowed in any case',
          relatedIntent: 'CHK-001:happy:0',
        }),
        /artifact_declare: path /,
        `path ${JSON.stringify(evil)} must be rejected`,
      );
    }

    // === Scenario 3b: bad relatedIntent shape also throws ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: 'tests/output/some.json',
        reason: 'reason text long enough',
        relatedIntent: 'not-a-valid-ref',
      }),
      /relatedIntent must match/,
      'malformed relatedIntent must be rejected at handler entry',
    );

    // === Scenario 4 (adversarial): DONE gate reference checker ===
    // (a) matching → no unreferenced.
    const checklistData = store.readChecklist(storyId);
    const declaredEntries = store.readDeclaredArtifacts(storyId);
    const matchedResult = evaluateDeclaredArtifactReferences(declaredEntries, checklistData, null);
    assert.equal(matchedResult.total, 1);
    assert.equal(matchedResult.unreferenced.length, 0, 'CHK-001:happy:0 matches the seeded verificationIntent slot');

    // (b) bogus intentRef → unreferenced.
    handlers.artifact_declare({
      storyId,
      path: 'tests/output/bogus.json',
      reason: 'second declaration with bogus ref for gate adversarial test',
      relatedIntent: 'CHK-999:happy:0',
    });
    const withBogus = store.readDeclaredArtifacts(storyId);
    const bogusResult = evaluateDeclaredArtifactReferences(withBogus, checklistData, null);
    assert.equal(bogusResult.total, 2);
    assert.equal(bogusResult.unreferenced.length, 1, 'CHK-999:happy:0 has no matching checklist item');
    assert.equal(bogusResult.unreferenced[0].relatedIntent, 'CHK-999:happy:0');

    // (c) coexisting matching + unreferenced still reports the unreferenced (1 is enough to block).
    const coexistResult = evaluateDeclaredArtifactReferences(withBogus, checklistData, null);
    assert.ok(coexistResult.unreferenced.length >= 1, 'at least one unreferenced entry must surface');

    // === Scenario 5: idempotency — re-declare same path overwrites entry.
    //     Run BEFORE the promise: stub block since that block rewrites the file.
    const beforeIdem = store.readDeclaredArtifacts(storyId);
    const idemOut = handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification (rewrite)',
      relatedIntent: 'CHK-001:happy:0',
    });
    assert.match(idemOut, /overwritten/, 'second declaration of same path must mention overwrite');
    const afterIdem = store.readDeclaredArtifacts(storyId);
    assert.equal(afterIdem.entries.length, beforeIdem.entries.length, 're-declaring same path must not duplicate entries');

    // (d) promise:<docPath> ref resolves when delivery-check.docsPromises contains the docPath.
    //     Use a separate store rooted at a fresh temp dir so we don't trample
    //     the previous-scenario fixtures.
    const promiseRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-declared-artifacts-promise-'));
    try {
      write(promiseRoot, 'proof-or-stop.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        testsDir: 'packages/main/tests',
        fixturesDir: 'packages/main/tests/fixtures',
        storyDir: '.proof-or-stop/story/actives',
        requirementsDir: 'docs/requirements',
      }));
      resetConfigCache();
      const promiseStore = new StoryStore(promiseRoot);
      promiseStore.writeStory(storyId, story);
      promiseStore.writeChecklist(storyId, checklist);
      promiseStore.writeDeclaredArtifacts(storyId, {
        entries: [{
          path: 'tests/output/with-promise.json',
          reason: 'promise ref smoke entry',
          relatedIntent: 'promise:CLAUDE.md#section-foo',
          declaredAt: now,
        }],
      });
      const declaredPromiseOnly = promiseStore.readDeclaredArtifacts(storyId);
      const deliveryStub = {
        storyId,
        checkedAt: now,
        reviewRound: now,
        agentId: 'proof-or-stop-review-delivery',
        docsPromises: [{ docPath: 'CLAUDE.md#section-foo', promise: 'doc promise', verifiedBy: 'grep', evidence: 'observed' }],
        realMachineTests: [],
        closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'ok summary text' },
        _hash: 'stub',
      };
      const promiseResult = evaluateDeclaredArtifactReferences(declaredPromiseOnly, null, deliveryStub);
      assert.equal(promiseResult.unreferenced.length, 0, 'promise:<docPath> ref must resolve via delivery-check docsPromises');
    } finally {
      rmSync(promiseRoot, { recursive: true, force: true });
      resetConfigCache();
    }

    // (e) empty entries → zero unreferenced, gate caller treats as informational.
    const emptyResult = evaluateDeclaredArtifactReferences({ entries: [] }, checklistData, null);
    assert.equal(emptyResult.total, 0);
    assert.equal(emptyResult.unreferenced.length, 0, 'empty declared-artifacts must not synthesize blockers');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDeclaredArtifactGateHotfix(): void {
  const ATTACK_SOURCE = 'packages/main/src/core/store.ts';
  const FIXTURE_PATH = 'packages/main/tests/fixtures/sample-fixture.json';
  const GENERATED_OUTPUT = 'packages/main/tests/output/declared-generated.json';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-declared-gate-hotfix-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-hotfix';
    const now = '2026-05-15T21:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'declared-gate-hotfix-smoke',
      title: 'Declared gate hotfix smoke',
      description: 'Attack-chain regression for the declared-artifact gate bypass.',
      type: 'chore',
      phase: 'DEV',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    };
    store.writeStory(storyId, story);

    const handlers = createArtifactDeclareHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const config = loadConfig(root);

    // === CHK-002: artifact_declare rejects material source path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: ATTACK_SOURCE,
        reason: 'attacker tries to declare a dirty source file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as material_source_changes and cannot be declared/,
      'artifact_declare must reject packages/main/src/core/store.ts',
    );
    // === CHK-002: artifact_declare rejects fixture path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: FIXTURE_PATH,
        reason: 'attacker tries to declare a fixture file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as fixture_changes and cannot be declared/,
      'artifact_declare must reject a fixture path',
    );
    // === CHK-002: artifact_declare rejects config / proof-or-stop-metadata paths ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: 'CLAUDE.md',
        reason: 'attacker tries to declare a config doc',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as material_source_changes and cannot be declared/,
      'artifact_declare must reject a config path (materialSourceFiles)',
    );
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.proof-or-stop/story/actives/B-hotfix/index.json',
        reason: 'attacker tries to declare proof-or-stop metadata',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as proof_or_stop_metadata_changes and cannot be declared/,
      'artifact_declare must reject a proof-or-stop-metadata path',
    );
    // === CHK-002 (B-8db9 F-002): artifact_declare rejects a runtime artifact path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.proof-or-stop/activity.jsonl',
        reason: 'attacker tries to declare a runtime activity log',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /is a runtime artifact, already handled by runtime-artifact-registry/,
      'artifact_declare must reject a runtime artifact path (.proof-or-stop/activity.jsonl)',
    );
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.proof-or-stop-serve.json',
        reason: 'attacker tries to declare the dev-server handshake file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /is a runtime artifact, already handled by runtime-artifact-registry/,
      'artifact_declare must reject a runtime artifact path (.proof-or-stop-serve.json)',
    );
    // === CHK-002 happy: a tests/output/ generated path is declarable ===
    handlers.artifact_declare({
      storyId,
      path: GENERATED_OUTPUT,
      reason: 'legitimate generated output declared for verification',
      relatedIntent: 'CHK-001:happy:0',
    });
    assert.equal(
      store.readDeclaredArtifacts(storyId).entries.some(e => e.path === GENERATED_OUTPUT),
      true,
      'a tests/output/ generated path must be declarable',
    );

    // === CHK-001 hard gate: hand-inject a declared-artifacts.json with the
    //     attack source path (NOT via artifact_declare) — the classifier must
    //     still group the dirty source file as material_source_changes. ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [
        { path: GENERATED_OUTPUT, reason: 'generated output', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
        { path: ATTACK_SOURCE, reason: 'hand-injected source path bypassing artifact_declare', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
        { path: FIXTURE_PATH, reason: 'hand-injected fixture path bypassing artifact_declare', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
      ],
    });
    const optsForStory = dirtyWorktreeClassifierOptionsForStory(config, storyId, store);
    const injected = classifyGitStatusRows(
      [` M ${ATTACK_SOURCE}`, ` M ${FIXTURE_PATH}`, `?? ${GENERATED_OUTPUT}`],
      optsForStory,
    );
    assert.equal(
      injected.groups.material_source_changes.length, 1,
      'dirty source file stays material_source_changes even when declared (classifier hard gate)',
    );
    assert.equal(injected.groups.material_source_changes[0].path, ATTACK_SOURCE);
    assert.equal(
      injected.groups.fixture_changes.length, 1,
      'dirty fixture file stays fixture_changes even when declared (declared check runs after fixture)',
    );
    assert.equal(injected.groups.fixture_changes[0].path, FIXTURE_PATH);
    assert.equal(
      injected.groups.declared_artifact_changes.length, 1,
      'only the genuine generated-output path stays declared_artifact_changes',
    );
    assert.equal(injected.groups.declared_artifact_changes[0].path, GENERATED_OUTPUT);

    // === CHK-001/CHK-003 cross-check: the declared generated output is
    //     non-blocking in a REVIEW/TEST gate context (dirty-gate-policy
    //     untouched) — only its uncommitted state blocks DONE. ===
    const reviewGate = evaluateDirtyGate(injected, {
      storyId,
      gate: 'test-pre-check',
      writer: null,
    });
    assert.equal(
      (reviewGate.passingCounts.declared_artifact_changes ?? 0), 1,
      'declared generated output is a passing (non-blocking) category in REVIEW/TEST gate context',
    );
    assert.equal(
      reviewGate.allPass, false,
      'the dirty source + fixture rows still block REVIEW/TEST (classifier reorder works)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertDeclaredArtifactDoneCommittedRow(): void {
  const GENERATED_OUTPUT = 'packages/main/tests/output/declared-generated.json';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-declared-committed-row-'));
  try {
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed committed-row smoke']);
    resetConfigCache();

    const store = new StoryStore(root);
    const storyId = 'B-committed';
    const now = '2026-05-15T21:30:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'declared-committed-row-smoke',
      title: 'Declared committed row smoke',
      description: 'DONE committed-check row regression.',
      type: 'chore',
      phase: 'TEST',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    });

    function committedRow(): { status: string; blocking: boolean; detail: string; hint?: string } {
      const rows = buildDoneChecklist(storyId, store, root);
      const row = rows.find(r => r.id === 'declared-artifacts-committed');
      assert.ok(row, 'buildDoneChecklist must emit a declared-artifacts-committed row');
      return row as { status: string; blocking: boolean; detail: string; hint?: string };
    }

    // === No declarations → pass non-blocking ===
    store.writeDeclaredArtifacts(storyId, { entries: [] });
    let row = committedRow();
    assert.equal(row.status, 'pass', 'empty declarations → committed row passes');
    assert.equal(row.blocking, false, 'empty declarations → committed row non-blocking');

    // === Uncommitted (untracked) declared artifact → fail/blocking ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: GENERATED_OUTPUT, reason: 'declared deliverable', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    write(root, GENERATED_OUTPUT, '{"generated":true}\n');
    row = committedRow();
    assert.equal(row.status, 'fail', 'untracked declared artifact → committed row fails');
    assert.equal(row.blocking, true, 'untracked declared artifact → committed row blocking');
    assert.match(row.detail, /uncommitted/, 'detail must name the uncommitted path');
    assert.match(row.hint ?? '', /commit|delete/, 'hint must give commit/cleanup guidance');

    // === committed-and-clean → pass ===
    git(root, ['add', GENERATED_OUTPUT]);
    git(root, ['commit', '-m', 'commit declared artifact']);
    row = committedRow();
    assert.equal(row.status, 'pass', 'committed-and-clean declared artifact → committed row passes');
    assert.equal(row.blocking, false, 'committed-and-clean → non-blocking');
    assert.match(row.detail, /1\/1/, 'detail shows 1/1 committed');

    // === absent (cleaned up) declared artifact → pass ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: 'packages/main/tests/output/never-existed.json', reason: 'temp output cleaned up', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    row = committedRow();
    assert.equal(row.status, 'pass', 'absent declared artifact → committed row passes (cleaned up is acceptable)');
    assert.equal(row.blocking, false, 'absent declared artifact → non-blocking');

    // === git-ignored declared path → fail/blocking with explicit message ===
    write(root, '.gitignore', 'packages/main/tests/output/ignored-output.json\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'add gitignore']);
    const IGNORED = 'packages/main/tests/output/ignored-output.json';
    write(root, IGNORED, '{"ignored":true}\n');
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: IGNORED, reason: 'mistakenly declared a git-ignored path', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    row = committedRow();
    assert.equal(row.status, 'fail', 'git-ignored declared path → committed row fails');
    assert.equal(row.blocking, true, 'git-ignored declared path → committed row blocking');
    assert.match(row.detail, /git-ignored/, 'detail must name the git-ignored status');
    assert.match(
      row.hint ?? '', /git-ignored paths must not be declared as deliverable artifacts/,
      'git-ignored declared path → explicit preMortem #2 message',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}
