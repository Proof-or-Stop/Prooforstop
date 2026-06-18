## Trigger Event
On 2026-06-17, a follow-up to the koala-removal ship-clean program (stories B-40eb residual sweep and B-0dab verify gate are DONE). The lab experiment schema id koala-lab/experiment.v1 was deliberately kept as a documented exception in B-40eb (wire-format, referenced by existing experiments data), but the user now wants it renamed to lattice-lab/experiment.v1 as the final koala-lab cleanup.

## Key Insights
There are 3 active-scope references: packages/lab/src/core/config.ts:71 (the $schema output marker written when generating an experiment config), packages/main/tests/fixtures/lab-foundation.json (asserts the schema id, and also uses a koala-lab-fixture- mkdtemp prefix), and scripts/verify-koala-residue.mjs:105 (a regex exemption that becomes unneeded once koala-lab is gone). Critically, lab does NOT validate incoming $schema — config.ts only WRITES it and there is no schema-id check anywhere in lab src — so renaming is safe: existing experiments/ data keeping koala-lab/experiment.v1 will not break. The 17 koala-lab occurrences under experiments/ are historical prose records, out of scope and not validated by the loader.

## Solution Tradeoffs
This is a brand rename (koala-lab -> lattice-lab), not a schema version change, so the id stays .v1. Because lab does not validate the id, no dual-accept or data migration is needed. Scope: the 3 active references plus the koala-lab-fixture- mkdtemp prefix in the fixture; do NOT touch experiments/ historical prose. After the change the koala-lab exemption in the gate becomes dead and is removed.

## Conversational Texture
The user asked to rename koala-lab to lattice-lab after the main koala sweep (B-40eb/B-0dab) was DONE, and explicitly chose to do it via a Lattice express-channel story given it is a small 3-reference change.
