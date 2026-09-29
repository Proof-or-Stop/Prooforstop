import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/verification-run-and-guard-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const allowed = ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node));
assert.ok(allowed && source.split('\n').length <= 40, 'ENTRYPOINT_NOT_THIN: verification entrypoint must contain only imports, usage comments and invocation');
const root = 'packages/main/src/tasks/verification-run-and-guard';
for (const name of fs.readdirSync(root).filter(name => name.endsWith('.ts'))) {
 const text = fs.readFileSync(`${root}/${name}`, 'utf8');
 assert.ok(text.split('\n').length <= 2000, `MODULE_EXCEEDS_2000: ${name}`);
 assert.ok(!/\beval\s*\(|new Function\s*\(/.test(text), 'modularization must not concatenate and evaluate source fragments');
}
console.log('VERIFICATION_ENTRYPOINT_STRUCTURE_GREEN');

// This one-time Lab migration proof is not a new routine validation command.
const { execFileSync, spawnSync } = await import('node:child_process');
const baseline = execFileSync('git', ['show', '52d801b25b:' + path], { encoding: 'utf8' });
const before = ts.createSourceFile(path, baseline, ts.ScriptTarget.Latest, true);
const functions = new Map();
for (const name of fs.readdirSync(root).filter(name => name.endsWith('.ts'))) {
 const text = fs.readFileSync(`${root}/${name}`, 'utf8');
 const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 for (const node of file.statements) if (ts.isFunctionDeclaration(node) && node.body) {
   assert.ok(!functions.has(node.name.text), 'duplicate function after extraction');
   functions.set(node.name.text, node.body.getText(file));
 }
}
let preserved = 0;
for (const node of before.statements) if (ts.isFunctionDeclaration(node) && node.body) {
 const mergedBaseline = node.name.text === 'partIIdentityDrift' ? ts.createSourceFile(path, execFileSync('git', ['show', '0836d73b7c:' + path], {encoding:'utf8'}), ts.ScriptTarget.Latest, true) : before;
 const mergedNode = mergedBaseline.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === node.name.text);
 const expected = mergedNode.body.getText(mergedBaseline).replaceAll('fileURLToPath(import.meta.url)', "join(HERE, 'verification-run-and-guard-smoke.js')");
 assert.equal(functions.get(node.name.text), expected, `changed verification body: ${node.name.text}`);
 preserved++;
}
console.log('VERIFICATION_BODIES_PRESERVED ' + preserved);
const entry = 'packages/main/dist/tasks/verification-run-and-guard-smoke.js';
const listed = spawnSync(process.execPath, [entry, '--list-capabilities'], { encoding: 'utf8', timeout: 20000 });
assert.equal(listed.status, 0, listed.stderr);
const capabilities = JSON.parse(listed.stdout);
assert.deepEqual(capabilities.map(c => c.id), ['foundation', 'fanout', 'integrity', 'story-identity']);
assert.equal(new Set(capabilities.flatMap(c => c.checks)).size, capabilities.flatMap(c => c.checks).length, 'capability obligations overlap');
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=foundation'], ['--capability=foundation', '--unknown']]) {
 const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 20000 });
 assert.equal(result.status, 1, result.stderr);
 assert.match(result.stderr, /Unknown verification (?:argument|capability)/);
 assert.doesNotMatch(result.stdout, /VERIFICATION_CAPABILITY_PASS|VERIFICATION_PARTIAL_PASS|PASS verification-run/);
}
console.log('VERIFICATION_CAPABILITY_CLI_GREEN: list and fail-closed arguments verified; no validation registration added');

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
console.log('VERIFICATION_FULL_RESULT ' + JSON.stringify({ ...result, timedOut, overflow, elapsedMs: performance.now() - started, fixture: fixture.root }));
console.log(stdout.slice(-12000)); console.error(stderr.slice(-6000));
assert.equal(timedOut || overflow, false, 'full invocation did not complete within bounded resources');
assert.equal(result.code, 0, 'complete retained verification failed; fixture preserved');
assert.match(stdout, /PASS verification-run-and-guard-smoke subprocessExecutionCount=/);
assert.doesNotMatch(stdout, /VERIFICATION_PARTIAL_PASS/);
fixture.cleanup();
console.log(`VERIFICATION_MODULAR_ENTRYPOINT_GREEN: structure, ${preserved} preserved bodies, capability CLI and original complete invocation`);
