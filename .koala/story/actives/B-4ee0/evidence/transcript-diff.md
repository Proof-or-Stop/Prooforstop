# User Acceptance Transcript Diff

Story: B-4ee0 - Default Lattice init to global-thin project assets

## Expected

For a fresh empty project, `lattice init` should default to global-thin project assets:

- Create `.Lattice/Lattice.md`, `.Lattice/lattice.json`, `AGENTS.md`, `koala.config.json`, and `.gitignore`.
- Do not create legacy local Codex/Koala assets by default: `KOALA.md`, `LATTICE.md`, `.Codex/README.md`, `.Codex/lattice.json`, `.Codex/koala.json`, `.Codex/agents`, or `bin/lattice*.js` / `bin/koala*.js`.
- `lattice codex doctor` should pass on the global-thin project without requiring `bin/lattice-codex.js`.

## Actual Transcript

Command:

```sh
tmp="$(mktemp -d)"
node packages/main/dist/cli.js --root "$tmp" init --yes
find "$tmp" -maxdepth 3 -type f | sed "s#^$tmp/##" | sort
node packages/main/dist/cli.js --root "$tmp" codex doctor
```

Observed init summary:

```text
Selected init profile: core
Profile reason: no host markers found; using core (global-thin default)
Codex asset mode: global-thin
...
✓ .Lattice/Lattice.md (created)
✓ .Lattice/lattice.json
- LATTICE.md (global-thin mode; canonical guide is .Lattice/Lattice.md)
✓ AGENTS.md (created)
- .Codex/README.md (global-thin mode; Codex adapter runs from global lattice CLI)
- .Codex/lattice.json (global-thin mode; use lattice codex verify)
- .Codex/agents (global-thin mode; Codex prompts resolve from global lattice registry)
```

Observed file tree:

```text
.Lattice/Lattice.md
.Lattice/lattice.json
.gitignore
AGENTS.md
koala.config.json
```

Forbidden local assets check printed no `PRESENT ...` lines for:

```text
KOALA.md
LATTICE.md
.Codex/README.md
.Codex/lattice.json
.Codex/koala.json
bin/lattice.js
bin/lattice-codex.js
bin/koala.js
bin/koala-codex.js
```

Observed Codex doctor result:

```text
✓ Codex adapter checks passed (5/6 pass)
  [✓] Codex manifest: global-thin project: Codex adapter behavior runs from global lattice CLI (.Lattice/lattice.json present)
  [✓] Codex prompt registry: 16 prompt(s) render from package registry; hash=aaa1167ca1fd
  [✓] Codex runtime exclusions: no .Codex/hooks or .Codex/settings.json
  [✓] Local Codex wrapper: global-thin project: local wrapper not required; use global lattice codex verify / lattice codex doctor
  [!] Global fallback heartbeat: not executed in this diagnostic mode
  [✓] Aux command availability: aux_doc_list registered
```

## Diff

Expected and actual match. The only diagnostic warning is expected for `codex doctor`: global fallback heartbeat is intentionally not executed in diagnostic mode.

## Pitfall

The first local acceptance script used `path` as a zsh loop variable. In zsh, `path` is tied to `PATH`, so later `node` and `rm` lookups failed. The test was rerun with a non-special variable name (`asset`) and passed.
