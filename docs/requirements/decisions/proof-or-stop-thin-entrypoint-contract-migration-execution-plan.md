# Proof-or-stop Thin Entrypoint Contract Migration Execution Plan

## Status

- Status: active implementation plan; migration not yet implemented.
- Scope: migrate the repository from a Claude-first root-document contract to host-neutral thin entrypoints backed by canonical documentation and mechanical registries.
- Product boundary: this plan changes documentation authority, generated assets, discovery, audit, review routing, and verification. It does not change the Story lifecycle, reviewer quorum, evidence admissibility, or DONE semantics.
- Delivery boundary: this document and its navigation entry are the only product changes in story B-c1f1. Every implementation stage below requires its own Story, verification evidence, review, and rollback point.
- Brand and host vocabulary: use `Proof-or-stop`; the three current hosts are Codex CLI, Claude Code CLI, and Antigravity CLI (`agy`). Do not introduce `CODEX.md`, `AGY.md`, or legacy Gemini CLI terminology as new contracts.

## Problem Statement

The repository already intends `AGENTS.md` and `CLAUDE.md` to be small discovery entrypoints, but current runtime and verification code still treats root `CLAUDE.md`—and in some checks root `AGENTS.md`—as a complete process contract. Making the files thin without migrating those consumers breaks audits, docs-drift checks, reviewer prompts, transition hints, and `npm test`. Copying the lifecycle back into both files would restore tests at the cost of preserving the architectural defect.

The migration must therefore change the authority graph and its mechanical consumers before declaring the old contract retired. Moving Markdown alone is insufficient.

## Decisions

### Host discovery matrix

| Host | Automatically discovered root entrypoint | Shared rules | Host-specific assets | Explicit non-contracts |
|---|---|---|---|---|
| Codex CLI | `AGENTS.md` | Reads the shared project constraints and canonical navigation from `AGENTS.md` | `.lattice-codex/` | No `CODEX.md` |
| Claude Code CLI | `CLAUDE.md` | `CLAUDE.md` imports or otherwise delegates shared rules to `AGENTS.md`; it must not copy the shared body | `.claude/agents/`, `.claude/hooks/`, `.claude/settings.json`, and supported Claude profiles | No second full lifecycle contract in `CLAUDE.md` |
| Antigravity CLI (`agy`) | `AGENTS.md` | Uses the same shared project entrypoint as Codex CLI | `.agents/` only when Antigravity-specific material is actually required | No `AGY.md`; do not add `GEMINI.md` without a separately proven compatibility requirement |

`AGENTS.md` is a shared convention entrypoint, not a Codex-only document. `CLAUDE.md` remains because its filename is a Claude Code discovery contract, not because Claude owns the common process contract.

### Target hierarchy and precedence

```text
AGENTS.md
  ├─ repository-local, non-negotiable constraints
  └─ → .lattice/Lattice.md

CLAUDE.md
  ├─ import/delegate → AGENTS.md
  ├─ Claude Code-only adapter information
  └─ → .lattice/Lattice.md

.lattice/Lattice.md
  ├─ host-neutral Proof-or-stop navigation
  ├─ → docs/dev/lattice-agent-runbook.md
  └─ → normative decision documents

docs/dev/lattice-agent-runbook.md
  ├─ operational projection: recovery, standard commands, review order,
  │  TEST-to-DONE convergence, and diagnosis
  └─ → docs/requirements/decisions/*.md

docs/requirements/decisions/*.md
  └─ normative process intent and policy

CLI registries, handlers, and gates
  └─ executable and mechanically consumed runtime facts
```

The existing `.lattice/Lattice.md` path is preserved. It is the one host-neutral navigation entry, but it is not a third copy of lifecycle prose.

When sources disagree, apply this order:

1. Current user and platform instructions govern the active interaction.
2. CLI schemas, registries, handlers, and gates govern executable runtime behavior and admissible evidence.
3. `docs/requirements/decisions/` governs normative process intent.
4. `docs/dev/lattice-agent-runbook.md` is a mechanically checked operational projection of those facts.
5. `.lattice/Lattice.md`, `AGENTS.md`, and `CLAUDE.md` provide discovery, minimum local constraints, and navigation; they do not redefine the detailed process.

A conflict between layers is a drift defect to fix, not permission to select whichever text is convenient.

### Normative facts versus operational projection

