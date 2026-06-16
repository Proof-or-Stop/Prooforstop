# Lattice Runtime-Owned Agent Assets Execution Plan

Date: 2026-06-15

## Purpose

This document defines the execution plan for moving Lattice agent prompt assets
to a runtime-owned model.

The principle is:

```text
Lattice agent templates belong to the local Lattice CLI runtime, not to each
business project.
```

Offline execution still uses the local installed Lattice CLI package. It does
not require copying all templates, or even thin prompt config, into every
project.

This plan is intentionally narrow:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic.

## Current State

B-bfb5 reduced the prompt cost of the package-owned agent templates by replacing
large repeated guide snapshots with a compact load-bearing prompt slice.

Confirmed local result:

```text
10 package templates:
  baseline: 632,687 B (~158,172 tok)
  after:    115,317 B (~28,830 tok)
  delta:   -517,370 B (~129,343 tok)
```

The current local global `lattice` binary points at:

```text
/Users/jek/Documents/Work/Orchestrate/packages/main/dist/cli.js
```

Therefore the CLI code and package prompt registry are available to any project
that invokes this local global Lattice CLI.

However, older projects may already contain materialized prompt assets such as:

```text
.claude/agents/*.md
.lattice-codex/agents/*.md
.lattice-codex/lattice.json
.lattice/lattice.json with assetMode prompt settings
```

Those files are project-owned copies. They do not automatically become
runtime-owned just because the global CLI was rebuilt.

## Problem Statement

Project-local agent prompt copies cause three real correctness and cost issues.

### 1. Stale Prompt Copies

If a project has materialized `.claude/agents/*.md` or `.lattice-codex/agents/*.md`, the
host may read those files instead of the current package registry. That can
reintroduce:

- old large prompt snapshots;
- stale flow facts;
- stale Authority boundary wording;
- mismatched Claude/Codex prompt mirrors.

### 2. Configuration Drift

If every project needs a thin prompt config to say "use global-thin", then the
default is not truly runtime-owned. Projects can drift just by carrying old
asset-mode config.

### 3. False Offline Assumption

"Offline" should mean:

```text
the local Lattice CLI package is installed and can render prompts locally
```

It should not mean:

```text
copy all prompt templates into every business project
```

Project-local copies are only justified for explicit pinning, debugging, or a
deliberate full-asset mode.

## Target Model

### Default Behavior

By default, a Lattice project should not need project-local prompt assets.

Expected default:

```text
business project
  lattice.config.json          project structure and story/runtime config
  AGENTS.md / requirements     project instructions and source of truth
  .lattice/story/...           story metadata

local Lattice CLI runtime
  prompt registry
  agent templates
  host adapter defaults
```

No default requirement for:

```text
.claude/agents/*.md
.lattice-codex/agents/*.md
.lattice-codex/lattice.json
.lattice/lattice.json only to say assetMode=global-thin
```

### Explicit Exceptions

Project-local assets remain allowed only when explicitly requested.

| Mode | Meaning | Requirement |
| --- | --- | --- |
| runtime-owned default | Use prompt registry from local Lattice CLI. | No project prompt assets. |
| pinned-runtime | Use a specific installed local Lattice CLI version/path. | Explicit config with reason. |
| full-asset mode | Materialize prompt files into the project. | Explicit flag, warning, and drift checks. |
| debug override | Temporary local prompt override. | Explicit file rule and clear expiry. |

Full-asset mode is a compatibility/debug mode, not the default.

## Host-Neutral Authority Boundary

This plan supports both:

- Lattice CLI local Non-authority execution;
- Lattice Authority Server receipt-backed execution.

But the asset ownership model must not blur authority boundaries.

Local runtime-owned prompt rendering can prove:

- the local CLI rendered the prompt from its package registry;
- prompt mirrors, if intentionally materialized, match the registry;
- local tests and local reviewers passed.

It cannot prove:

- `receiptVerified=true`;
- `productionDone=true`;
- `authorityDone=true`;
- `fullAuthorityDone=true`.

Authority completion may only be claimed after an explicit Authority Server
receipt is submitted and verified.

## Required Capability

Add a mechanical "agent asset resolution" contract.

Suggested shape:

```ts
interface AgentAssetResolution {
  schemaVersion: 'lattice.agent_asset_resolution.v1';
  projectRoot: string;
  runtimeCliPath: string;
  runtimePackageRoot: string;
  promptRegistryHash: string;
  mode:
    | 'runtime-owned'
    | 'pinned-runtime'
    | 'full-asset'
    | 'debug-override';
  projectPromptAssets: Array<{
    path: string;
    status: 'absent' | 'matches-runtime' | 'stale' | 'override';
    expectedHash?: string;
    actualHash?: string;
  }>;
  blockingIssues: string[];
  warnings: string[];
}
```

This contract should be consumed by doctor/verify commands and by any host
adapter that needs to decide where prompt text comes from.

## Implementation Phases

### Phase 1. Inventory Existing Asset Resolution

Read and document the current behavior in:

```text
packages/main/src/core/prompt-registry.ts
packages/main/src/core/managed-assets.ts
packages/main/src/core/codex-adapter-checks.ts
packages/main/src/cli-init.ts
packages/main/src/handlers/codex-adapter.ts
```

Questions to answer mechanically:

- When does Lattice read package registry prompts?
- When does Lattice materialize `.claude/agents`?
- When does Lattice materialize `.lattice-codex/agents`?
- Which config file forces `global-thin` today?
- Which commands currently write prompt assets?
- Which commands merely inspect prompt assets?

Deliverable:

```text
Agent asset resolution inventory table
```

No behavior change in this phase.

### Phase 2. Make Runtime-Owned The Default

Change default prompt resolution so that absence of project-local prompt asset
config means:

```text
use local Lattice CLI package prompt registry
```

Do not require `.lattice/lattice.json` or `.lattice-codex/lattice.json` solely to say
`assetMode=global-thin`.

Project config remains valid for project structure facts such as:

```text
scanRoot
rootDir
storyDir
requirementsDir
worktreeDir
```

Those are project facts, not prompt asset ownership facts.

Acceptance:

- A project with no `.claude/agents`, no `.lattice-codex/agents`, and no prompt asset
  config still runs Lattice host/reviewer commands through the runtime registry.
- `lattice doctor` or the relevant adapter doctor reports
  `mode=runtime-owned`.

### Phase 3. Detect Stale Project-Local Agent Assets

Extend existing doctor/adapter checks before adding a new command.

Preferred surfaces:

```text
lattice doctor
lattice codex_doctor
lattice verify_codex
lattice lattice_config_doctor
```

Only add a new command if the existing surfaces cannot express the result
clearly.

Detection rules:

- If `.claude/agents/*.md` exists and the project is not explicitly in
  full-asset/debug mode, warn or fail with a clear migration path.
- If `.lattice-codex/agents/*.md` exists and the project is not explicitly in
  full-asset/debug mode, warn or fail with a clear migration path.
- If project-local prompt assets exist but hashes differ from the runtime
  registry, report `stale`.
- If project-local prompt assets match the runtime registry but runtime-owned
  mode is intended, report them as removable duplication.

Acceptance:

- Existing projects do not silently keep using stale prompt assets.
- The command output distinguishes:
  - stale local prompt copy;
  - intentionally pinned full-asset mode;
  - intentional debug override;
  - clean runtime-owned mode.

### Phase 4. Add Explicit Migration / Repair

Migration must be explicit. Do not auto-delete project files during normal
commands.

Candidate command:

```text
lattice lattice_config_repair --agent-assets=runtime-owned
```

If existing command flags are preferred, add the smallest clear flag to the
existing repair surface.

