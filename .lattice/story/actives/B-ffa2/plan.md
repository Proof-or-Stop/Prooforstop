# B-ffa2 Execution Plan: Koala Role IDs to Lattice

## Objective

Rename active Koala subagent/reviewer role identifiers to Lattice identifiers across CLI runtime, prompt templates, mirrored host assets, active documentation, and tests. The migration intentionally targets role IDs such as `koala-implementer` and `koala-review-quality`, not every historical/runtime compatibility token containing `Koala`.

Canonical map:

| Old active role | New canonical role |
|---|---|
| `koala-implementer` | `lattice-implementer` |
| `koala-review-story-init` | `lattice-review-story-init` |
| `koala-review-scope-plan` | `lattice-review-scope-plan` |
| `koala-review-concept` | `lattice-review-concept` |
| `koala-review-quality` | `lattice-review-quality` |
| `koala-review-test-coverage` | `lattice-review-test-coverage` |
| `koala-review-behavior` | `lattice-review-behavior` |
| `koala-review-docs` | `lattice-review-docs` |
| `koala-review-channel` | `lattice-review-channel` |
| `koala-review-delivery` | `lattice-review-delivery` |
| `koala-evaluator` | `lattice-evaluator` |
| `koala-evaluator-cli` | `lattice-evaluator-cli` |

Compatibility boundary:

- Active CLI help, dispatch prompts, template names/frontmatter, generated host assets, and current process-fact reviewer lanes should use `lattice-*`.
- Historical/archive docs may keep Koala wording when they are explicitly legacy material.
- Runtime compatibility names such as `KOALA_*`, `.koala` migration paths, old salts, and old schema strings are only retained when changing them would be a separate compatibility migration.
- Do not run `omx`; do not read/write `.omx`; do not directly edit `docs/story` or `tests/fixtures`.

## CHK-001

Write `docs/requirements/decisions/koala-to-lattice-role-naming-execution-plan.md` before implementation changes.

Steps:

1. Record the inventory categories: templates, mirrored host assets, CLI help/schema, runtime reviewer lanes, process-fact registry, active docs, tests, and historical/runtime compatibility leftovers.
2. Include the canonical role map above.
3. Define what counts as active cleanup versus intentionally retained compatibility/archive text.
4. List verification commands and expected search boundaries.

Acceptance:

- The doc is readable by a future host without conversation context.
- It does not overclaim that all Koala tokens disappear.
- It gives concrete `rg` patterns for active role cleanup.

## CHK-002

Rename canonical agent prompt assets and mirrored host assets.

Steps:

1. Rename `packages/main/templates/agents/koala-*.md` to matching `lattice-*.md` filenames.
2. Rename `.claude/agents/koala-*.md` and `.Codex/agents/koala-*.md` mirrors the same way.
3. Update YAML frontmatter `name`, prompt prose, command examples, and author/example strings inside those files.
4. Leave unrelated agents such as `product-reviewer`, `implementation-reviewer`, `test-intent`, and `test-case-reviewer` untouched.

Acceptance:

- `find packages/main/templates/agents .claude/agents .Codex/agents -maxdepth 1 -type f | rg 'koala-'` finds no active agent filenames.
- `rg '\bkoala-(implementer|review|evaluator)' packages/main/templates/agents .claude/agents .Codex/agents` finds no active role IDs.

## CHK-003

Update runtime contracts and CLI-facing strings.

Steps:

1. Update story dispatch defaults, allowed agent maps, command examples, help descriptions, and commit author fallback to `lattice-*`.
2. Update reviewer lane lists, reviewer prefix checks, process-fact registry entries, init/delivery/scope reviewer requirements, and guard text.
3. Remove active legacy role aliases such as `koala-review-scope` unless a read-only historical metadata path requires explicit handling.
4. Update process/runtime verification scripts where they assert reviewer lanes.

Acceptance:

- `lattice help | rg 'koala-(implementer|review|evaluator)'` returns no active role guidance after rebuild.
- Review/finding/pass helpers use `lattice-review-*` as the reviewer prefix.
- Gate semantics remain intact: only canonical reviewer lanes count as reviewer evidence.

## CHK-004

Update active docs, audits, and tests.

Steps:

1. Update `CLAUDE.md`, `README.md`, and active decisions that teach role IDs.
2. Update tests/smoke tasks that construct reviewer lanes, source agents, expected text, or role-related snapshots.
3. Preserve or label historical/archive references rather than doing a blind rename across all docs.
4. Keep runtime compatibility docs accurate for `.koala`, `KOALA_*`, and legacy migration paths where those are still real.

Acceptance:

- Active docs no longer tell users to invoke `koala-implementer` or `koala-review-*`.
- Tests assert the new `lattice-*` canonical role IDs.
- Remaining Koala references are either non-role compatibility tokens or explicitly historical/archive context.

## CHK-005

Verify the migration.

Commands to run, adjusting if package scripts differ:

```bash
rg -n --hidden --glob '!docs/story/**' --glob '!tests/fixtures/**' --glob '!.omx/**' --glob '!.git/**' --glob '!.worktrees/**' '\bkoala-(implementer|review|evaluator)' packages/main/src packages/main/templates .claude .Codex CLAUDE.md README.md docs/requirements docs/audits scripts bin
lattice help | rg 'koala-(implementer|review|evaluator)'
npm --prefix packages/main run build
npm --prefix packages/main test
node bin/lattice.js verify_codex
lattice validate --story=B-ffa2
```

Expected result:

- Active role-ID searches return empty or only documented historical/compatibility exceptions.
- Build/test/adapter verification pass.
- `lattice validate` writes fresh verification evidence and allows progression toward DONE.
