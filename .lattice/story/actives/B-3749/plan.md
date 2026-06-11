# B-3749 plan

## CHK-001 metadata-only commit 不应让 verification evidence stale

- Define a narrow Koala workflow metadata classifier for evidence freshness.
- Keep source, tests, fixtures, package metadata, lockfiles, Koala config, and requirements/decisions material.
- Add a smoke test that proves workflow metadata remains fresh and material changes become stale.

## CHK-002 testintent_handoff 在 PLAN 阶段可用且命令注册一致

- Wire the existing testintent handoff handler into the main registry.
- Add a CLI schema entry so `help` and `--help` expose the command.
- Add phase allowlist support so PLAN can call it.
- Add a smoke test for command discovery, PLAN usage, and invalid item errors.

## CHK-003 新增回归验证覆盖 stale 与 handoff

- Add package scripts for both smoke tests.
- Run build, the new smoke tests, e2e, and story validation.
- Record verification evidence for all required intents.

## Out of scope

- No change to test-intent authoring semantics.
- No broad relaxation of stale checks for requirements, fixtures, source, or package files.
- No migration of historical story evidence files.
