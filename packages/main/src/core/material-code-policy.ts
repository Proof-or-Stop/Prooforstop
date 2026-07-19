/**
 * material-code-policy — language-neutral material-code classification (B-956f).
 *
 * One config-resolved policy service (`resolveMaterialCodePolicy`) plus an
 * immutable, hash-bound classification snapshot (`buildMaterialClassificationSnapshot`)
 * that all three advanced-gate consumers share:
 *   - review-assurance floor (per-file classification),
 *   - repro-evidence-binding gate (collectMaterialCodeFiles),
 *   - the ProofStory trigger predicate (ProofStoryDiagnosticInput.materialClassification).
 *
 * The classifier evaluates the plan's 8-step first-hit-wins precedence chain
 * (see docs/requirements/decisions/language-neutral-gates-execution-plan.md v4).
 * Level-1 runtime/build manifests are material and CANNOT be excluded by any
 * config key — enforced both at config-resolve time and by a filesystem-aware
 * transition preflight. Malformed materialCode config FAILS CLOSED with a
 * diagnostic naming the offending key (never a silent degrade to a TS-only
 * whitelist).
 *
 * Purity contract: the classifier is a pure function of (policy, path, hints).
 * Only `resolveMaterialCodePolicy` reads config and only
 * `buildMaterialClassificationSnapshot` touches git/the filesystem; the pure
 * evaluators consume the resulting snapshot and re-check its embedded
 * head/material hashes at decision time rather than re-reading config.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import {
  currentGitHead,
  currentMaterialHash,
  isStoryMetadataPath,
} from './evidence-freshness.js';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';

export const MATERIAL_CODE_POLICY_SCHEMA_VERSION = 'lattice.material_code_policy.v1' as const;
export const MATERIAL_CLASSIFICATION_SNAPSHOT_SCHEMA_VERSION =
  'lattice.material_classification_snapshot.v1' as const;

/** Level-1 immutable runtime/build-config manifest basenames (exact, case-insensitive). */
export const IMMUTABLE_MANIFEST_BASENAMES: readonly string[] = [
  // JS/TS runtime + lockfiles + lattice config.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'lattice.config.json',
  // Go.
  'go.mod',
  'go.sum',
  // Rust.
  'cargo.toml',
  'cargo.lock',
  // Python.
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'poetry.lock',
  // Java / JVM.
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  // Ruby.
  'gemfile',
  'gemfile.lock',
  // PHP.
  'composer.json',
  'composer.lock',
  // Python (pipenv).
  'pipfile',
  'pipfile.lock',
];

/** Level-1 immutable manifest glob patterns (name-only globs; `*` = [^/]*). */
export const IMMUTABLE_MANIFEST_PATTERNS: readonly string[] = [
  'tsconfig*.json',
  'requirements*.txt',
  'build.gradle*',
  'settings.gradle*',
  'gemfile*',
  'pipfile*',
  'composer.json*',
];

/** Default resolved code extension set (normalized: leading dot, lowercase). */
export const DEFAULT_CODE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.pyw',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cs',
  '.rb', '.php', '.swift', '.m', '.mm', '.sql',
  '.sh', '.bash', '.zsh', '.ps1', '.pl', '.pm', '.lua', '.r', '.dart',
  '.ex', '.exs', '.erl', '.clj', '.cljs', '.cljc', '.fs', '.fsx', '.vb',
  '.proto', '.tf', '.hcl',
];

/** Default documentation / binary formats (non-material; beats path prefixes). */
export const DEFAULT_DOC_EXTENSIONS: readonly string[] = [
  '.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tif', '.tiff',
  '.pptx', '.ppt', '.key', '.doc', '.docx', '.xls', '.xlsx', '.odt', '.odp', '.ods', '.csv',
];

/** Default code-extension-gated path prefixes (level 6). */
export const DEFAULT_PATH_PREFIXES: readonly string[] = ['scripts/', 'bin/', 'src/'];

/** Extensionless plain-text names that are non-material even under a path prefix. */
export const PLAIN_TEXT_BASENAMES: readonly string[] = [
  'readme', 'license', 'licence', 'install', 'copying', 'notice', 'authors',
  'changelog', 'contributing', 'codeowners',
];

