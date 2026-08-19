# Plan: Rebrand Phase 1 — user-visible Lattice→Proofbound

Edits confined to README.md, docs/**, packages/{main,utils,lab}/src (user-facing strings only), package.json description fields, CHANGELOG.md. KEEP all internal identifiers (lattice binary, @lattice/*, .lattice/, lattice.*.v1 schema-ids, lattice-* salts).

## CHK-001 — README + docs prose
Replace the capitalized brand word "Lattice"→"Proofbound" and "Lattice CLI"→"Proofbound CLI" in README.md + docs/**/*.md PROSE. Do NOT touch lowercase `lattice` commands, .lattice/ paths, or @lattice refs inside code-spans.

## CHK-002 — src user-facing strings
In packages/{main,utils,lab}/src, replace the brand word in --help text, CLI banner/title, command descriptions, and user-facing error messages (string literals/comments only — never identifiers/type names). Build must stay green.

## CHK-003 — package.json descriptions
Update the "description" fields to Proofbound. Leave "name" (lattice, @lattice/core) for Phase 2.

## CHK-004 — green + identifiers intact
npm test green; grep-verify the lattice binary, @lattice/* names, .lattice/ paths, the 122 schema-ids and 15 salts are byte-unchanged vs main.

## CHK-005 — CHANGELOG
Document the Phase-1 user-visible rebrand + that internal identifiers are deferred to later phases.
