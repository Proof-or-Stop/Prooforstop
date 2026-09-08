import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILENAMES, adapterManifestCandidates, stateDirCandidates, PROOF_OR_STOP_ADAPTER_DIR } from './brand-paths.js';

import {
  canonicalJsonStringify,
  domainSeparatedDigest,
  type RoleContract,
  type RoleLifecycleStatus,
  validateRoleContract,
  ROLE_CONTRACT_SCHEMA,
} from './prompt-contracts.js';
import {
  MODULAR_COMPLEX_ROLE_IDS,
  isModularReviewerRoleId,
  isModularRoleId,
  readPromptRegistry,
  readPromptTemplate,
  renderPromptEntryForHost,
  renderPromptForHost,
  resolvePromptTemplateBody,
  type PromptHost,
  type PromptRegistrySnapshot,
} from './prompt-registry.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { isCodexAdapterManifestOwner } from '../init-assets.js';

export { ACTIVE_MODULAR_REVIEWER_ROLE_IDS, isActiveModularReviewerRoleId } from './prompt-registry.js';

export const PROMPT_ROLE_CONTRACT_REGISTRY_VERSION = 'proof-or-stop.prompt-role-contract-registry.v1';
export const PROMPT_ROLE_CONTRACT_REGISTRY_VERSION_LEGACY = 'proofbound.prompt-role-contract-registry.v1';
export const PROMPT_ENVELOPE_ROLLOUT_VERSION = 'proof-or-stop.prompt-envelope-rollout.v1';
export const PROMPT_ENVELOPE_ROLLOUT_VERSION_LEGACY = 'proofbound.prompt-envelope-rollout.v1';
export type PromptEnvelopeRolloutMode = 'legacy-full-context' | 'full-envelope';
export const ACTIVE_MODULAR_COMPLEX_ROLE_IDS: readonly string[] = Object.freeze([...MODULAR_COMPLEX_ROLE_IDS]);

export interface ResolvedPromptRoleBody {
  roleId: string;
  mode: PromptEnvelopeRolloutMode;
  body: string;
  bodyDigest: string;
  legacyBytesRestored: boolean;
}

export interface ReviewerHostRenderIdentity {
  schemaVersion: 'proof-or-stop.reviewer-host-render-identity.v1' | 'proofbound.reviewer-host-render-identity.v1';
  roleId: string;
  rolloutMode: PromptEnvelopeRolloutMode;
  host: PromptHost;
  source: 'full-asset' | 'package-registry';
  packageTemplateDigest: string;
  selectedRoleBodyDigest: string;
  bootstrapDigest?: string;
  hostRenderDigest: string;
  identityDigest: string;
}

type ReviewerHostRenderSource = ReviewerHostRenderIdentity['source'];

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    throw new PromptRoleContractRegistryError(`${path} is not valid JSON`);
  }
}

function normalizeHostRenderSource(value: unknown): ReviewerHostRenderSource | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (['runtime-owned', 'global-thin', 'thin', 'registry', 'pinned-runtime'].includes(normalized)) {
    return 'package-registry';
  }
  if (['full-asset', 'full', 'legacy-mirror', 'local'].includes(normalized)) {
    return 'full-asset';
  }
  return null;
}

function globalHostRenderSource(projectRoot: string): ReviewerHostRenderSource | null {
  // B-cc10 CHK-004: probe every accepted state-dir x manifest-filename spelling
  // (canonical first) instead of two pinned literals, so this host-render-source
  // probe follows the rename. `.proof-or-stop` stays an explicit case variant.
  const probes = [
    ...MANIFEST_FILENAMES.flatMap(file => stateDirCandidates(file)),
    ...MANIFEST_FILENAMES.map(file => join('.proof-or-stop', file)),
  ].filter((value, index, all) => all.indexOf(value) === index);
  for (const relPath of probes) {
    const manifest = readJsonRecord(join(projectRoot, relPath));
    if (!manifest) continue;
    const source = normalizeHostRenderSource(
      manifest.agentAssetMode ?? manifest.assetMode ?? manifest.promptMode,
    );
    if (source) return source;
  }
  return null;
}

