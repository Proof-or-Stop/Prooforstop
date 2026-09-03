# Legacy-to-Proof-or-Stop Role Naming Execution Plan

## Goal

Rename active Lattice-branded role identifiers to Proof-or-Stop role identifiers across the
agent, reviewer, runtime, and documentation surfaces that teach or consume
role IDs. While doing that cleanup, also rename active user-visible verifier
dirty-gate vocabulary plus generated managed-block markers that would otherwise
keep teaching the retired identity as the current product surface. This is not a global
removal of every historical `Lattice` or `lattice` token.

This file is the handoff document for story `B-ffa2`. It intentionally contains
the old role IDs as the canonical rename map; post-migration searches should
exclude this file or treat it as the documented exception.

## Inventory Categories

Clean up these active categories:

- Agent templates: retired `packages/main/templates/agents/lattice-*.md` inputs and canonical `proof-or-stop-*.md` outputs, frontmatter
  `name`, prompt body, examples, author strings, and prompt-registry tests.
- Generated managed-block markers: active templates and mirrored assets should
  emit `<!-- proof-or-stop:start -->` / `<!-- proof-or-stop:end -->` while the parser
  continues accepting legacy `lattice` markers for existing projects.
- Mirrored host assets: retired materialized `.claude/agents/lattice-*.md` and
  `.proof-or-stop-codex/agents/lattice-*.md` inputs must become canonical `proof-or-stop-*.md` full-mode mirrors when present.
- CLI dispatch/help/schema: `proof-or-stop dispatch` defaults, `agentType` examples,
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
  `proof_or_stop_metadata_changes`, verifier provider/log names should use
  `proof-or-stop-verifier-*`, new managed docs should use `proof-or-stop:start/end`, and
  canonical config docs/tests should teach `proof-or-stop.config.json` as the only
  active project config.
- Historical/runtime compatibility leftovers: archived docs, retired `.lattice` runtime
  paths, `LATTICE_*` environment variables, old hash salts, and migration
  compatibility notes. These are classified, not blindly renamed.

## Canonical Rename Map

| Old active role ID | New canonical role ID |
|---|---|
| `lattice-implementer` | `proof-or-stop-implementer` |
| `lattice-review-story-init` | `proof-or-stop-review-story-init` |
| `lattice-review-scope-plan` | `proof-or-stop-review-scope-plan` |
| `lattice-review-concept` | `proof-or-stop-review-concept` |
| `lattice-review-quality` | `proof-or-stop-review-quality` |
| `lattice-review-test-coverage` | `proof-or-stop-review-test-coverage` |
| `lattice-review-behavior` | `proof-or-stop-review-behavior` |
| `lattice-review-docs` | `proof-or-stop-review-docs` |
| `lattice-review-channel` | `proof-or-stop-review-channel` |
| `lattice-review-delivery` | `proof-or-stop-review-delivery` |
| `lattice-evaluator` | `proof-or-stop-evaluator` |
| `lattice-evaluator-cli` | `proof-or-stop-evaluator-cli` |

`lattice-review-channel` is already retired as an LLM reviewer, but any active
template, help text, test expectation, or registry row that still names it as a
role ID should move to `proof-or-stop-review-channel` or be removed if the active
surface now belongs to the CLI `validate --channel` gate.

## Active vs Legacy Boundary

Active cleanup targets are surfaces that a current host, reviewer, command, or
operator can copy, invoke, or treat as process evidence. They should use only
the `proof-or-stop-*` role IDs after this migration.

Legacy or compatibility text may keep Lattice-branded wording only when it is clearly not
teaching active role invocation:

- archived material under `docs/lattice/**` and legacy root-markdown copies;
- historical audit tables that describe prior template byte sizes or old runs;
- compatibility explanations for old stories, old phase names, or old aliases;
- runtime compatibility paths and variables that are still real on disk or in
  user environments.

When a remaining Lattice-name reference is kept, the surrounding prose should make the
reason clear: historical archive, runtime compatibility, or old data migration.
Do not leave an unlabelled retired-role invocation in current docs or prompts.
A current instruction such as "spawn `proof-or-stop-review-quality`" is canonical
and must remain valid.

## Explicit Non-Goals

- Historical plan constraint: the older story did not rename the then-current `LATTICE_*` environment variables. Variables such as
  `LATTICE_AGENT`, `LATTICE_ROLE`, `LATTICE_REVIEWER_READONLY`,
  `LATTICE_ACTIVITY_SOURCE`, `LATTICE_AUTHORITY_MODE`, and related compatibility
  envs remain runtime compatibility contracts unless a later story explicitly
  migrates them.
- Historical compatibility inputs may still mention retired `.lattice/` runtime directories, locks, dispatches, activity logs,
  audit config, traces, or artifact registry entries as part of the role-ID
  rename. Active instructions and outputs use `.proof-or-stop`; `.lattice` input migration is a separate storage/runtime compatibility
  project.
- Do not rewrite archive docs simply to erase the word Lattice. Archive material
  should remain truthful and may be labelled legacy where needed.
- Do not re-enable retired `lattice.config.json` as an active config fallback. Current
  active config behavior is Proof-or-Stop-only: `proof-or-stop.config.json` is canonical and
  legacy config files are ignored by the active loader.
- Do not change hash salts or signed artifact domains solely because a salt
  contains `lattice`, unless the corresponding verifier and migration path are
  deliberately updated in the runtime contract work.
