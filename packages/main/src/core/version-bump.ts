/**
 * Auto patch-version bump on DONE merge to local main (B-aa8a).
 *
 * The CLI version lives in FIVE sync points that rollout-check enforces identical:
 *   1. <root>/package.json                              "version"
 *   2. <root>/package-lock.json                         "version" + root package entry
 *   3. <root>/packages/main/package.json                "version"
 *   4. <root>/packages/main/package-lock.json           "version" + root package entry
 *   5. <root>/packages/main/src/core/proof-or-stop-brand.ts   export const PROOF_OR_STOP_CLI_VERSION
 *
 * This module is PURE (no git, no done-effects import — avoids a circular dependency;
 * done-effects passes in the `shouldBump` decision and a `runGit` runner). It reads all
 * three STRUCTURALLY (package.json via JSON parse of the top-level `version`; the brand
 * via a regex anchored to the `export const` declaration so comments/duplicates can never
 * be mistaken for the real constant), asserts they are in sync, and patch-bumps them
 * atomically — rolling back on any write OR post-write-verification failure rather than
 * leaving the three points drifted. done-effects.ts calls bumpVersionOnDoneMerge after the
 * DONE merge and before the dist rebuild, so the rebuilt dist reports the new version with
 * no extra build step.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Relative paths (from the repo root) of the three version sync points. */
export const VERSION_SYNC_FILES = {
  rootPackageJson: 'package.json',
  rootPackageLock: 'package-lock.json',
  mainPackageJson: 'packages/main/package.json',
  mainPackageLock: 'packages/main/package-lock.json',
  brand: 'packages/main/src/core/proof-or-stop-brand.ts',
} as const;

/** Ordered list of the three relative sync-point paths (for `git add`). */
export const VERSION_SYNC_PATHS: readonly string[] = [
  VERSION_SYNC_FILES.rootPackageJson,
  VERSION_SYNC_FILES.rootPackageLock,
  VERSION_SYNC_FILES.mainPackageJson,
  VERSION_SYNC_FILES.mainPackageLock,
  VERSION_SYNC_FILES.brand,
];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const ACCEPTED_ROOT_PACKAGE_NAMES: ReadonlySet<string> = new Set(['proof-or-stop', 'lattice']);
/**
 * Matches an EXPORTED PROOF_OR_STOP_CLI_VERSION declaration in proof-or-stop-brand.ts. Anchored to the
 * start of a line (`^[ \t]*` under `/m`) followed by `export const`, and applied to a
 * COMMENT-STRIPPED view of the file (see stripComments), so neither a `// ...` line comment,
 * a commented-out `// export const ...` line, nor a `/* ... *​/` block-commented export can
 * be mistaken for the real constant. Global so callers can count occurrences.
 */
const BRAND_EXPORT_RE = /^[ \t]*export\s+const\s+PROOF_OR_STOP_CLI_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/gm;

/**
 * Remove `/* *​/` block comments and `//` line comments. Pragmatic for the controlled
 * proof-or-stop-brand.ts (no comment markers live inside its string literals) — NOT a full TS
 * parser; findBrandExport adds a raw-vs-stripped count guard to refuse any file where an
 * export-shaped PROOF_OR_STOP_CLI_VERSION line also appears in a comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Strictly parse an `X.Y.Z` semver; throw on anything else (no pre-release/build metadata). */
export function parseSemver(version: string): Semver {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) throw new Error(`version-bump: malformed semver "${version}" (expected strict X.Y.Z)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Patch-only increment: 0.3.9 -> 0.3.10. Major/minor are never touched. */
export function nextPatch(version: string): string {
  const v = parseSemver(version);
  return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
}

/** Read the structural top-level `version` from a package.json/package-lock.json. */
function readJsonVersion(absPath: string): string {
  const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`version-bump: ${absPath} has no string top-level "version" field`);
  }
  return parsed.version;
}

function readJsonPackageName(absPath: string, label: string): string {
  const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as { name?: unknown };
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`version-bump: ${label} has no string top-level "name" field`);
  }
  return parsed.name;
}

/**
 * Root package identity is a publish-level contract, not just display metadata.
 * Accept the pre-migration spelling while an older checkout is being read, but
 * fail closed when package.json and either root lockfile name disagree.
 */
function assertRootPackageIdentity(root: string): void {
  const packageName = readJsonPackageName(join(root, VERSION_SYNC_FILES.rootPackageJson), 'root package.json');
  const lock = JSON.parse(readFileSync(join(root, VERSION_SYNC_FILES.rootPackageLock), 'utf-8')) as {
    name?: unknown;
    packages?: Record<string, { name?: unknown }>;
  };
  const lockName = lock.name;
  const lockRootName = lock.packages?.['']?.name;
  const names = [packageName, lockName, lockRootName];
  if (typeof lockName !== 'string' || typeof lockRootName !== 'string') {
    throw new Error('version-bump: root package identity is missing from package-lock.json');
  }
  if (!ACCEPTED_ROOT_PACKAGE_NAMES.has(packageName) || !names.every(name => name === packageName)) {
    throw new Error(
      `version-bump: root package identity is out of sync ` +
      `(package.json=${packageName}, package-lock.json=${lockName}, package-lock.json packages[""]=${lockRootName}); ` +
      'refusing to bump until the canonical root identity is reconciled.',
    );
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLockPackageVersion(parsed: JsonRecord, packageKey: string, label: string): string {
  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(`version-bump: ${label} has no object "packages" field`);
  }
  const entry = packages[packageKey];
  if (!isRecord(entry)) {
    throw new Error(`version-bump: ${label} has no object packages[${JSON.stringify(packageKey)}] entry`);
  }
  if (typeof entry.version !== 'string') {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] has no string "version" field`);
  }
  return entry.version;
}

