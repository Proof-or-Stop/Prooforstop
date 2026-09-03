import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, PROJECT_CONFIG_FILENAMES } from './config.js';
import {
  RUNTIME_FACT_REGISTRY,
  type RuntimeFactId,
  type RuntimeFactOutputKey,
  type RuntimeFactRegistryEntry,
  type RuntimeFactScope,
  type RuntimeFactSeverity,
} from './runtime-fact-registry.js';
import {
  PROOF_OR_STOP_DEPRECATED_ROOT_PACKAGE_NAME,
  PROOF_OR_STOP_ROOT_PACKAGE_NAME,
} from './proof-or-stop-brand.js';
import { readBrandEnv } from './brand-env.js';

export type RuntimeFactStatus = 'pass' | 'warn' | 'fail';
export type RuntimeMode = 'global-cli' | 'project-local-package' | 'packaged-runtime' | 'compatibility-launcher' | 'diagnostic-only';
export type RuntimeModeSource = 'repo-local-dist' | 'project-node-modules' | 'packaged-runtime' | 'external-development-engine' | 'global-cli' | 'unknown';
export type RuntimeModeAuthority = 'local-runtime-diagnostic-only';

export interface RuntimeModeContract {
  mode: RuntimeMode;
  source: RuntimeModeSource;
  requiresProjectJavaScriptRuntime: boolean;
  authority: RuntimeModeAuthority;
  message: string;
}

export interface RuntimeFactCheckResult {
  id: RuntimeFactId;
  outputKey: RuntimeFactOutputKey;
  status: RuntimeFactStatus;
  severity: RuntimeFactSeverity;
  scope: RuntimeFactScope;
  rationale: string;
  driftMessage: string;
  repairHint?: string;
  actual?: unknown;
  expected?: unknown;
  details?: string[];
  warnings?: string[];
  connectivityChecked?: boolean;
}

export type RuntimeEnvironmentReport = {
  isSelfProject: boolean;
  scope: 'self' | 'external';
  runtimeMode: RuntimeModeContract;
  summary: {
    status: RuntimeFactStatus;
    pass: number;
    warn: number;
    fail: number;
  };
} & Record<RuntimeFactOutputKey, RuntimeFactCheckResult>;

export interface RuntimeEnvironmentOptions {
  commandResolver?: (projectRoot: string) => string | null;
  globalNpmRootResolver?: (projectRoot: string) => string | null;
  corePackageRoot?: string;
}

interface RuntimeCheckContext {
  projectRoot: string;
  isSelfProject: boolean;
  runtimeScope: 'self' | 'external';
  corePackageRoot: string;
  canonicalSelfCoreRoot: string | null;
  cliEntrypoint: string | null;
  activeCliEntrypoint: string | null;
  globalNpmRoot: string | null;
}

export const STALE_GLOBAL_RUNTIME_REASON_CODE = 'stale_global_runtime_in_worktree' as const;

export type RuntimeEntrypointAuthorityReasonCode =
  | typeof STALE_GLOBAL_RUNTIME_REASON_CODE
  | 'runtime_authority_unresolved_in_worktree'
  | 'runtime_authority_probe_timeout_in_worktree';

export interface RuntimeEntrypointAuthorityInput {
  command: string;
  commandArgs: string[];
  projectRoot: string;
  invokedEntrypoint?: string | null;
  loadedCorePackageRoot?: string | null;
  env?: Record<string, string | undefined>;
  requiresAuthoritativeRuntime?: boolean;
}

export interface RuntimeEntrypointAuthorityDecision {
  status: 'pass' | 'exempt' | 'blocked';
  reasonCode?: RuntimeEntrypointAuthorityReasonCode;
  selfHostWorktree: boolean;
  projectRoot: string;
  worktreeRoot: string | null;
  mainRoot: string | null;
  gitCommonDir: string | null;
  invokedEntrypoint: string | null;
  runtimeRoot: string | null;
  recoveryCommand?: string;
  detail: string;
}

interface ExternalReference {
  file: string;
  value: string;
  line: number;
  healthSemantics: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIN_NODE_MAJOR = 20;
const CANONICAL_ROOT_PACKAGE_NAME = PROOF_OR_STOP_ROOT_PACKAGE_NAME;
const DEPRECATED_ROOT_PACKAGE_NAME = PROOF_OR_STOP_DEPRECATED_ROOT_PACKAGE_NAME;
const CANONICAL_CORE_PACKAGE_NAME = '@proof-or-stop/core';
const DEPRECATED_CORE_PACKAGE_NAME = '@lattice/core';
const SELF_ROOT_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  CANONICAL_ROOT_PACKAGE_NAME,
  DEPRECATED_ROOT_PACKAGE_NAME,
]);
// Self-project detection must accept EITHER core spelling: a miss makes runtimeScope flip
// self -> external, which downgrades drift checks to advisory (the B-cdf6 regression class).
const SELF_CORE_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  CANONICAL_CORE_PACKAGE_NAME,
  DEPRECATED_CORE_PACKAGE_NAME,
]);
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const HOST_PORT_RE = /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}:\d{2,5}\b/g;
const LOCAL_HOST_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i;
const HEALTH_SEMANTICS_RE = /\b(health\s*check|healthcheck|health\s*command|doctor|ping|readiness|liveness)\b|health check|health command/i;
const RUNTIME_MODE_AUTHORITY: RuntimeModeAuthority = 'local-runtime-diagnostic-only';

interface CorePackageCandidate {
  path: string;
  packageName: typeof CANONICAL_CORE_PACKAGE_NAME | typeof DEPRECATED_CORE_PACKAGE_NAME;
  exists: boolean;
}

