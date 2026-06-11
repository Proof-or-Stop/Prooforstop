## Trigger Event
On 2026-06-10 the Authority receipt gate integration plan split Server and CLI work into separate repo stories. The CLI currently has signing primitives and a pure receipt-ref predicate but no real HTTP proof verification, writer command, or lifecycle gate consumption.

## Key Insights
The user needs Lattice CLI to stay host-neutral: Claude, Codex, and local runners may produce evidence, but only a verified Lattice Authority Server gate_decision receipt can satisfy production Authority gates. Readiness and transport accepted must remain separate from verified consumption.

## Solution Tradeoffs
Build the smallest correctness path first: proof fetch and verification, structured receipt-ref write, idempotent consumption, and enforce versus shadow gate behavior. Avoid unrelated dashboard, multi-tenant, or revocation work until the signed chain is proven.

## Conversational Texture
The user explicitly asked for separate Server and CLI stories/worktrees and for multi-host review following four principles: do not optimize for optimization, do not optimize arbitrarily, only fix real correctness issues, and preserve consistency of logic.