function reviewerHostRenderSource(
  projectRoot: string,
  host: PromptHost,
  file: string,
): ReviewerHostRenderSource {
  const globalSource = globalHostRenderSource(projectRoot);
  if (host === 'codex') {
    // B-cc10 CHK-004: read-both across the adapter dir x manifest filename cross
    // product, canonical first, so a half-migrated checkout still resolves.
    const codexManifest = adapterManifestCandidates()
      .map(rel => readJsonRecord(join(projectRoot, rel)))
      .find(Boolean) ?? null;
    const codexSource = normalizeHostRenderSource(
      codexManifest?.agentAssetMode ?? codexManifest?.assetMode ?? codexManifest?.promptMode,
    );
    if (codexSource === 'package-registry') return codexSource;
    if (globalSource === 'package-registry') return globalSource;
    if (codexSource === 'full-asset') return codexSource;
    if (
      isCodexAdapterManifestOwner(codexManifest?.adapterOwner)
      && codexManifest.adapterKind === 'codex'
      && codexManifest.promptMode === undefined
    ) {
      return 'full-asset';
    }
  } else if (globalSource) {
    return globalSource;
  }
  if (globalSource) return globalSource;
  // B-cc10 F-018: derive the adapter dir; this file already uses read-both
  // adapterManifestCandidates()/stateDirCandidates() above, so a hardcoded
  // deprecated spelling here made the fallback branch miss canonical-only projects.
  const relDir = host === 'claude' ? '.claude/agents' : `${PROOF_OR_STOP_ADAPTER_DIR}/agents`;
  return existsSync(join(projectRoot, relDir, file)) ? 'full-asset' : 'package-registry';
}

function assertExactHostAsset(path: string, expected: string, host: PromptHost): string {
  if (!existsSync(path)) throw new PromptRoleContractRegistryError(`missing ${host} reviewer prompt asset: ${path}`);
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) {
    throw new PromptRoleContractRegistryError(
      `${host} reviewer prompt asset drift: ${path} does not equal the canonical package render`,
    );
  }
  return actual;
}

/**
 * Proves that one host-visible role prompt is the exact deterministic render of
 * the package registry entry. Runtime-owned/thin hosts bind the package render
 * without requiring project assets. Explicit full-asset hosts bind only their
 * own materialized mirror, never another host's files.
 */
export function reviewerHostRenderIdentity(
  projectRoot: string,
  roleId: string,
  host: PromptHost = 'codex',
  rolloutMode: PromptEnvelopeRolloutMode = 'full-envelope',
): ReviewerHostRenderIdentity {
  const canonicalRoleId = canonicalAgentRoleId(roleId);
  const registry = readPromptRegistry();
  const entry = registry.agents.find(candidate => candidate.agentId === canonicalRoleId);
  if (!entry) throw new PromptRoleContractRegistryError(`unknown reviewer prompt role "${roleId}"`);
  if (!isPromptRoleEligibleForReviewEvidence(canonicalRoleId)) {
    throw new PromptRoleContractRegistryError(`role "${canonicalRoleId}" is not eligible for reviewer host rendering`);
  }
  const packageTemplate = resolvePromptTemplateBody(entry, rolloutMode);
  const source = reviewerHostRenderSource(projectRoot, host, entry.file);
  // B-cc10 F-018: derive the adapter dir; this file already uses read-both
  // adapterManifestCandidates()/stateDirCandidates() above, so a hardcoded
  // deprecated spelling here made the fallback branch miss canonical-only projects.
  const relDir = host === 'claude' ? '.claude/agents' : `${PROOF_OR_STOP_ADAPTER_DIR}/agents`;
  const bootstrap = renderPromptEntryForHost(entry, host);
  const bootstrapDigest = domainSeparatedDigest(`reviewer-${host}-bootstrap.raw-utf8.v1`, bootstrap);
  if (source === 'full-asset') {
    assertExactHostAsset(
      join(projectRoot, relDir, entry.file),
      bootstrap,
      host,
    );
  }
  const selectedRoleBody = renderPromptForHost(packageTemplate, host);
  const semantic = {
    schemaVersion: 'proof-or-stop.reviewer-host-render-identity.v1' as const,
    roleId: canonicalRoleId,
    rolloutMode,
    host,
    source,
    packageTemplateDigest: domainSeparatedDigest('reviewer-package-template.raw-utf8.v1', packageTemplate),
    selectedRoleBodyDigest: domainSeparatedDigest(`reviewer-${host}-selected-role-body.raw-utf8.v1`, selectedRoleBody),
    bootstrapDigest,
    hostRenderDigest: bootstrapDigest,
  };
  return {
    ...semantic,
    identityDigest: domainSeparatedDigest('reviewer-host-render-identity.v1', semantic),
  };
}

