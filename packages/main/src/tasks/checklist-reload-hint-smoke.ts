#!/usr/bin/env node

/**
 * B-95d8 CHK-002 smoke: checklist_update post-write reload reminder.
 *
 * Covers:
 *  1. After a successful write, the output carries a reload reminder reflecting the
 *     FINAL persisted state (read-after-write), naming the persisted status.
 *  2. The write semantics are unchanged: only the intended field changes on disk;
 *     all other checklist item fields are byte-identical before/after.
 *  3. stdout/pipeline compatibility: the reminder goes to STDERR only — stdout stays
 *     the pure conclusion so `checklist_update | tail` consumers are unaffected.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Run a command capturing stdout and stderr SEPARATELY. */
function runSplit(root: string, command: string, args: Record<string, unknown>): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
    cwd: root,
    encoding: 'utf8',
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

function run(root: string, command: string, args: Record<string, unknown>): string {
  const r = runSplit(root, command, args);
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const background = [
  '## Trigger Event',
  '2026-05-21 B-0000 smoke needs trigger detail to satisfy background validation for the reload-hint path.',
  '## Key Insights',
  'Long sessions trust a stale pre-write checklist snapshot; a stderr reload reminder reduces that drift without polluting stdout.',
  '## Trade-offs',
  'The reminder reuses the B-6812 advisory-to-stderr precedent so stdout stays the pure conclusion.',
  '## Conversation Texture',
  'A maintainer sees the conclusion on stdout and a separate reload reminder on stderr after each checklist_update.',
].join('\n\n');

// Pin PROOF_OR_STOP_SESSION_ID so all child processes — including the bash -c pipeline
// in Test 3 — share one stable session and don't trip the owner-lease gate via
// a different ppid-derived id.
const origSessionId = process.env.PROOF_OR_STOP_SESSION_ID;
process.env.PROOF_OR_STOP_SESSION_ID = 'smoke-reload-hint';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-reload-hint-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const created = run(root, 'story_create', {
    name: 'reload-hint',
    title: 'Reload hint story',
    description: 'Verify checklist_update post-write reload reminder.',
    type: 'chore',
    priority: 'medium',
    background,
    checklist: [{ title: 'First item', context: 'ctx-one', userSees: 'user sees one' }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'story_create should return story id');

  const checklistPath = join(root, '.proof-or-stop/story/actives', storyId!, 'checklist.json');
  const before = JSON.parse(readFileSync(checklistPath, 'utf8'));
  const itemBefore = before.items.find((i: any) => i.id === 'CHK-001');
  assert.ok(itemBefore, 'CHK-001 must exist after story_create');
  assert.equal(itemBefore.status, 'pending', 'CHK-001 starts pending');

  // ── Test 1 + 3: status write → conclusion on stdout, reminder on stderr ──────
  const upd = runSplit(root, 'checklist_update', { storyId, itemId: 'CHK-001', status: 'in_progress' });
  assert.equal(upd.status, 0, 'checklist_update should succeed');

  // stdout carries the conclusion only
  assert.match(upd.stdout, /Checklist CHK-001:.*status → in_progress/, 'stdout must carry the status conclusion');
  // reminder must NOT appear on stdout (pipeline-safe)
  assert.ok(!/↻/.test(upd.stdout), 'reload reminder (↻) must NOT pollute stdout');
  assert.ok(!/reload/.test(upd.stdout), 'reload reminder text must NOT appear on stdout');

  // stderr carries the reload reminder reflecting the FINAL persisted state
  assert.match(upd.stderr, /↻/, 'stderr must carry the reload reminder marker');
  assert.match(upd.stderr, /CHK-001 current status=in_progress/, 'reminder must name the final persisted status');
  assert.match(upd.stderr, /reload/, 'reminder must advise reloading');

  // ── Test 2: write semantics unchanged — only the intended field changed ──────
  const after = JSON.parse(readFileSync(checklistPath, 'utf8'));
  const itemAfter = after.items.find((i: any) => i.id === 'CHK-001');
  assert.equal(itemAfter.status, 'in_progress', 'persisted status must be in_progress');
  assert.equal(itemAfter.title, itemBefore.title, 'title must be unchanged');
  assert.equal(itemAfter.context, itemBefore.context, 'context must be unchanged');
  assert.equal(itemAfter.userSees, itemBefore.userSees, 'userSees must be unchanged');
  // every field except status (and startTime, which is set on first in_progress) is identical
  const stripVolatile = (it: any) => { const { status, startTime, endTime, ...rest } = it; return rest; };
  assert.deepEqual(stripVolatile(itemAfter), stripVolatile(itemBefore), 'no unintended field changes');

  // ── Test 3 (pipeline): piping stdout through `tail` yields only the conclusion ─
  const piped = execFileSync(
    'bash',
    ['-c', `node ${JSON.stringify(cliPath)} --root ${JSON.stringify(root)} checklist_update '{"storyId":"${storyId}","itemId":"CHK-001","status":"done"}' 2>/dev/null | tail -n 100`],
    { cwd: root, encoding: 'utf8' },
  );
  assert.match(piped, /status → done/, 'piped stdout must still carry the conclusion');
  assert.ok(!/↻/.test(piped), 'piped stdout must NOT contain the reminder');

  // final persisted state is done
  const final = JSON.parse(readFileSync(checklistPath, 'utf8'));
  assert.equal(final.items.find((i: any) => i.id === 'CHK-001').status, 'done', 'final persisted status is done');
} finally {
  rmSync(root, { recursive: true, force: true });
  if (origSessionId === undefined) {
    delete process.env.PROOF_OR_STOP_SESSION_ID;
  } else {
    process.env.PROOF_OR_STOP_SESSION_ID = origSessionId;
  }
}

console.log('✓ checklist reload hint smoke passed');
