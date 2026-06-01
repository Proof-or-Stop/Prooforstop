# B-4f15 Plan — Read-only Reviewer Command Policy

Design decision: use `KOALA_REVIEWER_READONLY=1` as an explicit advisory/delegated reviewer mode. The guard lives in `packages/main/src/cli-engine.ts` beside the owner-lease gate and reuses `resolveEffectiveOwnershipClass`. In readonly mode only effective `readOnly` commands may proceed; `reviewerWrite`, `storyScopedMutating`, `mainSharedMutating`, `dangerousMutating`, and unclassified commands fail closed before preCommand hooks and before handlers.

Normal Koala reviewers remain unchanged. They must not set readonly mode because they need to call `review_run_start`, `finding_add`, `review_pass_set`, `init_check_set`, `scope_check_save`, or `delivery_check_set`.

## CHK-001

**Owner**: koala-implementer

Document the contract in the existing truth sources rather than creating a duplicate. Add a concise section to `docs/requirements/decisions/role-separation.md` describing advisory read-only reviewers. Add a note to `docs/requirements/decisions/session-ownership-and-write-leases.md` clarifying that readonly reviewer mode is an extra opt-in guard layered on top of CommandPolicy/owner lease semantics.

Files:
- Modify: `docs/requirements/decisions/role-separation.md`, `docs/requirements/decisions/session-ownership-and-write-leases.md`
- Create: none
- Test: docs inspection plus REVIEW docs reviewer

## CHK-002

**Owner**: koala-implementer

Implement `KOALA_REVIEWER_READONLY=1` in `packages/main/src/cli-engine.ts`. Add small exported helpers so contract tests can assert behavior without launching a full CLI process. The helper should use `resolveEffectiveOwnershipClass(cmd,args,storyId)` and allow only `readOnly`. Error copy must name the env var, the command, the effective class, and the correct recovery path: return structured findings to the owner, who records evidence.

The guard must run before preCommand hooks and before `enforceStoryOwnerLeaseGate`, so blocked commands cannot write metadata, trigger mutating hooks, or use `--takeover` / `--forceTakeover` to bypass the readonly role.

Files:
- Modify: `packages/main/src/cli-engine.ts`
- Create: none
- Test: `packages/main/src/tasks/command-ownership-contract.ts`, `packages/main/src/tasks/reviewer-readonly-command-policy-smoke.ts`

## CHK-003

**Owner**: koala-implementer

Add regression coverage. Prefer a focused smoke task plus command ownership contract assertions. Required cases:
1. readonly mode allows `session_brief` or another effective readOnly command;
2. readonly mode blocks `review_pass_set` / reviewerWrite and writes no review-pass artifact;
3. no-env normal reviewerWrite remains allowed through the existing owner-lease gate;
4. readonly mode blocks `story_advance --forceTakeover` or another dangerous/story-scoped command before owner-lease takeover semantics.

Expose the focused smoke through `packages/main/package.json` and root `package.json` if consistent with nearby task scripts.

Files:
- Modify: `packages/main/src/tasks/command-ownership-contract.ts`, `packages/main/package.json`, `package.json`
- Create: `packages/main/src/tasks/reviewer-readonly-command-policy-smoke.ts`
- Test: `npm --prefix packages/main run build`, focused smoke, command ownership contract

## CHK-004

**Owner**: koala-implementer

Update owner/dispatch guidance for advisory external reviewers. Add a short note to `.Codex/agents/koala-evaluator.md` and `.claude/agents/koala-evaluator.md`: when launching Claude/Codex/Gemini as an advisory read-only reviewer, set `KOALA_REVIEWER_READONLY=1` only on that spawned process and collect structured findings/text yourself. Do not set it for normal Koala gate reviewers. If it was omitted, treat the review as non-sandboxed and verify/record evidence explicitly.

Files:
- Modify: `.Codex/agents/koala-evaluator.md`, `.claude/agents/koala-evaluator.md`, `docs/requirements/decisions/role-separation.md`
- Create: none
- Test: `node scripts/verify-codex-assets.mjs` and docs grep for the env guidance

## CHK-005

**Owner**: main-agent

Run lifecycle and evidence validation after implementation commits. Required verification commands: `npm --prefix packages/main run build`, the new focused smoke, `npm run test:command-ownership-contract`, process/runtime fact contracts if impacted, `node scripts/verify-codex-assets.mjs`, `koala validate --story=B-4f15`, `koala session_brief`, reviewer evidence, delivery check, summary, and DONE gate.

Files:
- Modify: Koala metadata only (`summary.json`, `test-evidence.json`, `delivery-check.json`)
- Create: none
- Test: full listed command set plus reviewer/DONE gates
