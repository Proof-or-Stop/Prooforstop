## Trigger Event
B-4c48 completed baseline item 4, leaving baseline item 5 open: delivery-check evidence can look fresh after the material it reviewed has changed, so a stale delivery review may still appear acceptable near DONE closure.

## Key Insights
This is not a general optimization problem. The correctness gap is the missing material binding on delivery-check evidence; if source material changes after the delivery reviewer signs, the gate should fail closed and request a fresh delivery review.

## Solution Tradeoffs
Bind delivery-check to materialHash and keep headHash as audit metadata rather than a hard metadata-only blocker. This catches real source changes without creating arbitrary rerun loops from later Lattice metadata commits.

## Conversational Texture
The user wants each baseline issue fixed as its own story with evidence, not a broad refactor. The result should be easy to compare against the baseline and should preserve Lattice role separation.
