## Trigger Event
B-914f F-010/F-012 required two repair rounds because the first reuse predicate checked coverage but omitted optional and semantic PASS fields. B-914f F-011 also showed an environment-driven test seam reaching writeFileSync. In B-ebe4, delivery_check_set accepted status=unverified together with verifiedBy and produced an invalid PASS artifact.

## Key Insights
These are not three unrelated typos. They share a missing mechanical completeness rule: security- or gate-relevant envelopes are validated field by field instead of normalized as a total, internally consistent outcome, while test-only control data can enter production side-effect paths without a capability boundary. Review eventually catches them, but only after extra DEV and review rounds.

## Solution Tradeoffs
A single source for normalized PASS semantics plus generated mutation and contradiction matrices costs more test setup but prevents incremental patching of one forgotten field at a time. A bounded AST or taint-style guard may need explicit narrow exemptions, so it must target production core and handlers and allow temp-repository helpers or capability-limited callbacks rather than banning all environment reads.

## Conversational Texture
The user explicitly asked to verify whether F-010 and F-011 caused avoidable extra rounds and to keep working without repeated manual confirmations. During B-ebe4, the same envelope inconsistency produced a false delivery PASS, providing fresh live evidence that this class deserves one compact hardening story instead of more reviewer memory or two separate lifecycle-heavy stories.
