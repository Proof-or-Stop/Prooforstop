# Five-item Lab evidence and integration

The user explicitly authorized a new managed Lab and integration into local main
on 2026-09-09. This directory preserves the complete prior experimental package.
It does not import old receipts as current lifecycle credentials.

## Historical package

`historical-evidence.tar.gz` is the byte-identical final package from the retained
Lab `five-item-proof-20260908`. Its SHA-256 is
`8221371def0e3bd30cea8d0da0328ffba4a3fab3f223b023c3439ee2264ce307`.
All 1,969 payload hashes in its `SHA256SUMS` were rechecked before this transfer.
It contains source patch/bundle, raw measurements, negative trials, scope limits,
Claude CLI audit reports/transcripts, and the original before/after analysis.
Its source base is cf21df09c273074d7aa3227a5f436c6f5badf47a; final candidate is
50ca0454dc8d6e2f44aa34918493da7415ee2c78. The repository-local checksums permit
verification without relying on the original absolute artifact paths.

The historical full validation measurement was 134/134 commands in each arm,
1,695.867 seconds versus 952.471 seconds, a 43.8% observed reduction in that
single controlled scheduling comparison. It is not a measurement of this newer
integration, all Story lead times, or universal defect detection. Short sharing
and arbitrary task splitting were slower in earlier trials, which remain included.

## Current integration contract

The new Lab starts from main 04e66fdbaeaeeb540a80c9f8e16085a5ee468f5a (0.3.285).
That main contains a newer modular quorum coordinator and 135 routine commands.
The old quorum prototype is superseded; preserve the current implementation and
its independent existing regression tests. Match configuration migrations by
command identity, never historical array positions. New verification will be
recorded separately and must identify the candidate it actually exercised.

Native Lab RED/GREEN records remain HMAC-bound local maintenance provenance in the
Git common directory after finish. They are not formal Story REVIEW/TEST/DONE.
The native finish command alone performs release preparation, fresh checks,
fast-forward local integration, and verified cleanup. Remote push is not authorized.

## Initial integration validation and independent audit

`initial-integration-evidence.tar.gz` preserves all 215 original current-evidence
files byte-for-byte, with its own SHA256SUMS. This includes 22/22 focused checks
and the complete first 135-command run: 129 passed, six failed, 774.955 seconds.
It is retained as a failed first integration trial, never relabeled final GREEN.
The original expanded files were compressed solely for reviewability and storage;
the external raw evidence and original local commit remain available.

`claude-initial-audit.md` and `.json` are the unmodified independent Claude CLI
review of source 3b55ae70. Its F-1/F-2/F-3 require explicit disposition in the final
integration report. Later fixes and rechecks do not alter that original verdict.

## Current managed integration

The integration now incorporates main 1300d7ad83 (0.3.292), all 141 current
routine commands and both DONE exclusions. Read `integration-report.md` for
the final code scope, adverse trials, unchanged baseline refusals and audit
dispositions. `claude-final-disposition.md` and `.json` are the unmodified
independent resolution of the remaining actionable audit findings at3da2f2f4.
The complete current derived-registration control is26/26, and the actual
73-case quorum run passes with internal jobs=2 and outer protected-root isolation.

`current-integration-evidence.tar.gz` preserves the current logs and source
bindings with a per-file SHA256 manifest. Its companion verification JSON records
an independent unpack/checksum check. Failed/cancelled trials remain explicit.
The native25-control RED/GREEN command and native finish status are separate
local maintenance records; no global141-command PASS or Story-wide speedup is
claimed. The Lab finish framework itself is unchanged.

The final native-gate follow-up is preserved in resource-followup-evidence.tar.gz
and claude-resource-followup.md/json:48 resource assertions pass at65bd543535.
The Lab also incorporates main6adc226976 (0.3.293), including its current strict
Story-carry rules. Ordinary clean-main integration rules remain in force.
