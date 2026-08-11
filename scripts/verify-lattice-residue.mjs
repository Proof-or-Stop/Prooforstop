#!/usr/bin/env node
/**
 * verify-lattice-residue.mjs — brand-residue acceptance gate (two independent checks).
 *
 * FILENAME IS FROZEN. `docs/requirements/decisions/brand-rename-mapping.md` classifies
 * this path as FROZEN because it has multiple live couplings, the load-bearing one being
 * `packages/main/src/handlers/review-preflight.ts` (hardcodes the relative path and
 * returns ok:false — FAILS CLOSED — when the file is absent). Also referenced by
 * `package.json` (`test:lattice-residue`), the CLAUDE.md gate table, and
 * `scripts/verify-residue-inject-repro.mjs`. Change this file's CONTENT, never its NAME.
 *
 * ---------------------------------------------------------------------------
 * CHECK 1 — koala residue (zero tolerance, allowlist-free). B-fbca ship-clean story 3.
 * ---------------------------------------------------------------------------
 *   Reproducible check that the product runtime source surface (packages/<pkg>/src)
 *   contains LITERAL ZERO un-rebranded "koala" / "Koala" residue. The koala→lattice
 *   bulk rename drove these roots to zero, so the check is unconditional: ANY
 *   case-insensitive "koala" hit in SRC_SCAN_ROOTS is a FAIL. There is no exemption
 *   list for koala because there is nothing left to exempt. This guarantee must not
 *   regress, and B-cdf6 preserves it byte-for-byte.
 *
 * ---------------------------------------------------------------------------
 * CHECK 2 — un-renamed brand PROSE in active docs (B-cdf6). Exemption-based.
 * ---------------------------------------------------------------------------
 *   The `lattice` token CANNOT be scanned with a zero-tolerance detector the way
 *   `koala` can. Measured fact: 602 files under the src roots legitimately contain it
 *   — signature salts, `.lattice/` state paths, `LATTICE_*` env vars, `@lattice/core`
 *   imports, the 13 frozen `lattice-*` role IDs, `lattice.config.json`. Every one of
 *   those is an explicit FROZEN / FROZEN-THIS-STORY row in the mapping table. A
 *   `/lattice/i` sweep would flag all 602 and be useless, so this check is deliberately
 *   NOT modelled on check 1.
 *
 *   Instead it detects the ONE token shape the mapping table marks RENAMED and that a
 *   reader can act on wrongly: a bare CLI INVOCATION, `lattice <subcommand>`, in an
 *   active doc. That shape tells a user what to run now, so a stale one is a live
 *   instruction to type a command under the old brand name. It is also precisely what
 *   CHK-003 rewrote, which makes this check a real regression detector: reverting any
 *   CHK-003 file re-introduces `lattice <cmd>` and fails the gate (verified in CHK-004
 *   by reverting CLAUDE.md to main — 40+ hits, exit 1).
 *
 *   Why FROZEN identifiers do NOT false-positive: they are all structurally
 *   distinguishable from an invocation by the character that follows the token —
 *   `.lattice/` and `bin/lattice.js` carry a path separator or dot, `LATTICE_*` and
 *   `lattice-review-*` / `@lattice/core` carry `_` `-` `/`, `lattice.config.json`
 *   carries a dot. The detector requires WHITESPACE after the token and a lowercase
 *   subcommand-shaped word after that, so none of those classes can match. That is
 *   a structural exclusion, not an allowlist.
 *
 *   EXEMPT_PROSE_FILES holds the small set of active docs that legitimately quote a
 *   bare `lattice <cmd>` string as their SUBJECT MATTER rather than as advice. Each
 *   entry carries a reason and is asserted to still exist and still contain a hit, so
 *   a stale exemption cannot silently widen the gate.
 *
 * Scope note:
 *   Neither check scans `.lattice/story/**` or `CHANGELOG.md` — both are FROZEN
 *   historical records per the mapping table. Check 1 stays confined to product
 *   runtime source; check 2 to active-doc prose.
 *
 * Usage:
 *   node scripts/verify-lattice-residue.mjs            run both checks; exit 0 PASS / 1 with hit list
 *   node scripts/verify-lattice-residue.mjs --self-test run the inline detector unit tests
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');

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
// CHECK 2 detector: bare `lattice <subcommand>` CLI invocation in active docs.
// ---------------------------------------------------------------------------

/**
 * Matches a bare CLI invocation of the OLD bin name.
 *
 * Anatomy, and why each part is load-bearing:
 *   (?<![A-Za-z0-9_./@-])  left fence. Rejects `.lattice/`, `bin/lattice.js`,
 *                          `@lattice/core`, `LATTICE_`-style and `-lattice`
 *                          compounds by refusing an identifier/path char before
 *                          the token. This is what keeps the 602 frozen-identifier
 *                          files from matching.
 *   [Ll]attice             the token itself; `Lattice` catches prose like
 *                          "Lattice validate".
 *   [ \t]+                 requires real whitespace. `lattice.config.json`,
 *                          `lattice-review-quality` and `LATTICE_X` all fail here.
 *   (?![A-Z])              rejects prose proper nouns such as "Lattice CLI" /
 *                          "Lattice Production Safety", which are brand-name prose
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
// Active scope definitions.
// ---------------------------------------------------------------------------

/** Product runtime source — the koala zero-tolerance surface (check 1). */
const SRC_SCAN_ROOTS = ['packages/main/src', 'packages/lab/src', 'packages/utils/src'];

