export type RuntimeArtifactPathMatcher =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'regexp'; value: RegExp };

export interface RuntimeArtifactRegistryEntry {
  id: string;
  description: string;
  matchers: RuntimeArtifactPathMatcher[];
  ignorePatterns: string[];
  materialHash: 'exclude' | 'include';
  volatile: boolean;
  repairableTrackedArtifact: boolean;
}

export const LATTICE_RUNTIME_IGNORE_BLOCK_START = '# lattice runtime artifacts (managed)';
export const LATTICE_RUNTIME_IGNORE_BLOCK_END = '# /lattice runtime artifacts (managed)';

function rx(value: string): RegExp {
  return new RegExp(value);
}

export const RUNTIME_ARTIFACT_REGISTRY: RuntimeArtifactRegistryEntry[] = [
  {
    id: 'lattice-runtime-root-ignore',
    description: 'Ignore runtime state under .lattice/ while keeping tracked story evidence visible.',
    matchers: [],
    ignorePatterns: [
      '.lattice/*',
      '!.lattice/story/',
      '.lattice/story/*',
      '!.lattice/story/actives/',
      '!.lattice/story/actives/**',
      '.lattice/story/actives/**/activity.jsonl',
    ],
    materialHash: 'include',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-activity-log',
    description: 'Primary Proofbound runtime activity log.',
    matchers: [
      { kind: 'exact', value: '.lattice/activity.jsonl' },
    ],
    ignorePatterns: ['**/activity.jsonl'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-c55d CHK-001: the per-story owner lease (`owner-lease.json`) is process
    // metadata, not story evidence. It lives under the git-tracked
    // `.lattice/story/actives/<id>/` subtree, so it MUST be ignored — an
    // un-ignored lease file would surface as a dirty write and could block the
    // DONE `git merge story/<id>` (the F-008 failure mode). The `**/` ignore
    // pattern mirrors `runtime-activity-log` above, which ignores the equally
    // story-scoped `activity.jsonl`.
    id: 'runtime-story-owner-lease',
    description: 'Per-story owner lease (local session ownership) written under .lattice/story/actives/<id>/.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`(?:^|/)owner-lease\.json$`) }],
    ignorePatterns: ['**/owner-lease.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'legacy-activity-log',
    description: 'Legacy top-level activity log retained for compatibility reads.',
    matchers: [{ kind: 'exact', value: 'docs/story/activity.jsonl' }],
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'owner-session-token-store',
    description: 'Local generated owner-session tokens under .lattice/runtime/owner-session-tokens/.',
    matchers: [
      { kind: 'prefix', value: '.lattice/runtime/owner-session-tokens/' },
    ],
    ignorePatterns: ['.lattice/runtime/owner-session-tokens/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-cache',
    description: 'Mutable runtime cache and trigger state under .lattice/runtime/.',
    matchers: [
      { kind: 'prefix', value: '.lattice/runtime/' },
    ],
    ignorePatterns: ['.lattice/runtime/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-traces',
    description: 'Trace artifacts emitted under .lattice/traces/.',
    matchers: [
      { kind: 'prefix', value: '.lattice/traces/' },
    ],
    ignorePatterns: ['.lattice/traces/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-locks',
    description: 'Main write lock and other mkdir-style coordination locks under .lattice/locks/.',
    matchers: [
      { kind: 'prefix', value: '.lattice/locks/' },
    ],
    ignorePatterns: ['.lattice/locks/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-253e CHK-005: the local LLM usage ledger (.lattice/usage/llm-usage.jsonl)
    // is a mutable runtime diagnostic — budget accounting and operator
    // diagnostics, NOT story evidence, validation evidence, or gate-consumed
    // proof. doctor / material-hash / runtime-artifact repair / gitignore must
    // treat it like other mutable runtime diagnostics under .lattice/. The
    // prefix matcher also covers future adjacent usage-runtime files under
    // .lattice/usage/ without catching unrelated paths (e.g. story evidence).
    id: 'llm-usage-ledger',
    description: 'local LLM usage diagnostic ledger',
    matchers: [
      { kind: 'exact', value: '.lattice/usage/llm-usage.jsonl' },
      { kind: 'prefix', value: '.lattice/usage/' },
    ],
    ignorePatterns: ['.lattice/usage/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-000c CHK-003: the Experience Layer derived caches under
    // .lattice/learning/ (finding-signals.json + learning-log.jsonl) are mutable
    // runtime diagnostics derived from existing findings — NOT story evidence,
    // validation evidence, or gate-consumed proof. They MUST be materialHash-
    // excluded so deriving/refreshing the cache never perturbs currentMaterialHash
    // and thus never invalidates a gate's evidence freshness. Mirrors the
    // llm-usage-ledger entry above; the prefix matcher also covers future
    // adjacent learning-runtime files under .lattice/learning/.
    id: 'experience-layer-learning-cache',
    description: 'Experience Layer derived finding-signals cache and learning log under .lattice/learning/.',
    matchers: [
      { kind: 'exact', value: '.lattice/learning/finding-signals.json' },
      { kind: 'exact', value: '.lattice/learning/learning-log.jsonl' },
      { kind: 'prefix', value: '.lattice/learning/' },
    ],
    ignorePatterns: ['.lattice/learning/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'serve-metadata',
    description: 'Transient dev-server handshake file.',
    matchers: [
      { kind: 'exact', value: '.lattice-serve.json' },
    ],
    ignorePatterns: ['.lattice-serve.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'lattice-authority-key-file',
    description: 'Internal Proofbound Authority key-management file; may contain local private key material.',
    matchers: [
      { kind: 'exact', value: '.lattice/authority.md' },
      { kind: 'exact', value: '.Lattice/authority.md' },
    ],
    ignorePatterns: ['.lattice/authority.md', '.Lattice/authority.md'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'lattice-baseline-artifacts',
    description: 'Proofbound baseline proof artifacts kept outside the material tree.',
    matchers: [
      { kind: 'prefix', value: '.lattice/artifacts/baseline/' },
      { kind: 'prefix', value: '.Lattice/artifacts/baseline/' },
    ],
    ignorePatterns: ['.lattice/artifacts/baseline/', '.Lattice/artifacts/baseline/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'memory-playbook-baseline-artifacts',
    description: 'Deterministic playbook runtime memory benchmark corpora and reports.',
    matchers: [
      { kind: 'prefix', value: '.lattice/benchmarks/memory-playbook/' },
    ],
    ignorePatterns: ['.lattice/benchmarks/memory-playbook/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-temp',
    description: 'Temporary runtime scratch files and directories.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`^\.lattice-tmp-[^/]+(?:/.*)?$`) }],
    ignorePatterns: ['.lattice-tmp-*'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'debug-log',
    description: 'CLI debug log emitted in the repo root.',
    matchers: [
      { kind: 'exact', value: 'lattice-debug.log' },
    ],
    ignorePatterns: ['lattice-debug.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'browser-test-log',
    description: 'Browser verification log emitted in the repo root.',
    matchers: [{ kind: 'exact', value: 'browser-test.log' }],
    ignorePatterns: ['browser-test.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'project-root-scratch',
    description: 'Host scratch directory created by external adapters.',
    matchers: [{ kind: 'prefix', value: '$PROJECT_ROOT/' }],
    ignorePatterns: ['$PROJECT_ROOT/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
];

export function normalizeRuntimeArtifactPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function matchesRuntimeArtifact(entry: RuntimeArtifactRegistryEntry, path: string): boolean {
  const normalized = normalizeRuntimeArtifactPath(path);
  return entry.matchers.some((matcher) => {
    if (matcher.kind === 'exact') return normalized === normalizeRuntimeArtifactPath(matcher.value);
    if (matcher.kind === 'prefix') {
      const base = normalizeRuntimeArtifactPath(matcher.value);
      return normalized === base || normalized.startsWith(`${base}/`);
    }
    return matcher.value.test(normalized);
  });
}

export function findRuntimeArtifactEntry(path: string): RuntimeArtifactRegistryEntry | undefined {
  const normalized = normalizeRuntimeArtifactPath(path);
  return RUNTIME_ARTIFACT_REGISTRY.find((entry) => entry.matchers.length > 0 && matchesRuntimeArtifact(entry, normalized));
}

export function isRuntimeArtifactPath(path: string): boolean {
  return Boolean(findRuntimeArtifactEntry(path));
}

export function isMaterialExcludedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.materialHash === 'exclude';
}

export function isVolatileRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.volatile === true;
}

export function isRepairableTrackedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.repairableTrackedArtifact === true;
}

export function listRuntimeArtifactIgnorePatterns(): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of RUNTIME_ARTIFACT_REGISTRY) {
    for (const pattern of entry.ignorePatterns) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      lines.push(pattern);
    }
  }
  return lines;
}
