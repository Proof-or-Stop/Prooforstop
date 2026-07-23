import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, type Dir, type Dirent, type Stats } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  AcceptanceSnapshotSealIssueV1,
  AcceptanceSnapshotSealV1,
  CoverageAdapterResultV1,
  CoverageDiscoveryMethodV1,
  PlannedCoveragePathV1,
} from './types.js';
import { digestCanonicalJson, digestText } from './digest.js';
import { PROCESS_FACT_REGISTRY, type ProcessFactRegistryEntry } from './process-fact-registry.js';
import { RUNTIME_FACT_REGISTRY } from './runtime-fact-registry.js';

export const ACCEPTANCE_PLAN_DISCOVERY_PROFILE = {
  ref: 'profile:typescript-proof-gate:plan:v1',
  methods: ['scope_contract', 'process_fact_registry', 'handler_dispatch_inventory', 'static_call_graph', 'runtime_trace'] as CoverageDiscoveryMethodV1[],
} as const;

export interface AcceptanceDiscoveryInput {
  supported: boolean;
  workspaceRoot: string;
  storyId: string;
  plannedPathRecords: PlannedCoveragePathV1[];
  scopeRefs: string[];
  phaseBasis?: 'plan' | 'pre_review';
  /** Test-only bounded runtime observations; production derives without caller-authored paths. */
  runtimeObservedPathRefs?: string[];
  /** Test-only mutation point after graph/provenance assembly and before the derivation seal. */
  testHooks?: {
    immediatelyBeforeFinalSeal?: () => void;
  };
}

export interface RegisteredProcessFactClosure {
  pathRefs: string[];
  sourceInventoryRefs: string[];
  sourceFileRefs: string[];
  blindSpots: string[];
  entries: ProcessFactRegistryEntry[];
}

export interface AcceptanceSourceSnapshot {
  canonicalFile: string;
  contentDigest: string;
  content: string;
}

export interface AcceptanceDiscoverySnapshot {
  adapterResults: CoverageAdapterResultV1[];
  registeredClosure: RegisteredProcessFactClosure;
  sourceSnapshots: AcceptanceSourceSnapshot[];
  sourceReadBlindSpots: string[];
  seal: (additionalIssues?: readonly AcceptanceSnapshotSealIssueV1[]) => AcceptanceSnapshotSealV1;
  immediatelyBeforeFinalSeal?: () => void;
}

export interface AcceptanceDiscoveryDiagnostic {
  code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING' | 'AT_ADAPTER_RESULT_DIGEST_MISMATCH' | 'AT_ADAPTER_RESULT_INVALID' | 'AT_DISCOVERY_DISAGREEMENT';
  message: string;
  adapterId?: string;
}

export interface AcceptanceDiscoveryReconciliation {
  adapterResults: CoverageAdapterResultV1[];
  enumeratedPathRefs: string[];
  blindSpots: string[];
  diagnostics: AcceptanceDiscoveryDiagnostic[];
  status: 'complete' | 'partial' | 'unsupported';
}

function stable(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRows<T extends { imported: string; local: string; sourceFile: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map(row => [`${row.sourceFile}\0${row.imported}\0${row.local}`, row])).values()]
    .sort((left, right) => compareCodeUnits(`${left.sourceFile}:${left.imported}:${left.local}`, `${right.sourceFile}:${right.imported}:${right.local}`));
}

function sourceFiles(entry: ProcessFactRegistryEntry): string[] {
  return stable([...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? [])]);
}

function processFactPath(entry: ProcessFactRegistryEntry): string {
  return `path:process-fact:${entry.name}->consumer:${entry.consumerGate ?? '<audit-only>'}`;
}

interface FactoryInventory {
  factory: string;
  sourceFile: string;
  registered: boolean;
  commandKeys: string[];
}

interface BoundedSourceGraph {
  seedFiles: string[];
  sourceInventoryFiles: string[];
  closureFiles: string[];
  entries: ProcessFactRegistryEntry[];
  factories: FactoryInventory[];
  sourceScans: Map<string, LocalImportCallScan>;
  blindSpots: string[];
  readContext: SourceReadContext;
  directoryFingerprints: DirectoryFingerprint[];
}

interface LocalImportCallScan {
  imports: Array<{ imported: string; local: string; sourceFile: string }>;
  calledImports: Array<{ imported: string; local: string; sourceFile: string }>;
  blindSpots: string[];
  unresolvedImports: string[];
}

interface BindingAnalysisContext {
  root: string;
  physicalRoot: string;
  sourceFiles: Map<string, ts.SourceFile>;
  readBlindSpots: Map<string, string[]>;
  checker: ts.TypeChecker;
  readContext: SourceReadContext;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SOURCE_INVENTORY_EXCLUDED_DIRECTORIES = new Set(['.git', '.lattice', '.worktrees', 'dist', 'node_modules']);
const DEFAULT_SOURCE_INVENTORY_BUDGET = {
  maxDirectories: 10_000,
  maxEntries: 100_000,
  maxFiles: 20_000,
  maxBytes: 100 * 1024 * 1024,
} as const;
const MAX_LEXICAL_SOURCE_BYTES = 2 * 1024 * 1024;

export interface SourceInventoryTraversalBudget {
  maxDirectories: number;
  maxEntries: number;
  maxFiles: number;
  maxBytes: number;
}

export interface SourceInventoryTraversalResult {
  files: string[];
  blindSpots: string[];
  stopped: boolean;
  stats: { directories: number; entries: number; files: number; bytes: number; iteratorReads: number; peakBufferedEntries: number; handlesOpened: number; handlesClosed: number };
  directoryFingerprints: DirectoryFingerprint[];
}

export interface DirectoryFingerprint {
  path: string;
  physicalPath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  entryCount: number;
  entriesDigest: string;
}

interface FileFingerprint extends DirectoryFingerprint {
  contentDigest: string;
}

export interface SourceInventoryTraversalHooks {
  beforeDirectoryOpen?: (directory: string) => void;
  afterDirectoryRead?: (directory: string) => void;
  closeDirectory?: (directory: string, close: () => void) => void;
  beforeFinalRevalidation?: () => void;
}

function relativeFile(root: string, absolute: string): string | null {
  const value = relative(root, absolute).replace(/\\/g, '/');
  return value.startsWith('../') || value === '..' ? null : value;
}

interface LocalModuleResolution { sourceFile: string | null; blindSpot?: string }

function physicallyContainedRegularFile(root: string, file: string): { canonical: string; spellingDrift: boolean } | null {
  try {
    const physicalRoot = realpathSync(root);
    let absolute = physicalRoot;
    for (const component of file.split('/').filter(Boolean)) {
      absolute = resolve(absolute, component);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) return null;
    }
    const physical = realpathSync(absolute);
    const rel = relative(physicalRoot, physical);
    if (rel.startsWith('..') || isAbsolute(rel) || !lstatSync(physical).isFile()) return null;
    const canonical = relativeFile(physicalRoot, physical);
    if (!canonical) return null;
    return { canonical, spellingDrift: canonical !== file.replace(/\\/g, '/') };
  } catch { return null; }
}

function resolveLocalModule(root: string, importer: string, specifier: string): LocalModuleResolution {
  if (!specifier.startsWith('.')) return { sourceFile: null };
  const base = resolve(root, dirname(importer), specifier);
  const extension = extname(base);
  const variants = extension.length > 0
    ? extension === '.js' ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base, base.replace(/\.js$/, '.jsx')]
      : extension === '.mjs' ? [base.replace(/\.mjs$/, '.mts'), base]
        : extension === '.cjs' ? [base.replace(/\.cjs$/, '.cts'), base]
          : extension === '.jsx' ? [base.replace(/\.jsx$/, '.tsx'), base]
            : [base]
    : [...SOURCE_EXTENSIONS].map(candidateExtension => `${base}${candidateExtension}`)
      .concat([...SOURCE_EXTENSIONS].map(candidateExtension => resolve(base, `index${candidateExtension}`)));
  const candidates = variants.flatMap(candidate => {
    try {
      const rel = relativeFile(root, candidate);
      const contained = rel ? physicallyContainedRegularFile(root, rel) : null;
      return contained ? [{ lexical: rel!, ...contained }] : [];
    } catch { return []; }
  });
  const drift = candidates.find(candidate => candidate.spellingDrift);
  if (drift) return { sourceFile: null, blindSpot: `local module spelling differs from canonical physical path for ${specifier} from ${importer}: ${drift.lexical} -> ${drift.canonical}` };
  const viable = stable(candidates.map(candidate => candidate.canonical));
  if (viable.length === 1) return { sourceFile: viable[0] };
  if (viable.length === 0) return { sourceFile: null, blindSpot: `unresolved local module ${specifier} from ${importer}` };
  return { sourceFile: null, blindSpot: `ambiguous local module ${specifier} from ${importer}: ${viable.join(', ')}` };
}

