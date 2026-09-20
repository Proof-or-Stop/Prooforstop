import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/tests/milestone-status.test.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'MILESTONE_ENTRYPOINT_NOT_THIN: extract independently classified verification blocks');
console.log('MILESTONE_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const dir = 'packages/main/tests/milestone-status';
const before = execFileSync('git', ['show', 'd085bce946:' + path], { encoding: 'utf8' });
const original = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true);
const bodies = new Map();
for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
 const text = fs.readFileSync(dir + '/' + name, 'utf8');
 assert.ok(text.split('\n').length <= 2000, 'MILESTONE_MODULE_EXCEEDS_2000: ' + name);
 const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 for (const n of parsed.statements) if (ts.isFunctionDeclaration(n) && n.body) bodies.set(n.name.text, n.body.getText(parsed));
}
const blocks = original.statements.filter(ts.isBlock);
const expectedBlocks = blocks.map(block => block.getText(original));
const repairs = JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/milestone-assertion-repairs.json', 'utf8'));
for (const repair of repairs) {
 assert.equal(expectedBlocks[29].split(repair.before).length - 1, 1, 'repair must name exactly one original assertion');
 expectedBlocks[29] = expectedBlocks[29].replace(repair.before, repair.after);
}
blocks.forEach((block, i) => assert.equal(bodies.get('case' + String(i + 1).padStart(2, '0')), expectedBlocks[i], 'changed original verification block ' + i));
for (const n of original.statements) if (ts.isFunctionDeclaration(n)) assert.equal(bodies.get(n.name.text), n.body.getText(original), 'changed helper ' + n.name.text);
console.log('MILESTONE_ORIGINAL_BLOCKS_PRESERVED ' + blocks.length);
const run = args => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 260000, maxBuffer: 16 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
assert.deepEqual(JSON.parse(list.stdout).map(row => row.id), ['reporting', 'planning', 'closeout', 'freshness', 'coverage', 'read-only', 'cli-behavior']);
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=reporting']]) {
 const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown milestone verification argument/); assert.doesNotMatch(result.stdout, /ok milestone-status|MILESTONE_PARTIAL_PASS/);
}
const partial = run(['--capability=reporting', '--capability=reporting']);
assert.equal(partial.status, 0, partial.stderr); assert.match(partial.stdout, /MILESTONE_PARTIAL_PASS/); assert.doesNotMatch(partial.stdout, /ok milestone-status/);
const started = performance.now(), full = run([]);
console.log('MILESTONE_FULL_RESULT ' + JSON.stringify({ code: full.status, signal: full.signal, elapsedMs: performance.now() - started }));
console.log(full.stdout); console.error(full.stderr);
assert.equal(full.status, 0, 'original complete milestone validation must pass');
assert.match(full.stdout, /ok milestone-status/); assert.doesNotMatch(full.stdout, /MILESTONE_PARTIAL_PASS/);
console.log('MILESTONE_MODULAR_ENTRYPOINT_GREEN');
