#!/usr/bin/env node
/**
 * B-a370 CHK-002: META container next/session_brief hint smoke.
 *
 * Verifies F-003 fix: `koala next` / `session_brief` must not hand META
 * containers (B-META-* / phase=META) an actionable lifecycle hint like
 * `story_advance --storyId=<meta> --phase=INIT_CHECK`; they must get
 * audit/finding-flow guidance and stay out of the lifecycle/worktree
 * suggestion ordering.
 *
 * Note: the guidance text itself contains the word `story_advance` ("不要
 * story_advance ...") — so the assertion targets the actionable hint
 * `story_advance --storyId=<id>` / `--phase=INIT_CHECK`, never the bare word.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { ensureMetaStory, META_STORY_ID } from '../core/audit-meta-store.js';
import type { StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const INIT_CHECK_HINT = '--phase=INIT_CHECK';

/** The actionable bad hint for a story: `story_advance --storyId=<id>`. The
 *  guidance prose may mention the bare word `story_advance`; only an actual
 *  per-story advance suggestion is the regression. */
function advanceHintFor(storyId: string): string {
  return `story_advance --storyId=${storyId}`;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runKoala(root: string, command: string): string {
  return execFileSync(process.execPath, [cliPath, command, '{}'], {
    cwd: root,
    env: { ...process.env, KOALA_PROJECT_ROOT: root },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Minimal koala project: git repo + config. resetConfigCache so the run
 *  picks up this temp root's storyDir instead of a cached prior project. */
function setupProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'README.md', 'meta-story next-hint smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();
  return root;
}

function writeStory(store: StoryStore, storyId: string, phase: string): void {
  const now = '2026-05-16T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: storyId,
    title: `Synthetic ${storyId}`,
    description: 'Synthetic story for meta-story next-hint smoke.',
    type: 'chore',
    phase: phase as StoryInfo['phase'],
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
  store.writeStory(storyId, story);
}

/** Scenario 1: a META container is the only story. next/session_brief must
 *  give audit/finding guidance, never an actionable story_advance / INIT_CHECK
 *  hint for the META container. */
function assertMetaContainerAloneGetsAuditHint(): void {
  const root = setupProject('koala-meta-hint-alone-');
  try {
    const store = new StoryStore(root);
    ensureMetaStory(store);

    const brief = runKoala(root, 'session_brief');
    assert.ok(
      !brief.includes(advanceHintFor(META_STORY_ID)),
      `session_brief must not suggest story_advance for the META container:\n${brief}`,
    );
    assert.ok(!brief.includes(INIT_CHECK_HINT), `META-only repo must not surface any INIT_CHECK hint:\n${brief}`);
    assert.ok(!brief.includes('## Active stories'), `META container must not appear as an active story:\n${brief}`);
    assert.ok(brief.includes('## META containers'), `session_brief must render a META containers section:\n${brief}`);
    assert.ok(brief.includes(META_STORY_ID), `META containers section must name ${META_STORY_ID}`);
    assert.ok(brief.includes('audit'), `META guidance must point at the audit/finding flow:\n${brief}`);

    const next = runKoala(root, 'next');
    assert.ok(
      !next.includes(advanceHintFor(META_STORY_ID)),
      `next must not suggest story_advance for the META container:\n${next}`,
    );
    assert.ok(!next.includes(INIT_CHECK_HINT), `next must not surface an INIT_CHECK hint for a META container:\n${next}`);
    assert.ok(next.includes('audit') || next.includes('finding'), `next must give audit/finding guidance:\n${next}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Scenario 2: META container coexists with a normal active story. The
 *  normal story still gets its lifecycle hint (no regression); the META
 *  container stays out of the Active stories ordering. (preMortem #2) */
function assertMetaCoexistsWithNormalStory(): void {
  const root = setupProject('koala-meta-hint-coexist-');
  try {
    const store = new StoryStore(root);
    ensureMetaStory(store);
    writeStory(store, 'B-normal1', 'INIT');

    const brief = runKoala(root, 'session_brief');
    assert.ok(brief.includes('## Active stories (1)'), `only the normal story should be active, META excluded:\n${brief}`);
    assert.ok(brief.includes('B-normal1'), `normal story must appear in Active stories:\n${brief}`);
    assert.ok(brief.includes('## META containers'), `META containers section must still render:\n${brief}`);
    // Normal story hint must NOT regress: it still gets its INIT_CHECK suggestion.
    assert.ok(
      brief.includes(`${advanceHintFor('B-normal1')} ${INIT_CHECK_HINT}`),
      `normal story lifecycle hint must not regress:\n${brief}`,
    );
    // The META container must never be the target of a story_advance hint.
    assert.ok(
      !brief.includes(advanceHintFor(META_STORY_ID)),
      `META container must never get a story_advance hint:\n${brief}`,
    );

    const next = runKoala(root, 'next');
    assert.ok(next.includes('B-normal1'), `next must focus on the normal active story:\n${next}`);
    assert.ok(!next.includes(META_STORY_ID), `next must not point at the META container while real work exists:\n${next}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Scenario 3: the two META identification criteria are each independently
 *  sufficient — B-META- id prefix without phase=META, and phase=META without
 *  the B-META- prefix. (preMortem #1) */
function assertBothMetaCriteriaDetectedIndependently(): void {
  // 3a: B-META- prefix, but phase is a normal lifecycle phase.
  const rootA = setupProject('koala-meta-hint-prefix-');
  try {
    const store = new StoryStore(rootA);
    writeStory(store, 'B-META-prefix-only', 'INIT');
    const brief = runKoala(rootA, 'session_brief');
    assert.ok(!brief.includes('## Active stories'), `B-META- prefix story must be excluded from Active stories:\n${brief}`);
    assert.ok(brief.includes('## META containers'), `B-META- prefix story must render in META containers:\n${brief}`);
    assert.ok(!brief.includes(INIT_CHECK_HINT), `B-META- prefix story must not surface an INIT_CHECK hint:\n${brief}`);
    assert.ok(
      !brief.includes(advanceHintFor('B-META-prefix-only')),
      `B-META- prefix story must not get a story_advance hint:\n${brief}`,
    );
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }

  // 3b: phase=META, but the id is not B-META- prefixed.
  const rootB = setupProject('koala-meta-hint-phase-');
  try {
    const store = new StoryStore(rootB);
    writeStory(store, 'B-phasemeta', 'META');
    const brief = runKoala(rootB, 'session_brief');
    assert.ok(!brief.includes('## Active stories'), `phase=META story must be excluded from Active stories:\n${brief}`);
    assert.ok(brief.includes('## META containers'), `phase=META story must render in META containers:\n${brief}`);
    assert.ok(!brief.includes(INIT_CHECK_HINT), `phase=META story must not surface an INIT_CHECK hint:\n${brief}`);
    assert.ok(
      !brief.includes(advanceHintFor('B-phasemeta')),
      `phase=META story must not get a story_advance hint:\n${brief}`,
    );
  } finally {
    rmSync(rootB, { recursive: true, force: true });
  }
}

assertMetaContainerAloneGetsAuditHint();
assertMetaCoexistsWithNormalStory();
assertBothMetaCriteriaDetectedIndependently();

console.log('✓ meta-story next-hint smoke passed');
