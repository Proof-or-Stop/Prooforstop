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
// a WELL-FORMED custom profile PASSES (empty adapter registry isolates the
// profile shape: replacing the default profile 'node-npm@1' would otherwise
// orphan the DEFAULT adapters' runnerProfileId reference — see R2 cross-ref).
ok(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [], runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME'], cwd: '.', submodules: false }] })));

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

// ── R2: EXHAUSTIVE §1.2 registry-schema STRUCTURAL constraints ───────────────
// The round-1 fix enforced required-field PRESENCE but left these axes fail-open
// (cross-host codex r2). Each block REJECTS with a DISTINCT named diagnostic on
// the complete implementation; the DEFAULT registries + every well-formed custom
// entry still resolve ok. In-scope = config-load STRUCTURAL validation; the
// runtime toolchain file-resolution + sha256-match stays fenced to W2e.

// R2-CX2: duplicate registry keys reject (matcher name / adapterId / profileId).
{
  const r = rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [
    { name: 'dup', predicateKind: 'stream-empty' },
    { name: 'dup', predicateKind: 'stream-nonempty' },
  ] })));
  assert.ok(codes(r).includes('red_evidence_policy_matcher_class_duplicate_name'),
    'a duplicate matcher class name rejects with a distinct diagnostic');
}
{
  const r = rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [
    { adapterId: 'dup@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^a$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' },
    { adapterId: 'dup@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^b$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' },
  ] })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_adapter_duplicate_id'),
    'a duplicate adapterId rejects with a distinct diagnostic');
}
{
  // duplicated node-npm@1 keeps the default adapters' profile reference valid, so
  // the ONLY rejection is the duplicate profile id.
  const r = rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [
    { runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: false },
    { runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: false },
  ] })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_duplicate_id'),
    'a duplicate runnerProfileId rejects with a distinct diagnostic');
}

// R2-CX3: an UNANCHORED testCaseRefPattern rejects (must be ^...$, escaped-$ aware).
const withPattern = (testCaseRefPattern) => base({
  runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern, argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
});
{
  const r = rejected(resolveRedEvidencePolicy(withPattern('(?<x>.+)')));
  assert.ok(codes(r).includes('red_evidence_policy_test_case_ref_pattern_unanchored'),
    'a pattern with neither ^ nor $ anchor rejects (the R2-CX3 blocker case)');
}
rejected(resolveRedEvidencePolicy(withPattern('^abc')));   // missing trailing $
rejected(resolveRedEvidencePolicy(withPattern('abc$')));   // missing leading ^
rejected(resolveRedEvidencePolicy(withPattern('^a\\$')));  // trailing $ is ESCAPED — not a real end anchor
// §1.2 requires >=1 NAMED capture group (R3-3), even for an all-literal argv: an
// anchored+captured pattern PASSES, a captureless anchored one now REJECTS.
ok(resolveRedEvidencePolicy(withPattern('^(?<name>abc)$')));  // anchored + named capture
rejected(resolveRedEvidencePolicy(withPattern('^abc$')));    // anchored but NO named capture → reject
rejected(resolveRedEvidencePolicy(withPattern('^$')));       // empty-anchor, no capture → reject

// adapter.runnerProfileId MUST reference a registered profile.
{
  const r = rejected(resolveRedEvidencePolicy(base({
    runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'no-such-profile@9', testCaseRefPattern: '^a$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
  })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_adapter_unknown_profile'),
    'an adapter referencing an unregistered profile rejects');
}
// an adapter referencing a profile registered in the SAME override resolves ok.
ok(resolveRedEvidencePolicy(base({
  runnerProfileRegistry: [{ runnerProfileId: 'custom@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: false }],
  runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'custom@1', testCaseRefPattern: '^(?<a>.+)$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
})));

// R2-CX1: profile toolchain STRUCTURAL shape (object of argv0 -> {absolutePath,sha256}).
// node-npm@1 keeps the default adapters' profile reference valid, so the ONLY
// rejection is the toolchain one.
const withToolchain = (toolchain) => base({
  runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'], cwd: '.', submodules: false, toolchain }],
});
{
  const r = rejected(resolveRedEvidencePolicy(withToolchain('broken')));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_toolchain_not_object'),
    'a non-object toolchain rejects (the R2-CX1 blocker case)');
}
rejected(resolveRedEvidencePolicy(withToolchain(['not', 'a', 'map'])));  // an array is not a toolchain map
{
  const r = rejected(resolveRedEvidencePolicy(withToolchain({ node: 'not-an-object' })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_toolchain_entry'), 'a non-object toolchain value rejects');
}
rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: '/usr/bin/node' } })));        // missing sha256
rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: '/usr/bin/node', sha256: 7 } }))); // sha256 not a string
rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: 7, sha256: 'abc' } })));        // absolutePath not a string
rejected(resolveRedEvidencePolicy(withToolchain({ '': { absolutePath: '/usr/bin/node', sha256: 'abc' } }))); // empty argv0 key
{
  const r = rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: 'relative/node', sha256: 'abc' } })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_toolchain_absolute_path'),
    'a non-absolute toolchain absolutePath rejects (STRUCTURAL only; no file resolution / sha256 match)');
}
// a WELL-FORMED toolchain resolves ok (W2e does the runtime resolve + sha256 match).
ok(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: '/usr/bin/node', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } })));

