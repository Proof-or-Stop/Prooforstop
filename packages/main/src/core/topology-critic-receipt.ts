import { createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  ProcessEvent,
  TopologyActorProvenanceV1,
  TopologyCriticReceiptV1,
  TopologyExclusionApprovalV1,
  TopologyImplementationProvenanceV1,
} from './types.js';
import type { SessionSource } from './owner-session.js';
import { exportPublicKeyRaw, importPrivateKeyRaw, signCanonical, verifyCanonical } from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import { agentRoleIdsEqual } from './agent-role-identity.js';

export const TOPOLOGY_CRITIC_ROLE = 'proof-or-stop-review-topology-critic' as const;
export const TOPOLOGY_EXCLUSION_APPROVER_ROLE = 'proof-or-stop-review-scope-plan' as const;
const IMPLEMENTER_ROLE = 'proof-or-stop-implementer' as const;
const IMPLEMENTER_AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>';
const LEGACY_IMPLEMENTER_AUTHOR = 'lattice-implementer <lattice-implementer@noreply.local>';

function canonicalBusinessAuthorIdentity(identity: string): string {
  return identity.trim() === LEGACY_IMPLEMENTER_AUTHOR ? IMPLEMENTER_AUTHOR : identity.trim();
}

type ReceiptContext = {
  storyId: string;
  basisStatus: 'complete' | 'partial' | 'unsupported';
  basisDigest: string;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  storyFilesHash: string;
  closureFilesHash: string;
  exclusions: Array<{ pathRef: string; decisionRef: string }>;
  findingRefs: string[];
};

export interface TopologyCriticVerification {
  ok: boolean;
  code: string;
  diagnostics: string[];
  independence: { agent: boolean; session: boolean; dispatch: boolean; businessCommitAuthor: boolean };
}

function digest(value: unknown): string { return `sha256:${digestCanonicalJson(value)}`; }

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, encoding: 'utf8' }).trim();
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}

function keyPath(gitCwd: string, role: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE): string {
  return join(gitCommonDir(gitCwd), `proofstory-${role}-v1.key`);
}

function readOrCreatePrivateKey(gitCwd: string, role: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE): string {
  const path = keyPath(gitCwd, role);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return readFileSync(path, 'utf8').trim();
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function registeredPublicKey(gitCwd: string, role: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE): string | null {
  const path = keyPath(gitCwd, role);
  if (!existsSync(path)) return null;
  try { return publicKeyForPrivate(readFileSync(path, 'utf8').trim()); } catch { return null; }
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8' }).trim();
}

function normalizeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map(value => value.trim()).filter(Boolean))].sort();
}

function isCanonicalRefs(refs: unknown): refs is string[] {
  return Array.isArray(refs) && refs.every(value => typeof value === 'string')
    && JSON.stringify(refs) === JSON.stringify(normalizeRefs(refs));
}

