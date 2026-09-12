# Native lock Lab follow-up provenance

The coverage follow-up was created through the repository-local official CLI:
`node bin/proof-or-stop.js story_draft`. Its creation output was:

```text
Draft 'native-lock-regression-coverage' created at docs/story/drafts/native-lock-regression-coverage/
```

The read-only `node bin/proof-or-stop.js story_draft_list` returns:

```text
  - native-lock-regression-coverage: Schedule native lock regressions and extend full-validation writer coverage
```

The current creation handler at packages/main/src/handlers/story-draft.ts
(SHA-256 `327b4ddb5589c148df3fc16624f5dfcbb9b03cc1f971e2902e7a69ab951fa76d`) explicitly defines:

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

It writes background.md, checklist.json and index.json and the list command reads
the same directory. The draft intentionally has no B identifier or signed draft
review yet. It is a CLI-created discoverable follow-up owned by the framework
validation-maintenance backlog, not a formal Story or signed completion claim.
The deferred work is routine registration and a combined full-validation writer
witness. Existing focused writer exclusion and preserved routine PASS remain
separate from dual-order fresh signed publication and post-command lock coverage.
