/**
 * @task B-9cec
 * @checklist CHK-001
 * @title validation no-entry warn/skip policy
 * @type bugfix
 * @priority high
 * @description
 *   Back-link docs/requirements/decisions/testing-infra.md:38 to the verifier
 *   implementation: when no validate.ts/js/mts exists, no configured
 *   validate.command(s) exist, and no fallback command can be discovered, Koala
 *   returns warn/skip instead of failure. Projects needing strong validation
 *   gates must configure validate.command(s).
 * @changes
 *   - [CHK-001] Bind no-validator warn/skip requirement to verifier implementation
 *   - [CHK-002] Cover no-entry warn/skip and configured-command hard-fail behavior
 *
 * Verifier handlers — koala validate / status / serve
 *
 * These commands prefer the project's validate.ts file when present (D/M/F verifier
 * pattern), then fall back to configured or auto-discovered language test commands.
 *
 * koala validate   → validate.ts/js/mts or configured/discovered project tests
 * koala status     → spawn `npx tsx validate.ts --status` in project root
 * koala serve      → spawn `npx tsx serve.ts` or start falcon serve in project root
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { loadConfig } from '../core/config.js';
import type { ValidationCommand } from '../core/validation-types.js';
import { executeValidationPlan, formatWorktreePollutionDetails, runValidationCommand, stripAnsi } from '../core/validation-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { runChannelGateCli } from './validate-channel.js';
import { runConceptGateCli } from './validate-concept.js';
import { runLintGateCli } from './validate-lint.js';
import { buildVerificationCoverage, renderVerificationCoverage } from '../core/verification.js';
import { checkEvidenceFreshnessForGit } from '../core/evidence-freshness.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { resolveVerificationIntentPolicy } from '../core/workflow-policy.js';

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
        commands.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command,
          args,
          ...(entry.shell === true ? { shell: true } : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) } : {}),
          ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
          ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {}),
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
  if (existsSync(join(projectRoot, 'Package.swift'))) {
    discovered.push({ label: 'swift test', command: 'swift', args: ['test'] });
  }
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

function currentHead(projectRoot: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

function decorateStoryVerification(ctx: HandlerContext, storyId: string, result: any): any {
  let coverage;
  let verificationPolicy;
  try {
    const story = ctx.store.readStory(storyId);
    const cl = ctx.store.readChecklist(storyId);
    let decision = null;
    try { decision = ctx.store.readDecision(storyId); } catch { /* no decision for express/fast stories */ }
    verificationPolicy = resolveVerificationIntentPolicy(story, cl, decision);
    const head = currentHead(ctx.root);
    coverage = buildVerificationCoverage(
      cl,
      head,
      (headHash, evidence) => checkEvidenceFreshnessForGit(ctx.root, headHash, evidence?.materialHash).fresh,
      { deferredGateEvidence: 'missing' },
    );
  } catch {
    return result;
  }
  const rendered = renderVerificationCoverage(coverage, verificationPolicy);
  const details = Array.isArray(result.details) ? [...result.details] : [];
  details.push(...rendered.split('\n'));
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
  const headHash = currentHead(ctx.root) ?? result.headSha ?? result.headHash;
  ctx.store.writeTestEvidence(storyId, {
    command,
    output: JSON.stringify(result),
    result: allPass ? 'PASS' : 'FAIL',
    timestamp: new Date().toISOString(),
    ...(headHash ? { headHash } : {}),
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
}) {
  return {
    provider: args.provider ?? 'koala-verifier',
    status: args.status,
    allPass: args.status !== 'fail',
    summary: args.summary,
    details: args.details,
    warnings: args.warnings ?? [],
    timestamp: new Date().toISOString(),
    ...(args.headSha ? { headSha: args.headSha } : {}),
    commands: args.commands ?? [],
  };
}

function renderExternalResult(result: any): string {
  const mark = result.status === 'fail' ? '✗' : result.status === 'warn' ? '⚠' : '✓';
  const lines = [`${mark} ${result.summary}`];
  for (const detail of result.details || []) lines.push(`  ${detail}`);
  for (const warning of result.warnings || []) lines.push(`  warning: ${warning}`);
  return lines.join('\n');
}

