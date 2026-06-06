#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { classifyEvidenceQuality, getEvidenceQualityIssues } from '../core/evidence-quality.js';
import { buildVerificationCoverage, getBlockingVerificationEvidenceIssues, renderVerificationCoverage } from '../core/verification.js';
import type { ChecklistData, VerificationEvidence } from '../core/types.js';

function makeEvidence(overrides: Partial<VerificationEvidence>): VerificationEvidence {
  return {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    result: 'pass',
    note: '',
    ...overrides,
  };
}

// ── 1. Classifier unit tests ────────────────────────────────────────────────

// Strong: test command
assert.equal(classifyEvidenceQuality(makeEvidence({ command: 'npm test' })).quality, 'strong', 'npm test should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ command: 'npx jest' })).quality, 'strong', 'npx jest should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ command: 'pytest src/' })).quality, 'strong', 'pytest should be strong');

// Strong: test/spec file
assert.equal(classifyEvidenceQuality(makeEvidence({ file: 'src/foo.test.ts' })).quality, 'strong', '.test.ts file should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ file: 'tests/bar.spec.js' })).quality, 'strong', '.spec.js file should be strong');

// Strong: assertion keyword in note
assert.equal(classifyEvidenceQuality(makeEvidence({ note: 'assert output matches expected' })).quality, 'strong', 'assert note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: 'verifies the edge case' })).quality, 'strong', 'verifies note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: 'regression check for this path' })).quality, 'strong', 'regression note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: 'expected output matches actual' })).quality, 'strong', 'expected/actual note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: '\u65ad\u8a00\u8f93\u51fa\u7b26\u5408\u9884\u671f' })).quality, 'strong', 'localized assertion note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: '\u56de\u5f52\u573a\u666f\u8986\u76d6\u9884\u671f\u4e0e\u5b9e\u9645\u7ed3\u679c' })).quality, 'strong', 'localized regression/coverage note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: '\u6838\u9a8c\u7528\u4f8b\u8986\u76d6\u771f\u5b9e\u8f93\u51fa' })).quality, 'strong', 'localized verify/scenario/real-output note should be strong');
assert.equal(classifyEvidenceQuality(makeEvidence({ note: '\u68c0\u67e5\u9879\u6e05\u5355\u8986\u76d6\u7387\u7b26\u5408\u9884\u671f' })).quality, 'strong', 'localized checklist/coverage-rate note should be strong');

// Strong: smoke task file path
assert.equal(
  classifyEvidenceQuality(makeEvidence({ file: 'packages/main/src/tasks/evidence-quality-smoke.ts' })).quality,
  'strong',
  'smoke task file should be strong',
);
assert.equal(
  classifyEvidenceQuality(makeEvidence({ file: 'packages/main/src/tasks/outcome-semantics-smoke.ts' })).quality,
  'strong',
  'tasks/*smoke.ts should be strong',
);
assert.equal(
  classifyEvidenceQuality(makeEvidence({ file: 'tests/spec/__tests__/foo.ts' })).quality,
  'strong',
  'tests/spec/__tests__ path should be strong',
);

// Weak: manual_transcript with note "pass" and no command/file
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: 'pass' }));
  assert.equal(r.quality, 'weak', 'manual_transcript note="pass" without command/file should be weak (natural-language claim)');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: 'the test passed' }));
  assert.equal(r.quality, 'weak', 'manual_transcript note="the test passed" without command/file should still be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: '\u6d4b\u8bd5\u901a\u8fc7' }));
  assert.equal(r.quality, 'weak', 'localized manual_transcript pass-only note without command/file should still be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: '\u9a8c\u8bc1\u901a\u8fc7' }));
  assert.equal(r.quality, 'weak', 'localized manual_transcript verification-pass-only note without command/file should still be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: '\u6d4b\u8bd5\u9a8c\u8bc1\u901a\u8fc7\u3002' }));
  assert.equal(r.quality, 'weak', 'localized manual_transcript test-verification-pass-only note without command/file should still be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: '\u5168\u90e8\u901a\u8fc7' }));
  assert.equal(r.quality, 'weak', 'localized manual_transcript all-pass-only note without command/file should still be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}

// Weak: echo/pass-only
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'echo ok' }));
  assert.equal(r.quality, 'weak', 'echo command should be weak');
  assert.equal(r.weaknessReason, 'echo_pass_only');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'true' }));
  assert.equal(r.quality, 'weak', 'true command should be weak');
  assert.equal(r.weaknessReason, 'echo_pass_only');
}

// Weak: version/help-only
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'node --version' }));
  assert.equal(r.quality, 'weak', '--version command should be weak');
  assert.equal(r.weaknessReason, 'version_help_only');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'koala --help' }));
  assert.equal(r.quality, 'weak', '--help command should be weak');
  assert.equal(r.weaknessReason, 'version_help_only');
}

// Weak: commandless/fileless manual_transcript
{
  const r = classifyEvidenceQuality(makeEvidence({ kind: 'manual_transcript', command: undefined, file: undefined, note: 'I checked it manually' }));
  assert.equal(r.quality, 'weak', 'manual_transcript without command/file should be weak');
  assert.equal(r.weaknessReason, 'commandless_fileless');
}

// Weak: build-only
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'tsc --noEmit', note: 'build succeeded' }));
  assert.equal(r.quality, 'weak', 'tsc --noEmit only should be weak');
  assert.equal(r.weaknessReason, 'build_only');
}
{
  const r = classifyEvidenceQuality(makeEvidence({ command: 'npm run build', note: '' }));
  assert.equal(r.quality, 'weak', 'npm run build only should be weak');
  assert.equal(r.weaknessReason, 'build_only');
}

