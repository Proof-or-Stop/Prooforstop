/**
 * Fixture children exercise independent CLI scenarios. They must not inherit
 * an outer provider's managed-review capability or a reviewer's mutation
 * authority; callers add only the identity their fixture explicitly owns.
 */
const FIXTURE_AMBIENT_AUTHORITY_KEYS = [
  // A provider-managed review capability can only be used by the process the
  // managed host admitted. Fixture children deliberately exercise a distinct,
  // direct CLI boundary, so they must never receive the outer capability.
  'LATTICE_MANAGED_HOST_RUN_ID',
  'LATTICE_MANAGED_REVIEW_INVOCATION_FD',
  'LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY',
  'LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD',
  'LATTICE_NATIVE_REVIEW_ATTESTATION_FD',
  'LATTICE_NATIVE_REVIEW_ATTESTATION',

  // Do not allow a surrounding reviewer's actor or host session to authorize
  // fixture mutations. Callers add their synthetic broker identity after this
  // sanitization, which keeps the fixture boundary explicit and auditable.
  'PROOF_OR_STOP_AGENT',
  'PROOF_OR_STOP_ACTIVITY_ROLE',
  'LATTICE_REVIEWER_READONLY',
  'PROOF_OR_STOP_SESSION_ID',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE',
  'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY',
  'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED',

  // Native provider session variables can derive the same ambient reviewer
  // identity without a LATTICE_* overlay, so remove only the known identity
  // inputs rather than broadly filtering the child environment.
  'AGY_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GEMINI_SESSION_ID',
  'OPENAI_SESSION_ID',
] as const;

export function sanitizedFixtureChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...environment };
  for (const key of FIXTURE_AMBIENT_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}
