## Trigger Event
While merging main into story B-ffe0 on 2026-07-03, a collision revealed main's B-ab8d already ships the experiment-arm render gate (resolveExperimentArm, surfaceRuntimeMemoryPack, experience_pack_surfaced, LATTICE_EXPERIMENT_ARM env) plus a memoryRetrieval command block. Cross-host Codex probes then proved that on the control arm a host can still recover stored memory through the serialized JSON surfaces the render gate deliberately keeps for "lossless measurement".

## Key Insights
B-ab8d's render gate suppresses only the TEXT section on control and keeps the pack in JSON. That JSON is host-readable, so done_closure --json, final_response_check --json (also its TEXT — the 8th RuntimeConsumer B-ab8d never gated), host_dispatch --json/--output plus its prefetch manifest, handoff_create/handoff_resume --json, and playbook_runtime_health topHitIds all leak stored dev-memory/playbook ids, lessons, and corpus fingerprints on control. parallel_dispatch --includeExperience also injects live experienceRefs. Measurement does not require the JSON pack: the experience_pack_surfaced event already carries packDigest + topHitIds on both arms.

## Solution Tradeoffs
Option A (chosen): a thin isolation layer keyed on the SAME resolveExperimentArm — redactMemoryPackForControlArm empties the pack at each JSON surface, final_response_check joins surfaceRuntimeMemoryPack, experienceRefs() returns [] on control, and two corpus tools join the memoryRetrieval markers. Option B (rejected): rewrite B-ab8d to not keep the JSON pack — larger blast radius, breaks its measurement-shape contract. Option C (rejected): block every serialized command on control — over-broad, kills legitimate treatment/no-experiment output.

## Conversational Texture
The operator directed reconciling the earlier duplicate implementation onto main's infrastructure rather than shipping two incompatible experiment-arm systems, and to keep only the genuinely net-new value (the JSON-leak closure). This story is that net-new isolation layer; the render gate, arm resolver, and retrieval block themselves remain B-ab8d's.
