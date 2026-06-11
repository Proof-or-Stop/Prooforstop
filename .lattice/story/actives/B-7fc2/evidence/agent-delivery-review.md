# B-7fc2 Agent Delivery Review Evidence

Story: B-7fc2 - Keep Lattice CLI --json stdout machine-parseable while preserving human hints
Reviewed head: 951a6c763173fb316d9178695972f5629b94a606
Implementation commit: 8a0c0705 B-7fc2: enforce strict JSON stdout contract

## Agent 1 - contract audit

Role: Claude Code CLI contract/test auditor, read-only.

Findings:
- Reproduced the original bug before the implementation: `node packages/main/dist/cli.js validate --json` produced a valid JSON document followed by a human next-step hint, so `JSON.parse(stdout)` failed.
- Isolated the root cause to the CLI wrapper calling `decorateResult(...)` after the validate handler returned JSON text.
- Confirmed `authority_status --json`, `host_runtime_probe --json`, and `parallel_status --format=json` were already parseable because they were not in the hint registry.
- Recommended the chosen fix: skip result hint decoration in the shared CLI output pipeline when `args.json === true` or `args.format === "json"`; do not add dashboard-side JSON substring extraction.
- Also identified that text-mode `validate` did not reliably emit the human success hint because the hint detector only recognized JSON-like `allPass` markers.

## Agent 2 - implementation

Role: Claude Code CLI implementer.

Commit:
- `8a0c0705 B-7fc2: enforce strict JSON stdout contract`

Changes:
- Added `wantsMachineJson(args)` in `packages/main/src/handlers/hints.ts`.
- Updated `packages/main/src/cli-engine.ts` so machine JSON mode skips `decorateResult(...)` at the shared output choke point.
- Preserved text-mode validate hints by recognizing `ALL PASS` / project validation pass text markers.
- Added `packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`.
- Added npm scripts for the focused smoke.
- Documented the CLI JSON stdout contract in `docs/requirements/decisions/host-neutral-observability-console.md`.

Agent 2 validation reported:
- `npm --prefix packages/main run build` passed.
- `npm --prefix packages/main run test:cli-json-stdout-contract-smoke` passed.
- `npm --prefix packages/main run test:lattice-cli-migration-smoke` passed.
- `node packages/main/dist/cli.js validate --json | node -e 'JSON.parse(...)'` printed `parse-ok`.
- `node packages/main/dist/cli.js validate` kept the human success hint.

## Agent 3 - independent review

Role: Claude Code CLI independent reviewer, read-only.

Verdict: pass.

Review conclusions:
- The fix is in `packages/main/src/cli-engine.ts`, not in a dashboard substring parser.
- `wantsMachineJson` covers `args.json === true` and `args.format === "json"`.
- Text-mode `validate` still emits the human next-step hint.
- The smoke spawns real CLI child processes and uses direct `JSON.parse(stdout)`.
- The doc contract is recorded in the canonical host-neutral observability decision.
- No schema overreach: `validate` is exercised with `--json`, while `--format=json` is exercised on commands that declare `format`.

Agent 3 validation:
- `npm --prefix packages/main run build` passed.
- `npm --prefix packages/main run test:cli-json-stdout-contract-smoke` passed.
- `npm --prefix packages/main run test:lattice-cli-migration-smoke` passed.
- Direct `validate --json | JSON.parse(stdin)` returned `parse-ok`.
- Text-mode validate tail contained the human success hint.
- `lattice finding_list --storyId=B-7fc2` returned no findings.

Residual risk noted by Agent 3:
- Coverage breadth is focused on the hint registry and representative JSON commands. Other JSON surfaces that never had hints are not exhaustively enumerated by this story. The shared choke point protects future hint-registered commands, and the smoke locks the original regression plus representative `--format=json` surfaces.

## Codex review and acceptance transcript

Codex reran:
- `npm --prefix packages/main run build` -> pass.
- `git diff --check` -> pass.
- `npm --prefix packages/main run test:cli-json-stdout-contract-smoke` -> pass.
- `npm --prefix packages/main run test:lattice-cli-migration-smoke` -> pass.
- `node packages/main/dist/cli.js validate --json | node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(0,"utf8")); console.log("parse-ok")'` -> `parse-ok`.
- `node packages/main/dist/cli.js validate | tail -n 8` -> contains `->` equivalent human success guidance in text mode (`验证全绿`).

Codex review verdict: no blocking code-review findings. The implementation satisfies the story contract:
- JSON mode stdout is direct-parseable as one JSON document.
- Human hints are preserved in text mode.
- The fix is shared in the CLI output pipeline.
- The dashboard/adapter path does not need substring parsing.

Limitations:
- No known product limitations for the scoped contract.
- This story does not claim every Lattice command has a finalized JSON schema; resolver/dashboard schema work remains owned by the host-neutral observability console milestones.
