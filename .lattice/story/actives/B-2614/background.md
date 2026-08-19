## Trigger Event

On 2026-08-17 story B-7dff finished all five checklist items, resolved ten review findings across four rounds and collected four reviewer passes on its final tree, then failed to enter DONE. Its done_required_validate emitted status FAIL with reasons command-failed: FAIL root full test suite: npm test exitCode=1, while the same run logged full-suite: 47/47 passed in 335.4s and full-suite performance budget exceeded: 335410.6ms >= 300000ms. No member failed. The gate rejected a green suite because the machine is slower than the constant assumed.

## Key Insights

The problem is a class, not an incident. Four separate absolute wall-clock thresholds in the same stack were each sized against a faster host: a 270000ms per-validate-command cap, a 120000ms per-suite-member default, a 300000ms whole-suite budget, and a 900000ms CLI maximum. Three of them produced false failures during a single day of work, and each was diagnosed only after someone measured rather than assumed.

A clean detached worktree of main at 860b7b45cf, run on the same host in the same session, gives TIMEOUT test:flow-stability-smoke 120.0s and full-suite: 48/49 passed in 296.8s with exit 1. That comparison is what separates a pre-existing repository condition from a regression introduced by in-flight work, and it also shows the 296.8s figure is not really under budget: it fits only because a member was killed 41s early. With that member running to completion the suite is structurally about 335s here.

The measurement inputs for a better guard already exist. The runner writes cpuInventory.userSeconds and systemSeconds, workerUtilization, criticalPath and a baselineComparison against historicalSerialMs 1688918. A guard expressed in accumulated CPU time, or as a ratio against a recorded baseline, would have caught the regression the 300000ms constant was meant to catch while staying silent on a merely slower machine.

## Solution Tradeoffs

Option A, raise each constant: trivial and immediately unblocking, but it re-arms the same failure on the next slower host and quietly weakens a regression guard. It is what the guard author was trying to prevent.

Option B, make the whole-suite guard host-relative (CPU time or baseline ratio) and give the genuinely at-risk members explicit budgets sized to measured contended duration: keeps the guard meaningful, costs real design work, and needs a defensible answer for what the new threshold means.

Option C, demote the whole-suite breach to a warning and keep member failures fatal: cheapest honest option, preserves the signal for a human without failing a green suite, but loses automatic enforcement of the performance goal.

The pinned-command cap is separable and much simpler: resolvePinnedCommandTimeoutMs should consult doneRequiredCommands as well as validate.commands, since npm test already declares 7200000ms there.

## Conversational Texture

This surfaced while driving B-7dff to DONE under an instruction to follow the whole process without escalating routine calls. Three ways out of the block were available and two of them were refusals on principle rather than on cost: relabelling a deferred waiver to permanent would have cleared the ProofStory completeness gate in one field edit but was the same move a reviewer had already caught and filed as a finding earlier in that story, and editing the 300000ms budget from inside B-7dff would have meant weakening a guard to pass the story that tripped it, on a boundary that story had itself declared out of scope. The operator chose to fix the budget in its own story instead. Worth preserving: the first instinct on seeing 335s was that B-7dff had introduced a 34 percent regression, and a main-baseline run on the same host falsified that within ten minutes.
