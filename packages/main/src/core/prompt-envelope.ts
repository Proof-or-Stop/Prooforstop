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

function renderFullPrompt(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  taskContext: FullTaskContext,
  environment: KnownExecutionEnvironment,
  rolePrompt: string,
): string {
  return [
    '## Runtime Contract',
    runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(roleContract),
    '## Task Context',
    canonicalJsonStringify(taskContext),
    '## Known Execution Environment',
    canonicalJsonStringify(environment),
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
  } else if (input.reviewRunId !== undefined || input.reviewRound !== undefined || input.lane !== undefined) {
    throw new Error('story-dispatch Prompt Envelope cannot carry reviewer authority');
  }

  const prompt = renderFullPrompt(
    input.runtimeContract,
    input.roleContract,
    input.taskContext,
    environment,
    input.rolePrompt,
  );
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
}): boolean {
  try {
    assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
    validatePromptEnvelope(input.envelope);
    const taskMarker = '\n\n## Task Context\n\n';
    const environmentMarker = '\n\n## Known Execution Environment\n\n';
    const rolePromptMarker = '\n\n## Role Prompt\n\n';
    const taskStart = input.prompt.indexOf(taskMarker);
    const environmentStart = input.prompt.indexOf(environmentMarker, taskStart + taskMarker.length);
    const rolePromptStart = input.prompt.indexOf(rolePromptMarker, environmentStart + environmentMarker.length);
    if (taskStart < 0 || environmentStart < 0 || rolePromptStart < 0) return false;
    const taskJson = input.prompt.slice(taskStart + taskMarker.length, environmentStart);
    const environmentJson = input.prompt.slice(environmentStart + environmentMarker.length, rolePromptStart);
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
