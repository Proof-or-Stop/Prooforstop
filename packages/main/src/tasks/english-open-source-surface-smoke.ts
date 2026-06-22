#!/usr/bin/env node
/**
 * @task B-a57f
 * @checklist CHK-004
 * @title English open-source surface — no-new-Chinese gate
 * @type feature
 * @priority high
 * @changes
 *   - [CHK-004] Scan the active source and docs surface for CJK and fail on new untranslated text.
 * @description
 * Phase 3 gate for the cli-engine English open-source translation plan.
 *
 * Scans the ACTIVE source surface (packages/main/src, all *.ts) and the ACTIVE
 * docs (README.md, docs/guide.md, docs/guide-hooks.md, and every *.md under
 * docs/requirements/decisions) for CJK characters (U+4E00..U+9FFF and
 * U+3400..U+4DBF). Any CJK occurrence outside the explicit, audited allowlist
 * FAILS the smoke (non-zero exit) and is reported as file:line:text. A clean
 * tree exits 0.
 *
 * Self-clean by construction: this file contains NO literal CJK. The CJK
 * detector range bounds and the deferred-line markers are assembled from
 * numeric code points (see `cp()` / range constants below), so the gate passes
 * its OWN scan without being added to its own allowlist (no self-exemption).
 * The assembled marker strings still match the literal Chinese lines in
 * cli-engine.ts at runtime — see DEFERRED_CLI_ENGINE_LINE_MARKERS.
 *
 * The allowlist below is intentionally explicit and commented so a reviewer can
 * audit exactly what Chinese is still permitted and why. It is NOT a blanket
 * skip of tests — only specific migration-compatibility fixtures / smoke files
 * that deliberately assert legacy (Chinese) output are allowlisted, by glob.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tasks -> packages/main
const pkgRoot = join(here, '..', '..');
// packages/main -> repo root
const repoRoot = join(pkgRoot, '..', '..');

/** Assemble a string from Unicode code points (keeps literal CJK out of this file). */
function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

// ─── CJK detector ────────────────────────────────────────────────────────────
// CJK Unified Ideographs (U+4E00–U+9FFF) plus Extension A (U+3400–U+4DBF).
// We deliberately do NOT include full-width punctuation / kana — only Han.
// The character class is built from code points so this file stays CJK-free.
const CJK_RE = new RegExp(
  `[${cp(0x4e00)}-${cp(0x9fff)}${cp(0x3400)}-${cp(0x4dbf)}]`,
);
const CJK_RE_G = new RegExp(CJK_RE.source, 'g');

// ─── Scan set (paths relative to repo root) ──────────────────────────────────
// ACTIVE source: every .ts under the main package src tree.
const SRC_GLOB_ROOT = join(pkgRoot, 'src');
// ACTIVE source: the utils package src tree (aux_/truth_/gap_ command surface
// that appears in `lattice help` / `<cmd> --help`).
const UTILS_SRC_GLOB_ROOT = join(repoRoot, 'packages', 'utils', 'src');
// ACTIVE docs: the published guides + the live decision records.
const DOC_FILES: string[] = [
  join(repoRoot, 'README.md'),
  join(repoRoot, 'docs', 'guide.md'),
  join(repoRoot, 'docs', 'guide-hooks.md'),
];
const DECISIONS_GLOB_ROOT = join(repoRoot, 'docs', 'requirements', 'decisions');

// ─── Allowlist ───────────────────────────────────────────────────────────────
// Everything here is Chinese that is PERMITTED to remain. A reviewer should be
// able to audit each entry and its justification. Paths are matched against the
// repo-root-relative POSIX path of the file (forward slashes).
//
// 1) Whole-file allowlist by exact repo-relative path.
//    These are the review/plan doc and the generated manifest, both of which
//    carry Chinese in their `chineseSource` columns by design.
const ALLOWLIST_FILES: readonly string[] = [
  // The execution-plan / review doc: keeps Chinese in its chineseSource column.
  'docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md',
  // The generated translation manifest: chineseSource column is Chinese by design.
  'docs/requirements/decisions/cli-engine-english-translation-manifest.md',
];

