## Trigger Event
On 2026-06-24, convergence_check still reported five high proof-admissibility gaps after B-0405 merged M2-M7, specifically supportedSchemaVersion, verifierVersionSupported, contractVersionSupported, unsupported_schema_version, and unsupported_contract_version.

## Key Insights
The schema and contract gaps appear mostly implemented but not mapped into the convergence scanner, while verifierVersionSupported appears to be a partial implementation where the value is recorded and bound but not explicitly allowlisted as supported.

## Solution Tradeoffs
Keep this story narrow: close only the five high gaps with the smallest correctness and mapping changes, avoiding Authority Server semantic cleanup or unrelated admissibility refactors until the local contract is stable.

## Conversational Texture
The user wants the high-gap noise eliminated before the larger Authority production receipt demotion, because otherwise later cleanup work may hide whether the local admissibility contract is truly closed.