interface RolePolicy {
  status: RoleLifecycleStatus;
  replacementAgentType?: string;
  migrationHint?: string;
  defaultDispatch: boolean;
  responsibility: string;
  requiredInputIds: readonly string[];
  requiredCheckIds: readonly string[];
  allowedCommandIds: readonly string[];
  forbiddenActionIds: readonly string[];
  requiredOutputIds: readonly string[];
  stopConditionCodes: readonly string[];
}

const commonPolicy = {
  requiredInputIds: ['dispatch-target', 'project-runtime-guide'],
  requiredCheckIds: ['scope-and-authority-check'],
  forbiddenActionIds: ['fabricate-authority', 'write-outside-role-boundary'],
  stopConditionCodes: ['missing-required-input', 'authority-boundary'],
} as const;

export const REVIEW_FINDING_TRIAGE_CHECK_ID = 'defect-triage-and-routing-check' as const;

/**
 * Declarative prompt metadata for the five active modular REVIEW lanes only.
 * This declaration is not evidence that the check ran, is not lifecycle gate
 * evidence, and does not change Dynamic Finding schema, blocking, freshness,
 * supersession, severity, or applicability semantics.
 */
const reviewFindingTriageRequiredCheckIds = Object.freeze([
  ...commonPolicy.requiredCheckIds,
  REVIEW_FINDING_TRIAGE_CHECK_ID,
] as const);

const ACTIVE = 'active' as const;
const COMPATIBILITY = 'compatibility' as const;

