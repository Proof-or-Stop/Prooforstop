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
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  routeCandidateSpecs,
  verifyCandidateSpecSet,
} from '../dist/core/candidate-spec-routing.js';
import { resetSessionIdForTest } from '../dist/core/story-owner-lease.js';
import { acquireOwnerLease } from '../dist/core/story-owner-lease.js';
import { acceptanceIntentHash, createIntentAmendment } from '../dist/core/verification-intent-amendment.js';
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

    const assertBoth = (label, expectedStatus, reasonPattern) => {
      const prompt = runCli(root, ['agent_prompt', '--role=proof-or-stop-review-story-init']);
      const verify = runCli(root, ['verify_codex']);
      assert.equal(prompt.status, expectedStatus, `${label} prompt: ${prompt.stdout}${prompt.stderr}`);
      assert.equal(verify.status, expectedStatus, `${label} verify: ${verify.stdout}${verify.stderr}`);
      if (reasonPattern) {
        assert.match(prompt.stdout + prompt.stderr, reasonPattern, `${label} prompt reason`);
        assert.match(verify.stdout + verify.stderr, reasonPattern, `${label} verify reason`);
        const unrelatedPrompt = runCli(root, ['agent_prompt', '--role=proof-or-stop-review-quality']);
        assert.equal(unrelatedPrompt.status, expectedStatus, `${label} unrelated-role prompt: ${unrelatedPrompt.stdout}${unrelatedPrompt.stderr}`);
        assert.match(unrelatedPrompt.stdout + unrelatedPrompt.stderr, reasonPattern, `${label} unrelated-role prompt reason`);
      }
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
      ['retired version', { version: 'proofbound.prompt-envelope-rollout.v1', roles: {} }, /retired active protocol identity/i],
      ['retired hyphen role', { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proofbound-review-story-init': 'full-envelope' } }, /retired active protocol identity.*proofbound-review-story-init/is],
      ['unknown role', { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'unknown-reviewer': 'full-envelope' } }, /unknown-reviewer|unknown prompt envelope role/i],
      ['invalid mode', { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-review-story-init': 'off' } }, /proof-or-stop-review-story-init|invalid|full-envelope/i],
    ];
    for (const [label, promptEnvelope, reasonPattern] of invalidCases) {
      writeJson(configPath, { ...generated, promptEnvelope });
      assertBoth(label, 1, reasonPattern);
    }
    writeFileSync(configPath, '{"promptEnvelope":{"version":"proof-or-stop.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-story-init":"full-envelope","proof-or-stop-review-story-init":"full-envelope"}}}\n');
    assertBoth('duplicate role key', 1, /duplicate promptEnvelope\.roles\..* key/i);
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
    assert.match(output, new RegExp(`${prefix}\\.happy\\?: array.*default: \\[\\]`));
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

  const aliasFailure = runCli(repositoryRoot, ['plan', 'acceptance', 'apply', '{"storyId":42}']);
  assert.equal(aliasFailure.status, 1);
  assert.match(aliasFailure.stderr, /proof-or-stop plan acceptance apply --help/);

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

const plannedDeclarationFor = (itemId) => ({
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1',
  id: `VPP-${itemId}`,
  relation: 'producer_to_consumer',
  producer: {
    id: `EP-${itemId}-P`, role: 'producer', expectedArtifactKind: 'handler',
    expectedFileRef: `src/${itemId}-producer.ts`, expectedSymbolOrFact: 'produceFact',
    fileDeclarationRef: `${itemId}:files:modify:0`,
  },
  consumers: [{
    id: `EP-${itemId}-C`, role: 'consumer', expectedArtifactKind: 'handler',
    expectedFileRef: `src/${itemId}-consumer.ts`, expectedSymbolOrFact: 'consumeFact',
    fileDeclarationRef: `${itemId}:files:modify:1`,
  }],
  outputFactRef: `intent:${itemId}:happy:0`,
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
      items: ['CHK-001', 'CHK-002', 'CHK-003', 'CHK-006', 'CHK-004', 'CHK-005'].map(id => ({
        id,
        title: `Acceptance ${id}`,
        context: 'Fixture item',
        status: 'pending',
        files: { modify: [], create: [], test: [] },
      })).concat([{
        id: 'CHK-007',
        title: 'Frozen planned-path acceptance',
        context: 'Fixture item with an existing planned-path binding',
        status: 'pending',
        files: { modify: ['src/CHK-007-producer.ts', 'src/CHK-007-consumer.ts'], create: [], test: [] },
        verificationIntent: {
          ...intentFor('CHK-007'),
          happy: [{ ...intentFor('CHK-007').happy[0], plannedPathDeclarations: [plannedDeclarationFor('CHK-007')] }],
        },
      }]),
    });
    process.chdir(root);
    process.env.PROOF_OR_STOP_SESSION_ID = 'plan-acceptance-owner';
    process.env.PROOF_OR_STOP_AGENT = 'main-agent';
    resetSessionIdForTest();
    const ownerLease = acquireOwnerLease(store.storyDirPath(storyId), { command: 'plan_acceptance_apply', cwd: root });
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

    const frozenPrepared = handlers.plan_acceptance_prepare({ storyId, items: [{
      itemId: 'CHK-007',
      files: { modify: ['src/rebound.ts'], create: [], test: [] },
      verificationIntent: intentFor('CHK-007'),
    }] });
    const beforeFrozen = JSON.stringify(store.readChecklist(storyId));
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared: frozenPrepared,
      reason: 'Reject rebinding files after a planned path declaration has frozen their indices.',
    }), /planned_path_file_binding_frozen/);
    assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeFrozen, 'file-binding refusal is atomic');

    const initialBindingIntent = {
      ...intentFor('CHK-004'),
      happy: [{ ...intentFor('CHK-004').happy[0], plannedPathDeclarations: [plannedDeclarationFor('CHK-004')] }],
    };
    const initialBindingFiles = {
      modify: ['src/CHK-004-producer.ts', 'src/CHK-004-consumer.ts'], create: [], test: [],
    };
    const initialPrepared = handlers.plan_acceptance_prepare({ storyId, items: [{
      itemId: 'CHK-004', files: initialBindingFiles, verificationIntent: initialBindingIntent,
    }] });
    handlers.plan_acceptance_apply({
      storyId,
      prepared: initialPrepared,
      reason: 'Atomically establish the first files and planned-path declaration binding.',
    });
    const initialApplied = store.readChecklist(storyId).items.find(item => item.id === 'CHK-004');
    assert.deepEqual(initialApplied.files, initialBindingFiles);
    assert.deepEqual(initialApplied.verificationIntent, initialBindingIntent);

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
    assert.deepEqual(applied.items.slice(0, 3).map(item => item.files), items.map(item => item.files));
    assert.deepEqual(applied.items.slice(0, 3).map(item => item.verificationIntent), items.map(item => item.verificationIntent));
    assert.equal(store.readProcessEvents(storyId).filter(event => event.action === 'verification_intent_applied').length, 4);

    const cliEnvironment = {
      PROOF_OR_STOP_SESSION_ID: 'plan-acceptance-owner',
      PROOF_OR_STOP_AGENT: 'main-agent',
    };
    const cliItems = [{
      itemId: 'CHK-006',
      files: { modify: ['src/cli-round-trip.ts'], create: [], test: ['tests/cli-round-trip.test.ts'] },
      verificationIntent: intentFor('CHK-006'),
    }];
    const cliPrepare = runCli(root, ['plan_acceptance_prepare', JSON.stringify({ storyId, items: cliItems })], cliEnvironment);
    assert.equal(cliPrepare.status, 0, cliPrepare.stdout + cliPrepare.stderr);
    const cliPrepared = JSON.parse(cliPrepare.stdout);
    const cliApply = runCli(root, ['plan_acceptance_apply', JSON.stringify({
      storyId,
      prepared: cliPrepared,
      reason: 'Apply the unchanged prepared payload through the public strict CLI command path.',
    })], cliEnvironment);
    assert.equal(cliApply.status, 0, cliApply.stdout + cliApply.stderr);
    assert.deepEqual(store.readChecklist(storyId).items.find(item => item.id === 'CHK-006').verificationIntent, intentFor('CHK-006'));

    const cliTampered = structuredClone(cliPrepared);
    cliTampered.digest = '0'.repeat(64);
    const cliDigestFailure = runCli(root, ['plan_acceptance_apply', JSON.stringify({
      storyId,
      prepared: cliTampered,
      reason: 'Reject a tampered digest through the public strict CLI command path.',
    })], cliEnvironment);
    assert.equal(cliDigestFailure.status, 1);
    assert.match(cliDigestFailure.stderr, /PLAN_ACCEPTANCE_DIGEST_INVALID/);

    const cliExtraField = runCli(root, ['plan_acceptance_apply', JSON.stringify({
      storyId,
      prepared: cliPrepared,
      reason: 'Reject an undeclared field through the public strict CLI command schema.',
      extra: true,
    })], cliEnvironment);
    assert.equal(cliExtraField.status, 1);
    assert.match(cliExtraField.stderr, /Unrecognized key|validation failed/i);

    const amendedChecklist = store.readChecklist(storyId);
    const amendmentItem = amendedChecklist.items.find(item => item.id === 'CHK-005');
    amendmentItem.verificationIntent = intentFor('CHK-005');
    const seededAmendment = createIntentAmendment({
      item: amendmentItem,
      storyId,
      expectedIntentHash: acceptanceIntentHash(amendmentItem.verificationIntent),
      reason: 'Seed an existing signed amendment so batch revision behavior is exercised.',
      addition: { edge: [{ id: 'AMEND_EDGE', desc: 'Exercise the signed amendment revision path', type: 'logic', priority: 'must' }] },
      sessionId: 'plan-acceptance-owner',
      leaseId: ownerLease.leaseId,
      headHash: git(root, ['rev-parse', 'HEAD']),
      gitCwd: root,
    });
    amendmentItem.verificationIntent = seededAmendment.intent;
    amendmentItem.verificationIntentAmendments = [seededAmendment.amendment];
    amendmentItem.status = 'done';
    amendmentItem.startTime = now;
    amendmentItem.endTime = now;
    store.writeChecklist(storyId, amendedChecklist);
    const revisedIntent = structuredClone(seededAmendment.intent);
    revisedIntent.edge[0] = {
      ...revisedIntent.edge[0],
      scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
    };
    const amendmentPrepared = handlers.plan_acceptance_prepare({ storyId, items: [{
      itemId: 'CHK-005', files: amendmentItem.files, verificationIntent: revisedIntent,
    }] });
    handlers.plan_acceptance_apply({
      storyId,
      prepared: amendmentPrepared,
      reason: 'Revise the signed acceptance intent and reset prior completion state for re-verification.',
    });
    const revisedItem = store.readChecklist(storyId).items.find(item => item.id === 'CHK-005');
    assert.equal(revisedItem.verificationIntentAmendments.length, 2);
    assert.equal(revisedItem.verificationIntentAmendments[1].schema, 'proof-or-stop.intent-revision.v1');
    assert.equal(revisedItem.status, 'pending');
    assert.equal(revisedItem.startTime, null);
    assert.equal(revisedItem.endTime, null);

    const planStory = store.readStory(storyId);
    store.writeStory(storyId, { ...planStory, phase: 'DEV' });
    assert.throws(() => handlers.plan_acceptance_prepare({ storyId, items }), /PLAN_ACCEPTANCE_PHASE_INVALID/);
    assert.throws(() => handlers.plan_acceptance_apply({
      storyId,
      prepared,
      reason: 'Reject applying a prepared acceptance batch after the Story has left PLAN.',
    }), /PLAN_ACCEPTANCE_PHASE_INVALID/);
    store.writeStory(storyId, planStory);

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

