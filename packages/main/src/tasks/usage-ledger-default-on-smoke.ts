#!/usr/bin/env node
/**
 * B-1b28: smoke suite for the LLM usage ledger DEFAULT-ON flip.
 *
 * The ledger writer is now active by default; LATTICE_USAGE_LEDGER=0 is the
 * explicit escape hatch that restores the legacy default-off no-op behavior.
 * The legacy retired-brand env alias was removed (B-b837); a stale
 * retired-brand-prefixed value is silently ignored. This smoke proves the
 * behavioral contracts of that flip:
 *
 *   - CHK-001 flag parsing: an UNSET env reads as ON; the falsy strings
 *     ('0'/'false'/'off'/'no'/'') read as OFF; the truthy strings
 *     ('1'/'true'/'on'/'yes', trimmed/case-insensitive) read as ON; a stale
 *     legacy alias env is ignored; the flag is re-read every call (not memoized).
 *   - CHK-002 escape hatch (=0 guard-inert): with LATTICE_USAGE_LEDGER=0
 *     the whole pipeline is a strict no-op — appendUsageRecord writes nothing and
 *     creates no file/dir, recordDispatchPreflight returns null, recordDispatchFinal
 *     writes nothing, recordBudgetBlock is inert (no block) even with a budget set,
 *     and buildClaudeSpawnArgs(file,false) preserves the canonical observable
 *     stream-json launcher. A stale legacy alias=0 no longer triggers the no-op
 *     (default-ON wins).
 *   - CHK-003 default-on safety: with the env UNSET, isUsageLedgerEnabled() is true,
 *     appendUsageRecord WRITES, a parse failure still yields raw text (the B-0f7c
 *     fallback), a thrown ledger op does NOT propagate to the dispatch caller, and
 *     NO budget block occurs when LATTICE_HARD_BUDGET_TOKENS is unset.
 *   - STATIC: the whole core/usage-ledger module still imports ZERO other Proofbound
 *     modules (only ./ siblings + node: builtins).
 *
 * Runs entirely in an OS temp dir and saves/restores process.env hermetically;
 * never pollutes the repo or leaks env state. Prints per-check lines and a final
 * summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { buildClaudeSpawnArgs } from '../core/lattice-dispatch.js';
import {
  isUsageLedgerEnabled,
  parseClaudeCliOutput,
  recordBudgetBlock,
  recordDispatchFinal,
  recordDispatchPreflight,
  resolveHardBudget,
  shouldBlockDispatch,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import { appendUsageRecord, resolveLedgerPath } from '../core/usage-ledger/writer.js';
import { type UsageLedgerRecordInput } from '../core/usage-ledger/record.js';

let passed = 0;
const failures: string[] = [];

// The legacy ledger-alias env var (formerly the retired-brand-prefixed name) was
// removed (B-b837). Only LATTICE_USAGE_LEDGER is read now; any other env var —
// including a user's stale legacy alias — must be silently ignored. We exercise
// that with a representative stale legacy-shaped key built at runtime so the test
// stays free of the retired brand token.
const STALE_LEDGER_ALIAS = ['LEGACY', 'USAGE_LEDGER'].join('_');

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-default-on-'));

const EXPECTED_CLAUDE_SPAWN_ARGS = [
  '--print',
  '--verbose',
  '--output-format=stream-json',
  '<prompt-file>',
] as const;

let counter = 0;
function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

function ctx(over: Partial<DispatchUsageContext> = {}): DispatchUsageContext {
  return {
    storyId: 'B-1b28',
    phase: 'dispatch',
    agentType: 'lattice-dispatch:claude-code',
    model: 'claude-code',
    ...over,
  };
}

function opts(env: NodeJS.ProcessEnv) {
  return {
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'claude --print --verbose --output-format=stream-json <prompt-file>',
    host: { kind: 'claude-code' } as UsageLedgerRecordInput['host'],
    env,
  };
}

/**
 * Run `fn` with a temporary patch to process.env, always restoring the prior
 * values (deleting keys that were absent). Keeps the default-on (no explicit env)
 * checks hermetic even though they deliberately read the real process.env.
 */
function withProcessEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prior[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

/** Build a valid provider-reported record body (without integrity). */
function validRecord(): UsageLedgerRecordInput {
  return {
    schemaVersion: 1,
    recordId: `rec_${counter++}_${Date.now()}`,
    ledgerCallId: `llmcall_${counter}`,
    attemptId: `attempt_${counter}`,
    sequence: 1,
    supersedesRecordIds: [],
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:abc',
    storyId: 'B-1b28',
    phase: 'DEV',
    agentType: 'implementer',
    subagentId: null,
    threadId: null,
    decision: { kind: 'allowed', budgetPolicyId: 'local-default', reasonCode: 'within_budget' },
    usage: {
      source: 'provider-reported',
      inputTokens: 1200,
      outputTokens: 340,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      canonical: { input: 1200, output: 340, cacheCreation: 0, cacheRead: 0 },
      raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:def' },
      estimator: null,
      unavailableReason: null,
    },
    privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
  };
}

try {
  // ======================================================================
  // CHK-001: flag parsing under the new default
  // ======================================================================
  check('CHK-001 UNSET env reads as ON (the core flip)', () => {
    assert.equal(isUsageLedgerEnabled({}), true);
  });

  check('CHK-001 truthy strings read as ON (1/true/on/yes)', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '1' }), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'true' }), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'on' }), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'yes' }), true);
  });

  check('CHK-001 falsy strings read as OFF (0/false/off/no/empty)', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '0' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'false' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'off' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'no' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '' }), false);
  });

  check('CHK-001 trimmed + case-insensitive parsing', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: ' 1 ' }), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: ' FALSE ' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'ON' }), true);
  });

  check('CHK-001 unrecognized values read as OFF (2/enabled)', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '2' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'enabled' }), false);
  });

  check('B-b837 adversarial: legacy ledger alias is ignored (default-ON preserved)', () => {
    // The legacy alias was removed; a stale alias env must not toggle the ledger.
    assert.equal(isUsageLedgerEnabled({ [STALE_LEDGER_ALIAS]: '1' }), true);
    assert.equal(isUsageLedgerEnabled({ [STALE_LEDGER_ALIAS]: '0' }), true);
  });

  check('B-b837 adversarial: only LATTICE_ controls the ledger; a stale alias alongside is ignored', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '0', [STALE_LEDGER_ALIAS]: '1' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '1', [STALE_LEDGER_ALIAS]: '0' }), true);
  });

  check('CHK-001 re-read every call (not memoized): 0 -> unset -> 1 toggles live', () => {
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '0' }), false);
    assert.equal(isUsageLedgerEnabled({}), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '1' }), true);
  });

  // ======================================================================
  // CHK-002: escape hatch (=0) restores ledger no-op behavior
  // ======================================================================
  const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;

  check('CHK-002 =0 => isUsageLedgerEnabled false', () => {
    assert.equal(isUsageLedgerEnabled(OFF), false);
  });

  check('CHK-002 =0 => appendUsageRecord strict no-op (10x, no file, no .lattice dir)', () => {
    const sub = freshRoot();
    for (let i = 0; i < 10; i += 1) {
      const res = appendUsageRecord(sub, validRecord(), { env: OFF });
      assert.equal(res.written, false);
    }
    assert.equal(existsSync(resolveLedgerPath(sub)), false, '=0 must create no ledger file');
    assert.equal(existsSync(join(sub, '.lattice')), false, '=0 must create no .lattice directory');
  });

  check('CHK-002 =0 => appendUsageRecord with real data still writes nothing', () => {
    const sub = freshRoot();
    const res = appendUsageRecord(sub, validRecord(), { env: OFF });
    assert.equal(res.written, false, 'even a valid record must not sneak a write through when OFF');
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
  });

  check('CHK-002 =0 => buildClaudeSpawnArgs(prompt,false) preserves canonical observable/bounded launcher', () => {
    assert.deepEqual(buildClaudeSpawnArgs('<prompt-file>', false), [...EXPECTED_CLAUDE_SPAWN_ARGS]);
  });

  check('CHK-002 =0 => recordDispatchPreflight returns null, writes nothing', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'a prompt', opts(OFF));
    assert.equal(handle, null);
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
  });

  check('CHK-002 =0 => recordDispatchFinal writes nothing', () => {
    const sub = freshRoot();
    recordDispatchFinal(sub, ctx(), null, null, { input_tokens: 10, output_tokens: 5 }, 'claude-code', opts(OFF));
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
  });

  check('CHK-002 =0 => resolveHardBudget(no budget env) null; shouldBlockDispatch(false,...) inert', () => {
    assert.equal(resolveHardBudget({ LATTICE_USAGE_LEDGER: '0' }), null);
    const d = shouldBlockDispatch(false, { LATTICE_HARD_BUDGET_TOKENS: '1000' }, 999);
    assert.equal(d.block, false);
    assert.equal(d.budget, null);
  });

  check('CHK-002 =0 + budget set => recordBudgetBlock inert (no block, no write)', () => {
    const sub = freshRoot();
    const env = { LATTICE_USAGE_LEDGER: '0', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const decision = recordBudgetBlock(sub, ctx(), null, 'a prompt clearly over a one-token budget', opts(env));
    assert.equal(decision.blocked, false, 'OFF means no block even with a budget configured');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'the whole pipeline leaves zero filesystem trace');
  });

  check('CHK-002 =0 => full pipeline (append + preflight + final + budget) leaves zero trace', () => {
    const sub = freshRoot();
    const env = { LATTICE_USAGE_LEDGER: '0', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    appendUsageRecord(sub, validRecord(), { env });
    const handle = recordDispatchPreflight(sub, ctx(), 'p', opts(env));
    recordDispatchFinal(sub, ctx(), null, null, { input_tokens: 1, output_tokens: 1 }, 'claude-code', opts(env));
    recordBudgetBlock(sub, ctx(), handle, 'p', opts(env));
    assert.equal(handle, null, 'preflight is a no-op when OFF');
    assert.equal(existsSync(join(sub, '.lattice', 'usage')), false, 'no usage directory created');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no ledger file created');
  });

  check('B-b837 adversarial: a stale ledger alias=0 does NOT disable the ledger (default-ON wins)', () => {
    const sub = freshRoot();
    // Legacy alias removed: a stale alias=0 must be ignored, so the ledger stays
    // ON (default) and the record IS written.
    const env = { [STALE_LEDGER_ALIAS]: '0' } as NodeJS.ProcessEnv;
    assert.equal(isUsageLedgerEnabled(env), true);
    const res = appendUsageRecord(sub, validRecord(), { env });
    assert.equal(res.written, true);
    assert.ok(recordDispatchPreflight(sub, ctx(), 'p', opts(env)));
    assert.equal(existsSync(resolveLedgerPath(sub)), true);
  });

  // ======================================================================
  // CHK-003: default-on (env UNSET) behavior + safety
  // ======================================================================
  check('CHK-003 UNSET env => appendUsageRecord WRITES one JSONL line', () => {
    withProcessEnv({ LATTICE_USAGE_LEDGER: undefined }, () => {
      const sub = freshRoot();
      // No `env` override -> appendUsageRecord falls back to process.env (UNSET = ON).
      const res = appendUsageRecord(sub, validRecord());
      assert.equal(res.written, true, 'default-on means an unset env triggers a real write');
      const path = resolveLedgerPath(sub);
      assert.equal(existsSync(path), true, 'the ledger file is created on the default-on path');
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1);
      JSON.parse(lines[0]); // a valid JSONL line
    });
  });

  check('CHK-003 UNSET env => recordDispatchPreflight returns an active handle + 1 estimate line', () => {
    withProcessEnv({ LATTICE_USAGE_LEDGER: undefined }, () => {
      const sub = freshRoot();
      const handle = recordDispatchPreflight(sub, ctx(), 'Hello world prompt', {
        recordedAt: '2026-06-16T00:00:00.000Z',
        projectRootHash: 'sha256:deadbeef',
      });
      assert.ok(handle, 'preflight is active on the default-on path');
      assert.ok(handle?.correlation.ledgerCallId.length);
      assert.ok(handle?.estimateRecordId.length);
      assert.equal(typeof handle?.estimatedInputTokens, 'number');
      const lines = readFileSync(resolveLedgerPath(sub), 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1, 'preflight appends exactly one estimate record');
    });
  });

  check('CHK-003 UNSET env => recordDispatchFinal supersedes the estimate (provider final, seq 2)', () => {
    withProcessEnv({ LATTICE_USAGE_LEDGER: undefined }, () => {
      const sub = freshRoot();
      const baseOpts = { recordedAt: '2026-06-16T00:00:00.000Z', projectRootHash: 'sha256:deadbeef' };
      const handle = recordDispatchPreflight(sub, ctx(), 'p', baseOpts);
      assert.ok(handle);
      recordDispatchFinal(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        { input_tokens: 100, output_tokens: 20 },
        'claude-opus-4-8',
        baseOpts,
      );
      const lines = readFileSync(resolveLedgerPath(sub), 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 2, 'estimate + final = 2 records');
      const final = JSON.parse(lines[1]);
      assert.equal(final.sequence, 2);
      assert.equal(final.usage.source, 'provider-reported');
      assert.deepEqual(final.supersedesRecordIds, [handle!.estimateRecordId]);
    });
  });

  check('CHK-003 ON path: buildClaudeSpawnArgs(prompt,true) uses same canonical observable/bounded launcher', () => {
    assert.deepEqual(buildClaudeSpawnArgs('<prompt-file>', true), [...EXPECTED_CLAUDE_SPAWN_ARGS]);
  });

  check('CHK-003 parse: valid JSON envelope => resultText + anthropicUsage + model', () => {
    const parsed = parseClaudeCliOutput(
      JSON.stringify({
        result: 'Hello',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    );
    assert.equal(parsed.resultText, 'Hello');
    assert.equal(parsed.anthropicUsage?.input_tokens, 50);
    assert.equal(parsed.anthropicUsage?.output_tokens, 10);
    assert.equal(parsed.model, 'claude-opus-4-8');
  });

  check('CHK-003 parse: non-JSON raw text => B-0f7c fallback (raw text, null usage, null model)', () => {
    const raw = 'plain non-json output from the host';
    const parsed = parseClaudeCliOutput(raw);
    assert.equal(parsed.resultText, raw, 'a parse failure degrades gracefully to the raw stdout text');
    assert.equal(parsed.anthropicUsage, null);
    assert.equal(parsed.model, null);
  });

  check('CHK-003 parse adversarial: deeply nested + type-confused usage => raw/null fallback, no throw', () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 1000; i += 1) nested = { result: nested };
    const deep = parseClaudeCliOutput(JSON.stringify(nested));
    assert.equal(deep.anthropicUsage, null, 'deeply nested input falls back, never throws');
    const typed = parseClaudeCliOutput(JSON.stringify({ result: 'x', usage: { input_tokens: '100', output_tokens: 5 } }));
    assert.equal(typed.anthropicUsage, null, 'string token counts are rejected (type coercion)');
  });

  check('CHK-003 UNSET env => a thrown ledger op does NOT propagate (preflight returns null on corrupt ledger)', () => {
    withProcessEnv({ LATTICE_USAGE_LEDGER: undefined }, () => {
      const sub = freshRoot();
      const baseOpts = { recordedAt: '2026-06-16T00:00:00.000Z', projectRootHash: 'sha256:deadbeef' };
      // Seed a valid record, then corrupt the last line so the next chain read throws
      // inside the writer; recordDispatchPreflight must swallow it and return null.
      recordDispatchPreflight(sub, ctx(), 'p', baseOpts);
      appendFileSync(resolveLedgerPath(sub), 'this is not json\n', 'utf8');
      let threw = false;
      let handle: ReturnType<typeof recordDispatchPreflight> = null;
      try {
        handle = recordDispatchPreflight(sub, ctx(), 'p2', baseOpts);
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'a ledger error must never propagate to the dispatch caller');
      assert.equal(handle, null, 'a corrupt ledger yields a null handle, not a throw');
    });
  });

  check('CHK-003 UNSET env => recordDispatchFinal swallows a corrupt-ledger error (returns void, no throw)', () => {
    withProcessEnv({ LATTICE_USAGE_LEDGER: undefined }, () => {
      const sub = freshRoot();
      const baseOpts = { recordedAt: '2026-06-16T00:00:00.000Z', projectRootHash: 'sha256:deadbeef' };
      recordDispatchPreflight(sub, ctx(), 'p', baseOpts);
      appendFileSync(resolveLedgerPath(sub), 'not json\n', 'utf8');
      let threw = false;
      try {
        recordDispatchFinal(sub, ctx(), null, null, { input_tokens: 1, output_tokens: 1 }, 'claude-code', baseOpts);
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'a post-dispatch ledger error must not crash the caller');
    });
  });

  check('CHK-003 UNSET env + NO LATTICE_HARD_BUDGET_TOKENS => no budget block', () => {
    withProcessEnv(
      { LATTICE_USAGE_LEDGER: undefined, LATTICE_HARD_BUDGET_TOKENS: undefined },
      () => {
        const sub = freshRoot();
        assert.equal(resolveHardBudget(undefined), null, 'default-on does NOT auto-enable a budget');
        const d = shouldBlockDispatch(true, undefined, 999999);
        assert.equal(d.block, false, 'no configured budget => never blocks even with a huge estimate');
        const decision = recordBudgetBlock(sub, ctx(), null, 'a large prompt with no budget set', {
          recordedAt: '2026-06-16T00:00:00.000Z',
          projectRootHash: 'sha256:deadbeef',
        });
        assert.equal(decision.blocked, false);
      },
    );
  });

  // ======================================================================
  // STATIC: zero cross-module import invariant for core/usage-ledger
  // ======================================================================
  check('STATIC core/usage-ledger imports ZERO other Proofbound modules', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    const tsFiles = walkTs(moduleDir);
    assert.ok(tsFiles.length > 0, 'expected usage-ledger .ts files');
    const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        // node: builtins are allowed.
        if (spec.startsWith('node:')) continue;
        // Relative imports must resolve to a sibling under core/usage-ledger/.
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          const rel = relative(moduleDir, resolved);
          if (rel.startsWith('..')) offenders.push(`${relative(repoRoot, file)} -> ${spec}`);
          continue;
        }
        // A bare specifier (a package or another Proofbound module) is an offender.
        offenders.push(`${relative(repoRoot, file)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `usage-ledger must import zero other modules; offenders: ${offenders.join(', ')}`);
  });

  check('STATIC all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    assert.ok(statSync(root).isDirectory());
    const entries = readdirSync(root);
    assert.ok(entries.length > 0, 'expected temp work to exist before cleanup');
  });

  if (failures.length > 0) {
    console.error(`\n✗ usage-ledger default-on smoke FAILED (${failures.length} of ${passed + failures.length})`);
  } else {
    console.log(`\n✓ usage-ledger default-on smoke passed (${passed} checks)`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}
