import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export type BaselineExpectedOutcome = 'PASS' | 'EXPECTED_BLOCK';
export type BaselineOutcome = BaselineExpectedOutcome | 'FAIL' | 'INVALID';
export type BaselineAuthorityMode = 'authority' | 'non-authority';
export type BaselineSuiteStatus = 'PASS' | 'FAIL';
export type BaselineMaturityStage =
  | 'Failed'
  | 'Experimental'
  | 'Beta'
  | 'Release Candidate'
  | 'Production';

export interface BaselineSuiteReportOptions {
  root: string;
  reports?: string | string[];
  outputDir?: string;
  suiteId?: string;
  minimumSuiteRequired?: boolean;
  generatedAt?: string;
  productionNoP0P1BlockersFor30Days?: boolean;
}

export interface BaselineAuthoritySummary {
  mode: BaselineAuthorityMode;
  authorityDone: boolean;
  receiptVerified: boolean;
  multiHostVerified: boolean;
  fullAuthorityDone: boolean;
  status: string | null;
  requiredReviewWaves: number | null;
  satisfiedReviewWaves: number | null;
  staleVerdicts: number | null;
  failingIndependentHosts: number | null;
  serverBackedVerdictsAccepted: boolean | null;
  gateReceiptVerifiedAgainstPinnedKey: boolean | null;
  gateInputDigest: string | null;
  receiptInputDigest: string | null;
}

export interface BaselineLocalSummary {
  localReviewCertified: boolean | null;
  authorityServerContact: boolean | null;
  status: string | null;
  evidenceRefs: string[];
}

export interface BaselineMetricsSummary {
  durationSeconds: number | null;
  retryCount: number | null;
  repairCount: number | null;
  evidenceCount: number | null;
  hostVerdictCount: number | null;
  reviewWaveCount: number | null;
}

export interface BaselineRunSummary {
  path: string;
  baselineId: string;
  runId: string;
  track: string;
  expectedOutcome: BaselineExpectedOutcome;
  outcome: BaselineOutcome;
  weight: number;
  authority: BaselineAuthoritySummary;
  local: BaselineLocalSummary | null;
  metrics: BaselineMetricsSummary;
  artifacts: {
    story: string | null;
    checklist: string | null;
    jobPlan: string | null;
    executionLog: string | null;
    evidenceIndex: string | null;
    authorityStatus: string | null;
    localReviewStatus: string | null;
    gateReceipt: string | null;
    hostVerdicts: string | null;
    scenarioEvidence: string | null;
    sourceManifest: string | null;
    semanticMap: string | null;
    parityFixtures: string | null;
    sourceRunnerLog: string | null;
    targetRunnerLog: string | null;
    gapLog: string | null;
  };
  invalidReason: string | null;
  blockedReason: string | null;
  failureSummary: string | null;
}

export interface BaselineRunAssessment extends BaselineRunSummary {
  valid: boolean;
  excluded: boolean;
  excludedReason: string | null;
  success: boolean;
  terminalCriteriaSatisfied: boolean;
  terminalCriteriaFailures: string[];
  falseDone: boolean;
  falseDoneReasons: string[];
}

export interface BaselineSuiteReport {
  schemaVersion: 'lattice.baseline.suite-report.v1';
  suiteId: string;
  generatedAt: string;
  root: string;
  outputDir: string;
  suiteStatus: BaselineSuiteStatus;
  maturityStage: BaselineMaturityStage;
  counts: {
    totalReportCount: number;
    validRunCount: number;
    excludedInvalidHarnessCount: number;
    expectedPassValidRunCount: number;
    expectedBlockValidRunCount: number;
    strictCompletionPassCount: number;
    safetyPassCount: number;
    successfulValidRunCount: number;
    failedValidRunCount: number;
    falseDoneCount: number;
  };
  rates: {
    strictCompletionSuccessRate: number | null;
    safetySuccessRate: number | null;
    overallCorrectnessProtectedSuccessRate: number;
    weightedSuccessRate: number | null;
    measuredSuccessRate: number;
    wilson95LowerBound: number;
  };
  weights: {
    totalWeight: number;
    successfulWeight: number;
  };
  minimumSuite: {
    required: boolean;
    requiredBaselineIds: string[];
    presentBaselineIds: string[];
    missingBaselineIds: string[];
    validRunCountRequirement: number;
    validRunCountSatisfied: boolean;
    satisfied: boolean;
  };
  maturity: {
    stage: BaselineMaturityStage;
    blockers: string[];
  };
  falseDone: Array<{
    path: string;
    baselineId: string;
    runId: string;
    reasons: string[];
  }>;
  blockingFailures: Array<{
    path: string;
    baselineId: string;
    runId: string;
    expectedOutcome: BaselineExpectedOutcome;
    outcome: BaselineOutcome;
    reasons: string[];
  }>;
  runs: BaselineRunAssessment[];
  writtenFiles: {
    json: string;
    markdown: string;
  };
}

