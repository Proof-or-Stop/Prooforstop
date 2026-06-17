#!/usr/bin/env node
/**
 * verify-koala-residue.mjs — canonical koala brand-residue acceptance gate.
 *
 * Purpose (B-40eb koala residual sweep, basis of follow-on story 4):
 *   Reproducible, full-active-scope check that NO un-rebranded "koala" / "Koala"
 *   brand prose survives in the active source surface, modulo a small,
 *   explicitly documented set of exemptions for genuine legacy-detection logic,
 *   env-var compatibility names, salts, legacy path literals, and assertion
 *   targets.
 *
 * Model:
 *   classify(line) strips every token that is a DOCUMENTED, non-brand use of the
 *   string "koala" (B-3cca neutral process-lane tokens, env vars, salts, legacy
 *   paths, legacy/compat identifiers, dual-accept markers, assertion literals).
 *   If "koala"/"Koala" still remains after stripping, the line is UNCLASSIFIED
 *   brand residue and fails the gate.
 *
 *   A small FILE-LEVEL allowlist (LEGACY_LOGIC_FILES below) covers files whose
 *   koala references are ALL legacy-detection logic / dual-accept / assertion
 *   targets (verified in CHK-007). Prefer line-level rules; only allowlist a
 *   whole file when its koala is genuinely all legacy-logic/assertions.
 *
 * Usage:
 *   node scripts/verify-koala-residue.mjs            scan active scope; exit 0 PASS / 1 with hit list
 *   node scripts/verify-koala-residue.mjs --self-test run classify() unit tests
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');

// ---------------------------------------------------------------------------
// classify(): strip documented non-brand koala tokens; report leftover brand.
// ---------------------------------------------------------------------------

/**
 * Line-level exemption rules. Each entry is a RegExp matching a DOCUMENTED,
 * non-brand use of "koala". classify() removes every match before checking for
 * leftover brand text. Keep these narrow and commented so story 4 can refine.
 */
