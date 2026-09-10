#!/usr/bin/env node



import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { dirname, join, relative } from 'node:path';
import { devNull } from 'node:os';

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

import {
  defineQuorumSmokeCase,
  quorumSmokeMinimalEnvironment,
} from './quorum-submit-smoke-case-catalog.js';

import {
  acquireQuorumSmokeFixtureRuntimePool,
  createQuorumSmokeOwnedFixtureRoot,
  removeQuorumSmokeOwnedFixtureRoot,
  type QuorumSmokeFixtureLease,
} from './quorum-submit-smoke-fixture.js';



export const STORY_ID = 'B-quorum-smoke';

export const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

export const DIST_DIRTY_GATE_POLICY_PATH = fileURLToPath(new URL('../core/dirty-gate-policy.js', import.meta.url));

export const IMPLEMENTATION_REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

export const HISTORICAL_RED_COMMIT = 'ffedfb4eb3';

export const REVIEW_ROUND = '2026-06-22T10:00:00.000Z';

export const COMMIT_ENV = ['-c', 'user.email=quorum-smoke@example.test', '-c', 'user.name=Quorum Submit Smoke'];

export const REVIEW_LANES = [
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
] as const;

export const MIRRORED_REPO_IGNORE_PATTERNS = [
  '*.bak',
  '**/owner-lease.json',
  '**/breaker-state.json',
  '**/takeover-count.json',
  '**/gate-failure-counts.json',
  '**/*.lock/',
] as const;

const WORKER_PROCESS_MARKER_ENV = 'PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER';

const FIXTURE_PROCESS_ENVIRONMENT_KEYS = [
  'NODE_OPTIONS',
  'PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER',
  'PROOF_OR_STOP_RUNTIME_TRACE_FILE',
  'PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER',
  'CI',
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;

function fixtureProcessEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const workerProcessMarker = process.env.PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER;
  for (const key of Object.keys(overrides)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      throw new Error(`quorum fixture subprocess refuses caller Git environment ${key}`);
    }
    if (key === WORKER_PROCESS_MARKER_ENV && overrides[key] !== workerProcessMarker) {
      throw new Error('quorum fixture subprocess refuses a changed worker process marker');
    }
  }
  const inherited: Record<string, string> = {};
  for (const key of FIXTURE_PROCESS_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') inherited[key] = value;
  }
  const workerRoot = process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
  const ownedGitEnvironment = workerRoot ? {
    HOME: join(workerRoot, '.home'),
    USERPROFILE: join(workerRoot, '.home'),
    XDG_CONFIG_HOME: join(workerRoot, '.xdg-config'),
    GIT_CONFIG_GLOBAL: join(workerRoot, '.gitconfig'),
    GIT_TEMPLATE_DIR: join(workerRoot, '.git-template'),
  } : {
    GIT_CONFIG_GLOBAL: devNull,
  };
  return quorumSmokeMinimalEnvironment({
    ...inherited,
    ...ownedGitEnvironment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    ...overrides,
    [WORKER_PROCESS_MARKER_ENV]: workerProcessMarker,
  });
}

export function reviewerReadManifest(lane: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${lane}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: fixtureProcessEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

export function writeConfig(root: string): void {
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

export function story(): StoryInfo {
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

export function checklist(): ChecklistData {
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

export function makeFixture(
  assetMode: 'global-thin' | 'full' = 'global-thin',
  selectedHost: PromptHost = 'codex',
  targetRoot?: string,
): { root: string; store: StoryStore; ctx: HandlerContext; registry: ReturnType<typeof createMainRegistry> } {
  const root = targetRoot ?? createQuorumSmokeOwnedFixtureRoot('proof-or-stop-quorum-submit-');
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

function openFixture(root: string): {
  root: string;
  store: StoryStore;
  ctx: HandlerContext;
  registry: ReturnType<typeof createMainRegistry>;
} {
  resetConfigCache();
  const store = new StoryStore(root);
  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx, registry: createMainRegistry(ctx) };
}

export function runFixtureCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['bin/proofOrStop.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: fixtureProcessEnvironment({
      PROOF_OR_STOP_PROJECT_ROOT: root,
      PROOF_OR_STOP_SESSION_ID: 'quorum-submit-cli-integration',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      ...env,
    }),
  });
}

