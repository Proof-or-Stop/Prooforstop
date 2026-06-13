# B-5773 Transcript Diff

## Expected

A reviewer opens
`docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md`
and finds, near the top, an **English Glossary** (fixing term choices: blocked
vs excluded, source of truth, iteration vs round, Story vs story, Git vs git,
evidence uncountable, finding, real-machine tests kept) and a **CLI Style
Guide** (imperative + sentence case + no final period; Enable/Disable/Emit/
Skip/Fail-if flags; noun-phrase schema; <= 80-char command descriptions;
preserve identifiers). The 762-row translation manifest consistently uses those
terms; command descriptions are short; runtime regex/`.includes` rows that match
Chinese are marked `behavior-sensitive` and listed in a dedicated subsection;
M004/M005 read as one coherent sentence. The change is mechanically verifiable.

## Actual

User-perspective document check (run from the worktree root):

```text
$ grep -nE '^## (English Glossary|CLI Style Guide|Behavior-sensitive rows)' <doc>
65:## English Glossary
91:## CLI Style Guide
1198:## Behavior-sensitive rows

$ node .lattice/story/actives/B-5773/evidence/verify-b5773.mjs
TOTAL 51 | PASS 51 | FAIL 0
```

Spot checks (proposedEnglish column):
- `Output JSON` → `Emit JSON` (0 stale), `truth source`/`finding item`/`self-pardon` → 0 remaining
- M019/M177/M185 → `Command to run`; M586/M588 → `prevents self-approval`
- M747/M751 → `Git repository`; M036–M053 → `iteration` (no bare `round`)
- command-description rows: longest 80 chars (was 218); behavior-sensitive: M668/M669/M750
- manifest rows: 762; Chinese chars in proposedEnglish: 0

## Diff

Expected and actual match. The standardized plan now carries a glossary +
style guide and applies them consistently across the manifest, with
behavior-sensitive runtime matchers quarantined for test-gated handling.

## Known limitation (point-in-time snapshot)

The manifest is a point-in-time snapshot of the 762 Chinese-bearing
`cli-engine.ts` lines at generation time. The DONE-gate `git merge main`
pulled in concurrent work (B-4e06) that added 5 Chinese lines to
`cli-engine.ts` (now 767) and shifted the behavior-matcher line numbers
(2303/2306/3887 → 2311/2314/3926). The doc already instructs implementers to
**regenerate the manifest from the implementation branch before changing
source**, so this drift is expected and out of scope for this standardization
story. The 3 behavior-sensitive matchers are unchanged in content and remain
correctly tagged (verified by content, not line number).

`packages/main/src/cli-engine.ts` was not modified by this story.
