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

export const KOALA_RUNTIME_IGNORE_BLOCK_START = '# koala runtime artifacts (managed)';
export const KOALA_RUNTIME_IGNORE_BLOCK_END = '# /koala runtime artifacts (managed)';

function rx(value: string): RegExp {
  return new RegExp(value);
}

export const RUNTIME_ARTIFACT_REGISTRY: RuntimeArtifactRegistryEntry[] = [
  {
    id: 'koala-runtime-root-ignore',
    description: 'Ignore runtime state under .koala/ while keeping tracked story evidence visible.',
    matchers: [],
    ignorePatterns: [
      '.koala/*',
      '!.koala/story/',
      '!.koala/story/**',
    ],
    materialHash: 'include',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-activity-log',
    description: 'Primary runtime activity log written by Koala CLI wrappers.',
    matchers: [{ kind: 'exact', value: '.koala/activity.jsonl' }],
    ignorePatterns: ['**/activity.jsonl'],
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
    id: 'runtime-cache',
    description: 'Mutable runtime cache and trigger state under .koala/runtime/.',
    matchers: [{ kind: 'prefix', value: '.koala/runtime/' }],
    ignorePatterns: ['.koala/runtime/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-traces',
    description: 'Trace artifacts emitted under .koala/traces/.',
    matchers: [{ kind: 'prefix', value: '.koala/traces/' }],
    ignorePatterns: ['.koala/traces/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-locks',
    description: 'Main write lock and other mkdir-style coordination locks under .koala/locks/.',
    matchers: [{ kind: 'prefix', value: '.koala/locks/' }],
    ignorePatterns: ['.koala/locks/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'serve-metadata',
    description: 'Transient dev-server handshake file.',
    matchers: [{ kind: 'exact', value: '.koala-serve.json' }],
    ignorePatterns: ['.koala-serve.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-temp',
    description: 'Temporary runtime scratch files and directories.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`^\.koala-tmp-[^/]+(?:/.*)?$`) }],
    ignorePatterns: ['.koala-tmp-*'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'debug-log',
    description: 'CLI debug log emitted in the repo root.',
    matchers: [{ kind: 'exact', value: 'koala-debug.log' }],
    ignorePatterns: ['koala-debug.log'],
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
    id: 'omx-runtime',
    description: 'OMX runtime workspace state kept outside the material tree.',
    matchers: [{ kind: 'prefix', value: '.omx/' }],
    ignorePatterns: ['.omx/'],
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
