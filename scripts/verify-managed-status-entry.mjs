import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'managed-status-entry-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), '{}');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../packages/main/dist/cli.js', import.meta.url)),
    'host_run_status', '--runId=absent-witness', '--json'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.match(`${result.stdout}\n${result.stderr}`, /managed host run not found: absent-witness/,
    'U02: durable run status must exist and distinguish an absent run');
  assert.equal(result.status, 1);
  console.log('PASS U02 managed-status-entry');
} finally { rmSync(root, { recursive: true, force: true }); }
