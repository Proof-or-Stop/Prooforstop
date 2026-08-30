import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
  | 'interactive'
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
  outputBytes?: number;
  diagnostic?: string;
  remediation: string;
}

const HOST_EXECUTION_READINESS_PROMPT = 'Reply READY and do not run tools.';
const HOST_EXECUTION_READINESS_PROMPT_MAX_CHARS = 128;

export function canonicalReviewHostCommand(host: CanonicalReviewHost): string {
  return host;
}

export function canonicalReviewHostLauncherSpec(host: CanonicalReviewHost): HostExecutionLauncherSpec {
  if (host === 'claude') {
    return {
      host,
      command: 'claude',
      launcher: 'claude --print --verbose --output-format=stream-json',
      launcherArgv: [
        'claude',
        '--print',
        '--verbose',
        '--output-format=stream-json',
        '<prompt-file>',
      ],
      progressMode: 'stream-json',
      observable: true,
      remediation: 'Use claude --print --verbose --output-format=stream-json for long reviewer work.',
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

/**
 * A canonical duration slot (e.g. the agy `--print-timeout` value) is `30s` in
 * the probe default but must accept any `\d+[smh]` value so a caller (host_run,
 * B-70e9) can parameterize the bound. Only the literal `30s` slot is relaxed; all
 * other fixed argv tokens still require an EXACT match.
 */
const CANONICAL_DURATION_SLOT = '30s';
const CANONICAL_DURATION_VALUE = /^\d+[smh]$/;

function launcherArgvPartMatchesCanonical(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  if (expected === '<prompt>') {
    if (actual === '<prompt>') return true;
    return actual.trim().length > 0 && actual !== '<prompt-file>' && !isAbsolute(actual);
  }
  if (expected === '<prompt-file>') {
    if (actual === '<prompt-file>') return true;
    return actual.trim().length > 0 && actual !== '<prompt>' && isAbsolute(actual);
  }
  // B-70e9: the print-timeout duration slot accepts any \d+[smh] value (probe
  // default 30s still matches) so the canonical launcher can carry a caller bound.
  if (expected === CANONICAL_DURATION_SLOT) {
    return CANONICAL_DURATION_VALUE.test(actual);
  }
  return expected === actual;
}

export function launcherArgvHasPromptPlaceholder(argv: readonly string[]): boolean {
  return argv.includes('<prompt>') || argv.includes('<prompt-file>');
}

export function launcherArgvMatchesCanonical(host: CanonicalReviewHost, argv: readonly string[]): boolean {
  const expected = canonicalReviewHostLauncherSpec(host).launcherArgv;
  return expected.length === argv.length && expected.every((part, index) => launcherArgvPartMatchesCanonical(part, argv[index]));
}

function boundedReadinessPrompt(): string {
  return HOST_EXECUTION_READINESS_PROMPT.slice(0, HOST_EXECUTION_READINESS_PROMPT_MAX_CHARS);
}

function launcherExecutionPlan(spec: HostExecutionLauncherSpec): {
  observedLauncherArgv: string[];
  spawnArgv: string[];
  cleanup: () => void;
} {
  const prompt = boundedReadinessPrompt();
  let promptFile: string | undefined;
  let promptDir: string | undefined;
  const observedLauncherArgv = spec.launcherArgv.map(arg => {
    if (arg === '<prompt>') return prompt;
    if (arg === '<prompt-file>') {
      if (!promptFile) {
        promptDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-host-readiness-'));
        promptFile = join(promptDir, 'prompt.txt');
        writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
      }
      return promptFile;
    }
    return arg;
  });
  return {
    observedLauncherArgv,
    spawnArgv: observedLauncherArgv.slice(1),
    cleanup: () => {
      if (promptDir) rmSync(promptDir, { recursive: true, force: true });
    },
  };
}

/**
 * B-70e9: materialize a canonical launcher argv for a REAL run (not the bounded
 * readiness probe). Substitutes the `<prompt>` slot (codex, agy: inline prompt
 * text) and the `<prompt-file>` slot (claude: an absolute prompt-file path the
 * caller wrote) 1:1, and — for the agy `--print-timeout` duration slot — replaces
 * the canonical `30s` value with `agyPrintTimeout` when it is a valid `\d+[smh]`
 * duration (otherwise the canonical value is kept). The returned argv INCLUDES the
 * leading command token (argv[0]); callers spawn `argv[0]` with `argv.slice(1)`.
 *
 * PURE: builds no temp file and touches no fs. The claude prompt file is the
 * caller's responsibility (write mode-0600, clean up after the run). Throws when a
 * required substitution value is missing so a half-substituted argv never spawns.
 */
export function materializeLauncherArgv(
  spec: HostExecutionLauncherSpec,
  opts: { prompt?: string; promptFile?: string; agyPrintTimeout?: string },
): string[] {
  const source = spec.launcherArgv;
  // The duration-slot index is read from the ORIGINAL spec argv so a prompt token
  // that happens to equal '--print-timeout' can never shift the replacement target
  // (placeholder substitution is strictly 1:1, so indices are stable).
  const durationFlagIndex = source.indexOf('--print-timeout');
  const out = source.map(arg => {
    if (arg === '<prompt>') {
      if (typeof opts.prompt !== 'string') {
        throw new Error(`materializeLauncherArgv: ${spec.host} launcher needs an inline <prompt> value`);
      }
      return opts.prompt;
    }
    if (arg === '<prompt-file>') {
      if (!opts.promptFile || opts.promptFile.trim().length === 0) {
        throw new Error(`materializeLauncherArgv: ${spec.host} launcher needs a <prompt-file> path`);
      }
      return opts.promptFile;
    }
    return arg;
  });
  if (
    durationFlagIndex >= 0 &&
    durationFlagIndex + 1 < out.length &&
    typeof opts.agyPrintTimeout === 'string' &&
    CANONICAL_DURATION_VALUE.test(opts.agyPrintTimeout)
  ) {
    out[durationFlagIndex + 1] = opts.agyPrintTimeout;
  }
  return out;
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
    if (!hasStreamJson) reasons.push('claude reviewer launcher must use --output-format stream-json');
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

function boundedOutputForClassification(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 240);
}

export function classifyHostExecutionDiagnosticText(text: string): 'auth' | 'interactive' | null {
  const normalized = text.toLowerCase();
  if (/token_invalidated|refresh_token_invalidated|invalidated token|unauthori[sz]ed|authentication|auth required|not logged in|login required|please login|invalid api key|401/.test(normalized)) {
    return 'auth';
  }
  if (/interactive|requires? (?:a )?tty|terminal required|cannot prompt|confirmation required|press enter|choose an option/.test(normalized)) {
    return 'interactive';
  }
  return null;
}

function outputByteCount(result: Pick<SpawnSyncReturns<string>, 'stderr' | 'stdout'>): number {
  return Buffer.byteLength(result.stdout || '', 'utf8') + Buffer.byteLength(result.stderr || '', 'utf8');
}

function launcherFailureDiagnostic(failureKind: HostExecutionFailureKind): string {
  return `launcher:${failureKind}`;
}

function executionFailureDiagnostic(failureKind: HostExecutionFailureKind): string {
  return `execution_failure:${failureKind}`;
}

export function classifyHostExecutionFailure(
  result: Pick<SpawnSyncReturns<string>, 'error' | 'signal' | 'stderr' | 'stdout' | 'status'>,
  fallback: HostExecutionFailureKind = 'unknown',
): HostExecutionFailureKind {
  const text = `${boundedOutputForClassification(result.stderr)} ${boundedOutputForClassification(result.stdout)}`.trim().toLowerCase();
  if (result.error && /timed?out|etimedout/i.test(result.error.message)) return 'timeout';
  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') return 'timeout';
  const diagnostic = classifyHostExecutionDiagnosticText(text);
  if (diagnostic) return diagnostic;
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
  if (failureKind === 'missing_executable' || failureKind === 'version_failed' || failureKind === 'auth' || failureKind === 'interactive' || failureKind === 'timeout') {
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
  outputBytes?: number;
  observedLauncherArgv?: string[];
}): HostExecutionReadinessProbe {
  const spec = canonicalReviewHostLauncherSpec(args.host);
  const launcherArgv = args.observedLauncherArgv ?? spec.launcherArgv;
  const launcher = classifyReviewHostLauncher(args.host, launcherArgv);
  const durationMs = Math.max(0, Math.floor(args.durationMs));

  if (!args.executablePath) {
    return {
      launcher: spec.launcher,
      launcherArgv,
      launcherSupport: 'unverified',
      launcherOk: launcher.launcherOk,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: 'missing_executable',
      durationMs,
      diagnostic: 'missing_executable',
      remediation: `Install or expose ${spec.command} in PATH.`,
    };
  }
  if (!args.versionOk) {
    return {
      launcher: spec.launcher,
      launcherArgv,
      launcherSupport: 'unverified',
      launcherOk: launcher.launcherOk,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: 'version_failed',
      durationMs,
      diagnostic: 'version_probe_failed',
      remediation: `Repair ${spec.command} installation until the CLI starts cleanly, then rerun review_host_availability_probe.`,
    };
  }
  if (!launcher.launcherOk) {
    return {
      launcher: spec.launcher,
      launcherArgv,
      launcherSupport: launcher.launcherSupport,
      launcherOk: false,
      executionReady: false,
      reviewReady: false,
      progressMode: launcher.progressMode,
      failureKind: launcher.failureKind,
      durationMs,
      diagnostic: launcherFailureDiagnostic(launcher.failureKind),
      remediation: launcher.remediation,
    };
  }

  const failureKind = args.result ? classifyHostExecutionFailure(args.result) : 'none';
  const executionReady = failureKind === 'none';
  const launcherSupport = supportForFailure(failureKind);
  const reviewReady = executionReady && spec.observable;
  const outputBytes = args.outputBytes ?? (args.result ? outputByteCount(args.result) : undefined);
  return {
    launcher: spec.launcher,
    launcherArgv,
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
    ...(outputBytes !== undefined ? { outputBytes: Math.max(0, Math.floor(outputBytes)) } : {}),
    ...(executionReady ? {} : { diagnostic: executionFailureDiagnostic(failureKind) }),
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

  const execution = launcherExecutionPlan(spec);
  const started = Date.now();
  try {
    const result = spawnSync(args.executablePath, execution.spawnArgv, {
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
      outputBytes,
      observedLauncherArgv: execution.observedLauncherArgv,
    });
  } finally {
    execution.cleanup();
  }
}
