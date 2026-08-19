## CHK-001 Add Codex adapter gate scope smoke

Implement `packages/main/src/tasks/codex-adapter-gate-scope-smoke.ts`. The smoke should import `storyRequiresCodexEvidence` from the compiled runtime path after build and use a minimal fake store with `readStory` and `readChecklist` methods. It should assert provider-only prose such as provider name Codex or Codex CLI host text returns false, while `.lattice-codex`, `verify_codex`, `bin/lattice-codex.js`, `.codex/hooks.json`, and `lattice codex verify` return true. The smoke must print a clear PASS line.

## CHK-002 Wire the smoke into validation without broadening behavior

Add the compiled smoke command to `lattice.config.json` validation commands with `focus: ["fast"]`. Verify `npm --prefix packages/main run build`, direct smoke execution, `lattice validate --focus=fast --json`, and at least one full story validate. This should add coverage only; it must not alter unsupported Codex workflow command behavior or adapter verification requirements.

## CHK-003 Write baseline comparison result for item 3

Create `experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-d43b-codex-adapter-gate-scope-result.json`. It should reference `baselineId`, `story: B-d43b`, and `baselineDimension: codexAdapterGateScope`, record provider-only text as not required, adapter surfaces as required, and explicitly state the artifact is local validation evidence only, not Authority or production proof. Do not modify the immutable baseline JSON.
