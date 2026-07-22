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
import { exportPublicKeyRaw, importPrivateKeyRaw, signCanonical, verifyCanonical } from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';

export const TOPOLOGY_CRITIC_ROLE = 'lattice-review-topology-critic' as const;
export const TOPOLOGY_EXCLUSION_APPROVER_ROLE = 'lattice-review-scope-plan' as const;
const IMPLEMENTER_ROLE = 'lattice-implementer' as const;
const IMPLEMENTER_AUTHOR = 'lattice-implementer <lattice-implementer@noreply.local>';

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

function isCanonicalRefs(refs: readonly string[]): boolean {
  return JSON.stringify(refs) === JSON.stringify(normalizeRefs(refs));
}

function isValidIssuedAt(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function dispatchIdentity(events: readonly ProcessEvent[], role: string, sessionId?: string): string {
  const event = [...events].reverse().find(candidate =>
    candidate.type === 'dispatch'
    && candidate.agentType === role
    && (!sessionId || candidate.sessionId === sessionId),
  );
  if (!event) throw new Error(`no registered dispatch provenance for ${role}${sessionId ? ` in session ${sessionId}` : ''}`);
  return String(event.promptEnvelopeId || event.dispatchBindingDigest || digest(event));
}

export function deriveImplementationProvenance(gitCwd: string, events: readonly ProcessEvent[]): TopologyImplementationProvenanceV1 {
  let rows = '';
  try { rows = git(gitCwd, ['log', 'main..HEAD', '--format=%H%x09%an <%ae>']); } catch { /* no local main */ }
  if (!rows) rows = git(gitCwd, ['log', '-n', '50', '--format=%H%x09%an <%ae>']);
  const line = rows.split('\n').find(row => row.endsWith(`\t${IMPLEMENTER_AUTHOR}`));
  if (!line) throw new Error(`implementation provenance is missing a business commit authored by ${IMPLEMENTER_AUTHOR}`);
  const [businessCommit, businessCommitAuthor] = line.split('\t');
  const event = [...events].reverse().find(candidate => candidate.type === 'dispatch' && candidate.agentType === IMPLEMENTER_ROLE);
  if (!event || typeof event.sessionId !== 'string' || !event.sessionId.trim()) {
    throw new Error('implementation provenance is missing a session-bound lattice-implementer dispatch');
  }
  return {
    agentId: IMPLEMENTER_ROLE,
    sessionId: event.sessionId,
    dispatchId: dispatchIdentity(events, IMPLEMENTER_ROLE, event.sessionId),
    businessIdentity: businessCommitAuthor,
    businessCommit,
    businessCommitAuthor,
  };
}

export function deriveRoleProvenance(args: {
  gitCwd: string;
  events: readonly ProcessEvent[];
  expectedRole: typeof TOPOLOGY_CRITIC_ROLE | typeof TOPOLOGY_EXCLUSION_APPROVER_ROLE;
  actor: string | undefined;
  sessionId: string;
}): TopologyActorProvenanceV1 {
  if (args.actor !== args.expectedRole) throw new Error(`role eligibility failed: expected ${args.expectedRole}, received ${args.actor || '<missing>'}`);
  if (!args.sessionId.trim()) throw new Error('role eligibility failed: session identity is missing');
  return {
    agentId: args.expectedRole,
    sessionId: args.sessionId,
    dispatchId: dispatchIdentity(args.events, args.expectedRole, args.sessionId),
    // Reviewer roles do not author business commits. Their registered canonical
    // role is therefore the mechanically attributable business identity and is
    // compared against the git-derived implementation commit author below.
    businessIdentity: args.expectedRole,
  };
}

export function independenceMatrix(actor: TopologyActorProvenanceV1, implementation: TopologyImplementationProvenanceV1) {
  return {
    agent: actor.agentId !== implementation.agentId,
    session: actor.sessionId !== implementation.sessionId,
    dispatch: actor.dispatchId !== implementation.dispatchId,
    businessCommitAuthor: actor.businessIdentity !== implementation.businessCommitAuthor
      && actor.agentId !== implementation.businessCommitAuthor,
  };
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
}): string[] {
  const { approval, context } = args;
  const diagnostics: string[] = [];
  const trusted = registeredPublicKey(args.gitCwd, TOPOLOGY_EXCLUSION_APPROVER_ROLE);
  if (!trusted || approval.signerPublicKey !== trusted || !verifyCanonical(unsignedApproval(approval), approval.signature, trusted)) diagnostics.push('exclusion approval signature is invalid');
  const expectedApprovalRef = `TEA-${digest({ storyId: context.storyId, exclusionRef: approval.exclusionRef }).slice(7, 19)}`;
  if (approval.schemaVersion !== 'proofstory.topology_exclusion_approval.v1' || approval.storyId !== context.storyId
    || approval.approverRole !== TOPOLOGY_EXCLUSION_APPROVER_ROLE || approval.approverIdentity !== TOPOLOGY_EXCLUSION_APPROVER_ROLE
    || approval.approverProvenance.agentId !== TOPOLOGY_EXCLUSION_APPROVER_ROLE
    || approval.approvalRef !== expectedApprovalRef || !isValidIssuedAt(approval.issuedAt)) diagnostics.push('exclusion approval role/story binding mismatch');
  if (JSON.stringify(approval.implementationProvenance) !== JSON.stringify(args.implementation)) diagnostics.push('exclusion implementation provenance mismatch');
  const expected = context.exclusions.filter(item => item.decisionRef === approval.exclusionRef && item.pathRef === approval.scopeRef);
  if (expected.length !== 1) diagnostics.push('exclusion approval is missing, orphaned, duplicated, or cross-story');
  if (approval.basisDigest !== context.basisDigest || approval.topologyDigest !== context.topologyDigest
    || approval.scopeCheckDigest !== context.scopeCheckDigest || approval.scopeContractDigest !== context.scopeContractDigest
    || approval.storyFilesHash !== context.storyFilesHash || approval.closureFilesHash !== context.closureFilesHash) diagnostics.push('exclusion approval freshness binding mismatch');
  const independence = independenceMatrix(approval.approverProvenance, args.implementation);
  if (Object.values(independence).some(value => !value)) diagnostics.push(`exclusion approver is not independent: ${Object.entries(independence).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`);
  if (args.critic && (approval.approverProvenance.agentId === args.critic.agentId
    || approval.approverProvenance.sessionId === args.critic.sessionId
    || approval.approverProvenance.dispatchId === args.critic.dispatchId
    || approval.approverProvenance.businessIdentity === args.critic.businessIdentity)) diagnostics.push('exclusion approver is not independent from topology critic');
  return diagnostics;
}

