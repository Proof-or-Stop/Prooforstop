# B-36fd real-machine user-acceptance transcript + diff

Perspective: a Proofbound maintainer opens the restored decision doc to plan the ablation study build.
Expected (PLAN userSees) -> Actual (live commands on 52c6440f1):

## 1. Header + revision provenance
EXPECTED: 'Status: draft execution plan (rev 2, 2026-07-02)' + provenance naming the 2026-07-02 adversarial review
ACTUAL:
  Status: draft execution plan (rev 2, 2026-07-02)
  
  Revision provenance: rev 2 incorporates the 12 verified findings of the
  2026-07-02 two-round adversarial review (4 repo mappers + 4 review lenses + 12
  independent adjudicators). It supersedes the deleted rev-1 draft of the same
  date. The honesty scaffolding of rev 1 (claim boundary, pre-registration
  discipline, immutable pre-outcome ledger, mechanical control-arm isolation,
  stopping rules, no-overclaim rule) is retained; the design parameters, study

## 2. S4 no allocated shadow arm
EXPECTED: 'There is no separately allocated shadow arm'
ACTUAL: 98:There is no separately allocated shadow arm. The production mechanism already

## 3. S7 per-population table
EXPECTED: columns 'Controlled seeded (fault stratum)' and 'Live', reference N rows
ACTUAL:
  215:| Parameter | Controlled seeded (fault stratum) | Live |
  221:| Reference N per arm (unpaired two-proportion) | ~27-62 over the full planning band (corner values 27-58; the ~62 maximum occurs inside the band near baseline 0.625 / MDE 0.25) | ~294 |

## 4. S8 matched-pairs title
ACTUAL: 248:## 8. Study Geometry: Matched Pairs, Not Blocked Randomization

## 5. S12 artifact root + isolation/freeze
ACTUAL:
  419:.lattice/experiments/experience-ablation/<experimentId>/
  431:Store isolation (mandatory, mechanical):
  445:Memory freeze (mandatory): the runtime memory-pack content used by the

## 6. S13 Reuses column
ACTUAL:
  461:| Milestone | Goal | Reuses | Exit criteria |

## 7. S5.1 held-out group
ACTUAL: 135:**Group 2 — held-out negative-control traps.** Fault-bearing tasks built from

## 8. S15 circularity disclosure
ACTUAL: 508:Required disclosure alongside any such claim: the in-store seeded traps are

## DIFF NOTES
All 8 userSees expectations matched on first read; zero mismatches.
Post-PLAN deltas (review-driven, all traced to findings F-001..F-006): reference N band reads
'~27-62 over the full planning band' (PLAN said ~29-58; corrected by F-002/F-004 with recomputed
corners), S17 sizing restated as 27-62 fixtures / ~54-124 arm-runs (F-001), M6/M7 Reuses flag
gitignored scratch (F-003), S11.1 has the complete CI-based decision rule (F-005), S7/M6/S17
carry the Wilson-CI freeze rule (F-006). Each delta strengthens the userSees intent; none violates it.
