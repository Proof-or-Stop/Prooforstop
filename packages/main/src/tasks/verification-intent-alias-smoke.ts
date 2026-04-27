import assert from 'node:assert/strict';
import { z } from 'zod';
import { MAIN_TOOLS } from '../cli-engine.js';

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return z.object(tool.schema);
}

function parseTool(name: string, payload: Record<string, unknown>) {
  const parsed = schemaFor(name).safeParse(payload);
  assert.equal(parsed.success, true, `${name} should parse: ${JSON.stringify(parsed, null, 2)}`);
  return parsed.data as any;
}

function rejectTool(name: string, payload: Record<string, unknown>) {
  const parsed = schemaFor(name).safeParse(payload);
  assert.equal(parsed.success, false, `${name} should reject invalid verificationIntent type`);
}

const storyCreate = parseTool('story_create', {
  name: 'alias-smoke',
  title: 'Alias smoke',
  description: 'Prove story_create normalizes legacy verificationIntent aliases.',
  type: 'feature',
  priority: 'medium',
  checklist: [{
    title: 'Parse alias',
    context: 'Legacy agents may still emit cli_blackbox.',
    verificationIntent: {
      happy: [{ desc: 'legacy cli alias', type: 'cli_blackbox' }],
    },
  }],
});
assert.equal(storyCreate.checklist[0].verificationIntent.happy[0].type, 'cli');

const checklistAdd = parseTool('checklist_add', {
  storyId: 'B-smoke',
  title: 'Parse browser alias',
  context: 'Legacy agents may still emit browser_blackbox.',
  verificationIntent: {
    happy: [{ desc: 'legacy browser alias', type: 'browser_blackbox' }],
  },
});
assert.equal(checklistAdd.verificationIntent.happy[0].type, 'browser');

const checklistUpdate = parseTool('checklist_update', {
  storyId: 'B-smoke',
  itemId: 'CHK-001',
  verificationIntent: {
    happy: [{ desc: 'legacy cli alias', type: 'cli_blackbox' }],
    edge: [{ desc: 'current browser value', type: 'browser' }],
    adversarial: [{ desc: 'legacy browser alias', type: 'browser_blackbox' }],
  },
});
assert.equal(checklistUpdate.verificationIntent.happy[0].type, 'cli');
assert.equal(checklistUpdate.verificationIntent.edge[0].type, 'browser');
assert.equal(checklistUpdate.verificationIntent.adversarial[0].type, 'browser');

for (const current of ['logic', 'cli', 'browser', 'manual', 'docs']) {
  const parsed = parseTool('checklist_update', {
    storyId: 'B-smoke',
    itemId: 'CHK-001',
    verificationIntent: {
      happy: [{ desc: `current ${current}`, type: current }],
    },
  });
  assert.equal(parsed.verificationIntent.happy[0].type, current);
}

rejectTool('story_create', {
  name: 'bad-alias-smoke',
  checklist: [{
    title: 'Reject invalid',
    verificationIntent: {
      happy: [{ desc: 'bad type', type: 'not_a_real_type' }],
    },
  }],
});

console.log('verificationIntent alias smoke passed');
