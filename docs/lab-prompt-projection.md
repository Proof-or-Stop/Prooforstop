# Shared prompt projection

`core/prompt-registry.ts` owns `projectPromptAsset`: role classification,
historical reconstruction, host transformation, reviewer bootstrap selection and
the live critic purpose contract. Existing `renderPromptEntryForHost` remains a
compatibility facade over the same projection, so materializers and adapter
comparison continue to use the shared implementation.

The projection distinguishes the configured runtime role mode from the installed
host asset mode. Managed comparison can select a runtime body while checking the
default installed bootstrap. Combining those two modes would silently invalidate
existing host identities. Fields are computed only when requested, and memoized
within one projection; inspecting a contract does not reconstruct an unrelated
legacy asset.

The role contract registry owns rollout admission and evidence eligibility. It
consumes projected bodies and host assets; it does not reconstruct them. The
agent prompt handler likewise delegates host rendering without a role branch.
The contract scanner rejects duplicated selection logic at those boundaries.

Existing eighteen-role baselines retain their exact host and body contracts.
Tests check externally visible markers and materialization against these frozen
baselines rather than rebuilding the complex-role expected renderer. This local
Lab change is not a Story completion or a release receipt.

The compatibility smokes exercise the real full-asset generator in a temporary
project for both hosts. They do not mistake unused repository-local copies for
newly generated assets. Historical reconstruction retains its immutable runtime
digest guard and rejects mutated semantic bytes. Current complete reviewer bodies
use the existing independent whole-body approval pins; retired prefix-only test
pins are not a separate authority to rewrite those approved bodies.

Global shims and the independent DEV acceptance reviewer use the same typed
projection entry point. Global installation deliberately gives every modular
reviewer a runtime-selection bootstrap; installed project assets retain their
existing active-rollout rule. The DEV reviewer keeps its own schema, execution
profile and signature boundary. Host syntax transforms trusted instructions
before exact acceptance JSON is appended, so task data is never rewritten.

The AST contract scans all production TypeScript consumers, including aliases
and namespace calls. It preserves the named rollout-admission and task-context
safety policies, which classify roles for authorization rather than rendering.
Mutation controls introduce direct, aliased, namespace and roster-based copies
and require their rejection.
