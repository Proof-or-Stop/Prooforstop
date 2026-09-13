# Reviewed identity context movement and audit provenance

This document resolves the documentation finding in audit `0859d75d-3526-48a4-93f7-729d6f57556f`. That audit reviewed prepared candidate `8ec508443595df5c18ddcab85e1715cdbca35d77` against main `b07b6e9fbfbb169bba2bb508ec1ffbafacd8bbd2` and rejected unclear spacing and comparison provenance. The code and verification command are unchanged by this documentation repair. No new scan admission is granted.

## Two distinct comparisons

The affected source is `scripts/verify-process-fact-contract.mjs`. Its source diff from `d788f9adafcf20ee8c66d0fd7e2ae1db72681e9f` to `b07b6e9fbfbb169bba2bb508ec1ffbafacd8bbd2` adds a 14-line acceptance-closure execution block before all nine contexts. It also updates prepared-evidence writer expectations elsewhere. Every reviewed context line remains byte-identical in that source comparison. The 14-line figure describes this latest sync only.

Main b07b6e9fbf still carried older positions in `scripts/identity-reviewed-fixture-data.json`. The complete inventory repair therefore has larger cumulative movements. The intermediate inventory at commit `242c6250da815ce497945e04fe9cac14d9d9b6a0` already matched the d788 source. Comparing that intermediate inventory to the synchronized repair shows exactly 14 additional lines for each row. Comparing main b07b6e9fbf's stale inventory to the synchronized repair shows six movements of 32 lines, one of 44 lines, and two of 114 lines.

The table uses zero-based JSON array indexes under `entries`; source line numbers are one-based. Each row keeps the same token, token occurrence count, line hash, classification, and reason. Only its source hash and line number change. The stale source hash is recorded as an inventory claim, not presented as a newly measured current source.

| Fixture row | Stale pin in main b07 | Actual line in d788 / pin at 242c625 | Actual line in b07 / repaired pin | Latest sync | Cumulative movement | Exact line SHA-256 |
|---|---:|---:|---:|---:|---:|---|
| 163 | 7242 | 7272 | 7286 | +14 | +44 | `b675687c994bcc52e9f2c2024ec63100a451143a2f5f1f0217a41561b7225c94` |
| 249 | 6489 | 6507 | 6521 | +14 | +32 | `e89dcf2a6a826d2835c5df00680c4fe6ddf5d3d2c7f155ee50be37660c6f8387` |
| 250 | 6491 | 6509 | 6523 | +14 | +32 | `0519f716d148190cfb2b11ace82e02297a2ab7eaff9163edcf6572b9dd5afde0` |
| 251 | 6498 | 6516 | 6530 | +14 | +32 | `ae8237dbd7e68e35d4b626920d706063ca716841e5ce492f81726b41bc6549e8` |
| 252 | 6506 | 6524 | 6538 | +14 | +32 | `17a459433ba198345c8b821268696356733020a5f5c4a0327ce564aac07c9cbf` |
| 253 | 6516 | 6534 | 6548 | +14 | +32 | `0c46ff5e6d3996a8a9f76a0614c14f94c87123801ac8ab87a4afeef5042c2ef0` |
| 254 | 6525 | 6543 | 6557 | +14 | +32 | `931f3791ffbe5fb584b6cf750bc8ab353a0561563a3a6f623c705e79f79f4ca1` |
| 255 | 7264 | 7364 | 7378 | +14 | +114 | `14c71d5ceea5f8729c7bdeab0f79a74985668c33fdfd9a12b056a3a61b351a28` |
| 256 | 7293 | 7393 | 7407 | +14 | +114 | `2a7e1eccda93ff980b87fb395076963a760c05058e22d10c3f3cb381a4ffa8f1` |

## Source and delivery bindings

- Stale inventory source hash carried by main b07: `ab59edf1bbb7031e4ae31b0539a3b399d4ddf807ab33b3ff249ef3b568476923`.
- Measured d788 source SHA-256: `9348d9fbe489a60ee81e11fdfae932ba9dc895868659e37b580d19e56a869775`.
- Measured b07 source SHA-256: `776343265e642ba54e9bb81e54f5c1c4c4caaffd391850cbcd84630b791baa8b`.
- Synchronized binding repair commit: `2465c0070e50b100ed06a5505be13564eb66ecb5`.

The fixture inventory remains at 268 entries. The static manifest inherited from main b07 remains at 267 entries. The sync changes nine fixture source/position bindings, their fixture-reader digest, two scanner hash bindings, and 136 derived hash fields in existing static entries. Static IDs, call keys, call digests, classifications, reasons, invocation coverage, and dependency keys are preserved. Existing source verifier bytes and all eight inherited console expressions remain unchanged.

The comparison can be reproduced from Git: read the source at d788 and b07, then read the fixture inventories at b07, 242c625, and 2465c007. For each table row, compare the old and repaired token/count/classification/reason/line-hash fields; hash the source line at the intermediate and final positions and require equality with the recorded line hash. Hash both whole source files separately. No executable source literals need to be copied into this document to perform those checks.

## Verification and audit boundaries

The pinned command remains `node scripts/verify-reviewed-source-bindings.mjs`. At repair commit 2465c007, official GREEN passed in 35.381925708 seconds, measured from 2026-09-13 11:15:24.792956 UTC to 11:16:00.144028 UTC. That command covers the real source and fixture readers, scanner self-test using current schema inventory, static edges, and the actual route driver's bounded dependency closure. It does not claim full active-residue scanner success or execution of the native route suite.

The earlier audit PASS in 449.065 seconds belongs only to candidate 22224fb2 and audit c26e3c07. Main changed before integration, so that PASS became historical. The later audit 0859d75d took 439.263 seconds and rejected documentation on candidate 8ec50844. Audit duration is nested within its finish command duration; the two must not be added as separate elapsed work. Neither audit establishes approval of this documentation repair or a future synchronized candidate.

The older 74-to-52 residue comparison was made against the d788 baseline. It is not a measured count for main b07 or a later main. Unmeasured timing and residue counts remain unknown. The owner must sync the next authorized main checkpoint and obtain fresh prepared-head evidence and independent audit before integration. This Lab is not Story B-e6d9 DONE or remote-release evidence.
