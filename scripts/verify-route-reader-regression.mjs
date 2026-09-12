import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const testPath = 'packages/main/tests/red/red-dynamic-finding-four-gaps.mjs';
const testSource = readFileSync(resolve(root, testPath), 'utf8');
const tree = ts.createSourceFile(testPath, testSource, ts.ScriptTarget.Latest, true);
const statement = tree.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'check'
  && node.expression.arguments[0]?.text === 'REATTEST-gate-consumes-verified-closure');
assert(statement, 'actual four-gaps wiring callback must exist');
const callback = statement.expression.arguments[1].getText(tree);
const source = path => readFileSync(resolve(root, 'packages/main/src', path), 'utf8');
const runWiring = overrides => runInNewContext('(' + callback + ')()', {
  assert, source: path => overrides.get(path) ?? source(path),
}, { timeout: 1000 });
runWiring(new Map());
const routePath = 'handlers/finding-route.ts';
const adapterPath = 'handlers/finding-material-reattestation.ts';
const adapter = source(adapterPath);
const declaration = 'export const readRouteSourceRestoration: RouteSourceRestorationReader = (ctx, source) => {';
assert.equal(adapter.split(declaration).length, 2, 'exact production adapter declaration must exist once');
const cases = [
  ['adapter body replaced while unrelated tokens survive', adapterPath,
    adapter.replace(declaration, 'export const readRouteSourceRestoration: RouteSourceRestorationReader = () => undefined;\nconst unrelatedReader = (ctx, source) => {')],
  ['alternate static import', routePath, source(routePath) + "\nimport { x } from '../handlers/finding-material-reattestation.js';\n"],
  ['dynamic import', routePath, source(routePath) + "\nawait import('../handlers/finding-material-reattestation.js');\n"],
];
const missed = [];
for (const [name, path, changed] of cases) {
  try { runWiring(new Map([[path, changed]])); missed.push(name); }
  catch (error) { assert.equal(error.code, 'ERR_ASSERTION', name + ' must fail an actual wiring assertion'); }
}
if (missed.length) console.error('ROUTE_READER_WIRING_MUTATION_RED ' + missed.join('; '));
assert.deepEqual(missed, [], 'actual four-gaps guards must reject each dependency mutation');
console.log('ROUTE_READER_WIRING_MUTATIONS PASS adapter scope and alternate imports');

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
