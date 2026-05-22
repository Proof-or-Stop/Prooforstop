#!/usr/bin/env node
/**
 * Contract test: evidence quality classifier API surface and backward compat.
 * Tests the dist build to catch module resolution and export contract regressions.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'packages/main/dist');

const failures = [];
function fail(msg) { failures.push(msg); }
function check(cond, msg) { if (!cond) fail(msg); }

// ── 1. Source files must exist ────────────────────────────────────────────────
const srcFiles = [
  'packages/main/src/core/evidence-quality.ts',
  'packages/main/src/tasks/evidence-quality-smoke.ts',
  'scripts/verify-evidence-quality.mjs',
];
for (const f of srcFiles) {
  check(existsSync(resolve(repoRoot, f)), `Source file missing: ${f}`);
}

// ── 2. Dist files must exist after build ─────────────────────────────────────
const distFiles = [
  'core/evidence-quality.js',
  'tasks/evidence-quality-smoke.js',
];
for (const f of distFiles) {
  check(existsSync(resolve(distDir, f)), `Dist file missing (run build first): ${f}`);
}

if (failures.length > 0) {
  console.error('Contract failures (pre-import):\n' + failures.map(f => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}

// ── 3. Import and check exported API surface ──────────────────────────────────
const eqUrl = pathToFileURL(resolve(distDir, 'core/evidence-quality.js')).href;
const eq = await import(eqUrl);

// classifyEvidenceQuality must be exported
check(typeof eq.classifyEvidenceQuality === 'function', 'classifyEvidenceQuality must be exported as function');
// getEvidenceQualityIssues must be exported
check(typeof eq.getEvidenceQualityIssues === 'function', 'getEvidenceQualityIssues must be exported as function');

// ── 4. Functional smoke against dist ─────────────────────────────────────────

// Strong: test command
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'npm test' });
  check(r.quality === 'strong', `npm test should be strong, got ${r.quality}`);
}

// Weak: echo
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' });
  check(r.quality === 'weak', `echo ok should be weak, got ${r.quality}`);
  check(r.weaknessReason === 'echo_pass_only', `expected echo_pass_only, got ${r.weaknessReason}`);
}

// Weak: --version
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'node --version' });
  check(r.quality === 'weak', `node --version should be weak, got ${r.quality}`);
  check(r.weaknessReason === 'version_help_only', `expected version_help_only, got ${r.weaknessReason}`);
}

// Weak: commandless manual_transcript
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'manual_transcript', result: 'pass', note: 'I tested it' });
  check(r.quality === 'weak', `commandless manual_transcript should be weak, got ${r.quality}`);
  check(r.weaknessReason === 'commandless_fileless', `expected commandless_fileless, got ${r.weaknessReason}`);
}

// Weak: manual_transcript with note "pass" (natural-language claim, no command/file)
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'manual_transcript', result: 'pass', note: 'pass' });
  check(r.quality === 'weak', `manual_transcript note="pass" without command/file must be weak, got ${r.quality}`);
  check(r.weaknessReason === 'commandless_fileless', `expected commandless_fileless, got ${r.weaknessReason}`);
}

// Strong: smoke task file
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', file: 'packages/main/src/tasks/evidence-quality-smoke.ts' });
  check(r.quality === 'strong', `smoke task file should be strong, got ${r.quality}`);
}

// Weak: build-only
{
  const r = eq.classifyEvidenceQuality({ intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'tsc --noEmit' });
  check(r.quality === 'weak', `tsc --noEmit should be weak, got ${r.quality}`);
  check(r.weaknessReason === 'build_only', `expected build_only, got ${r.weaknessReason}`);
}

// light profile: no issue for weak evidence
{
  const issue = eq.getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', { intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' }, 'light');
  check(issue === undefined, `light profile must return undefined for weak evidence, got ${JSON.stringify(issue)}`);
}

// balanced: non-blocking issue
{
  const issue = eq.getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', { intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' }, 'balanced');
  check(issue != null, 'balanced profile must return issue for weak evidence');
  check(issue?.blocking === false, `balanced issue must not be blocking, got ${issue?.blocking}`);
}

// strict: blocking issue
{
  const issue = eq.getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', { intentRef: 'x', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' }, 'strict');
  check(issue != null, 'strict profile must return issue for weak evidence');
  check(issue?.blocking === true, `strict issue must be blocking, got ${issue?.blocking}`);
}

// ── 5. Backward compat: buildVerificationCoverage with no profile = light ─────
const verUrl = pathToFileURL(resolve(distDir, 'core/verification.js')).href;
const ver = await import(verUrl);
check(typeof ver.buildVerificationCoverage === 'function', 'buildVerificationCoverage must be exported');
check(typeof ver.getBlockingVerificationEvidenceIssues === 'function', 'getBlockingVerificationEvidenceIssues must be exported');

{
  const cl = {
    items: [{
      id: 'CHK-001', title: 'x', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ desc: 'ok', type: 'logic', priority: 'must' }], edge: [], adversarial: [] },
      verificationEvidence: [{ intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' }],
    }],
  };
  const r = ver.buildVerificationCoverage(cl);
  check(r.entries[0].status === 'covered', `default no-options call must produce covered, got ${r.entries[0].status}`);
  check(r.qualityIssues === undefined, `default call must have no qualityIssues, got ${JSON.stringify(r.qualityIssues)}`);
  check(r.missingRequired === 0, `default call must have 0 missingRequired, got ${r.missingRequired}`);
}

// ── 6. Profile integration: strict blocks, balanced warns, light ignores ──────
{
  const cl = {
    items: [{
      id: 'CHK-001', title: 'x', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ desc: 'ok', type: 'logic', priority: 'must' }], edge: [], adversarial: [] },
      verificationEvidence: [{ intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass', note: '', command: 'echo ok' }],
    }],
  };

  // strict: getBlockingVerificationEvidenceIssues returns blocking issues for weak evidence
  const strictIssues = ver.getBlockingVerificationEvidenceIssues(cl, undefined, 'strict');
  check(strictIssues.length > 0, `strict profile must block weak evidence through getBlockingVerificationEvidenceIssues, got 0 issues`);
  check(strictIssues.length === 1, `strict profile must emit exactly one issue per weak entry (no duplicate generic + detail), got ${strictIssues.length}`);
  check(strictIssues.some(i => i.includes('CHK-001:happy:0')), `strict issues must reference intent ref`);

  // balanced: no missingRequired, but qualityIssues populated
  const balancedR = ver.buildVerificationCoverage(cl, undefined, undefined, { evidenceQualityProfile: 'balanced' });
  check(balancedR.missingRequired === 0, `balanced: must not have missingRequired (warning only), got ${balancedR.missingRequired}`);
  check(balancedR.qualityIssues && balancedR.qualityIssues.length > 0, `balanced: must populate qualityIssues`);
  const balancedIssues = ver.getBlockingVerificationEvidenceIssues(cl, undefined, 'balanced');
  check(balancedIssues.length === 0, `balanced: must not block weak evidence, got ${balancedIssues.length} issues`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('Contract failures:\n' + failures.map(f => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('✓ evidence quality contract passed');
