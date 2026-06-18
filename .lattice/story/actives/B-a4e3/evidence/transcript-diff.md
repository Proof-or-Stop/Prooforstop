# B-a4e3 TEST transcript-diff — OSS final koala cleanup + deprecated GC (PRESERVE salts)

Real-machine verification from the user's perspective. PLAN outcome (expected) vs actual machine output, with the critical salt-integrity proof.

## Expected (from understanding.outcome)
An operator sees: (1) `grep LEGACY_KOALA_DIR` nothing; (2) `test:koala-residue` PASS 0 unclassified; (3) zero modified salt lines (25 salt literals byte-identical to baseline); (4) `grep koala-agent/koala` package.json nothing; (5) consumers read only `.lattice/`; (6) CLAUDE.md runtime paths say `.lattice/`; (7) `lattice dispatch` sole dispatch entry, dead aliases gone; (8) `npm test` full battery green; (9) tsc exits 0.

## Actual (run on HEAD of story/B-a4e3)

### PROOF 1 — zero salt literals modified (THE critical check)
```
$ git diff main HEAD -- packages/main/src scripts | grep -iE 'koala-[a-z]*-integrity-v|koala-review-|koala-scope-check|koala-delivery-check|koala-draft-check|koala-finding-|koala-init-check|koala-capability|koala-discard|koala-mixed'
(empty — zero salt literals appear as +/- lines in the source/scripts diff)
```

### PROOF 2 — salt snapshot byte-identical to baseline
```
$ diff /tmp/salt-baseline-B-a4e3.txt <(current 25-salt-line snapshot)
IDENTICAL (all 25 koala-* salt literals across 17 files unchanged)
```
Baseline captured at story start (before any edit). The 25 frozen salts: koala-init-check-integrity-v1, koala-delivery-check-integrity-v1, koala-draft-check-integrity-v1, koala-finding-integrity-v1, koala-review-integrity-v1 (×4 sites), koala-review-pass-integrity-v1, koala-review-run-integrity-v1, koala-review-run-workspace-binding-v1, koala-review-scope-binding-v1, koala-scope-check-integrity-v1, koala-capability-list-cli/-registry, koala-discard-registry-repair, koala-mixed-global-link, plus the verify-*.mjs script copies. All verbatim.

### PROOF 3 — LEGACY_KOALA_DIR fully removed (CHK-001)
```
$ grep -rn 'LEGACY_KOALA_DIR' packages/main/src
(empty — removed from lattice-paths.ts + 10 consumers: cli-engine, activity-log, audit-config, dev-memory, evidence-freshness, planner, rollout-check, store, doctor, story-query)
```
The `.koala` WRITE-guard survives via a renamed private sentinel `FORBIDDEN_WRITE_DIR='.koala'` (non-salt) so `assertNoLegacyKoalaWritePath` still rejects `.koala` writes; only the READ fallback was dropped. dev-memory-legacy-read-smoke.ts flipped to a negative assertion (seeds a `.koala` entry, asserts it is NOT read).

### PROOF 4 — koala-residue gate green (CHK-002)
```
$ npm run test:koala-residue
PASS koala-residue: 0 unclassified
```
Allowlist tightened (2 dead exemptions `/work/koala/` + `.git/koala` removed, grep-proven zero occurrences); salt exemption `/koala-[a-z-]+-integrity-v\d+/g` (line 81) kept; scan/classify logic untouched (data-array-only edit). Stale `.koala`-readable doc claims fixed (cli-engine:2333 help, audit-config + stale-detector JSDoc).

### PROOF 5 — package.json koala URLs removed (CHK-003)
```
$ grep -n 'koala-agent/koala' package.json packages/main/package.json
(empty — 4 URLs removed: root repository.url/bugs.url/homepage + packages/main repository.url)
```
test:koala-residue script (package.json:19) preserved; both files valid JSON; build passes.

### PROOF 6 — CLAUDE.md runtime paths reconciled to .lattice/ (CHK-004)
```
$ grep -c '\.koala/' CLAUDE.md
0
```
5 runtime-path refs updated (.koala/audit-config.json, .koala/activity.jsonl, .koala/locks/main-write.lock → .lattice/). The 7 `.koala-serve.json` mentions intentionally LEFT (still the live serve-discovery filename in code: dev-host.ts:46, serve.ts:795). Salt mention (koala-init-check-integrity-v1 signing formula) untouched.

