#!/usr/bin/env node
/**
 * B-8387 CHK-004: smoke suite for Experience Layer Phase 2 — the staged Process
 * Playbook lifecycle (playbook_propose/diff/approve/reject).
 *
 * Coverage (named `check:` lines; sets exitCode=1 on any failure; prints
 * `smoke passed` + `TOTAL N | PASS N | FAIL N` at the very end):
 *   • LIFECYCLE: seed a finding -> playbook_propose (proposal carries lineage +
 *     proposalDigest) -> playbook_diff (renders; proposals/ unchanged) ->
 *     playbook_approve with the CORRECT expectedProposalDigest (candidate in
 *     playbooks.json, status=candidate, lineage carried, proposal deleted);
 *     playbook_reject on a fresh proposal removes it.
 *   • FAIL-CLOSED: approve with a WRONG/stale digest is rejected (no playbook
 *     written, proposal NOT cleared); approve with a MISSING digest rejected;
 *     approve a non-existent proposalId -> clear error; propose from a
 *     non-existent finding -> clear error.
 *   • GUARDRAIL: across the full lifecycle, findings.json is byte-identical
 *     before/after (never auto-files a finding); handlers/playbook.ts statically
 *     contains no finding_add / advisory reference.
 *   • STATUS/LINEAGE/DIGEST: candidate is `candidate` (NOT active); lineage
 *     fields present + matching the source finding; proposalDigest stable across
 *     re-read and excludes the digest field itself.
 *   • IMPORT-FENCE (non-vacuous): learning-store.ts imports nothing outward
 *     except ./digest.js (+ node: + ./experience-layer-types.js); handlers/
 *     playbook.ts imports nothing outward except the learning-store, the types,
 *     and the handler context read port.
 *
 * Runs entirely in an OS temp dir; saves/restores process.env + cwd; never
 * pollutes the repo.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { resetConfigCache, loadConfig } from '../core/config.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';
import {
  computePlaybookDigest,
  computePlaybookProposalDigest,
  isPositiveHelpedPlaybookOutcome,
  readPlaybookOutcomeEvents,
  readPlaybooks,
  readProposal,
  resolvePlaybookOutcomesPath,
  resolveProposalsDir,
  resolvePlaybooksPath,
  writeProposal,
} from '../core/learning-store.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import type { HandlerContext } from '../handlers/context.js';
import type { Finding, StoryInfo } from '../core/types.js';
import type { Playbook, PlaybookProposal } from '../core/experience-layer-types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const REPO_ROOT = repoRoot();
const MAIN_DIR = join(REPO_ROOT, 'packages', 'main');

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

/** Async-aware variant of `check` (awaits the body so async assertions count). */
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

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'b8387-playbook-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function newStory(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-8387 playbook smoke story',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: PINNED_NOW,
    startedAt: PINNED_NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: PINNED_NOW }],
  };
}

/** Build a HandlerContext bound to a hermetic temp project root. */
function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, config.scanRoot), log: () => {} };
  return { ctx, store };
}

/** Seed one story + one resolved finding (with lineage-able fields). */
function seed(store: StoryStore, storyId: string, finding: Finding): void {
  store.writeStory(storyId, newStory(storyId));
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings: [finding] });
}

function sampleFinding(storyId: string): Finding {
  return {
    id: `${storyId}:F-001`,
    desc: 'auth token comparison used == enabling timing-side-channel bypass in handler',
    severity: 'high',
    category: 'adversarial',
    status: 'resolved',
    createdAt: PINNED_NOW,
    reviewRound: 'R-1',
    files: ['src/handlers/auth.ts', 'src/core/token.ts'],
    signatureTag: 'auth-bypass',
  };
}

function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  const bare = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]);
  return out;
}

function findingsRaw(store: StoryStore, storyId: string): string {
  return JSON.stringify(store.readFindings(storyId));
}

