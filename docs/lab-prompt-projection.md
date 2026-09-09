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
