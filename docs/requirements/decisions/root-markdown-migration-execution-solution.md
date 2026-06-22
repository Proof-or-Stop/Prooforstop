# Root Markdown Migration Execution Solution

## Purpose

This decision defines the executable solution for reducing root-level Markdown to a small, intentional set of entrypoints. It does not move, delete, or rewrite root files by itself; it gives future migration stories the order, destinations, checks, and gates needed to do that work safely.

Root Markdown is not a durable home for agent-generated plans or historical execution notes. Anything outside the final allowed set below is a migration or retirement candidate.

## Final Allowed Root Markdown Set

After the migration is complete, the only Markdown files allowed at repository root are:

| File | Root role | Ownership rule |
|---|---|---|
| `README.md` | Human repository entrypoint | Keep root and update in place when the repo landing page changes. |
| `AGENTS.md` | Host-neutral agent instruction entrypoint | Keep root and update in place when project workflow rules change. |
| `CLAUDE.md` | Claude Code entrypoint and filename-contract compatibility asset | Keep root and update in place when Claude-specific entry behavior changes. |
| `CHANGELOG.md` | Release-history artifact | Keep root while releases are still recorded from this path. |
| `jek.md` | User-owned local bootstrap note | Keep root. Agents must not migrate, rewrite, archive, or retire it unless the user explicitly asks. |

`KOALA.md` is not part of the final allowed root set. It is a retirement target and must not remain at root after cleanup.

## Canonical Destinations

