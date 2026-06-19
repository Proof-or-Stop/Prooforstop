# B-b1f4 — User-value acceptance (real-machine transcript + diff)

Story: Surface cache-less-provider (codex/gemini) tokens in usage-ledger aggregates via an additive primaryReportedTotal.
Tracked follow-up for finding B-12d7:F-004.

## How this was run (real machine, user's perspective)

A ledger with one codex (openai adapter), one gemini, and one claude (anthropic)
provider-reported record was written to `/tmp/accept-ledger.jsonl`. The codex and
gemini records carry `cacheCreation=null` (BY DESIGN — these providers never report
a cache-write count); the claude record has all four dimensions. The operator-facing
reporter task was then run against it from this worktree:

```
node packages/main/dist/tasks/usage-ledger-report.js /tmp/accept-ledger.jsonl
```

## Expected (from PLAN understanding_set.outcome)

- The codex and gemini provider-reported records — previously invisible (all-zero
  `known` tokens, dropped into the unknown bucket) — surface their input+output in a
  new `primary[in=.. out=..]` column.
- The strict four-field `tokens[...]` for those records stays 0 (cacheCreation was
  never reported, so it is NOT invented).
- A claude record (all four dims known) appears in BOTH the primary column and the
  strict four-field `tokens[...]`.
- summary-equivalent: provider-reported `primaryKnownCount = 3` (all three finals),
  while strict four-field `knownCount = 1` (claude only) and `unknownCount = 2`
  (codex + gemini).

## Actual (verbatim)

```
LLM Usage Ledger Report (read-only diagnostics)
  records parsed:   3
  records selected: 3
  pricing:          (none injected — costs omitted)

Overall by source:
  provider-reported    count=3 known=1 unknown=2 primary[in=2300 out=820] tokens[in=1000 out=500 cacheCreate=10 cacheRead=20]
  prompt-size-estimate count=0 known=0 unknown=0 primary[in=0 out=0] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]
  unavailable          count=0 known=0 unknown=0 primary[in=0 out=0] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]
  unknown records (all sources): 2

Groups (3):
  - story=B-demo phase=dispatch role=lattice-dispatch:claude-code model=claude-opus-4-8 provider=anthropic records=1 unknown=0
      provider-reported    known=1 unknown=0 primary[in=1000 out=500] tokens[in=1000 out=500 cacheCreate=10 cacheRead=20]
  - story=B-demo phase=dispatch role=lattice-dispatch:codex model=gpt-5-codex provider=openai records=1 unknown=1
      provider-reported    known=0 unknown=1 primary[in=500 out=200] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]
  - story=B-demo phase=dispatch role=lattice-dispatch:gemini model=gemini-2.5-pro provider=gemini records=1 unknown=1
      provider-reported    known=0 unknown=1 primary[in=800 out=120] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]

# --json overall provider-reported:
#   primaryKnown={input:2300, output:820} primaryKnownCount=3
#   four-field known={input:1000, output:500, cacheCreation:10, cacheRead:20} knownCount=1 unknownCount=2
```

## Diff (expected vs actual)

No meaningful diff. Every expected property holds:

- codex group: `primary[in=500 out=200]` visible; `tokens[in=0 out=0 cacheCreate=0 cacheRead=0]` (four-field unchanged, cacheCreation NOT invented). ✓
- gemini group: `primary[in=800 out=120]` visible; `tokens[in=0 ...]`. ✓
- claude group: `primary[in=1000 out=500]` AND `tokens[in=1000 out=500 cacheCreate=10 cacheRead=20]` (BOTH). ✓
- overall provider-reported: `primaryKnownCount=3` vs four-field `knownCount=1`, `unknownCount=2`. ✓
- codex+gemini primary alone = (500+200)+(800+120) = 1620, matching the PLAN figure; claude adds 1500 → overall 3120. ✓

## User-value self-check

1. Who is the user? An operator inspecting LLM spend via the usage-ledger reporter.
2. What did they want? To SEE codex/gemini token spend that was being silently dropped.
3. Do they see it now? Yes — the `primary[in=.. out=..]` column shows codex (700) and gemini (920) input+output that the strict `tokens[...]` column still reports as 0.
4. Is the audit guarantee preserved? Yes — cacheCreation is never invented; the strict four-field `providerReportedTotal`/`known`/cost still exclude cache-less providers; the two aggregates are independent.
5. Is "done" recognizable? Yes — the operator reads codex/gemini input+output in the primary column and confirms the strict four-field total is unchanged.
```
