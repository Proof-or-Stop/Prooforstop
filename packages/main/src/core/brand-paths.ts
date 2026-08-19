/**
 * brand-paths.ts — the single read-both resolver for brand-named ON-DISK paths
 * (B-cc10 CHK-002).
 *
 * WHY THIS EXISTS
 * ---------------
 * B-cdf6 renamed the user-facing CLI surface but deliberately froze the
 * STRUCTURAL brand identities: the state directory (`.lattice/`), the Codex
 * adapter directory (`.lattice-codex/`), the project config filename
 * (`lattice.config.json`) and the adapter manifest filename (`lattice.json`).
 * B-cc10 unfreezes them. This module is the ONE place that decides, for each of
 * those four identities, which spelling is canonical and which is still read.
 *
 * The contract mirrors the one `core/brand-env.ts` already proved for env vars:
 *
 *   - the CANONICAL name wins whenever both spellings are present on disk;
 *   - the DEPRECATED name still RESOLVES for READS, so a checkout that has not
 *     been migrated keeps working;
 *   - only the CANONICAL name is ever WRITTEN.
 *
 * WHY ONE RESOLVER AND NOT ~200 OPEN-CODED LITERALS
 * ------------------------------------------------
 * This is not stylistic. `core/evidence-freshness.ts`'s `isStoryMetadataPath`
 * excludes story metadata from `storyFilesHash`, and its prefix list is DERIVED
 * from {@link PROOF_OR_STOP_STATE_DIR} via `PROOF_OR_STOP_STORY_DIR`. Measured
 * against the pre-migration build:
 *
 *     isStoryMetadataPath('.lattice/story/actives/B-cdf6/index.json')       -> true
 *     isStoryMetadataPath('.proof-or-stop/story/actives/B-cdf6/index.json') -> false
 *
 * So if the on-disk directory is renamed while that constant keeps the old
 * spelling, 344 archived story directories silently flip from EXCLUDED to
 * INCLUDED in `storyFilesHash`. Nothing throws; the hashes just quietly change
 * meaning, which is the worst possible failure mode for an evidence digest.
 * Making the state-dir name flow from exactly one constant is what makes
 * `isStoryMetadataPath` follow the rename automatically instead of being a
 * second place someone has to remember to edit.
 *
 * See `docs/requirements/decisions/proof-or-stop-identity-migration.md`, section
 * "storyFilesHash: the state-dir rename is a CHK-002 correctness requirement".
 *
 * THE B-cdf6 REGRESSION CLASS THIS MODULE IS SHAPED TO PREVENT
 * -----------------------------------------------------------
 * B-cdf6 shipped four regressions where a hardcoded DEPRECATED literal sat
 * inside a COMPARISON or PARSER rather than inside an output string, so the
 * CANONICAL spelling silently failed while the old one kept working — backwards
 * from the intent (F-065/F-061 denylist + allow/deny membership in
 * `core/lattice-dispatch.ts`, F-062 a regex in
 * `core/done-required-timeout-budget.ts`, F-068 entrypoint inference in
 * `cli/activity-policy.ts`). All four were found by reviewers, none by the
 * implementer.
 *
 * The defence here is that every DECISION helper below — membership tests,
 * prefix tests, filename recognition — accepts BOTH spellings by construction,
 * because it derives its accepted set from the same pair of constants that the
 * writers use. A caller cannot recognize only one spelling without bypassing
 * this module entirely.
 */

/* ------------------------------------------------------------------ *
 * State directory (`.lattice/` -> `.proof-or-stop/`)
 * ------------------------------------------------------------------ */

/**
 * Canonical state-directory name. Everything written goes here.
 *
 * CHANGING THIS VALUE IS THE MIGRATION. Because `PROOF_OR_STOP_STORY_DIR` and
 * therefore `isStoryMetadataPath`'s prefix list derive from it, flipping this
 * constant moves the `storyFilesHash` metadata exclusion with the directory in
 * the same edit. Do not reintroduce the directory name anywhere else.
 */
export const PROOF_OR_STOP_STATE_DIR = '.proof-or-stop';

/**
 * Deprecated state-directory name, still READ so a pre-migration checkout keeps
 * resolving. Never written.
 */
export const DEPRECATED_STATE_DIR = '.lattice';

