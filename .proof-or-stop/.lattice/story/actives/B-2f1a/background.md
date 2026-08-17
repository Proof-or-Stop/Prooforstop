## Trigger Event
On 2026-06-24, after the koala->lattice ship-clean program completed (packages/*/src + docs/experiments literal-zero), the operator directed rebranding the product to Proofbound: "Lattice CLI" -> "Proofbound CLI". The paper repo already rebranded Lattice->Proofbound; the CLI/repo is still Lattice-branded (18,145 hits across 1,562 files).

## Key Insight
Most "lattice" is LOAD-BEARING internal: the `.lattice/` audit directory (189 src files reference it), `@lattice/*` npm packages (117 files), 122 persisted schema-ids `lattice.*.v1`, and 15 signature salts `lattice-*-integrity/binding-v1` (just renamed from koala in B-fbca). A blind global rename would break the build, the audit trail, and signed-evidence verification. So the rebrand is a PHASED PROGRAM. This story is Phase 1: user-VISIBLE brand only (README/docs prose, --help/banner strings, package.json descriptions), keeping all internal lattice identifiers for later phases.

## Tradeoff
Phase 1 changes the capitalized brand word "Lattice"->"Proofbound" and "Lattice CLI"->"Proofbound CLI" in user-facing prose/strings, but DELIBERATELY keeps the lowercase `lattice` command name, `.lattice/` paths, `@lattice/*` package refs, schema-ids, and salts (those are Phases 2-4). Docs will temporarily say "Proofbound CLI" brand while still showing `lattice <cmd>` commands until Phase 3 renames the binary; that is acceptable because brand-first is the lowest-risk starting point and does not touch any load-bearing identifier.

## Conversation Texture
The operator chose rebrand scope = branding + CLI binary + @lattice packages + .lattice dir (NOT schema-ids/salts) and asked to create a story; given 18k hits and the .lattice-dir self-reference (the Lattice workflow itself depends on .lattice/), it was decomposed into a 4-phase program, starting here with the safe user-visible branding phase.