// 2) Whole-file allowlist by path substring.
//    Legacy / archived material and build artifacts are never gated.
const ALLOWLIST_PATH_SUBSTRINGS: readonly string[] = [
  '/legacy', // legacy snapshots — frozen, not part of the English surface
  '/archive', // archived material — frozen
  '/.lattice-codex/', // Codex adapter scratch / review artifacts
  '/node_modules/', // dependencies
  '/dist/', // build output (mirrors src; src is the source of truth)
];

// 3) Migration-compatibility test fixtures / smoke files.
//    These DELIBERATELY assert legacy (Chinese) output so the CLI keeps
//    backward compatibility during the translation rollout. They are NOT a
//    blanket "skip all tests" — only the specific globs below are exempt, each
//    because it pins old Chinese strings on purpose. When a given smoke is fully
//    migrated to assert only English, remove its entry here.
const ALLOWLIST_TEST_GLOBS: readonly RegExp[] = [
  // All hand-authored test fixtures (golden JSON pinning historical output).
  // Fixtures live under packages/main/tests/fixtures/** (outside the src scan
  // set today) — listed here defensively so any fixture moved under src stays
  // exempt.
  /^packages\/main\/tests\/fixtures\//,
  // Smoke that asserts the text-mode validate hint still renders in Chinese
  // ("validate all-green" hint) for backward compatibility.
  /^packages\/main\/src\/tasks\/cli-json-stdout-contract-smoke\.ts$/,
  // Smoke whose regexes accept BOTH the English and legacy Chinese merge /
  // cleanup / delete lines (e.g. "merged into | <legacy zh>").
  /^packages\/main\/src\/tasks\/worktree-authority-smoke\.ts$/,
  // Smoke whose regexes accept BOTH "JSON parse failed | <legacy zh>" etc.
  /^packages\/main\/src\/tasks\/validation-protocol-smoke\.ts$/,
  // Branding-audit smoke: its classifier regexes literally contain legacy
  // Chinese alias markers in order to detect-and-strip them.
  /^packages\/main\/src\/tasks\/cli-engine-branding-smoke\.ts$/,
  // Docs-drift path-parser smoke: its fixtures are Chinese prose ("do not
  // create X" / "X must not exist") on purpose — the parser under test extracts
  // forbidden paths from Chinese sentences, so removing the CJK would void it.
  /^packages\/main\/src\/tasks\/docs-drift-path-drift-smoke\.ts$/,
  // Prompt-token-cost smoke: asserts the audit caveat matcher accepts the
  // Chinese caveat marker (the "uncertain" caveat regex) for backward
  // compatibility; the CJK is the fixture being matched, not stray content.
  /^packages\/main\/src\/tasks\/prompt-token-cost-smoke\.ts$/,
  // Done-preflight smoke: asserts the genuinely-Chinese B-72df merge-failure
  // message from done-effects.ts (itself pending-migration, allowlisted below);
  // the test legitimately must match that Chinese output, so its fixture CJK is
  // deliberate, not stray content.
  /^packages\/main\/src\/tasks\/done-preflight-smoke\.ts$/,
];

