## Trigger Event
On 2026-06-17, after the koala-removal ship-clean program completed (B-40eb residual sweep, B-0dab verify gate, B-e7c6 schema id), the user reviewed CHANGELOG.md and found it still uses the Koala brand. CHANGELOG was originally a documented exception (truthful history kept), but the user now chose to fully rebrand it to Lattice.

## Key Insights
There are 49 koala/Koala occurrences in CHANGELOG.md, of two kinds: (1) brand names - 5 version titles (Koala 0.3.4-1, 0.3.0, 0.2.x), ~10 product-name prose hits, and the koala-lab subsystem heading; (2) historical technical tokens - @koala-agent/core (old npm scope), koala validate / koala test_story (old CLI commands), .koala/story/actives + .koala/activity.jsonl (old runtime paths), bin/koala.js, koala.config. The user explicitly chose to change BOTH categories (full de-koala), accepting that the CHANGELOG history becomes non-literal (it will describe the past as changing .lattice/ when it was actually .koala/ at the time). CHANGELOG.md is excluded from the koala-residue gate scope, so this is a pure-docs change with no test impact.

## Solution Tradeoffs
Brand-only vs full: the user chose FULL (all koala -> lattice including historical tokens) over brand-only (which would keep truthful history). The tradeoff is zero koala in CHANGELOG for OSS at the cost of historical literal accuracy. Mechanism: case-preserving substitution (Koala->Lattice, koala->lattice, KOALA->LATTICE) across the whole file. Scope: CHANGELOG.md only; no other files.

## Conversational Texture
After I pointed out the CHANGELOG still carried the Koala brand (it was a documented exception in the ship-clean program), the user asked to rebrand it and explicitly chose full de-koala including historical technical tokens, via a Lattice express-channel story.
