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
