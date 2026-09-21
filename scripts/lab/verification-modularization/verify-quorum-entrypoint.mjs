import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const entry = 'packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs';
const source = fs.readFileSync(entry, 'utf8');
const ast = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'QUORUM_ENTRYPOINT_NOT_THIN: isolate capabilities and supervision behind the original entry');
console.log('QUORUM_ENTRYPOINT_STRUCTURE_GREEN');
