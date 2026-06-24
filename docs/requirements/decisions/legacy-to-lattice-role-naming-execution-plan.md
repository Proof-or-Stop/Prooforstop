# Legacy-to-Lattice Role Naming Execution Plan

## Goal

Rename active Legacy role identifiers to Proofbound role identifiers across the
agent, reviewer, runtime, and documentation surfaces that teach or consume
role IDs. While doing that cleanup, also rename active user-visible verifier
dirty-gate vocabulary plus generated managed-block markers that would otherwise
keep teaching Proofbound as the current product surface. This is not a global
removal of every historical `Lattice` or `lattice` token.

This file is the handoff document for story `B-ffa2`. It intentionally contains
the old role IDs as the canonical rename map; post-migration searches should
exclude this file or treat it as the documented exception.

## Inventory Categories

Clean up these active categories:

- Agent templates: `packages/main/templates/agents/lattice-*.md`, frontmatter
  `name`, prompt body, examples, author strings, and prompt-registry tests.
- Generated managed-block markers: active templates and mirrored assets should
  emit `<!-- lattice:start -->` / `<!-- lattice:end -->` while the parser
  continues accepting legacy `lattice` markers for existing projects.
- Mirrored host assets: materialized `.claude/agents/lattice-*.md` and
  `.lattice-codex/agents/lattice-*.md` full-mode mirrors when present.
- CLI dispatch/help/schema: `lattice dispatch` defaults, `agentType` examples,
  allowed role lists, help text, command descriptions, and commit author
  fallback for normal-channel implementer work.
- Runtime reviewer lanes: `review_run_start`, `finding_add`,
  `review_pass_set`, reviewer prefix checks, reviewer opt-in lists, delivery
  and init reviewer IDs, and pass-only finding normalization.
- Process-fact and lifecycle registries: reviewer-lane facts, signed artifact
  producer names, required semantic facts, and contract verification scripts.
- Active docs and audits: `CLAUDE.md`, `README.md`,
  `docs/requirements/decisions/**/*.md`, and current audit docs that still
  instruct operators to invoke `lattice-*` role IDs.
- Tests and smoke tasks: source-agent fixtures, reviewer lane assertions,
  prompt registry expectations, Codex/Claude asset checks, flow and gate smokes,
  and CLI text expectations.
- Active validation surfaces: dirty-gate category text should use
  `lattice_metadata_changes`, verifier provider/log names should use
  `lattice-verifier-*`, new managed docs should use `lattice:start/end`, and
  canonical config docs/tests should teach `lattice.config.json` as the only
  active project config.
- Historical/runtime compatibility leftovers: archived docs, `.lattice` runtime
  paths, `LATTICE_*` environment variables, old hash salts, and migration
  compatibility notes. These are classified, not blindly renamed.

## Canonical Rename Map

| Old active role ID | New canonical role ID |
|---|---|
| `lattice-implementer` | `lattice-implementer` |
| `lattice-review-story-init` | `lattice-review-story-init` |
| `lattice-review-scope-plan` | `lattice-review-scope-plan` |
| `lattice-review-concept` | `lattice-review-concept` |
| `lattice-review-quality` | `lattice-review-quality` |
| `lattice-review-test-coverage` | `lattice-review-test-coverage` |
| `lattice-review-behavior` | `lattice-review-behavior` |
| `lattice-review-docs` | `lattice-review-docs` |
| `lattice-review-channel` | `lattice-review-channel` |
| `lattice-review-delivery` | `lattice-review-delivery` |
| `lattice-evaluator` | `lattice-evaluator` |
| `lattice-evaluator-cli` | `lattice-evaluator-cli` |

`lattice-review-channel` is already retired as an LLM reviewer, but any active
template, help text, test expectation, or registry row that still names it as a
role ID should move to `lattice-review-channel` or be removed if the active
surface now belongs to the CLI `validate --channel` gate.

## Active vs Legacy Boundary

Active cleanup targets are surfaces that a current host, reviewer, command, or
operator can copy, invoke, or treat as process evidence. They should use only
the `lattice-*` role IDs after this migration.

Legacy or compatibility text may keep Proofbound wording only when it is clearly not
teaching active role invocation:

- archived material under `docs/lattice/**` and legacy root-markdown copies;
- historical audit tables that describe prior template byte sizes or old runs;
- compatibility explanations for old stories, old phase names, or old aliases;
- runtime compatibility paths and variables that are still real on disk or in
  user environments.

When a remaining Proofbound reference is kept, the surrounding prose should make the
reason clear: historical archive, runtime compatibility, or old data migration.
Do not leave an unlabelled active instruction such as "spawn
`lattice-review-quality`" in current docs or prompts.

## Explicit Non-Goals

