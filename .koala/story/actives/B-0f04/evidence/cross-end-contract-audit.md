# B-0f04 Cross-End Authority Contract Audit

Scope: post-merge health verification of the Koala CLI repo after B-ca8f / commit
`37df1e7d`, plus (later checklist items) a cross-end authority/evidence contract
diff across Koala CLI, Cord Team Python authority, and Koala Mac/Swift.

This document is written by Claude Code (koala-implementer) as audit evidence only.
No production code is modified. Codex acts as PM/verifier per `plan.md` guardrails.

## Post-merge validation

CHK-001 goal: record Koala CLI post-merge health **without** assuming a green
result. All commands below were run in the main repository
`/Users/jek/Documents/Work/Orchestrate` (HEAD = post-merge B-ca8f). Raw output is
preserved verbatim in the [Raw command appendix](#raw-command-appendix).

### Result summary

| # | Command | Exit | Verdict | Classification |
|---|---------|------|---------|----------------|
| 1 | `node packages/main/dist/cli.js session_brief` | 0 | PASS | informational; no failure |
| 2 | `node packages/main/dist/cli.js convergence_check` | 0 | NOT CONVERGED (`converged:false`) | **expected in-flight state** (see below) |
| 3 | `node packages/main/dist/tasks/cli-validate.js` | 0 | PASS (2 warnings) | pass with non-blocking advisories |
| 4 | `npm run build` (tsc) | 0 | PASS | — |
| 5 | `npm test` (`test:e2e`) | 0 | PASS (ALL PASS) | — |
| 6 | `git status --short` | 0 | CLEAN (no output) | — |

### Per-command findings

**1. `session_brief` — PASS (informational).**
Exit 0. Dashboard reports lifecycle DONE 216/238 (91%), 0 open bugs. Three active
stories: `B-0f04` (this audit, DEV; authority:worktree, main metadata mirror lagging
at INIT_CHECK), `B-4622` (INIT), `B-da5b` (INIT). One META container
`B-META-framework-audit`. No error condition; this command only reports state.

**2. `convergence_check` — NOT CONVERGED, classified as expected in-flight state.**
Exit 0, but the JSON reports `"converged": false`. The single failing check is:

> `所有 Story 完成` → passed: false → "1 个 Story 未完成: B-0f04"

That failing story is **this audit story itself**, which is correctly mid-flight in
DEV. Every other check passes: 无高优先级差距 (pass), Flow 链路完整 (pass), 代码注释合规
(32 annotations all compliant, pass), Parked backlog (2 advisory: B-4622, B-da5b,
pass), Audit backlog (0 blocking / 4 advisory, pass), 需求覆盖率 100% (pass).

Classification: **expected in-flight state**, not a product failure and not an
environment/setup failure. Concrete evidence: the only `passed:false` row names
`B-0f04`, the story currently being executed; non-convergence here is the normal
signal that an active story has not reached DONE. It will clear once B-0f04 reaches
DONE.

**3. Task annotation validator (`cli-validate.js`) — PASS with 2 advisory warnings.**
Exit 0, final line `PASSED: All task annotations are valid.` Files scanned 248,
tasks 32, **errors 0**, warnings 2. The two warnings are missing `@test`
annotations on:
- `src/handlers/story-query.ts:621` — `story_migrate_storage`
- `src/handlers/story-query.ts:727` — `story_sync_main`

Classification: pass with non-blocking advisory. Errors=0 so the gate passes; the
warnings are pre-existing annotation-hygiene notes (candidate follow-up, not a
post-merge regression). The 216 "files without @task" listing is informational, not
an error.

**4. `npm run build` — PASS.**
Exit 0. `@koala-agent/core@0.3.3 build` → `tsc` completed with no diagnostics. This
build is a prerequisite for step 5 (e2e runs compiled `dist/`).

**5. `npm test` — PASS.**
Exit 0. Runs `test:e2e` → `node packages/main/dist/tasks/cli-e2e.js`. Both suites
green: `story-lifecycle (5 steps)` and `gap-convergence (4 steps)`, final `✓ ALL
PASS`.

**6. `git status --short` — CLEAN.**
Exit 0, no output → main working tree is clean post-merge (no stray uncommitted
changes from the B-ca8f merge).

### Active INIT backlog vs this audit

`session_brief` / `convergence_check` both surface two active INIT-phase backlog
stories. Both are **unrelated** to this cross-end authority contract audit:

| Story | Phase | Subject | Relation to B-0f04 |
|-------|-------|---------|--------------------|
| B-4622 | INIT | Framework audit backlog: `scope_check_save` PLAN-only evidence hygiene gap | Unrelated — internal Koala CLI scope-check evidence hygiene, not a cross-end authority/receipt contract item |
| B-da5b | INIT | Prevent post-DONE activity heartbeat from recreating removed story worktree directories | Unrelated — worktree lifecycle / heartbeat bug, not a cross-end authority/receipt contract item |

These appear as `Parked backlog` advisories in `convergence_check` (2 advisory,
passing). They do not block this story and are not in scope for the cross-end
contract matrix (CHK-002) or follow-up gap list (CHK-003). They are recorded here so
CHK-003 can deduplicate against them rather than re-proposing equivalent work.

### Post-merge verdict

Koala CLI post-merge health is green on the mechanical gates that matter for this
audit: build PASS, e2e PASS, annotation validator PASS (errors=0), working tree
clean. The only `converged:false` signal is the expected in-flight B-0f04 story
itself. No product failure and no environment/setup failure were observed in the
CHK-001 command set.

## Cross-end contract matrix

### Repo role confirmation (path → role, by file evidence, not by name)

| Path | Confirmed role | Evidence |
|------|----------------|----------|
| `/Users/jek/Documents/Work/Orchestrate` | Koala CLI (TypeScript client) | `packages/main/src/core/authority-client.ts` POSTs to `KOALA_AUTHORITY_URL`; node/tsc monorepo |
| `/Users/jek/Documents/Work/Koala/cord-team` | Cord Team Python authority (server) | `README.md:3` "server-side authority layer … owns lifecycle state, role policy, evidence receipts, leases, replay protection, and gate decisions"; `pyproject.toml`, `src/cord_team/` |
| `/Users/jek/Documents/Work/Koala/Koala` | Koala Mac/Swift (local runner client) | `Package.swift` Swift executable `Koala`; `README.md:1` "Koala Mac Native … Local Runner prototype"; `Sources/Koala/Core/Authority/` |

Abbreviations below: **CLI** = Koala CLI TS, **PY** = Cord Team Python authority, **MAC** = Koala Mac/Swift. Line refs are at audit HEAD; treat as anchors, not frozen offsets.

### Matrix (one row per contract surface)

| # | Surface | Status | Summary |
|---|---------|--------|---------|
| 1 | EvidenceEnvelope / evidence schema fields | **partial** | PY (`schemas/command.py:24-105`) and MAC (`Core/Authority/AuthorityModels.swift:67-313`) are full field mirrors; CLI contract (`core/authority-contracts.ts:110-146`) is a strict subset — no claims/coverage/negativeControls/oracleSpecs/testAdequacyReport/provenanceAttestation/factAssuranceScore/verifierAssignment*/verificationPlan*/handshake/device/runner/CI fields. CLI Zod is `.passthrough()` so it *can* carry extras but models/populates none. |
| 2 | Receipt issuance / lookup / server receipt authority | **partial → follow-up-needed** | PY signs an ed25519 `AuthorityReceipt` for every record incl. evidence (`schemas/receipt.py:12-26`, `services/receipt_service.py` `issue_authority_receipt`, `services/authority_records.py:689,709`) and exposes lookup (`api/routes.py:164` `/v1/receipts/{id}`, `:182` `/v1/projects/{id}/receipts`). MAC stores `receiptId`/`receiptKind` from the response (`Core/Runner/LocalRunnerService.swift:575-590`) but does **not** cryptographically verify the receipt signature (only `JobSpec.verifyServerSignature` at `:248` is verified). CLI ignores the receipt entirely (`authority-contracts.ts:481` `receipt: unknown`; `authority-submit.ts` `decideFromSingle` checks only `accepted`). |
| 3 | trustLevel / L2–L4 policy / strict & anti-hallucination presets | **partial** | PY full: `TrustLevel L0–L4` (`schemas/enums.py:86-91`), per-level role gates (`authority_records.py:829-900` — L3⇒CI, L4⇒HUMAN), presets `balanced-basic`/`balanced-heterogeneous`/`strict-ci`/`anti-hallucination` with **anti-hallucination as default** (`config.py:7,50-117`). MAC mirrors `trustLevel:Int`, builds L2 (`AuthorityModels.swift:184`, `LocalRunnerService.swift:666,706`). CLI only carries numeric `trustLevel` defaulting to `2` (`authority-contracts.ts:117,398`) with no preset awareness / no L3–L4 handling; the local truth source explicitly scopes PY presets as *external, not locally-landed* (`docs/requirements/decisions/verification-context-pack.md`). |
| 4 | producerRunId / verifierRunId binding | **partial → missing on CLI submit** | PY enforces run bindings under preset (`config.py` `require_l2_run_bindings`; `authority_records.py:511-520` `_optional_bound_run`; `local_runner/evidence.py:63-71` job/run match checks). MAC binds both from job/run (`LocalRunnerService.swift:714-715`). CLI *declares* the fields (`authority-contracts.ts:123-124`) but its submit path (`authority-submit.ts:68-89` `buildEnvelope`) never populates them → CLI POSTs carry no run binding. |
| 5 | provider / model / vendor heterogeneity | **partial → missing on CLI** | PY anti-hallucination requires distinct providers (`config.py:90,97` `require_distinct_l2_provider`, `required_l2_distinct_provider_count=2`); fields on envelope (`command.py:41-43`). MAC sets `provider` only, `model`/`vendor` left `nil` (`LocalRunnerService.swift:718-720`). CLI declares the three fields (`authority-contracts.ts:125-127`) but `buildEnvelope` omits all three → CLI cannot satisfy provider-heterogeneity gates. |
| 6 | verificationContextPack id / digest / refs / inspected refs | **aligned** (by-construction; not byte-tested cross-run in this audit) | The one surface deliberately engineered for parity. CLI: full VCP contract + canonical digest + required-ref projection (`authority-contracts.ts:78-108,347-349,363-377`). PY: `VerificationContextPack.digest()` / `all_required_refs()` consumed in evidence build (`local_runner/evidence.py:91-102`). MAC carries pack id/digest + `inspectedPackRefs` (`AuthorityModels.swift:201-202,223,269-270`; JobSpec `:662-663`). Digest parity asserted by truth source (`verification-context-pack.md`: `digestVerificationContextPack` ↔ Python `VerificationContextPack.digest()`). |
| 7 | Gate consumption: local evidence vs server receipt (DONE/REVIEW/TEST) | **partial** (intentional divergence, needs decision) | CLI DONE/REVIEW/TEST gates consume **local** evidence only (`handlers/checklist.ts` `verificationEvidence`; `core/verification.ts:49`; `core/command-policy.ts:131-132` gateEvidence). The authority POST only gates the *local write* at write-time in enforce mode (`authority-submit.ts`); no CLI lifecycle gate reads a server receipt. PY is the side that issues gate-decision receipts (`receipt_service.py` `issue_gate_decision_receipt`; `services/gate_service.py`). So CLI gates are not backed by PY receipts. |
| 8 | authority mode / preset enforcement / production enforce controls | **partial → follow-up-needed** | PY: `production_enforce_authority` + `required_authority_mode="enforce"` + handshake (`config.py:120-129`; `authority_records.py:524-582` `_require_authority_handshake` checks `client_name`/`client_version`/`command_catalog_digest`/`evidence_schema_digest`/`authority_mode`), env-driven preset overrides (`config.py:146-327`), discovery via `/v1/authority/policy` publishing `evidenceSchemaDigest` + required fields (`api/routes.py:106-153`). CLI mode is a *client-side* off/shadow/enforce POST posture (`authority-mode.ts:17,96-118`) — a different axis from server enforce; CLI sends none of the handshake fields → against a `production_enforce_authority=true` server every CLI evidence POST is rejected (`authority_enforce_required`/`authority_handshake_required`). MAC declares handshake fields (`AuthorityModels.swift:229-240`) but the runner build path leaves them `nil` too. |
| 9 | client / runner submission responsibilities & gaps | **partial → follow-up-needed** (largest impl gap) | MAC is a full runner: `registerActorKey` + `registerRunner` + `heartbeat` + `claimJob` + ed25519-signed envelope + server-signature verification of the job (`Core/Authority/AuthorityClient.swift:28-85`; `LocalRunnerService.swift:248,632-641`). CLI is a thin POST of a minimal unsigned envelope: no actor-key registration, no runner heartbeat, no signature, no handshake (`authority-submit.ts`, `authority-client.ts:138-158`). Under PY `require_runner_heartbeat_for_l2` + `require_actor_key_binding` (`config.py:128-129`, `authority_records.py:584-633`) CLI L2 submissions fail. |

### Partial / missing / follow-up-needed call-outs (for CHK-003 to action)

- **CLI evidence envelope is a subset (#1, #4, #5):** the CLI submit envelope omits run bindings, provider/model/vendor, structured claims/coverage/negative-controls. Naming overlap with PY/MAC does **not** mean alignment — `buildEnvelope` (`authority-submit.ts:68-89`) literally builds a minimal object. Any "enforce against production PY" use is currently non-functional from the CLI.
- **No client verifies server receipts (#2):** PY is a signing authority, but MAC only records the receipt and CLI discards it. Tamper/replay of receipts is not detected client-side. Candidate follow-up: client-side receipt signature verification + receipt lookup.
- **Server-enforce handshake unmet by CLI (#8):** CLI sends no `client_name`/`client_version`/`command_catalog_digest`/`evidence_schema_digest`/`authority_mode`; the TS `EvidenceEnvelopeContract` does not even model them. A production cord-team rejects CLI evidence outright.
- **Trust/preset asymmetry (#3):** anti-hallucination is the PY default but is treated as an external constraint in the Orchestrate truth source; CLI has no preset/L3-L4 model. This is an accepted documented gap, not a silent drift — but it means CLI-issued evidence is structurally below anti-hallucination requirements.
- **Gate authority boundary undecided (#7):** CLI lifecycle gates rely on local evidence; whether DONE/REVIEW/TEST should require a signed PY gate/evidence receipt is an open product decision.
- **Aligned surface (#6):** verificationContextPack id/digest/refs is the only end-to-end-consistent surface, and even there parity is by-construction + doc-asserted; this audit did not run a live cross-repo digest equality test (candidate verification for Codex / a follow-up).

## Gaps and follow-up stories

> TODO (CHK-003): actionable gap report + PM recommendation list. Separate
> already-solved / blockers / non-blocking advisories / follow-up recommendations.
> Each follow-up names its owning repo (Koala CLI, Cord Team Python authority, or
> Koala Mac/Swift). Deduplicate against known active backlog (B-4622, B-da5b — see
> Post-merge validation above). Codex independently verifies high-risk claims in
> `.koala/story/actives/B-0f04/evidence/codex-verification.md`.

## Raw command appendix

All commands run in `/Users/jek/Documents/Work/Orchestrate` (main repo, post-merge
HEAD). Output reproduced verbatim; long informational listings trimmed where noted.

### 1. `node packages/main/dist/cli.js session_brief` (exit 0)

```
# koala session brief

**Dashboard**: Lifecycle DONE: 216/238 (91%) · outcomes: DONE-success/default=216 DONE-blocked=0 DONE-audit-only=0 · 0 open bugs across all stories

## Active stories (3)
  B-0f04 DEV (authority:worktree, mirror:INIT_CHECK) Post-merge validation and cross-end authority contract audit bg:✓
    → cd /Users/jek/Documents/Work/Orchestrate/.worktrees/B-0f04
  B-4622 INIT (authority:main)                Framework audit backlog: scope_check_save PLAN-only evidence hygiene gap bg:✓
  B-da5b INIT (authority:main)                Prevent post-DONE activity heartbeat from recreating removed story worktree directories bg:✓

## META containers (1)
  B-META-framework-audit — audit/finding flow 容器，不走 story lifecycle
  → 用 `koala audit` / `koala finding_list` 处理，不要 story_advance 或建 worktree

## Recent commits
  51b44d64 koala: INIT_CHECK metadata B-0f04
  c2a90953 koala: create B-0f04 audit story
  37df1e7d merge: B-ca8f Restore annotation compliance for semantic scope guard files

## Recent activity (last 3)
  2026-05-25T12:33:56.793Z convergence_check [cli/main/ok]
  2026-05-25T12:25:43.601Z story_advance [cli/main/ok] (B-0f04)
  2026-05-25T12:25:12.658Z init_check_set [cli/main/ok] (B-0f04)

## → Next step
  Resume: cd /Users/jek/Documents/Work/Orchestrate/.worktrees/B-0f04 (story B-0f04; authority: worktree phase DEV is authoritative; main metadata mirror is lagging at INIT_CHECK)
```

### 2. `node packages/main/dist/cli.js convergence_check` (exit 0)

```json
{
  "converged": false,
  "checks": [
    { "name": "无高优先级差距", "passed": true, "detail": "所有需求已覆盖" },
    { "name": "Flow 链路完整", "passed": true, "detail": "0 条链路全部通过" },
    { "name": "代码注释合规", "passed": true, "detail": "32 个注释全部合规" },
    { "name": "所有 Story 完成", "passed": false, "detail": "1 个 Story 未完成: B-0f04" },
    { "name": "Parked backlog", "passed": true, "detail": "2 个 parked backlog advisory: B-4622, B-da5b" },
    { "name": "Audit backlog", "passed": true, "detail": "0 blocking; 4 advisory; B-META-framework-audit:F-001 [low/suspected], B-META-framework-audit:F-002 [medium/suspected], B-META-framework-audit:F-003 [medium/suspected], B-META-framework-audit:F-006 [low/verified]" },
    { "name": "需求覆盖率", "passed": true, "detail": "100%" }
  ]
}
```

### 3. `node packages/main/dist/tasks/cli-validate.js` (exit 0)

```
  WARN   src/handlers/story-query.ts:621  function story_migrate_storage missing @test annotation
  WARN   src/handlers/story-query.ts:727  function story_sync_main missing @test annotation

── Task Annotation Report ──
  Files scanned:    248
  Tasks found:      32
  Errors:           0
  Warnings:         2
  Files without @task (216):
    ... (216-entry informational listing trimmed; full output captured in run log) ...

PASSED: All task annotations are valid.
```

### 4. `npm run build` (exit 0)

```
> koala@0.3.3 build
> cd packages/main && npm run build

> @koala-agent/core@0.3.3 build
> tsc
```

### 5. `npm test` (exit 0)

```
> koala@0.3.3 test
> npm run test:e2e

> koala@0.3.3 test:e2e
> node packages/main/dist/tasks/cli-e2e.js

↻ 已写入并确认持久化：CHK-001 当前 status=done。长会话请重新加载（koala checklist_get / session_brief）后再依赖快照。
↻ 已写入并确认持久化：CHK-001 当前 status=done。长会话请重新加载（koala checklist_get / session_brief）后再依赖快照。

✓ story-lifecycle (5 steps)
  ✓ story_create (step 1)
  ✓ story_advance (step 2)
  ✓ checklist_update (step 3)
  ✓ task_coverage (step 4)
  ✓ test_auto (step 5)

✓ gap-convergence (4 steps)
  ✓ truth_scan (step 1)
  ✓ truth_analyze (step 2)
  ✓ gap_analyze (step 3)
  ✓ convergence_check (step 4)

✓ ALL PASS
```

### 6. `git status --short` (exit 0)

```
(no output — clean working tree)
```
