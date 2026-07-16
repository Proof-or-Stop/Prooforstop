import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { isStoryMetadataPath } from './evidence-freshness.js';
import type { TestEvidenceData, VerificationCoverageReport } from './types.js';
import type {
  RoutineValidationCommandExecution,
  RoutineValidationIdentity,
  RoutineValidationSourceKind,
  ValidationCommand,
  ValidationCommandResult,
} from './validation-types.js';
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

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command) || command.includes('/')) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command);
    return existsSync(candidate) ? candidate : null;
  }
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizedEffectiveEnvironment(
  processEnvironment: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
): Record<string, string> {
  const effective: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value !== undefined) effective[key] = value;
  }
  if (overlay) Object.assign(effective, overlay);
  return effective;
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
}): RoutineValidationIdentity {
  const processEnvironment = args.processEnvironment ?? process.env;
  const commands = args.commands.map((command) => {
    const cwd = command.cwd
      ? (isAbsolute(command.cwd) ? command.cwd : resolve(args.projectRoot, command.cwd))
      : args.projectRoot;
    const effectiveEnvironment = normalizedEffectiveEnvironment(processEnvironment, command.env);
    const executable = resolveExecutable(command.command, cwd, effectiveEnvironment);
    return {
      label: command.label,
      command: command.command,
      args: [...command.args],
      cwd,
      shell: command.shell === true,
      timeoutMs: resolveCommandTimeoutMs(command),
      optional: command.optional === true,
      focus: [...(command.focus ?? [])],
      effectiveEnvironmentDigest: validationIdentityDigest(effectiveEnvironment),
      executableDigest: executable ? fileDigest(executable) : null,
    };
  });
  const unsigned = {
    schema: 'lattice.routine-validation-identity' as const,
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
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
  };
  return { ...unsigned, digest: validationIdentityDigest(unsigned) };
}

export function isCompleteRoutineValidationIdentity(value: unknown): value is RoutineValidationIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as RoutineValidationIdentity;
  if (identity.schema !== 'lattice.routine-validation-identity' || identity.version !== 1) return false;
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
  ))) return false;
  const { digest, ...unsigned } = identity;
  return typeof digest === 'string' && digest.length === 64 && validationIdentityDigest(unsigned) === digest;
}

export function summarizeRoutineCommandExecution(
  results: ValidationCommandResult[],
  expectedCommandCount: number,
  options: { semanticPass?: boolean } = {},
): RoutineValidationCommandExecution {
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
  const failureKind = requiredFailures.some((result) => result.failureKind === 'infra_failure' || result.timedOut)
    ? 'infra_failure'
    : requiredFailures.length > 0 || semanticFailure ? 'validation_failure' : undefined;
  return {
    schema: 'lattice.routine-validation-command-execution',
    version: 1,
    status: requiredFailures.length === 0 && !semanticFailure ? 'PASS' : 'FAIL',
    complete: results.length === expectedCommandCount,
    commandCount: results.length,
    requiredFailureCount: requiredFailures.length + (semanticFailure && requiredFailures.length === 0 ? 1 : 0),
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
  return execution.schema === 'lattice.routine-validation-command-execution'
    && execution.version === 1
    && execution.status === 'PASS'
    && execution.complete === true
    && Number.isInteger(execution.commandCount)
    && execution.commandCount === expectedCommandCount
    && Number.isInteger(execution.requiredFailureCount)
    && execution.requiredFailureCount === 0
    && Number.isInteger(execution.optionalFailureCount)
    && execution.optionalFailureCount >= 0
    && execution.optionalFailureCount <= execution.commandCount
    && execution.failureKind === undefined;
}

export function classifyTrustedValidationLineage(args: {
  root: string;
  gitCwd: string;
  evidenceHead?: string;
  currentHead?: string;
}): TrustedValidationLineageResult {
  const reasons: string[] = [];
  if (!args.evidenceHead || !args.currentHead) return { lineage: 'rejected', reasons: ['missing-head-lineage'] };
  if (args.evidenceHead === args.currentHead) return { lineage: 'exact-head', reasons };
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', args.evidenceHead, args.currentHead], {
      cwd: args.gitCwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const commits = execFileSync('git', ['rev-list', '--reverse', `${args.evidenceHead}..${args.currentHead}`], {
      cwd: args.gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map((commit) => commit.trim()).filter(Boolean);
    const changed = [...new Set(commits.flatMap((commit) => execFileSync(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', commit],
      { cwd: args.gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).split('\n').map((path) => path.trim()).filter(Boolean)))];
    const untrusted = changed.filter((path) => !isStoryMetadataPath(path, args.root));
    if (changed.length === 0) reasons.push('empty-descendant-lineage');
    if (untrusted.length > 0) reasons.push(...untrusted.map((path) => `untrusted-lineage-path:${path}`));
    return reasons.length === 0
      ? { lineage: 'trusted-story-metadata-descendant', reasons: [] }
      : { lineage: 'rejected', reasons };
  } catch {
    return { lineage: 'rejected', reasons: ['evidence-head-is-not-current-ancestor'] };
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
}): RoutineValidationReuseEvaluation {
  if (!args.evidence) return { reusable: false, lineage: 'rejected', existingEvidenceBasis: 'missing', refusalReasons: ['evidence-missing'] };
  const reasons: string[] = [];
  const evidence = args.evidence;
  if (!isReusableCommandPass(evidence.commandExecution, args.currentIdentity.commands.length)) reasons.push('prior-command-execution-not-pass');
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
