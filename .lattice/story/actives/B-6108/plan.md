# B-6108 Plan — claimsShrinkage vocabulary recall expansion

## Problem

B-2c03 (DONE 0.3.185) fixed the false-POSITIVE direction of the
`claimsShrinkage` heuristic and, across nine codex host-B rounds plus claude
lanes, verified five false-NEGATIVE recall classes that its user-confirmed
scope boundary excluded (vocabulary beyond the `remaining` decision). All were
live-verified as non-firing, and re-verified by this story's INIT reviewer:

1. Adverb insertion: "The Windows install path is **not yet covered** by this
   delivery."
2. Inflections: "only **partially** delivered", "This delivery **excludes**
   the admin workflow".
3. Shrinkage verbs where the trigger word sits inside a stripped-by-requirement
   token: "The deferred-query.sql export **was skipped** for this delivery.",
   "The `deferred` work was **left to a follow-up** story.",
   "**was removed from this delivery**".
4. Quoted scope nouns: 'The remaining "cases" were left for a follow-up
   story.' (quote characters sit between the chain connector and the noun).
5. Comma+plus lists: "web, mobile, **plus** Safari cases" (the Oxford branch
   only knows and/or; two-item "X plus Y" already fires via the bare
   conjunction).

## Design (per class)

1. **Adverb windows** (CHK-001): bounded token steps, never raw proximity
   (F-012 lesson): `not(?:[connector][token]){0,2}?[connector]covered` and
   `out[connector]of(?:[connector][token]){0,2}?[connector]scope`, reusing the
   B-2c03 arbitrary-token modifier shape with the same non-sentence-punctuation
   token end.
2. **Inflections** (CHK-001): `partial(?:ly)?`, `exclud(?:ed|es|e|ing)`,
   `defer(?:red|s|ring)`. Longer unrelated words stay unmatched because the
   alternations have no shorter fallback inside a word (verified in smoke).
3. **Shrinkage verbs** (CHK-002), curated and constrained:
   - passive scope-cut verbs: `(?:was|were) (?:skipped|omitted|descoped|punted)`
     (active voice — "We skipped the redundant rebuild" — must NOT fire);
   - bare `descoped` (inherently scope-cutting, no routine reading);
   - follow-up handoffs: `(?:left|moved|pushed|punted|handed(?: off)?)
     (?:to|for|into) (?:a )?follow-up` with flexible connectors;
   - delivery-qualifier-bound: `(?:removed|dropped|cut) from (?:this|the)
     (?:delivery|story|scope|release|milestone|version)` — bare
     removed/dropped/cut must NOT fire (routine change descriptions).
4. **Quote tolerance** (CHK-003): the remaining-chain noun position accepts
   optional straight/curly double/single quote characters between the final
   connector and the scope noun (both the main branch and the Oxford tail).
5. **Oxford plus** (CHK-003): `(?:and|or)` → `(?:and|or|plus)` in the Oxford
   tail only; a lone ", plus" without a preceding comma list item remains
   clause coordination and stays quiet (pinned by a control).

## Execution order

1. CHK-001/002/003 RED cases added to the smoke BEFORE any regex change; RED
   observed and bound in red-evidence.json (repro-first).
2. Implement the vocabulary additions in one pass; GREEN the smoke.
3. CHK-004 interaction audit: probe additions against sanitizer strip classes
   and chain taxonomy; full suite (intent-hardening smoke,
   milestone-done-gate-reconciliation smoke, milestone-status tests, e2e).
4. Commit, REVIEW (three lanes + codex host-B under FROZEN-TREE discipline:
   no edits or commits while a review wave is in flight), TEST, DONE.

## Convergence statement (inherited and extended from B-2c03)

The vocabulary is a documented lexical heuristic, not a parser. Blocking floor
for this story: a finding is blocking only if it is (a) a VERIFIED
false-negative on one of the five in-scope classes' natural phrasings, (b) a
VERIFIED false-positive on routine change descriptions introduced by THIS
story's additions, or (c) a regression of any B-2c03 pinned case. Marginal
recall on classes outside the five (new verbs, new typography beyond quotes,
novel constructions) belongs to a future follow-up, not to further rounds of
this one.

## Risk notes

- The verb set is the precision-sensitive surface: every verb is bound by
  passive voice, a follow-up object, or a delivery qualifier, and the bare
  forms are pinned must-not-fire. Adding a bare verb to the set in future
  requires its own must-not-fire sweep.
- Quote tolerance only touches the noun position; quotes inside modifier
  tokens were already tolerated by the arbitrary-token shape.
- All B-2c03 residual directions (fail-safe false positives, fenced-block and
  stripped-file-name false negatives by requirement/convention) are unchanged.
