/**
 * Auto patch-version bump on DONE merge to local main (B-aa8a).
 *
 * The CLI version lives in THREE sync points that rollout-check enforces identical:
 *   1. <root>/package.json                              "version"
 *   2. <root>/packages/main/package.json                "version"
 *   3. <root>/packages/main/src/core/lattice-brand.ts   export const LATTICE_CLI_VERSION
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
  mainPackageJson: 'packages/main/package.json',
  brand: 'packages/main/src/core/lattice-brand.ts',
} as const;

/** Ordered list of the three relative sync-point paths (for `git add`). */
export const VERSION_SYNC_PATHS: readonly string[] = [
  VERSION_SYNC_FILES.rootPackageJson,
  VERSION_SYNC_FILES.mainPackageJson,
  VERSION_SYNC_FILES.brand,
];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
/**
 * Matches an EXPORTED LATTICE_CLI_VERSION declaration in lattice-brand.ts. Anchored to the
 * start of a line (`^[ \t]*` under `/m`) followed by `export const`, and applied to a
 * COMMENT-STRIPPED view of the file (see stripComments), so neither a `// ...` line comment,
 * a commented-out `// export const ...` line, nor a `/* ... *​/` block-commented export can
 * be mistaken for the real constant. Global so callers can count occurrences.
 */
const BRAND_EXPORT_RE = /^[ \t]*export\s+const\s+LATTICE_CLI_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/gm;

/**
 * Remove `/* *​/` block comments and `//` line comments. Pragmatic for the controlled
 * lattice-brand.ts (no comment markers live inside its string literals) — NOT a full TS
 * parser; findBrandExport adds a raw-vs-stripped count guard to refuse any file where an
 * export-shaped LATTICE_CLI_VERSION line also appears in a comment.
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

/** Read the structural top-level `version` from a package.json. */
function readJsonVersion(absPath: string): string {
  const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`version-bump: ${absPath} has no string top-level "version" field`);
  }
  return parsed.version;
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

/**
 * Locate THE single real exported LATTICE_CLI_VERSION. Matches against the comment-stripped
 * code (so a commented-out export — line or block — never matches), requires exactly one
 * match in that code, and refuses if the raw file has a different match count (i.e. an
 * export-shaped line also lives in a comment). Never a false success on a non-export.
 */
function findBrandExport(content: string, label: string): { version: string; raw: RegExpMatchArray } {
  const codeMatches = [...stripComments(content).matchAll(BRAND_EXPORT_RE)];
  if (codeMatches.length === 0) throw new Error(`version-bump: ${label} has no exported LATTICE_CLI_VERSION constant`);
  if (codeMatches.length > 1) throw new Error(`version-bump: ${label} has ${codeMatches.length} exported LATTICE_CLI_VERSION declarations (ambiguous; refusing to bump)`);
  const rawMatches = [...content.matchAll(BRAND_EXPORT_RE)];
  if (rawMatches.length !== 1) {
    throw new Error(`version-bump: ${label} has a LATTICE_CLI_VERSION export-shaped line in a comment as well as the real export (ambiguous; refusing to bump)`);
  }
  return { version: rawMatches[0][1], raw: rawMatches[0] };
}

function readBrandVersion(absPath: string): string {
  return findBrandExport(readFileSync(absPath, 'utf-8'), absPath).version;
}

/** Return a brand-file content string with the single real exported LATTICE_CLI_VERSION set to `to`. */
function bumpBrandContent(content: string, from: string, to: string): string {
  const { version, raw } = findBrandExport(content, 'lattice-brand.ts');
  if (version !== from) throw new Error(`version-bump: brand version "${version}" != expected "${from}"`);
  const replaced = raw[0].replace(`'${from}'`, `'${to}'`);
  const at = raw.index ?? content.indexOf(raw[0]);
  return content.slice(0, at) + replaced + content.slice(at + raw[0].length);
}

/**
 * Read the version from all three sync points and assert they are identical.
 * Throws a drift error naming each value if they disagree — the DONE merge then
 * surfaces it as a loud failure instead of silently bumping an inconsistent set.
 */
