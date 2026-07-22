import { createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AcceptanceBasisArtifactV1,
  ChecklistData,
  PreReviewCheckArtifactV1,
  PreReviewCheckCodeV1,
  PreReviewEvidenceRefV1,
  VerificationEvidence,
} from './types.js';
import type { AcceptanceTopologyGateMode } from './config.js';
import { exportPublicKeyRaw, importPrivateKeyRaw, signCanonical, verifyCanonical } from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import { verifyAcceptanceBasisReceipt } from './acceptance-basis-receipt.js';
import { verifyAcceptanceCoverageBasis } from './acceptance-coverage-basis.js';

const KEY_FILE = 'lattice-pre-review-check-verifier-v1.key';
const REQUIRED_CLAIMS = ['production-path', 'mutation-applied', 'mutation-bites', 'control-restored', 'transcript-related', 'authority-admissible', 'cutoff-bound'] as const;

export interface PreReviewCheckInput {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  cutoffAt: string;
  planArtifact: AcceptanceBasisArtifactV1 | null;
  currentArtifact: AcceptanceBasisArtifactV1;
  checklist: ChecklistData;
  topologyDigest: string;
  topologyDiagnosticCodes: string[];
  criticVerification?: { ok: boolean; code: string };
  criticReceiptDigest?: string;
}

export interface PreReviewCheckReport {
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  readOnly: true;
  status: 'pass' | 'fail' | 'inconclusive';
  ok: boolean;
  blocking: boolean;
  codes: PreReviewCheckCodeV1[];
  plannedActual: 'complete' | 'incomplete';
  executableEvidence: 'current' | 'missing';
  mutations: 'biting' | 'missing';
  transcript: 'related' | 'missing';
  authority: 'admissible' | 'inadmissible';
  criticReattestation: 'current' | 'missing' | 'not_required';
  artifact: PreReviewCheckArtifactV1 | null;
}

function digest(value: unknown): string { return `sha256:${digestCanonicalJson(value)}`; }
function stable<T extends string>(values: readonly T[]): T[] { return [...new Set(values)].sort() as T[]; }

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, encoding: 'utf8' }).trim();
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}
function keyPath(gitCwd: string): string { return join(gitCommonDir(gitCwd), KEY_FILE); }
function privateKey(gitCwd: string): string {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return readFileSync(path, 'utf8').trim();
}
function trustedPublicKey(gitCwd: string): string | null {
  try { return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(readFileSync(keyPath(gitCwd), 'utf8').trim()))); }
  catch { return null; }
}
function unsignedArtifact(artifact: PreReviewCheckArtifactV1): Omit<PreReviewCheckArtifactV1, 'signature'> {
  const { signature: _signature, ...unsigned } = artifact;
  return unsigned;
}

function allEvidence(checklist: ChecklistData): Array<{ itemId: string; index: number; evidence: VerificationEvidence }> {
  return checklist.items.flatMap(item => (item.verificationEvidence ?? []).map((evidence, index) => ({ itemId: item.id, index, evidence })));
}

function evidenceState(checklist: ChecklistData, cutoffAt: string, storyFilesHash: string, gitCwd = '', storyId = '') {
  const cutoff = Date.parse(cutoffAt);
  const rows = allEvidence(checklist);
  const afterCutoff = rows.filter(({ evidence }) => typeof evidence.timestamp === 'string' && Date.parse(evidence.timestamp) >= cutoff);
  const stale = rows.filter(({ evidence }) => evidence.result === 'pass' && evidence.storyFilesHash !== storyFilesHash);
  const current = rows.filter(({ evidence }) => evidence.result === 'pass'
    && typeof evidence.timestamp === 'string'
    && Date.parse(evidence.timestamp) < cutoff
    && evidence.storyFilesHash === storyFilesHash);
  const evidenceRefs: PreReviewEvidenceRefV1[] = current.map(({ itemId, index, evidence }) => ({
    intentRef: evidence.intentRef,
    itemId,
    evidenceIndex: index,
    kind: evidence.kind,
    evidenceDigest: digest(evidence),
  })).sort((a, b) => `${a.intentRef}\0${a.itemId}\0${a.evidenceIndex}`.localeCompare(`${b.intentRef}\0${b.itemId}\0${b.evidenceIndex}`));
  const mustIntents = checklist.items.flatMap(item => (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
    (item.verificationIntent?.[lane] ?? []).filter(intent => (intent.priority ?? 'must') === 'must').map((intent, index) => intent.id ?? `${item.id}:${lane}:${index}`)));
  const currentRefs = new Set(current.map(row => row.evidence.intentRef));
  const missingIntents = mustIntents.filter(ref => !currentRefs.has(ref));
  const claims = new Set(current.flatMap(row => row.evidence.attestation?.checkedClaims ?? []));
  let transcriptRelated = false;
  for (const { evidence } of current.filter(row => row.evidence.kind === 'manual_transcript')) {
    if (!gitCwd || !evidence.file || isAbsolute(evidence.file) || evidence.file.split(/[\\/]/).includes('..')) continue;
    try {
      const transcript = JSON.parse(readFileSync(resolve(gitCwd, evidence.file), 'utf8')) as Record<string, unknown>;
      const events = Array.isArray(transcript.events) ? transcript.events as Array<Record<string, unknown>> : [];
      const producer = events.findIndex(event => event.kind === 'producer' && event.intentRef === evidence.intentRef);
      const consumer = events.findIndex(event => event.kind === 'consumer' && event.intentRef === evidence.intentRef);
      const mutation = transcript.mutation as Record<string, unknown> | undefined;
      transcriptRelated = transcript.storyId === storyId && producer >= 0 && consumer > producer;
      if (transcriptRelated) claims.add('transcript-related');
      if (mutation?.applied === true && typeof mutation.expectedCode === 'string' && mutation.expectedCode === mutation.observedCode) {
        claims.add('mutation-applied'); claims.add('mutation-bites');
      }
      if (mutation?.controlRestored === true) claims.add('control-restored');
    } catch { /* malformed or missing transcript remains unrelated */ }
  }
  const trusted = current.some(row => {
    const trust = row.evidence.actorTrust;
    return trust?.trustStatus !== 'revoked'
      && Boolean(trust?.producerActorId && trust?.verifierActorId && trust.producerActorId !== trust.verifierActorId);
  });
  return { evidenceRefs, missingIntents, claims, trusted, afterCutoff: afterCutoff.length, stale: stale.length, transcriptRelated };
}

