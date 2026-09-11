# U-09 shard adapter identity and physical registry paths

The fixed Lab command is `node packages/main/dist/tasks/story-aware-validation-production-smoke.js`. At `9bfb0cb109`, RED failed the original seven-shard-receipt assertion: the configured adapter was rejected before any shard command launched.

The registered digest still named the adapter bytes from `db5dae1983`. Commit `a348e1c626` (B-45a0 F-447) added canonical environment names with legacy fallback but did not refresh this registration. The audited current source digest is `23e5676be5e9258a14ad20c528b58a082c185c1d844d1297a39c723152f50c30`. Registration now uses those exact bytes; it does not accept an arbitrary file under the registered name. The process contract mechanically compares the pin with the checked-in adapter.

After repairing the pin, the unchanged receipt validity assertion exposed a second issue: runtime reads used physical `/private/var/...` paths while registry identity used the `/var/...` alias. Registry loading now resolves the physical path before checking containment and before execution. An external symlink cannot acquire an internal registry identity. The runner identity advances to v5 so prior baselines are refreshed.

Actual production smoke passed its original seven receipt/signature/sentinel/case-coverage assertions and positive/fallback authority cases. Added negative executions prove that an adapter changed by one comment and a case-registry symlink targeting outside the project both launch zero shard commands. The registered byte check and containment boundaries remain enforced.

Build binding: `da8b188adf2c:205b0c29ee3a`. The process-fact contract also passed. This closes the shard failure identified during the preceding cross-commit cycle; it is Lab maintenance evidence, not formal Story DONE or a product-release assertion.
