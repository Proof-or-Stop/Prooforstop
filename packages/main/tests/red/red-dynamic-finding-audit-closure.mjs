// Preregistered regressions for Claude audit b00e28d7 (isolated fixtures only).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as projection from '../../dist/core/finding-applicability-projection.js';
import { verifyAssessmentFreshness } from '../../dist/core/finding-applicability.js';
import { readFindingValidationConstraints } from '../../dist/core/finding-validation.js';
import { resetConfigCache } from '../../dist/core/config.js';

const root = mkdtempSync(join(tmpdir(), 'dfec-audit-red-'));
let failed = 0; let passed = 0;
function test(name, action) { try { action(); passed++; console.log(`DFEC_AUDIT ${name} PASS`); } catch (error) { failed++; console.log(`DFEC_AUDIT ${name} FAIL: ${error.message}`); } }
const configure = dynamicFinding => { writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ dynamicFinding })); resetConfigCache(); };
const forbiddenStore = new Proxy({}, { get() { throw new Error('disabled dynamic feature read gate evidence'); } });
try {
  test('kill switch also disables diagnostic reads', () => {
    configure({ mode: 'warn', killSwitch: true });
    const decision = projection.readDynamicFindingDecision({ store: forbiddenStore, projectRoot: root, storyId: 'B-X',
      finding: { id: 'F-1', severity: 'low', status: 'open', evidenceState: 'verified' }, effectiveBlockingSeverities: ['high'], round: 1, diagnostic: true });
    assert.equal(decision.blocking, false);
  });
  for (const mode of ['observe', 'warn']) test(`${mode} cannot add validation gate constraints`, () => {
    configure({ mode });
    const constraints = readFindingValidationConstraints(forbiddenStore, root, 'B-X');
    assert.deepEqual(constraints.requiredCommands, []); assert.deepEqual(constraints.reassessFindingIds, []);
  });
  test('Story-owned drift is stale, not unrelated re-attestation', () => {
    const binding = { storyId: 'B-X', scopeDigest: 'scope', baseHash: 'base', headHash: 'head', acceptanceDigest: 'intents', runtimeReceiptDigest: 'runtime', materialHash: 'material1', storyFilesHash: 'story1' };
    assert.equal(verifyAssessmentFreshness({ signature: 'fixture', integrity: { ...binding, state: 'fresh' } }, { ...binding, materialHash: 'material2', storyFilesHash: 'story2' }), 'stale');
  });
  test('repair closure survives metadata HEAD but not material drift', () => {
    assert.equal(typeof projection.repairClosureContext, 'function');
    const context = { storyId: 'B-X', scopeDigest: 's', baseHash: 'b', headHash: 'h', materialHash: 'm', storyFilesHash: 'sf', acceptanceDigest: 'a', runtimeReceiptDigest: 'r' };
    assert.deepEqual(projection.repairClosureContext(context), projection.repairClosureContext({ ...context, headHash: 'metadata' }));
    assert.notDeepEqual(projection.repairClosureContext(context), projection.repairClosureContext({ ...context, materialHash: 'changed' }));
  });
  test('new evidence closure suite is in authoritative validation inventory', () => {
    const config = JSON.parse(readFileSync(new URL('../../../../proof-or-stop.config.json', import.meta.url), 'utf8'));
    assert.ok(config.validate.commands.some(row => row.command === 'npm' && row.args.includes('test:dynamic-finding-evidence-closure')));
  });
  console.log(`DYNAMIC_FINDING_AUDIT_CLOSURE ${failed ? 'FAIL' : 'PASS'} ${passed} passed ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
