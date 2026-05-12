# B-5c5e Transcript Diff

## Expected

- Legacy test/fixture commands must not become active story phase tools by accident.
- A blocked command should explain lifecycle status, requested phase, allowed phase/root-only state, destructive risk, and the supported replacement path.
- Project or malformed `phaseTools` configuration must not widen root-only / legacy restrictions.
- Reviewers must be able to inspect planning artifacts in REVIEW, and `koala-review-test-coverage` must be documented as a reviewer lane rather than a CLI command.
- Static contract verification must fail future drift for command lifecycle policy and active lifecycle docs.

## Actual Transcript

`node packages/main/dist/cli.js test_auto` in TEST returned:

```text
❌ 命令 "test_auto" 在 TEST 阶段不可用
Lifecycle: legacy
Requested phase: TEST
Allowed phases: root-only (outside an active story phase gate)
Replacement: Use koala validate --story=<storyId> and record verificationEvidence; test_auto full regression requires dryRun/confirm and is blocked for koala self-project full runs.
Destructive risk: workspace-destructive
Policy source: packages/main/src/core/command-policy.ts
```

Runtime policy probe returned:

```json
{
  "legacyCannotBeWidened": true,
  "malformedConfigDoesNotOpenBugReportInDev": true,
  "reviewCanReadPlanningArtifacts": true,
  "reviewPatternsExcludeLegacyTestAuto": true,
  "reviewPatternsKeepFindingAdd": true
}
```

`node scripts/verify-process-fact-contract.mjs` ended with:

```text
Process fact contract verified
```

`node packages/main/dist/cli.js validate --story=B-5c5e --json` reported:

```text
Project validation commands passed
Verification intent coverage: 9/9 covered (0 required missing)
```

## Diff

Expected and actual match. The visible UX now sends users away from legacy/destructive commands and toward `koala validate` plus structured `verificationEvidence`. The hard gate is runtime-enforced, not just prompt wording. The remaining nuance is intentional: legacy command names still appear in historical/compatibility docs, but the contract requires that context to be labeled as legacy/compat/maintenance.