/**
 * Active docs — the brand-prose surface CHK-003 rewrote (check 2).
 *
 * B-cdf6 CHK-003 follow-up: the two host adapter directories were ADDED after they
 * were caught holding ~20 stale `lattice <cmd>` lines each. They were missed the
 * first time precisely because they sat outside every scan root, so nothing failed
 * when they went stale — the exact miss this gate exists to prevent.
 *
 * These files are DERIVED mirrors of the package registry
 * (`renderPromptEntryForHost`), so a hit here means either the registry template /
 * injected slice is stale, or the mirror was not regenerated after the registry
 * changed. Both are real defects a reader/agent would act on: unlike a doc, a stale
 * host prompt is fed verbatim to a spawned agent, so it actively teaches the retired
 * bin name. Gating them costs no exemptions — the invocation detector already
 * ignores every FROZEN identifier shape that legitimately appears here
 * (`lattice-implementer` and the other 12 role IDs, `.lattice/` paths, `LATTICE_*`
 * env vars, `lattice-*-v1` salts) because its lookbehind excludes `-`, `.`, `/`, `_`.
 */
const DOC_SCAN_ROOTS = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs',
  'packages/main/templates',
  '.claude/agents',
  '.lattice-codex/agents',
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

const EXCLUDE_SUBSTRINGS = ['/node_modules/', '/dist/', '/.lattice/'];

/**
 * Active docs that legitimately contain a bare `lattice <cmd>` string because the
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
    'docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md',
    'Self-declared documented exception (see its own header: "This file is the handoff ' +
      'document for story B-ffa2. It intentionally contains the old role IDs as the ' +
      'canonical rename map; post-migration searches should exclude this file").',
  ],
  [
    'docs/requirements/baselines/proof-or-stop-prompt-overlap-matrix.md',
    'GENERATED artifact — emitted by renderMatrixMarkdown() in ' +
      'scripts/verify-proof-or-stop-prompt-baseline.mjs and hash-pinned by that ' +
      "script's baseline. Editing it by hand would be reverted by the generator and " +
      'would break the pinned baseline; the wording is fixed at the generator.',
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
        `stale prose exemption: ${rel} no longer contains a bare \`lattice <cmd>\` hit — remove the entry so the file is gated again.\n    reason on file: ${reason}`,
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
    console.log('PASS lattice-residue [koala]: 0 brand residue in product runtime source');
  } else {
    failed = true;
    console.error('FAIL lattice-residue [koala]: brand residue found (zero tolerance)');
    for (const h of koalaHits) console.error(`  ${h}`);
    console.error(`\n${koalaHits.length} koala residue hit(s).`);
  }

  // --- CHECK 2: un-renamed brand prose (bare `lattice <cmd>`) in active docs ---
  const exemptionProblems = verifyProseExemptions();
  const proseHits = scanRoots(
    DOC_SCAN_ROOTS,
    isBrandProseResidue,
    (rel) => !PROSE_FILE_RE.test(rel) || EXEMPT_PROSE_FILES.has(rel),
  );

  if (proseHits.length === 0 && exemptionProblems.length === 0) {
    console.log(
      `PASS lattice-residue [brand-prose]: 0 bare \`lattice <cmd>\` invocations in active docs ` +
        `(${EXEMPT_PROSE_FILES.size} documented exemption(s) verified live)`,
    );
  }
  if (proseHits.length > 0) {
    failed = true;
    console.error(
      'FAIL lattice-residue [brand-prose]: active docs still instruct the reader to run the OLD bin name',
    );
    for (const h of proseHits) console.error(`  ${h}`);
    console.error(
      `\n${proseHits.length} un-renamed brand invocation(s). Rewrite \`lattice <cmd>\` as ` +
        `\`proof-or-stop <cmd>\` per docs/requirements/decisions/brand-rename-mapping.md ` +
        `(row: "CLI bin name / invocation in active docs" = RENAMED). If the doc quotes the ` +
        `old command as its SUBJECT, add it to EXEMPT_PROSE_FILES with a reason.`,
    );
  }
  if (exemptionProblems.length > 0) {
    failed = true;
    console.error('FAIL lattice-residue [brand-prose]: exemption list is stale');
    for (const p of exemptionProblems) console.error(`  ${p}`);
  }

  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Inline unit tests.
// ---------------------------------------------------------------------------

/**
 * Cases for isResidue() — the koala zero-tolerance detector.
 *
 * NOTE ON THE TWO `false` CASES BELOW: they assert that a FROZEN `lattice-*`
 * identifier is clean *for the koala check*. The reason is NOT "lattice is the
 * current brand" — it is not; `proof-or-stop` is. The reason is that these exact
 * token shapes are FROZEN rows in
 * docs/requirements/decisions/brand-rename-mapping.md:
 *   - `lattice-review-integrity-v1` is 1 of the 13 frozen signature salts. It is
 *     hashed into `_hash` fields already persisted on live artifacts; renaming it
 *     would invalidate every stored signature and make active stories read as
 *     tampered.
 *   - `./lattice.js` is the deprecated-but-retained bin alias (RENAMED-additive row:
 *     add `proof-or-stop`, KEEP `lattice`), so the module path legitimately survives.
 * Both are therefore correctly outside the koala detector's remit, and both are
 * separately outside the brand-prose detector's remit by structural exclusion
 * (see BRAND_PROSE_CASES).
 *
 * @type {Array<[string, boolean]>}
 */