export function createVerifierHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * koala validate [--full[=filter]] [--story=B-xxx] [--json]
     *
     * Runs the project's validate.ts with appropriate flags.
     * Returns human-readable output by default, or ExternalVerifierResult with --json.
     */
    async validate(args: {
      full?: string | boolean;
      story?: string;
      json?: boolean;
      // B-9d95 CHK-006: REVIEW→TEST preflight CLI gate 独立分流
      channel?: boolean;
      concept?: boolean;
      lint?: boolean;
      noSync?: boolean;
    }) {
      const projectRoot = ctx.root;
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
        type GateTask = () => Promise<{ name: string; ok: boolean; rendered: string; result: unknown }>;
        const tasks: GateTask[] = [];
        if (args.channel) {
          tasks.push(async () => {
            const r = runChannelGateCli(args.story, { store: ctx.store, projectRoot });
            return { name: 'channel', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.concept) {
          tasks.push(async () => {
            const r = runConceptGateCli({ projectRoot });
            return { name: 'concept', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.lint) {
          tasks.push(async () => {
            const r = runLintGateCli({ projectRoot });
            return { name: 'lint', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        ctx.log?.(`running ${tasks.length} CLI gate(s) in parallel (channel=${!!args.channel} concept=${!!args.concept} lint=${!!args.lint})`);
        const results = await Promise.all(tasks.map((t) => t()));
        const allOk = results.every((r) => r.ok);
        if (args.json) {
          return JSON.stringify({
            provider: 'koala-verifier-gates',
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

        if (configuredCommands.length === 0 && fallbackCommands.length === 0) {
          const base = externalResult({
            provider: 'koala-verifier-no-validation-entry',
            status: 'warn',
            summary: 'No project validator configured; skipped project-specific validation',
            details: [
              `当前目录: ${projectRoot}`,
              '未找到 validate.ts/js/mts，也未在 koala.config.json 配置 validate.command(s)',
              '未自动发现 pytest/go test/cargo test/swift test/mvn test/gradle test/npm test 等 fallback 标准入口',
            ],
            warnings: [
              '这是 skip/warn，不是代码失败。需要强门禁时请在 koala.config.json 配置 validate.command 或 validate.commands。',
            ],
            headSha: currentHead(projectRoot),
          });
          const decorated = args.story ? decorateStoryVerification(ctx, args.story, base) : base;
          if (args.story) persistStoryValidationEvidence(ctx, args.story, decorated, `koala validate --story=${args.story} --json`);
          if (args.json) return JSON.stringify(decorated);
          return renderExternalResult(decorated);
        }

        const commands = configuredCommands.length > 0 ? configuredCommands : fallbackCommands;
        const usingConfigured = configuredCommands.length > 0;
        const fallbackDiscoveryDetail = 'validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery';
        ctx.log?.(usingConfigured
          ? `running ${commands.length} configured validate.command(s)`
          : `validate.ts/js/mts not found and no configured validate.command(s); running ${commands.length} advisory fallback validation command(s)`);
        const base = await executeValidationPlan({
          provider: usingConfigured ? 'koala-verifier-configured-commands' : 'koala-verifier-fallback-commands',
          commands,
          warnings: [],
        }, projectRoot, currentHead(projectRoot));
        for (const cmd of commands) {
          ctx.log?.(`ran: ${cmd.command} ${cmd.args.join(' ')}`);
        }
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
        });
        const decorated = args.story ? decorateStoryVerification(ctx, args.story, result) : result;
        if (args.story) persistStoryValidationEvidence(ctx, args.story, decorated, `koala validate --story=${args.story} --json`);
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
      if (args.story) {
        tsArgs.push(`--story=${args.story}`);
        // Git diff 推断：把全部改动文件传给 validate.ts，让项目自己决定跑哪���测试
        try {
          const diff = execSync('git diff main...HEAD --name-only', {
            cwd: projectRoot,
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
      const commandResult = await runValidationCommand({
        label: validateFile,
        command: 'npx',
        args: ['tsx', ...tsArgs],
      }, projectRoot);
      const { code, output } = commandResult;
      // @task B-6326: verifier surfaces categorized dirty ownership details.
      const pollutionDetails = formatWorktreePollutionDetails(commandResult, projectRoot);
      if (pollutionDetails.length > 0) {
        const polluted = externalResult({
          status: 'fail',
          summary: 'Validation command dirtied the worktree',
          details: [
            ...pollutionDetails,
            ...(output.trim() ? output.trim().split('\n').filter(Boolean).map(line => `  output: ${line}`) : []),
          ],
          warnings: [
            'Validation side effects are not auto-restored because tracked snapshots/docs may be legitimate review artifacts.',
          ],
          headSha: currentHead(projectRoot),
          commands: [commandResult],
        });
        const decorated = args.story ? decorateStoryVerification(ctx, args.story, polluted) : polluted;
        if (args.story) persistStoryValidationEvidence(ctx, args.story, decorated, `koala validate --story=${args.story} --json`);
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
          const decorated = args.story ? decorateStoryVerification(ctx, args.story, parsed) : parsed;
          if (args.story) persistStoryValidationEvidence(ctx, args.story, decorated, `koala validate --story=${args.story} --json`);
          return JSON.stringify(decorated);
        }
        // If validate.ts doesn't support --json yet, wrap the output
        let headSha: string | undefined;
        try {
          headSha = execSync('git rev-parse --short HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
        } catch { /* not git */ }

        const wrapped = {
          provider: 'koala-verifier',
          status: code === 0 ? 'pass' : 'fail',
          allPass: code === 0,
          summary: code === 0 ? 'All checks passed' : 'Validation failed',
          details: stripped.split('\n').filter(l => l.trim()),
          warnings: [],
          timestamp: new Date().toISOString(),
          headSha,
          commands: [commandResult],
        };
        const decorated = args.story ? decorateStoryVerification(ctx, args.story, wrapped) : wrapped;
        if (args.story) persistStoryValidationEvidence(ctx, args.story, decorated, `koala validate --story=${args.story} --json`);
        return JSON.stringify(decorated);
      }

      if (args.story) {
        try {
          const cl = ctx.store.readChecklist(args.story);
          const head = currentHead(projectRoot);
          const coverage = buildVerificationCoverage(
            cl,
            head,
            (headHash, evidence) => checkEvidenceFreshnessForGit(projectRoot, headHash, evidence?.materialHash).fresh,
            { deferredGateEvidence: 'missing' },
          );
          const verificationPolicy = resolveStoryVerificationPolicy(ctx, args.story);
          return output + '\n' + renderVerificationCoverage(coverage, verificationPolicy) + (code !== 0 || coverage.missingRequired > 0 ? `\n(exit code: ${code || 1})` : '');
        } catch {
          // If story metadata cannot be read, fall back to raw verifier output.
        }
      }
      return output + (code !== 0 ? `\n(exit code: ${code})` : '');
    },

    /**
     * koala status [--concise]
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

        // Try serve cache first (if koala serve is running, result is instant)
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
            '  Run `koala validate` for full diagnostics, or start `koala serve` to use cached status.',
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
     * koala serve [--dev="..."] [--port=N]
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
        // Find it relative to the koala package
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
