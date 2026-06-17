# B-000c Execution Plan — Experience Layer Phase 1a (finding-signals)

Build a self-contained module set that derives a finding-signals cache from
existing findings and registers it as gate-excluded. Zero outward imports
(usage-ledger isolation bar). Inert: no CLI, no injection, no playbooks.

## CHK-001 Types + minimal learning-store
`core/experience-layer-types.ts`: FindingSignal (localSignature, category,
counts {resolved,dismissed,falsePositive,acceptedRisk,unclear}, signalScore,
support, lastSeen, exampleStoryIds/FindingIds, fileKinds), the derived-cache
envelope {schemaVersion, updatedAt, signals[]}. `core/learning-store.ts`:
LEARNING_DIR (.lattice/learning), ensureLearningDir, read/write
finding-signals.json (atomic). Only node:/./../ imports within the module.
Verification: build clean; smoke round-trips the cache; zero outward imports.

## CHK-002 finding-signals derivation via the store port
`core/finding-signals.ts`: deriveFindingSignals(storyIds | all) reads findings
through `store.readFindings` (NEVER JSON.parse findings.json); builds
localSignature = category + signatureTag? + fileKind + lifecyclePhase; tallies
positive = fixed_resolved + 0.5*partially_mitigated, negative =
false_positive_dismissed, ignored = unclear+out_of_scope+duplicate+already_covered;
signalScore = positive/(positive+negative+1); support = positive+negative.
Writes the cache via learning-store. Degrades to category+fileKind when
signatureTag absent.
Verification: smoke seeds findings via the store, asserts aggregated signals +
correct signalScore/support; asserts the store accessor was used.

## CHK-003 Gate-safe runtime-artifact registration
`runtime-artifact-registry.ts`: add entries for
`.lattice/learning/finding-signals.json` and `.lattice/learning/learning-log.jsonl`
as materialHash:exclude, volatile:true, repairable.
Verification: smoke asserts currentMaterialHash() identical before/after writing
the cache.

## CHK-004 Smoke + npm script + no regression
`tasks/experience-layer-finding-signals-smoke.ts` + package.json
`test:experience-layer-finding-signals`. Hermetic temp dir + env restore.
Assert: derivation correctness (incl. zero-sample + single-hit edge),
currentMaterialHash unchanged after write, zero outward imports (static scan),
build clean.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
User-facing subcommands; reviewer-prompt hint injection; review-gate code;
the staged playbook proposal lifecycle; cross-project aggregation.
