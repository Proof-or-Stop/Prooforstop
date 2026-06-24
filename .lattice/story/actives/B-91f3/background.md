## Trigger Event
On 2026-06-24 after B-fbfb closed the five high proof-admissibility convergence gaps, the user decided to remove the Authority Server production receipt from the core route and keep proof completion local to the CLI admissibility contract.

## Key Insights
The local CLI already has strong local evidence boundaries, review assurance floor, DONE-required validation, delivery check, and receipt-bundle contract tests. Treating a server production receipt as the default productionDone path keeps an unused external dependency in the core model.

## Solution Tradeoffs
This story should not delete every Authority-related adapter or historical document. The narrow safe move is to demote production receipt completion from core local admissibility, preserve legacy/external fields as false or diagnostic, and update tests/docs so default gates speak in admissibilityStatus, assuranceLevel, and evidenceScope.

## Conversational Texture
The user wants fewer daily evidence-boundary bugs and a simpler CLI-first proof model. The important part is not pretending the external server disappeared everywhere; it is making sure local CLI completion no longer depends on or advertises server production receipt completion.
