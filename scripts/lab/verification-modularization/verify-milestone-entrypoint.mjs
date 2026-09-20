import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/tests/milestone-status.test.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'MILESTONE_ENTRYPOINT_NOT_THIN: extract independently classified verification blocks');
console.log('MILESTONE_ENTRYPOINT_STRUCTURE_GREEN');
