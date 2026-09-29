import { verifyTopLevelPreservation } from './verify-modular-top-level-preservation.mjs';
verifyTopLevelPreservation('process');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { execFileSync, spawnSync } from 'node:child_process';
const path = 'scripts/verify-process-fact-contract.mjs';
const original = ts.createSourceFile(path, execFileSync('git', ['show', '17ace95ded:' + path], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true);
const files = fs.readdirSync('scripts/process-fact-contract').filter(name => name.endsWith('.mjs'));
const functions = new Map();
const nestedFunctions = new Map();
for (const name of files) {
  const text = fs.readFileSync('scripts/process-fact-contract/' + name, 'utf8');
  assert.ok(text.split('\n').length <= 2000, 'PROCESS_MODULE_EXCEEDS_2000: ' + name);
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) if (ts.isFunctionDeclaration(node)) {
    assert.ok(!functions.has(node.name.text), 'duplicate process function: ' + node.name.text);
    functions.set(node.name.text, node.body.getText(ast));
    if (node.name.text === 'runCompleteProcessContract') {
      const expected = original.statements.filter(n => original.getLineAndCharacterOfPosition(n.getStart(original)).line + 1 >= 10496);
      assert.deepEqual(node.body.statements.map(n => n.getText(ast)), expected.map(n => n.getText(original).replace("await import('./prompt-projection-contract.mjs')", "await import('../prompt-projection-contract.mjs')").replace("await import(new URL('../../tests/intent-fingerprint-reuse.test.mjs', import.meta.url).href);", "await import('../../tests/intent-fingerprint-reuse.test.mjs');")).map(text => { for (const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/process-driver-sync-repairs.json','utf8'))) if (text === repair.before) text = repair.after; return text; }), 'original complete driver statements or order changed');
      for (const child of node.body.statements) if (ts.isFunctionDeclaration(child)) { assert.ok(!nestedFunctions.has(child.name.text), 'duplicate complete-driver function: ' + child.name.text); nestedFunctions.set(child.name.text, child.body.getText(ast)); }
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
  let expectedBody = node.body.getText(original);
  for (const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/process-source-binding-repairs.json', 'utf8'))) if (repair.function === node.name.text) {
    assert.ok(expectedBody.includes(repair.before)); expectedBody = expectedBody.replace(repair.before, () => repair.after);
  }
  assert.equal((original.getLineAndCharacterOfPosition(node.getStart(original)).line + 1 >= 10496 ? nestedFunctions : functions).get(node.name.text), expectedBody, 'changed process verification function ' + node.name.text);
  preserved++;
}
const run = args => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const list = run(['--list-capabilities']); assert.equal(list.status, 0, list.stderr);
const capabilities = JSON.parse(list.stdout);
assert.ok(capabilities.some(row => row.id === 'story3' && row.obligations.includes('assertStory3ProcessFactContract')));
// The complete driver's real completion markers (scripts/process-fact-contract/complete.mjs).
const PROCESS_SUCCESS_MARKERS = /PROCESS_PARTIAL_PASS|Process-fact contract verification passed|Process fact contract verified/;
const completeSource = fs.readFileSync('scripts/process-fact-contract/complete.mjs', 'utf8');
for (const marker of ['Process-fact contract verification passed', 'Process fact contract verified']) {
 assert.ok(completeSource.includes("console.log('" + marker + "')"), 'PROCESS_SUCCESS_MARKER_DRIFT: ' + marker);
 assert.match(marker, PROCESS_SUCCESS_MARKERS);
}
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=story3'], ['--quiet', '--unknown']]) {
 const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr, /Unknown process verification argument/);
 assert.doesNotMatch(result.stdout, PROCESS_SUCCESS_MARKERS);
}
console.log('PROCESS_FUNCTION_BODIES_VERIFIED ' + preserved + ' (exact source-binding repairs enumerated in process-source-binding-repairs.json)');
console.log('PROCESS_MODULAR_STRUCTURE_GREEN: original full driver and early admission sequence retained; full execution is separate evidence');