/** Deterministic, globally budgeted source-tree walk. Exported for bounded mutation tests. */
export function enumerateBoundedSourceTree(
  physicalWorkspace: string,
  physicalSourceRoot: string,
  budget: SourceInventoryTraversalBudget = DEFAULT_SOURCE_INVENTORY_BUDGET,
  hooks: SourceInventoryTraversalHooks = {},
): SourceInventoryTraversalResult {
  const files: string[] = [];
  const blindSpots: string[] = [];
  const stats = { directories: 0, entries: 0, files: 0, bytes: 0, iteratorReads: 0, peakBufferedEntries: 0, handlesOpened: 0, handlesClosed: 0 };
  const directories = [physicalSourceRoot];
  const admittedDirectories: Array<{ directory: string; physical: string; stat: Stats; entryCount: number; entriesDigest: string }> = [];
  let stopped = false;
  const stop = (dimension: keyof SourceInventoryTraversalBudget): void => {
    if (!stopped) blindSpots.push(`configured source-root inventory exhausted ${dimension} budget`);
    stopped = true;
  };
  while (directories.length > 0 && !stopped) {
    if (stats.directories >= budget.maxDirectories) { stop('maxDirectories'); break; }
    const directory = directories.pop()!;
    hooks.beforeDirectoryOpen?.(directory);
    stats.directories += 1;
    const remainingEntries = budget.maxEntries - stats.entries;
    const rows: Dirent[] = [];
    let before: Stats;
    let physicalBefore: string;
    let handle: Dir | undefined;
    let closeFailed = false;
    const closeHandle = (): void => {
      if (!handle) return;
      handle.closeSync();
      handle = undefined;
      stats.handlesClosed += 1;
    };
    try {
      before = lstatSync(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('not a stable directory');
      physicalBefore = realpathSync(directory);
      const contained = relative(physicalWorkspace, physicalBefore);
      if (contained.startsWith('..') || isAbsolute(contained)) throw new Error('directory escapes workspace');
      handle = opendirSync(physicalBefore);
      stats.handlesOpened += 1;
      while (rows.length <= remainingEntries) {
        const row = handle.readSync();
        stats.iteratorReads += 1;
        if (!row) break;
        rows.push(row);
        stats.peakBufferedEntries = Math.max(stats.peakBufferedEntries, rows.length);
      }
      hooks.afterDirectoryRead?.(directory);
      (hooks.closeDirectory ?? ((_directory: string, close: () => void) => close()))(directory, closeHandle);
    } catch {
      closeFailed = Boolean(handle);
      blindSpots.push(`${closeFailed ? 'configured source directory close failed' : 'configured source directory is unreadable'}: ${relativeFile(physicalWorkspace, directory) ?? directory}`);
    } finally {
      try { closeHandle(); }
      catch {
        closeFailed = true;
        blindSpots.push(`configured source directory close failed: ${relativeFile(physicalWorkspace, directory) ?? directory}`);
      }
    }
    const chargedEntries = Math.min(rows.length, remainingEntries);
    stats.entries += chargedEntries;
    if (closeFailed) { stopped = true; break; }
    try {
      const after = lstatSync(directory);
      const physicalAfter = realpathSync(directory);
      if (after.isSymbolicLink() || !after.isDirectory() || physicalAfter !== physicalBefore!
        || before!.dev !== after.dev || before!.ino !== after.ino || before!.size !== after.size
        || before!.mtimeMs !== after.mtimeMs || before!.ctimeMs !== after.ctimeMs) {
        blindSpots.push(`configured source directory changed during enumeration: ${relativeFile(physicalWorkspace, directory) ?? directory}`);
        stopped = true;
        break;
      }
    } catch {
      blindSpots.push(`configured source directory changed during enumeration: ${relativeFile(physicalWorkspace, directory) ?? directory}`);
      stopped = true;
      break;
    }
    if (rows.length > remainingEntries) { stop('maxEntries'); break; }
    rows.sort((a, b) => compareCodeUnits(a.name, b.name));
    const entriesDigest = digestText(rows.map(row => `${row.name}\0${row.isDirectory() ? 'd' : row.isFile() ? 'f' : row.isSymbolicLink() ? 'l' : 'o'}`).join('\n'));
    admittedDirectories.push({ directory, physical: physicalBefore!, stat: before!, entryCount: rows.length, entriesDigest });
    const childDirectories: string[] = [];
    for (const row of rows) {
      if (SOURCE_INVENTORY_EXCLUDED_DIRECTORIES.has(row.name)) continue;
      const absolute = resolve(directory, row.name);
      if (row.isSymbolicLink()) { blindSpots.push(`ambiguous source-root symlink excluded: ${relativeFile(physicalWorkspace, absolute) ?? absolute}`); continue; }
      if (row.isDirectory()) {
        if (stats.directories + directories.length + childDirectories.length + 1 > budget.maxDirectories) { stop('maxDirectories'); break; }
        childDirectories.push(absolute);
        continue;
      }
      const dot = row.name.lastIndexOf('.');
      if (!row.isFile() || dot < 0 || !SOURCE_EXTENSIONS.has(row.name.slice(dot))) continue;
      if (stats.files >= budget.maxFiles) { stop('maxFiles'); break; }
      let size: number;
      try { size = lstatSync(absolute).size; }
      catch { blindSpots.push(`configured source file is unreadable: ${relativeFile(physicalWorkspace, absolute) ?? absolute}`); continue; }
      if (stats.bytes + size > budget.maxBytes) { stop('maxBytes'); break; }
      const file = relativeFile(physicalWorkspace, absolute);
      if (!file) { blindSpots.push(`configured source file physically escapes workspace: ${absolute}`); continue; }
      files.push(file);
      stats.files += 1;
      stats.bytes += size;
    }
    for (let index = childDirectories.length - 1; index >= 0 && !stopped; index -= 1) directories.push(childDirectories[index]);
  }
  hooks.beforeFinalRevalidation?.();
  for (const snapshot of admittedDirectories) {
    try {
      const current = lstatSync(snapshot.directory);
      const physical = realpathSync(snapshot.directory);
      if (current.isSymbolicLink() || !current.isDirectory() || physical !== snapshot.physical
        || current.dev !== snapshot.stat.dev || current.ino !== snapshot.stat.ino || current.size !== snapshot.stat.size
        || current.mtimeMs !== snapshot.stat.mtimeMs || current.ctimeMs !== snapshot.stat.ctimeMs) throw new Error('changed');
    } catch {
      blindSpots.push(`configured source directory changed after enumeration: ${relativeFile(physicalWorkspace, snapshot.directory) ?? snapshot.directory}`);
      files.length = 0;
      stopped = true;
      break;
    }
  }
  return {
    files, blindSpots: stable(blindSpots), stopped, stats,
    directoryFingerprints: admittedDirectories.map(snapshot => ({
      path: snapshot.directory, physicalPath: snapshot.physical, dev: snapshot.stat.dev, ino: snapshot.stat.ino,
      size: snapshot.stat.size, mtimeMs: snapshot.stat.mtimeMs, ctimeMs: snapshot.stat.ctimeMs,
      entryCount: snapshot.entryCount, entriesDigest: snapshot.entriesDigest,
    })),
  };
}

const MAX_LATTICE_CONFIG_BYTES = 64 * 1024;

function configuredSourceInventory(workspaceRoot: string, readContext: SourceReadContext): { files: string[]; blindSpots: string[]; directoryFingerprints: DirectoryFingerprint[] } {
  let rawConfig: Record<string, unknown>;
  try {
    const read = readSourceSafely(readContext, 'lattice.config.json', MAX_LATTICE_CONFIG_BYTES);
    if (read.text === undefined) throw new Error(read.blindSpot ?? 'safe config snapshot is unavailable');
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level value must be an object');
    rawConfig = parsed as Record<string, unknown>;
  } catch (error) {
    return { files: [], blindSpots: [`canonical source-root config is unreadable: ${error instanceof Error ? error.message : String(error)}`], directoryFingerprints: [] };
  }
  const configuredScanRoot = rawConfig.scanRoot;
  const configuredRootDir = rawConfig.rootDir;
  if (typeof configuredScanRoot !== 'string' || configuredScanRoot.trim().length === 0
    || isAbsolute(configuredScanRoot) || configuredScanRoot.split(/[\\/]/).includes('..')
    || (configuredRootDir !== undefined && (typeof configuredRootDir !== 'string' || configuredRootDir.trim().length === 0
      || isAbsolute(configuredRootDir) || configuredRootDir.split(/[\\/]/).includes('..')))) {
    return { files: [], blindSpots: ['canonical scanRoot/rootDir is missing or ambiguous'], directoryFingerprints: [] };
  }
  // Only the fields that choose discovery scope belong to the cross-run basis
  // identity. The raw file fingerprint is still retained and revalidated below
  // during this assembly, so a concurrent config mutation remains fail-closed.
  // Lifecycle rollout fields (for example proofStory.acceptanceTopologyGateMode)
  // must not
  // change the structural inventory they merely decide whether to block on.
  readContext.semanticDigests.set('lattice.config.json', `sha256:${digestCanonicalJson({
    scanRoot: configuredScanRoot,
    rootDir: configuredRootDir ?? null,
  })}`);
  const relativeRoot = configuredRootDir ? join(configuredScanRoot, configuredRootDir) : configuredScanRoot;
  let physicalWorkspace: string;
  try {
    physicalWorkspace = realpathSync(workspaceRoot);
  } catch {
    return { files: [], blindSpots: ['canonical workspace root is missing or unreadable'], directoryFingerprints: [] };
  }
  let absoluteRoot = physicalWorkspace;
  for (const component of relativeRoot.split(/[\\/]/).filter(value => value.length > 0 && value !== '.')) {
    absoluteRoot = resolve(absoluteRoot, component);
    let componentStat;
    try { componentStat = lstatSync(absoluteRoot); }
    catch { return { files: [], blindSpots: [`configured source root is missing or unreadable: ${relativeRoot}`], directoryFingerprints: [] }; }
    if (componentStat.isSymbolicLink()) return { files: [], blindSpots: [`configured source root traverses symlink component: ${relativeRoot}`], directoryFingerprints: [] };
    if (!componentStat.isDirectory()) return { files: [], blindSpots: [`configured source root component is not a directory: ${relativeRoot}`], directoryFingerprints: [] };
    if ((componentStat.mode & 0o444) === 0 || (componentStat.mode & 0o111) === 0) {
      return { files: [], blindSpots: [`configured source root is unreadable: ${relativeRoot}`], directoryFingerprints: [] };
    }
  }
  let physicalSourceRoot: string;
  try { physicalSourceRoot = realpathSync(absoluteRoot); }
  catch { return { files: [], blindSpots: [`configured source root is missing or unreadable: ${relativeRoot}`], directoryFingerprints: [] }; }
  const physicalRelative = relative(physicalWorkspace, physicalSourceRoot);
  if (physicalRelative.startsWith('..') || isAbsolute(physicalRelative)) {
    return { files: [], blindSpots: [`configured source root physically escapes workspace: ${relativeRoot}`], directoryFingerprints: [] };
  }
  const canonicalRelativeRoot = relativeFile(physicalWorkspace, physicalSourceRoot);
  if (!canonicalRelativeRoot) return { files: [], blindSpots: [`configured source root physically escapes workspace: ${relativeRoot}`], directoryFingerprints: [] };
  absoluteRoot = physicalSourceRoot;
  const traversal = enumerateBoundedSourceTree(physicalWorkspace, absoluteRoot);
  return { files: traversal.files, blindSpots: traversal.blindSpots, directoryFingerprints: traversal.directoryFingerprints };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.mts')) return ts.ScriptKind.TS;
  if (file.endsWith('.cts')) return ts.ScriptKind.TS;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface SourceReadContext {
  physicalRoot: string;
  maxFiles: number;
  maxBytes: number;
  maxPerFileBytes: number;
  forceNoFollow: boolean;
  files: number;
  bytes: number;
  maxAllocatedBytes: number;
  snapshots: Map<string, string>;
  failures: Map<string, string>;
  fingerprints: Map<string, FileFingerprint>;
  /** Cross-run semantic digests for files whose unrelated fields are non-discovery policy. */
  semanticDigests: Map<string, string>;
}

export interface SourceReadTestResult {
  acceptedFiles: string[];
  blindSpots: string[];
  stats: { files: number; bytes: number; maxAllocatedBytes: number };
}

function createSourceReadContext(root: string, options: Partial<Pick<SourceReadContext, 'maxFiles' | 'maxBytes' | 'maxPerFileBytes' | 'forceNoFollow'>> = {}): SourceReadContext {
  let physicalRoot: string;
  try { physicalRoot = realpathSync(root); }
  catch { physicalRoot = resolve(root); }
  return {
    physicalRoot,
    maxFiles: options.maxFiles ?? DEFAULT_SOURCE_INVENTORY_BUDGET.maxFiles,
    maxBytes: options.maxBytes ?? DEFAULT_SOURCE_INVENTORY_BUDGET.maxBytes,
    maxPerFileBytes: options.maxPerFileBytes ?? MAX_LEXICAL_SOURCE_BYTES,
    forceNoFollow: options.forceNoFollow ?? false,
    files: 0,
    bytes: 0,
    maxAllocatedBytes: 0,
    snapshots: new Map(),
    failures: new Map(),
    fingerprints: new Map(),
    semanticDigests: new Map(),
  };
}

function readSourceSafely(context: SourceReadContext, file: string, perFileCap = context.maxPerFileBytes): { text?: string; blindSpot?: string } {
  const cached = context.snapshots.get(file);
  if (cached !== undefined) return { text: cached };
  const cachedFailure = context.failures.get(file);
  if (cachedFailure) return { blindSpot: cachedFailure };
  const fail = (message: string): { blindSpot: string } => { context.failures.set(file, message); return { blindSpot: message }; };
  const relativePath = file.replace(/\\/g, '/');
  if (isAbsolute(relativePath) || relativePath.split('/').includes('..')) return fail(`source file path escapes workspace: ${file}`);
  let absolute = context.physicalRoot;
  let before;
  try {
    for (const component of relativePath.split('/').filter(Boolean)) {
      absolute = resolve(absolute, component);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) return fail(`source file traverses symlink during read: ${file}`);
      before = stat;
    }
    if (!before?.isFile() || (before.mode & 0o444) === 0) return fail(`source file is unreadable: ${file}`);
    const physicalFile = realpathSync(absolute);
    const rel = relative(context.physicalRoot, physicalFile);
    if (rel.startsWith('..') || isAbsolute(rel)) return fail(`source file physically escapes workspace: ${file}`);
    const canonicalFile = relativeFile(context.physicalRoot, physicalFile);
    if (!canonicalFile || canonicalFile !== relativePath) return fail(`source file spelling differs from canonical physical path: ${file}${canonicalFile ? ` -> ${canonicalFile}` : ''}`);
    const noFollow = context.forceNoFollow ? undefined : fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== 'number' || noFollow <= 0) return fail(`safe no-follow source read is unsupported: ${file}`);
    if (before.size > perFileCap) return fail(`source file exceeds lexical scan budget: ${file}`);
    if (context.files >= context.maxFiles) return fail(`source read exhausted maxFiles budget: ${file}`);
    if (context.bytes + before.size > context.maxBytes) return fail(`source read exhausted maxBytes budget: ${file}`);
    const descriptor = openSync(physicalFile, fsConstants.O_RDONLY | noFollow);
    let text: string;
    let after;
    try {
      const opened = fstatSync(descriptor);
      if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) return fail(`source file changed before read: ${file}`);
      const allocation = opened.size + 1;
      context.maxAllocatedBytes = Math.max(context.maxAllocatedBytes, allocation);
      const buffer = Buffer.alloc(allocation);
      let offset = 0;
      while (offset < allocation) {
        const count = readSync(descriptor, buffer, offset, allocation - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== opened.size) return fail(`source file changed during bounded read: ${file}`);
      text = buffer.subarray(0, opened.size).toString('utf8');
      after = fstatSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const currentPhysical = realpathSync(absolute);
    if (currentPhysical !== physicalFile || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return fail(`source file changed during read: ${file}`);
    }
    context.files += 1;
    context.bytes += before.size;
    context.snapshots.set(canonicalFile, text);
    context.fingerprints.set(canonicalFile, {
      path: canonicalFile, physicalPath: physicalFile, dev: before.dev, ino: before.ino, size: before.size,
      mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, contentDigest: digestText(text),
      entryCount: 0, entriesDigest: '',
    });
    return { text };
  } catch {
    return fail(`source file is unreadable or disappeared: ${file}`);
  }
}

function revalidateDirectoryFingerprint(fingerprint: DirectoryFingerprint): boolean {
  let handle: Dir | undefined;
  try {
    const current = lstatSync(fingerprint.path);
    const physical = realpathSync(fingerprint.path);
    if (current.isSymbolicLink() || !current.isDirectory() || physical !== fingerprint.physicalPath
      || current.dev !== fingerprint.dev || current.ino !== fingerprint.ino || current.size !== fingerprint.size
      || current.mtimeMs !== fingerprint.mtimeMs || current.ctimeMs !== fingerprint.ctimeMs) throw new Error('changed');
    handle = opendirSync(physical);
    const rows: Dirent[] = [];
    while (rows.length <= fingerprint.entryCount) {
      const row = handle.readSync();
      if (!row) break;
      rows.push(row);
    }
    handle.closeSync();
    handle = undefined;
    rows.sort((a, b) => compareCodeUnits(a.name, b.name));
    const entriesDigest = digestText(rows.map(row => `${row.name}\0${row.isDirectory() ? 'd' : row.isFile() ? 'f' : row.isSymbolicLink() ? 'l' : 'o'}`).join('\n'));
    if (rows.length !== fingerprint.entryCount || entriesDigest !== fingerprint.entriesDigest) throw new Error('entries changed');
    return true;
  } catch { return false; }
  finally { if (handle) try { handle.closeSync(); } catch { /* already a failed seal */ } }
}

function revalidateFileFingerprint(context: SourceReadContext, fingerprint: FileFingerprint): AcceptanceSnapshotSealIssueV1['code'] | null {
  const fail = (): AcceptanceSnapshotSealIssueV1['code'] => 'source_file_changed';
  let absolute = context.physicalRoot;
  let descriptor: number | undefined;
  try {
    for (const component of fingerprint.path.split('/').filter(Boolean)) {
      absolute = resolve(absolute, component);
      if (lstatSync(absolute).isSymbolicLink()) return fail();
    }
    const physical = realpathSync(absolute);
    if (physical !== fingerprint.physicalPath) return fail();
    const noFollow = context.forceNoFollow ? undefined : fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== 'number' || noFollow <= 0) return 'safe_no_follow_unsupported';
    descriptor = openSync(physical, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (opened.dev !== fingerprint.dev || opened.ino !== fingerprint.ino || opened.size !== fingerprint.size
      || opened.mtimeMs !== fingerprint.mtimeMs || opened.ctimeMs !== fingerprint.ctimeMs) return fail();
    const buffer = Buffer.alloc(fingerprint.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== fingerprint.size || digestText(buffer.subarray(0, fingerprint.size).toString('utf8')) !== fingerprint.contentDigest) return fail();
    const after = fstatSync(descriptor);
    if (after.dev !== fingerprint.dev || after.ino !== fingerprint.ino || after.size !== fingerprint.size
      || after.mtimeMs !== fingerprint.mtimeMs || after.ctimeMs !== fingerprint.ctimeMs) return fail();
    closeSync(descriptor);
    descriptor = undefined;
    return null;
  } catch { return fail(); }
  finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* seal already fails only if observable above */ } }
}

