## Trigger Event
On 2026-08-31, the user explicitly approved the audited review-finding-triage prompt proposal and requested implementation across the relevant Agents until every document commitment is complete.

## Key Insights
The behavior must reach all five active REVIEW lanes, not just the quality reviewer. Severity, evidence state, applicability, and gate impact remain separate, and unknown applicability cannot downgrade a Finding that would otherwise block.

## Solution Tradeoffs
A single contract injected by the prompt resolver minimizes drift across full-envelope and legacy-full-context modes. This changes assembled prompt digests and role contracts, but avoids duplicating the policy in five templates. Prompt guidance remains distinct from Dynamic Finding machine authority.

## Conversational Texture
The user first asked whether the change was documentation-only, then explicitly changed the scope: apply the approved English proposal to the actual Agents. They want the work completed end to end, with the authoritative Dynamic Finding plan preserved and no scope expansion disguised as cleanup.
