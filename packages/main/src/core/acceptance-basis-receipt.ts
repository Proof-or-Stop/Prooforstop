import { createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AcceptanceBasisArtifactV1, AcceptanceBasisReceiptV1, AcceptanceCoverageBasisV1 } from './types.js';
import {
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { acceptanceCoverageBasisSemanticDigest, verifyAcceptanceCoverageBasis } from './acceptance-coverage-basis.js';

const KEY_FILE = 'proof-or-stop-acceptance-basis-verifier-v1.key';

export interface AcceptanceBasisReceiptVerification {
  ok: boolean;
  code: 'ok' | 'AT_COVERAGE_BASIS_MISSING' | 'AT_COVERAGE_BASIS_STALE' | 'AT_ADAPTER_RESULT_DIGEST_MISMATCH' | 'AT_SCOPE_BINDING_MISSING';
  diagnostics: string[];
}

function digest(value: unknown): string {
  return `sha256:${digestCanonicalJson(value)}`;
}

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, encoding: 'utf8' }).trim();
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}

function keyPath(gitCwd: string): string {
  return join(gitCommonDir(gitCwd), KEY_FILE);
}

function readOrCreatePrivateKey(gitCwd: string): string {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return readFileSync(path, 'utf8').trim();
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function registeredPublicKey(gitCwd: string): string | null {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) return null;
  try { return publicKeyForPrivate(readFileSync(path, 'utf8').trim()); }
  catch { return null; }
}

function unsignedReceipt(receipt: AcceptanceBasisReceiptV1): Omit<AcceptanceBasisReceiptV1, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export function workspaceIdentityDigest(workspaceRoot: string): string {
  let common = '<unavailable>';
  try { common = realpathSync(gitCommonDir(workspaceRoot)); } catch { /* deterministic unavailable marker */ }
  let root = workspaceRoot;
  try { root = realpathSync(workspaceRoot); } catch { /* keep supplied root */ }
  return digest({ common, root });
}

export function issueAcceptanceBasisReceipt(args: {
  gitCwd: string;
  basis: AcceptanceCoverageBasisV1;
  topologyDigest: string;
}): AcceptanceBasisReceiptV1 {
  const privateKey = readOrCreatePrivateKey(args.gitCwd);
  const signerPublicKey = publicKeyForPrivate(privateKey);
  const unsigned: Omit<AcceptanceBasisReceiptV1, 'signature'> = {
    schemaVersion: 'proofstory.acceptance_basis_receipt.v1',
    receiptRef: args.basis.receiptRef,
    issuer: 'acceptance-coverage-basis-verifier',
    issuerKeyId: `sha256:${digestCanonicalJson(signerPublicKey)}`,
    signerPublicKey,
    storyId: args.basis.storyId,
    phaseBasis: args.basis.phaseBasis,
    basisDigest: args.basis.basisDigest,
    topologyDigest: args.topologyDigest,
    scopeCheckDigest: args.basis.binding.scopeCheckDigest,
    ...(args.basis.binding.scopeContractDigest ? { scopeContractDigest: args.basis.binding.scopeContractDigest } : {}),
    headHash: args.basis.binding.headHash,
    materialHash: args.basis.binding.materialHash,
    storyFilesHash: args.basis.binding.storyFilesHash,
    closureFilesHash: args.basis.binding.closureFilesHash,
    sealDigest: args.basis.snapshotSeal.sealDigest,
    workspaceIdentityDigest: workspaceIdentityDigest(args.gitCwd),
  };
  return { ...unsigned, signature: signCanonical(unsigned, privateKey) };
}