function isValidIssuedAt(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function dispatchIdentity(event: ProcessEvent): string {
  return String(event.promptEnvelopeId || event.dispatchBindingDigest || digest(event));
}

function isAncestor(gitCwd: string, ancestor: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, 'HEAD'], { cwd: gitCwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function currentGitAuthorIdentity(gitCwd: string): string {
  const raw = git(gitCwd, ['var', 'GIT_AUTHOR_IDENT']);
  const match = /^(.*<[^>]+>)\s+\d+\s+[+-]\d+$/.exec(raw);
  if (!match?.[1]?.trim()) throw new Error('current git business author identity is unavailable');
  return match[1].trim();
}

export function currentImplementationBusinessCommit(gitCwd: string): { businessCommit: string; businessCommitAuthor: string } {
  let rows = '';
  try { rows = git(gitCwd, ['log', 'main..HEAD', '--format=%H%x09%an <%ae>']); } catch { /* no local main */ }
  if (!rows) rows = git(gitCwd, ['log', '-n', '50', '--format=%H%x09%an <%ae>']);
  const line = rows.split('\n').find(row => row.endsWith(`\t${IMPLEMENTER_AUTHOR}`))
    ?? rows.split('\n').find(row => row.endsWith(`\t${LEGACY_IMPLEMENTER_AUTHOR}`));
  if (!line) throw new Error(`implementation provenance is missing a business commit authored by ${IMPLEMENTER_AUTHOR}`);
  const [businessCommit, businessCommitAuthor] = line.split('\t');
  return { businessCommit, businessCommitAuthor: canonicalBusinessAuthorIdentity(businessCommitAuthor) };
}

export function topologyDispatchBusinessAuthor(gitCwd: string): string {
  return canonicalBusinessAuthorIdentity(currentGitAuthorIdentity(gitCwd));
}

export function deriveImplementationProvenance(gitCwd: string, events: readonly ProcessEvent[], context: ReceiptContext): TopologyImplementationProvenanceV1 {
  const { businessCommit, businessCommitAuthor } = currentImplementationBusinessCommit(gitCwd);
  const event = [...events].reverse().find(candidate => candidate.type === 'dispatch'
    && agentRoleIdsEqual(typeof candidate.agentType === 'string' ? candidate.agentType : undefined, IMPLEMENTER_ROLE));
  if (!event || typeof event.sessionId !== 'string' || !event.sessionId.trim()) {
    throw new Error('implementation provenance is missing a session-bound proof-or-stop-implementer dispatch');
  }
  return {
    agentId: IMPLEMENTER_ROLE,
    sessionId: event.sessionId,
    dispatchId: dispatchIdentity(event),
    storyId: context.storyId,
    headHash: businessCommit,
    storyFilesHash: context.storyFilesHash,
    businessIdentity: businessCommitAuthor,
    businessCommit,
    businessCommitAuthor: canonicalBusinessAuthorIdentity(businessCommitAuthor),
    businessCommitAuthorSource: 'git-log:commit-author',
  };
}

/**
 * Session sources a signing role may hold.
 *
 * `host-adapter` and `generated-token` both clear the same provider + task + agent gate in
 * `resolveAdapterOwnerSession`, and both derive their id by hash rather than by assignment, so an
 * implementer cannot pick the value a reviewer will sign under; `generated-token` additionally
 * demands a boundary token. `explicit-env` is whatever the caller wrote into the session id env
 * var, and `derived-ppid` is a hash of the process tree — both are mintable by the party under
 * review, so neither can carry an independent signature.
 */
const SIGNABLE_SESSION_SOURCES: ReadonlySet<SessionSource> = new Set<SessionSource>(['host-adapter', 'generated-token']);

export function deriveRoleProvenance(args: {
  gitCwd: string;
  events: readonly ProcessEvent[];
  expectedRole: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE;
  actor: string | undefined;
  sessionId: string;
  sessionSource: SessionSource;
  context: ReceiptContext;
  implementation: TopologyImplementationProvenanceV1;
}): TopologyActorProvenanceV1 {
  if (!args.actor || !agentRoleIdsEqual(args.actor, args.expectedRole)) throw new Error(`role eligibility failed: expected ${args.expectedRole}, received ${args.actor || '<missing>'}`);
  if (!args.sessionId.trim()) throw new Error('role eligibility failed: session identity is missing');
  if (!SIGNABLE_SESSION_SOURCES.has(args.sessionSource)) {
    throw new Error(`role eligibility failed: ${args.expectedRole} must sign from a host-adapter session, received "${args.sessionSource}"`);
  }
  const event = [...args.events].reverse().find(candidate =>
    candidate.type === 'dispatch'
    && agentRoleIdsEqual(typeof candidate.agentType === 'string' ? candidate.agentType : undefined, args.expectedRole)
    && candidate.sessionId === args.sessionId
    && candidate.storyId === args.context.storyId
    && candidate.businessCommit === args.implementation.businessCommit
    && candidate.storyFilesHash === args.context.storyFilesHash,
  );
  if (!event) {
    const candidates = args.events
      .filter(candidate => candidate.type === 'dispatch' && candidate.agentType === args.expectedRole && candidate.storyId === args.context.storyId)
      .slice(-3)
      .map(candidate => `session=${candidate.sessionId ?? '<missing>'},businessCommit=${candidate.businessCommit ?? '<missing>'},storyFilesHash=${candidate.storyFilesHash ?? '<missing>'}`)
      .join(' | ') || 'none';
    throw new Error(
      `no current registered dispatch provenance for ${args.expectedRole} in session ${args.sessionId}; ` +
      `expected businessCommit=${args.implementation.businessCommit}, storyFilesHash=${args.context.storyFilesHash}; candidates=${candidates}`,
    );
  }
  const headHash = typeof event.headHash === 'string' ? event.headHash : '';
  const businessCommit = typeof event.businessCommit === 'string' ? event.businessCommit : '';
  const businessCommitAuthor = typeof event.businessCommitAuthor === 'string' ? event.businessCommitAuthor.trim() : '';
  if (!headHash || !businessCommit || !businessCommitAuthor
    || event.businessCommitAuthorSource !== 'git-var:GIT_AUTHOR_IDENT'
    || !isAncestor(args.gitCwd, headHash)) {
    throw new Error(`dispatch provenance for ${args.expectedRole} is missing or unverifiable`);
  }
  return {
    agentId: args.expectedRole,
    sessionId: args.sessionId,
    dispatchId: dispatchIdentity(event),
    storyId: args.context.storyId,
    headHash,
    storyFilesHash: args.context.storyFilesHash,
    businessCommit,
    businessCommitAuthor,
    businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT',
    businessIdentity: businessCommitAuthor,
  };
}

export function independenceMatrix(actor: TopologyActorProvenanceV1, implementation: TopologyImplementationProvenanceV1) {
  return {
    agent: actor.agentId !== implementation.agentId,
    session: actor.sessionId !== implementation.sessionId,
    dispatch: actor.dispatchId !== implementation.dispatchId,
    businessCommitAuthor: canonicalBusinessAuthorIdentity(actor.businessCommitAuthor)
      !== canonicalBusinessAuthorIdentity(implementation.businessCommitAuthor),
  };
}

function verifierIndependenceMatrix(actor: unknown, implementation: TopologyImplementationProvenanceV1) {
  const value = actor && typeof actor === 'object' && !Array.isArray(actor) ? actor as Record<string, unknown> : {};
  return {
    agent: typeof value.agentId === 'string' && value.agentId.trim().length > 0 && value.agentId !== implementation.agentId,
    session: typeof value.sessionId === 'string' && value.sessionId.trim().length > 0 && value.sessionId !== implementation.sessionId,
    dispatch: typeof value.dispatchId === 'string' && value.dispatchId.trim().length > 0 && value.dispatchId !== implementation.dispatchId,
    businessCommitAuthor: typeof value.businessCommitAuthor === 'string' && value.businessCommitAuthor.trim().length > 0
      && canonicalBusinessAuthorIdentity(value.businessCommitAuthor) !== canonicalBusinessAuthorIdentity(implementation.businessCommitAuthor),
  };
}

function hasActorProvenance(value: unknown): value is TopologyActorProvenanceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return ['agentId', 'sessionId', 'dispatchId', 'storyId', 'headHash', 'storyFilesHash', 'businessCommit', 'businessCommitAuthor', 'businessIdentity']
    .every(field => typeof actor[field] === 'string' && Boolean((actor[field] as string).trim()))
    && (actor.businessCommitAuthorSource === 'git-var:GIT_AUTHOR_IDENT' || actor.businessCommitAuthorSource === 'git-log:commit-author');
}

const PROVENANCE_DIMENSIONS = [
  ['agent', 'agentId'],
  ['session', 'sessionId'],
  ['dispatch', 'dispatchId'],
  ['businessCommitAuthor', 'businessCommitAuthor'],
] as const;

const ACTOR_PROVENANCE_FIELDS = [
  ['agentId', 'agent'],
  ['sessionId', 'session'],
  ['dispatchId', 'dispatch'],
  ['storyId', 'storyId'],
  ['headHash', 'headHash'],
  ['storyFilesHash', 'storyFilesHash'],
  ['businessCommit', 'businessCommit'],
  ['businessCommitAuthor', 'businessCommitAuthor'],
  ['businessCommitAuthorSource', 'businessCommitAuthorSource'],
  ['businessIdentity', 'businessIdentity'],
] as const;

function actorDispatchDiagnostics(args: {
  gitCwd: string;
  events: readonly ProcessEvent[];
  actor: unknown;
  expectedRole: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE;
  context: ReceiptContext;
  implementation: TopologyImplementationProvenanceV1;
  label: string;
}): string[] {
  const actor = args.actor && typeof args.actor === 'object' && !Array.isArray(args.actor)
    ? args.actor as Record<string, unknown>
    : {};
  const diagnostics: string[] = [];
  for (const [field, diagnosticName] of ACTOR_PROVENANCE_FIELDS) {
    if (typeof actor[field] !== 'string' || !(actor[field] as string).trim()) {
      diagnostics.push(`${args.label} provenance missing or unverifiable: ${diagnosticName}`);
    }
  }
  if (!Array.isArray(args.events) || args.events.length === 0) {
    for (const [, diagnosticName] of ACTOR_PROVENANCE_FIELDS) {
      const message = `${args.label} provenance missing or unverifiable: ${diagnosticName}`;
      if (!diagnostics.includes(message)) diagnostics.push(message);
    }
    return diagnostics;
  }
  const candidates = args.events.filter(event => event.type === 'dispatch'
    && agentRoleIdsEqual(typeof event.agentType === 'string' ? event.agentType : undefined, args.expectedRole)
    && event.storyId === args.context.storyId
    && event.businessCommit === args.implementation.businessCommit
    && event.storyFilesHash === args.context.storyFilesHash
    && event.businessCommitAuthorSource === 'git-var:GIT_AUTHOR_IDENT'
    && typeof event.sessionId === 'string'
    && Boolean(event.sessionId)
    && typeof event.businessCommitAuthor === 'string'
    && Boolean(event.businessCommitAuthor)
    && typeof event.headHash === 'string'
    && Boolean(event.headHash)
    && isAncestor(args.gitCwd, event.headHash));
  const expectedForEvent = (event: ProcessEvent): Record<(typeof ACTOR_PROVENANCE_FIELDS)[number][0], string | undefined> => ({
    agentId: args.expectedRole,
    sessionId: String(event.sessionId),
    dispatchId: dispatchIdentity(event),
    storyId: args.context.storyId,
    headHash: String(event.headHash),
    storyFilesHash: args.context.storyFilesHash,
    businessCommit: args.implementation.businessCommit,
    businessCommitAuthor: String(event.businessCommitAuthor),
    businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT',
    businessIdentity: String(event.businessCommitAuthor),
  });
  const ranked = candidates.map(event => {
    const expected = expectedForEvent(event);
    const mismatches = ACTOR_PROVENANCE_FIELDS.filter(([field]) => actor[field] !== expected[field]);
    return { expected, mismatches };
  }).sort((a, b) => a.mismatches.length - b.mismatches.length);
  if (ranked.length === 0) {
    diagnostics.push(`${args.label} provenance is missing or unverifiable against a current registered dispatch`);
    return diagnostics;
  }
  for (const [field, diagnosticName] of ranked[0].mismatches) {
    const message = `${args.label} provenance missing or unverifiable: ${diagnosticName}`;
    if (!diagnostics.includes(message)) diagnostics.push(message);
  }
  return diagnostics;
}

function implementationProvenanceDiagnostics(value: unknown, expected: TopologyImplementationProvenanceV1): string[] {
  const actual = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return PROVENANCE_DIMENSIONS.flatMap(([dimension, field]) => (
    typeof actual[field] !== 'string' || !(actual[field] as string).trim() || actual[field] !== expected[field]
      ? [`implementation provenance missing or unverifiable: ${dimension}`]
      : []
  ));
}

function requireIndependent(actor: TopologyActorProvenanceV1, implementation: TopologyImplementationProvenanceV1): void {
  const matrix = independenceMatrix(actor, implementation);
  const failed = Object.entries(matrix).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`role independence failed: ${failed.join(', ')}`);
}

