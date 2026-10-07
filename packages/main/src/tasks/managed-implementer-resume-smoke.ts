#!/usr/bin/env node

// Regression: every DEV checklist item launched a cold, ephemeral implementer
// session, so each worker re-explored the same repository its predecessor had
// just read (about 40 commands and 2M input tokens per item on a 5-item Story).
// A Story's next implementer must resume the previous completed implementer
// session of the same Story, worktree and model, and the implementer session
// must be kept on disk so it can be resumed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as hostRun from '../core/host-run.js';
import * as managedHostRun from '../core/managed-host-run.js';

const MARKER = 'implementer launch does not resume the previous implementer session';

type Launch = { command: string; argv: string[] };
const materialize = hostRun.materializeHostRunLaunch as unknown as (
  args: Record<string, unknown>,
  env?: { platform: NodeJS.Platform; containerBoundaryPresent: boolean },
) => Launch;

function implementerArgs(cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'codex', model: 'deepseek-v4-flash', reasoningEffort: 'low',
    storyId: 'B-1234', agentType: 'proof-or-stop-implementer', phase: 'DEV',
    promptText: 'implement CHK-002', launchProfile: 'managed_dispatch',
    env: {}, cwd, root: cwd, recordedAt: new Date().toISOString(), projectRootHash: 'sha256:x',
    ...extra,
  };
}