export function runRuntimeEnvironmentChecks(
  projectRoot: string,
  options: RuntimeEnvironmentOptions = {},
): RuntimeEnvironmentReport {
  const resolvedRoot = resolve(projectRoot);
  const corePackageRoot = options.corePackageRoot ? resolve(options.corePackageRoot) : currentCorePackageRoot();
  const cliEntrypoint = (options.commandResolver ?? resolveCliCommandPath)(resolvedRoot);
  const globalNpmRoot = (options.globalNpmRootResolver ?? resolveGlobalNpmRoot)(resolvedRoot);
  const isSelfProject = detectSelfProject(resolvedRoot);
  const context: RuntimeCheckContext = {
    projectRoot: resolvedRoot,
    isSelfProject,
    runtimeScope: isSelfProject ? 'self' : 'external',
    corePackageRoot,
    canonicalSelfCoreRoot: isSelfProject ? resolveCanonicalSelfCoreRoot(resolvedRoot) : null,
    cliEntrypoint,
    activeCliEntrypoint: resolveActiveCliEntrypoint(resolvedRoot, corePackageRoot, cliEntrypoint),
    globalNpmRoot,
  };

  const results = RUNTIME_FACT_REGISTRY.map((entry) => runRegistryCheck(entry, context));
  const summary = summarize(results);
  const keyed = Object.fromEntries(results.map((result) => [result.outputKey, result])) as Record<RuntimeFactOutputKey, RuntimeFactCheckResult>;

  return {
    isSelfProject,
    scope: context.runtimeScope,
    runtimeMode: classifyRuntimeMode(context),
    summary,
    ...keyed,
  };
}

export function renderRuntimeFootprintSummary(runtimeMode: RuntimeModeContract, nextAction?: string): string {
  return [
    'Runtime footprint:',
    `Runtime mode: ${runtimeMode.mode}`,
    `Runtime source: ${runtimeMode.source}`,
    `Project-local JavaScript runtime required: ${runtimeMode.requiresProjectJavaScriptRuntime ? 'yes' : 'no'}`,
    `Authority: ${runtimeMode.authority}`,
    `Next action: ${nextAction ?? runtimeMode.message}`,
  ].join('\n');
}

export function renderRuntimeEnvironmentReport(report: RuntimeEnvironmentReport): string {
  const lines: string[] = [];
  lines.push('Runtime scan:');
  lines.push(`  scope: ${report.scope}`);
  lines.push(`  runtimeMode: ${report.runtimeMode.mode} (${report.runtimeMode.source})`);
  lines.push(`  status: ${report.summary.status} (${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail)`);
  for (const entry of RUNTIME_FACT_REGISTRY) {
    const result = report[entry.outputKey];
    const detail = compactFactDetail(result);
    lines.push(`  ${statusIcon(result.status)} ${entry.id} [${result.severity}] ${detail}`);
    if (result.warnings && result.warnings.length > 0) {
      for (const warning of result.warnings.slice(0, 4)) {
        lines.push(`    - ${warning}`);
      }
      if (result.warnings.length > 4) {
        lines.push(`    - ... and ${result.warnings.length - 4} more`);
      }
    }
    if (result.status !== 'pass' && result.repairHint) {
      lines.push(`    repair: ${result.repairHint}`);
    }
  }
  lines.push('  note: runtime facts describe environment drift; process gates remain in process-fact-registry.');
  return lines.join('\n');
}

function runRegistryCheck(entry: RuntimeFactRegistryEntry, context: RuntimeCheckContext): RuntimeFactCheckResult {
  const severity = context.isSelfProject ? entry.selfSeverity : entry.externalSeverity;
  const base = {
    id: entry.id,
    outputKey: entry.outputKey,
    severity,
    scope: entry.scope,
    rationale: entry.rationale,
    driftMessage: entry.driftMessage,
    ...(entry.repairHint ? { repairHint: entry.repairHint } : {}),
  };

  switch (entry.checker) {
    case 'resolveEntrypointAuthority':
      return { ...base, ...checkEntrypointAuthority(context, severity) };
    case 'resolveCliEntrypoint':
      return { ...base, ...checkCliEntrypoint(context, severity) };
    case 'resolveGlobalCoreRealpath':
      return { ...base, ...checkGlobalCoreRealpath(context, severity) };
    case 'resolveProjectLocalBin':
      return { ...base, ...checkProjectLocalBin(context, severity) };
    case 'resolveNodeVersion':
      return { ...base, ...checkNodeVersion(severity) };
    case 'resolvePackageVersion':
      return { ...base, ...checkPackageVersion(context, severity) };
    case 'resolveValidateSource':
      return { ...base, ...checkValidateSource(context, severity) };
    case 'scanExternalReferencePolicy':
      return { ...base, ...checkExternalReferencePolicy(context, severity) };
  }
}

function checkEntrypointAuthority(
  context: RuntimeCheckContext,
  severity: RuntimeFactSeverity,
): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const runtimeEntrypointAuthority = classifyRuntimeEntrypointAuthority({
    command: process.argv[2] ?? 'doctor',
    commandArgs: process.argv.slice(3),
    projectRoot: context.projectRoot,
    invokedEntrypoint: context.activeCliEntrypoint,
    loadedCorePackageRoot: context.corePackageRoot,
    env: process.env,
  });
  const status = runtimeEntrypointAuthority.status === 'blocked' ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: runtimeEntrypointAuthority,
    expected: context.isSelfProject
      ? 'active CLI runtime belongs to the current worktree'
      : 'external consumer runtime remains advisory',
    ...(status === 'pass' ? {} : { warnings: [runtimeEntrypointAuthority.detail] }),
  };
}

/**
 * Classify the runtime before CLI dispatch. Identity comes from canonical
 * filesystem paths and git metadata, never argv[0], PATH order, or repository
 * basenames. External consumers are deliberately outside this self-host gate.
 */