const ROLE_POLICIES: Readonly<Record<string, RolePolicy>> = Object.freeze({
  'proof-or-stop-implementation-reviewer': {
    ...commonPolicy,
    status: COMPATIBILITY,
    replacementAgentType: 'proof-or-stop-review-quality',
    migrationHint: 'Use proof-or-stop-review-quality first and proof-or-stop-review-behavior for behavioral coverage; this compatibility prompt creates no REVIEW lane.',
    defaultDispatch: false,
    responsibility: 'Legacy combined implementation review.',
    allowedCommandIds: [],
    requiredOutputIds: ['migration-guidance'],
  },
  'proof-or-stop-evaluator': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Evaluate Proof-or-Stop outcomes from project evidence.',
    allowedCommandIds: [],
    requiredOutputIds: ['evaluation-report'],
  },
  'proof-or-stop-evaluator-cli': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Evaluate Proof-or-Stop outcomes through the CLI surface.',
    allowedCommandIds: [],
    requiredOutputIds: ['evaluation-report'],
  },
  'proof-or-stop-implementer': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Implement exactly one DEV checklist item or repair target.',
    allowedCommandIds: ['checklist_update', 'finding_resolve'],
    requiredOutputIds: ['implementation-commit', 'verification-evidence'],
  },
  'proof-or-stop-review-behavior': {
    ...commonPolicy,
    requiredCheckIds: reviewFindingTriageRequiredCheckIds,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review user-visible behavior and edge conditions.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set'],
    requiredOutputIds: ['review-finding-or-pass'],
  },
  'proof-or-stop-review-channel': {
    ...commonPolicy,
    status: 'retired',
    defaultDispatch: false,
    responsibility: 'Retired normal-channel dispatch coverage reviewer.',
    allowedCommandIds: [],
    requiredOutputIds: ['retirement-guidance'],
  },
  'proof-or-stop-review-concept': {
    ...commonPolicy,
    requiredCheckIds: reviewFindingTriageRequiredCheckIds,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review concept deletion and residual references.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set'],
    requiredOutputIds: ['review-finding-or-pass'],
  },
  'proof-or-stop-review-delivery': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review TEST delivery evidence against promised outcomes.',
    allowedCommandIds: ['delivery_check_set'],
    requiredOutputIds: ['delivery-check'],
  },
  'proof-or-stop-review-docs': {
    ...commonPolicy,
    requiredCheckIds: reviewFindingTriageRequiredCheckIds,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review documentation and code consistency.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set'],
    requiredOutputIds: ['review-finding-or-pass'],
  },
  'proof-or-stop-review-quality': {
    ...commonPolicy,
    requiredCheckIds: reviewFindingTriageRequiredCheckIds,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review implementation quality, safety, and maintainability.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set'],
    requiredOutputIds: ['review-finding-or-pass'],
  },
  'proof-or-stop-review-scope-plan': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review PLAN scope and checklist coverage.',
    allowedCommandIds: ['scope_check_save', 'topology_exclusion_approval_set'],
    requiredOutputIds: ['scope-check'],
  },
  'proof-or-stop-review-topology-critic': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Independently challenge acceptance topology, discovery, closure, and exclusions.',
    allowedCommandIds: ['topology_critic_receipt_set', 'topology_critic_receipt_check', 'review_run_start', 'finding_add', 'review_pass_set', 'review_inventory_critic_set'],
    requiredOutputIds: ['topology-critic-receipt', 'review-finding-or-pass'],
  },
  'proof-or-stop-review-story-init': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review INIT story facts and standalone readability.',
    allowedCommandIds: ['init_check_set'],
    requiredOutputIds: ['init-check'],
  },
  'proof-or-stop-review-test-coverage': {
    ...commonPolicy,
    requiredCheckIds: reviewFindingTriageRequiredCheckIds,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Review verification intent and evidence coverage.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set'],
    requiredOutputIds: ['review-finding-or-pass'],
  },
  'proof-or-stop-product-reviewer': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Independently review INIT product outcome completeness.',
    allowedCommandIds: ['init_check_set'],
    requiredOutputIds: ['init-check'],
  },
  'proof-or-stop-verification-intent': {
    ...commonPolicy,
    status: ACTIVE,
    defaultDispatch: true,
    responsibility: 'Author PLAN verificationIntent for one checklist item.',
    allowedCommandIds: ['checklist_update'],
    requiredOutputIds: ['verification-intent'],
  },
  'proof-or-stop-test-case-reviewer': {
    ...commonPolicy,
    status: COMPATIBILITY,
    replacementAgentType: 'proof-or-stop-review-test-coverage',
    migrationHint: 'Legacy read-side identity only; use proof-or-stop-review-test-coverage for current REVIEW coverage.',
    defaultDispatch: false,
    responsibility: 'Legacy verification-intent review alias.',
    allowedCommandIds: [],
    requiredOutputIds: ['migration-guidance'],
  },
  'proof-or-stop-test-intent': {
    ...commonPolicy,
    status: COMPATIBILITY,
    replacementAgentType: 'proof-or-stop-verification-intent',
    migrationHint: 'Legacy read-side identity only; use proof-or-stop-verification-intent during PLAN.',
    defaultDispatch: false,
    responsibility: 'Legacy verification-intent authoring alias.',
    allowedCommandIds: [],
    requiredOutputIds: ['migration-guidance'],
  },
});