function readOptionalLockPackageVersion(parsed: JsonRecord, packageKey: string, label: string): string | null {
  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(`version-bump: ${label} has no object "packages" field`);
  }
  const entry = packages[packageKey];
  if (entry === undefined) return null;
  if (!isRecord(entry)) {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] is not an object`);
  }
  if (entry.version === undefined) return null;
  if (typeof entry.version !== 'string') {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] has non-string "version" field`);
  }
  return entry.version;
}

function readPackageLockVersions(absPath: string, label: string, optionalPackageKeys: string[] = []): Array<{ label: string; version: string }> {
  const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as JsonRecord;
  if (typeof parsed.version !== 'string') {
    throw new Error(`version-bump: ${label} has no string top-level "version" field`);
  }
  const versions = [
    { label, version: parsed.version },
    { label: `${label} packages[""]`, version: readLockPackageVersion(parsed, '', label) },
  ];
  for (const key of optionalPackageKeys) {
    const version = readOptionalLockPackageVersion(parsed, key, label);
    if (version !== null) versions.push({ label: `${label} packages[${JSON.stringify(key)}]`, version });
  }
  return versions;
}

/** Return a package.json content string with ONLY the top-level `version` set to `to`. */
function bumpJsonVersionContent(content: string, from: string, to: string, label: string): string {
  const parsed = JSON.parse(content) as { version?: unknown };
  if (parsed.version !== from) {
    throw new Error(`version-bump: ${label} top-level version is "${String(parsed.version)}", expected "${from}"`);
  }
  parsed.version = to;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function bumpRequiredLockPackageVersion(parsed: JsonRecord, packageKey: string, from: string, to: string, label: string): void {
  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(`version-bump: ${label} has no object "packages" field`);
  }
  const entry = packages[packageKey];
  if (!isRecord(entry)) {
    throw new Error(`version-bump: ${label} has no object packages[${JSON.stringify(packageKey)}] entry`);
  }
  if (entry.version !== from) {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] version is "${String(entry.version)}", expected "${from}"`);
  }
  entry.version = to;
}

function bumpOptionalLockPackageVersion(parsed: JsonRecord, packageKey: string, from: string, to: string, label: string): void {
  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(`version-bump: ${label} has no object "packages" field`);
  }
  const entry = packages[packageKey];
  if (entry === undefined) return;
  if (!isRecord(entry)) {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] is not an object`);
  }
  if (entry.version === undefined) return;
  if (entry.version !== from) {
    throw new Error(`version-bump: ${label} packages[${JSON.stringify(packageKey)}] version is "${String(entry.version)}", expected "${from}"`);
  }
  entry.version = to;
}

