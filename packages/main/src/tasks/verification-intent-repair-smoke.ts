#!/usr/bin/env node
/**
 * @task B-4e06
 * @checklist CHK-001 CHK-002 CHK-004
 * @title verification intent repair + legacy diagnostic smoke
 * @type bugfix
 * @priority high
 * @description
 *   Proves the audited legacy repair reconstructs ONLY missing verificationIntent
 *   lanes from passing evidence (priority=should, never overwriting authored
 *   intent, fail-closed on malformed refs), and that the shared legacy detector
 *   used by story_review/validate diagnostics fires exactly on the
 *   evidence-without-intent state. Pure-function coverage — no git worktree.
 * @changes
 *   - [CHK-001] reconstructMissingIntentsFromEvidence happy/no-overwrite/fail-closed/sparse
 *   - [CHK-002] detectLegacyEvidenceWithoutIntent positive/negative cases
 */
import assert from 'node:assert/strict';
import { reconstructMissingIntentsFromEvidence } from '../handlers/checklist.js';
import { detectLegacyEvidenceWithoutIntent, VERIFICATION_INTENT_REPAIR_COMMAND } from '../core/verification.js';
import type { ChecklistData, ChecklistItem, VerificationEvidence, VerificationIntent } from '../core/types.js';

function ev(intentRef: string, over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return { intentRef, kind: 'integration_test', result: 'pass', note: 'smoke evidence', ...over };
}

function item(id: string, over: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id, title: id, status: 'done', startTime: null, endTime: null, ...over };
}

function cl(items: ChecklistItem[]): ChecklistData {
  return { items };
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('verification-intent-repair-smoke');

// --- CHK-001: reconstruction ---------------------------------------------------
check('reconstruct: missing intent filled from passing evidence (priority=should)', () => {
  const data = cl([item('CHK-001', { verificationEvidence: [ev('CHK-001:happy:0', { kind: 'integration_test', note: 'ran the CLI happy path' })] })]);
  const filled = reconstructMissingIntentsFromEvidence(data);
  assert.deepEqual(filled, ['CHK-001:happy:0 (cli)']);
  const intent = data.items[0].verificationIntent as VerificationIntent;
  assert.equal(intent.happy.length, 1);
  assert.equal(intent.happy[0].priority, 'should', 'synthesized intent must be should, never must');
  assert.equal(intent.happy[0].type, 'cli'); // integration_test → cli
  assert.match(intent.happy[0].desc, /ran the CLI happy path/);
});

check('reconstruct: kind→type mapping', () => {
  const data = cl([item('CHK-002', { verificationEvidence: [
    ev('CHK-002:happy:0', { kind: 'logic_test' }),
    ev('CHK-002:edge:0', { kind: 'browser_test' }),
    ev('CHK-002:adversarial:0', { kind: 'docs_check' }),
  ] })]);
  reconstructMissingIntentsFromEvidence(data);
  const vi = data.items[0].verificationIntent as VerificationIntent;
  assert.equal(vi.happy[0].type, 'logic');
  assert.equal(vi.edge[0].type, 'browser');
  assert.equal(vi.adversarial[0].type, 'docs');
});

check('reconstruct: NEVER overwrites authored intent', () => {
  const authored: VerificationIntent = { happy: [{ desc: 'authored happy', type: 'manual', priority: 'must' }], edge: [], adversarial: [] };
  const data = cl([item('CHK-001', { verificationIntent: authored, verificationEvidence: [ev('CHK-001:happy:0')] })]);
  const filled = reconstructMissingIntentsFromEvidence(data);
  assert.deepEqual(filled, [], 'authored intent already present → nothing filled');
  assert.equal((data.items[0].verificationIntent as VerificationIntent).happy[0].desc, 'authored happy');
  assert.equal((data.items[0].verificationIntent as VerificationIntent).happy[0].priority, 'must');
});

check('reconstruct: failing / waiver evidence is NEVER used', () => {
  const data = cl([item('CHK-001', { verificationEvidence: [
    ev('CHK-001:happy:0', { result: 'fail' }),
    ev('CHK-001:edge:0', { kind: 'waiver' }),
  ] })]);
  const filled = reconstructMissingIntentsFromEvidence(data);
  assert.deepEqual(filled, [], 'no intent synthesized from failing/waiver evidence');
  assert.equal(data.items[0].verificationIntent, undefined);
});

check('reconstruct: malformed item-scoped ref fails closed (throws)', () => {
  const data = cl([item('CHK-001', { verificationEvidence: [ev('CHK-001:bogus')] })]);
  assert.throws(() => reconstructMissingIntentsFromEvidence(data), /malformed intentRef/);
});

check('reconstruct: custom/foreign ref is skipped, not thrown', () => {
  const data = cl([item('CHK-001', { verificationEvidence: [ev('my-custom-intent-id')] })]);
  const filled = reconstructMissingIntentsFromEvidence(data);
  assert.deepEqual(filled, []);
});

check('reconstruct: sparse index pads lower slots with non-required placeholders', () => {
  const data = cl([item('CHK-001', { verificationEvidence: [ev('CHK-001:happy:2')] })]);
  reconstructMissingIntentsFromEvidence(data);
  const happy = (data.items[0].verificationIntent as VerificationIntent).happy;
  assert.equal(happy.length, 3);
  assert.equal(happy[0].priority, 'nice'); // padded, never required
  assert.equal(happy[1].priority, 'nice');
  assert.equal(happy[2].priority, 'should'); // the real reconstruction
  for (const slot of happy) assert.notEqual(slot, null, 'no null holes (null would decode to required must)');
});

// --- CHK-002: legacy detector --------------------------------------------------
check('detect: evidence without intent → hit naming the lane + ref', () => {
  const hits = detectLegacyEvidenceWithoutIntent(item('CHK-001', { verificationEvidence: [ev('CHK-001:happy:0')] }));
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { itemId: 'CHK-001', lane: 'happy', intentRef: 'CHK-001:happy:0' });
});

check('detect: authored intent in lane → no hit', () => {
  const authored: VerificationIntent = { happy: [{ desc: 'x', type: 'cli' }], edge: [], adversarial: [] };
  const hits = detectLegacyEvidenceWithoutIntent(item('CHK-001', { verificationIntent: authored, verificationEvidence: [ev('CHK-001:happy:0')] }));
  assert.deepEqual(hits, []);
});

check('detect: no evidence → no hit', () => {
  assert.deepEqual(detectLegacyEvidenceWithoutIntent(item('CHK-001')), []);
});

check('command-name constant is stable', () => {
  assert.equal(VERIFICATION_INTENT_REPAIR_COMMAND, 'verification_intent_repair');
});

if (failures > 0) {
  console.error(`\nverification-intent-repair-smoke FAILED (${failures} failing)`);
  process.exit(1);
}
console.log('\nverification-intent-repair-smoke PASS');
