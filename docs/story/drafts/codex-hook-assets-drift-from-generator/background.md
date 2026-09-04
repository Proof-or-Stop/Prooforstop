## Trigger Event

On 2026-09-04, while implementing B-af1b CHK-003, the implementer regenerated the Codex host hook assets with init --upgrade and found (finding B-af1b:F-002, low) that the generator output for the two tracked sibling hook files .codex/hooks/proof-or-stop-scope-pretool.cjs and .codex/hooks/proof-or-stop-evidence-pretool.cjs differs from what is committed on main (duplicated ROOT_MARKERS, deprecated alias fallbacks), and that .codex/hooks.json statusMessage strings still read Proofbound instead of Proof-or-Stop. B-af1b only appended its own entries and did not repair this, because it is pre-existing drift outside the acceptance scope of that story.

## Key Insights

The tracked Codex hook files are supposed to be generated products of packages/main/src/init-assets.ts and core/managed-assets.ts, never hand-edited. When the committed copy and the generator disagree, any story that regenerates through init --upgrade sees unrelated churn in its diff, and any zero-drift assertion in a smoke must be narrowed to the files that story owns. The Proofbound statusMessage is a brand-rename residue that the residue verifier does not scan because .codex/hooks.json is a JSON asset, not prose or an executable.

## Solution Tradeoffs

Regenerate all tracked Codex hook assets from the current generator in one commit on main and add a smoke that asserts byte-equality between the generator output and the committed files, so drift can never return silently. The alternative of hand-patching the committed files keeps the disagreement and the next regeneration reintroduces it. A merge-only regeneration, which only appends missing entries, can never converge and is what B-af1b had to live with.

## Conversational Texture

The owner wants generated host assets to be exactly what the generator produces, so that a fresh clone and a regenerated repository are indistinguishable. This draft exists because the defect triage rule says a low-severity, out-of-scope defect is recorded with evidence and an owner, not fixed opportunistically inside an unrelated story.
