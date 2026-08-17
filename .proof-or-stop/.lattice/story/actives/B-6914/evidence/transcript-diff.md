# B-6914 Transcript Diff

## Expected

- Local CLI reports the new package boundary for this story.
- Package metadata, lockfiles, source brand, and dist brand all agree on the same version.
- No remote publish or push is performed.

## Actual

Command:

```bash
sh -lc "node packages/main/dist/cli.js --version && node -e <version-sync-check>"
```

Output:

```text
Proofbound CLI 0.3.172
version-sync-pass 0.3.172
```

Exit code: 0.

## Difference

No user-visible difference for the local version boundary: the CLI reports 0.3.172 and the package, lockfile, source brand, and dist brand checks agree on 0.3.172.

The DONE/recovery auto-bump line itself is covered by the recovery and version-bump smoke transcripts, not by this direct version-check command.
