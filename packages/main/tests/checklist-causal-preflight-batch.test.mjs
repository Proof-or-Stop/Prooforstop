import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { acquireOwnerLease } from '../dist/core/story-owner-lease.js';
import { resetConfigCache } from '../dist/core/config.js';
import { StoryStore } from '../dist/core/store.js';
import { createChecklistHandlers } from '../dist/handlers/checklist.js';

const source = readFileSync(new URL('../src/handlers/checklist.ts', import.meta.url), 'utf8');
const probeStart = source.indexOf('function probeCausalPreflightFacts');
const probeEnd = source.indexOf('/**\n * B-2296', probeStart);
const enforcementStart = source.indexOf('const preflightInput');
const enforcementEnd = source.indexOf('const receipt = causal.receipt;', enforcementStart);
const batchStart = source.indexOf('async verification_evidence_batch_add');
const batchEnd = source.indexOf('async verification_run', batchStart);

assert.ok(probeStart >= 0 && probeEnd > probeStart, 'the handler must retain one complete causal probe');
const probeSource = source.slice(probeStart, probeEnd);
for (const fact of [
  'cli', 'worktree', 'gitIndex', 'gitMaterial', 'writerLease',
  'providerCapability', 'resources', 'evidenceTarget', 'sideChannel',
]) {
  assert.match(probeSource, new RegExp(`\\b${fact}\\b`), `probe includes ${fact}`);
}

assert.ok(enforcementStart >= 0 && enforcementEnd > enforcementStart, 'the handler must retain the causal execution seam');
const enforcementSource = source.slice(enforcementStart, enforcementEnd);
assert.match(enforcementSource, /causalCanonical\(deps\.preflightFacts\(preflightInput\)\)/,
  'last-moment revalidation compares the complete probe-fact snapshot');
assert.match(enforcementSource, /revalidateBeforeRun: preflightFactsUnchanged/,
  'the full probe revalidation is wired to the child-launch boundary');
assert.doesNotMatch(enforcementSource, /current\.headHash === hashes\.headHash/,
  'the child-launch boundary must not regress to hash-only revalidation');

assert.ok(batchStart >= 0 && batchEnd > batchStart, 'the production batch handler must be present');
const batchSource = source.slice(batchStart, batchEnd);
assert.match(batchSource, /deriveCausalMetrics\(causalBatch\.ledger\)/,
  'the production batch response derives metrics from its causal ledger');
assert.match(batchSource, /renderCausalMetrics\(deriveCausalMetrics\(causalBatch\.ledger\)\)/,
  'the production batch response renders the derived causal metrics');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root, relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-causal-batch-'));
try {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  write(root, 'packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.3.266' }));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'causal-batch@example.test']);
  git(root, ['config', 'user.name', 'Causal Batch Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);

  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-causal-batch';
  const intents = Array.from({ length: 58 }, (_, index) => ({
    id: `INT-${index}`,
    desc: `causal batch intent ${index}`,
    type: 'cli',
    priority: 'must',
  }));
  store.writeStory(storyId, {
    storyId,
    name: 'causal-batch',
    title: 'causal batch response metrics',
    description: 'focused causal batch response test',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: '2026-08-20T00:00:00.000Z',
    startedAt: '2026-08-20T00:00:00.000Z',
    endedAt: null,
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'causal batch',
      context: 'focused handler response test',
      status: 'in_progress',
      startTime: null,
      endTime: null,
      verificationIntent: { happy: intents, edge: [], adversarial: [] },
    }],
  });
  acquireOwnerLease(store.storyDirPath(storyId), {
    command: 'verification_evidence_batch_add',
    cwd: root,
  });

  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const commands = Array.from({ length: 10 }, (_, index) =>
    `node -e "console.log('CAUSAL_BATCH_OK'); void ${index}"`,
  );
  const response = await handlers.verification_evidence_batch_add({
    storyId,
    evidences: intents.map((intent, index) => ({
      itemId: 'CHK-001',
      intentRef: intent.id,
      kind: 'integration_test',
      command: commands[index % commands.length],
      selector: 'CAUSAL_BATCH_OK',
      result: 'pass',
      note: `executed causal batch intent ${index}`,
    })),
  });

  assert.match(response, /Verification evidence batch recorded for B-causal-batch: 58 item intent/);
  assert.match(response, /CausalEvidence: intentCount=58 uniqueExecutionKeys=10 commandExecutions=10 cacheHitRate=83%/,
    'the response uses source arithmetic: (58 - 10) / 58 rounds to 83%');
  const displayedRate = Number(response.match(/cacheHitRate=(\d+)%/)?.[1]);
  assert.ok(displayedRate >= 80, 'the displayed causal cache hit rate satisfies the semantic >=80% contract');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('checklist-causal-preflight-batch: PASS');