function sealSourceAssembly(
  context: SourceReadContext,
  directories: readonly DirectoryFingerprint[],
  additionalIssues: readonly AcceptanceSnapshotSealIssueV1[] = [],
): AcceptanceSnapshotSealV1 {
  const directoryProjection = directories.map(fingerprint => ({
    canonicalRef: relativeFile(context.physicalRoot, fingerprint.path) ?? fingerprint.path,
    entryCount: fingerprint.entryCount, entriesDigest: fingerprint.entriesDigest,
  })).sort((left, right) => compareCodeUnits(left.canonicalRef, right.canonicalRef));
  const fileProjection = stable([...context.fingerprints.keys()]).filter(file => file !== 'lattice.config.json').map(file => {
    const fingerprint = context.fingerprints.get(file)!;
    return { canonicalRef: file, size: fingerprint.size, contentDigest: fingerprint.contentDigest };
  });
  const configFingerprint = context.fingerprints.get('lattice.config.json');
  const issues: AcceptanceSnapshotSealIssueV1[] = [...additionalIssues];
  for (const fingerprint of directories) {
    if (!revalidateDirectoryFingerprint(fingerprint)) issues.push({ code: 'directory_changed', targetKind: 'directory', canonicalRef: relativeFile(context.physicalRoot, fingerprint.path) ?? fingerprint.path });
  }
  for (const file of stable([...context.fingerprints.keys()])) {
    const code = revalidateFileFingerprint(context, context.fingerprints.get(file)!);
    if (code) issues.push({ code, targetKind: file === 'lattice.config.json' ? 'config' : 'source_file', canonicalRef: file });
  }
  if (directories.length === 0) issues.push({ code: 'inventory_unsealable', targetKind: 'inventory', canonicalRef: 'configured-source-root' });
  if (!configFingerprint) issues.push({ code: 'snapshot_missing', targetKind: 'config', canonicalRef: 'lattice.config.json' });
  const stableIssues = [...new Map(issues.map(issue => [`${issue.code}\0${issue.targetKind}\0${issue.canonicalRef}`, issue])).values()]
    .sort((left, right) => compareCodeUnits(`${left.code}:${left.targetKind}:${left.canonicalRef}`, `${right.code}:${right.targetKind}:${right.canonicalRef}`));
  const unsigned: Omit<AcceptanceSnapshotSealV1, 'sealDigest'> = {
    schemaVersion: 'proofstory.acceptance_snapshot_seal.v1',
    inventoryDirectoryDigest: `sha256:${digestCanonicalJson(directoryProjection)}`,
    inventoryDirectoryCount: directoryProjection.length,
    sourceSnapshotDigest: `sha256:${digestCanonicalJson(fileProjection)}`,
    sourceSnapshotCount: fileProjection.length,
    configSnapshotDigest: `sha256:${digestCanonicalJson(configFingerprint ? {
      canonicalRef: 'lattice.config.json',
      contentDigest: context.semanticDigests.get('lattice.config.json') ?? configFingerprint.contentDigest,
    } : null)}`,
    status: stableIssues.length === 0 ? 'complete' : 'partial',
    issues: stableIssues,
  };
  return { ...unsigned, sealDigest: `sha256:${digestCanonicalJson(unsigned)}` };
}

