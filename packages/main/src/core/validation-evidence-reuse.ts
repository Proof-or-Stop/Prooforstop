import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { classifyMergeLineage } from './validation-lineage.js';
import type { TestEvidenceData, VerificationCoverageReport } from './types.js';
import type {
  RoutineValidationCommandExecution,
  RoutineValidationIdentity,
  RoutineValidationIdentityCommand,
  RoutineValidationSourceKind,
  ValidationCommand,
  ValidationCommandResult,
} from './validation-types.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { resolveCommandTimeoutMs } from './validation-executor.js';

export type TrustedValidationLineage = 'exact-head' | 'trusted-story-metadata-descendant' | 'rejected';

export interface TrustedValidationLineageResult {
  lineage: TrustedValidationLineage;
  reasons: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validationIdentityDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function fileDigest(path: string): string | null {
  try {
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
  } catch {
    return null;
  }
}

export interface ValidationExecutableLookup {
  kind: 'explicit' | 'path-search';
  absolute: boolean;
  commandCandidates: string[];
}

/** Pure platform envelope: no filesystem reads, writes, callbacks, or env seams. */
export function buildValidationExecutableLookup(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ValidationExecutableLookup {
  const platformPath = platform === 'win32' ? win32 : posix;
  const explicitPath = platform === 'win32'
    ? command.includes('/') || command.includes('\\')
    : command.includes('/');
  const absolute = platformPath.isAbsolute(command);
  const base = explicitPath || absolute ? platformPath.normalize(command) : command;
  const commandCandidates = (() => {
    if (platform !== 'win32' || platformPath.extname(base)) return [base];
    const extensions = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean)
      .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
    return [base, ...extensions.map((extension) => `${base}${extension}`)];
  })();
  return {
    kind: explicitPath || absolute ? 'explicit' : 'path-search',
    absolute,
    commandCandidates,
  };
}

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const lookup = buildValidationExecutableLookup(command, env, platform);
  if (lookup.kind === 'explicit') {
    const candidates = lookup.commandCandidates.map((candidate) => {
      if (lookup.absolute || platform === process.platform) {
        return (platform === 'win32' ? win32 : posix).resolve(cwd, candidate);
      }
      // Platform-injected win32 tests map relative path segments into the host
      // temp cwd. Production win32 takes the native branch above.
      return resolve(cwd, ...win32.normalize(candidate).split(/[\\/]+/));
    });
    return candidates.find((path) => existsSync(path)) ?? null;
  }
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  for (const dir of String(env.PATH ?? '').split(pathDelimiter).filter(Boolean)) {
    const candidate = lookup.commandCandidates
      .map((name) => platform === process.platform ? (platform === 'win32' ? win32 : posix).join(dir, name) : join(dir, name))
      .find((path) => existsSync(path));
    if (candidate) return candidate;
  }
  return null;
}

/**
 * The one shell rule. `node:child_process` uses an implicit command shell on
 * Windows even when {@link ValidationCommand.shell} is false, so identity binds
 * the ACTUAL execution principal.
 *
 * B-a745 CHK-001 extracted this from {@link buildRoutineValidationIdentity} so
 * the stable command identity and the legacy pin resolver reuse it instead of
 * declaring a second rule that could drift. Extraction only: the behaviour of
 * `buildRoutineValidationIdentity` is unchanged.
 */
export function validationCommandUsesShell(
  command: Pick<ValidationCommand, 'shell'>,
  platform: NodeJS.Platform,
): boolean {
  return command.shell === true || platform === 'win32';
}

/**
 * The one cwd resolution rule: an absolute `cwd` is taken as-is, a relative one
 * resolves against the project root, and an absent one IS the project root.
 *
 * B-a745 CHK-001 extracted this from {@link buildRoutineValidationIdentity} for
 * the same reason as {@link validationCommandUsesShell}. Extraction only.
 */
export function resolveValidationCommandCwd(
  projectRoot: string,
  command: Pick<ValidationCommand, 'cwd'>,
): string {
  return command.cwd
    ? (isAbsolute(command.cwd) ? command.cwd : resolve(projectRoot, command.cwd))
    : projectRoot;
}

