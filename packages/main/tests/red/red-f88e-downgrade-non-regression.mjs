#!/usr/bin/env node
/**
 * B-f88e — the two behaviours the collision fix must NOT weaken.
 *
 * The fix in `eventsWithStoryFilesHashDowngrade` (core/review-escalation.ts) stops a
 * superseded host verdict being rewritten onto the current material when an
 * identity-equal verdict is already there natively. Two pre-mortem risks were recorded
 * for that change, and this guard pins both so a later edit cannot silently trade one
 * for the other:
 *
 *   1. UNRELATED DRIFT STILL ACCEPTED. A lone superseded verdict, with no live
 *      identity-equal counterpart, must still be downgraded onto the current material
 *      AND still emit its mandatory re-attestation advisory. If the precondition were
 *      written too broadly it would suppress this, and a story that legitimately relied
 *      on a downgraded verdict would start failing the review-assurance floor.
 *
 *   2. GENUINE DOUBLE VOTES STILL CAUGHT. Two same-identity verdicts recorded NATIVELY
 *      at the current material must still invalidate the round with
 *      `duplicate host/session/key identity`. The precondition only ever skips verdicts
 *      whose materialDigest differs from the current one, so native duplicates are never
 *      exempted — that is the property asserted here, not merely assumed.
 *
 *   3. NO-SIGNAL HASHES ARE NOT A MATCH. `EMPTY_STORY_FILES_HASH` is sha256 of the empty
 *      set: a well-formed hash meaning "this story owns no files". Two such values are
 *      not evidence that story-owned material is unchanged, so they must never authorise
 *      a downgrade (same precedent as delivery-check-hash.ts).
 */

import { createHash } from 'node:crypto';
import { eventsWithStoryFilesHashDowngrade } from '../../dist/core/review-escalation.js';
import { evaluateHostVerdictRounds } from '../../dist/core/host-independence.js';

const CUR_MATERIAL = 'c'.repeat(64);
const OLD_MATERIAL = 'o'.repeat(64);
const STORY_FILES = 's'.repeat(64);
const EMPTY_STORY_FILES_HASH = createHash('sha256').update('').digest('hex');

function verdict({ material, tag, hostId, runId, storyFilesHash = STORY_FILES }) {
  return {
    type: 'host_verdict',
    verdictId: `verdict-${tag}-${runId}-${hostId}`,
    runId,
    hostId,
    sessionId: `quorum:session:${hostId}`,
    keyId: `quorum:key:${hostId}`,
    provider: hostId.startsWith('claude') ? 'claude' : 'codex',
    decision: 'pass',
    materialDigest: material,
    storyFilesHash,
    validationDigest: 'validation-digest',
    promptDigest: `prompt-${hostId}`,
    timestamp: '2026-07-28T00:00:00.000Z',
  };
}

const failures = [];

// ── 1. A lone superseded verdict is still downgraded, and still advises.
{
  const events = [verdict({ material: OLD_MATERIAL, tag: 'old', hostId: 'claude-cli', runId: 'B-X-q-r1' })];
  const advisories = [];
  const out = eventsWithStoryFilesHashDowngrade(events, CUR_MATERIAL, STORY_FILES, advisories);
  if (out[0].materialDigest !== CUR_MATERIAL) {
    failures.push(
      'UNRELATED DRIFT NO LONGER ACCEPTED: a lone superseded verdict with no live identity-equal counterpart was '
      + `left at ${out[0].materialDigest.slice(0, 12)} instead of being downgraded to the current material. The `
      + 'collision precondition is too broad and now suppresses the benign drift allowance.',
    );
  }
  if (out[0].originalMaterialDigest !== OLD_MATERIAL) {
    failures.push('DOWNGRADE LOST PROVENANCE: originalMaterialDigest was not preserved on the downgraded verdict.');
  }
  if (advisories.length !== 1) {
    failures.push(
      `MANDATORY ADVISORY MISSING: expected exactly 1 re-attestation advisory for a genuinely downgraded verdict, got ${advisories.length}. `
      + 'story-files-hash-material-drift.md requires operators and reviewers to see that unrelated drift occurred.',
    );
  }
}

// ── 2. Genuine same-identity verdicts at the CURRENT material still invalidate the round.
{
  const events = [
    verdict({ material: CUR_MATERIAL, tag: 'first', hostId: 'claude-cli', runId: 'B-X-q-r1' }),
    verdict({ material: CUR_MATERIAL, tag: 'second', hostId: 'claude-cli', runId: 'B-X-q-r1' }),
    verdict({ material: CUR_MATERIAL, tag: 'other', hostId: 'codex-cli', runId: 'B-X-q-r1' }),
  ];
  const advisories = [];
  const out = eventsWithStoryFilesHashDowngrade(events, CUR_MATERIAL, STORY_FILES, advisories);
  const rounds = evaluateHostVerdictRounds(out, CUR_MATERIAL, 2);
  const duplicateReasons = rounds.invalidRounds
    .flatMap(round => round.reasons)
    .filter(reason => reason.startsWith('duplicate host/session/key identity'));
  if (duplicateReasons.length === 0) {
    failures.push(
      'DOUBLE-VOTE CHECK WEAKENED: two same-identity verdicts recorded natively at the current material no longer '
      + `invalidate the round (validRounds=${rounds.validRounds.length}). The precondition must only ever skip `
      + 'verdicts whose materialDigest differs from the current one, never exempt native duplicates.',
    );
  }
}

// ── 3. Two EMPTY_STORY_FILES_HASH values are no-signal, not a match.
{
  const events = [verdict({
    material: OLD_MATERIAL,
    tag: 'empty',
    hostId: 'claude-cli',
    runId: 'B-X-q-r1',
    storyFilesHash: EMPTY_STORY_FILES_HASH,
  })];
  const advisories = [];
  const out = eventsWithStoryFilesHashDowngrade(events, CUR_MATERIAL, EMPTY_STORY_FILES_HASH, advisories);
  if (out[0].materialDigest !== OLD_MATERIAL) {
    failures.push(
      'NO-SIGNAL HASH TREATED AS A MATCH: a verdict whose storyFilesHash is EMPTY_STORY_FILES_HASH (sha256 of the '
      + 'empty set) was downgraded onto the current material against an equally empty current hash. Two absences of '
      + 'signal are not evidence that story-owned material is unchanged.',
    );
  }
  if (advisories.length !== 0) {
    failures.push(`NO-SIGNAL ADVISORY LEAKED: expected no advisory for a skipped no-signal comparison, got ${advisories.length}.`);
  }
}

if (failures.length > 0) {
  console.error('red-f88e-downgrade-non-regression: FAIL\n');
  for (const line of failures) console.error(`  - ${line}\n`);
  process.exit(1);
}

console.log(
  'red-f88e-downgrade-non-regression: OK (unrelated drift is still downgraded with its mandatory advisory and preserved '
  + 'provenance, genuine same-identity double votes at the current material still invalidate the round, and two '
  + 'EMPTY_STORY_FILES_HASH values never authorise a downgrade)',
);
process.exit(0);