const RESIDUE_CASES = [
  ['the koala framework handles this', true],
  ['name: koala-implementer', true],
  ['const KoalaFoo = 1', true],
  ['existsSync(.claude/skills/koala)', true],
  // frozen signature salt (mapping table: FROZEN) — not koala residue
  ['const REVIEW_SALT = "lattice-review-integrity-v1";', false],
  // deprecated-but-retained bin alias (mapping table: RENAMED-additive, keeps `lattice`)
  ['import { lattice } from "./lattice.js";', false],
  ['a clean line with no brand token at all', false],
];

/**
 * Cases for isBrandProseResidue() — the B-cdf6 brand-prose detector.
 *
 * The `false` block is the important half: it pins that every FROZEN identifier class
 * from the mapping table is structurally excluded, which is what makes a `lattice`
 * check possible at all without flagging the 602 legitimate src files.
 *
 * @type {Array<[string, boolean]>}
 */
const BRAND_PROSE_CASES = [
  // --- MUST FLAG: bare invocations of the old bin (mapping table: RENAMED) ---
  ['Run `lattice validate` to check.', true],
  ['lattice story_advance \'{"storyId":"B-xxx"}\'', true],
  ['first command should be `lattice session_brief`', true],
  ['  lattice validate --full       # includes real-machine tests', true],
  ['Lattice validate is the single entry point', true],

  // --- MUST NOT FLAG: FROZEN identifier classes (each a mapping-table row) ---
  // .lattice/ state directory (FROZEN)
  ['state lives in .lattice/story/actives/B-xxxx/', false],
  ['writes .lattice/locks/main-write.lock/', false],
  // LATTICE_* env prefix (FROZEN, 56 vars)
  ['export LATTICE_SESSION_BRIEF_FRESH_MINUTES=60', false],
  ['`LATTICE_CLI_VERSION` must be bumped', false],
  // the 13 frozen lattice-* role IDs (FROZEN-THIS-STORY)
  ['Agent({ subagent_type: "lattice-implementer" })', false],
  ['| `lattice-review-scope-plan` | PLAN |', false],
  // signature salts (FROZEN)
  ['salt = `lattice-delivery-check-integrity-v1`', false],
  // npm package name (FROZEN — pre-push hook gates on it)
  ["import { devHost } from '@lattice/core/dev-host';", false],
  // config filename (FROZEN)
  ['edit `lattice.config.json` directly', false],
  // bin wrapper paths (deprecated alias retained)
  ['node bin/lattice.js verify_codex', false],
  ['node bin/lattice-codex.js session_brief', false],
  // managed-block markers (FROZEN)
  ['<!-- lattice:start -->', false],
  // runtime discovery file (FROZEN)
  ['reads .lattice-serve.json for the port', false],
  // brand-name PROSE proper noun — a different mapping row, not an invocation
  ['reviewer evidence through Lattice CLI.', false],
  // the NEW brand must never self-trigger
  ['Run `proof-or-stop validate` to check.', false],
  ['proof-or-stop story_advance \'{"storyId":"B-xxx"}\'', false],
  ['a clean line with no brand token at all', false],
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
    console.log(`PASS lattice-residue self-test: ${n}/${n} detector unit tests`);
    process.exit(0);
  }
  process.exit(runScan());
}
