# B-9b8f Plan

## CHK-001

Extend the existing process fact registry instead of creating a second source of truth. Add policy metadata for review pass, finding, reviewRound schema, and express verification exemption. Keep L4 facts tied to consumer gates and artifacts. Update scripts/verify-process-fact-contract.mjs so the registry contract checks these new policy facts as part of the existing process fact table, then add smoke assertions that handler and renderer behavior consume the same facts.

## CHK-002

Keep reviewRound runtime-compatible as an ISO string. Move pass-only finding detection into a named review fact policy helper so finding_add and tests consume the same classification. Strengthen tests for pass-only conversion, ambiguous pass+failure text, non-reviewer attribution, and reviewRound ISO shape. Update docs that still describe reviewRound as numeric.

## CHK-003

Represent express verificationIntent bypass as a structured verification policy derived from computeChannel(story, checklist, decision). Do not persist new story metadata. Add a render path that can say exactly: Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped). Keep normal/fast zero-intent output unchanged so missing intent is not hidden.

## CHK-004

Add/extend regression smoke tests that users can run locally. Evidence must cover registry completeness, pass-only finding conversion, ISO reviewRound docs/runtime consistency, express-only exemption output, unchanged behavior for non-express zero-intent stories, and scripts/verify-process-fact-contract.mjs passing after the registry update. Run build plus targeted smoke/contract commands, then record verificationEvidence for every must intent.
