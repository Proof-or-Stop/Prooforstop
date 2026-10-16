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
 * Old-PoS runs 36/37 (bench-staging/oldpos/run37-a2-analysis.md §5): a
 * `doc-code-drift:` finding cites the documentation lines that are wrong AND
 * the code that contradicts them (`docs/a.md:43 ... but src/x.go:1654 ...`).
 * Counting the code anchor as a defect site made the disposition unreachable:
 * the code file is in the scope contract (so "in scope") and Story-changed (so
 * "not unchanged"). For a doc-code-drift finding with at least one
 * documentation anchor (findingSites):
 *   - defect sites = the documentation anchors (base presence + scope as above);
 *   - code anchors are evidence: each must ALSO be outside every Story hunk and
 *     byte-identical at the base, so the code contradicted the doc already at
 *     the base. A code anchor inside a Story hunk is not proof of a
 *     pre-existing drift (the Story may have changed the behaviour the doc
 *     describes), so the finding stays the Story's to repair;
 *   - every cited documentation file must be unchanged base..HEAD as a whole:
 *     a drift in a doc this Story edits (run 37 F-003: the repair of one doc
 *     line left the next sentence contradicting it) is the Story's own.
 * Any other finding keeps every anchor as a defect site.
 *
 * Lab run110 (bench-staging/oldpos/run110-analysis.md §4 gap 2): three eligibility gaps kept a pre-existing,
 * out-of-scope drift in repair for six rounds:
 *   - a leading `[regression-of F-x]` (or any `[...]`) tag hid the `doc-code-drift:` prefix, so the code anchor
 *     became a defect site (the file is in the contract: "in scope"): leading tags are stripped first;
 *   - a code anchor inside a Story hunk (the Story rewrote the range loop but kept its exclusive end) failed the
 *     line-identity proxy. The evidence is now judged by BASE BEHAVIOUR: `baseBehaviour` (the store-aware caller runs
 *     the finding's own repro on the Story base and on HEAD with the project's declared probe runner) answering
 *     `same` makes it base evidence, `changed` makes the drift the Story's own; with no verdict the line rule stays.
 *     EXPERIMENTAL `review.driftBaseSymbol` (`symbolFallback`): every cited line found (trimmed) in the base source of
 *     the same enclosing symbol also counts (default off: it can close a drift the Story caused elsewhere in the
 *     symbol);
 *   - the Story's own edit of a cited doc made every later drift "the Story's own", so run 110's repair edit (itself a
 *     scope violation, later reverted) poisoned the path. An edit of a doc the scope contract EXCLUDES (`excluded`) no
 *     longer counts: the gate refuses it, it is not the Story's delivered documentation. An admitted doc edit still
 *     does (run 37 F-003).
 *   - findingScopeCoverage: a path the contract excludes (explicitExcludes / protectedFiles) is never "in scope"
 *     because the request or the boundary mentions it.
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

/** Leading `[...]` tags (`[regression-of F-005]`, `[dimension:docs]`, ...) a lane or the framework puts before a description. */
export function stripLeadingTags(desc: string): string {
  return desc.replace(/^\s*(?:\[[^\]\n]*\]\s*)+/, '');
}

/** A `doc-code-drift:` finding (the docs lane's prefix after any leading `[...]` tags, or the legacy category of that name). */
export function isDocCodeDriftFinding(finding: { desc?: string; category?: string }): boolean {
  return /^\s*doc-code-drift\b/i.test(stripLeadingTags(finding.desc ?? '')) || finding.category === 'doc-code-drift';
}

export interface FindingSites {
  /** Lines the finding says are wrong (base presence and scope are judged on these). */
  defects: FindingAnchor[];
  /** Lines cited as the contrast (doc-code-drift code anchors); never defect sites. */
  evidence: FindingAnchor[];
}

/**
 * Defect sites vs evidence (old-PoS runs 36/37): for a doc-code-drift finding
 * with a documentation anchor, only documentation anchors are defect sites and
 * code anchors are evidence; otherwise every anchor is a defect site.
 */
export function findingSites(finding: { desc?: string; files?: readonly string[]; category?: string }): FindingSites {
  const anchors = findingDefectAnchors(finding);
  if (!isDocCodeDriftFinding(finding)) return { defects: anchors, evidence: [] };
  const docs = anchors.filter(anchor => isDocumentation(anchor.path));
  if (docs.length === 0) return { defects: anchors, evidence: [] };
  return { defects: docs, evidence: anchors.filter(anchor => !isDocumentation(anchor.path)) };
}

