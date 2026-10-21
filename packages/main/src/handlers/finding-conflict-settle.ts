/**
 * Lab run131: the store-aware half of core/finding-conflict-settle.ts. Reads the Story's process events (rejected
 * repairs), findings, checklist, verbatim request and the settled-pair journal, and returns the framework's decision for
 * one open finding's conflict with a resolved finding (shared by next's framework step `finding_conflict_settled`, the
 * conflict step that would otherwise send it to PLAN, and finding_resolve disposition=finding_conflict_settled, so all
 * agree). With remediation.conflictSettle=off nothing is settled by the checklist pin.
 *
 * Lab run137 (fix N, core/finding-conflict-pin.ts, remediation.conflictPin): a conflict no checklist row pins is decided
 * by the framework pin only when the request quotes the case's value, or a test at the Story base commit states it
 * (storyBaseTestLines; evaluateFrameworkConflictPin):
 *   - the open finding wins (`story_base` / `request`): it is repaired against the pin (no PLAN trip), and the framework's
 *     own `[regression-of G]` finding that blames its rejected repair is the losing side: settled here;
 *   - the resolved finding wins (`request`): the open finding is settled here.
 */
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { conflictPinOn, conflictSettleOn } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';
import { readStoryRequest } from '../core/story-request.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { findingDuplicateOf } from '../core/duplicate-finding-coverage.js';
import { findingConflictOf, findingGuard, findingRepros, guardStatesPins, isReproCommand, regressionTargets, rejectedRepairCommits, repairCommitFromResolution, rowsCitingCase } from '../core/resolved-finding-guard.js';
import { conflictSettlements, findingConflictSettlement, FINDING_CONFLICT_PRECEDENCE, FINDING_CONFLICT_REASON_PREFIX, type ConflictSettlement } from '../core/finding-conflict-settle.js';
import { frameworkConflictPin, frameworkPinConfirmed, type BaseTestLine, type FrameworkConflictPin } from '../core/finding-conflict-pin.js';
import { isTestPath } from '../core/probe-text.js';
import { execFileSync } from 'node:child_process';
import { pinOracleStoryBase } from '../core/pin-oracle.js';

/** The settlement for one open finding, or null (switch off, no conflict, or not the framework's to decide). */
export function evaluateFindingConflictSettlement(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[];
  gitCwd?: string; events?: ReadonlyArray<Record<string, unknown>> }): ConflictSettlement | null {
  const { store, root, storyId, finding } = args;
  let settleOn = true;
  try { settleOn = conflictSettleOn(loadConfig(root)); } catch { /* unreadable config: the production default (on) */ }
  try {
    const findings = args.findings ?? store.readFindings(storyId).findings ?? [];
    let events = args.events;
    if (!events) { try { events = store.readProcessEvents(storyId) as Array<Record<string, unknown>>; } catch { events = []; } }
    const conflict = findingConflictOf({ finding, findings, storyId, rejected: rejectedRepairCommits(events),
      duplicateOf: id => findingDuplicateOf(store, storyId, id)?.canonicalFindingId ?? null });
    // Lab run137 (remediation.conflictPin, its own switch): the framework regression finding of an upheld repair.
    if (!conflict?.resolvedId) return regressionOfFrameworkPin({ store, root, storyId, finding, findings, events, gitCwd: args.gitCwd });
    const guarded = findings.find(row => row.id === conflict.resolvedId);
    if (!guarded) return null;
    const gitCwd = args.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
    const items = store.readChecklist(storyId).items;
    let coverage = null;
    try { coverage = store.readDuplicateFindingCoverage(storyId).receipts.filter(row => row.findingId === guarded.id && row.passed).at(-1) ?? null; } catch { coverage = null; }
    const guard = findingGuard({ gitCwd, finding: guarded, repairCommit: repairCommitFromResolution(gitCwd, guarded), coverage });
    const pins = guard ? guardStatesPins(gitCwd, guard, items) : null;
    const repros = findingRepros(finding.desc).repros.filter(repro => !isReproCommand(repro));
    const request = readStoryRequest(store, storyId);
    const settled = !settleOn ? null : findingConflictSettlement({ finding, conflict, guarded, pins, items: items as never, requestText: request.status === 'ok' ? request.text : null,
      repros: repros.length ? repros : (guard?.repros ?? []), settledCases: conflictSettlements(root, storyId) });
    if (settled) return settled;
    // Lab run137: no row pins the case; the request decides it for the resolved finding's side: this one loses.
    const framework = evaluateFrameworkConflictPin({ store, root, storyId, finding, findings, events, gitCwd });
    if (framework?.pin.side !== 'resolved') return null;
    return frameworkPinSettlement(finding, framework.resolved, framework.pin, `${short(finding.id)} demands the opposite of resolved ${short(framework.resolved.id)} (${conflict.why})`);
  } catch {
    return null;
  }
}

const short = (id: string): string => id.replace(/^[^:]+:(?=F-)/, '');

