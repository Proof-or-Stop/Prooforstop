## Trigger Event

While closing B-9ff1 on 2026-08-19, a merge of main into the story branch conflicted in
lattice.config.json. The resolution used the story side as the base and appended only main-only
entries, so the 92 entries present on BOTH sides kept the story's older form and silently lost main's
B-7dff resource declarations. The quality lane found it and quantified it (B-9ff1:F-079): resources
declared fell from 97 of 111 commands on main to 5 of 117 in the merged file. No test went red, and
the test that exists for exactly this surface still reported PASS.

## Key Insights

The loss was invisible at every layer that was actually checked. A reviewer had already verified, by
command key, that no command was dropped - and that was true. The damage was one level down, in the
FIELDS of entries whose keys matched on both sides, and a key-level comparison cannot see it. A git
diff of the conflict resolution shows no marker either, because the resolution is what wrote the file.

Nothing broke, which is why nothing caught it. validation-executor's
resolveValidationCommandResourceClaims defaults an undeclared command to exclusiveByDefault true, so
the suite still runs correctly - just serially where B-7dff had just made it parallel. A regression
that only costs time and never fails is precisely the kind that survives a green suite.

packages/main/tests/validate-resource-claims.test.mjs is the test that should have noticed. Its only
assertion over the real configured plan is `declared.length > 0 && byDefault.length > 0` (line 243).
That holds at 5 declared of 117 exactly as comfortably as at 97 of 111. The test's own transcript even
prints the real numbers - "configured plan: 117 commands, 97 declared, 20 exclusive by fail-closed
default" - so the information was on screen while the assertion ignored it.

## Solution Tradeoffs

The obvious fix, tightening the bound to an expected count or ratio, was considered and is probably
wrong on its own: a hardcoded expectation goes stale every time a command is added, and coupling a
per-package unit test to a moving branch creates a different, noisier failure mode. That is trading a
silent regression for a brittle one.

The more durable shape is a structural comparison at merge or review time: for every command key
present on both sides, compare the ENTRY CONTENT, not just the key, and report fields present on one
side and absent on the other. The test-coverage lane performed exactly that check ad hoc while
reviewing the fix and it took one pass over both files - the mechanism is cheap; what is missing is
that it runs automatically. That may belong to config-merge tooling rather than to this unit test, and
deciding which is in scope here.

A third option worth pricing rather than dismissing: make the runner surface the proportion, so a drop
from 97 to 5 shows up in output a human reads even if no assertion fires.

## Conversational Texture

This story exists because a defect that cost nothing but speed slipped through a green suite, a
key-level review, and the one test written for its surface. The reviewing lane declined to patch the
threshold from the story where it was found - the test belongs to B-7dff and had landed two days
earlier - and recommended the scoping decision be made deliberately rather than unilaterally.
