# B-6894 User-Value Transcript Diff

## Expected

- `init_check_repair` success output includes the boundary sentence:
  `Fallback only repairs INIT_CHECK; it does not authorize implementation and does not replace later PLAN/DEV/REVIEW/TEST reviewers.`
- Refused `init_check_repair` paths do not write `init-check.json` and do not emit a continuation hint.
- Blocking fallback output still says the gate blocks, includes the authorization boundary, and does not imply implementation may continue.
- `story_get` marks fallback stories with `initCheckAttestation=fallback` and a warning string, while independent reviewer stories do not get fallback warning fields.
- `session_brief` surfaces an `INIT fallback warning` section that says fallback is manual attestation, later gates remain required, and explicit user/project authorization is required for continuation.

## Actual

Commands run from `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-6894`:

```text
npm --prefix packages/main run build
npm --prefix packages/main run test:init-check-fallback-smoke
koala scope_contract_check --storyId=B-6894
koala validate --story=B-6894 --json
```

Observed results:

```text
npm --prefix packages/main run build
  PASS

npm --prefix packages/main run test:init-check-fallback-smoke
  PASS: ✓ init check fallback/repair smoke passed

koala scope_contract_check --storyId=B-6894
  PASS: Scope gate: pass; Semantic scope gate: pass

koala validate --story=B-6894 --json
  PASS: Project validation commands passed
  PASS: Verification intent coverage: 9/9 covered (0 required missing)
```

## Diff

No user-visible mismatch found. The focused smoke test exercises the fallback story, independent reviewer contrast story, refused repair paths, blocking high-issue fallback, and `session_brief` warning text. `koala validate` records all nine happy/edge/adversarial verification intents as covered.

## Evidence Refs

- `.koala/story/actives/B-6894/checklist.json`
- `.koala/story/actives/B-6894/test-evidence.json`
- `packages/main/src/tasks/init-check-fallback-smoke.ts`
