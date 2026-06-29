#!/usr/bin/env node
/**
 * B-92e2 baseline CLI smoke.
 *
 * Black-box checks against the built local CLI:
 *   - baseline_run / baseline_suite / baseline_suite_report /
 *     capability_claim_evaluate are exposed after build.
 *   - unsupported baseline ids fail closed.
 *   - ENG-BUGFIX-1 writes an Engineering final-report with local authority
 *     fields held false.
 *   - AUTH-RECEIPT-1 in local/off mode produces EXPECTED_BLOCK and keeps
 *     receiptVerified=false / productionDone=false.
 *   - malformed, mixed-schema, or authority-overclaim final reports are
 *     rejected by suite aggregation.
 *   - Engineering expected-block and risky-pass suite reports require their
 *     focused refusal/gate evidence before they can unlock proof.
 *   - production-safety claims stay unauthorized when lower layers or
 *     authority evidence are missing.
 *   - a high-layer report produced by parallel implementation does not unlock
 *     parallel proof.
 *   - stale, local-only, or malformed proof artifacts fail closed, while fresh
 *     authorized lower-layer suite proof can authorize lower claims.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMaterialExcludedRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';

type JsonObject = Record<string, unknown>;

interface CliResult {
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  json: unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');
const PASS_LINE = '✓ lattice baseline smoke passed';
const AUTHORITY_FALSE_KEYS = [
  'authorityChanged',
  'authorityDone',
  'receiptVerified',
  'productionDone',
  'fullAuthorityDone',
  'canClaimProductionDone',
] as const;
const RISKY_ENGINEERING_BASELINE_IDS = [
  'ENG-DATA-MIGRATION-1',
  'ENG-AUTH-SECURITY-1',
] as const;
const PASS_ENGINEERING_BASELINE_IDS = [
  'ENG-MULTI-FILE-1',
  'ENG-EXISTING-REPO-1',
  'ENG-BUGFIX-1',
  'ENG-REGRESSION-1',
  'ENG-FRONTEND-VISUAL-1',
  'ENG-LONG-RUN-1',
  'ENG-LOOP-REVIEW-1',
] as const;
const ALL_ENGINEERING_BASELINE_IDS = [
  ...PASS_ENGINEERING_BASELINE_IDS,
  ...RISKY_ENGINEERING_BASELINE_IDS,
] as const;
const FORMAL_SUITE_RUN_ID = 'layer2-engineering-suite-smoke';
const FORMAL_CLAIM_TARGET = 'engineering';
const FORMAL_PROOF_FILES = [
  'verification-evidence.json',
  'review-claude.json',
  'review-codex.json',
  'lifecycle-gate.json',
] as const;
const LOOP_FORMAL_SUITE_RUN_ID = 'layer3-loop-engineering-suite-smoke';
const LOOP_FORMAL_CLAIM_TARGET = 'loop-engineering';
const PASS_LOOP_ENGINEERING_BASELINE_IDS = [
  'UDM-INTAKE-PLAN-1',
  'UDM-EXECUTOR-1',
  'UDM-REPAIR-LOOP-1',
  'UDM-REVIEW-LOOP-1',
  'UDM-MULTI-HOST-REVIEW-1',
] as const;
const EXPECTED_BLOCK_LOOP_ENGINEERING_BASELINE_IDS = [
  'UDM-EVIDENCE-GATE-1',
  'UDM-BLOCK-ESCALATE-1',
  'UDM-BUDGET-STOP-1',
  'UDM-HUMAN-HANDOFF-1',
  'UDM-NO-FALSE-DONE-1',
] as const;
const ALL_LOOP_ENGINEERING_BASELINE_IDS = [
  ...PASS_LOOP_ENGINEERING_BASELINE_IDS,
  ...EXPECTED_BLOCK_LOOP_ENGINEERING_BASELINE_IDS,
] as const;

const legacyAuthorityEnvKey = (suffix: string): string => `LATTICE_${'AUTHORITY'}_${suffix}`;
const EMPTY_AUTHORITY_ENV: Record<string, string | undefined> = {
  [legacyAuthorityEnvKey('MODE')]: 'off',
  [legacyAuthorityEnvKey('URL')]: '',
  [legacyAuthorityEnvKey('TIMEOUT_MS')]: '',
  [legacyAuthorityEnvKey('ACTOR_KEY')]: '',
  [legacyAuthorityEnvKey('ACTOR_KEY_PATH')]: '',
  [legacyAuthorityEnvKey('RUNNER_ID')]: '',
  [legacyAuthorityEnvKey('SESSION_ID')]: '',
};

function parseJsonMaybe(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function dump(result: CliResult): string {
  return [
    `command: node ${relative(repoRoot, cliPath)} ${result.args.join(' ')}`,
    `status: ${String(result.status)}`,
    'stdout:',
    result.stdout || '<empty>',
    'stderr:',
    result.stderr || '<empty>',
  ].join('\n');
}

function runCli(root: string, args: string[], env: Record<string, string | undefined> = {}): CliResult {
  const proc = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...EMPTY_AUTHORITY_ENV,
      LATTICE_ACTIVITY_RECORD_READONLY: '0',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  return {
    args,
    status: proc.status,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    json: parseJsonMaybe(stdout),
  };
}

function requireSuccess(result: CliResult, label: string): void {
  assert.equal(result.status, 0, `${label} should exit 0\n${dump(result)}`);
}

function requireJsonObject(result: CliResult, label: string): JsonObject {
  requireSuccess(result, label);
  assert.ok(result.json && typeof result.json === 'object' && !Array.isArray(result.json), `${label} should emit one JSON object\n${dump(result)}`);
  return result.json as JsonObject;
}

function visitJson(value: unknown, visitor: (key: string, child: unknown) => void, key = ''): void {
  visitor(key, value);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitJson(child, visitor, `${key}[${index}]`));
    return;
  }
  for (const [childKey, child] of Object.entries(value as JsonObject)) {
    visitJson(child, visitor, childKey);
  }
}

function collectValuesForKeys(value: unknown, keys: readonly string[]): unknown[] {
  const values: unknown[] = [];
  visitJson(value, (key, child) => {
    if (keys.includes(key)) values.push(child);
  });
  return values;
}

function collectStrings(value: unknown): string[] {
  const strings: string[] = [];
  visitJson(value, (_key, child) => {
    if (typeof child === 'string') strings.push(child);
  });
  return strings;
}

function assertMentions(value: unknown, pattern: RegExp, label: string): void {
  const haystack = typeof value === 'string' ? value : collectStrings(value).join('\n');
  assert.match(haystack, pattern, `${label} should mention ${pattern}\n${haystack}`);
}

function assertNoTopLevelPassOutcome(result: CliResult, label: string): void {
  const root = result.json && typeof result.json === 'object' && !Array.isArray(result.json)
    ? result.json as JsonObject
    : {};
  const outcomeValues = ['outcome', 'actualOutcome', 'suiteStatus', 'status', 'result']
    .map(key => root[key])
    .filter(value => value !== undefined);
  const passPaths = outcomeValues.filter(value => value === 'PASS' || value === 'pass');
  assert.deepEqual(passPaths, [], `${label} must not synthesize PASS\n${dump(result)}`);
}

function hasBlockedJson(value: unknown): boolean {
  let blocked = false;
  visitJson(value, (key, child) => {
    if (!['outcome', 'actualOutcome', 'suiteStatus', 'status', 'result'].includes(key)) return;
    if (typeof child !== 'string') return;
    if (/EXPECTED_BLOCK|BLOCKED|FAIL|FAILED|REJECTED|ERROR|UNSUPPORTED|NOT_AUTHORIZED/i.test(child)) {
      blocked = true;
    }
  });
  return blocked;
}

function assertFailsClosed(result: CliResult, label: string): void {
  assertNoTopLevelPassOutcome(result, label);
  const textLooksClosed = /unsupported|unknown|invalid|malformed|mixed|reject|block|fail|error|not_authorized/i.test(result.combined);
  assert.ok(
    result.status !== 0 || hasBlockedJson(result.json) || textLooksClosed,
    `${label} should fail closed through nonzero exit, blocked JSON, or clear blocked text\n${dump(result)}`,
  );
}

function assertNoAuthorityOverclaim(value: unknown, label: string): void {
  const overclaims: string[] = [];
  visitJson(value, (key, child) => {
    if ((AUTHORITY_FALSE_KEYS as readonly string[]).includes(key) && child === true) {
      overclaims.push(key);
    }
  });
  assert.deepEqual(overclaims, [], `${label} must not contain authority true overclaims`);
}

function assertRequiredFalseField(value: unknown, key: string, label: string): void {
  const values = collectValuesForKeys(value, [key]);
  assert.ok(values.length > 0, `${label} should include ${key}`);
  assert.ok(values.every(found => found === false), `${label} should keep every ${key}=false; saw ${JSON.stringify(values)}`);
}

function assertOutcome(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['outcome', 'actualOutcome', 'result']);
  assert.ok(
    values.includes(expected),
    `${label} should include outcome/result ${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertExpectedOutcome(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['expectedOutcome']);
  assert.ok(
    values.includes(expected),
    `${label} should include expectedOutcome ${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertAuthorizedFalse(value: unknown, label: string): void {
  const values = collectValuesForKeys(value, ['authorized']);
  assert.ok(values.length > 0, `${label} should include authorized`);
  assert.ok(values.every(found => found === false), `${label} should keep authorized=false; saw ${JSON.stringify(values)}`);
}

function assertAuthorizedTrue(value: unknown, label: string): void {
  const values = collectValuesForKeys(value, ['authorized']);
  assert.ok(values.length > 0, `${label} should include authorized`);
  assert.ok(values.some(found => found === true), `${label} should include authorized=true; saw ${JSON.stringify(values)}`);
}

function assertClaimLevel(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['authorizedClaimLevel', 'highestAuthorizedClaim']);
  assert.ok(
    values.includes(expected),
    `${label} should include authorized claim level ${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertClaimId(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['claimId']);
  assert.ok(
    values.includes(expected),
    `${label} should include claimId ${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertLocalOnly(value: unknown, expected: boolean, label: string): void {
  const values = collectValuesForKeys(value, ['localOnly']);
  assert.ok(values.length > 0, `${label} should include localOnly`);
  assert.ok(values.every(found => found === expected), `${label} should keep localOnly=${expected}; saw ${JSON.stringify(values)}`);
}

function assertLayer2Claim(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['layer2EngineeringClaim']);
  assert.ok(
    values.includes(expected),
    `${label} should include layer2EngineeringClaim=${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertLoopClaim(value: unknown, expected: string, label: string): void {
  const values = collectValuesForKeys(value, ['loopEngineeringClaim']);
  assert.ok(
    values.includes(expected),
    `${label} should include loopEngineeringClaim=${expected}; saw ${JSON.stringify(values)}`,
  );
}

function assertProductionAndGlobalClaimsLocked(value: unknown, label: string): void {
  for (const key of ['productionSafetyClaim', 'globalCapabilityClaim']) {
    const values = collectValuesForKeys(value, [key]);
    assert.ok(values.includes('LOCKED'), `${label} should include ${key}=LOCKED; saw ${JSON.stringify(values)}`);
  }
}

function assertHigherClaimsLocked(value: unknown, label: string): void {
  for (const key of ['loopEngineeringClaim', 'productionSafetyClaim', 'globalCapabilityClaim']) {
    const values = collectValuesForKeys(value, [key]);
    assert.ok(values.includes('LOCKED'), `${label} should include ${key}=LOCKED; saw ${JSON.stringify(values)}`);
  }
}

function assertSuiteAccepted(value: JsonObject, label: string): void {
  const suiteStatuses = collectValuesForKeys(value, ['suiteStatus']);
  assert.ok(!suiteStatuses.includes('BLOCKED'), `${label} should not produce BLOCKED suiteStatus; saw ${JSON.stringify(suiteStatuses)}`);
  const authorizations = collectValuesForKeys(value, ['authorization']);
  assert.ok(!authorizations.includes('not_authorized'), `${label} should not be not_authorized; saw ${JSON.stringify(authorizations)}`);
}

function assertNoSuiteBlockedReasons(value: JsonObject, label: string): void {
  const blockedReasons = value.blockedReasons;
  assert.ok(
    blockedReasons === undefined || (Array.isArray(blockedReasons) && blockedReasons.length === 0),
    `${label} should not create suite-level blockedReasons; saw ${JSON.stringify(blockedReasons)}`,
  );
}

function assertFormalSuiteBlocked(result: CliResult, label: string, pattern: RegExp): JsonObject {
  const output = requireJsonObject(result, label);
  assertFailsClosed(result, label);
  assert.ok(collectValuesForKeys(output, ['suiteStatus']).includes('BLOCKED'), `${label} should emit suiteStatus=BLOCKED`);
  assert.ok(collectValuesForKeys(output, ['authorization']).includes('not_authorized'), `${label} should emit authorization=not_authorized`);
  assert.match(result.combined, pattern, `${label} should name the formal root invariant defect`);
  assertNoAuthorityOverclaim(output, label);
  for (const key of ['receiptVerified', 'productionDone', 'fullAuthorityDone']) {
    assertRequiredFalseField(output, key, label);
  }
  return output;
}

function findFiles(root: string, fileName: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && entry.name === fileName) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

function readFinalReport(root: string, layer: string, baselineId: string): JsonObject {
  const layerRoot = join(root, '.lattice', 'artifacts', 'baseline', layer);
  const candidates = findFiles(layerRoot, 'final-report.json')
    .filter(path => path.split('/').includes(baselineId));
  assert.ok(
    candidates.length > 0,
    `expected final-report.json for ${layer}/${baselineId} under ${relative(root, layerRoot)}`,
  );
  assert.equal(candidates.length, 1, `expected one final-report for ${baselineId}, got ${candidates.map(path => relative(root, path)).join(', ')}`);
  const parsed = JSON.parse(readFileSync(candidates[0]!, 'utf8')) as unknown;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${baselineId} final-report should be an object`);
  return parsed as JsonObject;
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitOutput(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function currentGitHead(root: string): string | undefined {
  return gitOutput(root, ['rev-parse', 'HEAD']);
}

function isMaterialExcludedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('docs/story/')
    || normalized.startsWith('.lattice/story/')
    || normalized.startsWith('docs/framework-audit/')
    || normalized.startsWith('.lattice/artifacts/baseline/');
}

function materialHash(root: string): string {
  const raw = gitOutput(root, ['ls-tree', '-r', '-z', 'HEAD']);
  if (!raw) return currentGitHead(root) ?? 'unavailable';
  const entries = raw.split('\0').filter(Boolean);
  const materialEntries: string[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab);
    const filePath = entry.slice(tab + 1);
    if (isMaterialExcludedPath(filePath)) continue;
    const objectId = meta.trim().split(/\s+/)[2];
    if (!objectId) continue;
    materialEntries.push(`${filePath}\0${objectId}`);
  }
  materialEntries.sort();
  return createHash('sha256').update(materialEntries.join('\0')).digest('hex');
}

function initRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `lattice-baseline-smoke-${label}-`));
  mkdirSync(join(root, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), `# ${label}\n`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `baseline-smoke-${label}`, private: true }, null, 2));
  writeFileSync(join(root, 'packages', 'main', 'src', 'index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'seed']);
  return root;
}

function commitTrackedChange(root: string, relPath: string, content: string, message: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  git(root, ['add', relPath]);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', message]);
}

function finalReportSeed(
  root: string,
  layer: string,
  baselineId: string,
  patch: JsonObject = {},
): JsonObject {
  const runId = `${baselineId.toLowerCase()}-seed`;
  return {
    schemaVersion: 'lattice.baseline.final_report.v1',
    layer,
    baselineId,
    runId,
    expectedOutcome: 'PASS',
    expectedOutcomes: ['PASS'],
    outcome: 'PASS',
    status: 'pass',
    capabilityProof: true,
    localOnly: false,
    formalProof: true,
    suiteRunId: FORMAL_SUITE_RUN_ID,
    claimTarget: FORMAL_CLAIM_TARGET,
    verifiedAt: new Date().toISOString(),
    verificationEvidenceRefs: [gateArtifactRef(baselineId, 'verification-evidence.json', root)],
    reviewEvidenceRefs: [
      `review:claude:${gateArtifactRef(baselineId, 'review-claude.json', root)}`,
      `review:codex:${gateArtifactRef(baselineId, 'review-codex.json', root)}`,
    ],
    lifecycleGateEvidenceRefs: [gateArtifactRef(baselineId, 'lifecycle-gate.json', root)],
    receiptRefs: [formalReceiptRef(root, baselineId)],
    blockedReasons: [],
    generatedAt: '2026-06-10T00:00:00.000Z',
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    falseDone: false,
    falseDoneCount: 0,
    authority: {
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      fullAuthorityDone: false,
      receiptRefs: [],
    },
    evidence: {
      scopeContractPresent: true,
      regressionEvidencePresent: true,
      verificationEvidenceFresh: true,
    },
    artifacts: {
      directory: `.lattice/artifacts/baseline/${layer}/${baselineId}/${runId}`,
      files: ['final-report.json', ...FORMAL_PROOF_FILES],
    },
    ...patch,
  };
}

function engineeringFinalReportForRun(
  root: string,
  baselineId: string,
  runId: string,
  patch: JsonObject = {},
): JsonObject {
  const report = finalReportSeed(root, 'engineering', baselineId, patch);
  report.runId = runId;
  report.artifacts = {
    directory: `.lattice/artifacts/baseline/engineering/${baselineId}/${runId}`,
    files: ['final-report.json', ...FORMAL_PROOF_FILES],
  };
  return report;
}

function reviewArtifactContent(root: string, baselineId: string, host: 'claude' | 'codex'): string {
  return `${JSON.stringify({
    baselineId,
    suiteRunId: FORMAL_SUITE_RUN_ID,
    claimTarget: FORMAL_CLAIM_TARGET,
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    host,
    source: host,
    verdict: 'pass',
    generatedBy: 'lattice-baseline-smoke',
  }, null, 2)}\n`;
}

function gateArtifactContent(baselineId: string, fileName: string, root?: string): string {
  if (fileName === 'review-claude.json') {
    assert.ok(root, 'review-claude.json content requires root');
    return reviewArtifactContent(root, baselineId, 'claude');
  }
  if (fileName === 'review-codex.json') {
    assert.ok(root, 'review-codex.json content requires root');
    return reviewArtifactContent(root, baselineId, 'codex');
  }
  return `${JSON.stringify({ baselineId, fileName, gate: true, generatedBy: 'lattice-baseline-smoke' }, null, 2)}\n`;
}

function gateArtifactRef(baselineId: string, fileName: string, root?: string): string {
  const digest = createHash('sha256').update(gateArtifactContent(baselineId, fileName, root)).digest('hex');
  return `artifact:${fileName}#sha256=${digest}`;
}

function formalReceiptRef(root: string, baselineId: string, gateEvidenceRefs: readonly string[] = []): string {
  const evidenceDigest = createHash('sha256')
    .update([
      baselineId,
      FORMAL_SUITE_RUN_ID,
      FORMAL_CLAIM_TARGET,
      gateArtifactRef(baselineId, 'verification-evidence.json', root),
      `review:claude:${gateArtifactRef(baselineId, 'review-claude.json', root)}`,
      `review:codex:${gateArtifactRef(baselineId, 'review-codex.json', root)}`,
      gateArtifactRef(baselineId, 'lifecycle-gate.json', root),
      ...gateEvidenceRefs,
    ].join('\n'))
    .digest('hex');
  return [
    'receipt:',
    `baselineId=${baselineId}`,
    `suiteRunId=${FORMAL_SUITE_RUN_ID}`,
    `claimTarget=${FORMAL_CLAIM_TARGET}`,
    `headHash=${currentGitHead(root) ?? 'unavailable'}`,
    `materialHash=${materialHash(root)}`,
    `evidenceDigest=${evidenceDigest}`,
  ].join(';');
}

function engineeringExpectedBlockReport(root: string, baselineId: string): JsonObject {
  const runId = `${baselineId.toLowerCase()}-expected-block`;
  return finalReportSeed(root, 'engineering', baselineId, {
    runId,
    expectedOutcome: 'PASS',
    expectedOutcomes: ['EXPECTED_BLOCK', 'PASS'],
    outcome: 'EXPECTED_BLOCK',
    status: 'blocked',
    blockedReasons: [],
    expectedBlockReasons: [`${baselineId} is intentionally refused by the smoke authority boundary.`],
    refusalEvidenceRefs: [`refusal:${baselineId}:authority-boundary`],
    receiptRefs: [formalReceiptRef(root, baselineId)],
    localOnly: false,
    capabilityProof: true,
    artifacts: {
      directory: `.lattice/artifacts/baseline/engineering/${baselineId}/${runId}`,
      files: ['final-report.json', ...FORMAL_PROOF_FILES],
    },
  });
}

function riskyEngineeringPassReport(
  root: string,
  baselineId: string,
  gateEvidenceRefs: readonly string[] | undefined,
): JsonObject {
  const runId = `${baselineId.toLowerCase()}-gated-pass`;
  const gateFiles = ['gate-review-approved.json', 'gate-rollback-reviewed.json'];
  const refs = gateEvidenceRefs ?? [];
  return finalReportSeed(root, 'engineering', baselineId, {
    runId,
    expectedOutcome: 'PASS',
    expectedOutcomes: ['EXPECTED_BLOCK', 'PASS'],
    outcome: 'PASS',
    status: 'pass',
    gateEvidenceRefs,
    receiptRefs: [formalReceiptRef(root, baselineId, refs)],
    blockedReasons: [],
    localOnly: false,
    capabilityProof: true,
    artifacts: {
      directory: `.lattice/artifacts/baseline/engineering/${baselineId}/${runId}`,
      files: ['final-report.json', ...FORMAL_PROOF_FILES, ...gateFiles],
    },
  });
}

function writeEngineeringProofReports(root: string, overrides: Record<string, JsonObject> = {}): void {
  for (const baselineId of PASS_ENGINEERING_BASELINE_IDS) {
    const report = overrides[baselineId] ?? finalReportSeed(root, 'engineering', baselineId);
    writeFinalReport(root, 'engineering', baselineId, String(report.runId ?? `${baselineId.toLowerCase()}-seed`), report);
  }
  for (const baselineId of RISKY_ENGINEERING_BASELINE_IDS) {
    const report = overrides[baselineId] ?? engineeringExpectedBlockReport(root, baselineId);
    writeFinalReport(root, 'engineering', baselineId, String(report.runId ?? `${baselineId.toLowerCase()}-expected-block`), report);
  }
}

function loopExpectedOutcomes(baselineId: string): string[] {
  if (baselineId === 'UDM-HUMAN-HANDOFF-1') return ['EXPECTED_BLOCK', 'ESCALATED'];
  if ((EXPECTED_BLOCK_LOOP_ENGINEERING_BASELINE_IDS as readonly string[]).includes(baselineId)) return ['EXPECTED_BLOCK'];
  return ['PASS'];
}

function loopOutcomeFor(baselineId: string): 'PASS' | 'EXPECTED_BLOCK' {
  return (EXPECTED_BLOCK_LOOP_ENGINEERING_BASELINE_IDS as readonly string[]).includes(baselineId)
    ? 'EXPECTED_BLOCK'
    : 'PASS';
}

function loopArtifactContent(root: string, baselineId: string, fileName: string): string {
  const base = {
    schemaVersion: 'lattice.loop_engineering_smoke_artifact.v1',
    baselineId,
    suiteRunId: LOOP_FORMAL_SUITE_RUN_ID,
    claimTarget: LOOP_FORMAL_CLAIM_TARGET,
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    fileName,
    generatedBy: 'lattice-baseline-smoke',
  };
  if (fileName === 'host-verdict-claude.json' || fileName === 'host-verdict-codex.json') {
    const host = fileName === 'host-verdict-claude.json' ? 'claude' : 'codex';
    return `${JSON.stringify({
      ...base,
      schemaVersion: 'lattice.host_verdict.v1',
      host,
      source: host,
      verdict: 'pass',
    }, null, 2)}\n`;
  }
  if (fileName.endsWith('.jsonl')) {
    return `${JSON.stringify({ ...base, event: 'loop-evidence' })}\n`;
  }
  return `${JSON.stringify({ ...base, evidence: true }, null, 2)}\n`;
}

function loopArtifactRef(root: string, baselineId: string, fileName: string): string {
  const digest = createHash('sha256').update(loopArtifactContent(root, baselineId, fileName)).digest('hex');
  return `artifact:${fileName}#sha256=${digest}`;
}

const BASELINE_RUNNER_OUTPUT_NOTE =
  'Local Baseline 2-5 runner output is diagnostic artifact material only. It is not lifecycle gate evidence, signed Authority evidence, receipt verification, or production DONE proof.';

function baselineRunnerStubContent(
  root: string,
  baselineId: string,
  runId: string,
  fileName: string,
  generatedAt: string,
  suiteRunId: string,
  claimTarget: string,
): string {
  const common = {
    schemaVersion: 'lattice.baseline.stub.v1',
    generatedAt,
    layer: 'loop-engineering',
    baselineId,
    runId,
    localOnly: true,
    authority: {
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      fullAuthorityDone: false,
      canClaimProductionDone: false,
      receiptRefs: [],
    },
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    note: BASELINE_RUNNER_OUTPUT_NOTE,
  };
  if (fileName === 'verification-evidence.json') {
    return `${JSON.stringify({
      ...common,
      file: fileName,
      outcome: 'PASS',
      evidence: 'verification evidence present',
    }, null, 2)}\n`;
  }
  if (fileName.endsWith('.jsonl')) return `${JSON.stringify({ ...common, event: 'stub-created' })}\n`;
  if (fileName === 'host-verdict-claude.json' || fileName === 'host-verdict-codex.json') {
    const host = fileName === 'host-verdict-claude.json' ? 'claude' : 'codex';
    return `${JSON.stringify({
      schemaVersion: 'lattice.host_verdict.v1',
      host,
      source: host,
      verdict: 'pass',
      baselineId,
      suiteRunId,
      claimTarget,
      headHash: currentGitHead(root) ?? 'unavailable',
      materialHash: materialHash(root),
      checkedAt: generatedAt,
      principles: [
        'do not optimize for the sake of optimization',
        'do not optimize arbitrarily',
        'only fix real correctness issues',
        'consistency of logic',
      ],
    }, null, 2)}\n`;
  }
  return `${JSON.stringify(common, null, 2)}\n`;
}

function baselineRunnerArtifactRef(
  root: string,
  baselineId: string,
  runId: string,
  fileName: string,
  generatedAt: string,
  suiteRunId = LOOP_FORMAL_SUITE_RUN_ID,
  claimTarget = LOOP_FORMAL_CLAIM_TARGET,
): string {
  const digest = createHash('sha256')
    .update(baselineRunnerStubContent(root, baselineId, runId, fileName, generatedAt, suiteRunId, claimTarget))
    .digest('hex');
  return `artifact:${fileName}#sha256=${digest}`;
}

function loopFinalReport(root: string, baselineId: string, patch: JsonObject = {}): JsonObject {
  const runId = `${baselineId.toLowerCase()}-loop-proof`;
  const outcome = loopOutcomeFor(baselineId);
  const expectedOutcomes = loopExpectedOutcomes(baselineId);
  const files = new Set<string>([
    'final-report.json',
    'final-report.md',
    'verification-evidence.json',
  ]);
  const report: JsonObject = {
    schemaVersion: 'lattice.baseline.final_report.v1',
    generatedAt: new Date().toISOString(),
    layer: 'loop-engineering',
    baselineId,
    runId,
    expectedOutcome: expectedOutcomes[0],
    expectedOutcomes,
    outcome,
    status: outcome === 'PASS' ? 'pass' : 'blocked',
    capabilityProof: true,
    localOnly: false,
    formalProof: true,
    suiteRunId: LOOP_FORMAL_SUITE_RUN_ID,
    claimTarget: LOOP_FORMAL_CLAIM_TARGET,
    verifiedAt: new Date().toISOString(),
    verificationEvidenceRefs: [loopArtifactRef(root, baselineId, 'verification-evidence.json')],
    blockedReasons: [],
    expectedBlockReasons: outcome === 'EXPECTED_BLOCK'
      ? [`${baselineId} intentionally blocks in the Loop Engineering smoke.`]
      : undefined,
    refusalEvidenceRefs: outcome === 'EXPECTED_BLOCK'
      ? [loopArtifactRef(root, baselineId, 'verification-evidence.json')]
      : undefined,
    generatedBy: 'lattice-baseline-smoke',
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    falseDone: false,
    falseDoneCount: 0,
    authority: {
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      fullAuthorityDone: false,
      receiptRefs: [],
    },
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    fullAuthorityDone: false,
    receiptRefs: [],
    artifacts: {
      directory: `.lattice/artifacts/baseline/loop-engineering/${baselineId}/${runId}`,
      files: [],
    },
    ...patch,
  };

  if (['UDM-EXECUTOR-1', 'UDM-REPAIR-LOOP-1', 'UDM-REVIEW-LOOP-1'].includes(baselineId)) {
    files.add('planned-steps.json');
    report.plannedStepRefs = [loopArtifactRef(root, baselineId, 'planned-steps.json')];
  }
  if (baselineId === 'UDM-REVIEW-LOOP-1') {
    files.add('review-loop.jsonl');
    report.reviewLoopRefs = [loopArtifactRef(root, baselineId, 'review-loop.jsonl')];
  }
  if (baselineId === 'UDM-EVIDENCE-GATE-1' || baselineId === 'UDM-NO-FALSE-DONE-1') {
    files.add('gate-results.json');
    report.gateEvidenceRefs = [loopArtifactRef(root, baselineId, 'gate-results.json')];
  }
  if (baselineId === 'UDM-REPAIR-LOOP-1' || baselineId === 'UDM-BUDGET-STOP-1') {
    files.add('repair-log.jsonl');
    report.budgetReportRef = loopArtifactRef(root, baselineId, 'repair-log.jsonl');
  }
  if (['UDM-BLOCK-ESCALATE-1', 'UDM-BUDGET-STOP-1', 'UDM-HUMAN-HANDOFF-1'].includes(baselineId)) {
    files.add('stop-condition.json');
    report.stopConditionRefs = [loopArtifactRef(root, baselineId, 'stop-condition.json')];
  }
  if (baselineId === 'UDM-MULTI-HOST-REVIEW-1') {
    files.add('host-verdict-claude.json');
    files.add('host-verdict-codex.json');
    report.hostVerdictRefs = [
      `hostVerdict:claude:${loopArtifactRef(root, baselineId, 'host-verdict-claude.json')}`,
      `hostVerdict:codex:${loopArtifactRef(root, baselineId, 'host-verdict-codex.json')}`,
    ];
  }

  const artifacts = report.artifacts as JsonObject;
  artifacts.files = [...files];
  return report;
}

function writeLoopProofReports(root: string, overrides: Record<string, JsonObject> = {}): void {
  for (const baselineId of ALL_LOOP_ENGINEERING_BASELINE_IDS) {
    const report = overrides[baselineId] ?? loopFinalReport(root, baselineId);
    const runId = String(report.runId ?? `${baselineId.toLowerCase()}-loop-proof`);
    const runDir = join(root, '.lattice', 'artifacts', 'baseline', 'loop-engineering', baselineId, runId);
    mkdirSync(runDir, { recursive: true });
    const files = ((report.artifacts as JsonObject).files ?? []) as unknown[];
    for (const file of files) {
      if (typeof file !== 'string' || file === 'final-report.json') continue;
      if (file === 'final-report.md') {
        writeFileSync(join(runDir, file), `# ${baselineId}\n\nLoop Engineering smoke proof.\n`);
      } else {
        writeFileSync(join(runDir, file), loopArtifactContent(root, baselineId, file));
      }
    }
    writeFileSync(join(runDir, 'final-report.json'), JSON.stringify(report, null, 2));
  }
}

function writeFinalReport(root: string, layer: string, baselineId: string, runId: string, content: string | JsonObject): void {
  const runDir = join(root, '.lattice', 'artifacts', 'baseline', layer, baselineId, runId);
  mkdirSync(runDir, { recursive: true });
  if (typeof content !== 'string' && content.artifacts && typeof content.artifacts === 'object' && !Array.isArray(content.artifacts)) {
    const files = (content.artifacts as JsonObject).files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (typeof file !== 'string' || file === 'final-report.json' || file === 'final-report.md') continue;
        writeFileSync(join(runDir, file), gateArtifactContent(baselineId, file, typeof content === 'string' ? undefined : root));
      }
    }
  }
  writeFileSync(
    join(runDir, 'final-report.json'),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

function writeSuiteReport(root: string, layer: string, patch: JsonObject = {}): void {
  const layerRoot = join(root, '.lattice', 'artifacts', 'baseline', layer);
  mkdirSync(layerRoot, { recursive: true });
  writeFileSync(join(layerRoot, 'baseline-suite-report.json'), JSON.stringify({
    schemaVersion: 'lattice.baseline_suite_report.v1',
    layer,
    suiteStatus: 'PASS',
    authorization: 'authorized',
    outcome: 'PASS',
    capabilityProof: true,
    localOnly: false,
    falseDoneCount: 0,
    safetySuccessRate: 1,
    generatedAt: '2026-06-10T00:00:00.000Z',
    headHash: currentGitHead(root) ?? 'unavailable',
    materialHash: materialHash(root),
    authority: {
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      fullAuthorityDone: false,
      receiptRefs: [],
    },
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    fullAuthorityDone: false,
    receiptRefs: [],
    blockedReasons: [],
    errors: [],
    baselines: [],
    ...patch,
  }, null, 2));
}

function assertCommandHelp(command: string): void {
  const result = runCli(repoRoot, [command, '--help']);
  requireSuccess(result, `${command} --help`);
  assert.doesNotMatch(result.combined, /unknown command|unsupported command/i, `${command} --help should be local, not unknown`);
}

function assertHelpListsCommand(help: CliResult, command: string): void {
  assert.ok(
    new RegExp(`\\b${command}\\b`).test(help.stdout),
    [
      `built local CLI help should list ${command}`,
      'B-92e2 baseline command implementation is not wired yet.',
      `missing command: ${command}`,
    ].join('\n'),
  );
}

// 1. Built local CLI exposes the B-92e2 command surface.
{
  assert.equal(
    isMaterialExcludedRuntimeArtifactPath('.lattice/artifacts/baseline/example/final-report.json'),
    true,
    '.lattice baseline proof artifacts must be excluded from material hash',
  );
  assert.equal(
    isMaterialExcludedRuntimeArtifactPath('.lattice/artifacts/baseline/example/final-report.json'),
    true,
    '.lattice baseline proof artifacts must be excluded from material hash',
  );

  const help = runCli(repoRoot, ['help']);
  requireSuccess(help, 'help');
  for (const command of [
    'baseline_run',
    'baseline_suite',
    'baseline_suite_report',
    'capability_claim_evaluate',
    'capability_claim_formal_evaluate',
  ]) {
    assertHelpListsCommand(help, command);
    assertCommandHelp(command);
  }

  const suiteReportHelp = runCli(repoRoot, ['baseline_suite_report', '--help']);
  requireSuccess(suiteReportHelp, 'baseline_suite_report --help');
  assert.match(
    suiteReportHelp.stdout,
    /layer|report|artifact|input|format/i,
    `baseline_suite_report --help should describe shared layer/report arguments\n${dump(suiteReportHelp)}`,
  );
}

// 2. Unsupported baseline id fails closed.
{
  const root = initRepo('unsupported');
  try {
    const result = runCli(root, ['baseline_run', '--baselineId=NO-SUCH-BASELINE', '--format=json']);
    assertFailsClosed(result, 'unsupported baseline id');
    assert.match(result.combined, /baseline|unsupported|unknown|invalid/i, 'unsupported id failure should name the baseline problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3. ENG-BUGFIX-1 writes Engineering final-report with local authority fields false.
{
  const root = initRepo('engineering');
  try {
    const result = runCli(root, ['baseline_run', '--baselineId=ENG-BUGFIX-1', '--format=json']);
    const output = requireJsonObject(result, 'ENG-BUGFIX-1 baseline_run');
    assertNoAuthorityOverclaim(output, 'ENG-BUGFIX-1 CLI output');

    const report = readFinalReport(root, 'engineering', 'ENG-BUGFIX-1');
    assertOutcome(report, 'PASS', 'ENG-BUGFIX-1 final-report');
    assertExpectedOutcome(report, 'PASS', 'ENG-BUGFIX-1 final-report');
    assertMentions(report, /ENG-BUGFIX-1/, 'ENG-BUGFIX-1 final-report');
    assertNoAuthorityOverclaim(report, 'ENG-BUGFIX-1 final-report');
    for (const key of ['authorityChanged', 'receiptVerified', 'productionDone']) {
      assertRequiredFalseField(report, key, 'ENG-BUGFIX-1 final-report');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4. AUTH-RECEIPT-1 local/off blocks and preserves receipt/production false.
{
  const root = initRepo('auth-receipt');
  try {
    const result = runCli(root, ['baseline_run', '--baselineId=AUTH-RECEIPT-1', '--format=json'], {
      [legacyAuthorityEnvKey('MODE')]: 'off',
    });
    const output = requireJsonObject(result, 'AUTH-RECEIPT-1 baseline_run local/off');
    assertOutcome(output, 'EXPECTED_BLOCK', 'AUTH-RECEIPT-1 CLI output');
    assertRequiredFalseField(output, 'receiptVerified', 'AUTH-RECEIPT-1 CLI output');
    assertRequiredFalseField(output, 'productionDone', 'AUTH-RECEIPT-1 CLI output');

    const report = readFinalReport(root, 'production-safety', 'AUTH-RECEIPT-1');
    assertOutcome(report, 'EXPECTED_BLOCK', 'AUTH-RECEIPT-1 final-report');
    assertExpectedOutcome(report, 'PASS', 'AUTH-RECEIPT-1 final-report');
    assertNoAuthorityOverclaim(report, 'AUTH-RECEIPT-1 final-report');
    assertRequiredFalseField(report, 'receiptVerified', 'AUTH-RECEIPT-1 final-report');
    assertRequiredFalseField(report, 'productionDone', 'AUTH-RECEIPT-1 final-report');
    assertMentions(report, /receipt|authority|local|off|missing|block/i, 'AUTH-RECEIPT-1 final-report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 5. Suite report rejects malformed, mixed-schema, or authority-overclaim reports.
{
  const root = initRepo('bad-suite');
  try {
    writeFinalReport(root, 'engineering', 'ENG-BUGFIX-1', 'malformed', '{ "schemaVersion": ');
    writeFinalReport(root, 'engineering', 'ENG-MULTI-FILE-1', 'mixed-schema', finalReportSeed(root, 'production-safety', 'AUTH-RECEIPT-1', {
      schemaVersion: 'lattice.baseline.foreign_report.v0',
      expectedOutcome: 'PASS',
      outcome: 'PASS',
    }));
    writeFinalReport(root, 'engineering', 'ENG-REGRESSION-1', 'authority-overclaim', finalReportSeed(root, 'engineering', 'ENG-REGRESSION-1', {
      authority: {
        authorityChanged: true,
        receiptVerified: true,
        productionDone: true,
        fullAuthorityDone: true,
        receiptRefs: ['local-forged-receipt'],
      },
    }));

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, 'baseline_suite_report invalid final reports');
    assert.match(result.combined, /malformed|schema|mixed|authority|receipt|productionDone|reject|invalid|block/i, 'suite report rejection should name malformed/schema/authority reasons');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 6. Suite report rejects invalid final-report status values.
{
  const root = initRepo('invalid-status');
  try {
    writeFinalReport(root, 'engineering', 'ENG-BUGFIX-1', 'invalid-status', finalReportSeed(root, 'engineering', 'ENG-BUGFIX-1', {
      status: 'not-a-real-status',
    }));

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, 'baseline_suite_report invalid final-report status');
    assert.match(result.combined, /unsupported status|invalid|malformed|reject|block/i, 'suite report should reject unsupported final-report status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 7. Local baseline_run stub artifacts cannot authorize Engineering suite PASS.
{
  const root = initRepo('local-stub-suite');
  try {
    requireJsonObject(runCli(root, ['baseline_run', '--baselineId=ENG-BUGFIX-1', '--format=json']), 'local ENG-BUGFIX-1 baseline_run');
    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    const output = requireJsonObject(result, 'local stub engineering suite report');
    assertFailsClosed(result, 'local stub engineering suite report');
    assert.ok(collectValuesForKeys(output, ['suiteStatus']).includes('BLOCKED'), 'local stub suite should be BLOCKED');
    assert.ok(collectValuesForKeys(output, ['authorization']).includes('not_authorized'), 'local stub suite should be not_authorized');
    assertMentions(output, /localOnly|local-only|capabilityProof|diagnostic/i, 'local stub suite blocked reason');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 8. Stale final reports are rejected by suite aggregation.
{
  const root = initRepo('stale-final');
  try {
    writeFinalReport(root, 'engineering', 'ENG-BUGFIX-1', 'stale-final', finalReportSeed(root, 'engineering', 'ENG-BUGFIX-1'));
    commitTrackedChange(root, 'packages/main/src/index.ts', 'export const smoke = "changed-after-final-report";\n', 'change material after final report');

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, 'stale engineering final report');
    assert.match(result.combined, /stale|materialHash|material/i, 'suite report should reject stale final report material hash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 9. Missing lower-layer Development proof blocks Engineering suite aggregation.
{
  const root = initRepo('missing-development-proof');
  try {
    writeEngineeringProofReports(root);

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, 'missing Development lower-layer proof');
    assert.match(result.combined, /development|lower-layer|missing/i, 'suite report should reject missing Development proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 10. Stale lower-layer Development proof blocks Engineering suite aggregation.
{
  const root = initRepo('stale-development-proof');
  try {
    writeSuiteReport(root, 'development');
    commitTrackedChange(root, 'packages/main/src/index.ts', 'export const smoke = "changed-after-development-proof";\n', 'change material after development proof');
    writeEngineeringProofReports(root);

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, 'stale Development lower-layer proof');
    assert.match(result.combined, /development|stale|materialHash/i, 'suite report should reject stale Development proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 11. Engineering EXPECTED_BLOCK reports are accepted only with refusal proof.
{
  const root = initRepo('engineering-expected-block');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root, {
      'ENG-DATA-MIGRATION-1': engineeringExpectedBlockReport(root, 'ENG-DATA-MIGRATION-1'),
    });

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    const output = requireJsonObject(result, 'engineering expected-block suite report');
    assertSuiteAccepted(output, 'engineering expected-block suite report');
    assertNoSuiteBlockedReasons(output, 'engineering expected-block suite report');
    assert.equal(output.formalProof, true, 'engineering expected-block suite report should be formal');
    assert.equal((output.coveredBaselineIds as unknown[]).length, 9, 'engineering expected-block suite report should cover all nine baselines');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 12. Engineering EXPECTED_BLOCK reports missing refusal proof are blocked.
for (const defect of [
  {
    label: 'missing-expected-block-reasons',
    mutate(report: JsonObject): void {
      delete report.expectedBlockReasons;
    },
    pattern: /expected[- ]?block|expectedBlockReasons/i,
  },
  {
    label: 'missing-refusal-evidence-refs',
    mutate(report: JsonObject): void {
      delete report.refusalEvidenceRefs;
    },
    pattern: /refusalEvidenceRefs|refusal evidence/i,
  },
]) {
  const root = initRepo(`engineering-expected-block-${defect.label}`);
  try {
    writeSuiteReport(root, 'development');
    const report = engineeringExpectedBlockReport(root, 'ENG-DATA-MIGRATION-1');
    defect.mutate(report);
    writeEngineeringProofReports(root, {
      'ENG-DATA-MIGRATION-1': report,
    });

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, `engineering expected-block ${defect.label}`);
    assert.match(result.combined, defect.pattern, `expected-block rejection should name ${defect.label}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 13. Risky Engineering PASS reports are accepted only with gate evidence.
{
  const root = initRepo('engineering-risky-pass-gated');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root, Object.fromEntries(
      RISKY_ENGINEERING_BASELINE_IDS.map((baselineId) => [
        baselineId,
        riskyEngineeringPassReport(root, baselineId, [
          gateArtifactRef(baselineId, 'gate-review-approved.json'),
          gateArtifactRef(baselineId, 'gate-rollback-reviewed.json'),
        ]),
      ]),
    ));

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    const output = requireJsonObject(result, 'risky engineering gated PASS suite report');
    assertSuiteAccepted(output, 'risky engineering gated PASS suite report');
    assertNoSuiteBlockedReasons(output, 'risky engineering gated PASS suite report');
    assert.equal(output.formalProof, true, 'risky engineering gated PASS suite report should be formal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 14. Risky Engineering PASS reports missing real gate evidence are blocked.
for (const baselineId of RISKY_ENGINEERING_BASELINE_IDS) {
  for (const defect of [
    { label: 'missing-gate-evidence', gateEvidenceRefs: undefined },
    { label: 'empty-gate-evidence', gateEvidenceRefs: [] },
    { label: 'fake-gate-evidence', gateEvidenceRefs: ['artifact:gate-review-approved.json#sha256=0000000000000000000000000000000000000000000000000000000000000000'] },
  ] as const) {
    const root = initRepo(`engineering-risky-pass-${baselineId.toLowerCase()}-${defect.label}`);
    try {
      writeSuiteReport(root, 'development');
      writeEngineeringProofReports(root, {
        [baselineId]: riskyEngineeringPassReport(root, baselineId, defect.gateEvidenceRefs),
      });

      const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
      assertFailsClosed(result, `risky engineering PASS ${baselineId} ${defect.label}`);
      assert.match(result.combined, /gateEvidenceRefs|gate evidence|gate/i, 'risky PASS rejection should name gate evidence');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// 15. Malformed risky Engineering PASS reports stay blocked.
for (const defect of [
  {
    label: 'mismatched-expected-outcomes',
    mutate(report: JsonObject): void {
      report.expectedOutcomes = ['PASS'];
    },
    pattern: /expectedOutcomes|definition/i,
  },
  {
    label: 'blocked-reasons-on-pass',
    mutate(report: JsonObject): void {
      report.blockedReasons = ['unresolved migration blocker'];
    },
    pattern: /blockedReasons|generic/i,
  },
  {
    label: 'artifact-directory-mismatch',
    mutate(report: JsonObject): void {
      report.artifacts = {
        directory: '.lattice/artifacts/baseline/engineering/ENG-BUGFIX-1/not-this-run',
        files: ['final-report.json', 'gate-review-approved.json', 'gate-rollback-reviewed.json'],
      };
    },
    pattern: /artifacts\\.directory|final-report directory/i,
  },
]) {
  const root = initRepo(`engineering-risky-pass-malformed-${defect.label}`);
  try {
    writeSuiteReport(root, 'development');
    const baselineId = 'ENG-DATA-MIGRATION-1';
    const report = riskyEngineeringPassReport(root, baselineId, [
      gateArtifactRef(baselineId, 'gate-review-approved.json'),
      gateArtifactRef(baselineId, 'gate-rollback-reviewed.json'),
    ]);
    defect.mutate(report);
    writeEngineeringProofReports(root, { [baselineId]: report });

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, `risky engineering malformed PASS ${defect.label}`);
    assert.match(result.combined, defect.pattern, `risky malformed PASS rejection should name ${defect.label}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 16. Formal Engineering reports lacking required bindings or refs are blocked.
for (const defect of [
  {
    label: 'missing-verification-evidence-refs',
    mutate(report: JsonObject, _root: string): void {
      delete report.verificationEvidenceRefs;
    },
    pattern: /verificationEvidenceRefs/i,
  },
  {
    label: 'missing-codex-review-ref',
    mutate(report: JsonObject, root: string): void {
      report.reviewEvidenceRefs = [`review:claude:${gateArtifactRef('ENG-BUGFIX-1', 'review-claude.json', root)}`];
    },
    pattern: /Codex reviewEvidenceRefs|reviewEvidenceRefs/i,
  },
  {
    label: 'missing-claude-review-ref',
    mutate(report: JsonObject, root: string): void {
      report.reviewEvidenceRefs = [`review:codex:${gateArtifactRef('ENG-BUGFIX-1', 'review-codex.json', root)}`];
    },
    pattern: /Claude reviewEvidenceRefs|reviewEvidenceRefs/i,
  },
  {
    label: 'wrong-review-host-json',
    mutate(report: JsonObject, root: string): void {
      report.reviewEvidenceRefs = [
        `review:claude:${gateArtifactRef('ENG-BUGFIX-1', 'review-codex.json', root)}`,
        `review:codex:${gateArtifactRef('ENG-BUGFIX-1', 'review-claude.json', root)}`,
      ];
    },
    pattern: /host|source|reviewEvidenceRefs/i,
  },
  {
    label: 'same-review-artifact-file',
    mutate(report: JsonObject, root: string): void {
      report.reviewEvidenceRefs = [
        `review:claude:${gateArtifactRef('ENG-BUGFIX-1', 'review-claude.json', root)}`,
        `review:codex:${gateArtifactRef('ENG-BUGFIX-1', 'review-claude.json', root)}`,
      ];
    },
    pattern: /distinct|reused|same|review artifact/i,
  },
  {
    label: 'missing-lifecycle-gate-ref',
    mutate(report: JsonObject, _root: string): void {
      delete report.lifecycleGateEvidenceRefs;
    },
    pattern: /lifecycleGateEvidenceRefs|lifecycle/i,
  },
  {
    label: 'missing-receipt-suite-binding',
    mutate(report: JsonObject, root: string): void {
      report.receiptRefs = [
        `receipt:baselineId=ENG-BUGFIX-1;claimTarget=${FORMAL_CLAIM_TARGET};headHash=${currentGitHead(root)!};materialHash=${materialHash(root)}`,
      ];
    },
    pattern: /suiteRunId|receiptRef/i,
  },
  {
    label: 'missing-receipt-evidence-digest-binding',
    mutate(report: JsonObject, root: string): void {
      report.receiptRefs = [
        `receipt:baselineId=ENG-BUGFIX-1;suiteRunId=${FORMAL_SUITE_RUN_ID};claimTarget=${FORMAL_CLAIM_TARGET};headHash=${currentGitHead(root)!};materialHash=${materialHash(root)}`,
      ];
    },
    pattern: /evidenceDigest|receiptRef/i,
  },
  {
    label: 'stale-verified-at',
    mutate(report: JsonObject, _root: string): void {
      report.verifiedAt = '2020-01-01T00:00:00.000Z';
    },
    pattern: /verifiedAt|stale/i,
  },
] as const) {
  const rootForDefect = initRepo(`engineering-formal-binding-${defect.label}`);
  try {
    writeSuiteReport(rootForDefect, 'development');
    const report = finalReportSeed(rootForDefect, 'engineering', 'ENG-BUGFIX-1');
    defect.mutate(report, rootForDefect);
    writeEngineeringProofReports(rootForDefect, { 'ENG-BUGFIX-1': report });

    const result = runCli(rootForDefect, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFailsClosed(result, `formal Engineering ${defect.label}`);
    assert.match(result.combined, defect.pattern, `formal rejection should name ${defect.label}`);
  } finally {
    rmSync(rootForDefect, { recursive: true, force: true });
  }
}

// 17. Formal suite roots fail closed when any parsed report violates the root invariant.
for (const defect of [
  {
    label: 'mixed-suite-run-id',
    mutate(report: JsonObject, _root: string): void {
      report.suiteRunId = 'layer2-engineering-suite-smoke-other';
    },
    pattern: /suiteRunId|root invariant/i,
  },
  {
    label: 'wrong-claim-target',
    mutate(report: JsonObject, _root: string): void {
      report.claimTarget = LOOP_FORMAL_CLAIM_TARGET;
    },
    pattern: /claimTarget|root invariant/i,
  },
  {
    label: 'local-only',
    mutate(report: JsonObject, _root: string): void {
      report.localOnly = true;
    },
    pattern: /localOnly|root invariant/i,
  },
  {
    label: 'authority-overclaim',
    mutate(report: JsonObject, _root: string): void {
      report.productionDone = true;
      report.authority = {
        authorityChanged: false,
        receiptVerified: false,
        productionDone: true,
        fullAuthorityDone: false,
        receiptRefs: [],
      };
    },
    pattern: /authority-overclaim|productionDone|root invariant/i,
  },
  {
    label: 'top-level-authority-done',
    mutate(report: JsonObject, _root: string): void {
      report.authorityDone = true;
    },
    pattern: /authority-overclaim|authorityDone|root invariant/i,
  },
  {
    label: 'nested-authority-done',
    mutate(report: JsonObject, _root: string): void {
      report.authority = {
        authorityChanged: false,
        authorityDone: true,
        receiptVerified: false,
        productionDone: false,
        fullAuthorityDone: false,
        receiptRefs: [],
      };
    },
    pattern: /authority-overclaim|authorityDone|root invariant/i,
  },
] as const) {
  const root = initRepo(`formal-root-invariant-${defect.label}`);
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root);
    const contaminated = engineeringFinalReportForRun(
      root,
      'ENG-BUGFIX-1',
      `ignored-${defect.label}`,
      { generatedAt: '2020-01-01T00:00:00.000Z' },
    );
    defect.mutate(contaminated, root);
    writeFinalReport(root, 'engineering', 'ENG-BUGFIX-1', String(contaminated.runId), contaminated);

    const result = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    assertFormalSuiteBlocked(result, `formal root invariant ${defect.label}`, defect.pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 18. Formal baseline_run cannot mint formal proof without required inputs.
{
  const root = initRepo('formal-run-missing-inputs');
  try {
    const result = runCli(root, [
      'baseline_run',
      '--baselineId=ENG-BUGFIX-1',
      '--formal=true',
      `--suiteRunId=${FORMAL_SUITE_RUN_ID}`,
      `--claimTarget=${FORMAL_CLAIM_TARGET}`,
      '--format=json',
    ]);
    assertFailsClosed(result, 'formal baseline_run missing proof refs');
    assert.match(result.combined, /verificationEvidenceRefs|formal baseline proof requires/i, 'formal baseline_run should require proof refs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 18. Stale lower-layer suite proof blocks capability claims.
{
  const root = initRepo('stale-lower-suite');
  try {
    writeSuiteReport(root, 'development');
    commitTrackedChange(root, 'packages/main/src/index.ts', 'export const smoke = "changed-after-suite-report";\n', 'change material after suite report');

    const result = runCli(root, ['capability_claim_evaluate', '--target=engineering', '--format=json']);
    const output = requireJsonObject(result, 'stale lower-layer suite claim');
    assertAuthorizedFalse(output, 'stale lower-layer suite claim');
    assertClaimLevel(output, 'none', 'stale lower-layer suite claim');
    assertMentions(output, /stale|materialHash|development|lower-layer/i, 'stale lower-layer suite claim');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 19. Fresh authorized lower-layer suite proof can authorize diagnostic Engineering claims only locally.
{
  const root = initRepo('claim-engineering-authorized');
  try {
    writeSuiteReport(root, 'development');
    writeSuiteReport(root, 'engineering');

    const result = runCli(root, ['capability_claim_evaluate', '--target=engineering', '--format=json']);
    const output = requireJsonObject(result, 'fresh engineering claim proof');
    assertAuthorizedTrue(output, 'fresh engineering claim proof');
    assertOutcome(output, 'PASS', 'fresh engineering claim proof');
    assertClaimLevel(output, 'engineering', 'fresh engineering claim proof');
    assertClaimId(output, 'CLAIM-ENGINEERING-DEV', 'fresh engineering claim proof');
    assertLocalOnly(output, true, 'fresh engineering diagnostic claim proof');
    assertNoAuthorityOverclaim(output, 'fresh engineering claim proof');
    assertRequiredFalseField(output, 'receiptVerified', 'fresh engineering claim proof');
    assertRequiredFalseField(output, 'productionDone', 'fresh engineering claim proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 20. Diagnostic suite proof cannot unlock the formal Layer 2 claim.
{
  const root = initRepo('formal-claim-rejects-diagnostic-suite');
  try {
    writeSuiteReport(root, 'development');
    writeSuiteReport(root, 'engineering');

    const result = runCli(root, ['capability_claim_formal_evaluate', '--target=engineering', '--format=json']);
    const output = requireJsonObject(result, 'formal claim rejects diagnostic suite');
    assertAuthorizedFalse(output, 'formal claim rejects diagnostic suite');
    assertLayer2Claim(output, 'LOCKED', 'formal claim rejects diagnostic suite');
    assertHigherClaimsLocked(output, 'formal claim rejects diagnostic suite');
    assertMentions(output, /formalProof|diagnostic/i, 'formal claim should reject diagnostic suite proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 21. A forged Engineering suite summary cannot unlock without final-report proof.
{
  const root = initRepo('formal-claim-rejects-forged-suite');
  try {
    writeSuiteReport(root, 'development');
    writeSuiteReport(root, 'engineering', {
      suiteStatus: 'PASS',
      authorization: 'authorized',
      outcome: 'PASS',
      capabilityProof: true,
      localOnly: false,
      formalProof: true,
      engineeringBaseline: 'PASS',
      suiteRunId: FORMAL_SUITE_RUN_ID,
      claimTarget: FORMAL_CLAIM_TARGET,
      requiredBaselineIds: [...ALL_ENGINEERING_BASELINE_IDS],
      coveredBaselineIds: [...ALL_ENGINEERING_BASELINE_IDS],
      missingBaselineIds: [],
    });

    const result = runCli(root, ['capability_claim_formal_evaluate', '--target=engineering', '--format=json']);
    const output = requireJsonObject(result, 'formal claim rejects forged suite summary');
    assertAuthorizedFalse(output, 'formal claim rejects forged suite summary');
    assertLayer2Claim(output, 'LOCKED', 'formal claim rejects forged suite summary');
    assertMentions(output, /rebuilt|final-report|missing baseline|accepted final-report/i, 'formal claim should revalidate final-report artifacts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 22. Formal Engineering suite proof unlocks only the Layer 2 Engineering claim.
{
  const root = initRepo('formal-claim-engineering-unlocked');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root);
    const beforeArtifactCommitHead = currentGitHead(root);
    const beforeArtifactCommitMaterialHash = materialHash(root);
    assert.ok(beforeArtifactCommitHead, 'formal Engineering artifact commit smoke should start from a git HEAD');

    const suiteResult = runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']);
    const suite = requireJsonObject(suiteResult, 'formal engineering suite proof');
    assertSuiteAccepted(suite, 'formal engineering suite proof');
    assert.equal(suite.formalProof, true, 'formal engineering suite proof should be formal');
    assert.equal(suite.suiteRunId, FORMAL_SUITE_RUN_ID, 'formal engineering suite proof should preserve one suiteRunId');
    assert.equal(suite.claimTarget, FORMAL_CLAIM_TARGET, 'formal engineering suite proof should preserve the Engineering claim target');
    assert.equal(suite.headHash, beforeArtifactCommitHead, 'generated suite report should bind to the pre-artifact-commit HEAD');
    assert.equal(suite.materialHash, beforeArtifactCommitMaterialHash, 'generated suite report should bind to the current material hash');

    git(root, ['add', '-f', '.lattice/artifacts/baseline']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'persist baseline proof artifacts']);
    assert.notEqual(currentGitHead(root), beforeArtifactCommitHead, 'committing proof artifacts should move HEAD');
    assert.equal(materialHash(root), beforeArtifactCommitMaterialHash, 'committing excluded proof artifacts must not change materialHash');

    const engineering = requireJsonObject(
      runCli(root, ['capability_claim_formal_evaluate', '--target=engineering', '--format=json']),
      'formal engineering claim after persisted proof artifact commit',
    );
    assertAuthorizedTrue(engineering, 'formal engineering claim after persisted proof artifact commit');
    assertOutcome(engineering, 'PASS', 'formal engineering claim after persisted proof artifact commit');
    assertClaimLevel(engineering, 'engineering', 'formal engineering claim after persisted proof artifact commit');
    assertLayer2Claim(engineering, 'UNLOCKED', 'formal engineering claim after persisted proof artifact commit');
    assertHigherClaimsLocked(engineering, 'formal engineering claim after persisted proof artifact commit');
    assertLocalOnly(engineering, false, 'formal engineering claim after persisted proof artifact commit');
    assertNoAuthorityOverclaim(engineering, 'formal engineering claim after persisted proof artifact commit');
    for (const key of ['authorityChanged', 'receiptVerified', 'productionDone', 'fullAuthorityDone']) {
      assertRequiredFalseField(engineering, key, 'formal engineering claim after persisted proof artifact commit');
    }

    for (const target of ['loop-engineering', 'production-safety']) {
      const higher = requireJsonObject(
        runCli(root, ['capability_claim_formal_evaluate', `--target=${target}`, '--format=json']),
        `formal ${target} claim`,
      );
      assertAuthorizedFalse(higher, `formal ${target} claim`);
      assertLayer2Claim(higher, 'UNLOCKED', `formal ${target} claim`);
      assertHigherClaimsLocked(higher, `formal ${target} claim`);
      assertMentions(higher, /Loop Engineering|higher layers remain locked|Engineering or Loop Engineering|missing baseline/i, `formal ${target} claim`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 23. Formal Loop Engineering suite proof unlocks only the Layer 3 claim.
{
  const root = initRepo('formal-claim-loop-engineering-unlocked');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root);
    const engineeringSuite = requireJsonObject(
      runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']),
      'formal engineering prerequisite for loop claim',
    );
    assertSuiteAccepted(engineeringSuite, 'formal engineering prerequisite for loop claim');

    writeLoopProofReports(root);
    const loopSuite = requireJsonObject(
      runCli(root, ['baseline_suite_report', '--layer=loop-engineering', '--format=json']),
      'formal loop-engineering suite proof',
    );
    assertSuiteAccepted(loopSuite, 'formal loop-engineering suite proof');
    assert.equal(loopSuite.formalProof, true, 'formal loop-engineering suite proof should be formal');
    assert.equal(loopSuite.suiteRunId, LOOP_FORMAL_SUITE_RUN_ID, 'formal loop-engineering suite proof should preserve one suiteRunId');
    assert.equal(loopSuite.claimTarget, LOOP_FORMAL_CLAIM_TARGET, 'formal loop-engineering suite proof should preserve the Loop Engineering claim target');
    assert.equal((loopSuite.coveredBaselineIds as unknown[]).length, 10, 'formal loop suite should cover all ten UDM baselines');

    git(root, ['add', '-f', '.lattice/artifacts/baseline']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'persist loop proof artifacts']);

    const loop = requireJsonObject(
      runCli(root, ['capability_claim_formal_evaluate', '--target=loop-engineering', '--format=json']),
      'formal loop-engineering claim after persisted proof artifact commit',
    );
    assertAuthorizedTrue(loop, 'formal loop-engineering claim after persisted proof artifact commit');
    assertOutcome(loop, 'PASS', 'formal loop-engineering claim after persisted proof artifact commit');
    assertClaimLevel(loop, 'loop-engineering', 'formal loop-engineering claim after persisted proof artifact commit');
    assertLayer2Claim(loop, 'UNLOCKED', 'formal loop-engineering claim after persisted proof artifact commit');
    assertLoopClaim(loop, 'UNLOCKED', 'formal loop-engineering claim after persisted proof artifact commit');
    assertProductionAndGlobalClaimsLocked(loop, 'formal loop-engineering claim after persisted proof artifact commit');
    assertLocalOnly(loop, false, 'formal loop-engineering claim after persisted proof artifact commit');
    assertNoAuthorityOverclaim(loop, 'formal loop-engineering claim after persisted proof artifact commit');

    const production = requireJsonObject(
      runCli(root, ['capability_claim_formal_evaluate', '--target=production-safety', '--format=json']),
      'formal production-safety claim after persisted loop proof artifact commit',
    );
    assertAuthorizedFalse(production, 'formal production-safety claim after persisted loop proof artifact commit');
    assertClaimId(production, 'CLAIM-PRODUCTION-SAFETY', 'formal production-safety claim after persisted loop proof artifact commit');
    assertClaimLevel(production, 'loop-engineering', 'formal production-safety claim after persisted loop proof artifact commit');
    assertLayer2Claim(production, 'UNLOCKED', 'formal production-safety claim after persisted loop proof artifact commit');
    assertLoopClaim(production, 'UNLOCKED', 'formal production-safety claim after persisted loop proof artifact commit');
    assertProductionAndGlobalClaimsLocked(production, 'formal production-safety claim after persisted loop proof artifact commit');
    assertNoAuthorityOverclaim(production, 'formal production-safety claim after persisted loop proof artifact commit');
    assert.ok(
      Array.isArray(production.dependsOn) && production.dependsOn.includes('production-safety'),
      'formal production-safety claim should still declare production-safety as a required dependency',
    );

    const global = requireJsonObject(
      runCli(root, ['capability_claim_formal_evaluate', '--target=capability-claim', '--format=json']),
      'formal global capability claim after persisted loop proof artifact commit',
    );
    assertAuthorizedFalse(global, 'formal global capability claim after persisted loop proof artifact commit');
    assertClaimId(global, 'CLAIM-GLOBAL-CAPABILITY', 'formal global capability claim after persisted loop proof artifact commit');
    assertClaimLevel(global, 'loop-engineering', 'formal global capability claim after persisted loop proof artifact commit');
    assertLayer2Claim(global, 'UNLOCKED', 'formal global capability claim after persisted loop proof artifact commit');
    assertLoopClaim(global, 'UNLOCKED', 'formal global capability claim after persisted loop proof artifact commit');
    assertProductionAndGlobalClaimsLocked(global, 'formal global capability claim after persisted loop proof artifact commit');
    assertNoAuthorityOverclaim(global, 'formal global capability claim after persisted loop proof artifact commit');
    assert.ok(
      Array.isArray(global.dependsOn) && global.dependsOn.includes('production-safety'),
      'formal global capability claim should still declare production-safety as a required dependency',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 24. A forged Loop Engineering suite summary cannot unlock without UDM final-report proof.
{
  const root = initRepo('formal-claim-rejects-forged-loop-suite');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root);
    requireJsonObject(runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']), 'engineering prerequisite for forged loop suite');
    writeSuiteReport(root, 'loop-engineering', {
      suiteStatus: 'PASS',
      authorization: 'authorized',
      outcome: 'PASS',
      capabilityProof: true,
      localOnly: false,
      formalProof: true,
      suiteRunId: LOOP_FORMAL_SUITE_RUN_ID,
      claimTarget: LOOP_FORMAL_CLAIM_TARGET,
      requiredBaselineIds: [...ALL_LOOP_ENGINEERING_BASELINE_IDS],
      coveredBaselineIds: [...ALL_LOOP_ENGINEERING_BASELINE_IDS],
      missingBaselineIds: [],
    });

    const result = runCli(root, ['capability_claim_formal_evaluate', '--target=loop-engineering', '--format=json']);
    const output = requireJsonObject(result, 'formal claim rejects forged loop suite summary');
    assertAuthorizedFalse(output, 'formal claim rejects forged loop suite summary');
    assertLayer2Claim(output, 'UNLOCKED', 'formal claim rejects forged loop suite summary');
    assertLoopClaim(output, 'LOCKED', 'formal claim rejects forged loop suite summary');
    assertProductionAndGlobalClaimsLocked(output, 'formal claim rejects forged loop suite summary');
    assertMentions(output, /rebuilt|final-report|missing baseline|accepted final-report/i, 'formal loop claim should revalidate UDM final-report artifacts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 25. UDM final reports missing required Loop Engineering refs are blocked.
{
  const root = initRepo('formal-loop-missing-udm-refs');
  try {
    writeSuiteReport(root, 'development');
    writeEngineeringProofReports(root);
    requireJsonObject(runCli(root, ['baseline_suite_report', '--layer=engineering', '--format=json']), 'engineering prerequisite for malformed loop report');
    const malformed = loopFinalReport(root, 'UDM-REVIEW-LOOP-1');
    delete malformed.reviewLoopRefs;
    writeLoopProofReports(root, { 'UDM-REVIEW-LOOP-1': malformed });

    const result = runCli(root, ['baseline_suite_report', '--layer=loop-engineering', '--format=json']);
    assertFailsClosed(result, 'loop suite missing reviewLoopRefs');
    assert.match(result.combined, /reviewLoopRefs|UDM-REVIEW-LOOP-1/i, 'loop suite rejection should name missing reviewLoopRefs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 26. CLI baseline_run forwards Loop Engineering formal proof refs to the registered handler.
{
  const root = initRepo('formal-loop-cli-parameter-forwarding');
  try {
    const baselineId = 'UDM-REVIEW-LOOP-1';
    const runId = 'udm-review-loop-cli-formal';
    const verifiedAt = new Date().toISOString();
    const verificationEvidenceRef = baselineRunnerArtifactRef(root, baselineId, runId, 'verification-evidence.json', verifiedAt);
    const plannedStepRef = baselineRunnerArtifactRef(root, baselineId, runId, 'planned-steps.json', verifiedAt);
    const reviewLoopRef = baselineRunnerArtifactRef(root, baselineId, runId, 'review-loop.jsonl', verifiedAt);

    const result = runCli(root, [
      'baseline_run',
      `--baselineId=${baselineId}`,
      `--runId=${runId}`,
      '--formal',
      `--suiteRunId=${LOOP_FORMAL_SUITE_RUN_ID}`,
      `--claimTarget=${LOOP_FORMAL_CLAIM_TARGET}`,
      '--outcome=PASS',
      `--verifiedAt=${verifiedAt}`,
      `--verificationEvidenceRefs=${verificationEvidenceRef}`,
      `--plannedStepRefs=${plannedStepRef}`,
      `--reviewLoopRefs=${reviewLoopRef}`,
      '--format=json',
    ]);
    const report = requireJsonObject(result, 'formal loop baseline_run CLI forwarding');
    assert.equal(report.baselineId, baselineId, 'formal loop baseline_run should write the requested baseline id');
    assert.equal(report.claimTarget, LOOP_FORMAL_CLAIM_TARGET, 'formal loop baseline_run should bind loop-engineering claim target');
    assert.equal(report.formalProof, true, 'formal loop baseline_run should emit formal proof');
    assert.equal(report.localOnly, false, 'formal loop baseline_run proof should be eligible for formal suite evaluation');
    assert.deepEqual(report.verificationEvidenceRefs, [verificationEvidenceRef], 'formal loop baseline_run should preserve verification evidence refs');
    assert.deepEqual(report.plannedStepRefs, [plannedStepRef], 'formal loop baseline_run should preserve planned step refs');
    assert.deepEqual(report.reviewLoopRefs, [reviewLoopRef], 'formal loop baseline_run should preserve review loop refs');
    assertNoAuthorityOverclaim(report, 'formal loop baseline_run CLI forwarding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 27. Inconsistent PASS suite proof cannot authorize Engineering claims.
{
  const root = initRepo('claim-engineering-incoherent-suite');
  try {
    writeSuiteReport(root, 'development', {
      suiteStatus: 'PASS',
      authorization: 'authorized',
      capabilityProof: true,
      localOnly: false,
      outcome: 'EXPECTED_BLOCK',
    });
    writeSuiteReport(root, 'engineering');

    const result = runCli(root, ['capability_claim_evaluate', '--target=engineering', '--format=json']);
    const output = requireJsonObject(result, 'incoherent development suite claim proof');
    assertAuthorizedFalse(output, 'incoherent development suite claim proof');
    assertOutcome(output, 'EXPECTED_BLOCK', 'incoherent development suite claim proof');
    assertClaimLevel(output, 'none', 'incoherent development suite claim proof');
    assertMentions(output, /blocked|BLOCKED/i, 'incoherent development suite claim proof');
    assertMentions(output, /outcome/i, 'incoherent development suite claim proof');
    assertMentions(output, /coherence/i, 'incoherent development suite claim proof');
    assertMentions(output, /inconsistent/i, 'incoherent development suite claim proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 23. capability_claim_evaluate blocks production-safety with missing lower layers.
{
  const root = initRepo('claim-missing-layers');
  try {
    const result = runCli(root, ['capability_claim_evaluate', '--target=production-safety', '--format=json']);
    const output = requireJsonObject(result, 'production-safety claim missing evidence');
    assertAuthorizedFalse(output, 'production-safety claim missing evidence');
    assertNoAuthorityOverclaim(output, 'production-safety claim missing evidence');
    assert.ok(
      collectValuesForKeys(output, ['highestAuthorizedClaim', 'authorizedClaimLevel']).length > 0,
      'claim evaluation should report the highest authorized claim boundary',
    );
    assertMentions(output, /missing|lower|development|engineering|loop|authority|receipt/i, 'production-safety blocked claim');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 24. Parallel implementation artifacts do not unlock parallel proof.
{
  const root = initRepo('parallel-implementation');
  try {
    writeSuiteReport(root, 'production-safety', {
      suiteStatus: 'PASS',
      implementationOrder: 'parallel',
      implementationMayProceedInParallel: true,
      claimUnlockOrder: 'sequential',
      note: 'Seeded high-layer implementation artifact; lower-layer proof is intentionally absent.',
      baselines: [finalReportSeed(root, 'production-safety', 'AUTH-RECEIPT-1', {
        expectedOutcome: 'PASS',
        outcome: 'PASS',
        implementationOrder: 'parallel',
      })],
    });
    const result = runCli(root, ['capability_claim_evaluate', '--target=production-safety', '--format=json']);
    const output = requireJsonObject(result, 'parallel implementation production-safety claim');
    assertAuthorizedFalse(output, 'parallel implementation production-safety claim');
    assertNoAuthorityOverclaim(output, 'parallel implementation production-safety claim');
    assertMentions(output, /sequential|lower|development|engineering|loop|missing|parallel|proof/i, 'parallel implementation blocked claim');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(PASS_LINE);
