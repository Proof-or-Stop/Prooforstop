import {
  canonicalJsonStringify,
  domainSeparatedDigest,
  estimatePromptTokens,
  PROMPT_CONTRACT_ALGORITHMS,
  promptLogicalLines,
  promptUtf8Bytes,
  validateFullTaskContext,
  validateKnownExecutionEnvironment,
  validatePromptEnvelope,
  type FullTaskContext,
  type KnownExecutionEnvironment,
  type PromptEnvelope,
  type RoleContract,
  type RuntimeContract,
} from './prompt-contracts.js';
import { LATTICE_CLI_VERSION } from './lattice-brand.js';
import type { ChecklistData, ScopeContractData, StoryInfo } from './types.js';
import { digestScopeContract } from './guard-session.js';

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
}

export interface FullPromptAssembly {
  prompt: string;
  taskContext: FullTaskContext;
  knownExecutionEnvironment: KnownExecutionEnvironment;
  envelope: PromptEnvelope;
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
      })),
    headHash: args.headHash,
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    ...(args.scopeContract ? { scopeContractDigest: digestScopeContract(args.scopeContract) } : {}),
  };
  validateFullTaskContext(context);
  return context;
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
  const environment = input.knownExecutionEnvironment ?? captureKnownExecutionEnvironment();
  validateKnownExecutionEnvironment(environment);
  if (input.roleContract.status !== 'active') {
    throw new Error(`full Prompt Envelope requires an active role; ${input.roleContract.roleId} is ${input.roleContract.status}`);
  }
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
  } else if (input.reviewRunId !== undefined || input.reviewRound !== undefined || input.lane !== undefined) {
    throw new Error('story-dispatch Prompt Envelope cannot carry reviewer authority');
  }

  const taskContextJson = canonicalJsonStringify(input.taskContext);
  const environmentJson = canonicalJsonStringify(environment);
  const prompt = [
    '## Runtime Contract',
    input.runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(input.roleContract),
    '## Task Context',
    taskContextJson,
    '## Known Execution Environment',
    environmentJson,
    '## Role Prompt',
    input.rolePrompt,
  ].join('\n\n');
  const envelopeWithoutId: Omit<PromptEnvelope, 'envelopeId'> = {
    schemaVersion: 'proofbound.prompt-envelope.v1',
    roleId: input.roleContract.roleId,
    storyId: input.taskContext.storyId,
    dispatchKind: input.dispatchKind,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    ...(input.reviewRound ? { reviewRound: input.reviewRound } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
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
