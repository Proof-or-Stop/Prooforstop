#!/usr/bin/env node
// @ts-check
/**
 * extract-cli-engine-english-manifest.mjs
 *
 * Regenerates the line-level English-translation manifest for
 * packages/main/src/cli-engine.ts (proof-or-stop story B-a57f, Phase 0 — "Freeze the
 * manifest").
 *
 * It scans the CURRENT cli-engine.ts source, emits one TSV row per
 * Chinese-bearing source line, and — for every line — reuses the approved
 * translation row from the point-in-time manifest already embedded in
 *   docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md
 * by matching on the Chinese-bearing snippet of the line.
 *
 * Matched lines carry over the same Mxxx id + surface + proposedEnglish +
 * reviewStatus from the plan doc. Brand-new Chinese lines (added after the
 * 2026-06-13 snapshot) get a fresh stable id (M763+), reviewStatus=review-draft,
 * and a faithful English translation proposed here following the plan doc's
 * glossary + CLI style guide.
 *
 * Canonical command:
 *   node scripts/extract-cli-engine-english-manifest.mjs \
 *     > docs/requirements/decisions/cli-engine-english-translation-manifest.md
 *
 * Output is written to stdout, wrapped in a ```tsv fenced block with a short
 * generated-source header. Phase 0 does not edit cli-engine.ts itself.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SOURCE_PATH = join(REPO_ROOT, 'packages/main/src/cli-engine.ts');
const PLAN_PATH = join(
  REPO_ROOT,
  'docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md',
);

const HEADER = 'translationId\tsourceLine\tsurface\tchineseSource\tproposedEnglish\treviewStatus';

/** Matches any CJK Unified Ideograph. */
const CJK = /[一-鿿]/;
const CJK_GLOBAL = /[一-鿿]/g;

/**
 * Runtime Chinese matchers (regex `.test()`/`.match()` or string comparison
 * such as `.includes()`). These rows are behavior-sensitive: the Chinese text
 * is parsed at runtime, so it must NOT be applied as plain prose during a
 * later phase. Detection is content-based (not line-number-based) so it stays
 * correct as the file shifts.
 */
