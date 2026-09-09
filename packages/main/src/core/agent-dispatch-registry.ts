import type {
  AgentDispatchCanonicalType,
  AgentDispatchIdentifierKind,
  AgentDispatchMutationCommand,
  AgentDispatchRegistryEntry,
  StoryPhase,
} from './types.js';
import { readBrandEnv } from './brand-env.js';
import { LEGACY_AGENT_ROLE_ALIASES, type CanonicalAgentRoleId } from './agent-role-identity.js';

const ITEM_REVIEW_MUTATIONS = ['review_run_start', 'finding_add', 'review_pass_set', 'managed_review_proposal_set'] as const;
const ITEM_REVIEW_EVIDENCE = ['review-run', 'finding', 'review-pass', 'managed-review-proposal'] as const;

function roleAliases(canonical: CanonicalAgentRoleId, extra: readonly string[] = []): readonly string[] {
  return [...LEGACY_AGENT_ROLE_ALIASES[canonical], ...extra];
}

/**
 * Canonical dispatch authority table.
 *
 * Consumers must resolve aliases through this table; role privilege must never
 * be inferred from a name prefix. Legacy verification names intentionally map
 * to verification-intent and therefore cannot inherit implementer authority.
 */
// Keep the exported table's public view at the contract level instead of
// preserving each row's literal canonicalName. Historical smoke/audit code
// still compares persisted lattice lane values against this table; widening
// the view keeps those comparisons expressible while the runtime rows below
// remain proof-or-stop canonical strings and aliases are still resolved to
// those rows.
export const AGENT_DISPATCH_REGISTRY: readonly AgentDispatchRegistryEntry[] = [
  {
    canonicalName: 'proof-or-stop-implementer',
    aliases: roleAliases('proof-or-stop-implementer'),
    roleClass: 'implementer',
    allowedPhases: ['DEV', 'TEST_CASE'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId', 'findingId', 'clusterId'],
    promptBuilder: 'implementer-dispatch',
    promptBuilderByIdentifier: { itemId: 'implementer-dispatch', findingId: 'finding-repair', clusterId: 'cluster-repair' },
    permittedMutations: ['checklist_update', 'finding_resolve', 'red_evidence_binding_set', 'red_evidence_quarantine', 'red_evidence_recover'],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['checklist-status', 'finding-resolution', 'cluster-resolution'],
  },
  {
    canonicalName: 'proof-or-stop-verification-intent',
    aliases: roleAliases('proof-or-stop-verification-intent'),
    roleClass: 'verification-intent',
    allowedPhases: ['PLAN'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId'],
    promptBuilder: 'verification-intent-item',
    promptBuilderByIdentifier: { itemId: 'verification-intent-item' },
    permittedMutations: ['checklist_update'],
    commitAllowed: false,
    reviewerLane: null,
    evidenceOwnership: ['verification-intent'],
  },
  {
    canonicalName: 'proof-or-stop-review-story-init',
    aliases: roleAliases('proof-or-stop-review-story-init'),
    roleClass: 'init-reviewer',
    allowedPhases: ['INIT'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'init-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ['init_check_set'],
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-review-story-init',
    evidenceOwnership: ['init-check'],
  },
  {
    canonicalName: 'proof-or-stop-product-reviewer',
    aliases: roleAliases('proof-or-stop-product-reviewer'),
    roleClass: 'init-reviewer',
    allowedPhases: ['INIT'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'product-init-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ['init_check_set'],
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-product-reviewer',
    evidenceOwnership: ['init-check'],
  },
  {
    canonicalName: 'proof-or-stop-review-scope-plan',
    aliases: roleAliases('proof-or-stop-review-scope-plan'),
    roleClass: 'scope-reviewer',
    allowedPhases: ['PLAN'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'scope-plan-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ['scope_check_save', 'topology_exclusion_approval_set'],
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-review-scope-plan',
    evidenceOwnership: ['scope-check', 'topology-exclusion-approval'],
  },
  {
    canonicalName: 'proof-or-stop-review-topology-critic',
    aliases: roleAliases('proof-or-stop-review-topology-critic'),
    roleClass: 'scope-reviewer',
    allowedPhases: ['PLAN', 'DEV', 'REVIEW'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'topology-critic-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ['topology_critic_receipt_set', 'review_run_start', 'finding_add', 'review_pass_set', 'review_inventory_critic_set'],
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-review-topology-critic',
    evidenceOwnership: ['topology-critic-receipt', 'review-run', 'finding', 'review-pass', 'review-inventory-critic-receipt'],
  },
  ...([
    'proof-or-stop-review-concept',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-behavior',
    'proof-or-stop-review-docs',
    // Retained for read-only historical classification. Runtime dispatch and
    // evidence eligibility reject it from the Prompt Role Contract registry.
    'proof-or-stop-review-channel',
  ] as const).map((canonicalName) => ({
    canonicalName,
    aliases: roleAliases(canonicalName),
    roleClass: 'story-reviewer' as const,
    allowedPhases: ['REVIEW'] as const,
    targetCardinality: 'story-only' as const,
    identifierKinds: [] as const,
    promptBuilder: 'story-review' as const,
    promptBuilderByIdentifier: {},
    permittedMutations: ITEM_REVIEW_MUTATIONS,
    commitAllowed: false,
    reviewerLane: canonicalName,
    evidenceOwnership: ITEM_REVIEW_EVIDENCE,
  })),
  {
    canonicalName: 'proof-or-stop-review-test-coverage',
    aliases: roleAliases('proof-or-stop-review-test-coverage'),
    roleClass: 'coverage-reviewer',
    allowedPhases: ['REVIEW'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'coverage-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ITEM_REVIEW_MUTATIONS,
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-review-test-coverage',
    evidenceOwnership: ITEM_REVIEW_EVIDENCE,
  },
  {
    canonicalName: 'proof-or-stop-review-delivery',
    aliases: roleAliases('proof-or-stop-review-delivery'),
    roleClass: 'delivery-reviewer',
    allowedPhases: ['TEST'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'delivery-review',
    promptBuilderByIdentifier: {},
    permittedMutations: ['delivery_check_set'],
    commitAllowed: false,
    reviewerLane: 'proof-or-stop-review-delivery',
    evidenceOwnership: ['delivery-check'],
  },
  {
    canonicalName: 'proof-or-stop-finding-repair',
    aliases: roleAliases('proof-or-stop-finding-repair'),
    roleClass: 'repairer',
    allowedPhases: ['DEV'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['findingId'],
    promptBuilder: 'finding-repair',
    promptBuilderByIdentifier: { findingId: 'finding-repair' },
    permittedMutations: ['finding_resolve'],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['finding-resolution'],
  },
  {
    canonicalName: 'proof-or-stop-cluster-repair',
    aliases: roleAliases('proof-or-stop-cluster-repair'),
    roleClass: 'repairer',
    allowedPhases: ['DEV'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['clusterId'],
    promptBuilder: 'cluster-repair',
    promptBuilderByIdentifier: { clusterId: 'cluster-repair' },
    permittedMutations: [],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['cluster-resolution'],
  },
  {
    // Wave-4 cohort runner identity. Owns review_run_start so a parent that
    // sets PROOF_OR_STOP_AGENT=acceptance-rollout-verifier can mint ReviewRuns.
    // allowedPhases omits REVIEW so this actor does not join REVIEW_RUN_LANES.
    canonicalName: 'acceptance-rollout-verifier',
    aliases: [],
    roleClass: 'story-reviewer',
    allowedPhases: ['DEV', 'TEST'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'rollout-verify',
    promptBuilderByIdentifier: {},
    permittedMutations: ['review_run_start', 'finding_add', 'review_pass_set'],
    commitAllowed: false,
    reviewerLane: 'acceptance-rollout-verifier',
    evidenceOwnership: ['review-run', 'finding', 'review-pass'],
  },
] as const satisfies readonly AgentDispatchRegistryEntry[];

export class AgentDispatchRegistryDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDispatchRegistryDefinitionError';
  }
}

const VALID_ROLE_CLASSES = new Set(['implementer', 'verification-intent', 'init-reviewer', 'scope-reviewer', 'story-reviewer', 'item-reviewer', 'coverage-reviewer', 'delivery-reviewer', 'repairer']);
const VALID_PHASES = new Set(['IDEA', 'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE', 'DISCARDED', 'TEST_CASE', 'TEST_CASE_REVIEW', 'META']);
const VALID_CARDINALITIES = new Set(['story-only', 'exactly-one']);
const VALID_IDENTIFIERS = new Set(['itemId', 'findingId', 'clusterId']);
const VALID_PROMPT_BUILDERS = new Set(['implementer-dispatch', 'verification-intent-item', 'init-review', 'product-init-review', 'scope-plan-review', 'topology-critic-review', 'story-review', 'item-review', 'coverage-review', 'delivery-review', 'finding-repair', 'cluster-repair', 'rollout-verify']);
const VALID_MUTATIONS = new Set(['review_remediation_close', 'checklist_update', 'init_check_set', 'scope_check_save', 'topology_exclusion_approval_set', 'topology_critic_receipt_set', 'review_run_start', 'finding_add', 'review_pass_set', 'review_inventory_critic_set', 'delivery_check_set', 'finding_resolve', 'red_evidence_binding_set', 'red_evidence_quarantine', 'red_evidence_recover', 'managed_review_proposal_set']);
const VALID_EVIDENCE_OWNERSHIP = new Set(['checklist-status', 'verification-intent', 'init-check', 'scope-check', 'topology-exclusion-approval', 'topology-critic-receipt', 'review-inventory-critic-receipt', 'review-run', 'finding', 'review-pass', 'delivery-check', 'finding-resolution', 'cluster-resolution', 'managed-review-proposal']);

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentDispatchRegistryDefinitionError(`${label} must be a nonblank string`);
  }
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new AgentDispatchRegistryDefinitionError(`${label} must be an array`);
  for (const item of value) requireString(item, `${label} entry`);
  if (new Set(value).size !== value.length) {
    throw new AgentDispatchRegistryDefinitionError(`${label} contains duplicate entries`);
  }
}

function requireMembers(values: string[], allowed: ReadonlySet<string>, label: string): void {
  for (const value of values) {
    if (!allowed.has(value)) throw new AgentDispatchRegistryDefinitionError(`${label} contains undeclared value "${value}"`);
  }
}

/** Fail immediately if a future table row is partial, ambiguous, or grants an undeclared authority. */
export function validateAgentDispatchRegistry(entries: readonly unknown[]): void {
  const names = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new AgentDispatchRegistryDefinitionError(`registry entry ${index} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    requireString(entry.canonicalName, `registry entry ${index} canonicalName`);
    requireStringArray(entry.aliases, `${entry.canonicalName}.aliases`);
    requireString(entry.roleClass, `${entry.canonicalName}.roleClass`);
    requireStringArray(entry.allowedPhases, `${entry.canonicalName}.allowedPhases`);
    requireString(entry.targetCardinality, `${entry.canonicalName}.targetCardinality`);
    requireStringArray(entry.identifierKinds, `${entry.canonicalName}.identifierKinds`);
    requireString(entry.promptBuilder, `${entry.canonicalName}.promptBuilder`);
    if (!entry.promptBuilderByIdentifier || typeof entry.promptBuilderByIdentifier !== 'object' || Array.isArray(entry.promptBuilderByIdentifier)) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.promptBuilderByIdentifier must be an object`);
    }
    requireStringArray(entry.permittedMutations, `${entry.canonicalName}.permittedMutations`);
    if (typeof entry.commitAllowed !== 'boolean') {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.commitAllowed must be boolean`);
    }
    if (entry.reviewerLane !== null) requireString(entry.reviewerLane, `${entry.canonicalName}.reviewerLane`);
    requireStringArray(entry.evidenceOwnership, `${entry.canonicalName}.evidenceOwnership`);

    if (!VALID_ROLE_CLASSES.has(entry.roleClass)) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.roleClass is undeclared`);
    requireMembers(entry.allowedPhases, VALID_PHASES, `${entry.canonicalName}.allowedPhases`);
    if (!VALID_CARDINALITIES.has(entry.targetCardinality)) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.targetCardinality is undeclared`);
    requireMembers(entry.identifierKinds, VALID_IDENTIFIERS, `${entry.canonicalName}.identifierKinds`);
    if (!VALID_PROMPT_BUILDERS.has(entry.promptBuilder)) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.promptBuilder is undeclared`);
    const promptBuilderByIdentifier = entry.promptBuilderByIdentifier as Record<string, unknown>;
    requireMembers(Object.keys(promptBuilderByIdentifier), VALID_IDENTIFIERS, `${entry.canonicalName}.promptBuilderByIdentifier keys`);
    for (const [kind, builder] of Object.entries(promptBuilderByIdentifier)) {
      requireString(builder, `${entry.canonicalName}.promptBuilderByIdentifier.${kind}`);
      if (!VALID_PROMPT_BUILDERS.has(builder)) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.promptBuilderByIdentifier.${kind} is undeclared`);
    }
    requireMembers(entry.permittedMutations, VALID_MUTATIONS, `${entry.canonicalName}.permittedMutations`);
    requireMembers(entry.evidenceOwnership, VALID_EVIDENCE_OWNERSHIP, `${entry.canonicalName}.evidenceOwnership`);
    if (entry.allowedPhases.length === 0) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.allowedPhases cannot be empty`);
    if (entry.targetCardinality === 'story-only' && entry.identifierKinds.length !== 0) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} story-only target cannot accept identifiers`);
    }
    if (entry.targetCardinality === 'exactly-one' && entry.identifierKinds.length === 0) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} exactly-one target needs an identifier kind`);
    }
    const mappedKinds = Object.keys(promptBuilderByIdentifier).sort();
    const acceptedKinds = [...entry.identifierKinds].sort();
    if (entry.targetCardinality === 'story-only' && mappedKinds.length !== 0) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} story-only target cannot declare identifier prompt builders`);
    }
    if (entry.targetCardinality === 'exactly-one' && JSON.stringify(mappedKinds) !== JSON.stringify(acceptedKinds)) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.promptBuilderByIdentifier must map every and only accepted identifier kind`);
    }
    for (const name of [entry.canonicalName, ...entry.aliases]) {
      if (names.has(name)) throw new AgentDispatchRegistryDefinitionError(`duplicate canonical name or alias "${name}"`);
      names.add(name);
    }
  }
}

