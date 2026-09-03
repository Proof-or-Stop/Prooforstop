#!/usr/bin/env node

// Trusted RED-evidence W2a acceptance smoke (B-c054).
//
// Proves the diagnostic-only foundation leaf of the RED-evidence subsystem spec
// (docs/requirements/decisions/red-evidence-subsystem-spec.md §0.4/§1.2/§1.12):
//   1. §0.4 CANON — RFC 8785 code-unit key order, preserved JSON null, minimal
//      number/string encoding, sha256:<64-hex> rendering, and the self-omitting
//      recordDigest helper — matches frozen vectors.
//   2. DIFFERENTIALLY neither core/digest.ts (localeCompare key order) nor
//      core/authority-signing.ts (null-drop) can serve as CANON.
//   3. The §1.2 resolver yields the exhaustive 14-key policySnapshot with the
//      FROZEN default policyDigest, and §1.12 clamp-REJECTS every hard floor,
//      forbidden env key, bare catch-all / material-overlap glob, and
//      unresolvable argv placeholder — fail-closed, one DISTINCT diagnostic each.
//   4. `proof-or-stop doctor` renders exactly one non-gating red-evidence line.
//   5. proof-or-stop.config.json carries NO redEvidence block (pinnedPath is
//      host-specific), and no new red-evidence string overclaims beyond the §0.6
//      practical assurance tier.
//
// Assurance scope (§0.6 practical tier): every guarantee here is handler-enforced
// consistency through the registered surfaces. It does not defend against a
// hostile local agent with filesystem control — that is the Tier-C program.

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';

import { canon, canonDigest, canonDigestOmitting, first12hex, omitUndefinedDeep } from '../core/red-evidence/canon.js';
import {
  resolveRedEvidencePolicy,
  resolveRedEvidenceDoctorLine,
  type ResolveRedEvidencePolicyResult,
} from '../core/red-evidence/policy.js';
import { digestCanonicalJson } from '../core/digest.js';
import { canonicalJsonForSigning } from '../core/authority-signing.js';
import { PROOF_OR_STOP_CONFIG_FILENAME } from '../core/brand-paths.js';

const RETIRED_CONFIG_FILENAME = ['lat', 'tice.config.json'].join('');

const FROZEN_DEFAULT_DIGEST =
  'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767';

const ok = (r: ResolveRedEvidencePolicyResult): Extract<ResolveRedEvidencePolicyResult, { ok: true }> => {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<ResolveRedEvidencePolicyResult, { ok: true }>;
};
const rejected = (r: ResolveRedEvidencePolicyResult): Extract<ResolveRedEvidencePolicyResult, { ok: false }> => {
  assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
  return r as Extract<ResolveRedEvidencePolicyResult, { ok: false }>;
};
const messages = (r: Extract<ResolveRedEvidencePolicyResult, { ok: false }>): string[] => r.diagnostics.map((d) => d.message);
const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ pinnedPath: ['/usr/bin'], ...extra });

