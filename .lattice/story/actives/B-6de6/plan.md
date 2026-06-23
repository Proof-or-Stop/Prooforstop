# Plan — B-6de6: make the review-assurance floor storyFilesHash-authoritative

## Summary

The review-assurance floor counts fresh local PASS rounds keyed only on the whole-tree
`materialHash`, so an unrelated `main` merge that drifts that hash makes a story's
already-submitted quorum host-verdicts read as stale (0 fresh rounds) and forces a full
re-bind. The escalation path already solves this by pre-transforming events with
`eventsWithStoryFilesHashDowngrade` (review-escalation.ts:408) and using a storyFilesHash-aware
fallback record. The floor never applies that transform. We make the floor reuse the **same
canonical helper** so the floor and escalation make identical freshness decisions, while keeping
whole-tree `materialHash` primary and `storyFilesHash` a secondary downgrade-accept
(valid-with-advisory). No change to the shared `evaluateHostVerdictRounds`; no change to
escalation behavior beyond exposing the helper.

## CHK-001 — Make the floor fresh-round count storyFilesHash-authoritative (valid-with-advisory)

**Files:** `packages/main/src/core/review-assurance-floor.ts`,
`packages/main/src/core/review-escalation.ts` (export only),
`packages/main/src/core/evidence-freshness.ts` (import only).

Steps:
1. Add `export` to `eventsWithStoryFilesHashDowngrade` in `review-escalation.ts` (the floor
   already imports from `./review-escalation.js`, so this is an existing dependency edge).
2. In `review-assurance-floor.ts`: import `currentStoryFilesHash` from `./evidence-freshness.js`
   and `eventsWithStoryFilesHashDowngrade` from `./review-escalation.js`.
3. After computing `materialHash` (line 439), compute
   `storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot) ?? null`.
4. Build `effectiveEvents` ONCE:
   `const advisories: string[] = []; const effectiveEvents = (materialHash && storyFilesHash) ? eventsWithStoryFilesHashDowngrade(readEvents(args), materialHash, storyFilesHash, advisories) : readEvents(args);`
5. Pass `effectiveEvents` to both `evaluateHostVerdictRounds` calls (lines 501, 509) and to
   `latestFallbackRecord` so a host verdict stale by whole-tree `materialHash` but with a matching
   `storyFilesHash` is rewritten to the current `materialHash` (counts as a VALID local round) and
   records a re-attestation advisory.
6. A verdict with no `storyFilesHash`, or whose `storyFilesHash` differs, is left untouched and
   stays stale/ignored. `currentStoryFilesHash` is reused as-is; no new hash is invented.

Done when: a host verdict at a drifted whole-tree `materialHash` with a matching
`storyFilesHash` is counted as a valid local round with the re-attestation advisory present.

## CHK-002 — Exclude truly-stale verdicts from the per-round duplicate-host-identity check

**Files:** `packages/main/src/core/review-assurance-floor.ts` (no change to
`host-independence.ts`).

This is satisfied by construction once CHK-001 lands, and the smoke must prove it:
1. `evaluateHostVerdictRounds` (host-independence.ts:154) routes any host verdict whose
   `materialDigest != currentMaterialHash` to `ignoredVerdicts` and returns BEFORE the per-runId
   duplicate-host/session/key-identity check (line 192).
2. `eventsWithStoryFilesHashDowngrade` only rewrites verdicts whose `storyFilesHash` matches; a
   verdict stale by BOTH `materialHash` AND `storyFilesHash` is NOT rewritten, so it stays
   `materialDigest`-stale → ignored → never participates in the duplicate-identity check.
3. Therefore an accumulated prior-submit verdict that is stale by both hashes cannot create a
   `duplicate host/session/key identity` invalid round; only freshness-valid verdicts (current
   `materialHash`, or `storyFilesHash`-matching after downgrade) reach the identity/validity
   evaluation. No edit to the shared evaluator is required.

Done when: smoke (b) shows a re-bind after such drift does not yield a duplicate-identity-invalid
round.

## CHK-003 — Anti-gaming + advisory correctness preserved

**Files:** `packages/main/src/core/review-assurance-floor.ts`.

1. Mirror escalation's storyFilesHash-aware fallback: change the floor's `fallbackRecordFromEvent`
   (line 575) to take `expectedStoryFilesHash` and, when `materialHash !== expectedMaterialHash`
   but `storyFilesHash === expectedStoryFilesHash`, push an advisory instead of the
   `materialHash is stale` reason (mirroring review-escalation.ts:249-255); thread it through
   `latestFallbackRecord` (line 615) as a 3rd arg.
2. Surface advisories on the report: add `advisories?: string[]` to `ReviewAssuranceFloorReport`
   (mirroring `ReviewEscalationReport.advisories`) and to the fallback record; populate from the
   downgrade `advisories` array + fallback record advisories so the re-attestation signal is not
   swallowed (consistent with B-edf1).
3. Anti-gaming: a real story-owned-file change (storyFilesHash differs) leaves verdicts stale →
   the floor still finds 0 fresh rounds. The downgrade only forgives unrelated whole-tree drift.

Done when: the advisory string is present on a storyFilesHash-accepted floor pass, and a
storyFilesHash mismatch still stales the rounds.

## CHK-004 — Offline smoke/contract test + wire into npm test

**Files:** `packages/main/src/tasks/review-assurance-floor-storyfileshash-smoke.ts` (new),
`package.json`.

1. Add an offline smoke in the existing `review-assurance-floor` smoke style (synthetic
   process-events; no `claude -p`, no network) asserting:
   - (a) quorum at material X with storyFilesHash S, then an unrelated whole-tree change
     (materialHash drifts to Y, storyFilesHash unchanged S) ⇒ the floor still counts the rounds
     valid (`ok=true`) with the re-attestation advisory present.
   - (b) a re-bind after such drift (a prior verdict stale by BOTH hashes alongside fresh
     verdicts) does NOT produce a duplicate-identity-invalid round.
   - (c) inverse control: a real story-file change (storyFilesHash differs to S') DOES stale the
     rounds (found 0, `ok=false`).
   - (d) the degraded single-host fallback record likewise accepts whole-tree drift only with a
     matching storyFilesHash (advisory), and stales on mismatch.
2. Build `packages/main` and run the new smoke from `dist`.
3. Wire the new smoke into the root `npm test` chain (and the package's smoke aggregator if one
   exists) so it runs in CI.

Done when: the new smoke passes from `dist`, `npm test` includes it, and the full build is clean.

## Verification

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/review-assurance-floor-storyfileshash-smoke.js`
- `node packages/main/dist/tasks/review-assurance-floor-smoke.js` (regression: existing floor smoke)
- `node packages/main/dist/tasks/review-escalation-smoke.js` (regression: escalation unchanged)
- `npm test` (full suite, includes the new smoke)