export class PromptRoleContractRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRoleContractRegistryError';
  }
}

function roleSemanticValue(roleId: string, policy: RolePolicy): Record<string, unknown> {
  return {
    schemaVersion: ROLE_CONTRACT_SCHEMA,
    registryVersion: PROMPT_ROLE_CONTRACT_REGISTRY_VERSION,
    roleId,
    status: policy.status,
    replacementAgentType: policy.replacementAgentType ?? null,
    migrationHint: policy.migrationHint ?? null,
    defaultDispatch: policy.defaultDispatch,
    responsibility: policy.responsibility,
    requiredInputIds: policy.requiredInputIds,
    requiredCheckIds: policy.requiredCheckIds,
    allowedCommandIds: policy.allowedCommandIds,
    forbiddenActionIds: policy.forbiddenActionIds,
    requiredOutputIds: policy.requiredOutputIds,
    stopConditionCodes: policy.stopConditionCodes,
  };
}

export function buildPromptRoleContracts(snapshot: PromptRegistrySnapshot = readPromptRegistry()): RoleContract[] {
  const expectedIds = snapshot.agents.map(entry => entry.agentId);
  validatePromptRolePolicyDefinition(ROLE_POLICIES, expectedIds);
  const contracts = snapshot.agents.map(entry => {
    const policy = ROLE_POLICIES[entry.agentId]!;
    const contract: RoleContract = {
      schemaVersion: ROLE_CONTRACT_SCHEMA,
      roleId: entry.agentId,
      status: policy.status,
      ...(policy.replacementAgentType ? { replacementAgentType: policy.replacementAgentType } : {}),
      ...(policy.migrationHint ? { migrationHint: policy.migrationHint } : {}),
      defaultDispatch: policy.defaultDispatch,
      responsibility: policy.responsibility,
      requiredInputIds: [...policy.requiredInputIds],
      requiredCheckIds: [...policy.requiredCheckIds],
      allowedCommandIds: [...policy.allowedCommandIds],
      forbiddenActionIds: [...policy.forbiddenActionIds],
      requiredOutputIds: [...policy.requiredOutputIds],
      stopConditionCodes: [...policy.stopConditionCodes],
      semanticDigest: domainSeparatedDigest('role-contract.semantic.v1', roleSemanticValue(entry.agentId, policy)),
      renderDigest: domainSeparatedDigest(
        'role-contract.render.v1',
        isModularReviewerRoleId(entry.agentId)
          ? resolvePromptTemplateBody(entry, 'full-envelope')
          : readPromptTemplate(entry),
      ),
    };
    validateRoleContract(contract);
    return contract;
  });
  validatePromptRoleContracts(contracts, expectedIds);
  return contracts;
}

export function validatePromptRolePolicyDefinition(
  policies: Readonly<Record<string, unknown>>,
  expectedRoleIds: readonly string[],
): void {
  const actual = Object.keys(policies);
  const duplicateExpected = expectedRoleIds.find((id, index) => expectedRoleIds.indexOf(id) !== index);
  if (duplicateExpected) throw new PromptRoleContractRegistryError(`prompt registry contains duplicate role "${duplicateExpected}"`);
  const expected = new Set(expectedRoleIds);
  for (const roleId of actual) {
    if (!expected.has(roleId)) throw new PromptRoleContractRegistryError(`unknown prompt role policy "${roleId}"`);
  }
  for (const roleId of expectedRoleIds) {
    if (!Object.prototype.hasOwnProperty.call(policies, roleId)) throw new PromptRoleContractRegistryError(`missing prompt role policy "${roleId}"`);
  }
  if (actual.length !== expectedRoleIds.length) throw new PromptRoleContractRegistryError('prompt role policy registry is not total');
}

