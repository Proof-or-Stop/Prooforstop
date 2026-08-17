## Trigger Event
On 2026-07-03 after B-c28f and B-6703 reached DONE, live status showed PLAYBOOK_DONE_SETTLEMENT_ENABLED=true and 2055 proposable seeds, but playbooks.json was missing and runtime consumption reported no_active_playbooks_to_verify. This proves DONE story experience enters the source layer but is not automatically converted into candidate playbooks.

## Key Insights
The correct product boundary is seed-to-candidate automation, not active guidance mutation. The learning layer needs explicit candidate creation so users do not have to remember a three-command seed observe, proposal apply, and candidate approve sequence after every story.

## Solution Tradeoffs
Add a deterministic, digest-bound ingestion wrapper and wire it to post-DONE settlement as a non-blocking learning step. Keep candidate playbooks inert, keep active promotion evidence-gated through B-6703, and leave historical backfill as a separate bounded batch story.

## Conversational Texture
The user is rightly frustrated that experience is recorded but not consumed. The implementation should make the next visible state obvious: new DONE stories can produce candidate playbooks automatically, while activation still requires exposure and structured outcome proof.
