# Plan: dev-memory lifecycle gates (B-a7c5)

## Reconciliation with the pre-existing playbook-runtime-memory-consumption-execution-plan.md spec (OQ-1, OQ-2)

The PLAN scope reviewer found `docs/requirements/decisions/playbook-runtime-memory-consumption-execution-plan.md`
(specifically M8 "Capture-Or-Noop Decision" and section 4.3 "Active Playbook
Runtime"). This is real prior architecture and must be reconciled, not
overridden silently:

- M8's own acceptance tests describe `dev_memory_finish_decision` as advisory
  ("missing decision is visible in runbook/advisory output"), and the doc's
  Non-Goals list includes "Do not make every advisory reminder a hard
  blocker." CHK-003 deliberately escalates ONE specific, narrow use of that
  same command (the end-of-story finish-decision) from advisory to blocking.
  This is a knowing, recorded escalation of M8's original scope, not an
  accidental conflict -- it exists because M8 shipped the *mechanism*
  (the command + record shape) but never wired any *consumer* to treat its
  absence as blocking, which is exactly the gap the user's requirement (a
  genuine backstop, not just a visible-but-ignorable reminder) needs closed.
- Section 4.3 independently establishes the CORRECT shape for introducing
  blocking behavior around memory-adjacent systems: blocking must come from "a
  committed, reviewable consumer policy row," never from memory content
  itself, and "registered blocking consumers must expose an operator-visible
  bypass or downgrade path with a reason." CHK-003 already satisfies this
  exactly: `decision=defer-with-reason` (or `no-reusable-lesson`, itself a
  reasoned downgrade) IS the bypass path, gated on a required ≥5-char reason
  field per the existing dev_memory_finish_decision schema. No new bypass
  mechanism is needed for CHK-003; it already conforms to 4.3's pattern.
- CHK-001 did NOT originally have an equivalent bypass path -- if the
  underlying preflight-pack build itself fails (corrupt experience.jsonl,
  filesystem error), a purely mechanical "artifact missing" check would block
  DEV entry with no recourse. Per section 4.3's own bypass-path requirement,
  add one: `dev_memory_preflight_ack` accepts an optional `--reason` (≥5
  chars) that, when the mechanical preflight pack build throws, still writes
  the ack artifact with `packDigest: null`/`topHitIds: []` and the given
  reason recorded -- an explicit, reasoned downgrade, not a silent skip. The
  DEV-entry gate accepts either a normal ack OR a reasoned-failure ack.
- This story's own decision.json's stated override ("a deliberate, explicit
  override of the artifact's own self-declared authority:non_authoritative /
  gateEvidence:false fields") stands, refined by the above: those fields
  describe dev-memory CONTENT's non-authoritative status (Non-Goal: "do not
  let dev-memory or playbooks satisfy... DONE... evidence gates" -- i.e. you
  cannot cite a LESSON as proof something was verified). CHK-003 does not do
  that -- it requires a RECORD OF REFLECTION having happened, structurally
  identical in kind to summary_set (also a required attestation, not itself
  code-correctness evidence). This distinction is what keeps CHK-003 inside
  the spirit of the Non-Goal while still closing the real gap.
