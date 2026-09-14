import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readdirSync, readSync, realpathSync, type Dir, type Dirent, type Stats } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  AcceptanceSnapshotSealIssueV1,
  AcceptanceSnapshotSealV1,
  CoverageAdapterResultV1,
  CoverageDiscoveryMethodV1,
  PlannedCoveragePathV1,
  VerificationPlannedPathEndpointV1,
} from './types.js';
import { digestCanonicalJson, digestText } from './digest.js';
import { PROCESS_FACT_REGISTRY, type ProcessFactRegistryEntry } from './process-fact-registry.js';
import { RUNTIME_FACT_REGISTRY } from './runtime-fact-registry.js';
import { PROOF_OR_STOP_STORY_DIR } from './proof-or-stop-paths.js';
import { CONFIG_FILENAMES, STATE_DIR_NAMES, resolveConfigFilename } from './brand-paths.js';

export const ACCEPTANCE_PLAN_DISCOVERY_PROFILE = {
  ref: 'profile:typescript-proof-gate:plan:v1',
  methods: ['scope_contract', 'process_fact_registry', 'handler_dispatch_inventory', 'static_call_graph', 'runtime_trace'] as CoverageDiscoveryMethodV1[],
} as const;

export const ACCEPTANCE_GO_COMMAND_PROFILE = {
  ref: 'profile:go-command:v1',
  methods: ['registered_command_receipts'] as CoverageDiscoveryMethodV1[],
} as const;

export type AcceptanceVerificationProfile = 'typescript-topology' | 'go-command' | 'unsupported';

type NestedTypeScriptScan = 'found' | 'exhaustively_absent' | 'inconclusive';

/** Strict TypeScript discovery wins for mixed workspaces; pure Go gets command-receipt admission. */
export function resolveAcceptanceVerificationProfile(workspaceRoot: string): AcceptanceVerificationProfile {
  if (detectAcceptanceDiscoverySupport(workspaceRoot)) return 'typescript-topology';
  const ignored = new Set(['.git', '.worktrees', 'node_modules', 'vendor', 'dist', 'build']);
  let visited = 0;
  const nestedTypeScript = (directory: string, depth: number): NestedTypeScriptScan => {
    if (depth > 6 || visited >= 4_096) return 'inconclusive';
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return 'inconclusive'; }
    let incomplete = false;
    for (const entry of entries) {
      visited += 1;
      if (visited > 4_096) return 'inconclusive';
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === 'tsconfig.json') return 'found';
      if (entry.isDirectory() && !ignored.has(entry.name)) {
        const nested = nestedTypeScript(join(directory, entry.name), depth + 1);
        if (nested === 'found') return 'found';
        if (nested === 'inconclusive') incomplete = true;
      }
    }
    return incomplete ? 'inconclusive' : 'exhaustively_absent';
  };
  const typeScriptScan = nestedTypeScript(workspaceRoot, 0);
  if (typeScriptScan === 'found') return 'typescript-topology';
  if (typeScriptScan === 'inconclusive') return 'unsupported';
  try {
    const goMod = lstatSync(resolve(workspaceRoot, 'go.mod'));
    if (goMod.isFile() && !goMod.isSymbolicLink()) return 'go-command';
  } catch { /* no bounded Go capability */ }
  return 'unsupported';
}

export function acceptanceDiscoveryProfile(profile: AcceptanceVerificationProfile) {
  return profile === 'go-command' ? ACCEPTANCE_GO_COMMAND_PROFILE : ACCEPTANCE_PLAN_DISCOVERY_PROFILE;
}

const PLAN_CONTROL_FACT_NAMES = ['acceptance_basis', 'acceptance_basis_generate', 'acceptance_topology_check', 'artifact:acceptance-basis.json'] as const;
const PRE_REVIEW_CONTROL_FACT_NAMES = ['pre_review_check', 'pre_review_check_read', 'artifact:pre-review-check.json'] as const;

/** Canonical phase in which a discovery control fact first becomes material. */
export function acceptanceDiscoveryFactActivationPhase(factName: string): 'plan' | 'pre_review' | null {
  if ((PLAN_CONTROL_FACT_NAMES as readonly string[]).includes(factName)) return 'plan';
  if ((PRE_REVIEW_CONTROL_FACT_NAMES as readonly string[]).includes(factName)) return 'pre_review';
  return null;
}