await check('missing requirements corpus is deterministic and symlinks preserve safe compatibility', () => {
  const missingRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-missing-corpus-'));
  const emptyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-empty-corpus-'));
  const danglingRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-dangling-corpus-'));
  try {
    mkdirSync(join(emptyRoot, 'docs', 'requirements'), { recursive: true });
    const missing = buildCorpusIndex(missingRoot, 'docs/requirements');
    const empty = buildCorpusIndex(emptyRoot, 'docs/requirements');
    assert.equal(missing.corpusStatus, 'missing');
    assert.deepEqual(missing.entries, []);
    assert.equal(missing.corpusDigest, empty.corpusDigest);
    assert.match(missing.diagnostic, /missing/i);
    const missingRoute = routeCandidateSpecs({
      projectRoot: missingRoot,
      storyId: 'B-missing-corpus',
      corpus: missing,
      seeds: buildKeywordSeeds({ title: 'Missing requirements corpus routing' }),
    });
    assert.equal(missingRoute.requiresEscalation, true);
    assert.ok(missingRoute.escalationReasons.includes('requirements_corpus_missing'));
    assert.equal(missingRoute.corpusStatus, 'missing');
    assert.equal(missingRoute.corpusDiagnostic, missing.diagnostic);
    assert.equal(verifyCandidateSpecSet(missingRoute), true);

    symlinkSync(join(danglingRoot, 'deleted-requirements'), join(danglingRoot, 'requirements-link'));
    const dangling = buildCorpusIndex(danglingRoot, 'requirements-link');
    assert.equal(dangling.corpusStatus, 'missing');
    assert.equal(dangling.corpusDigest, empty.corpusDigest);

    writeFileSync(join(missingRoot, 'requirements-file'), 'not a directory\n');
    assert.throws(() => buildCorpusIndex(missingRoot, 'requirements-file'), /not.*directory/i);
    mkdirSync(join(missingRoot, 'in-root-requirements'));
    symlinkSync(join(missingRoot, 'in-root-requirements'), join(missingRoot, 'requirements-link'));
    assert.equal(buildCorpusIndex(missingRoot, 'requirements-link').corpusDigest, empty.corpusDigest);
    symlinkSync(join(emptyRoot, 'docs', 'requirements'), join(missingRoot, 'external-requirements-link'));
    assert.throws(() => buildCorpusIndex(missingRoot, 'external-requirements-link'), /escapes project root/i);

    writeFileSync(join(emptyRoot, 'shared.md'), '# Shared requirement\n');
    symlinkSync(join(emptyRoot, 'shared.md'), join(emptyRoot, 'docs', 'requirements', 'shared-link.md'));
    assert.deepEqual(buildCorpusIndex(emptyRoot, 'docs/requirements').entries, [], 'in-root nested links remain skipped');
    symlinkSync(join(missingRoot, 'requirements-file'), join(emptyRoot, 'docs', 'requirements', 'escape-link.md'));
    assert.throws(() => buildCorpusIndex(emptyRoot, 'docs/requirements'), /escapes project root/i);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
    rmSync(danglingRoot, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.error(`CLI_CONTRACT_RECOVERY_RED ${failures.map(failure => failure.name).join('; ')}`);
  process.exit(1);
}

console.log('CLI_CONTRACT_RECOVERY_GREEN all five framework contracts pass');
