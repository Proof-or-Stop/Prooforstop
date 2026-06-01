import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  RUNTIME_FACT_REGISTRY,
  type RuntimeFactId,
  type RuntimeFactOutputKey,
  type RuntimeFactRegistryEntry,
  type RuntimeFactScope,
  type RuntimeFactSeverity,
} from './runtime-fact-registry.js';

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

interface ExternalReference {
  file: string;
  value: string;
  line: number;
  healthSemantics: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIN_NODE_MAJOR = 20;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const HOST_PORT_RE = /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}:\d{2,5}\b/g;
const LOCAL_HOST_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i;
const HEALTH_SEMANTICS_RE = /\b(health\s*check|healthcheck|health\s*command|doctor|ping|readiness|liveness)\b|健康检查|健康命令/i;
const RUNTIME_MODE_AUTHORITY: RuntimeModeAuthority = 'local-runtime-diagnostic-only';

export function runRuntimeEnvironmentChecks(
  projectRoot: string,
  options: RuntimeEnvironmentOptions = {},
): RuntimeEnvironmentReport {
  const resolvedRoot = resolve(projectRoot);
  const corePackageRoot = options.corePackageRoot ? resolve(options.corePackageRoot) : currentCorePackageRoot();
  const cliEntrypoint = (options.commandResolver ?? resolveKoalaCommandPath)(resolvedRoot);
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

function checkCliEntrypoint(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'details' | 'warnings'> {
  const commandPath = context.cliEntrypoint;
  if (!commandPath) {
    return {
      status: statusForDrift(severity),
      actual: null,
      expected: context.isSelfProject ? join(expectedSelfCoreRoot(context), 'dist', 'cli.js') : 'koala executable on PATH',
      warnings: ['`command -v koala` did not resolve a CLI executable'],
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
    ...(status === 'pass' ? {} : { warnings: [`koala resolves to ${commandRealpath ?? commandPath}, expected ${expectedCli}`] }),
  };
}

function checkGlobalCoreRealpath(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const globalRoot = context.globalNpmRoot;
  const globalPackagePath = globalRoot ? join(globalRoot, '@koala-agent', 'core') : null;
  const globalRealpath = globalPackagePath && existsSync(globalPackagePath) ? safeRealpath(globalPackagePath) : null;
  const expected = context.isSelfProject ? expectedSelfCoreRoot(context) : context.corePackageRoot;
  if (!globalPackagePath || !globalRealpath) {
    return {
      status: statusForDrift(severity),
      actual: { npmRoot: globalRoot, packagePath: globalPackagePath, realpath: null },
      expected,
      warnings: ['global @koala-agent/core could not be resolved from `npm root -g`'],
    };
  }
  const status = samePath(globalRealpath, expected) ? 'pass' : statusForDrift(severity);
  return {
    status,
    actual: { npmRoot: globalRoot, packagePath: globalPackagePath, realpath: globalRealpath },
    expected,
    ...(status === 'pass' ? {} : { warnings: [`global @koala-agent/core resolves to ${globalRealpath}, expected ${expected}`] }),
  };
}

function checkProjectLocalBin(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const localBin = join(context.projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'koala.cmd' : 'koala');
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
    expected: 'project-local koala should be absent or resolve to the active CLI entrypoint',
    ...(shadowsEntrypoint ? { warnings: [localBinWarning(localBin, localRealpath, cliRealpath, context.activeCliEntrypoint ?? context.cliEntrypoint)] } : {}),
  };
}

function classifyRuntimeMode(context: RuntimeCheckContext): RuntimeModeContract {
  if (isPackagedRuntime()) {
    return runtimeModeContract(
      'packaged-runtime',
      'packaged-runtime',
      'packaged runtime detected; project package.json/node_modules are not required for Koala diagnostics',
    );
  }

  const active = runtimeEntrypointRealpath(context);
  const localBin = projectLocalBinPath(context.projectRoot);
  const localBinPresent = existsSync(localBin);
  const localBinRealpath = localBinPresent ? safeRealpath(localBin) : null;

  if (!active.realpath) {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      'active Koala CLI entrypoint could not be resolved; runtime classification is diagnostic-only',
    );
  }

  if (localBinPresent && localBinRealpath) {
    if (samePath(localBinRealpath, active.realpath)) {
      return runtimeModeContract(
        'project-local-package',
        'project-node-modules',
        'active Koala CLI is the project-local node_modules/.bin/koala package',
        true,
      );
    }
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `project-local node_modules/.bin/koala resolves to ${localBinRealpath}, but the active CLI resolves to ${active.realpath}`,
    );
  }
  if (localBinPresent && !localBinRealpath) {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `project-local node_modules/.bin/koala exists at ${localBin}, but its realpath could not be resolved`,
    );
  }

  const source = runtimeModeSource(context, active.realpath);
  if (source === 'unknown') {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `active Koala CLI ${active.realpath} does not match a known runtime source`,
    );
  }

  if (source === 'global-cli' && !compatibilityLauncherSignal(active.path)) {
    return runtimeModeContract(
      'global-cli',
      'global-cli',
      'active Koala CLI resolves to the global installation; project package.json/node_modules are not required',
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
  const projectNodeModulesCore = join(context.projectRoot, 'node_modules', '@koala-agent', 'core');
  const globalCoreRoot = context.globalNpmRoot ? join(context.globalNpmRoot, '@koala-agent', 'core') : null;

  if (pathContains(selfDistRoot, activeRealpath) || samePath(context.corePackageRoot, join(context.projectRoot, 'packages', 'main'))) {
    return 'repo-local-dist';
  }
  if (pathContains(projectNodeModulesCore, activeRealpath) || pathContains(projectNodeModulesCore, context.corePackageRoot)) {
    return 'project-node-modules';
  }
  if (globalCoreRoot && (pathContains(globalCoreRoot, activeRealpath) || pathContains(globalCoreRoot, context.corePackageRoot))) {
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
      return 'compatibility launcher is using the repository-local Koala dist runtime; run npm --prefix packages/main run build after core edits';
    case 'project-node-modules':
      return 'compatibility launcher is using the project node_modules Koala package without requiring node_modules/.bin/koala as the active CLI';
    case 'packaged-runtime':
      return 'compatibility launcher is using a packaged Koala runtime; project package.json/node_modules are not required';
    case 'external-development-engine':
      return 'compatibility launcher is using an external Koala development engine; project package.json/node_modules are not required';
    case 'global-cli':
      return 'compatibility launcher is using the global Koala CLI fallback; project package.json/node_modules are not required';
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
  const globalPackagePath = context.globalNpmRoot ? join(context.globalNpmRoot, '@koala-agent', 'core') : null;
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
    ...(ok ? {} : { warnings: ['Koala package versions are missing or inconsistent'] }),
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
  if (existsSync(join(projectRoot, 'Package.swift'))) labels.push('swift test');
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
  const files = ['koala.config.json', 'AGENTS.md', 'CLAUDE.md', 'README.md'].filter((relPath) => existsSync(join(projectRoot, relPath)));
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

function resolveKoalaCommandPath(projectRoot: string): string | null {
  const out = process.platform === 'win32'
    ? runCommand('where', ['koala'], projectRoot)
    : runCommand('sh', ['-lc', 'command -v koala'], projectRoot);
  return out?.split(/\r?\n/).find(Boolean) ?? null;
}

function resolveGlobalNpmRoot(projectRoot: string): string | null {
  return runCommand('npm', ['root', '-g'], projectRoot);
}

function resolveActiveCliEntrypoint(projectRoot: string, corePackageRoot: string, fallbackEntrypoint: string | null): string | null {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
  if (invoked && looksLikeKoalaEntrypoint(invoked, projectRoot, corePackageRoot)) return invoked;
  return fallbackEntrypoint;
}

function looksLikeKoalaEntrypoint(path: string, projectRoot: string, corePackageRoot: string): boolean {
  const real = safeRealpath(path) ?? path;
  const name = basename(path);
  if (name === 'koala' || name === 'koala.cmd' || name === 'koala.js' || name === 'koala-codex.js') return true;
  if ((name === 'cli.js' || name === 'cli-engine.js') && pathContains(corePackageRoot, real)) return true;
  if (samePath(real, join(projectRoot, 'bin', 'koala.js'))) return true;
  if (samePath(real, join(projectRoot, 'bin', 'koala-codex.js'))) return true;
  return false;
}

function currentCorePackageRoot(): string {
  return resolve(__dirname, '..', '..');
}

function detectSelfProject(projectRoot: string): boolean {
  const rootPackage = readPackageJson(projectRoot);
  const corePackage = readPackageJson(join(projectRoot, 'packages', 'main'));
  return rootPackage?.name === 'koala' && corePackage?.name === '@koala-agent/core';
}

function resolveCanonicalSelfCoreRoot(projectRoot: string): string | null {
  const raw = runCommand('git', ['worktree', 'list', '--porcelain'], projectRoot);
  if (!raw) {
    const localCore = join(projectRoot, 'packages', 'main');
    return existsSync(localCore) ? safeRealpath(localCore) : null;
  }
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
  const localCore = join(projectRoot, 'packages', 'main');
  return existsSync(localCore) ? safeRealpath(localCore) ?? resolve(localCore) : null;
}

function expectedSelfCoreRoot(context: RuntimeCheckContext): string {
  return context.canonicalSelfCoreRoot ?? join(context.projectRoot, 'packages', 'main');
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
  return join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'koala.cmd' : 'koala');
}

function isPackagedRuntime(): boolean {
  return process.env.KOALA_DESKTOP_PACKAGED_RUNTIME === '1'
    || Boolean((process as typeof process & { pkg?: unknown }).pkg);
}

function compatibilityLauncherSignal(activePath: string | null): boolean {
  if (process.env.KOALA_ACTIVITY_SOURCE === 'codex') return true;
  if (process.env.KOALA_CODEX_ENTRYPOINT === 'global-fallback' || process.env.KOALA_CODEX_ENTRYPOINT === 'local-wrapper') return true;
  const name = activePath ? basename(activePath) : '';
  return name === 'koala.js' || name === 'koala-codex.js';
}

function localBinWarning(localBin: string, localRealpath: string | null, cliRealpath: string | null, cliEntrypoint: string | null): string {
  if (!localRealpath) return `${localBin} exists but its realpath could not be resolved`;
  if (!cliRealpath) return `${localBin} exists but active koala CLI could not be resolved for comparison`;
  return `${localBin} resolves to ${localRealpath}, active CLI ${cliEntrypoint ?? 'koala'} resolves to ${cliRealpath}`;
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