export interface AcceptanceDiscoveryInput {
  supported: boolean;
  verificationProfile?: AcceptanceVerificationProfile;
  workspaceRoot: string;
  storyId: string;
  plannedPathRecords: PlannedCoveragePathV1[];
  scopeRefs: string[];
  /** Canonical topology refs that require registry closure even across scope. */
  topologyPathRefs?: string[];
  /** Compatibility-only helper mode for explicitly requesting a whole seeded handler factory. */
  expandSeedHandlerCommands?: boolean;
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

function isResolvableRegularSourceFile(root: string, file: string): boolean {
  try { return lstatSync(resolve(root, file)).isFile(); }
  catch { return false; }
}

function isExistingDirectory(root: string, file: string): boolean {
  try { return lstatSync(resolve(root, file)).isDirectory(); }
  catch { return false; }
}

function sourceFileRefs(root: string, files: readonly string[]): string[] {
  return stable(files.filter(file => {
    try {
      // Follow neither directory symlinks nor file symlinks. Missing references
      // stay in the candidate set so the existing unreadable-source diagnostic
      // remains observable to the acceptance gate.
      return lstatSync(resolve(root, file)).isFile();
    } catch {
      return true;
    }
  }));
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

interface HandlerFactoryResolution {
  commandKeys: string[];
  blindSpots: string[];
}

interface BoundedSourceGraph {
  seedFiles: string[];
  sourceInventoryFiles: string[];
  closureFiles: string[];
  entries: ProcessFactRegistryEntry[];
  factories: FactoryInventory[];
  sourceScans: Map<string, LocalImportCallScan>;
  sourceFiles: Map<string, ts.SourceFile>;
  checker: ts.TypeChecker;
  blindSpots: string[];
  readContext: SourceReadContext;
  directoryFingerprints: DirectoryFingerprint[];
}

interface LocalImportCallScan {
  imports: Array<{ imported: string; local: string; sourceFile: string }>;
  contractImports: Array<{ imported: string; local: string; sourceFile: string; typeOnly: boolean }>;
  calledImports: Array<{ imported: string; local: string; sourceFile: string; caller: string | null }>;
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
// B-cc10 CHK-002: state-dir spellings from the resolver, so the source inventory
// keeps excluding the state directory across the rename.
const SOURCE_INVENTORY_EXCLUDED_DIRECTORIES = new Set([
  '.git', ...STATE_DIR_NAMES, '.worktrees', 'dist', 'node_modules',
]);
const GENERATED_PROOF_ARTIFACT_BASENAMES = new Set([
  'acceptance-basis.json',
  'pre-review-check.json',
  'topology-critic-receipt.json',
  'topology-exclusion-approvals.json',
]);
const DEFAULT_SOURCE_INVENTORY_BUDGET = {
  maxDirectories: 10_000,
  maxEntries: 100_000,
  maxFiles: 20_000,
  maxBytes: 100 * 1024 * 1024,
} as const;
const MAX_LEXICAL_SOURCE_BYTES = 2 * 1024 * 1024;

function supportsBindingAnalysis(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
}

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

// The repository's policy-rich canonical config is currently larger than
// 64 KiB. A 128 KiB single-file ceiling admits that real authority source while
// remaining independently bounded well below the 2 MiB lexical-source limit
// and the 100 MiB aggregate inventory budget.
// The approved root ownership policy is larger than 128 KiB. Keep the
// config bounded by the existing per-source read ceiling, not an unbounded read.
export const MAX_PROOF_OR_STOP_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Which project-config spelling this snapshot should read (B-cc10 CHK-004).
 *
 * The probe goes through `readSourceSafely` — the SAME hardened reader that does
 * the real read — because that reader rejects any path whose spelling differs
 * from the canonical physical path on disk (see the `canonicalFile !==
 * relativePath` guard). Probing with `existsSync` instead could answer "present"
 * for a spelling the reader would then refuse, so the probe has to bind to the
 * reader that follows it.
 *
 * The resolved name is then used for the read, for the `semanticDigests` key,
 * for the seal's `canonicalRef` and for the fingerprint filter, so all four stay
 * consistent with whichever spelling actually resolved. Hardcoding the
 * deprecated literal in any one of them is the B-cdf6 F-065/F-061 failure shape:
 * the CANONICAL name would silently stop being recognized while the deprecated
 * one kept working.
 *
 * Note this deliberately reuses the passed context so the probe's own snapshot /
 * failure bookkeeping is shared with the subsequent read rather than duplicated.
 */
function resolveSnapshotConfigFilename(context: SourceReadContext): string {
  // B-cc10: prefer a spelling that is PRESENT on disk, even if reading it safely fails.
  // readSourceSafely deliberately refuses symlinks, so probing by readability alone made a
  // symlinked config look ABSENT: the resolver fell through to the other spelling, and the
  // reported blind spot became `snapshot_missing: <other name>` instead of the real
  // "traverses symlink" refusal. Presence-first keeps the specific diagnosis attached to the
  // file the operator actually has.
  const presentByLstat = (name: string): boolean => {
    try { lstatSync(join(context.physicalRoot, name)); return true; } catch { return false; }
  };
  const resolved = resolveConfigFilename(
    (name) => presentByLstat(name)
      || readSourceSafely(context, name, MAX_PROOF_OR_STOP_CONFIG_BYTES).text !== undefined,
  );
  // Probing a spelling that is simply ABSENT is not a blind spot — it is the
  // expected outcome for the name this project does not use. Drop those cached
  // probe failures so a migrated project does not report a permanent
  // `snapshot_missing` / unreadable-config issue for the deprecated name it
  // correctly no longer has. Mirrors the existing profileCandidates cleanup.
  //
  // B-cc10 follow-up: only drop failures for names that are genuinely ABSENT. The
  // previous form deleted the cached failure for EVERY non-resolved spelling, which
  // also erased real blind spots — an existing-but-unreadable config (e.g. over
  // MAX_PROOF_OR_STOP_CONFIG_BYTES) had its oversize failure silently discarded, so the
  // bounded-read blind spot never surfaced. Absence is expected; unreadable is not.
  for (const name of CONFIG_FILENAMES) {
    if (name === resolved) continue;
    // lstat, NOT existsSync: this reader is deliberately no-follow, and existsSync
    // resolves symlinks — a dangling/foreign symlink would look ABSENT and have its
    // real safe-read failure discarded, which is the same blind spot in another guise.
    let present = false;
    try { lstatSync(join(context.physicalRoot, name)); present = true; } catch { present = false; }
    if (!present) context.failures.delete(name);
  }
  return resolved;
}

/**
 * Detect the TypeScript discovery profile from no-follow workspace snapshots.
 * A repository-level tsconfig remains valid; package layouts may instead put
 * the canonical tsconfig at proofOrStop.config.scanRoot. Unsafe or ambiguous
 * config paths never become support authority.
 */
export function detectAcceptanceDiscoverySupport(workspaceRoot: string): boolean {
  const rootContext = createSourceReadContext(workspaceRoot);
  if (readSourceSafely(rootContext, 'tsconfig.json').text !== undefined) return true;
  const configContext = createSourceReadContext(workspaceRoot);
  const configRead = readSourceSafely(configContext, resolveSnapshotConfigFilename(configContext), MAX_PROOF_OR_STOP_CONFIG_BYTES);
  if (configRead.text === undefined) return false;
  try {
    const parsed = JSON.parse(configRead.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const config = parsed as Record<string, unknown>;
    const scanRoot = config.scanRoot;
    const rootDir = config.rootDir;
    if (typeof scanRoot !== 'string' || scanRoot.trim().length === 0
      || isAbsolute(scanRoot) || scanRoot.split(/[\\/]/).includes('..')
      || (rootDir !== undefined && (typeof rootDir !== 'string' || rootDir.trim().length === 0
        || isAbsolute(rootDir) || rootDir.split(/[\\/]/).includes('..')))) return false;
    const candidate = join(scanRoot, 'tsconfig.json');
    return readSourceSafely(configContext, candidate).text !== undefined;
  } catch { return false; }
}

function configuredSourceInventory(workspaceRoot: string, readContext: SourceReadContext): { files: string[]; blindSpots: string[]; directoryFingerprints: DirectoryFingerprint[] } {
  let rawConfig: Record<string, unknown>;
  const configFilename = resolveSnapshotConfigFilename(readContext);
  try {
    const read = readSourceSafely(readContext, configFilename, MAX_PROOF_OR_STOP_CONFIG_BYTES);
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
  const profileCandidates = stable(['tsconfig.json', join(configuredScanRoot, 'tsconfig.json')]);
  let profileMarker: string | null = null;
  for (const candidate of profileCandidates) {
    if (readSourceSafely(readContext, candidate).text !== undefined) {
      profileMarker = candidate;
      break;
    }
  }
  if (!profileMarker) return { files: [], blindSpots: ['canonical TypeScript profile marker is missing or unreadable'], directoryFingerprints: [] };
  for (const candidate of profileCandidates) if (candidate !== profileMarker) readContext.failures.delete(candidate);
  // Only the fields that choose discovery scope belong to the cross-run basis
  // identity. The raw file fingerprint is still retained and revalidated below
  // during this assembly, so a concurrent config mutation remains fail-closed.
  // Lifecycle rollout fields (for example proofStory.acceptanceTopologyGateMode)
  // must not
  // change the structural inventory they merely decide whether to block on.
  readContext.semanticDigests.set(configFilename, `sha256:${digestCanonicalJson({
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
  // B-cc10 CHK-004: which config spelling this snapshot actually read is decided
  // by the context's own fingerprints, NOT by re-probing the filesystem. The seal
  // must describe the snapshot it is sealing; re-probing could name a spelling
  // this context never read (or that appeared mid-assembly) and would silently
  // split the config out of `fileProjection` under one name while looking it up
  // under another. Falling back to the canonical name keeps the both-absent case
  // reporting `snapshot_missing` against the name a project should have.
  const configFilename = CONFIG_FILENAMES.find(name => context.fingerprints.has(name))
    ?? resolveConfigFilename(() => false);
  const fileProjection = stable([...context.fingerprints.keys()]).filter(file => file !== configFilename).map(file => {
    const fingerprint = context.fingerprints.get(file)!;
    return { canonicalRef: file, size: fingerprint.size, contentDigest: fingerprint.contentDigest };
  });
  const configFingerprint = context.fingerprints.get(configFilename);
  const issues: AcceptanceSnapshotSealIssueV1[] = [...additionalIssues];
  for (const fingerprint of directories) {
    if (!revalidateDirectoryFingerprint(fingerprint)) issues.push({ code: 'directory_changed', targetKind: 'directory', canonicalRef: relativeFile(context.physicalRoot, fingerprint.path) ?? fingerprint.path });
  }
  for (const file of stable([...context.fingerprints.keys()])) {
    const code = revalidateFileFingerprint(context, context.fingerprints.get(file)!);
    if (code) issues.push({ code, targetKind: file === configFilename ? 'config' : 'source_file', canonicalRef: file });
  }
  if (directories.length === 0) issues.push({ code: 'inventory_unsealable', targetKind: 'inventory', canonicalRef: 'configured-source-root' });
  if (!configFingerprint) issues.push({ code: 'snapshot_missing', targetKind: 'config', canonicalRef: configFilename });
  const stableIssues = [...new Map(issues.map(issue => [`${issue.code}\0${issue.targetKind}\0${issue.canonicalRef}`, issue])).values()]
    .sort((left, right) => compareCodeUnits(`${left.code}:${left.targetKind}:${left.canonicalRef}`, `${right.code}:${right.targetKind}:${right.canonicalRef}`));
  const unsigned: Omit<AcceptanceSnapshotSealV1, 'sealDigest'> = {
    schemaVersion: 'proofstory.acceptance_snapshot_seal.v1',
    inventoryDirectoryDigest: `sha256:${digestCanonicalJson(directoryProjection)}`,
    inventoryDirectoryCount: directoryProjection.length,
    sourceSnapshotDigest: `sha256:${digestCanonicalJson(fileProjection)}`,
    sourceSnapshotCount: fileProjection.length,
    configSnapshotDigest: `sha256:${digestCanonicalJson(configFingerprint ? {
      canonicalRef: configFilename,
      contentDigest: context.semanticDigests.get(configFilename) ?? configFingerprint.contentDigest,
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
    // Non-code process-fact assets still participate in the immutable freshness
    // snapshot, but they are not TypeScript programs and must not create parser
    // blind spots merely by entering the registered closure.
    if (!supportsBindingAnalysis(file)) continue;
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
  const programSourceFiles = new Map<string, ts.SourceFile>();
  for (const [file, source] of sourceFiles) {
    const programSource = program.getSourceFile(source.fileName);
    if (programSource) programSourceFiles.set(file, programSource);
  }
  return { root, physicalRoot, sourceFiles: programSourceFiles, readBlindSpots, checker: program.getTypeChecker(), readContext };
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
  if (!source) return { imports: [], contractImports: [], calledImports: [], blindSpots: context.readBlindSpots.get(file) ?? [`uninspectable source file ${file}`], unresolvedImports: [] };
  const text = source.text;
  if (Buffer.byteLength(text, 'utf8') > MAX_LEXICAL_SOURCE_BYTES) {
    return { imports: [], contractImports: [], calledImports: [], blindSpots: [`source file exceeds lexical scan budget: ${file}`], unresolvedImports: [] };
  }
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return { imports: [], contractImports: [], calledImports: [], blindSpots: [`typescript parse ambiguity in ${file}`], unresolvedImports: [] };
  }
  const imports: Array<{ imported: string; local: string; sourceFile: string }> = [];
  const contractImports: Array<{ imported: string; local: string; sourceFile: string; typeOnly: boolean }> = [];
  const unresolved: string[] = [];
  const bindingBlindSpots: string[] = [];
  const bindings: Array<{ imported: string; local: string; sourceFile: string; node: ts.Identifier; direct: boolean; property: boolean; typeOnly: boolean; symbol?: ts.Symbol }> = [];
  const addBinding = (imported: string, node: ts.Identifier, sourceFile: string, direct: boolean, property: boolean, typeOnly = false): void => {
    const row = { imported, local: node.text, sourceFile, node, direct, property, typeOnly, symbol: context.checker.getSymbolAtLocation(node) };
    contractImports.push({ imported, local: node.text, sourceFile, typeOnly });
    if (!typeOnly) imports.push({ imported, local: node.text, sourceFile });
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
      if (clause?.name) addBinding('default', clause.name, sourceFile, true, true, clause.isTypeOnly);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) addBinding(
          element.propertyName?.text ?? element.name.text,
          element.name,
          sourceFile,
          true,
          false,
          clause.isTypeOnly || element.isTypeOnly,
        );
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addBinding('*', clause.namedBindings.name, sourceFile, false, true, clause.isTypeOnly);
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
  const callerFor = (node: ts.Node): string | null => {
    const propertyName = (name: ts.PropertyName | undefined): string | null => {
      if (!name) return null;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
      return null;
    };
    let current: ts.Node | undefined = node;
    while (current && current !== source) {
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if (ts.isMethodDeclaration(current)) return propertyName(current.name);
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)
        && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isPropertyAssignment(current.parent)) {
        return propertyName(current.parent.name);
      }
      current = current.parent;
    }
    return null;
  };
  const called: Array<{ imported: string; local: string; sourceFile: string; caller: string | null }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const inlineModule = moduleCall(node.expression);
      if (inlineModule) {
        supportedModuleCalls.add(inlineModule.call);
        const sourceFile = resolveSpecifier(inlineModule.specifier);
        if (sourceFile && inlineModule.kind === 'require') called.push({ imported: 'default', local: 'default', sourceFile, caller: callerFor(node) });
        else if (inlineModule.kind === 'import') bindingBlindSpots.push(`module namespace is not directly callable in ${file}`);
      }
      const directProperty = propertyModuleCall(node.expression);
      if (directProperty?.module) {
        supportedModuleCalls.add(directProperty.module.call);
        const sourceFile = resolveSpecifier(directProperty.module.specifier);
        if (sourceFile) called.push({ imported: directProperty.property, local: directProperty.property, sourceFile, caller: callerFor(node) });
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
          if (property === null && binding.direct) called.push({ imported: binding.imported, local: binding.local, sourceFile: binding.sourceFile, caller: callerFor(node) });
          if (property === null && !binding.direct && binding.imported === '*') bindingBlindSpots.push(`module namespace is not directly callable in ${file}`);
          if (property !== null && binding.property) called.push({ imported: property, local: binding.local, sourceFile: binding.sourceFile, caller: callerFor(node) });
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
  return {
    imports: stableRows(imports),
    contractImports: [...new Map(contractImports.map(row => [`${row.sourceFile}\0${row.imported}\0${row.local}\0${row.typeOnly}`, row])).values()]
      .sort((left, right) => compareCodeUnits(`${left.sourceFile}:${left.imported}:${left.local}:${left.typeOnly}`, `${right.sourceFile}:${right.imported}:${right.local}:${right.typeOnly}`)),
    calledImports: stableRows(called),
    blindSpots: stable(bindingBlindSpots),
    unresolvedImports: stable(unresolved),
  };
}

function resolveHandlerFactoryKeys(
  context: BindingAnalysisContext,
  sourceFile: string,
  factoryName: string,
  visiting = new Set<string>(),
  memo = new Map<string, HandlerFactoryResolution>(),
): HandlerFactoryResolution {
  const identity = `${sourceFile}#${factoryName}`;
  const cached = memo.get(identity);
  if (cached) return cached;
  if (!/^[A-Za-z_$][\w$]*Handlers$/.test(factoryName)) {
    return { commandKeys: [], blindSpots: [`unsupported handler factory name ${identity}`] };
  }
  if (visiting.has(identity)) {
    return { commandKeys: [], blindSpots: [`handler factory spread cycle at ${identity}`] };
  }
  const source = context.sourceFiles.get(sourceFile);
  if (!source) {
    return { commandKeys: [], blindSpots: context.readBlindSpots.get(sourceFile) ?? [`handler factory source is uninspectable: ${identity}`] };
  }
  const declarations = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName && statement.body !== undefined);
  if (declarations.length !== 1) {
    const result = { commandKeys: [], blindSpots: [`handler factory declaration is ${declarations.length === 0 ? 'missing' : 'ambiguous'}: ${identity}`] };
    memo.set(identity, result);
    return result;
  }
  const returns = declarations[0].body!.statements
    .filter((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && statement.expression !== undefined)
    .map(statement => unwrapExpression(statement.expression!))
    .filter(ts.isObjectLiteralExpression);
  if (returns.length !== 1) {
    const result = { commandKeys: [], blindSpots: [`handler factory returned command object is ${returns.length === 0 ? 'missing' : 'ambiguous'}: ${identity}`] };
    memo.set(identity, result);
    return result;
  }
  const keys: string[] = [];
  const blindSpots: string[] = [];
  const propertyName = (name: ts.PropertyName | undefined): string | null => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  };
  visiting.add(identity);
  for (const property of returns[0].properties) {
    if (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const key = propertyName(property.name);
      if (key && /^[a-z][a-z0-9_]*$/.test(key)) keys.push(key);
      continue;
    }
    if (!ts.isSpreadAssignment(property)) continue;
    const spread = unwrapExpression(property.expression);
    if (!ts.isCallExpression(spread) || spread.arguments.length !== 1
      || !ts.isIdentifier(spread.arguments[0]) || spread.arguments[0].text !== 'ctx'
      || !ts.isIdentifier(unwrapExpression(spread.expression))) {
      blindSpots.push(`unsupported handler factory spread in ${identity}`);
      continue;
    }
    const localName = (unwrapExpression(spread.expression) as ts.Identifier).text;
    if (!/^[A-Za-z_$][\w$]*Handlers$/.test(localName)) {
      blindSpots.push(`unsupported handler factory spread target ${localName} in ${identity}`);
      continue;
    }
    const localTargets = source.statements
      .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === localName && statement.body !== undefined)
      .map(() => ({ sourceFile, factoryName: localName }));
    const importedTargets = analyzeLocalImportCalls(context, sourceFile).imports
      .filter(binding => binding.local === localName && /^[A-Za-z_$][\w$]*Handlers$/.test(binding.imported))
      .map(binding => ({ sourceFile: binding.sourceFile, factoryName: binding.imported }));
    const targets = [...new Map([...localTargets, ...importedTargets]
      .map(target => [`${target.sourceFile}#${target.factoryName}`, target])).values()];
    if (targets.length !== 1) {
      blindSpots.push(`handler factory spread target is ${targets.length === 0 ? 'missing' : 'ambiguous'}: ${identity}->${localName}`);
      continue;
    }
    const nested = resolveHandlerFactoryKeys(context, targets[0].sourceFile, targets[0].factoryName, visiting, memo);
    keys.push(...nested.commandKeys);
    blindSpots.push(...nested.blindSpots);
  }
  visiting.delete(identity);
  const result = { commandKeys: stable(keys), blindSpots: stable(blindSpots) };
  memo.set(identity, result);
  return result;
}

function commandNamesForEntry(entry: ProcessFactRegistryEntry): string[] {
  const producerCommands = artifactProducerCommands(entry);
  return stable([...producerCommands, ...(/^[a-z][a-z0-9_]*$/.test(entry.name) ? [entry.name] : [])]);
}

function artifactProducerCommands(entry: ProcessFactRegistryEntry): string[] {
  return (entry.artifact?.producerCommand ?? '').split('/').filter(value => /^[a-z][a-z0-9_]*$/.test(value));
}

function isDispatchableProcessFact(entry: ProcessFactRegistryEntry): boolean {
  return entry.lifecycle !== undefined && /^[a-z][a-z0-9_]*$/.test(entry.name);
}

function graphFactoryCommandRegistered(factories: readonly FactoryInventory[], command: string): boolean {
  return factories.some(factory => factory.registered && factory.commandKeys.includes(command));
}

function topologyFactNames(input: AcceptanceDiscoveryInput): Set<string> {
  return new Set((input.topologyPathRefs ?? [])
    .map(ref => ref.startsWith('process-fact:') ? ref.slice('process-fact:'.length) : ref.startsWith('path:process-fact:') ? ref.slice('path:process-fact:'.length).split('->consumer:')[0] : '')
    .filter(Boolean));
}

function generatedStoryArtifactDirectory(context: SourceReadContext, storyId: string): string | null {
  try {
    const read = readSourceSafely(context, resolveSnapshotConfigFilename(context), MAX_PROOF_OR_STOP_CONFIG_BYTES);
    if (read.text === undefined) return null;
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    const configured = parsed.storyDir ?? PROOF_OR_STOP_STORY_DIR;
    if (typeof configured !== 'string' || configured.trim().length === 0
      || isAbsolute(configured) || configured.split(/[\\/]/).includes('..')) return null;
    return `${configured.replace(/\\/g, '/').replace(/\/+$/, '')}/${storyId}/`;
  } catch { return null; }
}

function sourceSeedFiles(input: AcceptanceDiscoveryInput, storyArtifactDirectory: string | null): string[] {
  // These files remain scope/process-fact evidence, but their generated
  // bytes cannot define the source closure that signs the next generation.
  return stable([
    ...input.scopeRefs.filter(ref => ref.startsWith('scope:file:')).map(ref => ref.slice('scope:file:'.length)),
    ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
  ]).filter(file => {
    const canonical = file.replace(/\\/g, '/');
    const basename = canonical.split('/').at(-1) ?? '';
    if (storyArtifactDirectory
      && GENERATED_PROOF_ARTIFACT_BASENAMES.has(basename)
      && canonical === `${storyArtifactDirectory}${basename}`) return false;
    // Scope contracts may name an existing directory as a source seed.  It is
    // still valid scope evidence, but it is not a source file for the bounded
    // reader.  Keep regular files and missing planned endpoints so their
    // normal read/closure diagnostics remain observable.
    try {
      return !lstatSync(resolve(input.workspaceRoot, canonical)).isDirectory();
    } catch {
      return true;
    }
  });
}

function buildBoundedSourceGraph(input: AcceptanceDiscoveryInput): BoundedSourceGraph {
  const root = input.workspaceRoot;
  const readContext = createSourceReadContext(root);
  const seedFiles = sourceSeedFiles(input, generatedStoryArtifactDirectory(readContext, input.storyId));
  const sourceInventory = configuredSourceInventory(root, readContext);
  const blindSpots: string[] = [...sourceInventory.blindSpots];
  // A process-fact sourceFiles entry may intentionally point at a directory
  // (for example the agent prompt asset root).  Scope references are still
  // retained by sourceSeedFiles, but never pass the directory to the bounded
  // file reader: it is not a source file and would create a false blind spot.
  // Missing file references remain in the candidate set so their normal
  // unreadable-source diagnostic stays observable and fail-closed.
  const registryCandidates = sourceFileRefs(root, ['packages/main/src/registry.ts', ...PROCESS_FACT_REGISTRY.flatMap(sourceFiles)]);
  const analysisContext = createBindingAnalysisContext(root, stable([...sourceInventory.files, ...seedFiles, ...registryCandidates]), readContext);
  const registryFiles = registryCandidates.filter(file => file === 'packages/main/src/registry.ts'
    || executableText(analysisContext.sourceFiles.get(file)?.text ?? '').includes('registerBatch('));
  const planControlFacts = new Set<string>(PLAN_CONTROL_FACT_NAMES);
  const preReviewControlFacts = new Set<string>(PRE_REVIEW_CONTROL_FACT_NAMES);
  const phaseControlFacts = new Set([...planControlFacts, ...preReviewControlFacts, 'acceptance_topology_check',
    'topology_exclusion_approval_set', 'topology_critic_receipt_set', 'topology_critic_receipt_check',
    'artifact:topology-exclusion-approvals.json', 'artifact:topology-critic-receipt.json']);
  const explicitTopologyFactNames = topologyFactNames(input);
  // Pre-review control facts are phase material only when the current
  // acceptance topology explicitly declares them. This keeps the basis
  // closure total for stories whose topology predates the pre-review control
  // surface while preserving the strict materialization test for declared
  // future-phase mappings.
  const allowedPhaseControlFacts = (input.phaseBasis ?? 'plan') === 'pre_review'
    ? new Set([...planControlFacts, ...[...preReviewControlFacts].filter(fact => explicitTopologyFactNames.has(fact))])
    : planControlFacts;
  const plannedFactNames = new Set(input.plannedPathRecords.flatMap(record => [
    record.outputFactRef.replace(/^process-fact:/, '').replace(/-/g, '_'),
    record.producer.expectedSymbolOrFact,
    ...record.consumers.map(consumer => consumer.expectedSymbolOrFact),
  ]).filter(value => /^[a-z][a-z0-9_:.-]*$/.test(value)));
  const relevantFactNames = new Set([...allowedPhaseControlFacts, ...explicitTopologyFactNames, ...plannedFactNames]);
  const factories: FactoryInventory[] = [];
  const handlerResolutionMemo = new Map<string, HandlerFactoryResolution>();
  for (const registryFile of registryFiles) {
    const source = analysisContext.sourceFiles.get(registryFile);
    if (!source) { blindSpots.push(...(analysisContext.readBlindSpots.get(registryFile) ?? [`uninspectable registry source ${registryFile}`])); continue; }
    const text = executableText(source.text);
    const registryScan = analyzeLocalImportCalls(analysisContext, registryFile);
    blindSpots.push(...registryScan.blindSpots, ...registryScan.unresolvedImports);
    const imports = registryScan.imports;
    const registrations = new Set([...text.matchAll(/registry\.registerBatch\(\s*([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)\s*\)/g)].map(match => match[1]));
    for (const imported of imports.filter(item => /Handlers$/.test(item.imported) || /Handlers$/.test(item.local))) {
      const registered = registrations.has(imported.local);
      const resolution = resolveHandlerFactoryKeys(analysisContext, imported.sourceFile, imported.imported, new Set(), handlerResolutionMemo);
      const commandKeys = resolution.commandKeys;
      if (!seedFiles.includes(imported.sourceFile)
        && input.expandSeedHandlerCommands !== true
        && !commandKeys.some(command => relevantFactNames.has(command))) continue;
      factories.push({ factory: imported.local, sourceFile: imported.sourceFile, registered, commandKeys });
      blindSpots.push(...resolution.blindSpots);
      if (!registered) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} lacks exact registerBatch(factory(ctx))`);
      if (commandKeys.length === 0) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} has ambiguous or empty returned command object`);
    }
  }
  const inferredHandlerFiles = new Map<string, string>();
  for (const factory of factories) for (const command of factory.commandKeys) inferredHandlerFiles.set(command, factory.sourceFile);
  const entryFiles = (entry: ProcessFactRegistryEntry): string[] => stable([
    ...sourceFileRefs(root, sourceFiles(entry)),
    ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
  ]);
  const closure = new Set(seedFiles);
  const reached = new Set<ProcessFactRegistryEntry>();
  const hubs = new Set(registryFiles);
  const sourceScans = new Map<string, LocalImportCallScan>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of PROCESS_FACT_REGISTRY) {
      if ((input.phaseBasis ?? 'plan') === 'plan'
        && acceptanceDiscoveryFactActivationPhase(entry.name) === 'pre_review') continue;
      if (phaseControlFacts.has(entry.name)) {
        if (!allowedPhaseControlFacts.has(entry.name) && !explicitTopologyFactNames.has(entry.name)) continue;
      }
      const files = entryFiles(entry).filter(file => !hubs.has(file));
      const explicitTopologyMatch = explicitTopologyFactNames.has(entry.name);
      const phaseControlMatch = allowedPhaseControlFacts.has(entry.name);
      const plannedMatch = plannedFactNames.has(entry.name)
        || (['artifact', 'signed-artifact'].includes(entry.kind)
          && artifactProducerCommands(entry).some(command => plannedFactNames.has(command)));
      const expandedHandlerMatch = input.expandSeedHandlerCommands === true
        && commandNamesForEntry(entry).some(command => inferredHandlerFiles.has(command));
      if (!phaseControlMatch && !explicitTopologyMatch && !plannedMatch && !expandedHandlerMatch) continue;
      if (!reached.has(entry)) { reached.add(entry); changed = true; }
      for (const file of files) if (!closure.has(file)) { closure.add(file); changed = true; }
    }
  }
  // A planned source endpoint is only useful when the runtime can reach it.
  // Keep the closure bounded by retaining only source-inventory files that
  // import one of the declared endpoint modules; this captures the real
  // handler binding without turning the discovery graph into a whole-tree
  // call graph.
  const plannedEndpointFiles = new Set(input.plannedPathRecords.flatMap(record =>
    [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)));
  const plannedEndpointBasenames = [...plannedEndpointFiles].map(file => file.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? file);
  for (const file of sourceInventory.files) {
    if (closure.has(file) || !supportsBindingAnalysis(file)) continue;
    const source = analysisContext.sourceFiles.get(file);
    if (!source || !plannedEndpointBasenames.some(name => source.text.includes(name))) continue;
    const scan = analyzeLocalImportCalls(analysisContext, file);
    if (!scan.imports.some(binding => plannedEndpointFiles.has(binding.sourceFile))) continue;
    closure.add(file);
    sourceScans.set(file, scan);
  }
  for (const file of closure) {
    blindSpots.push(...(analysisContext.readBlindSpots.get(file) ?? []));
    if (supportsBindingAnalysis(file)) sourceScans.set(file, analyzeLocalImportCalls(analysisContext, file));
  }
  for (const entry of reached) {
    const rawSourceRefs = sourceFiles(entry);
    const acceptedSourceRefs = new Set(sourceFileRefs(root, rawSourceRefs));
    for (const file of acceptedSourceRefs) {
      if (!existsSync(resolve(root, file))) blindSpots.push(`uninspectable registered source ${file} for ${entry.name}`);
    }
    // Directory and symlink refs are excluded from the executable source set,
    // but still pass through the no-follow reader once so their diagnostics are
    // retained instead of silently disappearing from the acceptance basis.
    for (const file of rawSourceRefs) {
      if (acceptedSourceRefs.has(file)) continue;
      const read = readSourceSafely(readContext, file);
      if (read.blindSpot) blindSpots.push(`${read.blindSpot} for ${entry.name}`);
    }
    if (entry.consumerGate) {
      const dispatchConsumer = isDispatchableProcessFact(entry)
        && graphFactoryCommandRegistered(factories, entry.name);
      const explicitConsumer = dispatchConsumer || sourceFileRefs(root, entry.consumerSourceRefs ?? [])
        .some(file => isResolvableRegularSourceFile(root, file));
      const producerFiles = stable([
        ...(entry.producerSourceRefs ?? []),
        ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
      ]);
      const discoveredConsumer = [...closure].some(file => !hubs.has(file) && !producerFiles.includes(file)
        && (sourceScans.get(file)?.calledImports ?? []).some(item => producerFiles.includes(item.sourceFile)));
      if (!explicitConsumer && !discoveredConsumer) blindSpots.push(`process fact ${entry.name} has consumerGate but no resolvable consumer source`);
    }
  }
  return {
    seedFiles, sourceInventoryFiles: sourceInventory.files, closureFiles: stable([...closure]), entries: [...reached], factories,
    sourceScans, sourceFiles: analysisContext.sourceFiles, checker: analysisContext.checker,
    blindSpots: stable(blindSpots), readContext, directoryFingerprints: sourceInventory.directoryFingerprints,
  };
}

/** Resolve canonical process-fact closure and its producer/consumer source files. */
function registeredProcessFactClosureFromGraph(graph: BoundedSourceGraph): RegisteredProcessFactClosure {
  const reached = graph.entries;
  return {
    pathRefs: stable(reached.map(processFactPath)),
    sourceInventoryRefs: stable(reached.flatMap(entry => [
      `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
      ...sourceFileRefs(graph.readContext.physicalRoot, entry.producerSourceRefs ?? [])
        .map(file => `source-file:producer:${encodeURIComponent(entry.name)}:${file}`),
      ...sourceFileRefs(graph.readContext.physicalRoot, entry.consumerSourceRefs ?? [])
        .map(file => `source-file:consumer:${encodeURIComponent(entry.name)}:${file}`),
      ...(entry.artifact ? [`artifact:${entry.artifact.path}`] : []),
    ]).concat(
      sourceFileRefs(graph.readContext.physicalRoot, graph.closureFiles).map(file => `source-file:closure:${file}`),
      // B-cc10 F-031: name the config spelling this project ACTUALLY has. This was a
      // hardcoded 'proof-or-stop.config.json' sitting beside dynamically-derived siblings, so a
      // canonical-only project inventoried a file it does not contain — producing a spurious
      // "lacks immutable bounded snapshot" blind spot that degraded the acceptance basis from
      // complete to partial. Masked in tests because every fixture used the deprecated name.
      [`source-file:config:${resolveSnapshotConfigFilename(graph.readContext)}`],
    )),
    sourceFileRefs: graph.closureFiles,
    blindSpots: graph.blindSpots,
    entries: reached,
  };
}

export function deriveRegisteredProcessFactClosure(workspaceRoot: string, seedRefs: readonly string[]): RegisteredProcessFactClosure {
  const graph = buildBoundedSourceGraph({ supported: true, workspaceRoot, storyId: '<closure>', plannedPathRecords: [], scopeRefs: seedRefs.map(ref => ref.startsWith('scope:file:') ? ref : `scope:file:${ref}`), expandSeedHandlerCommands: true });
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
    if (isExistingDirectory(context.physicalRoot, file)) return `source-directory:${file}`;
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
    const source = ts.createSourceFile(
      'packages/main/src/cli/command-catalog.ts',
      read.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) return new Set();
    const catalogs: ts.ArrayLiteralExpression[] = [];
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'MAIN_TOOLS' || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isArrayLiteralExpression(initializer)) catalogs.push(initializer);
      }
    }
    if (catalogs.length !== 1) return new Set();
    const commands = new Set<string>();
    for (const element of catalogs[0].elements) {
      const entry = unwrapExpression(element);
      if (!ts.isObjectLiteralExpression(entry)) return new Set();
      const names = entry.properties.flatMap(property => {
        if (!ts.isPropertyAssignment(property)) return [];
        const name = property.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
        const value = unwrapExpression(property.initializer);
        return key === 'name' && ts.isStringLiteral(value) ? [value.text] : [];
      });
      if (names.length !== 1 || !/^[a-z][a-z0-9_]*$/.test(names[0]) || commands.has(names[0])) return new Set();
      commands.add(names[0]);
    }
    return commands;
  }
  catch { return new Set(); }
}

function staticCallPaths(input: AcceptanceDiscoveryInput, graph: BoundedSourceGraph): { paths: string[]; blindSpots: string[] } {
  const paths: string[] = [];
  const blindSpots: string[] = [];
  const explicitFacts = topologyFactNames(input);
  const relevantFiles = new Set([
    ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
    ...graph.entries.filter(entry => explicitFacts.has(entry.name)).flatMap(sourceFiles),
    ...graph.factories.filter(factory => factory.commandKeys.some(command => explicitFacts.has(command))).map(factory => factory.sourceFile),
  ]);
  const bindingRequiredFiles = new Set([
    ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
    ...graph.factories.filter(factory => factory.commandKeys.some(command => explicitFacts.has(command))).map(factory => factory.sourceFile),
  ]);
  // Existing `basis-path:path:static-call:...` references are explicit
  // forward declarations at PLAN and become mandatory current edges at
  // pre-review. Include their bounded endpoints in the scan so a declared
  // edge is actually discoverable even when neither endpoint is already in
  // the process-fact closure. The emitted path is still derived from the
  // source import/call scan below; the declaration never self-certifies.
  for (const ref of input.topologyPathRefs ?? []) {
    const path = ref.startsWith('basis-path:') ? ref.slice('basis-path:'.length) : ref;
    const match = /^path:static-call:([^#]+)#[^>]+->consumer:([^#]+)#[^>]+$/.exec(path);
    if (!match) continue;
    relevantFiles.add(match[1]);
    relevantFiles.add(match[2]);
    bindingRequiredFiles.add(match[1]);
    bindingRequiredFiles.add(match[2]);
  }
  for (const file of stable([...relevantFiles]).filter(value => !value.endsWith('/registry.ts'))) {
    const absolute = resolve(input.workspaceRoot, file);
    if (!existsSync(absolute)) continue;
    const scan = graph.sourceScans.get(file);
    if (!scan) {
      if (bindingRequiredFiles.has(file)) blindSpots.push(`source file lacks binding analysis context: ${file}`);
      continue;
    }
    // A process-fact source ref is sufficient for freshness binding, but does
    // not make every import in that file part of the claimed edge. Binding
    // ambiguity blocks only files needed to resolve planned endpoints or an
    // explicitly relevant handler dispatch.
    if (bindingRequiredFiles.has(file)) blindSpots.push(...scan.blindSpots, ...scan.unresolvedImports);
    for (const imported of scan.calledImports) {
      if (!relevantFiles.has(imported.sourceFile) || /Handlers$/.test(imported.imported)) continue;
      paths.push(`path:static-call:${imported.sourceFile}#${imported.imported}->consumer:${file}#${imported.local}`);
    }
  }
  return { paths: stable(paths), blindSpots: stable(blindSpots) };
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function exportedCallableCount(source: ts.SourceFile, expected: string): number {
  let count = 0;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === expected && statement.body && isExported(statement)) count += 1;
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expected || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) count += 1;
    }
  }
  return count;
}

interface CallableBody {
  name: string;
  body: ts.Node;
  declaration: ts.Node;
  symbol: ts.Symbol | undefined;
}

interface CalledCallable {
  name: string;
  symbol: ts.Symbol | undefined;
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function callableBodies(source: ts.SourceFile, expected: string | undefined, checker: ts.TypeChecker): CallableBody[] {
  const bodies: CallableBody[] = [];
  const add = (nameNode: ts.Node | undefined, body: ts.Node | undefined): void => {
    if (!nameNode || body === undefined || !ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode) && !ts.isNumericLiteral(nameNode)) return;
    const name = nameNode.text;
    if (expected !== undefined && name !== expected) return;
    bodies.push({ name, body, declaration: nameNode.parent, symbol: checker.getSymbolAtLocation(nameNode) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) add(node.name, node.body);
    if (ts.isMethodDeclaration(node) && node.body) add(node.name, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) add(node.name, initializer.body);
    }
    if (ts.isPropertyAssignment(node)) {
      const initializer = unwrapExpression(node.initializer);
      if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body) add(node.name, initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

function uniqueCallableBodies(bodies: readonly CallableBody[]): CallableBody[] {
  return [...new Map(bodies.map(body => [body.symbol ?? body.declaration, body])).values()];
}

function inspectCallableBody(body: CallableBody, checker: ts.TypeChecker): CalledCallable[] {
  const called: CalledCallable[] = [];
  const inspect = (node: ts.Node, root: boolean): void => {
    if (!root && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) called.push({ name: callee.text, symbol: checker.getSymbolAtLocation(callee) });
    }
    ts.forEachChild(node, child => inspect(child, false));
  };
  inspect(body.body, true);
  return called;
}

function uniqueCallable(source: ts.SourceFile, expected: string, checker: ts.TypeChecker): CallableBody | null {
  const candidates = uniqueCallableBodies(callableBodies(source, expected, checker));
  return candidates.length === 1 && candidates[0].symbol ? candidates[0] : null;
}

function sameFileCallableReachable(source: ts.SourceFile, caller: string, callee: string, checker: ts.TypeChecker): boolean {
  const callerBody = uniqueCallable(source, caller, checker);
  const calleeBody = uniqueCallable(source, callee, checker);
  if (!callerBody || !calleeBody) return false;
  const pending = [callerBody];
  const visited = new Set<ts.Symbol>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (!current.symbol || visited.has(current.symbol)) continue;
    visited.add(current.symbol);
    for (const called of inspectCallableBody(current, checker)) {
      if (called.symbol === calleeBody.symbol) return true;
      if (!called.symbol) continue;
      const target = uniqueCallableBodies(callableBodies(source, called.name, checker))
        .find(candidate => candidate.symbol === called.symbol);
      if (target) pending.push(target);
    }
  }
  return false;
}

function hasSameFileIncomingCall(source: ts.SourceFile, expected: string, checker: ts.TypeChecker): boolean {
  const expectedBody = uniqueCallable(source, expected, checker);
  if (!expectedBody) return false;
  const candidates = uniqueCallableBodies(callableBodies(source, undefined, checker));
  return candidates.some(candidate =>
    candidate.symbol !== expectedBody.symbol
    && inspectCallableBody(candidate, checker).some(called => called.symbol === expectedBody.symbol));
}

function sourceSnapshot(graph: BoundedSourceGraph, file: string): ts.SourceFile | undefined {
  // All symbol-aware helpers must receive nodes from the same Program as the
  // checker. A separately parsed snapshot has equivalent text but unrelated
  // symbols, so an absent Program source is intentionally uninspectable.
  return graph.sourceFiles.get(file);
}

function callableSignatureMentionsType(source: ts.SourceFile, expected: string, typeName: string): boolean {
  const mentions = (node: ts.Node | undefined): boolean => node?.getText(source).split(/[^A-Za-z0-9_$]+/).includes(typeName) ?? false;
  const propertyName = (name: ts.PropertyName | undefined): string | null => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === expected) {
      found = mentions(node.type) || node.parameters.some(parameter => mentions(parameter.type));
    } else if (ts.isMethodDeclaration(node) && propertyName(node.name) === expected) {
      found = mentions(node.type) || node.parameters.some(parameter => mentions(parameter.type));
    } else if (ts.isPropertyAssignment(node) && propertyName(node.name) === expected) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        found = mentions(initializer.type) || initializer.parameters.some(parameter => mentions(parameter.type));
      }
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expected || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          found = mentions(initializer.type) || initializer.parameters.some(parameter => mentions(parameter.type));
        }
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function callableReferencesProperty(source: ts.SourceFile, expected: string, property: string, checker: ts.TypeChecker): boolean {
  const callable = uniqueCallable(source, expected, checker);
  if (!callable) return false;
  let found = false;
  const inspect = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === property) found = true;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === property) found = true;
    ts.forEachChild(node, inspect);
  };
  inspect(callable.body);
  return found;
}

