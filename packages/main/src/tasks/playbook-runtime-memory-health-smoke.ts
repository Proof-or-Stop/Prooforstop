#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import type { Playbook } from '../core/experience-layer-types.js';
import { writePlaybooks } from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function playbook(): Playbook {
  return {
    id: 'PB-host-policy',
    title: 'host-policy runtime memory',
    trigger: { keywords: ['host-policy'], fileKinds: ['ts'], storyPhases: ['DEV', 'TEST'] },
    check: 'Use Codex CLI and Claude Code CLI as primary hosts; agy fallback only.',
    pitfalls: ['Do not let advisory memory become gate evidence.'],
    verification: ['Health surfaces host-policy as advisory runtime memory.'],
    lineage: { sourceStoryId: 'B-source', sourceFindingId: 'F-001', sourceSignature: 'host-policy' },
    status: 'active',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pb-memory-health-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      runtimeMemory: { requiredClasses: ['host-policy'] },
    }, null, 2));
    resetConfigCache();
    writePlaybooks(root, [playbook()]);
    const ctx = {
      root,
      store: new StoryStore(root),
      scanRoot: join(process.cwd(), 'packages', 'main'),
      log: () => {},
    };
    const handlers = createPlaybookRuntimeMemoryHandlers(ctx);

    assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'playbook_runtime_health'));
    assert.equal(COMMAND_POLICIES.playbook_runtime_health.ownershipClass, 'readOnly');

    const pass = handlers.playbook_runtime_health({ json: true }) as any;
    assert.equal(pass.status, 'pass');
    assert.equal(pass.authority, 'non_authoritative');
    assert.equal(pass.gateEvidence, false);
    assert.ok(pass.checks.some((check: any) => check.id === 'required-class:host-policy' && check.status === 'pass'));

    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      runtimeMemory: { requiredClasses: ['missing-class'] },
    }, null, 2));
    resetConfigCache();
    const fail = handlers.playbook_runtime_health({ json: true }) as any;
    assert.equal(fail.status, 'fail');
    assert.ok(fail.checks.some((check: any) => check.id === 'required-class:missing-class' && check.status === 'fail'));

    const fakeSourceRoot = mkdtempSync(join(tmpdir(), 'pb-memory-health-fake-src-'));
    try {
      for (const rel of [
        'src/handlers/session.ts',
        'src/handlers/lattice-handoff.ts',
        'src/handlers/story-create.ts',
        'src/handlers/transition-orchestrator.ts',
        'src/handlers/done-closure.ts',
        'src/handlers/done-prepare.ts',
        'src/handlers/playbook-runtime-memory.ts',
      ]) {
        write(fakeSourceRoot, rel, `// weak legacy token only: ${rel} story_create story_advance done_closure final_response_check\n`);
      }
      write(root, 'lattice.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        storyDir: '.lattice/story/actives',
        requirementsDir: 'docs/requirements',
        runtimeMemory: { requiredClasses: [] },
      }, null, 2));
      resetConfigCache();
      const fakeHandlers = createPlaybookRuntimeMemoryHandlers({
        root,
        store: new StoryStore(root),
        scanRoot: fakeSourceRoot,
        log: () => {},
      });
      const drift = fakeHandlers.playbook_runtime_health({ json: true }) as any;
      assert.equal(drift.status, 'fail');
      assert.ok(
        drift.checks.some((check: any) => String(check.id).startsWith('consumer-wiring:') && check.status === 'fail'),
        'health must fail when weak handler tokens remain but real MemoryFreshnessPack wiring is absent',
      );
    } finally {
      if (existsSync(fakeSourceRoot)) rmSync(fakeSourceRoot, { recursive: true, force: true });
    }

    const decision = handlers.dev_memory_finish_decision({
      storyId: 'B-smoke',
      decision: 'no-reusable-lesson',
      reason: 'No reusable lesson was found in this short smoke.',
      json: true,
    }) as any;
    assert.equal(decision.record.authority, 'non_authoritative');
    assert.equal(decision.record.gateEvidence, false);
    assert.equal(decision.record.automaticPromotion, false);
    assert.ok(existsSync(decision.path));
    assert.match(readFileSync(decision.path, 'utf8'), /no-reusable-lesson/);

    for (const invalid of [
      {
        storyId: '../../outside',
        forbiddenPaths: [
          join(root, '.lattice', 'outside.json'),
          join(root, '.lattice', 'dev-memory', 'outside.json'),
        ],
      },
      {
        storyId: '../../../outside-root',
        forbiddenPaths: [join(root, 'outside-root.json')],
      },
      {
        storyId: 'B-bad/leaf',
        forbiddenPaths: [join(root, '.lattice', 'dev-memory', 'finish-decisions', 'B-bad', 'leaf.json')],
      },
    ]) {
      assert.throws(
        () => handlers.dev_memory_finish_decision({
          storyId: invalid.storyId,
          decision: 'no-reusable-lesson',
          reason: 'Invalid story id must fail before path use.',
          json: true,
        }),
        /dev_memory_finish_decision: invalid storyId .*path-safe Proofbound story id/,
      );
      for (const forbiddenPath of invalid.forbiddenPaths) {
        assert.equal(existsSync(forbiddenPath), false, `invalid storyId ${invalid.storyId} writes no outside file ${forbiddenPath}`);
      }
    }

    console.log('playbook-runtime-memory health smoke passed');
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
