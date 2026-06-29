import { z } from 'zod';
import { VERIFICATION_EVIDENCE_VERDICTS } from '../core/types.js';
import { BACKGROUND_SECTION_IDS, normalizeBackgroundSection } from '../core/background-validator.js';

export const verificationIntentTypeSchema = z.preprocess((value) => {
  if (value === 'cli_blackbox') return 'cli';
  if (value === 'browser_blackbox') return 'browser';
  return value;
}, z.enum(['logic', 'cli', 'browser', 'manual', 'docs']));

/**
 * @task B-ef9c
 * @checklist CHK-003
 * @title normalize legacy verificationIntent type aliases
 * @type feature
 * @priority high
 * @description
 *   The shared CLI schema accepts legacy verificationIntent aliases before enum
 *   validation, so story_create, checklist_add, and checklist_update all parse
 *   cli_blackbox/browser_blackbox and persist the normalized cli/browser types.
 * @changes
 *   - [CHK-003] Map cli_blackbox to cli and browser_blackbox to browser in the shared schema
 *   - [CHK-003] Keep old testIntent types untouched; only verificationIntent is normalized
 */
export const verificationIntentItemSchema = z.object({
  id: z.string().optional().describe('Optional stable ID; defaults to an inferred value such as CHK-001:happy:0.'),
  desc: z.string().describe('Verification intent description.'),
  type: verificationIntentTypeSchema.describe('Verification type.'),
  requiredIn: z.enum(['light', 'balanced', 'strict']).optional().describe('Minimum workflow profile that requires this.'),
  priority: z.enum(['must', 'should', 'nice']).optional().describe('must enters the evidence gate.'),
});

/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title automated interface owns workflow extension
 * @type feature
 * @priority high
 * @description
 *   Proofbound exposes code/story operations through a managed automated interface:
 *   people and AI both go through CLI schemas, command gates, handlers, and logs.
 *   Superpowers can trigger workflow by registering extra tools and handlers, but
 *   main command definitions win because MAIN_TOOLS are searched before extras.
 * More precisely, code should be managed through an automated interface; both humans and AI operate on code through that interface.
 * @changes
 *   - [CHK-001] Preserve CLI schema/handler dispatch as the operation interface for humans and AI
 *   - [CHK-001] Allow superpowers to trigger workflow through extraRegister without redefining core workflow
 */

export const verificationIntentSchema = z.object({
  happy: z.array(verificationIntentItemSchema).optional().default([]),
  edge: z.array(verificationIntentItemSchema).optional().default([]),
  adversarial: z.array(verificationIntentItemSchema).optional().default([]),
});

export const verificationEvidenceKindSchema = z.enum([
  'logic_test',
  'integration_test',
  'browser_test',
  'manual_transcript',
  'docs_check',
  'waiver',
  'cli',
  'logic',
]).describe('Evidence type; aliases: cli to manual_transcript, logic to logic_test.');

export const verificationEvidenceSchema = z.object({
  intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID.'),
  kind: verificationEvidenceKindSchema,
  verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate.'),
  waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, this can mark temporary gate self-test evidence; later validate will require real evidence to replace it.'),
  file: z.string().optional().describe('Test or documentation file path.'),
  command: z.string().optional().describe('Command to run.'),
  result: z.enum(['pass', 'fail']).optional().describe('Command result.'),
  note: z.string().describe('Why this evidence satisfies the intent.'),
  headHash: z.string().optional().describe('git HEAD when evidence was recorded.'),
  materialHash: z.string().optional().describe('Non-story-metadata material file hash when evidence was recorded.'),
  timestamp: z.string().optional().describe('Recorded time.'),
});

export const reviewLoopDecisionSchema = z.enum([
  'continue',
  'retry',
  'revise',
  'rollback_required',
  'handoff_recommended',
  'human_gate_required',
  'close_candidate',
  'stop_blocked',
]);

export const reviewLoopTriggerRefSchema = z.string().trim().min(1);

export const reviewLoopTriggerSchema = z.object({
  findingIds: z.array(reviewLoopTriggerRefSchema).optional().describe('List of finding IDs that triggered the loop.'),
  bugIds: z.array(reviewLoopTriggerRefSchema).optional().describe('List of bug IDs that triggered the loop.'),
  validationFailureRefs: z.array(reviewLoopTriggerRefSchema).optional().describe('Validation failure references that triggered the loop.'),
  scopeViolationRefs: z.array(reviewLoopTriggerRefSchema).optional().describe('Scope violation references that triggered the loop.'),
}).refine((trigger) => (
  (trigger.findingIds?.length ?? 0) > 0 ||
  (trigger.bugIds?.length ?? 0) > 0 ||
  (trigger.validationFailureRefs?.length ?? 0) > 0 ||
  (trigger.scopeViolationRefs?.length ?? 0) > 0
), {
  message: 'must include at least one findingId, bugId, validationFailureRef, or scopeViolationRef',
});

export const gitObjectHashSchema = z.string().trim().regex(
  /^(?!([0-9a-f])\1+$)[0-9a-f]{40}(?:[0-9a-f]{24})?$/i,
  'must be a full Git object hash (40 or 64 hex characters), not a placeholder',
);

export const sha256HashSchema = z.string().trim().regex(
  /^(?!([0-9a-f])\1+$)[0-9a-f]{64}$/i,
  'must be a SHA-256 hex digest (64 hex characters), not a placeholder',
);

