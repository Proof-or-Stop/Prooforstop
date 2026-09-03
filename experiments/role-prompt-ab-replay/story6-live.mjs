#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJsonStringify,
} from '../../packages/main/dist/core/prompt-contracts.js';
import { StoryStore } from '../../packages/main/dist/core/store.js';
import { createAgentPromptHandlers } from '../../packages/main/dist/handlers/agent-prompt.js';
import { validateExperiment } from './lib/replay.mjs';
import {
  assertClaudeSchemaEquivalent,
  deriveClaudeCompatibleSchema,
} from './lib/story6-schema-compat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RUNTIME = path.join(HERE, 'runtime', 'story6');
const SCHEMA_PATH = path.join(HERE, 'story6-output.schema.json');
const HOSTS = ['codex-cli', 'claude-cli'];
const ARMS = ['legacy', 'modular'];
const REPETITIONS = 3;
const SAMPLE_ROLE = Object.freeze({
  'clean-pass-01': 'proof-or-stop-review-story-init',
  'clean-pass-02': 'proof-or-stop-review-scope-plan',
  'critical-01': 'proof-or-stop-implementer',
  'critical-02': 'proof-or-stop-evaluator',
  'closeout-01': 'proof-or-stop-review-delivery',
  'closeout-02': 'proof-or-stop-implementer',
});
const TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Bash']);
const ORDER = Object.freeze([
  ['legacy', 'modular'],
  ['modular', 'legacy'],
  ['legacy', 'modular'],
]);