// 3b) Source files NOT covered by the cli-engine English plan / manifest.
//     The execution plan (cli-engine-english-open-source-execution-plan.md) and
//     its line-level manifest are scoped to packages/main/src/cli-engine.ts only.
//     These other source files still carry PRE-EXISTING Chinese and are tracked
//     for a follow-up source-translation story. They are allowlisted (not gated)
//     so this gate locks the COMPLETED surface (cli-engine.ts + active docs)
//     without silently expanding scope into ~470 unreviewed lines. Remove an
//     entry here as each file is migrated to English.
const ALLOWLIST_PENDING_SOURCE_MIGRATION: readonly string[] = [
  'packages/main/src/cli-init.ts',
  'packages/main/src/init-assets.ts',
  'packages/main/src/registry.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/core/hooks.ts',
  'packages/main/src/core/machine.ts',
  'packages/main/src/core/managed-assets.ts',
  'packages/main/src/core/command-policy.ts',
  'packages/main/src/handlers/done-effects.ts',
  'packages/main/src/handlers/test-auto.ts',
  // Production handler carrying a pending Chinese code COMMENT (the `role` arg
  // re-validation note references the Handler-conventions doc by its Chinese
  // heading); deferred to the source-translation follow-up — comment-only, no
  // behavior change needed.
  'packages/main/src/handlers/agent-prompt.ts',
  // Behavior-sensitive: parses forbidden paths out of Chinese doc prose via
  // regexes that literally contain Chinese path-prohibition phrases ("do not
  // create X" / "X must not exist" and the Chinese "or" separator). Changing
  // those regexes risks behavior, so it is deferred to the same coordinated
  // source-translation follow-up.
  'packages/main/src/handlers/validate-docs-drift.ts',
  'packages/main/src/handlers/hints.ts',
  'packages/main/src/handlers/phase-gates.ts',
  'packages/main/src/handlers/evaluate.ts',
  'packages/main/src/handlers/verifier.ts',
  'packages/main/src/tasks/extract.ts',
  // Behavior-sensitive: aux-diagnose matches Chinese rootCause substrings at
  // runtime (.includes('<zh>')) and returns coupled Chinese advice — a
  // Chinese-in/Chinese-out subsystem that needs a coordinated code+test change.
  // Deferred to the same follow-up as M668/M669/M750.
  'packages/utils/src/handlers/aux-diagnose.ts',
];

// 4) Deferred behavior-sensitive lines in cli-engine.ts (M668 / M669 / M750).
//    These three runtime matchers parse Chinese substrings of user/config text;
//    changing them risks behavior, so they are deferred to a follow-up story.
//    Allowlisted by matching the specific marker substrings ON the line, so the
//    rest of cli-engine.ts is still gated normally.
//
//    Markers are assembled from code points (cp(...)) so this gate file holds no
//    literal CJK. Decoded, they equal the Chinese substrings on those lines:
//      M668 -> "<zh:shi-zhong-wei> dry-run"   (always-on dry-run matcher)
//      M669 -> "<zh:mo-ren> dry run"          (default dry-run matcher)
//      M750 -> "<zh:dang-qian...> git <zh>"   ("current dir is not a git repo")
const CLI_ENGINE_REL = 'packages/main/src/cli-engine.ts';
const DEFERRED_CLI_ENGINE_LINE_MARKERS: readonly string[] = [
  // M668 — always-on dry-run matcher.  zh + " dry-run"
  cp(0x59cb, 0x7ec8, 0x4e3a) + ' dry-run',
  // M669 — default dry-run matcher.    zh + " dry run"
  cp(0x9ed8, 0x8ba4) + ' dry run',
  // M750 — "current dir is not a git repo".  zh + " git " + zh
  cp(0x5f53, 0x524d, 0x76ee, 0x5f55, 0x4e0d, 0x662f) + ' git ' + cp(0x4ed3, 0x5e93),
];

// ─── Path helpers ────────────────────────────────────────────────────────────
function toRepoRel(absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join('/');
}

function isFileAllowlisted(repoRel: string): boolean {
  if (ALLOWLIST_FILES.includes(repoRel)) return true;
  if (ALLOWLIST_PENDING_SOURCE_MIGRATION.includes(repoRel)) return true;
  for (const sub of ALLOWLIST_PATH_SUBSTRINGS) {
    // Compare against a leading-slash-normalized form so "/legacy" matches a
    // top-level "legacy/" segment as well as a nested one.
    if (('/' + repoRel).includes(sub)) return true;
  }
  for (const re of ALLOWLIST_TEST_GLOBS) {
    if (re.test(repoRel)) return true;
  }
  return false;
}

