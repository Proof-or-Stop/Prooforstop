#!/usr/bin/env node
/**
 * B-0f7c CHK-004 / CHK-005: smoke suite for the LLM usage ledger DISPATCH seam.
 *
 * Covers the thin one-way seam wiring the ledger into the Claude dispatch path:
 *   - CHK-001 orchestrator: preflight estimate appended (correlation handle
 *     returned); provider-reported final SUPERSEDES the estimate so the summary
 *     counts only the final (no double count); unavailable final when no usage;
 *     flag OFF => nothing written; never-throws under adversarial inputs;
 *   - CHK-002 parser: usage extracted from a sample JSON envelope; raw-text /
 *     malformed / empty / type-confused / no-usage / huge / deeply-nested all
 *     fall back gracefully to usage=null; never throws;
 *   - CHK-004 regression safety: the spawn args produced by the extracted
 *     arg-builder remain the canonical observable/bounded stream-json launcher
 *     with a prompt-contents argv slot; with the flag ON but non-JSON stdout the
 *     parser returns raw text + null and recordDispatchFinal records 'unavailable'
 *     (nothing throws); various falsy env strings all read as OFF;
 *   - CHK-005 simulated end-to-end: sample Claude JSON envelope -> parse -> record
 *     preflight then final (opt-in ON, temp dir) -> read the ledger back via
 *     summary + diagnostics and assert the story's provider-reported total equals
 *     the sample's tokens AND the estimate was superseded (not double-counted);
 *   - STATIC import boundary: the whole core/usage-ledger module imports ZERO
 *     other Proof-or-Stop modules (only ./ siblings + node: builtins), preserved after
 *     adding dispatch-usage.ts.
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import {
  buildClaudeSpawnArgs,
} from '../core/proof-or-stop-dispatch.js';
import {
  parseClaudeCliOutput,
  recordDispatchFinal,
  recordDispatchPreflight,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';
import { summarizeRecords } from '../core/usage-ledger/summary.js';
import { buildUsageReport } from '../core/usage-ledger/diagnostics.js';

let passed = 0;
const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const ON = { PROOF_OR_STOP_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;
// Ledger is default-ON, so OFF must be the EXPLICIT escape hatch, not an empty
// env (an empty/unset env now reads as ON).
const OFF = { PROOF_OR_STOP_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-dispatch-'));

function ctx(over: Partial<DispatchUsageContext> = {}): DispatchUsageContext {
  return {
    storyId: 'S-test',
    phase: 'dispatch',
    agentType: 'proof-or-stop-dispatch:claude-code',
    model: 'claude-code',
    ...over,
  };
}

function opts(env: NodeJS.ProcessEnv) {
  return {
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'claude --print --verbose --output-format=stream-json <prompt-file>',
    host: { kind: 'claude-code' },
    env,
  };
}

const EXPECTED_CLAUDE_SPAWN_ARGS = [
  '--print',
  '--verbose',
  '--output-format=stream-json',
  '<prompt-file>',
] as const;

/** Read the ledger lines under a fresh sub-root, verifying the chain. */
function readLedger(subRoot: string) {
  const path = resolveLedgerPath(subRoot);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

/** Make a fresh isolated sub-root so each test owns its own ledger file. */
let counter = 0;
function freshRoot(): string {
  const dir = join(root, `case-${counter++}`);
  return dir;
}

async function main(): Promise<void> {
  // ======================================================================
  // CHK-002: parseClaudeCliOutput
  // ======================================================================
  await check('CHK-002 happy: JSON envelope -> {result, usage extracted}', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Hello from Claude',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 1000,
        output_tokens: 300,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 200,
      },
    });
    const parsed = parseClaudeCliOutput(envelope);
    assert.equal(parsed.resultText, 'Hello from Claude');
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.anthropicUsage?.input_tokens, 1000);
    assert.equal(parsed.anthropicUsage?.output_tokens, 300);
    assert.equal(parsed.anthropicUsage?.cache_creation_input_tokens, 5);
    assert.equal(parsed.anthropicUsage?.cache_read_input_tokens, 200);
    assert.equal(parsed.model, 'claude-opus-4-8');
  });

  await check('CHK-002 happy: Claude stream-json NDJSON -> final result event extracted', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', result: 'older partial result', model: 'claude-old', usage: { input_tokens: 1, output_tokens: 1 } }),
      JSON.stringify({
        type: 'result',
        result: 'Final stream result',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 42,
          output_tokens: 11,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 7,
        },
      }),
    ].join('\n');
    const parsed = parseClaudeCliOutput(stream);
    assert.equal(parsed.resultText, 'Final stream result');
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.anthropicUsage?.input_tokens, 42);
    assert.equal(parsed.anthropicUsage?.output_tokens, 11);
    assert.equal(parsed.anthropicUsage?.cache_creation_input_tokens, 3);
    assert.equal(parsed.anthropicUsage?.cache_read_input_tokens, 7);
    assert.equal(parsed.model, 'claude-sonnet-4-5');
  });

  await check('CHK-002 happy: Claude stream-json can select final own-result event without type=result', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: 'progress' } }),
      JSON.stringify({ result: 'Final by own result', usage: { input_tokens: 9, output_tokens: 4, model: 'claude-usage-model' } }),
    ].join('\n');
    const parsed = parseClaudeCliOutput(stream);
    assert.equal(parsed.resultText, 'Final by own result');
    assert.equal(parsed.anthropicUsage?.input_tokens, 9);
    assert.equal(parsed.anthropicUsage?.output_tokens, 4);
    assert.equal(parsed.model, 'claude-usage-model');
  });

  await check('CHK-002 edge: Claude stream-json without result event -> raw text + null usage + null model', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 2 } } }),
    ].join('\n');
    const parsed = parseClaudeCliOutput(stream);
    assert.equal(parsed.resultText, stream);
    assert.equal(parsed.anthropicUsage, null);
    assert.equal(parsed.model, null);
  });

  await check('CHK-002 happy: plain text stdout -> raw text + null usage + null model', () => {
    const parsed = parseClaudeCliOutput('Just some text output');
    assert.equal(parsed.resultText, 'Just some text output');
    assert.equal(parsed.anthropicUsage, null);
    assert.equal(parsed.model, null);
  });

  await check('CHK-002 model: top-level .model preferred over .usage.model', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({
        result: 'x',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1, output_tokens: 1, model: 'claude-sonnet-ignored' },
      }),
    );
    assert.equal(parsed.model, 'claude-opus-4-8');
  });

  await check('CHK-002 model: falls back to .usage.model when no top-level model', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({ result: 'x', usage: { input_tokens: 1, output_tokens: 1, model: 'claude-haiku-4' } }),
    );
    assert.equal(parsed.model, 'claude-haiku-4');
  });

  await check('CHK-002 model: non-string / empty model -> null (no bad model id)', () => {
    const numeric = parseClaudeCliOutput(JSON.stringify({ result: 'x', model: 42, usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.equal(numeric.model, null);
    const empty = parseClaudeCliOutput(JSON.stringify({ result: 'x', model: '', usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.equal(empty.model, null);
  });

  await check('CHK-002 edge: malformed JSON -> raw text + null (never throws)', () => {
    const parsed = parseClaudeCliOutput('{not valid json');
    assert.equal(parsed.resultText, '{not valid json');
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-002 edge: valid JSON without usage -> result extracted, usage null', () => {
    const parsed = parseClaudeCliOutput(JSON.stringify({ result: 'hi' }));
    assert.equal(parsed.resultText, 'hi');
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-002 edge: valid JSON without result -> raw text, usage extracted', () => {
    const raw = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
    const parsed = parseClaudeCliOutput(raw);
    assert.equal(parsed.resultText, raw);
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.anthropicUsage?.input_tokens, 10);
  });

  await check('CHK-002 edge: empty string -> empty result + null (never throws)', () => {
    const parsed = parseClaudeCliOutput('');
    assert.equal(parsed.resultText, '');
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-002 edge: usage with only primaries -> cache fields absent (not 0)', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({ result: 'x', usage: { input_tokens: 100, output_tokens: 50 } }),
    );
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.anthropicUsage?.input_tokens, 100);
    assert.equal(parsed.anthropicUsage?.output_tokens, 50);
    assert.equal(parsed.anthropicUsage?.cache_creation_input_tokens, undefined);
    assert.equal(parsed.anthropicUsage?.cache_read_input_tokens, undefined);
  });

  await check('CHK-002 adversarial: deeply-nested JSON -> no stack overflow, top-level read', () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 50; i++) nested = { result: nested };
    const raw = JSON.stringify(nested);
    const parsed = parseClaudeCliOutput(raw);
    // .result is an object (not a string) -> falls back to raw text; usage null.
    assert.equal(parsed.resultText, raw);
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-002 adversarial: tokens as strings -> usage rejected (null)', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({ result: 'x', usage: { input_tokens: 'not a number', output_tokens: 5 } }),
    );
    assert.equal(parsed.resultText, 'x');
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-002 adversarial: very large stdout (5MB) -> full text returned, no OOM', () => {
    const big = 'a'.repeat(5 * 1024 * 1024);
    const parsed = parseClaudeCliOutput(big);
    assert.equal(parsed.resultText.length, big.length);
    assert.equal(parsed.anthropicUsage, null);
  });

  // ======================================================================
  // CHK-001: recordDispatchPreflight
  // ======================================================================
  await check('CHK-001 happy: preflight ON -> handle returned, 1 estimate line written', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'Hello world prompt', opts(ON));
    assert.ok(handle, 'expected a preflight handle');
    assert.ok(handle?.correlation.ledgerCallId.startsWith('llmcall_'));
    assert.ok(handle?.correlation.attemptId.startsWith('llmatt_'));
    assert.ok(handle?.estimateRecordId.startsWith('llmuse_'));
    const records = readLedger(sub);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.usage.source, 'prompt-size-estimate');
    assert.equal(rec.usage.estimator?.confidence, 'low');
    assert.ok((rec.usage.inputTokens as number) > 0);
    assert.equal(rec.usage.outputTokens, null);
    assert.equal(rec.storyId, 'S-test');
  });

  await check('CHK-001 happy: provider-reported final supersedes estimate (no double count)', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinal(
      sub,
      ctx(),
      handle!.correlation,
      handle!.estimateRecordId,
      { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 50 },
      'claude-opus-4-8',
      opts(ON),
    );
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final);
    assert.equal(final?.usage.inputTokens, 500);
    assert.equal(final?.usage.outputTokens, 200);
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    // Provider total counts ONLY the final: 500+200+10+50 = 760 (estimate excluded).
    assert.equal(summary.providerReportedTotal, 760);
    assert.equal(summary.providerReportedCount, 1);
    assert.equal(summary.estimateCount, 0, 'the estimate must be superseded, not counted');
  });

  await check('CHK-001 happy: unavailable final supersedes estimate; counts as unknown', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinal(sub, ctx(), handle!.correlation, handle!.estimateRecordId, null, 'claude-code', opts(ON));
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.ok((final?.usage.unavailableReason ?? '').length > 0);
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    assert.equal(summary.unknownCount, 1);
    assert.equal(summary.providerReportedCount, 0);
    assert.equal(summary.estimateCount, 0);
  });

  await check('CHK-001 edge: empty prompt -> inputTokens=0, never throws', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), '', opts(ON));
    assert.ok(handle);
    const records = readLedger(sub);
    assert.equal(records[0].usage.inputTokens, 0);
  });

  await check('CHK-001 edge: 1MB prompt -> large positive integer, <500ms', () => {
    const sub = freshRoot();
    const big = 'x'.repeat(1024 * 1024);
    const start = Date.now();
    const handle = recordDispatchPreflight(sub, ctx(), big, opts(ON));
    const elapsed = Date.now() - start;
    assert.ok(handle);
    const records = readLedger(sub);
    assert.ok((records[0].usage.inputTokens as number) > 200000);
    assert.ok(elapsed < 500, `preflight took ${elapsed}ms`);
  });

  await check('CHK-001 edge: final with no cache fields -> cache dimensions null (not 0)', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(ON));
    recordDispatchFinal(
      sub,
      ctx(),
      handle!.correlation,
      handle!.estimateRecordId,
      { input_tokens: 100, output_tokens: 50 },
      'claude-code',
      opts(ON),
    );
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.equal(final?.usage.cacheCreationInputTokens, null);
    assert.equal(final?.usage.cacheReadInputTokens, null);
  });

  await check('CHK-001 edge: storyId=null is written (present, not omitted)', () => {
    const sub = freshRoot();
    recordDispatchPreflight(sub, ctx({ storyId: null }), 'p', opts(ON));
    const records = readLedger(sub);
    assert.ok('storyId' in records[0]);
    assert.equal(records[0].storyId, null);
  });

  await check('CHK-001 adversarial: preflight with corrupt existing ledger -> returns null, no throw', () => {
    const sub = freshRoot();
    // Write a first valid record, then corrupt the last line so chaining throws.
    recordDispatchPreflight(sub, ctx(), 'p', opts(ON));
    const path = resolveLedgerPath(sub);
    appendFileSync(path, 'this is not json\n', 'utf8');
    let threw = false;
    let handle: ReturnType<typeof recordDispatchPreflight> = null;
    try {
      handle = recordDispatchPreflight(sub, ctx(), 'p2', opts(ON));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'recordDispatchPreflight must never throw');
    assert.equal(handle, null, 'a corrupt ledger yields a null handle, not a throw');
  });

  await check('CHK-001 adversarial: final with negative tokens -> does not throw', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(ON));
    let threw = false;
    try {
      recordDispatchFinal(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        { input_tokens: -999, output_tokens: 5 } as never,
        'claude-code',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a rogue negative token count must not crash dispatch');
    // The estimate stays (the bad final was rejected by validation inside the catch).
    const records = readLedger(sub);
    assert.ok(records.length >= 1);
  });

  await check('CHK-001 adversarial: flag OFF -> null, no file, no .proof-or-stop/usage dir', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(OFF));
    assert.equal(handle, null);
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
    assert.equal(existsSync(join(sub, '.proof-or-stop', 'usage')), false);
  });

  await check('CHK-001 adversarial: two concurrent preflights -> distinct correlations', () => {
    const sub = freshRoot();
    const a = recordDispatchPreflight(sub, ctx(), 'a', opts(ON));
    const b = recordDispatchPreflight(sub, ctx(), 'b', opts(ON));
    assert.ok(a && b);
    assert.notEqual(a!.correlation.ledgerCallId, b!.correlation.ledgerCallId);
    assert.notEqual(a!.correlation.attemptId, b!.correlation.attemptId);
    assert.notEqual(a!.estimateRecordId, b!.estimateRecordId);
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    assert.notEqual(records[0].recordId, records[1].recordId);
  });

  // ======================================================================
  // CHK-004: regression safety (canonical observable arg shape + parse fallback)
  // ======================================================================
  await check('CHK-004: buildClaudeSpawnArgs(prompt) preserves canonical observable/bounded launcher', () => {
    const args = buildClaudeSpawnArgs('<prompt-file>');
    assert.deepEqual(args, [...EXPECTED_CLAUDE_SPAWN_ARGS]);
  });

  await check('CHK-004 parse-failure fallback: ON + non-JSON -> raw text; final records unavailable', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(ON));
    const parsed = parseClaudeCliOutput('plain non-json output from the host');
    assert.equal(parsed.resultText, 'plain non-json output from the host');
    assert.equal(parsed.anthropicUsage, null);
    let threw = false;
    try {
      recordDispatchFinal(sub, ctx(), handle!.correlation, handle!.estimateRecordId, parsed.anthropicUsage, 'claude-code', opts(ON));
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'a parse failure must record an unavailable final');
  });

  await check('CHK-004 edge: env "false"/"0"/"off" all read as OFF (no file)', () => {
    for (const val of ['false', '0', 'off', 'no', '']) {
      const sub = freshRoot();
      const handle = recordDispatchPreflight(sub, ctx(), 'p', { ...opts(OFF), env: { PROOF_OR_STOP_USAGE_LEDGER: val } });
      assert.equal(handle, null, `env value "${val}" must read as OFF`);
      assert.equal(existsSync(resolveLedgerPath(sub)), false);
    }
  });

  await check('CHK-004 edge: truncated JSON envelope -> raw text + null usage', () => {
    const fullEnvelope = JSON.stringify({ result: 'hi', usage: { input_tokens: 5, output_tokens: 2 } });
    const truncated = fullEnvelope.slice(0, Math.floor(fullEnvelope.length / 2));
    const parsed = parseClaudeCliOutput(truncated);
    assert.equal(parsed.resultText, truncated);
    assert.equal(parsed.anthropicUsage, null);
  });

  await check('CHK-004 adversarial: ON + valid envelope with negative tokens -> usage rejected, no throw', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(ON));
    const parsed = parseClaudeCliOutput(JSON.stringify({ result: 'x', usage: { input_tokens: -999, output_tokens: 5 } }));
    // The parser rejects the type-confused/invalid usage (negative) -> null.
    assert.equal(parsed.resultText, 'x');
    assert.equal(parsed.anthropicUsage, null);
    let threw = false;
    try {
      recordDispatchFinal(sub, ctx(), handle!.correlation, handle!.estimateRecordId, parsed.anthropicUsage, 'claude-code', opts(ON));
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    // resultText still usable downstream; final recorded as unavailable.
    const records = readLedger(sub);
    assert.ok(records.find((r) => r.usage.source === 'unavailable'));
  });

  // ======================================================================
  // CHK-005: simulated end-to-end record-chain round-trip
  // ======================================================================
  await check('CHK-005 end-to-end: envelope -> parse -> preflight+final -> diagnostics totals + served model correct', () => {
    const sub = freshRoot();
    const SERVED_MODEL = 'claude-opus-4-8';
    const sampleEnvelope = JSON.stringify({
      type: 'result',
      result: 'Done.',
      model: SERVED_MODEL,
      usage: {
        input_tokens: 1500,
        output_tokens: 400,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const parsed = parseClaudeCliOutput(sampleEnvelope);
    assert.equal(parsed.resultText, 'Done.');
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.model, SERVED_MODEL);

    // The estimate uses the best-effort default model ('claude-code'); the final
    // must bind the REAL served model parsed from the envelope, NOT the default.
    const e2eCtx = ctx({ storyId: 'S-e2e', model: 'claude-code' });
    const handle = recordDispatchPreflight(sub, e2eCtx, 'the prompt text', opts(ON));
    assert.ok(handle);
    recordDispatchFinal(
      sub,
      e2eCtx,
      handle!.correlation,
      handle!.estimateRecordId,
      parsed.anthropicUsage,
      parsed.model,
      opts(ON),
    );

    const records = readLedger(sub);
    assert.equal(records.length, 2);

    // The provider-reported record carries the EXACT served model, not the default.
    const finalRecord = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(finalRecord);
    assert.equal(finalRecord?.provider?.model, SERVED_MODEL);
    assert.notEqual(finalRecord?.provider?.model, 'claude-code');

    // summary: provider total = 1500+400+0+0 = 1900 (estimate superseded, excluded)
    const summary = summarizeRecords(records);
    assert.equal(summary.providerReportedTotal, 1900);
    assert.equal(summary.providerReportedCount, 1);
    assert.equal(summary.estimateCount, 0, 'estimate must be superseded, not double-counted');

    // diagnostics: the S-e2e group is keyed by the served model and its
    // provider-reported known dimensions match.
    const report = buildUsageReport(records);
    const group = report.groups.find((g) => g.key.storyId === 'S-e2e' && g.key.model === SERVED_MODEL);
    assert.ok(group, `expected an S-e2e group keyed by model ${SERVED_MODEL}`);
    assert.equal(group!.key.model, SERVED_MODEL);
    const provider = group!.bySource['provider-reported'];
    assert.equal(provider.known.input, 1500);
    assert.equal(provider.known.output, 400);
    assert.equal(provider.knownCount, 1);
    // The estimate bucket has NO known records (it was superseded out of selection).
    assert.equal(group!.bySource['prompt-size-estimate'].knownCount, 0);
  });

  await check('CHK-005 edge: envelope with usage but no model -> final falls back to default (no throw)', () => {
    const sub = freshRoot();
    const noModelEnvelope = JSON.stringify({
      type: 'result',
      result: 'Done.',
      usage: { input_tokens: 700, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const parsed = parseClaudeCliOutput(noModelEnvelope);
    assert.ok(parsed.anthropicUsage);
    assert.equal(parsed.model, null, 'no model field -> parsed.model is null');

    const handle = recordDispatchPreflight(sub, ctx({ storyId: 'S-default' }), 'p', opts(ON));
    assert.ok(handle);
    let threw = false;
    try {
      // parsed.model is null -> recordDispatchFinal binds the best-effort default.
      recordDispatchFinal(sub, ctx({ storyId: 'S-default' }), handle!.correlation, handle!.estimateRecordId, parsed.anthropicUsage, parsed.model, opts(ON));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a null model must not throw');
    const records = readLedger(sub);
    const finalRecord = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(finalRecord);
    // Falls back to the best-effort default ('unknown' from dispatch-usage), never
    // an empty/null model on the record.
    assert.ok((finalRecord?.provider?.model ?? '').length > 0, 'model must be a non-empty default');
    assert.notEqual(finalRecord?.provider?.model, null);
  });

  await check('CHK-005 flag OFF: dispatch-usage writes nothing to the temp dir', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(OFF));
    recordDispatchFinal(sub, ctx(), null, null, { input_tokens: 1, output_tokens: 1 }, 'claude-code', opts(OFF));
    assert.equal(handle, null);
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
  });

  await check('CHK-005 adversarial: parser malformed fallback never throws (smoke-level)', () => {
    let threw = false;
    try {
      const parsed = parseClaudeCliOutput('{"result": "broken", "usage": {');
      assert.equal(parsed.anthropicUsage, null);
      assert.equal(parsed.resultText, '{"result": "broken", "usage": {');
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });

  // ======================================================================
  // STATIC: module isolation (zero-cross-module-import for core/usage-ledger)
  // ======================================================================
  await check('STATIC core/usage-ledger imports ZERO other Proof-or-Stop modules (incl. dispatch-usage.ts)', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    const tsFiles = walkTs(moduleDir);
    assert.ok(tsFiles.length > 0, 'expected usage-ledger .ts files');
    assert.ok(
      tsFiles.some((f) => f.endsWith('dispatch-usage.ts')),
      'dispatch-usage.ts must be part of the scanned module',
    );
    const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          const rel = relative(moduleDir, resolved);
          const escapesModule = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\');
          if (escapesModule) offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
          continue;
        }
        offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `usage-ledger must import only in-module siblings + node:; offenders:\n${offenders.join('\n')}`);
  });

  await check('STATIC dispatch-usage.ts imports only ./ siblings + node:', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(
      join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger', 'dispatch-usage.ts'),
      'utf8',
    );
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    const specs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) specs.push(m[1]);
    assert.ok(specs.length > 0, 'expected imports in dispatch-usage.ts');
    for (const spec of specs) {
      const ok = spec.startsWith('node:') || spec.startsWith('./');
      assert.ok(ok, `dispatch-usage.ts imported an unexpected spec: ${spec}`);
    }
  });

  await check('STATIC proof-or-stop-dispatch.ts imports usage-ledger ONLY via dispatch-usage.js', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', 'core', 'proof-or-stop-dispatch.ts'), 'utf8');
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    const usageLedgerSpecs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      if (m[1].includes('usage-ledger/')) usageLedgerSpecs.push(m[1]);
    }
    assert.deepEqual(
      usageLedgerSpecs,
      ['./usage-ledger/dispatch-usage.js'],
      `proof-or-stop-dispatch must import usage-ledger ONLY through dispatch-usage.js; got: ${usageLedgerSpecs.join(', ')}`,
    );
  });

  await check('isolation: all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    assert.ok(statSync(root).isDirectory());
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ usage-ledger dispatch smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger dispatch smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger dispatch smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}