### PROOF 7 — dispatch aliases removed; lattice dispatch sole entry (CHK-005)
```
$ grep -rn "name: 'story_dispatch'|name: 'finding_dispatch'" packages/main/src/cli-engine.ts
(empty — removed from cli-engine registry, command-policy, story-dispatch handler methods, process-fact-levels, config DEFAULT_PHASE_TOOLS)
```
Both confirmed deprecated by docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md (B-9d95 CHK-004); command-policy story_dispatch status:'supported' was a stale mislabel deleted with the alias (OQ-1). The dispatch() clusterId branch still works (uses cluster.ts finding_dispatch, a different intentional function).

### PROOF 8 — @deprecated count (P8 GC finding)
```
$ grep -rn '@deprecated' packages/main/src | wc -l
22   (baseline 22, unchanged)
```
FINDING: the @deprecated count does NOT drop. Investigation proved there were NO dead @deprecated FIELDS — all 22 are legacy-JSON-compat KEEP fields (types.ts: phase, testIntent, TestIntent, traceDiff, git; guard-session.ts: GUARD_PRELAUNCH_PROVIDERS, providerSupportsPreToolBlocking — each has a live old-JSON reader or is exported+tested). The two dispatch-alias deprecation markers were markdown prose (`**deprecated in B-9d95**`), NOT `@deprecated` JSDoc tags, so removing the dead CLI aliases (the only genuinely-dead P8 artifacts) does not lower the tag count. The deliverable (dead aliases removed) is complete; the "count drops" sub-expectation rested on a false premise. B-8451 advisory mechanism (deprecated-gc-smoke threshold) preserved.

### PROOF 9 — tsc + full battery
```
$ npm --prefix packages/main run build   → tsc EXIT 0
$ npm test (DEV→TEST gate)               → validate PASS (full root battery incl. test:koala-residue, deprecated-gc-smoke, dev-memory-legacy-read-smoke, flow-stability-smoke, process-fact-contract)
$ lattice validate                       → 验证全绿 (all green)
```

## Diff notes / deviations from PLAN
1. Blast radius was 10 consumers (not the brief's ~6) — handled (CHK-001 covered all 10 via grep).
2. story_dispatch was mislabeled `status:'supported'` in command-policy — resolved as a stale mislabel via OQ-1, removed alongside the alias.
3. @deprecated count stayed 22 (no dead fields existed) — documented above as PROOF 8; an honest factual correction to the PLAN's "count drops" expectation.
4. The CHK-003 checklist context originally contained the Chinese gloss `去掉`, which failed the english-artifacts CLI gate; normalized to English ("the user requested removal") via the proper checklist_update at INIT phase, re-signed by both INIT reviewers, story re-driven forward. Pure CJK→English normalization, no requirement change. Note: this exposed a framework worktree-authority/INIT_CHECK-bootstrap path bug (DEV→INIT_CHECK from a worktree cwd mis-resolves repoRoot and attempts a nested `.worktrees/B-a4e3/.worktrees/B-a4e3` git worktree add) — worth a follow-up framework story.
5. Pre-existing out-of-scope drift observed (not fixed): docs/requirements/decisions/lattice-parallel-wave.md:164/166 has a stale `.koala/dev-memory` "read-only" reference (file unchanged by this story, pre-existing on main).

## Self-check (5 questions)
- Real machine test exists? YES — full npm battery + targeted greps + the flipped dev-memory smoke.
- Edge cases covered? YES — salt-rename guard (the #1 risk), .koala write-guard survival, dispatch clusterId branch, legacy-JSON-compat field retention.
- Unresolved TODOs? NO — all 5 CHK done, all 3 review findings (F-001/F-002/F-003) resolved.
- User-facing outcome delivered? YES — clean OSS repo: no .koala read fallback, no koala URLs, accurate CLAUDE.md, dead aliases gone, salts intact.
- Honest? YES — the @deprecated-count and the framework-bug deviations are reported, not hidden.
