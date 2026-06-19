# Lattice Experience Layer -- Effectiveness-Proof Development Record

Status: accepted
Source story: B-cb13
Source proposal: DDP-001
Created: 2026-06-19

## Decision

The per-project Experience Layer effectiveness-proof track is built and live on main: a referential re-validation instrument (B-a2e3), a forward A/B apparatus (B-4eb6 learning_scan, B-5d48 signatureTag capture, B-06b3 A/B shadow-gate, B-c06a learning_effectiveness), and a signature_backfill command (B-17a9) whose apply made the live experience base real-signature. Effectiveness is recorded OBSERVATIONALLY (a learnable real-signature substrate is proven: 62% held-out specific recurrence offline; live recall 0.659) while the causal claim (showing hints improves outcomes) is explicitly DEFERRED to the forward ON/OFF RCT, which accrues over future stories.

## Context

lattice-experience-layer-execution-plan.md (B-1480) recorded the PLAN. Baseline A's flat/negative learning curve (Spearman rho=-0.55) was explicitly a LOWER BOUND caused by degraded mechanical signatures, not evidence that recurrence is absent. Real (LLM-assigned) signatures were needed to test learnability; and the live findings carried almost no signatureTag, so learning_scan derived near-empty signals and learning_effectiveness reported zeros. This record captures the OUTCOME of executing the proof track.

## Scope

The per-project Experience Layer on the Orchestrate (Lattice CLI) main branch: the six merged stories above plus the offline phase-3.5 backfill analysis and the live signature_backfill apply (main commit 2750aadef). Per-project only -- cross-project aggregation was removed (B-2a8d).

## Non-Goals

- A causal proof that showing hints improves development outcomes (deferred to the forward ON/OFF RCT)
- Cross-project / multi-repository learning aggregation
- Claiming the saturation-inflated rising recurrence curve (Spearman rho ~ +0.7) as a learning result
- Persisting degraded mechanical signatures into the live base (the backfill used LLM-assigned semantic signatures, evidence-first)
- Duplicating the raw evidence (CSVs, figures, scripts) into the repo -- they remain referenced in Work/lattice-Paper/

## Options Considered

### Degraded-mechanical-signatures only (Baseline A)

Pros:
- No LLM cost
- fully deterministic

Cons:
- Signatures are coarse-vacuous or fine-sparse; learning curve flat/negative (rho=-0.55); cannot drive a useful specific hint -- a lower bound only

### Cross-project aggregation

Pros:
- More data per signature

Cons:
- Pollutes single-project review + weakens the auditable local lineage; removed by B-2a8d

### Persist signatures without first proving learnability

Pros:
- Fewer steps

Cons:
- Risks mass-writing degraded experience that does not help; evidence-first deferral avoided this until the offline curve came back positive

## Chosen Approach

Six Lattice stories (each INIT->DONE, full review, audit fields excluded from gates, advisory-only): B-a2e3 read-only learning_validate (anchorFiles + revalidate leaf; valid-rate/drift instrument); B-4eb6 phase 3.1 learning_scan (derives+persists .lattice/learning/finding-signals.json, activating the Phase 1.5 hint loop); B-5d48 phase 3.2 signatureTag auto-candidate + provenance at finding_add (audit-only, excluded from finding _hash); B-06b3 phase 3.3 deterministic per-story A/B hintMode with shadow-gated hint display (event fires on both arms; hints stay out of resolveReviewPromptHash); B-c06a phase 3.4 read-only learning_effectiveness (predictive value + ON/OFF arm readout with a conservative N gate). Then an evidence-first offline phase-3.5 backfill (LLM-assigned area|failureMode signatures over 695 findings, 164 classes, leakage-free) re-ran the learning curve; then signature_backfill (B-17a9) persisted 656 real signatures into the live findings (commit 2750aadef) with every finding _hash byte-identical.

## Operational Rules

- Run `lattice learning_scan` to derive+persist the finding-signals cache (advisory; required for hints to fire).
- Run `lattice learning_validate` for referential validity (valid-rate / drift-rate vs HEAD).
- Run `lattice learning_effectiveness` (+ --json / --confirmedOnly) for the predictive-value + ON/OFF arm readout; it honestly reports 'insufficient N' until both arms reach MIN_ARM_N.
- Run `lattice signature_backfill --map <committed map>` (dry-run default; --apply to persist) to fill empty signatureTags with source=backfill; only empty tags are filled, confirmed are never overwritten, every finding _hash stays byte-identical.
- Honesty guards when reporting: report the saturation-immune held-out recall, NOT the naive rising Spearman rho; read recall together with signature specificity (coarse signatures are vacuous); always frame results as observational unless the forward RCT supports a causal claim.

## Verification Requirements

- The learnability claim is verified by a held-out temporal split (train earlier findings, test later), reported as token-recall over real signatures (62% offline; 0.659 live).
- The causal claim requires the forward ON/OFF RCT (phase 3.3 arms + phase 3.4 readout) to reach sufficient N over future stories.
- signature_backfill must keep every touched finding _hash byte-identical (verified via real signFinding) and be idempotent.
- The live experience base must stay drift-checked via learning_validate (valid-rate ~0.971, drift ~0.029 at record time).

## Risks

- Saturation confound: with a finite signature vocabulary the naive recurrence curve rises over time regardless of learning -- mitigated by reporting held-out recall, not rho.
- Observational != causal: high predictive recurrence does not prove hints change outcomes.
- Signature quality depends on LLM consistency under the fixed taxonomy; a different rubric could shift the classes.
- Live vs offline differences: the live learning_effectiveness numbers can differ slightly from the offline analysis as findings accrue.

## Supersession

If this decision changes, update this file through a Lattice story. Because
this file is under `docs/requirements/decisions/*.md`, DONE requires the local
decision-doc 3x2 host verdict quorum.
