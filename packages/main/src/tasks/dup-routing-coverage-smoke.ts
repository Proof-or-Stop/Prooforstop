#!/usr/bin/env node
/**
 * Run 17 (abs-stepped-slices, B-ab28) Q3 + Q4 (run17-cost-analysis.md §3a, §3c).
 *
 * Q3 — review_round_prepare demanded an owner fullScanReason twice in a Go
 * repo with no requirements corpus:
 *   R1  understanding.touchpoints are free text ("ast/ast.go IndexExpression
 *       and String", "a_test.go, b_test.go"). Every touchpoint became an
 *       exact-path protected source, realpath failed, and each was recorded as
 *       missing_protected_source, which disabled the automatic no-corpus full
 *       scan. Contract: only a touchpoint whose leading path token resolves to
 *       a real file in the project is a protected source; prose and missing
 *       paths are ranking seeds only, never `missing`.
 *   R2  after the repairs the persisted route was stale. Its reason was the
 *       owner's (R1 needed it), so the reroute demanded the owner again.
 *       Contract: a stale full-scan route whose escalation is only the missing
 *       corpus plus free-text touchpoints reroutes with the plain command (the
 *       framework re-derives the automatic reason); a stale owner-reasoned route
 *       with a real escalation reason still needs the owner.
 *
 * Q4 — the PLAN scope-plan reviewer raised `scope_gap` for benchmark workflow
 * sentences Proof-or-Stop already satisfies ("work in a new branch from main",
 * "commit everything when done") and for a constraint already in the INIT
 * scope ("The INIT scope boundary is not an input of this verdict"), forcing a
 * second reviewer run. Contract: the scope-plan dispatch prompt lists the
 * workflow obligations Proof-or-Stop guarantees and the INIT scope constraints
 * (scopeBoundary.excluded, understanding.constraints) as already covered, and
 * keeps every other request row strict.
 *
 * Usage: node packages/main/dist/tasks/dup-routing-coverage-smoke.js
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { buildScopeBoundary } from '../core/scope-anti-expansion.js';
import { writeStoryRequest } from '../core/story-request.js';
import { currentStoryRoutingInput } from '../handlers/candidate-spec-routing.js';
import { managedReviewCandidateReadiness } from '../handlers/reviewer-batch.js';
import { createMainRegistry } from '../registry.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const STORY_DIR = '.proof-or-stop/story/actives';
const failures: string[] = [];
function check(ok: boolean, message: string, detail = ''): boolean {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}${ok || !detail ? '' : `\n         ${detail.slice(0, 1500).replace(/\n/g, '\n         ')}`}`);
  if (!ok) failures.push(message);
  return ok;
}
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** Run 17's touchpoints, transposed onto the fixture's files. */
const TOUCHPOINTS = [
  'strs/strs.go Upper and String',
  'strs/strs_test.go, strs/strs.go',
  '`strs/strs.go:3`',
  'ast/ast.go IndexExpression and String',
  'the Upper helper and its callers',
];