function unsignedApproval(value: TopologyExclusionApprovalV1): Omit<TopologyExclusionApprovalV1, 'signature'> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function unsignedReceipt(value: TopologyCriticReceiptV1): Omit<TopologyCriticReceiptV1, 'signature'> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

export function issueTopologyExclusionApproval(args: {
  gitCwd: string;
  context: ReceiptContext;
  exclusionRef: string;
  actor: TopologyActorProvenanceV1;
  implementation: TopologyImplementationProvenanceV1;
  issuedAt?: string;
}): TopologyExclusionApprovalV1 {
  requireIndependent(args.actor, args.implementation);
  const matching = args.context.exclusions.filter(item => item.decisionRef === args.exclusionRef);
  if (matching.length !== 1) throw new Error(`exclusion approval requires exactly one current exclusion ${args.exclusionRef}`);
  const privateKey = readOrCreatePrivateKey(args.gitCwd, TOPOLOGY_EXCLUSION_APPROVER_ROLE);
  const unsigned: Omit<TopologyExclusionApprovalV1, 'signature'> = {
    schemaVersion: 'proofstory.topology_exclusion_approval.v1',
    approvalRef: `TEA-${digest({ storyId: args.context.storyId, exclusionRef: args.exclusionRef }).slice(7, 19)}`,
    storyId: args.context.storyId,
    exclusionRef: args.exclusionRef,
    scopeRef: matching[0].pathRef,
    approverIdentity: args.actor.agentId,
    approverRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE,
    approverProvenance: args.actor,
    implementationProvenance: args.implementation,
    basisDigest: args.context.basisDigest,
    topologyDigest: args.context.topologyDigest,
    scopeCheckDigest: args.context.scopeCheckDigest,
    ...(args.context.scopeContractDigest ? { scopeContractDigest: args.context.scopeContractDigest } : {}),
    storyFilesHash: args.context.storyFilesHash,
    closureFilesHash: args.context.closureFilesHash,
    issuedAt: args.issuedAt ?? new Date().toISOString(),
    signerPublicKey: publicKeyForPrivate(privateKey),
  };
  return { ...unsigned, signature: signCanonical(unsigned, privateKey) };
}

