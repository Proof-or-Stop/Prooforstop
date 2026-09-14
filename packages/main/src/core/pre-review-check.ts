import { createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AcceptanceBasisArtifactV1,
  ChecklistData,
  PreReviewCaseRecordV1,
  PreReviewCheckArtifactV1,
  PreReviewCheckCodeV1,
  PreReviewExecutableProofV1,
  PreReviewEvidenceRefV1,
  ProofStoryContractData,
  TopologySourceRefV1,
  VerificationEvidence,
} from './types.js';
import type { AcceptanceTopologyGateMode } from './config.js';
import { exportPublicKeyRaw, importPrivateKeyRaw, signCanonical, verifyCanonical } from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import { verifyAcceptanceBasisReceipt } from './acceptance-basis-receipt.js';
import { verifyAcceptanceCoverageBasis } from './acceptance-coverage-basis.js';
import { latestCausallyValidCloseoutReceipt } from './closeout-trust.js';
import { evaluateLiveSmokeTranscriptValue } from './live-smoke-transcript-evidence.js';
import {
  canonicalPreReviewAssertionSourceRef,
  decodePreReviewCaseRecords,
  preReviewCaseRequiresSemanticBinding,
  preReviewCaseSemanticMatches,
  preReviewExecutableProvenanceIsCurrent,
} from './pre-review-live-proof.js';
import { readBrandEnv } from './brand-env.js';
import { collectVerificationIntents, isExecutableIntentType } from './verification.js';
import { isSplitVerificationReceipt, validateVerificationReceipt } from './verification-execution-evidence.js';
import type { AcceptanceVerificationProfile } from './acceptance-discovery-adapters.js';
import { checkEvidenceFreshnessForGit } from './evidence-freshness.js';

const KEY_FILE = 'proof-or-stop-pre-review-check-verifier-v1.key';
const EXECUTABLE_PROOF_PREFIX = 'PROOFSTORY_PRE_REVIEW_PROOF=';
const LIVE_SMOKE_TRANSCRIPT_REL = 'evidence/live-smoke-transcript.json';
export const PRE_REVIEW_LIVE_PROOF_COMMAND = 'node scripts/run-proofstory-pre-review-live-proof.mjs';
export const PRE_REVIEW_LIVE_PROOF_TIMEOUT_MS = 120_000;

export interface PreReviewCheckInput {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  cutoffAt: string;
  planArtifact: AcceptanceBasisArtifactV1 | null;
  currentArtifact: AcceptanceBasisArtifactV1;
  checklist: ChecklistData;
  contract: ProofStoryContractData | null;
  executableProof: PreReviewExecutableProofV1 | null;
  topologyDigest: string;
  topologyDiagnosticCodes: string[];
  criticVerification?: { ok: boolean; code: string };
  criticReceiptDigest?: string;
  verificationProfile?: AcceptanceVerificationProfile;
}

