## Trigger Event
2026-06-18 user observed that @deprecated annotations accumulate silently over time (7 found in packages/main/src across guard-session.ts and types.ts); no existing mechanism surfaces this for periodic cleanup.

## Key Insights
audit-trigger.ts already fires every N stories (auditTriggerWindow in audit-config.ts). The DONE gate hook runs scanners at audit time. Adding a scanDeprecated function to audit-scan.ts follows the exact same pattern as the existing scanCommandDrift / scanFlagDrift / scanPathDrift functions. The integration point is the hint text appended to AuditTriggerResult, which is additive and never blocks DONE.

## Solution Tradeoffs
Option A (chosen): advisory-only — scanDeprecated count > threshold appends cleanup advisory to audit hint; never blocks DONE. Simple, zero risk to workflow. Option B: block DONE when count > threshold — too aggressive for a tooling repo where @deprecated is sometimes intentional during migration.

## Conversational Texture
User framed this as preventing legacy long-tail accumulation. The alias cleanup and @deprecated cleanup are related concerns (both are backwards-compat shims that accumulate). Current count is 7 (below a threshold of 10), so the advisory will not fire immediately — leaving headroom for future additions before the first nudge.
