# B-b95c Plan - Lattice-Branded Init Assets

## CHK-001 - Define Lattice Primary Asset Naming Contract

1. Extend lifecycle artifact policy with a Lattice-primary naming table.
2. State that KOALA.md, .Codex/koala.json, bin/koala.js, and bin/koala-codex.js are legacy aliases for existing projects.
3. State that this is managed asset naming only, not runtime authority or receipt semantics.
4. Verify with rg over docs for LATTICE.md, .Codex/lattice.json, legacy Koala aliases, and no-delete language.

## CHK-002 - Implement Lattice-Branded Init Output

1. Add Lattice template/render helpers in init-assets while preserving legacy Koala render helpers where needed.
2. Change cli-init fresh Codex/core output to write LATTICE.md, bin/lattice.js, bin/lattice-codex.js, and .Codex/lattice.json.
3. Keep AGENTS.md and .Codex/README.md filenames but update their content to reference Lattice primary entrypoints.
4. Ensure thin mode does not create Koala-named local assets in fresh projects.

## CHK-003 - Preserve Legacy Koala Asset Compatibility

1. Update managed asset detection/check to accept both Lattice primary paths and legacy Koala aliases.
2. Update Codex verification to resolve .Codex/lattice.json and bin/lattice-codex.js first, then legacy Koala paths.
3. Update runtime environment checks for lattice.js/lattice-codex.js local launchers.
4. Add compatibility smoke coverage for legacy Koala project fixtures and mixed primary+legacy path diagnostics.

## CHK-004 - Validate Docs, Init Fixtures, And Adapter Verification

1. Add focused smoke scripts for lattice-branded init and legacy Koala compatibility.
2. Run TypeScript build plus prompt/registry/init compatibility smoke tests.
3. Run node bin/koala-codex.js verify_codex after adapter path changes.
4. Record verification evidence for every intent and refresh stale evidence before REVIEW/TEST.
