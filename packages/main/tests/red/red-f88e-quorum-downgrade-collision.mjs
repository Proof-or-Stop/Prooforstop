#!/usr/bin/env node
/**
 * RED — storyFilesHash downgrade collides a re-submitted quorum into permanent invalidity.
 *
 * ── THE DEFECT THIS REPRODUCES ──────────────────────────────────────────────
 *
 * `eventsWithStoryFilesHashDowngrade` (core/review-escalation.ts) accepts a host
 * verdict recorded at an OLDER materialDigest when its storyFilesHash still matches
 * the current one, by REWRITING that verdict's materialDigest to the current value.
 * The intent is benign: unrelated whole-tree drift should not invalidate a verdict
 * whose story-owned files never moved.
 *
 * But `evaluateHostVerdictRounds` (core/host-independence.ts) then groups the
 * accepted verdicts of each runId by independent host identity and marks the round
 * invalid on `duplicate host/session/key identity`. Quorum runIds are FIXED
 * (`<storyId>-q-r1..r3`, see handlers/quorum-submit.ts) and quorum_submit always
 * reuses the same synthetic hostId/sessionId/keyId per host. So the moment a story
 * submits a quorum TWICE at two different materials that share one storyFilesHash,
 * the older set is rewritten onto the newer material, every runId ends up holding
 * two verdicts per host, and ALL rounds flip to invalid:
 *
 *     voluntaryLocalRounds: 0/3 rounds x 2 hosts (submitted=3, complete=false)
 *
 * The story is then wedged. The review-assurance floor cannot count the quorum, and
 * `quorum_submit` refuses to re-emit it because its duplicate guard keys only on
 * (runId, materialDigest) and those verdicts genuinely exist at the current material
 * ("Re-run only after the material changes (a new commit), or use a fresh review
 * round"). A fresh review round does NOT help: runIds are not round-scoped. The only
 * exits are an unrelated material change or the human-gated
 * `review_escalation_fallback_set`.
 *
 * Observed live on B-4043 (2026-07-27): verdicts existed at materials 443a65aa66cc
 * and 329b38c4807a, BOTH carrying storyFilesHash f29641b7d99d. With 329b38c4 current,
 * the floor reported exactly `0/3 (submitted=3, complete=false)` and DONE was
 * unreachable. It cleared only when merging main moved storyFilesHash to f25bb43b739c,
 * which stopped the old verdicts from downgrading onto the new material.
 *
 * ── WHAT THIS TEST ASSERTS (the CORRECT behaviour, hence RED today) ─────────
 *
 *   1. A complete, genuinely-unique 3x2 quorum at the CURRENT material must count
 *      as 3 valid rounds, even when a superseded quorum for the same runIds exists
 *      at an older material with the same storyFilesHash.
 *   2. The downgrade must never manufacture a `duplicate host/session/key identity`
 *      round-invalidation out of verdicts that were distinct on disk.
 *
 * Non-vacuity is asserted separately: the same fixture WITHOUT the superseded
 * submission must already produce 3/3, proving the fixture is otherwise valid and
 * that the downgrade collision is the sole cause of the failure.
 */

import { eventsWithStoryFilesHashDowngrade } from '../../dist/core/review-escalation.js';
import { evaluateHostVerdictRounds } from '../../dist/core/host-independence.js';

const STORY = 'B-RED';
const OLD_MATERIAL = '443a65aa66cc0000000000000000000000000000000000000000000000000000';
const CUR_MATERIAL = '329b38c4807a0000000000000000000000000000000000000000000000000000';
const SHARED_STORY_FILES = 'f29641b7d99d0000000000000000000000000000000000000000000000000000';
const HOSTS = ['claude-cli', 'codex-cli'];
const ROUNDS = 3;
const REQUIRED_HOSTS_PER_ROUND = 2;

/** One quorum submission: 3 rounds x 2 hosts, exactly as quorum_submit records them. */
function quorumSubmission(materialDigest, tag) {
  const events = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const hostId of HOSTS) {
      events.push({
        type: 'host_verdict',
        verdictId: `verdict-${tag}-r${round}-${hostId}`,
        runId: `${STORY}-q-r${round}`,
        hostId,
        // quorum_submit derives these deterministically per host, so a second
        // submission reuses the identical identity triple.
        sessionId: `quorum:${STORY}:${hostId}:session`,
        keyId: `quorum:${STORY}:${hostId}:key`,
        provider: hostId === 'claude-cli' ? 'claude' : 'codex',
        decision: 'pass',
        materialDigest,
        storyFilesHash: SHARED_STORY_FILES,
        validationDigest: 'validation-digest-0000',
        promptDigest: `prompt-${hostId}-0000`,
        timestamp: '2026-07-27T00:00:00.000Z',
      });
    }
  }
  return events;
}

