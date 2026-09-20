import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'scripts/verify-proof-or-stop-prompt-baseline.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'PROMPT_ENTRYPOINT_NOT_THIN: preserve entry path but extract policy, scans and verification');
for (const name of fs.readdirSync('scripts/prompt-baseline').filter(n => n.endsWith('.mjs'))) {
 assert.ok(fs.readFileSync('scripts/prompt-baseline/' + name, 'utf8').split('\n').length <= 2000, 'PROMPT_MODULE_EXCEEDS_2000: ' + name);
}
console.log('PROMPT_ENTRYPOINT_STRUCTURE_GREEN');
