#!/usr/bin/env node
/**
 * RED artifact (W2b / B-e10d, CHK-005 + CHK-006 + CHK-007 + CHK-008).
 *
 * Repro-first RED: this file is written and committed BEFORE
 * red_evidence_binding_set is registered at its 13 wiring points. At that point
 * the assertions below FAIL (the command is absent from MAIN_TOOLS, has no
 * command-policy entry, no process-fact level, no mutation authority, and
 * red-target-bindings.json does not classify as lifecycle metadata) — that is
 * the RED evidence.
 *
 * It runs the THREE pre-existing mechanical contracts that predate this story —
 * lifecycle-registry-contract, command-ownership-contract, and
 * verify-process-fact-contract — which enumerate the registries bidirectionally
 * and fail with named divergences the moment MAIN_TOOLS / command-policy declare
 * a command that is not completely wired. Together with the direct wiring
 * assertions, these are the un-gameable RED signal B: they pass only when every
 * registration point is present.
 *
 * Assurance scope (§0.6 practical tier): mechanical registry consistency through
 * the registered surfaces; not a defense against a hostile local agent.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const DIST = join(pkgRoot, 'dist');

const COMMAND = 'red_evidence_binding_set';
const ARTIFACT = 'red-target-bindings.json';

const { MAIN_TOOLS } = await import(`${DIST}/cli-engine.js`);
const { getCommandPolicy } = await import(`${DIST}/core/command-policy.js`);
const { PROCESS_FACT_LEVELS } = await import(`${DIST}/core/process-fact-levels.js`);
const { classifyLifecycleArtifact, PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES } = await import(`${DIST}/core/lifecycle-registry.js`);
const {
  AGENT_DISPATCH_REGISTRY,
  entryPermitsMutation,
  resolveAgentMutationAuthority,
} = await import(`${DIST}/core/agent-dispatch-registry.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { StoryStore } = await import(`${DIST}/core/store.js`);

// ── Point 1+2: MAIN_TOOLS (dispatchability + catalog) ────────────────────────
const toolNames = MAIN_TOOLS.map((t) => t.name);
assert.ok(toolNames.includes(COMMAND), `${COMMAND} must be declared in MAIN_TOOLS (cli/command-catalog.ts)`);

// ── Point: registered handler in createMainRegistry ──────────────────────────
{
  const root = join(repoRoot, 'packages', 'main');
  const store = new StoryStore(join(process.env.TMPDIR || '/tmp', `red-w2b-reg-${process.pid}`));
  const registry = createMainRegistry({ store, root, scanRoot: root });
  assert.ok(registry.has(COMMAND), `${COMMAND} must have a registered handler in createMainRegistry (registry.ts)`);
}

// ── Point 3: command-policy (owner-lease ownership class) ────────────────────
const policy = getCommandPolicy(COMMAND);
assert.ok(policy, `${COMMAND} must have a CommandPolicy entry (core/command-policy.ts)`);
assert.equal(policy.ownershipClass, 'storyScopedMutating',
  `${COMMAND} must be storyScopedMutating so it flows through the owner-lease choke point (§4.1)`);

// ── Point 5: process-fact-levels ─────────────────────────────────────────────
assert.ok(PROCESS_FACT_LEVELS.some((e) => e.name === COMMAND),
  `${COMMAND} must have a PROCESS_FACT_LEVELS entry (core/process-fact-levels.ts)`);

// ── Point 8 (closed union) + permittedMutations + resolveAgentMutationAuthority ─
const implementer = AGENT_DISPATCH_REGISTRY.find((e) => e.canonicalName === 'proof-or-stop-implementer');
assert.ok(implementer, 'proof-or-stop-implementer registry entry must exist');
assert.ok(entryPermitsMutation(implementer, COMMAND),
  `${COMMAND} must be in at least the proof-or-stop-implementer permittedMutations (agent-dispatch-registry.ts)`);
// The owner role resolves mutation authority for the command.
assert.doesNotThrow(
  () => resolveAgentMutationAuthority({ command: COMMAND, envActor: 'proof-or-stop-implementer' }),
  `resolveAgentMutationAuthority must accept ${COMMAND} for the implementer role`,
);
// A role WITHOUT the mutation is rejected (proves the gate is live, not a declaration).
assert.throws(
  () => resolveAgentMutationAuthority({ command: COMMAND, envActor: 'verification-intent' }),
  `resolveAgentMutationAuthority must REJECT ${COMMAND} for a role lacking the authority`,
);

// ── Point 9: lifecycle artifact classification (RED signal A) ────────────────
assert.ok(PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES.has(ARTIFACT),
  `${ARTIFACT} must be in PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES (core/lifecycle-registry.ts)`);
const classified = classifyLifecycleArtifact(`.proof-or-stop/story/actives/B-e10d/${ARTIFACT}`);
assert.ok(classified && classified.kind === 'lifecycle',
  `${ARTIFACT} under an active story dir must classify as kind='lifecycle' (closes RED signal A)`);
// Exact-match registration (adversarial): a lookalike must NOT classify.
const lookalike = classifyLifecycleArtifact(`.proof-or-stop/story/actives/B-e10d/red-target-bindings-extra.json`);
assert.ok(!lookalike || lookalike.kind !== 'lifecycle',
  'registration is exact-match — red-target-bindings-extra.json must not classify as lifecycle');

// ── The three pre-existing mechanical contracts must all PASS (RED signal B) ─
function runContract(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0,
    `${label} must pass with ${COMMAND} fully wired (exit 0); got status=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
}
const canonicalCore = process.argv.includes('--canonical-core');
if (!canonicalCore) {
  runContract('lifecycle-registry-contract', 'node', [join(DIST, 'tasks', 'lifecycle-registry-contract.js')]);
  runContract('command-ownership-contract', 'node', [join(DIST, 'tasks', 'command-ownership-contract.js')]);
}
runContract('verify-process-fact-contract', 'node', [join(repoRoot, 'scripts', 'verify-process-fact-contract.mjs')]);

// ── ADVERSARIAL (CHK-006:adversarial:0 + CHK-008:adversarial:0): remove ONE ──
// registration point → NAMED divergence.
//
// The coarse whole-module-absent RED (the file-header repro) only proves the
// contracts fail when target-bindings.ts does not exist at all. The specific
// claim these adversarial intents make is stronger and un-gameable: removing a
// SINGLE registration point — the command-policy.ts entry for
// red_evidence_binding_set — makes each of the three mechanical contracts fail
// with a divergence that NAMES the command, not a generic message. This section
// reproduces that, non-destructively (the working tree is NEVER modified):
//   • the two dist contracts (command-ownership / lifecycle-registry) IMPORT the
//     compiled command-policy.js, so they run under an ESM loader that returns a
//     patched command-policy.js — the red_evidence_binding_set entry stripped —
//     for that ONE module while every other module loads unchanged;
//   • verify-process-fact-contract reads command-policy.ts SOURCE TEXT, so it
//     uses the verifier's existing input-mutation seam on its real source read.
//     The same repository/build and all other inputs remain unchanged.
// Each contract must exit non-zero AND name red_evidence_binding_set. The parent
// pre-verifies that the strip actually changed each file, so a broken mechanism
// (entry not found, loader not applied) fails loudly rather than passing vacuously.

/** Remove the single-line command-policy entry `red_evidence_binding_set: {...},`. */
const REMOVE_ENTRY_RE = /^[^\n]*\bred_evidence_binding_set:[^\n]*\n/m;
function stripBindingEntry(source, label) {
  const stripped = source.replace(REMOVE_ENTRY_RE, '');
  assert.notEqual(stripped, source,
    `${label}: expected to find and remove the red_evidence_binding_set registration line (mechanism precondition)`);
  assert.ok(!/\bred_evidence_binding_set:/.test(stripped),
    `${label}: exactly one red_evidence_binding_set registration line must remain after removal`);
  return stripped;
}

