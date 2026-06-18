## Trigger Event
On 2026-06-16, during a pre-open-source cruft audit (after stories B-d313/B-0b26/B-08f2/B-747e and the discarded B-5740), three candidates were proposed for deletion. The concept reviewer in B-5740 found that intent-coverage was actually live via a dynamic fixture import. This story recreates the cleanup with only the two truly-dead modules plus the junk file.

## Key Insights
'orphans' is a tracked 5-byte shell-redirect mistake at repo root. phase-protocol.ts and bridge-utils.ts each have 0 source imports AND 0 dynamic/path consumers anywhere (verified by a two-pass scan: static `.ts` imports + dynamic `import()` and `dist/<path>.js` path references across packages, scripts, tests/fixtures, and bin). Their exported symbols (buildPhaseGateDecision/buildRollbackDecision/formatPhaseGateDecision; CreateBridgeOptions) have zero external uses. By contrast, intent-coverage.ts is live via packages/main/tests/fixtures/fixture-preview-runner-parity.json which dynamically imports dist/core/intent-coverage.js — that's why it's excluded here.

## Solution Tradeoffs
Delete only the certain-dead items; let the concept-deletion reviewer confirm no residual references and the over-reach guards (intent-coverage, dev-cli, lab, .codex/.Codex, .lattice all untouched). build + e2e must stay green. Conservative scope avoids repeating the B-5740 mistake.

## Conversational Texture
The user said 'delete the certain ones' after the audit; when the first attempt found intent-coverage was actually consumed by a fixture, they confirmed deleting only the truly certain items.
