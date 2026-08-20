# Plan — B-bf52: gate-failure digest precision

## 1. Problem

`gateFailureDigest` (packages/main/src/core/convergence-breaker.ts) produces the key under which
`bumpGateFailureCount` counts gate rejections. `maxGateFailureCount` feeds `assessBreaker`, which trips
the convergence breaker at a repeat count of 2 and freezes the story until a human acknowledges it.
The function's doc comment states the contract: reasons differing only in *incidental* detail collapse
to one key. Four classes were reproduced violating it, by collapsing *substantively* different
rejections:

| Class | Cause | Observed |
| --- | --- | --- |
| C1 | the 200-character cut | A real DEV-gate rejection's fixed header exceeds the cut, so every rejection for one story shared a key regardless of which gaps were outstanding |
| C2 | the path regex rewrote ANY slash-bearing token | `DEV/REVIEW` and `DEV/TEST` both became `dev#` |
| C3 | the digit regex ran inside identifier tokens | `CHK-001` and `CHK-002` both became `chk-#` |
| C4 | the path regex was greedy from the first slash | `src/core/alpha.ts` and `src/core/beta.ts` both became `src#` |

## 2. What this story ships

**Two behavioural changes against main**, both in `normalizeGateReason` / `gateFailureDigest`:

1. **The POSIX path rule matches an absolute path only at a token start** — preceded by string start,
   whitespace, quote, parenthesis, bracket, colon, equals or comma. A mid-token slash (`DEV/REVIEW`)
   and a repo-relative path (`src/core/alpha.ts`) are no longer rewritten, while `/Users/...` and
   `/private/var/...` still collapse. **This delivers C2 and C4.**
2. **The prefix is signals-conditional** — when `extractGateBlockSignals` returns nothing, the prefix
   widens, so a signal-less reason that diverges late keeps a distinct key.

Everything else is main's, including `extractGateBlockSignals`, the 200-character prefix and the
`basis` construction, all of which arrived from sibling story B-cc54.

## 3. What this story does NOT ship, and why

**C1 is not delivered by this story.** While this branch was in review, B-cc54 landed on main and fixed
the C1 class by folding structurally-extracted gap-id signals into the hash basis. This branch adopted
main's version wholesale. CHK-001's outcome is true on main; this story is not what made it true. The
signals-conditional prefix above is the only part of that item this story contributes.

**C3 is not delivered, and cannot be.** This is the story's main finding, and it is a proof rather than
an estimate.

`evidence.output` is interpolated verbatim into a `story_advance` DONE rejection at
`packages/main/src/core/machine.ts:1190`. A third-party TAP or parameterized-test label such as
`bug-2` is therefore **the same string** as a real artifact ordinal. Any rule that recognises one
recognises the other. Eight successive recognition rules were built and each was broken by cross-host
review on a different shape — a word boundary leaked hyphen-joined compounds; a negative lookbehind
leaked slash-joined names and doubled prefixes; a trailing boundary leaked welded tails; an optional
qualifier leaked `timeout:bug-2`; an unmatched wrapper reduced `(bug-2` to an id; an unconditional
sentence-punctuation strip reduced `bug-2:` to an id; a permissive body accepted `bug-fix-2`; and the
last showed the remainder was undecidable at the text level. Those were eight measurements of one
impossibility, not eight bugs.

Consistent with every exclusion decision taken on this story — `rr-`, `rp-`, `rl-` and `i-` were all
excluded on the same reasoning — the tie breaks toward **collapse**, because for a brake, recognising
too much is the dangerous direction: it mints a fresh key per retry and the brake never fires.

The withdrawal is **machine-checked, not merely described**: `checklist-ordinal` and
`unfixed-bug-ordinal` are must-still-collapse cases asserting the opposite of what CHK-003 asked,
beside `embedded-test-output-third-party-label` built from the reported pair. The operator confirmed
the scope shrinkage; `scope-shrinkage-decision.json` records CHK-003 as removed with this reasoning.

**Consequence for the frozen contract:** CHK-003's `userSees` — "a rejection naming CHK-001 and one
naming CHK-002 digest differently" — is literally FALSE against the shipped code. The field is frozen
from DEV and was not edited. The withdrawal, not the wording, is the record of what happened.

**The follow-up that could achieve C3** is named here and in source: the digest would have to consult
story state to know which ordinals actually exist for this story, instead of guessing from text. That
makes it store-dependent on a hot path and is a different design.

## 4. Honest residuals

- The prefix window: two rejections whose extracted signal sets are identical and whose only
  difference falls past the window still collapse, exactly as on main. Measured bound: a cut of 592
  leaves B-cc54's suite green and 593 breaks it, so 592 is the widest legal value — a measurement, not
  an assertion. The window stays at main's value for byte-compatibility.
- Bare ordinals of every kind now collapse, which is main's behaviour and the fail-safe direction.
- There is no automatic backstop for under-normalization. An earlier revision of this plan claimed the
  burn-alert system bounded that risk; the claim was false and is retracted — burn scanning is
  advisory, writes no gate evidence, never changes exit status, and can be disabled. The counter also
  resets only on a SUCCESSFUL `story_advance`, deliberately.

## 5. Process failures this story exposed

- **The branch sat 98 commits behind main for four review rounds.** B-cc54 landed the C1 fix during
  that window, so four rounds were spent refining an approach main had superseded, and one round
  adopted a policy a landed DONE-gating suite contradicts. Three reviewers and a cross-host run all
  missed it because they read the same stale tree. Countermeasure: merge main before each review round
  and re-verify RED against current main, not the pinned baseline.
- **The differential probe passed three times during live regressions**, each time because its matrix
  had no row for the shape at issue. Countermeasure, now in its header: every defect that slips past it
  is added to it, and the running count is recorded.
- **Evidence notes drifted from the matrix repeatedly**, through hand-written counts, stale case names,
  a command that did not demonstrate its claim, and a partial re-recording that left sibling notes
  contradicting each other. Countermeasure: re-record the whole set every time the matrix changes, cite
  case names and guard tags rather than totals, and let commands carry the numbers.

## 6. Verification

- `packages/main/tests/red/red-s3-digest-collapse.mjs` — asserts the delivered behaviour; passes here
  and fails against a freshly built main on exactly the delivered classes.
- `packages/main/tests/red/red-s3-differential-probe.mjs` — committed and runnable, compares this build
  against a comparison build, SKIPs cleanly when none is supplied, and reports cost as a ratio. It
  carries three bars; the third exists because a two-sided comparison structurally cannot see a
  regression whose effect is making this build AGREE with the comparison.
- `packages/main/src/tasks/convergence-breaker-smoke.ts` — the matrix, with named cases, explicit guard
  tags and printed values, every case driving the real `bumpGateFailureCount` / `maxGateFailureCount` /
  `assessBreaker` path.
- `packages/main/dist/tasks/gate-repeat-block-smoke.js` — B-cc54's suite, byte-unmodified, must pass.
- Each changed rule, reverted alone, must fail a named subset and leave the rest passing.
