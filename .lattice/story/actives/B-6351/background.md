## Trigger Event
On 2026-06-15 the user explicitly rejected keeping the B-a57f-style note that the koala binary or historical compatibility still exists. The requested outcome is to delete the compatibility surface because this local product currently has a single owner and does not need external legacy consumers.

## Key Insights
The previous lattice rename removed some package-level bin exposure but many runtime and documentation paths still advertise or accept koala as a legacy alias. The important boundary is operational compatibility: command entrypoints, wrapper generation, fallback package lookup, active docs, and tests should become lattice-only. Persisted historical evidence identifiers should not be rewritten when doing so would invalidate signed data.

## Solution Tradeoffs
A tiny text-only change would hide the alias from help output but leave stale wrappers and fallbacks alive, which conflicts with the user request. A full repository-wide removal of every koala token would be risky because some strings are historical process lane names or archived evidence. The chosen approach removes active runtime compatibility and current documentation while preserving immutable historical records.

## Conversational Texture
The user asked in Chinese whether koala still had to be retained, then clarified that historical compatibility is unnecessary because only they use this project now. The implementation should be direct and not over-defensive: lattice becomes the sole active name, and tests should prove the old alias is gone rather than merely undocumented.
