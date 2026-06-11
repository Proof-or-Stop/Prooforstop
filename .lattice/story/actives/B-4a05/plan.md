# Plan for B-4a05

## CHK-001: Surface JSON/schema validation errors instead of silent help fallback

Implement a CLI error-output hardening patch: when zod validation fails, print the actionable diagnostics through the same error stream as the help text, suppress the generic session footer for that error-help rendering, and repeat a short failure summary at the end so the final visible lines point at the invalid path/value. Keep valid empty objects accepted where the schema allows them.

Files:
- packages/main/src/cli-engine.ts
- packages/main/src/tasks/cli-argument-ergonomics-smoke.ts

Verify:
- invalid verificationIntent type returns nonzero
- stderr contains verificationIntent.happy.0.type, integration_test, and allowed enum values
- stdout does not contain the generic status next-step footer for this validation failure

## CHK-002: Whitelist Koala-generated init-self-check artifact for DONE cleanup

Add only init-self-check.json to the stray story metadata whitelist. Do not add globs or directory-level cleanup. Extend the stray cleanup smoke coverage so a Koala-generated init-self-check file is treated like other runtime metadata while arbitrary files still block.

Files:
- packages/main/src/handlers/stray-file-cleanup.ts
- packages/main/src/tasks/review-pass-discard-smoke.ts

Verify:
- STRAY_FILE_WHITELIST contains init-self-check.json
- cleanup removes init-self-check.json when it is an untracked story metadata copy
- non-whitelisted story files still throw

## CHK-003: Record dispatch audit events consumed by channel review

After successful dispatch prompt construction, append a process event with type=dispatch. Include storyId, agentType, normalized target kind, itemId/checklistId for checklist dispatches, findingId/clusterId for review work, phase, and source=koala dispatch. Treat append failure as PERSIST: report health and log, but do not prevent returning the prompt.

Files:
- packages/main/src/handlers/story-dispatch.ts
- packages/main/src/tasks/review-pass-discard-smoke.ts
- packages/main/src/handlers/validate-channel.ts (read-only compatibility check)

Verify:
- dispatch itemId writes a process event consumed by validate-channel
- init reviewer dispatch also writes a dispatch event without requiring item/finding/cluster
- prompt output remains compatible
