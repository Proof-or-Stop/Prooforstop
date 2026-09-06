## Trigger Event

On 2026-09-04, while migrating handlers during B-77e6 CHK-003, an implementer reported that two suites were failing before its change and reproduced both against the main checkout's own build. Confirmed independently from the main checkout: `node packages/main/dist/tasks/evidence-plan-smoke.js` exits 1 with an assertion that `renderEvidencePlanReport` never prints the line it expects, and `node packages/main/dist/tasks/candidate-spec-routing-smoke.js` exits 1 on its collector-valid case. Neither failure is caused by that story.

## Key Insights

The reason both can be red on main is that nothing runs them. `npm test` is `node packages/main/dist/tasks/full-suite-runner.js`, which builds its entry list from `entriesFromSerialReference(serialReference, pkg.scripts)` — that is, from the root `test:serial-reference` script. Grepping `package.json`, `packages/main/src/tasks/full-suite-runner.ts` and `proof-or-stop.config.json` for either suite name returns nothing, so neither is in the serial reference, the runner's RESOURCE_POLICY, nor the config's validate commands. A suite in none of the three is never executed by any gate, so it can fail indefinitely without any story noticing.

The failure is therefore not that two suites are broken. It is that a suite file can exist, be maintained, be worth running, and be reachable by nobody, with no signal anywhere that it has fallen out of every inventory. Whoever wrote those cases believed they were protecting something.

A caution for whoever picks this up, learned by getting it wrong while writing this draft. A quick script that tries to classify every `*-smoke.ts` under `packages/main/src/tasks` as registered or orphaned by matching script names against the serial reference produced an obviously wrong answer: it reported as unregistered several suites that are demonstrably run, including ones executed during recent stories. Script names, file stems and the names embedded in script bodies do not correspond one-to-one, so a naive match misclassifies in both directions. Do not trust such a sweep, and in particular do not put a count from one into a document. The reliable check for a single named suite is a grep of the three inventories, which is how the two suites above were confirmed. Building a trustworthy sweep is part of the work here, not a preliminary to it.

## Solution Tradeoffs

The narrow fix is to register both suites and repair whatever their failures reveal, which may be a genuine defect in `renderEvidencePlanReport` or may be a stale expectation. That restores two checks and says nothing about the rest.

The structural fix is a guard that fails when a suite file under the tasks directory is reachable from none of the three inventories, in the spirit of the registration case the single-owner audit already carries for itself. The cost is that it must distinguish a suite that is deliberately not registered — an interactive benchmark, a one-shot migration probe, a fixture helper that merely looks like a suite — from one that fell out by accident, so it needs either an explicit opt-out list or a shape rule, and an opt-out list is itself the hand-curated thing that tends to drift.

The middle option is a report rather than a gate: have the runner print which task files it did not run, so the set is visible at every full-suite run without blocking anyone. That is weaker, but it cannot be gamed by adding a name to a list, and it would have surfaced these two immediately.

## Conversational Texture

Surfaced by an implementer that was told to report rather than work around anything it did not expect, and that correctly refused to touch the failures because they were outside its scope. It reproduced them against the main build rather than asserting they were pre-existing, which is what made the claim checkable. A peer session on the same machine independently reported the same family of defect from a cross-vendor review — a verifier whose completeness depended on a hand-curated list, three levels deep, where deriving each level in turn kept revealing another curated one underneath. Registration inventories are the same shape: a list that looks authoritative and silently omits.
