import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(repoRoot, 'packages', 'main', 'dist');
const { createValidationCausalPreflightGate } = await import(pathToFileURL(join(distRoot, 'handlers/verifier.js')).href);
const { executeValidationPlan } = await import(pathToFileURL(join(distRoot, 'core/validation-executor.js')).href);

function validFacts(repoPath) {
  return {
    cli: { available: true, path: join(repoPath, 'proof-or-stop.js') },
    worktree: { expected: repoPath, actual: repoPath },
    gitIndex: { readable: true, path: join(repoPath, 'index'), contentDigest: 'sha256:test-index' },
    gitMaterial: { available: true, headHash: 'head-a', materialHash: 'material-a', storyFilesHash: 'story-a' },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] },
    resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
    evidenceTarget: { writable: true, path: join(repoPath, 'causal-evidence') },
    sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 },
  };
}

test('B-5a15 F-012: verifier plan launches are refused when the causal preflight snapshot changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-causal-preflight-'));
  try {
    const marker = join(root, 'launched');
    const command = {
      label: 'preflight-marker',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
    };
    const plan = { provider: 'test', commands: [command] };
    let currentFacts = validFacts(root);
    const ctx = {
      root,
      causalPreflightFacts: () => structuredClone(currentFacts),
    };
    const gate = createValidationCausalPreflightGate(ctx, 'B-verifier-preflight', [command], root);
    currentFacts = { ...currentFacts, gitIndex: { ...currentFacts.gitIndex, contentDigest: 'sha256:index-after' } };
    await assert.rejects(
      executeValidationPlan(plan, root, undefined, 'B-verifier-preflight', { jobs: 1, beforeLaunch: gate.beforeLaunch }),
      /state_changed_before_launch.*causal_preflight_refused/,
    );
    assert.equal(existsSync(marker), false, 'the changed preflight must block before the child process is launched');

    currentFacts = validFacts(root);
    const freshGate = createValidationCausalPreflightGate(ctx, 'B-verifier-preflight', [command], root);
    const result = await executeValidationPlan(plan, root, undefined, 'B-verifier-preflight', { jobs: 1, beforeLaunch: freshGate.beforeLaunch });
    assert.equal(result.allPass, true);
    assert.equal(existsSync(marker), true, 'an unchanged preflight permits the real verifier child launch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
