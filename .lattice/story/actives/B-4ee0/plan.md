# B-4ee0 Plan - Global-thin Lattice init assets

## Scope

Move fresh `lattice init` to a global-thin default: project-local assets describe Lattice context, while executable Codex adapter behavior lives in the global `lattice` CLI. Keep existing local shim / Koala-era assets compatible and non-destructive.

## CHK-001

Title: 定稿 global-thin 管理资产契约

DependsOn: none. This item defines the contract that CHK-002/003/004 implement.

Implementation notes:
- Update templates and managed asset registry so canonical fresh-project assets are `.Lattice/Lattice.md`, `.Lattice/lattice.json`, and a thin `AGENTS.md` pointer.
- Document legacy compatibility paths: `LATTICE.md`, `KOALA.md`, `.Codex/lattice.json`, `.Codex/koala.json`, `bin/lattice.js`, `bin/lattice-codex.js`, `bin/koala.js`, `bin/koala-codex.js`.
- Make `.Codex/*` and local `bin/*` Codex wrappers explicit full/local-shim or legacy assets, not default global-thin assets.

DoneWhen:
- A reader can tell exactly which files fresh init creates by default and which files are legacy/opt-in.
- No managed template implies that a fresh global-thin project must have `bin/lattice-codex.js` or `.Codex/README.md`.

Verification:
- Docs/template grep for forbidden default-shim language.
- `thin-init-assets-smoke` checks canonical and forbidden assets.

## CHK-002

Title: 修改 init 默认输出为 .Lattice 最小资产

DependsOn: CHK-001.

Implementation notes:
- Change fresh default `lattice init` to use global-thin defaults. Do not generate `bin/lattice.js`, `bin/lattice-codex.js`, `.Codex/README.md`, `.Codex/lattice.json`, `.Codex/agents`, or `KOALA.md` by default.
- Generate `.Lattice/Lattice.md`, `.Lattice/lattice.json`, and thin `AGENTS.md`.
- Preserve explicit full/local-shim mode. If existing `--asset-mode full/thin` is insufficient, add the smallest compatible option or reinterpret default safely with tests.
- Keep starter/business template behavior separate from asset mode.

DoneWhen:
- Fresh temp project file tree is visibly clean and matches the user’s requested `.Lattice` direction.
- Opt-in full/local-shim behavior remains available for projects that need local pinned wrappers.

Verification:
- Fresh init smoke asserts required assets exist and forbidden assets are absent.
- Full/local-shim smoke asserts opt-in assets still work.

## CHK-003

Title: 把 Codex verify/doctor 能力收回全局 CLI

DependsOn: CHK-001 and CHK-002.

Implementation notes:
- Add or expose global command aliases `lattice codex verify` and `lattice codex doctor` while keeping `verify_codex` compatibility.
- Resolver priority should be `.Lattice/lattice.json` first, then `.Codex/lattice.json`, `.Codex/koala.json`, `LATTICE.md`, `KOALA.md` as applicable.
- `runCodexAdapterChecks` must not hard fail global-thin projects for missing local wrapper or `.Codex` manifest. Local wrapper heartbeat is required only when a local wrapper/full/legacy adapter is present or explicitly requested.
- Update process/runtime fact contracts if command names or evidence commands change.

DoneWhen:
- In a fresh global-thin project with no `bin/lattice-codex.js`, user can run global `lattice codex verify` / `lattice codex doctor` and get a pass or bounded diagnostic, not a hard missing-wrapper failure.
- Legacy `verify_codex` remains accepted.

Verification:
- Targeted smoke runs global Codex verify/doctor in a minimal project.
- Legacy smoke runs old manifest/wrapper verify path.

## CHK-004

Title: 实现非破坏迁移与 legacy compatibility

DependsOn: CHK-001.

Implementation notes:
- `lattice check` should detect and report legacy assets as compatibility/migration candidates.
- `lattice check --apply` may create missing canonical `.Lattice` assets but must not delete or overwrite legacy assets by default.
- Any legacy pruning must require an explicit option and be covered by tests if implemented in this story.
- Mixed projects should prefer `.Lattice/lattice.json` but still explain detected legacy files.

DoneWhen:
- Existing projects with Koala or old Lattice local shim assets still run and check cleanly or receive non-breaking migration advice.
- Default apply is safe for user-edited old assets.

Verification:
- Legacy compatibility smoke proves old files survive `check --apply` and old commands still work.
- Mixed resolver smoke proves `.Lattice` wins without deleting `.Codex`/`KOALA` assets.

## CHK-005

Title: 补 smoke/contract 验证并重新 build

DependsOn: CHK-002, CHK-003, CHK-004.

Implementation notes:
- Extend `thin-init-assets-smoke` for fresh minimal init, forbidden default assets, `.Lattice` guide/config, global codex verify/doctor.
- Extend `legacy-koala-compatibility-smoke` for old Koala and old Lattice local shim compatibility.
- Add package scripts only if useful for stable targeted runs.
- Rebuild TypeScript after implementation.

DoneWhen:
- Build passes.
- Targeted smoke tests pass and clearly prove the user-visible outcome: clean new project file tree, global Codex commands, legacy compatibility.

Verification commands:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:thin-init-assets-smoke`
- `npm --prefix packages/main run test:legacy-koala-compatibility-smoke`
- `npm --prefix packages/main run test:runtime-fact-contract`
- `npm --prefix packages/main run test:validation-protocol`
