/**
 * B-1fca CHK-002: Smoke tests for reviewer-quorum module.
 * Run: npm run test:legacy -- reviewer-quorum
 */

import { evaluateReviewerQuorum } from '../core/reviewer-quorum.js';
import type { ReviewerEvidenceEntry } from '../core/reviewer-quorum.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function passEntry(lane: string): ReviewerEvidenceEntry {
  return { lane, kind: 'pass', signatureValid: true };
}

function findingEntry(lane: string): ReviewerEvidenceEntry {
  return { lane, kind: 'finding', signatureValid: true };
}

// ── Test 1: strict all required lanes present + independent verifier => ok ───

console.log('\nTest 1: strict — all lanes covered + independent verifier');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality', 'test-coverage'],
    evidence: [
      {
        ...passEntry('lattice-review-concept'),
        producer: { actor: 'agent-A', provider: 'anthropic', vendor: 'anthropic', model: 'claude-opus-4-7' },
        verifier: { actor: 'agent-B', provider: 'anthropic', vendor: 'anthropic', model: 'claude-sonnet-4-6' },
      },
      {
        ...passEntry('lattice-review-quality'),
        producer: { actor: 'agent-A' },
        verifier: { actor: 'agent-B' },
      },
      {
        ...passEntry('lattice-review-test-coverage'),
        producer: { actor: 'agent-A' },
        verifier: { actor: 'agent-B' },
      },
    ],
    profile: 'strict',
    requireDifferentiatedVerifier: true,
  });
  assert('ok is true', result.ok, JSON.stringify(result.blocking));
  assert('no blocking messages', result.blocking.length === 0, result.blocking.join('; '));
  assert('no warnings', result.warnings.length === 0, result.warnings.join('; '));
}

// ── Test 2: strict missing lane => blocking ───────────────────────────────────

console.log('\nTest 2: strict — missing lane => blocking');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality', 'test-coverage'],
    evidence: [
      passEntry('lattice-review-concept'),
      passEntry('lattice-review-quality'),
      // test-coverage missing
    ],
    profile: 'strict',
  });
  assert('ok is false', !result.ok);
  assert('blocking contains missing_lane for test-coverage', result.blocking.some(m => m.includes('lattice-review-test-coverage')));
  assert('missing_lane diagnostic exists', result.diagnostics.some(d => d.code === 'missing_lane' && d.lane === 'lattice-review-test-coverage' && d.severity === 'blocking'));
}

// ── Test 3: balanced missing metadata => warning, ok ─────────────────────────

console.log('\nTest 3: balanced — missing verifier metadata => warning, ok');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality'],
    evidence: [
      passEntry('lattice-review-concept'),  // no producer/verifier metadata
      passEntry('lattice-review-quality'),
    ],
    profile: 'balanced',
    requireDifferentiatedVerifier: true,
  });
  assert('ok is true', result.ok, JSON.stringify(result.blocking));
  assert('has warning for missing verifier metadata', result.warnings.some(w => w.includes('Verifier metadata absent')));
  assert('no blocking', result.blocking.length === 0);
}

// ── Test 4: strict same actor/provider => blocking ────────────────────────────

console.log('\nTest 4: strict — same actor as producer and verifier => blocking');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept'],
    evidence: [
      {
        ...passEntry('lattice-review-concept'),
        producer: { actor: 'agent-X', provider: 'anthropic', vendor: 'anthropic', model: 'claude-opus-4-7' },
        verifier: { actor: 'agent-X', provider: 'anthropic', vendor: 'anthropic', model: 'claude-opus-4-7' },
      },
    ],
    profile: 'strict',
  });
  assert('ok is false', !result.ok);
  assert('blocking contains same_producer_verifier', result.blocking.some(m => m.includes('same entity')));
  assert('diagnostic code is same_producer_verifier', result.diagnostics.some(d => d.code === 'same_producer_verifier' && d.severity === 'blocking'));
}

// ── Test 5: lane mapping aligns with active reviewer names ────────────────────

console.log('\nTest 5: lane mapping — concept/quality/test-coverage short names expand to full lanes');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality', 'test-coverage'],
    evidence: [
      passEntry('lattice-review-concept'),
      passEntry('lattice-review-quality'),
      passEntry('lattice-review-test-coverage'),
    ],
    profile: 'strict',
  });
  assert('ok is true', result.ok, JSON.stringify(result.blocking));
  // verify short-name in agent field also works as coverage
  const result2 = evaluateReviewerQuorum({
    activeReviewers: ['concept'],
    evidence: [
      { lane: 'lattice-review-concept', agent: 'concept', kind: 'pass', signatureValid: true },
    ],
    profile: 'strict',
  });
  assert('short agent name covers full lane', result2.ok, JSON.stringify(result2.blocking));
}

console.log('\nTest 5b: active reviewer source — computeActiveReviewers feeds quorum lanes');
{
  const active = computeActiveReviewers(
    { riskSignals: [] },
    { items: [{ id: 'CHK-001' }] },
    null,
    [],
  ).map(r => r.name);
  assert('computeActiveReviewers includes baseline concept', active.includes('concept'));
  assert('computeActiveReviewers includes baseline quality', active.includes('quality'));
  assert('computeActiveReviewers includes baseline test-coverage', active.includes('test-coverage'));
  const result = evaluateReviewerQuorum({
    activeReviewers: active,
    evidence: active.map(name => passEntry(`lattice-review-${name}`)),
    profile: 'strict',
  });
  assert('computed active reviewers satisfy quorum with matching lane evidence', result.ok, JSON.stringify(result.blocking));
}

// ── Test 6: light profile — no blocking even for missing lanes ────────────────

console.log('\nTest 6: light — missing lanes => no blocking, no warnings');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality', 'test-coverage'],
    evidence: [],
    profile: 'light',
  });
  assert('ok is true', result.ok);
  assert('no blocking', result.blocking.length === 0);
  assert('no warnings', result.warnings.length === 0);
}

// ── Test 7: balanced missing lane => warning, ok ─────────────────────────────

console.log('\nTest 7: balanced — missing lane => warning, ok');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept', 'quality'],
    evidence: [passEntry('lattice-review-concept')],
    profile: 'balanced',
  });
  assert('ok is true', result.ok, JSON.stringify(result.blocking));
  assert('warning for missing quality', result.warnings.some(w => w.includes('lattice-review-quality')));
  assert('no blocking', result.blocking.length === 0);
}

// ── Test 8: strict open finding => blocking ───────────────────────────────────

console.log('\nTest 8: strict — open finding entry => blocking dispute');
{
  const result = evaluateReviewerQuorum({
    activeReviewers: ['concept'],
    evidence: [findingEntry('lattice-review-concept')],
    profile: 'strict',
  });
  assert('ok is false', !result.ok);
  assert('blocking contains open_finding_dispute', result.blocking.some(m => m.includes('Blocking finding')));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