function topLevelBindingSymbol(source: ts.SourceFile, localName: string, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbols: ts.Symbol[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name?.text === localName) {
        const symbol = checker.getSymbolAtLocation(clause.name);
        if (symbol) symbols.push(symbol);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (element.name.text === localName) {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) symbols.push(symbol);
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)
        && clause.namedBindings.name.text === localName) {
        const symbol = checker.getSymbolAtLocation(clause.namedBindings.name);
        if (symbol) symbols.push(symbol);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === localName) {
          const symbol = checker.getSymbolAtLocation(declaration.name);
          if (symbol) symbols.push(symbol);
        }
      }
    }
  }
  return symbols.length === 1 ? symbols[0] : undefined;
}

function callableDirectlyCallsIdentifier(source: ts.SourceFile, expected: string, calleeName: string, checker: ts.TypeChecker): boolean {
  const callable = uniqueCallable(source, expected, checker);
  const importedSymbol = topLevelBindingSymbol(source, calleeName, checker);
  if (!callable || !importedSymbol) return false;
  let found = false;
  const inspect = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && callee.text === calleeName
        && checker.getSymbolAtLocation(callee) === importedSymbol) found = true;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(callable.body);
  return found;
}

function typeDeclaresProperty(source: ts.SourceFile, typeName: string, property: string): boolean {
  const propertyName = (name: ts.PropertyName | ts.BindingName | undefined): string | null => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  };
  const membersHaveProperty = (members: ts.NodeArray<ts.TypeElement>): boolean => members.some(member => {
    if (!('name' in member)) return false;
    return propertyName((member as ts.PropertySignature | ts.MethodSignature).name) === property;
  });
  return source.statements.some(statement => {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === typeName) return membersHaveProperty(statement.members);
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== typeName) return false;
    return ts.isTypeLiteralNode(statement.type) && membersHaveProperty(statement.type.members);
  });
}

