## Trigger Event
On 2026-06-24, static inspection found implementation_review_result_set/get defined in B-78d2 era code but unavailable in the current CLI, plus legacy intent coverage and zod bridge files with no live imports.

## Key Insights
The problem is workflow correctness, not code-size optimization: a handler can look implemented while no command can call it, which misleads tests, prompts, and future agents. The detector should focus on command/handler surfaces and avoid treating smoke tasks or dynamic serve entrypoints as dead code.

## Solution Tradeoffs
Prefer a narrow verification script that fails on unregistered handler factories and catalog/registry mismatches, with explicit allowlists for dynamic entrypoints. For stale code, delete only high-confidence unused files or leave dynamic serve support intact rather than broadly optimizing the tree.

## Conversational Texture
The user explicitly rejected registering old code just to make it look used. The work should preserve Lattice host-neutral logic, fix real correctness drift, and keep the explanation honest about what is runtime, regression asset, or legacy residue.
