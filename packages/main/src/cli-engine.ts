/**
 * koala CLI engine
 *
 * Wraps the common logic (dispatch / parse / log / phase gate) into a callable
 * runCli function. main's own cli.ts is the bin entrypoint and calls runCli()
 * directly; third-party bootstrap scripts can merge their tools and handlers
 * via runCli({extraTools, extraRegister}).
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { isAbsolute, join } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns } from './core/config.js';
import { formatCommandLifecycleHint } from './core/command-policy.js';
import { decorateResult, type ActiveStoryInfo } from './handlers/hints.js';
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

// ── Tool Registry ──

export interface ToolDef {
  name: string;
  /** One-line description (shown in the lattice help list) */
  description: string;
  /** Full PROMPT (shown in lattice <cmd> --help). Optional; only the description is shown when omitted */
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
  id: z.string().optional().describe('Optional stable id; auto-derived as CHK-001:happy:0 when omitted'),
  desc: z.string().describe('Verification intent description'),
  type: verificationIntentTypeSchema.describe('Verification type'),
  requiredIn: z.enum(['light', 'balanced', 'strict']).optional().describe('Workflow profile from which this becomes required'),
  priority: z.enum(['must', 'should', 'nice']).optional().describe('must items participate in the evidence gate'),
});

/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title automated interface owns workflow extension
 * @type feature
 * @priority high
 * @description
 *   Koala exposes code/story operations through a managed automated interface:
 *   people and AI both go through CLI schemas, command gates, handlers, and logs.
 *   Superpowers can trigger workflow by registering extra tools and handlers, but
 *   main command definitions win because MAIN_TOOLS are searched before extras.
 *   More precisely: code should be managed through an automated interface, and humans and AI both operate on code via that interface.
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
]).describe('Evidence type; aliases: cli→manual_transcript, logic→logic_test');

const verificationEvidenceSchema = z.object({
  intentRef: z.string().describe('e.g. CHK-001:happy:0 or a custom intent id'),
  kind: verificationEvidenceKindSchema,
  verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate'),
  waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, may mark this as temporary gate self-test evidence; subsequent validate runs will require replacing it with real evidence'),
  file: z.string().optional().describe('Test or documentation file path'),
  command: z.string().optional().describe('Command to execute'),
  result: z.enum(['pass', 'fail']).optional().describe('Execution result'),
  note: z.string().describe('Why this evidence covers the intent'),
  headHash: z.string().optional().describe('git HEAD at the time the evidence was recorded'),
  materialHash: z.string().optional().describe('Hash of non-story-metadata material files at the time the evidence was recorded'),
  timestamp: z.string().optional().describe('Record timestamp'),
});

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

