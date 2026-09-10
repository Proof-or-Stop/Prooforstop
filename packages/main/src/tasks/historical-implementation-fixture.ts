import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// An archived test input, not an assertion about the checkout's main ancestry.
// Reproduction bundles carry this unchanged shallow source with its original tree.
export const HISTORICAL_IMPLEMENTATION = 'b1a0bee88c2a57e33d3835600db53bb9297f04c1';
const COMMIT_SHA256 = '99b5adb68c3645ffa11b7076d2873a87724e0628f93e70c55d4fdcf3357b157e';
const AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>';

export function verifyHistoricalImplementationBytes(bytes: Buffer): void {
  const object = createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(object, HISTORICAL_IMPLEMENTATION, 'HISTORICAL_FIXTURE_OBJECT_CHANGED');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), COMMIT_SHA256, 'HISTORICAL_FIXTURE_BYTES_CHANGED');
  assert.ok(bytes.toString('utf8').split('\n\n')[0].split('\n')
    .includes(`author ${AUTHOR} 1788517101 +0100`), 'HISTORICAL_FIXTURE_AUTHOR_CHANGED');
}

export function assertHistoricalImplementationSource(sourceRoot: string): string {
  let bytes: Buffer;
  try {
    bytes = execFileSync('git', ['cat-file', 'commit', HISTORICAL_IMPLEMENTATION], { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`HISTORICAL_FIXTURE_OBJECT_MISSING: ${HISTORICAL_IMPLEMENTATION}; restore the byte-pinned archived test input from the reproduction bundle into this isolated checkout; main ancestry is not required`);
  }
  verifyHistoricalImplementationBytes(bytes);
  return HISTORICAL_IMPLEMENTATION;
}