export function verifyTopologyExclusionApproval(args: {
  gitCwd: string;
  context: ReceiptContext;
  approval: TopologyExclusionApprovalV1;
  implementation: TopologyImplementationProvenanceV1;
  critic?: TopologyActorProvenanceV1;
  events: readonly ProcessEvent[];
}): string[] {
  const { approval, context } = args;
  const diagnostics: string[] = [];
  const trusted = registeredPublicKey(args.gitCwd, TOPOLOGY_EXCLUSION_APPROVER_ROLE);
  if (!trusted || approval.signerPublicKey !== trusted || !verifyCanonical(unsignedApproval(approval), approval.signature, trusted)) diagnostics.push('exclusion approval signature is invalid');
  const expectedApprovalRef = `TEA-${digest({ storyId: context.storyId, exclusionRef: approval.exclusionRef }).slice(7, 19)}`;
  if (approval.schemaVersion !== 'proofstory.topology_exclusion_approval.v1' || approval.storyId !== context.storyId
    || !agentRoleIdsEqual(approval.approverRole, TOPOLOGY_EXCLUSION_APPROVER_ROLE) || !agentRoleIdsEqual(approval.approverIdentity, TOPOLOGY_EXCLUSION_APPROVER_ROLE)
    || !hasActorProvenance(approval.approverProvenance) || !agentRoleIdsEqual(approval.approverProvenance.agentId, TOPOLOGY_EXCLUSION_APPROVER_ROLE)
    || approval.approverProvenance.businessCommitAuthorSource !== 'git-var:GIT_AUTHOR_IDENT'
    || approval.approvalRef !== expectedApprovalRef || !isValidIssuedAt(approval.issuedAt)) diagnostics.push('exclusion approval role/story binding mismatch');
  diagnostics.push(...actorDispatchDiagnostics({
    gitCwd: args.gitCwd,
    events: args.events,
    actor: approval.approverProvenance,
    expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE,
    context,
    implementation: args.implementation,
    label: 'exclusion approver',
  }));
  if (JSON.stringify(approval.implementationProvenance) !== JSON.stringify(args.implementation)) diagnostics.push('exclusion implementation provenance mismatch');
  const expected = context.exclusions.filter(item => item.decisionRef === approval.exclusionRef && item.pathRef === approval.scopeRef);
  if (expected.length !== 1) diagnostics.push('exclusion approval is missing, orphaned, duplicated, or cross-story');
  if (approval.basisDigest !== context.basisDigest || approval.topologyDigest !== context.topologyDigest
    || approval.scopeCheckDigest !== context.scopeCheckDigest || approval.scopeContractDigest !== context.scopeContractDigest
    || approval.storyFilesHash !== context.storyFilesHash || approval.closureFilesHash !== context.closureFilesHash) diagnostics.push('exclusion approval freshness binding mismatch');
  const independence = verifierIndependenceMatrix(approval.approverProvenance, args.implementation);
  if (Object.values(independence).some(value => !value)) diagnostics.push(`exclusion approver is not independent: ${Object.entries(independence).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`);
  if (args.critic && hasActorProvenance(approval.approverProvenance) && (approval.approverProvenance.agentId === args.critic.agentId
    || approval.approverProvenance.sessionId === args.critic.sessionId
    || approval.approverProvenance.dispatchId === args.critic.dispatchId
    || approval.approverProvenance.businessCommitAuthor === args.critic.businessCommitAuthor)) diagnostics.push('exclusion approver is not independent from topology critic');
  return diagnostics;
}

