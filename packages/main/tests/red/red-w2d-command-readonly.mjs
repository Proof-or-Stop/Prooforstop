#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-012 + CHK-013 + CHK-014) — the read-only
 * `red_evidence_envelope_check` command: its SUCCESS OUTPUT CONTRACT, its
 * registration, and its read-only-ness.
 *
 * Repro-first RED: written and committed BEFORE the command is implemented and
 * wired. At that point `registry.get('red_evidence_envelope_check')` is
 * undefined (and the envelope module import fails), so this file exits non-zero
 * — that IS the RED evidence.
 *
 * CHK-014 success output contract: on an ADMISSIBLE envelope the command reports
 *   - the computed `assertionDigest`
 *   - the matched binding reference (acceptanceTargetRef, adapterId, testCaseRef)
 *   - the resolved `policyDigest`
 * so the operator can proceed to spend a run. On an INADMISSIBLE envelope that
 * success output is ABSENT and the tagged §1.6 rejection is reported instead.
 *
 * CHK-012 read-only: running the command leaves the whole `.lattice/` tree
 * byte-identical (per-file SHA-256 snapshot, compared before and after), and the
 * command is a member of the CLI read-only class, so no gate verdict, evidence
 * artifact, chain record, or process event can be written by it.
 *
 * Assurance scope (§0.6 practical tier): registered-surface drift detection, not
 * a defence against a hostile local agent (Tier-C).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const DIST = new URL('../../dist', import.meta.url).pathname;

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { targetBindingDigest, emptyRedTargetBindingsFile, appendTargetBinding } =
  await import(`${DIST}/core/red-evidence/target-bindings.js`);
const { computeAssertionDigest } = await import(`${DIST}/core/red-evidence/envelope.js`);
const { MAIN_TOOLS, resolveEffectiveOwnershipClass, enforceStoryOwnerLeaseGate } =
  await import(`${DIST}/cli-engine.js`);
const { getCommandPolicy } = await import(`${DIST}/core/command-policy.js`);
const { PROCESS_FACT_LEVELS } = await import(`${DIST}/core/process-fact-levels.js`);
const { isReadOnlyCommand, READ_ONLY_COMMANDS } = await import(`${DIST}/cli/activity-policy.js`);

const COMMAND = 'red_evidence_envelope_check';
const FROZEN_POLICY_DIGEST = 'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767';

// ── 1. Registration (CHK-013) ────────────────────────────────────────────────
assert.ok(MAIN_TOOLS.some((tool) => tool.name === COMMAND), `${COMMAND} must be in MAIN_TOOLS (CLI dispatchable)`);
const policyEntry = getCommandPolicy(COMMAND);
assert.ok(policyEntry, `${COMMAND} must have a CommandPolicy entry`);
assert.equal(policyEntry.ownershipClass, 'readOnly', `${COMMAND} is readOnly — it writes nothing`);
assert.equal(policyEntry.destructiveRisk, 'none', `${COMMAND} carries no destructive risk`);
assert.notEqual(policyEntry.status, 'gateEvidence', `${COMMAND} is NOT gate evidence — it changes no gate verdict`);
assert.notEqual(policyEntry.gateEvidence, true, `${COMMAND} must not declare gateEvidence`);
const levelEntry = PROCESS_FACT_LEVELS.find((entry) => entry.name === COMMAND);
assert.ok(levelEntry, `${COMMAND} must have a process-fact level entry`);
assert.equal(levelEntry.level, 'L0', `${COMMAND} is an L0 read-only/reporting fact`);
assert.equal(levelEntry.gateConsumer, undefined, 'an L0 read-only checker declares no gateConsumer');
assert.ok(READ_ONLY_COMMANDS.has(COMMAND), `${COMMAND} must be in the CLI READ_ONLY_COMMANDS class`);
assert.equal(isReadOnlyCommand(COMMAND, {}), true, 'the CLI read-only predicate recognises the command, so no hook/activity/process-event write fires');

