# Plan: B-d669 live-smoke transcript lifecycle artifact scope

## Objective
Fix the scope gate false positive where the first-party live_smoke_transcript command writes evidence/live-smoke-transcript.json, but scope classification treats it as ordinary Lattice metadata and blocks TEST/DONE.

## CHK-001
Register evidence/live-smoke-transcript.json in the closed lifecycle artifact relative-path registry. Keep the change exact-path only; do not add an evidence/ prefix or any broader metadata exemption.

## CHK-002
Extend regression coverage so the scope contract accepts .lattice/story/actives/B-scope/evidence/live-smoke-transcript.json as non-blocking lifecycle_artifact, keeps transcript-diff coverage, and still blocks .lattice/story/actives/B-scope/evidence/notes.md.

## CHK-003
Update lifecycle artifact scope policy text to name the live-smoke transcript alongside transcript-diff and restate that arbitrary nested evidence files remain fail-closed.

## Verification
Build packages/main, run scope-contract smoke, run live-smoke transcript smoke, and run scripts/verify-process-fact-contract.mjs. Record verificationEvidence per checklist item after the code/doc commit.
