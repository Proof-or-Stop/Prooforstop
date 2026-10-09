/**
 * Old-PoS run 30 (B-c201:F-005): pre-existing findings outside the Story.
 *
 * The docs reviewer reported wrong range examples in a doc that was
 * byte-identical on main. Nothing in the request or the scope contract asked
 * for that doc, every repair run ended without a commit, next kept proposing
 * the same repair and the Story stopped in DEV with nothing merged.
 *
 * This module decides mechanically, from Git and the Story's own contract:
 *
 *   1. Base presence (assessFindingBasePresence): the defect sites a finding
 *      cites as `path:line` (or `path:a-b`, with `and :n` continuations) exist
 *      at the Story base and the Story never changed those lines: every cited
 *      line is outside every base..reviewed-head hunk, its text is identical at
 *      the base, and the file is unchanged since the reviewed head. A finding
 *      with no line anchor is never pre-existing here. Cited files the Story
 *      changed without a line anchor are listed in the evidence (audit), not
 *      treated as defect sites.
 *   2. Scope coverage (findingScopeCoverage): a cited defect file is covered by
 *      the Story when the scope contract lists it (modify/create/test), a
 *      checklist item declares it, the scope boundary or the verbatim request
 *      names it, or (for a documentation file) the request asks for
 *      documentation work. The documentation-default admission of the scope
 *      gate is a permission, not a request, so it does not count.
 *   3. Routing (findingRepairRoute): pre-existing + not covered -> one audited
 *      disposition (finding_resolve disposition=preexisting_out_of_scope); else
 *      repair; a repair run that ends without a commit is relaunched once with
 *      its report in the prompt, a second one routes to PLAN (replan), never to
 *      the same repair again.
 *
 * Reviewer severity is never changed; the disposition is a signed, named
 * resolve transition whose reason carries this evidence.
 */
import { execFileSync } from 'node:child_process';
import { normalizeScopePath, pathMatchesScopePattern } from './scope-path-classifier.js';

/** The finding_resolve disposition (and resolutionType) for a pre-existing finding outside the Story. */
export const PREEXISTING_OUT_OF_SCOPE = 'preexisting_out_of_scope';

/** Completed managed repair runs without a commit (since the last PLAN entry) before next replans. */
export const REPAIR_NO_COMMIT_REPLAN_AFTER = 2;

export interface FindingAnchor { path: string; line: number; endLine: number }

const PATH_LINE = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
const CONTINUATION = /^(?:\s*(?:,|and|&)\s*:(\d+)(?:-(\d+))?)/;

/**
 * The `path:line` defect sites a finding's description cites (the reviewer
 * convention), restricted to the finding's own files when it declares any.
 * `docs/a.md:43 and :52` yields two anchors on docs/a.md.
 */
export function findingDefectAnchors(finding: { desc?: string; files?: readonly string[] }): FindingAnchor[] {
  const text = finding.desc ?? '';
  const files = new Set((finding.files ?? []).map(normalizeScopePath));
  const anchors: FindingAnchor[] = [];
  const push = (path: string, start: string, end?: string) => {
    const line = Number(start);
    const endLine = end ? Number(end) : line;
    if (!Number.isInteger(line) || line < 1 || endLine < line) return;
    if (!anchors.some(row => row.path === path && row.line === line && row.endLine === endLine)) anchors.push({ path, line, endLine });
  };
  for (const match of text.matchAll(PATH_LINE)) {
    const path = normalizeScopePath(match[1]!);
    if (files.size > 0 && !files.has(path)) continue;
    push(path, match[2]!, match[3]);
    let rest = text.slice((match.index ?? 0) + match[0].length);
    for (let next = CONTINUATION.exec(rest); next; next = CONTINUATION.exec(rest)) {
      push(path, next[1]!, next[2]);
      rest = rest.slice(next[0].length);
    }
  }
  return anchors;
}

export interface AnchorPresence extends FindingAnchor { baseLine: number | null; unchanged: boolean; detail: string }

export interface FindingBasePresence {
  schemaVersion: 1;
  base: string;
  head: string;
  preExisting: boolean;
  reason: string;
  anchors: AnchorPresence[];
  /** Cited files the Story changed (base..HEAD) that carry no line anchor: listed for the audit, not defect sites. */
  referencedChangedFiles: string[];
}

