/**
 * english-artifact-gate — diff/story-scoped CJK gate for the English-only policy (B-5f42).
 *
 * Scope is intentionally NARROW and forward-looking (the repository is full of
 * legacy Chinese; the policy does NOT translate retroactively):
 *
 *   1) Commit subjects + bodies on this branch only: `git log main..HEAD`.
 *   2) The CURRENT story's AUTHOR-CONTROLLED metadata files only, resolved from
 *      .lattice/story/actives/<storyId>/ (or whatever storyDir the store uses):
 *        background.md, index.json, checklist.json, decision.json,
 *        understanding.json, plan.md, summary.json.
 *
 * It NEVER scans:
 *   - outside the current story dir (other stories' legacy Chinese is untouched),
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

export interface EnglishArtifactViolation {
  /** Where the CJK was found: "commit <sha7>" or a story-relative file path. */
  source: string;
  /** 1-based line number within the source. */
  line: number;
  /** A short English-safe preview of the offending line. */
  preview: string;
}

export interface EnglishArtifactGateResult {
  ok: boolean;
  violations: EnglishArtifactViolation[];
  /** Non-blocking diagnostics (e.g. git unavailable, story dir missing). */
  notes: string[];
}

/** Injectable git log reader. Returns the raw `git log main..HEAD` text. */
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
  // %H full hash, %B raw subject+body. `git log main..HEAD` is branch-scoped.
  return execFileSync(
    'git',
    ['log', 'main..HEAD', '--pretty=format:%H%x1f%B%x1e'],
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

/** Scan one text blob, appending any CJK violations under the given source. */
function scanText(source: string, text: string, out: EnglishArtifactViolation[]): void {
  const result = detectCjk(text);
  if (!result.found) return;
  const lines = text.split('\n');
  // Report at most one violation per offending line to avoid flooding output.
  const reportedLines = new Set<number>();
  for (const m of result.matches) {
    if (reportedLines.has(m.line)) continue;
    reportedLines.add(m.line);
    out.push({
      source,
      line: m.line,
      preview: previewOf(lines[m.line - 1] ?? ''),
    });
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
      `git log main..HEAD unavailable (commit scan skipped): ${
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
      scanText(basename, content, violations);
    }
  }

  return { ok: violations.length === 0, violations, notes };
}

/** Build a single English failure message naming each offending artifact + line. */
export function renderEnglishArtifactViolations(
  violations: readonly EnglishArtifactViolation[],
): string[] {
  return violations.map(
    (v) => `${v.source}:${v.line}: non-English (CJK) text -> ${v.preview}`,
  );
}