- Do not rename `LATTICE_*` environment variables in this story. Variables such as
  `LATTICE_AGENT`, `LATTICE_ROLE`, `LATTICE_REVIEWER_READONLY`,
  `LATTICE_ACTIVITY_SOURCE`, `LATTICE_AUTHORITY_MODE`, and related compatibility
  envs remain runtime compatibility contracts unless a later story explicitly
  migrates them.
- Do not rename `.lattice/` runtime directories, locks, dispatches, activity logs,
  audit config, traces, or artifact registry entries as part of the role-ID
  rename. `.lattice` path migration is a separate storage/runtime compatibility
  project.
- Do not rewrite archive docs simply to erase the word Proofbound. Archive material
  should remain truthful and may be labelled legacy where needed.
- Do not re-enable `lattice.config.json` as an active config fallback. Current
  active config behavior is Lattice-only: `lattice.config.json` is canonical and
  legacy config files are ignored by the active loader.
- Do not change hash salts or signed artifact domains solely because a salt
  contains `lattice`, unless the corresponding verifier and migration path are
  deliberately updated in the runtime contract work.
- Do not remove legacy managed-block parsing for existing `lattice:start/end`
  sections. New generated assets should use `lattice:start/end`; old projects
  should remain readable and safely upgradeable.
- Do not touch `docs/story/**` or `tests/fixtures/**` directly. Story and
  fixture changes must go through Proofbound commands when needed.

## Rollout by Checklist

### CHK-001 - execution document

Create this decision doc first. It must provide the inventory, rename map,
boundary, rollout, verification commands, and non-goals before implementation
changes begin.

### CHK-002 - templates and mirrored host assets

Rename prompt asset filenames and frontmatter from `legacy-*` to `lattice-*` in
the package templates and any materialized `.claude` / `.lattice-codex` full-mode
mirrors. Update prompt prose, examples, author strings, and registry tests in
the same pass. Leave unrelated roles such as `product-reviewer`,
`implementation-reviewer`, `test-intent`, and `test-case-reviewer` unchanged.

### CHK-003 - runtime contracts and CLI strings

Update dispatch defaults, allowed `agentType` values, reviewer lane resolution,
reviewer prefix checks, process-fact registry rows, handler/gate text, and
command help/schema examples. Runtime gates should count `lattice-review-*` as
canonical reviewer evidence. Remove active `lattice-review-*` aliases unless a
specific read-only legacy migration path requires explicit normalization.

### CHK-004 - active docs, audits, and tests

Update active docs and tests that still teach or assert Proofbound role IDs or active
Lattice-branded validation vocabulary. Preserve or label historical/archive
references instead of performing a blind repository rename. Keep runtime
compatibility docs accurate for `LATTICE_*`, `.lattice`, old signed salts, and old
data migration paths.

### CHK-005 - verification and final validation

Run focused searches first, then build/test/runtime verifiers. Any remaining
`lattice-*` role-ID, `lattice_metadata`, or `lattice-verifier` hit must be either
fixed or documented as a legacy/archive/signed-artifact exception.

## Verification Commands

Inventory before and after the migration:

```bash
rg -n --hidden \
  --glob '!docs/story/**' \
  --glob '!tests/fixtures/**' \
  --glob '!.git/**' \
  --glob '!.worktrees/**' \
  '\blattice-(implementer|review|evaluator)' \
  packages/main/src packages/main/templates .claude .lattice-codex \
  CLAUDE.md README.md docs/requirements docs/audits scripts bin
```

Post-cleanup active-surface search, excluding this execution plan and archive
trees:

```bash
rg -n --hidden \
  --glob '!docs/story/**' \
  --glob '!tests/fixtures/**' \
  --glob '!.git/**' \
  --glob '!.worktrees/**' \
  --glob '!docs/lattice/**' \
  --glob '!docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md' \
  '\blattice-(implementer|review|evaluator)|lattice_metadata|lattice-verifier' \
  packages/main/src packages/main/templates .claude .lattice-codex \
  CLAUDE.md README.md docs/requirements docs/audits scripts bin
```

Prompt asset filename check:

```bash
find packages/main/templates/agents .claude/agents .lattice-codex/agents \
  -maxdepth 1 -type f | rg 'lattice-(implementer|review|evaluator)'
```

CLI-facing role guidance check:

```bash
lattice help | rg 'lattice-(implementer|review|evaluator)'
```

Runtime and regression checks:

```bash
npm --prefix packages/main run build
npm --prefix packages/main test
node bin/lattice.js verify_codex
lattice validate --story=B-ffa2
```

Expected results:

- Active role-ID searches return no hits outside this plan or explicitly
  labelled legacy/archive/compatibility text.
- CLI help no longer suggests `lattice-*` role IDs.
- Build, tests, Codex adapter verification, and `lattice validate` pass with
  fresh evidence for `B-ffa2`.
