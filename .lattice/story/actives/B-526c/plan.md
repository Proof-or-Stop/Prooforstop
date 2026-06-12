# B-526c Execution Plan

Goal: add a small Lattice-owned CLI path that helps an operator repair wrapper-root projects by configuring gitRoot explicitly. This plan does not change signed-workspace runtime resolution to guess child repositories, and it does not make Claude CLI, Codex CLI, or any other host an automatic repair authority.

Core constraints:
- Do not optimize for optimization; fix only the B-3938-style wrapper-root correctness UX.
- Do not optimize arbitrarily; reuse existing gitRoot resolver semantics and existing config doctor surface.
- Only fix real correctness issues; no Layer4, Authority, production readiness, or global convergence claims.
- Preserve logic consistency; read-only diagnosis and mutating repair must have separate command policy semantics.

## CHK-001

Execution:
1. Extend `lattice_config_doctor` with wrapper-root diagnostics derived from the current metadata root and loaded config.
2. If metadata root is git-backed or explicit `gitRoot` is configured, report that state without suggesting an automatic repair.
3. If metadata root is not git-backed and no explicit `gitRoot` is configured, inspect only immediate child directories for git roots.
4. Emit three deterministic states: `none`, `single`, or `ambiguous`.
5. For a single safe child git root, print an operator-facing suggestion and repair command. This is a suggestion only, not a resolver input.

Verification checklist:
- Single child repo: doctor text/JSON includes `suggestedGitRoot: clawcreek` and `repairCommand: lattice config repair --set-git-root=clawcreek --confirm`.
- Zero child repos: doctor reports no candidates and no repair command.
- Multiple child repos: doctor reports ambiguity and no chosen repair target.

## CHK-002

Execution:
1. Add `lattice_config_repair` plus alias `lattice config repair`.
2. Require an explicit `--set-git-root`/schema equivalent and `--confirm` before writing.
3. Normalize the requested path relative to metadata root; reject absolute/outside traversal, missing directories, non-git directories, and nested directories whose git top-level is elsewhere.
4. Preserve existing config data and update only `gitRoot`.
5. Report whether the configured git root verifies successfully; do not claim story resolution unless separately checked.
6. Register command policy and process-fact level consistently as a config mutating command, not gate evidence.

Verification checklist:
- Confirmed valid repair writes `gitRoot` and reports verified configured root.
- Missing `--confirm` is non-mutating and gives a concrete rerun command.
- Unsafe paths and non-git paths fail without modifying config.
- Command appears in CLI help/alias and policy/fact contract verification passes.

## CHK-003

Execution:
1. Extend field-regression smoke around existing wrapper-root fixtures.
2. Prove unresolved wrapper-root behavior remains fail-closed before repair.
3. Run the repair command in the fixture and verify `story_resolve` resolves via `configured-git-root`.
4. Verify `review_run_start` creates a signed reviewer run bound to the child git root after repair.
5. Verify ambiguous wrapper roots remain diagnostic-only until an explicit valid repair is provided.

Verification checklist:
- `npm --prefix packages/main run build` passes.
- Field-regression smoke covering wrapper-root repair passes.
- `node scripts/verify-process-fact-contract.mjs` passes after new command registration.
- `lattice validate --story=B-526c` passes or reports only actionable evidence gaps that are then recorded.
