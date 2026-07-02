## Trigger Event
On 2026-07-02 the user approved executing docs/requirements/decisions/proof-or-stop-quantum-claim-admissibility-execution-plan.md after clarifying that Quantum/PINN should become domain-specific claim-admissibility adapter packs.

## Key Insights
The repository already has a local proof-admissibility core for code-runtime evidence, but it does not yet have a quantum-specific runtime pack. The Quantum plan says M0-M1 should come first, before verifier adapters, gate policy, or benchmark execution.

## Solution Tradeoffs
Keep this story narrow: implement schema and fail-closed identity binding only. Do not present the result as scientific-truth proof, solver improvement, hardware or wet-lab assurance, or broad scientific correctness, and do not start the full A1-A4 benchmark before M1-M3 exist.

## Conversational Texture
The user is pushing toward a reusable adapter-pack architecture while also wanting concrete execution. The story should reduce ambiguity by turning the Quantum design contract into the first bounded runtime slice instead of another loose planning document.
