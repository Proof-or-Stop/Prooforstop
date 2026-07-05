# pos-instrument-replay — M0 protocol freeze

M0 of the proof-or-stop replay & tamper campaign (story B-9e44). This directory
produces a **frozen protocol** (`protocol.json`) that the later milestones
(M1–M4) execute against. The instrument under test is the playbook-runtime
memory baseline, exercised **only** through the `lattice
memory_playbook_baseline_generate` / `..._verify` CLI. Nothing here modifies the
instrument (`packages/**`); it is read/called only.

## What each script is

- **`lib/instrument.mjs`** — shared, deterministic helpers: `sha256`,
  `canonicalJson` (sorted keys, no incidental whitespace), `verifyDir` (shells
  the verify CLI and parses JSON), `refreshManifest` (recompute
  recordsDigest+goldDigest from files, apply overrides, rebuild manifestDigest —
  mirrors the smoke's refresh logic), `fingerprintDomain` (extract the observed
  `{status, flags, metrics}` domain), and the failure-signal predicate helpers.

- **`viability-check.mjs`** — generates ONE clean small baseline (seed 42) in
  mkdtemp, then applies each candidate tamper (class × `raw`|`refreshed`) to a
  fresh mkdtemp copy with a DETERMINISTIC mutation (fixed indices/inputs), runs
  verify, and records the observed fingerprint. Every candidate carries an
  `intent`: `malicious` (a real tamper we want rejected) or `benign` (a
  content-inert change the instrument is correct to accept). See the four
  disposition categories below. Writes `viability-results.json` (canonical,
  byte-stable) with per-candidate
  `{class, handling, intent, disposition, fingerprint, smokeOverlap}`. Asserts
  the fail-closed set is non-empty and every fail-closed class carries a genuine
  failure signal; asserts every acknowledged-limitation is `malicious`+`pass`;
  and exits nonzero on any vacuous fail-closed class **or any false-positive**.
  Never mutates the source baseline (verified after the run).

### The four disposition categories

The disposition rule is evaluated **in this order**:

1. **fail-closed** — verify `status === 'fail'` **OR** `status === 'crash'`. A
   crash is the instrument *refusing to certify* (it threw / emitted no
   parseable JSON — e.g. a structurally corrupt `manifest.json` or
   `gold-queries.json`). `verifyDir` returns a `{status:'crash', crashed:true,
   error}` sentinel instead of aborting the run, and the crash status is itself
   the failure signal. This is a genuine detection outcome, not a harness bug.
