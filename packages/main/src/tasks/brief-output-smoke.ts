#!/usr/bin/env node

/**
 * B-7c05 CHK-005 — brief-by-default CLI output regression smoke.
 *
 * On a synthetic temp project (a story with a populated milestone ledger +
 * findings + an open bug, plus terminal/non-terminal sibling stories) this
 * asserts:
 *   (a) brief defaults for milestone_status / finding_list / help / story_list /
 *       bug_list stay under their byte budgets and are smaller than --full;
 *   (b) --full restores the complete output (spot markers);
 *   (c) PROOF_OR_STOP_BRIEF_OUTPUT=0 restores full on bare invocation, and a per-call
 *       --brief still wins over the env hatch;
 *   (d) explicit --json field sets are identical with the brief env on/off
 *       (JSON opt-in bypasses brief — frozen machine shape);
 *   (e) brief skeleton contracts hold: finding_list findings[].evidenceState +
 *       attention.suspected, and story_list._bugSummary;
 *   (f) round-2 additions: story_review (genuine PLAN-phase run against the
 *       fixture project — brief keeps the issue skeleton incl. issues[].type,
 *       replaces _reviewPrompt with a stub naming --full) and doctor (brief
 *       keeps every scan section, trims Recent-issues/Validation detail).
 *
 * Run after build:
 *   node packages/main/dist/tasks/brief-output-smoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signFinding } from '../core/finding-verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const repoRoot = join(packageRoot, '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const cliFallback = join(repoRoot, 'bin', 'proof-or-stop.js');
const cliBin = existsSync(cliPath) ? cliPath : cliFallback;

const REVIEW_ROUND = '2026-07-12T00:00:00.000Z';
const FULL_ONLY_MARKER = 'FULLONLYMARKER';

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run the CLI. stdout is captured; stderr (the [Xs] log lines) is discarded. */
function runCli(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [cliBin, '--root', root, ...args], {
    cwd: root,
    env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runJson<T = Record<string, unknown>>(root: string, args: string[], env: Record<string, string> = {}): T {
  const out = runCli(root, args, env);
  return JSON.parse(out.slice(out.indexOf('{'))) as T;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function makeStory(id: string, phase: string, type = 'feature'): Record<string, unknown> {
  return {
    storyId: id,
    name: id,
    title: `${id} title`,
    description: 'Synthetic story for brief-output smoke.',
    type,
    phase,
    priority: 'high',
    createdAt: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    endedAt: phase === 'DONE' || phase === 'DISCARDED' ? REVIEW_ROUND : null,
  };
}

function makeFinding(
  storyId: string,
  seq: number,
  overrides: {
    severity: string;
    status: string;
    evidenceState: string;
    uncertaintyReason?: string;
    resolvedBy?: string;
  },
): Record<string, unknown> {
  const id = `${storyId}:F-${String(seq).padStart(3, '0')}`;
  // Deliberately heavy description whose unique marker sits BEYOND the 100-char
  // brief title truncation, so the marker appears only in --full / --json output
  // and brief is materially smaller than full.
  const desc = `${'A'.repeat(1200)} ${FULL_ONLY_MARKER}`;
  return {
    id,
    desc,
    severity: overrides.severity,
    category: 'happy',
    status: overrides.status,
    evidenceState: overrides.evidenceState,
    ...(overrides.uncertaintyReason ? { uncertaintyReason: overrides.uncertaintyReason } : {}),
    ...(overrides.resolvedBy ? { resolvedBy: overrides.resolvedBy } : {}),
    agent: 'proof-or-stop-review-quality',
    createdAt: REVIEW_ROUND,
    reviewRound: REVIEW_ROUND,
    reviewRunId: 'RR-001',
    _hash: signFinding(storyId, id, desc, overrides.severity, REVIEW_ROUND, REVIEW_ROUND, 'RR-001'),
  };
}

const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-brief-output-'));
try {
  writeJson(join(temp, 'proof-or-stop.config.json'), {
    scanRoot: '.',
    rootDir: 'src',
    outDir: 'dist',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  });
  git(temp, ['init']);
  git(temp, ['config', 'user.name', 'Brief Smoke']);
  git(temp, ['config', 'user.email', 'brief@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);

  const storyId = 'B-brief';
  const activesDir = join(temp, '.proof-or-stop', 'story', 'actives');
  const storyDir = join(activesDir, storyId);
  mkdirSync(storyDir, { recursive: true });
  writeJson(join(storyDir, 'index.json'), makeStory(storyId, 'DEV'));
  writeFileSync(join(storyDir, 'background.md'), '# Background\n\nBrief smoke fixture story.\n');
  writeJson(join(storyDir, 'checklist.json'), {
    items: [
      { id: 'CHK-001', title: 'First done item', status: 'done', startTime: null, endTime: null },
      { id: 'CHK-002', title: 'Second in-progress item', status: 'in_progress', startTime: null, endTime: null },
      { id: 'CHK-003', title: 'Third pending item', status: 'pending', startTime: null, endTime: null },
    ],
  });
  writeJson(join(storyDir, 'milestone-ledger.json'), {
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId,
    state: 'confirmed',
    ledgerHash: 'brief-smoke-hash',
    createdAt: REVIEW_ROUND,
    updatedAt: REVIEW_ROUND,
    milestones: [
      { id: 'M1', sourceRequirementId: 'REQ-1', claim: 'First milestone claim', doneMeans: 'M1 done means', status: 'done', checklistRefs: ['CHK-001'], verificationIntentRefs: [] },
      { id: 'M2', sourceRequirementId: 'REQ-2', claim: 'Second milestone claim', doneMeans: 'M2 done means', status: 'planned', checklistRefs: ['CHK-002'], verificationIntentRefs: [] },
      { id: 'M3', sourceRequirementId: 'REQ-3', claim: 'Third milestone claim', doneMeans: 'M3 done means', status: 'planned', checklistRefs: ['CHK-003'], verificationIntentRefs: [] },
    ],
  });
  writeJson(join(storyDir, 'findings.json'), {
    findings: [
      makeFinding(storyId, 1, { severity: 'high', status: 'open', evidenceState: 'verified' }),
      makeFinding(storyId, 2, { severity: 'critical', status: 'open', evidenceState: 'suspected', uncertaintyReason: 'Not yet reproduced against the real machine guard.' }),
      makeFinding(storyId, 3, { severity: 'medium', status: 'resolved', evidenceState: 'verified', resolvedBy: `${storyId}:F-003@commit` }),
    ],
  });
  writeJson(join(storyDir, 'bug.json'), {
    bugs: [
      { id: 'BUG-1', title: 'Open bug for brief smoke', status: 'open', foundAt: REVIEW_ROUND, fixedAt: null },
      { id: 'BUG-2', title: 'Fixed bug for brief smoke', status: 'fixed', foundAt: REVIEW_ROUND, fixedAt: REVIEW_ROUND },
    ],
  });

  // Sibling stories so story_list brief filtering (non-terminal one-liners +
  // per-phase counts covering all) is observable.
  for (const [sibId, sibPhase] of [['B-terminal', 'DONE'], ['B-plan', 'PLAN']] as const) {
    const dir = join(activesDir, sibId);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), makeStory(sibId, sibPhase));
    writeJson(join(dir, 'checklist.json'), { items: [] });
  }

  // Scaling story (CHK-001 edge:1 / F-003): >20 milestones must all stay
  // visible as one-liners in the brief rendering — no identifier hidden.
  const scaleStoryId = 'B-briefscale';
  const SCALE_MILESTONE_COUNT = 22;
  {
    const dir = join(activesDir, scaleStoryId);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), makeStory(scaleStoryId, 'DEV'));
    writeJson(join(dir, 'checklist.json'), {
      items: [{ id: 'CHK-001', title: 'Scale item', status: 'in_progress', startTime: null, endTime: null }],
    });
    writeJson(join(dir, 'milestone-ledger.json'), {
      schemaVersion: 'proofstory.milestone_ledger.v1',
      storyId: scaleStoryId,
      state: 'confirmed',
      ledgerHash: 'brief-smoke-scale-hash',
      createdAt: REVIEW_ROUND,
      updatedAt: REVIEW_ROUND,
      milestones: Array.from({ length: SCALE_MILESTONE_COUNT }, (_, i) => ({
        id: `MS-${String(i + 1).padStart(2, '0')}`,
        sourceRequirementId: 'REQ-1',
        claim: `Scale milestone ${i + 1} claim`,
        doneMeans: `Scale milestone ${i + 1} done means`,
        status: i < 5 ? 'done' : 'planned',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: [],
      })),
    });
  }

  // PLAN-phase story + a heavy truth doc for the story_review brief checks. The
  // marker sits inside the truth doc, which story_review embeds ONLY in the
  // full `_reviewPrompt`. Since main's B-f97c, requirements docs are no longer
  // embedded in the prompt (that was the measured 2.6MB whale), so the
  // full-output witness is the PLAN prompt header text, which the brief stub
  // replaces.
  const reviewStoryId = 'B-reviewbrief';
  {
    const dir = join(activesDir, reviewStoryId);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), makeStory(reviewStoryId, 'PLAN'));
    writeJson(join(dir, 'checklist.json'), { items: [] });
    mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
    writeFileSync(
      join(temp, 'docs', 'requirements', 'truth.md'),
      `# Truth\n\n${'A'.repeat(30_000)}\n\n${FULL_ONLY_MARKER}\n`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // milestone_status
  // ─────────────────────────────────────────────────────────────────────────
  const msBrief = runCli(temp, ['milestone_status', `--storyId=${storyId}`]);
  const msFull = runCli(temp, ['milestone_status', `--storyId=${storyId}`, '--full']);
  assert.match(msBrief, /Milestone Status - B-brief \(brief\)/, 'milestone_status brief header');
  assert.match(msBrief, /Progress: \d+ done \/ \d+ in progress \/ \d+ not started \(3 total\)/, 'milestone_status brief counts (3 total milestones)');
  // one line per milestone, no identifier hidden
  for (const m of ['M1', 'M2', 'M3']) assert.ok(msBrief.includes(m), `milestone_status brief keeps ${m}`);
  assert.doesNotMatch(msBrief, /\| Milestone \| Purpose \|/, 'brief drops the 7-column table header');
  assert.ok(bytes(msBrief) < 4000, `milestone brief under budget, got ${bytes(msBrief)}`);
  // (b) --full spot marker: the wide table header
  assert.match(msFull, /\| Milestone \| Purpose \| Status: \|/, 'milestone_status --full restores the table');
  assert.ok(bytes(msBrief) < bytes(msFull), 'milestone brief is smaller than full');
  // (c) env hatch + per-call override
  const msEnvFull = runCli(temp, ['milestone_status', `--storyId=${storyId}`], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.match(msEnvFull, /\| Milestone \| Purpose \|/, 'PROOF_OR_STOP_BRIEF_OUTPUT=0 restores the full table on bare invocation');
  const msEnvBrief = runCli(temp, ['milestone_status', `--storyId=${storyId}`, '--brief'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.match(msEnvBrief, /Milestone Status - B-brief \(brief\)/, 'per-call --brief wins over PROOF_OR_STOP_BRIEF_OUTPUT=0');
  // only the literal "0" disables brief
  const msEnvNonZero = runCli(temp, ['milestone_status', `--storyId=${storyId}`], { PROOF_OR_STOP_BRIEF_OUTPUT: 'false' });
  assert.match(msEnvNonZero, /Milestone Status - B-brief \(brief\)/, 'non-"0" PROOF_OR_STOP_BRIEF_OUTPUT keeps brief');
  // scaling boundary (CHK-001 edge:1 / F-003): >20 milestones, every id visible in brief
  const msScaleBrief = runCli(temp, ['milestone_status', `--storyId=${scaleStoryId}`]);
  assert.match(msScaleBrief, new RegExp(`\\(${SCALE_MILESTONE_COUNT} total\\)`), 'scaling brief counts all milestones');
  for (let i = 1; i <= SCALE_MILESTONE_COUNT; i++) {
    const id = `MS-${String(i).padStart(2, '0')}`;
    assert.ok(msScaleBrief.includes(id), `scaling brief keeps milestone id ${id}`);
  }
  assert.doesNotMatch(msScaleBrief, /\| Milestone \| Purpose \|/, 'scaling brief still drops the table');

  // ─────────────────────────────────────────────────────────────────────────
  // finding_list
  // ─────────────────────────────────────────────────────────────────────────
  const flBrief = runJson<{ _brief?: boolean; findings: Array<Record<string, unknown>>; attention: { suspected: string[]; disproven: string[] } }>(temp, ['finding_list', `--storyId=${storyId}`]);
  const flFullText = runCli(temp, ['finding_list', `--storyId=${storyId}`, '--full']);
  const flBriefText = runCli(temp, ['finding_list', `--storyId=${storyId}`]);
  assert.equal(flBrief._brief, true, 'finding_list brief marker');
  assert.equal(flBrief.findings.length, 3, 'finding_list brief keeps every finding');
  // (e) skeleton contracts preserved in brief
  for (const f of flBrief.findings) {
    assert.ok(['verified', 'suspected', 'disproven'].includes(f.evidenceState as string), 'brief finding keeps evidenceState');
  }
  assert.ok(Array.isArray(flBrief.attention.suspected), 'brief keeps attention.suspected');
  assert.ok(flBrief.attention.suspected.includes(`${storyId}:F-002`), 'suspected finding surfaces in brief attention');
  // resolvedBy + status preserved (field-regression contract shape)
  assert.match(flBriefText, /"resolvedBy":\s*"B-brief:F-003@commit"/, 'brief keeps resolvedBy');
  // heavy free text dropped in brief, present in full
  assert.doesNotMatch(flBriefText, new RegExp(FULL_ONLY_MARKER), 'brief drops the heavy description tail');
  assert.match(flFullText, new RegExp(FULL_ONLY_MARKER), 'finding_list --full keeps the full description');
  assert.ok(bytes(flBriefText) < 8000, `finding_list brief under budget, got ${bytes(flBriefText)}`);
  assert.ok(bytes(flBriefText) < bytes(flFullText), 'finding_list brief is smaller than full');
  // (d) explicit --json field set identical with the brief env on/off
  const flJsonEnvUnset = runJson<Record<string, unknown> & { findings: Array<Record<string, unknown>> }>(temp, ['finding_list', `--storyId=${storyId}`, '--json']);
  const flJsonEnvZero = runJson<Record<string, unknown> & { findings: Array<Record<string, unknown>> }>(temp, ['finding_list', `--storyId=${storyId}`, '--json'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.deepEqual(Object.keys(flJsonEnvUnset).sort(), Object.keys(flJsonEnvZero).sort(), 'finding_list --json top-level keys identical regardless of brief env');
  assert.deepEqual(Object.keys(flJsonEnvUnset.findings[0]).sort(), Object.keys(flJsonEnvZero.findings[0]).sort(), 'finding_list --json finding field set identical regardless of brief env');
  assert.equal((flJsonEnvUnset as { _brief?: boolean })._brief, undefined, 'explicit --json is not the brief shape');
  assert.match(JSON.stringify(flJsonEnvUnset), new RegExp(FULL_ONLY_MARKER), '--json returns the full description (frozen shape)');

  // ─────────────────────────────────────────────────────────────────────────
  // help
  // ─────────────────────────────────────────────────────────────────────────
  const helpBrief = runCli(temp, ['help']);
  const helpFull = runCli(temp, ['help', '--full']);
  // B-cdf6 CHK-005: PROOF_OR_STOP_PRODUCT_NAME is now 'Proof-or-Stop' (approved RENAMED row in
  // docs/requirements/decisions/brand-rename-mapping.md; `Proof-or-Stop` is a legacy spelling on the
  // normalize list). Same repin CHK-002 applied to command-catalog-smoke. The banner is still
  // asserted, so help losing its product name still fails.
  assert.match(helpBrief, /Proof-or-Stop/, 'brief help keeps branding');
  assert.match(helpBrief, /help --full/, 'brief help points at the full catalog');
  assert.doesNotMatch(helpBrief, /Development flow/, 'brief help drops the verbose development-flow block');
  assert.ok(bytes(helpBrief) < 16000, `brief help under 16000 bytes, got ${bytes(helpBrief)}`);
  assert.match(helpFull, /Development flow/, 'help --full restores the verbose catalog');
  assert.ok(bytes(helpBrief) < bytes(helpFull), 'brief help is smaller than full');
  // F-001: brief help is names-only — no truncated description fragments.
  assert.ok(!helpBrief.includes('…'), 'brief help contains no truncation-ellipsis fragments');
  // Every command name in the full catalog appears in brief too (no silent drop),
  // and the live registry is >100 commands, covering the scaling boundary.
  // Full-catalog rows are `    name<2+ spaces>description`; brief rows are
  // `    name` alone. Anchoring both patterns keeps footer prose (e.g.
  // "proofOrStop <command> --help") out of the name sets.
  const fullNames = new Set(
    helpFull
      .split('\n')
      .map((line) => /^ {4}([a-z][a-z0-9_]*) {2,}\S/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  const briefNames = new Set(
    helpBrief
      .split('\n')
      .map((line) => /^ {4}([a-z][a-z0-9_]*)\s*$/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  assert.ok(fullNames.size > 100, `full catalog lists >100 commands, got ${fullNames.size}`);
  for (const name of fullNames) {
    assert.ok(briefNames.has(name), `brief help keeps command name ${name}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // graceful ignore (CHK-005 adversarial:1 / F-005): a command without brief
  // mode treats --brief and the env hatch as no-ops — no crash, no change.
  // ─────────────────────────────────────────────────────────────────────────
  const cgBare = runCli(temp, ['checklist_get', `--storyId=${storyId}`, '--slim=true']);
  const cgBriefFlag = runCli(temp, ['checklist_get', `--storyId=${storyId}`, '--slim=true', '--brief']);
  const cgEnvOn = runCli(temp, ['checklist_get', `--storyId=${storyId}`, '--slim=true'], { PROOF_OR_STOP_BRIEF_OUTPUT: '1' });
  assert.equal(cgBriefFlag, cgBare, 'checklist_get ignores --brief (no behavior change)');
  assert.equal(cgEnvOn, cgBare, 'checklist_get ignores PROOF_OR_STOP_BRIEF_OUTPUT (no behavior change)');

  // ─────────────────────────────────────────────────────────────────────────
  // story_list
  // ─────────────────────────────────────────────────────────────────────────
  const slBrief = runJson<{ _brief?: boolean; _bugSummary?: string; _phases?: Record<string, number>; stories: Array<Record<string, unknown>> }>(temp, ['story_list']);
  const slFull = runJson<{ _brief?: boolean; _bugSummary?: string; stories: Array<Record<string, unknown>> }>(temp, ['story_list', '--full']);
  assert.equal(slBrief._brief, true, 'story_list brief marker');
  assert.ok('_bugSummary' in slBrief, 'story_list brief keeps _bugSummary (load-bearing consumer contract)');
  assert.ok(slBrief._phases && typeof slBrief._phases.DONE === 'number', 'story_list brief keeps per-phase counts covering ALL stories');
  const slBriefIds = slBrief.stories.map((s) => s.storyId);
  assert.ok(slBriefIds.includes('B-brief') && slBriefIds.includes('B-plan'), 'brief lists non-terminal stories');
  assert.ok(!slBriefIds.includes('B-terminal'), 'brief omits terminal stories from the list');
  // F-008: brief rows keep the bg (background.md) marker — no silent field drop
  const briefBriefRow = slBrief.stories.find((s) => s.storyId === 'B-brief') as Record<string, unknown>;
  assert.equal(briefBriefRow.bg, 'bg:✓', 'brief story_list keeps the bg marker');
  // full recovers the terminal story
  assert.ok(slFull.stories.map((s) => s.storyId).includes('B-terminal'), 'story_list --full recovers terminal stories');
  assert.equal(slFull._brief, undefined, 'story_list --full is not the brief shape');
  assert.ok(bytes(JSON.stringify(slBrief)) < 20000, 'story_list brief under budget');
  // (d) --json field parity with brief env on/off
  const slJsonUnset = runJson<Record<string, unknown>>(temp, ['story_list', '--json']);
  const slJsonZero = runJson<Record<string, unknown>>(temp, ['story_list', '--json'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.deepEqual(Object.keys(slJsonUnset).sort(), Object.keys(slJsonZero).sort(), 'story_list --json keys identical regardless of brief env');

  // ─────────────────────────────────────────────────────────────────────────
  // bug_list
  // ─────────────────────────────────────────────────────────────────────────
  const blBrief = runJson<{ _brief?: boolean; summary: { total: number; open: number; fixed: number }; bugs: Array<Record<string, unknown>> }>(temp, ['bug_list']);
  const blFull = runJson<{ _brief?: boolean; summary: { total: number }; bugs: Array<Record<string, unknown>> }>(temp, ['bug_list', '--full']);
  assert.equal(blBrief._brief, true, 'bug_list brief marker');
  assert.ok(blBrief.summary.total >= 2 && blBrief.summary.fixed >= 1, 'bug_list brief summary covers ALL bugs (non-silent counts)');
  assert.ok(blBrief.bugs.every((b) => b.status === 'open'), 'bug_list brief lists only open bugs');
  assert.ok(blFull.bugs.length > blBrief.bugs.length, 'bug_list --full recovers the omitted (fixed) bugs');
  assert.equal(blFull._brief, undefined, 'bug_list --full is not the brief shape');
  const blBriefBytes = bytes(JSON.stringify(blBrief));
  assert.ok(blBriefBytes < 20000, 'bug_list brief under budget');

  // ─────────────────────────────────────────────────────────────────────────
  // story_review (round 2) — genuine PLAN-phase run against the fixture; each
  // call appends a review round to review.json, which is fine here.
  // ─────────────────────────────────────────────────────────────────────────
  type StoryReviewOut = {
    _brief?: boolean;
    planReviewRound: number;
    reviewRound: number;
    summary: { totalItems: number; issueCount: number; blockerCount: number };
    issues: Array<{ type: string; severity: string; message: string }>;
    _hint: string;
    _reviewPrompt?: string;
  };
  const srBriefText = runCli(temp, ['story_review', `--storyId=${reviewStoryId}`]);
  const srBrief = JSON.parse(srBriefText.slice(srBriefText.indexOf('{'))) as StoryReviewOut;
  assert.equal(srBrief._brief, true, 'story_review brief marker');
  assert.ok(Number.isInteger(srBrief.planReviewRound), 'story_review brief keeps numeric planReviewRound');
  assert.equal(srBrief.reviewRound, srBrief.planReviewRound, 'story_review brief keeps the legacy numeric alias');
  assert.equal(typeof srBrief.summary.blockerCount, 'number', 'story_review brief keeps summary.blockerCount');
  assert.ok(Array.isArray(srBrief.issues) && srBrief.issues.length > 0, 'story_review brief keeps the issues array');
  assert.ok(srBrief.issues.every((i) => typeof i.type === 'string' && i.type.length > 0), 'story_review brief keeps issues[].type (stdout-consumer contract)');
  assert.ok(srBrief.issues.some((i) => i.type === 'split_quality'), 'empty checklist surfaces the split_quality blocker in brief');
  assert.ok(srBrief.issues.every((i) => i.message.length <= 301), 'story_review brief truncates issue messages');
  assert.ok(typeof srBrief._reviewPrompt === 'string' && srBrief._reviewPrompt.length > 0, 'story_review brief keeps a non-empty _reviewPrompt stub');
  assert.match(srBrief._reviewPrompt!, /--full/, 'story_review brief _reviewPrompt stub names --full');
  assert.doesNotMatch(srBriefText, /Please review the PLAN-phase artifacts/, 'story_review brief replaces the full _reviewPrompt body');
  assert.match(srBrief._hint, /--full/, 'story_review brief _hint names --full');
  assert.ok(bytes(srBriefText) < 20000, `story_review brief under budget, got ${bytes(srBriefText)}`);

  const srFullText = runCli(temp, ['story_review', `--storyId=${reviewStoryId}`, '--full']);
  assert.match(srFullText, /Please review the PLAN-phase artifacts/, 'story_review --full restores the full _reviewPrompt body');
  assert.ok(bytes(srBriefText) < bytes(srFullText), 'story_review brief is smaller than full');

  const srEnvFullText = runCli(temp, ['story_review', `--storyId=${reviewStoryId}`], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.match(srEnvFullText, /Please review the PLAN-phase artifacts/, 'PROOF_OR_STOP_BRIEF_OUTPUT=0 restores full story_review on bare invocation');
  const srEnvBriefText = runCli(temp, ['story_review', `--storyId=${reviewStoryId}`, '--brief'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.doesNotMatch(srEnvBriefText, /Please review the PLAN-phase artifacts/, 'per-call --brief wins over PROOF_OR_STOP_BRIEF_OUTPUT=0 for story_review');

  const srJsonUnset = runJson<Record<string, unknown>>(temp, ['story_review', `--storyId=${reviewStoryId}`, '--json']);
  const srJsonZero = runJson<Record<string, unknown>>(temp, ['story_review', `--storyId=${reviewStoryId}`, '--json'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.deepEqual(Object.keys(srJsonUnset).sort(), Object.keys(srJsonZero).sort(), 'story_review --json keys identical regardless of brief env');
  assert.equal(srJsonUnset._brief, undefined, 'story_review --json is not the brief shape');
  assert.match(String(srJsonUnset._reviewPrompt), /Please review the PLAN-phase artifacts/, 'story_review --json keeps the full _reviewPrompt (frozen shape)');

  // ─────────────────────────────────────────────────────────────────────────
  // doctor (round 2)
  // ─────────────────────────────────────────────────────────────────────────
  // The advisory host burn scan streams the OPERATOR machine's live
  // ~/.codex/sessions and ~/.claude/projects state, so its row count varies by
  // machine and minute; with it enabled the byte-budget assertion below tests
  // the reviewer's session history instead of the brief projection (B-fa65
  // F-004). Disable it via its documented env switch for deterministic output.
  const docEnv = { PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS: '0' };
  const docBrief = runCli(temp, ['doctor'], docEnv);
  const docFull = runCli(temp, ['doctor', '--full'], docEnv);
  assert.match(docBrief, /→ Brief view\. Full diagnostics: proof-or-stop doctor --full/, 'doctor brief carries the --full hint');
  for (const section of ['Runtime artifacts:', 'Worktree scan:', 'Partial-DONE scan:', 'Validation scan:', 'Codex adapter scan:']) {
    assert.ok(docBrief.includes(section), `doctor brief keeps the ${section} section`);
  }
  // Full-only validation-scan detail is the spot marker for restoration.
  assert.doesNotMatch(docBrief, /fallback command discovery is advisory/, 'doctor brief trims the validation-scan detail');
  assert.match(docFull, /fallback command discovery is advisory/, 'doctor --full restores the validation-scan detail');
  assert.doesNotMatch(docFull, /→ Brief view\./, 'doctor --full has no brief hint');
  assert.ok(bytes(docBrief) < bytes(docFull), 'doctor brief is smaller than full');
  assert.doesNotMatch(docBrief, /Long-lived interactive thread re-paying its full context every turn/, 'doctor brief omits verbose per-session burn remediation blocks');
  if (docFull.includes('Long-lived interactive thread re-paying its full context every turn')) {
    assert.match(docBrief, /use proof-or-stop doctor --full for every session detail/, 'doctor brief reports omitted burn sessions and points to --full');
  }
  assert.ok(bytes(docBrief) < 20000, `doctor brief under budget, got ${bytes(docBrief)}`);

  const docEnvFull = runCli(temp, ['doctor'], { ...docEnv, PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.match(docEnvFull, /fallback command discovery is advisory/, 'PROOF_OR_STOP_BRIEF_OUTPUT=0 restores full doctor on bare invocation');
  const docEnvBrief = runCli(temp, ['doctor', '--brief'], { ...docEnv, PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.match(docEnvBrief, /→ Brief view\./, 'per-call --brief wins over PROOF_OR_STOP_BRIEF_OUTPUT=0 for doctor');

  const docJsonUnset = runJson<Record<string, unknown>>(temp, ['doctor', '--format=json']);
  const docJsonZero = runJson<Record<string, unknown>>(temp, ['doctor', '--format=json'], { PROOF_OR_STOP_BRIEF_OUTPUT: '0' });
  assert.deepEqual(Object.keys(docJsonUnset).sort(), Object.keys(docJsonZero).sort(), 'doctor --format=json keys identical regardless of brief env');
  assert.ok(docJsonUnset.runtimeMode && docJsonUnset.partialDone, 'doctor --format=json keeps the full machine shape');

  console.log('brief output smoke passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