export function validatePromptRoleContracts(contracts: readonly unknown[], expectedRoleIds: readonly string[]): void {
  const ids: string[] = [];
  for (const contract of contracts) {
    try {
      validateRoleContract(contract);
    } catch (error) {
      throw new PromptRoleContractRegistryError(error instanceof Error ? error.message : String(error));
    }
    ids.push(contract.roleId);
  }
  if (new Set(ids).size !== ids.length) throw new PromptRoleContractRegistryError('prompt role contract registry contains duplicate role IDs');
  const actualSorted = [...ids].sort();
  const expectedSorted = [...expectedRoleIds].sort();
  if (canonicalJsonStringify(actualSorted) !== canonicalJsonStringify(expectedSorted)) {
    throw new PromptRoleContractRegistryError('prompt role contract registry membership differs from package prompt registry');
  }
  const active = contracts.filter(contract => (contract as RoleContract).status === 'active').length;
  const compatibility = contracts.filter(contract => (contract as RoleContract).status === 'compatibility').length;
  const retired = contracts.filter(contract => (contract as RoleContract).status === 'retired').length;
  if (active !== 14 || compatibility !== 3 || retired !== 1) {
    throw new PromptRoleContractRegistryError(`invalid role partition active=${active} compatibility=${compatibility} retired=${retired}`);
  }
  const byId = new Map(contracts.map(contract => [(contract as RoleContract).roleId, contract as RoleContract]));
  for (const roleId of expectedRoleIds) {
    const row = byId.get(roleId)!;
    const policy = ROLE_POLICIES[roleId];
    if (!policy) throw new PromptRoleContractRegistryError(`missing frozen role policy "${roleId}"`);
    const expectedFields: Record<string, unknown> = {
      status: policy.status,
      replacementAgentType: policy.replacementAgentType,
      migrationHint: policy.migrationHint,
      defaultDispatch: policy.defaultDispatch,
      responsibility: policy.responsibility,
      requiredInputIds: policy.requiredInputIds,
      requiredCheckIds: policy.requiredCheckIds,
      allowedCommandIds: policy.allowedCommandIds,
      forbiddenActionIds: policy.forbiddenActionIds,
      requiredOutputIds: policy.requiredOutputIds,
      stopConditionCodes: policy.stopConditionCodes,
    };
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (canonicalJsonStringify(row[field as keyof RoleContract] ?? null) !== canonicalJsonStringify(expected ?? null)) {
        throw new PromptRoleContractRegistryError(
          `${roleId}.${field} differs from the frozen role policy`,
        );
      }
    }
    const expectedSemanticDigest = domainSeparatedDigest(
      'role-contract.semantic.v1',
      roleSemanticValue(roleId, policy),
    );
    if (row.semanticDigest !== expectedSemanticDigest) {
      throw new PromptRoleContractRegistryError(
        `${roleId}.semanticDigest does not match the frozen role policy`,
      );
    }
  }
  if (byId.get('proof-or-stop-review-channel')?.status !== 'retired' || byId.get('proof-or-stop-review-channel')?.defaultDispatch !== false) {
    throw new PromptRoleContractRegistryError('proof-or-stop-review-channel must be retired and non-default');
  }
  if (byId.get('proof-or-stop-product-reviewer')?.status !== 'active') throw new PromptRoleContractRegistryError('proof-or-stop-product-reviewer must remain active');
  for (const roleId of ['proof-or-stop-implementation-reviewer', 'proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer']) {
    const row = byId.get(roleId);
    if (row?.status !== 'compatibility' || row.defaultDispatch !== false) {
      throw new PromptRoleContractRegistryError(`${roleId} must be compatibility and non-default`);
    }
  }
}

export function promptRoleContractRegistryDigest(contracts: readonly RoleContract[]): string {
  return domainSeparatedDigest('prompt-role-contract-registry.v1', contracts);
}

