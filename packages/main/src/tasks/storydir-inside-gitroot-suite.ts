#!/usr/bin/env node

/**
 * B-198c CHK-004 consolidated test suite: storyDir-inside-gitRoot detection
 * helper + `proof-or-stop doctor` check + early advisory (story_create /
 * session_brief), exercised end-to-end against real-git temp fixtures.
 *
 * The git-backed lifecycle must git-commit story metadata (scoped story branch
 * + DONE merge to main), which requires the story metadata dir to resolve
 * INSIDE the resolved git root. The only late detectors are two guards
 * (worktree.ts:754 + cli-engine reconcile) that fire at INIT_CHECK bootstrap —
 * by then INIT/PLAN effort is already invested. B-198c adds an EARLY, purely
 * additive detection layer:
 *  - CHK-001 helpers: `evaluateStoryDirInsideGitRoot` (id-dependent) and
 *    `evaluateStoryDirConfigInsideGitRoot` (id-independent, project-level).
 *  - CHK-002 doctor: `evaluateStoryDirConfigInsideGitRoot` → JSON block +
 *    rendered scan text.
 *  - CHK-003 advisory: `storyDirOutsideGitRootAdvisory` (story_create, stderr)
 *    + the session_brief advisory line.
 *
 * This suite drives the REAL function / handler entry points via direct dist
 * imports (NOT the global `proof-or-stop` binary, which resolves to the main repo).
 * It covers the full scenario matrix:
 *   1. INSIDE     : storyDir inside gitRoot → ok, no violation, healthy doctor
 *                   pass line, advisories silent.
 *   2. SIBLING    : storyDir as a `..` sibling of gitRoot (ClawCreek wrapper
 *                   root) → ok=false, reason='outside-gitroot', doctor flagged
 *                   ✗ block with both abs paths + remediation, both advisories
 *                   emit the one-line ⚠.
 *   3. SYMLINK    : symlinked roots → realpath both sides → NO false violation.
 *   4. NO-GITROOT : no configured/resolvable gitRoot → reason='gitroot-
 *                   unresolved', no violation, no advisory, no throw; doctor
 *                   reports it as a SEPARATE informational line.
 *
 * The two late guards (worktree.ts / cli-engine.ts) are untouched by this
 * story, so this suite deliberately contains NO guard-behavior tests.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import {
  evaluateStoryDirConfigInsideGitRoot,
  evaluateStoryDirInsideGitRoot,
  type StoryDirInsideGitRootResult,
} from '../core/story-signed-workspace-resolution.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import { storyDirOutsideGitRootAdvisory } from '../handlers/story-create.js';
import { createSessionHandlers } from '../handlers/session.js';

// B-623a: keep this smoke hermetic and fast — doctor now runs an advisory host
// burn scan over the real ~/.codex / ~/.claude stores by default; 0 disables it.
process.env.PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS = '0';

const STORY_DIR_REL = '.proof-or-stop/story/actives';
const STORY_ID = 'B-test';
const ADVISORY_PREFIX = '⚠ storyDir resolves outside the resolved gitRoot';
const ADVISORY_REMEDIATION = '→ configure storyDir so story metadata lives inside the gitRoot.';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('config user.email suite@test.local', dir);
  git('config user.name suite', dir);
}

/** Write proof-or-stop.config.json so StoryStore + resolution share storyDir / gitRoot. */
function writeConfig(metadataRoot: string, gitRoot?: string): void {
  const cfg: Record<string, unknown> = { storyDir: STORY_DIR_REL };
  if (gitRoot !== undefined) cfg.gitRoot = gitRoot;
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify(cfg, null, 2));
}

/** Materialize a story index.json under metadataRoot's configured storyDir. */
function writeStoryIndex(metadataRoot: string): void {
  const storyDir = join(metadataRoot, STORY_DIR_REL, STORY_ID);
  mkdirSync(storyDir, { recursive: true });
  const story = {
    storyId: STORY_ID,
    name: 'suite',
    title: 'suite',
    description: 'suite',
    phase: 'PLAN',
    type: 'feature',
    priority: 'low',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(storyDir, 'index.json'), JSON.stringify(story, null, 2));
}

