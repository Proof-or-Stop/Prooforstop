## Trigger Event
On 2026-06-30, user requested closure of three status documents after audit found B-9fc5 plan-only wording, proof admissibility partial/future rows, and control-plane partial/unavailable rows. This is a docs correctness closure story, not a new runtime automation story.

## Key Insights
The real issue is consistency of logic between implemented source, Lattice lifecycle facts, and requirement documents. Completed local CLI rows should be visibly marked, while partial, future, retired, unavailable, or read-only diagnostic rows must not be promoted into hard gates.

## Solution Tradeoffs
A small documentation/status-table update is safer than arbitrary code optimization. If an audit finds a real code mismatch, it should become a separate story; this story should only fix stale or ambiguous claims in the three named documents.

## Conversational Texture
The user wants to decide future priority from accurate tables, then asked to execute the agreed priority order until DONE. The final outcome should make each document readable at a glance: completed rows get checkmarks, and incomplete boundaries stay explicit.
