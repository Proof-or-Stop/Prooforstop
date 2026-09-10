# Portable U06 functional policy proposal

Suggested persisted directory: scripts/lab/u06-policy/. Copy only these 14 files:

- reproduce.mjs
- generate.mjs
- apply-refinements.mjs
- verify-complete-mapping.mjs
- apply-approved-families.mjs
- inventory.mjs
- functional-seed.json
- refinement-rules.json
- refinement-more.json
- final-material-rules.json
- family-allowlist-proposal.json
- root-decisions.json
- prospective-files.json
- README.md

Do not copy generated policy/evidence/logs from this staging directory. The driver creates a unique directory under an optional output parent, defaults to OS temp, and never overwrites its sibling source files:

```
node scripts/lab/u06-policy/reproduce.mjs <absolute-lab-worktree> [output-parent]
```

No source, seed, configuration or output path is hardcoded to /tmp or a user directory. Static inputs resolve relative to import.meta.url. Child scripts receive the same explicit repo and unique output directory.

Outputs include policy-with-families.json (the final policy), evidence-refined.json, family-acceptance.json. Exact legacy migration activation remains separate; this generator never adds a legacy manifest, reads/writes Story JSON or issues signatures.

Latest actual run: 35,212 tracked plus explicitly prospective U08 material paths, 147 canonical commands, zero unmapped paths/commands or ambiguous assignments. 28 approved patterns accepted; usage-ledger/** rejected because existing authority-evidence.ts has evidence-storage ownership. Every existing domain set stayed unchanged, and actual evaluator allowed new U06 vertical helper paths but refused unrelated new source. Archive matching excludes executable .mjs/.ts examples.

Prospective U08 registration explicitly names five core modules, their dedicated documentation and the existing full-runtime regression, all provider-execution. AGENTS.override.md is the sole intentionally excluded untracked instruction file. Any additional unreviewed untracked material path causes regeneration to fail; add the final credential-test path explicitly when it exists. The future persisted generator package's own 14 paths should likewise be registered as scope-acceptance at adoption, rather than silently accepting all new scripts.

This proves mechanical mapping and controlled family expansion. It is not an exhaustive semantic content audit, measured optimal governance limits, or a completed root policy activation. Existing producer/consumer process-fact counts remain derived by production code. Approved root decisions remain traceable in the supplied JSON inputs.
