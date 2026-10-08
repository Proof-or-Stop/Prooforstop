/**
 * english-artifact-gate — diff/story-scoped CJK gate for the English-only policy (B-5f42).
 *
 * Scope is intentionally NARROW and forward-looking (the repository is full of
 * legacy Chinese; the policy does NOT translate retroactively):
 *
 *   1) Commit subjects + bodies on this branch only: `git log <integration>..HEAD`.
 *   2) The CURRENT story's AUTHOR-CONTROLLED metadata files only, resolved from
 *      .proof-or-stop/story/actives/<storyId>/ (or whatever storyDir the store uses):
 *        background.md, index.json, checklist.json, decision.json,
 *        understanding.json, plan.md, summary.json.
 *
 * It NEVER scans:
 *   - outside the current story dir (other stories' legacy Chinese is untouched),
 *   - captured program output inside those files (CAPTURED_OUTPUT_FIELD_KEYS:
 *     verification `outputTail`/`stdout`/`stderr`, the DONE summary's observed
 *     `actualTranscript`, ...). Output is what a program printed, not prose an
 *     author wrote; old-PoS run 25 stalled REVIEW because `go test -v` of the
 *     task's own Unicode tests printed CJK subtest names into `outputTail`
 *     (run 20: the same for `actualTranscript`),
 *   - framework / reviewer / runtime artifacts inside the current story dir
 *     (process-events.jsonl, review-runs.json, scope-check.json, *-boundary.json,
 *     etc. — see RUNTIME_EXCLUDE_BASENAMES), which are not author-written prose.
 *
 * Detection is delegated to the pure core/cjk-detect.ts (single source of truth).
 * I/O (git + fs reads) lives here; the gate never throws on git/fs failure — a
 * git failure returns ok with a note so a missing/odd git state does not block.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectCjk } from '../core/cjk-detect.js';
import { requireRepositoryBaselineRef } from '../core/git-baseline.js';

/** Author-controlled metadata files scanned inside the current story dir. */
export const AUTHOR_METADATA_BASENAMES: readonly string[] = [
  'background.md',
  'index.json',
  'checklist.json',
  'decision.json',
  'understanding.json',
  'plan.md',
  'summary.json',
];

/**
 * Framework / reviewer / pure-runtime artifacts that may legitimately carry
 * generated or legacy text — never gated. This is defense-in-depth on top of
 * the author allowlist (a file must be in AUTHOR_METADATA_BASENAMES AND not in
 * this set to be scanned).
 */
export const RUNTIME_EXCLUDE_BASENAMES: readonly string[] = [
  'process-events.jsonl',
  'process-metrics.json',
  'owner-lease.json',
  'review-runs.json',
  'review-passes.json',
  'review.json',
  'findings.json',
  'scope-check.json',
  'init-check.json',
  'init-self-check.json',
  'delivery-check.json',
  'test-evidence.json',
  'scope-freeze-check.json',
  'scope-boundary.json',
  'execution-boundary.json',
];

/**
 * JSON keys whose string value (or whole subtree) records program output: the
 * captured verification output and the observed run transcript. These carry
 * whatever the program printed (the task's own Unicode test names, data
 * literals), so the English-only authoring policy does not apply to them —
 * neither in the REVIEW→TEST/DONE artifact gate nor at authoring time.
 * Owner-authored prose (titles, intents, notes, selectors, expectedOutcome)
 * stays in scope.
 */
export const CAPTURED_OUTPUT_FIELD_KEYS: readonly string[] = [
  'outputTail',
  'output',
  'stdout',
  'stderr',
  'stdoutTail',
  'stderrTail',
  'observedOutput',
  'actualTranscript',
];

/** True for a JSON key whose value records program output (never English-scanned). */
export function isCapturedOutputFieldKey(key: string): boolean {
  return CAPTURED_OUTPUT_FIELD_KEYS.includes(key);
}

export interface EnglishArtifactViolation {
  /** Where the CJK was found: "commit <sha7>" or a story-relative file path. */
  source: string;
  /** 1-based line number within the source. */
  line: number;
  /** A short English-safe preview of the offending line. */
  preview: string;
  /** The CJK code points on that line (U+XXXX), so the author can quote data literals by code point. */
  codepoints?: string[];
}

