#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import {
  buildMemoryFreshnessPack,
  classifyMemoryFreshnessPack,
  renderMemoryFreshnessPack,
} from '../core/playbook-runtime-memory.js';
import {
  computePlaybookProposalDigest,
  computePlaybookDigest,
  readPlaybooks,
  resolvePlaybooksPath,
  writeProposal,
  writePlaybooks,
} from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import {
  resolveProjectMemoryPath,
  writeEntries,
  type DevMemoryEntry,
} from '../core/dev-memory.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { Playbook, PlaybookProposal } from '../core/experience-layer-types.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';
import { createSessionHandlers } from '../handlers/session.js';
import type { HandlerContext } from '../handlers/context.js';

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
  writeFileSync(file, content, 'utf-8');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function mkRoot(prefix = 'pb-memory-mvp1-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function mkGitStoryRoot(storyId = 'B-smoke'): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkRoot();
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'playbook-runtime-smoke']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);
  git(root, ['checkout', '-q', '-b', `story/${storyId}`]);

  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId));
  store.writeChecklist(storyId, checklist());
  const ctx = mkCtx(root, store);
  return { root, store, ctx };
}

function mkCtx(root: string, store = new StoryStore(root)): HandlerContext {
  resetConfigCache();
  return {
    root,
    store,
    scanRoot: join(root, 'packages', 'main'),
    log: () => {},
  };
}

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: 'Runtime memory host policy story',
    description: 'Exercise session_brief memory runtime preflight consumption',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: NOW }],
  };
}

function checklist(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Surface runtime memory',
        context: 'MVP1 smoke',
        status: 'pending',
        startTime: null,
        endTime: null,
      },
    ],
  };
}

