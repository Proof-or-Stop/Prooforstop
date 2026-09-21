import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/flow-stability-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'FLOW_ENTRYPOINT_NOT_THIN: extract independently classified verification functions');
console.log('FLOW_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const dir = 'packages/main/src/tasks/flow-stability';
const before = execFileSync('git', ['show', 'cf1552808f:' + path], { encoding: 'utf8' });
const original = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true);
const bodies = new Map();
for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) {
 const text = fs.readFileSync(dir + '/' + name, 'utf8');
 assert.ok(text.split('\n').length <= 2000, 'FLOW_MODULE_EXCEEDS_2000: ' + name);
 const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 for (const n of parsed.statements) if (ts.isFunctionDeclaration(n) && n.body) bodies.set(n.name.text, n.body.getText(parsed));
}
let preserved = 0;
for (const n of original.statements) if (ts.isFunctionDeclaration(n)) {
 let expected = n.body.getText(original).replaceAll('dirname(fileURLToPath(import.meta.url))', 'ORIGINAL_TASKS_DIR').replaceAll("import('../core/dirty-worktree.js')", "import('../../core/dirty-worktree.js')");
 if (n.name.text === 'writeAcceptanceBasisDiscoveryFixture') expected = expected.slice(0, -1) + '  writeRegisteredDiscoverySnapshots(root);\n}';
 if (n.name.text === 'assertStoryAdvanceReviewEchoOmitsRetiredChannel') {
  const repair = JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/flow-fixture-repair.json', 'utf8'));
  assert.equal(expected.split(repair.before).length - 1, 1); expected = expected.replace(repair.before, repair.after);
 }
 assert.equal(bodies.get(n.name.text), expected, 'changed flow assertion ' + n.name.text); preserved++;
}
console.log('FLOW_FUNCTION_BODIES_PRESERVED ' + preserved);
const mainFlow = ts.createSourceFile(path, execFileSync('git',['show','742155e320:'+path],{encoding:'utf8'}),ts.ScriptTarget.Latest,true);
for(const name of ['assertImplementationWorkerAuthorityUsesFrozenMasterIntegrationTarget','assertImplementationWorkerAuthorityReportsUnresolvedIntegrationTarget']) assert.equal(bodies.get(name),mainFlow.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name).body.getText(mainFlow),'merged main assertion '+name);
const entry = 'packages/main/dist/tasks/flow-stability-smoke.js';
const run = args => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
const listed = JSON.parse(list.stdout);
assert.equal(listed.length, 10);
assert.equal(new Set(listed.flatMap(row => row.checks)).size, listed.flatMap(row => row.checks).length);
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=workspace'], ['--canonical-core', '--capability=workspace']]) {
 const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown flow verification argument/); assert.doesNotMatch(result.stdout, /flow stability smoke passed|FLOW_PARTIAL_PASS/);
}
const partial = run(['--capability=history-compatibility', '--capability=history-compatibility']);
assert.equal(partial.status, 0, partial.stderr); assert.match(partial.stdout, /FLOW_PARTIAL_PASS/); assert.doesNotMatch(partial.stdout, /flow stability smoke passed/);
const { createFixtureMachineEnvironment } = await import('../../../packages/main/dist/tasks/helpers/fixture-machine-environment.js');
const { VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY: policy } = await import('../../../packages/main/dist/core/runtime-fact-registry.js');
const { spawn } = await import('node:child_process');
const fixture = createFixtureMachineEnvironment();
const env = { ...fixture.env }; delete env[policy.descriptorEnvironment];
const started = performance.now();
const child = spawn(process.execPath, [entry], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false, overflow = false, killTimer;
const stop = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const abort = () => { stop('SIGTERM'); killTimer ??= setTimeout(() => stop('SIGKILL'), 2000); };
child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) { overflow = true; abort(); } });
child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16 * 1024 * 1024) { overflow = true; abort(); } });
const timer = setTimeout(() => { timedOut = true; abort(); }, 260000);
const result = await new Promise(resolve => { let error; child.once('error', e => { error = e.message; }); child.once('close', (code, signal) => resolve({ code, signal, error })); });
clearTimeout(timer); clearTimeout(killTimer);
console.log('FLOW_FULL_RESULT ' + JSON.stringify({ ...result, timedOut, overflow, elapsedMs: performance.now() - started, fixture: fixture.root }));
console.log(stdout.slice(-12000)); console.error(stderr.slice(-6000));
assert.equal(timedOut || overflow, false, 'full invocation did not complete within bounded resources');
assert.equal(result.code, 0, 'complete retained verification failed; fixture preserved');
assert.match(stdout, /✓ flow stability smoke passed/);
assert.doesNotMatch(stdout, /FLOW_PARTIAL_PASS/);
fixture.cleanup();
console.log('FLOW_MODULAR_ENTRYPOINT_GREEN');
