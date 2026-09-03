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
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { loadConfig, PROOF_OR_STOP_CONFIG_FILENAME, type ProofOrStopConfig } from './config.js';
import { CONFIG_FILENAMES } from './brand-paths.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import {
  currentGitHead,
  currentMaterialHash,
  isStoryMetadataPath,
} from './evidence-freshness.js';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { readGitBlobAt } from './git-blob-reader.js';

export const MATERIAL_CODE_POLICY_SCHEMA_VERSION = 'lattice.material_code_policy.v1' as const;
export const MATERIAL_CLASSIFICATION_SNAPSHOT_SCHEMA_VERSION =
  'lattice.material_classification_snapshot.v1' as const;

/** Level-1 immutable runtime/build-config manifest basenames (exact, case-insensitive). */
export const IMMUTABLE_MANIFEST_BASENAMES: readonly string[] = [
  // JS/TS runtime + lockfiles + proof-or-stop config.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  // B-cc10 CHK-004: BOTH config filenames are non-excludable. This list is a
  // deny-list protecting Level-1 manifests from being excluded via materialCode
  // config; listing only one spelling would let an excludePaths entry naming the
  // other spelling be ACCEPTED, silently removing the project config from
  // material classification. Sourced from the resolver so the pair cannot drift.
  ...CONFIG_FILENAMES,
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
 * (dist/package.json, node_modules/pkg/package.json) or a proof-or-stop runtime/build
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

/**
 * B-956f FIX 1 (codex MED — wrapper-root path namespace mismatch): the tree-bound
 * exclusion preflight and the per-file classifier compare git-emitted paths against
 * `excludePaths` / `pathPrefixes` / storyDir, which are PROJECT-relative (relative to
 * `projectRoot`, where proof-or-stop.config.json lives). Under the B-6666 resolveGitCwd
 * convention `gitCwd` is the resolved git ROOT (wrapper-root aware), so `git
 * ls-tree`/`git diff` emit REPO-relative paths (e.g. `project/backend/go.mod`). On a
 * wrapper-root layout (config in `<gitRoot>/project/`) those two namespaces disagree,
 * and a project-relative exclusion `backend/` silently fails to cover the real repo
 * path `project/backend/go.mod` — the builder would ACCEPT a policy hiding a level-1
 * manifest. Compute the project's repo-relative prefix ONCE (`relative(gitCwd,
 * projectRoot)`) and translate every git-emitted path into the project-relative
 * namespace before BOTH the preflight comparison and per-file classification. A
 * single-root layout (projectRoot === gitCwd, the common case) yields an EMPTY prefix
 * → identity → byte-identical to prior behavior.
 */
export function projectRepoPrefix(gitCwd: string | undefined, projectRoot: string | undefined): string {
  if (!projectRoot || !gitCwd) return '';
  // B-956f FIX 1 (R7 F-008): canonicalize BOTH sides (realpath when on disk) before
  // the relative() computation. The production gitCwd resolvers return REALPATHED
  // git roots (e.g. /private/var/… on macOS) while callers commonly hold a
  // symlinked projectRoot spelling (/var/…); comparing mixed spellings pushes rel
  // into the `..`-fallback below and silently disables the wrapper-root
  // translation even though the paths name the same tree.
  const rel = normalizeMaterialPath(relative(canonicalAbsolutePath(gitCwd), canonicalAbsolutePath(projectRoot)));
  // projectRoot === gitCwd → '' (identity, common single-root layout). A projectRoot
  // that escapes the git tree at gitCwd (rel begins with '..' or is absolute) cannot
  // be translated by a simple prefix strip, so fall back to identity (never worse
  // than prior behavior).
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return '';
  return rel.replace(/\/+$/, '');
}

/** realpath-when-on-disk absolute path (namespace comparisons must not mix symlink spellings). */
function canonicalAbsolutePath(path: string): string {
  const abs = resolve(path);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

/**
 * B-956f FIX 1: translate a git-emitted (repo-relative under the resolved-git-root
 * convention) path into the PROJECT-relative namespace given the project's
 * repo-relative prefix. Returns undefined when the path is OUTSIDE the project
 * subtree — a sibling/parent file that is not THIS project's file and must be
 * ignored. An empty prefix is identity (single-root layout).
 */
export function repoPathToProjectRelative(prefix: string, repoPath: string): string | undefined {
  const p = normalizeMaterialPath(repoPath);
  if (!prefix) return p;
  if (p.startsWith(`${prefix}/`)) return p.slice(prefix.length + 1);
  return undefined; // outside the project subtree
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
/**
 * B-956f FIX 3 (codex MED — preflight O(exclusions × trackedFiles)): memoize the
 * tree-bound exclusion preflight verdict by (resolved tree sha, policyDigest). The
 * verdict is a pure function of the committed tree (content-addressed sha) and the
 * resolved policy patterns, so the same (sha, policyDigest) always yields the same
 * verdict — a HEAD move produces a NEW sha (cache miss → re-verify), never a stale
 * accept. This makes the per-retry re-run from FIX 1 and repeated same-sha
 * resolutions cheap. Only cached on the git-enumerated path (never for an explicit
 * trackedFiles override, and never a fail-closed enumeration throw).
 */
const _preflightVerdictCache = new Map<string, MaterialCodeExclusionPreflightResult>();

/** Reset the resolved-policy cache (tests). */
export function resetMaterialCodePolicyCache(): void {
  _defaultPolicyCache = undefined;
  _policyCacheByRoot.clear();
  _preflightVerdictCache.clear();
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
 * key. Reads proof-or-stop.config.json DIRECTLY (not via loadConfig): loadConfig
 * caches per-root forever and swallows parse errors — both wrong at this
 * fail-closed, drift-sensitive boundary (CX4 FIX A: "re-resolve" must actually
 * reload config; a malformed config file must fail CLOSED, never silently
 * degrade to defaults).
 */
function readMaterialCodeConfig(projectRoot: string): { signature: string; raw: RawMaterialCodeConfig } {
  // B-cc10 CHK-004: probe BOTH config filenames, canonical first. This path
  // deliberately bypasses loadConfig, so it does not inherit the resolver used
  // there and must do its own read-both. Probing only the canonical name would
  // make an unmigrated project's ENOENT degrade to `{}` DEFAULTS — silently
  // dropping its materialCode removeExtensions/excludePaths, which is exactly
  // the fail-OPEN this function's FIX 3(a) comment exists to prevent.
  let configFilename = PROOF_OR_STOP_CONFIG_FILENAME;
  let content: string | undefined;
  let lastError: unknown;
  for (const candidate of CONFIG_FILENAMES) {
    try {
      content = readFileSync(join(projectRoot, candidate), 'utf8');
      configFilename = candidate;
      lastError = undefined;
      break;
    } catch (err) {
      // A non-ENOENT failure on a file that EXISTS must not be masked by simply
      // trying the next spelling: remember it and fail closed if nothing resolves.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') lastError = err;
    }
  }
  if (content === undefined) {
    if (lastError === undefined) {
      return { signature: 'absent', raw: {} }; // no config file under either name → defaults
    }
    const err = lastError;
    throw new MaterialCodePolicyError(
      configFilename,
      `config file exists but could not be read (${err instanceof Error ? err.message : String(err)}); material-code policy fails closed instead of degrading to defaults`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new MaterialCodePolicyError(
      // Name the spelling that actually resolved, so the diagnostic points at the
      // file on disk rather than at a canonical name that may not exist yet.
      configFilename,
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
  const policy = resolveMaterialCodePolicyConfigOnly(projectRoot);
  // B-956f FIX 1 (codex HIGH): config parsing/caching is now SEPARATE from the
  // tree-bound preflight. For standalone direct consumers (scope-diff-pack,
  // validate-concept, the floor's no-snapshot policy path) validate config
  // exclusions against LIVE HEAD here. The snapshot builder instead pins the sha
  // (capture-once) and runs the SAME preflight against THAT sha inside its
  // stability loop, so a snapshot is never bound to a tree the accepted policy was
  // not validated against. Enumeration failure inside the preflight throws (fail
  // closed); on a non-git root with exclusions this fails closed via the throw.
  // gitCwd === projectRoot here, so the project-relative translation is identity.
  assertMaterialCodeExclusionsAgainstTree(policy, projectRoot, 'HEAD', undefined, projectRoot);
  return policy;
}

/**
 * B-956f FIX 1 (codex HIGH — separate config parsing/caching from the tree-bound
 * preflight): resolve ONLY the config-derived policy (parse + build + digest +
 * config-key immutability rejection + content-signature cache). No filesystem/git
 * access happens here — the tree-bound exclusion preflight is a SEPARATE concern
 * (`assertMaterialCodeExclusionsAgainstTree`) so a caller that pins a specific sha
 * (the classification-snapshot builder) can run it against THAT sha rather than a
 * racy live HEAD read taken before the sha was captured.
 */
function resolveMaterialCodePolicyConfigOnly(projectRoot?: string): MaterialCodePolicy {
  if (projectRoot === undefined) {
    if (!_defaultPolicyCache) _defaultPolicyCache = deepFreeze(buildMaterialCodePolicy({}));
    return _defaultPolicyCache;
  }
  const { signature, raw } = readMaterialCodeConfig(projectRoot);
  const cached = _policyCacheByRoot.get(projectRoot);
  // The config-signature cache safely memoizes the config parse + policy build +
  // digest, which depend ONLY on the config file content. It is frozen once.
  if (cached && cached.configSignature === signature) return cached.policy;
  const policy = deepFreeze(buildMaterialCodePolicy(raw));
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

  // Step 0 (structural): generated/vendored artifact directories and proofOrStop
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
    return { path, materialCode: false, reason: 'proof-or-stop runtime/story metadata' };
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
  projectRoot?: string,
): MaterialCodeExclusionPreflightResult {
  if (policy.excludePaths.length === 0) return { ok: true, violations: [] };
  // B-956f FIX 1 (codex MED — wrapper-root path namespace): git ls-tree emits paths
  // in the git-root namespace; excludePaths are project-relative. Translate the tree
  // paths into the project namespace (dropping files outside the project subtree)
  // BEFORE candidate extraction so a project-relative exclusion is compared against
  // project-relative manifest paths. Identity when projectRoot === gitCwd.
  const prefix = projectRepoPrefix(gitCwd, projectRoot);
  const rawFiles = trackedFiles ?? listTrackedFiles(gitCwd, ref);
  const files: string[] = [];
  for (const raw of rawFiles) {
    const projectPath = repoPathToProjectRelative(prefix, raw);
    if (projectPath !== undefined) files.push(projectPath);
  }

  // B-956f FIX 3 (codex MED — O(exclusions × trackedFiles) → O(files + exclusions ×
  // candidates)): enumerate + normalize the tree ONCE and prefilter to the tiny set
  // of immutable-manifest CANDIDATES (files whose basename is a level-1 manifest and
  // are NOT structurally non-material at step 0), with the manifest basenames in a
  // Set and the name-glob patterns precompiled once. Only that small candidate set
  // is then compared against each exclusion entry — the old code re-scanned EVERY
  // tracked file (basename + glob) once per exclusion entry (9.6s at 50k files × 20
  // exclusions). Precedence is unchanged: a candidate is exactly a file the
  // classifier treats as a level-1 manifest (step 1) and does not skip at step 0.
  const basenameSet = new Set(policy.immutableManifestBasenames); // already lowercased
  const patternRegexes = policy.immutableManifestPatterns.map(
    (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`, 'i'),
  );
  const candidates: string[] = [];
  for (const file of files) {
    const path = normalizeMaterialPath(file);
    const base = baseName(path).toLowerCase();
    if (!basenameSet.has(base) && !patternRegexes.some((rx) => rx.test(base))) continue;
    if (isStructurallyNonMaterialArtifactPath(path)) continue;
    candidates.push(path);
  }

  const violations: Array<{ entry: string; manifest: string }> = [];
  for (const entry of policy.excludePaths) {
    for (const manifest of candidates) {
      if (matchesScopePathEntry(entry, manifest)) {
        violations.push({ entry, manifest });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * B-956f FIX 1 + FIX 3: run the tree-bound exclusion preflight against a SPECIFIC
 * ref — a pinned commit sha from the snapshot builder, or live HEAD for standalone
 * resolution — and throw MaterialCodePolicyError on any level-1 manifest coverage.
 * The verdict is memoized by (resolved tree sha, RECOMPUTED policy digest) so the
 * per-retry re-run (FIX 1) and repeated same-sha resolutions do not re-walk the
 * tree; a HEAD move yields a new sha and thus a cache miss (never a stale accept).
 * A no-exclusions policy is a no-op (no git access). Enumeration failure inside the
 * preflight propagates (fail closed) and is never cached — so on a non-git root /
 * pre-first-commit repo / wrapper-root miss WITH exclusions the tracked-file
 * enumeration throw fails closed, the SAME behavior class as resolveMaterialCodePolicy
 * (the snapshot builder relies on this: B-956f FIX 1 removes its `if (headRef)` gate).
 *
 * B-956f FIX 3 (codex H2 — cache-poison via a forged embedded digest): the supplied
 * policy's policyDigest is NEVER trusted. The canonical digest is RECOMPUTED from the
 * policy's actual fields and any mismatch is REJECTED before the cache is consulted,
 * and the cache is keyed by the recomputed digest only — so a hand-built policy whose
 * embedded digest was forged to alias another policy's cached verdict cannot slip its
 * different excludePaths past the preflight.
 */
export function assertMaterialCodeExclusionsAgainstTree(
  policy: MaterialCodePolicy,
  gitCwd: string | undefined,
  ref = 'HEAD',
  trackedFiles?: string[],
  projectRoot?: string,
): void {
  // B-956f FIX 3: bind trust to the RECOMPUTED digest, not the caller-supplied
  // field. Recompute from the actual policy fields and reject a forged/mismatched
  // embedded digest (fail closed) BEFORE any cache lookup or early return.
  const recomputedDigest = computePolicyDigest(policy);
  if (recomputedDigest !== policy.policyDigest) {
    throw new MaterialCodePolicyError(
      'materialCode.policyDigest',
      `supplied material-code policy carries an embedded policyDigest ${JSON.stringify(policy.policyDigest)} ` +
        `that does not match the digest recomputed from its actual fields ${JSON.stringify(recomputedDigest)}; ` +
        `refusing to trust a policy whose embedded digest was forged to alias a cached exclusion verdict (fail closed)`,
    );
  }
  if (policy.excludePaths.length === 0) return;
  const cwd = gitCwd ?? process.cwd();
  let effectiveRef = ref;
  let cacheKey: string | undefined;
  if (!trackedFiles) {
    // Pin the ref to a concrete tree sha so the cache key is HEAD-move-safe and the
    // ls-tree enumeration targets the exact same commit. A non-git tree yields no
    // sha; we then run the preflight against the raw ref so it fails closed via the
    // enumeration throw (an unresolvable tree with exclusions cannot be accepted).
    const sha = ref === 'HEAD' ? currentGitHead(cwd) : ref;
    if (sha) {
      effectiveRef = sha;
      // B-956f FIX 3: key by the RECOMPUTED digest (== the now-validated embedded
      // digest) only, so a forged digest can never select a cached row.
      // B-956f FIX 1 (R7): the verdict is a pure function of (tree sha, policy,
      // NAMESPACE PREFIX) — the prefix, not the raw projectRoot spelling, decides
      // how tree paths translate before comparison. Key by the computed prefix so
      // (a) two wrapper-root projects under different prefixes never alias each
      // other's verdict, and (b) the SAME (sha, digest, projectRoot) evaluated with
      // DIFFERENT gitCwds (an untranslated projectRoot-cwd call vs a resolved-root
      // call) can never replay the other shape's verdict.
      cacheKey = `${sha} ${recomputedDigest} ${projectRepoPrefix(cwd, projectRoot)}`;
      const cached = _preflightVerdictCache.get(cacheKey);
      if (cached) {
        throwOnExclusionViolation(cached);
        return;
      }
    }
  }
  const verdict = preflightMaterialCodeExclusions(policy, cwd, effectiveRef, trackedFiles, projectRoot);
  if (cacheKey) _preflightVerdictCache.set(cacheKey, verdict);
  throwOnExclusionViolation(verdict);
}

function throwOnExclusionViolation(verdict: MaterialCodeExclusionPreflightResult): void {
  if (verdict.ok) return;
  const detail = verdict.violations
    .map((violation) => `${JSON.stringify(violation.entry)} covers ${violation.manifest}`)
    .join('; ');
  throw new MaterialCodePolicyError(
    'materialCode.excludePaths',
    `exclusion covers real level-1 immutable runtime/build manifest(s) in the tracked tree: ${detail}`,
  );
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
  /**
   * Resolved git root override. When OMITTED, the builder resolves a SAFE default
   * itself (B-956f R7 F-008/F-011/F-013): the id-independent project git root via
   * resolveProjectGitCwd (a valid configured gitRoot, else the projectRoot's own
   * `git rev-parse --show-toplevel`), so a bare
   * buildMaterialClassificationSnapshot(projectRoot) on a wrapper-root layout
   * still translates git-emitted repo-relative paths into the project namespace.
   * Callers holding a STORY-scoped resolution (worktree bindings) must still
   * thread it explicitly — resolveGitCwd(...) is strictly more informed than the
   * project-level default. Never pass a bare projectRoot here "as a default";
   * that re-introduces the untranslated wrapper-root misclassification.
   */
  gitCwd?: string;
  policy?: MaterialCodePolicy;
  /** Override the classified changed-file set (else `git diff --name-only main...HEAD`). */
  changedFiles?: string[];
  headHash?: string;
  materialHash?: string;
}

/**
 * B-956f FIX 4 (codex M — test seam in the public production API): the head-capture
 * hook is NOT part of any public options type and is NEVER passed by production
 * callers. It lives in a MODULE-PRIVATE slot, installed only via the test-only
 * setter below, so production call sites carry no optional test callback. Invoked
 * with the captured head sha immediately AFTER capture and BEFORE the pinned-sha
 * exclusion preflight, so a smoke can deterministically land a commit mid-build and
 * prove that (a) the preflight binds to the captured sha and (b) the post-build
 * HEAD-stability validation forces a rebuild against the moved sha.
 */
let _afterHeadCaptureHookForTest: ((headRef: string | undefined) => void) | undefined;

/**
 * TEST-ONLY: install (or clear with `undefined`) the mid-build head-capture hook.
 * The language-neutral-gates smoke imports this to exercise the HEAD-move race, and
 * MUST reset it (`__setAfterHeadCaptureHookForTest(undefined)`) after use. Prefixed
 * `__…ForTest`; not part of the public snapshot-builder contract.
 */
export function __setAfterHeadCaptureHookForTest(
  hook: ((headRef: string | undefined) => void) | undefined,
): void {
  _afterHeadCaptureHookForTest = hook;
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
function listMainToHeadDiffEntries(gitCwd: string, headRef = 'HEAD'): MainToHeadDiff {
  let raw: string;
  try {
    // B-956f FIX 1: diff against the pinned HEAD sha (headRef), not the symbolic
    // ref, so a concurrent HEAD move cannot change the enumerated set mid-build.
    raw = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', `main...${headRef}`], {
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
function diffBaseRef(gitCwd: string, headRef = 'HEAD'): string {
  try {
    const base = execFileSync('git', ['merge-base', 'main', headRef], {
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
function extensionlessScriptSignal(gitCwd: string, path: string, headRef = 'HEAD'): boolean {
  for (const ref of [headRef, 'main']) {
    const blob = readGitBlobAt(gitCwd, ref, path);
    // Classification is a gate input. An unreadable tracked state must remain
    // conservative instead of silently becoming a non-material file.
    if (blob.status === 'error') return true;
    if (blob.status === 'missing') continue;
    return blob.mode === '100755' || blob.content.subarray(0, 2).toString() === '#!';
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
  const blob = readGitBlobAt(gitCwd, baseRef, path);
  if (blob.status === 'error') return true;
  if (blob.status === 'missing') return false;
  return blob.mode === '100755' || blob.content.subarray(0, 2).toString() === '#!';
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
/**
 * B-956f FIX 1: bounded retries when HEAD moves DURING snapshot construction. A
 * concurrent commit between capturing the head sha and enumerating the diff/hints
 * would yield an internally inconsistent snapshot; we rebuild against the new sha
 * and, if HEAD never stabilizes within this bound, fail closed.
 */
const MAX_SNAPSHOT_HEAD_STABILITY_RETRIES = 2;

/**
 * B-956f FIX 1 (R7 F-008/F-011/F-013 — safe default gitCwd): the previous default
 * (`gitCwd = projectRoot`) computed an IDENTITY projectRepoPrefix while git — which
 * walks upward to find the repository — still emitted repo-root-relative diff/tree
 * paths, so every no-override caller (the repro-evidence-binding gate, the
 * STORY_INTAKE preflight, diagnostics builds without a resolvable story) silently
 * skipped the wrapper-root namespace translation: material files misclassified
 * ({path:"project/bin/tool", materialCode:false} instead of {path:"bin/tool",
 * materialCode:true}) and project-relative excludePaths never applied. Default to
 * the id-independent resolved project git root instead (a valid configured
 * gitRoot, else the projectRoot's own `git rev-parse --show-toplevel`). A plain
 * single-root layout resolves to the projectRoot's own toplevel (identity prefix —
 * byte-identical classification); a non-git projectRoot falls back to projectRoot
 * verbatim (unchanged fail-closed behavior downstream). Config-load failures fall
 * back to config-less resolution — a malformed proof-or-stop.config.json already fails
 * closed in resolveMaterialCodePolicyConfigOnly BEFORE this default is consulted.
 */
function resolveDefaultSnapshotGitCwd(projectRoot: string | undefined): string {
  if (!projectRoot) return process.cwd();
  try {
    let config: ProofOrStopConfig | undefined;
    try {
      config = loadConfig(projectRoot);
    } catch {
      config = undefined;
    }
    return resolveProjectGitCwd(projectRoot, projectRoot, config);
  } catch {
    return projectRoot;
  }
}

export function buildMaterialClassificationSnapshot(
  projectRoot?: string,
  opts: BuildMaterialClassificationSnapshotOptions = {},
): MaterialClassificationSnapshot {
  // B-956f FIX 1 (codex HIGH): config-only policy resolution — NO live-HEAD
  // preflight here (that ran before the sha was captured and could bind a snapshot
  // to a tree the policy was never validated against). The tree-bound exclusion
  // preflight runs against the PINNED sha inside the loop below instead.
  const policy = opts.policy ?? resolveMaterialCodePolicyConfigOnly(projectRoot);
  const gitCwd = opts.gitCwd ?? resolveDefaultSnapshotGitCwd(projectRoot);

  // B-956f FIX 1 (codex HIGH — HEAD-move race): capture HEAD as ONE immutable
  // commit sha, run the tree-bound exclusion preflight AND all diff/hint
  // enumeration against that exact sha, then POST-VALIDATE that live HEAD still
  // equals the captured sha. On a mismatch a commit landed mid-build, so the
  // enumerated set and the embedded hashes may disagree — rebuild against the new
  // sha (bounded retries). If no stable snapshot is reached, throw the named
  // freshness diagnostic (fail closed). This is the ONLY builder, so every
  // consumer/refresh/rebuild path (the floor, ensureFreshMaterialClassificationSnapshot,
  // the diagnostics builder) inherits both the pinned-sha preflight and the
  // post-validation — no path returns an unvalidated snapshot. Outside a git tree
  // there is no HEAD to move and no tracked manifest to hide, so the single build
  // is returned directly.
  for (let attempt = 0; ; attempt++) {
    const headRef = currentGitHead(gitCwd);
    // TEST-ONLY seam (module-private slot; see __setAfterHeadCaptureHookForTest):
    // production callers can never pass this. Fires after sha capture, before the
    // preflight.
    _afterHeadCaptureHookForTest?.(headRef);
    // B-956f FIX 1 (codex H3 = quality F-006 = test-coverage F-007 — non-git-root
    // fail-open): validate config exclusions against the pinned tree on EVERY path,
    // NOT gated on `if (headRef)`. When headRef is a pinned sha the preflight binds
    // to the EXACT tree the snapshot will use (a mid-build commit adding a covered
    // backend/go.mod under an excluded backend/ is rejected here). When NO HEAD
    // resolves (non-git root, pre-first-commit repo, or wrapper-root miss) a policy
    // WITH exclusions cannot be validated against a tree that does not exist, so it
    // FAILS CLOSED through assertMaterialCodeExclusionsAgainstTree's enumeration
    // throw — the SAME behavior class as resolveMaterialCodePolicy — never a
    // silently-returned unvalidated snapshot. A no-exclusions policy is a no-op and
    // still builds (nothing to validate).
    // B-956f FIX 1: thread projectRoot so the pinned-sha exclusion preflight compares
    // in the PROJECT-relative namespace on a wrapper-root layout (gitCwd = git root,
    // projectRoot = config subdir). Identity when they coincide.
    assertMaterialCodeExclusionsAgainstTree(policy, gitCwd, headRef, undefined, projectRoot);
    const snapshot = buildMaterialClassificationSnapshotAtRef(projectRoot, gitCwd, policy, headRef, opts);
    if (!headRef) return snapshot; // non-git tree: nothing to race against
    const liveHead = currentGitHead(gitCwd);
    if (liveHead === headRef) return snapshot;
    if (attempt >= MAX_SNAPSHOT_HEAD_STABILITY_RETRIES) {
      throw new MaterialCodePolicyError(
        'materialClassification.freshness',
        `HEAD moved during classification snapshot construction for gitCwd ${JSON.stringify(gitCwd)} ` +
          `(captured ${headRef}, live ${liveHead ?? 'unavailable'}) across ${attempt + 1} attempts; ` +
          `refusing to return an internally inconsistent snapshot (fail closed)`,
      );
    }
    // else: loop and rebuild against the moved HEAD.
  }
}

/**
 * Build one classification snapshot against a PINNED head sha (`headRef`). All
 * git access (diff enumeration, merge-base, old-tree/head hint reads, materialHash)
 * targets that exact sha so the result is internally consistent for that commit.
 * `headRef` is undefined only outside a git tree.
 */
function buildMaterialClassificationSnapshotAtRef(
  projectRoot: string | undefined,
  gitCwd: string,
  policy: MaterialCodePolicy,
  headRef: string | undefined,
  opts: BuildMaterialClassificationSnapshotOptions,
): MaterialClassificationSnapshot {
  const headHash = opts.headHash ?? headRef;
  const materialHash = opts.materialHash ?? currentMaterialHash(gitCwd, headRef ?? 'HEAD', projectRoot);
  let diffEnumerationError: string | undefined;
  let entries: ChangedDiffEntry[];
  if (opts.changedFiles) {
    entries = opts.changedFiles
      .map((rawPath) => ({ path: normalizeMaterialPath(rawPath), hintSource: 'current' as const }))
      .filter((entry) => entry.path.length > 0);
  } else {
    const diff = listMainToHeadDiffEntries(gitCwd, headRef);
    entries = diff.entries;
    diffEnumerationError = diff.error;
  }
  let cachedBaseRef: string | undefined;
  const baseRef = (): string => (cachedBaseRef ??= diffBaseRef(gitCwd, headRef));

  // B-956f FIX 1 (codex MED — wrapper-root path namespace): the git diff enumerates
  // paths in the git-root namespace (repo-relative under the resolveGitCwd
  // convention), but excludePaths/pathPrefixes/storyDir are project-relative. Keep the
  // git-namespace path for git blob/mode HINT reads (they run at gitCwd) and translate
  // to the PROJECT-relative path for prefix-matching + classification, dropping files
  // OUTSIDE the project subtree (not this project's files). An explicit changedFiles
  // override is taken as already project-relative (caller namespace) → no translation.
  const namespacePrefix = opts.changedFiles ? '' : projectRepoPrefix(gitCwd, projectRoot);
  const files: MaterialClassificationSnapshotFile[] = entries.flatMap(({ path: gitPath, hintSource }) => {
    const projectPath = repoPathToProjectRelative(namespacePrefix, gitPath);
    if (projectPath === undefined) return []; // outside the project subtree — ignored
    const ext = materialPathExtension(projectPath);
    const underPrefix = !ext && policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, projectPath));
    const shebangOrExecutable = underPrefix
      ? (hintSource === 'old-tree' ? oldTreeScriptSignal(gitCwd, baseRef(), gitPath) : extensionlessScriptSignal(gitCwd, gitPath, headRef))
      : undefined;
    return [classifyMaterialCodePath(policy, projectPath, { projectRoot, shebangOrExecutable })];
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
  // B-956f FIX 1: compare against the CONFIG-resolved digest only. The digest is a
  // pure function of config, and the tree-bound preflight is validated at build/
  // resolve time — re-running it in this hot freshness path would re-walk the tree
  // on every consumer check. A malformed config still fails closed here (the throw
  // originates in readMaterialCodeConfig, inside the config-only resolver).
  if (resolveMaterialCodePolicyConfigOnly(projectRoot).policyDigest !== snapshot.policyDigest) return true;
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
  // B-956f FIX 2 (R7 F-009 — declared-path hint reads in the wrong namespace):
  // declared paths are PROJECT-relative, but the working-tree/blob hint readers run
  // at snapshot.gitCwd — the resolved git ROOT under the FIX 1 threading. Translate
  // a declared path in the REVERSE direction (project → git namespace: prepend the
  // project's repo-relative prefix) before the hint read, or a wrapper-root layout
  // stats/ls-trees `<gitRoot>/bin/deploy` instead of `<gitRoot>/project/bin/deploy`
  // and a declared extensionless script silently loses its shebang/exec-bit signal.
  // Identity when projectRoot === gitCwd (single-root layout).
  const namespacePrefix = projectRepoPrefix(snapshot.gitCwd, snapshot.projectRoot);
  return paths.map((rawPath) => {
    const path = normalizeMaterialPath(rawPath);
    const fromSnapshot = bySnapshotPath.get(path);
    if (fromSnapshot) {
      return { path: fromSnapshot.path, materialCode: fromSnapshot.materialCode, reason: fromSnapshot.reason };
    }
    const ext = materialPathExtension(path);
    const underPrefix = !ext && snapshot.policy.pathPrefixes.some((prefix) => matchesScopePathEntry(prefix, path));
    const gitNamespacePath = namespacePrefix ? `${namespacePrefix}/${path}` : path;
    const shebangOrExecutable = underPrefix ? workingTreeScriptSignal(snapshot.gitCwd, gitNamespacePath) : undefined;
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
    // B-956f FIX 1: buildMaterialClassificationSnapshot now pins HEAD to one sha,
    // enumerates against it, and post-validates HEAD stability (rebuilding on a
    // concurrent HEAD move, failing closed if it never stabilizes). The returned
    // git-bound snapshot is therefore internally self-consistent by construction,
    // so no separate re-validation is needed here. Still fail-soft (undefined) on
    // any policy/config error or an unverifiable-freshness throw — this is a
    // diagnostic-only field and must never crash a gate evaluation.
    return buildMaterialClassificationSnapshot(projectRoot, buildOpts);
  } catch {
    return undefined;
  }
}
