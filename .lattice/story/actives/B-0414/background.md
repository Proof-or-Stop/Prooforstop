## Trigger Event
On 2026-06-16, the user asked to open a story and produce a detailed requirements recommendation document after reviewing file:///Users/jek/Documents/lattice-console-demo.html, a static Lattice monitor prototype.

## Key Insights
The repository already has docs/requirements/decisions/host-neutral-observability-console.md as an adopted source-of-truth reference, so the new work should be an MVP/productization addendum based on the HTML prototype instead of a duplicate replacement.

## Solution Tradeoffs
Prefer a scoped requirements document that maps prototype panels to existing Lattice CLI JSON surfaces, recovery commands, authority boundaries, and acceptance criteria. Avoid implementing a UI adapter or changing Lattice authority semantics in this story.

## Conversational Texture
The user wants a concrete story and a detailed recommendation document, not another high-level chat answer. The output should be practical enough that a later story can implement the console without re-litigating scope.