/** Drive the REAL doctor handler; return its JSON storyDirGitRoot block + text. */
async function runDoctor(root: string): Promise<{
  json: {
    ok: boolean;
    storyDirAbs: string;
    gitRootAbs: string | null;
    rel: string | null;
    reason: string | null;
    violation: boolean;
    gitRootUnresolved: boolean;
  };
  text: string;
}> {
  const store = new StoryStore(root);
  const handlers = createDoctorHandlers({ store, root, scanRoot: root });
  const json = (await handlers.doctor({ format: 'json' })) as Record<string, unknown>;
  const text = String(await handlers.doctor({ format: 'text' }));
  return {
    json: json.storyDirGitRoot as StoryDirInsideGitRootResult & {
      violation: boolean;
      gitRootUnresolved: boolean;
      reason: string | null;
    },
    text,
  };
}

/** Drive the REAL session_brief handler and return its rendered text. */
function runSessionBrief(root: string): string {
  const store = new StoryStore(root);
  const handlers = createSessionHandlers({ store, root, scanRoot: root });
  return String(handlers.session_brief({}));
}

const base = mkdtempSync(join(tmpdir(), 'proof-or-stop-storydir-gitroot-suite-'));

console.log('storyDir-inside-gitRoot consolidated suite (B-198c CHK-004)');