- Do not remove legacy managed-block parsing for existing `lattice:start/end`
  sections. New generated assets should use `proof-or-stop:start/end`; old projects
  should remain readable and safely upgradeable.
- Do not touch `docs/story/**` or `tests/fixtures/**` directly. Story and
  fixture changes must go through Proof-or-Stop commands when needed.

## Rollout by Checklist

### CHK-001 - execution document

Create this decision doc first. It must provide the inventory, rename map,
boundary, rollout, verification commands, and non-goals before implementation
changes begin.

### CHK-002 - templates and mirrored host assets

Story B-ffa2 historically renamed prompt asset filenames and frontmatter from
`legacy-*` to the then-current `lattice-*` identities. Preserve that migration
record, but treat those outputs as retired inputs to the later Proof-or-Stop
cutover. Current package templates and materialized `.claude` /
`.proof-or-stop-codex` full-mode mirrors use canonical `proof-or-stop-*`
filenames, frontmatter, prompt prose, examples, author strings, and registry
expectations. Leave unrelated roles such as `product-reviewer`,
`implementation-reviewer`, `test-intent`, and `test-case-reviewer` unchanged.

### CHK-003 - runtime contracts and CLI strings

Update dispatch defaults, allowed `agentType` values, reviewer lane resolution,
reviewer prefix checks, process-fact registry rows, handler/gate text, and
command help/schema examples. Runtime gates should count `proof-or-stop-review-*` as
canonical reviewer evidence. Remove aliases keyed by the old-role column in the
rename map unless a specific read-only legacy migration path requires explicit
normalization. Never remove or reject canonical `proof-or-stop-review-*` IDs,
including `proof-or-stop-review-story-init`.

### CHK-004 - active docs, audits, and tests

Update active docs and tests that still teach or assert Lattice-branded role IDs or active
Lattice-branded validation vocabulary. Preserve or label historical/archive
references instead of performing a blind repository rename. Keep runtime
compatibility docs accurate for `LATTICE_*`, `.proof-or-stop`, old signed salts, and old
data migration paths.

### CHK-005 - verification and final validation

Run focused searches first, then build/test/runtime verifiers. Any remaining
retired `lattice-*` role-ID hit must be either fixed or documented as a
legacy/archive/signed-artifact exception. Canonical `proof-or-stop-review-*`,
`proof_or_stop_metadata_changes`, and `proof-or-stop-verifier-*` hits are expected
positive evidence and must not be classified as residue.

## Verification Commands

Inventory before and after the migration:

```bash
rg -n --hidden \
  --glob '!docs/story/**' \
  --glob '!tests/fixtures/**' \
  --glob '!.git/**' \
  --glob '!.worktrees/**' \
  '\blattice-(implementer|review|evaluator)' \
  packages/main/src packages/main/templates .claude .proof-or-stop-codex \
  CLAUDE.md README.md docs/requirements scripts bin
```

Post-cleanup retired-role search, excluding this execution plan and archive
trees:

```bash
rg -n --hidden \
  --glob '!docs/story/**' \
  --glob '!tests/fixtures/**' \
  --glob '!.git/**' \
  --glob '!.worktrees/**' \
  --glob '!docs/lattice/**' \
  --glob '!docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md' \
  '\blattice-(implementer|review|evaluator)' \
  packages/main/src packages/main/templates .claude .proof-or-stop-codex \
  CLAUDE.md README.md docs/requirements scripts bin
```

Canonical-identity positive search (these hits are required, not residue):

```bash
rg -n --hidden \
  --glob '!docs/story/**' \
  --glob '!tests/fixtures/**' \
  --glob '!.git/**' \
  --glob '!.worktrees/**' \
  '\bproof-or-stop-review-(story-init|scope-plan|concept|quality|test-coverage|behavior|docs|channel|delivery|topology-critic)\b|proof_or_stop_metadata_changes|proof-or-stop-verifier-' \
  packages/main/src packages/main/templates .claude .proof-or-stop-codex \
  CLAUDE.md README.md docs/requirements scripts bin
```

The raw retired-role search is an inventory and may print exact historical,
migration-input, or signature-salt rows. The authoritative active-surface result
comes from the context-aware classifier and must be empty:

```bash
node scripts/verify-proof-or-stop-identity-cutover.mjs --print-residue
```

Prompt asset filename check:

```bash
find packages/main/templates/agents .claude/agents .proof-or-stop-codex/agents \
  -maxdepth 1 -type f | rg 'lattice-(implementer|review|evaluator)'
```

CLI-facing role guidance check:

```bash
proof-or-stop help | rg 'lattice-(implementer|review|evaluator)'
```

Runtime and regression checks:

```bash
npm --prefix packages/main run build
npm --prefix packages/main test
node bin/proof-or-stop.js verify_codex
proof-or-stop validate --story=B-ffa2
```

Expected results:

- The retired-role inventory contains only exact labelled
  legacy/archive/compatibility or signature rows, and the context-aware residue
  command prints `[]`.
- The canonical-identity search returns the active reviewer set including
  `proof-or-stop-review-story-init`, plus the canonical metadata category and
  verifier identifiers; those positive hits are never reported as residue.
- CLI help no longer suggests `lattice-*` role IDs.
- Build, tests, Codex adapter verification, and `proof-or-stop validate` pass with
  fresh evidence for `B-ffa2`.
