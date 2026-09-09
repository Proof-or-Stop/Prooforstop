import { mkdirSync, writeFileSync } from 'node:fs';
import { PROOF_OR_STOP_STATE_DIR } from './brand-paths.js';
import { dirname, join } from 'node:path';

export const RELEASE_PUSH_APPROVAL_SCHEMA = 'proof-or-stop.remote-push-approval.v1';
// B-cc10 F-046: the approval is WRITTEN under the canonical state dir. This was a hardcoded
// deprecated path, so every release_approve_push recreated `.proof-or-stop/tmp/` on a migrated repo.
// The `proof-or-stop.remote-push-approval.v1` SCHEMA literal is deliberately FROZEN and unchanged —
// only the path moves. .githooks/pre-push is updated in the same commit to read BOTH spellings,
// because a one-sided rename here silently breaks release approval. The hook keeps its own
// inline deprecated-path fallback, so no exported deprecated constant is needed here.
export const RELEASE_PUSH_APPROVAL_REL_PATH = `${PROOF_OR_STOP_STATE_DIR}/tmp/remote-push-approval.json`;
export const DEFAULT_RELEASE_PUSH_TTL_SECONDS = 300;
export const MAX_RELEASE_PUSH_TTL_SECONDS = 900;

export interface ReleasePushApproval {
  schema: typeof RELEASE_PUSH_APPROVAL_SCHEMA;
  branch: 'refs/heads/main';
  remote: string;
  sha: string;
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
  approvedBy: string;
  reason: string;
}

export interface CreateReleasePushApprovalInput {
  root: string;
  sha: string;
  remote?: string;
  ttlSeconds?: number;
  approvedBy?: string;
  reason?: string;
  now?: Date;
}

export function releasePushApprovalPath(root: string): string {
  return join(root, RELEASE_PUSH_APPROVAL_REL_PATH);
}

export function normalizeReleasePushTtlSeconds(value?: number): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_RELEASE_PUSH_TTL_SECONDS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > MAX_RELEASE_PUSH_TTL_SECONDS) return MAX_RELEASE_PUSH_TTL_SECONDS;
  return whole;
}

export function createReleasePushApproval(input: CreateReleasePushApprovalInput): ReleasePushApproval {
  const now = input.now || new Date();
  const ttlSeconds = normalizeReleasePushTtlSeconds(input.ttlSeconds);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  return {
    schema: RELEASE_PUSH_APPROVAL_SCHEMA,
    branch: 'refs/heads/main',
    remote: input.remote || 'origin',
    sha: input.sha,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds,
    approvedBy: input.approvedBy || process.env.USER || process.env.LOGNAME || 'human',
    reason: input.reason || 'human-approved remote main publish',
  };
}

export function writeReleasePushApproval(input: CreateReleasePushApprovalInput): ReleasePushApproval {
  const approval = createReleasePushApproval(input);
  const file = releasePushApprovalPath(input.root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return approval;
}
