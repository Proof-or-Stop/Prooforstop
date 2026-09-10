#!/usr/bin/env node
/**
 * verify-proof-or-stop-residue.mjs — brand-residue acceptance gate (two independent checks).
 *
 * FILENAME IS FROZEN. `docs/requirements/decisions/brand-rename-mapping.md` classifies
 * this path as FROZEN because it has multiple live couplings, the load-bearing one being
 * `packages/main/src/handlers/review-preflight.ts` (hardcodes the relative path and
 * returns ok:false — FAILS CLOSED — when the file is absent). Also referenced by
 * `package.json` (`test:proof-or-stop-residue`), the CLAUDE.md gate table, and
 * `scripts/verify-residue-inject-repro.mjs`. Change this file's CONTENT, never its NAME.
 *
 * ---------------------------------------------------------------------------
 * CHECK 1 — koala residue (zero tolerance, allowlist-free). B-fbca ship-clean story 3.
 * ---------------------------------------------------------------------------
 *   Reproducible check that the product runtime source surface (packages/<pkg>/src)
 *   contains LITERAL ZERO un-rebranded "koala" / "Koala" residue. The koala→proofOrStop
 *   bulk rename drove these roots to zero, so the check is unconditional: ANY
 *   case-insensitive "koala" hit in SRC_SCAN_ROOTS is a FAIL. There is no exemption
 *   list for koala because there is nothing left to exempt. This guarantee must not
 *   regress, and B-cdf6 preserves it byte-for-byte.
 *
 * ---------------------------------------------------------------------------
 * CHECK 2 — un-renamed brand PROSE in active docs (B-cdf6). Exemption-based.
 * ---------------------------------------------------------------------------
 *   This detector checks bare retired CLI invocations in current documentation.
 *   It intentionally does not classify schema strings, paths, environment keys,
 *   or role identifiers. The independent identity-cutover verifier checks those
 *   surfaces with exact historical and negative-test provenance. Exclusion from
 *   this narrow invocation detector does not authorize an active compatibility
 *   alias or make an old artifact admissible to a current gate.
 *
 *   EXEMPT_PROSE_FILES holds the small set of active docs that legitimately quote a
 *   bare `proofOrStop <cmd>` string as their SUBJECT MATTER rather than as advice. Each
 *   entry carries a reason and is asserted to still exist and still contain a hit, so
 *   a stale exemption cannot silently widen the gate.
 *
 * ---------------------------------------------------------------------------
 * CHECK 4 — FORBIDDEN brand-path DECISION SITES in product runtime source (B-cc10
 * CHK-007). This is the row-flip from "exempt" to "forbidden".
 * ---------------------------------------------------------------------------
 *   B-cc10 unfroze four structural identities (state dir, adapter dir, project
 *   config filename, adapter manifest filename) and routed them through the single
 *   read-both resolver `packages/main/src/core/brand-paths.ts`. This check makes
 *   that migration non-regressable.
 *
 *   WHY THIS IS NOT A BARE `.proof-or-stop` SWEEP, WITH MEASURED NUMBERS
 *   -------------------------------------------------------------
 *   A blanket "any `.proof-or-stop` literal in packages/*\/src is forbidden" row was the
 *   obvious reading of the task, and it is wrong — it would fail closed on CORRECT
 *   code. Measured on this tree at implementation time: 1283 `.proof-or-stop` hits across
 *   272 files, 541 `proof-or-stop.config.json`, 90 `.proof-or-stop-codex`, 43 `@proof-or-stop/`.
 *   Sampling those shows they are overwhelmingly legitimate and MUST survive:
 *
 *     - the read-both constants themselves (`DEPRECATED_STATE_DIR = '.proof-or-stop'`,
 *       `DEPRECATED_CONFIG_FILENAME`, `DEPRECATED_ADAPTER_DIR`) — deleting these
 *       breaks reads on every unmigrated checkout, which is the whole contract;
 *     - user-facing DEPRECATION NOTICES that must name the old spelling to be
 *       actionable ("proof-or-stop.config.json is deprecated; rename it to ...");
 *     - read-both candidate LISTS that deliberately contain both spellings;
 *     - ~1062 hits inside `packages/main/src/tasks/**` fixtures, where the old
 *       spelling is frequently the SPECIMEN UNDER TEST (a migration fixture must be
 *       able to construct a legacy tree, or it cannot prove the migration works).
 *
 *   So the forbidden thing is not the literal's PRESENCE, it is the literal's USE
 *   AS A DECISION. That is the actual defect class B-cdf6 shipped four times
 *   (F-065/F-061/F-062/F-068, all documented at the top of `core/brand-paths.ts`):
 *   a DEPRECATED literal sitting inside a comparison / prefix test / membership
 *   check, so the CANONICAL spelling silently fails while the old one keeps
 *   working — backwards from the intent, and silent because nothing throws.
 *
 *   B-cc10 CHK-007 found three live instances of exactly that shape and fixed them
 *   by routing each through `isStateDirPath` (read-both by construction):
 *     - core/artifact-release.ts:68        `path.startsWith('.proof-or-stop/')`
 *     - core/semantic-scope-gate.ts:170    `hunk.path.startsWith('.proof-or-stop/')`
 *     - handlers/done-prepare.ts:1352      `lower.startsWith('.proof-or-stop/')`
 *   Each had stopped firing for canonical paths: the first could admit state-dir
 *   lifecycle metadata into an artifact release, the other two silently dropped a
 *   metadata/exemption classification.
 *
 *   HOW THIS CHECK AVOIDS ROTTING THE WAY THE THING IT GUARDS ROTTED
 *   ---------------------------------------------------------------
 *   The token list is DERIVED from `core/brand-paths.ts` by parsing the constants
 *   out of that file, not hardcoded here. A gate pinned to one spelling is the very
 *   defect these gates catch — it is what broke `brand-path-resolver-smoke`, whose
 *   flip regex hardcoded `.proof-or-stop` and failed closed on CHK-003's correct rename.
 *   Deriving means flipping a constant in the resolver moves this check with it.
 *   The resolver file is parsed rather than imported so this verifier keeps running
 *   standalone with no built `dist` (same constraint as EXECUTABLE_SCAN_ROOTS).
 *
 * Scope note:
 *   No check scans `.proof-or-stop/story/**` or `CHANGELOG.md` — both are FROZEN
 *   historical records per the mapping table. Checks 1 and 4 stay confined to
 *   product runtime source; check 2 to active-doc prose.
 *
 * Usage:
 *   node scripts/verify-proof-or-stop-residue.mjs            run both checks; exit 0 PASS / 1 with hit list
 *   node scripts/verify-proof-or-stop-residue.mjs --self-test run the inline detector unit tests
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');
const LEGACY_BIN = ['lat', 'tice'].join('');
const LEGACY_STATE_DIR = `.${LEGACY_BIN}`;
const LEGACY_ADAPTER_DIR = `${LEGACY_STATE_DIR}-codex`;
const LEGACY_CONFIG_FILENAME = `${LEGACY_BIN}.config.json`;
const LEGACY_MANIFEST_FILENAME = `${LEGACY_STATE_DIR}-manifest.json`;

// ---------------------------------------------------------------------------
// CHECK 1 detector: zero-tolerance, any case-insensitive "koala" is residue.
// ---------------------------------------------------------------------------

/**
 * Zero-tolerance koala-residue detector (B-fbca). Deliberately allowlist-free.
 * @param {string} line
 * @returns {boolean} true when the line contains koala brand residue
 */
