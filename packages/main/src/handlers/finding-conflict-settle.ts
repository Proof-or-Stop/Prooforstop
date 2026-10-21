/**
 * Lab run131: the store-aware half of core/finding-conflict-settle.ts. Reads the Story's process events (rejected
 * repairs), findings, checklist, verbatim request and the settled-pair journal, and returns the framework's decision for
 * one open finding's conflict with a resolved finding (shared by next's framework step `finding_conflict_settled`, the
 * conflict step that would otherwise send it to PLAN, and finding_resolve disposition=finding_conflict_settled, so all
 * agree). With remediation.conflictSettle=off nothing is settled.
 */
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { conflictSettleOn } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';
import { readStoryRequest } from '../core/story-request.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { findingDuplicateOf } from '../core/duplicate-finding-coverage.js';
import { findingConflictOf, findingGuard, findingRepros, guardStatesPins, isReproCommand, rejectedRepairCommits, repairCommitFromResolution } from '../core/resolved-finding-guard.js';
import { conflictSettlements, findingConflictSettlement, type ConflictSettlement } from '../core/finding-conflict-settle.js';

/** The settlement for one open finding, or null (switch off, no conflict, or not the framework's to decide). */
export function evaluateFindingConflictSettlement(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[];
  gitCwd?: string; events?: ReadonlyArray<Record<string, unknown>> }): ConflictSettlement | null {
  const { store, root, storyId, finding } = args;
  try { if (!conflictSettleOn(loadConfig(root))) return null; } catch { /* unreadable config: the production default (on) */ }
  try {
    const findings = args.findings ?? store.readFindings(storyId).findings ?? [];
    let events = args.events;
    if (!events) { try { events = store.readProcessEvents(storyId) as Array<Record<string, unknown>>; } catch { events = []; } }
    const conflict = findingConflictOf({ finding, findings, storyId, rejected: rejectedRepairCommits(events),
      duplicateOf: id => findingDuplicateOf(store, storyId, id)?.canonicalFindingId ?? null });
    if (!conflict?.resolvedId) return null;
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
    return findingConflictSettlement({ finding, conflict, guarded, pins, items: items as never, requestText: request.status === 'ok' ? request.text : null,
      repros: repros.length ? repros : (guard?.repros ?? []), settledCases: conflictSettlements(root, storyId) });
  } catch {
    return null;
  }
}
