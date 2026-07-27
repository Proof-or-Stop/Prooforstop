#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, CHK-011:adversarial:1) — de-registering a critical
 * smoke from `lattice.config.json` `validate.commands` is caught by a COMMITTED
 * test.
 *
 * The intent's literal scenario: "Remove the chain-smoke from validate.commands
 * -> lattice validate no longer runs it; the regression must be caught by a
 * committed test or the validate output audit." Before this test NOTHING in the
 * repo scanned `validate.commands` for completeness, so deleting the
 * `red-evidence-chain-smoke.js` registration line silently stopped the
 * convergence anchor from ever running under `lattice validate` — a green
 * validate would then prove nothing about the red-evidence chain. That silent
 * de-registration IS the RED signal.
 *
 * This is a registration-COMPLETENESS check: every required red-evidence smoke
 * must be registered in `validate.commands`, and every registered
 * `packages/main/dist/tasks/*.js` entry must have its committed TypeScript source
 * (so a typo'd or dangling path is caught too).
 *
 * Non-vacuity is proven mechanically: the SAME detector is re-run over an
 * in-memory copy of the real config with each required entry stripped, and must
 * report that exact command as missing.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const CONFIG_PATH = join(repoRoot, 'lattice.config.json');

/**
 * The smokes that MUST stay wired into `lattice validate`. `red-evidence-chain-
 * smoke` is the W2c convergence anchor (v2 union, enforce-gate byte-identical v1
 * guard, chain integrity, transition table, operation key, append/dedupe, the
 * rejection matrix, binding-freeze, and the 2-process race).
 */
const REQUIRED_VALIDATE_COMMANDS = [
  'packages/main/dist/tasks/red-evidence-chain-smoke.js',
  'packages/main/dist/tasks/red-evidence-policy-canon-smoke.js',
  'packages/main/dist/tasks/red-evidence-target-binding-smoke.js',
];

/** Normalize a validate.commands entry (bare string OR {command,args}) to its argv. */
function entryArgv(entry) {
  if (typeof entry === 'string') return entry.trim().split(/\s+/);
  if (entry && typeof entry === 'object') return [entry.command, ...(entry.args ?? [])].map(String);
  return [];
}

/**
 * THE DETECTOR (run over the real config AND over each mutated copy): returns the
 * required commands that are NOT registered in `validate.commands`.
 */
function missingRegistrations(config, required) {
  const registered = new Set();
  for (const entry of config?.validate?.commands ?? []) {
    for (const token of entryArgv(entry)) registered.add(token);
  }
  return required.filter((script) => !registered.has(script));
}

const raw = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(raw);

assert.ok(Array.isArray(config?.validate?.commands) && config.validate.commands.length > 0,
  'lattice.config.json must declare a non-empty validate.commands array');

// ── 1. The real config registers every required smoke. ──────────────────────
const missing = missingRegistrations(config, REQUIRED_VALIDATE_COMMANDS);
assert.deepEqual(missing, [],
  `these smokes are NOT registered in lattice.config.json validate.commands, so \`lattice validate\` would not run them: ${missing.join(', ')}`);

// ── 2. NON-VACUITY: strip each required entry from an in-memory copy and prove
//       the SAME detector names it as missing (the check cannot pass vacuously). ──
for (const script of REQUIRED_VALIDATE_COMMANDS) {
  const mutated = JSON.parse(raw);
  const beforeLen = mutated.validate.commands.length;
  mutated.validate.commands = mutated.validate.commands.filter(
    (entry) => !entryArgv(entry).includes(script),
  );
  assert.ok(mutated.validate.commands.length < beforeLen,
    `mechanism precondition: the ${script} registration entry must be findable and removable`);
  const detected = missingRegistrations(mutated, REQUIRED_VALIDATE_COMMANDS);
  assert.ok(detected.includes(script),
    `de-registering ${script} MUST be detected by this committed test (got missing=[${detected.join(', ')}])`);
}

// ── 3. Every registered dist task entry has its committed TypeScript source, so
//       a typo'd / dangling registration path is caught as well. ──────────────
const danglingSources = [];
for (const entry of config.validate.commands) {
  for (const token of entryArgv(entry)) {
    const m = /^packages\/main\/dist\/(.+)\.js$/.exec(token);
    if (!m) continue;
    if (!existsSync(join(pkgRoot, 'src', `${m[1]}.ts`))) danglingSources.push(token);
  }
}
assert.deepEqual(danglingSources, [],
  `these validate.commands entries have no committed packages/main/src/**.ts source (typo'd or dangling registration): ${danglingSources.join(', ')}`);

console.log(
  `red-w2c-validate-registration: OK (lattice.config.json validate.commands registers all ${REQUIRED_VALIDATE_COMMANDS.length} required red-evidence smokes including red-evidence-chain-smoke.js; stripping ANY of them is detected by this committed test — proven non-vacuous per entry; every registered dist task entry has its committed TypeScript source)`,
);
