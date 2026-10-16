/**
 * Lab run110 (bench-staging/oldpos/run110-analysis.md §4 gap 3, §6 fix 4): a FILE-STATE conflict between findings.
 *
 * Run 110: the docs lane required docs/src/docs/types/{array,string}.md to change (doc-code drift), the concept / test /
 * quality lanes required the same files unchanged (the scope boundary excluded "changes to docs"), and a repair turned
 * "unchanged" into a test that sha256-pinned the docs. Every repair satisfied one side and re-created the other: six
 * review rounds, two `finding_conflict_pin` PLAN visits (the behavioural pin machinery, core/resolved-finding-guard.ts
 * findingConflictOf, has no case to pin for a file state) and core/plan-remedy-cycle.ts (PLAN remedies) never fired.
 *
 * fileStateConflictOf resolves such a conflict ONCE, by the framework's precedence
 *
 *   request text > the scope boundary (the contract's explicitExcludes / protectedFiles) > a reviewer's opinion
 *
 * and names the losing finding, which the framework closes with a recorded reason (resolutionType `superseded`, the
 * reason starts with `[file_state_conflict]`, severity unchanged, follow-up recorded):
 *
 *   - CHANGE side loses: every file the finding's remedy must change (its defect sites: a doc-code drift's
 *     documentation anchors, else every `path:line` anchor, else its cited files) is a DOCUMENTATION file the contract
 *     excludes, and the request does not ask to change it. A finding with ANY defect site the Story may change
 *     (in-scope code) is never settled: a genuine product defect is still repaired. An excluded non-documentation
 *     file (a protected go.mod, a vendored path) is not settled either: its finding may have a remedy elsewhere, so it
 *     keeps the existing route (repair, then replan);
 *   - UNCHANGED side loses: a scope finding ("outside the scope boundary", "must not be modified", ...) against files
 *     the request explicitly asks to change, none of them excluded by the contract.
 *
 * Every settlement is journaled (`runtime/file-state/<storyId>.jsonl`, one row per finding, keyed by file and the
 * winning direction) for the audit and the review lanes' prompt; the verdict itself is recomputed from the request and
 * the contract each time, so it is the same for every later filing of the same file state (no round cap, no
 * alternation).
 *
 * Production default on; `remediation.fileStateSettle=off` (core/ab-variants.ts) is the recorded rollback.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { findingDefectAnchors, findingSites, isDocCodeDriftFinding, stripLeadingTags } from './finding-preexisting.js';
import { isDocumentationPath, normalizeScopePath, pathMatchesScopePattern } from './scope-path-classifier.js';
import { requestAsksChangeOf } from './boundary-path-excludes.js';

export const FILE_STATE_CONFLICT = 'file_state_conflict';
export const FILE_STATE_REASON_PREFIX = `[${FILE_STATE_CONFLICT}]`;
export const FILE_STATE_PRECEDENCE = 'request text > scope boundary > reviewer opinion';
export const FILE_STATE_SCHEMA = 'proof-or-stop.file-state.v1' as const;

export type FileStateDir = 'change' | 'unchanged';

export interface FileStateVerdict {
  /** True when this finding is the losing side and the framework closes it. */
  settle: boolean;
  winner: 'request' | 'scope_boundary' | null;
  /** The direction that stands for `files`. */
  dir: FileStateDir;
  files: string[];
  reason: string;
}

interface ContractSlice { explicitExcludes?: readonly string[]; protectedFiles?: readonly string[] }
interface FindingSlice { id: string; desc?: string; files?: readonly string[]; category?: string }

