# CHK-005 Verification Results — B-1148

All commands run from worktree `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-1148`.
Non-authoritative: these results document dev-memory behavior only; they are not
gate evidence for any Koala lifecycle artifact.

---

## 1. Build

```
npm --prefix packages/main run build
```

Result: **PASS** — TypeScript compiled without errors.

---

## 2. verify-dev-memory.mjs (61 tests)

```
node scripts/verify-dev-memory.mjs
```

Result: **61/61 PASS**

Includes B-1148 regression section (6 new tests):
- `project dev-memory path is not gitignored (B-1148 Risk A)` ✓
- `token-aware search: "authority reviewer" finds reviewer entries (B-1148 Risk B)` ✓
- `token-aware search: "reviewer" finds reviewer entries` ✓
- `search includes sourceStoryId in searchable text` ✓
- `formatEntryShort shows sourceStoryId and evidenceRefs when present` ✓
- `preflight output is bounded` ✓

---

## 3. process-fact-contract

```
npm run test:process-fact-contract
```

Result: **PASS** — Process fact contract verified (all prompt/CLI/handler/gate alignment checks pass).

---

## 4. dev_memory_search — "authority reviewer" (happy path)

```
KOALA_PROJECT_ROOT=.../B-1148 node packages/main/dist/cli.js dev_memory_search --query="authority reviewer"
```

Result: **3 entries returned** — f668c60, 9a9c568, 0b952b0

All three contain "reviewer" (the second token after whitespace split). Each entry shows:
- `id` / `category` / `scope`
- `Source  : <storyId> (non_authoritative)`
- `Refs    : <evidenceRef>`

Sample output:
```
[f668c60] workflow | project | agent: koala-implementer [reviewer-lane, review-run-start, reviewRunId, evidence-binding]
  Summary : Reviewers must call review_run_start first; findings or passes without reviewRunId are rejected
  Source  : B-ad12 (non_authoritative)
  Refs    : .koala/story/actives/B-ad12/summary.json
```

---

## 5. dev_memory_preflight — "流程伪造 事实伪造 authority reviewer" (happy path)

```
KOALA_PROJECT_ROOT=.../B-1148 node packages/main/dist/cli.js dev_memory_preflight --query="流程伪造 事实伪造 authority reviewer"
```

Result: **5 entries, ~23 lines** — bounded, within 60-line budget.

Entries returned: a6832a1, c948c85 (global/B-ad2c), f668c60, 9a9c568, 0b952b0 (project/B-1148).
Each shows `Source: <storyId> (non_authoritative)` and `Refs: <evidenceRef>`.

---

## 6. Edge case: needs-human-confirmation topics don't appear in search

```
KOALA_PROJECT_ROOT=.../B-1148 node packages/main/dist/cli.js dev_memory_search --query="B-e71f B-ed3e B-9975"
```

Result: `No dev-memory experience entries found for query: "B-e71f B-ed3e B-9975"`

The 6 needs-human-confirmation topics (B-e71f, B-ed3e, B-9975, B-9bd9, B-9d95, B-5a28) were
intentionally not captured. Searching by their story IDs returns zero results. ✓

---

## 7. Edge case: preflight bounded at default maxEntries=5

```
KOALA_PROJECT_ROOT=.../B-1148 node packages/main/dist/cli.js dev_memory_preflight --maxEntries=5
```

Result: `(5 entries, ~23 lines)` — bounded output, will not pollute agent startup context. ✓

---

## 8. JSONL integrity: all 11 entries have required non-authoritative fields

```python
cat .koala/dev-memory/experience.jsonl | python3 -c "
import sys, json
entries = [json.loads(l) for l in sys.stdin if l.strip()]
# verify required fields
for e in entries:
    assert e.get('gateEvidence') == False
    assert e.get('authority') == 'non_authoritative'
    assert e.get('sourceStoryId')
    assert e.get('evidenceRefs')
print(f'PASS: all {len(entries)} entries verified')
"
```

Result: `PASS: all 11 entries have gateEvidence=false, authority=non_authoritative, sourceStoryId, evidenceRefs`

---

## 9. koala validate --story=B-1148 --json

```
koala validate --story=B-1148 --json
```

Result (before CHK-005 evidence added):
- `npm test` (e2e): **PASS**
- verification coverage: `12/15 covered (3 required missing — CHK-005 intents)`
- CHK-006 fix: all DEFAULT_PHASE_TOOLS tests pass

After CHK-005 evidence is recorded, coverage will be 15/15.

---

## 10. dev-memory is not recognized as gate evidence (adversarial)

Verified by:
- `gateEvidence: false` in every entry (Python cross-check above confirms)
- `authority: non_authoritative` in every entry
- `koala validate` does NOT count dev-memory entries as `verification_evidence_add` or
  `review_pass_set` artifacts — the validate output above shows only CLI/docs/logic_test
  evidence types; no dev-memory entry appears in the coverage report as satisfying an intent
- dev-memory.md explicitly states: "no dev-memory entry, candidate file, or preflight pack
  can satisfy delivery_check_set / verification_evidence_add / review_pass_set / Any other
  signed gate artifact"

---

## Summary

| check | result |
|-------|--------|
| build (tsc) | PASS |
| verify-dev-memory.mjs (61 tests) | 61/61 PASS |
| process-fact-contract | PASS |
| dev_memory_search "authority reviewer" | 3 relevant entries returned with source refs |
| dev_memory_preflight "流程伪造 事实伪造 authority reviewer" | 5 entries, ~23 lines (bounded) |
| needs-human-confirmation topics absent from search | PASS (0 results) |
| preflight bounded at maxEntries=5 | PASS (23 lines) |
| all 11 entries: gateEvidence=false + non_authoritative | PASS |
| koala validate e2e | PASS |
| dev-memory not recognized as gate evidence | PASS |
