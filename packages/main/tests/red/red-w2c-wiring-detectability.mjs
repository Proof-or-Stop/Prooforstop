#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, CHK-011:adversarial:1).
 *
 * Committed detectability proof: de-registration of a command is DETECTED by the
 * mechanical wiring contracts with a NAMED divergence — it is not left to manual
 * inspection or an unaudited validate run. This mirrors the adversarial section
 * of red-w2b-wiring-contract.mjs but targets the TWO commands this story lands:
 * red_evidence_quarantine and red_evidence_recover.
 *
 * Mechanism (NON-destructive — the real registries are NEVER edited): the two
 * compiled contracts (command-ownership-contract, lifecycle-registry-contract)
 * IMPORT the compiled command-policy.js, so they run under an ESM `--import`
 * loader that returns a PATCHED command-policy.js — the ONE target entry stripped
 * — for that single module, while every other module loads unchanged from the
 * real dist tree. Removing a single registration point must make each contract
 * exit non-zero AND name the de-registered command, proving the regression is
 * caught by a committed test rather than by inspection.
 *
 * A green baseline run first proves the assertion is non-vacuous (both contracts
 * pass with every command fully wired), and each strip is pre-verified to have
 * actually changed the compiled source so a broken mechanism fails loudly rather
 * than passing vacuously.
 *
 * Assurance scope (§0.6 practical tier): mechanical registry consistency through
 * the registered surfaces; not a defense against a hostile local agent.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const DIST = join(pkgRoot, 'dist');

const OWNERSHIP_CONTRACT = join(DIST, 'tasks', 'command-ownership-contract.js');
const LIFECYCLE_CONTRACT = join(DIST, 'tasks', 'lifecycle-registry-contract.js');
const COMPILED_POLICY = join(DIST, 'core', 'command-policy.js');

const TARGET_COMMANDS = ['red_evidence_quarantine', 'red_evidence_recover'];

// ── Green baseline: with everything wired both contracts PASS (non-vacuous). ──
for (const [label, contract] of [
  ['command-ownership-contract', OWNERSHIP_CONTRACT],
  ['lifecycle-registry-contract', LIFECYCLE_CONTRACT],
]) {
  const r = spawnSync('node', [contract], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0,
    `${label} must PASS at baseline with every command wired (exit 0); got status=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
}

/** Remove the single-line command-policy entry `<command>: {...},` from `source`. */
function stripEntry(source, command, label) {
  const re = new RegExp(`^[^\\n]*\\b${command}:[^\\n]*\\n`, 'm');
  const stripped = source.replace(re, '');
  assert.notEqual(stripped, source,
    `${label}: expected to find and remove the ${command} registration line (mechanism precondition)`);
  assert.ok(!new RegExp(`\\b${command}:`).test(stripped),
    `${label}: exactly one ${command} registration line must remain after removal (i.e. none)`);
  return stripped;
}

const scratchDirs = [];
function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `red-w2c-detect-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

try {
  const realCompiledPolicy = readFileSync(COMPILED_POLICY, 'utf8');

  // A patch-loader that substitutes the patched command-policy.js source for the
  // ONE compiled command-policy module; the module url is preserved so its
  // relative imports still resolve against the real dist tree.
  const loaderDir = scratch('loader');
  writeFileSync(join(loaderDir, 'patch-loader.mjs'), [
    `import { readFileSync } from 'node:fs';`,
    `const PATCHED = readFileSync(process.env.RED_W2C_PATCHED_POLICY, 'utf8');`,
    `export async function load(url, context, nextLoad) {`,
    `  if (url.endsWith('/core/command-policy.js')) {`,
    `    return { format: 'module', source: PATCHED, shortCircuit: true };`,
    `  }`,
    `  return nextLoad(url, context);`,
    `}`,
    ``,
  ].join('\n'));
  const registerPath = join(loaderDir, 'register-loader.mjs');
  writeFileSync(registerPath, [
    `import { register } from 'node:module';`,
    `register('./patch-loader.mjs', import.meta.url);`,
    ``,
  ].join('\n'));

  function assertContractNamesDivergence(label, contract, command, patchedPolicyPath, needle) {
    const r = spawnSync('node', ['--import', registerPath, contract], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, RED_W2C_PATCHED_POLICY: patchedPolicyPath },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0,
      `${label} must FAIL (non-zero) when the ${command} command-policy entry is removed; got status=${r.status}\n${out}`);
    assert.ok(out.includes(command),
      `${label} divergence must NAME ${command} (not a generic message)\n${out}`);
    assert.ok(needle.test(out),
      `${label} must report the specific missing-registration divergence for ${command}\n${out}`);
  }

  for (const command of TARGET_COMMANDS) {
    const patched = stripEntry(realCompiledPolicy, command, `dist/core/command-policy.js (${command})`);
    const patchedPath = join(scratch(command), 'command-policy.patched.js');
    writeFileSync(patchedPath, patched);

    // command-ownership-contract: a MAIN_TOOLS command with no CommandPolicy
    // entry is a named divergence.
    assertContractNamesDivergence(
      `command-ownership-contract (${command} entry removed)`,
      OWNERSHIP_CONTRACT,
      command,
      patchedPath,
      new RegExp(`${command}["\\s][\\s\\S]*has no CommandPolicy entry|has no CommandPolicy entry[\\s\\S]*${command}`),
    );

    // lifecycle-registry-contract: the process-fact lifecycle entry now has no
    // command-policy entry — a named divergence.
    assertContractNamesDivergence(
      `lifecycle-registry-contract (${command} entry removed)`,
      LIFECYCLE_CONTRACT,
      command,
      patchedPath,
      new RegExp(`process-fact lifecycle entry ${command}[\\s\\S]*has no command-policy entry`),
    );
  }
} finally {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
}

console.log(
  'red-w2c-wiring-detectability: OK (baseline command-ownership / lifecycle-registry contracts pass; removing the ONE command-policy registration point for red_evidence_quarantine or red_evidence_recover makes BOTH contracts fail with a divergence naming the de-registered command — de-registration is detectable, working tree untouched)',
);
