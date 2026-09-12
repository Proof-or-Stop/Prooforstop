import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { verificationSpawner, verificationFailureMessage } from './verification-subprocess-budget.mjs';

let failure;
try {
  verificationSpawner(5000)(process.execPath, ['-e',
    "require('node:fs').writeSync(1,'TIMEOUT_CHILD_STDOUT');require('node:fs').writeSync(2,'TIMEOUT_CHILD_STDERR');setInterval(()=>{},1000)"],
  { encoding: 'utf8', timeout: 1000 });
} catch (error) { failure = error; }
assert(failure, 'TIMEOUT_DIAGNOSTICS_RED real child must time out');
assert.equal(failure.code, 'ETIMEDOUT', 'TIMEOUT_DIAGNOSTICS_RED preserve timeout code');
assert.equal(failure.signal, 'SIGTERM', 'TIMEOUT_DIAGNOSTICS_RED preserve actual signal');
assert.equal(failure.stdout, 'TIMEOUT_CHILD_STDOUT', 'TIMEOUT_DIAGNOSTICS_RED preserve stdout');
assert.equal(failure.stderr, 'TIMEOUT_CHILD_STDERR', 'TIMEOUT_DIAGNOSTICS_RED preserve stderr');
assert.match(failure.message, /^VERIFICATION_SUBPROCESS_TIMEOUT:/);
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
console.log('VERIFICATION_TIMEOUT_DIAGNOSTICS_PASS real timeout streams, caller reporting and success preserved');
