import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path='packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts';
const text=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
assert.ok(text.split('\n').length<=40&&ast.statements.every(n=>ts.isImportDeclaration(n)||ts.isExpressionStatement(n)),'RETIRED_ENTRYPOINT_NOT_THIN: separate rule data, loader analysis, graph analysis and controls');
console.log('RETIRED_ENTRYPOINT_STRUCTURE_GREEN');