function digest(domain, value) {
  return createHash('sha256')
    .update(`proofbound.story6-ab.v1\0${domain}\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalJsonStringify(value), 'utf8')
    .digest('hex');
}

function parseArgs(argv) {
  const out = { execute: false, selfcheck: false, cellId: null, campaignId: null, codexModel: null, claudeModel: null, timeoutMs: 600_000 };
  for (const arg of argv) {
    if (arg === '--execute') out.execute = true;
    else if (arg === '--selfcheck') out.selfcheck = true;
    else if (arg.startsWith('--cell=')) out.cellId = arg.slice(7);
    else if (arg.startsWith('--campaign-id=')) out.campaignId = arg.slice(14);
    else if (arg.startsWith('--codex-model=')) out.codexModel = arg.slice(14);
    else if (arg.startsWith('--claude-model=')) out.claudeModel = arg.slice(15);
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice(13));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.execute && (!out.campaignId || !out.codexModel || !out.claudeModel)) {
    throw new Error('--execute requires --campaign-id, --codex-model, and --claude-model');
  }
  if (out.execute && !out.cellId) throw new Error('--execute requires exactly one --cell; full campaigns must be externally serialized');
  if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 10_000) throw new Error('--timeout-ms must be an integer >= 10000');
  return out;
}

async function loadInputs() {
  const protocol = JSON.parse(await readFile(path.join(HERE, 'protocol.json'), 'utf8'));
  const corpus = JSON.parse(await readFile(path.join(HERE, 'corpus.json'), 'utf8'));
  const identity = validateExperiment(protocol, corpus);
  return { protocol, corpus, identity };
}

function buildCells(corpus) {
  const cells = [];
  for (const sample of corpus.samples) {
    const roleId = SAMPLE_ROLE[sample.id];
    if (!roleId) throw new Error(`sample ${sample.id} has no frozen Story 6 role assignment`);
    for (let repeat = 1; repeat <= REPETITIONS; repeat += 1) {
      for (const arm of ORDER[repeat - 1]) {
        for (const host of HOSTS) cells.push({
          cellId: `${sample.id}.${roleId}.${host}.${arm}.r${repeat}`,
          sampleId: sample.id,
          sampleClass: sample.class,
          roleId,
          host,
          arm,
          repeat,
        });
      }
    }
  }
  return cells;
}

function assertCampaignFloor(corpus, cells) {
  const classes = new Map();
  for (const sample of corpus.samples) classes.set(sample.class, (classes.get(sample.class) ?? 0) + 1);
  if (classes.size < 3 || [...classes.values()].some(count => count < 2)) throw new Error('Story 6 requires >=3 classes with >=2 samples each');
  if (new Set(Object.values(SAMPLE_ROLE)).size !== 5) throw new Error('Story 6 campaign must exercise all five migrated roles');
  const expected = corpus.samples.length * REPETITIONS * ARMS.length * HOSTS.length;
  if (cells.length !== expected || new Set(cells.map(cell => cell.cellId)).size !== expected) throw new Error('campaign cell matrix is incomplete or duplicated');
  for (const sample of corpus.samples) for (const host of HOSTS) for (const arm of ARMS) {
    const count = cells.filter(cell => cell.sampleId === sample.id && cell.host === host && cell.arm === arm).length;
    if (count !== REPETITIONS) throw new Error(`${sample.id}/${host}/${arm} must have exactly ${REPETITIONS} repetitions`);
  }
}

function outputInstruction(sample) {
  return [
    'Review only the frozen task material in the Task Context. Do not edit files or write lifecycle evidence.',
    'Return JSON matching the supplied schema. A finding matches a seeded oracle only when oracleId, normalized category, sourceBinding, and claimBinding all match.',
    `Seeded oracle descriptors (not answers): ${canonicalJsonStringify(sample.oracles)}`,
    'If evidence is insufficient, return no fabricated finding and explain that in summary.',
  ].join('\n');
}

async function producePromptThroughAgentPrompt(cell, sample) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'proofbound-story6-live-handler-'));
  const storyId = `EXP-${sample.id}`;
  try {
    await writeFile(path.join(fixtureRoot, 'proof-or-stop.config.json'), `${JSON.stringify({
      scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: { [cell.roleId]: 'legacy-full-context' },
      },
    })}\n`);
    execFileSync('git', ['init', '-q'], { cwd: fixtureRoot });
    execFileSync('git', ['config', 'user.email', 'story6-live@example.invalid'], { cwd: fixtureRoot });
    execFileSync('git', ['config', 'user.name', 'Story 6 Live Handler'], { cwd: fixtureRoot });
    const store = new StoryStore(fixtureRoot);
    store.writeStory(storyId, {
      storyId,
      title: sample.task,
      description: canonicalJsonStringify({
        frozenMaterial: sample.material.content,
        experimentInstruction: outputInstruction(sample),
      }),
      phase: 'DEV',
      priority: 'high',
    });
    store.writeChecklist(storyId, { items: [{
      id: 'CHK-AB', title: sample.task, context: sample.material.content.scope ?? 'frozen A/B material',
      status: 'in_progress', relatedDocs: [], files: { modify: [], create: [], test: [] },
      verificationIntent: { happy: [], edge: [], adversarial: [] },
    }] });
    execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
    execFileSync('git', ['commit', '-qm', 'frozen Story 6 handler fixture'], { cwd: fixtureRoot });
    const handlers = createAgentPromptHandlers({ root: fixtureRoot, scanRoot: fixtureRoot, store });
    const rawResponse = handlers.agent_prompt({
      role: cell.roleId,
      storyId,
      format: 'json',
      auditExperiment: true,
      ...(cell.arm === 'modular' ? { experimentalModeOverride: 'full-envelope' } : {}),
    });
    const response = JSON.parse(rawResponse);
    if (response.auditOnly !== true || response.auditExperiment !== true || response.canMintReviewEvidence !== false) {
      throw new Error('agent_prompt experiment response lost its audit-only boundary');
    }
    const expectedMode = cell.arm === 'modular' ? 'full-envelope' : 'legacy-full-context';
    if (response.mode !== expectedMode || typeof response.prompt !== 'string') throw new Error(`agent_prompt returned wrong ${cell.arm} mode`);
    const events = store.readProcessEvents(storyId).filter(event => event.type === 'dispatch' && event.targetKind === 'story-dispatch');
    const event = events.at(-1);
    if (!event || event.agentType !== cell.roleId) throw new Error('agent_prompt did not persist the matching dispatch event');
    if (cell.arm === 'modular') {
      if (!response.envelope?.envelopeId
          || event.promptEnvelopeId !== response.envelope.envelopeId
          || event.assembledPromptDigest !== response.envelope.assembledPromptDigest) {
        throw new Error('agent_prompt modular envelope/event binding mismatch');
      }
    }
    return {
      prompt: response.prompt,
      producerResponseDigest: digest('agent-prompt-response', rawResponse),
      producerMode: response.mode,
      envelopeId: response.envelope?.envelopeId ?? null,
      eventBinding: cell.arm === 'modular' ? {
        promptEnvelopeId: event.promptEnvelopeId,
        assembledPromptDigest: event.assembledPromptDigest,
      } : null,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function assertClaudeSchemaMutationBites(canonicalSchema, claudeSchema) {
  const weakenedRequired = structuredClone(claudeSchema);
  weakenedRequired.required = weakenedRequired.required.filter(field => field !== 'findings');
  assert.throws(
    () => assertClaudeSchemaEquivalent(canonicalSchema, weakenedRequired),
    /may differ .* only by removing root \$schema/,
  );
  const weakenedAdditionalProperties = structuredClone(claudeSchema);
  weakenedAdditionalProperties.properties.findings.items.additionalProperties = true;
  assert.throws(
    () => assertClaudeSchemaEquivalent(canonicalSchema, weakenedAdditionalProperties),
    /may differ .* only by removing root \$schema/,
  );
}

function hostInvocation(cell, options, claudeSchema) {
  if (cell.host === 'codex-cli') return {
    command: 'codex',
    args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', '--sandbox', 'read-only', '--model', options.codexModel, '--cd', ROOT, '--output-schema', SCHEMA_PATH, '-'],
    model: options.codexModel,
  };
  return {
    command: 'claude',
    args: ['--print', '--no-session-persistence', '--output-format', 'json', '--model', options.claudeModel, '--permission-mode', 'dontAsk', '--allowedTools', ...TOOLS, '--json-schema', JSON.stringify(claudeSchema)],
    model: options.claudeModel,
  };
}

function runProcess(spec, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(spec.command, spec.args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}`, latencyMs: Date.now() - started });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), latencyMs: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}