function isAllowlistedLine(repoRel: string, line: string): boolean {
  if (repoRel === CLI_ENGINE_REL) {
    for (const marker of DEFERRED_CLI_ENGINE_LINE_MARKERS) {
      if (line.includes(marker)) return true;
    }
  }
  return false;
}

// ─── File collection ─────────────────────────────────────────────────────────
function walk(dir: string, predicate: (absPath: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const repoRel = toRepoRel(abs);
      // Prune entire directories that are whole-file allowlisted by substring
      // (e.g. dist/, node_modules/, legacy/) — saves walking large trees.
      if (ALLOWLIST_PATH_SUBSTRINGS.some((s) => ('/' + repoRel + '/').includes(s))) {
        continue;
      }
      out.push(...walk(abs, predicate));
    } else if (predicate(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function collectScanSet(): string[] {
  const files = new Set<string>();
  // Active source: all .ts under packages/main/src.
  for (const f of walk(SRC_GLOB_ROOT, (p) => p.endsWith('.ts'))) files.add(f);
  // Active source: all .ts under packages/utils/src (the aux_/truth_ CLI surface).
  for (const f of walk(UTILS_SRC_GLOB_ROOT, (p) => p.endsWith('.ts'))) files.add(f);
  // Active docs: the named guide files.
  for (const f of DOC_FILES) if (existsSync(f)) files.add(f);
  // Active decision records: all .md under docs/requirements/decisions.
  for (const f of walk(DECISIONS_GLOB_ROOT, (p) => p.endsWith('.md'))) files.add(f);
  return [...files].sort();
}

// ─── Scanner ─────────────────────────────────────────────────────────────────
interface Offense {
  repoRel: string;
  lineNo: number;
  text: string;
}

function scanFile(absPath: string): Offense[] {
  const repoRel = toRepoRel(absPath);
  if (isFileAllowlisted(repoRel)) return [];
  const offenses: Offense[] = [];
  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CJK_RE.test(line)) continue;
    if (isAllowlistedLine(repoRel, line)) continue;
    offenses.push({ repoRel, lineNo: i + 1, text: line.trim() });
  }
  return offenses;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const scanSet = collectScanSet();
const allOffenses: Offense[] = [];
for (const abs of scanSet) {
  allOffenses.push(...scanFile(abs));
}

if (allOffenses.length > 0) {
  process.stderr.write(
    `english-open-source-surface smoke: FAIL — Chinese (CJK) found in ${
      new Set(allOffenses.map((o) => o.repoRel)).size
    } active file(s), ${allOffenses.length} line(s):\n`,
  );
  // Group by file for readable output, capped per file to stay legible while
  // still showing the count.
  const byFile = new Map<string, Offense[]>();
  for (const o of allOffenses) {
    const arr = byFile.get(o.repoRel) ?? [];
    arr.push(o);
    byFile.set(o.repoRel, arr);
  }
  for (const [file, offenses] of [...byFile.entries()].sort()) {
    process.stderr.write(`  ✗ ${file} (${offenses.length} line(s)):\n`);
    const CAP = 8;
    for (const o of offenses.slice(0, CAP)) {
      // file:line:text — surface the first few CJK chars for clarity.
      const m = o.text.match(CJK_RE_G);
      const snippet = m ? m.join('') : '';
      process.stderr.write(`      ${file}:${o.lineNo}: ${o.text}  [CJK: ${snippet.slice(0, 24)}]\n`);
    }
    if (offenses.length > CAP) {
      process.stderr.write(`      … and ${offenses.length - CAP} more line(s) in this file\n`);
    }
  }
  process.exit(1);
} else {
  process.stdout.write(
    `english-open-source-surface smoke: PASS — scanned ${scanSet.length} active file(s), no Chinese (CJK) outside the allowlist\n`,
  );
}
