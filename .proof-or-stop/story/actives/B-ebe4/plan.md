# B-ebe4 Execution Plan

## CHK-001 — Detect self-host worktree and runtime realpath mismatch
Add a pure runtime-authority classifier at the shared CLI seam. It will canonicalize the active entrypoint/core realpath, identify the current git worktree and common main checkout, distinguish Proofbound self-source from external projects, and return a typed pass/refusal result. Reuse the runtime fact registry and checker contract; do not add process-gate facts. The classifier must accept local bootstrap and symlinked worktree-local entrypoints, external global installs, and the explicitly marked global-fallback session_brief heartbeat.

## CHK-002 — Fail fast with one canonical local-entrypoint recovery command
Invoke the classifier after command alias/root resolution but before handler registry construction, validation, ownership mutation, or activity evidence writes. On mismatch, exit non-zero with reasonCode=stale_global_runtime_in_worktree, identify the loaded runtime versus authoritative worktree, and render exactly one safely quoted node bin/lattice.js rerun preserving the original normalized command and arguments. Keep bootstrap missing-build recovery separate and retain help/version behavior. Update canonical runtime diagnostics/docs where the fact is user-visible.

## CHK-003 — Prove stale-global rejection and correct-local execution end to end
Add hermetic tests with a main checkout, linked story worktree, symlinked launchers, nested cwd, and external consumer root. Assert stale global validate/story mutation reaches zero handlers, validation commands, evidence writes, or metadata commits; global-fallback only permits session_brief; aliases cannot bypass the guard; correct node bin/lattice.js execution succeeds; external global execution remains advisory/valid. Run TypeScript build, focused runtime smoke, validation protocol smoke, and scripts/verify-runtime-fact-contract.mjs.
