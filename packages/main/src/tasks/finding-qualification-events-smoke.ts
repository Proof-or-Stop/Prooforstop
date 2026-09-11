import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { createFindingLedgerHandlers } from '../handlers/finding-ledger.js';
import { collectFindingQualificationEvents } from '../handlers/finding-qualification-events.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';

const root = mkdtempSync(join(tmpdir(), 'finding-collector-')); const oldCwd = process.cwd();
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
try {
  write('proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives' }));
  write('.gitignore', '.proof-or-stop/\nbuild/\n');
  write('build.mjs', "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('build',{recursive:true});writeFileSync('build/artifact','fixture');");
  write('experiment.mjs', `import assert from 'node:assert/strict';import{isDynamicFindingBlocking}from ${JSON.stringify(new URL('../core/finding-applicability.js', import.meta.url).href)};
console.log('FINDING_METRIC assessment_integrity_fail_closed '+process.argv[2]);
const d=isDynamicFindingBlocking({finding:{status:'open',evidenceState:'verified',severity:'high'},mode:'enforce',round:3,effectiveBlockingSeverities:['critical','high']});
assert.equal(d.blocking,process.argv[2]!=='negative-control');`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Collector fixture'); git('config', 'user.email', 'collector@example.invalid');
  git('add', '.'); git('commit', '-m', 'collector fixture'); git('checkout', '-b', 'story/B-collector'); process.chdir(root); resetConfigCache();
  const storyId = 'B-collector'; const store = new StoryStore(root); const ctx = { root, store, scanRoot: root };
  store.writeStory(storyId, { storyId, name: storyId, title: 'Isolated collector test', description: 'Not operational qualification', phase: 'REVIEW', type: 'feature', priority: 'high',
    createdAt: new Date().toISOString(), startedAt: null, endedAt: null, events: [] });
  const pins = ['missing-state', 'negative-control'].map(scenario => ({ desc: 'Preregister a single actual assertion, not a caller total.', type: 'cli' as const,
    verification: { command: `${process.execPath} experiment.mjs ${scenario}`, selector: `FINDING_METRIC assessment_integrity_fail_closed ${scenario}` } }));
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Collector', context: 'Fixture', status: 'done', startTime: null, endTime: null,
    verificationIntent: { happy: [], edge: [], adversarial: pins } }] });
  const producer = createFindingLedgerHandlers(ctx);
  const run = (scenario: string) => producer.finding_runtime_evidence_run({ storyId, idempotencyKey: scenario,
    buildCommand: { executable: process.execPath, args: ['build.mjs'] }, executionCommand: { executable: process.execPath, args: ['experiment.mjs', scenario] },
    artifactPaths: ['build/artifact'], compilerVersion: 'fixture-v1', storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY });
  const good = run('missing-state'); const bad = run('negative-control');
  const experiments = [{ metric: 'assessment_integrity_fail_closed' as const, scenarioId: 'missing-state', runtimeReceiptId: good.runtimeReceiptId },
    { metric: 'assessment_integrity_fail_closed' as const, scenarioId: 'negative-control', runtimeReceiptId: bad.runtimeReceiptId }];
  const input = { storyId, findingId: 'F-fixture', caseId: 'fixture', severity: 'high' as const, observedAt: new Date().toISOString(), experiments, reportReceiptId: 'separate-report' };
  const result = collectFindingQualificationEvents(ctx, input);
  assert.deepEqual(result.measurements.map(row => [row.numerator, row.denominator, row.synthetic]), [[1, 1, true], [0, 1, true]]);
  assert.equal(result.measurements[1]!.rollbackEvent, true);
  assert.throws(() => collectFindingQualificationEvents(ctx, { ...input, experiments: experiments.slice(0, 1) }), /omitted/);
  assert.throws(() => collectFindingQualificationEvents(ctx, { ...input, experiments: [experiments[0]!, experiments[0]!] }), /repeated/);
  assert.throws(() => collectFindingQualificationEvents(ctx, { ...input, reportReceiptId: good.runtimeReceiptId }), /self-reported/);
  assert.throws(() => collectFindingQualificationEvents(ctx, { ...input, experiments: [{ ...experiments[0]!, scenarioId: 'unregistered' }] }), /preregistered/);
  assert.ok(result.missingSourceMetrics.includes('triage_latency'));
  console.log('FINDING_QUALIFICATION_EVENTS PASS 7');
} finally { process.chdir(oldCwd); resetConfigCache(); rmSync(root, { recursive: true, force: true }); }