function reachesRegisteredHandler(graph: BoundedSourceGraph, endpoint: VerificationPlannedPathEndpointV1): boolean {
  if (endpoint.expectedArtifactKind !== 'handler') return false;
  const source = sourceSnapshot(graph, endpoint.expectedFileRef);
  if (!source) return false;
  return graph.factories.some(factory => factory.registered && factory.sourceFile === endpoint.expectedFileRef
    && factory.commandKeys.some(command => command !== endpoint.expectedSymbolOrFact
      && sameFileCallableReachable(source, command, endpoint.expectedSymbolOrFact, graph.checker)));
}

function outputFactContractRelation(
  graph: BoundedSourceGraph,
  record: PlannedCoveragePathV1,
  producer: VerificationPlannedPathEndpointV1,
  consumer: VerificationPlannedPathEndpointV1,
): boolean {
  const fact = record.outputFactRef.trim();
  const producerSource = sourceSnapshot(graph, producer.expectedFileRef);
  const consumerSource = sourceSnapshot(graph, consumer.expectedFileRef);
  if (!producerSource || !consumerSource) return false;

  // A receipt producer and importer are deliberately separate transactions. For
  // this shape, the source must declare the output property's type, and both
  // callable bodies must actually consume that property.
  const receiptFact = fact.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (receiptFact && producer.expectedFileRef === consumer.expectedFileRef
    && typeDeclaresProperty(producerSource, receiptFact[1], receiptFact[2])
    && callableReferencesProperty(producerSource, producer.expectedSymbolOrFact, receiptFact[2], graph.checker)
    && callableReferencesProperty(consumerSource, consumer.expectedSymbolOrFact, receiptFact[2], graph.checker)) {
    return true;
  }

  // A typed decision consumer may use verifier helpers rather than calling the
  // evaluator directly. Require the consumer to import the declared output
  // type from the producer module, the producer signature to return it, and
  // the consumer callable to call a value import from that same module.
  if (/^[A-Z_$][\w$]*$/.test(fact) && producer.expectedFileRef !== consumer.expectedFileRef) {
    const consumerScan = graph.sourceScans.get(consumer.expectedFileRef);
    const typeImport = consumerScan?.contractImports.some(binding =>
      binding.sourceFile === producer.expectedFileRef && binding.imported === fact);
    const valueImportUsed = consumerScan?.calledImports.some(call =>
      call.sourceFile === producer.expectedFileRef
        && (call.caller === consumer.expectedSymbolOrFact
          || (call.caller !== null && sameFileCallableReachable(consumerSource, consumer.expectedSymbolOrFact, call.caller, graph.checker))));
    return typeImport === true
      && callableSignatureMentionsType(producerSource, producer.expectedSymbolOrFact, fact)
      && valueImportUsed === true;
  }
  return false;
}