export const reviewLoopRollbackRefSchema = z.object({
  headHash: gitObjectHashSchema.describe('HEAD hash before the loop starts or the iteration begins.'),
  diffHash: sha256HashSchema.describe('Diff hash before the loop starts or the iteration begins.'),
  materialHash: sha256HashSchema.describe('Material hash before the loop starts or the iteration begins.'),
  scopeContractHash: sha256HashSchema.optional().describe('Optional scope contract hash.'),
});

export const reviewLoopHostSchema = z.object({
  hostId: z.string().min(1).describe('Host ID participating in this reflection iteration.'),
  capabilitySnapshotRef: z.string().min(1).optional().describe('Capability snapshot reference; recorded only and receipt is not verified.'),
  visibleDegradations: z.array(z.string().min(1)).optional().describe('Visible host degradations in this iteration.'),
});

export const reviewLoopReflectionSchema = z.object({
  progress: z.enum(['improved', 'unchanged', 'regressed']).describe('Whether this improved compared with the previous iteration.'),
  evidenceQuality: z.enum(['strong', 'medium', 'weak']).describe('Evidence quality for this iteration.'),
  failureType: z.enum(['prompt', 'context', 'tool', 'host', 'requirement', 'external']).optional().describe('Failure type.'),
  riskLevel: z.enum(['low', 'medium', 'high']).describe('Risk level for continuing the loop.'),
  rootCauseHypothesis: z.string().min(1).describe('Current root-cause hypothesis.'),
  nextPromptPatch: z.string().min(1).optional().describe('Suggested prompt patch for the next iteration; recorded only, not executed.'),
  recommendedDecision: reviewLoopDecisionSchema.describe('Reflection recommended decision.'),
  reason: z.string().min(1).describe('Recommendation reason.'),
  reusableLearning: z.string().min(1).optional().describe('Reusable lesson; contextual record, not gate evidence.'),
});

export const reviewLoopEvaluationSchema = z.object({
  progressScore: z.number().optional().describe('Progress score.'),
  riskScore: z.number().optional().describe('Risk score.'),
  regressionScore: z.number().optional().describe('Regression score.'),
  confidenceScore: z.number().optional().describe('Confidence score.'),
  costMeasured: z.boolean().optional().describe('Whether cost was actually measured; default false.'),
  costUsedUSD: z.number().optional().describe('Cost used this iteration; recorded only.'),
  timeUsedMs: z.number().optional().describe('Time used this iteration; recorded only.'),
  commandsRun: z.array(z.string().min(1)).optional().describe('Commands actually run this iteration.'),
  evidenceRefs: z.array(z.string().min(1)).optional().describe('Evidence refs referenced this iteration; receipts are not verified.'),
});

export const reviewLoopNextActionSchema = z.object({
  nextPrompt: z.string().min(1).optional().describe('Suggested next prompt; recorded only, not executed.'),
  rollbackCommandHint: z.string().min(1).optional().describe('Manual rollback command hint; recorded only, not executed.'),
  handoffHostId: z.string().min(1).optional().describe('Suggested handoff host; recorded only, no automatic handoff.'),
  humanQuestion: z.string().min(1).optional().describe('Question that requires a human answer.'),
});

export const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);
export const autopilotModeSchema = z.enum([
  'conservative',
  'authority-verified', // legacy retired alias; handler refuses it.
  'authority_verified', // legacy retired alias; handler refuses it.
  'full-autopilot', // legacy retired alias; handler refuses it.
  'full_autopilot', // legacy retired alias; handler refuses it.
]);

export const reviewEscalationFallbackEligibilitySchema = z.enum([
  'single-host-environment',
  'temporary-host-unavailability',
  'explicit-human-approval',
]);

export const capsuleEvidenceRefSchema = z.object({
  kind: z.string().optional(),
  path: z.string().optional(),
  intentRef: z.string().optional(),
  receiptId: z.string().optional(),
  processEventLine: z.number().optional(),
  authority: z.enum(['authoritative', 'non_authoritative']).optional(),
  note: z.string().optional(),
});

export const capsuleProcessEventRefSchema = z.object({
  line: z.number().optional(),
  type: z.string().optional(),
  digest: z.string().optional(),
  note: z.string().optional(),
});

export const backgroundSectionSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return normalizeBackgroundSection(value) ?? value;
}, z.enum(BACKGROUND_SECTION_IDS));

export const scopeFileRuleSchema = z.object({
  path: z.string().describe('Relative file path or simple glob covered by this semantic rule'),
  allowedAnchors: z.array(z.string()).optional().describe('Only these anchors may change'),
  deniedAnchors: z.array(z.string()).optional().describe('These anchors must not change'),
  protectedAnchors: z.array(z.string()).optional().describe('Hard-protected anchors'),
  allowedChangeKinds: z.array(z.enum(['add', 'remove', 'modify', 'rename'])).optional().describe('Allowed change kinds for matching hunks'),
  intentRefs: z.array(z.string()).optional().describe('Verification intent refs this rule protects'),
});

export const storyTypeSchema = z.preprocess((value) => {
  if (value === 'test') return 'chore';
  return value;
}, z.enum(['feature','bug','refactor','chore']));

export function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim().length > 0);
}

export function hasAnyNonEmptyStringArray(value: unknown, fields: string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return fields.some(field => hasNonEmptyStringArray(record[field]));
}