export function renderAcceptanceSnapshotSealIssue(issue: AcceptanceSnapshotSealIssueV1): string {
  return `snapshot-seal:${issue.code}:${issue.targetKind}:${issue.canonicalRef}`;
}

/** Test seam proving the shared source-read budget rejects before unbounded allocation. */
export function readBoundedSourceSetForTest(
  root: string,
  files: readonly string[],
  options: { maxFiles: number; maxBytes: number; maxPerFileBytes: number; forceNoFollow?: boolean },
): SourceReadTestResult {
  const context = createSourceReadContext(root, options);
  for (const file of stable(files)) readSourceSafely(context, file);
  return {
    acceptedFiles: stable([...context.snapshots.keys()]),
    blindSpots: stable([...context.failures.values()]),
    stats: { files: context.files, bytes: context.bytes, maxAllocatedBytes: context.maxAllocatedBytes },
  };
}

export function snapshotAcceptanceSourceFiles(root: string, files: readonly string[]): { sourceSnapshots: AcceptanceSourceSnapshot[]; blindSpots: string[] } {
  const context = createSourceReadContext(root);
  for (const file of stable(files)) readSourceSafely(context, file);
  return {
    sourceSnapshots: stable([...context.snapshots.keys()]).map(canonicalFile => {
      const content = context.snapshots.get(canonicalFile)!;
      return { canonicalFile, contentDigest: digestText(content), content };
    }),
    blindSpots: stable([...context.failures.values()]),
  };
}

