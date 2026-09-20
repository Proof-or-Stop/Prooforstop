import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/finding-ledger-runtime-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'LEDGER_ENTRYPOINT_NOT_THIN: isolate ledger, projection, runtime and distribution verification');
console.log('LEDGER_ENTRYPOINT_STRUCTURE_GREEN');
