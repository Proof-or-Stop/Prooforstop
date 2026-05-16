#!/usr/bin/env node
/**
 * B-6812 CHK-001: concurrency smoke for story_create's directory lock.
 *
 * Verifies the G1 fix: concurrent `koala story_create` calls with the SAME
 * `name` must not slip past the idempotency check and materialize two stories.
 *
 * Anti-fake-concurrency design (decision explicitly requires this):
 *  - We spawn REAL OS child processes running the built `cli.js`, not an
 *    in-process `Promise.all` over the handler. Each process has its own JS
 *    heap; the only shared state is the filesystem — exactly the production
 *    race. `Promise.all` over in-process calls would serialize on the single
 *    event loop and prove nothing.
 *  - All children are spawned BEFORE any of them is awaited, so they race for
 *    the lock concurrently. Multiple rounds increase the chance of catching a
 *    regression where the lock is removed.
 *  - Each child writes its own stdout/stderr to a temp file so post-mortem
 *    inspection is possible if the assertion fails.
 *
 * Non-default storyDir coverage (decision preMortem "锁错目录形成假安全"):
 *  - Round set A uses the default storyDir.
 *  - Round set B uses a NON-default storyDir (`custom/stories/here`). If the
 *    lock path were hardcoded to docs/story or .koala/story, the lock dir and
 *    the actual write target would diverge and the race would reopen — this
 *    round would then produce duplicates and fail.
 *
 * B-6812 CHK-002 dedup coverage (separate `runDedupScenario`):
 *  - normalized-name hit: "Fix Login" then "fix-login" → second reuses the
 *    first story's id (G2: exact-name match used to miss this).
 *  - keyword full overlap on an ACTIVE non-terminal story → hard block;
 *    forceNew:true overrides the block and creates a fresh story.
 *  - partial keyword overlap (ratio < 1) → no block, new story created.
 *  - keyword full overlap against a DONE story → no block (terminal stories
 *    only warn, never block).
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const VALID_BACKGROUND = [
  '## 触发事件',
  '2026-05-16 B-6812 concurrency smoke needs a trigger section long enough to clear background validation thresholds.',
  '## 关键洞察',
  'Concurrent story_create with the same name must serialize on a directory lock so idempotency holds under a real OS race.',
  '## 方案取舍',
  'The smoke spawns genuine child processes instead of an in-process Promise.all so the only shared state is the filesystem.',
  '## 对话纹理',
  'A maintainer running two agents on the same backlog item sees one story reused, never two duplicates landing side by side.',
].join('\n\n');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Spawn one real `koala story_create` child; resolves with its exit info. */
function spawnCreate(
  root: string,
  storyName: string,
  logPath: string,
): Promise<{ code: number; output: string }> {
  const args = JSON.stringify({
    name: storyName,
    title: `Concurrency probe ${storyName}`,
    description: 'Concurrent story_create duplicate-creation guard probe.',
    type: 'chore',
    priority: 'medium',
    background: VALID_BACKGROUND,
    checklist: [{ title: 'probe item', context: 'probe context for concurrency smoke' }],
  });
  const out = openSync(logPath, 'w');
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [cliPath, '--root', root, 'story_create', args], {
      cwd: root,
      stdio: ['ignore', out, out],
    });
    child.on('close', (code) => {
      resolveP({ code: code ?? -1, output: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' });
    });
  });
}

/** Count distinct story directories that have an index.json under a storyDir base. */
function countStoryDirs(storyDirAbs: string): string[] {
  if (!existsSync(storyDirAbs)) return [];
  return readdirSync(storyDirAbs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(storyDirAbs, d.name, 'index.json')))
    .sort()
    .map((d) => d.name);
}

interface RoundConfig {
  label: string;
  storyDir: string; // relative path stored in koala.config.json
}

