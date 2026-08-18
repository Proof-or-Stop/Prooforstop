## Trigger Event

On 2026-08-18 the concept reviewer lane on story B-9ff1 declined to pass and filed B-9ff1:F-068,
recommending this story explicitly. Its argument was empirical rather than theoretical: B-9ff1
produced a correction chain that needed THREE iterations of the same lesson - dev-memory entries
a67bb17, then 8d1d2bb, then e367ec1 - and all three remain retrievable, with the first two still
asserting claims established as false. Two other lanes independently falsified the middle entry in the
same round (B-9ff1:F-067 from test-coverage, B-9ff1:F-069 from behavior).

## Key Insights

`.lattice/dev-memory/experience.jsonl` is append-only through `dev_memory_capture`, and there is no
update, supersede or withdraw command anywhere in the dev_memory surface (capture, list, search,
preflight, preflight_ack, finish, finish_decision, start). The only available correction is to append
a new entry naming the old one as superseded and hope the reader arrives via the tag or the
reusePrompt.

That hope is misplaced in the one direction that matters. Retrieval is by relevance to a trigger, so
a future session asking about the same trigger can surface the SUPERSEDED entry alone, with its false
sentence and no indication anything replaced it. The correction is discoverable only if you already
know to look for it. B-9ff1 also demonstrated the compounding failure mode: each successive correction
was written in the same way that produced the original, so entry two shipped with a fresh
self-contradiction and needed a third.

Worth stating plainly because it bounds the value of the whole ledger: a wrong lesson is worse than no
lesson, because a session retrieves it and acts on it. An append-only store of advice with no
retraction primitive accumulates confidently-worded mistakes and surfaces them with the same
authority as the corrections.

## Solution Tradeoffs

A tombstone honored at the RETRIEVAL path is the shape that actually closes this: an entry marked
superseded should not be returned as a standalone hit, or must be returned with its successor
attached. Adding a `supersedes` field that only the writer sets and nothing enforces at read time
reproduces the current situation with more ceremony.

Deletion is the wrong instrument. The ledger's value depends on being append-only and auditable - the
history of a mistaken lesson and its correction is itself a lesson, as this story shows. Withdraw and
supersede must both be recorded events, not erasures.

There is a scope question to decide rather than assume: whether withdrawal should also apply to
entries whose author later judges them merely low-value rather than wrong, and whether a superseded
entry should remain searchable by explicit id. Deciding narrowly (wrong-only, id-searchable) is
probably right but should be stated.

## Conversational Texture

This story exists because a reviewer refused to accept a stopgap as a fix, and named the evidence: not
that the mechanism might fail, but that it had already failed three times inside the story it was
reviewing. The story owner had written the stopgap's own honest caveat - "superseding does not remove
a67bb17 from the ledger" - and then treated writing that caveat as sufficient.