export function readSyncedVersion(root: string): string {
  const rootV = readJsonVersion(join(root, VERSION_SYNC_FILES.rootPackageJson));
  const mainV = readJsonVersion(join(root, VERSION_SYNC_FILES.mainPackageJson));
  const brandV = readBrandVersion(join(root, VERSION_SYNC_FILES.brand));
  if (rootV !== mainV || rootV !== brandV) {
    throw new Error(
      `version-bump: the 3 version sync points are out of sync ` +
      `(root=${rootV}, packages/main=${mainV}, lattice-brand=${brandV}); ` +
      `refusing to bump. Reconcile all three to the same X.Y.Z first.`,
    );
  }
  parseSemver(rootV); // catch a synced-but-malformed value early
  return rootV;
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
 * Patch-bump all three sync points in `root`. Pure filesystem (no git), so it is
 * hermetically testable against a temp fixture dir. Computes every replacement in memory
 * first (structural JSON for the two package.json, anchored single-match regex for the
 * brand) so any ambiguity/missing target throws BEFORE any write; then writes all three
 * and re-reads to verify. On ANY write failure OR a failed post-write verification it
 * rolls every file back to `from`, so the three points are never left drifted.
 */
export function applyPatchBump(root: string, opts?: ApplyPatchBumpTestHooks): PatchBumpResult {
  const from = readSyncedVersion(root);
  const to = nextPatch(from);

  const rootPkgPath = join(root, VERSION_SYNC_FILES.rootPackageJson);
  const mainPkgPath = join(root, VERSION_SYNC_FILES.mainPackageJson);
  const brandPath = join(root, VERSION_SYNC_FILES.brand);

  // Compute all three new contents in memory first; a structural problem throws here,
  // before a single byte is written.
  const plan = [
    { path: rootPkgPath, next: bumpJsonVersionContent(readFileSync(rootPkgPath, 'utf-8'), from, to, 'root package.json') },
    { path: mainPkgPath, next: bumpJsonVersionContent(readFileSync(mainPkgPath, 'utf-8'), from, to, 'packages/main package.json') },
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
  /** True only when the DONE merge changed watched CLI/runtime inputs. */
  shouldBump: boolean;
  /** Git runner (done-effects passes its runGitArgs; tests inject a spy). */
  runGit: BumpGitRunner;
}

/** Report line when a merge does not qualify for a version bump. */
export const VERSION_BUMP_SKIPPED_LINE = '✓ version bump skipped (no watched CLI/runtime inputs changed)';

/**
 * DONE post-merge effect: patch-bump the three sync points and commit the bump on main,
 * but only when the merge changed watched CLI/runtime inputs. Returns the human-readable
 * report line that done-effects pushes into the merge log. Throws a loud, actionable error
 * on failure (matching runDoneMainPackageBuildAfterMerge's style) — never leaves the
 * version files written-but-uncommitted silently.
 */
export function bumpVersionOnDoneMerge(opts: BumpOnDoneMergeOptions): string {
  if (!opts.shouldBump) return VERSION_BUMP_SKIPPED_LINE;

  let bump: PatchBumpResult;
  try {
    bump = applyPatchBump(opts.mainMergeRoot);
  } catch (e: any) {
    throw new Error(
      `DONE post-merge version bump failed before any commit: ${e?.message ?? e}\n` +
      `Recovery: reconcile the 3 version sync points (${VERSION_SYNC_PATHS.join(', ')}) to the same X.Y.Z, then re-run the bump or bump manually.`,
    );
  }

  try {
    opts.runGit(['add', ...bump.files], opts.mainMergeRoot);
    opts.runGit(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', `chore: bump lattice cli to ${bump.to}`],
      opts.mainMergeRoot,
    );
  } catch (e: any) {
    throw new Error(
      `DONE post-merge version bump wrote ${bump.from} -> ${bump.to} but the commit failed: ${e?.message ?? e}\n` +
      `The version files are modified on main and NOT committed. Recovery:\n` +
      `  cd "${opts.mainMergeRoot}"\n` +
      `  git add ${bump.files.join(' ')}\n` +
      `  git commit -m "chore: bump lattice cli to ${bump.to}"`,
    );
  }

  return `✓ version auto-bumped ${bump.from} → ${bump.to} across 3 sync points after DONE merge`;
}
