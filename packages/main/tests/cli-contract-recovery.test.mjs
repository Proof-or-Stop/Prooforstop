import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { MAIN_TOOLS } from '../dist/cli-engine.js';
import { resetConfigCache } from '../dist/core/config.js';
import { digestCanonicalJson } from '../dist/core/digest.js';
import { buildCorpusIndex } from '../dist/core/candidate-spec-routing.js';
import { resetSessionIdForTest } from '../dist/core/story-owner-lease.js';
import { acquireOwnerLease } from '../dist/core/story-owner-lease.js';
import { StoryStore } from '../dist/core/store.js';
import { createChecklistHandlers } from '../dist/handlers/checklist.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repositoryRoot = join(packageRoot, '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const originalEnvironment = { ...process.env };
const failures = [];

function runCli(root, args, inputEnvironment = {}) {
  return spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PROOF_OR_STOP_NO_HOOKS: '1',
      PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '0',
      ...inputEnvironment,
    },
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function check(name, action) {
  try {
    await action();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check('fresh init prompt consumer and verifier agree', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-fresh-prompt-'));
  try {
    const initialized = spawnSync(process.execPath, [cliPath, 'init', '--profile', 'codex', '--asset-mode', 'global-thin', root], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1' },
    });
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    const configPath = join(root, 'proof-or-stop.config.json');
    const generated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(generated.promptEnvelope, {
      version: 'proof-or-stop.prompt-envelope-rollout.v1',
      roles: {},
    });

    const assertBoth = (label, expectedStatus) => {
      const prompt = runCli(root, ['agent_prompt', '--role=proof-or-stop-review-story-init']);
      const verify = runCli(root, ['verify_codex']);
      assert.equal(prompt.status, expectedStatus, `${label} prompt: ${prompt.stdout}${prompt.stderr}`);
      assert.equal(verify.status, expectedStatus, `${label} verify: ${verify.stdout}${verify.stderr}`);
    };
    assertBoth('generated config', 0);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Prompt Consumer Fixture']);
    git(root, ['config', 'user.email', 'prompt-consumer@example.invalid']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'fixture baseline']);
    const promptStore = new StoryStore(root);
    promptStore.writeStory('B-prompt', {
      storyId: 'B-prompt', name: 'prompt-consumer', title: 'Prompt consumer',
      description: 'Read-only prompt consumer fixture.', type: 'chore', phase: 'INIT', priority: 'medium',
      createdAt: '2026-09-14T00:00:00.000Z', startedAt: '2026-09-14T00:00:00.000Z', endedAt: null, events: [],
    });
    promptStore.writeChecklist('B-prompt', { items: [] });
    const storyPrompt = runCli(root, ['agent_prompt', '--role=proof-or-stop-review-story-init', '--storyId=B-prompt', '--readOnly']);
    assert.equal(storyPrompt.status, 0, storyPrompt.stdout + storyPrompt.stderr);
    delete generated.promptEnvelope;
    writeJson(configPath, generated);
    assertBoth('legacy omitted promptEnvelope', 0);

    const invalidCases = [
      ['retired version', { version: 'proofbound.prompt-envelope-rollout.v1', roles: {} }],
      ['unknown role', { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'unknown-reviewer': 'full-envelope' } }],
      ['invalid mode', { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-review-story-init': 'off' } }],
    ];
    for (const [label, promptEnvelope] of invalidCases) {
      writeJson(configPath, { ...generated, promptEnvelope });
      assertBoth(label, 1);
    }
    writeFileSync(configPath, '{"promptEnvelope":{"version":"proof-or-stop.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-story-init":"full-envelope","proof-or-stop-review-story-init":"full-envelope"}}}\n');
    assertBoth('duplicate role key', 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const assetMode of ['global-thin', 'thin']) {
    const modeRoot = mkdtempSync(join(tmpdir(), `proof-or-stop-${assetMode}-prompt-`));
    try {
      const initialized = spawnSync(process.execPath, [cliPath, 'init', '--profile', 'codex', '--asset-mode', assetMode, modeRoot], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1' },
      });
      assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
      assert.equal(runCli(modeRoot, ['agent_prompt', '--role=proof-or-stop-review-story-init']).status, 0, `${assetMode} agent_prompt`);
      assert.equal(runCli(modeRoot, ['verify_codex']).status, 0, `${assetMode} verify_codex`);
    } finally {
      rmSync(modeRoot, { recursive: true, force: true });
    }
  }
});