- Because this constitutes a genuine, deliberate widening of M8's originally
  advisory-only scope, `docs/requirements/decisions/playbook-runtime-memory-consumption-execution-plan.md`
  itself must be updated (not just this story's own artifacts) to describe
  the actually-delivered, escalated behavior -- otherwise the next reader of
  that spec is misled the same way B-3144's F-030 finding showed a stale
  pre-merge design doc can mislead. Added as an explicit sub-task under
  CHK-003 below.

## Architecture decision: shared core module, no core→handlers inversion

`dev_memory_finish_decision`'s path-builder (`finishDecisionPath`) and record shape
currently live only in `packages/main/src/handlers/playbook-runtime-memory.ts` (the
CLI-handler file), never exported. `core/machine.ts` (a pure core module) must not
import from `handlers/` for this feature (the one existing `core→handlers` import,
`computeActiveReviewers`, is a pre-existing exception, not a pattern to extend).
Fix: move `finishDecisionPath` + a new `readDevMemoryFinishDecision(root, storyId)`
reader into `core/playbook-runtime-memory.ts` (the existing core module for this
subsystem), export both, and have `handlers/playbook-runtime-memory.ts`'s
`dev_memory_finish_decision` write-handler import `finishDecisionPath` from core
instead of defining it locally. `core/machine.ts` then imports
`readDevMemoryFinishDecision` from the same core module — a normal core→core import.

## CHK-001 — INIT_CHECK-phase dev-memory preflight requirement before DEV

Mirrors the scope_boundary_set/execution_boundary_set INIT_CHECK-gating pattern
(handlers/scope-anti-expansion.ts + core/machine.ts's evaluateScopeAntiExpansionGate,
core/machine.ts:286-378).

1. **New type** `DevMemoryPreflightAckData` in `core/types.ts`: `{ schemaVersion,
   storyId, packDigest, topHitIds: string[], acknowledgedAt, acknowledgedBy }`.
2. **New store methods** in `core/store.ts`: `readDevMemoryPreflightAck(storyId)` /
   `writeDevMemoryPreflightAck(storyId, data)`, writing to
   `.lattice/story/actives/<storyId>/dev-memory-preflight-ack.json` (same
   `readJson`/`writeJson` helper pattern as scope-boundary.json).
3. **New handler** `dev_memory_preflight_ack` in `handlers/dev-memory.ts`: runs the
   existing preflight-pack build (reuse the same builder `dev_memory_preflight`
   already uses), then writes the ack artifact recording `packDigest` and
   `topHitIds` actually seen. No phase restriction needed (allowedPhases stays
   'all', matching the existing dev_memory_* commands) — but the GATE only checks
   for it at the DEV-entry doors, so in practice it must be called before DEV.
4. **New gate function** `evaluateDevMemoryPreflightGate(storyId, store)` in
   `core/machine.ts`, following the SIMPLE existence-check model (canFinishGuard
   lines 877-882: read → check truthy), not the hash/staleness model — the ack
   just needs to exist once per story, it never needs to be re-validated against
   current material (unlike scope-boundary, which is tied to a frozen snapshot).
5. **Wire into all four DEV doors** uniformly (canStartDevGuard 637-669,
   canSkipPlanGuard 697-717, canReenterDevGuard 728-738) since the artifact
   persists for the story's whole lifetime once written — a rollback door
   (REVIEW/TEST→DEV) will find the ack already present from the first PLAN→DEV
   entry and pass through with zero added friction. This matches the
   "applies-to-every-door" category (like proofStoryDevGateFailure /
   parallelDevEntryBlock, comment at 719-727) rather than the review-only category.
6. **Message twin** in `getGuardFailureReason`'s `targetPhase === 'DEV'` branch
   (1188-1293), same slot as the existing `proofStoryDevGateFailure` check
   (1236-1237): `Cannot enter DEV: dev-memory preflight has not been acknowledged
   for this story. [missing_dev_memory_preflight_ack] → Run \`lattice
   dev_memory_preflight_ack --storyId=<id>\` first (or, if the preflight pack
   build itself is failing, --reason="<why>" to record a reasoned downgrade).`
7. **Bypass path (section 4.3 compliance)**: `dev_memory_preflight_ack` accepts
   an optional `--reason` (≥5 chars). Normal path: build the pack, write
   `packDigest`/`topHitIds` from a real successful build. Reasoned-downgrade
   path: if the pack build throws AND `--reason` is provided, write the ack
   with `packDigest: null`, `topHitIds: []`, `downgradeReason: <reason>` --
   still satisfies the gate, but visibly and honestly, not silently. If the
   pack build throws and NO `--reason` is provided, the command still fails
   (does not silently ack) -- the reason is mandatory for the downgrade path,
   exactly mirroring `dev_memory_finish_decision`'s existing requirement that
   `no-reusable-lesson`/`defer-with-reason` need a reason.

## CHK-002 — non-blocking advisory reminder on finding_resolve

`handlers/finding.ts:759-791`, `finding_resolve` returns a bare string built at line
790 as `Finding ${args.findingId} resolved${commitHint}` where `commitHint` is
itself an optional, always-computed, try/catch-safe advisory suffix
(`autoCommitStoryMetadata`, core/auto-commit-metadata.ts:478-483) -- the exact
precedent to mirror.

1. Add `'finding_resolve'` to the `RuntimeConsumer` union in
   `core/playbook-runtime-memory.ts:44-52`. Do NOT add it to
   `REGISTERED_CRITICAL_RUNTIME_CONSUMERS` or `ADVISORY_ONLY_RUNTIME_CONSUMERS`
   (lines 207-214) -- fully advisory, non-escalatable, matching the explicit
   design decision (background.md Solution Tradeoffs) that this must stay
   non-blocking.
2. In `finding_resolve`, after computing `commitHint` (line 789) and before the
   return statement (790), compute a `memoryHint` string: build a pack via the
   existing `buildMemoryFreshnessPack`/equivalent builder with
   `consumer: 'finding_resolve'`, render via `renderMemoryFreshnessPackSummary`
   (core/playbook-runtime-memory.ts:439-447, the terse 4-line form, not the full
   60-line pack -- this is a one-line-per-finding nudge, not a full report),
   prefixed with a short human sentence e.g. "Consider \`dev_memory_capture\` if
   this finding's root cause/fix is a genuinely reusable lesson." Wrap the whole
   computation in try/catch returning '' on any failure -- a memory-subsystem
   error must never fail finding_resolve itself.
3. Splice `memoryHint` into the same template literal as `commitHint`.

## CHK-003 — DONE-gate dev_memory_finish_decision requirement

1. In `core/playbook-runtime-memory.ts`: export `finishDecisionPath(root, storyId)`
   (moved from handlers/playbook-runtime-memory.ts:179-181, unchanged logic) and a
   new `readDevMemoryFinishDecision(root, storyId): FinishDecisionRecord | null`
   that reads+JSON-parses the file at that path, returning `null` on
   missing/parse-error (fail-closed for the gate's purposes -- a corrupt record is
   treated the same as no record).
2. Update `handlers/playbook-runtime-memory.ts`'s `dev_memory_finish_decision` to
   import `finishDecisionPath` from core instead of defining it locally (delete
   the now-duplicate local definition).
3. In `core/machine.ts`'s `canFinishGuard` (876-943), add after the existing
   test-evidence check (877-882), following that exact simple-existence-check
   style (not the delivery-check hash/staleness style, since finish-decision
   records have no `_hash`/material-binding field to validate):
   ```
   const finishDecision = readDevMemoryFinishDecision(context.projectRoot, context.storyId);
   if (!finishDecision) return false;
   ```
4. Message twin in `getGuardFailureReason`'s `targetPhase === 'DONE'` branch
   (1329-1422), added after the equivalent test-evidence message slot (1330-1336):
   `Cannot enter DONE: dev_memory_finish_decision has not been recorded.
   [missing_dev_memory_finish_decision] → Run \`lattice dev_memory_finish_decision
   --storyId=<id> --decision=captured|no-reusable-lesson|defer-with-reason\`.`
5. No minimum-count / positive-capture requirement -- `decision:
   'no-reusable-lesson'` with a reason satisfies the gate. This is a deliberate,
   explicit override of the artifact's own self-declared
   `authority: 'non_authoritative'` / `gateEvidence: false` fields (which describe
   dev-memory's general non-authoritative status, not a promise that NO gate will
   ever consume presence-of-a-record as a completeness signal) -- record this
   override explicitly in code comments at the new gate-check site so it isn't
   mistaken for a bug later.
6. **Spec doc update (required, see Reconciliation section above)**: update
   `docs/requirements/decisions/playbook-runtime-memory-consumption-execution-plan.md`'s
   M8 section to describe the actually-delivered behavior (finish_decision
   presence is now a required, blocking DONE-gate check, not purely advisory
   runbook output as originally scoped), and note in section 4.3's context
   that this is the first concrete instance of that section's
   registered-blocking-consumer-with-bypass pattern being exercised for a
   dev-memory (not playbook) consumer. Preserve the original M8/4.3 text as
   historical design rationale (mirror the "Delivered differently" callout
   pattern used in B-3144's own doc fix, docs/evidence-write-guard-spec.md).

## Testing strategy

New smoke test `packages/main/src/tasks/dev-memory-lifecycle-gates-smoke.ts`
covering all three gates against a fresh temp-git fixture (mkdtempSync + git init,
mirroring the pattern used throughout this codebase, e.g.
quorum-submit-smoke.ts's `makeFixture`): CHK-001's DEV-door refusal-then-pass
across all four doors, CHK-002's advisory text presence/absence (present after a
successful finding_resolve, absent/harmless on a finding_resolve that itself
fails), CHK-003's DONE-gate refusal-then-pass for all three decision values,
including the fail-closed corrupt-record case. Register in `lattice.config.json`
`validate.commands`.
