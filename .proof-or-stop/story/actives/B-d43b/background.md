## Trigger Event
Baseline story B-4bd7 recorded on 2026-06-23 that ordinary provider text mentioning Codex had previously triggered the Codex adapter evidence gate. This follow-up addresses baseline dimension 3 with a narrow regression proof.

## Key Insights
The correctness issue is scope classification, not adapter capability. Provider-only prose can mention Codex as a host without touching adapter assets, while real adapter surfaces such as .lattice-codex, verify_codex, or lattice codex verify must still require adapter verification evidence.

## Solution Tradeoffs
Prefer a small smoke test plus baseline result artifact over changing runtime matching unless the smoke proves drift. The regression should run against built dist output so rebuild/install drift is visible without adding arbitrary workflow behavior.

## Conversational Texture
The user wants the six measured workflow fixes completed without optimizing for its own sake. This story keeps that discipline by proving the existing gate boundary and recording the before/after comparison for future audits.
