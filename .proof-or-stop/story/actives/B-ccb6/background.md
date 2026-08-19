## Trigger Event
During B-9f8a on 2026-07-15, done_prepare's 240-second outer DONE-required phase timeout was confirmed shorter than the configured sequential 290-second build and 1,200-second test budgets. A direct done_required_validate then ran npm test normally but was killed after 300.7 seconds of silence by the CLI idle watchdog; rerunning with bounded idle/max overrides completed PASS in 573.8 seconds.

## Key Insights
The command-level timeout, phase hard deadline, CLI idle watchdog, and absolute lifecycle timeout are different safety layers. The fix must keep all layers fail-closed while making their budgets coherent. Existing fresh receipt provenance already contains policy and command evidence, so redundant reruns should be skipped only after a structural freshness decision rather than an operator prose assertion.

## Solution Tradeoffs
Removing the phase deadline or globally disabling the idle watchdog would hide true hangs. A fixed larger constant would only postpone the mismatch. The preferred design derives the phase deadline from ordered effective command budgets plus bounded grace, emits liveness during active DONE-required commands, and reuses receipts only when HEAD/material/story-files/policy/command-set/build-proof bindings remain current.

## Conversational Texture
The user asked to execute the remediation document in priority order, starting with #1 before dispatch, routing, session identity, and scope anchors. The prior documentation story took over an hour largely because validation was repeated and false timeouts forced retries, so this first implementation must measurably remove that convergence tax without reducing assurance.