The runbook may explain how to resume a session, execute the standard Story flow, order reviewer work, converge TEST to DONE, diagnose a blocker, and invoke common CLI commands. Those instructions are behavior-affecting projections, so they must be checked against the command, lifecycle, reviewer-lane, and DONE-policy registries. The runbook must link to the owning decision for every process section and must state that decision docs and mechanical gates prevail if drift is detected.

Detailed lifecycle, verification, review-assurance, convergence, drift, and ownership facts remain in their existing decision sources, including:

- `docs/requirements/decisions/story-lifecycle.md`
- `docs/requirements/decisions/testing-infra.md`
- `docs/requirements/decisions/done-prepare-automation-execution-plan.md`
- `docs/requirements/decisions/review-assurance-floor-execution-plan.md`
- `docs/requirements/decisions/session-ownership-and-write-leases.md`
- `docs/requirements/decisions/story-files-hash-material-drift.md`

The runbook summarizes operations and links to these sources; it must not become co-equal normative authority.

### Root entrypoint content and budgets

`AGENTS.md` directly retains only the constraints that must be visible before following a link:

- `lattice session_brief` is the first command in a new or resumed session.
- User instructions override repository defaults.
- Story and fixture stores are not edited directly; use the Lattice CLI.
- Work follows the Story lifecycle unless the user explicitly requests an allowed quick path.
- Engineering completion is not the same as user-value completion.
- Ownership, lock, destructive-command, and blind-retry prohibitions that are needed before any action.
- Links to `.lattice/Lattice.md`, the runbook, and the normative documentation index.
- A statement that CLI output and gates are mechanical facts while the root file provides discovery and minimum safety constraints.

`CLAUDE.md` retains only:

- Claude Code discovery and shared-rule import/delegation.
- Claude-specific agent, hook, settings, and profile locations.
- Links to the same host-neutral guide and runbook.
- A statement that shared rules come from `AGENTS.md` and canonical documents.

The following are excluded from both managed root bodies: full CLI references, complete phase chapters, Finding schemas, checklist example collections, DONE drift taxonomies, reviewer/subagent manuals, and historical compatibility essays.

Budgets are anti-regression ceilings, not fill targets:

| Asset | Recommended generated/managed size | Hard ceiling | Hard byte ceiling |
|---|---:|---:|---:|
| `AGENTS.md` managed body | 30–60 lines | 150 lines | 16 KiB |
| `CLAUDE.md` managed body | 10–30 lines | 120 lines | 12 KiB |

Verification must measure the managed body separately from user-owned text. It must also resolve the effective import closure for each host, deduplicate repeated imports, reject cycles, and cap the resolved shared instruction closure at 220 lines and 24 KiB. A short file that imports an unbounded or cyclic body does not satisfy the thin-entrypoint contract.

All local Markdown links in the managed bodies, `.lattice/Lattice.md`, and the runbook must resolve to an existing file and anchor, must not target retired authority, and must not form a navigation/import cycle.

### Repository-local constraints and managed ownership

The OMX prohibition, user-owned bootstrap text, and other repository-local constraints remain outside the Proof-or-stop managed block unless they are separately adopted as universal generated policy. In this repository, the OMX prohibition must remain directly visible in `AGENTS.md`, but generators must not propagate it to unrelated projects.

Managed-asset updates must preserve text before and after `<!-- lattice:start -->` / `<!-- lattice:end -->`. Tests must prove that profile changes, init, check, and repair do not delete, duplicate, or relocate repository-local text. Claude's import/delegation must expose the shared repository-local constraints without copying them into a second managed body.

## Shared Canonical-Document Registry

Create one typed, data-only registry—for example `packages/main/src/core/canonical-agent-docs.ts`—and make all behavior-affecting consumers use it instead of maintaining path arrays independently. A suitable shape is:

```ts
type CanonicalAgentDocRole =
  | 'shared-entrypoint'
  | 'host-entrypoint'
  | 'host-neutral-guide'
  | 'operational-projection'
  | 'normative-process';

interface CanonicalAgentDoc {
  path: string;
  role: CanonicalAgentDocRole;
  hosts: Array<'codex' | 'claude' | 'antigravity'>;
  auditCommands: boolean;
  auditPaths: boolean;
  docsDrift: boolean;
  reviewDiscoverable: boolean;
  required: boolean;
  legacyFallback?: boolean;
}
```

