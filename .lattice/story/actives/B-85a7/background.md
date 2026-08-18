## Trigger Event

Story B-9ff1's closing review produced a correction chain on a single dev-memory lesson that did not
converge. Each entry was written to fix a false claim in its predecessor, and each introduced a
smaller defect of the same kind, which the next review round found. The concept lane recorded the
final two as B-9ff1:F-076 and B-9ff1:F-077 and judged both acceptable to defer, on the explicit
ground that another in-story correction would repeat the pattern rather than end it. The human
running the story had already set that termination condition before the round began.

## Key Insights

Two shapes recurred, and both are properties of the FORMAT rather than of any author's care.

First, self-referential absolution. Entries kept asserting that their own text was free of something
- "carries no count", "with nothing in it that can go stale". Each such claim is a statement about a
whole body of prose, checkable only by exhaustively searching for every instance of a category, and
each was written after checking for a narrower set than the claim covered. The claim reads as a
guarantee to the next reader while resting on a spot check.

Second, embedded volatile values. A correction meant to disprove a stale claim did so by pasting a
live query result into permanent prose, naming a dev-memory id as the thing retrieval currently
returns. That id was superseded within the same session, so the correction became stale in the same
way as the text it corrected. The same shape covers pasted counts, lane splits, allowed-phase lists,
and command exclusion lists - a figure about an artifact is a second copy of something that lives
elsewhere and changes without the copy.

What distinguishes the safe case matters and should be preserved: an ordinal about the correction
chain itself - "the third version", "superseded twice" - is stable, because that chain is fixed once
written. Forbidding those too would be an over-correction, and was tried during B-9ff1.

## Solution Tradeoffs

The candidate fix is a format rule enforced at dev_memory_capture: reject an entry whose text asserts
that the entry itself lacks some property, and reject an entry embedding an identifier of another
dev-memory entry as a claimed current retrieval result. A rule enforced at write time cannot be
forgotten the way a convention can, which is the whole point - the failures above were not caused by
ignorance of the convention, since several of the offending entries state the convention in their own
body.

The risk to weigh is over-blocking. Quoting a false claim in order to correct it must remain legal,
and a correction naming which entries it supersedes must remain legal - both were essential to how
this chain was eventually documented. So the rule needs to distinguish assertion from quotation and
supersession metadata from a claimed retrieval outcome, and a rule that cannot make that distinction
cleanly is worse than none. Decide whether the check is lexical or requires structure the entry does
not currently carry.

A weaker alternative worth pricing: no enforcement, only a documented format section plus a lint the
author may run. That is cheaper and preserves flexibility, but it is exactly the regime under which
this chain occurred.

## Conversational Texture

The evidence here is unusually direct: the failures are recorded, in order, in one story's ledger,
each with the review finding that caught it. Anyone implementing this can read the chain and check a
proposed rule against every entry in it - a rule that would not have blocked the offending text is
not a rule worth shipping.
