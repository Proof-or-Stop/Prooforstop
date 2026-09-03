## Trigger Event

On 2026-09-03 an operator asked whether the behavior rules in CLAUDE.md are
actually correct, and asked for evidence. A read-only audit ran the documented
commands against this repository and falsified seven claims while confirming
the rest. The seven are: the agent prompt asset section; the story channel
count; the story artifact directory rule; one stale story-review.ts line
citation; one stale attribution of where the INIT_CHECK blocker messages are
defined; a link to an experiment file that is absent from the whole
repository; and an incomplete host hook inventory that also omits three
commands the framework's own gate messages instruct agents to run.

## Key Insight

The existing docs-drift preflight gate only verifies that command names
referenced by CLAUDE.md exist in the CLI registry, plus a path check that
deliberately skips every path beginning with docs/story/ (audit-scan.ts, the
collect helper). That exclusion was written when the configured storyDir was
docs/story, so the broken experiment link sits exactly inside the blind spot.
None of the seven falsified claims is mechanically guarded today, which is why
they drifted silently while every existing gate stayed green.

## Tradeoff

The alternative is to correct the prose only and rely on review discipline to
keep it true. That is cheaper now and leaves the same blind spot open, so the
next refactor reintroduces the same class of drift. Adding a claim verifier
costs a new script and a new registered test command, and it can only pin
claims that are mechanically checkable, so prose claims about intent stay
unguarded. We accept that narrower coverage in exchange for a regression that
fails loudly instead of silently.

## Conversation Texture

The operator asked twice for evidence rather than for an opinion, and rejected
a summary that would have rested on reading the document alone. Every claim in
the audit was backed by a command run in this repository. The follow-up request
was explicit that the work must go through the full story process with a red
test before a green one, and that no Chinese text may appear in what this story
produces.