// ── Fixture repo ─────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'red-w2d-cmd-'));
try {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'red@w2d.local']);
  git(['config', 'user.name', 'red-w2d']);

  // A config carrying the MINIMAL red-evidence policy block: pinnedPath only,
  // so the resolved snapshot is the frozen default and its digest is the W2a
  // pinned literal.
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({ redEvidence: { pinnedPath: ['/usr/bin'] } }, null, 2)}\n`);

  const storyId = 'B-w2d1';
  const store = new StoryStore(root);
  const now = '2026-08-01T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId, name: 'w2d', title: 'W2d envelope check fixture',
    description: 'Envelope admissibility pre-flight fixture.',
    type: 'feature', phase: 'DEV', priority: 'high', createdAt: now, startedAt: now, endedAt: null,
  });

  const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
  store.writeRedTargetBindings(storyId, appendTargetBinding(emptyRedTargetBindingsFile(storyId, now), BINDING, now));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture: committed target binding']);

  const storyRel = relative(realpathSync(root), realpathSync(store.storyDirPath(storyId)));
  assert.ok(!storyRel.startsWith('..'), 'the story dir resolves inside the fixture repo');

  const ADMISSIBLE_VALUE = "Error: Cannot find module '/repo/dist/x.js'";
  const admissible = {
    acceptanceTargetRef: 'M1',
    matchers: [{ id: 'L1', kind: 'literal-line', value: ADMISSIBLE_VALUE, stream: 'combined', polarity: 'present-in-red' }],
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
  };
  const admissibleFile = join(root, 'envelope-ok.json');
  writeFileSync(admissibleFile, `${JSON.stringify(admissible, null, 2)}\n`);

  const inadmissible = JSON.parse(JSON.stringify(admissible));
  inadmissible.matchers[0].value = 'failed'; // below the §1.3 rule-2 floors -> R1-2
  const inadmissibleFile = join(root, 'envelope-bad.json');
  writeFileSync(inadmissibleFile, `${JSON.stringify(inadmissible, null, 2)}\n`);

  writeFileSync(join(root, 'envelope-broken.json'), '{ this is not json\n');

  const registry = createMainRegistry({ store, root, scanRoot: join(root, 'packages', 'main') });
  const check = registry.get(COMMAND);
  assert.ok(check, `${COMMAND} must have a registered handler (dispatchability)`);

  // ── 2. Read-only snapshot of the whole .lattice tree (CHK-012) ─────────────
  function snapshotLattice() {
    const base = join(root, '.lattice');
    const entries = [];
    const walk = (dir, rel) => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(dir, item.name);
        const next = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) walk(abs, next);
        else entries.push(`${next}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    };
    walk(base, '');
    return entries.join('\n');
  }
  const before = snapshotLattice();
  assert.ok(before.length > 0, 'the fixture .lattice tree is non-empty, so the comparison is meaningful');

  // ── 3. SUCCESS OUTPUT CONTRACT (CHK-014) ──────────────────────────────────
  const expectedDigest = computeAssertionDigest({ ...admissible, policyDigest: FROZEN_POLICY_DIGEST });
  const out = check({ storyId, assertionFile: admissibleFile });
  assert.equal(typeof out, 'string', 'the command returns a report string');
  assert.ok(out.includes(expectedDigest), `success output must carry the COMPUTED assertionDigest ${expectedDigest}; got:\n${out}`);
  assert.ok(out.includes(FROZEN_POLICY_DIGEST), `success output must carry the resolved policyDigest; got:\n${out}`);
  for (const field of [BINDING.acceptanceTargetRef, BINDING.adapterId, BINDING.testCaseRef]) {
    assert.ok(out.includes(field), `success output must carry the matched binding field ${field}; got:\n${out}`);
  }
  assert.match(out, /ADMISSIBLE/, 'success output states the verdict in words');

  // JSON projection carries the same three facts structurally.
  const json = JSON.parse(check({ storyId, assertionFile: admissibleFile, json: true }));
  assert.equal(json.ok, true);
  assert.equal(json.assertionDigest, expectedDigest);
  assert.equal(json.policyDigest, FROZEN_POLICY_DIGEST);
  assert.deepEqual(json.binding, BINDING, 'the JSON binding reference carries all THREE fields, not just the target ref');
  assert.deepEqual(json.rejections, []);

  // The digest is recomputed per envelope, never cached or echoed: a one-value
  // change moves it.
  const variant = JSON.parse(JSON.stringify(admissible));
  variant.matchers[0].value = "Error: Cannot find module '/repo/dist/y.js'";
  const variantFile = join(root, 'envelope-variant.json');
  writeFileSync(variantFile, `${JSON.stringify(variant, null, 2)}\n`);
  const variantJson = JSON.parse(check({ storyId, assertionFile: variantFile, json: true }));
  assert.equal(variantJson.ok, true);
  assert.notEqual(variantJson.assertionDigest, expectedDigest,
    'two envelopes differing by one matcher value produce DIFFERENT assertionDigests');

  // ── 4. Inadmissible: tagged rejection, NO success output (CHK-014) ─────────
  let rejectionMessage = '';
  assert.throws(
    () => check({ storyId, assertionFile: inadmissibleFile }),
    (error) => {
      rejectionMessage = error.message;
      return /R1-2/.test(error.message);
    },
    'an inadmissible envelope reports its EXACT §1.6 tag and exits non-zero',
  );
  assert.ok(!/ADMISSIBLE\b/.test(rejectionMessage.replace(/NOT ADMISSIBLE/g, '')),
    `the success verdict must be ABSENT for an inadmissible envelope; got:\n${rejectionMessage}`);
  assert.ok(!rejectionMessage.includes(expectedDigest),
    'no computed assertionDigest is advertised for an inadmissible envelope');

  // ── 5. Fail-closed inputs (CHK-012) ───────────────────────────────────────
  assert.throws(() => check({ storyId: 'B-nope', assertionFile: admissibleFile }), /B-nope/,
    'a nonexistent storyId fails with a diagnostic naming the story');
  assert.throws(() => check({ storyId, assertionFile: join(root, 'envelope-broken.json') }), /JSON|parse/i,
    'a syntactically invalid envelope file fails with a parse diagnostic');
  assert.throws(() => check({ storyId, assertionFile: join(root, 'no-such-file.json') }), /no-such-file\.json/,
    'a missing envelope file fails with a diagnostic naming the path');
  assert.throws(() => check({ storyId }), /assertionFile/,
    'a missing assertionFile argument fails closed');

  // ── 6. The .lattice tree is byte-identical after ALL of the above ──────────
  assert.equal(snapshotLattice(), before,
    'red_evidence_envelope_check wrote NOTHING under .lattice/ — no gate verdict, evidence artifact, chain record, or process event');

  // ── 7. The owner lease never gates it (readOnly) ──────────────────────────
  assert.equal(resolveEffectiveOwnershipClass(COMMAND, { storyId }, storyId), 'readOnly');
  assert.doesNotThrow(
    () => enforceStoryOwnerLeaseGate(COMMAND, { storyId }, store, null, root),
    'a read-only pre-flight is never owner-lease gated, even on a foreign-owned story',
  );

  console.log('red-w2d-command-readonly: PASS');
  console.log(`  registration: MAIN_TOOLS + command-policy(readOnly/none) + process-fact L0 + READ_ONLY_COMMANDS + registered handler`);
  console.log(`  success output: assertionDigest ${expectedDigest} / binding ${BINDING.acceptanceTargetRef} ${BINDING.adapterId} ${BINDING.testCaseRef} / policyDigest ${FROZEN_POLICY_DIGEST}`);
  console.log('  inadmissible: tagged R1-2 rejection, success output absent; .lattice tree byte-identical after 7 invocations');
} finally {
  rmSync(root, { recursive: true, force: true });
}
