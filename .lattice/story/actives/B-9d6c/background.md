## Trigger Event
2026-06-12 formal unlock audit found that stale or mixed baseline artifacts can pollute a current Layer 2 or Layer 3 formal proof root if old final-report files remain in the scanned directory. The new execution plan requires a clean run-scoped root plus a mechanical invariant check.

## Key Insights
The existing formal evaluator already keeps Production Safety and global claims locked, but suite aggregation currently reasons mainly over accepted reports. A final PASS proof root needs an explicit all-files invariant so rejected or mixed files cannot be silently tolerated in the final proof root.

## Solution Tradeoffs
The minimal fix is to add a narrow formal root invariant around Engineering and Loop Engineering suite aggregation instead of rewriting artifact discovery or adding reportFiles support. Layer 4 stays a future Authority-backed path and does not inherit local formal unlock authority.

## Conversational Texture
The user explicitly wants execution with two host review while preserving the core principles: no optimization for its own sake, no arbitrary changes, only real correctness fixes, and logical consistency across Lattice CLI non-authority and Authority Server boundaries.
