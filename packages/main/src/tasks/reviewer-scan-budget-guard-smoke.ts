#!/usr/bin/env node
/**
 * Reviewer scan-budget guard (B-cee5).
 *
 * Static regression guard for the token-stopgap contract: the scope-plan and
 * behavior reviewer prompts (template + .claude + .proof-or-stop-codex copies) must
 * not reintroduce unconditional full decisions-directory scan instructions,
 * and must keep the bounded memory/playbook preflight + candidateSpecSet +
 * scanEscalationReason wording. Escalation-path wording is explicitly allowed:
 * a line that names scanEscalationReason may describe a full scan.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ReviewerReadLogEvent, ReviewerReadManifest, StoryInfo } from '../core/types.js';
import {
  captureReviewerReadEvent,
  diagnoseReviewerReadEvidence,
  digestReviewerReadManifest,
  normalizeReviewerReadLog,
  normalizeReviewerReadManifest,
} from '../core/reviewer-read-evidence.js';
import { signReviewPass, verifyFinding, verifyReviewPass } from '../core/finding-verify.js';
import {
  createScopeCheckHandlers,
  verifyScopeCheckSignature,
} from '../handlers/scope-check.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createMainRegistry } from '../registry.js';
import {
  nativeReviewFixtureBrokers,
  withBrokeredNativeReviewInvocation,
  withNativeReviewFixtureHostIdentity,
} from './native-review-fixture.js';
import { createReviewRunHandlers } from '../handlers/review-run.js';
import { ADAPTER_DIR_NAMES, PROOF_OR_STOP_ADAPTER_DIR } from '../core/brand-paths.js';


const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
// B-cc10: this smoke reads the REAL repo tree, so it must resolve whichever adapter-dir
// spelling actually exists rather than hardcoding one. Hardcoding the deprecated name
// made every read throw ENOENT after the rename.
const CODEX_AGENTS_REL = ADAPTER_DIR_NAMES
  .map((dir) => `${dir}/agents`)
  .find((rel) => existsSync(join(repoRoot, rel))) ?? `${PROOF_OR_STOP_ADAPTER_DIR}/agents`;

interface PatternRule {
  label: string;
  pattern: RegExp;
}

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

const guardedPromptFiles = [
  'packages/main/templates/agents/proof-or-stop-review-scope-plan.md',
  'packages/main/templates/agents/proof-or-stop-review-behavior.md',
  '.claude/agents/proof-or-stop-review-scope-plan.md',
  '.claude/agents/proof-or-stop-review-behavior.md',
  `${CODEX_AGENTS_REL}/proof-or-stop-review-scope-plan.md`,
  `${CODEX_AGENTS_REL}/proof-or-stop-review-behavior.md`,
] as const;

// Active modular reviewers keep their selected role body only in the package
// registry. Host files are intentionally body-free review_run_start bootstraps,
// so the bounded-search vocabulary is checked in the canonical template rather
// than falsely required in these two entrypoints.
const bodyFreeReviewerBootstrapFiles = new Set<string>([
  '.claude/agents/proof-or-stop-review-behavior.md',
  `${CODEX_AGENTS_REL}/proof-or-stop-review-behavior.md`,
]);

// Unconditional broad-scan instructions that must never return without
// escalation wording on the same line.
const bannedUnconditionalRules: PatternRule[] = [
  { label: 'always scan full decisions', pattern: /always scan the .*full decisions/i },
  { label: 'read every decisions file', pattern: /(?:must )?read every \.?md file/i },
  { label: 'read each decisions file unconditionally', pattern: /read every .*decisions/i },
  { label: 'full directory scan', pattern: /full directory scan of/i },
  { label: 'all md files under decisions', pattern: /all \.md files under .*decisions/i },
  { label: 'no cherry-picking full read', pattern: /read every \.md file one by one/i },
  { label: 'always defer to full decisions directory', pattern: /always defer to the full decisions/i },
  // Codex host-review catches (2026-07-09): the retired behavior wording
  // "Use Glob to list ..., Read each one" matched no rule, and softening a
  // real escalation line by deleting its conditioning clause was uncovered.
  { label: 'glob then read each one', pattern: /read each one\b/i },
  { label: 'whole-directory full-content scan', pattern: /full-content (?:directory )?scan of the whole/i },
];

// Phrases the bounded-search contract requires in every guarded copy.
const requiredPhrases = [
  'candidateSpecSet',
  'scanEscalationReason',
  'advisory only',
  'gateEvidence=false',
  'readManifest',
  'filesReadFully',
  'filesTriagedByName',
] as const;

// A line may legitimately describe the full-scan escalation path only when it
// CONDITIONS the scan on the recorded escalation reason (F-003 hardening:
// a bare scanEscalationReason mention — e.g. "ignore scanEscalationReason" —
// does not exempt the line). F-005 hardening: only the exact conditioning
// idioms used by the guarded prompts are exempt; the earlier loose
// "only with ... scanEscalationReason" proximity branch was removed because
// no legitimate line needs it and hostile fillers could satisfy it. This
// guard defends against ACCIDENTAL regression of prompt wording; a writer
// deliberately gaming the idioms (e.g. `recorded scanEscalationReason of
// "N/A"`) is out of scope for a static line-level text check and belongs to
// human review.
const escalationConditioningPattern =
  /(?:recorded scanEscalationReason|write the scanEscalationReason|escalated via scanEscalationReason)/i;

function lineIsEscalationPath(line: string): boolean {
  return line.includes('scanEscalationReason') && escalationConditioningPattern.test(line);
}

function readRel(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function scanFile(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((text, idx) => {
    if (lineIsEscalationPath(text)) return;
    for (const rule of bannedUnconditionalRules) {
      if (rule.pattern.test(text)) {
        violations.push({ file, line: idx + 1, label: rule.label, text: text.trim() });
      }
    }
  });
  return violations;
}

function toolSchema(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `command catalog contains ${name}`);
  return tool.schema;
}

function assertSchemaRejectsMissingReadManifest(command: string): void {
  const schema = toolSchema(command);
  assert.ok(schema.readManifest, `${command} schema exposes readManifest`);
  assert.equal(schema.readManifest.safeParse(undefined).success, false, `${command} schema rejects missing readManifest`);
  assert.equal(
    schema.readManifest.safeParse({ filesReadFully: 'docs/requirements/decisions/a.md', filesTriagedByName: [], scanEscalationReason: null }).success,
    false,
    `${command} schema rejects malformed readManifest arrays`,
  );
}

function assertSchemaExposesMechanicalReadInputs(command: string): void {
  const schema = toolSchema(command);
  assert.ok(schema.readEvents, `${command} schema exposes readEvents`);
  assert.ok(schema.readLog, `${command} schema exposes readLog`);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 1 }]).success, true);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: null }]).success, true);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokens: null }]).success, true);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: -1 }]).success, false);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokens: -1 }]).success, false);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 'unknown' }]).success, false);
  assert.equal(schema.readEvents.safeParse([{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokens: 'unknown' }]).success, false);
  assert.equal(schema.readLog.safeParse({ events: [{ path: 'docs/requirements/decisions/a.md', mode: 'full' }] }).success, true);
}

function initScopeCheckStore() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-read-manifest-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-readmanifest';
  const now = '2026-07-10T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'read-manifest-smoke',
    title: 'Read manifest smoke',
    description: 'Synthetic story for read manifest smoke.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: '2026-07-10T10:01:00.000Z',
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic read manifest item',
      context: 'Synthetic context',
      userSees: '`scope_check_save` writes a readManifest.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  return { root, store, storyId };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initReviewEvidenceStore() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-read-evidence-'));
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }, null, 2));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'review-read-evidence-smoke', private: true }, null, 2));
  writeFileSync(join(root, 'docs/requirements/decisions/a.md'), '# Decision A\n');
  writeFileSync(join(root, 'docs/requirements/decisions/b.md'), '# Decision B\n');
  git(root, ['init']);
  try {
    git(root, ['checkout', '-b', 'main']);
  } catch {
    git(root, ['checkout', 'main']);
  }
  git(root, ['config', 'user.email', 'review-read-evidence@example.invalid']);
  git(root, ['config', 'user.name', 'Review Read Evidence Smoke']);
  git(root, ['add', 'proof-or-stop.config.json', 'package.json', 'docs/requirements/decisions/a.md', 'docs/requirements/decisions/b.md']);
  git(root, ['commit', '-m', 'initial']);

  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-readhandler';
  const agent = 'proof-or-stop-review-behavior';
  const reviewRound = '2026-07-10T11:01:00.000Z';
  const now = '2026-07-10T11:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'review-read-evidence-handler-smoke',
    title: 'Review read evidence handler smoke',
    description: 'Synthetic REVIEW story for real handler read-log persistence.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Persist bounded reviewer read evidence',
      context: 'Synthetic checklist context for the production review-run path.',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  });
  const dispatch = createMainRegistry({ root, store, scanRoot: join(root, 'packages/main') }).get('dispatch');
  assert.ok(dispatch, 'native review fixture dispatch handler is registered');
  withNativeReviewFixtureHostIdentity({
    agent,
    invoke: () => dispatch({ storyId, agentType: agent }),
  });
  const reviewRunOutput = withNativeReviewFixtureHostIdentity({
    agent, invoke: () => createReviewRunHandlers({ store, root, scanRoot: join(root, 'packages/main') }).review_run_start({ storyId, agent }),
  });
  const reviewRunId = reviewRunOutput.match(/B-[^:\s]+:RR-\d+/)?.[0];
  assert.ok(reviewRunId, `review_run_start should return a current signed run id: ${reviewRunOutput}`);
  return { root, store, storyId, agent, reviewRunId };
}

function validManifest(): ReviewerReadManifest {
  return {
    filesReadFully: ['docs/requirements/decisions/a.md'],
    filesTriagedByName: ['docs/requirements/decisions/b.md'],
    scanEscalationReason: null,
  };
}

function assertReadManifestNormalizationAndDigest(): void {
  const normalized = normalizeReviewerReadManifest({
    filesReadFully: ['./docs/requirements/decisions/b.md', 'docs/requirements/decisions/a.md'],
    filesTriagedByName: ['docs/requirements/decisions/c.md'],
    scanEscalationReason: '  candidate ambiguity  ',
  });
  assert.deepEqual(normalized.filesReadFully, [
    'docs/requirements/decisions/a.md',
    'docs/requirements/decisions/b.md',
  ]);
  assert.equal(normalized.scanEscalationReason, 'candidate ambiguity');
  assert.equal(
    digestReviewerReadManifest(normalized),
    digestReviewerReadManifest({
      filesReadFully: ['docs/requirements/decisions/b.md', 'docs/requirements/decisions/a.md'],
      filesTriagedByName: ['docs/requirements/decisions/c.md'],
      scanEscalationReason: 'candidate ambiguity',
    }),
    'readManifest digest is stable after deterministic sorting',
  );
  assert.throws(
    () => normalizeReviewerReadManifest({ filesReadFully: ['a.md', './a.md'], filesTriagedByName: [], scanEscalationReason: null }),
    /duplicate path/,
  );
  assert.throws(
    () => normalizeReviewerReadManifest({ filesReadFully: ['../a.md'], filesTriagedByName: [], scanEscalationReason: null }),
    /path traversal|unsafe|not allowed/,
  );
  assert.throws(
    () => normalizeReviewerReadManifest({ filesReadFully: [], filesTriagedByName: [], scanEscalationReason: '   ' }),
    /blank strings are malformed/,
  );
}

function assertScopeCheckReadManifestSigning(): void {
  const { root, store, storyId } = initScopeCheckStore();
  const handlers = createScopeCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  assert.throws(
    () => handlers.scope_check_save({
      storyId,
      features: [],
      summary: { total: 0, covered: 0, excluded: 0, gaps: 0 },
      openQuestions: [],
    }),
    /scope_check_save\.readManifest/,
    'scope_check_save rejects missing readManifest at runtime',
  );
  handlers.scope_check_save({
    storyId,
    features: [{
      feature: 'read evidence',
      covered_by: 'CHK-001',
      status: 'covered',
      excluded_by: null,
      source: 'description',
    }],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0 },
    readManifest: validManifest(),
    openQuestions: [],
  });
  const data = store.readScopeCheck(storyId);
  assert.ok(data, 'scope_check_save persisted scope-check.json');
  assert.deepEqual(data!.readManifest, validManifest(), 'scope_check_save persists normalized readManifest');
  assert.equal(verifyScopeCheckSignature(storyId, data!), true, 'scope-check v2 signature verifies');
  const tampered = {
    ...data!,
    readManifest: {
      ...validManifest(),
      filesReadFully: ['docs/requirements/decisions/changed.md'],
    },
  };
  assert.equal(verifyScopeCheckSignature(storyId, tampered), false, 'changing only readManifest invalidates scope-check signature');
}

function assertReviewPassReadManifestSigning(): void {
  const manifest = validManifest();
  const base = {
    id: 'B-readmanifest:RP-001',
    agent: 'proof-or-stop-review-behavior',
    note: 'checked behavior and found no blocker',
    createdAt: '2026-07-10T10:05:00.000Z',
    reviewRound: '2026-07-10T10:01:00.000Z',
    reviewRunId: 'RR-001',
  };
  const pass = {
    ...base,
    readManifest: manifest,
    _hash: signReviewPass('B-readmanifest', base.id, base.agent, base.note, base.createdAt, base.reviewRound, base.reviewRunId, manifest),
  };
  assert.equal(verifyReviewPass('B-readmanifest', pass), true, 'review pass v2 signature verifies');
  assert.equal(
    verifyReviewPass('B-readmanifest', {
      ...pass,
      readManifest: { ...manifest, filesTriagedByName: ['docs/requirements/decisions/changed.md'] },
    }),
    false,
    'changing only readManifest invalidates review pass signature',
  );
  const legacyPass = {
    ...base,
    _hash: signReviewPass('B-readmanifest', base.id, base.agent, base.note, base.createdAt, base.reviewRound, base.reviewRunId),
  };
  assert.equal(verifyReviewPass('B-readmanifest', legacyPass), true, 'legacy review pass without readManifest remains verifiable');
}

function assertHandlerAndSchemaRejection(): void {
  assertSchemaRejectsMissingReadManifest('scope_check_save');
  assertSchemaRejectsMissingReadManifest('review_pass_set');
  assertSchemaExposesMechanicalReadInputs('review_pass_set');
  assertSchemaExposesMechanicalReadInputs('finding_add');
  const { root, store, storyId } = initScopeCheckStore();
  const findingHandlers = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  assert.throws(
    () => findingHandlers.review_pass_set({
      storyId,
      agent: 'proof-or-stop-review-behavior',
      reviewRunId: 'RR-001',
      note: 'checked enough to reject missing manifest',
    } as any),
    /review_pass_set\.readManifest/,
    'review_pass_set rejects missing readManifest at runtime',
  );
  assert.throws(
    () => findingHandlers.review_pass_set({
      storyId,
      agent: 'proof-or-stop-review-behavior',
      reviewRunId: 'RR-001',
      note: 'checked enough to reject malformed manifest',
      readManifest: { filesReadFully: ['docs/requirements/decisions/a.md'], filesTriagedByName: ['docs/requirements/decisions/a.md'], scanEscalationReason: null },
    } as any),
    /duplicate path/,
    'review_pass_set rejects malformed duplicate readManifest at runtime',
  );
}

function assertMechanicalReadLogAndDiagnostics(): void {
  const reviewerContext = { agent: 'proof-or-stop-review-behavior' };
  const events = [
    captureReviewerReadEvent({ path: './docs/requirements/decisions/b.md', action: 'Read', tokenCount: 11 }, reviewerContext),
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/a.md', readFully: true, tokenCount: 3 }, reviewerContext),
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/c.md', mode: 'triage' }, reviewerContext),
    captureReviewerReadEvent({ path: 'packages/main/src/core/types.ts', action: 'Read', tokenCount: 99 }, reviewerContext),
  ].filter((event): event is ReviewerReadLogEvent => event !== null);
  const log = normalizeReviewerReadLog(events);
  assert.deepEqual(log.filesReadFully, [
    'docs/requirements/decisions/a.md',
    'docs/requirements/decisions/b.md',
  ]);
  assert.deepEqual(log.filesTriagedByName, ['docs/requirements/decisions/c.md']);
  assert.equal(log.summary.readCount, 2, 'readCount counts full decision-doc read events deterministically');
  assert.equal(log.summary.tokenCount, 14, 'tokenCount sums available full-read token counts');

  const reversed = normalizeReviewerReadLog([...events].reverse());
  assert.equal(reversed.digest, log.digest, 'read-log digest is stable under event reordering');
  const changedToken = normalizeReviewerReadLog([
    ...events.slice(0, 1),
    { path: 'docs/requirements/decisions/a.md', mode: 'full', tokenCount: 4 },
    events[2],
  ]);
  assert.notEqual(changedToken.digest, log.digest, 'read-log digest changes when token/read-count inputs change');
  const unavailable = normalizeReviewerReadLog([
    { path: 'docs/requirements/decisions/a.md', mode: 'full', tokenCount: null },
  ]);
  assert.equal(unavailable.summary.tokenCount, null, 'tokenCount is null when unavailable');

  const matchingManifest: ReviewerReadManifest = {
    filesReadFully: log.filesReadFully,
    filesTriagedByName: log.filesTriagedByName,
    scanEscalationReason: 'explicit reviewer escalation',
  };
  assert.deepEqual(
    diagnoseReviewerReadEvidence({
      readManifest: matchingManifest,
      readLog: log,
      knownDecisionFiles: ['docs/requirements/decisions/a.md', 'docs/requirements/decisions/b.md'],
    }),
    [],
    'matching manifest/log with escalation reason has no diagnostics',
  );
  const diagnostics = diagnoseReviewerReadEvidence({
    readManifest: {
      filesReadFully: ['docs/requirements/decisions/a.md', 'docs/requirements/decisions/extra.md'],
      filesTriagedByName: ['docs/requirements/decisions/c.md'],
      scanEscalationReason: null,
    },
    readLog: log,
    knownDecisionFiles: ['docs/requirements/decisions/a.md', 'docs/requirements/decisions/b.md'],
  });
  assert.ok(diagnostics.some(d => d.code === 'read_manifest_missing_full_read' && d.path === 'docs/requirements/decisions/b.md'));
  assert.ok(diagnostics.some(d => d.code === 'read_manifest_extra_full_read' && d.path === 'docs/requirements/decisions/extra.md'));
  assert.ok(diagnostics.some(d => d.code === 'full_scan_without_scanEscalationReason'), 'full scan without scanEscalationReason is diagnosed');
}

function assertRealHandlerReadLogEvidencePath(): void {
  const { root, store, storyId, agent, reviewRunId } = initReviewEvidenceStore();
  const handlers = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const manifest: ReviewerReadManifest = {
    filesReadFully: ['docs/requirements/decisions/a.md'],
    filesTriagedByName: ['docs/requirements/decisions/b.md', 'packages/main/src/core/types.ts'],
    scanEscalationReason: null,
  };
  const readEvents = [
    { path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: null },
    { path: 'docs/requirements/decisions/b.md', mode: 'triage' },
    { path: 'packages/main/src/core/types.ts', action: 'Read', tokenCount: 99 },
  ];

  withBrokeredNativeReviewInvocation({
    root,
    store,
    storyId,
    agent,
    reviewRunId,
    invoke: () => handlers.review_pass_set({
      storyId,
      agent,
      reviewRunId,
      note: 'checked behavior evidence and found no blocker',
      readManifest: manifest,
      readEvents,
    }),
  });
  const pass = store.readReviewPasses(storyId).passes[0];
  assert.ok(pass.readLog?.digest, 'real review_pass_set persists mechanical readLog digest');
  assert.deepEqual(pass.readLog.filesReadFully, ['docs/requirements/decisions/a.md']);
  assert.deepEqual(pass.readLog.filesTriagedByName, ['docs/requirements/decisions/b.md']);
  assert.equal(pass.readLog.summary.tokenCount, null, 'real review_pass_set persists unknown readLog tokenCount from null readEvents');
  assert.deepEqual(pass.readManifest?.filesTriagedByName, [
    'docs/requirements/decisions/b.md',
    'packages/main/src/core/types.ts',
  ], 'real review_pass_set keeps source-file manifest triage signed');
  assert.deepEqual(pass.readDiagnostics, [], 'matching real review_pass_set stores no diagnostics');
  assert.equal(verifyReviewPass(storyId, pass), true, 'review pass with readLog verifies');
  assert.equal(
    verifyReviewPass(storyId, {
      ...pass,
      readLog: { ...pass.readLog!, summary: { ...pass.readLog!.summary, readCount: pass.readLog!.summary.readCount + 1 } },
    }),
    false,
    'tampering with persisted readLog invalidates review pass signature',
  );
  const passEvent = store.readProcessEvents(storyId).find(event => event.type === 'review_pass' && event.reviewPassId === pass.id);
  assert.equal(passEvent?.command, 'review_pass_set');
  assert.ok((passEvent?.readLog as any)?.digest, 'review_pass_set process event carries readLog digest');

  // The pass-only conversion below carries different semantic evidence, so it
  // is a distinct terminal rather than an idempotent retry of RP-001. Give it
  // its own current-round signed ReviewRun; reusing RR-001 must correctly fail
  // under the production conflict guard.
  const conversionRunOutput = withNativeReviewFixtureHostIdentity({ agent,
    invoke: () => createReviewRunHandlers({ store, root, scanRoot: join(root, 'packages/main') }).review_run_start({ storyId, agent }),
  });
  const conversionReviewRunId = conversionRunOutput.match(/B-[^:\s]+:RR-\d+/)?.[0];
  assert.ok(conversionReviewRunId, `second review_run_start should return a current signed run id: ${conversionRunOutput}`);

  // B-137a: finding_add binds native review authority, so the conversion write
  // must run inside a brokered invocation just like the first terminal.
  withBrokeredNativeReviewInvocation({
    root,
    store,
    storyId,
    agent,
    reviewRunId: conversionReviewRunId,
    invoke: () => handlers.finding_add({
      storyId,
      agent,
      reviewRunId: conversionReviewRunId,
      desc: 'no blockers after checking behavior path',
      severity: 'low',
      category: 'happy',
      readManifest: manifest,
      readLog: { events: [{ path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 8 }, { path: 'docs/requirements/decisions/b.md', mode: 'triage' }] },
    }),
  });
  const convertedPass = store.readReviewPasses(storyId).passes[1];
  assert.equal(convertedPass.agent, agent, 'pass-only finding_add converts into reviewer pass evidence');
  assert.ok(convertedPass.readLog?.digest, 'pass-only finding_add persists readLog digest');
  assert.notEqual(convertedPass.readLog.digest, pass.readLog!.digest, 'real handler readLog digest changes when read events change');
  assert.equal(verifyReviewPass(storyId, convertedPass), true, 'pass-only converted pass with readLog verifies');
  const convertedEvent = store.readProcessEvents(storyId).find(event => event.type === 'review_pass' && event.reviewPassId === convertedPass.id);
  assert.equal(convertedEvent?.command, 'finding_add', 'pass-only review_pass process event preserves originating command');

  assert.throws(
    () => handlers.review_pass_set({
      storyId,
      agent,
      reviewRunId: conversionReviewRunId,
      note: 'checked behavior evidence but supplied mismatched read manifest',
      readManifest: {
        filesReadFully: ['docs/requirements/decisions/a.md'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
      readEvents: [
        { path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 5 },
        { path: 'docs/requirements/decisions/b.md', action: 'Read', tokenCount: 7 },
      ],
    }),
    /read_manifest_missing_full_read|full_scan_without_scanEscalationReason/,
    'review_pass_set fails closed instead of silently dropping mismatch/full-scan diagnostics',
  );
  assert.equal(store.readReviewPasses(storyId).passes.length, 2, 'mismatched review_pass_set does not create a pass');

  withBrokeredNativeReviewInvocation({
    root,
    store,
    storyId,
    agent,
    reviewRunId: conversionReviewRunId,
    invoke: () => handlers.finding_add({
      storyId,
      agent,
      reviewRunId: conversionReviewRunId,
      desc: 'implementation misses the documented read evidence persistence path',
      severity: 'high',
      category: 'missing',
      readManifest: {
        filesReadFully: ['docs/requirements/decisions/a.md'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
      readEvents: [
        { path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 5 },
        { path: 'docs/requirements/decisions/b.md', action: 'Read', tokenCount: 7 },
      ],
    }),
  });
  const finding = store.readFindings(storyId).findings[0];
  assert.ok(finding.readLog?.digest, 'reviewer finding_add persists readLog digest');
  assert.ok(
    finding.readDiagnostics?.some(d => d.code === 'read_manifest_missing_full_read' && d.path === 'docs/requirements/decisions/b.md'),
    'reviewer finding_add records readManifest/readLog mismatch diagnostics',
  );
  assert.ok(
    finding.readDiagnostics?.some(d => d.code === 'full_scan_without_scanEscalationReason'),
    'reviewer finding_add records full-scan-without-reason diagnostics',
  );
  assert.equal(verifyFinding(storyId, finding), true, 'reviewer finding with read diagnostics verifies');
  assert.equal(
    verifyFinding(storyId, {
      ...finding,
      readDiagnostics: finding.readDiagnostics!.slice(1),
    }),
    false,
    'tampering with finding read diagnostics invalidates finding signature',
  );
  const findingEvent = store.readProcessEvents(storyId).find(event => event.type === 'reviewer_finding' && event.findingId === finding.id);
  assert.ok((findingEvent?.readLog as any)?.digest, 'finding_add process event carries readLog digest');
  assert.ok(Array.isArray(findingEvent?.readDiagnostics), 'finding_add process event carries read diagnostics');
}

function assertNonReviewerBypass(): void {
  const bypassed = captureReviewerReadEvent(
    { path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 7 },
    { agent: 'main' },
  );
  assert.equal(bypassed, null, 'non-reviewer read capture bypasses without reviewer evidence');
  const missingAgent = captureReviewerReadEvent(
    { path: 'docs/requirements/decisions/a.md', action: 'Read', tokenCount: 7 },
    {},
  );
  assert.equal(missingAgent, null, 'missing reviewer context bypasses without reviewer evidence');
  console.log('non-reviewer read capture bypass: PASS');
}

function assertPositiveControls(): void {
  const control = 'Always scan the **full decisions/ directory**.';
  const hits = scanFile('<positive-control>', control);
  assert.ok(hits.length > 0, 'positive control: banned pattern set must match the legacy full-scan wording');
  // Codex host-review fix (2026-07-09): the exempt control must be a line
  // that WOULD trip a banned rule, so it actually proves the exemption path.
  const escalatedLine =
    'Always scan the **full decisions/ directory** only with a recorded scanEscalationReason.';
  const escalated = scanFile('<positive-control>', escalatedLine);
  assert.equal(escalated.length, 0, 'positive control: conditioning-idiom lines are exempt escalation-path wording');
  const escalatedWithoutIdiom = scanFile('<positive-control>', escalatedLine.replace('recorded ', ''));
  assert.ok(
    escalatedWithoutIdiom.length > 0,
    'positive control soundness: the exempt line must trip a banned rule once its conditioning idiom is removed',
  );
  const hostile = scanFile(
    '<positive-control>',
    'Always scan the full decisions/ directory; ignore scanEscalationReason.',
  );
  assert.ok(
    hostile.length > 0,
    'positive control (F-003): a bare scanEscalationReason mention must not exempt banned unconditional wording',
  );
  const hostileProximity = scanFile(
    '<positive-control>',
    'Always scan the full decisions/ directory only with scanEscalationReason lying around unused.',
  );
  assert.ok(
    hostileProximity.length > 0,
    'positive control (F-005): loose only-with proximity phrasing must not exempt banned unconditional wording',
  );
}

// This standalone fixture must also run after validation strips host identity.
process.env.PROOF_OR_STOP_SESSION_ID = 'fixture-reviewer-scan-budget';
process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';

function main(): void {
  assertPositiveControls();
  assertReadManifestNormalizationAndDigest();
  assertScopeCheckReadManifestSigning();
  assertReviewPassReadManifestSigning();
  assertHandlerAndSchemaRejection();
  assertMechanicalReadLogAndDiagnostics();
  assertRealHandlerReadLogEvidencePath();
  assertNonReviewerBypass();

  const violations: Violation[] = [];
  const missing: string[] = [];

  for (const file of guardedPromptFiles) {
    const content = readRel(file);
    violations.push(...scanFile(file, content));
    if (bodyFreeReviewerBootstrapFiles.has(file)) {
      if (!content.includes('review_run_start')) {
        missing.push(`${file}: body-free reviewer bootstrap must call review_run_start`);
      }
    } else {
      for (const phrase of requiredPhrases) {
        if (!content.includes(phrase)) {
          missing.push(`${file}: missing required phrase "${phrase}"`);
        }
      }
    }
    assert.doesNotMatch(content, /“|”/, `${file}: JSON examples must use ASCII double quotes`);
  }

  if (violations.length > 0) {
    console.error('reviewer-scan-budget-guard: banned unconditional broad-scan wording found:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.label}] ${v.text}`);
    }
  }
  if (missing.length > 0) {
    console.error('reviewer-scan-budget-guard: required bounded-search phrases missing:');
    for (const m of missing) console.error(`  ${m}`);
  }
  assert.equal(violations.length, 0, `${violations.length} unconditional broad-scan violation(s)`);
  assert.equal(missing.length, 0, `${missing.length} missing required phrase(s)`);
  console.log(`reviewer-scan-budget-guard: PASS (${guardedPromptFiles.length} prompt copies clean, ${requiredPhrases.length} required phrases present)`);
}

main();
