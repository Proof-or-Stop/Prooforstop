#!/usr/bin/env node
/**
 * B-3434 — deterministic, OFFLINE smoke for the validation evidence sizing model. No git, no
 * network, no filesystem: pure-Fn assertions over classifyValidationEvidenceSize,
 * boundValidationEvidenceOutput and formatValidationEvidenceAdvisory.
 *
 * What it protects, and why each part exists:
 *
 *   CHK-004 (the bound) — per-command output is already capped by trimOutput; the AGGREGATE grew
 *   with the number of configured validate commands until it passed the metadata read ceiling and
 *   no story could commit test-evidence.json at all. The bound must shrink the artifact WITHOUT
 *   breaking the JSON contract its consumers depend on, and without losing evidence silently.
 *
 *   CHK-005 (the advisory) — the cliff must be marked, not merely moved. The thresholds are
 *   fractions of the ceiling THIS story set in core/done-prepare-generated-metadata.ts, so a later
 *   change to that ceiling moves the advisory with it instead of leaving a stale number behind.
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
  boundValidationEvidenceOutput,
  classifyValidationEvidenceSize,
  formatValidationEvidenceAdvisory,
} from '../core/validation-executor.js';

const MIB = 1024 * 1024;

const OUTPUT_LINE_CHARS = 120;

/** Captured output as the executor actually captures it: many lines, not one long run. */
function capturedOutput(outputChars: number): string {
  if (outputChars === 0) return '';
  const lines: string[] = [];
  for (let written = 0; written < outputChars; written += OUTPUT_LINE_CHARS) {
    lines.push('o'.repeat(Math.min(OUTPUT_LINE_CHARS, outputChars - written)));
  }
  return lines.join('\n');
}

function commandResult(label: string, outputChars: number, argChars = 0): Record<string, unknown> {
  return {
    label,
    command: 'node',
    args: argChars > 0 ? [`--fixture=${'a'.repeat(argChars)}`] : ['packages/main/dist/tasks/example.js'],
    code: 0,
    output: capturedOutput(outputChars),
    durationMs: 12,
  };
}