export function issuePreReviewCheckArtifact(input: PreReviewCheckInput): PreReviewCheckArtifactV1 {
  const basis = input.currentArtifact.basis;
  const codes: PreReviewCheckCodeV1[] = [];
  if (!input.planArtifact || basis.priorPlanBasisDigest !== input.planArtifact.basis.basisDigest) codes.push('PR_COVERAGE_BASIS_CHANGED');
  if (basis.status !== 'complete') codes.push('PR_COVERAGE_INCONCLUSIVE');
  const basisVerification = verifyAcceptanceCoverageBasis(basis);
  for (const diagnostic of basisVerification.diagnostics) {
    const code = diagnostic.code.startsWith('PR_') ? diagnostic.code as PreReviewCheckCodeV1 : 'PR_ADAPTER_RESULT_INVALID';
    codes.push(code);
  }
  if (basis.plannedActualReconciliations.length !== basis.plannedPathRecords.length) codes.push('PR_PLANNED_PATH_UNRESOLVED');
  if (input.topologyDiagnosticCodes.some(code => code === 'AT_UNMAPPED_SCOPE_REF')) codes.push('PR_NEW_PATH_UNMAPPED');
  if (input.topologyDiagnosticCodes.length > 0) codes.push('PR_COVERAGE_BASIS_CHANGED');
  const evidence = evidenceState(input.checklist, input.cutoffAt, basis.binding.storyFilesHash, input.gitCwd, input.storyId);
  if (evidence.stale > 0) codes.push('PR_EVIDENCE_STALE');
  if (evidence.afterCutoff > 0) codes.push('PR_CUTOFF_UNBOUND');
  if (evidence.missingIntents.length > 0) codes.push('PR_POSITIVE_EVIDENCE_MISSING');
  if (!evidence.claims.has('production-path')) codes.push('PR_PRODUCTION_PATH_UNPROVEN');
  if (!evidence.claims.has('mutation-applied')) codes.push('PR_MUTATION_EVIDENCE_MISSING');
  if (!evidence.claims.has('mutation-bites')) codes.push('PR_MUTATION_DID_NOT_BITE');
  if (!evidence.claims.has('control-restored')) codes.push('PR_CONTROL_NOT_RESTORED');
  if (!evidence.transcriptRelated) codes.push(evidence.evidenceRefs.some(ref => ref.kind === 'manual_transcript') ? 'PR_TRANSCRIPT_UNRELATED' : 'PR_TRANSCRIPT_MISSING');
  if (!evidence.trusted || !evidence.claims.has('authority-admissible')) codes.push('PR_AUTHORITY_INADMISSIBLE');
  if (!evidence.claims.has('cutoff-bound')) codes.push('PR_CUTOFF_UNBOUND');
  if (input.mode === 'enforce' && !input.criticVerification?.ok) codes.push('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED');
  const orderedCodes = stable(codes);
  const status = orderedCodes.length === 0 ? 'pass' : basis.status === 'complete' ? 'fail' : 'inconclusive';
  const key = privateKey(input.gitCwd);
  const signerPublicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(key)));
  const unsigned: Omit<PreReviewCheckArtifactV1, 'signature'> = {
    schemaVersion: 'proofstory.pre_review_check.v1',
    storyId: input.storyId,
    mode: input.mode,
    cutoffAt: input.cutoffAt,
    planBasisDigest: input.planArtifact?.basis.basisDigest ?? '<missing>',
    preReviewBasisArtifact: input.currentArtifact,
    topologyDigest: input.topologyDigest,
    scopeCheckDigest: basis.binding.scopeCheckDigest,
    ...(basis.binding.scopeContractDigest ? { scopeContractDigest: basis.binding.scopeContractDigest } : {}),
    storyFilesHash: basis.binding.storyFilesHash,
    closureFilesHash: basis.binding.closureFilesHash,
    evidenceRefs: evidence.evidenceRefs,
    ...(input.criticReceiptDigest ? { criticReceiptDigest: input.criticReceiptDigest } : {}),
    codes: orderedCodes,
    status,
    issuedAt: input.cutoffAt,
    signerPublicKey,
  };
  return { ...unsigned, signature: signCanonical(unsigned, key) };
}

