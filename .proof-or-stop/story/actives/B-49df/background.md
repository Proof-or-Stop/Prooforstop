## Trigger Event
On 2026-09-02, inspection after B-022e found a newly created B-a745 INIT record containing the retired reviewer identity and confirmed that the global CLI resolved into the B-fe8f worktree. The same audit showed current scope-boundary writers still emit the historical schema literal and the identity verifier fails after B-022e DONE release records were appended.

## Key Insights
Historical signed artifacts must remain byte-stable, but that requirement does not authorize new Story writers to keep producing retired active identities. The safe boundary is explicit: read historical v1 evidence, write the new canonical v1.1 schema, reject retired reviewer actors, and prevent a foreign-worktree runtime from writing at all.

## Solution Tradeoffs
A new schema literal changes the scope-boundary hash by design, so new records use proof-or-stop.scope_boundary.v1.1 while old lattice.scope_boundary.v1 records remain readable without mutation. A runtime-realpath admission check adds a small preflight cost to Story writes but closes the demonstrated global-link ambiguity instead of relying on operator discipline.

## Conversational Texture
The user asked for direct evidence and then explicitly approved the four hard measures, with a precise requested schemaVersion and reviewer Agent name. Success must be visible in freshly generated JSON, not inferred from renamed prompts or a passing test that runs before DONE appends release metadata.