validateAgentDispatchRegistry(AGENT_DISPATCH_REGISTRY);

/**
 * Historical verification identities remain resolvable for actor/read paths,
 * but are deliberately outside AGENT_DISPATCH_REGISTRY and therefore cannot
 * be selected for a new dispatch. They have no mutation or evidence authority.
 */
export const LEGACY_AGENT_DISPATCH_REGISTRY: readonly AgentDispatchRegistryEntry[] = [
  {
    canonicalName: 'proof-or-stop-test-intent',
    aliases: roleAliases('proof-or-stop-test-intent'),
    roleClass: 'verification-intent',
    allowedPhases: ['PLAN', 'TEST_CASE', 'TEST_CASE_REVIEW'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId'],
    promptBuilder: 'verification-intent-item',
    promptBuilderByIdentifier: { itemId: 'verification-intent-item' },
    permittedMutations: [],
    commitAllowed: false,
    reviewerLane: null,
    evidenceOwnership: [],
  },
  {
    canonicalName: 'proof-or-stop-test-case-reviewer',
    aliases: roleAliases('proof-or-stop-test-case-reviewer'),
    roleClass: 'verification-intent',
    allowedPhases: ['TEST_CASE', 'TEST_CASE_REVIEW'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId'],
    promptBuilder: 'verification-intent-item',
    promptBuilderByIdentifier: { itemId: 'verification-intent-item' },
    permittedMutations: [],
    commitAllowed: false,
    reviewerLane: null,
    evidenceOwnership: [],
  },
] as const satisfies readonly AgentDispatchRegistryEntry[];

validateAgentDispatchRegistry(LEGACY_AGENT_DISPATCH_REGISTRY);

export type AgentDispatchRegistryErrorCode =
  | 'blank_agent_type'
  | 'unknown_agent_type'
  | 'legacy_agent_type'
  | 'invalid_dispatch_phase'
  | 'invalid_dispatch_cardinality';

export class AgentDispatchRegistryError extends Error {
  readonly code: AgentDispatchRegistryErrorCode;
  readonly acceptedTypes: readonly string[];

  constructor(code: AgentDispatchRegistryErrorCode, message: string, acceptedTypes: readonly string[]) {
    super(message);
    this.name = 'AgentDispatchRegistryError';
    this.code = code;
    this.acceptedTypes = acceptedTypes;
  }
}

export interface ResolvedAgentDispatchType {
  entry: AgentDispatchRegistryEntry;
  requestedType: string | undefined;
  canonicalType: AgentDispatchCanonicalType;
  usedDefault: boolean;
  usedAlias: boolean;
}

const byName = new Map<string, AgentDispatchRegistryEntry>();
for (const entry of AGENT_DISPATCH_REGISTRY) {
  byName.set(entry.canonicalName, entry);
  for (const alias of entry.aliases) byName.set(alias, entry);
}

const legacyByName = new Map<string, AgentDispatchRegistryEntry>();
for (const entry of LEGACY_AGENT_DISPATCH_REGISTRY) {
  legacyByName.set(entry.canonicalName, entry);
  for (const alias of entry.aliases) legacyByName.set(alias, entry);
}

export const AGENT_DISPATCH_ACCEPTED_TYPES = Object.freeze(
  [...byName.entries()]
    .filter(([, entry]) => entry.canonicalName !== 'proof-or-stop-review-channel')
    .map(([name]) => name)
    .sort(),
);

/** Resolve one explicit type or the deliberate omitted-type implementer default. */
export function resolveAgentDispatchType(agentType?: string): ResolvedAgentDispatchType {
  if (agentType === undefined) {
    const entry = byName.get('proof-or-stop-implementer')!;
    return {
      entry,
      requestedType: undefined,
      canonicalType: entry.canonicalName,
      usedDefault: true,
      usedAlias: false,
    };
  }
  if (agentType.trim().length === 0) {
    throw new AgentDispatchRegistryError(
      'blank_agent_type',
      `agentType must be omitted for the proof-or-stop-implementer default or be one of: ${AGENT_DISPATCH_ACCEPTED_TYPES.join(', ')}`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  const legacyEntry = legacyByName.get(agentType);
  if (legacyEntry) {
    throw new AgentDispatchRegistryError(
      'legacy_agent_type',
      `agentType "${agentType}" is a legacy read-side identity and is not dispatchable for new stories; use proof-or-stop-verification-intent for PLAN verificationIntent authoring`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  const entry = byName.get(agentType);
  if (!entry || entry.canonicalName === 'proof-or-stop-review-channel') {
    throw new AgentDispatchRegistryError(
      'unknown_agent_type',
      `${entry ? 'retired' : 'unknown'} agentType "${agentType}"; accepted types: ${AGENT_DISPATCH_ACCEPTED_TYPES.join(', ')}`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  return {
    entry,
    requestedType: agentType,
    canonicalType: entry.canonicalName,
    usedDefault: false,
    usedAlias: agentType !== entry.canonicalName,
  };
}

export function entryAcceptsIdentifier(
  entry: AgentDispatchRegistryEntry,
  identifierKind: AgentDispatchIdentifierKind,
): boolean {
  return entry.identifierKinds.includes(identifierKind);
}

/** Resolve prompt selection only from registry metadata; no consumer may infer it from role-name prefixes. */
export function resolveAgentDispatchPromptBuilder(
  entry: AgentDispatchRegistryEntry,
  identifierKind?: AgentDispatchIdentifierKind,
): AgentDispatchRegistryEntry['promptBuilder'] {
  if (entry.targetCardinality === 'story-only') return entry.promptBuilder;
  if (!identifierKind || !entry.identifierKinds.includes(identifierKind)) {
    throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} has no prompt builder for ${identifierKind ?? 'story-only'}`);
  }
  const builder = entry.promptBuilderByIdentifier[identifierKind];
  if (!builder) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} has no prompt builder for ${identifierKind}`);
  return builder;
}

export interface AgentDispatchTargetInput {
  itemId?: string;
  findingId?: string;
  clusterId?: string;
}

function providedIdentifiers(target: AgentDispatchTargetInput): AgentDispatchIdentifierKind[] {
  return (['itemId', 'findingId', 'clusterId'] as const).filter((kind) => {
    const value = target[kind];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function cardinalityGuidance(entry: AgentDispatchRegistryEntry): string {
  if (entry.targetCardinality === 'story-only') {
    return `${entry.canonicalName} is story-only; omit itemId, findingId, and clusterId`;
  }
  return `${entry.canonicalName} requires exactly one of: ${entry.identifierKinds.join(', ')}`;
}

/** Resolve and validate the complete dispatch contract before any prompt is built. */
export function validateCriticReviewPurpose(actor: string, purpose: unknown, epochId: unknown): void {
  if (purpose === undefined && epochId === undefined) return;
  if (resolveRegisteredAgentActor(actor)?.canonicalName !== 'proof-or-stop-review-topology-critic') {
    throw new Error('review purpose is available only to the registered topology critic');
  }
  if (purpose !== 'topology' && purpose !== 'inventory-completeness') throw new Error('unknown or missing critic review purpose');
  if (purpose === 'topology' && epochId !== undefined) throw new Error('topology purpose forbids inventoryEpochId');
  if (purpose === 'inventory-completeness' && (typeof epochId !== 'string' || !epochId.trim() || epochId !== epochId.trim())) {
    throw new Error('inventory-completeness purpose requires exact inventoryEpochId');
  }
}

export function validateAgentDispatchRequest(args: AgentDispatchTargetInput & {
  agentType?: string;
  phase: StoryPhase;
  reviewPurpose?: 'topology' | 'inventory-completeness';
  inventoryEpochId?: string;
}): ResolvedAgentDispatchType {
  const resolved = resolveAgentDispatchType(args.agentType);
  const { entry } = resolved;
  validateCriticReviewPurpose(resolved.canonicalType, args.reviewPurpose, args.inventoryEpochId);
  if (!entry.allowedPhases.includes(args.phase)) {
    throw new AgentDispatchRegistryError(
      'invalid_dispatch_phase',
      `${entry.canonicalName} cannot be dispatched during ${args.phase}; allowed phases: ${entry.allowedPhases.join(', ')}`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  const provided = providedIdentifiers(args);
  const valid = entry.targetCardinality === 'story-only'
    ? provided.length === 0
    : provided.length === 1 && entryAcceptsIdentifier(entry, provided[0]);
  if (!valid) {
    throw new AgentDispatchRegistryError(
      'invalid_dispatch_cardinality',
      `invalid dispatch target for ${entry.canonicalName}: ${cardinalityGuidance(entry)}; received ${provided.join(', ') || 'story-only'}`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  return resolved;
}

/** Return a registry row for a known actor; non-dispatch host identities remain unclassified. */
export function resolveRegisteredAgentActor(actor: string | undefined | null): AgentDispatchRegistryEntry | null {
  const value = actor?.trim();
  if (!value) return null;
  return byName.get(value) ?? legacyByName.get(value) ?? null;
}

/** True only for registered REVIEW lanes; prefix lookalikes never acquire reviewer authority. */
export function isRegisteredReviewAgent(actor: string | undefined | null): boolean {
  const entry = resolveRegisteredAgentActor(actor);
  return !!entry?.reviewerLane && entry.allowedPhases.includes('REVIEW');
}

export function entryPermitsMutation(
  entry: AgentDispatchRegistryEntry,
  command: AgentDispatchMutationCommand,
): boolean {
  return entry.permittedMutations.includes(command);
}

/**
 * Explicit non-dispatch identities used by trusted host/human callers.
 * Keep this list deliberately small and exact: spelling variants and prefix
 * lookalikes must not acquire host authority.
 */
export const TRUSTED_HOST_ACTOR_IDENTITIES = ['main', 'main-agent', 'human'] as const;

export type TrustedHostActorIdentity = typeof TRUSTED_HOST_ACTOR_IDENTITIES[number];

const trustedHostActorIdentities = new Set<string>(TRUSTED_HOST_ACTOR_IDENTITIES);

export function isTrustedHostActor(actor: string | undefined | null): boolean {
  const actorName = actor?.trim();
  return !actorName || trustedHostActorIdentities.has(actorName);
}

export function assertRegisteredAgentMutationAllowed(
  actor: string | undefined | null,
  command: AgentDispatchMutationCommand,
): AgentDispatchRegistryEntry | null {
  const actorName = actor?.trim();
  // Omitted identities and the small, explicit trusted-host set retain the
  // compatibility path. Every other supplied identity must be registered:
  // prefix lookalikes and misspellings never inherit host authority.
  if (isTrustedHostActor(actor)) return null;
  const entry = resolveRegisteredAgentActor(actor);
  if (!entry) {
    throw new Error(
      `${command} refused: actor "${actorName}" is not registered in the agent dispatch registry. [agent_dispatch_actor_unknown]`,
    );
  }
  if (!entryPermitsMutation(entry, command)) {
    throw new Error(
      `${command} refused: dispatched role "${actorName}" has no ${command} authority in the agent dispatch registry. [agent_dispatch_mutation_denied]`,
    );
  }
  return entry;
}

export interface ResolvedAgentMutationAuthority {
  actor: string | undefined;
  entry: AgentDispatchRegistryEntry | null;
  source: 'dispatched-env' | 'payload' | 'env' | 'omitted';
}

function sameAgentAuthority(left: string, right: string): boolean {
  if (left === right) return true;
  const leftEntry = resolveRegisteredAgentActor(left);
  const rightEntry = resolveRegisteredAgentActor(right);
  return !!leftEntry && leftEntry === rightEntry;
}

/**
 * Resolve mutation authority without allowing audit payload fields to override
 * the identity assigned to a dispatched process.
 *
 * A nonblank PROOF_OR_STOP_AGENT is authoritative for actor classification. A
 * registered role follows registry authority, an explicit trusted-host actor
 * retains host compatibility, and every other env actor fails closed before a
 * payload identity can replace it. When PROOF_OR_STOP_AGENT is blank or omitted, the
 * legacy host/payload compatibility path remains available.
 */
export function resolveAgentMutationAuthority(args: {
  command: AgentDispatchMutationCommand;
  payloadActors?: readonly (string | undefined | null)[];
  envActor?: string | undefined | null;
}): ResolvedAgentMutationAuthority {
  const envActor = (args.envActor === undefined ? readBrandEnv('AGENT') : args.envActor)?.trim() || undefined;
  const payloadActors = (args.payloadActors || [])
    .map((actor) => actor?.trim())
    .filter((actor): actor is string => !!actor);
  const payloadActor = payloadActors[0];

  for (const candidate of payloadActors.slice(1)) {
    if (!sameAgentAuthority(payloadActor, candidate)) {
      throw new Error(
        `${args.command} refused: conflicting payload identities "${payloadActor}" and "${candidate}". [agent_dispatch_identity_conflict]`,
      );
    }
  }

  const envEntry = resolveRegisteredAgentActor(envActor);
  if (envEntry) {
    if (payloadActor && !sameAgentAuthority(envActor!, payloadActor)) {
      throw new Error(
        `${args.command} refused: payload identity "${payloadActor}" cannot override dispatched PROOF_OR_STOP_AGENT "${envActor}". [agent_dispatch_identity_conflict]`,
      );
    }
    const entry = assertRegisteredAgentMutationAllowed(envActor, args.command);
    return { actor: envActor, entry, source: 'dispatched-env' };
  }

  // A supplied environment identity is provenance, not an optional audit
  // label. Only exact trusted-host identities reach the compatibility path;
  // an unknown/misspelled/lookalike actor must not be laundered by a payload
  // that names human/main or a registered role.
  if (envActor && !isTrustedHostActor(envActor)) {
    assertRegisteredAgentMutationAllowed(envActor, args.command);
  }

  const actor = payloadActor || envActor;
  const entry = assertRegisteredAgentMutationAllowed(actor, args.command);
  return {
    actor,
    entry,
    source: payloadActor ? 'payload' : envActor ? 'env' : 'omitted',
  };
}
