#!/usr/bin/env node
/**
 * B-3434 — deterministic, OFFLINE smoke for the validation evidence sizing model. No git, no
 * network, no spawned process: pure-Fn assertions over classifyValidationEvidenceSize,
 * boundValidationEvidenceOutput, boundPersistedValidationEvidence and
 * formatValidationEvidenceAdvisory. It DOES read repository files with readFileSync and existsSync -
 * handlers/verifier.ts and the CHK-004 decision document, because the disposition section observes
 * the shipped wiring rather than inferring it - so this is filesystem-reading but filesystem-writing
 * free, and it says so rather than claiming a purity it does not have.
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
 *   F-014 (the boundary) — the bound measures a candidate record with the serialisation format used
 *   by StoryStore today, rather than bounding only its inner output string. This catches the second
 *   escaping pass in the current format. It does not guarantee that StoryStore's later, independent
 *   serialisation writes those same bytes; that limitation is retained in the decision document.
 *
 *   F-029 / F-030 / F-031 / F-032 (the same defect, four more doors) — every one of these was a
 *   claim about the bound that was wider than the code: a gate measuring a record the write then
 *   added fields to, an array slipping through a `typeof` test into a verdict record it never
 *   carried, a size reported for one reading of a value free to serialise differently on the next,
 *   and a failure path that answered a throwing builder by calling it again. They are covered
 *   executably here rather than described, because seven rounds of narrowing the prose did not stop
 *   the class.
 *
 * Prints `validation-evidence-buffer-smoke: PASS` on success; throws (non-zero exit) on any failed
 * assertion.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
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
    command: 'proof-or-stop validate --story=B-3434 --json',
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
 * Every node of the candidate record returned by the bound must be plain JSON data.
 *
 * This checks the returned snapshot at the instant the bound is evaluated: it contains JSON scalars,
 * arrays and plain objects, with no own getter or visible `toJSON`. It does not freeze the shared
 * `Object.prototype`; installing an inherited `toJSON` after this check can still change the later
 * writer serialisation. That retained limitation is recorded in the CHK-004 decision document.
 */
function assertPlainJsonData(value: unknown, path: string): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return;
  assert.equal(kind, 'object', `${path}: a returned candidate record carries only JSON scalars and containers (found ${kind})`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlainJsonData(entry, `${path}[${index}]`));
    return;
  }
  const prototype = Object.getPrototypeOf(value as object);
  assert.ok(
    prototype === Object.prototype || prototype === null,
    `${path}: a returned candidate record carries standard or null-prototype containers; later shared-prototype mutation remains outside this check`,
  );
  assert.equal(
    typeof (value as { toJSON?: unknown }).toJSON,
    'undefined',
    `${path}: a value with toJSON can serialise differently on the write than it did on the measurement`,
  );
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(value as object, key);
    assert.equal(typeof descriptor?.get, 'undefined', `${path}.${key}: a getter can return a different value on each read`);
    assertPlainJsonData(entry, `${path}.${key}`);
  }
}

/**
 * The check applied to every case: the reported size must be a real measurement of the returned
 * snapshot at check time, and the flag must be derived from it. It does not claim that later mutation
 * of the shared prototype cannot alter writer serialisation. An earlier revision reported a hardcoded
 * success flag, and every fixture passed while it was structurally unable to say no.
 */
