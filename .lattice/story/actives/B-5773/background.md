## Trigger Event
On 2026-06-13, after B-8448 produced the cli-engine English execution plan and 19 reviewer wording fixes were applied directly (commit a40b3686f), the user supplied a second, deeper review with 20 structural suggestions about terminology consistency, command-description length, behavior-sensitive regex rows, and the need for a glossary plus a CLI style guide.

## Key Insights
The remaining issues are project-wide conventions plus genuinely behavior-sensitive code, not one-off wording. Manifest rows M668/M669 are runtime regexes matching Chinese strings (if (/默认 dry run|.../i.test(combined))); deleting Chinese branches changes matching behavior, so they need test gating, not prose translation. Terms vary across 762 rows. 'real-machine tests' maps to the code identifier realMachineTests (37 refs) and must stay in sync, so it is deliberately kept.

## Solution Tradeoffs
Applying these as direct edits (as with the 19 wording fixes) is unsafe given the behavior-sensitive regex rows and the 762-row scale. A gated koala story routes the work through REVIEW (catch convention drift and T/M divergence) and TEST (confirm behavior-sensitive changes carry test updates). Skipping standardization leaves the open-source deliverable inconsistent and risks an implementer mistranslating regex code. The plan document remains the only deliverable; no source is touched.

## Conversational Texture
The user reviewed the manifest twice: first 19 line edits applied directly, then asked whether to create a story for the larger 20-point set. They approved creating this story as proposed at medium priority and chose to keep 'real-machine tests' unchanged because it is an established code term.
