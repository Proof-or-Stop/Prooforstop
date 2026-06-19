# Execution Plan

## CHK-001
Remove the public Lattice CLI Authority bundle generator surface while preserving consumer behavior. Delete or de-scope buildAuthorityTrustProfileBundle and any task/test path that uses it as a reusable generator. Keep filename constants and parsing/resolution code that are needed to consume server-provided authority trust and client env files.

Verification for this item: source search confirms buildAuthorityTrustProfileBundle and senior bundle writer paths are gone; authority config parsing still reads authority_trust.env and referenced client env files; senior bundle generation cannot be triggered from CLI code paths.

## CHK-002
Update public CLI documentation and operator-facing hints to consumer-only wording. Replace local generation language with server/operator-provided handoff files, explicitly covering lattice_authority_trust.env and lattice_staging-client.env for normal developers and senior files only for live runner or strong-evidence flows. Do not document private server generation internals in this public repo.

Verification for this item: docs and CLI messages describe the files as operator/server-provided, normal developer wording does not require PROJECT_ID or GATE_ACTOR variables, and no public docs tell users to generate senior bundles locally.

## CHK-003
Adjust focused CLI tests after removing generation. Convert generator-backed smoke setup into explicit consumer fixtures where needed, keep authority status/client tests passing, and add a search/check to prevent accidental reintroduction of local senior bundle generation.

Verification for this item: focused authority client/status smoke tests pass, the package builds with generation imports removed, and repository search shows no reusable public generator for lattice_senior_* bundle material.