// ── R3: §1.2 DEPTH layer — TYPE **and DOMAIN** of EVERY registry field ────────
// Round-2 checked field PRESENCE/type; cross-host codex r3 confirmed the DOMAIN
// constraints were still fail-open. Each block below REJECTS with a DISTINCT
// named diagnostic on the complete implementation; the DEFAULT registries + every
// well-formed custom entry still resolve ok. Config-load STRUCTURAL only — the
// runtime toolchain file-resolution + sha256-match stays fenced to W2e.
const withAdapterField = (o) => base({
  runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x:(?<script>[a-z]+)$', argvTemplate: ['${script}'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit', ...o }],
});
const withProfileField = (o) => base({
  runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'], cwd: '.', submodules: false, ...o }],
});

// R3-1: argvTemplate partial-token placeholder (contains ${ but not exactly ${name}).
{
  const r = rejected(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: ['prefix-${script}'] })));
  assert.ok(codes(r).includes('red_evidence_policy_argv_partial_placeholder'),
    'a partial-token placeholder "prefix-${script}" rejects (no partial-token interpolation, §1.2)');
}
rejected(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: ['${}'] })));                 // empty placeholder name
rejected(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: ['${1bad}'] })));             // capture name starts with a digit
rejected(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: ['${script}suffix'] })));     // trailing text after placeholder
// a pure-literal token containing a bare '$' (no ${) is NOT a placeholder → accepted verbatim
ok(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: ['cost$5', '${script}'] })));

// R3-2: adapter.cwd AND profile.cwd must be a NON-EMPTY repo-relative string.
{
  const r = rejected(resolveRedEvidencePolicy(withAdapterField({ cwd: '/tmp' })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_adapter_cwd_not_repo_relative'),
    'an absolute adapter cwd "/tmp" rejects');
}
rejected(resolveRedEvidencePolicy(withAdapterField({ cwd: '../outside' })));   // traversal
rejected(resolveRedEvidencePolicy(withAdapterField({ cwd: 'a/../../b' })));    // traversal mid-path
rejected(resolveRedEvidencePolicy(withAdapterField({ cwd: '' })));            // empty
{
  const r = rejected(resolveRedEvidencePolicy(withProfileField({ cwd: '/tmp' })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_cwd_not_repo_relative'),
    'an absolute profile cwd "/tmp" rejects');
}
rejected(resolveRedEvidencePolicy(withProfileField({ cwd: '../outside' })));  // traversal
rejected(resolveRedEvidencePolicy(withProfileField({ cwd: '' })));           // empty
// a legitimate repo-relative cwd (nested, and the default '.') PASSES
ok(resolveRedEvidencePolicy(withAdapterField({ cwd: 'packages/main' })));
ok(resolveRedEvidencePolicy(withProfileField({ cwd: 'packages/main' })));

// R3-3: testCaseRefPattern with no named capture group rejects.
{
  const r = rejected(resolveRedEvidencePolicy(withAdapterField({ testCaseRefPattern: '^npm$', argvTemplate: ['npm'] })));
  assert.ok(codes(r).includes('red_evidence_policy_test_case_ref_pattern_no_capture'),
    'an anchored but captureless pattern "^npm$" rejects (§1.2 requires >=1 named capture)');
}
// an UNNAMED capture group does not satisfy "named capture" → still rejects
rejected(resolveRedEvidencePolicy(withAdapterField({ testCaseRefPattern: '^(npm)$', argvTemplate: ['npm'] })));
// a single named capture PASSES (default adapters already have one)
ok(resolveRedEvidencePolicy(withAdapterField({ testCaseRefPattern: '^(?<x>npm)$', argvTemplate: ['npm'] })));

// R3-4: prepCommands with an empty argv entry rejects.
{
  const r = rejected(resolveRedEvidencePolicy(withProfileField({ prepCommands: [[]] })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_prep_command_empty'),
    'an empty prepCommands argv [[]] rejects (argv[0] is the command)');
}
rejected(resolveRedEvidencePolicy(withProfileField({ prepCommands: [['npm', 'ci'], []] })));  // one empty among many
// a non-empty argv PASSES
ok(resolveRedEvidencePolicy(withProfileField({ prepCommands: [['npm', 'ci']] })));

// R3 proactive: matcherClass exit-code-in param entries must be INTEGERS in 0..255.
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1.5] }] })));  // float
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: ['1'] }] })));  // string
rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [-1] }] })));   // below 0

