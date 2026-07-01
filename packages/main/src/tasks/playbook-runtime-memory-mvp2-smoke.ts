#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { writeEntries, resolveProjectMemoryPath, type DevMemoryEntry } from '../core/dev-memory.js';
import type { Playbook } from '../core/experience-layer-types.js';
import { writePlaybooks } from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createDoneClosureHandlers } from '../handlers/done-closure.js';
import type { HandlerContext } from '../handlers/context.js';
import { createLatticeHandoffHandlers } from '../handlers/lattice-handoff.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { renderTransitionResult } from '../handlers/transition-orchestrator.js';

const NOW = '2026-07-01T00:00:00.000Z';
let total = 0;
let passed = 0;

function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} - PASS`);
  } catch (err) {
    console.error(`check: ${label} - FAIL`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  }
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function mkRoot(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'pb-memory-mvp2-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'packages/main/src/index.ts', 'export const smoke = true;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'playbook-runtime-mvp2']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);
  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory('B-smoke', story());
  store.writeChecklist('B-smoke', checklist());
  const ctx = { root, store, scanRoot: join(root, 'packages', 'main'), log: () => {} };
  seedMemory(root);
  return { root, store, ctx };
}

function story(): StoryInfo {
  return {
    storyId: 'B-smoke',
    name: 'runtime-memory-smoke',
    title: 'Runtime memory host policy story',
    description: 'Use host-policy, stale-doc, intent-totality, and delivery lessons as advisory memory.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'TEST', action: 'advance', timestamp: NOW }],
  };
}

function checklist(): ChecklistData {
  return { items: [{ id: 'CHK-001', title: 'Verify runtime memory', context: 'smoke', status: 'done', startTime: NOW, endTime: NOW }] };
}

function playbook(id: string, status: Playbook['status'], keyword: string): Playbook {
  return {
    id,
    title: `${keyword} active lesson`,
    trigger: { keywords: [keyword, 'runtime', 'memory', 'delivery', 'host-policy'], fileKinds: ['ts'], storyPhases: ['TEST', 'DONE', 'DEV'] },
    check: `Check ${keyword} before making claims.`,
    pitfalls: [`Do not turn ${keyword} memory into gate evidence.`],
    verification: [`Confirm ${keyword} remains advisory.`],
    lineage: { sourceStoryId: 'B-source', sourceFindingId: 'F-001', sourceSignature: keyword },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function memory(id: string, text: string): DevMemoryEntry {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'smoke',
    category: 'workflow',
    scope: 'project',
    summary: text,
    trigger: text,
    lesson: text,
    reusePrompt: text,
    tags: [],
    evidenceRefs: [],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function seedMemory(root: string): void {
  writePlaybooks(root, [
    playbook('PB-host-policy', 'active', 'host-policy'),
    playbook('PB-delivery', 'active', 'intent-totality'),
    playbook('PB-candidate', 'candidate', 'host-policy'),
  ]);
  writeEntries(resolveProjectMemoryPath(root), [
    memory('mem-host-policy', 'Default 3x2 host verification uses codex-cli and claude-cli; agy-cli fallback only after unavailable or quota-limited primary failure.'),
    memory('mem-stale-doc', 'Before claiming task missing from old plan prose, prefer current structured facts and DONE oracle rows.'),
    memory('mem-parent-totality', 'Full completion claims rely on ParentRollupResult/current structured facts, not advisory memory.'),
  ]);
}

async function run(): Promise<void> {
  const savedCwd = process.cwd();
  const roots: string[] = [];
  try {
    const { root, ctx } = mkRoot();
    roots.push(root);
    process.chdir(root);
    const handoff = createLatticeHandoffHandlers(ctx);
    const runtime = createPlaybookRuntimeMemoryHandlers(ctx);
    const done = createDoneClosureHandlers(ctx);

    check('command metadata: runtime-memory commands are registered and non-gate', () => {
      for (const name of ['memory_playbook_baseline_generate', 'memory_playbook_baseline_verify', 'playbook_runtime_health', 'dev_memory_finish_decision', 'final_response_check']) {
        assert.ok(MAIN_TOOLS.some((tool) => tool.name === name), `MAIN_TOOLS includes ${name}`);
        assert.notEqual((COMMAND_POLICIES as any)[name]?.gateEvidence, true, `${name} is not gate evidence`);
        assert.ok(PROCESS_FACT_LEVELS.some((entry) => entry.name === name), `process fact includes ${name}`);
      }
    });

    check('handoff_create text includes Memory Runtime Preflight and host-policy top hits', () => {
      const text = handoff.handoff_create({ storyId: 'B-smoke', fromHost: 'codex', toHost: 'claude-code' });
      assert.match(text, /## Memory Runtime Preflight/);
      assert.match(text, /authority=non_authoritative gateEvidence=false/);
      assert.match(text, /topHitIds:/);
      assert.match(text, /PB-host-policy|mem-host-policy/);
      assert.doesNotMatch(text, /PB-candidate/);
    });

    check('handoff_resume includes memory pack and agy fallback requires primary failure signal', () => {
      const pack = handoff.handoff_create({ storyId: 'B-smoke', fromHost: 'codex', toHost: 'claude-code', json: true }) as any;
      const file = join(root, 'handoff-pack.json');
      writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
      const resume = handoff.handoff_resume({ file, resumeHost: 'claude-code' });
      assert.match(resume, /Runtime memory advisory/);
      assert.match(resume, /memoryGateEvidence: false/);
      assert.throws(() => handoff.handoff_resume({ file, resumeHost: 'agy' }), /fallback-only/);
      const fallback = handoff.handoff_resume({ file, resumeHost: 'agy', primaryHostFailure: 'claude-cli unavailable' });
      assert.match(fallback, /role=fallback allowed=true/);
    });

    check('host_dispatch includes shared pack digest and fallback policy', () => {
      const pack = handoff.handoff_create({ storyId: 'B-smoke', fromHost: 'codex', toHost: 'claude-code', json: true }) as any;
      const file = join(root, 'dispatch-pack.json');
      writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
      const dispatch = handoff.host_dispatch({ file, host: 'claude-code' });
      assert.match(dispatch, /memoryPackDigest:/);
      assert.match(dispatch, /memoryGateEvidence: false/);
      assert.throws(() => handoff.host_dispatch({ file, host: 'agy' }), /fallback-only/);
    });

    check('done_closure and final_response_check surface advisory memory without proof claims', () => {
      const closure = done.done_closure({ storyId: 'B-smoke' });
      assert.match(closure, /Advisory memory considered/);
      assert.match(closure, /memoryCompletionProof: false/);
      assert.match(closure, /completionClaimSource: ParentRollupResult\/current-structured-facts/);
      const final = runtime.final_response_check({ storyId: 'B-smoke' });
      assert.match(final, /Final response advisory check/);
      assert.match(final, /memoryCompletionProof: false/);
      assert.match(final, /gateEvidence: false/);
    });

    check('transition render includes runtime memory advisory field', () => {
      const text = renderTransitionResult({
        storyId: 'B-smoke',
        newState: 'DEV',
        doneChecklistPrefix: '',
        metadataCommitReport: '',
        doneMergeReport: '',
        nextSteps: { DEV: 'next' },
        docsHint: '',
        depsWarning: '',
        sessionWarning: '',
        doneSummarySuffix: '',
        initCheckAdvisory: '',
        baselineRiskWarning: '',
        staleEvidenceHint: '',
        scopeGateReport: '',
        guardGateReport: '',
        memoryRuntimeAdvisory: '\n\nRuntime memory advisory (not gate evidence):\n## Memory Runtime Preflight\n  authority=non_authoritative gateEvidence=false',
      });
      assert.match(text, /Runtime memory advisory/);
      assert.match(text, /gateEvidence=false/);
    });

    if (process.exitCode) return;
    console.log(`playbook-runtime-memory MVP2 smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
  } finally {
    process.chdir(savedCwd);
    for (const root of roots) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