export function isResidue(line) {
  return /koala/i.test(line);
}

// ---------------------------------------------------------------------------
// CHECK 2 detector: bare `proofOrStop <subcommand>` CLI invocation in active docs.
// ---------------------------------------------------------------------------

/**
 * Matches a bare CLI invocation of the OLD bin name.
 *
 * Anatomy, and why each part is load-bearing:
 *   (?<![A-Za-z0-9_./@-])  left fence. Rejects `.proof-or-stop/`, `bin/proofOrStop.js`,
 *                          `@proof-or-stop/core`, `PROOF_OR_STOP_`-style and `-proofOrStop`
 *                          compounds by refusing an identifier/path char before
 *                          the token. This is what keeps the 602 frozen-identifier
 *                          files from matching.
 *   [Ll]attice             the token itself; `Proof-or-Stop` catches prose like
 *                          "ProofOrStop validate".
 *   [ \t]+                 requires real whitespace. `proof-or-stop.config.json`,
 *                          `proof-or-stop-review-quality` and `PROOF_OR_STOP_X` all fail here.
 *   (?![A-Z])              rejects prose proper nouns such as "ProofOrStop CLI" /
 *                          "ProofOrStop Production Safety", which are brand-name prose
 *                          (a different mapping-table row) rather than an invocation.
 *   [a-z][a-z0-9_]*        a subcommand-shaped word: `validate`, `story_advance`.
 *
 * @param {string} line
 * @returns {boolean} true when the line instructs the reader to run the old bin
 */
export function isBrandProseResidue(line) {
  return /(?<![A-Za-z0-9_./@-])[Ll]attice[ \t]+(?![A-Z])[a-z][a-z0-9_]*/.test(line);
}

// ---------------------------------------------------------------------------
// CHECK 4 detector: a DEPRECATED brand literal used as a DECISION (B-cc10 CHK-007).
// ---------------------------------------------------------------------------

/** The resolver that owns every brand-path identity. Parsed, not imported (no dist). */
const BRAND_PATHS_REL = 'packages/main/src/core/brand-paths.ts';

/**
 * Read the DEPRECATED_* string literals out of `core/brand-paths.ts`.
 *
 * Derived rather than hardcoded so this gate cannot pin itself to one spelling —
 * see the CHECK 4 header. Fails LOUDLY (throws) rather than returning an empty set,
 * because an empty token list would make the check silently vacuous, which is the
 * "gate went quietly blind" regression shape B-cdf6 is full of.
 *
 * @returns {string[]} deprecated brand literals, longest first
 */