| Current root file | Batch | Canonical destination | Final root action |
|---|---|---|---|
| `README.md` | Entry | Root | Keep. |
| `AGENTS.md` | Entry | Root | Keep. |
| `CLAUDE.md` | Entry | Root | Keep. |
| `CHANGELOG.md` | Entry | Root | Keep. |
| `jek.md` | Entry | Root | Keep as user-owned. |
| `KOALA.md` | Retirement | Active operational material goes to `docs/guide.md` or the relevant root entrypoint (`AGENTS.md` / `CLAUDE.md`) if it is truly entrypoint instruction. Historical Koala-only material may be archived under `docs/koala/legacy/root-markdown/KOALA.md` only when retention is needed. | Delete the root file after references are updated. No permanent compatibility stub. |
| `koala-project-overview.md` | Policy merge | `docs/requirements/decisions/project-vision.md` | Merge durable overview content, then delete or replace with a temporary stub only while references are being cut over. |
| `Lattice-baseline.md` | Policy merge | `docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md` | Merge active baseline policy, then delete or temporary-stub. |
| `Lattice-Engineering-baseline.md` | Engineering merge | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge active Layer 2 engineering baseline material, then delete or temporary-stub. |
| `Lattice-Engineering-Baseline-Unlock-Execution-Plan.md` | Engineering merge | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge still-current execution rules, then delete or temporary-stub. |
| `Lattice-Layer2-Proof-Bridge-Execution-Plan.md` | Engineering merge | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Merge still-current bridge rules without duplicating proof claims, then delete or temporary-stub. |
| `Lattice-Loop-Engineering-baseline.md` | Loop merge | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active loop-engineering rules, then delete or temporary-stub. |
| `Lattice-Review-reflection-loop.md` | Loop merge | `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Merge active reflection-loop rules, then delete or temporary-stub. |
| `Lattice-Parallel-Development-Capability.md` | Parallel merge | `docs/requirements/decisions/lattice-parallel-wave.md` | Merge reusable parallel-development policy, then delete or temporary-stub. |
| `Lattice-lifecycle-memory-Evolving.md` | Memory split | `docs/requirements/decisions/dev-memory.md` and `docs/requirements/decisions/lifecycle-artifact-scope.md` | Split durable memory policy from artifact-scope policy, then delete or temporary-stub. |
| `Lattice-Capability-Claim-baseline.md` | Retirement | No active decision destination by default. Archive under `docs/koala/legacy/root-markdown/Lattice-Capability-Claim-baseline.md` only when historical retention is needed. | Delete the root file after references are updated. Do not create or retain a root compatibility copy. |
| `Lattice-Production-Safety-baseline.md` | Retirement | No active decision destination by default. Archive under `docs/koala/legacy/root-markdown/Lattice-Production-Safety-baseline.md` only when historical retention is needed. | Delete the root file after references are updated. Do not create or retain a root compatibility copy. |

## Migration Batches

### Batch 0: Inventory And Freeze

- Confirm the root Markdown inventory.
- Freeze new root Markdown creation except for the final allowed root set.
- Mark every root Markdown file outside the allowed set as migration or retirement work.
- Record any external consumers before changing paths.

### Batch 1: Allowed Entrypoints

- Keep `README.md`, `AGENTS.md`, `CLAUDE.md`, and `CHANGELOG.md` at root.
- Keep `jek.md` at root as user-owned content.
- Do not let agent-generated docs use `jek.md` as a destination or template.

### Batch 2: High-Confidence Policy Merges

- Merge `koala-project-overview.md` into `docs/requirements/decisions/project-vision.md`.
- Merge `Lattice-baseline.md` into `docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md`.
- Merge `Lattice-Parallel-Development-Capability.md` into `docs/requirements/decisions/lattice-parallel-wave.md` only as parallel-development policy, without adding new capability claims.

### Batch 3: Engineering And Loop Merges

- Merge the Layer 2 engineering root files into `docs/requirements/decisions/unlock-layer2-ENG-suite.md`.
- Merge the loop-engineering and reflection-loop root files into `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md`.
- Split lifecycle-memory material between `docs/requirements/decisions/dev-memory.md` and `docs/requirements/decisions/lifecycle-artifact-scope.md`.

### Batch 4: KOALA.md Retirement

- Classify `KOALA.md` content into active operational instruction, active guide material, and historical Koala-only material.
- Move active instruction only into `AGENTS.md` or `CLAUDE.md` when it is truly entrypoint behavior.
- Move active guide material into `docs/guide.md` or a nearby `docs/guide-*.md` page.
- Archive historical material only if it still has retention value.
- Update every reference to stop pointing at root `KOALA.md`.
- Delete root `KOALA.md` after the reference scan is clean.

### Batch 5: Claim-Sensitive Retirements

- Treat `Lattice-Capability-Claim-baseline.md` and `Lattice-Production-Safety-baseline.md` as retirement candidates, not active truth-source migrations.
- Archive only historical text that must be retained.
- Do not create replacement docs that imply Production Safety readiness, new capability readiness, authority readiness, or unattended readiness.

## Stub And Delete Rules

1. Allowed root files stay in place and are edited directly.
2. Migration candidates may use a temporary root stub only when current references cannot be updated in the same batch.
3. A temporary stub must name the canonical destination, state that the root path is deprecated, and contain no duplicated policy text.
4. Temporary stubs must be removed after the reference-update scan is clean.
5. Retirement targets, including `KOALA.md`, must not become permanent compatibility stubs.
6. If no internal or known external reference still needs the old root path, delete the old root file in the same migration story that finishes the content move or retirement.
7. `jek.md` is user-owned and excluded from agent-driven stub, delete, archive, and migration work unless the user explicitly requests it.

## Reference-Update Checks

Before removing or stubbing a root file, run a repository reference scan for its exact filename and common relative-link forms, excluding banned or generated areas that should not be hand-edited. For example:

```bash
rg -n --glob '!docs/story/**' --glob '!**/tests/fixtures/**' 'KOALA\.md|./KOALA\.md|\(KOALA\.md\)' .
```

For each batch:

- Update Markdown links in root entrypoints, `docs/guide*.md`, `docs/requirements/NAV.md`, and related decision docs.
- Update prose references that tell readers to open the old root file.
- If a generated or lifecycle artifact still names the old path, treat it as evidence for the migration story and use the owning CLI workflow instead of direct file edits.
- Re-run the scan after edits and before delete or stub removal.

## Validation Gates

Each migration story that executes part of this solution must pass these gates before it is considered complete:

1. `git diff --name-only` shows only paths allowed by that story's scope.
2. The root Markdown inventory either matches the final allowed set or the remaining non-allowed files are explicitly listed as pending in the story.
3. Reference scans for moved, stubbed, or retired filenames are clean, except for intentional historical archive references.
4. `docs/requirements/NAV.md` includes every active decision doc added by the batch and its file count matches the decisions list.
5. No migrated text claims Production Safety readiness, new capability readiness, authority readiness, or unattended readiness.
6. If a temporary stub remains, it has a canonical destination and a follow-up deletion condition.
7. The story's required Lattice validation command passes in TEST.

Useful local checks:

```bash
find . -maxdepth 1 -type f -name '*.md' -exec basename {} \; | sort
find docs/requirements/decisions -maxdepth 1 -type f -name '*.md' | wc -l
rg -n --glob '!docs/story/**' --glob '!**/tests/fixtures/**' 'Production Safety|capability|authority|unattended' docs/requirements/decisions docs/guide*.md README.md AGENTS.md CLAUDE.md
```

The last scan is not a failure by itself. Every match must be reviewed to ensure it is historical, bounded, or explicitly no-claim.

## Migration Status

As of story B-7f61, all 12 non-allowed root Markdown files listed in the Canonical Destinations table have been archived to `docs/koala/legacy/root-markdown/`. Root file references in the tables above are now historical lineage. The remaining root Markdown set matches the Final Allowed Root Markdown Set.

## No-Overclaim Boundary

This solution is documentation-only. It does not unlock Production Safety, does not grant new capability, does not assert authority readiness, and does not assert unattended readiness. It only defines where root Markdown content should live and how future stories should verify the migration.
