#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { captureLifecycleMetadataTransaction } from '../core/auto-commit-metadata.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
  isMaterialExcludedPath,
} from '../core/evidence-freshness.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { collectReviewerEvidenceState, signReviewRun, verifyReviewRunPromptEnvelope } from '../core/review-run.js';
import {
  deriveCanonicalHostKeyId,
  deriveHostVerdictBindings,
  HOST_VERDICT_PROMPT_DIGEST_SCHEMA,
  HOST_VERDICT_PROMPT_PURPOSE,
  HOST_VERDICT_VALIDATION_DIGEST_SCHEMA,
} from '../core/host-verdict-bindings.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { evaluateHostVerdictRounds } from '../core/host-independence.js';
import { acquireMkdirLock } from '../core/mkdir-lock.js';
import { eventsWithStoryFilesHashDowngrade } from '../core/review-escalation.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetSessionIdForTest, resolveSessionIdentity } from '../core/owner-session.js';
import { storyRuntimeLockPath } from '../core/validation-execution-lock.js';
import { computePromptEnvelopeId } from '../core/prompt-envelope.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../core/prompt-role-contract-registry.js';
import { readPromptRegistry, renderPromptEntryForHost, type PromptHost } from '../core/prompt-registry.js';
import { StoryStore } from '../core/store.js';
import { listVerdicts, summarizeVerdicts } from '../core/verdicts.js';
import { createMainRegistry } from '../registry.js';
import { createQuorumPruneHandlers } from '../handlers/quorum-prune.js';
import { createQuorumSubmitHandlers } from '../handlers/quorum-submit.js';
import type { HandlerContext } from '../handlers/context.js';
import { reviewerPromptHostForProvider } from '../handlers/story-dispatch.js';
import type { ChecklistData, Finding, ReviewPass, ReviewRun, StoryInfo } from '../core/types.js';
import { STATE_DIR_NAMES, PROOF_OR_STOP_ADAPTER_DIR, PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';

const STORY_ID = 'B-quorum-smoke';
const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const DIST_DIRTY_GATE_POLICY_PATH = fileURLToPath(new URL('../core/dirty-gate-policy.js', import.meta.url));
const IMPLEMENTATION_REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const HISTORICAL_RED_COMMIT = 'ffedfb4eb3';
const REVIEW_ROUND = '2026-06-22T10:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=quorum-smoke@example.test', '-c', 'user.name=Quorum Submit Smoke'];
const REVIEW_LANES = [
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
] as const;

// Ignore rules copied verbatim from the implementation repo's own .gitignore. Both
// quorum_prune's assertCleanPruneBaseline and quorum_submit's assertCleanQuorumBaseline run an
// UNSCOPED `git status --porcelain=v1 --untracked-files=all`, so a fixture that omits the
// shipped repo's `*.bak` + managed-runtime-artifact rules measures fixture drift instead of
// product behavior (a CLI-driven mutating command writes owner-lease.json while it runs). The
// "clean worktree after apply" check asserts every pattern below still exists in the real
// .gitignore, so this mirror can never quietly become a self-serving fixture.
const MIRRORED_REPO_IGNORE_PATTERNS = [
  '*.bak',
  '**/owner-lease.json',
  '**/breaker-state.json',
  '**/takeover-count.json',
  '**/gate-failure-counts.json',
  '**/*.lock/',
] as const;

function reviewerReadManifest(lane: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${lane}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    validate: {
      commands: [{
        label: 'bounded quorum CLI validation probe',
        command: process.execPath,
        args: ['probe.mjs'],
        timeoutMs: 10_000,
      }],
    },
    proofAdmissibility: {
      mode: 'enforce',
      enforcedConsumers: ['REVIEW'],
    },
    promptEnvelope: {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: Object.fromEntries(REVIEW_LANES.map(lane => [lane, 'full-envelope'])),
    },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'quorum-submit-smoke',
    title: 'quorum_submit smoke',
    description: 'Synthetic REVIEW story for quorum_submit smoke coverage.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    createdAt: '2026-06-22T09:00:00.000Z',
    startedAt: '2026-06-22T09:10:00.000Z',
    endedAt: null,
    events: [
      { phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND },
    ],
  } as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'submit local quorum',
      context: 'Smoke fixture item already implemented.',
      status: 'done',
      startTime: null,
      endTime: null,
      files: {
        modify: ['packages/main/src/index.ts'],
        create: [],
        test: ['packages/main/tests/fixtures/quorum-smoke.json'],
      },
      verificationIntent: {
        happy: [{
          id: 'quorum-smoke-happy',
          desc: 'Quorum smoke fixture remains Story-scoped.',
          type: 'logic',
          priority: 'must',
        }],
        edge: [],
        adversarial: [],
      },
    }, ...Array.from({ length: 24 }, (_, index) => ({
      id: `CHK-CONTEXT-${String(index + 1).padStart(3, '0')}`,
      title: `Unaffected authoritative acceptance context ${index + 1}`,
      context: `Current full-context requirement ${index + 1} ${'bounded '.repeat(40)}`,
      status: 'done' as const,
      startTime: null,
      endTime: null,
      relatedDocs: [],
      files: { modify: [], create: [], test: [] },
      verificationIntent: { happy: [], edge: [], adversarial: [] },
    }))],
  };
}

function makeFixture(
  assetMode: 'global-thin' | 'full' = 'global-thin',
  selectedHost: PromptHost = 'codex',
): { root: string; store: StoryStore; ctx: HandlerContext; registry: ReturnType<typeof createMainRegistry> } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-quorum-submit-'));
  writeConfig(root);
  write(root, '.gitignore', [
    // B-cc10: list BOTH state-dir spellings. The runtime writes under the canonical
    // dir, so a fixture ignoring only the deprecated one left '?? .proof-or-stop/'
    // untracked and failed its own clean-baseline assertion.
    ...STATE_DIR_NAMES.flatMap((dir) => [
      `${dir}/autopilot-verdicts/`,
      `${dir}/activity.jsonl`,
      `${dir}/locks/`,
    ]),
    ...MIRRORED_REPO_IGNORE_PATTERNS,
    '',
  ].join('\n'));
  write(root, 'bin/proofOrStop.js', `#!/usr/bin/env node\nimport ${JSON.stringify(DIST_CLI_PATH)};\n`);
  write(root, 'probe.mjs', [
    "import { appendFileSync } from 'node:fs';",
    "if (process.env.QUORUM_CLI_PROBE_COUNTER) appendFileSync(process.env.QUORUM_CLI_PROBE_COUNTER, 'run\\n');",
    "console.log('bounded quorum CLI validation probe PASS');",
    '',
  ].join('\n'));
  write(root, '.proof-or-stop/proof-or-stop.json', `${JSON.stringify({ assetMode }, null, 2)}\n`);
  if (assetMode === 'full') {
    const promptRegistry = readPromptRegistry();
    // B-cc10: the runtime resolves the codex prompt dir canonically, so a fixture writing to
    // the deprecated spelling made every reviewer prompt asset look missing.
    const assetDir = selectedHost === 'codex' ? `${PROOF_OR_STOP_ADAPTER_DIR}/agents` : '.claude/agents';
    for (const lane of REVIEW_LANES) {
      const entry = promptRegistry.agents.find(candidate => candidate.agentId === lane)!;
      const hostTemplate = renderPromptEntryForHost(entry, selectedHost);
      write(root, `${assetDir}/${entry.file}`, hostTemplate);
    }
  }
  write(root, 'README.md', 'quorum submit smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  write(root, 'packages/main/tests/fixtures/quorum-smoke.json', JSON.stringify({
    cases: [{
      _id: 'base-case',
      name: 'base case',
      intentRef: `${STORY_ID}:CHK-001:happy:0`,
      expect: true,
    }],
  }, null, 2) + '\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed']);
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = 1;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story code change']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, checklist());
  store.writeFindings(STORY_ID, { findings: [] });
  store.writeTestEvidence(STORY_ID, {
    result: 'PASS',
    command: 'quorum-submit-smoke-validation',
    output: 'synthetic validation passed',
    timestamp: '2026-06-22T09:30:00.000Z',
  });
  git(root, ['add', '.proof-or-stop/story', 'proof-or-stop.config.json']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story review metadata']);

  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  return { root, store, ctx, registry };
}

function runFixtureCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['bin/proofOrStop.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PROOF_OR_STOP_PROJECT_ROOT: root,
      PROOF_OR_STOP_SESSION_ID: 'quorum-submit-cli-integration',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      ...env,
    },
  });
}

function withFreshFixture(
  fn: (fixture: ReturnType<typeof makeFixture>) => void,
): void {
  const fixture = makeFixture();
  const previous = process.cwd();
  try {
    process.chdir(fixture.root);
    withSessionProvider('codex', () => fn(fixture));
  } finally {
    process.chdir(previous);
    rmSync(fixture.root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function quorumArgs() {
  return {
    storyId: STORY_ID,
    hostA: 'claude-host',
    hostB: 'codex-host',
    rounds: 3,
    providerA: 'claude',
    providerB: 'codex',
    note: 'quorum_submit smoke atomic transaction',
    format: 'json' as const,
  };
}

function hostVerdictEventCount(store: StoryStore): number {
  return store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict').length;
}

function seedLargeCommittedProcessEvents(fixture: ReturnType<typeof makeFixture>): string {
  const path = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
  appendFileSync(path, `${JSON.stringify({
    type: 'plan_updated',
    timestamp: '2026-06-22T09:30:00.000Z',
    padding: 'x'.repeat(1_400_000),
  })}\n`);
  git(fixture.root, ['add', relative(fixture.root, path)]);
  git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'seed large process event history']);
  assert.ok(readFileSync(path).length > 1024 * 1024, 'large process-events fixture exceeds the execFileSync default maxBuffer');
  return path;
}

function verdictFileCount(root: string): number {
  return listVerdicts(root, 'local', STORY_ID).length;
}

function assertQuorumRefuses(registry: ReturnType<typeof createMainRegistry>, store: StoryStore, root: string, label: string): void {
  const beforeEvents = hostVerdictEventCount(store);
  const beforeVerdicts = verdictFileCount(root);
  const handler = registry.get('quorum_submit');
  assert.ok(handler, 'quorum_submit handler is registered');
  const refusal = assert.throws(
    () => handler({
      storyId: STORY_ID,
      hostA: 'host-a',
      hostB: 'host-b',
      format: 'json',
    }),
    /quorum_submit refuses: no current reviewer pass evidence for the required lanes/,
    label,
  );
  const refusalText = String(refusal);
  if (refusalText.includes('missing current pass lane(s):')) {
    assert.match(
      refusalText,
      new RegExp(`missing current pass lane\\(s\\): ${REVIEW_LANES.join(', ')}`),
      `${label}: missing-lane diagnostics use canonical reviewer lanes`,
    );
  }
  assert.equal(hostVerdictEventCount(store), beforeEvents, `${label}: no host_verdict process events written`);
  assert.equal(verdictFileCount(root), beforeVerdicts, `${label}: no verdict files written`);
}

function startRunAndPass(
  registry: ReturnType<typeof createMainRegistry>,
  lane: string,
  mode: 'legacy-full-context' | 'full-envelope' = 'full-envelope',
): void {
  const dispatch = registry.get('dispatch');
  const start = registry.get('review_run_start');
  const pass = registry.get('review_pass_set');
  assert.ok(dispatch, 'dispatch handler is registered');
  assert.ok(start, 'review_run_start handler is registered');
  assert.ok(pass, 'review_pass_set handler is registered');
  const dispatched = dispatch({ storyId: STORY_ID, agentType: lane }) as { prompt: string };
  assert.match(dispatched.prompt, new RegExp(`Review lane: ${lane}`));
  const output = String(start({
    storyId: STORY_ID,
    agent: lane,
  }));
  const match = output.match(/Review run (\S+) started/);
  assert.ok(match?.[1], `review_run_start output contains reviewRunId for ${lane}`);
  assert.match(
    output,
    mode === 'full-envelope'
      ? /BEGIN EXACT ASSEMBLED REVIEW PROMPT/
      : /BEGIN EXACT SELECTED LEGACY ROLE BODY/,
    `review_run_start delivers the selected ${mode} prompt bytes`,
  );
  pass({
    storyId: STORY_ID,
    agent: lane,
    reviewRunId: match[1],
    note: `No blocking issue found by ${lane} for quorum_submit smoke.`,
    readManifest: reviewerReadManifest(lane),
  });
}

const SESSION_ENV_KEYS = [
  'PROOF_OR_STOP_SESSION_ID',
  'PROOF_OR_STOP_ACTIVITY_SOURCE',
  'PROOF_OR_STOP_ACTIVITY_SESSION',
  'PROOF_OR_STOP_AGENT',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_SESSION',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  'TERM_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'AGY_SESSION_ID',
] as const;

function withClearedSessionEnvironment<T>(
  fn: () => T,
): T {
  const previous = Object.fromEntries(SESSION_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of SESSION_ENV_KEYS) delete process.env[key];
  resetSessionIdForTest();
  try {
    return fn();
  } finally {
    for (const key of SESSION_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionIdForTest();
  }
}

function withSessionProvider<T>(
  provider: string | undefined,
  fn: () => T,
  competingEnv: Record<string, string> = {},
): T {
  return withClearedSessionEnvironment(() => {
    process.env.PROOF_OR_STOP_SESSION_ID = `sess-quorum-${provider ?? 'absent'}`;
    if (provider !== undefined) process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = provider;
    for (const [key, value] of Object.entries(competingEnv)) process.env[key] = value;
    resetSessionIdForTest();
    return fn();
  });
}

function recordReviewerPasses(
  registry: ReturnType<typeof createMainRegistry>,
  provider: 'codex' | 'claude-code' | 'codex-cli' | 'claude-cli' = 'codex',
): void {
  withSessionProvider(provider, () => {
    for (const lane of REVIEW_LANES) startRunAndPass(registry, lane);
  });
}

let materialChangeCounter = 1;
function commitMaterialChange(root: string): void {
  // Each call must produce a DISTINCT materialDigest (a new commit with new content), so the
  // counter guarantees the file content actually changes even across repeated calls.
  materialChangeCounter += 1;
  write(root, 'packages/main/src/index.ts', `export const seed = true;\nexport const changed = ${materialChangeCounter};\n`);
  // Stage the whole tree so any verdict/process-event files written by a prior quorum are
  // committed too, leaving a clean working tree for the next review_run_start preflight.
  git(root, ['add', '-A']);
  git(root, [...COMMIT_ENV, 'commit', '-m', `material change ${materialChangeCounter}`]);
}

let mainDriftCounter = 0;
function commitMainDrift(root: string): void {
  // Reproduce the B-bf52 incident precondition: a commit that moves the whole-tree
  // materialHash but leaves the story-owned diff (and therefore storyFilesHash) untouched —
  // the normal effect of merging main into a story branch.
  mainDriftCounter += 1;
  git(root, ['checkout', 'main']);
  write(root, 'packages/main/src/main-drift.ts', `export const drift = ${mainDriftCounter};\n`);
  git(root, ['add', '-A']);
  git(root, [...COMMIT_ENV, 'commit', '-m', `main drift ${mainDriftCounter}`]);
  git(root, ['checkout', `story/${STORY_ID}`]);
  git(root, [...COMMIT_ENV, 'merge', '--no-edit', 'main']);
}

function quorumProcessEventsPath(fixture: ReturnType<typeof makeFixture>): string {
  return join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
}

function storyBackupFiles(fixture: ReturnType<typeof makeFixture>): string[] {
  return readdirSync(fixture.store.storyDirPath(STORY_ID))
    .filter(name => name.startsWith('process-events.jsonl.') && name.endsWith('.bak'));
}

// B-3144 F-006: an INDEPENDENT, file-level view of the story-owned diff — the (path, status,
// destination blob id) triples git itself reports between merge-base(main, HEAD) and HEAD, with
// the same story-metadata exclusion currentStoryFilesHash applies. It shares no code with the
// storyFilesHash digest, so equality here is a genuinely separate witness that a main drift
// touched zero story-owned blobs rather than a restatement of the hash equality.
function storyOwnedDiffBlobs(root: string): string[] {
  const base = git(root, ['merge-base', 'main', 'HEAD']);
  const raw = git(root, ['diff', '--raw', base, 'HEAD']);
  return raw.split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    // ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
    const parts = meta.trim().split(/\s+/);
    return { path, dstBlob: parts[3], status: parts[4] };
  })
    .filter(entry => entry.path && !isMaterialExcludedPath(entry.path, root))
    .map(entry => `${entry.path}\0${entry.status}\0${entry.dstBlob}`)
    .sort();
}

function wholeTreeDiffPaths(root: string, fromHead: string): string[] {
  return git(root, ['diff', '--name-only', fromHead, 'HEAD']).split('\n').filter(Boolean).sort();
}

