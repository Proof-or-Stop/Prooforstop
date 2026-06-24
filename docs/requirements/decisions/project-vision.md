# Project Vision and Positioning

## Core Positioning

Proofbound CLI (packages/main) is a **host-neutral, general-purpose project development orchestration CLI**. Its goal is to deliver a complete loop from requirements to code:

```
truth (source of truth for requirements) → story (execution plan) → code (development) → extract (extraction and verification) → gap (gap analysis) → converge (convergence decision)
```

## Design Principles

- **CLI / MCP tool driven**: All project management operations are performed through Proofbound commands or MCP tools. The AI executes the workflow through structured entry points rather than documentation conventions.
- **Active entry point**: `lattice` is the 0.3.5 active product entry. Runtime checks, wrappers, generated assets, and docs do not accept `lattice` as an active compatibility alias.
- **Structured comments as metadata**: The `@task`/`@flow`/`@test` comments in the code are living documentation of project status, and can be scanned and validated by tools.
- **Separation of the source of truth**: Requirement decisions (docs/requirements/decisions/) are separated from execution plans (Story) to avoid circular dependencies.
- **CLI-first host migration**: Mac App provider/config dashboard functionality is expressed through CLI surfaces such as `host_*`, `lattice_config_doctor`, `rollout_check`, `authority_status`, and `conduit_*`; the Mac App retains only an optional/dashboard/archive role.
- **Host Overflow manual-first**: Proofbound Host Overflow treats Claude Code / Codex and the like as execution hosts; Proofbound continues to hold story, scope, receipt, and merge authority. `host_status`, `handoff_*`, and `host_dispatch` can only project readiness / handoff / receipt / worktree information; they cannot auto-trust, auto-merge, or claim `productionDone`.
- **Rollout can inspect but not overstep**: `lattice rollout_check` is a read-only scan of project version, wrapper/realpath, managed assets, runtime footprint, git/story status, and transcript lifecycle readiness; it does not perform apply/upgrade/repair/fix, does not submit evidence, does not verify receipts, and does not promote a local PASS to production authority.
- **Refresh is auditable**: After a local or global CLI refresh, `lattice --version`, `lattice check`, `lattice doctor --format=json`, and `lattice rollout_check` verify the active runtime and generated assets.

## Tech Stack

- TypeScript + Node.js
- xstate (state machine managing the Story lifecycle)
- MCP Server (Claude Code integration)
- Claude Code Skills (user interaction layer)

## Constraints

- Story file operations must go through MCP tools; reading or writing the JSON directly is prohibited.
- The source of truth is Markdown files, which are not converted to JSON; they are scanned and extracted from the .md in real time on every pass.