function deepFreezeRoleContract(contract: RoleContract): Readonly<RoleContract> {
  Object.freeze(contract.requiredInputIds);
  Object.freeze(contract.requiredCheckIds);
  Object.freeze(contract.allowedCommandIds);
  Object.freeze(contract.forbiddenActionIds);
  Object.freeze(contract.requiredOutputIds);
  Object.freeze(contract.stopConditionCodes);
  return Object.freeze(contract);
}

export const PROMPT_ROLE_CONTRACTS = Object.freeze(
  buildPromptRoleContracts().map(deepFreezeRoleContract),
);

const PROMPT_ROLE_CONTRACT_BY_ID = new Map(PROMPT_ROLE_CONTRACTS.map(contract => [contract.roleId, contract]));

export type PromptRoleResponsibility = 'inventory-completeness';

const INVENTORY_CRITIC_CONTRACT = (() => {
  const roleId = 'proof-or-stop-review-topology-critic';
  const base = PROMPT_ROLE_CONTRACT_BY_ID.get(roleId)!;
  const policy: RolePolicy = {
    ...ROLE_POLICIES[roleId]!,
    responsibility: 'Independently verify current review inventory completeness and finding dispositions.',
    allowedCommandIds: ['review_run_start', 'finding_add', 'review_pass_set', 'review_inventory_critic_set'],
    requiredOutputIds: ['review-finding-or-pass', 'review-inventory-critic-receipt'],
  };
  const contract: RoleContract = {
    ...base,
    responsibility: policy.responsibility,
    allowedCommandIds: [...policy.allowedCommandIds],
    requiredOutputIds: [...policy.requiredOutputIds],
    semanticDigest: domainSeparatedDigest('role-contract.semantic.v1', roleSemanticValue(roleId, policy)),
  };
  validateRoleContract(contract);
  return deepFreezeRoleContract(contract);
})();

export function promptRoleContract(roleId: string, responsibility?: PromptRoleResponsibility): Readonly<RoleContract> {
  const canonicalRoleId = canonicalAgentRoleId(roleId);
  const contract = PROMPT_ROLE_CONTRACT_BY_ID.get(canonicalRoleId);
  if (!contract) throw new PromptRoleContractRegistryError(`unknown prompt role "${roleId}"`);
  if (responsibility === 'inventory-completeness') {
    if (canonicalRoleId !== INVENTORY_CRITIC_CONTRACT.roleId) {
      throw new PromptRoleContractRegistryError(`inventory completeness is unsupported for ${canonicalRoleId}`);
    }
    return INVENTORY_CRITIC_CONTRACT;
  }
  return contract;
}

/** Reconstruct only registered semantics after the envelope and signed run have authenticated them. */
export function promptRoleContractForSemanticDigest(roleId: string, semanticDigest: string): Readonly<RoleContract> {
  const base = promptRoleContract(roleId);
  if (base.semanticDigest === semanticDigest) return base;
  if (base.roleId === INVENTORY_CRITIC_CONTRACT.roleId && INVENTORY_CRITIC_CONTRACT.semanticDigest === semanticDigest) {
    return INVENTORY_CRITIC_CONTRACT;
  }
  throw new PromptRoleContractRegistryError(`unregistered Role Contract semantics for ${base.roleId}`);
}

/** Gate evidence is owned only by active canonical REVIEW lanes, never compatibility/retired prompts. */
export function isPromptRoleEligibleForReviewEvidence(roleId: string | undefined | null): boolean {
  if (!roleId) return false;
  const contract = PROMPT_ROLE_CONTRACT_BY_ID.get(canonicalAgentRoleId(roleId));
  return contract?.status === 'active'
    && contract.allowedCommandIds.includes('review_run_start')
    && contract.allowedCommandIds.includes('review_pass_set');
}