export interface PreReviewCheckReport {
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  readOnly: true;
  verificationProfile: AcceptanceVerificationProfile;
  status: 'pass' | 'fail' | 'inconclusive';
  ok: boolean;
  blocking: boolean;
  codes: PreReviewCheckCodeV1[];
  plannedActual: 'complete' | 'incomplete';
  executableEvidence: 'current' | 'missing';
  mutations: 'biting' | 'missing' | 'not_required';
  transcript: 'related' | 'missing' | 'not_required';
  authority: 'admissible' | 'inadmissible';
  criticReattestation: 'current' | 'missing' | 'not_required';
  remediation: string[];
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

export function criticReceiptDigestForPreReviewSemanticComparison(
  mode: AcceptanceTopologyGateMode,
  currentDigest: string | undefined,
  signedDigest: string | undefined,
): string | undefined {
  return mode === 'enforce' ? currentDigest : signedDigest;
}

function allEvidence(checklist: ChecklistData): Array<{ itemId: string; index: number; evidence: VerificationEvidence }> {
  return checklist.items.flatMap(item => (item.verificationEvidence ?? []).map((evidence, index) => ({ itemId: item.id, index, evidence })));
}

function evidenceState(checklist: ChecklistData, cutoffAt: string, storyFilesHash: string) {
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
  return { evidenceRefs, missingIntents, afterCutoff: afterCutoff.length, stale: stale.length };
}

/** Verify generic command admission from the same signed receipts used by checklist gates. */
export function evaluateRegisteredCommandEvidence(input: {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  checklist: ChecklistData;
  cutoffAt: string;
  freshness: { headHash: string; materialHash: string; storyFilesHash: string };
}): { ok: boolean; codes: PreReviewCheckCodeV1[]; goTestReceiptCount: number; evidenceRefs: PreReviewEvidenceRefV1[] } {
  const freshness = {
    headHash: input.freshness.headHash,
    materialHash: input.freshness.materialHash,
    storyFilesHash: input.freshness.storyFilesHash,
  };
  const codes = new Set<PreReviewCheckCodeV1>();
  const evidenceRefs: PreReviewEvidenceRefV1[] = [];
  let goTestReceiptCount = 0;
  const cutoff = Date.parse(input.cutoffAt);
  const must = input.checklist.items.flatMap(item => collectVerificationIntents(item)
    .filter(entry => (entry.intent.priority ?? 'must') === 'must' && isExecutableIntentType(entry.intent.type))
    .map(entry => ({ item, entry })));
  for (const { item, entry } of must) {
    const pin = entry.intent.verification;
    const candidates = (item.verificationEvidence ?? []).map((evidence, index) => ({ evidence, index }))
      .filter(row => row.evidence.intentRef === entry.ref);
    const passing = candidates.filter(row => row.evidence.result === 'pass');
    if (!pin || passing.length === 0) {
      codes.add('PR_POSITIVE_EVIDENCE_MISSING');
      continue;
    }
    let accepted = false;
    const candidateFailures = new Set<PreReviewCheckCodeV1>();
    for (const { evidence, index } of passing) {
      if (evidence.materialHash !== freshness.materialHash
        || evidence.storyFilesHash !== freshness.storyFilesHash) {
        candidateFailures.add('PR_EVIDENCE_STALE');
        continue;
      }
      const liveFreshness = checkEvidenceFreshnessForGit(input.gitCwd, evidence.headHash, evidence.materialHash, input.metadataRoot, evidence.storyFilesHash);
      if (!liveFreshness.fresh) {
        candidateFailures.add('PR_EVIDENCE_STALE');
        continue;
      }
      if (typeof evidence.timestamp !== 'string' || !Number.isFinite(Date.parse(evidence.timestamp)) || Date.parse(evidence.timestamp) >= cutoff) {
        candidateFailures.add('PR_CUTOFF_UNBOUND');
        continue;
      }
      if (evidence.mechanical !== true || !evidence.receipt || evidence.command !== pin.command) {
        candidateFailures.add('PR_AUTHORITY_INADMISSIBLE');
        continue;
      }
      const evidenceFreshness = { headHash: evidence.headHash!, materialHash: evidence.materialHash!, storyFilesHash: evidence.storyFilesHash! };
      const validation = validateVerificationReceipt(input.metadataRoot, evidence.receipt, {
        storyId: input.storyId,
        intentRef: entry.ref,
        selector: pin.selector,
        command: pin.command,
        freshness: evidenceFreshness,
      });
      if (!validation.ok || !isSplitVerificationReceipt(evidence.receipt)) {
        candidateFailures.add('PR_AUTHORITY_INADMISSIBLE');
        continue;
      }
      const execution = evidence.receipt.executionReceipt;
      if (execution.exitCode !== 0 || execution.timedOut || evidence.receipt.assertionReceipt.matched !== true) {
        candidateFailures.add('PR_POSITIVE_EVIDENCE_MISSING');
        continue;
      }
      if (basename(execution.executable) === 'go' && execution.argv[0] === 'test') goTestReceiptCount += 1;
      evidenceRefs.push({ intentRef: entry.ref, itemId: item.id, evidenceIndex: index, kind: evidence.kind, evidenceDigest: digest(evidence) });
      accepted = true;
      break;
    }
    if (!accepted) {
      if (candidateFailures.size === 0) codes.add('PR_POSITIVE_EVIDENCE_MISSING');
      else for (const code of candidateFailures) codes.add(code);
    }
  }
  if (must.length === 0 || goTestReceiptCount === 0) codes.add('PR_PRODUCTION_PATH_UNPROVEN');
  const ordered = orderedCodes([...codes]);
  return { ok: ordered.length === 0, codes: ordered, goTestReceiptCount, evidenceRefs };
}

export function loadVerifiedPreReviewExecutableProof(input: {
  gitCwd: string;
  metadataRoot: string;
  storyDir: string;
  storyId: string;
  contract: ProofStoryContractData | null;
  cutoffAt: string;
  storyFilesHash: string;
}): PreReviewExecutableProofV1 | null {
  const reject = (reason: string): null => { if (readBrandEnv('DEBUG_PRE_REVIEW_PROOF') === '1') process.stderr.write(`[pre-review-proof] ${reason}\n`); return null; };
  const canonicalGitCwd = realpathSync(input.gitCwd);
  const canonicalMetadataRoot = realpathSync(input.metadataRoot);
  const canonicalStoryDir = realpathSync(input.storyDir);
  const artifactPath = join(canonicalStoryDir, LIVE_SMOKE_TRANSCRIPT_REL);
  if (!existsSync(artifactPath)) return reject('artifact missing');
  const bytes = readFileSync(artifactPath, 'utf8');
  const receipt = latestCausallyValidCloseoutReceipt(canonicalStoryDir, input.storyId, LIVE_SMOKE_TRANSCRIPT_REL, {
    projectRoot: canonicalGitCwd,
    metadataRoot: canonicalMetadataRoot,
  });
  if (!receipt || receipt.writerCommand !== 'live_smoke_transcript'
    || receipt.storyFilesHash !== input.storyFilesHash
    || Date.parse(receipt.timestamp) >= Date.parse(input.cutoffAt)) return reject(`receipt invalid writer=${receipt?.writerCommand ?? 'missing'} storyFiles=${receipt?.storyFilesHash ?? 'missing'} expected=${input.storyFilesHash} timestamp=${receipt?.timestamp ?? 'missing'} cutoff=${input.cutoffAt}`);
  let transcript: { actual?: { command?: unknown; stdout?: unknown; exitCode?: unknown } | null };
  try { transcript = JSON.parse(bytes) as typeof transcript; }
  catch { return reject('artifact JSON malformed'); }
  if (!evaluateLiveSmokeTranscriptValue(transcript, input.storyId).ok
    || transcript.actual?.command !== PRE_REVIEW_LIVE_PROOF_COMMAND
    || typeof transcript.actual.stdout !== 'string'
    || transcript.actual.exitCode !== 0) return reject('captured transcript shape/exit invalid');
  const proofLine = transcript.actual.stdout.split(/\r?\n/).find(line => line.startsWith(EXECUTABLE_PROOF_PREFIX));
  if (!proofLine) return reject('proof line missing');
  let parsed: unknown;
  try { parsed = JSON.parse(proofLine.slice(EXECUTABLE_PROOF_PREFIX.length)); }
  catch { return reject('proof line JSON malformed'); }
  if (!parsed || typeof parsed !== 'object') return reject('proof is not an object');
  const candidate = parsed as Partial<PreReviewExecutableProofV1>;
  if (candidate.schemaVersion !== 'proofstory.pre_review_executable_proof.v1'
    || candidate.storyId !== input.storyId || !Array.isArray(candidate.bindingProofs)
    || !Array.isArray(candidate.commandDigests) || candidate.commandDigests.length !== 1
    || candidate.caseRecordsEncoding !== 'gzip-base64' || typeof candidate.caseRecords !== 'string' || !candidate.provenance
    || candidate.commandDigests.some(value => typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))) return reject('proof schema/story/bindings/case aggregate digest invalid');
  let records;
  try { records = decodePreReviewCaseRecords(candidate.caseRecords); }
  catch { return reject('proof case records compression invalid'); }
  const requiredIds = input.contract?.acceptanceBindings.flatMap(binding => binding.verificationTopology
    ? [...binding.verificationTopology.positiveAssertionRefs, ...binding.verificationTopology.mutationCaseRefs, ...binding.verificationTopology.transcriptAssertionRefs].map(item => item.id)
    : []) ?? [];
  const recordIds = records.map(record => Array.isArray(record) ? record[0] : '<invalid>');
  const mutations = records.filter(record => Array.isArray(record) && record[1] === 'mutation');
  const validRecords = records.every(record => Array.isArray(record) && record.length === 10
    && typeof record[0] === 'string' && ['positive', 'mutation', 'transcript'].includes(record[1])
    && typeof record[2] === 'string' && record[2].length > 0 && typeof record[3] === 'string' && record[3].length > 0
    && typeof record[4] === 'string' && record[4].length > 0 && typeof record[5] === 'string' && record[5].length > 0
    && typeof record[6] === 'string' && record[6].length > 0 && typeof record[7] === 'boolean'
    && Array.isArray(record[8]) && record[8].every(event => Array.isArray(event) && typeof event[0] === 'string' && Number.isInteger(event[1]))
    && typeof record[9] === 'string' && record[9].length > 0);
  const exactIds = JSON.stringify(stable(recordIds)) === JSON.stringify(stable(requiredIds))
    && new Set(recordIds).size === recordIds.length;
  const assertionRows: Array<[string, [PreReviewCaseRecordV1[1], TopologySourceRefV1]]> =
    input.contract?.acceptanceBindings.flatMap(binding => {
    const topology = binding.verificationTopology;
    return topology ? [...topology.positiveAssertionRefs.map(assertion => [assertion.id, ['positive', assertion.sourceRef]] as [string, ['positive', typeof assertion.sourceRef]]),
      ...topology.mutationCaseRefs.map(assertion => [assertion.id, ['mutation', assertion.sourceRef]] as [string, ['mutation', typeof assertion.sourceRef]]),
      ...topology.transcriptAssertionRefs.map(assertion => [assertion.id, ['transcript', assertion.sourceRef]] as [string, ['transcript', typeof assertion.sourceRef]])] : [];
  }) ?? [];
  const assertionsById = new Map(assertionRows);
  const exactKindsAndSources = records.every(record => {
    const expected = assertionsById.get(record[0]);
    return expected?.[0] === record[1]
      && canonicalPreReviewAssertionSourceRef(expected[1]) === record[9];
  });
  const semanticBindings = records.every(record =>
    preReviewCaseSemanticMatches(
      record,
      record[9],
      preReviewCaseRequiresSemanticBinding(record[9], record[1], record[0]),
    ));
  const distinctMutationTargets = new Set(mutations.map(record => `${record[2]}\0${record[3]}`)).size === mutations.length;
  const outcomesBite = records.every(record => record[5] === record[6] && record[7] === true);
  const transcriptEvents = records.filter(record => record[1] === 'transcript').every(record => {
    const producer = record[8].find(event => event[0] === 'producer-evaluated')?.[1];
    const consumer = record[8].find(event => event[0] === 'consumer-verified')?.[1];
    return Number.isInteger(producer) && Number.isInteger(consumer) && (producer as number) < (consumer as number);
  });
  if (!validRecords || !exactIds || !exactKindsAndSources || !semanticBindings || !distinctMutationTargets || !outcomesBite || !transcriptEvents
    || candidate.commandDigests[0] !== digest({ schemaVersion: 'proofstory.pre_review_case_aggregate.v1', storyId: input.storyId, caseRecords: records })) return reject(`proof case records/root invalid shape=${validRecords} ids=${exactIds} semantics=${semanticBindings} distinct=${distinctMutationTargets} outcomes=${outcomesBite} transcript=${transcriptEvents}`);
  const recordById = new Map(records.map(record => [record[0], record]));
  const verifiedBindingProofs = input.contract?.acceptanceBindings.filter(binding => binding.verificationTopology).map(binding => {
    const topology = binding.verificationTopology!;
    return {
      bindingId: binding.id,
      positiveAssertionIds: topology.positiveAssertionRefs.map(item => item.id),
      mutationProofs: topology.mutationCaseRefs.map(item => {
        const record = recordById.get(item.id)!;
        return { mutationId: item.id, expectedCode: record[5], observedCode: record[6], controlRestored: record[7] };
      }),
      transcriptProofs: topology.transcriptAssertionRefs.map(item => {
        const record = recordById.get(item.id)!;
        return {
          transcriptId: item.id,
          producerRefs: [...item.producerRefs], consumerRefs: [...item.consumerRefs],
          producerSequence: record[8].find(event => event[0] === 'producer-evaluated')![1],
          consumerSequence: record[8].find(event => event[0] === 'consumer-verified')![1],
        };
      }),
    };
  }) ?? [];
  const provenance = candidate.provenance;
  if (!preReviewExecutableProvenanceIsCurrent(canonicalGitCwd, provenance)) return reject('proof executable provenance invalid');
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1',
    storyId: input.storyId,
    producer: 'registered-verification-command',
    verifier: 'pre-review-check-command-runner',
    commandDigests: [digest({
      caseAggregateDigest: candidate.commandDigests[0],
      command: transcript.actual.command,
      stdout: transcript.actual.stdout,
      receipt: receipt.integrityHash,
    })],
    caseRecordsEncoding: 'gzip-base64',
    caseRecords: candidate.caseRecords,
    provenance,
    bindingProofs: verifiedBindingProofs,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

const PRE_REVIEW_CODE_PRIORITY: readonly PreReviewCheckCodeV1[] = [
  'PR_ARTIFACT_MISSING',
  'PR_ARTIFACT_TAMPERED',
  'PR_COVERAGE_BASIS_MISSING',
  'PR_NEW_PATH_UNMAPPED',
  'PR_COVERAGE_BASIS_CHANGED',
  'PR_COVERAGE_INCONCLUSIVE',
  'PR_PLANNED_PATH_UNRESOLVED',
  'PR_PLANNED_PATH_RECONCILIATION_TAMPERED',
  'PR_REQUIRED_ADAPTER_RESULT_MISSING',
  'PR_ADAPTER_RESULT_DIGEST_MISMATCH',
  'PR_ADAPTER_RESULT_INVALID',
  'PR_CLOSURE_FILES_CHANGED',
  'PR_POSITIVE_EVIDENCE_MISSING',
  'PR_PRODUCTION_PATH_UNPROVEN',
  'PR_MUTATION_EVIDENCE_MISSING',
  'PR_MUTATION_DID_NOT_BITE',
  'PR_CONTROL_NOT_RESTORED',
  'PR_TRANSCRIPT_MISSING',
  'PR_TRANSCRIPT_UNRELATED',
  'PR_AUTHORITY_INADMISSIBLE',
  'PR_EVIDENCE_STALE',
  'PR_CUTOFF_UNBOUND',
  'PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED',
];

function orderedCodes(codes: readonly PreReviewCheckCodeV1[]): PreReviewCheckCodeV1[] {
  const priority = new Map(PRE_REVIEW_CODE_PRIORITY.map((code, index) => [code, index]));
  return [...new Set(codes)].sort((left, right) =>
    (priority.get(left) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right));
}

function executableProofState(contract: ProofStoryContractData | null, proof: PreReviewExecutableProofV1 | null) {
  const state = { authority: false, positives: false, mutationsPresent: false, mutationsBite: false, controlsRestored: false, transcriptsPresent: false, transcriptsRelated: false };
  if (!contract || !proof || proof.schemaVersion !== 'proofstory.pre_review_executable_proof.v1'
    || proof.storyId !== contract.storyId || proof.producer !== 'registered-verification-command'
    || proof.verifier !== 'pre-review-check-command-runner' || proof.commandDigests.length === 0
    || proof.commandDigests.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) return state;
  const expectedBindings = contract.acceptanceBindings.filter(binding => binding.verificationTopology);
  if (proof.bindingProofs.length !== expectedBindings.length) return state;
  const byBinding = new Map(proof.bindingProofs.map(row => [row.bindingId, row]));
  if (byBinding.size !== proof.bindingProofs.length) return state;
  state.authority = true;
  state.positives = true;
  state.mutationsPresent = true;
  state.mutationsBite = true;
  state.controlsRestored = true;
  state.transcriptsPresent = true;
  state.transcriptsRelated = true;
  for (const binding of expectedBindings) {
    const topology = binding.verificationTopology!;
    const row = byBinding.get(binding.id);
    if (!row) return { ...state, authority: false, positives: false, mutationsPresent: false, mutationsBite: false, controlsRestored: false, transcriptsPresent: false, transcriptsRelated: false };
    if (!sameStrings(row.positiveAssertionIds, topology.positiveAssertionRefs.map(item => item.id))) state.positives = false;
    const mutationIds = row.mutationProofs.map(item => item.mutationId);
    if (!sameStrings(mutationIds, topology.mutationCaseRefs.map(item => item.id)) || new Set(mutationIds).size !== mutationIds.length) state.mutationsPresent = false;
    if (row.mutationProofs.some(item => !item.expectedCode || item.expectedCode !== item.observedCode)) state.mutationsBite = false;
    if (row.mutationProofs.some(item => item.controlRestored !== true)) state.controlsRestored = false;
    const transcriptIds = row.transcriptProofs.map(item => item.transcriptId);
    if (!sameStrings(transcriptIds, topology.transcriptAssertionRefs.map(item => item.id)) || new Set(transcriptIds).size !== transcriptIds.length) state.transcriptsPresent = false;
    for (const assertion of topology.transcriptAssertionRefs) {
      const transcript = row.transcriptProofs.find(item => item.transcriptId === assertion.id);
      if (!transcript || !sameStrings(transcript.producerRefs, assertion.producerRefs)
        || !sameStrings(transcript.consumerRefs, assertion.consumerRefs)
        || !Number.isInteger(transcript.producerSequence) || !Number.isInteger(transcript.consumerSequence)
        || transcript.producerSequence >= transcript.consumerSequence) state.transcriptsRelated = false;
    }
  }
  return state;
}

function remediationFor(codes: readonly PreReviewCheckCodeV1[]): string[] {
  return stable(codes.map(code => code === 'PR_COVERAGE_BASIS_MISSING'
    ? 'Run proof-or-stop acceptance_basis_generate --storyId=<id>, then rerun proof-or-stop pre_review_check --storyId=<id>.'
    : code === 'PR_ARTIFACT_MISSING'
    ? 'Run proof-or-stop pre_review_check --storyId=<id> after recording a current canonical live_smoke_transcript proof.'
    : code === 'PR_ARTIFACT_TAMPERED'
      ? 'Discard the invalid pre-review artifact and reissue it through proof-or-stop pre_review_check; do not edit StoryStore files directly.'
      : code === 'PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED'
        ? 'Obtain a fresh independent topology critic receipt bound to the current pre-review basis, then reissue pre_review_check.'
        : 'Repair the reported PR_* condition, recapture verifier-owned executable proof, and reissue pre_review_check.'));
}

export function issuePreReviewCheckArtifact(input: PreReviewCheckInput): PreReviewCheckArtifactV1 {
  const basis = input.currentArtifact.basis;
  const codes: PreReviewCheckCodeV1[] = [];
  const commandProfile = input.verificationProfile === 'go-command';
  if (!input.planArtifact || basis.priorPlanBasisDigest !== input.planArtifact.basis.basisDigest) codes.push('PR_COVERAGE_BASIS_CHANGED');
  if (!commandProfile && basis.status !== 'complete') codes.push('PR_COVERAGE_INCONCLUSIVE');
  const basisVerification = verifyAcceptanceCoverageBasis(basis);
  for (const diagnostic of basisVerification.diagnostics) {
    const code = diagnostic.code.startsWith('PR_') ? diagnostic.code as PreReviewCheckCodeV1 : 'PR_ADAPTER_RESULT_INVALID';
    codes.push(code);
  }
  if (!commandProfile && basis.plannedActualReconciliations.length !== basis.plannedPathRecords.length) codes.push('PR_PLANNED_PATH_UNRESOLVED');
  if (!commandProfile && input.topologyDiagnosticCodes.some(code => code === 'AT_UNMAPPED_SCOPE_REF')) codes.push('PR_NEW_PATH_UNMAPPED');
  if (!commandProfile && input.topologyDiagnosticCodes.length > 0) codes.push('PR_COVERAGE_BASIS_CHANGED');
  const evidence = evidenceState(input.checklist, input.cutoffAt, basis.binding.storyFilesHash);
  const proof = executableProofState(input.contract, input.executableProof);
  const commandEvidence = commandProfile ? evaluateRegisteredCommandEvidence({
    gitCwd: input.gitCwd,
    metadataRoot: input.metadataRoot,
    storyId: input.storyId,
    checklist: input.checklist,
    cutoffAt: input.cutoffAt,
    freshness: basis.binding,
  }) : null;
  if (commandProfile) {
    codes.push(...(commandEvidence?.codes ?? ['PR_AUTHORITY_INADMISSIBLE']));
    if (evidence.missingIntents.length > 0) codes.push('PR_POSITIVE_EVIDENCE_MISSING');
  } else {
    if (evidence.stale > 0) codes.push('PR_EVIDENCE_STALE');
    if (evidence.afterCutoff > 0) codes.push('PR_CUTOFF_UNBOUND');
    if (evidence.missingIntents.length > 0) codes.push('PR_POSITIVE_EVIDENCE_MISSING');
    if (!proof.positives) codes.push('PR_PRODUCTION_PATH_UNPROVEN');
    if (!proof.mutationsPresent) codes.push('PR_MUTATION_EVIDENCE_MISSING');
    if (!proof.mutationsBite) codes.push('PR_MUTATION_DID_NOT_BITE');
    if (!proof.controlsRestored) codes.push('PR_CONTROL_NOT_RESTORED');
    if (!proof.transcriptsPresent) codes.push('PR_TRANSCRIPT_MISSING');
    else if (!proof.transcriptsRelated) codes.push('PR_TRANSCRIPT_UNRELATED');
    if (!proof.authority) codes.push('PR_AUTHORITY_INADMISSIBLE');
    if (input.mode === 'enforce' && !input.criticVerification?.ok) codes.push('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED');
  }
  const emittedCodes = orderedCodes(codes);
  const status = emittedCodes.length === 0 ? 'pass' : commandProfile || basis.status === 'complete' ? 'fail' : 'inconclusive';
  const key = privateKey(input.gitCwd);
  const signerPublicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(key)));
  const unsigned: Omit<PreReviewCheckArtifactV1, 'signature'> = {
    schemaVersion: 'proofstory.pre_review_check.v1',
    storyId: input.storyId,
    mode: input.mode,
    ...(commandProfile ? { verificationProfile: 'go-command' as const } : {}),
    cutoffAt: input.cutoffAt,
    planBasisDigest: input.planArtifact?.basis.basisDigest ?? '<missing>',
    preReviewBasisArtifact: input.currentArtifact,
    topologyDigest: input.topologyDigest,
    scopeCheckDigest: basis.binding.scopeCheckDigest,
    ...(basis.binding.scopeContractDigest ? { scopeContractDigest: basis.binding.scopeContractDigest } : {}),
    storyFilesHash: basis.binding.storyFilesHash,
    closureFilesHash: basis.binding.closureFilesHash,
    evidenceRefs: commandEvidence?.evidenceRefs ?? evidence.evidenceRefs,
    executableProof: input.executableProof ?? {
      schemaVersion: 'proofstory.pre_review_executable_proof.v1', storyId: input.storyId,
      producer: 'registered-verification-command', verifier: 'pre-review-check-command-runner', commandDigests: [], caseRecordsEncoding: 'gzip-base64', caseRecords: '',
      provenance: { runnerPath: '', runnerDigest: '', targetPath: '', targetDigest: '', buildCommand: '' }, bindingProofs: [],
    },
    ...(input.criticReceiptDigest ? { criticReceiptDigest: input.criticReceiptDigest } : {}),
    codes: emittedCodes,
    status,
    issuedAt: input.cutoffAt,
    signerPublicKey,
  };
  return { ...unsigned, signature: signCanonical(unsigned, key) };
}