function evaluate(events) {
  const advisories = [];
  const effective = eventsWithStoryFilesHashDowngrade(
    events,
    CUR_MATERIAL,
    SHARED_STORY_FILES,
    advisories,
  );
  const rounds = evaluateHostVerdictRounds(effective, CUR_MATERIAL, REQUIRED_HOSTS_PER_ROUND);
  return { rounds, advisories };
}

const failures = [];

// ── Non-vacuity: the current submission ALONE must already be a valid 3x2 quorum.
const soloEvents = quorumSubmission(CUR_MATERIAL, 'cur');
const solo = evaluate(soloEvents);
if (solo.rounds.validRounds.length !== ROUNDS) {
  failures.push(
    `FIXTURE IS VACUOUS: the current-material quorum alone yielded ${solo.rounds.validRounds.length}/${ROUNDS} valid rounds `
    + `(expected ${ROUNDS}); reasons=${JSON.stringify(solo.rounds.invalidRounds.map(r => r.reasons))}. `
    + 'The collision test below would prove nothing.',
  );
}

// ── The defect: a superseded submission at an older material, same storyFilesHash.
const withSuperseded = [...quorumSubmission(OLD_MATERIAL, 'old'), ...soloEvents];
const collided = evaluate(withSuperseded);

const uniqueOnDisk = new Set(
  withSuperseded.map(e => [e.materialDigest, e.runId, e.hostId, e.sessionId, e.keyId].join('|')),
).size;
if (uniqueOnDisk !== withSuperseded.length) {
  failures.push(
    `FIXTURE ERROR: verdicts are not distinct on disk (${uniqueOnDisk}/${withSuperseded.length} unique); `
    + 'the duplicate must be manufactured by the downgrade, not planted by the fixture.',
  );
}

if (collided.rounds.validRounds.length !== ROUNDS) {
  const reasons = collided.rounds.invalidRounds.map(r => `${r.runId}: ${r.reasons.join('; ')}`);
  failures.push(
    `DOWNGRADE COLLISION: a complete, on-disk-distinct 3x2 quorum at the current material counted as `
    + `${collided.rounds.validRounds.length}/${ROUNDS} valid rounds `
    + `(submitted runIds=${new Set([...collided.rounds.validRounds, ...collided.rounds.invalidRounds].map(r => r.runId)).size}). `
    + `Invalid rounds: ${JSON.stringify(reasons)}. `
    + 'A superseded quorum at an older materialDigest sharing the same storyFilesHash was rewritten onto the current '
    + 'material and collided with the live one, so the floor cannot count a quorum that genuinely exists — and '
    + 'quorum_submit refuses to re-emit it because (runId, materialDigest) already carries verdicts.',
  );
}

const manufacturedDuplicates = collided.rounds.invalidRounds
  .flatMap(r => r.reasons)
  .filter(reason => reason.startsWith('duplicate host/session/key identity'));
if (manufacturedDuplicates.length > 0) {
  failures.push(
    `MANUFACTURED DUPLICATES: the downgrade produced ${manufacturedDuplicates.length} `
    + `'duplicate host/session/key identity' round-invalidation(s) from verdicts that were distinct on disk: `
    + `${JSON.stringify(manufacturedDuplicates)}.`,
  );
}

if (failures.length > 0) {
  console.error('red-quorum-downgrade-collision: RED (defect reproduced)\n');
  for (const line of failures) console.error(`  - ${line}\n`);
  console.error(
    `  advisories emitted by the downgrade: ${JSON.stringify(collided.advisories.slice(0, 2))}`
    + `${collided.advisories.length > 2 ? ` (+${collided.advisories.length - 2} more)` : ''}`,
  );
  process.exit(1);
}

console.log(
  'red-quorum-downgrade-collision: OK (a superseded quorum sharing storyFilesHash no longer collides with the live '
  + 'quorum; a complete 3x2 at the current material counts as 3 valid rounds and no duplicate identity is manufactured)',
);
process.exit(0);
