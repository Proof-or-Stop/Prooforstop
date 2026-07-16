import type {
  AgentDispatchCanonicalType,
  AgentDispatchIdentifierKind,
  AgentDispatchMutationCommand,
  AgentDispatchRegistryEntry,
  StoryPhase,
} from './types.js';

const ITEM_REVIEW_MUTATIONS = ['review_run_start', 'finding_add', 'review_pass_set'] as const;
const ITEM_REVIEW_EVIDENCE = ['review-run', 'finding', 'review-pass'] as const;

/**
 * Canonical dispatch authority table.
 *
 * Consumers must resolve aliases through this table; role privilege must never
 * be inferred from a name prefix. Legacy verification names intentionally map
 * to verification-intent and therefore cannot inherit implementer authority.
 */
export const AGENT_DISPATCH_REGISTRY = [
  {
    canonicalName: 'lattice-implementer',
    aliases: [],
    roleClass: 'implementer',
    allowedPhases: ['DEV', 'TEST_CASE'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId', 'findingId', 'clusterId'],
    promptBuilder: 'implementer-dispatch',
    permittedMutations: ['checklist_update', 'finding_resolve'],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['checklist-status', 'finding-resolution', 'cluster-resolution'],
  },
  {
    canonicalName: 'verification-intent',
    aliases: ['test-intent', 'test-case-reviewer'],
    roleClass: 'verification-intent',
    allowedPhases: ['PLAN'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['itemId'],
    promptBuilder: 'verification-intent-item',
    permittedMutations: ['checklist_update'],
    commitAllowed: false,
    reviewerLane: null,
    evidenceOwnership: ['verification-intent'],
  },
  {
    canonicalName: 'lattice-review-story-init',
    aliases: [],
    roleClass: 'init-reviewer',
    allowedPhases: ['INIT'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'init-review',
    permittedMutations: ['init_check_set'],
    commitAllowed: false,
    reviewerLane: 'lattice-review-story-init',
    evidenceOwnership: ['init-check'],
  },
  {
    canonicalName: 'product-reviewer',
    aliases: [],
    roleClass: 'init-reviewer',
    allowedPhases: ['INIT'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'product-init-review',
    permittedMutations: ['init_check_set'],
    commitAllowed: false,
    reviewerLane: 'product-reviewer',
    evidenceOwnership: ['init-check'],
  },
  {
    canonicalName: 'lattice-review-scope-plan',
    aliases: [],
    roleClass: 'scope-reviewer',
    allowedPhases: ['PLAN'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'scope-plan-review',
    permittedMutations: ['scope_check_save'],
    commitAllowed: false,
    reviewerLane: 'lattice-review-scope-plan',
    evidenceOwnership: ['scope-check'],
  },
  ...([
    'lattice-review-concept',
    'lattice-review-quality',
    'lattice-review-behavior',
    'lattice-review-docs',
    'lattice-review-channel',
  ] as const).map((canonicalName) => ({
    canonicalName,
    aliases: [],
    roleClass: 'story-reviewer' as const,
    allowedPhases: ['REVIEW'] as const,
    targetCardinality: 'story-only' as const,
    identifierKinds: [] as const,
    promptBuilder: 'story-review' as const,
    permittedMutations: ITEM_REVIEW_MUTATIONS,
    commitAllowed: false,
    reviewerLane: canonicalName,
    evidenceOwnership: ITEM_REVIEW_EVIDENCE,
  })),
  {
    canonicalName: 'lattice-review-test-coverage',
    aliases: [],
    roleClass: 'coverage-reviewer',
    allowedPhases: ['REVIEW'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'coverage-review',
    permittedMutations: ITEM_REVIEW_MUTATIONS,
    commitAllowed: false,
    reviewerLane: 'lattice-review-test-coverage',
    evidenceOwnership: ITEM_REVIEW_EVIDENCE,
  },
  {
    canonicalName: 'lattice-review-delivery',
    aliases: [],
    roleClass: 'delivery-reviewer',
    allowedPhases: ['TEST'],
    targetCardinality: 'story-only',
    identifierKinds: [],
    promptBuilder: 'delivery-review',
    permittedMutations: ['delivery_check_set'],
    commitAllowed: false,
    reviewerLane: 'lattice-review-delivery',
    evidenceOwnership: ['delivery-check'],
  },
  {
    canonicalName: 'lattice-finding-repair',
    aliases: [],
    roleClass: 'repairer',
    allowedPhases: ['DEV'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['findingId'],
    promptBuilder: 'finding-repair',
    permittedMutations: ['finding_resolve'],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['finding-resolution'],
  },
  {
    canonicalName: 'lattice-cluster-repair',
    aliases: [],
    roleClass: 'repairer',
    allowedPhases: ['DEV'],
    targetCardinality: 'exactly-one',
    identifierKinds: ['clusterId'],
    promptBuilder: 'cluster-repair',
    permittedMutations: [],
    commitAllowed: true,
    reviewerLane: null,
    evidenceOwnership: ['cluster-resolution'],
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
const VALID_PROMPT_BUILDERS = new Set(['implementer-dispatch', 'verification-intent-item', 'init-review', 'product-init-review', 'scope-plan-review', 'story-review', 'item-review', 'coverage-review', 'delivery-review', 'finding-repair', 'cluster-repair']);
const VALID_MUTATIONS = new Set(['checklist_update', 'init_check_set', 'scope_check_save', 'review_run_start', 'finding_add', 'review_pass_set', 'delivery_check_set', 'finding_resolve']);
const VALID_EVIDENCE_OWNERSHIP = new Set(['checklist-status', 'verification-intent', 'init-check', 'scope-check', 'review-run', 'finding', 'review-pass', 'delivery-check', 'finding-resolution', 'cluster-resolution']);

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
    requireMembers(entry.permittedMutations, VALID_MUTATIONS, `${entry.canonicalName}.permittedMutations`);
    requireMembers(entry.evidenceOwnership, VALID_EVIDENCE_OWNERSHIP, `${entry.canonicalName}.evidenceOwnership`);
    if (entry.allowedPhases.length === 0) throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName}.allowedPhases cannot be empty`);
    if (entry.targetCardinality === 'story-only' && entry.identifierKinds.length !== 0) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} story-only target cannot accept identifiers`);
    }
    if (entry.targetCardinality === 'exactly-one' && entry.identifierKinds.length === 0) {
      throw new AgentDispatchRegistryDefinitionError(`${entry.canonicalName} exactly-one target needs an identifier kind`);
    }
    for (const name of [entry.canonicalName, ...entry.aliases]) {
      if (names.has(name)) throw new AgentDispatchRegistryDefinitionError(`duplicate canonical name or alias "${name}"`);
      names.add(name);
    }
  }
}

validateAgentDispatchRegistry(AGENT_DISPATCH_REGISTRY);

export type AgentDispatchRegistryErrorCode =
  | 'blank_agent_type'
  | 'unknown_agent_type'
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

export const AGENT_DISPATCH_ACCEPTED_TYPES = Object.freeze([...byName.keys()].sort());

/** Resolve one explicit type or the deliberate omitted-type implementer default. */
export function resolveAgentDispatchType(agentType?: string): ResolvedAgentDispatchType {
  if (agentType === undefined) {
    const entry = byName.get('lattice-implementer')!;
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
      `agentType must be omitted for the lattice-implementer default or be one of: ${AGENT_DISPATCH_ACCEPTED_TYPES.join(', ')}`,
      AGENT_DISPATCH_ACCEPTED_TYPES,
    );
  }
  const entry = byName.get(agentType);
  if (!entry) {
    throw new AgentDispatchRegistryError(
      'unknown_agent_type',
      `unknown agentType "${agentType}"; accepted types: ${AGENT_DISPATCH_ACCEPTED_TYPES.join(', ')}`,
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
export function validateAgentDispatchRequest(args: AgentDispatchTargetInput & {
  agentType?: string;
  phase: StoryPhase;
}): ResolvedAgentDispatchType {
  const resolved = resolveAgentDispatchType(args.agentType);
  const { entry } = resolved;
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
  return byName.get(value) ?? null;
}

export function entryPermitsMutation(
  entry: AgentDispatchRegistryEntry,
  command: AgentDispatchMutationCommand,
): boolean {
  return entry.permittedMutations.includes(command);
}

export function assertRegisteredAgentMutationAllowed(
  actor: string | undefined | null,
  command: AgentDispatchMutationCommand,
): AgentDispatchRegistryEntry | null {
  const entry = resolveRegisteredAgentActor(actor);
  if (!entry) return null;
  if (!entryPermitsMutation(entry, command)) {
    throw new Error(
      `${command} refused: dispatched role "${actor!.trim()}" has no ${command} authority in the agent dispatch registry. [agent_dispatch_mutation_denied]`,
    );
  }
  return entry;
}