Migration behavior:

1. Inspect project-local prompt assets.
2. Print the exact files that would be removed or ignored.
3. Require explicit confirmation for deletion.
4. Preserve unrelated project config.
5. Leave a short machine-readable resolution record only if needed for audit.

Deletion candidates:

```text
.claude/agents/*.md
.lattice-codex/agents/*.md
.lattice-codex/lattice.json when it only expresses runtime-owned default
.lattice/lattice.json prompt asset fields when they only express runtime-owned default
```

Files that must not be removed by this migration:

```text
lattice.config.json
AGENTS.md
CLAUDE.md if it is project guidance rather than a generated prompt snapshot
requirements / docs / story metadata
host hooks that are real runtime policy, unless separately audited
```

Acceptance:

- Running repair on a stale full-copy project can migrate it to runtime-owned
  mode without losing project structure configuration.
- Running repair on an already runtime-owned project is idempotent.
- Repair output is explicit enough for review and audit.

### Phase 5. Preserve Full-Asset Mode As Explicit Compatibility

Do not delete full-asset support outright.

Full-asset mode remains useful for:

- debugging host prompt rendering;
- intentionally pinning a project to a snapshot;
- environments where a host requires files on disk and cannot call the runtime
  registry directly.

But it must require an explicit action such as:

```text
lattice init --asset-mode=full
lattice lattice_config_repair --agent-assets=full
```

Full-asset mode output must say:

```text
This project now carries local prompt assets. They can drift from the runtime
registry. Run verify/doctor after Lattice CLI upgrades.
```

Acceptance:

- Full-asset mode still works when explicitly requested.
- It is no longer the accidental default.

### Phase 6. Update Host Adapter Verification

Host adapters should report prompt source in a host-neutral way.

Examples:

```text
Claude prompt source: runtime registry
Codex prompt source: runtime registry
Project prompt assets: absent
Runtime registry hash: <hash>
Authority status: localNonAuthorityAudit
```

If a host needs a file path for compatibility, the adapter should materialize
bounded temporary runtime files outside the business project or use an explicit
debug/full-asset path. Do not write long-lived prompt templates into the
business project by default.

Acceptance:

- `verify_codex` still passes without `.lattice-codex/agents/*.md`.
- Claude/Codex adapters can explain where prompts were resolved from.
- The report does not claim Authority Server completion.

### Phase 7. Tests And Smokes

Add or extend smokes to cover:

```text
runtime-owned project with no project prompt assets
stale project-local .claude/agents detection
stale project-local .lattice-codex/agents detection
explicit full-asset mode remains supported
repair migration is idempotent
verify_codex passes in runtime-owned mode
prompt-token-cost-smoke still passes
prompt-registry-smoke still passes
```

Recommended test files:

```text
packages/main/src/tasks/thin-init-assets-smoke.ts
packages/main/src/tasks/codex-registry-mode-smoke.ts
packages/main/src/tasks/prompt-registry-smoke.ts
packages/main/src/tasks/prompt-token-cost-smoke.ts
packages/main/src/tasks/flow-stability-smoke.ts
```

Only modify `flow-stability-smoke.ts` if the behavior under test is directly
affected. Do not expand this story into unrelated flow-stability classifier
work.

## Migration Strategy For Existing Projects

### Step 1. Inspect

From each project root:

```bash
lattice doctor
lattice codex_doctor
lattice verify_codex --json
```

Expected clean result:

```text
agentAssetMode: runtime-owned
projectPromptAssets: absent
promptRegistryHash: <current runtime hash>
```

### Step 2. Classify Existing Assets

If local assets are found, classify:

| Finding | Action |
| --- | --- |
| stale generated prompt copy | migrate to runtime-owned |
| matching generated prompt copy | remove duplication or leave only with explicit full-asset mode |
| intentional project guidance | keep; do not classify as generated prompt asset |
| host hook / policy file | keep unless separately audited |

