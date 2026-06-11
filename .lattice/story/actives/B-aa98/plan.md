# B-aa98 Plan — Lattice Host Overflow

## CHK-001 Document Host Overflow architecture and boundaries

Add `docs/requirements/decisions/host-overflow.md` as the canonical architecture note. Update README, guide, project vision, and docs NAV so users see that Lattice Host Overflow is a host-neutral coordination surface: Lattice owns story state, scope, receipts, evidence, and gates; Codex, Claude Code, Gemini, local-runner, browser, and future hosts are execution surfaces. Manual handoff is the first supported path. Supervised dispatch is conservative and cannot auto-trust, auto-merge, submit evidence, verify receipts, or claim productionDone.

Verification: docs grep/smoke will confirm the doc names manual-first overflow, authorityChanged=false, productionDone=false, no Mac App requirement, and no new model runner claim.

## CHK-002 Add host capability model for overflow readiness

Extend host/capability diagnostics with an overflow-oriented `host_status` surface. It should report a target host such as `claude-code`, capability categories, overflowReady status, limits, availability, and `nextAction`. Missing Claude Code or unknown hosts must degrade to unavailable/warn without breaking local workflow. It must keep receiptVerified=false and productionDone=false.

Verification: `host-overflow-smoke` will exercise `host_status --host=claude-code --format=json` and unavailable host behavior. Existing capability and Lattice migration smokes must continue to pass.

## CHK-003 Create bounded handoff pack schema and CLI

Extend existing `handoff_create` rather than replacing it. Add optional overflow fields: role, objective, allowedPaths, deniedPaths, requiredCommands, successCriteria, baseSha, packId, packHash, authority boundary, and explicit execution instructions. Preserve old `handoff-pack-v0` behavior for existing consumers. `handoff_inspect` should expose overflow fields when present.

Verification: smoke tests will create both a legacy-compatible pack and an overflow pack, inspect it, and assert no production authority is claimed.

## CHK-004 Add manual receipt submit and gate-consumable evidence

Add `handoff_receipt_submit` and inspect/read behavior for local external-host receipts. Receipts must reference packId, packHash, base/head, commands, changedFiles, verdict, limitations, and host. The submit result should classify scopeStatus and freshness/stale status, then store or return a local diagnostic receipt. It must not mutate production authority.

Verification: smoke tests will submit a passing receipt, a stale/hash-mismatch receipt, and an out-of-scope changedFiles receipt. All outputs must keep authorityChanged=false, receiptVerified=false, and productionDone=false.

## CHK-005 Add overflow worktree isolation guidance

Add `handoff_worktree_create` or equivalent projection that binds a pack to a dedicated branch/worktree plan. It may create metadata/projection and provide commands/guidance, but should not auto-run Claude Code or auto-merge results. The output must include worktree path, branch, baseSha, packId, allowedPaths, deniedPaths, cleanup guidance, and merge guidance.

Verification: smoke tests assert worktree projection output is deterministic, scoped, and no-overclaim. It should refuse or warn when pack constraints are missing.

## CHK-006 Cover Host Overflow with tests and delivery transcript

Create `packages/main/src/tasks/host-overflow-smoke.ts`, wire package scripts, and record `.koala/story/actives/B-aa98/evidence/host-overflow-transcript.md`. The transcript should be user-facing: a Codex user generates a Claude Code overflow pack, sees manual instructions, submits a local receipt, and observes that Lattice keeps authority false until future server receipt verification.

Verification: run build, host-overflow smoke, lattice-handoff smoke, lattice-cli-migration smoke, command ownership/process fact checks as needed, and final `lattice validate --story=B-aa98 --json`.

## CHK-007 Add conservative supervised dispatch projection

Add `host_dispatch` as a projection surface for supervised overflow. If Claude Code is unavailable, it returns status unavailable/warn and nextAction. If available or forced as dry run, it returns planned dispatch metadata. It must not invoke vendor-specific non-interactive Claude Code as a trusted runner in this story; no auto-trust, no auto-merge, no evidence submit, no receipt verify, no productionDone.

Verification: smoke tests cover unavailable and dry-run/planned dispatch outputs. Docs explain supervised dispatch is future-facing and conservative.