function writeRun(root: string, runId: string, fields: {
  storyId?: string; agentType?: string; cwd: string; model?: string; state: string; terminalAt: string; threadId: string | null;
}): void {
  const dir = managedHostRun.managedHostRunDirectory(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    runId, host: 'codex', profile: 'managed_dispatch', storyId: fields.storyId ?? 'B-1234',
    agentType: fields.agentType ?? 'proof-or-stop-implementer', cwd: fields.cwd, model: fields.model ?? 'deepseek-v4-flash',
    managedDispatchTarget: { itemId: 'CHK-001' },
  }));
  writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ runId, state: fields.state, terminalAt: fields.terminalAt }));
  const frames = [
    ...(fields.threadId ? [{ sequence: 1, stream: 'stdout', text: `{"type":"thread.started","thread_id":"${fields.threadId}"}\n` }] : []),
    { sequence: 2, stream: 'stdout', text: '{"type":"turn.completed"}\n' },
  ];
  writeFileSync(join(dir, 'live-output.jsonl'), frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'managed-implementer-resume-'));
  try {
    const worktree = join(root, '.worktrees', 'B-1234');
    const codexHome = join(root, 'codex-home');
    const kept = '019a0000-0000-7000-8000-00000000aaaa';
    mkdirSync(join(codexHome, 'sessions', '2026', '09', '29'), { recursive: true });
    writeFileSync(join(codexHome, 'sessions', '2026', '09', '29', `rollout-2026-09-29T10-00-00-${kept}.jsonl`), '{}\n');

    // Launch shape: a fresh implementer keeps its session; a resumed one continues it.
    const container = { platform: 'linux' as NodeJS.Platform, containerBoundaryPresent: true };
    const fresh = materialize(implementerArgs(worktree), container);
    assert.ok(!fresh.argv.includes('--ephemeral'), `${MARKER}: a fresh implementer session is ephemeral (${fresh.argv.join(' ')})`);
    assert.equal(fresh.argv[1], '--json');
    const resumed = materialize(implementerArgs(worktree, { resumeSessionId: kept }), container);
    assert.deepEqual(resumed.argv.slice(0, 2), ['exec', 'resume'], `${MARKER}: ${resumed.argv.join(' ')}`);
    assert.equal(resumed.argv.at(-2), kept, 'the session id precedes the stdin prompt marker');
    assert.equal(resumed.argv.at(-1), '-');
    assert.ok(resumed.argv.includes('sandbox_mode="danger-full-access"'), 'resume carries the sandbox as config');
    assert.ok(!resumed.argv.includes('-C') && !resumed.argv.includes('-s'), 'exec resume takes neither -C nor -s');
    const repair = materialize({ ...implementerArgs(worktree, { resumeSessionId: kept }), agentType: 'proof-or-stop-finding-repair' }, container);
    assert.deepEqual(repair.argv.slice(0, 2), ['exec', 'resume'], 'a finding repair resumes the Story code-writer session too');
    const reviewer = materialize({ ...implementerArgs(worktree), agentType: 'proof-or-stop-review-story-init' }, container);
    assert.ok(reviewer.argv.includes('--ephemeral'), 'other managed dispatch roles stay ephemeral');
    // Old-PoS run 20: a managed save reviewer keeps its session so an unbound
    // save is repaired by resuming it (managed-scope-save-binding-smoke).
    const scope = materialize({ ...implementerArgs(worktree), agentType: 'proof-or-stop-review-scope-plan' }, container);
    assert.ok(!scope.argv.includes('--ephemeral'), `the managed scope reviewer keeps its session (${scope.argv.join(' ')})`);
    const scopeResumed = materialize({ ...implementerArgs(worktree, { resumeSessionId: kept }), agentType: 'proof-or-stop-review-scope-plan' }, container);
    assert.deepEqual(scopeResumed.argv.slice(0, 2), ['exec', 'resume'], 'the scope reviewer save repair resumes its session');

    // Lookup: newest completed implementer run of the same Story/worktree/model whose session exists.
    const find = (managedHostRun as Record<string, unknown>).findResumableImplementerSession as
      | ((args: { root: string; storyId: string; cwd: string; model: string | null; excludeRunId: string; codexHome: string }) => string | null)
      | undefined;
    assert.equal(typeof find, 'function', `${MARKER}: no resumable-session lookup`);
    writeRun(root, 'run-old', { cwd: worktree, state: 'completed', terminalAt: '2026-09-29T09:00:00.000Z', threadId: '019a0000-0000-7000-8000-00000000bbbb' });
    writeRun(root, 'run-kept', { cwd: worktree, state: 'completed', terminalAt: '2026-09-29T10:00:00.000Z', threadId: kept });
    writeRun(root, 'run-failed', { cwd: worktree, state: 'failed', terminalAt: '2026-09-29T11:00:00.000Z', threadId: '019a0000-0000-7000-8000-00000000cccc' });
    writeRun(root, 'run-other-story', { cwd: worktree, storyId: 'B-9999', state: 'completed', terminalAt: '2026-09-29T12:00:00.000Z', threadId: '019a0000-0000-7000-8000-00000000dddd' });
    writeRun(root, 'run-reviewer', { cwd: worktree, agentType: 'proof-or-stop-review-scope-plan', state: 'completed', terminalAt: '2026-09-29T12:00:00.000Z', threadId: '019a0000-0000-7000-8000-00000000eeee' });
    const lookup = { root, storyId: 'B-1234', cwd: worktree, model: 'deepseek-v4-flash', excludeRunId: 'run-current', codexHome };
    assert.equal(find!(lookup), kept, 'newest completed same-Story implementer session is chosen');
    const repairThread = '019a0000-0000-7000-8000-00000000ffff';
    writeFileSync(join(codexHome, 'sessions', '2026', '09', '29', `rollout-2026-09-29T13-00-00-${repairThread}.jsonl`), '{}\n');
    writeRun(root, 'run-repair', { cwd: worktree, agentType: 'proof-or-stop-finding-repair', state: 'completed', terminalAt: '2026-09-29T13:00:00.000Z', threadId: repairThread });
    assert.equal(find!(lookup), repairThread, 'a newer finding-repair session is the one to continue');
    rmSync(managedHostRun.managedHostRunDirectory(root, 'run-repair'), { recursive: true, force: true });
    assert.equal(find!({ ...lookup, model: 'other-model' }), null, 'a different model never resumes');
    assert.equal(find!({ ...lookup, excludeRunId: 'run-kept' }), null, 'a session missing from the codex home is not resumed');
    console.log('managed-implementer-resume-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
