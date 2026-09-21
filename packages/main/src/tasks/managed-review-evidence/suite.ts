import assert from 'node:assert/strict';


import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from "../../core/config.js";



















import { normalizeHostRunModelSelection } from "../../core/host-run.js";





import { assertHostOwnedMutationEnvDropsReviewerDispatchAuthority } from "./environment.js";



import { runPhase as phase0 } from './codex-transport.js';
import { runPhase as phase1 } from './claude-transport.js';
import { runPhase as phase2 } from './evidence-binding.js';
import { runPhase as phase3 } from './native-attestation.js';
import { runPhase as phase4 } from './sealed-receipts.js';
export async function main(maxPhase?: number, descriptorOnly = false): Promise<number> {
assert.deepEqual(
    normalizeHostRunModelSelection({ host: 'codex' }),
    { model: null, reasoningEffort: null },
    'omitted model selection preserves the historical default contract',
  );
for (const model of ['model with whitespace', 'model\ncontrol', 'x'.repeat(257)]) {
    assert.throws(
      () => normalizeHostRunModelSelection({ host: 'codex', model }),
      /--model must be a non-empty model id of at most 256 characters without whitespace or controls/,
      'model ids that are unsafe or outside the bounded contract fail before provider launch',
    );
  }
assert.throws(
    () => normalizeHostRunModelSelection({ host: 'codex', reasoningEffort: 'extreme' }),
    /--reasoningEffort must be one of/,
    'unknown reasoning effort fails before provider launch',
  );
for (const reasoningEffort of ['none', 'minimal', 'ultra'] as const) {
    assert.throws(
      () => normalizeHostRunModelSelection({ host: 'claude', reasoningEffort }),
      /Claude --reasoningEffort must be one of low, medium, high, xhigh, max/,
      'Claude rejects reasoning levels that its public CLI cannot honor',
    );
  }
assertHostOwnedMutationEnvDropsReviewerDispatchAuthority();
const root = mkdtempSync(join(tmpdir(), 'managed-review-evidence-smoke-'));
const originalCwd = process.cwd();
const evaluatorMutationBoundary = process.env.LATTICE_VALID_TRUE_MUTATION_BOUNDARY;
const bindingMutationTarget = process.env.LATTICE_BINDING_MUTATION_NAME;
try {
const result0 = await phase0({ root, evaluatorMutationBoundary, bindingMutationTarget, fullRun: maxPhase === undefined, descriptorOnly });
if (!result0) return -1;
if (maxPhase === 0) return 0;
const result1 = await phase1(result0);
if (!result1) return -1;
if (maxPhase === 1) return 1;
const result2 = await phase2(result1);
if (!result2) return -1;
if (maxPhase === 2) return 2;
const result3 = await phase3(result2);
if (!result3) return -1;
if (maxPhase === 3) return 3;
const result4 = await phase4(result3);
if (!result4) return -1;
if (maxPhase === 4) return 4;
return 4;
} finally {
    process.chdir(originalCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}
