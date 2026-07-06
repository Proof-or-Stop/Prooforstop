## Trigger Event
During B-f511 (POS campaign M3: interrupt/resume idempotence probe, merged to main as 51c68420b on 2026-07-06), the M3 REVIEW raised two LOW test-hardening findings, F-017 and F-018, against experiments/pos-instrument-replay/selfcheck-m3.mjs. Both were resolved as accepted_risk (non-blocking) so M3 could land, with an explicit follow-up to harden the selfcheck.

## Key Insights
F-017 is a resource-leak-on-failure: selfcheck-m3's fail() calls process.exit(1), which per Node.js semantics skips pending finally blocks, so a sub-check's mkdtemp sandbox dir leaks precisely when a sub-check FAILS (a genuine regression). Every sub-check A-M shares this try/finally pattern. F-018 is a coverage gap: sub-check M (checkResumeBreakFailureDiagnostic) asserts exit 2, the diagnostic, break-mutex released, and campaign ledger untouched, but never explicitly asserts that LOCK_DIR (.batch-ledger.lock) and holder.json SURVIVE the forced break failure. Inspection of run-batch.mjs (842-845) confirms the fault hook throws before the real rmSync(LOCK_DIR), so they survive today, making the assertion belt-and-suspenders.

## Solution Tradeoffs
For F-017, prefer a module-level Set of active sandbox dirs registered on creation, de-registered on the normal finally cleanup, and swept by a process.on('exit') handler: this is purely additive, preserves fail()'s fail-fast process.exit semantics and exit codes, and needs no control-flow change. The rejected alternative (throwing a sentinel from fail() so each finally runs) risks catch-swallow and changes exit semantics. For F-018, add an existsSync(LOCK_DIR) plus holder.json survival assertion mirroring sub-checks H/I. Keep the entire change confined to selfcheck-m3.mjs.

## Conversational Texture
The user framed these as LOW, non-blocking test-hygiene improvements, NOT correctness bugs, to be tracked through the normal Lattice story workflow because they touch Proofbound experiment code. Acceptance is the existing selfcheck suite staying green: node selfcheck-m3.mjs (sub-checks A-M PASS) plus selfcheck-m2.mjs for non-regression.