async function runScenario(cfg: RoundConfig): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'koala-story-create-conc-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    writeFile(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: cfg.storyDir,
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    writeFile(root, 'README.md', 'concurrency smoke\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);

    const storyDirAbs = join(root, cfg.storyDir);
    const rounds = 4;
    // 10 concurrent processes per round — matches the CHK-001:adversarial:0
    // intent (high-concurrency mutual-exclusion stress).
    const procsPerRound = 10;

    for (let r = 0; r < rounds; r++) {
      const storyName = `conc-probe-${cfg.label}-r${r}`;
      const logDir = join(root, `.logs-r${r}`);
      mkdirSync(logDir, { recursive: true });

      // Spawn all children FIRST (real concurrency), then await them together.
      const pending: Array<Promise<{ code: number; output: string }>> = [];
      for (let p = 0; p < procsPerRound; p++) {
        pending.push(spawnCreate(root, storyName, join(logDir, `proc-${p}.log`)));
      }
      const results = await Promise.all(pending);

      // Every child must exit cleanly: the winner creates, the rest hit the
      // idempotency reuse branch. A non-zero exit (e.g. lock timeout / crash)
      // is itself a failure.
      for (let p = 0; p < results.length; p++) {
        assert.equal(
          results[p].code, 0,
          `[${cfg.label}] round ${r} proc ${p} exited ${results[p].code}\n${results[p].output}`,
        );
      }

      // Exactly one story dir must exist for this name's round. Without the
      // lock, two racers both pass the idempotency scan and write two dirs.
      const dirs = countStoryDirs(storyDirAbs).filter((id) => {
        try {
          const idx = JSON.parse(readFileSync(join(storyDirAbs, id, 'index.json'), 'utf8'));
          return idx.name === storyName;
        } catch {
          return false;
        }
      });
      assert.equal(
        dirs.length, 1,
        `[${cfg.label}] round ${r}: expected exactly 1 story for name="${storyName}", got ${dirs.length}: ${dirs.join(', ')}`,
      );

      // Exactly one child reports "created"; the others report reuse.
      const createdCount = results.filter((res) => /Story B-[a-f0-9]+ created/.test(res.output)).length;
      const reusedCount = results.filter((res) => /Story already exists/.test(res.output)).length;
      assert.equal(
        createdCount, 1,
        `[${cfg.label}] round ${r}: expected exactly 1 "created" winner, got ${createdCount}`,
      );
      assert.equal(
        createdCount + reusedCount, procsPerRound,
        `[${cfg.label}] round ${r}: every process must create-or-reuse (created=${createdCount} reused=${reusedCount})`,
      );

      // The lock dir must be released after the round (no leaked .create.lock).
      assert.equal(
        existsSync(join(storyDirAbs, '.create.lock')), false,
        `[${cfg.label}] round ${r}: .create.lock leaked under ${cfg.storyDir}`,
      );
    }

    // Sanity: distinct names still produce distinct stories (lock does not
    // collapse unrelated creates).
    const a = await spawnCreate(root, `${cfg.label}-distinct-a`, join(root, '.logs-da.log'));
    const b = await spawnCreate(root, `${cfg.label}-distinct-b`, join(root, '.logs-db.log'));
    assert.equal(a.code, 0, `[${cfg.label}] distinct-a exit\n${a.output}`);
    assert.equal(b.code, 0, `[${cfg.label}] distinct-b exit\n${b.output}`);
    const idA = a.output.match(/Story (B-[a-f0-9]+) created/)?.[1];
    const idB = b.output.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(idA && idB, `[${cfg.label}] both distinct creates should return a story id`);
    assert.notEqual(idA, idB, `[${cfg.label}] distinct names must get distinct story ids`);

    console.log(`  ✓ ${cfg.label} (storyDir=${cfg.storyDir}): ${rounds} concurrent rounds, single story each`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run one synchronous `koala story_create` child with arbitrary args; returns
 * exit code + merged stdout/stderr. Used by the CHK-002 dedup scenario where
 * we need control over name / keywords / phase / forceNew per call.
 */
function createStorySync(
  root: string,
  overrides: Record<string, unknown>,
): { code: number; output: string } {
  const args = JSON.stringify({
    name: 'placeholder',
    title: 'Dedup probe',
    description: 'B-6812 CHK-002 dedup probe story.',
    type: 'chore',
    priority: 'medium',
    background: VALID_BACKGROUND,
    checklist: [{ title: 'probe item', context: 'probe context for dedup smoke' }],
    ...overrides,
  });
  const res = spawnSync(
    process.execPath,
    [cliPath, '--root', root, 'story_create', args],
    { cwd: root, encoding: 'utf8' },
  );
  return { code: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Extract the created/reused story id from story_create output. */
function storyIdOf(output: string): string | undefined {
  return (
    output.match(/Story (B-[a-f0-9]+) created/)?.[1] ??
    output.match(/Story already exists: (B-[a-f0-9]+)/)?.[1]
  );
}

/**
 * B-6812 CHK-002: dedup behavior — normalized-name idempotency + keyword
 * full-overlap block. No concurrency needed here; these are sequential
 * functional regressions on the dedup logic.
 */
async function runDedupScenario(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'koala-story-dedup-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    writeFile(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    writeFile(root, 'README.md', 'dedup smoke\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);

    // 1) normalized-name idempotency: "Fix Login" then "fix-login" must reuse.
    const a = createStorySync(root, { name: 'Fix Login' });
    assert.equal(a.code, 0, `normalized-name: first create exit\n${a.output}`);
    assert.match(a.output, /Story B-[a-f0-9]+ created/, 'first create should materialize');
    const idA = storyIdOf(a.output);
    assert.ok(idA, 'first create returns an id');

    const b = createStorySync(root, { name: 'fix-login' });
    assert.equal(b.code, 0, `normalized-name: second create exit\n${b.output}`);
    assert.match(b.output, /Story already exists/, 'normalized-name hit must reuse, not create');
    assert.equal(storyIdOf(b.output), idA, 'normalized-name hit returns the SAME story id');

    // raw exact-name "FIX__LOGIN " also normalizes to "fix-login" → reuse.
    const c = createStorySync(root, { name: '  FIX__LOGIN  ' });
    assert.equal(c.code, 0, `normalized-name: third spelling exit\n${c.output}`);
    assert.match(c.output, /Story already exists/, 'separator/case variant must reuse');
    assert.equal(storyIdOf(c.output), idA, 'separator/case variant returns the SAME story id');

    // 2) keyword full overlap on an ACTIVE non-terminal story → hard block.
    const k1 = createStorySync(root, { name: 'kw-base', keywords: ['auth', 'session'] });
    assert.equal(k1.code, 0, `keyword base create exit\n${k1.output}`);
    const idK1 = storyIdOf(k1.output);
    assert.ok(idK1, 'keyword base create returns an id');

    // Different name (so normalized-name does NOT match), same keyword set.
    const blocked = createStorySync(root, { name: 'kw-dup', keywords: ['auth', 'session'] });
    assert.notEqual(blocked.code, 0, 'keyword full overlap must FAIL the create');
    assert.match(blocked.output, /疑似重复 story/, 'block message names the duplicate');
    assert.match(blocked.output, /forceNew/, 'block message points at the forceNew override');

    // forceNew:true overrides the block → a new story is created.
    const forced = createStorySync(root, {
      name: 'kw-dup', keywords: ['auth', 'session'], forceNew: true,
    });
    assert.equal(forced.code, 0, `forceNew override exit\n${forced.output}`);
    assert.match(forced.output, /Story B-[a-f0-9]+ created/, 'forceNew:true creates despite overlap');
    assert.notEqual(storyIdOf(forced.output), idK1, 'forceNew create gets a distinct id');

    // 3) partial keyword overlap (ratio < 1) → NOT blocked.
    // new keywords {auth, payment}; existing kw-base {auth, session} → shared {auth}, ratio 1/2.
    const partial = createStorySync(root, { name: 'kw-partial', keywords: ['auth', 'payment'] });
    assert.equal(partial.code, 0, `partial overlap must not block\n${partial.output}`);
    assert.match(partial.output, /Story B-[a-f0-9]+ created/, 'partial overlap still creates');

    // single shared keyword (shared.length < 2) → not blocked even if ratio 1.
    const single = createStorySync(root, { name: 'kw-single', keywords: ['auth'] });
    assert.equal(single.code, 0, `single shared keyword must not block\n${single.output}`);
    assert.match(single.output, /Story B-[a-f0-9]+ created/, 'single-keyword overlap still creates');

    // 4) keyword full overlap against a TERMINAL story → NOT blocked.
    // Create terminal (DONE / DISCARDED) stories via the onboard phase path,
    // then a new active story with the identical keyword set: terminal stories
    // never block (the handler skips DONE and DISCARDED identically).
    const done = createStorySync(root, {
      name: 'kw-done-base', keywords: ['archived', 'legacy'], phase: 'DONE',
    });
    assert.equal(done.code, 0, `DONE-phase base create exit\n${done.output}`);
    const againstDone = createStorySync(root, {
      name: 'kw-against-done', keywords: ['archived', 'legacy'],
    });
    assert.equal(againstDone.code, 0,
      `full overlap with a DONE story must NOT block\n${againstDone.output}`);
    assert.match(againstDone.output, /Story B-[a-f0-9]+ created/,
      'DONE-story keyword overlap still creates');

    // story_create cannot mint a DISCARDED story directly, so create a normal
    // story with the keyword set then `story_discard` it into the terminal
    // DISCARDED phase.
    const discardedBase = createStorySync(root, {
      name: 'kw-discarded-base', keywords: ['retired', 'obsolete'],
    });
    assert.equal(discardedBase.code, 0, `DISCARDED base create exit\n${discardedBase.output}`);
    const idDiscarded = storyIdOf(discardedBase.output);
    assert.ok(idDiscarded, 'DISCARDED base create returns an id');
    const discardRes = spawnSync(
      process.execPath,
      [cliPath, '--root', root, 'story_discard',
        JSON.stringify({ storyId: idDiscarded, reason: 'dedup smoke terminal-phase fixture' })],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(discardRes.status, 0,
      `story_discard exit\n${discardRes.stdout ?? ''}${discardRes.stderr ?? ''}`);
    const againstDiscarded = createStorySync(root, {
      name: 'kw-against-discarded', keywords: ['retired', 'obsolete'],
    });
    assert.equal(againstDiscarded.code, 0,
      `full overlap with a DISCARDED story must NOT block\n${againstDiscarded.output}`);
    assert.match(againstDiscarded.output, /Story B-[a-f0-9]+ created/,
      'DISCARDED-story keyword overlap still creates');

    console.log('  ✓ dedup: normalized-name reuse, keyword block + forceNew override, partial/DONE/DISCARDED no-block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  // Round set A: default storyDir.
  await runScenario({ label: 'default-dir', storyDir: '.koala/story/actives' });
  // Round set B: NON-default storyDir — proves the lock path is resolved from
  // store.storyDirRel() and not hardcoded.
  await runScenario({ label: 'custom-dir', storyDir: 'custom/stories/here' });

  // B-6812 CHK-002: dedup regressions (normalized name + keyword block).
  await runDedupScenario();

  console.log('✓ story-create-concurrency smoke passed (default + non-default storyDir, real subprocess concurrency, CHK-002 dedup)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
