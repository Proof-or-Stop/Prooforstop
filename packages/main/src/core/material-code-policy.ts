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
 * Only `resolveMaterialCodePolicy` reads config (content-signature-keyed cache
 * + filesystem exclusion preflight, both fail-closed) and only the snapshot
 * boundary (`buildMaterialClassificationSnapshot` / `classifyDeclaredPaths`
 * hint building) touches git/the filesystem; consumers route received
 * snapshots through `ensureFreshMaterialClassificationSnapshot`, which
 * re-checks the embedded head/material hashes AND the policyDigest against
 * live config at decision time and re-resolves on drift. Snapshots and
 * resolved policies are deep-frozen — mutation attempts throw.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { LATTICE_CONFIG_FILENAME } from './config.js';
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

/**
 * Step-0 structural generated/vendored directory segments (CX4 FIX D).
 * Segment-aware and STRUCTURAL (never config-driven): a manifest under any of
 * these directories (node_modules/pkg/package.json, dist/package.json) is a
 * dependency's or a build output's file, not the project's own level-1
 * runtime/build manifest. Evaluated BEFORE step 1, so no config key can reach
 * (and therefore weaken) level-1 immutability for first-party manifests.
 */
export const STRUCTURAL_ARTIFACT_DIR_SEGMENTS: readonly string[] = [
  'node_modules', 'dist', 'build', 'coverage', '.git',
];

function isStructuralArtifactPath(path: string): boolean {
  const segments = normalizeMaterialPath(path).split('/');
  // Directory segments only (never the basename): a FILE named `dist` or
  // `build.gradle` is not a vendored directory.
  return segments.slice(0, -1).some((segment) => STRUCTURAL_ARTIFACT_DIR_SEGMENTS.includes(segment.toLowerCase()));
}

/**
 * B-956f FIX 4: the shared step-0 "structurally non-material artifact" predicate
 * reused by the classifier and the exclusion preflight so precedence matches
 * exactly. A manifest under a generated/vendored artifact directory
 * (dist/package.json, node_modules/pkg/package.json) or a lattice runtime/build
 * artifact is a build output's / dependency's file — NOT the project's own
 * level-1 runtime/build manifest — so a config excludePaths entry covering it is
 * never an immutable-manifest violation. Composes the same two structural checks
 * the classifier applies at step 0 (no duplicated logic).
 */
function isStructurallyNonMaterialArtifactPath(path: string): boolean {
  const normalized = normalizeMaterialPath(path);
  return isStructuralArtifactPath(normalized) || isMaterialExcludedRuntimeArtifactPath(normalized);
}

/** Recursively freeze an object graph (CX4 FIX A): compiled output is strict-mode ESM, so any mutation attempt on a frozen snapshot/policy throws a TypeError. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

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
  /**
   * B-956f FIX 1: set when the main...HEAD diff enumeration itself failed (e.g.
   * `main` is unavailable). Consumers that gate on the diff (the review-assurance
   * floor) surface this as a hard "unable to classify git diff" block rather than
   * silently treating an unenumerable diff as an empty (non-material) change set.
   * Undefined on the success path and when the changed set was supplied directly.
   */
  diffEnumerationError?: string;
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

interface MaterialCodePolicyCacheEntry {
  /** sha256 of the raw config file content ('absent' when no config file). */
  configSignature: string;
  policy: MaterialCodePolicy;
}

let _defaultPolicyCache: MaterialCodePolicy | undefined;
const _policyCacheByRoot = new Map<string, MaterialCodePolicyCacheEntry>();

/** Reset the resolved-policy cache (tests). */
export function resetMaterialCodePolicyCache(): void {
  _defaultPolicyCache = undefined;
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
 * Read the RAW materialCode config block plus a content signature for the cache
 * key. Reads lattice.config.json DIRECTLY (not via loadConfig): loadConfig
 * caches per-root forever and swallows parse errors — both wrong at this
 * fail-closed, drift-sensitive boundary (CX4 FIX A: "re-resolve" must actually
 * reload config; a malformed config file must fail CLOSED, never silently
 * degrade to defaults).
 */
function readMaterialCodeConfig(projectRoot: string): { signature: string; raw: RawMaterialCodeConfig } {
  const configPath = join(projectRoot, LATTICE_CONFIG_FILENAME);
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch (err) {
    // B-956f FIX 3(a): ONLY a genuinely-absent file (ENOENT) degrades to defaults.
    // Any other read failure (EACCES/EISDIR/IO) is NOT "no config" — treating it as
    // absent is fail-OPEN (an unreadable config whose removeExtensions/excludePaths
    // silently vanish). Fail CLOSED naming the file instead.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { signature: 'absent', raw: {} }; // no config file → defaults
    }
    throw new MaterialCodePolicyError(
      LATTICE_CONFIG_FILENAME,
      `config file exists but could not be read (${err instanceof Error ? err.message : String(err)}); material-code policy fails closed instead of degrading to defaults`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new MaterialCodePolicyError(
      LATTICE_CONFIG_FILENAME,
      `config file is not valid JSON (${err instanceof Error ? err.message : String(err)}); material-code policy fails closed instead of degrading to defaults`,
    );
  }
  const signature = createHash('sha256').update(content).digest('hex');
  const block = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { materialCode?: unknown }).materialCode
    : undefined;
  if (block === undefined) return { signature, raw: {} };
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new MaterialCodePolicyError('materialCode', `expected an object, got ${Array.isArray(block) ? 'array' : typeof block}`);
  }
  return { signature, raw: block as RawMaterialCodeConfig };
}