function frameworkPinSettlement(loser: Pick<Finding, 'id'>, resolved: Pick<Finding, 'id'>, pin: FrameworkConflictPin, what: string): ConflictSettlement {
  const cases = pin.cases.map(row => row.expr);
  const reason = `${FINDING_CONFLICT_REASON_PREFIX} ${what} for ${cases.map(row => `\`${row}\``).join(', ')}. No checklist row pins ${cases.length > 1 ? 'these cases' : 'this case'}; decided once by the framework pin `
    + `(precedence ${FINDING_CONFLICT_PRECEDENCE}, source ${pin.source}): ${pin.reason}. ${short(loser.id)} is the losing side: closed without a repair; severity unchanged. `
    + `A pin of the case in PLAN (re-pin: <case> was <old>, now <new>) reopens it.`;
  return { settle: true, winner: pin.source, reason, cases, resolvedId: resolved.id };
}

/**
 * Lab run137: the framework pin of one open finding's conflict with a resolved finding that no current checklist row pins
 * (a row that pins it decides instead), or null (switch off, no such conflict, or not determinable: the PLAN pin stays).
 * Only the request and the Story base commit's own tests decide (security reviews: no finding-authored expression is
 * executed, and no agent-committed file or prose-named commit is a source).
 */
export function evaluateFrameworkConflictPin(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[];
  gitCwd?: string; events?: ReadonlyArray<Record<string, unknown>> }): { pin: FrameworkConflictPin; resolved: Finding } | null {
  const { store, root, storyId, finding } = args;
  try { if (!conflictPinOn(loadConfig(root))) return null; } catch { /* unreadable config: the production default (on) */ }
  try {
    const findings = args.findings ?? store.readFindings(storyId).findings ?? [];
    let events = args.events;
    if (!events) { try { events = store.readProcessEvents(storyId) as Array<Record<string, unknown>>; } catch { events = []; } }
    const conflict = findingConflictOf({ finding, findings, storyId, rejected: rejectedRepairCommits(events),
      duplicateOf: id => findingDuplicateOf(store, storyId, id)?.canonicalFindingId ?? null });
    if (!conflict?.resolvedId) return null;
    const resolved = findings.find(row => row.id === conflict.resolvedId);
    if (!resolved) return null;
    const items = store.readChecklist(storyId).items;
    const repros = findingRepros(finding.desc).repros.filter(repro => !isReproCommand(repro));
    if (repros.length && rowsCitingCase(items, repros).length) return null;
    const request = readStoryRequest(store, storyId);
    const gitCwd = args.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
    const requestText = request.status === 'ok' ? request.text : null;
    const baseSha = (() => { try { return pinOracleStoryBase(gitCwd, (store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } }).integrationTarget?.parentCommitAtCreation); } catch { return null; } })();
    const pin = frameworkConflictPin({ finding, resolved, conflict, requestText,
      ...(baseSha ? { baseTests: (expr: string) => storyBaseTestLines(gitCwd, baseSha, expr) } : {}) });
    // Security review: nothing is decided without a positive record of every case.
    if (!pin || !frameworkPinConfirmed(pin)) return null;
    // A case a current row pins is the row's to decide (lab run131 settle / the repair against the row).
    if (rowsCitingCase(items, pin.cases.map(row => row.expr)).length) return null;
    return { pin, resolved };
  } catch {
    return null;
  }
}

/**
 * Lab run137: the framework's own regression finding `[regression-of G] the repair of F (commit c) broke ...` is the
 * losing side when the framework pin of F's conflict with G upholds F (the repair broke a test that pins a value the
 * request / the Story base do not support). Linked by the rejected-repair record of G's guard, never by prose alone.
 */
function regressionOfFrameworkPin(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings: readonly Finding[];
  events: ReadonlyArray<Record<string, unknown>>; gitCwd?: string }): ConflictSettlement | null {
  const { storyId, finding, findings } = args;
  const targets = regressionTargets(finding.desc, storyId);
  const blamed = String(finding.desc ?? '').match(/^\[regression-of [^\]]+\] the repair of ([^ ]+) \(commit ([0-9a-f]{7,40})\)/);
  if (!targets.length || !blamed) return null;
  const rejected = rejectedRepairCommits(args.events);
  for (const [findingId, rows] of rejected) {
    if (short(findingId) !== blamed[1] || !rows.some(row => targets.includes(row.guardedFindingId) && row.commit.startsWith(blamed[2]!))) continue;
    const owner = findings.find(row => row.id === findingId && row.status === 'open');
    if (!owner) continue;
    const framework = evaluateFrameworkConflictPin({ ...args, finding: owner, findings });
    if (framework?.pin.side !== 'finding' || !targets.includes(framework.resolved.id)) continue;
    // Security review: a framework guard finding is settled only on a positive record from the two trusted sources (a
    // request-quoted value, or a test at the Story base commit), never on what the finding (a reviewer) wrote.
    if (!frameworkPinConfirmed(framework.pin)) continue;
    return frameworkPinSettlement(finding, framework.resolved, framework.pin,
      `${short(finding.id)} reports that the repair of ${short(owner.id)} broke resolved ${short(framework.resolved.id)}'s covering test`);
  }
  return null;
}

/**
 * Lab run137 (security review 3 of fix N): the Story BASE commit's test lines that contain `expr` verbatim (`git grep -F`
 * at the base SHA, test paths only, at most 50 lines). The base SHA is the Story's recorded integration base; files an
 * agent committed later and commits named in prose are never read.
 */
export function storyBaseTestLines(gitCwd: string, baseSha: string, expr: string): BaseTestLine[] {
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !expr.trim() || /[\r\n]/.test(expr)) return [];
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-n', '-I', '-F', '--no-color', '-e', expr.trim(), baseSha, '--'], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch { return []; }
  const rows: BaseTestLine[] = [];
  for (const raw of out.split('\n')) {
    const match = raw.match(/^[0-9a-f]{40}:(.+?):(\d+):(.*)$/);
    if (!match || !isTestPath(match[1]!)) continue;
    rows.push({ file: match[1]!, line: Number(match[2]), text: match[3]! });
    if (rows.length >= 50) break;
  }
  return rows;
}
