#!/usr/bin/env node
// Actual handlers, separate processes, tool-owned PASS; private fixture state only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const { StoryStore } = await import('../../packages/main/dist/core/store.js');
const { listRuntimeArtifactIgnorePatterns } = await import('../../packages/main/dist/core/runtime-artifact-registry.js');
const { persistSyntheticAdmittedWindowForTest } = await import('../../packages/main/dist/core/certification-window.js');
const { deriveCertificationDomainInputHashes } = await import('../../packages/main/dist/handlers/certification-window.js');
const { resetConfigCache } = await import('../../packages/main/dist/core/config.js');
const output = process.env.LAB_OBSERVE_OUTPUT || mkdtempSync(join(tmpdir(), 'observe-reuse-results-'));
mkdirSync(output, { recursive: true });
const trials = [], failures = [];
const cases = [
  { name: 'explicit-observe-opt-in', options: { reuseFreshRoutinePass: true }, reused: true },
  { name: 'config-observe-opt-in', configOptIn: true, reused: true },
  { name: 'default-observe-executes', reused: false },
  { name: 'explicit-disable-overrides-config', configOptIn: true, options: { reuseFreshRoutinePass: false }, reused: false },
  { name: 'dirty-material-refused', configOptIn: true, mutation: 'dirty', reused: false },
  { name: 'committed-material-refused', configOptIn: true, mutation: 'commit', reused: false },
  { name: 'command-list-change-refused', configOptIn: true, mutation: 'command', reused: false },
  { name: 'incomplete-count-refused', configOptIn: true, mutation: 'count', reused: false },
  { name: 'shadow-remains-executed', configOptIn: true, mode: 'shadow', reused: false },
  { name: 'focused-remains-executed', configOptIn: true, options: { focus: 'fast' }, reused: false },
  { name: 'validate-file-observe-opt-in', configOptIn: true, validateFile: true, reused: true },
];
for (const test of cases) {
  const fixture = mkdtempSync(join(tmpdir(), 'proof-or-stop-observe-fixture-'));
  const dir = join(output, test.name); mkdirSync(dir, { recursive: true });
  const counter = join(dir, 'children.jsonl'), storyId = 'B-labreuse';
  const git = argv => execFileSync('git', argv, { cwd: fixture, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (p, body) => { mkdirSync(dirname(join(fixture, p)), { recursive: true }); writeFileSync(join(fixture, p), body); };
  const count = () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const options = test.options || {};
  const command = { label: 'real assertion fixture', command: process.execPath, args: ['assertion.mjs'], focus: ['fast'], timeoutMs: 30000 };
  const config = { scanRoot: '.', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', validate: { dynamic: { mode: test.mode || 'observe' }, sharedExecution: false, ...(test.configOptIn !== undefined ? { reuseFreshRoutinePass: test.configOptIn } : {}), commands: [command] } };
  try {
    write('proof-or-stop.config.json', JSON.stringify(config));
    write('src/add.mjs', 'export const add=(a,b)=>a+b;\n');
    write('assertion.mjs', `import assert from 'node:assert/strict'; import {appendFileSync} from 'node:fs'; import {add} from './src/add.mjs'; assert.equal(add(2,3),5); appendFileSync(${JSON.stringify(counter)},JSON.stringify({pid:process.pid,pass:true})+'\\n'); console.log('OBSERVE_ASSERTION_PASS');\n`);
    if (test.validateFile) write('validate.mjs', "import './assertion.mjs';\n");
    write('.gitignore', listRuntimeArtifactIgnorePatterns().join('\n') + '\n');
    git(['init', '-q', '-b', 'story/' + storyId]); git(['config', 'user.email', 'lab@example.test']); git(['config', 'user.name', 'Lab fixture']); git(['add', '.']); git(['commit', '-qm', 'code']); git(['branch', 'main']); resetConfigCache();
    const store = new StoryStore(fixture);
    store.writeStory(storyId, { storyId, name: 'observe-reuse-fixture', title: 'Observe full PASS reuse', description: 'Private integration fixture', type: 'chore', phase: 'TEST', priority: 'medium', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null });
    store.writeChecklist(storyId, { items: [] });
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: fixture, causalInputHashes: deriveCertificationDomainInputHashes(fixture, 'HEAD', fixture) });
    git(['add', '.']); git(['commit', '-qm', 'private fixture state']);
    const run = n => {
      const target = join(dir, n + '.json'), start = performance.now();
      const child = spawnSync(process.execPath, [join(here, 'observe-reuse-worker.mjs'), fixture, target, JSON.stringify(options)], { cwd: fixture, encoding: 'utf8', timeout: 120000, env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'observe-reuse-fixture' } });
      writeFileSync(join(dir, n + '.log'), child.stdout + child.stderr);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      return { result: JSON.parse(readFileSync(target, 'utf8')), elapsedMs: performance.now() - start, children: count() };
    };
    const first = run('first');
    assert.equal(first.result.allPass, true, JSON.stringify(first.result));
    assert.equal(first.children, 1, 'first demand executes its actual assertion');
    if (test.mutation === 'dirty' || test.mutation === 'commit') appendFileSync(join(fixture, 'src/add.mjs'), '// new material input\n');
    if (test.mutation === 'command') { config.validate.commands.push({ ...command, label: 'additional assertion', args: ['assertion.mjs', 'additional'] }); write('proof-or-stop.config.json', JSON.stringify(config)); }
    if (test.mutation === 'count') { const e = store.readTestEvidence(storyId); e.commandExecution.commandCount = 0; store.writeTestEvidence(storyId, e); }
    if (['commit', 'command', 'count'].includes(test.mutation)) { git(['add', '.']); git(['commit', '-qm', 'negative input change']); }
    const second = run('second');
    const entry = { name: test.name, first, second, expectedReuse: test.reused, fixtureAdmission: 'synthetic; no real Story authority' };
    trials.push(entry);
    assert.equal(second.result.disposition === 'reused', test.reused, 'OBSERVE_FRESH_PASS_REUSE_MISSING: ' + test.name + ' ' + JSON.stringify(second.result.reuse));
    if (test.reused) {
      assert.equal(second.result.allPass, true);
      assert.equal(second.children, 1, 'second actual process executes zero commands');
      assert.equal(second.result.commandExecutions, 0);
      assert.equal(second.result.dynamicValidation.mode, 'observe');
      assert.equal(second.result.dynamicValidation.oracleStatus, 'not-run');
      assert.equal(second.result.dynamicValidation.authority, 'observe-only');
      assert.equal(second.result.dynamicValidation.reusedFromIdentityDigest, first.result.reuse?.identityDigest || store.readTestEvidence(storyId).routineValidationIdentity.digest);
      assert.equal(second.result.dynamicValidation.fullPlanAllPass, undefined);
      assert.equal(second.result.dynamicValidation.verdictEquivalent, undefined);
      assert.equal(second.result.dynamicValidation.observeOracle, undefined);
      assert.ok(existsSync(join(fixture, '.proof-or-stop/runtime/dynamic-validation', storyId, 'selection.json')));
      const evidence = store.readTestEvidence(storyId);
      assert.equal(evidence.resolvedDynamicMode, 'observe');
      assert.equal(evidence.reuseAdmission, 'observe-opt-in');
      assert.equal(evidence.commandExecution.commandCount, 1);
    } else {
      assert.ok(second.children > 1, 'refused reuse must launch actual assertion commands');
    }
    console.log('PASS ' + test.name);
  } catch (error) { failures.push({ name: test.name, error: String(error.stack) }); console.error('FAIL ' + test.name + ': ' + error.message); }
  finally { rmSync(fixture, { recursive: true, force: true }); resetConfigCache(); }
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ trials, failures }, null, 2));
console.log('Evidence: ' + output);
assert.equal(failures.length, 0, 'OBSERVE_FRESH_PASS_REUSE_MISSING: actual-handler acceptance and negative controls must all pass');
console.log('OBSERVE_FULL_PASS_REUSE_GREEN');
