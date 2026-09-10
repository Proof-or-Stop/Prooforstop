import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { acquireOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
import { createVerifierHandlers } from '../packages/main/dist/handlers/verifier.js';
import { isOfficialHeavyValidateInvocation } from '../packages/main/dist/core/certification-window.js';

assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-precert-witness' }), true,
  'U01: default Story routine validation must require PRE_CERT');
const root = mkdtempSync(join(tmpdir(), 'routine-precert-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: root });
  const marker = join(root, 'child-launched');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ validate: { commands: [{
    command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
  }] } }));
  const store = new StoryStore(root);
  store.writeStory('B-precert-witness', { storyId: 'B-precert-witness', name: 'precert-witness', title: 'PRE_CERT witness',
    description: 'Isolated invocation witness', type: 'feature', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(),
    startedAt: null, endedAt: null, events: [] });
  store.writeChecklist('B-precert-witness', { items: [] });
  acquireOwnerLease(store.storyDirPath('B-precert-witness'), { command: 'fixture-owner', cwd: root });
  const handlers = createVerifierHandlers({ store, root, scanRoot: root, log() {} });
  await assert.rejects(() => handlers.validate({ story: 'B-precert-witness', json: true }), /pre_cert_/);
  assert.equal(existsSync(marker), false, 'PRE_CERT refusal must precede child launch');
  assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-precert-witness', focus: 'fast' }), false);
  assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-precert-witness', full: true, focus: 'fast' }), true);
  console.log('PASS U01 routine-precert-entry');
} finally { rmSync(root, { recursive: true, force: true }); }
