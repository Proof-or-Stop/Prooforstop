#!/usr/bin/env node

import assert from 'node:assert/strict';
// B-cc10: dispatch paths must come from the resolver, not a hardcoded state-dir literal.
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { PROCESS_FACT_LEVEL_BY_NAME } from '../core/process-fact-levels.js';
import { canonicalReviewHostLauncherSpec } from '../core/host-execution-readiness.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  StoryInfo,
} from '../core/types.js';
import type {
  DispatchAutoResult,
  DispatchCollection,
  DispatchListResult,
  DispatchMergePlanResult,
  DispatchPlanResult,
  DispatchReceiptDraft,
  DispatchReassignResult,
  DispatchRecord,
  DispatchReviewResult,
  DispatchRunResult,
  DispatchRunnerRecord,
  DispatchStatusResult,
  DispatchWatchResult,
  HostRuntimeList,
  HostRuntimeProbe,
} from '../core/proof-or-stop-dispatch.js';
import { relativePathStaysWithinRoot, runDispatch } from '../core/proof-or-stop-dispatch.js';
import type {
  DispatchPolicy,
  DispatchPolicyCheckResult,
} from '../core/dispatch-policy.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_COMMANDS = [
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_prepare',
  'dispatch_run',
  'overflow_auto',
  'dispatch_collect',
  'dispatch_receipt_create',
  'dispatch_status',
  'dispatch_list',
  'dispatch_resume',
  'dispatch_reassign',
  'dispatch_cancel',
  'dispatch_review',
  'dispatch_merge_plan',
  'dispatch_policy_create',
  'dispatch_policy_get',
  'dispatch_policy_check',
  'dispatch_auto',
  'dispatch_watch',
] as const;

const READ_ONLY_EXPECTED = new Set([
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_status',
  'dispatch_list',
  'dispatch_review',
  'dispatch_merge_plan',
  'dispatch_policy_get',
  'dispatch_policy_check',
  'dispatch_watch',
]);

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
  }, null, 2) + '\n');
}

function initRepo(root: string, externalDir: string): void {
  mkdirSync(join(root, 'packages/main/src/generated'), { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  symlinkSync(externalDir, join(root, 'packages/main/src/generated/external-link'), 'dir');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'README.md'), '# dispatch run smoke\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'proofOrStop@example.com']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, storyId = 'B-dispatch'): void {
  const now = '2026-06-02T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'dispatch-run-smoke',
    title: 'Dispatch run smoke story',
    description: 'Smoke story for Proof-or-Stop dispatch_run automatic overflow.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: `story/${storyId}` }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Dispatch run smoke',
        status: 'done',
        startTime: now,
        endTime: now,
      },
    ],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function assertAuthorityFalse(value: unknown, label = 'result'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAuthorityFalse(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['authorityChanged', 'receiptVerified', 'productionDone']) {
    if (key in record) assert.equal(record[key], false, `${label}.${key}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertAuthorityFalse(nested, `${label}.${key}`);
  }
}

function dispatchCount(root: string): number {
  const dir = join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches`);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(entry => existsSync(join(dir, entry, 'dispatch.json'))).length;
}

function readDispatch(root: string, dispatchId: string): DispatchRecord {
  return JSON.parse(readFileSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches`, dispatchId, 'dispatch.json'), 'utf8')) as DispatchRecord;
}

function writeDispatch(root: string, dispatchId: string, record: DispatchRecord): void {
  writeFileSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches`, dispatchId, 'dispatch.json'), JSON.stringify(record, null, 2) + '\n');
}

