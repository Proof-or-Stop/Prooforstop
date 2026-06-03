export const REQUIRED_RUNTIME_FACT_IDS = [
  'cli-entrypoint',
  'global-core-realpath',
  'project-local-bin',
  'node-version',
  'package-version',
  'validate-source',
  'external-reference-policy',
] as const;

export type RuntimeFactId = typeof REQUIRED_RUNTIME_FACT_IDS[number];

export type RuntimeFactScope = 'all' | 'self' | 'external';
export type RuntimeFactSeverity = 'hard' | 'warn' | 'advisory';

export type RuntimeFactChecker =
  | 'resolveCliEntrypoint'
  | 'resolveGlobalCoreRealpath'
  | 'resolveProjectLocalBin'
  | 'resolveNodeVersion'
  | 'resolvePackageVersion'
  | 'resolveValidateSource'
  | 'scanExternalReferencePolicy';

export const RUNTIME_FACT_OUTPUT_KEYS = {
  'cli-entrypoint': 'cliEntrypoint',
  'global-core-realpath': 'globalCoreRealpath',
  'project-local-bin': 'projectLocalBin',
  'node-version': 'nodeVersion',
  'package-version': 'packageVersion',
  'validate-source': 'validateSource',
  'external-reference-policy': 'externalReferencePolicy',
} as const satisfies Record<RuntimeFactId, string>;

export type RuntimeFactOutputKey = typeof RUNTIME_FACT_OUTPUT_KEYS[RuntimeFactId];

export interface RuntimeFactRegistryEntry {
  id: RuntimeFactId;
  scope: RuntimeFactScope;
  selfSeverity: RuntimeFactSeverity;
  externalSeverity: RuntimeFactSeverity;
  checker: RuntimeFactChecker;
  outputKey: RuntimeFactOutputKey;
  rationale: string;
  driftMessage: string;
  repairHint?: string;
}

export const RUNTIME_FACT_REGISTRY = [
  {
    id: 'cli-entrypoint',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'warn',
    checker: 'resolveCliEntrypoint',
    outputKey: 'cliEntrypoint',
    rationale: 'The CLI path determines which installed Lattice/Koala runtime answers user commands.',
    driftMessage: 'The lattice executable on PATH is missing or does not resolve to the expected runtime; legacy koala is accepted as a fallback.',
    repairHint: 'Run `command -v lattice || command -v koala`, rebuild/link the intended package, or use `node packages/main/dist/cli.js` for current-worktree checks.',
  },
  {
    id: 'global-core-realpath',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'warn',
    checker: 'resolveGlobalCoreRealpath',
    outputKey: 'globalCoreRealpath',
    rationale: 'Global @koala-agent/core drift makes bare `lattice` or legacy `koala` commands run stale handlers.',
    driftMessage: 'The globally installed @koala-agent/core realpath does not match the expected Koala core package.',
    repairHint: 'Relink or reinstall the global @koala-agent/core package, then rerun `lattice doctor --format=json`.',
  },
  {
    id: 'project-local-bin',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'resolveProjectLocalBin',
    outputKey: 'projectLocalBin',
    rationale: 'A project-local node_modules/.bin/lattice or legacy node_modules/.bin/koala can shadow the global CLI inside npm scripts or modified PATHs.',
    driftMessage: 'A local lattice or legacy koala binary is present and may override the intended CLI entrypoint.',
    repairHint: 'Inspect `node_modules/.bin/lattice` and legacy `node_modules/.bin/koala`, adjust PATH, or remove stale local installs before trusting bare CLI output.',
  },
  {
    id: 'node-version',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'advisory',
    checker: 'resolveNodeVersion',
    outputKey: 'nodeVersion',
    rationale: 'Node runtime version affects ESM loading, built-in APIs, and child process behavior.',
    driftMessage: 'The current Node runtime is below Koala runtime expectations.',
    repairHint: 'Use Node 20 or newer for Koala CLI development and runtime checks.',
  },
  {
    id: 'package-version',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'advisory',
    checker: 'resolvePackageVersion',
    outputKey: 'packageVersion',
    rationale: 'Package version drift makes global and local Koala outputs hard to compare.',
    driftMessage: 'Koala package versions disagree between the current runtime, repository root, or global install.',
    repairHint: 'Align root/package versions and rebuild before publishing or using the global CLI as evidence.',
  },
  {
    id: 'validate-source',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'resolveValidateSource',
    outputKey: 'validateSource',
    rationale: 'Validation evidence depends on whether Koala uses explicit validate files, configured commands, or advisory fallback discovery.',
    driftMessage: 'No explicit validation source is configured, or Koala is relying on fallback discovery.',
    repairHint: 'Add validate.ts/js/mts or configure validate.command(s) in koala.config.json.',
  },
  {
    id: 'external-reference-policy',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'scanExternalReferencePolicy',
    outputKey: 'externalReferencePolicy',
    rationale: 'External service and memory references must be policy-scanned without pretending connectivity was verified.',
    driftMessage: 'A bounded docs/config scan found external references without explicit health-check semantics.',
    repairHint: 'Document the owning health command or mark the reference as policy-only; localhost examples are treated as internal.',
  },
] as const satisfies readonly RuntimeFactRegistryEntry[];

export function runtimeFactIds(): RuntimeFactId[] {
  return RUNTIME_FACT_REGISTRY.map((entry) => entry.id);
}

export function runtimeFactOutputKeys(): RuntimeFactOutputKey[] {
  return RUNTIME_FACT_REGISTRY.map((entry) => entry.outputKey);
}

export function getRuntimeFactEntry(id: RuntimeFactId): RuntimeFactRegistryEntry {
  const entry = RUNTIME_FACT_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown runtime fact: ${id}`);
  return entry;
}