/**
 * The ONE per-command normalization. Everything that needs to compare two
 * validation commands as EXECUTABLES goes through this: the routine reuse
 * identity below, and (B-a745 CHK-002) the legacy pin resolver in
 * `core/validation-command-identity.ts`.
 *
 * B-a745 CHK-001/CHK-002 extracted it out of {@link buildRoutineValidationIdentity}
 * so a second copy of the cwd / shell / environment / executable rules can never
 * drift into existence. Extraction only: the object this returns, field for
 * field, is exactly what the identity used to build inline, so
 * `buildRoutineValidationIdentity`'s digest is unchanged.
 */
export function normalizeRoutineValidationCommand(args: {
  projectRoot: string;
  command: ValidationCommand;
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): RoutineValidationIdentityCommand {
  const processEnvironment = args.processEnvironment ?? process.env;
  const platform = args.platform ?? process.platform;
  const command = args.command;
  const cwd = resolveValidationCommandCwd(args.projectRoot, command);
  const effectiveEnvironment = effectiveValidationCommandEnvironment(processEnvironment, command.env, cwd, platform);
  // node:child_process uses an implicit command shell on Windows even when
  // ValidationCommand.shell is false. Bind identity to that actual execution
  // principal (ComSpec/cmd.exe), not to a command that spawn never executes
  // directly.
  const usesShell = validationCommandUsesShell(command, platform);
  const shellExecutableCommand = usesShell
    ? platform === 'win32'
      ? String(effectiveEnvironment.ComSpec ?? effectiveEnvironment.COMSPEC ?? 'cmd.exe')
      : '/bin/sh'
    : null;
  const executable = resolveExecutable(command.command, cwd, effectiveEnvironment, platform);
  const shellExecutable = shellExecutableCommand
    ? resolveExecutable(shellExecutableCommand, cwd, effectiveEnvironment, platform)
    : null;
  return {
    label: command.label,
    command: command.command,
    args: [...command.args],
    cwd,
    shell: usesShell,
    timeoutMs: resolveCommandTimeoutMs(command),
    optional: command.optional === true,
    focus: [...(command.focus ?? [])],
    effectiveEnvironmentDigest: validationIdentityDigest(effectiveEnvironment),
    executableDigest: executable ? fileDigest(executable) : null,
    shellExecutableDigest: shellExecutable ? fileDigest(shellExecutable) : null,
  };
}

export function buildRoutineValidationIdentity(args: {
  projectRoot: string;
  sourceKind: RoutineValidationSourceKind;
  sourceInputs: unknown;
  entrypointPath?: string;
  commands: ValidationCommand[];
  full?: boolean | string;
  focus?: string;
  profile: string;
  verificationPolicyInputs: unknown;
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): RoutineValidationIdentity {
  const processEnvironment = args.processEnvironment ?? process.env;
  const platform = args.platform ?? process.platform;
  const commands = args.commands.map((command) => normalizeRoutineValidationCommand({
    projectRoot: args.projectRoot,
    command,
    processEnvironment,
    platform,
  }));
  const unsigned = {
    schema: 'proofOrStop.routine-validation-identity' as const,
    version: 1 as const,
    source: {
      kind: args.sourceKind,
      inputDigest: validationIdentityDigest(args.sourceInputs),
      entrypointDigest: args.entrypointPath ? fileDigest(args.entrypointPath) : null,
    },
    commands,
    invocation: {
      full: args.full ?? null,
      focus: args.focus ?? null,
      profile: args.profile,
    },
    verificationPolicyDigest: validationIdentityDigest(args.verificationPolicyInputs),
    runtime: {
      platform,
      arch: process.arch,
      node: process.version,
    },
  };
  return { ...unsigned, digest: validationIdentityDigest(unsigned) };
}

export function isCompleteRoutineValidationIdentity(value: unknown): value is RoutineValidationIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as RoutineValidationIdentity;
  if (identity.schema !== 'proofOrStop.routine-validation-identity' || identity.version !== 1) return false;
  if (!identity.source || !['configured', 'fallback', 'validate-file', 'no-validator'].includes(identity.source.kind)) return false;
  if (!Array.isArray(identity.commands) || !identity.invocation || !identity.runtime) return false;
  if (typeof identity.source.inputDigest !== 'string' || identity.source.inputDigest.length !== 64) return false;
  if (identity.source.entrypointDigest !== null && (typeof identity.source.entrypointDigest !== 'string' || identity.source.entrypointDigest.length !== 64)) return false;
  if (typeof identity.verificationPolicyDigest !== 'string' || identity.verificationPolicyDigest.length !== 64) return false;
  if (typeof identity.runtime.platform !== 'string' || typeof identity.runtime.arch !== 'string' || typeof identity.runtime.node !== 'string') return false;
  if (identity.commands.some((command) => (
    !command || typeof command.label !== 'string' || typeof command.command !== 'string'
    || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string')
    || typeof command.cwd !== 'string' || typeof command.shell !== 'boolean'
    || typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0
    || typeof command.optional !== 'boolean' || !Array.isArray(command.focus)
    || typeof command.effectiveEnvironmentDigest !== 'string' || command.effectiveEnvironmentDigest.length !== 64
    || (command.executableDigest !== null && (typeof command.executableDigest !== 'string' || command.executableDigest.length !== 64))
    || (command.shellExecutableDigest !== undefined
      && command.shellExecutableDigest !== null
      && (typeof command.shellExecutableDigest !== 'string' || command.shellExecutableDigest.length !== 64))
  ))) return false;
  const { digest, ...unsigned } = identity;
  return typeof digest === 'string' && digest.length === 64 && validationIdentityDigest(unsigned) === digest;
}

/**
 * B-7dff F-003: `concurrentPollutionBlocking` carries the plan-level dirty
 * verdict that no single command owns (see
 * ValidationResult.concurrentWorktreePollution). Per-command records are now
 * only ever written when the attribution is exclusive, so without this the
 * ambiguous case would be invisible to this summary — the summary would report
 * PASS on a run `executeValidationPlan` already failed. It is counted as one
 * required failure, exactly as a per-command blocking record is.
 */
export function summarizeRoutineCommandExecution(
  results: ValidationCommandResult[],
  expectedCommandCount: number,
  options: { semanticPass?: boolean; concurrentPollutionBlocking?: boolean } = {},
): RoutineValidationCommandExecution {
  const concurrentPollutionFailure = options.concurrentPollutionBlocking === true;
  const requiredFailures = results.filter((result) => (
    result.worktreePollution?.blocking === true
    || (!result.optional && (result.code !== 0 || result.timedOut))
  ));
  const optionalFailures = results.filter((result) => (
    result.worktreePollution?.blocking !== true
    && result.optional
    && (result.code !== 0 || result.timedOut)
  ));
  const semanticFailure = options.semanticPass === false;
  const requiredFailureCount = requiredFailures.length + (concurrentPollutionFailure ? 1 : 0);
  const failureKind = requiredFailures.some((result) => result.failureKind === 'infra_failure' || result.timedOut)
    ? 'infra_failure'
    : requiredFailureCount > 0 || semanticFailure ? 'validation_failure' : undefined;
  return {
    schema: 'proofOrStop.routine-validation-command-execution',
    version: 1,
    status: requiredFailureCount === 0 && !semanticFailure ? 'PASS' : 'FAIL',
    complete: results.length === expectedCommandCount,
    commandCount: results.length,
    requiredFailureCount: requiredFailureCount + (semanticFailure && requiredFailureCount === 0 ? 1 : 0),
    optionalFailureCount: optionalFailures.length,
    ...(failureKind ? { failureKind } : {}),
  };
}

export function isReusableCommandPass(
  value: unknown,
  expectedCommandCount: number,
): value is RoutineValidationCommandExecution {
  if (!value || typeof value !== 'object') return false;
  const execution = value as RoutineValidationCommandExecution;
  return execution.schema === 'proofOrStop.routine-validation-command-execution'
    && execution.version === 1
    && execution.status === 'PASS'
    && execution.complete === true
    && Number.isInteger(execution.commandCount)
    && execution.commandCount === expectedCommandCount
    && Number.isInteger(execution.requiredFailureCount)
    && execution.requiredFailureCount === 0
    && Number.isInteger(execution.optionalFailureCount)
    && execution.optionalFailureCount === 0
    && execution.failureKind === undefined;
}

export function classifyTrustedValidationLineage(args: {
  root: string;
  gitCwd: string;
  evidenceHead?: string;
  currentHead?: string;
}): TrustedValidationLineageResult {
  if (!args.evidenceHead || !args.currentHead) return { lineage: 'rejected', reasons: ['missing-head-lineage'] };
  const classification = classifyMergeLineage({
    evidenceHead: args.evidenceHead,
    currentHead: args.currentHead,
    gitCwd: args.gitCwd,
    metadataRoot: args.root,
  });
  switch (classification.kind) {
    case 'exact-head':
      return { lineage: 'exact-head', reasons: [] };
    case 'trusted-descendant':
      // An empty net diff (byte-identical endpoint trees) is trusted: the
      // validation ran against identical content. A merge that re-touches a
      // content-unchanged file no longer surfaces here.
      return { lineage: 'trusted-story-metadata-descendant', reasons: [] };
    case 'untrusted':
      return { lineage: 'rejected', reasons: classification.untrustedPaths.map((path) => `untrusted-lineage-path:${path}`) };
    case 'not-ancestor':
      return { lineage: 'rejected', reasons: ['evidence-head-is-not-current-ancestor'] };
    case 'diff-failed':
      return { lineage: 'rejected', reasons: [`lineage-diff-failed:${classification.error}`] };
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

export interface RoutineValidationReuseEvaluation {
  reusable: boolean;
  lineage: TrustedValidationLineage;
  existingEvidenceBasis: 'fresh' | 'stale' | 'missing';
  refusalReasons: string[];
}

export function evaluateRoutineValidationReuse(args: {
  root: string;
  gitCwd: string;
  evidence: TestEvidenceData | null;
  currentIdentity: RoutineValidationIdentity;
  currentCoverage: VerificationCoverageReport;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
  clean: boolean;
  headBefore?: string;
  headAfter?: string;
  /** Trusted caller has authenticated the PASS and verified its current dynamic
   * manifest, command receipts and revocation ledger. This replaces only the
   * expected full-plan count, never execution PASS/failure/completeness checks. */
  dynamicCoverageAdmitted?: boolean;
}): RoutineValidationReuseEvaluation {
  if (!args.evidence) return { reusable: false, lineage: 'rejected', existingEvidenceBasis: 'missing', refusalReasons: ['evidence-missing'] };
  const reasons: string[] = [];
  const evidence = args.evidence;
  const expectedCount = args.dynamicCoverageAdmitted === true && evidence.result === 'PASS'
    ? evidence.commandExecution?.commandCount : args.currentIdentity.commands.length;
  if (typeof expectedCount !== 'number' || (args.dynamicCoverageAdmitted === true && expectedCount < 1)
    || !isReusableCommandPass(evidence.commandExecution, expectedCount)) reasons.push('prior-command-execution-not-pass');
  const priorCoverageOnlyFailure = evidence.result === 'FAIL'
    && evidence.verificationCoverage !== undefined
    && Number.isInteger(evidence.verificationCoverage.missingRequired)
    && evidence.verificationCoverage.missingRequired > 0;
  if (evidence.result !== 'PASS' && !priorCoverageOnlyFailure) {
    reasons.push('prior-overall-result-not-reusable');
  }
  if (!isCompleteRoutineValidationIdentity(evidence.routineValidationIdentity)) reasons.push('identity-missing-malformed-or-legacy');
  else if (evidence.routineValidationIdentity.digest !== args.currentIdentity.digest) reasons.push('validation-identity-changed');
  if (args.currentCoverage.missingRequired !== 0) reasons.push('current-verification-coverage-incomplete');
  if (!args.clean) reasons.push('worktree-dirty');
  if (!evidence.materialHash || !args.currentMaterialHash || evidence.materialHash !== args.currentMaterialHash) reasons.push('material-hash-changed-or-missing');
  if (!evidence.storyFilesHash || !args.currentStoryFilesHash || evidence.storyFilesHash !== args.currentStoryFilesHash) reasons.push('story-files-hash-changed-or-missing');
  const lineageResult = classifyTrustedValidationLineage({
    root: args.root,
    gitCwd: args.gitCwd,
    evidenceHead: evidence.headHash,
    currentHead: args.headBefore,
  });
  reasons.push(...lineageResult.reasons);
  if (!args.headBefore || args.headAfter !== args.headBefore) reasons.push('head-changed-during-reuse-evaluation');
  const refusalReasons = [...new Set(reasons)];
  return {
    reusable: refusalReasons.length === 0 && lineageResult.lineage !== 'rejected',
    lineage: refusalReasons.length === 0 ? lineageResult.lineage : 'rejected',
    existingEvidenceBasis: refusalReasons.length === 0 ? 'fresh' : 'stale',
    refusalReasons,
  };
}
