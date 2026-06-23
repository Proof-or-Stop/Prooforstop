# Execution Plan

## CHK-001
Trace DONE readiness and closure ordering from the DONE oracle, done closure runbook, done_prepare, and post-DONE merge effects. Record the boundary clearly: pre-DONE recovery may synchronize main, refresh stale evidence, and rerun validation, while version bump, package sync, dist build, and experience cache refresh remain post-DONE effects. This preserves evidence binding safety and avoids optimizing unrelated lifecycle mechanics.

## CHK-002
For ordering-sensitive DONE blockers only, route operator guidance to the single host-neutral recovery command: lattice done_prepare with mergeMain, refreshStale, and validate enabled. Apply this to evidence-freshness, DONE-required validation, and branch-synced-main rows in the DONE oracle and done closure runbook. Do not change the underlying pass or fail predicates, and do not hide unrelated blockers behind done_prepare.

## CHK-003
Extend done_prepare smoke coverage with a regression scenario where main is ahead of the story branch and DONE-required evidence is missing. Assert that the DONE oracle and closure runbook both point to done_prepare, and assert that raw git merge main is not emitted as the primary recovery command. Keep the negative safety case explicit: stale or missing evidence remains blocking until the normal recovery path updates it.

## CHK-004
Update docs or diagnostics only where the user-visible behavior changed. Keep all wording host-neutral and Lattice workflow oriented. Do not add Codex or Claude namespace guidance. Preserve the design rule that done_prepare is a pre-DONE readiness assistant and that deterministic post-DONE sync remains post-DONE.
