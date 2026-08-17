# Plan: B-521d Add read-only playbook promotion observation command

## CHK-001: Add observation aggregation for candidate generation consumption and recommendation handling

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/playbook.ts
- Modify: packages/main/src/core/learning-store.ts
- Modify: packages/main/src/core/experience-layer-types.ts
- Test: packages/main/src/tasks/playbook-promotion-observe-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/playbook-promotion-observe-smoke.js` proves empty, consumed, unconsumed, handled, and unhandled cases.

**DoneWhen**:
- Observation output reports `candidateGenerated`, `candidateConsumed`, and `recommendationHandling`.
- `candidateConsumed` only counts explicit candidate exposure rows with `exposureMode != "none"`.
- Candidate existence, story DONE, neutral, and unknown rows do not become positive helped evidence.

## CHK-002: Expose host-neutral playbook_promotion_observe command

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/playbook.ts
- Modify: packages/main/src/cli/command-catalog.ts
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/process-fact-levels.ts
- Test: packages/main/src/tasks/playbook-promotion-observe-smoke.ts

**Verify**:
- `lattice playbook_promotion_observe --since=14d --json` emits valid JSON with `authority: "non_authoritative"` and `gateEvidence: false`.
- Invalid `--since` values fail with a `playbook_promotion_observe` diagnostic.
- Command policy and process-fact metadata classify the command as read-only/L0.

**DoneWhen**:
- The command is host-neutral and registered as a plain `lattice playbook_promotion_observe` workflow command.
- The command is not available or documented as a Codex/Claude adapter namespace command.
- The command writes no learning files and does not call sweep apply, activation, timers, trial traffic, runtime guidance, or DONE gate evidence paths.

## CHK-003: Add focused smoke coverage and documentation note

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: docs/requirements/decisions/playbook-promotion-worker-execution-plan.md
- Create: packages/main/src/tasks/playbook-promotion-observe-smoke.ts
- Test: packages/main/src/tasks/playbook-promotion-observe-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/playbook-promotion-observe-smoke.js` ends with `playbook promotion observe smoke passed`.
- `rg -n "playbook_promotion_observe|evidence gathering|not automatic" docs/requirements/decisions/playbook-promotion-worker-execution-plan.md` shows the boundary note.

**DoneWhen**:
- Smoke covers empty real-store posture and synthetic candidate/outcome/recommendation cases.
- Smoke covers unhandled `recommend_activate` and handled `recommend_activate` after explicit activation.
- Documentation says observation answers whether M7/M8 automation is justified; it does not implement automatic promotion, trial traffic, timer registration, or gate evidence.