const NEUTRAL_TOKEN_PATTERNS = [
  // --- B-3cca process-lane neutral tokens (koala-<role>) -------------------
  /koala-(?:codex|review[a-z-]*|implementer|reviewer|eval[a-z-]*|delivery|init|agent|story[a-z-]*)/gi,
  // --- B-3cca legacy/config identifiers ------------------------------------
  /LEGACY_KOALA[A-Z0-9_]*/g, // SCREAMING_CASE legacy constants
  /KoalaConfig/g, // legacy type name
  /KOALA\.md/g, // legacy guide filename literal
  /['"]koala['"]/g, // bare 'koala' / "koala" legacy alias literal

  // --- legacy/compat identifiers (camelCase + comments) --------------------
  // assertNoLegacyKoalaWritePath / containsLegacyKoalaDir / isLegacyKoalaWritePath
  // / getLegacyKoalaActivityLogPath / getMigratedLegacyKoalaActivityLogPath /
  // legacyKoalaViolations / legacyKoalaAliasPreserved / migratedKoalaLogPath /
  // rEmptyKoala / checkIdleKoala / idleKoala — all legacy-detection logic.
  /(?:Legacy|legacy|Migrated|migrated|Empty|Idle|idle|No)Koala[A-Za-z0-9_]*/g,
  /[A-Za-z0-9_]*[Kk]oala(?:Log|Path|Dir|Violations?|AliasPreserved|Write[A-Za-z]*)/g,
  /idleKoala/g, // stale-detector legacy threshold field
  // legacy-koala / legacy_koala lowercased/snake/kebab identifiers
  // (activity.legacy-koala.jsonl filename, legacy_koala_write rule, etc.)
  /legacy[-_]koala[\w-]*/gi,
  /koala[-_](?:write|legacy|local|loses|metadata)[\w-]*/gi,

  // --- legacy-compat descriptive prose ("legacy Koala …" / "Koala env") ----
  // Comments and human strings that DESCRIBE the legacy brand for migration /
  // read-only-compat purposes are documentation of legacy behavior, not active
  // branding. Strip "legacy Koala", "Koala env/runtime/activity/metadata/gate",
  // and the bilingual "koala legacy" compat note.
  /(?:legacy\s+|migrated\s+legacy\s+)koala\b/gi,
  /koala\s+(?:env|runtime|activity|metadata|legacy|gate|loses|lab_create|alias|local\s+bins|package\s+bin|--version)\b/gi,

  // --- env-var compatibility fallbacks (LATTICE_ canonical, KOALA_ legacy) --
  /KOALA_[A-Z0-9_]*/g,

  // --- integrity salts (frozen literals; renaming them would break hashes) -
  // e.g. koala-draft-check-integrity-v1, koala-scope-check-integrity-v1
  /koala-[a-z-]+-integrity-v\d+/g,

  // --- legacy host / agent id string literals (data, not brand prose) ------
  /koala-audit/g,
  /koala-gap-log/g,
  /koala-cli/g,
  /koala-env/g, // SessionSource enum value
  /koala-override-\d+/g, // test fixture session id
  /koala-loses/g, // validation-protocol test gate marker
  /koala-(?:lab|capability|worktree|user|mixed|discard|partial|entrypoints|metadata)[\w-]*/g, // temp-dir / test prefixes

  // --- legacy path literals (absence/dual-accept assertions & runtime compat) --
  /\.lattice-codex\/koala\.json/g, // legacy Codex manifest literal (asserted absent)
  /bin\\?\/koala(?:-codex)?\\?\.js/g, // legacy local wrappers, incl. regex-escaped form bin\/koala\.js
  /koala(?:-codex)?\\?\.js/g, // bare koala.js / koala-codex.js (path segments + escaped regex form)
  /\\\.bin\\\/koala/g, // regex-escaped node_modules/.bin/koala assertion (\.bin\/koala)
  /\.claude\/skills\/koala/g, // legacy skill dir (asserted absent / removed)
  /node_modules\/\.bin\/koala/g, // stale local-bin path (ignored by runtime)
  /koala\.(?:cmd|config\.json)/g, // legacy local bin + config literal
  /(?:other|packaged)-koala/g, // test fixture CLI names for legacy-bin conflict detection
  /koala-debug\.log/g, // legacy debug log filename
  /\.koala[\w./*-]*/gi, // any .koala runtime path incl .koala-tmp-*, .koala-serve.json
  /koala\.[a-z_]+\.v\d+/gi, // wire schemaVersion koala.X.vN
  /@koala-agent\/[\w-]+/g, // legacy npm scope
  /koala-lab\/experiment[\w.]*/g, // lab schema id
  /packages\/koala\//g,
  /docs\/koala\//g,
  /\/work\/koala\//g,
  /\.git\/koala/g, // done-auto-git lock dir

  // --- dual-accept markers (transitional regex that accept BOTH brands) ----
  /\(\?:koala\|lattice\)/g, // /(?:koala|lattice)-profile/ style markers
  /\(\?:lattice\|koala\)/g,
  /lattice\|koala/g, // alternation fragments
  /koala\|lattice/g,
  /LATTICE\/KOALA\/CLAUDE/g, // combined guide label
  /LATTICE_, 'KOALA_/g, // env-prefix passthrough list fragment

  // --- explicit-removal/rejection literals (the brand is the thing forbidden) --
  /'koala-'/g, // story-dispatch legacy role-id prefix rejection
  /no-koala-local-wrapper/g, // lattice-cli doctor check id

  // --- generic test helper identifiers -------------------------------------
  /runKoala(?:ExpectFail)?/g, // worktree-repair-smoke helpers

  // --- legacy session-variable identifier (story-owner-lease) --------------
  // `const koala = env.LATTICE_SESSION_ID; if (koala !== null) ... sessionId: koala`
  /\bkoala\b(?=\s*(?:=|!==|===|\)|,|;|\.))/g,
  /:\s*koala\b/g,

  // --- legacy git-subject literal (`koala: story <id> init` detection) -----
  /koala\$\{':'\}/g, // `koala${':'}` template producing legacy subject prefix
  /koala:\s+story\b/g,

  // --- legacy-alias command normalizer / assertion regex fragments ---------
  // `\bkoala\s+(validate|status|...)` rewrites the legacy alias to `lattice`;
  // smoke tests match `koala <subcommand>` to assert the alias is gone.
  /\\bkoala\\s\+/g, // the source-level regex fragment "\bkoala\s+"
  /\\bkoala\b/g, // source-level "\bkoala" inside an assertion regex literal
  /koala\s+(?:validate|status|checklist_get|session_brief|next|init)\b/gi,
  /koala\s+(?:alias|wrapper|Codex\s+wrapper|as\s+active\s+alias)\b/gi, // "koala alias" / "global koala wrapper" / "koala as active alias"

  // --- legacy-brand assertion targets (the brand IS the forbidden thing) ----
  // These lines assert the legacy koala brand is ABSENT / not delegated to:
  //   spawnSync('koala' …  |  global koala  |  `koala` is retained …
  //   /Legacy alias:\s+koala/  |  Compatible: koala
  /spawnSync\('koala'/g,
  /global\s+koala\b/gi,
  /koala`/g, // backtick-quoted brand in doc-assertion regex literals
  /Legacy alias:\\s\+koala/g,
  /(?:legacy alias|Compatible):\s*koala\b/gi,

  // --- B-292d Story 4 preflight gate self-identifiers ----------------------
  // The koala-residue preflight gate (review-preflight.ts) names itself in
  // source: const KOALA_RESIDUE_GATE_LABEL, gate name 'koala-residue',
  // runKoalaResidueGate helper, KoalaResidueGateResult type, koalaResidue
  // local variable, and the script path literal
  // 'scripts/verify-koala-residue.mjs'. These are not brand prose — they
  // name the gate machinery. Without these the gate's own source would fail
  // its own check.
  /KOALA_RESIDUE[A-Z0-9_]*/g,
  /koala-residue/g,
  /KoalaResidueGate[A-Za-z0-9_]*/g,
  /runKoalaResidueGate/g,
  /koalaResidue/g,
];

/**
 * Strip all documented non-brand koala tokens from a line.
 * @param {string} line
 * @returns {string} line with documented tokens removed
 */
function strip(line) {
  let s = line;
  for (const re of NEUTRAL_TOKEN_PATTERNS) {
    s = s.replace(re, '');
  }
  return s;
}

/**
 * Classify a single line.
 * @param {string} line
 * @returns {'UNCLASSIFIED' | 'EXEMPT' | 'NONE'}
 *   - 'NONE'         no koala token at all
 *   - 'EXEMPT'       koala present but every occurrence is a documented token
 *   - 'UNCLASSIFIED' brand "koala"/"Koala" survives stripping → residue
 */
export function classify(line) {
  if (!/koala/i.test(line)) return 'NONE';
  return /koala/i.test(strip(line)) ? 'UNCLASSIFIED' : 'EXEMPT';
}

// ---------------------------------------------------------------------------
// Active scope definition.
// ---------------------------------------------------------------------------

const SCAN_ROOTS = [
  'packages/main/src',
  'packages/lab/src',
  'packages/utils/src',
  'scripts',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/guide.md',
  'docs/guide-hooks.md',
];

const EXCLUDE_PREFIXES = [
  'packages/main/tests/fixtures',
  'docs/story',
  'docs/requirements/decisions',
  'docs/koala',
];

const EXCLUDE_EXACT = new Set(['CHANGELOG.md']);

const EXCLUDE_SUBSTRINGS = ['/node_modules/', '/dist/', '/.lattice/'];

/**
 * FILE-LEVEL documented-exception allowlist.
 *
 * Each file's koala references are genuinely all legacy-detection logic,
 * dual-accept handling, or assertion/absence targets (verified in CHK-007).
 * These files legitimately must name "koala" to detect/forbid the legacy brand,
 * so they are exempted wholesale. Story 4 can refine this list (prefer
 * line-level rules above; only allowlist a whole file when unavoidable).
 */
const LEGACY_LOGIC_FILES = new Set([
  // Managed-asset legacy-detection + dual-accept + absence assertions.
  'packages/main/src/core/managed-assets.ts',
  // init: legacy koala.json / bin/koala.js cleanup + absence handling.
  'packages/main/src/cli-init.ts',
  // Smoke tests that assert the legacy brand is ABSENT or dual-accepted.
  'packages/main/src/tasks/cli-engine-branding-smoke.ts',
  'packages/main/src/tasks/lattice-only-absence-smoke.ts',
  'packages/main/src/tasks/dev-memory-legacy-read-smoke.ts',
  'packages/main/src/tasks/codex-registry-mode-smoke.ts',
  'packages/main/src/tasks/lattice-baseline-smoke.ts',
  // Verify scripts whose koala is legacy-absence / dual-accept assertions.
  'scripts/verify-codex-assets.mjs',
  'scripts/verify-process-fact-contract.mjs',
  'scripts/verify-runtime-fact-contract.mjs',
  // This gate's own source: every "koala" here is a rule definition, an
  // exemption comment, or a classify() unit-test fixture — not product brand
  // prose. The gate must not flag its own detection logic (self-reference).
  'scripts/verify-koala-residue.mjs',
]);

/**
 * @param {string} rel normalized repo-relative path
 * @returns {boolean} true when the path is inside the scannable active scope
 */
function inActiveScope(rel) {
  if (EXCLUDE_EXACT.has(rel)) return false;
  if (EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
  if (EXCLUDE_SUBSTRINGS.some((s) => rel.includes(s))) return false;
  return true;
}

/**
 * Resolve the concrete set of tracked files in the active scope.
 * Uses `git ls-files` so the scan is deterministic and ignores untracked junk.
 * @returns {string[]} repo-relative file paths
 */
function listScopeFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
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

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

function runScan() {
  const files = listScopeFiles();
  /** @type {string[]} */
  const hits = [];

  for (const rel of files) {
    if (LEGACY_LOGIC_FILES.has(rel)) continue; // documented whole-file exception
    const abs = join(repoRoot, rel);
    let content;
    try {
      if (!statSync(abs).isFile()) continue;
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (classify(lines[i]) === 'UNCLASSIFIED') {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (hits.length === 0) {
    console.log('PASS koala-residue: 0 unclassified');
    return 0;
  }
  console.error('FAIL koala-residue: unclassified brand residue found');
  for (const h of hits) console.error(`  ${h}`);
  console.error(`\n${hits.length} unclassified hit(s).`);
  return 1;
}

// ---------------------------------------------------------------------------
// Inline unit tests for classify().
// ---------------------------------------------------------------------------

/** @type {Array<[string, 'UNCLASSIFIED' | 'EXEMPT']>} */
const CLASSIFY_CASES = [
  // neutral process-lane token stripped, real brand prose remains → residue
  ['koala-codex review then real Koala brand prose', 'UNCLASSIFIED'],
  // documented .koala runtime path → exempt
  ['reads ~/.koala/activity.json at startup', 'EXEMPT'],
  // bare brand, no neutral token → residue
  ['the koala framework handles this', 'UNCLASSIFIED'],
  // koala inside a novel identifier → residue
  ['const KoalaFoo = 1', 'UNCLASSIFIED'],
  // legacy alias literal → exempt
  ["spawnSync('koala', args)", 'EXEMPT'],
];

/**
 * Run classify() unit tests. Throws on the first failure.
 * @returns {number} count of assertions run
 */
export function runSelfTest() {
  let passed = 0;
  for (const [line, expected] of CLASSIFY_CASES) {
    const actual = classify(line);
    if (actual !== expected) {
      throw new Error(
        `classify() unit test FAILED:\n  input:    ${JSON.stringify(line)}\n  expected: ${expected}\n  actual:   ${actual}`,
      );
    }
    passed++;
  }
  return passed;
}

// Always assert the unit tests at module load so any regression in classify()
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
    console.log(`PASS koala-residue self-test: ${n}/${n} classify() unit tests`);
    process.exit(0);
  }
  process.exit(runScan());
}
