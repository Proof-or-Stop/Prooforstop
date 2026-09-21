import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';




import { fileURLToPath } from 'node:url';



























export const STORY_ID = 'B-managed-evidence';

export const LANE = 'proof-or-stop-review-quality';

export const REVIEW_RUN_ID = `${STORY_ID}:RR-001`;

export const CONCEPT_LANE = 'proof-or-stop-review-concept';

export const CONCEPT_REVIEW_RUN_ID = `${STORY_ID}:RR-002`;

export const REVIEW_ROUND = '2026-08-14T00:00:00.000Z';

export const SELF = fileURLToPath(new URL('../managed-review-evidence-smoke.js', import.meta.url));

export const MANAGED_REVIEW_FIXTURE_DEADLINE_MS = 10_000;

export const MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS = 10_000;

export const MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS = 15_000;

export const MANAGED_REVIEW_NESTED_CLAIM_DELAY_MS = 2_500;

export const CLI = fileURLToPath(new URL("../../cli.js", import.meta.url));

export const REQUESTED_CODEX_MODEL = 'gpt-5.6-terra';

export const REQUESTED_CODEX_REASONING = 'high';

export const REQUESTED_CLAUDE_MODEL = 'claude-fable-5';

export const REQUESTED_CLAUDE_REASONING = 'xhigh';

export const MANAGED_AMBIENT_AUTHORITY_KEYS = [
  'LATTICE_MANAGED_HOST_RUN_ID',
  'LATTICE_MANAGED_REVIEW_INVOCATION_FD',
  'LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY',
  'LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD',
] as const;

export const REVIEWER_DISPATCH_AUTHORITY_KEYS = [
  'PROOF_OR_STOP_AGENT',
  'PROOF_OR_STOP_ACTIVITY_ROLE',
] as const;

export function withoutManagedAmbientAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of MANAGED_AMBIENT_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}

export function withoutReviewerDispatchAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}

export function hostOwnedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutReviewerDispatchAuthority(env);
}

export function withHostOwnedMutationEnv<T>(fn: () => T): T {
  const previous = REVIEWER_DISPATCH_AUTHORITY_KEYS.map(key => [key, process.env[key]] as const);
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function assertHostOwnedMutationEnvDropsReviewerDispatchAuthority(): void {
  const env = hostOwnedChildEnv({
    ...process.env,
    PROOF_OR_STOP_AGENT: 'proof-or-stop-review-test-coverage',
    PROOF_OR_STOP_ACTIVITY_ROLE: 'proof-or-stop-review-test-coverage',
  });
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) {
    assert.equal(env[key], undefined, `host-owned fixture env must not inherit ${key}`);
  }
  const observed = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({agent: process.env.PROOF_OR_STOP_AGENT ?? null, role: process.env.PROOF_OR_STOP_ACTIVITY_ROLE ?? null}))'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.deepEqual(
    JSON.parse(observed),
    { agent: null, role: null },
    `host-owned fixture child inherited reviewer dispatch authority: ${observed}`,
  );
}
