## Trigger Event
On 2026-07-28 the user approved executing M0 after B-7a84 re-audit showed that the seven original closeout defects remain fully or partially observable on current Proofbound CLI 0.3.249, while the planning branch is far behind main.

## Key Insights
M0 is a characterization stage rather than a semantic fix. Each defect needs a deterministic isolated repository probe, a structured reason code, and a named future inversion owner so later fixes can prove they changed the intended behavior without weakening unrelated gates.

## Solution Tradeoffs
Use one dedicated non-blocking characterization command whose assertions pass only when the documented pre-fix behavior is reproduced. Desired-state assertions remain explicitly expected failures until M1-M6 invert and promote them; do not add known-red desired behavior to routine validation.

## Conversational Texture
The user explicitly asked to start with M0 and confirmed that this stage is primarily test-case work. The deliverable must make the seven problems concrete and reviewable, avoid pretending reproduction is repair, and leave a clear execution order for subsequent milestones.