export function issueTopologyCriticReceipt(args: {
  gitCwd: string;
  context: ReceiptContext;
  critic: TopologyActorProvenanceV1;
  implementation: TopologyImplementationProvenanceV1;
  approvals: TopologyExclusionApprovalV1[];
  events: readonly ProcessEvent[];
  verdict: 'pass' | 'request_changes';
  issuedAt?: string;
}): TopologyCriticReceiptV1 {
  requireIndependent(args.critic, args.implementation);
  if (args.verdict === 'pass' && args.context.basisStatus !== 'complete') throw new Error(`critic cannot override ${args.context.basisStatus} discovery`);
  const approvalDiagnostics = args.approvals.flatMap(approval => verifyTopologyExclusionApproval({ ...args, approval }));
  if (approvalDiagnostics.length > 0) throw new Error(`invalid exclusion approval: ${approvalDiagnostics.join('; ')}`);
  const expectedExclusions = normalizeRefs(args.context.exclusions.map(item => item.decisionRef));
  const actualExclusions = normalizeRefs(args.approvals.map(item => item.exclusionRef));
  if (JSON.stringify(expectedExclusions) !== JSON.stringify(actualExclusions) || args.approvals.length !== actualExclusions.length) {
    throw new Error('topology exclusions require exact one-to-one independent approvals');
  }
  const privateKey = readOrCreatePrivateKey(args.gitCwd, TOPOLOGY_CRITIC_ROLE);
  const unsigned: Omit<TopologyCriticReceiptV1, 'signature'> = {
    schemaVersion: 'proofstory.topology_critic_receipt.v1',
    storyId: args.context.storyId,
    criticIdentity: args.critic.agentId,
    criticRole: TOPOLOGY_CRITIC_ROLE,
    criticProvenance: args.critic,
    implementationProvenance: args.implementation,
    basisDigest: args.context.basisDigest,
    topologyDigest: args.context.topologyDigest,
    scopeCheckDigest: args.context.scopeCheckDigest,
    ...(args.context.scopeContractDigest ? { scopeContractDigest: args.context.scopeContractDigest } : {}),
    storyFilesHash: args.context.storyFilesHash,
    closureFilesHash: args.context.closureFilesHash,
    findingRefs: normalizeRefs(args.context.findingRefs),
    approvedExclusionRefs: normalizeRefs(args.approvals.map(item => item.approvalRef)),
    verdict: args.verdict,
    issuedAt: args.issuedAt ?? new Date().toISOString(),
    signerPublicKey: publicKeyForPrivate(privateKey),
  };
  return { ...unsigned, signature: signCanonical(unsigned, privateKey) };
}

