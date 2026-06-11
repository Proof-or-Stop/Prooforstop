# B-952f Plan

## CHK-001: 修正 convergence_check 的终态 story 统计口径

**Owner**: main-agent

Change `checkConvergence` so `activeStories` excludes both `DONE` and `DISCARDED`.
Keep all non-terminal phases visible to the convergence gate.

Validation:

- Smoke test with only `DONE` and `DISCARDED` stories does not report unfinished stories.
- Smoke test with a `DEV` story still reports unfinished stories.

## CHK-002: 补齐 summary.ts 顶部 @task 注释必填字段

**Owner**: main-agent

Update only the file-level task metadata block in `summary.ts`.
Do not change runtime imports, exported handlers, or summary behavior.

Validation:

- Annotation validation no longer reports `summary.ts:1` missing fields.
- TypeScript build still passes.

## CHK-003: 补回归验证 convergence 与注释错误消失

**Owner**: main-agent

Add a small compiled smoke script for the terminal-state convergence rule and
wire it into `package.json`.

Validation:

- `npm run build`
- `npm run test:convergence-false-blockers`
- `npm run test:e2e`
- `koala convergence_check`
