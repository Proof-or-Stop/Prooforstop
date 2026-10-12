/**
 * Base-disagreement check of the scope-plan reviewer (A/B switch
 * plan.baseDisagreement, default on; core/ab-variants.ts).
 *
 * Old-PoS run 46 (bench-staging/oldpos/run46-analysis.md §2.2, §2.3 item 1):
 * a Story added a new form of an existing operation on a receiver type that
 * did not have it. The base already had two precedents for that operation that
 * disagreed on one operand case (the same receiver's counterpart operation,
 * and the same operation on another receiver type), and neither the request
 * nor a checklist row said which applies. Nothing in PLAN looked; REVIEW found
 * it as a sibling-parity divergence and the repair loop flip-flopped for four
 * rounds. All the information is in the base code before the Story starts, so
 * the cheapest place to ask is the scope-plan review: the answer is a covering
 * checklist row (a pin with a derivation), which the lanes then treat as stated.
 *
 * Prompt only (the reviewer probes; the framework cannot know the operation
 * semantics). `off` (the rollback) sends nothing; a malformed value keeps on.
 */
import { baseDisagreementOn } from './ab-variants.js';
import { loadConfig } from './config.js';

export const SCOPE_PLAN_BASE_DISAGREEMENT_CHECK = '- Base-disagreement check: for each new operation an item adds, probe its base precedents (the same receiver\'s counterpart operation and the same operation on other receivers) on the operand cases they special-case (out of range, sign, empty, null or omitted, type). Where they disagree and neither the request nor a checklist row settles it, save a gap `Precedent conflict: <operation>, <case>: <A result> vs <B result>`; its remedy is a covering row on that item pinning which precedent applies (derivation quoting the base probe), never an excludes entry.';

/** Whether the scope-plan dispatch carries the check (a malformed value or unreadable config keeps on). */
export function baseDisagreementActive(root: string): boolean {
  try { return baseDisagreementOn(loadConfig(root)); } catch { return true; }
}
