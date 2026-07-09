import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export type CanonicalReviewHost = 'codex' | 'claude' | 'agy';

export type HostExecutionProgressMode =
  | 'jsonl'
  | 'stream-json'
  | 'bounded-final-output'
  | 'none';

export type HostLauncherSupport =
  | 'supported'
  | 'unsupported'
  | 'wrong_launcher'
  | 'unverified';

export type HostExecutionFailureKind =
  | 'none'
  | 'missing_executable'
  | 'version_failed'
  | 'wrong_launcher'
  | 'auth'
  | 'timeout'
  | 'silent_final_output'
  | 'unsupported'
  | 'unknown';

export interface HostExecutionLauncherSpec {
  host: CanonicalReviewHost;
  command: string;
  launcher: string;
  launcherArgv: string[];
  progressMode: HostExecutionProgressMode;
  observable: boolean;
  remediation: string;
}

export interface HostLauncherClassification {
  launcherSupport: HostLauncherSupport;
  launcherOk: boolean;
  progressMode: HostExecutionProgressMode;
  failureKind: HostExecutionFailureKind;
  remediation: string;
  reasons: string[];
}

export interface HostExecutionReadinessProbe {
  launcher: string;
  launcherArgv: string[];
  launcherSupport: HostLauncherSupport;
  launcherOk: boolean;
  executionReady: boolean;
  reviewReady: boolean;
  progressMode: HostExecutionProgressMode;
  failureKind: HostExecutionFailureKind;
  durationMs: number;
  firstProgressMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  diagnostic?: string;
  remediation: string;
}

export function canonicalReviewHostCommand(host: CanonicalReviewHost): string {
  return host;
}

export function canonicalReviewHostLauncherSpec(host: CanonicalReviewHost): HostExecutionLauncherSpec {
  if (host === 'claude') {
    return {
      host,
      command: 'claude',
      launcher: 'claude --print --verbose --output-format stream-json',
      launcherArgv: [
        'claude',
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--no-session-persistence',
        '--permission-mode',
        'bypassPermissions',
        '--max-budget-usd',
        '0.25',
        '<prompt>',
      ],
      progressMode: 'stream-json',
      observable: true,
      remediation: 'Use claude --print --verbose --output-format stream-json for long reviewer work.',
    };
  }
  if (host === 'agy') {
    return {
      host,
      command: 'agy',
      launcher: 'agy --print --print-timeout',
      launcherArgv: [
        'agy',
        '--print',
        '<prompt>',
        '--print-timeout',
        '30s',
        '--dangerously-skip-permissions',
      ],
      progressMode: 'bounded-final-output',
      observable: true,
      remediation: 'Use agy print mode with an explicit print timeout; agy --prompt-file is not a valid launcher.',
    };
  }
  return {
    host,
    command: 'codex',
    launcher: 'codex exec --json',
      launcherArgv: [
        'codex',
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-rules',
        '<prompt>',
      ],
    progressMode: 'jsonl',
    observable: true,
    remediation: 'Use codex exec in noninteractive mode; rerun after fixing Codex auth if exec reports an invalidated token.',
  };
}

function argvHas(argv: readonly string[], value: string): boolean {
  return argv.includes(value) || argv.some(part => part.startsWith(`${value}=`));
}

function outputFormatValue(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i] ?? '';
    if (part === '--output-format') return argv[i + 1] ?? '';
    if (part.startsWith('--output-format=')) return part.slice('--output-format='.length);
  }
  return '';
}

export function launcherArgvMatchesCanonical(host: CanonicalReviewHost, argv: readonly string[]): boolean {
  const expected = canonicalReviewHostLauncherSpec(host).launcherArgv;
  return expected.length === argv.length && expected.every((part, index) => part === argv[index]);
}

function launcherArgsForExecution(spec: HostExecutionLauncherSpec): string[] {
  const prompt = 'Reply READY and do not run tools.';
  return spec.launcherArgv
    .slice(1)
    .map(arg => arg === '<prompt>' ? prompt : arg);
}

