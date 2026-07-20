import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const storyId = 'B-407c';
const roles = [
  'lattice-review-story-init',
  'lattice-review-scope-plan',
  'lattice-implementer',
  'lattice-review-delivery',
  'lattice-evaluator',
];
const lease = JSON.parse(readFileSync(join(root, '.lattice/story/actives', storyId, 'owner-lease.json'), 'utf8')) as { sessionId?: string };
assert.match(lease.sessionId ?? '', /^sess-/);
const env = { ...process.env, LATTICE_SESSION_ID: lease.sessionId };
const run = (args: string[]) => {
  const text = execFileSync('node', ['bin/lattice.js', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  try { return JSON.parse(text) as any; } catch {
    const lastLine = text.split('\n').at(-1) ?? text;
    try { return JSON.parse(lastLine) as any; } catch { return text; }
  }
};
const receipts = [] as Array<{ roleId: string; arm: string; envelopeId?: string; prompt?: string }>;
for (const role of roles) {
  const legacy = run(['agent_prompt', `--role=${role}`]);
  assert.ok(typeof legacy === 'string' || typeof legacy.prompt === 'string');
  receipts.push({ roleId: role, arm: 'legacy', prompt: typeof legacy === 'string' ? legacy : legacy.prompt });
  const modular = run(['agent_prompt', `--role=${role}`, `--storyId=${storyId}`, '--format=json']);
  assert.equal(modular.auditOnly, true);
  assert.equal(modular.envelope.roleId, role);
  assert.match(modular.envelope.envelopeId, /^[a-f0-9]{64}$/);
  receipts.push({ roleId: role, arm: 'modular', envelopeId: modular.envelope.envelopeId, prompt: modular.prompt });
}
const envelopes = JSON.parse(readFileSync(join(root, '.lattice/story/actives', storyId, 'prompt-envelopes.json'), 'utf8')) as { envelopes: Array<{ envelopeId: string; roleId: string }> };
const events = readFileSync(join(root, '.lattice/story/actives', storyId, 'process-events.jsonl'), 'utf8');
for (const role of roles) {
  const receipt = receipts.find(row => row.roleId === role && row.arm === 'modular')!;
  assert.ok(envelopes.envelopes.some(row => row.envelopeId === receipt.envelopeId && row.roleId === role));
  assert.ok(receipt.envelopeId);
  assert.match(events, new RegExp(receipt.envelopeId));
}
console.log(`story6-production-dispatch-smoke: PASS (${roles.length} roles; provider usage INCONCLUSIVE)`);