/** A finding that demands files stay as they are (scope violation / boundary / must not change). */
const SCOPE_DEMAND = /\b(?:scope[- ]boundary|out[- ]of[- ]scope|outside (?:of )?(?:the |this )?(?:story'?s? )?(?:declared |allowed )?scope|scope violation|scope contract|excluded (?:by|from|in)|must not (?:be )?(?:changed|modified|edited|touched)|should not (?:be )?(?:changed|modified|edited|touched)|(?:revert|undo) (?:the |this )?(?:doc|docs|documentation|change|edit))/i;

const short = (id: string): string => id.replace(/^[^:]+:/, '');

/** The files a finding's remedy must change: defect anchors (a drift's documentation anchors), else its cited files. */
export function findingTargetFiles(finding: FindingSlice): string[] {
  const sites = findingSites(finding).defects;
  const anchored = sites.length ? sites.map(anchor => anchor.path) : findingDefectAnchors({ desc: finding.desc }).map(anchor => anchor.path);
  const paths = anchored.length ? anchored : (finding.files ?? []).map(path => normalizeScopePath(path.replace(/:\d.*$/, '')));
  return [...new Set(paths.filter(Boolean))];
}

const excludedBy = (contract: ContractSlice | null | undefined, path: string): string | undefined =>
  [...(contract?.explicitExcludes ?? []), ...(contract?.protectedFiles ?? [])].find(pattern => pathMatchesScopePattern(path, pattern));

/**
 * The file-state verdict for one open finding, or null when it states no file-state demand the contract or the
 * request decides. `boundaryExcluded` are the scope boundary's excluded entries (named in the reason).
 */
export function fileStateConflictOf(args: { finding: FindingSlice; findings?: readonly FindingSlice[]; contract: ContractSlice | null | undefined;
  requestText: string | null; boundaryExcluded?: readonly string[] }): FileStateVerdict | null {
  const { finding, contract } = args;
  const files = findingTargetFiles(finding);
  if (!files.length) return null;
  const desc = stripLeadingTags(finding.desc ?? '');
  const scopeDemand = !isDocCodeDriftFinding(finding) && SCOPE_DEMAND.test(desc);
  const entries = (args.boundaryExcluded ?? []).length ? ` ("${(args.boundaryExcluded ?? []).join('", "')}")` : '';
  if (scopeDemand) {
    // UNCHANGED side: it loses only to the request, for files the contract does not exclude.
    if (files.some(path => excludedBy(contract, path))) return null;
    const asked = files.map(path => ({ path, sentence: requestAsksChangeOf(args.requestText, path) }));
    if (!asked.every(row => row.sentence)) return null;
    return { settle: true, winner: 'request', dir: 'change', files,
      reason: `${FILE_STATE_REASON_PREFIX} ${short(finding.id)} requires ${files.join(', ')} to stay unchanged, but the request asks to change ${files.length > 1 ? 'them' : 'it'} ("${asked[0]!.sentence!.slice(0, 160)}"). `
        + `Resolved once by the framework's precedence (${FILE_STATE_PRECEDENCE}): the request stands; the change is in scope. Closed without a repair; severity unchanged.` };
  }
  // CHANGE side: every file the remedy must change is a documentation file the contract excludes.
  const excluded = files.map(path => ({ path, pattern: excludedBy(contract, path) }));
  if (!excluded.every(row => row.pattern && isDocumentationPath(normalizeScopePath(row.path)))) return null;
  const asked = files.map(path => requestAsksChangeOf(args.requestText, path)).find(Boolean);
  if (asked) {
    return { settle: false, winner: 'request', dir: 'change', files,
      reason: `${FILE_STATE_REASON_PREFIX} ${short(finding.id)} requires ${files.join(', ')} to change and the request asks for it ("${asked.slice(0, 160)}"), but the scope contract excludes ${files.length > 1 ? 'them' : 'it'}: the scope contract must be amended (request text > scope boundary); not settled by the framework` };
  }
  const opposing = (args.findings ?? []).filter(row => row.id !== finding.id && !isDocCodeDriftFinding(row) && SCOPE_DEMAND.test(stripLeadingTags(row.desc ?? ''))
    && findingTargetFiles(row).some(path => files.includes(path))).map(row => short(row.id));
  return { settle: true, winner: 'scope_boundary', dir: 'unchanged', files,
    reason: `${FILE_STATE_REASON_PREFIX} ${short(finding.id)} requires changing ${files.join(', ')}, which the Story's scope boundary${entries} excludes `
      + `(explicitExcludes ${[...new Set(excluded.map(row => row.pattern))].join(', ')})${opposing.length ? `; ${opposing.join(', ')} require ${files.length > 1 ? 'them' : 'it'} unchanged` : ''}. `
      + `Resolved once by the framework's precedence (${FILE_STATE_PRECEDENCE}): the scope boundary stands and no repair may change ${files.length > 1 ? 'these files' : 'this file'}. `
      + 'Closed without a repair; severity unchanged.' };
}

/** A finding the framework closed as the losing side of a file-state conflict. */
export function isFileStateSettled(finding: { status?: string; resolutionType?: string; resolvedReason?: string }): boolean {
  return finding.status === 'resolved' && finding.resolutionType === 'superseded' && String(finding.resolvedReason ?? '').startsWith(FILE_STATE_REASON_PREFIX);
}

// ---------------------------------------------------------------------------
// Journal

interface SettleEntry { schema: typeof FILE_STATE_SCHEMA; at: string; files: string[]; dir: FileStateDir; winner: string; findingId: string; why: string }

const journal = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'file-state', `${storyId}.jsonl`);

function entries(root: string, storyId: string): SettleEntry[] {
  try {
    return readFileSync(journal(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as SettleEntry; return row?.schema === FILE_STATE_SCHEMA ? [row] : []; } catch { return []; }
    });
  } catch { return []; }
}

/** Journal one settlement (evidence; no gate depends on the write succeeding). */
export function recordFileStateSettlement(root: string, storyId: string, entry: { files: string[]; dir: FileStateDir; winner: string; findingId: string; why: string }): void {
  try {
    if (entries(root, storyId).some(row => row.findingId === entry.findingId)) return;
    mkdirSync(dirname(journal(root, storyId)), { recursive: true });
    writeFileSync(journal(root, storyId), `${JSON.stringify({ schema: FILE_STATE_SCHEMA, at: new Date().toISOString(), ...entry })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}

/** The settled file states, one row per file and winning direction, with every finding closed by it (journal order). */
export function fileStateSettlements(root: string, storyId: string): Array<{ file: string; dir: FileStateDir; winner: string; findings: string[]; why: string }> {
  const out = new Map<string, { file: string; dir: FileStateDir; winner: string; findings: string[]; why: string }>();
  for (const row of entries(root, storyId)) {
    for (const file of row.files) {
      const key = `${file}|${row.dir}`;
      const current = out.get(key) ?? { file, dir: row.dir, winner: row.winner, findings: [], why: row.why };
      if (!current.findings.includes(row.findingId)) current.findings.push(row.findingId);
      out.set(key, current);
    }
  }
  return [...out.values()];
}
