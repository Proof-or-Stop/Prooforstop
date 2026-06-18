/**
 * B-c06a CHK-002 (Experience Layer ③.4): read-only learning_effectiveness handler.
 *
 * `learning_effectiveness` reports two deterministic readouts over the local store
 * + activity log, modelled on the strictly-read-only `learning_validate` (B-a2e3):
 *
 *   1. FAST per-story hint predictive value (retrodictive recall over findings +
 *      signatureTags in temporal order, plus a windowed trend + slope).
 *   2. LONG-GAME ON/OFF arm comparison from the recorded experience_hint_surfaced
 *      hintMode events, with an HONEST per-arm N and a CONSERVATIVE significance
 *      gate (no p-value).
 *
 * This handler is STRICTLY READ-ONLY and ADVISORY:
 *   • It reads stories through the store read ports (`listStoryIds` / `readStory` /
 *     `readFindings`) and the activity-log read port (`readActivityLogTail`); it
 *     persists NOTHING — no cache, no derived index, no projectRoot.
 *   • All metric logic lives in the pure `core/experience-effectiveness.ts` leaf;
 *     this handler only adapts the store + activity log to that leaf and renders.
 *   • It files NO findings, registers NO gate, and writes NOTHING.
 */

import { readActivityLogTail } from '../core/activity-log.js';
import {
  computePredictiveValue,
  computeArmComparison,
  type EffStory,
  type EffFinding,
  type PredictiveValueReport,
  type ArmComparison,
  type PredictiveValueOptions,
} from '../core/experience-effectiveness.js';
import type { HandlerContext } from './context.js';

interface LearningEffectivenessArgs {
  json?: boolean;
  confirmedOnly?: boolean;
}

/** How many recent activity records to scan for hintMode arm assignments. */
const ACTIVITY_TAIL = 5000;

/**
 * Map each storyId to its recorded experience-hint arm (hintMode). The activity
 * tail is newest-first, so the FIRST hintMode seen per story is the latest and
 * wins. Records without a usable storyId / hintMode are ignored.
 */
function buildHintModeByStory(root: string): Map<string, 'on' | 'off'> {
  const out = new Map<string, 'on' | 'off'>();
  let records: Record<string, unknown>[];
  try {
    records = readActivityLogTail(root, ACTIVITY_TAIL);
  } catch {
    return out; // activity log unreadable => no arm data (graceful)
  }
  for (const rec of records) {
    if (rec?.event !== 'experience_hint_surfaced') continue;
    const storyId = typeof rec.storyId === 'string' ? rec.storyId : undefined;
    const hintMode = rec.hintMode === 'on' || rec.hintMode === 'off' ? rec.hintMode : undefined;
    if (!storyId || !hintMode) continue;
    if (!out.has(storyId)) out.set(storyId, hintMode); // newest-first => latest wins
  }
  return out;
}

/** Project a store finding onto the leaf's EffFinding shape (tolerant of shape drift). */
function toEffFinding(finding: unknown): EffFinding {
  const f = (finding ?? {}) as Record<string, unknown>;
  const out: EffFinding = {};
  if (typeof f.signatureTag === 'string') out.signatureTag = f.signatureTag;
  if (typeof f.signatureTagSource === 'string') out.signatureTagSource = f.signatureTagSource;
  return out;
}

/**
 * Build the ordered (temporal-ascending) EffStory list through the read ports.
 * Sort is STABLE-by-createdAt-then-storyId so a missing/equal createdAt yields a
 * deterministic order. Reads findings via `store.readFindings` (never JSON.parse).
 */
function buildOrderedStories(ctx: HandlerContext): EffStory[] {
  const hintModeByStory = buildHintModeByStory(ctx.root);
  const ids = ctx.store.listStoryIds();
  const rows: EffStory[] = [];
  for (const id of ids) {
    let createdAt = '';
    try {
      const story = ctx.store.readStory(id);
      createdAt = typeof story.createdAt === 'string' ? story.createdAt : '';
    } catch {
      createdAt = ''; // unreadable index => sorts first deterministically
    }
    let findings: EffFinding[] = [];
    try {
      const data = ctx.store.readFindings(id);
      findings = Array.isArray(data?.findings) ? data.findings.map(toEffFinding) : [];
    } catch {
      findings = [];
    }
    const row: EffStory = { storyId: id, createdAt, findings };
    const mode = hintModeByStory.get(id);
    if (mode) row.hintMode = mode;
    rows.push(row);
  }
  // Ascending by createdAt (earliest first); ties broken by storyId for stability.
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
  });
  return rows;
}

/** Render the advisory human report (predictive value + windowed trend + arms). */
function renderHuman(predictive: PredictiveValueReport, arms: ArmComparison): string {
  const lines: string[] = [];
  lines.push('Experience Layer — learning effectiveness (read-only, advisory)');
  lines.push('FAST predictive value (per-story hint, retrodictive):');
  lines.push(`  stories scanned:        ${predictive.stories}`);
  lines.push(`  findings w/ signature:  ${predictive.findingsWithSig}`);
  lines.push(`  pre-warnable findings:  ${predictive.preWarnable}`);
  lines.push(`  recall:    ${predictive.recall.toFixed(3)}`);
  lines.push(`  trend (windowed hit-rate, slope ${predictive.slopeSign}):`);
  if (predictive.windows.length === 0) {
    lines.push('    (no windows)');
  } else {
    for (const w of predictive.windows) {
      lines.push(`    <=${w.cutoff}: ${w.hitRate.toFixed(3)}`);
    }
  }
  lines.push('LONG-GAME ON/OFF arm comparison (experience_hint_surfaced hintMode):');
  lines.push(`  nOn:  ${arms.nOn}`);
  lines.push(`  nOff: ${arms.nOff}`);
  lines.push(`  outcomeOn  (uncaught recurrence rate): ${arms.outcomeOn.toFixed(3)}`);
  lines.push(`  outcomeOff (uncaught recurrence rate): ${arms.outcomeOff.toFixed(3)}`);
  lines.push(`  delta (off - on): ${arms.delta.toFixed(3)}`);
  lines.push(`  significant: ${arms.significant ? 'YES' : 'NO'} — ${arms.note}`);
  lines.push('(advisory, read-only — no gate touched, nothing written)');
  return lines.join('\n');
}

export function createLearningEffectivenessHandlers(ctx: HandlerContext) {
  return {
    /**
     * Report Experience Layer learning effectiveness: FAST per-story hint
     * predictive value (retrodictive recall + windowed trend) and a LONG-GAME
     * ON/OFF arm comparison from recorded hintMode events. READ-ONLY:
     * reads stories + findings + activity log through the read ports only,
     * persists nothing, files no findings, and touches no gate.
     */
    learning_effectiveness(args: LearningEffectivenessArgs = {}): string {
      const opts: PredictiveValueOptions = args.confirmedOnly ? { confirmedOnly: true } : {};
      const stories = buildOrderedStories(ctx);
      const predictive = computePredictiveValue(stories, opts);
      const arms = computeArmComparison(stories, opts);

      if (args.json) {
        return JSON.stringify({ predictiveValue: predictive, armComparison: arms }, null, 2);
      }
      return renderHuman(predictive, arms);
    },
  };
}
