/**
 * Lattice CLI engine
 *
 * Wrap the shared dispatch, parse, log, and phase-gate logic in the callable runCli function.
 * The main package cli.ts is the binary entrypoint and calls runCli() directly.
 * Third-party bootstrap scripts can pass extraTools and extraRegister to runCli to merge utility tools
 * and handlers.
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { isAbsolute, join, relative } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns, hasProjectConfigFile } from './core/config.js';
import { resolveStorySignedWorkspace } from './core/story-signed-workspace-resolution.js';
import { formatCommandLifecycleHint, type CommandPolicy } from './core/command-policy.js';
import { decorateResult, wantsMachineJson, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { gitProbe, isGitRepository } from './core/git-probe.js';
import {
  acquireOrRefreshOwnerLease,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  takeOverOwnerLease,
} from './core/story-owner-lease.js';
import { getCommandPolicy, isOwnershipClass, type OwnershipClass } from './core/command-policy.js';
import { getGuardFailureReason } from './core/machine.js';
import { STORY_OUTCOME_KINDS, VERIFICATION_EVIDENCE_VERDICTS } from './core/types.js';
import { BACKGROUND_SECTION_IDS, normalizeBackgroundSection } from './core/background-validator.js';
import {
  ContextPackDependencyEdgeContractSchema,
  ContextPackSnippetContractSchema,
  ContextPackSymbolContractSchema,
  VerificationCommandContractSchema,
  VerificationContextPackContractSchema,
} from './core/authority-contracts.js';
import {
  STORY_CREATE_LONG, STORY_ADVANCE_LONG, CHECKLIST_UPDATE_LONG,
  STORY_REVIEW_LONG, BUG_REPORT_LONG, VALIDATE_LONG,
  SESSION_BRIEF_FOOTER,
} from './cli-prompts.js';
import {
  detectLatticeBrand,
  formatLatticeProductLine,
  formatLatticeVersionLine,
} from './core/lattice-brand.js';
import {
  MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT,
  MEMORY_BENCHMARK_DEFAULT_SEED,
} from './core/memory-benchmark.js';
import { LATTICE_DIR, LEGACY_KOALA_DIR } from './core/lattice-paths.js';
import { withReentrantMainWriteLock } from './core/main-write-lock.js';

// ── Tool Registry ──

export interface ToolDef {
  name: string;
  /** Short description shown in the lattice help command list. */
  description: string;
  /** Full prompt shown in lattice <cmd> --help. Optional; defaults to showing description only. */
  longHelp?: string;
  schema: Record<string, ZodType>;
}

