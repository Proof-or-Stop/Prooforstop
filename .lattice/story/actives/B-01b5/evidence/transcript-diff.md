# B-01b5 User Value Transcript Diff

## Expected

Codex users should get hard executable capabilities, not prompt-only guidance:

- `node bin/koala-codex.js doctor` reports live Codex adapter diagnostics.
- `node bin/koala-codex.js verify_codex` records/verifies hard adapter evidence.
- Fresh `koala init --verify-codex` creates Codex assets that can actually run through the generated wrapper.
- Generated Codex wrapper works even when a stale or missing global `koala` cannot provide the required commands.

## Actual

Repository-local diagnostics:

```text
$ node bin/koala-codex.js doctor
✓ No health issues recorded. koala is healthy.
Codex adapter scan:
  ✓ Codex adapter checks passed (7/7 pass)
    [✓] Codex manifest: .Codex/koala.json matches template
    [✓] Codex agents mirror: 16 prompt(s) mirrored
    [✓] Codex runtime exclusions: no .Codex/hooks or .Codex/settings.json
    [✓] Local Codex wrapper: bin/koala-codex.js sets Codex activity env
    [✓] Local wrapper heartbeat: source=codex ... entrypoint=local-wrapper
    [✓] Global fallback heartbeat: source=codex ...
    [✓] Aux command availability: aux_doc_list registered
```

Repository-local verification:

```text
$ node bin/koala-codex.js verify_codex
✓ Codex adapter checks passed (7/7 pass)
  [✓] Codex manifest: .Codex/koala.json matches template
  [✓] Codex agents mirror: 16 prompt(s) mirrored
  [✓] Codex runtime exclusions: no .Codex/hooks or .Codex/settings.json
  [✓] Local Codex wrapper: bin/koala-codex.js sets Codex activity env
  [✓] Local wrapper heartbeat: source=codex ... entrypoint=local-wrapper
  [✓] Global fallback heartbeat: source=codex ...
  [✓] Aux command availability: aux_doc_list registered
```

Fresh init with wrapper verification:

```text
$ node bin/koala.js init --verify-codex /tmp/koala-codex-user-check
✓ bin/koala.js
✓ bin/koala-codex.js
Codex verification:
✓ Codex adapter checks passed (5/7 pass)
  [✓] Codex manifest: .Codex/koala.json matches template
  [✓] Codex agents mirror: 16 prompt(s) mirrored
  [✓] Codex runtime exclusions: no .Codex/hooks or .Codex/settings.json
  [✓] Local Codex wrapper: bin/koala-codex.js sets Codex activity env
  [✓] Local wrapper heartbeat: source=codex ... entrypoint=local-wrapper
```

Fresh init generated wrapper under minimal PATH:

```text
$ PATH=/usr/bin:/bin <absolute-node> bin/koala-codex.js session_brief
# koala session brief

**No active story** — no stories yet.

Start with `koala story_create` to create your first story.
```

## Diff

No user-value gap remains for this story. The generated Codex adapter now has a real executable local path, the init verifier exercises that path, and REVIEW/DONE evidence can reject missing, failing, or stale Codex hard evidence.
