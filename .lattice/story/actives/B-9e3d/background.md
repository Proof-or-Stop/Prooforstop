## Trigger Event

Raised on 2026-08-18 as finding B-7dff:F-014 by the lattice-review-quality lane while reviewing story B-7dff on its merged tree. The reviewer was asked specifically to look for places where the two hand-merged concurrency models silently disagree, and this is what it found: full-suite-runner.ts scaling declared budgets by CONCURRENCY_HEADROOM_FACTOR 1.5 at jobs greater than one, while validation-executor.ts drives the same runScheduled primitive with the same default concurrency and applies lattice.config.json timeouts as a flat ceiling.

## Key Insights

A shared engine did not produce a shared policy. B-7dff extracted the keyed scheduler into core so both the full suite and routine validate could use one admission-control implementation, which it does; but the two callers arrived with independently developed assumptions about whether a configured timeout describes standalone work or contended work, and the extraction did not force that question.

The gap is currently held closed by a comment. validation-executor.ts asserts the configured values are already calibrated against the concurrent case; nothing checks it, nothing references the headroom model, and the numbers in lattice.config.json carry no marker saying which regime they were measured under. That is the same shape as several defects this repository has already paid for, where a true statement in a comment stopped being true and nothing noticed.

Timing matters for whoever picks this up: the divergence does not exist on main. It arrives when B-7dff merges, because routine validate only begins using the shared scheduler at that point. So this is not archaeology on existing code, it is finishing a change that just landed.

## Solution Tradeoffs

Option A, apply headroom to routine validate as well: makes the two callers identical and removes the question. Cost is that every one of the roughly 110 configured timeoutMs values silently changes meaning from contended ceiling to standalone budget, effectively multiplying each by 1.5 at the default concurrency, which needs to be documented and measured rather than assumed harmless.

Option B, keep the flat ceiling and make it an asserted invariant: cheaper conceptually and preserves what the config values mean today, but requires a source of observed contended durations to check against, and that data has to come from somewhere and be kept fresh.

Option C, leave it and rely on the comment: rejected. It is the current state, and the reason this finding exists.

## Conversational Texture

This came out of the sixth review round on B-7dff, in a session where the operator had asked for the full process to be followed without escalating routine calls. The finding was deferred rather than fixed inside B-7dff on the grounds that reconciling the policies changes what every configured timeout means and deserves its own measurement and review. That deferral was then itself caught: a later reviewer checked the claim that the work had been filed as a task, searched story_list and bug_list, found nothing, and registered B-7dff:F-015 - the disposition had been recorded only as a Claude Code session chip, invisible to the Proof-or-Stop story system and gone when the session ends. This story exists so that the deferral is real rather than asserted.