export function verifyPreReviewCheckArtifact(input: PreReviewCheckInput & { artifact: PreReviewCheckArtifactV1 | null }): PreReviewCheckReport {
  const artifact = input.artifact;
  const verificationProfile = input.verificationProfile ?? 'unsupported';
  const commandProfile = verificationProfile === 'go-command';
  if (!artifact) return {
    storyId: input.storyId, mode: input.mode, readOnly: true, verificationProfile, status: 'fail', ok: false, blocking: input.mode === 'enforce',
    codes: ['PR_ARTIFACT_MISSING'], plannedActual: 'incomplete', executableEvidence: 'missing',
    mutations: commandProfile ? 'not_required' : 'missing', transcript: commandProfile ? 'not_required' : 'missing', authority: 'inadmissible',
    criticReattestation: commandProfile || input.mode !== 'enforce' ? 'not_required' : 'missing', remediation: remediationFor(['PR_ARTIFACT_MISSING']), artifact: null,
  };
  // Metadata auto-commit advances HEAD after the producer writes the artifact.
  // Re-evaluate semantic evidence against the signed basis while the canonical
  // receipt freshness reader below independently rejects material/story/closure
  // drift; do not silently rebind the stored artifact to the later HEAD.
  const expectedInput: PreReviewCheckInput = {
    ...input,
    currentArtifact: artifact.preReviewBasisArtifact,
    executableProof: artifact.executableProof,
    criticReceiptDigest: criticReceiptDigestForPreReviewSemanticComparison(
      input.mode,
      input.criticReceiptDigest,
      artifact.criticReceiptDigest,
    ),
  };
  const expected = issuePreReviewCheckArtifact(expectedInput);
  const codes: PreReviewCheckCodeV1[] = [...expected.codes];
  const executableProvenanceCurrent = commandProfile
    ? true
    : preReviewExecutableProvenanceIsCurrent(realpathSync(input.gitCwd), artifact.executableProof?.provenance);
  if (!commandProfile && !executableProvenanceCurrent) codes.push('PR_AUTHORITY_INADMISSIBLE');
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
    // A partial/unsupported basis is a valid signed diagnostic artifact. The
    // receipt verifier includes the basis's own semantic diagnostics in its
    // `ok` result, so `!receipt.ok` alone does not mean bytes or bindings were
    // tampered. Ignore only diagnostics already inherent in the signed basis;
    // signature, key, workspace freshness, expected binding, and receipt/basis
    // mismatch diagnostics remain integrity failures and fail closed.
    const signedBasisDiagnostics = new Set(
      verifyAcceptanceCoverageBasis(artifact.preReviewBasisArtifact.basis).diagnostics
        .map(item => `${item.code}: ${item.message}`),
    );
    const receiptIntegrityFailed = receipt.diagnostics.some(
      diagnostic => !signedBasisDiagnostics.has(diagnostic),
    );
    if (receiptIntegrityFailed || artifact.storyId !== input.storyId) codes.push('PR_ARTIFACT_TAMPERED');
  }
  const ordered = orderedCodes(codes);
  const ok = ordered.length === 0 && artifact?.status === 'pass';
  const proof = executableProofState(input.contract, artifact.executableProof);
  const commandEvidence = commandProfile ? evaluateRegisteredCommandEvidence({
    gitCwd: input.gitCwd,
    metadataRoot: input.metadataRoot,
    storyId: input.storyId,
    checklist: input.checklist,
    cutoffAt: input.cutoffAt,
    freshness: artifact.preReviewBasisArtifact.basis.binding,
  }) : null;
  return {
    storyId: input.storyId, mode: input.mode, readOnly: true, verificationProfile,
    status: ok ? 'pass' : commandProfile || input.currentArtifact.basis.status === 'complete' ? 'fail' : 'inconclusive',
    ok, blocking: input.mode === 'enforce' && !ok, codes: ordered,
    plannedActual: commandProfile || input.currentArtifact.basis.plannedActualReconciliations.length === input.currentArtifact.basis.plannedPathRecords.length ? 'complete' : 'incomplete',
    executableEvidence: commandProfile ? commandEvidence?.ok ? 'current' : 'missing' : proof.positives ? 'current' : 'missing',
    mutations: commandProfile ? 'not_required' : proof.mutationsBite && proof.controlsRestored ? 'biting' : 'missing',
    transcript: commandProfile ? 'not_required' : proof.transcriptsPresent && proof.transcriptsRelated ? 'related' : 'missing',
    authority: commandProfile ? commandEvidence?.ok ? 'admissible' : 'inadmissible' : proof.authority && executableProvenanceCurrent ? 'admissible' : 'inadmissible',
    criticReattestation: commandProfile || input.mode !== 'enforce' ? 'not_required' : input.criticVerification?.ok ? 'current' : 'missing', artifact,
    remediation: remediationFor(ordered),
  };
}