export function withFreshFixture(
  fn: (fixture: ReturnType<typeof makeFixture>) => void,
): void {
  const fixture = makeFixture();
  const previous = process.cwd();
  try {
    process.chdir(fixture.root);
    withSessionProvider('codex', () => fn(fixture));
  } finally {
    process.chdir(previous);
    removeQuorumSmokeOwnedFixtureRoot(fixture.root);
    resetConfigCache();
  }
}

export function quorumArgs() {
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

export function hostVerdictEventCount(store: StoryStore): number {
  return store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict').length;
}

export function seedLargeCommittedProcessEvents(fixture: ReturnType<typeof makeFixture>): string {
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

export function verdictFileCount(root: string): number {
  return listVerdicts(root, 'local', STORY_ID).length;
}

export function assertQuorumRefuses(registry: ReturnType<typeof createMainRegistry>, store: StoryStore, root: string, label: string): void {
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

export function startRunAndPass(
  registry: ReturnType<typeof createMainRegistry>,
  lane: string,
  mode: 'full-envelope' = 'full-envelope',
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

export const SESSION_ENV_KEYS = [
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

export function withClearedSessionEnvironment<T>(
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

export function withSessionProvider<T>(
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

export function recordReviewerPasses(
  registry: ReturnType<typeof createMainRegistry>,
  provider: 'codex' | 'claude-code' | 'codex-cli' | 'claude-cli' = 'codex',
): void {
  withSessionProvider(provider, () => {
    for (const lane of REVIEW_LANES) startRunAndPass(registry, lane);
  });
}

export let materialChangeCounter = 1;

export function commitMaterialChange(root: string): void {
  // Each call must produce a DISTINCT materialDigest (a new commit with new content), so the
  // counter guarantees the file content actually changes even across repeated calls.
  materialChangeCounter += 1;
  write(root, 'packages/main/src/index.ts', `export const seed = true;\nexport const changed = ${materialChangeCounter};\n`);
  // Stage the whole tree so any verdict/process-event files written by a prior quorum are
  // committed too, leaving a clean working tree for the next review_run_start preflight.
  git(root, ['add', '-A']);
  git(root, [...COMMIT_ENV, 'commit', '-m', `material change ${materialChangeCounter}`]);
}

export let mainDriftCounter = 0;

export function commitMainDrift(root: string): void {
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

export function quorumProcessEventsPath(fixture: ReturnType<typeof makeFixture>): string {
  return join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl');
}

export function storyBackupFiles(fixture: ReturnType<typeof makeFixture>): string[] {
  return readdirSync(fixture.store.storyDirPath(STORY_ID))
    .filter(name => name.startsWith('process-events.jsonl.') && name.endsWith('.bak'));
}

export function storyOwnedDiffBlobs(root: string): string[] {
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

export function wholeTreeDiffPaths(root: string, fromHead: string): string[] {
  return git(root, ['diff', '--name-only', fromHead, 'HEAD']).split('\n').filter(Boolean).sort();
}

export function injectPoisonedDuplicates(
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

export function commitEventsRewrite(fixture: ReturnType<typeof makeFixture>, content: string, message: string): void {
  writeFileSync(quorumProcessEventsPath(fixture), content, 'utf8');
  git(fixture.root, ['add', '-A']);
  git(fixture.root, [...COMMIT_ENV, 'commit', '-m', message]);
}

export function committedHostVerdictLines(fixture: ReturnType<typeof makeFixture>): Array<Record<string, unknown>> {
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

export function injectPrecedingFailVerdict(
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

export function appendDuplicatesForRunId(
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

export function quorumFloorRounds(fixture: ReturnType<typeof makeFixture>) {
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

export function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tasks' ? [] : productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

export function directProcessEventAppends(): string[] {
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

export type QuorumSmokeLegacyFixtureContext = ReturnType<typeof makeFixture> & {
  previousCwd: string;
  result?: any;
  fixtureLease?: QuorumSmokeFixtureLease;
};

export function prepareCurrentRootContext(): { root: string } {
  return { root: process.cwd() };
}

export function prepareFreshFixtureContext(): QuorumSmokeLegacyFixtureContext {
  const previousCwd = process.cwd();
  const fixture = makeFixture();
  process.chdir(fixture.root);
  return { ...fixture, previousCwd };
}

const QUORUM_SMOKE_SHARED_FIXTURE_PROFILE = {
  id: 'global-thin-codex-v1',
  inputs: {
    assetMode: 'global-thin',
    selectedHost: 'codex',
    storySchema: 'v1',
    configProfile: 'balanced',
  },
} as const;

export async function prepareTemplateFixtureContext(
  executionContext: Record<string, any> = {},
): Promise<QuorumSmokeLegacyFixtureContext> {
  const runId = String(executionContext.runId ?? process.env.PROOF_OR_STOP_QUORUM_SMOKE_RUN_ID ?? 'standalone');
  const callbackNonce = executionContext.callbackTrace?.nonce
    ?? process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE;
  const caseId = String(executionContext.quorumSmokeCaseId ?? 'unknown-case');
  const pool = acquireQuorumSmokeFixtureRuntimePool({
    runId,
    callbackNonce,
    buildTemplate: ({ targetRoot }) => makeFixture('global-thin', 'codex', targetRoot),
  });
  const fixtureLease = await pool.clone(QUORUM_SMOKE_SHARED_FIXTURE_PROFILE, { caseId });
  const previousCwd = process.cwd();
  try {
    const fixture = openFixture(fixtureLease.root);
    process.chdir(fixture.root);
    return { ...fixture, previousCwd, fixtureLease };
  } catch (error) {
    process.chdir(previousCwd);
    fixtureLease.dispose();
    resetConfigCache();
    throw error;
  }
}

export function disposeFixtureContext(context: Record<string, any>): void {
  process.chdir(context.previousCwd);
  if (context.fixtureLease) context.fixtureLease.dispose();
  else removeQuorumSmokeOwnedFixtureRoot(context.root);
  resetConfigCache();
}

export function prepareIncrementalFixtureContext(): QuorumSmokeLegacyFixtureContext {
  const context = prepareFreshFixtureContext();
  try {
    recordReviewerPasses(context.registry);
    return context;
  } catch (error) {
    disposeFixtureContext(context);
    throw error;
  }
}

export function prepareStandingQuorumContext(): QuorumSmokeLegacyFixtureContext {
  const context = prepareFreshFixtureContext();
  try {
    recordReviewerPasses(context.registry);
    const handler = context.registry.get('quorum_submit');
    assert.ok(handler, 'quorum_submit handler is registered');
    const result: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke local voluntary quorum',
      format: 'json',
    });
    return { ...context, result };
  } catch (error) {
    disposeFixtureContext(context);
    throw error;
  }
}

export function runQuorumSmokeDynCase(caseId: string): void {
  const previousDyn5Cwd = process.cwd();
  try {
    withClearedSessionEnvironment(() => {
      withFreshFixture((fixture) => {
        const handler = fixture.registry.get('quorum_submit')!;
        if (caseId === 'quorum:scenario-1') {
          recordReviewerPasses(fixture.registry);
          const result: any = handler(quorumArgs());
          assert.equal(result.emittedCount, 6, 'real quorum submit must emit one 3x2 verdict set');
        } else if (caseId === 'quorum:scenario-2') {
          recordReviewerPasses(fixture.registry);
          handler(quorumArgs());
          assert.throws(() => handler(quorumArgs()), /verdicts already exist for runId/, 'duplicate quorum must be refused');
        } else if (caseId === 'quorum:scenario-3') {
          assert.throws(() => handler(quorumArgs()), /no current reviewer pass evidence/, 'quorum without reviewer passes must be refused');
        } else if (caseId === 'quorum:scenario-4') {
          recordReviewerPasses(fixture.registry);
          const result: any = handler(quorumArgs());
          assert.equal(result.emittedCount, 6, 'quorum floor must retain all three local rounds');
          assert.equal(quorumFloorRounds(fixture).validRounds.length, 3, 'quorum floor must observe three valid rounds');
        } else {
          throw new Error('unknown DYN-5 quorum case: ' + caseId);
        }
      });
    });
    console.log('PROOF_OR_STOP_DOMAIN_CASE:' + caseId);
  } finally {
    process.chdir(previousDyn5Cwd);
    resetConfigCache();
  }
}

export const QUORUM_SMOKE_CASES = [
  defineQuorumSmokeCase({
    id: "qsm-001",
    title: "every production process-event writer honors the shared append lock",
    domain: "integration",
    shard: "integration-a",
    capabilities: ["lock"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
    const lockFixture = createQuorumSmokeOwnedFixtureRoot('proof-or-stop-process-event-lock-');
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
          env: fixtureProcessEnvironment(),
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
      removeQuorumSmokeOwnedFixtureRoot(lockFixture);
    }
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-004",
    title: "real story-owned fixture delta is host-independent and requires case-level Story intent closure",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-005",
    title: "duplicate fixture identities always force full regardless of alias or ordering",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-006",
    title: "review_run_start CLI records reviewer-requested full escalation in envelope and signed run",
    domain: "integration",
    shard: "integration-a",
    capabilities: ["cli"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-007",
    title: "unsupported session providers cannot enter the dispatch-to-review-run-to-gate chain",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-008",
    title: "Codex and Claude CLI provider aliases complete the thin zero-asset review chain",
    domain: "integration",
    shard: "integration-a",
    capabilities: ["environment"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
        removeQuorumSmokeOwnedFixtureRoot(thin.root);
        resetConfigCache();
      }
    }
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-013",
    title: "worktree-local CLI commits the exact quorum batch through the production entrypoint",
    domain: "integration",
    shard: "integration-a",
    capabilities: ["git"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    sentinel: "real",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-014",
    title: "explicit full-envelope reviewer evidence crosses collector, REVIEW gate, and quorum admission",
    domain: "integration",
    shard: "integration-a",
    capabilities: ["signature"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      const configPath = join(fixture.root, 'proof-or-stop.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const modes = {
        'proof-or-stop-review-concept': 'full-envelope',
        'proof-or-stop-review-quality': 'full-envelope',
        'proof-or-stop-review-test-coverage': 'full-envelope',
      } as const;
      config.promptEnvelope.roles = modes;
      write(fixture.root, 'proof-or-stop.config.json', `${JSON.stringify(config, null, 2)}\n`);
      git(fixture.root, ['add', 'proof-or-stop.config.json']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '--allow-empty', '-m', 'select explicit full reviewer rollout']);
      resetConfigCache();

      withSessionProvider('codex', () => {
        for (const lane of REVIEW_LANES) startRunAndPass(fixture.registry, lane, modes[lane]);
      });
      const evidence = collectReviewerEvidenceState(fixture.store, STORY_ID, fixture.root);
      assert.equal(evidence.invalid.length, 0, `full-envelope collector invalid=${JSON.stringify(evidence.invalid)}`);
      assert.equal(evidence.valid.length, REVIEW_LANES.length);
      assert.equal(canPassReviewGuard({ storyId: STORY_ID, store: fixture.store, projectRoot: fixture.root }), true);
      const result: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(result.emittedCount, 6, 'full-envelope reviewer passes authorize the same 3x2 quorum batch');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-015",
    title: "production CLI refuses process-events, staged source, and lifecycle metadata pre-dirt",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-016",
    title: "historical RED dirty baseline makes CLI validation refuse canonical PASS persistence",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
    execFileSync('git', ['cat-file', '-e', `${HISTORICAL_RED_COMMIT}^{commit}`], {
      cwd: IMPLEMENTATION_REPO_ROOT,
      env: fixtureProcessEnvironment(),
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
      // Isolate dirty-publication refusal from the earlier scope preflight.
      fixture.registry.get('scope_contract_init_from_plan')!({ storyId: STORY_ID });
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
      assert.equal(result.status, 1, 'typed validation refusal must exit nonzero');
      assert.equal(payload.status, 'fail');
      assert.equal(payload.allPass, false);
      assert.equal(payload.failureKind, 'infra_failure');
      assert.equal(payload.disposition, undefined);
      assert.equal(payload.commandExecutions, 0);
      assert.match(result.stdout, /VALIDATION_PUBLICATION_NOT_READY/);
      assert.doesNotMatch(result.stdout, /bounded quorum CLI validation probe PASS/,
        'dirty-baseline refusal must not execute the validation command');
      assert.match(`${result.stdout}\n${result.stderr}`, /canonical metadata was already dirty|pre-existing|infra_failure/);
      assert.equal(fixture.store.readTestEvidence(STORY_ID)?.result, 'FAIL');
      assert.deepEqual(
        readFileSync(join(fixture.store.storyDirPath(STORY_ID), 'process-events.jsonl')),
        dirtyBytes,
        'validation refusal preserves the historical dirty baseline',
      );
      assert.doesNotMatch(result.stdout, /"result"\s*:\s*"PASS"|"status"\s*:\s*"pass"/);
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-017",
    title: "refuses when required reviewer passes are absent and writes no verdicts",
    domain: "integration",
    shard: "integration-a",
    fixtureConsumer: true,
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareTemplateFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { registry, store, root } }: { context: QuorumSmokeLegacyFixtureContext }) => {
    assertQuorumRefuses(registry, store, root, 'absent reviewer pass refusal');
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-018",
    title: "numerically sufficient compatibility/retired-only receipts cannot authorize quorum",
    domain: "integration",
    shard: "integration-a",
    fixtureConsumer: true,
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareTemplateFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { root, store, registry } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-019",
    title: "refuses when reviewer passes are stale and writes no verdicts",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareFreshFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { store, registry, root } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-020",
    title: "machine REVIEW and quorum consume the same full-envelope replay/tamper proof",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareFreshFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { registry, root, store } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-021",
    title: "explicit full-asset mode binds Claude and Codex independently and rejects selected-host drift",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
        removeQuorumSmokeOwnedFixtureRoot(full.root);
        resetConfigCache();
      }
    }
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-022",
    title: "emits exactly rounds x 2 verdicts after current reviewer passes",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareIncrementalFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { registry, root, store, result } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
    assert.equal(result.schemaVersion, 'proof-or-stop.quorum_submit.v1');
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-023",
    title: "review_escalation_status and review assurance floor report complete voluntary 3x2 rounds",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { result, root, store, registry } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
      authorityDone: false, // legacy compatibility assertion
      fullAuthorityDone: false, // legacy compatibility assertion
      productionDone: false, // legacy compatibility assertion
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-024",
    title: "auto-computed materialDigest and storyFilesHash match current helpers",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { result, root } }: { context: QuorumSmokeLegacyFixtureContext }) => {
    assert.equal(result.materialDigest, currentMaterialHash(root));
    assert.equal(result.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root));
    assert.match(result.validationDigest, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostA, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostB, /^[0-9a-f]{64}$/);
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-025",
    title: "hosts are independent by hostId, sessionId, and keyId",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { result, root } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-026",
    title: "never sets authorityDone, fullAuthorityDone, or productionDone", // legacy compatibility assertion
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { result, root } }: { context: QuorumSmokeLegacyFixtureContext }) => {
    assert.equal(result.authorityDone, false); // legacy compatibility assertion
    assert.equal(result.fullAuthorityDone, false); // legacy compatibility assertion
    assert.equal(result.productionDone, false); // legacy compatibility assertion
    assert.equal(result.reviewEscalationStatus.authorityDone, false); // legacy compatibility assertion
    assert.equal(result.reviewEscalationStatus.fullAuthorityDone, false); // legacy compatibility assertion
    assert.equal(result.reviewEscalationStatus.productionDone, false); // legacy compatibility assertion
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.authorityDone, false); // legacy compatibility assertion
      assert.equal(summary.fullAuthorityDone, false); // legacy compatibility assertion
      assert.equal(summary.multiHostVerified, false);
    }
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-027",
    title: "refuses a same-material re-submit and writes no new verdicts",
    domain: "integration",
    shard: "integration-a",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { store, root, registry } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-028",
    title: "same-material duplicate refusal survives deletion of the ignored verdict cache",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const beforeEvents = hostVerdictEventCount(fixture.store);
      assert.equal(verdictFileCount(fixture.root), 6, 'the retry witness starts with a populated canonical verdict cache');
      rmSync(join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID), { recursive: true, force: true });
      assert.equal(verdictFileCount(fixture.root), 0, 'the retry witness actually deletes the canonical verdict cache');
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /quorum_submit refuses: verdicts already exist for runId/,
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(hostVerdictEventCount(fixture.store), beforeEvents);
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-029",
    title: "allows a fresh quorum after a material change",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareStandingQuorumContext,
    dispose: disposeFixtureContext,
    run: ({ context: { root, registry } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-030",
    title: "--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareFreshFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { root, registry, store } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
    assert.equal(customResult.authorityDone, false); // legacy compatibility assertion
    assert.equal(customResult.fullAuthorityDone, false); // legacy compatibility assertion
    assert.equal(customResult.productionDone, false); // legacy compatibility assertion
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-031",
    title: "refuses a redundant re-submit when the standing quorum drift-accepts",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-032",
    title: "blank storyFilesHash on committed legacy verdicts is no-signal for the drift branch",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-033",
    title: "EMPTY_STORY_FILES_HASH current state allows resubmit instead of falsely drift-accepting (F-035)",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-034",
    title: "a second main drift does not circumvent the drift-accept refusal",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-035",
    title: "a story-owned file change after main drift makes the re-quorum genuine again",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-036",
    title: "refuses pre-existing user dirt before writing any verdict",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-037",
    title: "foreign append fails exact verification and rolls back only the six owned verdicts",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-038",
    title: "capture-time failure rolls back the just-written event and verdict JSON",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-039",
    title: "between-row foreign append preserves foreign bytes and rolls back row two",
    domain: "integration",
    shard: "integration-b",
    capabilities: ["concurrency"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-040",
    title: "writer-owned append identity never claims a foreign row inserted before host_verdict",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-041",
    title: "rollback never deletes an owned-row byte sequence embedded inside foreign binary",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-042",
    title: "same-verdictId mutation of a gate-consumed field is refused and rolled back",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-043",
    title: "rollback preserves a concurrently changed verdict JSON with the same verdictId",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-044",
    title: "rollback preserves non-UTF8 blank and unterminated foreign suffix bytes exactly",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-045",
    title: "commit-hook rejection rolls back all rows and a clean retry succeeds once",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-046",
    title: "atomic quorum commit hashes process-events larger than one MiB",
    domain: "integration",
    shard: "integration-b",
    capabilities: ["large-file"],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    sentinel: "real",
    run: () => {
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
      rmSync(join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID), { recursive: true, force: true });
      assert.throws(
        () => fixture.registry.get('quorum_submit')!(quorumArgs()),
        /quorum_submit refuses: verdicts already exist for runId/,
        'the committed >1MiB process-events log remains the duplicate authority after cache deletion',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), committedHead, 'large same-material retry writes no commit');
      assert.equal(hostVerdictEventCount(fixture.store), beforeRetryEvents, 'large same-material retry writes no event');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-047",
    title: "large atomic quorum commit still rejects a post-manifest mutation",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-048",
    title: "HEAD movement loses the CAS without reverting the competing HEAD",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-049",
    title: "rollback conflict preserves competing prefix bytes and removes every countable verdict",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-050",
    title: "rejects non-independent host identity before writing additional verdicts",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    prepare: prepareIncrementalFixtureContext,
    dispose: disposeFixtureContext,
    run: ({ context: { store, root, registry } }: { context: QuorumSmokeLegacyFixtureContext }) => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-072",
    title: "quorum_submit re-checks the duplicate guard against the captured HEAD (F-028)",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-073",
    title: "quorum_submit compares the same-material guard on the normalized digest (F-029)",
    domain: "integration",
    shard: "integration-b",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    run: () => {
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
  },
  })
];
