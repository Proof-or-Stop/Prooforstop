# Production validation budget: 260 seconds

The user explicitly requires the production validation timeouts to match the
260-second Lab acceptance threshold. Change exactly these complete commands in
`proof-or-stop.config.json` from 180000 to 260000 milliseconds:

- `node scripts/verify-process-fact-contract.mjs --quiet`
- `node packages/main/dist/tasks/red-evidence-target-binding-smoke.js --canonical-core`
- `node packages/main/dist/tasks/red-evidence-envelope-smoke.js --canonical-core`

This is an authorized operational-budget change, not a performance improvement.
Command arguments, test bodies, resources, unrelated budgets and inventory
membership remain unchanged. Earlier complete semantic runs reached about
199 seconds, so a 180-second production timeout could interrupt valid work even
though the 260-second Lab acceptance passed.

The committed regression selects each exact executable and argv and requires
one registration with timeoutMs equal to 260000. Its pre-change RED is the real
180000-ms production value failing that requirement. GREEN checks the production
configuration and all static references to its current bytes. It does not claim
a new full validation campaign or a measured speedup.

The static manifest keeps all 311 exceptions, call bindings, rationales and
invocations. Its complete command-inventory digest and the 22 existing
configuration dependency digests were refreshed. Two existing configuration
source excerpts also bind the new file digest and retain their exact line bounds;
their original excerpts were checked against the original committed bytes before
refreshing. A semantic comparison verified
that the three timeout values are the only configuration edits and those exact
digests and those two source excerpts are the only configuration-related manifest
edits. No exception is added or broadened.

The regression is registered as `npm run test:validation-production-budget-260`.
The existing `test:reviewed-source-bindings` serial-reference member invokes it,
so the default serial and policy-derived full suite include the guard without
changing suite membership or introducing an unclassified resource policy. The
41 existing root-package dependency digests follow these exact script edits.

The pinned Lab command also imports and executes the actual static-edge verifier,
including all package, lockfile and source-excerpt bindings. Its successful
output includes `U18_STATIC_PASS` before `PRODUCTION_VALIDATION_260_GREEN`.
The focused configuration assertions are additional checks; the actual verifier
remains the acceptance authority for the static manifest. Release-time package
digest refreshes are therefore checked again on the built candidate and main.

This focused Lab can be integrated separately from the remaining validation
audit Lab, whose other audit findings retain their own status and evidence.
