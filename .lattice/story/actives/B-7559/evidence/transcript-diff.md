# B-7559 — User-value acceptance (transcript + diff)

**Deliverable:** `docs/parallel-decomposition-spec.md` — a mandatory contract-first parallel-decomposition spec for Lattice requirement breakdown. The deliverable is the *written document*; "running it" means (a) the document is present and renders, (b) every concrete claim it makes about real Lattice internals is true, and (c) every command/template it tells an implementer to run is valid against the live CLI.

## Rhythm: expected (PLAN) → actual (run) → diff

### 1. Expected (PLAN outcome)
A trustworthy spec an implementer can follow with **zero surprises**: accurate symbol/file/behavior references, copy-pasteable CLI examples, internally consistent sections, a sound worked example, and an honest enforcement model.

### 2. Actual (what running/inspecting produced)
- `lattice validate` → **PASS** (tsc build + authority-client-smoke + authority-completion-smoke; verification policy express-exempt).
- Document audited across **3 review rounds + a confirmation + a final gate** by 4 independent reviewer lanes (docs / quality / concept / test-coverage).
- **27 findings** filed and **all resolved**; final per-lane passes recorded on current material with **0 new findings**.
- Every cited Lattice symbol independently verified present in `packages/main/src`: `canStartDevGuard` & `getGuardFailureReason` (machine.ts), warning at `transition-orchestrator.ts:156`, `pathMatchesPattern` (core/scope-contract.ts, hand-rolled, no minimatch), `resolveParallelSafety` order (parallel-policy.ts), `actualFileOverlapsByStory`/`resolveWaveSafety` (core/lattice-parallel-wave.ts), `AuditMode`/`VALID_MODES: ReadonlySet<AuditMode>`/`resolveAuditConfig` (audit-config.ts), `ScopeContractData` fields (types.ts), `acquireOwnerLease` (story-owner-lease.ts).
- Every CLI example verified against the live Zod schemas: `scope_boundary_set` requires `--userConfirmed=true`; `scope_contract_set` requires `--mode=enforce`; array flags require **JSON-array** syntax (`parseFlags` consumes one value/flag, JSON-parses `[`-prefixed values, drops space-separated extras); `story_create` does **not** accept `lane`/`parallelSafe`/`blockingFor` (derived, not flags).

### 3. Diff (expected vs actual)
The audit surfaced and corrected **27 discrepancies** between the draft's claims and the live code/CLI — examples:
| Expected (draft claimed) | Actual (live code) | Fix |
|---|---|---|
| `pathMatchesPattern` in `handlers/scope-contract.ts` | it is in `core/scope-contract.ts` | path corrected |
| `scope_contract_set "a" "b" "c"` (space-separated) | parser keeps only first; rest dropped | converted to JSON arrays + convention note |
| `story_create … lane:… parallelSafe:… blockingFor:…` | those are derived, not flags (silently discarded) | annotated as derived in §3 + §5.1 |
| `VALID_MODES: Set<AuditMode>` | it is `ReadonlySet<AuditMode>` | corrected |
| `actualFileOverlapsByStory` "cannot run before DEV" | callable in PLAN, just no meaningful results pre-DEV | reworded |

**Post-fix diff: none material.** After 27 fixes the document matches the intended deliverable; an implementer copy-pasting any command or following any code sketch hits zero known surprises.

## Assurance
- Review escalation: **degraded-single-host (3/3 rounds × 1 host)** with explicit fallback `REF-mqkd7zbh` (`single-host-environment`). Genuine 3×2 two-independent-host strong proof was NOT available (single physical operator/machine; live Authority runner not provisioned — `autopilot_doctor authorityStatus=fail`). Local host verdicts were **not** fabricated to claim 2-host independence; the honest degraded assurance is recorded instead.