function proposalsSnapshot(root: string): string {
  const dir = resolveProposalsDir(root);
  if (!existsSync(dir)) return '<no-dir>';
  const files = readdirSync(dir).sort();
  return files.map((f) => `${f}::${readFileSync(join(dir, f), 'utf-8')}`).join('\n');
}

function approveCandidate(root: string, h: ReturnType<typeof createPlaybookHandlers>, finding: Finding): Playbook {
  const pid = h.playbook_propose({ finding: finding.id }).match(/proposal (\S+) staged/)![1];
  const digest = readProposal(root, pid)!.proposalDigest;
  h.playbook_approve({ proposalId: pid, expectedProposalDigest: digest });
  const playbook = readPlaybooks(root).find((p) => p.id === pid);
  assert.ok(playbook, 'candidate playbook exists after approve');
  return playbook!;
}

type OutcomeSmokeArgs = {
  storyId: string;
  playbookId: string;
  exposureMode: string;
  consumer: string;
  context: Record<string, unknown>;
  outcome: Record<string, unknown>;
  bindings: Record<string, unknown>;
  observedAt: string;
  idempotencyKey: string;
  [key: string]: unknown;
};

function outcomeArgs(
  storyId: string,
  playbookId: string,
  overrides: Partial<OutcomeSmokeArgs> = {},
): OutcomeSmokeArgs {
  return {
    storyId,
    playbookId,
    exposureMode: 'candidate-inspection',
    consumer: 'reviewer',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'chore',
      fileKinds: ['ts'],
      triggerClasses: ['auth-bypass'],
      host: 'Codex CLI',
    },
    outcome: {
      verdict: 'helped',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
      note: 'explicit reviewer outcome',
    },
    bindings: {},
    observedAt: PINNED_NOW,
    idempotencyKey: `${storyId}:${playbookId}:smoke`,
    ...overrides,
  };
}