export interface MaterialCodePolicy {
  schemaVersion: typeof MATERIAL_CODE_POLICY_SCHEMA_VERSION;
  /** Exact immutable manifest basenames (lowercase). Never excludable by config. */
  immutableManifestBasenames: string[];
  /** Immutable manifest name globs. Never excludable by config. */
  immutableManifestPatterns: string[];
  /** Project config excludePaths (segment-aware, non-material). */
  excludePaths: string[];
  /** Documentation / binary extensions (non-material). */
  docExtensions: string[];
  /** Extensions subtracted from the resolved code set before inclusion. */
  removeExtensions: string[];
  /** Code-extension-gated path prefixes (config `paths` ∪ defaults). */
  pathPrefixes: string[];
  /** Resolved code extension set (defaults ∪ add − remove; normalized). */
  codeExtensions: string[];
  /** Stable digest of the resolved policy for snapshot binding. */
  policyDigest: string;
}

export interface MaterialClassification {
  path: string;
  materialCode: boolean;
  reason: string;
}

export interface MaterialClassificationSnapshotFile extends MaterialClassification {}

export interface MaterialClassificationSnapshot {
  schemaVersion: typeof MATERIAL_CLASSIFICATION_SNAPSHOT_SCHEMA_VERSION;
  policyDigest: string;
  policy: MaterialCodePolicy;
  /** HEAD commit the snapshot was computed at (undefined outside a git tree). */
  headHash?: string;
  /** Whole-tree materialHash the snapshot was computed at. */
  materialHash?: string;
  gitCwd: string;
  projectRoot?: string;
  /** Immutable per-file classification of the main...HEAD diff. */
  files: MaterialClassificationSnapshotFile[];
  generatedAt: string;
}

/** Thrown when materialCode config is malformed — fail CLOSED, never silent-degrade. */
export class MaterialCodePolicyError extends Error {
  readonly offendingKey: string;
  constructor(offendingKey: string, message: string) {
    super(`material-code policy config invalid [${offendingKey}]: ${message}`);
    this.name = 'MaterialCodePolicyError';
    this.offendingKey = offendingKey;
  }
}

// ── path + name helpers ──

export function normalizeMaterialPath(path: string): string {
  return String(path).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function baseName(path: string): string {
  const parts = normalizeMaterialPath(path).split('/');
  return parts[parts.length - 1] ?? '';
}

/** Extension WITH a leading dot, lowercased. '' for extensionless files/dotfiles. */
export function materialPathExtension(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/** Normalize an extension to a leading-dot, lowercase form. '' stays ''. */
export function normalizeExtension(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return '';
  return value.startsWith('.') ? value : `.${value}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesNameGlob(pattern: string, name: string): boolean {
  const rx = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`, 'i');
  return rx.test(name);
}

/**
 * Segment-aware path-entry match. `src/` matches `src/x.py` (segment boundary)
 * but NEVER `src-old/x.py`; an exact file entry matches only that file.
 */
export function matchesScopePathEntry(entry: string, path: string): boolean {
  const e = normalizeMaterialPath(entry).replace(/\/+$/, '');
  const p = normalizeMaterialPath(path);
  if (!e || !p) return false;
  return p === e || p.startsWith(`${e}/`);
}

/** True when the basename is a level-1 immutable manifest (non-excludable). */
export function isImmutableManifestName(policy: MaterialCodePolicy, name: string): boolean {
  const lower = name.toLowerCase();
  if (policy.immutableManifestBasenames.includes(lower)) return true;
  return policy.immutableManifestPatterns.some((pattern) => matchesNameGlob(pattern, lower));
}

function isPlainTextName(name: string): boolean {
  const lower = name.toLowerCase();
  return PLAIN_TEXT_BASENAMES.includes(lower);
}

// ── config resolution (fail-closed) ──

let _policyCache: MaterialCodePolicy | undefined;
const _policyCacheByRoot = new Map<string, MaterialCodePolicy>();

/** Reset the resolved-policy cache (tests). */
export function resetMaterialCodePolicyCache(): void {
  _policyCache = undefined;
  _policyCacheByRoot.clear();
}

interface RawMaterialCodeConfig {
  addExtensions?: unknown;
  removeExtensions?: unknown;
  excludePaths?: unknown;
  paths?: unknown;
  docExtensions?: unknown;
}

function requireStringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new MaterialCodePolicyError(key, `expected an array of strings, got ${typeof value}`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new MaterialCodePolicyError(`${key}[${index}]`, `expected a non-empty string, got ${JSON.stringify(entry)}`);
    }
    return entry.trim();
  });
}

