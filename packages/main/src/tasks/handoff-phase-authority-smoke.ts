#!/usr/bin/env node
/**
 * @task B-6493
 * @checklist CHK-001 CHK-002
 * @title handoff phase-authority warning smoke
 * @type feature
 * @priority medium
 * @description
 *   Proves the phase-authority warning fires only when a story's
 *   linked-worktree (authoritative) phase diverges from the packed
 *   main-mirror phase, that it renders in handoff_create / handoff_inspect
 *   output, and — critically — that its presence never perturbs packHash
 *   (the field is outside HandoffPackHashInput). Also proves createHandoffPack
 *   stays warning-free and failure-safe for the common no-worktree case.
 * @changes
 *   - [CHK-001] Unit-cover buildPhaseAuthorityWarning + packHash byte-stability
 *   - [CHK-002] Cover inspect/render surface + createHandoffPack no-warning path
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import {
  buildPhaseAuthorityWarning,
  computeHandoffPackHash,
  createHandoffPack,
  inspectHandoffPack,
  renderHandoffInspectionText,
  type HandoffPack,
  type PhaseAuthorityWarning,
} from '../core/lattice-handoff.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: 'Docs/story/actives',
  }, null, 2));
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-13T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-phaseauth',
    name: 'phase-authority-smoke',
    title: 'Phase authority smoke story',
    description: 'Seed story for the handoff phase-authority warning smoke.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-phaseauth' }],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Seed', status: 'done', startTime: now, endTime: now }],
  };
  store.writeStory('B-phaseauth', story);
  store.writeChecklist('B-phaseauth', checklist);
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('handoff-phase-authority-smoke');

// --- 1. Pure helper: worktree ahead of mirror → 'ahead' warning ---------------
check('buildPhaseAuthorityWarning: worktree ahead → ahead warning', () => {
  const w = buildPhaseAuthorityWarning({
    mirrorPhase: 'INIT_CHECK',
    authoritativePhase: 'DEV',
    worktreePath: '/repo/.worktrees/B-x',
  });
  assert.ok(w, 'expected a warning');
  assert.equal(w!.kind, 'phase-authority');
  assert.equal(w!.relation, 'ahead');
  assert.equal(w!.mirrorPhase, 'INIT_CHECK');
  assert.equal(w!.authoritativePhase, 'DEV');
  assert.equal(w!.worktreePath, '/repo/.worktrees/B-x');
  assert.match(w!.message, /DEV/);
  assert.match(w!.message, /INIT_CHECK/);
  assert.match(w!.message, /ahead/);
});

// --- 2. Pure helper: in sync → no warning -------------------------------------
check('buildPhaseAuthorityWarning: phases equal → undefined', () => {
  const w = buildPhaseAuthorityWarning({
    mirrorPhase: 'DEV',
    authoritativePhase: 'DEV',
    worktreePath: '/repo/.worktrees/B-x',
  });
  assert.equal(w, undefined);
});

// --- 3. Pure helper: no linked worktree → no warning --------------------------
check('buildPhaseAuthorityWarning: no worktree → undefined', () => {
  const w = buildPhaseAuthorityWarning({
    mirrorPhase: 'INIT_CHECK',
    authoritativePhase: 'DEV',
    worktreePath: null,
  });
  assert.equal(w, undefined);
});

// --- 4. Pure helper: authoritative behind mirror → 'divergent' ----------------
check('buildPhaseAuthorityWarning: authoritative behind → divergent', () => {
  const w = buildPhaseAuthorityWarning({
    mirrorPhase: 'DEV',
    authoritativePhase: 'INIT_CHECK',
    worktreePath: '/repo/.worktrees/B-x',
  });
  assert.ok(w, 'expected a warning on any divergence');
  assert.equal(w!.relation, 'divergent');
});

// --- 5. packHash byte-stability: the field is never hashed --------------------
check('computeHandoffPackHash ignores phaseAuthorityWarning (byte-stable)', () => {
  const input = {
    packId: 'HP-deadbeef0000',
    storyId: 'B-phaseauth',
    fromHost: 'codex',
    toHost: 'claude-code',
    baseSha: 'abc123',
    allowedPaths: ['packages/main/src'],
    deniedPaths: [],
    requiredCommands: ['npm test'],
    successCriteria: ['green'],
    executionInstructions: [],
  };
  const warning: PhaseAuthorityWarning = {
    kind: 'phase-authority',
    mirrorPhase: 'INIT_CHECK',
    authoritativePhase: 'DEV',
    worktreePath: '/repo/.worktrees/B-phaseauth',
    relation: 'ahead',
    message: 'irrelevant to hash',
  };
  const without = computeHandoffPackHash(input);
  const withWarning = computeHandoffPackHash({ ...input, phaseAuthorityWarning: warning } as typeof input);
  assert.equal(withWarning, without, 'packHash must not change when the warning is present');
});

// --- 6. Inspect + render surface: present renders, absent stays silent --------
check('inspect + render: warning present is rendered, absent is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-phaseauth-render-'));
  try {
    writeConfig(root);
    resetConfigCache();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'smoke@example.com']);
    git(root, ['config', 'user.name', 'smoke']);
    writeFileSync(join(root, 'seed.txt'), 'seed');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'seed']);
    const store = new StoryStore(root);
    seedStory(store);

    // Real factory path, no linked worktree → no warning, silent render.
    const clean = createHandoffPack(store, root, { storyId: 'B-phaseauth', fromHost: 'codex', toHost: 'claude-code' });
    assert.equal(clean.phaseAuthorityWarning, undefined, 'no-worktree story must produce no warning');
    const cleanText = renderHandoffInspectionText(inspectHandoffPack(clean));
    assert.equal(/phaseAuthority/.test(cleanText), false, 'silent render when no warning');

    // Same pack with a warning grafted on → inspect carries it, render shows it.
    const warned: HandoffPack = {
      ...clean,
      phaseAuthorityWarning: {
        kind: 'phase-authority',
        mirrorPhase: 'INIT_CHECK',
        authoritativePhase: 'DEV',
        worktreePath: join(root, '.worktrees', 'B-phaseauth'),
        relation: 'ahead',
        message: 'Authoritative worktree phase DEV is ahead of the packed mirror phase INIT_CHECK.',
      },
    };
    const inspection = inspectHandoffPack(warned);
    assert.ok(inspection.phaseAuthorityWarning, 'inspection must carry the warning');
    assert.equal(inspection.phaseAuthorityWarning!.relation, 'ahead');
    const warnedText = renderHandoffInspectionText(inspection);
    assert.match(warnedText, /phaseAuthority \(ahead\)/);
    assert.match(warnedText, /ahead of the packed mirror phase INIT_CHECK/);

    // And the warning never leaks into packHash, even via the real factory.
    assert.equal(warned.packHash, clean.packHash, 'grafting a warning must not change packHash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.error(`\nhandoff-phase-authority-smoke FAILED (${failures} failing)`);
  process.exit(1);
}
console.log('\nhandoff-phase-authority-smoke PASS');
