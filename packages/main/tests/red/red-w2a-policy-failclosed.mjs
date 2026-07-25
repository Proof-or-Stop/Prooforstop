#!/usr/bin/env node
/**
 * RED artifact (W2a / B-c054, CHK-003..CHK-006, CHK-010).
 *
 * Repro-first RED: committed BEFORE packages/main/src/core/red-evidence/policy.ts
 * exists. Until then the import of ../../dist/core/red-evidence/policy.js fails
 * and the process exits non-zero — that is the RED evidence that the §1.2 policy
 * resolver + §1.12 fail-closed floors are unimplemented. After implementation +
 * build, every assertion below holds (GREEN).
 *
 * Pins:
 *   - the FROZEN default policyDigest (pinnedPath=["/usr/bin"]) so two conforming
 *     implementations must resolve identical default snapshots (catches a CANON
 *     substitution or a mis-transcribed default);
 *   - the §1.12 clamp-REJECT matrix — every hard floor rejects fail-closed with a
 *     DISTINCT named diagnostic, never silently clamps;
 *   - the exact `red_evidence_policy_missing: pinnedPath` diagnostic;
 *   - the forbidden-env-key / bare-catch-all / material-overlap / unresolvable
 *     argv-placeholder config-load rejections, proving BOTH directions.
 *
 * Assurance scope (§0.6 practical tier): fail-closed config-load rejection guards
 * against accidental mis-policy and casual gaming, not a hostile local agent.
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;
const { resolveRedEvidencePolicy } = await import(`${DIST}/core/red-evidence/policy.js`);

const FROZEN_DEFAULT_DIGEST =
  'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767';

const ok = (r) => { assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`); return r; };
const rejected = (r) => { assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`); return r; };
const codes = (r) => r.diagnostics.map((d) => d.code);
const messages = (r) => r.diagnostics.map((d) => d.message);
const base = (extra = {}) => ({ pinnedPath: ['/usr/bin'], ...extra });

// ── Frozen default snapshot + digest ─────────────────────────────────────────
{
  const r = ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] }));
  assert.equal(r.policyDigest, FROZEN_DEFAULT_DIGEST,
    'default policyDigest must reproduce the frozen literal EXACTLY (CANON + spec defaults)');
  assert.equal(Object.keys(r.snapshot).length, 14, 'policySnapshot has EXACTLY 14 keys');
  const nonzero = r.snapshot.matcherClassRegistry.find((c) => c.name === 'nonzero-exit');
  assert.equal(nonzero.param.length, 255, 'nonzero-exit param is the fully enumerated 1..255 array');
  assert.equal(nonzero.param[0], 1);
  assert.equal(nonzero.param[254], 255);
}

// A user override changes the digest (proves it is not a hard-coded constant).
{
  const r = ok(resolveRedEvidencePolicy(base({ maxMatchers: 4 })));
  assert.equal(r.snapshot.maxMatchers, 4);
  assert.notEqual(r.policyDigest, FROZEN_DEFAULT_DIGEST, 'a valid override MUST change the digest');
}

// ── pinnedPath required-no-default, exact diagnostic ─────────────────────────
{
  const r = rejected(resolveRedEvidencePolicy({}));
  assert.ok(messages(r).includes('red_evidence_policy_missing: pinnedPath'),
    'missing pinnedPath rejects with the EXACT spec diagnostic string');
}
rejected(resolveRedEvidencePolicy({ pinnedPath: null }));
rejected(resolveRedEvidencePolicy({ pinnedPath: [] }));
rejected(resolveRedEvidencePolicy({ pinnedPath: ['relative/path'] }));
rejected(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin', 'relative'] }));
rejected(resolveRedEvidencePolicy({ pinnedPath: ['./usr/bin'] }));
rejected(resolveRedEvidencePolicy({ pinnedPath: [''] }));
ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/local/bin'] }));

// ── §1.12 clamp-REJECT floors, each a DISTINCT named diagnostic ──────────────
const floorCases = [
  ['minMatcherLen', 3], ['minMatcherLen', 0],
  ['minMatcherEntropyBits', 11],
  ['maxMatchers', 33],
  ['maxMatcherLen', 4097],
  ['runTimeoutMs', 3600001],
  ['prepTimeoutMs', 3600001],
];
const seenFloorCodes = new Set();
for (const [key, value] of floorCases) {
  const r = rejected(resolveRedEvidencePolicy(base({ [key]: value })));
  const named = r.diagnostics.find((d) => d.message.includes(key));
  assert.ok(named, `floor violation for ${key}=${value} must name ${key} in its diagnostic`);
  seenFloorCodes.add(named.code);
}
assert.equal(seenFloorCodes.size, 6,
  'the six distinct floor keys produce six distinct diagnostic codes (never a shared string)');

// silent clamping is forbidden: minMatcherLen:3 yields NO snapshot, not {minMatcherLen:4}
{
  const r = rejected(resolveRedEvidencePolicy(base({ minMatcherLen: 3 })));
  assert.equal(r.snapshot, undefined, 'a floor violation produces NO snapshot (never a silently-clamped one)');
}
// both timeouts over ceiling → BOTH reported, not short-circuited at the first
{
  const r = rejected(resolveRedEvidencePolicy(base({ runTimeoutMs: 3600001, prepTimeoutMs: 3600001 })));
  assert.ok(messages(r).some((m) => m.includes('runTimeoutMs')), 'runTimeoutMs violation reported');
  assert.ok(messages(r).some((m) => m.includes('prepTimeoutMs')), 'prepTimeoutMs violation reported (no short-circuit)');
}
// boundary-exact values PASS
ok(resolveRedEvidencePolicy(base({ minMatcherLen: 4 })));
ok(resolveRedEvidencePolicy(base({ minMatcherEntropyBits: 12 })));
ok(resolveRedEvidencePolicy(base({ maxMatchers: 32 })));
ok(resolveRedEvidencePolicy(base({ maxMatcherLen: 4096 })));
ok(resolveRedEvidencePolicy(base({ runTimeoutMs: 3600000 })));

// forbiddenCatchAlls may EXTEND, never DROP a default entry
rejected(resolveRedEvidencePolicy(base({ forbiddenCatchAlls: ['.+', '.', '^$', '^.*$', '^.+$', '\\s*', '""'] })));
ok(resolveRedEvidencePolicy(base({ forbiddenCatchAlls: ['.*', '.+', '.', '^$', '^.*$', '^.+$', '\\s*', '""', 'EXTRA_ENTRY'] })));

// matcherClassRegistry predicateKind must stay inside the closed enum
rejected(resolveRedEvidencePolicy(base({
  matcherClassRegistry: [{ name: 'evil', predicateKind: 'regex-match' }],
})));

// unknown top-level key rejects fail-closed
{
  const r = rejected(resolveRedEvidencePolicy(base({ unknownKey: 'evil' })));
  assert.ok(messages(r).some((m) => m.includes('unknownKey')), 'unknown key is named in the diagnostic');
}

// ── forbidden env keys in an allowlist (adapter/profile) ─────────────────────
const withProfileEnv = (keys) => base({
  runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: keys, cwd: '.', submodules: false }],
});
rejected(resolveRedEvidencePolicy(withProfileEnv(['PATH'])));
rejected(resolveRedEvidencePolicy(withProfileEnv(['NODE_OPTIONS'])));
rejected(resolveRedEvidencePolicy(withProfileEnv(['LD_PRELOAD'])));
rejected(resolveRedEvidencePolicy(withProfileEnv(['DYLD_INSERT_LIBRARIES'])));
rejected(resolveRedEvidencePolicy(withProfileEnv(['DYLD_FRAMEWORK_PATH'])));
rejected(resolveRedEvidencePolicy(withProfileEnv(['SAFE_KEY', 'NODE_OPTIONS'])));
ok(resolveRedEvidencePolicy(withProfileEnv(['HOME'])));
ok(resolveRedEvidencePolicy(withProfileEnv(['path']))); // case-sensitive: lowercase is NOT the forbidden PATH

// ── invarianceExcludePaths: bare catch-all + tracked-material overlap ────────
rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*'] })));
rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['*'] })));
rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**'] })));
{
  const r = ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] })));
  assert.deepEqual(r.snapshot.invarianceExcludePaths, ['node_modules/**'],
    'a legitimate node_modules/** exclude is KEPT (proves the KEEP direction)');
}
ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['tmp/**'] })));
// material overlap uses the LIVE tracked-material classification (ctx)
{
  const ctx = { trackedMaterialPaths: ['packages/main/src/core/red-evidence/policy.ts'] };
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['packages/main/src/**'] }), ctx));
  ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] }), ctx));
}

// ── argv placeholder must name a real capture in the adapter pattern ─────────
const withAdapterArgv = (argvTemplate, testCaseRefPattern) => base({
  runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern, argvTemplate, allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
});
rejected(resolveRedEvidencePolicy(withAdapterArgv(['node', '${missing}'], '^x:(?<script>[a-z]+)$')));
ok(resolveRedEvidencePolicy(withAdapterArgv(['${script}'], '^x:(?<script>[a-z]+)$')));

// ── F-CX2: "**/" must match zero-or-more path segments INCLUDING zero ────────
// so a glob like **/*.ts catches a ROOT-LEVEL tracked material file, not only nested ones.
{
  const ctx = { trackedMaterialPaths: ['foo.ts'] };
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*.ts'] }), ctx));
  // node_modules/** matches no tracked material → still ACCEPTED (KEEP direction preserved)
  ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] }), ctx));
}
// a NESTED tracked file is still caught by **/*.ts
rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*.ts'] }), { trackedMaterialPaths: ['a/b/foo.ts'] }));

