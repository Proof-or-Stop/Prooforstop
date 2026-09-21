import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { execFileSync, spawnSync } from 'node:child_process';
const path = 'scripts/verify-process-fact-contract.mjs';
const original = ts.createSourceFile(path, execFileSync('git', ['show', '17ace95ded:' + path], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true);
const files = fs.readdirSync('scripts/process-fact-contract').filter(name => name.endsWith('.mjs'));
const functions = new Map();
for (const name of files) {
  const text = fs.readFileSync('scripts/process-fact-contract/' + name, 'utf8');
  assert.ok(text.split('\n').length <= 2000, 'PROCESS_MODULE_EXCEEDS_2000: ' + name);
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) if (ts.isFunctionDeclaration(node)) {
    functions.set(node.name.text, node.body.getText(ast));
    if (node.name.text === 'runCompleteProcessContract') {
      const expected = original.statements.filter(n => original.getLineAndCharacterOfPosition(n.getStart(original)).line + 1 >= 10496);
      assert.deepEqual(node.body.statements.map(n => n.getText(ast)), expected.map(n => n.getText(original)), 'original complete driver statements or order changed');
      for (const child of node.body.statements) if (ts.isFunctionDeclaration(child)) functions.set(child.name.text, child.body.getText(ast));
    }
    if (node.name.text === 'runEarlyProcessChecks') {
      const expected = original.statements.filter(n => {
        const line = original.getLineAndCharacterOfPosition(n.getStart(original)).line + 1;
        return line >= 1178 && line < 10496 && !ts.isFunctionDeclaration(n) && !ts.isVariableStatement(n) && !ts.isImportDeclaration(n);
      });
      assert.deepEqual(node.body.statements.map(n => n.getText(ast)), expected.map(n => n.getText(original)), 'early admission checks or order changed');
    }
  }
}
let preserved = 0;
for (const node of original.statements) if (ts.isFunctionDeclaration(node)) {
  assert.equal(functions.get(node.name.text), node.body.getText(original), 'changed process verification function ' + node.name.text);
  preserved++;
}
const run = args => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
const capabilities = JSON.parse(list.stdout);
assert.ok(capabilities.some(row => row.id === 'story3' && row.obligations.includes('assertStory3ProcessFactContract')));
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=story3'], ['--quiet', '--unknown']]) {
 const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown process verification argument/);
 assert.doesNotMatch(result.stdout, /PROCESS_PARTIAL_PASS|Process fact contract passed/);
}
console.log('PROCESS_ORIGINAL_FUNCTION_BODIES_PRESERVED ' + preserved);
console.log('PROCESS_MODULAR_STRUCTURE_GREEN: original full driver and early admission sequence retained; full execution is separate evidence');
