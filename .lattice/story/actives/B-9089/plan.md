# B-9089 Plan: Owner Session Canonical Runtime Contract

## Execution Order

1. Finish pre-code evidence: two-host plan review evidence (CHK-001) and parent-PID transcript evidence (CHK-007).
2. Initialize an enforce-mode scope contract from this plan before DEV.
3. Implement the resolver facade and preserve existing behavior through the facade (CHK-002).
4. Move host-specific session signals into adapter-boundary code and the dispatch/provider launch env boundary (CHK-003).
5. Add generated-token fallback and runtime artifact hygiene (CHK-004).
6. Replace lifecycle and DEV-claim ad hoc session reads (CHK-005).
7. Run focused smoke, guardrail, runtime two-host matrix evidence, build, and Lattice validation evidence (CHK-006).

This is a single-owner integration story. The touched files are tightly coupled owner-lease/lifecycle paths, so parallel host execution is used for plan review evidence and runtime/review verdicts, not simultaneous edits to the same core files.

## Scope Decisions

- Actual launch/dispatch/pre-apply integration is in scope only at the owner-session adapter/env boundary: dispatch/provider launch paths may preserve or set `LATTICE_SESSION_ID` for Codex, Claude Code, Antigravity/agy, and fake future-host coverage.
- Broader dispatch redesign, Gemini-to-Antigravity provider migration, and unrelated provider behavior are excluded. Active story B-fbb6 owns the Gemini-to-Antigravity semantic migration.
- `runtime-fact-registry.ts` and `command-ownership-contract.ts` are not planned touchpoints unless a later scoped replan proves they are needed.

## CHK-001

**Owner**: main-agent

**Goal**: Record two independent host reviews of the current owner-session execution plan before runtime code changes begin.

**Files**:
- `.lattice/story/actives/B-9089/checklist.json` through Lattice evidence commands only.

**Steps**:
- Compute the current git HEAD and document/material hash for `docs/requirements/decisions/owner-session-contract-execution-plan.md`.
- Run one Codex-host review and one second host review, preferring Claude Code CLI when available and falling back to Antigravity/agy only if Claude cannot run.
- Each review must explicitly check local/non-cryptographic boundary, generated-token fallback, ppid degradation, and no core host-specific session exceptions.
- Record passing evidence with host provider, command/transcript hash where available, story id, git HEAD, document hash, and timestamp.

**Verify**:
- Evidence note contains `PASS owner-session plan-review evidence: 2 independent hosts reviewed the bound plan and found no blocking contract issue`.
- Duplicate same-host/same-session reviews do not satisfy the item.
- No evidence claims Authority/full production completion.

## CHK-002

**Owner**: main-agent

**Goal**: Introduce the host-neutral owner-session resolver facade used by owner-lease code.

**Files**:
- Modify: `packages/main/src/core/story-owner-lease.ts`
- Modify: `packages/main/src/handlers/session.ts`
- Modify: `packages/main/src/core/story-owner-lease-doctor.ts`
- Modify: `docs/requirements/decisions/session-ownership-and-write-leases.md`
- Create: `packages/main/src/core/owner-session.ts`
- Test: `packages/main/src/tasks/story-owner-lease-smoke.ts`

**Steps**:
- Create a resolver facade that returns `sessionId`, `sessionSource`, diagnostic provider/source metadata, and degraded status.
- Preserve existing canonical env and ppid fallback behavior first.
- Update owner-lease acquisition/refresh/read summaries to consume the facade result rather than embedding source-specific logic.
- Keep legacy lease reading tolerant of older `koala-env` and `claude-code-env` sessionSource values.
- Update `session-ownership-and-write-leases.md` so it reflects implemented canonical source labels after code lands.

**Verify**:
- `lattice session_brief` can show `owner session: <id> [explicit-env]` for canonical env and `owner session: <id> [derived-ppid]` only for degraded fallback.
- Smoke covers canonical env wins, blank canonical env ignored, ppid fallback, ppid degradation, and source-label compatibility.

## CHK-003

**Owner**: main-agent

**Goal**: Move Claude/Codex/Antigravity/future-host session signals to adapter-boundary code and route dispatch/provider launch env through that bridge.

**Files**:
- Modify: `packages/main/src/core/story-owner-lease.ts`
- Modify: `packages/main/src/handlers/context.ts`
- Modify: `packages/main/src/handlers/transition-orchestrator.ts`
- Modify: `packages/main/src/core/lattice-dispatch.ts`
- Modify: `docs/guide-scope-guard.md`
- Create: `packages/main/src/core/owner-session-adapters.ts`
- Test: `packages/main/src/tasks/story-owner-lease-smoke.ts`