export interface EnglishArtifactGateResult {
  ok: boolean;
  violations: EnglishArtifactViolation[];
  /** Non-blocking diagnostics (e.g. git unavailable, story dir missing). */
  notes: string[];
}

/** Injectable git log reader. Returns raw branch-only `git log <integration>..HEAD` text. */
export type GitLogReader = (cwd: string) => string;

/** Injectable file reader (returns null when the file is absent/unreadable). */
export type FileReader = (absPath: string) => string | null;

export interface EnglishArtifactGateDeps {
  /** Absolute path to the current story directory. */
  storyDir: string;
  /** Working directory for git (the repo root for this story). */
  gitCwd: string;
  /** test injection — git log reader. */
  gitLogReader?: GitLogReader;
  /** test injection — file reader. */
  readFile?: FileReader;
}

/** One author-provided text field to scan at authoring time (before persistence). */
export interface EnglishAuthoringTextSource {
  /** User-facing field name, e.g. "background" or "checklist[1].title". */
  field: string;
  /** Author-provided text to check. Non-string / empty values are ignored. */
  text: unknown;
  /** Optional field refinement based on the offending 1-based line number. */
  fieldForLine?: (line: number) => string;
}

/**
 * Project every author-controlled string leaf of one checklist payload into
 * the shared English-authoring predicate. The persisted-artifact gate scans
 * the complete checklist.json, so writer admission must cover nested values
 * too (for example relatedDocs, excludes, files, and verificationIntent prose)
 * instead of maintaining a smaller hand-written field list.
 *
 * Runtime identity and lifecycle fields are deliberately absent: callers pass
 * only the author-controlled subset they are about to persist.
 */
