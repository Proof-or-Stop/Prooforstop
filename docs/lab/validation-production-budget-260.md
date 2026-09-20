# Production validation budget: 260 seconds

The user explicitly requires the production validation timeouts to match the
260-second Lab acceptance threshold. Exactly these existing complete commands
change from 180000 to 260000 milliseconds in proof-or-stop.config.json:

- node scripts/verify-process-fact-contract.mjs --quiet
- node packages/main/dist/tasks/red-evidence-target-binding-smoke.js --canonical-core
- node packages/main/dist/tasks/red-evidence-envelope-smoke.js --canonical-core

This is an authorized operational-budget change, not a performance improvement.
Existing command arguments, assertion bodies, resources and unrelated budgets
remain unchanged. The regression's real RED is the former 180000-ms production
value failing the user-requested 260000-ms requirement. This evidence establishes
configuration behavior, not a new full-suite campaign or measured speedup.

The guard has its own npm script, test:validation-production-budget-260, and an
appended validate.commands registration with a 60000-ms execution bound, full-only
assurance and explicit shared resource claims for the repository, package.json,
proof-or-stop.config.json and scripts. Existing command indexes remain stable.
The original test:reviewed-source-bindings npm command is unchanged.

The pinned Lab check executes the actual static-edge verifier. It requires both
successful exit state and the emitted U18_STATIC_PASS marker; an import that does
nothing cannot pass. It then emits PRODUCTION_VALIDATION_260_GREEN. The canonical
verifier checks all dependency and excerpt bindings, including release-time
package and lockfile digest updates on the candidate and main.

All 311 static exceptions, call bindings, rationales and invocation permissions
remain unchanged. Exact configuration and root-package dependency digests are
refreshed after the budget and registration edits. Two configuration source
excerpts retain their original line bounds; the original bytes were verified
before refreshing their digest and text. No exception is added or broadened.

The remaining validation audit Lab retains its separate findings and evidence.