// B-3144 CHK-003: reproduce an already-poisoned committed log — the shape `quorum_prune` exists
// to repair (background.md: "incidents predating the guard fix remain unrecoverable without
// manual jsonl surgery"). The producer guard now REFUSES a redundant re-submit, so we cannot
// re-run quorum_submit to build duplicates; instead we append duplicate host_verdict lines
// (new verdictId, unchanged storyFilesHash) and commit.
//
// F-0xx (post-B-f88e correction): the duplicates MUST carry the REAL current materialDigest, not
// a synthetic drift string. B-f88e (core/review-escalation.ts eventsWithStoryFilesHashDowngrade)
// now declines to downgrade a stale verdict onto a materialDigest that already has a NATIVE
// verdict of the same (runId, hostId, sessionId, keyId) identity — it leaves the stale one at its
// original material instead of colliding it. process-events.jsonl is excluded from
// currentMaterialHash (it is story-metadata bookkeeping, not source), so appending to it and
// committing does not change currentMaterialHash: the 6 baseline verdicts stay NATIVE at the
// current material. A synthetic non-current drift string on the duplicates therefore makes them
// "already superseded by a live verdict of the same identity" under B-f88e and they are left
// un-downgraded at their fake material — never colliding, never poisoning the floor at all (this
// is exactly B-f88e's fix working as intended for a genuine drift scenario). To still reproduce a
// REAL poisoned-at-current-material log (duplicate identity rows already sitting in the SAME
// material — the case `quorum_prune`'s own grouping, which keys on identity only, not material,
// still has to repair), pin the duplicates to `currentMaterialHash` directly.
function injectPoisonedDuplicates(
  fixture: ReturnType<typeof makeFixture>,
  opts: { copies?: number; interleaveLine?: string } = {},
): { first: any; originalHostVerdictLines: string[]; originalVerdictIds: string[]; dupMaterials: string[] } {
  const copies = opts.copies ?? 1;
  recordReviewerPasses(fixture.registry);
  const first: any = fixture.registry.get('quorum_submit')!(quorumArgs());
  assert.equal(first.emittedCount, 6, 'poison precondition: baseline quorum emits 6 verdicts');
  const eventsPath = quorumProcessEventsPath(fixture);
  const raw = readFileSync(eventsPath, 'utf8');
  assert.ok(raw.endsWith('\n'), 'committed process-events.jsonl is newline-terminated');
  const originalHostVerdictLines: string[] = [];
  const originalVerdictIds: string[] = [];
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type !== 'host_verdict') continue;
    originalHostVerdictLines.push(line);
    originalVerdictIds.push(String(event.verdictId));
    parsed.push(event);
  }
  assert.equal(parsed.length, 6, 'baseline quorum wrote 6 host_verdict lines');
  const nativeMaterial = currentMaterialHash(fixture.root, 'HEAD', fixture.root)!;
  assert.ok(nativeMaterial, 'poison precondition: current material hash resolves');
  const appended: string[] = [];
  if (opts.interleaveLine) appended.push(opts.interleaveLine);
  const dupMaterials: string[] = [];
  for (let copy = 1; copy <= copies; copy += 1) {
    dupMaterials.push(nativeMaterial);
    for (const event of parsed) {
      appended.push(JSON.stringify({ ...event, verdictId: `${String(event.verdictId)}-dup${copy}`, materialDigest: nativeMaterial }));
    }
  }
  writeFileSync(eventsPath, `${raw}${appended.join('\n')}\n`, 'utf8');
  git(fixture.root, ['add', '-A']);
  git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'inject B-bf52 poisoning duplicate host_verdict events']);
  return { first, originalHostVerdictLines, originalVerdictIds, dupMaterials };
}

function commitEventsRewrite(fixture: ReturnType<typeof makeFixture>, content: string, message: string): void {
  writeFileSync(quorumProcessEventsPath(fixture), content, 'utf8');
  git(fixture.root, ['add', '-A']);
  git(fixture.root, [...COMMIT_ENV, 'commit', '-m', message]);
}

function committedHostVerdictLines(fixture: ReturnType<typeof makeFixture>): Array<Record<string, unknown>> {
  return readFileSync(quorumProcessEventsPath(fixture), 'utf8').split('\n').flatMap((line) => {
    if (!line) return [];
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.type === 'host_verdict' ? [event] : [];
    } catch {
      return [];
    }
  });
}

// B-3144 F-024: build the shape a recovery tool must NEVER "recover" — a decision=fail verdict
// standing immediately BEFORE a passing verdict that carries the SAME runId + host/session/key
// identity. core/host-independence.ts treats the current-material FAIL as an invalidating fact for
// that round, so deleting it (as duplicate-identity pruning would) converts an INVALID round into
// a valid one. The fail row keeps every binding field and the current material, so it is exactly
// the row the consumer counts against the round.
function injectPrecedingFailVerdict(
  fixture: ReturnType<typeof makeFixture>,
  targetRunId: string,
): { failVerdictId: string; targetHostId: string } {
  const raw = readFileSync(quorumProcessEventsPath(fixture), 'utf8');
  const failVerdictId = `verdict-${'0'.repeat(15)}f`;
  let targetHostId = '';
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) {
      out.push(line);
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line);
      continue;
    }
    if (event.type === 'host_verdict' && event.runId === targetRunId && !targetHostId) {
      targetHostId = String(event.hostId);
      out.push(JSON.stringify({
        ...event,
        verdictId: failVerdictId,
        decision: 'fail',
        note: 'independent host found a blocking defect',
      }));
    }
    out.push(line);
  }
  assert.ok(targetHostId, `fixture precondition: ${targetRunId} has a host_verdict row to shadow with a FAIL`);
  commitEventsRewrite(fixture, out.join('\n'), `inject a failing verdict ahead of the passing one on ${targetRunId}`);
  return { failVerdictId, targetHostId };
}

// Append one duplicate-identity copy of every PASSING verdict on exactly one runId, so a single
// call can hold both a genuine B-bf52 collision and an unrecoverable group.
function appendDuplicatesForRunId(
  fixture: ReturnType<typeof makeFixture>,
  targetRunId: string,
  driftMaterial: string,
  overrides: (event: Record<string, unknown>) => Record<string, unknown> = event => event,
): string[] {
  const raw = readFileSync(quorumProcessEventsPath(fixture), 'utf8');
  const appended = committedHostVerdictLines(fixture)
    .filter(event => event.runId === targetRunId && String(event.decision ?? '').trim().toLowerCase() === 'pass')
    .map(event => overrides({
      ...event,
      verdictId: `${String(event.verdictId)}-dup`,
      materialDigest: driftMaterial,
    }));
  assert.ok(appended.length > 0, `fixture precondition: ${targetRunId} has passing verdicts to duplicate`);
  commitEventsRewrite(
    fixture,
    `${raw}${appended.map(event => JSON.stringify(event)).join('\n')}\n`,
    `inject duplicate host_verdict events for ${targetRunId}`,
  );
  return appended.map(event => String(event.verdictId));
}

function quorumFloorRounds(fixture: ReturnType<typeof makeFixture>) {
  const material = currentMaterialHash(fixture.root, 'HEAD', fixture.root)!;
  const storyFilesHash = currentStoryFilesHash(fixture.root, 'HEAD', fixture.root) ?? null;
  const advisories: string[] = [];
  const effective = eventsWithStoryFilesHashDowngrade(
    fixture.store.readProcessEvents(STORY_ID),
    material,
    storyFilesHash,
    advisories,
  );
  return evaluateHostVerdictRounds(effective, material, 2);
}

// B-3144: this suite's full run legitimately exceeds
// DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS (270s; see core/validation-executor.ts) — it is
// independently budgeted at 1_200_000ms in proof-or-stop.config.json's validate.commands entry
// (see git history: "chore(validate): raise quorum-submit-smoke budget to 20m"). The B-ec67
// tool-executed-receipt path (verification_evidence_add/_batch_add) has no way to honor that
// per-command override — it always runs the pinned command under the 270s default — so a
// mechanical receipt can never be earned against the unfiltered command for any intent whose
// evidence happens to require the LATER portion of this 70+-check suite. `--grep=<substring>`
// is an opt-in, additive-only narrowing: every check still runs its real, unmodified body and
// assertions when selected; only which checks execute (and print) changes. Default (unfiltered)
// behavior — used by `npm run build`'s consumers, `proof-or-stop validate`, and CI — is untouched.
const GREP_FILTER = (() => {
  const arg = process.argv.find(a => a.startsWith('--grep='));
  return arg ? arg.slice('--grep='.length) : null;
})();