function isRuntimeMatcherLine(rawLine) {
  // A regex literal containing Chinese, used with .test() / .match().
  if (/\/[^\/\n]*[一-鿿][^\/\n]*\/[gimsuy]*\s*\.(test|match)\s*\(/.test(rawLine)) return true;
  // .test()/.match() invoked with a regex literal arg containing Chinese.
  if (/\.(test|match)\s*\(\s*\/[^\/\n]*[一-鿿]/.test(rawLine)) return true;
  // String membership / prefix / index comparison against a Chinese literal.
  if (/\.(includes|startsWith|endsWith|indexOf|search)\s*\(\s*['"`][^'"`]*[一-鿿]/.test(rawLine)) return true;
  // new RegExp('...Chinese...') / switch-case on a Chinese literal.
  if (/new\s+RegExp\s*\(\s*['"`][^'"`]*[一-鿿]/.test(rawLine)) return true;
  if (/case\s+['"`][^'"`]*[一-鿿]/.test(rawLine)) return true;
  return false;
}

/** Strip line-comment / block-comment markers from a comment line. */
function stripCommentMarkers(text) {
  let t = text.trim();
  t = t.replace(/^\/\*\*?/, ''); // leading /** or /*
  t = t.replace(/^\/\//, ''); // leading //
  t = t.replace(/^\*+/, ''); // leading * (block-comment continuation)
  return t.trim();
}

/** Reduce a snippet to its Chinese-only character sequence (fallback key). */
function chineseOnly(text) {
  const m = text.match(CJK_GLOBAL);
  return m ? m.join('') : '';
}

/**
 * Heuristic surface classification for genuinely NEW Chinese lines that have no
 * match in the plan manifest. Matched lines reuse the plan's surface verbatim,
 * so this only governs the handful of newly added rows.
 */
function classifySurface(rawLine) {
  const line = rawLine.trim();
  if (/^\/\/|^\/\*|^\*|\*\/\s*$/.test(line) || /^\/\*\*/.test(line)) return 'comment';
  if (/\.describe\s*\(/.test(line)) return 'schema';
  if (/\bdescription\s*:\s*['"`]/.test(line)) return 'command-description';
  if (/[⚠✗✖]|失败|错误|无法|不允许|拒绝/.test(line)) return 'error';
  if (/→|Next:|提示|建议先|请先/.test(line)) return 'hint';
  if (/console\.log|return\s*`|`[^`]*\$\{/.test(line)) return 'cli-output';
  return 'other';
}

/**
 * Derive the Chinese-bearing snippet for a source line, mirroring the original
 * generator's per-surface heuristics so it matches the plan manifest:
 *   - runtime string-comparison guards (.includes('…')): the literal argument;
 *   - runtime regex matchers: the whole trimmed line;
 *   - .describe('…') / description:'…': the full inner string literal;
 *   - comment lines: the line with comment markers stripped;
 *   - otherwise: the trimmed line.
 */
function deriveChineseSource(rawLine) {
  // .includes/.startsWith/.endsWith/.indexOf('…Chinese…') → the literal arg.
  const includeMatch = rawLine.match(
    /\.(?:includes|startsWith|endsWith|indexOf|search)\s*\(\s*(['"`])([^'"`]*[一-鿿][^'"`]*)\1/,
  );
  if (includeMatch) return includeMatch[2];

  // Runtime regex matcher (.test/.match): keep the whole trimmed line.
  if (/\.(test|match)\s*\(/.test(rawLine) && /\/[^\/\n]*[一-鿿]/.test(rawLine)) {
    return rawLine.trim();
  }

  // .describe('…') / description: '…' → full inner string literal.
  const descMatch = rawLine.match(/(?:\.describe\s*\(|description\s*:)\s*(['"`])([\s\S]*?)\1/);
  if (descMatch && CJK.test(descMatch[2])) return descMatch[2];

  // Comment line → strip markers.
  const trimmed = rawLine.trim();
  if (/^\/\/|^\/\*|^\*/.test(trimmed)) return stripCommentMarkers(rawLine);

  // Fallback: the trimmed source line.
  return trimmed;
}

/**
 * Parse the plan-doc manifest's ```tsv block into an ordered row list.
 *
 * The point-in-time plan manifest is NOT strictly one-row-per-physical-line:
 * the original generator merged adjacent Chinese strings that belong to the
 * same logical construct (e.g. two `.describe()` calls on one line, or a
 * `.min(...)` message plus its `.describe()`) into a single row, joining the
 * pieces with ` / `. To stay robust against that — and against line shifts —
 * we match the CURRENT one-line-per-row scan to the plan by Chinese-only
 * character content (containment), not by exact line text.
 */
function parsePlanManifest(planText) {
  const lines = planText.split('\n');
  let inTsv = false;
  let sawHeader = false;
  /** @type {{id:string,surface:string,chineseSource:string,chineseKey:string,proposedEnglish:string,reviewStatus:string}[]} */
  const rows = [];
  let maxId = 0;

  for (const line of lines) {
    if (line.trim() === '```tsv') {
      inTsv = true;
      sawHeader = false;
      continue;
    }
    if (inTsv && line.trim() === '```') {
      inTsv = false;
      continue;
    }
    if (!inTsv) continue;
    if (!sawHeader) {
      // First line inside the block is the column header.
      sawHeader = true;
      continue;
    }
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const [id, , surface, chineseSource, proposedEnglish, reviewStatus] = cols;
    if (!/^M\d+$/.test(id)) continue;
    const num = Number(id.slice(1));
    if (num > maxId) maxId = num;
    rows.push({
      id,
      surface,
      chineseSource,
      chineseKey: chineseOnly(chineseSource),
      proposedEnglish,
      reviewStatus,
    });
  }

  return { rows, maxId };
}

/**
 * Match a current source line to an approved plan row.
 *
 * Strategy (most precise first):
 *   1. exact chineseSource string equality;
 *   2. exact Chinese-only character equality (survives whitespace / marker / id
 *      drift);
 *   3. containment: the plan row's Chinese-only content includes this line's
 *      Chinese-only content (the current line is one segment of a merged plan
 *      row). Prefer the shortest such plan row to avoid over-broad matches.
 */
function matchPlanRow(plan, chineseSource) {
  const exact = plan.rows.find((r) => r.chineseSource === chineseSource);
  if (exact) return exact;

  const key = chineseOnly(chineseSource);
  if (!key) return undefined;

  const exactKey = plan.rows.find((r) => r.chineseKey === key);
  if (exactKey) return exactKey;

  let best;
  for (const r of plan.rows) {
    if (r.chineseKey.length > 0 && r.chineseKey.includes(key)) {
      if (!best || r.chineseKey.length < best.chineseKey.length) best = r;
    }
  }
  return best;
}

/**
 * Faithful English translations for the Chinese lines added after the
 * 2026-06-13 snapshot (no match in the plan manifest). Keyed by the
 * Chinese-only normalized form so they survive whitespace/marker differences.
 * Follows the plan doc glossary + CLI style guide: imperative/sentence-case,
 * no final period for command descriptions, preserve identifiers/enum/JSON
 * keys/template tokens verbatim.
 */
const NEW_LINE_TRANSLATIONS = new Map([
  // verification_intent_repair command + schema (added after the 2026-06-13
  // snapshot by B-4e06). Keyed by chineseOnly(chineseSource).
  // L485 — command description (imperative, sentence-case, no final period;
  // preserve identifiers verificationEvidence / verificationIntent / intent / should).
  [
    '受控修复从已有反推仅填补缺失的绝不覆盖已撰写为优先级',
    'Controlled legacy repair: back-fill only the missing verificationIntent lanes inferred from existing PASSING verificationEvidence (never overwrites authored intent; synthesized intent uses should priority)',
  ],
  // L487 — schema field (preserve verificationEvidence.intentRef / intent).
  [
    '当前唯一模式从反推缺失的',
    'Only supported mode: infer the missing intent from verificationEvidence.intentRef',
  ],
  // L488 — schema field (preserve true / legacy / PLAN).
  [
    '必须显式传确认这是数据补洞不是正常流程',
    'Must be passed explicitly as true: confirms this is a legacy data backfill, not the normal PLAN flow',
  ],
  // L489 — schema field. The describe() text is the meaningful snippet; the
  // co-located .min(30, 'reason 必须 ≥ 30 字符') message is runtime validation
  // prose, not a Chinese matcher (preserve legacy).
  [
    '为什么需要修复你核查了什么',
    'Why the legacy repair is needed, and what you verified',
  ],
  // L490 — schema field (preserve intent).
  [
    '只报告将生成的条目不写入',
    'Report only the intent entries that would be generated; do not write them',
  ],
]);

function main() {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const plan = parsePlanManifest(readFileSync(PLAN_PATH, 'utf8'));

  const srcLines = source.split('\n');
  let nextNewId = plan.maxId + 1;

  /** @type {string[]} */
  const rows = [];

  srcLines.forEach((rawLine, idx) => {
    if (!CJK.test(rawLine)) return;
    const sourceLine = idx + 1;
    const chineseSource = deriveChineseSource(rawLine);

    const runtimeMatcher = isRuntimeMatcherLine(rawLine);

    // Look up the approved row from the plan manifest.
    const match = matchPlanRow(plan, chineseSource);

    let translationId;
    let surface;
    let proposedEnglish;
    let reviewStatus;

    if (match) {
      translationId = match.id;
      surface = match.surface;
      proposedEnglish = match.proposedEnglish;
      reviewStatus = match.reviewStatus;
    } else {
      // Brand-new Chinese line: assign a fresh stable id and translate.
      translationId = `M${nextNewId++}`;
      surface = classifySurface(rawLine);
      const key = chineseOnly(chineseSource);
      proposedEnglish = NEW_LINE_TRANSLATIONS.get(key) || '';
      reviewStatus = 'review-draft';
      if (!proposedEnglish) {
        // Defensive fallback so no generated row is ever left empty; should be
        // overridden by NEW_LINE_TRANSLATIONS for every real new line.
        throw new Error(
          `No proposed English for new Chinese line ${sourceLine}: ${chineseSource}\n` +
            `Add a NEW_LINE_TRANSLATIONS entry keyed by: ${key}`,
        );
      }
    }

    // Behavior-sensitive overrides reviewStatus for runtime matchers regardless
    // of what the plan said, so any newly discovered matcher is flagged too.
    if (runtimeMatcher) {
      reviewStatus = 'behavior-sensitive';
    }

    rows.push(
      [translationId, sourceLine, surface, chineseSource, proposedEnglish, reviewStatus].join('\t'),
    );
  });

  const out = [];
  out.push('# CLI-Engine English Translation Manifest (generated, current source)');
  out.push('');
  out.push(
    'Generated by `scripts/extract-cli-engine-english-manifest.mjs` from the',
  );
  out.push(
    'current `packages/main/src/cli-engine.ts`. One row per Chinese-bearing',
  );
  out.push(
    'source line. `translationId` / `proposedEnglish` / `reviewStatus` are',
  );
  out.push(
    'carried over from the approved manifest in',
  );
  out.push(
    '`cli-engine-english-open-source-execution-plan.md` by matching the',
  );
  out.push(
    'Chinese snippet; lines added after the 2026-06-13 snapshot get a fresh',
  );
  out.push(
    'stable id and a `review-draft` proposal. Rows whose source line parses',
  );
  out.push(
    'Chinese at runtime are flagged `behavior-sensitive` and must not be',
  );
  out.push(
    'applied as plain prose. Regenerate, do not hand-edit:',
  );
  out.push('');
  out.push('```bash');
  out.push(
    'node scripts/extract-cli-engine-english-manifest.mjs > docs/requirements/decisions/cli-engine-english-translation-manifest.md',
  );
  out.push('```');
  out.push('');
  out.push('```tsv');
  out.push(HEADER);
  for (const r of rows) out.push(r);
  out.push('```');
  out.push('');

  process.stdout.write(out.join('\n'));
}

main();