function registeredHandlerEndpoint(graph: BoundedSourceGraph, endpoint: VerificationPlannedPathEndpointV1): boolean {
  return graph.factories.some(factory => factory.registered && factory.sourceFile === endpoint.expectedFileRef
    && factory.commandKeys.includes(endpoint.expectedSymbolOrFact));
}

function endpointMatchesArtifactKind(graph: BoundedSourceGraph, endpoint: VerificationPlannedPathEndpointV1): boolean {
  if (endpoint.expectedArtifactKind === 'process_fact') {
    return graph.entries.some(entry => entry.name === endpoint.expectedSymbolOrFact && sourceFiles(entry).includes(endpoint.expectedFileRef));
  }
  const registered = registeredHandlerEndpoint(graph, endpoint);
  if (endpoint.expectedArtifactKind === 'dispatch') return registered;
  const source = sourceSnapshot(graph, endpoint.expectedFileRef);
  if (!source) return false;
  const exported = exportedCallableCount(source, endpoint.expectedSymbolOrFact);
  if (endpoint.expectedArtifactKind === 'handler') {
    const internal = exported === 0 && !registered && reachesRegisteredHandler(graph, endpoint);
    return Number(registered) + exported + Number(internal) === 1;
  }
  return exported === 1;
}

function endpointIsRuntimeReachable(graph: BoundedSourceGraph, endpoint: VerificationPlannedPathEndpointV1): boolean {
  if (endpoint.expectedArtifactKind === 'process_fact' || registeredHandlerEndpoint(graph, endpoint)) return true;
  if (reachesRegisteredHandler(graph, endpoint)) return true;
  const importedIncoming = [...graph.sourceScans.values()].some(scan => scan.calledImports.some(call =>
    call.sourceFile === endpoint.expectedFileRef && call.imported === endpoint.expectedSymbolOrFact));
  if (importedIncoming) return true;
  const source = sourceSnapshot(graph, endpoint.expectedFileRef);
  if (!source) return false;
  return hasSameFileIncomingCall(source, endpoint.expectedSymbolOrFact, graph.checker);
}

