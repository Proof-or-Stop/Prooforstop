# B-c64a Plan

1. Add a material tree hash helper that hashes tracked, non-story-metadata files.
2. Record that material hash on new verification evidence when git metadata is available.
3. Make verification coverage prefer material hash freshness before falling back to legacy headHash diff.
4. Extend `verification-freshness-smoke` to cover metadata-only fresh, legacy fallback, and material-change stale behavior.
5. Run build and the freshness smoke before review.
