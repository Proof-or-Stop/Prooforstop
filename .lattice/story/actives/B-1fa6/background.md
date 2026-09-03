## Trigger Event
On 2026-08-30, the user asked to turn the Dynamic Finding discussion into a canonical Markdown execution plan. Historical Story B-cdf6 and findings F-056, F-067, and F-070 show that finding truth, current-Story applicability, runtime freshness, and ownership cannot remain compressed into the open, resolved, and dismissed lifecycle states.

## Key Insights
A fresh CLI inventory shows enough historical findings to amplify REVIEW cost materially, but dynamic applicability alone cannot honestly solve detector noise, concurrent write loss, incorrect historical statements, or runtime-artifact drift. The design must separate candidates, verified findings, applicability, freshness, supersession, and ledger integrity while keeping historical learning non-authoritative.

## Solution Tradeoffs
This Story produces the specification only. It does not change Finding schemas, lifecycle gates, or runtime behavior, and it does not create the three follow-up implementation Stories. One program with four responsibility components and three ordered delivery Stories costs more planning up front but preserves gate safety, legacy compatibility, rollback, and review convergence.

## Conversational Texture
The user wants whole-Story delivery to become faster without allowing high or critical defects to disappear for convenience. The document must use named finding IDs, current CLI evidence, and reproducible queries to explain why the seven problems exist, what each component owns, what remains only mitigated, and how the package rename from @lattice/lab to @proof-or-stop/lab demonstrates a scope change.
