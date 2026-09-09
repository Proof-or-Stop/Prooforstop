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
Large-Story approval and parent/child decomposition decisions are separate work;
until those paths are available, enforced over-budget scope must be narrowed.

Verification: `node scripts/verify-story-scope-budget.mjs` exercises actual DEV
guards, all seven dimensions, unknown inputs, unchanged read projections, actual
additive derivation, and a managed review whose approval is rejected before any
over-budget acceptance write. The existing parallel decomposition integration
smoke checks compatibility of valid projects without the new policy.
