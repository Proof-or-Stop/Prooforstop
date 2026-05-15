# B-d9ee User-Value Transcript Diff

## Expected

- In PLAN, `grill_start`, `grill_record`, `grill_close`, and `grill_get` provide a usable planning-clarification flow.
- Closing a session with unresolved questions surfaces `remainingUnknowns` without turning the transcript into verification evidence.
- Outside PLAN, mutating grill commands are rejected by the target story phase, while `grill_get` remains read-only.

## Actual

Ran local worktree CLI from current build:

```bash
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_start '{"storyId":"B-21e6","topic":"Confirm grill planning artifact behavior"}'
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_record '{"storyId":"B-21e6","question":"Can grill transcript replace verificationEvidence?","answer":"No. It is planning context only.","status":"answered"}'
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_record '{"storyId":"B-21e6","question":"What remains unresolved for delivery?","status":"unresolved"}'
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_close '{"storyId":"B-21e6","sessionId":"GRILL-001"}'
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_get '{"storyId":"B-21e6"}'
```

Observed:

- `grill_start` returned `Grill session started: GRILL-001`.
- Answered `grill_record` returned `Recorded grill question: GQ-001`.
- Unresolved `grill_record` returned `Recorded grill question: GQ-002`.
- `grill_close` returned `status: closed` and `remainingUnknowns: ["What remains unresolved for delivery?"]`.
- `grill_get` returned one closed `GRILL-001` session with one answered and one unresolved question.

Phase-boundary check:

```bash
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_get '{"storyId":"B-ccf7"}'
node packages/main/dist/cli.js --root /tmp/koala-grill-verify-fixed.3JcfyI grill_start '{"storyId":"B-ccf7","topic":"Should fail outside PLAN"}'
```

Observed:

- TEST-phase `grill_get` returned `{ "_empty": true }`.
- TEST-phase `grill_start` failed with: `grill_start can only mutate grill.json in PLAN; current phase is TEST, expected PLAN`.

## Diff

Accepted. Actual behavior matches the expected user-visible flow after the target-story phase guard fix. The first real-machine pass exposed that TEST-phase mutators were not mechanically blocked; commit `9fc8f12f` fixed that by checking the target story phase in the handler, and the final transcript confirms the lifecycle boundary is now enforced.