/* ------------------------------------------------------------------ *
 * Codex adapter directory (`.lattice-codex/` -> `.proof-or-stop-codex/`)
 * ------------------------------------------------------------------ */

/** Canonical Codex adapter directory name. Everything written goes here. */
export const PROOF_OR_STOP_ADAPTER_DIR = '.proof-or-stop-codex';

/** Deprecated Codex adapter directory name, still READ. Never written. */
export const DEPRECATED_ADAPTER_DIR = '.lattice-codex';

/* ------------------------------------------------------------------ *
 * Project config filename (`lattice.config.json` -> `proof-or-stop.config.json`)
 * ------------------------------------------------------------------ */

/**
 * Canonical project config filename. Only this name is written.
 *
 * B-cc10 CHK-004 flipped this from `lattice.config.json`. The deprecated
 * spelling below still RESOLVES for reads, so an unmigrated checkout keeps
 * loading — it just gets a one-line stderr deprecation notice.
 */
export const PROOF_OR_STOP_CONFIG_FILENAME = 'proof-or-stop.config.json';

/** Deprecated project config filename, still READ. Never written. */
export const DEPRECATED_CONFIG_FILENAME = 'lattice.config.json';

/* ------------------------------------------------------------------ *
 * Adapter manifest filename (`lattice.json` -> `proof-or-stop.json`)
 * ------------------------------------------------------------------ */

/**
 * Canonical adapter manifest filename. Only this name is written.
 *
 * B-cc10 CHK-004 flipped this from `lattice.json`. The adapter DIRECTORY is a
 * separate identity that CHK-003 moves; this constant governs only the filename,
 * and `adapterManifestCandidates()` probes the dir x filename cross product so a
 * half-migrated checkout resolves either way.
 */
export const PROOF_OR_STOP_MANIFEST_FILENAME = 'proof-or-stop.json';

/** Deprecated adapter manifest filename, still READ. Never written. */
export const DEPRECATED_MANIFEST_FILENAME = 'lattice.json';

/* ------------------------------------------------------------------ *
 * Read-both candidate lists — canonical FIRST in every one.
 * ------------------------------------------------------------------ */

/**
 * Deduplicate while preserving order, so a candidate list stays a single entry
 * for as long as canonical and deprecated spellings are still equal (i.e.
 * before the rename lands) and becomes a genuine two-entry read-both list
 * afterwards, with no call-site change.
 */
