## Trigger Event
During B-62b8 closeout on 2026-07-18, official gap_log output at B-META-framework-audit was classified as unsafe dirty state, while earlier stories also required acknowledgements because source-relative checklist paths did not match repo-relative git paths and regex anchors selected control flow or local variables.

## Key Insights
The failures share a boundary problem: scope facts are persisted and compared in ambiguous path forms, and semantic ownership is inferred from text rather than syntax. Canonical paths and parser-versioned declaration identities must be established before enforcement, while official shared metadata needs narrow provenance-aware classification.

## Solution Tradeoffs
Canonicalize once at write time and compare one repo-root-relative representation rather than trying multiple bases forever. Use AST declarations with explicit parser-version migration instead of keyword regex patches. Accept migration complexity and bounded re-attestation, but retain fail-closed behavior for traversal, symlink escape, protected anchors, unknown .lattice files, and direct untrusted story edits.

## Conversational Texture
The user wants this completed immediately after stable owner identity because these false positives repeatedly caused acknowledgements, extra review rounds, and wasted validation time. The implementation must stay bounded, avoid corpus scans, preserve real blockers, and proceed autonomously through DONE without asking for routine manual confirmation.