export function verifyPreReviewCheckArtifact(input: PreReviewCheckInput & { artifact: PreReviewCheckArtifactV1 | null }): PreReviewCheckReport {
  const artifact = input.artifact;
  if (!artifact) return {
    storyId: input.storyId, mode: input.mode, readOnly: true, status: 'fail', ok: false, blocking: input.mode === 'enforce',
    codes: ['PR_ARTIFACT_TAMPERED'], plannedActual: 'incomplete', executableEvidence: 'missing', mutations: 'missing', transcript: 'missing', authority: 'inadmissible',
    criticReattestation: input.mode === 'enforce' ? 'missing' : 'not_required', artifact: null,
  };
  // Metadata auto-commit advances HEAD after the producer writes the artifact.
  // Re-evaluate semantic evidence against the signed basis while the canonical
  // receipt freshness reader below independently rejects material/story/closure
  // drift; do not silently rebind the stored artifact to the later HEAD.
  const expectedInput = artifact ? { ...input, currentArtifact: artifact.preReviewBasisArtifact } : input;
  const expected = issuePreReviewCheckArtifact(expectedInput);
  const codes: PreReviewCheckCodeV1[] = artifact ? [...expected.codes] : ['PR_ARTIFACT_TAMPERED'];
  const trusted = trustedPublicKey(input.gitCwd);
  if (!artifact || !trusted || artifact.signerPublicKey !== trusted
    || !verifyCanonical(unsignedArtifact(artifact), artifact.signature, trusted)
    || digest(unsignedArtifact(artifact)) !== digest(unsignedArtifact(expected))) codes.push('PR_ARTIFACT_TAMPERED');
  if (artifact) {
    const receipt = verifyAcceptanceBasisReceipt({
      artifact: artifact.preReviewBasisArtifact,
      gitCwd: input.gitCwd,
      metadataRoot: input.metadataRoot,
      expectedStoryId: input.storyId,
      expectedTopologyDigest: input.topologyDigest,
      expectedScopeCheckDigest: input.currentArtifact.basis.binding.scopeCheckDigest,
      ...(input.currentArtifact.basis.binding.scopeContractDigest ? { expectedScopeContractDigest: input.currentArtifact.basis.binding.scopeContractDigest } : {}),
      expectedClosureFilesHash: input.currentArtifact.basis.binding.closureFilesHash,
      expectedSealDigest: input.currentArtifact.basis.snapshotSeal.sealDigest,
    });
    if (!receipt.ok || artifact.storyId !== input.storyId) codes.push('PR_ARTIFACT_TAMPERED');
  }
  const ordered = stable(codes);
  const ok = ordered.length === 0 && artifact?.status === 'pass';
  const claims = evidenceState(input.checklist, input.cutoffAt, input.currentArtifact.basis.binding.storyFilesHash, input.gitCwd, input.storyId).claims;
  return {
    storyId: input.storyId, mode: input.mode, readOnly: true, status: ok ? 'pass' : input.currentArtifact.basis.status === 'complete' ? 'fail' : 'inconclusive',
    ok, blocking: input.mode === 'enforce' && !ok, codes: ordered,
    plannedActual: input.currentArtifact.basis.plannedActualReconciliations.length === input.currentArtifact.basis.plannedPathRecords.length ? 'complete' : 'incomplete',
    executableEvidence: claims.has('production-path') ? 'current' : 'missing', mutations: claims.has('mutation-bites') && claims.has('control-restored') ? 'biting' : 'missing',
    transcript: claims.has('transcript-related') ? 'related' : 'missing', authority: claims.has('authority-admissible') ? 'admissible' : 'inadmissible',
    criticReattestation: input.mode !== 'enforce' ? 'not_required' : input.criticVerification?.ok ? 'current' : 'missing', artifact,
  };
}