function assertFlagAgreesWithMeasurement(bound: ReturnType<typeof persist>): void {
  if (bound.record === null) {
    // No record is not a small record. The refusal shape is fixed so a caller cannot read a missing
    // record as an admissible one.
    assert.equal(bound.withinBound, false, 'a record that could not be produced is never reported as within bound');
    assert.equal(bound.disposition, 'refused', 'and its disposition says refused');
    assert.equal(bound.fileBytes, Number.MAX_SAFE_INTEGER, 'and it carries no size that could be compared favourably to the bound');
    return;
  }
  assertPlainJsonData(bound.record, 'bound.record');
  const actual = measurePersistedEvidenceBytes(bound.record);
  assert.notEqual(actual, null, 'the returned candidate record is measurable');
  assert.equal(bound.fileBytes, actual, 'fileBytes is the check-time measurement of the returned candidate record');
  assert.equal(
    bound.withinBound,
    actual! < VALIDATION_EVIDENCE_BOUND_BYTES,
    `withinBound must be derived from the candidate measurement (flag=${bound.withinBound}, actual=${actual}, bound=${VALIDATION_EVIDENCE_BOUND_BYTES})`,
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
    provider: 'proof-or-stop-verifier',
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

// ── 3. The measurement applies the two-space format. This section does NOT pin it to store.ts. ───
{
  // measurePersistedEvidenceBytes duplicates a format owned by core/store.ts, which is outside this
  // story's allowed scope. This section does not close that: it re-types the same formula rather
  // than importing StoryStore, so both copies move together and a store.ts format change leaves
  // every assertion here passing while the measurement reads low. Measured on a two-space to
  // four-space change: expected 158, measured 158, writer 168, smoke still passing. B-3434:F-033.
  // A writer-owned boundary would close this narrower byte-identity gap; the decision document
  // preserves the limitation and records why no active follow-up is currently justified.
  const record = buildRecord('{"allPass":true}');
  const expected = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  assert.equal(measurePersistedEvidenceBytes(record), expected, 'the measurement is JSON.stringify(record, null, 2) + newline, which is what store.ts writes today - compared against a second copy of that formula, not against store.ts');
  assert.equal(measurePersistedEvidenceBytes({ cycle: (() => { const o: any = {}; o.self = o; return o; })() }), null, 'an unserialisable record measures null rather than throwing');
  console.log('✓ the candidate measurement applies the current two-space format (a duplicate of core/store.ts, not a pin of it)');
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

// ── 5. F-014: quote-heavy output, where the second escaping pass expands the candidate record. ───
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
    `the unbounded candidate serialisation breaches the read ceiling (${unboundedFile} vs ${VALIDATION_EVIDENCE_READ_CEILING_BYTES})`,
  );
  assert.ok(
    unboundedFile > innerOnly.serializedBytes * 1.5,
    `the second escaping pass expands the candidate serialisation substantially (inner ${innerOnly.serializedBytes}, candidate ${unboundedFile})`,
  );

  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, `the measured candidate record must be brought under the bound (${bound.fileBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`);
  assert.ok(bound.fileBytes < VALIDATION_EVIDENCE_READ_CEILING_BYTES, 'and its check-time measurement is under the configured read ceiling');
  const parsed = JSON.parse((bound.record as any).output);
  assert.equal(parsed.allPass, true, 'the verdict survives the reduction');
  assert.equal(bound.disposition, 'reduced', 'escaping expansion is handled by re-reducing, not by collapsing to the fallback');
  assert.ok(Array.isArray(parsed.commands) && parsed.commands.length > 0, 'per-command evidence survives the expansion-aware retry');
  console.log('✓ quote-heavy output is bounded against the candidate serialisation used at check time');
  console.log(`    innerBytes=${innerOnly.serializedBytes} unboundedFile=${unboundedFile} boundedFile=${bound.fileBytes}`);
}

// ── 6. Past the bound: markers stay visible and the JSON contract survives. ──────────────────────
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 100_000)));
  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, 'the measured candidate record is brought under the bound');
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
  console.log('✓ the oversized candidate record is reduced with visible markers and JSON contract intact');
  console.log(`    fileBytes=${bound.fileBytes} elidedCommandOutputs=${bound.sizing!.elidedCommandOutputs} elidedDetailLines=${bound.sizing!.elidedDetailLines}`);
}