export function classifyReviewHostLauncher(host: CanonicalReviewHost, argv: readonly string[]): HostLauncherClassification {
  const reasons: string[] = [];
  const spec = canonicalReviewHostLauncherSpec(host);
  let progressMode: HostExecutionProgressMode = 'none';
  let failureKind: HostExecutionFailureKind = 'none';
  let launcherSupport: HostLauncherSupport = 'supported';

  if (host === 'claude') {
    const hasPrint = argvHas(argv, '--print') || argvHas(argv, '-p');
    const hasVerbose = argvHas(argv, '--verbose');
    const hasStreamJson = outputFormatValue(argv) === 'stream-json';
    progressMode = hasStreamJson ? 'stream-json' : hasPrint ? 'bounded-final-output' : 'none';
    if (!hasPrint) reasons.push('claude launcher must use --print/-p for noninteractive reviewer work');
    if (!hasVerbose) reasons.push('claude stream-json launcher must include --verbose for observable progress');
    if (!hasStreamJson) reasons.push('claude reviewer launcher must use --output-format=stream-json');
    if (reasons.length > 0) {
      failureKind = hasPrint ? 'silent_final_output' : 'wrong_launcher';
      launcherSupport = hasPrint ? 'unsupported' : 'wrong_launcher';
    }
  } else if (host === 'agy') {
    const hasPrint = argvHas(argv, '--print') || argvHas(argv, '-p') || argvHas(argv, '--prompt');
    const hasTimeout = argvHas(argv, '--print-timeout') || argvHas(argv, '--timeout');
    progressMode = hasPrint && hasTimeout ? 'bounded-final-output' : 'none';
    if (argvHas(argv, '--prompt-file')) {
      reasons.push('agy --prompt-file is the wrong launcher; use print mode with an explicit timeout');
      failureKind = 'wrong_launcher';
      launcherSupport = 'wrong_launcher';
    }
    if (!hasPrint) reasons.push('agy launcher must use print mode for noninteractive reviewer work');
    if (!hasTimeout) reasons.push('agy launcher must include an explicit timeout');
    if (failureKind === 'none' && reasons.length > 0) {
      failureKind = 'wrong_launcher';
      launcherSupport = 'wrong_launcher';
    }
  } else {
    const hasExec = argv.includes('exec');
    const hasJson = argvHas(argv, '--json');
    progressMode = hasJson ? 'jsonl' : hasExec ? 'bounded-final-output' : 'none';
    if (argvHas(argv, '--prompt-file')) {
      reasons.push('codex exec does not use --prompt-file for the canonical reviewer launcher');
      failureKind = 'wrong_launcher';
      launcherSupport = 'wrong_launcher';
    }
    if (!hasExec) reasons.push('codex launcher must use exec for noninteractive reviewer work');
    if (!hasJson) reasons.push('codex exec launcher must use --json for observable events');
    if (failureKind === 'none' && reasons.length > 0) {
      failureKind = 'wrong_launcher';
      launcherSupport = 'wrong_launcher';
    }
  }

  if (!launcherArgvMatchesCanonical(host, argv)) {
    reasons.push(`launcherArgv must match canonical ${spec.launcher}`);
    if (launcherSupport === 'supported') launcherSupport = 'wrong_launcher';
    if (failureKind === 'none') failureKind = 'wrong_launcher';
  }

  return {
    launcherSupport,
    launcherOk: reasons.length === 0,
    progressMode,
    failureKind,
    remediation: reasons.length === 0 ? '' : spec.remediation,
    reasons,
  };
}

function boundedDiagnostic(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 240);
}

function outputText(result: SpawnSyncReturns<string>): string {
  return `${boundedDiagnostic(result.stderr)} ${boundedDiagnostic(result.stdout)}`.trim();
}

export function classifyHostExecutionFailure(
  result: Pick<SpawnSyncReturns<string>, 'error' | 'signal' | 'stderr' | 'stdout' | 'status'>,
  fallback: HostExecutionFailureKind = 'unknown',
): HostExecutionFailureKind {
  const text = `${boundedDiagnostic(result.stderr)} ${boundedDiagnostic(result.stdout)}`.trim().toLowerCase();
  if (result.error && /timed?out|etimedout/i.test(result.error.message)) return 'timeout';
  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') return 'timeout';
  if (/token_invalidated|refresh_token_invalidated|invalidated token|unauthori[sz]ed|authentication|auth required|not logged in|login required|please login|invalid api key|401/.test(text)) {
    return 'auth';
  }
  if (/flag provided but not defined|unknown flag|unknown option|unrecognized option|unexpected argument|invalid option|unknown command/.test(text)) {
    return 'wrong_launcher';
  }
  if (/timeout|timed out|deadline exceeded/.test(text)) return 'timeout';
  if (result.status !== 0) return fallback;
  return 'none';
}