export function classifyRuntimeEntrypointAuthority(
  input: RuntimeEntrypointAuthorityInput,
): RuntimeEntrypointAuthorityDecision {
  const projectRoot = safeRealpath(resolve(input.projectRoot)) ?? resolve(input.projectRoot);
  const invokedEntrypoint = input.invokedEntrypoint
    ? safeRealpath(resolve(input.invokedEntrypoint)) ?? resolve(input.invokedEntrypoint)
    : null;
  const loadedCorePackageRoot = input.loadedCorePackageRoot
    ? safeRealpath(resolve(input.loadedCorePackageRoot)) ?? resolve(input.loadedCorePackageRoot)
    : currentCorePackageRoot();
  const base = {
    projectRoot,
    invokedEntrypoint,
  };

  if (!detectSelfProject(projectRoot)) {
    return {
      status: 'pass',
      selfHostWorktree: false,
      ...base,
      worktreeRoot: null,
      mainRoot: null,
      gitCommonDir: null,
      runtimeRoot: gitTopLevel(loadedCorePackageRoot)
        ?? (invokedEntrypoint ? gitTopLevel(dirname(invokedEntrypoint)) : null),
      detail: 'External consumer repository: self-host runtime authority is advisory.',
    };
  }

  const identityProbe = { deadline: performance.now() + 16_000, timedOut: false, env: input.env ?? process.env };
  const worktreeRoot = gitTopLevel(projectRoot, identityProbe);
  const gitCommonDir = absoluteGitCommonDir(projectRoot, identityProbe);
  const mainRoot = worktreeRoot ? findMainWorktreeRoot(worktreeRoot, identityProbe) : null;
  const selfHostWorktree = !!worktreeRoot
    && !!gitCommonDir
    && !!mainRoot
    && !samePath(worktreeRoot, mainRoot);
  // The loaded module root is authoritative. A launcher can live outside git
  // (or spoof argv/PATH) while importing main-checkout dist; process.argv[1]
  // alone cannot identify that runtime. Entrypoint git identity is only the
  // fallback for packaged/compatibility launchers without a package root.
  const loadedCoreRelation = worktreeRoot ? relative(worktreeRoot, loadedCorePackageRoot) : null;
  const loadedCoreInsideWorktree = loadedCoreRelation !== null
    && loadedCoreRelation !== '..' && !loadedCoreRelation.startsWith(`..${delimiter}`) && !isAbsolute(loadedCoreRelation);
  const runtimeRoot = loadedCoreInsideWorktree ? worktreeRoot : gitTopLevel(loadedCorePackageRoot, identityProbe)
    ?? (invokedEntrypoint ? gitTopLevel(dirname(invokedEntrypoint), identityProbe) : null);

  if ((!worktreeRoot || !gitCommonDir || !mainRoot) && input.requiresAuthoritativeRuntime !== false) {
    const recoveryRoot = worktreeRoot ?? projectRoot;
    return {
      status: 'blocked',
      reasonCode: identityProbe.timedOut ? 'runtime_authority_probe_timeout_in_worktree' : 'runtime_authority_unresolved_in_worktree',
      selfHostWorktree: false,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand: renderLocalEntrypointRecoveryCommand(recoveryRoot, input.command, input.commandArgs),
      detail: identityProbe.timedOut
        ? 'Self-host runtime authority git identity probe exceeded its bounded retry budget.'
        : 'Self-host runtime authority could not resolve a complete git worktree/common-dir/main-worktree identity.',
    };
  }

  if (!selfHostWorktree) {
    return {
      status: 'pass',
      selfHostWorktree: false,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      detail: 'Not a linked self-host story worktree; no worktree runtime mismatch applies.',
    };
  }

  const recoveryCommand = renderLocalEntrypointRecoveryCommand(worktreeRoot!, input.command, input.commandArgs);
  // B-cdf6:F-020 — read BOTH brand spellings, same as line ~1129 does for this exact
  // semantic check. A raw `input.env?.PROOF_OR_STOP_CODEX_ENTRYPOINT` access here would miss the
  // canonical PROOF_OR_STOP_CODEX_ENTRYPOINT spelling, which is equally valid under the
  // additive compat contract. Since classifyRuntimeEntrypointAuthority runs on EVERY command
  // in a self-host worktree (cli-engine.ts passes env: process.env), missing it would
  // misclassify a legitimate global-fallback session_brief heartbeat as a runtime-authority
  // violation. Same bug class as F-016 (idleProofOrStop), which is why this was swept for.
  const isExplicitSessionBriefFallback = input.command === 'session_brief'
    && readBrandEnv('CODEX_ENTRYPOINT', input.env) === 'global-fallback';
  if (isExplicitSessionBriefFallback) {
    return {
      status: 'exempt',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: 'Explicit global-fallback session_brief heartbeat is exempt; it is not current-worktree gate evidence.',
    };
  }

  const runtimeIsLocal = !!runtimeRoot && samePath(runtimeRoot, worktreeRoot!);
  if (runtimeIsLocal) {
    return {
      status: 'pass',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      detail: 'Runtime authority check: PASS — active CLI resolves inside the current story worktree.',
    };
  }

  const runtimeIsMain = !!runtimeRoot && !!mainRoot && samePath(runtimeRoot, mainRoot);
  if (runtimeIsMain) {
    return {
      status: 'blocked',
      reasonCode: STALE_GLOBAL_RUNTIME_REASON_CODE,
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: `Loaded runtime belongs to the main checkout (${runtimeRoot}), not the active worktree (${worktreeRoot}).`,
    };
  }

  if (input.requiresAuthoritativeRuntime !== false) {
    return {
      status: 'blocked',
      reasonCode: 'runtime_authority_unresolved_in_worktree',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: invokedEntrypoint
        ? `Could not bind the active runtime (${invokedEntrypoint}) to the current worktree git identity.`
        : 'Could not resolve the active CLI entrypoint for this self-host worktree.',
    };
  }

  return {
    status: 'pass',
    selfHostWorktree: true,
    ...base,
    worktreeRoot,
    mainRoot,
    gitCommonDir,
    runtimeRoot,
    recoveryCommand,
    detail: 'Read-only command allowed with unresolved runtime identity; mutating commands remain fail-closed.',
  };
}

export function renderRuntimeEntrypointAuthorityFailure(decision: RuntimeEntrypointAuthorityDecision): string {
  if (decision.status !== 'blocked' || !decision.reasonCode) return decision.detail;
  return [
    `Blocked [${decision.reasonCode}] before dispatch.`,
    decision.detail,
    decision.recoveryCommand ? `Retry: ${decision.recoveryCommand}` : '',
  ].filter(Boolean).join('\n');
}

