#!/usr/bin/env node

// Trusted RED-evidence W2d acceptance smoke (B-9ff1).
//
// Proves the §1.1 assertion envelope + §1.3 matcher admissibility + the
// read-only `red_evidence_envelope_check` command of the RED-evidence subsystem
// spec (docs/requirements/decisions/red-evidence-subsystem-spec.md §1.1, §1.2,
// §1.3, §1.6, §1.11, §1.11.4):
//   1. §1.11.4 entropy is TOTAL BITS (byteLength x H), not per-symbol, and is
//      measured in BYTES, not UTF-16 code units — proven differentially.
//   2. §1.3 rule 2 is the length-AND-entropy CONJUNCTION — proven differentially
//      on rows that satisfy exactly ONE floor, in BOTH directions.
//   3. §1.3 rule 1 blocklist (all 8 default entries) and rule 3 (a class matcher
//      is never the sole present-in-red evidence) reject with tag R1-2.
//   4. §1.1.4 assertionDigest scope, BOTH directions: CANON over the assertion
//      with ONLY assertionDigest stripped matches; CANON over the full object
//      and CANON without policyDigest do not.
//   5. §1.1 schema bounds and §1.1.3 binding validation reject with the EXACT
//      §1.6 tag — R1-2 (specificity) and R1-3 (bounds) are never collapsed.
//   6. §1.6 tag coverage: R1-1, R1-2, R1-3, R1-5 and R1-6 each have at least one
//      fixture, so no rejection class is silently untested.
//   7. The SUCCESS transcript (CHK-014): an admissible envelope reports the
//      computed assertionDigest, the matched binding reference, and the resolved
//      policyDigest — the operator's primary use case, not only rejections.
//   8. The command is READ-ONLY: the .lattice tree is byte-identical after every
//      invocation, it is a member of the CLI read-only command class, and it
//      changes no gate verdict.
//   9. The three pre-existing mechanical contracts still pass with the command
//      fully wired.
//
// Assurance scope (§0.6 practical tier): handler-enforced consistency through the
// registered surfaces; not a defence against a hostile local agent with
// filesystem control (that is the Tier-C program).

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canon, canonDigest, canonDigestOmitting } from '../core/red-evidence/canon.js';
import { entropyBits, valueByteLength, matcherValueSpecificity } from '../core/red-evidence/specificity.js';
import {
  canonicalAssertionSubobject,
  computeAssertionDigest,
  validateAssertionEnvelope,
  MATCHER_KINDS,
  MATCHER_STREAMS,
  MATCHER_POLARITIES,
  type EnvelopeRejection,
  type ValidateAssertionEnvelopeResult,
} from '../core/red-evidence/envelope.js';
import { resolveRedEvidencePolicy, type RedEvidencePolicySnapshot } from '../core/red-evidence/policy.js';
import { DEFAULT_FORBIDDEN_CATCH_ALLS } from '../core/red-evidence/registries.js';
import {
  appendTargetBinding,
  emptyRedTargetBindingsFile,
  targetBindingDigest,
} from '../core/red-evidence/target-bindings.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { MAIN_TOOLS, resolveEffectiveOwnershipClass, enforceStoryOwnerLeaseGate } from '../cli-engine.js';
import { isReadOnlyCommand, READ_ONLY_COMMANDS } from '../cli/activity-policy.js';
import { evaluateProofStoryDiagnostics } from '../core/proofstory.js';
import { proofStoryDiagnosticInput } from '../handlers/phase-gates.js';
import type { StoryInfo } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');

const COMMAND = 'red_evidence_envelope_check';
const FROZEN_POLICY_DIGEST = 'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767';

const roots: string[] = [];
function freshRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `red-w2d-${label}-`));
  roots.push(root);
  return root;
}