function createBindingAnalysisContext(root: string, files: readonly string[], readContext = createSourceReadContext(root)): BindingAnalysisContext {
  const physicalRoot = readContext.physicalRoot;
  const sourceFiles = new Map<string, ts.SourceFile>();
  const readBlindSpots = new Map<string, string[]>();
  const absoluteSources = new Map<string, ts.SourceFile>();
  for (const file of stable(files)) {
    const read = readSourceSafely(readContext, file);
    if (read.blindSpot || read.text === undefined) { readBlindSpots.set(file, [read.blindSpot ?? `source file is unreadable: ${file}`]); continue; }
    try {
      const absolute = resolve(physicalRoot, file);
      const source = ts.createSourceFile(absolute, read.text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
      sourceFiles.set(file, source);
      absoluteSources.set(absolute, source);
    } catch {
      readBlindSpots.set(file, [`typescript parser failed for ${file}`]);
    }
  }
  const options: ts.CompilerOptions = { allowJs: true, checkJs: false, noResolve: true, noLib: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve };
  const fallback = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...fallback,
    fileExists: fileName => absoluteSources.has(resolve(fileName)),
    readFile: fileName => absoluteSources.get(resolve(fileName))?.text,
    getSourceFile: fileName => absoluteSources.get(resolve(fileName)),
    writeFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [...absoluteSources.keys()], options, host });
  return { root, physicalRoot, sourceFiles, readBlindSpots, checker: program.getTypeChecker(), readContext };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current) || ts.isPartiallyEmittedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function analyzeLocalImportCalls(context: BindingAnalysisContext, file: string): LocalImportCallScan {
  const source = context.sourceFiles.get(file);
  if (!source) return { imports: [], calledImports: [], blindSpots: context.readBlindSpots.get(file) ?? [`uninspectable source file ${file}`], unresolvedImports: [] };
  const text = source.text;
  if (Buffer.byteLength(text, 'utf8') > MAX_LEXICAL_SOURCE_BYTES) {
    return { imports: [], calledImports: [], blindSpots: [`source file exceeds lexical scan budget: ${file}`], unresolvedImports: [] };
  }
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return { imports: [], calledImports: [], blindSpots: [`typescript parse ambiguity in ${file}`], unresolvedImports: [] };
  }
  const imports: Array<{ imported: string; local: string; sourceFile: string }> = [];
  const unresolved: string[] = [];
  const bindingBlindSpots: string[] = [];
  const bindings: Array<{ imported: string; local: string; sourceFile: string; node: ts.Identifier; direct: boolean; property: boolean; symbol?: ts.Symbol }> = [];
  const addBinding = (imported: string, node: ts.Identifier, sourceFile: string, direct: boolean, property: boolean): void => {
    const row = { imported, local: node.text, sourceFile, node, direct, property, symbol: context.checker.getSymbolAtLocation(node) };
    imports.push({ imported, local: node.text, sourceFile });
    bindings.push(row);
    if (!row.symbol) bindingBlindSpots.push(`unresolved import binding ${node.text} in ${file}`);
  };
  const resolveSpecifier = (specifier: string): string | null => {
    const resolution = resolveLocalModule(context.root, file, specifier);
    if (resolution.blindSpot) unresolved.push(resolution.blindSpot);
    return resolution.sourceFile;
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
      const sourceFile = resolveSpecifier(statement.moduleSpecifier.text);
      if (!sourceFile) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.name) addBinding('default', clause.name, sourceFile, true, true);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) addBinding(element.propertyName?.text ?? element.name.text, element.name, sourceFile, true, false);
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addBinding('*', clause.namedBindings.name, sourceFile, false, true);
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)
      && statement.moduleReference.expression.text.startsWith('.')) {
      const sourceFile = resolveSpecifier(statement.moduleReference.expression.text);
      if (sourceFile) addBinding('*', statement.name, sourceFile, true, true);
    }
  }
  const moduleCall = (expression: ts.Expression | undefined): { specifier: string; call: ts.CallExpression; kind: 'require' | 'import' } | null => {
    if (!expression) return null;
    let value = unwrapExpression(expression);
    if (ts.isAwaitExpression(value)) value = unwrapExpression(value.expression);
    if (!ts.isCallExpression(value) || value.arguments.length !== 1 || !ts.isStringLiteral(value.arguments[0]) || !value.arguments[0].text.startsWith('.')) return null;
    const callee = unwrapExpression(value.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return { specifier: value.arguments[0].text, call: value, kind: 'import' };
    if (ts.isIdentifier(callee) && callee.text === 'require') {
      const symbol = context.checker.getSymbolAtLocation(callee);
      const locallyDeclared = symbol?.declarations?.some(declaration => declaration.getSourceFile() === source) ?? false;
      if (!locallyDeclared) return { specifier: value.arguments[0].text, call: value, kind: 'require' };
    }
    return null;
  };
  const supportedModuleCalls = new Set<ts.CallExpression>();
  const propertyModuleCall = (expression: ts.Expression | undefined): { module: ReturnType<typeof moduleCall>; property: string } | null => {
    if (!expression) return null;
    const value = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(value)) {
      const module = moduleCall(value.expression);
      return module ? { module, property: value.name.text } : null;
    }
    if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteral(value.argumentExpression)) {
      const module = moduleCall(value.expression);
      return module ? { module, property: value.argumentExpression.text } : null;
    }
    return null;
  };
  const visitModuleBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      let module = moduleCall(node.initializer);
      const property = module ? null : propertyModuleCall(node.initializer);
      module ??= property?.module ?? null;
      if (module) {
        supportedModuleCalls.add(module.call);
        const sourceFile = resolveSpecifier(module.specifier);
        if (sourceFile && ts.isIdentifier(node.name)) {
          if (property) addBinding(property.property, node.name, sourceFile, true, false);
          else if (module.kind === 'import') addBinding('*', node.name, sourceFile, false, true);
          else addBinding('default', node.name, sourceFile, true, true);
        }
        if (sourceFile && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) if (ts.isIdentifier(element.name)) {
            const imported = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)) ? element.propertyName.text : element.name.text;
            addBinding(imported, element.name, sourceFile, true, false);
          }
        }
      }
    }
    ts.forEachChild(node, visitModuleBindings);
  };
  visitModuleBindings(source);
  const called: Array<{ imported: string; local: string; sourceFile: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const inlineModule = moduleCall(node.expression);
      if (inlineModule) {
        supportedModuleCalls.add(inlineModule.call);
        const sourceFile = resolveSpecifier(inlineModule.specifier);
        if (sourceFile && inlineModule.kind === 'require') called.push({ imported: 'default', local: 'default', sourceFile });
        else if (inlineModule.kind === 'import') bindingBlindSpots.push(`module namespace is not directly callable in ${file}`);
      }
      const directProperty = propertyModuleCall(node.expression);
      if (directProperty?.module) {
        supportedModuleCalls.add(directProperty.module.call);
        const sourceFile = resolveSpecifier(directProperty.module.specifier);
        if (sourceFile) called.push({ imported: directProperty.property, local: directProperty.property, sourceFile });
      }
      let target: ts.Identifier | null = null;
      let property: string | null = null;
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) target = callee;
      else if (ts.isPropertyAccessExpression(callee)) {
        const base = unwrapExpression(callee.expression);
        if (ts.isIdentifier(base)) { target = base; property = callee.name.text; }
      } else if (ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression)) {
        const base = unwrapExpression(callee.expression);
        if (ts.isIdentifier(base)) { target = base; property = callee.argumentExpression.text; }
      }
      if (target) {
        const targetSymbol = context.checker.getSymbolAtLocation(target);
        for (const binding of bindings.filter(candidate => candidate.local === target!.text)) {
          if (!targetSymbol) { bindingBlindSpots.push(`unresolved call binding ${target.text} in ${file}`); continue; }
          if (!binding.symbol || targetSymbol !== binding.symbol) continue;
          if (property === null && binding.direct) called.push({ imported: binding.imported, local: binding.local, sourceFile: binding.sourceFile });
          if (property === null && !binding.direct && binding.imported === '*') bindingBlindSpots.push(`module namespace is not directly callable in ${file}`);
          if (property !== null && binding.property) called.push({ imported: property, local: binding.local, sourceFile: binding.sourceFile });
        }
      }
      const possibleDynamic = unwrapExpression(node.expression);
      if (possibleDynamic.kind === ts.SyntaxKind.ImportKeyword && !supportedModuleCalls.has(node)) {
        bindingBlindSpots.push(`unsupported dynamic import shape in ${file}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const visitUnsupportedDynamicImports = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && unwrapExpression(node.expression).kind === ts.SyntaxKind.ImportKeyword && !supportedModuleCalls.has(node)) {
      bindingBlindSpots.push(`unsupported dynamic import shape in ${file}`);
    }
    ts.forEachChild(node, visitUnsupportedDynamicImports);
  };
  visitUnsupportedDynamicImports(source);
  return { imports: stableRows(imports), calledImports: stableRows(called), blindSpots: stable(bindingBlindSpots), unresolvedImports: stable(unresolved) };
}

function returnedHandlerKeysFromText(sourceText: string): string[] {
  const text = executableText(sourceText);
  const returnIndex = text.indexOf('return {');
  if (returnIndex < 0) return [];
  const body = text.slice(returnIndex + 'return {'.length);
  return stable([...body.matchAll(/^\s+([a-z][a-z0-9_]*)\s*(?:\([^\n]*\)\s*(?::[^\n{]+)?\{|:\s*)/gm)].map(match => match[1]));
}

function commandNamesForEntry(entry: ProcessFactRegistryEntry): string[] {
  const producerCommands = (entry.artifact?.producerCommand ?? '').split('/').filter(value => /^[a-z][a-z0-9_]*$/.test(value));
  return stable([...producerCommands, ...(/^[a-z][a-z0-9_]*$/.test(entry.name) ? [entry.name] : [])]);
}

function sourceSeedFiles(input: AcceptanceDiscoveryInput): string[] {
  return stable([
    ...input.scopeRefs.filter(ref => ref.startsWith('scope:file:')).map(ref => ref.slice('scope:file:'.length)),
    ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
  ]);
}

function buildBoundedSourceGraph(input: AcceptanceDiscoveryInput): BoundedSourceGraph {
  const root = input.workspaceRoot;
  const readContext = createSourceReadContext(root);
  const seedFiles = sourceSeedFiles(input);
  const sourceInventory = configuredSourceInventory(root, readContext);
  const blindSpots: string[] = [...sourceInventory.blindSpots];
  const registryCandidates = stable(['packages/main/src/registry.ts', ...PROCESS_FACT_REGISTRY.flatMap(sourceFiles)]);
  const analysisContext = createBindingAnalysisContext(root, stable([...sourceInventory.files, ...seedFiles, ...registryCandidates]), readContext);
  const registryFiles = registryCandidates.filter(file => file === 'packages/main/src/registry.ts'
    || executableText(analysisContext.sourceFiles.get(file)?.text ?? '').includes('registerBatch('));
  const factories: FactoryInventory[] = [];
  for (const registryFile of registryFiles) {
    const source = analysisContext.sourceFiles.get(registryFile);
    if (!source) { blindSpots.push(...(analysisContext.readBlindSpots.get(registryFile) ?? [`uninspectable registry source ${registryFile}`])); continue; }
    const text = executableText(source.text);
    const registryScan = analyzeLocalImportCalls(analysisContext, registryFile);
    blindSpots.push(...registryScan.blindSpots, ...registryScan.unresolvedImports);
    const imports = registryScan.imports;
    const registrations = new Set([...text.matchAll(/registry\.registerBatch\(\s*([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)\s*\)/g)].map(match => match[1]));
    for (const imported of imports.filter(item => /Handlers$/.test(item.imported) || /Handlers$/.test(item.local))) {
      if (!seedFiles.includes(imported.sourceFile)) continue;
      const registered = registrations.has(imported.local);
      const commandKeys = returnedHandlerKeysFromText(analysisContext.sourceFiles.get(imported.sourceFile)?.text ?? '');
      factories.push({ factory: imported.local, sourceFile: imported.sourceFile, registered, commandKeys });
      if (!registered) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} lacks exact registerBatch(factory(ctx))`);
      if (commandKeys.length === 0) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} has ambiguous or empty returned command object`);
    }
  }
  const handlerCommands = new Set(factories.flatMap(factory => factory.commandKeys));
  const inferredHandlerFiles = new Map<string, string>();
  for (const factory of factories) for (const command of factory.commandKeys) inferredHandlerFiles.set(command, factory.sourceFile);
  const entryFiles = (entry: ProcessFactRegistryEntry): string[] => stable([
    ...sourceFiles(entry),
    ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
  ]);
  const closure = new Set(seedFiles);
  const reached = new Set<ProcessFactRegistryEntry>();
  const hubs = new Set(registryFiles);
  const boundedUniverse = sourceInventory.files;
  const sourceScans = new Map(boundedUniverse.map(file => [file, analyzeLocalImportCalls(analysisContext, file)]));
  blindSpots.push(...[...sourceScans.values()].flatMap(scan => scan.blindSpots));
  const planControlFacts = new Set(['acceptance_basis', 'acceptance_basis_generate', 'acceptance_topology_check', 'artifact:acceptance-basis.json']);
  const preReviewControlFacts = new Set(['pre_review_check', 'pre_review_check_read', 'artifact:pre-review-check.json']);
  const phaseControlFacts = new Set([...planControlFacts, ...preReviewControlFacts, 'acceptance_topology_check',
    'topology_exclusion_approval_set', 'topology_critic_receipt_set', 'topology_critic_receipt_check',
    'artifact:topology-exclusion-approvals.json', 'artifact:topology-critic-receipt.json']);
  const allowedPhaseControlFacts = (input.phaseBasis ?? 'plan') === 'pre_review'
    ? new Set([...planControlFacts, ...preReviewControlFacts]) : planControlFacts;
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of PROCESS_FACT_REGISTRY) {
      if (phaseControlFacts.has(entry.name)) {
        if (!allowedPhaseControlFacts.has(entry.name)) continue;
      }
      const files = entryFiles(entry).filter(file => !hubs.has(file));
      const commandMatch = commandNamesForEntry(entry).some(command => handlerCommands.has(command));
      if (!commandMatch && !files.some(file => closure.has(file))) continue;
      if (!reached.has(entry)) { reached.add(entry); changed = true; }
      for (const file of files) if (!closure.has(file)) { closure.add(file); changed = true; }
    }
    for (const file of boundedUniverse.filter(file => !hubs.has(file) && !closure.has(file))) {
      if ((sourceScans.get(file)?.calledImports ?? []).some(item => closure.has(item.sourceFile))) { closure.add(file); changed = true; }
    }
  }
  for (const entry of reached) {
    for (const file of entryFiles(entry)) if (!existsSync(resolve(root, file))) blindSpots.push(`uninspectable registered source ${file} for ${entry.name}`);
    if (entry.consumerGate) {
      const explicitConsumer = (entry.consumerSourceRefs ?? []).some(file => existsSync(resolve(root, file)));
      const producerFiles = stable([
        ...(entry.producerSourceRefs ?? []),
        ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
      ]);
      const discoveredConsumer = sourceInventory.files.some(file => !hubs.has(file) && !producerFiles.includes(file)
        && (sourceScans.get(file)?.calledImports ?? []).some(item => producerFiles.includes(item.sourceFile)));
      if (!explicitConsumer && !discoveredConsumer) blindSpots.push(`process fact ${entry.name} has consumerGate but no resolvable consumer source`);
    }
  }
  for (const file of closure) if (!sourceScans.has(file)) sourceScans.set(file, analyzeLocalImportCalls(analysisContext, file));
  return {
    seedFiles, sourceInventoryFiles: sourceInventory.files, closureFiles: stable([...closure]), entries: [...reached], factories,
    sourceScans, blindSpots: stable(blindSpots), readContext, directoryFingerprints: sourceInventory.directoryFingerprints,
  };
}

/** Resolve canonical process-fact closure and its producer/consumer source files. */
function registeredProcessFactClosureFromGraph(graph: BoundedSourceGraph): RegisteredProcessFactClosure {
  const reached = graph.entries;
  return {
    pathRefs: stable(reached.map(processFactPath)),
    sourceInventoryRefs: stable(reached.flatMap(entry => [
      `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
      ...((entry.producerSourceRefs ?? []).map(file => `source-file:producer:${encodeURIComponent(entry.name)}:${file}`)),
      ...((entry.consumerSourceRefs ?? []).map(file => `source-file:consumer:${encodeURIComponent(entry.name)}:${file}`)),
      ...(entry.artifact ? [`artifact:${entry.artifact.path}`] : []),
    ]).concat(graph.closureFiles.map(file => `source-file:closure:${file}`), ['source-file:config:lattice.config.json'])),
    sourceFileRefs: graph.closureFiles,
    blindSpots: graph.blindSpots,
    entries: reached,
  };
}