function ordered(...names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Accepted state-directory names, canonical first. */
export const STATE_DIR_NAMES: readonly string[] = ordered(
  PROOF_OR_STOP_STATE_DIR,
  DEPRECATED_STATE_DIR,
);

/** Accepted Codex adapter directory names, canonical first. */
export const ADAPTER_DIR_NAMES: readonly string[] = ordered(
  PROOF_OR_STOP_ADAPTER_DIR,
  DEPRECATED_ADAPTER_DIR,
);

/** Accepted project config filenames, canonical first. */
export const CONFIG_FILENAMES: readonly string[] = ordered(
  PROOF_OR_STOP_CONFIG_FILENAME,
  DEPRECATED_CONFIG_FILENAME,
);

/** Accepted adapter manifest filenames, canonical first. */
export const MANIFEST_FILENAMES: readonly string[] = ordered(
  PROOF_OR_STOP_MANIFEST_FILENAME,
  DEPRECATED_MANIFEST_FILENAME,
);

/* ------------------------------------------------------------------ *
 * Decision helpers.
 *
 * These exist so a caller that needs to TEST a path never has to write a brand
 * literal itself — the F-065/F-061/F-062/F-068 shape. Each derives its accepted
 * set from the constants above, so both spellings are recognized by
 * construction.
 * ------------------------------------------------------------------ */

/** Normalize a relative path for comparison: `\` -> `/`, strip `./` and edge slashes. */
function normalizeForCompare(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** First path segment of a relative path, or `''`. */
function firstSegment(path: string): string {
  const normalized = normalizeForCompare(path);
  if (!normalized) return '';
  const slash = normalized.indexOf('/');
  return slash === -1 ? normalized : normalized.slice(0, slash);
}

/**
 * True when `path` sits in the state directory under EITHER spelling.
 *
 * Matches the directory itself as well as anything beneath it, so it is safe to
 * use both as an ignore-list membership test and as a prefix test.
 */
export function isStateDirPath(path: string): boolean {
  return STATE_DIR_NAMES.includes(firstSegment(path));
}

/** True when `path` sits in the Codex adapter directory under EITHER spelling. */
export function isAdapterDirPath(path: string): boolean {
  return ADAPTER_DIR_NAMES.includes(firstSegment(path));
}

/** True when `name` is a project config filename under EITHER spelling. */
export function isConfigFilename(name: string): boolean {
  return CONFIG_FILENAMES.includes(normalizeForCompare(name));
}

/** True when `name` is an adapter manifest filename under EITHER spelling. */
export function isManifestFilename(name: string): boolean {
  return MANIFEST_FILENAMES.includes(normalizeForCompare(name));
}

/**
 * Every accepted spelling of a path inside the state directory, canonical first.
 *
 * Callers that must probe the filesystem (`existsSync`) iterate this and take
 * the first hit, which is what implements canonical-wins for reads.
 */
export function stateDirCandidates(...segments: readonly string[]): readonly string[] {
  const tail = segments.filter(Boolean).join('/');
  return STATE_DIR_NAMES.map((dir) => (tail ? `${dir}/${tail}` : dir));
}

/** Every accepted spelling of a path inside the Codex adapter directory, canonical first. */
export function adapterDirCandidates(...segments: readonly string[]): readonly string[] {
  const tail = segments.filter(Boolean).join('/');
  return ADAPTER_DIR_NAMES.map((dir) => (tail ? `${dir}/${tail}` : dir));
}

/**
 * True when `text` mentions a project config filename under EITHER spelling.
 *
 * For callers that must classify a free-form diagnostic string (a blind-spot
 * message, a read failure) as being ABOUT the config file. Same F-065/F-061
 * defence as the other decision helpers: the accepted set derives from the
 * constants, so a caller cannot recognize only one spelling.
 */
export function isConfigFilenameMentioned(text: string): boolean {
  return CONFIG_FILENAMES.some((name) => text.includes(name));
}

/**
 * Pick which config-filename spelling to actually USE against a tree, by asking
 * a caller-supplied probe which one is present. Canonical wins; the deprecated
 * spelling is the fallback; when neither is present the CANONICAL name is
 * returned so error messages and digest keys name the spelling a project should
 * have.
 *
 * WHY A PROBE CALLBACK INSTEAD OF `existsSync`
 * -------------------------------------------
 * The B-cc10 CHK-004 caller that needs this most
 * (`core/acceptance-discovery-adapters.ts`) may not use `existsSync` at all: it
 * reads through a hardened no-follow snapshot reader that REJECTS a path whose
 * spelling differs from the canonical physical path on disk. So "which spelling
 * exists" has to be answered by the same reader that will do the real read, or
 * the answer does not bind to the read that follows. Taking a probe keeps this
 * module free of I/O (it stays a pure resolver) while still letting every caller
 * derive its accepted set from the same two constants.
 *
 * This is the F-065/F-061 shape done right: a caller cannot end up recognizing
 * only one spelling, because it never writes either literal itself.
 */
export function resolveConfigFilename(exists: (name: string) => boolean): string {
  for (const name of CONFIG_FILENAMES) {
    if (exists(name)) return name;
  }
  return PROOF_OR_STOP_CONFIG_FILENAME;
}

/**
 * Same read-both resolution for the adapter manifest filename. Canonical wins;
 * canonical is the both-absent fallback.
 */
export function resolveManifestFilename(exists: (name: string) => boolean): string {
  for (const name of MANIFEST_FILENAMES) {
    if (exists(name)) return name;
  }
  return PROOF_OR_STOP_MANIFEST_FILENAME;
}

/**
 * Accepted spellings of the adapter manifest inside the adapter directory,
 * canonical-dir + canonical-filename first.
 *
 * The cross product matters: a partially migrated checkout can legitimately
 * have a canonical directory holding a deprecated filename, or vice versa, and
 * a resolver that only probed the two "matched" pairs would miss both mixes.
 */
export function adapterManifestCandidates(): readonly string[] {
  const out: string[] = [];
  for (const dir of ADAPTER_DIR_NAMES) {
    for (const file of MANIFEST_FILENAMES) {
      const candidate = `${dir}/${file}`;
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}
