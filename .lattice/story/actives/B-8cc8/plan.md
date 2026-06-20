# Plan: B-8cc8 full CHANGELOG de-koala

## Overview
Express-intent docs story (forced through normal channel by strict profile). Fully rebrand CHANGELOG.md koala/Koala/KOALA -> lattice/Lattice/LATTICE via case-preserving substitution, including historical technical tokens (the user chose full de-koala over truthful history). CHANGELOG.md only; it is excluded from the koala-residue gate, so no code/test impact.

## CHK-001 Replace all koala/Koala/KOALA with lattice/Lattice/LATTICE in CHANGELOG.md
Case-preserving substitution across the whole file: version titles (Koala 0.3.x -> Lattice 0.3.x), product-name prose, koala-lab -> lattice-lab, and all historical technical tokens (@koala-agent -> @lattice-agent, koala commands -> lattice, .koala/ -> .lattice/, bin/koala.js -> bin/lattice.js, koala.config -> lattice.config).
- userSees: git grep -i koala CHANGELOG.md returns 0 (down from 49); CHANGELOG reads fully Lattice-branded.

## CHK-002 Acceptance: zero koala in CHANGELOG, build/validate green
git grep -i koala CHANGELOG.md -> nothing; npm run build -> exit 0; lattice validate -> all-green.
- userSees: 0 koala in CHANGELOG; build exit 0; validate all-green.
