import { ReviewerBatchAdmitArgsSchema } from '../core/reviewer-batch-admit-schema.js';
import { z } from 'zod';
import { findingSupersessionRequestSchema, canonicalSupersessionRequestSchema, historyQuerySchema, historyRecallSchema, scorecardQuerySchema } from '../core/finding-history.js';
import { candidateAddSchema, candidateGetSchema, candidateMergeSchema, candidateDisproveSchema, candidatePromoteSchema, identityConfirmSchema, identityQuerySchema } from '../core/finding-identity.js';
import { routeRequestSchema, routeRevokeSchema, routeVerifySchema, candidateRouteRequestSchema, routeSourceSchema } from '../core/finding-route.js';
import { progressCaptureSchema, progressPredecessorRequestSchema } from '../core/finding-progress.js';
import { publicToolCatalog, type ToolDef } from './main-tools.js';
import { STORY_OUTCOME_KINDS, VERIFICATION_EVIDENCE_VERDICTS } from '../core/types.js';
import {
  ContextPackDependencyEdgeContractSchema,
  ContextPackSnippetContractSchema,
  ContextPackSymbolContractSchema,
  VerificationCommandContractSchema,
  VerificationContextPackContractSchema,
} from '../core/authority-contracts.js';
import {
  STORY_CREATE_LONG,
  STORY_ADVANCE_LONG,
  CHECKLIST_UPDATE_LONG,
  STORY_REVIEW_LONG,
  BUG_REPORT_LONG,
  VALIDATE_LONG,
} from '../cli-prompts.js';
import {
  MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT,
  MEMORY_BENCHMARK_DEFAULT_SEED,
} from '../core/memory-benchmark.js';
// B-cdf6 (B-META F-012): the Zod bound and the handler's runtime re-validation import the
// SAME cap/default constants so the two layers can never drift apart.
import {
  DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  EVIDENCE_COMMAND_TIMEOUT_CAP_MS,
} from '../core/validation-executor.js';
// B-cdf6 (B-META F-013): same single-source discipline as F-012 above — the Zod bound and
// the runtime re-validation in codex-adapter-checks import the SAME cap/default/min
// constants, so the two layers can never drift apart.
import {
  DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS,
  GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS,
  HEARTBEAT_TIMEOUT_REASON_MIN_CHARS,
} from '../core/codex-adapter-checks.js';
import {
  autopilotModeSchema,
  backgroundSectionSchema,
  capsuleEvidenceRefSchema,
  capsuleProcessEventRefSchema,
  gitObjectHashSchema,
  hasAnyNonEmptyStringArray,
  hasNonEmptyStringArray,
  reviewEscalationFallbackEligibilitySchema,
  reviewLoopDecisionSchema,
  reviewLoopEvaluationSchema,
  reviewLoopHostSchema,
  reviewLoopNextActionSchema,
  reviewLoopReflectionSchema,
  reviewLoopRollbackRefSchema,
  reviewLoopTriggerRefSchema,
  reviewLoopTriggerSchema,
  scopeFileRuleSchema,
  sha256HashSchema,
  storyTypeSchema,
  stringOrStringArraySchema,
  verificationEvidenceKindSchema,
  verificationEvidenceSchema,
  verificationIntentItemSchema,
  verificationIntentSchema,
  verificationIntentTypeSchema,
} from './command-schemas.js';
import { AGENT_DISPATCH_ACCEPTED_TYPES } from '../core/agent-dispatch-registry.js';
import { STALL_RESOLUTION_ACTIONS } from '../core/review-convergence.js';
import { normalizeDeliveryPromiseOutcome } from '../core/delivery-promise-outcome.js';

// review_run_start accepts only canonical reviewer lanes. Runtime
// phase and evidence eligibility checks remain in core/review-run.ts.
const REVIEW_RUN_LANE_INPUTS = [
  'proof-or-stop-review-topology-critic',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-channel',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-delivery',
] as const;

const HIDDEN_LOCAL_ASSURANCE_REFUSAL = '@help-hidden local-assurance refusal sentinel';

const READ_ONLY_STATUS_UNSUPPORTED_FLAGS = {
  runCommands: z.never().optional().describe('Not a flag; status commands are read-only. Passing --runCommands is rejected by CLI validation.'),
  writeEvidence: z.never().optional().describe('Not a flag; status commands write no evidence. Passing --writeEvidence is rejected by CLI validation.'),
  advancePhase: z.never().optional().describe('Not a flag; status commands never advance phase. Passing --advancePhase is rejected by CLI validation.'),
  launchReviewers: z.never().optional().describe('Not a flag; status commands launch no reviewers. Passing --launchReviewers is rejected by CLI validation.'),
  authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  write: z.never().optional().describe('Not a flag; status commands are read-only. Passing --write is rejected by CLI validation.'),
  apply: z.never().optional().describe('Not a flag; status commands apply nothing. Passing --apply is rejected by CLI validation.'),
  execute: z.never().optional().describe('Not a flag; status commands execute nothing. Passing --execute is rejected by CLI validation.'),
  run: z.never().optional().describe('Not a flag; status commands run nothing. Passing --run is rejected by CLI validation.'),
  launch: z.never().optional().describe('Not a flag; status commands launch nothing. Passing --launch is rejected by CLI validation.'),
  capture: z.never().optional().describe('Not a flag; status commands capture nothing. Passing --capture is rejected by CLI validation.'),
  refresh: z.never().optional().describe('Not a flag; status commands refresh nothing. Passing --refresh is rejected by CLI validation.'),
} satisfies Record<string, z.ZodType>;

// B-7c05: brief-by-default output flags. --full restores the current verbose
// shape; --brief forces brief over the PROOF_OR_STOP_BRIEF_OUTPUT=0 env hatch.
// Rendering-only — no gate/state-machine change (validate deliberately excluded).
const BRIEF_OUTPUT_FLAGS = {
  full: z.boolean().optional().describe('Show the full (verbose) output instead of the brief default.'),
  brief: z.boolean().optional().describe('Force the brief output even when PROOF_OR_STOP_BRIEF_OUTPUT=0 is set.'),
} satisfies Record<string, z.ZodType>;

// B-7c05: explicit machine-JSON opt-in (frozen full shape) for commands whose
// default output is a JSON object and which did not previously expose it.
const JSON_OUTPUT_FLAGS = {
  format: z.enum(['text', 'json']).optional().describe('Output format; json returns the frozen full machine shape (default = brief).'),
  json: z.boolean().optional().describe('Shortcut for --format=json (frozen full machine shape).'),
} satisfies Record<string, z.ZodType>;

const inlineJsonObjectSchema = z.union([z.string(), z.object({}).passthrough()]);

const milestoneNotApplicableDecisionSchema = z.object({
  reason: z.string().min(1).describe('Non-empty scope reason the milestone row does not apply.'),
  decidedBy: z.string().min(1).describe('Human / agent identity of record for the exemption.'),
  decidedAt: z.string().min(1).describe('ISO timestamp the exemption was decided.'),
}).describe('Auditable justification required when status=not_applicable is to satisfy the DONE-gate not_applicable_missing_decision check.');

