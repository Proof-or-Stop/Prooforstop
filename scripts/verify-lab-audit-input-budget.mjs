import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditInput } from './lab-audit.mjs';
import { LAB_MAINTENANCE_RUNTIME_REQUIREMENTS as policy, SUPERVISED_PROVIDER_RUNTIME_POLICY as provider } from '../packages/main/src/core/runtime-fact-registry.ts';
const root = mkdtempSync(join(tmpdir(), 'audit-input-budget-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (text, message) => { writeFileSync(join(root, 'source.txt'), text); git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
try {
  git('init', '-b', 'main'); git('config', 'user.name', 'Audit input fixture'); git('config', 'user.email', 'audit@example.invalid');
  const base = commit('old\n', 'baseline');
  const text = 'bounded audit source line\n'.repeat(400000);
  const head = commit(text, 'large complete snapshot');
  let input;
  assert.doesNotThrow(() => { input = auditInput(root, base, head); }, 'LAB_AUDIT_INPUT_OUTPUT_BUDGET_COUPLED: complete local snapshots must not consume the provider output allowance');
  assert.equal(input.files[0].content, text);
  assert.ok(Buffer.byteLength(input.input) > 8 * 1024 * 1024);
  assert.equal(policy.auditInputMaxBytes, 64 * 1024 * 1024);
  assert.equal(provider.maxOutputBytes, 8 * 1024 * 1024);
  const implementation = readFileSync(new URL('./lab-audit.mjs', import.meta.url), 'utf8');
  assert.match(implementation, /const INPUT_LIMIT = labPolicy\.auditInputMaxBytes;/);
  assert.match(implementation, /const OUTPUT_LIMIT = SUPERVISED_PROVIDER_RUNTIME_POLICY\.maxOutputBytes;/);
  assert.match(implementation, /captured \+ bytes > OUTPUT_LIMIT/);
  // Each file and git diff fit; the combined serialized snapshot exceeds the bound.
  const aggregate = commit('a'.repeat(34 * 1024 * 1024), 'aggregate budget refusal');
  assert.throws(() => auditInput(root, base, aggregate), /input exceeds the bounded text contract/);
  const oversized = commit('b'.repeat(policy.auditInputMaxBytes + 1), 'single source budget refusal');
  assert.throws(() => auditInput(root, base, oversized), /input exceeds the bounded text contract/);
  const binary = commit('actual \0 byte', 'binary refusal');
  assert.throws(() => auditInput(root, base, binary), /bounded text contract/);
  console.log('LAB_AUDIT_INPUT_BUDGET_GREEN complete large snapshots; 64 MiB input bound; 8 MiB output unchanged; aggregate, per-file and binary refusals');
} finally { rmSync(root, { recursive: true, force: true }); }