export function renderLocalEntrypointRecoveryCommand(
  worktreeRoot: string,
  command: string,
  args: readonly string[],
): string {
  const tokens = [command, ...args].map(shellQuote);
  // B-cc10 CHK-006: was `bin/proofOrStop.js`. A recovery command must name a wrapper that
  // still exists, or the operator's retry fails for a second, unrelated reason.
  return `cd -- ${shellQuote(worktreeRoot)} && node bin/proof-or-stop.js ${tokens.join(' ')}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

type IdentityProbeBudget = { deadline: number; timedOut: boolean; env: NodeJS.ProcessEnv | Record<string, string | undefined> };

function gitTopLevel(cwd: string, budget?: IdentityProbeBudget): string | null {
  const top = budget
    ? runAuthoritativeIdentityCommand(['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd, budget)
    : runCommand('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd);
  return top ? safeRealpath(top) ?? resolve(top) : null;
}

function absoluteGitCommonDir(cwd: string, budget?: IdentityProbeBudget): string | null {
  const common = budget
    ? runAuthoritativeIdentityCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, budget)
    : runCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common ? safeRealpath(common) ?? resolve(common) : null;
}

function findMainWorktreeRoot(cwd: string, budget?: IdentityProbeBudget): string | null {
  const raw = budget
    ? runAuthoritativeIdentityCommand(['worktree', 'list', '--porcelain'], cwd, budget)
    : runCommand('git', ['worktree', 'list', '--porcelain'], cwd);
  if (!raw) return null;
  for (const record of raw.split(/\n\s*\n/)) {
    const lines = record.split(/\r?\n/);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (path && branch === 'refs/heads/main') return safeRealpath(path) ?? resolve(path);
  }
  return null;
}

function checkCliEntrypoint(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'details' | 'warnings'> {
  const commandPath = context.cliEntrypoint;
  if (!commandPath) {
    return {
      status: statusForDrift(severity),
      actual: null,
      expected: context.isSelfProject ? join(expectedSelfCoreRoot(context), 'dist', 'cli.js') : 'proof-or-stop executable on PATH',
      warnings: ['PATH lookup for `proof-or-stop` did not resolve a CLI executable'],
    };
  }
  const commandRealpath = safeRealpath(commandPath);
  const expectedCli = context.isSelfProject ? join(expectedSelfCoreRoot(context), 'dist', 'cli.js') : null;
  const matchesExpected = !expectedCli || (commandRealpath ? samePath(commandRealpath, expectedCli) : false);
  const status = matchesExpected ? 'pass' : statusForDrift(severity);
  return {
    status,
    actual: {
      path: commandPath,
      realpath: commandRealpath,
    },
    expected: expectedCli,
    ...(status === 'pass' ? {} : { warnings: [`CLI entrypoint resolves to ${commandRealpath ?? commandPath}, expected ${expectedCli}`] }),
  };
}

function checkGlobalCoreRealpath(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const globalRoot = context.globalNpmRoot;
  const globalPackage = globalRoot ? resolveCorePackageCandidate(globalRoot) : null;
  const globalPackagePath = globalPackage?.path ?? null;
  const globalRealpath = globalPackage && globalPackage.exists ? safeRealpath(globalPackage.path) : null;
  const expected = context.isSelfProject ? expectedSelfCoreRoot(context) : resolveCanonicalCoreRoot(context.corePackageRoot);
  if (!globalPackage || !globalPackagePath || !globalRealpath) {
    return {
      status: statusForDrift(severity),
      actual: { npmRoot: globalRoot, packageName: globalPackage?.packageName ?? CANONICAL_CORE_PACKAGE_NAME, packagePath: globalPackagePath, realpath: null },
      expected,
      warnings: [`global ${CANONICAL_CORE_PACKAGE_NAME} could not be resolved from \`npm root -g\``],
    };
  }
  const status = samePath(globalRealpath, expected) ? 'pass' : statusForDrift(severity);
  const warnings = status === 'pass' ? [] : [`global ${describeCorePackageCandidate(globalPackage)} resolves to ${globalRealpath}, expected ${expected}`];
  return {
    status,
    actual: { npmRoot: globalRoot, packageName: globalPackage?.packageName, packagePath: globalPackagePath, realpath: globalRealpath },
    expected,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function checkProjectLocalBin(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const localBin = projectLocalBinPath(context.projectRoot);
  const localBinExists = existsSync(localBin);
  const localRealpath = localBinExists ? safeRealpath(localBin) : null;
  const cliRealpath = context.activeCliEntrypoint ? safeRealpath(context.activeCliEntrypoint) : context.cliEntrypoint ? safeRealpath(context.cliEntrypoint) : null;
  const matchesEntrypoint = localBinExists && !!localRealpath && !!cliRealpath && samePath(localRealpath, cliRealpath);
  const shadowsEntrypoint = localBinExists && !matchesEntrypoint;
  const status = shadowsEntrypoint ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: {
      path: localBin,
      present: localBinExists,
      realpath: localRealpath,
      cliRealpath,
      matchesEntrypoint,
      shadowsEntrypoint,
    },
    expected: 'project-local proof-or-stop should be absent or resolve to the active CLI entrypoint',
    ...(shadowsEntrypoint ? { warnings: [localBinWarning(localBin, localRealpath, cliRealpath, context.activeCliEntrypoint ?? context.cliEntrypoint)] } : {}),
  };
}

