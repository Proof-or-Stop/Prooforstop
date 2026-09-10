# Original quorum target ABBA

Run `node scripts/lab/u17-original/u17-original-abba-run.mjs <repo> [output-parent]` after a fresh build, with other heavy workloads paused. Keep these four modules together.

The driver preserves all original prefix checks and runs the original target callback on/off/off/on, restoring the same temporary Git fixture and resetting the six named caches each time. It verifies source/dist/HEAD and the build binding before and after, and enforces a 20-minute process-group deadline.

The baseline is mixed: actual historical Story-hash implementations at 3f010a95b24c73d68fa6df0fc715df102f9ea4f0, with exact-hit bypass for current material/root caches. It is not a whole historical checkout. Timings exclude fixture restoration, baseline loading, cache reset and post-callback close drainage.

Unknown subprocesses fail measurement. Exact source-bound filesystem-only lock heartbeats and known read-only process probes are separately recorded; business JavaScript children must retain their instrumentation receipts. Failed measurements are not performance results.

See docs/lab-evidence/u17-original-target-abba.md for the completed experiment and its limits. The recorded-artifact checker is scripts/verify-u17-original-evidence.mjs.