// R3 proactive: allowedEnvKeys / argvTemplate / prepCommands elements must be strings.
rejected(resolveRedEvidencePolicy(withAdapterField({ allowedEnvKeys: [7] })));       // non-string env key
rejected(resolveRedEvidencePolicy(withAdapterField({ argvTemplate: [7] })));         // non-string argv token
rejected(resolveRedEvidencePolicy(withProfileField({ allowedEnvKeys: [7] })));       // non-string env key
rejected(resolveRedEvidencePolicy(withProfileField({ prepCommands: [[7]] })));       // non-string argv element

// R3 proactive: toolchain sha256 must be a 64-char lowercase hex string (structural).
const withToolchainField = (tc) => withProfileField({ toolchain: tc });
{
  const r = rejected(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'abc' } })));
  assert.ok(codes(r).includes('red_evidence_policy_runner_profile_toolchain_sha256'),
    'a too-short toolchain sha256 rejects (structural 64-hex shape; no runtime file match)');
}
rejected(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855' } }))); // uppercase hex
rejected(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'g'.repeat(64) } })));  // non-hex chars
rejected(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'a'.repeat(63) } })));  // 63 chars
rejected(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'a'.repeat(65) } })));  // 65 chars
// a well-formed 64-hex-lowercase sha256 PASSES (W2e does the runtime match)
ok(resolveRedEvidencePolicy(withToolchainField({ node: { absolutePath: '/usr/bin/node', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } })));

// ── R4-1 (cross-host codex r4): patternCaptureNames must TOKENIZE the pattern,
// not textually scan for `(?<name>`. A `(?<name>`-shaped sequence appearing INSIDE
// a character class (literal characters, NOT a group) or after a backslash escape
// is NOT a real named capture. The buggy textual scan counted it, so a captureless
// pattern wrongly passed the ">=1 named capture" check and a `${name}` argv
// placeholder wrongly resolved against a nonexistent capture — BOTH must reject.
{
  // `[(?<fake>]` is a character CLASS body → ZERO real named captures. With a
  // literal-only argv the pattern must REJECT with the no-capture diagnostic.
  const r = rejected(resolveRedEvidencePolicy(withAdapterArgv(['tool'], '^[(?<fake>]+$')));
  assert.ok(codes(r).includes('red_evidence_policy_test_case_ref_pattern_no_capture'),
    'a `(?<fake>` INSIDE a character class is not a real named capture → no-capture rejection');
}
{
  // SAME class-embedded pattern with `${fake}`: the placeholder names no REAL
  // capture, so it must reject with the unresolved-placeholder diagnostic.
  const r = rejected(resolveRedEvidencePolicy(withAdapterArgv(['tool', '${fake}'], '^[(?<fake>]+$')));
  assert.ok(codes(r).includes('red_evidence_policy_argv_unresolved_placeholder'),
    '${fake} against a class-embedded `(?<fake>` resolves to no real capture → unresolved-placeholder rejection');
}
{
  // A backslash-escaped `\(?<x>` is an OPTIONAL literal `(` followed by literal
  // `<x>`, NOT a named group — it must NOT be counted, so this captureless
  // anchored pattern REJECTS.
  const r = rejected(resolveRedEvidencePolicy(withAdapterArgv(['tool'], '^\\(?<x>$')));
  assert.ok(codes(r).includes('red_evidence_policy_test_case_ref_pattern_no_capture'),
    'a backslash-escaped `\\(?<x>` is not a real named capture → no-capture rejection');
}
// REGRESSION: a GENUINE named capture (default npm-script adapter shape) still
// resolves ok, both with a literal argv and with a `${...}` placeholder against it.
ok(resolveRedEvidencePolicy(withAdapterArgv(['tool'], '^(?<script>[A-Za-z0-9:_-]+)$')));
ok(resolveRedEvidencePolicy(withAdapterArgv(['${script}'], '^(?<script>[A-Za-z0-9:_-]+)$')));

// After the exhaustive §1.2 structural pass the DEFAULT registries STILL resolve
// to the frozen digest (well-formed defaults are unaffected by any new check).
{
  const r = ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] }));
  assert.equal(r.policyDigest, FROZEN_DEFAULT_DIGEST, 'frozen default digest survives the exhaustive §1.2 structural pass');
}

console.log('red-w2a-policy-failclosed: PASS');
