## Trigger Event

While closing story B-83aa a cross-host reviewer reported that the registered smoke verification-freshness-smoke could not pass, because one of its assertions pinned a call-site shape that B-83aa had changed. Fixing that assertion revealed a second, older failure in the same file that has nothing to do with B-83aa: assertSimulatedMainMergeRegression advances a temporary fixture story from DEV to REVIEW, and that transition is refused because the fixture story has no verifier-owned PLAN acceptance basis. The same failure reproduces from a clean build of the main checkout, and B-83aa touches neither proofstory.ts nor transition-orchestrator.ts.

## Key Insight

runPreReviewCheckGate in transition-orchestrator.ts is unconditional for DEV to REVIEW and calls currentPreReviewInputForContext in proofstory.ts, which requires the verifier-owned acceptance basis. That gate was wired in commit fb2170f016 on 2026-07-23. The fixture predates the requirement and was never given a basis, so the smoke has been red ever since. It is discovered by run-all-smokes, which is why npm run test:all is red on main, while npm test and the done-required suite are unaffected because the smoke is not a member of test:serial-reference.

## Tradeoff

The cheap fix is to relax the gate for fixture stories or to delete the assertion, and both are wrong: the gate is a real lifecycle protection and the assertion is a real merge-regression guard. The fixture should earn the acceptance basis the way a production story does, even though that makes the fixture setup longer. The nearby helper writeAcceptanceBasisDiscoveryFixture in flow-stability-smoke.ts is a command-discovery fixture rather than a real basis, so it cannot simply be reused.

## Conversation Texture

An implementer working on an unrelated assertion in this file reported the second failure rather than silently leaving the smoke red, and verified it against the main checkout before attributing it. The judgement recorded here is that this is a separate defect with its own decision to make, not something to fold into a story that never touched the gate.
