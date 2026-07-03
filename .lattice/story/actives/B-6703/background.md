## Trigger Event
On 2026-07-03 after B-c28f reached DONE, live status showed DONE settlement default-on and 2031 proposable seeds, but zero candidate playbooks and no activated runtime guidance. The user explicitly rejected a design where activation depends on a human remembering to promote candidates or on a hidden default-off flag.

## Key Insights
DONE success alone must never become helped evidence, but explicit candidate exposure plus structured helped outcomes can be evaluated deterministically. The system already has outcome rows, promotion decisions, activation audits, and runtime consumption checks; the missing product behavior is a clear apply path that turns qualifying evidence into active advisory playbooks.

## Solution Tradeoffs
Keep activation advisory and non-authoritative, and do not create gate evidence or blocking policy. Avoid arbitrary trial serving, timers, or historical backfill in this story. Prefer a small correctness change to the existing playbook_auto_promotion_apply path over adding a larger new namespace or daemon.

## Conversational Texture
The user wants proof that the learning loop really closes: experience enters playbook, is consumed, produces explicit outcome evidence, and then activates without a person taking responsibility for subjective promotion. The acceptance language should be concrete CLI transcript evidence, not a promise that a future operator may remember to run several hidden steps.
