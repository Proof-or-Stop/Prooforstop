// Fixtures use the authoritative V5 bundle and its V3 execution component.
// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StoryStore } from '../../core/store.js';

import { acquireOwnerLease } from '../../core/story-owner-lease.js';
import { createChecklistHandlers } from '../../handlers/checklist.js';
import { createEvidencePinGuardHandlers } from '../../handlers/evidence-pin-guard.js';
import { createDonePrepareHandlers } from '../../handlers/done-prepare.js';
import { buildVerificationCoverage } from '../../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../../core/proof-admissibility.js';
import { currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';
import { resetConfigCache } from '../../core/config.js';
import type { ChecklistData, StoryInfo, VerificationEvidence, VerificationIntentItem, VerificationIntentType, VerificationReceiptBundleV5 } from '../../core/types.js';
import { isReusableVerificationReceipt } from '../../core/verification-execution-evidence.js';

import { effectiveValidationCommandEnvironment } from '../../core/validation-command-environment.js';
import { runSingleAllowlistedCommand } from '../../core/validation-executor.js';

import { buildVerificationReuseCapsuleInvocation } from '../../core/verification-reuse-capsule.js';

import { partE } from './refresh.js';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REPO_ROOT = resolve(HERE, '../../../..');

export const REAL_CLI = join(REPO_ROOT, 'packages', 'main', 'dist', 'cli.js');

export const CLAUDE_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'proof-or-stop-evidence-pretool.cjs');

export const CODEX_HOOK = join(REPO_ROOT, '.codex', 'hooks', 'proof-or-stop-evidence-pretool.cjs');

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export async function expectRejection(promise: Promise<unknown>, marker: RegExp, label: string): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, marker, `${label}: expected rejection matching ${marker}, got: ${msg}`);
  }
  assert.ok(threw, `${label}: expected the operation to be REFUSED but it succeeded`);
}

export const SELECTOR = 'MARKER_OK';

export const PASS_CMD = `node -e "console.log('MARKER_OK')"`;

export const NONZERO_CMD = `node -e "console.log('MARKER_OK'); process.exit(3)"`;

export const DIFFERENT_CMD = `node -e "console.log(1)"`;

export interface Env {
  root: string;
  store: StoryStore;
  handlers: ReturnType<typeof createChecklistHandlers>;
  guard: ReturnType<typeof createEvidencePinGuardHandlers>;
  storyId: string;
  launchCounter: { count: number };
}

