# Plan: B-a4e3 OSS final cleanup — remove legacy .koala read fallback + non-salt koala identifiers + package.json koala URLs + GC dead @deprecated — PRESERVE signature salts

## ⛔ GLOBAL HARD CONSTRAINT (applies to EVERY item)
The `koala` substring inside signature SALTS is a FROZEN cryptographic constant, NOT branding. NEVER rename/modify any of:
`koala-init-check-integrity-v1`, `koala-delivery-check-integrity-v1`, `koala-draft-check-integrity-v1`, `koala-finding-integrity-v1`, `koala-review-integrity-v1`, `koala-review-pass-integrity-v1`, `koala-review-run-integrity-v1`, `koala-review-run-workspace-binding-v1`, `koala-review-scope-binding-v1`, `koala-scope-check-integrity-v1`, `koala-capability-list-cli`, `koala-capability-list-registry`, `koala-discard-registry-repair`, `koala-mixed-global-link`, and ANY `koala-*-integrity-v\d+` / salt literal.
Baseline (25 salt lines / 17 files) snapshotted at `/tmp/salt-baseline-B-a4e3.txt`. After every change: `git diff main HEAD | grep -iE 'koala-.*-integrity|koala-.*salt|koala-capability-list|koala-discard-registry|koala-mixed-global'` must show ZERO modified salt lines. Salt-bearing files are deliberately NOT in execution_boundary allowedPaths.

Verification cadence after EVERY item: `npm --prefix packages/main run build` (tsc) + `npm run test:koala-residue` (must print `PASS koala-residue: 0 unclassified`) + the salt-grep above.

---

## CHK-001: Remove the legacy .koala read fallback (LEGACY_KOALA_DIR + the consumer sites) + flip the legacy-read smoke

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lattice-paths.ts (remove LEGACY_KOALA_DIR + LEGACY_KOALA_* path constants; keep LATTICE_* canonical + LATTICE_LEGACY_KOALA_ACTIVITY_LOG only if it is a .lattice path still used)
- Modify: packages/main/src/cli-engine.ts, core/activity-log.ts, core/audit-config.ts, core/dev-memory.ts, core/evidence-freshness.ts, core/planner.ts, core/rollout-check.ts, core/store.ts, handlers/doctor.ts, handlers/story-query.ts (remove the .koala read-fallback branches; for each confirm the .lattice canonical path is the live write target before deleting)
- Modify (flip, do NOT gut): packages/main/src/tasks/dev-memory-legacy-read-smoke.ts (change from "asserts ~/.koala read with .lattice winning duplicates" to "asserts .koala is NO LONGER read")

**Verify**:
- `grep -rn 'LEGACY_KOALA_DIR\|LEGACY_KOALA_' packages/main/src` returns NOTHING (except possibly a .lattice-prefixed constant name that does not reference the .koala dir — confirm it points at .lattice)
- `npm --prefix packages/main run build` exits 0
- `node --import tsx packages/main/src/tasks/dev-memory-legacy-read-smoke.ts` (or via `lattice validate`) passes with the flipped assertion
- `npm run test:koala-residue` → `PASS koala-residue: 0 unclassified`
- salt-grep clean

**DoneWhen**:
- No code path reads `.koala/` for story metadata, dev-memory, audit-config, activity log, autopilot-runs, planner runs, evidence freshness
- The legacy-read smoke proves `.koala` is no longer read (assertion flipped, not deleted)
- Every former .koala consumer has a working `.lattice` path
- tsc + test:koala-residue green; zero salt lines modified

---

## CHK-002: Rename remaining NON-SALT koala identifiers to lattice + shrink the residue-gate allowlist (PRESERVE salts)

**Owner**: lattice-implementer
**DependsOn**: CHK-001 (the fallback path literals must be gone before their allowlist exemptions can be dropped without making the gate red)
**Files**:
- Modify: any active-code file with a NON-salt koala identifier tied to the removed fallback (internal variable / comment branding) → rename to lattice. Use `npm run test:koala-residue` output + `grep` to locate; do NOT touch salt literals or historical/decision-doc/test-intent text.
- Modify: scripts/verify-koala-residue.mjs — remove ONLY the allowlist exemptions whose target `.koala`-fallback path literals no longer exist after CHK-001 (e.g. dead path-literal exemptions in the lines-93-108 block, line 102 `.koala` runtime-path exemption if `.koala` truly no longer appears). KEEP: line 81 salt exemption `/koala-[a-z-]+-integrity-v\d+/g`, KOALA_* env-var fallback (line 77), gate self-identifiers, LEGACY_LOGIC_FILES, and all historical/dual-accept exemptions. Change ONLY allowlist DATA arrays — NEVER the scan/classify enforcement functions.

**Verify**:
- `npm run test:koala-residue` → `PASS koala-residue: 0 unclassified` (green with a tightened allowlist)
- `git diff scripts/verify-koala-residue.mjs` shows edits ONLY inside exemption/allowlist arrays (line 81 salt regex present, scan logic untouched)
- salt-grep clean; tsc exits 0

**DoneWhen**:
- Active code carries no non-salt koala branding tied to the removed fallback
- The salt exemption (line 81) and historical exemptions remain; only dead-path exemptions dropped
- Gate green; zero salt lines modified

---

## CHK-003: Remove the 4 koala URLs in package.json + packages/main/package.json

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: package.json — delete repository.url (~:81), bugs.url (~:88), homepage (~:90) koala-agent/koala URLs. If a field becomes empty object, remove the whole field. KEEP `test:koala-residue` script (line 19) and all other scripts.
- Modify: packages/main/package.json — delete repository.url (~:8) koala-agent/koala URL.