export function deriveRegisteredProcessFactClosure(workspaceRoot: string, seedRefs: readonly string[]): RegisteredProcessFactClosure {
  const graph = buildBoundedSourceGraph({ supported: true, workspaceRoot, storyId: '<closure>', plannedPathRecords: [], scopeRefs: seedRefs.map(ref => ref.startsWith('scope:file:') ? ref : `scope:file:${ref}`) });
  return registeredProcessFactClosureFromGraph(graph);
}

function unsignedResult(result: CoverageAdapterResultV1): Omit<CoverageAdapterResultV1, 'resultDigest'> {
  const { resultDigest: _resultDigest, ...unsigned } = result;
  return unsigned;
}

export function digestCoverageAdapterResult(result: Omit<CoverageAdapterResultV1, 'resultDigest'>): string {
  return `sha256:${digestCanonicalJson(result)}`;
}

function adapterId(method: CoverageDiscoveryMethodV1): string {
  return `${method.replace(/_/g, '-')}:plan:v1`;
}

function sourceProvenance(context: SourceReadContext, file: string): string {
  try {
    const read = readSourceSafely(context, file);
    if (read.text === undefined) return `source-file:${file}:uninspectable`;
    const semanticDigest = context.semanticDigests.get(file);
    return semanticDigest
      ? `source-file:${file}:${semanticDigest}`
      : `source-file:${file}:sha256:${digestCanonicalJson(read.text)}`;
  } catch { return `source-file:${file}:uninspectable`; }
}