2. **acknowledged-limitation** — a `malicious` tamper that verify *accepted*
   (`status === 'pass'`). These are the instrument's **documented blind spots**:
   an editor who recomputes the digests (a *refreshed* tamper) defeats the
   digest mechanism — e.g. silently weakening a gold query's `expectedIds`
   (`gold-semantic-weaken`), lying about `corruptRows` in the manifest
   (`corruptRows-lie`), or colliding a noise-row id with a gold-record id
   (`duplicate-gold-id`). Making these **explicit and honest** is the whole
   point of the fix: the instrument's real detection boundary is the digest, and
   digest-recompute is *out of H2 scope*. **Tier-C signing would address this**
   (the plan claim boundary: "an editor who recomputes digests defeats them —
   Tier-C").
3. **dropped** — `status === 'pass'` AND both `records.jsonl` and
   `gold-queries.json` are byte-identical to clean (only manifest/metadata
   changed; the content-inert seed-swap no-op).
4. **accepted** — a `benign` content change the instrument correctly accepts
   (e.g. a refreshed row-reorder, or an additive gold field).

**SAFETY** — if a `benign` candidate is ever *rejected* (`status === 'fail'`),
it is disposed **false-positive** and the harness **exits nonzero**. The
instrument must never reject a benign change; a false-positive is a hard
honesty failure.

- **`calibrate-full.mjs`** — the sole heavy compute in M0. Runs ONE full-profile
  (1,000,000-record) generate+verify in mkdtemp, captures `elapsedMs` +
  `peakRssBytes` from the verify result, and writes `calibration.json` with the
  measured cost, chosen N (`small:30, full:3`), the per-verify budget cap
  (full elapsed × safety factor 3), and env pins
  `{nodeVersion, platform, instrumentCommit}`. This run takes minutes.

- **`build-protocol.mjs`** — deterministic producer. Reads
  `viability-results.json` + `calibration.json` + frozen constants and emits
  `protocol.json` (canonical JSON, byte-stable) plus `protocol.json.sha256`.
  Running it twice produces a byte-identical `protocol.json` (stable sha256).

- **`selfcheck.mjs`** — hermetic (mkdtemp), no network, no live baseline. Runs
  `build-protocol` in a sandbox from the committed inputs and asserts the
  re-emitted `protocol.json` is byte-identical (sha256 stable); asserts every
  `failClosed` fingerprint carries a failure signal (a `fail` with off-gold
  flags/metrics **or** a `crash` status); asserts every `acceptanceBucket` entry
  is `status:pass`; asserts every `acknowledgedLimitations` entry is
  `intent:malicious` with a `status:pass` fingerprint and a non-empty
  `limitationNote`; asserts no candidate in `viability-results.json` is disposed
  `false-positive`. Prints `selfcheck PASS` / exit 0, or a clear message /
  nonzero on any violation.

## Reproduce

```bash
cd experiments/pos-instrument-replay
node viability-check.mjs     # -> viability-results.json + disposition table
node calibrate-full.mjs      # -> calibration.json (minutes: one full-profile run)
node build-protocol.mjs      # -> protocol.json + protocol.json.sha256
node selfcheck.mjs           # -> selfcheck PASS
```

`build-protocol.mjs` is deterministic: re-running it re-emits a byte-identical
`protocol.json` and the same sha256, as long as `viability-results.json` and
`calibration.json` are unchanged.

## `protocol.json` is the frozen M0 contract for M1–M4

`protocol.json` pins: `schemaVersion`; the content-inert `seed` (42,
`contentInert:true`); `N` per scale; the `tamperMatrix`
(`failClosed` with per-class fingerprint + exact-comparison failure-signal
predicates — including a `{field:'status', op:'==', value:'crash'}` predicate
for structural-corruption classes; `acceptanceBucket`;
`acknowledgedLimitations` — each `{class, handling, intent:'malicious',
fingerprint, limitationNote}` recording a documented instrument blind spot that
digest-recompute defeats and Tier-C signing would address; `dropped`); the
`iterationIdRule`
(replay `<arm>/<scale>/<index>` and tamper
`tamper/<scale>/<class>/<manifestHandling>`); the `recordDigestPreimageRule`
(sha256 of canonical JSON of the record with the `recordDigest` field absent);
`budgetCaps`; the `stopReasonEnum`
(`budget_cap|verify_crash|precondition_failed|operator_abort`); `envPins`; and
`smokeOverlap` per class.

### Reuse audit (`smokeOverlap`)

Each candidate class carries `smokeOverlap {covered, smokeCase?}`, audited
against `packages/main/src/tasks/playbook-runtime-memory-baseline-smoke.ts`:

- `gold-edit` (raw) → covered by `assertGoldTamperWouldFail`.
- `records-truncation` → covered by `assertTruncatedSelfConsistentManifestWouldFail`.
- `records-byte-flip`, `records-row-drop`, `records-row-duplicate`,
  `records-row-reorder`, `records-field-rename`, `gold-additive-field`
  (the additive `tampered:true` refreshed variant, renamed out of `gold-edit`
  so it does not collide with the semantic-weaken class),
  `manifest-recordCount-edit`, `manifest-profile-edit`, `manifest-digest-edit`,
  `cross-profile-swap`, `seed-swap` → **net-new** (`covered:false`); no
  equivalent smoke case exists.
- `gold-semantic-weaken`, `corruptRows-lie`, `duplicate-gold-id`,
  `manifest-structural-corruption`, `gold-structural-corruption` → **net-new**
  (`covered:false`), enumerated from Codex host-2 findings F-001..F-004. The two
  gold-* structural/semantic classes touch `gold-queries.json` but are still
  net-new: no smoke case exercises a semantic weaken or a structural corruption
  of gold.

Smoke-covered classes are re-asserted through the harness for ledger
completeness (cheap), not re-engineered.
