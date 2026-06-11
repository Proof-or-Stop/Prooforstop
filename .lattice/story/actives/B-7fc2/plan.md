# B-7fc2 Plan — Strict JSON stdout contract

## Outcome Transcript

Expected machine-mode transcript:

```bash
node packages/main/dist/cli.js validate --json | node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(0,"utf8")); console.log("parse-ok")'
parse-ok
```

Expected text-mode transcript still includes the human hint:

```text
→ 验证全绿。可以提交
```

## Agent Split

- Agent 1: contract audit and regression-test design.
- Agent 2: implementation and primary validation.
- Agent 3: independent review and delivery readiness.
- Codex: orchestration, code review, final acceptance transcript, and Lattice DONE gates.

## CHK-001 — Contract Audit And Failing Reproduction

Scope:

- Inspect `packages/main/src/cli-engine.ts` and `packages/main/src/handlers/hints.ts`.
- Confirm the exact stdout contamination path for `validate --json`.
- Build an explicit matrix of JSON commands:
  - `validate --json`
  - `authority_status --json`
  - `host runtime probe --json`
  - `parallel_status --format=json`
- Reject dashboard-side substring parsing as a solution.

Acceptance:

- A real child-process reproduction shows current `validate --json` cannot be passed directly to `JSON.parse`.
- The plan identifies that existing direct-parse smokes already protect several non-hint JSON commands.

## CHK-002 — CLI Output Pipeline Fix

Scope:

- Add a shared machine-mode detector in the CLI output path:
  - `args.json === true`
  - `args.format === "json"`
- JSON machine mode must skip stdout hint decoration.
- Text mode must keep existing `decorateResult` behavior.

Acceptance:

- `validate --json` stdout is exactly parseable JSON.
- stdout does not contain `→ 验证全绿` in JSON mode.
- text-mode `validate` still shows the next-step hint.

## CHK-003 — Regression Smoke And Docs

Scope:

- Add `packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`.
- Add or wire an npm script for the smoke if local conventions require one.
- Document the contract in dashboard/testing-infra docs and README if there is already a suitable CLI JSON section.

Acceptance:

- The smoke directly calls `JSON.parse(stdout)` with no substring extraction.
- The smoke includes at least one known-good `--format=json` command to guard against broad regressions.
- Docs state that `--json` / `--format=json` stdout is machine-only JSON; human guidance belongs to text mode or stderr.

## CHK-004 — Three-Agent Review And Delivery

Scope:

- Agent 1 produces a contract/test audit artifact.
- Agent 2 implements and validates the fix.
- Agent 3 performs independent code/delivery review.
- Codex records final acceptance transcript and writes Lattice delivery/summary artifacts.

Acceptance:

- Three Claude Code CLI agents have traceable outputs.
- `lattice validate --story=B-7fc2 --json` passes.
- Final user acceptance transcript includes parseable JSON mode and preserved text-mode hint.
