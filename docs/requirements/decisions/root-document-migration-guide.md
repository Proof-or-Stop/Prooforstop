# Root Document Migration Guide

## Purpose

This guide defines where root-level Markdown documents should live, which root files are allowed to stay in place as host-neutral entrypoints or compatibility assets, and how future migrations should update references without breaking existing links.

Root Markdown should not become a catch-all. New durable docs should default to:

- `docs/requirements/decisions/` for policy, boundary, and decision records.
- `docs/guide.md` or a nearby `docs/guide-*.md` file for operational how-to material.
- `docs/koala/` or a dedicated archive area for historical reports and legacy material that is no longer the active source of truth.

## Current Root Markdown Inventory

This repository currently has 17 root-level Markdown files.

| File | Current role | Classification | Target home | Next action |
|---|---|---|---|---|
| `AGENTS.md` | Agent-facing root instruction entrypoint | Stay root | Root | Keep as a host-neutral entrypoint for Codex, Claude Code, and human operators. Update in place when project workflow changes. |
| `CLAUDE.md` | Claude-facing root instruction entrypoint | Stay root | Root | Keep as a host-neutral entrypoint. Update in place when project workflow changes. |
| `README.md` | Human-facing repository entrypoint | Stay root | Root | Keep as the first landing page for the repo. |
| `CHANGELOG.md` | Human release history | Stay root compatibility asset | Root | Keep while release history is still consumed from the repository root. |
| `KOALA.md` | Legacy Koala-named guide / compatibility asset | Stay root compatibility asset | Root until compatibility retirement | Keep only as long as legacy path compatibility is still required. Prefer canonical replacements elsewhere for new content. |
| `jek.md` | Local bootstrap note | Archive candidate | TBD / do not migrate yet | Leave this note in place until a human classifies the content and chooses one definitive archive target. |
| `koala-project-overview.md` | Duplicate project overview | Move / merge candidate | `docs/requirements/decisions/project-vision.md` | Merge into the canonical overview, then leave only a short compatibility stub if external references still exist. |
| `Lattice-baseline.md` | Legacy baseline policy doc | Move / merge candidate | `docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md` | Merge policy that is still active into the canonical baseline decision; archive duplicated historical text. |
| `Lattice-Capability-Claim-baseline.md` | Legacy capability boundary doc | Move / merge candidate | `docs/requirements/decisions/lattice-capability-claim-boundary.md` | Future-only and no-claim: convert only the still-valid claim boundary into a reviewed decision if and when that separate decision is approved. |
| `Lattice-Engineering-baseline.md` | Legacy engineering baseline doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge active Layer 2 engineering baseline material into the existing Layer 2 decision. |
| `Lattice-Engineering-Baseline-Unlock-Execution-Plan.md` | Legacy execution plan doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Fold durable execution-plan details into the Layer 2 decision; mark superseded evidence inside that decision when needed. |
| `Lattice-Layer2-Proof-Bridge-Execution-Plan.md` | Legacy execution plan doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge only the bridge rules that remain current; do not duplicate Layer 2 proof claims. |
| `Lattice-Loop-Engineering-baseline.md` | Legacy loop-engineering doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active Loop Engineering baseline material into the Layer 3 decision. |
| `Lattice-Parallel-Development-Capability.md` | Legacy parallel-development capability doc | Move / merge candidate | `docs/requirements/decisions/lattice-parallel-wave.md` | Merge reusable parallel-development policy into the existing parallel-wave decision. |
| `Lattice-Production-Safety-baseline.md` | Legacy production-safety baseline doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer4-production-safety-suite.md` | Future-only and no-unlock: move only in a dedicated Production Safety story after the reviewed decision exists. |
| `Lattice-Review-reflection-loop.md` | Legacy review-loop doc | Move / merge candidate | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active reflection-loop rules into the Layer 3 truth source. |
| `Lattice-lifecycle-memory-Evolving.md` | Legacy lifecycle-memory doc | Move / merge candidate | `docs/requirements/decisions/dev-memory.md` | Split durable memory policy from runtime artifact scope before moving. |

## What Should Stay Root

Only root files that satisfy one of these conditions should remain at the repository root:

1. They are a host-neutral entrypoint for humans or agents.
2. They are a compatibility asset whose filename is still part of an established contract.
3. They are a release-history or bootstrap artifact that existing tooling already treats as root-owned.

In practice, that means `AGENTS.md`, `CLAUDE.md`, and `README.md` stay root by default for Codex, Claude Code, and human entry. `CHANGELOG.md` and `KOALA.md` may stay root while compatibility needs remain real. Anything else should be treated as a migration candidate, not a new permanent root doc.

## Non-Markdown Root File Audit

The root should also avoid one-off helper scripts, crash dumps, and local runtime state. These are not decision records and should not remain beside the main entrypoints.

| File or directory | Current role | Target home | Next action |
|---|---|---|---|
| `.gitignore` | Repository-level git behavior | Root | Keep. This is a repository control file. |
| `lattice.config.json` | Project-level Lattice config | Root | Keep. This is the canonical project config. |
| `package.json` / `package-lock.json` | Node package metadata | Root | Keep. This is normal for the workspace package manager. |
| `claude-session.mjs` | Local Claude CLI helper wrapper | `scripts/dev/claude-session.mjs` if still used; otherwise archive/remove after checking `packages/main/src/providers/claude-cli.ts` covers the use case | Do not leave as a permanent root helper. Migrate only in a dedicated script-cleanup story because references still exist in metadata. |
| `du.exe.stackdump` | Local crash dump | Delete from tracked source; optional local-only retention under `.lattice/artifacts/legacy-crash/` | Treat as accidental source pollution, not a Lattice asset. |
| `.DS_Store` | macOS Finder metadata | Nowhere | Delete locally when found; `.gitignore` already excludes it. |
| `.omx/` | Legacy/plugin runtime state | Nowhere for active Lattice assets; historical migrated material belongs under `.lattice/artifacts/legacy-omx/` | Delete local runtime residue. Do not write new Lattice assets here. |
| `.lattice/dev-memory/experience.jsonl` | Lattice dev-memory advisory state | `.lattice/dev-memory/` | Keep under `.lattice`; this is not root pollution and is non-authoritative. |

## Migration Order

Use a staged order so references stay valid throughout the cutover:

1. Identify the canonical destination before moving content.
2. Update inbound references to point at the canonical destination.
3. Move or merge the smallest duplicate or lowest-risk docs first.
4. Keep a root compatibility stub only when external references still need the old path.
5. Remove the root stub only after the reference scan is clean.

Recommended file order:

1. `koala-project-overview.md`
2. `jek.md`
3. The `Lattice-*.md` files, in dependency order from broad policy to narrower execution notes:
   - `Lattice-baseline.md`
   - `Lattice-Capability-Claim-baseline.md`
   - `Lattice-Production-Safety-baseline.md`
   - `Lattice-Engineering-baseline.md`
   - `Lattice-Loop-Engineering-baseline.md`
   - `Lattice-Parallel-Development-Capability.md`
   - `Lattice-Engineering-Baseline-Unlock-Execution-Plan.md`
   - `Lattice-Layer2-Proof-Bridge-Execution-Plan.md`
   - `Lattice-Review-reflection-loop.md`
   - `Lattice-lifecycle-memory-Evolving.md`

That order keeps the most reusable policy text available while the more specific operational notes are rewritten or archived.

## Compatibility And Redirect Strategy

When a root doc still has external consumers, do not delete it first. Keep a compatibility stub at the original path until the cutover is complete.

The stub should do only three things:

- Name the canonical destination.
- State that the old path is deprecated or compatibility-only.
- Avoid reintroducing old content that can drift away from the canonical copy.

If the old path is only a filename contract and the canonical doc is already in place, the root file may become a minimal pointer. If the old path is no longer needed at all, archive it after the final inbound reference is moved.

## Reference-Update Rules

1. Update links before moving files when the old path is still referenced.
2. Update every inbound reference in the same migration set: root docs, `docs/requirements/NAV.md`, related guides, and any code or prompt text that names the file directly.
3. Preserve the meaning of the document while changing its location. A move is not an excuse to rewrite scope.
4. Do not create new root Markdown files unless they are entrypoints or compatibility assets.
5. If a filename is part of a contract, update the contract consumers at the same time as the document move.
6. Prefer one canonical destination per topic. Duplicate content should be merged, not forked.

## NAV Update Requirement

`docs/requirements/NAV.md` should be updated alongside each decision-guide change:

- update the file count to match the decisions list;
- add a link to `decisions/root-document-migration-guide.md` under the decisions list for this story.

## Scope Boundary Audit

- No bulk move happened in this story.
- No root Markdown file was renamed, moved, or deleted in this story.
- This guide does not unlock Production Safety.
- This guide does not assert unattended readiness or authority readiness.
- This guide does not claim any new global capability.
- This guide is documentation-only and does not change code, runtime behavior, or story/fixture artifacts.