try {
  // ── Scenario 1: INSIDE — storyDir inside gitRoot (metadataRoot == gitRoot) ──
  {
    const root = join(base, 'inside');
    initGitRepo(root);
    writeConfig(root); // no configured gitRoot; metadataRoot itself is git-backed
    writeStoryIndex(root);
    const store = new StoryStore(root);

    await check('scenario1.inside: id-dependent helper → ok, no reason', async () => {
      const r = evaluateStoryDirInsideGitRoot({ store, storyId: STORY_ID, metadataRoot: root });
      assert.equal(r.ok, true);
      assert.equal(r.reason, undefined);
      assert.equal(r.gitRootAbs, realpathSync(root));
      assert.ok(r.rel && !r.rel.split('/').includes('..'));
      assert.match(r.storyDirAbs, /B-test$/);
    });

    await check('scenario1.inside: id-independent helper → ok, no reason', async () => {
      const r = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root });
      assert.equal(r.ok, true);
      assert.equal(r.reason, undefined);
      assert.equal(r.gitRootAbs, realpathSync(root));
      assert.ok(r.rel && !r.rel.split('/').includes('..'));
    });

    await check('scenario1.inside: doctor → healthy pass line, no violation', async () => {
      const { json, text } = await runDoctor(root);
      assert.equal(json.ok, true);
      assert.equal(json.violation, false);
      assert.equal(json.gitRootUnresolved, false);
      assert.equal(json.reason, null);
      assert.ok(text.includes('✓ storyDir resolves inside the resolved gitRoot'));
      assert.ok(!text.includes('✗ storyDir resolves OUTSIDE the resolved gitRoot'));
    });

    await check('scenario1.inside: story_create advisory → empty', async () => {
      assert.equal(storyDirOutsideGitRootAdvisory(root), '');
    });

    await check('scenario1.inside: session_brief → no advisory line', async () => {
      assert.ok(!runSessionBrief(root).includes(ADVISORY_PREFIX));
    });
  }

  // ── Scenario 2: SIBLING — storyDir as a `..` sibling of gitRoot (ClawCreek) ──
  // wrapper-root layout: metadataRoot = wrapper dir; configured gitRoot is a
  // subdir; story metadata lives at the wrapper root → OUTSIDE the gitRoot.
  {
    const wrapper = join(base, 'wrapper');
    mkdirSync(wrapper, { recursive: true });
    const innerGit = join(wrapper, 'clawcreek');
    initGitRepo(innerGit);
    writeConfig(wrapper, 'clawcreek'); // gitRoot = subdir; storyDir at wrapper root
    writeStoryIndex(wrapper);
    const store = new StoryStore(wrapper);
    const expectedStoryDir = join(realpathSync(wrapper), STORY_DIR_REL);
    const expectedGitRoot = realpathSync(innerGit);

    await check('scenario2.sibling: id-dependent helper → violation outside-gitroot', async () => {
      const r = evaluateStoryDirInsideGitRoot({ store, storyId: STORY_ID, metadataRoot: wrapper });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'outside-gitroot');
      assert.ok(r.gitRootAbs);
      assert.ok(r.rel && r.rel.split('/').includes('..'), 'rel must contain a .. segment');
    });

    await check('scenario2.sibling: id-independent helper → violation outside-gitroot', async () => {
      const r = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: wrapper });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'outside-gitroot');
      assert.equal(r.gitRootAbs, expectedGitRoot);
      assert.ok(r.rel && r.rel.split('/').includes('..'));
    });

    await check('scenario2.sibling: doctor → flagged ✗ block + both abs paths + remediation', async () => {
      const { json, text } = await runDoctor(wrapper);
      assert.equal(json.ok, false);
      assert.equal(json.violation, true);
      assert.equal(json.gitRootUnresolved, false);
      assert.equal(json.reason, 'outside-gitroot');
      assert.equal(json.storyDirAbs, expectedStoryDir);
      assert.equal(json.gitRootAbs, expectedGitRoot);
      assert.ok(text.includes('✗ storyDir resolves OUTSIDE the resolved gitRoot'));
      assert.ok(text.includes(`storyDir: ${expectedStoryDir}`));
      assert.ok(text.includes(`gitRoot:  ${expectedGitRoot}`));
      assert.ok(text.includes(ADVISORY_REMEDIATION));
    });

    await check('scenario2.sibling: story_create advisory → one-line ⚠ with both paths', async () => {
      const note = storyDirOutsideGitRootAdvisory(wrapper);
      assert.ok(note.startsWith(ADVISORY_PREFIX));
      assert.ok(note.includes(expectedStoryDir));
      assert.ok(note.includes(expectedGitRoot));
      assert.ok(note.includes(ADVISORY_REMEDIATION));
      assert.ok(!note.includes('\n'), 'advisory is a single line');
    });

    await check('scenario2.sibling: session_brief → emits the ⚠ advisory line', async () => {
      const text = runSessionBrief(wrapper);
      const line = text.split('\n').find((l) => l.startsWith(ADVISORY_PREFIX));
      assert.ok(line, 'session_brief must surface the advisory line');
      assert.ok(line!.includes(expectedStoryDir));
      assert.ok(line!.includes(expectedGitRoot));
      assert.ok(line!.includes(ADVISORY_REMEDIATION));
    });
  }

  // ── Scenario 3: SYMLINK — symlinked roots resolved via realpath → no false ──
  // A symlink pointing at the real git root must NOT be mislabeled as outside.
  {
    const realRoot = join(base, 'sym-real');
    initGitRepo(realRoot);
    writeStoryIndex(realRoot);
    const linkRoot = join(base, 'sym-link');
    symlinkSync(realRoot, linkRoot, 'dir');
    writeConfig(linkRoot); // config read through the symlinked path
    const store = new StoryStore(linkRoot);

    await check('scenario3.symlink: id-dependent helper → no false violation', async () => {
      const r = evaluateStoryDirInsideGitRoot({ store, storyId: STORY_ID, metadataRoot: linkRoot });
      assert.equal(r.ok, true);
      assert.equal(r.reason, undefined);
      assert.ok(r.rel !== null && !r.rel.split('/').includes('..'));
    });

    await check('scenario3.symlink: id-independent helper → no false violation', async () => {
      const r = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: linkRoot });
      assert.equal(r.ok, true);
      assert.equal(r.reason, undefined);
      assert.ok(r.rel !== null && !r.rel.split('/').includes('..'));
    });

    await check('scenario3.symlink: doctor → healthy pass line (realpath both sides)', async () => {
      const { json, text } = await runDoctor(linkRoot);
      assert.equal(json.ok, true);
      assert.equal(json.violation, false);
      assert.equal(json.reason, null);
      assert.ok(text.includes('✓ storyDir resolves inside the resolved gitRoot'));
    });

    await check('scenario3.symlink: advisories silent', async () => {
      assert.equal(storyDirOutsideGitRootAdvisory(linkRoot), '');
      assert.ok(!runSessionBrief(linkRoot).includes(ADVISORY_PREFIX));
    });
  }

  // ── Scenario 4: NO-GITROOT — no resolvable/configured gitRoot → unresolved ──
  // metadataRoot is NOT git-backed and no gitRoot configured.
  {
    const root = join(base, 'no-git');
    mkdirSync(root, { recursive: true }); // plain dir, no git init
    writeConfig(root); // no gitRoot configured
    writeStoryIndex(root);
    const store = new StoryStore(root);

    await check('scenario4.no-gitRoot: id-dependent helper → gitroot-unresolved, no throw', async () => {
      const r = evaluateStoryDirInsideGitRoot({ store, storyId: STORY_ID, metadataRoot: root });
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'gitroot-unresolved');
      assert.equal(r.gitRootAbs, null);
      assert.equal(r.rel, null);
    });

    await check('scenario4.no-gitRoot: id-independent helper → gitroot-unresolved, no throw', async () => {
      const r = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root });
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'gitroot-unresolved');
      assert.equal(r.gitRootAbs, null);
      assert.equal(r.rel, null);
    });

    await check('scenario4.no-gitRoot: doctor → SEPARATE unresolved line, NOT a violation', async () => {
      const { json, text } = await runDoctor(root);
      assert.equal(json.ok, true);
      assert.equal(json.violation, false);
      assert.equal(json.gitRootUnresolved, true);
      assert.equal(json.reason, 'gitroot-unresolved');
      assert.equal(json.gitRootAbs, null);
      assert.ok(text.includes('- gitRoot unresolved'));
      assert.ok(!text.includes('✗ storyDir resolves OUTSIDE the resolved gitRoot'));
    });

    await check('scenario4.no-gitRoot: advisories silent (never nag not-yet-git setups)', async () => {
      assert.equal(storyDirOutsideGitRootAdvisory(root), '');
      assert.ok(!runSessionBrief(root).includes(ADVISORY_PREFIX));
    });

    await check('scenario4.no-gitRoot: project-level entry points never throw with absent story metadata', async () => {
      // The id-independent helper + the story_create advisory are the surfaces
      // the doctor / story_create / session_brief call (they have no story id).
      // They must be TOTAL even when no story metadata exists on disk — they do
      // not read any story (unlike the id-dependent helper, whose "never throws"
      // guarantee is exercised in the smoke / scenario1-3 with a story present
      // and which legitimately requires the story to exist via readStory).
      const bareRoot = join(base, 'no-git-bare');
      mkdirSync(bareRoot, { recursive: true }); // config only, NO story index.json
      writeConfig(bareRoot);
      let threw = false;
      try {
        const idIndependent = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: bareRoot });
        assert.equal(idIndependent.reason, 'gitroot-unresolved');
        assert.equal(storyDirOutsideGitRootAdvisory(bareRoot), '');
      } catch {
        threw = true;
      }
      assert.equal(threw, false);
    });

    await check('scenario4.no-gitRoot: helper stays TOTAL for a legacy non-canonical storyDir (guard removed; loadConfig no longer throws)', async () => {
      // B-b837: the legacy write-path guard was removed, so loadConfig()
      // no longer throws for a non-canonical storyDir. The helper must still
      // produce a safe result and the story_create advisory must stay silent (no gitRoot).
      const legacyRoot = join(base, 'legacy-storydir-config');
      mkdirSync(legacyRoot, { recursive: true });
      writeFileSync(
        join(legacyRoot, 'proof-or-stop.config.json'),
        JSON.stringify({ storyDir: 'legacy/story/actives' }, null, 2),
      );
      let threw = false;
      let result: StoryDirInsideGitRootResult | null = null;
      try {
        result = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: legacyRoot });
        assert.equal(storyDirOutsideGitRootAdvisory(legacyRoot), '');
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'helper must not propagate any loadConfig error');
      assert.equal(result?.ok, true, 'no gitRoot => safe non-violation');
      assert.equal(result?.reason, 'gitroot-unresolved', 'safe fallback reason');
      assert.equal(result?.gitRootAbs, null, 'no gitRoot on safe fallback');
    });
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n✓ storyDir-inside-gitRoot consolidated suite passed (${passed} checks)`);
