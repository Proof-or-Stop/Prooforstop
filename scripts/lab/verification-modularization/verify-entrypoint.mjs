import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/verification-run-and-guard-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const allowed = ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node));
assert.ok(allowed && source.split('\n').length <= 40, 'ENTRYPOINT_NOT_THIN: verification entrypoint must contain only imports, usage comments and invocation');
const root = 'packages/main/src/tasks/verification-run-and-guard';
for (const name of fs.readdirSync(root).filter(name => name.endsWith('.ts'))) {
 const text = fs.readFileSync(`${root}/${name}`, 'utf8');
 assert.ok(text.split('\n').length <= 2000, `MODULE_EXCEEDS_2000: ${name}`);
 assert.ok(!/\beval\s*\(|new Function\s*\(/.test(text), 'modularization must not concatenate and evaluate source fragments');
}
console.log('VERIFICATION_ENTRYPOINT_STRUCTURE_GREEN');
