#!/usr/bin/env node
/**
 * @task B-ab8d
 * @checklist CHK-005
 * @title experience-pack-arm-switch-smoke
 * @type feature
 * @priority high
 * @description
 *   B-ab8d CHK-005 — end-to-end arm-switch smoke for the M3 exit criteria:
 *   full runtime-pack render gating (CHK-002 shared leaf), control-arm memory
 *   retrieval blocking at the CLI choke point (CHK-003), and the experiment
 *   context resolver (CHK-001).
 *
 *   Cases (per plan.md CHK-005 DoneWhen, adjusted by two DEV discoveries):
 *   (a) no-experiment mode is byte-identical pass-through at the pack
 *       entrypoints: section renders, NO experience_pack_surfaced event, no
 *       activity-log read/write (temp fixture repo, captured baseline);
 *   (b) control hides the pack render + logs experience_pack_surfaced at the
 *       entrypoints (session_brief, story_create, done_prepare summary shape).
 *       ADJUSTMENT 1: dev_memory_start on control is BLOCKED by the CHK-003
 *       retrieval gate at the CLI choke point BEFORE it can render (it is a
 *       memory-consumption command, plan section 9) — the smoke asserts the
 *       refusal + retrieval_violation event for it instead of a surfaced event;
 *   (c) treatment shows the pack + event, byte-identical rendering vs no-env;
 *   (d) partial env context (only one var) is ignored with a console.warn
 *       naming the ignored var; invalid arm values name control|treatment;
 *   (e) retrieval blocked + retrieval_violation recorded on control (recall
 *       AND a dev_memory_* command), normal on treatment/no-env; a non-memory
 *       command (story_list) still works on control;
 *   (f) catalog cross-check — every registered command name matching the
 *       memory families carries the memoryRetrieval policy marker, and a
 *       deliberately unmarked memory-family name FAILS the same cross-check
 *       (proves the checker is non-vacuous);
 *   (g) resolveReviewPromptHash is byte-identical across arms;
 *   (h) event dedup: one event per (experimentId, consumer, storyId-or-global,
 *       roundKey);
 *   (i) ADJUSTMENT 2 (eighth surface): the host_dispatch text projection
 *       (renderHostDispatchProjectionText) prints NO memoryPackDigest /
 *       memoryTopHitIds / memoryAuthority / memoryGateEvidence lines on
 *       control and is byte-identical on treatment vs no-env.
 *
 *   Runs entirely in OS temp dirs (mkdtemp), isolates global dev-memory via
 *   LATTICE_GLOBAL_MEMORY_DIR, saves/restores process.env + cwd, and never
 *   writes to the production .lattice/learning store — following the
 *   experience-layer-ab-shadow-gate-smoke conventions.
 * @changes
 *   - [CHK-005] Add the arm-switch integration smoke and register it in validate.commands.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAIN_TOOLS, enforceExperimentArmRetrievalGate } from '../cli-engine.js';
import { isMemoryRetrievalCommand } from '../core/command-policy.js';
import {
  EXPERIMENT_ARM_ENV_VAR,
  EXPERIMENT_ID_ENV_VAR,
  resetExperimentArmWarnLatch,
  resolveExperimentArm,
} from '../core/experiment-arm.js';
import {
  EXPERIENCE_PACK_SURFACED_EVENT,
  shouldRenderRuntimeMemoryPack,
  surfaceRuntimeMemoryPack,
} from '../core/experience-pack-surface.js';
import { getRuntimeActivityLogPath, readActivityLogTail } from '../core/activity-log.js';
import { resetConfigCache } from '../core/config.js';
import { buildMemoryFreshnessPack, runtimeMemoryTopHits } from '../core/playbook-runtime-memory.js';
import { writePlaybooks } from '../core/learning-store.js';
import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import { renderHostDispatchProjectionText } from '../core/lattice-handoff.js';
import type { HostDispatchProjection } from '../core/lattice-handoff.js';
import { resolveReviewPromptHash } from '../core/review-run.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { Playbook } from '../core/experience-layer-types.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';
import { createDevMemoryHandlers } from '../handlers/dev-memory.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import type { HandlerContext } from '../handlers/context.js';

const NOW = '2026-07-01T00:00:00.000Z';
const EXP_A = 'exp-b-ab8d-arm-switch-a';
const EXP_B = 'exp-b-ab8d-arm-switch-b';
const PACK_SECTION = '## Memory Runtime Preflight';
const DONE_ADVISORY = 'Advisory memory considered:';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');

let total = 0;
let passed = 0;

function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

// ─── env helpers ──────────────────────────────────────────────────────────────

function setArm(arm: string, experimentId = EXP_A): void {
  process.env[EXPERIMENT_ID_ENV_VAR] = experimentId;
  process.env[EXPERIMENT_ARM_ENV_VAR] = arm;
}

function clearArm(): void {
  delete process.env[EXPERIMENT_ID_ENV_VAR];
  delete process.env[EXPERIMENT_ARM_ENV_VAR];
}

/** Base env for CLI child processes: never inherit the smoke's own arm vars. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[EXPERIMENT_ID_ENV_VAR];
  delete env[EXPERIMENT_ARM_ENV_VAR];
  return { ...env, ...extra };
}

function runCli(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: cliEnv(extraEnv),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return true;
    };
    const result = fn();
    return { result, stderr };
  } finally {
    process.stderr.write = originalWrite as typeof process.stderr.write;
  }
}

function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

// ─── fixture helpers ──────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function mkRoot(prefix = 'b-ab8d-arm-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
  return root;
}

function mkCtx(root: string, store = new StoryStore(root)): HandlerContext {
  resetConfigCache();
  return { root, store, scanRoot: join(root, 'packages', 'main'), log: () => {} };
}

function playbook(id: string, status: Playbook['status'], keyword = 'host-policy'): Playbook {
  return {
    id,
    title: `${keyword} runtime reminder ${id}`,
    trigger: {
      keywords: [keyword, 'runtime', 'memory', 'delivery'],
      fileKinds: ['ts'],
      storyPhases: ['DEV', 'TEST', 'DONE'],
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

function memoryEntry(id: string, text: string): DevMemoryEntry {
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
  writePlaybooks(root, [playbook('PB-arm-active', 'active'), playbook('PB-arm-candidate', 'candidate')]);
  writeEntries(resolveProjectMemoryPath(root), [
    memoryEntry('mem-arm-1', 'host-policy runtime memory delivery lesson for the arm switch smoke'),
  ]);
}

function storyInfo(storyId: string, phase: StoryInfo['phase']): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: 'Runtime memory arm switch story',
    description: 'Exercise runtime memory pack surfacing across experiment arms with host-policy delivery lessons.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: NOW }],
  };
}

function checklistData(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'Verify runtime memory arm switching',
      context: 'CHK-005 smoke fixture item',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  };
}

/** Git fixture: main branch + story/<id> branch, story + checklist in store. */
function mkGitStoryRoot(storyId: string, phase: StoryInfo['phase']): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkRoot();
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  // The advisory stores are materialHash-excluded by design; ignore them in
  // the fixture too so surfaced events / pack caches written DURING the smoke
  // never dirty the tree and block done_prepare's cleanTree preflight.
  write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/learning/\n');
  seedMemory(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'arm-switch-smoke']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['switch', '-q', '-c', `story/${storyId}`]);
  const store = new StoryStore(root);
  store.writeStory(storyId, storyInfo(storyId, phase));
  store.writeChecklist(storyId, checklistData());
  return { root, store, ctx: mkCtx(root, store) };
}