export interface AnchorPresence extends FindingAnchor { baseLine: number | null; unchanged: boolean; detail: string }

export interface FindingBasePresence {
  schemaVersion: 1;
  base: string;
  head: string;
  preExisting: boolean;
  reason: string;
  anchors: AnchorPresence[];
  /** Doc-code-drift code anchors (evidence, not defect sites), each checked unchanged at the base. */
  evidence: AnchorPresence[];
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
export interface BaseBehaviourVerdict { verdict: 'same' | 'changed' | 'unknown'; detail: string }

export function assessFindingBasePresence(args: { gitCwd: string; base: string; head: string;
  finding: { desc?: string; files?: readonly string[]; category?: string };
  /** Lab run110: the scope contract excludes this path (an edit of it is a refused scope violation, not the Story's doc). */
  excluded?: (path: string) => boolean;
  /** Lab run110: the finding's repro on the Story base vs HEAD (store-aware caller, project probe runner); consulted lazily. */
  baseBehaviour?: () => BaseBehaviourVerdict;
  /** Lab run110 EXPERIMENTAL review.driftBaseSymbol: cited code lines found in the base source of the same symbol count. */
  symbolFallback?: boolean }): FindingBasePresence {
  const { gitCwd, base, head } = args;
  const { defects: anchors, evidence } = findingSites(args.finding);
  const result = (preExisting: boolean, reason: string, rows: AnchorPresence[], evidenceRows: AnchorPresence[] = [], referencedChangedFiles: string[] = []): FindingBasePresence =>
    ({ schemaVersion: 1, base, head, preExisting, reason, anchors: rows, evidence: evidenceRows, referencedChangedFiles });
  if (anchors.length === 0) return result(false, 'the finding cites no path:line defect site', []);
  const files = new Map<string, { hunks: Hunk[]; baseLines: string[]; headLines: string[] } | string>();
  const presenceOf = (anchor: FindingAnchor): AnchorPresence => {
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
    if (typeof file === 'string') return { ...anchor, baseLine: null, unchanged: false, detail: file };
    const touched = file.hunks.find(hunk => hunk.newCount > 0
      ? hunk.newStart <= anchor.endLine && hunk.newStart + hunk.newCount - 1 >= anchor.line
      : anchor.line <= hunk.newStart && hunk.newStart < anchor.endLine);
    if (touched) return { ...anchor, baseLine: null, unchanged: false, detail: `the Story changed ${anchor.path} at line ${touched.newStart}` };
    const before = file.hunks.filter(hunk => (hunk.newCount > 0 ? hunk.newStart + hunk.newCount - 1 : hunk.newStart) < anchor.line);
    const baseLine = anchor.line - before.reduce((sum, hunk) => sum + hunk.newCount - hunk.oldCount, 0);
    const span = anchor.endLine - anchor.line;
    const headText = file.headLines.slice(anchor.line - 1, anchor.endLine);
    const baseText = file.baseLines.slice(baseLine - 1, baseLine + span);
    const same = headText.length === span + 1 && baseText.length === span + 1 && headText.every((text, index) => text === baseText[index]);
    return { ...anchor, baseLine, unchanged: same,
      detail: same ? `${anchor.path}:${anchor.line}${span ? `-${anchor.endLine}` : ''} is byte-identical at base line ${baseLine}` : `${anchor.path}:${anchor.line} differs from the base` };
  };
  const rows = anchors.map(presenceOf);
  const evidenceRows = evidence.map(presenceOf);
  const anchored = new Set([...anchors, ...evidence].map(anchor => anchor.path));
  const unanchored = [...new Set((args.finding.files ?? []).map(normalizeScopePath))].filter(path => !anchored.has(path));
  let referencedChangedFiles: string[] = [];
  if (unanchored.length) {
    try {
      referencedChangedFiles = gitText(gitCwd, ['diff', '--name-only', '--no-renames', base, 'HEAD', '--', ...unanchored]).split('\n').map(row => row.trim()).filter(Boolean);
    } catch { referencedChangedFiles = unanchored; }
  }
  const failed = rows.find(row => !row.unchanged);
  if (failed) return result(false, failed.detail, rows, evidenceRows, referencedChangedFiles);
  // Old-PoS runs 36/37: a doc-code-drift is pre-existing only when its code evidence
  // contradicted the doc at the base too, and the Story edits none of the cited docs.
  const changedEvidence = evidenceRows.find(row => !row.unchanged);
  let behaviourNote = '';
  if (changedEvidence) {
    // Lab run110: line identity is only a proxy for "the code behaved this way at the base". Base behaviour decides.
    const behaviour = args.baseBehaviour?.() ?? { verdict: 'unknown' as const, detail: 'no base probe' };
    if (behaviour.verdict === 'changed') {
      return result(false, `the contrasted code's behaviour differs between the Story base and HEAD (${behaviour.detail}), so the drift comes from this Story's change`, rows, evidenceRows, referencedChangedFiles);
    }
    const symbols = behaviour.verdict === 'same' || !args.symbolFallback ? null
      : evidenceRows.filter(row => !row.unchanged).map(row => baseSymbolCarries(gitCwd, base, head, row));
    if (behaviour.verdict === 'same') {
      behaviourNote = `; the contrasted code (${evidenceRows.filter(row => !row.unchanged).map(row => `${row.path}:${row.line}`).join(', ')}) lies in a Story hunk, but a base probe shows the same behaviour at the base and HEAD (${behaviour.detail})`;
    } else if (symbols && symbols.every(row => row.carried)) {
      behaviourNote = `; the contrasted code lies in a Story hunk, but every cited line is in the base source of the same symbol (${symbols.map(row => row.detail).join('; ')}) [review.driftBaseSymbol]`;
    } else {
      return result(false, `the contrasted code is not unchanged at the base (${changedEvidence.detail}${symbols ? `; ${symbols.find(row => !row.carried)?.detail}` : ''}), so the drift may come from this Story's change`, rows, evidenceRows, referencedChangedFiles);
    }
  }
  if (evidence.length > 0 || isDocCodeDriftFinding(args.finding)) {
    const docs = [...new Set([...anchors.map(anchor => anchor.path), ...unanchored.filter(isDocumentation)])].filter(isDocumentation)
      // Lab run110: an edit of a doc the contract excludes is a refused scope violation, not the Story's documentation.
      .filter(path => !args.excluded?.(path));
    let editedDoc: string | undefined;
    try { editedDoc = docs.find(path => !gitOk(gitCwd, ['diff', '--quiet', '--no-ext-diff', base, 'HEAD', '--', path])); } catch { editedDoc = docs[0]; }
    if (editedDoc) return result(false, `the Story changed ${editedDoc} (base..HEAD); a drift in a documentation file this Story edits is the Story's own`, rows, evidenceRows, referencedChangedFiles);
  }
  const cited = (list: AnchorPresence[]) => list.map(row => `${row.path}:${row.line}${row.endLine > row.line ? `-${row.endLine}` : ''}`).join(', ');
  return result(true, `every cited defect line (${cited(rows)}) is unchanged ${base.slice(0, 12)}..${head.slice(0, 12)} and byte-identical at the Story base`
    + (behaviourNote || (evidenceRows.length ? `; the contrasted code (${cited(evidenceRows)}) is unchanged and byte-identical at the base too, so the drift predates the Story` : '')), rows, evidenceRows, referencedChangedFiles);
}

const SYMBOL_DECL = /^\s*(?:func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]|def\s+([A-Za-z_]\w*)\s*\(|(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)|class\s+([A-Za-z_]\w*))/;
const symbolName = (line: string): string | null => { const match = SYMBOL_DECL.exec(line); return match ? (match.slice(1).find(Boolean) ?? null) : null; };

/**
 * EXPERIMENTAL lab run110 review.driftBaseSymbol: whether every cited head line of `anchor` (trimmed, blank and
 * brace-only lines aside) appears in the base source of the same enclosing symbol (found by name).
 */
function baseSymbolCarries(gitCwd: string, base: string, head: string, anchor: FindingAnchor): { carried: boolean; detail: string } {
  let headLines: string[]; let baseLines: string[];
  try {
    headLines = gitText(gitCwd, ['show', `${head}:${anchor.path}`]).split('\n');
    baseLines = gitText(gitCwd, ['show', `${base}:${anchor.path}`]).split('\n');
  } catch { return { carried: false, detail: `${anchor.path} is not readable at the base and the reviewed head` }; }
  let name: string | null = null;
  for (let index = Math.min(anchor.line, headLines.length) - 1; index >= 0 && !name; index -= 1) name = symbolName(headLines[index]!);
  if (!name) return { carried: false, detail: `${anchor.path}:${anchor.line} has no enclosing symbol` };
  const start = baseLines.findIndex(line => symbolName(line) === name);
  if (start < 0) return { carried: false, detail: `${name} does not exist at the base` };
  let end = baseLines.length;
  for (let index = start + 1; index < baseLines.length; index += 1) if (symbolName(baseLines[index]!) && !/^\s/.test(baseLines[index]!)) { end = index; break; }
  const body = new Set(baseLines.slice(start, end).map(line => line.trim()));
  const cited = headLines.slice(anchor.line - 1, anchor.endLine).map(line => line.trim()).filter(line => line && !/^[{}()[\];,]+$/.test(line));
  const missing = cited.find(line => !body.has(line));
  return missing === undefined && cited.length
    ? { carried: true, detail: `${anchor.path}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ''} in ${name} at the base` }
    : { carried: false, detail: `${anchor.path}:${anchor.line}: \`${(missing ?? '').slice(0, 80)}\` is not in the base source of ${name}` };
}

/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4; run 48 cycle C):
 * the defect sites of a PRE-EXISTING finding, keyed by path and Story-base
 * line (`docs/a.md#43`), one key per cited line. Keyed by the base line, two
 * filings of one site match even when they cite it on different heads in
 * other words. Empty for a finding that is not pre-existing.
 */
