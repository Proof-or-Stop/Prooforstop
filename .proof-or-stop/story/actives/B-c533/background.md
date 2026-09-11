## Trigger Event

On 2026-09-10, the approved v37 trusted RED-to-GREEN execution plan identified P0m, the registry component-mapping foundation prerequisite, as the first strict runtime gate dependency before ordinary Stories can receive enforceable classifications: redRequired means executable behavior must have a failing baseline RED and matching GREEN; characterizationRequired means behavior-preserving work must prove the same characterization before and after; docsExempt means fresh machine analysis found no executable or material acceptance target, while normal documentation checks and lifecycle still apply.

## Key Insights

Later classification signatures cannot be computed safely by guessing component ownership from producer prose or artifact paths. Both process and runtime fact registries must expose explicit normalized mappings and deterministic component-filtered projections while leaving existing whole-registry digests unchanged.

## Solution Tradeoffs

The P0m implementation will extend existing registry entry types and verification scripts instead of adding a parallel registry. It will fail closed on missing, ambiguous, generated-without-lineage, or non-total mappings, accepting the additional authoring burden to prevent silent evidence attribution and gate bypass.

## Conversational Texture

The operator explicitly required this three-class policy to become a working result, with implementation performed here and independent Claude CLI audits used as review evidence rather than allowing the design document itself to stand in for runtime enforcement.
