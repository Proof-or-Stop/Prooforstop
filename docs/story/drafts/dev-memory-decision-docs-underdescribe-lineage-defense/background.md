## Trigger Event

While signing the delivery check for B-c86f, the delivery lane traced every documented promise to code and found the reverse problem: code stronger than its documents. Two rounds of cross-host review had widened the lineage defense from symlinks to an allowlist of plain committed files and then to a rule about record filenames used as directories, and the decision documents were not revisited after either.

## Key Insights

The documents are not wrong, they are incomplete. Every sentence they contain is still true, which is why the docs lane and the process-fact contract did not fire: the contract pins the rationale string, not the decision prose, and the docs lane checks documents against symbols in the diff, which it did for the earlier rounds. A defense described more narrowly than it is implemented is a maintenance hazard, because the next person to touch the code will trust the document and may narrow the code back to match it.

## Solution Tradeoffs

Fixing it inside B-c86f would have cost a development bounce on a story that had already been frozen once by the convergence breaker for review-round count, for a change that carries no behaviour. Deferring costs nothing today and leaves the code and the red test as the truth until the documents catch up. The paragraph to add is small; the value is that three sources agree.

## Conversational Texture

The delivery reviewer raised it as a completeness gap rather than a finding, and judged shipping honest. The main agent agreed and recorded it here so the drift is owned rather than rediscovered.