function playbook(id: string, status: Playbook['status'], keyword = 'host-policy'): Playbook {
  return {
    id,
    title: `${keyword} runtime reminder ${id}`,
    trigger: {
      keywords: [keyword, 'runtime', 'memory'],
      fileKinds: ['ts'],
      storyPhases: ['DEV'],
    },
    check: `Check ${keyword} before making a runtime claim`,
    pitfalls: [`Forgetting ${keyword} causes stale work`],
    verification: [`Confirm ${keyword} was considered`],
    lineage: {
      sourceStoryId: 'B-source',
      sourceFindingId: 'B-source:F-001',
      sourceSignature: keyword,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function memoryEntry(id: string, patch: Partial<DevMemoryEntry> = {}): DevMemoryEntry {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'smoke',
    category: 'workflow',
    scope: 'project',
    summary: 'Remember the legacy trap before acting',
    trigger: 'legacy trap query',
    lesson: 'Use the current superseding runtime memory lesson',
    reusePrompt: 'Search for legacy trap runtime memory',
    tags: [],
    evidenceRefs: [],
    gateEvidence: false,
    authority: 'non_authoritative',
    ...patch,
  };
}

function assertLineCap(rendered: string): void {
  const lines = rendered.split('\n');
  assert.ok(lines.length <= 60, `rendered ${lines.length} lines, expected <=60`);
}

async function run(): Promise<void> {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const roots: string[] = [];
  try {
    const globalMemoryDir = mkdtempSync(join(tmpdir(), 'pb-memory-global-'));
    roots.push(globalMemoryDir);
    process.env.LATTICE_GLOBAL_MEMORY_DIR = globalMemoryDir;

    check('command metadata: playbook_activate is supported audit-only metadata, not gate evidence', () => {
      assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'playbook_activate'), 'MAIN_TOOLS includes playbook_activate');
      const policy = COMMAND_POLICIES.playbook_activate;
      assert.equal(policy.status, 'supported');
      assert.equal(policy.ownershipClass, 'mainSharedMutating');
      assert.notEqual((policy as { gateEvidence?: boolean }).gateEvidence, true);
      const fact = PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_activate');
      assert.ok(fact, 'PROCESS_FACT_LEVELS includes playbook_activate');
      assert.equal(fact!.level, 'L2');
      assert.equal((fact as { gateConsumer?: string } | undefined)?.gateConsumer, undefined);
    });

    check('activation boundary: stale digest rejects, malformed rejects, correct digest activates and preserves sibling row', () => {
      const root = mkRoot(); roots.push(root);
      const ctx = mkCtx(root);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = playbook('PB-001', 'candidate');
      const sibling = playbook('PB-002', 'candidate', 'delivery');
      writePlaybooks(root, [candidate, sibling]);

      assert.throws(
        () => handlers.playbook_activate({ playbookId: candidate.id, expectedPlaybookDigest: '0'.repeat(64) }),
        /expectedPlaybookDigest is stale/,
      );
      assert.equal(readPlaybooks(root).find((p) => p.id === candidate.id)?.status, 'candidate');

      writePlaybooks(root, [{ id: 'PB-bad', status: 'candidate' } as unknown as Playbook]);
      assert.throws(
        () => handlers.playbook_activate({ playbookId: 'PB-bad', expectedPlaybookDigest: '0'.repeat(64) }),
        /malformed playbook/,
      );

      writePlaybooks(root, [candidate, sibling]);
      const digest = computePlaybookDigest(candidate);
      const out = handlers.playbook_activate({ playbookId: candidate.id, expectedPlaybookDigest: digest });
      assert.match(out, /status: active/);
      const after = readPlaybooks(root);
      assert.equal(after.find((p) => p.id === candidate.id)?.status, 'active');
      assert.ok(after.some((p) => p.id === sibling.id), 'sibling row was preserved');
    });

    check('usability: diff and approve output expose candidatePlaybookDigest as non-authoritative', () => {
      const root = mkRoot(); roots.push(root);
      const ctx = mkCtx(root);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = playbook('PB-digest', 'candidate');
      const proposal: PlaybookProposal = {
        id: candidate.id,
        title: candidate.title,
        trigger: candidate.trigger,
        check: candidate.check,
        pitfalls: candidate.pitfalls,
        verification: candidate.verification,
        lineage: candidate.lineage,
        status: 'proposed',
        proposalDigest: '',
      };
      proposal.proposalDigest = computePlaybookProposalDigest(proposal);
      writeProposal(root, proposal);
      const digest = computePlaybookDigest(candidate);

      const diff = handlers.playbook_diff({ proposalId: proposal.id });
      assert.match(diff, new RegExp(`candidatePlaybookDigest: ${digest}`));
      assert.match(diff, /authority: non_authoritative/);
      assert.match(diff, /gateEvidence: false/);

      const approved = handlers.playbook_approve({
        proposalId: proposal.id,
        expectedProposalDigest: proposal.proposalDigest,
      });
      assert.match(approved, new RegExp(`candidatePlaybookDigest: ${digest}`));
      assert.match(approved, /authority: non_authoritative/);
      assert.match(approved, /gateEvidence: false/);
    });

    check('runtime pack: active playbook appears, candidate does not, pack/source digests and authority flags are present', () => {
      const root = mkRoot(); roots.push(root);
      const active = playbook('PB-active', 'active');
      const candidate = playbook('PB-candidate', 'candidate');
      writePlaybooks(root, [active, candidate]);
      const pack = buildMemoryFreshnessPack({
        projectRoot: root,
        query: 'host-policy runtime',
        storyPhase: 'DEV',
        consumer: 'session_brief',
      });
      assert.ok(pack.results.playbookIds.includes('PB-active'), 'active playbook surfaced');
      assert.equal(pack.results.playbookIds.includes('PB-candidate'), false, 'candidate stayed inert');
      assert.match(pack.packDigest, /^[0-9a-f]{64}$/);
      assert.ok(pack.sourceDigests.playbookDigest, 'playbook source digest present');
      assert.equal(pack.gateEvidence, false);
      assert.equal(pack.authority, 'non_authoritative');
    });

    check('dev-memory: superseded entries are suppressed and recorded', () => {
      const root = mkRoot(); roots.push(root);
      const old = memoryEntry('mem0001', {
        summary: 'Legacy trap old lesson',
        lesson: 'Old lesson should not surface directly',
        reusePrompt: 'legacy trap old',
      });
      const current = memoryEntry('mem0002', {
        summary: 'Current runtime memory lesson',
        lesson: 'Current lesson inherits the legacy trap query',
        reusePrompt: 'Use current lesson',
        tags: ['supersedes-mem0001'],
      });
      writeEntries(resolveProjectMemoryPath(root), [old, current]);
      const pack = buildMemoryFreshnessPack({ projectRoot: root, query: 'legacy trap', consumer: 'session_brief' });
      assert.deepEqual(pack.results.devMemoryEntryIds, ['mem0002']);
      assert.deepEqual(pack.results.suppressedSupersededIds, ['mem0001']);
      assert.ok(pack.results.contributingSourceRefs.some((ref) => ref.startsWith('dev-memory:mem0001:')));
    });

    check('freshness: mutating a surfaced source row classifies the old pack as stale-relevant', () => {
      const root = mkRoot(); roots.push(root);
      const entry = memoryEntry('mem0100', {
        summary: 'Relevant source mutation row',
        trigger: 'source mutation',
        lesson: 'Original relevant source lesson',
        reusePrompt: 'source mutation',
      });
      writeEntries(resolveProjectMemoryPath(root), [entry]);
      const pack = buildMemoryFreshnessPack({ projectRoot: root, query: 'source mutation', consumer: 'session_brief' });
      writeEntries(resolveProjectMemoryPath(root), [
        { ...entry, lesson: 'Changed relevant source lesson' },
      ]);
      const checked = classifyMemoryFreshnessPack(pack);
      assert.equal(checked.freshness.stale, true);
      assert.equal(checked.freshness.class, 'stale-relevant');
    });

    check('freshness: unrelated append-only churn is stale-irrelevant with unchanged surfaced ids', () => {
      const root = mkRoot(); roots.push(root);
      const entry = memoryEntry('mem0200', {
        summary: 'Relevant source mutation row',
        trigger: 'source mutation',
        lesson: 'Original relevant source lesson',
        reusePrompt: 'source mutation',
      });
      writeEntries(resolveProjectMemoryPath(root), [entry]);
      const pack = buildMemoryFreshnessPack({ projectRoot: root, query: 'source mutation', consumer: 'session_brief' });

      const unrelated = memoryEntry('mem0201', {
        summary: 'Completely separate garden note',
        trigger: 'banana orchard reminder',
        lesson: 'This row is intentionally unrelated to the active query',
        reusePrompt: 'remember banana orchard',
      });
      writeEntries(resolveProjectMemoryPath(root), [entry, unrelated]);
      const current = buildMemoryFreshnessPack({ projectRoot: root, query: 'source mutation', consumer: 'session_brief' });
      assert.notEqual(
        current.sourceDigests.projectDevMemoryDigest,
        pack.sourceDigests.projectDevMemoryDigest,
        'broad project dev-memory source digest changed',
      );
      assert.deepEqual(current.results.devMemoryEntryIds, pack.results.devMemoryEntryIds, 'surfaced ids unchanged');
      assert.deepEqual(current.results.suppressedSupersededIds, pack.results.suppressedSupersededIds, 'suppressed ids unchanged');

      const checked = classifyMemoryFreshnessPack(pack);
      assert.equal(checked.freshness.stale, true);
      assert.equal(checked.freshness.class, 'stale-irrelevant');
      assert.equal(checked.gateEvidence, false);
      assert.equal(checked.authority, 'non_authoritative');
    });

    check('rendering: MemoryFreshnessPack output is capped at 60 lines and records omittedCount', () => {
      const root = mkRoot(); roots.push(root);
      writePlaybooks(root, Array.from({ length: 25 }, (_v, idx) => playbook(`PB-cap-${idx}`, 'active')));
      const pack = buildMemoryFreshnessPack({
        projectRoot: root,
        query: 'runtime',
        storyPhase: 'DEV',
        consumer: 'session_brief',
        maxPlaybooks: 25,
      });
      const rendered = renderMemoryFreshnessPack(pack);
      assertLineCap(rendered);
      assert.ok(pack.render.omittedCount > 0, 'omittedCount records capped lines');
    });

    check('empty state: pack renders explicit empty non-authoritative state', () => {
      const root = mkRoot(); roots.push(root);
      const pack = buildMemoryFreshnessPack({ projectRoot: root, query: 'nothing relevant', consumer: 'session_brief' });
      const rendered = renderMemoryFreshnessPack(pack);
      assert.match(rendered, /empty: no relevant active playbooks or dev-memory entries surfaced/);
      assert.match(rendered, /authority=non_authoritative gateEvidence=false/);
      assertLineCap(rendered);
    });

    check('session_brief: full output includes bounded Memory Runtime Preflight and never surfaces candidates', () => {
      const { root, ctx } = mkGitStoryRoot('B-smoke'); roots.push(root);
      process.chdir(root);
      writePlaybooks(root, [playbook('PB-session-active', 'active'), playbook('PB-session-candidate', 'candidate')]);
      const brief = createSessionHandlers(ctx).session_brief({});
      assert.match(brief, /## Memory Runtime Preflight/);
      assert.match(brief, /PB-session-active/);
      assert.doesNotMatch(brief, /PB-session-candidate/);
      assert.match(brief, /authority=non_authoritative gateEvidence=false/);
      const section = brief.split('## Memory Runtime Preflight')[1].split('\n## ')[0];
      assertLineCap(`## Memory Runtime Preflight${section}`);
    });

    check('session_brief: corrupt advisory memory/playbooks do not crash the brief', () => {
      const { root, ctx } = mkGitStoryRoot('B-corrupt'); roots.push(root);
      process.chdir(root);
      write(root, '.lattice/dev-memory/experience.jsonl', '{not-json\n');
      mkdirSync(dirname(resolvePlaybooksPath(root)), { recursive: true });
      writeFileSync(resolvePlaybooksPath(root), '{not-json\n', 'utf-8');
      assert.doesNotThrow(() => createSessionHandlers(ctx).session_brief({}));
      const brief = createSessionHandlers(ctx).session_brief({});
      assert.match(brief, /## Memory Runtime Preflight/);
      assert.match(brief, /gateEvidence=false/);
    });

    if (process.exitCode) {
      console.error(`playbook-runtime-memory MVP1 smoke failed: TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
      return;
    }
    console.log(`playbook-runtime-memory MVP1 smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    for (const root of roots) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
