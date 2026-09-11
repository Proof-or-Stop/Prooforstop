# Seven-Lab integration against refreshed main

This records the independently audited implementation. Final main/tag publication identity is recorded separately in the release publication-verification.json.

Remote main: `d354d2b43d771b702b4913b4ba0241520e7b1cb0`. Combined candidate: `d7f6669c6aa0e62ee58b3d9cf8d5c7ab96f472d6`.

All seven selected Lab heads have commits absent from remote main (both ancestry and patch-equivalence checks). All seven selected heads are ancestors of the combined candidate. Current worktree source may include overlapping main fixes; the table does not claim every source line is missing from main.

| Lab | Selected commit | In remote main | In candidate |
| --- | --- | --- | --- |
| b03b7-validation-baseline-convergence | `3828191b2b05d6727958c4f314a0ec57bd46eecc` | No | Yes |
| delivery-root-cause-20260911 | `1f23dabb3427cce0f54eec274f1a50ac51372c5d` | No | Yes |
| dynamic-finding-evidence-closure | `bb7ee75049999abddf41b7fcca3e78d1a53fd220` | No | Yes |
| dynamic-validation-tier-selection | `0decca4f8bfc08dfe6677ae17c2bf2f96e21194b` | No | Yes |
| lab-main-lock-scope-20260911 | `9299a7067c330174b5af4d4e1e0b8ad07929a970` | No | Yes |
| repro-first-enforcement-0296 | `b0ab33dbdc1e1573e9fa6a4999da076b11be2ad3` | No | Yes |
| validation-reuse-proof | `2ddf8dc2dd45a41a100daf7ea575b825adcafa27` | No | Yes |

The candidate merged remote main without text conflicts, including the external-worktree and Go pre-review repairs. It also merged the newer Finding qualification partial-diagnostics repair and its independent Lab acceptance report. The version already present on remote main is 0.3.317; this candidate must use the next available patch version when released and must not overwrite that tag.

Claude independently executed all seven acceptance commands plus identity self-test and external-worktree/Go regression: all nine exited 0. See CLAUDE-SEVEN-LAB-FINAL-AUDIT.md and the captured task outputs. Retain every source worktree until verified inclusion in main. Historical snapshots remain labeled with their original candidate; seven-audited-candidate-reachability.json is the current implementation binding.