async function run(): Promise<void> {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const tmpRoots: string[] = [];
  delete process.env.LATTICE_AGENT;

  try {
    // ─── LIFECYCLE: propose -> diff -> approve(correct digest) -> candidate ──────
    check('lifecycle: propose stages a proposal with lineage + proposalDigest', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-life'; const f = sampleFinding(storyId); seed(store, storyId, f);

      const msg = h.playbook_propose({ finding: f.id });
      const pid = msg.match(/proposal (\S+) staged/)![1];
      assert.match(msg, /proposalDigest: [0-9a-f]{64}/, 'prints a sha256 digest');

      const proposal = readProposal(root, pid)!;
      assert.ok(proposal, 'proposal file written');
      assert.equal(proposal.status, 'proposed');
      assert.equal(proposal.lineage.sourceStoryId, storyId, 'lineage.sourceStoryId');
      assert.equal(proposal.lineage.sourceFindingId, f.id, 'lineage.sourceFindingId');
      assert.equal(proposal.lineage.sourceSignature, 'auth-bypass', 'lineage.sourceSignature');
      assert.ok(proposal.proposalDigest.length === 64, 'proposalDigest is a sha256 hex');
    });

    check('lifecycle: diff renders the candidate and does NOT mutate proposals/', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-diff'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];

      const before = proposalsSnapshot(root);
      const out1 = h.playbook_diff({ proposalId: pid });
      const out2 = h.playbook_diff({ proposalId: pid });
      const after = proposalsSnapshot(root);

      assert.match(out1, /status: candidate \(active is NEVER auto-set\)/, 'diff shows candidate status');
      assert.match(out1, /lineage: story=B-diff/, 'diff shows lineage');
      assert.equal(out1, out2, 'diff is deterministic');
      assert.equal(before, after, 'diff did not mutate proposals/');
      assert.equal(readPlaybooks(root).length, 0, 'diff wrote no playbook');
    });

    check('lifecycle: approve with CORRECT digest -> candidate, lineage carried, proposal deleted', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-appr'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      const digest = readProposal(root, pid)!.proposalDigest;

      const msg = h.playbook_approve({ proposalId: pid, expectedProposalDigest: digest });
      assert.match(msg, /approved as candidate/);

      const playbooks = readPlaybooks(root);
      assert.equal(playbooks.length, 1, 'exactly one candidate written');
      const pb = playbooks[0];
      assert.equal(pb.status, 'candidate', 'status=candidate (NOT active)');
      assert.notEqual(pb.status as string, 'active', 'never auto-active');
      assert.equal(pb.lineage.sourceStoryId, storyId);
      assert.equal(pb.lineage.sourceFindingId, f.id);
      assert.equal(pb.lineage.sourceSignature, 'auth-bypass');
      assert.deepEqual(pb.usage, { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 }, 'usage zeroed');
      assert.equal(readProposal(root, pid), null, 'proposal cleared after approve');
    });

    check('lifecycle: reject removes a fresh proposal', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-rej'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      assert.ok(readProposal(root, pid), 'proposal exists before reject');
      const msg = h.playbook_reject({ proposalId: pid });
      assert.match(msg, /rejected and removed/);
      assert.equal(readProposal(root, pid), null, 'proposal removed');
      assert.equal(readPlaybooks(root).length, 0, 'reject wrote no playbook');
    });

    // ─── FAIL-CLOSED: stale / missing digest, missing proposal/finding ──────────
    check('fail-closed: approve with a WRONG digest is rejected; no playbook; proposal NOT cleared', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-stale'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];

      assert.throws(
        () => h.playbook_approve({ proposalId: pid, expectedProposalDigest: 'deadbeef'.repeat(8) }),
        /expectedProposalDigest is stale/,
        'stale digest fails closed',
      );
      assert.equal(readPlaybooks(root).length, 0, 'no candidate written on stale digest');
      assert.ok(readProposal(root, pid), 'proposal NOT cleared on stale digest');
    });

    check('fail-closed: approve with a MISSING digest is rejected', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-nodig'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      assert.throws(
        () => h.playbook_approve({ proposalId: pid } as { proposalId: string }),
        /requires --expectedProposalDigest/,
        'missing digest fails closed',
      );
      // empty-string digest is likewise rejected (not coerced to "match").
      assert.throws(
        () => h.playbook_approve({ proposalId: pid, expectedProposalDigest: '   ' }),
        /requires --expectedProposalDigest/,
        'whitespace digest fails closed',
      );
      assert.equal(readPlaybooks(root).length, 0, 'no candidate written');
      assert.ok(readProposal(root, pid), 'proposal NOT cleared');
    });

    check('fail-closed: approve / diff / reject on a non-existent proposalId -> clear error', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      assert.throws(() => h.playbook_approve({ proposalId: 'PBP-999', expectedProposalDigest: 'x'.repeat(64) }), /proposal not found: PBP-999/);
      assert.throws(() => h.playbook_diff({ proposalId: 'PBP-999' }), /proposal not found: PBP-999/);
      assert.throws(() => h.playbook_reject({ proposalId: 'PBP-999' }), /proposal not found: PBP-999/);
      assert.equal(readPlaybooks(root).length, 0, 'no side effects');
    });

    check('fail-closed: propose from a non-existent finding -> clear error, no proposal', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-nofind'; seed(store, storyId, sampleFinding(storyId));
      assert.throws(
        () => h.playbook_propose({ finding: `${storyId}:F-404` }),
        /finding not found/,
        'missing finding rejected',
      );
      assert.equal(existsSync(resolveProposalsDir(root)) ? readdirSync(resolveProposalsDir(root)).length : 0, 0, 'no proposal file created');
    });

    // ─── GUARDRAIL: full lifecycle never auto-files a finding ────────────────────
    check('guardrail: full propose->diff->approve->reject leaves findings.json byte-identical', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-guard'; const f = sampleFinding(storyId); seed(store, storyId, f);

      const before = findingsRaw(store, storyId);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      h.playbook_diff({ proposalId: pid });
      const digest = readProposal(root, pid)!.proposalDigest;
      h.playbook_approve({ proposalId: pid, expectedProposalDigest: digest });
      // a second propose+reject round to exercise reject too
      const pid2 = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      h.playbook_reject({ proposalId: pid2 });
      const after = findingsRaw(store, storyId);

      assert.equal(before, after, 'findings.json byte-identical across the full lifecycle (never auto-files a finding)');
    });

    check('guardrail (static): handlers/playbook.ts references no finding writer / advisory module / gate', () => {
      const src = readFileSync(join(MAIN_DIR, 'src', 'handlers', 'playbook.ts'), 'utf-8');
      assert.ok(!/finding_add/.test(src), 'playbook.ts must not reference finding_add');
      assert.ok(!/from ['"][^'"]*advisory[^'"]*['"]/.test(src), 'playbook.ts must not import advisory modules');
      assert.ok(!/from ['"][^'"]*gate[^'"]*['"]/.test(src), 'playbook.ts must not import gate modules');
      assert.ok(!/writeFindings/.test(src), 'playbook.ts must not write findings');
    });

    // ─── DIGEST: stable across re-read + excludes the digest field ───────────────
    check('digest: proposalDigest stable across re-read; excludes the proposalDigest field', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-dig'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];

      const reread = readProposal(root, pid)!;
      const recomputed = computePlaybookProposalDigest(reread);
      assert.equal(reread.proposalDigest, recomputed, 'stored digest matches recomputation over re-read');

      // Setting the digest field to a different value must NOT change the computed
      // digest — proving the digest domain excludes the field itself.
      const tampered: PlaybookProposal = { ...reread, proposalDigest: 'zzzz' };
      assert.equal(computePlaybookProposalDigest(tampered), recomputed, 'digest excludes its own field');
    });

    // ─── IMPORT-FENCE (non-vacuous) ─────────────────────────────────────────────
    check('import-fence: learning-store.ts imports only node:, ./digest.js, ./experience-layer-types.js', () => {
      const src = readFileSync(join(MAIN_DIR, 'src', 'core', 'learning-store.ts'), 'utf-8');
      const specs = importSpecifiers(src);
      assert.ok(specs.length > 0, 'learning-store.ts has imports');
      const allowed = new Set(['./digest.js', './experience-layer-types.js']);
      const foreign = specs.filter((s) => !s.startsWith('node:') && !allowed.has(s));
      assert.deepEqual(foreign, [], `learning-store.ts must not import outward beyond ./digest.js + ./experience-layer-types.js; found: ${foreign.join(', ')}`);
      assert.ok(specs.includes('./digest.js'), 'learning-store.ts imports ./digest.js');
    });

    check('import-fence: handlers/playbook.ts imports only learning-store, types, and the context read port', () => {
      const src = readFileSync(join(MAIN_DIR, 'src', 'handlers', 'playbook.ts'), 'utf-8');
      const specs = importSpecifiers(src);
      assert.ok(specs.length > 0, 'playbook.ts has imports');
      const allowed = new Set([
        '../core/experience-layer-types.js',
        '../core/learning-store.js',
        '../core/main-write-lock.js',
        '../core/types.js',
        './context.js',
      ]);
      const foreign = specs.filter((s) => !s.startsWith('node:') && !allowed.has(s));
      assert.deepEqual(foreign, [], `playbook.ts must not import outward beyond the allowed set; found: ${foreign.join(', ')}`);
      // load-bearing: it must NOT import the finding handler, advisory, or any gate.
      assert.ok(!specs.some((s) => /finding\.js$|advisory|gate/i.test(s)), 'playbook.ts imports no finding handler / advisory / gate');
    });

    check('import-fence: the static scan is non-vacuous (catches a planted foreign import)', () => {
      const real = readFileSync(join(MAIN_DIR, 'src', 'handlers', 'playbook.ts'), 'utf-8');
      const planted = `import { finding_add } from './finding.js';\n${real}`;
      const specs = importSpecifiers(planted);
      const allowed = new Set([
        '../core/experience-layer-types.js',
        '../core/learning-store.js',
        '../core/main-write-lock.js',
        '../core/types.js',
        './context.js',
      ]);
      const foreign = specs.filter((s) => !s.startsWith('node:') && !allowed.has(s));
      assert.deepEqual(foreign, ['./finding.js'], 'the scanner must detect a planted foreign import');
    });

    // ─── PERSISTENCE LOCATION: everything lives under .lattice/learning/ ─────────
    check('persistence: proposals + playbooks live only under .lattice/learning/', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-loc'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      assert.ok(existsSync(join(resolveProposalsDir(root), `${pid}.json`)), 'proposal under .lattice/learning/proposals/');
      const digest = readProposal(root, pid)!.proposalDigest;
      h.playbook_approve({ proposalId: pid, expectedProposalDigest: digest });
      assert.ok(existsSync(resolvePlaybooksPath(root)), 'playbooks.json under .lattice/learning/');
      assert.ok(resolvePlaybooksPath(root).includes(join('.lattice', 'learning')), 'playbooks path is under .lattice/learning/');
    });

    // ─── B-dddd M0-M2: explicit outcome ledger, no promotion evaluator ─────────
    check('outcome: playbook_outcome_record explicitly appends a non-authoritative ledger row', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-out'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pb = approveCandidate(root, h, f);
      const beforeDigest = computePlaybookDigest(pb);

      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'no outcome exists before explicit record');
      const msg = h.playbook_outcome_record(outcomeArgs(storyId, pb.id));
      assert.match(msg, /Playbook outcome .* recorded/);
      assert.match(msg, /authority: non_authoritative/);
      assert.match(msg, /gateEvidence: false/);
      assert.ok(existsSync(resolvePlaybookOutcomesPath(root)), 'outcome ledger is created only by the explicit command');

      const events = readPlaybookOutcomeEvents(root);
      assert.equal(events.length, 1, 'one event appended');
      const event = events[0];
      assert.equal(event.authority, 'non_authoritative');
      assert.equal(event.gateEvidence, false);
      assert.equal(event.playbookStatusAtObservation, 'candidate');
      assert.equal(event.exposureMode, 'candidate-inspection');
      assert.equal(event.outcome.verdict, 'helped');
      assert.equal(isPositiveHelpedPlaybookOutcome(event), true, 'explicit helped exposure is the only positive helped sample');
      assert.equal(computePlaybookDigest(readPlaybooks(root)[0]), beforeDigest, 'recording outcome did not mutate the candidate playbook');
    });

    check('outcome: ordinary story/DONE completion alone is not recorded as helped', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-doneonly'; const f = sampleFinding(storyId); seed(store, storyId, f);
      approveCandidate(root, h, f);
      store.writeStory(storyId, { ...newStory(storyId), phase: 'DONE', endedAt: PINNED_NOW });

      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'DONE metadata alone writes no outcome row');
      assert.equal(existsSync(resolvePlaybookOutcomesPath(root)), false, 'no outcome ledger file is created by DONE completion alone');
    });

    check('outcome: helped requires concrete exposure and structured verdict source', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-helpguard'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pb = approveCandidate(root, h, f);
      const base = outcomeArgs(storyId, pb.id);

      assert.throws(
        () => h.playbook_outcome_record({ ...base, exposureMode: 'none' }),
        /helped outcomes require exposureMode other than none/,
        'helped with exposureMode=none is rejected',
      );
      assert.throws(
        () => h.playbook_outcome_record({ ...base, outcome: { ...base.outcome, verdictSource: 'free form prose source' } }),
        /verdictSource must be a structured non-empty source token/,
        'helped with prose verdictSource is rejected',
      );
      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'rejected helped rows are not appended');
    });

    check('outcome: neutral/unknown are observability only, not decisive positive helped samples', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-neutral'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pb = approveCandidate(root, h, f);
      const base = outcomeArgs(storyId, pb.id);

      h.playbook_outcome_record({
        ...base,
        exposureMode: 'none',
        consumer: 'done_closure',
        idempotencyKey: `${storyId}:${pb.id}:neutral`,
        outcome: {
          ...base.outcome,
          verdict: 'neutral',
          verdictSource: 'done-settlement',
          preventedRepeatFinding: false,
        },
      });
      h.playbook_outcome_record({
        ...base,
        exposureMode: 'none',
        consumer: 'playbook_runtime_health',
        idempotencyKey: `${storyId}:${pb.id}:unknown`,
        outcome: {
          ...base.outcome,
          verdict: 'unknown',
          verdictSource: 'health-scan',
          preventedRepeatFinding: false,
        },
      });

      const events = readPlaybookOutcomeEvents(root);
      assert.deepEqual(events.map((event) => event.outcome.verdict), ['neutral', 'unknown']);
      assert.equal(events.filter(isPositiveHelpedPlaybookOutcome).length, 0, 'neutral/unknown do not count as helped samples');
    });

    check('outcome: candidate status remains candidate; no activation, rejection, or runtime surfacing', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-candstay'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pb = approveCandidate(root, h, f);
      const beforeDigest = computePlaybookDigest(pb);

      h.playbook_outcome_record(outcomeArgs(storyId, pb.id, { idempotencyKey: `${storyId}:${pb.id}:stay` }));

      const playbooks = readPlaybooks(root);
      assert.equal(playbooks.length, 1, 'outcome recording did not add/delete playbooks');
      assert.equal(playbooks[0].status, 'candidate', 'candidate remains candidate');
      assert.notEqual(playbooks[0].status as string, 'active', 'outcome recording does not activate');
      assert.equal(computePlaybookDigest(playbooks[0]), beforeDigest, 'candidate row is byte-domain identical after outcome');
      assert.equal(readPlaybookOutcomeEvents(root)[0].playbookStatusAtObservation, 'candidate', 'event snapshots status only');
    });

    check('outcome: malformed authority/gate claims and inherited outcome fields reject fail-closed', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-badout'; const f = sampleFinding(storyId); seed(store, storyId, f);
      const pb = approveCandidate(root, h, f);
      const base = outcomeArgs(storyId, pb.id);

      assert.throws(() => h.playbook_outcome_record({ ...base, gateEvidence: true }), /gateEvidence must be false/);
      assert.throws(() => h.playbook_outcome_record({ ...base, authority: 'authoritative' }), /authority must be non_authoritative/);
      assert.throws(() => h.playbook_outcome_record({ ...base, releaseReady: true } as Parameters<typeof h.playbook_outcome_record>[0]), /refuses authority\/proof claim field/);

      const inheritedOutcome = Object.create({
        verdict: 'helped',
        verdictSource: 'operator',
        causedNoise: false,
        causedWrongClaim: false,
        preventedRepeatFinding: true,
      });
      assert.throws(
        () => h.playbook_outcome_record({ ...base, outcome: inheritedOutcome }),
        /requires own field verdict/,
        'prototype/inherited outcome fields cannot masquerade as own structured fields',
      );
      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'rejected malformed rows are not appended');
    });

    check('outcome: command metadata/process facts classify it as audit-only non-gate metadata', () => {
      const policy = COMMAND_POLICIES.playbook_outcome_record;
      assert.equal(policy.status, 'supported');
      assert.equal(policy.ownershipClass, 'mainSharedMutating');
      assert.equal(policy.destructiveRisk, 'metadata-write');
      assert.notEqual((policy as { gateEvidence?: boolean }).gateEvidence, true, 'command policy is not gate evidence');
      assert.match(policy.reason, /audit-only/);
      assert.match(policy.reason, /gateEvidence=false/);

      const fact = PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_outcome_record');
      assert.ok(fact, 'PROCESS_FACT_LEVELS includes playbook_outcome_record');
      assert.equal(fact!.level, 'L2');
      assert.equal(fact!.category, 'experience-layer');
      assert.equal((fact as { gateConsumer?: string }).gateConsumer, undefined, 'no lifecycle gate consumer');
      assert.match(fact!.rationale, /audit-only/);
      assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'playbook_outcome_record'), 'MAIN_TOOLS exposes playbook_outcome_record');
    });

    check('outcome: no Codex/Claude-specific namespace introduced', () => {
      const names = MAIN_TOOLS.map((tool) => tool.name);
      assert.deepEqual(names.filter((name) => name.endsWith('playbook_outcome_record')), ['playbook_outcome_record']);
      assert.equal(names.includes('codex_playbook_outcome_record'), false, 'no codex-specific outcome command');
      assert.equal(names.includes('claude_playbook_outcome_record'), false, 'no claude-specific outcome command');
      assert.equal(names.includes('playbook_codex_outcome_record'), false, 'no playbook codex alias');
      assert.equal(names.includes('playbook_claude_outcome_record'), false, 'no playbook claude alias');
    });

    // ─── F-003: minted ids are globally unique across propose->approve cycles ─────
    check('CHK-001:edge:2 unique ids across cycles (no duplicate after approve empties proposals/)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-cycle'; const f = sampleFinding(storyId); seed(store, storyId, f);

      // Cycle 1: propose -> approve (this clears the proposals/ directory).
      const pid1 = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      const digest1 = readProposal(root, pid1)!.proposalDigest;
      h.playbook_approve({ proposalId: pid1, expectedProposalDigest: digest1 });
      assert.equal(readProposal(root, pid1), null, 'cycle-1 proposal cleared (proposals/ now empty)');

      // Cycle 2: a fresh propose must NOT reuse pid1 even though proposals/ is empty.
      const pid2 = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      assert.notEqual(pid2, pid1, 'second propose mints a DISTINCT id (id reuse bug fixed)');
      const digest2 = readProposal(root, pid2)!.proposalDigest;
      h.playbook_approve({ proposalId: pid2, expectedProposalDigest: digest2 });

      const playbooks = readPlaybooks(root);
      assert.equal(playbooks.length, 2, 'two candidates written across two cycles');
      const ids = playbooks.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate playbook id in playbooks.json');
      assert.ok(ids.includes(pid1) && ids.includes(pid2), 'both distinct ids persisted');
    });

    // ─── F-001: a path-traversal proposalId is rejected by the safeProposalId guard ─
    check('CHK-001:edge:1 path-traversal proposalId rejected (no file written/read outside proposals/)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-trav'; const f = sampleFinding(storyId); seed(store, storyId, f);
      // A real proposal exists so the proposals/ directory is present (read path is live).
      const realPid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];

      const hostile = ['../../etc/x', 'a/b', '..', '.', 'a\\b', 'x/../../y', 'a\0b'];
      for (const id of hostile) {
        // read path (diff / approve / reject) must throw on the traversal id …
        assert.throws(() => h.playbook_diff({ proposalId: id }), /illegal path characters|non-empty/, `diff rejects "${id}"`);
        assert.throws(() => h.playbook_approve({ proposalId: id, expectedProposalDigest: 'x'.repeat(64) }), /illegal path characters|non-empty/, `approve rejects "${id}"`);
        assert.throws(() => h.playbook_reject({ proposalId: id }), /illegal path characters|non-empty/, `reject rejects "${id}"`);
        // raw write path must throw too (guard fires before any fs write) …
        assert.throws(
          () => writeProposal(root, { ...readProposal(root, realPid)!, id }),
          /illegal path characters|non-empty/,
          `writeProposal rejects "${id}"`,
        );
      }

      // Nothing escaped: only the single legitimate proposal file exists, and the
      // approved-playbooks store was never created by a hostile id.
      const dir = resolveProposalsDir(root);
      const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
      assert.deepEqual(files.sort(), [`${realPid}.json`], 'no traversal file written under proposals/');
      assert.equal(readPlaybooks(root).length, 0, 'no playbook written via a hostile id');
    });

    // ─── F-002: concurrent proposal writes are atomic (temp+rename) ──────────────
    await checkAsync('CHK-001:adversarial:1 concurrent proposal writes (atomic temp+rename; reads complete-or-absent)', async () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createPlaybookHandlers(ctx);
      const storyId = 'B-conc'; const f = sampleFinding(storyId); seed(store, storyId, f);
      // Stamp a base proposal to clone the shape from.
      const basePid = h.playbook_propose({ finding: f.id }).match(/proposal (\S+) staged/)![1];
      const base = readProposal(root, basePid)!;

      const N = 24;
      const ids = Array.from({ length: N }, (_, i) => `PBP-${String(i + 100).padStart(3, '0')}`);
      const mkProposal = (id: string): PlaybookProposal => {
        const p: PlaybookProposal = { ...base, id, title: `concurrent ${id}` };
        p.proposalDigest = computePlaybookProposalDigest(p);
        return p;
      };

      // Fire all writes concurrently, interleaved with reads of the same set. The
      // atomic temp+rename contract means each read sees either a fully-written,
      // valid proposal or nothing at all — never a truncated/half-written file.
      const ops: Array<Promise<void>> = [];
      for (const id of ids) {
        ops.push(Promise.resolve().then(() => { writeProposal(root, mkProposal(id)); }));
        ops.push(Promise.resolve().then(() => {
          const got = readProposal(root, id); // complete-or-absent
          if (got !== null) {
            assert.equal(got.id, id, 'interleaved read sees a complete (non-truncated) proposal');
            assert.equal(got.proposalDigest, computePlaybookProposalDigest(got), 'interleaved read is digest-consistent (atomic)');
          }
        }));
      }
      await Promise.all(ops);

      // After all writes settle, every proposal must be present, valid, and atomic.
      for (const id of ids) {
        const got = readProposal(root, id);
        assert.ok(got, `proposal ${id} present after concurrent writes`);
        assert.equal(got!.id, id, 'final read id matches');
        assert.equal(got!.proposalDigest, computePlaybookProposalDigest(got!), `proposal ${id} digest-consistent (atomic, never half-written)`);
      }
      // No leftover temp files from the atomic writer.
      const leftoverTmp = readdirSync(resolveProposalsDir(root)).filter((n) => n.includes('.tmp-'));
      assert.deepEqual(leftoverTmp, [], 'no leftover .tmp- files from the atomic writer');
    });
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    for (const r of tmpRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }

  // ─── NO REGRESSION: prior Phase-1/2 + decision-doc smokes still pass ──────────
  const regressionSmokes: Array<{ label: string; rel: string }> = [
    { label: 'experience-layer-finding-signals', rel: 'dist/tasks/experience-layer-finding-signals-smoke.js' },
    { label: 'experience-layer-finding-enums', rel: 'dist/tasks/experience-layer-finding-enums-smoke.js' },
    { label: 'experience-layer-hint-injection', rel: 'dist/tasks/experience-layer-hint-injection-smoke.js' },
    { label: 'experience-layer-digest-extract', rel: 'dist/tasks/experience-layer-digest-extract-smoke.js' },
    { label: 'decision-doc-promotion', rel: 'dist/tasks/decision-doc-promotion-smoke.js' },
  ];
  for (const { label, rel } of regressionSmokes) {
    check(`no-regression: ${label} smoke still prints "smoke passed"`, () => {
      const out = execFileSync('node', [rel], { cwd: MAIN_DIR, encoding: 'utf-8' });
      assert.match(out, /smoke passed/, `${label} smoke prints "smoke passed"`);
    });
  }

  console.log(`\nTOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (process.exitCode === 1) {
    console.error('smoke FAILED');
    return;
  }
  console.log('smoke passed');
}

run().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
