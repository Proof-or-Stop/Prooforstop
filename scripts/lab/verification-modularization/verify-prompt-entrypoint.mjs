import { verifyTopLevelPreservation } from './verify-modular-top-level-preservation.mjs';
verifyTopLevelPreservation('prompt');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'scripts/verify-proof-or-stop-prompt-baseline.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'PROMPT_ENTRYPOINT_NOT_THIN: preserve entry path but extract policy, scans and verification');
for (const name of fs.readdirSync('scripts/prompt-baseline').filter(n => n.endsWith('.mjs'))) {
 assert.ok(fs.readFileSync('scripts/prompt-baseline/' + name, 'utf8').split('\n').length <= 2000, 'PROMPT_MODULE_EXCEEDS_2000: ' + name);
}
console.log('PROMPT_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const baseline = execFileSync('git', ['show', '856e011213:' + path], { encoding: 'utf8' });
const original = ts.createSourceFile(path, baseline, ts.ScriptTarget.Latest, true);
const functions = new Map();
for (const name of fs.readdirSync('scripts/prompt-baseline').filter(n => n.endsWith('.mjs'))) {
 const text = fs.readFileSync('scripts/prompt-baseline/' + name, 'utf8');
 const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 for (const node of file.statements) if (ts.isFunctionDeclaration(node) && node.body) {
   assert.ok(!functions.has(node.name.text), 'duplicate extracted verification function');
   functions.set(node.name.text, node.body.getText(file));
 }
}
let preserved = 0;
for (const node of original.statements) if (ts.isFunctionDeclaration(node) && node.body) {
 assert.equal(functions.get(node.name.text), node.body.getText(original), 'changed prompt verification: ' + node.name.text); preserved++;
}
console.log('PROMPT_FUNCTION_BODIES_PRESERVED ' + preserved);
const run = args => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 260000, maxBuffer: 16 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
assert.deepEqual(JSON.parse(list.stdout).map(row => row.id), ['registry', 'prompt-policy', 'baseline-drift', 'role-matrix', 'legacy-vocabulary', 'direct-story-policy', 'measurement']);
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=registry'], ['--write', '--capability=registry']]) {
 const result = run(args); assert.equal(result.status, 1, result.stderr);
 assert.match(result.stderr, /Unknown prompt verification (?:argument|capability)/);
 assert.doesNotMatch(result.stdout, /WROTE|PROMPT_CAPABILITY_PASS|PROMPT_PARTIAL_PASS/);
}
for (const arg of ['--probe-direct-story-classifier', '--probe-legacy-vocabulary-policy']) {
 const result = run([arg]); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS diagnostic/);
}
console.log('PROMPT_CAPABILITY_ARGUMENTS_GREEN');
const partial = run(['--capability=registry', '--capability=registry']);
assert.equal(partial.status, 0, partial.stderr);
assert.equal((partial.stdout.match(/PROMPT_CAPABILITY_PASS /g) || []).length, 1, 'duplicate capability executed twice');
assert.match(partial.stdout, /PROMPT_PARTIAL_PASS/); assert.doesNotMatch(partial.stdout, /PASS proof-or-stop prompt baseline:/);
const started = performance.now(), full = run([]);
console.log('PROMPT_FULL_RESULT ' + JSON.stringify({ code: full.status, signal: full.signal, error: full.error?.code, elapsedMs: performance.now() - started }));
console.log(full.stdout); console.error(full.stderr);
assert.equal(full.status, 0, 'original complete prompt validation must still pass');
assert.match(full.stdout, /PASS proof-or-stop prompt baseline:/); assert.doesNotMatch(full.stdout, /PROMPT_PARTIAL_PASS/);
console.log('PROMPT_MODULAR_ENTRYPOINT_GREEN');