/**
 * Build a result the way executeValidationPlan in core/validation-executor.ts actually builds one.
 *
 * The part that matters, and that an earlier version of this fixture got wrong by hardcoding
 * `details: []`: the executor pushes a status line per command AND THEN pushes every line of that
 * command captured output into `details`, indented by two spaces. So the artifact carries a SECOND
 * copy of the same bytes, slightly larger than the first. A fixture without it does not have the
 * shape the producer emits, and a bound tested only against that fixture looks complete while
 * leaving half the payload untouched - the same way small fixtures hid the original 1 MiB defect.
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
  assert.ok(
    VALIDATION_EVIDENCE_READ_CEILING_BYTES >= 10 * MIB,
    'the ceiling must sit at least an order of magnitude above the 1 MiB Node default',
  );
  assert.notEqual(VALIDATION_EVIDENCE_READ_CEILING_BYTES, MIB, 'the ceiling is not the old Node default');
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
  assert.ok(
    VALIDATION_EVIDENCE_ADVISORY_BYTES < VALIDATION_EVIDENCE_BOUND_BYTES,
    'the advisory must fire strictly before the bound, otherwise it is not advance notice',
  );
  assert.ok(
    VALIDATION_EVIDENCE_BOUND_BYTES < VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    'a bounded artifact must always be readable by the read whose ceiling bounds it',
  );
  console.log('✓ advisory and bound are fractions of the metadata read ceiling this story set');
}

// ── 2. Three tiers, with the boundary resolved deterministically on the higher side. ─────────────
{
  assert.equal(classifyValidationEvidenceSize(0), 'within_budget', 'an empty artifact is within budget');
  assert.equal(
    classifyValidationEvidenceSize(VALIDATION_EVIDENCE_ADVISORY_BYTES - 1),
    'within_budget',
    'one byte below the advisory threshold is still within budget',
  );
  assert.equal(
    classifyValidationEvidenceSize(VALIDATION_EVIDENCE_ADVISORY_BYTES),
    'advisory',
    'EXACTLY at the advisory threshold resolves to advisory: each threshold is inclusive of the higher tier',
  );
  assert.equal(
    classifyValidationEvidenceSize(VALIDATION_EVIDENCE_BOUND_BYTES - 1),
    'advisory',
    'one byte below the bound is advisory, not bounded',
  );
  assert.equal(
    classifyValidationEvidenceSize(VALIDATION_EVIDENCE_BOUND_BYTES),
    'bounded',
    'EXACTLY at the bound resolves to bounded',
  );
  console.log('✓ within_budget / advisory / bounded tiers with an inclusive, deterministic boundary');
}

// ── 3. Today's repository shape is untouched: no advisory, no bounding, byte-identical output. ───
{
  // 100 configured commands at the trimOutput cap (12,000 chars) is the shape that measured
  // 1,369,692 bytes on story B-9ff1 — the size that used to be fatal, and must now be ordinary.
  const result = validationResult(Array.from({ length: 100 }, (_, index) => commandResult(`cmd-${index}`, 12_000)));
  const bounded = boundValidationEvidenceOutput(result);
  assert.ok(bounded.measuredBytes > MIB, `the realistic artifact is genuinely past 1 MiB (${bounded.measuredBytes})`);
  assert.equal(bounded.state, 'within_budget', 'a 100-command artifact is within budget under the new ceiling');
  assert.equal(bounded.bounded, false, 'nothing is bounded at the current command count');
  assert.equal(bounded.output, JSON.stringify(result), 'an unbounded artifact serialises byte-identically to before');
  assert.equal(formatValidationEvidenceAdvisory(bounded), null, 'an artifact below the advisory fraction prints no advisory');
  // The stable sentence carries no runtime number: a selector pinned to a measured byte count is
  // stranded by the next fixture change, and a pin is immutable once bound.
  console.log('✓ realistic 100-command artifact is unbounded and silent');
  console.log(`    measured=${bounded.measuredBytes} bytes state=${bounded.state}`);
}

// ── 4. Past the advisory fraction: an advisory that names the size and the limit, and nothing else. ─
{
  const sizing = {
    measuredBytes: VALIDATION_EVIDENCE_ADVISORY_BYTES + 1,
    serializedBytes: VALIDATION_EVIDENCE_ADVISORY_BYTES + 1,
    ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    advisoryBytes: VALIDATION_EVIDENCE_ADVISORY_BYTES,
    boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
    state: 'advisory' as const,
    bounded: false,
    elidedCommandOutputs: 0,
    elidedCommandEntries: 0,
    elidedDetailLines: 0,
    elidedWarnings: 0,
    droppedKeys: [],
  };
  const advisory = formatValidationEvidenceAdvisory(sizing);
  assert.ok(advisory, 'an artifact past the advisory fraction produces an advisory');
  assert.ok(advisory!.includes(String(sizing.measuredBytes)), 'the advisory names the MEASURED size');
  assert.ok(advisory!.includes(String(VALIDATION_EVIDENCE_READ_CEILING_BYTES)), 'the advisory names the configured limit');
  assert.ok(advisory!.includes(String(VALIDATION_EVIDENCE_ADVISORY_BYTES)), 'the advisory names the threshold it crossed');
  // A reader scanning output must not mistake it for a failing check.
  assert.match(advisory!, /advisory/i, 'the advisory says it is an advisory');
  assert.match(advisory!, /informational/i, 'the advisory states that it is informational');
  assert.match(advisory!, /verdict is unchanged/i, 'the advisory states that the verdict is unchanged');
  assert.doesNotMatch(advisory!, /\bfail(ed|ure|s)?\b/i, 'the advisory contains no failure vocabulary');
  assert.doesNotMatch(advisory!, /\berrors?\b/i, 'the advisory contains no error vocabulary');
  assert.doesNotMatch(advisory!, /[✗✘×]/, 'the advisory carries no failure glyph');
  console.log('✓ advisory names measured size and limit and cannot be read as a failure');
}

// ── 5. Past the bound: a valid, bounded artifact with visible markers and no silent loss. ────────
{
  // 300 commands x 100,000 chars ≈ 30 MB — comfortably past the bound.
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 100_000)));
  const bounded = boundValidationEvidenceOutput(result);
  assert.ok(
    bounded.measuredBytes >= VALIDATION_EVIDENCE_BOUND_BYTES,
    `the fixture must genuinely exceed the bound (${bounded.measuredBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  assert.equal(bounded.state, 'bounded', 'an artifact past the bound classifies as bounded');
  assert.equal(bounded.bounded, true, 'the bound is ENFORCED, not merely declared');
  const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
  assert.equal(serializedBytes, bounded.serializedBytes, 'the reported serialised size is the real one');
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    `the bounded artifact is under the bound (${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    'the bounded artifact is readable by the metadata blob read that consumes it',
  );

  // The JSON contract survives: consumers reject an unparseable artifact (output_invalid_json) and
  // an artifact that is not allPass (output_not_all_pass). Bounding must break neither.
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.allPass, true, 'bounding preserves allPass, so the pass verdict is unchanged');
  assert.equal(parsed.status, 'pass', 'bounding preserves status');
  assert.equal(parsed.summary, result.summary, 'bounding preserves the summary');

  // Command entries keep their identity; only bulk is replaced, and every replacement is visible.
  assert.equal(
    parsed.commands.length + bounded.elidedCommandEntries,
    300,
    'every command entry is either present or counted — nothing vanishes silently',
  );
  assert.ok(bounded.elidedCommandOutputs > 0, 'at least one captured output was elided');
  const markers = parsed.commands.filter((command: any) => String(command.output).startsWith('[evidence bound:'));
  assert.match(String(markers[0].output), /\d+ chars of captured output omitted/, 'the marker names how much was omitted');
  assert.match(String(markers[0].output), new RegExp(String(VALIDATION_EVIDENCE_BOUND_BYTES)), 'the marker names the bound');
  for (const command of parsed.commands) {
    assert.ok(typeof command.label === 'string' && command.label.length > 0, 'entry identity survives elision');
    assert.equal(typeof command.code, 'number', 'entry exit code survives elision');
  }
  assert.equal(parsed.evidenceBound.elidedCommandOutputs, bounded.elidedCommandOutputs, 'the artifact states the elision count');
  assert.equal(parsed.evidenceBound.measuredBytes, bounded.measuredBytes, 'the artifact states the measured size');
  assert.equal(parsed.evidenceBound.boundBytes, VALIDATION_EVIDENCE_BOUND_BYTES, 'the artifact states the bound');
  // The duplicated copy in details must be bounded too, not just the copy in commands.
  assert.ok(
    Buffer.byteLength(JSON.stringify(parsed.details), 'utf8') < VALIDATION_EVIDENCE_BOUND_BYTES,
    'the details copy of the same bytes is bounded as well',
  );

  const advisory = formatValidationEvidenceAdvisory(bounded);
  assert.ok(advisory, 'a bounded artifact still reports its advisory');
  assert.ok(advisory!.includes(String(bounded.measuredBytes)), 'the bounded advisory names the measured size');
  assert.ok(advisory!.includes(String(VALIDATION_EVIDENCE_READ_CEILING_BYTES)), 'the bounded advisory names the ceiling');
  assert.doesNotMatch(advisory!, /\bfail(ed|ure|s)?\b/i, 'even the bounded advisory carries no failure vocabulary');
  console.log('✓ oversized realistic artifact is bounded with visible markers and JSON contract intact');
  console.log(`    measured=${bounded.measuredBytes} serialised=${serializedBytes} elidedCommandOutputs=${bounded.elidedCommandOutputs} elidedDetailLines=${bounded.elidedDetailLines}`);
}

// ── 6. Bulk outside captured output: entries are capped WITH A COUNT, never dropped silently. ────
{
  // Nothing here is elidable output; the weight is in args, so tier 1 cannot help and tier 2 runs.
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 0, 100_000)));
  const bounded = boundValidationEvidenceOutput(result);
  assert.ok(bounded.measuredBytes >= VALIDATION_EVIDENCE_BOUND_BYTES, 'the fixture exceeds the bound');
  assert.equal(bounded.bounded, true, 'the bound is enforced even when no captured output can be elided');
  assert.ok(
    Buffer.byteLength(bounded.output, 'utf8') < VALIDATION_EVIDENCE_BOUND_BYTES,
    'the artifact is brought under the bound',
  );
  assert.ok(bounded.elidedCommandEntries > 0, 'tier 2 capped the entry count');
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.allPass, true, 'capping entries still preserves the pass verdict');
  assert.equal(
    parsed.commands.length + bounded.elidedCommandEntries,
    300,
    'every omitted entry is accounted for by the reported count — nothing vanishes silently',
  );
  assert.equal(
    parsed.evidenceBound.elidedCommandEntries,
    bounded.elidedCommandEntries,
    'the artifact itself carries the diagnostic count of omitted entries',
  );
  // The phrase "non-output bulk capped" is contiguous on purpose: CHK-004:adversarial:1 is pinned
  // to that literal substring and a pin is immutable once bound, so the wording is load-bearing.
  console.log('✓ non-output bulk capped with a diagnostic count');
  console.log(`    elidedCommandEntries=${bounded.elidedCommandEntries} serialised=${Buffer.byteLength(bounded.output, 'utf8')}`);
}

// ── 7. details ALONE past the bound: the second copy of the same bytes must be bounded too. ──────
{
  // The shape executeValidationPlan emits once command output has already been elided: the status
  // lines and the indented duplicate remain in `details`, and at 2,800 commands x 12,000 chars that
  // array alone serialises past both the bound and the ceiling. Bounding `commands` cannot help
  // here, because `commands` carries nothing.
  const details: string[] = [];
  for (let index = 0; index < 2_800; index += 1) {
    details.push(`✓ cmd-${index}: node packages/main/dist/tasks/example.js`);
    details.push(...capturedOutput(12_000).split('\n').map((line) => `  ${line}`));
  }
  const result = validationResult([], { details });
  const detailsBytes = Buffer.byteLength(JSON.stringify(details), 'utf8');
  assert.ok(
    detailsBytes >= VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    `details alone must genuinely breach the ceiling (${detailsBytes} vs ${VALIDATION_EVIDENCE_READ_CEILING_BYTES})`,
  );
  const bounded = boundValidationEvidenceOutput(result);
  const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
  assert.equal(bounded.serializedBytes, serializedBytes, 'the reported serialised size is the real one');
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    `bulk carried ONLY in details must still be brought under the bound `
      + `(${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  assert.ok(bounded.elidedDetailLines > 0, 'the elided detail lines are counted');
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.allPass, true, 'bounding details preserves the pass verdict');
  assert.ok(Array.isArray(parsed.details), 'details remains an array of strings');
  assert.ok(
    parsed.details.some((line: string) => line.startsWith('[evidence bound:')),
    'the elision is visible inside details, not silent',
  );
  assert.ok(
    parsed.details.some((line: string) => line.startsWith('✓ cmd-')),
    'the per-command status lines survive: they are the navigable index a reader scans',
  );
  assert.equal(
    parsed.evidenceBound.elidedDetailLines,
    bounded.elidedDetailLines,
    'the artifact itself carries the count of omitted detail lines',
  );
  console.log('✓ details-only bulk is bounded: the duplicated copy of command output is elided too');
  console.log(`    detailsBytes=${detailsBytes} serialised=${serializedBytes} elidedDetailLines=${bounded.elidedDetailLines}`);
}

// ── 8. Unknown bulk: the bound is a POST-CONDITION, not a list of fields someone remembered. ─────
{
  // details was one duplicate copy; assuming it is the last one is how this defect recurs. A field
  // this function has never heard of must not be able to breach the bound either.
  const result = validationResult([commandResult('cmd-0', 1_000)], {
    verificationCoverage: { entries: Array.from({ length: 20_000 }, (_, index) => ({ itemId: `CHK-${index}`, lane: 'happy', note: 'x'.repeat(1_000) })) },
    someFieldAddedLater: 'z'.repeat(30 * MIB),
  });
  const bounded = boundValidationEvidenceOutput(result);
  const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
  assert.ok(
    bounded.measuredBytes > VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    'the fixture carries bulk in fields the bounding logic does not know about',
  );
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    `the bound holds for bulk in unknown fields too (${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.allPass, true, 'the verdict survives even the last-resort bounding');
  assert.equal(parsed.status, 'pass', 'the status survives even the last-resort bounding');
  assert.ok(parsed.evidenceBound, 'the artifact always says that and how it was bounded');
  assert.ok(
    Array.isArray(parsed.evidenceBound.droppedKeys) && parsed.evidenceBound.droppedKeys.includes('someFieldAddedLater'),
    'a dropped top-level field is named, so the loss is stated rather than silent',
  );
  console.log('✓ unknown-field bulk is bounded and the dropped top-level fields are named');
  console.log(`    measured=${bounded.measuredBytes} serialised=${serializedBytes} droppedKeys=${bounded.droppedKeys.join(',')}`);
}

// ── 8b. The postcondition is measured, not inferred, even when every known reduction is useless. ─
{
  // Bulk in fields no reduction strategy models: verdict-bearing scalars themselves. If the
  // postcondition were "the loops ran" this would return an oversized artifact reporting success.
  const result = validationResult([], {
    summary: 's'.repeat(20 * MIB),
    provider: 'p'.repeat(20 * MIB),
  });
  const bounded = boundValidationEvidenceOutput(result);
  const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
  assert.ok(bounded.measuredBytes > VALIDATION_EVIDENCE_READ_CEILING_BYTES, 'the fixture starts above the ceiling');
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    `the postcondition holds when no modelled reduction can help (${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  assert.equal(bounded.serializedBytes, serializedBytes, 'the reported size is the measured size, not an estimate');
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.allPass, true, 'the bounded artifact still carries allPass, which is what the phase gate parses');
  assert.equal(parsed.status, 'pass', 'the bounded artifact still carries status');
  // Assert the PROPERTY, not the mechanism: whichever stage got there, the loss must be stated.
  const lossStated = parsed.evidenceBound.replacedWithVerdictOnlyRecord === true
    || parsed.evidenceBound.droppedKeys.includes('summary')
    || parsed.evidenceBound.droppedKeys.includes('provider');
  assert.ok(lossStated, 'whichever reduction got under the bound, the artifact states what it lost');
  console.log('✓ postcondition holds even when the bulk is in verdict-bearing fields');
  console.log(`    measured=${bounded.measuredBytes} serialised=${serializedBytes} droppedKeys=${parsed.evidenceBound.droppedKeys.join(',')}`);
}

// ── 8b-ii. The last-resort record itself: bulk that no reduction stage can shrink. ───────────────
{
  // A verdict-bearing key holding a huge NON-string: string truncation cannot touch it and stage 5
  // must not drop a verdict key, so the only way to satisfy the postcondition is the fallback.
  const result = validationResult([], {
    summary: Array.from({ length: 400_000 }, (_, index) => ({ index, note: 'n'.repeat(60) })),
  });
  const bounded = boundValidationEvidenceOutput(result);
  const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
  assert.ok(bounded.measuredBytes > VALIDATION_EVIDENCE_READ_CEILING_BYTES, 'the fixture starts above the ceiling');
  assert.ok(
    serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    `the last-resort record satisfies the postcondition (${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
  );
  assert.ok(serializedBytes < 2_000, `the last-resort record is sized independently of the input (${serializedBytes} bytes)`);
  const parsed = JSON.parse(bounded.output);
  assert.equal(parsed.evidenceBound.replacedWithVerdictOnlyRecord, true, 'the record says of itself that it is a replacement');
  assert.ok(String(parsed.evidenceBound.reason).length > 0, 'the record states why it replaced the full artifact');
  assert.equal(parsed.allPass, true, 'the last-resort record preserves the consumer contract: allPass');
  assert.equal(parsed.status, 'pass', 'the last-resort record preserves the consumer contract: status');
  assert.equal(parsed.evidenceBound.measuredBytes, bounded.measuredBytes, 'the record names the size it replaced');
  console.log('✓ last-resort record is admissible, self-describing and input-independent in size');
  console.log(`    measured=${bounded.measuredBytes} serialised=${serializedBytes}`);
}

// ── 8c. The reviewer's reported scales: 2,100 and 2,800 commands at the trimOutput cap. ──────────
{
  for (const commandCount of [2_100, 2_800]) {
    const result = validationResult(Array.from({ length: commandCount }, (_, index) => commandResult(`cmd-${index}`, 12_000)));
    const bounded = boundValidationEvidenceOutput(result);
    const serializedBytes = Buffer.byteLength(bounded.output, 'utf8');
    assert.ok(
      serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
      `${commandCount} commands must serialise under the bound (${serializedBytes} vs ${VALIDATION_EVIDENCE_BOUND_BYTES})`,
    );
    assert.ok(
      serializedBytes < VALIDATION_EVIDENCE_READ_CEILING_BYTES,
      `${commandCount} commands must serialise under the read ceiling (${serializedBytes})`,
    );
    assert.equal(JSON.parse(bounded.output).allPass, true, 'the verdict survives at this scale');
    console.log(`    ${commandCount} commands: measured=${bounded.measuredBytes} serialised=${serializedBytes}`);
  }
  console.log('✓ the scales that defeated the commands-only bounding are under the bound');
}

// ── 9. The advisory is log-only: bounding never touches the verdict or the caller's object. ──────
{
  const result = validationResult(Array.from({ length: 300 }, (_, index) => commandResult(`cmd-${index}`, 100_000)));
  const before = JSON.stringify({ allPass: result.allPass, status: result.status, commandCount: (result.commands as unknown[]).length, detailCount: (result.details as unknown[]).length });
  const bounded = boundValidationEvidenceOutput(result);
  const after = JSON.stringify({ allPass: result.allPass, status: result.status, commandCount: (result.commands as unknown[]).length, detailCount: (result.details as unknown[]).length });
  assert.equal(after, before, 'bounding must not mutate the caller result: the verdict object it returns is what validate reports');
  assert.equal(JSON.parse(bounded.output).allPass, result.allPass, 'the bounded copy carries the same verdict as the live result');
  assert.equal(JSON.parse(bounded.output).status, result.status, 'the bounded copy carries the same status as the live result');
  // formatValidationEvidenceAdvisory returns text for a caller to log; it has no way to alter a verdict.
  const advisory = formatValidationEvidenceAdvisory(bounded);
  assert.equal(typeof advisory, 'string', 'the advisory is a string a caller may log, not a verdict mutation');
  console.log('✓ advisory is log-only and bounding never mutates the caller result or its verdict');
}

// ── 10. CHK-004 disposition: outcome A shipped, and it is wired into the real evidence write. ────
{
  // A governance claim needs an observation, not a serialization check. Read the shipped source:
  // outcome A is code in the serialization path, so the path must actually call it.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../../..');
  const verifier = readFileSync(resolve(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
  const persist = verifier.slice(verifier.indexOf('function persistStoryValidationEvidence'));
  const persistBody = persist.slice(0, persist.indexOf('\nfunction '));
  assert.ok(
    persistBody.includes('boundValidationEvidenceOutput('),
    'CHK-004 outcome A must be WIRED: persistStoryValidationEvidence calls the bounding function',
  );
  assert.ok(
    persistBody.includes('formatValidationEvidenceAdvisory('),
    'CHK-005 requires the advisory to be emitted from the same evidence write path',
  );
  assert.ok(
    /output:\s*boundedOutput\.output/.test(persistBody),
    'the evidence record must serialise the BOUNDED output, not JSON.stringify(result)',
  );
  assert.ok(
    !/output:\s*JSON\.stringify\(result\)/.test(persistBody),
    'the unbounded serialisation must be gone from the evidence write path, not merely shadowed',
  );
  // Exactly one of the two dispositions shipped: bounding code, and no deferral rationale document.
  const rationale = resolve(repoRoot, 'docs/requirements/decisions/validation-evidence-artifact-growth.md');
  assert.ok(
    !existsSync(rationale),
    'outcome B must NOT also exist: CHK-004 requires exactly one shipped disposition, and A shipped',
  );
  console.log('✓ CHK-004 disposition observed: outcome A (bound ships) is wired into persistStoryValidationEvidence, outcome B absent');
}

// ── 11. Degenerate inputs never crash the serialiser. ────────────────────────────────────────────
{
  for (const value of [null, undefined, 0, 'plain', { allPass: true }, { allPass: true, commands: [] }]) {
    const bounded = boundValidationEvidenceOutput(value);
    assert.equal(bounded.bounded, false, `a small ${typeof value} artifact needs no bounding`);
    assert.equal(bounded.state, 'within_budget', 'a small artifact is within budget');
    assert.doesNotThrow(() => JSON.parse(bounded.output), 'the serialised artifact is always valid JSON');
  }
  console.log('✓ null / primitive / empty-command results serialise without crashing');
}

console.log('validation-evidence-buffer-smoke: PASS');
