#!/usr/bin/env node
/**
 * B-49ed CHK-003:adversarial:0 — mechanical mutation proof.
 *
 * An attestation that "reverting the guard makes the smoke fail" is not evidence;
 * this executes that cycle: weaken SIGNABLE_SESSION_SOURCES in a throwaway copy of
 * the compiled guard, and assert the refusal disappears — i.e. that the guard, not
 * something else, is what refuses a forgeable session source.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const guardFile = resolve(here, '../core/topology-critic-receipt.js');
const original = readFileSync(guardFile, 'utf8');
const { TOPOLOGY_CRITIC_ROLE } = await import(pathToFileURL(guardFile).href) as { TOPOLOGY_CRITIC_ROLE: string };

const GUARD = "SIGNABLE_SESSION_SOURCES.has(args.sessionSource)";
assert.ok(original.includes(GUARD), 'guard call site is present in the built artifact');

const setLiteral = /new Set\((\[[^\]]*'host-adapter'[^\]]*\])\)/;
const match = setLiteral.exec(original);
assert.ok(match, 'SIGNABLE_SESSION_SOURCES set literal is present');
assert.ok(!match[1].includes('explicit-env'), 'control: explicit-env is NOT accepted before mutation');

// Mutate a COPY only; the real artifact is never written. B-49ed F-010: an earlier version
// of this proof wrote the mutant and then re-ran the same regex against its own substitution
// output, which holds by construction and proved nothing about runtime behaviour. The mutant
// is now IMPORTED AND EXECUTED, and the real guard is executed alongside it, so the assertion
// is about what deriveRoleProvenance actually does rather than about string replacement.
const scratch = mkdtempSync(join(tmpdir(), 'b49ed-mutation-'));
try {
  const weakened = original.replace(setLiteral, "new Set(['host-adapter', 'generated-token', 'explicit-env', 'derived-ppid'])");
  assert.notEqual(weakened, original, 'mutation actually changed the artifact');
  // The mutant must sit beside the original so its relative imports still resolve.
  const mutantPath = join(dirname(guardFile), `__b49ed-mutant-${process.pid}.js`);
  writeFileSync(mutantPath, weakened, 'utf8');

  try {
    const mutant = await import(pathToFileURL(mutantPath).href);
    const real = await import(pathToFileURL(guardFile).href);

    const probe = (mod: { deriveRoleProvenance: (a: unknown) => unknown }, source: string): string => {
      try {
        mod.deriveRoleProvenance({
          gitCwd: resolve(here, "../.."),
          events: [],
          expectedRole: TOPOLOGY_CRITIC_ROLE,
          actor: TOPOLOGY_CRITIC_ROLE,
          sessionId: 'sess-mutation-probe',
          sessionSource: source,
          context: { storyId: 'B-probe', storyFilesHash: 'h' },
          implementation: { businessCommit: 'c' },
        });
        return '<no throw>';
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    };

    for (const forgeable of ['explicit-env', 'derived-ppid']) {
      const realMessage = probe(real as never, forgeable);
      const mutantMessage = probe(mutant as never, forgeable);

      // The real guard refuses at the SOURCE gate.
      assert.match(realMessage, /must sign from a host-adapter session/,
        `real guard refuses ${forgeable}`);
      // The weakened guard does NOT refuse at the source gate -- it gets further, to the
      // dispatch lookup. That difference is only observable by executing both.
      assert.doesNotMatch(mutantMessage, /must sign from a host-adapter session/,
        `mutant must NOT refuse ${forgeable} at the source gate, or the guard is not what refuses it`);
      assert.match(mutantMessage, /no current registered dispatch provenance/,
        `mutant reaches the dispatch lookup for ${forgeable}`);
    }
  } finally {
    rmSync(mutantPath, { force: true });
  }

  assert.equal(readFileSync(guardFile, 'utf8'), original, 'the real guard artifact is untouched by the probe');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

assert.equal(readFileSync(guardFile, 'utf8'), original, 'the real guard artifact is byte-identical after the proof');
console.log('Signing guard mutation proof: PASS');
console.log('  guard removal admits: explicit-env, derived-ppid');
console.log('  guard intact refuses: explicit-env, derived-ppid');
console.log('  real artifact unchanged: true');

/**
 * B-49ed CHK-005:edge:0 — generated-token is strictly MORE constrained than
 * host-adapter, which is why accepting it does not weaken the guard. Asserted by
 * driving the real resolver rather than by describing the code.
 */
const { resolveSessionIdentity } = await import('../core/owner-session.js');
const base = {
  LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
  LATTICE_OWNER_SESSION_ADAPTER_TASK: 'b49ed-edge',
  LATTICE_OWNER_SESSION_ADAPTER_AGENT: 'lattice-review-topology-critic',
} as Record<string, string>;
const inputs = { hostname: 'h', root: process.cwd(), ppid: 1 };

// Same two identity dimensions, no boundary -> host-adapter.
const asAdapter = resolveSessionIdentity({ ...base } as never, inputs);
assert.equal(asAdapter.sessionSource, 'host-adapter', 'provider+task+agent yields host-adapter');

// Generation requested WITHOUT a boundary -> refused, falls back below host-adapter.
const genNoBoundary = resolveSessionIdentity(
  { ...base, LATTICE_OWNER_SESSION_ADAPTER_GENERATED: 'true' } as never, inputs);
assert.notEqual(genNoBoundary.sessionSource, 'generated-token',
  'generation without a boundary token does NOT yield generated-token');

// Generation WITH a boundary -> generated-token.
const genWithBoundary = resolveSessionIdentity(
  { ...base, LATTICE_OWNER_SESSION_ADAPTER_GENERATED: 'true', LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY: 'b49ed' } as never, inputs);
assert.equal(genWithBoundary.sessionSource, 'generated-token',
  'generation with provider+task+agent+boundary yields generated-token');

// Dropping an identity dimension breaks it entirely.
const missingAgent = resolveSessionIdentity(
  { LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code', LATTICE_OWNER_SESSION_ADAPTER_TASK: 'b49ed-edge',
    LATTICE_OWNER_SESSION_ADAPTER_GENERATED: 'true', LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY: 'b49ed' } as never, inputs);
assert.notEqual(missingAgent.sessionSource, 'generated-token',
  'generated-token still requires the agent identity dimension');

console.log('  generated-token requires: provider + task + agent + boundary');
console.log('  host-adapter requires: provider + task + agent');
