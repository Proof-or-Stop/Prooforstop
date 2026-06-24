# Root Document Migration Guide

## Purpose

This guide defines where root-level Markdown documents should live, which root files are allowed to stay in place as host-neutral entrypoints, compatibility assets, release history, or user-owned bootstrap notes, and how future migrations should update references without breaking existing links.

Root Markdown should not become a catch-all. New durable docs, especially agent-generated plans and execution notes, should default to:

- `docs/requirements/decisions/` for policy, boundary, and decision records.
- `docs/guide.md` or a nearby `docs/guide-*.md` file for operational how-to material.
- `docs/lattice/` or a dedicated archive area for historical reports and legacy material that is no longer the active source of truth.

## Root Markdown Cleanup Inventory

Before story B-7f61 executed the cleanup, this repository had 17 root-level Markdown files. After B-7f61, the repository root has 5 Markdown files: `README.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, and `jek.md`. The table below is retained as cleanup lineage for the files that were kept, migrated, or archived.

| File | Current role | Classification | Target home | Next action |
|---|---|---|---|---|
| `AGENTS.md` | Agent-facing root instruction entrypoint | Stay root | Root | Keep as a host-neutral entrypoint for Codex, Claude Code, and human operators. Update in place when project workflow changes. |
| `CLAUDE.md` | Claude-facing root instruction entrypoint | Stay root host-specific compatibility asset | Root | Keep as a Claude Code-specific root entrypoint and compatibility asset by filename contract. Update in place when project workflow changes. |
| `README.md` | Human-facing repository entrypoint | Stay root | Root | Keep as the first landing page for the repo. |
| `CHANGELOG.md` | Human release history | Stay root compatibility asset | Root | Keep while release history is still consumed from the repository root. |
| `LATTICE.md` | Legacy Lattice-named guide | Retirement target | Active guide material to `docs/guide.md` or `docs/guide-*.md`; historical material to `docs/lattice/legacy/root-markdown/LATTICE.md` only if retention is needed | Retire the root path. Do not keep it at root. Update references, then delete or use only a temporary migration stub. |
| `jek.md` | User-owned local bootstrap note | Stay root | Root | Keep in place as user-owned content. Agents must not migrate, rewrite, archive, or retire it unless the user explicitly asks. |
| `lattice-project-overview.md` | Duplicate project overview | Move / merge candidate | `docs/requirements/decisions/project-vision.md` | Merge into the canonical overview, then leave only a short compatibility stub if external references still exist. |
| `Lattice-baseline.md` | Legacy baseline policy doc | Move / merge candidate | `docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md` | Merge policy that is still active into the canonical baseline decision; archive duplicated historical text. |
| `Lattice-Capability-Claim-baseline.md` | Legacy capability boundary doc | Retirement / archive candidate | `docs/lattice/legacy/root-markdown/Lattice-Capability-Claim-baseline.md` only if historical retention is needed | Do not keep root compatibility. Do not create an active replacement that claims capability readiness. |
| `Lattice-Engineering-baseline.md` | Legacy engineering baseline doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge active Layer 2 engineering baseline material into the existing Layer 2 decision. |
| `Lattice-Engineering-Baseline-Unlock-Execution-Plan.md` | Legacy execution plan doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Fold durable execution-plan details into the Layer 2 decision; mark superseded evidence inside that decision when needed. |
| `Lattice-Layer2-Proof-Bridge-Execution-Plan.md` | Legacy execution plan doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge only the bridge rules that remain current; do not duplicate Layer 2 proof claims. |
| `Lattice-Loop-Engineering-baseline.md` | Legacy loop-engineering doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active Loop Engineering baseline material into the Layer 3 decision. |
| `Lattice-Parallel-Development-Capability.md` | Legacy parallel-development capability doc | Move / merge candidate | `docs/requirements/decisions/lattice-parallel-wave.md` | Merge reusable parallel-development policy into the existing parallel-wave decision. |
| `Lattice-Production-Safety-baseline.md` | Legacy production-safety baseline doc | Retirement / archive candidate | `docs/lattice/legacy/root-markdown/Lattice-Production-Safety-baseline.md` only if historical retention is needed | Do not keep root compatibility. Do not create an active replacement that claims Production Safety readiness. |
| `Lattice-Review-reflection-loop.md` | Legacy review-loop doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active reflection-loop rules into the Layer 3 truth source. |
| `Lattice-lifecycle-memory-Evolving.md` | Legacy lifecycle-memory doc | Move / merge candidate | `docs/requirements/decisions/dev-memory.md` and `docs/requirements/decisions/lifecycle-artifact-scope.md` | Split durable memory policy from runtime artifact scope before moving. |

## What Should Stay Root

Only root files that satisfy one of these conditions should remain at the repository root:

1. They are a host-neutral entrypoint for humans or agents.
2. They are a compatibility asset whose filename is still part of an established contract.
3. They are a release-history or bootstrap artifact that existing tooling already treats as root-owned.
4. They are explicitly user-owned local bootstrap notes.

In practice, the final allowed root Markdown set is `README.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, and `jek.md`. `LATTICE.md` is a retirement target and must not remain at root after cleanup. Anything else should be treated as a migration or retirement candidate, not a new permanent root doc.

