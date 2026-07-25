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

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const DIST = join(pkgRoot, 'dist');

const COMMAND = 'red_evidence_binding_set';
const ARTIFACT = 'red-target-bindings.json';

const { MAIN_TOOLS } = await import(`${DIST}/cli-engine.js`);
const { getCommandPolicy } = await import(`${DIST}/core/command-policy.js`);
const { PROCESS_FACT_LEVELS } = await import(`${DIST}/core/process-fact-levels.js`);
const { classifyLifecycleArtifact, LATTICE_LIFECYCLE_ARTIFACT_FILENAMES } = await import(`${DIST}/core/lifecycle-registry.js`);
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
const implementer = AGENT_DISPATCH_REGISTRY.find((e) => e.canonicalName === 'lattice-implementer');
assert.ok(implementer, 'lattice-implementer registry entry must exist');
assert.ok(entryPermitsMutation(implementer, COMMAND),
  `${COMMAND} must be in at least the lattice-implementer permittedMutations (agent-dispatch-registry.ts)`);
// The owner role resolves mutation authority for the command.
assert.doesNotThrow(
  () => resolveAgentMutationAuthority({ command: COMMAND, envActor: 'lattice-implementer' }),
  `resolveAgentMutationAuthority must accept ${COMMAND} for the implementer role`,
);
// A role WITHOUT the mutation is rejected (proves the gate is live, not a declaration).
assert.throws(
  () => resolveAgentMutationAuthority({ command: COMMAND, envActor: 'verification-intent' }),
  `resolveAgentMutationAuthority must REJECT ${COMMAND} for a role lacking the authority`,
);

// ── Point 9: lifecycle artifact classification (RED signal A) ────────────────
assert.ok(LATTICE_LIFECYCLE_ARTIFACT_FILENAMES.has(ARTIFACT),
  `${ARTIFACT} must be in LATTICE_LIFECYCLE_ARTIFACT_FILENAMES (core/lifecycle-registry.ts)`);
const classified = classifyLifecycleArtifact(`.lattice/story/actives/B-e10d/${ARTIFACT}`);
assert.ok(classified && classified.kind === 'lifecycle',
  `${ARTIFACT} under an active story dir must classify as kind='lifecycle' (closes RED signal A)`);
// Exact-match registration (adversarial): a lookalike must NOT classify.
const lookalike = classifyLifecycleArtifact(`.lattice/story/actives/B-e10d/red-target-bindings-extra.json`);
assert.ok(!lookalike || lookalike.kind !== 'lifecycle',
  'registration is exact-match — red-target-bindings-extra.json must not classify as lifecycle');

// ── The three pre-existing mechanical contracts must all PASS (RED signal B) ─
function runContract(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0,
    `${label} must pass with ${COMMAND} fully wired (exit 0); got status=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
}
runContract('lifecycle-registry-contract', 'node', [join(DIST, 'tasks', 'lifecycle-registry-contract.js')]);
runContract('command-ownership-contract', 'node', [join(DIST, 'tasks', 'command-ownership-contract.js')]);
runContract('verify-process-fact-contract', 'node', [join(repoRoot, 'scripts', 'verify-process-fact-contract.mjs')]);

console.log('red-w2b-wiring-contract: OK (13 wiring points present; lifecycle-registry / command-ownership / verify-process-fact contracts all pass)');