function classifyRuntimeMode(context: RuntimeCheckContext): RuntimeModeContract {
  const active = runtimeEntrypointRealpath(context);
  const localBin = projectLocalBinPath(context.projectRoot);
  const localBinPresent = existsSync(localBin);
  const localBinRealpath = localBinPresent ? safeRealpath(localBin) : null;

  if (localBinPresent) {
    if (!active.realpath) {
      return runtimeModeContract(
        'diagnostic-only',
        'unknown',
          'project-local CLI bin exists, but the active Proof-or-Stop entrypoint could not be resolved',
      );
    }
    if (!localBinRealpath) {
      return runtimeModeContract(
        'diagnostic-only',
        'unknown',
        `project-local CLI bin exists at ${localBin}, but its realpath could not be resolved`,
      );
    }
    if (samePath(localBinRealpath, active.realpath)) {
      if (isPackagedRuntime()) {
        return runtimeModeContract(
          'packaged-runtime',
          'packaged-runtime',
          'packaged runtime detected; project package.json/node_modules are not required for Proof-or-Stop diagnostics',
        );
      }
      return runtimeModeContract(
        'project-local-package',
        'project-node-modules',
        `active Proof-or-Stop is the project-local ${relative(context.projectRoot, localBin)} package`,
        true,
      );
    }
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `project-local CLI bin ${localBin} resolves to ${localBinRealpath}, but the active CLI resolves to ${active.realpath}`,
    );
  }

  if (isPackagedRuntime()) {
    return runtimeModeContract(
      'packaged-runtime',
      'packaged-runtime',
      'packaged runtime detected; project package.json/node_modules are not required for Proof-or-Stop diagnostics',
    );
  }

  if (!active.realpath) {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      'active Proof-or-Stop entrypoint could not be resolved; runtime classification is diagnostic-only',
    );
  }

  const source = runtimeModeSource(context, active.realpath);
  if (source === 'unknown') {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `active Proof-or-Stop ${active.realpath} does not match a known runtime source`,
    );
  }

  if (source === 'global-cli' && !compatibilityLauncherSignal(active.path)) {
    return runtimeModeContract(
      'global-cli',
      'global-cli',
      'active Proof-or-Stop resolves to the global installation; project package.json/node_modules are not required',
    );
  }

  return runtimeModeContract(
    'compatibility-launcher',
    source,
    compatibilityRuntimeMessage(source),
  );
}

function runtimeModeContract(
  mode: RuntimeMode,
  source: RuntimeModeSource,
  message: string,
  requiresProjectJavaScriptRuntime = false,
): RuntimeModeContract {
  return {
    mode,
    source,
    requiresProjectJavaScriptRuntime,
    authority: RUNTIME_MODE_AUTHORITY,
    message,
  };
}

function runtimeEntrypointRealpath(context: RuntimeCheckContext): { path: string | null; realpath: string | null } {
  const path = context.activeCliEntrypoint ?? context.cliEntrypoint;
  return {
    path,
    realpath: path ? safeRealpath(path) ?? resolve(path) : null,
  };
}

function runtimeModeSource(context: RuntimeCheckContext, activeRealpath: string): RuntimeModeSource {
  const selfDistRoot = join(context.projectRoot, 'packages', 'main', 'dist');
  const projectNodeModulesCore = resolveCorePackageCandidate(join(context.projectRoot, 'node_modules'));
  const globalCoreRoot = context.globalNpmRoot ? resolveCorePackageCandidate(context.globalNpmRoot) : null;

  if (pathContains(selfDistRoot, activeRealpath) || samePath(context.corePackageRoot, join(context.projectRoot, 'packages', 'main'))) {
    return 'repo-local-dist';
  }
  if (pathContains(projectNodeModulesCore.path, activeRealpath) || pathContains(projectNodeModulesCore.path, context.corePackageRoot)) {
    return 'project-node-modules';
  }
  if (globalCoreRoot && (pathContains(globalCoreRoot.path, activeRealpath) || pathContains(globalCoreRoot.path, context.corePackageRoot))) {
    return 'global-cli';
  }
  if (pathContains(context.corePackageRoot, activeRealpath) || !pathContains(context.projectRoot, context.corePackageRoot)) {
    return 'external-development-engine';
  }
  return 'unknown';
}

function compatibilityRuntimeMessage(source: RuntimeModeSource): string {
  switch (source) {
    case 'repo-local-dist':
      return 'compatibility launcher is using the repository-local Proof-or-Stop dist runtime; run npm --prefix packages/main run build after core edits';
    case 'project-node-modules':
      return 'compatibility launcher is using the project node_modules Proof-or-Stop package without requiring node_modules/.bin/proof-or-stop as the active CLI';
    case 'packaged-runtime':
      return 'compatibility launcher is using a packaged Proof-or-Stop runtime; project package.json/node_modules are not required';
    case 'external-development-engine':
      return 'compatibility launcher is using an external Proof-or-Stop development engine; project package.json/node_modules are not required';
    case 'global-cli':
      return 'compatibility launcher is using the global Proof-or-Stop; project package.json/node_modules are not required';
    case 'unknown':
      return 'runtime source is unknown; classification is diagnostic-only';
  }
}

function checkNodeVersion(severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    status: ok ? 'pass' : statusForDrift(severity),
    actual: process.version,
    expected: `>=${MIN_NODE_MAJOR}.0.0`,
    ...(ok ? {} : { warnings: [`Node ${process.version} is below ${MIN_NODE_MAJOR}.x`] }),
  };
}

function checkPackageVersion(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const runtimePackage = readPackageJson(context.corePackageRoot);
  const rootPackage = readPackageJson(context.projectRoot);
  const selfCorePackage = context.isSelfProject ? readPackageJson(join(context.projectRoot, 'packages', 'main')) : null;
  const globalPackageCandidate = context.globalNpmRoot ? resolveCorePackageCandidate(context.globalNpmRoot) : null;
  const globalPackagePath = globalPackageCandidate?.path ?? null;
  const globalPackage = globalPackagePath ? readPackageJson(globalPackagePath) : null;
  const versions = [
    runtimePackage?.version,
    context.isSelfProject ? rootPackage?.version : undefined,
    context.isSelfProject ? selfCorePackage?.version : undefined,
    context.isSelfProject ? globalPackage?.version : undefined,
  ].filter((version): version is string => typeof version === 'string' && version.length > 0);
  const unique = new Set(versions);
  const ok = unique.size <= 1 && versions.length > 0;
  return {
    status: ok ? 'pass' : statusForDrift(severity),
    actual: {
      runtime: packageSummary(runtimePackage, context.corePackageRoot),
      root: packageSummary(rootPackage, context.projectRoot),
      selfCore: selfCorePackage ? packageSummary(selfCorePackage, join(context.projectRoot, 'packages', 'main')) : null,
      globalCore: globalPackagePath ? packageSummary(globalPackage, globalPackagePath) : null,
    },
    expected: context.isSelfProject ? 'root, packages/main, runtime, and global core versions match' : 'runtime package version readable',
    ...(ok ? {} : { warnings: ['Proof-or-Stop package versions are missing or inconsistent'] }),
  };
}

