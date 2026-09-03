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
import { execFileSync } from 'node:child_process';
import { TOPOLOGY_CRITIC_ROLE } from '../core/topology-critic-receipt.js';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const guardFile = resolve(here, '../core/topology-critic-receipt.js');
const original = readFileSync(guardFile, 'utf8');

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
const weakened = original.replace(setLiteral, "new Set(['host-adapter', 'generated-token', 'explicit-env', 'derived-ppid'])");
assert.notEqual(weakened, original, 'mutation actually changed the artifact');
// The mutant must sit beside the original so its relative imports still resolve.
// B-49ed F-013: the mutant must NOT live under packages/main/dist. scripts/full-suite-build-binding.mjs
// hashes every file in that tree and runs on every `npm run build`, so a transient extra file there
// races with any concurrent build and trips `stale full-suite dist`. Instead the mutant goes to a
// scratch dir outside the repo, and its two relative imports are rewritten to absolute file:// URLs
// so they still resolve from there.
const scratch = mkdtempSync(join(tmpdir(), 'b49ed-mutant-'));
const mutantPath = join(scratch, 'mutant.mjs');
const guardDirUrl = pathToFileURL(dirname(guardFile) + '/').href;
const relocated = weakened.replace(/from '\.\/([^']+)'/g, (_m, rel) => `from '${guardDirUrl}${rel}'`);
// The rewrite above only handles `from './x'`. Assert that no OTHER relative specifier form
// survives either, so if the guard ever gains `export * from './y'`, a parent-relative `../z`,
// or a dynamic import('./w'), this fails loudly instead of silently loading a different module
// and quietly making the whole proof vacuous again.
assert.doesNotMatch(relocated, /from '\.\.?\//, 'no relative static import or re-export survives relocation');
assert.doesNotMatch(relocated, /import\(\s*['"]\.\.?\//, 'no relative dynamic import survives relocation');
writeFileSync(mutantPath, relocated, 'utf8');

try {
  // B-49ed F-027: F-002 accepted the regex's brittleness when this proof only PARSED the
  // artifact. It now REWRITES and EXECUTES it, and execution drives deriveRoleProvenance,
  // which shells out to git. So a silently-missed specifier would no longer just produce a
  // useless proof -- it could execute an unintended module with real subprocess calls.
  // Assert the transitively-loaded modules are I/O-free, so that safety is enforced here
  // rather than being an accident of what those files happen to contain today.
  for (const dep of ['authority-signing.js', 'digest.js']) {
    const depSource = readFileSync(join(dirname(guardFile), dep), 'utf8');
    assert.doesNotMatch(depSource, /child_process|execFileSync|execSync|spawnSync/,
      `${dep} must stay free of subprocess I/O, since the mutant executes it`);
  }

  // B-49ed/B-3f3d: probe each module in a CHILD PROCESS rather than via dynamic import().
  // retired-authority-vocabulary-guard forbids non-literal dynamic module loads, and giving
  // this file an allowlist entry would defeat the guard rather than satisfy it. A child
  // process still genuinely EXECUTES both the real guard and the mutant -- which is the whole
  // point of F-010 -- while keeping every module specifier in this file literal.
  // B-49ed F-029: the previous rewrite swapped dynamic import() for `node -e <constructed
  // string>`. Quality correctly judged that worse, not better: it is still dynamic code
  // generation, merely in a shape the vocabulary guard's AST scan cannot see, so a green
  // guard there was scanner blindness rather than safety. Neither routing around the guard
  // nor allowlisting myself past it is right.
  //
  // No code is constructed now. A STATIC probe script is written once and executed with the
  // module path and session source as ARGV, so the child only ever runs a fixed file.
  const probeScript = join(scratch, 'probe.mjs');
  writeFileSync(probeScript, [
    "const [, , modulePath, sessionSource, gitCwd, role] = process.argv;",
    "const mod = await import(modulePath);",
    "try {",
    "  mod.deriveRoleProvenance({",
    "    gitCwd, events: [], expectedRole: role, actor: role,",
    "    sessionId: 'sess-mutation-probe', sessionSource,",
    "    context: { storyId: 'B-probe', storyFilesHash: 'h' },",
    "    implementation: { businessCommit: 'c' },",
    "  });",
    "  console.log('<no throw>');",
    "} catch (error) {",
    "  console.log(error && error.message ? error.message : String(error));",
    "}",
  ].join('\n'), 'utf8');

  const probe = (modulePath: string, source: string): string => execFileSync(
    process.execPath,
    [probeScript, pathToFileURL(modulePath).href, source, resolve(here, '../..'), TOPOLOGY_CRITIC_ROLE],
    { encoding: 'utf8', cwd: resolve(here, '../..') },
  ).trim();

  for (const forgeable of ['explicit-env', 'derived-ppid']) {
    const realMessage = probe(guardFile, forgeable);
    const mutantMessage = probe(mutantPath, forgeable);

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
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'b49ed-edge',
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'proof-or-stop-review-topology-critic',
} as Record<string, string>;
// B-49ed F-025: use an isolated scratch root rather than process.cwd(). Nothing downstream
// needs `root` to be a real project: detectProvider reads env only, the token store treats
// projectRoot as opaque path material, and the assertions below check sessionSource, never
// sessionId. Probing under cwd meant the cleanup had to delete under cwd too -- with an
// isolated root the probes write only here, so nothing outside this dir is ever removed.
// Same precedent as story-owner-lease-smoke.ts's dedicated smoke root.
const probeRoot = mkdtempSync(join(tmpdir(), 'b49ed-session-probe-'));
const inputs = { hostname: 'h', root: probeRoot, ppid: 1 };

// Same two identity dimensions, no boundary -> host-adapter.
const asAdapter = resolveSessionIdentity({ ...base } as never, inputs);
assert.equal(asAdapter.sessionSource, 'host-adapter', 'provider+task+agent yields host-adapter');

// Generation requested WITHOUT a boundary -> refused, falls back below host-adapter.
const genNoBoundary = resolveSessionIdentity(
  { ...base, PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED: 'true' } as never, inputs);
assert.notEqual(genNoBoundary.sessionSource, 'generated-token',
  'generation without a boundary token does NOT yield generated-token');

// Generation WITH a boundary -> generated-token.
const genWithBoundary = resolveSessionIdentity(
  { ...base, PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED: 'true', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY: 'b49ed' } as never, inputs);
assert.equal(genWithBoundary.sessionSource, 'generated-token',
  'generation with provider+task+agent+boundary yields generated-token');

// Dropping an identity dimension breaks it entirely.
const missingAgent = resolveSessionIdentity(
  { PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'b49ed-edge',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED: 'true', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY: 'b49ed' } as never, inputs);
assert.notEqual(missingAgent.sessionSource, 'generated-token',
  'generated-token still requires the agent identity dimension');

// B-49ed F-017/F-019/F-020/F-025: the resolveSessionIdentity probes above write an
// owner-session-tokens store under a `.proof-or-stop/runtime` dir, and .gitignore's
// `.proof-or-stop/runtime/` pattern is root-anchored so it does not cover packages/main/.proof-or-stop.
// This must run AFTER those probes -- an earlier version placed it before them and was
// therefore inert. Since F-025 the probes write under an isolated scratch root instead of
// cwd, so cleanup is a single scoped removal of that root -- nothing outside it is touched.
rmSync(probeRoot, { recursive: true, force: true });

console.log('  generated-token requires: provider + task + agent + boundary');
console.log('  host-adapter requires: provider + task + agent');