The initial registry contains `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, `docs/dev/lattice-agent-runbook.md`, and the specifically owned decision documents. Selectors such as `docsForMechanicalAudit()`, `docsForReviewDrift()`, `docsForHost(host)`, and `normativeDocsForFact(fact)` return ordered, deduplicated paths. The registry contains no filesystem I/O; callers resolve paths from the repository or git root appropriate to their gate.

The process-fact verifier must use the same exported ownership model or a generated JSON projection of it. It must not keep a second handwritten list that again requires lifecycle vocabulary in root entrypoints.

## Current Consumer Inventory

Before each implementation Story, rerun a repository-wide reference scan for `CLAUDE.md`, `AGENTS.md`, `.lattice/Lattice.md`, canonical document arrays, docs-drift readers, and root-document discovery. Every behavior-affecting hit must be assigned to one of the following slices; comment-only historical references may be updated or explicitly classified as non-behavioral.

### Init, profile, sync, and managed assets

- `packages/main/src/init-assets.ts`: generic and global-thin templates, host wording, guide pointers, and the missing dedicated global-thin Claude shape.
- `packages/main/src/core/managed-assets.ts`: managed markers, drift checks, repair, host profile asset sets, and local-edit review.
- `packages/main/src/claude-md-sync.ts` and `packages/main/src/handlers/workflow.ts`: Claude profile-section mutation and rollback; replace whole-document assumptions with managed host-adapter ownership or retire the special sync path.
- `packages/main/src/cli-init.ts`, `packages/main/src/cli-prompts.ts`, and `packages/main/src/cli/command-catalog.ts`: profile selection, generated-asset descriptions, and help text.
- `packages/main/src/core/codex-adapter-checks.ts`: Codex entrypoint verification must continue to target `AGENTS.md` without treating it as Codex-only prose.
- `packages/main/src/tasks/thin-init-assets-smoke.ts` and `packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts`: generation, preservation, profile transition, and wrapper-root regression coverage.

### Mechanical audit and audit triggering

- `packages/main/src/handlers/audit.ts`: replace the hard-coded root `CLAUDE.md` list and “nothing to audit” result with registry-selected canonical docs.
- `packages/main/src/core/audit-scan.ts`: make diagnostics name the actual source document instead of always saying `CLAUDE.md`; scan registry-selected command/path-bearing docs.
- `packages/main/src/core/audit-trigger.ts`: trigger on changes to the canonical audit set rather than only `CLAUDE.md` and package-local Claude files; keep the trigger bounded and deterministic.
- `packages/main/src/handlers/validate-docs-drift.ts`: preserve its pure comparison behavior while accepting content assembled from registry-selected docs.
- `packages/main/src/tasks/audit-esm-smoke.ts`, `packages/main/src/tasks/docs-drift-path-drift-smoke.ts`, and `packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts`: replace Claude-only fixtures with canonical-set fixtures and preserve git-root behavior.

### Review preflight, prompts, and delivery promises

- `packages/main/src/handlers/review-preflight.ts`: replace the default `CLAUDE.md` reader with a registry-backed, git-root-relative canonical reader; preserve dependency injection and fail-closed missing-required-doc behavior.
- `packages/main/src/handlers/agent-prompt.ts` and `packages/main/src/handlers/story-dispatch.ts`: pass bounded document candidates and roles to reviewers instead of implying one giant root contract.
- `packages/main/templates/agents/lattice-review-story-init.md`: stop requiring a complete read of root `CLAUDE.md`; require the thin entrypoint, relevant runbook section, and task-owned normative documents.
- `packages/main/templates/agents/lattice-review-docs.md`: search `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, runbook, and task touchpoints through the registry; remove the documentation-only fallback that reads an entire root contract.
- `packages/main/templates/agents/lattice-review-behavior.md`, `lattice-review-channel.md`, `lattice-review-concept.md`, `lattice-review-quality.md`, and `lattice-review-delivery.md`: generalize “promises in CLAUDE.md / README” to promises in changed or registry-selected canonical docs.
- `packages/main/templates/agents/test-intent.md`: update any root-contract routing language found by the pre-implementation scan.

### Lifecycle hints and user-value guidance

- `packages/main/src/handlers/transition-effects.ts`: point user-value acceptance hints to the owning runbook/decision anchor, not a removed `CLAUDE.md` section.
- `packages/main/src/tasks/flow-stability-smoke.ts` and `packages/main/src/tasks/session-brief-prompt-sync-smoke.ts`: assert the new stable target and exact hint projection.
- Any explanatory references in `packages/main/src/core/background-validator.ts`, `advisory.ts`, `finding-verify.ts`, `review-pass-provenance.ts`, `guard-utils.ts`, and `config.ts` must either link to their actual normative owner or be classified as non-behavioral comments; they must not perpetuate a false root authority.

