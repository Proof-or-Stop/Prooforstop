#!/usr/bin/env node
//
// verification_evidence_add / batch_add authority handler integration smoke.
//
// SCOPE NOTE (B-94a6): CHK-001 does NOT wire authority POST into checklist.ts. The
// authority interaction (local-validation-first / shadow / enforce, Blockers 1-4) is
// added by CHK-002/003/004, which will extend this file to drive the handlers under
// each authority mode with an injected client and assert POST counts + local writes.
//
// For CHK-001 this smoke pins the OFF-mode baseline these later cases regress
// against: with no authority env configured, verification_evidence_add and
// verification_evidence_batch_add write local evidence exactly as post-B-2157 main,
// performing zero authority interaction. It also asserts the existing local-validation
// guards (note >= 5, waiverType requires kind=waiver, unknown itemId rejected) still
// fire — these are the preflight checks CHK-002 must run BEFORE any authority POST.
//
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { loadAuthoritySettings } from '../core/authority-mode.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const STORY_ID = 'B-authh';
const now = '2026-05-21T00:00:00.000Z';

function createStoryRepo(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'koala-authh-'));
  mkdirSync(dirname(join(root, 'koala.config.json')), { recursive: true });
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }));
  writeFileSync(join(root, 'README.md'), 'authority handler smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'authority-handler-smoke',
    title: 'Authority handler smoke',
    description: 'Synthetic story exercising verification evidence handlers in off mode.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Item one',
        context: 'Synthetic item.',
        status: 'in_progress' as const,
        startTime: now,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'happy path returns success', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'empty input clear error', type: 'cli', priority: 'must' }],
          adversarial: [{ desc: 'illegal state writes nothing', type: 'logic', priority: 'must' }],
        },
      },
      {
        id: 'CHK-002',
        title: 'Item two',
        context: 'Synthetic item.',
        status: 'in_progress' as const,
        startTime: now,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'second happy path', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'second edge', type: 'cli', priority: 'must' }],
          adversarial: [{ desc: 'second adversarial', type: 'logic', priority: 'must' }],
        },
      },
    ],
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
  return { root, store };
}

// --- off mode is the default with no authority env ----------------------------
{
  const settings = loadAuthoritySettings({});
  assert.equal(settings.mode, 'off', 'default authority mode must be off');
}

// --- off mode: verification_evidence_add writes local evidence, zero network ---
{
  const { root, store } = createStoryRepo();
  try {
    const handlers = createChecklistHandlers({ root, store } as any);
    const msg = handlers.verification_evidence_add({
      storyId: STORY_ID,
      itemId: 'CHK-001',
      intentRef: 'CHK-001:happy:0',
      kind: 'integration_test',
      file: 'validate.ts',
      command: 'koala validate --story=B-authh',
      result: 'pass',
      note: 'integration test covers the happy path',
    });
    assert.match(msg, /Verification evidence recorded for CHK-001/);
    const cl = store.readChecklist(STORY_ID);
    const item = cl.items.find(i => i.id === 'CHK-001');
    assert.ok(item?.verificationEvidence?.some(e => e.intentRef === 'CHK-001:happy:0'),
      'local evidence must be written in off mode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- off mode: batch_add all-or-nothing local write ---------------------------
{
  const { root, store } = createStoryRepo();
  try {
    const handlers = createChecklistHandlers({ root, store } as any);
    const msg = handlers.verification_evidence_batch_add({
      storyId: STORY_ID,
      evidences: [
        { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'covers first happy' },
        { itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', kind: 'integration_test', note: 'covers second happy' },
      ],
    });
    assert.match(msg, /batch recorded for B-authh: 2/);
    const cl = store.readChecklist(STORY_ID);
    assert.ok(cl.items.find(i => i.id === 'CHK-001')?.verificationEvidence?.length);
    assert.ok(cl.items.find(i => i.id === 'CHK-002')?.verificationEvidence?.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- local preflight guards still fire (the checks CHK-002 must run pre-POST) --
{
  const { root, store } = createStoryRepo();
  try {
    const handlers = createChecklistHandlers({ root, store } as any);

    // note < 5 chars rejected
    assert.throws(
      () => handlers.verification_evidence_add({
        storyId: STORY_ID, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0',
        kind: 'integration_test', note: 'x',
      }),
      /note 必须 ≥ 5 字符/,
    );

    // waiverType with non-waiver kind rejected
    assert.throws(
      () => handlers.verification_evidence_add({
        storyId: STORY_ID, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0',
        kind: 'integration_test', waiverType: 'wont_fix' as any, note: 'should be rejected',
      }),
      /waiverType 只能用于 kind=waiver/,
    );

    // unknown itemId rejected (CHK-002 must reject this BEFORE any POST)
    assert.throws(
      () => handlers.verification_evidence_add({
        storyId: STORY_ID, itemId: 'CHK-999', intentRef: 'CHK-999:happy:0',
        kind: 'integration_test', note: 'unknown item should be rejected',
      }),
      /Checklist item CHK-999 not found/,
    );

    // batch: any invalid entry rejects whole batch (all-or-nothing) and writes nothing
    assert.throws(
      () => handlers.verification_evidence_batch_add({
        storyId: STORY_ID,
        evidences: [
          { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'valid first entry' },
          { itemId: 'CHK-999', intentRef: 'CHK-999:happy:0', kind: 'integration_test', note: 'invalid second entry' },
        ],
      }),
      /Checklist item CHK-999 not found/,
    );

    console.log('✓ local preflight guards (note/waiver/unknown-item/batch) still fire in off mode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('verification evidence authority handler smoke passed (CHK-001 off-mode baseline)');
