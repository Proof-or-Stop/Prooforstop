import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  verificationSpawner(5000)(process.execPath, ['-e',
    "require('node:fs').writeSync(1,'TIMEOUT_CHILD_STDOUT');require('node:fs').writeSync(2,'TIMEOUT_CHILD_STDERR');setInterval(()=>{},1000)"],
  { encoding: 'utf8', timeout: 1000 });
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
const driver = readFileSync(new URL('./verify-route-reader-regression.mjs', import.meta.url), 'utf8');
const handler = driver.match(/catch \(error\) \{([\s\S]*?)\n  \}/);
assert(handler, 'TIMEOUT_DIAGNOSTICS_RED official caller must report retained output');
let stderr = '';
assert.throws(() => runInNewContext(handler[1], { error: failure,
  process: { stderr: { write(text) { stderr += text; } } }, verificationFailureMessage }),
  error => error === failure, 'caller must retain the original failure');
assert(stderr.includes('PROOF_UNAVAILABLE:') && stderr.includes(failure.stdout) && stderr.includes(failure.stderr),
  'TIMEOUT_DIAGNOSTICS_RED caller must surface both child streams');
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
console.log('VERIFICATION_TIMEOUT_DIAGNOSTICS_PASS real timeout streams, caller reporting and success preserved');