### Process and entrypoint verification

- `scripts/verify-process-fact-contract.mjs`: remove `AGENTS.md` and `CLAUDE.md` from detailed lifecycle/review/evidence vocabulary sets; verify those facts in their normative owners and verify root non-duplication separately.
- `scripts/verify-entrypoints.mjs`: test host discovery, managed preservation, guide/runbook links, budgets, import closure, link/anchor integrity, no long-form body, and profile transitions.
- `scripts/verify-codex-assets.mjs`: validate the effective Codex instruction closure and Codex adapter commands without requiring shared operational prose to remain copied in `AGENTS.md`.
- `scripts/verify-proof-or-stop-prompt-baseline.mjs`: update prompt overlap expectations and forbid retired Claude-first authority phrases.
- `packages/main/src/tasks/cli-surface-smoke.ts`, `field-regression-cli-smoke.ts`, `cli-argument-ergonomics-smoke.ts`, and other fixtures containing `CLAUDE.md` as generic sample data must be classified: update behavior assertions, but retain neutral filename examples when they are only parser fixtures.

### Auxiliary and runtime discovery

- `packages/main/src/handlers/aux-doc.ts`: discover `.lattice/Lattice.md` and the runbook in addition to root entrypoints; expose roles without claiming every discovered document is normative.
- `packages/main/src/core/runtime-environment-checks.ts`: keep root marker discovery host-neutral and include the canonical guide where appropriate.
- `packages/main/src/core/rollout-check.ts`: stop treating `CLAUDE.md` or retired root `LATTICE.md` as the Lattice guide; recognize `.lattice/Lattice.md` explicitly.
- `packages/main/src/core/cluster-compute.ts`: update common-document assumptions used for project clustering.
- `packages/main/src/core/dirty-worktree.ts`: retain root docs in material/dirty classification where required; thinness does not make them non-material.
- `packages/main/src/handlers/session.ts`, `story-create.ts`, `init-check.ts`, `checklist.ts`, `done-effects.ts`, `recover-evidence.ts`, `artifact-declare.ts`, `finding.ts`, `gap-log.ts`, `story-review.ts`, and `validate-lint.ts`: classify references found by the migration scan and route behavior-affecting document lookup through the registry.

This inventory is a migration baseline, not permission to ignore new hits. Each implementation Story must attach the fresh scan output to its verification evidence and explain any excluded hit.

## Red-Before / Green-After Verification Contract

The first implementation Story adds tests before changing production consumers. The red suite must fail against the current repository for the intended reason, with an artifact recording the failing assertion.

| Area | Red assertion before migration | Green assertion after migration |
|---|---|---|
| Size | Managed `AGENTS.md` exceeds its selected ceiling or a long-form fixture is accepted | Managed bodies meet line and byte ceilings; user-owned text is measured separately |
| Effective host rules | Claude import/delegation and closure are not resolved | Codex and Antigravity resolve `AGENTS.md`; Claude resolves `CLAUDE.md` plus shared `AGENTS.md`, with deduplication |
| Required constraints | Deleting all root prose can still pass a pointer-only check | Effective host closures directly expose session-first, user-priority, no-direct-store-edit, lifecycle, ownership safety, and user-value constraints |
| Links and anchors | A stale local anchor or retired target is accepted | Missing file, missing anchor, retired authority, or import/navigation cycle fails |
| Non-duplication | Root files may contain full lifecycle/Finding/DONE sections | Lifecycle tables, Finding schema bodies, reviewer manuals, CLI encyclopedias, and legacy compatibility chapters fail root checks |
| Audit source | A bad command placed only in the canonical runbook is invisible | `lattice audit --framework` reports the runbook path and bad command |
| Docs drift | Preflight reads only root `CLAUDE.md` | Preflight reads the registry-selected set from the git root and reports missing required sources |
| Process facts | Thin root files fail because detailed terms are absent | Detailed terms are required only in owning decision docs; removing a required fact there fails |
| Review routing | Documentation-only review falls back to reading all of `CLAUDE.md` | Reviewer receives bounded registry candidates plus touchpoints and never mandates a giant root scan |
| Generation | Global-thin templates mislabel `AGENTS.md` as Codex-only or produce an unsuitable Claude copy | Each profile produces exactly the discovery assets for that host and preserves user-owned regions |
| Projection drift | A runbook command, phase, reviewer lane, or DONE step can contradict registries | Projection verifier rejects unknown commands and mismatched lifecycle/reviewer/DONE facts |