let passed = 0;
function check(name: string, fn: () => void): void {
  if (GREP_FILTER !== null && !name.includes(GREP_FILTER)) return;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tasks' ? [] : productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function directProcessEventAppends(): string[] {
  const srcRoot = join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src');
  const primitive = join(srcRoot, 'core/process-events.ts');
  const violations: string[] = [];
  for (const path of productionTypeScriptFiles(srcRoot)) {
    if (path === primitive) continue;
    const sourceText = readFileSync(path, 'utf8');
    if (!sourceText.includes('appendFileSync') || !sourceText.includes('process-events.jsonl')) continue;
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'appendFileSync'
      ) {
        let scope: ts.Node | undefined = node;
        while (scope) {
          if (ts.isFunctionLike(scope) && scope.getText(source).includes('process-events.jsonl')) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${relative(IMPLEMENTATION_REPO_ROOT, path)}:${position.line + 1}`);
            break;
          }
          scope = scope.parent;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

const dyn5Case = process.env.PROOF_OR_STOP_DYN5_CASE;
if (dyn5Case) {
  const previousDyn5Cwd = process.cwd();
  try {
    withClearedSessionEnvironment(() => {
      withFreshFixture((fixture) => {
        const handler = fixture.registry.get('quorum_submit')!;
        if (dyn5Case === 'quorum:scenario-1') {
          recordReviewerPasses(fixture.registry);
          const result: any = handler(quorumArgs());
          assert.equal(result.emittedCount, 6, 'real quorum submit must emit one 3x2 verdict set');
        } else if (dyn5Case === 'quorum:scenario-2') {
          recordReviewerPasses(fixture.registry);
          handler(quorumArgs());
          assert.throws(() => handler(quorumArgs()), /verdicts already exist for runId/, 'duplicate quorum must be refused');
        } else if (dyn5Case === 'quorum:scenario-3') {
          assert.throws(() => handler(quorumArgs()), /no current reviewer pass evidence/, 'quorum without reviewer passes must be refused');
        } else if (dyn5Case === 'quorum:scenario-4') {
          recordReviewerPasses(fixture.registry);
          const result: any = handler(quorumArgs());
          assert.equal(result.emittedCount, 6, 'quorum floor must retain all three local rounds');
          assert.equal(quorumFloorRounds(fixture).validRounds.length, 3, 'quorum floor must observe three valid rounds');
        } else {
          throw new Error(`unknown DYN-5 quorum case: ${dyn5Case}`);
        }
      });
    });
    console.log(`PROOF_OR_STOP_DOMAIN_CASE:${dyn5Case}`);
  } finally {
    process.chdir(previousDyn5Cwd);
    resetConfigCache();
  }
  process.exit(0);
}

const previousCwd = process.cwd();
const { root, store, registry } = makeFixture();

try {
  process.chdir(root);

  check('every production process-event writer honors the shared append lock', () => {
    const lockFixture = mkdtempSync(join(tmpdir(), 'proof-or-stop-process-event-lock-'));
    try {
      const storyDirRel = '.proof-or-stop/story/actives';
      const storyDir = join(lockFixture, storyDirRel, STORY_ID);
      // B-d877 R3 FIX B: defaultAuditWriter now serializes the append on the
      // RELOCATED shared process-event lock under the gitignored
      // `.proof-or-stop/locks/process-events/` prefix — NOT the old in-story
      // `<storyDir>/.process-events-append.lock` (whose committed-then-deleted
      // holder.json dirtied the tree). Pre-create the relocated lock so the writer
      // must block on it; the invariant (honor the shared append lock) is unchanged,
      // only the canonical lock location moved.
      const lockDir = storyRuntimeLockPath(lockFixture, 'process-events', STORY_ID, 'process-events-append');
      mkdirSync(lockDir, { recursive: true });
      write(lockFixture, 'invoke-audit-writer.mjs', [
        `import { defaultAuditWriter } from ${JSON.stringify(DIST_DIRTY_GATE_POLICY_PATH)};`,
        `defaultAuditWriter(${JSON.stringify(lockFixture)}, ${JSON.stringify(storyDirRel)}, ${JSON.stringify(STORY_ID)})({`,
        "  type: 'dirty_gate_audit',",
        `  storyId: ${JSON.stringify(STORY_ID)},`,
        "  gate: 'validate-side-effect',",
        "  category: 'proof_or_stop_metadata_changes',",
        "  pathCount: 1,",
        "  paths: ['.proof-or-stop/story/actives/B-quorum-smoke/index.json'],",
        "  reason: 'lock ownership regression',",
        "  timestamp: '2026-07-19T00:00:00.000Z',",
        '});',
        '',
      ].join('\n'));
      const script = [
        `"${process.execPath}" invoke-audit-writer.mjs &`,
        'child=$!',
        'sleep 0.25',
        `if test -e ${JSON.stringify(join(storyDir, 'process-events.jsonl'))}; then`,
        '  wait "$child" || true',
        '  exit 41',
        'fi',
        `rmdir ${JSON.stringify(lockDir)}`,
        'wait "$child"',
      ].join('\n');
      assert.doesNotThrow(
        () => execFileSync('/bin/sh', ['-c', script], {
          cwd: lockFixture,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        'defaultAuditWriter must wait for the shared process-event lock instead of writing through it',
      );
      const rows = readFileSync(join(storyDir, 'process-events.jsonl'), 'utf8').trim().split('\n');
      assert.equal(rows.length, 1);

      assert.deepEqual(
        directProcessEventAppends(),
        [],
        'production process-events writers outside core/process-events.ts must use the shared append primitive',
      );
    } finally {
      rmSync(lockFixture, { recursive: true, force: true });
    }
  });

  check('reviewer provider mapping is explicit and unsupported providers fail closed', () => {
    assert.equal(reviewerPromptHostForProvider('codex'), 'codex');
    assert.equal(reviewerPromptHostForProvider('codex-cli'), 'codex');
    assert.equal(reviewerPromptHostForProvider('claude-code'), 'claude');
    assert.equal(reviewerPromptHostForProvider('claude-cli'), 'claude');
    for (const provider of ['antigravity', 'fake', 'unknown', undefined] as const) {
      assert.throws(
        () => reviewerPromptHostForProvider(provider),
        new RegExp(`unsupported session host provider "${provider ?? 'absent'}"`),
      );
    }
  });

  check('explicit invalid provider wins over competing host inference while true absence still infers', () => {
    const inputs = { hostname: 'quorum-smoke-host', root, ppid: 4242 };
    for (const competingEnv of [
      { CODEX_THREAD_ID: 'competing-codex-thread' },
      { CLAUDE_CODE_SESSION_ID: 'competing-claude-session' },
    ]) {
      const invalid = resolveSessionIdentity({
        PROOF_OR_STOP_SESSION_ID: 'sess-explicit-invalid',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'gemini',
        ...competingEnv,
      }, inputs);
      assert.equal(invalid.hostProvider, 'unknown', 'explicit invalid provider cannot fall through to competing host variables');
      assert.equal(invalid.sessionSource, 'explicit-env');
    }
    const absentCodex = resolveSessionIdentity({
      PROOF_OR_STOP_SESSION_ID: 'sess-absent-codex',
      CODEX_THREAD_ID: 'inferred-codex-thread',
    }, inputs);
    assert.equal(absentCodex.hostProvider, 'codex', 'absent explicit provider preserves Codex inference');
    const absentClaude = resolveSessionIdentity({
      PROOF_OR_STOP_SESSION_ID: 'sess-absent-claude',
      CLAUDE_CODE_SESSION_ID: 'inferred-claude-session',
    }, inputs);
    assert.equal(absentClaude.hostProvider, 'claude-code', 'absent explicit provider preserves Claude inference');
  });

  check('real story-owned fixture delta is host-independent and requires case-level Story intent closure', () => {
    withClearedSessionEnvironment(() => {
      withFreshFixture((fixture) => {
        recordReviewerPasses(fixture.registry);
        const fixturePath = 'packages/main/tests/fixtures/quorum-smoke.json';
        write(fixture.root, fixturePath, JSON.stringify({
          cases: [
            { _id: 'base-case', name: 'base case', intentRef: `${STORY_ID}:CHK-001:happy:0`, expect: true },
            { _id: 'added-case', name: 'new bounded case', intentRef: `${STORY_ID}:CHK-001:happy:0`, expect: true },
          ],
        }, null, 2) + '\n');
        git(fixture.root, ['add', fixturePath]);
        git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'add story-scoped fixture case']);
        const dispatch = fixture.registry.get('dispatch')!;
        const start = fixture.registry.get('review_run_start')!;
        dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-review-quality' });
        const output = String(start({ storyId: STORY_ID, agent: 'proof-or-stop-review-quality' }));
        assert.match(output, /context incremental\/SAFE_INCREMENTAL/);
        const latest = [...fixture.store.readReviewRuns(STORY_ID).runs].reverse().find(
          candidate => candidate.lane === 'proof-or-stop-review-quality',
        )!;
        const envelope = fixture.store.readPromptEnvelopes(STORY_ID).envelopes.find(
          candidate => candidate.envelopeId === latest.envelopeId,
        )!;
        assert.equal(envelope.freshnessClassification, 'RELATED_STORY_MATERIAL_DRIFT');
        assert.ok(envelope.eligibilityReasonCodes?.includes('ELIGIBLE_RELATED_PURE_STORY_FIXTURE_DRIFT'));
        assert.equal(verifyReviewRunPromptEnvelope(fixture.store, latest).ok, true);

        write(fixture.root, fixturePath, JSON.stringify({
          cases: [
            { _id: 'base-case', name: 'base case', intentRef: `${STORY_ID}:CHK-001:happy:0`, expect: true },
            { _id: 'added-case', name: 'new bounded case', intentRef: `${STORY_ID}:CHK-001:happy:0`, expect: true },
            { _id: 'unbound-case', name: 'attacker omitted current Story intent', expect: true },
          ],
        }, null, 2) + '\n');
        git(fixture.root, ['add', fixturePath]);
        git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'add unbound fixture case']);
        dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-review-quality' });
        const rejectedOutput = String(start({ storyId: STORY_ID, agent: 'proof-or-stop-review-quality' }));
        assert.match(rejectedOutput, /context full\/SAFETY_REQUIRES_FULL/);
      });
    });
  });

  check('duplicate fixture identities always force full regardless of alias or ordering', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const fixturePath = 'packages/main/tests/fixtures/quorum-smoke.json';
      const intentRef = `${STORY_ID}:CHK-001:happy:0`;
      const original = {
        _id: 'base-case',
        name: 'base case',
        intentRef,
        expect: true,
      };
      const duplicateVariants: Array<[string, Array<Record<string, unknown>>]> = [
        ['prepend duplicate _id', [{ _id: 'base-case', expect: false }, original]],
        ['append duplicate _id', [original, { _id: 'base-case', expect: false }]],
        ['reordered duplicate _id', [{ _id: 'other', intentRef }, original, { _id: 'base-case', expect: false }]],
        ['cross-field id alias', [original, { id: 'base-case', expect: false }]],
        ['cross-field name alias', [original, { name: 'base case', expect: false }]],
      ];
      const dispatch = fixture.registry.get('dispatch')!;
      const start = fixture.registry.get('review_run_start')!;
      for (const [label, cases] of duplicateVariants) {
        write(fixture.root, fixturePath, JSON.stringify({ cases }, null, 2) + '\n');
        git(fixture.root, ['add', fixturePath]);
        git(fixture.root, [...COMMIT_ENV, 'commit', '-m', label]);
        dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-review-quality' });
        const output = String(start({ storyId: STORY_ID, agent: 'proof-or-stop-review-quality' }));
        assert.match(output, /context full\/SAFETY_REQUIRES_FULL/, `${label} must select safety full`);
      }
    });
  });

  check('review_run_start CLI records reviewer-requested full escalation in envelope and signed run', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const dispatch = runFixtureCli(fixture.root, [
        'dispatch',
        JSON.stringify({ storyId: STORY_ID, agentType: 'proof-or-stop-review-quality' }),
      ], { PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' });
      assert.equal(dispatch.status, 0, dispatch.stderr);
      const reason = 'Bounded basis omitted an affected contract required by the reviewer.';
      const started = runFixtureCli(fixture.root, [
        'review_run_start',
        JSON.stringify({
          storyId: STORY_ID,
          agent: 'proof-or-stop-review-quality',
          reviewerEscalationReason: reason,
        }),
      ], { PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' });
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /context full\/REVIEWER_REQUESTED_FULL/);
      assert.match(started.stdout, /reviewer escalation: Bounded basis omitted/);
      const latest = [...fixture.store.readReviewRuns(STORY_ID).runs].reverse().find(
        candidate => candidate.lane === 'proof-or-stop-review-quality',
      )!;
      assert.equal(latest.reviewerEscalationReason, reason);
      assert.equal(verifyReviewRunPromptEnvelope(fixture.store, latest).ok, true);
      const envelope = fixture.store.readPromptEnvelopes(STORY_ID).envelopes.find(
        candidate => candidate.envelopeId === latest.envelopeId,
      )!;
      assert.equal(envelope.selectionReason, 'REVIEWER_REQUESTED_FULL');
      assert.equal(envelope.escalationReason, reason);
    });
  });

  check('unsupported session providers cannot enter the dispatch-to-review-run-to-gate chain', () => {
    const cases = [
      { label: 'agy', provider: 'agy', diagnostic: 'antigravity', competingEnv: {} },
      { label: 'antigravity', provider: 'antigravity', diagnostic: 'antigravity', competingEnv: {} },
      { label: 'fake', provider: 'fake', diagnostic: 'fake', competingEnv: {} },
      { label: 'unknown', provider: 'unknown', diagnostic: 'unknown', competingEnv: {} },
      { label: 'absent', provider: undefined, diagnostic: 'absent', competingEnv: {} },
      {
        label: 'explicit gemini with competing Codex env',
        provider: 'gemini',
        diagnostic: 'unknown',
        competingEnv: { CODEX_THREAD_ID: 'competing-codex-thread' },
      },
      {
        label: 'explicit gemini with competing Claude env',
        provider: 'gemini',
        diagnostic: 'unknown',
        competingEnv: { CLAUDE_CODE_SESSION_ID: 'competing-claude-session' },
      },
    ] as const;
    for (const testCase of cases) {
      withFreshFixture((unsupported) => {
        withSessionProvider(testCase.provider, () => {
          const dispatch = unsupported.registry.get('dispatch');
          const start = unsupported.registry.get('review_run_start');
          assert.ok(dispatch, 'dispatch handler is registered');
          assert.ok(start, 'review_run_start handler is registered');
          assert.throws(
            () => dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-review-quality' }),
            new RegExp(`unsupported session host provider "${testCase.diagnostic}"`),
            `${testCase.label} dispatch fails closed`,
          );
          assert.throws(
            () => start({ storyId: STORY_ID, agent: 'proof-or-stop-review-quality' }),
            /no trusted story-review dispatch binding/,
            `${testCase.label} cannot start a review run without supported dispatch provenance`,
          );
          assert.equal(
            canPassReviewGuard({
              storyId: STORY_ID,
              store: unsupported.store,
              projectRoot: unsupported.root,
              gitCwd: unsupported.root,
            }),
            false,
            `${testCase.label} cannot satisfy the REVIEW gate`,
          );
          assert.equal(
            unsupported.store.readProcessEvents(STORY_ID).filter(
              event => event.type === 'dispatch' && event.targetKind === 'story-review',
            ).length,
            0,
            `${testCase.label} fails before dispatch provenance is persisted`,
          );
          assert.equal(unsupported.store.readReviewRuns(STORY_ID).runs.length, 0);
          assert.equal(unsupported.store.readPromptEnvelopes(STORY_ID).envelopes.length, 0);
        }, testCase.competingEnv);
      });
    }
  });

  check('Codex and Claude CLI provider aliases complete the thin zero-asset review chain', () => {
    const primaryCwd = process.cwd();
    for (const selected of [
      { provider: 'codex-cli', host: 'codex' },
      { provider: 'claude-cli', host: 'claude' },
    ] as const) {
      const thin = makeFixture('global-thin');
      try {
        process.chdir(thin.root);
        assert.equal(existsSync(join(thin.root, `${PROOF_OR_STOP_ADAPTER_DIR}/agents`)), false);
        assert.equal(existsSync(join(thin.root, '.claude/agents')), false);
        recordReviewerPasses(thin.registry, selected.provider);
        const thinEvidence = collectReviewerEvidenceState(thin.store, STORY_ID, thin.root);
        const qualityDispatch = [...thin.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'proof-or-stop-review-quality',
        );
        assert.equal(qualityDispatch?.hostRenderHost, selected.host);
        assert.equal(
          canPassReviewGuard({
            storyId: STORY_ID,
            store: thin.store,
            projectRoot: thin.root,
            gitCwd: thin.root,
          }),
          true,
          `${selected.provider} completes dispatch, review_run_start and REVIEW gate without host assets; invalid=${JSON.stringify(thinEvidence.invalid)}`,
        );
      } finally {
        process.chdir(primaryCwd);
        rmSync(thin.root, { recursive: true, force: true });
        resetConfigCache();
      }
    }
  });

  check('shared binding derivation is byte-identical to the former quorum envelopes', () => {
    const vector = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS', command: 'vector' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const keyId = `quorum:${STORY_ID}:host-vector:key`;
    const actual = deriveHostVerdictBindings(vector);
    assert.equal(actual.keyId, keyId);
    assert.equal(actual.keyId, deriveCanonicalHostKeyId(STORY_ID, 'host-vector'));
    assert.equal(actual.validationDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: vector.testEvidence,
    }));
    assert.equal(actual.promptDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.prompt_digest.v1',
      purpose: 'local voluntary 3x2 review quorum after signed reviewer passes',
      storyId: STORY_ID,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
    }));
    assert.equal(HOST_VERDICT_VALIDATION_DIGEST_SCHEMA, 'lattice.quorum_submit.validation_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_DIGEST_SCHEMA, 'lattice.quorum_submit.prompt_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_PURPOSE, 'local voluntary 3x2 review quorum after signed reviewer passes');
  });

  check('shared derivation preserves optional-head and missing-evidence envelopes', () => {
    const base = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const absent = deriveHostVerdictBindings({ ...base, testEvidence: null });
    assert.equal(absent.validationDigest, canonicalDigest({
      schemaVersion: 'lattice.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: undefined,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
    }));
    const present = deriveHostVerdictBindings({ ...base, headHash: 'head-vector', testEvidence: { result: 'PASS' } });
    assert.notEqual(absent.validationDigest, present.validationDigest);
  });

  check('shared derivation fails closed on every required envelope field', () => {
    const valid = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    for (const field of ['storyId', 'materialDigest', 'storyFilesHash', 'hostId', 'provider', 'sessionId', 'keyId'] as const) {
      assert.throws(() => deriveHostVerdictBindings({ ...valid, [field]: ' ' }), new RegExp(field));
    }
    assert.throws(() => deriveHostVerdictBindings({ ...valid, storyId: '../not-a-story' }), /canonical storyId/);
    assert.throws(() => deriveCanonicalHostKeyId('../not-a-story', 'host-vector'), /canonical storyId/);
  });

  check('shared derivation binds every replay-sensitive input', () => {
    const base = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    const original = deriveHostVerdictBindings(base);
    for (const [field, value] of Object.entries({
      storyId: 'B-other', headHash: 'other-head', materialDigest: 'other-material',
      storyFilesHash: 'other-story-files', hostId: 'other-host', provider: 'claude',
      sessionId: 'other-session', keyId: 'other-key',
    })) {
      const changed = deriveHostVerdictBindings({ ...base, [field]: value });
      assert.ok(changed.validationDigest !== original.validationDigest || changed.promptDigest !== original.promptDigest, `${field} changes a canonical digest`);
    }
    const changedEvidence = deriveHostVerdictBindings({ ...base, testEvidence: { result: 'FAIL' } });
    assert.notEqual(changedEvidence.validationDigest, original.validationDigest);
  });

  check('worktree-local CLI commits the exact quorum batch through the production entrypoint', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const result = runFixtureCli(fixture.root, ['quorum_submit', JSON.stringify(quorumArgs())]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /metadataCommitSha/);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(git(fixture.root, ['status', '--porcelain=v1']), '');
      assert.equal(hostVerdictEventCount(fixture.store), 6);
      assert.equal(verdictFileCount(fixture.root), 6);
    });
  });

  check('mixed legacy/full reviewer evidence crosses collector, REVIEW gate, and quorum admission', () => {
    withFreshFixture((fixture) => {
      const configPath = join(fixture.root, 'proof-or-stop.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const modes = {
        'proof-or-stop-review-concept': 'legacy-full-context',
        'proof-or-stop-review-quality': 'full-envelope',
        'proof-or-stop-review-test-coverage': 'legacy-full-context',
      } as const;
      config.promptEnvelope.roles = modes;
      write(fixture.root, 'proof-or-stop.config.json', `${JSON.stringify(config, null, 2)}\n`);
      git(fixture.root, ['add', 'proof-or-stop.config.json']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'select mixed reviewer rollout']);
      resetConfigCache();

      withSessionProvider('codex', () => {
        for (const lane of REVIEW_LANES) startRunAndPass(fixture.registry, lane, modes[lane]);
      });
      const evidence = collectReviewerEvidenceState(fixture.store, STORY_ID, fixture.root);
      assert.equal(evidence.invalid.length, 0, `mixed collector invalid=${JSON.stringify(evidence.invalid)}`);
      assert.equal(evidence.valid.length, REVIEW_LANES.length);
      assert.equal(canPassReviewGuard({ storyId: STORY_ID, store: fixture.store, projectRoot: fixture.root }), true);
      const result: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(result.emittedCount, 6, 'mixed reviewer passes authorize the same 3x2 quorum batch');
    });
  });

  check('production CLI refuses process-events, staged source, and lifecycle metadata pre-dirt', () => {
    const cases: Array<{
      name: string;
      mutate: (fixture: ReturnType<typeof makeFixture>) => string;
    }> = [
      {
        name: 'process-events',
        mutate: (fixture) => {
          const path = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
          appendFileSync(path, '{"type":"foreign_preexisting_event"}\n');
          return path;
        },
      },
      {
        name: 'staged-source',
        mutate: (fixture) => {
          const path = join(fixture.root, 'packages/main/src/index.ts');
          appendFileSync(path, 'export const stagedUserChange = true;\n');
          git(fixture.root, ['add', 'packages/main/src/index.ts']);
          return path;
        },
      },
      {
        name: 'lifecycle-metadata',
        mutate: (fixture) => {
          const path = join(fixture.store.storyDirPath(STORY_ID), 'index.json');
          const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          value.foreignLifecycleMutation = true;
          writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
          return path;
        },
      },
    ];
    for (const testCase of cases) {
      withFreshFixture((fixture) => {
        recordReviewerPasses(fixture.registry);
        const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
        const path = testCase.mutate(fixture);
        const beforeBytes = readFileSync(path);
        const result = runFixtureCli(fixture.root, ['quorum_submit', JSON.stringify(quorumArgs())]);
        assert.notEqual(result.status, 0, `${testCase.name} pre-dirt must refuse`);
        assert.match(`${result.stdout}\n${result.stderr}`, /worktree\/index must be clean|canonical metadata was already dirty/);
        assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
        assert.deepEqual(readFileSync(path), beforeBytes);
        assert.equal(verdictFileCount(fixture.root), 0);
      });
    }
  });

  check('historical RED dirty baseline makes CLI validation refuse canonical PASS persistence', () => {
    execFileSync('git', ['cat-file', '-e', `${HISTORICAL_RED_COMMIT}^{commit}`], {
      cwd: IMPLEMENTATION_REPO_ROOT,
      stdio: 'ignore',
    });
    withFreshFixture((fixture) => {
      const current = fixture.store.readStory(STORY_ID);
      fixture.store.writeStory(STORY_ID, {
        ...current,
        phase: 'TEST',
        events: [...(current.events ?? []), {
          phase: 'TEST',
          action: 'advance',
          timestamp: '2026-06-22T10:30:00.000Z',
        }],
      });
      fixture.store.writeTestEvidence(STORY_ID, {
        result: 'FAIL',
        command: 'historical-red-baseline',
        output: `bound to RED commit ${HISTORICAL_RED_COMMIT}`,
        timestamp: '2026-06-22T10:31:00.000Z',
      });
      git(fixture.root, ['add', '.proof-or-stop/story']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'seed TEST failure baseline']);
      for (let index = 0; index < 6; index += 1) {
        fixture.store.appendProcessEvent(STORY_ID, {
          type: 'host_verdict',
          mode: 'local',
          verdictId: `historical-red-verdict-${index}`,
          runId: `${STORY_ID}-q-r${Math.floor(index / 2) + 1}`,
          hostId: index % 2 === 0 ? 'claude-host' : 'codex-host',
          provider: index % 2 === 0 ? 'claude' : 'codex',
          sessionId: `historical-red-session-${index % 2}`,
          keyId: `historical-red-key-${index % 2}`,
          decision: 'pass',
          materialDigest: 'historical-red-material',
          storyFilesHash: 'historical-red-story-files',
          validationDigest: 'historical-red-validation',
          promptDigest: 'historical-red-prompt',
        });
      }
      const dirtyBytes = readFileSync(join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl'));
      const result = runFixtureCli(fixture.root, ['validate', `--story=${STORY_ID}`, '--json']);
      const payload = JSON.parse(result.stdout.trim()) as {
        status?: unknown;
        allPass?: unknown;
        failureKind?: unknown;
        disposition?: unknown;
        commandExecutions?: unknown;
      };
      assert.equal(payload.status, 'fail');
      assert.equal(payload.allPass, false);
      assert.equal(payload.failureKind, 'infra_failure');
      assert.equal(payload.disposition, 'executed');
      assert.equal(payload.commandExecutions, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /canonical metadata was already dirty|pre-existing|infra_failure/);
      assert.equal(fixture.store.readTestEvidence(STORY_ID)?.result, 'FAIL');
      assert.deepEqual(
        readFileSync(join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl')),
        dirtyBytes,
        'validation refusal preserves the historical dirty baseline',
      );
      assert.doesNotMatch(result.stdout, /"result"\s*:\s*"PASS"|"status"\s*:\s*"pass"/);
    });
  });

  check('refuses when required reviewer passes are absent and writes no verdicts', () => {
    assertQuorumRefuses(registry, store, root, 'absent reviewer pass refusal');
  });

  check('numerically sufficient compatibility/retired-only receipts cannot authorize quorum', () => {
    const headHash = currentGitHead(root)!;
    const materialHash = currentMaterialHash(root)!;
    const storyFilesHash = currentStoryFilesHash(root)!;
    const aliases = ['implementation-reviewer', 'test-intent', 'proof-or-stop-review-channel'];
    const runs: ReviewRun[] = aliases.map((agent, index) => {
      const run: ReviewRun = {
        reviewRunId: `${STORY_ID}:COMPAT-${index + 1}`,
        storyId: STORY_ID,
        agent,
        lane: agent,
        reviewRound: REVIEW_ROUND,
        startedAt: `2026-06-22T09:4${index}:00.000Z`,
        headHash,
        materialHash,
        storyFilesHash,
        promptHash: `compatibility-only-${index}`,
      };
      run._hash = signReviewRun(
        run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound,
        run.startedAt, run.headHash, run.materialHash, run.promptHash,
        undefined, undefined, run.storyFilesHash,
      );
      return run;
    });
    const passes: ReviewPass[] = runs.map((run, index) => {
      const pass: ReviewPass = {
        id: `${STORY_ID}:COMPAT-RP-${index + 1}`,
        agent: run.agent,
        note: 'Compatibility-only receipt must remain non-authoritative.',
        createdAt: `2026-06-22T09:5${index}:00.000Z`,
        reviewRound: REVIEW_ROUND,
        reviewRunId: run.reviewRunId,
      };
      pass._hash = signReviewPass(
        STORY_ID, pass.id, pass.agent, pass.note, pass.createdAt,
        REVIEW_ROUND, pass.reviewRunId,
      );
      return pass;
    });
    store.writeReviewRuns(STORY_ID, { runs });
    store.writeReviewPasses(STORY_ID, { passes });
    assertQuorumRefuses(registry, store, root, 'compatibility-only quorum refusal');
    const floor = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: store.readStory(STORY_ID),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: store.readProcessEvents(STORY_ID),
      materialHash,
      storyFilesHash,
    });
    assert.equal(floor.ok, false, 'rejected compatibility-only receipts cannot cross the quorum boundary into floor evidence');
    assert.equal(floor.localRounds.validRounds.length, 0, 'quorum refusal leaves no countable host-verdict round');
    assert.equal(floor.proofAdmissibility.artifactKind, 'host-verdict');
    store.writeReviewRuns(STORY_ID, { runs: [] });
    store.writeReviewPasses(STORY_ID, { passes: [] });
  });

  check('refuses when reviewer passes are stale and writes no verdicts', () => {
    const checklist = store.readChecklist(STORY_ID);
    store.writeChecklist(STORY_ID, {
      items: [
        ...checklist.items,
        ...Array.from({ length: 60 }, (_, index) => ({
          id: `CHK-PAD-${String(index + 1).padStart(3, '0')}`,
          title: `Current unaffected acceptance context ${index + 1}`,
          context: `Authoritative current full-context padding ${index + 1} ${'x'.repeat(160)}`,
          status: 'done' as const,
          startTime: null,
          endTime: null,
          relatedDocs: [],
          files: { modify: [], create: [], test: [] },
          verificationIntent: { happy: [], edge: [], adversarial: [] },
        })),
      ],
    });
    recordReviewerPasses(registry);
    commitMaterialChange(root);
    assertQuorumRefuses(registry, store, root, 'stale reviewer pass refusal');
  });

  check('machine REVIEW and quorum consume the same full-envelope replay/tamper proof', () => {
    recordReviewerPasses(registry);
    const machineContext: StoryMachineContext = {
      storyId: STORY_ID,
      store,
      projectRoot: root,
      gitCwd: root,
    };
    const currentEnvelopeEvidence = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.equal(
      canPassReviewGuard(machineContext),
      true,
      `current canonical full-envelope evidence passes REVIEW; invalid=${JSON.stringify(currentEnvelopeEvidence.invalid)}`,
    );
    const qualityRun = [...store.readReviewRuns(STORY_ID).runs]
      .reverse()
      .find(run => run.lane === 'proof-or-stop-review-quality');
    assert.ok(qualityRun, 'quality reviewer run exists for thin host-render verification');
    assert.equal(
      verifyReviewRunPromptEnvelope(store, qualityRun).ok,
      true,
      'global-thin full-envelope dispatch and review-run verification need no project host prompt assets',
    );
    const data = store.readPromptEnvelopes(STORY_ID);
    const original = data.envelopes[0];
    assert.ok(original, 'full-envelope reviewer run persists an envelope');
    const replayed = {
      ...original,
      reviewRound: 'replayed-round',
    };
    replayed.envelopeId = computePromptEnvelopeId(replayed);
    store.writePromptEnvelopes(STORY_ID, {
      envelopes: [replayed, ...data.envelopes.slice(1)],
    });
    assert.equal(canPassReviewGuard(machineContext), false, 'machine REVIEW rejects a replayed envelope');
    assertQuorumRefuses(registry, store, root, 'quorum rejects the same replayed envelope');
    store.writePromptEnvelopes(STORY_ID, data);
    assert.equal(canPassReviewGuard(machineContext), true, 'restoring exact envelope bytes restores REVIEW evidence');
  });

  check('explicit full-asset mode binds Claude and Codex independently and rejects selected-host drift', () => {
    const primaryCwd = process.cwd();
    for (const selected of [
      {
        host: 'codex',
        provider: 'codex',
        assetPath: `${PROOF_OR_STOP_ADAPTER_DIR}/agents/proof-or-stop-review-quality.md`,
        otherAssetDir: '.claude/agents',
      },
      {
        host: 'claude',
        provider: 'claude-code',
        assetPath: '.claude/agents/proof-or-stop-review-quality.md',
        otherAssetDir: '.proof-or-stop-codex/agents',
      },
    ] as const) {
      const full = makeFixture('full', selected.host);
      try {
        process.chdir(full.root);
        assert.equal(existsSync(join(full.root, selected.otherAssetDir)), false, `${selected.host} fixture has no other-host assets`);
        recordReviewerPasses(full.registry, selected.provider);
        const machineContext: StoryMachineContext = {
          storyId: STORY_ID,
          store: full.store,
          projectRoot: full.root,
          gitCwd: full.root,
        };
        assert.equal(canPassReviewGuard(machineContext), true, `${selected.host}-only full-asset reviewer evidence passes`);
        const qualityRun = [...full.store.readReviewRuns(STORY_ID).runs]
          .reverse()
          .find(run => run.lane === 'proof-or-stop-review-quality');
        assert.ok(qualityRun, `${selected.host} quality reviewer run exists for full-asset drift verification`);
        const qualityDispatch = [...full.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'proof-or-stop-review-quality',
        );
        assert.equal(
          qualityDispatch?.hostRenderHost,
          selected.host,
          `dispatch provenance records the selected ${selected.host} host`,
        );
        const originalQualityAsset = readFileSync(join(full.root, selected.assetPath), 'utf8');
        write(full.root, selected.assetPath, `${originalQualityAsset}\n<!-- selected-host drift -->\n`);
        const driftedHostVerification = verifyReviewRunPromptEnvelope(full.store, qualityRun);
        assert.equal(driftedHostVerification.ok, false, `${selected.host} asset drift invalidates the bound Prompt Envelope`);
        assert.match(
          driftedHostVerification.reason ?? '',
          new RegExp(`host render identity|${selected.host} reviewer prompt asset drift`),
          `full-asset drift is rejected by the selected ${selected.host} render boundary`,
        );
        assert.equal(canPassReviewGuard(machineContext), false, `machine REVIEW rejects selected ${selected.host} asset drift`);
        write(full.root, selected.assetPath, originalQualityAsset);
        assert.equal(canPassReviewGuard(machineContext), true, `restoring exact ${selected.host} bytes restores REVIEW evidence`);
      } finally {
        process.chdir(primaryCwd);
        rmSync(full.root, { recursive: true, force: true });
        resetConfigCache();
      }
    }
  });

  let result: any;
  check('emits exactly rounds x 2 verdicts after current reviewer passes', () => {
    recordReviewerPasses(registry);
    const machineContext: StoryMachineContext = {
      storyId: STORY_ID,
      store,
      projectRoot: root,
      gitCwd: root,
    };
    for (const lane of REVIEW_LANES) {
      const latestRun = [...store.readReviewRuns(STORY_ID).runs].reverse().find(run => run.lane === lane)!;
      const latestEnvelope = store.readPromptEnvelopes(STORY_ID).envelopes.find(
        envelope => envelope.envelopeId === latestRun.envelopeId,
      )!;
      assert.equal(latestEnvelope.contextMode, 'incremental', `${lane} second same-material run uses trusted incremental context`);
      assert.equal(latestEnvelope.selectionReason, 'SAFE_INCREMENTAL');
      assert.equal(verifyReviewRunPromptEnvelope(store, latestRun).ok, true);
    }
    const qualityRun = [...store.readReviewRuns(STORY_ID).runs].reverse().find(
      run => run.lane === 'proof-or-stop-review-quality',
    )!;
    const postRunFinding: Finding = {
      id: `${STORY_ID}:F-CUTOFF`,
      desc: 'Low-severity finding recorded after the incremental ReviewRun snapshot.',
      severity: 'low',
      category: 'edge',
      status: 'open',
      evidenceState: 'verified',
      agent: 'proof-or-stop-review-quality',
      createdAt: new Date(Date.parse(qualityRun.startedAt) + 1_000).toISOString(),
      reviewRound: qualityRun.reviewRound,
      reviewRunId: qualityRun.reviewRunId,
    };
    postRunFinding._hash = signFinding(
      STORY_ID,
      postRunFinding.id,
      postRunFinding.desc,
      postRunFinding.severity,
      postRunFinding.createdAt!,
      postRunFinding.reviewRound!,
      postRunFinding.reviewRunId!,
    );
    const originalFindings = store.readFindings(STORY_ID);
    store.writeFindings(STORY_ID, { findings: [...originalFindings.findings, postRunFinding] });
    assert.equal(
      verifyReviewRunPromptEnvelope(store, qualityRun).ok,
      true,
      'a finding created after ReviewRun start cannot self-invalidate the frozen incremental basis',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(record => record.id === postRunFinding.id),
      'the post-run finding remains visible as reviewer evidence even though it is outside the frozen basis',
    );
    store.writeFindings(STORY_ID, originalFindings);

    const envelopeData = store.readPromptEnvelopes(STORY_ID);
    const qualityEnvelopeIndex = envelopeData.envelopes.findIndex(
      envelope => envelope.envelopeId === qualityRun.envelopeId,
    );
    assert.ok(qualityEnvelopeIndex >= 0);
    const originalQualityEnvelope = envelopeData.envelopes[qualityEnvelopeIndex];
    const tamperCases: Array<[string, unknown]> = [
      ['impactPolicyVersion', 'tampered-policy'],
      ['eligibilityReasonCodes', ['ELIGIBLE_ATTACKER_OVERRIDE']],
      ['freshnessClassification', 'ATTACKER_FRESH'],
      ['priorPassRef', 'attacker-pass'],
      ['changedFilesDigest', 'attacker-changed-files'],
      ['impactedFilesDigest', 'attacker-impacted-files'],
      ['reviewBasisDigest', 'attacker-basis'],
      ['incrementalContextDigest', 'attacker-context'],
      ['taskSemanticDigest', 'attacker-task'],
      ['selectionReason', 'FULL_CHEAPER_OR_EQUAL'],
    ];
    for (const [field, value] of tamperCases) {
      const tampered = { ...originalQualityEnvelope, [field]: value };
      const envelopes = [...envelopeData.envelopes];
      envelopes[qualityEnvelopeIndex] = tampered;
      store.writePromptEnvelopes(STORY_ID, { envelopes });
      assert.equal(canPassReviewGuard(machineContext), false, `${field} tamper is rejected by REVIEW`);
      assert.ok(
        collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(issue => issue.reviewRunId === qualityRun.reviewRunId),
        `${field} tamper is rejected by the shared evidence collector`,
      );
      assertQuorumRefuses(registry, store, root, `${field} tamper is rejected by quorum`);
    }
    store.writePromptEnvelopes(STORY_ID, envelopeData);
    assert.equal(canPassReviewGuard(machineContext), true, 'restoring the exact incremental envelope restores REVIEW');

    const originalChecklist = store.readChecklist(STORY_ID);
    store.writeChecklist(STORY_ID, {
      items: originalChecklist.items.map(item => ({
        ...item,
        context: `${item.context ?? ''} model-relevant attacker drift`,
      })),
    });
    assert.equal(canPassReviewGuard(machineContext), false, 'incremental run is rejected when authoritative recomputation requires full');
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(issue => issue.reviewRunId === qualityRun.reviewRunId),
      'wrong-mode incremental evidence is rejected by the shared collector',
    );
    assertQuorumRefuses(registry, store, root, 'wrong-mode incremental run is rejected by quorum');
    store.writeChecklist(STORY_ID, originalChecklist);
    assert.equal(canPassReviewGuard(machineContext), true, 'restoring authoritative task context restores incremental evidence');

    const handler = registry.get('quorum_submit');
    assert.ok(handler, 'quorum_submit handler is registered');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);
    result = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke local voluntary quorum',
      format: 'json',
    });
    assert.equal(result.schemaVersion, 'lattice.quorum_submit.v1');
    assert.equal(result.emittedCount, 6);
    assert.equal(result.verdictIds.length, 6);
    assert.deepEqual(result.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]);
    assert.equal(listVerdicts(root, 'local', STORY_ID).length, 6);
    const afterHead = git(root, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'quorum_submit atomically commits its six host_verdict rows');
    const storyRel = relative(root, store.storyDirPath(STORY_ID)).replace(/\\/g, '/');
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--', `${storyRel}/process-events.jsonl`]),
      '',
      'quorum_submit leaves canonical process-events metadata clean',
    );
    assert.deepEqual(
      git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', afterHead]).split('\n').filter(Boolean),
      [`${storyRel}/process-events.jsonl`],
      'the quorum closeout commit contains only the exact host_verdict event file',
    );
    assert.doesNotThrow(
      () => captureLifecycleMetadataTransaction({
        root,
        gitCwd: root,
        storyId: STORY_ID,
        storyRel,
        kind: 'codex-command-terminal',
      }),
      'a following canonical validation writer can capture clean metadata instead of refusing pre-dirty process-events',
    );
  });

  check('review_escalation_status and review assurance floor report complete voluntary 3x2 rounds', () => {
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound, 2);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.complete, true);

    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'current material hash exists');
    store.appendProcessEvent(STORY_ID, {
      type: 'review_escalation_policy',
      storyId: STORY_ID,
      command: 'quorum-submit-smoke',
      timestamp: '2026-06-22T10:10:00.000Z',
      policyId: `${STORY_ID}:POL-quorum-smoke`,
      predicate: 'explicitlyConfiguredHighRiskPolicyRequires3x2',
      requires3x2: true,
      policyVersion: 'quorum-submit-smoke.v1',
      riskClass: 'process-fact',
      sourcePolicyRef: 'packages/main/src/tasks/quorum-submit-smoke.ts',
      rolloutStage: 'enforced',
      degradedFallbackAllowed: true,
      issuer: 'quorum-submit-smoke',
      issuedAt: '2026-06-22T10:10:00.000Z',
      headHash: git(root, ['rev-parse', 'HEAD']),
      materialHash,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    });
    const status = registry.get('review_escalation_status');
    assert.ok(status, 'review_escalation_status handler is registered');
    const escalation = status({ storyId: STORY_ID, json: true }) as any;
    assert.equal(escalation.required, true);
    assert.equal(escalation.ok, true);
    assert.equal(escalation.assuranceLevel, 'full-3x2');
    assert.equal(escalation.proofAdmissibility.allowed, true);
    assert.equal(escalation.proofAdmissibility.overall, 'pass');

    const assurance = evaluateReviewAssuranceFloor({
      projectRoot: root,
      storyId: STORY_ID,
      store,
      changedFiles: ['packages/main/src/core/process-fact-registry.ts'],
      materialHash,
    });
    assert.equal(assurance.localRounds.validRounds.length, 3);
    assert.equal(assurance.localRounds.requiredRounds, 3);
    assert.equal(assurance.localRounds.requiredPassingHostsPerRound, 2);
    assert.equal(assurance.localRounds.ok, true);
  });

  check('auto-computed materialDigest and storyFilesHash match current helpers', () => {
    assert.equal(result.materialDigest, currentMaterialHash(root));
    assert.equal(result.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root));
    assert.match(result.validationDigest, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostA, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostB, /^[0-9a-f]{64}$/);
  });

  check('hosts are independent by hostId, sessionId, and keyId', () => {
    const { hostA, hostB } = result.hosts;
    assert.notEqual(hostA.hostId.toLowerCase(), hostB.hostId.toLowerCase());
    assert.notEqual(hostA.sessionId.toLowerCase(), hostB.sessionId.toLowerCase());
    assert.notEqual(hostA.keyId.toLowerCase(), hostB.keyId.toLowerCase());
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
      assert.equal(summary.duplicateVerdicts, 0);
    }
  });

  check('never sets authorityDone, fullAuthorityDone, or productionDone', () => {
    assert.equal(result.authorityDone, false);
    assert.equal(result.fullAuthorityDone, false);
    assert.equal(result.productionDone, false);
    assert.equal(result.reviewEscalationStatus.authorityDone, false);
    assert.equal(result.reviewEscalationStatus.fullAuthorityDone, false);
    assert.equal(result.reviewEscalationStatus.productionDone, false);
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.authorityDone, false);
      assert.equal(summary.fullAuthorityDone, false);
      assert.equal(summary.multiHostVerified, false);
    }
  });

  check('refuses a same-material re-submit and writes no new verdicts', () => {
    // No material change since the rounds=3 quorum above, so runIds r1..r3 already carry
    // verdicts at the current materialDigest. A second quorum_submit must refuse instead of
    // silently piling duplicate verdicts onto the same runIds.
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'claude-host',
        hostB: 'codex-host',
        rounds: 3,
        providerA: 'claude',
        providerB: 'codex',
        note: 'quorum_submit smoke same-material re-submit',
        format: 'json',
      }),
      /quorum_submit refuses: verdicts already exist for runId/,
      'same-material re-submit is refused',
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents, 'same-material refusal writes no host_verdict events');
    assert.equal(verdictFileCount(root), beforeVerdicts, 'same-material refusal writes no verdict files');
  });

  check('same-material duplicate refusal survives deletion of the ignored verdict cache', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const beforeEvents = hostVerdictEventCount(fixture.store);
      rmSync(join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID), { recursive: true, force: true });
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /quorum_submit refuses: verdicts already exist for runId/,
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), beforeEvents);
    });
  });

  check('allows a fresh quorum after a material change', () => {
    // A real material change (new commit) yields a different materialDigest, so the guard
    // does not collide and a fresh quorum is allowed for the same runIds.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const freshResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke fresh-material re-quorum',
      format: 'json',
    });
    assert.equal(freshResult.emittedCount, 6, 'fresh-material re-quorum emits rounds x 2 verdicts');
    assert.equal(verdictFileCount(root) - beforeVerdicts, 6, 'fresh-material re-quorum writes new verdict files');
    for (const runId of freshResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2, {
        currentAnchor: { materialDigest: freshResult.materialDigest },
      });
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
  });

  check('--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds', () => {
    // INIT product-reviewer advisory: prove the rounds knob is honored for N != 3.
    // Advance the material first so the rounds=2 quorum runs at a fresh materialDigest and
    // does not collide with the r1/r2 verdicts already written at earlier materials.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const customRounds = 2;
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const customResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: customRounds,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke custom-rounds quorum',
      format: 'json',
    });
    assert.equal(customResult.rounds, customRounds, '--rounds=N is reflected in result.rounds');
    assert.equal(customResult.emittedCount, customRounds * 2, '--rounds=N emits N x 2 verdicts');
    assert.equal(customResult.verdictIds.length, customRounds * 2);
    assert.deepEqual(customResult.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`]);
    // exactly N x 2 new host_verdict events and verdict files were added by this call.
    assert.equal(hostVerdictEventCount(store) - beforeEvents, customRounds * 2, '--rounds=N writes N x 2 host_verdict events');
    assert.equal(verdictFileCount(root) - beforeVerdicts, customRounds * 2, '--rounds=N writes N x 2 verdict files');
    for (const runId of customResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
    assert.equal(customResult.authorityDone, false);
    assert.equal(customResult.fullAuthorityDone, false);
    assert.equal(customResult.productionDone, false);
  });

  check('refuses a redundant re-submit when the standing quorum drift-accepts', () => {
    // B-3144 RED: after a merge that moves materialHash but NOT storyFilesHash, the floor
    // still accepts the standing quorum (eventsWithStoryFilesHashDowngrade rewrites its
    // verdicts to the current material), so a redundant re-submit must be REFUSED. Pre-fix,
    // the guard compares only raw materialDigest, accepts the re-submit, and every round then
    // collapses as "duplicate host/session/key identity" — the B-bf52 poisoning.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      const first: any = handler(quorumArgs());
      assert.equal(first.emittedCount, 6, 'baseline quorum emits 3 rounds x 2 hosts');
      const storyHashBefore = currentStoryFilesHash(fixture.root, 'HEAD', fixture.root);
      // CHK-001:edge:0 (F-006): storyFilesHash equality is necessary but NOT sufficient, so also
      // capture the independent file-level story-owned blob set before the drift.
      const storyBlobsBefore = storyOwnedDiffBlobs(fixture.root);
      const preDriftHead = git(fixture.root, ['rev-parse', 'HEAD']);
      commitMainDrift(fixture.root);
      const storyHashAfter = currentStoryFilesHash(fixture.root, 'HEAD', fixture.root);
      assert.equal(storyHashAfter, storyHashBefore, 'incident precondition: main drift must not move storyFilesHash');
      // F-006: independent witness — the drift really did change the tree (main-drift.ts appears
      // in the whole-tree diff), yet the story-owned changed-file set and every one of its
      // destination blob ids are byte-identical, so zero story-owned blobs were touched.
      const driftedPaths = wholeTreeDiffPaths(fixture.root, preDriftHead);
      assert.ok(
        driftedPaths.includes('packages/main/src/main-drift.ts'),
        `drift precondition: the merge must actually introduce main-drift.ts (${driftedPaths.join(', ')})`,
      );
      const storyBlobsAfter = storyOwnedDiffBlobs(fixture.root);
      assert.ok(storyBlobsBefore.length > 0, 'the story-owned diff set is non-empty, so equality below is not vacuous');
      assert.deepEqual(
        storyBlobsAfter,
        storyBlobsBefore,
        'commitMainDrift touches ZERO story-owned blobs: identical (path, status, blob id) triples across the drift',
      );
      assert.ok(
        storyBlobsAfter.every(entry => !entry.startsWith('packages/main/src/main-drift.ts\0')),
        'the drift file never enters the story-owned diff set',
      );
      const materialAfter = currentMaterialHash(fixture.root, 'HEAD', fixture.root);
      assert.ok(materialAfter && materialAfter !== first.materialDigest, 'incident precondition: main drift must move materialHash');
      recordReviewerPasses(fixture.registry);
      const beforeEvents = hostVerdictEventCount(fixture.store);
      const beforeVerdicts = verdictFileCount(fixture.root);
      // CHK-002:adversarial:2 (F-005): the refusal must leak NO state, HEAD included.
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      let refusal: unknown = null;
      try {
        handler(quorumArgs());
      } catch (error) {
        refusal = error;
      }
      if (refusal === null) {
        // Pre-fix path: prove the poisoning consequence so the repro is un-gameable, then
        // fail with the forensic detail the fix must prevent.
        const advisories: string[] = [];
        const effective = eventsWithStoryFilesHashDowngrade(
          fixture.store.readProcessEvents(STORY_ID),
          materialAfter!,
          storyHashAfter ?? null,
          advisories,
        );
        const rounds = evaluateHostVerdictRounds(effective, materialAfter!, 2);
        const reasons = rounds.invalidRounds.map(round => `${round.runId}: ${round.reasons.join('; ')}`);
        assert.fail(
          'redundant re-submit was accepted and poisoned the standing quorum: '
          + `validRounds=${rounds.validRounds.length} invalidRounds=${rounds.invalidRounds.length} (${reasons.join(' | ')})`,
        );
      }
      const refusalMessage = String((refusal as Error).message);
      assert.match(
        refusalMessage,
        /quorum_submit refuses: .*drift-accept/i,
        'refusal names the standing drift-accepted quorum',
      );
      // CHK-002:edge:2 (F-003): assert the refusal message CONTENT, not just the branch keyword —
      // the operator must be able to act on it without reading the source.
      for (const runId of [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]) {
        assert.ok(refusalMessage.includes(runId), `refusal names the standing runId ${runId}: ${refusalMessage}`);
      }
      assert.ok(
        first.materialDigest && refusalMessage.includes(String(first.materialDigest)),
        `refusal names the older standing materialDigest ${first.materialDigest}: ${refusalMessage}`,
      );
      assert.ok(
        storyHashAfter && refusalMessage.includes(String(storyHashAfter)),
        `refusal names the current storyFilesHash ${storyHashAfter}: ${refusalMessage}`,
      );
      assert.ok(
        refusalMessage.includes('review_escalation_status'),
        `refusal points at review_escalation_status: ${refusalMessage}`,
      );
      assert.equal(hostVerdictEventCount(fixture.store), beforeEvents, 'refusal writes no host_verdict events');
      assert.equal(verdictFileCount(fixture.root), beforeVerdicts, 'refusal writes no verdict files');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'refusal does not advance HEAD');
    });
  });

  check('blank storyFilesHash on committed legacy verdicts is no-signal for the drift branch', () => {
    // CHK-002:edge:0 (OQ-1): legacy verdict events written before storyFilesHash existed carry
    // no drift-accept claim, so the guard must not fabricate a collision from a blank field —
    // the resubmission proceeds exactly as it did pre-fix.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      const first: any = handler(quorumArgs());
      assert.equal(first.emittedCount, 6);
      const eventsPath = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const legacyLines = readFileSync(eventsPath, 'utf8').split('\n').map((line) => {
        if (!line.trim()) return line;
        const row = JSON.parse(line);
        if (row.type === 'host_verdict') delete row.storyFilesHash;
        return JSON.stringify(row);
      }).join('\n');
      writeFileSync(eventsPath, legacyLines, 'utf8');
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'strip storyFilesHash to simulate legacy verdicts']);
      commitMainDrift(fixture.root);
      recordReviewerPasses(fixture.registry);
      const second: any = handler(quorumArgs());
      assert.equal(second.emittedCount, 6, 'legacy no-signal verdicts do not collide on the drift branch');
    });
  });

  check('EMPTY_STORY_FILES_HASH current state allows resubmit instead of falsely drift-accepting (F-035)', () => {
    // F-035: mirrors eventsWithStoryFilesHashDowngrade's top-level EMPTY_STORY_FILES_HASH
    // exclusion (review-escalation.ts:975). When the story owns ZERO files (current
    // storyFilesHash === sha256('')), the floor never drift-accepts ANY event -- two
    // "owns nothing" hashes are not evidence of "unchanged" -- so a stale-material verdict
    // whose own storyFilesHash also happens to equal EMPTY_STORY_FILES_HASH must NOT be
    // treated by the guard as a drift-accept collision; the resubmit must be ALLOWED,
    // matching the floor holding zero valid assurance for that round.
    withFreshFixture((fixture) => {
      // Revert the fixture's story-owned diff-causing file back to its main-branch content so
      // the NET diff between merge-base(main) and HEAD is empty -> currentStoryFilesHash
      // resolves to EMPTY_STORY_FILES_HASH.
      git(fixture.root, ['checkout', 'main', '--', 'packages/main/src/index.ts']);
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'revert story diff to empty']);
      const emptyStoryFilesHash = currentStoryFilesHash(fixture.root, 'HEAD', fixture.root);
      assert.equal(emptyStoryFilesHash, EMPTY_STORY_FILES_HASH, 'fixture precondition: story owns zero files');
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      const first: any = handler(quorumArgs());
      assert.equal(first.emittedCount, 6);
      commitMainDrift(fixture.root);
      assert.equal(
        currentStoryFilesHash(fixture.root, 'HEAD', fixture.root),
        EMPTY_STORY_FILES_HASH,
        'fixture precondition: still owns zero files after main drift',
      );
      recordReviewerPasses(fixture.registry);
      const second: any = handler(quorumArgs());
      assert.equal(
        second.emittedCount,
        6,
        'a resubmit at EMPTY_STORY_FILES_HASH is allowed, not falsely refused as drift-accepted',
      );
    });
  });

  check('a second main drift does not circumvent the drift-accept refusal', () => {
    // CHK-002:adversarial:0: merging main twice moves the material again but the story-owned
    // diff is still untouched, so the standing quorum still drift-accepts and the guard must
    // keep refusing.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      handler(quorumArgs());
      commitMainDrift(fixture.root);
      recordReviewerPasses(fixture.registry);
      assert.throws(() => handler(quorumArgs()), /drift-accept/i, 'first drift refuses');
      commitMainDrift(fixture.root);
      recordReviewerPasses(fixture.registry);
      assert.throws(() => handler(quorumArgs()), /drift-accept/i, 'second drift still refuses');
      assert.equal(hostVerdictEventCount(fixture.store), 6, 'still exactly the original six verdicts');
    });
  });

  check('a story-owned file change after main drift makes the re-quorum genuine again', () => {
    // CHK-002:adversarial:1 boundary: once the story-owned diff itself changes (storyFilesHash
    // moves), the old verdicts no longer drift-accept and a fresh quorum is legitimate even
    // though a main drift also happened.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      const first: any = handler(quorumArgs());
      commitMainDrift(fixture.root);
      commitMaterialChange(fixture.root);
      recordReviewerPasses(fixture.registry);
      const second: any = handler(quorumArgs());
      assert.equal(second.emittedCount, 6, 'fresh quorum allowed once storyFilesHash moves');
      assert.notEqual(second.storyFilesHash, first.storyFilesHash, 'storyFilesHash genuinely moved');
    });
  });

  check('refuses pre-existing user dirt before writing any verdict', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      write(fixture.root, 'user-notes.txt', 'preserve me\n');
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /worktree\/index must be clean/,
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(readFileSync(join(fixture.root, 'user-notes.txt'), 'utf8'), 'preserve me\n');
      assert.equal(hostVerdictEventCount(fixture.store), 0);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('foreign append fails exact verification and rolls back only the six owned verdicts', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const foreign = JSON.stringify({ type: 'foreign_concurrent_event', marker: 'preserve-foreign-append' }) + '\n';
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          afterAddBeforeCommit: () => appendFileSync(processEvents, foreign, 'utf8'),
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /atomic closeout failed.*rolled back/s);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(verdictFileCount(fixture.root), 0);
      const after = readFileSync(processEvents, 'utf8');
      assert.match(after, /preserve-foreign-append/);
      assert.doesNotMatch(after, /"type":"host_verdict"/);
    });
  });

  check('capture-time failure rolls back the just-written event and verdict JSON', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const baseline = readFileSync(processEvents);
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        beforeCaptureOwnedVerdict: () => {
          throw new Error('deterministic capture-time failure after submitLocalVerdict');
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /capture-time failure/);
      assert.deepEqual(readFileSync(processEvents), baseline);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('between-row foreign append preserves foreign bytes and rolls back row two', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const baseline = readFileSync(processEvents);
      const foreign = Buffer.from('{"type":"foreign_between_rows","marker":"keep"}\n');
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        afterVerdictWrite: ({ emittedCount }) => {
          if (emittedCount === 1) appendFileSync(processEvents, foreign);
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /changed bytes outside its append boundary/);
      assert.deepEqual(readFileSync(processEvents), Buffer.concat([baseline, foreign]));
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('writer-owned append identity never claims a foreign row inserted before host_verdict', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const baseline = readFileSync(processEvents);
      const originalAppend = fixture.store.appendProcessEvent.bind(fixture.store);
      let injected = false;
      let foreignBytes = Buffer.alloc(0);
      fixture.store.appendProcessEvent = ((storyId, event) => {
        if (!injected && event.type === 'host_verdict') {
          injected = true;
          originalAppend(storyId, {
            type: 'foreign_pre_host_append',
            marker: 'preserve-writer-boundary',
          });
          foreignBytes = Buffer.from(readFileSync(processEvents).subarray(baseline.length));
        }
        return originalAppend(storyId, event);
      }) as typeof fixture.store.appendProcessEvent;

      const handler = createQuorumSubmitHandlers(fixture.ctx).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /atomic closeout failed/);
      assert.ok(foreignBytes.length > 0);
      assert.deepEqual(readFileSync(processEvents), Buffer.concat([baseline, foreignBytes]));
      assert.equal(hostVerdictEventCount(fixture.store), 0);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('rollback never deletes an owned-row byte sequence embedded inside foreign binary', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const baseline = readFileSync(processEvents);
      let expected = Buffer.alloc(0);
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          afterAddBeforeCommit: () => {
            const current = readFileSync(processEvents);
            const firstEnd = current.indexOf(0x0a, baseline.length) + 1;
            assert.ok(firstEnd > baseline.length);
            const originalFirst = Buffer.from(current.subarray(baseline.length, firstEnd));
            const mutatedFirst = Buffer.from(originalFirst);
            const pass = Buffer.from('"decision":"pass"');
            const passAt = mutatedFirst.indexOf(pass);
            assert.ok(passAt >= 0);
            Buffer.from('"decision":"fail"').copy(mutatedFirst, passAt);
            const foreign = Buffer.concat([
              Buffer.from([0xff, 0x00]),
              originalFirst,
              Buffer.from([0x00, 0xfe]),
            ]);
            expected = Buffer.concat([baseline, mutatedFirst, foreign]);
            writeFileSync(processEvents, Buffer.concat([
              baseline,
              mutatedFirst,
              current.subarray(firstEnd),
              foreign,
            ]));
          },
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /atomic closeout failed/);
      assert.ok(expected.length > 0);
      assert.deepEqual(readFileSync(processEvents), expected);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('same-verdictId mutation of a gate-consumed field is refused and rolled back', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        afterVerdictWrite: ({ emittedCount }) => {
          if (emittedCount !== 6) return;
          const lines = readFileSync(processEvents, 'utf8').trimEnd().split('\n');
          const forged = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
          forged.decision = 'fail';
          lines[lines.length - 1] = JSON.stringify(forged);
          writeFileSync(processEvents, `${lines.join('\n')}\n`, 'utf8');
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /exact canonical host_verdict bytes/);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), 1, 'concurrently forged row is preserved but remains uncommitted');
      assert.match(readFileSync(processEvents, 'utf8'), /"decision":"fail"/);
      assert.match(git(fixture.root, ['status', '--porcelain=v1', '--', processEvents]), /^M /);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('rollback preserves a concurrently changed verdict JSON with the same verdictId', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      let changedPath = '';
      let changedBytes = Buffer.alloc(0);
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        afterVerdictWrite: ({ verdictId, emittedCount }) => {
          if (emittedCount !== 6) return;
          changedPath = join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID, `${verdictId}.json`);
          const value = JSON.parse(readFileSync(changedPath, 'utf8')) as Record<string, unknown>;
          value.note = 'foreign concurrent replacement with same verdictId';
          changedBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
          writeFileSync(changedPath, changedBytes);
        },
        metadataCommit: {
          beforeAdd: () => { throw new Error('force rollback after verdict-file mutation'); },
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /rollback conflicts preserved.*verdict bytes changed/s);
      assert.ok(changedPath);
      assert.deepEqual(readFileSync(changedPath), changedBytes);
      assert.equal(hostVerdictEventCount(fixture.store), 0);
    });
  });

  check('rollback preserves non-UTF8 blank and unterminated foreign suffix bytes exactly', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const baseline = readFileSync(processEvents);
      const foreign = Buffer.from([0x0a, 0x0a, 0xff, 0x00, 0x7b, 0x7d]);
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          afterAddBeforeCommit: () => appendFileSync(processEvents, foreign),
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /atomic closeout failed/);
      assert.deepEqual(readFileSync(processEvents), Buffer.concat([baseline, foreign]));
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('commit-hook rejection rolls back all rows and a clean retry succeeds once', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const hook = join(fixture.root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 23\n', 'utf8');
      chmodSync(hook, 0o755);
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /git pre-commit hook failed.*all emitted verdicts were rolled back/s,
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), 0);
      assert.equal(verdictFileCount(fixture.root), 0);
      rmSync(hook);
      const retry: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(retry.emittedCount, 6);
      assert.equal(hostVerdictEventCount(fixture.store), 6);
      assert.equal(verdictFileCount(fixture.root), 6);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
    });
  });

  check('atomic quorum commit hashes process-events larger than one MiB', () => {
    withFreshFixture((fixture) => {
      seedLargeCommittedProcessEvents(fixture);
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const result: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(result.emittedCount, 6);
      assert.equal(hostVerdictEventCount(fixture.store), 6);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'large immutable metadata tree is installed atomically');
      const committedHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const beforeRetryEvents = hostVerdictEventCount(fixture.store);
      rmSync(join(fixture.root, '.lattice', 'autopilot-verdicts', STORY_ID), { recursive: true, force: true });
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /quorum_submit refuses: verdicts already exist for runId/,
        'the committed >1MiB process-events log remains the duplicate authority after cache deletion',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), committedHead, 'large same-material retry writes no commit');
      assert.equal(hostVerdictEventCount(fixture.store), beforeRetryEvents, 'large same-material retry writes no event');
    });
  });

  check('large atomic quorum commit still rejects a post-manifest mutation', () => {
    withFreshFixture((fixture) => {
      const processEvents = seedLargeCommittedProcessEvents(fixture);
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          afterAddBeforeCommit: () => appendFileSync(processEvents, `${JSON.stringify({
            type: 'plan_updated',
            timestamp: '2026-06-22T10:05:00.000Z',
            mutation: 'post-manifest',
          })}\n`),
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /verified metadata changed.*rolled back/s);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), 0);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('HEAD movement loses the CAS without reverting the competing HEAD', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      let movedHead = '';
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          beforeCasUpdate: (oldHead, targetRef) => {
            const tree = git(fixture.root, ['rev-parse', `${oldHead}^{tree}`]);
            movedHead = git(fixture.root, [...COMMIT_ENV, 'commit-tree', tree, '-p', oldHead, '-m', 'foreign HEAD movement']);
            git(fixture.root, ['update-ref', targetRef, movedHead, oldHead]);
          },
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /HEAD changed before isolated metadata commit CAS.*rolled back/s);
      assert.ok(movedHead);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), movedHead);
      assert.notEqual(movedHead, beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), 0);
      assert.equal(verdictFileCount(fixture.root), 0);
    });
  });

  check('rollback conflict preserves competing prefix bytes and removes every countable verdict', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const processEvents = join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
      const handler = createQuorumSubmitHandlers(fixture.ctx, {
        metadataCommit: {
          afterAddBeforeCommit: () => {
            const bytes = readFileSync(processEvents);
            bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
            writeFileSync(processEvents, bytes);
          },
        },
      }).quorum_submit;
      assert.throws(() => handler(quorumArgs()), /rollback conflicts preserved.*pre-quorum bytes changed and were preserved/s);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(verdictFileCount(fixture.root), 0);
      const after = readFileSync(processEvents, 'utf8');
      assert.doesNotMatch(after, /"type":"host_verdict"/);
      assert.equal(after.charCodeAt(0), 0x20, 'competing prefix mutation is preserved byte-for-byte');
    });
  });

  check('rejects non-independent host identity before writing additional verdicts', () => {
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'same-host',
        hostB: 'different-host',
        sessionA: 'shared-session',
        sessionB: 'shared-session',
        format: 'json',
      }),
      /hostA and hostB must be independent/,
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents);
    assert.equal(verdictFileCount(root), beforeVerdicts);
  });

  check('quorum_prune dry-run lists the poisoned duplicates without mutating', () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const collapsed = quorumFloorRounds(fixture);
      assert.equal(collapsed.validRounds.length, 0, 'poisoned floor has zero valid rounds');
      assert.ok(
        collapsed.invalidRounds.some(round => round.reasons.some(reason => /duplicate host\/session\/key identity/.test(reason))),
        'poisoning collapses rounds as duplicate host/session/key identity',
      );
      const result: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      assert.equal(result.applied, false, 'dry-run does not apply');
      assert.equal(result.dryRun, true);
      assert.equal(result.backupPath, null, 'dry-run writes no backup');
      assert.equal(result.metadataCommitSha, null, 'dry-run makes no commit');
      assert.equal(result.duplicateGroups.length, 6, 'one duplicate group per runId per host');
      assert.equal(result.removedVerdictCount, 6, 'six losing verdict events would be removed');
      for (const group of result.duplicateGroups) {
        assert.equal(group.members.length, 2);
        assert.equal(group.members.filter((member: any) => member.disposition === 'KEEP').length, 1, 'exactly one kept per group');
        assert.equal(group.members.filter((member: any) => member.disposition === 'REMOVE').length, 1, 'exactly one removed per group');
        for (const member of group.members) {
          assert.ok(member.verdictId, 'dry-run reports verdictId');
          assert.ok(member.runId, 'dry-run reports runId');
          assert.ok(member.hostId, 'dry-run reports hostId');
          assert.ok(member.materialDigest, 'dry-run reports materialDigest');
          assert.ok(member.timestamp, 'dry-run reports timestamp');
        }
      }
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'dry-run mutates nothing');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'dry-run advances no HEAD');
      assert.equal(storyBackupFiles(fixture).length, 0, 'dry-run leaves no backup file');
    });
  });

  check('quorum_prune apply removes the losing set, backs up, and the floor returns to full-3x2', () => {
    withFreshFixture((fixture) => {
      const { originalHostVerdictLines } = injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const poisonedBytes = readFileSync(eventsPath);
      const beforeLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.equal(quorumFloorRounds(fixture).validRounds.length, 0, 'floor collapsed before prune');
      assert.equal(verdictFileCount(fixture.root), 6, 'six verdict cache files exist before prune');
      const result: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(result.applied, true);
      assert.equal(result.removedVerdictCount, 6);
      assert.ok(result.metadataCommitSha, 'apply commits the pruned log');
      assert.ok(result.backupPath && existsSync(result.backupPath), 'timestamped backup created');
      assert.match(
        result.backupPath,
        /process-events\.jsonl\.\d{4}-\d{2}-\d{2}T[0-9-]+Z(?:-\d+)?\.bak$/,
        'backup name is timestamped AND keeps the ignored .bak extension last',
      );
      assert.deepEqual(readFileSync(result.backupPath), poisonedBytes, 'backup is a byte-identical copy of the pre-prune log');
      const losing = new Set(originalHostVerdictLines);
      const expectedAfter = beforeLines.filter(line => !losing.has(line));
      assert.deepEqual(
        readFileSync(eventsPath, 'utf8').split('\n'),
        expectedAfter,
        'only the losing host_verdict lines removed; every other line byte-identical and in order',
      );
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3, 'floor returns to three valid rounds');
      assert.equal(recovered.invalidRounds.length, 0);
      for (const round of recovered.validRounds) {
        assert.equal(round.passingHostIds.length, 2, 'each recovered round has two passing independent hosts');
      }
      assert.equal(result.removedVerdictFiles.length, 6, 'losing verdict cache files were pruned best-effort');
      assert.equal(git(fixture.root, ['status', '--porcelain=v1', '--', quorumProcessEventsPath(fixture)]), '', 'pruned log is committed clean');
    });
  });

  check('quorum_prune resolves AND executes through the built CLI in the story phase (catalog + policy + DEFAULT_PHASE_TOOLS)', () => {
    // CHK-003:happy:2 (F-004): every in-scope wiring point, including the config.ts
    // DEFAULT_PHASE_TOOLS entry, is verified BEHAVIORALLY by this bound command.
    assert.ok(
      DEFAULT_PHASE_TOOLS['*'].includes('quorum_prune'),
      'config.ts DEFAULT_PHASE_TOOLS["*"] lists quorum_prune',
    );
    assert.equal(isCommandAllowed('quorum_prune', 'REVIEW'), true, 'the phase-tool resolver admits quorum_prune in the fixture story phase');
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      // Negative control FIRST: the fixture declares no phaseTools, so the CLI phase gate runs
      // against DEFAULT_PHASE_TOOLS and genuinely blocks a command that is not listed for
      // REVIEW. Without this, the exit-0 below would be vacuous.
      const blocked = runFixtureCli(fixture.root, ['plan_set', `--storyId=${STORY_ID}`]);
      assert.notEqual(blocked.status, 0, 'phase-gate control command is refused');
      assert.match(
        `${blocked.stdout}\n${blocked.stderr}`,
        /is not available in REVIEW phase/,
        'the DEFAULT_PHASE_TOOLS-driven phase gate is live in this fixture',
      );
      const dryRun = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, json: true })]);
      const combined = `${dryRun.stdout}\n${dryRun.stderr}`;
      assert.doesNotMatch(combined, /unknown command|Unknown command|not a registered command|Unknown subcommand/i, 'quorum_prune resolves as a registered command, not unknown');
      assert.doesNotMatch(combined, /is not available in REVIEW phase/, 'quorum_prune is NOT phase-refused: the DEFAULT_PHASE_TOOLS entry is live');
      assert.equal(dryRun.status, 0, `quorum_prune executes through the built CLI: ${combined}`);
      const payload = JSON.parse(dryRun.stdout.trim()) as { schemaVersion: string; duplicateGroups: unknown[]; dryRun: boolean };
      assert.equal(payload.schemaVersion, 'lattice.quorum_prune.v1', 'the real handler ran end-to-end through catalog + policy + phase gate');
      assert.equal(payload.dryRun, true);
      assert.equal(payload.duplicateGroups.length, 6, 'the dispatched handler actually projected the poisoned groups');
    });
  });

  check('quorum_prune refuses when there is nothing to prune', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /nothing to prune/,
        'a clean quorum has nothing to prune',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  });

  check('quorum_prune apply refuses on a dirty tree before any mutation', () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const poisonedBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      write(fixture.root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const dirty = true;\n');
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /worktree\/index must be clean/,
        'a dirty tree refuses before any file I/O',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(eventsPath), poisonedBytes, 'refusal leaves the poisoned log untouched');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  });

  check('quorum_prune keeps exactly one event per group for a triple-duplicate', () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture, { copies: 2 });
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      assert.equal(dry.duplicateGroups.length, 6);
      for (const group of dry.duplicateGroups) {
        assert.equal(group.members.length, 3, 'triple duplicate has three members');
        assert.equal(group.members.filter((member: any) => member.disposition === 'KEEP').length, 1, 'exactly one kept');
        assert.equal(group.members.filter((member: any) => member.disposition === 'REMOVE').length, 2, 'other two removed');
      }
      assert.equal(dry.removedVerdictCount, 12, 'six groups remove two each');
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.removedVerdictCount, 12);
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3);
      for (const round of recovered.validRounds) assert.equal(round.passingHostIds.length, 2);
    });
  });

  check('quorum_prune runIds filter prunes only the specified runIds', () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const targetRunId = `${STORY_ID}-q-r1`;
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [targetRunId], json: true });
      assert.equal(dry.duplicateGroups.length, 2, 'only r1 has duplicate groups (two hosts)');
      for (const group of dry.duplicateGroups) assert.equal(group.runId, targetRunId);
      assert.equal(dry.removedVerdictCount, 2, 'only r1 duplicates are counted');
      assert.deepEqual(dry.runIdsFilter, [targetRunId]);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [targetRunId], apply: true, json: true });
      assert.equal(applied.removedVerdictCount, 2);
      const rounds = quorumFloorRounds(fixture);
      assert.ok(rounds.validRounds.map(round => round.runId).includes(targetRunId), 'r1 recovered after targeted prune');
      assert.ok(rounds.invalidRounds.some(round => round.runId === `${STORY_ID}-q-r2`), 'r2 duplicates left untouched');
      assert.ok(rounds.invalidRounds.some(round => round.runId === `${STORY_ID}-q-r3`), 'r3 duplicates left untouched');
    });
  });

  check('quorum_prune preserves interleaved non-host_verdict lines byte-identically', () => {
    withFreshFixture((fixture) => {
      const interleave = JSON.stringify({ type: 'review_run', marker: 'B-3144-preserve-interleaved', reviewRunId: 'B-3144-interleave' });
      const { originalHostVerdictLines } = injectPoisonedDuplicates(fixture, { interleaveLine: interleave });
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(beforeLines.includes(interleave), 'interleaved non-host_verdict line was committed');
      fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      const afterLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(afterLines.includes(interleave), 'interleaved non-host_verdict line preserved verbatim');
      const losing = new Set(originalHostVerdictLines);
      const expectedAfter = beforeLines.filter(line => !losing.has(line));
      assert.deepEqual(afterLines, expectedAfter, 'non-host_verdict lines preserved in original order; only losing host_verdict rows removed');
    });
  });

  check('quorum_prune keep:oldest-material inverts which duplicate survives', () => {
    withFreshFixture((fixture) => {
      const { first } = injectPoisonedDuplicates(fixture);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, keep: 'oldest-material', json: true });
      assert.equal(applied.keep, 'oldest-material');
      assert.equal(applied.removedVerdictCount, 6);
      const survivors = fixture.store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict');
      assert.equal(survivors.length, 6, 'one surviving verdict per host per round');
      for (const survivor of survivors) {
        assert.equal(survivor.materialDigest, first.materialDigest, 'oldest-material keeps the earlier (older-material) verdict, not the drift copy');
      }
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3);
      for (const round of recovered.validRounds) assert.equal(round.passingHostIds.length, 2);
    });
  });

  check('quorum_prune refuses an uncommitted process-events file', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const eventsPath = quorumProcessEventsPath(fixture);
      const raw = readFileSync(eventsPath, 'utf8');
      const dupLines = raw.split('\n').filter(Boolean).flatMap((line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
        return event.type === 'host_verdict'
          ? [JSON.stringify({ ...event, verdictId: `${String(event.verdictId)}-dup`, materialDigest: 'B-3144-uncommitted-drift' })]
          : [];
      });
      writeFileSync(eventsPath, `${raw}${dupLines.join('\n')}\n`, 'utf8');
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /uncommitted changes|prune only operates on the committed/,
        'an uncommitted events file refuses before any mutation',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'refusal leaves the uncommitted file untouched');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  });

  check('quorum_prune never overwrites a previous run backup', () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const firstPrune: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.ok(firstPrune.backupPath && existsSync(firstPrune.backupPath));
      const firstBackupBytes = readFileSync(firstPrune.backupPath);
      const eventsPath = quorumProcessEventsPath(fixture);
      const raw = readFileSync(eventsPath, 'utf8');
      const dupLines = raw.split('\n').filter(Boolean).flatMap((line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
        return event.type === 'host_verdict'
          ? [JSON.stringify({ ...event, verdictId: `${String(event.verdictId)}-dup2`, materialDigest: 'B-3144-second-drift' })]
          : [];
      });
      writeFileSync(eventsPath, `${raw}${dupLines.join('\n')}\n`, 'utf8');
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 're-poison after first prune']);
      const secondPrune: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.ok(secondPrune.backupPath && existsSync(secondPrune.backupPath));
      assert.notEqual(secondPrune.backupPath, firstPrune.backupPath, 'second prune uses a distinct backup path');
      assert.deepEqual(readFileSync(firstPrune.backupPath), firstBackupBytes, 'the earlier backup is not overwritten');
    });
  });

  check('quorum_prune apply leaves a clean worktree and a second apply needs no manual git', () => {
    // F-002/F-007 RED: the pre-prune backup is written into the GIT-TRACKED story dir while the
    // prune transaction stages only process-events.jsonl. Unless the backup name genuinely
    // matches the repository's `*.bak` ignore pattern it survives as untracked dirt, and both
    // assertCleanPruneBaseline and quorum_submit's assertCleanQuorumBaseline (unscoped
    // `git status --porcelain=v1 --untracked-files=all`) then refuse on the tool's OWN artifact.
    // The fixture mirrors the repo's ignore rules, so first prove the real pattern still exists —
    // otherwise the mirror could silently become a self-serving fixture.
    const repoIgnoreLines = readFileSync(join(IMPLEMENTATION_REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map(line => line.trim());
    for (const pattern of MIRRORED_REPO_IGNORE_PATTERNS) {
      assert.ok(
        repoIgnoreLines.includes(pattern),
        `the implementation repo .gitignore still carries the mirrored pattern ${pattern}`,
      );
    }
    assert.ok(
      repoIgnoreLines.includes('*.bak'),
      'the *.bak pattern the backup name relies on is a real, shipped repo rule',
    );
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const r1 = `${STORY_ID}-q-r1`;
      const r2 = `${STORY_ID}-q-r2`;
      const first: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [r1], apply: true, json: true });
      assert.equal(first.applied, true, 'first apply succeeds');
      assert.ok(first.backupPath.endsWith('.bak'), `backup must end in .bak so *.bak covers it (got ${first.backupPath})`);
      assert.ok(existsSync(first.backupPath), 'the backup really is written into the tracked story dir');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'a successful apply leaves NO worktree dirt — the exact predicate both clean-baseline checks use',
      );
      const firstBackupBytes = readFileSync(first.backupPath);
      // The next legitimate recovery action, with NO intervening git add/commit whatsoever.
      const second: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [r2], apply: true, json: true });
      assert.equal(second.applied, true, 'the immediate second apply is not blocked by the first apply backup');
      assert.notEqual(second.backupPath, first.backupPath, 'the second apply writes a distinct backup');
      assert.deepEqual(readFileSync(first.backupPath), firstBackupBytes, 'the first backup survives the second apply untouched');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'the tree is still clean after the second apply',
      );
      assert.equal(storyBackupFiles(fixture).length, 2, 'both backups are retained side by side');
      const rounds = quorumFloorRounds(fixture);
      assert.ok(rounds.validRounds.map(round => round.runId).includes(r1), 'r1 recovered by the first apply');
      assert.ok(rounds.validRounds.map(round => round.runId).includes(r2), 'r2 recovered by the second apply with no manual git');
    });
  });

  check('quorum_prune apply through the production CLI under codex leaves no process-event dirt', () => {
    // F-001 RED: cli-engine's generic post-handler codex_cli process-event append must exclude
    // quorum_prune exactly as it excludes quorum_submit, otherwise it re-dirties the very
    // process-events.jsonl the handler just atomically committed. runFixtureCli sets
    // PROOF_OR_STOP_ACTIVITY_SOURCE=codex, which is the only condition under which the append fires.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const applied = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      const combined = `${applied.stdout}\n${applied.stderr}`;
      assert.equal(applied.status, 0, combined);
      const payload = JSON.parse(applied.stdout.trim()) as { applied: boolean; removedVerdictCount: number; metadataCommitSha: string };
      assert.equal(payload.applied, true);
      assert.equal(payload.removedVerdictCount, 6);
      assert.ok(payload.metadataCommitSha, 'the prune committed through the lifecycle-metadata transaction');
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply advances HEAD with the pruned log');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no codex_cli append re-dirties the file quorum_prune just committed, and no backup is left untracked',
      );
      // The next real call must therefore still be able to run: it reaches its own semantic
      // refusal (nothing left to prune) instead of a pre-dirty refusal about our own artifact.
      const next = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      const nextCombined = `${next.stdout}\n${next.stderr}`;
      assert.match(nextCombined, /nothing to prune/, `follow-up call reaches the semantic refusal: ${nextCombined}`);
      assert.doesNotMatch(nextCombined, /worktree\/index must be clean|has uncommitted changes/, 'follow-up call is not blocked by the tool\'s own leftovers');
    });
  });

  check('quorum_prune --dryRun is a real declared flag, is honored, and refuses when combined with --apply', () => {
    // F-008/F-009 RED: without a `dryRun` schema field, `--dryRun` is silently swallowed by the
    // non-strict flag parser and help-renderer falls through to "Dry-run: always-on", which
    // inverts the safety boundary for a command whose apply path really does mutate git state.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const dry = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--dryRun', '--json']);
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      const dryPayload = JSON.parse(dry.stdout.trim()) as { dryRun: boolean; applied: boolean; duplicateGroups: unknown[] };
      assert.equal(dryPayload.dryRun, true, '--dryRun projects');
      assert.equal(dryPayload.applied, false);
      assert.equal(dryPayload.duplicateGroups.length, 6);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, '--dryRun makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, '--dryRun writes no backup');

      // An explicitly conflicting combination must REFUSE, never silently pick a side.
      const conflict = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--dryRun', '--apply']);
      const conflictOut = `${conflict.stdout}\n${conflict.stderr}`;
      assert.notEqual(conflict.status, 0, `--dryRun --apply must fail: ${conflictOut}`);
      assert.match(conflictOut, /pass either apply:true or dryRun:true, not both/i, conflictOut);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the conflict refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the conflict refusal writes no backup');

      // The auto-generated help must state the truth about when this command mutates.
      const help = runFixtureCli(fixture.root, ['quorum_prune', '--help']);
      const helpText = `${help.stdout}\n${help.stderr}`;
      assert.match(helpText, /--dryRun\s+boolean/, 'help documents --dryRun as a declared boolean flag');
      assert.doesNotMatch(helpText, /Dry-run: always-on/i, 'help must not claim the command never executes a side effect');
      assert.match(helpText, /Dry-run: default-on via --dryRun=true/, 'help states the real default-on-with-explicit-apply contract');

      // And apply:true still mutates for real, so the help claim above is not the safe lie.
      const realApply = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      assert.equal(realApply.status, 0, `${realApply.stdout}\n${realApply.stderr}`);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply:true really does commit');
      assert.equal(storyBackupFiles(fixture).length, 1, 'apply:true really does write a backup');
    });
  });

  check('quorum_prune dryRun:false executes instead of being a silent no-op', () => {
    // F-010 RED: an explicit dryRun:false used to fall through to the projection path, so an
    // operator who said "do not dry-run" got a dry run anyway and CHK-003's userSees promise
    // ("without --dryRun it backs up, removes them, commits") was false. Omitting dryRun must
    // still default to the safe projection — the default carries the safety, not the silent
    // discarding of an explicit instruction.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);

      // Omitted dryRun keeps the safe projection default.
      const omitted = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--json']);
      assert.equal(omitted.status, 0, `${omitted.stdout}\n${omitted.stderr}`);
      const omittedPayload = JSON.parse(omitted.stdout.trim()) as { dryRun: boolean; applied: boolean };
      assert.equal(omittedPayload.applied, false, 'omitting dryRun still projects only');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'omitting dryRun makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'omitting dryRun writes no backup');

      // An explicit dryRun:false executes exactly like apply:true.
      const explicitFalse = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, dryRun: false, json: true })]);
      assert.equal(explicitFalse.status, 0, `${explicitFalse.stdout}\n${explicitFalse.stderr}`);
      const falsePayload = JSON.parse(explicitFalse.stdout.trim()) as { dryRun: boolean; applied: boolean; removedVerdictCount: number; removedVerdictIds: string[] };
      assert.equal(falsePayload.applied, true, 'dryRun:false executes');
      assert.equal(falsePayload.dryRun, false);
      assert.equal(falsePayload.removedVerdictCount, 6, 'dryRun:false removes the losing duplicate set');
      assert.equal(falsePayload.removedVerdictIds.length, 6);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'dryRun:false really does commit');
      assert.equal(storyBackupFiles(fixture).length, 1, 'dryRun:false really does write a backup');
      assert.equal(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']), '', 'dryRun:false leaves a clean tree');
    });
  });

  check('quorum_prune refuses the symmetric apply:false + dryRun:false conflict', () => {
    // F-012 RED: the F-010 fix resolved `apply === true || dryRun === false`, so {apply:false,
    // dryRun:false} silently EXECUTED a backup+rewrite+commit against an explicit apply:false —
    // resolving a contradiction toward the more dangerous side, which is exactly what the
    // conflict rule exists to prevent. Both contradictory pairs must refuse.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const conflict = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: false, dryRun: false })]);
      const conflictOut = `${conflict.stdout}\n${conflict.stderr}`;
      assert.notEqual(conflict.status, 0, `apply:false + dryRun:false must fail: ${conflictOut}`);
      assert.match(conflictOut, /apply:false and dryRun:false contradict each other/i, conflictOut);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the symmetric conflict makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the symmetric conflict writes no backup');

      // apply:false alone still projects rather than executing.
      const applyFalse = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: false, json: true })]);
      assert.equal(applyFalse.status, 0, `${applyFalse.stdout}\n${applyFalse.stderr}`);
      assert.equal((JSON.parse(applyFalse.stdout.trim()) as { applied: boolean }).applied, false, 'apply:false projects only');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply:false makes no commit');
    });
  });

  check('every quorum_prune apply/dryRun description states both executors', () => {
    // F-011 RED: the F-010 fix updated only the dryRun field description and one comment, leaving
    // five other prose sites claiming apply:true was the sole mutation trigger — including the
    // catalog's top-level description, which is the FIRST line of --help and contradicted the
    // corrected flag description a few lines below it in the same output.
    //
    // F-013 RED: the first version of THIS guard had the same blind spot one level down. It read
    // only the three block-level descriptions and never the per-flag `describe()` strings, which
    // are exactly what help-renderer prints per argument — so --help could (and did) show a
    // correct top-level description above a stale --dryRun line and a never-updated --apply line.
    // A guard with a coverage hole is worse than no guard: it reads as "this is protected". Every
    // site that renders or audits this contract is asserted here, including the two schema fields
    // and the handler JSDoc, plus a live --help render so the assertion is not source-only.
    const catalogSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/cli/command-catalog.ts'), 'utf8');
    const factSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/core/process-fact-levels.ts'), 'utf8');
    const policySource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/core/command-policy.ts'), 'utf8');
    const handlerSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/handlers/quorum-prune.ts'), 'utf8');
    const catalogEntry = catalogSource.slice(catalogSource.indexOf("{ name: 'quorum_prune'"));
    const catalogBlock = catalogEntry.slice(0, catalogEntry.indexOf('}},'));
    const catalogDescription = catalogEntry.slice(0, catalogEntry.indexOf('schema:'));
    const fieldDescribe = (field: string): string => {
      const start = catalogBlock.indexOf(`${field}: z.`);
      return start < 0 ? '' : catalogBlock.slice(start, catalogBlock.indexOf('\n', start));
    };
    const argsTypeStart = handlerSource.indexOf('QuorumPruneArgs = {');
    const argsTypeEnd = handlerSource.indexOf('keep?: KeepSelector', argsTypeStart);
    assert.ok(argsTypeStart >= 0 && argsTypeEnd > argsTypeStart, 'QuorumPruneArgs declaration shape changed; update this guard');
    const argsInterface = handlerSource.slice(argsTypeStart, argsTypeEnd);
    for (const [label, prose] of [
      ['catalog top-level description', catalogDescription],
      ['catalog dryRun describe()', fieldDescribe('dryRun')],
      ['catalog apply describe()', fieldDescribe('apply')],
      ['process-fact rationale', factSource.split('\n').find(line => line.includes("name: 'quorum_prune'")) ?? ''],
      ['command-policy reason', policySource.split('\n').find(line => line.includes('quorum_prune: {')) ?? ''],
      ['QuorumPruneArgs JSDoc', argsInterface],
    ] as const) {
      assert.ok(prose.length > 0, `${label} was not found`);
      assert.match(prose, /dryRun:false/, `${label} must name dryRun:false as an executor`);
      assert.doesNotMatch(
        prose,
        /\(apply:true required to mutate\)/,
        `${label} must not claim apply:true is the only mutation trigger`,
      );
    }

    // F-014/F-015 RED: the enumerated list above went stale TWICE — first missing the per-flag
    // describe() strings (F-013), then missing the module header, the runtime dry-run note, and a
    // genuinely stale config.ts comment (F-014/F-015). A hand-maintained site list is the defect:
    // it silently under-covers every time someone documents this contract somewhere new. So DISCOVER
    // the sites instead of listing them — every non-test production line that talks about this
    // command's apply contract must also name dryRun:false. Adding a new mention anywhere now
    // either satisfies the contract or fails this check; it can no longer be silently missed.
    // F-016/F-017 RED: the first discovery sweep matched line-by-line with a regex, which gave it
    // three silent escapes, all confirmed by reviewers against the real logic: (1) the exclusion
    // pattern was whole-line, so fusing a stale claim onto a line containing `args.apply` or a
    // `+ '...'` continuation hid it entirely — and 3 real continuation lines carrying `apply:true`
    // were already being skipped; (2) the self-mention test read ONE line while the pairing test
    // read a ±3-line window, so a two-line comment naming the command above a stale claim was
    // invisible; (3) the window was not sentence-scoped, so a stale statement could borrow a
    // neighbour's correct `dryRun:false`. Line-oriented regex is simply the wrong instrument for
    // "is this prose unit self-consistent". Parse instead: every string literal (concatenations
    // folded into one unit) and every comment block IS a prose unit, so a claim and its pairing
    // are judged in the same unit they were written in, and executable logic is excluded because
    // it is neither a comment nor a string rather than because a regex guessed at it.
    const proseUnitsOf = (file: string, source: string): Array<{ text: string; line: number }> => {
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const units: Array<{ text: string; line: number }> = [];
      const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
      const seenComments = new Set<number>();
      const collectComments = (pos: number) => {
        for (const range of [...(ts.getLeadingCommentRanges(source, pos) ?? []), ...(ts.getTrailingCommentRanges(source, pos) ?? [])]) {
          if (seenComments.has(range.pos)) continue;
          seenComments.add(range.pos);
          units.push({ text: source.slice(range.pos, range.end), line: lineOf(range.pos) });
        }
      };
      const visit = (node: ts.Node): void => {
        collectComments(node.getFullStart());
        // A `'a' + 'b' + 'c'` message is ONE prose unit; take the whole expression and do not
        // descend into its parts, so a claim on one operand pairs with text on another.
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && /['"`]/.test(node.getText()[0] ?? '')) {
          units.push({ text: node.getText(), line: lineOf(node.getStart()) });
          return;
        }
        if (ts.isStringLiteralLike(node)) {
          units.push({ text: node.getText(), line: lineOf(node.getStart()) });
          return;
        }
        node.forEachChild(visit);
      };
      visit(sf);
      // F-018 RED: merging contiguous `//` lines into one block only moved the borrowing escape
      // from the old ±3-line window to the comment-block boundary — a stale sentence could still
      // borrow an unrelated sentence's `dryRun:false` from the same block, and quorum-prune.ts's
      // 20-line header is exactly such a multi-sentence block. Comments are therefore joined by
      // line-contiguity and then split back apart by SENTENCE, so each claim is judged against
      // the sentence that makes it. `apply:true`/`dryRun:false` contain no sentence-ending
      // period, so splitting on `.` followed by whitespace cannot cut a claim in half.
      units.sort((a, b) => a.line - b.line);
      const merged: Array<{ text: string; line: number }> = [];
      for (const unit of units) {
        const previous = merged[merged.length - 1];
        const contiguousComment = previous
          && unit.text.startsWith('//') && previous.text.startsWith('//')
          && unit.line === previous.line + previous.text.split('\n').length;
        if (contiguousComment) previous.text += `\n${unit.text}`;
        else merged.push({ ...unit });
      }
      return merged.flatMap((unit) => {
        if (!unit.text.startsWith('//') && !unit.text.startsWith('/*')) return [unit];
        const sentences = unit.text.split(/(?<=\.)\s+/).filter(sentence => sentence.trim().length > 0);
        if (sentences.length <= 1) return [unit];
        let consumed = 0;
        return sentences.map((sentence) => {
          const line = unit.line + unit.text.slice(0, consumed).split('\n').length - 1;
          consumed += sentence.length + 1;
          return { text: sentence, line };
        });
      });
    };
    // Scope: sibling commands (capability_release_backfill and friends) legitimately keep the
    // apply-only convention, so only THIS command's prose is swept. quorum-prune.ts is entirely
    // about this command; the catalog is narrowed to the quorum_prune entry; elsewhere the prose
    // unit itself must name the command — now judged per UNIT, not per line, closing escape (2).
    // F-019 RED: the file list was still hand-maintained, so proof-or-stop-cli.ts — a CHK-003 scope
    // touchpoint that already carries quorum_prune prose — was permanently invisible to the
    // sweep. That is the same stale-enumeration pattern as F-013/F-014/F-015, just moved up from
    // lines to files. The story's own signed scope contract already enumerates every file this
    // change may touch, so read THAT instead of restating it: a file entering the story's scope
    // now enters the sweep automatically, and a hand-edited list can no longer drift behind it.
    // F-021 RED: deriving from allowedModify+allowedCreate alone was still too narrow. A file can
    // also enter the story's real scope through an acknowledged expansion — cli-engine.ts did
    // exactly that for the F-001 fix, carries quorum_prune prose, and a stale claim planted there
    // left the suite fully green. The codebase's own isAcknowledged() (core/scope-contract.ts)
    // treats acknowledged paths as in-scope, so the sweep must union them too: "in this story's
    // scope" has one meaning, and this guard now uses the same one the scope checker does.
    // B-cc10: this reads the REAL repo's own story artifact, so it must resolve whichever
    // state-dir spelling exists on disk rather than pinning the deprecated one.
    const scopeContractPath = STATE_DIR_NAMES
      .map((dir) => join(IMPLEMENTATION_REPO_ROOT, `${dir}/story/actives/B-3144/scope-contract.json`))
      .find((candidate) => existsSync(candidate))
      ?? join(IMPLEMENTATION_REPO_ROOT, `${PROOF_OR_STOP_STATE_DIR}/story/actives/B-3144/scope-contract.json`);
    const scopeContract = JSON.parse(readFileSync(scopeContractPath, 'utf8')) as {
      allowedModify?: string[];
      allowedCreate?: string[];
      allowedTest?: string[];
      acknowledgements?: Array<{ paths?: string[] }>;
    };
    const historicalScopePathMap = new Map<string, string>([
      // B-3144's signed scope predates the clean-break handler rename. Preserve
      // that historical artifact and resolve its owned source path to the
      // canonical file the implementation now ships.
      [['packages/main/src/handlers/lat', 'tice-cli.ts'].join(''), 'packages/main/src/handlers/proof-or-stop-cli.ts'],
    ]);
    const sweptFiles = [...new Set([
      ...(scopeContract.allowedModify ?? []),
      ...(scopeContract.allowedCreate ?? []),
      ...(scopeContract.acknowledgements ?? []).flatMap(ack => ack.paths ?? []),
    ])]
      .filter(path => path.endsWith('.ts') && !(scopeContract.allowedTest ?? []).includes(path))
      .map(path => historicalScopePathMap.get(path) ?? path)
      .sort();
    assert.ok(sweptFiles.length >= 6, `scope contract yielded too few production files to sweep: ${sweptFiles.join(', ')}`);
    // The catalog is one giant multi-command file, so only the quorum_prune entry is in range;
    // quorum-prune.ts is entirely this command's, and everything else must name it nearby.
    const catalogRelPath = 'packages/main/src/cli/command-catalog.ts';
    const handlerRelPath = 'packages/main/src/handlers/quorum-prune.ts';
    const catalogBlockStart = catalogSource.indexOf("{ name: 'quorum_prune'");
    const contractSources: Array<{ file: string; source: string; requireSelfMention: boolean; range?: [number, number] }> = sweptFiles.map((file) => {
      const source = file === catalogRelPath ? catalogSource
        : file === handlerRelPath ? handlerSource
          : readFileSync(join(IMPLEMENTATION_REPO_ROOT, file), 'utf8');
      return {
        file,
        source,
        requireSelfMention: file !== catalogRelPath && file !== handlerRelPath,
        ...(file === catalogRelPath ? { range: [catalogBlockStart, catalogBlockStart + catalogBlock.length] as [number, number] } : {}),
      };
    });
    const discovered: string[] = [];
    for (const { file, source, requireSelfMention, range } of contractSources) {
      const inRange = (line: number): boolean => {
        if (!range) return true;
        const startLine = source.slice(0, range[0]).split('\n').length;
        const endLine = source.slice(0, range[1]).split('\n').length;
        return line >= startLine && line <= endLine;
      };
      const sourceLines = source.split('\n');
      // Scoping and pairing are deliberately different granularities. Pairing is judged INSIDE the
      // prose unit (strict — a claim cannot borrow a neighbour's wording). Scoping asks only "is
      // this prose about quorum_prune", and the command name often sits beside the unit rather
      // than inside it (`'quorum_prune', // <comment>`, or a `quorum_prune: {` key above a reason
      // string), so it is answered over the surrounding lines. Wide scoping under-skips; strict
      // pairing prevents escapes. Getting these backwards is what F-017 flagged.
      // F-020 RED: a fixed ±N-line window is not anchored to anything real, so a claim written
      // more than N lines from the `quorum_prune` key silently leaves the sweep. Anchor to the
      // enclosing syntactic entry instead — the property assignment, array element, or statement
      // the prose belongs to — so however that entry is formatted, prose inside it stays in range.
      const scopeSf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const namedNearby = (line: number): boolean => {
        const offset = scopeSf.getPositionOfLineAndCharacter(Math.max(0, line - 1), 0);
        // The question is "which command's entry owns this prose", so match the KEY, not the text.
        // F-022 RED: keeping only the innermost enclosing node answered it wrongly — reformat
        // `quorum_prune: { reason: '...apply:true...' }` across lines and the innermost node is
        // `reason:` itself, whose text lacks the command name, so the site left the sweep.
        // F-023 RED: widening that to "any ancestor whose TEXT contains quorum_prune" answered it
        // wrongly in the other direction — each of these files holds its whole command table in
        // ONE top-level statement, which trivially contains the name, so every row in the table
        // matched, including the sibling commands this sweep must leave alone.
        // A property whose KEY is the command name is exactly the entry that owns its own prose:
        // it encloses the reason string however that entry is wrapped, and a sibling entry keyed
        // `quorum_submit` never matches no matter what the enclosing table contains.
        let named = false;
        const visit = (node: ts.Node): void => {
          if (named) return;
          if (node.getFullStart() > offset || node.getEnd() < offset) return;
          if (ts.isPropertyAssignment(node) && node.name.getText().replace(/['"]/g, '') === 'quorum_prune') {
            named = true;
            return;
          }
          node.forEachChild(visit);
        };
        visit(scopeSf);
        if (named) return true;
        // Array-element style (`'quorum_prune', // comment`) has no per-entry node, so fall back
        // to the physical line, which is where that form always puts the name.
        return (sourceLines[line - 1] ?? '').includes('quorum_prune');
      };
      for (const unit of proseUnitsOf(file, source)) {
        if (!/apply:true|apply=true/.test(unit.text)) continue;
        if (!inRange(unit.line)) continue;
        if (requireSelfMention && !unit.text.includes('quorum_prune') && !namedNearby(unit.line)) continue;
        const where = `${file}:${unit.line}`;
        discovered.push(where);
        assert.match(
          unit.text,
          /dryRun:false|--dryRun=false/,
          `${where} documents apply:true without naming dryRun:false as the equivalent executor (prose unit: ${unit.text.slice(0, 160)})`,
        );
      }
    }
    // The floor guards against the sweep silently finding nothing (a parse or scoping regression).
    // It is pinned to the actual current count, so losing even one site trips it — a loose floor
    // was itself a review finding: at >= 6 with 12 real sites, half could vanish unnoticed.
    assert.ok(
      discovered.length >= 10,
      `discovery sweep under-covered: found only ${discovered.length} contract prose units (${discovered.join(', ')}); if a site was legitimately removed, lower this floor deliberately`,
    );
    // Both refusals must be documented wherever the per-flag contract is rendered, so the two
    // --help lines cannot disagree with each other or with the block above them again.
    for (const [label, prose] of [
      ['catalog dryRun describe()', fieldDescribe('dryRun')],
      ['catalog apply describe()', fieldDescribe('apply')],
      ['QuorumPruneArgs JSDoc', argsInterface],
    ] as const) {
      assert.match(prose, /apply:false/, `${label} must document the symmetric apply:false refusal`);
    }
    // And the rendered help itself, since that is what an operator actually reads.
    withFreshFixture((fixture) => {
      const help = runFixtureCli(fixture.root, ['quorum_prune', '--help']);
      const helpText = `${help.stdout}\n${help.stderr}`;
      const dryRunLine = helpText.split('\n').find(line => line.includes('--dryRun')) ?? '';
      const applyLine = helpText.split('\n').find(line => line.trim().startsWith('--apply')) ?? '';
      assert.match(dryRunLine, /dryRun:false/, `rendered --dryRun help is stale: ${dryRunLine}`);
      assert.match(applyLine, /dryRun:false/, `rendered --apply help is stale: ${applyLine}`);
    });
  });

  check('quorum_prune refuses a non-pass duplicate group instead of laundering the round (F-024)', () => {
    // F-024 RED: grouping by runId + host/session/key with NO look at `decision` or the required
    // binding fields makes this recovery command able to CHANGE a verdict. A decision=fail row
    // standing before a passing row with the same identities is a duplicate group like any other,
    // so the default keep-the-later-row rule deletes the FAIL — and core/host-independence.ts
    // stops reporting the round as invalid. A previously failed review becomes a passing quorum,
    // executed by a tool whose entire purpose is to restore an ALREADY-recorded quorum.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const first: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(first.emittedCount, 6, 'baseline quorum emits 3 rounds x 2 hosts');
      const failedRunId = `${STORY_ID}-q-r1`;
      const collidingRunId = `${STORY_ID}-q-r2`;
      const { failVerdictId } = injectPrecedingFailVerdict(fixture, failedRunId);

      // Precondition: the FAIL genuinely invalidates its round AT THE CURRENT MATERIAL, so the
      // only thing standing between this log and a full 3x2 floor is that one row.
      const poisoned = quorumFloorRounds(fixture);
      assert.equal(poisoned.validRounds.length, 2, 'the failed round is not valid before any prune');
      assert.ok(
        poisoned.invalidRounds.some(round =>
          round.runId === failedRunId && round.reasons.some(reason => /non-pass verdict/.test(reason))),
        'the consumer invalidates the round because of the failing verdict',
      );

      // Projection must not even offer the group as prunable.
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      if (dry.duplicateGroups.length > 0) {
        // Pre-fix path: execute exactly what the projection offered and report the CONSEQUENCE, so
        // the repro is un-gameable — the failure names the laundering, not just a shape mismatch.
        fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
        const laundered = quorumFloorRounds(fixture);
        assert.fail(
          'quorum_prune offered the non-pass identity collision as prunable, and pruning it laundered the round: '
          + `validRounds=${laundered.validRounds.length} invalidRounds=${laundered.invalidRounds.length} `
          + `failedRoundNowValid=${laundered.validRounds.some(round => round.runId === failedRunId)} `
          + `failingVerdictStillCommitted=${committedHostVerdictLines(fixture).some(event => event.verdictId === failVerdictId)}`,
        );
      }
      assert.equal(dry.duplicateGroups.length, 0, 'a non-pass member makes the identity collision unprunable');
      assert.equal(dry.removedVerdictCount, 0, 'nothing is projected for removal');
      assert.equal(dry.refusedGroups.length, 1, 'the group is reported as refused, not silently dropped');
      assert.equal(dry.refusedGroups[0].runId, failedRunId, 'the refusal names the affected runId');
      assert.ok(
        dry.refusedGroups[0].verdictIds.includes(failVerdictId),
        `the refusal names the failing verdict: ${JSON.stringify(dry.refusedGroups[0])}`,
      );
      assert.ok(
        dry.refusedGroups[0].reasons.some((reason: string) => /decision=fail is not pass/.test(reason)),
        `the refusal states WHY it is unrecoverable: ${JSON.stringify(dry.refusedGroups[0].reasons)}`,
      );

      // Executing must refuse outright and leave every byte alone.
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /nothing to prune[\s\S]*REFUSED as outside the recoverable/,
        'execution refuses and names the refused group',
      );
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'the failing verdict is still there, byte-identical');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the refusal writes no backup');
      const afterRefusal = quorumFloorRounds(fixture);
      assert.equal(afterRefusal.validRounds.length, 2, 'the failed round is STILL not valid — no laundering happened');
      assert.ok(
        afterRefusal.invalidRounds.some(round => round.runId === failedRunId),
        'the round the reviewer failed stays failed',
      );

      // Fail-closed is PER GROUP: a genuine B-bf52 collision elsewhere in the same log is still
      // recoverable in the same call, so the hardening does not disable the recovery.
      // F-031: must pin to the REAL current material, not a synthetic drift string — B-f88e
      // declines to downgrade a stale-material duplicate that shares identity with an already-live
      // native-material verdict, so a synthetic string here is silently neutralized and never
      // actually poisons collidingRunId (the "genuinely poisoned round recovered" assertion below
      // would then hold vacuously even if quorum_prune's recovery were broken). Same fix as
      // injectPoisonedDuplicates (commit 5291d420dd).
      appendDuplicatesForRunId(fixture, collidingRunId, currentMaterialHash(fixture.root, 'HEAD', fixture.root)!);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.applied, true, 'the genuine collision is still recoverable');
      assert.equal(applied.removedVerdictCount, 2, 'only the two losing rows of the recoverable group are removed');
      assert.equal(applied.refusedGroups.length, 1, 'the unrecoverable group is still refused in the same call');
      assert.equal(applied.refusedGroups[0].runId, failedRunId);
      const finalRounds = quorumFloorRounds(fixture);
      assert.ok(
        finalRounds.validRounds.map(round => round.runId).includes(collidingRunId),
        'the genuinely poisoned round recovered',
      );
      assert.ok(
        finalRounds.invalidRounds.some(round => round.runId === failedRunId),
        'and the failed round is still invalid after a successful apply on its neighbour',
      );
      assert.ok(
        committedHostVerdictLines(fixture).some(event => event.verdictId === failVerdictId),
        'the failing verdict row survives a successful prune of another group',
      );
    });
  });

  check('quorum_prune never deletes a verdict cache path outside the story verdict dir (F-025)', () => {
    // F-025 RED: the losing rows' verdictIds come from a committed log, i.e. untrusted input, and
    // were joined straight into `<verdictId>.json`. A crafted id resolves out of the gitignored
    // verdict cache and rmSync deletes a real repository file — after the evidence commit, so the
    // command reports a successful recovery while destroying an unrelated tracked file.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      write(fixture.root, 'evidence-target.json', '{"do-not":"delete me"}\n');
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'a tracked file the traversal would destroy']);
      const target = join(fixture.root, 'evidence-target.json');
      const targetBytes = readFileSync(target);
      const verdictDir = join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID);
      // The crafted id resolves to <root>/evidence-target.json from inside the verdict cache dir.
      const craftedVerdictId = '../../../evidence-target';
      const targetRunId = `${STORY_ID}-q-r1`;
      // F-031: pin to the REAL current material (see the identical fix + rationale at the F-024
      // check above and in injectPoisonedDuplicates, commit 5291d420dd) so the duplicate genuinely
      // collides instead of being silently neutralized by B-f88e's downgrade-skip.
      appendDuplicatesForRunId(
        fixture,
        targetRunId,
        currentMaterialHash(fixture.root, 'HEAD', fixture.root)!,
        event => ({ ...event, verdictId: craftedVerdictId }),
      );
      assert.equal(
        join(verdictDir, `${craftedVerdictId}.json`).replace(/\/+/g, '/'),
        join(fixture.root, 'evidence-target.json'),
        'fixture precondition: the crafted id really does traverse out of the verdict cache dir',
      );
      // keep:oldest-material makes the LATER (crafted) rows the losing set, so the crafted id is
      // the one handed to the verdict-cache deletion.
      const applied: any = fixture.registry.get('quorum_prune')!({
        storyId: STORY_ID, apply: true, keep: 'oldest-material', json: true,
      });
      assert.equal(applied.applied, true, 'the prune itself still succeeds');
      assert.ok(
        applied.removedVerdictIds.includes(craftedVerdictId),
        'the crafted id really was in the losing set handed to the cache deletion',
      );
      assert.ok(existsSync(target), 'the tracked file outside the verdict cache still exists');
      assert.deepEqual(readFileSync(target), targetBytes, 'and its bytes are untouched');
      assert.ok(
        applied.skippedVerdictFiles.some((skipped: any) =>
          skipped.verdictId === craftedVerdictId && /canonical generated shape/.test(skipped.reason)),
        `the skipped deletion is reported: ${JSON.stringify(applied.skippedVerdictFiles)}`,
      );
      for (const path of applied.removedVerdictFiles) {
        assert.equal(dirname(path), verdictDir, `deleted cache file stayed inside the verdict dir: ${path}`);
      }
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no tracked file was deleted, so the worktree is still clean after the apply',
      );
    });
  });

  check('quorum_prune holds the shared append lock across read and rewrite (F-026)', () => {
    // F-026 RED: the source bytes were read at the TOP of the handler — before the clean checks and
    // the transaction capture — and the rewrite never took the append lock ordinary process-event
    // writers must take (core/process-events.ts). Any row appended between that read and the
    // rewrite is silently overwritten, and the catch-path restore of the earlier snapshot deletes
    // it outright. The hook below fires at the start of the mutation phase and scripts exactly that
    // interleaving: a competing writer that lands (and commits) a row just before the rewrite.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const expectedLockDir = storyRuntimeLockPath(fixture.root, 'process-events', STORY_ID, 'process-events-append');
      const concurrentRow = JSON.stringify({
        type: 'review_run',
        marker: 'B-3144-F-026-concurrent-append',
        reviewRunId: 'B-3144-F-026',
      });
      let observedLockDir = '';
      let contention: unknown = null;
      const prune = createQuorumPruneHandlers(fixture.ctx, {
        insideAppendLock: ({ lockDir }) => {
          observedLockDir = lockDir;
          // (1) The lock is genuinely HELD at this moment: an independent fail-fast acquire of the
          // SAME dir must be refused. Without the fix this acquire simply succeeds.
          try {
            acquireMkdirLock(lockDir, {
              failFastIfHeld: true,
              heldMessage: 'process-events append lock is held',
            }).release();
          } catch (error) {
            contention = error;
          }
          // (2) A row that landed just before the lock was taken must survive the rewrite.
          appendFileSync(eventsPath, `${concurrentRow}\n`, 'utf8');
          git(fixture.root, ['add', '-A']);
          git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'concurrent append that must survive the prune']);
        },
      }).quorum_prune;
      const applied: any = prune({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(observedLockDir, expectedLockDir, 'prune takes the SAME lock the append primitive takes');
      assert.ok(contention, 'the append lock was genuinely held while the rewrite ran');
      assert.match(String((contention as Error).message), /held/i, String((contention as Error).message));
      assert.equal(applied.applied, true);
      assert.equal(applied.removedVerdictCount, 6, 'the recovery still removed the losing duplicate set');
      const afterLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(
        afterLines.includes(concurrentRow),
        'the row committed by the competing writer survives the rewrite instead of being overwritten',
      );
      assert.ok(
        readFileSync(applied.backupPath, 'utf8').includes('B-3144-F-026-concurrent-append'),
        'the backup is a copy of the bytes the rewrite was actually derived from, not an older snapshot',
      );
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'the committed rewrite leaves a clean tree',
      );
      assert.equal(quorumFloorRounds(fixture).validRounds.length, 3, 'the floor still recovers to full 3x2');
    });
  });

  check('quorum_prune installs the pruned log by atomic rename, never an in-place overwrite (F-027)', () => {
    // F-027 RED: the rewrite was a plain in-place writeFileSync, which truncates first. A SIGKILL
    // or power loss between the truncate and the final write leaves a PARTIAL canonical log and the
    // catch-path rollback never runs, while the surrounding prose called the operation atomic. The
    // inode assertion below is the mechanical difference: an in-place overwrite keeps the file's
    // identity, a temp-file-plus-rename replaces it.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const before = statSync(eventsPath);
      assert.ok(before.ino > 0, 'inode identity is observable on this filesystem, so the check is not vacuous');
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.applied, true);
      const after = statSync(eventsPath);
      assert.notEqual(
        after.ino,
        before.ino,
        'the canonical log was REPLACED by a rename; an in-place truncate-and-write keeps the same inode',
      );
      assert.equal(storyBackupFiles(fixture).length, 1, 'only the backup remains — the rewrite temp was renamed away');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no rewrite temp survives as worktree dirt',
      );
      const handlerSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/handlers/quorum-prune.ts'), 'utf8');
      assert.match(handlerSource, /renameSync\(tempPath, processEventsPath\)/, 'the rewrite installs through rename');
      assert.match(handlerSource, /fsyncSync\(fd\)/, 'the replacement bytes are flushed before the rename');
      assert.doesNotMatch(
        handlerSource,
        /writeFileSync\(processEventsPath/,
        'the canonical log is never written in place, so the atomicity the prose claims is real',
      );
    });
  });

  check('quorum_submit re-checks the duplicate guard against the captured HEAD (F-028)', () => {
    // F-028 RED: the committed-event duplicate check ran BEFORE the clean-baseline check and the
    // transaction capture, so it answered a question about a HEAD the transaction never used. Two
    // reviewer-write invocations can both observe "no standing quorum"; if one commits before the
    // other captures its baseline, the second captures the first quorum and appends a SECOND
    // identical quorum onto the same runIds — recreating the exact poisoning this story exists to
    // prevent. The hook fires in that window and scripts the competitor deterministically.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      let competitor: any = null;
      const racing = createQuorumSubmitHandlers(fixture.ctx, {
        beforeTransactionCapture: () => {
          if (competitor) return;
          competitor = createQuorumSubmitHandlers(fixture.ctx).quorum_submit(quorumArgs());
        },
      }).quorum_submit;
      let raced: any = null;
      let refusal: unknown = null;
      try {
        raced = racing(quorumArgs());
      } catch (error) {
        refusal = error;
      }
      assert.ok(competitor, 'the competing invocation ran inside the window');
      assert.equal(competitor.emittedCount, 6, 'the competitor really did commit a full quorum first');
      if (refusal === null) {
        const material = currentMaterialHash(fixture.root, 'HEAD', fixture.root)!;
        const rounds = evaluateHostVerdictRounds(fixture.store.readProcessEvents(STORY_ID), material, 2);
        assert.fail(
          'the racing re-submit was accepted after the competitor committed: '
          + `emitted=${raced?.emittedCount} totalHostVerdicts=${hostVerdictEventCount(fixture.store)} `
          + `validRounds=${rounds.validRounds.length} invalidRounds=${rounds.invalidRounds.length} `
          + `(${rounds.invalidRounds.map(round => `${round.runId}: ${round.reasons.join('; ')}`).join(' | ')})`,
        );
      }
      const message = String((refusal as Error).message);
      assert.match(
        message,
        /quorum_submit refuses: verdicts already exist for runId/,
        `the post-capture re-check reuses the existing same-material refusal: ${message}`,
      );
      for (const runId of [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]) {
        assert.ok(message.includes(runId), `the refusal names the standing runId ${runId}: ${message}`);
      }
      assert.equal(hostVerdictEventCount(fixture.store), 6, 'exactly one quorum survives the race');
      assert.equal(verdictFileCount(fixture.root), 6, 'the losing invocation wrote no verdict files');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'the refusal leaves no dirt behind',
      );
      const rounds = quorumFloorRounds(fixture);
      assert.equal(rounds.validRounds.length, 3, 'the surviving quorum is a clean full 3x2');
      assert.equal(rounds.invalidRounds.length, 0, 'no round collapsed as duplicate host/session/key identity');
    });
  });

  check('quorum_submit compares the same-material guard on the normalized digest (F-029)', () => {
    // F-029 RED: the same-material branch compared the RAW committed value while the consumer
    // (core/host-independence.ts) normalizes it. A verdict whose materialDigest carries surrounding
    // whitespace therefore COUNTS at the floor but escapes BOTH producer branches: raw equality is
    // false, and the drift branch — which already normalized — sees the current material, so it is
    // false too. The re-submit proceeds and poisons the run it was supposed to protect.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const handler = fixture.registry.get('quorum_submit')!;
      const first: any = handler(quorumArgs());
      assert.equal(first.emittedCount, 6);
      const paddedMaterial = ` ${first.materialDigest} `;
      const rewritten = readFileSync(quorumProcessEventsPath(fixture), 'utf8').split('\n').map((line) => {
        if (!line) return line;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return line;
        }
        return event.type === 'host_verdict'
          ? JSON.stringify({ ...event, materialDigest: paddedMaterial })
          : line;
      }).join('\n');
      commitEventsRewrite(fixture, rewritten, 'pad the committed materialDigest with whitespace');

      // Preconditions that make this a real hole rather than a synthetic one: the padded value is
      // genuinely in the committed bytes, the material itself did not move, and the floor STILL
      // counts those verdicts (the consumer trims) — so a standing quorum really does exist.
      assert.ok(
        readFileSync(quorumProcessEventsPath(fixture), 'utf8').includes(`"materialDigest":${JSON.stringify(paddedMaterial)}`),
        'the committed bytes really carry the whitespace-padded digest',
      );
      assert.equal(
        currentMaterialHash(fixture.root, 'HEAD', fixture.root),
        first.materialDigest,
        'the story-metadata commit did not move the material, so this is the SAME material',
      );
      const standing = quorumFloorRounds(fixture);
      assert.equal(standing.validRounds.length, 3, 'the padded verdicts are still counted by the consumer at the floor');
      assert.equal(standing.invalidRounds.length, 0);

      const beforeEvents = hostVerdictEventCount(fixture.store);
      const beforeVerdicts = verdictFileCount(fixture.root);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      let second: any = null;
      let refusal: unknown = null;
      try {
        second = handler(quorumArgs());
      } catch (error) {
        refusal = error;
      }
      if (refusal === null) {
        const material = currentMaterialHash(fixture.root, 'HEAD', fixture.root)!;
        const rounds = evaluateHostVerdictRounds(fixture.store.readProcessEvents(STORY_ID), material, 2);
        assert.fail(
          'a re-submit against a whitespace-padded standing quorum was accepted: '
          + `emitted=${second?.emittedCount} totalHostVerdicts=${hostVerdictEventCount(fixture.store)} `
          + `validRounds=${rounds.validRounds.length} invalidRounds=${rounds.invalidRounds.length} `
          + `(${rounds.invalidRounds.map(round => `${round.runId}: ${round.reasons.join('; ')}`).join(' | ')})`,
        );
      }
      const message = String((refusal as Error).message);
      assert.match(
        message,
        /quorum_submit refuses: verdicts already exist for runId/,
        `the normalized comparison reaches the existing same-material refusal: ${message}`,
      );
      for (const runId of [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]) {
        assert.ok(message.includes(runId), `the refusal names the standing runId ${runId}: ${message}`);
      }
      assert.equal(hostVerdictEventCount(fixture.store), beforeEvents, 'the refusal writes no host_verdict events');
      assert.equal(verdictFileCount(fixture.root), beforeVerdicts, 'the refusal writes no verdict files');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the refusal does not advance HEAD');
    });
  });

  console.log(`\n✓ quorum_submit smoke passed (${passed} checks)`);
} finally {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}