const verificationIntentTypeSchema = z.preprocess((value) => {
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
const verificationIntentItemSchema = z.object({
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
 *   Lattice exposes code/story operations through a managed automated interface:
 *   people and AI both go through CLI schemas, command gates, handlers, and logs.
 *   Superpowers can trigger workflow by registering extra tools and handlers, but
 *   main command definitions win because MAIN_TOOLS are searched before extras.
 * More precisely, code should be managed through an automated interface; both humans and AI operate on code through that interface.
 * @changes
 *   - [CHK-001] Preserve CLI schema/handler dispatch as the operation interface for humans and AI
 *   - [CHK-001] Allow superpowers to trigger workflow through extraRegister without redefining core workflow
 */

const verificationIntentSchema = z.object({
  happy: z.array(verificationIntentItemSchema).optional().default([]),
  edge: z.array(verificationIntentItemSchema).optional().default([]),
  adversarial: z.array(verificationIntentItemSchema).optional().default([]),
});

const verificationEvidenceKindSchema = z.enum([
  'logic_test',
  'integration_test',
  'browser_test',
  'manual_transcript',
  'docs_check',
  'waiver',
  'cli',
  'logic',
]).describe('Evidence type; aliases: cli to manual_transcript, logic to logic_test.');

const verificationEvidenceSchema = z.object({
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

const reviewLoopDecisionSchema = z.enum([
  'continue',
  'retry',
  'revise',
  'rollback_required',
  'handoff_recommended',
  'human_gate_required',
  'close_candidate',
  'stop_blocked',
]);

const reviewLoopTriggerRefSchema = z.string().trim().min(1);

const reviewLoopTriggerSchema = z.object({
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

const gitObjectHashSchema = z.string().trim().regex(
  /^(?!([0-9a-f])\1+$)[0-9a-f]{40}(?:[0-9a-f]{24})?$/i,
  'must be a full Git object hash (40 or 64 hex characters), not a placeholder',
);

const sha256HashSchema = z.string().trim().regex(
  /^(?!([0-9a-f])\1+$)[0-9a-f]{64}$/i,
  'must be a SHA-256 hex digest (64 hex characters), not a placeholder',
);

const reviewLoopRollbackRefSchema = z.object({
  headHash: gitObjectHashSchema.describe('HEAD hash before the loop starts or the iteration begins.'),
  diffHash: sha256HashSchema.describe('Diff hash before the loop starts or the iteration begins.'),
  materialHash: sha256HashSchema.describe('Material hash before the loop starts or the iteration begins.'),
  scopeContractHash: sha256HashSchema.optional().describe('Optional scope contract hash.'),
});

const reviewLoopHostSchema = z.object({
  hostId: z.string().min(1).describe('Host ID participating in this reflection iteration.'),
  capabilitySnapshotRef: z.string().min(1).optional().describe('Capability snapshot reference; recorded only and receipt is not verified.'),
  visibleDegradations: z.array(z.string().min(1)).optional().describe('Visible host degradations in this iteration.'),
});

const reviewLoopReflectionSchema = z.object({
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

const reviewLoopEvaluationSchema = z.object({
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

const reviewLoopNextActionSchema = z.object({
  nextPrompt: z.string().min(1).optional().describe('Suggested next prompt; recorded only, not executed.'),
  rollbackCommandHint: z.string().min(1).optional().describe('Manual rollback command hint; recorded only, not executed.'),
  handoffHostId: z.string().min(1).optional().describe('Suggested handoff host; recorded only, no automatic handoff.'),
  humanQuestion: z.string().min(1).optional().describe('Question that requires a human answer.'),
});

const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);
const autopilotModeSchema = z.enum([
  'conservative',
  'authority-verified',
  'authority_verified',
  'full-autopilot',
  'full_autopilot',
]);
const serverAuthorityReceiptSchema = z.union([
  z.string(),
  z.object({
    authority: z.string().optional(),
    verified: z.boolean().optional(),
    receiptRef: z.string().optional(),
  }).passthrough(),
]);

const reviewEscalationFallbackEligibilitySchema = z.enum([
  'single-host-environment',
  'temporary-host-unavailability',
  'explicit-human-approval',
]);

const capsuleEvidenceRefSchema = z.object({
  kind: z.string().optional(),
  path: z.string().optional(),
  intentRef: z.string().optional(),
  receiptId: z.string().optional(),
  processEventLine: z.number().optional(),
  authority: z.enum(['authoritative', 'non_authoritative']).optional(),
  note: z.string().optional(),
});

const capsuleProcessEventRefSchema = z.object({
  line: z.number().optional(),
  type: z.string().optional(),
  digest: z.string().optional(),
  note: z.string().optional(),
});

const backgroundSectionSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return normalizeBackgroundSection(value) ?? value;
}, z.enum(BACKGROUND_SECTION_IDS));

const scopeFileRuleSchema = z.object({
  path: z.string().describe('Relative file path or simple glob covered by this semantic rule'),
  allowedAnchors: z.array(z.string()).optional().describe('Only these anchors may change'),
  deniedAnchors: z.array(z.string()).optional().describe('These anchors must not change'),
  protectedAnchors: z.array(z.string()).optional().describe('Hard-protected anchors'),
  allowedChangeKinds: z.array(z.enum(['add', 'remove', 'modify', 'rename'])).optional().describe('Allowed change kinds for matching hunks'),
  intentRefs: z.array(z.string()).optional().describe('Verification intent refs this rule protects'),
});

const storyTypeSchema = z.preprocess((value) => {
  if (value === 'test') return 'chore';
  return value;
}, z.enum(['feature','bug','refactor','chore']));

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim().length > 0);
}

function hasAnyNonEmptyStringArray(value: unknown, fields: string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return fields.some(field => hasNonEmptyStringArray(record[field]));
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
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional(), relatedDocs: z.array(z.string()).optional().describe('Related documentation paths used for the three reminders.'), userSees: z.string().optional().describe('User-visible output.'), excludes: z.array(z.string()).optional().describe('Explicitly declared out-of-scope functionality.'), verificationIntent: verificationIntentSchema.optional().describe('Happy-path, edge-case, and adversarial verification intent.') })).optional().describe('Development checklist.'),
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
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason}; explain each sandbox:false case that was not run, otherwise Lattice reports missing entries.'),
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
  { name: 'done_closure', description: 'Project local DONE closure readiness from the DONE oracle without mutating lifecycle or claiming Authority completion. Alias: lattice done closure', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'decision_doc_quorum_check', description: 'Read-only decision-doc local quorum diagnostic; decision-doc edits are classification-only unless review_escalation_status requires quorum. Alias: lattice decision doc quorum check', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_status', description: 'Read-only REVIEW escalation status for DONE; reports ordinary, full 3x2, or degraded 3x1 assurance without Authority completion. Alias: lattice review escalation status', schema: {
    storyId: z.string().describe('Story ID'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'review_escalation_fallback_set', description: 'Record explicit degraded 3x1 review escalation fallback evidence bound to the current material hash. Alias: lattice review escalation fallback set', schema: {
    storyId: z.string().describe('Story ID'),
    eligibility: reviewEscalationFallbackEligibilitySchema.describe('Allowed degraded fallback eligibility'),
    reason: z.string().min(20).describe('Why the selected degraded fallback eligibility applies and lower-assurance 3x1 review is being used'),
    evidenceRefs: z.array(z.string().min(1)).optional().describe('Local evidence references supporting degraded fallback'),
    approvalRef: z.string().optional().describe('Explicit approval reference; required when evidenceRefs is empty'),
    materialHash: z.string().optional().describe('Optional expected current material hash; stale values are rejected'),
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
    provider: z.string().optional().describe('CLI/provider, such as codex/claude-code/gemini.'),
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
  { name: 'capability_list', description: 'List host-neutral Lattice capability profiles and degradations (text/json)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_probe', description: 'Probe one host-neutral Lattice capability profile and visible degradations (text/json)', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'agent_prompt', description: 'Print the canonical Lattice agent prompt body for a role from the package prompt registry (host-neutral single source; Claude thin-shims fetch from here, Codex resolves the same registry)', schema: {
    role: z.string().min(1).describe('Lattice agent role name, e.g. lattice-implementer, lattice-review-concept (the template basename without .md)'),
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
  { name: 'host_list', description: 'List Lattice host profiles, visible degradations, and migration authority boundaries (text/json). Alias: lattice host list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_probe', description: 'Probe one Lattice host profile without claiming production authority (text/json). Alias: lattice host probe', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_status', description: 'Report overflow-readiness status for one Lattice host without changing authority (text/json). Alias: lattice host status', schema: {
    host: z.string().describe('Host profile id, for example claude-code or codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'host_runtime_list', description: 'List dispatch runtime availability for fake, claude-code, gemini, and codex without changing authority (text/json). Alias: lattice host runtime list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime list JSON; refuses to overwrite'),
  }},
  { name: 'host_runtime_probe', description: 'Probe one dispatch runtime (fake, claude-code, gemini, codex) without starting a host (text/json). Alias: lattice host runtime probe', schema: {
    host: z.string().describe('Dispatch runtime id: fake, claude-code, gemini, or codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for runtime probe JSON; refuses to overwrite'),
  }},
  { name: 'host_install', description: 'Show dry-run Lattice host install guidance only; no third-party installs are executed. Alias: lattice host install', schema: {
    host: z.string().describe('Host profile id to show guidance for'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'lattice_config_doctor', description: 'Report Lattice CLI 0.3.5 migration readiness, Mac App demotion status, and wrapper-root gitRoot diagnostics (text/json). Alias: lattice config doctor', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'lattice_config_repair', description: 'Explicit operator-confirmed wrapper-root repair: validates --set-git-root stays under the metadata root and is a git repository root, then writes only the gitRoot field of the existing project config when --confirm is given; without --confirm it is a non-mutating preview. Alias: lattice config repair', schema: {
    setGitRoot: z.string().optional().describe('Relative directory under the metadata root that is the git repository root (use --set-git-root=<dir>); required, never guessed'),
    confirm: z.boolean().optional().describe('Required to write; without --confirm the command previews the change and prints the exact confirm command'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'rollout_check', description: 'Run read-only cross-project Lattice rollout diagnostics for install drift, managed assets, runtime footprint, and transcript scope. Alias: lattice rollout check', schema: {
    projects: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated project paths or JSON array; omit to scan the current root'),
    maxDepth: z.number().optional().describe('Discovery depth when projects is omitted (default 1)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'baseline_run', description: 'Run one executable Lattice baseline scenario and write required final-report artifacts. Alias: lattice baseline run', schema: {
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
    receiptRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Authority receipt binding refs, array or comma-separated'),
    plannedStepRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering planned-step refs, array or comma-separated'),
    reviewLoopRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering review-loop refs, array or comma-separated'),
    hostVerdictRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering host verdict refs, array or comma-separated'),
    budgetReportRef: z.string().optional().describe('Formal Loop Engineering budget report ref'),
    stopConditionRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Formal Loop Engineering stop-condition refs, array or comma-separated'),
    authorityMode: z.enum(['non-authority', 'authority']).optional().describe('Baseline authority mode'),
    expectedOutcome: z.enum(['PASS', 'EXPECTED_BLOCK']).optional().describe('Expected outcome override'),
    outputRoot: z.string().optional().describe('Baseline artifact root'),
    requestText: z.string().optional().describe('Original request text override'),
    receiptVerified: z.boolean().optional().describe('Authority-mode verified native receipt input'),
    gateReceiptVerifiedAgainstPinnedKey: z.boolean().optional().describe('Authority-mode receipt was verified against the pinned server public key'),
    gateReceiptJson: z.string().optional().describe('Authority-mode native gate_decision receipt JSON payload'),
    gateReceiptPath: z.string().optional().describe('Path to Authority-mode native gate_decision receipt JSON payload'),
    hostVerdictsJson: z.string().optional().describe('Authority-mode server-backed host verdicts JSON payload'),
    hostVerdictsPath: z.string().optional().describe('Path to Authority-mode server-backed host verdicts JSON payload'),
    satisfiedReviewWaves: z.number().int().nonnegative().optional().describe('Authority-mode satisfied review waves'),
    requiredReviewWaves: z.number().int().positive().optional().describe('Authority-mode required review waves; floored to 3'),
    staleVerdicts: z.number().int().nonnegative().optional().describe('Authority-mode stale verdict count'),
    failingIndependentHosts: z.number().int().nonnegative().optional().describe('Authority-mode failing independent host count'),
    serverBackedVerdictsAccepted: z.boolean().optional().describe('Authority-mode server-backed verdict acceptance input'),
    localReviewCertified: z.boolean().optional().describe('Non-authority local independent review result'),
    localReviewEvidenceRefs: z.union([z.array(z.string()), z.string()]).optional().describe('Non-authority local independent review evidence refs, array or comma-separated'),
    requiredIndependentHosts: z.number().int().positive().optional().describe('Non-authority required independent local host count'),
    independentHosts: z.number().int().nonnegative().optional().describe('Non-authority observed independent local host count'),
    passingIndependentHosts: z.number().int().nonnegative().optional().describe('Non-authority passing independent local host count'),
    authorityServerContact: z.boolean().optional().describe('Whether a non-authority run contacted Authority'),
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
  { name: 'baseline_suite_report', description: 'Aggregate Lattice baseline final-report.json files and write baseline-suite-report.json/md. Alias: lattice baseline suite report', schema: {
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
  { name: 'authority_status', description: 'Report receipt-aware authority settings and enforce readiness diagnostics without submitting evidence or verifying receipts. Alias: lattice authority status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    authorityMode: z.string().optional().describe('Optional authority mode override for diagnostics only'),
    authorityURL: z.string().optional().describe('Optional authority URL override for diagnostics only'),
    authorityTimeoutMS: z.number().optional().describe('Optional authority timeout override for diagnostics only'),
    storyId: z.string().optional().describe('Optional story id for receipt-ref status lookup'),
    targetPhase: z.string().optional().describe('Optional gate phase for receipt eligibility lookup'),
    phase: z.string().optional().describe('Alias for targetPhase'),
    headHash: z.string().optional().describe('Optional head hash for receipt eligibility lookup'),
    materialHash: z.string().optional().describe('Optional material hash for receipt eligibility lookup'),
    policyMode: z.string().optional().describe('Optional workflow policy profile for receipt eligibility lookup'),
    now: z.string().optional().describe('Optional timestamp for deterministic receipt freshness checks'),
  }},
  { name: 'conduit_status', description: 'Report Lattice conduit status and enforce readiness diagnostics without provisioning a runner or production authority. Alias: lattice conduit status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_explain', description: 'Explain the CLI conduit migration boundary and no-overclaim semantics. Alias: lattice conduit explain', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_export', description: 'Export a Lattice Story as Canonical Story v0 without claiming production authority', schema: {
    storyId: z.string().describe('Story ID to export'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for canonical-story JSON'),
  }},
  { name: 'story_authority_resolve', description: 'Resolve host-neutral story authority (main vs worktree) for every active story without parsing session_brief/status Markdown or promoting local DONE. Alias: lattice story authority resolve', schema: {
    storyIds: z.array(z.string()).optional().describe('Restrict resolution to specific story ids'),
    activeOnly: z.boolean().optional().describe('Default true; pass false to include DONE/DISCARDED stories'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default json for machine consumers)'),
  }},
  { name: 'observability_snapshot', description: 'Build a host-neutral Lattice observability snapshot (authority ladder, story board, capability matrix, recovery, parallel) from story_authority_resolve without claiming production authority. Alias: lattice observability snapshot', schema: {
    storyIds: z.array(z.string()).optional().describe('Restrict snapshot to specific story ids'),
    activeOnly: z.boolean().optional().describe('Default true; pass false to include DONE/DISCARDED stories'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for snapshot JSON; refuses to overwrite'),
  }},
  { name: 'handoff_create', description: 'Create a Lattice handoff pack from one host to another without manufacturing production DONE. Alias: lattice handoff create', schema: {
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
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary carried into the pack'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions for the overflow worker'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for handoff-pack JSON'),
  }},
  { name: 'handoff_inspect', description: 'Inspect a Lattice handoff pack and show capability deltas, degradations, evidence refs, and authority boundary. Alias: lattice handoff inspect', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'handoff_accept', description: 'Accept a Lattice handoff pack as a process-event style projection without changing authority. Alias: lattice handoff accept', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    acceptedByHost: z.string().optional().describe('Accepting host profile id; defaults to the handoff target host'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for accept projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_resume', description: 'Project a resume plan from a handoff pack or accept projection without refreshing evidence or authority. Alias: lattice handoff resume', schema: {
    file: z.string().describe('Handoff pack JSON file or handoff_accept projection JSON file'),
    resumeHost: z.string().optional().describe('Resume host profile id; defaults to acceptedByHost or target host'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for resume projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_receipt_submit', description: 'Validate and accept a local overflow receipt as diagnostic evidence only; never changes authority. Alias: lattice handoff receipt submit', schema: {
    file: z.string().describe('Handoff receipt JSON file'),
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
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary'),
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
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary'),
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
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary'),
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
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary'),
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
    allowedHosts: z.union([z.string(), z.array(z.string())]).describe('Allowed host IDs (fake, claude-code, gemini, codex)'),
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
    allowProductionDone: z.boolean().optional().describe('Allow productionDone; must be false'),
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
  { name: 'dispatch_auto', description: 'Policy-authorized unattended scheduler: reads dispatch_policy_check, enforces maxParallel/host/scope limits, starts deterministic fake workers; real subprocess v1.0.1 is claude-code only with explicit policy opt-in. Alias: lattice dispatch auto', schema: {
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
    authorityBoundary: z.string().optional().describe('Authority boundary statement'),
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
  { name: 'autopilot_policy_create', description: 'Create and persist a named autopilot execution policy without starting workers or claiming authority. Alias: lattice autopilot policy create', schema: {
    policy: z.string().describe('Policy name (alphanumeric, hyphen, underscore; 1-64 chars)'),
    mode: autopilotModeSchema.optional().describe('Autopilot execution mode (default conservative in core policy)'),
    dispatchPolicy: z.string().optional().describe('Underlying dispatch policy name to enforce for worker scheduling'),
    allowAutoDispatch: z.boolean().optional().describe('Allow autopilot to schedule dispatch under policy constraints'),
    allowAutoValidate: z.boolean().optional().describe('Allow autopilot to run validation commands under policy constraints'),
    allowAutoFix: z.boolean().optional().describe('Allow bounded fix retries'),
    allowStoryIntegration: z.boolean().optional().describe('Allow story-branch integration only when core authority gates permit it'),
    allowDoneAdvance: z.boolean().optional().describe('Allow lifecycle DONE advance only when core authority gates permit it'),
    allowMainMerge: z.boolean().optional().describe('Allow main merge only when core authority gates permit it'),
    requireServerReceipt: z.boolean().optional().describe('Require server-authority proof before stronger authority claims'),
    requireServerAuthorityReceipt: z.boolean().optional().describe('Require server-authority proof before stronger authority claims'),
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
  { name: 'autopilot_policy_check', description: 'Check a named autopilot policy without changing authority. Alias: lattice autopilot policy check', schema: {
    policy: z.string().describe('Policy name to check'),
    serverAuthorityReceipt: serverAuthorityReceiptSchema.optional().describe('Optional server-authority proof object or reference to pass through to the core checker'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    output: z.string().optional().describe('Optional file path for autopilot policy check JSON; refuses to overwrite'),
  }},
  { name: 'autopilot_run', description: 'Run a saved autopilot policy for a story while preserving conservative authority boundaries. Alias: lattice autopilot run', schema: {
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
    authorityBoundary: z.string().optional().describe('Authority boundary statement'),
    executionInstructions: stringOrStringArraySchema.optional().describe('Instructions for the worker'),
    parallel: z.number().optional().describe('Worker count, capped by policy'),
    serverAuthorityReceipt: serverAuthorityReceiptSchema.optional().describe('Optional server-authority proof object or reference to pass through to core'),
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
  { name: 'autopilot_resume', description: 'Inspect a persisted autopilot run and refuse unsafe v1 resume while preserving evidence. Alias: lattice autopilot resume', schema: {
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
  { name: 'parallel_wave_create', description: 'Create a Lattice Parallel Wave scheduling projection over Canonical Stories without authority changes', schema: {
    storyIds: z.array(z.string()).optional().describe('Story IDs to include; omit to analyze active stories'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id; defaults to a deterministic id from story refs'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for wave JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_inspect', description: 'Inspect a Lattice Parallel Wave JSON file without refreshing evidence or authority', schema: {
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
  { name: 'doctor', description: 'View Lattice health issues (silent-caught PERSIST fails); scan orphan worktrees', schema: {
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
  { name: 'check', description: 'Check Lattice asset/template drift; --apply/--upgrade sync safe items explicitly', schema: {
    json: z.boolean().optional().describe('Structured JSON output.'),
    apply: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets; does not overwrite CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE.'),
    upgrade: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets to current Lattice templates; equivalent to --apply.'),
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

  // Verifier (Lattice built-in code verification).
  { name: 'validate', description: 'Run project verification (static, logic, and integration tests)', longHelp: VALIDATE_LONG, schema: {
    full: z.union([z.string(), z.boolean()]).optional().describe('Include real-machine tests (--full or --full=PvE to filter by name).'),
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

  // Finding (Lattice reviewer finding).
  { name: 'finding_add', description: 'Add a finding (Lattice reviewer finding)', schema: {
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

  // B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle. Distil a
  // resolved finding into a human-approved candidate playbook. NEVER files findings
  // or touches gates; writes only under .lattice/learning/. Approve fails closed on
  // a stale --expectedProposalDigest (decision-doc pattern); status is candidate, NOT active.
  { name: 'playbook_propose', description: 'Stage a Playbook proposal distilled from a resolved finding (audit-only; never files a finding)', schema: {
    finding: z.string().describe('Source finding id (e.g. B-xxx:F-001) to distil into a playbook proposal.'),
    storyId: z.string().optional().describe('Optional story id; defaults to the prefix parsed from the finding id.'),
  }},
  { name: 'playbook_diff', description: 'Read-only render of the candidate Playbook that approve would write (no mutation)', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to render.'),
  }},
  { name: 'playbook_approve', description: 'Approve a staged proposal into a candidate Playbook (fails closed on a stale digest; never active)', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to approve.'),
    expectedProposalDigest: z.string().describe('Must byte-match the stored proposalDigest; a stale/missing digest fails closed.'),
  }},
  { name: 'playbook_reject', description: 'Discard a staged Playbook proposal', schema: {
    proposalId: z.string().describe('Proposal id (PBP-NNN) to discard.'),
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
  { name: 'learning_validate', description: 'Report Experience Layer referential validity: valid-rate / drift-rate of finding-signals vs HEAD (read-only; advisory; writes nothing)', schema: {
    json: z.boolean().optional().describe('Emit the machine-readable ValidRateReport as JSON.'),
    story: z.string().optional().describe('Restrict derivation to a single story id.'),
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

  // Story dispatch (B-45ed CHK-005: implementer prompt generator)
  { name: 'story_dispatch', description: 'Generate a standard implementer prompt string (main agent dispatches CHK-xxx)', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID, for example CHK-001.'),
    agentType: z.string().optional().describe('subagent type, for example lattice-implementer / lattice-review-channel; CHK-008 will expand matrix.'),
  }},

  // Finding dispatch (B-45ed CHK-010: reviewer-finding repair prompt generator, isomorphic with story_dispatch).
  // B-9d95 CHK-004: deprecated alias; first stdout line prints a deprecation warning and recommends lattice dispatch.
  { name: 'finding_dispatch', description: '[deprecated: use lattice dispatch] Generate reviewer-finding repair prompt', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID, for example F-001 or the full B-xxx:F-xxx form.'),
    agentType: z.string().optional().describe('subagent type, for example lattice-implementer / lattice-review-channel; reuses the CHK-008 grading matrix.'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch merged into lattice dispatch, available in all phases).
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
  { name: 'guard_session_start', description: 'Start (or restart) a Lattice-managed scope-guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    provider: z.string().min(1, 'provider is required').describe('Agent provider runtime (e.g. claude-code, codex). Guard mode depends on provider and context flags.'),
    nativeHookVerified: z.boolean().optional().describe('Set true when the host-native PreToolUse hook is confirmed installed (Claude Code .claude/settings.json or Codex .codex/hooks.json), enabling native-pretool mode.'),
    viaDispatch: z.boolean().optional().describe('(Codex/Gemini only) Set true when running via Lattice dispatch/pre-apply flow, enabling wrapped-preapply mode. Without this, those hosts use watcher-fallback.'),
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
  { name: 'prewrite_guard_check', description: 'Pre-write scope enforcement for Claude Code PreToolUse hooks and Lattice dispatch pre-apply checks', schema: {
    storyId: z.string().optional().describe('Story ID (auto-discovered from active guard sessions when absent)'),
    provider: z.string().optional().describe('Agent provider (informational; used to log who triggered the check)'),
    toolName: z.string().describe('Name of the write-like tool being invoked (e.g. Edit, Write, MultiEdit, NotebookEdit)'),
    toolInputJson: z.string().optional().describe('JSON-encoded tool input from which target paths are extracted (used when targetPaths is absent)'),
    targetPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Explicit target path(s) to evaluate (overrides tool-input extraction)'),
    cwd: z.string().optional().describe('Working directory for resolving relative paths (defaults to project root)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},

  // B-ea92 M1: read-only authority policy discovery.
  // Alias: lattice authority enforce policy → authority_enforce_policy (resolved in runCli).
  { name: 'authority_enforce_policy', description: 'Discover authority policy (GET /v1/authority/policy). Read-only: no receipt, no gate pass, no evidence submission. Alias: lattice authority enforce policy', schema: {
    authorityURL: z.string().optional().describe('Authority server base URL (overrides LATTICE_AUTHORITY_URL)'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout in milliseconds (overrides LATTICE_AUTHORITY_TIMEOUT_MS)'),
  }},
  { name: 'authority_receipt_verify', description: 'Verify an Authority gate_decision proof and write authority-receipt-refs.json only for production-classified receipts. Alias: lattice authority receipt verify', schema: {
    storyId: z.string().describe('Expected story id and story artifact target'),
    phase: z.string().optional().describe('Expected target phase, e.g. TEST or test; defaults to proof input targetPhase'),
    targetPhase: z.string().optional().describe('Alias for phase'),
    headHash: z.string().optional().describe('Expected head hash; defaults to proof input headHash'),
    materialHash: z.string().optional().describe('Expected material hash; defaults to proof input materialHash'),
    authorityURL: z.string().optional().describe('Authority server base URL for proofPath fetch and receipt-ref metadata'),
    proof: z.unknown().optional().describe('Inline proof JSON object or JSON string'),
    proofFile: z.string().optional().describe('Path to proof JSON file'),
    proofPath: z.string().optional().describe('Server-relative proof path to fetch from the Authority server'),
    productionAuthorityKeyDigests: z.union([z.array(z.string()), z.string()]).optional().describe('Pinned production Authority public key digest(s), comma-separated or JSON array'),
    localTestAuthorityKeyDigests: z.union([z.array(z.string()), z.string()]).optional().describe('Known local/test Authority public key digest(s), comma-separated or JSON array'),
    dryRun: z.boolean().optional().describe('Verify and project the ref without writing authority-receipt-refs.json'),
    now: z.string().optional().describe('Verification timestamp override for deterministic tests'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'authority_enforce_runner', description: 'Explicit enforce-only headless runner command. Dry-run projects register/heartbeat/claim without provider execution. Alias: lattice authority enforce runner', schema: {
    once: z.boolean().optional().describe('Claim at most one job'),
    dryRun: z.boolean().optional().describe('Project planned steps without network mutation or provider execution'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
    authorityMode: z.string().optional().describe('Authority mode override; runner treats missing override as enforce'),
    authorityURL: z.string().optional().describe('Authority server base URL override'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout override'),
  }},
  { name: 'authority_receipt_fetch', description: 'Fetch a native Lattice Authority receipt by id and optionally write it to a local JSON file. Alias: lattice authority receipt fetch', schema: {
    receiptId: z.string().describe('Native Authority receipt id to fetch'),
    outputFile: z.string().optional().describe('Optional output JSON file path'),
    authorityURL: z.string().optional().describe('Override LATTICE_AUTHORITY_URL'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_execute', description: 'Execute a bounded unattended Lattice autopilot loop. Local mode runs local Lattice commands, shadow warns on authority readiness, authority fails closed for DONE without a verified receipt. Alias: lattice autopilot execute', schema: {
    mode: z.enum(['local', 'shadow', 'authority']).optional().describe('Autopilot mode: local, shadow, or authority'),
    storyId: z.string().optional().describe('Story ID to bind the autopilot executor to'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase to execute toward'),
    once: z.boolean().optional().describe('Execute a single loop iteration'),
    dryRun: z.boolean().optional().describe('Preview the executor loop without running commands'),
    jobFile: z.string().optional().describe('Claimed Authority job JSON file carrying typed plannedSteps[]; consumed through the bounded executor instead of local argv synthesis. Authority DONE still requires a verified native gate_decision receipt.'),
    maxSteps: z.number().optional().describe('Maximum planned steps to execute (default 20)'),
    requireMultiHost: z.boolean().optional().describe('Require independent host verdict certification before final DONE execution'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts when multi-host review is required'),
    maxReviewWaves: z.number().optional().describe('Maximum bounded multi-host review waves'),
    allowClaudeRepair: z.boolean().optional().describe('Allow a bounded Claude Code CLI repair attempt when an execution step fails'),
    claudeCommand: z.string().optional().describe('Claude Code CLI executable for repair attempts (default claude)'),
    claudePermissionMode: z.string().optional().describe('Optional Claude Code CLI --permission-mode value for repair attempts'),
    maxRepairAttempts: z.number().optional().describe('Maximum Claude repair attempts per failed step when allowClaudeRepair=true'),
    commandTimeoutMS: z.number().optional().describe('Timeout for each Lattice executor command in milliseconds'),
    claudeTimeoutMS: z.number().optional().describe('Timeout for each Claude repair command in milliseconds'),
    authorityURL: z.string().optional().describe('Authority server base URL override'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout override'),
    receiptFile: z.string().optional().describe('Signed authority receipt JSON file for authority DONE verification'),
    authorityPublicKey: z.string().optional().describe('Legacy base64 subject-receipt public key; does not satisfy native authority DONE'),
    receiptSubjectId: z.string().optional().describe('Legacy expected subjectId; does not satisfy native authority DONE'),
    receiptSubjectKind: z.string().optional().describe('Legacy expected subjectKind; does not satisfy native authority DONE'),
    serverPublicKey: z.string().optional().describe('Native Lattice Authority Ed25519 server public key, hex by default'),
    serverPublicKeyEncoding: z.enum(['hex', 'base64', 'auto']).optional().describe('Encoding of serverPublicKey (default auto)'),
    serverKeyId: z.string().optional().describe('Expected native Lattice Authority serverKeyId'),
    receiptKind: z.string().optional().describe('Expected native receipt kind, e.g. gate_decision'),
    receiptProjectId: z.string().optional().describe('Expected native receipt projectId'),
    receiptStoryId: z.string().optional().describe('Expected native receipt storyId'),
    expectedDecisionDigest: z.string().optional().describe('Expected native gate decisionDigest'),
    receiptMaxAgeMs: z.number().optional().describe('Maximum native receipt age in milliseconds'),
    receiptClockSkewMs: z.number().optional().describe('Allowed native receipt clock skew in milliseconds'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_doctor', description: 'Diagnose local and authority autopilot readiness while confirming local autopilot remains usable. Alias: lattice autopilot doctor', schema: {
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_draft', description: 'Create a structured Lattice planner draft from a natural-language request. Alias: lattice planner draft', schema: {
    request: z.string().optional().describe('One sentence or paragraph request'),
    requestFile: z.string().optional().describe('Request document path'),
    interactionMode: z.enum(['autonomous', 'interview', 'decision-gated']).optional().describe('Planner interaction mode (default autonomous)'),
    mode: z.enum(['local', 'authority']).optional().describe('Execution mode for the generated plan'),
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
    allowUnattendedPlanning: z.boolean().optional().describe('Allow unattended Story/job creation for authority mode'),
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
  { name: 'planner_create_story', description: 'Create a Lattice Story from a reviewed planner draft. Alias: lattice planner create-story', schema: {
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    forceNew: z.boolean().optional().describe('Force a new Story through the planner-controlled path'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'planner_create_job', description: 'Create a local run plan or unsigned Authority job-create envelope with typed plannedSteps. Alias: lattice planner create-job', schema: {
    storyId: z.string().optional().describe('Story id'),
    draftFile: z.string().optional().describe('Planner draft JSON file'),
    runId: z.string().optional().describe('Planner run id'),
    projectId: z.string().optional().describe('Authority project id'),
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
    mode: z.enum(['local', 'authority']).optional().describe('Execution mode'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase'),
    workflow: z.enum(['standard', 'source-aligned-redevelopment', 'source_aligned_redevelopment']).optional().describe('Development workflow'),
    projectId: z.string().optional().describe('Authority project id'),
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
  { name: 'autopilot_review_submit', description: 'Submit a local non-authority host verdict with identity/material bindings for review escalation. Alias: lattice autopilot review submit', schema: {
    verdictFile: z.string().optional().describe('Verdict JSON file'),
    storyId: z.string().optional().describe('Story id'),
    runId: z.string().optional().describe('Local run id'),
    hostId: z.string().optional(),
    provider: z.string().optional(),
    sessionId: z.string().optional(),
    keyId: z.string().optional(),
    decision: z.enum(['pass', 'fail', 'blocked']).optional(),
    materialDigest: z.string().optional(),
    validationDigest: z.string().optional(),
    promptDigest: z.string().optional(),
    note: z.string().optional(),
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
  { name: 'authority_verdict_submit', description: 'Submit an Authority-mode independent host verdict record. Server-backed when authority mode + URL are configured (enforces receipt-before-verdict ordering); otherwise local storage. Alias: lattice authority verdict submit', schema: {
    verdictFile: z.string().optional().describe('Verdict JSON file (full §X9 host-verdict record)'),
    jobId: z.string().optional().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    storyId: z.string().optional().describe('Story id the verdict certifies (server-backed claim)'),
    hostId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional().describe('Verifier model id'),
    role: z.enum(['implementer', 'verifier', 'reviewer']).optional().describe('Host role (default verifier)'),
    sessionId: z.string().optional(),
    keyId: z.string().optional(),
    reviewWaveId: z.string().optional().describe('Review wave id'),
    decision: z.enum(['pass', 'fail', 'blocked']).optional(),
    materialDigest: z.string().optional(),
    validationDigest: z.string().optional(),
    gateInputDigest: z.string().optional().describe('checkedGateInputDigest of the receipt-backed run (required server-backed)'),
    receiptId: z.string().optional().describe('checkedReceiptId of the verified gate_decision receipt (required server-backed; receipt-before-verdict ordering)'),
    promptProfile: z.string().optional().describe('Final host-check prompt profile; defaults to lattice-final-host-check-v1 for server-backed Authority verdicts'),
    promptDigest: z.string().optional(),
    artifactDigest: z.string().optional().describe('Digest of the review artifact checked by this verifier (required server-backed)'),
    note: z.string().optional(),
    authorityURL: z.string().optional().describe('Override LATTICE_AUTHORITY_URL'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'authority_job_create', description: 'Submit a planner JobPlan as a signed queued job to Lattice Authority. Alias: lattice authority job create', schema: {
    jobPlanFile: z.string().optional().describe('JobPlan JSON file produced by lattice planner run/create-job'),
    runId: z.string().optional().describe('Planner run id with a persisted jobPlan'),
    provider: z.enum(['codex', 'claude-code', 'gemini']).optional().describe('Authority provider for the queued job; required unless the JobPlan explicitly opts into a real provider'),
    role: z.enum(['planner', 'implementer', 'reviewer', 'explorer', 'tester']).optional().describe('Authority job role (default implementer)'),
    promptRef: z.string().optional().describe('Prompt reference recorded in the server job'),
    promptHash: z.string().optional().describe('Prompt hash recorded in the server job'),
    cwd: z.string().optional().describe('Working directory recorded in the server job'),
    canWrite: z.boolean().optional().describe('Whether the queued job may write files (default false)'),
    canRunShell: z.boolean().optional().describe('Whether the queued job may run shell commands (default true)'),
    mutatesStory: z.boolean().optional().describe('Whether the server should treat this as a mutating story job (default false)'),
    authorityURL: z.string().optional().describe('Override LATTICE_AUTHORITY_URL'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'authority_verdict_list', description: 'Summarize Authority independent host verdicts. Server-backed when authority mode + URL are configured; otherwise local storage. Alias: lattice authority verdict list', schema: {
    jobId: z.string().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    requiredHosts: z.number().optional().describe('Required independent passing hosts'),
    authorityURL: z.string().optional().describe('Override LATTICE_AUTHORITY_URL'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'authority_job_status', description: 'Summarize Authority job host-verdict status without minting or replacing native receipts. fullAuthorityDone requires a verified per-run gate_decision receipt (pass --receiptFile) plus a satisfied independent-host reconciliation. Alias: lattice authority job status', schema: {
    jobId: z.string().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    requiredHosts: z.number().optional().describe('Required independent passing hosts'),
    disagreementBehavior: z.enum(['block', 'repair_then_reverify']).optional().describe('§X9 disagreement protocol (shapes recommended nextAction; default block)'),
    receiptFile: z.string().optional().describe('Native gate_decision receipt JSON for the run (verified to prove per-run authorityDone; anchors the fresh review wave)'),
    receiptProjectId: z.string().optional().describe('Expected receipt projectId binding'),
    receiptStoryId: z.string().optional().describe('Expected receipt storyId binding'),
    serverKeyId: z.string().optional().describe('Expected receipt serverKeyId binding'),
    expectedDecisionDigest: z.string().optional().describe('Expected receipt decisionDigest binding'),
    gateInputDigest: z.string().optional().describe('Expected receipt inputDigest / checked gate input digest binding'),
    authorityURL: z.string().optional().describe('Override LATTICE_AUTHORITY_URL'),
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
    storyId: z.string().optional().describe('Active story ID, for example B-xxx; omitted value is inferred automatically from the active story branch; optional outside Lattice sessions.'),
    storyDir: z.string().optional().describe('Story directory root path (default <root>/.lattice/story/actives; legacy .koala/story/actives remains readable).'),
    query: z.string().optional().describe('Optional relevance filter query.'),
    scope: z.enum(['global']).optional().describe('When storyId is omitted: global=promote project lessons to global dev-memory; even inside an active story, do not write story candidates.'),
  }},
  { name: 'dev_memory_start', description: 'Start a dev-memory session wrapper', schema: {
    agent: z.string().optional().describe('Agent name, such as claude/codex; display only, does not start an external process.'),
    query: z.string().optional().describe('Preflight relevance query.'),
    maxEntries: z.number().optional().describe('Maximum number of preflight entries (default 5).'),
    dryRun: z.boolean().optional().describe('Compatibility parameter; always dry-run mode (does not start an external process).'),
  }},

];

/**
 * Runtime tool list: assigned when runCli() starts, including main built-ins plus extras.
 * After that, all helpers (printHelp, dispatch lookup, and others) access tools through this variable,
 * and do not reference MAIN_TOOLS directly.
 */
let TOOLS: ToolDef[] = MAIN_TOOLS;

// ── Phase detection ──

interface ActiveStory { storyId: string; phase: string; }

/**
 * Detect active story from the git branch name.
 * Branch format: story/B-xxxx maps to storyId = B-xxxx.
 * Return null for non-story branches (all commands available).
 */
function detectActiveStory(root: string): ActiveStory | null {
  const gitCwd = root;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!branch.startsWith('story/')) return null;
    const storyId = branch.slice('story/'.length);
    if (!storyId) return null;
    const store = new StoryStore(root);
    try {
      const story = store.readStory(storyId);
      return { storyId, phase: story.phase };
    } catch {
      // Story file does not exist, so do not filter.
      return null;
    }
  } catch {
    // Not a git directory or another error, so do not filter.
    return null;
  }
}

// ── Help ──

function describeType(t: ZodType): string {
  if (t instanceof ZodOptional) return describeType((t as any)._def.innerType);
  if (t instanceof ZodString) return 'string';
  if (t instanceof ZodNumber) return 'number';
  if (t instanceof ZodBoolean) return 'boolean';
  if (t instanceof ZodEnum) return ((t as any).options || []).join('|');
  if (t instanceof ZodArray) return 'array';
  if (t instanceof ZodObject) return 'object';
  if (t instanceof ZodUnion) return 'string|array';
  return 'any';
}

function getDesc(t: ZodType): string {
  return (t as any).description || '';
}

function unwrapOptional(t: ZodType): ZodType {
  return t instanceof ZodOptional ? (t as any)._def.innerType : t;
}

function objectShape(t: ZodObject<any>): Record<string, ZodType> {
  const anyType = t as any;
  const shape = anyType.shape ?? anyType._def?.shape;
  return typeof shape === 'function' ? shape() : shape || {};
}

function arrayElement(t: ZodArray<any>): ZodType | null {
  const anyType = t as any;
  return anyType.element || anyType._def?.type || null;
}

function nestedSchemaLines(t: ZodType, prefix: string, indent = '      '): string[] {
  const inner = unwrapOptional(t);
  if (inner instanceof ZodArray) {
    const element = arrayElement(inner);
    if (!element) return [];
    const elementInner = unwrapOptional(element);
    if (elementInner instanceof ZodObject) {
      return nestedSchemaLines(elementInner, `${prefix}[]`, indent);
    }
    return [`${indent}${prefix}[]: ${describeType(elementInner)} ${getDesc(elementInner)}`.trimEnd()];
  }
  if (!(inner instanceof ZodObject)) return [];
  const shape = objectShape(inner);
  const lines: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const optional = child instanceof ZodOptional;
    const childInner = unwrapOptional(child);
    const path = prefix ? `${prefix}.${key}` : key;
    lines.push(`${indent}${path}${optional ? '?' : ''}: ${describeType(child)} ${getDesc(child)}`.trimEnd());
    if (childInner instanceof ZodObject || childInner instanceof ZodArray) {
      lines.push(...nestedSchemaLines(childInner, path, indent + '  '));
    }
  }
  return lines;
}

type HelpOutputOptions = {
  stream?: { write(chunk: string): unknown };
  includeFooter?: boolean;
};

function normalizeHelpText(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * @task B-e3d9
 * @checklist CHK-002
 * @title derive supportsDryRun help from live schema and command policy
 * @type refactor
 * @priority high
 * @description
 *   The abandoned cc-learnings supportsDryRun field is not the main CLI
 *   contract. Real dry-run behavior already lives in ToolDef schema flags
 *   (`dryRun` / `confirm`), command descriptions, and COMMAND_POLICIES
 *   operator-safety prose. Help derives the surfaced contract from those live
 *   inputs so we do not create a second supportsDryRun registry.
 * @changes
 *   - [CHK-002] Summarize supportsDryRun-equivalent behavior in lattice <command> --help
 *   - [CHK-002] Keep dry-run truth derived from schema/policy instead of speculative metadata
 * @test dangerous-command-guardrails
 */
function dryRunHelpLine(tool: ToolDef, policy?: CommandPolicy): string | null {
  const toolDescription = normalizeHelpText(tool.description);
  const policyReason = normalizeHelpText(policy?.reason);
  const policyReplacement = normalizeHelpText(policy?.replacement);
  const dryRunField = tool.schema.dryRun;
  const dryRunDescription = dryRunField ? normalizeHelpText(getDesc(dryRunField)) : '';
  const combined = [toolDescription, dryRunDescription, policyReason, policyReplacement]
    .filter(Boolean)
    .join(' ');
  const hasConfirmFlag = Object.prototype.hasOwnProperty.call(tool.schema, 'confirm');

  if (dryRunField) {
    if (/始终为 dry-run|always[- ]on|always dry[- ]run/i.test(combined)) {
      return `  Dry-run: always-on. ${dryRunDescription || 'This command is projection-only and never executes the side-effect path.'}`;
    }
    if (/默认 dry run|默认 dry-run|default dry run|default dry-run|默认 true/i.test(combined)) {
      return `  Dry-run: default-on via --dryRun=true. ${dryRunDescription || 'Pass --dryRun=false to execute the real path.'}`;
    }
    const confirmNote = hasConfirmFlag ? ' Real execution may also require --confirm.' : '';
    return `  Dry-run: optional via --dryRun. ${dryRunDescription || 'Preview the command without executing the real path.'}${confirmNote}`;
  }

  if (/dry[- ]run/i.test(combined)) {
    return '  Dry-run: always-on. This command only projects guidance and does not execute the side-effect path.';
  }

  return null;
}

/**
 * Returns a multi-line help block describing the `--takeover` / `--forceTakeover`
 * meta options for owner-gated CLI commands, or `null` for commands that are
 * not owner-gated (readOnly / reviewerWrite / mainSharedMutating).
 *
 * Owner-gated means `storyScopedMutating` or `dangerousMutating` — the gate in
 * `enforceStoryOwnerLeaseGate` checks both. `validate` is statically classified
 * `storyScopedMutating` so the block is shown, with a note that it only applies
 * when `--story` is supplied (boundary rule 2 downgrades it to readOnly without
 * a story argument).
 *
 * Exported so contract tests can assert the block is present for gated commands
 * and absent for read-only / reviewer-lane commands without spawning a subprocess.
 */
export function ownerLeaseHelpBlock(cmd: string): string | null {
  const policy = getCommandPolicy(cmd);
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  const cls = policy.ownershipClass;
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') return null;
  // storyScopedMutating or dangerousMutating — owner-gated.
  const note = cmd === 'validate'
    ? ' (applies when --story is supplied; diagnostic validate without --story is always read-only)'
    : '';
  return [
    ``,
    `  Owner lease meta options${note}:`,
    `    --takeover          recover a stale foreign lease (no heartbeat for 30+ min)`,
    `    --forceTakeover     seize an active foreign lease (deliberate human override; also transfers stale)`,
  ].join('\n');
}

function printToolHelp(tool: ToolDef, options: HelpOutputOptions = {}) {
  const brand = detectLatticeBrand();
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;
  const policy = getCommandPolicy(tool.name);
  const dryRunLine = dryRunHelpLine(tool, policy);

  out(`\n  ${brand.primaryBin} ${tool.name} — ${tool.description}\n`);
  out(`  ${formatLatticeProductLine(brand)}\n`);

  // If longHelp exists for a core command, print the full prompt first.
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    out('  No arguments\n');
    out(`  Usage: ${brand.primaryBin} ${tool.name}`);
    if (dryRunLine) out(dryRunLine);
    const ownerBlock = ownerLeaseHelpBlock(tool.name);
    if (ownerBlock) out(ownerBlock);
    if (includeFooter) out(SESSION_BRIEF_FOOTER);
    return;
  }
  out('  Arguments:');
  const maxN = Math.max(...entries.map(([k]) => k.length));
  for (const [name, type] of entries) {
    const opt = type instanceof ZodOptional;
    const req = opt ? '' : ' *';
    const inner = type instanceof ZodOptional ? (type as any)._def.innerType : type;
    const isComplex = inner instanceof ZodArray || inner instanceof ZodObject;
    const flagHint = isComplex ? '(JSON)' : '';
    out(`    --${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req} ${flagHint}`);
    if (isComplex) {
      for (const line of nestedSchemaLines(type, name)) out(line);
    }
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const optional = entries.filter(([, t]) => t instanceof ZodOptional);
  const reqParts = required.map(([k]) => `--${k}=value`);
  const optParts = optional.map(([k]) => {
    const inner = (entries.find(([n]) => n === k)?.[1] as any);
    const base = inner instanceof ZodOptional ? (inner as any)._def.innerType : inner;
    return base instanceof ZodBoolean ? `[--${k}]` : `[--${k}=value]`;
  });
  out(`\n  Usage: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  out('  (* = required)');
  if (dryRunLine) out(dryRunLine);
  const ownerBlock = ownerLeaseHelpBlock(tool.name);
  if (ownerBlock) out(ownerBlock);
  if (includeFooter) out(SESSION_BRIEF_FOOTER);
}

function formatValidationIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `  ${path}: ${issue.message}`;
}

function printValidationFailure(tool: ToolDef, issues: z.ZodIssue[]) {
  const lines = issues.map(formatValidationIssue);
  process.stderr.write('Argument validation failed:\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
  printToolHelp(tool, { stream: process.stderr, includeFooter: false });
  process.stderr.write('\nArgument validation failed (summary):\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
}

function printHelp(activeStory?: ActiveStory | null) {
  const brand = detectLatticeBrand();
  console.log(`\n  ${formatLatticeProductLine(brand)} — CLI-first project workflow and host migration surface\n`);
  console.log(`  Entrypoint: ${brand.primaryBin}\n`);
  console.log(`  Usage: ${brand.primaryBin} <command> --key=value         Run command`);
  console.log(`        ${brand.primaryBin} <command> --help              View arguments`);
  console.log(`        ${brand.primaryBin} help                          Show this help`);
  console.log(`        ${brand.primaryBin} --version                     Show version`);
  console.log(`        ${brand.primaryBin} --root <path> ...             Specify project root directory\n`);

  if (activeStory) {
    console.log(`  Current Story: ${activeStory.storyId}  phase: ${activeStory.phase}\n`);
  }

  const config = loadConfig();
  const phaseTools = config.phaseTools;

  // Known prefix maps to display group name (special cases first).
  const KNOWN_GROUP: Record<string, string> = {
    story: 'Story',
    checklist: 'Checklist',
    bug: 'Bug',
    test: 'Test',
    validate: 'Validate',
    status: 'Status',
    serve: 'Serve',
    aux: 'Aux',
    evaluate: 'Evaluate',
    dashboard: 'Session',
    session: 'Session',
    audit: 'Audit',
    check: 'Check',
    release: 'Release',
    host: 'Host',
    lattice: 'Lattice',
    rollout: 'Lattice',
    authority: 'Authority',
    conduit: 'Conduit',
  };
  // Display order for known groups; groups not in the list (from extras) are appended alphabetically.
  const KNOWN_ORDER = ['Host', 'Lattice', 'Authority', 'Conduit', 'Story', 'Review', 'Checklist', 'Grill', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Check', 'Serve', 'Session', 'Aux', 'Audit'];

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    // When an active story exists, list only commands available in the current phase.
    if (activeStory && !isCommandAllowed(t.name, activeStory.phase, phaseTools)) continue;
    const p = t.name.split('_')[0];
    let g: string;
    if (t.name === 'story_review' || t.name === 'story_review_dismiss') g = 'Review';
    else if (KNOWN_GROUP[p]) g = KNOWN_GROUP[p];
    else g = p.charAt(0).toUpperCase() + p.slice(1); // Unknown prefix: capitalize first letter.
    (groups[g] = groups[g] || []).push(t);
  }
  const filteredTools = activeStory ? TOOLS.filter(t => isCommandAllowed(t.name, activeStory.phase, phaseTools)) : TOOLS;
  const maxN = Math.max(...filteredTools.map(t => t.name.length), 0);

  const presentGroups = Object.keys(groups);
  const orderedGroups = [
    ...KNOWN_ORDER.filter(g => groups[g]),
    ...presentGroups.filter(g => !KNOWN_ORDER.includes(g)).sort(),
  ];
  for (const g of orderedGroups) {
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  Development flow:
    ── PLAN ──
    1. lattice story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"what to do","context":"context"}]}'
    2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # Create local worktree/local branch
    3. cd .worktrees/B-xxx
    4. lattice story_review --storyId=B-xxx                     # Review passes, then enter DEV
    5. lattice story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. Implement the code and its verification (fixtures, project-native tests, or optional validate.ts)
    7. lattice validate                                         # Verification (auto-detect by project language or read config)
    8. lattice checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # Enter code review
   10. Lattice reviewer reviews code and raises findings       # critical/high must resolve

    ── TEST → DONE ──
   11. lattice story_advance --storyId=B-xxx --phase=TEST
   12. lattice story_advance --storyId=B-xxx --phase=DONE     # Merge back to local main and clean worktree

  Parallelism and branch discipline:
    Lattice parallel development uses only local git worktrees plus local branches; do not create or push GitHub/origin feature branches.
    If remote publishing is needed, first let DONE merge back to local main, confirm main is clean, then a human explicitly runs lattice release_approve_push --confirm, and then manually runs git push origin main.

  Initialize a new project:
    lattice init                          # Initialize Lattice project state in the current directory

  Tip: use --key=value for simple arguments; use JSON format for complex arguments (array/object).
  Error? Use lattice <command> --help to view complete argument help.
`);
}

// ── Flag parser ──

/** Test entrypoint: accepts a JSON-described schema (string/number/boolean/array/object) and converts it to Zod internally. */
export function parseFlagsTest(rawArgs: string[], schemaDesc: Record<string, string>): Record<string, unknown> {
  const schema: Record<string, ZodType> = {};
  for (const [k, v] of Object.entries(schemaDesc)) {
    if (v === 'number') schema[k] = z.number();
    else if (v === 'boolean') schema[k] = z.boolean().optional();
    else if (v === 'array') schema[k] = z.array(z.string());
    else if (v === 'object') schema[k] = z.object({}).passthrough();
    else schema[k] = z.string();
  }
  return parseFlags(rawArgs, schema);
}

function normalizeFlagKey(key: string, schema: Record<string, ZodType>): string {
  if (schema[key]) return key;
  const camelKey = key.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
  return schema[camelKey] ? camelKey : key;
}

export function parseFlags(rawArgs: string[], schema: Record<string, ZodType>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const arrayKeys = new Set(
    Object.entries(schema).filter(([, t]) => {
      const inner = t instanceof ZodOptional ? (t as any)._def.innerType : t;
      return inner instanceof ZodArray;
    }).map(([k]) => k),
  );

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg.startsWith('--')) {
      // --key=value or --key value or --flag (boolean)
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const key = normalizeFlagKey(arg.slice(2, eqIdx), schema);
        const val = arg.slice(eqIdx + 1);
        addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
      } else {
        const key = normalizeFlagKey(arg.slice(2), schema);
        // Next argument is not a flag, so treat it as the value.
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          addValue(result, key, coerce(rawArgs[i + 1], schema[key]), arrayKeys.has(key));
          i++;
        } else {
          // bare --flag → true
          result[key] = true;
        }
      }
    } else if (arg.includes('=') && !arg.startsWith('{')) {
      // key=value without -- prefix, compatible with legacy format.
      const eqIdx = arg.indexOf('=');
      const key = normalizeFlagKey(arg.slice(0, eqIdx), schema);
      const val = arg.slice(eqIdx + 1);
      addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
    }
    // Ignore unrecognized positional arguments.
    i++;
  }
  return result;
}

export function coerce(val: string, schemaDef?: ZodType): unknown {
  // JSON object/array
  if ((val.startsWith('{') || val.startsWith('[')) && val.length > 1) {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  // boolean
  if (val === 'true') return true;
  if (val === 'false') return false;
  // number (only if schema expects it)
  const inner = schemaDef instanceof ZodOptional ? (schemaDef as any)._def.innerType : schemaDef;
  if (inner instanceof ZodNumber && /^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val;
}

export function addValue(obj: Record<string, unknown>, key: string, val: unknown, isArray: boolean) {
  if (isArray) {
    if (!Array.isArray(obj[key])) obj[key] = obj[key] !== undefined ? [obj[key]] : [];
    if (Array.isArray(val)) {
      (obj[key] as unknown[]).push(...val);
    } else {
      (obj[key] as unknown[]).push(val);
    }
  } else {
    obj[key] = val;
  }
}

const STRICT_OWNER_META_COMMANDS = new Set([
  'autopilot_run',
  'autopilot_cancel',
  'autopilot_resume',
]);

const CLI_META_SCHEMA = {
  takeover: z.boolean().optional(),
  forceTakeover: z.boolean().optional(),
};

function isAutopilotCommand(cmd: string): boolean {
  return cmd.startsWith('autopilot_');
}

function validationSchemaForCommand(cmd: string, tool: ToolDef): z.ZodObject<Record<string, ZodType>> {
  const schemaWithCliMeta = { ...tool.schema, ...CLI_META_SCHEMA };
  if (isAutopilotCommand(cmd)) {
    const schema = STRICT_OWNER_META_COMMANDS.has(cmd) ? schemaWithCliMeta : tool.schema;
    return z.object(schema).strict();
  }
  return z.object(schemaWithCliMeta);
}

// ── Resolve root ──

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LATTICE_PROJECT_ROOT) return process.env.LATTICE_PROJECT_ROOT;
  // Walk upward to find lattice.config.json and determine the project root.
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: git worktree root
  const commonDir = gitProbe('git rev-parse --git-common-dir');
  if (commonDir.ok) {
    const cd = commonDir.output;
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      const wtList = gitProbe('git worktree list --porcelain');
      if (wtList.ok) {
        return wtList.output.split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
      }
    }
  }
  return process.cwd();
}

function resolveMainRootFromWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/i);
    if (!m) return null;
    const gitdir = m[1].trim();
    const absGitdir = gitdir.startsWith('/') ? gitdir : join(root, gitdir);
    const marker = `${join('.git', 'worktrees')}`;
    const normalized = absGitdir.replace(/\\/g, '/');
    const markerNormalized = marker.replace(/\\/g, '/');
    const idx = normalized.indexOf(`/${markerNormalized}/`);
    if (idx === -1) return null;
    return normalized.slice(0, idx);
  } catch {
    return null;
  }
}

function resolveRootForCommand(cmd: string, explicit?: string): string {
  const root = resolveRoot(explicit);
  if (cmd !== 'story_discard') return root;
  return resolveMainRootFromWorktreeRoot(root) || root;
}

// ── Activity log filter ──

/**
 * Read-only commands that should NOT write activity.jsonl by default.
 * These are pure queries / status checks — logging them pollutes
 * the audit trail and can cause DONE dirty-self-block (B-c622).
 * Codex wrapper sessions opt in because session_brief is their primary
 * cross-session tracking heartbeat.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'session_brief',
  'next',
  'done_closure',
  'status',
  'story_get',
  'story_list',
  'checklist_get',
  'finding_list',
  'bug_list',
  'test_list',
  'aux_doc_list',
  'capability_list',
  'capability_probe',
  'agent_prompt',
  'baseline_run',
  'baseline_suite',
  'baseline_suite_report',
  'capability_claim_evaluate',
  'capability_claim_formal_evaluate',
  'memory_benchmark_run',
  'memory_benchmark_compare',
  'memory_benchmark_real_data',
  'host_list',
  'host_probe',
  'host_status',
  'host_runtime_list',
  'host_runtime_probe',
  'host_install',
  'lattice_config_doctor',
  'rollout_check',
  'baseline_suite_report',
  'authority_status',
  'conduit_status',
  'conduit_explain',
  'story_export',
  'story_authority_resolve',
  'observability_snapshot',
  'handoff_create',
  'handoff_inspect',
  'handoff_accept',
  'handoff_resume',
  'handoff_receipt_submit',
  'handoff_worktree_create',
  'host_dispatch',
  'dispatch_plan',
  'dispatch_status',
  'dispatch_list',
  'dispatch_review',
  'dispatch_merge_plan',
  'evidence_manifest',
  'evidence_inspect',
  'parallel_wave_create',
  'parallel_wave_inspect',
  'parallel_plan',
  'parallel_dispatch',
  'parallel_status',
  'parallel_merge_queue',
  'parallel_report',
  'grill_get',
  'reviewer_list',
  'review_incremental_context',
  'workflow_explain',
  'help',
  'authority_enforce_policy',
  'authority_enforce_runner',
  'dispatch_policy_get',
  'dispatch_policy_check',
  'dispatch_watch',
  'autopilot_policy_get',
  'autopilot_policy_check',
  'autopilot_status',
  'autopilot_watch',
  'autopilot_review',
]);

function inferCodexEntrypoint(): string {
  if (process.env.LATTICE_CODEX_ENTRYPOINT) return process.env.LATTICE_CODEX_ENTRYPOINT;
  const invoked = process.argv[1] || '';
  if (invoked.includes('lattice-codex')) return 'local-wrapper';
  if (process.env.LATTICE_ACTIVITY_SOURCE === 'codex') return 'global-fallback';
  return 'cli';
}

const AUTOPILOT_RUN_OWNER_GATED_COMMANDS = new Set([
  'autopilot_cancel',
  'autopilot_resume',
]);

function safeAutopilotRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export function storyIdFromAutopilotRunId(projectRoot: string, args: Record<string, unknown>): string | null {
  const runId = safeAutopilotRunId(args.runId ?? args.autopilotId);
  if (!runId) return null;
  const file = [
    join(projectRoot, LATTICE_DIR, 'autopilot-runs', runId, 'run.json'),
    join(projectRoot, LEGACY_KOALA_DIR, 'autopilot-runs', runId, 'run.json'),
  ].find((candidate) => existsSync(candidate));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { storyId?: unknown };
    return typeof parsed.storyId === 'string' && parsed.storyId.trim()
      ? parsed.storyId.trim()
      : null;
  } catch {
    return null;
  }
}

function storyIdFromArgs(
  args: Record<string, unknown>,
  activeStory?: ActiveStory | null,
  context?: { command?: string; projectRoot?: string },
): string | null {
  if (typeof args.storyId === 'string' && args.storyId.trim()) return args.storyId.trim();
  if (typeof args.story === 'string' && args.story.trim()) return args.story.trim();
  if (
    context?.command &&
    context.projectRoot &&
    AUTOPILOT_RUN_OWNER_GATED_COMMANDS.has(context.command)
  ) {
    const runStoryId = storyIdFromAutopilotRunId(context.projectRoot, args);
    if (runStoryId) return runStoryId;
  }
  return activeStory?.storyId || null;
}

/**
 * B-c55d CHK-002: resolve the EFFECTIVE ownership class of a single command
 * invocation.
 *
 * The static `CommandPolicy.ownershipClass` is the base classification; this
 * function applies the four dynamic boundary rules from
 * session-ownership-and-write-leases.md (and the story plan) that depend on the
 * actual invocation arguments:
 *
 *  1. `finding_resolve` / `finding_dismiss` — `storyScopedMutating` for a normal
 *     story, but `mainSharedMutating` when the target is a B-META story (the
 *     B-f60c main write lock serializes those; `finding.ts` already routes the
 *     write through `withMetaFindingLock`). So a B-META finding mutation must
 *     NOT be owner-lease-gated.
 *  2. `validate` — `storyScopedMutating` only when `--story` is supplied (it
 *     then writes story TEST/DONE gate evidence). A diagnostic `validate` with
 *     no `--story` mutates no story state → downgraded to `readOnly`.
 *  3. `delivery_check_set` — `reviewerWrite` only when the resolved actor is
 *     `lattice-review-delivery`; any other caller is treated as
 *     `storyScopedMutating` so a main agent cannot borrow it to bypass the
 *     owner lease.
 *  4. `dev_memory_finish --scope=global` with no explicit story target is
 *     `mainSharedMutating`: it promotes non-authoritative project memory to
 *     global memory and must not be owner-lease-gated by the active story.
 *
 * Returns `null` when the command has no policy entry OR its `ownershipClass`
 * is not a valid enum value — the gate treats `null` as FAIL-CLOSED (an
 * unclassified command is rejected, never default-allowed).
 */
export function resolveEffectiveOwnershipClass(
  cmd: string,
  args: Record<string, unknown>,
  storyId: string | null,
): OwnershipClass | null {
  const policy = getCommandPolicy(cmd);
  // Runtime enum re-validation (CLAUDE.md Handler coding convention): a missing policy
  // OR a policy whose `ownershipClass` is not a valid enum value is fail-closed.
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  let cls: OwnershipClass = policy.ownershipClass;

  // Boundary rule 1: a B-META finding mutation is mainSharedMutating.
  if ((cmd === 'finding_resolve' || cmd === 'finding_dismiss') && storyId && storyId.startsWith('B-META-')) {
    cls = 'mainSharedMutating';
  }

  // Boundary rule 2: a diagnostic `validate` without --story is readOnly.
  if (cmd === 'validate') {
    const hasStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    cls = hasStory ? 'storyScopedMutating' : 'readOnly';
  }

  // Boundary rule 3: delivery_check_set is reviewerWrite ONLY for the delivery
  // reviewer actor; any other caller is owner-gated as storyScopedMutating.
  if (cmd === 'delivery_check_set') {
    cls = isDeliveryReviewerActor(args) ? 'reviewerWrite' : 'storyScopedMutating';
  }

  // Boundary rule 4: global dev-memory promotion is a main shared metadata write.
  if (cmd === 'dev_memory_finish') {
    const hasExplicitStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    if (!hasExplicitStory && args.scope === 'global') {
      cls = 'mainSharedMutating';
    }
  }

  return cls;
}

/**
 * B-c55d CHK-002: whether a `delivery_check_set` invocation is acting AS the
 * delivery reviewer (`lattice-review-delivery`).
 *
 * The actor is resolved from the explicit `agentId` argument first, then the
 * `LATTICE_AGENT` environment variable — the same precedence the
 * `delivery_check_set` handler records into `delivery-check.json`. Only the
 * exact `lattice-review-delivery` lane qualifies for the reviewerWrite exemption;
 * a main agent (or any other agent id) does NOT, so it cannot borrow
 * `delivery_check_set` to bypass the owner lease.
 *
 * NOTE: this only decides the owner-lease exemption. The delivery evidence's
 * own signature / phase rules are still enforced inside `delivery_check_set`
 * and by the TEST→DONE delivery-check gate — the exemption is never a free
 * pass to write.
 */
export function isDeliveryReviewerActor(args: Record<string, unknown>): boolean {
  const explicit = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  const env = typeof process.env.LATTICE_AGENT === 'string' ? process.env.LATTICE_AGENT.trim() : '';
  const actor = explicit || env;
  return actor === 'lattice-review-delivery';
}

/**
 * B-c55d CHK-003: the takeover intent of a single CLI invocation.
 *
 *  - `none`          → no takeover flag; a foreign lease stays rejected.
 *  - `takeover`      → `--takeover`; transfers a STALE foreign lease only.
 *  - `forceTakeover` → `--forceTakeover`; transfers an ACTIVE foreign lease too
 *    (deliberate human override). Implies `--takeover` semantics for a stale
 *    lease as well, so `--forceTakeover` always wins when both are present.
 */
export type TakeoverIntent = 'none' | 'takeover' | 'forceTakeover';

/**
 * Resolve the takeover intent from parsed CLI args.
 *
 * `parseFlags` records a bare `--takeover` / `--forceTakeover` as boolean
 * `true`; an `=value` form may also yield a string. Runtime re-validation (per
 * "Handler coding convention"): the flag counts as set ONLY for a real boolean `true` or
 * the literal string `"true"` — any other value (a typo'd `--takeover=maybe`)
 * is treated as NOT set, so a malformed flag can never silently authorize a
 * dangerous lease transfer. `--forceTakeover` outranks `--takeover`.
 */
export function resolveTakeoverIntent(args: Record<string, unknown>): TakeoverIntent {
  const isSet = (v: unknown): boolean => v === true || v === 'true';
  if (isSet(args.forceTakeover)) return 'forceTakeover';
  if (isSet(args.takeover)) return 'takeover';
  return 'none';
}


/**
 * B-c55d CHK-002: the single CLI choke-point story owner lease GATE.
 *
 * Runs once in the `run()` wrapper for every command — ownership is NEVER
 * checked inside individual handlers. Behavior by effective ownership class
 * (see `resolveEffectiveOwnershipClass`):
 *
 *  - `readOnly` / `reviewerWrite` / `mainSharedMutating` → not owner-gated. The
 *    function returns without acquiring or rejecting. (`reviewerWrite` is
 *    exempt from the owner lease but still bound by its own reviewer-run /
 *    signature gates inside the handler; `mainSharedMutating` is serialized by
 *    the B-f60c main write lock.)
 *  - `storyScopedMutating` / `dangerousMutating` → owner-gated. With a
 *    resolvable story:
 *      · no lease on disk            → this session acquires it (becomes owner);
 *      · lease owned by this session → heartbeat is refreshed;
 *      · lease owned by ANOTHER session (`foreign`) → CHK-003: if the
 *        invocation carries an explicit takeover flag the lease may be
 *        transferred (`--takeover` for a STALE lease, `--forceTakeover` for an
 *        ACTIVE one) — the transfer rewrites the lease and records a
 *        `story-owner-lease-takeover` audit event, then the command proceeds.
 *        Without a flag (or a `--takeover` on a still-active lease) the command
 *        is REJECTED fail-closed with owner guidance.
 *  - unclassified (no policy / invalid `ownershipClass`) → REJECTED fail-closed.
 *    An unclassified command is never default-allowed.
 *
 * Throws an `Error` on rejection; the `run()` catch block surfaces it as the
 * command failure. A non-owner session performs NO write (the lease primitive
 * observes a foreign lease without stealing it).
 */
export function enforceStoryOwnerLeaseGate(
  cmd: string,
  args: Record<string, unknown>,
  store: StoryStore,
  activeStory: ActiveStory | null,
  projectRoot: string,
): void {
  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  // Fail-closed: an unclassified command (no policy entry, or a policy with an
  // invalid `ownershipClass`) is rejected, never default-allowed.
  if (cls === null) {
    throw new Error(
      `Command "${cmd}" has no valid ownershipClass in command-policy.ts and is rejected fail-closed. ` +
      `Every registered command must declare a CommandPolicy.ownershipClass (readOnly / storyScopedMutating / ` +
      `reviewerWrite / mainSharedMutating / dangerousMutating). Add a classified policy entry and rerun.`,
    );
  }

  // Not owner-gated: readOnly (no story state mutated), reviewerWrite (exempt —
  // bound by its own reviewer-run/signature gates), mainSharedMutating
  // (serialized by the B-f60c main write lock, not the owner lease).
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') {
    return;
  }

  // Owner-gated: storyScopedMutating / dangerousMutating.
  if (!storyId) return; // no story resolves → nothing to own (e.g. a draft).
  const storyDir = store.storyDirPath(storyId);
  if (!existsSync(storyDir)) return; // story dir absent → command will fail on its own.

  const { lease, action } = acquireOrRefreshOwnerLease(storyDir, {
    command: cmd,
    cwd: process.cwd(),
  });

  // `acquired` / `refreshed` → the current session owns the lease; proceed.
  if (action !== 'foreign') return;

  // `foreign` → another session owns this story.
  //
  // B-c55d CHK-003: before the fail-closed rejection, check for an explicit
  // takeover flag. A takeover is a `dangerousMutating` action — it requires
  // explicit operator intent (`--takeover` / `--forceTakeover`) and always
  // records an audit event. Without a flag, NOTHING is transferred and the
  // CHK-002 fail-closed rejection stands.
  const intent = resolveTakeoverIntent(args);
  if (intent !== 'none') {
    const result = takeOverOwnerLease(storyDir, {
      kind: intent,
      command: cmd,
      cwd: process.cwd(),
      projectRoot,
    });
    if (result.transferred) {
      // The lease now belongs to this session — the takeover event was logged.
      // Proceed: the owner-gated command runs as the new owner.
      return;
    }
    // `--takeover` on an ACTIVE (non-stale) lease → refuse, and tell the
    // operator the active lease needs the explicit `--forceTakeover` override.
    if (result.reason === 'lease-active') {
      const activeAgeMs = Date.now() - Date.parse(lease.heartbeatAt);
      const activeAge = Number.isFinite(activeAgeMs) ? formatLeaseAge(activeAgeMs) : 'unknown';
      throw new Error(
        `${storyId} is owned by another Lattice session (${lease.sessionId}) whose owner lease is ` +
        `still ACTIVE (heartbeat ${activeAge} ago). --takeover only transfers a STALE lease ` +
        `(no heartbeat for 30+ minutes). To seize an active session's lock, rerun with ` +
        `--forceTakeover — a deliberate human override.`,
      );
    }
    // `no-lease` / `already-owned` are not expected here (a foreign lease was
    // just observed); fall through to the standard rejection for safety.
  }

  // No takeover flag (or a takeover that did not transfer): reject fail-closed
  // with owner guidance. The lease primitive performed NO write (no silent
  // steal). The full multi-field rejection message — story / owner sessionId /
  // owner cwd / heartbeat age / stale verdict / allowed next action — is built
  // by the single `formatNonOwnerError` pure formatter so the message can never
  // drift from the `session-ownership-and-write-leases.md` § Error UX contract.
  throw new Error(
    formatNonOwnerError(lease, {
      storyId,
      command: cmd,
      ownershipClass: cls,
      currentSessionId: getSessionId(),
      currentCwd: process.cwd(),
    }),
  );
}

// ─── B-4f15 CHK-002: read-only reviewer command guard ───────────────────────

/** Environment variable name that activates read-only reviewer mode. */
export const REVIEWER_READONLY_ENV = 'LATTICE_REVIEWER_READONLY';

/** Returns true when the process is running as a read-only reviewer. */
export function isReviewerReadOnlyModeEnabled(): boolean {
  return process.env[REVIEWER_READONLY_ENV] === '1';
}

/**
 * B-4f15 CHK-002: pre-hook, pre-lease gate for read-only reviewer mode.
 *
 * When LATTICE_REVIEWER_READONLY=1, only commands whose EFFECTIVE ownershipClass
 * is `readOnly` are permitted. All other classes — `reviewerWrite`,
 * `storyScopedMutating`, `mainSharedMutating`, `dangerousMutating`, and
 * unclassified (null) — are rejected fail-closed.
 *
 * This gate must run BEFORE preCommand hooks and before enforceStoryOwnerLeaseGate
 * so a blocked command never triggers hooks or acquires/mutates lease state.
 *
 * Throws an Error on rejection; callers surface it as a command failure.
 */
export function enforceReviewerReadOnlyCommandGate(
  cmd: string,
  args: Record<string, unknown>,
  activeStory: ActiveStory | null,
): void {
  if (!isReviewerReadOnlyModeEnabled()) return;

  const storyId = storyIdFromArgs(args, activeStory);
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === 'readOnly') return;

  const clsLabel = cls === null ? 'unclassified' : cls;
  throw new Error(
    `[${REVIEWER_READONLY_ENV}=1] Command "${cmd}" is not allowed in read-only reviewer mode ` +
    `(effective ownershipClass: ${clsLabel}). ` +
    `Advisory read-only reviewers may only run read-only Lattice commands and should return ` +
    `structured findings to the story owner. ` +
    `To run write commands, unset ${REVIEWER_READONLY_ENV} and ensure you are the story owner.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a CLI invocation should be recorded in activity.jsonl.
 * Returns false for read-only commands and dry-run invocations.
 */
export function shouldWriteActivityLog(cmdName: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_COMMANDS.has(cmdName)) {
    return process.env.LATTICE_ACTIVITY_RECORD_READONLY === '1';
  }
  if (args.dryRun === true) return false;
  return true;
}

function gitCli(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    const details = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
}

function toGitRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function boundedMetadataPath(baseRel: string, child: string, label: string): string {
  const childPath = toGitRelPath(child);
  if (!childPath || isAbsolute(childPath) || childPath.split('/').includes('..')) {
    throw new Error(`from-draft metadata path for ${label} is not bounded: ${child}`);
  }
  return `${toGitRelPath(baseRel)}/${childPath}`;
}

function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function stageBoundedMetadataPath(root: string, relPath: string): void {
  if (existsSync(join(root, relPath))) {
    gitCli(root, ['add', '-A', '--', relPath]);
    return;
  }

  const deleted = gitCli(root, ['ls-files', '--deleted', '--', relPath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (deleted.length > 0) {
    gitCli(root, ['add', '-A', '--', ...deleted]);
  }
}

function preflightFromDraftMetadataBootstrap(root: string): void {
  const currentBranch = gitCli(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== 'main') {
    throw new Error(`story_create --fromDraft must finalize metadata on main, but current branch is ${currentBranch}`);
  }

  const stagedBefore = gitCli(root, ['diff', '--cached', '--name-only']);
  if (stagedBefore) {
    throw new Error(
      `story_create --fromDraft requires a clean git index before mutating story/draft/worktree metadata:\n${stagedBefore}`,
    );
  }
}

function commitFromDraftMetadataOnMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  preflightFromDraftMetadataBootstrap(root);

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  const draftRel = boundedMetadataPath('docs/story/drafts', draftName, 'source draft');
  const boundedPaths = [storyRel, draftRel];

  // B-9177 CHK-002: serialize the stage→commit-on-main critical section under
  // the unified main write lock. A concurrent main commit between staging and
  // committing is the same B-7365-class race that corrupts story/draft metadata.
  // Reentrant variant — the from-draft bootstrap can run inside an
  // already-locked context; `root` is the main checkout (preflight asserts
  // branch==main on it and every git op uses it as cwd).
  return withReentrantMainWriteLock(root, () => {
    for (const path of boundedPaths) {
      stageBoundedMetadataPath(root, path);
    }
    const staged = gitCli(root, ['diff', '--cached', '--name-only']);
    const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
    if (stagedPaths.length === 0) {
      return '';
    }
    const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, boundedPaths));
    if (outOfBounds.length > 0) {
      throw new Error(
        `from-draft metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
      );
    }

    const commitMessage = `lattice: from-draft metadata ${storyId}`;
    gitCli(root, [
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m', commitMessage,
    ]);
    const mainHead = gitCli(root, ['rev-parse', '--short', 'HEAD']);
    const boundedStatus = gitCli(root, ['status', '--porcelain', '--', ...boundedPaths]);
    if (boundedStatus) {
      throw new Error(
        `from-draft metadata committed, but bounded metadata paths are still dirty ` +
        `(${boundedPaths.join(', ')}):\n${boundedStatus}`,
      );
    }

    return `✓ from-draft metadata committed on main: ${mainHead} (${commitMessage})`;
  }, { label: 'from-draft metadata commit' });
}

function commitFromDraftMetadataAndMergeMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  // B-9177 CHK-002: serialize the commit-on-main + merge-into-story-worktree
  // critical section under one main write lock, exactly as the B-7365 sibling
  // `commitInitCheckMetadataAndMergeMain` does. A concurrent main commit between
  // our commit and our merge is what produces a divergent metadata state.
  // Reentrant — the inner `commitFromDraftMetadataOnMain` (also reentrant-locked)
  // becomes a pass-through under this outer hold; `root` is the main checkout.
  return withReentrantMainWriteLock(root, () => {
    const metadataResult = commitFromDraftMetadataOnMain(root, store, storyId, draftName);
    const story = store.readStory(storyId);
    const worktreePath = story.worktree?.path;
    const storyBranch = story.worktree?.branch || `story/${storyId}`;
    if (!worktreePath) {
      throw new Error(`from-draft story ${storyId} has no recorded worktree path after dev_start`);
    }
    const repoRoot = gitCli(root, ['rev-parse', '--show-toplevel']);
    const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(repoRoot, worktreePath);
    gitCli(worktreeAbs, [
      '-c', 'commit.gpgsign=false',
      'merge',
      'main',
      '--no-edit',
    ]);
    gitCli(worktreeAbs, ['merge-base', '--is-ancestor', 'main', storyBranch]);

    return [
      metadataResult,
      `✓ main merged into ${storyBranch}`,
    ].filter(Boolean).join('\n');
  }, { label: 'from-draft metadata commit+merge' });
}

/**
 * B-f60c CHK-002 — close F-008 partial-DONE at the INIT_CHECK write side.
 *
 * Root cause (verified, B-6974 / B-ad12 real-machine repros): `story_advance
 * INIT_CHECK` runs `story_advance` (writes phase) then `dev_start` (writes
 * `story.worktree` into the MAIN repo's `.lattice/story/actives/<id>/index.json`).
 * `dev_start.createScopedStoryBootstrapCommit` commits the story dir onto the
 * `story/<id>` branch via a TEMPORARY git index — it never touches the main
 * repo's working tree or index. So the main checkout is left with an
 * UNCOMMITTED story-metadata mirror (the story dir is untracked, since
 * `story_create` only wrote files without committing them).
 *
 * At DONE, `applyDoneMergeEffects` Step 3 runs `git merge story/<id>` from the
 * main repo root. The story branch carries a committed
 * `.lattice/story/actives/<id>/index.json`; the main working tree has the SAME
 * path untracked → git aborts the merge ("untracked working tree files would
 * be overwritten by merge") → partial-DONE (story marked DONE, branch never
 * merged).
 *
 * Fix: commit that mirror on the current (main) branch right after `dev_start`,
 * exactly mirroring what `commitFromDraftMetadataAndMergeMain` already does for
 * the from-draft path, then merge the base branch into the story worktree so
 * the story branch still contains all of main. After this the DONE merge has
 * nothing uncommitted to collide with. Just serializing the DONE critical
 * section (CHK-001's lock) cannot close F-008 — the stale mirror must be
 * removed from the main working tree at its INIT_CHECK source.
 *
 * Idempotent: a retry where the story dir is already committed stages nothing
 * and returns '' (no-op) instead of throwing.
 */
/**
 * B-4e06 CHK-003: resolve the git "main checkout" root for INIT_CHECK metadata
 * reconciliation. With a configured gitRoot (wrapper-root project), the main
 * checkout IS the resolved git root, not the metadata wrapper. Reuses the shared
 * signed-workspace resolver — no second resolver. Falls back to the metadata
 * root for plain repos (byte-for-byte unchanged).
 */
function resolveInitCheckGitMainRoot(root: string, store: StoryStore, storyId: string): string {
  const configuredGitRoot = loadConfig(root).gitRoot?.trim();
  if (!configuredGitRoot) return root;
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: root });
  if (resolution.resolved && resolution.repoRoot) return resolution.repoRoot;
  throw new Error(
    `INIT_CHECK metadata reconcile: configured gitRoot is unusable (${resolution.unresolvedReason || 'unresolved'}).`,
  );
}

export function commitInitCheckMetadataAndMergeMain(root: string, store: StoryStore, storyId: string): string {
  const gitMainRoot = resolveInitCheckGitMainRoot(root, store, storyId);
  const currentBranch = gitCli(gitMainRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch.startsWith('story/')) {
    // INIT_CHECK is the standard worktree-creation entry and must run from the
    // main checkout. If we are already on a story branch, dev_start would not
    // have created a main-side mirror to reconcile — leave it untouched.
    return '';
  }

  // storyRel must be relative to the git main root so `git add` works whether or
  // not the metadata root is the git root. Canonicalize both sides (realpath) so
  // a /var → /private/var symlink does not corrupt the relative path. When
  // gitMainRoot === root this equals the legacy bounded storyDirRel/storyId path.
  const storyAbs = join(root, store.storyDirRel(), storyId);
  const canonicalStoryAbs = existsSync(storyAbs) ? realpathSync(storyAbs) : storyAbs;
  const canonicalGitMainRoot = existsSync(gitMainRoot) ? realpathSync(gitMainRoot) : gitMainRoot;
  const storyRelRaw = relative(canonicalGitMainRoot, canonicalStoryAbs).replace(/\\/g, '/');
  if (!storyRelRaw || isAbsolute(storyRelRaw) || storyRelRaw.split('/').includes('..')) {
    throw new Error(
      `INIT_CHECK metadata reconcile: story metadata path ${storyAbs} is not inside the git root ${gitMainRoot}; ` +
      `configure storyDir so story metadata lives inside the gitRoot.`,
    );
  }
  const storyRel = storyRelRaw;
  stageBoundedMetadataPath(gitMainRoot, storyRel);
  const staged = gitCli(gitMainRoot, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    // Story metadata already committed (retry / already-tracked) — nothing to
    // reconcile, the DONE merge will not collide.
    return '';
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    throw new Error(
      `INIT_CHECK metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `lattice: INIT_CHECK metadata ${storyId}`;
  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`INIT_CHECK story ${storyId} has no recorded worktree path after dev_start`);
  }
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(gitMainRoot, worktreePath);

  // B-7365: serialize the commit-on-main + merge-into-story-worktree critical
  // section under the unified main write lock. A concurrent session committing
  // to main between our commit and our merge is exactly what produces a
  // divergent `index.json` and the merge conflict this function must survive;
  // holding the lock across BOTH steps closes that race. Reentrant variant:
  // INIT_CHECK can run inside an already-locked context (the lock is released
  // in the helper's finally even when the critical section throws).
  return withReentrantMainWriteLock(gitMainRoot, () => {
    gitCli(gitMainRoot, [
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m', commitMessage,
    ]);
    const mainHead = gitCli(gitMainRoot, ['rev-parse', '--short', 'HEAD']);
    const boundedStatus = gitCli(gitMainRoot, ['status', '--porcelain', '--', storyRel]);
    if (boundedStatus) {
      throw new Error(
        `INIT_CHECK metadata committed, but bounded story path is still dirty (${storyRel}):\n${boundedStatus}`,
      );
    }

    mergeBaseBranchIntoStoryWorktreeResolvingMetadata({
      worktreeAbs,
      baseBranch: currentBranch,
      storyRel,
    });
    gitCli(worktreeAbs, ['merge-base', '--is-ancestor', currentBranch, storyBranch]);

    return [
      `✓ INIT_CHECK metadata committed on ${currentBranch}: ${mainHead} (${commitMessage})`,
      `✓ ${currentBranch} merged into ${storyBranch}`,
    ].join('\n');
  }, { label: 'INIT_CHECK reconcile' });
}

/**
 * B-7365: merge `baseBranch` (main) into the story worktree's branch, resolving
 * any conflict on the machine-generated story metadata deterministically to the
 * post-advance (base/main-committed) version — NEVER leaving or committing
 * `<<<<<<< / ======= / >>>>>>>` conflict markers in `index.json` (or any other
 * file under `storyRel`).
 *
 * Rationale: the story metadata under `storyRel` is machine-owned and
 * authoritative on the base branch right after INIT_CHECK advanced it; the
 * story branch's copy is the pre-advance bootstrap snapshot. So on a conflict
 * the correct, deterministic resolution is "take base/main's version" for every
 * conflicted path under `storyRel`. Anything conflicting OUTSIDE `storyRel` is
 * not machine-owned and cannot be silently auto-resolved — we abort the merge
 * and throw a clear recovery error rather than guess.
 *
 * The clean (no-conflict) path is byte-identical to the legacy bare
 * `git merge <base> --no-edit`: `git merge` returns 0, we return immediately.
 */
function mergeBaseBranchIntoStoryWorktreeResolvingMetadata(args: {
  worktreeAbs: string;
  baseBranch: string;
  storyRel: string;
}): void {
  const { worktreeAbs, baseBranch, storyRel } = args;

  // Run the merge WITHOUT throwing on a non-zero exit so a conflict can be
  // inspected + resolved rather than surfacing as an opaque marker corruption.
  const merge = runGitNoThrow(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge', baseBranch, '--no-edit',
  ]);
  if (merge.code === 0) {
    // Clean (no-conflict) path: byte-identical to the legacy bare merge — git
    // has already created the merge commit. Return immediately.
    return;
  }

  // Non-zero exit: determine whether this is a resolvable metadata conflict.
  // `git diff --name-only --diff-filter=U` lists exactly the unmerged
  // (conflicted) paths, repo-relative with forward slashes.
  const conflicted = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
    .stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (conflicted.length === 0) {
    // Non-zero with no unmerged paths is NOT a content conflict (e.g. the base
    // branch is unknown, a dirty worktree blocked the merge, a hook failed).
    // Do not pretend to resolve it: abort any half-started merge and surface the
    // real git error for recovery.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: git merge ${baseBranch} into the story worktree failed and is not a ` +
      `metadata conflict (no unmerged paths). git said:\n${(merge.stderr || merge.stdout).trim()}`,
    );
  }

  // Any conflicted path OUTSIDE the machine-owned story dir cannot be safely
  // auto-resolved (it is not machine-generated metadata we own a canonical
  // version of). Abort the merge cleanly and throw a clear recovery error —
  // never leave/commit markers.
  const outOfBounds = conflicted.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: merge of ${baseBranch} conflicted on non-metadata paths that cannot be ` +
      `auto-resolved:\n${outOfBounds.join('\n')}\n` +
      `Aborted the merge to avoid committing conflict markers. Resolve manually in the worktree ` +
      `(git merge ${baseBranch}) and retry.`,
    );
  }

  // Every conflicted path is under the machine-owned story dir. Resolve each to
  // the post-advance (base/main) version. We merged `baseBranch` INTO the story
  // branch, so `--theirs` is the incoming base branch's version. Stage the
  // resolved content so no markers remain, then complete the merge commit.
  //
  // The throwing gitCli calls below (stage / rm / commit) can fail for reasons
  // outside our control (locked index, hook failure, disk error). If any of
  // them throws, the exception must NOT escape with the worktree left mid-merge
  // (MERGE_HEAD present) — that would require manual `git merge --abort`
  // recovery. Wrap the resolution + commit in try/catch so ANY throw aborts the
  // half-started merge before rethrowing, mirroring the out-of-bounds and
  // still-unmerged abort+throw handling above.
  try {
    for (const path of conflicted) {
      // `git checkout --theirs` takes the base/main version for content (and
      // add/add) conflicts. For a modify/delete conflict where base DELETED the
      // path there is no "theirs" stage and checkout errors — in that case the
      // deterministic "take base" resolution is to delete the path too.
      const tookTheirs = runGitNoThrow(worktreeAbs, ['checkout', '--theirs', '--', path]);
      if (tookTheirs.code === 0) {
        gitCli(worktreeAbs, ['add', '--', path]);
      } else {
        gitCli(worktreeAbs, ['rm', '-f', '--', path]);
      }
    }

    // Defensive: confirm no unmerged paths remain before committing so a marker
    // can never reach a commit object. (Re-check the same invariant rather than
    // trusting the loop above blindly — Handler coding convention.)
    const stillUnmerged = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
      .stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (stillUnmerged.length > 0) {
      runGitNoThrow(worktreeAbs, ['merge', '--abort']);
      throw new Error(
        `INIT_CHECK reconcile: failed to fully resolve metadata conflict; unmerged paths remain:\n` +
        `${stillUnmerged.join('\n')}\nAborted the merge to avoid committing conflict markers.`,
      );
    }

    gitCli(worktreeAbs, ['-c', 'commit.gpgsign=false', 'commit', '--no-edit']);
  } catch (e) {
    // Any failure while resolving/committing the metadata conflict must leave
    // the worktree clean rather than mid-merge. Abort the half-started merge
    // (best-effort, no-throw) before surfacing the original error.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw e;
  }
}

/**
 * Run a git command capturing stdout/stderr/exit code WITHOUT throwing on a
 * non-zero exit. Needed for `git merge`, whose conflict exit code (1) must be
 * inspected and resolved rather than surfacing as an opaque thrown error.
 */
function runGitNoThrow(cwd: string, gitArgs: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', gitArgs, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e: any) {
    return {
      code: typeof e?.status === 'number' ? e.status : 1,
      stdout: e?.stdout ? String(e.stdout) : '',
      stderr: e?.stderr ? String(e.stderr) : String(e?.message ?? e),
    };
  }
}

// ── Main ──

/**
 * runCli: Lattice CLI runtime entry point.
 *
 * @param opts.extraTools ToolDef list from third-party packages, merged into help and dispatch.
 * @param opts.extraRegister register function from third-party packages, called after createMainRegistry.
 * (after receiving the Registry instance, inject handlers with registry.registerBatch(...))
 */
export async function runCli(opts?: {
  extraTools?: ToolDef[];
  extraRegister?: (registry: Registry, ctx: HandlerContext) => void;
}): Promise<void> {
  // Inject extras: merge tool defs and keep extras register for later invocation.
  TOOLS = opts?.extraTools && opts.extraTools.length > 0
    ? [...MAIN_TOOLS, ...opts.extraTools]
    : MAIN_TOOLS;

  const argv = process.argv.slice(2);

  // --root flag
  let rootOverride: string | undefined;
  const ri = argv.indexOf('--root');
  if (ri !== -1 && argv[ri + 1]) { rootOverride = argv[ri + 1]; argv.splice(ri, 2); }

  let cmd = argv[0];
  let arg = argv[1];

  // Detect active story from git branch
  const root0 = resolveRootForCommand(cmd, rootOverride);
  const activeStory = detectActiveStory(root0);
  const gitReady = isGitRepository(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
    return;
  }

  // init uses a standalone script.
  if (cmd === 'init') {
    const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    await import(`file://${initPath}`);
    return;
  }

  // dashboard uses standalone long-running mode.
  if (cmd === 'dashboard') {
    const dashArgs = parseFlags(argv.slice(1), {
      roots: z.string().optional(),
      interval: z.number().optional(),
    });
    // If roots are not specified, use --root (or auto-detection) as the default.
    if (!dashArgs.roots) dashArgs.roots = root0;
    const { runDashboard } = await import('./dashboard.js');
    await runDashboard(dashArgs as { roots?: string; interval?: number });
    return;
  }

  // Normalize nested space aliases into the flat underscore commands used by
  // the registry.
  const aliasStart = cmd === 'lattice' ? 1 : 0;
  const aliasMap: Record<string, string> = {
  'host list': 'host_list',
  'host probe': 'host_probe',
  'host status': 'host_status',
  'host runtime list': 'host_runtime_list',
  'host runtime probe': 'host_runtime_probe',
  'host install': 'host_install',
  'host dispatch': 'host_dispatch',
  'dispatch plan': 'dispatch_plan',
  'dispatch prepare': 'dispatch_prepare',
  'dispatch run': 'dispatch_run',
  'dispatch collect': 'dispatch_collect',
  'dispatch receipt create': 'dispatch_receipt_create',
  'dispatch status': 'dispatch_status',
  'dispatch list': 'dispatch_list',
  'dispatch resume': 'dispatch_resume',
  'dispatch cancel': 'dispatch_cancel',
  'dispatch review': 'dispatch_review',
  'dispatch merge plan': 'dispatch_merge_plan',
  'dispatch policy create': 'dispatch_policy_create',
  'dispatch policy get': 'dispatch_policy_get',
  'dispatch policy check': 'dispatch_policy_check',
  'dispatch auto': 'dispatch_auto',
  'dispatch watch': 'dispatch_watch',
  'autopilot policy create': 'autopilot_policy_create',
  'autopilot policy get': 'autopilot_policy_get',
  'autopilot policy check': 'autopilot_policy_check',
  'autopilot run': 'autopilot_run',
  'autopilot status': 'autopilot_status',
  'autopilot watch': 'autopilot_watch',
  'autopilot cancel': 'autopilot_cancel',
  'autopilot review': 'autopilot_review',
  'autopilot resume': 'autopilot_resume',
  'overflow auto': 'overflow_auto',
  'handoff create': 'handoff_create',
  'handoff inspect': 'handoff_inspect',
  'handoff accept': 'handoff_accept',
  'handoff resume': 'handoff_resume',
  'handoff receipt submit': 'handoff_receipt_submit',
  'handoff worktree create': 'handoff_worktree_create',
  'config doctor': 'lattice_config_doctor',
  'config repair': 'lattice_config_repair',
  'codex verify': 'verify_codex',
  'codex doctor': 'codex_doctor',
  'rollout check': 'rollout_check',
  'baseline run': 'baseline_run',
  'baseline suite': 'baseline_suite',
  'baseline suite report': 'baseline_suite_report',
  'capability claim formal evaluate': 'capability_claim_formal_evaluate',
  'authority status': 'authority_status',
  'authority enforce policy': 'authority_enforce_policy',
  'authority enforce runner': 'authority_enforce_runner',
  'authority receipt verify': 'authority_receipt_verify',
  'authority receipt fetch': 'authority_receipt_fetch',
  'authority job create': 'authority_job_create',
  'authority job status': 'authority_job_status',
  'authority verdict submit': 'authority_verdict_submit',
  'authority verdict list': 'authority_verdict_list',
  'autopilot execute': 'autopilot_execute',
  'autopilot doctor': 'autopilot_doctor',
  'autopilot review submit': 'autopilot_review_submit',
  'autopilot review status': 'autopilot_review_status',
  'decision doc quorum check': 'decision_doc_quorum_check',
  'decision doc proposal': 'decision_doc_proposal',
  'decision doc preview': 'decision_doc_preview',
  'decision doc save': 'decision_doc_save',
  'review escalation status': 'review_escalation_status',
  'review escalation fallback set': 'review_escalation_fallback_set',
  'planner draft': 'planner_draft',
  'planner review': 'planner_review',
  'planner create-story': 'planner_create_story',
  'planner create-job': 'planner_create_job',
  'planner status': 'planner_status',
  'planner answer': 'planner_answer',
  'planner decision submit': 'planner_decision_submit',
  'planner resume': 'planner_resume',
  'planner run': 'planner_run',
  'planner source-manifest': 'planner_source_manifest',
  'story resolve': 'story_resolve',
  'done closure': 'done_closure',
  'conduit status': 'conduit_status',
  'conduit explain': 'conduit_explain',
  'story authority resolve': 'story_authority_resolve',
  'observability snapshot': 'observability_snapshot',
  };
  const twoPart = argv.slice(aliasStart, aliasStart + 2).join(' ');
  const threePart = argv.slice(aliasStart, aliasStart + 3).join(' ');
  const fourPart = argv.slice(aliasStart, aliasStart + 4).join(' ');
  const canonicalAlias = aliasMap[fourPart] || aliasMap[threePart] || aliasMap[twoPart];
  if (canonicalAlias) {
    const consumed = aliasMap[fourPart] ? 4 : aliasMap[threePart] ? 3 : 2;
    argv.splice(0, aliasStart + consumed, canonicalAlias);
    cmd = canonicalAlias;
    arg = argv[1];
  } else if (cmd === 'lattice' && (argv[1] === 'version' || argv[1] === '--version' || argv[1] === '-v')) {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
    return;
  }

  if (cmd === 'codex' && (argv[1] === 'session_brief' || argv[1] === 'aux_doc_list')) {
    const ordinary = argv[1];
    console.error(`Unsupported command: lattice codex ${ordinary}`);
    console.error('The Codex adapter namespace only supports: lattice codex verify, lattice codex doctor.');
    console.error(`Use the ordinary command instead: lattice ${ordinary}`);
    process.exit(1);
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`Unknown command: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('Did you mean:'); for (const t of m) console.error(`  lattice ${t.name}`); }
    console.error('Use lattice help to view all commands.');
    process.exit(1);
  }

  if (arg === '--help' || arg === '-h') { printToolHelp(tool); return; }

  // Phase gate: When an active story exists, reject commands outside the allowlist.
  if (activeStory) {
    const config = loadConfig(root0);
    if (!isCommandAllowed(cmd, activeStory.phase, config.phaseTools)) {
      const allowed = getAllowedPatterns(activeStory.phase, config.phaseTools);
      console.error(`Command "${cmd}" is not available in ${activeStory.phase} phase`);
      console.error(`   Story: ${activeStory.storyId}  Phase: ${activeStory.phase}`);
      for (const line of formatCommandLifecycleHint(cmd, activeStory.phase, allowed)) console.error(line);
      console.error(`   Current phase available commands: ${allowed.join(', ')}`);
      process.exit(1);
    }
  }

  // Parse arguments — supports three formats:
  // 1. --key=value --flag (standard flag)
  // 2. key=value (shorthand flag)
  // 3. '{"key":"value"}'  (JSON body, compatible with legacy usage)
  let parsed: Record<string, unknown> = {};
  {
    const rawArgs = argv.slice(1);
    if (rawArgs.length === 0) {
      // No arguments; empty object.
    } else if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
      // JSON body format (compatible with legacy usage).
      try { parsed = JSON.parse(rawArgs[0]); }
      catch (e) {
        console.error(`JSON parse failed: ${(e as Error).message}\nInput: ${rawArgs[0]}`);
        printToolHelp(tool, { stream: process.stderr, includeFooter: false });
        process.exit(1);
      }
    } else {
      // Flag-format parsing.
      parsed = parseFlags(rawArgs, tool.schema);
    }
  }

  if (cmd === 'dev_memory_finish' && activeStory) {
    const hasExplicitStory =
      (typeof parsed.story === 'string' && parsed.story.trim().length > 0) ||
      (typeof parsed.storyId === 'string' && parsed.storyId.trim().length > 0);
    if (!hasExplicitStory && parsed.scope !== 'global') {
      parsed = { ...parsed, storyId: activeStory.storyId };
    }
  }

  // Validate
  const schema = validationSchemaForCommand(cmd, tool);
  const v = schema.safeParse(parsed);
  if (!v.success) {
    printValidationFailure(tool, v.error.issues);
    process.exit(1);
  }
  parsed = v.data as Record<string, unknown>;

  // Execute
  const root = resolveRootForCommand(cmd, rootOverride);
  // Durable main-root fallback for post-command activity logging.
  // story_advance --phase=DONE removes the current story worktree mid-command.
  // Once removed, root/.git is gone, so resolveMainRootFromWorktreeRoot() can no
  // longer recover the main project root, and resolveRoot()'s cwd-walk may land
  // on (and appendActivityLog may recreate) the now-deleted ghost worktree dir.
  // Capture the main root NOW, while root/.git still exists, so writeLog can fall
  // back to a durable path that survives the deletion.
  const mainRootFallback = resolveMainRootFromWorktreeRoot(root);
  const store = new StoryStore(root);
  const _cliStart = Date.now();
  let log: (msg: string) => void = (msg) => {
    const elapsed = ((Date.now() - _cliStart) / 1000).toFixed(1);
    process.stderr.write(`[${elapsed}s] ${msg}\n`);
  };

  const config0 = loadConfig(root);
  const scanRoot = join(root, config0.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  const registry = createMainRegistry(ctx);
  if (opts?.extraRegister) opts.extraRegister(registry, ctx);
  const handlers = registry.toObject() as Record<string, Function>;

  // Stale state warnings — soft, never blocks. Print before handler dispatch
  // so the agent sees the reminder along with the command output. The captured
  // warnings are also passed into writeLog so activity.jsonl preserves them
  // for trend analysis (how often does the agent forget to advance?).
  let staleWarnings: string[] = [];
  try {
    staleWarnings = detectStaleState(ctx);
    if (staleWarnings.length > 0) {
      process.stderr.write('⚠ Lattice stale state warnings:\n');
      for (const w of staleWarnings) process.stderr.write(`  - ${w}\n`);
    }
  } catch { /* never block */ }

  // Heartbeat: by default, 5 minutes without output means stuck; 15 minutes is the absolute safety limit.
  // Can be overridden with LATTICE_IDLE_TIMEOUT_MS / LATTICE_MAX_TIMEOUT_MS,
  // A single LLM call in real-machine smoke tests can occasionally exceed 2 minutes (non-deterministic cases such as text-adventure uninstall).
  const IDLE_TIMEOUT = Number(process.env.LATTICE_IDLE_TIMEOUT_MS) || (5 * 60 * 1000);
  const MAX_TIMEOUT = Number(process.env.LATTICE_MAX_TIMEOUT_MS) || (15 * 60 * 1000);
  const startTime = Date.now();
  let lastActivity = Date.now();
  const originalLog = log;
  log = (msg: string) => { lastActivity = Date.now(); originalLog(msg); };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startTime > MAX_TIMEOUT) {
      originalLog(`${cmd} exceeded 10 minutes; forcing exit`);
      process.exit(2);
    }
    if (now - lastActivity > IDLE_TIMEOUT) {
      originalLog(`${cmd} stuck: ${IDLE_TIMEOUT / 1000} seconds without output; forcing exit`);
      process.exit(2);
    }
  }, 10000);
  watchdog.unref();

  // Unified logging: write to .lattice/activity.jsonl (dual-source module, legacy path is read-compatible only).
  // Write failure is a PERSIST issue (incomplete audit means it cannot be traced later), so reportHealthIssue is used instead.
  // staleWarnings are persisted too, making later trend analysis possible (how long agents go before forgetting an advance).
  function writeLog(entry: {
    command: string;
    args: unknown;
    startTime: string;
    endTime: string;
    success: boolean;
    error?: string;
    staleWarnings?: string[];
  }) {
    try {
      // B-9cd4 follow-up bug: story_advance --phase=DONE removes the current
      // worktree mid-command. The `root` captured at command start still
      // points at that worktree. If we appendActivityLog on the now-ghost
      // path, we re-create dirs and leave a dangling audit log that
      // masquerades as an active worktree.
      //
      // Detect this by checking if `root` still has lattice.config.json.
      // If not (the worktree was removed), prefer the durable main-root
      // fallback captured at command start — it was computed while root/.git
      // still existed, so it points at the real main project even after the
      // worktree is gone. Do NOT fall back to resolveRoot() first: its
      // cwd-walk may resolve to (and appendActivityLog would then recreate)
      // the now-deleted ghost worktree dir. Only use resolveRoot() if the
      // durable fallback is unavailable/stale, and skip logging entirely if
      // neither has a project config file rather than pollute the filesystem.
      let effectiveRoot = root;
      if (!hasProjectConfigFile(effectiveRoot)) {
        if (mainRootFallback && hasProjectConfigFile(mainRootFallback)) {
          effectiveRoot = mainRootFallback;
        } else {
          effectiveRoot = resolveRoot();
          if (!hasProjectConfigFile(effectiveRoot)) {
            return;
          }
        }
      }
      const record: Record<string, unknown> = {
        source: process.env.LATTICE_ACTIVITY_SOURCE || 'cli',
        session: process.env.LATTICE_ACTIVITY_SESSION || '',
        entrypoint: inferCodexEntrypoint(),
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: storyIdFromArgs(entry.args as Record<string, unknown>, activeStory, {
          command: entry.command,
          projectRoot: effectiveRoot,
        }),
        phase: activeStory?.phase || null,
        role: inferActivityRole(entry.args, process.env.LATTICE_ACTIVITY_ROLE || process.env.LATTICE_AGENT),
      };
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendActivityLog(effectiveRoot, record);
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        logDir: join(root, LATTICE_DIR),
      });
    }
  }

  function writeCodexProcessEvent(entry: {
    command: string;
    args: unknown;
    success: boolean;
    error?: string;
  }) {
    if ((process.env.LATTICE_ACTIVITY_SOURCE || '') !== 'codex') return;
    const argsObject = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? entry.args as Record<string, unknown>
      : {};
    const storyId = storyIdFromArgs(argsObject, activeStory, { command: entry.command, projectRoot: root });
    if (!storyId) return;
    try {
      let phase = activeStory?.phase || '';
      if (!phase) {
        try { phase = store.readStory(storyId).phase; } catch { phase = ''; }
      }
      store.appendProcessEvent(storyId, {
        type: 'codex_cli',
        source: 'codex',
        session: process.env.LATTICE_ACTIVITY_SESSION || '',
        role: inferActivityRole(entry.args, process.env.LATTICE_ACTIVITY_ROLE || process.env.LATTICE_AGENT),
        storyId,
        phase,
        command: entry.command,
        entrypoint: inferCodexEntrypoint(),
        result: entry.success ? 'pass' : 'fail',
        ...(entry.error ? { errorSummary: entry.error.slice(0, 300) } : {}),
      });
    } catch (e: unknown) {
      reportHealthIssue('persist:codexProcessEvent', e as Error, {
        command: entry.command,
        storyId,
      });
    }
  }

  // Hook env factory — delegates to the shared helper in core/hooks.ts so
  // transition-orchestrator can call it the same way for onPhaseChange.
  function buildHookEnvLocal(stage: 'preCommand' | 'postCommand' | 'onError', extra: Record<string, string> = {}): Record<string, string> {
    return buildSharedHookEnv({
      stage,
      command: cmd,
      cwd: process.cwd(),
      root,
      argsJson: JSON.stringify(parsed),
      storyId: activeStory?.storyId,
      phase: activeStory?.phase,
      extra,
    });
  }

  async function run(fn: () => unknown | Promise<unknown>) {
    const runStart = new Date().toISOString();
    log(`running ${cmd}...`);
    // B-4f15 CHK-002: read-only reviewer gate runs first — before hooks and
    // before the owner lease gate, so a blocked command cannot trigger hooks
    // or acquire/mutate lease state.
    try {
      enforceReviewerReadOnlyCommandGate(cmd, parsed, activeStory);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // preCommand hook — non-blocking failure, awaited so it always runs before the handler
    if (config0?.hooks?.preCommand && !READ_ONLY_COMMANDS.has(cmd)) {
      process.stderr.write(`[lattice-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    if (!READ_ONLY_COMMANDS.has(cmd)) {
      await runHooks('preCommand', cmd, buildHookEnvLocal('preCommand'), config0, root);
    }
    try {
      // B-c55d CHK-002: story owner lease GATE. This `run()` wrapper is the
      // single CLI choke-point every command flows through, so ownership is
      // decided here — NOT scattered across handlers. By effective
      // ownershipClass: readOnly / reviewerWrite / mainSharedMutating are never
      // owner-gated; an owner-gated storyScopedMutating / dangerousMutating
      // command for a story owned by THIS session acquires-or-refreshes the
      // lease, while a command targeting a story owned by ANOTHER session is
      // rejected fail-closed with owner guidance; an unclassified command is
      // also rejected fail-closed. The gate runs inside this `try` so a
      // rejection surfaces through the `catch` below as the command failure.
      enforceStoryOwnerLeaseGate(cmd, parsed, store, activeStory, root);
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      clearInterval(watchdog);
      log(`${cmd} done`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: true, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: true });
      // Append next-step guidance. Only commands registered in hints.ts are decorated; other commands are returned unchanged.
      // B-7fc2: `--json` / `--format=json` stdout is a machine-only payload.
      // Skip hint decoration entirely in machine JSON mode so JSON.parse(stdout)
      // succeeds for dashboard / host adapters / smoke tests. Text mode still
      // gets the existing decorateResult treatment so human users keep the
      // next-step hint (e.g. "Next: Validation passed").
      const hintActive: ActiveStoryInfo | null = activeStory
        ? { storyId: activeStory.storyId, phase: activeStory.phase }
        : null;
      if (!wantsMachineJson(parsed)) {
        result = decorateResult({
          cmd,
          args: parsed,
          result,
          store,
          root,
          activeStory: hintActive,
        });
      }
      // postCommand hook — runs before we exit; failure does not block exit(0)
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      if (config0?.hooks?.postCommand && !READ_ONLY_COMMANDS.has(cmd)) {
        process.stderr.write(`[lattice-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      if (!READ_ONLY_COMMANDS.has(cmd)) {
        await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
          LATTICE_RESULT_JSON: truncateForEnv(resultText),
        }), config0, root);
      }
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      process.stdout.write(`${output}\n`);
      process.exitCode = 0;
      return;
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: false, error: e.message });
      // onError hook — best-effort; always runs before exit(1).
      // Print a hint so the user knows why a failed command takes a few extra seconds.
      if (config0?.hooks?.onError) {
        process.stderr.write(`[lattice-hook] running onError hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('onError', cmd, buildHookEnvLocal('onError', {
        LATTICE_ERROR: String(e?.message || e),
      }), config0, root);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // story_create: append next-step hint when stopping in INIT.
  if (cmd === 'story_create') {
    await run(() => {
      const fromDraftName = typeof (v.data as any).fromDraft === 'string' ? (v.data as any).fromDraft : '';
      if (fromDraftName && gitReady) {
        preflightFromDraftMetadataBootstrap(root);
      }
      const result = handlers.story_create(v.data);
      if (result.includes('created from draft') && result.includes('(phase=INIT_CHECK)')) {
        const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
        if (!storyId) return result;
        if (!gitReady) {
          return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the from-draft worktree cannot be created automatically.\nNext: Run git init and make the first commit, then retry lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
        }
        try {
          const wtResult = handlers.dev_start({ storyId });
          const syncResult = commitFromDraftMetadataAndMergeMain(root, store, storyId, fromDraftName);
          return `${result}\n\n${wtResult}\n\n${syncResult}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN`;
        } catch (e: any) {
          throw new Error(
            `from-draft worktree bootstrap failed for ${storyId}: ${e.message}\n` +
            `Next: After diagnosing, run lattice story_advance --phase=INIT_CHECK again to retry automatically, or manually run lattice dev_start '{"storyId":"${storyId}"}'`,
          );
        }
      }
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (result.includes('当前目录不是 git 仓库')) return result;
      let fromDraftMetadataSegment = '';
      if (fromDraftName && result.includes('created from draft') && gitReady) {
        fromDraftMetadataSegment = commitFromDraftMetadataOnMain(root, store, storyId, fromDraftName);
      }
      if (!gitReady) {
        return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the INIT_CHECK/worktree flow cannot run smoothly yet.\nNext: First run git init && git add . && git commit -m "init" at the project root, then run lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
      }
      const metadataLine = fromDraftMetadataSegment ? `\n${fromDraftMetadataSegment}` : '';
      return `${result}${metadataLine}\nStory is currently in INIT.\nNext steps:\n  1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' create worktree\n  2. cd to the prompted worktree path\n  3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' enter PLAN (cwd must be the worktree)`;
    });
    return;
  }

  // story_advance phase=INIT_CHECK: after success, automatically call dev_start to create the worktree.
  // B-5246: when phase is already INIT_CHECK (retry scenario), allow dev_start to rerun without throwing
  // "Cannot transition INIT_CHECK->INIT_CHECK". This lets an agent retry after the first worktree creation failure.
  // can call story_advance INIT_CHECK again to retry without using the hidden manual dev_start path.
  if (cmd === 'story_advance' && (v.data as any)?.phase === 'INIT_CHECK') {
    await run(async () => {
      const storyId = (v.data as any).storyId;
      if ((v.data as any).dryRun === true) {
        const story: any = handlers.story_get({ storyId, detail: true });
        const currentPhase = story?.index?.phase || 'unknown';
        return [
          `[DRY-RUN] INIT_CHECK bootstrap plan for ${storyId}`,
          `- current phase: ${currentPhase}`,
          `- would verify init-check gate without mutating story metadata`,
          `- would create/update branch story/${storyId} with scoped story bootstrap files`,
          `- would create worktree under configured worktreeDir`,
          `- no phase, branch, commit, or worktree changes were made`,
        ].join('\n');
      }
      // B-804c CHK-001: make the INIT_CHECK phase write ATOMIC with the worktree
      // bootstrap (Option A — defer the write). The old order persisted
      // phase=INIT_CHECK FIRST and only then ran dev_start; a failed bootstrap
      // left phase=INIT_CHECK with no worktree and no INIT_CHECK->INIT back-edge
      // (unrecoverable). New order: bootstrap FIRST against the still-INIT story,
      // and persist phase=INIT_CHECK ONLY after dev_start succeeds. On bootstrap
      // failure we do NOT advance, so the story stays at its prior phase (INIT).
      //
      // Detect the current phase to choose the branch:
      //   - currentPhase === INIT_CHECK (B-5246 legacy victim retry): the phase is
      //     ALREADY persisted, so we never re-advance (no INIT_CHECK->INIT_CHECK);
      //     just (re)run dev_start to bootstrap the missing worktree.
      //   - currentPhase === INIT (the normal case): run dev_start against the
      //     still-INIT story; only advance the phase AFTER bootstrap succeeds.
      // story_get returns {checklist, review} by default; phase requires
      // detail:true to appear at result.index.phase.
      let alreadyInitCheck = false;
      try {
        const story: any = handlers.story_get({ storyId, detail: true });
        alreadyInitCheck = story?.index?.phase === 'INIT_CHECK';
      } catch {
        // story_get failed: we cannot prove the phase is INIT_CHECK, so
        // alreadyInitCheck stays false and the normal path (guard pre-check +
        // bootstrap + advance) runs — the safe behavior.
      }

      // B-804c CHK-001: validate the FULL INIT→INIT_CHECK transition guard BEFORE
      // bootstrapping. Deferring the phase write must not also defer (or weaken)
      // the gate: dev_start only enforces the scope-anti-expansion freeze gate,
      // which is a STRICT SUBSET of the INIT_CHECK transition gate (it also
      // requires a valid init-check.json — the lattice-review-story-init evidence).
      // If we bootstrapped on dev_start's subset gate alone, a story with passing
      // scope-freeze but missing init-check could create a worktree (and the exact
      // failure diagnostic would regress from [missing_init_check] to a scope
      // message). getGuardFailureReason returns null for a non-INIT story, so this
      // is a no-op for the already-INIT_CHECK retry path. The gate runs whenever
      // the story is not already INIT_CHECK — including the case where story_get
      // threw and alreadyInitCheck stayed false (closing B-804c:F-002): without
      // this pre-check that path ran dev_start FIRST with no gate, so a succeeding
      // bootstrap followed by a story_advance that failed its own gate could leave
      // a worktree on disk while the phase stayed INIT — a partial bootstrap.
      // Running the full INIT_CHECK transition guard here means dev_start never
      // bootstraps ahead of the INIT_CHECK gate, so there is no path that creates a
      // worktree without the phase advancing.
      if (!alreadyInitCheck) {
        const guardFailure = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
        if (guardFailure) {
          throw new Error(
            `${guardFailure}\n\n` +
            `INIT_CHECK aborted: Story ${storyId} stays at INIT (phase not advanced; no worktree created).`,
          );
        }
      }

      // Gate passed. Bootstrap FIRST (against the still-INIT story for the normal
      // case, or the already-INIT_CHECK story for the retry case). If this throws,
      // the phase is NOT advanced and the story stays put — no partial advance. We
      // RE-THROW the abort (rather than returning a warning string) so the command
      // exits non-zero: a failed bootstrap is a real failure, and the old exit-0
      // "advanced + ⚠ warning" output is exactly what masked this bug.
      let wtResult: string;
      try {
        wtResult = handlers.dev_start({ storyId });
      } catch (e: any) {
        throw new Error(
          `INIT_CHECK aborted: ${e.message}\n` +
          `Story ${storyId} stays at ${alreadyInitCheck ? 'INIT_CHECK' : 'INIT'} (phase not advanced; no worktree created).\n` +
          `Next: fix the cause, then re-run lattice story_advance --phase=INIT_CHECK, ` +
          `or run lattice dev_start '{"storyId":"${storyId}"}' to bootstrap directly.`,
        );
      }

      // Bootstrap succeeded. Persist phase=INIT_CHECK now (only when the story is
      // not already INIT_CHECK; an already-INIT_CHECK retry must never re-advance).
      // There is no separate fallback branch: if story_get failed above,
      // alreadyInitCheck is false and we take the normal advance path here.
      let advanceResult: string;
      if (alreadyInitCheck) {
        advanceResult = `Story ${storyId} is already in INIT_CHECK; bootstrapped worktree`;
      } else {
        // Normal case: persist the phase via the real story_advance handler,
        // which re-runs the same guard.
        advanceResult = await handlers.story_advance(v.data);
      }

      // B-f60c CHK-002: close F-008. dev_start leaves an uncommitted
      // story-metadata mirror in the main checkout that blocks the DONE
      // `git merge story/<id>`. Commit it on the base branch (mirroring the
      // metadata-commit part of the from-draft path) so DONE has nothing
      // uncommitted to collide with. Final order (B-804c): dev_start (success)
      // -> story_advance (persist phase) -> commitInitCheckMetadata.
      let syncResult = '';
      if (gitReady) {
        syncResult = commitInitCheckMetadataAndMergeMain(root, store, storyId);
      }
      const syncSegment = syncResult ? `\n\n${syncResult}` : '';
      return `${advanceResult}\n\n${wtResult}${syncSegment}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN`;
    });
    return;
  }

  // B-a2f1 CHK-003: recover_evidence — handler always returns a structured result;
  // CLI wrapper prints the result to stdout, then throws on non-pass so runCli's
  // catch branch sets process.exitCode=1. The same pattern as the validate gate
  // dispatcher (verifier.ts:482) — keeps the handler pure for in-process tests.
  if (cmd === 'recover_evidence') {
    const handler = handlers[cmd];
    if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }
    await run(async () => {
      const r = await handler(v.data);
      if (r && typeof r === 'object' && (r.status === 'refused' || r.status === 'fail')) {
        // Print structured result first so the user sees the refused/fail diagnosis,
        // then throw a one-line error message that runCli renders on stderr.
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        const msg = r.status === 'refused'
          ? (r.refused?.reason || 'recover_evidence refused')
          : 'recover_evidence: validate failed after refresh; inspect validateTranscript for details';
        throw new Error(msg);
      }
      return r;
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(
    isAutopilotCommand(cmd)
      ? parsed
      : (v.data as Record<string, unknown>),
  ));
}