### Step 3. Repair

Use an explicit repair command once implemented:

```bash
lattice lattice_config_repair --agent-assets=runtime-owned
```

Until that exists, do not manually delete assets in bulk unless a human has
reviewed the file list. Stale prompt files can affect host behavior, so removal
is a correctness-sensitive migration.

### Step 4. Verify

```bash
lattice verify_codex --json
lattice doctor
lattice session_brief
```

For a project with active stories, also run the project-specific validation
before advancing any lifecycle phase.

## Acceptance Criteria

The capability is complete only when all of these are true:

- New projects do not receive project-local agent prompt templates by default.
- New projects do not need thin prompt config solely to use runtime-owned
  prompts.
- Existing projects with stale prompt assets are mechanically detected.
- Migration to runtime-owned mode is explicit, reviewable, and idempotent.
- Full-asset mode still works when explicitly requested.
- Claude and Codex host adapters report prompt source consistently.
- Local CLI evidence remains local Non-authority evidence.
- Authority Server claims remain receipt-backed only.
- B-bfb5 prompt token savings are preserved by `prompt-token-cost-smoke`.
- Default `story_get` / `checklist_get` compatibility remains unchanged.

## Non-Goals

- Do not remove project structure config such as `lattice.config.json`.
- Do not remove legitimate project guidance such as `AGENTS.md`.
- Do not auto-delete project files during ordinary Lattice commands.
- Do not introduce network dependency for offline prompt rendering.
- Do not make local prompt registry verification imply Authority completion.
- Do not optimize unrelated Lattice flows merely because they appear nearby.

## Review Plan

Before implementation is marked DONE:

- For low-risk implementation, run at least one two-host audit round.
- For high-risk asset-resolution, host-adapter, lifecycle, or Authority-boundary
  changes, run three rounds of two-host audit:
  - Claude CLI host.
  - Codex CLI host.
  - Each round checks only real correctness issues.
  - Each round enforces:
    - do not optimize for optimization;
    - do not optimize arbitrarily;
    - only fix real correctness issues;
    - follow consistency of logic.

Results must separate:

```text
localNonAuthorityAudit
authorityServerPath
```

DONE may only claim Authority completion when receipt-backed Authority Server
proof is actually verified.

## Claude CLI Host Audit Record

Date: 2026-06-15

Reviewer host:

```text
Claude CLI 2.1.88
```

Command shape:

```bash
claude --print --permission-mode plan --tools Read,Glob,Grep \
  --add-dir /Users/jek/Documents/Work/Orchestrate
```

Audit criteria:

- host-neutral Lattice design;
- local Non-authority and Authority Server path separation;
- do not optimize for optimization;
- do not optimize arbitrarily;
- only identify real correctness issues;
- follow consistency of logic;
- verify that runtime-owned agent templates, no default project-local full
  templates, no default thin prompt config, offline local CLI rendering, and
  explicit full-asset/pinned/debug exceptions are expressed correctly.

Result:

```text
PASS
```

Findings:

```text
No real correctness issues identified.
```

Authority statement:

```text
This is localNonAuthorityAudit only. It is not Authority Server
receipt-backed proof and does not set receiptVerified, authorityDone,
productionDone, or fullAuthorityDone.
```

## Recommended Story Split

This should not be implemented as one large arbitrary refactor.

Suggested stories:

1. **Asset resolution inventory and doctor projection**
   - Read-only diagnosis.
   - No repair/delete behavior.

2. **Runtime-owned default for new projects**
   - New init/default behavior.
   - No migration of existing projects.

3. **Explicit repair for stale generated prompt assets**
   - Reviewable migration path.
   - Idempotent repair.

4. **Host adapter verification alignment**
   - Codex/Claude prompt source reporting.
   - Full-asset compatibility checks.

Each story must carry its own verificationIntent and should avoid broad
template/adapter rewrites outside its declared scope.