function fixture(phase: 'REVIEW' | 'PLAN', storyId: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dup-routing-coverage-${phase.toLowerCase()}-`)));
  write(root, 'go.mod', 'module example.com/strs\n\ngo 1.22\n');
  write(root, 'strs/strs.go', 'package strs\n\nfunc Upper(s string) string { return s }\n');
  write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestUpper(t *testing.T) { _ = Upper("a") }\n');
  write(root, '.gitignore', '');
  write(root, 'proof-or-stop.config.json', JSON.stringify({ artifactContract: 'none', storyDir: STORY_DIR, workflow: { profile: 'balanced' } }));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Owner']);
  git(['config', 'user.email', 'owner@noreply.local']);
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  resetConfigCache();
  const store = new StoryStore(root);
  const now = '2026-10-03T06:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'dup-routing', title: 'Upper string helper', description: 'Implement strs.Upper',
    type: 'feature', phase, priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
    ...(phase === 'REVIEW' ? { currentReviewRound: now } : {}),
    events: [{ phase, action: 'advance', timestamp: now }],
  } as StoryInfo;
  store.writeStory(storyId, story);
  const checklist: ChecklistData = { items: [{
    id: 'CHK-001', title: 'Upper upper-cases ASCII', context: 'fixture', userSees: 'strs.Upper("ab") == "AB"',
    status: phase === 'REVIEW' ? 'done' : 'pending', files: ['strs/strs.go'], startTime: null, endTime: null,
  } as never] };
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Upper-case strings', outcome: 'strs.Upper("ab") == "AB"', facts: ['strs.Upper returns its input'],
    constraints: ['Do not change the exported signature of strs.Upper', 'Keep the existing error format for an empty input'], unknowns: [], touchpoints: TOUCHPOINTS, timestamp: now,
  });
  git(['add', '-A']);
  git(['commit', '-qm', 'proof-or-stop: story metadata']);
  return { root, store, storyId, git };
}

function cli(root: string, command: string, payload: Record<string, unknown>): { status: number; out: string; stdout: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROOF_OR_STOP_AGENT: 'main',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'dup-routing-coverage-owner',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
  };
  delete env.PROOF_OR_STOP_SESSION_ID;
  delete env.LATTICE_SESSION_ID;
  const run = spawnSync(process.execPath, [CLI, '--root', root, command, JSON.stringify(payload)], {
    cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
  });
  return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, stdout: run.stdout ?? '' };
}

function q3(): void {
  console.log('Q3 R1: free-text touchpoints are not protected sources');
  const t = fixture('REVIEW', 'B-d0a1');
  try {
    const input = currentStoryRoutingInput({ store: t.store, root: t.root, scanRoot: t.root } as never, t.storyId);
    const exact = (input.protectedSources ?? []).filter(source => source.kind === 'exact-path').map(source => source.path).sort();
    check(JSON.stringify(exact) === JSON.stringify(['strs/strs.go', 'strs/strs_test.go']),
      'only the leading path token of a touchpoint that resolves to a real file becomes an exact-path protected source', JSON.stringify(exact));

    const first = cli(t.root, 'review_round_prepare', { storyId: t.storyId, json: true });
    check(first.status === 0, 'review_round_prepare routes a no-corpus Story with free-text touchpoints without an owner fullScanReason', first.out.slice(-1500));
    const route = t.store.readCandidateSpecSet(t.storyId);
    check(/^automatic: no requirements corpus in project /.test(route?.scanEscalationReason ?? ''), 'the route records the automatic no-corpus reason', String(route?.scanEscalationReason));
    check((route?.protectedRouting.missing ?? []).length === 0, 'no missing_protected_source from free-text touchpoints', JSON.stringify(route?.protectedRouting.missing));
    check(JSON.stringify([...(route?.protectedRouting.selectedPaths ?? [])].sort()) === JSON.stringify(['strs/strs.go', 'strs/strs_test.go']),
      'the real touchpoint files stay protected (selected)', JSON.stringify(route?.protectedRouting.selectedPaths));

    console.log('Q3 R2: a stale owner-reasoned no-corpus route reroutes without the owner');
    // Run 17's R1 state: the owner had to supply a reason; route with it.
    const owner = cli(t.root, 'candidate_spec_route', { storyId: t.storyId, hosts: false, json: true, fullScanReason: 'no requirements corpus; touchpoints are free text' });
    check(owner.status === 0, 'owner-reasoned route recorded', owner.out.slice(-1000));
    check(t.store.readCandidateSpecSet(t.storyId)?.scanEscalationReason === 'no requirements corpus; touchpoints are free text', 'the owner reason is the recorded reason');
    write(t.root, 'strs/strs.go', 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string { return strings.ToUpper(s) }\n');
    t.git(['add', '-A']);
    t.git(['commit', '-qm', 'repair']);
    const second = cli(t.root, 'review_round_prepare', { storyId: t.storyId, json: true });
    check(second.status === 0, 'the stale owner-reasoned no-corpus route is rerouted automatically (no owner fullScanReason)', second.out.slice(-1500));
    check(/^automatic: no requirements corpus in project /.test(t.store.readCandidateSpecSet(t.storyId)?.scanEscalationReason ?? ''),
      'the reroute re-derived the automatic reason', String(t.store.readCandidateSpecSet(t.storyId)?.scanEscalationReason));

    // Readiness on run 17's exact persisted shape (pre-fix route with free-text missing sources).
    const binding = { materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) };
    const run17Route = {
      fullScan: true, requiresEscalation: true, corpusStatus: 'missing', scanEscalationReason: 'owner: no corpus, touchpoints are prose',
      escalationReasons: ['requirements_corpus_missing', 'missing_protected_source:missing:ast/ast.go IndexExpression and String',
        'missing_protected_source:missing:evaluator/evaluator_test.go, parser/parser_test.go, ast/ast_test.go'],
      materialHash: 'a'.repeat(64), storyFilesHash: 'a'.repeat(64),
    };
    const readiness = managedReviewCandidateReadiness(run17Route as never, t.storyId, binding);
    check(readiness.status === 'blocked' && !(readiness.nextAction ?? '').includes('fullScanReason'),
      'run 17 R2 shape: the stale route\'s next action is the plain candidate_spec_route', JSON.stringify(readiness));
    const riskRoute = { ...run17Route, escalationReasons: ['requirements_corpus_missing', 'high_risk_structured_signal'] };
    const risky = managedReviewCandidateReadiness(riskRoute as never, t.storyId, binding);
    check((risky.nextAction ?? '').includes('fullScanReason'), 'control: a stale owner-reasoned route with a real escalation reason still needs the owner', JSON.stringify(risky));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

const REQUEST = [
  'Add stepped slices to arrays and strings: a[start:end:step].',
  'For example [1, 2, 3, 4][::2] returns [1, 3].',
  'Do not change public syntax outside index brackets.',
  '',
  'Work in a new branch from main. Commit everything when you are done.',
].join('\n');

function q4(): void {
  console.log('Q4: the scope-plan reviewer prompt marks framework-owned workflow and INIT constraints as covered');
  const t = fixture('PLAN', 'B-d0a2');
  try {
    const now = '2026-10-03T06:00:00.000Z';
    writeStoryRequest(t.store, { storyId: t.storyId, phase: 'INIT', request: REQUEST, source: 'smoke', now });
    t.store.writeScopeBoundary(t.storyId, buildScopeBoundary({
      storyId: t.storyId, mode: 'feature', allowed: ['stepped slices inside index brackets'],
      excluded: ['public syntax changes outside index brackets'], now,
    } as never));
    const ctx = { store: t.store, root: t.root, scanRoot: t.root };
    const registry = createMainRegistry(ctx);
    const result = registry.get('dispatch')!({ storyId: t.storyId, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string };
    const prompt = String(result.prompt);
    const block = prompt.slice(prompt.lastIndexOf('Already covered ('));
    check(prompt.includes('Already covered'), 'the prompt has an "Already covered" block', prompt.slice(-2500));
    check(/branch[^.;]*from main/i.test(block) && /commit/i.test(block) && /proof-or-stop-workflow/.test(block),
      'workflow obligations Proof-or-Stop guarantees (branch from main, commit everything) are listed as covered by proof-or-stop-workflow', block.slice(0, 1500));
    check(block.includes('public syntax changes outside index brackets'), 'the INIT scopeBoundary exclusion is listed as acknowledged coverage', block.slice(0, 1500));
    check(block.includes('Do not change the exported signature of strs.Upper'), 'understanding.constraints are listed as acknowledged coverage', block.slice(0, 1500));
    check(/strict/i.test(block), 'every other request row stays strict (product requirements)', block.slice(0, 1500));
    check(!block.includes('Keep the existing error format for an empty input'),
      'a constraint that requires a behavior ("keep X") is not listed as covered: product requirements stay strict', block.slice(0, 1500));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

q3();
q4();
if (failures.length) {
  console.log(`dup-routing-coverage-smoke: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('dup-routing-coverage-smoke: PASS');
