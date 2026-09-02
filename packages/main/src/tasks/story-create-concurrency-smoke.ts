#!/usr/bin/env node
/**
 * B-6812 CHK-001: concurrency smoke for story_create's directory lock.
 *
 * Verifies the G1 fix: concurrent `proof-or-stop story_create` calls with the SAME
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
 * Non-default storyDir coverage (decision preMortem "locking the wrong directory creates false safety"):
 *  - Round set A uses the default storyDir.
 *  - Round set B uses a NON-default storyDir (`custom/stories/here`). If the
 *    lock path were hardcoded to docs/story or .proof-or-stop/story, the lock dir and
 *    the actual write target would diverge and the race would reopen — this
 *    round would then produce duplicates and fail.
 *
 * B-6812 CHK-002 dedup coverage (separate `runDedupScenario`):
 *  - normalized-name hit: "Fix Login" then "fix-login" → second reuses the
 *    first story's id (G2: exact-name match used to miss this).
 *  - keyword full overlap on an ACTIVE non-terminal story → hard block;
 *    forceNew:true overrides the block and creates a fresh story.
 *  - partial keyword overlap (ratio < 1) → no block, new story created.
 *  - keyword full overlap against a DONE / DISCARDED story → no block, but a
 *    non-blocking same-domain FYI warn is emitted (B-6812 F-004); a partial
 *    overlap with a terminal story emits no warn (false-positive guard).
 *
 * B-6812 CHK-003 stderr-channel coverage (separate `runStderrChannelScenario`):
 *  - G3: keyword-overlap dupWarning + riskHint advisory text must land on
 *    STDERR; STDOUT must carry only the `Story B-xxxx created ...` conclusion
 *    (plus non-advisory guidance like the INIT reviewer hint). The classic
 *    failure mode is `proof-or-stop story_create | tail` swallowing the warning — we
 *    explicitly read STDOUT alone and assert the warning is NOT there, then
 *    read STDERR and assert it IS.
 *  - G4: a second story created within 30 minutes of the first triggers the
 *    "N other stories were also created within the last 30 minutes" note on STDERR.
 *  - false-positive guard: a fresh repo's very first story has no concurrent
 *    siblings → the concurrent-story note must NOT appear.
 *  - 30-minute window boundary: a story whose createdAt is just OUTSIDE the
 *    window is excluded; one just INSIDE is included.
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
  '## Trigger Event',
  '2026-05-16 B-6812 concurrency smoke needs a trigger section long enough to clear background validation thresholds.',
  '## Key Insights',
  'Concurrent story_create with the same name must serialize on a directory lock so idempotency holds under a real OS race.',
  '## Option Tradeoffs',
  'The smoke spawns genuine child processes instead of an in-process Promise.all so the only shared state is the filesystem.',
  '## Conversation Texture',
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

/** Spawn one real `proof-or-stop story_create` child; resolves with its exit info. */
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
  storyDir: string; // relative path stored in proof-or-stop.config.json
}

