## Trigger Event

B-3f3d narrowed the OPEN-epoch review-inventory barrier three separate times (F-099 evidence semantics, F-103/F-104 candidate identity, F-107 queryFiltering). B-3f3d:F-107 was then marked resolved on unit-level evidence alone, and an end-to-end fixture written immediately afterwards falsified that resolution. Tracked in B-3f3d as BUG-F107-INCOMPLETE. The remaining work was split out here rather than absorbed into yet another B-3f3d review round.

## Key Insights

The decisive evidence is a digest pair: after one unrelated commit touching only a test file, the epoch invalidates with corpusDigest byte-identical (d49896cf -> d49896cf) while candidateSpecSetDigest moves (a4cb4561 -> 9dffdc85). Corpus unchanged plus candidate digest changed proves the leak sits inside the candidates projection itself, not in corpus and not in queryFiltering. changedPaths seeds buildKeywordSeeds at weight 50, so it can plausibly change which specs are selected or merely their order.

## Solution Tradeoffs

If only ORDER moves, the cheap and correct fix is to bind a sorted set of path plus contentHash instead of the ordered array. If SELECTION genuinely moves, the barrier cannot bind the selection at all and must fall back to corpus plus routing policy. Guarding malformed candidate input could be done either by validating in verifyCandidateSpecSet or by defensive handling at the barrier; the latter is preferred because the barrier feeds six gate lifecycle call sites with no try/catch and must fail closed rather than throw.

## Conversational Texture

Two process errors from B-3f3d are worth carrying forward. A verification was reported as passing when it had actually been checked by passing the field as a top-level override into a local test helper rather than through the production projection, which is a tautology that proves nothing. And a finding was marked resolved before an end-to-end fixture existed to falsify it. The stashed fixture fails correctly and should be treated as an asset, not as broken work.
