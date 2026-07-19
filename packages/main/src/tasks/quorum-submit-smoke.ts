#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { captureLifecycleMetadataTransaction } from '../core/auto-commit-metadata.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
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
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetSessionIdForTest, resolveSessionIdentity } from '../core/owner-session.js';
import { computePromptEnvelopeId } from '../core/prompt-envelope.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../core/prompt-role-contract-registry.js';
import { isModularReviewerRoleId, readPromptRegistry, renderPromptEntryForHost, type PromptHost } from '../core/prompt-registry.js';
import { renderReviewerRunBootstrapForTemplate } from '../core/global-agents.js';
import { StoryStore } from '../core/store.js';
import { listVerdicts, summarizeVerdicts } from '../core/verdicts.js';
import { createMainRegistry } from '../registry.js';
import { createQuorumSubmitHandlers } from '../handlers/quorum-submit.js';
import type { HandlerContext } from '../handlers/context.js';
import { reviewerPromptHostForProvider } from '../handlers/story-dispatch.js';
import type { ChecklistData, Finding, ReviewPass, ReviewRun, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-quorum-smoke';
const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const DIST_DIRTY_GATE_POLICY_PATH = fileURLToPath(new URL('../core/dirty-gate-policy.js', import.meta.url));
const IMPLEMENTATION_REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const HISTORICAL_RED_COMMIT = 'ffedfb4eb3';
const REVIEW_ROUND = '2026-06-22T10:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=quorum-smoke@example.test', '-c', 'user.name=Quorum Submit Smoke'];
const REVIEW_LANES = [
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-test-coverage',
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
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-quorum-submit-'));
  writeConfig(root);
  write(root, '.gitignore', '.lattice/autopilot-verdicts/\n.lattice/activity.jsonl\n.lattice/locks/\n');
  write(root, 'bin/lattice.js', `#!/usr/bin/env node\nimport ${JSON.stringify(DIST_CLI_PATH)};\n`);
  write(root, 'probe.mjs', [
    "import { appendFileSync } from 'node:fs';",
    "if (process.env.QUORUM_CLI_PROBE_COUNTER) appendFileSync(process.env.QUORUM_CLI_PROBE_COUNTER, 'run\\n');",
    "console.log('bounded quorum CLI validation probe PASS');",
    '',
  ].join('\n'));
  write(root, '.lattice/lattice.json', `${JSON.stringify({ assetMode }, null, 2)}\n`);
  if (assetMode === 'full') {
    const promptRegistry = readPromptRegistry();
    const assetDir = selectedHost === 'codex' ? '.lattice-codex/agents' : '.claude/agents';
    for (const lane of REVIEW_LANES) {
      const entry = promptRegistry.agents.find(candidate => candidate.agentId === lane)!;
      const hostTemplate = renderPromptEntryForHost(entry, selectedHost);
      write(root, `${assetDir}/${entry.file}`, isModularReviewerRoleId(entry.agentId)
        ? renderReviewerRunBootstrapForTemplate(hostTemplate, entry.file)
        : hostTemplate);
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
  git(root, ['add', '.lattice/story', 'lattice.config.json']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story review metadata']);

  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  return { root, store, ctx, registry };
}

function runFixtureCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['bin/lattice.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      LATTICE_PROJECT_ROOT: root,
      LATTICE_SESSION_ID: 'quorum-submit-cli-integration',
      LATTICE_ACTIVITY_SOURCE: 'codex',
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
    fn(fixture);
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

function verdictFileCount(root: string): number {
  return listVerdicts(root, 'local', STORY_ID).length;
}

function assertQuorumRefuses(registry: ReturnType<typeof createMainRegistry>, store: StoryStore, root: string, label: string): void {
  const beforeEvents = hostVerdictEventCount(store);
  const beforeVerdicts = verdictFileCount(root);
  const handler = registry.get('quorum_submit');
  assert.ok(handler, 'quorum_submit handler is registered');
  assert.throws(
    () => handler({
      storyId: STORY_ID,
      hostA: 'host-a',
      hostB: 'host-b',
      format: 'json',
    }),
    /quorum_submit refuses: no current reviewer pass evidence for the required lanes/,
    label,
  );
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
  'LATTICE_SESSION_ID',
  'LATTICE_ACTIVITY_SOURCE',
  'LATTICE_ACTIVITY_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
  'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_TASK',
  'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
  'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'AGY_SESSION_ID',
] as const;

function withSessionProvider<T>(
  provider: string | undefined,
  fn: () => T,
  competingEnv: Record<string, string> = {},
): T {
  const previous = Object.fromEntries(SESSION_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of SESSION_ENV_KEYS) delete process.env[key];
  process.env.LATTICE_SESSION_ID = `sess-quorum-${provider ?? 'absent'}`;
  if (provider !== undefined) process.env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER = provider;
  for (const [key, value] of Object.entries(competingEnv)) process.env[key] = value;
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

let passed = 0;
function check(name: string, fn: () => void): void {
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

const previousCwd = process.cwd();
const { root, store, registry } = makeFixture();

try {
  process.chdir(root);

  check('every production process-event writer honors the shared append lock', () => {
    const lockFixture = mkdtempSync(join(tmpdir(), 'lattice-process-event-lock-'));
    try {
      const storyDirRel = '.lattice/story/actives';
      const storyDir = join(lockFixture, storyDirRel, STORY_ID);
      const lockDir = join(storyDir, '.process-events-append.lock');
      mkdirSync(lockDir, { recursive: true });
      write(lockFixture, 'invoke-audit-writer.mjs', [
        `import { defaultAuditWriter } from ${JSON.stringify(DIST_DIRTY_GATE_POLICY_PATH)};`,
        `defaultAuditWriter(${JSON.stringify(lockFixture)}, ${JSON.stringify(storyDirRel)}, ${JSON.stringify(STORY_ID)})({`,
        "  type: 'dirty_gate_audit',",
        `  storyId: ${JSON.stringify(STORY_ID)},`,
        "  gate: 'validate-side-effect',",
        "  category: 'lattice_metadata_changes',",
        "  pathCount: 1,",
        "  paths: ['.lattice/story/actives/B-quorum-smoke/index.json'],",
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
        LATTICE_SESSION_ID: 'sess-explicit-invalid',
        LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: 'gemini',
        ...competingEnv,
      }, inputs);
      assert.equal(invalid.hostProvider, 'unknown', 'explicit invalid provider cannot fall through to competing host variables');
      assert.equal(invalid.sessionSource, 'explicit-env');
    }
    const absentCodex = resolveSessionIdentity({
      LATTICE_SESSION_ID: 'sess-absent-codex',
      CODEX_THREAD_ID: 'inferred-codex-thread',
    }, inputs);
    assert.equal(absentCodex.hostProvider, 'codex', 'absent explicit provider preserves Codex inference');
    const absentClaude = resolveSessionIdentity({
      LATTICE_SESSION_ID: 'sess-absent-claude',
      CLAUDE_CODE_SESSION_ID: 'inferred-claude-session',
    }, inputs);
    assert.equal(absentClaude.hostProvider, 'claude-code', 'absent explicit provider preserves Claude inference');
  });

  check('real story-owned fixture delta reaches incremental only with case-level Story intent closure', () => {
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
      dispatch({ storyId: STORY_ID, agentType: 'lattice-review-quality' });
      const output = String(start({ storyId: STORY_ID, agent: 'lattice-review-quality' }));
      assert.match(output, /context incremental\/SAFE_INCREMENTAL/);
      const latest = [...fixture.store.readReviewRuns(STORY_ID).runs].reverse().find(
        candidate => candidate.lane === 'lattice-review-quality',
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
      dispatch({ storyId: STORY_ID, agentType: 'lattice-review-quality' });
      const rejectedOutput = String(start({ storyId: STORY_ID, agent: 'lattice-review-quality' }));
      assert.match(rejectedOutput, /context full\/SAFETY_REQUIRES_FULL/);
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
        dispatch({ storyId: STORY_ID, agentType: 'lattice-review-quality' });
        const output = String(start({ storyId: STORY_ID, agent: 'lattice-review-quality' }));
        assert.match(output, /context full\/SAFETY_REQUIRES_FULL/, `${label} must select safety full`);
      }
    });
  });

  check('review_run_start CLI records reviewer-requested full escalation in envelope and signed run', () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const dispatch = runFixtureCli(fixture.root, [
        'dispatch',
        JSON.stringify({ storyId: STORY_ID, agentType: 'lattice-review-quality' }),
      ], { LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' });
      assert.equal(dispatch.status, 0, dispatch.stderr);
      const reason = 'Bounded basis omitted an affected contract required by the reviewer.';
      const started = runFixtureCli(fixture.root, [
        'review_run_start',
        JSON.stringify({
          storyId: STORY_ID,
          agent: 'lattice-review-quality',
          reviewerEscalationReason: reason,
        }),
      ], { LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' });
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /context full\/REVIEWER_REQUESTED_FULL/);
      assert.match(started.stdout, /reviewer escalation: Bounded basis omitted/);
      const latest = [...fixture.store.readReviewRuns(STORY_ID).runs].reverse().find(
        candidate => candidate.lane === 'lattice-review-quality',
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
    const primaryCwd = process.cwd();
    for (const testCase of cases) {
      const unsupported = makeFixture('global-thin');
      try {
        process.chdir(unsupported.root);
        withSessionProvider(testCase.provider, () => {
          const dispatch = unsupported.registry.get('dispatch');
          const start = unsupported.registry.get('review_run_start');
          assert.ok(dispatch, 'dispatch handler is registered');
          assert.ok(start, 'review_run_start handler is registered');
          assert.throws(
            () => dispatch({ storyId: STORY_ID, agentType: 'lattice-review-quality' }),
            new RegExp(`unsupported session host provider "${testCase.diagnostic}"`),
            `${testCase.label} dispatch fails closed`,
          );
          assert.throws(
            () => start({ storyId: STORY_ID, agent: 'lattice-review-quality' }),
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
      } finally {
        process.chdir(primaryCwd);
        rmSync(unsupported.root, { recursive: true, force: true });
        resetConfigCache();
      }
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
        assert.equal(existsSync(join(thin.root, '.lattice-codex/agents')), false);
        assert.equal(existsSync(join(thin.root, '.claude/agents')), false);
        recordReviewerPasses(thin.registry, selected.provider);
        const thinEvidence = collectReviewerEvidenceState(thin.store, STORY_ID, thin.root);
        const qualityDispatch = [...thin.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'lattice-review-quality',
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
      const configPath = join(fixture.root, 'lattice.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const modes = {
        'lattice-review-concept': 'legacy-full-context',
        'lattice-review-quality': 'full-envelope',
        'lattice-review-test-coverage': 'legacy-full-context',
      } as const;
      config.promptEnvelope.roles = modes;
      write(fixture.root, 'lattice.config.json', `${JSON.stringify(config, null, 2)}\n`);
      git(fixture.root, ['add', 'lattice.config.json']);
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
      git(fixture.root, ['add', '.lattice/story']);
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
    const aliases = ['implementation-reviewer', 'test-intent', 'lattice-review-channel'];
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
      .find(run => run.lane === 'lattice-review-quality');
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
        assetPath: '.lattice-codex/agents/lattice-review-quality.md',
        otherAssetDir: '.claude/agents',
      },
      {
        host: 'claude',
        provider: 'claude-code',
        assetPath: '.claude/agents/lattice-review-quality.md',
        otherAssetDir: '.lattice-codex/agents',
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
          .find(run => run.lane === 'lattice-review-quality');
        assert.ok(qualityRun, `${selected.host} quality reviewer run exists for full-asset drift verification`);
        const qualityDispatch = [...full.store.readProcessEvents(STORY_ID)].reverse().find(
          event => event.type === 'dispatch' && event.agentType === 'lattice-review-quality',
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
      run => run.lane === 'lattice-review-quality',
    )!;
    const postRunFinding: Finding = {
      id: `${STORY_ID}:F-CUTOFF`,
      desc: 'Low-severity finding recorded after the incremental ReviewRun snapshot.',
      severity: 'low',
      category: 'edge',
      status: 'open',
      evidenceState: 'verified',
      agent: 'lattice-review-quality',
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
      rmSync(join(fixture.root, '.lattice', 'autopilot-verdicts', STORY_ID), { recursive: true, force: true });
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
          changedPath = join(fixture.root, '.lattice', 'autopilot-verdicts', STORY_ID, `${verdictId}.json`);
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

  console.log(`\n✓ quorum_submit smoke passed (${passed} checks)`);
} finally {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}
