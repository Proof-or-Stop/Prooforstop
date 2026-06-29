/**
 * @task B-9cec
 * @checklist CHK-001
 * @title validation no-entry warn/skip policy
 * @type bugfix
 * @priority high
 * @description
 *   Back-link docs/requirements/decisions/testing-infra.md:38 to the verifier
 *   implementation: when no validate.ts/js/mts exists, no configured
 *   validate.command(s) exist, and no fallback command can be discovered, Proofbound
 *   returns warn/skip instead of failure. Projects needing strong validation
 *   gates must configure validate.command(s).
 * @changes
 *   - [CHK-001] Bind no-validator warn/skip requirement to verifier implementation
 *   - [CHK-002] Cover no-entry warn/skip and configured-command hard-fail behavior
 *
 * Verifier handlers — lattice validate / status / serve
 *
 * These commands prefer the project's validate.ts file when present (D/M/F verifier
 * pattern), then fall back to configured or auto-discovered language test commands.
 *
 * lattice validate   → validate.ts/js/mts or configured/discovered project tests
 * lattice status     → spawn `npx tsx validate.ts --status` in project root
 * lattice serve      → spawn `npx tsx serve.ts` or start falcon serve in project root
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { loadConfig } from '../core/config.js';
import type { ValidationCommand } from '../core/validation-types.js';
import { executeValidationPlan, formatWorktreePollutionDetails, runValidationCommand, stripAnsi } from '../core/validation-executor.js';
import { withValidationExecutionLock } from '../core/validation-execution-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { runChannelGateCli } from './validate-channel.js';
import { runConceptGateCli } from './validate-concept.js';
import { runLintGateCli, resolveChangedFiles } from './validate-lint.js';
import { buildVerificationCoverage, renderVerificationCoverage, detectLegacyEvidenceWithoutIntent, VERIFICATION_INTENT_REPAIR_COMMAND } from '../core/verification.js';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { resolveGitCwd, resolveProjectGitCwd, evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';
import { resolveVerificationIntentPolicy, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import type { ChecklistData, VerificationEvidence } from '../core/types.js';

const STATUS_FALLBACK_TIMEOUT_MS = 10_000;
const SHELL_META_RE = /[;&|<>$()`]/;

export interface ValidationSetupScan {
  validateFiles: Array<{ name: string; present: boolean }>;
  validateFile: string | null;
  configuredCommands: ValidationCommand[];
  fallbackCommands: ValidationCommand[];
  discoveredFallbackLabels: string[];
  noValidatorWarning: boolean;
  configuredShellStyleCommands: Array<{
    label: string;
    command: string;
    shell: boolean;
    intentionalShellReceipt: boolean;
    source: 'string' | 'object';
  }>;
  configuredShellReceiptsIntentional: boolean;
  warnings: string[];
}

export function findValidateFile(projectRoot: string): string | null {
  const candidates = ['validate.ts', 'validate.js', 'validate.mts'];
  for (const f of candidates) {
    if (existsSync(join(projectRoot, f))) return f;
  }
  return null;
}

function hasAny(projectRoot: string, paths: string[]): boolean {
  return paths.some(p => existsSync(join(projectRoot, p)));
}

function hasDirectoryEntry(projectRoot: string, dir: string, suffixes: string[]): boolean {
  const abs = join(projectRoot, dir);
  if (!existsSync(abs)) return false;
  try {
    return readdirSync(abs).some(entry => suffixes.some(s => entry.endsWith(s)));
  } catch {
    return false;
  }
}

function splitShellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function commandFromString(label: string, value: string): ValidationCommand | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SHELL_META_RE.test(trimmed)) {
    return { label, command: trimmed, args: [], shell: true };
  }
  const parts = splitShellWords(trimmed);
  if (parts.length === 0) return null;
  return { label, command: parts[0], args: parts.slice(1) };
}

function normalizeValidateFocus(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const focus = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  return focus.length > 0 ? focus : undefined;
}

function normalizeFocusArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const focus = String(value).trim();
  if (!focus) {
    throw new Error('validate --focus requires a non-empty focus name');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(focus)) {
    throw new Error('validate --focus accepts only letters, numbers, dot, underscore, or hyphen');
  }
  return focus;
}

function focusedModeNotice(focus: string): string {
  return `FOCUSED VALIDATE MODE focus=${focus}: not final full validation and not DONE-required proof.`;
}

function filterFocusedConfiguredCommands(commands: ValidationCommand[], focus: string): ValidationCommand[] {
  const selected = commands.filter((cmd) => cmd.focus?.includes(focus));
  if (selected.length === 0) {
    throw new Error(
      `validate --focus=${focus}: no configured validate.commands are tagged with focus "${focus}"; ` +
      `tag one or more commands with focus: ["${focus}"] or run lattice validate --json for full validation.`,
    );
  }
  return selected;
}

function markFocusedResult(result: any, focus: string): any {
  if (!focus) return result;
  const provider = String(result.provider ?? 'lattice-verifier');
  const focusedProvider = provider.endsWith('-focused') ? provider : `${provider}-focused`;
  const summary = String(result.summary ?? 'Validation completed');
  const details = Array.isArray(result.details) ? result.details : [];
  return {
    ...result,
    provider: focusedProvider,
    summary: summary.startsWith(`Focused validation (${focus}):`)
      ? summary
      : `Focused validation (${focus}): ${summary}; not final full validation or DONE-required proof`,
    details: details[0] === focusedModeNotice(focus)
      ? details
      : [focusedModeNotice(focus), ...details],
    focus: {
      name: focus,
      mode: 'focused',
      finalFullValidation: false,
      doneRequiredProof: false,
    },
  };
}

function maybePrefixFocusedText(output: string, focus: string | undefined): string {
  if (!focus) return output;
  return `${focusedModeNotice(focus)}\n${output}`;
}

export function configuredValidationCommands(projectRoot: string): ValidationCommand[] {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  const commands: ValidationCommand[] = [];
  if (!validate || typeof validate !== 'object') return commands;

  if (typeof validate.command === 'string') {
    const cmd = commandFromString('configured validate.command', validate.command);
    if (cmd) commands.push(cmd);
  }
  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        if (cmd) commands.push(cmd);
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
        const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
        const focus = normalizeValidateFocus(entry.focus);
        commands.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command,
          args,
          ...(entry.shell === true ? { shell: true } : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) } : {}),
          ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
          ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {}),
          ...(focus ? { focus } : {}),
        });
      }
    }
  }
  return commands;
}

function configuredShellStyleEntries(projectRoot: string): ValidationSetupScan['configuredShellStyleCommands'] {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  const out: ValidationSetupScan['configuredShellStyleCommands'] = [];
  if (!validate || typeof validate !== 'object') return out;

  if (typeof validate.command === 'string' && SHELL_META_RE.test(validate.command.trim())) {
    const cmd = commandFromString('configured validate.command', validate.command);
    out.push({
      label: 'configured validate.command',
      command: validate.command.trim(),
      shell: cmd?.shell === true,
      intentionalShellReceipt: cmd?.shell === true,
      source: 'string',
    });
  }

  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        if (!SHELL_META_RE.test(entry.trim())) continue;
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        out.push({
          label: `configured validate.commands[${i}]`,
          command: entry.trim(),
          shell: cmd?.shell === true,
          intentionalShellReceipt: cmd?.shell === true,
          source: 'string',
        });
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string' && SHELL_META_RE.test(entry.command.trim())) {
        const shell = entry.shell === true;
        out.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command.trim(),
          shell,
          intentionalShellReceipt: shell,
          source: 'object',
        });
      }
    }
  }

  return out;
}

function packageJsonTestCommand(projectRoot: string): ValidationCommand | null {
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
    const testScript = pkg?.scripts?.test;
    if (typeof testScript === 'string' && testScript.trim() && !/no test specified/i.test(testScript)) {
      return { label: 'package.json test script', command: 'npm', args: ['test'] };
    }
  } catch {
    return null;
  }
  return null;
}

export function discoverFallbackValidationCommands(projectRoot: string): ValidationCommand[] {
  const discovered: ValidationCommand[] = [];
  const npmTest = packageJsonTestCommand(projectRoot);
  if (npmTest) discovered.push(npmTest);

  if (existsSync(join(projectRoot, 'go.mod'))) {
    discovered.push({ label: 'go test', command: 'go', args: ['test', './...'] });
  }
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    discovered.push({ label: 'cargo test', command: 'cargo', args: ['test'] });
  }
  // Swift / Package.swift is intentionally NOT included in automatic fallback
  // discovery. The Mac Native App / Swift product runtime has been demoted
  // (see docs/requirements/decisions/testing-infra.md). Projects that still
  // want to run `swift test` must opt in explicitly via validate.command(s).
  if (existsSync(join(projectRoot, 'pom.xml'))) {
    discovered.push({ label: 'maven test', command: 'mvn', args: ['test'] });
  }
  if (hasAny(projectRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
    const gradle = existsSync(join(projectRoot, 'gradlew')) ? './gradlew' : 'gradle';
    discovered.push({ label: 'gradle test', command: gradle, args: ['test'] });
  }
  if (
    hasAny(projectRoot, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) ||
    hasDirectoryEntry(projectRoot, 'tests', ['.py'])
  ) {
    discovered.push({ label: 'pytest', command: 'python', args: ['-m', 'pytest'] });
  }

  return discovered;
}

export function scanValidationSetup(projectRoot: string): ValidationSetupScan {
  const validateFiles = ['validate.ts', 'validate.js', 'validate.mts'].map((name) => ({
    name,
    present: existsSync(join(projectRoot, name)),
  }));
  const validateFile = validateFiles.find((f) => f.present)?.name ?? null;
  const configuredCommands = configuredValidationCommands(projectRoot);
  const fallbackCommands = discoverFallbackValidationCommands(projectRoot);
  const configuredShellStyleCommands = configuredShellStyleEntries(projectRoot);
  const configuredShellReceiptsIntentional = configuredShellStyleCommands.every((cmd) => cmd.intentionalShellReceipt);
  const noValidatorWarning = !validateFile && configuredCommands.length === 0 && fallbackCommands.length === 0;
  const warnings: string[] = [];

  if (!validateFile && configuredCommands.length === 0 && fallbackCommands.length > 0) {
    warnings.push('validate.ts/js/mts not found; validation will use advisory fallback command discovery');
  }
  if (noValidatorWarning) {
    warnings.push('No validate.ts/js/mts, configured validate.command(s), or fallback validation commands found');
  }
  for (const entry of configuredShellStyleCommands) {
    if (!entry.intentionalShellReceipt) {
      warnings.push(`${entry.label} looks shell-style but is not configured with shell=true`);
    }
  }

  return {
    validateFiles,
    validateFile,
    configuredCommands,
    fallbackCommands,
    discoveredFallbackLabels: fallbackCommands.map((cmd) => cmd.label),
    noValidatorWarning,
    configuredShellStyleCommands,
    configuredShellReceiptsIntentional,
    warnings,
  };
}

/** Run a command and capture stdout+stderr, returning { code, output } */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<{ code: number; output: string; durationMs: number; timedOut?: boolean }> {
  const result = await runValidationCommand({ label: command, command, args, ...(timeoutMs ? { timeoutMs } : {}) }, cwd);
  return {
    code: result.code,
    output: result.output,
    durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (resolveGitCwd at the
// caller, which has store+storyId in scope). On a wrapper-root layout it is the
// real gitRoot subdir; on a plain repo it is the projectRoot verbatim. The
// `undefined` fallback on any git failure is preserved (graceful degradation:
// callers treat a missing head as "no head hash", never crash).
function currentHead(gitCwd: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

function evidenceFreshness(gitCwd: string, metadataRoot: string, headHash: string, evidence?: VerificationEvidence) {
  return checkEvidenceFreshnessForGit(gitCwd, headHash, evidence?.materialHash, metadataRoot, evidence?.storyFilesHash);
}

function collectStoryFilesHashAdvisories(cl: ChecklistData, gitCwd: string, metadataRoot: string): string[] {
  const advisories: string[] = [];
  for (const item of cl.items) {
    for (const evidence of item.verificationEvidence || []) {
      if (!evidence.headHash) continue;
      const freshness = evidenceFreshness(gitCwd, metadataRoot, evidence.headHash, evidence);
      if (!freshness.fresh || !freshness.warnings?.length) continue;
      for (const warning of freshness.warnings) {
        advisories.push(`Re-attestation advisory: ${item.id} ${evidence.intentRef}: ${warning}`);
      }
    }
  }
  return [...new Set(advisories)];
}

function decorateStoryVerification(ctx: HandlerContext, storyId: string, result: any): any {
  let coverage;
  let verificationPolicy;
  let legacyHints: Array<{ itemId: string; lane: string; intentRef: string }> = [];
  try {
    const story = ctx.store.readStory(storyId);
    const cl = ctx.store.readChecklist(storyId);
    legacyHints = cl.items.flatMap(detectLegacyEvidenceWithoutIntent);
    let decision = null;
    try { decision = ctx.store.readDecision(storyId); } catch { /* no decision for express/fast stories */ }
    verificationPolicy = resolveVerificationIntentPolicy(story, cl, decision);
    const effectivePolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
    const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    const head = currentHead(gitCwd);
    coverage = buildVerificationCoverage(
      cl,
      head,
      (headHash, evidence) => evidenceFreshness(gitCwd, ctx.root, headHash, evidence).fresh,
      { deferredGateEvidence: 'missing', evidenceQualityProfile: effectivePolicy.profile },
    );
  } catch {
    return result;
  }
  const rendered = renderVerificationCoverage(coverage, verificationPolicy);
  const details = Array.isArray(result.details) ? [...result.details] : [];
  details.push(...rendered.split('\n'));
  details.push(...collectStoryFilesHashAdvisories(ctx.store.readChecklist(storyId), resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }), ctx.root));
  // B-4e06 CHK-002: surface legacy evidence-without-intent as an informational
  // hint naming the repair command. Additive only — never alters coverage math
  // or allPass, so the hint can never become a pass condition.
  for (const h of legacyHints) {
    details.push(`Legacy evidence without intent: ${h.itemId} ${h.lane} has verificationEvidence (${h.intentRef}) but no verificationIntent.${h.lane} — run \`lattice ${VERIFICATION_INTENT_REPAIR_COMMAND}\` to backfill the intent (this is a schema repair, NOT a coverage pass).`);
  }
  const allPass = Boolean(result.allPass) && coverage.missingRequired === 0;
  return {
    ...result,
    status: allPass ? (result.status === 'warn' ? 'warn' : 'pass') : 'fail',
    allPass,
    summary: coverage.missingRequired > 0
      ? `${result.summary || 'Validation'}; verification coverage missing ${coverage.missingRequired} required intent(s)`
      : result.summary,
    details,
    verificationPolicy,
    verificationCoverage: coverage,
    ...(legacyHints.length > 0 ? { legacyEvidenceWithoutIntent: legacyHints } : {}),
  };
}

function resolveStoryVerificationPolicy(ctx: HandlerContext, storyId: string) {
  const story = ctx.store.readStory(storyId);
  const cl = ctx.store.readChecklist(storyId);
  let decision = null;
  try { decision = ctx.store.readDecision(storyId); } catch { /* no decision for express/fast stories */ }
  return resolveVerificationIntentPolicy(story, cl, decision);
}

function persistStoryValidationEvidence(ctx: HandlerContext, storyId: string, result: any, command: string): void {
  const statusPass = result.status === 'pass';
  const allPass = Boolean(result.allPass ?? result.allPassed ?? statusPass);
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const headHash = currentHead(gitCwd) ?? result.headSha ?? result.headHash;
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
  ctx.store.writeTestEvidence(storyId, {
    command,
    output: JSON.stringify(result),
    result: allPass ? 'PASS' : 'FAIL',
    timestamp: new Date().toISOString(),
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...(result.verificationCoverage ? { verificationCoverage: result.verificationCoverage } : {}),
  });
}

function externalResult(args: {
  provider?: string;
  status: 'pass' | 'fail' | 'warn';
  summary: string;
  details: string[];
  warnings?: string[];
  headSha?: string;
  commands?: any[];
  focus?: any;
}) {
  return {
    provider: args.provider ?? 'lattice-verifier',
    status: args.status,
    allPass: args.status !== 'fail',
    summary: args.summary,
    details: args.details,
    warnings: args.warnings ?? [],
    timestamp: new Date().toISOString(),
    ...(args.headSha ? { headSha: args.headSha } : {}),
    commands: args.commands ?? [],
    ...(args.focus ? { focus: args.focus } : {}),
  };
}

function renderExternalResult(result: any): string {
  const mark = result.status === 'fail' ? '✗' : result.status === 'warn' ? '⚠' : '✓';
  const lines = [`${mark} ${result.summary}`];
  for (const detail of result.details || []) lines.push(`  ${detail}`);
  for (const warning of result.warnings || []) lines.push(`  warning: ${warning}`);
  return lines.join('\n');
}

async function maybeHoldValidationLockSmokeHook(projectRoot: string, storyId: string | undefined): Promise<void> {
  // Internal smoke seam: verifies the lock stays held after a command exits and before evidence persists.
  const holdFile = process.env.LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_HOLD_FILE;
  if (!storyId || !holdFile) return;
  const readyFile = process.env.LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE;
  if (readyFile) {
    mkdirSync(dirname(readyFile), { recursive: true });
    writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  }
  const timeoutMs = Number(process.env.LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_TIMEOUT_MS ?? 8000);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000);
  while (existsSync(holdFile)) {
    if (Date.now() > deadline) {
      throw new Error(`validate lock smoke hook timed out waiting for ${holdFile} in ${projectRoot}`);
    }
    await new Promise((resolveHold) => setTimeout(resolveHold, 25));
  }
}

function decorateAndMaybePersistStoryValidation(
  ctx: HandlerContext,
  storyId: string | undefined,
  focus: string | undefined,
  result: any,
): any {
  if (!storyId) return result;
  const decorated = decorateStoryVerification(ctx, storyId, result);
  if (!focus) persistStoryValidationEvidence(ctx, storyId, decorated, `lattice validate --story=${storyId} --json`);
  return decorated;
}

export function createVerifierHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * lattice validate [--full[=filter]] [--story=B-xxx] [--json]
     *
     * Runs the project's validate.ts with appropriate flags.
     * Returns human-readable output by default, or ExternalVerifierResult with --json.
     */
    async validate(args: {
      full?: string | boolean;
      focus?: string;
      story?: string;
      storyId?: string;
      json?: boolean;
      // B-9d95 CHK-006: REVIEW→TEST preflight CLI gate 独立分流
      channel?: boolean;
      concept?: boolean;
      lint?: boolean;
      noSync?: boolean;
    }) {
      // B-a30e: normalize storyId alias — must happen before any story usage
      if (args.storyId !== undefined) {
        const sid = args.storyId.trim();
        if (args.story !== undefined && args.story.trim() !== sid) {
          throw new Error(
            `validate: conflicting story identifiers: --story="${args.story}" and storyId="${args.storyId}" differ; supply only one`,
          );
        }
        args.story = sid;
      }
      const focus = normalizeFocusArg(args.focus);
      const projectRoot = ctx.root;
      // B-75f0 CHK-002: resolve the git working dir once at handler entry so every
      // headSha read below (currentHead / `git rev-parse --short HEAD`) runs from
      // the REAL gitRoot on a wrapper-root layout. With a real --story use the
      // id-keyed resolveGitCwd; otherwise the id-independent project-level resolver.
      // Both fall back to projectRoot verbatim when no gitRoot resolves, so plain
      // repos stay byte-identical and the existing `undefined`/not-git graceful
      // degradation of each reader is preserved.
      const handlerGitCwd = args.story
        ? resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot })
        : resolveProjectGitCwd(projectRoot, projectRoot, loadConfig(projectRoot));
      if (args.story) {
        assertCwdInWorktree(ctx.store, args.story);
        if (!args.noSync) {
          const synced = syncClusterResolves(args.story, ctx.store, projectRoot, ctx.log);
          if (synced.resolved > 0) {
            ctx.log?.(`cluster-sync: auto-resolved ${synced.resolved} finding(s) from commit message Resolves tags`);
          }
        }
      }

      // B-9d95 CHK-006: CLI gate flag 分流——任一命中即只跑对应 gate，
      // 不 spawn pytest 的全量 validate.ts。多个 flag 同时传 → Promise.all 并行。
      if (args.channel || args.concept || args.lint) {
        // B-2856: resolve the story's gitRoot once at handler entry (story context
        // is available here) so the channel/concept git readers run from the real
        // repo in wrapper-root layouts. Null/unresolved → projectRoot fallback.
        const gitCwd = args.story
          ? resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot })
          : (evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot);
        type GateTask = () => Promise<{ name: string; ok: boolean; rendered: string; result: unknown }>;
        const tasks: GateTask[] = [];
        if (args.channel) {
          tasks.push(async () => {
            const r = runChannelGateCli(args.story, { store: ctx.store, projectRoot, gitCwd });
            return { name: 'channel', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.concept) {
          tasks.push(async () => {
            const r = runConceptGateCli({ projectRoot, gitCwd });
            return { name: 'concept', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.lint) {
          tasks.push(async () => {
            // B-a749: when run as a story-scoped gate (--lint --story=B-xxx),
            // resolve the change-scope (changed files vs main) so out-of-scope
            // packages whose deps are absent are skipped-with-warning instead of
            // hard-failing on missing deps. Plain `--lint` (no story) passes no
            // scope → full recursive tsc (unchanged). On resolution failure the
            // resolver returns undefined → full recursive tsc (never skip-all).
            const changedFiles = args.story
              ? resolveChangedFiles({ projectRoot, gitCwd })
              : undefined;
            const r = runLintGateCli({ projectRoot, changedFiles });
            return { name: 'lint', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        ctx.log?.(`running ${tasks.length} CLI gate(s) in parallel (channel=${!!args.channel} concept=${!!args.concept} lint=${!!args.lint})`);
        const results = await Promise.all(tasks.map((t) => t()));
        const allOk = results.every((r) => r.ok);
        if (args.json) {
          return JSON.stringify({
            provider: 'lattice-verifier-gates',
            status: allOk ? 'pass' : 'fail',
            allPass: allOk,
            gates: results.map((r) => ({ name: r.name, ok: r.ok, result: r.result })),
            timestamp: new Date().toISOString(),
          });
        }
        const sections = results.map((r) => r.rendered).join('\n\n');
        if (!allOk) {
          // Print gate output on stdout first so users see which gate(s) failed,
          // then throw a short error so runCli's catch branch exits 1 without
          // double-printing the rendered sections.
          console.log(sections);
          const failedNames = results.filter((r) => !r.ok).map((r) => r.name).join(', ');
          throw new Error(`CLI gate(s) failed: ${failedNames}`);
        }
        return sections;
      }

      const validateFile = findValidateFile(projectRoot);
      if (!validateFile) {
        const configuredCommands = configuredValidationCommands(projectRoot);
        const fallbackCommands = configuredCommands.length === 0
          ? discoverFallbackValidationCommands(projectRoot)
          : [];

        if (focus && configuredCommands.length === 0) {
          throw new Error(
            `validate --focus=${focus}: no validate.ts/js/mts file or configured validate.commands were found; ` +
            'fallback validation discovery is full-only and cannot satisfy a focused validate profile.',
          );
        }
        if (configuredCommands.length === 0 && fallbackCommands.length === 0) {
          const buildNoValidatorResult = () => {
            const base = externalResult({
              provider: 'lattice-verifier-no-validation-entry',
              status: 'warn',
              summary: 'No project validator configured; skipped project-specific validation',
              details: [
                `当前目录: ${projectRoot}`,
                '未找到 validate.ts/js/mts，也未在 lattice.config.json 配置 validate.command(s)',
                '未自动发现 npm test / pytest / go test / cargo test / mvn test / gradle test 等 fallback 标准入口',
                'Swift / Package.swift 不在自动 fallback 列表（Mac Native App 已退役）；如需运行 swift test，请显式配置 validate.commands。',
              ],
              warnings: [
                '这是 skip/warn，不是代码失败。需要强门禁时请在 lattice.config.json 配置 validate.command 或 validate.commands。',
              ],
              headSha: currentHead(handlerGitCwd),
            });
            return decorateAndMaybePersistStoryValidation(ctx, args.story, focus, base);
          };
          const decorated = args.story
            ? await withValidationExecutionLock({
              root: projectRoot,
              storyId: args.story,
              workspaceRoot: handlerGitCwd,
              command: 'validate',
            }, buildNoValidatorResult)
            : buildNoValidatorResult();
          if (args.json) return JSON.stringify(decorated);
          return renderExternalResult(decorated);
        }

        const commands = configuredCommands.length > 0
          ? (focus ? filterFocusedConfiguredCommands(configuredCommands, focus) : configuredCommands)
          : fallbackCommands;
        const usingConfigured = configuredCommands.length > 0;
        const fallbackDiscoveryDetail = 'validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery';
        ctx.log?.(usingConfigured
          ? `running ${commands.length} configured validate.command(s)${focus ? ` for focus=${focus}` : ''}`
          : `validate.ts/js/mts not found and no configured validate.command(s); running ${commands.length} advisory fallback validation command(s)`);
        const runPlanAndPersist = async () => {
          const base = await executeValidationPlan({
            provider: usingConfigured ? 'lattice-verifier-configured-commands' : 'lattice-verifier-fallback-commands',
            commands,
            warnings: [],
            ...(focus ? { focus } : {}),
          }, projectRoot, currentHead(handlerGitCwd), args.story);
          await maybeHoldValidationLockSmokeHook(projectRoot, args.story);
          const summary = usingConfigured
            ? base.summary
            : `${base.summary}; ${fallbackDiscoveryDetail}`;
          const details = usingConfigured
            ? base.details
            : [fallbackDiscoveryDetail, ...base.details];
          const result = externalResult({
            provider: base.provider,
            status: base.status,
            summary,
            details,
            warnings: base.warnings,
            headSha: base.headSha,
            commands: base.commands,
            ...(base.focus ? { focus: base.focus } : {}),
          });
          return decorateAndMaybePersistStoryValidation(ctx, args.story, focus, result);
        };
        const decorated = args.story
          ? await withValidationExecutionLock({
            root: projectRoot,
            storyId: args.story,
            workspaceRoot: handlerGitCwd,
            command: 'validate',
          }, runPlanAndPersist)
          : await runPlanAndPersist();
        for (const cmd of commands) {
          ctx.log?.(`ran: ${cmd.command} ${cmd.args.join(' ')}`);
        }
        if (args.json) return JSON.stringify(decorated);
        return renderExternalResult(decorated);
      }

      // Build args for validate.ts
      const tsArgs: string[] = [validateFile];
      if (args.full !== undefined) {
        if (typeof args.full === 'string' && args.full.length > 0) {
          tsArgs.push(`--full=${args.full}`);
        } else {
          tsArgs.push('--full');
        }
      }
      if (focus) {
        tsArgs.push(`--focus=${focus}`);
      }
      if (args.story) {
        tsArgs.push(`--story=${args.story}`);
        // Git diff 推断：把全部改动文件传给 validate.ts，让项目自己决定跑哪���测试
        // B-db56: resolve gitCwd via resolveGitCwd so wrapper-root layouts
        // (metadataRoot ≠ gitRoot) run git diff in the real repo subdir.
        const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot });
        try {
          const diff = execSync('git diff main...HEAD --name-only', {
            cwd: gitCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (diff) {
            const changedFiles = diff.split('\n').filter(Boolean);
            // 传全部改动文件给 validate.ts，不假设项目遵循 D/M/F 范式
            tsArgs.push(`--changed-files=${changedFiles.join(',')}`);
            ctx.log?.(`story ${args.story}: git diff 发现 ${changedFiles.length} 个改动文件`);
          }
        } catch { /* git diff 失败不阻塞 */ }
      }
      if (args.json) {
        tsArgs.push('--json');
      }

      ctx.log?.(`running: npx tsx ${tsArgs.join(' ')}`);
      const runValidateFile = () => runValidationCommand({
        label: validateFile,
        command: 'npx',
        args: ['tsx', ...tsArgs],
      }, projectRoot);
      const runValidateFileAndRender = async () => {
        const commandResult = await runValidateFile();
        await maybeHoldValidationLockSmokeHook(projectRoot, args.story);
        const { code, output } = commandResult;
        // Task B-6326 + B-4b22: verifier surfaces categorized dirty ownership
        // details AND respects dirty-gate-policy. When every polluted path
        // classifies as a passing category the pollution.blocking flag is
        // flipped false and we keep status=pass.
        const pollutionDetails = formatWorktreePollutionDetails(commandResult, projectRoot, args.story);
        if (pollutionDetails.length > 0) {
          const isBlocking = commandResult.worktreePollution?.blocking !== false;
          const polluted = externalResult({
            status: isBlocking ? 'fail' : 'pass',
            summary: isBlocking
              ? 'Validation command dirtied the worktree'
              : 'Validation command produced policy-allowed dirty paths (audited)',
            details: [
              ...pollutionDetails,
              ...(output.trim() ? output.trim().split('\n').filter(Boolean).map(line => `  output: ${line}`) : []),
            ],
            warnings: isBlocking ? [
              'Validation side effects are not auto-restored because tracked snapshots/docs may be legitimate review artifacts.',
            ] : [],
            headSha: currentHead(handlerGitCwd),
            commands: [commandResult],
          });
          const focusedPolluted = focus ? markFocusedResult(polluted, focus) : polluted;
          const decorated = decorateAndMaybePersistStoryValidation(ctx, args.story, focus, focusedPolluted);
          if (args.json) return JSON.stringify(decorated);
          return renderExternalResult(decorated);
        }

        if (args.json) {
          // Try to extract JSON from output (validate.ts should print JSON when --json is passed)
          const stripped = stripAnsi(output);
          // Look for JSON object in output
          const jsonMatch = stripped.match(/\{[\s\S]*"provider"\s*:\s*"[^"]+"[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const focusedParsed = focus ? markFocusedResult(parsed, focus) : parsed;
            const decorated = decorateAndMaybePersistStoryValidation(ctx, args.story, focus, focusedParsed);
            return JSON.stringify(decorated);
          }
          // If validate.ts doesn't support --json yet, wrap the output
          let headSha: string | undefined;
          try {
            headSha = execSync('git rev-parse --short HEAD', { cwd: handlerGitCwd, encoding: 'utf-8' }).trim();
          } catch { /* not git — graceful: headSha stays undefined */ }

          const wrapped = markFocusedResult({
            provider: 'lattice-verifier',
            status: code === 0 ? 'pass' : 'fail',
            allPass: code === 0,
            summary: code === 0 ? 'All checks passed' : 'Validation failed',
            details: stripped.split('\n').filter(l => l.trim()),
            warnings: [],
            timestamp: new Date().toISOString(),
            headSha,
            commands: [commandResult],
          }, focus ?? '');
          const decorated = decorateAndMaybePersistStoryValidation(ctx, args.story, focus, wrapped);
          return JSON.stringify(decorated);
        }

        if (args.story) {
          try {
            const cl = ctx.store.readChecklist(args.story);
            const head = currentHead(handlerGitCwd);
            const story = ctx.store.readStory(args.story);
            const effectivePolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
            const coverage = buildVerificationCoverage(
              cl,
              head,
              (headHash, evidence) => evidenceFreshness(handlerGitCwd, projectRoot, headHash, evidence).fresh,
              { deferredGateEvidence: 'missing', evidenceQualityProfile: effectivePolicy.profile },
            );
            const verificationPolicy = resolveStoryVerificationPolicy(ctx, args.story);
            const advisories = collectStoryFilesHashAdvisories(cl, handlerGitCwd, projectRoot);
            return maybePrefixFocusedText(output + '\n' + renderVerificationCoverage(coverage, verificationPolicy) + (advisories.length > 0 ? `\n${advisories.join('\n')}` : '') + (code !== 0 || coverage.missingRequired > 0 ? `\n(exit code: ${code || 1})` : ''), focus);
          } catch {
            // If story metadata cannot be read, fall back to raw verifier output.
          }
        }
        return maybePrefixFocusedText(output + (code !== 0 ? `\n(exit code: ${code})` : ''), focus);
      };
      return args.story
        ? await withValidationExecutionLock({
          root: projectRoot,
          storyId: args.story,
          workspaceRoot: handlerGitCwd,
          command: 'validate',
        }, runValidateFileAndRender)
        : await runValidateFileAndRender();
    },

    /**
     * lattice status [--concise]
     *
     * Unified project status: story progress + Machine code status.
     * Two sections run in parallel (Promise.all).
     * --concise: skip code verification (for hook injection).
     */
    async status(args: { concise?: boolean } = {}) {
      const projectRoot = ctx.root;

      // Two tasks in parallel
      const briefTask = (async (): Promise<string> => {
        try {
          const { createSessionHandlers } = await import('./session.js');
          const sessionHandlers = createSessionHandlers(ctx);
          const brief = sessionHandlers.session_brief({ concise: true });
          return typeof brief === 'string' ? brief.trim() : '';
        } catch { return ''; }
      })();

      const verifierTask = (async (): Promise<string> => {
        if (args.concise) return '';
        const validateFile = findValidateFile(projectRoot);
        if (!validateFile) return '';

        // Try serve cache first (if lattice serve is running, result is instant)
        try {
          const { stablePort } = await import('../verifier/browser-executor.js');
          const httpPort = stablePort(projectRoot, 1);
          const res = await fetch(`http://localhost:${httpPort}/status`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            const data = await res.json();
            if (data.validate) return '\n── Code Verification (cached) ──\n' + String(data.validate).trim();
          }
        } catch { /* serve not running, fall through */ }

        // Fallback: spawn tsx
        ctx.log?.('running: npx tsx ' + validateFile + ' --status');
        const { output, timedOut } = await runCommand('npx', ['tsx', validateFile, '--status'], projectRoot, STATUS_FALLBACK_TIMEOUT_MS);
        if (timedOut) {
          const cmd = `npx tsx ${validateFile} --status`;
          const body = [
            `✗ ${cmd} timed out after ${Math.round(STATUS_FALLBACK_TIMEOUT_MS / 1000)}s.`,
            '  Run `lattice validate` for full diagnostics, or start `lattice serve` to use cached status.',
          ];
          if (output.trim()) body.push(...output.trim().split('\n').map(line => `  ${line}`));
          return '\n── Code Verification ──\n' + body.join('\n');
        }
        return output.trim() ? '\n── Code Verification ──\n' + output.trim() : '';
      })();

      const [brief, verifier] = await Promise.all([briefTask, verifierTask]);
      const sections = [brief, verifier].filter(s => s.length > 0);

      if (sections.length === 0) {
        return `✗ 无项目状态可显示\n  当前目录: ${projectRoot}`;
      }
      return sections.join('\n');
    },

    /**
     * lattice serve [--dev="..."] [--port=N]
     *
     * Start HTTP API server for real-time debugging.
     * This is a long-running process, so we spawn it and return the startup info.
     */
    async serve(args: {
      dev?: string;
      port?: number;
      circuit?: boolean;
    }) {
      const projectRoot = ctx.root;

      // Look for serve.ts in project root first, then use verifier's built-in serve
      const serveFiles = ['serve.ts', 'serve.js'];
      let serveFile: string | null = null;
      for (const f of serveFiles) {
        if (existsSync(join(projectRoot, f))) {
          serveFile = f;
          break;
        }
      }

      const tsArgs: string[] = [];
      if (serveFile) {
        tsArgs.push(serveFile);
      } else {
        // Use the verifier's built-in serve module
        // Find it relative to the core package
        const verifierServe = join(__dirname, '..', 'verifier', 'serve.js');
        if (!existsSync(verifierServe)) {
          return `✗ 找不到 serve.ts（项目根目录）或内建 verifier serve 模块\n  当前目录: ${projectRoot}`;
        }
        tsArgs.push(verifierServe);
      }

      if (args.dev) tsArgs.push(`--dev=${args.dev}`);
      if (args.port) tsArgs.push(`--port=${args.port}`);
      if (args.circuit) tsArgs.push('--circuit');

      // Spawn as detached process
      const child = spawn('npx', ['tsx', ...tsArgs], {
        cwd: projectRoot,
        shell: true,
        stdio: 'inherit',
        detached: false,
      });

      // Keep the process running (this handler won't return until killed)
      return new Promise<string>((resolveP) => {
        child.on('close', (code: number | null) => {
          resolveP(`serve exited with code ${code}`);
        });
        child.on('error', (e: Error) => {
          resolveP(`serve failed: ${e.message}`);
        });
      });
    },
  };
}