function normalizeExtensionList(value: unknown, key: string): string[] {
  const raw = requireStringArray(value, key);
  const out: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const normalized = normalizeExtension(entry);
    if (!normalized || !/^\.[a-z0-9._+-]+$/.test(normalized)) {
      throw new MaterialCodePolicyError(`${key}[${index}]`, `not a valid file extension: ${JSON.stringify(entry)}`);
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function dedupePaths(value: unknown, key: string): string[] {
  const raw = requireStringArray(value, key);
  const out: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeMaterialPath(entry);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function computePolicyDigest(policy: Omit<MaterialCodePolicy, 'policyDigest'>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: policy.schemaVersion,
      immutableManifestBasenames: [...policy.immutableManifestBasenames].sort(),
      immutableManifestPatterns: [...policy.immutableManifestPatterns].sort(),
      excludePaths: [...policy.excludePaths].sort(),
      docExtensions: [...policy.docExtensions].sort(),
      removeExtensions: [...policy.removeExtensions].sort(),
      pathPrefixes: [...policy.pathPrefixes].sort(),
      codeExtensions: [...policy.codeExtensions].sort(),
    }))
    .digest('hex');
}

/**
 * Resolve the material-code policy for a project root. FAILS CLOSED: malformed
 * materialCode config throws a MaterialCodePolicyError naming the offending key
 * rather than silently degrading to the TS-only whitelist. An excludePaths /
 * paths entry that names a level-1 immutable manifest is rejected here (the
 * config-resolve half of the two-layer immutability enforcement).
 */