const proofStoryMilestoneSchema = z.object({
  id: z.string().min(1).describe('Stable milestone id, for example M1.'),
  sourceRequirementId: z.string().min(1).describe('Original intent key requirement id this milestone derives from.'),
  claim: z.string().min(1).describe('Milestone claim.'),
  doneMeans: z.string().min(1).describe('Observable completion rule.'),
  requiredEvidence: z.array(z.string()).optional().describe('Evidence kinds expected for this milestone.'),
  checklistRefs: z.array(z.string()).optional().describe('Checklist item ids that deliver this milestone.'),
  verificationIntentRefs: z.array(z.string()).optional().describe('Verification intent refs covering this milestone.'),
  parentLedgerId: z.string().min(1).optional().describe('Optional parent ledger row this milestone slices from.'),
  assignedStory: z.string().regex(/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe('Optional child story assigned to deliver this row.'),
  status: z.enum(['planned', 'covered', 'done', 'not_applicable']).optional().describe('Milestone coverage status.'),
  notApplicableDecision: milestoneNotApplicableDecisionSchema.optional().describe('Required auditable justification when status=not_applicable; omit for other statuses.'),
});

const proofStorySliceSchema = z.object({
  id: z.string().min(1).describe('Stable slice id, for example slice-1.'),
  milestoneIds: z.array(z.string().min(1)).min(1).describe('Milestone ids covered by this slice.'),
  reason: z.string().min(1).describe('Why these milestones belong together.'),
  assignedStory: z.string().regex(/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe('Optional child story assigned to this slice.'),
});

const proofStoryRollupChildSchema = z.object({
  storyId: z.string().regex(/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/).describe('Child story id.'),
  milestoneIds: z.array(z.string().min(1)).min(1).describe('Parent milestone ids covered by this child.'),
  status: z.enum(['planned', 'covered', 'done']).describe('Child coverage status. DONE equivalence consumes covered/done only.'),
  evidenceRefs: z.array(z.string().min(1)).optional().describe('Evidence refs proving child coverage.'),
});

const proofStoryAcceptanceBindingSchema = z.object({
  id: z.string().min(1).describe('Stable acceptance binding id.'),
  acceptanceClaim: z.string().min(1).optional().describe('Acceptance claim this binding covers; defaults to the original intent snapshot claim by convention.'),
  checklistRefs: z.array(z.string()).optional().describe('Checklist item ids bound to this acceptance claim.'),
  verificationIntentRefs: z.array(z.string()).optional().describe('Verification intent refs bound to this acceptance claim.'),
  milestoneIds: z.array(z.string()).optional().describe('Milestone ids bound to this acceptance claim.'),
  note: z.string().optional().describe('Reviewer-visible note.'),
  verificationTopology: z.record(z.string(), z.unknown()).optional().describe('Optional reference-only proofstory.acceptance_topology.v1 payload. Structural diagnostics are observe-only in Wave 1.'),
});

const proofStoryContractEnvelopeSchema = z.object({
  acceptanceBindings: z.array(proofStoryAcceptanceBindingSchema).optional().describe('Acceptance-to-checklist/verificationIntent bindings consumed by diagnostics and opt-in gate enforcement.'),
  note: z.string().optional().describe('Contract envelope note.'),
}).passthrough();

const proofStoryGateModeSchema = z.enum(['observe', 'warn', 'enforce']);

const runtimeEvidenceCommandSchema = z.object({
  executable: z.string().min(1).describe('Absolute executable path; runtime resolves the realpath and always uses shell=false.'),
  args: z.array(z.string()).optional().describe('Exact ordered argv passed to the executable.'),
  cwd: z.string().optional().describe('Project-relative working directory; traversal and realpath escape are refused.'),
});

const reviewerReadManifestSchema = z.object({
  filesReadFully: z.array(z.string()).describe('Relative files the reviewer read in full. Decisions-doc entries are mechanically compared to readLog; non-decision entries remain signed manifest evidence.'),
  filesTriagedByName: z.array(z.string()).describe('Relative files the reviewer only triaged by filename/title. Decisions-doc entries are mechanically compared to readLog; non-decision entries remain signed manifest evidence.'),
  scanEscalationReason: z.string().nullable().describe('Reason for full decisions-directory escalation, or null when no escalation occurred.'),
  candidateSpecSetDigest: z.string().optional().describe('Current candidate-spec-set artifact digest consumed by this reviewer.'),
  corpusDigest: z.string().optional().describe('Requirements corpus digest bound to the candidate set.'),
}).describe('Required reviewer read evidence: {filesReadFully:string[], filesTriagedByName:string[], scanEscalationReason:string|null}. Runtime rejects duplicates, unsafe paths, and malformed values.');
const reviewerReadTokenCountSchema = z.number().nonnegative().nullable();
const reviewerReadEventSchema = z.object({
  path: z.string().optional().describe('Relative or project-root absolute path read by the reviewer.'),
  filePath: z.string().optional().describe('Alias for path.'),
  file: z.string().optional().describe('Alias for path.'),
  absolutePath: z.string().optional().describe('Alias for path; runtime relativizes it against projectRoot.'),
  relPath: z.string().optional().describe('Alias for path.'),
  mode: z.string().optional().describe('Read mode, for example full or triage.'),
  action: z.string().optional().describe('Tool action, for example Read.'),
  kind: z.string().optional().describe('Tool event kind.'),
  readType: z.string().optional().describe('Read type alias.'),
  readFully: z.boolean().optional().describe('True for a full read, false for filename/title triage.'),
  tokenCount: reviewerReadTokenCountSchema.optional().describe('Observed token count for a full read, or null when unavailable.'),
  tokens: reviewerReadTokenCountSchema.optional().describe('Alias for tokenCount.'),
}).passthrough().describe('Mechanical reviewer read event captured from tool usage.');
const reviewerReadEventsSchema = z.array(reviewerReadEventSchema)
  .describe('Mechanical reviewer read events. Runtime keeps only proof-or-stop-review-* decisions-doc reads, derives the signed readLog digest/summary, and scopes mismatch diagnostics to decisions docs.');
const reviewerReadLogInputSchema = z.union([
  reviewerReadEventsSchema,
  z.object({ events: reviewerReadEventsSchema }).passthrough(),
]).describe('Mechanical reviewer read log input: either an array of read events or {events:[...]}. The CLI derives the persisted readLog digest/summary.');
const proofStoryIntentCollisionDecisionSchema = z.enum(['pass', 'revise_intent', 'human_gate', 'stop']);
const proofStorySpikePromotionSchema = z.enum(['red_evidence', 'verification_evidence', 'scope_decision', 'implementation_note']);
const proofStoryGreenRelationSchema = z.enum(['same_acceptance', 'regression_to_green', 'replacement']);
const parentRoadmapCaseSchema = z.enum(['full', 'partial', 'blocked', 'invalid', 'stale', 'migration', 'b-43de']);

/**
 * B-ab8d CHK-003: memory retrieval/consumption command FAMILIES, declared next
 * to the command catalog so the classification lives beside the command
 * registry itself — never a string-prefix guess inside the CLI engine.
 *
 * Families (experience-layer-ablation-causal-validation-execution-plan.md):
 * story recall, dev-memory store reads AND writes (capture/finish included —
 * store writes are forbidden during experiment runs), playbook lifecycle and
 * consumption, learning-signal scan/validation/effectiveness, and the
 * memory/playbook baseline benchmarks.
 *
 * The runtime gate does NOT consume these patterns: it keys off the
 * per-command `memoryRetrieval: true` marker in COMMAND_POLICIES
 * (core/command-policy.ts, same static-table pattern as `ownershipClass`).
 * These declared families exist so the arm-switch smoke / catalog cross-check
 * can mechanically assert the marker set stays exactly consistent with the
 * families: every MAIN_TOOLS command matching a family carries the marker and
 * no non-family command does.
 */
export const MEMORY_RETRIEVAL_COMMAND_FAMILIES: readonly RegExp[] = [
  /^recall$/,
  /^dev_memory_/,
  /^playbook_/,
  /^learning_scan$/,
  /^learning_validate$/,
  /^learning_effectiveness$/,
  /^memory_playbook_baseline_/,
] as const;

/** Whether a registered command name belongs to a memory retrieval/consumption family. */
export function matchesMemoryRetrievalFamily(commandName: string): boolean {
  if (typeof commandName !== 'string' || commandName.length === 0) return false;
  return MEMORY_RETRIEVAL_COMMAND_FAMILIES.some((family) => family.test(commandName));
}

/** CLI tool definitions bundled with main. */
const deliveryPromiseSchema = z.object({
  docPath: z.string().describe('Document path.'),
  promise: z.string().describe('Promise described in the document.'),
  // Runtime classification owns the stable contradiction reason, including
  // unknown strings; do not let a narrower enum mask it at the CLI boundary.
  status: z.any().optional().describe('Optional status: met, verified, waived, or unverified; runtime normalizer rejects non-strings.'),
  verifiedBy: z.any().optional().describe('Verification method; runtime normalizer rejects non-strings.'),
  evidence: z.any().optional().describe('Verification evidence; runtime normalizer rejects non-strings.'),
  waiverReason: z.any().optional().describe('Documentation promise waiver reason; runtime normalizer rejects non-strings and short waivers.'),
}).superRefine((promise, ctx) => {
  const result = normalizeDeliveryPromiseOutcome(promise);
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${result.code}: ${result.reason}`,
    });
  }
});

export const MAIN_TOOLS: ToolDef[] = [
  // Story
  { name: 'story_create', description: 'Create a Story entry', longHelp: STORY_CREATE_LONG, schema: {
    name: z.string().optional().describe('Short name.'),
    title: z.string().optional().describe('Title.'),
    description: z.string().optional().describe('Description.'),
    type: storyTypeSchema.optional().describe('Type; test is normalized to chore.'),
    priority: z.string().optional().describe('Priority.'),
    source: z.string().optional().describe('Source.'),
    depends: z.array(z.string()).optional().describe('Dependent Story ID.'),
    keywords: z.array(z.string()).optional().describe('Keywords (domain/module/concept, used for duplicate detection).'),
    checklist: z.array(z.object({
      title: z.string(),
      context: z.string().optional(),
      relatedDocs: z.array(z.string()).optional().describe('Related documentation paths used for the three reminders.'),
      userSees: z.string().optional().describe('User-visible output.'),
      excludes: z.array(z.string()).optional().describe('Explicitly declared out-of-scope functionality.'),
      files: z.object({
        modify: z.array(z.string()).optional(),
        create: z.array(z.string()).optional(),
        test: z.array(z.string()).optional(),
      }).optional().describe('Affected file declarations used by story intake and review gates.'),
      verificationIntent: verificationIntentSchema.optional().describe('Happy-path, edge-case, and adversarial verification intent.'),
    })).optional().describe('Development checklist.'),
    milestones: z.array(proofStoryMilestoneSchema).optional().describe('Optional explicit machine-countable milestone rows. When supplied, story_create writes a candidate milestone ledger; no rows means no ledger is inferred from prose or checklist text.'),
    scopeBoundary: z.object({
      mode: z.enum(['correctness_fix', 'feature', 'maintenance', 'custom']).optional().describe('Scope boundary mode; correctness_fix enables the default future denylist.'),
      allowed: z.array(z.string().min(1)).optional().describe('Scope entries the user confirmed as allowed.'),
      allowedScope: z.array(z.string().min(1)).optional().describe('Compatibility alias for allowed.'),
      excluded: z.array(z.string().min(1)).optional().describe('Scope entries the user confirmed as excluded or not to be done.'),
      excludedScope: z.array(z.string().min(1)).optional().describe('Compatibility alias for excluded.'),
      userConfirmed: z.boolean().describe('Must be true: confirms this is the user-confirmed INIT scope boundary.'),
      confirmation: z.string().optional().describe('Confirmation note or source excerpt.'),
      actor: z.string().optional().describe('Recorded by; defaults to story_create.'),
    }).refine(
      value => hasAnyNonEmptyStringArray(value, ['allowed', 'allowedScope']),
      { message: 'scopeBoundary requires at least one allowed/allowedScope entry' },
    ).optional().describe('Optional: story_create writes scope-boundary.json synchronously; otherwise run scope_boundary_set during INIT.'),
    executionBoundary: z.object({
      allowedCommands: z.array(z.string().min(1)).optional().describe('Allowed command patterns for execution or verification.'),
      allowedTools: z.array(z.string().min(1)).optional().describe('Allowed tool or adapter names.'),
      allowedPaths: z.array(z.string().min(1)).optional().describe('Allowed relative paths; rejects absolute paths and .. traversal.'),
      excludedCommands: z.array(z.string().min(1)).optional().describe('Explicitly blocked command patterns.'),
      excludedTools: z.array(z.string().min(1)).optional().describe('Explicitly blocked tool or adapter names.'),
      excludedPaths: z.array(z.string().min(1)).optional().describe('Explicitly blocked relative paths; rejects absolute paths and .. traversal.'),
      blockedPaths: z.array(z.string().min(1)).optional().describe('Compatibility alias for excludedPaths.'),
      confirmation: z.string().optional().describe('Execution-boundary confirmation note.'),
      actor: z.string().optional().describe('Recorded by; defaults to story_create.'),
    }).refine(
      value => hasAnyNonEmptyStringArray(value, ['allowedCommands', 'allowedTools', 'allowedPaths', 'excludedCommands', 'excludedTools', 'excludedPaths', 'blockedPaths']),
      { message: 'executionBoundary requires at least one allowed/excluded command, tool, or path entry' },
    ).optional().describe('Optional: story_create writes execution-boundary.json synchronously; otherwise run execution_boundary_set during INIT.'),
    prefix: z.string().optional().describe('ID prefix (default: B).'),
    phase: z.enum(['IDEA','INIT'], {
      error: () => 'story_create phase must be IDEA or INIT; post-intake lifecycle phases require story_advance. [story_create_direct_lifecycle_phase_forbidden]',
    }).optional().describe('Optional intake phase. Post-intake lifecycle phases require story_advance.'),
    forceNew: z.boolean().optional().describe('B-0af4: bypass same-name story idempotency and force creation; unfinished same-name stories are reused by default.'),
    background: z.string().optional().describe('B-45ed CHK-006: four-section background.md content. Must include Trigger Event, Key Insight, Tradeoff, and Conversation Texture sections; each section at least 50 characters, total at least 300, and Trigger Event must include a concrete ID (B-xxxx / F-xxx / CHK-xxx / commit hash / YYYY-MM-DD). Not required in fromDraft mode.'),
    fromDraft: z.string().optional().describe('B-9975: create a story from a reviewed draft by passing draft name. Conservatively stops in INIT, then follows normal INIT_CHECK gates.'),
    reproFirstBypassReason: z.string().min(10).optional().describe('Documented STORY_INTAKE exception for emergency/non-reproducible work; later lifecycle gates still require binding for code-declaring stories.'),
  }},
  { name: 'story_advance', description: 'Advance a Story to the next phase', longHelp: STORY_ADVANCE_LONG, schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).describe('Target phase.'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('Development checklist.'),
    dryRun: z.boolean().optional().describe('Preview INIT_CHECK bootstrap only; do not advance phase or create worktree.'),
    confirm: z.boolean().optional().describe('Confirm a side-effecting advance (compatible script argument).'),
    reason: z.string().optional().describe('B-8b69: required when reopening PLAN->INIT (phase=INIT from PLAN); explains why the frozen checklist title/context must change. Ignored for other transitions.'),
  }},
  { name: 'story_update', description: 'Edit Story metadata', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('New title.'),
    description: z.string().optional().describe('New description.'), priority: z.string().optional().describe('New priority.'),
    agent: z.string().optional().describe('Actor; INIT reviewer lanes may not directly change story-level scope fields.'),
    actor: z.string().optional().describe('Actor alias; INIT reviewer lanes may not directly change story-level scope fields.'),
  }},
  { name: 'story_resume', description: 'Append a signed human continuation decision after two complete stagnant review epochs; requires an interactive session and explicit acknowledgement', schema: {
    storyId: z.string().describe('Story ID of the frozen story.'),
    ack: z.boolean().optional().describe('Required: confirms a human is deliberately clearing the freeze.'),
    reason: z.string().optional().describe('Required human explanation (>=10 chars) of why it is safe to continue.'),
  }},
  { name: 'story_get', description: 'Read Story details; include all index.json fields in result.index', schema: {
    storyId: z.string().describe('Story ID'),
    detail: z.boolean().optional().describe('Attach all index.json fields (phase/priority/name/description/...) to result.index.'),
    slim: z.boolean().optional().describe('Opt-in compact status view. Default output is unchanged when omitted.'),
    fields: z.array(z.string()).optional().describe('Opt-in top-level field filter. With slim=true, filter the compact story/checklist/review/initCheck fields.'),
  }},
  { name: 'story_list', description: 'List all Stories', schema: {
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE','DISCARDED']).optional().describe('Filter by phase (mutually exclusive with active).'),
    active: z.boolean().optional().describe('List only non-terminal stories (exclude DONE/DISCARDED/IDEA). Added by B-89c7 CHK-016.'),
    ...BRIEF_OUTPUT_FLAGS,
    ...JSON_OUTPUT_FLAGS,
  }},
  { name: 'story_resolve', description: 'Resolve a story phase and authoritative cwd for planned steps. Alias: proof-or-stop story resolve', schema: {
    storyId: z.string().describe('Story ID to resolve'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_reconcile', description: 'Detect and repair zombie Stories or terminal worktree residue (default dry run)', schema: {
    dryRun: z.boolean().optional().describe('true=report only; false=perform repair (default true).'),
  }},
  { name: 'identity_state_migrate', description: 'One-shot, digest-verified migration of one exact story from retired state storage to canonical Proof-or-Stop storage', schema: {
    id: z.string().describe('Exact story id to migrate.'),
    confirm: z.boolean().optional().describe('Required true to perform the migration; omitted is dry-run.'),
  }},
  { name: 'story_discard', description: 'Discard a Story: clean up its worktree and branch, then mark it DISCARDED', schema: {
    storyId: z.string().describe('Story ID'),
    reason: z.string().optional().describe('Discard reason (written to event log).'),
    force: z.boolean().optional().describe('Force-discard uncommitted changes.'),
    purge: z.boolean().optional().describe('Temporary-story only: delete story metadata and safely revert metadata-only init commit when safe.'),
  }},
  // B-804c CHK-002: expose the idempotent dev_start handler as a recovery command
  // for a story stuck in INIT_CHECK with no worktree on disk (or after an atomic
  // bootstrap-failure left it at INIT). The generic dispatcher routes name ->
  // handlers.dev_start automatically. Idempotent: returns the existing path when a
  // worktree already exists; enforces the INIT scope-anti-expansion freeze gate.
  { name: 'dev_start', description: '(Re-)bootstrap a Story worktree; recovery command for a story stuck without a worktree', longHelp:
`proof-or-stop dev_start '{"storyId":"B-xxxx"}'

Recovery / (re-)bootstrap command for the worktree of a single story.

When to use:
  - A story is stuck in INIT_CHECK with no worktree on disk (e.g. a prior
    INIT_CHECK bootstrap failed before B-804c made the phase write atomic), and
    the forward-only machine has no INIT_CHECK->INIT back-edge to retry.
  - A story is at INIT after an atomic story_advance INIT_CHECK bootstrap-failure
    and you want to bootstrap directly after fixing the cause.

Behavior:
  - Creates the story/<storyId> branch (if missing) and the worktree under the
    configured worktreeDir, then prints its Path.
  - Idempotent: if the worktree already exists it returns the existing path
    without error.
  - Enforces the INIT scope-anti-expansion freeze gate: an unfrozen INIT story is
    refused (dev_start cannot bypass the freeze gate).
  - Allowed only in INIT / INIT_CHECK / PLAN / DEV; refused in REVIEW / TEST / DONE.
  - Owner-lease gated (storyScopedMutating): a non-owner session is refused.`,
    schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // Draft (B-9975: iterate on story shape before formal story_create)
  { name: 'story_draft', description: 'Create a draft without a B-xxxx ID; write it to docs/story/drafts/<name>/', schema: {
    name: z.string().describe('Short name (letters, digits, and hyphens; 3-60 characters).'),
    title: z.string().describe('Title (at least 5 characters).'),
    description: z.string().describe('Description (at least 5 characters).'),
    type: storyTypeSchema.describe('Type; test is normalized to chore.'),
    priority: z.string().describe('Priority.'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional() })).describe('Development checklist (at least 1 item).'),
    background: z.string().describe('Four-section background.md content (required; same validation as story_create).'),
    keywords: z.array(z.string()).optional().describe('Keywords.'),
  }},
  { name: 'story_draft_list', description: 'List all drafts', schema: {} },
  { name: 'story_draft_discard', description: 'Delete the specified draft', schema: {
    name: z.string().describe('Name of the draft to delete.'),
  }},
  { name: 'draft_check_set', description: 'Save draft check results (reviewer-called; signs draft background and checklist)', schema: {
    draftName: z.string().describe('Draft name.'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Reviewer-assigned ID, for example INIT-001; optional and auto-assigned.'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity.'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character.').describe('Issue details.'),
    })).describe('List of issues raised by the reviewer; empty array is allowed.'),
    agentId: z.string().optional().describe('Reviewer self-reported agent ID, used only for audit tracing.'),
  }},
  { name: 'draft_issue_resolve', description: 'Write a resolution for an issue in a draft check (at least 20 characters)', schema: {
    draftName: z.string().describe('Draft name.'),
    issueId: z.string().describe('Issue ID, for example INIT-001.'),
    resolution: z.string().min(20, 'resolution must be at least 20 characters.').describe('Written resolution conclusion.'),
  }},

  // Review
  { name: 'story_review', description: 'Adversarially review checklist completeness', longHelp: STORY_REVIEW_LONG, schema: {
    storyId: z.string().describe('Story ID'),
    ...BRIEF_OUTPUT_FLAGS,
    ...JSON_OUTPUT_FLAGS,
  }},
  { name: 'story_review_dismiss', description: 'Dismiss a falsely reported riskSignal category (B-5010)', schema: {
    storyId: z.string().describe('Story ID'),
    category: z.string().describe('riskSignal.category to dismiss, for example state machine/gate or test runner framework.'),
    reason: z.string().describe('Dismissal reason (at least 5 characters); explain why this signal is a false positive for the story.'),
  }},
  { name: 'testintent_handoff', description: 'Generate a test-intent agent handoff packet (PLAN phase)', schema: {
    storyId: z.string().describe('Story ID'),
    itemIds: z.array(z.string()).optional().describe('Hand off only specified checklist item IDs; defaults to all.'),
  }},

  // Checklist
  { name: 'checklist_get', description: 'Read the checklist', schema: {
    storyId: z.string().describe('Story ID'),
    proposalFor: z.string().optional().describe('Read-only current baseIntentHash for this checklist item; combine with proposalIntent to compute an exact approval digest.'),
    proposalIntent: verificationIntentSchema.optional().describe('Proposed intent JSON; with proposalFor returns digest only, never applies or approves the proposal.'),
    slim: z.boolean().optional().describe('Opt-in compact checklist view. Default output is unchanged when omitted.'),
    fields: z.array(z.string()).optional().describe('Opt-in top-level field filter. With slim=true, filter storyId/counts/items.'),
  }},
  { name: 'frozen_claim_drift_check', description: 'B-2296 Phase 1: read-only, non-blocking FROZEN_CLAIM_DRIFT advisory — reports checklist userSees whose normalized claim OR story-owned material (storyFilesHash) drifted since attestation; classifies no-snapshot userSees as legacy-unbound.', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output the structured advisory array + summary object as JSON.'),
  }},
  { name: 'checklist_add', description: 'Append a checklist item to an existing story', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().describe('What to do, in one sentence.'),
    context: z.string().optional().describe('Root cause or reference approach.'),
    relatedDocs: z.array(z.string()).optional().describe('Related documentation paths used for the three reminders.'),
    userSees: z.string().optional().describe('Specific terminal/UI text the user sees after completing this item.'),
    excludes: z.array(z.string()).optional().describe('Explicitly declared out-of-scope functionality.'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: affected file set declared in PLAN; story_review checks touchpoints-to-files coverage.'),
    verificationIntent: verificationIntentSchema.optional().describe('Happy-path, edge-case, and adversarial verification intent (PLAN phase).'),
    reason: z.string().optional().describe('Required replan/scope audit reason when adding an item during PLAN (at least 10 characters).'),
    agent: z.string().optional().describe('Actor or agent lane; INIT reviewer lanes may not directly change requirement definitions.'),
    actor: z.string().optional().describe('Actor alias; INIT reviewer lanes may not directly change requirement definitions.'),
  }},
  { name: 'checklist_remove', description: 'Remove a checklist item from a story; requires disposition and justification', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('ID of the item to remove.'),
    disposition: z.enum(['accept', 'reject', 'partial']).describe('Disposition: accept=deletion is valid, reject=should not be deleted but remove it, partial=partially valid.'),
    justification: z.string().describe('Deletion justification (at least 10 characters).'),
    agent: z.string().optional().describe('Actor identity; INIT reviewers cannot remove requirements.'),
    actor: z.string().optional().describe('Actor alias; cannot hide a dispatched INIT reviewer.'),
  }},
  { name: 'checklist_update', description: 'Update a checklist item (status/relatedDocs; title/context/userSees frozen)', longHelp: CHECKLIST_UPDATE_LONG, schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('Item ID.'),
    status: z.enum(['pending','in_progress','done','withdrawn']).optional().describe("New status. 'withdrawn' is REFUSED here — it may only be set by scope_shrinkage_decision_set (the sole authorized applier)."),
    title: z.string().optional().describe('New title; frozen starting in PLAN.'),
    context: z.string().optional().describe('New context; frozen starting in PLAN.'),
    relatedDocs: z.array(z.string()).optional().describe('Related documentation paths used for the three reminders.'),
    userSees: z.string().optional().describe('Specific terminal/UI text the user sees after completing this item; writable before PLAN and frozen from DEV.'),
    excludes: z.array(z.string()).optional().describe('Explicitly declared out-of-scope functionality; INIT reviewer lanes may not modify directly.'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: affected file set declared in PLAN.'),
    verificationIntent: verificationIntentSchema.optional().describe('Happy-path, edge-case, and adversarial verification intent; frozen from DEV.'),
    intentProposalApproval: z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),baseIntentHash:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().min(30)}).strict().optional().describe('PLAN owner approval of exact proposed intent bytes, bound to Story/item and prior intent hash. Intent-only payload; preserves lease and does not attest independent authorship.'),
    verificationEvidence: z.array(verificationEvidenceSchema).optional().describe('Evidence list covering verificationIntent.'),
    reason: z.string().optional().describe('Change reason.'), agent: z.string().optional().describe('Actor.'),
    actor: z.string().optional().describe('Actor alias; INIT reviewer lanes may not directly change requirement definitions.'),
    success: z.boolean().optional().describe('Feeds the subagent_result process event (success flag) when status=done; default true. NOT persisted on the checklist item.'),
  }},
  { name: 'verification_evidence_add', description: 'Add or update evidence satisfying a checklist item\'s verificationIntent', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID'),
    intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID.'),
    kind: verificationEvidenceKindSchema,
    verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate.'),
    waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, this can mark temporary gate self-test evidence.'),
    file: z.string().optional().describe('Test or documentation file path.'),
    command: z.string().optional().describe('Command to run. For logic|cli|browser, or a docs/manual intent deliberately given a verifier, this is the pinned command the tool RUNS; executable+argv only (no raw shell); pinned immutably on the first selector-bearing write.'),
    selector: z.string().optional().describe('B-ec67: proof selector — a string that MUST appear in the pinned command output. Providing it with command pins the intent verifier (including a mechanically checked docs/manual intent) and makes evidence tool-executed; result is derived from the actual exit + selector match.'),
    result: z.enum(['pass', 'fail']).optional().describe('Command result. For a tool-executed (pinned) executable intent this is DERIVED from the receipt and a contradicting caller pass is refused.'),
    note: z.string().describe('Why this evidence satisfies the intent.'),
    nonMechanicalReason: z.string().min(30, 'nonMechanicalReason must be ≥ 30 characters').optional().describe('B-ec67 audited escape: record a non-mechanical attestation for an executable intent WITHOUT execution (execution impossible in this environment). Attributable + gate-visible; never grants coverage.'),
    commandTimeoutMs: z.number().int().positive().max(EVIDENCE_COMMAND_TIMEOUT_CAP_MS, `commandTimeoutMs must be ≤ ${EVIDENCE_COMMAND_TIMEOUT_CAP_MS}ms`).optional().describe(`B-cdf6 bounded audited override: raise the pinned command's wall-clock ceiling above the ${DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS}ms default so a legitimately long witness (e.g. the root DONE-blocking suite) can earn a REAL receipt. Requires commandTimeoutReason. Cap ${EVIDENCE_COMMAND_TIMEOUT_CAP_MS}ms (the framework's own longest sanctioned budget); above the cap is REFUSED, never clamped. The armed budget + reason are stamped on the tool-owned receipt (gate-visible). NOTE: the outer CLI watchdog (5 min idle / 15 min total by default) still applies.`),
    commandTimeoutReason: z.string().min(30, 'commandTimeoutReason must be ≥ 30 characters').optional().describe('B-cdf6: attributable justification REQUIRED whenever commandTimeoutMs is supplied (same spirit as nonMechanicalReason). Recorded on the receipt so a reviewer sees the receipt was earned under a raised budget.'),
  }},
  { name: 'verification_evidence_batch_add', description: 'Batch add/update verificationIntent coverage evidence (concurrency-safe)', schema: {
    storyId: z.string().describe('Story ID'),
    evidences: z.array(z.object({
      itemId: z.string().describe('Checklist item ID'),
      intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID.'),
      kind: verificationEvidenceKindSchema,
      verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate.'),
      waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, this can mark temporary gate self-test evidence.'),
      file: z.string().optional().describe('Test or documentation file path.'),
      command: z.string().optional().describe('Command to run. For logic|cli|browser, or a docs/manual intent deliberately given a verifier, this is the pinned command the tool RUNS; executable+argv only (no raw shell); pinned immutably on the first selector-bearing write.'),
      selector: z.string().optional().describe('B-ec67: proof selector — a string that MUST appear in the pinned command output. Providing it with command pins the intent verifier (including a mechanically checked docs/manual intent) and makes evidence tool-executed.'),
      result: z.enum(['pass', 'fail']).optional().describe('Command result. For a tool-executed (pinned) executable intent this is DERIVED from the receipt and a contradicting caller pass is refused.'),
      note: z.string().describe('Why this evidence satisfies the intent.'),
      nonMechanicalReason: z.string().min(30, 'nonMechanicalReason must be ≥ 30 characters').optional().describe('B-ec67 audited escape for an executable intent: record a non-mechanical attestation WITHOUT execution. Attributable + gate-visible; never grants coverage.'),
      commandTimeoutMs: z.number().int().positive().max(EVIDENCE_COMMAND_TIMEOUT_CAP_MS, `commandTimeoutMs must be ≤ ${EVIDENCE_COMMAND_TIMEOUT_CAP_MS}ms`).optional().describe(`B-cdf6 bounded audited override: raise this entry's pinned command ceiling above the ${DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS}ms default. Requires commandTimeoutReason; above the ${EVIDENCE_COMMAND_TIMEOUT_CAP_MS}ms cap is REFUSED, never clamped. One invalid entry fails the whole batch before any command runs.`),
      commandTimeoutReason: z.string().min(30, 'commandTimeoutReason must be ≥ 30 characters').optional().describe('B-cdf6: attributable justification REQUIRED whenever commandTimeoutMs is supplied. Recorded on the tool-owned receipt (gate-visible).'),
    })).describe('Evidence array; reads and writes the checklist once in the same call.'),
  }},
  { name: 'verification_run', description: 'B-1507: execute an intent\'s PINNED verifier and atomically record the tool-executed receipt (the caller never authors the command)', schema: {
    storyId: z.string().describe('Story ID'),
    intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID. Resolved to its owning item\'s pinned verification:{command,selector}; the pinned command is what runs.'),
    itemId: z.string().optional().describe('Checklist item ID owning the intent; optional — inferred from the intentRef when omitted.'),
    note: z.string().optional().describe('Why this run covers the intent; a descriptive default is recorded when omitted or shorter than 5 characters.'),
    cwd: z.string().optional().describe('Working directory for the pinned command; defaults to the resolved story git root (relative paths resolve against it).'),
  }},
  { name: 'verification_pin_narrow', description: 'B-1482: NARROWING-ONLY re-pin of an executable intent\'s proof selector. The pinned COMMAND never changes and a broader selector is always refused. Only current signed authoritative VerificationReceiptBundleV5 receipts recorded by this tool for that pinned command may be proof witnesses; legacy combined and Bundle V2/V3/V4 receipts remain audit-readable but are rejected with narrowing_recorded_receipt_not_authoritative — record current signed V5 evidence first. All direction, presence, and absence checks use complete authenticated output artifacts; outputTail is display-only and a mismatched projection is rejected with narrowing_recorded_receipt_invalid. No transcript, output or receipt is an input, and a recorded-receipt set admits at most ONE narrowing.', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID owning the intent.'),
    intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID. Must already carry a verification pin.'),
    selector: z.string().min(1, 'selector must be a non-empty string').describe('The NEW, stricter selector. Accepted only when current signed authoritative VerificationReceiptBundleV5 witnesses prove it stricter: absent from the complete authenticated output of at least one recorded FAILING render the current selector matched, and present in EVERY recorded passing output artifact.'),
    reason: z.string().min(30, 'reason must be \u2265 30 characters').describe('Attributable justification for why the pinned selector is not discriminating. Retained on the narrowing record; never itself the proof.'),
  }},
  { name: 'verification_evidence_refresh_stale', description: 'Safely refresh stale verificationEvidence by selector-free execution identity. A proven-unchanged policy-owned capsule may reuse immutable evidence with zero subprocesses; otherwise freshness fails closed to at most one real rerun per affected execution key. Timeout/nonzero failure demotes every dependent row, selector mismatch demotes only that row, and no independently passing assertion means no pass receipt.', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('Report stale evidence that would be refreshed, without writing.'),
  }},
  { name: 'verification_intent_recover', description: 'Owner-only recovery of the exact signed acceptance checkpoint after missing/corrupt history or interrupted canonical publication. Default inspects the checkpoint without writes; apply requires its current digest and a reason. No test runs or evidence re-attestation.', schema: {
    storyId:z.string(), expectedCheckpointDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),reason:z.string().min(30).optional(),apply:z.boolean().optional(),
  }},
  { name: 'verification_intent_append', description: 'Owner-only DEV repair: append signed must-level executable acceptance within an existing item scope. Original intents and scope remain unchanged; new coverage and fresh final review remain mandatory.', schema: {
    storyId: z.string(), itemId: z.string(), expectedIntentHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().min(30),
    addition: z.object({happy:z.array(z.object({id:z.string(),desc:z.string(),type:z.enum(['cli','logic','browser']),priority:z.literal('must')}).strict()).optional(),edge:z.array(z.object({id:z.string(),desc:z.string(),type:z.enum(['cli','logic','browser']),priority:z.literal('must')}).strict()).optional(),adversarial:z.array(z.object({id:z.string(),desc:z.string(),type:z.enum(['cli','logic','browser']),priority:z.literal('must')}).strict()).optional()}).strict(),
  }},
  { name: 'verification_intent_repair', description: 'Controlled legacy repair: back-fill only the missing verificationIntent lanes inferred from existing PASSING verificationEvidence (never overwrites authored intent; synthesized intent uses should priority)', schema: {
    storyId: z.string().describe('Story ID'),
    mode: z.literal('fromEvidence').describe('Only supported mode: infer the missing intent from verificationEvidence.intentRef'),
    legacyRepair: z.boolean().describe('Must be passed explicitly as true: confirms this is a legacy data backfill, not the normal PLAN flow'),
    reason: z.string().min(30, 'reason must be at least 30 characters.').describe('Why the legacy repair is needed, and what you verified'),
    dryRun: z.boolean().optional().describe('Report only the intent entries that would be generated; do not write them'),
  }},
  { name: 'verification_context_pack_create', description: 'Generate a Verification Context Pack from the current git diff for verifier jobs', schema: {
    producerRunId: z.string().min(1).describe('Implementer run ID.'),
    storyId: z.string().optional().describe('Story ID'),
    baseRef: z.string().optional().describe('Diff base ref, default HEAD.'),
    headRef: z.string().optional().describe('Diff head ref; default WORKTREE means uncommitted worktree.'),
    packId: z.string().optional().describe('Explicit pack ID; defaults to a stable ID generated from the diff.'),
    checklistItemIds: z.array(z.string()).optional().describe('Checklist item IDs associated with this pack.'),
    testIntentRefs: z.array(z.string()).optional().describe('verificationIntent refs this pack must cover.'),
    acceptanceCriteria: z.array(z.string()).optional().describe('Acceptance criteria summary.'),
    requiredRefs: z.array(z.string()).optional().describe('Additional required refs.'),
    requiredCommands: z.array(VerificationCommandContractSchema).optional().describe('Command contracts the verifier must run or cover.'),
    oracleRefs: z.array(z.string()).optional().describe('oracle refs'),
    tokenBudget: z.number().int().nonnegative().optional().describe('source snippets token budget'),
    excludedPaths: z.array(z.string()).optional().describe('Excluded paths included in the pack for audit.'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata.'),
  }},
  { name: 'verification_context_pack_expand', description: 'Generate a controlled expansion pack from the parent pack (reason required)', schema: {
    parentPack: VerificationContextPackContractSchema.describe('Previous Verification Context Pack.'),
    packId: z.string().optional().describe('New pack ID.'),
    expansionReason: z.string().min(10).describe('Expansion reason (at least 10 characters).'),
    impactedFiles: z.array(z.string()).optional().describe('Added impacted files.'),
    impactedSymbols: z.array(ContextPackSymbolContractSchema).optional().describe('Added impacted symbols.'),
    sourceSnippets: z.array(ContextPackSnippetContractSchema).optional().describe('Added source snippets.'),
    dependencyEdges: z.array(ContextPackDependencyEdgeContractSchema).optional().describe('Added dependency edges.'),
    requiredRefs: z.array(z.string()).optional().describe('Added required refs.'),
    tokenBudget: z.number().int().nonnegative().optional().describe('New token budget.'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata.'),
  }},
  // B-a2f1 CHK-003: single-shot recover — refresh stale evidence + revalidate.
  { name: 'recover_evidence', description: 'Refresh stale evidence and revalidate in a single shot', schema: {
    storyId: z.string().min(1).describe('Story ID'),
  }},
  // B-cf60: per-story declared product artifact — register a generated path so
  // the dirty-worktree classifier groups it under declared_artifact_changes
  // instead of unexpected_dirty_files. DONE gate then checks every declared
  // path is referenced from verificationEvidence or delivery-check.docsPromises.
  { name: 'artifact_declare', description: 'Declare an expected generated artifact for this Story', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    path: z.string().min(1).describe('Exact path relative to the repository root; no globs, wildcards, leading slash, or .. segments.'),
    reason: z.string().min(10, 'reason ≥ 10 characters').describe('Why this file is declared as an expected output of this story.'),
    relatedIntent: z.string().min(1).describe('Related reference: CHK-NNN:(happy|edge|adversarial):IDX or promise:<docPath>.'),
  }},
  { name: 'artifact_release_list', description: 'List non-runtime artifact release provenance records', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    limit: z.number().int().positive().optional().describe('Maximum number of recent records to show (default 20, max 200).'),
  }},
  { name: 'artifact_release_status', description: 'Show non-runtime artifact release provenance records for one Story', schema: {
    storyId: z.string().min(1).describe('Story ID to inspect.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
  }},
  { name: 'capability_release_list', description: 'List non-runtime product capability release provenance records', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    limit: z.number().int().positive().optional().describe('Maximum number of recent records to show (default 20, max 200).'),
  }},
  { name: 'capability_release_status', description: 'Show non-runtime product capability release provenance records for one Story', schema: {
    storyId: z.string().min(1).describe('Story ID to inspect.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
  }},
  { name: 'capability_release_backfill', description: 'Record-then-bind migration: dry-run default links under-bound candidate playbooks (recording a capability release from a story’s artifact release when none exists) to their capability release; --apply requires the current plan --digest', schema: {
    storyId: z.string().min(1).optional().describe('Optional single-story filter (only candidates whose lineage.sourceStoryId matches).'),
    dryRun: z.boolean().optional().describe('Preview eligible candidates (plan=bind or record-then-bind) + plan digest without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Record any missing capability release (from the story’s artifact release; git add -f + commit) then enrich the eligible candidates’ lineage with capabilityReleaseId/capabilityId/capabilityVersion/artifactReleaseId. Requires --digest; never activates, never changes status, never records outcomes.'),
    digest: z.string().optional().describe('Current dry-run planDigest required for --apply; refuses on drift.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'scope_boundary_set', description: 'Save the user-confirmed allowed/excluded scope boundary for the INIT_CHECK gate', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    mode: z.enum(['correctness_fix', 'feature', 'maintenance', 'custom']).optional().describe('Scope boundary mode; correctness_fix enables default future-capability keyword exclusions.'),
    allowedScope: z.array(z.string().min(1)).min(1).describe('Scope entries the user confirmed as allowed.'),
    excludedScope: z.array(z.string().min(1)).optional().describe('Scope entries the user confirmed as excluded or not to be done.'),
    userConfirmed: z.boolean().describe('Must be true: confirms this is the user-confirmed INIT scope boundary.'),
    confirmation: z.string().optional().describe('Confirmation note or source excerpt.'),
    actor: z.string().optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main-agent.'),
  }},
  { name: 'execution_boundary_set', description: 'Save INIT execution boundaries (command/tool/path allow/block) for the gate', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    allowedCommands: z.array(z.string().min(1)).optional().describe('Allowed command patterns for execution or verification.'),
    blockedCommands: z.array(z.string().min(1)).optional().describe('Explicitly blocked command patterns (alias: excludedCommands).'),
    excludedCommands: z.array(z.string().min(1)).optional().describe('Explicitly blocked command patterns.'),
    allowedTools: z.array(z.string().min(1)).optional().describe('Allowed tool or adapter names.'),
    excludedTools: z.array(z.string().min(1)).optional().describe('Explicitly blocked tool or adapter names.'),
    allowedPaths: z.array(z.string().min(1)).optional().describe('Allowed relative paths; rejects absolute paths and .. traversal.'),
    blockedPaths: z.array(z.string().min(1)).optional().describe('Explicitly blocked relative paths; rejects absolute paths and .. traversal.'),
    excludedPaths: z.array(z.string().min(1)).optional().describe('Explicitly blocked relative paths.'),
    notes: z.string().optional().describe('Additional execution-boundary notes.'),
    actor: z.string().optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main-agent.'),
  }},
  { name: 'scope_freeze_check', description: 'Write the INIT scope freeze check result (accepted extensions stale old freeze)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    status: z.enum(['PASS', 'FAIL', 'pass', 'fail']).optional().describe('Optional assertion; cannot override the core evaluateScopeFreeze result.'),
    note: z.string().optional().describe('Freeze-check note; can also serve as repeated-discard mitigation text.'),
    repeatDiscardMitigation: z.string().optional().describe('Mitigation note for repeated discarded direction.'),
    actor: z.string().optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main-agent.'),
  }},
  { name: 'scope_extension_proposal', description: 'Propose a scope extension as the INIT reviewer (proposal only)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    proposal: z.string().min(10).describe('Extension proposal narrative; cannot take effect as accepted scope.'),
    reason: z.string().optional().describe('Why the reviewer thinks an extension is needed.'),
    reviewer: z.string().optional().describe('Proposer; defaults to PROOF_OR_STOP_AGENT/USER/main-agent.'),
    findingId: z.string().optional().describe('Optional related finding or issue ID.'),
    evidenceRefs: z.array(z.string().min(1)).optional().describe('Optional evidence references.'),
  }},
  { name: 'scope_extension_decide', description: 'Accept/reject a scope extension proposal in INIT (accepted stales old freeze)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    proposalId: z.string().min(1).describe('Proposal ID returned by scope_extension_proposal.'),
    decision: z.enum(['accepted', 'rejected']).describe('Explicit decision.'),
    reason: z.string().min(10, 'reason ≥ 10 characters').describe('Decision reason.'),
    decider: z.string().optional().describe('Decider; defaults to PROOF_OR_STOP_AGENT/USER/main-agent.'),
  }},
  { name: 'light_review', description: 'Record one lightweight review (called after each batch of DEV items completes)', schema: {
    storyId: z.string().describe('Story ID'),
    checklistIds: z.array(z.string()).describe('Checklist item IDs covered by this review.'),
    note: z.string().optional().describe('Review note.'),
  }},
  { name: 'certification_window_begin', description: 'Begin a PRE_CERT CertificationWindow; fail-closed unless inventory, merge, clean-tree, and coverage facts admit', schema: {
    storyId: z.string().min(1).describe('Story ID'),
  }},
  { name: 'certification_window_status', description: 'Inspect the current PRE_CERT CertificationWindow; prints State and exactly one Next command', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    refresh: z.boolean().optional().describe('Persist a signed INVALIDATED state when the read-only status preflight detects certification drift.'),
  }},
  { name: 'certification_window_cancel', description: 'Cancel a BLOCKED, ADMITTED, or RUNNING CertificationWindow without granting heavy-certification authority', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    reason: z.string().min(5).describe('Why the window is cancelled (at least 5 characters).'),
  }},
  { name: 'review_run_start', description: 'Start a reviewer run for the current REVIEW round; write signed review-runs.json', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent ID, for example proof-or-stop-review-quality; defaults to PROOF_OR_STOP_AGENT.'),
    lane: z.enum(REVIEW_RUN_LANE_INPUTS).optional().describe('Explicit canonical reviewer lane; provide only one.'),
    reviewedIntentRefs: z.array(z.string()).optional().describe('Scope-protected story: verification intent refs reviewed in this run; included in scope binding, optional.'),
    reviewerEscalationReason: z.string().trim().min(1).optional().describe('Reviewer-authored reason to mint a new full-context ReviewRun when the bounded incremental basis is incomplete.'),
    reviewPurpose: z.enum(['topology', 'inventory-completeness']).optional().describe('Critic only. Omitted preserves topology admission; inventory requires a current signed OPEN epoch.'),
    inventoryEpochId: z.string().min(1).optional().describe('Exact current epoch for explicit inventory-completeness purpose, never topology authority.'),
  }},
  { name: 'review_run_list', description: 'Read compact signed reviewer-run metadata for recovery and inspection; never writes evidence or prompt bytes', schema: {
    storyId: z.string().min(1).describe('Story ID.'),
    lane: z.enum(REVIEW_RUN_LANE_INPUTS).optional().describe('Optional canonical reviewer lane filter.'),
    latest: z.boolean().optional().describe('Return only the newest matching signed ReviewRun.'),
    json: z.boolean().optional().describe('Emit compact machine-readable signed run metadata.'),
  }},
  { name: 'review_prompt_gc', description: 'Reclaim only orphan prompt bodies under producer locks. Preserve every historical run/envelope reference; refuse corrupt metadata or dangling gate references.', schema: {
    storyId: z.string().min(1).describe('Story whose prompt storage should be collected.'),
  }},
  { name: 'review_inventory_begin', description: 'Begin one signed frozen-candidate REVIEW inventory epoch', schema: {
    storyId: z.string().min(1).describe('Story ID in REVIEW.'),
    maxWaves: z.number().int().min(1).max(5).optional().describe('Bounded discovery-wave budget; defaults to 3.'),
  }},
  { name: 'review_inventory_status', description: 'Inspect the latest inventory epoch; OPEN drift is fail-closed to INVALIDATED', schema: {
    storyId: z.string().min(1).describe('Story ID.'),
  }},
  { name: 'review_inventory_critic_set', description: 'Record independent completeness-critic authority for the current frozen inventory wave', schema: {
    storyId: z.string().min(1).describe('Story ID.'),
    epochId: z.string().min(1).describe('Current OPEN inventory epoch ID.'),
    reviewRunId: z.string().min(1).describe('Fresh proof-or-stop-review-topology-critic ReviewRun with terminal read evidence.'),
    agent: z.literal('proof-or-stop-review-topology-critic').optional().describe('Critic actor; must agree with the dispatched PROOF_OR_STOP_AGENT authority.'),
    findingDispositions: z.array(z.object({
      findingId: z.string().min(1),
      disposition: z.enum(['verified_family', 'duplicate', 'not_verified']),
      familyKey: z.string().min(1).optional(),
      canonicalFindingId: z.string().min(1).optional(),
      reason: z.string().min(10),
    }).strict()).describe('Independent signed disposition for every raw finding in this wave; unresolved findings block finalization.'),
  }},
  { name: 'review_inventory_wave_advance', description: 'Persist one complete nonzero-new discovery wave and open the next unchanged-material wave', schema: {
    storyId: z.string().min(1).describe('Story ID with a complete critic-certified current wave that added verified finding families.'),
  }},
  { name: 'review_inventory_finalize', description: 'With an OPEN saturation epoch, mint a receipt only when the current complete unchanged-material wave adds zero verified finding families. With no OPEN epoch, write a FINALIZED unconsumed inventory-completeness receipt bound to current hashes; completeness is not PRE_CERT and authorizesTest stays false. Commit epoch metadata once; on commit failure retry this command without rerunning reviewers.', schema: {
    storyId: z.string().min(1).describe('Story ID.'),
    remediation: z.boolean().optional().describe('Finalize a complete critic-certified wave for repair only, including new findings. This receipt never grants certification or TEST authority.'),
  }},
  { name: 'review_inventory_cancel', description: 'Cancel an OPEN epoch or invalidate an unconsumed FINALIZED receipt without granting transition authority', schema: {
    storyId: z.string().min(1).describe('Story ID.'),
    reason: z.string().trim().min(10).describe('Auditable cancellation and recovery reason.'),
  }},
  { name: 'review_pass_set', description: 'Record a durable signed reviewer pass credential. Inside a frozen epoch, Git metadata is committed together at finalize/cancel.', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent ID, for example proof-or-stop-review-quality; defaults to PROOF_OR_STOP_AGENT.'),
    reviewRunId: z.string().describe('Current reviewer run ID; call review_run_start first.'),
    note: z.string().describe('Review scope and reason there is no blocker (at least 10 characters).'),
    readManifest: reviewerReadManifestSchema.describe('Required signed reviewer read coverage for this pass.'),
    readEvents: reviewerReadEventsSchema.optional().describe('Optional mechanical read events for this reviewer pass. When supplied, runtime persists signed decisions-doc readLog digest/summary and rejects decisions-doc readManifest mismatches.'),
    readLog: reviewerReadLogInputSchema.optional().describe('Optional mechanical read-log input for this reviewer pass: event array or {events:[...]}. Runtime derives the signed decisions-doc readLog digest/summary.'),
  }},
  { name: 'review_loop_start', description: 'Record REVIEW reflection loop start (recording only; no host or rollback)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    loopId: z.string().min(1).optional().describe('Optional loop ID; defaults to one generated by the handler.'),
    reviewRound: z.string().min(1).optional().describe('Optional REVIEW round; defaults to story.currentReviewRound.'),
    trigger: reviewLoopTriggerSchema.describe('Structured source that triggered the loop.'),
    rollbackRef: reviewLoopRollbackRefSchema.describe('References required for manual rollback; recorded only, not executed.'),
    actor: z.string().min(1).optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main.'),
    json: z.boolean().optional().describe('Emit JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
  }},
  { name: 'review_loop_iteration_add', description: 'Record a REVIEW reflection iteration (recording only; no host/rollback/handoff)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    loopId: z.string().min(1).describe('loopId returned by review_loop_start.'),
    reviewRound: z.string().min(1).optional().describe('Optional REVIEW round; defaults to story.currentReviewRound.'),
    trigger: reviewLoopTriggerSchema.describe('Trigger context for this iteration.'),
    host: reviewLoopHostSchema.describe('Host/capability record for this iteration; does not start a host.'),
    rollbackRef: reviewLoopRollbackRefSchema.describe('References required for manual rollback; recorded only, not executed.'),
    reflection: reviewLoopReflectionSchema.describe('Reflection judgment for this iteration.'),
    evaluation: reviewLoopEvaluationSchema.optional().describe('Cost, evidence, and command record for this iteration.'),
    decision: reviewLoopDecisionSchema.describe('Final decision for this iteration.'),
    decisionReason: z.string().min(1).describe('Final decision reason.'),
    nextAction: reviewLoopNextActionSchema.optional().describe('Suggested next action; recorded only, not executed.'),
    actor: z.string().min(1).optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main.'),
    json: z.boolean().optional().describe('Emit JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
  }},
  { name: 'review_loop_status', description: 'Read REVIEW reflection loop status (read-only)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    loopId: z.string().min(1).optional().describe('Optional loop ID filter.'),
    json: z.boolean().optional().describe('Emit JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
  }},
  { name: 'review_loop_close', description: 'Record REVIEW reflection loop close (recording only; no merge/DONE/receipt)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    loopId: z.string().min(1).describe('loopId to close.'),
    reviewRound: z.string().min(1).optional().describe('Optional REVIEW round; defaults to story.currentReviewRound.'),
    status: z.enum(['resolved', 'escalated', 'blocked']).describe('Close status.'),
    trigger: reviewLoopTriggerSchema.describe('Trigger context associated at close time.'),
    materialHash: z.string().min(1).describe('Material hash at close time.'),
    resolvedEvidenceRefs: z.array(z.string().min(1)).optional().describe('Resolved evidence references.'),
    supersedingEvidenceRefs: z.array(z.string().min(1)).optional().describe('Superseding evidence references.'),
    closeReason: z.string().min(1).describe('Close reason.'),
    actor: z.string().min(1).optional().describe('Recorded by; defaults to PROOF_OR_STOP_AGENT/USER/main.'),
    json: z.boolean().optional().describe('Emit JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
  }},
  { name: 'review_loop_policy_show', description: 'Show REVIEW reflection loop recording policy (read-only)', schema: {
    json: z.boolean().optional().describe('Emit JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
  }},

  // Understanding (pre-context intake snapshot).
  { name: 'understanding_set', description: 'Record the PLAN task understanding snapshot (task/outcome/facts/constraints/...)', schema: {
    storyId: z.string().describe('Story ID'),
    task: z.string().describe('One-sentence description of the problem to solve.'),
    outcome: z.string().describe('Observable outcome after completion.'),
    facts: z.array(z.string()).describe('Known facts.'),
    constraints: z.array(z.string()).describe('Constraints.'),
    unknowns: z.array(z.string()).describe('Unknowns to resolve before splitting the checklist.'),
    touchpoints: z.array(z.string()).describe('Possible code touchpoints.'),
  }},
  { name: 'understanding_get', description: 'Read the understanding snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Decision (RALPLAN-DR structured decision).
  { name: 'decision_set', description: 'Record a structured PLAN decision (principles/drivers/options/chosen/preMortem)', schema: {
    storyId: z.string().describe('Story ID'),
    principles: z.array(z.string()).describe('3-5 design principles.'),
    drivers: z.array(z.string()).describe('Top 3 key constraints.'),
    options: z.array(z.object({
      name: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    })).describe('At least 2 options with pros and cons.'),
    chosen: z.string().describe('Selected option.name.'),
    rationale: z.string().describe('Selection rationale (at least 10 characters).'),
    preMortem: z.array(z.object({
      scenario: z.string(),
      trigger: z.string(),
      consequence: z.string(),
      mitigation: z.string(),
    })).optional().describe('Pre-mortem failure scenarios (at least 3 for high-risk stories).'),
  }},
  { name: 'decision_get', description: 'Read decision snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'decision_doc_proposal', description: 'Create/update a story-local proposal for promoting a decision into docs/requirements/decisions/<slug>.md. Alias: proof-or-stop decision doc proposal', schema: {
    storyId: z.string().describe('Story ID'),
    proposalId: z.string().optional().describe('Optional existing DDP-001 proposal id to refresh before save'),
    slug: z.string().describe('Lowercase kebab-case slug, without .md'),
    targetPath: z.string().optional().describe('Must match the derived canonical path; custom paths are rejected'),
    title: z.string().describe('Decision doc title'),
    sourceDecision: z.enum(['decision.json', 'manual']).optional().describe('Defaults to decision.json; manual skips source decision digest binding'),
    decision: z.string().describe('Durable decision statement'),
    context: z.string().describe('Why this durable decision exists'),
    scope: z.string().describe('Where this decision applies'),
    nonGoals: z.array(z.string()).describe('Explicit non-goals'),
    chosenApproach: z.string().describe('Chosen approach'),
    alternatives: z.array(z.object({
      name: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    })).describe('At least two alternatives, each with pros and cons'),
    operationalRules: z.array(z.string()).describe('Executable future rules'),
    verificationRequirements: z.array(z.string()).describe('Future verification requirements'),
    risks: z.array(z.string()).describe('Known risks'),
  }},
  { name: 'decision_doc_preview', description: 'Read-only render of a decision-doc proposal; writes no files or metadata. Alias: proof-or-stop decision doc preview', schema: {
    storyId: z.string().describe('Story ID'),
    proposalId: z.string().describe('DDP-001 proposal id'),
  }},
  { name: 'decision_doc_save', description: 'Materialize a proposal into docs/requirements/decisions/<slug>.md with confirm, freshness, and scope guards. Alias: proof-or-stop decision doc save', schema: {
    storyId: z.string().describe('Story ID'),
    proposalId: z.string().describe('DDP-001 proposal id'),
    mode: z.enum(['create', 'update']).describe('create requires missing target; update requires existing target'),
    confirm: z.boolean().describe('Must be true to write the target decision doc'),
    targetPath: z.string().optional().describe('Must match the proposal canonical target when supplied; custom paths are rejected'),
    expectedProposalDigest: z.string().trim().min(1).describe('Required reviewed proposal digest; stale values fail closed'),
    expectedSourceDecisionDigest: z.string().trim().min(1).optional().describe('Required when sourceDecision is decision.json; invalid for manual source decisions; stale values fail closed'),
  }},
  // Grill planning artifact (PLAN context only; not verification/validation evidence)
  { name: 'grill_start', description: 'Start a PLAN grill clarification session (writes grill.json, not evidence)', schema: {
    storyId: z.string().describe('Story ID'),
    topic: z.string().optional().describe('Topic or focus of this grill round.'),
  }},
  { name: 'grill_record', description: 'Record grill question and answer (unanswered becomes unresolved)', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID; defaults to the latest open session.'),
    question: z.string().describe('Clarifying question.'),
    answer: z.string().optional().describe('Answer; defaults to unresolved when omitted.'),
    status: z.enum(['answered', 'unresolved']).optional().describe('Question status; inferred from whether answer exists by default.'),
    source: z.string().optional().describe('Optional source, such as user/reviewer/implementer.'),
  }},
  { name: 'grill_close', description: 'Close grill session and return remainingUnknowns', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID; defaults to the latest open session.'),
    note: z.string().optional().describe('Close note.'),
    closedBy: z.string().optional().describe('Closed-by identifier.'),
  }},
  { name: 'grill_get', description: 'Read grill planning artifact', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Read only the specified grill session.'),
  }},
  // Summary (B-093b: DONE-gate forced completion summary)
  { name: 'summary_set', description: 'Record the required Story completion summary', schema: {
    storyId: z.string().describe('Story ID'),
    changes: z.string().describe('What changed (key changes per file from the user perspective, at least 10 characters).'),
    usage: z.string().describe('How to use it (slash/tool/call example, at least 10 characters).'),
    expectedOutcome: z.string().optional().describe('DONE gate required: user-perspective expected visible result or expected transcript (at least 10 characters).'),
    actualTranscript: z.string().optional().describe('DONE gate required: actual user-visible transcript or output summary (at least 10 characters).'),
    outcomeDiff: z.string().optional().describe('DONE gate required: expected vs actual difference; explicitly say when there is no difference (at least 5 characters).'),
    acceptanceVerdict: z.enum(['accepted', 'partial', 'rejected']).optional().describe('DONE gate required: user-value acceptance verdict.'),
    outcomeKind: z.enum(STORY_OUTCOME_KINDS).optional().describe('DONE outcome classification: success / blocked / audit_only'),
    limitations: z.string().describe('Known limitations or design deviations (write "none — fully covered" if none).'),
    pitfalls: z.string().describe('Pitfalls record: where it got stuck, how many retries, and what the next person should know (at least 10 characters; no empty platitudes).'),
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason}; explain each sandbox:false case that was not run, otherwise Proof-or-Stop reports missing entries.'),
  }},
  { name: 'summary_get', description: 'Read story summary', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Bug
  { name: 'bug_report', description: 'Report a bug', longHelp: BUG_REPORT_LONG, schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    title: z.string().describe('Description.'), checklistId: z.string().optional().describe('Related checklist item ID.'),
  }},
  { name: 'bug_update', description: 'Update bug status', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    status: z.enum(['open','fixed']).describe('New status.'),
    evidence: z.object({
      symptom: z.string().describe('User-observable symptom.'),
      reproSteps: z.array(z.string()).describe('Minimal reproduction steps.'),
      hypothesis: z.string().optional().describe('Verified hypothesis.'),
      rootCause: z.string().describe('Confirmed root cause.'),
      fixEvidence: z.string().describe('Fix evidence explanation.'),
      reproTest: z.string().optional().describe('Reproduction test path.'),
    }).optional().describe('Debugging evidence chain; recommended when marking fixed.'),
  }},
  { name: 'bug_list', description: 'View bug list; without storyId, show a global summary across all stories', schema: {
    storyId: z.string().optional().describe('Story ID; when omitted, list bugs for all stories.'),
    ...BRIEF_OUTPUT_FLAGS,
    ...JSON_OUTPUT_FLAGS,
  }},
  { name: 'bug_analyze', description: 'Cross-story bug quality dashboard (markdown/json)', schema: {
    format: z.enum(['json','markdown']).optional().describe('Output format (default: json).'),
  }},

  // Test
  { name: 'test_add', description: 'Record test evidence', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('TE ID'),
    scenario: z.string().describe('Scenario.'), command: z.string().describe('Command.'),
    output: z.string().describe('Output.'), expected: z.string().describe('Expected.'),
    result: z.enum(['PASS','FAIL']).describe('Result.'),
  }},
  { name: 'test_list', description: 'View latest test evidence snapshot (currently not a historical list)', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'fixture_get', description: 'Read fixture file', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json.'),
  }},
  { name: 'fixture_update', description: 'Replace fixture cases (compatibility maintenance command)', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json.'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('Complete cases array.'),
  }},
  { name: 'fixture_batch_add', description: 'Batch append fixture cases (supports executor/command/legacy execute)', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json.'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('Cases to append.'),
    storyId: z.string().optional().describe('Used to auto-fill the intentRef story prefix.'),
    dryRun: z.boolean().optional().describe('Preview only; do not persist changes.'),
    validateExecute: z.boolean().optional().describe('Pre-run CLI case before appending.'),
  }},
  { name: 'test_auto', description: 'Legacy full fixture regression (real run needs confirm; dryRun previews)', schema: {
    storyId: z.string().optional().describe('Deprecated; for current story verification use proof-or-stop validate --story=<storyId> and record verificationEvidence.'),
    trace: z.boolean().optional().describe('Collect trace.'),
    enableProfiler: z.boolean().optional().describe('Enable profiler.'),
    dryRun: z.boolean().optional().describe('Output execution plan only.'),
    confirm: z.boolean().optional().describe('Confirm side-effecting full regression execution.'),
  }},
  { name: 'test_story', description: 'Filter by story and run related fixture cases', schema: {
    storyId: z.string().describe('Story ID'),
    trace: z.boolean().optional().describe('Collect trace.'),
  }},
  { name: 'test_fixture', description: 'Run a single case or chain by fixtureId', schema: {
    fixtureId: z.string().describe('fixture case _id'),
  }},
  { name: 'task_coverage', description: 'Check coverage between story checklist and code task metadata', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID or array of Story IDs.'),
  }},

  // Truth / Gap
  { name: 'truth_scan', description: 'Scan source-of-truth directories', schema: {
    summary: z.boolean().optional().describe('Return only a statistics summary.'),
  }},
  { name: 'truth_nav', description: 'Generate source-of-truth navigation', schema: {} },
  { name: 'truth_analyze', description: 'Analyze contradictions, ambiguity, and gaps in sources of truth', schema: {} },
  { name: 'truth_to_story', description: 'Extract candidate stories from sources of truth', schema: {} },
  { name: 'truth_extract', description: 'Extract requirements documents from code metadata', schema: {} },
  { name: 'gap_analyze', description: 'Compare sources of truth with code reality and output a gap report', schema: {} },
  { name: 'convergence_check', description: 'Determine whether the project has converged (requirements covered, tests pass)', schema: {} },
  // Dashboard (real-time dashboard).
  { name: 'dashboard', description: 'Real-time story progress dashboard (refreshes every N seconds, multi-project)', schema: {
    roots: z.string().optional().describe('Project roots (comma-separated paths; default current directory).'),
    interval: z.number().optional().describe('Refresh interval in seconds (default: 5).'),
  }},
  { name: 'session_brief', description: 'Cross-session opening brief (active story/phase/checklist/bug/next step)', schema: {
    concise: z.boolean().optional().describe('Concise mode (default: false).'),
  }},
  { name: 'next', description: 'Output only the most reliable next step (reuses session_brief phase judgment)', schema: {
    concise: z.boolean().optional().describe('Concise mode (default: true).'),
  }},
  { name: 'done_closure', description: 'Project local DONE closure readiness from the DONE oracle without mutating lifecycle or widening local assurance. Alias: proof-or-stop done closure', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'lifecycle_check', description: 'Read-only proof-or-stop lifecycle readiness report for REVIEW, TEST, or DONE; never runs commands or writes evidence.', schema: {
    storyId: z.string().describe('Story ID'),
    target: z.enum(['REVIEW', 'TEST', 'DONE']).describe('Lifecycle target to check.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('V1 must be false; true fails closed before reading story facts.'),
    writeEvidence: z.boolean().optional().describe('V1 must be false; true fails closed before reading story facts.'),
  }},
  { name: 'milestone_status', description: 'Read-only grouped ProofStory milestone status report; projects existing milestone ledger, checklist, verification intent/evidence, phase, and summary facts without creating storage, running commands, writing evidence, launching reviewers, advancing phase, or claiming DONE/production readiness.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    ...BRIEF_OUTPUT_FLAGS,
    authorityClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    deploymentReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    externalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    terminalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'milestone_closeout', description: 'Read-only historical DONE milestone closeout report from milestone-closeout.json; reads a frozen closeout snapshot without recomputing live freshness, mutating storage, advancing phase, or claiming production readiness.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    authorityClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    deploymentReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    externalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    terminalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'global_control_status', description: 'Read-only global lifecycle control plane dashboard over runtime closure, admissibility waterline, and queue governance.', schema: {
    storyIds: z.array(z.string()).optional().describe('Optional story IDs to include.'),
    expanded: z.boolean().optional().describe('Expand experiment-batch details (default false).'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'runtime_closure_status', description: 'Read-only runtime closure projection from local assurance, readiness, freshness, and shipped lock state.', schema: {
    storyId: z.string().optional().describe('Optional single story ID to include. Alias for storyIds=[storyId].'),
    storyIds: z.array(z.string()).optional().describe('Optional story IDs to include.'),
    activeOnly: z.boolean().optional().describe('Only include non-terminal stories (default true).'),
    currentValidationStoryId: z.string().optional().describe('Test/diagnostic hint to render a validation lock as self-reentry.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'admissibility_waterline', description: 'Diagnostic-only Proof Admissibility consumer waterline; never grants lifecycle readiness or production eligibility.', schema: {
    storyId: z.string().optional().describe('Optional story ID for story-scoped evidence probes.'),
    consumers: z.array(z.enum(['STORY_INTAKE', 'PLAN', 'REVIEW', 'TEST', 'DONE', 'HANDOFF', 'AUTHORITY_GATE_DECISION', 'LEGACY_AUTHORITY_RECEIPT', 'DONE_REQUIRED'])).optional().describe('Optional consumers to render.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'pinn_claim_check', description: 'Local-only Proof-or-Stop PINN claim-admissibility check; never grants PDE correctness, deployment readiness, or external completion.', schema: {
    claimId: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']).optional().describe('PINN claim strength to evaluate (default C9 for built-in fixtures).'),
    fixture: z.enum(['complete']).optional().describe('Use a built-in complete evidence fixture.'),
    injection: z.string().regex(/^B(?:[1-9]|1[0-5])$/).optional().describe('Use a deterministic B1-B15 failure injection fixture.'),
    evidenceJson: z.string().optional().describe('Inline JSON evidence object to evaluate.'),
    evidencePath: z.string().optional().describe('Path to a JSON evidence object to evaluate.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    deploymentReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    externalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    terminalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    pdeCorrectnessClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'quantum_claim_check', description: 'Local-only Quantum M3 claim-admissibility gate-policy check; read-only and never grants production, Authority, hardware, theory, or solver-improvement claims.', schema: {
    claimId: z.enum(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12']).optional().describe('Quantum claim id to evaluate for built-in complete evidence (default Q5).'),
    case: z.enum(['complete', 'weak', 'degraded', 'stale', 'missing', 'mismatched', 'unbound', 'overclaim']).optional().describe('Built-in local read-only smoke case to evaluate (default complete).'),
    evidenceJson: inlineJsonObjectSchema.optional().describe('Inline JSON quantum evidence object to evaluate.'),
    evidencePath: z.string().optional().describe('Path to a JSON quantum evidence object to evaluate.'),
    requestedStrength: z.enum(['scoped', 'ground-state', 'convergence', 'quantum-advantage', 'theory', 'hardware', 'physical-validation', 'solver-improvement', 'production', 'authority']).optional().describe('Requested claim strength; unsupported strengths fail closed as boundary overclaims.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    quantumTheoryClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    physicalValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    hardwareValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    solverImprovementClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    authorityClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'quantum_claim_benchmark', description: 'Run deterministic local Quantum M4 benchmark cases A1-A4 and B1-B15 failure injections; read-only diagnostic only.', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    quantumTheoryClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    physicalValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    hardwareValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    solverImprovementClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    authorityClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'quantum_claim_report', description: 'Render deterministic Quantum M5 governance report from the local benchmark; read-only diagnostic only.', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    quantumTheoryClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    physicalValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    hardwareValidationClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    solverImprovementClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    authorityClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'pinn_benchmark_run', description: 'Run deterministic local PINN claim-admissibility benchmark arms A1-A4 over B1-B15 injections.', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    deploymentReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    externalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    terminalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    pdeCorrectnessClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'pinn_report_render', description: 'Render deterministic PINN claim-admissibility report with artifact index and claim-boundary paragraph.', schema: {
    benchmarkJson: z.string().optional().describe('Inline benchmark JSON object to render; defaults to a fresh deterministic local run.'),
    benchmarkPath: z.string().optional().describe('Path to benchmark JSON to render; defaults to a fresh deterministic local run.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    deploymentReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionReadyClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    externalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    terminalCompletionClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    pdeCorrectnessClaim: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'queue_governance_status', description: 'Read-only active story queue governance projection with duplicate and experiment-batch grouping.', schema: {
    expanded: z.boolean().optional().describe('Expand experiment-batch story membership (default false).'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'queue_exception_set', description: 'Guarded queue governance writer for auditable experiment-batch exceptions; does not grant lifecycle readiness.', schema: {
    experimentBatchId: z.string().describe('Durable experiment batch id.'),
    storyIds: z.array(z.string()).describe('Story IDs included in the exception.'),
    reason: z.string().describe('Human-readable reason (minimum enforced by handler).'),
    actor: z.string().optional().describe('Actor label recorded in the exception.'),
    source: z.preprocess(
      (value) => value === 'tier-c-prefix' ? 'migration-title-prefix' : value,
      z.enum(['explicit', 'migration-title-prefix']).optional(),
    ).describe('Source rule for this exception. Legacy tier-c-prefix input is normalized to migration-title-prefix.'),
    dashboardMode: z.enum(['collapsed', 'expanded']).optional().describe('Default dashboard mode for this exception.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
  }},
  { name: 'evidence_plan', description: 'Read-only DRY planner that classifies each verification intent evidence into missing/rerun/refresh-only/fresh from the StoryReadinessReport; runs no commands and writes no evidence.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    writeEvidence: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    write: z.boolean().optional().describe('Unsupported; evidence_plan is read-only (refresh is the P4 layer). true fails closed.'),
    refresh: z.boolean().optional().describe('Unsupported; evidence_plan is read-only (refresh is the P4 layer). true fails closed.'),
    execute: z.boolean().optional().describe('Unsupported; evidence_plan is read-only. true fails closed.'),
  }},
  { name: 'init_preflight', description: 'Read-only INIT→INIT_CHECK prerequisite surveyor: lists ALL prerequisites at once (scope-boundary, execution-boundary, scope-freeze-check, scope-extension-proposals, init-check, scope-discard-digest) — each [PASS]/[MISSING]/[STALE]/[BLOCKED]/[ERROR] with a fix command — and echoes the AUTHORITATIVE INIT_CHECK gate verdict via getGuardFailureReason (gate.ready always agrees with the real INIT_CHECK gate). Unlike story_advance --phase=INIT_CHECK (fail-fast, first reason only), it surfaces every missing prerequisite in one run. Runs no commands, writes no evidence; there is NO write flag.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    writeEvidence: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    // write/apply/execute are NOT real flags: each is declared as `z.never()` so the
    // no-such-flag contract is enforced — the only valid value is ABSENCE. Passing
    // --write/--apply/--execute is a hard CLI validation FAILURE (the command never
    // runs / never prints a report), never a silently-stripped no-op. (The non-strict
    // CLI object would otherwise drop a fully-removed key before the handler could
    // refuse it.) The handler's assertBoundary additionally rejects these for
    // direct/programmatic callers and the smoke boundary test. (Same resolution as
    // P8 F-008.) storyId + format are the only real flags.
    write: z.never().optional().describe('Not a flag; init_preflight is read-only. Passing --write is rejected by CLI validation.'),
    apply: z.never().optional().describe('Not a flag; init_preflight never applies anything. Passing --apply is rejected by CLI validation.'),
    execute: z.never().optional().describe('Not a flag; init_preflight is read-only. Passing --execute is rejected by CLI validation.'),
  }},
  // Lifecycle Readiness P7: reviewer_batch — read-only reviewer-launcher PLAN producer.
  { name: 'reviewer_batch_admit', description: 'Owner-only shared capability admission for an explicit complete reviewer roster in the current signed REVIEW inventory wave. Does not launch a reviewer or issue review evidence.', schema: ReviewerBatchAdmitArgsSchema.shape },
  { name: 'reviewer_batch', description: 'Awaiting-repair suppresses repeat launch plans only for valid blocking observations with unchanged committed material or metadata-only head drift; it proves no repair, applicability or gate readiness. Read-only reviewer-launcher PLAN producer: for a story in REVIEW, consolidates the per-lane reviewer state (current-pass / scope-changed / no-receipt / blocking / awaiting-repair) from existing facts, emits the Agent(...) launch instruction (the orchestrator subagent-spawn form, not a dispatch CLI command) for each lane needing a (re-)run, and reports the REVIEW gate status from the StoryReadinessReport review rows. Launches no reviewer, runs no review_run_start, writes no review-runs/review-passes/findings or any evidence; there is NO --write/--launch/--run flag.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    writeEvidence: z.boolean().optional().describe('Unsupported; true fails closed before reading story facts.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; reviewer_batch never launches a reviewer. true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    write: z.boolean().optional().describe('Unsupported; reviewer_batch is read-only (the orchestrator spawns reviewers from the plan). true fails closed.'),
    launch: z.boolean().optional().describe('Unsupported; reviewer_batch is read-only and launches no reviewer. true fails closed.'),
    run: z.boolean().optional().describe('Unsupported; reviewer_batch is read-only and runs no command. true fails closed.'),
  }},
  { name: 'evidence_refresh', description: 'Opt-in one-pass refresh-only orchestrator: default is a read-only dry preview of the refresh-only evidence bucket; --apply performs AT MOST ONE re-stamp pass via verification_evidence_refresh_stale and reclassifies (refreshed / rerun_required / hard_stale). Never runs a verification command, advances phase, launches reviewers, or widens local assurance.', schema: {
    storyId: z.string().describe('Story ID'),
    apply: z.boolean().optional().describe('Perform AT MOST ONE refresh pass via verification_evidence_refresh_stale, then reclassify. Default false = read-only dry preview. --apply is ownership/scope gated.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; evidence_refresh never runs a verification command. true fails closed.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  }},
  // Lifecycle Readiness P8 (CAPSTONE): lifecycle_orchestrate — read-only top-level
  // lifecycle orchestration that composes the prior read-only layers into one view.
  { name: 'lifecycle_orchestrate', description: 'Read-only top-level lifecycle orchestration CAPSTONE (P8): composes the prior read-only layers (V1 StoryReadinessReport + P2-P7) into ONE consolidated, PHASE-AWARE view for a story. It builds the V1 readiness report for the phase-appropriate target and composes only the phase-relevant prior layers via their READ-ONLY DEFAULT path (PLAN→plan_skeleton; verification intents present→evidence_plan + evidence_refresh DRY preview; REVIEW→reviewer_batch; TEST/approaching delivery→live_smoke_transcript STATUS + delivery_context_pack default summary), consolidates blockers + next actions across the composed view, and EMITS the next story_advance command as a PRINTED string (executed:false — NEVER executed). It runs no command, writes no evidence/metadata/artifact, launches no reviewer, advances no phase, and never widens local assurance. There is NO --write/--apply/--execute flag.', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; lifecycle_orchestrate runs no command. true fails closed before reading story facts.'),
    writeEvidence: z.boolean().optional().describe('Unsupported; lifecycle_orchestrate writes no evidence. true fails closed before reading story facts.'),
    advancePhase: z.boolean().optional().describe('Unsupported; the story_advance handoff is a PRINTED string, never executed. true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; lifecycle_orchestrate launches no reviewer. true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    // write/apply/capture/launch/run/execute are NOT real flags: each is declared as
    // `z.never()` so the no-such-flag contract is enforced — the only valid value is
    // ABSENCE. Passing --write/--apply/--execute (or --capture/--launch/--run) is a
    // hard CLI validation FAILURE (the command never runs / never prints a report),
    // never a silently-stripped no-op. (The non-strict CLI object would otherwise
    // drop a fully-removed key before the handler could refuse it.) The handler's
    // assertBoundary additionally rejects these for direct/programmatic callers and
    // the smoke boundary test.
    write: z.never().optional().describe('Not a flag; lifecycle_orchestrate is read-only. Passing --write is rejected by CLI validation.'),
    apply: z.never().optional().describe('Not a flag; lifecycle_orchestrate never applies a refresh pass. Passing --apply is rejected by CLI validation.'),
    capture: z.never().optional().describe('Not a flag; lifecycle_orchestrate never captures a command. Passing --capture is rejected by CLI validation.'),
    launch: z.never().optional().describe('Not a flag; lifecycle_orchestrate launches nothing. Passing --launch is rejected by CLI validation.'),
    run: z.never().optional().describe('Not a flag; lifecycle_orchestrate runs nothing. Passing --run is rejected by CLI validation.'),
    execute: z.never().optional().describe('Not a flag; lifecycle_orchestrate is read-only. Passing --execute is rejected by CLI validation.'),
  }},
  { name: 'live_smoke_transcript', description: 'Explicit live-smoke transcript producer: default is read-only status (expected userSees output, current transcript artifact status, V1 live-smoke readiness row). --capture="<command>" runs ONLY that one provided command (runCommands) and records the actual transcript; --write persists the expected-vs-actual artifact (writeEvidence, ownership/scope gated). --capture and --write are independent. Never advances phase, launches reviewers, widens local assurance, writes verificationEvidence/delivery checks, or accepts a metadata-only waiver.', schema: {
    storyId: z.string().describe('Story ID'),
    capture: z.string().optional().describe('Opt-in command capture: run ONLY this one explicitly-provided command in an isolated process group with a bounded timeout and record stdout/stderr/exit as the actual transcript. Direct DONE-required/done_prepare captures derive their legal configured budget only when the proof-or-stop executable resolves to the exact active CLI realpath and the optional inline environment is limited to PROOF_OR_STOP_SESSION_ID (the deprecated PROOF_OR_STOP_SESSION_ID spelling is also accepted); project paths never self-authorize. Every inherited or default/config/phase-derived nested max remains the business bound while capture/outer wrappers add bounded cleanup grace; a Node-timer-saturated bound is reduced to reserve both grace layers and preserve strict ordering. Timeout cleanup remains referenced until a structured terminal is emitted. Arbitrary, shell-composed, or executable-injected commands retain the fixed safety ceiling. Never derives or appends a command. Capture alone persists nothing.'),
    write: z.boolean().optional().describe('Opt-in artifact writer: persist the expected-vs-actual transcript to <storyDir>/evidence/live-smoke-transcript.json. Ownership/scope gated. Write alone runs no command. Independent of --capture.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported as a bare flag; command capture is the explicit --capture="<command>" opt-in. true fails closed.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  }},
  { name: 'delivery_context_pack', description: 'Delivery-review CONTEXT PRODUCER (P6), NOT a delivery signer: default is read-only — gather and print the structured delivery context pack (delivery-scoped git diff vs main, docs-promises from plan.md + checklist userSees, real-machine test refs, validation + review-round state, and the delivery-check + metadata-waiver status CONSUMED from the V1 StoryReadinessReport deliveryCheckRef). --write persists the same pack to <storyDir>/evidence/delivery-context-pack.json (ownership/scope gated, atomic). It NEVER writes delivery-check.json / calls delivery_check_set, accepts a metadata-only waiver, runs a command, advances phase, launches reviewers, writes verificationEvidence, or widens local assurance.', schema: {
    storyId: z.string().describe('Story ID'),
    write: z.boolean().optional().describe('Opt-in artifact writer: persist the structured delivery context pack to <storyDir>/evidence/delivery-context-pack.json (atomic). Ownership/scope gated. Never writes delivery-check.json or signs the delivery check.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; delivery_context_pack never runs a command. true fails closed.'),
    writeEvidence: z.boolean().optional().describe('Unsupported as a bare flag; persistence is the explicit --write opt-in. true fails closed.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  }},
  { name: 'plan_skeleton', description: 'Suggest or write a PLAN skeleton from story text plus StoryReadinessReport; default is read-only and never advances lifecycle or writes evidence.', schema: {
    storyId: z.string().describe('Story ID'),
    write: z.boolean().optional().describe('Persist through existing understanding_set/checklist_add paths, plus milestone_ledger_set when explicit milestones are supplied.'),
    milestones: z.array(proofStoryMilestoneSchema).optional().describe('Optional explicit machine-countable milestone rows. Only --write persists them; read-only preview never writes a ledger.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text).'),
    json: z.boolean().optional().describe('Shortcut for --format=json.'),
    runCommands: z.boolean().optional().describe('Unsupported; true fails closed.'),
    writeEvidence: z.boolean().optional().describe('Unsupported; true fails closed.'),
    advancePhase: z.boolean().optional().describe('Unsupported; true fails closed.'),
    launchReviewers: z.boolean().optional().describe('Unsupported; true fails closed.'),
    authorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    fullAuthorityDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
    productionDone: z.never().optional().describe(HIDDEN_LOCAL_ASSURANCE_REFUSAL),
  }},
  { name: 'done_prepare', description: 'Conservative pre-DONE readiness assistant; prints Memory Runtime Preflight packDigest/gateEvidence=false and never advances DONE or mutates version files. Alias: proof-or-stop done prepare', schema: {
    storyId: z.string().describe('Story ID'),
    mergeMain: z.boolean().optional().describe('Attempt git merge main before closure checks (default true).'),
    refreshStale: z.boolean().optional().describe('Refresh stale evidence only when the dry-run classification says it is safe (default true).'),
    validate: z.boolean().optional().describe('Run proof-or-stop validate --story=<storyId> --json before DONE closure projection (default true).'),
    build: z.boolean().optional().describe('Optional worktree-local npm build + CLI version execution check; does not check global proofOrStop.'),
    dryRun: z.boolean().optional().describe('Inspect and report planned steps without mutating git, evidence, build outputs, or version files.'),
    json: z.boolean().optional().describe('Return a JSON object; progress still uses the CLI liveness side channel.'),
    autoCloseGeneratedMetadata: z.boolean().optional().describe('Opt-in: commit only current-run generated DONE/test lifecycle metadata after manifest safety checks (default false).'),
    reuseFreshValidation: z.boolean().optional().describe('Opt-in: after a safe generated-metadata commit, reuse same-run validation only when structural hashes are unchanged (default false).'),
    reuseFreshDoneRequired: z.boolean().optional().describe('Reuse fresh DONE-required evidence before execution only when canonical checks and exact/trusted-metadata-only HEAD lineage pass (default true).'),
    versionBump: z.never().optional().describe('Unsupported: done_prepare never bumps versions before DONE.'),
    bumpVersion: z.never().optional().describe('Unsupported: done_prepare never bumps versions before DONE.'),
    postDoneVersionBump: z.never().optional().describe('Unsupported: done_prepare only reports post-DONE version bump need.'),
  }},
  { name: 'done_required_validate', description: 'Run opt-in DONE-required validation under shared workspace capacity and write done-required-evidence.json; bare npm test is outside this lease', schema: {
    storyId: z.string().describe('Story ID'),
    story: z.string().optional().describe('Alias for storyId.'),
    json: z.boolean().optional().describe('Return done-required-evidence.json content as JSON.'),
  }},
  { name: 'decision_doc_quorum_check', description: 'Read-only decision-doc local quorum diagnostic; decision-doc edits are classification-only unless review_escalation_status requires quorum. Alias: proof-or-stop decision doc quorum check', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_status', description: 'Read-only REVIEW escalation status for DONE; reports ordinary, full 3x2, or degraded 3x1 local assurance. Alias: proof-or-stop review escalation status', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_policy_set', description: 'Record an explicit high-risk policy fact that makes review escalation require 3x2 for the current material. Alias: proof-or-stop review escalation policy set', schema: {
    storyId: z.string().describe('Story ID'),
    policyVersion: z.string().min(1).describe('Policy version that authorizes explicitlyConfiguredHighRiskPolicyRequires3x2'),
    sourcePolicyRef: z.string().min(1).describe('Source policy reference, such as a decision-doc anchor or policy id'),
    rolloutStage: z.string().min(1).describe('Effective rollout stage for this policy fact'),
    milestoneId: z.string().optional().describe('Milestone id when the policy applies by roadmap milestone'),
    riskClass: z.string().optional().describe('Risk class when the policy applies by risk class'),
    degradedFallbackAllowed: z.boolean().describe('Whether the policy allows explicit degraded single-host fallback for this story/risk class'),
    issuer: z.string().optional().describe('Issuer identity for the policy fact'),
    approver: z.string().optional().describe('Approver identity or reference when applicable'),
    materialHash: z.string().optional().describe('Optional expected current material hash; stale values are rejected'),
    headHash: z.string().optional().describe('Optional expected current HEAD hash; stale values are rejected'),
    actor: z.string().optional().describe('Operator or reviewer recording the policy fact'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_host_availability_probe', description: 'Probe canonical review hosts codex, claude, and agy by executable path, --version, and bounded noninteractive launcher readiness, then record material-bound gate evidence. Alias: proof-or-stop review host availability probe', schema: {
    storyId: z.string().describe('Story ID'),
    materialHash: z.string().optional().describe('Optional expected current material hash; stale values are rejected'),
    storyFilesHash: z.string().optional().describe('Optional expected current story-owned file hash; stale values are rejected when computable'),
    timeoutMs: z.number().int().positive().max(30000).optional().describe('Per-host version and launcher readiness timeout in milliseconds (default 5000, max 30000)'),
    actor: z.string().optional().describe('Operator recording the probe'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_fallback_set', description: 'Record explicit degraded 3x1 review escalation fallback evidence bound to the current material hash and optional storyFilesHash. Alias: proof-or-stop review escalation fallback set', schema: {
    storyId: z.string().describe('Story ID'),
    eligibility: reviewEscalationFallbackEligibilitySchema.describe('Allowed degraded fallback eligibility'),
    reason: z.string().min(20).describe('Why the selected degraded fallback eligibility applies and lower-assurance 3x1 review is being used'),
    evidenceRefs: z.array(z.string().min(1)).optional().describe('Local evidence references supporting degraded fallback'),
    approvalRef: z.string().optional().describe('Explicit approval reference; required when evidenceRefs is empty'),
    materialHash: z.string().optional().describe('Optional expected current material hash; stale values are rejected'),
    storyFilesHash: z.string().optional().describe('Optional expected current story-owned file hash; stale values are rejected when computable'),
    actor: z.string().optional().describe('Operator or reviewer recording the fallback'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'capsule_show', description: 'Show story session capsule (projected state, not gate evidence)', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    format: z.enum(['text', 'json']).optional().describe('Output format.'),
    strict: z.boolean().optional().describe('Fail when references are missing.'),
  }},
  { name: 'capsule_update', description: 'Create or update the story session capsule projection', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    rebuild: z.boolean().optional().describe('Rebuild base capsule from story/checklist/process-events'),
    summary: z.string().optional().describe('Summary.'),
    nextAction: z.string().optional().describe('Next step.'),
    currentChecklistId: z.string().optional().describe('Current checklist item.'),
    activeRunId: z.string().optional().describe('Current or latest run ID.'),
    openBlockers: z.array(z.string()).optional().describe('Unresolved blocker summary.'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('Evidence references.'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events references.'),
    strict: z.boolean().optional().describe('Reject writes when references are missing.'),
  }},
  { name: 'capsule_handoff', description: 'Write handoff.md and update capsule next action', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    nextAction: z.string().describe('Next step.'),
    notes: z.string().optional().describe('Handoff notes.'),
    openBlockers: z.array(z.string()).optional().describe('Unresolved blocker summary.'),
  }},
  { name: 'capsule_run_add', description: 'Record story capsule run summary and metrics', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    runId: z.string().optional().describe('Run ID'),
    checklistId: z.string().optional().describe('Related checklist item.'),
    provider: z.string().optional().describe('CLI/provider, such as codex/claude-code/antigravity.'),
    model: z.string().optional().describe('Model.'),
    vendor: z.string().optional().describe('Vendor.'),
    role: z.enum(['implementer', 'reviewer', 'tester', 'verifier', 'main', 'other']).optional().describe('Run role.'),
    result: z.enum(['pass', 'fail', 'blocked', 'unknown']).optional().describe('Run result.'),
    commands: z.array(z.string()).optional().describe('Command summary.'),
    transcript: z.string().optional().describe('Key transcript excerpt.'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('Evidence references.'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events references.'),
    metrics: z.record(z.string(), z.unknown()).optional().describe('Metrics summary.'),
    artifacts: z.record(z.string(), z.unknown()).optional().describe('Artifact summary.'),
  }},
  { name: 'aux_doc_list', description: 'List project documents, used to choose relatedDocs during PLAN', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default: text).'),
  }},
  { name: 'capability_list', description: 'List host-neutral Proof-or-Stop capability profiles and degradations (text/json)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_probe', description: 'Probe one host-neutral Proof-or-Stop capability profile and visible degradations (text/json)', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'agent_prompt', description: 'Print the canonical package-registry host render: a body-free review_run_start bootstrap for migrated reviewers, or the role body for ordinary roles', schema: {
    role: z.string().min(1).describe('Proof-or-Stop agent role name, e.g. proof-or-stop-implementer, proof-or-stop-review-concept (the template basename without .md)'),
    storyId: z.string().min(1).optional().describe('Optional Story ID for trusted full-context assembly when this role rollout flag is enabled.'),
    format: z.enum(['text', 'json']).optional().describe('Story-aware full-context output format (default text); role-only output equals the canonical registry host render.'),
  }},
  { name: 'prompt_measurement_report', description: 'Report deterministic local prompt bytes, lines, estimated tokens, repetition, and three-layer input availability for all 16 package prompt roles (read-only L0)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'capability_claim_evaluate', description: 'Evaluate a local capability claim fail-closed from lower-layer suite reports (text/json)', schema: {
    target: z.string().optional().describe('Requested claim target, for example development, engineering, loop-engineering, or production-safety'),
    claimId: z.string().optional().describe('Claim id, for example CLAIM-PRODUCTION-SAFETY'),
    requestedClaim: z.string().optional().describe('Human requested claim wording to evaluate'),
    runId: z.string().optional().describe('Optional report run id when writing a claim report'),
    artifactsRoot: z.string().optional().describe('Optional baseline artifacts root (default .proof-or-stop/artifacts/baseline)'),
    output: z.string().optional().describe('Optional JSON output path; also writes a sibling .md report'),
    outputDir: z.string().optional().describe('Optional directory for claim-report.json/md'),
    writeReport: z.boolean().optional().describe('Write the canonical claim-report.json/md under the baseline artifacts root'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'capability_claim_formal_evaluate', description: 'Formally evaluate Engineering or Loop Engineering claim from formal suite proof (text/json)', schema: {
    target: z.string().optional().describe('Requested claim target; engineering or loop-engineering can unlock here, higher layers remain locked'),
    claimId: z.string().optional().describe('Claim id; CLAIM-ENGINEERING-DEV or CLAIM-LOOP-ENGINEERING can unlock here'),
    requestedClaim: z.string().optional().describe('Human requested claim wording to evaluate'),
    runId: z.string().optional().describe('Optional report run id when writing a claim report'),
    artifactsRoot: z.string().optional().describe('Optional baseline artifacts root (default .proof-or-stop/artifacts/baseline)'),
    output: z.string().optional().describe('Optional JSON output path; also writes a sibling .md report'),
    outputDir: z.string().optional().describe('Optional directory for claim-report.json/md'),
    writeReport: z.boolean().optional().describe('Write the canonical claim-report.json/md under the baseline artifacts root'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'memory_benchmark_run', description: 'Run the deterministic virtual lifecycle memory benchmark baseline (text/json)', schema: {
    tier: z.string().optional().describe('Tier alias: T0/T1/T2/T3 or 10k/100k/1m'),
    candidateCount: z.union([z.number(), z.string()]).optional().describe('Candidate count override; must match --tier when both are provided'),
    queryCount: z.number().optional().describe(`Query count (default ${MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT})`),
    seed: z.number().optional().describe(`Deterministic seed (default ${MEMORY_BENCHMARK_DEFAULT_SEED})`),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'memory_benchmark_compare', description: 'Compare the deterministic lifecycle memory benchmark across candidate-count tiers (text/json)', schema: {
    candidateCounts: z.union([z.array(z.union([z.number(), z.string()])), z.string(), z.number()]).optional().describe('Candidate counts via repeated flags, JSON array, or comma-separated string (default 10000,100000,1000000)'),
    queryCount: z.number().optional().describe(`Query count (default ${MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT})`),
    seed: z.number().optional().describe(`Deterministic seed (default ${MEMORY_BENCHMARK_DEFAULT_SEED})`),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'memory_benchmark_real_data', description: 'Export a non-authoritative real lifecycle data baseline corpus/gold/query/result set (text/json)', schema: {
    outputDir: z.string().optional().describe('Optional output directory for corpus.jsonl, gold.jsonl, queries.jsonl, and result.json; refuses to overwrite existing output files'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'memory_playbook_baseline_generate', description: 'Write deterministic playbook runtime memory baseline artifacts (small or full 1,000,000 records); force may replace outputDir; non-authoritative benchmark only', schema: {
    profile: z.enum(['small', 'full']).optional().describe('Baseline profile. full writes exactly 1,000,000 records. Default small.'),
    outputDir: z.string().optional().describe('Output directory; omit for temp output. Refuses to overwrite unless force is true.'),
    seed: z.number().optional().describe('Deterministic seed metadata (default 42).'),
    force: z.boolean().optional().describe('Remove existing outputDir first.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'memory_playbook_baseline_verify', description: 'Verify deterministic playbook runtime memory baseline correctness, stale detection, false-surface rates, and perf/memory report; non-authoritative benchmark only', schema: {
    profile: z.enum(['small', 'full']).optional().describe('Generated profile when inputDir is omitted. full verifies exactly 1,000,000 generated records.'),
    inputDir: z.string().optional().describe('Existing baseline directory with manifest.json, records.jsonl, and gold-queries.json. Omit to generate then verify.'),
    seed: z.number().optional().describe('Deterministic seed metadata when generating.'),
    keepGenerated: z.boolean().optional().describe('When inputDir is omitted, keep the generated temp baseline directory instead of deleting it after verification.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'playbook_runtime_health', description: 'Check advisory runtime memory required classes and consumer wiring drift; memory remains non-authoritative', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'final_response_check', description: 'Advisory final response memory check; completion claims must rely on ParentRollupResult/current structured facts, not memory', schema: {
    storyId: z.string().optional().describe('Optional story id for final response context'),
    claim: z.string().optional().describe('Optional proposed final claim wording'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'host_list', description: 'List Proof-or-Stop host profiles, visible degradations, and migration authority boundaries (text/json). Alias: proof-or-stop host list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_probe', description: 'Probe one Proof-or-Stop host profile without claiming release readiness (text/json). Alias: proof-or-stop host probe', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_status', description: 'Report overflow-readiness status for one Proof-or-Stop host without changing authority (text/json). Alias: proof-or-stop host status', schema: {
    host: z.string().describe('Host profile id, for example claude-code or codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'host_runtime_list', description: 'List dispatch runtime availability for fake, codex, claude-code, and antigravity without changing authority (text/json). Alias: proof-or-stop host runtime list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime list JSON; refuses to overwrite'),
  }},
  { name: 'host_runtime_probe', description: 'Probe one dispatch runtime (fake, codex, claude-code, antigravity; alias agy) without starting a host (text/json). Alias: proof-or-stop host runtime probe', schema: {
    host: z.string().describe('Dispatch runtime id: fake, codex, claude-code, antigravity, or agy alias'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime probe JSON; refuses to overwrite'),
  }},
  { name: 'host_install', description: 'Show dry-run Proof-or-Stop host install guidance only; no third-party installs are executed. Alias: proof-or-stop host install', schema: {
    host: z.string().describe('Host profile id to show guidance for'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'proof_or_stop_config_doctor', description: 'Report Proof-or-Stop 0.3.8 migration readiness, Mac App demotion status, and wrapper-root gitRoot diagnostics (text/json). Alias: proof-or-stop config doctor', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'proof_or_stop_config_repair', description: 'Explicit operator-confirmed wrapper-root repair: validates --set-git-root stays under the metadata root and is a git repository root, then writes only the gitRoot field of the existing project config when --confirm is given; without --confirm it is a non-mutating preview. Alias: proof-or-stop config repair', schema: {
    setGitRoot: z.string().optional().describe('Relative directory under the metadata root that is the git repository root (use --set-git-root=<dir>); required, never guessed'),
    confirm: z.boolean().optional().describe('Required to write; without --confirm the command previews the change and prints the exact confirm command'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'rollout_check', description: 'Run read-only cross-project Proof-or-Stop rollout diagnostics for install drift, managed assets, runtime footprint, and transcript scope. Alias: proof-or-stop rollout check', schema: {
    projects: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated project paths or JSON array; omit to scan the current root'),
    maxDepth: z.number().optional().describe('Discovery depth when projects is omitted (default 1)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'baseline_run', description: 'Run one executable Proof-or-Stop baseline scenario and write required final-report artifacts. Alias: proof-or-stop baseline run', schema: {
    baselineId: z.string().describe('Baseline scenario id (NL-*/RED-* baseline suite, or legacy ENG-/AUTH-/CLAIM-* Baseline 2-5 id)'),
    runId: z.string().optional().describe('Optional run id'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .proof-or-stop/artifacts/baseline)'),
    formal: z.boolean().optional().describe('Produce a formal Engineering or Loop Engineering final report after proof refs validate'),
    suiteRunId: z.string().optional().describe('Formal suite run id binding'),
    claimTarget: z.string().optional().describe('Formal claim target binding; must be engineering or loop-engineering'),
    outcome: z.enum(['PASS', 'FAIL', 'EXPECTED_BLOCK', 'ESCALATED']).optional().describe('Formal baseline outcome'),
    verifiedAt: z.string().optional().describe('Formal proof verification timestamp'),
    verificationEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal test/lifecycle evidence refs, array or comma-separated'),
    reviewEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal dual-host review refs, array or comma-separated'),
    lifecycleGateEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal TEST/DONE gate consumption refs, array or comma-separated'),
    gateEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal risky PASS gate refs, array or comma-separated'),
    receiptRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal local receipt-bundle binding refs, array or comma-separated'),
    plannedStepRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering planned-step refs, array or comma-separated'),
    reviewLoopRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering review-loop refs, array or comma-separated'),
    hostVerdictRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering host verdict refs, array or comma-separated'),
    budgetReportRef: z.string().optional().describe('Formal Loop Engineering budget report ref'),
    stopConditionRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering stop-condition refs, array or comma-separated'),
    authorityMode: z.enum(['non-authority', 'authority']).optional().describe('Baseline authority mode'),
    expectedOutcome: z.enum(['PASS', 'EXPECTED_BLOCK']).optional().describe('Expected outcome override'),
    outputRoot: z.string().optional().describe('Baseline artifact root'),
    requestText: z.string().optional().describe('Original request text override'),
    receiptVerified: z.boolean().optional().describe('Local receipt-bundle verification input'),
    gateReceiptVerifiedAgainstPinnedKey: z.boolean().optional().describe('Local receipt-bundle signature was verified against the pinned public key'),
    gateReceiptJson: z.string().optional().describe('Local receipt-bundle JSON payload'),
    gateReceiptPath: z.string().optional().describe('Path to local receipt-bundle JSON payload'),
    hostVerdictsJson: z.string().optional().describe('Local quorum host verdicts JSON payload'),
    hostVerdictsPath: z.string().optional().describe('Path to local quorum host verdicts JSON payload'),
    satisfiedReviewWaves: z.number().int().nonnegative().optional().describe('Local satisfied review waves'),
    requiredReviewWaves: z.number().int().positive().optional().describe('Local required review waves; floored to 3'),
    staleVerdicts: z.number().int().nonnegative().optional().describe('Local stale verdict count'),
    failingIndependentHosts: z.number().int().nonnegative().optional().describe('Local failing independent host count'),
    serverBackedVerdictsAccepted: z.boolean().optional().describe('@help-hidden legacy baseline compatibility'),
    localReviewCertified: z.boolean().optional().describe('Non-authority local independent review result'),
    localReviewEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Non-authority local independent review evidence refs, array or comma-separated'),
    requiredIndependentHosts: z.number().int().positive().optional().describe('Non-authority required independent local host count'),
    independentHosts: z.number().int().nonnegative().optional().describe('Non-authority observed independent local host count'),
    passingIndependentHosts: z.number().int().nonnegative().optional().describe('Non-authority passing independent local host count'),
    authorityServerContact: z.boolean().optional().describe('@help-hidden legacy baseline compatibility'),
    retryCount: z.number().int().nonnegative().optional().describe('Retry count'),
    repairCount: z.number().int().nonnegative().optional().describe('Repair count'),
    blockedReason: z.string().optional().describe('Specific blocked reason for EXPECTED_BLOCK scenarios'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'baseline_suite', description: 'Aggregate baseline_run final-report artifacts into rates and false-DONE checks. Alias: proof-or-stop baseline suite', schema: {
    layer: z.enum(['development', 'engineering', 'loop-engineering', 'production-safety', 'capability-claim']).optional().describe('Legacy Baseline 2-5 layer to aggregate'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .proof-or-stop/artifacts/baseline)'),
    reportsRoot: z.string().optional().describe('Root directory to scan for final-report.json files'),
    reportFiles: z.union([z.array(z.string()), z.string()]).optional().describe('Explicit final-report.json files, array or comma-separated'),
    outputDir: z.string().optional().describe('Directory for baseline-suite-report artifacts'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'baseline_suite_report', description: 'Aggregate Proof-or-Stop baseline final-report.json files and write baseline-suite-report.json/md. Alias: proof-or-stop baseline suite report', schema: {
    layer: z.enum(['development', 'engineering', 'loop-engineering', 'production-safety', 'capability-claim']).optional().describe('Legacy Baseline 2-5 layer to aggregate'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .proof-or-stop/artifacts/baseline)'),
    reports: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated final-report.json files or directories; defaults to the command report root'),
    outputDir: z.string().optional().describe('Directory for baseline-suite-report.json and baseline-suite-report.md (default command report root)'),
    suiteId: z.string().optional().describe('Suite id to include in the report (default minimum-baseline-suite)'),
    minimumSuiteRequired: z.boolean().optional().describe('Require the six-scenario minimum suite ids and at least six valid runs (default true)'),
    productionNoP0P1BlockersFor30Days: z.boolean().optional().describe('Only set true when the external 30-day blocker-free production requirement is proven'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_status', description: 'Report Proof-or-Stop conduit status and enforce readiness diagnostics without provisioning a runner or widening local assurance. Alias: proof-or-stop conduit status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_explain', description: 'Explain the CLI conduit migration boundary and no-overclaim semantics. Alias: proof-or-stop conduit explain', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_export', description: 'Export a Proof-or-Stop Story as Canonical Story v0 without claiming release readiness', schema: {
    storyId: z.string().describe('Story ID to export'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for canonical-story JSON'),
  }},
  { name: 'observability_snapshot', description: 'Build a host-neutral Proof-or-Stop observability snapshot (assurance ladder, story board, capability matrix, recovery, parallel) without widening local assurance. Alias: proof-or-stop observability snapshot', schema: {
    storyIds: z.array(z.string()).optional().describe('Restrict snapshot to specific story ids'),
    activeOnly: z.boolean().optional().describe('Default true; pass false to include DONE/DISCARDED stories'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for snapshot JSON; refuses to overwrite'),
  }},
  { name: 'handoff_create', description: 'Create a Proof-or-Stop handoff pack from one host to another; includes a memory/playbook packDigest with gateEvidence=false without manufacturing release readiness. Alias: proof-or-stop handoff create', schema: {
    storyId: z.string().describe('Story ID to include in the handoff pack'),
    fromHost: z.string().describe('Source host profile id'),
    toHost: z.string().describe('Target host profile id'),
    role: z.string().optional().describe('Optional overflow role for the external worker'),
    objective: z.string().optional().describe('Optional bounded objective for the overflow worker'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs for overflow edits'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs for overflow edits'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands the overflow worker must run or report'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria for the overflow worker'),
    baseSha: z.string().optional().describe('Optional explicit base SHA; defaults to current HEAD'),
    packId: z.string().optional().describe('Optional explicit pack id; defaults to HP-<digest>'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary carried into the pack'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions for the overflow worker'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Explicit proof refs to evaluate for HANDOFF admissibility under project proofAdmissibility policy'),
    primaryHostFailure: z.string().optional().describe('Required only when toHost is agy/antigravity fallback: concrete Codex/Claude failure signal such as unavailable, quota-limited, timed-out, or explicitly-substituted'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for handoff-pack JSON'),
  }},
  { name: 'handoff_inspect', description: 'Inspect a Proof-or-Stop handoff pack and show capability deltas, degradations, evidence refs, and authority boundary. Alias: proof-or-stop handoff inspect', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while inspecting'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'handoff_accept', description: 'Accept a Proof-or-Stop handoff pack as a process-event style projection without changing authority. Alias: proof-or-stop handoff accept', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    acceptedByHost: z.string().optional().describe('Accepting host profile id; defaults to the handoff target host'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while accepting'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for accept projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_resume', description: 'Project a resume plan from a handoff pack or accept projection without refreshing evidence or authority. Alias: proof-or-stop handoff resume', schema: {
    file: z.string().describe('Handoff pack JSON file or handoff_accept projection JSON file'),
    resumeHost: z.string().optional().describe('Resume host profile id; defaults to acceptedByHost or target host'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while resuming'),
    primaryHostFailure: z.string().optional().describe('Required only when resumeHost is agy/antigravity fallback: concrete Codex/Claude failure signal'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for resume projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_receipt_submit', description: 'Validate and accept a local overflow receipt as diagnostic evidence only; never changes authority. Alias: proof-or-stop handoff receipt submit', schema: {
    file: z.string().describe('Handoff receipt JSON file'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while submitting the local receipt'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for receipt-submit projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_worktree_create', description: 'Project isolated overflow worktree guidance from a handoff pack without creating or merging anything. Alias: proof-or-stop handoff worktree create', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for worktree projection JSON; refuses to overwrite'),
  }},
  { name: 'host_dispatch', description: 'Project supervised host dispatch for an overflow pack without auto-trust, evidence submit, receipt verify, or merge. Alias: proof-or-stop host dispatch', schema: {
    host: z.string().describe('Target host profile id, for example claude-code'),
    file: z.string().describe('Handoff pack JSON file'),
    mode: z.enum(['supervised']).optional().describe('Dispatch mode; only supervised projection is supported'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility during dispatch preflight'),
    primaryHostFailure: z.string().optional().describe('Required only when host is agy/antigravity fallback: concrete Codex/Claude failure signal'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch projection JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_plan', description: 'Plan a dispatch runtime handoff without creating a worktree, receipt, or running an external host. Alias: proof-or-stop dispatch plan', schema: {
    storyId: z.string().describe('Story ID to dispatch'),
    host: z.string().optional().describe('Target runtime id or auto (default auto)'),
    fromHost: z.string().optional().describe('Source host id; defaults to codex'),
    role: z.string().optional().describe('Optional runtime role'),
    objective: z.string().optional().describe('Optional bounded objective'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria'),
    baseSha: z.string().optional().describe('Optional explicit base SHA'),
    packId: z.string().optional().describe('Optional explicit pack id'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions'),
    parallel: z.number().optional().describe('Optional parallel fake worker count'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch plan JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_prepare', description: 'Persist dispatch metadata, prompt placeholders, and bounded pack state without running a host. Alias: proof-or-stop dispatch prepare', schema: {
    storyId: z.string().describe('Story ID to dispatch'),
    dispatchId: z.string().optional().describe('Optional explicit dispatch id'),
    host: z.string().optional().describe('Target runtime id or auto (default auto)'),
    fromHost: z.string().optional().describe('Source host id; defaults to codex'),
    role: z.string().optional().describe('Optional runtime role'),
    objective: z.string().optional().describe('Optional bounded objective'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria'),
    baseSha: z.string().optional().describe('Optional explicit base SHA'),
    packId: z.string().optional().describe('Optional explicit pack id'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions'),
    parallel: z.number().optional().describe('Optional parallel fake worker count'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch record JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_run', description: 'Run fake dispatch locally or materialize real-host scaffolding without claiming authority. Alias: proof-or-stop dispatch run', schema: {
    storyId: z.string().optional().describe('Story ID when creating a new dispatch'),
    dispatchId: z.string().optional().describe('Existing dispatch id to resume/run'),
    host: z.string().optional().describe('Target runtime id or auto (default auto)'),
    fromHost: z.string().optional().describe('Source host id; defaults to codex'),
    role: z.string().optional().describe('Optional runtime role'),
    objective: z.string().optional().describe('Optional bounded objective'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria'),
    baseSha: z.string().optional().describe('Optional explicit base SHA'),
    packId: z.string().optional().describe('Optional explicit pack id'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions'),
    parallel: z.number().optional().describe('Optional parallel fake worker count'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch-run JSON; refuses to overwrite'),
  }},
  { name: 'overflow_auto', description: 'Guarded alias over auto dispatch selection; defaults to suggest-only and requires visible approval to start. Alias: proof-or-stop overflow auto', schema: {
    storyId: z.string().describe('Story ID to dispatch'),
    dispatchId: z.string().optional().describe('Existing dispatch id to reuse'),
    host: z.string().optional().describe('Target runtime id or auto (default auto)'),
    fromHost: z.string().optional().describe('Source host id; defaults to codex'),
    role: z.string().optional().describe('Optional runtime role'),
    objective: z.string().optional().describe('Optional bounded objective'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria'),
    baseSha: z.string().optional().describe('Optional explicit base SHA'),
    packId: z.string().optional().describe('Optional explicit pack id'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions'),
    parallel: z.number().optional().describe('Optional parallel fake worker count'),
    approve: z.boolean().optional().describe('Visible approval gate to start instead of suggest-only'),
    start: z.boolean().optional().describe('Start the selected path instead of suggest-only mode'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for overflow_auto JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_collect', description: 'Collect git-derived base/head/changedFiles/transcript diagnostics for one dispatch. Alias: proof-or-stop dispatch collect', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch collect JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_receipt_create', description: 'Create a draft local handoff receipt from collected dispatch state. Alias: proof-or-stop dispatch receipt create', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch receipt JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_status', description: 'Inspect one dispatch lifecycle record and any derived receipt state. Alias: proof-or-stop dispatch status', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch status JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_list', description: 'List persisted dispatch lifecycle records. Alias: proof-or-stop dispatch list', schema: {
    storyId: z.string().optional().describe('Optional story filter'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch list JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_resume', description: 'Resume or rerun an existing dispatch lifecycle record. Alias: proof-or-stop dispatch resume', schema: {
    dispatchId: z.string().describe('Dispatch id to resume'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch resume JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_reassign', description: 'Create a fresh-context worker reassignment from an existing dispatch without forking full history. Alias: proof-or-stop dispatch reassign', schema: {
    dispatchId: z.string().describe('Existing dispatch id to reassign from'),
    host: z.string().optional().describe('Target runtime id or auto; defaults to the previous selected host'),
    fromHost: z.string().optional().describe('Source host id; defaults to the previous handoff pack fromHost'),
    role: z.string().optional().describe('Explicit worker role for the reassignment; defaults to overflow-worker'),
    objective: z.string().optional().describe('Optional bounded objective; defaults from the previous handoff pack objective'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs; defaults from the previous handoff pack'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs; defaults from the previous handoff pack'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands; defaults from the previous handoff pack'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria; defaults from the previous handoff pack'),
    baseSha: z.string().optional().describe('Optional explicit base SHA; defaults from the previous handoff pack'),
    packId: z.string().optional().describe('Optional explicit pack id for the new reassignment'),
    authorityBoundary: z.string().optional().describe('Optional local responsibility boundary summary; defaults from the previous handoff pack'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions; defaults from the previous handoff pack'),
    parallel: z.number().optional().describe('Optional parallel fake worker count for the new reassignment'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch reassignment JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_cancel', description: 'Cancel a dispatch without deleting its metadata or changing authority. Alias: proof-or-stop dispatch cancel', schema: {
    dispatchId: z.string().describe('Dispatch id to cancel'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch cancel JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_review', description: 'Summarize one dispatch, its receipt state, warnings, and git-derived changedFiles. Alias: proof-or-stop dispatch review', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch review JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_merge_plan', description: 'Produce manual-only merge guidance for accepted_local dispatches. Alias: proof-or-stop dispatch merge plan', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch merge-plan JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_create', description: 'Create and persist a named dispatch policy for user-authorized unattended scheduling. Alias: proof-or-stop dispatch policy create', schema: {
    policy: z.string().describe('Policy name (alphanumeric, hyphen, underscore; 1-64 chars)'),
    allowedHosts: z.union([z.string(), z.array(z.string())]).describe('Allowed host IDs (fake, codex, claude-code, antigravity; agy aliases to antigravity; gemini is legacy-only)'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).describe('Allowed relative paths (no absolute or traversal)'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Explicitly denied relative paths'),
    maxParallel: z.number().int().positive().describe('Maximum concurrent workers (1-10)'),
    maxRuntimeMinutes: z.number().int().positive().describe('Maximum runtime per worker in minutes (1-1440)'),
    maxBudgetUSD: z.number().positive().optional().describe('Optional budget cap in USD; omitting degrades to supervised'),
    network: z.enum(['none', 'local', 'restricted']).optional().describe('Network access policy; omitting degrades to supervised'),
    envAllowlist: z.union([z.string(), z.array(z.string())]).optional().describe('Allowed environment variable names (no TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL)'),
    envDenylist: z.union([z.string(), z.array(z.string())]).optional().describe('Denied environment variable names'),
    commandAllowlist: z.union([z.string(), z.array(z.string())]).optional().describe('Allowed command patterns; required for unattended authorization'),
    retryLimit: z.number().int().min(0).optional().describe('Retry limit per worker (default 0)'),
    requireReceipt: z.boolean().optional().describe('Require a local receipt; must be true'),
    requireReview: z.boolean().optional().describe('Require manual review; must be true'),
    allowRealHostSubprocess: z.boolean().optional().describe('Explicit opt-in for real-host subprocess launch; defaults false and currently supports claude-code only'),
    allowReviewOnlyRealHostSubprocess: z.boolean().optional().describe('Explicit opt-in for a read-only codex REVIEW subprocess (cross_host_review); permits codex only, mutually exclusive with allowRealHostSubprocess, refuses gemini/antigravity'),
    allowAutoMerge: z.boolean().optional().describe('Allow auto-merge; must be false'),
    allowProductionDone: z.boolean().optional().describe('@help-hidden legacy local-assurance refusal sentinel'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_get', description: 'Read a named dispatch policy. Alias: proof-or-stop dispatch policy get', schema: {
    policy: z.string().describe('Policy name'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_check', description: 'Check authorization status of a named dispatch policy for unattended scheduling. Alias: proof-or-stop dispatch policy check', schema: {
    policy: z.string().describe('Policy name to check'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy check JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_auto', description: 'Policy-authorized unattended scheduler: reads dispatch_policy_check, enforces maxParallel/host/scope limits, starts deterministic fake workers; current host policies can name codex, claude-code, or antigravity, but real subprocess launch remains explicit and bounded. Alias: proof-or-stop dispatch auto', schema: {
    storyId: z.string().describe('Story ID to schedule dispatch for'),
    policy: z.string().describe('Policy name that authorizes unattended scheduling'),
    host: z.string().optional().describe('Override host (must be in policy allowedHosts; defaults to first policy-allowed host)'),
    fromHost: z.string().optional().describe('Dispatching host identity (default: codex)'),
    role: z.string().optional().describe('Worker role label'),
    objective: z.string().optional().describe('Objective for this dispatch'),
    allowedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Paths the worker may write'),
    deniedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Paths the worker must not write'),
    requiredCommands: z.union([z.array(z.string()), z.string()]).optional().describe('Commands the worker must run'),
    successCriteria: z.union([z.array(z.string()), z.string()]).optional().describe('Acceptance criteria for this dispatch'),
    baseSha: z.string().optional().describe('Git base SHA for evidence freshness'),
    packId: z.string().optional().describe('Optional pack id override'),
    authorityBoundary: z.string().optional().describe('Local responsibility boundary statement'),
    executionInstructions: z.union([z.array(z.string()), z.string()]).optional().describe('Instructions for the worker'),
    parallel: z.number().optional().describe('Worker count (capped at policy maxParallel)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch_auto JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_watch', description: 'Read-only lifecycle aggregation for one dispatch: status, workers, runner summary, changedFiles count, nextAction. Alias: proof-or-stop dispatch watch', schema: {
    dispatchId: z.string().describe('Dispatch ID to watch'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch_watch JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_policy_create', description: 'Create and persist a named local autopilot execution policy without starting workers. Alias: proof-or-stop autopilot policy create', schema: {
    policy: z.string().describe('Policy name (alphanumeric, hyphen, underscore; 1-64 chars)'),
    mode: autopilotModeSchema.optional().describe('Autopilot execution mode (default conservative in core policy)'),
    dispatchPolicy: z.string().optional().describe('Underlying dispatch policy name to enforce for worker scheduling'),
    allowAutoDispatch: z.boolean().optional().describe('Allow autopilot to schedule dispatch under policy constraints'),
    allowAutoValidate: z.boolean().optional().describe('Allow autopilot to run validation commands under policy constraints'),
    allowAutoFix: z.boolean().optional().describe('Allow bounded fix retries'),
    allowStoryIntegration: z.boolean().optional().describe('Allow story-branch integration only when local lifecycle gates permit it'),
    allowDoneAdvance: z.boolean().optional().describe('Allow lifecycle DONE advance only when local lifecycle gates permit it'),
    allowMainMerge: z.boolean().optional().describe('Allow main merge only when local lifecycle gates permit it'),
    maxIterations: z.number().int().positive().optional().describe('Maximum autopilot loop iterations'),
    maxRuntimeMinutes: z.number().int().positive().optional().describe('Maximum total autopilot runtime in minutes'),
    maxBudgetUSD: z.number().positive().optional().describe('Optional budget cap in USD'),
    stopOnConflict: z.boolean().optional().describe('Stop when a conflict is detected'),
    stopOnScopeViolation: z.boolean().optional().describe('Stop when scope guard reports a violation'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_policy_get', description: 'Read a named autopilot policy. Alias: proof-or-stop autopilot policy get', schema: {
    policy: z.string().describe('Policy name'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_policy_check', description: 'Check a named local autopilot policy. Alias: proof-or-stop autopilot policy check', schema: {
    policy: z.string().describe('Policy name to check'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy check JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_run', description: 'Run a saved local autopilot policy for a story. Alias: proof-or-stop autopilot run', schema: {
    storyId: z.string().describe('Story ID to run autopilot for'),
    policy: z.string().describe('Saved autopilot policy name; its dispatchPolicy selects the underlying dispatch policy'),
    mode: autopilotModeSchema.optional().describe('Optional expected mode assertion; must match the saved autopilot policy and cannot widen it'),
    runId: z.string().optional().describe('Optional explicit run id when core supports it'),
    host: z.string().optional().describe('Override host, constrained by policy'),
    fromHost: z.string().optional().describe('Dispatching host identity'),
    role: z.string().optional().describe('Worker role label'),
    objective: z.string().optional().describe('Bounded objective for this run'),
    allowedPaths: stringOrStringArraySchema.optional().describe('Paths the run may write'),
    deniedPaths: stringOrStringArraySchema.optional().describe('Paths the run must not write'),
    requiredCommands: stringOrStringArraySchema.optional().describe('Commands the run must execute or verify'),
    successCriteria: stringOrStringArraySchema.optional().describe('Acceptance criteria for the run'),
    baseSha: z.string().optional().describe('Git base SHA for evidence freshness'),
    packId: z.string().optional().describe('Optional pack id override'),
    authorityBoundary: z.string().optional().describe('Local responsibility boundary statement'),
    executionInstructions: stringOrStringArraySchema.optional().describe('Instructions for the worker'),
    parallel: z.number().optional().describe('Worker count, capped by policy'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot run JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_status', description: 'Read one persisted autopilot run status. Alias: proof-or-stop autopilot status', schema: {
    runId: z.string().describe('Autopilot run ID to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot status JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_watch', description: 'Read-only lifecycle aggregation for one autopilot run. Alias: proof-or-stop autopilot watch', schema: {
    runId: z.string().describe('Autopilot run ID to watch'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot watch JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_cancel', description: 'Cancel an autopilot run without deleting evidence or changing authority. Alias: proof-or-stop autopilot cancel', schema: {
    runId: z.string().describe('Autopilot run ID to cancel'),
    reason: z.string().optional().describe('Optional cancellation reason'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot cancel JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_review', description: 'Summarize an autopilot run, warnings, evidence, and authority posture without mutating it. Alias: proof-or-stop autopilot review', schema: {
    runId: z.string().describe('Autopilot run ID to review'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot review JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_resume', description: 'Replay a persisted autopilot checkpoint ledger and return an M1 resume projection without launching workers or changing authority. Alias: proof-or-stop autopilot resume', schema: {
    runId: z.string().describe('Autopilot run ID to resume'),
    maxResumeAgeMs: z.number().int().positive().optional().describe('Maximum age in ms for a persisted run to be considered resumable by core'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot resume JSON; refuses to overwrite'),
  }},
  { name: 'evidence_manifest', description: 'Create a portable evidence freshness manifest with transcript/test refs and authority guidance only', schema: {
    storyId: z.string().describe('Story ID to inspect for evidence refs'),
    sourceHost: z.string().describe('Source host profile id for portability diagnostics'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for evidence manifest JSON; refuses to overwrite'),
  }},
  { name: 'evidence_inspect', description: 'Inspect a portable evidence manifest or Story evidence against current HEAD/material hash without refreshing evidence', schema: {
    file: z.string().optional().describe('Evidence manifest JSON file; mutually exclusive with storyId'),
    storyId: z.string().optional().describe('Story ID for story-based evidence inspection; mutually exclusive with file'),
    sourceHost: z.string().optional().describe('Source host profile id for story-based inspection; defaults to codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for evidence inspection JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_create', description: 'Create a Proof-or-Stop Parallel Wave scheduling projection over Canonical Stories without authority changes', schema: {
    storyIds: z.array(z.string()).optional().describe('Story IDs to include; omit to analyze active stories'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id; defaults to a deterministic id from story refs'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for wave JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_inspect', description: 'Inspect a Proof-or-Stop Parallel Wave JSON file without refreshing evidence or authority', schema: {
    file: z.string().describe('Parallel Wave JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for inspection JSON; refuses to overwrite'),
  }},
  { name: 'parallel_plan', description: 'Produce a parallel execution plan from a wave file or active stories without creating authority evidence', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc plan'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for plan JSON; refuses to overwrite'),
  }},
  { name: 'parallel_dispatch', description: 'Project operator-confirmed parallel dispatch entries without spawning agents or changing authority', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc dispatch projection'),
    includeExperience: z.boolean().optional().describe('Include bounded non-authoritative dev-memory refs (default false)'),
    experienceQuery: z.string().optional().describe('Query for bounded dev-memory refs when includeExperience=true'),
    maxExperienceRefs: z.number().optional().describe('Maximum dev-memory refs to include; capped by core policy'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for dispatch JSON; refuses to overwrite'),
  }},
  { name: 'parallel_status', description: 'Project parallel wave status counts and ready/blocked guidance without authority changes', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc status projection'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for status JSON; refuses to overwrite'),
  }},
  { name: 'parallel_merge_queue', description: 'Project merge queue readiness and blockers from a Parallel Wave without mutating story state', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc merge queue projection'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for merge queue JSON; refuses to overwrite'),
  }},
  { name: 'parallel_report', description: 'Project a full parallel wave report with dispatch, evidence, guidance, and bounded memory refs', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc report projection'),
    includeExperience: z.boolean().optional().describe('Include bounded non-authoritative dev-memory refs (default false)'),
    experienceQuery: z.string().optional().describe('Query for bounded dev-memory refs when includeExperience=true'),
    maxExperienceRefs: z.number().optional().describe('Maximum dev-memory refs to include; capped by core policy'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for report JSON; refuses to overwrite'),
  }},

  // Doctor (health issue inspection).
  { name: 'doctor', description: 'View Proof-or-Stop health issues (silent-caught PERSIST fails); scan orphan worktrees. Also runs the B-623a ADVISORY host burn scan: read-only stream over recently-active ~/.codex/sessions and ~/.claude/projects transcripts flagging long-thread token burn (env-tunable thresholds; PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS=0 disables; never gates, no gate evidence, exit code unchanged)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default: text).'),
    limit: z.number().optional().describe('Maximum number of entries to read (default: 1000).'),
    repair: z.boolean().optional().describe('Clean DONE/DISCARDED terminal worktree registrations, orphan directories, and prunable metadata.'),
    runtimeArtifact: z.enum(['runtime-causal-evidence-receipts']).optional().describe('With repair:true, only migrate causal cache ignore rules and untrack index/receipt cache files; preserves bytes and skips all other repair operations.'),
    ...BRIEF_OUTPUT_FLAGS,
  }},
  { name: 'done_recover', description: 'Recover a partial-DONE story (phase DONE but branch not yet merged into main)', schema: {
    storyId: z.string().describe('Story ID to recover.'),
  }},
  { name: 'release_approve_push', description: 'Create a short-lived local approval for one remote main push; never pushes by itself', schema: {
    confirm: z.boolean().optional().describe('Required explicit human confirmation; must be true'),
    sha: z.string().optional().describe('Expected commit SHA/ref to publish; defaults to HEAD and is resolved to a full SHA'),
    ttlSeconds: z.number().optional().describe('Approval TTL in seconds; defaults to 300 and is capped at 900'),
    remote: z.string().optional().describe('Remote name the approval is valid for; defaults to origin'),
    reason: z.string().optional().describe('Human reason recorded in the local approval file'),
    approvedBy: z.string().optional().describe('Human/operator label recorded in the local approval file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'verify_codex', description: 'Verify Codex adapter assets, entrypoint heartbeat, and hard evidence', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
    storyId: z.string().optional().describe('Optional Story ID; defaults to inferring from the story/* branch and recording process-event evidence.'),
    heartbeatTimeoutMs: z.number().int().positive().max(GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS, `heartbeatTimeoutMs must be <= ${GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS}ms`).optional().describe(`B-cdf6 bounded audited override: raise the GLOBAL-FALLBACK heartbeat budget above the ${DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS}ms default. session_brief aggregates every active story before writing its heartbeat, so a large repository legitimately needs longer and would otherwise fail this check with no honest way to pass. Requires heartbeatTimeoutReason. Cap ${GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS}ms; above the cap is REFUSED, never clamped. Does NOT affect the conservative local wrapper probe. The armed budget + reason are echoed into the check detail.`),
    heartbeatTimeoutReason: z.string().min(HEARTBEAT_TIMEOUT_REASON_MIN_CHARS, `heartbeatTimeoutReason must be >= ${HEARTBEAT_TIMEOUT_REASON_MIN_CHARS} characters`).optional().describe('B-cdf6: attributable justification REQUIRED whenever heartbeatTimeoutMs is supplied. Echoed into the check detail so a reviewer sees the pass was earned under a raised budget.'),
  }},
  { name: 'codex_doctor', description: 'Report Codex adapter diagnostics status', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
  }},
  { name: 'check', description: 'Check Proof-or-Stop asset/template drift; --apply/--upgrade sync safe items explicitly', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
    apply: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets; does not overwrite CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE.'),
    upgrade: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets to current Proof-or-Stop templates; equivalent to --apply.'),
    reviewLocalEdits: z.boolean().optional().describe('Output structured manual review summary for STALE_LOCAL_EDIT.'),
    profile: z.enum(['codex', 'claude', 'all', 'core']).optional().describe('Override auto-detected init profile.'),
    assetMode: z.enum(['full', 'thin']).optional().describe('Override Codex prompt asset mode; full=generate .proof-or-stop-codex/agents, thin=use prompt registry.'),
  }},

  // Audit (framework self-audit: scan CLAUDE.md promises across stories versus actual CLI behavior drift).
  { name: 'audit', description: 'Framework self-audit: scan CLAUDE.md drift, write audit finding plus report.md', schema: {
    framework: z.boolean().optional().describe('Scan CLI command/flag/path drift in CLAUDE.md and packages/main/CLAUDE.md (current MVP only mode).'),
    mode: z.enum(['semi-auto', 'full-auto', 'off']).optional().describe('Override configured default mode; off exits immediately without running.'),
  }},

  // Gap Log (B-3fad CHK-002: manual framework gap archive entrypoint).
  // Write B-META-framework-audit findings (bootstrap ensureMetaStory if missing); does not depend on reviewer /
  // review round or story worktree, and does not participate in lifecycle gates. Default evidenceState=suspected;
  // verified requires paired structured evidence (runtime applies the same validation standard; see CLAUDE.md Handler coding convention).
  { name: 'gap_log', description: 'Manually archive a framework gap into the B-META-framework-audit backlog', schema: {
    category: z.enum(['happy', 'edge', 'adversarial', 'missing']).describe('Finding category.'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Severity.'),
    evidence: z.string().min(1, 'evidence is required and must be at least 1 character').describe('Gap description (the finding evidence note).'),
    sourceRefs: z.array(z.string()).optional().describe('Source trace: source/documentation location, for example src/foo.ts:42.'),
    reproCommand: z.string().optional().describe('Source trace: reproduction/observation command.'),
    observedOutput: z.string().optional().describe('Source trace: observed actual output.'),
    analysisNote: z.string().optional().describe('Source trace: analysis note.'),
    evidenceState: z.enum(['suspected', 'verified']).optional()
      .describe('Evidence state: default suspected; verified is allowed only when structured evidence is provided, otherwise it is forced back to suspected.'),
    uncertaintyReason: z.string().optional().describe('Suspicion reason for suspected state (optional; automatic fallback if omitted).'),
    files: z.array(z.string()).optional().describe('Related file paths.'),
    agent: z.string().optional().describe('Caller identity (audit field, defaults from PROOF_OR_STOP_AGENT).'),
  }},

  // Verifier (Proof-or-Stop built-in code verification).
  { name: 'validate', description: 'Run project verification under shared workspace validation capacity; bare npm test is outside this lease', longHelp: VALIDATE_LONG, schema: {
    full: z.union([z.string(), z.boolean()]).optional().describe('Include real-machine tests (--full or --full=PvE to filter by name).'),
    focus: z.string().optional().describe('Run an explicit focused validate profile, for example --focus=fast. Configured commands must opt in with focus tags; no-focus validate remains full.'),
    dynamicMode: z.enum(['off', 'observe', 'shadow', 'enforce-low-risk']).optional().describe('Story-aware validation mode. Defaults to off; observe/shadow retain the complete-plan oracle.'),
    reuseFreshRoutinePass: z.boolean().optional().describe('Override validate.reuseFreshRoutinePass: allow strict whole-PASS reuse in observe mode without claiming a new oracle run. Default false; explicit false forces execution in observe mode.'),
    story: z.string().optional().describe('Run only transitions affected by the story changes (used by TEST gate).'),
    storyId: z.string().optional().describe('B-a30e: alias for --story; error when both are provided with different values.'),
    json: z.boolean().optional().describe('Structured JSON output (ExternalVerifierResult).'),
    // B-9d95 CHK-006: independent REVIEW to TEST preflight CLI gate flag.
    // If any flag matches, run only the corresponding CLI gate and do not spawn pytest (returns in seconds).
    // If multiple flags are provided, run them in parallel with Promise.all; any failure exits 1.
    channel: z.boolean().optional().describe('B-9d95: run only the --channel gate (commit author scan, requires --story).'),
    concept: z.boolean().optional().describe('B-9d95: run only the --concept gate (deleted symbol residue scan).'),
    lint: z.boolean().optional().describe('B-9d95: run only the --lint gate (tsc + ruff + import-graph).'),
    noSync: z.boolean().optional().describe('Skip cluster commit auto-resolve sync before validate (diagnostic use).'),
  }},
  { name: 'status', description: 'Project overview (story progress plus code verification status)', schema: {
    concise: z.boolean().optional().describe('Concise mode (skips code verification, under 4 KB, for hook injection).'),
  }},
  { name: 'serve', description: 'Start HTTP API debug server (watch files + live verification + browser proxy)', schema: {
    dev: z.string().optional().describe('Dev server command, for example npm run dev; enables browser proxy.'),
    port: z.number().optional().describe('API port (default: 3456).'),
  }},
  { name: 'graph', description: 'Interactive story + evidence graph for this repository (reads story state; writes its index cache outside the repo)', longHelp:
`proof-or-stop graph [--root=<dir>] [--port=<n>] [--no-open] [--json] [--story=<id>]

Read-only visualizer for the stories and evidence of a Proof-or-Stop repository:
a browsable graph plus full-text search and per-story detail.

Options:
  --root=<dir>   Repository to read (default: nearest Proof-or-Stop root from cwd).
  --port=<n>     HTTP port (default: 8731; 0 lets the OS choose a free port).
  --no-open      Do not launch a browser.
  --json         Print status as JSON and exit without serving.
  --story=<id>   Open the graph on that story's dossier page (/story/<id>) instead
                 of the root graph view (default: the root view). An id that is not
                 a story in this repository is refused before the server listens,
                 and the error names near-miss candidates.

Behavior:
  - Reads story state only; it never mutates story metadata, so it is allowed in
    every phase (readOnly / destructiveRisk none).
  - Its search index is written under the user cache directory, keyed by a hash of
    the repository root, so running it never dirties the worktree that DONE gates
    on a clean tree.
  - The graph library, browser client and static assets live in the packages/graph
    subpackage and are resolved at runtime; if they are missing, the command names
    the missing directory and the build command instead of failing obscurely.
  - Long-running when it serves (same shape as serve): the command stays in the
    foreground until interrupted.`,
    schema: {
    root: z.string().optional().describe('Repository to read (default: nearest Proof-or-Stop root from cwd).'),
    port: z.number().optional().describe('HTTP port (default: 8731; 0 lets the OS choose a free port).'),
    // Default true, applied in the handler (`args.open !== false`), NOT via
    // `.default(true)`: the help renderer detects optionality with
    // `instanceof ZodOptional`, and a ZodDefault wrapper would render this flag
    // as required with type `any`. Every other catalog flag follows this same
    // convention — document the default in the description, apply it in code.
    open: z.boolean().optional().describe('Launch a browser once the server is listening; default true, use --no-open to suppress.'),
    json: z.boolean().optional().describe('Print status as JSON and exit without serving.'),
    // Optional with the default documented here, NOT `.default()` — same reason as
    // `open` above: a ZodDefault wrapper defeats the help renderer's ZodOptional
    // check and would render this flag as required with type `any`. The handler
    // re-validates the value at its entry, so a schema-bypassing call is refused too.
    story: z.string().optional().describe('Open the graph on that story\'s dossier page (/story/<id>); default is the root graph view. An unknown id is refused before the server listens.'),
  }},

  // Evaluate (AI evaluation for browser projects).
  { name: 'evaluate', description: 'Ask the evaluator agent to score a browser app (completeness and usability)', schema: {
    storyId: z.string().describe('Story ID'),
    port: z.number().optional().describe('proof-or-stop serve port (default: 3456).'),
  }},
  { name: 'evaluate_save', description: 'Save evaluator scoring result to eval-evidence.json', schema: {
    storyId: z.string().describe('Story ID'),
    result: z.string().describe('JSON string output by evaluator.'),
  }},

  // Finding (Proof-or-Stop reviewer finding).
  { name: 'finding_add', description: 'Add a finding (Proof-or-Stop reviewer finding)', schema: {
    storyId: z.string().describe('Story ID'),
    desc: z.string().describe('Finding description.'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Severity.'),
    category: z.enum([
      'happy',
      'edge',
      'adversarial',
      'missing',
      'cleanup',
      'doc-promise-undelivered',
      'doc-code-drift',
      'spec-boundary',
    ]).describe('Category (legacy category is normalized to missing).'),
    agent: z.string().optional().describe('Caller identity (optional, defaults from PROOF_OR_STOP_AGENT environment variable).'),
    reviewRunId: z.string().optional().describe('Current proof-or-stop-review-* reviewer run ID (call review_run_start first; main finding may omit this).'),
    idempotencyKey: z.string().min(1).optional().describe('Caller retry key. Reusing it with identical bytes returns the original ledger record/display ID; conflicting bytes fail closed. Omitted calls receive a fresh UUID key.'),
    files: z.array(z.string()).optional().describe('Related file paths (for reviewer finding clustering and traceability).'),
    // B-3fad CHK-001: evidence state axis. Omitted value defaults to verified for REVIEW-stage reviewer findings, preserving current gate behavior.
    // suspected requires uncertaintyReason; disproven requires disprovenEvidence.summary (runtime applies the same standard validation).
    evidenceState: z.enum(['suspected', 'verified', 'disproven']).optional()
      .describe('Evidence state: suspected (uncertain, non-blocking gate) / verified (default, evidenced, blocking) / disproven (refuted, non-blocking).'),
    uncertaintyReason: z.string().optional()
      .describe('Required when evidenceState=suspected (at least 10 characters): why it is only a suspicion.'),
    disprovenEvidence: z.object({
      summary: z.string().describe('Refutation summary: why this finding does not hold.'),
      sourceRefs: z.array(z.string()).optional().describe('Source/documentation locations referenced by the refutation.'),
      reproCommand: z.string().optional().describe('Reproduction/verification command used for refutation.'),
    }).optional().describe('Required when evidenceState=disproven: refutation summary plus command plus source references.'),
    // B-4f46 CHK-002 (Experience Layer Phase 1b): audit-only signature tag. Additive/optional; never read by any gate, excluded from the finding signature.
    signatureTag: z.string().optional()
      .describe('Audit-only signature tag grouping this finding into a recurring pattern family (auto-proposed to the signature-registry if new). Never read by any gate.'),
    readManifest: reviewerReadManifestSchema.optional().describe('Required when pass-only finding_add text is converted into review_pass_set evidence; also required for reviewer finding_add when readEvents/readLog is supplied.'),
    readEvents: reviewerReadEventsSchema.optional().describe('Optional mechanical read events for reviewer finding_add. Requires readManifest for proof-or-stop-review-* agents; non-reviewer usage is ignored by the read-evidence capture path, and mismatch diagnostics are decisions-doc scoped.'),
    readLog: reviewerReadLogInputSchema.optional().describe('Optional mechanical read-log input for reviewer finding_add: event array or {events:[...]}. Requires readManifest for proof-or-stop-review-* agents; mismatch diagnostics are decisions-doc scoped.'),
  }},
  { name: 'finding_list', description: 'View story findings', schema: {
    storyId: z.string().describe('Story ID'),
    cluster: z.boolean().optional().describe('B-9d95 CHK-005: return cluster view { clusters, ungrouped } instead of flat findings.'),
    ...BRIEF_OUTPUT_FLAGS,
    ...JSON_OUTPUT_FLAGS,
  }},
  { name: 'finding_progress_predecessor', description: 'Source-owned signed neutral predecessor reference; does not prove deferral validity or renewal eligibility', schema: progressPredecessorRequestSchema.shape },
  { name: 'finding_identity_confirm', description: 'Strict signed non-gate finding identity confirm with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: identityConfirmSchema.shape },
  { name: 'finding_identity_query', description: 'Strict signed non-gate finding identity query with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: identityQuerySchema.shape },
  { name: 'finding_supersession_add', description: 'Append reviewer-authorized exact historical Finding correction without rewriting observations', schema: findingSupersessionRequestSchema.shape },
  { name: 'finding_identity_supersede', description: 'Stage and activate an exact signed canonical cause correction; unlinked revisions are never current', schema: canonicalSupersessionRequestSchema.shape },
  { name: 'finding_history_query', description: 'Read a complete versioned exact history projection with immutable predecessor trails and distinct projection digest', schema: historyQuerySchema.shape },
  { name: 'finding_identity_scorecard', description: 'Read complete signed-carrier rows and a current digest-bound non-gate scorecard; adjudication counts are not precision/recall', schema: scorecardQuerySchema.shape },
  { name: 'finding_history_recall', description: 'Recall a verified historical trigger once as a non-gate candidate, never as an assessment', schema: historyRecallSchema.shape },
  { name: 'finding_route_accept', description: 'Strict signed non-gate finding route accept with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: routeRequestSchema.shape },
  { name: 'finding_route_reject', description: 'Strict signed non-gate finding route reject with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: routeRequestSchema.shape },
  { name: 'finding_route_revoke', description: 'Strict signed non-gate finding route revoke with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: routeRevokeSchema.shape },
  { name: 'finding_route_verify', description: 'Strict signed non-gate finding route verify with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: routeVerifySchema.shape },
  { name: 'finding_candidate_route', description: 'Strict signed non-gate finding candidate route with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: candidateRouteRequestSchema.shape },
  { name: 'finding_progress_capture', description: 'Strict signed non-gate finding progress capture with exact target/source evidence and owner currentness; never changes lifecycle authority', schema: progressCaptureSchema.shape },
  { name: 'finding_candidate_add', description: 'Append a non-authoritative detector signal and pending candidate with exact source anchors, retry identity, and preregistered reproduction command template/selector; never creates a verified Finding', schema: candidateAddSchema.shape },
  { name: 'finding_candidate_get', description: 'Inspect verified immutable candidate versions and source lineage; read-only and never gate evidence', schema: candidateGetSchema.shape },
  { name: 'finding_candidate_merge', description: 'Append evidenced candidate merge versions with exact current hashes while retaining both sources; no semantic-defect confirmation or Finding mutation', schema: candidateMergeSchema.shape },
  { name: 'finding_candidate_disprove', description: 'Append an evidenced non-gate disproof retaining the original candidate', schema: candidateDisproveSchema.shape },
  { name: 'finding_candidate_promote', description: 'Eligible current reviewer signs a non-gate semantic reproduction attestation bound to the exact candidate hash, preregistered command/selector, causal receipt, and existing verified Finding; marker-only receipt evidence cannot promote', schema: candidatePromoteSchema.shape },
  { name: 'finding_ledger_query', description: 'Read a complete signed ledger/CAS/idempotency/runtime/migration scorecard projection without exposing protected storage paths', schema: {
    storyId: z.string().describe('Story ID.'),
  }},
  { name: 'finding_runtime_evidence_run', description: 'Run a structured build/execution command and append a content-addressed RuntimeEvidenceReceipt', schema: {
    storyId: z.string().describe('Story ID.'),
    sourceRef: z.string().regex(/^[a-f0-9]{40,64}$/).optional().describe('Exact ancestor commit executed in a detached temporary worktree; historical proof only, never current freshness.'),
    idempotencyKey: z.string().min(1).describe('Exactly-once runtime receipt append key.'),
    buildCommand: runtimeEvidenceCommandSchema.describe('Structured build command.'),
    executionCommand: runtimeEvidenceCommandSchema.describe('Structured execution command.'),
    artifactPaths: z.array(z.string().min(1)).min(1).describe('Project-relative artifacts whose bytes and realpaths must remain stable.'),
    environmentAllowlist: z.array(z.string().min(1)).optional().describe('Environment variable names allowed into the complete child environment and redacted receipt projection.'),
    excludedEnvironmentVariables: z.array(z.string().min(1)).optional().describe('Environment names explicitly excluded from execution and raw-value storage.'),
    compilerVersion: z.string().min(1).describe('Compiler/toolchain version bound into the receipt.'),
    timeoutMs: z.number().int().min(1).max(300000).optional().describe('Per-command timeout in milliseconds (default 60000).'),
    buildInProgress: z.boolean().optional().describe('Legacy conservative hint. The handler also observes the canonical proper-lockfile build mutex and refuses even when this field is false or omitted.'),
    storageCapability: z.string().optional().describe('Declared storage adapter capability; unsupported values fail closed.'),
  }},
  { name: 'finding_runtime_evidence_verify', description: 'Verify a persisted RuntimeEvidenceReceipt against current blobs, source, artifacts, commands, environment, toolchain and trust', schema: {
    storyId: z.string().describe('Story ID.'),
    runtimeReceiptId: z.string().min(1).describe('RuntimeEvidenceReceipt ID returned by finding_runtime_evidence_run.'),
    buildCommand: runtimeEvidenceCommandSchema.describe('Expected current structured build command.'),
    executionCommand: runtimeEvidenceCommandSchema.describe('Expected current structured execution command.'),
    environmentAllowlist: z.array(z.string().min(1)).optional().describe('Expected current environment allowlist.'),
    excludedEnvironmentVariables: z.array(z.string().min(1)).optional().describe('Expected current excluded environment names.'),
    compilerVersion: z.string().min(1).describe('Expected current compiler/toolchain version.'),
    publicKey: z.string().optional().describe('Compatibility assertion only. It cannot select trust; when present it must equal the current registered runtime-evidence key.'),
    keyStatus: z.enum(['fresh', 'unknown', 'revoked', 'expired']).optional().describe('Compatibility assertion only. It cannot promote a key to fresh; trusted key status is derived by the verifier.'),
    storageCapability: z.string().optional().describe('Declared storage adapter capability; unsupported values fail closed.'),
  }},
  { name: 'finding_applicability_assess', description: 'Append a signed current applicability assessment and exact batch manifest for one verified open Finding', schema: {
    storyId: z.string().min(1), findingId: z.string().min(1), idempotencyKey: z.string().min(1),
    verdict: z.enum(['introduced', 'worsened', 'applicable', 'pre_existing_unaffected', 'out_of_scope', 'duplicate', 'disproven', 'not_reproduced_under_current_witness', 'unknown']),
    proofStrength: z.enum(['strong', 'weak', 'unknown']),
    proposalRef: routeSourceSchema, evaluationScope: z.enum(['target_story', 'canonical_owner', 'repository_release']).optional(),
    dispositionPlan: z.enum(['repair_current', 'defer_with_proof']).optional(),
    gateImpact: z.enum(['blocks', 'does_not_block', 'unknown']).optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(), recheckTriggers: z.array(z.string().min(1)).optional(),
    expiresAt: z.string().datetime().optional(),
    route: z.object({ storyId: z.string().min(1), receipt: z.object({ storyId: z.string().min(1), recordId: z.string().min(1), recordHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict().optional(),
  }},
  { name: 'finding_assessment_propose', description: 'Current reviewer signs a runtime-witness-bound immutable proposal; it has no standalone gate authority', schema: {
    storyId: z.string().min(1), findingId: z.string().min(1), idempotencyKey: z.string().min(1), proposal: z.record(z.string(), z.unknown()),
  }},
  { name: 'finding_applicability_batch', description: 'Atomically apply a digest-bound batch of signed applicability assessments, eligible deferrals and mandatory-repair classifications', schema: {
    storyId: z.string().min(1), idempotencyKey: z.string().min(1),
    items: z.array(z.object({
      findingId: z.string().min(1),
      proposalRef: routeSourceSchema, evaluationScope: z.enum(['target_story', 'canonical_owner', 'repository_release']).optional(),
      verdict: z.enum(['introduced', 'worsened', 'applicable', 'pre_existing_unaffected', 'out_of_scope', 'duplicate', 'disproven', 'not_reproduced_under_current_witness', 'unknown']),
      proofStrength: z.enum(['strong', 'weak', 'unknown']), dispositionPlan: z.enum(['repair_current', 'defer_with_proof']).optional(),
      gateImpact: z.enum(['blocks', 'does_not_block', 'unknown']).optional(), expiresAt: z.string().datetime().optional(),
      evidenceRefs: z.array(z.string().min(1)).optional(), recheckTriggers: z.array(z.string().min(1)).optional(),
      route: z.object({ storyId: z.string().min(1), receipt: z.object({ storyId: z.string().min(1), recordId: z.string().min(1), recordHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict().optional(),
    }).strict()).min(1),
  }},
  { name: 'finding_deferral_record', description: 'Append an expiry-bounded low/medium defer-with-proof disposition bound to a signed assessment and accepted owner route', schema: {
    storyId: z.string().min(1), findingId: z.string().min(1), idempotencyKey: z.string().min(1), assessmentId: z.string().min(1),
    renewalCount: z.number().int().min(0).max(1).optional(),
  }},
  { name: 'finding_mandatory_repair_close', description: 'Append signed complete-repair closure for an exact mandatory-repair classification', schema: {
    storyId: z.string().min(1), findingId: z.string().min(1), idempotencyKey: z.string().min(1), classificationId: z.string().min(1),
    closureEvidenceRefs: z.array(z.string().min(1)).min(1),
    rootCause: z.string().min(20), repairCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  }},
  { name: 'finding_triage', description: 'Read the shared Dynamic Finding blocker projection and batch manifest digest used by lifecycle gates', schema: {
    storyId: z.string().min(1), findingIds: z.array(z.string().min(1)).optional(), mode: z.enum(['observe', 'warn', 'enforce']).optional(),
  }},
  { name: 'finding_material_reattest', description: 'Re-attest only unrelated material drift with exact fresh runtime pairs and current independent reviewer proof; no scope or expiry extension', schema: {
    storyId: z.string().min(1), assessmentId: z.string().min(1), runtimeReceiptIds: z.array(z.string().min(1)).min(1), idempotencyKey: z.string().min(1),
  }},
  { name: 'finding_rollout_scorecard', description: 'Compare blocker decisions, qualification and non-authoritative Story collection actions; never enroll or enable automatically', schema: {
    storyId: z.string().min(1), findingIds: z.array(z.string().min(1)).optional(), mode: z.enum(['observe', 'warn', 'enforce']).optional(),
  }},
  { name: 'finding_qualification_record', description: 'Record an independently adjudicated, executed qualification case; never authorizes a lifecycle transition', schema: {
    storyId: z.string().min(1), findingId: z.string().min(1), assessmentId: z.string().min(1), reviewRunId: z.string().min(1), runtimeReceiptId: z.string().min(1), idempotencyKey: z.string().min(1),
  }},
  { name: 'finding_qualification_query', description: 'Read exact signed qualification rows through the public ledger query boundary', schema: { storyId: z.string().min(1) } },
  { name: 'scope_budget_check', description: 'Read semantic scope budget dimensions, unknown mappings and required decomposition before DEV. No approval or state mutation.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1).optional(), json: z.boolean().optional(),
  }},
  { name: 'scope_budget_approve', description: 'Record an interactive operator acknowledgement bound to exact known over-budget scope. Does not replace independent review.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1).optional(), bindingDigest: z.string().min(1),
    ack: z.boolean(), confirmationToken: z.string().min(1), reason: z.string().min(20),
  }},
  { name: 'acceptance_amendment_propose', description: 'Propose additive DEV acceptance with frozen original scope, intents and topology; no acceptance is changed until independent approval.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1),
    delta: z.object({ addItems: z.array(z.unknown()), appendIntents: z.array(z.unknown()),
      scopeDelta: z.object({ modify: z.array(z.string()), create: z.array(z.string()), test: z.array(z.string()) }).strict(), topologyDelta: z.array(z.unknown()),
    }).strict().describe('Exact additive delta; the domain validator refuses unknown fields, weakening, unbound scope and incomplete topology.'),
  }},
  { name: 'acceptance_amendment_review', description: 'Launch or recover one independent DEV intent-reviewer attempt with its worker key pinned before launch.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1), host: z.enum(['codex', 'claude']),
  }},
  { name: 'acceptance_amendment_approve', description: 'Consume the independently signed approve verdict and atomically journal additive acceptance application; retries recover interrupted writes.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1),
  }},
  { name: 'acceptance_amendment_cancel', description: 'Cancel an unapplied amendment with a reason, retaining its proposal and review history.', schema: {
    storyId: z.string().min(1), amendmentId: z.string().min(1), reason: z.string().min(5),
  }},
  { name: 'acceptance_amendment_show', description: 'Read and verify the signed acceptance amendment journal.', schema: { storyId: z.string().min(1) }},
  { name: 'review_remediation_close', description: 'Atomically close an inventory-bound repair set using current executed verification evidence; repeat the exact request to recover or replay.', schema: {
    storyId: z.string().min(1), repairSetId: z.string().min(1), epochId: z.string().min(1), repairCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    findings: z.array(z.object({ findingId: z.string().min(1), resolution: z.string().min(1),
      verification: z.array(z.object({ itemId: z.string().min(1), intentRef: z.string().min(1), evidenceDigest: z.string().min(1) })).min(1),
    })).min(1),
  }},
  { name: 'finding_resolve', description: 'Mark finding as resolved', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID, for example B-xxx:F-001.'),
    resolution: z.string().optional().describe('Optional: record specific fix or verification evidence explanation.'),
    // B-4f46 CHK-002 (Experience Layer Phase 1b): audit-only outcome enums. Additive/optional; never read by any gate, excluded from the finding signature.
    resolutionType: z.enum(['fixed', 'duplicate', 'superseded', 'accepted_risk', 'partially_mitigated']).optional()
      .describe('Audit-only: how this finding was resolved. Never read by any gate.'),
    resolveEvidenceStrength: z.enum(['strong', 'medium', 'weak']).optional()
      .describe('Audit-only: confidence strength of the resolve evidence. Never read by any gate.'),
  }},
  { name: 'finding_dismiss', description: 'Confirm a finding will not be fixed (reason required)', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID, for example B-xxx:F-001.'),
    reason: z.string().describe('Reason for not fixing (at least 10 characters).'),
    // B-4f46 CHK-002 (Experience Layer Phase 1b): audit-only outcome enums. Additive/optional (dismissReasonType is NEVER required); never read by any gate, excluded from the finding signature.
    dismissReasonType: z.enum(['false_positive', 'out_of_scope', 'duplicate', 'wontfix', 'unclear', 'already_covered']).optional()
      .describe('Audit-only (OPTIONAL): why this finding was dismissed. Never read by any gate.'),
    dismissEvidenceStrength: z.enum(['strong', 'medium', 'weak']).optional()
      .describe('Audit-only: confidence strength of the dismiss evidence. Never read by any gate.'),
  }},

  // B-4f46 CHK-003: signature-registry (Experience Layer Phase 1b). AUDIT-ONLY catalog
  // of finding signatureTags under .proof-or-stop/learning/. No gate reads it.
  { name: 'signature_registry_list', description: 'List signature-registry tags + statuses (audit-only)', schema: {
    storyId: z.string().optional().describe('Optional story ID (audit context only; the registry is not story-scoped).'),
  }},
  { name: 'signature_registry_set', description: 'Mutate the signature-registry (propose/approve/alias/deprecate; audit-only)', schema: {
    tag: z.string().describe('Signature tag.'),
    action: z.enum(['propose', 'approve', 'alias', 'deprecate']).describe('propose -> proposed; approve -> active (active requires explicit approve); alias adds a synonym; deprecate (optionally mergedInto).'),
    alias: z.string().optional().describe('Required when action=alias: the synonym to fold into the canonical tag.'),
    mergedInto: z.string().optional().describe('Optional when action=deprecate: canonical tag this deprecated tag folds into.'),
    by: z.string().optional().describe('Caller identity (audit trace; defaults from PROOF_OR_STOP_AGENT).'),
    storyId: z.string().optional().describe('Optional story ID (audit context only; the registry is not story-scoped).'),
  }},

  // B-17a9 (Experience Layer): signature_backfill — WRITING command. Fills empty finding
  // signatureTags from a committed map (source='backfill'); dry-run default (--apply to write).
  // Audit-only fields attached AFTER _hash; never recomputes _hash; NOT in READ_ONLY_COMMANDS.
  { name: 'signature_backfill', description: 'Backfill empty finding signatureTags from a committed { findingId -> signature } map (source=backfill); dry-run by default, --apply to write; audit-only, never changes any finding _hash or gate', schema: {
    map: z.string().optional().describe('Path to the committed signature map JSON ({ findingId -> "area|failureMode" }). Required; no implicit default.'),
    apply: z.boolean().optional().describe('Persist the fills via store.writeFindings. Default false (dry-run reports what would change and writes nothing).'),
    overwriteAuto: z.boolean().optional().describe('Also replace existing auto-sourced tags with the mapped signature. Never overwrites confirmed tags. Default false.'),
    json: z.boolean().optional().describe('Emit the structured tally (scanned/filled/actions/by-source) as JSON.'),
  }},

  // B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle. Distil a
  // resolved finding into a human-approved candidate playbook. NEVER files findings
  // or touches gates; writes only under .proof-or-stop/learning/. Approve fails closed on
  // a stale --expectedProposalDigest (decision-doc pattern); status is candidate,
  // NOT active. Activate is the explicit active-runtime boundary and fails closed
  // on --expectedPlaybookDigest.
  { name: 'playbook_propose', description: 'Stage a Playbook proposal distilled from a resolved finding (audit-only; never files a finding)', schema: {
    finding: z.string().describe('Source finding id (e.g. B-xxx:F-001) to distil into a playbook proposal.'),
    storyId: z.string().optional().describe('Optional story id; defaults to the prefix parsed from the finding id.'),
    overrideNonDeducible: z.boolean().optional().describe('Explicitly override a marked non_deducible source. Requires nonDeducibleOverrideReason and records audit metadata.'),
    nonDeducibleOverrideReason: z.string().optional().describe('Required with overrideNonDeducible=true; a useful reason whose digest is recorded for audit.'),
  }},
  { name: 'playbook_diff', description: 'Read-only render of the candidate Playbook that approve would write (no mutation)', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to render.'),
  }},
  { name: 'playbook_approve', description: 'Approve a staged proposal into a candidate Playbook (fails closed on a stale digest; never active)', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to approve.'),
    expectedProposalDigest: z.string().describe('Must byte-match the stored proposalDigest; a stale/missing digest fails closed.'),
  }},
  { name: 'playbook_activate', description: 'Explicitly activate a candidate Playbook for advisory runtime matching (fails closed on a stale digest)', schema: {
    playbookId: z.string().describe('Approved playbook id (PBP-NNN/PB-NNN) to activate.'),
    expectedPlaybookDigest: z.string().describe('Must byte-match computePlaybookDigest for the stored candidate; a stale/missing digest fails closed.'),
  }},
  { name: 'playbook_outcome_record', description: 'Append an explicit audit-only Playbook outcome observation (non-authoritative; never gate evidence)', schema: {
    storyId: z.string().describe('Story where the observation was made. Story/DONE completion alone is not interpreted as helped.'),
    playbookId: z.string().describe('Candidate or active playbook id being observed. The command snapshots current status but does not change it.'),
    exposureMode: z.enum(['candidate-inspection', 'active-advisory', 'none']).describe('Concrete exposure mode; helped requires a value other than none.'),
    consumer: z.string().describe('Host-neutral consumer surface, for example session_brief, reviewer, delivery, done_closure, or another source token.'),
    context: z.object({
      storyPhase: z.string().optional(),
      storyType: z.string().optional(),
      fileKinds: z.array(z.string()).describe('Coarse file-kind buckets involved in the observation.'),
      triggerClasses: z.array(z.string()).describe('Trigger/pattern classes involved in the observation.'),
      host: z.string().optional().describe('Optional host label; accepts future host strings.'),
      hostProvider: z.string().optional().describe('Optional provider label; host-neutral and not a namespace.'),
      hostCapabilityId: z.string().optional().describe('Optional host capability id.'),
    }).strict().describe('Structured observation context.'),
    outcome: z.object({
      verdict: z.enum(['helped', 'neutral', 'dismissed', 'harmful', 'unknown']).describe('Outcome verdict. Neutral/unknown are observability only, not positive helped samples.'),
      verdictSource: z.string().describe('Structured source token, for example operator, reviewer, delivery-reviewer, done-settlement, or health-scan.'),
      causedNoise: z.boolean().describe('Whether the playbook caused noise.'),
      causedWrongClaim: z.boolean().describe('Whether the playbook caused a wrong claim.'),
      preventedRepeatFinding: z.boolean().describe('Whether the playbook prevented a repeat finding.'),
      note: z.string().optional().describe('Optional audit note; no prompt text or secrets.'),
    }).strict().describe('Structured verdict source and outcome flags.'),
    bindings: z.object({
      headHash: z.string().optional(),
      storyFilesHash: z.string().optional(),
      materialHash: z.string().optional(),
      summaryDigest: z.string().optional(),
      deliveryCheckDigest: z.string().optional(),
    }).strict().optional().describe('Optional hash/digest bindings for audit correlation only.'),
    observedAt: z.string().optional().describe('ISO timestamp; defaults to now.'),
    idempotencyKey: z.string().optional().describe('Caller-provided idempotency/audit key; defaults from playbook/story/time/verdict.'),
    eventId: z.string().optional().describe('Caller-provided event id; defaults to PBO-<uuid>.'),
    authority: z.literal('non_authoritative').optional().describe('Only non_authoritative is accepted; omitted values are recorded as non_authoritative.'),
    gateEvidence: z.literal(false).optional().describe('Only false is accepted; this command can never create gate evidence.'),
  }},
  { name: 'playbook_promotion_sweep', description: 'Evaluate candidate/active playbooks and optionally append idempotent non-authoritative promotion recommendation rows', schema: {
    dryRun: z.boolean().optional().describe('Preview decisions without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Append idempotent decision rows. Requires PLAYBOOK_PROMOTION_SWEEP_ENABLED=true/1/yes. Never activates candidates.'),
    playbookId: z.string().optional().describe('Optional playbook id to evaluate.'),
    since: z.string().optional().describe('Optional ISO timestamp; only outcomes observed at/after this time are counted.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_promotion_observe', description: 'Read-only promotion observation for candidates, explicit candidate consumption, and recommendation handling', schema: {
    since: z.string().optional().describe('Optional ISO timestamp or relative duration like 14d; only outcome and recommendation rows at/after this time are counted.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'playbook_promotion_status', description: 'Read-only promotion posture: pending learning candidates, latest decisions, non_promotable sources (legacy storage: non_deducible), health, flags', schema: {
    playbookId: z.string().optional().describe('Optional playbook id filter.'),
    limit: z.coerce.number().int().optional().describe('Maximum latest decisions/health rows to render (default 10, max 50).'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_seed_observe', description: 'Read-only deduped historical playbook seed view with observeDigest (non-authoritative)', schema: {
    source: z.enum(['dev-memory', 'finding-signals', 'done-experience', 'raw-findings', 'all']).optional().describe('Optional seed source filter. Default all.'),
    json: z.boolean().optional().describe('Emit structured JSON including observeDigest.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'playbook_seed_propose_batch', description: 'Dry-run default batch proposal staging from deduped seeds; --apply requires observeDigest and never creates candidates/active', schema: {
    source: z.enum(['dev-memory', 'finding-signals', 'done-experience', 'raw-findings', 'all']).optional().describe('Optional seed source filter. Default all.'),
    dryRun: z.boolean().optional().describe('Preview staged proposals without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Write proposal files only. Requires observeDigest; fails closed on observe drift.'),
    limit: z.coerce.number().int().optional().describe('Maximum seeds to stage (default 20, max 100).'),
    observeDigest: z.string().optional().describe('Digest from playbook_seed_observe required for --apply.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_seed_backfill', description: 'Dry-run default historical seed backfill into inert candidate playbooks; --apply requires current observeDigest', schema: {
    source: z.enum(['dev-memory', 'finding-signals', 'done-experience', 'raw-findings', 'all']).optional().describe('Optional seed source filter. Default all.'),
    dryRun: z.boolean().optional().describe('Preview candidate backfill without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Write inert candidate playbooks only. Requires current observeDigest; never activates or records outcomes.'),
    limit: z.coerce.number().int().optional().describe('Optional maximum seeds to backfill. Omitted means all proposable seeds; not capped at the legacy batch limits.'),
    observeDigest: z.string().optional().describe('Current digest from playbook_seed_observe required for --apply.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_candidate_batch_approve', description: 'Dry-run default manifest for seed proposals; --apply requires manifestDigest and writes candidates only', schema: {
    dryRun: z.boolean().optional().describe('Preview candidate approval manifest without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Convert seed proposals to candidate playbooks only. Requires manifestDigest; never activates.'),
    limit: z.coerce.number().int().optional().describe('Maximum seed proposals to approve (default 50, max 100).'),
    manifestDigest: z.string().optional().describe('Digest from dry-run manifest required for --apply.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_candidate_ingest', description: 'Dry-run default DONE-experience seed ingestion into inert candidate playbooks; --apply composes digest-bound observe/propose/approve', schema: {
    source: z.enum(['dev-memory', 'finding-signals', 'done-experience', 'raw-findings', 'all']).optional().describe('Optional seed source filter. Default done-experience.'),
    storyId: z.string().optional().describe('Optional source story filter, useful for ingesting one DONE story.'),
    dryRun: z.boolean().optional().describe('Preview observe -> propose -> candidate manifest without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Write only scoped proposals and inert candidate playbooks; never activates playbooks or records outcomes.'),
    limit: z.coerce.number().int().optional().describe('Maximum DONE/source seeds to ingest (default 5, max 25).'),
    json: z.boolean().optional().describe('Emit structured JSON with observe/proposal/candidate digests.'),
  }},
  { name: 'playbook_runtime_consumption_verify', description: 'Read-only diagnostic proving active playbooks are consumed and candidates remain inert', schema: {
    json: z.boolean().optional().describe('Emit structured JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'playbook_trial_run', description: 'Dry-run default bounded candidate trial recording: unknown candidate exposure outcomes plus matched controls', schema: {
    storyId: z.string().describe('Story where the candidate trial observation is made.'),
    playbookId: z.string().optional().describe('Optional candidate playbook id. When omitted, bounded candidate playbooks are selected.'),
    consumer: z.string().optional().describe('Host-neutral consumer token. Default playbook_trial.'),
    dryRun: z.boolean().optional().describe('Preview trial rows without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Append idempotent unknown candidate-trial outcome rows and matched-control rows. Never records helped.'),
    limit: z.coerce.number().int().optional().describe('Maximum candidate playbooks to trial (default 10, max 1000).'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_auto_promotion_apply', description: 'Evidence-activated advisory promotion; dry-run explains eligibility and --apply activates only qualifying candidates', schema: {
    dryRun: z.boolean().optional().describe('Explain evidence activation eligibility without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Activate only evidence-qualified advisory candidates; writes active status plus append-only activation audit rows.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_promotion_timer', description: 'Explicit bounded one-shot playbook automation; optional backfill/trial/sweep/activate steps, no daemon', schema: {
    dryRun: z.boolean().optional().describe('Preview requested bounded steps without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Run requested bounded steps once. Activation still uses playbook_auto_promotion_apply guards.'),
    backfill: z.boolean().optional().describe('Run bounded seed backfill step.'),
    trial: z.boolean().optional().describe('Run bounded candidate trial step. Requires storyId.'),
    sweep: z.boolean().optional().describe('Run bounded promotion sweep step. Apply requires PLAYBOOK_PROMOTION_SWEEP_ENABLED=true/1/yes.'),
    activate: z.boolean().optional().describe('Run evidence-activation guard step; unqualified candidates remain blocked.'),
    backfillLimit: z.coerce.number().int().optional().describe('Maximum seeds for timer backfill step (default 25, max 1000).'),
    trialLimit: z.coerce.number().int().optional().describe('Maximum candidates for timer trial step (default 10, max 1000).'),
    sweepLimit: z.coerce.number().int().optional().describe('Maximum playbooks for timer sweep step (default 25, max 1000).'),
    source: z.enum(['dev-memory', 'finding-signals', 'done-experience', 'raw-findings', 'all']).optional().describe('Seed source for timer backfill. Default all.'),
    storyId: z.string().optional().describe('Story id used by the trial step.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_reject', description: 'Discard a staged Playbook proposal', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to discard.'),
  }},

  // B-01df M1: read-only, host-neutral learning source lineage audit. This is
  // an audit surface only: no seed proposal, candidate approval, automatic
  // promotion, settlement default-on, or runtime blocking.
  { name: 'source_lineage_audit', description: 'Read-only source lineage audit for learning artifacts; groups duplicate canonical source keys and reports missing lineage diagnostics', schema: {
    domain: z.string().describe('Audit domain. M1 supports exactly learning. Unsupported domains fail clearly.'),
    json: z.boolean().optional().describe('Emit the structured source lineage audit report as JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},

  // B-7561 (Experience Layer Phase 3, FINAL slice): Story Recall. Rank stories by
  // structured-field similarity over the EXISTING story_list scan — multi-field
  // Jaccard (keywords/fileKinds/touchpoints) + small type/phase boosts. READ-ONLY:
  // writes nothing, creates no derived index / cache, and never touches a gate.
  // NO FTS, NO embedding. `--story <id>` ranks similar stories; `--query "<text>"`
  // ranks against an ad-hoc keyword profile. Default top = 5.
  { name: 'recall', description: 'Rank stories by structured-field similarity over the story_list scan (read-only; no FTS/index)', schema: {
    storyId: z.string().optional().describe('Target story id; recall ranks the stories most similar to it (excludes itself).'),
    story: z.string().optional().describe('Alias of --storyId (documented short form): target story id whose similar stories to rank.'),
    query: z.string().optional().describe('Ad-hoc free-text query; recall ranks stories matching its keywords. Pass either --story OR --query, not both.'),
    top: z.coerce.number().int().optional().describe('Max number of ranked matches to return (default 5; <=0 returns none).'),
  }},
  // B-4eb6 (Experience Layer ③.1): learning_scan derives + PERSISTS the advisory
  // finding-signals cache (.proof-or-stop/learning/finding-signals.json) the Phase 1.5
  // hint loader reads. It WRITES the cache (not read-only — NOT in READ_ONLY_COMMANDS)
  // but reads findings via the store read ports only and touches no gate.
  { name: 'learning_scan', description: 'Derive and persist the advisory finding-signals cache (.proof-or-stop/learning/finding-signals.json) that powers review experience hints; writes the cache, reads findings via store ports, touches no gate', schema: {
    json: z.boolean().optional().describe('Emit a machine-readable summary { written, path, signals, schemaVersion, updatedAt } as JSON.'),
    story: z.string().optional().describe('Restrict derivation to a single story id.'),
  }},
  { name: 'learning_validate', description: 'Report Experience Layer referential validity: valid-rate / drift-rate of finding-signals vs HEAD (read-only; advisory; writes nothing)', schema: {
    json: z.boolean().optional().describe('Emit the machine-readable ValidRateReport as JSON.'),
    story: z.string().optional().describe('Restrict derivation to a single story id.'),
  }},
  // B-c06a (Experience Layer ③.4): learning_effectiveness reports FAST per-story hint
  // predictive value (retrodictive recall + windowed trend) and a LONG-GAME
  // ON/OFF arm comparison (from experience_hint_surfaced hintMode events) with an honest
  // per-arm N + conservative significance gate. READ-ONLY like learning_validate: reads
  // stories/findings/activity-log via the read ports only; writes nothing, no gate.
  { name: 'learning_effectiveness', description: 'Report Experience Layer learning effectiveness: per-story hint predictive value (recall + windowed trend) and ON/OFF arm comparison with honest N (read-only; advisory; writes nothing)', schema: {
    json: z.boolean().optional().describe('Emit the structured report { predictiveValue, armComparison } as JSON.'),
    confirmedOnly: z.boolean().optional().describe('Count only findings whose signatureTagSource === confirmed.'),
  }},

  // Finding Cluster (B-e8c8 / B-9d95 CHK-005: automatic clustering plus manual merge/split).
  //
  // No arguments (default mode): auto-cluster when files intersection is at least 50% and severity matches; write back clusters.json plus findings.clusterId.
  // merge: force the given finding ID list into a new cluster.
  // split: delete the cluster and return members to singleton findings.
  // Phase: aligned with finding_list, available in REVIEW/TEST (see config.ts DEFAULT_PHASE_TOOLS).
  { name: 'finding_cluster', description: 'B-9d95: Cluster findings (auto/merge/split) and output cluster summary', schema: {
    storyId: z.string().describe('Story ID'),
    merge: z.union([z.array(z.string()), z.string()]).optional().describe('Force into a new cluster: finding ID array or comma-separated string (F-001,F-002).'),
    split: z.string().optional().describe('Target cluster ID to split (CL-xxx); member findings return to singleton.'),
  }},

  // Init Check (B-e71f CHK-003: init reviewers write signed init-check.json)
  // INIT to INIT_CHECK hard-gate artifact. EXP-001 disproved mechanical caller verifiability, so agentId/agent remains self-reported;
  // Gate validates whether required reviewer names were recorded; prompt must pass exact names.
  // Zod layer in three-layer validation (CLAUDE.md Handler coding convention): severity enum plus desc.min(1).
  { name: 'init_check_set', description: 'Save init check results (called by INIT reviewer)', schema: {
    storyId: z.string().describe('Story ID'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Reviewer self-assigned ID, for example I-1; optional.'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity.'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character').describe('Issue details (reviewer subjective judgment must be specific).'),
    })).describe('List of issues raised by Reviewer; critical/high block INIT_CHECK; empty array allowed.'),
    agent: z.string().optional().describe('Reviewer self-reported agent name; proof-or-stop-product-reviewer must pass proof-or-stop-product-reviewer.'),
    agentId: z.string().optional().describe('Reviewer self-reported agent ID; proof-or-stop-product-reviewer must pass proof-or-stop-product-reviewer and must not pass proof-or-stop-review-story-init.'),
  }},

  // Init Check fallback/repair (B-95d8 CHK-001: explicit, auditable INIT_CHECK exit
  // for environments that cannot spawn the init reviewer subagent).
  // Default-disabled: refuses without BOTH acknowledge=true AND fallbackReason (>=30).
  // Reuses signInitCheck — does NOT weaken the gate or add agentId identity checks.
  { name: 'init_check_repair', description: 'Create an audited INIT reviewer fallback attestation', schema: {
    storyId: z.string().describe('Story ID'),
    fallbackReason: z.string().min(30, 'fallbackReason must be at least 30 characters').describe('Why INIT reviewer cannot run plus what you manually checked (durable audit attestation).'),
    acknowledge: z.boolean().describe('Must explicitly pass true: confirms you are intentionally substituting for independent INIT reviewer attestation.'),
    mode: z.enum(['repair', 'fallback']).optional().describe("audit classification: repair (fix missing exit) / fallback (substitute when no subagent environment exists), default repair."),
    evidenceRefs: z.array(z.string()).optional().describe('Optional: evidence references for the manual check (file/URL/transcript summary).'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Self-assigned ID, optional.'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity.'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character.').describe('Issue details.'),
    })).optional().describe('Optional issues raised by manual attestation; high/critical still block INIT_CHECK.'),
    actor: z.string().optional().describe('Optional actor identifier; defaults to git user.name.'),
  }},

  // Delivery Check (B-35ed: proof-or-stop-review-delivery reviewer writes signed delivery-check.json)
  // TEST to DONE hard-gate artifact. Signature domain: storyId + docsPromises + realMachineTests + closingSelfCheck + reviewRound.
  { name: 'delivery_check_set', description: 'Save delivery check results (called by proof-or-stop-review-delivery reviewer)', schema: {
    storyId: z.string().describe('Story ID'),
    docsPromises: z.array(deliveryPromiseSchema).describe('Documentation promise list.'),
    realMachineTests: z.array(z.object({
      featureId: z.string().describe('Feature ID, for example CHK-xxx.'),
      transcript: z.string().describe('Real-machine test transcript or summary.'),
      waiverReason: z.string().optional().describe('Waiver reason (at least 30 characters when non-empty; included in signature).'),
    })).describe('Real-machine test record.'),
    closingSelfCheck: z.object({
      hasRealMachineTest: z.boolean().describe('Whether real-machine tests exist.'),
      hasEdgeCaseCoverage: z.boolean().describe('Whether edge cases are covered.'),
      hasUnresolvedTodos: z.boolean().describe('Whether unresolved TODOs exist.'),
      summary: z.string().min(10, 'summary must be at least 10 characters').describe('Closing self-check summary.'),
    }).describe('Closing self-check.'),
    agentId: z.string().optional().describe('Reviewer self-reported agent ID, only for audit tracing.'),
  }},

  // Delivery Waiver (B-35ed CHK-005: waiver audit; main agent adds waiver reason for unverified docsPromise).
  { name: 'delivery_waiver_add', description: 'Add a waiver reason to a docsPromise entry in delivery-check.json (re-sign)', schema: {
    storyId: z.string().describe('Story ID'),
    promiseId: z.string().describe('docPath to waive (matches docsPromises[].docPath).'),
    waiverReason: z.string().min(30, 'waiverReason must be at least 30 characters').describe('Waiver reason (at least 30 characters).'),
  }},

  // Scope Check (B-d4d1: scope agent writes signed scope-check.json)
  { name: 'scope_check_save', description: 'Save reviewer-written PLAN scope evidence (scope-check.json) consumed by story_review; intended for proof-or-stop-review-scope-plan/scope-plan reviewers.', schema: {
    storyId: z.string().describe('Story ID'),
    features: z.array(z.object({
      feature: z.string(),
      covered_by: z.string().nullable(),
      // B-ed3e CHK-002: five-level status.
      status: z.enum(['covered', 'excluded', 'gap', 'orphan-suspect', 'drift']),
      excluded_by: z.string().nullable(),
      // B-ed3e CHK-002: source marks origin (description / decisions:<path> / relatedDocs:<path>).
      source: z.string().optional(),
    })).describe('Feature coverage analysis result.'),
    summary: z.object({
      total: z.number(),
      covered: z.number(),
      excluded: z.number(),
      gaps: z.number(),
      // B-ed3e CHK-002: new field optional, default 0; drift is always 0 in PLAN.
      orphanSuspect: z.number().optional(),
      drift: z.number().optional(),
    }).describe('Summary.'),
    readManifest: reviewerReadManifestSchema.describe('Required signed scope reviewer read coverage.'),
    ownerDispositions: z.array(z.object({path:z.string(),disposition:z.enum(['modify','test','unchanged']),reason:z.string().min(40)}).strict()).optional().describe('Required for canonical process-fact topology: exactly one substantive disposition for every mapped owner; unchanged is reviewed, not a scope expansion.'),
    // B-ed3e CHK-003: sixth channel Open Questions (optional). Reviewer writes only receive type validation,
    // business completeness is not validated; main agent later resolves it in writing with scope_question_resolve.
    openQuestions: z.array(z.object({
      id: z.string(),
      q: z.string(),
      evidence: z.string(),
      sourcePointers: z.array(z.string()),
    })).optional().describe('Open Questions: contradictions/questions reviewers notice in decisions/ but do not classify; main agent must resolve them with scope_question_resolve.'),
  }},

  // Signed compatibility diagnosis; only declare_unreachable changes acceptance
  // through the existing scope-shrinkage path. It cannot release an epoch stall.
  { name: 'stall_resolution_set', description: 'Record a signed compatibility diagnosis or checklist withdrawal; does not clear the completed-epoch convergence gate', schema: {
    storyId: z.string().describe('Story ID'),
    action: z.enum(STALL_RESOLUTION_ACTIONS as unknown as [string, ...string[]]).describe('Structured stall-resolution action: authorize_continuation | replan | escalate_root_cause | resolve_findings | declare_unreachable | override_budget. declare_unreachable additionally withdraws the named checklist item (B-1909 disposition) and closes the loop for it. override_budget retains compatibility diagnostic meaning; human continuation of a verified epoch stall requires story_resume.'),
    reason: z.string().min(20, 'reason must be at least 20 characters (why this compatibility diagnosis or withdrawal is justified).').describe('Why this compatibility diagnosis or withdrawal is justified (>= 20 chars after trim).'),
    itemId: z.string().optional().describe('Checklist item ID (CHK-xxx) to withdraw as unreachable; REQUIRED when action=declare_unreachable, ignored otherwise.'),
    approvedBy: z.string().optional().describe('Optional operator identifier recorded on the resolution (and on the B-1909 decision for declare_unreachable).'),
    actor: z.string().optional().describe('Optional actor identifier; used for approvedBy attribution when approvedBy is omitted.'),
  }},

  // B-ed3e CHK-003: scope_question_resolve - main agent writes resolution for an OQ raised by reviewer.
  // Design principle: resolution is not included in signed _hash because resolution is a main-agent action and must not pollute the reviewer judgment signature domain.
  { name: 'scope_question_resolve', description: 'Resolve a scope reviewer Open Question in writing (prevents self-approval)', schema: {
    storyId: z.string().describe('Story ID'),
    oqId: z.string().describe('Open Question ID, for example OQ-1.'),
    resolution: z.string().min(20, 'resolution is required and must be at least 20 characters (written resolution, prevents self-approval).').describe('Main agent written resolution conclusion (at least 20 characters; should cite original decisions/ text).'),
    sourcePointers: z.array(z.string()).optional().describe('Evidence pointers for resolution (decisions/ path or checklist item ID), default [].'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch merged into proof-or-stop dispatch, available in all phases;
  // B-a4e3 CHK-005: the deprecated story_dispatch / finding_dispatch aliases were removed — proof-or-stop dispatch is now the only entry).
  { name: 'dispatch', description: 'Dispatch a registered subagent prompt using registry-defined story-only or exactly-one target cardinality', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().optional().describe('Checklist item ID (CHK-xxx). Supply only when the registered agent type requires an item target; story-only roles must omit all identifiers.'),
    findingId: z.string().optional().describe('Finding ID (F-xxx or B-xxx:F-xxx). Supply only for a registered finding-target role; mutually exclusive with itemId/clusterId.'),
    clusterId: z.string().optional().describe('Cluster ID (CL-xxx). Supply only for a registered cluster-target role; mutually exclusive with itemId/findingId.'),
    agentType: z.enum(AGENT_DISPATCH_ACCEPTED_TYPES as [string, ...string[]]).optional().describe('Registered subagent type or compatibility alias. Omit only for the deliberate proof-or-stop-implementer default; runtime enforces phase and target cardinality from the same registry.'),
    reviewPurpose: z.enum(['topology', 'inventory-completeness']).optional().describe('Critic only. Explicit inventory purpose does not establish topology implementation provenance. No fallback from a topology refusal.'),
    inventoryEpochId: z.string().min(1).optional().describe('Exact current signed OPEN inventory epoch; wave and cutoff are derived by the handler.'),
  }},

  // Background CLI trio (B-45ed CHK-007: background.md set/append/get).
  { name: 'background_set', description: 'Write the full background.md (four-section check, reuses CHK-006 validator)', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('Complete background.md content (four-section format).'),
  }},
  { name: 'background_append', description: 'Append content to the end of a background.md section without affecting others', schema: {
    storyId: z.string().describe('Story ID'),
    section: backgroundSectionSchema.describe('Target section ID: trigger_event / key_insight / tradeoff / conversation_texture; legacy Chinese section names are normalized.'),
    content: z.string().describe('Content to append, usually one bullet line or several lines.'),
  }},
  { name: 'background_get', description: 'Read the full background.md', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'plan_set', description: 'Write the full plan.md (each checklist item requires a ## CHK-xxx section)', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('Complete plan.md content.'),
  }},
  { name: 'plan_get', description: 'Read the full plan.md', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // Reviewer list (B-fdcf CHK-001: opt-in list query, calculated in real time from riskSignals/touchpoints).
  { name: 'reviewer_list', description: 'List the current Story\'s opt-in reviewers', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON including reviewers array.'),
    forceReviewer: z.string().optional().describe('Comma-separated built-in REVIEW reviewer lane or short name to force-add; writes story.events audit (reviewer_forced).'),
  }},

  // B-f675 CHK-002: read-only incremental review context (prior verdict + since-last-pass diff + scopeChanged).
  { name: 'review_incremental_context', description: 'Read-only: a reviewer role\'s prior verdict, bound headHash, scopeChanged, and the material files changed since its last pass', schema: {
    storyId: z.string().describe('Story ID'),
    role: z.string().describe('Reviewer short name (concept / quality / test-coverage / behavior / docs).'),
    json: z.boolean().optional().describe('Output structured JSON (role, isFirstPass, scopeChanged, priorHeadHash, priorVerdict, changedFiles).'),
  }},

  // B-a745 CHK-005: read-only Story-relevance validation planner. Explain-only:
  // it executes no validation command, writes no artifact, and is final
  // authority for nothing. There is deliberately NO --focus flag here; the
  // --focus / --tier mutual rejection belongs to `validate --tier`.
  { name: 'validation_plan', description: 'Read-only: explain which validation units a Story tier would run, why, and at what estimated cost. Executes nothing, writes nothing, and is never final authority.', schema: {
    // The custom missing-value messages exist so the SCHEMA path and the HANDLER
    // path refuse an omitted argument in the same words. Both layers are real:
    // zod is the first line of defence on the CLI path, and the handler
    // re-validates for every caller that never met a schema.
    storyId: z.string({ error: (issue) => (issue.input === undefined ? 'validation_plan: storyId is required (for example --storyId=B-a745)' : undefined) }).trim().min(1).describe('Story ID (required; never defaulted).'),
    tier: z.string({ error: (issue) => (issue.input === undefined ? 'validation_plan: tier is required (one of fast, intermediate, full)' : undefined) }).trim().min(1).describe('Requested tier: fast / intermediate / full (required; never defaulted).'),
    explain: z.boolean().optional().describe('List every unit and every unclassified input instead of a preview.'),
    json: z.boolean().optional().describe('Emit one structured JSON object carrying the same facts as the human output.'),
    persist: z.never().optional().describe('Not a flag; validation_plan persists nothing. Passing --persist is rejected by CLI validation.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},

  // Workflow profile
  { name: 'workflow_set', description: 'Set project workflow profile (light/balanced/strict)', schema: {
    profile: z.string().describe('Target profile: light / balanced / strict.'),
  }},
  { name: 'workflow_show', description: 'Show current workflow profile and effective policy', schema: {} },
  { name: 'workflow_explain', description: 'Explain a story\'s actual effective profile (project / required / effective)', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // B-be27: Scope Contract — story-scoped allowed-file contract + post-diff gate
  { name: 'scope_contract_set', description: 'Create or update a versioned repo-root-relative scope contract (configured source-root inputs are canonicalized; unsafe/ambiguous paths fail closed)', schema: {
    storyId: z.string().describe('Story ID'),
    mode: z.enum(['local', 'shadow', 'enforce']).describe('Gate behavior: local=advisory, shadow=warn, enforce=block on violations'),
    allowedModify: z.array(z.string()).optional().describe('Files/globs allowed to be modified'),
    allowedCreate: z.array(z.string()).optional().describe('Files/globs allowed to be created'),
    allowedTest: z.array(z.string()).optional().describe('Test files/globs (always allowed)'),
    protectedFiles: z.array(z.string()).optional().describe('Files that must not change (block in enforce)'),
    explicitExcludes: z.array(z.string()).optional().describe('Files explicitly out of scope'),
    scopeChangeReason: z.string().optional().describe('Human explanation for a deliberate scope change'),
    fileRules: z.array(scopeFileRuleSchema).optional().describe('Per-file semantic anchor rules'),
    protectedAnchors: z.array(z.string()).optional().describe('Globally protected anchors'),
  }},
  { name: 'scope_contract_show', description: 'Show the current scope contract for a story', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'scope_contract_check', description: 'Run versioned canonical-path and parser-backed enclosing-declaration scope gates against the git diff', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON with status, violations, warnings'),
  }},
  { name: 'scope_contract_acknowledge', description: 'Record an acknowledgement for already declared paths (requires reason ≥ 20 chars)', schema: {
    storyId: z.string().describe('Story ID'),
    paths: z.array(z.string()).describe('Out-of-scope paths being acknowledged'),
    reason: z.string().min(20, 'reason must be ≥ 20 characters').describe('Why these out-of-scope paths are necessary (≥ 20 chars)'),
    actor: z.string().optional().describe('Actor making the acknowledgement (default: main-agent)'),
    anchors: z.array(z.string()).optional().describe('Semantic anchors covered by this acknowledgement'),
    hunkDigest: z.string().optional().describe('Single hunk digest covered by this acknowledgement'),
    hunkDigests: z.array(z.string()).optional().describe('Multiple hunk digests covered by this acknowledgement'),
  }},
  { name: 'scope_diff_pack', description: 'Generate a mechanical diff context pack with hunk digests and versioned TypeScript-AST declaration anchors', schema: {
    storyId: z.string().describe('Story ID whose signed workspace supplies the Git diff'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'scope_contract_init_from_plan', description: 'Initialize a story scope contract from PLAN checklist files', schema: {
    storyId: z.string().describe('Story ID'),
    mode: z.enum(['local', 'shadow', 'enforce']).optional().describe('Gate behavior (default enforce)'),
    protectedFiles: z.array(z.string()).optional().describe('Files that must not change'),
    explicitExcludes: z.array(z.string()).optional().describe('Files explicitly out of scope'),
    scopeChangeReason: z.string().optional().describe('Reason recorded on the generated contract'),
  }},
  // ProofStory progressive intent hardening.
  { name: 'original_intent_snapshot_set', description: 'Persist the immutable Intent MVP source snapshot for a story', schema: {
    storyId: z.string().describe('Story ID'),
    sourceText: z.string().min(1).describe('Original user request text.'),
    normalizedOutcome: z.string().min(1).describe('Observable outcome expected by the user.'),
    acceptanceClaim: z.string().min(1).describe('Single claim that proves the normalized outcome.'),
    keyRequirementIds: z.array(z.string().min(1)).optional().describe('Stable requirement ids included in requestHash; defaults to REQ-001.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'original_intent_snapshot_get', description: 'Read the story original intent snapshot', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'milestone_ledger_set', description: 'Replace the story milestone ledger for multi-deliverable intent', schema: {
    storyId: z.string().describe('Story ID'),
    milestones: z.array(proofStoryMilestoneSchema).describe('Machine-countable milestone rows.'),
    state: z.enum(['candidate', 'confirmed']).optional().describe('Ledger state. Direct writes default to candidate; confirmed is preserved only when the existing confirmed ledger hash is unchanged.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'milestone_ledger_add', description: 'Append one milestone row to the story milestone ledger', schema: {
    storyId: z.string().describe('Story ID'),
    milestone: proofStoryMilestoneSchema.optional().describe('Milestone row to append.'),
    id: z.string().optional().describe('Stable milestone id when not passing milestone.'),
    sourceRequirementId: z.string().optional().describe('Source requirement id when not passing milestone.'),
    claim: z.string().optional().describe('Milestone claim when not passing milestone.'),
    doneMeans: z.string().optional().describe('Observable completion rule when not passing milestone.'),
    requiredEvidence: z.array(z.string()).optional().describe('Evidence kinds expected for this milestone.'),
    checklistRefs: z.array(z.string()).optional().describe('Checklist item ids that deliver this milestone.'),
    verificationIntentRefs: z.array(z.string()).optional().describe('Verification intent refs covering this milestone.'),
    parentLedgerId: z.string().optional().describe('Optional parent ledger row this milestone slices from.'),
    assignedStory: z.string().regex(/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe('Optional child story assigned to deliver this row.'),
    status: z.enum(['planned', 'covered', 'done', 'not_applicable']).optional().describe('Milestone coverage status.'),
    notApplicableDecision: milestoneNotApplicableDecisionSchema.optional().describe('Required auditable justification when status=not_applicable and not passing milestone.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'milestone_ledger_get', description: 'Read the story milestone ledger', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'slice_plan_set', description: 'Persist a ProofStory slice plan for an oversized milestone ledger', schema: {
    storyId: z.string().describe('Story ID'),
    slices: z.array(proofStorySliceSchema).min(1).describe('Complete slices covering every current milestone ledger row.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'slice_plan_get', description: 'Read the ProofStory slice plan', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'parent_ledger_rollup_set', description: 'Persist parent ledger roll-up coverage for slice-plan child stories', schema: {
    storyId: z.string().describe('Story ID'),
    children: z.array(proofStoryRollupChildSchema).describe('Child story coverage rows.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'parent_ledger_rollup_get', description: 'Read the ProofStory parent ledger roll-up', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'proofstory_contract_set', description: 'Persist the ProofStory contract envelope consumed by opt-in gates', schema: {
    storyId: z.string().describe('Story ID'),
    acceptanceBindings: z.array(proofStoryAcceptanceBindingSchema).optional().describe('Acceptance-to-checklist/verificationIntent bindings consumed by diagnostics and opt-in gate enforcement.'),
    note: z.string().optional().describe('Contract envelope note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'proofstory_contract_get', description: 'Read the ProofStory contract envelope', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'acceptance_matrix', description: 'Render the deterministic read-only, non-evidentiary ProofStory acceptance matrix', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output deterministic structured JSON.'),
    mode: z.never().optional().describe('Not supported: Wave 1 is observe-only.'),
    write: z.never().optional().describe('Not supported: acceptance_matrix is read-only.'),
    output: z.never().optional().describe('Not supported: acceptance_matrix writes no artifact.'),
    apply: z.never().optional().describe('Not supported: acceptance_matrix applies no change.'),
    result: z.never().optional().describe('Not supported: callers cannot submit a result.'),
    verdict: z.never().optional().describe('Not supported: callers cannot submit a verdict.'),
    evidence: z.never().optional().describe('Not supported: matrix output is not evidence.'),
    rows: z.never().optional().describe('Not supported: rows are derived from canonical inputs.'),
  }},
  { name: 'acceptance_topology_check', description: 'Evaluate the canonical PLAN structural topology under the flat project gate mode', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    json: z.boolean().optional().describe('Output deterministic structured JSON.'),
    mode: z.never().optional().describe('Forbidden: mode comes only from proofStory.acceptanceTopologyGateMode.'),
    status: z.never().optional().describe('Forbidden: status is evaluator-derived.'),
    structuralPass: z.never().optional().describe('Forbidden: structural pass is evaluator-derived.'),
    blocking: z.never().optional().describe('Forbidden: lifecycle blocking is evaluator-derived.'),
    authority: z.never().optional().describe('Forbidden: local diagnostics cannot be promoted to Authority.'),
    basis: z.never().optional().describe('Forbidden: the signed verifier artifact is loaded from canonical storage.'),
    evidence: z.never().optional().describe('Forbidden: PLAN structural evaluation consumes no executable evidence.'),
    write: z.never().optional().describe('Not supported: the command is read-only.'),
    apply: z.never().optional().describe('Not supported: the command applies no change.'),
  }},
  { name: 'topology_exclusion_approval_set', description: 'Persist one signed independent scope-plan approval for a current topology exclusion', schema: {
    storyId: z.string().min(1),
    exclusionRef: z.string().min(1),
    json: z.boolean().optional(),
    approverIdentity: z.never().optional(), approverRole: z.never().optional(), signature: z.never().optional(),
    basisDigest: z.never().optional(), topologyDigest: z.never().optional(), scopeCheckDigest: z.never().optional(), scopeContractDigest: z.never().optional(),
    storyFilesHash: z.never().optional(), closureFilesHash: z.never().optional(), issuedAt: z.never().optional(),
  }},
  { name: 'topology_critic_receipt_set', description: 'Persist a signed current receipt from the registered independent topology critic', schema: {
    storyId: z.string().min(1),
    verdict: z.enum(['pass', 'request_changes']),
    json: z.boolean().optional(),
    criticIdentity: z.never().optional(), criticRole: z.never().optional(), signature: z.never().optional(),
    basisDigest: z.never().optional(), topologyDigest: z.never().optional(), scopeCheckDigest: z.never().optional(), scopeContractDigest: z.never().optional(),
    storyFilesHash: z.never().optional(), closureFilesHash: z.never().optional(), findingRefs: z.never().optional(), approvedExclusionRefs: z.never().optional(), issuedAt: z.never().optional(),
  }},
  { name: 'topology_critic_receipt_check', description: 'Read-only verification of topology critic authority, signatures, bindings, and exclusion approvals', schema: {
    storyId: z.string().min(1),
    json: z.boolean().optional(),
    verdict: z.never().optional(), receipt: z.never().optional(), evidence: z.never().optional(), write: z.never().optional(),
  }},
  { name: 'acceptance_basis_generate', description: 'Run the registered PLAN verifier and atomically persist its signed coverage-basis receipt. ORDERING (B-45a0): run this BEFORE pre_review_check, never after. pre_review_check snapshots the plan basisDigest, and that digest covers binding/receiptRef, so regenerating the basis afterwards moves it and decays a genuine PASS to PR_COVERAGE_BASIS_CHANGED + PR_ARTIFACT_TAMPERED with no material drift. Recovery needs pre_review_check, which is DEV-only.', schema: {
    storyId: z.string().min(1),
    json: z.boolean().optional(),
    status: z.never().optional().describe('Forbidden: basis status is verifier-derived.'),
    enumeratedPathRefs: z.never().optional().describe('Forbidden: path inventory is verifier-derived.'),
    blindSpots: z.never().optional().describe('Forbidden: blind spots are verifier-derived.'),
    excludedPathRefs: z.never().optional().describe('Forbidden: exclusions are verifier-derived.'),
    generatedBy: z.never().optional().describe('Forbidden: verifier identity is registered.'),
    digest: z.never().optional().describe('Forbidden: digests are verifier-derived.'),
    receiptRef: z.never().optional(), basisDigest: z.never().optional(), issuer: z.never().optional(), signature: z.never().optional(),
    headHash: z.never().optional(), materialHash: z.never().optional(), storyFilesHash: z.never().optional(), closureFilesHash: z.never().optional(),
    workspaceIdentityDigest: z.never().optional(), scopeCheckDigest: z.never().optional(), scopeContractDigest: z.never().optional(), topologyDigest: z.never().optional(),
    adapterResults: z.never().optional(), discoveryMethods: z.never().optional(), discoveryProfileRef: z.never().optional(), discoveryProfileDigest: z.never().optional(),
    sourceInventoryRefs: z.never().optional(), plannedPathRecords: z.never().optional(), receipt: z.never().optional(), binding: z.never().optional(),
    evidence: z.never().optional(), verdict: z.never().optional(), authority: z.never().optional(),
  }},
  { name: 'acceptance_basis', description: 'Read and verify the current signed acceptance coverage basis without mutation', schema: {
    storyId: z.string().min(1),
    json: z.boolean().optional(),
    status: z.never().optional().describe('Forbidden: basis status is verifier-derived.'),
    enumeratedPathRefs: z.never().optional().describe('Forbidden: path inventory is verifier-derived.'),
    blindSpots: z.never().optional().describe('Forbidden: blind spots are verifier-derived.'),
    excludedPathRefs: z.never().optional().describe('Forbidden: exclusions are verifier-derived.'),
    generatedBy: z.never().optional().describe('Forbidden: verifier identity is registered.'),
    digest: z.never().optional().describe('Forbidden: digests are verifier-derived.'),
    signature: z.never().optional().describe('Forbidden: receipt signatures are verifier-issued.'),
    issuer: z.never().optional().describe('Forbidden: issuer identity is registered, not caller-selected.'),
    receiptRef: z.never().optional(), basisDigest: z.never().optional(),
    headHash: z.never().optional(), materialHash: z.never().optional(), storyFilesHash: z.never().optional(), closureFilesHash: z.never().optional(),
    workspaceIdentityDigest: z.never().optional(), scopeCheckDigest: z.never().optional(), scopeContractDigest: z.never().optional(), topologyDigest: z.never().optional(),
    adapterResults: z.never().optional(), discoveryMethods: z.never().optional(), discoveryProfileRef: z.never().optional(), discoveryProfileDigest: z.never().optional(),
    sourceInventoryRefs: z.never().optional(), plannedPathRecords: z.never().optional(), receipt: z.never().optional(), binding: z.never().optional(),
    evidence: z.never().optional(), verdict: z.never().optional(), authority: z.never().optional(),
  }},
  { name: 'pre_review_check', description: 'Recompute the current-worktree basis and persist the canonical signed executable pre-review result. ORDERING (B-45a0): any acceptance_basis_generate run AFTER this invalidates the artifact it just signed (PR_COVERAGE_BASIS_CHANGED + PR_ARTIFACT_TAMPERED), because the snapshotted plan basisDigest covers binding/receiptRef. Regenerate the basis first, then issue this last.', schema: {
    storyId: z.string().min(1),
    json: z.boolean().optional(),
    status: z.never().optional(), codes: z.never().optional(), ok: z.never().optional(), mode: z.never().optional(),
    artifact: z.never().optional(), basis: z.never().optional(), evidence: z.never().optional(), verdict: z.never().optional(), authority: z.never().optional(),
    signature: z.never().optional(), signerPublicKey: z.never().optional(), issuedAt: z.never().optional(), cutoffAt: z.never().optional(),
    storyFilesHash: z.never().optional(), closureFilesHash: z.never().optional(), topologyDigest: z.never().optional(),
  }},
  { name: 'pre_review_check_read', description: 'Read-only verification of the canonical signed executable pre-review result', schema: {
    storyId: z.string().min(1), json: z.boolean().optional(),
    status: z.never().optional(), codes: z.never().optional(), ok: z.never().optional(), mode: z.never().optional(),
    artifact: z.never().optional(), evidence: z.never().optional(), verdict: z.never().optional(), authority: z.never().optional(), write: z.never().optional(),
  }},
  { name: 'acceptance_rollout_report', description: 'Run the registered real-Story cohort and persist a verifier-derived signed Wave 4 rollout report', schema: {
    storyId: z.string().min(1), json: z.boolean().optional(),
    evaluationWindow: z.never().optional(), membership: z.never().optional(), eligibleMembership: z.never().optional(),
    sourceRecords: z.never().optional(), registeredSeedIds: z.never().optional(), adapterProfile: z.never().optional(),
    thresholds: z.never().optional(), metrics: z.never().optional(), aggregate: z.never().optional(), verdict: z.never().optional(),
    quorum: z.never().optional(), providers: z.never().optional(), signature: z.never().optional(), receipt: z.never().optional(),
    headHash: z.never().optional(), materialHash: z.never().optional(), storyFilesHash: z.never().optional(),
  }},
  { name: 'acceptance_rollout_report_read', description: 'Read and verify the current signed frozen-membership Wave 4 rollout report', schema: {
    storyId: z.string().min(1), json: z.boolean().optional(),
    write: z.never().optional(), apply: z.never().optional(), membership: z.never().optional(),
    metrics: z.never().optional(), verdict: z.never().optional(), receipt: z.never().optional(),
  }},
  { name: 'acceptance_rollout_check', description: 'Evaluate the flat project rollout policy with mode-invariant diagnostics; enforce alone blocks', schema: {
    storyId: z.string().min(1), json: z.boolean().optional(),
    mode: z.never().optional(), status: z.never().optional(), blocking: z.never().optional(),
    thresholds: z.never().optional(), verdict: z.never().optional(), evidence: z.never().optional(),
  }},
  { name: 'intent_collision_set', description: 'Persist a structured ProofStory intent-collision decision', schema: {
    storyId: z.string().describe('Story ID'),
    decision: proofStoryIntentCollisionDecisionSchema.describe('Collision decision. Only pass with acceptedInterpretation confirms a candidate ledger.'),
    acceptedInterpretation: z.string().min(1).optional().describe('Accepted interpretation; required when decision=pass.'),
    notes: z.string().optional().describe('Audit note for non-pass or pass decisions.'),
    id: z.string().optional().describe('Stable decision id; generated when omitted.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'intent_collision_get', description: 'Read the structured ProofStory intent collision artifact', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'scope_shrinkage_decision_set', description: 'Persist an explicit ProofStory scope-shrinkage decision (sole applier of checklist-item and acceptance-binding withdrawals)', schema: {
    storyId: z.string().describe('Story ID'),
    decision: z.enum(['confirmed', 'rejected']).describe('Whether the shrinkage is accepted.'),
    userConfirmed: z.boolean().optional().describe('Must be true when decision=confirmed; DONE equivalence ignores confirmed shrinkage without this explicit user confirmation.'),
    removedMilestoneIds: z.array(z.string().min(1)).optional().describe('Milestones explicitly removed from DONE equivalence when decision=confirmed.'),
    reason: z.string().min(1).describe('Audit reason for the shrinkage decision.'),
    approvedBy: z.string().min(1).describe('Human or agent approving the decision.'),
    decisionId: z.string().min(1).optional().describe('B-1909: stable id both withdrawal layers cite; generated when omitted.'),
    withdrawnChecklistItemRefs: z.array(z.string().min(1)).optional().describe('B-1909: checklist item ids to withdraw (flipped to status=withdrawn with decisionRef). Requires decision=confirmed + userConfirmed.'),
    withdrawnAcceptanceBindingRefs: z.array(z.string().min(1)).optional().describe('B-1909: acceptance-binding ids to withdraw (append-only disposition beside the frozen binding). Requires decision=confirmed + userConfirmed.'),
    evidenceRefs: z.array(z.string().min(1)).optional().describe('B-1909: optional audit references backing the withdrawal.'),
    fullWithdrawalReapproval: z.object({
      approvedBy: z.string().min(1).describe('Operator approving a full withdrawal that empties the effective binding set.'),
      reason: z.string().min(1).describe('Why emptying the acceptance scope is authorized.'),
      at: z.string().min(1).describe('ISO 8601 timestamp of the re-approval.'),
    }).optional().describe('B-1909: explicit re-approval required to withdraw every effective acceptance binding (empty-scope floor).'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'scope_shrinkage_decision_get', description: 'Read the ProofStory scope-shrinkage decision', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'red_evidence_create', description: 'Record ProofStory red evidence for a triggered pre-fix failure', schema: {
    storyId: z.string().describe('Story ID'),
    trigger: z.string().min(1).describe('Trigger or claim this red evidence addresses.'),
    acceptanceTargetRef: z.string().min(1).describe('Acceptance, verificationIntent, milestone, or request hash target this red proof addresses.'),
    baselineHeadHash: z.string().min(1).optional().describe('Pre-fix git HEAD; defaults to current HEAD.'),
    baselineMaterialHash: z.string().min(1).optional().describe('Pre-fix material hash; defaults to current material hash.'),
    observedFailure: z.string().min(1).describe('Observed failing behavior before the fix.'),
    failingCommand: z.string().optional().describe('Command that demonstrates the red state; gate satisfaction requires this or failureReceiptHash.'),
    failureReceiptHash: z.string().min(1).optional().describe('Comparable reproducible red receipt/transcript digest when no failing command is available.'),
    expectedGreenCommand: z.string().optional().describe('Separate command expected to pass after the fix.'),
    greenTargetRef: z.string().min(1).optional().describe('Green evidence target; defaults to acceptanceTargetRef and must match for gate satisfaction.'),
    greenRelation: proofStoryGreenRelationSchema.optional().describe('Relationship from red failure to green target.'),
    greenHeadHash: z.string().min(1).optional().describe('Optional green HEAD hash; must differ from baseline when provided.'),
    greenMaterialHash: z.string().min(1).optional().describe('Optional green material hash; must differ from baseline when provided.'),
    note: z.string().optional().describe('Audit note.'),
    id: z.string().optional().describe('Stable red evidence id; generated when omitted.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'red_evidence_get', description: 'Read ProofStory red evidence', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_start', description: 'Start a ProofStory investigation spike', schema: {
    storyId: z.string().describe('Story ID'),
    id: z.string().optional().describe('Stable spike id; generated when omitted.'),
    question: z.string().min(1).describe('Question the spike is investigating.'),
    disposableCodePaths: z.array(z.string().min(1)).optional().describe('Disposable spike-only code paths that must be discarded or explicitly promoted.'),
    note: z.string().optional().describe('Audit note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_result_set', description: 'Record the result of a ProofStory spike', schema: {
    storyId: z.string().describe('Story ID'),
    id: z.string().min(1).describe('Spike id.'),
    result: z.string().min(1).describe('Investigation result.'),
    note: z.string().optional().describe('Audit note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_result', description: 'Alias for spike_result_set', schema: {
    storyId: z.string().describe('Story ID'),
    id: z.string().min(1).describe('Spike id.'),
    result: z.string().min(1).describe('Investigation result.'),
    note: z.string().optional().describe('Audit note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_discard', description: 'Discard a ProofStory spike as audit-only investigation evidence', schema: {
    storyId: z.string().describe('Story ID'),
    id: z.string().min(1).describe('Spike id.'),
    note: z.string().optional().describe('Audit note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_promote', description: 'Mark a ProofStory spike as promoted through explicit semantics', schema: {
    storyId: z.string().describe('Story ID'),
    id: z.string().min(1).describe('Spike id.'),
    promotedAs: proofStorySpikePromotionSchema.optional().describe('Explicit promotion target. This does not create red or verification evidence automatically.'),
    note: z.string().optional().describe('Audit note.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'spike_get', description: 'Read ProofStory spike evidence', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'intent_coverage_check', description: 'ProofStory intent coverage diagnostics; writes nothing', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('Compatibility flag; this command writes nothing.'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'proofstory_gate_check', description: 'ProofStory gate diagnostics in observe, warn, or enforce mode', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('Compatibility flag; this command writes nothing.'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'done_intent_equivalence_check', description: 'Compare DONE delivery against ProofStory original intent and confirmed ledger', schema: {
    storyId: z.string().describe('Story ID'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'proofstory_review_completeness_check', description: 'Check ProofStory REVIEW completeness gaps', schema: {
    storyId: z.string().describe('Story ID'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
  }},
  { name: 'parent_roadmap_status', description: 'Read-only parent-roadmap totality status from a provided ledger or built-in sample case', schema: {
    case: parentRoadmapCaseSchema.optional().describe('Built-in sample case to evaluate; case=migration remains the explicit legacy negative diagnostic sample.'),
    storyId: z.string().optional().describe('Optional parent story id; storyId=B-43de maps to the closed B-e781 evidence-backed parent roadmap ledger when no ledger is supplied.'),
    ledger: z.any().optional().describe('ParentRoadmapLedger object to evaluate. Caller-provided rollup conclusions are ignored.'),
    proofstoryContract: proofStoryContractEnvelopeSchema.optional().describe('External ProofStory contract inventory whose acceptance milestoneIds must bind into proofstoryBinding evaluation.'),
    summaryText: z.string().optional().describe('Optional summary/handoff wording to check for full-roadmap overclaims.'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode for claim wording.'),
    currentHeadHash: z.string().optional().describe('Current HEAD hash for stale evidence checks.'),
    currentMaterialHash: z.string().optional().describe('Current material hash for stale evidence checks.'),
    currentStoryFilesHash: z.string().optional().describe('Current story-files hash for stale evidence checks.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'parent_roadmap_evaluate', description: 'Evaluate a parent-roadmap ledger and optional claim text without writing story metadata', schema: {
    case: parentRoadmapCaseSchema.optional().describe('Built-in sample case to evaluate; case=migration remains the explicit legacy negative diagnostic sample.'),
    storyId: z.string().optional().describe('Optional parent story id; storyId=B-43de maps to the closed B-e781 evidence-backed parent roadmap ledger when no ledger is supplied.'),
    ledger: z.any().optional().describe('ParentRoadmapLedger object to evaluate. Caller-provided rollup conclusions are ignored.'),
    proofstoryContract: proofStoryContractEnvelopeSchema.optional().describe('External ProofStory contract inventory whose acceptance milestoneIds must bind into proofstoryBinding evaluation.'),
    summaryText: z.string().optional().describe('Optional summary/handoff wording to check for full-roadmap overclaims.'),
    mode: proofStoryGateModeSchema.optional().describe('observe/warn/enforce diagnostic mode for claim wording.'),
    currentHeadHash: z.string().optional().describe('Current HEAD hash for stale evidence checks.'),
    currentMaterialHash: z.string().optional().describe('Current material hash for stale evidence checks.'),
    currentStoryFilesHash: z.string().optional().describe('Current story-files hash for stale evidence checks.'),
    json: z.boolean().optional().describe('Output structured JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'guard_session_start', description: 'Start (or restart) a Proof-or-Stop-managed scope-guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    provider: z.string().min(1, 'provider is required').describe('Agent provider runtime (e.g. claude-code, codex). Guard mode depends on provider and context flags.'),
    nativeHookVerified: z.boolean().optional().describe('Set true when the host-native PreToolUse hook is confirmed installed (Claude Code .claude/settings.json or Codex .codex/hooks.json), enabling native-pretool mode.'),
    viaDispatch: z.boolean().optional().describe('(Codex/Antigravity only; Gemini legacy) Set true when running via Proof-or-Stop dispatch/pre-apply flow, enabling wrapped-preapply mode. Without this, those hosts use watcher-fallback.'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'guard_session_status', description: 'Read the current guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'guard_session_check', description: 'Check current diff against the guard session scope contract and record any forbidden writes', schema: {
    storyId: z.string().describe('Story ID'),
    simulatedWrites: z.array(z.string()).optional().describe('Paths to evaluate as if written (test/dry-run forbidden-write simulation)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  // Pre-write scope enforcement — pre-tool hook guard for write-like operations.
  // Returns allow/deny/ask/shadow verdict before the write lands.
  // Fail-closed on corrupt scope contracts or ambiguous active guard sessions.
  // Backward-compatible allow when no guard session or story context exists.
  { name: 'prewrite_guard_check', description: 'Pre-write scope enforcement for Claude Code PreToolUse hooks and Proof-or-Stop dispatch pre-apply checks', schema: {
    storyId: z.string().optional().describe('Story ID (auto-discovered from active guard sessions when absent)'),
    provider: z.string().optional().describe('Agent provider (informational; used to log who triggered the check)'),
    toolName: z.string().describe('Name of the write-like tool being invoked (e.g. Edit, Write, MultiEdit, NotebookEdit)'),
    toolInputJson: z.string().optional().describe('JSON-encoded tool input from which target paths are extracted (used when targetPaths is absent)'),
    targetPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Explicit target path(s) to evaluate (overrides tool-input extraction)'),
    cwd: z.string().optional().describe('Working directory for resolving relative paths (defaults to project root)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'verification_pin_guard_check', description: 'B-1507: fail-open PreToolUse evidence-pin seatbelt for shell-tool hooks. Parses a proof-or-stop verification_evidence_add / verification_run command string and denies (exit 2 in the hook) when the caller command/selector mismatches the intent’s pin, which is immutable to evidence writes with exactly one audited narrowing exception (verification_pin_narrow); allows in every ambiguous case (the enforceAndStampEvidence handler is the real floor)', schema: {
    provider: z.string().optional().describe('Agent provider (informational; used to log who triggered the check)'),
    toolName: z.string().optional().describe('Name of the shell tool being invoked (e.g. Bash on Claude, the Codex shell tool)'),
    toolInputJson: z.string().optional().describe('JSON-encoded shell tool input; the command string is read from its .command field when commandString is absent'),
    commandString: z.string().optional().describe('Explicit shell command string to inspect (overrides toolInputJson extraction)'),
    cwd: z.string().optional().describe('Working directory (informational; the guard resolves the pin from story metadata)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'autopilot_execute', description: 'Execute a bounded unattended Proof-or-Stop autopilot loop using local Proof-or-Stop commands and local assurance only. Alias: proof-or-stop autopilot execute', schema: {
    mode: z.enum(['local']).optional().describe('Autopilot mode: local'),
    storyId: z.string().optional().describe('Story ID to bind the autopilot executor to'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase to execute toward'),
    once: z.boolean().optional().describe('Execute a single loop iteration'),
    dryRun: z.boolean().optional().describe('Preview the executor loop without running commands'),
    maxSteps: z.number().optional().describe('Maximum planned steps to execute (default 20)'),
    requireMultiHost: z.boolean().optional().describe('Require independent host verdict certification before final DONE execution'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts when multi-host review is required'),
    maxReviewWaves: z.number().optional().describe('Maximum bounded multi-host review waves'),
    allowClaudeRepair: z.boolean().optional().describe('Allow a bounded Claude Code CLI repair attempt when an execution step fails'),
    claudeCommand: z.string().optional().describe('Claude Code CLI executable for repair attempts (default claude)'),
    claudePermissionMode: z.string().optional().describe('Optional Claude Code CLI --permission-mode value for repair attempts'),
    maxRepairAttempts: z.number().optional().describe('Maximum Claude repair attempts per failed step when allowClaudeRepair=true'),
    commandTimeoutMS: z.number().optional().describe('Timeout for each Proof-or-Stop executor command in milliseconds'),
    claudeTimeoutMS: z.number().optional().describe('Timeout for each Claude repair command in milliseconds'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_doctor', description: 'Diagnose local autopilot readiness. Alias: proof-or-stop autopilot doctor', schema: {
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_draft', description: 'Create a structured Proof-or-Stop planner draft from a natural-language request. Alias: proof-or-stop planner draft', schema: {
    request: z.string().optional().describe('One sentence or paragraph request'),
    requestFile: z.string().optional().describe('Request document path'),
    interactionMode: z.enum(['autonomous', 'interview', 'decision-gated']).optional().describe('Planner interaction mode (default autonomous)'),
    mode: z.enum(['local']).optional().describe('Execution mode for the generated plan'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase'),
    workflow: z.enum(['standard', 'source-aligned-redevelopment', 'source_aligned_redevelopment']).optional().describe('Development workflow'),
    sourceRepo: z.string().optional().describe('Source repo path for source-aligned redevelopment'),
    targetProject: z.string().optional().describe('Target project path for source-aligned redevelopment'),
    targetProjectName: z.string().optional().describe('Target project name for source-aligned redevelopment'),
    sourceLanguage: z.string().optional().describe('Canonical source language id'),
    targetLanguage: z.string().optional().describe('Canonical target language id'),
    renameMap: z.union([z.record(z.string(), z.string()), z.string()]).optional().describe('Rename map object or JSON string'),
    includedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Included source paths (array or comma-separated string)'),
    excludedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Excluded source paths (array or comma-separated string)'),
    languageAdapterPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Language adapter policy object or JSON string'),
    semanticMappingPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Semantic mapping policy object or JSON string'),
    parityOraclePolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Parity oracle policy object or JSON string'),
    alignmentVerificationIntent: z.union([z.array(z.string()), z.string()]).optional().describe('Alignment verification intents'),
    providerPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Explicit provider policy object or JSON string; real providers require explicit opt-in'),
    milestones: z.array(proofStoryMilestoneSchema).optional().describe('Optional explicit machine-countable milestone rows to carry in the planner draft; planner_create_story passes them through story_create.'),
    allowUnattendedPlanning: z.boolean().optional().describe('Allow unattended local Story planning'),
    forceNewRun: z.boolean().optional().describe('Request a distinct planner idempotency scope'),
    forceNewRunReason: z.string().optional().describe('Reason for forceNewRun'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_review', description: 'Review a planner draft for placeholders, ambiguity, policy, and verification gaps. Alias: proof-or-stop planner review', schema: {
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_create_story', description: 'Create a Proof-or-Stop Story from a reviewed planner draft. Alias: proof-or-stop planner create-story', schema: {
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    forceNew: z.boolean().optional().describe('Force a new Story through the planner-controlled path'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_create_job', description: 'Create a local run plan with typed plannedSteps. Alias: proof-or-stop planner create-job', schema: {
    storyId: z.string().optional().describe('Story id'),
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    requireMultiHost: z.boolean().optional().describe('Tighten the generated JobPlan.multiHostPolicy to require independent host verdicts (floor 2); does not itself certify multi-host verification'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts recorded in JobPlan.multiHostPolicy; activates and floors the multi-host requirement at 2'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_status', description: 'Read planner run status without mutation. Alias: proof-or-stop planner status', schema: {
    runId: z.string().optional().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_answer', description: 'Record structured interview answers for a paused planner run. Alias: proof-or-stop planner answer', schema: {
    runId: z.string().describe('Planner run id'),
    answersFile: z.string().describe('Structured answers JSON file'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_decision_submit', description: 'Record structured decision evidence for a paused decision-gated planner run. Alias: proof-or-stop planner decision submit', schema: {
    runId: z.string().describe('Planner run id'),
    decisionFile: z.string().describe('Structured decision JSON file'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_resume', description: 'Resume a paused planner run after answers or decisions. Alias: proof-or-stop planner resume', schema: {
    runId: z.string().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_run', description: 'Compose draft, review, Story creation, job/local plan creation, and plannedSteps execution unless --planOnly is set. Alias: proof-or-stop planner run', schema: {
    request: z.string().optional().describe('One sentence or paragraph request'),
    requestFile: z.string().optional().describe('Request document path'),
    interactionMode: z.enum(['autonomous', 'interview', 'decision-gated']).optional().describe('Planner interaction mode'),
    mode: z.enum(['local']).optional().describe('Execution mode'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase'),
    workflow: z.enum(['standard', 'source-aligned-redevelopment', 'source_aligned_redevelopment']).optional().describe('Development workflow'),
    planOnly: z.boolean().optional().describe('Stop after Story/job planning and do not execute plannedSteps'),
    execute: z.boolean().optional().describe('Execute plannedSteps; defaults to true unless planOnly is set'),
    maxExecuteSteps: z.number().int().positive().optional().describe('Maximum plannedSteps to execute before blocking'),
    requireMultiHost: z.boolean().optional().describe('Tighten the generated JobPlan.multiHostPolicy to require independent host verdicts (floor 2); does not itself certify multi-host verification'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts recorded in JobPlan.multiHostPolicy; activates and floors the multi-host requirement at 2'),
    sourceRepo: z.string().optional(),
    targetProject: z.string().optional(),
    targetProjectName: z.string().optional(),
    sourceLanguage: z.string().optional(),
    targetLanguage: z.string().optional(),
    renameMap: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
    includedPaths: z.union([z.array(z.string()), z.string()]).optional(),
    excludedPaths: z.union([z.array(z.string()), z.string()]).optional(),
    languageAdapterPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    semanticMappingPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    parityOraclePolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    alignmentVerificationIntent: z.union([z.array(z.string()), z.string()]).optional(),
    providerPolicy: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Explicit provider policy object or JSON string; real providers require explicit opt-in'),
    milestones: z.array(proofStoryMilestoneSchema).optional().describe('Optional explicit machine-countable milestone rows to carry in the planner draft; planner_create_story passes them through story_create.'),
    allowUnattendedPlanning: z.boolean().optional(),
    forceNewRun: z.boolean().optional(),
    forceNewRunReason: z.string().optional(),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_source_manifest', description: 'Extract a deterministic digest manifest for source-aligned redevelopment intake. Alias: proof-or-stop planner source-manifest', schema: {
    sourceRepo: z.string().describe('Source repo path'),
    includedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Included source paths'),
    excludedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Excluded source paths'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_review_submit', description: 'Submit a local non-authority host verdict with identity/material/storyFilesHash bindings for review escalation. Alias: proof-or-stop autopilot review submit', schema: {
    verdictFile: z.string().optional().describe('Verdict JSON file'),
    storyId: z.string().optional().describe('Story id'),
    runId: z.string().optional().describe('Local run id'),
    hostId: z.string().optional(),
    provider: z.string().optional(),
    sessionId: z.string().optional(),
    keyId: z.string().optional(),
    decision: z.enum(['pass', 'fail', 'blocked']).optional(),
    materialDigest: z.string().optional(),
    storyFilesHash: z.string().optional().describe('Optional story-owned file hash for whole-tree material drift downgrade diagnostics'),
    validationDigest: z.string().optional(),
    promptDigest: z.string().optional(),
    deriveBindings: z.boolean().optional().describe('Explicitly derive and verify the complete canonical binding envelope from current PASS evidence before writing one host verdict'),
    note: z.string().optional(),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'quorum_submit', description: 'Submit a local voluntary 3x2 host-verdict quorum only after current reviewer pass evidence exists for every required review lane', schema: {
    storyId: z.string().describe('Canonical Story id'),
    hostA: z.string().describe('First independent host id'),
    hostB: z.string().describe('Second independent host id'),
    rounds: z.number().int().positive().optional().describe('Number of quorum rounds to emit; default 3'),
    validationDigest: z.string().optional().describe('Optional validation digest; otherwise derived from current validation state'),
    promptDigestA: z.string().optional().describe('Optional prompt digest for hostA; otherwise derived'),
    promptDigestB: z.string().optional().describe('Optional prompt digest for hostB; otherwise derived'),
    keyA: z.string().optional().describe('Optional key id for hostA; otherwise derived'),
    keyB: z.string().optional().describe('Optional key id for hostB; otherwise derived'),
    sessionA: z.string().optional().describe('Optional session id for hostA; otherwise derived'),
    sessionB: z.string().optional().describe('Optional session id for hostB; otherwise derived'),
    providerA: z.string().optional().describe('Provider for hostA; default claude'),
    providerB: z.string().optional().describe('Provider for hostB; default codex'),
    note: z.string().optional().describe('Note attached to each local host verdict'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'quorum_prune', description: 'Official B-bf52 recovery: list (dry-run by default) and, with apply:true or the equivalent dryRun:false, remove duplicate host_verdict events on the same runId + host/session/key identity from the committed process-events.jsonl. Executing writes a timestamped byte-identical backup before rewriting and commits through the same lifecycle-metadata transaction quorum_submit uses, holding the shared process-events append lock and installing the rewritten log by atomic rename. Recovery is restricted to the canonical collision shape: every member of a pruned group must be a complete decision=pass host_verdict, so a group containing a non-pass or malformed row is refused, reported, and left intact rather than having a failing verdict deleted. Contradictory pairs (apply:true with dryRun:true, or apply:false with dryRun:false) are refused.', schema: {
    storyId: z.string().describe('Canonical Story id'),
    runIds: z.array(z.string()).optional().describe('Optional runId filter; only duplicates on these runIds are pruned, others are left untouched'),
    dryRun: z.boolean().optional().describe('Default dry-run: list the duplicate host_verdict events that would be removed without writing a backup, rewriting, or committing. Default true; an explicit dryRun:false executes exactly like apply:true rather than being a silent no-op. Contradictory pairs are refused: dryRun:true with apply:true, and dryRun:false with apply:false.'),
    apply: z.boolean().optional().describe('Actually back up, rewrite, and commit; omitted defaults to the dry-run that only lists what would be removed. apply:true and dryRun:false are equivalent executors. Contradictory pairs are refused: apply:true with dryRun:true, and apply:false with dryRun:false.'),
    keep: z.enum(['newest-material', 'oldest-material']).optional().describe('Which duplicate survives per group; default newest-material keeps the later (newer-material) event, oldest-material keeps the earlier'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'cross_host_review', description: 'Submit or resume a durable managed Codex run as an independent read-only reviewer over the current materialHash-bound change, then record a structured host-B verdict alongside the caller-authored host-A findings and surface host-A/host-B disagreements (crypto-deferred M1; no signatures)', schema: {
    storyId: z.string().describe('Canonical Story id'),
    policy: z.string().optional().describe('Optional dispatch policy name governing the read-only Codex subprocess'),
    hostAFindingsFile: z.string().optional().describe('Path to a JSON array of host-A (Claude) Finding objects to diff against host B'),
    hostA: z.string().optional().describe('Host-A id; default claude-host-a'),
    hostB: z.string().optional().describe('Host-B id; default codex-host-b'),
    runId: z.string().optional().describe('Local run id; default <storyId>-xhr-r1'),
    timeoutMinutes: z.number().int().positive().optional().describe('Bounded timeout for the Codex review subprocess; default 12'),
    detach: z.boolean().optional().describe('Submit the durable managed Codex leaf and return its managedRunId after worker claim without consuming a verdict'),
    managedRunId: z.string().optional().describe('Resume and consume this exact already-submitted managed Codex run; never spawns a replacement'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'host_run', description: 'Submit a durable managed Codex or Claude CLI run. Foreground mode attaches to the same durable run; --detach returns after the worker claim. Silence never implies failure. Alias: proof-or-stop host run', schema: {
    idempotencyKey: z.string().min(1).max(512).optional().describe('Stable logical request key for retry-safe submission; changed inputs are refused. Formal reviews automatically bind host/story/reviewRunId/lane.'),
    host: z.string().describe('Canonical managed host: codex or claude (alias: claude-code->claude)'),
    agentType: z.string().describe('Attribution agentType recorded on the usage rows, e.g. reviewer / proof-or-stop-review-quality / autopilot-repair'),
    storyId: z.string().optional().describe('Canonical Story id; when set the story index resolves the phase (omit for an adhoc run)'),
    phase: z.string().optional().describe('Explicit attribution phase; when omitted and storyId is set, resolves from the story index'),
    prompt: z.string().optional().describe('Inline prompt text (mutually exclusive with --promptFile)'),
    promptFile: z.string().optional().describe('Path to a prompt file (mutually exclusive with --prompt)'),
    reviewRunId: z.string().optional().describe('Review run id (e.g. B-70e9:RR-001) recorded as threadId; must start with "<storyId>:" when storyId is given'),
    lane: z.string().optional().describe('Reviewer lane (e.g. proof-or-stop-review-quality) recorded as subagentId'),
    timeoutMs: z.number().int().positive().optional().describe('Host subprocess timeout in milliseconds'),
    deadlineMs: z.number().int().positive().optional().describe('Finite absolute managed-run deadline in milliseconds; defaults to timeoutMs or 30 minutes'),
    detach: z.boolean().optional().describe('Return after durable worker claim instead of attaching until terminal'),
    managedReview: z.boolean().optional().describe('Formal cross-provider reviewer mode: derive the exact prompt from reviewRunId/lane, require agentType=lane, and accept only a provider-authored proposal plus successful terminal receipt. Do not pass prompt/promptFile.'),
    json: z.boolean().optional().describe('Output the structured host_run result as JSON (exitCode is a field)'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'host_run_status', description: 'Read or bounded-long-poll one durable managed host run or a set of targets. waitMs is capped at 30000 and silence does not change state. Alias: proof-or-stop host run status', schema: {
    runId: z.string().optional().describe('Managed host run id; exclusive with targets'),
    targets: z.array(z.object({
      runId: z.string(),
      afterGeneration: z.number().int().nonnegative().optional(),
    })).min(1).max(32).optional().describe('Wait for any changed run; each cursor acknowledges previously delivered terminal state'),
    afterGeneration: z.number().int().nonnegative().optional().describe('Return when generation differs from this value'),
    afterSequence: z.number().int().nonnegative().optional().describe('Return live-output frames after this sequence'),
    waitMs: z.number().int().nonnegative().max(30000).optional().describe('Bounded long-poll wait, maximum 30000ms'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'host_run_cancel', description: 'Idempotently request cancellation of one durable managed host run. Alias: proof-or-stop host run cancel', schema: {
    runId: z.string().describe('Managed host run id'),
    reason: z.string().optional().describe('Operator cancellation reason'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'host_run_worker', visibility: 'internal', description: 'Internal detached worker for a previously submitted managed host run', schema: {
    runId: z.string().describe('Managed host run id'),
  }},
  { name: 'managed_review_proposal_set', description: 'Compatibility-only provider callback for older adapters. It requires paired readManifest/readLog evidence; formal managed reviewers seal the bounded final assistant result instead.', schema: {
    runId: z.string().optional().describe('Managed run id; normally inherited through LATTICE_MANAGED_HOST_RUN_ID'),
    storyId: z.string().describe('Story bound by the managed run'),
    providerAgent: z.string().describe('Provider reviewer identity bound by the managed run'),
    lane: z.string().describe('Reviewer lane bound by the managed run'),
    reviewRunId: z.string().describe('Signed review run bound by the managed run'),
    conclusion: z.enum(['pass', 'findings']).describe('Exactly one pass or findings conclusion'),
    note: z.string().optional().describe('Pass note; required only for pass'),
    findings: z.array(z.object({
      desc: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      category: z.enum(['happy', 'edge', 'adversarial', 'missing']),
      files: z.array(z.string()).optional(),
      evidenceState: z.enum(['suspected', 'verified']).optional(),
      uncertaintyReason: z.string().optional(),
    }).strict()).optional().describe('Findings; required only for findings conclusion'),
    readManifest: z.unknown().describe('Truthful reviewer read manifest'),
    readLog: z.unknown().describe('Required mechanical reviewer read-log evidence. Runtime validates its canonical shape and coherence with readManifest.'),
    readDiagnostics: z.unknown().optional().describe('Mechanical read-manifest diagnostics'),
  }},
  { name: 'managed_review_evidence_import', description: 'Import provider-authored evidence only from an exact successful managed terminal receipt. Verdict/note/finding overrides are intentionally unsupported.', schema: {
    runId: z.string().describe('Managed run id'),
    receiptId: z.string().describe('Exact receipt id returned by host_run_status after terminal'),
  }},
  { name: 'candidate_spec_route', description: 'Build deterministic Story keywords, optionally collect sanitized bounded Codex and Claude semantic proposals through host_run, search the local requirements corpus, rank at most eight ordinary candidates, and persist a versioned candidate-spec-set artifact without embedding document bodies in a prompt.', schema: {
    storyId: z.string().describe('Canonical Story id'),
    hosts: z.boolean().optional().describe('Launch semantic proposal hosts; default true. Set false for deterministic local-only routing.'),
    persist: z.boolean().optional().describe('Persist candidate-spec-set.json; default true.'),
    fullScanReason: z.string().optional().describe('Structured reason for a tool-driven broad scan; never serializes corpus bodies.'),
    json: z.boolean().optional().describe('Output the versioned candidate artifact as JSON.'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'candidate_spec_rollout_check', description: 'Evaluate a shadow/warn/enforce candidate-routing promotion against two consecutive quality and cost windows. Read-only; rollback always means explicit tool-driven review with recorded escalation and never corpus prompt injection.', schema: {
    from: z.enum(['shadow', 'warn', 'enforce']),
    to: z.enum(['shadow', 'warn', 'enforce']),
    windows: z.array(z.object({
      id: z.string(),
      criticalHighRecall: z.number(),
      overallRecall: z.number(),
      findingEquivalent: z.boolean(),
      promptByteReduction: z.number(),
      p95LatencyMs: z.number(),
      readMismatchCount: z.number().int(),
      unjustifiedFullScanCount: z.number().int(),
    })),
    maxP95LatencyMs: z.number().positive().optional(),
    json: z.boolean().optional(),
    format: z.enum(['text', 'json']).optional(),
  }},
  { name: 'usage_sweep', description: 'Read-only NON-AUTHORITATIVE usage sweep: streams ~/.codex/sessions rollouts and ~/.claude/projects transcripts since a cutoff and reports per-session token totals, originator (desktop vs exec vs claude-code), cwd, first/last timestamps, and B-xxxx story mentions plus a per-story rollup and grand totals. Estimates only (attribution from host transcript stores, not billing truth); performs no ledger backfill and no gate/lifecycle changes, and writes nothing unless --out is explicitly passed. Alias: proof-or-stop usage sweep', schema: {
    since: z.string().describe('Cutoff: YYYY-MM-DD, ISO datetime, or <N>d shorthand (e.g. 7d). Files with mtime before the cutoff are skipped before reading'),
    codexSessionsDir: z.string().optional().describe('Override the codex sessions dir (default ~/.codex/sessions)'),
    claudeProjectsDir: z.string().optional().describe('Override the claude projects dir (default ~/.claude/projects)'),
    out: z.string().optional().describe('Write the JSON report to this path (must resolve INSIDE the project root); the only write this command performs'),
    alert: z.boolean().optional().describe('B-623a advisory burn alert: evaluate the swept sessions against the env-tunable burn thresholds (PROOF_OR_STOP_BURN_ALERT_FILE_MB/INPUT_TOKENS/AGE_DAYS) and exit non-zero when any session exceeds them, after printing the full report — cron-friendly; performs no writes and never gates anything'),
    json: z.boolean().optional().describe('Emit the full report object as JSON (carries the same NON-AUTHORITATIVE ESTIMATE label)'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_review_status', description: 'Summarize local independent host verdicts. Alias: proof-or-stop autopilot review status', schema: {
    storyId: z.string().describe('Story id'),
    runId: z.string().optional().describe('Local run id'),
    requiredHosts: z.number().optional().describe('Required independent passing hosts'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},

  // B-ad2c: dev-memory — lightweight non-authoritative experience capture
  { name: 'dev_memory_capture', description: 'Capture a non-authoritative dev-memory lesson to JSONL (not gate evidence)', schema: {
    category: z.enum(['failure-mode','pattern','anti-pattern','workflow','tool-quirk','guard-bypass','debugging','communication','other']).describe('Lesson category.'),
    scope: z.enum(['project','global','story-candidate']).optional().describe('Storage scope (default: project).'),
    summary: z.string().describe('One-sentence summary (at least 10 characters).'),
    trigger: z.string().describe('Trigger scenario (at least 5 characters).'),
    lesson: z.string().describe('Reusable lesson (at least 10 characters).'),
    reusePrompt: z.string().describe('How to retrieve this lesson in a later session (at least 5 characters).'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('Keyword tags, as a comma-separated string or array.'),
    sourceAgent: z.string().optional().describe('Source agent (default: proof-or-stop-implementer).'),
    sourceStoryId: z.string().optional().describe('Source story ID.'),
    evidenceRefs: z.array(z.string()).optional().describe('Evidence references (file paths or commit SHAs).'),
  }},
  { name: 'dev_memory_list', description: 'List dev-memory lessons', schema: {
    scope: z.enum(['project','global','story-candidate']).optional().describe('Storage scope (default: project).'),
    limit: z.number().optional().describe('Maximum number of entries to return (default: 50).'),
    json: z.boolean().optional().describe('JSON output format.'),
  }},
  { name: 'dev_memory_search', description: 'Search dev-memory lessons by query/category/agent/tags', schema: {
    query: z.string().optional().describe('Full-text search query.'),
    category: z.string().optional().describe('Filter by category.'),
    agent: z.string().optional().describe('Filter by source agent.'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('Filter by tags, as a comma-separated string or array.'),
    limit: z.number().optional().describe('Maximum number of entries to return (default: 20).'),
    global: z.boolean().optional().describe('Also search global storage.'),
    json: z.boolean().optional().describe('JSON output format.'),
  }},
  { name: 'dev_memory_preflight', description: 'Output a non-authoritative dev-memory preflight pack (called at session start)', schema: {
    query: z.string().optional().describe('Relevance query.'),
    maxEntries: z.number().optional().describe('Maximum number of entries to include (default: 5).'),
    maxLines: z.number().optional().describe('Line budget (default: 60).'),
    json: z.boolean().optional().describe('JSON output format.'),
  }},
  { name: 'dev_memory_preflight_ack', description: 'Build the dev-memory preflight pack and write a per-story acknowledgement required by the DEV-entry gate (or, if the build fails, record a reasoned downgrade with --reason)', schema: {
    storyId: z.string().describe('Story id whose DEV-entry gate this acknowledgement satisfies.'),
    query: z.string().optional().describe('Preflight relevance query.'),
    maxEntries: z.number().optional().describe('Maximum number of entries to include (default: 5).'),
    maxLines: z.number().optional().describe('Line budget (default: 60).'),
    reason: z.string().optional().describe('Reasoned-downgrade explanation (>=5 chars), required only when the preflight pack build itself throws.'),
    actor: z.string().optional().describe('Acknowledging actor (default: PROOF_OR_STOP_AGENT/USER env or "main-agent").'),
  }},
  { name: 'dev_memory_finish', description: 'Finish the dev-memory session', schema: {
    storyId: z.string().optional().describe('Active story ID, for example B-xxx; omitted value is inferred automatically from the active story branch; optional outside Proof-or-Stop sessions.'),
    storyDir: z.string().optional().describe('Story directory root path (default <root>/.proof-or-stop/story/actives).'),
    query: z.string().optional().describe('Optional relevance filter query.'),
    scope: z.enum(['global']).optional().describe('When storyId is omitted: global=promote project lessons to global dev-memory; even inside an active story, do not write story candidates.'),
  }},
  { name: 'dev_memory_finish_decision', description: 'Record end-of-work memory decision: captured, no reusable lesson, or defer with reason (no automatic promotion; existence required by the DONE gate, but lesson content is never gate evidence)', schema: {
    storyId: z.string().optional().describe('Optional story id for the finish decision.'),
    decision: z.enum(['captured', 'no-reusable-lesson', 'defer-with-reason']).describe('End-of-work memory decision.'),
    reason: z.string().optional().describe('Required for no-reusable-lesson and defer-with-reason.'),
    capturedEntryIds: z.union([z.string(), z.array(z.string())]).optional().describe('Captured dev-memory entry ids, comma-separated or array.'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'dev_memory_start', description: 'Start a dev-memory session wrapper', schema: {
    agent: z.string().optional().describe('Agent name, such as claude/codex; display only, does not start an external process.'),
    query: z.string().optional().describe('Preflight relevance query.'),
    maxEntries: z.number().optional().describe('Maximum number of preflight entries (default 5).'),
    dryRun: z.boolean().optional().describe('Compatibility parameter; always dry-run mode (does not start an external process).'),
  }},

  // B-0aa1: repro-first candidate-only evidence intake. All artifacts are evidence-candidate scope.
  { name: 'repro_probe', description: 'Record a candidate repro probe artifact (evidence-candidate scope; not production/DONE evidence)', schema: {
    candidateId: z.string().min(1).describe('Candidate identifier for this repro effort.'),
    taskSummary: z.string().min(5).describe('Summary of the task being reproduced.'),
    eligibility: z.string().min(1).describe('Why this candidate is eligible for repro intake.'),
    reason: z.string().min(1).describe('Reason for creating this probe.'),
    commandSpec: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }).describe('Command specification to reproduce the failure.'),
    expectedFailure: z.string().min(1).describe('Expected failure description.'),
    expectedFailurePattern: z.string().min(1).describe('Pattern (substring/regex) to match in observed failure output.'),
    executionStatus: z.enum(['not_run', 'run_attempted', 'confirmed_failing']).describe('Current execution status.'),
    observedFailureSummary: z.string().describe('Summary of observed failure.'),
    boundedOutputExcerpt: z.string().describe('Bounded excerpt of command output (not full log).'),
    producerObservedClass: z.enum(['target-bug', 'bootstrap-noise', 'environment-noise', 'unknown']).describe('Producer-observed failure classification.'),
    baselineHeadHash: z.string().optional().describe('Optional git HEAD hash at baseline.'),
    materialHash: z.string().optional().describe('Optional material hash at baseline.'),
  }},
  { name: 'repro_probe_get', description: 'Get a repro probe artifact by ID', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the probe.'),
  }},
  { name: 'repro_review_set', description: 'Record a review verdict for a repro probe (evidence-candidate scope)', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the probe being reviewed.'),
    probeDigest: z.string().optional().describe('Expected probe artifact digest for integrity check.'),
    verdict: z.enum(['red-reviewed', 'repro-rejected', 'needs-spike']).describe('Review verdict.'),
    reviewedFailureClass: z.enum(['target-bug', 'bootstrap-noise', 'environment-noise', 'unknown']).describe('Reviewer classification of the failure.'),
    notes: z.string().min(1).describe('Review notes.'),
  }},
  { name: 'spike_record', description: 'Record a spike investigation linked to a repro probe (evidence-candidate scope)', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the linked probe.'),
    description: z.string().min(1).describe('Description of the spike.'),
    steps: z.array(z.string()).describe('Investigation steps taken.'),
    observations: z.string().min(1).describe('Observations from the spike.'),
    commandSpec: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }).optional().describe('Command spec used during spike (if any).'),
    expectedFailurePattern: z.string().optional().describe('Expected failure pattern during spike.'),
    executionStatus: z.enum(['not_run', 'run_attempted', 'confirmed_failing']).describe('Execution status of spike command.'),
    observedOutput: z.string().describe('Observed output from spike execution.'),
  }},
  { name: 'spike_review_set', description: 'Record a review verdict for a spike record (evidence-candidate scope)', schema: {
    spikeId: z.string().min(1).describe('Artifact ID of the spike being reviewed.'),
    spikeDigest: z.string().optional().describe('Expected spike artifact digest for integrity check.'),
    verdict: z.enum(['confirmed', 'inconclusive', 'rejected']).describe('Spike review verdict.'),
    notes: z.string().min(1).describe('Review notes.'),
  }},
  { name: 'red_green_relation_create', description: 'Create a red/green baseline-vs-current relation artifact (evidence-candidate scope)', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the linked probe.'),
    baselineCommandSpec: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }).describe('Baseline command spec (failing state).'),
    baselineExpectedFailurePattern: z.string().min(1).describe('Expected failure pattern in baseline.'),
    currentCommandSpec: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }).describe('Current command spec (target passing state).'),
    currentExpectedFailurePattern: z.string().min(1).describe('Expected failure pattern that should change in current.'),
    description: z.string().min(1).describe('Description of the relation.'),
  }},
  { name: 'red_green_relation_evaluate', description: 'Evaluate a red/green relation artifact; fails closed on missing refs or digest mismatch', schema: {
    relationId: z.string().min(1).describe('Artifact ID of the relation to evaluate.'),
    relationDigest: z.string().optional().describe('Expected relation digest for integrity check.'),
  }},
  { name: 'regression_matrix_review_set', description: 'Record a candidate regression matrix review (evidence-candidate scope)', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the linked probe.'),
    relationId: z.string().optional().describe('Artifact ID of the linked red/green relation.'),
    spikeId: z.string().optional().describe('Artifact ID of the linked spike record.'),
    status: z.enum(['accepted', 'gap', 'blocked']).describe('Matrix review status.'),
    notes: z.string().min(1).describe('Review notes.'),
  }},
  { name: 'story_create_from_repro', description: 'Create a story from a reviewed repro candidate and write a story-evidence-binding artifact (evidence-candidate scope)', schema: {
    probeId: z.string().min(1).describe('Artifact ID of the repro probe.'),
    reviewId: z.string().min(1).describe('Artifact ID of the repro review.'),
    spikeId: z.string().optional().describe('Optional spike record artifact ID.'),
    spikeReviewId: z.string().optional().describe('Optional confirmed spike review artifact ID when spikeId is supplied.'),
    matrixReviewId: z.string().optional().describe('Optional regression matrix review artifact ID.'),
    storyTitle: z.string().min(5).describe('Title for the new story.'),
    storyDescription: z.string().min(10).describe('Description for the new story.'),
    derivedChecklistRefs: z.array(z.string()).optional().describe('Derived checklist item refs.'),
    derivedVerificationIntentRefs: z.array(z.string()).optional().describe('Derived verification intent refs.'),
  }},
  { name: 'red_evidence_binding_set', description: 'W2b: register the per-story target binding {acceptanceTargetRef, adapterId, testCaseRef} that authorizes a RED run (§1.1.3). Owner-lease + mutation-authority gated; exactly one binding per acceptanceTargetRef (duplicate rejects), rejects an out-of-expectedRedTargets ref, records targetBindingDigest = CANON over the createdAt-stripped 3-field subobject. W2c adds the §1.1.3 binding-freeze rule (frozen once a run record exists on an unquarantined chain).', schema: {
    storyId: z.string().describe('Story ID'),
    acceptanceTargetRef: z.string().min(1).describe('The acceptance target this binding authorizes; must be in the story\'s expectedRedTargets (§3.3).'),
    adapterId: z.string().min(1).describe('The adapter id that owns the RED run for this target.'),
    testCaseRef: z.string().min(1).describe('The test-case reference the adapter runs for this target.'),
    agent: z.string().optional().describe('Actor.'),
    actor: z.string().optional().describe('Actor alias.'),
  }},
  { name: 'red_evidence_quarantine', description: 'W2c: append a quarantine chain-control record retiring the referenced record without mutating history (§4.1). recordId MUST be the current head of its (storyId, target) chain whose operation is red-assert/green-confirm/recover. Owner-lease + mutation-authority gated; approvedBy is DERIVED <actor>@<sessionId> (never a caller arg); the derived acceptanceTargetRef must be in expectedRedTargets (§3.3, CHK-012); serialized under one mkdir claim.', schema: {
    storyId: z.string().describe('Story ID'),
    recordId: z.string().min(1).describe('The current chain-head record id to quarantine; the acceptanceTargetRef is derived from it (§4.1).'),
    reason: z.string().min(1).describe('Human-readable reason (whitespace-normalized into the operation key).'),
    agent: z.string().optional().describe('Actor.'),
    actor: z.string().optional().describe('Actor alias.'),
  }},
  { name: 'red_evidence_recover', description: 'W2c: append a recover chain-control record undoing a mistaken quarantine (§4.1). recordId MUST be the current head of its (storyId, target) chain whose operation is quarantine; reinstates the quarantined record transitively. Owner-lease + mutation-authority gated; approvedBy is DERIVED <actor>@<sessionId> (never a caller arg); the derived acceptanceTargetRef must be in expectedRedTargets (§3.3, CHK-012); serialized under one mkdir claim.', schema: {
    storyId: z.string().describe('Story ID'),
    recordId: z.string().min(1).describe('The current chain-head quarantine record id to recover; the acceptanceTargetRef is derived from it (§4.1).'),
    reason: z.string().min(1).describe('Human-readable reason (whitespace-normalized into the operation key).'),
    agent: z.string().optional().describe('Actor.'),
    actor: z.string().optional().describe('Actor alias.'),
  }},
  { name: 'red_evidence_envelope_check', description: 'W2d: READ-ONLY admissibility pre-flight for a candidate RED assertion envelope (§1.1). Validates matcher schema bounds, the §1.3 minimum-specificity rules, the §1.1.2 exit-class and adapter-linkage compatibility, the §1.1.3 supplementary-artifact path syntax, and the assertion against the story COMMITTED target binding, reporting §1.6-tagged rejections (R1-1/R1-2/R1-3/R1-5/R1-6) BEFORE a run is spent. On an admissible envelope it reports the computed assertionDigest, the matched binding reference, and the resolved policyDigest. It executes no envelope. Scoped to the command handler itself and the CLI story-evidence writers, it writes no RED-evidence record, chain record or story/evidence artifact, emits no process event, changes no gate verdict, and runs no preCommand or postCommand hook. Nothing outside that scope is covered: see the red_evidence_envelope_check note in cli/activity-policy.ts, which lists the surfaces known when it was written and is not a proof of exhaustiveness. In particular an inadmissible envelope is reported by THROWING, and cli-engine.ts prints that report TWICE — once before and once after it awaits the onError hooks, which run only when the hooks map has an exact red_evidence_envelope_check key or a * key.', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    assertionFile: z.string().min(1).describe('Path to the candidate §1.1 assertion envelope JSON (absolute, or resolved against the project root).'),
    json: z.boolean().optional().describe('Output deterministic structured JSON.'),
    status: z.never().optional().describe('Forbidden: admissibility is validator-derived.'),
    verdict: z.never().optional().describe('Forbidden: callers cannot submit a verdict.'),
    rejections: z.never().optional().describe('Forbidden: rejections are validator-derived.'),
    assertionDigest: z.never().optional().describe('Forbidden: the assertion digest is recomputed, never accepted from a caller.'),
    policyDigest: z.never().optional().describe('Forbidden: the policy digest comes from the resolved policy snapshot.'),
    binding: z.never().optional().describe('Forbidden: the target binding is read from the committed tree.'),
    evidence: z.never().optional().describe('Not supported: this check consumes and produces no evidence.'),
    write: z.never().optional().describe('Not supported: the command is read-only.'),
    apply: z.never().optional().describe('Not supported: the command applies no change.'),
  }},

];

/** Ordinary discovery/catalog consumers use this view; MAIN_TOOLS is the dispatch registry. */
export const PUBLIC_MAIN_TOOLS: ToolDef[] = publicToolCatalog(MAIN_TOOLS);