function checkValidateSource(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const scan = scanValidateSource(context.projectRoot);
  const status = scan.source === 'missing' || scan.source === 'fallback' ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: scan,
    expected: 'validate.ts/js/mts or configured validate.command(s); fallback discovery is advisory only',
    ...(status === 'pass' ? {} : { warnings: scan.warnings }),
  };
}

function checkExternalReferencePolicy(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings' | 'connectivityChecked'> {
  const scan = scanExternalReferences(context.projectRoot);
  const referencesMissingHealth = scan.references.filter((ref) => !ref.healthSemantics);
  const status = referencesMissingHealth.length > 0 ? statusForDrift(severity) : 'pass';
  const warnings = referencesMissingHealth.map((ref) => `${ref.file}:${ref.line} ${ref.value} is reference-only; no health command semantics found`);
  return {
    status,
    connectivityChecked: false,
    actual: {
      scannedFiles: scan.scannedFiles,
      ignoredExamples: scan.ignoredExamples,
      externalReferenceCount: scan.references.length,
      references: scan.references.slice(0, 20),
      policy: 'reference-only',
    },
    expected: 'bounded docs/config references either stay internal or document explicit health command semantics',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function scanValidateSource(projectRoot: string): {
  validateFiles: Array<{ name: string; present: boolean }>;
  validateFile: string | null;
  configuredCommands: number;
  discoveredFallbackLabels: string[];
  source: 'validate-file' | 'configured' | 'fallback' | 'missing';
  warnings: string[];
} {
  const validateFiles = ['validate.ts', 'validate.js', 'validate.mts'].map((name) => ({
    name,
    present: existsSync(join(projectRoot, name)),
  }));
  const validateFile = validateFiles.find((file) => file.present)?.name ?? null;
  const configuredCommands = countConfiguredValidationCommands(projectRoot);
  const discoveredFallbackLabels = discoverFallbackValidationLabels(projectRoot);
  const source = validateFile
    ? 'validate-file'
    : configuredCommands > 0
      ? 'configured'
      : discoveredFallbackLabels.length > 0
        ? 'fallback'
        : 'missing';
  const warnings: string[] = [];
  if (source === 'fallback') {
    warnings.push('validate.ts/js/mts and configured validate.command(s) are missing; using advisory fallback discovery');
  }
  if (source === 'missing') {
    warnings.push('No validate.ts/js/mts, configured validate.command(s), or fallback validation commands found');
  }
  return { validateFiles, validateFile, configuredCommands, discoveredFallbackLabels, source, warnings };
}

function countConfiguredValidationCommands(projectRoot: string): number {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  if (!validate || typeof validate !== 'object') return 0;
  let count = 0;
  if (typeof validate.command === 'string' && validate.command.trim()) count++;
  if (Array.isArray(validate.commands)) {
    for (const entry of validate.commands) {
      if (typeof entry === 'string' && entry.trim()) count++;
      else if (entry && typeof entry === 'object' && typeof entry.command === 'string' && entry.command.trim()) count++;
    }
  }
  return count;
}

function discoverFallbackValidationLabels(projectRoot: string): string[] {
  const labels: string[] = [];
  const packageJson = readPackageJson(projectRoot);
  if (typeof packageJson?.scripts?.test === 'string' && packageJson.scripts.test.trim() && !/no test specified/i.test(packageJson.scripts.test)) {
    labels.push('package.json test script');
  }
  if (existsSync(join(projectRoot, 'go.mod'))) labels.push('go test');
  if (existsSync(join(projectRoot, 'Cargo.toml'))) labels.push('cargo test');
  // Swift / Package.swift is intentionally NOT advertised as a standard
  // automatic fallback (Mac Native App demoted). Opt in explicitly via
  // validate.commands if needed.
  if (existsSync(join(projectRoot, 'pom.xml'))) labels.push('maven test');
  if (existsSync(join(projectRoot, 'build.gradle')) || existsSync(join(projectRoot, 'build.gradle.kts')) || existsSync(join(projectRoot, 'settings.gradle')) || existsSync(join(projectRoot, 'settings.gradle.kts'))) {
    labels.push('gradle test');
  }
  if (
    existsSync(join(projectRoot, 'pyproject.toml')) ||
    existsSync(join(projectRoot, 'pytest.ini')) ||
    existsSync(join(projectRoot, 'setup.cfg')) ||
    existsSync(join(projectRoot, 'tox.ini')) ||
    hasDirectoryEntry(projectRoot, 'tests', '.py')
  ) {
    labels.push('pytest');
  }
  return labels;
}

function scanExternalReferences(projectRoot: string): {
  scannedFiles: string[];
  ignoredExamples: number;
  references: ExternalReference[];
} {
  const relFiles = boundedReferenceFiles(projectRoot);
  const references: ExternalReference[] = [];
  let ignoredExamples = 0;
  for (const relFile of relFiles) {
    const absFile = join(projectRoot, relFile);
    const text = readText(absFile);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const values = externalValuesFromLine(line);
      for (const value of values) {
        if (LOCAL_HOST_RE.test(value)) {
          ignoredExamples++;
          continue;
        }
        const windowText = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
        references.push({
          file: relFile,
          value,
          line: index + 1,
          healthSemantics: HEALTH_SEMANTICS_RE.test(windowText),
        });
      }
    }
  }
  return { scannedFiles: relFiles, ignoredExamples, references };
}

function boundedReferenceFiles(projectRoot: string): string[] {
  // Scan the same active project config surface as loadConfig.
  const candidates = [...PROJECT_CONFIG_FILENAMES, 'AGENTS.md', 'CLAUDE.md', 'README.md'];
  const files = candidates.filter((relPath) => existsSync(join(projectRoot, relPath)));
  const requirementsRoot = join(projectRoot, 'docs', 'requirements');
  for (const relPath of listMarkdownFiles(requirementsRoot, join('docs', 'requirements'))) {
    files.push(relPath);
  }
  return files;
}

function listMarkdownFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(absDir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch {
    // PROBE: unreadable optional docs/requirements directory means there are no bounded docs to scan.
    return out;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry);
    const rel = join(relDir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      // PROBE: skip entries that disappear or cannot be statted during the bounded scan.
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...listMarkdownFiles(abs, rel));
    } else if (entry.endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

function externalValuesFromLine(line: string): string[] {
  const values = new Set<string>();
  for (const match of line.matchAll(URL_RE)) values.add(stripTrailingPunctuation(match[0]));
  for (const match of line.matchAll(HOST_PORT_RE)) values.add(stripTrailingPunctuation(match[0]));
  return [...values];
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;]+$/g, '');
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 2_000): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: process.env,
    }).trim();
  } catch {
    // PROBE: command discovery is best-effort for runtime diagnostics.
    return null;
  }
}

