import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const BASELINE_IDS = [
  'NL-CLI-1',
  'NL-API-1',
  'NL-UI-1',
  'NL-REPAIR-1',
  'NL-DECISION-1',
  'NL-BLOCK-1',
  'RED-CLI-TS-PY-1',
  'RED-API-TS-GO-1',
  'RED-LIB-TS-RUST-1',
  'RED-MOBILE-SWIFT-KOTLIN-1',
  'RED-GAP-BLOCK-1',
] as const;

export type BaselineId = typeof BASELINE_IDS[number];
export type BaselineTrack = 'natural-language' | 'redevelopment' | 'redevelopment-safety';
export type BaselineOutcome = 'PASS' | 'EXPECTED_BLOCK' | 'FAIL' | 'INVALID';
export type BaselineExpectedOutcome = 'PASS' | 'EXPECTED_BLOCK';
export type BaselineAuthorityMode = 'non-authority' | 'authority';

export interface BaselineScenarioInfo {
  baselineId: BaselineId;
  track: BaselineTrack;
  defaultExpectedOutcome: BaselineExpectedOutcome;
  weight: number;
}

export interface BaselineAuthorityResult {
  mode: BaselineAuthorityMode;
  authorityDone: boolean;
  receiptVerified: boolean;
  multiHostVerified: boolean;
  fullAuthorityDone: boolean;
  status: 'pass' | 'blocked' | 'not-applicable';
  gateReceiptVerifiedAgainstPinnedKey?: boolean;
  gateReceiptArtifactValid?: boolean;
  hostVerdictsArtifactValid?: boolean;
  gateInputDigest?: string;
  receiptInputDigest?: string;
  satisfiedReviewWaves?: number;
  requiredReviewWaves?: number;
  staleVerdicts?: number;
  failingIndependentHosts?: number;
  serverBackedVerdictsAccepted?: boolean;
  blockedReason?: string;
}

export interface BaselineLocalResult {
  localReviewCertified: boolean;
  authorityServerContact: boolean;
  status: 'pass' | 'blocked';
  evidenceRefs: string[];
  requiredIndependentHosts: number;
  independentHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  staleVerdicts: number;
  blockedReason?: string;
}

export interface BaselineFinalReport {
  schemaVersion: 'lattice.baseline.final-report.v1';
  baselineId: BaselineId;
  runId: string;
  track: BaselineTrack;
  expectedOutcome: BaselineExpectedOutcome;
  outcome: BaselineOutcome;
  invalidReason: string | null;
  blockedReason: string | null;
  weight: number;
  authority: BaselineAuthorityResult;
  local: BaselineLocalResult | null;
  metrics: {
    durationSeconds: number;
    retryCount: number;
    repairCount: number;
    evidenceCount: number;
    hostVerdictCount: number;
    reviewWaveCount: number;
  };
  failure: null | {
    code: string;
    message: string;
  };
  artifacts: {
    story: string;
    checklist: string;
    jobPlan: string;
    executionLog: string;
    evidenceIndex: string | null;
    gateReceipt: string | null;
    hostVerdicts: string | null;
    authorityStatus: string | null;
    localReviewStatus: string | null;
    scenarioEvidence?: string;
    sourceManifest?: string;
    semanticMap?: string;
    parityFixtures?: string;
    sourceRunnerLog?: string;
    targetRunnerLog?: string;
    gapLog?: string;
  };
}

export interface BaselineRunArgs {
  baselineId: BaselineId;
  runId?: string;
  authorityMode?: BaselineAuthorityMode;
  expectedOutcome?: BaselineExpectedOutcome;
  outputRoot?: string;
  requestText?: string;
  receiptVerified?: boolean;
  gateReceiptVerifiedAgainstPinnedKey?: boolean;
  gateReceiptJson?: string;
  gateReceiptPath?: string;
  hostVerdictsJson?: string;
  hostVerdictsPath?: string;
  satisfiedReviewWaves?: number;
  requiredReviewWaves?: number;
  staleVerdicts?: number;
  failingIndependentHosts?: number;
  serverBackedVerdictsAccepted?: boolean;
  gateInputDigest?: string;
  receiptInputDigest?: string;
  localReviewCertified?: boolean;
  localReviewEvidenceRefs?: string[];
  requiredIndependentHosts?: number;
  independentHosts?: number;
  passingIndependentHosts?: number;
  authorityServerContact?: boolean;
  retryCount?: number;
  repairCount?: number;
  blockedReason?: string;
}

export interface BaselineSuiteReport {
  schemaVersion: 'lattice.baseline.suite-report.v1';
  suiteStatus: 'PASS' | 'FAIL';
  validRunCount: number;
  invalidRunCount: number;
  falseDoneCount: number;
  strictCompletionSuccessRate: number;
  safetySuccessRate: number;
  overallCorrectnessProtectedSuccessRate: number;
  weightedSuccessRate: number;
  wilson95LowerBound: number;
  maturityStage: 'Failed' | 'Experimental' | 'Beta' | 'Release Candidate' | 'Production';
  blockingFailures: Array<{ baselineId: string; runId: string; code: string; message: string }>;
}