// Build with assertion note → strong
assert.equal(
  classifyEvidenceQuality(makeEvidence({ command: 'npm run build', note: 'build verifies the module loads' })).quality,
  'strong',
  'build with assertion note should be strong',
);
assert.equal(
  classifyEvidenceQuality(makeEvidence({ command: 'npm run build', note: '\u56de\u5f52\u573a\u666f\u8986\u76d6\u9884\u671f\u4e0e\u5b9e\u9645\u7ed3\u679c' })).quality,
  'strong',
  'build with localized assertion note should be strong',
);

// Waiver is always strong (handled elsewhere)
assert.equal(classifyEvidenceQuality(makeEvidence({ kind: 'waiver' })).quality, 'strong', 'waiver should be strong');

// ── 2. Profile gating ────────────────────────────────────────────────────────

// light: no issue regardless of quality
assert.equal(
  getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', makeEvidence({ command: 'echo ok' }), 'light'),
  undefined,
  'light profile should never return an issue',
);

// balanced: issue present but not blocking
{
  const issue = getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', makeEvidence({ command: 'echo ok' }), 'balanced');
  assert.ok(issue, 'balanced profile should return an issue for weak evidence');
  assert.equal(issue!.blocking, false, 'balanced issue should not be blocking');
  assert.equal(issue!.weaknessReason, 'echo_pass_only');
}

// strict: issue present and blocking
{
  const issue = getEvidenceQualityIssues('CHK-001:happy:0', 'CHK-001', makeEvidence({ command: 'echo ok' }), 'strict');
  assert.ok(issue, 'strict profile should return an issue for weak evidence');
  assert.equal(issue!.blocking, true, 'strict issue should be blocking');
}

// ── 3. buildVerificationCoverage integration ─────────────────────────────────

const weakCl: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'weak evidence item',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'runs ok', type: 'logic', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'logic_test',
      result: 'pass',
      command: 'echo done',
      note: '',
    }],
  }],
};

// light: covered, no quality issues
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'light' });
  assert.equal(r.entries[0].status, 'covered', 'light: weak evidence should be covered');
  assert.equal(r.qualityIssues, undefined, 'light: no qualityIssues');
  assert.equal(r.missingRequired, 0, 'light: nothing missing');
}

// balanced: status stays covered but qualityIssues populated (non-blocking warning)
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'balanced' });
  assert.equal(r.entries[0].status, 'weak', 'balanced: weak evidence gets weak status');
  assert.ok(r.qualityIssues && r.qualityIssues.length > 0, 'balanced: qualityIssues populated');
  assert.equal(r.qualityIssues![0].blocking, false, 'balanced: issue not blocking');
  // In balanced, 'weak' is still counted as covered
  assert.equal(r.missingRequired, 0, 'balanced: still counts as covered (no missingRequired)');
}

// strict: status becomes 'weak', counts as not covered
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'strict' });
  assert.equal(r.entries[0].status, 'weak', 'strict: weak evidence gets weak status');
  assert.ok(r.qualityIssues && r.qualityIssues.length > 0, 'strict: qualityIssues populated');
  assert.equal(r.qualityIssues![0].blocking, true, 'strict: issue is blocking');
  assert.equal(r.missingRequired, 1, 'strict: counts as missingRequired');
}

// ── 4. getBlockingVerificationEvidenceIssues ─────────────────────────────────
{
  const issues = getBlockingVerificationEvidenceIssues(weakCl, undefined, 'strict');
  assert.ok(issues.length > 0, 'strict: blocking issues should be returned for weak evidence');
  assert.equal(issues.length, 1, 'strict: should emit exactly one issue per weak entry (no duplicate generic + detail)');
  assert.ok(issues.some(i => i.includes('CHK-001:happy:0')), 'issue should reference intent ref');
}
{
  const issues = getBlockingVerificationEvidenceIssues(weakCl, undefined, 'balanced');
  assert.equal(issues.length, 0, 'balanced: weak evidence should NOT be blocking');
}
{
  const issues = getBlockingVerificationEvidenceIssues(weakCl, undefined, 'light');
  assert.equal(issues.length, 0, 'light: weak evidence should NOT be blocking');
}

// ── 5. renderVerificationCoverage shows quality warnings ─────────────────────
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'balanced' });
  const rendered = renderVerificationCoverage(r);
  assert.ok(rendered.includes('[WARNING]'), 'balanced render should include WARNING label');
  assert.ok(rendered.includes('echo_pass_only'), 'balanced render should include weakness reason');
}
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'strict' });
  const rendered = renderVerificationCoverage(r);
  assert.ok(rendered.includes('[BLOCKING]'), 'strict render should include BLOCKING label');
}
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'light' });
  const rendered = renderVerificationCoverage(r);
  assert.ok(!rendered.includes('[WARNING]') && !rendered.includes('[BLOCKING]'), 'light render should have no quality labels');
}

// ── 6. Backward compatibility: no profile option = light ─────────────────────
{
  const r = buildVerificationCoverage(weakCl);
  assert.equal(r.entries[0].status, 'covered', 'default (no profile): weak evidence should be covered');
  assert.equal(r.qualityIssues, undefined, 'default: no qualityIssues');
}

// Diagnostic names include item/intent ref
{
  const r = buildVerificationCoverage(weakCl, undefined, undefined, { evidenceQualityProfile: 'strict' });
  assert.ok(r.qualityIssues![0].intentRef === 'CHK-001:happy:0', 'qualityIssue should carry intentRef');
  assert.ok(r.qualityIssues![0].itemId === 'CHK-001', 'qualityIssue should carry itemId');
}

console.log('✓ evidence quality smoke passed');