function readPack(root: string, dispatchId: string): {
  packId: string;
  packHash: string;
  fromHost: string;
  toHost: string;
  baseSha?: string;
  role?: string;
  objective?: string;
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  authorityBoundary: { summary: string };
  executionInstructions: string[];
} {
  return JSON.parse(readFileSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches`, dispatchId, 'pack.json'), 'utf8')) as {
    packId: string;
    packHash: string;
    fromHost: string;
    toHost: string;
    baseSha?: string;
    role?: string;
    objective?: string;
    allowedPaths: string[];
    deniedPaths: string[];
    requiredCommands: string[];
    successCriteria: string[];
    authorityBoundary: { summary: string };
    executionInstructions: string[];
  };
}

function projectedDispatchWorktreePath(root: string, storyId: string, dispatchId: string): string {
  return join(root, '.worktrees', 'overflow', storyId, dispatchId);
}

function projectedDispatchWorktreeStoryRoot(root: string, storyId: string): string {
  return join(root, '.worktrees', 'overflow', storyId);
}

function seedProjectedDispatchWorktreeRootSymlink(root: string, storyId: string, dispatchId: string, externalTarget: string): string {
  const projectedRoot = projectedDispatchWorktreePath(root, storyId, dispatchId);
  mkdirSync(dirname(projectedRoot), { recursive: true });
  rmSync(projectedRoot, { recursive: true, force: true });
  symlinkSync(externalTarget, projectedRoot, 'dir');
  return projectedRoot;
}

function seedProjectedDispatchWorktreeAncestorSymlink(root: string, storyId: string, externalTarget: string): string {
  const projectedStoryRoot = projectedDispatchWorktreeStoryRoot(root, storyId);
  mkdirSync(dirname(projectedStoryRoot), { recursive: true });
  rmSync(projectedStoryRoot, { recursive: true, force: true });
  symlinkSync(externalTarget, projectedStoryRoot, 'dir');
  return projectedStoryRoot;
}

function isProjectedWorktreeContainmentFailure(detail: string): boolean {
  return /real git worktree root, not a symlink|resolves outside the isolated worktree via an existing symlinked path segment|traverses a symlinked ancestor|ancestor must be a directory|ancestor resolves outside the repository root/i.test(detail);
}

function assertFiveWayRegistration(command: string, registry: ReturnType<typeof createMainRegistry>): void {
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `${command} missing MAIN_TOOLS entry`);
  assert.equal(registry.has(command), true, `${command} missing registry handler`);
  assert.ok(command in COMMAND_POLICIES, `${command} missing command policy`);
  assert.ok(PROCESS_FACT_LEVEL_BY_NAME[command], `${command} missing process fact level`);
  const ownership = COMMAND_POLICIES[command as keyof typeof COMMAND_POLICIES].ownershipClass;
  if (READ_ONLY_EXPECTED.has(command)) {
    assert.equal(ownership, 'readOnly', `${command} should stay read-only`);
  }
}

function writeFakeCodexBinary(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'codex'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const argvFile = process.env.PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE;',
    'if (!argvFile) process.exit(64);',
    'const stdinFile = process.env.PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE;',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)), 'utf8');",
    "  if (stdinFile) fs.writeFileSync(stdinFile, input, 'utf8');",
    "  process.stdout.write(JSON.stringify({ model: 'fake-codex-model', usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\\n');",
    '});',
  ].join('\n') + '\n', { encoding: 'utf8', mode: 0o755 });
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-suite-'));
const root = join(sandboxRoot, 'repo', 'root');
const externalDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-external-'));
const externalMarker = join(externalDir, 'blocked-by-symlink.txt');
const fakeCodexBinDir = join(sandboxRoot, 'fake-codex-bin');
const fakeCodexArgvFile = join(sandboxRoot, 'fake-codex-argv.json');
const fakeCodexStdinFile = join(sandboxRoot, 'fake-codex-stdin.txt');
const escapedHostRuntimeListOutput = resolve(root, '../escape.json');
const escapedDispatchPlanOutput = resolve(root, '../../escape.json');
const outputSymlinkEscapeMarker = join(externalDir, 'nested/output-symlink-escape.json');
const fakeProjectedRootExternalDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-fake-root-'));
const realProjectedRootExternalDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-real-root-'));
const fakeAncestorExternalDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-fake-ancestor-'));
const realAncestorExternalDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-dispatch-run-real-ancestor-'));
try {
  initRepo(root, externalDir);
  writeFakeCodexBinary(fakeCodexBinDir);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);
  seedStory(store, 'B-ancestor-attack');
  seedStory(store, 'B-chk006-auto');
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };
  const runText = (name: string, args: Record<string, unknown> = {}): string => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler(args) as string;
  };

  assert.equal(relativePathStaysWithinRoot('', win32.isAbsolute), true, 'empty relative path stays within root');
  assert.equal(relativePathStaysWithinRoot(`nested${win32.sep}file.txt`, win32.isAbsolute), true, 'nested win32 relative path stays within root');
  assert.equal(relativePathStaysWithinRoot(`..${win32.sep}outside`, win32.isAbsolute), false, 'parent traversal must escape root');
  assert.equal(relativePathStaysWithinRoot('D:\\outside', win32.isAbsolute), false, 'win32 cross-drive absolute relative() result must escape root');

  for (const command of EXPECTED_COMMANDS) assertFiveWayRegistration(command, registry);
  assert.equal(PROCESS_FACT_LEVEL_BY_NAME.dispatch_reassign?.level, 'L1', 'dispatch_reassign must be L1 dispatch metadata');
  assert.equal(PROCESS_FACT_LEVEL_BY_NAME.dispatch_reassign?.category, 'proof-or-stop-dispatch', 'dispatch_reassign must be proof-or-stop-dispatch category');

  const runtimeList = run<HostRuntimeList>('host_runtime_list');
  assert.equal(runtimeList.schemaVersion, 'lattice.host_runtime_list.v1');
  assert.deepEqual(runtimeList.runtimes.map(runtime => runtime.host), ['fake', 'codex', 'claude-code', 'antigravity']);
  assert.equal(runtimeList.runtimes.find(runtime => runtime.host === 'fake')?.status, 'ready');
  assertAuthorityFalse(runtimeList, 'runtimeList');

  const fakeProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'fake' });
  assert.equal(fakeProbe.status, 'ready');
  assert.equal(fakeProbe.supportsParallel, true);
  assert.equal(fakeProbe.versionStatus, 'detected');
  assert.equal(fakeProbe.version, 'fake-deterministic');
  assert.equal(fakeProbe.noninteractiveSupport, 'supported');
  assert.equal(fakeProbe.cwdSupport, 'supported');
  assert.equal(fakeProbe.timeoutSupport, 'supported');
  assert.equal(fakeProbe.transcriptSupport, 'supported');
  assert.equal(fakeProbe.envSafetyPosture, 'sandboxed');
  assert.equal(fakeProbe.unattendedSafe, false, 'fake probe must never set unattendedSafe=true');
  assert.ok(Array.isArray(fakeProbe.unattendedReasons), 'fake probe must have unattendedReasons array');
  assert.ok(Array.isArray(fakeProbe.degradations), 'fake probe must have degradations array');
  assertAuthorityFalse(fakeProbe, 'fakeProbe');
  assert.throws(() => run<HostRuntimeProbe>('host_runtime_probe', { host: 'unknown-host' }), /requires host=fake\|codex\|claude-code\|antigravity.*agy aliases to antigravity.*gemini is accepted only for legacy compatibility/i);

  // CHK-002: Claude Code bounded unattended feasibility probe
  // Must work whether claude is installed or not
  const claudeProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'claude-code' });
  assert.equal(claudeProbe.host, 'claude-code');
  assert.equal(claudeProbe.schemaVersion, 'lattice.host_runtime_probe.v1');
  assert.deepEqual(
    claudeProbe.invocationTemplate,
    canonicalReviewHostLauncherSpec('claude').launcherArgv,
    'claude-code invocationTemplate must use observable --verbose stream-json launcher',
  );
  // Structured feasibility fields must always be present
  assert.ok(['detected', 'unavailable', 'unknown'].includes(claudeProbe.versionStatus), `claude versionStatus must be a known value, got ${claudeProbe.versionStatus}`);
  assert.ok(['supported', 'unverified', 'unsupported'].includes(claudeProbe.noninteractiveSupport), `claude noninteractiveSupport must be a known value, got ${claudeProbe.noninteractiveSupport}`);
  assert.ok(['supported', 'unverified'].includes(claudeProbe.cwdSupport), `claude cwdSupport must be a known value, got ${claudeProbe.cwdSupport}`);
  assert.ok(['supported', 'unverified'].includes(claudeProbe.timeoutSupport), `claude timeoutSupport must be a known value, got ${claudeProbe.timeoutSupport}`);
  assert.ok(['supported', 'unverified'].includes(claudeProbe.transcriptSupport), `claude transcriptSupport must be a known value, got ${claudeProbe.transcriptSupport}`);
  assert.ok(['sandboxed', 'inherited', 'unverified'].includes(claudeProbe.envSafetyPosture), `claude envSafetyPosture must be a known value, got ${claudeProbe.envSafetyPosture}`);
  assert.equal(claudeProbe.unattendedSafe, false, 'claude-code must not claim unattendedSafe=true — dispatch_policy_check authorization and dispatch_auto policy binding required first');
  assert.ok(Array.isArray(claudeProbe.unattendedReasons), 'claude probe must have unattendedReasons array');
  assert.ok(claudeProbe.unattendedReasons.length > 0, 'claude probe must explain why unattendedSafe=false');
  assert.ok(
    claudeProbe.unattendedReasons.some(reason => /policy|dispatch_policy|dispatch_auto/i.test(reason)),
    'claude probe must surface dispatch_policy_check / dispatch_auto policy binding requirement as a reason for unattendedSafe=false',
  );
  assert.ok(Array.isArray(claudeProbe.degradations), 'claude probe must have degradations array');
  assert.ok(typeof claudeProbe.nextAction === 'string' && claudeProbe.nextAction.length > 0, 'claude probe must have a nextAction');
  // nextAction must indicate supervised-only or unavailable, not full authorization
  assert.ok(
    /supervised-only|unavailable|policy|install|expose/i.test(claudeProbe.nextAction),
    `claude probe nextAction must indicate supervised-only or missing CLI, got: ${claudeProbe.nextAction}`,
  );
  assertAuthorityFalse(claudeProbe, 'claudeProbe');

  const antigravityProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'antigravity' });
  assert.equal(antigravityProbe.host, 'antigravity');
  assert.equal(antigravityProbe.requestedHost, 'antigravity');
  assert.equal(antigravityProbe.schemaVersion, 'lattice.host_runtime_probe.v1');
  assert.equal(antigravityProbe.cliCommand, 'agy');
  assert.ok(antigravityProbe.invocationTemplate?.includes('--print'), 'antigravity template must use agy --print');
  assert.ok(antigravityProbe.invocationTemplate?.includes('--print-timeout'), 'antigravity template must include --print-timeout');
  assert.ok(antigravityProbe.invocationTemplate?.includes('<prompt>'), 'antigravity template must carry canonical prompt placeholder');
  assert.equal(antigravityProbe.invocationTemplate?.includes('--prompt-file'), false, 'antigravity template must not use unsupported --prompt-file');
  assert.equal(antigravityProbe.unattendedSafe, false, 'antigravity must not claim unattendedSafe=true');
  assert.ok(Array.isArray(antigravityProbe.unattendedReasons), 'antigravity probe must have unattendedReasons array');
  assert.ok(
    antigravityProbe.unattendedReasons.some(reason => /dispatch_policy_check|dispatch_auto|policy binding/i.test(reason)),
    'antigravity probe must surface dispatch_policy_check / dispatch_auto policy binding requirement',
  );
  assertAuthorityFalse(antigravityProbe, 'antigravityProbe');

  const agyProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'agy' });
  assert.equal(agyProbe.host, 'antigravity');
  assert.equal(agyProbe.requestedHost, 'agy');
  assert.equal(agyProbe.matchedFallback, true, 'agy aliases to the current Antigravity runtime');
  assert.equal(agyProbe.cliCommand, 'agy');
  assertAuthorityFalse(agyProbe, 'agyProbe');

  const codexProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'codex' });
  assert.ok(codexProbe.invocationTemplate?.includes('exec'), 'codex template must use codex exec');
  assert.ok(codexProbe.invocationTemplate?.includes('--json'), 'codex template must use --json for observable events');
  assert.ok(codexProbe.invocationTemplate?.includes('<prompt>'), 'codex template must carry canonical prompt placeholder');
  assert.equal(codexProbe.invocationTemplate?.includes('--prompt-file'), false, 'codex template must not use --prompt-file');

  // If claude is installed, additional shape assertions apply
  if (claudeProbe.available) {
    assert.ok(['detected', 'unknown'].includes(claudeProbe.versionStatus), `installed claude must have detected or unknown versionStatus, got ${claudeProbe.versionStatus}`);
    assert.ok(['supported', 'unverified', 'unsupported'].includes(claudeProbe.noninteractiveSupport), 'installed claude must report noninteractive support');
    assert.equal(claudeProbe.cwdSupport, 'supported', 'installed claude must have cwdSupport=supported');
    assert.equal(claudeProbe.timeoutSupport, 'supported', 'installed claude must have timeoutSupport=supported');
    assert.equal(claudeProbe.transcriptSupport, 'supported', 'installed claude must have transcriptSupport=supported');
    // Even if installed and noninteractive is supported, dispatch_auto + policy binding still blocks unattendedSafe
    assert.equal(claudeProbe.unattendedSafe, false, 'installed claude must not be unattendedSafe without dispatch_auto policy binding');
    assert.match(claudeProbe.nextAction, /supervised-only|dispatch_auto|policy/i, 'installed claude without dispatch_auto policy binding must surface supervised-only nextAction');
  } else {
    // CLI not installed
    assert.equal(claudeProbe.status, 'unavailable');
    assert.equal(claudeProbe.runtimeKind, 'missing-cli');
    assert.ok(
      claudeProbe.unattendedReasons.some(reason => /not available|install|expose|PATH/i.test(reason)),
      'unavailable claude probe must explain CLI is not in PATH',
    );
  }

  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: '../escape.json' }),
    /--output escapes the repository root via path traversal/i,
    'host_runtime_list --output=../escape.json must be rejected before writing outside root',
  );
  assert.equal(existsSync(escapedHostRuntimeListOutput), false, 'host_runtime_list escaped output must never be created');
  assert.throws(
    () => runText('dispatch_plan', {
      storyId: 'B-dispatch',
      host: 'fake',
      objective: 'Escaped output must be rejected.',
      output: '../../escape.json',
    }),
    /--output escapes the repository root via path traversal/i,
    'dispatch_plan --output=../../escape.json must be rejected before writing outside root',
  );
  assert.equal(existsSync(escapedDispatchPlanOutput), false, 'dispatch_plan escaped output must never be created');

  const absoluteRuntimeOutput = join(root, 'reports/absolute-runtime-list.json');
  assert.throws(
    () => run<HostRuntimeProbe>('host_runtime_probe', { host: 'fake', output: absoluteRuntimeOutput }),
    /--output must be a relative path inside the repository root/i,
    'host_runtime_probe --output must reject absolute paths',
  );
  assert.equal(existsSync(absoluteRuntimeOutput), false, 'absolute --output rejection must not write inside root');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: '.' }),
    /--output must resolve to a file inside the repository root, not the repository root itself/i,
    'host_runtime_list --output=. must reject the repo root as the output target',
  );

  const nonDirectoryOutputAncestor = join(root, 'reports-file-ancestor');
  writeFileSync(nonDirectoryOutputAncestor, 'not a directory\n');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: 'reports-file-ancestor/runtime-list.json' }),
    /--output ancestor must be a directory/i,
    'host_runtime_list --output must reject existing non-directory ancestors',
  );

  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', {
      output: 'packages/main/src/generated/external-link/nested/output-symlink-escape.json',
    }),
    /--output traverses a symlinked ancestor/i,
    'host_runtime_list output must reject a pre-existing symlink ancestor that resolves outside root',
  );
  assert.equal(existsSync(outputSymlinkEscapeMarker), false, 'output symlink ancestor escape target must never be created');

  const legalRuntimeOutput = 'reports/runtime-list.json';
  const legalRuntimeOutputPath = join(root, legalRuntimeOutput);
  const legalRuntimeList = run<HostRuntimeList>('host_runtime_list', { output: legalRuntimeOutput });
  assert.equal(legalRuntimeList.schemaVersion, 'lattice.host_runtime_list.v1');
  assert.equal(existsSync(legalRuntimeOutputPath), true, 'repo-local output should be created');
  assert.equal(JSON.parse(readFileSync(legalRuntimeOutputPath, 'utf8')).schemaVersion, 'lattice.host_runtime_list.v1');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: legalRuntimeOutput }),
    /refusing to overwrite existing file/,
    'repo-local output must keep no-overwrite behavior',
  );

  const legalPlanOutput = 'reports/nested/dispatch-plan.json';
  const legalPlanText = runText('dispatch_plan', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Repo-local text output should be written.',
    output: legalPlanOutput,
  });
  assert.match(legalPlanText, /output: reports\/nested\/dispatch-plan\.json/);
  assert.equal(existsSync(join(root, legalPlanOutput)), true, 'repo-local text output should be created');

  const beforePlanCount = dispatchCount(root);
  const plan = run<DispatchPlanResult>('dispatch_plan', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Verify dispatch planning without side effects.',
    allowedPaths: ['packages/main/src/generated/plan.txt'],
    deniedPaths: ['README.md'],
    successCriteria: ['Plan only'],
    parallel: 2,
  });
  assert.equal(plan.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selectedHost, 'fake');
  assert.equal(plan.parallel, 2);
  assert.equal(dispatchCount(root), beforePlanCount, 'dispatch_plan must not create dispatch records');
  assert.equal(existsSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches`)), false, 'dispatch_plan must not create .proof-or-stop/dispatches');
  assertAuthorityFalse(plan, 'plan');

  const prepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-prepare',
    host: 'fake',
    objective: 'Prepare only.',
    allowedPaths: ['packages/main/src/generated/prepare.txt'],
    deniedPaths: ['README.md'],
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(existsSync(join(root, prepared.packFile)), true);
  assert.equal(existsSync(join(root, prepared.promptFile)), true);
  assert.equal(existsSync(resolve(root, prepared.worktree.worktreePath)), false, 'dispatch_prepare must not create a worktree');
  const preparedPrompt = readFileSync(join(root, prepared.promptFile), 'utf8');
  assert.match(preparedPrompt, /Role: overflow-worker/, 'normal dispatch prompt must show default role');
  assert.match(preparedPrompt, /Objective: Prepare only\./, 'normal dispatch prompt must show objective');
  assertAuthorityFalse(prepared, 'prepared');

  const unconstrainedPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-prepare-unconstrained',
    host: 'fake',
    objective: 'Prepare with missing constraints should warn without starting a host.',
  });
  assert.equal(unconstrainedPrepared.status, 'prepared');
  assert.ok(unconstrainedPrepared.warnings.some(warning => /No allowedPaths declared/i.test(warning)));
  assert.ok(unconstrainedPrepared.warnings.some(warning => /No requiredCommands declared/i.test(warning)));
  assert.equal(existsSync(resolve(root, unconstrainedPrepared.worktree.worktreePath)), false, 'missing-constraints dispatch_prepare must not create a worktree');
  assert.equal(existsSync(join(root, unconstrainedPrepared.receiptFile)), false, 'missing-constraints dispatch_prepare must not create a receipt');
  assertAuthorityFalse(unconstrainedPrepared, 'unconstrainedPrepared');

  const antigravityPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-antigravity-prepare',
    host: 'antigravity',
    objective: 'Antigravity dispatch should preserve current third-host identity in pack and prompt artifacts.',
    allowedPaths: ['packages/main/src/generated/antigravity-prepare.txt'],
    deniedPaths: ['README.md'],
  });
  const antigravityPack = readPack(root, antigravityPrepared.dispatchId);
  const antigravityPrompt = readFileSync(join(root, antigravityPrepared.promptFile), 'utf8');
  assert.equal(antigravityPrepared.selectedHost, 'antigravity');
  assert.equal(antigravityPrepared.runtime.host, 'antigravity');
  assert.equal(antigravityPrepared.runtime.cliCommand, 'agy');
  assert.equal(antigravityPack.toHost, 'antigravity');
  assert.ok(
    antigravityPack.executionInstructions.some(instruction => /Use antigravity only as a bounded overflow execution host/i.test(instruction)),
    'antigravity dispatch pack should preserve Antigravity host identity in execution instructions',
  );
  assert.match(antigravityPrompt, /Host runtime: antigravity/);
  assert.match(antigravityPrompt, /Use antigravity only as a bounded overflow execution host/i);
  assertAuthorityFalse(antigravityPrepared, 'antigravityPrepared');

  const agyPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-agy-prepare',
    host: 'agy',
    objective: 'agy alias dispatch should preserve Antigravity host identity in pack and prompt artifacts.',
    allowedPaths: ['packages/main/src/generated/agy-prepare.txt'],
    deniedPaths: ['README.md'],
  });
  assert.equal(agyPrepared.requestedHost, 'agy');
  assert.equal(agyPrepared.selectedHost, 'antigravity');
  assert.equal(agyPrepared.runtime.host, 'antigravity');
  assertAuthorityFalse(agyPrepared, 'agyPrepared');

  const geminiPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-gemini-prepare',
    host: 'gemini',
    objective: 'Legacy Gemini dispatch should preserve compatibility identity in pack and prompt artifacts.',
    allowedPaths: ['packages/main/src/generated/gemini-prepare.txt'],
    deniedPaths: ['README.md'],
  });
  const geminiPack = readPack(root, geminiPrepared.dispatchId);
  const geminiPrompt = readFileSync(join(root, geminiPrepared.promptFile), 'utf8');
  assert.equal(geminiPrepared.selectedHost, 'gemini');
  assert.equal(geminiPrepared.runtime.host, 'gemini');
  assert.ok(geminiPrepared.runtime.warnings.some(warning => /deprecated legacy compatibility/i.test(warning)));
  assert.equal(geminiPack.toHost, 'gemini');
  assert.ok(
    geminiPack.executionInstructions.some(instruction => /Use gemini only as a bounded overflow execution host/i.test(instruction)),
    'gemini dispatch pack should preserve Gemini host identity in execution instructions',
  );
  assert.ok(
    !geminiPack.executionInstructions.some(instruction => /Use codex only as a bounded overflow execution host/i.test(instruction)),
    'gemini dispatch pack should not silently fall back to Codex wording',
  );
  assert.match(geminiPrompt, /Host runtime: gemini/);
  assert.match(geminiPrompt, /Use gemini only as a bounded overflow execution host/i);
  assert.doesNotMatch(geminiPrompt, /Use codex only as a bounded overflow execution host/i);
  assertAuthorityFalse(geminiPrepared, 'geminiPrepared');

  const geminiDraftReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: geminiPrepared.dispatchId });
  assert.equal(geminiDraftReceipt.receipt.host, 'gemini');
  assert.notEqual(geminiDraftReceipt.receipt.host, 'codex');
  assert.equal(geminiDraftReceipt.receipt.fromHost, 'codex');
  assert.equal(geminiDraftReceipt.receipt.toHost, 'gemini');
  assertAuthorityFalse(geminiDraftReceipt, 'geminiDraftReceipt');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-parallel',
    host: 'fake',
    objective: 'Verify parallel fake workers.',
    allowedPaths: [
      'packages/main/src/generated/worker-1.txt',
      'packages/main/src/generated/worker-2.txt',
    ],
    deniedPaths: ['README.md'],
    successCriteria: ['Each worker returns local receipt only'],
    parallel: 2,
  });
  const parallelRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-parallel' });
  assert.equal(parallelRun.schemaVersion, 'lattice.dispatch_run.v1');
  assert.equal(parallelRun.status, 'accepted_local');
  assert.equal(parallelRun.parallel, 2);
  assert.equal(parallelRun.workers.length, 2);
  assert.equal('receipt' in parallelRun, false, 'parent parallel dispatch should not create a parent receipt');
  for (const worker of parallelRun.workers) {
    assert.equal(worker.status, 'accepted_local');
    assert.equal(worker.receipt?.status, 'accepted-local');
    assert.equal(worker.receipt?.host, 'fake');
    assert.notEqual(worker.receipt?.host, 'codex');
    assert.equal(worker.receipt?.verdict, 'pass');
    assert.equal(worker.receipt?.validations.verdict, 'pass');
  }
  const parentRecord = readDispatch(root, 'D-parallel');
  assert.deepEqual(parentRecord.workerIds, ['D-parallel-w1', 'D-parallel-w2']);
  assertAuthorityFalse(parallelRun, 'parallelRun');

  const parentStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-parallel' });
  assert.equal(parentStatus.dispatch.status, 'accepted_local');
  assert.equal(parentStatus.workers.length, 2);
  assert.equal(parentStatus.receipt, undefined);
  assertAuthorityFalse(parentStatus, 'parentStatus');

  const parentCollect = run<DispatchCollection>('dispatch_collect', { dispatchId: 'D-parallel' });
  assert.equal(parentCollect.status, 'accepted_local');
  assert.equal(parentCollect.workers.length, 2);
  assert.equal(parentCollect.changedFiles.length, 2);
  assert.equal(existsSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches/D-parallel/collect.json`)), true);
  assert.throws(() => run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: 'D-parallel' }), /only supports leaf dispatches/);

  const leafReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: 'D-parallel-w1' });
  assert.equal(leafReceipt.status, 'created');
  assert.equal(leafReceipt.receipt.host, 'fake');
  assert.notEqual(leafReceipt.receipt.host, 'codex');
  assert.equal(leafReceipt.receipt.verdict, 'pass');
  assertAuthorityFalse(leafReceipt, 'leafReceipt');

  const review = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-parallel' });
  assert.equal(review.status, 'accepted_local');
  assert.equal(review.changedFiles.length, 2);
  assert.equal(review.workers.length, 2);
  assertAuthorityFalse(review, 'review');

  const mergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-parallel' });
  assert.equal(mergePlan.mergeable, true);
  assert.equal(mergePlan.manualOnly, true);
  assert.equal(mergePlan.commands.length, 4);
  assert.ok(mergePlan.commands.every(command => !/\bgit\s+(merge|cherry-pick)\b/.test(command)));
  assertAuthorityFalse(mergePlan, 'mergePlan');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-parallel-mixed',
    host: 'fake',
    objective: 'Mixed fake worker outcomes should stay recoverable at the parent level.',
    allowedPaths: [
      'packages/main/src/generated/mixed-worker-1.txt',
      'packages/main/src/generated/mixed-worker-2.txt',
    ],
    requiredCommands: ['node -e "const fs = require(\'fs\'); process.exit(fs.existsSync(\'packages/main/src/generated/mixed-worker-2.txt\') ? 7 : 0)"'],
    successCriteria: ['One worker succeeds while another reports a local command failure'],
    parallel: 2,
  });
  const mixedRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedRun.status, 'diagnostic');
  assert.equal(mixedRun.parallel, 2);
  assert.equal(mixedRun.workers.length, 2);
  assert.equal(mixedRun.workers[0].status, 'accepted_local');
  assert.equal(mixedRun.workers[0].receipt?.status, 'accepted-local');
  assert.equal(mixedRun.workers[0].receipt?.validations.verdict, 'pass');
  assert.deepEqual(mixedRun.workers[0].receipt?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  assert.equal(mixedRun.workers[1].status, 'failed');
  assert.equal(mixedRun.workers[1].receipt?.status, 'diagnostic');
  assert.equal(mixedRun.workers[1].receipt?.verdict, 'fail');
  assert.equal(mixedRun.workers[1].receipt?.validations.verdict, 'fail');
  assert.ok(mixedRun.workers[1].warnings.some(warning => /command failed:/i.test(warning)));
  assert.ok(mixedRun.workers[1].receipt?.limitations.some(limitation => /command failed:/i.test(limitation)));
  const mixedParentRecord = readDispatch(root, 'D-parallel-mixed');
  assert.equal(mixedParentRecord.status, 'diagnostic');
  assert.deepEqual(mixedParentRecord.workerIds, ['D-parallel-mixed-w1', 'D-parallel-mixed-w2']);
  const mixedParentStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedParentStatus.dispatch.status, 'diagnostic');
  assert.equal(mixedParentStatus.workers[0].dispatch.status, 'accepted_local');
  assert.equal(mixedParentStatus.workers[1].dispatch.status, 'failed');
  assert.deepEqual(mixedParentStatus.workers[0].receipt?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  const mixedCollect = run<DispatchCollection>('dispatch_collect', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedCollect.status, 'diagnostic');
  assert.equal(mixedCollect.changedFiles.length, 2);
  assert.deepEqual(mixedCollect.workers[0]?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  assert.deepEqual(mixedCollect.workers[1]?.changedFiles, ['packages/main/src/generated/mixed-worker-2.txt']);
  const mixedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedReview.status, 'diagnostic');
  assert.equal(mixedReview.changedFiles.length, 2);
  assert.equal(mixedReview.workers.length, 2);
  assert.ok(mixedReview.risks.some(risk => /dispatch status=failed/i.test(risk)));
  assert.ok(mixedReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  assert.match(mixedReview.nextAction, /non-accepted workers/i);
  const mixedMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedMerge.mergeable, false);
  assert.deepEqual(mixedMerge.commands, []);
  assert.ok(mixedMerge.workers.some(worker => worker.dispatchId === 'D-parallel-mixed-w1' && worker.status === 'accepted_local'));
  assert.ok(mixedMerge.workers.some(worker => worker.dispatchId === 'D-parallel-mixed-w2' && worker.status === 'failed'));
  assertAuthorityFalse(mixedRun, 'mixedRun');
  assertAuthorityFalse(mixedParentStatus, 'mixedParentStatus');
  assertAuthorityFalse(mixedCollect, 'mixedCollect');
  assertAuthorityFalse(mixedReview, 'mixedReview');
  assertAuthorityFalse(mixedMerge, 'mixedMerge');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-failing-command',
    host: 'fake',
    objective: 'Required command failure must not be accepted local.',
    allowedPaths: ['packages/main/src/generated/failing.txt'],
    requiredCommands: ['node -e "process.exit(7)"'],
  });
  const failedRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-failing-command' });
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.receipt?.status, 'diagnostic');
  assert.equal(failedRun.receipt?.verdict, 'fail');
  assert.equal(failedRun.receipt?.validations.verdict, 'fail');
  const failedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-failing-command' });
  assert.equal(failedReview.status, 'failed');
  assert.ok(failedReview.risks.some(risk => /dispatch status=failed/i.test(risk)));
  assert.ok(failedReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  const failedMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-failing-command' });
  assert.equal(failedMerge.mergeable, false);
  assert.deepEqual(failedMerge.commands, []);
  assertAuthorityFalse(failedRun, 'failedRun');
  assertAuthorityFalse(failedReview, 'failedReview');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-diagnostic-scope',
    host: 'fake',
    objective: 'Denied overlap should keep a passing fake worker diagnostic-only.',
    allowedPaths: ['packages/main/src/generated/diagnostic-scope.txt'],
    deniedPaths: ['packages/main/src/generated/diagnostic-scope.txt'],
  });
  const diagnosticRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticRun.status, 'diagnostic');
  assert.equal(diagnosticRun.receipt?.status, 'diagnostic');
  assert.equal(diagnosticRun.receipt?.verdict, 'pass');
  assert.equal(diagnosticRun.receipt?.validations.changedFiles, 'fail');
  const diagnosticReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticReview.status, 'diagnostic');
  assert.ok(diagnosticReview.risks.some(risk => /dispatch status=diagnostic/i.test(risk)));
  assert.ok(diagnosticReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  const diagnosticMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticMerge.mergeable, false);
  assert.deepEqual(diagnosticMerge.commands, []);
  assertAuthorityFalse(diagnosticRun, 'diagnosticRun');
  assertAuthorityFalse(diagnosticReview, 'diagnosticReview');

  const draftOnly = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-draft-receipt-no-collect',
    host: 'fake',
    objective: 'Draft receipt should degrade when no worker collect data exists yet.',
    allowedPaths: ['packages/main/src/generated/draft-only.txt'],
  });
  const draftReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: draftOnly.dispatchId });
  assert.equal(draftReceipt.status, 'diagnostic');
  assert.equal(draftReceipt.receipt.host, 'fake');
  assert.notEqual(draftReceipt.receipt.host, 'codex');
  assert.equal(draftReceipt.receipt.verdict, 'warn');
  assert.deepEqual(draftReceipt.receipt.changedFiles, []);
  assert.ok(draftReceipt.receipt.limitations.some(limitation => /No git-derived changedFiles detected/i.test(limitation)));
  assertAuthorityFalse(draftReceipt, 'draftReceipt');

  const cancelRecord = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-cancel-resume',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/cancel-resume.txt'],
  });
  const cancelStatus = run<DispatchStatusResult>('dispatch_cancel', { dispatchId: cancelRecord.dispatchId });
  assert.equal(cancelStatus.dispatch.status, 'cancelled');
  assert.equal(existsSync(join(root, cancelStatus.dispatch.receiptFile)), false);
  const resumed = run<DispatchRunResult>('dispatch_resume', { dispatchId: cancelRecord.dispatchId });
  assert.equal(resumed.status, 'accepted_local');
  assert.equal(resumed.receipt?.status, 'accepted-local');

  const previousCancelPack = readPack(root, cancelRecord.dispatchId);
  const oldRecordBeforeReassign = JSON.stringify(readDispatch(root, cancelRecord.dispatchId));
  const explicitWorkerRole = 'proof-or-stop-implementer';
  const reassigned = run<DispatchReassignResult>('dispatch_reassign', {
    dispatchId: cancelRecord.dispatchId,
    role: explicitWorkerRole,
    objective: 'Continue the completed worker output with explicit fresh-context instructions.',
  });
  assert.equal(reassigned.schemaVersion, 'lattice.dispatch_reassign.v1');
  assert.equal(reassigned.mode, 'fresh-context');
  assert.equal(reassigned.previousDispatchId, cancelRecord.dispatchId);
  assert.notEqual(reassigned.dispatchId, cancelRecord.dispatchId);
  assert.equal(reassigned.role, explicitWorkerRole);
  assert.equal(reassigned.roleSource, 'requested');
  assert.equal(reassigned.objective, 'Continue the completed worker output with explicit fresh-context instructions.');
  assert.match(reassigned.nextAction, /Worker reassignment ready/i);
  assert.match(reassigned.nextAction, /no full-history fork is required/i);
  assert.equal(JSON.stringify(readDispatch(root, cancelRecord.dispatchId)), oldRecordBeforeReassign, 'dispatch_reassign must leave old record untouched');
  const reassignedRecord = readDispatch(root, reassigned.dispatchId);
  const reassignedPack = readPack(root, reassigned.dispatchId);
  assert.equal(reassignedRecord.parentDispatchId, cancelRecord.dispatchId);
  assert.equal(reassigned.promptFile, reassignedRecord.promptFile);
  assert.equal(reassignedPack.role, explicitWorkerRole);
  assert.equal(reassignedPack.objective, 'Continue the completed worker output with explicit fresh-context instructions.');
  assert.deepEqual(reassignedPack.allowedPaths, previousCancelPack.allowedPaths, 'reassignment should default allowedPaths from previous pack');
  assert.deepEqual(reassignedPack.deniedPaths, previousCancelPack.deniedPaths, 'reassignment should default deniedPaths from previous pack');
  assert.deepEqual(reassignedPack.requiredCommands, previousCancelPack.requiredCommands, 'reassignment should default requiredCommands from previous pack');
  assert.deepEqual(reassignedPack.successCriteria, previousCancelPack.successCriteria, 'reassignment should default successCriteria from previous pack');
  assert.equal(reassignedPack.fromHost, previousCancelPack.fromHost, 'reassignment should default fromHost from previous pack');
  assert.equal(reassignedPack.baseSha, previousCancelPack.baseSha, 'reassignment should default baseSha from previous pack');
  assert.deepEqual(
    reassignedPack.executionInstructions.filter(instruction => /^Work in role:/i.test(instruction)),
    [`Work in role: ${explicitWorkerRole}.`],
    'explicit role reassignment must rewrite inherited execution role instructions',
  );
  const reassignedPrompt = readFileSync(join(root, reassigned.promptFile), 'utf8');
  assert.match(reassignedPrompt, new RegExp(`Role: ${explicitWorkerRole}`), 'reassignment prompt must include explicit role');
  assert.match(reassignedPrompt, new RegExp(`Work in role: ${explicitWorkerRole}\\.`), 'reassignment prompt execution instructions must use explicit role');
  assert.doesNotMatch(reassignedPrompt, /Work in role: overflow-worker\./, 'reassignment prompt must not retain the previous worker role instruction');
  assert.match(reassignedPrompt, /Objective: Continue the completed worker output with explicit fresh-context instructions\./, 'reassignment prompt must include objective');
  assert.match(reassignedPrompt, /## Fresh-context Continuity/, 'reassignment prompt must include continuity section');
  assert.match(reassignedPrompt, /mode: fresh-context/, 'reassignment prompt must state fresh-context mode');
  assert.match(reassignedPrompt, new RegExp(`Previous dispatch: ${cancelRecord.dispatchId}`), 'reassignment prompt must reference previous dispatch');
  assert.match(reassignedPrompt, /summary-only continuity/i, 'reassignment prompt must limit continuity to summary material');
  assert.match(reassignedPrompt, /no full-history fork is required/i, 'reassignment prompt must reject full-history fork dependency');
  assert.doesNotMatch(reassignedPrompt, /full-history fork has been created|full-history inheritance/i, 'reassignment prompt must not claim full-history inheritance');
  assert.doesNotMatch(reassignedPrompt, /receipt verified|production DONE achieved|authority changed/i, 'reassignment prompt must not claim receipt verification, production DONE, or authority changes');
  assertAuthorityFalse(reassigned, 'reassigned');

  const defaultRoleReassigned = run<DispatchReassignResult>('dispatch_reassign', {
    dispatchId: cancelRecord.dispatchId,
  });
  assert.equal(defaultRoleReassigned.role, 'overflow-worker');
  assert.equal(defaultRoleReassigned.roleSource, 'default');
  assert.equal(defaultRoleReassigned.previousDispatchId, cancelRecord.dispatchId);
  assert.equal(readDispatch(root, defaultRoleReassigned.dispatchId).parentDispatchId, cancelRecord.dispatchId);
  const defaultRolePrompt = readFileSync(join(root, defaultRoleReassigned.promptFile), 'utf8');
  assert.match(defaultRolePrompt, /Role: overflow-worker/, 'omitted-role reassignment must use explicit default worker role');
  assert.match(defaultRolePrompt, /no full-history fork is required/i);
  assertAuthorityFalse(defaultRoleReassigned, 'defaultRoleReassigned');

  assert.equal(existsSync(join(root, unconstrainedPrepared.receiptFile)), false, 'prepared-only fixture must not have a receipt');
  const countBeforePreparedReassign = dispatchCount(root);
  let preparedReassignError: Error | undefined;
  try {
    run<DispatchReassignResult>('dispatch_reassign', {
      dispatchId: unconstrainedPrepared.dispatchId,
      role: 'summary-worker',
      objective: 'Render bounded continuity when previous receipt data is absent.',
      allowedPaths: ['packages/main/src/generated/missing-summary-reassign.txt'],
    });
  } catch (error) {
    preparedReassignError = error as Error;
  }
  assert.ok(preparedReassignError, 'prepared-only dispatch_reassign must be rejected');
  assert.match(preparedReassignError.message, /requires a completed\/accepted previous dispatch/i);
  assert.match(preparedReassignError.message, /status=prepared/i);
  assert.match(preparedReassignError.message, /localReceiptStatus=missing/i);
  assert.doesNotMatch(preparedReassignError.message, /Worker reassignment ready/i);
  assert.equal(dispatchCount(root), countBeforePreparedReassign, 'rejected prepared-only reassign must not create a follow-up dispatch');

  const reassignText = runText('dispatch_reassign', {
    dispatchId: cancelRecord.dispatchId,
    role: 'text-worker',
    objective: 'Render text reassignment output.',
    allowedPaths: ['packages/main/src/generated/text-reassign.txt'],
  });
  assert.match(reassignText, /Worker reassignment ready/);
  assert.match(reassignText, /mode: fresh-context/);
  assert.match(reassignText, /previousDispatchId: D-cancel-resume/);
  assert.match(reassignText, /role: text-worker/);
  assert.match(reassignText, /promptFile:/);
  assert.match(reassignText, /no full-history fork is required/i);

  const resumeRegressionRecord = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-resume-regression',
    host: 'fake',
    objective: 'dispatch_resume must rerun the original dispatch metadata.',
    allowedPaths: ['packages/main/src/generated/resume-regression.txt'],
  });
  const countBeforeResumeRegression = dispatchCount(root);
  const resumeRegression = run<DispatchRunResult>('dispatch_resume', { dispatchId: resumeRegressionRecord.dispatchId });
  assert.equal(resumeRegression.dispatchId, resumeRegressionRecord.dispatchId, 'dispatch_resume must return original dispatch id');
  assert.equal(dispatchCount(root), countBeforeResumeRegression, 'dispatch_resume must not create a follow-up dispatch');
  assert.equal(readDispatch(root, resumeRegressionRecord.dispatchId).parentDispatchId, resumeRegressionRecord.parentDispatchId, 'dispatch_resume must keep original lineage metadata shape');

  const expiredRecord = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-expired',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/expired.txt'],
  });
  writeDispatch(root, expiredRecord.dispatchId, {
    ...expiredRecord,
    expiresAt: '2026-06-01T00:00:00.000Z',
  });
  const expiredStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: expiredRecord.dispatchId });
  assert.equal(expiredStatus.dispatch.status, 'expired');
  const expiredRun = run<DispatchRunResult>('dispatch_run', { dispatchId: expiredRecord.dispatchId });
  assert.equal(expiredRun.status, 'expired');
  assert.equal(existsSync(resolve(root, expiredRecord.worktree.worktreePath)), false, 'expired dispatch_run must not create a worktree');
  assert.equal(readDispatch(root, expiredRecord.dispatchId).status, 'expired');

  const list = run<DispatchListResult>('dispatch_list', { storyId: 'B-dispatch' });
  assert.ok(list.dispatches.some(entry => entry.dispatchId === 'D-parallel'));
  assert.ok(list.dispatches.some(entry => entry.dispatchId === 'D-cancel-resume'));
  assertAuthorityFalse(list, 'list');

  const beforeOverflowSuggestCount = dispatchCount(root);
  const autoSuggested = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    objective: 'Default auto suggestion should not require an explicit fake host.',
  });
  assert.equal(autoSuggested.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(autoSuggested.requestedHost, 'auto');
  assert.ok(autoSuggested.warnings.some(warning => /suggest-only/i.test(warning)));
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto default host=auto must not materialize dispatch records');
  const suggested = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Suggest only.',
  });
  assert.equal(suggested.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(suggested.warnings.some(warning => /suggest-only/i.test(warning)));
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto default must not materialize dispatch records');
  const startOnly = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Start-only must stay suggest-only.',
    start: true,
  });
  assert.equal(startOnly.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(startOnly.warnings.some(warning => /start=true without approve=true/i.test(warning)));
  assert.match(startOnly.nextAction, /approve=true --start=true/);
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto start=true alone must stay suggest-only');
  const approveOnly = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Approve-only must stay suggest-only.',
    approve: true,
  });
  assert.equal(approveOnly.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(approveOnly.warnings.some(warning => /approve=true without start=true/i.test(warning)));
  assert.match(approveOnly.nextAction, /approve=true --start=true/);
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto approve=true alone must stay suggest-only');
  const approved = run<DispatchRunResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Approved fake overflow run.',
    allowedPaths: ['packages/main/src/generated/overflow-approved.txt'],
    approve: true,
    start: true,
  });
  assert.equal(approved.status, 'accepted_local');
  assertAuthorityFalse(approved, 'approvedOverflow');

  assert.throws(() => run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-path-traversal',
    host: 'fake',
    objective: 'Traversal must be rejected before any file write.',
    allowedPaths: ['../D-path-traversal-escaped.txt'],
    deniedPaths: ['README.md'],
  }), /allowedPaths\[0\].*escapes the isolated worktree/i);
  assert.equal(existsSync(resolve(root, '../D-path-traversal-escaped.txt')), false, 'escaped file must never be written');
  assert.equal(existsSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches/D-path-traversal`)), false, 'invalid traversal must not persist dispatch metadata');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-symlink-escape',
    host: 'fake',
    objective: 'Symlink escape must be rejected before writing outside the worktree.',
    allowedPaths: ['packages/main/src/generated/external-link/blocked-by-symlink.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-symlink-escape' }),
    /resolves outside the isolated worktree via an existing symlinked path segment/i,
  );
  assert.equal(existsSync(externalMarker), false, 'symlink escape target must never be written');

  const fakeProjectedRootDispatchId = 'D-preexisting-root-symlink-fake';
  const fakeProjectedRootExternalMarker = join(fakeProjectedRootExternalDir, 'packages/main/src/generated/preexisting-root-blocked.txt');
  seedProjectedDispatchWorktreeRootSymlink(root, 'B-dispatch', fakeProjectedRootDispatchId, fakeProjectedRootExternalDir);
  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: fakeProjectedRootDispatchId,
    host: 'fake',
    objective: 'Fake runtime must reject a projected worktree root symlink before writing external output.',
    allowedPaths: ['packages/main/src/generated/preexisting-root-blocked.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: fakeProjectedRootDispatchId }),
    error => isProjectedWorktreeContainmentFailure(String(error)),
  );
  assert.equal(existsSync(fakeProjectedRootExternalMarker), false, 'fake projected-root symlink target must never receive allowed output');
  assert.deepEqual(readdirSync(fakeProjectedRootExternalDir), [], 'fake projected-root symlink target must remain unused');

  const fakeAncestorDispatchId = 'D-ancestor-symlink-fake';
  seedProjectedDispatchWorktreeAncestorSymlink(root, 'B-ancestor-attack', fakeAncestorExternalDir);
  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-ancestor-attack',
    dispatchId: fakeAncestorDispatchId,
    host: 'fake',
    objective: 'Fake runtime must reject a symlinked projected worktree ancestor before git worktree add.',
    allowedPaths: ['packages/main/src/generated/ancestor-blocked.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: fakeAncestorDispatchId }),
    error => isProjectedWorktreeContainmentFailure(String(error)),
  );
  assert.equal(existsSync(resolve(root, projectedDispatchWorktreePath(root, 'B-ancestor-attack', fakeAncestorDispatchId))), false, 'fake ancestor symlink attack must not materialize a worktree path');
  assert.deepEqual(readdirSync(fakeAncestorExternalDir), [], 'fake ancestor symlink target must remain unused');
  rmSync(projectedDispatchWorktreeStoryRoot(root, 'B-ancestor-attack'), { recursive: true, force: true });

  const maliciousDispatchId = '../../dispatch-id-escape';
  const escapedDispatchMetadataDir = resolve(root, 'dispatch-id-escape');
  const maliciousOverflowSuggest = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    dispatchId: maliciousDispatchId,
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/malicious-overflow-suggest.txt'],
  });
  assert.equal(maliciousOverflowSuggest.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(existsSync(escapedDispatchMetadataDir), false, 'overflow_auto suggest-only malicious dispatchId must not write outside .proof-or-stop/dispatches');
  for (const [command, args] of [
    ['dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious.txt'],
    }],
    ['dispatch_run', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious.txt'],
    }],
    ['dispatch_status', { dispatchId: maliciousDispatchId }],
    ['dispatch_collect', { dispatchId: maliciousDispatchId }],
    ['dispatch_receipt_create', { dispatchId: maliciousDispatchId }],
    ['dispatch_resume', { dispatchId: maliciousDispatchId }],
    ['dispatch_reassign', { dispatchId: maliciousDispatchId }],
    ['dispatch_cancel', { dispatchId: maliciousDispatchId }],
    ['dispatch_review', { dispatchId: maliciousDispatchId }],
    ['dispatch_merge_plan', { dispatchId: maliciousDispatchId }],
    ['overflow_auto', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious-overflow-start.txt'],
      approve: true,
      start: true,
    }],
  ] as const) {
    assert.throws(
      () => run(command, args),
      /dispatchId must not contain path separators or traversal segments/i,
      `${command} must reject malicious dispatchId`,
    );
  }
  assert.equal(existsSync(escapedDispatchMetadataDir), false, 'malicious dispatchId must not write metadata outside .proof-or-stop/dispatches');

  const unknownValidDispatchId = 'D-valid-but-missing';
  for (const [command, args] of [
    ['dispatch_run', { dispatchId: unknownValidDispatchId }],
    ['dispatch_status', { dispatchId: unknownValidDispatchId }],
    ['dispatch_collect', { dispatchId: unknownValidDispatchId }],
    ['dispatch_receipt_create', { dispatchId: unknownValidDispatchId }],
    ['dispatch_resume', { dispatchId: unknownValidDispatchId }],
    ['dispatch_reassign', { dispatchId: unknownValidDispatchId }],
    ['dispatch_cancel', { dispatchId: unknownValidDispatchId }],
    ['dispatch_review', { dispatchId: unknownValidDispatchId }],
    ['dispatch_merge_plan', { dispatchId: unknownValidDispatchId }],
    ['overflow_auto', {
      storyId: 'B-dispatch',
      dispatchId: unknownValidDispatchId,
      approve: true,
      start: true,
    }],
  ] as const) {
    assert.throws(
      () => run(command, args),
      new RegExp(`Unknown dispatchId ${unknownValidDispatchId}`),
      `${command} must reject an unknown but syntactically valid dispatchId`,
    );
  }

  const originalCodexSessionId = process.env.CODEX_SESSION_ID;
  try {
    process.env.CODEX_SESSION_ID = 'dispatch-run-smoke';
    assert.throws(() => run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-traversal',
      host: 'codex',
      objective: 'Real-host traversal must be rejected before prompt metadata persists.',
      allowedPaths: ['packages/main/src/generated/real-host-traversal.txt'],
      deniedPaths: ['../outside.txt'],
    }), /deniedPaths\[0\].*escapes the isolated worktree/i);
    assert.equal(existsSync(join(root, `${PROOF_OR_STOP_STATE_DIR}/dispatches/D-real-host-traversal`)), false, 'invalid real-host traversal must not persist dispatch metadata');

    const realHostReady = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-ready',
      host: 'codex',
      objective: 'Available real host should create its isolated worktree.',
      allowedPaths: ['packages/main/src/generated/real-host-ready.txt'],
    });
    const realHostRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostReady.dispatchId });
    assert.equal(realHostRun.status, 'needs_receipt');
    assert.equal(existsSync(resolve(root, realHostReady.worktree.worktreePath)), true, 'available real-host scaffold should create the isolated worktree');
    assert.match(realHostRun.nextAction, new RegExp(realHostReady.worktree.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const savedPath = process.env.PATH;
    const savedArgvFile = process.env.PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE;
    const savedStdinFile = process.env.PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE;
    try {
      process.env.PATH = `${fakeCodexBinDir}${delimiter}${savedPath ?? ''}`;
      process.env.PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE = fakeCodexArgvFile;
      process.env.PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE = fakeCodexStdinFile;
      rmSync(fakeCodexArgvFile, { force: true });
      rmSync(fakeCodexStdinFile, { force: true });
      const codexPromptReady = run<DispatchRecord>('dispatch_prepare', {
        storyId: 'B-dispatch',
        dispatchId: 'D-real-host-codex-prompt-argv',
        host: 'codex',
        objective: 'REAL_PROMPT_SENTINEL_123 must reach spawned codex stdin, not argv.',
        allowedPaths: ['packages/main/src/generated/real-host-codex-prompt-argv.txt'],
      });
      const codexPromptText = readFileSync(join(root, codexPromptReady.promptFile), 'utf8');
      const codexPromptRun = runDispatch(store, root, {
        storyId: codexPromptReady.storyId,
        dispatchId: codexPromptReady.dispatchId,
        allowRealHostSubprocess: true,
        executionPolicy: {
          envAllowlist: ['PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE', 'PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE'],
          envDenylist: [],
          commandAllowlist: [],
          maxRuntimeMs: 5000,
        },
      });
      const codexPromptTranscript = readFileSync(join(root, codexPromptReady.transcriptFile), 'utf8');
      assert.equal(codexPromptRun.status, 'accepted_local', `fake codex real subprocess should complete cleanly; status=${codexPromptRun.status}; transcript:\n${codexPromptTranscript}`);
      const spawnedArgv = JSON.parse(readFileSync(fakeCodexArgvFile, 'utf8')) as string[];
      assert.equal(spawnedArgv.includes('<prompt>'), false, 'spawned codex argv must not receive literal <prompt>');
      assert.equal(spawnedArgv.includes('<prompt-file>'), false, 'spawned codex argv must not receive literal <prompt-file>');
      assert.ok(spawnedArgv.includes('-'), 'spawned codex argv must request stdin prompt mode');
      assert.equal(spawnedArgv.includes(codexPromptText), false, 'spawned codex argv must not receive prompt contents as an argv item');
      assert.equal(spawnedArgv.some(arg => /REAL_PROMPT_SENTINEL_123/.test(arg)), false, 'spawned codex argv must not include story prompt content');
      const spawnedStdin = readFileSync(fakeCodexStdinFile, 'utf8');
      assert.equal(spawnedStdin, codexPromptText, 'spawned codex stdin must receive the prompt file contents');
      assert.match(spawnedStdin, /REAL_PROMPT_SENTINEL_123/, 'spawned codex stdin must include the story prompt content');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedArgvFile === undefined) delete process.env.PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE;
      else process.env.PROOF_OR_STOP_FAKE_CODEX_ARGV_FILE = savedArgvFile;
      if (savedStdinFile === undefined) delete process.env.PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE;
      else process.env.PROOF_OR_STOP_FAKE_CODEX_STDIN_FILE = savedStdinFile;
    }

    const realHostSymlinkEscape = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-symlink-escape',
      host: 'codex',
      objective: 'Real-host scaffold must not return needs_receipt when allowedPaths resolve outside the worktree.',
      allowedPaths: ['packages/main/src/generated/external-link/blocked-by-symlink.txt'],
      deniedPaths: ['README.md'],
    });
    const failedRealHostSymlinkEscape = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostSymlinkEscape.dispatchId });
    assert.equal(failedRealHostSymlinkEscape.status, 'failed');
    assert.ok(
      failedRealHostSymlinkEscape.warnings.some(warning =>
        /canonical pack-path validation failed: .*resolves outside the isolated worktree via an existing symlinked path segment/i.test(warning)),
      'real-host symlink escape should surface canonical validation failure in warnings',
    );
    assert.match(failedRealHostSymlinkEscape.nextAction, /rolled back after canonical pack-path validation failed/i);
    assert.equal(existsSync(resolve(root, realHostSymlinkEscape.worktree.worktreePath)), false, 'real-host symlink escape must clean up the created worktree');
    assert.equal(existsSync(externalMarker), false, 'real-host symlink escape target must never be written');
    assert.equal(readDispatch(root, realHostSymlinkEscape.dispatchId).status, 'failed', 'real-host symlink escape must persist failed dispatch status');

    const realProjectedRootDispatchId = 'D-preexisting-root-symlink-real';
    const realProjectedRootExternalMarker = join(realProjectedRootExternalDir, 'packages/main/src/generated/preexisting-root-blocked.txt');
    seedProjectedDispatchWorktreeRootSymlink(root, 'B-dispatch', realProjectedRootDispatchId, realProjectedRootExternalDir);
    const realProjectedRootSymlink = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: realProjectedRootDispatchId,
      host: 'codex',
      objective: 'Real runtime must fail instead of returning needs_receipt when the projected worktree root is a symlink.',
      allowedPaths: ['packages/main/src/generated/preexisting-root-blocked.txt'],
      deniedPaths: ['README.md'],
    });
    const realProjectedRootRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realProjectedRootSymlink.dispatchId });
    assert.notEqual(realProjectedRootRun.status, 'needs_receipt');
    assert.equal(realProjectedRootRun.status, 'failed');
    assert.ok(
      realProjectedRootRun.warnings.some(warning => isProjectedWorktreeContainmentFailure(warning)),
      'real projected-root symlink should surface canonical validation failure in warnings',
    );
    assert.match(realProjectedRootRun.nextAction, /Resolve the git worktree error, then rerun dispatch_run/i);
    assert.equal(existsSync(realProjectedRootExternalMarker), false, 'real projected-root symlink target must never receive allowed output');
    assert.deepEqual(readdirSync(realProjectedRootExternalDir), [], 'real projected-root symlink target must remain unused');
    assert.equal(readDispatch(root, realProjectedRootSymlink.dispatchId).status, 'failed', 'real projected-root symlink must persist failed dispatch status');

    const realAncestorDispatchId = 'D-ancestor-symlink-real';
    seedProjectedDispatchWorktreeAncestorSymlink(root, 'B-ancestor-attack', realAncestorExternalDir);
    const realAncestorSymlink = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-ancestor-attack',
      dispatchId: realAncestorDispatchId,
      host: 'codex',
      objective: 'Real runtime must reject a symlinked projected worktree ancestor before returning needs_receipt.',
      allowedPaths: ['packages/main/src/generated/ancestor-blocked.txt'],
      deniedPaths: ['README.md'],
    });
    const realAncestorRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realAncestorSymlink.dispatchId });
    assert.notEqual(realAncestorRun.status, 'needs_receipt');
    assert.equal(realAncestorRun.status, 'failed');
    assert.ok(
      realAncestorRun.warnings.some(warning => isProjectedWorktreeContainmentFailure(warning)),
      'real ancestor symlink should surface ancestry containment failure in warnings',
    );
    assert.match(realAncestorRun.nextAction, /Resolve the git worktree error, then rerun dispatch_run/i);
    assert.equal(existsSync(resolve(root, projectedDispatchWorktreePath(root, 'B-ancestor-attack', realAncestorDispatchId))), false, 'real ancestor symlink attack must not materialize a worktree path');
    assert.deepEqual(readdirSync(realAncestorExternalDir), [], 'real ancestor symlink target must remain unused');
    assert.equal(readDispatch(root, realAncestorSymlink.dispatchId).status, 'failed', 'real ancestor symlink must persist failed dispatch status');
    rmSync(projectedDispatchWorktreeStoryRoot(root, 'B-ancestor-attack'), { recursive: true, force: true });

    const realHostFailure = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-failure',
      host: 'codex',
      objective: 'Available real host should report worktree creation failure truthfully.',
      allowedPaths: ['packages/main/src/generated/real-host-failure.txt'],
    });
    git(root, ['branch', realHostFailure.worktree.branch, baseSha]);
    const failedRealHost = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostFailure.dispatchId });
    assert.equal(failedRealHost.status, 'failed');
    assert.equal(existsSync(resolve(root, realHostFailure.worktree.worktreePath)), false, 'failed scaffold must not claim a created worktree');
    assert.ok(failedRealHost.warnings.some(warning => /Worktree creation failed:/i.test(warning)));
    assert.match(failedRealHost.nextAction, /could not create .*Resolve the git worktree error, then rerun dispatch_run/i);
  } finally {
    if (originalCodexSessionId === undefined) {
      delete process.env.CODEX_SESSION_ID;
    } else {
      process.env.CODEX_SESSION_ID = originalCodexSessionId;
    }
  }

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    const unavailableProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'antigravity' });
    assert.equal(unavailableProbe.status, 'unavailable');
    assert.equal(unavailableProbe.runtimeKind, 'missing-cli');
    const beforeUnavailablePlanCount = dispatchCount(root);
    const unavailablePlan = run<DispatchPlanResult>('dispatch_plan', {
      storyId: 'B-dispatch',
      host: 'antigravity',
      objective: 'Explicit unavailable host should produce a degraded plan only.',
    });
    assert.equal(unavailablePlan.status, 'unavailable');
    assert.equal(unavailablePlan.selectedHost, 'antigravity');
    assert.equal(unavailablePlan.runtime.status, 'unavailable');
    assert.ok(unavailablePlan.risks.some(risk => /antigravity runtime is unavailable/i.test(risk)));
    assert.ok(unavailablePlan.warnings.some(warning => /agy CLI is not available/i.test(warning)));
    assert.equal(dispatchCount(root), beforeUnavailablePlanCount, 'unavailable dispatch_plan must not create dispatch records');
    const unavailableRun = run<DispatchRunResult>('dispatch_run', {
      storyId: 'B-dispatch',
      host: 'antigravity',
      objective: 'Missing real host should degrade without worktree execution.',
    });
    assert.equal(unavailableRun.status, 'unavailable');
    const missingRecord = readDispatch(root, unavailableRun.dispatchId);
    assert.equal(existsSync(resolve(root, missingRecord.worktree.worktreePath)), false);
    assert.equal(existsSync(join(root, missingRecord.receiptFile)), false);
    assertAuthorityFalse(unavailableRun, 'unavailableRun');

    const legacyGeminiUnavailable = run<HostRuntimeProbe>('host_runtime_probe', { host: 'gemini' });
    assert.equal(legacyGeminiUnavailable.host, 'gemini');
    assert.equal(legacyGeminiUnavailable.status, 'unavailable');
    assert.ok(legacyGeminiUnavailable.warnings.some(warning => /deprecated legacy compatibility/i.test(warning)));
    assertAuthorityFalse(legacyGeminiUnavailable, 'legacyGeminiUnavailable');
  } finally {
    process.env.PATH = originalPath;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const cliProbe = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'proof-or-stop',
    'host',
    'runtime',
    'probe',
    '--host=fake',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HostRuntimeProbe;
  assert.equal(cliProbe.host, 'fake');
  assert.equal(cliProbe.status, 'ready');
  assertAuthorityFalse(cliProbe, 'cliProbe');

  // CHK-003: dispatch_policy contract — create/get/check happy path
  const policyCreateResult = run<DispatchPolicy>('dispatch_policy_create', {
    policy: 'nightly-safe',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    maxParallel: 2,
    maxRuntimeMinutes: 60,
    maxBudgetUSD: 5.0,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(policyCreateResult.schemaVersion, 'lattice.dispatch_policy.v1');
  assert.equal(policyCreateResult.policy, 'nightly-safe');
  assert.deepEqual(policyCreateResult.allowedHosts, ['fake']);
  assert.equal(policyCreateResult.allowAutoMerge, false);
  assert.equal(policyCreateResult.allowProductionDone, false);
  assert.equal(policyCreateResult.requireReceipt, true);
  assert.equal(policyCreateResult.requireReview, true);

  const policyGetResult = run<DispatchPolicy>('dispatch_policy_get', { policy: 'nightly-safe' });
  assert.equal(policyGetResult.schemaVersion, 'lattice.dispatch_policy.v1');
  assert.equal(policyGetResult.policy, 'nightly-safe');
  assert.deepEqual(policyGetResult.allowedHosts, ['fake']);

  const policyCheckAuthorized = run<DispatchPolicyCheckResult>('dispatch_policy_check', { policy: 'nightly-safe' });
  assert.equal(policyCheckAuthorized.schemaVersion, 'lattice.dispatch_policy_check.v1');
  assert.equal(policyCheckAuthorized.policy, 'nightly-safe');
  assert.equal(policyCheckAuthorized.authorized, true);
  assert.equal(policyCheckAuthorized.status, 'authorized');
  assert.equal(policyCheckAuthorized.reasons.length, 0);
  assert.equal(policyCheckAuthorized.degradations.length, 0);
  assert.equal(policyCheckAuthorized.authorityChanged, false);
  assert.equal(policyCheckAuthorized.receiptVerified, false);
  assert.equal(policyCheckAuthorized.productionDone, false);
  assertAuthorityFalse(policyCheckAuthorized, 'policyCheckAuthorized');

  // CHK-003: fake policy is deterministically authorized
  const fakeCheckResult = run<DispatchPolicyCheckResult>('dispatch_policy_check', { policy: 'fake' });
  assert.equal(fakeCheckResult.authorized, true);
  assert.equal(fakeCheckResult.status, 'authorized');
  assertAuthorityFalse(fakeCheckResult, 'fakeCheckResult');

  // CHK-003: missing policy → refused
  const missingPolicyResult = run<DispatchPolicyCheckResult>('dispatch_policy_check', { policy: 'does-not-exist' });
  assert.equal(missingPolicyResult.authorized, false);
  assert.equal(missingPolicyResult.status, 'refused');
  assert.ok(missingPolicyResult.reasons.some(r => /not found/i.test(r)));
  assertAuthorityFalse(missingPolicyResult, 'missingPolicyResult');

  // CHK-003: dispatch_policy_get throws for missing policy
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_get', { policy: 'no-such-policy' }),
    /not found/i,
    'dispatch_policy_get must throw for missing policy',
  );

  // CHK-003: traversal/absolute path rejection
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-traversal',
      allowedHosts: ['fake'],
      allowedPaths: ['../escaped.txt'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
    }),
    /allowedPaths\[0\].*escapes|traversal/i,
    'create must reject traversal in allowedPaths',
  );
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-absolute',
      allowedHosts: ['fake'],
      allowedPaths: ['/etc/passwd'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
    }),
    /allowedPaths\[0\].*relative|absolute/i,
    'create must reject absolute paths in allowedPaths',
  );

  // CHK-003: denied-path overlap rejection
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-overlap',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/'],
      deniedPaths: ['packages/main/src/'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
    }),
    /overlap/i,
    'create must reject denied-path overlap with allowedPaths',
  );

  // CHK-003: unsafe env name rejection
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-env',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
      envAllowlist: ['ANTHROPIC_API_KEY'],
    }),
    /unsafe.*env|TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i,
    'create must reject unsafe env names in envAllowlist',
  );

  // CHK-003: allowAutoMerge=true rejection
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-automerge',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
      allowAutoMerge: true,
    }),
    /allowAutoMerge.*false|auto-merge/i,
    'create must reject allowAutoMerge=true',
  );

  // CHK-003: allowProductionDone=true rejection
  assert.throws(
    () => run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'bad-productiondone',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      commandAllowlist: ['node -e "process.exit(0)"'],
      allowProductionDone: true,
    }),
    /allowProductionDone.*false|productionDone/i,
    'create must reject allowProductionDone=true',
  );

  // CHK-003: authority flags always false on check result
  assert.equal(policyCheckAuthorized.authorityChanged, false, 'policy check must never set authorityChanged=true');
  assert.equal(policyCheckAuthorized.receiptVerified, false, 'policy check must never set receiptVerified=true');
  assert.equal(policyCheckAuthorized.productionDone, false, 'policy check must never set productionDone=true');

  // CHK-004: Real host unattended capability contract — structured fields on all probes
  {
    const VALID_LOGIN_READINESS = ['ready', 'requires-login', 'unknown'];
    const VALID_RECEIPT_SUPPORT = ['structured', 'transcript-capture', 'unverified'];
    const VALID_VERSION_STATUS = ['detected', 'unavailable', 'unknown'];
    const VALID_NONINTERACTIVE = ['supported', 'unverified', 'unsupported'];

    // Fake probe: re-run to confirm structured fields
    const fakeProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'fake' });
    assert.equal(fakeProbe4.loginReadiness, 'ready', 'fake probe must have loginReadiness=ready');
    assert.equal(fakeProbe4.receiptSupport, 'structured', 'fake probe must have receiptSupport=structured');
    assert.equal(fakeProbe4.unattendedSafe, false, 'fake probe must never set unattendedSafe=true');
    assertAuthorityFalse(fakeProbe4, 'fakeProbe4');

    // claude-code probe (already partially tested in CHK-002 section; extend for CHK-004 fields)
    const claudeProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'claude-code' });
    assert.ok(VALID_LOGIN_READINESS.includes(claudeProbe4.loginReadiness),
      `claude-code loginReadiness must be valid, got ${claudeProbe4.loginReadiness}`);
    assert.ok(VALID_RECEIPT_SUPPORT.includes(claudeProbe4.receiptSupport),
      `claude-code receiptSupport must be valid, got ${claudeProbe4.receiptSupport}`);
    assert.equal(claudeProbe4.unattendedSafe, false, 'claude-code must not claim unattendedSafe=true');
    assert.ok(
      claudeProbe4.unattendedReasons.some(r => /dispatch_policy_check|dispatch_auto|policy binding/i.test(r)),
      'claude-code unattendedReasons must reference dispatch_policy_check / dispatch_auto policy binding',
    );
    assertAuthorityFalse(claudeProbe4, 'claudeProbe4');

    // antigravity probe: current third host must expose structured fields regardless of CLI availability
    const antigravityProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'antigravity' });
    assert.equal(antigravityProbe4.host, 'antigravity');
    assert.equal(antigravityProbe4.requestedHost, 'antigravity');
    assert.equal(antigravityProbe4.schemaVersion, 'lattice.host_runtime_probe.v1');
    assert.equal(antigravityProbe4.cliCommand, 'agy');
    assert.ok(VALID_VERSION_STATUS.includes(antigravityProbe4.versionStatus),
      `antigravity versionStatus must be valid, got ${antigravityProbe4.versionStatus}`);
    assert.ok(VALID_LOGIN_READINESS.includes(antigravityProbe4.loginReadiness),
      `antigravity loginReadiness must be valid, got ${antigravityProbe4.loginReadiness}`);
    assert.ok(VALID_NONINTERACTIVE.includes(antigravityProbe4.noninteractiveSupport),
      `antigravity noninteractiveSupport must be valid, got ${antigravityProbe4.noninteractiveSupport}`);
    assert.ok(VALID_RECEIPT_SUPPORT.includes(antigravityProbe4.receiptSupport),
      `antigravity receiptSupport must be valid, got ${antigravityProbe4.receiptSupport}`);
    assert.equal(antigravityProbe4.unattendedSafe, false, 'antigravity must not claim unattendedSafe=true');
    assert.ok(Array.isArray(antigravityProbe4.unattendedReasons) && antigravityProbe4.unattendedReasons.length > 0,
      'antigravity must have unattendedReasons');
    assert.ok(
      antigravityProbe4.unattendedReasons.some(r => /dispatch_policy_check|dispatch_auto|policy binding/i.test(r)),
      'antigravity unattendedReasons must reference dispatch_policy_check / dispatch_auto policy binding',
    );
    assert.ok(typeof antigravityProbe4.nextAction === 'string' && antigravityProbe4.nextAction.length > 0,
      'antigravity must have a nextAction');
    assertAuthorityFalse(antigravityProbe4, 'antigravityProbe4');

    // agy is the current Antigravity CLI alias.
    const agyProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'agy' });
    assert.equal(agyProbe4.host, 'antigravity');
    assert.equal(agyProbe4.requestedHost, 'agy');
    assert.equal(agyProbe4.cliCommand, 'agy');
    assertAuthorityFalse(agyProbe4, 'agyProbe4');

    // If antigravity is unavailable (agy CLI not in PATH), must degrade visibly.
    if (!antigravityProbe4.available) {
      assert.equal(antigravityProbe4.status, 'unavailable');
      assert.equal(antigravityProbe4.runtimeKind, 'missing-cli');
      assert.equal(antigravityProbe4.receiptSupport, 'unverified',
        'unavailable antigravity must have receiptSupport=unverified');
      assert.ok(
        antigravityProbe4.unattendedReasons.some(r => /not available|install|expose|PATH/i.test(r)),
        'unavailable antigravity must explain agy CLI is not in PATH',
      );
    } else {
      assert.equal(antigravityProbe4.status, 'scaffolded');
      assert.equal(antigravityProbe4.receiptSupport, 'transcript-capture',
        'available antigravity must have receiptSupport=transcript-capture');
      assert.ok(/supervised-only|dispatch_auto|policy/i.test(antigravityProbe4.nextAction),
        'available antigravity nextAction must surface supervised-only or dispatch_auto requirement');
    }

    // legacy gemini probe: compatibility only, not part of the current runtime list
    const geminiProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'gemini' });
    assert.equal(geminiProbe4.host, 'gemini');
    assert.equal(geminiProbe4.schemaVersion, 'lattice.host_runtime_probe.v1');
    assert.ok(geminiProbe4.warnings.some(warning => /deprecated legacy compatibility/i.test(warning)));
    assert.ok(VALID_VERSION_STATUS.includes(geminiProbe4.versionStatus),
      `gemini versionStatus must be valid, got ${geminiProbe4.versionStatus}`);
    assert.ok(VALID_LOGIN_READINESS.includes(geminiProbe4.loginReadiness),
      `gemini loginReadiness must be valid, got ${geminiProbe4.loginReadiness}`);
    assert.ok(VALID_NONINTERACTIVE.includes(geminiProbe4.noninteractiveSupport),
      `gemini noninteractiveSupport must be valid, got ${geminiProbe4.noninteractiveSupport}`);
    assert.ok(VALID_RECEIPT_SUPPORT.includes(geminiProbe4.receiptSupport),
      `gemini receiptSupport must be valid, got ${geminiProbe4.receiptSupport}`);
    assert.equal(geminiProbe4.unattendedSafe, false, 'gemini must not claim unattendedSafe=true');
    assert.ok(Array.isArray(geminiProbe4.unattendedReasons) && geminiProbe4.unattendedReasons.length > 0,
      'gemini must have unattendedReasons');
    assert.ok(
      geminiProbe4.unattendedReasons.some(r => /dispatch_policy_check|dispatch_auto|policy binding/i.test(r)),
      'gemini unattendedReasons must reference dispatch_policy_check / dispatch_auto policy binding',
    );
    assert.ok(typeof geminiProbe4.nextAction === 'string' && geminiProbe4.nextAction.length > 0,
      'gemini must have a nextAction');
    assertAuthorityFalse(geminiProbe4, 'geminiProbe4');

    // If legacy gemini is unavailable (CLI not in PATH), must degrade visibly
    if (!geminiProbe4.available) {
      assert.equal(geminiProbe4.status, 'unavailable');
      assert.equal(geminiProbe4.runtimeKind, 'missing-cli');
      assert.equal(geminiProbe4.receiptSupport, 'unverified',
        'unavailable gemini must have receiptSupport=unverified');
      assert.ok(
        geminiProbe4.unattendedReasons.some(r => /not available|install|expose|PATH/i.test(r)),
        'unavailable gemini must explain CLI is not in PATH',
      );
    } else {
      assert.equal(geminiProbe4.status, 'scaffolded');
      assert.equal(geminiProbe4.receiptSupport, 'transcript-capture',
        'available gemini must have receiptSupport=transcript-capture');
      assert.ok(/supervised-only|dispatch_auto|policy/i.test(geminiProbe4.nextAction),
        'available gemini nextAction must surface supervised-only or dispatch_auto requirement');
    }

    // codex probe: must expose structured fields regardless of session/CLI availability
    const codexProbe4 = run<HostRuntimeProbe>('host_runtime_probe', { host: 'codex' });
    assert.equal(codexProbe4.host, 'codex');
    assert.equal(codexProbe4.schemaVersion, 'lattice.host_runtime_probe.v1');
    assert.ok(VALID_VERSION_STATUS.includes(codexProbe4.versionStatus),
      `codex versionStatus must be valid, got ${codexProbe4.versionStatus}`);
    assert.ok(VALID_LOGIN_READINESS.includes(codexProbe4.loginReadiness),
      `codex loginReadiness must be valid, got ${codexProbe4.loginReadiness}`);
    assert.ok(VALID_NONINTERACTIVE.includes(codexProbe4.noninteractiveSupport),
      `codex noninteractiveSupport must be valid, got ${codexProbe4.noninteractiveSupport}`);
    assert.ok(VALID_RECEIPT_SUPPORT.includes(codexProbe4.receiptSupport),
      `codex receiptSupport must be valid, got ${codexProbe4.receiptSupport}`);
    assert.equal(codexProbe4.unattendedSafe, false, 'codex must not claim unattendedSafe=true');
    assert.ok(Array.isArray(codexProbe4.unattendedReasons) && codexProbe4.unattendedReasons.length > 0,
      'codex must have unattendedReasons');
    assert.ok(
      codexProbe4.unattendedReasons.some(r => /dispatch_policy_check|dispatch_auto|policy binding/i.test(r)),
      'codex unattendedReasons must reference dispatch_policy_check / dispatch_auto policy binding',
    );
    assertAuthorityFalse(codexProbe4, 'codexProbe4');

    // host_runtime_list: current hosts must expose loginReadiness and receiptSupport; legacy gemini is probe-only.
    const runtimeList4 = run<HostRuntimeList>('host_runtime_list');
    assert.deepEqual(runtimeList4.runtimes.map(runtime => runtime.host), ['fake', 'codex', 'claude-code', 'antigravity']);
    assert.equal(runtimeList4.runtimes.some(runtime => runtime.host === 'gemini'), false, 'legacy gemini is not in the current runtime list');
    for (const runtime of runtimeList4.runtimes) {
      assert.ok(VALID_LOGIN_READINESS.includes(runtime.loginReadiness),
        `runtime list ${runtime.host} must have valid loginReadiness, got ${runtime.loginReadiness}`);
      assert.ok(VALID_RECEIPT_SUPPORT.includes(runtime.receiptSupport),
        `runtime list ${runtime.host} must have valid receiptSupport, got ${runtime.receiptSupport}`);
      assert.equal(runtime.unattendedSafe, false,
        `runtime list ${runtime.host} must not claim unattendedSafe=true prematurely`);
      assertAuthorityFalse(runtime, `runtimeList4.${runtime.host}`);
    }
  }

  // CHK-004: unavailable host degrades visibly (PATH-restricted test)
  {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      const antigravityUnavailable = run<HostRuntimeProbe>('host_runtime_probe', { host: 'antigravity' });
      assert.equal(antigravityUnavailable.status, 'unavailable');
      assert.equal(antigravityUnavailable.runtimeKind, 'missing-cli');
      assert.equal(antigravityUnavailable.receiptSupport, 'unverified',
        'unavailable antigravity (PATH-restricted) must have receiptSupport=unverified');
      assert.ok(['ready', 'requires-login', 'unknown'].includes(antigravityUnavailable.loginReadiness),
        `unavailable antigravity loginReadiness must be valid, got ${antigravityUnavailable.loginReadiness}`);
      assert.equal(antigravityUnavailable.unattendedSafe, false,
        'unavailable antigravity must not claim unattendedSafe=true');
      assert.ok(
        antigravityUnavailable.unattendedReasons.some(r => /dispatch_policy_check|dispatch_auto|policy binding/i.test(r)),
        'unavailable antigravity must still reference policy binding requirement',
      );
      assertAuthorityFalse(antigravityUnavailable, 'antigravityUnavailable4');

      const agyUnavailable = run<HostRuntimeProbe>('host_runtime_probe', { host: 'agy' });
      assert.equal(agyUnavailable.host, 'antigravity');
      assert.equal(agyUnavailable.status, 'unavailable');
      assert.equal(agyUnavailable.runtimeKind, 'missing-cli');
      assertAuthorityFalse(agyUnavailable, 'agyUnavailable4');

      const legacyGeminiUnavailable = run<HostRuntimeProbe>('host_runtime_probe', { host: 'gemini' });
      assert.equal(legacyGeminiUnavailable.status, 'unavailable');
      assert.equal(legacyGeminiUnavailable.runtimeKind, 'missing-cli');
      assert.equal(legacyGeminiUnavailable.receiptSupport, 'unverified',
        'unavailable legacy gemini (PATH-restricted) must have receiptSupport=unverified');
      assert.ok(legacyGeminiUnavailable.warnings.some(warning => /deprecated legacy compatibility/i.test(warning)));
      assertAuthorityFalse(legacyGeminiUnavailable, 'legacyGeminiUnavailable4');

      const codexUnavailable = run<HostRuntimeProbe>('host_runtime_probe', { host: 'codex' });
      assert.equal(codexUnavailable.receiptSupport, 'unverified',
        'unavailable codex (PATH-restricted) must have receiptSupport=unverified');
      assert.equal(codexUnavailable.unattendedSafe, false,
        'unavailable codex must not claim unattendedSafe=true');
      assertAuthorityFalse(codexUnavailable, 'codexUnavailable4');
    } finally {
      process.env.PATH = savedPath;
    }
  }

  // CHK-003: missing budget/network → supervised, not refused
  const supervisedPolicyCreate = run<DispatchPolicy>('dispatch_policy_create', {
    policy: 'supervised-only',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    maxParallel: 1,
    maxRuntimeMinutes: 30,
    commandAllowlist: ['node -e "process.exit(0)"'],
    // deliberately omitting maxBudgetUSD and network
  });
  assert.equal(supervisedPolicyCreate.maxBudgetUSD, undefined);
  assert.equal(supervisedPolicyCreate.network, undefined);
  const supervisedCheckResult = run<DispatchPolicyCheckResult>('dispatch_policy_check', { policy: 'supervised-only' });
  assert.equal(supervisedCheckResult.authorized, false);
  assert.equal(supervisedCheckResult.status, 'supervised');
  assert.ok(supervisedCheckResult.degradations.length > 0, 'supervised check must have degradations');
  assert.ok(
    supervisedCheckResult.degradations.some(d => /budget/i.test(d)),
    'supervised check must report missing budget as a degradation',
  );
  assert.ok(
    supervisedCheckResult.degradations.some(d => /network/i.test(d)),
    'supervised check must report missing network as a degradation',
  );
  assertAuthorityFalse(supervisedCheckResult, 'supervisedCheckResult');

  // CHK-005: Runner details exposed through dispatch_status

  function assertRunnerShape(runner: unknown, label: string): void {
    assert.ok(runner && typeof runner === 'object', `${label} must be an object`);
    const r = runner as DispatchRunnerRecord;
    assert.equal(r.schemaVersion, 'lattice.dispatch_runner.v1', `${label}.schemaVersion`);
    assert.ok(typeof r.dispatchId === 'string' && r.dispatchId.length > 0, `${label}.dispatchId must be non-empty`);
    assert.ok(typeof r.host === 'string', `${label}.host must be a string`);
    assert.ok(['fake', 'scaffolded', 'refused'].includes(r.runnerKind), `${label}.runnerKind must be fake|scaffolded|refused, got ${r.runnerKind}`);
    assert.ok(Array.isArray(r.commandTemplate), `${label}.commandTemplate must be an array`);
    assert.ok(Array.isArray(r.invocation), `${label}.invocation must be an array`);
    assert.ok(typeof r.cwd === 'string' && r.cwd.length > 0, `${label}.cwd must be non-empty`);
    assert.ok(typeof r.transcriptPath === 'string' && r.transcriptPath.length > 0, `${label}.transcriptPath must be non-empty`);
    assert.ok(typeof r.startedAt === 'string', `${label}.startedAt must be a string`);
    assert.equal(typeof r.timedOut, 'boolean', `${label}.timedOut must be boolean`);
    assert.ok(Array.isArray(r.refusalReasons), `${label}.refusalReasons must be an array`);
    assert.ok(r.envSummary && typeof r.envSummary === 'object', `${label}.envSummary must be an object`);
    const env = r.envSummary as { totalVars: number; sensitiveFiltered: number; safeVarNames: string[]; note: string };
    assert.ok(typeof env.totalVars === 'number' && env.totalVars >= 0, `${label}.envSummary.totalVars`);
    assert.ok(typeof env.sensitiveFiltered === 'number' && env.sensitiveFiltered >= 0, `${label}.envSummary.sensitiveFiltered`);
    assert.ok(Array.isArray(env.safeVarNames), `${label}.envSummary.safeVarNames must be an array`);
    assert.ok(typeof env.note === 'string', `${label}.envSummary.note must be a string`);
    // Authority invariant
    assert.equal(r.authorityChanged, false, `${label}.authorityChanged must be false`);
    assert.equal(r.receiptVerified, false, `${label}.receiptVerified must be false`);
    assert.equal(r.productionDone, false, `${label}.productionDone must be false`);
  }

  // CHK-005a: Fake run — dispatch_status exposes runner details
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk005-fake',
      host: 'fake',
      objective: 'CHK-005 fake runner details.',
      allowedPaths: ['packages/main/src/generated/chk005-fake.txt'],
    });
    run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk005-fake' });
    const fakeRunStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-chk005-fake' });
    assert.ok(fakeRunStatus.runner !== undefined, 'dispatch_status after fake run must include runner field');
    assertRunnerShape(fakeRunStatus.runner, 'fakeRunStatus.runner');
    assert.equal(fakeRunStatus.runner!.runnerKind, 'fake', 'fake run must have runnerKind=fake');
    assert.ok(fakeRunStatus.runner!.commandTemplate.length > 0, 'fake runner must have commandTemplate');
    assert.ok(fakeRunStatus.runner!.invocation.length > 0, 'fake runner must have invocation');
    assert.equal(fakeRunStatus.runner!.cwd, fakeRunStatus.dispatch.worktree.worktreePath, 'fake runner cwd must match worktree path');
    assert.equal(fakeRunStatus.runner!.transcriptPath, fakeRunStatus.dispatch.transcriptFile, 'fake runner transcriptPath must match dispatch transcriptFile');
    assert.ok(typeof fakeRunStatus.runner!.startedAt === 'string', 'fake runner must have startedAt');
    assert.ok(typeof fakeRunStatus.runner!.endedAt === 'string', 'fake runner must have endedAt');
    assert.equal(typeof fakeRunStatus.runner!.exitCode, 'number', 'fake runner must have exitCode');
    assert.equal(fakeRunStatus.runner!.exitCode, 0, 'successful fake run must have exitCode=0');
    assert.equal(fakeRunStatus.runner!.timedOut, false, 'fake runner timedOut must be false');
    assert.equal(fakeRunStatus.runner!.refusalReasons.length, 0, 'fake runner must have no refusalReasons on success');
    assertAuthorityFalse(fakeRunStatus.runner, 'fakeRunStatus.runner');
    // Text rendering includes runner info
    const fakeRunStatusText = runText('dispatch_status', { dispatchId: 'D-chk005-fake' });
    assert.match(fakeRunStatusText, /runner:/i, 'dispatch_status text must include runner section');
    assert.match(fakeRunStatusText, /runnerKind: fake/, 'dispatch_status text must show runnerKind=fake');
    assert.match(fakeRunStatusText, /cwd:/, 'dispatch_status text must show cwd');
    assert.match(fakeRunStatusText, /transcriptPath:/, 'dispatch_status text must show transcriptPath');
    assert.match(fakeRunStatusText, /exitCode:/, 'dispatch_status text must show exitCode');
  }

  // CHK-005b: Fake run with failing command — exitCode=1, diagnostic status
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk005-fail-cmd',
      host: 'fake',
      objective: 'CHK-005 failed command runner details.',
      allowedPaths: ['packages/main/src/generated/chk005-fail-cmd.txt'],
      requiredCommands: ['node -e "process.exit(7)"'],
    });
    run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk005-fail-cmd' });
    const failCmdStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-chk005-fail-cmd' });
    assert.ok(failCmdStatus.runner !== undefined, 'failed-command dispatch_status must include runner field');
    assertRunnerShape(failCmdStatus.runner, 'failCmdStatus.runner');
    assert.equal(failCmdStatus.runner!.runnerKind, 'fake', 'failed-command runner must still be runnerKind=fake');
    assert.equal(failCmdStatus.runner!.exitCode, 1, 'failed-command fake run must have exitCode=1');
    assertAuthorityFalse(failCmdStatus.runner, 'failCmdStatus.runner');
  }

  // CHK-005c: Scaffolded real-host run — runner details with supervised-only refusalReasons
  {
    const savedCodexSession = process.env.CODEX_SESSION_ID;
    try {
      process.env.CODEX_SESSION_ID = 'chk005-test';
      run<DispatchRecord>('dispatch_prepare', {
        storyId: 'B-dispatch',
        dispatchId: 'D-chk005-scaffolded',
        host: 'codex',
        objective: 'CHK-005 scaffolded real-host runner details.',
        allowedPaths: ['packages/main/src/generated/chk005-scaffolded.txt'],
      });
      run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk005-scaffolded' });
      const scaffoldedStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-chk005-scaffolded' });
      assert.ok(scaffoldedStatus.runner !== undefined, 'scaffolded dispatch_status must include runner field');
      assertRunnerShape(scaffoldedStatus.runner, 'scaffoldedStatus.runner');
      assert.equal(scaffoldedStatus.runner!.runnerKind, 'scaffolded', 'scaffolded run must have runnerKind=scaffolded');
      assert.ok(scaffoldedStatus.runner!.refusalReasons.length > 0, 'scaffolded runner must have refusalReasons (supervised-only)');
      assert.ok(
        scaffoldedStatus.runner!.refusalReasons.some(r => /supervised-only/i.test(r)),
        'scaffolded runner refusalReasons must explain supervised-only',
      );
      assert.equal(scaffoldedStatus.runner!.cwd, scaffoldedStatus.dispatch.worktree.worktreePath, 'scaffolded runner cwd must match worktree path');
      assert.equal(scaffoldedStatus.runner!.transcriptPath, scaffoldedStatus.dispatch.transcriptFile, 'scaffolded runner transcriptPath must match transcriptFile');
      assert.ok(typeof scaffoldedStatus.runner!.startedAt === 'string', 'scaffolded runner must have startedAt');
      assert.ok(typeof scaffoldedStatus.runner!.endedAt === 'string', 'scaffolded runner must have endedAt');
      assert.equal(scaffoldedStatus.runner!.exitCode, undefined, 'scaffolded runner must not have exitCode (not actually run)');
      assert.ok(scaffoldedStatus.runner!.commandTemplate.length > 0, 'scaffolded runner must have commandTemplate');
      assert.ok(scaffoldedStatus.runner!.invocation.length > 0, 'scaffolded runner must have resolved invocation');
      assert.equal(scaffoldedStatus.runner!.invocation.includes('<prompt>'), false, 'scaffolded invocation must not leave a literal <prompt>');
      assert.equal(scaffoldedStatus.runner!.invocation.includes('<prompt-file>'), false, 'scaffolded invocation must not leave a literal <prompt-file>');
      assert.ok(
        scaffoldedStatus.runner!.invocation.some(part => part.includes(resolve(root, scaffoldedStatus.dispatch.promptFile))),
        'scaffolded invocation must point to the prompt file instead of dumping prompt contents',
      );
      assertAuthorityFalse(scaffoldedStatus.runner, 'scaffoldedStatus.runner');
      // Text rendering
      const scaffoldedText = runText('dispatch_status', { dispatchId: 'D-chk005-scaffolded' });
      assert.match(scaffoldedText, /runner:/i, 'scaffolded dispatch_status text must include runner section');
      assert.match(scaffoldedText, /runnerKind: scaffolded/, 'scaffolded dispatch_status text must show runnerKind=scaffolded');
      assert.match(scaffoldedText, /supervised-only/, 'scaffolded dispatch_status text must show supervised-only refusal');
    } finally {
      if (savedCodexSession === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = savedCodexSession;
    }
  }

  // CHK-005d: Refused (unavailable host) — runner details with refusalReasons
  {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      run<DispatchRecord>('dispatch_prepare', {
        storyId: 'B-dispatch',
        dispatchId: 'D-chk005-refused',
        host: 'gemini',
        objective: 'CHK-005 refused runner details.',
        allowedPaths: ['packages/main/src/generated/chk005-refused.txt'],
      });
      run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk005-refused' });
      const refusedStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-chk005-refused' });
      assert.ok(refusedStatus.runner !== undefined, 'refused dispatch_status must include runner field');
      assertRunnerShape(refusedStatus.runner, 'refusedStatus.runner');
      assert.equal(refusedStatus.runner!.runnerKind, 'refused', 'unavailable run must have runnerKind=refused');
      assert.ok(refusedStatus.runner!.refusalReasons.length > 0, 'refused runner must have refusalReasons');
      assert.equal(refusedStatus.dispatch.status, 'unavailable', 'refused dispatch must have status=unavailable');
      assertAuthorityFalse(refusedStatus.runner, 'refusedStatus.runner');
    } finally {
      process.env.PATH = savedPath;
    }
  }

  // CHK-005e: authority invariant — runner object never sets authority fields to true
  {
    const chk5Status = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-chk005-fake' });
    assertAuthorityFalse(chk5Status, 'chk5Status including runner');
  }

  // CHK-006: dispatch_auto scheduler controls and dispatch_watch aggregation

  // CHK-006a: missing policy name → dispatch_auto refused
  assert.throws(
    () => run('dispatch_auto', { storyId: 'B-chk006-auto', allowedPaths: ['packages/main/src/generated/auto-no-policy.txt'] }),
    /requires a policy name/i,
    'dispatch_auto without policy must throw with requires a policy name',
  );

  // CHK-006b: policy not found → dispatch_auto refused
  assert.throws(
    () => run('dispatch_auto', {
      storyId: 'B-chk006-auto',
      policy: 'nonexistent-policy-xyz',
      allowedPaths: ['packages/main/src/generated/auto-no-policy.txt'],
    }),
    /could not be loaded|policy not found/i,
    'dispatch_auto with nonexistent policy must throw',
  );

  // CHK-006c: authorized fake policy starts deterministic workers; dispatch_watch reports accepted state
  {
    const fakePolicyCheck = run<{ authorized: boolean; status: string }>('dispatch_policy_check', { policy: 'fake' });
    assert.equal(fakePolicyCheck.authorized, true, 'fake policy must be authorized for CHK-006 coverage');

    const autoResult = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-chk006-auto',
      policy: 'fake',
      allowedPaths: ['packages/main/src/generated/chk006-auto.txt'],
      objective: 'CHK-006 authorized fake dispatch_auto',
    });
    assert.equal(autoResult.schemaVersion, 'lattice.dispatch_auto.v1', 'dispatch_auto must return lattice.dispatch_auto.v1 schema');
    assert.equal(autoResult.status, 'accepted_local', 'authorized fake dispatch_auto must reach accepted_local');
    assert.equal(autoResult.policy, 'fake', 'dispatch_auto result must echo policy name');
    assert.equal(autoResult.host, 'fake', 'dispatch_auto with fake policy must use fake host');
    assertAuthorityFalse(autoResult, 'autoResult');

    const watchAccepted = run<DispatchWatchResult>('dispatch_watch', { dispatchId: autoResult.dispatchId });
    assert.equal(watchAccepted.schemaVersion, 'lattice.dispatch_watch.v1', 'dispatch_watch must return lattice.dispatch_watch.v1 schema');
    assert.equal(watchAccepted.dispatchId, autoResult.dispatchId, 'dispatch_watch dispatchId must match');
    assert.equal(watchAccepted.storyId, 'B-chk006-auto', 'dispatch_watch storyId must match');
    assert.equal(watchAccepted.status, 'accepted_local', 'dispatch_watch must report accepted_local after dispatch_auto');
    assert.ok(watchAccepted.changedFilesCount !== undefined && watchAccepted.changedFilesCount > 0, 'dispatch_watch must report changedFilesCount for accepted dispatch');
    assert.ok(watchAccepted.runnerSummary !== undefined, 'dispatch_watch must include runnerSummary after fake run');
    assert.equal(watchAccepted.runnerSummary!.runnerKind, 'fake', 'dispatch_watch runnerSummary.runnerKind must be fake');
    assert.ok(typeof watchAccepted.nextAction === 'string' && watchAccepted.nextAction.length > 0, 'dispatch_watch must have nextAction');
    assertAuthorityFalse(watchAccepted, 'watchAccepted');

    // Text rendering
    const watchText = runText('dispatch_watch', { dispatchId: autoResult.dispatchId });
    assert.match(watchText, /proofOrStop\.dispatch_watch\.v1/, 'dispatch_watch text must include schema version');
    assert.match(watchText, /status: accepted_local/, 'dispatch_watch text must show status');
  }

  // CHK-006d: maxParallel exceeded → dispatch_auto refused
  {
    const mp1Policy = run<{ policy: string }>('dispatch_policy_create', {
      policy: 'chk006-mp1',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 1,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 0.5,
      network: 'none',
      commandAllowlist: ['node -e "process.exit(0)"'],
    });
    assert.equal(mp1Policy.policy, 'chk006-mp1', 'policy created');

    // Use dispatch_prepare to create a non-terminal (prepared) record, then try dispatch_auto
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-chk006-auto',
      dispatchId: 'D-chk006-active',
      host: 'fake',
      objective: 'CHK-006 active dispatch for maxParallel test',
      allowedPaths: ['packages/main/src/generated/chk006-active.txt'],
    });
    // D-chk006-active is now in 'prepared' state (non-terminal), count = 1 >= maxParallel 1
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-chk006-auto',
        policy: 'chk006-mp1',
        allowedPaths: ['packages/main/src/generated/chk006-mp1-second.txt'],
        objective: 'CHK-006 maxParallel second should fail',
      }),
      /maxParallel limit/i,
      'dispatch_auto must refuse when maxParallel is reached',
    );

    // Cancel the prepared dispatch so it doesn't interfere with later tests
    run('dispatch_cancel', { dispatchId: 'D-chk006-active' });
  }

  // CHK-006e: host not in policy → dispatch_auto refused
  {
    const claudePolicy = run<{ policy: string }>('dispatch_policy_create', {
      policy: 'chk006-claude-only',
      allowedHosts: ['claude-code'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 2,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 5.0,
      network: 'restricted',
      commandAllowlist: ['node -e "process.exit(0)"'],
    });
    assert.equal(claudePolicy.policy, 'chk006-claude-only');

    // Explicitly requesting fake host, which is not in the policy
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-chk006-auto',
        policy: 'chk006-claude-only',
        host: 'fake',
        allowedPaths: ['packages/main/src/generated/chk006-host-check.txt'],
        objective: 'CHK-006 host not in policy',
      }),
      /not in policy|allowedHosts/i,
      'dispatch_auto must refuse host not in policy allowedHosts',
    );
  }

  // CHK-006f: real host unavailable or unattendedSafe=false → dispatch_auto refused, no real host launched
  {
    const realHostPolicy = run<{ policy: string }>('dispatch_policy_create', {
      policy: 'chk006-real-host',
      allowedHosts: ['gemini'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 2,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 5.0,
      network: 'restricted',
      commandAllowlist: ['node -e "process.exit(0)"'],
    });
    assert.equal(realHostPolicy.policy, 'chk006-real-host');

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      // gemini unavailable → dispatch_auto refuses
      assert.throws(
        () => run('dispatch_auto', {
          storyId: 'B-chk006-auto',
          policy: 'chk006-real-host',
          host: 'gemini',
          allowedPaths: ['packages/main/src/generated/chk006-gemini.txt'],
          objective: 'CHK-006 real host unavailable',
        }),
        /not available|not unattended-safe|unattendedSafe=false/i,
        'dispatch_auto must refuse unavailable real host',
      );
    } finally {
      process.env.PATH = savedPath;
    }

    // Even if gemini CLI is available, dispatch_auto refuses because unattendedSafe=false
    // (All real hosts currently have unattendedSafe=false)
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-chk006-auto',
        policy: 'chk006-real-host',
        host: 'gemini',
        allowedPaths: ['packages/main/src/generated/chk006-gemini-safe.txt'],
        objective: 'CHK-006 real host unattendedSafe=false',
      }),
      /not unattended-safe|unattendedSafe=false|not available/i,
      'dispatch_auto must refuse real host with unattendedSafe=false even if available',
    );
    // No dispatch record created for real host refusal
    const dispatchListAfterRealRefuse = run<DispatchListResult>('dispatch_list', { storyId: 'B-chk006-auto' });
    assert.ok(
      !dispatchListAfterRealRefuse.dispatches.some(d => d.dispatchId.includes('chk006-gemini')),
      'dispatch_auto must not create dispatch record for refused real host',
    );
  }

  // CHK-006g: dispatch_cancel then dispatch_watch reports cancelled; evidence/metadata preserved
  {
    const cancelAutoResult = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-chk006-auto',
      policy: 'fake',
      allowedPaths: ['packages/main/src/generated/chk006-cancel.txt'],
      objective: 'CHK-006 cancel then watch',
    });
    assert.equal(cancelAutoResult.status, 'accepted_local', 'dispatch before cancel must complete');

    // Cancel the dispatch
    run('dispatch_cancel', { dispatchId: cancelAutoResult.dispatchId });

    // Watch reports cancelled state
    const watchCancelled = run<DispatchWatchResult>('dispatch_watch', { dispatchId: cancelAutoResult.dispatchId });
    assert.equal(watchCancelled.status, 'cancelled', 'dispatch_watch must report cancelled after dispatch_cancel');
    assert.ok(typeof watchCancelled.nextAction === 'string' && watchCancelled.nextAction.length > 0, 'dispatch_watch cancelled must have nextAction');
    assertAuthorityFalse(watchCancelled, 'watchCancelled');

    // Evidence files must be preserved (not deleted on cancel)
    const canceledRecord = readDispatch(root, cancelAutoResult.dispatchId);
    assert.ok(existsSync(join(root, canceledRecord.packFile)), 'pack.json must survive cancel');
    assert.ok(existsSync(join(root, canceledRecord.promptFile)), 'prompt.md must survive cancel');
    assert.ok(existsSync(join(root, canceledRecord.statusFile)), 'dispatch.json must survive cancel');
  }

  // CHK-006h: authority invariants throughout dispatch_auto/dispatch_watch
  {
    const authAutoResult = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-chk006-auto',
      policy: 'fake',
      allowedPaths: ['packages/main/src/generated/chk006-auth.txt'],
      objective: 'CHK-006 authority invariant check',
    });
    assertAuthorityFalse(authAutoResult, 'authAutoResult');
    const watchAuth = run<DispatchWatchResult>('dispatch_watch', { dispatchId: authAutoResult.dispatchId });
    assertAuthorityFalse(watchAuth, 'watchAuth');
  }

  // CHK-006i: overflow_auto nextAction mentions dispatch_auto as policy-authorized path
  {
    const overflowResult = run<{ nextAction?: string; schemaVersion: string }>('overflow_auto', {
      storyId: 'B-chk006-auto',
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/chk006-overflow.txt'],
    });
    assert.ok(
      typeof overflowResult.nextAction === 'string' && /dispatch_auto/i.test(overflowResult.nextAction),
      `overflow_auto nextAction must mention dispatch_auto as the policy-authorized unattended path, got: ${overflowResult.nextAction}`,
    );
  }

  // CHK-007: Collect unattended evidence and preserve manual review/merge gates

  // CHK-007a: dispatch_review surfaces transcript path/existence, runner summary, changedFiles,
  //           commands, and local receipt status for a completed fake dispatch.
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk007-review',
      host: 'fake',
      objective: 'CHK-007 review surfaces evidence fields.',
      allowedPaths: ['packages/main/src/generated/chk007-review.txt'],
    });
    run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk007-review' });
    const chk7Review = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-chk007-review' });
    // transcript path and existence
    assert.ok(typeof chk7Review.transcriptPath === 'string' && chk7Review.transcriptPath.length > 0,
      'dispatch_review must surface transcriptPath');
    assert.equal(chk7Review.transcriptExists, true,
      'dispatch_review transcriptExists must be true for completed fake dispatch');
    // runner summary
    assert.ok(chk7Review.runnerSummary !== undefined,
      'dispatch_review must include runnerSummary for completed fake dispatch');
    assert.equal(chk7Review.runnerSummary!.runnerKind, 'fake',
      'dispatch_review runnerSummary.runnerKind must be fake');
    assert.ok(typeof chk7Review.runnerSummary!.cwd === 'string' && chk7Review.runnerSummary!.cwd.length > 0,
      'dispatch_review runnerSummary.cwd must be non-empty');
    assert.ok(typeof chk7Review.runnerSummary!.transcriptPath === 'string' && chk7Review.runnerSummary!.transcriptPath.length > 0,
      'dispatch_review runnerSummary.transcriptPath must be non-empty');
    assert.equal(chk7Review.runnerSummary!.exitCode, 0,
      'dispatch_review runnerSummary.exitCode must be 0 for successful fake dispatch');
    assert.equal(chk7Review.runnerSummary!.timedOut, false,
      'dispatch_review runnerSummary.timedOut must be false for successful dispatch');
    assert.ok(Array.isArray(chk7Review.runnerSummary!.commandTemplate) && chk7Review.runnerSummary!.commandTemplate.length > 0,
      'dispatch_review runnerSummary.commandTemplate must be non-empty array');
    // changedFiles and commands
    assert.ok(chk7Review.changedFiles.length > 0,
      'dispatch_review must surface changedFiles for completed fake dispatch');
    assert.ok(Array.isArray(chk7Review.commands),
      'dispatch_review must surface commands array');
    // local receipt status
    assert.equal(chk7Review.localReceiptStatus, 'accepted-local',
      'dispatch_review localReceiptStatus must be accepted-local for accepted dispatch');
    assertAuthorityFalse(chk7Review, 'chk7Review');

    // Text rendering includes evidence fields
    const chk7ReviewText = runText('dispatch_review', { dispatchId: 'D-chk007-review' });
    assert.match(chk7ReviewText, /transcriptPath:/i, 'dispatch_review text must include transcriptPath');
    assert.match(chk7ReviewText, /transcriptExists: true/, 'dispatch_review text must show transcriptExists');
    assert.match(chk7ReviewText, /localReceiptStatus: accepted-local/, 'dispatch_review text must show localReceiptStatus');
    assert.match(chk7ReviewText, /runnerKind: fake/, 'dispatch_review text must show runner section');
  }

  // CHK-007b: dispatch_review with no transcript (prepared-only) surfaces diagnostic risk.
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk007-no-transcript',
      host: 'fake',
      objective: 'CHK-007 missing transcript must surface diagnostic risk.',
      allowedPaths: ['packages/main/src/generated/chk007-no-transcript.txt'],
    });
    // Do NOT run dispatch_run — no transcript will be written
    const noTxReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-chk007-no-transcript' });
    assert.equal(noTxReview.transcriptExists, false,
      'dispatch_review transcriptExists must be false when dispatch has not run');
    assert.ok(noTxReview.risks.some(risk => /transcript file missing/i.test(risk)),
      'dispatch_review must add transcript-missing risk when transcript does not exist');
    assert.equal(noTxReview.runnerSummary, undefined,
      'dispatch_review runnerSummary must be absent when dispatch has not run');
    assert.equal(noTxReview.localReceiptStatus, 'missing',
      'dispatch_review localReceiptStatus must be missing for never-run dispatch');
    assertAuthorityFalse(noTxReview, 'noTxReview');
  }

  // CHK-007c: dispatch_merge_plan is manualOnly=true and requires actual accepted-local receipts
  //           to set mergeable=true; it is never auto-executable.
  {
    // Accepted parallel dispatch: mergeable=true but manualOnly enforced
    const chk7MergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-parallel' });
    assert.equal(chk7MergePlan.manualOnly, true,
      'dispatch_merge_plan must always be manualOnly=true');
    assert.equal(chk7MergePlan.mergeable, true,
      'dispatch_merge_plan must be mergeable when all workers have accepted-local receipts');
    // Commands must be review/cleanup only, never git merge/cherry-pick
    assert.ok(chk7MergePlan.commands.every(cmd => !/\bgit\s+(merge|cherry-pick)\b/.test(cmd)),
      'dispatch_merge_plan commands must not contain git merge or cherry-pick');
    assert.ok(chk7MergePlan.warnings.some(w => /manual merge only/i.test(w)),
      'dispatch_merge_plan must warn that merge is manual-only');
    assertAuthorityFalse(chk7MergePlan, 'chk7MergePlan');

    // Prepare-only (no run): mergeable=false because receipts are missing
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk007-no-receipt-merge',
      host: 'fake',
      objective: 'CHK-007 merge plan must be non-mergeable without accepted receipt.',
      allowedPaths: ['packages/main/src/generated/chk007-no-receipt-merge.txt'],
    });
    const noReceiptMergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-chk007-no-receipt-merge' });
    assert.equal(noReceiptMergePlan.manualOnly, true,
      'dispatch_merge_plan manualOnly must always be true');
    assert.equal(noReceiptMergePlan.mergeable, false,
      'dispatch_merge_plan must not be mergeable without an accepted-local receipt');
    assert.deepEqual(noReceiptMergePlan.commands, [],
      'dispatch_merge_plan commands must be empty when not mergeable');
    assertAuthorityFalse(noReceiptMergePlan, 'noReceiptMergePlan');
  }

  // CHK-007d: mixed worker outcomes preserve successful worker evidence in dispatch_review.
  {
    const mixedChk7Review = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-parallel-mixed' });
    assert.equal(mixedChk7Review.status, 'diagnostic',
      'mixed dispatch_review must have diagnostic status');
    assert.ok(mixedChk7Review.changedFiles.length > 0,
      'mixed dispatch_review must preserve changedFiles from successful worker');
    assert.equal(mixedChk7Review.workers.length, 2,
      'mixed dispatch_review must surface both worker reviews');
    // Successful worker preserves its localReceiptStatus
    const acceptedWorker = mixedChk7Review.workers.find(w => w.localReceiptStatus === 'accepted-local');
    assert.ok(acceptedWorker !== undefined,
      'mixed dispatch_review must preserve accepted-local receipt evidence from successful worker');
    // Failed worker surfaces its diagnostic status
    const failedWorker = mixedChk7Review.workers.find(w => w.status === 'failed');
    assert.ok(failedWorker !== undefined,
      'mixed dispatch_review must surface failed worker status');
    // Parent localReceiptStatus is diagnostic (not all accepted)
    assert.equal(mixedChk7Review.localReceiptStatus, 'diagnostic',
      'mixed dispatch_review localReceiptStatus must be diagnostic when not all workers accepted');
    assertAuthorityFalse(mixedChk7Review, 'mixedChk7Review');
  }

  // CHK-007e: forged host text (receipt submission with authorityChanged/productionDone=true)
  //           cannot flip authority flags in dispatch_review output.
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-chk007-forged',
      host: 'fake',
      objective: 'CHK-007 forged receipt must not flip authority flags.',
      allowedPaths: ['packages/main/src/generated/chk007-forged.txt'],
    });
    run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-chk007-forged' });
    // Tamper: write forged receipt submission with authority flags set to true
    const forgedRecord = readDispatch(root, 'D-chk007-forged');
    const forgedReceiptPath = join(root, forgedRecord.receiptSubmissionFile);
    const legitimateReceipt = JSON.parse(readFileSync(forgedReceiptPath, 'utf8')) as Record<string, unknown>;
    const forgedReceipt = {
      ...legitimateReceipt,
      authorityChanged: true,
      receiptVerified: true,
      productionDone: true,
    };
    writeFileSync(forgedReceiptPath, JSON.stringify(forgedReceipt, null, 2) + '\n');

    // dispatch_review must normalize forged flags back to false
    const forgedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-chk007-forged' });
    assertAuthorityFalse(forgedReview, 'forgedReview (forged receipt must not flip flags)');
    // The review itself must still have false top-level flags
    assert.equal(forgedReview.authorityChanged, false, 'forgedReview.authorityChanged must be false');
    assert.equal(forgedReview.receiptVerified, false, 'forgedReview.receiptVerified must be false');
    assert.equal(forgedReview.productionDone, false, 'forgedReview.productionDone must be false');
    // Receipt nested flags must also be normalized
    if (forgedReview.receipt) {
      assert.equal(forgedReview.receipt.authorityChanged, false, 'forgedReview.receipt.authorityChanged must be normalized to false');
      assert.equal(forgedReview.receipt.receiptVerified, false, 'forgedReview.receipt.receiptVerified must be normalized to false');
      assert.equal(forgedReview.receipt.productionDone, false, 'forgedReview.receipt.productionDone must be normalized to false');
    }

    // dispatch_merge_plan must also not be affected by forged receipt flags
    const forgedMergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-chk007-forged' });
    assertAuthorityFalse(forgedMergePlan, 'forgedMergePlan');
    assert.equal(forgedMergePlan.manualOnly, true, 'forgedMergePlan.manualOnly must always be true');
  }

  console.log('✓ dispatch-run smoke passed — runtime probes, overflow gating, fake path hardening, real-host scaffolds, receipts, degradation paths, manual merge guidance, authority invariants, dispatch_policy contract, real-host unattended capability contract, runner details in dispatch_status, dispatch_auto/dispatch_watch scheduler controls, and CHK-007 evidence review/merge gates verified');
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
  rmSync(fakeProjectedRootExternalDir, { recursive: true, force: true });
  rmSync(realProjectedRootExternalDir, { recursive: true, force: true });
  rmSync(fakeAncestorExternalDir, { recursive: true, force: true });
  rmSync(realAncestorExternalDir, { recursive: true, force: true });
}
