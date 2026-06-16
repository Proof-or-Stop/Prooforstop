# B-94ae real-machine verification (user-perspective)

**User value**: a person reading CLAUDE.md's hook section no longer sees the false
prohibition "不要创建 `.Codex/hooks`" — instead they read the truth that host hooks
are framework-managed init assets.

## Expected (PLAN outcome)
- CLAUDE.md line 77 no longer contains the clause forbidding creation of host hooks.
- The line accurately states host hooks are generated per-host by `lattice init`
  (Claude under `.claude/`, the Codex adapter under its own adapter dir).
- No `.Codex` literal is re-introduced (sibling story B-ed70 gates on `git grep .Codex` empty).

## Actual (run from the worktree)

Command: `git show main:CLAUDE.md | sed -n '77p'`  (BEFORE, on main)
```
...不阻塞 prompt。Claude hook/settings 只放在 `.claude/`，不要创建 `.Codex/hooks` 或 `.Codex/settings.json`。
```

Command: `sed -n '77p' CLAUDE.md`  (AFTER, this story HEAD)
```
...不阻塞 prompt。每个 host 的 hook/settings 都是框架在 `lattice init` 时按 host 生成的 managed asset：Claude host 落在 `.claude/`（如 `.claude/hooks/lattice-scope-pretool.cjs`，已纳入 git），Codex adapter 落在其各自的 adapter 目录（同样由框架生成对应的 scope-guard hook）。这些是框架管理的生成产物，不要手写或手改；要调整 hook 行为请改生成源（`init-assets` / `core/managed-assets`），而不是直接编辑产物。
```

Command: `grep -c "不要创建.*hooks" CLAUDE.md`
```
0   ← no line forbidding hook creation remains
```

Command: `git grep -nE '\.Codex(/|\b)' -- CLAUDE.md`
```
CLAUDE.md:773: | Codex | `.Codex/lattice.json` manifest ...   ← PRE-EXISTING (B-ed70 owns), NOT introduced by this diff
```

Command: `lattice codex verify`
```
✓ Codex adapter checks passed (8/8 pass)
  [✓] Codex runtime exclusions: no uppercase-only .Codex/hooks or .Codex/settings.json
  [✓] Codex native PreToolUse hook: .codex/hooks.json wires apply_patch/Edit/Write to lattice-scope-pretool.cjs
```
→ confirms the corrected wording matches reality: the framework's managed Codex scope-guard
  hook lives at lowercase `.codex/hooks/` (managed-assets.ts:730-736), generated, not hand-written.

## Diff notes (expected vs actual)
- Expected == actual: false prohibition removed; accurate managed-asset statement present;
  no new `.Codex` literal; codex adapter contract still green (8/8).

## 5-question self-check
1. PLAN outcome concrete? Yes — exact line text before/after captured above.
2. Read user-perspective output? Yes — read the rendered CLAUDE.md line a human would read.
3. Would the user consider it done? Yes — the lie is gone, the line now states the truth.
4. Noise/duplicate engineering logs in user's eyes? No — single-line doc change.
5. Plain-language summary? "CLAUDE.md no longer falsely forbids host hooks; it now says they
   are framework-generated managed assets you shouldn't hand-edit."
