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

function commandResult(label: string, outputChars: number, argChars = 0): Record<string, unknown> {
  return {
    label,
    command: 'node',
    args: argChars > 0 ? [`--fixture=${'a'.repeat(argChars)}`] : ['packages/main/dist/tasks/example.js'],
    code: 0,
    output: 'o'.repeat(outputChars),
    durationMs: 12,
  };
}

function validationResult(commands: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    provider: 'lattice-verifier',
    status: 'pass',
    allPass: true,
    summary: 'all validation commands passed',
    details: [],
    warnings: [],
    timestamp: '2026-08-15T00:00:00.000Z',
    commands,
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
  console.log(`✓ realistic 100-command artifact (${bounded.measuredBytes} bytes) is unbounded and silent`);
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

  // Tier 1 keeps every entry and replaces only captured output, with a visible marker.
  assert.equal(parsed.commands.length, 300, 'tier 1 retains every command entry');
  assert.equal(bounded.elidedCommandEntries, 0, 'no entry was dropped when eliding output alone sufficed');
  assert.ok(bounded.elidedCommandOutputs > 0, 'at least one captured output was elided');
  const markers = parsed.commands.filter((command: any) => String(command.output).startsWith('[evidence bound:'));
  assert.equal(markers.length, bounded.elidedCommandOutputs, 'every elision left a visible marker');
  assert.match(String(markers[0].output), /\d+ chars of captured output omitted/, 'the marker names how much was omitted');
  assert.match(String(markers[0].output), new RegExp(String(VALIDATION_EVIDENCE_BOUND_BYTES)), 'the marker names the bound');
  for (const command of parsed.commands) {
    assert.ok(typeof command.label === 'string' && command.label.length > 0, 'entry identity survives elision');
    assert.equal(typeof command.code, 'number', 'entry exit code survives elision');
  }
  assert.equal(parsed.evidenceBound.elidedCommandOutputs, bounded.elidedCommandOutputs, 'the artifact states the elision count');
  assert.equal(parsed.evidenceBound.measuredBytes, bounded.measuredBytes, 'the artifact states the measured size');
  assert.equal(parsed.evidenceBound.boundBytes, VALIDATION_EVIDENCE_BOUND_BYTES, 'the artifact states the bound');

  const advisory = formatValidationEvidenceAdvisory(bounded);
  assert.ok(advisory, 'a bounded artifact still reports its advisory');
  assert.ok(advisory!.includes(String(bounded.measuredBytes)), 'the bounded advisory names the measured size');
  assert.ok(advisory!.includes(String(VALIDATION_EVIDENCE_READ_CEILING_BYTES)), 'the bounded advisory names the ceiling');
  assert.doesNotMatch(advisory!, /\bfail(ed|ure|s)?\b/i, 'even the bounded advisory carries no failure vocabulary');
  console.log(`✓ ${bounded.measuredBytes}-byte artifact bounded to ${serializedBytes} bytes, ${bounded.elidedCommandOutputs} marker(s), JSON contract intact`);
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
  console.log(`✓ non-output bulk capped ${bounded.elidedCommandEntries} entry(ies) with a diagnostic count`);
}

// ── 7. Degenerate inputs never crash the serialiser. ─────────────────────────────────────────────
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