await check('verification intent help exposes the real nested schema', () => {
  for (const command of ['story_create', 'checklist_add', 'checklist_get', 'checklist_update']) {
    const result = runCli(repositoryRoot, [command, '--help']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    const prefix = command === 'checklist_get' ? 'proposalIntent' : 'verificationIntent';
    assert.match(output, new RegExp(`${prefix}\\.happy\\[\\]\\.desc: string`));
    assert.match(output, new RegExp(`${prefix}\\.happy\\[\\]\\.type: logic\\|cli\\|browser\\|manual\\|docs`));
    assert.match(output, new RegExp(`${prefix}\\.happy\\[\\]\\.scope\\?: focused\\|repository`));
    assert.match(output, new RegExp(`${prefix}\\.happy\\[\\]\\.expectation\\?: absolute_pass\\|no_new_regressions`));
    assert.match(output, new RegExp(`${prefix}\\.happy\\[\\]\\.requirementSource\\?: story\\|external_verifier\\|repository_health`));
    assert.doesNotMatch(output, new RegExp(`${prefix}\\.(happy|edge|adversarial): any`));
    const tool = MAIN_TOOLS.find(candidate => candidate.name === command);
    assert.ok(tool?.examples?.length, `${command} exposes a copyable example`);
    for (const example of tool.examples) {
      assert.equal(z.object(tool.schema).safeParse(example.body).success, true, `${command}: ${example.title}`);
    }
  }
});

await check('validation failures are concise and machine recoverable', () => {
  const textFailure = runCli(repositoryRoot, ['checklist_get', '{"storyId":42}']);
  assert.equal(textFailure.status, 1);
  assert.equal((textFailure.stderr.match(/^Argument validation failed:/gm) ?? []).length, 1);
  assert.equal((textFailure.stderr.match(/Invalid input: expected string, received number/g) ?? []).length, 1);
  assert.match(textFailure.stderr, /proof-or-stop checklist_get --help/);
  assert.ok(Buffer.byteLength(textFailure.stderr) < 4096, `stderr was ${Buffer.byteLength(textFailure.stderr)} bytes`);

  const jsonFailure = runCli(repositoryRoot, ['checklist_get', '{"storyId":42,"json":true}']);
  assert.equal(jsonFailure.status, 1);
  assert.equal(jsonFailure.stderr, '');
  const parsed = JSON.parse(jsonFailure.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'argument_validation_failed');
  assert.equal(parsed.recoverable, true);
  assert.equal(parsed.nextCommand, 'proof-or-stop checklist_get --help');
  assert.deepEqual(parsed.issues[0].path, ['storyId']);

  const enumRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-enum-'));
  try {
    const enumFailure = runCli(enumRoot, ['checklist_update', '{"storyId":"B-x","itemId":"CHK-001","status":"invalid","json":true}']);
    assert.equal(enumFailure.status, 1);
    assert.equal(enumFailure.stderr, '');
    const enumPayload = JSON.parse(enumFailure.stdout);
    assert.deepEqual(enumPayload.issues.find(issue => issue.path.join('.') === 'status').allowedValues,
      ['pending', 'in_progress', 'done', 'withdrawn']);
  } finally {
    rmSync(enumRoot, { recursive: true, force: true });
  }
});

const intentFor = (itemId) => ({
  happy: [{
    id: `${itemId}:happy:0`,
    desc: `Focused acceptance for ${itemId}`,
    type: 'logic',
    priority: 'must',
    scope: 'focused',
    expectation: 'absolute_pass',
    requirementSource: 'story',
  }],
  edge: [],
  adversarial: [],
});

await check('plan acceptance prepare and apply are atomic', () => {
  const prepareTool = MAIN_TOOLS.find(tool => tool.name === 'plan_acceptance_prepare');
  const applyTool = MAIN_TOOLS.find(tool => tool.name === 'plan_acceptance_apply');
  assert.ok(prepareTool, 'plan_acceptance_prepare command is registered');
  assert.ok(applyTool, 'plan_acceptance_apply command is registered');

  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-plan-acceptance-'));
  const oldCwd = process.cwd();
  try {
    writeJson(join(root, 'proof-or-stop.config.json'), {
      scanRoot: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    });
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/runtime/\nowner-lease.json\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'base.ts'), 'export const base = true;\n');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Plan Acceptance Fixture']);
    git(root, ['config', 'user.email', 'plan-acceptance@example.invalid']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'fixture baseline']);
    git(root, ['checkout', '-qb', 'story/B-batch']);

    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-batch';
    const now = '2026-09-14T00:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'plan-acceptance-batch',
      title: 'Plan acceptance batch',
      description: 'Apply three acceptance items atomically.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, {
      items: ['CHK-001', 'CHK-002', 'CHK-003'].map(id => ({
        id,
        title: `Acceptance ${id}`,
        context: 'Fixture item',
        status: 'pending',
        files: { modify: [], create: [], test: [] },
      })),
    });
    process.chdir(root);
    process.env.PROOF_OR_STOP_SESSION_ID = 'plan-acceptance-owner';
    process.env.PROOF_OR_STOP_AGENT = 'main-agent';
    resetSessionIdForTest();
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'plan_acceptance_apply', cwd: root });
    const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'src') });
    const items = ['CHK-001', 'CHK-002', 'CHK-003'].map((itemId, index) => ({
      itemId,
      files: { modify: [`src/file-${index}.ts`], create: [], test: [`tests/file-${index}.test.ts`] },
      verificationIntent: intentFor(itemId),
    }));
    const unclassified = structuredClone(items);
    delete unclassified[0].verificationIntent.happy[0].scope;
    assert.throws(
      () => handlers.plan_acceptance_prepare({ storyId, items: unclassified }),
      error => /verification_intent_metadata_required/.test(error.message)
        && /scope=focused\|repository/.test(error.message)
        && /plan_acceptance_prepare/.test(error.message),
    );
    const beforePrepare = JSON.stringify(store.readChecklist(storyId));
    const prepared = handlers.plan_acceptance_prepare({ storyId, items });
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforePrepare, 'prepare is read-only');
    assert.equal(prepared.items.length, 3);
    for (const row of prepared.items) {
      assert.equal(row.proposalDigest, digestCanonicalJson({
        storyId,
        itemId: row.itemId,
        baseIntentHash: row.baseIntentHash,
        verificationIntent: row.verificationIntent,
      }));
    }

    assert.throws(() => handlers.checklist_update({
      storyId,
      itemId: prepared.items[0].itemId,
      files: prepared.items[0].files,
      verificationIntent: prepared.items[0].verificationIntent,
      intentProposalApproval: {
        digest: prepared.items[0].proposalDigest,
        baseIntentHash: prepared.items[0].baseIntentHash,
        reason: 'Exercise the one-response recovery guidance for mixed proposal fields.',
      },
    }), error => /INTENT_PROPOSAL_FIELDS_INVALID/.test(error.message)
      && /Next 1: proof-or-stop plan_acceptance_prepare/.test(error.message)
      && /Next 2:/.test(error.message));

    const bad = structuredClone(prepared);
    bad.digest = '0'.repeat(64);
    const beforeBad = JSON.stringify(store.readChecklist(storyId));
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared: bad,
      reason: 'Reject a tampered whole-plan digest without any partial checklist write.',
    }), /DIGEST|digest/i);
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeBad);

    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-verification-intent';
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared,
      reason: 'A dispatched reviewer role cannot exercise the Story owner approval authority.',
    }), /OWNER_REQUIRED/);
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeBad);

    process.env.PROOF_OR_STOP_AGENT = 'main-agent';
    process.env.PROOF_OR_STOP_SESSION_ID = 'foreign-plan-acceptance-session';
    resetSessionIdForTest();
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared,
      reason: 'A foreign active session cannot exercise another owner lease in the batch path.',
    }), /OWNER_REQUIRED/);
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeBad);

    process.env.PROOF_OR_STOP_SESSION_ID = 'plan-acceptance-owner';
    resetSessionIdForTest();

    handlers.plan_acceptance_apply({
      storyId,
      prepared,
      reason: 'Apply all three reviewed acceptance items in one owner-authorized transaction.',
    });
    const applied = store.readChecklist(storyId);
    assert.deepEqual(applied.items.map(item => item.files), items.map(item => item.files));
    assert.deepEqual(applied.items.map(item => item.verificationIntent), items.map(item => item.verificationIntent));
    assert.equal(store.readProcessEvents(storyId).filter(event => event.action === 'verification_intent_applied').length, 3);

    const stalePrepared = handlers.plan_acceptance_prepare({ storyId, items: items.map((item, index) => ({
      ...item,
      verificationIntent: { ...item.verificationIntent, edge: [{
        id: `${item.itemId}:edge:0`, desc: `Edge ${index}`, type: 'logic', priority: 'must',
        scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
      }] },
    })) });
    const drifted = store.readChecklist(storyId);
    drifted.items[1].context = 'Concurrent drift';
    store.writeChecklist(storyId, drifted);
    const beforeStale = JSON.stringify(store.readChecklist(storyId));
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared: stalePrepared,
      reason: 'Reject a stale multi-item preparation without applying any surviving item.',
    }), /STALE|stale/i);
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeStale);

    const applySchema = z.object(applyTool.schema).strict();
    assert.equal(applySchema.safeParse({ storyId, prepared, reason: 'x'.repeat(40), extra: true }).success, false);
  } finally {
    process.chdir(oldCwd);
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetSessionIdForTest();
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

await check('missing requirements corpus is deterministic and symlinks fail closed', () => {
  const missingRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-missing-corpus-'));
  const emptyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-empty-corpus-'));
  try {
    mkdirSync(join(emptyRoot, 'docs', 'requirements'), { recursive: true });
    const missing = buildCorpusIndex(missingRoot, 'docs/requirements');
    const empty = buildCorpusIndex(emptyRoot, 'docs/requirements');
    assert.equal(missing.corpusStatus, 'missing');
    assert.deepEqual(missing.entries, []);
    assert.equal(missing.corpusDigest, empty.corpusDigest);
    assert.match(missing.diagnostic, /missing/i);

    writeFileSync(join(missingRoot, 'requirements-file'), 'not a directory\n');
    assert.throws(() => buildCorpusIndex(missingRoot, 'requirements-file'), /not.*directory/i);
    symlinkSync(join(emptyRoot, 'docs', 'requirements'), join(missingRoot, 'requirements-link'));
    assert.throws(() => buildCorpusIndex(missingRoot, 'requirements-link'), /symbolic link|symlink/i);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.error(`CLI_CONTRACT_RECOVERY_RED ${failures.map(failure => failure.name).join('; ')}`);
  process.exit(1);
}

console.log('CLI_CONTRACT_RECOVERY_GREEN all five framework contracts pass');
