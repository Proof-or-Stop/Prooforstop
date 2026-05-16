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
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

(async () => {
  // Round set A: default storyDir.
  await runScenario({ label: 'default-dir', storyDir: '.koala/story/actives' });
  // Round set B: NON-default storyDir — proves the lock path is resolved from
  // store.storyDirRel() and not hardcoded.
  await runScenario({ label: 'custom-dir', storyDir: 'custom/stories/here' });

  console.log('✓ story-create-concurrency smoke passed (default + non-default storyDir, real subprocess concurrency)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
