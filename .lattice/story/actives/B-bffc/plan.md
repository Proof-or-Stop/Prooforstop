# Lattice CLI 0.3.5 Mac App Migration Plan

## Goal

Ship Lattice CLI 0.3.5 as the primary product surface while keeping the existing koala command as a compatibility alias. Move the useful Mac App concepts into CLI-first, host-neutral commands: provider visibility, config diagnostics, authority receipt boundaries, and conduit semantics. The Mac App becomes optional/archive/dashboard only; it is not required for the release path.

## Product Boundaries

- Lattice CLI is the user-facing name for the workflow/state substrate in 0.3.5.
- Existing package identity can remain compatible for this release; the lattice bin is first-class and koala remains a legacy alias.
- Lattice Conduit is a thin conduit/status/event-capture concept, not an autonomous coding host, model runner, or production authority.
- Production DONE still requires Server Authority receipts. Local CLI status, transport acceptance, handoff packs, and conduit status cannot manufacture receipts.
- Third-party hosts such as Codex, Claude Code, and Gemini remain the coding runners. Lattice CLI coordinates state, handoff, evidence, and authority boundaries.

## Eight Milestones

1. Product identity: bump release metadata to 0.3.5, expose Lattice CLI wording, and make version/help cold-readable.
2. Entrypoint compatibility: add a repo-local lattice wrapper and package bin while preserving koala as a legacy alias.
3. Host provider surface: expose host list/probe/install guidance from the CLI so users do not need a Mac provider dashboard.
4. Config migration surface: expose Lattice/Koala config compatibility and environment diagnostics in CLI form.
5. Authority receipt boundary: expose receipt-aware status that clearly separates local transport from verified Server Authority receipts.
6. Conduit semantics: expose conduit explain/status commands that position Lattice Conduit as a thin non-runner conduit.
7. Documentation migration: update README and decision docs so Mac App is optional/archive, and Lattice CLI + Server Authority receipts is the main path.
8. Verification: add focused smoke coverage, run build/smoke tests, record verification evidence, and keep scope protected.

## CHK-001

Ship Lattice CLI 0.3.5 product identity and entrypoint.

Implementation steps:
- Keep existing package names for compatibility but bump root and core package versions to 0.3.5.
- Add a first-class lattice bin mapping and repo-local bin/lattice.js wrapper.
- Make help/version/bootstrap failure text recognize the invoked product name while keeping koala compatibility.
- Add a shared brand helper if needed so code and tests do not duplicate product/version strings.

Validation:
- Happy: lattice version/help displays Lattice CLI 0.3.5 and the lattice entrypoint exists.
- Edge: koala remains callable as a compatibility alias and existing commands are still listed.
- Adversarial: bootstrap/help text must not tell users that koala-only Mac App setup is required.

## CHK-002

Expose Mac App provider/config capabilities through CLI surfaces.

Implementation steps:
- Add host provider metadata for Codex, Claude Code, Gemini, Lattice Conduit, and Server Authority.
- Add host list/probe/install-guidance commands with JSON and text output.
- Add config doctor/migration status command that recognizes LATTICE_* as primary and KOALA_* as legacy compatibility.
- Keep provider installation guidance dry-run/suggestive; do not make CLI install third-party hosts implicitly.

Validation:
- Happy: host list/probe and config doctor show CLI-visible provider/config status.
- Edge: missing providers degrade visibly instead of failing the whole command.
- Adversarial: host install guidance must not execute package installs unless explicitly designed and verified in a later story.

## CHK-003

Define receipt-aware authority and conduit semantics without creating a new agent host.

Implementation steps:
- Add authority status output that points to policy discovery and verified receipts as the authoritative layer.
- Add conduit explain/status output that labels Lattice Conduit as thin, non-runner, and non-authoritative.
- Reuse existing authority and capability primitives instead of introducing a new execution plane.
- Keep local CLI accepted/transport status distinct from receipt-backed production authority.

Validation:
- Happy: authority/conduit commands expose status with productionDone=false unless verified receipt evidence exists.
- Edge: missing authority URL still returns guidance and does not overclaim receipt verification.
- Adversarial: output must explicitly deny that local CLI JSON, conduit status, or handoff packs satisfy production authority.

## CHK-004

Demote Mac App from required release path.

Implementation steps:
- Update README product positioning to Lattice CLI primary and koala legacy alias.
- Update stack-layering and project-vision docs to reflect host-neutral third-party-host usage.
- Update authority-client-role docs so the old Mac Runner wording is translated into Lattice CLI + Server Authority + optional dashboard language.
- Document that Mac App remains optional/archive/dashboard only, not a required host-neutral workflow dependency.

Validation:
- Happy: docs tell a new user they can use Lattice CLI with Codex/Claude Code/Gemini and Server Authority receipts.
- Edge: old Koala wording remains as compatibility context without becoming the main product claim.
- Adversarial: docs do not imply that open-sourcing the Mac App is required to use Lattice.

## CHK-005

Verify Lattice CLI migration with focused build and smoke tests.

Implementation steps:
- Add a smoke task covering entrypoints, version/help, host/config/authority/conduit commands, and no authority overclaim.
- Register root and package scripts for the smoke task.
- Run npm build and focused smoke tests.
- Record verification evidence against every PLAN verification intent after successful validation.

Validation:
- Happy: build and smoke task pass.
- Edge: JSON/text modes return stable status for missing optional hosts and missing authority URL.
- Adversarial: smoke asserts local CLI surfaces do not report verified production receipt authority.

## Rollback

Because 0.3.5 keeps koala as a legacy alias and does not remove the existing package identity, rollback is low-risk: remove the lattice wrapper/bin mapping, revert new Lattice-specific handlers/scripts/docs, and restore versions to the previous 0.3.4-1 metadata. No story JSON or runtime artifacts are part of the product rollback.