function executableText(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\b.*$/gm, '');
}

function catalogCommands(context: SourceReadContext): Set<string> {
  try {
    const read = readSourceSafely(context, 'packages/main/src/cli/command-catalog.ts');
    if (read.text === undefined) return new Set();
    return new Set([...executableText(read.text).matchAll(/^\s*\{?\s*name:\s*['"]([a-z][a-z0-9_]*)['"]/gm)].map(match => match[1]));
  }
  catch { return new Set(); }
}

function staticCallPaths(root: string, graph: BoundedSourceGraph): { paths: string[]; blindSpots: string[] } {
  const paths: string[] = [];
  const blindSpots: string[] = [];
  for (const file of graph.closureFiles.filter(value => !value.endsWith('/registry.ts'))) {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) continue;
    const scan = graph.sourceScans.get(file);
    if (!scan) { blindSpots.push(`source file lacks binding analysis context: ${file}`); continue; }
    blindSpots.push(...scan.blindSpots, ...scan.unresolvedImports);
    for (const imported of scan.calledImports) {
      if (!graph.closureFiles.includes(imported.sourceFile) || /Handlers$/.test(imported.imported)) continue;
      paths.push(`path:static-call:${imported.sourceFile}#${imported.imported}->consumer:${file}#${imported.local}`);
    }
  }
  return { paths: stable(paths), blindSpots: stable(blindSpots) };
}

function sourceExactSymbolCount(file: string, text: string, expected: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  let count = 0;
  const named = (name: ts.PropertyName | ts.BindingName | undefined): boolean => {
    if (!name) return false;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === expected;
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name?.text === expected) count += 1;
    else if (ts.isVariableDeclaration(node) && named(node.name)) count += 1;
    else if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && named(node.name)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function actualEndpointPathRefs(input: AcceptanceDiscoveryInput, graph: BoundedSourceGraph): string[] {
  const refs: string[] = [];
  for (const record of input.plannedPathRecords) {
    for (const endpoint of [record.producer, ...record.consumers]) {
      const actualRef = `actual:${endpoint.expectedArtifactKind}:${endpoint.expectedFileRef}#${endpoint.expectedSymbolOrFact}`;
      if (endpoint.expectedArtifactKind === 'process_fact') {
        if (graph.entries.some(entry => entry.name === endpoint.expectedSymbolOrFact
          && sourceFiles(entry).includes(endpoint.expectedFileRef))) refs.push(actualRef);
        continue;
      }
      const sourceText = graph.readContext.snapshots.get(endpoint.expectedFileRef);
      if (sourceText !== undefined && sourceExactSymbolCount(endpoint.expectedFileRef, sourceText, endpoint.expectedSymbolOrFact) === 1) refs.push(actualRef);
    }
  }
  return stable(refs);
}

function buildResult(
  input: AcceptanceDiscoveryInput,
  method: CoverageDiscoveryMethodV1,
  prebuiltGraph?: BoundedSourceGraph,
): CoverageAdapterResultV1 {
  const unsupported = !input.supported;
  const boundedRuntime = method === 'runtime_trace';
  let pathRefs: string[] = [];
  let blindSpots: string[] = [];
  let provenanceRefs: string[] = [];
  if (!unsupported) {
    const graph = prebuiltGraph ?? buildBoundedSourceGraph(input);
    if (method === 'scope_contract') {
      pathRefs = input.plannedPathRecords.map(record => record.plannedPathRef);
      provenanceRefs = stable([
        ...input.scopeRefs,
        ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers])
          .map(endpoint => sourceProvenance(graph.readContext, endpoint.expectedFileRef)),
      ]);
    } else if (method === 'process_fact_registry') {
      pathRefs = graph.entries.map(processFactPath);
      blindSpots = graph.blindSpots;
      provenanceRefs = stable(graph.entries.flatMap(entry => [`process-fact:${entry.name}:${digestCanonicalJson(entry)}`, ...sourceFiles(entry).map(file => sourceProvenance(graph.readContext, file))]));
    } else if (method === 'handler_dispatch_inventory') {
      const commands = catalogCommands(graph.readContext);
      const registeredKeys = new Set(graph.factories.filter(factory => factory.registered).flatMap(factory => factory.commandKeys));
      const inspectableEntries = graph.entries.filter(entry => commandNamesForEntry(entry).some(command => registeredKeys.has(command) && commands.has(command)));
      pathRefs = inspectableEntries.map(processFactPath);
      blindSpots = stable([
        ...graph.blindSpots,
        ...graph.factories.filter(factory => !factory.registered).map(factory => `unregistered handler factory ${factory.factory}`),
        ...[...registeredKeys].filter(command => !commands.has(command)).map(command => `registered handler command ${command} has no exact command catalog binding`),
        ...graph.entries.filter(entry => commandNamesForEntry(entry).length > 0 && !inspectableEntries.includes(entry)).map(entry => `registered process fact ${entry.name} has no exact registered handler/catalog dispatch`),
      ]);
      provenanceRefs = stable(['packages/main/src/cli/command-catalog.ts', 'packages/main/src/registry.ts', ...graph.factories.map(factory => factory.sourceFile)]
        .map(file => sourceProvenance(graph.readContext, file)));
    } else if (method === 'static_call_graph') {
      const inspectableEntries = graph.entries.filter(entry => sourceFiles(entry).every(file => existsSync(resolve(input.workspaceRoot, file))));
      const staticCalls = staticCallPaths(input.workspaceRoot, graph);
      pathRefs = inspectableEntries.map(processFactPath);
      pathRefs.push(...staticCalls.paths);
      if (input.phaseBasis === 'pre_review') pathRefs.push(...actualEndpointPathRefs(input, graph));
      blindSpots = stable([...graph.blindSpots, ...staticCalls.blindSpots, ...graph.entries.filter(entry => !inspectableEntries.includes(entry)).map(entry => `static registered source graph is incomplete for ${entry.name}`)]);
      provenanceRefs = stable(graph.closureFiles.map(file => sourceProvenance(graph.readContext, file)));
    } else {
      pathRefs = stable(input.runtimeObservedPathRefs ?? []);
      provenanceRefs = [
        `runtime-fact-registry:sha256:${digestCanonicalJson(RUNTIME_FACT_REGISTRY)}`,
        `runtime-trace:story:${input.storyId}:bounded`,
      ];
    }
    if (method !== 'runtime_trace') {
      provenanceRefs = stable([...provenanceRefs, sourceProvenance(graph.readContext, 'lattice.config.json')]);
      const blockingReadFailures = [...graph.readContext.failures.values()].filter(message => /budget|no-follow/.test(message));
      blindSpots = stable([...blindSpots, ...blockingReadFailures]);
    }
  }
  const unsigned: Omit<CoverageAdapterResultV1, 'resultDigest'> = {
    schemaVersion: 'proofstory.coverage_adapter_result.v1',
    adapterId: adapterId(method),
    method,
    pathRefs: stable(pathRefs),
    coverageClaim: unsupported ? 'unsupported' : blindSpots.length > 0 ? 'partial' : 'complete_for_scope',
    blindSpots: unsupported ? [`unsupported discovery profile for ${method}`] : stable(blindSpots),
    provenanceRefs: stable(provenanceRefs.length > 0 ? provenanceRefs : [`registered:${method}:v1`]),
    asymmetryPolicy: {
      kind: unsupported ? 'unsupported' : boundedRuntime ? 'bounded_non_exhaustive' : 'exhaustive',
      policyRef: unsupported ? 'policy:unsupported:v1' : boundedRuntime ? 'policy:bounded-runtime:v1' : `policy:${method}:v1`,
      scopeRefs: stable(input.scopeRefs),
    },
  };
  return { ...unsigned, resultDigest: digestCoverageAdapterResult(unsigned) };
}

/** Run the immutable PLAN profile from canonical repository and registry inputs. */
export function runAcceptanceDiscoveryAdapters(input: AcceptanceDiscoveryInput): CoverageAdapterResultV1[] {
  const graph = input.supported ? buildBoundedSourceGraph(input) : undefined;
  return ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method, graph));
}

/** One immutable source snapshot shared by closure discovery, adapter provenance, and receipt hashing. */
export function runAcceptanceDiscoverySnapshot(input: AcceptanceDiscoveryInput): AcceptanceDiscoverySnapshot {
  if (!input.supported) {
    return {
      adapterResults: ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method)),
      registeredClosure: { pathRefs: [], sourceInventoryRefs: [], sourceFileRefs: [], blindSpots: [], entries: [] },
      sourceSnapshots: [],
      sourceReadBlindSpots: [],
      seal: additionalIssues => sealSourceAssembly(createSourceReadContext(input.workspaceRoot), [], additionalIssues),
      immediatelyBeforeFinalSeal: input.testHooks?.immediatelyBeforeFinalSeal,
    };
  }
  const graph = buildBoundedSourceGraph(input);
  const adapterResults = ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method, graph));
  return {
    adapterResults,
    registeredClosure: registeredProcessFactClosureFromGraph(graph),
    sourceSnapshots: stable([...graph.readContext.snapshots.keys()]).map(canonicalFile => {
      const content = graph.readContext.snapshots.get(canonicalFile)!;
      return { canonicalFile, contentDigest: digestText(content), content };
    }),
    sourceReadBlindSpots: stable([...graph.readContext.failures.values()]),
    seal: additionalIssues => sealSourceAssembly(graph.readContext, graph.directoryFingerprints, additionalIssues),
    immediatelyBeforeFinalSeal: input.testHooks?.immediatelyBeforeFinalSeal,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function reconcileAcceptanceDiscoveryResults(results: readonly CoverageAdapterResultV1[]): AcceptanceDiscoveryReconciliation {
  const diagnostics: AcceptanceDiscoveryDiagnostic[] = [];
  const byMethod = new Map<CoverageDiscoveryMethodV1, CoverageAdapterResultV1[]>();
  for (const result of results) {
    const rows = byMethod.get(result.method) ?? [];
    rows.push(result);
    byMethod.set(result.method, rows);
    if (result.schemaVersion !== 'proofstory.coverage_adapter_result.v1' || !result.adapterId || !Array.isArray(result.provenanceRefs) || result.provenanceRefs.length === 0
      || !['complete_for_scope', 'partial', 'unsupported'].includes(result.coverageClaim)
      || !['exhaustive', 'bounded_non_exhaustive', 'unsupported'].includes(result.asymmetryPolicy?.kind)
      || typeof result.asymmetryPolicy?.policyRef !== 'string' || result.asymmetryPolicy.policyRef.trim().length === 0
      || !Array.isArray(result.asymmetryPolicy?.scopeRefs) || result.asymmetryPolicy.scopeRefs.length === 0) {
      diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', adapterId: result.adapterId, message: `invalid adapter result ${result.adapterId || '<missing>'}` });
    }
    if (digestCoverageAdapterResult(unsignedResult(result)) !== result.resultDigest) diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', adapterId: result.adapterId, message: `adapter result digest mismatch: ${result.adapterId}` });
  }
  for (const method of ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods) {
    const rows = byMethod.get(method) ?? [];
    if (rows.length !== 1) diagnostics.push({ code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING', message: `registered profile requires exactly one ${method} result; observed ${rows.length}`, adapterId: adapterId(method) });
  }
  const staticResult = byMethod.get('static_call_graph')?.[0];
  const runtimeResult = byMethod.get('runtime_trace')?.[0];
  if (staticResult && runtimeResult && !sameSet(staticResult.pathRefs, runtimeResult.pathRefs) && runtimeResult.asymmetryPolicy.kind !== 'bounded_non_exhaustive') {
    diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'static/runtime path disagreement lacks bounded runtime asymmetry policy' });
  }
  const registryResult = byMethod.get('process_fact_registry')?.[0];
  const dispatchResult = byMethod.get('handler_dispatch_inventory')?.[0];
  const registryProcessPaths = registryResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  const dispatchProcessPaths = dispatchResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  if (registryResult && dispatchResult && !sameSet(registryProcessPaths, dispatchProcessPaths)) diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'process-fact and handler/dispatch discovery disagree' });
  const enumeratedPathRefs = stable(results.flatMap(result => result.pathRefs));
  const blindSpots = stable(results.flatMap(result => result.blindSpots));
  const unsupported = results.some(result => result.coverageClaim === 'unsupported' || result.asymmetryPolicy.kind === 'unsupported');
  const partial = diagnostics.length > 0 || blindSpots.length > 0 || results.some(result => result.coverageClaim === 'partial');
  return { adapterResults: [...results].sort((a, b) => compareCodeUnits(a.adapterId, b.adapterId)), enumeratedPathRefs, blindSpots,
    diagnostics: diagnostics.sort((a, b) => compareCodeUnits(`${a.code}:${a.adapterId ?? ''}:${a.message}`, `${b.code}:${b.adapterId ?? ''}:${b.message}`)),
    status: unsupported ? 'unsupported' : partial ? 'partial' : 'complete' };
}

export function discoveryProfileDigest(): string {
  return `sha256:${digestCanonicalJson(ACCEPTANCE_PLAN_DISCOVERY_PROFILE)}`;
}
