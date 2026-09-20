import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/finding-ledger-runtime-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'LEDGER_ENTRYPOINT_NOT_THIN: isolate ledger, projection, runtime and distribution verification');
console.log('LEDGER_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const dir = 'packages/main/src/tasks/finding-ledger-runtime';
const before = execFileSync('git', ['show', '8938f4fdc8:' + path], { encoding: 'utf8' });
const original = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true);
const bodies = new Map();
for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) {
 const text = fs.readFileSync(dir + '/' + name, 'utf8');
 assert.ok(text.split('\n').length <= 2000, 'LEDGER_MODULE_EXCEEDS_2000: ' + name);
 const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 for (const n of parsed.statements) if (ts.isFunctionDeclaration(n) && n.body) bodies.set(n.name.text, n.body.getText(parsed));
}
let preserved = 0;
for (const n of original.statements) if (ts.isFunctionDeclaration(n)) {
 const expected = n.name.text === 'runWorkers' ? n.body.getText(original).replace('fileURLToPath(import.meta.url)', "resolve(dirname(fileURLToPath(import.meta.url)), '..', 'finding-ledger-runtime-smoke.js')") : n.body.getText(original);
 assert.equal(bodies.get(n.name.text), expected, 'changed ledger verification ' + n.name.text); preserved++;
}
let full = original.statements.find(n => ts.isIfStatement(n) && n.getText(original).startsWith("if (process.argv[2]"));
while (ts.isIfStatement(full)) full = full.elseStatement;
const statements = [...full.statements.find(ts.isTryStatement).tryBlock.statements];
const start = statements.findIndex(n => n.getText(original).startsWith('const concurrentFile'));
const end = statements.findIndex(n => n.getText(original).startsWith('const repositoryRoot'));
const transactionText = fs.readFileSync(dir + '/transactions.ts', 'utf8');
const transactionAst = ts.createSourceFile('transactions.ts', transactionText, ts.ScriptTarget.Latest, true);
const extracted = transactionAst.statements.find(ts.isFunctionDeclaration).body.statements;
assert.deepEqual(extracted.map(n => n.getText(transactionAst)), statements.slice(start, end).map(n => n.getText(original)), 'transaction assertions or order changed');
console.log('LEDGER_FUNCTION_BODIES_PRESERVED ' + preserved + ' TRANSACTION_STATEMENTS ' + extracted.length);
const entry = 'packages/main/dist/tasks/finding-ledger-runtime-smoke.js';
const run = args => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
const listed = JSON.parse(list.stdout);
assert.deepEqual(listed.map(row => row.id), ['proposal-envelope', 'projection-receipt', 'base-authority', 'legacy-authority', 'transactions', 'readonly-mutations', 'runtime-evidence', 'rollback-concurrency', 'historical-migration', 'build-distribution', 'tamper-dependency']);
assert.equal(new Set(listed.flatMap(row => row.checks)).size, listed.flatMap(row => row.checks).length);
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=transactions'], ['--proposal-envelope-only', '--capability=transactions']]) {
 const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown Finding verification argument|Conflicting Finding verification legacy arguments/); assert.doesNotMatch(result.stdout, /Finding ledger integrity: PASS|FINDING_PARTIAL_PASS/);
}
const partial = run(['--capability=proposal-envelope', '--capability=proposal-envelope']);
assert.equal(partial.status, 0, partial.stderr); assert.match(partial.stdout, /FINDING_PARTIAL_PASS/); assert.doesNotMatch(partial.stdout, /Finding ledger integrity: PASS/);
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
console.log('LEDGER_FULL_RESULT ' + JSON.stringify({ ...result, timedOut, overflow, elapsedMs: performance.now() - started, fixture: fixture.root }));
console.log(stdout.slice(-12000)); console.error(stderr.slice(-6000));
assert.equal(timedOut || overflow, false, 'full invocation did not complete within bounded resources');
assert.equal(result.code, 0, 'complete retained verification failed; fixture preserved');
assert.match(stdout, /green.story3_matrix: PASS/);
assert.doesNotMatch(stdout, /FINDING_PARTIAL_PASS/);
fixture.cleanup();
console.log('LEDGER_MODULAR_ENTRYPOINT_GREEN');