function parseProvider(cell, result) {
  if (result.exitCode !== 0) return { availability: 'unavailable', reason: `provider exited ${result.exitCode ?? result.signal ?? 'before-start'}: ${result.stderr.slice(0, 500)}` };
  try {
    if (cell.host === 'claude-cli') {
      const row = JSON.parse(result.stdout);
      return {
        availability: 'available',
        inputTokens: row.usage?.input_tokens ?? null,
        cacheCreationInputTokens: row.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: row.usage?.cache_read_input_tokens ?? null,
        outputTokens: row.usage?.output_tokens ?? null,
        latencyMs: result.latencyMs,
        output: row.structured_output ?? row.result ?? null,
      };
    }
    const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const terminal = [...rows].reverse().find(row => row.type === 'turn.completed');
    const message = [...rows].reverse().find(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
    return {
      availability: 'available',
      inputTokens: terminal?.usage?.input_tokens ?? null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: terminal?.usage?.cached_input_tokens ?? null,
      outputTokens: terminal?.usage?.output_tokens ?? null,
      latencyMs: result.latencyMs,
      output: message?.item?.text ? JSON.parse(message.item.text) : null,
    };
  } catch (error) {
    return { availability: 'unavailable', reason: `provider output could not be parsed: ${error.message}`, latencyMs: result.latencyMs };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const canonicalSchemaText = await readFile(SCHEMA_PATH, 'utf8');
  const canonicalSchema = JSON.parse(canonicalSchemaText);
  const claudeSchema = deriveClaudeCompatibleSchema(canonicalSchema);
  assertClaudeSchemaMutationBites(canonicalSchema, claudeSchema);
  const claudeSelfcheckInvocation = hostInvocation(
    { host: 'claude-cli' },
    { claudeModel: 'selfcheck-model' },
    claudeSchema,
  );
  const schemaArgIndex = claudeSelfcheckInvocation.args.indexOf('--json-schema') + 1;
  assert.ok(schemaArgIndex > 0 && schemaArgIndex < claudeSelfcheckInvocation.args.length);
  assertClaudeSchemaEquivalent(canonicalSchema, JSON.parse(claudeSelfcheckInvocation.args[schemaArgIndex]));
  const { protocol, corpus, identity } = await loadInputs();
  const cells = buildCells(corpus);
  assertCampaignFloor(corpus, cells);
  const protocolBinding = {
    schemaVersion: 'proofbound.story6-live-ab.v1',
    protocolDigest: identity.protocolDigest,
    corpusDigest: identity.corpusDigest,
    hosts: HOSTS,
    arms: ARMS,
    repetitions: REPETITIONS,
    roleAssignment: SAMPLE_ROLE,
    tools: TOOLS,
    order: ORDER,
    sampling: {
      temperature: { availability: 'unavailable', reason: 'Codex CLI and Claude CLI do not expose one shared temperature control in this harness.' },
      providerSeed: { availability: 'unavailable', reason: 'Neither pinned CLI surface exposes one shared deterministic provider seed.' },
    },
    outputSchemaDigest: digest('output-schema', canonicalSchemaText),
    claudeCompatibleOutputSchemaDigest: digest('claude-compatible-output-schema', claudeSchema),
    promptProducer: 'agent_prompt-audit-experiment.v1',
    gateEvidence: false,
  };
  if (!options.execute) {
    const probe = cells.find(cell => cell.sampleId === 'critical-01' && cell.host === 'codex-cli' && cell.repeat === 1 && cell.arm === 'legacy');
    const probeSample = corpus.samples.find(sample => sample.id === probe.sampleId);
    const legacyProbe = await producePromptThroughAgentPrompt(probe, probeSample);
    const modularProbe = await producePromptThroughAgentPrompt({ ...probe, arm: 'modular' }, probeSample);
    assert.equal(legacyProbe.producerMode, 'legacy-full-context');
    assert.equal(legacyProbe.envelopeId, null);
    assert.equal(modularProbe.producerMode, 'full-envelope');
    assert.ok(modularProbe.envelopeId);
    assert.equal(modularProbe.eventBinding.promptEnvelopeId, modularProbe.envelopeId);
    process.stdout.write(`story6-live selfcheck: PASS classes=3 samples=${corpus.samples.length} cells=${cells.length} roles=5 hosts=2 repetitions=3 producer=agent_prompt claudeSchemaMutationsRejected=2 gateEvidence=false\n`);
    process.stdout.write(`protocolBindingDigest=${digest('protocol-binding', protocolBinding)}; execution not requested => provider outcome INCONCLUSIVE\n`);
    return;
  }
  const cell = cells.find(candidate => candidate.cellId === options.cellId);
  if (!cell) throw new Error(`unknown --cell; choose one of: ${cells.map(candidate => candidate.cellId).join(', ')}`);
  const sample = corpus.samples.find(candidate => candidate.id === cell.sampleId);
  const produced = await producePromptThroughAgentPrompt(cell, sample);
  const prompt = produced.prompt;
  const invocation = hostInvocation(cell, options, claudeSchema);
  const campaignBinding = { ...protocolBinding, campaignId: options.campaignId, models: { 'codex-cli': options.codexModel, 'claude-cli': options.claudeModel } };
  const result = await runProcess(invocation, prompt, options.timeoutMs);
  const provider = parseProvider(cell, result);
  const receipt = {
    schemaVersion: 'proofbound.story6-live-ab-receipt.v1',
    campaignId: options.campaignId,
    campaignBindingDigest: digest('campaign-binding', campaignBinding),
    cell,
    model: invocation.model,
    toolPolicy: TOOLS,
    promptDigest: digest('prompt', prompt),
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    materialDigest: sample.materialDigest,
    findingSetDigest: sample.findingSetDigest,
    observedAt: new Date().toISOString(),
    provenance: {
      kind: 'production-provider-dispatch',
      producer: 'agent_prompt',
      producerMode: produced.producerMode,
      producerResponseDigest: produced.producerResponseDigest,
      envelopeId: produced.envelopeId,
      eventBinding: produced.eventBinding,
      gateEvidence: false,
    },
    provider,
    outcome: provider.availability === 'available' ? 'PENDING_INDEPENDENT_ADJUDICATION' : 'INCONCLUSIVE',
    gateEvidence: false,
  };
  await mkdir(RUNTIME, { recursive: true });
  const receiptPath = path.join(RUNTIME, `${options.campaignId}.${cell.cellId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`story6-live cell: ${receipt.outcome} ${cell.cellId} provider=${provider.availability} receipt=${path.relative(ROOT, receiptPath)}\n`);
}

main().catch(error => {
  process.stderr.write(`story6-live: INCONCLUSIVE ${error.message}\n`);
  process.exitCode = 2;
});
