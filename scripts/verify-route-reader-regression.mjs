import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { verifyRouteReaderWiring } from './route-reader-wiring-controls.mjs';

const root = resolve(import.meta.dirname, '..');
const testPath = 'packages/main/tests/red/red-dynamic-finding-four-gaps.mjs';
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const registered = readFileSync(resolve(root, 'scripts/verify-route-reattestation-dependency-direction.mjs'), 'utf8');
const tree = ts.createSourceFile('registered.mjs', registered, ts.ScriptTarget.Latest, true);
assert(tree.statements.some(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === './route-reader-wiring-controls.mjs'
  && node.importClause?.namedBindings?.elements?.some(binding => binding.name.text === 'verifyRouteReaderWiring'
    && !binding.propertyName)), 'ROUTE_READER_REGISTERED_MUTATION_RED registered suite must import actual helper');
assert(tree.statements.some(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(tree) === 'verifyRouteReaderWiring' && node.expression.arguments.length === 0),
  'ROUTE_READER_REGISTERED_MUTATION_RED registered suite must execute actual helper');
verifyRouteReaderWiring();

for (const args of [[testPath],
  ['packages/main/dist/tasks/finding-material-reattestation-smoke.js', '--route-restoration-port'],
  ['packages/main/dist/tasks/finding-material-reattestation-smoke.js', '--route-restoration-port', '--head-continuity']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);
  assert.equal(result.error, undefined, 'child execution must complete');
  assert.equal(result.signal, null, 'child execution must not be signaled');
  assert.equal(result.status, 0, args.join(' ') + ' must preserve native controls');
  assert(output.includes(args.length === 1 ? 'DYNAMIC_FINDING_FOUR_GAPS PASS' : 'ROUTE_RESTORATION_PORT PASS'));
}
console.log('ROUTE_READER_REGRESSION_GREEN composition and native material/head-only refusal controls passed');