/**
 * Resolve the material-code policy for a project root. FAILS CLOSED: malformed
 * materialCode config (or an unparseable config file) throws a
 * MaterialCodePolicyError naming the offending key rather than silently
 * degrading to the TS-only whitelist. An excludePaths / paths entry that names
 * a level-1 immutable manifest is rejected here, and the filesystem-aware
 * exclusion preflight ALSO runs here (CX4 FIX E) — the config-resolve boundary
 * is a production path, so `excludePaths: ["backend/"]` covering a real
 * backend/go.mod rejects at resolution, not only in a test harness.
 *
 * The per-root cache is keyed by the config file's content signature (CX4
 * FIX A): a config edit invalidates the cache, so re-resolution actually
 * reloads config instead of echoing a stale policy. The resolved policy is
 * deep-frozen — mutation attempts throw.
 */
export function resolveMaterialCodePolicy(projectRoot?: string): MaterialCodePolicy {
  if (projectRoot === undefined) {
    if (!_defaultPolicyCache) _defaultPolicyCache = deepFreeze(buildMaterialCodePolicy({}));
    return _defaultPolicyCache;
  }

  const { signature, raw } = readMaterialCodeConfig(projectRoot);
  const cached = _policyCacheByRoot.get(projectRoot);
  if (cached && cached.configSignature === signature) return cached.policy;

  const policy = buildMaterialCodePolicy(raw);
  // CX4 FIX E: the filesystem-aware exclusion preflight runs INSIDE production
  // resolution. Enumeration failure inside preflight throws (fail closed).
  if (policy.excludePaths.length > 0) {
    const preflight = preflightMaterialCodeExclusions(policy, projectRoot);
    if (!preflight.ok) {
      const detail = preflight.violations
        .map((violation) => `${JSON.stringify(violation.entry)} covers ${violation.manifest}`)
        .join('; ');
      throw new MaterialCodePolicyError(
        'materialCode.excludePaths',
        `exclusion covers real level-1 immutable runtime/build manifest(s) in the tracked tree: ${detail}`,
      );
    }
  }
  deepFreeze(policy);
  _policyCacheByRoot.set(projectRoot, { configSignature: signature, policy });
  return policy;
}