**Verify**:
- `grep -n 'koala-agent/koala' package.json packages/main/package.json` returns NOTHING
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('packages/main/package.json','utf8')); console.log('valid')"` prints `valid`
- `grep -n 'test:koala-residue' package.json` still present
- `npm --prefix packages/main run build` exits 0
- `npm run test:koala-residue` green; salt-grep clean

**DoneWhen**:
- Neither package.json contains a github.com/koala-agent/koala URL
- Both files are valid JSON; builds pass; test:koala-residue script retained
- zero salt lines modified

---

## CHK-004: Update CLAUDE.md .koala/ runtime-path references to .lattice/

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: CLAUDE.md — update ONLY the live `.koala/<dir>` runtime-path references to match the code (which writes `.lattice/`):
  - line 37: `.koala/audit-config.json` → `.lattice/audit-config.json`
  - line 71: `.koala/activity.jsonl` → `.lattice/activity.jsonl`
  - line 95: `<projectRoot>/.koala/audit-config.json` → `<projectRoot>/.lattice/audit-config.json`
  - line 99: `<projectRoot>/.koala/audit-config.json` → `<projectRoot>/.lattice/audit-config.json`
  - line 410: `.koala/locks/main-write.lock/` → `.lattice/locks/main-write.lock/`
- Do NOT change the 7 `.koala-serve.json` mentions (lines 204,245,258,262,307,311,315) — that filename is STILL what the code writes (dev-host.ts:46, serve.ts:795); changing the doc would diverge it from code. Do NOT change any salt mention or `see story/B-xxx` historical reference.

**Verify**:
- `grep -n '\.koala/' CLAUDE.md` returns NOTHING (no `.koala/<dir>` paths remain; `.koala-serve.json` is a file not a `/`-suffixed dir path so will not match `\.koala/`)
- `grep -n '\.koala-serve\.json' CLAUDE.md` still present (unchanged)
- `grep -n '\.lattice/audit-config\|\.lattice/activity\|\.lattice/locks/main-write' CLAUDE.md` shows the updated paths
- docs-drift gate green (verified at REVIEW→TEST preflight)
- salt-grep clean

**DoneWhen**:
- CLAUDE.md's `.koala/` runtime-path references say `.lattice/` and match the code
- `.koala-serve.json` and historical/salt mentions untouched
- docs-drift gate green; zero salt lines modified

---

## CHK-005: P8 deprecated GC — remove dead dispatch alias(es) + their JSDoc @deprecated; KEEP legacy-JSON-compat @deprecated fields

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/cli-engine.ts — remove the `finding_dispatch` (~:1909) and `story_dispatch` (~:1901) registry entries (both confirmed deprecated by docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md §B-9d95 CHK-004 merging both into `lattice dispatch`). KEEP the unified `dispatch` entry (~:1916).
- Modify: packages/main/src/handlers/story-dispatch.ts — remove the `finding_dispatch` (447-456) and `story_dispatch` (463-472) alias METHODS + their JSDoc `@deprecated` annotations (443,459). The `dispatch()` clusterId branch (line 557) calls `createClusterHandlers(ctx).finding_dispatch` — a DIFFERENT cluster.ts function — so it keeps working; do NOT remove that.
- Modify: packages/main/src/core/command-policy.ts — remove the `finding_dispatch` (331) and `story_dispatch` (330) policy entries (story_dispatch's `status:'supported'` is a stale mislabel; both are deprecated and removed together).
- Modify: packages/main/src/tasks/flow-stability-smoke.ts — update the two `finding_dispatch` command-policy references (583,635) that assert the alias is allowed, since the alias is being removed (adjust to the surviving `dispatch` entry or remove those specific assertions; keep the rest of the smoke intact).
- DO NOT remove the 7 legacy-JSON-compat @deprecated fields (KEEP with annotation if not already annotated): types.ts ChecklistItem.phase (~229), ChecklistItem.testIntent (~231), TestIntent interface (~255), BugDiagnose.traceDiff (~356), TestResult.git (~694); guard-session.ts GUARD_PRELAUNCH_PROVIDERS (~68), providerSupportsPreToolBlocking (~76). Each has a live old-JSON reader or is exported+tested.
- DO NOT touch the B-8451 advisory mechanism (deprecated-gc-smoke.ts threshold logic, audit-trigger.ts count).

**Verify**:
- `grep -rn "'story_dispatch'\|'finding_dispatch'\|\"story_dispatch\"\|\"finding_dispatch\"" packages/main/src` shows no live registry/policy/handler definitions (only allowed remnants: none expected; doc/comment mentions outside src are fine)
- `lattice dispatch '{"storyId":"B-a4e3","itemId":"CHK-001"}'` still produces a prompt (unified entry intact)
- `npm --prefix packages/main run build` exits 0; `npm test` full battery green (incl. flow-stability-smoke + deprecated-gc-smoke + dev-memory-legacy-read-smoke)
- `grep -rn '@deprecated' packages/main/src | wc -l` is LOWER than baseline 22 (the 2 alias JSDoc annotations removed) — the 7 legacy-compat fields remain
- salt-grep clean

**DoneWhen**:
- `lattice dispatch` is the only dispatch entry; finding_dispatch/story_dispatch removed from registry + command-policy + handler methods
- dispatch() clusterId branch still works via cluster.ts
- All 7 legacy-JSON-compat @deprecated fields retained with rationale; @deprecated count dropped
- B-8451 advisory mechanism intact; full battery + tsc green; zero salt lines modified