// ── F-CX3: registry entries are fail-closed §1.2 discriminated schemas ───────
// matcherClass: missing name AND missing the required non-empty param
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ predicateKind: 'exit-code-in' }] })));
// exit-code-in param must be a non-empty array of UNIQUE ints in 0..255
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [] }] })));
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [256] }] })));
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1, 1] }] })));
// exit-code-in stream MUST be "combined" (or absent)
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1], stream: 'stdout' }] })));
// stream-nonempty / stream-empty FORBID param
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'stream-nonempty', param: [1] }] })));
// a non-string name rejects
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 42, predicateKind: 'stream-empty' }] })));
// WELL-FORMED custom matcher classes PASS (don't over-reject)
ok(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1, 2, 3] }] })));
ok(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1], stream: 'combined' }] })));
ok(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'stream-empty' }] })));

// adapter: an empty / malformed entry rejects (all required fields checked)
rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{}] })));
rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: ['not-an-object'] })));
rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'nope' }] })));
// a WELL-FORMED custom adapter PASSES
ok(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x:(?<script>[a-z]+)$', argvTemplate: ['${script}'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }] })));

// profile: an empty / malformed entry rejects (all required fields checked)
rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{}] })));
rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: 'not-array', allowedEnvKeys: [], cwd: '.', submodules: false }] })));
rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: 'yes' }] })));
// a WELL-FORMED custom profile PASSES
ok(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME'], cwd: '.', submodules: false }] })));

// ── F-001: the resolved policySnapshot is DEEP-FROZEN (no post-resolution mutation) ──
{
  const r = ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] }));
  assert.throws(() => { r.snapshot.evilFifteenthKey = 1; }, TypeError,
    'adding a 15th key to the resolved snapshot throws (deep Object.freeze; §0.6 casual-mutation tier)');
  assert.throws(() => { r.snapshot.pinnedPath.push('/evil'); }, TypeError,
    'nested arrays in the snapshot are frozen too');
  assert.throws(() => { r.snapshot.matcherClassRegistry[0].name = 'mutated'; }, TypeError,
    'nested registry objects in the snapshot are frozen too');
}

console.log('red-w2a-policy-failclosed: PASS');