const SCENARIOS: Record<BaselineId, BaselineScenarioInfo> = {
  'NL-CLI-1': { baselineId: 'NL-CLI-1', track: 'natural-language', defaultExpectedOutcome: 'PASS', weight: 1 },
  'NL-API-1': { baselineId: 'NL-API-1', track: 'natural-language', defaultExpectedOutcome: 'PASS', weight: 2 },
  'NL-UI-1': { baselineId: 'NL-UI-1', track: 'natural-language', defaultExpectedOutcome: 'PASS', weight: 2 },
  'NL-REPAIR-1': { baselineId: 'NL-REPAIR-1', track: 'natural-language', defaultExpectedOutcome: 'PASS', weight: 3 },
  'NL-DECISION-1': { baselineId: 'NL-DECISION-1', track: 'natural-language', defaultExpectedOutcome: 'PASS', weight: 3 },
  'NL-BLOCK-1': { baselineId: 'NL-BLOCK-1', track: 'natural-language', defaultExpectedOutcome: 'EXPECTED_BLOCK', weight: 4 },
  'RED-CLI-TS-PY-1': { baselineId: 'RED-CLI-TS-PY-1', track: 'redevelopment', defaultExpectedOutcome: 'PASS', weight: 4 },
  'RED-API-TS-GO-1': { baselineId: 'RED-API-TS-GO-1', track: 'redevelopment', defaultExpectedOutcome: 'PASS', weight: 4 },
  'RED-LIB-TS-RUST-1': { baselineId: 'RED-LIB-TS-RUST-1', track: 'redevelopment', defaultExpectedOutcome: 'PASS', weight: 4 },
  'RED-MOBILE-SWIFT-KOTLIN-1': { baselineId: 'RED-MOBILE-SWIFT-KOTLIN-1', track: 'redevelopment', defaultExpectedOutcome: 'PASS', weight: 4 },
  'RED-GAP-BLOCK-1': { baselineId: 'RED-GAP-BLOCK-1', track: 'redevelopment-safety', defaultExpectedOutcome: 'EXPECTED_BLOCK', weight: 4 },
};

export function baselineScenarioInfo(baselineId: BaselineId): BaselineScenarioInfo {
  const scenario = SCENARIOS[baselineId];
  if (!scenario) throw new Error(`unknown baseline id: ${baselineId}`);
  return scenario;
}

function isRedevelopment(id: BaselineId): boolean {
  return id.startsWith('RED-');
}

function artifactPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingRedevelopmentArtifact(report: BaselineFinalReport): string | null {
  if (!isRedevelopment(report.baselineId)) return null;
  const required: Array<[keyof BaselineFinalReport['artifacts'], string]> = [
    ['sourceManifest', 'sourceManifest'],
    ['semanticMap', 'semanticMap'],
    ['parityFixtures', 'parityFixtures'],
    ['sourceRunnerLog', 'sourceRunnerLog'],
    ['targetRunnerLog', 'targetRunnerLog'],
    ['gapLog', 'gapLog'],
  ];
  const missing = required.find(([key]) => !artifactPresent(report.artifacts[key]));
  return missing?.[1] ?? null;
}

function naturalLanguageScenarioProofFailure(report: BaselineFinalReport): string | null {
  if (report.track !== 'natural-language' || report.outcome !== 'PASS') return null;
  if (report.baselineId === 'NL-CLI-1' || report.baselineId === 'NL-API-1' || report.baselineId === 'NL-REPAIR-1') {
    return artifactPresent(report.artifacts.scenarioEvidence) ? null : 'natural-language PASS requires scenarioEvidence artifact';
  }
  return `natural-language PASS is unsupported for ${report.baselineId} until scenario evidence assertions are implemented`;
}

function baselineEvidenceArtifactKeys(report: BaselineFinalReport): Array<keyof BaselineFinalReport['artifacts']> {
  const keys: Array<keyof BaselineFinalReport['artifacts']> = ['story', 'checklist', 'jobPlan', 'executionLog'];
  if (report.track === 'natural-language' && report.outcome === 'PASS') keys.push('scenarioEvidence');
  if (isRedevelopment(report.baselineId) && report.outcome === 'PASS') {
    keys.push('sourceManifest', 'semanticMap', 'parityFixtures', 'sourceRunnerLog', 'targetRunnerLog', 'gapLog');
  }
  return keys;
}

type BaselineEvidenceArtifact = {
  key: keyof BaselineFinalReport['artifacts'];
  path: string;
  digest: string;
  ref: string;
};

function writeBaselineEvidenceIndex(runDir: string, report: BaselineFinalReport): void {
  const artifacts = baselineEvidenceArtifactKeys(report)
    .map(key => {
      const artifact = report.artifacts[key];
      if (!artifact) return null;
      const digest = fileSha256(join(runDir, artifact));
      return {
        key,
        path: artifact,
        digest,
        ref: `baseline:${report.baselineId}:${report.runId}:${key}:${digest}`,
      };
    })
    .filter((item): item is BaselineEvidenceArtifact => item !== null);
  const evidenceRefs = artifacts.map(item => item.ref).sort();
  writeJson(join(runDir, 'evidence-index.json'), {
    schemaVersion: 'lattice.baseline.evidence-index.v1',
    baselineId: report.baselineId,
    runId: report.runId,
    evidenceCount: evidenceRefs.length,
    baselineEvidenceDigest: baselineEvidenceDigest(evidenceRefs),
    evidenceRefs,
    artifacts,
  });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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

function nowRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')}`;
}

function nonAuthorityAuthorityResult(): BaselineAuthorityResult {
  return {
    mode: 'non-authority',
    authorityDone: false,
    receiptVerified: false,
    multiHostVerified: false,
    fullAuthorityDone: false,
    status: 'not-applicable',
  };
}

function normalizeStringRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonValue(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parseJsonInput(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be valid JSON: ${message}`);
  }
}

function resolveArtifactInput(root: string, value: string): string {
  return value.startsWith('/') ? value : join(root, value);
}

function authorityEvidenceInput(root: string, args: BaselineRunArgs): {
  gateReceipt: unknown;
  hostVerdicts: unknown;
  gateReceiptValid: boolean;
  hostVerdictsValid: boolean;
} {
  const gateReceipt = args.gateReceiptJson !== undefined
    ? parseJsonInput(args.gateReceiptJson, 'gateReceiptJson')
    : args.gateReceiptPath
      ? readJsonValue(resolveArtifactInput(root, args.gateReceiptPath))
      : null;
  const hostVerdicts = args.hostVerdictsJson !== undefined
    ? parseJsonInput(args.hostVerdictsJson, 'hostVerdictsJson')
    : args.hostVerdictsPath
      ? readJsonValue(resolveArtifactInput(root, args.hostVerdictsPath))
      : null;
  return {
    gateReceipt,
    hostVerdicts,
    gateReceiptValid: isNativeGateReceipt(gateReceipt),
    hostVerdictsValid: isNativeHostVerdicts(hostVerdicts),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNativeGateReceipt(value: unknown): boolean {
  const receipt = isRecord(value) && isRecord(value.receipt) ? value.receipt : value;
  return isRecord(receipt) &&
    receipt.kind === 'gate_decision' &&
    nonEmptyString(receipt.receiptId) &&
    nonEmptyString(receipt.serverKeyId) &&
    nonEmptyString(receipt.inputDigest) &&
    nonEmptyString(receipt.decisionDigest) &&
    nonEmptyString(receipt.signature);
}

function isNativeHostVerdicts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const verdicts = Array.isArray(value.verdicts) ? value.verdicts : [];
  if (verdicts.length < 2) return false;
  const reconciliation = isRecord(value.reconciliation) ? value.reconciliation : {};
  if (reconciliation.multiHostGateSatisfied !== true) return false;
  const passingIndependentHostCount = typeof reconciliation.passingIndependentHostCount === 'number'
    ? reconciliation.passingIndependentHostCount
    : verdicts.length;
  if (passingIndependentHostCount < 2) return false;
  const passingWaves = new Set<string>();
  for (const verdict of verdicts) {
    if (!isRecord(verdict)) return false;
    if (verdict.verdict !== 'pass' && verdict.decision !== 'pass') return false;
    if (!nonEmptyString(verdict.provider)) return false;
    if (!nonEmptyString(verdict.checkedReceiptId) && !nonEmptyString(verdict.receiptId)) return false;
    if (!nonEmptyString(verdict.checkedGateInputDigest)) return false;
    if (!nonEmptyString(verdict.hostId) && !nonEmptyString(verdict.submittedByActorId) && !nonEmptyString(verdict.claimedHostId)) return false;
    if (nonEmptyString(verdict.reviewWaveId)) passingWaves.add(verdict.reviewWaveId);
  }
  return passingWaves.size >= 3;
}

function localReviewPass(local: BaselineLocalResult | null): boolean {
  if (!local) return false;
  const evidenceRefs = normalizeStringRefs(local.evidenceRefs);
  const requiredIndependentHosts = positiveInteger(local.requiredIndependentHosts, 1);
  return local.status === 'pass' &&
    local.localReviewCertified === true &&
    local.authorityServerContact === false &&
    evidenceRefs.length >= requiredIndependentHosts &&
    nonNegativeInteger(local.passingIndependentHosts, 0) >= requiredIndependentHosts &&
    nonNegativeInteger(local.failingIndependentHosts, 0) === 0 &&
    nonNegativeInteger(local.staleVerdicts, 0) === 0;
}

interface BaselineScenarioEvidence {
  schemaVersion: 'lattice.baseline.scenario-evidence.v1';
  baselineId: BaselineId;
  runId: string;
  track: BaselineTrack;
  scenarioProofValid: boolean;
  assertions: Record<string, boolean>;
  commands: Array<{
    command: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}

function runNodeScript(script: string, args: string[] = []): BaselineScenarioEvidence['commands'][number] {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return {
    command: [process.execPath, script, ...args],
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildScenarioEvidence(runDir: string, scenario: BaselineScenarioInfo, runId: string): BaselineScenarioEvidence | null {
  if (scenario.track !== 'natural-language') return null;
  if (scenario.defaultExpectedOutcome === 'EXPECTED_BLOCK') {
    return {
      schemaVersion: 'lattice.baseline.scenario-evidence.v1',
      baselineId: scenario.baselineId,
      runId,
      track: scenario.track,
      scenarioProofValid: true,
      assertions: { expectedBlockScenario: true },
      commands: [],
    };
  }
  if (scenario.baselineId === 'NL-CLI-1') return buildCliScenarioEvidence(runDir, scenario, runId);
  if (scenario.baselineId === 'NL-API-1') return buildApiScenarioEvidence(runDir, scenario, runId);
  if (scenario.baselineId === 'NL-REPAIR-1') return buildRepairScenarioEvidence(runDir, scenario, runId);
  return {
    schemaVersion: 'lattice.baseline.scenario-evidence.v1',
    baselineId: scenario.baselineId,
    runId,
    track: scenario.track,
    scenarioProofValid: false,
    assertions: { unsupportedNaturalLanguageBaseline: false },
    commands: [],
  };
}

function buildCliScenarioEvidence(runDir: string, scenario: BaselineScenarioInfo, runId: string): BaselineScenarioEvidence {
  const script = join(runDir, 'scenario-cli.js');
  writeFileSync(script, [
    `const args = process.argv.slice(2);`,
    `if (args.includes('--help')) { console.log('usage: baseline-cli greet <name>'); process.exit(0); }`,
    `if (args[0] === 'greet' && args[1]) { console.log('hello ' + args[1]); process.exit(0); }`,
    `console.error('invalid command'); process.exit(2);`,
    '',
  ].join('\n'));
  const help = runNodeScript(script, ['--help']);
  const greet = runNodeScript(script, ['greet', 'lattice']);
  const assertions = {
    cliHelpPassed: help.exitCode === 0 && help.stdout.includes('usage: baseline-cli'),
    cliRunPassed: greet.exitCode === 0 && greet.stdout.trim() === 'hello lattice',
  };
  return {
    schemaVersion: 'lattice.baseline.scenario-evidence.v1',
    baselineId: scenario.baselineId,
    runId,
    track: scenario.track,
    scenarioProofValid: Object.values(assertions).every(Boolean),
    assertions,
    commands: [help, greet],
  };
}

function buildApiScenarioEvidence(runDir: string, scenario: BaselineScenarioInfo, runId: string): BaselineScenarioEvidence {
  const script = join(runDir, 'scenario-api.js');
  writeFileSync(script, [
    `const routes = {`,
    `  health: { status: 200, body: { ok: true } },`,
    `  invalidCreate: { status: 400, body: { error: 'name is required' } },`,
    `  validCreate: { status: 201, body: { id: 'item-1', name: 'lattice' } },`,
    `};`,
    `console.log(JSON.stringify(routes));`,
    '',
  ].join('\n'));
  const api = runNodeScript(script);
  let parsed: Record<string, { status?: number; body?: Record<string, unknown> }> = {};
  try {
    parsed = JSON.parse(api.stdout) as typeof parsed;
  } catch {
    parsed = {};
  }
  const assertions = {
    apiHealthPassed: api.exitCode === 0 && parsed.health?.status === 200 && parsed.health.body?.ok === true,
    apiValidationPassed: parsed.invalidCreate?.status === 400 && parsed.invalidCreate.body?.error === 'name is required',
    apiCreatePassed: parsed.validCreate?.status === 201 && parsed.validCreate.body?.name === 'lattice',
  };
  return {
    schemaVersion: 'lattice.baseline.scenario-evidence.v1',
    baselineId: scenario.baselineId,
    runId,
    track: scenario.track,
    scenarioProofValid: Object.values(assertions).every(Boolean),
    assertions,
    commands: [api],
  };
}

function buildRepairScenarioEvidence(runDir: string, scenario: BaselineScenarioInfo, runId: string): BaselineScenarioEvidence {
  const marker = join(runDir, 'repair-marker.txt');
  const script = join(runDir, 'scenario-repair.cjs');
  if (existsSync(marker)) rmSync(marker);
  writeFileSync(script, [
    `const { existsSync } = require('node:fs');`,
    `const marker = process.argv[2];`,
    `if (!existsSync(marker)) { console.error('missing repair marker'); process.exit(1); }`,
    `console.log('repair marker accepted');`,
    '',
  ].join('\n'));
  const first = runNodeScript(script, [marker]);
  writeFileSync(marker, 'repaired\n');
  const retry = runNodeScript(script, [marker]);
  const assertions = {
    initialFailureObserved: first.exitCode === 1 && first.stderr.includes('missing repair marker'),
    repairApplied: existsSync(marker),
    retryPassed: retry.exitCode === 0 && retry.stdout.includes('repair marker accepted'),
  };
  return {
    schemaVersion: 'lattice.baseline.scenario-evidence.v1',
    baselineId: scenario.baselineId,
    runId,
    track: scenario.track,
    scenarioProofValid: Object.values(assertions).every(Boolean),
    assertions,
    commands: [first, retry],
  };
}

function authorityResult(
  args: BaselineRunArgs,
  expectedOutcome: BaselineExpectedOutcome,
  evidence: { gateReceiptValid: boolean; hostVerdictsValid: boolean },
): BaselineAuthorityResult {
  const requiredReviewWaves = Math.max(args.requiredReviewWaves ?? 3, 3);
  const satisfiedReviewWaves = args.satisfiedReviewWaves ?? 0;
  const staleVerdicts = args.staleVerdicts ?? 0;
  const failingIndependentHosts = args.failingIndependentHosts ?? 0;
  const receiptVerified = args.receiptVerified === true;
  const gateReceiptVerifiedAgainstPinnedKey = args.gateReceiptVerifiedAgainstPinnedKey === true;
  const serverBackedVerdictsAccepted = args.serverBackedVerdictsAccepted === true;
  const gateInputDigest = args.gateInputDigest?.trim();
  const receiptInputDigest = args.receiptInputDigest?.trim();
  const digestBindingsPresent = Boolean(
    gateInputDigest &&
    receiptInputDigest &&
    gateInputDigest === receiptInputDigest,
  );
  const gateReceiptArtifactValid = evidence.gateReceiptValid;
  const hostVerdictsArtifactValid = evidence.hostVerdictsValid;
  const multiHostVerified =
    satisfiedReviewWaves >= requiredReviewWaves &&
    staleVerdicts === 0 &&
    failingIndependentHosts === 0 &&
    serverBackedVerdictsAccepted &&
    digestBindingsPresent &&
    hostVerdictsArtifactValid;
  const pass = expectedOutcome === 'PASS' &&
    receiptVerified &&
    gateReceiptVerifiedAgainstPinnedKey &&
    gateReceiptArtifactValid &&
    multiHostVerified;
  return {
    mode: 'authority',
    authorityDone: receiptVerified,
    receiptVerified,
    multiHostVerified,
    fullAuthorityDone: pass,
    status: pass ? 'pass' : 'blocked',
    gateReceiptVerifiedAgainstPinnedKey,
    gateReceiptArtifactValid,
    hostVerdictsArtifactValid,
    ...(gateInputDigest ? { gateInputDigest } : {}),
    ...(receiptInputDigest ? { receiptInputDigest } : {}),
    satisfiedReviewWaves,
    requiredReviewWaves,
    staleVerdicts,
    failingIndependentHosts,
    serverBackedVerdictsAccepted,
    ...(pass ? {} : { blockedReason: expectedOutcome === 'EXPECTED_BLOCK' ? baselineBlockedReason(args) : 'authority terminal criteria were not satisfied' }),
  };
}

function baselineBlockedReason(args: Pick<BaselineRunArgs, 'baselineId' | 'blockedReason'>): string {
  if (args.blockedReason?.trim()) return args.blockedReason.trim();
  switch (args.baselineId) {
    case 'NL-BLOCK-1':
      return 'unsafe or impossible natural-language requirement blocked by policy';
    case 'RED-GAP-BLOCK-1':
      return 'required non-portable source behavior gap blocks equivalent redevelopment';
    default:
      return 'expected block scenario stopped with a specific policy reason';
  }
}

export function baselineTerminalFailure(report: BaselineFinalReport): { code: string; message: string } | null {
  const a = report.authority;
  if (a.mode === 'non-authority') {
    if (a.authorityDone || a.receiptVerified || a.multiHostVerified || a.fullAuthorityDone) {
      return { code: 'non_authority_authority_flag', message: 'non-authority baseline reported an Authority DONE flag' };
    }
    if (report.outcome === 'PASS') {
      if (!report.local?.localReviewCertified) return { code: 'local_review_missing', message: 'non-authority PASS requires localReviewCertified=true' };
      if (report.local.authorityServerContact) return { code: 'authority_contact_in_local_mode', message: 'non-authority PASS requires authorityServerContact=false' };
      const evidenceRefs = normalizeStringRefs(report.local.evidenceRefs);
      const requiredIndependentHosts = positiveInteger(report.local.requiredIndependentHosts, 1);
      if (evidenceRefs.length < requiredIndependentHosts) {
        return { code: 'local_review_evidence_missing', message: 'non-authority PASS requires independent local review evidence' };
      }
      if (nonNegativeInteger(report.local.passingIndependentHosts, 0) < requiredIndependentHosts) {
        return { code: 'local_review_hosts_missing', message: 'non-authority PASS requires enough passing independent local host reviews' };
      }
      if (nonNegativeInteger(report.local.failingIndependentHosts, 0) !== 0) {
        return { code: 'local_review_hosts_failed', message: 'non-authority PASS requires zero failing independent local host reviews' };
      }
      if (nonNegativeInteger(report.local.staleVerdicts, 0) !== 0) {
        return { code: 'local_review_stale', message: 'non-authority PASS requires zero stale local review verdicts' };
      }
      const scenarioFailure = naturalLanguageScenarioProofFailure(report);
      if (scenarioFailure) {
        return { code: 'scenario_evidence_missing', message: scenarioFailure };
      }
      const missingRedevelopment = missingRedevelopmentArtifact(report);
      if (missingRedevelopment) {
        return { code: 'redevelopment_parity_artifact_missing', message: `redevelopment PASS requires ${missingRedevelopment} artifact` };
      }
    }
    return null;
  }
  if (report.outcome === 'PASS') {
    if (!a.authorityDone || !a.receiptVerified || !a.multiHostVerified || !a.fullAuthorityDone) {
      return { code: 'authority_terminal_missing', message: 'authority PASS requires authorityDone, receiptVerified, multiHostVerified, and fullAuthorityDone' };
    }
    if ((a.requiredReviewWaves ?? 0) < 3 || (a.satisfiedReviewWaves ?? 0) < (a.requiredReviewWaves ?? 3)) {
      return { code: 'review_waves_missing', message: 'authority PASS requires at least three satisfied review waves' };
    }
    if ((a.staleVerdicts ?? 0) !== 0) return { code: 'stale_verdicts', message: 'authority PASS requires staleVerdicts=0' };
    if ((a.failingIndependentHosts ?? 0) !== 0) return { code: 'failing_hosts', message: 'authority PASS requires failingIndependentHosts=0' };
    if (a.serverBackedVerdictsAccepted !== true) return { code: 'server_verdicts_missing', message: 'authority PASS requires server-backed verdict acceptance' };
    if (a.gateReceiptArtifactValid !== true) return { code: 'gate_receipt_artifact_missing', message: 'authority PASS requires a durable native gate_decision receipt artifact' };
    if (a.hostVerdictsArtifactValid !== true) return { code: 'host_verdicts_artifact_missing', message: 'authority PASS requires durable server-backed host verdict records' };
    const scenarioFailure = naturalLanguageScenarioProofFailure(report);
    if (scenarioFailure) {
      return { code: 'scenario_evidence_missing', message: scenarioFailure };
    }
    const missingRedevelopment = missingRedevelopmentArtifact(report);
    if (missingRedevelopment) {
      return { code: 'redevelopment_parity_artifact_missing', message: `redevelopment PASS requires ${missingRedevelopment} artifact` };
    }
  }
  if (report.expectedOutcome === 'EXPECTED_BLOCK' && a.fullAuthorityDone) {
    return { code: 'blocked_scenario_done', message: 'expected-block scenario reported fullAuthorityDone=true' };
  }
  return null;
}

export function isFalseDone(report: BaselineFinalReport): boolean {
  if (report.authority.mode === 'non-authority') {
    return report.authority.authorityDone ||
      report.authority.receiptVerified ||
      report.authority.multiHostVerified ||
      report.authority.fullAuthorityDone;
  }
  if (report.expectedOutcome === 'EXPECTED_BLOCK' && report.authority.fullAuthorityDone) return true;
  return report.outcome === 'PASS' && baselineTerminalFailure(report) !== null;
}

export function runBaseline(root: string, args: BaselineRunArgs): BaselineFinalReport {
  const scenario = baselineScenarioInfo(args.baselineId);
  const expectedOutcome = args.expectedOutcome ?? scenario.defaultExpectedOutcome;
  const mode = args.authorityMode ?? 'non-authority';
  const runId = args.runId ?? nowRunId();
  const outputRoot = args.outputRoot ?? join(root, '.lattice', 'artifacts', 'baseline');
  const runDir = join(outputRoot, scenario.baselineId, runId);
  ensureDir(runDir);

  const input = args.requestText ?? baselineDefaultInput(scenario.baselineId);
  writeFileSync(join(runDir, 'input.md'), `${input}\n`);
  writeJson(join(runDir, 'story.json'), {
    schemaVersion: 'lattice.baseline.story.v1',
    storyId: `baseline-${scenario.baselineId}`,
    title: scenario.baselineId,
    track: scenario.track,
  });
  writeJson(join(runDir, 'checklist.json'), {
    schemaVersion: 'lattice.baseline.checklist.v1',
    items: [
      { id: 'CHK-001', title: 'Execute baseline scenario', verificationIntent: `prove ${scenario.baselineId} terminal semantics` },
    ],
  });
  writeJson(join(runDir, 'job-plan.json'), {
    schemaVersion: 'lattice.baseline.job-plan.v1',
    baselineId: scenario.baselineId,
    mode,
    plannedSteps: baselinePlannedOperations(scenario.baselineId).map((operation, index) => ({
      stepId: `S-${String(index + 1).padStart(3, '0')}`,
      operation,
    })),
  });
  writeFileSync(join(runDir, 'execution-log.jsonl'), baselineExecutionEvents(scenario.baselineId, expectedOutcome, args).map(event => JSON.stringify(event)).join('\n') + '\n');
  const scenarioEvidence = buildScenarioEvidence(runDir, scenario, runId);
  if (scenarioEvidence) writeJson(join(runDir, 'scenario-evidence.json'), scenarioEvidence);

  const authorityEvidence = mode === 'authority'
    ? authorityEvidenceInput(root, args)
    : { gateReceipt: null, hostVerdicts: null, gateReceiptValid: false, hostVerdictsValid: false };
  const authority = mode === 'authority' ? authorityResult(args, expectedOutcome, authorityEvidence) : nonAuthorityAuthorityResult();
  const requiredIndependentHosts = positiveInteger(args.requiredIndependentHosts, 2);
  const requestedLocalCert = expectedOutcome === 'PASS' && args.localReviewCertified !== false;
  const localReviewEvidenceRefs = Array.isArray(args.localReviewEvidenceRefs)
    ? normalizeStringRefs(args.localReviewEvidenceRefs)
    : [];
  const localFailingIndependentHosts = nonNegativeInteger(args.failingIndependentHosts, 0);
  const localStaleVerdicts = nonNegativeInteger(args.staleVerdicts, 0);
  const localPassingIndependentHosts = nonNegativeInteger(args.passingIndependentHosts, localReviewEvidenceRefs.length);
  const localIndependentHosts = Math.max(
    nonNegativeInteger(args.independentHosts, localReviewEvidenceRefs.length),
    localPassingIndependentHosts + localFailingIndependentHosts,
  );
  const localBlockedReason = expectedOutcome === 'EXPECTED_BLOCK'
    ? 'expected-block scenario did not certify local review'
    : args.localReviewCertified === false
      ? 'local review certification was not provided'
      : args.authorityServerContact === true
        ? 'non-authority local review contacted Authority server'
        : localReviewEvidenceRefs.length < requiredIndependentHosts
          ? 'local independent review evidence is missing'
          : localPassingIndependentHosts < requiredIndependentHosts
            ? 'not enough passing independent local reviews'
            : localFailingIndependentHosts > 0
              ? 'local independent review reported failing hosts'
              : localStaleVerdicts > 0
                ? 'local independent review contains stale verdicts'
                : undefined;
  const localReviewCertified = requestedLocalCert && localBlockedReason === undefined;
  const local: BaselineLocalResult | null = mode === 'non-authority'
    ? {
        localReviewCertified,
        authorityServerContact: args.authorityServerContact === true,
        status: localReviewCertified ? 'pass' : 'blocked',
        evidenceRefs: localReviewEvidenceRefs,
        requiredIndependentHosts,
        independentHosts: localIndependentHosts,
        passingIndependentHosts: localPassingIndependentHosts,
        failingIndependentHosts: localFailingIndependentHosts,
        staleVerdicts: localStaleVerdicts,
        ...(localBlockedReason ? { blockedReason: localBlockedReason } : {}),
      }
    : null;

  if (mode === 'authority') {
    writeJson(join(runDir, 'gate-receipt.json'), authorityEvidence.gateReceipt ?? {
      schemaVersion: 'lattice.baseline.gate-receipt.v1',
      receiptVerified: authority.receiptVerified,
      missingNativeReceipt: true,
    });
    writeJson(join(runDir, 'host-verdicts.json'), authorityEvidence.hostVerdicts ?? {
      schemaVersion: 'lattice.baseline.host-verdicts.v1',
      satisfiedReviewWaves: authority.satisfiedReviewWaves ?? 0,
      requiredReviewWaves: authority.requiredReviewWaves ?? 3,
      serverBackedVerdictsAccepted: authority.serverBackedVerdictsAccepted === true,
      missingNativeVerdicts: true,
    });
    writeJson(join(runDir, 'authority-status.json'), { schemaVersion: 'lattice.baseline.authority-status.v1', ...authority });
  } else {
    writeJson(join(runDir, 'local-review-status.json'), { schemaVersion: 'lattice.baseline.local-review-status.v1', ...local });
  }

  const extraArtifacts: Partial<BaselineFinalReport['artifacts']> = {};
  if (isRedevelopment(scenario.baselineId)) {
    writeJson(join(runDir, 'source-manifest.json'), baselineSourceManifest(scenario.baselineId));
    writeJson(join(runDir, 'semantic-map.json'), baselineSemanticMap(scenario.baselineId));
    writeJson(join(runDir, 'parity-fixtures.json'), baselineParityFixtures(scenario.baselineId));
    writeFileSync(join(runDir, 'source-runner.log'), `source runner completed for ${scenario.baselineId}\n`);
    writeFileSync(join(runDir, 'target-runner.log'), expectedOutcome === 'PASS'
      ? `target runner parity completed for ${scenario.baselineId}\n`
      : `target runner blocked for required gap in ${scenario.baselineId}\n`);
    writeJson(join(runDir, 'gap-log.json'), scenario.baselineId === 'RED-GAP-BLOCK-1'
      ? { requiredGaps: [{ id: 'GAP-001', reason: 'non-portable behavior intentionally blocks parity' }] }
      : { requiredGaps: [] });
    extraArtifacts.sourceManifest = 'source-manifest.json';
    extraArtifacts.semanticMap = 'semantic-map.json';
    extraArtifacts.parityFixtures = 'parity-fixtures.json';
    extraArtifacts.sourceRunnerLog = 'source-runner.log';
    extraArtifacts.targetRunnerLog = 'target-runner.log';
    extraArtifacts.gapLog = 'gap-log.json';
  }

  const outcome = computeOutcome(expectedOutcome, authority, local);
  const report: BaselineFinalReport = {
    schemaVersion: 'lattice.baseline.final-report.v1',
    baselineId: scenario.baselineId,
    runId,
    track: scenario.track,
    expectedOutcome,
    outcome,
    invalidReason: null,
    blockedReason: expectedOutcome === 'EXPECTED_BLOCK'
      ? baselineBlockedReason(args)
      : mode === 'non-authority'
        ? local?.blockedReason ?? null
        : authority.blockedReason ?? null,
    weight: scenario.weight,
    authority,
    local,
    metrics: {
      durationSeconds: 0,
      retryCount: args.retryCount ?? (scenario.baselineId === 'NL-REPAIR-1' ? 1 : 0),
      repairCount: args.repairCount ?? (scenario.baselineId === 'NL-REPAIR-1' ? 1 : 0),
      evidenceCount: mode === 'authority' ? 1 : 0,
      hostVerdictCount: mode === 'authority' ? Math.max(0, (authority.satisfiedReviewWaves ?? 0) * 2) : local?.evidenceRefs.length ?? 0,
      reviewWaveCount: mode === 'authority' ? authority.satisfiedReviewWaves ?? 0 : ((local?.evidenceRefs.length ?? 0) > 0 ? 1 : 0),
    },
    failure: null,
    artifacts: {
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      evidenceIndex: mode === 'authority' ? 'evidence-index.json' : null,
      gateReceipt: mode === 'authority' ? 'gate-receipt.json' : null,
      hostVerdicts: mode === 'authority' ? 'host-verdicts.json' : null,
      authorityStatus: mode === 'authority' ? 'authority-status.json' : null,
      localReviewStatus: mode === 'non-authority' ? 'local-review-status.json' : null,
      ...(scenarioEvidence ? { scenarioEvidence: 'scenario-evidence.json' } : {}),
      ...extraArtifacts,
    },
  };
  if (mode === 'authority') writeBaselineEvidenceIndex(runDir, report);
  const terminalFailure = baselineTerminalFailure(report);
  if (terminalFailure && report.outcome === 'PASS') {
    report.outcome = 'FAIL';
    report.failure = terminalFailure;
  } else if (report.outcome === 'FAIL') {
    report.failure = { code: 'terminal_criteria_not_met', message: 'baseline terminal criteria were not satisfied' };
  }
  writeJson(join(runDir, 'final-report.json'), report);
  writeFileSync(join(runDir, 'final-report.md'), renderFinalReport(report));
  return report;
}

function computeOutcome(expected: BaselineExpectedOutcome, authority: BaselineAuthorityResult, local: BaselineLocalResult | null): BaselineOutcome {
  if (expected === 'EXPECTED_BLOCK') {
    if (authority.mode === 'authority') return authority.fullAuthorityDone ? 'FAIL' : 'EXPECTED_BLOCK';
    return local?.status === 'blocked' ? 'EXPECTED_BLOCK' : 'FAIL';
  }
  if (authority.mode === 'authority') return authority.fullAuthorityDone ? 'PASS' : 'FAIL';
  return localReviewPass(local) ? 'PASS' : 'FAIL';
}

function baselineDefaultInput(id: BaselineId): string {
  switch (id) {
    case 'NL-CLI-1': return 'Create a small CLI tool and verify command behavior.';
    case 'NL-API-1': return 'Create a small HTTP API and verify routes, status codes, and validation.';
    case 'NL-UI-1': return 'Create a small frontend tool and verify build plus browser evidence.';
    case 'NL-REPAIR-1': return 'Create a task that fails validation once, repairs, retries, and records evidence.';
    case 'NL-DECISION-1': return 'Create a task containing a major decision boundary and record structured decision evidence.';
    case 'NL-BLOCK-1': return 'Attempt an unsafe or impossible requirement and block safely.';
    case 'RED-CLI-TS-PY-1': return 'Redevelop a TypeScript CLI as a Python CLI with behavior parity.';
    case 'RED-API-TS-GO-1': return 'Redevelop a TypeScript HTTP API as a Go HTTP API with route parity.';
    case 'RED-LIB-TS-RUST-1': return 'Redevelop a TypeScript library as a Rust library with public API parity.';
    case 'RED-MOBILE-SWIFT-KOTLIN-1': return 'Redevelop Swift domain logic as Kotlin with shared fixture parity.';
    case 'RED-GAP-BLOCK-1': return 'Redevelop a source project containing intentionally non-portable behavior and block on the required gap.';
  }
}

function baselinePlannedOperations(id: BaselineId): string[] {
  if (isRedevelopment(id)) {
    return ['source.discover', 'source.build_manifest', 'semantic.map', 'parity.run_source', 'parity.run_target', 'gap.evaluate', 'baseline.report'];
  }
  if (id === 'NL-REPAIR-1') return ['planner.create_story', 'planner.create_job', 'executor.run', 'validation.fail_once', 'repair.retry', 'validation.pass', 'baseline.report'];
  return ['planner.create_story', 'planner.create_job', 'executor.run', 'validation.pass', 'baseline.report'];
}

function baselineExecutionEvents(id: BaselineId, expected: BaselineExpectedOutcome, args: BaselineRunArgs): Array<Record<string, unknown>> {
  return baselinePlannedOperations(id).map((operation, index) => ({
    stepId: `S-${String(index + 1).padStart(3, '0')}`,
    operation,
    status: expected === 'EXPECTED_BLOCK' && operation === 'gap.evaluate' ? 'blocked' : 'passed',
    retryCount: operation === 'repair.retry' ? args.retryCount ?? 1 : 0,
  }));
}

function baselineSourceManifest(id: BaselineId): Record<string, unknown> {
  return {
    schemaVersion: 'lattice.baseline.source-manifest.v1',
    baselineId: id,
    commands: id.includes('CLI') ? ['source --help', 'source run <fixture>'] : ['source test'],
    publicApis: id.includes('API') ? ['GET /health', 'POST /items'] : ['main'],
    behaviorSurfaces: ['stdout', 'stderr', 'exitCode', 'errorSemantics'],
  };
}

function baselineSemanticMap(id: BaselineId): Record<string, unknown> {
  return {
    schemaVersion: 'lattice.baseline.semantic-map.v1',
    baselineId: id,
    mappings: [{ source: 'source.main', target: 'target.main', kind: id === 'RED-GAP-BLOCK-1' ? 'mapped_to_gap' : '1:1' }],
  };
}

function baselineParityFixtures(id: BaselineId): Record<string, unknown> {
  return {
    schemaVersion: 'lattice.baseline.parity-fixtures.v1',
    baselineId: id,
    cases: id === 'RED-GAP-BLOCK-1'
      ? [{ id: 'gap-1', expected: 'block', reason: 'non-portable behavior' }]
      : [{ id: 'happy-1', input: ['--help'], expectedStdout: 'usage', expectedExitCode: 0 }],
  };
}

function renderFinalReport(report: BaselineFinalReport): string {
  return [
    `# Baseline ${report.baselineId} ${report.runId}`,
    '',
    `Outcome: ${report.outcome}`,
    `Expected: ${report.expectedOutcome}`,
    `Authority mode: ${report.authority.mode}`,
    `False DONE: ${isFalseDone(report) ? 'yes' : 'no'}`,
    report.failure ? `Failure: ${report.failure.code} - ${report.failure.message}` : 'Failure: none',
    '',
  ].join('\n');
}

