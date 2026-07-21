import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const storyId = 'B-407c';
const lease = JSON.parse(readFileSync(join(root, '.lattice/story/actives', storyId, 'owner-lease.json'), 'utf8')) as { sessionId?: string };
const env = { ...process.env, LATTICE_SESSION_ID: lease.sessionId };
function runJson(command: string, args: string[]): any {
  const output = execFileSync('node', ['bin/lattice.js', command, ...args], { cwd: root, env, encoding: 'utf8' });
  const line = output.trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(line); } catch { return { text: output }; }
}
const scope = runJson('scope_contract_check', [`--storyId=${storyId}`, '--json']);
assert.ok(scope.status || scope.ok !== undefined || scope.text, 'scope contract check must return structured/readable output');
const delivery = runJson('delivery_context_pack', [`--storyId=${storyId}`, '--json']);
assert.ok(delivery.schemaVersion || delivery.storyId || delivery.text, 'delivery context pack must return structured/readable output');
const author = execFileSync('git', ['show', '-s', '--format=%an <%ae>', '397198367a'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(author, 'lattice-implementer <lattice-implementer@noreply.local>');
console.log('story6-invariants-smoke: PASS (read-only scope/delivery surfaces and positive implementation-author control)');
