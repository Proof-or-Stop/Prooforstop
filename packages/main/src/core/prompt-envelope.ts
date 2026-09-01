import {
  canonicalJsonStringify,
  domainSeparatedDigest,
  estimatePromptTokens,
  PROMPT_CONTRACT_ALGORITHMS,
  promptLogicalLines,
  promptUtf8Bytes,
  reviewerDispatchPromptDigest,
  validateFullTaskContext,
  validateIncrementalReviewBasis,
  validateKnownExecutionEnvironment,
  validatePromptEnvelope,
  type FullTaskContext,
  type IncrementalReviewBasis,
  type KnownExecutionEnvironment,
  type PromptEnvelope,
  type RoleContract,
  type RuntimeContract,
} from './prompt-contracts.js';
import { LATTICE_CLI_VERSION } from './lattice-brand.js';
import type { ChecklistData, ScopeContractData, StoryInfo } from './types.js';
import { digestScopeContract } from './guard-session.js';
import { isModularReviewerRoleId } from './prompt-registry.js';

export const PROMPT_ENVELOPE_ASSEMBLER_VERSION = 'proofbound.full-context-assembler.v1';
export const PROMPT_DISPATCH_PROTOCOL_VERSION = 'proofbound.prompt-dispatch.v1';

export interface FullPromptAssemblyInput {
  roleContract: RoleContract;
  runtimeContract: RuntimeContract;
  rolePrompt: string;
  taskContext: FullTaskContext;
  knownExecutionEnvironment?: KnownExecutionEnvironment;
  dispatchKind: 'story-dispatch' | 'review-run';
  reviewRunId?: string;
  reviewRound?: string;
  lane?: string;
  createdAt: string;
  launcherSpec?: unknown;
  commandPolicy?: unknown;
  toolPolicy?: unknown;
  systemInstruction?: string;
  dispatchPrompt?: string;
  hostRenderIdentityDigest?: string;
}

export interface FullPromptAssembly {
  prompt: string;
  taskContext: FullTaskContext;
  knownExecutionEnvironment: KnownExecutionEnvironment;
  envelope: PromptEnvelope;
}

export interface ConditionalReviewAssemblyInput extends FullPromptAssemblyInput {
  incrementalEligible: boolean;
  eligibilityDigest: string;
  eligibilityReasonCodes: string[];
  freshnessClassification: string;
  impactPolicyVersion: string;
  priorPassRef?: string;
  changedFilesDigest: string;
  impactedFilesDigest: string;
  reviewBasis?: IncrementalReviewBasis | null;
  incrementalBudgetBytes?: number;
  fullBudgetBytes?: number;
  reviewerEscalationReason?: string;
}

export interface ConditionalReviewAssembly extends FullPromptAssembly {
  selectionReason: NonNullable<PromptEnvelope['selectionReason']>;
  fullPrompt: string;
  incrementalPrompt?: string;
}

function renderFullPrompt(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  taskContext: FullTaskContext,
  environment: KnownExecutionEnvironment,
  rolePrompt: string,
  dispatchPrompt?: string,
): string {
  const sections = [
    '## Runtime Contract',
    runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(roleContract),
    '## Task Context',
    canonicalJsonStringify(taskContext),
    '## Known Execution Environment',
    canonicalJsonStringify(environment),
  ];
  if (dispatchPrompt !== undefined) sections.push('## Dispatch Prompt', dispatchPrompt);
  sections.push('## Role Prompt', rolePrompt);
  return sections.join('\n\n');
}

function renderIncrementalPrompt(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  reviewBasis: IncrementalReviewBasis,
  environment: KnownExecutionEnvironment,
  rolePrompt: string,
  dispatchPrompt: string,
): string {
  return [
    '## Runtime Contract',
    runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(roleContract),
    '## Incremental Review Basis',
    canonicalJsonStringify(reviewBasis),
    '## Known Execution Environment',
    canonicalJsonStringify(environment),
    '## Dispatch Prompt',
    dispatchPrompt,
    '## Role Prompt',
    rolePrompt,
  ].join('\n\n');
}

function assertContractRenderCoherence(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  rolePrompt: string,
): void {
  const runtimeRenderDigest = domainSeparatedDigest('runtime-contract.render.v1', runtimeContract.compactText);
  if (runtimeContract.renderDigest !== runtimeRenderDigest) {
    throw new Error('Runtime Contract renderDigest does not match compactText');
  }
  const roleRenderDigest = domainSeparatedDigest('role-contract.render.v1', rolePrompt);
  if (roleContract.renderDigest !== roleRenderDigest) {
    throw new Error(`Role Contract renderDigest does not match the canonical prompt bytes for ${roleContract.roleId}`);
  }
}

