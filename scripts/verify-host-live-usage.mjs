import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostRun, UsageLineScanner } from '../packages/main/dist/core/host-run.js';
const root = mkdtempSync(join(tmpdir(), 'live-provider-usage-'));
try {
  for (const host of ['codex', 'claude']) {
    const observations = [];
    const usage = host === 'codex'
      ? { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }
      : { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 } };
    await runHostRun({ host, storyId: null, phase: 'DEV', agentType: 'usage-fixture', promptText: 'Inspect the fixture.',
      cwd: root, root, timeoutMs: 2000, recordedAt: new Date().toISOString(), projectRootHash: 'fixture',
      env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' } }, {
      onProviderUsage: value => observations.push(value),
      runner: async plan => {
        const scanner = new UsageLineScanner(plan.retainUsageLine, 1024);
        scanner.push(JSON.stringify({ type: 'item.completed', item: { text: JSON.stringify(usage) } }) + '\n');
        scanner.push(JSON.stringify({ ...usage, usage: { input_tokens: -1, output_tokens: 5 } }) + '\n');
        scanner.push('x'.repeat(2048) + JSON.stringify(usage) + '\n');
        assert.equal(observations.length, 0, 'tool payloads, invalid counts and truncated lines grant no usage authority');
        const line = JSON.stringify(usage);
        scanner.push(line.slice(0, 12)); scanner.push(line.slice(12) + '\n');
        assert.equal(observations.length, 1, 'U15 supervisor must observe valid provider usage before child exit');
        assert.equal(observations[0].tokens, 150, 'cache input counted once across provider adapters');
        scanner.push(JSON.stringify({ ...usage, usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 10 } }) + '\n');
        assert.equal(observations.length, 1, 'unsafe total cannot authorize a stop');
        return { stdout: scanner.retainedText(), stderr: '', exitCode: 0, timedOut: false };
      },
    });
  }
  console.log('PASS U15 bounded live provider usage before exit, adapters, malformed and tool payload rejection');
} finally { rmSync(root, { recursive: true, force: true }); }
