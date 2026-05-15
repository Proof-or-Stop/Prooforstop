# B-d9ee Plan

## CHK-001
Implement `grill_start`, `grill_record`, `grill_close`, and `grill_get` as PLAN-oriented CLI commands backed by a `grill.json` planning artifact. Add typed data structures and StoryStore read/write helpers. Register handlers and expose schemas in `cli-engine`. Add command policy and phase tool entries so write commands are available in PLAN and read command is available broadly.

## CHK-002
Teach `story_review` to read the grill planning artifact and emit advisory-only issues for open sessions or unresolved questions. Keep severity advisory, keep `blockerCount` unchanged, and make missing `grill.json` a no-op for legacy stories.

## CHK-003
Add focused smoke tests for command persistence, lifecycle policy, and advisory behavior. Update truth-source docs to state `Grill clarifies intent; evidence proves behavior`, and record verification evidence from project-native commands rather than from grill transcript.
