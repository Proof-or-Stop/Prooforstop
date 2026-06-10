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
  'receiptVerified',
  'productionDone',
  'fullAuthorityDone',
  'canClaimProductionDone',
] as const;

const EMPTY_AUTHORITY_ENV: Record<string, string | undefined> = {
  KOALA_AUTHORITY_MODE: 'off',
  KOALA_AUTHORITY_URL: '',
  KOALA_AUTHORITY_TIMEOUT_MS: '',
  KOALA_AUTHORITY_ACTOR_KEY: '',
  KOALA_AUTHORITY_ACTOR_KEY_PATH: '',
  KOALA_AUTHORITY_RUNNER_ID: '',
  KOALA_AUTHORITY_SESSION_ID: '',
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
      KOALA_ACTIVITY_RECORD_READONLY: '0',
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
  const layerRoot = join(root, '.omx', 'artifacts', 'baseline', layer);
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
    || normalized.startsWith('.koala/story/')
    || normalized.startsWith('docs/koala/framework-audit/')
    || normalized.startsWith('.omx/');
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
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'seed']);
  return root;
}

function commitTrackedChange(root: string, relPath: string, content: string, message: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  git(root, ['add', relPath]);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', message]);
}

function finalReportSeed(
  root: string,
  layer: string,
  baselineId: string,
  patch: JsonObject = {},
): JsonObject {
  return {
    schemaVersion: 'lattice.baseline.final_report.v1',
    layer,
    baselineId,
    runId: `${baselineId.toLowerCase()}-seed`,
    expectedOutcome: 'PASS',
    expectedOutcomes: ['PASS'],
    outcome: 'PASS',
    status: 'pass',
    capabilityProof: true,
    localOnly: false,
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
    ...patch,
  };
}

function writeFinalReport(root: string, layer: string, baselineId: string, runId: string, content: string | JsonObject): void {
  const runDir = join(root, '.omx', 'artifacts', 'baseline', layer, baselineId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'final-report.json'),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

function writeSuiteReport(root: string, layer: string, patch: JsonObject = {}): void {
  const layerRoot = join(root, '.omx', 'artifacts', 'baseline', layer);
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
  const help = runCli(repoRoot, ['help']);
  requireSuccess(help, 'help');
  for (const command of [
    'baseline_run',
    'baseline_suite',
    'baseline_suite_report',
    'capability_claim_evaluate',
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
      KOALA_AUTHORITY_MODE: 'off',
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

// 9. Stale lower-layer suite proof blocks capability claims.
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

// 10. Fresh authorized lower-layer suite proof can authorize Engineering claims.
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
    assertNoAuthorityOverclaim(output, 'fresh engineering claim proof');
    assertRequiredFalseField(output, 'receiptVerified', 'fresh engineering claim proof');
    assertRequiredFalseField(output, 'productionDone', 'fresh engineering claim proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 11. Inconsistent PASS suite proof cannot authorize Engineering claims.
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

// 12. capability_claim_evaluate blocks production-safety with missing lower layers.
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

// 13. Parallel implementation artifacts do not unlock parallel proof.
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