export function resolvePromptEnvelopeRolloutMode(
  roleId: string,
  config: unknown,
): PromptEnvelopeRolloutMode {
  const canonicalRoleId = canonicalAgentRoleId(roleId);
  const contract = promptRoleContract(canonicalRoleId);
  if (config === undefined || config === null) return 'legacy-full-context';
  if (typeof config !== 'object' || Array.isArray(config) || Object.getPrototypeOf(config) !== Object.prototype) {
    throw new PromptRoleContractRegistryError('promptEnvelope config must be a plain object');
  }
  const record = config as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['version', 'roles'].includes(key)) throw new PromptRoleContractRegistryError(`promptEnvelope.${key} is unknown`);
  }
  if (record.version !== PROMPT_ENVELOPE_ROLLOUT_VERSION
    && record.version !== PROMPT_ENVELOPE_ROLLOUT_VERSION_LEGACY) {
    throw new PromptRoleContractRegistryError(`promptEnvelope.version must be ${PROMPT_ENVELOPE_ROLLOUT_VERSION}`);
  }
  if (!record.roles || typeof record.roles !== 'object' || Array.isArray(record.roles) || Object.getPrototypeOf(record.roles) !== Object.prototype) {
    throw new PromptRoleContractRegistryError('promptEnvelope.roles must be a plain object');
  }
  const roles = record.roles as Record<string, unknown>;
  const logicalRoles = new Map<string, { key: string; mode: unknown }>();
  for (const key of Object.keys(roles)) {
    const canonicalKey = canonicalAgentRoleId(key);
    if (!PROMPT_ROLE_CONTRACT_BY_ID.has(canonicalKey)) throw new PromptRoleContractRegistryError(`promptEnvelope.roles contains unknown role "${key}"`);
    const previous = logicalRoles.get(canonicalKey);
    if (previous) {
      throw new PromptRoleContractRegistryError(
        `promptEnvelope.roles contains duplicate logical role "${canonicalKey}" via keys "${previous.key}" and "${key}"`,
      );
    }
    logicalRoles.set(canonicalKey, { key, mode: roles[key] });
    if (!['legacy-full-context', 'full-envelope'].includes(roles[key] as string)) {
      throw new PromptRoleContractRegistryError(`promptEnvelope.roles.${key} has unsupported mode`);
    }
    if (roles[key] === 'full-envelope' && promptRoleContract(canonicalKey).status !== 'active') {
      throw new PromptRoleContractRegistryError(`${key} is ${promptRoleContract(canonicalKey).status} and cannot enable full-envelope`);
    }
    if (!isModularReviewerRoleId(canonicalKey) && !MODULAR_COMPLEX_ROLE_IDS.includes(canonicalKey as typeof MODULAR_COMPLEX_ROLE_IDS[number])) {
      throw new PromptRoleContractRegistryError(`promptEnvelope.roles.${key} is outside the approved modular rollout`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(roles, '__proto__') || Object.prototype.hasOwnProperty.call(roles, 'constructor')) {
    throw new PromptRoleContractRegistryError('promptEnvelope.roles contains a forbidden prototype key');
  }
  const configured = logicalRoles.get(contract.roleId)?.mode;
  return configured === undefined ? 'legacy-full-context' : configured as PromptEnvelopeRolloutMode;
}

export function resolvePromptRoleBody(
  roleId: string,
  config: unknown,
  snapshot: PromptRegistrySnapshot = readPromptRegistry(),
): ResolvedPromptRoleBody {
  const canonicalRoleId = canonicalAgentRoleId(roleId);
  const mode = resolvePromptEnvelopeRolloutMode(canonicalRoleId, config);
  const entry = snapshot.agents.find(candidate => candidate.agentId === canonicalRoleId);
  if (!entry) throw new PromptRoleContractRegistryError(`unknown prompt role "${roleId}"`);
  const body = resolvePromptTemplateBody(entry, mode);
  return Object.freeze({
    roleId: canonicalRoleId,
    mode,
    body,
    bodyDigest: domainSeparatedDigest(`reviewer-role-body.${mode}.raw-utf8.v1`, body),
    legacyBytesRestored: mode === 'legacy-full-context' && isModularRoleId(roleId),
  });
}
