import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/tests/canonical-new-story-artifacts.test.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'CANONICAL_ENTRYPOINT_NOT_THIN: separate artifact, identity, runtime and release capabilities');
console.log('CANONICAL_ENTRYPOINT_STRUCTURE_GREEN');