export function resolveMaterialCodePolicy(projectRoot?: string): MaterialCodePolicy {
  const cacheKey = projectRoot ?? '';
  if (projectRoot === undefined) {
    if (_policyCache) return _policyCache;
  } else if (_policyCacheByRoot.has(cacheKey)) {
    return _policyCacheByRoot.get(cacheKey)!;
  }

  let raw: RawMaterialCodeConfig = {};
  if (projectRoot !== undefined) {
    let block: unknown;
    try {
      block = (loadConfig(projectRoot) as { materialCode?: unknown }).materialCode;
    } catch {
      block = undefined; // config load failure → defaults (no materialCode overrides present)
    }
    if (block !== undefined) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) {
        throw new MaterialCodePolicyError('materialCode', `expected an object, got ${Array.isArray(block) ? 'array' : typeof block}`);
      }
      raw = block as RawMaterialCodeConfig;
    }
  }

  const addExtensions = normalizeExtensionList(raw.addExtensions, 'materialCode.addExtensions');
  const removeExtensions = normalizeExtensionList(raw.removeExtensions, 'materialCode.removeExtensions');
  const docExtensions = raw.docExtensions === undefined
    ? [...DEFAULT_DOC_EXTENSIONS]
    : normalizeExtensionList(raw.docExtensions, 'materialCode.docExtensions');
  const excludePaths = dedupePaths(raw.excludePaths, 'materialCode.excludePaths');
  const configPaths = dedupePaths(raw.paths, 'materialCode.paths');

  const immutableBasenames = IMMUTABLE_MANIFEST_BASENAMES.map((n) => n.toLowerCase());
  const immutablePatterns = [...IMMUTABLE_MANIFEST_PATTERNS];
  const manifestGuard = {
    schemaVersion: MATERIAL_CODE_POLICY_SCHEMA_VERSION,
    immutableManifestBasenames: immutableBasenames,
    immutableManifestPatterns: immutablePatterns,
  } as MaterialCodePolicy;

  // Config-resolve immutability rejection: an exclude/paths entry naming a
  // level-1 manifest basename can never demote it.
  for (const entry of excludePaths) {
    if (isImmutableManifestName(manifestGuard, baseName(entry))) {
      throw new MaterialCodePolicyError('materialCode.excludePaths', `entry ${JSON.stringify(entry)} names a level-1 immutable runtime/build manifest, which cannot be excluded`);
    }
  }
  for (const entry of configPaths) {
    if (isImmutableManifestName(manifestGuard, baseName(entry))) {
      throw new MaterialCodePolicyError('materialCode.paths', `entry ${JSON.stringify(entry)} names a level-1 immutable runtime/build manifest`);
    }
  }

  const codeExtensions: string[] = [];
  for (const ext of [...DEFAULT_CODE_EXTENSIONS, ...addExtensions]) {
    if (!removeExtensions.includes(ext) && !codeExtensions.includes(ext)) codeExtensions.push(ext);
  }

  const pathPrefixes: string[] = [];
  for (const prefix of [...DEFAULT_PATH_PREFIXES, ...configPaths]) {
    const normalized = normalizeMaterialPath(prefix);
    if (normalized && !pathPrefixes.includes(normalized)) pathPrefixes.push(normalized);
  }

  const withoutDigest: Omit<MaterialCodePolicy, 'policyDigest'> = {
    schemaVersion: MATERIAL_CODE_POLICY_SCHEMA_VERSION,
    immutableManifestBasenames: immutableBasenames,
    immutableManifestPatterns: immutablePatterns,
    excludePaths,
    docExtensions,
    removeExtensions,
    pathPrefixes,
    codeExtensions,
  };
  const policy: MaterialCodePolicy = { ...withoutDigest, policyDigest: computePolicyDigest(withoutDigest) };

  if (projectRoot === undefined) _policyCache = policy;
  else _policyCacheByRoot.set(cacheKey, policy);
  return policy;
}

// ── the 8-step precedence chain (pure) ──

export interface ClassifyMaterialCodeOptions {
  /** projectRoot used only for storyDir-aware metadata exclusion (step 2). */
  projectRoot?: string;
  /**
   * For an extensionless file under a code path prefix (step 6): whether it
   * carries a shebang or executable bit. Precomputed by the snapshot builder
   * (from the OLD-tree blob for deleted/renamed files, CX3-10). Undefined =
   * treat as a non-script (conservative non-material).
   */
  shebangOrExecutable?: boolean;
}

/**
 * Classify a single path against the resolved policy using the plan's 8-step
 * first-hit-wins precedence chain. Pure: no config or filesystem reads.
 */