export function readDeprecatedBrandTokens() {
  const source = readTracked(BRAND_PATHS_REL);
  if (source === null) {
    throw new Error(
      `verify-proof-or-stop-residue: cannot read ${BRAND_PATHS_REL}; check 4 derives its token list from ` +
        'that resolver and refuses to run vacuously.',
    );
  }
  const tokens = [];
  for (const m of source.matchAll(/export const (DEPRECATED_[A-Z_]+)\s*=\s*'([^']+)'/g)) {
    tokens.push(m[2]);
  }
  if (tokens.length === 0) {
    // The identity cutover deliberately removed the read-both constants from
    // the active resolver. Keep this older gate non-vacuous after that point:
    // derive the exact retired structural names from the already split legacy
    // bin token, without reintroducing an active literal that the cutover gate
    // must (correctly) reject.
    tokens.push(
      `.${LEGACY_BIN}-codex`,
      `${LEGACY_BIN}.config.json`,
      `.${LEGACY_BIN}-manifest.json`,
      `.${LEGACY_BIN}`,
    );
  }
  // Longest first so `.proof-or-stop-codex` is tried before `.proof-or-stop`.
  return tokens.sort((a, b) => b.length - a.length);
}

/**
 * Build the check-4 detector for a given token set.
 *
 * A DECISION SITE is a deprecated literal that appears as the argument of a path
 * comparison, or on either side of `===` / `!==`:
 *
 *     path.startsWith('.proof-or-stop/')        <- forbidden
 *     name === 'proof-or-stop.config.json'      <- forbidden
 *     const DEPRECATED_STATE_DIR = '.proof-or-stop'   <- ALLOWED (a declaration)
 *     'proof-or-stop.config.json is deprecated'       <- ALLOWED (a notice)
 *
 * Only the comparison shape is reported, because that is the shape that silently
 * inverts behaviour. Presence alone is legitimate (see the CHECK 4 header).
 *
 * @param {string[]} tokens deprecated brand literals
 * @returns {(line: string) => boolean}
 */
export function makeBrandDecisionDetector(tokens) {
  const alt = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // A quoted literal that STARTS with a deprecated token (optionally continuing
  // into a longer path), used as a comparison argument or an (in)equality operand.
  const quoted = `['"\`](?:${alt})(?:/[^'"\`]*)?['"\`]`;
  const patterns = [
    // .startsWith('.proof-or-stop/') / .includes(...) / .endsWith(...) / .indexOf(...)
    new RegExp(`\\.(?:startsWith|endsWith|includes|indexOf)\\s*\\(\\s*${quoted}`),
    // x === '.proof-or-stop' / x !== 'proof-or-stop.config.json'
    new RegExp(`(?:===|!==)\\s*${quoted}`),
    // '.proof-or-stop' === x
    new RegExp(`${quoted}\\s*(?:===|!==)`),
  ];
  return (line) => {
    // A COMMENT is not a decision. This is load-bearing, not a convenience: the
    // correct fix for a forbidden decision site is to route it through the resolver
    // AND record what the old code was, so the comment necessarily quotes the very
    // shape being forbidden. Without this the gate would flag its own remediation
    // and make the documented fix impossible — first observed on CHK-007's own fix
    // to artifact-release.ts / done-prepare.ts. Only leading-comment lines are
    // skipped, so a trailing `// ...` cannot be used to hide real code.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return false;
    }
    return patterns.some((re) => re.test(line));
  };
}

/** Live detector, bound to the tokens the resolver currently declares. */
const DEPRECATED_BRAND_TOKENS = readDeprecatedBrandTokens();
export const isBrandDecisionResidue = makeBrandDecisionDetector(DEPRECATED_BRAND_TOKENS);

// ---------------------------------------------------------------------------
// Active scope definitions.
// ---------------------------------------------------------------------------

/** Product runtime source — the koala zero-tolerance surface (check 1). */
const SRC_SCAN_ROOTS = ['packages/main/src', 'packages/lab/src', 'packages/utils/src', 'packages/graph/src'];

/**
 * The npm package may keep old filesystem/read fallbacks, but it must not publish
 * the retired `lattice` executable alias. Keep this guard structural so adding the
 * alias back to either package.json or package-lock.json fails the residue gate.
 */
export function isCanonicalNpmBinMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value['proof-or-stop'] === 'dist/cli.js'
    && !Object.prototype.hasOwnProperty.call(value, 'lattice');
}

export function isCanonicalMainPackageMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value;
  const bin = record.bin ?? record.packages?.['']?.bin;
  return isCanonicalNpmBinMap(bin);
}

/**
 * Active docs — the brand-prose surface CHK-003 rewrote (check 2).
 *
 * B-cdf6 CHK-003 follow-up: the two host adapter directories were ADDED after they
 * were caught holding ~20 stale `proofOrStop <cmd>` lines each. They were missed the
 * first time precisely because they sat outside every scan root, so nothing failed
 * when they went stale — the exact miss this gate exists to prevent.
 *
 * These files are DERIVED mirrors of the package registry
 * (`renderPromptEntryForHost`), so a hit here means either the registry template /
 * injected slice is stale, or the mirror was not regenerated after the registry
 * changed. Both are real defects a reader/agent would act on: unlike a doc, a stale
 * host prompt is fed verbatim to a spawned agent, so it actively teaches the retired
 * bin name. The invocation detector checks this same shape in mirrors; its
 * structural exclusions grant no authority to other retired identity shapes.
 */
