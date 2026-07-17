## Trigger Event
During B-c163 and the 2026-07-16 workflow-remediation investigation, real unattended host execution appeared hung for multiple minutes while deterministic local routing completed quickly; the same review program also observed tiny changes escalating from bounded candidates to more than one hundred documents.

## Key Insights
Readiness probing and execution are separate: a launcher marked unverified can pass shallow availability checks yet block on authentication or interaction after spawn. Candidate routing now contains a document-frequency filter, but its full acceptance contract, relevance-aware truncation, explanation fields, and rollout-mode consistency still need proof against current main.

## Solution Tradeoffs
Use two independently configurable controls: a short startup or first-output watchdog and a longer total execution deadline. Fail closed for automatic routing when unattended support is not positively established. Preserve exact paths, related documents, registries, structured risks, and reviewer evidence even when generic tokens are filtered. Keep rollback flags separate so ranking can be reverted without admitting unverified launchers.

## Conversational Texture
The user explicitly wants the remaining remediation executed without another long convergence cycle. The PLAN must define the complete host-state and routing matrix before implementation, use deterministic fake children instead of live external hosts, synchronize main before final validation, and avoid repeating full-document scans or incremental one-bypass-at-a-time review fixes.
