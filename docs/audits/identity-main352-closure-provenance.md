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

The pinned command remains `node scripts/verify-reviewed-source-bindings.mjs`. At repair commit 2465c007, official GREEN passed with a subprocess-monotonic elapsed duration of 35.381925708 seconds. The ledger separately recorded UTC timestamps of 2026-09-13 11:15:24.792956 and 11:16:00.144028. These are different clock measurements; subtracting the UTC timestamps does not reproduce the monotonic duration. That command covers the real source and fixture readers, scanner self-test using current schema inventory, static edges, and the actual route driver's bounded dependency closure. It does not claim full active-residue scanner success or execution of the native route suite.

The earlier audit PASS in 449.065 seconds belongs only to candidate 22224fb2 and audit c26e3c07. Main changed before integration, so that PASS became historical. The later audit 0859d75d took 439.263 seconds and rejected documentation on candidate 8ec50844. Audit duration is nested within its finish command duration; the two must not be added as separate elapsed work. Neither audit establishes approval of this documentation repair or a future synchronized candidate.

The older 74-to-52 residue comparison was made against the d788 baseline. It is not a measured count for main b07 or a later main. Unmeasured timing and residue counts remain unknown. The owner must sync the next authorized main checkpoint and obtain fresh prepared-head evidence and independent audit before integration. This Lab is not Story B-e6d9 DONE or remote-release evidence.

## Subsequent main 0.3.354 synchronization

Official sync incorporated main 939d7215236a97fd8bf514d11c0619fcf95bd282. Compared with b07b6e9fbf, its process-contract source adds 18 lines after line 10001. All nine reviewed contexts listed above precede line 7408; every position, exact line hash, count, classification, reason and evidence string remains unchanged. The source hash changes from 776343265e642ba54e9bb81e54f5c1c4c4caaffd391850cbcd84630b791baa8b to c4486554d092dbeece2a0b461eccf2e8c6e44f625a60d524076082d8fe7cd9ba. This subsequent comparison has zero context movement; the earlier insertion and cumulative movement table remains historical.

The nine process-contract whole-source fields and their dependent hashes are refreshed. Complete inventory preflight additionally identified the two existing contexts detailed below. All 268 fixture rows and 267 static entries are retained; no IDs, calls, evidence claims, dependency keys, assertions or budgets change. The pinned verifier remains byte-identical with SHA256 ec746476ce3f9d8bdc9b7af087bd558ddd9d186ac54cb5262e2c87c09090502f. Source comparisons are reproducible with Git at b07b6e9fbf and 939d721523. No residue count or timing from an earlier baseline is asserted for this synchronized candidate. Fresh official verification and prepared-head audit remain separate requirements.

The separate source inventory row 14 in packages/main/src/core/runtime-fact-registry.ts moves from line 488 to 495 because main adds seven continuity-budget declaration lines. Its exact line hash remains a64f56d954b7389ac455e4d8ab7b4dc602592e25150e157d27993453674ae32d; whole-source hash changes from 2a50979405c7a3a56466c259f02591c83aa6c678f9c1db6a25fe670c6d4d8231 to cce634fccb7b787a22ef40e3b951b8840eb76ec09f211c545d0142a76274f83f. The paired environment-marker classification and occurrence count are unchanged.

Fixture row 258 in scripts/verify-scope-budget-approval.mjs moves from line 46 to 48 after two inserted budget assertions. Its environment-clearing negative-control line remains byte-identical with hash 514f555de291c6e658ed1bbfe4861bba9b98136d9f29cfdc2644314ced9b0742; whole-source hash changes from 085f49578e243fb09e15e24ef74893cd4cf9bd785fb26352b94055d366c5460c to b1118a7eb38b0c407e56bf615bca5819180ce0f37879199da011f9e26cc9be7b. Surrounding incoming assertions consume the budget-specific blocker; the reviewed clearing operation and its classification, count and evidence remain unchanged. All 55 source rows and 268 fixture rows were checked against their complete current source bytes and exact line hashes before the next official replay. The failed official replay and subsequent fixture preflight are retained as failures, not passing evidence.

The separate scanner-owned negative-source table also retains two existing paths whose whole-source fingerprints changed: scripts/verify-process-fact-contract.mjs and scripts/verify-runtime-fact-contract.mjs. Main adds continuity-policy assertions, while their 30 and 6 lines containing retired identity spellings respectively remain identical as multisets to b07b6e9fbf. Only their whole-source hashes change; no negative-context row, count, classification or assertion changes. The runtime-contract hash changes from cd748737298613e40212c5a4822685bf51e00ccdac049c9f5e16e40ed2334cfd to 7bee4a0fe6b4551a694f81af5ae115b33d1293e8bd5f12558a58a924a8910b47. All 50 witnesses exposed by the scanner were subsequently checked against current bytes. The scanner self-test and official pinned replay remain the executable checks; a witness census alone does not establish full scanner success.
