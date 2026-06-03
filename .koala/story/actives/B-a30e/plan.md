# B-a30e Plan - lifecycle UX papercuts

## Boundary

B-a30e fixes four lifecycle UX/API mismatches found during B-4ee0 delivery:
validate storyId alias/evidence semantics, phase-aware scope freshness guidance,
owner lease takeover discoverability, and scope-warning recovery copy. B-7fc2 owns
strict JSON stdout / machine-parseable output contracts. This story must not do a
broad stdout formatting or CLI decoration refactor.

Parallel development uses isolated Claude Code CLI worktrees for code/test work.
The supervising Codex session owns Lattice metadata, checklist transitions,
phase transitions, evidence recording, review, TEST validation, and final DONE.
Agents must not call checklist_update, story_advance, summary_set, delivery_check_set,
or any other mutating story metadata command.

## CHK-001

Support validate storyId JSON alias without silent diagnostic fallback.

Implementation:
- Add `storyId?: string` as an explicit validate schema alias in `packages/main/src/cli-engine.ts`.
- Normalize validate arguments before `handlers.validate` persists evidence: `story` remains canonical; `storyId` maps to `story`.
- If both `story` and `storyId` are present with different values, fail explicitly before validation runs.
- Preserve `validate --story=B-xxx --json` and diagnostic no-story validate behavior.
- Avoid generic JSON stdout changes owned by B-7fc2.

Verification:
- Extend validation-protocol smoke or an adjacent focused smoke to assert JSON body `{storyId,json:true}` writes/refreshes story test-evidence.
- Assert `--story` continues to write story evidence.
- Assert no-story validate remains diagnostic/read-only.
- Assert conflicting `story`/`storyId` fails without silent selection.

## CHK-002

Render phase-aware scope freshness guidance.

Implementation:
- Update `deriveNextAction` in `packages/main/src/core/review-scope-binding.ts` to use the already supplied `phase`.
- Keep hard blockers first: guard violations and path/semantic fails remain blocking in every phase.
- In REVIEW, stale/missing reviewer scope binding continues to instruct `review_run_start` before REVIEW-to-TEST.
- In TEST/DONE, stale review hash freshness is rendered as post-review advisory/delivery-review guidance and must not say before REVIEW-to-TEST.
- Keep session_brief and story_advance copy consistent with the summary rows.

Verification:
- Extend semantic scope guard or flow stability smoke for REVIEW stale/missing, TEST stale advisory, and fail remains fail.
- Confirm the output text no longer contains REVIEW-to-TEST guidance in TEST/DONE stale advisory cases.

## CHK-003

Expose owner-lease takeover meta options in CLI help.

Implementation:
- Extend `printToolHelp` in `packages/main/src/cli-engine.ts` to append common owner lease meta options for owner-gated commands.
- Show `--takeover` as stale lease recovery and `--forceTakeover` as deliberate active lease override.
- Derive whether help should show takeover guidance from command ownership policy and dynamic validate story-target semantics.
- Do not change `enforceStoryOwnerLeaseGate` behavior.
- Do not imply takeover for read-only commands.

Verification:
- Extend story-owner-lease smoke or command-ownership-contract to assert `story_advance --help`, `checklist_update --help`, and story-targeted validate guidance expose takeover meta options.
- Assert read-only command help does not advertise takeover recovery.
- Assert active takeover still requires `--forceTakeover` and logs takeover events as before.

## CHK-004

Clarify scope-warning recovery path after REVIEW.

Implementation:
- Improve advisory/warn copy in scope summary and transition gate rendering so users see advisory/not blocking for shadow/local warnings.
- When a later-phase necessary out-of-scope expansion is detected, point to the right recovery: acknowledge in DEV/REVIEW if allowed, roll back to DEV when already in TEST, or rely on delivery reviewer verification when the warning is advisory.
- Keep `scope_contract_set` phase limits unchanged.
- Keep blocking failures noisy; warnings become clearer, not silent.

Verification:
- Extend scope-contract/semantic-scope/flow-stability smoke to cover shadow/warn advisory copy, later-phase recovery wording, and unchanged phase limits.
- Confirm blocking scope failures still throw and name `scope_contract_acknowledge`/fix diff recovery.

## CHK-005

Integrate parallel fixes and prove lifecycle gates still fail closed.

Implementation:
- Create three isolated Claude Code CLI worktrees/branches from story/B-a30e: validate alias, scope UX, owner help.
- Agents commit only code/test/docs changes on their branches.
- Supervisor merges/cherry-picks back into story/B-a30e, resolves conflicts, and performs all Lattice metadata updates.
- Run full targeted verification after integration.

Verification commands:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:story-owner-lease-smoke`
- `npm --prefix packages/main run test:command-ownership-contract`
- `npm --prefix packages/main run test:semantic-scope-guard-smoke`
- `npm --prefix packages/main run test:scope-contract-smoke`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `node scripts/verify-process-fact-contract.mjs`
- `lattice validate --story=B-a30e --json`

Acceptance transcripts:
- validate JSON `storyId` refreshes current story evidence.
- TEST stale scope guidance does not instruct REVIEW-to-TEST.
- owner-gated help exposes `--takeover` and `--forceTakeover`.
- scope warning copy distinguishes advisory vs blocking recovery.
