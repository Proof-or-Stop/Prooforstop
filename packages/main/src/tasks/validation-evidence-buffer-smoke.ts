#!/usr/bin/env node
/**
 * B-3434 — deterministic, OFFLINE smoke for the validation evidence sizing model. No git, no
 * network, no spawned process: pure-Fn assertions over classifyValidationEvidenceSize,
 * boundValidationEvidenceOutput, boundPersistedValidationEvidence and
 * formatValidationEvidenceAdvisory. It DOES read two repository source files with readFileSync and
 * existsSync - the CHK-004 disposition section observes the shipped wiring rather than inferring it
 * - so this is filesystem-reading but filesystem-writing free, and it says so rather than claiming
 * a purity it does not have.
 *
 * What it protects:
 *
 *   CHK-004 (the bound) — per-command output is already capped by trimOutput; the AGGREGATE grew
 *   with the number of configured validate commands until it passed the metadata read ceiling and
 *   no story could commit test-evidence.json at all.
 *
 *   CHK-005 (the advisory) — the cliff must be marked, not merely moved, with thresholds derived
 *   from the ceiling THIS story set rather than a number copied beside it.
 *
 *   F-014 (the boundary) — the bound must hold over the SERIALISED FILE. StoryStore stringifies
 *   the record a second time, escaping the output string again, so an inner string under the bound
 *   can still write a file roughly twice that size. Bounding the inner value alone left a reachable
 *   wedge, and the sections below measure the file.
 *
 * Prints `validation-evidence-buffer-smoke: PASS` on success; throws (non-zero exit) on any failed
 * assertion.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METADATA_BLOB_READ_MAX_BUFFER_BYTES } from '../core/done-prepare-generated-metadata.js';
import {
  VALIDATION_EVIDENCE_ADVISORY_BYTES,
  VALIDATION_EVIDENCE_ADVISORY_FRACTION,
  VALIDATION_EVIDENCE_BOUND_BYTES,
  VALIDATION_EVIDENCE_BOUND_FRACTION,
  VALIDATION_EVIDENCE_READ_CEILING_BYTES,
  boundPersistedValidationEvidence,
  boundValidationEvidenceOutput,
  classifyValidationEvidenceSize,
  formatValidationEvidenceAdvisory,
  measurePersistedEvidenceBytes,
} from '../core/validation-executor.js';

const MIB = 1024 * 1024;
const OUTPUT_LINE_CHARS = 120;

/** The TestEvidenceData shape persistStoryValidationEvidence builds, minus the parts we do not size. */
function buildRecord(output: string): Record<string, unknown> {
  return {
    command: 'lattice validate --story=B-3434 --json',
    output,
    result: 'PASS',
    timestamp: '2026-08-15T00:00:00.000Z',
    headHash: 'a'.repeat(40),
    materialHash: 'b'.repeat(64),
    storyFilesHash: 'c'.repeat(64),
    commandExecution: { commandCount: 100 },
    disposition: 'executed',
  };
}

function persist(result: unknown) {
  return boundPersistedValidationEvidence({ result, buildRecord });
}

/**
 * The postcondition check, applied to every case: the reported size must be a real measurement of
 * the record being persisted, and the flag must be derived from it. An earlier revision reported a
 * hardcoded success flag, and every fixture passed while it was structurally unable to say no.
 */
