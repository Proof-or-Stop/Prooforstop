/** Reviewer dispatch identity must not reach host-owned raw fixture children. */
export const REVIEWER_DISPATCH_AUTHORITY_KEYS = [
  'PROOF_OR_STOP_AGENT',
  'PROOF_OR_STOP_ACTIVITY_ROLE',
] as const;

export function withoutReviewerDispatchAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}

export function childSmokeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutReviewerDispatchAuthority(env),
    // provider-codex is also a pinned liveness entrypoint; prevent it
    // from recursively launching the unrelated liveness aggregate.
    LATTICE_AGENT_LIVENESS_SUITE_CHILD: '1',
  };
}
