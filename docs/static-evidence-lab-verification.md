# Static evidence Lab verification provenance

## Official draft creation and discovery

The deferral was created by `node bin/proof-or-stop.js story_draft` in this Lab,
after the global entry refused stale-main runtime routing and explicitly directed
the local entry. Creation returned:

```text
Draft 'static-evidence-regression-registration' created at docs/story/drafts/static-evidence-regression-registration/
```

A fresh read-only command confirms discovery:

```text
node bin/proof-or-stop.js story_draft_list
  - static-evidence-regression-registration: Register static source evidence negative controls in routine validation
```

The current command help states:

```text

  proof-or-stop story_draft — Create a draft without a B-xxxx ID; write it to docs/story/drafts/<name>/

  Proof-or-Stop 0.3.345

  Arguments:
```

The current handler is the authoritative implementation, not an inference from
old host prose. `packages/main/src/handlers/story-draft.ts` has SHA-256
`327b4ddb5589c148df3fc16624f5dfcbb9b03cc1f971e2902e7a69ab951fa76d`; its path definition is:

```ts
/**
 * B-9975 CHK-001: story_draft handler
 *
 * Writes draft story content to docs/story/drafts/<name>/ without allocating a B-xxxx story id.
 * Allows iterating on story shape before committing to formal story_create.
 */

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/;

function getDraftsDir(ctx: HandlerContext): string {
  // ctx.root points to <projectRoot> (where proofOrStop.config lives).
  // Drafts go to <projectRoot>/docs/story/drafts/
  return join(ctx.root, 'docs', 'story', 'drafts');
}
```

Its creation handler writes background.md, checklist.json and index.json and
returns the docs/story/drafts path. `story_draft_list` reads the same directory.
Draft creation deliberately allocates no B identifier and does not claim a
signed draft review. The CLI-generated follow-up is discoverable; it is not a
formal Story or a signed completion artifact. Audit e8fd21e4's contrary claim
that these files were hand-authored or must live in configured active Story
storage is contradicted by the executed command and this current handler.

## Measured child budgets

Measured on this host during the complete boundary command (both children exited
zero). These are observations, not portable performance promises.

| Child | Observed ms | Budget ms | Observed headroom |
|---|---:|---:|---:|
| version-release-contract | 4543.767 | 270000 | 59.4x |
| live-static-scan | 1259.184 | 60000 | 47.6x |

The live scan budget is the named STATIC_EVIDENCE_LIVE_SCAN_TIMEOUT_MS constant.
The release budget conservatively sums four 60-second CLI allowances plus 30
seconds of setup/negative-control allowance; the measured complete child above
includes that setup. Both remain comfortably above the observed execution and
emit measured elapsed/budget/status fields on every replay. A budget overrun has
LAB_REGRESSION_BUDGET_EXCEEDED, distinct from transport failure and ordinary
assertion failure. A real timed-out subprocess pins the budget diagnostic.