export function classifyMaterialCodePath(
  policy: MaterialCodePolicy,
  rawPath: string,
  opts: ClassifyMaterialCodeOptions = {},
): MaterialClassification {
  const path = normalizeMaterialPath(rawPath);
  if (!path) return { path, materialCode: false, reason: 'empty path' };

  const name = baseName(path);
  const ext = materialPathExtension(path);

  // Step 0 (structural): vendored/runtime artifacts (node_modules, dist, …) are
  // never your material — checked before the immutable-manifest rule so a
  // dependency's manifest is not misclassified. This is a STRUCTURAL exclusion,
  // not a config-key exclusion, so it does not weaken level-1 immutability.
  if (isMaterialExcludedRuntimeArtifactPath(path)) {
    return { path, materialCode: false, reason: 'runtime/build artifact (non-source)' };
  }

  // Step 1: level-1 immutable runtime/build-config manifests → material.
  if (isImmutableManifestName(policy, name)) {
    return { path, materialCode: true, reason: 'level-1 immutable runtime/build manifest' };
  }

  // Step 2: story-metadata exclusion via the resolved storyDir (config-aware).
  if (isStoryMetadataPath(path, opts.projectRoot)) {
    return { path, materialCode: false, reason: 'lattice runtime/story metadata' };
  }

  // Step 3: project config excludePaths (segment-aware) → non-material.
  if (policy.excludePaths.some((entry) => matchesScopePathEntry(entry, path))) {
    return { path, materialCode: false, reason: 'config excludePaths' };
  }

  // Step 4: documentation / binary formats → non-material (beats path prefixes).
  if (ext && policy.docExtensions.includes(ext)) {
    return { path, materialCode: false, reason: 'documentation/binary format' };
  }

  // Step 5: removeExtensions (subtracted from defaults) → non-material.
  if (ext && policy.removeExtensions.includes(ext)) {
    return { path, materialCode: false, reason: 'config removeExtensions' };
  }

  const underPathPrefix = policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, path));

  // Step 6: code-extension-gated path prefixes + shebang/exec rule for
  // extensionless scripts.
  if (underPathPrefix) {
    if (ext && policy.codeExtensions.includes(ext)) {
      return { path, materialCode: true, reason: 'code file under source/script path prefix' };
    }
    if (!ext) {
      if (isPlainTextName(name)) {
        return { path, materialCode: false, reason: 'plain-text name under path prefix' };
      }
      if (opts.shebangOrExecutable === true) {
        return { path, materialCode: true, reason: 'extensionless shebang/executable script' };
      }
      return { path, materialCode: false, reason: 'extensionless non-script under path prefix' };
    }
    // non-code extension under a path prefix → fall through.
  }

  // Step 7: resolved code extension set → material.
  if (ext && policy.codeExtensions.includes(ext)) {
    return { path, materialCode: true, reason: 'code extension' };
  }

  // Step 8: default → non-material (whitelist direction preserved).
  return { path, materialCode: false, reason: 'default non-material' };
}

// ── filesystem-aware immutability preflight ──

export interface MaterialCodeExclusionPreflightResult {
  ok: boolean;
  violations: Array<{ entry: string; manifest: string }>;
}

/**
 * Filesystem-aware transition preflight: walk the ACTUAL tree (via git ls-tree)
 * and reject any config exclusion path — directory-level included (e.g.
 * `backend/` hiding `backend/go.mod`) — that covers a real level-1 immutable
 * manifest. This is the second immutability-enforcement layer complementing the
 * config-resolve basename rejection.
 */