function producerConsumerRelation(
  graph: BoundedSourceGraph,
  record: PlannedCoveragePathV1,
  producer: VerificationPlannedPathEndpointV1,
  consumer: VerificationPlannedPathEndpointV1,
): boolean {
  const source = sourceSnapshot(graph, consumer.expectedFileRef);
  const importedCall = (graph.sourceScans.get(consumer.expectedFileRef)?.calledImports ?? []).some(call =>
    call.sourceFile === producer.expectedFileRef && call.imported === producer.expectedSymbolOrFact
        && (call.caller === consumer.expectedSymbolOrFact
        || (registeredHandlerEndpoint(graph, consumer)
          && call.caller !== null && source !== undefined
          && sameFileCallableReachable(source, consumer.expectedSymbolOrFact, call.caller, graph.checker))));
  const lexicalImportedCall = source !== undefined
    && reachesRegisteredHandler(graph, consumer)
    && (graph.sourceScans.get(consumer.expectedFileRef)?.imports ?? []).some(binding =>
      binding.sourceFile === producer.expectedFileRef && binding.imported === producer.expectedSymbolOrFact)
    && callableDirectlyCallsIdentifier(source, consumer.expectedSymbolOrFact, producer.expectedSymbolOrFact, graph.checker);
  const sameFileCall = producer.expectedFileRef === consumer.expectedFileRef && source
    ? sameFileCallableReachable(source, consumer.expectedSymbolOrFact, producer.expectedSymbolOrFact, graph.checker) : false;
  const registryRelation = (producer.expectedArtifactKind === 'process_fact' || consumer.expectedArtifactKind === 'process_fact')
    && graph.entries.some(entry => commandNamesForEntry(entry).includes(producer.expectedSymbolOrFact)
    && (entry.consumerSourceRefs ?? []).includes(consumer.expectedFileRef)
    && (sourceFiles(entry).includes(producer.expectedFileRef) || registeredHandlerEndpoint(graph, producer)));
  return importedCall || lexicalImportedCall || sameFileCall || registryRelation || outputFactContractRelation(graph, record, producer, consumer);
}