function runAuthoritativeIdentityCommand(args: string[], cwd: string, budget: IdentityProbeBudget): string | null {
  let attempt = 0;
  while (performance.now() < budget.deadline) {
    const remaining = Math.max(1, Math.floor(budget.deadline - performance.now()));
    const timeout = attempt === 0 ? Math.min(2_000, remaining) : remaining;
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout,
        env: budget.env as NodeJS.ProcessEnv,
      }).trim();
    } catch (error) {
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).code === 'ETIMEDOUT'
        || (error as { killed?: boolean }).killed === true;
      if (!timedOut) return null;
      budget.timedOut = true;
      attempt += 1;
    }
  }
  budget.timedOut = true;
  return null;
}

function resolveCliCommandPath(projectRoot: string): string | null {
  return resolveCommandOnPath('proof-or-stop', projectRoot) ?? resolveCommandOnPath('lattice', projectRoot);
}

function resolveCommandOnPath(command: 'proof-or-stop' | 'lattice', projectRoot: string): string | null {
  const pathEnv = process.platform === 'win32'
    ? process.env.Path ?? process.env.PATH ?? ''
    : process.env.PATH ?? '';
  for (const rawDir of pathEnv.split(delimiter)) {
    const dir = rawDir.length > 0 ? rawDir : '.';
    const absDir = isAbsolute(dir) ? dir : resolve(projectRoot, dir);
    for (const name of commandPathNames(command)) {
      const candidate = resolve(absDir, name);
      if (isRunnablePath(candidate)) return candidate;
    }
  }
  return null;
}

function commandPathNames(command: 'proof-or-stop' | 'lattice'): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [...new Set([
    command,
    ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
    ...extensions.map((extension) => `${command}${extension.toUpperCase()}`),
  ])];
}

function isRunnablePath(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveGlobalNpmRoot(projectRoot: string): string | null {
  return runCommand('npm', ['root', '-g'], projectRoot);
}

function resolveActiveCliEntrypoint(projectRoot: string, corePackageRoot: string, fallbackEntrypoint: string | null): string | null {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
  if (invoked && looksLikeProofOrStopEntrypoint(invoked, projectRoot, corePackageRoot)) return invoked;
  return fallbackEntrypoint;
}

function looksLikeProofOrStopEntrypoint(path: string, projectRoot: string, corePackageRoot: string): boolean {
  const real = safeRealpath(path) ?? path;
  const name = basename(path);
  if (
    name === 'proof-or-stop'
    || name === 'proof-or-stop.cmd'
    || name === 'proof-or-stop.js'
    || name === 'proof-or-stop-codex.js'
  ) return true;
  if ((name === 'cli.js' || name === 'cli-engine.js') && pathContains(corePackageRoot, real)) return true;
  for (const rel of ['proof-or-stop.js', 'proof-or-stop-codex.js']) {
    if (samePath(real, join(projectRoot, 'bin', rel))) return true;
  }
  return false;
}

function currentCorePackageRoot(): string {
  return resolve(__dirname, '..', '..');
}

function detectSelfProject(projectRoot: string): boolean {
  const rootPackage = readPackageJson(projectRoot);
  const corePackage = readPackageJson(join(projectRoot, 'packages', 'main'));
  const rootName = rootPackage?.name;
  const coreName = corePackage?.name;
  return SELF_ROOT_PACKAGE_NAMES.has(rootName)
    && typeof coreName === 'string'
    && SELF_CORE_PACKAGE_NAMES.has(coreName);
}

function packagePathFromName(root: string, packageName: string): string {
  const [scope, name] = packageName.split('/');
  if (!scope || !name) throw new Error(`invalid package name: ${packageName}`);
  return join(root, scope, name);
}

function resolveCorePackageCandidate(root: string): CorePackageCandidate {
  const canonicalPath = packagePathFromName(root, CANONICAL_CORE_PACKAGE_NAME);
  if (existsSync(canonicalPath)) {
    return { path: canonicalPath, packageName: CANONICAL_CORE_PACKAGE_NAME, exists: true };
  }
  // B-cc10 CHK-005: fall back to the deprecated scope so an already-installed global
  // @proof-or-stop/core is still FOUND (and reported) instead of looking absent.
  const deprecatedPath = packagePathFromName(root, DEPRECATED_CORE_PACKAGE_NAME);
  if (existsSync(deprecatedPath)) {
    return { path: deprecatedPath, packageName: DEPRECATED_CORE_PACKAGE_NAME, exists: true };
  }
  return { path: canonicalPath, packageName: CANONICAL_CORE_PACKAGE_NAME, exists: false };
}

function describeCorePackageCandidate(candidate: CorePackageCandidate): string {
  return candidate.packageName;
}

// Single source of truth for locating the refs/heads/main worktree's
// packages/main via `git worktree list --porcelain` (F-001): both the
// self-project and non-self canonicalizers parse identically and differ only
// in their fallbacks. Returns null when git fails, no main-branch worktree is
// listed, or the candidate directory does not exist.
function findMainWorktreeCoreRoot(anchorDir: string): string | null {
  const raw = runCommand('git', ['worktree', 'list', '--porcelain'], anchorDir);
  if (!raw) return null;
  const records = raw.split(/\n\s*\n/).map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const lines = record.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (worktree && branch === 'refs/heads/main') {
      const candidate = join(worktree, 'packages', 'main');
      if (existsSync(candidate)) return safeRealpath(candidate) ?? resolve(candidate);
    }
  }
  return null;
}

