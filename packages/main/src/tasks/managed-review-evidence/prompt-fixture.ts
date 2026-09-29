import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { submitManagedHostRun } from '../../core/managed-host-run.js';

// Direct transport fixtures must seal exactly the prompt they submit, just as
// the public host_run producer does. Re-rendering at import is not authority.
export function withManagedFixturePrompt(
  input: Parameters<typeof submitManagedHostRun>[0],
): Parameters<typeof submitManagedHostRun>[0] {
  assert.ok(input.reviewBinding, 'managed transport fixture requires an existing review tuple');
  return {
    ...input,
    reviewBinding: {
      ...input.reviewBinding,
      managedPromptDigest: `sha256:${createHash('sha256').update(input.promptText, 'utf8').digest('hex')}`,
    },
  };
}