/** Git reads use an argv array (no shell). */
function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitOk(cwd: string, args: string[]): boolean {
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }

function diffHunks(cwd: string, base: string, head: string, path: string): Hunk[] {
  const out = gitText(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, head, '--', path]);
  const hunks: Hunk[] = [];
  for (const match of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]) });
  }
  return hunks;
}

/**
 * Whether every cited defect line already existed, unchanged, at the Story
 * base. `head` is the head the reviewer cited lines against (the finding's
 * reviewed head when it is an ancestor of HEAD, else HEAD); the cited files
 * must also be unchanged from it to HEAD.
 */
export function assessFindingBasePresence(args: { gitCwd: string; base: string; head: string;
  finding: { desc?: string; files?: readonly string[] } }): FindingBasePresence {
  const { gitCwd, base, head } = args;
  const anchors = findingDefectAnchors(args.finding);
  const result = (preExisting: boolean, reason: string, rows: AnchorPresence[], referencedChangedFiles: string[] = []): FindingBasePresence =>
    ({ schemaVersion: 1, base, head, preExisting, reason, anchors: rows, referencedChangedFiles });
  if (anchors.length === 0) return result(false, 'the finding cites no path:line defect site', []);
  const rows: AnchorPresence[] = [];
  const files = new Map<string, { hunks: Hunk[]; baseLines: string[]; headLines: string[] } | string>();
  for (const anchor of anchors) {
    let file = files.get(anchor.path);
    if (file === undefined) {
      try {
        if (!gitOk(gitCwd, ['cat-file', '-e', `${base}:${anchor.path}`])) file = `${anchor.path} does not exist at the Story base`;
        else if (!gitOk(gitCwd, ['diff', '--quiet', '--no-ext-diff', head, 'HEAD', '--', anchor.path])) file = `${anchor.path} changed after the reviewed head`;
        else {
          file = { hunks: diffHunks(gitCwd, base, head, anchor.path),
            baseLines: gitText(gitCwd, ['show', `${base}:${anchor.path}`]).split('\n'),
            headLines: gitText(gitCwd, ['show', `${head}:${anchor.path}`]).split('\n') };
        }
      } catch (error) {
        file = `${anchor.path} could not be read (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
      }
      files.set(anchor.path, file);
    }
    if (typeof file === 'string') { rows.push({ ...anchor, baseLine: null, unchanged: false, detail: file }); continue; }
    const touched = file.hunks.find(hunk => hunk.newCount > 0
      ? hunk.newStart <= anchor.endLine && hunk.newStart + hunk.newCount - 1 >= anchor.line
      : anchor.line <= hunk.newStart && hunk.newStart < anchor.endLine);
    if (touched) { rows.push({ ...anchor, baseLine: null, unchanged: false, detail: `the Story changed ${anchor.path} at line ${touched.newStart}` }); continue; }
    const before = file.hunks.filter(hunk => (hunk.newCount > 0 ? hunk.newStart + hunk.newCount - 1 : hunk.newStart) < anchor.line);
    const baseLine = anchor.line - before.reduce((sum, hunk) => sum + hunk.newCount - hunk.oldCount, 0);
    const span = anchor.endLine - anchor.line;
    const headText = file.headLines.slice(anchor.line - 1, anchor.endLine);
    const baseText = file.baseLines.slice(baseLine - 1, baseLine + span);
    const same = headText.length === span + 1 && baseText.length === span + 1 && headText.every((text, index) => text === baseText[index]);
    rows.push({ ...anchor, baseLine, unchanged: same,
      detail: same ? `${anchor.path}:${anchor.line}${span ? `-${anchor.endLine}` : ''} is byte-identical at base line ${baseLine}` : `${anchor.path}:${anchor.line} differs from the base` });
  }
  const anchored = new Set(anchors.map(anchor => anchor.path));
  const unanchored = [...new Set((args.finding.files ?? []).map(normalizeScopePath))].filter(path => !anchored.has(path));
  let referencedChangedFiles: string[] = [];
  if (unanchored.length) {
    try {
      referencedChangedFiles = gitText(gitCwd, ['diff', '--name-only', '--no-renames', base, 'HEAD', '--', ...unanchored]).split('\n').map(row => row.trim()).filter(Boolean);
    } catch { referencedChangedFiles = unanchored; }
  }
  const failed = rows.find(row => !row.unchanged);
  return failed
    ? result(false, failed.detail, rows, referencedChangedFiles)
    : result(true, `every cited defect line (${rows.map(row => `${row.path}:${row.line}${row.endLine > row.line ? `-${row.endLine}` : ''}`).join(', ')}) is unchanged ${base.slice(0, 12)}..${head.slice(0, 12)} and byte-identical at the Story base`, rows, referencedChangedFiles);
}

export interface FindingScopeCoverage { inScope: boolean; reason: string }

const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc'];
/** An imperative asking for documentation work ("update the docs", "document X in the guide"); "as documented in docs/x.md" is not one. */
const DOCS_WORK = /\b(?:update|document|write|add|extend|revise|correct|fix|rewrite)s?\b[^.\n]{0,80}\b(?:docs?|documentation|readme|guide)\b(?![/\w]|\.\w)/i;

const isDocumentation = (path: string): boolean => DOCUMENTATION_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension));
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, path: string): boolean => {
  const lower = text.toLowerCase();
  const base = path.split('/').pop()!.toLowerCase();
  return lower.includes(path.toLowerCase()) || new RegExp(`(?<![\\w.-])${escapeRegExp(base)}(?![\\w-])`).test(lower);
};

/**
 * Whether the Story's own request or scope covers ANY of the cited defect
 * files (then the finding is the Story's to repair, as before).
 */
export function findingScopeCoverage(args: { paths: readonly string[];
  contract: { allowedModify?: readonly string[]; allowedCreate?: readonly string[]; allowedTest?: readonly string[] } | null;
  itemFiles: readonly string[]; requestText: string | null; scopeAllowed: readonly string[] }): FindingScopeCoverage {
  for (const path of args.paths) {
    const pattern = [...(args.contract?.allowedModify ?? []), ...(args.contract?.allowedCreate ?? []), ...(args.contract?.allowedTest ?? [])]
      .find(row => pathMatchesScopePattern(path, row));
    if (pattern) return { inScope: true, reason: `the scope contract lists ${path} (${pattern})` };
    if (args.itemFiles.map(normalizeScopePath).includes(path)) return { inScope: true, reason: `a checklist item declares ${path}` };
    if (args.requestText && mentions(args.requestText, path)) return { inScope: true, reason: `the request names ${path}` };
    const boundary = args.scopeAllowed.find(row => mentions(row, path));
    if (boundary) return { inScope: true, reason: `the scope boundary names ${path} ("${boundary}")` };
    if (args.requestText && isDocumentation(path)) {
      const sentence = args.requestText.match(DOCS_WORK)?.[0];
      if (sentence) return { inScope: true, reason: `the request asks for documentation work ("${sentence.trim()}")` };
    }
  }
  return { inScope: false, reason: `no scope-contract path, checklist file, scope-boundary entry or request sentence covers ${args.paths.join(', ')}` };
}

/** The audited disposition text recorded in the signed resolve transition. */
export function preexistingDispositionReason(presence: FindingBasePresence, coverage: FindingScopeCoverage, followUp: string): string {
  const changed = presence.referencedChangedFiles.length
    ? ` Cited files the Story changed without a line anchor (not defect sites): ${presence.referencedChangedFiles.join(', ')}.` : '';
  return `[${PREEXISTING_OUT_OF_SCOPE}] Pre-existing at the Story base ${presence.base.slice(0, 12)} (reviewed head ${presence.head.slice(0, 12)}): ${presence.reason}.`
    + ` Outside this Story: ${coverage.reason}.${changed} Severity unchanged. Follow-up: ${followUp.trim() || 'repair it in a separate Story.'}`;
}

/** What next does with one open verified blocking finding (pure; the caller supplies the facts). */
export type FindingRepairRoute =
  | { kind: 'disposition' }
  | { kind: 'repair'; relaunch: boolean }
  | { kind: 'replan' };

export function findingRepairRoute(args: { preexistingOutOfScope: boolean; noCommitRunsSincePlan: number }): FindingRepairRoute {
  if (args.preexistingOutOfScope) return { kind: 'disposition' };
  if (args.noCommitRunsSincePlan >= REPAIR_NO_COMMIT_REPLAN_AFTER) return { kind: 'replan' };
  return { kind: 'repair', relaunch: args.noCommitRunsSincePlan > 0 };
}