// ── 7. Bulk that is not captured output: entries are capped WITH A COUNT, never dropped silently. ─
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 0, 100_000)));
  const bound = persist(result);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, true, 'the measured candidate record is brought under the bound');
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
  // the bounding function measures the candidate record and returns a fallback sized by construction.
  for (const [label, overrides] of [
    ['unknown field', { someFieldAddedLater: 'z'.repeat(30 * MIB) }],
    ['key name', { ['k'.repeat(30_000_000)]: 1 }],
    ['verdict-bearing scalar', { summary: 's'.repeat(30 * MIB) }],
  ] as Array<[string, Record<string, unknown>]>) {
    const bound = persist(validationResult([], overrides));
    assertFlagAgreesWithMeasurement(bound);
    assert.equal(bound.withinBound, true, `${label}: the measured candidate record is brought under the bound`);
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
    assert.notEqual((bound.record as any).output, 'null', `${label}: an unserialisable result is never returned as a bare-null candidate, which would read as a silent not-a-pass`);
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
  // predicate that measures each candidate serialisation, so a miss inside this function is not a
  // thing that can happen: it keeps reducing. This says nothing about a later StoryStore reading.
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

// ── 9d. An oversized ARRAY is refused too: `typeof [] === 'object'` put it on the wrong side. ────
{
  // The guard above tests `typeof args.result !== 'object'`, which an array passes, so an oversized
  // array used to fall through into the reduction, find no commands / details / warnings to work on,
  // and land on the verdict-only fallback: a few hundred bytes asserting allPass and status that the
  // array never carried. That is the same invention section 9b refuses for a string, reached through
  // a different door - measured at disposition=verdict_only, fileBytes=470 before the guard named
  // arrays explicitly.
  const oversized = Array.from({ length: 300_000 }, () => 'x'.repeat(100));
  const unboundedFile = measurePersistedEvidenceBytes(buildRecord(JSON.stringify(oversized)))!;
  assert.ok(
    unboundedFile >= VALIDATION_EVIDENCE_BOUND_BYTES,
    `the candidate serialisation genuinely exceeds the bound (${unboundedFile} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  const bound = persist(oversized);
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.withinBound, false, 'an oversized array reports withinBound false');
  assert.equal(bound.disposition, 'refused', 'and is refused rather than given a verdict record it never carried');
  assert.equal(bound.sizing, null, 'no reduction was attempted: an array has none of the dimensions the reducer models');
  assert.ok(bound.fileBytes >= VALIDATION_EVIDENCE_BOUND_BYTES, 'the refusal rests on a real measurement');
  // The refusal is about size, not about arrays being unwelcome: a small one is measured and
  // reported like any other input the reducer has no structure for.
  const small = persist(['a', 'b', 'c']);
  assertFlagAgreesWithMeasurement(small);
  assert.equal(small.disposition, 'unmodified', 'a small array is returned unmodified after measurement');
  assert.equal(small.withinBound, true, 'and is admissible');
  console.log('✓ an oversized array is refused rather than handed a verdict record it never carried');
  console.log(`    unboundedFile=${unboundedFile} fileBytes=${bound.fileBytes} disposition=${bound.disposition}`);
}

// ── 10. An unmeetable bound is refused, and the text says refusal rather than reassurance. ───────
{
  // Bulk in a sibling field the reducer must NOT mangle: verificationCoverage is read by the phase
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
  assert.ok(advisory!.includes(String(bound.fileBytes)), 'it names the check-time candidate size');
  console.log('✓ an unmeetable bound is refused, with text that reads as a refusal');
  console.log(`    fileBytes=${bound.fileBytes} disposition=${bound.disposition}`);
}

// ── 10b. The gate measures the candidate offered to the writer, hash fields included. ─────────────
{
  // persistStoryValidationEvidence computes the bound once, after the hash fields are known. The
  // defect that repairs: the gate measured the record WITHOUT headHash / materialHash /
  // storyFilesHash and the write added them, so a record sitting in that ~232-byte window passed a
  // check it would have failed. The buildRecord at the top of this file always carries fixed hash
  // placeholders, so it structurally cannot exercise that boundary - this fixture is built to sit
  // inside it.
  const HASH_FIELDS = { headHash: 'a'.repeat(40), materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) };
  // Padding in a field the reducer does not model (as in section 10), so the record's size is set by
  // `pad` alone and no reduction can carry it back across the boundary.
  const windowRecord = (output: string, pad: number, withHashes: boolean): Record<string, unknown> => ({
    command: 'proof-or-stop validate --story=B-3434 --json',
    output,
    result: 'PASS',
    timestamp: '2026-08-15T00:00:00.000Z',
    ...(withHashes ? HASH_FIELDS : {}),
    verificationCoverage: { pad: 'p'.repeat(pad) },
    commandExecution: { commandCount: 1 },
    disposition: 'executed',
  });
  const result = validationResult([]);
  // The smallest output this result can produce: its own serialisation. The verdict-only fallback is
  // LARGER than this, so no path through the bounding function can shrink the candidate below this
  // size, and the refusal asserted below cannot be an artefact of reduction not having been tried.
  const smallestOutput = JSON.stringify(result);
  const baseBytes = measurePersistedEvidenceBytes(windowRecord(smallestOutput, 0, false))!;
  const hashDelta = measurePersistedEvidenceBytes(windowRecord(smallestOutput, 0, true))! - baseBytes;
  assert.ok(hashDelta > 0, `the hash fields cost real bytes (${hashDelta})`);
  // One byte under the bound without the hash fields; hashDelta bytes over it with them.
  const pad = VALIDATION_EVIDENCE_BOUND_BYTES - baseBytes - 1;

  const withoutHashes = boundPersistedValidationEvidence({
    result,
    buildRecord: (output) => windowRecord(output, pad, false),
  });
  assertFlagAgreesWithMeasurement(withoutHashes);
  assert.equal(withoutHashes.fileBytes, VALIDATION_EVIDENCE_BOUND_BYTES - 1, 'the fixture sits exactly one byte under the bound without the hash fields');
  assert.equal(withoutHashes.withinBound, true, 'so a gate that measured the record without them would admit it');

  const withHashes = boundPersistedValidationEvidence({
    result,
    buildRecord: (output) => windowRecord(output, pad, true),
  });
  assertFlagAgreesWithMeasurement(withHashes);
  assert.equal(withHashes.withinBound, false, 'the candidate passed to the writer does not fit at check time');
  assert.equal(withHashes.disposition, 'refused', 'and it is refused, not admitted on the strength of the smaller measurement');
  assert.ok(withHashes.fileBytes >= VALIDATION_EVIDENCE_BOUND_BYTES, 'the refusal rests on a measurement of the final record');
  assert.ok(withHashes.fileBytes > withoutHashes.fileBytes, 'the added fields are inside the number the gate reads');

  // The property above is only worth anything if the shipped call site is the one that behaves this
  // way, so read it. The defect shape to exclude is not "two computations" in the abstract - it is a
  // gate that reads one binding and a write that takes its record from ANOTHER, which is how the
  // ~232-byte window opened. So: every record written in that function must come from a bound whose
  // own withinBound was gated. Checking the names is what makes that mechanical.
  const here = dirname(fileURLToPath(import.meta.url));
  const verifierSource = readFileSync(resolve(here, '../../../..', 'packages/main/src/handlers/verifier.ts'), 'utf8');
  const persistFrom = verifierSource.slice(verifierSource.indexOf('\nfunction persistStoryValidationEvidence('));
  const persistBody = persistFrom.slice(0, persistFrom.indexOf('\nfunction ', 1));
  assert.ok(persistBody.length > 0, 'persistStoryValidationEvidence was located in the shipped source');
  const written = [...persistBody.matchAll(/writeTestEvidence\([^,]+,\s*([A-Za-z_$][\w$]*)\.record\s*\)/g)].map((match) => match[1]);
  assert.ok(written.length > 0, 'the function writes evidence through a bound record');
  for (const name of written) {
    assert.ok(
      persistBody.includes(`!${name}.withinBound`),
      `the record written from ${name} is the record whose own withinBound was gated, not a sibling computation of it`,
    );
    assert.ok(
      persistBody.includes(`${name}.record === null`),
      `and ${name} is proven to have produced a record before that record is written`,
    );
  }
  assert.equal(
    (persistBody.match(/boundEvidence\(hashes\)/g) || []).length,
    1,
    'the hashed bound is computed exactly once, so no second hashed computation can diverge from the gated one',
  );
  assert.match(persistBody, /const persistedBound = boundEvidence\(hashes\);/, 'the hashed computation is the one bound to the git path');
  assert.ok(written.includes('persistedBound'), 'and it is what the git path writes');
  console.log('✓ the size gate sees the candidate record with hash fields, and that bound result supplies the record passed to the writer');
  console.log(`    hashDelta=${hashDelta} withoutHashes=${withoutHashes.fileBytes} withHashes=${withHashes.disposition}`);
}

// ── 10c. Own volatile values are snapshotted; inherited prototype mutation remains possible. ────
{
  // The reported size described ONE reading of a live object; StoryStore performs another when it
  // writes. Any value free to answer differently on a later call - a getter, a Proxy, a toJSON -
  // makes those two readings different numbers, and the one that reaches disk is not the one that
  // was checked. Measured on the live-object revision, through the real StoryStore.writeTestEvidence:
  // fileBytes 82, withinBound true, disposition unmodified, and 36,000,077 bytes on disk against a
  // 25,165,824 ceiling.
  //
  // The counter answers small for the first two calls because that is how many readings the bounding
  // takes: a fixture that turned large on the first call would simply be measured large and refused,
  // and would prove nothing.
  let toJsonCalls = 0;
  const volatileField = {
    toJSON() {
      toJsonCalls += 1;
      return toJsonCalls <= 2 ? { state: 'small' } : { state: 'x'.repeat(34 * MIB) };
    },
  };
  const bound = boundPersistedValidationEvidence({
    result: validationResult([commandResult('cmd-0', 100)]),
    buildRecord: (output) => ({ ...buildRecord(output), volatileField }),
  });
  assertFlagAgreesWithMeasurement(bound);
  assert.notEqual(bound.record, null, 'the record was built');
  assert.equal(bound.withinBound, true, 'and the small record it measured is admissible');
  // Serialised well past the call at which the SOURCE object's own toJSON changed its answer. The
  // snapshot no longer consults that own method, so immediate remeasurement under the unchanged
  // shared prototype reproduces the count. This does not cover a later Object.prototype mutation.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(
      measurePersistedEvidenceBytes(bound.record),
      bound.fileBytes,
      `remeasuring the snapshot without intervening prototype mutation reproduces fileBytes (attempt ${attempt}, ${toJsonCalls} source toJSON calls so far)`,
    );
  }
  assert.equal(
    JSON.stringify((bound.record as any).volatileField),
    '{"state":"small"}',
    'the record carries the value that was measured, not a live source that can produce another one',
  );
  console.log('✓ own volatile source values are snapshotted at check time; inherited prototype mutation remains outside this assertion');
  console.log(`    fileBytes=${bound.fileBytes} toJSONCallsDuringBounding=${toJsonCalls}`);
}

// ── 10d. A builder that throws produces no record, on every branch that builds one. ──────────────
{
  // The failure path used to manufacture a record by calling the SAME builder again with a different
  // argument - unguarded, at a site reached only because that builder had just thrown. Two of the
  // four internal call sites have no enclosing try, so the second throw escaped the function. Both
  // are exercised here: an object result reaches the reducing branch, a string result reaches the
  // branch with no enclosing try at all.
  for (const [label, input] of [
    ['object result', validationResult([commandResult('cmd-0', 100)])],
    ['non-object result', 'a plain string result'],
    ['array result', ['an', 'array', 'result']],
  ] as Array<[string, unknown]>) {
    let builds = 0;
    let bound!: ReturnType<typeof persist>;
    assert.doesNotThrow(
      () => {
        bound = boundPersistedValidationEvidence({
          result: input,
          buildRecord: () => { builds += 1; throw new Error('buildRecord always throws'); },
        });
      },
      `${label}: a builder that throws is bounded, not propagated to the caller`,
    );
    assertFlagAgreesWithMeasurement(bound);
    assert.equal(bound.record, null, `${label}: there is no record, because there was nothing to build one from`);
    assert.equal(bound.disposition, 'refused', `${label}: the outcome is a refusal`);
    assert.equal(bound.withinBound, false, `${label}: which no caller can read as writable`);
    assert.ok(builds > 0, `${label}: the builder really was called`);
    console.log(`    ${label}: builds=${builds} record=${bound.record === null ? 'null' : 'present'} disposition=${bound.disposition}`);
  }
  console.log('✓ a throwing builder yields an honest refusal rather than a second unguarded build');
}

// ── 11. The advisory names size and limit, and cannot be mistaken for a failure. ─────────────────
{
  const commands = Array.from({ length: 900 }, (_, index) => commandResult(`cmd-${index}`, 12_000));
  const bound = persist(validationResult(commands));
  assertFlagAgreesWithMeasurement(bound);
  assert.equal(bound.state, 'advisory', 'this fixture lands in the advisory band');
  const advisory = formatValidationEvidenceAdvisory(bound);
  assert.ok(advisory, 'an artifact past the advisory fraction produces an advisory');
  assert.ok(advisory!.includes(String(bound.fileBytes)), 'the advisory names the check-time candidate size');
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

// ── 13. CHK-004 disposition: outcome B shipped; the limitation remains; follow-up is declined. ───
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
  // CHK-004 requires a BINDING disposition, and outcome B is the one that shipped: the reduction
  // above is wired into both write paths, but the byte-for-byte agreement between the number it
  // reports and the file on disk is not established from this side. The committed decision record
  // remains required audit evidence even though its later human decision declines an active
  // writer-owned-boundary follow-up. A bare existsSync would let an empty file satisfy that contract.
  const rationalePath = 'docs/requirements/decisions/validation-evidence-artifact-growth.md';
  const rationale = resolve(repoRoot, rationalePath);
  assert.ok(
    existsSync(rationale),
    `CHK-004 shipped outcome B (the reduction ships while byte-for-byte agreement remains a known limitation), so the committed decision record must exist at ${rationalePath}`,
  );
  const rationaleText = readFileSync(rationale, 'utf8');
  const rationaleDigest = createHash('sha256').update(rationaleText).digest('hex');
  assert.equal(
    rationaleDigest,
    '6041dbff24cba1df2c2a838d949df8d87a7eaf04a979525681456f5d994e614e',
    'the decision record changed after independent review; any wording change requires a new reviewed digest',
  );
  // Exactly one disposition is declared, and it is B. This is the mutual-exclusivity the outcome-A
  // guard used to get from the document's ABSENCE, re-expressed against the document's own structure
  // now that it is present.
  const declared = rationaleText.split('\n').filter((line) => line.startsWith('Disposition:'));
  assert.equal(declared.length, 1, `the rationale declares exactly one CHK-004 disposition (found ${declared.length})`);
  assert.equal(
    declared[0],
    'Disposition: outcome B (committed rationale). The reduction ships; the byte-for-byte agreement between the measured size and the file on disk does not.',
    'and the one it declares is outcome B in the retained decision record',
  );
  // The exact reviewed digest above catches every unreviewed edit, including paraphrased active
  // work-order language. These positive checks retain local diagnostics for the contract's key parts.
  for (const required of [
    '## Decision after B-3434',
    'Decision: decline the writer-owned canonical boundary as not currently justified.',
    'No follow-up story is planned or owned.',
    '## What ships',
    '## Known limitations retained from B-3434',
    '## Historical proposal: writer-owned canonical boundary',
    '## Known limitations',
    'writer-owned canonical boundary',
    'packages/main/src/core/store.ts',
    'Object.prototype',
    'B-3434:F-033',
    'B-3434:F-035',
    'B-3434:F-036',
    'B-3434:F-037',
  ]) {
    assert.ok(
      rationaleText.includes(required),
      `the decision record preserves required audit context: it names ${JSON.stringify(required)}`,
    );
  }
  // Read out of the document rather than restated beside it: a hardcoded list here would be one more
  // sentence owned somewhere else, which is the defect class this whole story kept reopening.
  const namedFindings = [...new Set(rationaleText.match(/B-3434:F-\d+/g) ?? [])].sort();
  console.log('✓ CHK-004 disposition observed: outcome B shipped, its limitations remain recorded, and no writer-owned-boundary follow-up is currently active');
  console.log(`    rationale=${rationalePath} bytes=${Buffer.byteLength(rationaleText, 'utf8')} findingIdsNamed=${namedFindings.join(',')}`);
}

console.log('validation-evidence-buffer-smoke: PASS');
