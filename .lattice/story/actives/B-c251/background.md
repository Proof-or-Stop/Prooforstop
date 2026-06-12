## Trigger Event
On 2026-06-12, discussion identified that story_review missing_scope_check is a real PLAN blocker when scope-check.json is absent, but the user-facing guidance may be confusing because it can sound like Lattice lacks scope_check_save.

## Key Insights
scope_check_save already exists and is registered as PLAN gate evidence. The correctness issue, if any, is ergonomics: story_review/session guidance should clearly tell users to run the scope-plan reviewer or scope_check_save path, while preserving reviewer authority and gate semantics.

## Solution Tradeoffs
Do not weaken PLAN gates or auto-generate reviewer evidence. First write and audit a detailed execution plan; only then let Lattice execute an implementation story if the plan identifies a real correctness/ergonomics fix.

## Conversational Texture
The user wants Lattice to drive the work, with two host-style audits and final auditor review before execution.
