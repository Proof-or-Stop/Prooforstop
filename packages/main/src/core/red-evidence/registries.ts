// §1.2 policy defaults and registries for the trusted RED-evidence subsystem
// (W2a / B-c054). Every constant here is transcribed VERBATIM from the spec's
// "Per-key default status" block so that two conforming implementations resolve
// identical default snapshots and digests
// (docs/requirements/decisions/red-evidence-subsystem-spec.md §1.2).
//
// These are DEFAULTS ONLY. This module ships no runtime execution: it declares
// no runner, resolves no executable, and touches neither the filesystem nor the
// environment. It is diagnostic scaffolding for the W2a policy resolver.

/** §1.2 closed `predicateKind` enum for matcher classes (no free-form predicates, ever). */
export const MATCHER_CLASS_PREDICATE_KINDS = ['exit-code-in', 'stream-nonempty', 'stream-empty'] as const;
export type MatcherClassPredicateKind = (typeof MATCHER_CLASS_PREDICATE_KINDS)[number];

export interface MatcherClass {
  name: string;
  predicateKind: MatcherClassPredicateKind;
  /** Present ONLY for `exit-code-in` (non-empty unique ints 0..255); forbidden for stream-* kinds. */
  param?: number[];
}

export interface RunnerAdapter {
  adapterId: string;
  runnerProfileId: string;
  testCaseRefPattern: string;
  argvTemplate: string[];
  allowedEnvKeys: string[];
  cwd: string;
  linkageKind: 'reporter-event' | 'script-exit';
}

export interface RunnerProfile {
  runnerProfileId: string;
  prepCommands: string[][];
  allowedEnvKeys: string[];
  cwd: string;
  submodules: boolean;
  toolchain?: Record<string, { absolutePath: string; sha256: string }>;
}

/** The fully enumerated integer array 1..255 (NOT a range expression) — §1.2. */
export const NONZERO_EXIT_CODES: number[] = Array.from({ length: 255 }, (_, i) => i + 1);

/**
 * §1.2 default `forbiddenCatchAlls`. The 8th entry is the 2-CHARACTER
 * double-quote literal (two U+0022 chars), NOT the empty string: matcher values
 * are required non-empty (§1.3 rule 1), so an empty-string entry would be inert;
 * the entry is punctuation-only noise text rejected as asserted failure text.
 */
export const DEFAULT_FORBIDDEN_CATCH_ALLS: string[] = ['.*', '.+', '.', '^$', '^.*$', '^.+$', '\\s*', '""'];

/** §1.2 default `invarianceExcludePaths`. */
export const DEFAULT_INVARIANCE_EXCLUDE_PATHS: string[] = [
  'node_modules/**',
  '**/.cache/**',
  '**/*.tsbuildinfo',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  'coverage/**',
  'tmp/**',
  '**/.DS_Store',
];

/** §1.2 default `matcherClassRegistry` (complete canonical objects). */
export function defaultMatcherClassRegistry(): MatcherClass[] {
  return [
    { name: 'nonzero-exit', predicateKind: 'exit-code-in', param: [...NONZERO_EXIT_CODES] },
    { name: 'stderr-nonempty', predicateKind: 'stream-nonempty' },
  ];
}

/** §1.2 default `runnerAdapterRegistry` (complete canonical objects). */
export function defaultRunnerAdapterRegistry(): RunnerAdapter[] {
  return [
    {
      adapterId: 'npm-script@1',
      runnerProfileId: 'node-npm@1',
      testCaseRefPattern: '^npm-script:(?<script>[A-Za-z0-9:_-]+)$',
      argvTemplate: ['npm', 'run', '${script}'],
      allowedEnvKeys: [],
      cwd: '.',
      linkageKind: 'script-exit',
    },
    {
      adapterId: 'node-test@1',
      runnerProfileId: 'node-npm@1',
      testCaseRefPattern: '^node-test:(?<file>[A-Za-z0-9/._-]+)#(?<test>[^#]+)$',
      argvTemplate: ['node', '--test', '--test-reporter', 'tap', '--test-name-pattern', '${test}', '${file}'],
      allowedEnvKeys: [],
      cwd: '.',
      linkageKind: 'reporter-event',
    },
  ];
}

/** §1.2 default `runnerProfileRegistry` (complete canonical object; no toolchain pinned). */
export function defaultRunnerProfileRegistry(): RunnerProfile[] {
  return [
    {
      runnerProfileId: 'node-npm@1',
      prepCommands: [['npm', 'ci']],
      allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'],
      cwd: '.',
      submodules: false,
    },
  ];
}

/**
 * §1.2 HARD forbidden environment keys (language-neutral). No adapter/profile
 * allowlist may contain one, and the runner never propagates one. This set is a
 * SPEC constant; policy may EXTEND it (via `forbiddenEnvKeysExtensions`), never
 * shrink it. `DYLD_`-prefixed keys are matched by prefix, not membership.
 */
export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'JAVA_TOOL_OPTIONS',
  'GIT_EXEC_PATH',
];

/** The exhaustive §1.2 top-level policySnapshot key set — EXACTLY these, no more, no fewer. */
export const POLICY_SNAPSHOT_KEYS = [
  'maxMatchers',
  'maxMatcherLen',
  'minMatcherLen',
  'minMatcherEntropyBits',
  'runTimeoutMs',
  'prepTimeoutMs',
  'killGraceMs',
  'forbiddenCatchAlls',
  'forbiddenEnvKeysExtensions',
  'invarianceExcludePaths',
  'pinnedPath',
  'matcherClassRegistry',
  'runnerAdapterRegistry',
  'runnerProfileRegistry',
] as const;

export type PolicySnapshotKey = (typeof POLICY_SNAPSHOT_KEYS)[number];

/** §1.2 stated scalar/set defaults. `pinnedPath` is intentionally absent (required-no-default). */
export const DEFAULT_POLICY_SCALARS = {
  maxMatchers: 8,
  maxMatcherLen: 512,
  minMatcherLen: 8,
  minMatcherEntropyBits: 24,
  runTimeoutMs: 600000,
  prepTimeoutMs: 900000,
  killGraceMs: 5000,
} as const;

/** §1.12 hard spec-level floors/caps (non-tunable; policy may not cross them). */
export const HARD_FLOORS = {
  minMatcherLenMin: 4,
  minMatcherEntropyBitsMin: 12,
  maxMatchersMax: 32,
  maxMatcherLenMax: 4096,
  timeoutMsMax: 3600000,
} as const;
