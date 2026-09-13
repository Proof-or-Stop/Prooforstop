import './verify-verification-timeout-diagnostics.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { prepareVerification, verificationFailureMessage } from './verification-subprocess-budget.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const suitePath = 'scripts/verify-route-reattestation-dependency-direction.mjs';
const registered = readFileSync(resolve(root, suitePath), 'utf8');
function verifyRegistration(text) {
  const tree = ts.createSourceFile(suitePath, text, ts.ScriptTarget.Latest, true);
  assert(tree.statements.some(node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === './route-reader-wiring-controls.mjs'
    && node.importClause?.namedBindings?.elements?.some(binding => binding.name.text === 'verifyRouteReaderWiring'
      && !binding.propertyName)), 'ROUTE_READER_REGISTERED_MUTATION_RED suite must import actual helper');
  assert(tree.statements.some(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === 'verifyRouteReaderWiring' && node.expression.arguments.length === 0),
    'ROUTE_READER_REGISTERED_MUTATION_RED suite must execute actual helper');
}
verifyRegistration(registered);
const parsed = ts.createSourceFile(suitePath, registered, ts.ScriptTarget.Latest, true);
for (const node of parsed.statements.filter(node =>
  (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './route-reader-wiring-controls.mjs')
  || (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(parsed) === 'verifyRouteReaderWiring'))) {
  assert.throws(() => verifyRegistration(registered.slice(0, node.getStart(parsed)) + registered.slice(node.end)),
    /ROUTE_READER_REGISTERED_MUTATION_RED/, 'removing either import or invocation must be refused independently');
}
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
assert.equal(scripts['test:route-reattestation-dependency-direction'], 'node scripts/verify-route-reader-regression.mjs',
  'ROUTE_READER_CONSOLIDATED_RED existing registered entry must execute durable driver');
assert(scripts['test:serial-reference'].split(' && ').includes('npm run test:route-reattestation-dependency-direction'));
const closure = JSON.parse(readFileSync(resolve(root, 'scripts/lab/u18-static-edges/exceptions.json'), 'utf8')).entries
  .filter(entry => entry.dependencyDigests?.['packages/main/tests/red/red-dynamic-finding-four-gaps.mjs']);
assert.equal(closure.length, 4, 'reviewed four-gaps dependency closure must remain complete');
for (const file of ['scripts/route-reader-wiring-controls.mjs', 'scripts/verify-route-reader-regression.mjs',
  'scripts/verify-verification-timeout-diagnostics.mjs', 'scripts/verify-route-reattestation-dependency-direction.mjs',
  'scripts/verification-subprocess-budget.mjs', 'packages/main/tests/canonical-new-story-artifacts.test.mjs',
  'scripts/verify-proof-or-stop-identity-cutover.mjs',
  'scripts/verify-proof-or-stop-pack-boundary.mjs',
  'packages/main/tests/support/active-identity-operation-ownership.mjs',
  'packages/main/tests/support/private-mutation-observer.mjs',
  'scripts/verify-acceptance-amendment-delta.mjs',
  'scripts/identity-maintenance-boundaries.mjs',
  'scripts/identity-child-closure.mjs',
  'scripts/identity-child-contract.json',
  'packages/main/src/core/store.ts',
  'packages/main/src/core/causal-evidence.ts',
  'packages/main/src/core/runtime-environment-checks.ts',
  ...['source', 'json', 'fixture'].flatMap(kind => [`scripts/identity-reviewed-${kind}-contexts.mjs`, `scripts/identity-reviewed-${kind}-data.json`])]) {
  const digest = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex');
  assert(closure.every(entry => entry.dependencyDigests[file] === digest), 'route verifier helper dependency must match current source: ' + file);
}
console.log('ROUTE_READER_REGISTRATION PASS independent import/call removal controls');

// Keep the existing suite's native/history/contract children and budgets intact.
// The registered suite is run once; this driver adds no duplicate native modes.
const spawnSync = prepareVerification(root, { shareBuild: true, bodyBudgetMs: 600000 });
for (const [path, timeout, selector, args = []] of [
  ['packages/main/tests/red/red-dynamic-finding-four-gaps.mjs', 180000, ['DYNAMIC_FINDING_FOUR_GAPS PASS']],
  ['packages/main/tests/canonical-new-story-artifacts.test.mjs', 180000, ['GREEN B-49df: identity-sites group pass.'], ['--group=identity-sites']],
  [suitePath, 600000, ['ROUTE_DIRECTION_NATIVE_GREEN', 'ROUTE_READER_WIRING_MUTATIONS PASS']],
  ['scripts/verify-validation-static-edges.mjs', 180000, ['U18_STATIC_PASS']],
]) {
  let result;
  try {
    result = spawnSync(process.execPath, [path, ...args], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    process.stderr.write(verificationFailureMessage('route verification child', error) + '\n');
    throw error;
  }
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);
  assert.equal(result.error, undefined, 'child execution must complete');
  assert.equal(result.signal, null, 'child execution must not be signaled');
  assert.equal(result.status, 0, path + ' must preserve existing controls');
  for (const required of selector) assert(output.includes(required), path + ' must report ' + required);
}
console.log('ROUTE_READER_REGRESSION_GREEN registered full suite, current builds and static evidence passed');