/** Build (and validate) a policy from a raw materialCode config block. */
function buildMaterialCodePolicy(raw: RawMaterialCodeConfig): MaterialCodePolicy {
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
  return { ...withoutDigest, policyDigest: computePolicyDigest(withoutDigest) };
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

  // Step 0 (structural): generated/vendored artifact directories and lattice
  // runtime artifacts are never your material — checked BEFORE the
  // immutable-manifest rule so a dependency's or a build output's manifest
  // (node_modules/pkg/package.json, dist/package.json — CX4 FIX D) is not
  // misclassified as the project's level-1 manifest. Both checks are
  // STRUCTURAL exclusions, not config-key exclusions, so they cannot be used
  // to weaken level-1 immutability.
  if (isStructuralArtifactPath(path)) {
    return { path, materialCode: false, reason: 'generated/vendored artifact directory (non-source)' };
  }
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
  if (policy.excludePaths.length === 0) return { ok: true, violations: [] };
  const files = trackedFiles ?? listTrackedFiles(gitCwd, ref);
  const violations: Array<{ entry: string; manifest: string }> = [];
  for (const entry of policy.excludePaths) {
    for (const file of files) {
      const path = normalizeMaterialPath(file);
      // B-956f FIX 4: skip manifests that are structurally non-material at step 0
      // (dist/package.json, node_modules/**, runtime artifacts) BEFORE applying
      // immutable-manifest protection — they are not the project's level-1
      // manifest, so excluding their directory is legitimate. This matches the
      // classifier's precedence (step 0 runs before the level-1 rule).
      if (isStructurallyNonMaterialArtifactPath(path)) continue;
      if (!isImmutableManifestName(policy, baseName(path))) continue;
      if (matchesScopePathEntry(entry, path)) {
        violations.push({ entry, manifest: path });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * FAIL CLOSED (quality F-001 / CX4 FIX E): a tree-enumeration failure throws a
 * named diagnostic — it never degrades to an empty file list, which would
 * silently turn the exclusion preflight into ok:true while a real level-1
 * manifest stays hidden under an excluded directory.
 */
function listTrackedFiles(gitCwd: string, ref: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new MaterialCodePolicyError(
      'materialCode.excludePaths',
      `filesystem exclusion preflight could not enumerate tracked files (git ls-tree -r ${ref} in ${gitCwd}): ${err instanceof Error ? err.message : String(err)}; failing closed`,
    );
  }
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
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

interface ChangedDiffEntry {
  path: string;
  /** Where extensionless shebang/exec hints must be read for this entry. */
  hintSource: 'current' | 'old-tree';
}

interface MainToHeadDiff {
  entries: ChangedDiffEntry[];
  /** Set when `git diff` itself failed (e.g. `main` is unavailable). */
  error?: string;
}

/**
 * Enumerate the main...HEAD diff with IDENTITY PRESERVED (CX4 FIX B):
 * `--name-status -z --find-renames` yields explicit D rows for deletions and
 * old/new path pairs for renames, so a deleted or renamed-away script keeps a
 * classifiable OLD-tree identity. `--name-only` loses both (a deleted
 * executable, shebang-free bin/tool classified non-material).
 */
function listMainToHeadDiffEntries(gitCwd: string): MainToHeadDiff {
  let raw: string;
  try {
    raw = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', 'main...HEAD'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // B-956f FIX 1: surface the enumeration failure so the floor can hard-block
    // ("unable to classify git diff against main") instead of consuming an empty
    // (non-material) change set — a silent bypass.
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
  const tokens = raw.split('\u0000');
  const entries: ChangedDiffEntry[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string | undefined, hintSource: 'current' | 'old-tree'): void => {
    if (!rawPath) return;
    const path = normalizeMaterialPath(rawPath);
    if (!path || seen.has(path)) return;
    seen.add(path);
    entries.push({ path, hintSource });
  };
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) continue; // trailing/empty token
    const kind = status[0]!.toUpperCase();
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      push(newPath, 'current');
      // A rename REMOVES the old path — classify it from the OLD tree. A copy
      // (C) leaves the old path untouched, so only renames add the old side.
      if (kind === 'R') push(oldPath, 'old-tree');
    } else {
      push(tokens[index++], kind === 'D' ? 'old-tree' : 'current');
    }
  }
  return { entries };
}

/** merge-base of main...HEAD — the OLD tree the triple-dot diff is computed against. */
function diffBaseRef(gitCwd: string): string {
  try {
    const base = execFileSync('git', ['merge-base', 'main', 'HEAD'], {
      cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (base) return base;
  } catch { /* fall back to main */ }
  return 'main';
}

/**
 * Read the shebang/executable signal for an extensionless file still present
 * on the CURRENT side of the diff (added/modified/rename-target). Prefers the
 * git blob/mode at HEAD; falls back to the main blob when HEAD is unavailable.
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
 * Shebang/exec signal for a DELETED or RENAMED-AWAY extensionless file, read
 * ENTIRELY from the OLD tree (CX4 FIX B): `git ls-tree <base> -- <path>` gives
 * the historical file MODE (a shebang-free executable is still a script) and
 * `git show <base>:<path>` gives the old blob's shebang. Neither HEAD nor the
 * worktree carries this identity any more.
 */
function oldTreeScriptSignal(gitCwd: string, baseRef: string, path: string): boolean {
  try {
    const meta = execFileSync('git', ['ls-tree', baseRef, '--', path], {
      cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (meta.split(/\s+/)[0] === '100755') return true;
  } catch { /* not present at base */ }
  try {
    const blob = execFileSync('git', ['show', `${baseRef}:${path}`], {
      cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    });
    return blob.startsWith('#!');
  } catch {
    return false;
  }
}

/**
 * Shebang/exec signal for a DECLARED extensionless path (CX4 FIX C): declared
 * checklist files may be outside the diff, so hints are built from the WORKING
 * TREE at the snapshot boundary (exec bit + `#!` prefix), falling back to the
 * git blob signal for paths not (yet) present on disk. The hintless pure
 * classifier is never invoked for a path that could carry hints.
 */
function workingTreeScriptSignal(gitCwd: string, path: string): boolean {
  const abs = join(gitCwd, path);
  try {
    const stats = statSync(abs);
    if (stats.isFile()) {
      if ((stats.mode & 0o111) !== 0) return true;
      const fd = openSync(abs, 'r');
      try {
        const head = Buffer.alloc(2);
        const read = readSync(fd, head, 0, 2, 0);
        return read === 2 && head[0] === 0x23 && head[1] === 0x21; // '#!'
      } finally {
        closeSync(fd);
      }
    }
  } catch { /* not in the worktree — fall back to the git blob signal */ }
  return extensionlessScriptSignal(gitCwd, path);
}

/**
 * Build an immutable (deep-frozen — mutation attempts throw, CX4 FIX A),
 * hash-bound classification snapshot for the main...HEAD diff. Embeds the HEAD
 * + materialHash + policyDigest it was computed at so consumers can detect
 * drift and re-resolve. Deleted and renamed-away files keep their OLD-tree
 * identity (CX4 FIX B). Best-effort git access: outside a git tree the file
 * set is empty and the hashes are undefined, but the resolved policy (the
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
  let diffEnumerationError: string | undefined;
  let entries: ChangedDiffEntry[];
  if (opts.changedFiles) {
    entries = opts.changedFiles
      .map((rawPath) => ({ path: normalizeMaterialPath(rawPath), hintSource: 'current' as const }))
      .filter((entry) => entry.path.length > 0);
  } else {
    const diff = listMainToHeadDiffEntries(gitCwd);
    entries = diff.entries;
    diffEnumerationError = diff.error;
  }
  let cachedBaseRef: string | undefined;
  const baseRef = (): string => (cachedBaseRef ??= diffBaseRef(gitCwd));

  const files: MaterialClassificationSnapshotFile[] = entries.map(({ path, hintSource }) => {
    const ext = materialPathExtension(path);
    const underPrefix = !ext && policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, path));
    const shebangOrExecutable = underPrefix
      ? (hintSource === 'old-tree' ? oldTreeScriptSignal(gitCwd, baseRef(), path) : extensionlessScriptSignal(gitCwd, path))
      : undefined;
    return classifyMaterialCodePath(policy, path, { projectRoot, shebangOrExecutable });
  });

  return deepFreeze({
    schemaVersion: MATERIAL_CLASSIFICATION_SNAPSHOT_SCHEMA_VERSION,
    policyDigest: policy.policyDigest,
    policy,
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    gitCwd,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    files,
    ...(diffEnumerationError ? { diffEnumerationError } : {}),
    generatedAt: new Date().toISOString(),
  });
}

export interface SnapshotFreshnessArgs {
  gitCwd?: string;
  projectRoot?: string;
  headHash?: string;
  materialHash?: string;
}

/**
 * True when the snapshot can no longer be consumed as-is (CX4 FIX A):
 *   - the embedded policyDigest no longer matches the embedded policy bytes
 *     (a mutated snapshot — defense in depth behind the deep freeze), or
 *   - the policy re-resolved from LIVE config has a different digest (config
 *     drift between build and consumption; the content-signature-keyed cache
 *     makes this a REAL reload, not a stale-cache echo), or
 *   - the embedded HEAD or materialHash differs from the live tree at decision
 *     time (long validations / concurrent commits). A snapshot with no
 *     embedded hash is treated as stale (never silently consumed).
 * A malformed live config THROWS here (fail closed at consumption).
 */
export function materialClassificationSnapshotStale(
  snapshot: MaterialClassificationSnapshot,
  args: SnapshotFreshnessArgs = {},
): boolean {
  const gitCwd = args.gitCwd ?? snapshot.gitCwd;
  const projectRoot = args.projectRoot ?? snapshot.projectRoot;
  if (computePolicyDigest(snapshot.policy) !== snapshot.policyDigest) return true;
  if (resolveMaterialCodePolicy(projectRoot).policyDigest !== snapshot.policyDigest) return true;
  if (!snapshot.headHash || !snapshot.materialHash) return true;
  const liveHead = args.headHash ?? currentGitHead(gitCwd);
  const liveMaterial = args.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', projectRoot);
  // B-956f FIX 2: never ACCEPT a snapshot whose freshness cannot be verified.
  // When the live HEAD/materialHash cannot be computed (nonexistent/unreadable
  // gitCwd), the previous code skipped the comparison and returned false ("fresh")
  // — a fail-OPEN that consumed an unverifiable snapshot. Throw a named freshness
  // diagnostic instead (fail closed); consumers that route through
  // ensureFreshMaterialClassificationSnapshot force a loud re-resolve, and the
  // gate evaluators catch it into a structured failing outcome.
  if (!liveHead || !liveMaterial) {
    throw new MaterialCodePolicyError(
      'materialClassification.freshness',
      `cannot verify snapshot freshness: live ${!liveHead ? 'HEAD' : 'materialHash'} is unavailable for gitCwd ${JSON.stringify(gitCwd)} (nonexistent/unreadable git tree); refusing to accept unverifiable freshness (fail closed)`,
    );
  }
  if (snapshot.headHash !== liveHead) return true;
  if (snapshot.materialHash !== liveMaterial) return true;
  return false;
}

/**
 * The validated consumption entry (CX4 FIX A): return the snapshot unchanged
 * when it is still current, else re-resolve (a REAL config reload through the
 * signature-keyed cache) and rebuild. EVERY consumer entry point — the floor,
 * classifyReproFirstRequirement/collectMaterialCodeFiles, and the ProofStory
 * diagnostic-input builders — routes a received snapshot through here.
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
 * Classify a set of declared paths against a shared snapshot. Consumers MUST
 * route declared-file classification through the shared snapshot rather than
 * re-deriving from raw paths with a config-blind classifier. CX4 FIX C:
 *   - a declared path the snapshot already classified is reused VERBATIM (its
 *     classification carried old-tree/exec-bit hints the pure classifier
 *     cannot re-derive — a changed bin/deploy must never flip between the
 *     snapshot and this call);
 *   - a declared path absent from the diff gets filesystem/blob hints (exec
 *     bit + shebang from the working tree) built at this snapshot boundary —
 *     the hintless pure classifier is never called for a path that could
 *     carry hints.
 */
export function classifyDeclaredPaths(
  snapshot: MaterialClassificationSnapshot,
  paths: readonly string[],
): MaterialClassification[] {
  const bySnapshotPath = new Map(snapshot.files.map((file) => [file.path, file]));
  return paths.map((rawPath) => {
    const path = normalizeMaterialPath(rawPath);
    const fromSnapshot = bySnapshotPath.get(path);
    if (fromSnapshot) {
      return { path: fromSnapshot.path, materialCode: fromSnapshot.materialCode, reason: fromSnapshot.reason };
    }
    const ext = materialPathExtension(path);
    const underPrefix = !ext && snapshot.policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, path));
    const shebangOrExecutable = underPrefix ? workingTreeScriptSignal(snapshot.gitCwd, path) : undefined;
    return classifyMaterialCodePath(snapshot.policy, path, { projectRoot: snapshot.projectRoot, shebangOrExecutable });
  });
}

/**
 * B-956f FIX G helper for the ProofStory diagnostic-input builders: build the
 * production materialClassification snapshot (fresh by construction — the
 * hash-bound build IS the FIX A freshness contract for producers). Returns
 * undefined instead of throwing: materialClassification is a DIAGNOSTIC field,
 * and a policy/config failure must surface through the fail-closed
 * resolve/floor/repro consumers — never by crashing a gate evaluation that
 * only reports diagnostics (which would itself change enforce outcomes).
 */
export function tryBuildMaterialClassificationSnapshotForDiagnostics(
  projectRoot?: string,
  gitCwd?: string,
): MaterialClassificationSnapshot | undefined {
  if (!projectRoot) return undefined;
  const buildOpts = { ...(gitCwd ? { gitCwd } : {}) };
  try {
    const snapshot = buildMaterialClassificationSnapshot(projectRoot, buildOpts);
    // B-956f FIX 5: the hash capture and the diff enumeration inside a single
    // build are not atomic — a concurrent HEAD move between them can yield an
    // internally mismatched snapshot. When the snapshot is git-bound, validate it
    // against the live tree and rebuild ONCE on mismatch so the returned snapshot
    // is self-consistent. A hashless (non-git) snapshot has no HEAD to move, so
    // it is returned as-is. Still fail-soft (undefined) on any policy/config
    // error or an unverifiable-freshness throw — this is a diagnostic-only field.
    if (!snapshot.headHash || !snapshot.materialHash) return snapshot;
    if (!materialClassificationSnapshotStale(snapshot)) return snapshot;
    return buildMaterialClassificationSnapshot(projectRoot, buildOpts);
  } catch {
    return undefined;
  }
}
