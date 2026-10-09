#!/usr/bin/env node
/**
 * Old-PoS run 31 pin oracle (core/pin-oracle.ts), unit level.
 *
 *   A. Example extraction on run 31's own intent descs: an evaluable input
 *      (`"aébcd"[::2]`), never an assignment, a bare literal named in prose
 *      (`s[0]='H' over 'hello' -> 'Hello'`) or a continued expression.
 *   B. A project-declared oracle (a node evaluator committed at the base) runs
 *      in a `git archive` of the Story base, never in the Story worktree: a
 *      Story change to the evaluator does not change what it computes.
 *      Mismatch -> listed with the computed value; baseValue acknowledges it;
 *      an input the base cannot run is skipped; results are cached per base.
 *   C. No declaration -> no oracle, no prompt bytes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePinValue, pinExampleOf, pinOracleMismatches, preparePinOracle, renderPinOracleAudit, pinOracleRefusal } from '../core/pin-oracle.js';
import type { VerificationIntent } from '../core/types.js';

// A. Run 31's descs (B-6f26 CHK-004..CHK-006).
assert.deepEqual(pinExampleOf("rune three-part range 'aébcd'[::2] -> 'abd'"), { input: "'aébcd'[::2]", pinned: "'abd'" });
assert.deepEqual(pinExampleOf('"aébcd"[::2] == "abd"'), { input: '"aébcd"[::2]', pinned: '"abd"' });
assert.deepEqual(pinExampleOf('strs.Upper(s): Upper("ab") -> "AB"'), { input: 'Upper("ab")', pinned: '"AB"' });
assert.deepEqual(pinExampleOf('`[1, 2, 3][1:]` -> `[2, 3]`'), { input: '[1, 2, 3][1:]', pinned: '[2, 3]' });
assert.equal(pinExampleOf("string single-index assignment s[0]='H' over 'hello' -> 'Hello'"), null, 'a bare literal named in prose is no input');
assert.equal(pinExampleOf("s[::2]='ABC' -> 'AeBlC'"), null, 'an assignment needs context');
assert.equal(pinExampleOf('1 + 1 -> 2'), null, 'a continued expression is no standalone input');
assert.equal(pinExampleOf('TestUpper passes'), null);
assert.equal(pinExampleOf('Upper("ab") -> error is reported'), null, 'no concrete value');
assert.equal(normalizePinValue('"abd"'), 'abd');
assert.equal(normalizePinValue("'abd'"), 'abd');
assert.equal(normalizePinValue('[2,  3]'), '[2,3]');

// B. A base repository with a declared oracle.
const root = mkdtempSync(join(tmpdir(), 'pin-oracle-run31-'));
try {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
  mkdirSync(join(root, 'tools'));
  // Base semantics: Upper keeps its input; anything else is unknown to the base.
  writeFileSync(join(root, 'tools/eval.js'), [
    "const src = require('fs').readFileSync(process.argv[2], 'utf8').trim();",
    'const call = src.match(/^Upper\\((".*")\\)$/);',
    "if (!call) { console.error('undefined: ' + src); process.exit(1); }",
    "require('fs').appendFileSync(process.env.EVAL_LOG, src + '\\n');",
    'console.log(JSON.stringify(JSON.parse(call[1])));', ''].join('\n'));
  const log = join(root, '..', `${root.split('/').at(-1)}-eval.log`);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ validate: { env: { EVAL_LOG: log } },
    pinOracle: { command: process.execPath, args: ['tools/eval.js', '{file}'], program: '{input}', extension: '.txt' } }));
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  // The Story changes the evaluator: the oracle must still run the base.
  writeFileSync(join(root, 'tools/eval.js'), "console.log('\"STORY\"');\n");
  git('commit', '-qam', 'story change');

  const oracle = preparePinOracle(root, root, base);
  assert.ok(oracle, 'a declared oracle is prepared');
  assert.ok(existsSync(join(oracle!.tree, 'tools/eval.js')), 'the base tree is materialized');
  const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic' as const, priority: 'must' as const, ...extra });
  const intent: VerificationIntent = {
    happy: [row('Upper("ab") -> "AB"')],
    edge: [row('Upper("AB") -> "ab"'), row('Upper("q") -> "Q"', { baseValue: '"q"' })],
    adversarial: [row('Reverse("héllo") -> "olléh"')],
  };
  const mismatches = pinOracleMismatches(oracle!, [{ id: 'CHK-001', status: 'pending', verificationIntent: intent }]);
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0]!.rows.map(entry => [entry.ref, entry.computed]), [['CHK-001:happy:0', '"ab"'], ['CHK-001:edge:0', '"AB"']],
    'base-computed values differ from the pins; the acknowledged row and the new function are not listed');
  const refusal = pinOracleRefusal('checklist_update', 'B-0001', 'CHK-001', oracle!, mismatches[0]!.rows) ?? '';
  assert.match(refusal, /\[pin_oracle_mismatch\]/);
  assert.match(refusal, /CHK-001:edge:0: Upper\("AB"\) -> the Story base computes "AB", the row pins "ab"/);
  assert.match(refusal, /^Next: proof-or-stop checklist_update /m);
  const evaluated = execFileSync('cat', [log], { encoding: 'utf8' }).trim().split('\n');
  pinOracleMismatches(oracle!, [{ id: 'CHK-001', status: 'pending', verificationIntent: intent }]);
  assert.deepEqual(execFileSync('cat', [log], { encoding: 'utf8' }).trim().split('\n'), evaluated, 'results are cached per base');
  assert.match(renderPinOracleAudit(oracle).join('\n'), /Pin oracle \(project-declared, Story base [0-9a-f]{12}\)/);
  rmSync(log, { force: true });

  // C. No declaration at the base: nothing runs, no prompt bytes.
  writeFileSync(join(root, 'proof-or-stop.config.json'), '{}');
  git('commit', '-qam', 'no oracle');
  assert.equal(preparePinOracle(root, root, git('rev-parse', 'HEAD')), null);
  assert.deepEqual(renderPinOracleAudit(null), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('pin-oracle-run31-smoke: PASS');