async function runScenario(cfg: RoundConfig): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-create-conc-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    writeFile(root, 'proof-or-stop.config.json', JSON.stringify({
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
 * Run one synchronous `proof-or-stop story_create` child with arbitrary args; returns
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-dedup-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    writeFile(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
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
    assert.match(blocked.output, /Suspected duplicate of story B-[a-f0-9]+ \(keyword fully overlaps:/, 'block message names the duplicate');
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

    // 4) keyword full overlap against a TERMINAL story → NOT blocked, but a
    // non-blocking same-domain FYI warn IS emitted (B-6812 F-004). plan.md
    // CHK-002 + AGENTS.md promise the warn; silently `continue`-ing produced
    // no output (doc drift) before the F-004 fix.
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
    assert.match(
      againstDone.output, /keyword fully overlaps with completed story \(advisory only, does not block creation\)/,
      'F-004: full overlap with a DONE story emits a non-blocking warn',
    );

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
    assert.match(
      againstDiscarded.output, /keyword fully overlaps with completed story \(advisory only, does not block creation\)/,
      'F-004: full overlap with a DISCARDED story emits a non-blocking warn',
    );

    // F-004 false-positive guard: a PARTIAL keyword overlap (ratio < 1) with a
    // terminal story must NOT trigger the terminal-overlap warn.
    const partialTerminal = createStorySync(root, {
      name: 'kw-partial-terminal', keywords: ['archived', 'fresh-topic'],
    });
    assert.equal(partialTerminal.code, 0,
      `partial overlap with a terminal story exit\n${partialTerminal.output}`);
    assert.doesNotMatch(
      partialTerminal.output, /keyword fully overlaps with completed story/,
      'F-004: partial overlap with a terminal story does NOT emit the warn',
    );

    console.log('  ✓ dedup: normalized-name reuse, keyword block + forceNew override, partial/DONE/DISCARDED no-block, F-004 terminal-overlap warn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run one synchronous `proof-or-stop story_create` child returning STDOUT and STDERR
 * SEPARATELY (unlike `createStorySync` which merges them). The CHK-003 stderr
 * scenario must assert which stream a line landed on, so the streams cannot be
 * merged.
 */
function createStorySplit(
  root: string,
  overrides: Record<string, unknown>,
): { code: number; stdout: string; stderr: string } {
  const args = JSON.stringify({
    name: 'placeholder',
    title: 'Stderr-channel probe',
    description: 'B-6812 CHK-003 stderr-channel probe story.',
    type: 'chore',
    priority: 'medium',
    background: VALID_BACKGROUND,
    checklist: [{ title: 'probe item', context: 'probe context for stderr-channel smoke' }],
    ...overrides,
  });
  const res = spawnSync(
    process.execPath,
    [cliPath, '--root', root, 'story_create', args],
    { cwd: root, encoding: 'utf8' },
  );
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Backdate a story's index.json createdAt by `minutesAgo` minutes. */
function backdateStory(storyDirAbs: string, storyId: string, minutesAgo: number): void {
  const idxPath = join(storyDirAbs, storyId, 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.createdAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  writeFileSync(idxPath, JSON.stringify(idx, null, 2));
}

/**
 * B-6812 CHK-003: advisory text (duplicate + concurrency warnings) must travel
 * on STDERR, leaving STDOUT to carry only the create conclusion so a
 * `proof-or-stop story_create | tail` pipe never silently eats the warning.
 */
async function runStderrChannelScenario(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-stderr-'));
  const storyDir = '.proof-or-stop/story/actives';
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    writeFile(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir,
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    writeFile(root, 'README.md', 'stderr-channel smoke\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);

    const storyDirAbs = join(root, storyDir);

    // 1) FALSE-POSITIVE GUARD: the very first story in a fresh repo has no
    // concurrent siblings → the concurrent-story note must NOT appear.
    const first = createStorySplit(root, { name: 'stderr-first', keywords: ['alpha', 'beta'] });
    assert.equal(first.code, 0, `first create exit\n${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /Story B-[a-f0-9]+ created/, 'first create conclusion on stdout');
    assert.doesNotMatch(
      first.stdout + first.stderr, /were also created within the last 30 minutes/,
      'no concurrent siblings → concurrent-story note must NOT be emitted (false-positive guard)',
    );
    const idFirst = storyIdOf(first.stdout);
    assert.ok(idFirst, 'first create returns an id');

    // 2) G3 — keyword-overlap dupWarning lands on STDERR, NOT on STDOUT.
    // Different name (normalized-name will not match) but only a PARTIAL
    // keyword overlap so it warns instead of hard-blocking.
    const second = createStorySplit(root, {
      name: 'stderr-second', keywords: ['alpha', 'gamma'],
    });
    assert.equal(second.code, 0, `second create exit\n${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /Story B-[a-f0-9]+ created/, 'create conclusion stays on stdout');
    // The keyword-overlap warning must be on stderr ...
    assert.match(
      second.stderr, /Possibly duplicate story \(keyword overlap\)/,
      'keyword-overlap dupWarning must be written to STDERR',
    );
    // ... and must NOT be on stdout (the `| tail` pipe reads stdout only).
    assert.doesNotMatch(
      second.stdout, /Possibly duplicate story \(keyword overlap\)/,
      'keyword-overlap dupWarning must NOT leak into STDOUT',
    );

    // 3) G4 — within 30 minutes of `stderr-first`, the concurrent-story note
    // appears on STDERR. `second` already created a sibling; assert it named
    // the earlier active stories.
    assert.match(
      second.stderr, /\d+ other stories were also created within the last 30 minutes/,
      'recently-created concurrent stories must be surfaced on STDERR',
    );
    assert.match(
      second.stderr, new RegExp(idFirst!),
      'concurrent-story note lists the earlier active story id',
    );
    assert.doesNotMatch(
      second.stdout, /were also created within the last 30 minutes/,
      'concurrent-story note must NOT leak into STDOUT',
    );

    // 4) `| tail` pipe simulation: a consumer reading STDOUT ONLY still gets a
    // clean create conclusion and never sees the warnings — but the warnings
    // were not lost, they are on STDERR. We already captured both streams
    // separately above; assert the stdout-only view is warning-free.
    const stdoutOnlyView = second.stdout;
    assert.doesNotMatch(stdoutOnlyView, /Possibly duplicate story/, '`| tail` (stdout-only) view is warning-free');
    assert.doesNotMatch(stdoutOnlyView, /in the last 30 minutes/, '`| tail` (stdout-only) view has no concurrency note');
    assert.match(stdoutOnlyView, /Story B-[a-f0-9]+ created/, '`| tail` still sees the create conclusion');

    // 5) G3 — riskHint advisory text lands on STDERR, NOT on STDOUT.
    // A high-risk keyword in the description triggers riskSignals → riskHint.
    const risky = createStorySplit(root, {
      name: 'stderr-risky',
      description: 'B-6812 CHK-003 probe touching auth and token handling.',
    });
    assert.equal(risky.code, 0, `risky create exit\n${risky.stdout}\n${risky.stderr}`);
    assert.match(risky.stderr, /High-risk signals detected/, 'riskHint must be written to STDERR');
    assert.doesNotMatch(risky.stdout, /High-risk signals detected/, 'riskHint must NOT leak into STDOUT');
    assert.match(risky.stdout, /Story B-[a-f0-9]+ created/, 'risky create conclusion stays on stdout');

    // 6) 30-MINUTE WINDOW BOUNDARY.
    // Backdate every existing active story to 31 minutes ago — just OUTSIDE
    // the window — so a new create finds NO recent concurrent siblings.
    for (const id of countStoryDirs(storyDirAbs)) {
      backdateStory(storyDirAbs, id, 31);
    }
    const outside = createStorySplit(root, { name: 'stderr-outside-window' });
    assert.equal(outside.code, 0, `outside-window create exit\n${outside.stdout}\n${outside.stderr}`);
    assert.doesNotMatch(
      outside.stdout + outside.stderr, /were also created within the last 30 minutes/,
      'stories older than 30 min are OUTSIDE the window → no concurrent-story note',
    );
    const idOutside = storyIdOf(outside.stdout);
    assert.ok(idOutside, 'outside-window create returns an id');

    // Backdate that just-created story to 29 minutes ago — just INSIDE the
    // window — then a fresh create must surface it.
    backdateStory(storyDirAbs, idOutside!, 29);
    const inside = createStorySplit(root, { name: 'stderr-inside-window' });
    assert.equal(inside.code, 0, `inside-window create exit\n${inside.stdout}\n${inside.stderr}`);
    assert.match(
      inside.stderr, /\d+ other stories were also created within the last 30 minutes/,
      'a story 29 min old is INSIDE the window → concurrent-story note must appear',
    );
    assert.match(
      inside.stderr, new RegExp(idOutside!),
      'inside-window note lists the 29-min-old story id',
    );

    // 7) TERMINAL-PHASE EXCLUSION: a DONE story created within 30 minutes must
    // NOT be counted in the concurrent-story note. Push every existing story
    // outside the window first so only the DONE fixture is recent, then create
    // a fresh story and assert the note does not appear.
    for (const id of countStoryDirs(storyDirAbs)) {
      backdateStory(storyDirAbs, id, 45);
    }
    const doneRecent = createStorySplit(root, { name: 'stderr-done-recent', phase: 'DONE' });
    assert.equal(doneRecent.code, 0, `DONE-recent create exit\n${doneRecent.stdout}\n${doneRecent.stderr}`);
    const idDoneRecent = storyIdOf(doneRecent.stdout);
    assert.ok(idDoneRecent, 'DONE-recent create returns an id');
    const afterDone = createStorySplit(root, { name: 'stderr-after-done' });
    assert.equal(afterDone.code, 0, `after-done create exit\n${afterDone.stdout}\n${afterDone.stderr}`);
    assert.doesNotMatch(
      afterDone.stdout + afterDone.stderr, /\d+ other stories were also created within the last 30 minutes/,
      'a DONE story within 30 min must NOT count as a concurrent sibling',
    );

    // 8) MALFORMED createdAt TOLERANCE: a story whose index.json createdAt is
    // missing / non-ISO must be skipped silently — it must not crash the scan
    // and must not appear in the note. Corrupt the DONE fixture's createdAt
    // into garbage, push others out of window, then create a fresh story.
    const corruptIdxPath = join(storyDirAbs, idDoneRecent!, 'index.json');
    const corruptIdx = JSON.parse(readFileSync(corruptIdxPath, 'utf8'));
    corruptIdx.createdAt = 'not-a-valid-iso-date';
    corruptIdx.phase = 'PLAN'; // active phase so only createdAt would exclude it
    writeFileSync(corruptIdxPath, JSON.stringify(corruptIdx, null, 2));
    for (const id of countStoryDirs(storyDirAbs)) {
      if (id === idDoneRecent) continue;
      backdateStory(storyDirAbs, id, 50);
    }
    const afterCorrupt = createStorySplit(root, { name: 'stderr-after-corrupt' });
    assert.equal(
      afterCorrupt.code, 0,
      `malformed createdAt must not crash story_create\n${afterCorrupt.stdout}\n${afterCorrupt.stderr}`,
    );
    assert.match(afterCorrupt.stdout, /Story B-[a-f0-9]+ created/, 'create still succeeds despite corrupt sibling');
    assert.doesNotMatch(
      afterCorrupt.stdout + afterCorrupt.stderr, /\d+ other stories were also created within the last 30 minutes/,
      'a story with a malformed createdAt is skipped, never listed',
    );

    console.log('  ✓ stderr-channel: dupWarning/riskHint on stderr, stdout warning-free, 30-min window boundary, terminal-phase exclusion, malformed-createdAt tolerance, false-positive guard');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  // Round set A: default storyDir.
  await runScenario({ label: 'default-dir', storyDir: '.proof-or-stop/story/actives' });
  // Round set B: NON-default storyDir — proves the lock path is resolved from
  // store.storyDirRel() and not hardcoded.
  await runScenario({ label: 'custom-dir', storyDir: 'custom/stories/here' });

  // B-6812 CHK-002: dedup regressions (normalized name + keyword block).
  await runDedupScenario();

  // B-6812 CHK-003: stderr channel for duplicate / concurrency warnings.
  await runStderrChannelScenario();

  console.log('✓ story-create-concurrency smoke passed (default + non-default storyDir, real subprocess concurrency, CHK-002 dedup, CHK-003 stderr channel)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
