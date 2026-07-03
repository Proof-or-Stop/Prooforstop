import { z } from 'zod';
import type { ToolDef } from './main-tools.js';
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

const inlineJsonObjectSchema = z.union([z.string(), z.object({}).passthrough()]);

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
});

const proofStoryContractEnvelopeSchema = z.object({
  acceptanceBindings: z.array(proofStoryAcceptanceBindingSchema).optional().describe('Acceptance-to-checklist/verificationIntent bindings consumed by diagnostics and opt-in gate enforcement.'),
  note: z.string().optional().describe('Contract envelope note.'),
}).passthrough();

const proofStoryGateModeSchema = z.enum(['observe', 'warn', 'enforce']);
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
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).optional().describe('Directly specify phase.'),
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
  }},
  { name: 'story_update', description: 'Edit Story metadata', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('New title.'),
    description: z.string().optional().describe('New description.'), priority: z.string().optional().describe('New priority.'),
    agent: z.string().optional().describe('Actor; INIT reviewer lanes may not directly change story-level scope fields.'),
    actor: z.string().optional().describe('Actor alias; INIT reviewer lanes may not directly change story-level scope fields.'),
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
  }},
  { name: 'story_resolve', description: 'Resolve a story phase and authoritative cwd for planned steps. Alias: lattice story resolve', schema: {
    storyId: z.string().describe('Story ID to resolve'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_reconcile', description: 'Detect and repair zombie Stories or terminal worktree residue (default dry run)', schema: {
    dryRun: z.boolean().optional().describe('true=report only; false=perform repair (default true).'),
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
`lattice dev_start '{"storyId":"B-xxxx"}'

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
    slim: z.boolean().optional().describe('Opt-in compact checklist view. Default output is unchanged when omitted.'),
    fields: z.array(z.string()).optional().describe('Opt-in top-level field filter. With slim=true, filter storyId/counts/items.'),
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
  }},
  { name: 'checklist_update', description: 'Update a checklist item (status/relatedDocs; title/context/userSees frozen)', longHelp: CHECKLIST_UPDATE_LONG, schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('Item ID.'),
    status: z.enum(['pending','in_progress','done']).optional().describe('New status.'),
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
    verificationEvidence: z.array(verificationEvidenceSchema).optional().describe('Evidence list covering verificationIntent.'),
    reason: z.string().optional().describe('Change reason.'), agent: z.string().optional().describe('Actor.'),
    actor: z.string().optional().describe('Actor alias; INIT reviewer lanes may not directly change requirement definitions.'),
    success: z.boolean().optional().describe('Whether the subagent result succeeded; only valid when status=done, default true.'),
  }},
  { name: 'verification_evidence_add', description: 'Add or update evidence satisfying a checklist item\'s verificationIntent', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID'),
    intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent ID.'),
    kind: verificationEvidenceKindSchema,
    verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate.'),
    waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, this can mark temporary gate self-test evidence.'),
    file: z.string().optional().describe('Test or documentation file path.'),
    command: z.string().optional().describe('Command to run.'),
    result: z.enum(['pass', 'fail']).optional().describe('Command result.'),
    note: z.string().describe('Why this evidence satisfies the intent.'),
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
      command: z.string().optional().describe('Command to run.'),
      result: z.enum(['pass', 'fail']).optional().describe('Command result.'),
      note: z.string().describe('Why this evidence satisfies the intent.'),
    })).describe('Evidence array; reads and writes the checklist once in the same call.'),
  }},
  { name: 'verification_evidence_refresh_stale', description: 'Refresh HEAD/material hashes for stale verificationEvidence (rerun command)', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('Report stale evidence that would be refreshed, without writing.'),
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
  { name: 'scope_boundary_set', description: 'Save the user-confirmed allowed/excluded scope boundary for the INIT_CHECK gate', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    mode: z.enum(['correctness_fix', 'feature', 'maintenance', 'custom']).optional().describe('Scope boundary mode; correctness_fix enables default future-capability keyword exclusions.'),
    allowedScope: z.array(z.string().min(1)).min(1).describe('Scope entries the user confirmed as allowed.'),
    excludedScope: z.array(z.string().min(1)).optional().describe('Scope entries the user confirmed as excluded or not to be done.'),
    userConfirmed: z.boolean().describe('Must be true: confirms this is the user-confirmed INIT scope boundary.'),
    confirmation: z.string().optional().describe('Confirmation note or source excerpt.'),
    actor: z.string().optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main-agent.'),
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
    actor: z.string().optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main-agent.'),
  }},
  { name: 'scope_freeze_check', description: 'Write the INIT scope freeze check result (accepted extensions stale old freeze)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    status: z.enum(['PASS', 'FAIL', 'pass', 'fail']).optional().describe('Optional assertion; cannot override the core evaluateScopeFreeze result.'),
    note: z.string().optional().describe('Freeze-check note; can also serve as repeated-discard mitigation text.'),
    repeatDiscardMitigation: z.string().optional().describe('Mitigation note for repeated discarded direction.'),
    actor: z.string().optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main-agent.'),
  }},
  { name: 'scope_extension_proposal', description: 'Propose a scope extension as the INIT reviewer (proposal only)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    proposal: z.string().min(10).describe('Extension proposal narrative; cannot take effect as accepted scope.'),
    reason: z.string().optional().describe('Why the reviewer thinks an extension is needed.'),
    reviewer: z.string().optional().describe('Proposer; defaults to LATTICE_AGENT/USER/main-agent.'),
    findingId: z.string().optional().describe('Optional related finding or issue ID.'),
    evidenceRefs: z.array(z.string().min(1)).optional().describe('Optional evidence references.'),
  }},
  { name: 'scope_extension_decide', description: 'Accept/reject a scope extension proposal in INIT (accepted stales old freeze)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    proposalId: z.string().min(1).describe('Proposal ID returned by scope_extension_proposal.'),
    decision: z.enum(['accepted', 'rejected']).describe('Explicit decision.'),
    reason: z.string().min(10, 'reason ≥ 10 characters').describe('Decision reason.'),
    decider: z.string().optional().describe('Decider; defaults to LATTICE_AGENT/USER/main-agent.'),
  }},
  { name: 'light_review', description: 'Record one lightweight review (called after each batch of DEV items completes)', schema: {
    storyId: z.string().describe('Story ID'),
    checklistIds: z.array(z.string()).describe('Checklist item IDs covered by this review.'),
    note: z.string().optional().describe('Review note.'),
  }},
  { name: 'review_run_start', description: 'Start a reviewer run for the current REVIEW round; write signed review-runs.json', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent ID, for example lattice-review-quality; defaults to LATTICE_AGENT.'),
    lane: z.enum([
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
      'lattice-review-behavior',
      'lattice-review-docs',
      'lattice-review-channel',
    ]).optional().describe('Explicit reviewer lane; synonym for agent, provide only one.'),
    prompt: z.string().optional().describe('Prompt text actually received by the reviewer; promptHash is computed automatically when provided.'),
    promptHash: z.string().optional().describe('SHA-256 of the reviewer prompt; if prompt is also provided, it must match the actual prompt hash.'),
    reviewedIntentRefs: z.array(z.string()).optional().describe('Scope-protected story: verification intent refs reviewed in this run; included in scope binding, optional.'),
  }},
  { name: 'review_pass_set', description: 'Record a reviewer pass credential (reviewer checked, found no blocking findings)', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent ID, for example lattice-review-quality; defaults to LATTICE_AGENT.'),
    reviewRunId: z.string().describe('Current reviewer run ID; call review_run_start first.'),
    note: z.string().describe('Review scope and reason there is no blocker (at least 10 characters).'),
  }},
  { name: 'review_loop_start', description: 'Record REVIEW reflection loop start (recording only; no host or rollback)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    loopId: z.string().min(1).optional().describe('Optional loop ID; defaults to one generated by the handler.'),
    reviewRound: z.string().min(1).optional().describe('Optional REVIEW round; defaults to story.currentReviewRound.'),
    trigger: reviewLoopTriggerSchema.describe('Structured source that triggered the loop.'),
    rollbackRef: reviewLoopRollbackRefSchema.describe('References required for manual rollback; recorded only, not executed.'),
    actor: z.string().min(1).optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main.'),
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
    actor: z.string().min(1).optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main.'),
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
    actor: z.string().min(1).optional().describe('Recorded by; defaults to LATTICE_AGENT/USER/main.'),
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
  { name: 'decision_doc_proposal', description: 'Create/update a story-local proposal for promoting a decision into docs/requirements/decisions/<slug>.md. Alias: lattice decision doc proposal', schema: {
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
  { name: 'decision_doc_preview', description: 'Read-only render of a decision-doc proposal; writes no files or metadata. Alias: lattice decision doc preview', schema: {
    storyId: z.string().describe('Story ID'),
    proposalId: z.string().describe('DDP-001 proposal id'),
  }},
  { name: 'decision_doc_save', description: 'Materialize a proposal into docs/requirements/decisions/<slug>.md with confirm, freshness, and scope guards. Alias: lattice decision doc save', schema: {
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
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason}; explain each sandbox:false case that was not run, otherwise Proofbound reports missing entries.'),
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
  { name: 'bug_list', description: 'View bug list; without storyId, show a global summary across all stories', schema: { storyId: z.string().optional().describe('Story ID; when omitted, list bugs for all stories.') }},
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
    storyId: z.string().optional().describe('Deprecated; for current story verification use lattice validate --story=<storyId> and record verificationEvidence.'),
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
  { name: 'done_closure', description: 'Project local DONE closure readiness from the DONE oracle without mutating lifecycle or widening local assurance. Alias: lattice done closure', schema: {
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
  { name: 'reviewer_batch', description: 'Read-only reviewer-launcher PLAN producer: for a story in REVIEW, consolidates the per-lane reviewer state (current-pass / scope-changed / no-receipt / blocking) from existing facts, emits the Agent(...) launch instruction (the orchestrator subagent-spawn form, not a dispatch CLI command) for each lane needing a (re-)run, and reports the REVIEW gate status from the StoryReadinessReport review rows. Launches no reviewer, runs no review_run_start, writes no review-runs/review-passes/findings or any evidence; there is NO --write/--launch/--run flag.', schema: {
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
    capture: z.string().optional().describe('Opt-in command capture: run ONLY this one explicitly-provided command (spawnSync, bounded timeout) and record stdout/stderr/exit as the actual transcript. Never derives or appends a command. Capture alone persists nothing.'),
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
    write: z.boolean().optional().describe('Persist through existing understanding_set and checklist_add paths only.'),
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
  { name: 'done_prepare', description: 'Conservative pre-DONE readiness assistant; prints Memory Runtime Preflight packDigest/gateEvidence=false and never advances DONE or mutates version files. Alias: lattice done prepare', schema: {
    storyId: z.string().describe('Story ID'),
    mergeMain: z.boolean().optional().describe('Attempt git merge main before closure checks (default true).'),
    refreshStale: z.boolean().optional().describe('Refresh stale evidence only when the dry-run classification says it is safe (default true).'),
    validate: z.boolean().optional().describe('Run lattice validate --story=<storyId> --json before DONE closure projection (default true).'),
    build: z.boolean().optional().describe('Optional worktree-local npm build + CLI version execution check; does not check global lattice.'),
    dryRun: z.boolean().optional().describe('Inspect and report planned steps without mutating git, evidence, build outputs, or version files.'),
    versionBump: z.never().optional().describe('Unsupported: done_prepare never bumps versions before DONE.'),
    bumpVersion: z.never().optional().describe('Unsupported: done_prepare never bumps versions before DONE.'),
    postDoneVersionBump: z.never().optional().describe('Unsupported: done_prepare only reports post-DONE version bump need.'),
  }},
  { name: 'done_required_validate', description: 'Run opt-in DONE-required validation commands and write done-required-evidence.json', schema: {
    storyId: z.string().describe('Story ID'),
    story: z.string().optional().describe('Alias for storyId.'),
    json: z.boolean().optional().describe('Return done-required-evidence.json content as JSON.'),
  }},
  { name: 'decision_doc_quorum_check', description: 'Read-only decision-doc local quorum diagnostic; decision-doc edits are classification-only unless review_escalation_status requires quorum. Alias: lattice decision doc quorum check', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_status', description: 'Read-only REVIEW escalation status for DONE; reports ordinary, full 3x2, or degraded 3x1 local assurance. Alias: lattice review escalation status', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_policy_set', description: 'Record an explicit high-risk policy fact that makes review escalation require 3x2 for the current material. Alias: lattice review escalation policy set', schema: {
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
  { name: 'review_escalation_fallback_set', description: 'Record explicit degraded 3x1 review escalation fallback evidence bound to the current material hash and optional storyFilesHash. Alias: lattice review escalation fallback set', schema: {
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
  { name: 'capability_list', description: 'List host-neutral Proofbound capability profiles and degradations (text/json)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_probe', description: 'Probe one host-neutral Proofbound capability profile and visible degradations (text/json)', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'agent_prompt', description: 'Print the canonical Proofbound agent prompt body for a role from the package prompt registry (host-neutral single source; Claude thin-shims fetch from here, Codex resolves the same registry)', schema: {
    role: z.string().min(1).describe('Proofbound agent role name, e.g. lattice-implementer, lattice-review-concept (the template basename without .md)'),
  }},
  { name: 'capability_claim_evaluate', description: 'Evaluate a local capability claim fail-closed from lower-layer suite reports (text/json)', schema: {
    target: z.string().optional().describe('Requested claim target, for example development, engineering, loop-engineering, or production-safety'),
    claimId: z.string().optional().describe('Claim id, for example CLAIM-PRODUCTION-SAFETY'),
    requestedClaim: z.string().optional().describe('Human requested claim wording to evaluate'),
    runId: z.string().optional().describe('Optional report run id when writing a claim report'),
    artifactsRoot: z.string().optional().describe('Optional baseline artifacts root (default .lattice/artifacts/baseline)'),
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
    artifactsRoot: z.string().optional().describe('Optional baseline artifacts root (default .lattice/artifacts/baseline)'),
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
  { name: 'host_list', description: 'List Proofbound host profiles, visible degradations, and migration authority boundaries (text/json). Alias: lattice host list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_probe', description: 'Probe one Proofbound host profile without claiming release readiness (text/json). Alias: lattice host probe', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_status', description: 'Report overflow-readiness status for one Proofbound host without changing authority (text/json). Alias: lattice host status', schema: {
    host: z.string().describe('Host profile id, for example claude-code or codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'host_runtime_list', description: 'List dispatch runtime availability for fake, codex, claude-code, and antigravity without changing authority (text/json). Alias: lattice host runtime list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime list JSON; refuses to overwrite'),
  }},
  { name: 'host_runtime_probe', description: 'Probe one dispatch runtime (fake, codex, claude-code, antigravity; alias agy) without starting a host (text/json). Alias: lattice host runtime probe', schema: {
    host: z.string().describe('Dispatch runtime id: fake, codex, claude-code, antigravity, or agy alias'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime probe JSON; refuses to overwrite'),
  }},
  { name: 'host_install', description: 'Show dry-run Proofbound host install guidance only; no third-party installs are executed. Alias: lattice host install', schema: {
    host: z.string().describe('Host profile id to show guidance for'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'lattice_config_doctor', description: 'Report Proofbound CLI 0.3.8 migration readiness, Mac App demotion status, and wrapper-root gitRoot diagnostics (text/json). Alias: lattice config doctor', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'lattice_config_repair', description: 'Explicit operator-confirmed wrapper-root repair: validates --set-git-root stays under the metadata root and is a git repository root, then writes only the gitRoot field of the existing project config when --confirm is given; without --confirm it is a non-mutating preview. Alias: lattice config repair', schema: {
    setGitRoot: z.string().optional().describe('Relative directory under the metadata root that is the git repository root (use --set-git-root=<dir>); required, never guessed'),
    confirm: z.boolean().optional().describe('Required to write; without --confirm the command previews the change and prints the exact confirm command'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'rollout_check', description: 'Run read-only cross-project Proofbound rollout diagnostics for install drift, managed assets, runtime footprint, and transcript scope. Alias: lattice rollout check', schema: {
    projects: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated project paths or JSON array; omit to scan the current root'),
    maxDepth: z.number().optional().describe('Discovery depth when projects is omitted (default 1)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'baseline_run', description: 'Run one executable Proofbound baseline scenario and write required final-report artifacts. Alias: lattice baseline run', schema: {
    baselineId: z.string().describe('Baseline scenario id (NL-*/RED-* baseline suite, or legacy ENG-/AUTH-/CLAIM-* Baseline 2-5 id)'),
    runId: z.string().optional().describe('Optional run id'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .lattice/artifacts/baseline)'),
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
  { name: 'baseline_suite', description: 'Aggregate baseline_run final-report artifacts into rates and false-DONE checks. Alias: lattice baseline suite', schema: {
    layer: z.enum(['development', 'engineering', 'loop-engineering', 'production-safety', 'capability-claim']).optional().describe('Legacy Baseline 2-5 layer to aggregate'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .lattice/artifacts/baseline)'),
    reportsRoot: z.string().optional().describe('Root directory to scan for final-report.json files'),
    reportFiles: z.union([z.array(z.string()), z.string()]).optional().describe('Explicit final-report.json files, array or comma-separated'),
    outputDir: z.string().optional().describe('Directory for baseline-suite-report artifacts'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'baseline_suite_report', description: 'Aggregate Proofbound baseline final-report.json files and write baseline-suite-report.json/md. Alias: lattice baseline suite report', schema: {
    layer: z.enum(['development', 'engineering', 'loop-engineering', 'production-safety', 'capability-claim']).optional().describe('Legacy Baseline 2-5 layer to aggregate'),
    artifactsRoot: z.string().optional().describe('Baseline artifacts root (default .lattice/artifacts/baseline)'),
    reports: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated final-report.json files or directories; defaults to the command report root'),
    outputDir: z.string().optional().describe('Directory for baseline-suite-report.json and baseline-suite-report.md (default command report root)'),
    suiteId: z.string().optional().describe('Suite id to include in the report (default minimum-baseline-suite)'),
    minimumSuiteRequired: z.boolean().optional().describe('Require the six-scenario minimum suite ids and at least six valid runs (default true)'),
    productionNoP0P1BlockersFor30Days: z.boolean().optional().describe('Only set true when the external 30-day blocker-free production requirement is proven'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_status', description: 'Report Proofbound conduit status and enforce readiness diagnostics without provisioning a runner or widening local assurance. Alias: lattice conduit status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_explain', description: 'Explain the CLI conduit migration boundary and no-overclaim semantics. Alias: lattice conduit explain', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_export', description: 'Export a Proofbound Story as Canonical Story v0 without claiming release readiness', schema: {
    storyId: z.string().describe('Story ID to export'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for canonical-story JSON'),
  }},
  { name: 'observability_snapshot', description: 'Build a host-neutral Proofbound observability snapshot (assurance ladder, story board, capability matrix, recovery, parallel) without widening local assurance. Alias: lattice observability snapshot', schema: {
    storyIds: z.array(z.string()).optional().describe('Restrict snapshot to specific story ids'),
    activeOnly: z.boolean().optional().describe('Default true; pass false to include DONE/DISCARDED stories'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for snapshot JSON; refuses to overwrite'),
  }},
  { name: 'handoff_create', description: 'Create a Proofbound handoff pack from one host to another; includes a memory/playbook packDigest with gateEvidence=false without manufacturing release readiness. Alias: lattice handoff create', schema: {
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
  { name: 'handoff_inspect', description: 'Inspect a Proofbound handoff pack and show capability deltas, degradations, evidence refs, and authority boundary. Alias: lattice handoff inspect', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while inspecting'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'handoff_accept', description: 'Accept a Proofbound handoff pack as a process-event style projection without changing authority. Alias: lattice handoff accept', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    acceptedByHost: z.string().optional().describe('Accepting host profile id; defaults to the handoff target host'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while accepting'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for accept projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_resume', description: 'Project a resume plan from a handoff pack or accept projection without refreshing evidence or authority. Alias: lattice handoff resume', schema: {
    file: z.string().describe('Handoff pack JSON file or handoff_accept projection JSON file'),
    resumeHost: z.string().optional().describe('Resume host profile id; defaults to acceptedByHost or target host'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while resuming'),
    primaryHostFailure: z.string().optional().describe('Required only when resumeHost is agy/antigravity fallback: concrete Codex/Claude failure signal'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for resume projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_receipt_submit', description: 'Validate and accept a local overflow receipt as diagnostic evidence only; never changes authority. Alias: lattice handoff receipt submit', schema: {
    file: z.string().describe('Handoff receipt JSON file'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility while submitting the local receipt'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for receipt-submit projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_worktree_create', description: 'Project isolated overflow worktree guidance from a handoff pack without creating or merging anything. Alias: lattice handoff worktree create', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for worktree projection JSON; refuses to overwrite'),
  }},
  { name: 'host_dispatch', description: 'Project supervised host dispatch for an overflow pack without auto-trust, evidence submit, receipt verify, or merge. Alias: lattice host dispatch', schema: {
    host: z.string().describe('Target host profile id, for example claude-code'),
    file: z.string().describe('Handoff pack JSON file'),
    mode: z.enum(['supervised']).optional().describe('Dispatch mode; only supervised projection is supported'),
    admissibleProofRefs: z.union([z.string(), z.array(z.string())]).optional().describe('Additional explicit proof refs to evaluate for HANDOFF admissibility during dispatch preflight'),
    primaryHostFailure: z.string().optional().describe('Required only when host is agy/antigravity fallback: concrete Codex/Claude failure signal'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch projection JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_plan', description: 'Plan a dispatch runtime handoff without creating a worktree, receipt, or running an external host. Alias: lattice dispatch plan', schema: {
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
  { name: 'dispatch_prepare', description: 'Persist dispatch metadata, prompt placeholders, and bounded pack state without running a host. Alias: lattice dispatch prepare', schema: {
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
  { name: 'dispatch_run', description: 'Run fake dispatch locally or materialize real-host scaffolding without claiming authority. Alias: lattice dispatch run', schema: {
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
  { name: 'overflow_auto', description: 'Guarded alias over auto dispatch selection; defaults to suggest-only and requires visible approval to start. Alias: lattice overflow auto', schema: {
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
  { name: 'dispatch_collect', description: 'Collect git-derived base/head/changedFiles/transcript diagnostics for one dispatch. Alias: lattice dispatch collect', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch collect JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_receipt_create', description: 'Create a draft local handoff receipt from collected dispatch state. Alias: lattice dispatch receipt create', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch receipt JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_status', description: 'Inspect one dispatch lifecycle record and any derived receipt state. Alias: lattice dispatch status', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch status JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_list', description: 'List persisted dispatch lifecycle records. Alias: lattice dispatch list', schema: {
    storyId: z.string().optional().describe('Optional story filter'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch list JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_resume', description: 'Resume or rerun an existing dispatch lifecycle record. Alias: lattice dispatch resume', schema: {
    dispatchId: z.string().describe('Dispatch id to resume'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch resume JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_cancel', description: 'Cancel a dispatch without deleting its metadata or changing authority. Alias: lattice dispatch cancel', schema: {
    dispatchId: z.string().describe('Dispatch id to cancel'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch cancel JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_review', description: 'Summarize one dispatch, its receipt state, warnings, and git-derived changedFiles. Alias: lattice dispatch review', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch review JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_merge_plan', description: 'Produce manual-only merge guidance for accepted_local dispatches. Alias: lattice dispatch merge plan', schema: {
    dispatchId: z.string().describe('Dispatch id to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch merge-plan JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_create', description: 'Create and persist a named dispatch policy for user-authorized unattended scheduling. Alias: lattice dispatch policy create', schema: {
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
    allowAutoMerge: z.boolean().optional().describe('Allow auto-merge; must be false'),
    allowProductionDone: z.boolean().optional().describe('@help-hidden legacy local-assurance refusal sentinel'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_get', description: 'Read a named dispatch policy. Alias: lattice dispatch policy get', schema: {
    policy: z.string().describe('Policy name'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_policy_check', description: 'Check authorization status of a named dispatch policy for unattended scheduling. Alias: lattice dispatch policy check', schema: {
    policy: z.string().describe('Policy name to check'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for policy check JSON; refuses to overwrite'),
  }},
  { name: 'dispatch_auto', description: 'Policy-authorized unattended scheduler: reads dispatch_policy_check, enforces maxParallel/host/scope limits, starts deterministic fake workers; current host policies can name codex, claude-code, or antigravity, but real subprocess launch remains explicit and bounded. Alias: lattice dispatch auto', schema: {
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
  { name: 'dispatch_watch', description: 'Read-only lifecycle aggregation for one dispatch: status, workers, runner summary, changedFiles count, nextAction. Alias: lattice dispatch watch', schema: {
    dispatchId: z.string().describe('Dispatch ID to watch'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for dispatch_watch JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_policy_create', description: 'Create and persist a named local autopilot execution policy without starting workers. Alias: lattice autopilot policy create', schema: {
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
  { name: 'autopilot_policy_get', description: 'Read a named autopilot policy. Alias: lattice autopilot policy get', schema: {
    policy: z.string().describe('Policy name'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_policy_check', description: 'Check a named local autopilot policy. Alias: lattice autopilot policy check', schema: {
    policy: z.string().describe('Policy name to check'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy check JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_run', description: 'Run a saved local autopilot policy for a story. Alias: lattice autopilot run', schema: {
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
  { name: 'autopilot_status', description: 'Read one persisted autopilot run status. Alias: lattice autopilot status', schema: {
    runId: z.string().describe('Autopilot run ID to inspect'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot status JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_watch', description: 'Read-only lifecycle aggregation for one autopilot run. Alias: lattice autopilot watch', schema: {
    runId: z.string().describe('Autopilot run ID to watch'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot watch JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_cancel', description: 'Cancel an autopilot run without deleting evidence or changing authority. Alias: lattice autopilot cancel', schema: {
    runId: z.string().describe('Autopilot run ID to cancel'),
    reason: z.string().optional().describe('Optional cancellation reason'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot cancel JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_review', description: 'Summarize an autopilot run, warnings, evidence, and authority posture without mutating it. Alias: lattice autopilot review', schema: {
    runId: z.string().describe('Autopilot run ID to review'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot review JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_resume', description: 'Replay a persisted autopilot checkpoint ledger and return an M1 resume projection without launching workers or changing authority. Alias: lattice autopilot resume', schema: {
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
  { name: 'parallel_wave_create', description: 'Create a Proofbound Parallel Wave scheduling projection over Canonical Stories without authority changes', schema: {
    storyIds: z.array(z.string()).optional().describe('Story IDs to include; omit to analyze active stories'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id; defaults to a deterministic id from story refs'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for wave JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_inspect', description: 'Inspect a Proofbound Parallel Wave JSON file without refreshing evidence or authority', schema: {
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
  { name: 'doctor', description: 'View Proofbound health issues (silent-caught PERSIST fails); scan orphan worktrees', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default: text).'),
    limit: z.number().optional().describe('Maximum number of entries to read (default: 1000).'),
    repair: z.boolean().optional().describe('Clean DONE/DISCARDED terminal worktree registrations, orphan directories, and prunable metadata.'),
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
  }},
  { name: 'codex_doctor', description: 'Report Codex adapter diagnostics status', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
  }},
  { name: 'check', description: 'Check Proofbound asset/template drift; --apply/--upgrade sync safe items explicitly', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
    apply: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets; does not overwrite CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE.'),
    upgrade: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets to current Proofbound templates; equivalent to --apply.'),
    reviewLocalEdits: z.boolean().optional().describe('Output structured manual review summary for STALE_LOCAL_EDIT.'),
    profile: z.enum(['codex', 'claude', 'all', 'core']).optional().describe('Override auto-detected init profile.'),
    assetMode: z.enum(['full', 'thin']).optional().describe('Override Codex prompt asset mode; full=generate .lattice-codex/agents, thin=use prompt registry.'),
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
    agent: z.string().optional().describe('Caller identity (audit field, defaults from LATTICE_AGENT).'),
  }},

  // Verifier (Proofbound built-in code verification).
  { name: 'validate', description: 'Run project verification (static, logic, and integration tests)', longHelp: VALIDATE_LONG, schema: {
    full: z.union([z.string(), z.boolean()]).optional().describe('Include real-machine tests (--full or --full=PvE to filter by name).'),
    focus: z.string().optional().describe('Run an explicit focused validate profile, for example --focus=fast. Configured commands must opt in with focus tags; no-focus validate remains full.'),
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

  // Evaluate (AI evaluation for browser projects).
  { name: 'evaluate', description: 'Ask the evaluator agent to score a browser app (completeness and usability)', schema: {
    storyId: z.string().describe('Story ID'),
    port: z.number().optional().describe('lattice serve port (default: 3456).'),
  }},
  { name: 'evaluate_save', description: 'Save evaluator scoring result to eval-evidence.json', schema: {
    storyId: z.string().describe('Story ID'),
    result: z.string().describe('JSON string output by evaluator.'),
  }},

  // Finding (Proofbound reviewer finding).
  { name: 'finding_add', description: 'Add a finding (Proofbound reviewer finding)', schema: {
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
    agent: z.string().optional().describe('Caller identity (optional, defaults from LATTICE_AGENT environment variable).'),
    reviewRunId: z.string().optional().describe('Current lattice-review-* reviewer run ID (call review_run_start first; main finding may omit this).'),
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
  }},
  { name: 'finding_list', description: 'View story findings', schema: {
    storyId: z.string().describe('Story ID'),
    cluster: z.boolean().optional().describe('B-9d95 CHK-005: return cluster view { clusters, ungrouped } instead of flat findings.'),
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
  // of finding signatureTags under .lattice/learning/. No gate reads it.
  { name: 'signature_registry_list', description: 'List signature-registry tags + statuses (audit-only)', schema: {
    storyId: z.string().optional().describe('Optional story ID (audit context only; the registry is not story-scoped).'),
  }},
  { name: 'signature_registry_set', description: 'Mutate the signature-registry (propose/approve/alias/deprecate; audit-only)', schema: {
    tag: z.string().describe('Signature tag.'),
    action: z.enum(['propose', 'approve', 'alias', 'deprecate']).describe('propose -> proposed; approve -> active (active requires explicit approve); alias adds a synonym; deprecate (optionally mergedInto).'),
    alias: z.string().optional().describe('Required when action=alias: the synonym to fold into the canonical tag.'),
    mergedInto: z.string().optional().describe('Optional when action=deprecate: canonical tag this deprecated tag folds into.'),
    by: z.string().optional().describe('Caller identity (audit trace; defaults from LATTICE_AGENT).'),
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
  // or touches gates; writes only under .lattice/learning/. Approve fails closed on
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
  { name: 'playbook_candidate_batch_approve', description: 'Dry-run default manifest for seed proposals; --apply requires manifestDigest and writes candidates only', schema: {
    dryRun: z.boolean().optional().describe('Preview candidate approval manifest without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Convert seed proposals to candidate playbooks only. Requires manifestDigest; never activates.'),
    limit: z.coerce.number().int().optional().describe('Maximum seed proposals to approve (default 50, max 100).'),
    manifestDigest: z.string().optional().describe('Digest from dry-run manifest required for --apply.'),
    json: z.boolean().optional().describe('Emit structured JSON.'),
  }},
  { name: 'playbook_runtime_consumption_verify', description: 'Read-only diagnostic proving active playbooks are consumed and candidates remain inert', schema: {
    json: z.boolean().optional().describe('Emit structured JSON.'),
    ...READ_ONLY_STATUS_UNSUPPORTED_FLAGS,
  }},
  { name: 'playbook_auto_promotion_apply', description: 'Evidence-activated advisory promotion; dry-run explains eligibility and --apply activates only qualifying candidates', schema: {
    dryRun: z.boolean().optional().describe('Explain evidence activation eligibility without writing. Default true unless apply=true.'),
    apply: z.boolean().optional().describe('Activate only evidence-qualified advisory candidates; writes active status plus append-only activation audit rows.'),
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
  // finding-signals cache (.lattice/learning/finding-signals.json) the Phase 1.5
  // hint loader reads. It WRITES the cache (not read-only — NOT in READ_ONLY_COMMANDS)
  // but reads findings via the store read ports only and touches no gate.
  { name: 'learning_scan', description: 'Derive and persist the advisory finding-signals cache (.lattice/learning/finding-signals.json) that powers review experience hints; writes the cache, reads findings via store ports, touches no gate', schema: {
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
    agent: z.string().optional().describe('Reviewer self-reported agent name; product-reviewer must pass product-reviewer.'),
    agentId: z.string().optional().describe('Reviewer self-reported agent ID; product-reviewer must pass product-reviewer and must not pass lattice-review-story-init.'),
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

  // Delivery Check (B-35ed: lattice-review-delivery reviewer writes signed delivery-check.json)
  // TEST to DONE hard-gate artifact. Signature domain: storyId + docsPromises + realMachineTests + closingSelfCheck + reviewRound.
  { name: 'delivery_check_set', description: 'Save delivery check results (called by lattice-review-delivery reviewer)', schema: {
    storyId: z.string().describe('Story ID'),
    docsPromises: z.array(z.object({
      docPath: z.string().describe('Document path.'),
      promise: z.string().describe('Promise described in the document.'),
      status: z.enum(['met', 'verified', 'waived', 'unverified']).optional().describe('Optional status; met/verified are treated as verified, waived requires waiverReason.'),
      verifiedBy: z.string().optional().describe('Verification method, such as grep/test/manual.'),
      evidence: z.string().optional().describe('Verification evidence.'),
      waiverReason: z.string().optional().describe('Documentation promise waiver reason (at least 30 characters when status=waived).'),
    })).describe('Documentation promise list.'),
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
  { name: 'scope_check_save', description: 'Save reviewer-written PLAN scope evidence (scope-check.json) consumed by story_review; intended for lattice-review-scope-plan/scope-plan reviewers.', schema: {
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
    // B-ed3e CHK-003: sixth channel Open Questions (optional). Reviewer writes only receive type validation,
    // business completeness is not validated; main agent later resolves it in writing with scope_question_resolve.
    openQuestions: z.array(z.object({
      id: z.string(),
      q: z.string(),
      evidence: z.string(),
      sourcePointers: z.array(z.string()),
    })).optional().describe('Open Questions: contradictions/questions reviewers notice in decisions/ but do not classify; main agent must resolve them with scope_question_resolve.'),
  }},

  // B-ed3e CHK-003: scope_question_resolve - main agent writes resolution for an OQ raised by reviewer.
  // Design principle: resolution is not included in signed _hash because resolution is a main-agent action and must not pollute the reviewer judgment signature domain.
  { name: 'scope_question_resolve', description: 'Resolve a scope reviewer Open Question in writing (prevents self-approval)', schema: {
    storyId: z.string().describe('Story ID'),
    oqId: z.string().describe('Open Question ID, for example OQ-1.'),
    resolution: z.string().min(20, 'resolution is required and must be at least 20 characters (written resolution, prevents self-approval).').describe('Main agent written resolution conclusion (at least 20 characters; should cite original decisions/ text).'),
    sourcePointers: z.array(z.string()).optional().describe('Evidence pointers for resolution (decisions/ path or checklist item ID), default [].'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch merged into lattice dispatch, available in all phases;
  // B-a4e3 CHK-005: the deprecated story_dispatch / finding_dispatch aliases were removed — lattice dispatch is now the only entry).
  { name: 'dispatch', description: 'Dispatch a subagent prompt for one item, finding, or cluster', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().optional().describe('Checklist item ID (CHK-xxx); mutually exclusive with findingId/clusterId, provide exactly one.'),
    findingId: z.string().optional().describe('Finding ID (F-xxx or B-xxx:F-xxx); mutually exclusive with itemId/clusterId.'),
    clusterId: z.string().optional().describe('Cluster ID (CL-xxx); mutually exclusive with itemId/findingId.'),
    agentType: z.string().optional().describe('subagent type; INIT reviewer may pass only lattice-review-story-init, other cases pair it with itemId/findingId/clusterId.'),
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

  // Workflow profile
  { name: 'workflow_set', description: 'Set project workflow profile (light/balanced/strict)', schema: {
    profile: z.string().describe('Target profile: light / balanced / strict.'),
  }},
  { name: 'workflow_show', description: 'Show current workflow profile and effective policy', schema: {} },
  { name: 'workflow_explain', description: 'Explain a story\'s actual effective profile (project / required / effective)', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // B-be27: Scope Contract — story-scoped allowed-file contract + post-diff gate
  { name: 'scope_contract_set', description: 'Create or update the scope contract for a story (allowed/protected/excluded files, mode)', schema: {
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
  { name: 'scope_contract_check', description: 'Run the post-diff scope gate (compares git diff against contract)', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON with status, violations, warnings'),
  }},
  { name: 'scope_contract_acknowledge', description: 'Record an explicit out-of-scope change acknowledgement (requires reason ≥ 20 chars)', schema: {
    storyId: z.string().describe('Story ID'),
    paths: z.array(z.string()).describe('Out-of-scope paths being acknowledged'),
    reason: z.string().min(20, 'reason must be ≥ 20 characters').describe('Why these out-of-scope paths are necessary (≥ 20 chars)'),
    actor: z.string().optional().describe('Actor making the acknowledgement (default: main-agent)'),
    anchors: z.array(z.string()).optional().describe('Semantic anchors covered by this acknowledgement'),
    hunkDigest: z.string().optional().describe('Single hunk digest covered by this acknowledgement'),
    hunkDigests: z.array(z.string()).optional().describe('Multiple hunk digests covered by this acknowledgement'),
  }},
  { name: 'scope_diff_pack', description: 'Generate a mechanical diff context pack with hunk digests and anchors', schema: {
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
  { name: 'scope_shrinkage_decision_set', description: 'Persist an explicit ProofStory scope-shrinkage decision', schema: {
    storyId: z.string().describe('Story ID'),
    decision: z.enum(['confirmed', 'rejected']).describe('Whether the shrinkage is accepted.'),
    userConfirmed: z.boolean().optional().describe('Must be true when decision=confirmed; DONE equivalence ignores confirmed shrinkage without this explicit user confirmation.'),
    removedMilestoneIds: z.array(z.string().min(1)).optional().describe('Milestones explicitly removed from DONE equivalence when decision=confirmed.'),
    reason: z.string().min(1).describe('Audit reason for the shrinkage decision.'),
    approvedBy: z.string().min(1).describe('Human or agent approving the decision.'),
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
  { name: 'guard_session_start', description: 'Start (or restart) a Proofbound-managed scope-guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    provider: z.string().min(1, 'provider is required').describe('Agent provider runtime (e.g. claude-code, codex). Guard mode depends on provider and context flags.'),
    nativeHookVerified: z.boolean().optional().describe('Set true when the host-native PreToolUse hook is confirmed installed (Claude Code .claude/settings.json or Codex .codex/hooks.json), enabling native-pretool mode.'),
    viaDispatch: z.boolean().optional().describe('(Codex/Antigravity only; Gemini legacy) Set true when running via Proofbound dispatch/pre-apply flow, enabling wrapped-preapply mode. Without this, those hosts use watcher-fallback.'),
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
  { name: 'prewrite_guard_check', description: 'Pre-write scope enforcement for Claude Code PreToolUse hooks and Proofbound dispatch pre-apply checks', schema: {
    storyId: z.string().optional().describe('Story ID (auto-discovered from active guard sessions when absent)'),
    provider: z.string().optional().describe('Agent provider (informational; used to log who triggered the check)'),
    toolName: z.string().describe('Name of the write-like tool being invoked (e.g. Edit, Write, MultiEdit, NotebookEdit)'),
    toolInputJson: z.string().optional().describe('JSON-encoded tool input from which target paths are extracted (used when targetPaths is absent)'),
    targetPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Explicit target path(s) to evaluate (overrides tool-input extraction)'),
    cwd: z.string().optional().describe('Working directory for resolving relative paths (defaults to project root)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'autopilot_execute', description: 'Execute a bounded unattended Proofbound autopilot loop using local Proofbound commands and local assurance only. Alias: lattice autopilot execute', schema: {
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
    commandTimeoutMS: z.number().optional().describe('Timeout for each Proofbound executor command in milliseconds'),
    claudeTimeoutMS: z.number().optional().describe('Timeout for each Claude repair command in milliseconds'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_doctor', description: 'Diagnose local autopilot readiness. Alias: lattice autopilot doctor', schema: {
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_draft', description: 'Create a structured Proofbound planner draft from a natural-language request. Alias: lattice planner draft', schema: {
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
    allowUnattendedPlanning: z.boolean().optional().describe('Allow unattended local Story planning'),
    forceNewRun: z.boolean().optional().describe('Request a distinct planner idempotency scope'),
    forceNewRunReason: z.string().optional().describe('Reason for forceNewRun'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_review', description: 'Review a planner draft for placeholders, ambiguity, policy, and verification gaps. Alias: lattice planner review', schema: {
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_create_story', description: 'Create a Proofbound Story from a reviewed planner draft. Alias: lattice planner create-story', schema: {
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    forceNew: z.boolean().optional().describe('Force a new Story through the planner-controlled path'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_create_job', description: 'Create a local run plan with typed plannedSteps. Alias: lattice planner create-job', schema: {
    storyId: z.string().optional().describe('Story id'),
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    requireMultiHost: z.boolean().optional().describe('Tighten the generated JobPlan.multiHostPolicy to require independent host verdicts (floor 2); does not itself certify multi-host verification'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts recorded in JobPlan.multiHostPolicy; activates and floors the multi-host requirement at 2'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_status', description: 'Read planner run status without mutation. Alias: lattice planner status', schema: {
    runId: z.string().optional().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_answer', description: 'Record structured interview answers for a paused planner run. Alias: lattice planner answer', schema: {
    runId: z.string().describe('Planner run id'),
    answersFile: z.string().describe('Structured answers JSON file'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_decision_submit', description: 'Record structured decision evidence for a paused decision-gated planner run. Alias: lattice planner decision submit', schema: {
    runId: z.string().describe('Planner run id'),
    decisionFile: z.string().describe('Structured decision JSON file'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_resume', description: 'Resume a paused planner run after answers or decisions. Alias: lattice planner resume', schema: {
    runId: z.string().describe('Planner run id'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_run', description: 'Compose draft, review, Story creation, job/local plan creation, and plannedSteps execution unless --planOnly is set. Alias: lattice planner run', schema: {
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
    allowUnattendedPlanning: z.boolean().optional(),
    forceNewRun: z.boolean().optional(),
    forceNewRunReason: z.string().optional(),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_source_manifest', description: 'Extract a deterministic digest manifest for source-aligned redevelopment intake. Alias: lattice planner source-manifest', schema: {
    sourceRepo: z.string().describe('Source repo path'),
    includedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Included source paths'),
    excludedPaths: z.union([z.array(z.string()), z.string()]).optional().describe('Excluded source paths'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_review_submit', description: 'Submit a local non-authority host verdict with identity/material/storyFilesHash bindings for review escalation. Alias: lattice autopilot review submit', schema: {
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
  { name: 'autopilot_review_status', description: 'Summarize local independent host verdicts. Alias: lattice autopilot review status', schema: {
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
    sourceAgent: z.string().optional().describe('Source agent (default: lattice-implementer).'),
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
  { name: 'dev_memory_finish', description: 'Finish the dev-memory session', schema: {
    storyId: z.string().optional().describe('Active story ID, for example B-xxx; omitted value is inferred automatically from the active story branch; optional outside Proofbound sessions.'),
    storyDir: z.string().optional().describe('Story directory root path (default <root>/.lattice/story/actives).'),
    query: z.string().optional().describe('Optional relevance filter query.'),
    scope: z.enum(['global']).optional().describe('When storyId is omitted: global=promote project lessons to global dev-memory; even inside an active story, do not write story candidates.'),
  }},
  { name: 'dev_memory_finish_decision', description: 'Record end-of-work memory decision: captured, no reusable lesson, or defer with reason (no automatic promotion; not gate evidence)', schema: {
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

];
