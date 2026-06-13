# User Value Acceptance Transcript Diff

Story: B-50fb
Outcome checked: package identity no longer presents Koala as the current npm scope; Lattice is canonical while the `koala` binary remains a legacy alias.

## Expected

- `packages/main/package.json` reports `@lattice-agent/core` at version `0.3.5`.
- Workspace packages use `@lattice-agent/*` or `@lattice/*` names, not `@koala-agent/*`.
- The `lattice` binary remains available as the primary CLI command.
- The `koala` binary remains only as a compatibility alias to the same entrypoint.
- Package manifests and lockfiles do not expose old Koala package scopes as canonical metadata.

## Actual Transcript

```text
$ node -e "const p=require('./packages/main/package.json'); console.log(p.name+' '+p.version); console.log('bin.lattice='+p.bin.lattice); console.log('bin.koala='+p.bin.koala);"
@lattice-agent/core 0.3.5
bin.lattice=dist/cli.js
bin.koala=dist/cli.js
```

```text
$ node -e "const fs=require('fs'); const files=['package.json','packages/main/package.json','packages/utils/package.json','packages/lab/package.json','packages/cli-guess-number/package.json','packages/game/package.json']; for (const f of files) { const p=JSON.parse(fs.readFileSync(f,'utf8')); console.log(f+': '+p.name); }"
package.json: lattice
packages/main/package.json: @lattice-agent/core
packages/utils/package.json: @lattice-agent/utils
packages/lab/package.json: @lattice-agent/lab
packages/cli-guess-number/package.json: @lattice-agent/cli-guess-number
packages/game/package.json: @lattice/game
```

```text
$ rg -n "@koala-agent/(core|utils|lab|cli-guess-number)|@koala/game" package.json package-lock.json packages/*/package.json packages/*/package-lock.json
<no matches>
```

## Diff Notes

- Expected and actual package identity match: `@lattice-agent/core 0.3.5` is visible from the product metadata.
- Expected and actual CLI compatibility match: `lattice` and legacy `koala` both point to `dist/cli.js`, so existing command access is preserved without making Koala the package identity.
- Expected and actual manifest scan match: no old `@koala-agent/*` or `@koala/game` package metadata remains in manifests or lockfiles.
- No user-visible gap remains for the requested package-scope rename.
