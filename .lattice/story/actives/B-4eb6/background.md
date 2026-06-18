## Trigger Event
The approved forward-A/B-proof design (2026-06-18, Work/lattice-Paper/experience-forward-ab-proof-design.md) identified the decisive gap: Phase 1.5 (B-1dc9) already injects an advisory experience-hints section into the review prompt and emits experience_hint_surfaced, but NO command ever writes the finding-signals.json cache the hint loader reads — so hints never fire. This story (3.1) activates the loop.

## Key Insights
The derive+persist machinery already exists: deriveFindingSignalsFromStore(store, {projectRoot}) calls writeFindingSignals (learning-store.ts, the only toucher of .lattice/learning/) which writes .lattice/learning/finding-signals.json; experience-hint-loader.ts reads that exact path via readFindingSignals. So learning_scan is a thin command that invokes the derivation WITH projectRoot to persist the cache, plus registration. The cache carries the anchorFiles added in B-a2e3, so the hint loader and effectiveness metric can re-validate at read time.

## Solution Tradeoffs
learning_scan is a clean deterministic derive+persist of ALL signals; referential-staleness filtering is intentionally NOT done here (it stays at read time via B-a2e3's revalidateSignals leaf), keeping the scan simple and the cache a faithful snapshot. Because it WRITES the advisory learning cache it is an experience-layer mutation (process-fact level L2), not a read-only command, so it is not added to READ_ONLY_COMMANDS and its command-policy ownershipClass is not readOnly. The .lattice/learning/ prefix is already materialHash-excluded, so writing the cache never perturbs any gate or evidence freshness.

## Conversational Texture
The user approved the 4-story Hybrid plan (3.1 scan, 3.2 signatureTag capture, 3.3 A/B gating, 3.4 effectiveness metric). 3.1 is the foundation: without the persisted cache the rest cannot show anything. The user values honest framing — this story activates the mechanism; it does not by itself prove the layer makes development smarter.
