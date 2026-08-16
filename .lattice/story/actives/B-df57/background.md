## Trigger Event

B-8de3 reached REVIEW with 13/13 fresh mechanical receipts and four signed reviewer lanes, but REVIEW to TEST failed because ProofStory contract refs used CHK-xxx:lane:index while verificationEvidence used the corresponding authored intent IDs.

## Key Insights

The two ref forms are aliases for one immutable verificationIntent row. Exact string comparison creates a false missing-evidence result. Adding fake duplicate evidence or allowing REVIEW to rewrite a frozen PLAN contract would weaken the trust boundary.

## Solution Tradeoffs

Canonicalize both ref forms against the current checklist row before coverage comparison. Keep unresolved, cross-item, malformed, out-of-range, duplicate-ID, and ambiguous refs fail-closed. Do not alter evidence command/selector pins, phase policy, or contract mutability.

## Conversational Texture

The operator should see ProofStory completeness PASS when the exact authored row has a fresh passing receipt, regardless of which supported ref spelling the frozen contract used.