const DOC_SCAN_ROOTS = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs',
  'packages/main/templates',
  '.claude/agents',
  // B-cc10 F-054: scan the CANONICAL adapter dir. This listed '.proof-or-stop-codex/agents', which
  // CHK-003 renamed — so `git ls-files -- <deleted path>` returned an EMPTY list and this root
  // contributed no files. Keep the canonical mirror root explicitly in the scan.
  '.proof-or-stop-codex/agents',
];

/**
 * Executable-surface scan roots (B-cdf6 CHK-006 Pass A).
 *
 * These roots hold code and generated shell/JS assets, not prose docs, so they are scanned
 * with the SAME invocation detector but WITHOUT the `.md`-only restriction: a stale
 * `proofOrStop <cmd>` in a `console.error` recovery hint or a generated hook is exactly as
 * misleading as one in a doc, and `bin/` was previously outside every scan root.
 *
 * Deliberately NOT included, with measured reasons (counts from the detector at the time of
 * writing — reported rather than silently exempted, because they are real findings this pass
 * does not own):
 *
 *   - `packages/main/src` — was 969 hits / 214 files across all three package roots at Pass A;
 *     Pass B rewrote the user-facing runtime strings and it now measures 159 hits / 83 files.
 *     `packages/utils/src` reached 0 and has been PROMOTED to a gated root below.
 *     `packages/lab/src` is down to 1. The 159 that remain are NOT the same class as the
 *     original finding: they are overwhelmingly (a) smoke/verifier fixtures that embed stale
 *     prose as the SPECIMEN under test — rewriting them destroys the positive test case, which
 *     is how Pass B broke and then restored this very file's self-test — and (b) tests that
 *     deliberately exercise retired bin provenance and rejection paths. These specimens
 *     remain subject to the independent identity-cutover verifier and cannot authorize
 *     current runtime aliases.
 *   - `scripts` — 173 hits / 24 files, same specimen-fixture class (77 of them in
 *     verify-entrypoints.mjs alone, which asserts on the deprecated bin on purpose).
 *   - `CHANGELOG.md` — 19 hits, FROZEN historical release record per the mapping table.
 *   - `proof-or-stop-experience-layer-v1.1-zh.md` — 2 hits, both `ProofOrStop story workflow` brand
 *     PROSE (a different mapping-table row than an invocation).
 */
const EXECUTABLE_SCAN_ROOTS = [
  'bin',
  '.codex',
  'package.json',
  // B-cc10 CHK-004: BOTH config spellings are scan roots. Non-existent roots are
  // skipped, so listing both keeps this gate covering whichever name a checkout
  // actually has. Naming only the deprecated one meant that after the rename this
  // root silently scanned NOTHING — the executable-surface check would have gone
  // quietly blind rather than failing, which is the B-cdf6 regression shape.
  // Deliberately literal, not imported from `core/brand-paths.ts`: this verifier
  // must run standalone without a built `dist`.
  'proof-or-stop.config.json',
  'proof-or-stop.config.json',
  'CITATION.cff',
  // B-cdf6 CHK-006 Pass B: promoted from "counted" to GATED once its detector count
  // reached a measured 0 (was 0 hits / 0 files at promotion). This is the only one of
  // the four counted roots that can be gated without failing closed today; see the
  // updated counts in the block above for why the other three stay counted.
  'packages/utils/src',
];

/**
 * Check 2 is scoped to PROSE documents, i.e. markdown. Verified exhaustively: the only
 * non-markdown tracked files under DOC_SCAN_ROOTS are 6 `.json`, 2 `.gitkeep`, 1 `.svg`
 * and 1 `.png`, so restricting to `.md` costs no reader-facing prose coverage. It does
 * remove a genuine false-positive class at the root instead of per-file exemptions:
 *   - `docs/requirements/baselines/proof-or-stop-prompt-baseline.json` — GENERATED and
 *     SHA-256-pinned; its hits are quoted excerpts of LEGACY prompt clauses, i.e. a
 *     record of prompt text as it was, not advice to a reader.
 *   - `docs/metadata/task.json` — structured data consumed by
 *     `packages/main/src/tasks/extract.ts`, not prose anyone reads and follows.
 * A `.json` value is never an instruction a user acts on the way a doc sentence is, so
 * the invocation detector (which is about live "run this" guidance) does not apply.
 */
const PROSE_FILE_RE = /\.md$/;

const EXCLUDE_SUBSTRINGS = ['/node_modules/', '/dist/', '/.proof-or-stop/'];

/**
 * Active docs that legitimately contain a bare `proofOrStop <cmd>` string because the
 * old command name is their SUBJECT, not their advice. Keyed by repo-relative path.
 *
 * Every entry is validated by verifyProseExemptions(): the file must be a scanned
 * prose file, must still exist, AND must still contain at least one hit. A stale entry
 * therefore FAILS the gate instead of silently widening it — an exemption cannot
 * outlive the thing it exempts.
 */
const EXEMPT_PROSE_FILES = new Map([
  [
    'docs/requirements/decisions/brand-rename-mapping.md',
    'The B-cdf6 mapping table itself. It must quote the old strings verbatim as the ' +
      'left-hand side of the rename map; rewriting them would erase the mapping.',
  ],
  [
    'docs/requirements/decisions/proof-or-stop-identity-cutover.md',
    'The approved B-022e clean-break policy is hash-bound provenance and must quote the ' +
      'retired identity as the subject of the no-alias rule.',
  ],
]);

