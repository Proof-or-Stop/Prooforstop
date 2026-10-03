import type { SpawnSyncReturns } from 'node:child_process';
import { runSupervisedProviderProcess } from '../providers/supervised-process.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const CANONICAL_REVIEW_HOSTS = ['codex', 'claude', 'grok', 'agy'] as const;
export type CanonicalReviewHost = typeof CANONICAL_REVIEW_HOSTS[number];
export const CANONICAL_CODEX_NONINTERACTIVE_FLAGS = [
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-rules',
] as const;

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
  if (host === 'grok') return {
    host, command: 'grok', launcher: 'grok --output-format streaming-messages-json --prompt-file',
    launcherArgv: ['grok','--output-format','streaming-messages-json','--no-subagents','--disable-web-search','--prompt-file','<prompt-file>'],
    progressMode:'stream-json', observable:true,
    remediation:'Use authenticated Grok headless mode with an isolated GROK_HOME and protected prompt file.',
  };
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
    launcher: 'codex exec --json -',
      launcherArgv: [
        'codex',
        'exec',
        '--json',
        ...CANONICAL_CODEX_NONINTERACTIVE_FLAGS,
        '-',
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
 * readiness probe). Substitutes the `<prompt>` slot (agy: inline prompt text)
 * and the `<prompt-file>` slot (claude: an absolute prompt-file path the
 * caller wrote) 1:1. The returned argv INCLUDES the
 * leading command token (argv[0]); callers spawn `argv[0]` with `argv.slice(1)`.
 *
 * PURE: builds no temp file and touches no fs. The claude prompt file is the
 * caller's responsibility (write mode-0600, clean up after the run). Throws when a
 * required substitution value is missing so a half-substituted argv never spawns.
 */
export function materializeLauncherArgv(
  spec: HostExecutionLauncherSpec,
  opts: { prompt?: string; promptFile?: string },
): string[] {
  const source = spec.launcherArgv;
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
  return out;
}

export function classifyReviewHostLauncher(host: CanonicalReviewHost, argv: readonly string[]): HostLauncherClassification {
  const reasons: string[] = [];
  const spec = canonicalReviewHostLauncherSpec(host);
  let progressMode: HostExecutionProgressMode = 'none';
  let failureKind: HostExecutionFailureKind = 'none';
  let launcherSupport: HostLauncherSupport = 'supported';

  if (host === 'grok') {
    const ready=argvHas(argv,'--prompt-file')&&outputFormatValue(argv)==='streaming-messages-json';
    progressMode=ready?'stream-json':'none';
    if(!ready){reasons.push('grok requires protected prompt file and streaming-messages-json');failureKind='wrong_launcher';launcherSupport='wrong_launcher';}
  } else if (host === 'claude') {
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

// Word-bounded provider diagnostics (old-PoS run 15). A bare `401` matched the
// digits of `"cached_input_tokens":7401088`, a bare `authentication` / `interactive`
// matched ordinary prose and tool output ("non-interactive", "add authentication").
// Only phrases a provider prints about its own session count.
const AUTH_DIAGNOSTIC = new RegExp([
  String.raw`\b(?:refresh_)?token_invalidated\b`, String.raw`\binvalidated token\b`,
  String.raw`\bunauthori[sz]ed\b`, String.raw`\bauthentication (?:failed|failure|required|error)\b`,
  String.raw`\bauth required\b`, String.raw`\bnot logged in\b`, String.raw`\blogin required\b`,
  String.raw`\bplease (?:log ?in|run /login)\b`, String.raw`\binvalid api key\b`,
  String.raw`\b(?:http|status|status code|code)[ :=]{0,3}401\b`,
].join('|'));
const INTERACTIVE_DIAGNOSTIC = new RegExp([
  String.raw`\binteractive (?:terminal|tty|session|input|mode) (?:is )?required\b`,
  String.raw`\brequires? (?:a |an )?(?:tty|interactive terminal)\b`, String.raw`\bterminal required\b`,
  String.raw`\bcannot prompt\b`, String.raw`\bconfirmation required\b`, String.raw`\bpress enter\b`,
  String.raw`\bchoose an option\b`,
].join('|'));

export function classifyHostExecutionDiagnosticText(text: string): 'auth' | 'interactive' | null {
  const normalized = text.toLowerCase();
  if (AUTH_DIAGNOSTIC.test(normalized)) return 'auth';
  if (INTERACTIVE_DIAGNOSTIC.test(normalized)) return 'interactive';
  return null;
}

/**
 * The diagnostic text of one provider stdout line. JSON-mode providers (Codex
 * `exec --json`, Claude `stream-json`) put every item, tool output and usage
 * counter on stdout as JSON events; only an error event speaks for the provider
 * session itself: Codex `error` / `turn.failed`, a Claude `is_error` result, or
 * a top-level `error` on a non-item event. Every other JSON line yields ''.
 * A line that does not start with `{` is plain provider text and is returned as is.
 */
export function providerDiagnosticLineText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return ''; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const event = value as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';
  const isError = type === 'error' || type === 'turn.failed' || event.is_error === true
    || (event.error !== undefined && event.error !== null && !type.startsWith('item.'));
  if (!isError) return '';
  const parts: string[] = [];
  const add = (field: unknown): void => {
    if (typeof field === 'string') parts.push(field);
    else if (field && typeof field === 'object') {
      const nested = field as Record<string, unknown>;
      for (const key of ['message', 'error', 'code', 'type']) if (typeof nested[key] === 'string') parts.push(nested[key] as string);
    }
  };
  add(event.message); add(event.error); add(event.result);
  return parts.join(' ');
}

/** Stdout reduced to provider diagnostics: plain text lines plus provider error events. */
export function providerDiagnosticStdoutText(stdout: string): string {
  return stdout.split('\n').map(providerDiagnosticLineText).filter(line => line.trim().length > 0).join('\n');
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
  const text = `${boundedOutputForClassification(result.stderr)} ${boundedOutputForClassification(providerDiagnosticStdoutText(result.stdout || ''))}`.trim().toLowerCase();
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
  budgetRoot?: string;
  budgetEnv?: NodeJS.ProcessEnv;
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
    const supervised = runSupervisedProviderProcess(args.executablePath, execution.spawnArgv, {
      budgetRoot: args.budgetRoot ?? args.cwd ?? process.cwd(),
      budgetEnv: args.budgetEnv ?? args.env ?? process.env,
      budgetPrompt: boundedReadinessPrompt(),
      cwd: args.cwd ?? process.cwd(),
      env: args.env ?? process.env,
      timeoutMs: args.timeoutMs,
      stdin: args.host === 'codex' ? boundedReadinessPrompt() : '',
    });
    // Retain the readiness output ceiling/classification, while the shared
    // supervisor owns admission and proves provider-group cleanup first.
    const overflow = Buffer.byteLength(supervised.stdout, 'utf8') > 256 * 1024
      || Buffer.byteLength(supervised.stderr, 'utf8') > 256 * 1024;
    const result = { ...supervised, signal: supervised.signal ?? null,
      ...(overflow ? { status: null,
        error: Object.assign(new Error('readiness output exceeded bounded buffer'), { code: 'ENOBUFS' }) } : {}),
    };
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
