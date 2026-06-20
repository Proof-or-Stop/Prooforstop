# B-a781 Plan: Owner Session Contract for Stable Multi-Host Leases

## Scope

This story writes an execution plan for a host-neutral owner-session contract. It does not implement runtime behavior. The plan must be precise enough for a follow-up implementation story to update wrappers, dispatch, owner-lease tests, session rendering, and docs without re-deciding the architecture.

The core decision is that `LATTICE_SESSION_ID` becomes the canonical owner-lease identity at the Lattice boundary. Host-specific session facts belong in adapters/wrappers/dispatch, not in `core/story-owner-lease.ts` as an expanding list of host names.

## CHK-001

Document the canonical owner-session contract.

Implementation work:

- Create `docs/requirements/decisions/owner-session-contract-execution-plan.md`.
- Define `LATTICE_SESSION_ID` as the canonical local coordination identity consumed by story owner lease.
- State that `LATTICE_SESSION_ID` is local, forgeable, non-cryptographic, and never Authority receipt evidence.
- Define `sessionSource` language that can distinguish canonical, bridged, generated, legacy, and derived fallback sources.
- State that ppid-derived identity is a last-resort fallback because host shell parent processes may change between commands.
- Identify existing truth-source drift from older `KOALA_SESSION_ID` / `koala-env` wording and require migration in implementation.

Acceptance evidence:

- The document has explicit canonical contract wording.
- The document does not claim Authority, cryptographic identity, or production safety from local session ids.
- The document explains the ppid failure mode and why it must not be the normal mutating-command path.

## CHK-002

Define host adapter bridge and future-host onboarding rules.

Implementation work:

- Add a host adapter contract section covering Codex, Claude Code, Antigravity/agy, and future hosts.
- Require wrappers and dispatch flows to bridge stable native session ids, or generated dispatch session tokens, into `LATTICE_SESSION_ID` before any owner-gated mutating command.
- Define precedence: explicit user/project `LATTICE_SESSION_ID` wins; adapter bridge fills it only when absent.
- Keep `CLAUDE_CODE_SESSION_ID` as a transitional compatibility fallback, but describe it as a legacy core exception to migrate behind the adapter bridge.
- For Antigravity/agy, handle the unknown native-session-env case by requiring Lattice dispatch to generate and carry a stable token across the handoff/runner command set.
- Define future-host onboarding as one rule: prove stable `LATTICE_SESSION_ID` propagation; do not add host-specific env discovery to owner-lease core.

Acceptance evidence:

- The document contains a concrete mapping table for Codex, Claude Code, Antigravity/agy, and future hosts.
- The document includes both native-session and generated-token cases.
- The document explicitly rejects adding every future host env variable to owner-lease core.

## CHK-003

Define verification and rollout plan with two-host review.

Implementation work:

- Define the follow-up implementation story slices: shared session bridge helper, Codex wrapper bridge, Claude migration, Antigravity/agy dispatch bridge, owner-lease resolver hardening, docs updates, and tests.
- Require smoke coverage for ppid-changing invocations where stable `LATTICE_SESSION_ID` remains constant.
- Require wrapper tests proving Codex activity session and owner lease session are aligned.
- Require dispatch tests proving generated `LATTICE_SESSION_ID` is stable across a supervised Antigravity/agy handoff or runner scope.
- Require `session_brief`/doctor visibility for canonical vs legacy vs derived fallback source.
- Require fallback warnings, and later optional fail-closed policy, when owner-gated mutating commands run on `derived-ppid` without a stable env.
- Require two-host review before implementing runtime changes, with durable Lattice review evidence or material-bound host verdict evidence.

Acceptance evidence:

- The document has a rollout sequence and explicit tests.
- The document names the two-host review requirement and what counts as durable evidence.
- The document preserves degraded/local-only boundaries and does not claim Authority Server receipt verification.