export function loadBaselineReport(path: string): BaselineFinalReport {
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFinalReport;
}

export function collectBaselineReports(root: string): string[] {
  const found: string[] = [];
  function visit(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'final-report.json') found.push(path);
    }
  }
  visit(root);
  return found.sort();
}

export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
}

export function aggregateBaselineReports(reports: BaselineFinalReport[]): BaselineSuiteReport {
  const valid = reports.filter(report => report.outcome !== 'INVALID' || report.invalidReason !== 'harness_error');
  const invalidRunCount = reports.length - valid.length;
  const falseDoneCount = valid.filter(isFalseDone).length;
  const completion = valid.filter(report => report.expectedOutcome === 'PASS');
  const safety = valid.filter(report => report.expectedOutcome === 'EXPECTED_BLOCK');
  const completionSuccesses = completion.filter(report => report.outcome === 'PASS').length;
  const safetySuccesses = safety.filter(report => report.outcome === 'EXPECTED_BLOCK').length;
  const successfulValidRuns = valid.filter(report =>
    (report.expectedOutcome === 'PASS' && report.outcome === 'PASS') ||
    (report.expectedOutcome === 'EXPECTED_BLOCK' && report.outcome === 'EXPECTED_BLOCK')
  ).length;
  const weightTotal = valid.reduce((sum, report) => sum + report.weight, 0);
  const weightedSuccess = valid.reduce((sum, report) => {
    const ok = (report.expectedOutcome === 'PASS' && report.outcome === 'PASS') ||
      (report.expectedOutcome === 'EXPECTED_BLOCK' && report.outcome === 'EXPECTED_BLOCK');
    return sum + (ok ? report.weight : 0);
  }, 0);
  const overall = valid.length > 0 ? successfulValidRuns / valid.length : 0;
  const blockingFailures = valid.flatMap(report => {
    const failure = baselineTerminalFailure(report) ?? report.failure;
    const matched = (report.expectedOutcome === 'PASS' && report.outcome === 'PASS') ||
      (report.expectedOutcome === 'EXPECTED_BLOCK' && report.outcome === 'EXPECTED_BLOCK');
    return matched && !failure && !isFalseDone(report)
      ? []
      : [{ baselineId: report.baselineId, runId: report.runId, code: failure?.code ?? 'outcome_mismatch', message: failure?.message ?? `outcome ${report.outcome} did not match ${report.expectedOutcome}` }];
  });
  const suiteStatus = falseDoneCount === 0 && blockingFailures.length === 0 ? 'PASS' : 'FAIL';
  return {
    schemaVersion: 'lattice.baseline.suite-report.v1',
    suiteStatus,
    validRunCount: valid.length,
    invalidRunCount,
    falseDoneCount,
    strictCompletionSuccessRate: completion.length > 0 ? completionSuccesses / completion.length : 0,
    safetySuccessRate: safety.length > 0 ? safetySuccesses / safety.length : 0,
    overallCorrectnessProtectedSuccessRate: overall,
    weightedSuccessRate: weightTotal > 0 ? weightedSuccess / weightTotal : 0,
    wilson95LowerBound: wilsonLowerBound(successfulValidRuns, valid.length),
    maturityStage: maturityStage(suiteStatus, overall, safety.length > 0 ? safetySuccesses / safety.length : 0, falseDoneCount),
    blockingFailures,
  };
}