function assertFlagAgreesWithMeasurement(bound: ReturnType<typeof persist>): void {
  if (bound.disposition === 'refused' && bound.fileBytes === Number.MAX_SAFE_INTEGER) {
    assert.equal(bound.withinBound, false, 'an unmeasurable record is never reported as within bound');
    return;
  }
  const actual = measurePersistedEvidenceBytes(bound.record);
  assert.notEqual(actual, null, 'the persisted record is measurable');
  assert.equal(bound.fileBytes, actual, 'fileBytes is a measurement of the record being persisted');
  assert.equal(
    bound.withinBound,
    actual! < VALIDATION_EVIDENCE_BOUND_BYTES,
    `withinBound must be derived from the file measurement (flag=${bound.withinBound}, actual=${actual}, bound=${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
}

function capturedOutput(outputChars: number, char = 'o'): string {
  if (outputChars === 0) return '';
  const lines: string[] = [];
  for (let written = 0; written < outputChars; written += OUTPUT_LINE_CHARS) {
    lines.push(char.repeat(Math.min(OUTPUT_LINE_CHARS, outputChars - written)));
  }
  return lines.join('\n');
}

function commandResult(label: string, outputChars: number, argChars = 0, char = 'o'): Record<string, unknown> {
  return {
    label,
    command: 'node',
    args: argChars > 0 ? [`--fixture=${'a'.repeat(argChars)}`] : ['packages/main/dist/tasks/example.js'],
    code: 0,
    output: capturedOutput(outputChars, char),
    durationMs: 12,
  };
}

/**
 * Build a result the way executeValidationPlan actually builds one: a status line per command AND
 * every line of that command captured output pushed into `details` indented by two spaces, so the
 * artifact carries a SECOND copy of the same bytes.
 */
function validationResult(
  commands: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const details: string[] = [];
  for (const command of commands) {
    details.push(`✓ ${command.label}: ${command.command} ${(command.args as string[]).join(' ')}`.trim());
    const output = String(command.output ?? '').trim();
    if (output) details.push(...output.split('\n').filter(Boolean).map((line) => `  ${line}`));
  }
  return {
    provider: 'lattice-verifier',
    status: 'pass',
    allPass: true,
    summary: 'all validation commands passed',
    details,
    warnings: [],
    timestamp: '2026-08-15T00:00:00.000Z',
    commands,
    ...overrides,
  };
}

// ── 1. The thresholds are anchored to THIS story's ceiling, not to an external default. ──────────
{
  assert.equal(
    VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    'the evidence ceiling must BE the metadata blob read ceiling, so the two can never drift apart',
  );
  assert.ok(VALIDATION_EVIDENCE_READ_CEILING_BYTES >= 10 * MIB, 'the ceiling sits well above the 1 MiB Node default');
  assert.equal(
    VALIDATION_EVIDENCE_ADVISORY_BYTES,
    Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_ADVISORY_FRACTION),
    'the advisory threshold is a fraction OF THE CEILING',
  );
  assert.equal(
    VALIDATION_EVIDENCE_BOUND_BYTES,
    Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_BOUND_FRACTION),
    'the bound is a fraction OF THE CEILING',
  );
  assert.ok(VALIDATION_EVIDENCE_ADVISORY_BYTES < VALIDATION_EVIDENCE_BOUND_BYTES, 'the advisory fires before the bound');
  assert.ok(VALIDATION_EVIDENCE_BOUND_BYTES < VALIDATION_EVIDENCE_READ_CEILING_BYTES, 'the bound sits below the read ceiling');
  console.log('✓ advisory and bound are fractions of the metadata read ceiling this story set');
}

// ── 2. Three tiers, with the boundary resolved deterministically on the higher side. ─────────────
{
  assert.equal(classifyValidationEvidenceSize(0), 'within_budget', 'an empty artifact is within budget');
  assert.equal(classifyValidationEvidenceSize(VALIDATION_EVIDENCE_ADVISORY_BYTES - 1), 'within_budget', 'one byte below the advisory threshold is within budget');
  assert.equal(classifyValidationEvidenceSize(VALIDATION_EVIDENCE_ADVISORY_BYTES), 'advisory', 'EXACTLY at the advisory threshold resolves to advisory');
  assert.equal(classifyValidationEvidenceSize(VALIDATION_EVIDENCE_BOUND_BYTES - 1), 'advisory', 'one byte below the bound is advisory');
  assert.equal(classifyValidationEvidenceSize(VALIDATION_EVIDENCE_BOUND_BYTES), 'bounded', 'EXACTLY at the bound resolves to bounded');
  console.log('✓ within_budget / advisory / bounded tiers with an inclusive, deterministic boundary');
}

// ── 3. The measurement reproduces StoryStore.writeJson exactly. ──────────────────────────────────
{
  // measurePersistedEvidenceBytes duplicates a format owned by core/store.ts, which is outside this
  // story's allowed scope. Pin it here so a change there fails a test instead of silently loosening
  // the bound by measuring something smaller than what reaches disk.
  const record = buildRecord('{"allPass":true}');
  const expected = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  assert.equal(measurePersistedEvidenceBytes(record), expected, 'the measurement is JSON.stringify(record, null, 2) + newline, as StoryStore.writeJson writes it');
  assert.equal(measurePersistedEvidenceBytes({ cycle: (() => { const o: any = {}; o.self = o; return o; })() }), null, 'an unserialisable record measures null rather than throwing');
  console.log('✓ the persisted measurement reproduces the StoryStore serialisation format');
}

// ── 4. Today's repository shape is untouched: no advisory, no reduction, byte-identical output. ──
{
  const result = validationResult(Array.from({ length: 100 }, (_, index) => commandResult(`cmd-${index}`, 12_000)));
  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.disposition, 'unmodified', 'a 100-command artifact needs no reduction');
  assert.equal(bound.state, 'within_budget', 'and it is within budget');
  assert.equal((bound.record as any).output, JSON.stringify(result), 'an unreduced artifact serialises byte-identically to before');
  assert.equal(formatValidationEvidenceAdvisory(bound), null, 'an artifact below the advisory fraction prints no advisory');
  console.log('✓ realistic 100-command artifact is unbounded and silent');
  console.log(`    fileBytes=${bound.fileBytes} state=${bound.state}`);
}

// ── 5. F-014: quote-heavy output, where the second escaping pass doubles the file. ───────────────
{
  // The reachable wedge. Every captured character is a quote, so it costs two bytes on the second
  // stringify. Before the fix the reducer measured the inner string, found it under the bound, never
  // engaged, and the file went out over the READ CEILING - so the metadata commit failed on the blob
  // ceiling and no evidence could ever persist for that configuration.
  const commands = Array.from({ length: 400 }, (_, index) => commandResult(`cmd-${index}`, 12_000, 0, '"'));
  const result = validationResult(commands);
  const innerOnly = boundValidationEvidenceOutput(result);
  const unboundedFile = measurePersistedEvidenceBytes(buildRecord(JSON.stringify(result)))!;
  assert.ok(
    unboundedFile >= VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    `the fixture genuinely breaches the read ceiling once persisted (${unboundedFile} vs ${VALIDATION_EVIDENCE_READ_CEILING_BYTES})`,
  );
  assert.ok(
    unboundedFile > innerOnly.serializedBytes * 1.5,
    `the second escaping pass expands the artifact substantially (inner ${innerOnly.serializedBytes}, file ${unboundedFile})`,
  );

  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, `the PERSISTED FILE must be brought under the bound (${bound.fileBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`);
  assert.ok(bound.fileBytes < VALIDATION_EVIDENCE_READ_CEILING_BYTES, 'and therefore under the read ceiling the metadata commit enforces');
  const parsed = JSON.parse((bound.record as any).output);
  assert.equal(parsed.allPass, true, 'the verdict survives the reduction');
  assert.equal(bound.disposition, 'reduced', 'escaping expansion is handled by re-reducing, not by collapsing to the fallback');
  assert.ok(Array.isArray(parsed.commands) && parsed.commands.length > 0, 'per-command evidence survives the expansion-aware retry');
  console.log('✓ quote-heavy output is bounded at the FILE, where the second escaping pass lands');
  console.log(`    innerBytes=${innerOnly.serializedBytes} unboundedFile=${unboundedFile} boundedFile=${bound.fileBytes}`);
}

// ── 6. Past the bound: markers stay visible and the JSON contract survives. ──────────────────────
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 100_000)));
  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, 'the file is brought under the bound');
  assert.equal(bound.disposition, 'reduced', 'the staged reduction was enough; no fallback needed');
  const parsed = JSON.parse((bound.record as any).output);
  assert.equal(parsed.allPass, true, 'bounding preserves allPass, so the pass verdict is unchanged');
  assert.equal(parsed.status, 'pass', 'bounding preserves status');
  assert.equal(parsed.commands.length + bound.sizing!.elidedCommandEntries, 300, 'every command entry is present or counted');
  assert.ok(bound.sizing!.elidedCommandOutputs > 0, 'captured output was elided');
  assert.ok(bound.sizing!.elidedDetailLines > 0, 'the duplicated copy in details was elided too');
  const markers = parsed.commands.filter((command: any) => String(command.output).startsWith('[evidence bound:'));
  assert.match(String(markers[0].output), /\d+ chars of captured output omitted/, 'the marker names how much was omitted');
  assert.ok(parsed.details.some((line: string) => line.includes('[evidence bound:')), 'the details elision is visible too');
  console.log('✓ oversized realistic artifact is bounded with visible markers and JSON contract intact');
  console.log(`    fileBytes=${bound.fileBytes} elidedCommandOutputs=${bound.sizing!.elidedCommandOutputs} elidedDetailLines=${bound.sizing!.elidedDetailLines}`);
}

// ── 7. Bulk that is not captured output: entries are capped WITH A COUNT, never dropped silently. ─
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 0, 100_000)));
  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, 'the file is brought under the bound');
  assert.ok(bound.sizing!.elidedCommandEntries > 0, 'entries were capped');
  const parsed = JSON.parse((bound.record as any).output);
  assert.equal(parsed.allPass, true, 'capping entries preserves the pass verdict');
  assert.equal(
    parsed.commands.length + bound.sizing!.elidedCommandEntries,
    300,
    'every omitted entry is accounted for by the reported count — nothing vanishes silently',
  );
  // The phrase "non-output bulk capped" is contiguous on purpose: CHK-004:adversarial:1 is pinned
  // to that literal substring and a pin is immutable once bound, so the wording is load-bearing.
  console.log('✓ non-output bulk capped with a diagnostic count');
  console.log(`    elidedCommandEntries=${bound.sizing!.elidedCommandEntries} fileBytes=${bound.fileBytes}`);
}

// ── 8. Bulk the reducer cannot model reaches the fallback, and the fallback is admissible. ───────
{
  // The staged reduction only models commands / details / warnings. Anything else - a field added
  // later, a key name carrying bulk, a huge verdict-bearing scalar - is not its problem any more:
  // the writer measures the file and swaps in a fallback sized by construction.
  for (const [label, overrides] of [
    ['unknown field', { someFieldAddedLater: 'z'.repeat(30 * MIB) }],
    ['key name', { ['k'.repeat(30_000_000)]: 1 }],
    ['verdict-bearing scalar', { summary: 's'.repeat(30 * MIB) }],
  ] as Array<[string, Record<string, unknown>]>) {
    const bound = persist(validationResult([], overrides));
    assertFlagAgreesWithMeasurement(bound);
    assert.equal(bound.withinBound, true, `${label}: the file is brought under the bound`);
    assert.equal(bound.disposition, 'verdict_only', `${label}: the fallback is what got it there`);
    assert.ok(bound.fileBytes < 4_000, `${label}: the fallback record is sized by construction (${bound.fileBytes} bytes)`);
    const parsed = JSON.parse((bound.record as any).output);
    assert.equal(parsed.allPass, true, `${label}: the fallback preserves allPass, which the phase gate parses`);
    assert.equal(parsed.status, 'pass', `${label}: the fallback preserves status`);
    assert.equal(parsed.evidenceBound.replacedWithVerdictOnlyRecord, true, `${label}: the record names itself a replacement`);
    assert.ok(String(parsed.evidenceBound.reason).length > 0, `${label}: and says why`);
    assert.deepEqual(
      parsed.evidenceBound.carriedFields,
      ['provider', 'status', 'allPass', 'allPassed', 'failureKind', 'summary'],
      `${label}: the fallback states exactly which fields it carries, so what it drops is derivable`,
    );
    console.log(`    ${label}: fileBytes=${bound.fileBytes} disposition=${bound.disposition}`);
  }
  console.log('✓ bulk outside the modelled dimensions falls back to an admissible record sized by construction');
}

// ── 9. Inputs that make property access or JSON.stringify THROW are bounded, not propagated. ────
{
  // The claim this replaces said degenerate inputs "never crash" while sitting on calls that throw
  // on cycles, BigInt and any accessor that raises. The getter fixture below throws on EVERY read,
  // not on the third: a fixture that survives the first two reads never reaches the fallback, which
  // is exactly why the earlier version of this section missed an uncaught throw there.
  const cyclic: any = { provider: 'p', status: 'pass', allPass: true, commands: [], details: [], warnings: [] };
  cyclic.self = cyclic;
  const withBigInt: any = { provider: 'p', status: 'pass', allPass: true, commands: [], details: [], warnings: [], big: BigInt(1) };
  const alwaysThrows: any = {
    provider: 'p', status: 'pass', allPass: true, commands: [], details: [], warnings: [],
    get summary() { throw new Error('summary getter always throws'); },
  };
  const proxied: any = new Proxy(
    { provider: 'p', status: 'pass', allPass: true, commands: [], details: [], warnings: [] },
    { get(target, key) { if (key === 'status') throw new Error('proxy refuses status'); return (target as any)[key]; } },
  );
  for (const [label, value] of [
    ['cyclic', cyclic],
    ['BigInt', withBigInt],
    ['always-throwing getter', alwaysThrows],
    ['throwing proxy trap', proxied],
  ] as Array<[string, unknown]>) {
    let bound!: ReturnType<typeof persist>;
    assert.doesNotThrow(() => { bound = persist(value); }, `${label}: a degenerate input is bounded, not thrown`);
    assertFlagAgreesWithMeasurement(bound);
    assert.equal(bound.withinBound, true, `${label}: a degenerate input still produces a writable record`);
    assert.doesNotThrow(() => JSON.parse((bound.record as any).output), `${label}: the output field stays valid JSON`);
    assert.notEqual((bound.record as any).output, 'null', `${label}: an unserialisable result is never persisted as a bare null, which reads as a silent not-a-pass`);
    const parsed = JSON.parse((bound.record as any).output);
    assert.equal(parsed.evidenceBound.replacedWithVerdictOnlyRecord, true, `${label}: the replacement names itself`);
    console.log(`    ${label}: disposition=${bound.disposition} withinBound=${bound.withinBound}`);
  }
  console.log('✓ cyclic, BigInt, throwing-getter and throwing-proxy inputs are bounded rather than propagated');
}

// ── 9b. A non-object oversized input is REFUSED, not replaced by an invented record. ─────────────
{
  // Substituting a verdict-only record here would invent fields the input never had: a string has
  // no allPass and no status to carry, so the artifact would assert neither while reporting success.
  const bound = persist('x'.repeat(30 * MIB));
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, false, 'an unreducible oversized non-object reports withinBound false');
  assert.equal(bound.disposition, 'refused', 'and is refused rather than replaced');
  assert.ok(bound.fileBytes >= VALIDATION_EVIDENCE_BOUND_BYTES, 'the refusal rests on a real measurement');
  console.log('✓ an oversized non-object input is refused rather than given an invented verdict record');
  console.log(`    fileBytes=${bound.fileBytes} disposition=${bound.disposition}`);
}

// ── 9c. F-020: a successfully reduced artifact is never discarded for the stub. ─────────────────
{
  // Heterogeneous density: quote-heavy continuation lines expand x2 on the outer stringify while
  // plain status lines expand x1, so no single expansion ESTIMATE describes the artifact. The old
  // writer estimated one, made a single corrective attempt, and on a miss threw away a perfectly
  // good reduced artifact for a several-hundred-byte stub. The reduction is now driven by a
  // predicate that measures the file, so a miss is not a thing that can happen: it keeps reducing.
  const details: string[] = [];
  for (let index = 0; index < 120_000; index += 1) {
    details.push(`✓ cmd-${index}: node packages/main/dist/tasks/example.js`);
    if (index % 2 === 0) details.push(`  ${'"'.repeat(400)}`);
  }
  const bound = persist(validationResult([], { details }));
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, 'the heterogeneous artifact is brought under the bound');
  assert.notEqual(
    bound.disposition,
    'verdict_only',
    'a reducible artifact must be REDUCED, never discarded for the fallback stub',
  );
  const parsed = JSON.parse((bound.record as any).output);
  assert.ok(Array.isArray(parsed.details) && parsed.details.length > 100, `real evidence survives (${parsed.details?.length ?? 0} detail lines kept)`);
  assert.ok(parsed.details.some((line: string) => line.startsWith('✓ cmd-')), 'the surviving lines are the navigable per-command index');
  console.log('✓ heterogeneous density is reduced to fit rather than discarded for the stub');
  console.log(`    disposition=${bound.disposition} fileBytes=${bound.fileBytes} detailsKept=${parsed.details.length}`);
}

// ── 10. An unmeetable bound is refused, and the text says refusal rather than reassurance. ───────
{
  // Bulk in a sibling field the writer must NOT mangle: verificationCoverage is read by the phase
  // gate, so silently trimming it would trade a size defect for an admissibility defect. The honest
  // outcome is a refusal the caller acts on.
  const heavyCoverage = { entries: Array.from({ length: 200_000 }, (_, index) => ({ itemId: `CHK-${index}`, note: 'n'.repeat(200) })) };
  const bound = boundPersistedValidationEvidence({
    result: validationResult([commandResult('cmd-0', 1_000)]),
    buildRecord: (output) => ({ ...buildRecord(output), verificationCoverage: heavyCoverage }),
  });
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, false, 'a record whose non-output fields exceed the bound is refused');
  assert.equal(bound.disposition, 'refused', 'and the disposition says so');
  assert.ok(bound.fileBytes >= VALIDATION_EVIDENCE_BOUND_BYTES, 'the refusal rests on a real measurement');
  const advisory = formatValidationEvidenceAdvisory(bound);
  assert.ok(advisory, 'the refusal produces operator-facing text');
  assert.match(advisory!, /evidence size limit reached/, 'the refusal text does not open as an advisory');
  assert.match(advisory!, /write is refused/, 'it states that the write does not happen');
  assert.doesNotMatch(advisory!, /verdict is unchanged/, 'and it does NOT claim the verdict is unchanged, because on this path the evidence write fails');
  assert.ok(advisory!.includes(String(bound.fileBytes)), 'it names the measured file size');
  console.log('✓ an unmeetable bound is refused, with text that reads as a refusal');
  console.log(`    fileBytes=${bound.fileBytes} disposition=${bound.disposition}`);
}

// ── 11. The advisory names size and limit, and cannot be mistaken for a failure. ─────────────────
{
  const commands = Array.from({ length: 900 }, (_, index) => commandResult(`cmd-${index}`, 12_000));
  const bound = persist(validationResult(commands));
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.state, 'advisory', 'this fixture lands in the advisory band');
  const advisory = formatValidationEvidenceAdvisory(bound);
  assert.ok(advisory, 'an artifact past the advisory fraction produces an advisory');
  assert.ok(advisory!.includes(String(bound.fileBytes)), 'the advisory names the MEASURED file size');
  assert.ok(advisory!.includes(String(VALIDATION_EVIDENCE_READ_CEILING_BYTES)), 'the advisory names the configured limit');
  assert.match(advisory!, /advisory/i, 'the advisory says it is an advisory');
  assert.match(advisory!, /informational/i, 'the advisory states that it is informational');
  assert.match(advisory!, /verdict is unchanged/i, 'and on this path the verdict genuinely is unchanged');
  assert.doesNotMatch(advisory!, /\bfail(ed|ure|s)?\b/i, 'the advisory contains no failure vocabulary');
  assert.doesNotMatch(advisory!, /\berrors?\b/i, 'the advisory contains no error vocabulary');
  assert.doesNotMatch(advisory!, /[✗✘×]/, 'the advisory carries no failure glyph');
  console.log('✓ advisory names measured size and limit and cannot be read as a failure');
  console.log(`    fileBytes=${bound.fileBytes} state=${bound.state}`);
}

// ── 12. Bounding never mutates the caller result or its verdict. ─────────────────────────────────
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 100_000)));
  const before = JSON.stringify({ allPass: result.allPass, status: result.status, commandCount: (result.commands as unknown[]).length, detailCount: (result.details as unknown[]).length });
  const bound = persist(result);
  const after = JSON.stringify({ allPass: result.allPass, status: result.status, commandCount: (result.commands as unknown[]).length, detailCount: (result.details as unknown[]).length });
  assert.equal(after, before, 'bounding must not mutate the caller result: the verdict object it returns is what validate reports');
  assert.equal(JSON.parse((bound.record as any).output).allPass, result.allPass, 'the bounded copy carries the same verdict as the live result');
  console.log('✓ advisory is log-only and bounding never mutates the caller result or its verdict');
}

// ── 13. CHK-004 disposition: outcome A shipped, wired into BOTH evidence write paths. ────────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../../..');
  const verifier = readFileSync(resolve(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
  assert.ok(verifier.includes('boundPersistedValidationEvidence('), 'the bound is wired into the evidence write path');
  assert.ok(
    !/output:\s*JSON\.stringify\(result\)/.test(verifier),
    'the unbounded serialisation is gone from the executed path',
  );
  assert.ok(
    !/output:\s*JSON\.stringify\(reused\)/.test(verifier),
    'and from the reuse path, which F-014 found bypassing the bound entirely',
  );
  const reuseSlice = verifier.slice(verifier.indexOf('function reusedStoryValidationResult'));
  assert.ok(
    reuseSlice.slice(0, reuseSlice.indexOf('\nfunction ')).includes('boundPersistedValidationEvidence('),
    'the reuse path bounds its record too',
  );
  const rationale = resolve(repoRoot, 'docs/requirements/decisions/validation-evidence-artifact-growth.md');
  assert.ok(!existsSync(rationale), 'outcome B must NOT also exist: CHK-004 requires exactly one shipped disposition');
  console.log('✓ CHK-004 disposition observed: outcome A (bound ships) is wired into persistStoryValidationEvidence, outcome B absent');
}

console.log('validation-evidence-buffer-smoke: PASS');
