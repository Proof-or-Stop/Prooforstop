import type { DispatchAuthorityState } from './lattice-dispatch.js';

// Env vars whose names match these patterns are considered sensitive and never recorded.
const SENSITIVE_ENV_PATTERNS = [
  /KEY$/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /PASSWD/i,
  /CREDENTIAL/i, /AUTH_/i, /PRIVATE/i, /CERT$/i,
];

// Only names starting with these prefixes are included in the safe-name summary.
const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_', 'TZ',
  'PWD', 'OLDPWD', 'NODE_', 'npm_', 'KOALA_', 'CI', 'GITHUB_',
  'RUNNER_', 'TMPDIR', 'TEMP', 'TMP', 'LOGNAME',
];

const MAX_SAFE_NAMES = 20;

export interface DispatchRunnerEnvSummary {
  totalVars: number;
  sensitiveFiltered: number;
  safeVarNames: string[];
  note: string;
}

export type RunnerKind = 'fake' | 'scaffolded' | 'refused' | 'claude-code-real';

export interface DispatchRunnerRecord {
  schemaVersion: 'lattice.dispatch_runner.v1';
  dispatchId: string;
  host: string;
  runnerKind: RunnerKind;
  commandTemplate: string[];
  invocation: string[];
  cwd: string;
  transcriptPath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  timedOut: boolean;
  envSummary: DispatchRunnerEnvSummary;
  refusalReasons: string[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(key));
}

function isSafeKey(key: string): boolean {
  if (isSensitiveKey(key)) return false;
  return SAFE_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function buildEnvSummary(env: Record<string, string | undefined> = process.env): DispatchRunnerEnvSummary {
  const allKeys = Object.keys(env);
  const sensitiveCount = allKeys.filter(isSensitiveKey).length;
  const safeVarNames = allKeys.filter(isSafeKey).sort().slice(0, MAX_SAFE_NAMES);
  return {
    totalVars: allKeys.length,
    sensitiveFiltered: sensitiveCount,
    safeVarNames,
    note: `${sensitiveCount} sensitive key(s) filtered; values never recorded.`,
  };
}

function authorityState(): DispatchAuthorityState {
  return { authorityChanged: false, receiptVerified: false, productionDone: false };
}

export function buildFakeRunnerRecord(opts: {
  dispatchId: string;
  host: string;
  commandTemplate: string[];
  cwd: string;
  transcriptPath: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  timedOut?: boolean;
  env?: Record<string, string | undefined>;
}): DispatchRunnerRecord {
  return {
    schemaVersion: 'lattice.dispatch_runner.v1',
    dispatchId: opts.dispatchId,
    host: opts.host,
    runnerKind: 'fake',
    commandTemplate: opts.commandTemplate,
    invocation: opts.commandTemplate,
    cwd: opts.cwd,
    transcriptPath: opts.transcriptPath,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    exitCode: opts.exitCode,
    timedOut: opts.timedOut ?? false,
    envSummary: buildEnvSummary(opts.env),
    refusalReasons: [],
    ...authorityState(),
  };
}

export function buildScaffoldedRunnerRecord(opts: {
  dispatchId: string;
  host: string;
  commandTemplate: string[];
  invocation: string[];
  cwd: string;
  transcriptPath: string;
  startedAt: string;
  endedAt: string;
}): DispatchRunnerRecord {
  return {
    schemaVersion: 'lattice.dispatch_runner.v1',
    dispatchId: opts.dispatchId,
    host: opts.host,
    runnerKind: 'scaffolded',
    commandTemplate: opts.commandTemplate,
    invocation: opts.invocation,
    cwd: opts.cwd,
    transcriptPath: opts.transcriptPath,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    timedOut: false,
    envSummary: buildEnvSummary(),
    refusalReasons: [
      'supervised-only: no external host process was launched; manual invocation required.',
    ],
    ...authorityState(),
  };
}

export function buildClaudeCodeRealRunnerRecord(opts: {
  dispatchId: string;
  host: string;
  commandTemplate: string[];
  invocation: string[];
  cwd: string;
  transcriptPath: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  timedOut: boolean;
  env: Record<string, string | undefined>;
}): DispatchRunnerRecord {
  return {
    schemaVersion: 'lattice.dispatch_runner.v1',
    dispatchId: opts.dispatchId,
    host: opts.host,
    runnerKind: 'claude-code-real',
    commandTemplate: opts.commandTemplate,
    invocation: opts.invocation,
    cwd: opts.cwd,
    transcriptPath: opts.transcriptPath,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    exitCode: opts.exitCode,
    timedOut: opts.timedOut,
    envSummary: buildEnvSummary(opts.env),
    refusalReasons: [],
    ...authorityState(),
  };
}

export function buildRefusedRunnerRecord(opts: {
  dispatchId: string;
  host: string;
  commandTemplate: string[];
  cwd: string;
  transcriptPath: string;
  refusalReasons: string[];
}): DispatchRunnerRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 'lattice.dispatch_runner.v1',
    dispatchId: opts.dispatchId,
    host: opts.host,
    runnerKind: 'refused',
    commandTemplate: opts.commandTemplate,
    invocation: [],
    cwd: opts.cwd,
    transcriptPath: opts.transcriptPath,
    startedAt: now,
    endedAt: now,
    timedOut: false,
    envSummary: buildEnvSummary(),
    refusalReasons: opts.refusalReasons,
    ...authorityState(),
  };
}
