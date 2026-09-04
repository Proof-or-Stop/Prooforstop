## Trigger Event

On 2026-09-03, B-fe8f exposed a reproducible verification amplification defect: 71 pinned intents referred to two commands, while selector-bound refresh behavior scheduled nearly one subprocess per intent. Probe rp-mtlq4b1z-hem77a and independent review rr-mtlq63zn-umve6e confirmed the current execution key contains the selector.

## Key Insights

Story-owned file changes must continue to invalidate evidence, but invalidation does not require duplicate command execution. Command execution identity, per-intent selector assertion identity, and reuse eligibility are distinct facts that need separate immutable bindings and fail-closed gate consumption.

## Solution Tradeoffs

Keep materialHash and storyFilesHash as conservative fallback signals. Permit command fan-out immediately, and permit input-scoped reuse only when dependency closure, environment, toolchain, command, timeout, and output integrity are mechanically complete. Uncertain inputs always cause a real rerun.

## Conversational Texture

The user explicitly rejected treating this as several loosely connected fixes and requested one strict Story. The first requested deliverable is a committed RED followed by GREEN evidence demonstrating the 71-intent, two-command execution amplification and its safe correction.
