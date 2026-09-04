## Trigger Event

On 2026-09-04 during B-77e6, a claim made at PLAN was falsified during DEV: understanding.json stated that no exemption allowlist would be needed for the story's acceptance bar, and wave 1 group C then proved, against the resolver's source, that one handler cannot be migrated at all and a second was later proven the same way. The story owner tried to record the correction where the claim lives and found no channel: plan_set is refused outside PLAN, understanding_set is refused outside PLAN, and checklist title and context are frozen from INIT_CHECK onward. The correction ended up as two findings, B-77e6:F-001 and F-002, and the concept lane then filed B-77e6:F-003 noting that a reader of understanding.json alone is still told the opposite of what shipped, because nothing in the PLAN artifact points at the findings that refute it.

## Key Insights

The freeze is doing its job. A PLAN artifact that could be rewritten during DEV would let the acceptance bar drift silently, which is worse than a stale one; the phase gate on plan_set and understanding_set is a deliberate anti-tampering control and should stay. The gap is that the framework offers no way to attach a signed, phase-appropriate correction to a frozen artifact, so the only honest moves are a finding, which lives in a different file that the artifact never references, or a commit message, which nobody reading the artifact will see.

The project instructions describe plan.md as soft-frozen, with changes allowed if the commit message explains why. That is not what the tool does: plan_set's command policy allows PLAN only, so the described route does not exist. Either the instructions or the policy should change, and the policy is the one with a reason behind it.

The consequence is a quiet loss of record fidelity in exactly the artifacts reviewers are told to read first. On B-77e6 the truth was recoverable only by knowing to run finding_list, and index.json's description, which is injected into every reviewer's task context, still frames the goal as a literal zero with no mention of the two permanent exemptions.

## Solution Tradeoffs

The narrow fix is a corrections field on the PLAN artifacts, written through a new command that is allowed in DEV and REVIEW, that can only append, that records who wrote it and at what head, and whose entries must cite a finding id. The artifact stays frozen; the correction is a signed annotation alongside it, and understanding_get and plan_get render annotations inline so a reader cannot miss them. The cost is one more command and one more thing for the scope reviewer to read.

The alternative is to make finding_list the single truth and teach every reader of PLAN artifacts to consult it: cheaper, but it relies on a convention the tool cannot enforce, and it was the convention that failed here.

A third option is to allow re-entering PLAN to amend, which the lifecycle already permits for INIT. That is the heaviest route: re-entering resets checklist statuses and costs advances against the convergence budget, so it makes correcting a record more expensive than leaving it wrong, which is the incentive this draft exists to remove.

## Conversational Texture

Surfaced by the story owner while trying to do the right thing and finding no door, then sharpened by the concept lane, which was asked to audit the owner's prose rather than the code and found that the record as a whole was honest but the PLAN artifact read alone was not. Recorded rather than worked around because the freeze is correct and the fix belongs to the framework, not to a story that happened to be the first to need it.
