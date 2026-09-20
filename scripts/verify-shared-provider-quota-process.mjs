// Build dist first. Real supervised children are local Node fixtures, never models.
import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const root = mkdtempSync(join(os.tmpdir(), 'shared-quota-process-'));
const savedUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...savedUserInfo(...args), homedir: root });
syncBuiltinESMExports();
try {
  const { runSupervisedProviderProcess } = await import('../packages/main/dist/providers/supervised-process.js');
  const adapters = {
    codex: (await import('../packages/main/dist/providers/codex-cli.js')).runBoundedCodexProvider,
    claude: (await import('../packages/main/dist/providers/claude-cli.js')).runBoundedClaudeProvider,
    gemini: (await import('../packages/main/dist/providers/gemini-cli.js')).runBoundedGeminiProvider,
  };
  for (const [provider, adapter] of Object.entries(adapters)) {
    const counter = join(root, provider + '.calls');
    const argv = ['-e', 'require("node:fs").appendFileSync(process.argv[1], "call\\n")', counter];
    const request = { provider, cwd: root, env: {
      PROOF_OR_STOP_RUN_BUDGET_ID: provider, PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS: '2',
    }, argv, timeoutMs: 5000, maxAttempts: 5 };
    // Use the real supervisor with the exact delegated options object.
    const runner = (_binary, args, options) => runSupervisedProviderProcess(process.execPath, args, options);
    for (let i = 0; i < 2; i++) {
      const result = adapter(request, runner);
      assert.equal(result.exitCode, 0); assert.equal(result.attempts, 1);
    }
    assert.throws(() => adapter(request, runner), /reservations exhausted/);
    assert.equal(readFileSync(counter, 'utf8'), 'call\ncall\n');
  }
  const options = { cwd: root, env: { PROOF_OR_STOP_RUN_BUDGET_ID: 'direct-supervisor',
    PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS: '1' }, timeoutMs: 5000 };
  assert.equal(runSupervisedProviderProcess(process.execPath, ['-e', ''], options).status, 0);
  assert.throws(() => runSupervisedProviderProcess(process.execPath, ['-e', ''], options), /reservations exhausted/);
  console.log('SHARED_QUOTA_PROCESS_GREEN three real adapter/supervisor chains, seven local children, paid calls=0');
} finally {
  os.userInfo = savedUserInfo; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
}
