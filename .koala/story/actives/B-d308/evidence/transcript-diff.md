# B-d308 user acceptance transcript diff

## Expected

- Codex users have a clear Koala-owned adapter entrypoint instead of fake `.Codex/hooks` or `.Codex/settings.json`.
- `node bin/koala-codex.js session_brief` works as the preferred local wrapper.
- `.Codex/koala.json` declares `adapterOwner=koala`, `adapterKind=codex`, `activitySource=codex`, local wrapper first, global fallback with read-only activity recording, and explicit exclusions for unsupported Codex runtime assets.

## Actual

```text
$ node bin/koala-codex.js session_brief
# koala session brief
Story: B-d308
Phase: TEST
Checklist: 3/3 done
```

```text
$ node -e "const m=require('./.Codex/koala.json'); ..."
koala
codex
codex
node bin/koala-codex.js
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala
.Codex/hooks,.Codex/settings.json
```

```text
$ test ! -e .Codex/hooks && test ! -e .Codex/settings.json
no-fake-codex-runtime-assets
```

## Diff

No product-visible mismatch. The final behavior matches the intended boundary: Codex receives Koala adapter metadata and a hardened wrapper/fallback path, while Claude-only hooks/settings/skills stay under `.claude`.