function resolveCanonicalSelfCoreRoot(projectRoot: string): string | null {
  const canonical = findMainWorktreeCoreRoot(projectRoot);
  if (canonical) return canonical;
  const localCore = join(projectRoot, 'packages', 'main');
  return existsSync(localCore) ? safeRealpath(localCore) ?? resolve(localCore) : null;
}

function expectedSelfCoreRoot(context: RuntimeCheckContext): string {
  return context.canonicalSelfCoreRoot ?? join(context.projectRoot, 'packages', 'main');
}

// A worktree-built CLI evaluating a NON-self project must accept the global
// package resolving to the canonical main checkout of the CLI's own repository:
// linked worktrees are never relinked into `npm root -g`, so comparing against
// the raw corePackageRoot makes the check structurally unpassable from any
// story worktree (B-fa65). Canonicalize via `git worktree list` anchored at the
// core root itself; a different clone has a different repository, so its
// canonical path still differs from the global realpath and genuine drift
// keeps warning. When git yields no main worktree the fallback is the
// realpath-normalized core root — deliberately NOT the raw pre-fix path,
// because the comparison target (globalRealpath) is itself realpath-resolved,
// so symlink normalization must match on both sides (F-002).
function resolveCanonicalCoreRoot(coreRoot: string): string {
  return findMainWorktreeCoreRoot(coreRoot) ?? safeRealpath(coreRoot) ?? resolve(coreRoot);
}

function readPackageJson(dir: string): any | null {
  const path = join(dir, 'package.json');
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // PROBE: missing or malformed package.json is reported as an unavailable package summary.
    return null;
  }
}

function packageSummary(pkg: any | null, dir: string): { path: string; name: unknown; version: unknown } | null {
  if (!pkg) return null;
  return { path: join(dir, 'package.json'), name: pkg.name, version: pkg.version };
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    // PROBE: optional bounded reference files may be absent or unreadable.
    return '';
  }
}

function hasDirectoryEntry(projectRoot: string, dir: string, suffix: string): boolean {
  const abs = join(projectRoot, dir);
  if (!existsSync(abs)) return false;
  try {
    return readdirSync(abs).some((entry) => entry.endsWith(suffix));
  } catch {
    // PROBE: optional test directories may be absent or unreadable.
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // PROBE: unresolved realpaths are surfaced to callers as null for drift reporting.
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function projectLocalBinPath(projectRoot: string): string {
  const candidates = projectLocalBinCandidates(projectRoot);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function projectLocalBinCandidates(projectRoot: string): string[] {
  const binDir = join(projectRoot, 'node_modules', '.bin');
  return process.platform === 'win32'
    ? [join(binDir, 'proof-or-stop.cmd')]
    : [join(binDir, 'proof-or-stop')];
}

function isPackagedRuntime(): boolean {
  return readBrandEnv('DESKTOP_PACKAGED_RUNTIME') === '1'
    || Boolean((process as typeof process & { pkg?: unknown }).pkg);
}

// B-cc10 CHK-006: the deprecated basenames below remain recognized for older checkouts and
// compatibility provenance. This predicate
// asks "was a retained COMPATIBILITY launcher used?", so recognizing the old names is the
// whole point — adding the canonical spellings would make every ordinary canonical
// invocation look like a compatibility launcher and invert the classification at line 626.
// The current package ships only the proof-or-stop bin; an older checkout may still reach this
// signal through its legacy launcher and must remain classifiable as compatibility traffic.
function compatibilityLauncherSignal(activePath: string | null): boolean {
  if (readBrandEnv('ACTIVITY_SOURCE') === 'codex') return true;
  if (readBrandEnv('CODEX_ENTRYPOINT') === 'global-fallback' || readBrandEnv('CODEX_ENTRYPOINT') === 'local-wrapper') return true;
  return false;
}

function localBinWarning(localBin: string, localRealpath: string | null, cliRealpath: string | null, cliEntrypoint: string | null): string {
  if (!localRealpath) return `${localBin} exists but its realpath could not be resolved`;
  if (!cliRealpath) return `${localBin} exists but active Proof-or-Stop could not be resolved for comparison`;
  return `${localBin} resolves to ${localRealpath}, active CLI ${cliEntrypoint ?? 'proof-or-stop'} resolves to ${cliRealpath}`;
}

function statusForDrift(severity: RuntimeFactSeverity): RuntimeFactStatus {
  return severity === 'hard' ? 'fail' : 'warn';
}

function summarize(results: RuntimeFactCheckResult[]): RuntimeEnvironmentReport['summary'] {
  const pass = results.filter((result) => result.status === 'pass').length;
  const warn = results.filter((result) => result.status === 'warn').length;
  const fail = results.filter((result) => result.status === 'fail').length;
  return {
    status: fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass',
    pass,
    warn,
    fail,
  };
}

function compactFactDetail(result: RuntimeFactCheckResult): string {
  if (result.outputKey === 'externalReferencePolicy') {
    const actual = result.actual as any;
    return `${actual?.externalReferenceCount ?? 0} external refs, connectivityChecked=false`;
  }
  if (result.outputKey === 'validateSource') {
    const actual = result.actual as any;
    return `source=${actual?.source ?? 'unknown'}`;
  }
  if (result.outputKey === 'cliEntrypoint') {
    const actual = result.actual as any;
    return String(actual?.realpath ?? actual?.path ?? 'missing');
  }
  if (result.outputKey === 'globalCoreRealpath') {
    const actual = result.actual as any;
    return String(actual?.realpath ?? 'missing');
  }
  if (result.outputKey === 'projectLocalBin') {
    const actual = result.actual as any;
    return actual?.present ? `present shadow=${actual.shadowsEntrypoint}` : 'absent';
  }
  if (result.outputKey === 'nodeVersion') return String(result.actual);
  if (result.outputKey === 'packageVersion') {
    const actual = result.actual as any;
    return String(actual?.runtime?.version ?? 'unknown');
  }
  return result.status;
}

function statusIcon(status: RuntimeFactStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  return '✗';
}