export function checklistEnglishAuthoringFields(
  item: unknown,
  itemRef: string,
): EnglishAuthoringTextSource[] {
  const fields: EnglishAuthoringTextSource[] = [];

  const visit = (value: unknown, field: string): void => {
    // Captured program output (e.g. verificationEvidence[].outputTail) is not prose.
    const key = field.slice(field.lastIndexOf('.') + 1);
    if (isCapturedOutputFieldKey(key)) return;
    if (typeof value === 'string') {
      fields.push({ field, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${field}[${index + 1}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      visit(entry, `${field}.${key}`);
    }
  };

  if (!item || typeof item !== 'object') return fields;
  const authored = item as Record<string, unknown>;
  for (const key of [
    'title',
    'context',
    'relatedDocs',
    'userSees',
    'excludes',
    'files',
    'verificationIntent',
    'verificationEvidence',
    'reason',
  ]) {
    visit(authored[key], `${itemRef}.${key}`);
  }
  return fields;
}

// Field / record separators are emitted BY git via %x1f (Unit Separator) and
// %x1e (Record Separator) inside the --pretty format string. The argv we pass
// holds the ASCII escape spec ("%x1f"/"%x1e"), not raw control bytes, so
// execFileSync (which rejects NUL bytes in argv) accepts it. These control
// characters never occur in commit messages, so the record/field split is
// unambiguous even when a body contains spaces or newlines.
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

/** Default git log reader: subjects + bodies for commits on this branch only. */
const defaultGitLogReader: GitLogReader = (cwd) => {
  // %H full hash, %B raw subject+body. The resolved integration range is branch-scoped.
  return execFileSync(
    'git',
    ['log', `${requireRepositoryBaselineRef(cwd)}..HEAD`, '--pretty=format:%H%x1f%B%x1e'],
    { cwd, encoding: 'utf-8' },
  );
};

const defaultFileReader: FileReader = (absPath) => {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
};

/** Truncate a preview to keep gate output legible. */
function previewOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

const codepointLabel = (codepoint: number): string => `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;

/** Scan one text blob, appending any CJK violations under the given source. */
function scanText(source: string, text: string, out: EnglishArtifactViolation[], keepLine: (line: string) => boolean = () => true): void {
  const result = detectCjk(text);
  if (!result.found) return;
  const lines = text.split('\n');
  // Report at most one violation per offending line to avoid flooding output.
  const byLine = new Map<number, string[]>();
  for (const m of result.matches) {
    const codepoints = byLine.get(m.line) ?? [];
    const label = codepointLabel(m.codepoint);
    if (!codepoints.includes(label)) codepoints.push(label);
    byLine.set(m.line, codepoints);
  }
  for (const [line, codepoints] of byLine) {
    const text = lines[line - 1] ?? '';
    if (!keepLine(text)) continue;
    out.push({ source, line, preview: previewOf(text), codepoints: codepoints.slice(0, 6) });
  }
}

/**
 * Scan a JSON metadata file, skipping captured program output. The authored
 * CJK strings are collected from the parsed tree (every string leaf and key
 * outside CAPTURED_OUTPUT_FIELD_KEYS subtrees); the raw text is then scanned
 * and only lines holding one of them are reported, so line numbers stay exact
 * for pretty-printed files and a compact one-line file still reports line 1.
 * Unparseable JSON falls back to the plain text scan (fail closed).
 */
function scanJsonArtifact(source: string, text: string, out: EnglishArtifactViolation[]): void {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { scanText(source, text, out); return; }
  const authored: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { if (detectCjk(value).found) authored.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isCapturedOutputFieldKey(key)) continue;
      if (detectCjk(key).found) authored.push(key);
      visit(entry);
    }
  };
  visit(parsed);
  if (authored.length === 0) return;
  // The raw form of each authored string as JSON.stringify writes it.
  const needles = [...new Set(authored)].map(value => JSON.stringify(value).slice(1, -1));
  const before = out.length;
  // A pretty-printed captured-output property line is never reported, even when it
  // happens to contain the same characters as an authored string.
  const capturedLine = new RegExp(`^\\s*"(?:${CAPTURED_OUTPUT_FIELD_KEYS.join('|')})"\\s*:`);
  scanText(source, text, out, line => !capturedLine.test(line) && needles.some(needle => line.includes(needle)));
  if (out.length === before) {
    // Written in another escaping style: report the authored value itself.
    scanText(source, authored[0]!, out);
    out.splice(before + 1);
  }
}

/**
 * Parse `git log --pretty=format:%H<US>%B<RS>` output into { sha, message } pairs.
 * Records are RS-delimited; within a record the hash and the body are FS-delimited.
 */
function parseCommitRecords(raw: string): Array<{ sha: string; message: string }> {
  const records: Array<{ sha: string; message: string }> = [];
  for (const rec of raw.split(RECORD_SEP)) {
    const sepIdx = rec.indexOf(FIELD_SEP);
    if (sepIdx === -1) continue; // trailing empty chunk / malformed record
    const sha = rec.slice(0, sepIdx).trim();
    const message = rec.slice(sepIdx + 1);
    if (sha.length === 0) continue;
    records.push({ sha, message });
  }
  return records;
}

/**
 * Run the diff/story-scoped CJK gate. Pure-ish: all I/O goes through injectable
 * readers; detection is the pure core detector.
 */
export function runEnglishArtifactGate(
  deps: EnglishArtifactGateDeps,
): EnglishArtifactGateResult {
  const violations: EnglishArtifactViolation[] = [];
  const notes: string[] = [];

  // ── 1) Commit subjects + bodies (branch-scoped) ──
  const gitLogReader = deps.gitLogReader ?? defaultGitLogReader;
  try {
    const raw = gitLogReader(deps.gitCwd);
    for (const { sha, message } of parseCommitRecords(raw)) {
      scanText(`commit ${sha.slice(0, 7)}`, message, violations);
    }
  } catch (e) {
    // Never block on a git failure (detached HEAD, no `main`, git absent, ...).
    notes.push(
      `git log <integration>..HEAD unavailable (commit scan skipped): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // ── 2) Current-story author-controlled metadata files only ──
  const readFile = deps.readFile ?? defaultFileReader;
  if (!existsSync(deps.storyDir)) {
    notes.push(`story dir not found (metadata scan skipped): ${deps.storyDir}`);
  } else {
    for (const basename of AUTHOR_METADATA_BASENAMES) {
      // Defense-in-depth: never scan a runtime/framework file even if a future
      // basename overlap is introduced.
      if (RUNTIME_EXCLUDE_BASENAMES.includes(basename)) continue;
      const abs = join(deps.storyDir, basename);
      const content = readFile(abs);
      if (content === null) continue; // absent file is fine (e.g. no summary yet)
      if (basename.endsWith('.json')) scanJsonArtifact(basename, content, violations);
      else scanText(basename, content, violations);
    }
  }

  return { ok: violations.length === 0, violations, notes };
}

/** The framework command that rewrites the authored text a gate violation names. */
const ARTIFACT_REWRITE_COMMAND: Readonly<Record<string, string>> = {
  'checklist.json': 'proof-or-stop checklist_update (the item field quoted above)',
  'summary.json': 'proof-or-stop summary_set',
  'background.md': 'proof-or-stop background_set',
  'decision.json': 'proof-or-stop decision_set',
  'understanding.json': 'proof-or-stop understanding_set',
  'index.json': 'proof-or-stop story_update (title/description)',
  'plan.md': 'a plan.md edit committed as Story metadata',
};

/**
 * The concrete fix for one gate violation: the framework command that rewrites
 * the authored text, how to keep a needed non-English data literal (by code
 * point), and that source or tests are never edited for this gate.
 */
export function englishArtifactFixAction(violation: Pick<EnglishArtifactViolation, 'source' | 'codepoints'>): string {
  const rewrite = violation.source.startsWith('commit ')
    ? 'reword that Story-branch commit message'
    : `rewrite it with ${ARTIFACT_REWRITE_COMMAND[violation.source] ?? 'the command that authored it'}`;
  const literal = violation.codepoints?.length
    ? `; quote a required non-English data literal by code point (${violation.codepoints.join(' ')})`
    : '';
  return `Fix: ${rewrite}${literal}. Never edit source or tests to satisfy this gate; captured program output is exempt.`;
}

/** Build a single English failure message naming each offending artifact + line and its fix. */
export function renderEnglishArtifactViolations(
  violations: readonly EnglishArtifactViolation[],
): string[] {
  return violations.map(
    (v) => `${v.source}:${v.line}: non-English (CJK) text -> ${v.preview} ${englishArtifactFixAction(v)}`,
  );
}

/**
 * Shared authoring/gate predicate for the English-only CJK policy — a thin
 * wrapper over the single source of truth core/cjk-detect.ts `detectCjk`. The
 * REVIEW->TEST gate's scanText() and the authoring-time refusal below both flow
 * through detectCjk, so an authoring rejection is exactly what the later gate
 * would have flagged (the smoke asserts this agreement). Never add a second CJK
 * regex — reuse this / detectCjk.
 */
export function containsCJK(text: string): boolean {
  return typeof text === 'string' && detectCjk(text).found;
}

/**
 * Find the FIRST CJK violation across an ordered list of author-provided text
 * fields (authoring time, before any artifact is written). Returns null when
 * every field is English. Detection is delegated to scanText -> detectCjk so it
 * never diverges from the persisted-artifact gate. Non-string / empty fields are
 * skipped (a missing optional field is not a violation).
 */
export function findFirstEnglishAuthoringViolation(
  fields: readonly EnglishAuthoringTextSource[],
): EnglishArtifactViolation | null {
  for (const field of fields) {
    if (typeof field.text !== 'string' || field.text.length === 0) continue;
    const hits: EnglishArtifactViolation[] = [];
    scanText(field.field, field.text, hits);
    const hit = hits[0];
    if (!hit) continue;
    return {
      ...hit,
      source: field.fieldForLine ? field.fieldForLine(hit.line) : hit.source,
    };
  }
  return null;
}

/** Render the single-line authoring refusal message for a detected violation. */
export function renderEnglishAuthoringRefusal(
  commandName: string,
  violation: EnglishArtifactViolation,
): string {
  const located = `${violation.source}:${violation.line}: non-English (CJK) text -> ${violation.preview}`;
  const literal = violation.codepoints?.length
    ? ` Quote a required non-English data literal by code point (${violation.codepoints.join(' ')}) instead of the character.`
    : '';
  return (
    `${commandName} refuses: ${located}. ` +
    `Story artifacts must be English. Found: ${violation.preview}. ` +
    `Rerun ${commandName} with this field in English.${literal} Never edit source or tests for this rule. ` +
    `[english_artifact_cjk_authoring]`
  );
}

/**
 * Throw a clear English refusal if any author-provided field carries CJK,
 * BEFORE the caller persists the artifact. No-op when every field is English.
 * Scans only the author-controlled text it is handed (background / checklist
 * text / title / description) — never code or runtime files.
 */
export function assertEnglishAuthoringText(
  commandName: string,
  fields: readonly EnglishAuthoringTextSource[],
): void {
  const violation = findFirstEnglishAuthoringViolation(fields);
  if (!violation) return;
  throw new Error(renderEnglishAuthoringRefusal(commandName, violation));
}