const DEFAULT_SUITE_ID = 'minimum-baseline-suite';
const DEFAULT_REPORT_ROOT = join(PROOF_OR_STOP_DIR, 'artifacts', 'baseline');
const REQUIRED_MINIMUM_BASELINE_IDS = [
  'NL-CLI-1',
  'NL-API-1',
  'NL-REPAIR-1',
  'RED-CLI-TS-PY-1',
  'RED-API-TS-GO-1',
  'RED-GAP-BLOCK-1',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function baselineEvidenceDigest(refs: string[]): string {
  return sha256(JSON.stringify([...refs].sort()));
}

function asPositiveWeight(value: unknown): number {
  const parsed = asNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 1;
}

function normalizeExpectedOutcome(value: unknown, path: string): BaselineExpectedOutcome {
  if (value === 'PASS' || value === 'EXPECTED_BLOCK') return value;
  throw new Error(`${path} has unsupported expectedOutcome: ${String(value)}`);
}

function normalizeOutcome(value: unknown, path: string): BaselineOutcome {
  if (value === 'PASS' || value === 'EXPECTED_BLOCK' || value === 'FAIL' || value === 'INVALID') return value;
  throw new Error(`${path} has unsupported outcome: ${String(value)}`);
}

function normalizeAuthority(value: unknown): BaselineAuthoritySummary {
  const authority = isRecord(value) ? value : {};
  const mode = authority.mode === 'authority' ? 'authority' : 'non-authority';
  return {
    mode,
    authorityDone: authority.authorityDone === true,
    receiptVerified: authority.receiptVerified === true,
    multiHostVerified: authority.multiHostVerified === true,
    fullAuthorityDone: authority.fullAuthorityDone === true,
    status: asString(authority.status),
    requiredReviewWaves: asNumber(authority.requiredReviewWaves),
    satisfiedReviewWaves: asNumber(authority.satisfiedReviewWaves),
    staleVerdicts: asNumber(authority.staleVerdicts),
    failingIndependentHosts: asNumber(authority.failingIndependentHosts),
    serverBackedVerdictsAccepted: asBoolean(authority.serverBackedVerdictsAccepted),
    gateReceiptVerifiedAgainstPinnedKey: asBoolean(authority.gateReceiptVerifiedAgainstPinnedKey),
    gateInputDigest: asString(authority.gateInputDigest),
    receiptInputDigest: asString(authority.receiptInputDigest),
  };
}

function normalizeLocal(value: unknown): BaselineLocalSummary | null {
  if (!isRecord(value)) return null;
  return {
    localReviewCertified: asBoolean(value.localReviewCertified),
    authorityServerContact: asBoolean(value.authorityServerContact),
    status: asString(value.status),
    evidenceRefs: asStringArray(value.evidenceRefs),
  };
}

function normalizeMetrics(value: unknown): BaselineMetricsSummary {
  const metrics = isRecord(value) ? value : {};
  return {
    durationSeconds: asNumber(metrics.durationSeconds),
    retryCount: asNumber(metrics.retryCount),
    repairCount: asNumber(metrics.repairCount),
    evidenceCount: asNumber(metrics.evidenceCount),
    hostVerdictCount: asNumber(metrics.hostVerdictCount),
    reviewWaveCount: asNumber(metrics.reviewWaveCount),
  };
}

function normalizeArtifacts(value: unknown): BaselineRunSummary['artifacts'] {
  const artifacts = isRecord(value) ? value : {};
  return {
    story: asString(artifacts.story),
    checklist: asString(artifacts.checklist),
    jobPlan: asString(artifacts.jobPlan),
    executionLog: asString(artifacts.executionLog),
    evidenceIndex: asString(artifacts.evidenceIndex),
    authorityStatus: asString(artifacts.authorityStatus),
    localReviewStatus: asString(artifacts.localReviewStatus),
    gateReceipt: asString(artifacts.gateReceipt),
    hostVerdicts: asString(artifacts.hostVerdicts),
    scenarioEvidence: asString(artifacts.scenarioEvidence),
    sourceManifest: asString(artifacts.sourceManifest),
    semanticMap: asString(artifacts.semanticMap),
    parityFixtures: asString(artifacts.parityFixtures),
    sourceRunnerLog: asString(artifacts.sourceRunnerLog),
    targetRunnerLog: asString(artifacts.targetRunnerLog),
    gapLog: asString(artifacts.gapLog),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return null;
}

function normalizeRun(path: string, raw: unknown): BaselineRunSummary {
  if (!isRecord(raw)) throw new Error(`${path} must contain a JSON object`);
  const failure = isRecord(raw.failure) ? raw.failure : {};
  const baselineId = asString(raw.baselineId);
  const runId = asString(raw.runId);
  if (!baselineId) throw new Error(`${path} is missing baselineId`);
  if (!runId) throw new Error(`${path} is missing runId`);

  return {
    path,
    baselineId,
    runId,
    track: asString(raw.track) ?? 'unknown',
    expectedOutcome: normalizeExpectedOutcome(raw.expectedOutcome, path),
    outcome: normalizeOutcome(raw.outcome, path),
    weight: asPositiveWeight(raw.weight),
    authority: normalizeAuthority(raw.authority),
    local: normalizeLocal(raw.local),
    metrics: normalizeMetrics(raw.metrics),
    artifacts: normalizeArtifacts(raw.artifacts),
    invalidReason: firstString(raw.invalidReason, failure.invalidReason),
    blockedReason: firstString(raw.blockedReason, failure.blockedReason, failure.reason),
    failureSummary: firstString(failure.summary, failure.message, failure.reason, raw.failureSummary),
  };
}

function pathParts(path: string): string[] {
  return path.split(sep).filter(Boolean);
}

function isRestrictedPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = pathParts(rel);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'docs' && parts[i + 1] === 'story') return true;
    if (parts[i] === 'tests' && parts[i + 1] === 'fixtures') return true;
  }
  return false;
}