/** main's built-in CLI tool definitions */
export const MAIN_TOOLS: ToolDef[] = [
  // Story
  { name: 'story_create', description: 'Create a Story entry', longHelp: STORY_CREATE_LONG, schema: {
    name: z.string().optional().describe('Short name'),
    title: z.string().optional().describe('Title'),
    description: z.string().optional().describe('Description'),
    type: storyTypeSchema.optional().describe('Type; test is normalized to chore'),
    priority: z.string().optional().describe('Priority'),
    source: z.string().optional().describe('Source'),
    depends: z.array(z.string()).optional().describe('Dependent Story IDs'),
    keywords: z.array(z.string()).optional().describe('Keywords (domain / module / concept, used for duplicate detection)'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional(), relatedDocs: z.array(z.string()).optional().describe('Related document paths (used for the three reminders)'), userSees: z.string().optional().describe('User-visible output'), excludes: z.array(z.string()).optional().describe('Feature points explicitly declared out of scope'), verificationIntent: verificationIntentSchema.optional().describe('happy / edge / adversarial verification intents') })).optional().describe('Development checklist'),
    prefix: z.string().optional().describe('ID prefix (default B)'),
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).optional().describe('Directly specify the phase'),
    forceNew: z.boolean().optional().describe('B-0af4: bypass same-name story idempotency and force creation (an unfinished same-name story is reused by default)'),
    background: z.string().optional().describe('B-45ed CHK-006: four-section background.md content. Must contain "## Trigger Event" / "## Key Insight" / "## Tradeoffs" / "## Conversation Texture", each ≥ 50 characters, total length ≥ 300; the Trigger Event section must contain a concrete identifier (B-xxxx / F-xxx / CHK-xxx / commit hash / YYYY-MM-DD). Not required in fromDraft mode'),
    fromDraft: z.string().optional().describe('B-9975: create a story from a reviewed draft (pass the draft name). After the three-layer gate check, enters INIT_CHECK directly'),
  }},
  { name: 'story_advance', description: 'Advance the Story to the next phase', longHelp: STORY_ADVANCE_LONG, schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).describe('Target phase'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('Development checklist'),
    dryRun: z.boolean().optional().describe('Only preview the INIT_CHECK bootstrap; do not advance the phase or create a worktree'),
    confirm: z.boolean().optional().describe('Confirm side-effecting advancement (kept for script compatibility)'),
  }},
  { name: 'story_update', description: 'Edit Story metadata', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'), priority: z.string().optional().describe('New priority'),
  }},
  { name: 'story_get', description: 'Read Story details', schema: { storyId: z.string().describe('Story ID'), detail: z.boolean().optional().describe('Include the full index.json fields (phase / priority / name / description / ...) under result.index') }},
  { name: 'story_resolve', description: 'Resolve Story context, current phase, and authoritative working directory for plannedSteps. Alias: lattice story resolve', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'story_list', description: 'List all Stories', schema: {
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE','DISCARDED']).optional().describe('Filter by phase (mutually exclusive with active)'),
    active: z.boolean().optional().describe('Only list non-terminal stories (excluding DONE / DISCARDED / IDEA). Added in B-89c7 CHK-016'),
  }},
  { name: 'story_reconcile', description: 'Detect and repair zombie stories / terminal worktree residue (dry run by default)', schema: {
    dryRun: z.boolean().optional().describe('true = report only; false = perform repair (default true)'),
  }},
  { name: 'story_discard', description: 'Discard a Story: clean up the worktree / branch and mark it as DISCARDED', schema: {
    storyId: z.string().describe('Story ID'),
    reason: z.string().optional().describe('Discard reason (written to the event log)'),
    force: z.boolean().optional().describe('Force-discard uncommitted changes'),
    purge: z.boolean().optional().describe('Temporary-story only: delete story metadata and, when safe, revert the pure-metadata init commit'),
  }},

  // Draft (B-9975: iterate on story shape before formal story_create)
  { name: 'story_draft', description: 'Create a draft without assigning a B-xxxx id; writes to docs/story/drafts/<name>/', schema: {
    name: z.string().describe('Short name (alphanumeric plus hyphens, 3-60 characters)'),
    title: z.string().describe('Title (≥ 5 characters)'),
    description: z.string().describe('Description (≥ 5 characters)'),
    type: storyTypeSchema.describe('Type; test is normalized to chore'),
    priority: z.string().describe('Priority'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional() })).describe('Development checklist (≥ 1 item)'),
    background: z.string().describe('Four-section background.md content (required; same validation as story_create)'),
    keywords: z.array(z.string()).optional().describe('Keywords'),
  }},
  { name: 'story_draft_list', description: 'List all drafts', schema: {} },
  { name: 'story_draft_discard', description: 'Delete a draft', schema: {
    name: z.string().describe('Draft name to delete'),
  }},
  { name: 'draft_check_set', description: 'Save draft check results (called by reviewers; signs the draft background + checklist)', schema: {
    draftName: z.string().describe('Draft name'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Optional reviewer-assigned id (for example INIT-001); auto-assigned when omitted'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character').describe('Concrete issue description'),
    })).describe('Issues raised by the reviewer (empty array allowed)'),
    agentId: z.string().optional().describe('Reviewer self-reported agent id, used only for audit traceability'),
  }},
  { name: 'draft_issue_resolve', description: 'Record a resolution for a draft-check issue (≥ 20 characters)', schema: {
    draftName: z.string().describe('Draft name'),
    issueId: z.string().describe('Issue ID (for example INIT-001)'),
    resolution: z.string().min(20, 'resolution must be at least 20 characters').describe('Written resolution conclusion'),
  }},

  // Review
  { name: 'story_review', description: 'Adversarially review checklist completeness', longHelp: STORY_REVIEW_LONG, schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'story_review_dismiss', description: 'Dismiss a false-positive riskSignal category (B-5010)', schema: {
    storyId: z.string().describe('Story ID'),
    category: z.string().describe('riskSignal.category to dismiss (for example "state machine/gate" or "test runner framework")'),
    reason: z.string().describe('Dismissal reason (≥ 5 characters; explain why this signal is a false positive for this story)'),
  }},
  { name: 'testintent_handoff', description: 'Generate a test-intent agent handoff pack (PLAN phase)', schema: {
    storyId: z.string().describe('Story ID'),
    itemIds: z.array(z.string()).optional().describe('Only hand off the specified checklist item IDs; defaults to all items'),
  }},

  // Checklist
  { name: 'checklist_get', description: 'Read the checklist', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'checklist_add', description: 'Append a checklist item to an existing story', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().describe('What to do (one sentence)'),
    context: z.string().optional().describe('Root cause or reference approach'),
    relatedDocs: z.array(z.string()).optional().describe('Related document paths (used for the three reminders)'),
    userSees: z.string().optional().describe('Concrete terminal/UI text the user sees after this item is complete'),
    excludes: z.array(z.string()).optional().describe('Feature points explicitly declared out of scope'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: affected file set (declared in PLAN; story_review validates touchpoints-to-files coverage)'),
    verificationIntent: verificationIntentSchema.optional().describe('happy/edge/adversarial verification intents (PLAN phase)'),
    reason: z.string().optional().describe('Required replan/scope-audit reason when adding an item during PLAN (≥10 characters)'),
  }},
  { name: 'checklist_remove', description: 'Remove a checklist item from a story (requires disposition + reason)', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('Item ID to remove'),
    disposition: z.enum(['accept', 'reject', 'partial']).describe('Disposition: accept=deletion is valid / reject=should not be deleted but remove anyway / partial=partly valid'),
    justification: z.string().describe('Removal reason (≥10 characters)'),
  }},
  { name: 'checklist_update', description: 'Update a checklist item (status/relatedDocs; title/context freeze from PLAN, userSees freezes from DEV)', longHelp: CHECKLIST_UPDATE_LONG, schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('Item ID'),
    status: z.enum(['pending','in_progress','done']).optional().describe('New status'),
    title: z.string().optional().describe('New title (frozen from PLAN onward)'),
    context: z.string().optional().describe('New context (frozen from PLAN onward)'),
    relatedDocs: z.array(z.string()).optional().describe('Related document paths (used for the three reminders)'),
    userSees: z.string().optional().describe('Concrete terminal/UI text the user sees after this item is complete (editable before PLAN, frozen from DEV onward)'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: affected file set (declared in PLAN)'),
    verificationIntent: verificationIntentSchema.optional().describe('happy/edge/adversarial verification intents (frozen from DEV onward)'),
    verificationEvidence: z.array(verificationEvidenceSchema).optional().describe('Evidence list covering verificationIntent'),
    reason: z.string().optional().describe('Change reason'), agent: z.string().optional().describe('Actor'),
    success: z.boolean().optional().describe('Whether the subagent result succeeded (only valid when status=done; default true)'),
  }},
  { name: 'verification_evidence_add', description: 'Append or update verificationIntent coverage evidence for a checklist item', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID'),
    intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent id'),
    kind: verificationEvidenceKindSchema,
    verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate'),
    waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, may mark this as temporary gate self-test evidence'),
    file: z.string().optional().describe('Test or documentation file path'),
    command: z.string().optional().describe('Command to execute'),
    result: z.enum(['pass', 'fail']).optional().describe('Execution result'),
    note: z.string().describe('Why this evidence covers the intent'),
  }},
  { name: 'verification_evidence_batch_add', description: 'Batch append or update verificationIntent coverage evidence (avoids losing evidence during concurrent checklist writes)', schema: {
    storyId: z.string().describe('Story ID'),
    evidences: z.array(z.object({
      itemId: z.string().describe('Checklist item ID'),
      intentRef: z.string().describe('For example CHK-001:happy:0 or a custom intent id'),
      kind: verificationEvidenceKindSchema,
      verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('Evidence verdict semantics; does not override the result pass/fail gate'),
      waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('When kind=waiver, may mark this as temporary gate self-test evidence'),
      file: z.string().optional().describe('Test or documentation file path'),
      command: z.string().optional().describe('Command to execute'),
      result: z.enum(['pass', 'fail']).optional().describe('Execution result'),
      note: z.string().describe('Why this evidence covers the intent'),
    })).describe('Evidence array; reads/writes the checklist once in this call'),
  }},
  { name: 'verification_evidence_refresh_stale', description: 'Refresh stale verificationEvidence HEAD/material hashes (rerun the corresponding verification command first)', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('Only report stale evidence that would be refreshed; do not write'),
  }},
  { name: 'verification_context_pack_create', description: 'Mechanically generate a Verification Context Pack from the current git diff (for verifier jobs/Runners)', schema: {
    producerRunId: z.string().min(1).describe('Implementer run id'),
    storyId: z.string().optional().describe('Story ID'),
    baseRef: z.string().optional().describe('diff base ref, default HEAD'),
    headRef: z.string().optional().describe('diff head ref; default WORKTREE means uncommitted working tree'),
    packId: z.string().optional().describe('Explicit pack id; defaults to a stable id generated from the diff'),
    checklistItemIds: z.array(z.string()).optional().describe('Checklist item IDs associated with this pack'),
    testIntentRefs: z.array(z.string()).optional().describe('verificationIntent refs this pack must cover'),
    acceptanceCriteria: z.array(z.string()).optional().describe('Acceptance criteria summary'),
    requiredRefs: z.array(z.string()).optional().describe('Additional required refs'),
    requiredCommands: z.array(VerificationCommandContractSchema).optional().describe('Command constraints the verifier must execute/cover'),
    oracleRefs: z.array(z.string()).optional().describe('oracle refs'),
    tokenBudget: z.number().int().nonnegative().optional().describe('source snippets token budget'),
    excludedPaths: z.array(z.string()).optional().describe('Excluded paths, included in the pack for audit'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
  }},
  { name: 'verification_context_pack_expand', description: 'Generate a controlled expansion pack from a parent pack (must explain the expansion reason)', schema: {
    parentPack: VerificationContextPackContractSchema.describe('Previous Verification Context Pack'),
    packId: z.string().optional().describe('New pack id'),
    expansionReason: z.string().min(10).describe('Expansion reason (≥10 characters)'),
    impactedFiles: z.array(z.string()).optional().describe('Additional impacted files'),
    impactedSymbols: z.array(ContextPackSymbolContractSchema).optional().describe('Additional impacted symbols'),
    sourceSnippets: z.array(ContextPackSnippetContractSchema).optional().describe('Additional source snippets'),
    dependencyEdges: z.array(ContextPackDependencyEdgeContractSchema).optional().describe('Additional dependency edges'),
    requiredRefs: z.array(z.string()).optional().describe('Additional required refs'),
    tokenBudget: z.number().int().nonnegative().optional().describe('New token budget'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
  }},
  // B-a2f1 CHK-003: single-shot recover — refresh stale evidence + revalidate.
  { name: 'recover_evidence', description: 'Single-shot recover: refresh stale evidence + revalidate (allowed only when the worktree contains only koala metadata / runtime / declared artifacts)', schema: {
    storyId: z.string().min(1).describe('Story ID'),
  }},
  // B-cf60: per-story declared product artifact — register a generated path so
  // the dirty-worktree classifier groups it under declared_artifact_changes
  // instead of unexpected_dirty_files. DONE gate then checks every declared
  // path is referenced from verificationEvidence or delivery-check.docsPromises.
  { name: 'artifact_declare', description: 'Declare a generated path as an expected output for this story, classify it as declared_artifact_changes, and require matching verificationEvidence/promise references at the DONE gate', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    path: z.string().min(1).describe('Exact path relative to the repository root (no glob/wildcards, no leading slash, no .. segments)'),
    reason: z.string().min(10, 'reason ≥ 10 characters').describe('Why this file is an expected output for the story'),
    relatedIntent: z.string().min(1).describe('Related reference: CHK-NNN:(happy|edge|adversarial):IDX or promise:<docPath>'),
  }},
  { name: 'light_review', description: 'Record a lightweight review (called after each batch of DEV items is completed)', schema: {
    storyId: z.string().describe('Story ID'),
    checklistIds: z.array(z.string()).describe('Checklist item IDs covered by this review'),
    note: z.string().optional().describe('Review note'),
  }},
  { name: 'review_run_start', description: 'Start a reviewer run for the current REVIEW round and write signed review-runs.json', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent id (for example koala-review-quality; defaults to KOALA_AGENT)'),
    lane: z.enum([
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
      'koala-review-behavior',
      'koala-review-docs',
      'koala-review-channel',
    ]).optional().describe('Explicit reviewer lane; synonymous with agent, pass only one'),
    prompt: z.string().optional().describe('Actual prompt text received by the reviewer; promptHash is computed automatically when provided'),
    promptHash: z.string().optional().describe('sha256 of the reviewer prompt; when prompt is also provided, it must match the actual prompt hash'),
    reviewedIntentRefs: z.array(z.string()).optional().describe('Scope-protected story: verification intent refs checked by this reviewer round (optional; counted in scope binding)'),
  }},
  { name: 'review_pass_set', description: 'Record pass evidence that a reviewer inspected the scope and found no blocking findings', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('Reviewer agent id (for example koala-review-quality; defaults to KOALA_AGENT)'),
    reviewRunId: z.string().describe('Current reviewer run id (obtain it by calling review_run_start first)'),
    note: z.string().describe('Reviewed scope and why there are no blockers (≥10 characters)'),
  }},

  // Understanding (Pre-context Intake snapshot, OMX style)
  { name: 'understanding_set', description: 'Record a PLAN-phase task understanding snapshot (task/outcome/facts/constraints/unknowns/touchpoints)', schema: {
    storyId: z.string().describe('Story ID'),
    task: z.string().describe('One-sentence description of the problem to solve'),
    outcome: z.string().describe('Observable change after completion'),
    facts: z.array(z.string()).describe('Known facts'),
    constraints: z.array(z.string()).describe('Constraints'),
    unknowns: z.array(z.string()).describe('Unknowns that should be resolved before splitting the checklist'),
    touchpoints: z.array(z.string()).describe('Likely code touchpoints'),
  }},
  { name: 'understanding_get', description: 'Read the understanding snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Decision (RALPLAN-DR structured decision, OMX ralplan style)
  { name: 'decision_set', description: 'Record a PLAN-phase structured decision (principles/drivers/options/chosen/preMortem)', schema: {
    storyId: z.string().describe('Story ID'),
    principles: z.array(z.string()).describe('3-5 design principles'),
    drivers: z.array(z.string()).describe('Top 3 key constraints'),
    options: z.array(z.object({
      name: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    })).describe('≥ 2 options with pros/cons'),
    chosen: z.string().describe('Chosen option.name'),
    rationale: z.string().describe('Selection rationale (≥ 10 characters)'),
    preMortem: z.array(z.object({
      scenario: z.string(),
      trigger: z.string(),
      consequence: z.string(),
      mitigation: z.string(),
    })).optional().describe('Pre-mortem failure scenarios (high-risk stories require ≥ 3)'),
  }},
  { name: 'decision_get', description: 'Read the decision snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Grill planning artifact (PLAN context only; not verification/validation evidence)
  { name: 'grill_start', description: 'Start a PLAN grill clarification session (writes grill.json, not evidence)', schema: {
    storyId: z.string().describe('Story ID'),
    topic: z.string().optional().describe('Topic or focus for this grill round'),
  }},
  { name: 'grill_record', description: 'Record a grill question and answer (unresolved if no answer is provided)', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID; defaults to the latest open session'),
    question: z.string().describe('Clarifying question'),
    answer: z.string().optional().describe('Answer; recorded as unresolved when omitted'),
    status: z.enum(['answered', 'unresolved']).optional().describe('Question status; defaults based on whether answer exists'),
    source: z.string().optional().describe('Optional source, such as user / reviewer / implementer'),
  }},
  { name: 'grill_close', description: 'Close a grill session and return remainingUnknowns', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID; defaults to the latest open session'),
    note: z.string().optional().describe('Close note'),
    closedBy: z.string().optional().describe('Closer identifier'),
  }},
  { name: 'grill_get', description: 'Read the grill planning artifact', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Read only the specified grill session'),
  }},
  // Summary (B-093b: DONE-gate forced completion summary)
  { name: 'summary_set', description: 'Required before DONE: story completion summary (changes/usage/user acceptance/limitations/pitfalls + automatically scanned real-machine coverage skeleton)', schema: {
    storyId: z.string().describe('Story ID'),
    changes: z.string().describe('What changed (key per-file changes from the user perspective, ≥ 10 characters)'),
    usage: z.string().describe('How to use it (slash/tool/call examples, ≥ 10 characters)'),
    expectedOutcome: z.string().optional().describe('Required by DONE gate: expected user-visible result / expected transcript (≥ 10 characters)'),
    actualTranscript: z.string().optional().describe('Required by DONE gate: actual user-visible transcript / output summary (≥ 10 characters)'),
    outcomeDiff: z.string().optional().describe('Required by DONE gate: expected vs actual difference; explicitly say if there is no difference (≥ 5 characters)'),
    acceptanceVerdict: z.enum(['accepted', 'partial', 'rejected']).optional().describe('Required by DONE gate: user-value acceptance verdict'),
    outcomeKind: z.enum(STORY_OUTCOME_KINDS).optional().describe('DONE outcome classification: success / blocked / audit_only'),
    limitations: z.string().describe('Known limitations / design deviations (write "none — fully covered" when there are none)'),
    pitfalls: z.string().describe('Pitfall log (where it got stuck, how many retries, what the next person should know, ≥ 10 characters; no empty boilerplate)'),
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason}; explain every sandbox:false case that was not run. If omitted, Lattice reports missing items'),
  }},
  { name: 'summary_get', description: 'Read the story summary', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Bug
  { name: 'bug_report', description: 'Report a bug', longHelp: BUG_REPORT_LONG, schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    title: z.string().describe('Description'), checklistId: z.string().optional().describe('Related checklist ID'),
  }},
  { name: 'bug_update', description: 'Update bug status', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    status: z.enum(['open','fixed']).describe('New status'),
    evidence: z.object({
      symptom: z.string().describe('User-observable symptom'),
      reproSteps: z.array(z.string()).describe('Minimal reproduction steps'),
      hypothesis: z.string().optional().describe('Verified hypothesis'),
      rootCause: z.string().describe('Confirmed root cause'),
      fixEvidence: z.string().describe('Fix evidence description'),
      reproTest: z.string().optional().describe('Reproduction test path'),
    }).optional().describe('Debug evidence chain (recommended when marking fixed)'),
  }},
  { name: 'bug_list', description: 'View bug list (global summary when storyId is omitted)', schema: { storyId: z.string().optional().describe('Story ID; omitted means list bugs for all stories') }},
  { name: 'bug_analyze', description: 'Cross-story bug quality dashboard (markdown/json)', schema: {
    format: z.enum(['json','markdown']).optional().describe('Output format (default json)'),
  }},

  // Test
  { name: 'test_add', description: 'Record test evidence', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('TE ID'),
    scenario: z.string().describe('Scenario'), command: z.string().describe('Command'),
    output: z.string().describe('Output'), expected: z.string().describe('Expected result'),
    result: z.enum(['PASS','FAIL']).describe('Result'),
  }},
  { name: 'test_list', description: 'View the latest test evidence snapshot (currently not a history list)', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'fixture_get', description: 'Read a fixture file', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json'),
  }},
  { name: 'fixture_update', description: 'Replace fixture cases (compatibility maintenance command)', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('Complete cases array'),
  }},
  { name: 'fixture_batch_add', description: 'Batch append fixture cases (supports executor / command / legacy execute)', schema: {
    fixturePath: z.string().describe('Fixture path relative to fixturesDir, without .json'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('Cases to append'),
    storyId: z.string().optional().describe('Used to auto-fill the intentRef story prefix'),
    dryRun: z.boolean().optional().describe('Preview only; do not write'),
    validateExecute: z.boolean().optional().describe('Pre-execute CLI cases before appending'),
  }},
  { name: 'test_auto', description: 'Legacy full fixture regression (real execution requires confirm; dryRun previews)', schema: {
    storyId: z.string().optional().describe('Deprecated; for current-story verification, use lattice validate --story=<storyId> and record verificationEvidence'),
    trace: z.boolean().optional().describe('Collect trace'),
    enableProfiler: z.boolean().optional().describe('Enable profiler'),
    dryRun: z.boolean().optional().describe('Only print the execution plan'),
    confirm: z.boolean().optional().describe('Confirm side-effecting full regression execution'),
  }},
  { name: 'test_story', description: 'Filter by story and run related fixture cases', schema: {
    storyId: z.string().describe('Story ID'),
    trace: z.boolean().optional().describe('Collect trace'),
  }},
  { name: 'test_fixture', description: 'Run a single case or chain by fixtureId', schema: {
    fixtureId: z.string().describe('fixture case _id'),
  }},
  { name: 'task_coverage', description: 'Check coverage between story checklist and code task metadata', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID or array of Story IDs'),
  }},

  // Truth / Gap
  { name: 'truth_scan', description: 'Scan truth-source directories and extract requirements/decisions/constraints/questions', schema: {
    summary: z.boolean().optional().describe('Return statistics summary only'),
  }},
  { name: 'truth_nav', description: 'Generate truth-source navigation', schema: {} },
  { name: 'truth_analyze', description: 'Analyze contradictions, ambiguities, and gaps in truth sources', schema: {} },
  { name: 'truth_to_story', description: 'Extract candidate stories from truth sources', schema: {} },
  { name: 'truth_extract', description: 'Extract requirements documents from code metadata', schema: {} },
  { name: 'gap_analyze', description: 'Compare truth sources against code reality and output a gap report', schema: {} },
  { name: 'convergence_check', description: 'Decide whether the project has converged (requirements covered, tests pass, no gaps)', schema: {} },
  // Dashboard (live board)
  { name: 'dashboard', description: 'Live story progress dashboard (refreshes every N seconds, supports multiple projects)', schema: {
    roots: z.string().optional().describe('Project roots (comma-separated paths; defaults to current directory)'),
    interval: z.number().optional().describe('Refresh interval in seconds (default 5)'),
  }},
  { name: 'session_brief', description: 'Cross-session opening brief (active story / phase / checklist / bugs / next step)', schema: {
    concise: z.boolean().optional().describe('Concise mode (default false)'),
  }},
  { name: 'next', description: 'Print only the most trustworthy current next step (reuses session_brief authoritative phase judgment)', schema: {
    concise: z.boolean().optional().describe('Concise mode (default true)'),
  }},
  { name: 'capsule_show', description: 'Show the story session capsule (projected state, not gate evidence)', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
    strict: z.boolean().optional().describe('Hard fail when references are missing'),
  }},
  { name: 'capsule_update', description: 'Create/update a story session capsule projection', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    rebuild: z.boolean().optional().describe('Rebuild the base capsule from story/checklist/process-events'),
    summary: z.string().optional().describe('Summary'),
    nextAction: z.string().optional().describe('Next action'),
    currentChecklistId: z.string().optional().describe('Current checklist item'),
    activeRunId: z.string().optional().describe('Current/recent run id'),
    openBlockers: z.array(z.string()).optional().describe('Open blocker summaries'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('Evidence refs'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events refs'),
    strict: z.boolean().optional().describe('Refuse to write when references are missing'),
  }},
  { name: 'capsule_handoff', description: 'Write handoff.md and update the capsule next action', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    nextAction: z.string().describe('Next action'),
    notes: z.string().optional().describe('Handoff notes'),
    openBlockers: z.array(z.string()).optional().describe('Open blocker summaries'),
  }},
  { name: 'capsule_run_add', description: 'Record story capsule run summary and metrics', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    runId: z.string().optional().describe('Run ID'),
    checklistId: z.string().optional().describe('Related checklist item'),
    provider: z.string().optional().describe('CLI/provider, such as codex/claude-code/gemini'),
    model: z.string().optional().describe('Model'),
    vendor: z.string().optional().describe('Vendor'),
    role: z.enum(['implementer', 'reviewer', 'tester', 'verifier', 'main', 'other']).optional().describe('Run role'),
    result: z.enum(['pass', 'fail', 'blocked', 'unknown']).optional().describe('Run result'),
    commands: z.array(z.string()).optional().describe('Executed command summary'),
    transcript: z.string().optional().describe('Key transcript excerpt'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('Evidence refs'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events refs'),
    metrics: z.record(z.string(), z.unknown()).optional().describe('Metrics summary'),
    artifacts: z.record(z.string(), z.unknown()).optional().describe('Artifact summary'),
  }},
  { name: 'aux_doc_list', description: 'List project documents (used to choose relatedDocs during PLAN)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_list', description: 'List host-neutral Koala capability profiles and degradations (text/json)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_probe', description: 'Probe one host-neutral Koala capability profile and visible degradations (text/json)', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
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
  { name: 'host_install', description: 'Show dry-run Lattice host install guidance only; no third-party installs are executed. Alias: lattice host install', schema: {
    host: z.string().describe('Host profile id to show guidance for'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'lattice_config_doctor', description: 'Report Lattice CLI 0.3.5 migration readiness and Mac App demotion status (text/json). Alias: lattice config doctor', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'rollout_check', description: 'Run read-only cross-project Lattice rollout diagnostics for install drift, managed assets, runtime footprint, and transcript scope. Alias: lattice rollout check', schema: {
    projects: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated project paths or JSON array; omit to scan the current root'),
    maxDepth: z.number().optional().describe('Discovery depth when projects is omitted (default 1)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'authority_status', description: 'Report receipt-aware authority settings and enforce readiness diagnostics without submitting evidence or verifying receipts. Alias: lattice authority status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    authorityMode: z.string().optional().describe('Optional authority mode override for diagnostics only'),
    authorityURL: z.string().optional().describe('Optional authority URL override for diagnostics only'),
    authorityTimeoutMS: z.number().optional().describe('Optional authority timeout override for diagnostics only'),
  }},
  { name: 'conduit_status', description: 'Report Lattice conduit status and enforce readiness diagnostics without provisioning a runner or production authority. Alias: lattice conduit status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_explain', description: 'Explain the CLI conduit migration boundary and no-overclaim semantics. Alias: lattice conduit explain', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_export', description: 'Export a Koala Story as Canonical Story v0 without claiming production authority', schema: {
    storyId: z.string().describe('Story ID to export'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for canonical-story JSON'),
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

  // Doctor (health issue inspection)
  { name: 'doctor', description: 'Inspect Lattice health issues (PERSIST failures caught by silent catches) and scan .worktrees/ orphan directories', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    limit: z.number().optional().describe('Maximum entries to read (default 1000)'),
    repair: z.boolean().optional().describe('Clean DONE/DISCARDED terminal worktree registrations, orphan directories, and prunable metadata'),
  }},
  { name: 'done_recover', description: 'Recover a partial-DONE story whose phase is DONE but whose story branch has not merged into main', schema: {
    storyId: z.string().describe('Story ID to recover'),
  }},
  { name: 'verify_codex', description: 'Verify Codex adapter assets, entrypoint heartbeat, and hard evidence', schema: {
    json: z.boolean().optional().describe('Structured JSON output'),
    storyId: z.string().optional().describe('Optional Story ID; defaults to inferring from story/* branch and recording process-event evidence'),
  }},
  { name: 'check', description: 'Check Koala managed asset/template drift; --apply/--upgrade explicitly sync safe items', schema: {
    json: z.boolean().optional().describe('Structured JSON output'),
    apply: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets; never overwrite CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE'),
    upgrade: z.boolean().optional().describe('Sync MISSING/STALE_SAFE managed assets to current Koala templates; equivalent to --apply'),
    reviewLocalEdits: z.boolean().optional().describe('Output a structured human-review summary for STALE_LOCAL_EDIT items'),
    profile: z.enum(['codex', 'claude', 'all', 'core']).optional().describe('Override the auto-detected init profile'),
    assetMode: z.enum(['full', 'thin']).optional().describe('Override Codex prompt asset mode; full=generate .Codex/agents, thin=use prompt registry'),
  }},

  // Audit (framework self-audit: scan CLAUDE.md promises vs actual CLI behavior drift across stories)
  { name: 'audit', description: 'Framework self-audit (mechanically scans CLAUDE.md drift -> writes B-META-framework-audit finding + report.md)', schema: {
    framework: z.boolean().optional().describe('Scan CLI command/flag/path drift in CLAUDE.md / packages/koala/CLAUDE.md (currently the only MVP mode)'),
    mode: z.enum(['semi-auto', 'full-auto', 'off']).optional().describe('Override the configured default mode; off = exit immediately without running'),
  }},

  // Gap Log (B-3fad CHK-002: manual framework gap archival entrypoint)
  // Writes B-META-framework-audit findings (bootstrap ensureMetaStory if missing).
  // Does not depend on reviewer / review round / story worktree and does not
  // participate in lifecycle gates. Defaults evidenceState to suspected; verified
  // requires matching structured evidence (runtime uses the same standard validation).
  { name: 'gap_log', description: 'Manually archive a framework gap into the B-META-framework-audit backlog', schema: {
    category: z.enum(['happy', 'edge', 'adversarial', 'missing']).describe('Finding category'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Severity'),
    evidence: z.string().min(1, 'evidence is required and must be at least 1 character').describe('Gap description (the finding evidence note)'),
    sourceRefs: z.array(z.string()).optional().describe('Source trace: source/documentation locations (for example src/foo.ts:42)'),
    reproCommand: z.string().optional().describe('Source trace: reproduction/observation command'),
    observedOutput: z.string().optional().describe('Source trace: observed actual output'),
    analysisNote: z.string().optional().describe('Source trace: analysis note'),
    evidenceState: z.enum(['suspected', 'verified']).optional()
      .describe('Evidence state: default suspected; verified only when structured evidence is provided, otherwise forced back to suspected'),
    uncertaintyReason: z.string().optional().describe('Reason for suspicion when suspected (optional; defaults automatically)'),
    files: z.array(z.string()).optional().describe('Related file paths'),
    agent: z.string().optional().describe('Caller identity (audit field; defaults from KOALA_AGENT)'),
  }},

  // Verifier (built-in Koala code verification)
  { name: 'validate', description: 'Run project verification (static + logic + integration tests)', longHelp: VALIDATE_LONG, schema: {
    full: z.union([z.string(), z.boolean()]).optional().describe('Include real-machine tests (--full or --full=PvE to filter by name)'),
    story: z.string().optional().describe('Run only transitions touched by the story (used by TEST gate)'),
    json: z.boolean().optional().describe('Structured JSON output (ExternalVerifierResult)'),
    // B-9d95 CHK-006: REVIEW->TEST preflight CLI gate split flags.
    // Any matching flag runs only the corresponding CLI gate and skips spawning pytest.
    // Multiple flags run in parallel via Promise.all; any failure exits 1.
    channel: z.boolean().optional().describe('B-9d95: run only the --channel gate (commit author scan; requires --story)'),
    concept: z.boolean().optional().describe('B-9d95: run only the --concept gate (deleted-symbol residue scan)'),
    lint: z.boolean().optional().describe('B-9d95: run only the --lint gate (tsc + ruff + import-graph)'),
    noSync: z.boolean().optional().describe('Skip pre-validate cluster commit auto-resolve sync (diagnostics only)'),
  }},
  { name: 'status', description: 'Project overview (story progress + code verification status)', schema: {
    concise: z.boolean().optional().describe('Concise mode (skips code verification, < 4KB, intended for hook injection)'),
  }},
  { name: 'serve', description: 'Start the HTTP API debug service (watch files + live verification + browser proxy)', schema: {
    dev: z.string().optional().describe('Dev server command (for example "npm run dev"); enables browser proxy'),
    port: z.number().optional().describe('API port (default 3456)'),
  }},

  // Evaluate (AI evaluation for browser projects)
  { name: 'evaluate', description: 'Ask the evaluator agent to score a browser app (functional completeness + usability)', schema: {
    storyId: z.string().describe('Story ID'),
    port: z.number().optional().describe('lattice serve port (default 3456)'),
  }},
  { name: 'evaluate_save', description: 'Save evaluator scoring result to eval-evidence.json', schema: {
    storyId: z.string().describe('Story ID'),
    result: z.string().describe('JSON string output by the evaluator'),
  }},

  // Finding (koala-reviewer findings)
  { name: 'finding_add', description: 'Add a finding (koala-reviewer finding)', schema: {
    storyId: z.string().describe('Story ID'),
    desc: z.string().describe('Finding description'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Severity'),
    category: z.enum([
      'happy',
      'edge',
      'adversarial',
      'missing',
      'cleanup',
      'doc-promise-undelivered',
      'doc-code-drift',
      'spec-boundary',
    ]).describe('Category (legacy categories are normalized to missing)'),
    agent: z.string().optional().describe('Caller identity (optional; defaults from KOALA_AGENT environment variable)'),
    reviewRunId: z.string().optional().describe('Current koala-review-* reviewer run id (obtain via review_run_start; optional for main findings)'),
    files: z.array(z.string()).optional().describe('Related file paths (used for reviewer finding clustering and traceability)'),
    // B-3fad CHK-001: evidence-state axis. Omitted means verified by default
    // for REVIEW-phase reviewer findings to preserve existing gate behavior.
    // suspected requires uncertaintyReason; disproven requires disprovenEvidence.summary.
    evidenceState: z.enum(['suspected', 'verified', 'disproven']).optional()
      .describe('Evidence state: suspected (uncertain, non-blocking) / verified (default, evidenced, blocking) / disproven (counter-evidenced, non-blocking)'),
    uncertaintyReason: z.string().optional()
      .describe('Required when evidenceState=suspected (≥10 characters): why this is only suspected'),
    disprovenEvidence: z.object({
      summary: z.string().describe('Counter-evidence summary: why this finding is invalid'),
      sourceRefs: z.array(z.string()).optional().describe('Source/documentation refs used as counter-evidence'),
      reproCommand: z.string().optional().describe('Reproduction/verification command used for counter-evidence'),
    }).optional().describe('Required when evidenceState=disproven: counter-evidence summary + command + source refs'),
  }},
  { name: 'finding_list', description: 'View findings for a story', schema: {
    storyId: z.string().describe('Story ID'),
    cluster: z.boolean().optional().describe('B-9d95 CHK-005: return cluster view { clusters, ungrouped } instead of flat findings'),
  }},
  { name: 'finding_resolve', description: 'Mark a finding as resolved', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID (for example B-xxx:F-001)'),
    resolution: z.string().optional().describe('Optional: record concrete fix/verification evidence details'),
  }},
  { name: 'finding_dismiss', description: 'Confirm a finding will not be fixed (reason required)', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID (for example B-xxx:F-001)'),
    reason: z.string().describe('Reason for not fixing (≥10 characters)'),
  }},

  // Finding Cluster (B-e8c8 / B-9d95 CHK-005: automatic clustering + manual merge/split)
  //
  // No args (default mode): auto-cluster by files overlap >= 50% plus matching
  // severity, then write clusters.json + findings.clusterId.
  // merge: force the given finding id list into a new cluster.
  // split: delete the cluster and return members to singleton findings.
  // Phase availability matches finding_list: REVIEW/TEST.
  { name: 'finding_cluster', description: 'B-9d95: cluster findings (auto / merge / split) and output cluster summary', schema: {
    storyId: z.string().describe('Story ID'),
    merge: z.union([z.array(z.string()), z.string()]).optional().describe('Force-merge into a new cluster: finding id array or comma-separated string (F-001,F-002)'),
    split: z.string().optional().describe('Cluster ID to split (CL-xxx); members return to singleton findings'),
  }},

  // Init Check (B-e71f CHK-003: init reviewers write signed init-check.json)
  // INIT->INIT_CHECK hard gate artifact. EXP-001 disproved mechanical caller
  // verifiability, so agentId/agent remain self-reported. The gate verifies that
  // required reviewer names were recorded, so prompts must pass exact names.
  // Zod layer in the three-layer validation: severity enum + desc.min(1).
  { name: 'init_check_set', description: 'Save init check results (called by INIT reviewers)', schema: {
    storyId: z.string().describe('Story ID'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Optional reviewer-assigned id (for example I-1)'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character').describe('Concrete issue description (reviewer judgment must be specific)'),
    })).describe('Issues raised by the reviewer; critical/high block INIT_CHECK, empty array allowed'),
    agent: z.string().optional().describe('Reviewer self-reported agent name; product-reviewer must pass product-reviewer'),
    agentId: z.string().optional().describe('Reviewer self-reported agent id; product-reviewer must pass product-reviewer, not koala-review-story-init'),
  }},

  // Init Check fallback/repair (B-95d8 CHK-001: explicit, auditable INIT_CHECK exit
  // for environments that cannot spawn the init reviewer subagent).
  // Default-disabled: refuses without BOTH acknowledge=true AND fallbackReason (>=30).
  // Reuses signInitCheck — does NOT weaken the gate or add agentId identity checks.
  { name: 'init_check_repair', description: 'Controlled fallback: explicitly and auditably generate signed init-check.json when INIT reviewers cannot be spawned (disabled by default; requires acknowledge + fallbackReason)', schema: {
    storyId: z.string().describe('Story ID'),
    fallbackReason: z.string().min(30, 'fallbackReason must be at least 30 characters').describe('Why INIT reviewers could not run + what you manually checked (durable audit attestation)'),
    acknowledge: z.boolean().describe('Must explicitly pass true: confirms deliberate attestation in place of independent INIT reviewers'),
    mode: z.enum(['repair', 'fallback']).optional().describe("Audit classification: repair (missing exit repair) / fallback (subagent-less environment substitution), default repair"),
    evidenceRefs: z.array(z.string()).optional().describe('Optional evidence refs for manual checks (file/URL/transcript summary)'),
    issues: z.array(z.object({
      id: z.string().optional().describe('Optional self-assigned id'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Issue severity'),
      desc: z.string().min(1, 'desc is required and must be at least 1 character').describe('Concrete issue description'),
    })).optional().describe('Optional issues raised by manual attestation; high/critical still block INIT_CHECK'),
    actor: z.string().optional().describe('Optional actor identifier; defaults to git user.name'),
  }},

  // Delivery Check (B-35ed: koala-review-delivery reviewer writes signed delivery-check.json)
  // TEST->DONE hard gate artifact. Signature domain: storyId + docsPromises +
  // realMachineTests + closingSelfCheck + reviewRound.
  { name: 'delivery_check_set', description: 'Save delivery check results (called by koala-review-delivery reviewer)', schema: {
    storyId: z.string().describe('Story ID'),
    docsPromises: z.array(z.object({
      docPath: z.string().describe('Document path'),
      promise: z.string().describe('Promise described in the document'),
      status: z.enum(['met', 'verified', 'waived', 'unverified']).optional().describe('Optional status; met/verified count as verified, waived requires waiverReason'),
      verifiedBy: z.string().optional().describe('Verification method (for example grep/test/manual)'),
      evidence: z.string().optional().describe('Verification evidence'),
      waiverReason: z.string().optional().describe('Document-promise waiver reason (≥ 30 characters when status=waived)'),
    })).describe('Document promise list'),
    realMachineTests: z.array(z.object({
      featureId: z.string().describe('Feature ID (for example CHK-xxx)'),
      transcript: z.string().describe('Real-machine test transcript or summary'),
      waiverReason: z.string().optional().describe('Waiver reason (≥ 30 characters when non-empty; included in signature)'),
    })).describe('Real-machine test records'),
    closingSelfCheck: z.object({
      hasRealMachineTest: z.boolean().describe('Whether real-machine testing exists'),
      hasEdgeCaseCoverage: z.boolean().describe('Whether edge cases are covered'),
      hasUnresolvedTodos: z.boolean().describe('Whether unresolved TODOs exist'),
      summary: z.string().min(10, 'summary must be at least 10 characters').describe('Closing self-check summary'),
    }).describe('Closing self-check'),
    agentId: z.string().optional().describe('Reviewer self-reported agent id, used only for audit traceability'),
  }},

  // Delivery Waiver (B-35ed CHK-005: waiver audit; main agent adds waiver
  // reasons for unverified docsPromises)
  { name: 'delivery_waiver_add', description: 'Add a waiver reason to one docsPromise in delivery-check.json (re-signs)', schema: {
    storyId: z.string().describe('Story ID'),
    promiseId: z.string().describe('docPath to waive (matches docsPromises[].docPath)'),
    waiverReason: z.string().min(30, 'waiverReason must be at least 30 characters').describe('Waiver reason (≥ 30 characters)'),
  }},

  // Scope Check (B-d4d1: scope agent writes signed scope-check.json)
  { name: 'scope_check_save', description: 'Save scope check results (called by the scope agent)', schema: {
    storyId: z.string().describe('Story ID'),
    features: z.array(z.object({
      feature: z.string(),
      covered_by: z.string().nullable(),
      // B-ed3e CHK-002: five status levels
      status: z.enum(['covered', 'excluded', 'gap', 'orphan-suspect', 'drift']),
      excluded_by: z.string().nullable(),
      // B-ed3e CHK-002: source records origin (description / decisions:<path> / relatedDocs:<path>)
      source: z.string().optional(),
    })).describe('Feature coverage analysis results'),
    summary: z.object({
      total: z.number(),
      covered: z.number(),
      excluded: z.number(),
      gaps: z.number(),
      // B-ed3e CHK-002: optional new fields, default 0; drift is always 0 in PLAN
      orphanSuspect: z.number().optional(),
      drift: z.number().optional(),
    }).describe('Summary'),
    // B-ed3e CHK-003: sixth-channel Open Questions (optional). Reviewer writes
    // only receive type validation, not business completeness validation; the
    // main agent later resolves them in writing via scope_question_resolve.
    openQuestions: z.array(z.object({
      id: z.string(),
      q: z.string(),
      evidence: z.string(),
      sourcePointers: z.array(z.string()),
    })).optional().describe('Open Questions: contradictions/questions the reviewer saw in decisions/ but did not classify; the main agent must resolve them with scope_question_resolve'),
  }},

  // B-ed3e CHK-003: scope_question_resolve — main agent writes resolutions for
  // Open Questions raised by the reviewer. Design principle: resolution is not
  // included in signature _hash because it is a main-agent action and must not
  // pollute the reviewer judgment signature domain.
  { name: 'scope_question_resolve', description: 'Write a main-agent resolution for an Open Question raised by the scope reviewer (prevents self-absolution)', schema: {
    storyId: z.string().describe('Story ID'),
    oqId: z.string().describe('Open Question ID (for example OQ-1)'),
    resolution: z.string().min(20, 'resolution is required and must be at least 20 characters (written resolution prevents self-absolution)').describe('Main-agent written resolution (≥ 20 characters; should cite decisions/ source text)'),
    sourcePointers: z.array(z.string()).optional().describe('Evidence pointers for the resolution (decisions/ paths or checklist item ids), default []'),
  }},

  // Story dispatch (B-45ed CHK-005: implementer prompt generator)
  { name: 'story_dispatch', description: 'Generate the standard implementer prompt string (used by the main agent to dispatch CHK-xxx)', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID (for example CHK-001)'),
    agentType: z.string().optional().describe('subagent type (for example koala-implementer / koala-review-channel); CHK-008 will expand matrix'),
  }},

  // Finding dispatch (B-45ed CHK-010: reviewer-finding repair prompt generator, isomorphic with story_dispatch)
  // B-9d95 CHK-004: deprecated alias; first stdout line prints deprecation warning and recommends `lattice dispatch`.
  { name: 'finding_dispatch', description: '[deprecated: use lattice dispatch] Generate the standard reviewer-finding repair prompt string', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID (for example F-001 or full B-xxx:F-001 form)'),
    agentType: z.string().optional().describe('subagent type (for example koala-implementer / koala-review-channel); reuses the CHK-008 tier matrix'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch merged into `lattice dispatch`, available in all phases)
  { name: 'dispatch', description: 'Unified dispatch entrypoint: provide exactly one of itemId / findingId / clusterId to generate a subagent prompt (available in all phases)', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().optional().describe('Checklist item ID (CHK-xxx); mutually exclusive with findingId / clusterId, provide exactly one'),
    findingId: z.string().optional().describe('Finding ID (F-xxx or B-xxx:F-xxx); mutually exclusive with itemId / clusterId'),
    clusterId: z.string().optional().describe('Cluster ID (CL-xxx); mutually exclusive with itemId / findingId'),
    agentType: z.string().optional().describe('subagent type; INIT reviewers may pass only koala-review-story-init, other cases pair this with itemId/findingId/clusterId'),
  }},

  // Background CLI trio (B-45ed CHK-007: background.md set/append/get)
  { name: 'background_set', description: 'Write the full background.md (four-section format validation, reuses CHK-006 validator)', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('Complete background.md content (four sections)'),
  }},
  { name: 'background_append', description: 'Append content to the end of a specific background.md section without changing other sections', schema: {
    storyId: z.string().describe('Story ID'),
    section: backgroundSectionSchema.describe('Target section id: trigger_event / key_insight / tradeoff / conversation_texture; legacy localized section names are normalized'),
    content: z.string().describe('Content to append (usually a single bullet or several lines)'),
  }},
  { name: 'background_get', description: 'Read the full background.md', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'plan_set', description: 'Write the full plan.md (each checklist item needs a ## CHK-xxx section)', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('Complete plan.md content'),
  }},
  { name: 'plan_get', description: 'Read the full plan.md', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // Reviewer list (B-fdcf CHK-001: opt-in list query, computed live from riskSignals / touchpoints)
  { name: 'reviewer_list', description: 'List opt-in reviewers for the current story (baseline concept/quality/test-coverage + behavior/docs mounted by signals; channel LLM is retired)', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON (including reviewers array)'),
    forceReviewer: z.string().optional().describe('Comma-separated built-in REVIEW reviewer lane or short name to force-mount; writes reviewer_forced audit event to story.events'),
  }},

  // Workflow profile
  { name: 'workflow_set', description: 'Set project workflow profile (light/balanced/strict)', schema: {
    profile: z.string().describe('Target profile: light / balanced / strict'),
  }},
  { name: 'workflow_show', description: 'Show current workflow profile and effective policy', schema: {} },
  { name: 'workflow_explain', description: 'Explain a story\'s effective profile (project / required / effective)', schema: {
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
  { name: 'guard_session_start', description: 'Start (or restart) a Koala-managed scope-guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    provider: z.string().min(1, 'provider is required').describe('Agent provider runtime (e.g. claude-code, codex). Providers without pre-tool hooks run as watcher-fallback.'),
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

  // B-ea92 M1: read-only authority policy discovery.
  // Alias: lattice authority enforce policy → authority_enforce_policy (resolved in runCli).
  { name: 'authority_enforce_policy', description: 'Discover authority policy (GET /v1/authority/policy). Read-only: no receipt, no gate pass, no evidence submission. Alias: lattice authority enforce policy', schema: {
    authorityURL: z.string().optional().describe('Authority server base URL (overrides LATTICE_AUTHORITY_URL; legacy KOALA_AUTHORITY_URL is still accepted)'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout in milliseconds (overrides LATTICE_AUTHORITY_TIMEOUT_MS; legacy KOALA_AUTHORITY_TIMEOUT_MS is still accepted)'),
  }},
  { name: 'authority_enforce_runner', description: 'Explicit enforce-only headless runner command. Dry-run projects register/heartbeat/claim; --live performs register/heartbeat/claim/release without provider execution. Alias: lattice authority enforce runner', schema: {
    once: z.boolean().optional().describe('Claim at most one job'),
    dryRun: z.boolean().optional().describe('Project planned steps without network mutation or provider execution'),
    live: z.boolean().optional().describe('Run live Lattice Authority control-plane smoke: register, heartbeat, claim, then release any claimed job without provider execution'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
    authorityMode: z.string().optional().describe('Authority mode override; runner treats missing override as enforce'),
    authorityURL: z.string().optional().describe('Authority server base URL override'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout override'),
  }},
  { name: 'authority_receipt_verify', description: 'Verify a native Lattice Authority receipt signature and optional bindings. Alias: lattice authority receipt verify', schema: {
    receiptFile: z.string().describe('Signed native Lattice Authority receipt JSON file'),
    serverPublicKey: z.string().describe('Ed25519 server public key, hex by default'),
    serverPublicKeyEncoding: z.enum(['hex', 'base64', 'auto']).optional().describe('Encoding of serverPublicKey (default auto)'),
    receiptKind: z.string().optional().describe('Expected receipt kind, e.g. gate_decision'),
    receiptProjectId: z.string().optional().describe('Expected receipt projectId'),
    receiptStoryId: z.string().optional().describe('Expected receipt storyId'),
    serverKeyId: z.string().optional().describe('Expected serverKeyId'),
    expectedDecisionDigest: z.string().optional().describe('Expected decisionDigest for gate receipts'),
    receiptMaxAgeMs: z.number().optional().describe('Maximum receipt age in milliseconds (default LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS or 600000)'),
    receiptClockSkewMs: z.number().optional().describe('Allowed receipt clock skew in milliseconds (default LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS or 300000)'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'autopilot_run', description: 'Project or record a Lattice autopilot loop. Modes: local keeps the workflow purely local, shadow reports authority readiness warnings, authority requires Python authority readiness and a verified receipt for DONE. Alias: lattice autopilot run', schema: {
    mode: z.enum(['local', 'shadow', 'authority']).optional().describe('Autopilot mode: local, shadow, or authority'),
    storyId: z.string().optional().describe('Story ID to bind the autopilot loop to'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase to plan toward'),
    once: z.boolean().optional().describe('Plan a single loop iteration'),
    dryRun: z.boolean().optional().describe('Project planned steps without recording an autopilot projection (default true)'),
    maxSteps: z.number().optional().describe('Maximum projected local steps when dryRun=false'),
    requireMultiHost: z.boolean().optional().describe('Require independent host verdict certification before final DONE projection'),
    requiredHostVerdictCount: z.number().optional().describe('Required independent passing host verdicts when multi-host review is required'),
    maxReviewWaves: z.number().optional().describe('Maximum bounded multi-host review waves'),
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
  { name: 'autopilot_execute', description: 'Execute a bounded unattended Lattice autopilot loop. Local mode runs local Lattice commands, shadow warns on authority readiness, authority fails closed for DONE without a verified receipt. Alias: lattice autopilot execute', schema: {
    mode: z.enum(['local', 'shadow', 'authority']).optional().describe('Autopilot mode: local, shadow, or authority'),
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
  { name: 'autopilot_status', description: 'Report Lattice autopilot mode availability and Python authority readiness without mutating workflow state. Alias: lattice autopilot status', schema: {
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
  { name: 'planner_run', description: 'Compose draft, review, Story creation, and job/local plan creation. Alias: lattice planner run', schema: {
    request: z.string().optional().describe('One sentence or paragraph request'),
    requestFile: z.string().optional().describe('Request document path'),
    interactionMode: z.enum(['autonomous', 'interview', 'decision-gated']).optional().describe('Planner interaction mode'),
    mode: z.enum(['local', 'authority']).optional().describe('Execution mode'),
    until: z.enum(['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']).optional().describe('Target phase'),
    workflow: z.enum(['standard', 'source-aligned-redevelopment', 'source_aligned_redevelopment']).optional().describe('Development workflow'),
    projectId: z.string().optional().describe('Authority project id'),
    requireMultiHost: z.boolean().optional().describe('Require local/authority multi-host certification in the generated plan'),
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
  { name: 'autopilot_review_submit', description: 'Submit a local non-authority independent host verdict. Alias: lattice autopilot review submit', schema: {
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
  { name: 'authority_verdict_submit', description: 'Submit an Authority-mode independent host verdict record. Alias: lattice authority verdict submit', schema: {
    verdictFile: z.string().optional().describe('Verdict JSON file'),
    jobId: z.string().optional().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    hostId: z.string().optional(),
    provider: z.string().optional(),
    sessionId: z.string().optional(),
    keyId: z.string().optional(),
    decision: z.enum(['pass', 'fail', 'blocked']).optional(),
    materialDigest: z.string().optional(),
    gateInputDigest: z.string().optional(),
    receiptId: z.string().optional(),
    promptDigest: z.string().optional(),
    note: z.string().optional(),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'authority_verdict_list', description: 'Summarize Authority independent host verdicts. Alias: lattice authority verdict list', schema: {
    jobId: z.string().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    requiredHosts: z.number().optional().describe('Required independent passing hosts'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},
  { name: 'authority_job_status', description: 'Summarize Authority job host-verdict status without minting or replacing native receipts. Alias: lattice authority job status', schema: {
    jobId: z.string().describe('Authority job id'),
    runId: z.string().optional().describe('Authority run id'),
    requiredHosts: z.number().optional().describe('Required independent passing hosts'),
    json: z.boolean().optional().describe('Output JSON'),
    format: z.enum(['text', 'json']).optional().describe('Output format'),
  }},

  // B-ad2c: dev-memory — lightweight non-authoritative experience capture
  { name: 'dev_memory_capture', description: 'Capture a non-authoritative dev-memory experience entry to file-backed JSONL storage (does not satisfy Koala gate evidence)', schema: {
    category: z.enum(['failure-mode','pattern','anti-pattern','workflow','tool-quirk','guard-bypass','debugging','communication','other']).describe('Experience category'),
    scope: z.enum(['project','global','story-candidate']).optional().describe('Storage scope (default project)'),
    summary: z.string().describe('One-sentence summary (≥10 characters)'),
    trigger: z.string().describe('Trigger scenario (≥5 characters)'),
    lesson: z.string().describe('Reusable lesson (≥10 characters)'),
    reusePrompt: z.string().describe('How to recall this experience in a future session (≥5 characters)'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('Keyword tags (comma-separated string or array)'),
    sourceAgent: z.string().optional().describe('Source agent (default koala-implementer)'),
    sourceStoryId: z.string().optional().describe('Source story ID'),
    evidenceRefs: z.array(z.string()).optional().describe('Evidence refs (file paths/commit sha)'),
  }},
  { name: 'dev_memory_list', description: 'List dev-memory experience entries', schema: {
    scope: z.enum(['project','global','story-candidate']).optional().describe('Storage scope (default project)'),
    limit: z.number().optional().describe('Maximum entries to return (default 50)'),
    json: z.boolean().optional().describe('JSON output'),
  }},
  { name: 'dev_memory_search', description: 'Search dev-memory experience entries by query/category/agent/tags', schema: {
    query: z.string().optional().describe('Full-text search query'),
    category: z.string().optional().describe('Filter by category'),
    agent: z.string().optional().describe('Filter by source agent'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('Filter by tags (comma-separated string or array)'),
    limit: z.number().optional().describe('Maximum entries to return (default 20)'),
    global: z.boolean().optional().describe('Also search global storage'),
    json: z.boolean().optional().describe('JSON output'),
  }},
  { name: 'dev_memory_preflight', description: 'Output a non-authoritative dev-memory preflight context pack (called at session start)', schema: {
    query: z.string().optional().describe('Relevance query'),
    maxEntries: z.number().optional().describe('Maximum included entries (default 5)'),
    maxLines: z.number().optional().describe('Line budget (default 60)'),
    json: z.boolean().optional().describe('JSON output'),
  }},
  { name: 'dev_memory_finish', description: 'End the session: writes story candidates by default inside an active story; without a story, reports/promotes project entries (no story directory required)', schema: {
    storyId: z.string().optional().describe('Active story ID (for example B-xxx); omitted means infer from active story branch; may be omitted outside Koala sessions'),
    storyDir: z.string().optional().describe('Story directory root (default <root>/.koala/story/actives)'),
    query: z.string().optional().describe('Optional relevance filter'),
    scope: z.enum(['global']).optional().describe('Without storyId: global=promote project experience into global dev-memory; even in an active story, do not write story candidates'),
  }},
  { name: 'dev_memory_start', description: 'Session-start wrapper: outputs dev-memory preflight context + reminder to call dev_memory_finish at the end (does not start external agent binaries; not lifecycle dev_start; does not create worktrees or advance phase)', schema: {
    agent: z.string().optional().describe('Agent name (for example claude / codex; display only, does not start a process)'),
    query: z.string().optional().describe('Preflight relevance query'),
    maxEntries: z.number().optional().describe('Maximum preflight entries (default 5)'),
    dryRun: z.boolean().optional().describe('Compatibility parameter; always dry-run mode (does not start external processes)'),
  }},

];

/**
 * Runtime tool list assigned when runCli() starts, including main built-ins plus
 * extras. All helpers (printHelp, dispatch lookup, etc.) access this variable
 * afterward instead of directly referencing MAIN_TOOLS.
 */
let TOOLS: ToolDef[] = MAIN_TOOLS;

// ── Phase detection ──

interface ActiveStory { storyId: string; phase: string; }

/**
 * Detect the active story from the git branch name.
 * Branch format: story/B-xxxx -> storyId = B-xxxx.
 * Returns null for non-story branches (all commands available).
 */
function detectActiveStory(root: string): ActiveStory | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
    // Non-git directory or other error, so do not filter.
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

function printToolHelp(tool: ToolDef, options: HelpOutputOptions = {}) {
  const brand = detectLatticeBrand();
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;

  out(`\n  ${brand.primaryBin} ${tool.name} — ${tool.description}\n`);
  out(`  ${formatLatticeProductLine(brand)}; legacy alias: ${brand.legacyAlias}\n`);

  // If a core command has longHelp, print the full prompt first.
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    out('  No arguments\n');
    out(`  Usage: ${brand.primaryBin} ${tool.name}`);
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
  out(`  Compatible alias: ${brand.legacyAlias} ${tool.name} ...`);
  out('  (* = required)');
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
  console.log(`  Primary entrypoint: ${brand.primaryBin}`);
  console.log(`  Legacy alias:       ${brand.legacyAlias}\n`);
  console.log(`  Usage: ${brand.primaryBin} <command> --key=value         Run a command`);
  console.log(`         ${brand.primaryBin} <command> --help              Show arguments`);
  console.log(`         ${brand.primaryBin} help                          Show this help`);
  console.log(`         ${brand.primaryBin} --version                     Show version`);
  console.log(`         ${brand.primaryBin} --root <path> ...             Set project root\n`);

  if (activeStory) {
    console.log(`  Current Story: ${activeStory.storyId}  Phase: ${activeStory.phase}\n`);
  }

  const config = loadConfig();
  const phaseTools = config.phaseTools;

  // Known prefixes -> display group names (special cases first).
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
    host: 'Host',
    lattice: 'Lattice',
    rollout: 'Lattice',
    authority: 'Authority',
    conduit: 'Conduit',
  };
  // Display order for known groups; groups not listed here (from extras) append alphabetically.
  const KNOWN_ORDER = ['Host', 'Lattice', 'Authority', 'Conduit', 'Story', 'Review', 'Checklist', 'Grill', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Check', 'Serve', 'Session', 'Aux', 'Audit'];

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    // With an active story, list only commands available in the current phase.
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
    1. lattice story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"Do the work","context":"Context"}]}'
    2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # create worktree
    3. cd .worktrees/B-xxx
    4. lattice story_review --storyId=B-xxx                     # enter DEV after review passes
    5. lattice story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. Write code + verification (fixture / project-native tests / optional validate.ts)
    7. lattice validate                                         # verify (auto-discovers by project language or reads config)
    8. lattice checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # enter code review
   10. koala-reviewer reviews code and raises findings         # critical/high must be resolved

    ── TEST → DONE ──
   11. lattice story_advance --storyId=B-xxx --phase=TEST
   12. lattice story_advance --storyId=B-xxx --phase=DONE

  Initialize a new project:
    lattice init                          # initialize Lattice/Koala project state in the current directory

  Tip: use --key=value for simple arguments; use JSON for complex arguments (array/object)
  Error? Run lattice <command> --help to see the full argument reference
`);
}

function printCodexHelp() {
  const brand = detectLatticeBrand();
  console.log(`\n  ${brand.primaryBin} codex <command> — Codex-tagged Lattice entrypoint\n`);
  console.log(`  Usage: ${brand.primaryBin} codex session_brief`);
  console.log(`         ${brand.primaryBin} codex aux_doc_list --format=json`);
  console.log(`         ${brand.primaryBin} codex verify`);
  console.log(`         ${brand.primaryBin} codex doctor\n`);
  console.log('  Aliases:');
  console.log('    verify  -> verify_codex');
  console.log('    doctor  -> doctor\n');
  console.log('  The codex namespace marks activity with source=codex before dispatching the underlying Lattice command.');
}

// ── Flag parser ──

/** Test entrypoint: accepts JSON-described schema ("string"|"number"|"boolean"|"array"|"object") and converts it to Zod internally. */
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
        // Next argument is not a flag -> treat it as a value.
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          addValue(result, key, coerce(rawArgs[i + 1], schema[key]), arrayKeys.has(key));
          i++;
        } else {
          // bare --flag → true
          result[key] = true;
        }
      }
    } else if (arg.includes('=') && !arg.startsWith('{')) {
      // key=value (without -- prefix, kept for legacy compatibility)
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

// ── Resolve root ──

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.KOALA_PROJECT_ROOT) return process.env.KOALA_PROJECT_ROOT;
  // Walk upward to find koala.config.json and determine the project root.
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
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
  'host_list',
  'host_probe',
  'host_status',
  'host_install',
  'lattice_config_doctor',
  'rollout_check',
  'authority_status',
  'autopilot_status',
  'autopilot_doctor',
  'conduit_status',
  'conduit_explain',
  'story_export',
  'handoff_create',
  'handoff_inspect',
  'handoff_accept',
  'handoff_resume',
  'handoff_receipt_submit',
  'handoff_worktree_create',
  'host_dispatch',
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
  'workflow_explain',
  'help',
  'authority_enforce_policy',
  'authority_enforce_runner',
  'authority_receipt_verify',
]);

function inferCodexEntrypoint(): string {
  if (process.env.KOALA_CODEX_ENTRYPOINT) return process.env.KOALA_CODEX_ENTRYPOINT;
  const invoked = process.argv[1] || '';
  if (invoked.includes('lattice-codex') || invoked.includes('koala-codex')) return 'local-wrapper';
  if (process.env.KOALA_ACTIVITY_SOURCE === 'codex') return 'global-fallback';
  return 'cli';
}

function storyIdFromArgs(args: Record<string, unknown>, activeStory?: ActiveStory | null): string | null {
  if (typeof args.storyId === 'string' && args.storyId.trim()) return args.storyId.trim();
  if (typeof args.story === 'string' && args.story.trim()) return args.story.trim();
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
 *     `koala-review-delivery`; any other caller is treated as
 *     `storyScopedMutating` so a main agent cannot borrow it to bypass the
 *     owner lease.
 *  4. `dev_memory_finish --scope=global` with no explicit story target is
 *     `mainSharedMutating`: it promotes non-authoritative project memory to
 *     global memory and must not be owner-lease-gated by the active story.
 *  5. `autopilot_run` is `readOnly` by default because it projects steps only;
 *     explicit `dryRun=false` asks it to append an autopilot_projection event,
 *     so that invocation is `storyScopedMutating`.
 *     `autopilot_execute` is always `storyScopedMutating` because the command
 *     is the true unattended executor loop and may run lifecycle/evidence steps.
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
  // Runtime enum re-validation (CLAUDE.md "Handler coding convention"): a missing policy
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

  // Boundary rule 5: autopilot_run defaults to dry-run projection; only an
  // explicit false records the story-scoped autopilot_projection event.
  if (cmd === 'autopilot_run') {
    cls = args.dryRun === false || args.dryRun === 'false' ? 'storyScopedMutating' : 'readOnly';
  }
  if (cmd === 'autopilot_execute') {
    cls = 'storyScopedMutating';
  }

  return cls;
}

/**
 * B-c55d CHK-002: whether a `delivery_check_set` invocation is acting AS the
 * delivery reviewer (`koala-review-delivery`).
 *
 * The actor is resolved from the explicit `agentId` argument first, then the
 * `KOALA_AGENT` environment variable — the same precedence the
 * `delivery_check_set` handler records into `delivery-check.json`. Only the
 * exact `koala-review-delivery` lane qualifies for the reviewerWrite exemption;
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
  const env = typeof process.env.KOALA_AGENT === 'string' ? process.env.KOALA_AGENT.trim() : '';
  const actor = explicit || env;
  return actor === 'koala-review-delivery';
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
  const storyId = storyIdFromArgs(args, activeStory);
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
        `${storyId} is owned by another Koala session (${lease.sessionId}) whose owner lease is ` +
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
    }),
  );
}

// ─── B-4f15 CHK-002: read-only reviewer command guard ───────────────────────

/** Environment variable name that activates read-only reviewer mode. */
export const REVIEWER_READONLY_ENV = 'KOALA_REVIEWER_READONLY';

/** Returns true when the process is running as a read-only reviewer. */
export function isReviewerReadOnlyModeEnabled(): boolean {
  return process.env[REVIEWER_READONLY_ENV] === '1';
}

/**
 * B-4f15 CHK-002: pre-hook, pre-lease gate for read-only reviewer mode.
 *
 * When KOALA_REVIEWER_READONLY=1, only commands whose EFFECTIVE ownershipClass
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
    `Advisory read-only reviewers may only run read-only Koala commands and should return ` +
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
    return process.env.KOALA_ACTIVITY_RECORD_READONLY === '1';
  }
  if (cmdName === 'autopilot_run' && args.dryRun !== false && args.dryRun !== 'false') return false;
  if (cmdName === 'autopilot_execute' && (args.dryRun === true || args.dryRun === 'true')) return false;
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

function commitFromDraftMetadataAndMergeMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  preflightFromDraftMetadataBootstrap(root);

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  const draftRel = boundedMetadataPath('docs/story/drafts', draftName, 'source draft');
  const boundedPaths = [storyRel, draftRel];

  for (const path of boundedPaths) {
    stageBoundedMetadataPath(root, path);
  }
  const staged = gitCli(root, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    throw new Error(`from-draft metadata commit found no changes under ${boundedPaths.join(', ')}`);
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, boundedPaths));
  if (outOfBounds.length > 0) {
    throw new Error(
      `from-draft metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `koala: from-draft metadata ${storyId}`;
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
    `✓ from-draft metadata committed on main: ${mainHead} (${commitMessage})`,
    `✓ main merged into ${storyBranch}`,
  ].join('\n');
}

/**
 * B-f60c CHK-002 — close F-008 partial-DONE at the INIT_CHECK write side.
 *
 * Root cause (verified, B-6974 / B-ad12 real-machine repros): `story_advance
 * INIT_CHECK` runs `story_advance` (writes phase) then `dev_start` (writes
 * `story.worktree` into the MAIN repo's `.koala/story/actives/<id>/index.json`).
 * `dev_start.createScopedStoryBootstrapCommit` commits the story dir onto the
 * `story/<id>` branch via a TEMPORARY git index — it never touches the main
 * repo's working tree or index. So the main checkout is left with an
 * UNCOMMITTED story-metadata mirror (the story dir is untracked, since
 * `story_create` only wrote files without committing them).
 *
 * At DONE, `applyDoneMergeEffects` Step 3 runs `git merge story/<id>` from the
 * main repo root. The story branch carries a committed
 * `.koala/story/actives/<id>/index.json`; the main working tree has the SAME
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
function commitInitCheckMetadataAndMergeMain(root: string, store: StoryStore, storyId: string): string {
  const currentBranch = gitCli(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch.startsWith('story/')) {
    // INIT_CHECK is the standard worktree-creation entry and must run from the
    // main checkout. If we are already on a story branch, dev_start would not
    // have created a main-side mirror to reconcile — leave it untouched.
    return '';
  }

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  stageBoundedMetadataPath(root, storyRel);
  const staged = gitCli(root, ['diff', '--cached', '--name-only']);
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

  const commitMessage = `koala: INIT_CHECK metadata ${storyId}`;
  gitCli(root, [
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m', commitMessage,
  ]);
  const mainHead = gitCli(root, ['rev-parse', '--short', 'HEAD']);
  const boundedStatus = gitCli(root, ['status', '--porcelain', '--', storyRel]);
  if (boundedStatus) {
    throw new Error(
      `INIT_CHECK metadata committed, but bounded story path is still dirty (${storyRel}):\n${boundedStatus}`,
    );
  }

  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`INIT_CHECK story ${storyId} has no recorded worktree path after dev_start`);
  }
  const repoRoot = gitCli(root, ['rev-parse', '--show-toplevel']);
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(repoRoot, worktreePath);
  gitCli(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge',
    currentBranch,
    '--no-edit',
  ]);
  gitCli(worktreeAbs, ['merge-base', '--is-ancestor', currentBranch, storyBranch]);

  return [
    `✓ INIT_CHECK metadata committed on ${currentBranch}: ${mainHead} (${commitMessage})`,
    `✓ ${currentBranch} merged into ${storyBranch}`,
  ].join('\n');
}

// ── Main ──

/**
 * runCli — koala CLI runtime entrypoint
 *
 * @param opts.extraTools     ToolDef list from third-party packages, merged into help and dispatch
 * @param opts.extraRegister  Third-party register function called after createMainRegistry
 *                            (receives the Registry instance and can inject handlers with registry.registerBatch(...))
 */
export async function runCli(opts?: {
  extraTools?: ToolDef[];
  extraRegister?: (registry: Registry, ctx: HandlerContext) => void;
}): Promise<void> {
  // Inject extras: merge tool defs and retain extra register for later.
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

  if (cmd === 'lattice' && argv[1] === 'codex') {
    argv.shift();
    cmd = argv[0];
    arg = argv[1];
  }

  if (cmd === 'codex') {
    const subcommand = argv[1];
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      printCodexHelp();
      return;
    }
    process.env.KOALA_ACTIVITY_SOURCE = 'codex';
    process.env.KOALA_ACTIVITY_RECORD_READONLY = process.env.KOALA_ACTIVITY_RECORD_READONLY || '1';
    process.env.KOALA_CODEX_ENTRYPOINT = process.env.KOALA_CODEX_ENTRYPOINT || 'global-codex';
    const codexAliases: Record<string, string> = {
      verify: 'verify_codex',
      doctor: 'doctor',
    };
    argv.splice(0, 2, codexAliases[subcommand] || subcommand);
    cmd = argv[0];
    arg = argv[1];
  }

  // init uses a standalone script.
  if (cmd === 'init') {
    const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    await import(`file://${initPath}`);
    return;
  }

  // dashboard uses its own long-running mode.
  if (cmd === 'dashboard') {
    const dashArgs = parseFlags(argv.slice(1), {
      roots: z.string().optional(),
      interval: z.number().optional(),
    });
    // If roots were not specified, use --root (or auto-detected root) as default.
    if (!dashArgs.roots) dashArgs.roots = root0;
    const { runDashboard } = await import('./dashboard.js');
    await runDashboard(dashArgs as { roots?: string; interval?: number });
    return;
  }

  // Normalize nested space aliases into the flat underscore commands used by
  // the registry. Supports both primary invocations (`lattice host list`) and
  // legacy-prefixed invocations (`koala lattice host list`).
  const aliasStart = cmd === 'lattice' ? 1 : 0;
  const aliasMap: Record<string, string> = {
  'host list': 'host_list',
  'host probe': 'host_probe',
  'host status': 'host_status',
  'host install': 'host_install',
  'host dispatch': 'host_dispatch',
  'handoff create': 'handoff_create',
  'handoff inspect': 'handoff_inspect',
  'handoff accept': 'handoff_accept',
  'handoff resume': 'handoff_resume',
  'handoff receipt submit': 'handoff_receipt_submit',
  'handoff worktree create': 'handoff_worktree_create',
  'config doctor': 'lattice_config_doctor',
    'rollout check': 'rollout_check',
    'authority status': 'authority_status',
    'authority enforce policy': 'authority_enforce_policy',
    'authority enforce runner': 'authority_enforce_runner',
    'authority receipt verify': 'authority_receipt_verify',
    'authority job status': 'authority_job_status',
    'authority verdict submit': 'authority_verdict_submit',
    'authority verdict list': 'authority_verdict_list',
    'autopilot run': 'autopilot_run',
    'autopilot execute': 'autopilot_execute',
    'autopilot status': 'autopilot_status',
    'autopilot doctor': 'autopilot_doctor',
    'autopilot review submit': 'autopilot_review_submit',
    'autopilot review status': 'autopilot_review_status',
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
    'conduit status': 'conduit_status',
    'conduit explain': 'conduit_explain',
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

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`Unknown command: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('Did you mean:'); for (const t of m) console.error(`  lattice ${t.name}`); }
    console.error('Run lattice help to see all commands (legacy alias: koala)');
    process.exit(1);
  }

  if (arg === '--help' || arg === '-h') { printToolHelp(tool); return; }

  // Phase gate: with an active story, reject commands outside the allowlist.
  if (activeStory) {
    const config = loadConfig(root0);
    if (!isCommandAllowed(cmd, activeStory.phase, config.phaseTools)) {
      const allowed = getAllowedPatterns(activeStory.phase, config.phaseTools);
      console.error(`Command "${cmd}" is not available in ${activeStory.phase} phase`);
      console.error(`   Story: ${activeStory.storyId}  Phase: ${activeStory.phase}`);
      for (const line of formatCommandLifecycleHint(cmd, activeStory.phase, allowed)) console.error(line);
      console.error(`   Commands available in this phase: ${allowed.join(', ')}`);
      process.exit(1);
    }
  }

  // Parse arguments — supports three formats:
  //   1. --key=value --flag (standard flags)
  //   2. key=value          (short flags)
  //   3. '{"key":"value"}'  (JSON body, legacy-compatible)
  let parsed: Record<string, unknown> = {};
  {
    const rawArgs = argv.slice(1);
    if (rawArgs.length === 0) {
      // No arguments, empty object.
    } else if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
      // JSON body format (legacy-compatible)
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
  const schema = z.object(tool.schema);
  const v = schema.safeParse(parsed);
  if (!v.success) {
    printValidationFailure(tool, v.error.issues);
    process.exit(1);
  }

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
      process.stderr.write('⚠ koala stale state warnings:\n');
      for (const w of staleWarnings) process.stderr.write(`  - ${w}\n`);
    }
  } catch { /* never block */ }

  // Watchdog: by default, 5 minutes without output means stuck; 15 minutes is
  // the absolute cap. Override with KOALA_IDLE_TIMEOUT_MS / KOALA_MAX_TIMEOUT_MS.
  // Real-machine smoke tests can occasionally spend > 2 minutes in one LLM call.
  const IDLE_TIMEOUT = Number(process.env.KOALA_IDLE_TIMEOUT_MS) || (5 * 60 * 1000);
  const MAX_TIMEOUT = Number(process.env.KOALA_MAX_TIMEOUT_MS) || (15 * 60 * 1000);
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
      originalLog(`${cmd} appears stuck: no output for ${IDLE_TIMEOUT / 1000} seconds; forcing exit`);
      process.exit(2);
    }
  }, 10000);
  watchdog.unref();

  // Unified logging: writes .koala/activity.jsonl (dual-source module, legacy
  // path kept read-only compatible). Write failures are PERSIST-class issues
  // (incomplete audit trail -> cannot reconstruct later), so reportHealthIssue.
  // Persist staleWarnings too for trend analysis.
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
      // Detect this by checking if `root` still has koala.config.json. If not
      // (the worktree was removed), prefer the durable main-root fallback
      // captured at command start — it was computed while root/.git still
      // existed, so it points at the real main project even after the worktree
      // is gone. Do NOT fall back to resolveRoot() first: its cwd-walk may
      // resolve to (and appendActivityLog would then recreate) the now-deleted
      // ghost worktree dir. Only use resolveRoot() if the durable fallback is
      // unavailable/stale, and skip logging entirely if neither has
      // koala.config.json rather than pollute the filesystem.
      let effectiveRoot = root;
      if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
        if (mainRootFallback && existsSync(join(mainRootFallback, 'koala.config.json'))) {
          effectiveRoot = mainRootFallback;
        } else {
          effectiveRoot = resolveRoot();
          if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
            return;
          }
        }
      }
      const record: Record<string, unknown> = {
        source: process.env.KOALA_ACTIVITY_SOURCE || 'cli',
        session: process.env.KOALA_ACTIVITY_SESSION || '',
        entrypoint: inferCodexEntrypoint(),
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: storyIdFromArgs(entry.args as Record<string, unknown>, activeStory),
        phase: activeStory?.phase || null,
        role: inferActivityRole(entry.args, process.env.KOALA_ACTIVITY_ROLE || process.env.KOALA_AGENT),
      };
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendActivityLog(effectiveRoot, record);
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        logDir: join(root, '.koala'),
      });
    }
  }

  function writeCodexProcessEvent(entry: {
    command: string;
    args: unknown;
    success: boolean;
    error?: string;
  }) {
    if ((process.env.KOALA_ACTIVITY_SOURCE || '') !== 'codex') return;
    const argsObject = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? entry.args as Record<string, unknown>
      : {};
    const storyId = storyIdFromArgs(argsObject, activeStory);
    if (!storyId) return;
    try {
      let phase = activeStory?.phase || '';
      if (!phase) {
        try { phase = store.readStory(storyId).phase; } catch { phase = ''; }
      }
      store.appendProcessEvent(storyId, {
        type: 'codex_cli',
        source: 'codex',
        session: process.env.KOALA_ACTIVITY_SESSION || '',
        role: inferActivityRole(entry.args, process.env.KOALA_ACTIVITY_ROLE || process.env.KOALA_AGENT),
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
      process.stderr.write(`[koala-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
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
      // Inject next-step hint (only commands registered in hints.ts are affected; others return unchanged).
      const hintActive: ActiveStoryInfo | null = activeStory
        ? { storyId: activeStory.storyId, phase: activeStory.phase }
        : null;
      result = decorateResult({
        cmd,
        args: parsed,
        result,
        store,
        root,
        activeStory: hintActive,
      });
      // postCommand hook — runs before we exit; failure does not block exit(0)
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      if (config0?.hooks?.postCommand && !READ_ONLY_COMMANDS.has(cmd)) {
        process.stderr.write(`[koala-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      if (!READ_ONLY_COMMANDS.has(cmd)) {
        await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
          KOALA_RESULT_JSON: truncateForEnv(resultText),
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
        process.stderr.write(`[koala-hook] running onError hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('onError', cmd, buildHookEnvLocal('onError', {
        KOALA_ERROR: String(e?.message || e),
      }), config0, root);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // story_create: when it stops at INIT, append next-step guidance.
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
          return `${result}\nCurrent directory is not a git repository: story was recorded, but the from-draft worktree cannot be created automatically.\n-> Run git init and make the first commit, then retry lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
        }
        try {
          const wtResult = handlers.dev_start({ storyId });
          const syncResult = commitFromDraftMetadataAndMergeMain(root, store, storyId, fromDraftName);
          return `${result}\n\n${wtResult}\n\n${syncResult}\n\n-> Now cd into the worktree path above, then run lattice story_advance phase=PLAN to enter PLAN`;
        } catch (e: any) {
          throw new Error(
            `from-draft worktree bootstrap failed for ${storyId}: ${e.message}\n` +
            `-> After diagnosing, run lattice story_advance --phase=INIT_CHECK again to auto-retry, or manually run lattice dev_start '{"storyId":"${storyId}"}'`,
          );
        }
      }
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (result.includes('Current directory is not a git repository')) return result;
      if (!gitReady) {
        return `${result}\nCurrent directory is not a git repository: story was recorded, but the INIT_CHECK/worktree flow cannot run smoothly yet.\n-> Run git init && git add . && git commit -m \"init\" at the project root, then run lattice story_advance '{\"storyId\":\"${storyId}\",\"phase\":\"INIT_CHECK\"}'`;
      }
      return `${result}\n-> Story is in INIT. Next steps:\n  1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' to create the worktree\n  2. cd into the suggested worktree path\n  3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' to enter PLAN (cwd must be the worktree)`;
    });
    return;
  }

  // story_advance phase=INIT_CHECK: on success, automatically call dev_start to
  // create the worktree. B-5246: when phase is already INIT_CHECK (retry case),
  // allow dev_start to rerun without throwing "Cannot transition INIT_CHECK->INIT_CHECK".
  // This lets agents retry story_advance INIT_CHECK after first worktree creation
  // failure without using the hidden manual dev_start path.
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
      // Probe current phase; if already INIT_CHECK, skip advance and retry dev_start directly.
      // story_get returns {checklist, review} by default; phase needs detail:true at result.index.phase.
      let advanceResult = '';
      try {
        const story: any = handlers.story_get({ storyId, detail: true });
        const currentPhase = story?.index?.phase;
        if (currentPhase === 'INIT_CHECK') {
          advanceResult = `Story ${storyId} is already in INIT_CHECK; retrying worktree creation`;
        } else {
          advanceResult = await handlers.story_advance(v.data);
        }
      } catch {
        // If story_get fails, fall back to the original behavior.
        advanceResult = await handlers.story_advance(v.data);
      }
      try {
        const wtResult = handlers.dev_start({ storyId });
        // B-f60c CHK-002: close F-008. dev_start leaves an uncommitted
        // story-metadata mirror in the main checkout that blocks the DONE
        // `git merge story/<id>`. Commit it on the base branch (mirroring the
        // from-draft path) so DONE has nothing uncommitted to collide with.
        let syncResult = '';
        if (gitReady) {
          syncResult = commitInitCheckMetadataAndMergeMain(root, store, storyId);
        }
        const syncSegment = syncResult ? `\n\n${syncResult}` : '';
        return `${advanceResult}\n\n${wtResult}${syncSegment}\n\n-> Now cd into the worktree path above, then run lattice story_advance phase=PLAN to enter PLAN`;
      } catch (e: any) {
        return `${advanceResult}\nWorktree creation failed: ${e.message}\n-> After diagnosing, run lattice story_advance --phase=INIT_CHECK again to auto-retry, or manually run lattice dev_start '{"storyId":"${storyId}"}'`;
      }
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

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}
