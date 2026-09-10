import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the complete original verifier: its recovery, HTTP, assets, refusal and
// cleanup assertions must succeed before elapsed time is evaluated.
const repo = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(error => error ? reject(error) : resolve(selected));
  });
});
const started = performance.now();
const result = spawnSync(process.execPath, ['packages/graph/scripts/verify-missing-assets-fail.mjs'], {
  cwd: repo,
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, GRAPH_VERIFY_PORT: String(port) },
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
const elapsedMs = performance.now() - started;
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'Original missing-assets verifier must complete successfully before timing acceptance');
assert.match(result.stdout, /^MISSING_ASSETS_HANDLED_OK$/m);
console.log(JSON.stringify({ schemaVersion: 'graph-recovery-latency.v1', elapsedMs, limitMs: 45000, port, originalVerifierExit: result.status }));
assert.ok(elapsedMs < 45000, `GRAPH_ASSET_RECOVERY_WAITS_FOR_TIMEOUT: original checks passed but took ${elapsedMs.toFixed(1)} ms (limit 45000 ms)`);
console.log('GRAPH_ASSET_RECOVERY_LATENCY_PASS');
