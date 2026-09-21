# REVIEW rework execution archive

These are actual command outputs, archived for the independent Lab auditor.
They are diagnostic records; they grant no Story PASS or independent approval.
`checks.json` binds the tested executable sources and raw logs by SHA-256.
The code parent predates the added negative controls; the source digests identify
the tested working-tree bytes that this evidence commit now freezes.
The later formal Lab GREEN reruns the pinned command on the committed candidate.

- `process-fact.log`: full process-fact contract, exit 0.
- `static-edges.log`: full static-edge contract, exit 0; no exceptions added.
- `runtime-candidate.log` and `runtime-baseline.log`: both exit 1 on the same
  pre-existing validation snapshot binding assertion. `runtime-comparison.json`
  records the exact normalization: checkout root and measured duration only.
  All remaining bytes match `runtime-normalized.log`; no failed assertion or
  error detail was removed. The failed production consumer is unchanged.
- `native-controls.log`: wrong cwd refuses without publication; successful and
  throwing handler calls restore cwd; inventory overflow requires every lane;
  cross-wave duplicates retain both originals; dirty transport and bounded
  rendering controls pass through the real selector/CLI/broker chain.
- `inventory-controls.log`: empty repository and real ls-files ENOBUFS refuse;
  46,477-path inventory succeeds under the registered bound. The real-source
  inventory covers count, byte and cooperative deadline limits.
- `source-budget-red.log`: the same oversized real-source inventory reached parsing
  before the new resource bound; the new refusal assertion failed. This is no
  claim that the old fixture reproduced a minutes-long stall.
- `identity-controls.log`: reviewed emitted-JS pin accepts canonical code and
  rejects an executable mutation; comments do not alter its digest domain.
- `prior-green-0227bf95.log`: previous tool-owned GREEN for the prior committed
  candidate. It is historical context, not a claim of GREEN for later commits.

The full official local Lab history remains available through
`npm run lab:worktree -- status review-rework`. The active-audit projection's
`verification: null` limitation and registered contract execution paths are
explained in `docs/review-rework-maintenance.md`.