export function makeEnv(
  storyId: string,
  intents: VerificationIntentItem[],
  runnerAfterExecution?: (command: string, cwd: string) => void | Promise<void>,
  log?: (message: string) => void,
  runnerMode: 'counted' | 'production' = 'counted',
): Env {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b1507-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }, null, 2));
  // Causal execution keys require a resolved tool version. npm runs this smoke
  // with packages/main as process.cwd(), so seed the minimal manifest that the
  // resolver expects in an isolated fixture repo.
  write(root, 'packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0-smoke' }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'work']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'B1507 Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['branch', 'main']);
  resetConfigCache();
  const store = new StoryStore(root);
  const at = '2026-07-25T00:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'b1507-smoke', title: 'verification_run + refresh + guard smoke',
    description: 'smoke', type: 'chore', phase: 'DEV', priority: 'medium',
    createdAt: at, startedAt: at, endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001', title: 'exercise B-1507 behaviors', context: 'ctx', status: 'in_progress',
      startTime: null, endTime: null,
      verificationIntent: { happy: intents, edge: [], adversarial: [] },
    }],
  };
  store.writeStory(storyId, story);
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'smoke_fixture_setup', cwd: root });
  store.writeChecklist(storyId, checklist);
  const launchCounter = { count: 0 };
  const handlers = createChecklistHandlers({
    ...(log ? { log } : {}),
    store,
    root,
    scanRoot: join(root, 'packages/main'),
    ...(runnerMode === 'production' ? {} : { verificationCommandRunner: async (command: string, cwd: string, timeoutMs?: number) => {
      launchCounter.count++;
      const result = await runSingleAllowlistedCommand(command, root, {
        cwd,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await runnerAfterExecution?.(command, cwd);
      return result;
    } }),
  });
  const guard = createEvidencePinGuardHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  return { root, store, handlers, guard, storyId, launchCounter };
}

export function cleanup(env: { root: string }): void {
  rmSync(env.root, { recursive: true, force: true });
}

export function findEvidence(env: Env, intentRef: string) {
  const cl = env.store.readChecklist(env.storyId);
  return cl.items[0].verificationEvidence?.find(e => e.intentRef === intentRef);
}

export function verificationFreshnessHashBinding(env: Env, intentRef: string) {
  const evidence = findEvidence(env, intentRef);
  return {
    evidenceHeadHash: evidence?.headHash,
    evidenceMaterialHash: evidence?.materialHash,
    evidenceStoryFilesHash: evidence?.storyFilesHash,
    currentHeadHash: git(env.root, ['rev-parse', 'HEAD']),
    currentMaterialHash: currentMaterialHash(env.root, 'HEAD', env.root),
    currentStoryFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
  };
}

export function splitReceipt(env: Env, intentRef: string): VerificationReceiptBundleV5 {
  const receipt = findEvidence(env, intentRef)?.receipt;
  assert.ok(
    isReusableVerificationReceipt(receipt),
    `${intentRef}: expected VerificationReceiptBundleV5 with VerificationAssertionReceiptV2 and VerificationExecutionReceiptV3`,
  );
  return receipt;
}

export function reusableReceipt(env: Env, intentRef: string): VerificationReceiptBundleV5 {
  const receipt = findEvidence(env, intentRef)?.receipt;
  assert.ok(
    isReusableVerificationReceipt(receipt),
    `${intentRef}: expected reuse-capable VerificationReceiptBundleV5 with VerificationExecutionReceiptV3 component`,
  );
  return receipt;
}

export function guardVerdict(env: Env, args: { commandString?: string; toolInputJson?: string }): { verdict: string; matched: boolean } {
  const out = env.guard.verification_pin_guard_check({ ...args, json: true });
  return JSON.parse(out) as { verdict: string; matched: boolean };
}

export const intent = (id: string, type: VerificationIntentType, pin?: { command: string; selector: string }): VerificationIntentItem => ({
  id, desc: `intent ${id}`, type, priority: 'must', ...(pin ? { verification: pin } : {}),
});

export function makeCliBackedEnv(storyId: string): Env {
  const env = makeEnv(storyId, [intent('INT-PIN', 'cli')]);
  // Thin shim: importing the real dist/cli.js runs runCli() (no ?query on its own url).
  write(env.root, 'packages/main/dist/cli.js', `import ${JSON.stringify(pathToFileURL(REAL_CLI).href)};\n`);
  return env;
}

export function runHook(hookPath: string, root: string, toolName: string, command: string): number {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: root });
  const r = spawnSync(process.execPath, [hookPath], {
    input: payload,
    // PROOF_OR_STOP_PROJECT_ROOT pins the spawned CLI to THIS temp repo regardless of cwd walking.
    env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 20000,
  });
  return typeof r.status === 'number' ? r.status : -1;
}

