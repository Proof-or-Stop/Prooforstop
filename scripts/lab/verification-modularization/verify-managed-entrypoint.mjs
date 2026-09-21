import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/managed-review-evidence-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'MANAGED_ENTRYPOINT_NOT_THIN: separate transport, evidence, tamper and worker capabilities');
console.log('MANAGED_ENTRYPOINT_STRUCTURE_GREEN');