/**
 * @param {string} rel normalized repo-relative path
 * @returns {boolean} true when the path is inside the scannable active scope
 */
function inActiveScope(rel) {
  return !EXCLUDE_SUBSTRINGS.some((s) => rel.includes(s));
}

/**
 * Resolve the concrete set of tracked files under the given roots.
 * Uses `git ls-files` so the scan is deterministic and ignores untracked junk.
 * @param {string[]} roots
 * @returns {string[]} repo-relative file paths
 */
function listScopeFiles(roots) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter(inActiveScope);
}

/**
 * Read a tracked file, returning null when it is not a readable regular file.
 * @param {string} rel
 * @returns {string | null}
 */
function readTracked(rel) {
  const abs = join(repoRoot, rel);
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Scan files under `roots` with `detect`, skipping any path for which `skip` is true.
 * @param {string[]} roots
 * @param {(line: string) => boolean} detect
 * @param {(rel: string) => boolean} [skip]
 * @returns {string[]} formatted `path:line: text` hits
 */
function scanRoots(roots, detect, skip) {
  /** @type {string[]} */
  const hits = [];
  for (const rel of listScopeFiles(roots)) {
    if (skip && skip(rel)) continue;
    const content = readTracked(rel);
    if (content === null) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (detect(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  return hits;
}

/**
 * Assert every prose exemption is still live: it is a scanned prose file, it exists,
 * and it still has a hit. Keeps the exemption list from decaying into a silent hole.
 * @returns {string[]} problems (empty when all exemptions are justified)
 */
function verifyProseExemptions() {
  /** @type {string[]} */
  const problems = [];
  for (const [rel, reason] of EXEMPT_PROSE_FILES) {
    if (!PROSE_FILE_RE.test(rel)) {
      problems.push(
        `useless prose exemption: ${rel} is not a prose (.md) file, so it was never scanned — remove the entry.\n    reason on file: ${reason}`,
      );
      continue;
    }
    const content = readTracked(rel);
    if (content === null) {
      problems.push(
        `stale prose exemption: ${rel} is no longer a readable tracked file — remove the entry.\n    reason on file: ${reason}`,
      );
      continue;
    }
    if (!content.split('\n').some(isBrandProseResidue)) {
      problems.push(
        `stale prose exemption: ${rel} no longer contains a bare \`proofOrStop <cmd>\` hit — remove the entry so the file is gated again.\n    reason on file: ${reason}`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

function runScan() {
  let failed = false;

  // --- CHECK 1: koala zero tolerance over product runtime source ---
  const koalaHits = scanRoots(SRC_SCAN_ROOTS, isResidue);
  if (koalaHits.length === 0) {
    console.log('PASS proof-or-stop-residue [koala]: 0 brand residue in product runtime source');
  } else {
    failed = true;
    console.error('FAIL proof-or-stop-residue [koala]: brand residue found (zero tolerance)');
    for (const h of koalaHits) console.error(`  ${h}`);
    console.error(`\n${koalaHits.length} koala residue hit(s).`);
  }

  // --- CHECK 2: un-renamed brand prose (bare `proofOrStop <cmd>`) in active docs ---
  const exemptionProblems = verifyProseExemptions();
  const proseHits = scanRoots(
    DOC_SCAN_ROOTS,
    isBrandProseResidue,
    (rel) => !PROSE_FILE_RE.test(rel) || EXEMPT_PROSE_FILES.has(rel),
  );

  if (proseHits.length === 0 && exemptionProblems.length === 0) {
    console.log(
      `PASS proof-or-stop-residue [brand-prose]: 0 bare \`proofOrStop <cmd>\` invocations in active docs ` +
        `(${EXEMPT_PROSE_FILES.size} documented exemption(s) verified live)`,
    );
  }
  if (proseHits.length > 0) {
    failed = true;
    console.error(
      'FAIL proof-or-stop-residue [brand-prose]: active docs still instruct the reader to run the OLD bin name',
    );
    for (const h of proseHits) console.error(`  ${h}`);
    console.error(
      `\n${proseHits.length} un-renamed brand invocation(s). Rewrite \`proofOrStop <cmd>\` as ` +
        `\`proof-or-stop <cmd>\` per docs/requirements/decisions/brand-rename-mapping.md ` +
        `(row: "CLI bin name / invocation in active docs" = RENAMED). If the doc quotes the ` +
        `old command as its SUBJECT, add it to EXEMPT_PROSE_FILES with a reason.`,
    );
  }
  if (exemptionProblems.length > 0) {
    failed = true;
    console.error('FAIL proof-or-stop-residue [brand-prose]: exemption list is stale');
    for (const p of exemptionProblems) console.error(`  ${p}`);
  }

  // --- CHECK 3: un-renamed brand invocations on the EXECUTABLE surface (B-cdf6 Pass A) ---
  // Same detector, no `.md` filter and no exemptions: `bin/` and `.codex/` were outside
  // every scan root before this, which is why a stale `proof-or-stop` invocation in a recovery
  // hint or a generated hook could sit there while the gate reported PASS.
  const execHits = scanRoots(EXECUTABLE_SCAN_ROOTS, isBrandProseResidue);
  if (execHits.length === 0) {
    console.log(
      'PASS proof-or-stop-residue [brand-exec]: 0 bare `proofOrStop <cmd>` invocations on the ' +
        `executable surface (${EXECUTABLE_SCAN_ROOTS.join(', ')})`,
    );
  } else {
    failed = true;
    console.error(
      'FAIL proof-or-stop-residue [brand-exec]: executable assets still invoke the OLD bin name',
    );
    for (const h of execHits) console.error(`  ${h}`);
    console.error(
      `\n${execHits.length} un-renamed brand invocation(s) on the executable surface. ` +
        'Rewrite `proofOrStop <cmd>` as `proof-or-stop <cmd>`. Deprecated-alias FILE paths ' +
        '(`bin/proofOrStop.js`) are structurally excluded by the detector and are fine; only ' +
        'a bare `proofOrStop <subcommand>` INVOCATION is reported here.',
    );
  }

  // --- CHECK 3b: npm metadata must publish only the canonical executable ---
  const npmBinProblems = [];
  for (const rel of ['packages/main/package.json', 'packages/main/package-lock.json']) {
    const content = readTracked(rel);
    if (content === null) {
      npmBinProblems.push(`${rel}: file is not readable from the tracked tree`);
      continue;
    }
    try {
      const metadata = JSON.parse(content);
      if (!isCanonicalMainPackageMetadata(metadata)) {
        npmBinProblems.push(`${rel}: npm bin map must contain only proof-or-stop -> dist/cli.js`);
      }
    } catch (error) {
      npmBinProblems.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (npmBinProblems.length === 0) {
    console.log('PASS proof-or-stop-residue [npm-bin]: packages/main publishes only the proof-or-stop bin');
  } else {
    failed = true;
    console.error('FAIL proof-or-stop-residue [npm-bin]: retired lattice npm bin alias is active or metadata is invalid');
    for (const problem of npmBinProblems) console.error(`  ${problem}`);
  }

  // --- CHECK 4: FORBIDDEN deprecated-brand DECISION SITES in runtime source ---
  // The B-cc10 CHK-007 row flip. Scans the same product runtime source as check 1,
  // but SKIPS `**/tasks/**`: those are migration fixtures whose whole job can be to
  // construct a legacy tree, so a deprecated literal there is the specimen under
  // test, not a decision the product makes. Skipping the resolver itself would be
  // wrong (it must be gated like anything else) and is unnecessary — its constants
  // are declarations, which the detector already does not flag.
  const decisionHits = scanRoots(
    SRC_SCAN_ROOTS,
    isBrandDecisionResidue,
    (rel) => rel.includes('/tasks/'),
  );
  if (decisionHits.length === 0) {
    console.log(
      'PASS proof-or-stop-residue [brand-decision]: 0 deprecated brand-path decision sites in product ' +
        `runtime source (forbidden tokens derived from ${BRAND_PATHS_REL}: ${DEPRECATED_BRAND_TOKENS.join(', ')})`,
    );
  } else {
    failed = true;
    console.error(
      'FAIL proof-or-stop-residue [brand-decision]: a DEPRECATED brand literal is used as a path DECISION',
    );
    for (const h of decisionHits) console.error(`  ${h}`);
    console.error(
      `\n${decisionHits.length} forbidden decision site(s). A deprecated literal inside a ` +
        'comparison recognizes ONLY the old spelling, so the CANONICAL name silently fails while ' +
        'the old one keeps working (B-cdf6 F-065/F-061/F-062/F-068). Route the test through the ' +
        `read-both helpers in ${BRAND_PATHS_REL} — isStateDirPath / isAdapterDirPath / ` +
        'isConfigFilename / isManifestFilename — which accept both spellings by construction. ' +
        'Declaring the literal (a DEPRECATED_* constant) or naming it in a deprecation notice is ' +
        'still allowed; only using it as a decision is forbidden.',
    );
  }

  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Inline unit tests.
// ---------------------------------------------------------------------------

/**
 * Cases for isResidue() — the koala zero-tolerance detector.
 *
 * The `false` cases test only this detector's lexical scope. Canonical signature
 * identifiers and retired module-path specimens do not contain its target token.
 * This does not authorize retired runtime aliases, readers, or signing salts;
 * those decisions remain subject to the independent active-identity guard.
 *
 * @type {Array<[string, boolean]>}
 */
const RESIDUE_CASES = [
  ['the koala framework handles this', true],
  ['name: koala-implementer', true],
  ['const KoalaFoo = 1', true],
  ['existsSync(.claude/skills/koala)', true],
  // frozen signature salt (mapping table: FROZEN) — not koala residue
  ['const REVIEW_SALT = "proof-or-stop-review-integrity-v1";', false],
  // deprecated-but-retained bin alias (mapping table: RENAMED-additive, keeps `proof-or-stop`)
  ['import { proofOrStop } from "./proofOrStop.js";', false],
  ['a clean line with no brand token at all', false],
];

/**
 * Cases for isBrandProseResidue() — the B-cdf6 brand-prose detector.
 *
 * The `false` block is the important half: it pins that every FROZEN identifier class
 * from the mapping table is structurally excluded, which is what makes a `proof-or-stop`
 * legacy-bin check possible at all without flagging the legitimate src files.
 *
 * @type {Array<[string, boolean]>}
 */
const BRAND_PROSE_CASES = [
  // --- MUST FLAG: bare invocations of the old bin (mapping table: RENAMED) ---
  [`Run \`${LEGACY_BIN} validate\` to check.`, true],
  [`${LEGACY_BIN} story_advance '{"storyId":"B-xxx"}'`, true],
  [`first command should be \`${LEGACY_BIN} session_brief\``, true],
  [`  ${LEGACY_BIN} validate --full       # includes real-machine tests`, true],
  [`${LEGACY_BIN[0].toUpperCase()}${LEGACY_BIN.slice(1)} validate is the single entry point`, true],

  // --- MUST NOT FLAG: specimens outside the bare-invocation detector's shape ---
  // Retired path specimens are outside this bare-invocation detector's shape.
  ['state lives in .lattice/story/actives/B-xxxx/', false],
  ['writes .lattice/locks/main-write.lock/', false],
  // Retired environment specimens are outside the bare-invocation shape.
  ['export LATTICE_SESSION_BRIEF_FRESH_MINUTES=60', false],
  ['`LATTICE_CLI_VERSION` must be bumped', false],
  // Retired role specimens cannot satisfy a bare-invocation pattern (
  // proof-or-stop-* is canonical for new writes)
  ['Agent({ subagent_type: "lattice-implementer" })', false],
  ['| `lattice-review-scope-plan` | PLAN |', false],
  // signature salts (FROZEN)
  ['salt = `proof-or-stop-delivery-check-integrity-v1`', false],
  // A canonical package import is not a bare executable invocation.
  ["import { devHost } from '@proof-or-stop/core/dev-host';", false],
  // Retired config filenames are specimens, not supported runtime readers.
  ['edit `lattice.config.json` directly', false],
  // Retired wrapper path specimens; the shipped bin map is canonical-only.
  ['node bin/lattice.js verify_codex', false],
  ['node bin/lattice-codex.js session_brief', false],
  // Explicit migration marker input is not a bare executable invocation.
  ['<!-- lattice:start -->', false],
  // Canonical runtime discovery path is not a bare executable invocation.
  ['reads .proof-or-stop-serve.json for the port', false],
  // brand-name PROSE proper noun — a different mapping row, not an invocation
  ['reviewer evidence through ProofOrStop CLI.', false],
  // the NEW brand must never self-trigger
  ['Run `proof-or-stop validate` to check.', false],
  ['proof-or-stop story_advance \'{"storyId":"B-xxx"}\'', false],
  ['a clean line with no brand token at all', false],

  // --- B-cdf6 CHK-006 Pass A: the widened EXECUTABLE_SCAN_ROOTS must not trip on the
  // things Pass A deliberately keeps. These are the shapes that actually appear in the
  // newly-gated `bin/` and `.codex/` files, so each is pinned here. ---
  // All 13 frozen signature salts share this shape; the trailing `-v<N>` means the token
  // is followed by `-`, which the left/right fences reject. Byte-frozen by the mapping table.
  ['const SALT = "proof-or-stop-review-integrity-v1";', false],
  ['proof-or-stop-closeout-write-receipt-integrity-v3', false],
  // Retained deprecated bin ALIAS paths — a file path, not an invocation. Never flagged,
  // which is what makes the rename additive: keeping the alias cannot fail the gate.
  ["path.join(root, 'bin', 'proofOrStop.js'),", false],
  ["const BOOTSTRAP_WRAPPERS = ['proof-or-stop.js', 'proofOrStop.js'];", false],
  ['import \'./proof-or-stop-codex.js\';', false],
  // Read-both bin-name lists: the deprecated name appears as a quoted STRING, not as a
  // `proofOrStop <cmd>` invocation, so the read-both compat pattern is gate-safe.
  ["for (const bin of ['proof-or-stop', 'proof-or-stop']) {", false],
  // The canonical codex wrapper invocation must not self-trigger either.
  ['node bin/proof-or-stop-codex.js verify_codex', false],
  // Frozen npm package name used as a path segment in a resolution probe.
  ["path.join(root, 'node_modules', '@proofOrStop', 'core', 'dist', 'cli.js'),", false],
  // ...but a genuine stale invocation on the executable surface IS still caught.
  [`console.error('  - Rerun: ${LEGACY_BIN} init --verify-codex');`, true],
];

/**
 * Cases for isBrandDecisionResidue() — the B-cc10 CHK-007 forbidden-decision detector.
 *
 * The `true` block pins the three shapes CHK-007 actually found and fixed in the
 * product runtime. The `false` block is what keeps the flip from failing closed on
 * legitimate code: declarations, deprecation notices, read-both candidate lists and
 * resolver-routed tests must all stay clean, or the row could not be flipped at all.
 *
 * @type {Array<[string, boolean]>}
 */
const BRAND_DECISION_CASES = [
  // --- MUST FLAG: a deprecated literal used AS A DECISION (forbidden) ---
  // The three real sites CHK-007 fixed.
  [`  if (path.startsWith('${LEGACY_STATE_DIR}/')) return false;`, true],
  [`    if (hunk.path.startsWith('docs/story/') || hunk.path.startsWith('${LEGACY_STATE_DIR}/')) continue;`, true],
  [`    || lower.startsWith('${LEGACY_STATE_DIR}/')`, true],
  // Other decision shapes on the same tokens.
  [`if (name === '${LEGACY_CONFIG_FILENAME}') return true;`, true],
  [`return relPath.includes('${LEGACY_ADAPTER_DIR}/agents');`, true],
  [`if ('${LEGACY_STATE_DIR}' === firstSegment(path)) return true;`, true],
  [`if (file.endsWith('${LEGACY_MANIFEST_FILENAME}')) return true;`, true],

  // --- MUST NOT FLAG: legitimate uses of the same literals (allowed) ---
  // The read-both constants themselves. Flagging these would forbid the contract.
  [`export const DEPRECATED_STATE_DIR = '${LEGACY_STATE_DIR}';`, false],
  [`export const DEPRECATED_CONFIG_FILENAME = '${LEGACY_CONFIG_FILENAME}';`, false],
  [`export const DEPRECATED_ADAPTER_DIR = '${LEGACY_ADAPTER_DIR}';`, false],
  // Read-both candidate lists: both spellings on purpose, canonical first.
  [`const CONFIG_FILENAMES = ['proof-or-stop.config.json', '${LEGACY_CONFIG_FILENAME}'];`, false],
  // User-facing deprecation notices must be able to NAME the old spelling.
  [`console.warn('${LEGACY_CONFIG_FILENAME} is deprecated; rename it to proof-or-stop.config.json');`, false],
  // Tests routed through the resolver — the correct fix shape.
  ['  if (isStateDirPath(path)) return false;', false],
  ['  if (isConfigFilename(name)) return true;', false],
  // A path JOIN is a construction, not a decision; check 4 deliberately ignores it
  // (whether a writer should use the canonical dir is not a comparison bug).
  [`const dir = join(root, '${LEGACY_ADAPTER_DIR}', 'agents');`, false],
  // The canonical spellings must never self-trigger.
  ["if (path.startsWith('.proof-or-stop/')) return false;", false],
  ["if (name === 'proof-or-stop.config.json') return true;", false],
  ['a clean line with no brand token at all', false],
  // A COMMENT quoting the forbidden shape is allowed — the documented fix for a real
  // decision site records the old code, so flagging comments would forbid the remedy.
  [`  // B-cc10 CHK-007: was \`path.startsWith('${LEGACY_STATE_DIR}/')\`, now resolver-routed.`, false],
  [`   * \`lower.startsWith('${LEGACY_STATE_DIR}/')\` matched only the deprecated spelling.`, false],
  [`  /* legacy: name === '${LEGACY_CONFIG_FILENAME}' */`, false],
  // ...but a trailing comment must NOT launder real code on the same line.
  [`if (path.startsWith('${LEGACY_STATE_DIR}/')) return false; // legacy`, true],
];

const NPM_BIN_CASES = [
  [{ bin: { 'proof-or-stop': 'dist/cli.js' } }, true],
  [{ bin: { 'proof-or-stop': 'dist/cli.js', lattice: 'dist/cli.js' } }, false],
  [{ bin: { lattice: 'dist/cli.js' } }, false],
  [{ packages: { '': { bin: { 'proof-or-stop': 'dist/cli.js' } } } }, true],
  [{ packages: { '': { bin: { 'proof-or-stop': 'dist/cli.js', lattice: 'dist/cli.js' } } } }, false],
];

/**
 * Run the inline detector unit tests. Throws on the first failure.
 * @returns {number} count of assertions run
 */
export function runSelfTest() {
  let passed = 0;
  /** @type {Array<[string, Array<[string, boolean]>, (l: string) => boolean]>} */
  const suites = [
    ['isResidue', RESIDUE_CASES, isResidue],
    ['isBrandProseResidue', BRAND_PROSE_CASES, isBrandProseResidue],
    ['isBrandDecisionResidue', BRAND_DECISION_CASES, isBrandDecisionResidue],
  ];
  for (const [name, cases, detect] of suites) {
    for (const [line, expected] of cases) {
      const actual = detect(line);
      if (actual !== expected) {
        throw new Error(
          `${name}() unit test FAILED:\n  input:    ${JSON.stringify(line)}\n  expected: ${expected}\n  actual:   ${actual}`,
        );
      }
      passed++;
    }
  }
  for (const [metadata, expected] of NPM_BIN_CASES) {
    const actual = isCanonicalMainPackageMetadata(metadata);
    if (actual !== expected) {
      throw new Error(
        `isCanonicalMainPackageMetadata() unit test FAILED:\n  input:    ${JSON.stringify(metadata)}\n  expected: ${expected}\n  actual:   ${actual}`,
      );
    }
    passed++;
  }
  return passed;
}

// Always assert the unit tests at module load so any regression in the detectors
// fails fast for every consumer (scan run, import, or --self-test).
runSelfTest();

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && relative(fileURLToPath(import.meta.url), process.argv[1]) === '';

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) {
    const n = runSelfTest();
    console.log(`PASS proof-or-stop-residue self-test: ${n}/${n} detector unit tests`);
    process.exit(0);
  }
  process.exit(runScan());
}