export function externalVerifierCommand(counterPath: string, outputPath: string, exitCodePath?: string, gitIndexRefreshRoot?: string): string {
  const script = [
    `require('fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`,
    ...(gitIndexRefreshRoot ? [
      `require('fs').utimesSync(${JSON.stringify(join(gitIndexRefreshRoot, 'packages/main/src/base.ts'))}, new Date(), new Date())`,
      // This disposable fixture deliberately changes its own index stat cache,
      // even when the outer validation disables optional writes to the real index.
      `require('child_process').execFileSync('git',['status','--short'],{cwd:${JSON.stringify(gitIndexRefreshRoot)},env:{...process.env,GIT_OPTIONAL_LOCKS:'1'}})`,
    ] : []),
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(outputPath)}, 'utf8'))`,
    ...(exitCodePath
      ? [`process.exit(Number(require('fs').readFileSync(${JSON.stringify(exitCodePath)}, 'utf8')))`]
      : []),
  ].join(';');
  return `node -e ${JSON.stringify(script)}`;
}

export function commitRefreshDrift(env: Env, label: string): void {
  write(env.root, 'packages/main/src/refresh-drift.ts', `export const drift = ${JSON.stringify(label)};\n`);
  git(env.root, ['add', 'packages/main/src/refresh-drift.ts']);
  git(env.root, ['commit', '-m', `refresh drift ${label}`]);
}

export async function seedPinnedReceipt(
  env: Env,
  args: {
    intentRef: string;
    command: string;
    selector: string;
    kind?: VerificationEvidence['kind'];
    commandTimeoutMs?: number;
    commandTimeoutReason?: string;
    file?: string;
  },
): Promise<void> {
  await env.handlers.verification_evidence_add({
    storyId: env.storyId,
    itemId: 'CHK-001',
    intentRef: args.intentRef,
    kind: args.kind ?? 'integration_test',
    command: args.command,
    selector: args.selector,
    result: 'pass',
    note: `seed ${args.intentRef}`,
    ...(args.file ? { file: args.file } : {}),
    ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
    ...(args.commandTimeoutReason ? { commandTimeoutReason: args.commandTimeoutReason } : {}),
  });
}

export function executionCount(counterPath: string): number {
  return readFileSync(counterPath, 'utf8').length;
}

export function writeSelfAttestedDependencyManifest(
  root: string,
  path: string,
  files: string[],
  overrides: Partial<{
    fileClosure: 'complete' | 'partial';
    deterministic: boolean;
    dynamicFileReads: boolean;
    networkInputs: boolean;
    undeclaredEnvironment: boolean;
    sideEffects: boolean;
    environmentVariables: string[];
  }> = {},
): void {
  const environmentVariables = overrides.environmentVariables
    ?? Object.keys(effectiveValidationCommandEnvironment(process.env, undefined, root)).sort();
  write(root, path, `${JSON.stringify({
    schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v1',
    fileClosure: overrides.fileClosure ?? 'complete',
    files,
    environmentVariables,
    deterministic: overrides.deterministic ?? true,
    dynamicFileReads: overrides.dynamicFileReads ?? false,
    networkInputs: overrides.networkInputs ?? false,
    undeclaredEnvironment: overrides.undeclaredEnvironment ?? false,
    sideEffects: overrides.sideEffects ?? false,
  }, null, 2)}\n`);
}

export function writeCapsuleManifest(root: string, path: string, files: string[]): void {
  write(root, path, `${JSON.stringify({
    schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v2',
    capsuleProfile: 'proof-or-stop.verification-reuse-capsule.v1',
    files,
  }, null, 2)}\n`);
}

export function capsuleCommand(root: string, manifestPath: string, files: string[]): string {
  return buildVerificationReuseCapsuleInvocation({ cwd: root, manifestPath, files }).command;
}

export function gateCoverage(env: Env, checklist: ChecklistData = env.store.readChecklist(env.storyId)) {
  return buildVerificationCoverage(checklist, undefined, undefined, {
    receiptAdmissibility: createVerificationEvidenceGateEvaluator(env.root, env.storyId),
  });
}

export function gateDiagnostic(env: Env, checklist: ChecklistData): string {
  return gateCoverage(env, checklist).entries[0]?.evidence?.nonMechanicalReason ?? '';
}

export async function collectRepairChecks(body: (check: (label: string, fn: () => unknown | Promise<unknown>) => Promise<void>) => Promise<void>): Promise<void> {
  const errors: string[] = [];
  await body(async (label, fn) => {
    try { await fn(); } catch (error) {
      const detail = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(detail);
      console.error(`[repair assertion FAIL] ${detail}`);
    }
  });
  assert.equal(errors.length, 0, errors.join('\n'));
}

export function evidenceContext(env: Env) {
  return { store: env.store, root: env.root, scanRoot: join(env.root, 'packages/main') };
}

export async function doneIdentityPreview(env: Env): Promise<{ transcript: string; blockedAt?: string }> {
  const story = env.store.readStory(env.storyId);
  const previousCwd = process.cwd();
  env.store.writeStory(env.storyId, { ...story, phase: 'TEST', worktree: { path: env.root, branch: 'work', createdAt: story.createdAt } });
  try {
    process.chdir(env.root);
    return await createDonePrepareHandlers(evidenceContext(env)).done_prepare({
      storyId: env.storyId, dryRun: true, mergeMain: false, refreshStale: false,
      validate: false, build: false, json: true,
    });
  } finally {
    process.chdir(previousCwd);
    env.store.writeStory(env.storyId, story);
  }
}

export type VerificationFanoutShardReceipt = {
  codexNote?: string;
  fanout: Awaited<ReturnType<typeof partE>>;
};