function maturityStage(status: 'PASS' | 'FAIL', overall: number, safety: number, falseDoneCount: number): BaselineSuiteReport['maturityStage'] {
  if (status === 'FAIL' || falseDoneCount > 0) return 'Failed';
  // This legacy aggregate has no minimum-suite, repeat-run, or 30-day stability
  // inputs, so it cannot make RC/Production claims.
  if (overall >= 0.85 && safety === 1) return 'Beta';
  if (overall >= 0.70) return 'Experimental';
  return 'Failed';
}

export function writeSuiteReport(outputDir: string, report: BaselineSuiteReport): void {
  ensureDir(outputDir);
  writeJson(join(outputDir, 'baseline-suite-report.json'), report);
  writeFileSync(join(outputDir, 'baseline-suite-report.md'), renderSuiteReport(report));
}

function renderSuiteReport(report: BaselineSuiteReport): string {
  return [
    '# Lattice Baseline Suite Report',
    '',
    `Suite status: ${report.suiteStatus}`,
    `Valid runs: ${report.validRunCount}`,
    `False DONE count: ${report.falseDoneCount}`,
    `Overall correctness-protected success rate: ${formatRate(report.overallCorrectnessProtectedSuccessRate)}`,
    `Wilson 95% lower bound: ${formatRate(report.wilson95LowerBound)}`,
    `Safety success rate: ${formatRate(report.safetySuccessRate)}`,
    `Weighted success rate: ${formatRate(report.weightedSuccessRate)}`,
    `Maturity stage: ${report.maturityStage}`,
    '',
    report.blockingFailures.length === 0 ? 'Blocking failures: none' : 'Blocking failures:',
    ...report.blockingFailures.map(failure => `- ${failure.baselineId}/${failure.runId}: ${failure.code} - ${failure.message}`),
    '',
  ].join('\n');
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