try {
  // === 1. §0.4 CANON frozen vectors ==========================================
  assert.equal(canon({ B: 1, a: 2 }), '{"B":1,"a":2}', 'CANON key order is UTF-16 code-unit (B<a), not localeCompare');
  assert.equal(canonDigest({ B: 1, a: 2 }),
    'sha256:812e5e7fb7bb816dc477e91a136430192eadcf83ff303881298146e106ae0161');
  assert.equal(canon({ x: null }), '{"x":null}', '§0.4: JSON null preserved');
  assert.equal(canon({ v: -0 }), '{"v":0}');
  assert.equal(canon({ v: 1e21 }), '{"v":1e+21}');
  assert.equal(canon({ v: 1e-7 }), '{"v":1e-7}');
  assert.equal(canon([1, null, 3]), '[1,null,3]');
  assert.equal(canon({ a: { b: { c: { d: { e: null, z: 1 } } } }, m: null }),
    '{"a":{"b":{"c":{"d":{"e":null,"z":1}}}},"m":null}', 'recursive null preservation + per-level key sort');

  const astral: Record<string, number> = {};
  astral['\u0001'] = 1;
  astral['\u{1D573}'] = 2;
  assert.ok(canon(astral).startsWith('{"\\u0001":1,'), 'control-char key escapes and sorts first by code unit');
  assert.ok(canon(astral).includes(String.fromCodePoint(0x1D573)), 'astral key emitted as raw UTF-8 after the control char');
  assert.equal(canonDigest(astral), 'sha256:27fbb55752b4beb938f3ef318d30e5b0f37c326cb3650d33c507b4d71077e021');

  assert.equal(canonDigest({}), 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'empty object stable digest');
  assert.equal(canonDigestOmitting({ a: 1, b: 2, recordDigest: 'sha256:abc' }, 'recordDigest'), canonDigest({ a: 1, b: 2 }),
    '§0.4 self-omitting recordDigest');
  assert.equal(canonDigestOmitting({ a: 1, b: 2 }, 'nope'), canonDigest({ a: 1, b: 2 }), 'omitting an absent field is a no-op');
  assert.equal(first12hex('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'), 'abcdef012345',
    'first12hex excludes the sha256: prefix');

  // omitUndefinedDeep drops undefined but preserves null, then CANON is safe.
  assert.equal(canon(omitUndefinedDeep({ keep: 1, gone: undefined, nul: null })), '{"keep":1,"nul":null}');

  // F-CX1: a lone surrogate TERMINATES canonicalization with an error (RFC 8785
  // §3.2.2.2) — it is NOT silently escaped. A well-formed surrogate PAIR is fine.
  const lone: Record<string, number> = {};
  lone['\uD800'] = 1;
  assert.throws(() => canon(lone), 'lone-surrogate member name throws (RFC 8785 §3.2.2.2)');
  assert.throws(() => canon('\uD800'), 'a lone high-surrogate string value throws');
  assert.throws(() => canon('\uDC00'), 'a lone low-surrogate string value throws');
  assert.throws(() => canon('a\uD83Dz'), 'a high surrogate not followed by a low surrogate throws');
  assert.equal(canon('\u{1F600}'), JSON.stringify('\u{1F600}'), 'a valid astral surrogate PAIR canonicalizes, not rejected');
  // F-002: a non-plain object (Date/Map/Set/RegExp/class instance) throws rather
  // than silently collapsing to {} and aliasing two distinct values to one digest.
  assert.throws(() => canon({ createdAt: new Date('2020-01-01T00:00:00Z'), name: 'x' }),
    'a Date value throws (no {} collapse aliasing distinct dates)');
  assert.throws(() => canon(new Date('2099-01-01T00:00:00Z')), 'a top-level Date throws');
  assert.throws(() => canon(new Map([['a', 1]])), 'a Map throws');
  assert.throws(() => canon(new Set([1])), 'a Set throws');
  assert.throws(() => canon(/re/), 'a RegExp throws');
  assert.equal(canon(Object.assign(Object.create(null), { a: 1, b: 2 })), '{"a":1,"b":2}',
    'a null-prototype object is a plain JSON object (allowed)');
  assert.throws(() => canon(undefined), 'canon(undefined) throws');
  assert.throws(() => canon(() => {}), 'canon(function) throws');
  assert.throws(() => canon({ v: NaN }), 'canon(NaN) throws');
  assert.throws(() => canon({ v: Infinity }), 'canon(Infinity) throws');

  // === 2. Differentials — no existing canonicalizer can be CANON =============
  const canonHex = canonDigest({ B: 1, a: 2 }).slice('sha256:'.length);
  const digestTsHex = digestCanonicalJson({ B: 1, a: 2 });
  assert.notEqual(canonHex, digestTsHex, 'digest.ts:27 localeCompare key order differs from CANON code-unit order');
  assert.equal(digestTsHex, 'f4fb4f23c18557f189581b45e08078afb6b588addef57f8b1b4c80cef4a8716d',
    'frozen digest.ts digest pinned to catch a silent substitution');
  assert.ok(canon({ priorRecordDigest: null }).includes('"priorRecordDigest":null'), 'CANON preserves priorRecordDigest:null');
  assert.equal(canonicalJsonForSigning({ priorRecordDigest: null }), '{}', 'authority-signing.ts:64 null->undefined DROPS the field');
  assert.equal(canonicalJsonForSigning({ a: null, b: 1 }), '{"b":1}', 'authority-signing drops ALL null fields systematically');

  // === 3. Frozen default snapshot + 14-key coverage ==========================
  {
    const r = ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] }));
    assert.equal(r.policyDigest, FROZEN_DEFAULT_DIGEST, 'default policyDigest reproduces the frozen literal EXACTLY');
    assert.equal(Object.keys(r.snapshot).length, 14, 'policySnapshot has EXACTLY 14 keys');
    const nonzero = r.snapshot.matcherClassRegistry.find((c) => c.name === 'nonzero-exit');
    assert.ok(nonzero && nonzero.param && nonzero.param.length === 255, 'nonzero-exit param is the fully enumerated 1..255 array');
    assert.equal(nonzero!.param![0], 1);
    assert.equal(nonzero!.param![254], 255);
    const adapter = r.snapshot.runnerAdapterRegistry.find((a) => a.adapterId === 'node-test@1');
    assert.deepEqual(adapter!.argvTemplate, ['node', '--test', '--test-reporter', 'tap', '--test-name-pattern', '${test}', '${file}']);
    assert.deepEqual(r.snapshot.runnerProfileRegistry[0], {
      runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'], cwd: '.', submodules: false,
    });
  }
  {
    const r = ok(resolveRedEvidencePolicy(base({ maxMatchers: 4 })));
    assert.equal(r.snapshot.maxMatchers, 4);
    assert.notEqual(r.policyDigest, FROZEN_DEFAULT_DIGEST, 'a valid override changes the digest');
  }
  // JSON duplicate-key collapses to the single-key digest (never a different one).
  assert.equal(
    ok(resolveRedEvidencePolicy(JSON.parse('{"pinnedPath":["/usr/bin"],"maxMatchers":8,"maxMatchers":8}'))).policyDigest,
    FROZEN_DEFAULT_DIGEST, 'duplicate JSON key resolves identically to the single-key default');

  // === 4. pinnedPath required-no-default (exact diagnostic) ===================
  assert.ok(messages(rejected(resolveRedEvidencePolicy({}))).includes('red_evidence_policy_missing: pinnedPath'),
    'missing pinnedPath rejects with the EXACT spec diagnostic string');
  rejected(resolveRedEvidencePolicy({ pinnedPath: null }));
  rejected(resolveRedEvidencePolicy({ pinnedPath: [] }));
  rejected(resolveRedEvidencePolicy({ pinnedPath: ['relative/path'] }));
  rejected(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin', 'relative'] }));
  rejected(resolveRedEvidencePolicy({ pinnedPath: ['./usr/bin'] }));
  rejected(resolveRedEvidencePolicy({ pinnedPath: [''] }));
  ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/local/bin'] }));
  // no default pinnedPath is ever substituted (source inspection: the resolver
  // pushes the missing diagnostic and returns rejected without a snapshot).
  assert.equal(rejected(resolveRedEvidencePolicy({})).snapshot, undefined, 'no snapshot (hence no default pinnedPath) on rejection');

  // === 5. §1.12 clamp-REJECT floors — distinct diagnostics, never clamp ======
  const floorCases: Array<[string, number]> = [
    ['minMatcherLen', 3], ['minMatcherLen', 0], ['minMatcherEntropyBits', 11],
    ['maxMatchers', 33], ['maxMatcherLen', 4097], ['runTimeoutMs', 3600001], ['prepTimeoutMs', 3600001],
  ];
  const floorCodes = new Set<string>();
  for (const [key, value] of floorCases) {
    const r = rejected(resolveRedEvidencePolicy(base({ [key]: value })));
    const named = r.diagnostics.find((d) => d.message.includes(key));
    assert.ok(named, `floor ${key}=${value} names ${key}`);
    assert.ok(named!.message.includes(String(value)), `floor diagnostic includes the offending value ${value}`);
    floorCodes.add(named!.code);
  }
  assert.equal(floorCodes.size, 6, 'six distinct floor keys => six distinct diagnostic codes');
  // silent clamping forbidden
  assert.equal(rejected(resolveRedEvidencePolicy(base({ minMatcherLen: 3 }))).snapshot, undefined,
    'a floor violation yields NO snapshot, never a silently-clamped one');
  // both ceilings reported, no short-circuit
  {
    const m = messages(rejected(resolveRedEvidencePolicy(base({ runTimeoutMs: 3600001, prepTimeoutMs: 3600001 }))));
    assert.ok(m.some((x) => x.includes('runTimeoutMs')) && m.some((x) => x.includes('prepTimeoutMs')), 'both timeout violations reported');
  }
  // boundary-exact values pass
  ok(resolveRedEvidencePolicy(base({ minMatcherLen: 4 })));
  ok(resolveRedEvidencePolicy(base({ minMatcherEntropyBits: 12 })));
  ok(resolveRedEvidencePolicy(base({ maxMatchers: 32 })));
  ok(resolveRedEvidencePolicy(base({ maxMatcherLen: 4096 })));
  ok(resolveRedEvidencePolicy(base({ runTimeoutMs: 3600000 })));
  // forbiddenCatchAlls superset-only + closed predicateKind enum
  rejected(resolveRedEvidencePolicy(base({ forbiddenCatchAlls: ['.+', '.', '^$', '^.*$', '^.+$', '\\s*', '""'] })));
  ok(resolveRedEvidencePolicy(base({ forbiddenCatchAlls: ['.*', '.+', '.', '^$', '^.*$', '^.+$', '\\s*', '""', 'EXTRA'] })));
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'evil', predicateKind: 'regex-match' }] })));
  // unknown top-level key
  assert.ok(messages(rejected(resolveRedEvidencePolicy(base({ unknownKey: 'evil' })))).some((m) => m.includes('unknownKey')));

  // === 6. forbidden env keys / invariance globs / argv placeholders ==========
  const withProfileEnv = (keys: string[]): Record<string, unknown> => base({
    runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: keys, cwd: '.', submodules: false }],
  });
  for (const key of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_FRAMEWORK_PATH']) {
    rejected(resolveRedEvidencePolicy(withProfileEnv([key])));
  }
  rejected(resolveRedEvidencePolicy(withProfileEnv(['SAFE_KEY', 'NODE_OPTIONS'])));
  ok(resolveRedEvidencePolicy(withProfileEnv(['HOME'])));
  ok(resolveRedEvidencePolicy(withProfileEnv(['path']))); // case-sensitive: lowercase is NOT forbidden PATH

  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*'] })));
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['*'] })));
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**'] })));
  assert.deepEqual(ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] }))).snapshot.invarianceExcludePaths,
    ['node_modules/**'], 'legitimate node_modules/** is KEPT (KEEP direction)');
  ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['tmp/**'] })));
  {
    const ctx = { trackedMaterialPaths: ['packages/main/src/core/red-evidence/policy.ts'] };
    rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['packages/main/src/**'] }), ctx));
    ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] }), ctx));
  }
  const withAdapterArgv = (argvTemplate: string[], testCaseRefPattern: string): Record<string, unknown> => base({
    runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern, argvTemplate, allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
  });
  rejected(resolveRedEvidencePolicy(withAdapterArgv(['node', '${missing}'], '^x:(?<script>[a-z]+)$')));
  ok(resolveRedEvidencePolicy(withAdapterArgv(['${script}'], '^x:(?<script>[a-z]+)$')));

  // F-CX2: "**/" matches zero-or-more path segments INCLUDING zero, so **/*.ts
  // catches a ROOT-LEVEL tracked material file (foo.ts), not just nested ones.
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*.ts'] }), { trackedMaterialPaths: ['foo.ts'] }));
  ok(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['node_modules/**'] }), { trackedMaterialPaths: ['foo.ts'] }));
  rejected(resolveRedEvidencePolicy(base({ invarianceExcludePaths: ['**/*.ts'] }), { trackedMaterialPaths: ['a/b/foo.ts'] }));

  // F-CX3: registry entries are fail-closed §1.2 discriminated schemas.
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ predicateKind: 'exit-code-in' }] }))); // missing name + param
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [] }] })));
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [256] }] })));
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1, 1] }] })));
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1], stream: 'stdout' }] })));
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'stream-nonempty', param: [1] }] })));
  ok(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1, 2, 3] }] })));
  ok(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'stream-empty' }] })));
  rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{}] })));
  rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'nope' }] })));
  ok(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x:(?<script>[a-z]+)$', argvTemplate: ['${script}'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }] })));
  rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{}] })));
  rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: 'x', allowedEnvKeys: [], cwd: '.', submodules: false }] })));
  // empty adapter registry isolates the profile shape: replacing 'node-npm@1'
  // would otherwise orphan the DEFAULT adapters' runnerProfileId reference (R2 cross-ref).
  ok(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [], runnerProfileRegistry: [{ runnerProfileId: 'p', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME'], cwd: '.', submodules: false }] })));

  // F-001: the resolved policySnapshot is DEEP-FROZEN — casual post-resolution
  // mutation (a stale-digest vector) throws in strict mode (§0.6 casual tier).
  {
    const r = ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] }));
    assert.throws(() => { (r.snapshot as unknown as Record<string, unknown>).evilFifteenthKey = 1; }, TypeError,
      'adding a 15th key to the resolved snapshot throws (deep Object.freeze)');
    assert.throws(() => { r.snapshot.pinnedPath.push('/evil'); }, TypeError, 'nested snapshot arrays are frozen');
    assert.throws(() => { (r.snapshot.matcherClassRegistry[0] as { name: string }).name = 'mutated'; }, TypeError,
      'nested registry objects in the snapshot are frozen');
  }

  // === 6b. R2 exhaustive §1.2 registry-schema STRUCTURAL constraints =========
  // Duplicate registry keys, an unanchored testCaseRefPattern, an adapter->unknown
  // profile reference, and a malformed profile toolchain all reject fail-closed
  // (cross-host codex r2). Runtime toolchain file-resolution + sha256 match = W2e.
  const codes = (r: Extract<ResolveRedEvidencePolicyResult, { ok: false }>): string[] => r.diagnostics.map((d) => d.code);
  assert.ok(codes(rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [
    { name: 'dup', predicateKind: 'stream-empty' }, { name: 'dup', predicateKind: 'stream-nonempty' },
  ] })))).includes('red_evidence_policy_matcher_class_duplicate_name'), 'duplicate matcher name rejects');
  assert.ok(codes(rejected(resolveRedEvidencePolicy(base({ runnerAdapterRegistry: [
    { adapterId: 'dup@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^a$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' },
    { adapterId: 'dup@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^b$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' },
  ] })))).includes('red_evidence_policy_runner_adapter_duplicate_id'), 'duplicate adapterId rejects');
  assert.ok(codes(rejected(resolveRedEvidencePolicy(base({ runnerProfileRegistry: [
    { runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: false },
    { runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: [], cwd: '.', submodules: false },
  ] })))).includes('red_evidence_policy_runner_profile_duplicate_id'), 'duplicate runnerProfileId rejects');
  const withPattern = (p: string): Record<string, unknown> => base({
    runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: p, argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
  });
  assert.ok(codes(rejected(resolveRedEvidencePolicy(withPattern('(?<x>.+)')))).includes('red_evidence_policy_test_case_ref_pattern_unanchored'), 'unanchored pattern rejects');
  rejected(resolveRedEvidencePolicy(withPattern('^abc')));   // missing trailing $
  rejected(resolveRedEvidencePolicy(withPattern('abc$')));   // missing leading ^
  rejected(resolveRedEvidencePolicy(withPattern('^a\\$')));  // escaped trailing $ is not an anchor
  ok(resolveRedEvidencePolicy(withPattern('^(?<x>abc)$')));   // anchored + named capture (§1.2 requires >=1; R3-3)
  assert.ok(codes(rejected(resolveRedEvidencePolicy(base({
    runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'no-such-profile@9', testCaseRefPattern: '^a$', argvTemplate: ['node'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit' }],
  })))).includes('red_evidence_policy_runner_adapter_unknown_profile'), 'adapter -> unregistered profile rejects');
  const withToolchain = (toolchain: unknown): Record<string, unknown> => base({
    runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'], cwd: '.', submodules: false, toolchain }],
  });
  assert.ok(codes(rejected(resolveRedEvidencePolicy(withToolchain('broken')))).includes('red_evidence_policy_runner_profile_toolchain_not_object'), 'non-object toolchain rejects (R2-CX1)');
  assert.ok(codes(rejected(resolveRedEvidencePolicy(withToolchain({ node: 'nope' })))).includes('red_evidence_policy_runner_profile_toolchain_entry'), 'malformed toolchain entry rejects');
  rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: '/usr/bin/node' } })));          // missing sha256
  assert.ok(codes(rejected(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: 'relative/node', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } })))).includes('red_evidence_policy_runner_profile_toolchain_absolute_path'), 'non-absolute toolchain absolutePath rejects (structural)');
  ok(resolveRedEvidencePolicy(withToolchain({ node: { absolutePath: '/usr/bin/node', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } }))); // well-formed 64-hex structural toolchain resolves
  assert.equal(ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] })).policyDigest, FROZEN_DEFAULT_DIGEST,
    'frozen default digest survives the exhaustive §1.2 structural pass');

  // === 6c. R3 §1.2 DEPTH layer — field TYPE **and DOMAIN** (cross-host codex r3) =
  // Round-2 checked field PRESENCE/type; the DOMAIN constraints below were still
  // fail-open. Each rejects with a DISTINCT code; defaults + well-formed customs ok.
  const adapterField = (o: Record<string, unknown>): Record<string, unknown> => base({
    runnerAdapterRegistry: [{ adapterId: 'x@1', runnerProfileId: 'node-npm@1', testCaseRefPattern: '^x:(?<script>[a-z]+)$', argvTemplate: ['${script}'], allowedEnvKeys: [], cwd: '.', linkageKind: 'script-exit', ...o }],
  });
  const profileField = (o: Record<string, unknown>): Record<string, unknown> => base({
    runnerProfileRegistry: [{ runnerProfileId: 'node-npm@1', prepCommands: [['npm', 'ci']], allowedEnvKeys: ['HOME', 'TMPDIR', 'CI'], cwd: '.', submodules: false, ...o }],
  });
  // R3-1: argvTemplate partial-token placeholder (contains ${ but not exactly ${name}).
  assert.ok(codes(rejected(resolveRedEvidencePolicy(adapterField({ argvTemplate: ['prefix-${script}'] })))).includes('red_evidence_policy_argv_partial_placeholder'), 'partial-token placeholder rejects (R3-1)');
  rejected(resolveRedEvidencePolicy(adapterField({ argvTemplate: ['${}'] })));
  ok(resolveRedEvidencePolicy(adapterField({ argvTemplate: ['cost$5', '${script}'] })));  // a bare '$' literal is not a placeholder
  // R3-2: adapter.cwd AND profile.cwd must be NON-EMPTY repo-relative strings.
  assert.ok(codes(rejected(resolveRedEvidencePolicy(adapterField({ cwd: '/tmp' })))).includes('red_evidence_policy_runner_adapter_cwd_not_repo_relative'), 'absolute adapter cwd rejects (R3-2)');
  rejected(resolveRedEvidencePolicy(adapterField({ cwd: '../outside' })));
  rejected(resolveRedEvidencePolicy(adapterField({ cwd: '' })));
  assert.ok(codes(rejected(resolveRedEvidencePolicy(profileField({ cwd: '/tmp' })))).includes('red_evidence_policy_runner_profile_cwd_not_repo_relative'), 'absolute profile cwd rejects (R3-2)');
  rejected(resolveRedEvidencePolicy(profileField({ cwd: '../outside' })));
  rejected(resolveRedEvidencePolicy(profileField({ cwd: '' })));
  ok(resolveRedEvidencePolicy(adapterField({ cwd: 'packages/main' })));   // nested repo-relative PASSES
  ok(resolveRedEvidencePolicy(profileField({ cwd: 'packages/main' })));
  // R3-3: testCaseRefPattern must have >=1 NAMED capture group.
  assert.ok(codes(rejected(resolveRedEvidencePolicy(adapterField({ testCaseRefPattern: '^npm$', argvTemplate: ['npm'] })))).includes('red_evidence_policy_test_case_ref_pattern_no_capture'), 'captureless pattern rejects (R3-3)');
  rejected(resolveRedEvidencePolicy(adapterField({ testCaseRefPattern: '^(npm)$', argvTemplate: ['npm'] })));  // an UNNAMED capture is insufficient
  ok(resolveRedEvidencePolicy(adapterField({ testCaseRefPattern: '^(?<x>npm)$', argvTemplate: ['npm'] })));
  // R3-4: prepCommands entries must be NON-EMPTY argv arrays.
  assert.ok(codes(rejected(resolveRedEvidencePolicy(profileField({ prepCommands: [[]] })))).includes('red_evidence_policy_runner_profile_prep_command_empty'), 'empty prepCommands argv rejects (R3-4)');
  rejected(resolveRedEvidencePolicy(profileField({ prepCommands: [['npm', 'ci'], []] })));
  // R3 proactive: integer param domain, string elements, sha256 64-hex-lowercase shape.
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: [1.5] }] })));   // float
  rejected(resolveRedEvidencePolicy(base({ matcherClassRegistry: [{ name: 'x', predicateKind: 'exit-code-in', param: ['1'] }] })));   // string
  rejected(resolveRedEvidencePolicy(adapterField({ allowedEnvKeys: [7] })));       // non-string env key
  rejected(resolveRedEvidencePolicy(adapterField({ argvTemplate: [7] })));         // non-string argv token
  rejected(resolveRedEvidencePolicy(profileField({ prepCommands: [[7]] })));       // non-string argv element
  assert.ok(codes(rejected(resolveRedEvidencePolicy(profileField({ toolchain: { node: { absolutePath: '/usr/bin/node', sha256: 'abc' } } })))).includes('red_evidence_policy_runner_profile_toolchain_sha256'), 'short toolchain sha256 rejects (R3 proactive)');
  rejected(resolveRedEvidencePolicy(profileField({ toolchain: { node: { absolutePath: '/usr/bin/node', sha256: 'E'.repeat(64) } } })));  // uppercase hex rejects
  ok(resolveRedEvidencePolicy(profileField({ toolchain: { node: { absolutePath: '/usr/bin/node', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } } })));
  assert.equal(ok(resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] })).policyDigest, FROZEN_DEFAULT_DIGEST,
    'frozen default digest survives the R3 DEPTH structural pass');

  // === 7. doctor line — exactly one non-gating red-evidence line =============
  const hyphenCount = (s: string): number => (s.match(/red-evidence/gi) ?? []).length;
  const absentLine = resolveRedEvidenceDoctorLine(undefined);
  assert.equal(hyphenCount(absentLine), 1, 'doctor line contains exactly one "red-evidence" occurrence');
  assert.ok(absentLine.includes('red_evidence_policy_missing: pinnedPath'), 'absent block renders the fail-closed diagnostic');
  assert.equal(hyphenCount(resolveRedEvidenceDoctorLine({})), 1);
  const validLine = resolveRedEvidenceDoctorLine({ pinnedPath: ['/usr/bin'] });
  assert.equal(hyphenCount(validLine), 1);
  assert.ok(validLine.includes(FROZEN_DEFAULT_DIGEST), 'a valid block renders the resolved policyDigest');
  assert.ok(!/throw|undefined/.test(resolveRedEvidenceDoctorLine('not-an-object' as unknown)), 'doctor line never throws on a bad block');

  // === 8. config self-pinning (CHK-007 absence + CHK-010 uncommitted rule) ===
  // B-cc10: resolve whichever config filename exists. The canonical name is now
  // proof-or-stop.config.json, so the hardcoded deprecated name threw ENOENT here.
  const configUrl = [PROOF_OR_STOP_CONFIG_FILENAME, RETIRED_CONFIG_FILENAME]
    .map((name) => new URL(`../../../../${name}`, import.meta.url))
    .find((candidate) => existsSync(candidate))
    ?? new URL(`../../../../${PROOF_OR_STOP_CONFIG_FILENAME}`, import.meta.url);
  const rawConfig = readFileSync(configUrl, 'utf8');
  const parsedConfig = JSON.parse(rawConfig) as { redEvidence?: unknown; validate?: { commands?: unknown[] } };
  assert.equal(parsedConfig.redEvidence, undefined,
    `${PROOF_OR_STOP_CONFIG_FILENAME} MUST contain no redEvidence block (pinnedPath is host-specific; committing one is out of scope)`);
  const commands = parsedConfig.validate?.commands ?? [];
  const smokeEntry = commands.find((c) => typeof c === 'object' && c !== null
    && (c as { args?: string[] }).args?.some((a) => typeof a === 'string' && a.includes('red-evidence-policy-canon-smoke'))) as
    { command?: string; args?: string[]; timeoutMs?: number } | undefined;
  assert.ok(smokeEntry, 'this smoke MUST be registered in validate.commands');
  assert.equal(smokeEntry!.command, 'node');
  assert.equal(smokeEntry!.timeoutMs, 180000, 'registered smoke timeoutMs is 180000');

  // === 9. §0.6 assurance-tier fence (no overclaim in new red-evidence code) ==
  const OVERCLAIM = /tamper-proof|tamper-resistant|cannot be forged|unforgeable|cryptographic proof|mathematically proves|impossible to fake|guarantees integrity|prevents forgery|receipt signing|cross-host proof/i;
  const redSrc = ['canon.ts', 'policy.ts', 'registries.ts']
    .map((name) => readFileSync(new URL(`../../src/core/red-evidence/${name}`, import.meta.url), 'utf8'))
    .join('\n');
  assert.ok(!OVERCLAIM.test(redSrc), 'new red-evidence source must not claim assurance beyond the §0.6 practical tier');
  // Only the red-evidence lines this story added to doctor.ts are in scope.
  const doctorRedLines = readFileSync(new URL('../../src/handlers/doctor.ts', import.meta.url), 'utf8')
    .split('\n').filter((line) => /red.?evidence/i.test(line)).join('\n');
  assert.ok(!OVERCLAIM.test(doctorRedLines), 'new doctor red-evidence lines must not overclaim');

  console.log('red-evidence-policy-canon-smoke: OK');
} catch (error) {
  console.error('red-evidence-policy-canon-smoke: FAIL');
  console.error(error);
  process.exit(1);
}
