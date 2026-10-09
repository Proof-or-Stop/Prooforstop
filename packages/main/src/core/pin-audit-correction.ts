/**
 * Old-PoS run 31 (D8): the scope-plan reviewer was rerun (#4, #5: 3.4 min,
 * 1.16M) only because the owner applied the values its own pin audit asked for.
 *
 * A pin-audit gap reads `pin-audit CHK-<id>:<lane>:<n>: pins <pinned>; request
 * gives <value> (<why>)` (core/intent-derivation.ts renderPinAudit). When the
 * checklist's ONLY changes since the verdict are those requested values, the
 * rerun is replaced by a deterministic check: substituting each requested value
 * back by its pinned value reproduces exactly the checklist the reviewer judged
 * (scope-check.json checklistDigest), and each cited row now states the
 * requested value and no longer the pinned one. Any other change (or an
 * unparsable gap) keeps the rerun. The check can only fail toward a rerun.
 */
import type { ChecklistData, ChecklistItem, ScopeCheckData } from './types.js';
import { PIN_AUDIT_GAP_PREFIX } from './intent-derivation.js';
import { scopeReviewChecklistDigest } from './scope-check-integrity.js';

export interface PinAuditGap { feature: string; ref: string; itemId: string; lane: string; index: number; pinned: string; requestValue: string }

const LANES = ['happy', 'edge', 'adversarial'] as const;

/** One pin-audit gap feature, parsed; null when it does not follow the audit format. */
export function parsePinAuditGap(feature: string): PinAuditGap | null {
  const match = feature.match(new RegExp(`^${PIN_AUDIT_GAP_PREFIX}\\s+((CHK-\\d+):(happy|edge|adversarial):(\\d+)):\\s*pins\\s+(.+?);\\s*request gives\\s+(.+)$`, 's'));
  if (!match) return null;
  let requestValue = match[6]!.trim();
  // Drop the trailing "(why)".
  if (requestValue.endsWith(')')) {
    let depth = 0;
    for (let index = requestValue.length - 1; index >= 0; index -= 1) {
      const char = requestValue[index];
      if (char === ')') depth += 1;
      else if (char === '(') { depth -= 1; if (depth === 0) { requestValue = requestValue.slice(0, index).trim(); break; } }
    }
  }
  const pinned = match[5]!.trim();
  if (!pinned || !requestValue || pinned === requestValue) return null;
  return { feature, ref: match[1]!, itemId: match[2]!, lane: match[3]!, index: Number(match[4]), pinned, requestValue };
}

function rowText(item: ChecklistItem | undefined, lane: string, index: number): string {
  const row = item?.verificationIntent?.[lane as typeof LANES[number]]?.[index] as { desc?: string; derivation?: { computation?: string } } | undefined;
  return row ? `${row.desc ?? ''}\n${row.derivation?.computation ?? ''}` : '';
}

/** The checklist with each requested value substituted back by its pinned value (userSees, row descs, derivation computations). */
function revertRequestedValues(items: readonly ChecklistItem[], gaps: readonly PinAuditGap[]): ChecklistItem[] {
  const revert = (text: string): string => gaps.reduce((current, gap) => current.split(gap.requestValue).join(gap.pinned), text);
  return items.map(item => {
    const copy = structuredClone(item);
    if (typeof copy.userSees === 'string') copy.userSees = revert(copy.userSees);
    for (const lane of LANES) {
      for (const row of copy.verificationIntent?.[lane] ?? []) {
        if (typeof row.desc === 'string') row.desc = revert(row.desc);
        const derivation = (row as { derivation?: { computation?: string } }).derivation;
        if (derivation && typeof derivation.computation === 'string') derivation.computation = revert(derivation.computation);
      }
    }
    return copy;
  });
}

/**
 * The pin-audit gap features the checklist has applied, when its only changes
 * since the verdict are those requested values; otherwise none.
 */
export function appliedPinAuditGaps(scope: Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>): Set<string> {
  const gapFeatures = (scope.features ?? []).filter(feature => feature.status === 'gap' && feature.feature.startsWith(PIN_AUDIT_GAP_PREFIX));
  if (!scope.checklistDigest || gapFeatures.length === 0) return new Set();
  const parsed = gapFeatures.map(feature => parsePinAuditGap(feature.feature));
  if (parsed.some(gap => !gap)) return new Set();
  const gaps = parsed as PinAuditGap[];
  if (scopeReviewChecklistDigest(checklist) === scope.checklistDigest) return new Set();
  const stated = gaps.every(gap => {
    const text = rowText(checklist.items.find(item => item.id === gap.itemId), gap.lane, gap.index);
    return text.includes(gap.requestValue) && !text.includes(gap.pinned);
  });
  if (!stated) return new Set();
  return scopeReviewChecklistDigest({ items: revertRequestedValues(checklist.items, gaps) }) === scope.checklistDigest
    ? new Set(gaps.map(gap => gap.feature)) : new Set();
}

/** Gap features of a verdict that still stand (applied pin-audit corrections removed). */
export function openScopeGaps<T extends { feature: string; status: string }>(scope: Pick<ScopeCheckData, 'checklistDigest'> & { features?: T[] }, checklist: Pick<ChecklistData, 'items'>): T[] {
  const gaps = (scope.features ?? []).filter(feature => feature.status === 'gap');
  if (gaps.length === 0) return gaps;
  const applied = appliedPinAuditGaps(scope as Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist);
  return applied.size ? gaps.filter(feature => !applied.has(feature.feature)) : gaps;
}

/** Pin-audit gaps whose cited row still states the pinned value (what the owner corrects next). */
export function openPinAuditGaps(scope: Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>): PinAuditGap[] {
  const open = new Set(openScopeGaps(scope, checklist).map(feature => feature.feature));
  return (scope.features ?? []).filter(feature => feature.status === 'gap' && open.has(feature.feature))
    .map(feature => parsePinAuditGap(feature.feature)).filter((gap): gap is PinAuditGap => Boolean(gap))
    .filter(gap => rowText(checklist.items.find(item => item.id === gap.itemId), gap.lane, gap.index).includes(gap.pinned));
}