function actualEndpointPathRefs(input: AcceptanceDiscoveryInput, graph: BoundedSourceGraph): string[] {
  const refs: string[] = [];
  for (const record of input.plannedPathRecords) {
    const endpoints = [record.producer, ...record.consumers];
    if (!endpoints.every(endpoint => endpointMatchesArtifactKind(graph, endpoint) && endpointIsRuntimeReachable(graph, endpoint))) continue;
    if (!record.consumers.every(consumer => producerConsumerRelation(graph, record, record.producer, consumer))) continue;
    refs.push(...endpoints.map(endpoint => `actual:${endpoint.expectedArtifactKind}:${endpoint.expectedFileRef}#${endpoint.expectedSymbolOrFact}`));
  }
  return stable(refs);
}

function buildResult(
  input: AcceptanceDiscoveryInput,
  method: CoverageDiscoveryMethodV1,
  prebuiltGraph?: BoundedSourceGraph,
): CoverageAdapterResultV1 {
  if (method === 'registered_command_receipts') {
    const unsigned: Omit<CoverageAdapterResultV1, 'resultDigest'> = {
      schemaVersion: 'proofstory.coverage_adapter_result.v1',
      adapterId: adapterId(method),
      method,
      pathRefs: [],
      coverageClaim: 'complete_for_scope',
      blindSpots: [],
      provenanceRefs: ['registered-command-receipts:verification-evidence:v1'],
      asymmetryPolicy: {
        kind: 'exhaustive',
        policyRef: 'policy:registered-command-receipts:v1',
        scopeRefs: stable(input.scopeRefs),
      },
    };
    return { ...unsigned, resultDigest: digestCoverageAdapterResult(unsigned) };
  }
  const unsupported = !input.supported;
  const boundedRuntime = method === 'runtime_trace';
  let pathRefs: string[] = [];
  let blindSpots: string[] = [];
  let provenanceRefs: string[] = [];
  if (!unsupported) {
    const graph = prebuiltGraph ?? buildBoundedSourceGraph(input);
    const plannedFiles = new Set(input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers]
      .map(endpoint => endpoint.expectedFileRef)));
    const graphBlindSpots = graph.blindSpots.filter(message => {
      if ((input.phaseBasis ?? 'plan') !== 'plan' || !/unreadable or disappeared/.test(message)) return true;
      const file = message.match(/: (.+?)(?: -> .+)?$/)?.[1];
      return !file || !plannedFiles.has(file);
    });
    if (method === 'scope_contract') {
      pathRefs = input.plannedPathRecords.map(record => record.plannedPathRef);
      provenanceRefs = stable([
        ...input.scopeRefs,
        ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers])
          .map(endpoint => sourceProvenance(graph.readContext, endpoint.expectedFileRef)),
      ]);
    } else if (method === 'process_fact_registry') {
      pathRefs = graph.entries.map(processFactPath);
      blindSpots = graphBlindSpots;
      provenanceRefs = stable(graph.entries.flatMap(entry => [
        `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
        ...sourceFileRefs(input.workspaceRoot, sourceFiles(entry)).map(file => sourceProvenance(graph.readContext, file)),
      ]));
    } else if (method === 'handler_dispatch_inventory') {
      const commands = catalogCommands(graph.readContext);
      const registeredKeys = new Set(graph.factories.filter(factory => factory.registered).flatMap(factory => factory.commandKeys));
      const dispatchableEntries = graph.entries.filter(isDispatchableProcessFact);
      const inspectableEntries = dispatchableEntries.filter(entry => registeredKeys.has(entry.name) && commands.has(entry.name));
      const requiredCommands = new Set(dispatchableEntries.map(entry => entry.name));
      pathRefs = inspectableEntries.map(processFactPath);
      blindSpots = stable([
        ...graphBlindSpots,
        ...graph.factories.filter(factory => !factory.registered).map(factory => `unregistered handler factory ${factory.factory}`),
        ...[...requiredCommands].filter(command => registeredKeys.has(command) && !commands.has(command)).map(command => `registered handler command ${command} has no exact command catalog binding`),
        ...dispatchableEntries.filter(entry => !inspectableEntries.includes(entry)).map(entry => `dispatchable process fact ${entry.name} has no exact registered handler/catalog dispatch`),
      ]);
      provenanceRefs = stable(['packages/main/src/cli/command-catalog.ts', 'packages/main/src/registry.ts', ...graph.factories.map(factory => factory.sourceFile)]
        .map(file => sourceProvenance(graph.readContext, file)));
    } else if (method === 'static_call_graph') {
      const inspectableEntries = graph.entries.filter(entry => sourceFileRefs(input.workspaceRoot, sourceFiles(entry))
        .every(file => existsSync(resolve(input.workspaceRoot, file))));
      const staticCalls = staticCallPaths(input, graph);
      pathRefs = inspectableEntries.map(processFactPath);
      pathRefs.push(...staticCalls.paths);
      if (input.phaseBasis === 'pre_review') pathRefs.push(...actualEndpointPathRefs(input, graph));
      blindSpots = stable([...graphBlindSpots, ...staticCalls.blindSpots, ...graph.entries.filter(entry => !inspectableEntries.includes(entry)).map(entry => `static registered source graph is incomplete for ${entry.name}`)]);
      provenanceRefs = stable(graph.closureFiles.map(file => sourceProvenance(graph.readContext, file)));
    } else {
      pathRefs = stable(input.runtimeObservedPathRefs ?? []);
      provenanceRefs = [
        `runtime-fact-registry:sha256:${digestCanonicalJson(RUNTIME_FACT_REGISTRY)}`,
        `runtime-trace:story:${input.storyId}:bounded`,
      ];
    }
    if (method !== 'runtime_trace') {
      provenanceRefs = stable([...provenanceRefs, sourceProvenance(graph.readContext, resolveSnapshotConfigFilename(graph.readContext))]);
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
  const methods = acceptanceDiscoveryProfile(input.verificationProfile ?? (input.supported ? 'typescript-topology' : 'unsupported')).methods;
  const graph = input.supported ? buildBoundedSourceGraph(input) : undefined;
  return methods.map(method => buildResult(input, method, graph));
}

/** One immutable source snapshot shared by closure discovery, adapter provenance, and receipt hashing. */
export function runAcceptanceDiscoverySnapshot(input: AcceptanceDiscoveryInput): AcceptanceDiscoverySnapshot {
  const profile = input.verificationProfile ?? (input.supported ? 'typescript-topology' : 'unsupported');
  const methods = acceptanceDiscoveryProfile(profile).methods;
  if (profile === 'go-command') {
    return {
      adapterResults: methods.map(method => buildResult(input, method)),
      registeredClosure: { pathRefs: [], sourceInventoryRefs: [], sourceFileRefs: [], blindSpots: [], entries: [] },
      sourceSnapshots: [],
      sourceReadBlindSpots: [],
      seal: additionalIssues => sealSourceAssembly(createSourceReadContext(input.workspaceRoot), [], additionalIssues),
      immediatelyBeforeFinalSeal: input.testHooks?.immediatelyBeforeFinalSeal,
    };
  }
  if (!input.supported) {
    return {
      adapterResults: methods.map(method => buildResult(input, method)),
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

function boundedProcessFactDifference(label: 'registryOnly' | 'dispatchOnly', paths: readonly string[]): string {
  const names = stable(paths.map(path => path.match(/^path:process-fact:(.+?)->consumer:/)?.[1] ?? '<malformed>'));
  const limit = 8;
  const shown = names.slice(0, limit).join(',');
  return `${label}(count=${names.length})=[${shown}${names.length > limit ? ',…' : ''}]`;
}

export function reconcileAcceptanceDiscoveryResults(
  results: readonly CoverageAdapterResultV1[],
  profile: AcceptanceVerificationProfile = 'typescript-topology',
): AcceptanceDiscoveryReconciliation {
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
  for (const method of acceptanceDiscoveryProfile(profile).methods) {
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
  const dispatchablePaths = new Set(PROCESS_FACT_REGISTRY.filter(isDispatchableProcessFact).map(processFactPath));
  const registryProcessPaths = registryResult?.pathRefs.filter(path => dispatchablePaths.has(path)) ?? [];
  const dispatchProcessPaths = dispatchResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  if (registryResult && dispatchResult && !sameSet(registryProcessPaths, dispatchProcessPaths)) {
    const registrySet = new Set(registryProcessPaths);
    const dispatchSet = new Set(dispatchProcessPaths);
    const registryOnly = registryProcessPaths.filter(path => !dispatchSet.has(path));
    const dispatchOnly = dispatchProcessPaths.filter(path => !registrySet.has(path));
    diagnostics.push({
      code: 'AT_DISCOVERY_DISAGREEMENT',
      message: `process-fact and handler/dispatch discovery disagree; ${boundedProcessFactDifference('registryOnly', registryOnly)}; ${boundedProcessFactDifference('dispatchOnly', dispatchOnly)}`,
    });
  }
  const enumeratedPathRefs = stable(results.flatMap(result => result.pathRefs));
  const blindSpots = stable(results.flatMap(result => result.blindSpots));
  const unsupported = results.some(result => result.coverageClaim === 'unsupported' || result.asymmetryPolicy.kind === 'unsupported');
  const partial = diagnostics.length > 0 || blindSpots.length > 0 || results.some(result => result.coverageClaim === 'partial');
  return { adapterResults: [...results].sort((a, b) => compareCodeUnits(a.adapterId, b.adapterId)), enumeratedPathRefs, blindSpots,
    diagnostics: diagnostics.sort((a, b) => compareCodeUnits(`${a.code}:${a.adapterId ?? ''}:${a.message}`, `${b.code}:${b.adapterId ?? ''}:${b.message}`)),
    status: unsupported ? 'unsupported' : partial ? 'partial' : 'complete' };
}

export function discoveryProfileDigest(profile: AcceptanceVerificationProfile = 'typescript-topology'): string {
  return `sha256:${digestCanonicalJson(acceptanceDiscoveryProfile(profile))}`;
}
