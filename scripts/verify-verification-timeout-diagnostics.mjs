import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { verificationSpawner, verificationFailureMessage } from './verification-subprocess-budget.mjs';

function requireStartedCapture(error) {
  if (error?.code === 'ETIMEDOUT' && (error.stdout !== 'TIMEOUT_CHILD_STDOUT' || error.stderr !== 'TIMEOUT_CHILD_STDERR')) {
    throw Object.assign(new Error('VERIFICATION_SUBPROCESS_TIMEOUT: diagnostic child readiness was not observed before the existing timeout; proof unavailable'), { code: 'ETIMEDOUT' });
  }
}
let notReady;
try {
  verificationSpawner(5000)(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { encoding: 'utf8', timeout: 1000 });
} catch (error) { notReady = error; }
assert.throws(() => requireStartedCapture(notReady), error => verificationFailureMessage('startup control', error).startsWith('PROOF_UNAVAILABLE:'),
  'a real timed-out child without readiness must be unavailable, not a product assertion');
let failure;
try {
  verificationSpawner(15000)(process.execPath, ['-e',
    "require('node:fs').writeSync(1,'TIMEOUT_CHILD_STDOUT');require('node:fs').writeSync(2,'TIMEOUT_CHILD_STDERR');setInterval(()=>{},1000)"],
  { encoding: 'utf8', timeout: 10000 });
} catch (error) { failure = error; }
assert(failure, 'TIMEOUT_DIAGNOSTICS_RED real child must time out');
requireStartedCapture(failure);
assert.equal(failure.code, 'ETIMEDOUT', 'TIMEOUT_DIAGNOSTICS_RED preserve timeout code');
if (process.platform !== 'win32') assert.equal(failure.signal, 'SIGTERM', 'started POSIX child preserves actual default termination signal');
assert.equal(Object.getOwnPropertyDescriptor(failure, 'stdout').writable, true, 'AUDIT5_DIAGNOSTICS_RED diagnostic buffers remain writable');
assert.equal(failure.stdout, 'TIMEOUT_CHILD_STDOUT', 'TIMEOUT_DIAGNOSTICS_RED preserve stdout');
assert.equal(failure.stderr, 'TIMEOUT_CHILD_STDERR', 'TIMEOUT_DIAGNOSTICS_RED preserve stderr');
assert.match(failure.message, /^VERIFICATION_SUBPROCESS_TIMEOUT:/);
assert.equal(failure.status, null);
for (const field of ['stdout', 'stderr']) {
  const descriptor = Object.getOwnPropertyDescriptor(failure, field);
  assert.equal(descriptor.writable, true); assert.equal(descriptor.configurable, true);
  const value = failure[field]; failure[field] = value; Object.defineProperty(failure, field, { value });
}
assert(!inspect(failure).includes(failure.stdout) && !inspect(failure).includes(failure.stderr), 'uncaught error inspection must not duplicate rendered buffers');
const rendered = verificationFailureMessage('route child', failure);
assert.match(rendered, /^PROOF_UNAVAILABLE:/);
assert(rendered.includes(failure.stdout) && rendered.includes(failure.stderr));

// Exercise the exact caller catch body, without rerunning the native proof suite.
const driver = 'try {} catch (error) {\n    throw error;\n  }\n' + readFileSync(new URL('./verify-route-reader-regression.mjs', import.meta.url), 'utf8');
const ts = createRequire(import.meta.url)('typescript');
function actualSpawnHandler(text) {
  const tree = ts.createSourceFile('driver.mjs', text, ts.ScriptTarget.Latest, true);
  const handlers = [];
  function visit(node) {
    if (ts.isTryStatement(node) && node.tryBlock.statements.some(statement =>
      ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && ts.isCallExpression(statement.expression.right)
      && statement.expression.right.expression.getText(tree) === 'spawnSync')) handlers.push(node.catchClause);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(handlers.length, 1, 'ACTUAL_SPAWN_HANDLER_REQUIRED exactly one child-spawn try');
  assert(handlers[0], 'ACTUAL_SPAWN_HANDLER_REQUIRED child-spawn catch required');
  return handlers[0].block.getText(tree).slice(1, -1);
}
const handler = actualSpawnHandler(driver);
assert.throws(() => actualSpawnHandler(driver.replace('result = spawnSync(', 'result = unrelatedSpawn(')),
  /ACTUAL_SPAWN_HANDLER_REQUIRED/, 'an unrelated earlier catch must not replace the actual child handler');
let stderr = '';
assert.throws(() => runInNewContext(handler, { error: failure,
  process: { stderr: { write(text) { stderr += text; } } }, verificationFailureMessage }),
  error => error === failure, 'caller must retain the original failure');
assert(stderr.includes('PROOF_UNAVAILABLE:') && stderr.includes(failure.stdout) && stderr.includes(failure.stderr),
  'AUDIT6_CALLER_BINDING_RED caller must surface both child streams despite an earlier unrelated catch');
const success = verificationSpawner(5000)(process.execPath, ['-e',
  "process.stdout.write('SUCCESS_STDOUT');process.stderr.write('SUCCESS_STDERR')"], { encoding: 'utf8', timeout: 3000 });
assert.equal(success.status, 0); assert.equal(success.signal, null); assert.equal(success.error, undefined);
assert.equal(success.stdout, 'SUCCESS_STDOUT'); assert.equal(success.stderr, 'SUCCESS_STDERR');
const nonzero = verificationSpawner(5000)(process.execPath, ['-e', 'process.exit(7)'], { timeout: 3000 });
assert.equal(nonzero.status, 7); assert.equal(nonzero.signal, null); assert.equal(nonzero.error, undefined);
const signaled = verificationSpawner(5000)(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"], { timeout: 3000 });
assert.equal(signaled.status, null); assert.equal(signaled.signal, 'SIGTERM'); assert.equal(signaled.error, undefined);
const missing = verificationSpawner(5000)('/definitely-absent-route-diagnostic-executable', [], { timeout: 3000 });
assert.equal(missing.error.code, 'ENOENT');
// Exercise the actual driver's binding program, including refusal for every
// modified member of its execution graph, before any expensive proof child.
const driverTree = ts.createSourceFile('driver.mjs', driver, ts.ScriptTarget.Latest, true);
const closureIndex = driverTree.statements.findIndex(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(driverTree) === 'closure'));
assert(closureIndex >= 0 && ts.isForOfStatement(driverTree.statements[closureIndex + 2]), 'driver closure program must exist');
const closureProgram = driverTree.statements.slice(closureIndex, closureIndex + 3).map(node => node.getText(driverTree)).join('\n');
const runClosure = new Function('assert', 'readFileSync', 'resolve', 'root', 'createHash', closureProgram);
const root = resolve(import.meta.dirname, '..');
runClosure(assert, readFileSync, resolve, root, createHash);
for (const member of ['scripts/route-reader-wiring-controls.mjs', 'scripts/verify-route-reader-regression.mjs',
  'scripts/verify-verification-timeout-diagnostics.mjs', 'scripts/verify-route-reattestation-dependency-direction.mjs',
  'scripts/verification-subprocess-budget.mjs']) {
  const changedRead = (file, ...args) => file === resolve(root, member) ? Buffer.from('/* removed proof member */') : readFileSync(file, ...args);
  assert.throws(() => runClosure(assert, changedRead, resolve, root, createHash), { code: 'ERR_ASSERTION' },
    'AUDIT6_CLOSURE_REQUIRED each modified graph member must be bound: ' + member);
}
console.log('VERIFICATION_TIMEOUT_DIAGNOSTICS_PASS real timeout streams, caller reporting and success preserved');