export function preexistingSiteKeys(presence: FindingBasePresence): string[] {
  if (!presence.preExisting) return [];
  const keys: string[] = [];
  for (const anchor of presence.anchors) {
    if (anchor.baseLine === null || !anchor.unchanged) return [];
    for (let offset = 0; offset <= anchor.endLine - anchor.line; offset += 1) {
      const key = `${anchor.path}#${anchor.baseLine + offset}`;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Old-PoS run 52: the resolve-reason prefix of a finding the framework closed
 * at import as a recurrence (handlers/finding-recurrence.ts). The reason is
 * part of the signed lifecycle transition (the Finding record itself carries
 * no extra field: the ledger mirror authenticates its exact shape).
 */
export const RECURRING_PREEXISTING_REASON_PREFIX = `[${PREEXISTING_OUT_OF_SCOPE}] Recurring pre-existing finding, closed by the framework at import (recurrence of `;

/** The dispositions a framework-closed recurrence names (empty for any other finding). */
export function recurringPreexistingOf(finding: { status?: string; resolutionType?: string; resolvedReason?: string }): string[] {
  if (finding.status !== 'resolved' || finding.resolutionType !== PREEXISTING_OUT_OF_SCOPE) return [];
  const reason = finding.resolvedReason ?? '';
  if (!reason.startsWith(RECURRING_PREEXISTING_REASON_PREFIX)) return [];
  const end = reason.indexOf(')', RECURRING_PREEXISTING_REASON_PREFIX.length);
  if (end < 0) return [];
  return reason.slice(RECURRING_PREEXISTING_REASON_PREFIX.length, end).split(',').map(id => id.trim()).filter(Boolean);
}

export interface RecurringPreexistingMatch {
  recurring: boolean;
  /** The dispositioned findings whose sites cover the candidate's (sorted). */
  of: string[];
  /** The candidate's defect sites as it cited them (`path:line`). */
  sites: string[];
  reason: string;
}

/**
 * Old-PoS run 52: is a new finding a RECURRENCE of an existing
 * `preexisting_out_of_scope` disposition? Only when the candidate is itself
 * pre-existing (every defect line outside every Story hunk and byte-identical
 * at the base, doc-code-drift evidence unchanged too; assessFindingBasePresence)
 * AND every one of its defect sites is a site of a disposition that still holds
 * (its own presence recomputed now). A site the Story edited, a site nobody
 * dispositioned (even in the same file), or a code line inside a Story hunk is
 * never a recurrence, so a real defect in Story-changed code is never closed
 * this way.
 */
export function recurringPreexistingSites(args: { candidate: FindingBasePresence;
  dispositioned: ReadonlyArray<{ findingId: string; presence: FindingBasePresence }> }): RecurringPreexistingMatch {
  const sites = args.candidate.anchors.map(anchor => `${anchor.path}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ''}`);
  const no = (reason: string): RecurringPreexistingMatch => ({ recurring: false, of: [], sites, reason });
  if (!args.candidate.preExisting) return no(`not pre-existing: ${args.candidate.reason}`);
  const owners = new Map<string, string[]>();
  for (const row of args.dispositioned) {
    for (const key of preexistingSiteKeys(row.presence)) owners.set(key, [...(owners.get(key) ?? []), row.findingId]);
  }
  if (owners.size === 0) return no('no pre-existing disposition holds on the current material');
  const uncovered = args.candidate.anchors.filter(anchor => {
    if (anchor.baseLine === null) return true;
    for (let offset = 0; offset <= anchor.endLine - anchor.line; offset += 1) if (!owners.has(`${anchor.path}#${anchor.baseLine + offset}`)) return true;
    return false;
  });
  if (uncovered.length) {
    return no(`site(s) ${uncovered.map(anchor => `${anchor.path}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ''}`).join(', ')} not dispositioned`);
  }
  const keys = preexistingSiteKeys(args.candidate);
  if (keys.length === 0) return no('the finding cites no pre-existing defect site');
  const of = [...new Set(keys.flatMap(key => owners.get(key) ?? []))].sort();
  return { recurring: true, of, sites, reason: `every defect site (${sites.join(', ')}) was already dispositioned by ${of.join(', ')} and is still unchanged at the Story base` };
}

export interface FindingScopeCoverage { inScope: boolean; reason: string }

const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc'];
/** An imperative asking for documentation work ("update the docs", "document X in the guide"); "as documented in docs/x.md" is not one. */
export const DOCS_WORK = /\b(?:update|document|write|add|extend|revise|correct|fix|rewrite)s?\b[^.\n]{0,80}\b(?:docs?|documentation|readme|guide)\b(?![/\w]|\.\w)/i;

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
  contract: { allowedModify?: readonly string[]; allowedCreate?: readonly string[]; allowedTest?: readonly string[]; explicitExcludes?: readonly string[]; protectedFiles?: readonly string[] } | null;
  itemFiles: readonly string[]; requestText: string | null; scopeAllowed: readonly string[] }): FindingScopeCoverage {
  const excludedBy = (path: string): string | undefined => [...(args.contract?.explicitExcludes ?? []), ...(args.contract?.protectedFiles ?? [])]
    .find(pattern => pathMatchesScopePattern(path, pattern));
  const excluded: string[] = [];
  for (const path of args.paths) {
    // Lab run110: a path the contract excludes is never in scope by a mention (its edit is refused by the gate).
    const excludePattern = excludedBy(path);
    if (excludePattern) { excluded.push(`${path} (${excludePattern})`); continue; }
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
  if (excluded.length === args.paths.length) return { inScope: false, reason: `the scope contract excludes ${excluded.join(', ')}` };
  return { inScope: false, reason: `no scope-contract path, checklist file, scope-boundary entry or request sentence covers ${args.paths.join(', ')}${excluded.length ? ` (the scope contract excludes ${excluded.join(', ')})` : ''}` };
}

/** The audited disposition text recorded in the signed resolve transition. */
export function preexistingDispositionReason(presence: FindingBasePresence, coverage: FindingScopeCoverage, followUp: string): string {
  const evidence = presence.evidence.length
    ? ` Code evidence (the contrast, not defect sites): ${presence.evidence.map(row => `${row.path}:${row.line}${row.endLine > row.line ? `-${row.endLine}` : ''} (base line ${row.baseLine})`).join(', ')}.` : '';
  const changed = presence.referencedChangedFiles.length
    ? ` Cited files the Story changed without a line anchor (not defect sites): ${presence.referencedChangedFiles.join(', ')}.` : '';
  return `[${PREEXISTING_OUT_OF_SCOPE}] Pre-existing at the Story base ${presence.base.slice(0, 12)} (reviewed head ${presence.head.slice(0, 12)}): ${presence.reason}.`
    + ` Outside this Story: ${coverage.reason}.${evidence}${changed} Severity unchanged. Follow-up: ${followUp.trim() || 'repair it in a separate Story.'}`;
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