export function preflightMaterialCodeExclusions(
  policy: MaterialCodePolicy,
  gitCwd: string,
  ref = 'HEAD',
  trackedFiles?: string[],
): MaterialCodeExclusionPreflightResult {
  const files = trackedFiles ?? listTrackedFiles(gitCwd, ref);
  const violations: Array<{ entry: string; manifest: string }> = [];
  for (const entry of policy.excludePaths) {
    for (const file of files) {
      const path = normalizeMaterialPath(file);
      if (!isImmutableManifestName(policy, baseName(path))) continue;
      if (matchesScopePathEntry(entry, path)) {
        violations.push({ entry, manifest: path });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function listTrackedFiles(gitCwd: string, ref: string): string[] {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── hash-bound classification snapshot ──

export interface BuildMaterialClassificationSnapshotOptions {
  gitCwd?: string;
  policy?: MaterialCodePolicy;
  /** Override the classified changed-file set (else `git diff --name-only main...HEAD`). */
  changedFiles?: string[];
  headHash?: string;
  materialHash?: string;
}

function listMainToHeadDiff(gitCwd: string): string[] {
  try {
    const raw = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    return raw ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Read the shebang/executable signal for an extensionless file. Prefers the git
 * blob (works for deleted/renamed files whose worktree copy is gone — CX3-10);
 * falls back to the worktree only when the blob is unavailable.
 */
function extensionlessScriptSignal(gitCwd: string, path: string): boolean {
  // Executable bit at HEAD.
  try {
    const meta = execFileSync('git', ['ls-tree', 'HEAD', '--', path], {
      cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mode = meta.split(/\s+/)[0];
    if (mode === '100755') return true;
  } catch { /* not tracked at HEAD */ }
  // Shebang from the HEAD blob.
  for (const spec of [`HEAD:${path}`, `main:${path}`]) {
    try {
      const blob = execFileSync('git', ['show', spec], {
        cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      });
      if (blob.startsWith('#!')) return true;
      return false;
    } catch { /* try next spec */ }
  }
  return false;
}

/**
 * Build an immutable, hash-bound classification snapshot for the main...HEAD
 * diff. Embeds the HEAD + materialHash it was computed at so consumers can
 * detect drift and re-resolve. Best-effort git access: outside a git tree the
 * file set is empty and the hashes are undefined, but the resolved policy (the
 * load-bearing part for declared-file classification) is always present.
 */
export function buildMaterialClassificationSnapshot(
  projectRoot?: string,
  opts: BuildMaterialClassificationSnapshotOptions = {},
): MaterialClassificationSnapshot {
  const policy = opts.policy ?? resolveMaterialCodePolicy(projectRoot);
  const gitCwd = opts.gitCwd ?? projectRoot ?? process.cwd();
  const headHash = opts.headHash ?? currentGitHead(gitCwd);
  const materialHash = opts.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', projectRoot);
  const changedFiles = opts.changedFiles ?? listMainToHeadDiff(gitCwd);

  const files: MaterialClassificationSnapshotFile[] = changedFiles.map((rawPath) => {
    const path = normalizeMaterialPath(rawPath);
    const ext = materialPathExtension(path);
    const underPrefix = !ext && policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, path));
    const shebangOrExecutable = underPrefix ? extensionlessScriptSignal(gitCwd, path) : undefined;
    return classifyMaterialCodePath(policy, path, { projectRoot, shebangOrExecutable });
  });

  return {
    schemaVersion: MATERIAL_CLASSIFICATION_SNAPSHOT_SCHEMA_VERSION,
    policyDigest: policy.policyDigest,
    policy,
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    gitCwd,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    files,
    generatedAt: new Date().toISOString(),
  };
}

export interface SnapshotFreshnessArgs {
  gitCwd?: string;
  projectRoot?: string;
  headHash?: string;
  materialHash?: string;
}

/**
 * True when the snapshot's embedded HEAD or materialHash differs from the live
 * tree at decision time (long validations / concurrent commits). A snapshot
 * with no embedded hash is treated as stale (never silently consumed).
 */
export function materialClassificationSnapshotStale(
  snapshot: MaterialClassificationSnapshot,
  args: SnapshotFreshnessArgs = {},
): boolean {
  const gitCwd = args.gitCwd ?? snapshot.gitCwd;
  const projectRoot = args.projectRoot ?? snapshot.projectRoot;
  const liveHead = args.headHash ?? currentGitHead(gitCwd);
  const liveMaterial = args.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', projectRoot);
  if (!snapshot.headHash || !snapshot.materialHash) return true;
  if (liveHead && snapshot.headHash !== liveHead) return true;
  if (liveMaterial && snapshot.materialHash !== liveMaterial) return true;
  return false;
}

/**
 * Return the snapshot unchanged when it is still current, else re-resolve and
 * rebuild. Consumers thread the result so all three observe ONE fresh object.
 */
export function ensureFreshMaterialClassificationSnapshot(
  snapshot: MaterialClassificationSnapshot,
  args: SnapshotFreshnessArgs = {},
): MaterialClassificationSnapshot {
  if (!materialClassificationSnapshotStale(snapshot, args)) return snapshot;
  return buildMaterialClassificationSnapshot(args.projectRoot ?? snapshot.projectRoot, {
    gitCwd: args.gitCwd ?? snapshot.gitCwd,
    ...(args.headHash ? { headHash: args.headHash } : {}),
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
  });
}

/**
 * Classify a set of declared paths against a shared snapshot's policy. Consumers
 * MUST route declared-file classification through the shared snapshot rather
 * than re-deriving from raw paths with a config-blind classifier.
 */
export function classifyDeclaredPaths(
  snapshot: MaterialClassificationSnapshot,
  paths: readonly string[],
): MaterialClassification[] {
  return paths.map((path) => classifyMaterialCodePath(snapshot.policy, path, { projectRoot: snapshot.projectRoot }));
}
