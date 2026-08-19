# Plan — B-3144: quorum_submit cross-material resubmission poisons a drift-accepted quorum

Terminology (INIT-002): "full-3x2" = the review assurance floor's strong level: 3 quorum
rounds, each carrying PASS verdicts from 2 independent hosts (e.g. claude-cli + codex-cli).
Chosen solution (INIT-001): of the three candidates weighed in background.md §Solution
Tradeoffs, this story implements candidate (1) guard-predicate alignment, plus a recovery
command; candidate (2) material-scoped runIds and candidate (3) supersede events are
explicitly out of scope.

## Root cause (verified)

- Producer guard: `quorum_submit` refuses resubmission only when a committed `host_verdict`
  event on a planned runId has `materialDigest === current` (handlers/quorum-submit.ts:485).
- Consumer floor: review-escalation drift-accepts stale-material verdicts whose
  `storyFilesHash` matches current, by rewriting their materialDigest to current before round
  evaluation (core/review-escalation.ts:948-969 `eventsWithStoryFilesHashDowngrade`).
- Gap: any commit that moves materialHash but not storyFilesHash (the normal effect of
  `git merge main`) lets a redundant resubmit through the guard; old + new verdicts then share
  the deterministic runIds (`<storyId>-q-rN`, quorum-submit.ts:480,506) and identical derived
  host/session/key identities, so `evaluateHostVerdictRounds` invalidates every round as
  "duplicate host/session/key identity" (core/host-independence.ts:191-205).
- Live incident: story B-bf52, 2026-07-24; recovered only by manual jsonl surgery
  (commit 255eefd289). No supersede or recovery command exists.

## CHK-001 — RED repro (before any fix)

Extend `packages/main/src/tasks/quorum-submit-smoke.ts`:

1. New helper `commitMainDrift(root)`: on the fixture's `main` branch, add/modify a file the
   story branch never touches (e.g. `packages/main/src/other.ts`), commit, then merge `main`
   into `story/B-quorum-smoke`. Effect: whole-tree materialHash changes, story-diff object ids
   (and therefore storyFilesHash) stay identical — the exact B-bf52 shape.
2. New check `refuses a redundant re-submit when the standing quorum drift-accepts`:
   submit a rounds=3 quorum → `commitMainDrift` → refresh reviewer passes → call
   `quorum_submit` again.
   - RED assertion (fails on current code): the second submit must throw a refusal naming the
     standing drift-accepted quorum, and write no events/files; today it succeeds and the
     escalation floor then reports all rounds invalid ("duplicate host/session/key identity").
   - The RED run must also assert the poisoning consequence on current code (floor collapse)
     so the repro is un-gameable: capture `evaluateReviewEscalation` (or floor evaluation)
     before/after.
3. Keep the existing `allows a fresh quorum after a material change` check green: its
   `commitMaterialChange` edits `packages/main/src/index.ts`, a story-diff file, so
   storyFilesHash changes and the new guard still allows that resubmission.

RED evidence is recorded via `red_evidence` bound to the smoke invocation (target = AB-id /
requestHash of the failing check, not a CHK id), before the fix lands.

## CHK-002 — Guard predicate alignment

In `handlers/quorum-submit.ts` (guard block, lines 474-490):

- Extend the collision filter from
  `event.materialDigest === materialDigest`
  to
  `event.materialDigest === materialDigest || (normalizeString(event.storyFilesHash) !== '' && event.storyFilesHash === storyFilesHash)`
  i.e. a committed verdict collides when the floor would accept it at evaluation time —
  same material OR drift-acceptable via matching storyFilesHash.
- Split the refusal message by branch:
  - same material: keep the existing message.
  - drift-accept branch: state that the existing quorum at the older material still
    drift-accepts because storyFilesHash is unchanged, that nothing needs resubmitting, and
    that a resubmit would poison the rounds; point at `review_escalation_status`.
- No change to the floor / `eventsWithStoryFilesHashDowngrade` (excluded scope).
- Update the guard comment to document both branches.

## CHK-003 — `quorum_prune` recovery command

New `packages/main/src/handlers/quorum-prune.ts`, formalizing the B-bf52 surgery:

- Input: `storyId`, optional `runIds` filter, `dryRun` (default true → explicit
  `apply: true` required to mutate), optional `keep: "newest-material" | "oldest-material"`
  (default `newest-material`).
- Behavior: read committed `process-events.jsonl`; group `host_verdict` events by
  (runId, hostId, sessionId, keyId); for groups with >1 event, select the losing set (all but
  the event whose materialDigest matches `keep`; default keeps the newest-material event per
  group). Dry-run prints the exact events (verdictId, runId, host, materialDigest, timestamp)
  that would be removed and which survive.
- Apply path: write a timestamped backup of the jsonl next to it (inside the story dir),
  rewrite the file without the losing events, and commit through the same lifecycle-metadata
  transaction machinery quorum_submit uses (pre-dirty refusal + rollback on failure).
  Removing events never touches storyFilesHash (story metadata is material-excluded), so
  pruning cannot re-stale passes.
- Refuses when: no duplicates found (nothing to prune), or the events file is uncommitted /
  the tree is dirty.
- Wiring (5 points): handler file, `handlers/lattice-cli.ts` registration,
  `cli/command-catalog.ts` entry, `core/command-policy.ts` policy
  (gateEvidence-adjacent metadata-write, reviewerWrite ownership), and
  `core/process-fact-levels.ts` fact row. Smoke coverage lives in quorum-submit-smoke
  (dry-run lists the poisoned pair; apply restores 1 verdict per host per round and the floor
  returns to full-3x2).

## Validation

- `node packages/main/dist/tasks/quorum-submit-smoke.js` (RED first, then GREEN after fix).
- `npm test` full suite before REVIEW.

## Risks

- The smoke fixture's storyFilesHash must genuinely stay constant across `commitMainDrift`;
  assert it inside the check (`currentStoryFilesHash` before == after) so the repro cannot
  silently degrade.
- quorum_prune rewrites an append-only committed file; the backup + dry-run-default +
  pre-dirty refusal are the containment. It must refuse to remove non-duplicate events.
- Existing callers/tests that rely on cross-material resubmission being allowed: only the
  `allows a fresh quorum after a material change` smoke check — kept valid (see CHK-001.3).
