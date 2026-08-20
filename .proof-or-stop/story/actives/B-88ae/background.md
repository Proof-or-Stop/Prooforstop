## Trigger Event
2026-06-25 user asked whether the recommended source structure from the architecture review is actually implemented, then asked to develop it and estimate milestones. The current code still has flat proof-admissibility and repro-intake modules while the docs now define layered evidence and lifecycle-control paths.

## Key Insights
This is a structural convergence task, not a behavior change. The safest slice is to add stable directory entrypoints and compatibility re-exports first, then let later stories move implementations behind those paths. That avoids breaking existing proof, repro, and gate imports while giving new work a canonical target.

## Solution Tradeoffs
A full move of proof-admissibility.ts and repro-intake.ts would touch many gate and smoke imports at once. A compatibility-first layout is less dramatic but safer: it creates the recommended package shape, proves build compatibility, and leaves old paths as supported adapters until a later migration can update callsites incrementally.

## Conversational Texture
The user is trying to turn the architecture recommendations into concrete implementation discipline. They care that future hosts do not improvise module boundaries or create another proof stack. The result should make the source tree visibly match the documented layers without pretending the full Global Control Plane is done.
