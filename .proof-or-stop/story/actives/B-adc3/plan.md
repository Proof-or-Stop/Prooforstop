# Plan

## CHK-001: Keep accepted exact scope inventories usable by canonical reviewers

Owner: proof-or-stop-implementer
DependsOn: none

Create core/scope-inventory-budget.ts with one normalized scope projection and shared4096-path per-list,1MiB aggregate UTF8 JSON budget. Extract current canonical sorted/dedup scope projection from prompt-envelope.ts without changing its serialized shape or digest. Keep generic512 lists and text/file-rule protections. Validate the final merged contract in scope_contract_set/init_from_plan before persistence and projected scope in FullTaskContext. Do not truncate or broaden scope.

Modify prompt-contracts.ts, prompt-envelope.ts, handlers/scope-contract.ts and scope/prompt smokes plus process registry/verifier as declared. Test513/799 exact-path roundtrip and last-path digest sensitivity; exact4096 acceptance and overflow rejection; aggregate UTF8 byte limits with previous persisted scope unchanged on error; generic512 limits unchanged. Root provides actual B42 CLI-scope replay separately from durable synthetic boundary regressions.

Build, run focused scope/prompt smokes, independent REVIEW and required full validation. Normal local DONE merge only; root owns later integration/publication. No scope mutation to B42.