/** Return a package-lock.json content string with top-level and package-entry versions set to `to`. */
function bumpPackageLockVersionContent(content: string, from: string, to: string, label: string, optionalPackageKeys: string[] = []): string {
  const parsed = JSON.parse(content) as JsonRecord;
  if (parsed.version !== from) {
    throw new Error(`version-bump: ${label} top-level version is "${String(parsed.version)}", expected "${from}"`);
  }
  parsed.version = to;
  bumpRequiredLockPackageVersion(parsed, '', from, to, label);
  for (const key of optionalPackageKeys) {
    bumpOptionalLockPackageVersion(parsed, key, from, to, label);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Locate THE single real exported PROOF_OR_STOP_CLI_VERSION. Matches against the comment-stripped
 * code (so a commented-out export — line or block — never matches), requires exactly one
 * match in that code, and refuses if the raw file has a different match count (i.e. an
 * export-shaped line also lives in a comment). Never a false success on a non-export.
 */
function findBrandExport(content: string, label: string): { version: string; raw: RegExpMatchArray } {
  const codeMatches = [...stripComments(content).matchAll(BRAND_EXPORT_RE)];
  if (codeMatches.length === 0) throw new Error(`version-bump: ${label} has no exported PROOF_OR_STOP_CLI_VERSION constant`);
  if (codeMatches.length > 1) throw new Error(`version-bump: ${label} has ${codeMatches.length} exported PROOF_OR_STOP_CLI_VERSION declarations (ambiguous; refusing to bump)`);
  const rawMatches = [...content.matchAll(BRAND_EXPORT_RE)];
  if (rawMatches.length !== 1) {
    throw new Error(`version-bump: ${label} has a PROOF_OR_STOP_CLI_VERSION export-shaped line in a comment as well as the real export (ambiguous; refusing to bump)`);
  }
  return { version: rawMatches[0][1], raw: rawMatches[0] };
}

function readBrandVersion(absPath: string): string {
  return findBrandExport(readFileSync(absPath, 'utf-8'), absPath).version;
}

/** Return a brand-file content string with the single real exported PROOF_OR_STOP_CLI_VERSION set to `to`. */
function bumpBrandContent(content: string, from: string, to: string): string {
  const { version, raw } = findBrandExport(content, 'proof-or-stop-brand.ts');
  if (version !== from) throw new Error(`version-bump: brand version "${version}" != expected "${from}"`);
  const replaced = raw[0].replace(`'${from}'`, `'${to}'`);
  const at = raw.index ?? content.indexOf(raw[0]);
  return content.slice(0, at) + replaced + content.slice(at + raw[0].length);
}

/**
 * Read the version from all sync points and assert they are identical.
 * Throws a drift error naming each value if they disagree — the DONE merge then
 * surfaces it as a loud failure instead of silently bumping an inconsistent set.
 */
export function readSyncedVersion(root: string): string {
  assertRootPackageIdentity(root);
  const versions = [
    { label: 'root', version: readJsonVersion(join(root, VERSION_SYNC_FILES.rootPackageJson)) },
    ...readPackageLockVersions(join(root, VERSION_SYNC_FILES.rootPackageLock), 'root lockfile', ['packages/main']),
    { label: 'packages/main', version: readJsonVersion(join(root, VERSION_SYNC_FILES.mainPackageJson)) },
    ...readPackageLockVersions(join(root, VERSION_SYNC_FILES.mainPackageLock), 'packages/main lockfile'),
    { label: 'proof-or-stop-brand', version: readBrandVersion(join(root, VERSION_SYNC_FILES.brand)) },
  ];
  const [first] = versions;
  if (versions.some((entry) => entry.version !== first.version)) {
    throw new Error(
      `version-bump: the version sync points are out of sync ` +
      `(${versions.map((entry) => `${entry.label}=${entry.version}`).join(', ')}); ` +
      `refusing to bump. Reconcile all version sources to the same X.Y.Z first.`,
    );
  }
  parseSemver(first.version); // catch a synced-but-malformed value early
  return first.version;
}

export interface PatchBumpResult {
  from: string;
  to: string;
  files: readonly string[];
}

/**
 * Test-only injection points (no production caller passes them). `afterWriteForTest` runs
 * after the three files are written but BEFORE the post-write verification, so a test can
 * corrupt the on-disk state to exercise the verify-failure rollback path.
 */
export interface ApplyPatchBumpTestHooks {
  afterWriteForTest?: () => void;
}

/**
 * Patch-bump all sync points in `root`. Pure filesystem (no git), so it is
 * hermetically testable against a temp fixture dir. Computes every replacement in memory
 * first (structural JSON for package.json/package-lock.json files, anchored single-match
 * regex for the brand) so any ambiguity/missing target throws BEFORE any write; then
 * writes all files and re-reads to verify. On ANY write failure OR a failed post-write
 * verification it rolls every file back to `from`, so sync points are never left drifted.
 */
export function applyPatchBump(root: string, opts?: ApplyPatchBumpTestHooks): PatchBumpResult {
  const from = readSyncedVersion(root);
  const to = nextPatch(from);

  const rootPkgPath = join(root, VERSION_SYNC_FILES.rootPackageJson);
  const rootLockPath = join(root, VERSION_SYNC_FILES.rootPackageLock);
  const mainPkgPath = join(root, VERSION_SYNC_FILES.mainPackageJson);
  const mainLockPath = join(root, VERSION_SYNC_FILES.mainPackageLock);
  const brandPath = join(root, VERSION_SYNC_FILES.brand);

  // Compute all three new contents in memory first; a structural problem throws here,
  // before a single byte is written.
  const plan = [
    { path: rootPkgPath, next: bumpJsonVersionContent(readFileSync(rootPkgPath, 'utf-8'), from, to, 'root package.json') },
    { path: rootLockPath, next: bumpPackageLockVersionContent(readFileSync(rootLockPath, 'utf-8'), from, to, 'root package-lock.json', ['packages/main']) },
    { path: mainPkgPath, next: bumpJsonVersionContent(readFileSync(mainPkgPath, 'utf-8'), from, to, 'packages/main package.json') },
    { path: mainLockPath, next: bumpPackageLockVersionContent(readFileSync(mainLockPath, 'utf-8'), from, to, 'packages/main package-lock.json') },
    { path: brandPath, next: bumpBrandContent(readFileSync(brandPath, 'utf-8'), from, to) },
  ];

  const originals = plan.map((p) => ({ path: p.path, content: readFileSync(p.path, 'utf-8') }));
  const rollback = (): void => {
    for (const o of originals) {
      try { writeFileSync(o.path, o.content); } catch { /* best-effort rollback */ }
    }
  };

  try {
    for (const p of plan) writeFileSync(p.path, p.next);
  } catch (e: any) {
    rollback();
    throw new Error(`version-bump: write failed and was rolled back to ${from}: ${e?.message ?? e}`);
  }

  opts?.afterWriteForTest?.(); // test seam: corrupt the post-write state to exercise verify rollback

  // Verify inside try/catch: a THROW here (e.g. transient read error) must also roll back,
  // not just the wrong-value case — otherwise the files sit bumped-but-unverified.
  let after: string;
  try {
    after = readSyncedVersion(root);
  } catch (e: any) {
    rollback();
    throw new Error(`version-bump: could not verify the write; rolled back to ${from}: ${e?.message ?? e}`);
  }
  if (after !== to) {
    rollback();
    throw new Error(`version-bump: post-write verification failed (expected ${to}, read ${after}); rolled back to ${from}`);
  }
  return { from, to, files: VERSION_SYNC_PATHS };
}

export type BumpGitRunner = (args: string[], cwd: string) => string;

export interface BumpOnDoneMergeOptions {
  /** The main checkout root where the bump commit lands. */
  mainMergeRoot: string;
  /** True only when the DONE merge changed watched CLI/runtime or capability contract inputs. */
  shouldBump: boolean;
  /**
   * Optional version read from main before the DONE merge. When the story branch already
   * carries exactly nextPatch(preMergeVersion), the finalizer must not bump twice.
   */
  preMergeVersion?: string;
  /** Git runner (done-effects passes its runGitArgs; tests inject a spy). */
  runGit: BumpGitRunner;
}

/** Report line when a merge does not qualify for a version bump. */
export const VERSION_BUMP_SKIPPED_LINE = '✓ version bump skipped (no watched CLI/runtime or capability contract inputs changed)';

/**
 * DONE post-merge effect: patch-bump the three sync points and commit the bump on main,
 * but only when the merge changed watched CLI/runtime or capability contract inputs. Returns the human-readable
 * report line that done-effects pushes into the merge log. Throws a loud, actionable error
 * on failure (matching runDoneMainPackageBuildAfterMerge's style) — never leaves the
 * version files written-but-uncommitted silently.
 */
export function bumpVersionOnDoneMerge(opts: BumpOnDoneMergeOptions): string {
  if (!opts.shouldBump) return VERSION_BUMP_SKIPPED_LINE;

  if (opts.preMergeVersion) {
    const expectedPreBump = nextPatch(opts.preMergeVersion);
    const current = readSyncedVersion(opts.mainMergeRoot);
    if (current === expectedPreBump) {
      return `✓ version bump already present ${opts.preMergeVersion} → ${current} across ${VERSION_SYNC_PATHS.length} sync points after DONE merge`;
    }
  }

  let bump: PatchBumpResult;
  try {
    bump = applyPatchBump(opts.mainMergeRoot);
  } catch (e: any) {
    throw new Error(
      `DONE post-merge version bump failed before any commit: ${e?.message ?? e}\n` +
      `Recovery: reconcile the version sync points (${VERSION_SYNC_PATHS.join(', ')}) to the same X.Y.Z, then re-run the bump or bump manually.`,
    );
  }

  try {
    opts.runGit(['add', ...bump.files], opts.mainMergeRoot);
    opts.runGit(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', `chore: bump proof-or-stop cli to ${bump.to}`],
      opts.mainMergeRoot,
    );
  } catch (e: any) {
    throw new Error(
      `DONE post-merge version bump wrote ${bump.from} -> ${bump.to} but the commit failed: ${e?.message ?? e}\n` +
      `The version files are modified on main and NOT committed. Recovery:\n` +
      `  cd "${opts.mainMergeRoot}"\n` +
      `  git add ${bump.files.join(' ')}\n` +
      `  git commit -m "chore: bump proof-or-stop cli to ${bump.to}"`,
    );
  }

  return `✓ version auto-bumped ${bump.from} → ${bump.to} across ${bump.files.length} sync points after DONE merge`;
}
