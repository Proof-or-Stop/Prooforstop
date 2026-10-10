/**
 * Sibling-parity check of the evidence lanes (A/B switch review.siblingParity,
 * default on; core/ab-variants.ts).
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
 */
import { siblingParityOn } from './ab-variants.js';
import { loadConfig } from './config.js';

export const SIBLING_PARITY_LANES: ReadonlySet<string> = new Set(['proof-or-stop-review-test-coverage', 'proof-or-stop-review-quality']);

export const SIBLING_PARITY_CHECK = [
  'Sibling parity (required): for every entry point the diff adds or changes, find its sibling paths: the matching read or write of the same data, the same operation on the other receiver types, and the pre-existing variant (unchanged files included).',
  '- List the operand cases a sibling special-cases (out of range, sign, empty, null or omitted, type) and run at least one probe per case on the new path and on the sibling.',
  '- A difference that neither the request nor a checklist row states is a finding (category edge, at least medium) citing both paths and both probe outputs; name the sibling pairs you probed in your note.',
] as const;

/** The block for a lane's dispatch prompt: the check for a parity lane while the switch is on (a malformed value keeps on). */
export function renderSiblingParity(root: string, lane: string): string[] {
  if (!SIBLING_PARITY_LANES.has(lane)) return [];
  let on = true;
  try { on = siblingParityOn(loadConfig(root)); } catch { on = true; }
  return on ? [...SIBLING_PARITY_CHECK] : [];
}
