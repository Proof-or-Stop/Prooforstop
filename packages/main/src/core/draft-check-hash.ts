import { createHash } from 'crypto';

export const DRAFT_CHECK_SALT = 'proof-or-stop-draft-check-integrity-v1';

export function computeDraftCheckHash(
  draftName: string,
  backgroundHash: string,
  title: string,
  description: string,
  checklistHash: string,
  reviewRound: string,
): string {
  return createHash('sha256')
    .update(`${draftName}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${DRAFT_CHECK_SALT}`)
    .digest('hex');
}