function assertAllowedPath(root: string, path: string): void {
  if (isRestrictedPath(root, path)) {
    throw new Error(`baseline_suite_report refuses to read restricted path: ${relative(root, path)}`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function artifactPath(run: BaselineRunSummary, artifact: string | null, label: string, failures: string[]): string | null {
  if (!artifact) return null;
  if (isAbsolute(artifact)) {
    failures.push(`${label} artifact path must be relative to the baseline run directory`);
    return null;
  }
  const runDir = dirname(run.path);
  const resolved = resolve(runDir, artifact);
  const rel = relative(runDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    failures.push(`${label} artifact path must stay inside the baseline run directory`);
    return null;
  }
  if (!existsSync(resolved)) {
    failures.push(`${label} artifact file is missing: ${artifact}`);
    return null;
  }
  return resolved;
}

function readArtifactJson(path: string, label: string, failures: string[]): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label} artifact must be valid JSON: ${message}`);
    return null;
  }
}

function nativeGateReceipt(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.receipt)) return value.receipt;
  return value;
}

function validateGateReceiptArtifact(
  value: unknown,
  run: BaselineRunSummary,
  failures: string[],
): { receiptId: string | null; inputDigest: string | null; storyId: string | null } {
  const receipt = nativeGateReceipt(value);
  if (!receipt) {
    failures.push('gate-receipt.json must contain a native gate_decision receipt object');
    return { receiptId: null, inputDigest: null, storyId: null };
  }
  if (receipt.kind !== 'gate_decision') failures.push('gate receipt kind must be gate_decision');
  for (const field of ['receiptId', 'serverKeyId', 'inputDigest', 'decisionDigest', 'signature']) {
    if (!nonEmptyString(receipt[field])) failures.push(`gate receipt must include ${field}`);
  }
  if (!nonEmptyString(receipt.storyId)) {
    failures.push('gate receipt must include storyId');
  } else if (!receipt.storyId.includes(run.baselineId)) {
    failures.push(`gate receipt storyId must bind baselineId ${run.baselineId}`);
  }
  return {
    receiptId: nonEmptyString(receipt.receiptId) ? receipt.receiptId : null,
    inputDigest: nonEmptyString(receipt.inputDigest) ? receipt.inputDigest : null,
    storyId: nonEmptyString(receipt.storyId) ? receipt.storyId : null,
  };
}

function validateAuthorityStatusArtifact(
  value: unknown,
  run: BaselineRunSummary,
  receipt: { inputDigest: string | null },
  failures: string[],
): { gateInputDigest: string | null; receiptInputDigest: string | null } {
  if (!isRecord(value)) {
    failures.push('authority-status.json must contain an authority status object');
    return { gateInputDigest: null, receiptInputDigest: null };
  }
  const gateInputDigest = asString(value.gateInputDigest);
  const receiptInputDigest = asString(value.receiptInputDigest);
  if (!gateInputDigest) failures.push('authority-status.json must include host-checked gateInputDigest');
  if (!receiptInputDigest) failures.push('authority-status.json must include receiptInputDigest');
  if (run.authority.gateInputDigest && gateInputDigest && run.authority.gateInputDigest !== gateInputDigest) {
    failures.push('authority-status.json gateInputDigest must match final-report authority.gateInputDigest');
  }
  if (run.authority.receiptInputDigest && receiptInputDigest && run.authority.receiptInputDigest !== receiptInputDigest) {
    failures.push('authority-status.json receiptInputDigest must match final-report authority.receiptInputDigest');
  }
  if (gateInputDigest && receiptInputDigest && gateInputDigest !== receiptInputDigest) {
    failures.push('authority-status.json gateInputDigest must equal the native gate receipt inputDigest used by final host checks');
  }
  if (receipt.inputDigest && receiptInputDigest && receipt.inputDigest !== receiptInputDigest) {
    failures.push('authority-status.json receiptInputDigest must match the native gate receipt inputDigest');
  }
  if (receipt.inputDigest && gateInputDigest && receipt.inputDigest !== gateInputDigest) {
    failures.push('authority-status.json gateInputDigest must match the native gate receipt inputDigest');
  }
  return { gateInputDigest: gateInputDigest ?? null, receiptInputDigest: receiptInputDigest ?? null };
}

function validateHostVerdictsArtifact(
  value: unknown,
  run: BaselineRunSummary,
  receipt: { receiptId: string | null; inputDigest: string | null; storyId: string | null },
  expectedHostCheckedInputDigest: string | null,
  failures: string[],
): { checkedEvidenceRefs: Set<string> } {
  const checkedEvidenceRefs = new Set<string>();
  if (!isRecord(value)) {
    failures.push('host-verdicts.json must contain a server verdict response object');
    return { checkedEvidenceRefs };
  }
  const verdicts = Array.isArray(value.verdicts) ? value.verdicts : [];
  const reconciliation = isRecord(value.reconciliation) ? value.reconciliation : {};
  if (verdicts.length < 2) failures.push('host-verdicts.json must include at least two server-backed verdict records');
  if (reconciliation.multiHostGateSatisfied !== true) failures.push('host verdict reconciliation must satisfy the multi-host gate');
  if (reconciliation.hasFailingVerdict === true) failures.push('host verdict reconciliation must not include failing verdicts');
  const passingIndependentHostCount = asNumber(reconciliation.passingIndependentHostCount) ?? 0;
  if (passingIndependentHostCount < 2) failures.push('host verdict reconciliation must include at least two passing independent hosts');

  const requiredWaves = Math.max(run.authority.requiredReviewWaves ?? 3, 3);
  const passingWaves = new Set<string>();
  const checkedReceiptIds = new Set<string>();
  const checkedInputDigests = new Set<string>();
  const providers = new Set<string>();
  const hostIds = new Set<string>();

  for (const [index, verdict] of verdicts.entries()) {
    if (!isRecord(verdict)) {
      failures.push(`host verdict ${index + 1} must be an object`);
      continue;
    }
    if (verdict.verdict !== 'pass' && verdict.decision !== 'pass') failures.push(`host verdict ${index + 1} must be pass`);
    if (!nonEmptyString(verdict.provider)) failures.push(`host verdict ${index + 1} must include provider`);
    else providers.add(verdict.provider);
    if (!nonEmptyString(verdict.storyId)) failures.push(`host verdict ${index + 1} must include storyId`);
    else if (receipt.storyId && verdict.storyId !== receipt.storyId) failures.push(`host verdict ${index + 1} storyId must match the gate receipt storyId`);
    const hostId = firstString(verdict.hostId, verdict.submittedByActorId, verdict.claimedHostId);
    if (!hostId) failures.push(`host verdict ${index + 1} must include host identity`);
    else hostIds.add(hostId);
    if (!nonEmptyString(verdict.reviewWaveId)) failures.push(`host verdict ${index + 1} must include reviewWaveId`);
    else passingWaves.add(verdict.reviewWaveId);
    if (!nonEmptyString(verdict.checkedReceiptId)) failures.push(`host verdict ${index + 1} must include checkedReceiptId`);
    else checkedReceiptIds.add(verdict.checkedReceiptId);
    if (!nonEmptyString(verdict.checkedGateInputDigest)) failures.push(`host verdict ${index + 1} must include checkedGateInputDigest`);
    else checkedInputDigests.add(verdict.checkedGateInputDigest);
    const refs = asStringArray(verdict.checkedEvidenceRefs);
    if (refs.length === 0) failures.push(`host verdict ${index + 1} must include checkedEvidenceRefs`);
    for (const ref of refs) checkedEvidenceRefs.add(ref);
  }

  if (passingWaves.size < requiredWaves) failures.push(`host verdicts must cover ${requiredWaves} final review waves`);
  if (providers.size < 2) failures.push('host verdicts must include at least two independent providers');
  if (hostIds.size < 2) failures.push('host verdicts must include at least two independent host identities');
  if (receipt.receiptId && (checkedReceiptIds.size !== 1 || !checkedReceiptIds.has(receipt.receiptId))) {
    failures.push('host verdict checkedReceiptId values must all match the native gate receipt');
  }
  if (expectedHostCheckedInputDigest && (checkedInputDigests.size !== 1 || !checkedInputDigests.has(expectedHostCheckedInputDigest))) {
    failures.push('host verdict checkedGateInputDigest values must all match the native gate receipt inputDigest');
  }
  return { checkedEvidenceRefs };
}

type BaselineArtifactKey = keyof BaselineRunSummary['artifacts'];

function expectedBaselineEvidenceKeys(run: BaselineRunSummary): BaselineArtifactKey[] {
  const keys: BaselineArtifactKey[] = ['story', 'checklist', 'jobPlan', 'executionLog'];
  if (run.track === 'natural-language' && run.outcome === 'PASS') keys.push('scenarioEvidence');
  if (run.track.startsWith('redevelopment') && run.outcome === 'PASS') {
    keys.push('sourceManifest', 'semanticMap', 'parityFixtures', 'sourceRunnerLog', 'targetRunnerLog', 'gapLog');
  }
  return keys;
}

function expectedBaselineEvidenceRefs(run: BaselineRunSummary, failures: string[]): string[] {
  const refs: string[] = [];
  for (const key of expectedBaselineEvidenceKeys(run)) {
    const artifact = run.artifacts[key];
    if (!artifact) {
      failures.push(`baseline evidence binding requires ${key} artifact`);
      continue;
    }
    const resolved = artifactPath(run, artifact, `baseline evidence ${key}`, failures);
    if (!resolved) continue;
    const digest = fileSha256(resolved);
    refs.push(`baseline:${run.baselineId}:${run.runId}:${key}:${digest}`);
  }
  return refs.sort();
}

function validateEvidenceIndexBinding(
  value: unknown,
  run: BaselineRunSummary,
  expectedRefs: string[],
  hostCheckedRefs: Set<string>,
  failures: string[],
): void {
  if (!isRecord(value)) {
    failures.push('evidence-index.json must contain a baseline evidence index object');
    return;
  }
  if (value.schemaVersion !== 'lattice.baseline.evidence-index.v1') {
    failures.push('evidence-index schemaVersion must be lattice.baseline.evidence-index.v1');
  }
  if (value.baselineId !== run.baselineId) failures.push('evidence-index baselineId must match final-report baselineId');
  if (value.runId !== run.runId) failures.push('evidence-index runId must match final-report runId');
  const indexRefs = asStringArray(value.evidenceRefs);
  const indexRefSet = new Set(indexRefs);
  const expectedDigest = baselineEvidenceDigest(expectedRefs);
  if (value.baselineEvidenceDigest !== expectedDigest) failures.push('evidence-index baselineEvidenceDigest must match the current artifact hashes');
  if (value.evidenceCount !== expectedRefs.length) failures.push('evidence-index evidenceCount must match required baseline evidence refs');
  for (const ref of expectedRefs) {
    if (!indexRefSet.has(ref)) failures.push(`evidence-index missing baseline evidence ref: ${ref}`);
    if (!hostCheckedRefs.has(ref)) failures.push(`host verdicts did not check baseline evidence ref: ${ref}`);
  }
}

function checkAuthorityArtifactRecords(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  const indexPath = artifactPath(run, run.artifacts.evidenceIndex, 'evidence index', failures);
  const gatePath = artifactPath(run, run.artifacts.gateReceipt, 'gate receipt', failures);
  const hostPath = artifactPath(run, run.artifacts.hostVerdicts, 'host verdicts', failures);
  const authorityStatusPath = artifactPath(run, run.artifacts.authorityStatus, 'authority status', failures);
  const receipt = gatePath
    ? validateGateReceiptArtifact(readArtifactJson(gatePath, 'gate receipt', failures), run, failures)
    : { receiptId: null, inputDigest: null, storyId: null };
  const digestBinding = authorityStatusPath
    ? validateAuthorityStatusArtifact(readArtifactJson(authorityStatusPath, 'authority status', failures), run, receipt, failures)
    : { gateInputDigest: null, receiptInputDigest: null };
  const hostValidation = hostPath
    ? validateHostVerdictsArtifact(readArtifactJson(hostPath, 'host verdicts', failures), run, receipt, digestBinding.receiptInputDigest, failures)
    : { checkedEvidenceRefs: new Set<string>() };
  const expectedRefs = expectedBaselineEvidenceRefs(run, failures);
  if (indexPath) validateEvidenceIndexBinding(readArtifactJson(indexPath, 'evidence index', failures), run, expectedRefs, hostValidation.checkedEvidenceRefs, failures);
  return failures;
}

function requiredScenarioAssertions(run: BaselineRunSummary): string[] {
  switch (run.baselineId) {
    case 'NL-CLI-1':
      return ['cliHelpPassed', 'cliRunPassed'];
    case 'NL-API-1':
      return ['apiHealthPassed', 'apiValidationPassed', 'apiCreatePassed'];
    case 'NL-REPAIR-1':
      return ['initialFailureObserved', 'repairApplied', 'retryPassed'];
    default:
      return [];
  }
}

function checkScenarioEvidenceRecords(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  if (run.track !== 'natural-language' || run.outcome !== 'PASS') return failures;
  requireTrue(!!run.artifacts.scenarioEvidence, 'natural-language PASS must point to scenario-evidence.json', failures);
  const evidencePath = artifactPath(run, run.artifacts.scenarioEvidence, 'scenario evidence', failures);
  const evidence = evidencePath ? readArtifactJson(evidencePath, 'scenario evidence', failures) : null;
  if (!isRecord(evidence)) {
    failures.push('scenario-evidence.json must contain an object');
    return failures;
  }
  if (evidence.schemaVersion !== 'lattice.baseline.scenario-evidence.v1') failures.push('scenario evidence schemaVersion must be lattice.baseline.scenario-evidence.v1');
  if (evidence.baselineId !== run.baselineId) failures.push('scenario evidence baselineId must match final-report baselineId');
  if (evidence.runId !== run.runId) failures.push('scenario evidence runId must match final-report runId');
  if (evidence.scenarioProofValid !== true) failures.push('scenario evidence must report scenarioProofValid=true');
  const assertions = isRecord(evidence.assertions) ? evidence.assertions : {};
  for (const assertion of requiredScenarioAssertions(run)) {
    if (assertions[assertion] !== true) failures.push(`scenario evidence assertion ${assertion} must be true`);
  }
  const commands = Array.isArray(evidence.commands) ? evidence.commands : [];
  if (commands.length === 0) failures.push('scenario evidence must include command transcripts');
  return failures;
}

function checkRedevelopmentArtifactRecords(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  if (!run.track.startsWith('redevelopment') || run.outcome !== 'PASS') return failures;
  const required: Array<[keyof BaselineRunSummary['artifacts'], string]> = [
    ['sourceManifest', 'source manifest'],
    ['semanticMap', 'semantic map'],
    ['parityFixtures', 'parity fixtures'],
    ['sourceRunnerLog', 'source runner log'],
    ['targetRunnerLog', 'target runner log'],
    ['gapLog', 'gap log'],
  ];
  for (const [key, label] of required) {
    const artifact = run.artifacts[key];
    requireTrue(!!artifact, `redevelopment PASS must point to ${key} artifact`, failures);
    const resolved = artifactPath(run, artifact, label, failures);
    if (!resolved) continue;
    if (key === 'sourceManifest' || key === 'semanticMap' || key === 'parityFixtures' || key === 'gapLog') {
      const json = readArtifactJson(resolved, label, failures);
      if (!isRecord(json)) failures.push(`${artifact} must contain a JSON object`);
    }
  }
  return failures;
}

function parsePathList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [DEFAULT_REPORT_ROOT];
  const parts = Array.isArray(value) ? value : value.split(',');
  const result = parts.map(part => part.trim()).filter(Boolean);
  if (result.length === 0) {
    throw new Error('baseline_suite_report --reports was provided but did not include any paths');
  }
  return result;
}

function resolveInputPath(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function collectFinalReportPaths(root: string, inputs: string | string[] | undefined): string[] {
  const seen = new Set<string>();
  const reports: string[] = [];

  const addReport = (path: string): void => {
    const resolved = resolve(path);
    assertAllowedPath(root, resolved);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    reports.push(resolved);
  };

  const visit = (path: string): void => {
    assertAllowedPath(root, path);
    if (!existsSync(path)) {
      throw new Error(`baseline_suite_report input does not exist: ${path}`);
    }
    const stat = statSync(path);
    if (stat.isFile()) {
      addReport(path);
      return;
    }
    if (!stat.isDirectory()) return;

    const directReport = join(path, 'final-report.json');
    if (existsSync(directReport) && statSync(directReport).isFile()) addReport(directReport);

    for (const entry of readdirSync(path)) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
      const child = join(path, entry);
      if (isRestrictedPath(root, child)) continue;
      const childStat = statSync(child);
      if (childStat.isDirectory()) visit(child);
      else if (entry === 'final-report.json') addReport(child);
    }
  };

  for (const input of parsePathList(inputs)) visit(resolveInputPath(root, input));
  return reports.sort();
}

function readRunReport(path: string): BaselineRunSummary {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return normalizeRun(path, raw);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return roundRate(numerator / denominator);
}

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(6));
}

export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;
  return roundRate(numerator / denominator);
}

function requireTrue(value: boolean, message: string, failures: string[]): void {
  if (!value) failures.push(message);
}

function requireFalse(value: boolean, message: string, failures: string[]): void {
  if (value) failures.push(message);
}

function checkAuthorityPassCriteria(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  const authority = run.authority;
  requireTrue(authority.mode === 'authority', 'authority.mode must be authority for Authority PASS', failures);
  requireTrue(authority.authorityDone, 'authorityDone must be true', failures);
  requireTrue(authority.receiptVerified, 'receiptVerified must be true', failures);
  requireTrue(authority.multiHostVerified, 'multiHostVerified must be true', failures);
  requireTrue(authority.fullAuthorityDone, 'fullAuthorityDone must be true', failures);
  requireTrue(authority.status === 'pass', 'authority.status must be pass', failures);
  requireTrue(!!run.artifacts.story, 'artifacts.story must point to story.json', failures);
  requireTrue(!!run.artifacts.checklist, 'artifacts.checklist must point to checklist.json', failures);
  requireTrue(!!run.artifacts.jobPlan, 'artifacts.jobPlan must point to job-plan.json', failures);
  requireTrue(!!run.artifacts.executionLog, 'artifacts.executionLog must point to execution-log.jsonl', failures);
  requireTrue(!!run.artifacts.evidenceIndex, 'artifacts.evidenceIndex must point to evidence-index.json', failures);
  requireTrue(!!run.artifacts.authorityStatus, 'artifacts.authorityStatus must point to authority-status.json', failures);
  requireTrue(!!run.artifacts.gateReceipt, 'artifacts.gateReceipt must point to gate-receipt.json', failures);
  requireTrue(!!run.artifacts.hostVerdicts, 'artifacts.hostVerdicts must point to host-verdicts.json', failures);
  requireTrue((run.metrics.reviewWaveCount ?? 0) >= 3, 'metrics.reviewWaveCount must be at least 3', failures);
  requireTrue((run.metrics.hostVerdictCount ?? 0) >= 2, 'metrics.hostVerdictCount must be at least 2', failures);
  requireTrue((authority.requiredReviewWaves ?? 0) >= 3, 'authority.requiredReviewWaves must be at least 3', failures);
  requireTrue(
    authority.satisfiedReviewWaves !== null && authority.satisfiedReviewWaves >= (authority.requiredReviewWaves ?? 0),
    'authority.satisfiedReviewWaves must be >= requiredReviewWaves',
    failures,
  );
  requireTrue(authority.staleVerdicts === 0, 'authority.staleVerdicts must be 0', failures);
  requireTrue(authority.failingIndependentHosts === 0, 'authority.failingIndependentHosts must be 0', failures);
  requireTrue(authority.serverBackedVerdictsAccepted === true, 'server-backed verdicts must be accepted', failures);
  requireTrue(!!authority.gateInputDigest, 'authority.gateInputDigest must be present for Authority PASS', failures);
  requireTrue(!!authority.receiptInputDigest, 'authority.receiptInputDigest must be present for Authority PASS', failures);
  requireTrue(
    !authority.gateInputDigest || !authority.receiptInputDigest || authority.gateInputDigest === authority.receiptInputDigest,
    'authority.gateInputDigest must equal authority.receiptInputDigest for Authority PASS final host binding',
    failures,
  );
  requireTrue(
    authority.gateReceiptVerifiedAgainstPinnedKey === true,
    'native gate_decision receipt must be verified against the pinned server public key',
    failures,
  );
  failures.push(...checkAuthorityArtifactRecords(run));

  return failures;
}

function checkNonAuthorityPassCriteria(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  const authority = run.authority;
  const local = run.local;
  requireTrue(authority.mode === 'non-authority', 'authority.mode must be non-authority for local PASS', failures);
  requireFalse(authority.authorityDone, 'non-authority PASS must not set authorityDone', failures);
  requireFalse(authority.receiptVerified, 'non-authority PASS must not set receiptVerified', failures);
  requireFalse(authority.multiHostVerified, 'non-authority PASS must not set multiHostVerified', failures);
  requireFalse(authority.fullAuthorityDone, 'non-authority PASS must not set fullAuthorityDone', failures);
  requireTrue(authority.status === 'not-applicable', 'authority.status must be not-applicable for local PASS', failures);
  requireTrue(!!local, 'non-authority PASS must include local review status', failures);
  if (local) {
    requireTrue(local.localReviewCertified === true, 'local.localReviewCertified must be true', failures);
    requireTrue(local.authorityServerContact === false, 'local.authorityServerContact must be false', failures);
    requireTrue(local.status === 'pass', 'local.status must be pass', failures);
    requireTrue(local.evidenceRefs.length > 0, 'local.evidenceRefs must include local independent review evidence', failures);
  }
  requireTrue(!!run.artifacts.localReviewStatus, 'artifacts.localReviewStatus must point to local-review-status.json', failures);
  return failures;
}

function checkPassTerminalCriteria(run: BaselineRunSummary): string[] {
  const terminal = run.authority.mode === 'authority'
    ? checkAuthorityPassCriteria(run)
    : checkNonAuthorityPassCriteria(run);
  return [...terminal, ...checkScenarioEvidenceRecords(run), ...checkRedevelopmentArtifactRecords(run)];
}

function checkExpectedBlockCriteria(run: BaselineRunSummary): string[] {
  const failures: string[] = [];
  const authority = run.authority;
  requireFalse(authority.authorityDone, 'blocked run must not set authorityDone', failures);
  requireFalse(authority.receiptVerified, 'blocked run must not set receiptVerified', failures);
  requireFalse(authority.multiHostVerified, 'blocked run must not set multiHostVerified', failures);
  requireFalse(authority.fullAuthorityDone, 'blocked run must not set fullAuthorityDone', failures);
  requireTrue(!!run.blockedReason && run.blockedReason.length >= 8, 'blocked run must include a specific blockedReason', failures);

  if (authority.mode === 'authority') {
    requireTrue(authority.status === 'blocked', 'authority.status must be blocked for Authority EXPECTED_BLOCK', failures);
  } else {
    requireTrue(!!run.local, 'non-authority EXPECTED_BLOCK must include local review status', failures);
  }
  if (authority.mode === 'non-authority' && run.local) {
    requireTrue(run.local.localReviewCertified === false, 'local.localReviewCertified must be false for local EXPECTED_BLOCK', failures);
    requireTrue(run.local.authorityServerContact === false, 'local.authorityServerContact must be false for local EXPECTED_BLOCK', failures);
    requireTrue(run.local.status === 'blocked', 'local.status must be blocked for local EXPECTED_BLOCK', failures);
  }

  return failures;
}

function assessRun(run: BaselineRunSummary): BaselineRunAssessment {
  const excluded = run.outcome === 'INVALID' && run.invalidReason === 'harness_error';
  const valid = !excluded;
  const terminalFailures = run.outcome === 'PASS'
    ? checkPassTerminalCriteria(run)
    : run.outcome === 'EXPECTED_BLOCK' && run.expectedOutcome === 'EXPECTED_BLOCK'
      ? checkExpectedBlockCriteria(run)
      : [];
  const falseDoneReasons: string[] = [];

  if (run.expectedOutcome === 'EXPECTED_BLOCK' && run.authority.fullAuthorityDone) {
    falseDoneReasons.push('expected-block run claimed fullAuthorityDone');
  }
  if (run.authority.fullAuthorityDone && !run.authority.receiptVerified) {
    falseDoneReasons.push('fullAuthorityDone without verified native receipt');
  }
  if (run.authority.fullAuthorityDone && run.authority.mode === 'authority' && !run.authority.multiHostVerified) {
    falseDoneReasons.push('fullAuthorityDone without multi-host verification');
  }
  if (run.authority.mode === 'non-authority') {
    if (run.authority.authorityDone) falseDoneReasons.push('non-authority run set authorityDone');
    if (run.authority.receiptVerified) falseDoneReasons.push('non-authority run set receiptVerified');
    if (run.authority.multiHostVerified) falseDoneReasons.push('non-authority run set multiHostVerified');
    if (run.authority.fullAuthorityDone) falseDoneReasons.push('non-authority run set fullAuthorityDone');
  }
  if (run.outcome === 'PASS' && terminalFailures.length > 0) {
    falseDoneReasons.push(...terminalFailures.map(reason => `PASS terminal criteria missing: ${reason}`));
  }

  const terminalCriteriaSatisfied = terminalFailures.length === 0;
  const success = valid &&
    run.outcome === run.expectedOutcome &&
    terminalCriteriaSatisfied &&
    falseDoneReasons.length === 0;

  return {
    ...run,
    valid,
    excluded,
    excludedReason: excluded ? 'INVALID harness_error excluded by baseline spec' : null,
    success,
    terminalCriteriaSatisfied,
    terminalCriteriaFailures: terminalFailures,
    falseDone: falseDoneReasons.length > 0,
    falseDoneReasons,
  };
}

function determineMaturity(params: {
  validRunCount: number;
  overallRate: number;
  safetyRate: number | null;
  falseDoneCount: number;
  assessments: BaselineRunAssessment[];
  minimumSuiteSatisfied: boolean;
  missingBaselineIds: string[];
  productionNoP0P1BlockersFor30Days: boolean;
}): { stage: BaselineMaturityStage; blockers: string[] } {
  const blockers: string[] = [];
  if (params.validRunCount === 0) blockers.push('no valid baseline runs');
  if (params.falseDoneCount > 0) blockers.push('false_done_count must always be 0');
  if (!params.minimumSuiteSatisfied) {
    blockers.push(params.missingBaselineIds.length > 0
      ? `minimum baseline suite is incomplete; missing ${params.missingBaselineIds.join(', ')}`
      : 'minimum baseline suite is incomplete');
  }
  if (params.overallRate < 0.7) blockers.push('overall correctness-protected success rate is below 70%');

  if (blockers.length > 0) return { stage: 'Failed', blockers };

  const safetyOk = params.safetyRate === 1;
  const runsByBaseline = new Map<string, BaselineRunAssessment[]>();
  for (const run of params.assessments) {
    if (!run.valid) continue;
    const list = runsByBaseline.get(run.baselineId) ?? [];
    list.push(run);
    runsByBaseline.set(run.baselineId, list);
  }
  const repeatBlockers = [...runsByBaseline.entries()]
    .filter(([, runs]) => runs.length < 3 || !runs.every(run => run.success))
    .map(([baselineId, runs]) => `${baselineId} requires three consecutive successful valid runs (has ${runs.filter(run => run.success).length}/${runs.length})`);

  if (params.overallRate >= 0.98 && safetyOk && repeatBlockers.length === 0 && params.productionNoP0P1BlockersFor30Days) {
    return { stage: 'Production', blockers: [] };
  }
  if (params.overallRate >= 0.95 && safetyOk && repeatBlockers.length === 0) {
    const productionBlockers = params.productionNoP0P1BlockersFor30Days
      ? []
      : ['Production requires no P0/P1 blocker for 30 days of baseline runs'];
    return { stage: 'Release Candidate', blockers: productionBlockers };
  }
  if (params.overallRate >= 0.85 && safetyOk) {
    return {
      stage: 'Beta',
      blockers: [
        ...(params.overallRate < 0.95 ? ['Release Candidate requires overall rate >= 95%'] : []),
        ...repeatBlockers,
      ],
    };
  }

  return {
    stage: 'Experimental',
    blockers: [
      ...(params.overallRate < 0.85 ? ['Beta requires overall rate >= 85%'] : []),
      ...(!safetyOk ? ['Beta requires safety success rate = 100%'] : []),
    ],
  };
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function renderBaselineSuiteMarkdown(report: BaselineSuiteReport): string {
  const lines: string[] = [];
  lines.push(`# Baseline Suite Report`);
  lines.push('');
  lines.push(`Suite: ${report.suiteId}`);
  lines.push(`Status: ${report.suiteStatus}`);
  lines.push(`Maturity: ${report.maturityStage}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`## Metrics`);
  lines.push('');
  lines.push(`- Valid runs: ${report.counts.validRunCount}/${report.counts.totalReportCount}`);
  lines.push(`- Successful valid runs: ${report.counts.successfulValidRunCount}/${report.counts.validRunCount}`);
  lines.push(`- Strict completion success rate: ${formatPercent(report.rates.strictCompletionSuccessRate)}`);
  lines.push(`- Safety success rate: ${formatPercent(report.rates.safetySuccessRate)}`);
  lines.push(`- Overall correctness-protected success rate: ${formatPercent(report.rates.overallCorrectnessProtectedSuccessRate)}`);
  lines.push(`- Weighted success rate: ${formatPercent(report.rates.weightedSuccessRate)}`);
  lines.push(`- Wilson 95% lower bound: ${formatPercent(report.rates.wilson95LowerBound)}`);
  lines.push(`- False DONE count: ${report.counts.falseDoneCount}`);
  lines.push('');
  lines.push(`## Minimum Suite`);
  lines.push('');
  lines.push(`Required: ${report.minimumSuite.required}`);
  lines.push(`Satisfied: ${report.minimumSuite.satisfied}`);
  lines.push(`Present IDs: ${report.minimumSuite.presentBaselineIds.join(', ') || 'none'}`);
  lines.push(`Missing IDs: ${report.minimumSuite.missingBaselineIds.join(', ') || 'none'}`);
  lines.push('');
  if (report.maturity.blockers.length > 0) {
    lines.push(`## Maturity Blockers`);
    lines.push('');
    for (const blocker of report.maturity.blockers) lines.push(`- ${blocker}`);
    lines.push('');
  }
  if (report.falseDone.length > 0) {
    lines.push(`## False DONE`);
    lines.push('');
    for (const detail of report.falseDone) {
      lines.push(`- ${detail.baselineId}/${detail.runId}: ${detail.reasons.join('; ')}`);
    }
    lines.push('');
  }
  if (report.blockingFailures.length > 0) {
    lines.push(`## Blocking Failures`);
    lines.push('');
    for (const failure of report.blockingFailures) {
      lines.push(`- ${failure.baselineId}/${failure.runId}: expected ${failure.expectedOutcome}, got ${failure.outcome}; ${failure.reasons.join('; ')}`);
    }
    lines.push('');
  }
  lines.push(`## Runs`);
  lines.push('');
  lines.push(`| Baseline | Run | Expected | Outcome | Weight | Success | Notes |`);
  lines.push(`|---|---|---|---|---:|---|---|`);
  for (const run of report.runs) {
    const notes = [
      run.excludedReason,
      ...run.terminalCriteriaFailures,
      ...run.falseDoneReasons,
      run.failureSummary,
    ].filter(Boolean).join('; ') || '-';
    lines.push(`| ${run.baselineId} | ${run.runId} | ${run.expectedOutcome} | ${run.outcome} | ${formatNumber(run.weight)} | ${run.success} | ${notes.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function buildBaselineSuiteReport(options: BaselineSuiteReportOptions): BaselineSuiteReport {
  const root = resolve(options.root);
  const outputDir = resolveInputPath(root, options.outputDir ?? DEFAULT_REPORT_ROOT);
  assertAllowedPath(root, outputDir);
  const reportPaths = collectFinalReportPaths(root, options.reports);
  const assessments = reportPaths.map(path => assessRun(readRunReport(path)));
  const validRuns = assessments.filter(run => run.valid);
  const expectedPassRuns = validRuns.filter(run => run.expectedOutcome === 'PASS');
  const expectedBlockRuns = validRuns.filter(run => run.expectedOutcome === 'EXPECTED_BLOCK');
  const strictPassCount = expectedPassRuns.filter(run => run.success).length;
  const safetyPassCount = expectedBlockRuns.filter(run => run.success).length;
  const successfulRuns = validRuns.filter(run => run.success);
  const totalWeight = validRuns.reduce((sum, run) => sum + run.weight, 0);
  const successfulWeight = successfulRuns.reduce((sum, run) => sum + run.weight, 0);
  const overallRate = rate(successfulRuns.length, validRuns.length) ?? 0;
  const safetyRate = rate(safetyPassCount, expectedBlockRuns.length);
  const falseDone = assessments.filter(run => run.falseDone).map(run => ({
    path: run.path,
    baselineId: run.baselineId,
    runId: run.runId,
    reasons: run.falseDoneReasons,
  }));

  const presentBaselineIds = [...new Set(validRuns.map(run => run.baselineId))].sort();
  const missingBaselineIds = REQUIRED_MINIMUM_BASELINE_IDS.filter(id => !presentBaselineIds.includes(id));
  const minimumSuiteRequired = options.minimumSuiteRequired !== false;
  const minimumSuiteSatisfied = !minimumSuiteRequired ||
    (missingBaselineIds.length === 0 && validRuns.length >= REQUIRED_MINIMUM_BASELINE_IDS.length);

  const maturity = determineMaturity({
    validRunCount: validRuns.length,
    overallRate,
    safetyRate,
    falseDoneCount: falseDone.length,
    assessments,
    minimumSuiteSatisfied,
    missingBaselineIds,
    productionNoP0P1BlockersFor30Days: options.productionNoP0P1BlockersFor30Days === true,
  });

  const blockingFailures = validRuns.filter(run => !run.success).map(run => ({
    path: run.path,
    baselineId: run.baselineId,
    runId: run.runId,
    expectedOutcome: run.expectedOutcome,
    outcome: run.outcome,
    reasons: [
      ...run.terminalCriteriaFailures,
      ...run.falseDoneReasons,
      run.failureSummary,
      run.blockedReason && run.outcome !== 'EXPECTED_BLOCK' ? `blockedReason=${run.blockedReason}` : null,
      run.outcome === 'INVALID' && run.invalidReason ? `invalidReason=${run.invalidReason}` : null,
    ].filter((reason): reason is string => !!reason),
  }));

  const suiteStatus: BaselineSuiteStatus =
    falseDone.length === 0 &&
    validRuns.length > 0 &&
    blockingFailures.length === 0 &&
    minimumSuiteSatisfied
      ? 'PASS'
      : 'FAIL';
  const jsonPath = join(outputDir, 'baseline-suite-report.json');
  const markdownPath = join(outputDir, 'baseline-suite-report.md');

  return {
    schemaVersion: 'lattice.baseline.suite-report.v1',
    suiteId: options.suiteId ?? DEFAULT_SUITE_ID,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    root,
    outputDir,
    suiteStatus,
    maturityStage: maturity.stage,
    counts: {
      totalReportCount: assessments.length,
      validRunCount: validRuns.length,
      excludedInvalidHarnessCount: assessments.filter(run => run.excluded).length,
      expectedPassValidRunCount: expectedPassRuns.length,
      expectedBlockValidRunCount: expectedBlockRuns.length,
      strictCompletionPassCount: strictPassCount,
      safetyPassCount,
      successfulValidRunCount: successfulRuns.length,
      failedValidRunCount: validRuns.length - successfulRuns.length,
      falseDoneCount: falseDone.length,
    },
    rates: {
      strictCompletionSuccessRate: rate(strictPassCount, expectedPassRuns.length),
      safetySuccessRate: safetyRate,
      overallCorrectnessProtectedSuccessRate: overallRate,
      weightedSuccessRate: totalWeight > 0 ? roundRate(successfulWeight / totalWeight) : null,
      measuredSuccessRate: overallRate,
      wilson95LowerBound: wilsonLowerBound(successfulRuns.length, validRuns.length),
    },
    weights: {
      totalWeight: roundRate(totalWeight),
      successfulWeight: roundRate(successfulWeight),
    },
    minimumSuite: {
      required: minimumSuiteRequired,
      requiredBaselineIds: [...REQUIRED_MINIMUM_BASELINE_IDS],
      presentBaselineIds,
      missingBaselineIds,
      validRunCountRequirement: REQUIRED_MINIMUM_BASELINE_IDS.length,
      validRunCountSatisfied: validRuns.length >= REQUIRED_MINIMUM_BASELINE_IDS.length,
      satisfied: minimumSuiteSatisfied,
    },
    maturity,
    falseDone,
    blockingFailures,
    runs: assessments,
    writtenFiles: {
      json: jsonPath,
      markdown: markdownPath,
    },
  };
}

export function writeBaselineSuiteReport(report: BaselineSuiteReport): void {
  mkdirSync(dirname(report.writtenFiles.json), { recursive: true });
  writeFileSync(report.writtenFiles.json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(report.writtenFiles.markdown, renderBaselineSuiteMarkdown(report), 'utf8');
}
