# Semantic Story scope budgets

`proof-or-stop scope_budget_check --storyId=B-xxxx --json` reports the configured
scope budget without writing Story metadata or granting approval. Planning review,
all three DEV entry guards, and AcceptanceAmendment application use the same
evaluator. A failed amendment budget check happens before `APPLYING`; recovery
also checks the proposed next acceptance against the original base.

Configure `storyScopeBudget` in `proof-or-stop.config.json` with:

- `schemaVersion: "story-scope-budget.v1"` and `mode: "observe"` or `"enforce"`.
- `limits`: a nonnegative integer for every dimension in the table below.
- `responsibilities`: rows with a stable `id`, repository-relative `paths`
  patterns, `hostAdapters`, and `validationGroups`.
- Optional `validationGroups`: rows with an `id` and `commandLabels` referencing
  configured validation commands. A command's focus label is not a responsibility.

The policy deliberately has no invented universal numeric defaults. Valid projects
without this policy retain the existing lifecycle behavior. Invalid configuration
JSON blocks DEV: the legacy configuration parser's fallback cannot silently erase
an enforced policy. An invalid opted-in policy also fails closed.

| Dimension | Counted units |
| --- | --- |
| `responsibilityDomains` | Distinct explicitly mapped responsibilities touched by scope or checklist paths |
| `hostAdapters` | Distinct mapped adapter identities from the canonical host registry |
| `processFacts` | Registered facts whose declared source/consumer or registered owner module is touched, plus topology fact references |
| `publicCommands` | The subset of those identities registered as public commands |
| `acceptanceTopology` | Bindings, producer/consumer/assertion/mutation/transcript nodes, and producer/consumer edges |
| `devScopeDelta` | New semantic units compared with the amendment base, plus changed/new requirement, intent and binding content |
| `validationGroups` | Explicit groups of registered validation commands associated with touched responsibilities |

For example, 500 files in one mapped responsibility consume one responsibility
unit. Two responsibilities exceed a responsibility limit of one, even when each
contains only one file. Limits are independent; unused allowance in one dimension
does not offset an excess in another.

Paths must be explicit enough to classify. Directory grants, symlink aliases,
unmapped paths, unresolved scope globs,
unknown host or validation identities, and duplicate topology identities produce
an unknown result. Enforced unknown or over-budget results block admission.
Observe mode projects valid policy results without enforcing its numeric limits.

These are conservative declared-impact counts, not claims that every command in a
touched owner module changed. The responsibility map remains reviewed project
policy; the evaluator does not infer architecture from directory count. Other
scope, topology, review and full validation gates remain independently required.

The binding digest includes policy, paths, semantic facts, requirements, topology
and validation configuration. It is a diagnostic identity, not a signed approval.
For known over-budget scope, an operator can run `scope_budget_approve` from an
interactive terminal with `--storyId`, the report's exact `--bindingDigest` and
`--confirmationToken`, `--ack`, and a substantive `--reason`. The tool signs the
journal and each decision; it preserves the configured limits. Approval expires
after seven days and is invalid for changed scope, acceptance or policy. Unknown
scope cannot be approved. Noninteractive and recognized agent sessions are refused;
terminal possession is an acknowledgement channel, not cryptographic human identity.

For a pending DEV amendment, pass its `--amendmentId` to both check and approval.
Obtain scope approval before independent amendment review; the decision does not
replace that review. Read projections never create authority.

Declared decomposition uses existing `milestone_ledger_set`, `slice_plan_set` and
`parent_ledger_rollup_set` artifacts. Create the child Stories through the normal
CLI, assign every parent milestone to exactly one child in all three artifacts,
and link each child's milestone through `parentLedgerId`. Child claim, doneMeans
and required evidence must preserve the assigned parent requirement. Child
checklist intents and structurally valid acceptance bindings must cover that row.
The tools do not infer new child requirements or create child Stories automatically.

For projects with this policy, `scope_budget_check` reads the live decomposition.
It requires at least two real, independently within-budget children, complete
assignment agreement, and non-overlapping declared paths across the entire tree.
Missing children, partial plans, stale artifact hashes, invalid acceptance and
cyclic assignments block enforced admission. Child scope and acceptance changes
change the parent report digest; there is no cached readiness permission.
A parent must narrow its own implementation scope and still meet its own budget.
A ready decomposition never makes an oversized parent eligible for DEV.

The returned `decomposition.authority` is `planning_only`. Candidate ledger rows
can demonstrate a plan; their `planned`, `covered` or `done` labels do not certify
delivery. Each child's ordinary review, validation and DONE gates remain required.
Unconfigured legacy projects retain their existing partial-plan behavior.

`node scripts/verify-story-scope-decomposition.mjs` verifies phantom children,
coverage/assignment errors, independent budgets, parent and recursive subtree
scope conflicts, changed acceptance, digest freshness, read-only projection and
legacy compatibility against isolated real StoryStore artifacts.

Verification: `node scripts/verify-story-scope-budget.mjs` exercises actual DEV
guards, all seven dimensions, unknown inputs, unchanged read projections, actual
additive derivation, and a managed review whose approval is rejected before any
over-budget acceptance write. The existing parallel decomposition integration
smoke checks compatibility of valid projects without the new policy.