try {
  // === 0. The frozen default policy (W2a) ===================================
  const resolved = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] });
  assert.equal(resolved.ok, true, 'the frozen default policy resolves');
  const policy: RedEvidencePolicySnapshot = resolved.snapshot!;
  const policyDigest: string = resolved.policyDigest!;
  assert.equal(policyDigest, FROZEN_POLICY_DIGEST, 'frozen default policyDigest is the W2a pinned literal');
  assert.equal(policy.minMatcherLen, 8);
  assert.equal(policy.minMatcherEntropyBits, 24);
  assert.equal(policy.maxMatchers, 8);
  assert.equal(policy.maxMatcherLen, 512);

  // === 1. §1.11.4 entropy: TOTAL BITS, measured in BYTES =====================
  // Independent reference implementation (not the module under test).
  const refH = (value: string): number => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length === 0) return 0;
    const freq = new Map<number, number>();
    for (const byte of bytes) freq.set(byte, (freq.get(byte) ?? 0) + 1);
    let h = 0;
    for (const count of freq.values()) {
      const p = count / bytes.length;
      h -= p * Math.log2(p);
    }
    return h;
  };
  const refTotalBits = (value: string): number => Buffer.byteLength(value, 'utf8') * refH(value);
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

  assert.ok(close(entropyBits('ab'), 2), 'entropyBits("ab") = 2 x 1.0 = 2.0 TOTAL bits');
  assert.ok(close(entropyBits('aabb'), 4), 'entropyBits("aabb") = 4 x 1.0 = 4.0 — total bits GROW with length');
  assert.ok(close(refH('ab'), 1) && close(refH('aabb'), 1), 'the per-symbol rival is constant across both rows');
  assert.ok(close(entropyBits('abcdefgh'), 24), 'entropyBits("abcdefgh") = 8 x 3.0 = 24.0 exactly');
  assert.ok(close(entropyBits('a'), 0), 'one distinct byte carries 0 bits');

  // Differential: under the 24-bit floor, every value the spec ADMITS is one the
  // per-symbol rival REJECTS (per-byte H can never exceed 8).
  const ENTROPY_TABLE = [
    "Error: Cannot find module '/repo/dist/x.js'",
    'AssertionError: expected 1 to equal 2',
    'npm ERR! missing script: test',
    'TypeError: x is not a function',
    'ENOENT: no such file or directory',
    'FAIL packages/main/tests/red/x.mjs',
    'exit status 1 (expected 0)',
    'abcdefgh',
  ];
  let entropyDifferentialRows = 0;
  for (const value of ENTROPY_TABLE) {
    const total = refTotalBits(value);
    const perSymbol = refH(value);
    assert.ok(close(entropyBits(value), total), `entropyBits(${JSON.stringify(value)}) must equal byteLength x H`);
    const specVerdict: boolean = total >= policy.minMatcherEntropyBits;
    const rivalVerdict: boolean = perSymbol >= policy.minMatcherEntropyBits;
    assert.equal(matcherValueSpecificity(value, policy).entropyFloor, specVerdict,
      `${JSON.stringify(value)}: the entropy verdict must follow TOTAL bits`);
    if (specVerdict !== rivalVerdict) entropyDifferentialRows += 1;
  }
  assert.ok(entropyDifferentialRows >= 8,
    `the entropy table must carry at least 8 rows where total-bits and per-symbol DISAGREE (found ${entropyDifferentialRows})`);

  // BYTES, not UTF-16 code units: a 4-byte / 2-code-unit character separates them.
  {
    const multibyte = '\u{1F4A5} boom';
    assert.equal(valueByteLength(multibyte), 9);
    assert.equal(multibyte.length, 7);
    assert.ok(close(entropyBits(multibyte), refTotalBits(multibyte)), 'entropy is measured over BYTES');
  }

  // === 2. §1.3 rule 2 is a CONJUNCTION (both single-floor directions) ========
  const raised = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'], minMatcherLen: 16 });
  assert.equal(raised.ok, true, 'a policy raising minMatcherLen resolves (§1.12 permits raising)');
  const CONJUNCTION_TABLE: Array<{ value: string; snapshot: RedEvidencePolicySnapshot }> = [
    // length passes / entropy fails -> AND rejects, OR would admit
    { value: 'aaaaaaaa', snapshot: policy },
    { value: 'aaaaaaaaaaaa', snapshot: policy },
    { value: 'abababababab', snapshot: policy },
    { value: 'abcabcabcabc', snapshot: policy },
    { value: '========', snapshot: policy },
    // length fails / entropy passes -> only reachable with a RAISED length floor
    { value: 'Cannot find', snapshot: raised.snapshot! },
    { value: 'no such file', snapshot: raised.snapshot! },
  ];
  let conjunctionDifferentialRows = 0;
  let lengthOnly = 0;
  let entropyOnly = 0;
  for (const row of CONJUNCTION_TABLE) {
    const specificity = matcherValueSpecificity(row.value, row.snapshot);
    const and = specificity.lengthFloor && specificity.entropyFloor;
    const or = specificity.lengthFloor || specificity.entropyFloor;
    assert.equal(specificity.rule2, and,
      `${JSON.stringify(row.value)}: rule 2 must be the AND verdict ${and}, an OR implementation would say ${or}`);
    if (and !== or) conjunctionDifferentialRows += 1;
    if (specificity.lengthFloor && !specificity.entropyFloor) lengthOnly += 1;
    if (!specificity.lengthFloor && specificity.entropyFloor) entropyOnly += 1;
  }
  assert.equal(conjunctionDifferentialRows, CONJUNCTION_TABLE.length,
    'every conjunction-table row must SEPARATE AND from OR');
  assert.ok(lengthOnly > 0 && entropyOnly > 0, 'both single-floor directions are covered');
  // Boundary inclusivity (>=, not >).
  assert.equal(matcherValueSpecificity('abcdefgh', policy).rule2, true, 'exactly at both floors is admissible');
  assert.equal(matcherValueSpecificity('abcdefga', policy).rule2, false, 'just below the entropy floor rejects');

  // === 3. Envelope fixtures ==================================================
  const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
  const COMMITTED = { ...BINDING, createdAt: '2026-08-01T00:00:00.000Z' };
  const ADMISSIBLE = "Error: Cannot find module '/repo/dist/x.js'";
  const literal = (id: string, value: string, polarity = 'present-in-red', stream = 'combined') =>
    ({ id, kind: 'literal-line', value, stream, polarity });

  const baseAssertion = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    acceptanceTargetRef: 'M1',
    matchers: [literal('L1', ADMISSIBLE)],
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
    ...overrides,
  });

  const validate = (
    assertion: unknown,
    opts: { binding?: unknown; snapshot?: RedEvidencePolicySnapshot; digest?: string } = {},
  ): ValidateAssertionEnvelopeResult => validateAssertionEnvelope({
    assertion,
    policy: opts.snapshot ?? policy,
    policyDigest: opts.digest ?? policyDigest,
    committedBinding: ('binding' in opts ? opts.binding : COMMITTED) as never,
  });
  const tagsOf = (result: ValidateAssertionEnvelopeResult): string[] =>
    [...new Set(result.rejections.map((rejection: EnvelopeRejection) => rejection.tag))].sort();

  assert.deepEqual(MATCHER_KINDS, ['literal-line', 'class'], 'the matcher language has exactly two kinds — no pattern kind');
  assert.deepEqual(MATCHER_STREAMS, ['stdout', 'stderr', 'combined']);
  assert.deepEqual(MATCHER_POLARITIES, ['present-in-red', 'absent-in-green', 'present-in-green']);
  assert.equal(validate(baseAssertion()).ok, true, 'the baseline fixture is admissible');

  // === 4. §1.3 rule 1 blocklist + rule 3, tagged R1-2 ========================
  assert.equal(DEFAULT_FORBIDDEN_CATCH_ALLS.length, 8);
  for (const entry of DEFAULT_FORBIDDEN_CATCH_ALLS) {
    assert.equal(matcherValueSpecificity(entry, policy).notBlocklisted, false, `${JSON.stringify(entry)} is blocklisted`);
    const result = validate(baseAssertion({ matchers: [literal('L1', entry)] }));
    assert.deepEqual(tagsOf(result), ['R1-2'], `blocklisted ${JSON.stringify(entry)} rejects R1-2 alone`);
  }
  // Membership, not substring.
  assert.equal(validate(baseAssertion({ matchers: [literal('L1', 'Error: .* pattern not found')] })).ok, true,
    'a literal merely CONTAINING a blocklist entry is admissible (membership, not substring)');
  // No silent trimming: an untrimmed value is a BOUNDS failure, not a specificity one.
  assert.deepEqual(tagsOf(validate(baseAssertion({ matchers: [literal('L1', ' .* ')] }))), ['R1-3'],
    'an untrimmed value is R1-3 (bounds); a validator that silently trimmed would report R1-2 and hide it');
  // Rule 3.
  const classMatcher = (id: string, value: string, polarity = 'present-in-red', stream = 'stderr') =>
    ({ id, kind: 'class', value, stream, polarity });
  for (const [label, matchers] of [
    ['class-only present-in-red', [classMatcher('C1', 'stderr-nonempty')]],
    ['multiple class matchers only', [classMatcher('C1', 'stderr-nonempty'), classMatcher('C2', 'nonzero-exit', 'present-in-red', 'combined')]],
    ['no present-in-red matcher at all', [literal('L1', ADMISSIBLE, 'absent-in-green')]],
    ['the only present-in-red literal is inadmissible', [classMatcher('C1', 'stderr-nonempty'), literal('L1', 'aaaaaaaaaaaa')]],
  ] as Array<[string, unknown[]]>) {
    assert.deepEqual(tagsOf(validate(baseAssertion({ matchers }))), ['R1-2'], `rule 3: ${label} rejects R1-2 alone`);
  }
  assert.equal(validate(baseAssertion({ matchers: [literal('L1', ADMISSIBLE), classMatcher('C1', 'stderr-nonempty')] })).ok, true,
    'a class matcher supplemented by an admissible literal satisfies rule 3');

  // === 5. §1.1.4 assertionDigest scope, BOTH directions ======================
  {
    const candidate = baseAssertion({ policyDigest });
    const digest = computeAssertionDigest(candidate);
    const stored = { ...candidate, assertionDigest: digest };
    assert.equal(canonDigestOmitting(stored, 'assertionDigest'), digest,
      'POSITIVE: CANON with ONLY assertionDigest stripped equals the stored digest');
    assert.notEqual(canonDigest(stored), digest,
      'NEGATIVE: CANON over the FULL stored object (self field kept) must DIFFER');
    const withoutPolicyDigest = { ...candidate };
    delete (withoutPolicyDigest as Record<string, unknown>).policyDigest;
    assert.notEqual(canonDigest(withoutPolicyDigest), digest,
      'NEGATIVE: CANON with policyDigest REMOVED must DIFFER — the assertion digest COVERS the policy digest');
    assert.ok(canon(canonicalAssertionSubobject(stored)).includes('"policyDigest"'));
    assert.ok(!canon(canonicalAssertionSubobject(stored)).includes('"assertionDigest"'));
    assert.equal(computeAssertionDigest(JSON.parse(JSON.stringify(stored))), digest, 'CANON survives a JSON roundtrip');
    // §0.4: greenExempt:false is OMITTED, so it cannot fork the digest.
    const explicitFalse = baseAssertion({ policyDigest, matchers: [{ ...literal('L1', ADMISSIBLE), greenExempt: false }] });
    const explicitTrue = baseAssertion({ policyDigest, matchers: [{ ...literal('L1', ADMISSIBLE), greenExempt: true }] });
    assert.equal(computeAssertionDigest(explicitFalse), digest, 'greenExempt:false is omitted (§0.4)');
    assert.notEqual(computeAssertionDigest(explicitTrue), digest, 'greenExempt:true IS covered by assertionDigest');
    // A stored digest that does not recompute is a NAMED diagnostic, not a fabricated §1.6 tag.
    const tampered = validate({ ...stored, assertionDigest: `sha256:${'0'.repeat(64)}` });
    assert.equal(tampered.ok, false);
    assert.deepEqual(tagsOf(tampered), [], 'a digest mismatch carries NO §1.6 tag');
    assert.ok(tampered.diagnostics.some((diagnostic) => diagnostic.code === 'assertion-digest-mismatch'));
  }

  // === 6. §1.6 TAGGED rejection matrix (R1-2 and R1-3 never collapsed) =======
  const matrix: Array<{ label: string; assertion: unknown; tags: string[]; opts?: Record<string, unknown> }> = [
    // R1-3 bounds: count, identity, kind, class registry, value, enums, path.
    { label: 'zero matchers', assertion: baseAssertion({ matchers: [] }), tags: ['R1-3'] },
    {
      label: 'maxMatchers+1 matchers',
      assertion: baseAssertion({
        matchers: [literal('L1', ADMISSIBLE), ...Array.from({ length: 8 }, (_, i) => literal(`L${i + 2}`, `Error: distinct failure line ${i + 2} observed`, 'present-in-green'))],
      }),
      tags: ['R1-3'],
    },
    { label: 'duplicate matcher id', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), literal('L1', 'Error: a second distinct failure line', 'present-in-green')] }), tags: ['R1-3'] },
    { label: 'unknown kind anchored-regex (no pattern language exists)', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind: 'anchored-regex', value: ADMISSIBLE, stream: 'combined', polarity: 'present-in-green' }] }), tags: ['R1-3'] },
    { label: 'class value naming no registry entry', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), classMatcher('C1', 'no-such-class', 'present-in-green')] }), tags: ['R1-3'] },
    { label: 'class value differing only in case', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), classMatcher('C1', 'Stderr-Nonempty', 'present-in-green')] }), tags: ['R1-3'] },
    { label: 'untrimmed value', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), literal('L2', ` ${ADMISSIBLE}`, 'present-in-green')] }), tags: ['R1-3'] },
    { label: 'empty value', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), literal('L2', '', 'present-in-green')] }), tags: ['R1-3'] },
    { label: 'value at maxMatcherLen+1 bytes', assertion: baseAssertion({ matchers: [literal('L1', `${'abcdefgh'.repeat(64)}x`)] }), tags: ['R1-3'] },
    { label: 'stream outside the closed enum', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind: 'literal-line', value: ADMISSIBLE, stream: 'Combined', polarity: 'present-in-green' }] }), tags: ['R1-3'] },
    { label: 'polarity outside the closed enum', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind: 'literal-line', value: ADMISSIBLE, stream: 'combined', polarity: 'absent-in-red' }] }), tags: ['R1-3'] },
    { label: 'greenExempt on a non-present-in-red polarity', assertion: baseAssertion({ matchers: [literal('L1', ADMISSIBLE), { ...literal('L2', ADMISSIBLE, 'absent-in-green'), greenExempt: true }] }), tags: ['R1-3'] },
    { label: 'expectedExitClass exit:0', assertion: baseAssertion({ expectedExitClass: 'exit:0' }), tags: ['R1-3'] },
    { label: 'expectedExitClass exit:256', assertion: baseAssertion({ expectedExitClass: 'exit:256' }), tags: ['R1-3'] },
    { label: 'timeout-is-failure with a script-exit adapter (decidable at schema time)', assertion: baseAssertion({ expectedExitClass: 'timeout-is-failure' }), tags: ['R1-3'] },
    { label: 'absolute targetArtifactRef', assertion: baseAssertion({ targetExercisedProof: { ...(baseAssertion().targetExercisedProof as object), supplementaryArtifact: { targetArtifactRef: '/absolute/path', expectation: 'present' } } }), tags: ['R1-3'] },
    { label: 'targetArtifactRef with a .. segment', assertion: baseAssertion({ targetExercisedProof: { ...(baseAssertion().targetExercisedProof as object), supplementaryArtifact: { targetArtifactRef: 'foo/../bar', expectation: 'present' } } }), tags: ['R1-3'] },
    // R1-2 specificity.
    { label: 'below-threshold literal is R1-2 not R1-3', assertion: baseAssertion({ matchers: [literal('L1', 'failed')] }), tags: ['R1-2'] },
    // R1-1 missing proof.
    { label: 'targetExercisedProof absent', assertion: (() => { const a = baseAssertion(); delete (a as Record<string, unknown>).targetExercisedProof; return a; })(), tags: ['R1-1'] },
    { label: 'targetExercisedProof.adapterId absent (incomplete proof, not a mismatch)', assertion: (() => { const a = baseAssertion(); delete (a.targetExercisedProof as Record<string, unknown>).adapterId; return a; })(), tags: ['R1-1'] },
    // R1-6 binding.
    { label: 'no committed binding registered', assertion: baseAssertion(), tags: ['R1-6'], opts: { binding: null } },
    { label: 'correct adapterId but wrong testCaseRef is R1-6, not R1-1', assertion: (() => { const a = baseAssertion(); (a.targetExercisedProof as Record<string, unknown>).testCaseRef = 'npm-script:test:OTHER'; (a.targetExercisedProof as Record<string, unknown>).targetBindingDigest = targetBindingDigest({ ...BINDING, testCaseRef: 'npm-script:test:OTHER' }); return a; })(), tags: ['R1-6'] },
    { label: 'targetBindingDigest computed WITH createdAt (the digest-scope trap)', assertion: (() => { const a = baseAssertion(); (a.targetExercisedProof as Record<string, unknown>).targetBindingDigest = canonDigest(COMMITTED); return a; })(), tags: ['R1-6'] },
    // R1-5 registry membership (the envelope-decidable half).
    { label: 'adapterId absent from runnerAdapterRegistry', assertion: (() => { const a = baseAssertion(); (a.targetExercisedProof as Record<string, unknown>).adapterId = 'ghost@9'; (a.targetExercisedProof as Record<string, unknown>).targetBindingDigest = targetBindingDigest({ ...BINDING, adapterId: 'ghost@9' }); return a; })(), tags: ['R1-5'], opts: { binding: { acceptanceTargetRef: 'M1', adapterId: 'ghost@9', testCaseRef: BINDING.testCaseRef, createdAt: '2026-08-01T00:00:00.000Z' } } },
    // Co-occurrence: neither tag suppresses the other.
    { label: 'R1-2 and R1-3 co-occur', assertion: baseAssertion({ matchers: [literal('L1', 'failed')], targetExercisedProof: { ...(baseAssertion().targetExercisedProof as object), supplementaryArtifact: { targetArtifactRef: '/absolute/path', expectation: 'present' } } }), tags: ['R1-2', 'R1-3'] },
  ];
  const coveredTags = new Set<string>();
  for (const row of matrix) {
    const result = validate(row.assertion, (row.opts ?? {}) as never);
    assert.equal(result.ok, false, `${row.label}: must be inadmissible`);
    assert.deepEqual(tagsOf(result), row.tags.slice().sort(),
      `${row.label}: expected tags ${JSON.stringify(row.tags)}, got ${JSON.stringify(tagsOf(result))}`);
    assert.equal(result.assertionDigest, null, `${row.label}: an inadmissible envelope advertises NO success digest`);
    for (const tag of row.tags) coveredTags.add(tag);
  }
  for (const tag of ['R1-1', 'R1-2', 'R1-3', 'R1-5', 'R1-6']) {
    assert.ok(coveredTags.has(tag), `the matrix must exercise ${tag} — an untested tag is an unverified rejection class`);
  }

  // === 7. The command: registration, SUCCESS transcript, read-only ==========
  assert.ok(MAIN_TOOLS.some((tool) => tool.name === COMMAND), `${COMMAND} is CLI dispatchable`);
  const commandPolicy = getCommandPolicy(COMMAND);
  assert.ok(commandPolicy, `${COMMAND} has a CommandPolicy entry`);
  assert.equal(commandPolicy!.ownershipClass, 'readOnly');
  assert.equal(commandPolicy!.destructiveRisk, 'none');
  assert.notEqual(commandPolicy!.status, 'gateEvidence', `${COMMAND} is not gate evidence`);
  const levelEntry = PROCESS_FACT_LEVELS.find((entry) => entry.name === COMMAND);
  assert.ok(levelEntry, `${COMMAND} has a process-fact level entry`);
  assert.equal(levelEntry!.level, 'L0');
  assert.equal((levelEntry as { gateConsumer?: string }).gateConsumer, undefined, 'an L0 read-only checker declares no gateConsumer');
  assert.ok(READ_ONLY_COMMANDS.has(COMMAND) && isReadOnlyCommand(COMMAND, {}),
    `${COMMAND} is in the CLI read-only class, so no hook/activity/process-event write fires`);

  {
    const root = freshRoot('command');
    const git = (args: string[]): string => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'red@w2d.local']);
    git(['config', 'user.name', 'red-w2d']);
    writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({ redEvidence: { pinnedPath: ['/usr/bin'] } }, null, 2)}\n`);

    const storyId = 'B-w2d';
    const store = new StoryStore(root);
    const now = '2026-08-01T00:00:00.000Z';
    const story: StoryInfo = {
      storyId, name: 'w2d', title: 'W2d envelope pre-flight',
      description: 'Fix an authentication session security regression (behavior change).',
      type: 'bug', phase: 'DEV', priority: 'high', createdAt: now, startedAt: now, endedAt: null,
    };
    store.writeStory(storyId, story);
    store.writeRedTargetBindings(storyId, appendTargetBinding(emptyRedTargetBindingsFile(storyId, now), BINDING, now));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fixture: committed target binding']);

    const admissibleFile = join(root, 'envelope-ok.json');
    writeFileSync(admissibleFile, `${JSON.stringify(baseAssertion(), null, 2)}\n`);
    const inadmissible = baseAssertion({ matchers: [literal('L1', 'failed')] });
    const inadmissibleFile = join(root, 'envelope-bad.json');
    writeFileSync(inadmissibleFile, `${JSON.stringify(inadmissible, null, 2)}\n`);
    writeFileSync(join(root, 'envelope-broken.json'), '{ not json\n');

    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    const check = registry.get(COMMAND);
    assert.ok(check, `${COMMAND} has a registered handler`);

    const snapshotLattice = (): string => {
      const entries: string[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const abs = join(dir, item.name);
          const next = rel ? `${rel}/${item.name}` : item.name;
          if (item.isDirectory()) walk(abs, next);
          else entries.push(`${next}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
        }
      };
      walk(join(root, '.lattice'), '');
      return entries.join('\n');
    };
    const before = snapshotLattice();
    assert.ok(before.length > 0, 'the fixture .lattice tree is non-empty, so the comparison is meaningful');
    const gateBefore = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);

    // CHK-014 SUCCESS OUTPUT CONTRACT.
    const expectedDigest = computeAssertionDigest({ ...baseAssertion(), policyDigest: FROZEN_POLICY_DIGEST });
    const transcript: string = check!({ storyId, assertionFile: admissibleFile });
    assert.equal(transcript.split('\n')[0], 'Red-evidence envelope: ADMISSIBLE', 'the success verdict line');
    assert.ok(transcript.includes(expectedDigest), 'success transcript carries the COMPUTED assertionDigest');
    assert.ok(transcript.includes(FROZEN_POLICY_DIGEST), 'success transcript carries the resolved policyDigest');
    for (const field of [BINDING.acceptanceTargetRef, BINDING.adapterId, BINDING.testCaseRef]) {
      assert.ok(transcript.includes(field), `success transcript carries the matched binding field ${field}`);
    }
    const json = JSON.parse(check!({ storyId, assertionFile: admissibleFile, json: true }));
    assert.equal(json.ok, true);
    assert.equal(json.assertionDigest, expectedDigest);
    assert.equal(json.policyDigest, FROZEN_POLICY_DIGEST);
    assert.deepEqual(json.binding, BINDING, 'the binding reference carries all THREE fields');

    // An inadmissible envelope: tagged rejection, success transcript ABSENT.
    let rejectionText = '';
    assert.throws(
      () => check!({ storyId, assertionFile: inadmissibleFile }),
      (error: Error) => { rejectionText = error.message; return /\[R1-2\]/.test(error.message); },
      'an inadmissible envelope reports its EXACT §1.6 tag and exits non-zero',
    );
    assert.ok(!rejectionText.includes('Red-evidence envelope: ADMISSIBLE'), 'no success verdict for a rejected envelope');
    assert.ok(!rejectionText.includes(expectedDigest), 'no computed assertionDigest for a rejected envelope');

    // Fail-closed inputs.
    assert.throws(() => check!({ storyId: 'B-nope', assertionFile: admissibleFile }), /B-nope/);
    assert.throws(() => check!({ storyId, assertionFile: join(root, 'envelope-broken.json') }), /not valid JSON/);
    assert.throws(() => check!({ storyId, assertionFile: join(root, 'missing.json') }), /missing\.json/);
    assert.throws(() => check!({ storyId }), /assertionFile/);

    // READ-ONLY: nothing under .lattice changed, and no gate verdict moved.
    assert.equal(snapshotLattice(), before,
      `${COMMAND} wrote NOTHING under .lattice/ — no artifact, chain record, process event, or gate verdict`);
    assert.equal(
      JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence),
      gateBefore,
      'the redEvidenceSatisfied / missingRedEvidence gate verdict is UNCHANGED by the envelope check',
    );
    assert.equal(resolveEffectiveOwnershipClass(COMMAND, { storyId }, storyId), 'readOnly');
    assert.doesNotThrow(() => enforceStoryOwnerLeaseGate(COMMAND, { storyId }, store, null, root),
      'a read-only pre-flight is never owner-lease gated');
  }

  // === 8. The three pre-existing mechanical contracts still pass =============
  const runContract = (label: string, cmd: string, args: string[]): void => {
    const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, `${label} must pass (exit 0); status=${result.status}\n${result.stdout}\n${result.stderr}`);
  };
  runContract('lifecycle-registry-contract', 'node', [join(pkgRoot, 'dist', 'tasks', 'lifecycle-registry-contract.js')]);
  runContract('command-ownership-contract', 'node', [join(pkgRoot, 'dist', 'tasks', 'command-ownership-contract.js')]);
  runContract('verify-process-fact-contract', 'node', [join(repoRoot, 'scripts', 'verify-process-fact-contract.mjs'), '--quiet']);

  console.log(
    'red-evidence-envelope-smoke: OK — total-bits entropy (8 differential rows) + byte measurement, ' +
    'rule 2 AND-not-OR (both single-floor directions), rule 1 blocklist (8/8) + rule 3 all tagged R1-2, ' +
    'assertionDigest scope proven in BOTH directions, ' +
    `${matrix.length} tagged rejection fixtures covering R1-1/R1-2/R1-3/R1-5/R1-6 with R1-2 and R1-3 never collapsed, ` +
    'the ADMISSIBLE success transcript (assertionDigest + matched binding + policyDigest), ' +
    'a byte-identical .lattice tree with no gate verdict change, and all three registry contracts pass.',
  );
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