## Migration Order

Use a staged order so references stay valid throughout the cutover:

1. Identify the canonical destination before moving content.
2. Update inbound references to point at the canonical destination.
3. Move or merge the smallest duplicate or lowest-risk docs first.
4. Keep a root compatibility stub only when external references still need the old path.
5. Remove the root stub only after the reference scan is clean.

Recommended file order:

1. `lattice-project-overview.md`
2. The `Lattice-*.md` files with classified target homes, in dependency order from broad policy to narrower execution notes:
   - `Lattice-baseline.md`
   - `Lattice-Engineering-baseline.md`
   - `Lattice-Loop-Engineering-baseline.md`
   - `Lattice-Parallel-Development-Capability.md`
   - `Lattice-Engineering-Baseline-Unlock-Execution-Plan.md`
   - `Lattice-Layer2-Proof-Bridge-Execution-Plan.md`
   - `Lattice-Review-reflection-loop.md`
   - `Lattice-lifecycle-memory-Evolving.md`
3. The retirement targets:
   - `LATTICE.md`
   - `Lattice-Capability-Claim-baseline.md`
   - `Lattice-Production-Safety-baseline.md`

That order keeps the most reusable policy text available while the more specific operational notes are rewritten or archived.

Excluded from the executable migration order unless the user explicitly asks:

- `jek.md`

## Compatibility And Redirect Strategy

When a root doc still has external consumers, do not delete it first. Keep a compatibility stub at the original path until the cutover is complete.

The stub should do only three things:

- Name the canonical destination.
- State that the old path is deprecated or compatibility-only.
- Avoid reintroducing old content that can drift away from the canonical copy.

If the old path is only a filename contract and the canonical doc is already in place, the root file may become a minimal pointer only when the file is part of the final allowed root set. If the old path is a migration or retirement target, remove the temporary stub after the final inbound reference is moved.

## Reference-Update Rules

1. Update links before moving files when the old path is still referenced.
2. Update every Markdown documentation reference in the same migration set: root docs, `docs/requirements/NAV.md`, and related guides that name the file directly.
3. Preserve the meaning of the document while changing its location. A move is not an excuse to rewrite scope.
4. Do not create new root Markdown files unless they are entrypoints or compatibility assets.
5. If a filename is part of a contract, update the contract consumers at the same time as the document move.
6. Prefer one canonical destination per topic. Duplicate content should be merged, not forked.
7. Treat agent-generated root Markdown outside the final allowed set as migration or retirement candidates.

## NAV Update Requirement

`docs/requirements/NAV.md` should be kept in sync alongside decision-guide changes:

- update the file count to match the decisions list;
- add, move, or remove decision links when decision guides are added, moved, or retired.

## Migration Status

As of story B-7f61, all 12 non-allowed root Markdown files have been archived to `docs/lattice/legacy/root-markdown/`. The remaining root Markdown set is: `README.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `jek.md`. File references in the inventory table above are now historical lineage only.

## Scope Boundary Audit

- Root Markdown cleanup was executed in story B-7f61.
- All 12 migration/retirement candidates were moved to `docs/lattice/legacy/root-markdown/`.
- This guide does not unlock Production Safety.
- This guide does not assert unattended readiness or authority readiness.
- This guide does not claim any new global capability.
- This guide is documentation-only and does not change code, runtime behavior, or story/fixture artifacts.
