## Trigger Event

On 2026-09-02 the user asked to migrate new upstream work into this repository. B-3e16
had previously migrated the standalone `proof-or-stop-graph` repository into
`packages/graph` at upstream commit 10b5921de4b1fe5b4e796d1a7d78ec655cc400fd. Since that
point the upstream repository gained four further commits building a per-story detail
page: 4c3bde0 (the dossier page itself, with its own URL), 7ecad9a (a findings feed),
a0b14da (date-prefixed wire-log lines) and 1536588 (title wrapping, a pinned close
button, empty states). None of that work exists here. The user also asked that the
dossier be reachable from the command line, following this repository's own conventions
rather than inventing a new command shape.

## Key Insights

The migration surface is small and mechanically verifiable. `git diff --stat 10b5921 HEAD`
upstream is 7 files and 1860 insertions, of which 1119 lines are one new file,
`src/shells/web/dossier.js`. Four of the files this repository would have to patch
(`src/io/http.ts`, `src/shells/web/app.body.html`, `app.css`, `app.js`) were confirmed by
shasum to be byte-identical to their upstream 10b5921 contents, so the upstream diffs
apply without conflict resolution. The two that diverge are divergent by design:
`README.md` carries this repository's migration wording, and `scripts/build-web.mjs`
carries a local uncommitted change that makes a missing d3 a hard failure.

The dossier already has a server-side route contract upstream: `/story/<id>` serves the
same `app.html`, and the client reads `location.pathname` at boot to open the dossier
over the graph. That means the CLI needs no new server, no second HTML asset and no new
long-running command; a flag on the existing `graph` command that changes which URL is
opened is sufficient. `resolveStories(root).primary` is already on the graph library
surface and maps story id to directory, so validating a supplied id needs no new export.

## Solution Tradeoffs

For the CLI shape, a dedicated `graph_story` command was weighed against a `--story=<id>`
flag on `graph`. A separate command would duplicate the whole startup path the existing
handler already owns - package resolution, on-demand client build, `startServer`, the
watchdog heartbeat and signal shutdown - and two long-running commands would compete for
the same port. The flag reuses all of it and costs one optional schema field, so the flag
was chosen.

For an unknown story id, serving anyway and letting the page render an empty state was
weighed against refusing before listening. The handler already contains a resolved
precedent for exactly this question: an unresolvable `--root` is refused rather than
served, because a typo would otherwise be indistinguishable from an empty repository.
Refusing before listening keeps `--story` consistent with that precedent, so it was
chosen, with near-miss candidates named in the error.

## Conversational Texture

The user framed this as a migration and not a redesign, naming the source repository, the
already-migrated commit, and their recollection that the existing command is
`proof-or-stop graph`. They explicitly asked that the new command surface follow this
repository's conventions. Both design questions above were put to the user before any
code was written, and both were answered: the `--story` flag on `graph`, and validation
before the server starts listening.