**Steps**:
- Implement adapter functions for Claude Code, Codex, Antigravity/agy, and a fake future host fixture.
- Adapter code may read host-native stable signals and convert them to canonical owner-session identity metadata.
- Dispatch/provider launch code may call the adapter bridge to preserve or set `LATTICE_SESSION_ID` in child/dispatch env summaries.
- Generic owner-lease, lifecycle, gate, and cli-engine code must not read host-native session env names directly.
- Add a guardrail check that fails if forbidden host-native env names appear outside allowed adapter/test/docs and dispatch-boundary paths.
- Update `docs/guide-scope-guard.md` only where it describes provider labels versus owner-session identity.

**Verify**:
- Guardrail output contains `PASS owner-session host-native env guardrail: no generic core host-session env reads`.
- Diagnostics may still display provider labels such as `claude-code`, `codex`, `antigravity`, and `agy`, but gates key on canonical `sessionId`.
- This does not rename or migrate legacy Gemini provider behavior; that remains outside this story.

## CHK-004

**Owner**: main-agent

**Goal**: Add generated-token fallback for adapter sessions with no native stable env, and keep token storage material-safe.

**Files**:
- Modify: `packages/main/src/core/runtime-artifact-registry.ts`
- Modify: `packages/main/src/core/story-owner-lease.ts`
- Modify: `packages/main/src/core/story-owner-lease-doctor.ts`
- Create: `packages/main/src/core/owner-session-token-store.ts`
- Test: `packages/main/src/tasks/story-owner-lease-smoke.ts`

**Steps**:
- Implement a generated token store scoped by project/worktree root, provider, and adapter session boundary.
- Use generated-token fallback only when an adapter can provide a stable boundary but no native session id.
- Register the token path as a runtime artifact and ensure ignored/material-safe behavior.
- Label generated-token sessions as local coordination only in diagnostics.

**Verify**:
- Smoke output includes `PASS owner-session generated-token fallback: stable token reused and runtime artifact ignored`.
- `git status --short` does not show the token file as a material change.

## CHK-005

**Owner**: main-agent

**Goal**: Replace lifecycle event and DEV-claim ad hoc session env reads with the shared resolver.

**Files**:
- Modify: `packages/main/src/handlers/context.ts`
- Modify: `packages/main/src/handlers/transition-orchestrator.ts`
- Modify: `packages/main/src/core/story-owner-lease.ts`
- Test: `packages/main/src/tasks/story-owner-lease-smoke.ts`

**Steps**:
- Update `collectContext` to use the owner-session resolver for event `sessionId`.
- Replace DEV-claim warning current-session logic with the same resolver.
- Preserve behavior when session id is unavailable or degraded, but label ppid fallback clearly.

**Verify**:
- Repeated commands with the same canonical session do not print `already claimed for development` merely because parent PID changes.
- Grep guardrail confirms lifecycle files do not read host-native session env names directly.

## CHK-006

**Owner**: main-agent

**Goal**: Add guardrail tests and complete multi-host runtime verification matrix coverage.

**Files**:
- Modify: `packages/main/src/tasks/story-owner-lease-smoke.ts`
- Modify: `packages/main/package.json`
- Create: `packages/main/src/tasks/owner-session-guardrail.ts`
- Test: `packages/main/src/tasks/story-owner-lease-smoke.ts`
- Test: `packages/main/src/tasks/owner-session-guardrail.ts`

**Steps**:
- Extend story-owner lease smoke for canonical env, blank env, adapter bridge, generated token, ppid fallback/degradation, owner gate, lifecycle events, and material hygiene.
- Add a focused guardrail task/script for host-native env names in generic core paths.
- Record runtime matrix evidence using Codex plus Claude Code when Claude is available; if Claude cannot run, record the unavailability and use Antigravity/agy as the second host.
- Keep matrix evidence local/non-Authority and bind it to HEAD/material hash.
- Run build and focused smokes before entering REVIEW.

**Verify**:
- Terminal output contains `✓ story-owner-lease smoke passed`, `PASS owner-session host-native env guardrail`, and `PASS owner-session runtime matrix: codex + claude-code/agy evidence recorded` after `npm --prefix packages/main run build` succeeds.

## CHK-007

**Owner**: main-agent

**Goal**: Record the required parent-PID-changing transcript evidence before runtime source edits begin.

**Files**:
- `.lattice/story/actives/B-9089/checklist.json` through Lattice evidence commands only.

**Steps**:
- Record two parent-PID-changing invocation shapes that preserve the same `LATTICE_SESSION_ID` and prove the same owner lease is reused/refreshed.
- Record one degraded comparison with no canonical env, no adapter signal, and no generated token.
- Include story id, command, host provider, cwd, git HEAD, material/document hash, observed session id/source, owner lease before/after summary, and pass/fail.

**Verify**:
- Transcript evidence includes `PASS parent-pid transcript: canonical session reused lease across two invocation shapes; degraded ppid-only path labeled derived-ppid`.
- Incomplete transcript entries do not satisfy the item.