function supportForFailure(failureKind: HostExecutionFailureKind): HostLauncherSupport {
  if (failureKind === 'none') return 'supported';
  if (failureKind === 'wrong_launcher') return 'wrong_launcher';
  if (failureKind === 'missing_executable' || failureKind === 'version_failed' || failureKind === 'auth' || failureKind === 'timeout') {
    return 'unverified';
  }
  return 'unsupported';
}

export function classifyHostExecutionReadiness(args: {
  host: CanonicalReviewHost;
  executablePath?: string;
  versionOk: boolean;
  durationMs: number;
  result?: Pick<SpawnSyncReturns<string>, 'error' | 'signal' | 'stderr' | 'stdout' | 'status'>;
  firstProgressMs?: number;
  exitCode?: number;
  timedOut?: boolean;
}): HostExecutionReadinessProbe {
  const spec = canonicalReviewHostLauncherSpec(args.host);
  const launcher = classifyReviewHostLauncher(args.host, spec.launcherArgv);
  const durationMs = Math.max(0, Math.floor(args.durationMs));

  if (!args.executablePath) {
    return {
      launcher: spec.launcher,
      launcherArgv: spec.launcherArgv,
      launcherSupport: 'unverified',
      launcherOk: launcher.launcherOk,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: 'missing_executable',
      durationMs,
      diagnostic: 'executable not found in PATH',
      remediation: `Install or expose ${spec.command} in PATH.`,
    };
  }
  if (!args.versionOk) {
    return {
      launcher: spec.launcher,
      launcherArgv: spec.launcherArgv,
      launcherSupport: 'unverified',
      launcherOk: launcher.launcherOk,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: 'version_failed',
      durationMs,
      diagnostic: 'version probe failed before launcher readiness could be confirmed',
      remediation: `Repair ${spec.command} installation until the CLI starts cleanly, then rerun review_host_availability_probe.`,
    };
  }
  if (!launcher.launcherOk) {
    return {
      launcher: spec.launcher,
      launcherArgv: spec.launcherArgv,
      launcherSupport: launcher.launcherSupport,
      launcherOk: false,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: launcher.failureKind,
      durationMs,
      diagnostic: launcher.reasons.join('; '),
      remediation: launcher.remediation,
    };
  }

  const failureKind = args.result ? classifyHostExecutionFailure(args.result) : 'none';
  const executionReady = failureKind === 'none';
  const launcherSupport = supportForFailure(failureKind);
  const reviewReady = executionReady && spec.observable;
  return {
    launcher: spec.launcher,
    launcherArgv: spec.launcherArgv,
    launcherSupport,
    launcherOk: launcherSupport === 'supported',
    executionReady,
    reviewReady,
    progressMode: launcher.progressMode,
    failureKind,
    durationMs,
    ...(args.firstProgressMs !== undefined ? { firstProgressMs: Math.max(0, Math.floor(args.firstProgressMs)) } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.timedOut ? { timedOut: true } : {}),
    ...(executionReady ? {} : { diagnostic: args.result ? outputText(args.result as SpawnSyncReturns<string>) || 'launcher readiness probe failed' : 'launcher readiness probe failed' }),
    remediation: executionReady ? '' : spec.remediation,
  };
}

export function probeHostExecutionReadiness(args: {
  host: CanonicalReviewHost;
  executablePath?: string;
  versionOk: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): HostExecutionReadinessProbe {
  const spec = canonicalReviewHostLauncherSpec(args.host);
  if (!args.executablePath || !args.versionOk) {
    return classifyHostExecutionReadiness({
      host: args.host,
      executablePath: args.executablePath,
      versionOk: args.versionOk,
      durationMs: 0,
    });
  }

  const started = Date.now();
  const result = spawnSync(args.executablePath, launcherArgsForExecution(spec), {
    cwd: args.cwd,
    env: args.env,
    encoding: 'utf8',
    timeout: args.timeoutMs,
    maxBuffer: 256 * 1024,
    input: '',
  });
  const durationMs = Math.max(0, Date.now() - started);
  const failureKind = classifyHostExecutionFailure(result);
  const timedOut = failureKind === 'timeout';
  const outputBytes = Buffer.byteLength(result.stdout || '', 'utf8') + Buffer.byteLength(result.stderr || '', 'utf8');
  return classifyHostExecutionReadiness({
    host: args.host,
    executablePath: args.executablePath,
    versionOk: args.versionOk,
    durationMs,
    result,
    ...(typeof result.status === 'number' ? { exitCode: result.status } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(outputBytes > 0 ? { firstProgressMs: durationMs } : {}),
  });
}