export function verifyTopologyCriticReceipt(args: {
  gitCwd: string;
  context: ReceiptContext;
  receipt: TopologyCriticReceiptV1 | null;
  approvals: TopologyExclusionApprovalV1[];
  implementation: TopologyImplementationProvenanceV1;
  events: readonly ProcessEvent[];
}): TopologyCriticVerification {
  const empty = { agent: false, session: false, dispatch: false, businessCommitAuthor: false };
  if (!args.receipt) return { ok: false, code: 'AT_TOPOLOGY_CRITIC_RECEIPT_MISSING', diagnostics: ['topology critic receipt is missing'], independence: empty };
  const { receipt, context } = args;
  const diagnostics: string[] = [];
  const trusted = registeredPublicKey(args.gitCwd, TOPOLOGY_CRITIC_ROLE);
  if (!trusted || receipt.signerPublicKey !== trusted || !verifyCanonical(unsignedReceipt(receipt), receipt.signature, trusted)) diagnostics.push('topology critic signature is invalid');
  if (receipt.schemaVersion !== 'proofstory.topology_critic_receipt.v1' || receipt.storyId !== context.storyId
    || !agentRoleIdsEqual(receipt.criticRole, TOPOLOGY_CRITIC_ROLE) || !agentRoleIdsEqual(receipt.criticIdentity, TOPOLOGY_CRITIC_ROLE)
    || !hasActorProvenance(receipt.criticProvenance) || !agentRoleIdsEqual(receipt.criticProvenance.agentId, TOPOLOGY_CRITIC_ROLE)
    || receipt.criticProvenance.businessCommitAuthorSource !== 'git-var:GIT_AUTHOR_IDENT'
    || !isValidIssuedAt(receipt.issuedAt)) diagnostics.push('topology critic role/story binding mismatch');
  diagnostics.push(...actorDispatchDiagnostics({
    gitCwd: args.gitCwd,
    events: args.events,
    actor: receipt.criticProvenance,
    expectedRole: TOPOLOGY_CRITIC_ROLE,
    context,
    implementation: args.implementation,
    label: 'topology critic',
  }));
  const independence = verifierIndependenceMatrix(receipt.criticProvenance, args.implementation);
  for (const [dimension, independent] of Object.entries(independence)) if (!independent) diagnostics.push(`topology critic independence failed: ${dimension}`);
  diagnostics.push(...implementationProvenanceDiagnostics(receipt.implementationProvenance, args.implementation));
  if (JSON.stringify(receipt.implementationProvenance) !== JSON.stringify(args.implementation)) diagnostics.push('critic implementation provenance mismatch');
  if (context.basisStatus !== 'complete') diagnostics.push(`critic cannot override ${context.basisStatus} discovery`);
  if (receipt.verdict !== 'pass') diagnostics.push(`critic verdict is ${receipt.verdict}`);
  if (receipt.basisDigest !== context.basisDigest || receipt.topologyDigest !== context.topologyDigest
    || receipt.scopeCheckDigest !== context.scopeCheckDigest || receipt.scopeContractDigest !== context.scopeContractDigest
    || receipt.storyFilesHash !== context.storyFilesHash || receipt.closureFilesHash !== context.closureFilesHash) diagnostics.push('critic receipt freshness binding mismatch');
  if (!isCanonicalRefs(receipt.findingRefs) || JSON.stringify(receipt.findingRefs) !== JSON.stringify(normalizeRefs(context.findingRefs))) diagnostics.push('finding refs are noncanonical or stale');
  if (!isCanonicalRefs(receipt.approvedExclusionRefs)) diagnostics.push('approved exclusion refs are noncanonical');
  const approvalDiagnostics = args.approvals.flatMap(approval => verifyTopologyExclusionApproval({ ...args, approval, ...(hasActorProvenance(receipt.criticProvenance) ? { critic: receipt.criticProvenance } : {}) }));
  diagnostics.push(...approvalDiagnostics);
  const expectedExclusions = normalizeRefs(context.exclusions.map(item => item.decisionRef));
  const actualExclusions = normalizeRefs(args.approvals.map(item => item.exclusionRef));
  const expectedApprovalRefs = normalizeRefs(args.approvals.map(item => item.approvalRef));
  if (args.approvals.length !== actualExclusions.length || JSON.stringify(expectedExclusions) !== JSON.stringify(actualExclusions)
    || JSON.stringify(receipt.approvedExclusionRefs) !== JSON.stringify(expectedApprovalRefs)) diagnostics.push('topology exclusions lack exact one-to-one current approvals');
  const code = diagnostics.length === 0 ? 'ok'
    : diagnostics.some(item => item.includes('partial') || item.includes('unsupported')) ? 'AT_TOPOLOGY_CRITIC_INCOMPLETE_BASIS'
      : diagnostics.some(item => item.includes('independ')) ? 'AT_TOPOLOGY_CRITIC_NOT_INDEPENDENT'
        : diagnostics.some(item => item.includes('exclusion')) ? 'AT_TOPOLOGY_EXCLUSION_APPROVAL_INVALID'
          : 'AT_TOPOLOGY_CRITIC_RECEIPT_INVALID';
  return { ok: diagnostics.length === 0, code, diagnostics, independence };
}

export function canonicalTopologyReceiptContext(context: ReceiptContext): ReceiptContext {
  return { ...context, exclusions: [...context.exclusions].sort((a, b) => `${a.decisionRef}\0${a.pathRef}`.localeCompare(`${b.decisionRef}\0${b.pathRef}`)), findingRefs: normalizeRefs(context.findingRefs) };
}

export function canonicalWorkspaceIdentity(gitCwd: string): string {
  let root = gitCwd;
  try { root = realpathSync(gitCwd); } catch { /* retain caller path */ }
  return digest({ root });
}
