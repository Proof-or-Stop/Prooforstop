/**
 * Finding closure severities: the single source of which verified finding
 * severities must be closed before REVIEW->TEST and before DONE.
 *
 * Every profile (light, balanced, strict) requires verified critical, high AND
 * medium findings to be closed; low is always advisory. The WORKFLOW_PRESETS
 * (core/types.ts) derive review.blockingSeverities from this constant, so the
 * profile setting says exactly what the gate does. closureBlockingSeverities
 * keeps the union with the policy's own list only as a guard for a hand-built
 * policy object: it can add severities, never remove one from this set. Dependency-free so gate, diagnostic and triage
 * modules can share it without widening their imports.
 */
export const CLOSURE_REQUIRED_SEVERITIES: readonly ['critical', 'high', 'medium'] = Object.freeze(['critical', 'high', 'medium'] as const);

export function closureBlockingSeverities(policy: { review: { blockingSeverities: readonly string[] } }): string[] {
  return [...new Set([...CLOSURE_REQUIRED_SEVERITIES, ...policy.review.blockingSeverities])].filter(severity => severity !== 'low');
}

/**
 * The one shared reviewer severity rubric (run 16: a reproduced base->head
 * regression of an existing operation was rated low, low is advisory, and the
 * Story reached DONE with it open). Carried verbatim by the REVIEW finding
 * triage contract (every active REVIEW lane), the topology/inventory critic
 * template, and the managed final-proposal schema's severity description.
 */
export const REVIEW_SEVERITY_RUBRIC = 'Severity rubric: a confirmed regression of existing behavior (a base-to-head behavior change the request did not ask for, documented or not) or a wrong result on a documented or tested path is at least medium. Use low only for cosmetic or non-behavioral issues (naming, comments, style, unobservable dead code). critical, high and medium must be closed before TEST and DONE; low is advisory.';
