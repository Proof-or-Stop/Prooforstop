## CHK-001 Commit the rev 3 execution plan document

Goal: land the operator-approved, pre-story-reviewed rev 3 of
docs/requirements/decisions/proof-or-stop-evidence-instrument-replay-execution-plan.md
as the committed pre-registration for the proof-or-stop evidence-instrument
replay & tamper campaign (M0-M4 + optional M5).

Steps:
1. The rev 3 text is already present in this worktree (moved from the main
   working tree where it was drafted untracked; scratchpad backup taken and
   its sha256 recorded as evidence).
2. git add the single file and commit with a message referencing B-e86f and
   the rev provenance (21 self-review findings resolved in rev 2; 6.5
   cross-vendor roles added in rev 3 by operator decision 2026-07-05).
3. Verify per verificationIntent:
   - happy: sha256 of committed blob == scratchpad backup digest; all 12
     section headers + 6.1-6.5 subsections present.
   - edge: git diff main...HEAD touches exactly the one allowed path.
   - adversarial: spot-check the load-bearing corrections survived landing
     (no seed-swap class; 'content-inert'; 'fingerprint'; 'never
     outcome-judging'; Tier-C ledger disclaimer).
4. No code, no experiments/ artifacts: the story's scope boundary is the
   single md path; anything else is a scope violation.

Out of scope: any M0-M4 implementation; protocol.json; changes to the
instrument or smokes; changes to other decision docs.
