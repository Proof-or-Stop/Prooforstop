/**
 * Auto patch-version bump on DONE merge to local main (B-aa8a).
 *
 * The CLI version lives in THREE sync points that rollout-check enforces identical:
 *   1. <root>/package.json                              "version"
 *   2. <root>/packages/main/package.json                "version"
 *   3. <root>/packages/main/src/core/lattice-brand.ts   LATTICE_CLI_VERSION = '...'
 *
 * This module is PURE (no git, no done-effects import — avoids a circular dependency;
 * done-effects passes in the `shouldBump` decision and a `runGit` runner). It reads all
 * three, asserts they are in sync, and patch-bumps them atomically, failing loud on any
 * drift rather than silently picking one. done-effects.ts calls bumpVersionOnDoneMerge
 * after the DONE merge and before the dist rebuild, so the rebuilt dist reports the new
 * version with no extra build step.
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
/** Matches the LATTICE_CLI_VERSION literal in lattice-brand.ts. */
const BRAND_VERSION_RE = /LATTICE_CLI_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/;

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

export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Patch-only increment: 0.3.9 -> 0.3.10. Major/minor are never touched. */
export function nextPatch(version: string): string {
  const v = parseSemver(version);
  return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
}

function readJsonVersion(absPath: string): string {
  const raw = readFileSync(absPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`version-bump: ${absPath} has no string "version" field`);
  }
  return parsed.version;
}

function readBrandVersion(absPath: string): string {
  const raw = readFileSync(absPath, 'utf-8');
  const m = BRAND_VERSION_RE.exec(raw);
  if (!m) throw new Error(`version-bump: ${absPath} has no LATTICE_CLI_VERSION = '...' literal`);
  return m[1];
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
  // Validate it parses (catches a synced-but-malformed value early).
  parseSemver(rootV);
  return rootV;
}

function replaceOnce(content: string, needle: string, replacement: string, label: string): string {
  const idx = content.indexOf(needle);
  if (idx === -1) throw new Error(`version-bump: could not find ${label} to replace ("${needle}")`);
  return content.slice(0, idx) + replacement + content.slice(idx + needle.length);
}

export interface PatchBumpResult {
  from: string;
  to: string;
  files: readonly string[];
}

/**
 * Patch-bump all three sync points in `root`. Pure filesystem (no git), so it is
 * hermetically testable against a temp fixture dir. Reads the in-sync current version,
 * computes the next patch, rewrites each file with a single targeted substitution
 * (preserving surrounding formatting), then re-reads to verify all three landed on the
 * same new version. Throws on drift or a missing substitution target.
 */
export function applyPatchBump(root: string): PatchBumpResult {
  const from = readSyncedVersion(root);
  const to = nextPatch(from);

  const rootPkgPath = join(root, VERSION_SYNC_FILES.rootPackageJson);
  const mainPkgPath = join(root, VERSION_SYNC_FILES.mainPackageJson);
  const brandPath = join(root, VERSION_SYNC_FILES.brand);

  // Compute ALL three replacements in memory first, so a missing substitution target
  // throws BEFORE any file is touched (no partial write from a bad-content failure).
  const plan = [
    { path: rootPkgPath, next: replaceOnce(readFileSync(rootPkgPath, 'utf-8'), `"version": "${from}"`, `"version": "${to}"`, 'root package.json version') },
    { path: mainPkgPath, next: replaceOnce(readFileSync(mainPkgPath, 'utf-8'), `"version": "${from}"`, `"version": "${to}"`, 'packages/main package.json version') },
    { path: brandPath, next: replaceOnce(readFileSync(brandPath, 'utf-8'), `LATTICE_CLI_VERSION = '${from}'`, `LATTICE_CLI_VERSION = '${to}'`, 'lattice-brand LATTICE_CLI_VERSION') },
  ];

  // Snapshot originals so a mid-write filesystem failure (e.g. a read-only file) rolls
  // back instead of leaving the 3 sync points drifted (preMortem #1: never corrupt).
  const originals = plan.map((p) => ({ path: p.path, content: readFileSync(p.path, 'utf-8') }));
  try {
    for (const p of plan) writeFileSync(p.path, p.next);
  } catch (e: any) {
    for (const o of originals) {
      try { writeFileSync(o.path, o.content); } catch { /* best-effort rollback */ }
    }
    throw new Error(`version-bump: write failed and was rolled back to ${from}: ${e?.message ?? e}`);
  }

  const after = readSyncedVersion(root);
  if (after !== to) {
    throw new Error(`version-bump: post-write verification failed (expected ${to}, read ${after})`);
  }
  return { from, to, files: VERSION_SYNC_PATHS };
}

export type GitRunner = (args: string[], cwd: string) => string;

export interface BumpOnDoneMergeOptions {
  /** The main checkout root where the bump commit lands. */
  mainMergeRoot: string;
  /** True only when the DONE merge changed material code (done-effects computes this). */
  shouldBump: boolean;
  /** Git runner (done-effects passes its runGitArgs; tests inject a spy). */
  runGit: GitRunner;
}

/** Report line when a merge does not qualify for a version bump. */
export const VERSION_BUMP_SKIPPED_LINE = '✓ version bump skipped (no material code change)';

/**
 * DONE post-merge effect: patch-bump the three sync points and commit the bump on main,
 * but only when the merge changed material code. Returns the human-readable report line
 * that done-effects pushes into the merge log. Throws a loud, actionable error on failure
 * (matching runDoneMainPackageBuildAfterMerge's style) — never leaves the version files
 * written-but-uncommitted silently.
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
