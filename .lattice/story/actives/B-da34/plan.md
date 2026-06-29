# B-da34 Plan — Physical removal of Authority Server vocabulary and code surfaces

Original intent: complete all five milestones with no discount until DONE. This plan is not allowed to shrink to active-semantics retirement. DONE must prove all five CHK sections below with command evidence.

## CHK-001

M1 freeze Authority vocabulary migration contract.

Implementation steps:
- Add a migration/retirement decision doc that defines banned active terms, replacement terms, active-surface scope, legacy whitelist scope, and scanner ownership.
- The contract must name Authority Server, authorityDone, fullAuthorityDone, productionDone, and LATTICE_AUTHORITY_* as banned active vocabulary.
- It must define replacement terms: local assurance, admissibilityStatus, assuranceLevel, evidenceScope, local review quorum, signed/offline receipt bundle.

Verification:
- New scanner reads or references this contract.
- `rg` confirms the contract exists and includes banned/replacement terms.

## CHK-002

M2 clean user-facing Authority wording.

Implementation steps:
- Update README, docs/guide, active agent prompts/templates, CLI help/catalog descriptions, and DONE/user-facing output text.
- Replace no-overclaim phrasing such as productionDone=false with local assurance/admissibility wording where the user sees it.
- Leave only explicitly whitelisted retired legacy docs/sections with historical context.

Verification:
- Scanner includes README/docs/prompts/templates/help output.
- `lattice help` output must pass active vocabulary scan.

## CHK-003

M3 remove Authority command surface from active CLI.

Implementation steps:
- Remove active authority_* command exposure from registry/help/config.
- If compatibility remains, it must be hidden legacy/quarantined and excluded from normal help/catalog.
- Rename active story/host surfaces that use authority vocabulary where feasible, or quarantine as legacy alias with local wording.

Verification:
- Command catalog/help smoke proves no active authority_* command surface.
- Validation config no longer runs server-backed authority smokes.

## CHK-004

M4 remove or quarantine server-backed Authority code and smokes.

Implementation steps:
- Trace imports for authority client/runner/receipt-gate/server-backed modules and smoke tests.
- Delete unused server-backed modules/smokes or move them behind a legacy quarantine with scanner whitelist and no active registry imports.
- Preserve local quorum_submit, proof-admissibility, receipt-bundle, delivery-check, and local lifecycle gates.

Verification:
- Build passes.
- Local proof/admissibility/quorum/receipt-bundle smokes pass.
- Scanner proves server-backed authority modules are absent from active runtime paths or quarantined.

## CHK-005

M5 add hard retired-Authority scanner gate.

Implementation steps:
- Add a scanner/smoke task that scans active code, active docs, prompts, generated help/catalog text, and validation config.
- Fail on Authority Server, authorityDone, fullAuthorityDone, productionDone, LATTICE_AUTHORITY_*, and active authority_* command exposure unless the match is in explicit legacy whitelist/migration tests.
- Add scanner to `lattice.config.json` validate.commands so DONE cannot pass with drift.

Verification:
- Scanner fails on injected positive-control samples and passes current tree.
- `npm --prefix packages/main run build` passes.
- `lattice validate --story=B-da34 --json` passes before DONE.