type ReviewTriageAuthorityViolation =
  | 'retired applicability verdict used as authority'
  | 'disposition collapsed into applicability'
  | 'unauthorized disposition minting'
  | 'severity used as sole ownership or scope authority'
  | 'dismissal used as applicability proof'
  | 'unknown applicability used to route or unblock';

const TRIAGE_NEGATION = /\b(?:not|never|cannot|prohibited|forbidden|disallowed)\b/u;
const RETIRED_APPLICABILITY_ALIAS = /\bstale\s+or\s+not\s+reproduced\b/u;

function normalizeTriageAuthorityText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`'"“”‘’]/gu, ' ')
    .replace(/[_\-‐‑‒–—]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function triageAuthoritySegments(text: string): string[] {
  return normalizeTriageAuthorityText(text)
    .split(/(?:[.!?;\n]+|\b(?:but|however|yet|although)\b)/u)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function matchRanges(text: string, pattern: RegExp): Array<{ start: number; end: number }> {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('u') ? 'gu' : 'g');
  return [...text.matchAll(matcher)].map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Detect an affirmative semantic relation between two concepts in either word
 * order. Negation inside the bounded bridge reverses the relation and is safe.
 * This is deliberately concept-based rather than an exact sentence denylist:
 * Task Context remains prose, but it cannot assert package-owned authority.
 */
function hasAffirmativeBridge(
  segment: string,
  left: RegExp,
  right: RegExp,
  relation: RegExp,
  maxBridgeLength = 180,
): boolean {
  for (const leftRange of matchRanges(segment, left)) {
    for (const rightRange of matchRanges(segment, right)) {
      const bridgeStart = Math.min(leftRange.end, rightRange.end);
      const bridgeEnd = Math.max(leftRange.start, rightRange.start);
      if (bridgeEnd < bridgeStart || bridgeEnd - bridgeStart > maxBridgeLength) continue;
      const bridge = segment.slice(bridgeStart, bridgeEnd);
      if (relation.test(bridge) && !TRIAGE_NEGATION.test(bridge)) return true;
    }
  }
  return false;
}

function retiredAliasIsSafeMigrationOrRejection(segment: string): boolean {
  const explicitRejection = /\b(?:reject|retire|retired|obsolete|deprecated|prohibit|forbid|disallow)\b/u.test(segment)
    || /\b(?:do|does|must|may|should|can)\s+not\s+(?:use|accept|emit|sign|treat)\b/u.test(segment);
  const migration = /\b(?:legacy|compatibility|migration|input\s+alias)\b/u.test(segment)
    && /\b(?:normalize|map|translate|migrate|canonicalize)\b/u.test(segment);
  return explicitRejection || migration;
}

function reviewTriageAuthorityViolation(text: string): ReviewTriageAuthorityViolation | null {
  for (const segment of triageAuthoritySegments(text)) {
    if (RETIRED_APPLICABILITY_ALIAS.test(segment)) {
      const assertsCurrentVerdict = /\b(?:current|official|applicability)\s+verdict\b/u.test(segment)
        && /\b(?:use|treat|accept|is|becomes|means|counts|classify|set)\b/u.test(segment)
        && !TRIAGE_NEGATION.test(segment);
      if (assertsCurrentVerdict || !retiredAliasIsSafeMigrationOrRejection(segment)) {
        return 'retired applicability verdict used as authority';
      }
    }

    const deferral = /\b(?:defer\s+with\s+proof|deferral|finding\s+deferral\s+disposition)\b/u;
    const applicabilityVerdict = /\b(?:applicability\s+)?verdict\b/u;
    if (hasAffirmativeBridge(
      segment,
      deferral,
      applicabilityVerdict,
      /\b(?:is|as|means|becomes|counts|equals|qualifies|serves|treat|classify|set|use)\b/u,
    )) {
      return 'disposition collapsed into applicability';
    }

    const unauthorizedActor = /\b(?:reviewers?|review\s+lane|agents?|story\s+owner)\b/u;
    const dispositionMinting = /\b(?:mint|sign|approve|create|issue|generate|authorize)(?:s|ing)?\b/u;
    if (deferral.test(segment) && hasAffirmativeBridge(
      segment,
      unauthorizedActor,
      dispositionMinting,
      /\b(?:may|can|must|should|will|permitted|allowed|authorized|able|is|are|to|for)\b/u,
    )) {
      return 'unauthorized disposition minting';
    }
    const compatibilityAuthority = /\b(?:current\s+cli|compatibility\s+cli|compatibility\s+path)\b/u;
    const futureCapability = /\b(?:implement|support|mint|sign|create|issue)(?:s|ing)?\b/u;
    if (deferral.test(segment) && hasAffirmativeBridge(
      segment,
      compatibilityAuthority,
      futureCapability,
      /\b(?:does|can|will|is|are|to)\b/u,
    )) {
      return 'unauthorized disposition minting';
    }

    const severity = /\b(?:severity|critical|high|medium|low)\b/u;
    const soleAuthority = /\b(?:alone|solely|only|automatically|by\s+itself|on\s+its\s+own)\b/u;
    const storyResponsibility = /\b(?:scope|applicability|ownership|owns?|belongs?|responsibility|current\s+story|routing|repair)\b/u;
    if (soleAuthority.test(segment) && hasAffirmativeBridge(
      segment,
      severity,
      storyResponsibility,
      /\b(?:control|determine|decide|set|establish|make|define|assign|require)\w*\b/u,
    )) {
      return 'severity used as sole ownership or scope authority';
    }

    const dismissal = /\b(?:finding\s+dismiss|dismissal|dismissed)\b/u;
    const applicabilityOutcome = /\b(?:out\s+of\s+scope|non\s+applicable|applicability|deferral|repair|resolution|resolved)\b/u;
    if (hasAffirmativeBridge(
      segment,
      dismissal,
      applicabilityOutcome,
      /\b(?:prove|establish|confirm|demonstrate|mean|make|classify|set|count)\w*\b/u,
    )) {
      return 'dismissal used as applicability proof';
    }

    const unknownApplicability = /\b(?:unknown\s+applicability|applicability\s+(?:is|remains)\s+unknown)\b/u;
    const routingOrGateRelief = /\b(?:routing|route|defer|deferral|non\s+blocking|advisory|review\s+blocker|blocker)\b/u;
    if (hasAffirmativeBridge(
      segment,
      unknownApplicability,
      routingOrGateRelief,
      /\b(?:permit|allow|authorize|enable|route|defer|make|become|is|remove|clear|lift|bypass|waive)\w*\b/u,
    )) {
      return 'unknown applicability used to route or unblock';
    }
  }
  return null;
}

function reviewerTaskContextAuthorityText(taskContext: FullTaskContext): Array<[string, string]> {
  const values: Array<[string, string]> = [
    ['story.title', taskContext.title],
    ['story.description', taskContext.description],
  ];
  for (const item of taskContext.checklist) {
    values.push([`checklist.${item.id}.title`, item.title]);
    if (item.context !== undefined) values.push([`checklist.${item.id}.context`, item.context]);
    if (item.userSees !== undefined) values.push([`checklist.${item.id}.userSees`, item.userSees]);
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const intent of item.verificationIntent[lane]) {
        values.push([`verificationIntent.${intent.id}.desc`, intent.desc]);
      }
    }
  }
  return values;
}

/**
 * REVIEW role authority is package-owned. Story-authored Task Context may
 * describe work, tests, explicit rejection, and legacy migration, but it
 * cannot assert contradictory Finding-triage authority. The bounded semantic
 * check relates normalized concepts and assertion polarity, rather than
 * denying an exact sentence. It runs before envelope digests are minted, so
 * recomputing every content address cannot bless an authority injection.
 */
function assertReviewerTaskContextAuthoritySafety(
  roleId: string,
  taskContext: FullTaskContext,
): void {
  if (!isModularReviewerRoleId(roleId)) return;
  for (const [location, text] of reviewerTaskContextAuthorityText(taskContext)) {
    const violation = reviewTriageAuthorityViolation(text);
    if (violation) {
      throw new Error(
        `REVIEW Task Context contains unsafe Finding-triage authority at ${location}: ${violation}`,
      );
    }
  }
}

function canonicalStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

export function buildFullTaskContext(args: {
  story: StoryInfo;
  checklist: ChecklistData;
  headHash: string;
  materialHash?: string;
  storyFilesHash?: string;
  scopeContract?: ScopeContractData | null;
}): FullTaskContext {
  const context: FullTaskContext = {
    schemaVersion: 'proofbound.full-task-context.v1',
    storyId: args.story.storyId,
    title: args.story.title,
    description: args.story.description,
    phase: args.story.phase,
    priority: args.story.priority,
    checklist: [...args.checklist.items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
        ...(item.context?.trim() ? { context: item.context } : {}),
        ...(item.userSees?.trim() ? { userSees: item.userSees } : {}),
        relatedDocs: canonicalStrings(item.relatedDocs),
        files: {
          modify: canonicalStrings(item.files?.modify),
          create: canonicalStrings(item.files?.create),
          test: canonicalStrings(item.files?.test),
        },
        verificationIntent: Object.fromEntries(
          (['happy', 'edge', 'adversarial'] as const).map(lane => [
            lane,
            (item.verificationIntent?.[lane] ?? []).map((intent, index) => ({
              id: intent.id?.trim() || `${item.id}:${lane}:${index}`,
              desc: intent.desc,
              type: intent.type,
              ...(intent.requiredIn ? { requiredIn: intent.requiredIn } : {}),
              ...(intent.priority ? { priority: intent.priority } : {}),
            })),
          ]),
        ) as FullTaskContext['checklist'][number]['verificationIntent'],
      })),
    headHash: args.headHash,
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    ...(args.scopeContract ? {
      scopeContractDigest: digestScopeContract(args.scopeContract),
      scope: {
        mode: args.scopeContract.mode,
        allowedModify: canonicalStrings(args.scopeContract.allowedModify),
        allowedCreate: canonicalStrings(args.scopeContract.allowedCreate),
        allowedTest: canonicalStrings(args.scopeContract.allowedTest),
        protectedFiles: canonicalStrings(args.scopeContract.protectedFiles),
        explicitExcludes: canonicalStrings(args.scopeContract.explicitExcludes),
        protectedAnchors: canonicalStrings(args.scopeContract.protectedAnchors),
        fileRules: [...(args.scopeContract.fileRules ?? [])]
          .map(rule => ({
            path: rule.path,
            allowedAnchors: canonicalStrings(rule.allowedAnchors),
            deniedAnchors: canonicalStrings(rule.deniedAnchors),
            protectedAnchors: canonicalStrings(rule.protectedAnchors),
            allowedChangeKinds: canonicalStrings(rule.allowedChangeKinds),
            intentRefs: canonicalStrings(rule.intentRefs),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        ...(args.scopeContract.pathCanonicalizerVersion ? {
          pathCanonicalizerVersion: args.scopeContract.pathCanonicalizerVersion,
        } : {}),
        ...(args.scopeContract.pathCanonicalizationMode ? {
          pathCanonicalizationMode: args.scopeContract.pathCanonicalizationMode,
        } : {}),
        ...(args.scopeContract.anchorParserVersion ? {
          anchorParserVersion: args.scopeContract.anchorParserVersion,
        } : {}),
        ...(args.scopeContract.anchorArtifactVersion ? {
          anchorArtifactVersion: args.scopeContract.anchorArtifactVersion,
        } : {}),
        ...(args.scopeContract.astAnchorMode ? { astAnchorMode: args.scopeContract.astAnchorMode } : {}),
      },
    } : {}),
  };
  validateFullTaskContext(context);
  return context;
}

export function fullTaskSemanticDigest(context: FullTaskContext): string {
  const {
    headHash: _headHash,
    materialHash: _materialHash,
    storyFilesHash: _storyFilesHash,
    phase: _phase,
    ...modelRelevant
  } = context;
  // Review evidence is produced in REVIEW and consumed again after the
  // mandatory REVIEW -> TEST transition. Only TEST is mapped back to that
  // producer phase: DEV, DONE, DISCARDED, and malformed phases must remain
  // distinct so evidence from an inadmissible lifecycle state fails closed.
  const semanticPhase = context.phase === 'TEST' ? 'REVIEW' : context.phase;
  return domainSeparatedDigest('full-task-context.model-relevant.v1', {
    ...modelRelevant,
    phase: semanticPhase,
  });
}

export function captureKnownExecutionEnvironment(): KnownExecutionEnvironment {
  const value: KnownExecutionEnvironment = {
    schemaVersion: 'proofbound.known-execution-environment.v1',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cliVersion: LATTICE_CLI_VERSION,
    source: 'trusted-local-runtime',
  };
  validateKnownExecutionEnvironment(value);
  return Object.freeze(value);
}

export function promptEnvelopeSemanticValue(envelope: PromptEnvelope): Record<string, unknown> {
  const { envelopeId: _envelopeId, createdAt: _createdAt, ...semantic } = envelope;
  return semantic;
}

export function computePromptEnvelopeId(envelope: PromptEnvelope): string {
  return domainSeparatedDigest('prompt-envelope.semantic.v1', promptEnvelopeSemanticValue(envelope));
}

export function verifyPromptEnvelopeIntegrity(envelope: PromptEnvelope): boolean {
  try {
    validatePromptEnvelope(envelope);
    return envelope.envelopeId === computePromptEnvelopeId(envelope);
  } catch {
    return false;
  }
}

export function assembleFullPromptEnvelope(input: FullPromptAssemblyInput): FullPromptAssembly {
  validateFullTaskContext(input.taskContext);
  assertReviewerTaskContextAuthoritySafety(input.roleContract.roleId, input.taskContext);
  const environment = input.knownExecutionEnvironment ?? captureKnownExecutionEnvironment();
  validateKnownExecutionEnvironment(environment);
  if (input.roleContract.status !== 'active') {
    throw new Error(`full Prompt Envelope requires an active role; ${input.roleContract.roleId} is ${input.roleContract.status}`);
  }
  assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
  if (input.dispatchKind === 'review-run') {
    for (const [key, value] of Object.entries({
      reviewRunId: input.reviewRunId,
      reviewRound: input.reviewRound,
      lane: input.lane,
    })) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`review-run Prompt Envelope requires ${key}`);
      }
    }
    if (input.roleContract.roleId !== input.lane) {
      throw new Error(
        `review-run Prompt Envelope role/lane mismatch: ${input.roleContract.roleId} !== ${input.lane}`,
      );
    }
    if (typeof input.dispatchPrompt !== 'string' || input.dispatchPrompt.length === 0) {
      throw new Error('review-run Prompt Envelope requires the exact story-dispatch prompt bytes');
    }
    if (!/^[a-f0-9]{64}$/.test(input.hostRenderIdentityDigest ?? '')) {
      throw new Error('review-run Prompt Envelope requires a hostRenderIdentityDigest');
    }
  } else if (input.reviewRunId !== undefined || input.reviewRound !== undefined || input.lane !== undefined) {
    throw new Error('story-dispatch Prompt Envelope cannot carry reviewer authority');
  }

  const prompt = renderFullPrompt(
    input.runtimeContract,
    input.roleContract,
    input.taskContext,
    environment,
    input.rolePrompt,
    input.dispatchPrompt,
  );
  const envelopeWithoutId: Omit<PromptEnvelope, 'envelopeId'> = {
    schemaVersion: 'proofbound.prompt-envelope.v1',
    roleId: input.roleContract.roleId,
    storyId: input.taskContext.storyId,
    dispatchKind: input.dispatchKind,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    ...(input.reviewRound ? { reviewRound: input.reviewRound } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.dispatchPrompt ? { dispatchPromptDigest: reviewerDispatchPromptDigest(input.dispatchPrompt) } : {}),
    ...(input.hostRenderIdentityDigest ? { hostRenderIdentityDigest: input.hostRenderIdentityDigest } : {}),
    createdAt: input.createdAt,
    headHash: input.taskContext.headHash,
    runtimeContractVersion: input.runtimeContract.schemaVersion,
    runtimeSemanticDigest: input.runtimeContract.semanticDigest,
    runtimeRenderDigest: input.runtimeContract.renderDigest,
    roleContractVersion: input.roleContract.schemaVersion,
    roleSemanticDigest: input.roleContract.semanticDigest,
    roleRenderDigest: input.roleContract.renderDigest,
    contextMode: 'full',
    contextDigest: domainSeparatedDigest('full-task-context.v1', input.taskContext),
    ...(input.taskContext.materialHash ? { materialHash: input.taskContext.materialHash } : {}),
    ...(input.taskContext.storyFilesHash ? { storyFilesHash: input.taskContext.storyFilesHash } : {}),
    ...(input.taskContext.scopeContractDigest ? { policyHash: input.taskContext.scopeContractDigest } : {}),
    eligibilityDecision: 'full',
    eligibilityDigest: domainSeparatedDigest('prompt-full-eligibility.v1', {
      roleId: input.roleContract.roleId,
      roleStatus: input.roleContract.status,
      dispatchKind: input.dispatchKind,
      contextMode: 'full',
    }),
    knownExecutionEnvironmentDigest: domainSeparatedDigest('known-execution-environment.v1', environment),
    assemblerVersion: PROMPT_ENVELOPE_ASSEMBLER_VERSION,
    dispatchProtocolVersion: PROMPT_DISPATCH_PROTOCOL_VERSION,
    launcherSpecDigest: domainSeparatedDigest('prompt-launcher-spec.v1', input.launcherSpec ?? { kind: input.dispatchKind }),
    commandPolicyDigest: domainSeparatedDigest('prompt-command-policy.v1', input.commandPolicy ?? input.roleContract.allowedCommandIds),
    ...(input.toolPolicy !== undefined ? { toolPolicyDigest: domainSeparatedDigest('prompt-tool-policy.v1', input.toolPolicy) } : {}),
    ...(input.systemInstruction !== undefined ? { systemInstructionDigest: domainSeparatedDigest('prompt-system-instruction.v1', input.systemInstruction) } : {}),
    assembledPromptDigest: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', prompt),
    bytes: promptUtf8Bytes(prompt),
    lines: promptLogicalLines(prompt),
    estimatedTokens: estimatePromptTokens(prompt),
    tokenEstimatorVersion: PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
  };
  const provisional = { ...envelopeWithoutId, envelopeId: '0'.repeat(64) } as PromptEnvelope;
  const envelope = { ...envelopeWithoutId, envelopeId: computePromptEnvelopeId(provisional) } as PromptEnvelope;
  validatePromptEnvelope(envelope);
  if (!verifyPromptEnvelopeIntegrity(envelope)) throw new Error('assembled Prompt Envelope failed integrity verification');
  return { prompt, taskContext: input.taskContext, knownExecutionEnvironment: environment, envelope };
}

/**
 * Safety is resolved before cost. A required full prompt remains full even when
 * over budget; cost can only select full from an already-safe incremental path.
 */
export function assembleConditionalReviewPromptEnvelope(
  input: ConditionalReviewAssemblyInput,
): ConditionalReviewAssembly {
  if (input.dispatchKind !== 'review-run') {
    throw new Error('conditional review assembly is available only for review-run dispatch');
  }
  const full = assembleFullPromptEnvelope(input);
  const fullBudgetBytes = Number.isSafeInteger(input.fullBudgetBytes) && input.fullBudgetBytes! >= 0
    ? input.fullBudgetBytes!
    : 256_000;
  const incrementalBudgetBytes = Number.isSafeInteger(input.incrementalBudgetBytes) && input.incrementalBudgetBytes! >= 0
    ? input.incrementalBudgetBytes!
    : 64_000;
  const fullBudgetViolation = full.envelope.bytes > fullBudgetBytes;
  const basis = input.reviewBasis ?? null;
  const safetyRequiresFull = !input.incrementalEligible || !basis;
  let incrementalPrompt: string | undefined;
  if (basis) {
    validateIncrementalReviewBasis(basis);
    incrementalPrompt = renderIncrementalPrompt(
      input.runtimeContract,
      input.roleContract,
      basis,
      full.knownExecutionEnvironment,
      input.rolePrompt,
      input.dispatchPrompt!,
    );
  }
  const incrementalBytes = incrementalPrompt ? promptUtf8Bytes(incrementalPrompt) : undefined;
  let selectionReason: NonNullable<PromptEnvelope['selectionReason']>;
  if (input.reviewerEscalationReason?.trim()) {
    selectionReason = 'REVIEWER_REQUESTED_FULL';
  } else if (safetyRequiresFull) {
    selectionReason = 'SAFETY_REQUIRES_FULL';
  } else if (incrementalBytes! > incrementalBudgetBytes) {
    selectionReason = 'INCREMENTAL_BUDGET_EXCEEDED';
  } else if (incrementalBytes! >= full.envelope.bytes) {
    selectionReason = 'FULL_CHEAPER_OR_EQUAL';
  } else {
    selectionReason = 'SAFE_INCREMENTAL';
  }
  const contextMode = selectionReason === 'SAFE_INCREMENTAL' ? 'incremental' as const : 'full' as const;
  const prompt = contextMode === 'incremental' ? incrementalPrompt! : full.prompt;
  const envelopeBase: PromptEnvelope = {
    ...full.envelope,
    contextMode,
    eligibilityDecision: contextMode,
    contextDigest: contextMode === 'incremental'
      ? domainSeparatedDigest('incremental-review-basis.v1', basis!)
      : full.envelope.contextDigest,
    ...(input.priorPassRef ? { priorPassRef: input.priorPassRef } : {}),
    eligibilityDigest: input.eligibilityDigest,
    freshnessClassification: input.freshnessClassification,
    impactPolicyVersion: input.impactPolicyVersion,
    eligibilityReasonCodes: [...new Set(input.eligibilityReasonCodes)].sort(),
    changedFilesDigest: input.changedFilesDigest,
    impactedFilesDigest: input.impactedFilesDigest,
    taskSemanticDigest: fullTaskSemanticDigest(input.taskContext),
    ...(basis ? {
      reviewBasisDigest: domainSeparatedDigest('incremental-review-basis.v1', basis),
      incrementalContextDigest: domainSeparatedDigest('incremental-review-context.raw-utf8.v1', incrementalPrompt!),
    } : {}),
    selectionReason,
    fullContextBytes: full.envelope.bytes,
    ...(incrementalBytes !== undefined ? { incrementalContextBytes: incrementalBytes } : {}),
    escalatedToFull: contextMode === 'full' && Boolean(basis),
    ...(selectionReason === 'REVIEWER_REQUESTED_FULL'
      ? { escalationReason: input.reviewerEscalationReason!.trim() }
      : selectionReason !== 'SAFE_INCREMENTAL' && basis
        ? { escalationReason: selectionReason }
        : {}),
    ...((contextMode === 'full' && fullBudgetViolation)
      ? { budgetViolation: 'full' as const }
      : (selectionReason === 'INCREMENTAL_BUDGET_EXCEEDED')
        ? { budgetViolation: 'incremental' as const }
        : {}),
    assembledPromptDigest: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', prompt),
    bytes: promptUtf8Bytes(prompt),
    lines: promptLogicalLines(prompt),
    estimatedTokens: estimatePromptTokens(prompt),
  };
  const provisional = { ...envelopeBase, envelopeId: '0'.repeat(64) };
  const envelope = { ...envelopeBase, envelopeId: computePromptEnvelopeId(provisional) };
  validatePromptEnvelope(envelope);
  if (!verifyPromptEnvelopeIntegrity(envelope)) throw new Error('conditional Prompt Envelope failed integrity verification');
  return {
    prompt,
    taskContext: full.taskContext,
    knownExecutionEnvironment: full.knownExecutionEnvironment,
    envelope,
    selectionReason,
    fullPrompt: full.prompt,
    ...(incrementalPrompt ? { incrementalPrompt } : {}),
  };
}

/**
 * Reconstructs the exact trusted assembly from canonical inputs and rejects any
 * mismatch between the persisted bytes and the gate-consumed envelope.
 */
export function verifyFullPromptAssemblyIntegrity(input: {
  prompt: string;
  envelope: PromptEnvelope;
  runtimeContract: RuntimeContract;
  roleContract: RoleContract;
  rolePrompt: string;
  dispatchPrompt?: string;
  hostRenderIdentityDigest?: string;
}): boolean {
  try {
    assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
    validatePromptEnvelope(input.envelope);
    const taskMarker = '\n\n## Task Context\n\n';
    const environmentMarker = '\n\n## Known Execution Environment\n\n';
    const dispatchPromptMarker = '\n\n## Dispatch Prompt\n\n';
    const rolePromptMarker = '\n\n## Role Prompt\n\n';
    const taskStart = input.prompt.indexOf(taskMarker);
    const environmentStart = input.prompt.indexOf(environmentMarker, taskStart + taskMarker.length);
    const dispatchPromptStart = input.prompt.indexOf(
      dispatchPromptMarker,
      environmentStart + environmentMarker.length,
    );
    const rolePromptStart = input.prompt.indexOf(rolePromptMarker, environmentStart + environmentMarker.length);
    if (taskStart < 0 || environmentStart < 0 || rolePromptStart < 0) return false;
    const taskJson = input.prompt.slice(taskStart + taskMarker.length, environmentStart);
    const environmentEnd = dispatchPromptStart >= 0 ? dispatchPromptStart : rolePromptStart;
    const environmentJson = input.prompt.slice(environmentStart + environmentMarker.length, environmentEnd);
    const embeddedDispatchPrompt = dispatchPromptStart >= 0
      ? input.prompt.slice(dispatchPromptStart + dispatchPromptMarker.length, rolePromptStart)
      : undefined;
    if (embeddedDispatchPrompt !== input.dispatchPrompt) return false;
    const taskContext = JSON.parse(taskJson) as FullTaskContext;
    const environment = JSON.parse(environmentJson) as KnownExecutionEnvironment;
    validateFullTaskContext(taskContext);
    validateKnownExecutionEnvironment(environment);
    if (canonicalJsonStringify(taskContext) !== taskJson) return false;
    if (canonicalJsonStringify(environment) !== environmentJson) return false;
    const expectedPrompt = renderFullPrompt(
      input.runtimeContract,
      input.roleContract,
      taskContext,
      environment,
      input.rolePrompt,
      input.dispatchPrompt,
    );
    if (input.prompt !== expectedPrompt) return false;
    const envelope = input.envelope;
    return envelope.assemblerVersion === PROMPT_ENVELOPE_ASSEMBLER_VERSION
      && envelope.dispatchProtocolVersion === PROMPT_DISPATCH_PROTOCOL_VERSION
      && envelope.roleId === input.roleContract.roleId
      && envelope.runtimeContractVersion === input.runtimeContract.schemaVersion
      && envelope.runtimeSemanticDigest === input.runtimeContract.semanticDigest
      && envelope.runtimeRenderDigest === input.runtimeContract.renderDigest
      && envelope.roleContractVersion === input.roleContract.schemaVersion
      && envelope.roleSemanticDigest === input.roleContract.semanticDigest
      && envelope.roleRenderDigest === input.roleContract.renderDigest
      && envelope.dispatchPromptDigest === (
        input.dispatchPrompt === undefined ? undefined : reviewerDispatchPromptDigest(input.dispatchPrompt)
      )
      && envelope.hostRenderIdentityDigest === input.hostRenderIdentityDigest
      && envelope.storyId === taskContext.storyId
      && envelope.headHash === taskContext.headHash
      && envelope.materialHash === taskContext.materialHash
      && envelope.storyFilesHash === taskContext.storyFilesHash
      && envelope.policyHash === taskContext.scopeContractDigest
      && envelope.contextDigest === domainSeparatedDigest('full-task-context.v1', taskContext)
      && envelope.knownExecutionEnvironmentDigest === domainSeparatedDigest('known-execution-environment.v1', environment)
      && envelope.assembledPromptDigest === domainSeparatedDigest('assembled-prompt.raw-utf8.v1', input.prompt)
      && envelope.bytes === promptUtf8Bytes(input.prompt)
      && envelope.lines === promptLogicalLines(input.prompt)
      && envelope.estimatedTokens === estimatePromptTokens(input.prompt);
  } catch {
    return false;
  }
}

export function verifyIncrementalPromptAssemblyIntegrity(input: {
  prompt: string;
  envelope: PromptEnvelope;
  runtimeContract: RuntimeContract;
  roleContract: RoleContract;
  rolePrompt: string;
  dispatchPrompt: string;
  hostRenderIdentityDigest: string;
}): boolean {
  try {
    assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
    validatePromptEnvelope(input.envelope);
    if (input.envelope.contextMode !== 'incremental') return false;
    const basisMarker = '\n\n## Incremental Review Basis\n\n';
    const environmentMarker = '\n\n## Known Execution Environment\n\n';
    const dispatchPromptMarker = '\n\n## Dispatch Prompt\n\n';
    const rolePromptMarker = '\n\n## Role Prompt\n\n';
    const basisStart = input.prompt.indexOf(basisMarker);
    const environmentStart = input.prompt.indexOf(environmentMarker, basisStart + basisMarker.length);
    const dispatchStart = input.prompt.indexOf(dispatchPromptMarker, environmentStart + environmentMarker.length);
    const roleStart = input.prompt.indexOf(rolePromptMarker, dispatchStart + dispatchPromptMarker.length);
    if (basisStart < 0 || environmentStart < 0 || dispatchStart < 0 || roleStart < 0) return false;
    const basisJson = input.prompt.slice(basisStart + basisMarker.length, environmentStart);
    const environmentJson = input.prompt.slice(environmentStart + environmentMarker.length, dispatchStart);
    const embeddedDispatchPrompt = input.prompt.slice(dispatchStart + dispatchPromptMarker.length, roleStart);
    const basis = JSON.parse(basisJson) as IncrementalReviewBasis;
    const environment = JSON.parse(environmentJson) as KnownExecutionEnvironment;
    validateIncrementalReviewBasis(basis);
    validateKnownExecutionEnvironment(environment);
    if (canonicalJsonStringify(basis) !== basisJson || canonicalJsonStringify(environment) !== environmentJson) return false;
    if (embeddedDispatchPrompt !== input.dispatchPrompt) return false;
    const expected = renderIncrementalPrompt(
      input.runtimeContract,
      input.roleContract,
      basis,
      environment,
      input.rolePrompt,
      input.dispatchPrompt,
    );
    const envelope = input.envelope;
    return input.prompt === expected
      && envelope.roleId === input.roleContract.roleId
      && envelope.runtimeContractVersion === input.runtimeContract.schemaVersion
      && envelope.runtimeSemanticDigest === input.runtimeContract.semanticDigest
      && envelope.runtimeRenderDigest === input.runtimeContract.renderDigest
      && envelope.roleContractVersion === input.roleContract.schemaVersion
      && envelope.roleSemanticDigest === input.roleContract.semanticDigest
      && envelope.roleRenderDigest === input.roleContract.renderDigest
      && envelope.dispatchPromptDigest === reviewerDispatchPromptDigest(input.dispatchPrompt)
      && envelope.hostRenderIdentityDigest === input.hostRenderIdentityDigest
      && envelope.storyId === basis.storyId
      && envelope.lane === basis.lane
      && envelope.priorPassRef === basis.priorPassRef
      && envelope.contextDigest === domainSeparatedDigest('incremental-review-basis.v1', basis)
      && envelope.reviewBasisDigest === domainSeparatedDigest('incremental-review-basis.v1', basis)
      && envelope.incrementalContextDigest === domainSeparatedDigest('incremental-review-context.raw-utf8.v1', input.prompt)
      && envelope.knownExecutionEnvironmentDigest === domainSeparatedDigest('known-execution-environment.v1', environment)
      && envelope.assembledPromptDigest === domainSeparatedDigest('assembled-prompt.raw-utf8.v1', input.prompt)
      && envelope.bytes === promptUtf8Bytes(input.prompt)
      && envelope.lines === promptLogicalLines(input.prompt)
      && envelope.estimatedTokens === estimatePromptTokens(input.prompt)
      && verifyPromptEnvelopeIntegrity(envelope);
  } catch {
    return false;
  }
}
