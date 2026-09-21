import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path='scripts/verify-proof-or-stop-identity-cutover.mjs';
const text=fs.readFileSync(path,'utf8');
const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
assert.ok(text.split('\n').length<=40&&ast.statements.every(node=>ts.isImportDeclaration(node)||ts.isExportDeclaration(node)||ts.isExpressionStatement(node)), 'IDENTITY_ENTRYPOINT_NOT_THIN: separate rule data, provenance, source integrity, scanning and certification');
console.log('IDENTITY_ENTRYPOINT_STRUCTURE_GREEN');