export function issueTopologyCriticReceipt(args: {
  gitCwd: string;
  context: ReceiptContext;
  critic: TopologyActorProvenanceV1;
  implementation: TopologyImplementationProvenanceV1;
  approvals: TopologyExclusionApprovalV1[];
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
}): TopologyCriticVerification {
  const empty = { agent: false, session: false, dispatch: false, businessCommitAuthor: false };
  if (!args.receipt) return { ok: false, code: 'AT_TOPOLOGY_CRITIC_RECEIPT_MISSING', diagnostics: ['topology critic receipt is missing'], independence: empty };
  const { receipt, context } = args;
  const diagnostics: string[] = [];
  const trusted = registeredPublicKey(args.gitCwd, TOPOLOGY_CRITIC_ROLE);
  if (!trusted || receipt.signerPublicKey !== trusted || !verifyCanonical(unsignedReceipt(receipt), receipt.signature, trusted)) diagnostics.push('topology critic signature is invalid');
  if (receipt.schemaVersion !== 'proofstory.topology_critic_receipt.v1' || receipt.storyId !== context.storyId
    || receipt.criticRole !== TOPOLOGY_CRITIC_ROLE || receipt.criticIdentity !== TOPOLOGY_CRITIC_ROLE
    || receipt.criticProvenance.agentId !== TOPOLOGY_CRITIC_ROLE
    || !isValidIssuedAt(receipt.issuedAt)) diagnostics.push('topology critic role/story binding mismatch');
  const independence = independenceMatrix(receipt.criticProvenance, args.implementation);
  for (const [dimension, independent] of Object.entries(independence)) if (!independent) diagnostics.push(`topology critic independence failed: ${dimension}`);
  if (JSON.stringify(receipt.implementationProvenance) !== JSON.stringify(args.implementation)) diagnostics.push('critic implementation provenance mismatch');
  if (context.basisStatus !== 'complete') diagnostics.push(`critic cannot override ${context.basisStatus} discovery`);
  if (receipt.verdict !== 'pass') diagnostics.push(`critic verdict is ${receipt.verdict}`);
  if (receipt.basisDigest !== context.basisDigest || receipt.topologyDigest !== context.topologyDigest
    || receipt.scopeCheckDigest !== context.scopeCheckDigest || receipt.scopeContractDigest !== context.scopeContractDigest
    || receipt.storyFilesHash !== context.storyFilesHash || receipt.closureFilesHash !== context.closureFilesHash) diagnostics.push('critic receipt freshness binding mismatch');
  if (!isCanonicalRefs(receipt.findingRefs) || JSON.stringify(receipt.findingRefs) !== JSON.stringify(normalizeRefs(context.findingRefs))) diagnostics.push('finding refs are noncanonical or stale');
  if (!isCanonicalRefs(receipt.approvedExclusionRefs)) diagnostics.push('approved exclusion refs are noncanonical');
  const approvalDiagnostics = args.approvals.flatMap(approval => verifyTopologyExclusionApproval({ ...args, approval, critic: receipt.criticProvenance }));
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
