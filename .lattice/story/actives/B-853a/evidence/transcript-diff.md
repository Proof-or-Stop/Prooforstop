# B-853a (M4) real-machine acceptance — transcript + diff

Milestone M4 (final) of the proof-or-stop evidence-instrument replay campaign: the offline
three-state H1–H4 ADJUDICATOR. Deliverables: `experiments/pos-instrument-replay/analyze-batch.mjs`
(offline analyzer) + `selfcheck-m4.mjs` (hermetic un-gameable selfcheck) + generated
`report.json` / `report.md`.

Run from the operator's perspective on the real machine (macOS, darwin), 2026-07-06.

## 1. `node experiments/pos-instrument-replay/analyze-batch.mjs`

**Expected:** reads the four committed evidence streams + protocol.json, re-verifies each
batch-ledger recordDigest, adjudicates each hypothesis to a three-state verdict, prints the four
verdicts + overall + a reproducible digest, and writes report.json + report.md. On the real
(complete, well-formed) committed evidence, all four hypotheses are supported.

**Actual:**
```
H1 replay-determinism: pass
H2 tamper-fail-closed: pass
H3 resume-integrity: pass
H4 scale-envelope: pass
overall: all-pass
digest: 198e33866bfbc52439abb38704bb3d7bd3c5611a2337fa003fae869432dff458
```
Second run: identical digest. `git status` on report.json/report.md after re-running: empty
(byte-identical — deterministic). The digest was independently re-derived by hand
(`sha256(canonicalJson(report minus digest))`, recursively-sorted keys) and by Codex host-2 — both match.

**Diff:** none. Actual == expected on every field (verdicts, overall, digest, determinism).

## 2. `node experiments/pos-instrument-replay/selfcheck-m4.mjs`

**Expected:** exit 0, `selfcheck-m4 PASS`, all 19 hermetic sub-checks A–S green.

**Actual:** `selfcheck-m4 PASS`, exit 0, A–S all pass — including the adversarial ones that prove the
three-state adjudication is un-gameable: an incomplete scale, stripped/partial goldMetrics, an
undeclared/extra scale, a missing tamper `(class,handling)` identity, a swapped
identity→disposition, a resume stub / false `killC.stoppedRecordPreserved` / empty `postResume`, a
negative/null `elapsedMs`, or a naively-edited ledger record each yield `fail`/`inconclusive`/abort
— **never a false `all-pass`**; an absent input file yields `inconclusive` + a null `generatedInputs`
sha (never a crash); and report.md embeds the §3 claim text only when `all-pass` (no-overclaim).

**Diff:** none.

## 3. Cross-vendor adversarial convergence (the strongest campaign exhibit)

The M4 adjudicator was reviewed over 4 rounds, each 3 Claude lanes + a genuine Codex gpt-5.5 host-2.
Codex found real HIGH false-passes the Claude lanes missed in rounds 1–2 (H1 completeness, H2
identity + identity→disposition binding, H3 stub + nested-value). The analyzer was too lenient —
it rubber-stamped incomplete / stub / count-only / mislabeled evidence as `pass`, which would have
silently defeated the whole campaign. All 15 findings were resolved (14 fixed across two
deep-harden commits + 1 dead-code removed). Round 3: **Codex = NO REAL FINDINGS** and independently
**re-derived the report digest (DIGEST REPLICATED: YES)**. Round 4: all 3 lanes pass on the clean
tree. Cross-host quorum satisfied (3/3 × 2 hosts). `lattice validate`: status pass, 12/12 coverage.

## Self-check (user-value acceptance)
- Runs on a real machine as the operator would invoke it? Yes — `node analyze-batch.mjs` and
  `node selfcheck-m4.mjs` both exit 0 with the expected output.
- Reproducible/cross-host? Yes — the digest re-derives byte-for-byte, offline, independently and
  cross-vendor.
- Un-gameable? Yes — 19 sub-checks prove no incomplete/tampered/mislabeled evidence yields a false pass.
- Actual matched the expected PLAN outcome? Yes — zero diff on every field.