export function verifyAcceptanceBasisReceipt(args: {
  artifact: AcceptanceBasisArtifactV1 | null;
  gitCwd: string;
  metadataRoot: string;
  expectedStoryId: string;
  expectedTopologyDigest?: string;
  expectedScopeCheckDigest?: string;
  expectedScopeContractDigest?: string;
  expectedClosureFilesHash?: string;
  expectedSealDigest?: string;
  expectedBasisSemanticDigest?: string;
}): AcceptanceBasisReceiptVerification {
  if (!args.artifact) return { ok: false, code: 'AT_COVERAGE_BASIS_MISSING', diagnostics: ['acceptance basis receipt is missing'] };
  const { basis, receipt } = args.artifact;
  const diagnostics: string[] = [];
  const trustedPublicKey = registeredPublicKey(args.gitCwd);
  if (!trustedPublicKey
    || receipt.signerPublicKey !== trustedPublicKey
    || receipt.issuerKeyId !== `sha256:${digestCanonicalJson(trustedPublicKey)}`) diagnostics.push('registered verifier signer key mismatch');
  if (!trustedPublicKey || !verifyCanonical(unsignedReceipt(receipt), receipt.signature, trustedPublicKey)) diagnostics.push('receipt signature is invalid');
  const basisVerification = verifyAcceptanceCoverageBasis(basis);
  diagnostics.push(...basisVerification.diagnostics.map(item => `${item.code}: ${item.message}`));
  if (args.expectedBasisSemanticDigest && acceptanceCoverageBasisSemanticDigest(basis) !== args.expectedBasisSemanticDigest) {
    diagnostics.push('basis semantic discovery digest mismatch');
  }
  if (receipt.issuer !== 'acceptance-coverage-basis-verifier'
    || receipt.storyId !== args.expectedStoryId
    || basis.storyId !== args.expectedStoryId
    || receipt.receiptRef !== basis.receiptRef
    || receipt.basisDigest !== basis.basisDigest) diagnostics.push('issuer/story/basis receipt binding mismatch');
  if (receipt.workspaceIdentityDigest !== workspaceIdentityDigest(args.gitCwd)) diagnostics.push('workspace identity mismatch');
  if (args.expectedTopologyDigest && receipt.topologyDigest !== args.expectedTopologyDigest) diagnostics.push('topology digest mismatch');
  if (args.expectedScopeCheckDigest && receipt.scopeCheckDigest !== args.expectedScopeCheckDigest) diagnostics.push('scope-check digest mismatch');
  if (args.expectedScopeContractDigest && receipt.scopeContractDigest !== args.expectedScopeContractDigest) diagnostics.push('scope-contract digest mismatch');
  if (args.expectedClosureFilesHash && receipt.closureFilesHash !== args.expectedClosureFilesHash) diagnostics.push('closure files hash mismatch');
  if (args.expectedSealDigest && receipt.sealDigest !== args.expectedSealDigest) diagnostics.push('snapshot seal digest mismatch');
  const freshness = checkEvidenceFreshnessForGit(args.gitCwd, receipt.headHash, receipt.materialHash, args.metadataRoot, receipt.storyFilesHash);
  if (!freshness.fresh) diagnostics.push(`freshness mismatch: ${freshness.reason}`);
  const current = {
    headHash: currentGitHead(args.gitCwd),
    materialHash: currentMaterialHash(args.gitCwd, 'HEAD', args.metadataRoot),
    storyFilesHash: currentStoryFilesHash(args.gitCwd, 'HEAD', args.metadataRoot),
  };
  if (!current.headHash || !current.materialHash || !current.storyFilesHash) diagnostics.push('current workspace binding is unavailable');
  if (receipt.scopeCheckDigest !== basis.binding.scopeCheckDigest
    || receipt.scopeContractDigest !== basis.binding.scopeContractDigest
    || receipt.closureFilesHash !== basis.binding.closureFilesHash
    || receipt.sealDigest !== basis.snapshotSeal.sealDigest
    || receipt.headHash !== basis.binding.headHash
    || receipt.materialHash !== basis.binding.materialHash
    || receipt.storyFilesHash !== basis.binding.storyFilesHash) diagnostics.push('receipt and basis binding mismatch');
  if (diagnostics.length === 0) return { ok: true, code: 'ok', diagnostics: [] };
  const code = diagnostics.some(message => message.includes('scope-'))
    ? 'AT_SCOPE_BINDING_MISSING'
    : diagnostics.some(message => message.includes('digest') || message.includes('signature') || message.includes('binding mismatch'))
      ? 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'
      : 'AT_COVERAGE_BASIS_STALE';
  return { ok: false, code, diagnostics };
}
