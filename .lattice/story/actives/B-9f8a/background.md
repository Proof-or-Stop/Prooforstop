## Trigger Event
During B-7776 closeout on 2026-07-15, a trivial dead-parameter cleanup exposed six repeatable workflow failures: deterministic DONE-required timeout, unattended host execution stalls, generic-token full-corpus escalation, dispatch role mismatch, derived-ppid lease conflict, and scope/anchor false positives.

## Key Insights
The failures are not one implementation defect. They cross five ownership boundaries and need a shared execution sequence without combining unrelated runtime changes. Claude source-level verification strengthened the evidence and corrected the probe-versus-execution and path-shape diagnoses.

## Solution Tradeoffs
An umbrella document provides one dependency and risk model, while implementation stays split into cohesive stories. Timeout derivation must not weaken freshness, routing specificity must not hide explicit documents, and stable sessions must not collapse reviewer and implementer identities.

## Conversational Texture
The user explicitly asked for a Markdown execution document based on the combined diagnosis. The desired result is concrete enough to open implementation stories directly, concise enough to audit, and explicit about which proposed fixes are adopted, modified, or rejected.
