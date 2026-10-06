/**
 * One verification-intent metadata rule from intake to PLAN acceptance.
 *
 * Every authored intent row carries scope, expectation and requirementSource
 * (the PLAN acceptance classification). The same rule is applied by
 * story_create (intake), checklist_update for verification-intent roles and
 * owner proposals, and plan_acceptance_prepare / plan_acceptance_apply.
 *
 * Run 19 (B-8166): story_create accepted intents without requirementSource,
 * the owner reused that shape in PLAN, and the first PLAN intent batch was
 * refused. The owner's script printed stdout only, so the refusal went
 * unnoticed for a round. The refusal therefore starts with "<command> REFUSED,
 * nothing was written", names the exact missing field of every unclassified
 * row, and carries one copyable classified row and one Next line.
 */
import type { VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';

export const VERIFICATION_INTENT_METADATA_REQUIRED = 'verification_intent_metadata_required';
export const VERIFICATION_INTENT_CLASSIFICATION_FIELDS = ['scope', 'expectation', 'requirementSource'] as const;
/** The classification a Story-focused intent takes (what the copyable row proposes). */
export const STORY_FOCUSED_CLASSIFICATION = { scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' } as const;

export type ClassificationCommand = 'story_create' | 'checklist_update' | 'plan_acceptance_prepare' | 'plan_acceptance_apply';

/** Unclassified rows of one item: ref and the missing fields, in lane order. */
export function unclassifiedVerificationIntentRows(itemId: string, verificationIntent: VerificationIntent | undefined):
  Array<{ ref: string; missing: string[]; intent: Record<string, unknown> }> {
  if (!verificationIntent) return [];
  const rows: Array<{ ref: string; missing: string[]; intent: Record<string, unknown> }> = [];
  for (const lane of VERIFICATION_LANES) {
    for (const [index, intent] of (verificationIntent[lane] ?? []).entries()) {
      const record = intent as unknown as Record<string, unknown>;
      const missing = VERIFICATION_INTENT_CLASSIFICATION_FIELDS.filter(field => !record[field]);
      if (missing.length) rows.push({ ref: `${itemId}:${lane}:${index}`, missing, intent: record });
    }
  }
  return rows;
}

/** The refusal text when any row of the item is unclassified, else null. */
export function verificationIntentClassificationFailure(
  itemId: string,
  verificationIntent: VerificationIntent | undefined,
  command: ClassificationCommand,
  options: { ownerProposal?: boolean } = {},
): string | null {
  const rows = unclassifiedVerificationIntentRows(itemId, verificationIntent);
  if (!rows.length) return null;
  const first = rows[0]!;
  const who = command === 'story_create' ? 'story_create intents'
    : options.ownerProposal ? 'owner proposals' : 'verification-intent roles';
  const classified = {
    ...first.intent,
    scope: first.intent.scope ?? STORY_FOCUSED_CLASSIFICATION.scope,
    expectation: first.intent.expectation ?? STORY_FOCUSED_CLASSIFICATION.expectation,
    requirementSource: first.intent.requirementSource ?? STORY_FOCUSED_CLASSIFICATION.requirementSource,
  };
  const next = command === 'story_create'
    ? 'Next: rerun story_create with every verificationIntent row classified (no Story was created; the same rule applies to PLAN intent writes).'
    : options.ownerProposal
      ? 'Next: rerun plan_acceptance_prepare with the complete classified verificationIntent, then plan_acceptance_apply its unchanged result.'
      : 'Next: rerun checklist_update with the complete classified verificationIntent.';
  return `${command} REFUSED, nothing was written: ${who} must classify every verificationIntent row before PLAN acceptance is frozen [${VERIFICATION_INTENT_METADATA_REQUIRED}]\n`
    + `Unclassified: ${rows.map(row => `${row.ref} (missing ${row.missing.join(', ')})`).join('; ')}\n`
    + 'Allowed values: scope=focused|repository; expectation=absolute_pass|no_new_regressions; requirementSource=story|external_verifier|repository_health\n'
    + `Copyable classified row (${first.ref}): ${JSON.stringify(classified)}\n`
    + next;
}