function packEvents(root: string, consumer?: string): Array<Record<string, unknown>> {
  return readActivityLogTail(root, 1000).filter(
    (e) => e.event === EXPERIENCE_PACK_SURFACED_EVENT && (consumer === undefined || e.consumer === consumer),
  );
}

function violationEvents(root: string): Array<Record<string, unknown>> {
  return readActivityLogTail(root, 1000).filter((e) => e.event === 'retrieval_violation');
}

/** Extract the rendered pack section (header to the next H2 or end). */
function packSectionOf(text: string): string {
  const start = text.indexOf(PACK_SECTION);
  assert.ok(start >= 0, `text does not contain "${PACK_SECTION}"`);
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', PACK_SECTION.length);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Remove the done_prepare advisory memory block for the control-vs-baseline diff. */
function stripDoneAdvisoryBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === DONE_ADVISORY) {
      inBlock = true;
      // The block is preceded by one deliberate blank spacer line.
      if (out.length > 0 && out[out.length - 1] === '') out.pop();
      continue;
    }
    if (inBlock) {
      if (line.startsWith('  ')) continue; // indented advisory content
      inBlock = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

const MEMORY_PROJECTION_LINE = /^memory(PackDigest|TopHitIds|Authority|GateEvidence): /;

/** The same memory-family matcher the catalog cross-check case relies on. */
const MEMORY_FAMILY_PATTERNS: readonly RegExp[] = [
  /^recall(_|$)/,
  /^dev_memory_/,
  /^playbook_/,
  /^(learning_scan|learning_validate|learning_effectiveness)$/,
  /^memory_playbook_baseline_/,
];

function matchesMemoryFamily(name: string): boolean {
  return MEMORY_FAMILY_PATTERNS.some((pattern) => pattern.test(name));
}

/** Names that match a memory family but do NOT carry the memoryRetrieval marker. */
function missingMarkerNames(names: readonly string[]): string[] {
  return names.filter((name) => matchesMemoryFamily(name) && !isMemoryRetrievalCommand(name));
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  try {
    // Isolate global dev-memory: never read/write the operator's real store.
    const globalMemoryDir = mkdtempSync(join(tmpdir(), 'b-ab8d-arm-global-'));
    tmpRoots.push(globalMemoryDir);
    process.env.LATTICE_GLOBAL_MEMORY_DIR = globalMemoryDir;
    clearArm();
    resetExperimentArmWarnLatch();

    // ── (a) no-experiment byte-identical pass-through ────────────────────────

    const devRoot = mkRoot();
    seedMemory(devRoot);
    const devHandlers = createDevMemoryHandlers(mkCtx(devRoot));
    let devBaseline = '';

    check('(a) happy — no-experiment dev_memory_start renders the pack, byte-stable, zero surfaced events', () => {
      clearArm();
      devBaseline = devHandlers.dev_memory_start({ agent: 'arm-smoke', query: 'host-policy runtime memory delivery' });
      const second = devHandlers.dev_memory_start({ agent: 'arm-smoke', query: 'host-policy runtime memory delivery' });
      assert.ok(devBaseline.includes(PACK_SECTION), 'no-env dev_memory_start renders the pack section');
      assert.ok(devBaseline.includes('PB-arm-active'), 'active playbook surfaced');
      assert.equal(second, devBaseline, 'no-env output is byte-stable across calls (captured baseline)');
      assert.equal(packEvents(devRoot).length, 0, 'no experiment: NO experience_pack_surfaced event');
    });

    check('(a) edge — surfaceRuntimeMemoryPack pass-through: shouldRender=true, no event, no activity log write', () => {
      clearArm();
      const root = mkRoot();
      seedMemory(root);
      const surfaced = surfaceRuntimeMemoryPack(root, {
        consumer: 'session_brief',
        storyId: 'B-arm',
        roundKey: 'DEV',
        buildPack: () => buildMemoryFreshnessPack({ projectRoot: root, query: 'host-policy runtime', consumer: 'session_brief' }),
      });
      assert.equal(surfaced.experiment, null, 'no experiment context resolved');
      assert.equal(surfaced.shouldRender, true, 'render pass-through');
      assert.equal(surfaced.fired, false, 'no event fired');
      assert.match(surfaced.pack.packDigest, /^[0-9a-f]{64}$/, 'pack still computed');
      assert.ok(!existsSync(getRuntimeActivityLogPath(root)), 'no activity log created in pass-through mode');
      assert.equal(shouldRenderRuntimeMemoryPack(), true, 'pure render probe defaults to true');
    });

    // ── shared git fixture: session_brief + done_prepare across all three arms ─

    const main = mkGitStoryRoot('B-smoke', 'TEST');
    process.chdir(main.root);
    const session = createSessionHandlers(main.ctx);
    const prepare = createDonePrepareHandlers(main.ctx);
    const donePrepareArgs = { storyId: 'B-smoke', mergeMain: false, refreshStale: false, validate: false, dryRun: true } as const;
    let briefBaseline = '';
    let doneBaseline = '';

    check('(a) happy — no-experiment session_brief renders the pack section and logs no surfaced event', () => {
      clearArm();
      briefBaseline = session.session_brief({});
      assert.ok(briefBaseline.includes(PACK_SECTION), 'no-env session_brief renders the pack section');
      assert.equal(packEvents(main.root, 'session_brief').length, 0, 'no surfaced event without an experiment');
    });

    await checkAsync('(a) happy — no-experiment done_prepare prints the advisory memory summary, no surfaced event', async () => {
      clearArm();
      doneBaseline = await prepare.done_prepare({ ...donePrepareArgs });
      assert.ok(doneBaseline.includes(DONE_ADVISORY), 'no-env done_prepare shows the advisory memory summary');
      assert.ok(doneBaseline.includes('memoryPackDigest: '), 'summary shape includes memoryPackDigest');
      assert.ok(doneBaseline.includes('memoryAuthority: non_authoritative'), 'summary shape includes authority');
      assert.ok(doneBaseline.includes('memoryGateEvidence: false'), 'summary shape includes gateEvidence');
      assert.equal(packEvents(main.root, 'done_prepare').length, 0, 'no surfaced event without an experiment');
    });

    // ── (c) treatment: pack shown + event, byte-identical vs no-env ──────────

    check('(c) happy — treatment dev_memory_start output is byte-identical to no-env and fires the event', () => {
      setArm('treatment');
      const treated = devHandlers.dev_memory_start({ agent: 'arm-smoke', query: 'host-policy runtime memory delivery' });
      assert.equal(treated, devBaseline, 'treatment render is byte-identical to the no-env baseline');
      const events = packEvents(devRoot, 'dev_memory_start');
      assert.equal(events.length, 1, 'treatment fires exactly one surfaced event');
      assert.equal(events[0].arm, 'treatment');
      assert.equal(events[0].experimentId, EXP_A);
      assert.equal(events[0].storyId, 'global', 'dev_memory_start has no story scope -> global');
      assert.match(String(events[0].packDigest), /^[0-9a-f]{64}$/);
      assert.ok(Array.isArray(events[0].topHitIds), 'event carries topHitIds');
      clearArm();
    });

    check('(c) happy — treatment session_brief pack section is byte-identical to no-env and fires the event', () => {
      setArm('treatment');
      const treated = session.session_brief({});
      assert.ok(treated.includes(PACK_SECTION), 'treatment shows the pack section');
      assert.equal(packSectionOf(treated), packSectionOf(briefBaseline), 'pack section bytes identical vs no-env');
      const events = packEvents(main.root, 'session_brief');
      assert.equal(events.length, 1, 'treatment fires exactly one surfaced event');
      assert.equal(events[0].arm, 'treatment');
      assert.equal(events[0].experimentId, EXP_A);
      clearArm();
    });

    await checkAsync('(c) happy — treatment done_prepare output is byte-identical to no-env and fires the event', async () => {
      setArm('treatment');
      const treated = await prepare.done_prepare({ ...donePrepareArgs });
      assert.equal(treated, doneBaseline, 'treatment done_prepare output byte-identical vs no-env');
      const events = packEvents(main.root, 'done_prepare');
      assert.equal(events.length, 1, 'treatment fires exactly one surfaced event');
      assert.equal(events[0].arm, 'treatment');
      assert.equal(events[0].consumer, 'done_prepare');
      assert.equal(events[0].storyId, 'B-smoke');
      clearArm();
    });

    // ── (b) control: pack hidden + event still logged ─────────────────────────

    check('(b) happy — control session_brief hides the pack section and still logs the surfaced event', () => {
      setArm('control', EXP_B);
      const controlled = session.session_brief({});
      assert.ok(!controlled.includes(PACK_SECTION), 'control hides the pack section');
      const events = packEvents(main.root, 'session_brief').filter((e) => e.experimentId === EXP_B);
      assert.equal(events.length, 1, 'control fires exactly one surfaced event (lossless measurement)');
      assert.equal(events[0].arm, 'control');
      assert.match(String(events[0].packDigest), /^[0-9a-f]{64}$/, 'pack still computed on control');
      clearArm();
    });

    await checkAsync('(b) happy — control done_prepare omits ONLY the advisory memory block and logs the event', async () => {
      setArm('control', EXP_B);
      const controlled = await prepare.done_prepare({ ...donePrepareArgs });
      assert.ok(!controlled.includes(DONE_ADVISORY), 'control hides the advisory memory summary');
      assert.ok(!controlled.includes('memoryPackDigest: '), 'control omits memoryPackDigest');
      assert.equal(
        controlled,
        stripDoneAdvisoryBlock(doneBaseline),
        'control output equals the no-env baseline minus exactly the advisory memory block',
      );
      const events = packEvents(main.root, 'done_prepare').filter((e) => e.experimentId === EXP_B);
      assert.equal(events.length, 1, 'control fires exactly one surfaced event');
      assert.equal(events[0].arm, 'control');
      clearArm();
    });

    check('(b) happy — control story_create hides the pack advisory on stderr and still logs the event', () => {
      const controlRoot = mkRoot();
      seedMemory(controlRoot);
      const createControl = createStoryCreateHandlers(mkCtx(controlRoot));
      setArm('control', EXP_B);
      const { stderr } = captureStderr(() => createControl.story_create({
        name: 'arm-switch-intake-control',
        title: 'Surface advisory memory during story intake',
        description: 'Story intake should keep advisory runtime memory lossless while the render is hidden on the control arm.',
        type: 'feature',
        priority: 'medium',
        background: '## Trigger Event\nB-ab8d CHK-005 needs an intake fixture that exercises the arm-gated advisory pack during story creation on 2026-07-01.\n\n## Key Insights\nThe intake advisory must stay lossless for measurement while the render is hidden on the control arm; the pack is context only and never satisfies evidence requirements.\n\n## Solution Tradeoffs\nReuse the shared surfacing leaf instead of an intake-specific renderer so digest and line caps stay consistent with the other consumers.\n\n## Conversational Texture\nThe operator wants fewer repeated process mistakes without letting advisory memory masquerade as proof.',
        checklist: [{ title: 'Show advisory memory at intake', context: 'Arm switch smoke fixture item.' }],
        forceNew: true,
      }));
      assert.ok(!stderr.includes(PACK_SECTION), 'control story_create stderr omits the pack section');
      const events = packEvents(controlRoot, 'story_create');
      assert.equal(events.length, 1, 'control story_create fires exactly one surfaced event');
      assert.equal(events[0].arm, 'control');
      assert.equal(events[0].experimentId, EXP_B);
      clearArm();
    });

    check('(a)+(c) happy — no-env story_create prints the pack advisory on stderr with no event', () => {
      const plainRoot = mkRoot();
      seedMemory(plainRoot);
      const createPlain = createStoryCreateHandlers(mkCtx(plainRoot));
      clearArm();
      const { stderr } = captureStderr(() => createPlain.story_create({
        name: 'arm-switch-intake-plain',
        title: 'Surface advisory memory during story intake',
        description: 'Story intake should keep advisory runtime memory lossless while the render is hidden on the control arm.',
        type: 'feature',
        priority: 'medium',
        background: '## Trigger Event\nB-ab8d CHK-005 needs an intake fixture that exercises the arm-gated advisory pack during story creation on 2026-07-01.\n\n## Key Insights\nThe intake advisory must stay lossless for measurement while the render is hidden on the control arm; the pack is context only and never satisfies evidence requirements.\n\n## Solution Tradeoffs\nReuse the shared surfacing leaf instead of an intake-specific renderer so digest and line caps stay consistent with the other consumers.\n\n## Conversational Texture\nThe operator wants fewer repeated process mistakes without letting advisory memory masquerade as proof.',
        checklist: [{ title: 'Show advisory memory at intake', context: 'Arm switch smoke fixture item.' }],
        forceNew: true,
      }));
      assert.ok(stderr.includes(PACK_SECTION), 'no-env story_create stderr contains the pack section');
      assert.equal(packEvents(plainRoot, 'story_create').length, 0, 'no experiment: no surfaced event');
    });

    // ── (b adj 1)+(e) control-arm retrieval blocking at the CLI choke point ───

    await checkAsync('(b/e) adversarial — control dev_memory_start is REFUSED at the CLI with a retrieval_violation, no surfaced event', async () => {
      const root = mkRoot();
      seedMemory(root);
      const res = runCli(root, ['dev_memory_start', '{"agent":"arm-smoke"}'], {
        [EXPERIMENT_ID_ENV_VAR]: EXP_A,
        [EXPERIMENT_ARM_ENV_VAR]: 'control',
      });
      assert.notEqual(res.status, 0, 'control dev_memory_start exits nonzero');
      assert.match(res.stderr, /memory retrieval is disabled on the control arm/, 'refusal names the gate');
      assert.ok(res.stderr.includes(EXP_A), 'refusal names the experimentId');
      const violations = violationEvents(root);
      assert.equal(violations.length, 1, 'exactly one retrieval_violation recorded');
      assert.equal(violations[0].command, 'dev_memory_start');
      assert.equal(violations[0].experimentId, EXP_A);
      assert.equal(packEvents(root, 'dev_memory_start').length, 0, 'refused BEFORE render: no surfaced event');
    });

    await checkAsync('(e) adversarial — control recall + dev_memory_search blocked with violations; story_list still works', async () => {
      const root = mkRoot();
      seedMemory(root);
      const controlEnv = { [EXPERIMENT_ID_ENV_VAR]: EXP_A, [EXPERIMENT_ARM_ENV_VAR]: 'control' };

      const recallRes = runCli(root, ['recall', '{"query":"host-policy"}'], controlEnv);
      assert.notEqual(recallRes.status, 0, 'control recall exits nonzero');
      assert.match(recallRes.stderr, /memory retrieval is disabled on the control arm/);

      const searchRes = runCli(root, ['dev_memory_search', '{"query":"host-policy"}'], controlEnv);
      assert.notEqual(searchRes.status, 0, 'control dev_memory_search exits nonzero');
      assert.match(searchRes.stderr, /memory retrieval is disabled on the control arm/);

      const violations = violationEvents(root);
      assert.deepEqual(
        violations.map((v) => v.command).sort(),
        ['dev_memory_search', 'recall'],
        'both blocked attempts recorded as retrieval_violation',
      );
      assert.ok(violations.every((v) => v.experimentId === EXP_A), 'violations carry the experimentId');

      const listRes = runCli(root, ['story_list'], controlEnv);
      assert.equal(listRes.status, 0, `non-memory story_list works on control (stderr: ${listRes.stderr.slice(0, 200)})`);
      assert.equal(violationEvents(root).length, 2, 'story_list adds no violation');
    });

    await checkAsync('(e) happy — recall works normally on treatment and with no experiment env', async () => {
      const root = mkRoot();
      seedMemory(root);
      const treatRes = runCli(root, ['recall', '{"query":"host-policy"}'], {
        [EXPERIMENT_ID_ENV_VAR]: EXP_A,
        [EXPERIMENT_ARM_ENV_VAR]: 'treatment',
      });
      assert.equal(treatRes.status, 0, `treatment recall exits 0 (stderr: ${treatRes.stderr.slice(0, 200)})`);
      const plainRes = runCli(root, ['recall', '{"query":"host-policy"}']);
      assert.equal(plainRes.status, 0, `no-env recall exits 0 (stderr: ${plainRes.stderr.slice(0, 200)})`);
      assert.equal(violationEvents(root).length, 0, 'no retrieval_violation on treatment/no-env');
    });

    check('(e) adversarial — gate function: control throws for memory commands only; treatment/unknown pass', () => {
      const root = mkRoot();
      setArm('control');
      assert.throws(
        () => enforceExperimentArmRetrievalGate('recall', root),
        /memory retrieval is disabled on the control arm/,
        'control + recall throws',
      );
      assert.equal(violationEvents(root).length, 1, 'violation recorded before the throw');
      assert.doesNotThrow(() => enforceExperimentArmRetrievalGate('story_list', root), 'non-memory command passes');
      assert.doesNotThrow(() => enforceExperimentArmRetrievalGate('recall_unregistered_fake', root), 'unregistered name is not classified');
      setArm('treatment');
      assert.doesNotThrow(() => enforceExperimentArmRetrievalGate('recall', root), 'treatment passes');
      clearArm();
      assert.doesNotThrow(() => enforceExperimentArmRetrievalGate('recall', root), 'no experiment passes');
      assert.equal(violationEvents(root).length, 1, 'no extra violations from allowed paths');
    });

    // ── (d) partial / invalid env context ─────────────────────────────────────

    check('(d) edge — partial env (only experimentId) ignored with ONE warning naming the ignored var', () => {
      clearArm();
      process.env[EXPERIMENT_ID_ENV_VAR] = EXP_A;
      resetExperimentArmWarnLatch();
      const { result, warnings } = captureWarn(() => [resolveExperimentArm(), resolveExperimentArm()]);
      assert.equal(result[0], null, 'partial context resolves to null');
      assert.equal(result[1], null, 'still null on repeat');
      assert.equal(warnings.length, 1, 'once-latch: exactly one warning per process');
      assert.ok(warnings[0].includes(`ignoring ${EXPERIMENT_ID_ENV_VAR}`), `warning names the ignored var: ${warnings[0]}`);
      assert.ok(warnings[0].includes(`${EXPERIMENT_ARM_ENV_VAR} is missing`), 'warning names the missing var');
      clearArm();
    });

    check('(d) edge — partial env (only arm=control) neither hides the pack nor blocks retrieval', () => {
      clearArm();
      process.env[EXPERIMENT_ARM_ENV_VAR] = 'control';
      resetExperimentArmWarnLatch();
      const root = mkRoot();
      seedMemory(root);
      const { result, warnings } = captureWarn(() => {
        const render = shouldRenderRuntimeMemoryPack();
        const surfaced = surfaceRuntimeMemoryPack(root, {
          consumer: 'session_brief',
          buildPack: () => buildMemoryFreshnessPack({ projectRoot: root, query: 'host-policy', consumer: 'session_brief' }),
        });
        assert.doesNotThrow(() => enforceExperimentArmRetrievalGate('recall', root), 'partial context does not block');
        return { render, surfaced };
      });
      assert.equal(result.render, true, 'partial context renders as no-experiment');
      assert.equal(result.surfaced.fired, false, 'partial context fires no event');
      assert.equal(result.surfaced.experiment, null, 'partial context resolves to null');
      assert.equal(warnings.length, 1, 'exactly one warning');
      assert.ok(warnings[0].includes(`ignoring ${EXPERIMENT_ARM_ENV_VAR}`), `warning names the ignored var: ${warnings[0]}`);
      assert.equal(violationEvents(root).length, 0, 'no retrieval_violation under partial context');
      clearArm();
    });

    check('(d) edge — invalid arm value ignored with a warning naming control|treatment', () => {
      clearArm();
      setArm('treatmnt');
      resetExperimentArmWarnLatch();
      const { result, warnings } = captureWarn(() => resolveExperimentArm());
      assert.equal(result, null, 'invalid arm resolves to null');
      assert.equal(warnings.length, 1, 'exactly one warning');
      assert.ok(warnings[0].includes('control|treatment'), `warning names the accepted values: ${warnings[0]}`);
      clearArm();
    });

    // ── (f) catalog cross-check ───────────────────────────────────────────────

    check('(f) adversarial — every registered memory-family command carries the memoryRetrieval marker', () => {
      const names = MAIN_TOOLS.map((tool) => tool.name);
      const family = names.filter(matchesMemoryFamily);
      assert.ok(family.length >= 10, `memory families are non-vacuous (found ${family.length})`);
      for (const required of ['recall', 'dev_memory_start', 'dev_memory_capture', 'dev_memory_finish', 'learning_scan', 'memory_playbook_baseline_generate']) {
        assert.ok(family.includes(required), `family match includes ${required}`);
      }
      assert.deepEqual(missingMarkerNames(names), [], 'no memory-family command is missing the marker');
      for (const nonMemory of ['story_list', 'session_brief', 'story_create', 'done_prepare', 'validate']) {
        assert.equal(isMemoryRetrievalCommand(nonMemory), false, `${nonMemory} is not classified memoryRetrieval`);
      }
    });

    check('(f) adversarial — a deliberately unmarked memory-family name FAILS the same cross-check', () => {
      const poisoned = [...MAIN_TOOLS.map((tool) => tool.name), 'dev_memory_unmarked_fake'];
      assert.deepEqual(
        missingMarkerNames(poisoned),
        ['dev_memory_unmarked_fake'],
        'the cross-check detects an unmarked memory-family command (non-vacuous checker)',
      );
    });

    // ── (g) hash invariance across arms ───────────────────────────────────────

    check('(g) adversarial — resolveReviewPromptHash is byte-identical across control/treatment/no-env', () => {
      const prompt = 'REVIEW reviewer prompt: examine the diff for B-ab8d.';
      clearArm();
      const plain = resolveReviewPromptHash(prompt);
      setArm('control');
      const control = resolveReviewPromptHash(prompt);
      setArm('treatment');
      const treatment = resolveReviewPromptHash(prompt);
      clearArm();
      assert.equal(control, plain, 'control hash identical');
      assert.equal(treatment, plain, 'treatment hash identical');
      assert.match(plain, /^[0-9a-f]{64}$/, 'hash shape stable');
    });

    // ── (h) event dedup per (experimentId, consumer, storyId-or-global, roundKey)

    check('(h) edge — exactly one event per dedup key; each key component opens a new event', () => {
      const root = mkRoot();
      seedMemory(root);
      const buildPack = () => buildMemoryFreshnessPack({ projectRoot: root, query: 'host-policy', consumer: 'session_brief' });
      setArm('treatment');
      const first = surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(first.fired, true, 'first call fires');
      const repeat = surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(repeat.fired, false, 'same key deduped');
      assert.equal(packEvents(root).length, 1, 'one event per key');

      surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r2', buildPack });
      assert.equal(packEvents(root).length, 2, 'new roundKey -> new event');

      surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', roundKey: 'r1', buildPack });
      const globalEvents = packEvents(root).filter((e) => e.storyId === 'global');
      assert.equal(globalEvents.length, 1, 'missing storyId normalizes to global -> new event');

      surfaceRuntimeMemoryPack(root, { consumer: 'dev_memory_start', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(packEvents(root).length, 4, 'new consumer -> new event');

      setArm('treatment', EXP_B);
      surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(packEvents(root).length, 5, 'new experimentId -> new event');

      setArm('control', 'exp-b-ab8d-arm-switch-c');
      const controlFirst = surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(controlFirst.fired, true, 'control fires on first key use');
      assert.equal(controlFirst.shouldRender, false, 'control never renders');
      const controlRepeat = surfaceRuntimeMemoryPack(root, { consumer: 'session_brief', storyId: 'B-dedup', roundKey: 'r1', buildPack });
      assert.equal(controlRepeat.fired, false, 'control deduped on repeat');
      assert.equal(packEvents(root).length, 6, 'control adds exactly one event');
      clearArm();
    });

    // ── (i) eighth surface: host_dispatch text projection ─────────────────────

    check('(i) adversarial — host_dispatch projection: control hides ONLY the memory lines; treatment byte-identical to no-env', () => {
      const root = mkRoot();
      seedMemory(root);
      clearArm();
      const pack = buildMemoryFreshnessPack({
        projectRoot: root,
        query: 'host-policy runtime memory delivery',
        consumer: 'host_handoff',
        storyPhase: 'DEV',
      });
      assert.ok(runtimeMemoryTopHits(pack).ids.length > 0, 'fixture pack has top hits (non-vacuous)');
      const projection = {
        schemaVersion: 'lattice.host_dispatch.v1',
        status: 'planned',
        mode: 'supervised',
        storyId: 'B-smoke',
        host: 'claude-code',
        requestedHost: 'claude-cli',
        packId: 'pack-arm-smoke',
        packHash: 'hash-arm-smoke',
        overflowReady: true,
        authorityChanged: false,
        receiptVerified: false,
        productionDone: false,
        nextAction: 'review the pack before dispatch',
        warnings: [],
        admissibilitySummary: {
          admissibleProofRef: [],
          blocked: false,
          diagnostics: [],
          reasons: [],
        },
        limits: [],
        worktree: {
          branch: 'story/B-smoke',
          worktreePath: join(root, '.worktrees', 'B-smoke'),
          cleanupCommand: 'lattice handoff_worktree_cleanup',
          reviewCommand: 'lattice finding_list',
        },
        preflight: { memoryFreshnessPack: pack },
        prefetchManifest: {
          host: 'claude-code',
          targetStoryId: 'B-smoke',
          bundleFiles: [],
          verdict: 'no-block',
          winSignal: 'activeStorySummary/gapAnalyze/learningValidate',
          staleSignals: [],
        },
      } as unknown as HostDispatchProjection;

      const plain = renderHostDispatchProjectionText(projection);
      assert.ok(plain.includes(`memoryPackDigest: ${pack.packDigest}`), 'no-env prints memoryPackDigest');
      assert.ok(plain.includes(`memoryTopHitIds: ${runtimeMemoryTopHits(pack).ids.join(', ')}`), 'no-env prints topHitIds');
      assert.ok(plain.includes('memoryAuthority: non_authoritative'), 'no-env prints authority');
      assert.ok(plain.includes('memoryGateEvidence: false'), 'no-env prints gateEvidence');

      setArm('treatment');
      const treatment = renderHostDispatchProjectionText(projection);
      assert.equal(treatment, plain, 'treatment projection byte-identical to no-env');

      setArm('control');
      const control = renderHostDispatchProjectionText(projection);
      for (const marker of ['memoryPackDigest:', 'memoryTopHitIds:', 'memoryAuthority:', 'memoryGateEvidence:']) {
        assert.ok(!control.includes(marker), `control omits ${marker}`);
      }
      const plainMinusMemory = plain.split('\n').filter((line) => !MEMORY_PROJECTION_LINE.test(line)).join('\n');
      assert.equal(control, plainMinusMemory, 'control equals no-env minus exactly the four memory lines');
      clearArm();
    });

    // ── summary ───────────────────────────────────────────────────────────────

    console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
    if (passed !== total) {
      process.exitCode = 1;
      console.error('experience-pack-arm-switch-smoke: FAILED');
    } else {
      console.log('experience-pack-arm-switch-smoke: ALL PASS');
    }
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    for (const root of tmpRoots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
