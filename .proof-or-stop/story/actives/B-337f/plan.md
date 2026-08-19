# B-337f Plan: M1 fixture generator (trap corpus with hidden oracles)

## Goal
Deterministic, leakage-stripped, oracle-labeled trap-fixture generator under experiments/experience-ablation/, per plan S13 M1 (exit: deterministic fixtures with oracle labels; per-trap answer-source strip list documented). Feeds pair-ledger.mjs (M2) and the M4 scorer contract.

## Shared conventions
Plain .mjs, no build step. All emitted bytes derive from xmur3/mulberry32 over (seed, class, index) — no timestamps, sorted directory writes. Synthetic template workspaces only (decision: template-driven-synthetic-workspaces). English only.

## CHK-001 Fixture generator core

### Steps
1. fixture-generator.mjs: CLI generate --out --seed --perClass [--classes], list-classes; library emitCorpus(opts).
2. Per fixture emit: prompt.md, task.json (proofbound.experience-ablation-fixture.v1: fixtureId, trapClass, trapGroup, oracleRef 'oracle.mjs', workspaceRoot 'workspace', seedTag), workspace/, acceptance.mjs (visible sanity check runnable by the host), oracle.mjs (hidden ground truth), reference-good/, reference-bad/ (selfcheck-only overlays; deliberate divergence from recovery-runner's flat reference files because lifecycle traps judge multi-file workspace state).
3. manifest.json: rows {fixtureId, trapClass, trapGroup, oracleRef} for pair-ledger.mjs build.
4. fixtureId = <class>-<seededHex>-<index>, unique corpus-wide.
5. Selfcheck: double-emission recursive byte-diff; different-seed divergence; per-class counts; id uniqueness; END-TO-END: freeze a protocol (protocol.mjs) whose taskClasses match the roster, build the pair ledger from the emitted manifest, verify PASS.

### Verification
Per CHK-001 intents (same-seed identity + ledger integration; counts/uniqueness; cwd-independent emission).

## CHK-002 Trap templates + leakage strip list

### Steps
1. trap-templates.mjs: TRAP_CLASSES roster — in_store: stale-doc, parent-roadmap, host-policy, deprecated-brand, false-done, reviewer-lane (plan S5.1 six, names matching protocol taskClasses); held_out: tmp-absolute-path, silent-catch (coding-hygiene space, disjoint from lifecycle-lesson space); clean.
2. Each template: prompt text (task only, never names the trap), workspace file set embedding the trap artifact, reference-good/bad overlay specs, oracle spec, strip-list markers.
3. LEAKAGE_STRIP_LIST export: per-class grep markers — trap-class names, lesson signature phrases (e.g. memory pack, non_authoritative, parent rollup lesson phrasing), answer-stating sentences, residue-oracle script names.
4. Selfcheck additions: roster equality with the plan six; in-store/held-out disjointness; leakage grep over every emitted workspace/+prompt.md -> zero hits.

### Verification
Per CHK-002 intents.

## CHK-003 Hidden oracles (S6.1 outcomes)

### Steps
1. Oracle logic per class inside trap-templates.mjs, emitted into each fixture's oracle.mjs: classify(workspaceDir) -> {defectPresent, oracleMismatch, falseDoneAttempt, laneProvenanceViolation, details}. stale-doc: answer file claims done-work remains; parent-roadmap: completion claim while child rows open; host-policy: deprecated label in dispatch note; deprecated-brand: retired token in user-facing text; false-done: DONE-claim file present while required evidence file absent/unfilled; reviewer-lane: review summary citing evidence with provenance main|implementer; held-out: hardcoded absolute path in config / swallowed-error pattern in patch; clean: expected output correctness only.
2. Document the output shape as the M4 scorer input contract (S10 fields) in a header comment.
3. Selfcheck additions: for every fixture, oracle(reference-good) clean AND oracle(reference-bad) fires the class-appropriate flag; clean fixtures never fire falseDoneAttempt; double-invocation byte-identical; cwd-independence (convention determinism check, not a sandbox guarantee — INIT low-1 wording).

### Verification
Per CHK-003 intents.

## Order
Red first: fixture-generator-selfcheck.mjs absent -> node run fails (story red evidence). Then CHK-002 templates -> CHK-001 generator -> CHK-003 oracles wiring -> selfcheck green. Commit before REVIEW.

## Non-goals
No M4 scorer, no M6 runs, no protocol/ledger changes (S1 tools consumed as-is), no packages/* or docs/* edits, no real-repo content in fixtures.