The migration suite must include fixtures for stale links, conflicting runbook commands, a failed red-test handoff, partial template migration rollback, and B-e514 remaining in TEST while the old verifier is active.

Minimum green commands after every applicable slice are:

```bash
npm --prefix packages/main run build
node scripts/verify-entrypoints.mjs
node scripts/verify-process-fact-contract.mjs
node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js
npm test
```

Focused audit, docs-drift, init-asset, managed-asset, wrapper-root, prompt-baseline, Codex-adapter, link/anchor, and projection tests must run in the Stories that own those surfaces. Passing a focused subset must not be described as full-suite success.

## Implementation Sequence

Each stage is a separate Story with a focused commit set, fresh review, and a clean rollback. Later Stories depend on earlier green contracts; no stage declares the old contract retired before cutover.

### Story 1 — Contract tests and canonical registry

1. Add the typed canonical-document registry and pure selectors.
2. Add red fixtures for budgets, imports, links/anchors, canonical audit reachability, root non-duplication, and process-fact ownership.
3. Record red evidence against current behavior, then implement only enough registry/validator infrastructure for the new tests to exercise real selectors.
4. Keep existing runtime consumers unchanged.

Rollback: revert the registry and its isolated tests; no generated assets or runtime lookup has changed.

### Story 2 — Canonical guide and operational projection

1. Repair `.lattice/Lattice.md` branding, self-paths, command examples, and authority wording.
2. Add `docs/dev/lattice-agent-runbook.md` with bounded operational sections and links to the owning decisions.
3. Add link/anchor and registry-projection verification.
4. Do not edit the root `AGENTS.md` or `CLAUDE.md`; B-e514 remains their sole owner.

Rollback: revert the guide/runbook and registry entries; root discovery remains on the legacy contract.

### Story 3 — Init, managed assets, and host import closure

1. Update generic and global-thin templates for the host matrix.
2. Implement Claude shared-rule import/delegation and effective-closure validation.
3. Generalize or retire `claude-md-sync.ts` whole-document assumptions while preserving supported profile behavior.
4. Prove managed-block preservation for repository-local constraints.

Compatibility: generated docs point to the new hierarchy, while runtime audit/review consumers still dual-read the legacy root source.

Rollback: revert template/sync changes; previously generated managed blocks remain recognized by compatibility detection.

### Story 4 — Audit, docs-drift, and discovery dual-read

1. Move audit, audit trigger, docs-drift, auxiliary discovery, and runtime/rollout discovery to registry selectors.
2. During dual-read, scan canonical docs first and legacy root `CLAUDE.md` second, deduplicating identical `(path, anchor, symbol, driftType)` results.
3. Emit a structured advisory when the legacy fallback contributes a unique fact, so cutover readiness is observable.
4. Preserve git-root/wrapper-root semantics and existing audit locking.

Rollback: restore the previous consumers; no canonical files or generated assets need deletion.

### Story 5 — Review prompts and lifecycle hints

1. Route preflight and reviewer prompts through bounded canonical candidates plus Story touchpoints.
2. Replace all user-value links and Claude-first promise language with owning runbook/decision anchors.
3. Prove documentation-only review does not fall back to a full root scan.
4. Keep legacy fallback diagnostics active.

Rollback: revert prompt/hint routing; dual-read audit remains safe and the old root contract is still present.

### Story 6 — Verifier ownership cutover

1. Change process-fact verification so detailed lifecycle, review, evidence, and DONE facts are checked only in their canonical normative owners.
2. Enforce root budgets, effective import closure, required constraint reachability, no duplicated long-form sections, and link/anchor integrity in entrypoint verification.
3. Make all behavior-affecting canonical path sets derive from the shared registry or its generated projection.
4. Run the full red-to-green matrix and complete suite.

Cutover condition: all canonical sources and consumers pass without unique facts supplied by the legacy fallback for at least one complete full-suite run at the same HEAD.

Rollback: revert this verifier Story to restore dual acceptance; do not copy old prose back into templates.

### Story 7 — B-e514 root-entrypoint convergence

B-e514 remains the single owner of product edits to root `AGENTS.md` and `CLAUDE.md`. No implementation Story above may edit those two repository-root files, although template fixtures may generate them in temporary directories.

After Stories 1–6 merge to main, the B-e514 owner must:

1. Merge current main into the B-e514 worktree using the lifecycle-supported convergence path.
2. Update its thin files to the final contract: shared constraints and local user region in `AGENTS.md`; Claude import/delegation and Claude-only adapter material in `CLAUDE.md`.
3. Preserve the repository-local OMX prohibition outside the managed block.
4. Re-run entrypoint, process-fact, audit reachability, managed preservation, build, routine validation, DONE-required validation when configured, and the full suite.
5. Refresh all stale review, delivery, and verification evidence indicated by Lattice before DONE.

B-e514 is not silently superseded and its scope is not expanded to code/templates/tests. If it becomes unrecoverable, a human must explicitly discard it and create one replacement root-entrypoint Story; the replacement then becomes the sole owner, and B-e514's commits must not also be merged. Concurrent root-document owners are prohibited.

Rollback before B-e514 DONE: revert only its root-doc commit in its worktree. Rollback after DONE: use a new Story that restores the last known good thin entrypoints; never resurrect the giant contract as an emergency unreviewed edit.

### Story 8 — Legacy fallback retirement

1. Remove dual-read fallback and its compatibility diagnostics only after B-e514 is DONE and a fresh full-suite run proves canonical-only operation.
2. Remove obsolete Claude-only helpers, path arrays, comments, and test fixtures that no longer represent supported behavior.
3. Keep filename compatibility assets and managed-block migration recognition for the documented support window.
4. Record the retirement point and replacement sources in the process-fact and root-document migration documentation.

Rollback: restore only the registry's legacy fallback and diagnostic path. Do not restore duplicated root prose.

## Compatibility and Cutover Rules

Dual-read is mandatory between the first consumer migration and final retirement:

1. Canonical registry paths are authoritative candidates.
2. Legacy root `CLAUDE.md` is a compatibility fallback, never the destination for new facts.
3. Results are deduplicated deterministically and retain source provenance.
4. Missing required canonical docs fail closed once their owning Story declares them required; legacy presence cannot mask a missing required source.
5. A unique legacy fact blocks retirement and identifies the fact that still needs a canonical owner.
6. Entry generators may become thin before fallback retirement only when the canonical set is complete and the same Story proves the consumer still has a valid source.
7. “Old contract retired” may be written only after canonical-only audit, review preflight, verifier, build, and full-suite tests pass at the same HEAD.

## Rollback and Failure Recovery

- A failed red test is evidence, not permission to weaken the assertion. Confirm it fails for the intended legacy behavior before implementation.
- A partial template migration rolls back the template/sync Story while dual-read remains enabled; managed-block preservation prevents loss of local constraints.
- A broken link or conflicting runbook command fails the projection/entrypoint verifier and blocks cutover.
- A canonical audit miss restores or retains legacy fallback until the registry selector and scanner are fixed.
- If B-e514 is still blocked in TEST, do not force DONE and do not move its root edits into another active Story. Complete the prerequisite contract Stories, merge main, refresh evidence, and let its sole owner converge it.
- Rollback commits must preserve audit provenance and must not directly edit Story or fixture stores.
- No rollback may re-label legacy Gemini, `CODEX.md`, or `AGY.md` conventions as supported architecture.

## Final Acceptance

The migration is accepted only when all of the following are true at one reviewed HEAD:

- Codex CLI and Antigravity CLI discover the effective shared constraints through `AGENTS.md`; Claude Code CLI discovers `CLAUDE.md` and resolves the shared `AGENTS.md` rules without a copied common body.
- `.lattice/Lattice.md` is the preserved, unique host-neutral navigation entry and links to the runbook and normative owners.
- Root managed bodies satisfy line, byte, import-closure, required-constraint, link/anchor, and non-duplication checks.
- Repository-local OMX and user-owned constraints survive init, profile change, repair, and managed update without entering universal templates.
- Audit and docs-drift detect an invalid command placed only in the canonical runbook and report the correct source.
- Reviewer routing is bounded by registry roles and Story touchpoints and never mandates reading a giant root contract.
- Detailed process-fact verification succeeds from canonical normative documents and fails if an owned fact is removed there.
- All named focused tests, build, routine Story validation, configured DONE-required validation, and `npm test` pass with fresh evidence.
- B-e514 is either DONE as the sole root-document owner or explicitly discarded and replaced by exactly one human-approved owner; both implementations are never merged.
- Legacy fallback is removed only after canonical-only evidence is green.

This plan does not claim that any implementation Story is complete, that any host has been validated after migration, or that B-e514 is unblocked. Those claims require the execution and evidence described above.
