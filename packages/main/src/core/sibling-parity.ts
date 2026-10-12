/**
 * Sibling-parity check of the evidence lanes (A/B switch review.siblingParity,
 * default OFF since old-PoS run 58, `on` = the recorded arm; core/ab-variants.ts).
 * Run 58 (run58-analysis.md §0 item 5, §7): parity on in runs 46/47/58 took
 * 131 min / timeout / timeout and added mostly duplicate precedent-conflict
 * findings; the PLAN base-disagreement check alone pinned the case it was
 * added for.
 *
 * Old-PoS run 43 (bench-staging/oldpos/run43-analysis.md §5.2 fix 1): a new
 * write path copied the precedent of another write path and differed from the
 * sibling read path of the same data on an operand case the read path
 * special-cases; the request was silent, nothing pinned the case, and no lane
 * compared the new path with its siblings (lanes probed reads and the other
 * new forms only). Nothing in the prompts asked for that comparison.
 *
 * The test-coverage and quality lane dispatch prompts (handlers/story-dispatch.ts
 * buildStoryReviewPrompt) carry SIBLING_PARITY_CHECK: for each new or changed
 * entry point, find its siblings (matching read / write, other receiver types,
 * the pre-existing variant), probe each operand case a sibling special-cases on
 * both, and report an unstated difference. The text names generic operand
 * classes only. `off` (the rollback) sends nothing.
 *
 * Old-PoS run 46 (run46-analysis.md §2.1-§2.3 item 2): the run-43 text gave all
 * sibling kinds equal weight and no oracle. Lanes compared a new write only
 * with another receiver type's write, called the behaviour that matched the
 * same receiver's pre-existing read a defect, and the repair aligned the new
 * path to the wrong precedent. The check now ranks the oracle (request /
 * checklist row, then the same receiver's pre-existing counterpart, then other
 * receivers' same operation) and turns a disagreement between two base
 * precedents into one `[precedent-conflict]` finding (a question for the owner,
 * routed by the repair prompt to an intent conflict) instead of an alignment
 * demand. Each finding states its repro (`Repro: ...`), which the
 * resolved-finding re-probe and the duplicate-closure checks read
 * (core/resolved-finding-guard.ts).
 */
import { siblingParityOn } from './ab-variants.js';
import { loadConfig } from './config.js';

export const SIBLING_PARITY_LANES: ReadonlySet<string> = new Set(['proof-or-stop-review-test-coverage', 'proof-or-stop-review-quality']);

export const SIBLING_PARITY_CHECK = [
  'Sibling parity (required): for every entry point the diff adds or changes, probe each operand case its references special-case (out of range, sign, empty, null or omitted, type) on the new path and on the reference, unchanged files included.',
  '- Oracle order: a request sentence or checklist row; else the SAME receiver\'s pre-existing counterpart (its read for a new write, its write for a new read); the same operation on another receiver is only secondary. Probe the primary first.',
  '- New path differs from the primary on an unstated case: a finding (edge, at least medium) citing both paths and probe outputs. Primary and secondary already disagree in the base on that case: not a defect of the new path; report one `[precedent-conflict]` finding asking which applies (both base probes); never ask to align the new path with the secondary.',
  '- Give each finding its repro as Repro: `<command or expression>`; name the pairs probed in your note.',
] as const;

/** The block for a lane's dispatch prompt: the check for a parity lane while the switch is on (absent, malformed or unreadable = off). */
export function renderSiblingParity(root: string, lane: string): string[] {
  if (!SIBLING_PARITY_LANES.has(lane)) return [];
  let on = false;
  try { on = siblingParityOn(loadConfig(root)); } catch { on = false; }
  return on ? [...SIBLING_PARITY_CHECK] : [];
}
