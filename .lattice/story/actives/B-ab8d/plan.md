# Plan: B-ab8d Experience-ablation M3: full runtime-pack arm switch with experimentId override and control-arm retrieval blocking

Chosen decision: env-var-context (LATTICE_EXPERIMENT_ID + LATTICE_EXPERIMENT_ARM, both required, validated; null context = production mode, byte-identical to today).

## CHK-001: Experiment arm context resolver (experimentId override) as a new core leaf

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/experiment-arm.ts
- Test: packages/main/tests/experiment-arm.test.ts (or the repo's logic-test location; follow existing tests/ conventions)

**Verify**:
- `npm --prefix packages/main run build` green
- Logic test: both vars valid -> {experimentId, arm}; none -> null; partial -> null + warning listing the ignored var; invalid arm -> null + message naming control|treatment; empty experimentId -> treated as unset

**DoneWhen**:
- `resolveExperimentArm(env?: NodeJS.ProcessEnv): ExperimentArmContext | null` exported, pure (no I/O beyond the env argument, default process.env)
- Warning path uses console.warn exactly once per process (module-level latch) to avoid log spam
- Zod-free plain validation with runtime checks per Handler coding convention (runtime re-validation at consumers)

## CHK-002: Full-pack render gate applied at all seven lifecycle entrypoints via one shared leaf

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/core/experience-pack-surface.ts
- Modify: packages/main/src/handlers/story-create.ts, packages/main/src/handlers/transition-orchestrator.ts, packages/main/src/handlers/session.ts, packages/main/src/handlers/lattice-handoff.ts, packages/main/src/handlers/done-prepare.ts, packages/main/src/handlers/done-closure.ts, packages/main/src/handlers/dev-memory.ts
- Test: covered by CHK-005 smoke + existing smokes must stay green

**Verify**:
- `npm --prefix packages/main run build` green
- Manual transcript: control env -> `lattice session_brief` shows NO "## Memory Runtime Preflight"; activity log tail shows experience_pack_surfaced {arm:"control", consumer:"session_brief", packDigest}; treatment env -> section identical to no-experiment run; no env -> byte-identical output to pre-change (compare against a captured baseline)

**DoneWhen**:
- Shared leaf exposes `surfaceRuntimeMemoryPack(root, {consumer, storyId?, roundKey?}) -> {shouldRender, renderedSection, summaryLines, packDigest, event fired}` style API (exact shape implementer's choice) used by ALL seven sites; done-prepare's summary shape (renderMemoryFreshnessPackSummary over runbook.pack) goes through the same shouldRender decision
- Event experience_pack_surfaced fires on BOTH arms with dedup key (experimentId, consumer, storyId-or-global, roundKey) — one event per key; no experiment context -> NO new event (today's behavior preserved, hints event untouched)
- The arm value never reaches resolveReviewPromptHash, issues/blockers, or gate decisions (grep-verifiable: no import of experiment-arm in gate/hash modules)
- buildMemoryFreshnessPack internals untouched

## CHK-003: Mechanical control-arm retrieval blocking at the CLI choke point with recorded violations

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/cli-engine.ts, packages/main/src/core/command-policy.ts (add memoryRetrieval marker to CommandPolicy), packages/main/src/cli/command-catalog.ts (mark recall, dev_memory_*, playbook_*, learning_scan/learning_validate/learning_effectiveness, memory_playbook_baseline_*, recall variants)
- Test: covered by CHK-005 smoke; existing owner-lease gate tests must stay green

**Verify**:
- `npm --prefix packages/main run build` green
- Manual transcript: control env -> `lattice recall '{"query":"x"}'` exits nonzero with message naming the experimentId; activity log gains retrieval_violation {experimentId, command:"recall"}; treatment/no-env -> works normally

**DoneWhen**:
- Enforcement lives beside enforceStoryOwnerLeaseGate in cli-engine.ts (single choke point), keyed off the memoryRetrieval policy marker — NOT a name-prefix string list in the engine
- Every blocked attempt appends retrieval_violation to the activity log BEFORE throwing, so the M4 scorer can count attempts even on refusal
- dev_memory_capture/dev_memory_finish (write-side) also blocked on control (store writes are forbidden during runs per plan section 12)

## CHK-004: Store-root resolution surface for isolation assertions

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/observability-snapshot.ts
- Test: small logic/integration case (resolution unchanged; field present)

**Verify**:
- `lattice observability_snapshot` in the worktree prints resolvedLearningRoot ending in /.lattice/learning under the MAIN repo root (worktree canonicalization visible)
- Same command with cwd set to a fresh mkdtemp non-git dir prints resolvedLearningRoot under that temp root

**DoneWhen**:
- observability_snapshot output (text + JSON) includes resolvedLearningRoot computed via the existing resolveLearningDir — zero change to resolution logic (learning-store.ts is scope-contract-excluded)

## CHK-005: Arm-switch smoke test covering the M3 exit criteria end to end

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Create: packages/main/src/tasks/experience-pack-arm-switch-smoke.ts
- Modify: .lattice/validate.json (register the smoke in validate.commands)
- Test: the smoke IS the test

**Verify**:
- `node packages/main/dist/tasks/experience-pack-arm-switch-smoke.js` prints per-case PASS lines and final `experience-pack-arm-switch-smoke: ALL PASS`, exit 0
- `lattice validate` includes and passes the smoke

**DoneWhen**:
- Cases: (a) no-experiment byte-identical regression at all seven entrypoints (temp fixture repo, captured baseline); (b) control hides pack + experience_pack_surfaced logged at all seven entrypoints; (c) treatment shows pack + event; (d) partial env context ignored with warning; (e) retrieval blocked + retrieval_violation recorded on control, normal on treatment/no-env; (f) catalog cross-check — every command name matching the memory families carries the memoryRetrieval marker; (g) resolveReviewPromptHash byte-identical across arms; (h) event dedup one-per-key
- Smoke follows experience-layer-ab-shadow-gate-smoke.ts conventions (temp roots, no production store writes)

## Dispatch order

1. CHK-001 and CHK-004 in parallel (disjoint files)
2. CHK-002 and CHK-003 in parallel after CHK-001 (disjoint: core+handlers vs engine+catalog+policy)
3. CHK-005 last (integrates everything)