const scratchDirs = [];
function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `red-w2b-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

try {
  // (a) The two DIST contracts, under an ESM loader that strips the entry from
  // the compiled command-policy.js at load time.
  const compiledPolicyPath = join(DIST, 'core', 'command-policy.js');
  const patchedCompiled = stripBindingEntry(readFileSync(compiledPolicyPath, 'utf8'), 'dist/core/command-policy.js');
  const loaderDir = scratch('loader');
  const patchedCompiledPath = join(loaderDir, 'command-policy.patched.js');
  writeFileSync(patchedCompiledPath, patchedCompiled);
  // patch-loader substitutes the patched source for the compiled command-policy
  // module ONLY; the module url is preserved so its relative imports still
  // resolve against the real dist tree.
  writeFileSync(join(loaderDir, 'patch-loader.mjs'), [
    `import { readFileSync } from 'node:fs';`,
    `const PATCHED = readFileSync(process.env.RED_W2B_PATCHED_POLICY, 'utf8');`,
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

  function assertContractNamesDivergence(label, cmd, args, needle) {
    const r = spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, RED_W2B_PATCHED_POLICY: patchedCompiledPath },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0,
      `${label} must FAIL (non-zero) when the red_evidence_binding_set command-policy entry is removed; got status=${r.status}\n${out}`);
    assert.ok(out.includes('red_evidence_binding_set'),
      `${label} divergence must NAME red_evidence_binding_set (not a generic message)\n${out}`);
    assert.ok(needle.test(out),
      `${label} must report the specific missing-registration divergence for red_evidence_binding_set\n${out}`);
  }

  assertContractNamesDivergence(
    'command-ownership-contract (entry removed)',
    'node',
    ['--import', registerPath, join(DIST, 'tasks', 'command-ownership-contract.js')],
    /red_evidence_binding_set["\s].*has no CommandPolicy entry|has no CommandPolicy entry[\s\S]*red_evidence_binding_set/,
  );
  assertContractNamesDivergence(
    'lifecycle-registry-contract (entry removed)',
    'node',
    ['--import', registerPath, join(DIST, 'tasks', 'lifecycle-registry-contract.js')],
    /process-fact lifecycle entry red_evidence_binding_set[\s\S]*has no command-policy entry/,
  );

  // (b) Remove the actual source registration through the verifier input seam.
  // The source precondition and the named divergence exclude a no-op mutation;
  // the full positive invocation above still exercises all real child proofs.
  const realPolicyTs = join(repoRoot, 'packages', 'main', 'src', 'core', 'command-policy.ts');
  stripBindingEntry(readFileSync(realPolicyTs, 'utf8'), 'src/core/command-policy.ts');
  {
    const r = spawnSync('node', [join(repoRoot, 'scripts', 'verify-process-fact-contract.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: 'drop-red-evidence-binding-policy' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0,
      `verify-process-fact-contract (entry removed) must FAIL (non-zero); got status=${r.status}\n${out}`);
    assert.ok(/MAIN_TOOLS command\(s\) missing lifecycle policy: [^\n]*red_evidence_binding_set/.test(out),
      `verify-process-fact-contract must report the specific "missing lifecycle policy: red_evidence_binding_set" divergence\n${out}`);
  }
} finally {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
}

console.log('red-w2b-wiring-contract: OK (13 wiring points present; ' + (canonicalCore
  ? 'canonical core and process-fact contract pass; registry contracts scheduled independently; '
  : 'lifecycle-registry / command-ownership / verify-process-fact contracts all pass; ') + 'and removing the ONE command-policy.ts registration point makes all three fail with a divergence naming red_evidence_binding_set — working tree untouched)');
