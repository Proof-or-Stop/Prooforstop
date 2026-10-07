/**
 * Grouped DEV dispatches (core/ab-variants.ts): V4 adopted, V5 EXPERIMENTAL.
 *
 * V4 `remediation.grouping: "single"` (production default since the detection
 *   A/B V4 arm, bench-staging/oldpos/ab/results-r2.md; "per-finding" is the
 *   rollback): one managed finding-repair run covers
 *   every open blocking finding that no repair is bound to yet. The run binds
 *   its primary finding (managedDispatchTarget.findingId) plus
 *   `groupFindingIds` (and the A/B evidence when another switch is not at its
 *   production value). A finding counts as repaired by
 *   that run only when a material commit made inside the run's window names
 *   the finding id in its message (one commit per finding is required by the
 *   prompt) — otherwise next dispatches that finding's own repair. Each finding
 *   still needs its own regression test and its own finding_resolve.
 * V5 `implementation.grouping: "files"`: open checklist items that share a
 *   declared file with the first open item are implemented by one managed
 *   implementer run bound to the first item plus `groupItemIds`. The worker
 *   marks only the bound item done (one-shot managed capability); every other
 *   member is marked done by the owner afterwards, and only after a material
 *   commit inside the run's window touched one of that item's declared files.
 *
 * V4 is honoured unless the config sets the rollback; a malformed config
 * falls back to the per-finding path, because host_run refuses a grouped
 * launch it cannot resolve the switch for. V5 is honoured only while its
 * switch is set (malformed config fails closed to production behavior).
 */
import { resolveAbVariants } from './ab-variants.js';
import { loadConfig } from './config.js';
import type { ChecklistItem, Finding } from './types.js';

function variantsOrNull(root: string) {
  try { return resolveAbVariants(loadConfig(root)); } catch { return null; }
}

/** Adopted default: true unless the config sets the `per-finding` rollback (or is malformed). */
export function remediationGroupingSingle(root: string): boolean {
  return variantsOrNull(root)?.remediationGrouping === 'single';
}

export function implementationGroupingFiles(root: string): boolean {
  return variantsOrNull(root)?.implementationGrouping === 'files';
}

export function itemDeclaredFiles(item: Pick<ChecklistItem, 'files'>): string[] {
  const files = item.files;
  return files ? [...new Set([...files.modify, ...files.create, ...files.test])] : [];
}

/** The primary item plus every other candidate sharing at least one declared file with it (order kept). */
export function sharedFileItemGroup<T extends Pick<ChecklistItem, 'id' | 'files'>>(primary: T, candidates: readonly T[]): T[] {
  const own = new Set(itemDeclaredFiles(primary));
  if (own.size === 0) return [primary];
  return [primary, ...candidates.filter(item => item.id !== primary.id && itemDeclaredFiles(item).some(path => own.has(path)))];
}

export function shortFindingId(storyId: string, findingId: string): string {
  return findingId.startsWith(`${storyId}:`) ? findingId.slice(storyId.length + 1) : findingId;
}

/** Does a commit message name this finding (short `F-001` or full `B-x:F-001`, not `F-0010`)? */
export function commitMessageNamesFinding(message: string, storyId: string, findingId: string): boolean {
  const short = shortFindingId(storyId, findingId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${short}(?![0-9])`).test(message);
}

export function renderGroupedFindingRepairSection(storyId: string, primaryId: string, findings: readonly Pick<Finding, 'id' | 'severity' | 'category' | 'desc'>[]): string[] {
  const others = findings.filter(finding => finding.id !== primaryId);
  return [
    '',
    '--- BEGIN GROUPED FINDING REPAIR (remediation.grouping=single) ---',
    `This one run repairs ALL ${findings.length} open blocking findings below, not only ${shortFindingId(storyId, primaryId)}.`,
    'For EACH finding: add its own failing regression test (or tests) first, then fix it, then make ONE commit for that finding whose message starts with',
    `"${storyId} <F-id>: resolve finding" (for example "${storyId} ${shortFindingId(storyId, primaryId)}: resolve finding"). A finding with no commit naming its id`,
    'is treated as NOT repaired by this run and gets its own repair dispatch later. Do not call finding_resolve; the owner resolves each finding separately with its own evidence.',
    'Additional findings in this run:',
    ...others.map(finding => `- ${shortFindingId(storyId, finding.id)} [severity=${finding.severity ?? 'n/a'}, category=${finding.category ?? 'n/a'}] ${(finding.desc ?? '').replace(/\s+/g, ' ').trim()}`),
    '--- END GROUPED FINDING REPAIR ---',
  ];
}

export function renderGroupedItemSection(storyId: string, primaryId: string, items: readonly ChecklistItem[]): string[] {
  const others = items.filter(item => item.id !== primaryId);
  return [
    '',
    '--- BEGIN GROUPED IMPLEMENTATION (A/B implementation.grouping=files, experimental) ---',
    `These checklist items share declared files with ${primaryId}; implement them in this SAME run, together with ${primaryId}.`,
    `Commit each item's work (one commit per item is preferred; its message should name the item id, e.g. "${storyId} CHK-00N: ...").`,
    `Run checklist_update ... "status":"done" ONLY for ${primaryId} (this run's bound item). Do NOT mark the items below done: the owner verifies and marks each one separately.`,
    ...others.flatMap(item => [
      `- ${item.id}: ${item.title}`,
      ...(item.context ? [`  Context: ${item.context}`] : []),
      ...(item.userSees ? [`  User sees: ${item.userSees}`] : []),
      `  Files: modify ${item.files?.modify.join(', ') || '(none)'}; create ${item.files?.create.join(', ') || '(none)'}; test ${item.files?.test.join(', ') || '(none)'}`,
    ]),
    '--- END GROUPED IMPLEMENTATION ---',
  ];
}
