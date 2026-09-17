# Isolated Claude and Grok review authentication

Formal managed reviewers retain the existing signed subject, private build,
read-only source, disposable execution worktree, process admission and terminal
receipt checks. Authentication availability alone is never review approval.

Claude accepts its existing supported credential file or noninteractive
authentication environment. On macOS, when the selected configuration directory
is the canonical default `~/.claude` and neither input exists, the controller
reads the `Claude Code-credentials` Keychain item once per captured snapshot using the fixed system
executable and a bounded timeout. It validates and captures only `claudeAiOauth`;
unrelated MCP credentials are omitted. The reviewer receives a private mode-0600
credential file inside its mode-0700 configuration directory. Custom Claude
directories never silently fall back to the default account. Lookup errors are
sanitized; credentials do not appear in argv, public receipts or diagnostics.

Grok captures its existing `auth.json` and TOML configuration from `GROK_HOME`
(default `~/.grok`), or uses an existing `XAI_API_KEY`. Each reviewer receives an
independent `GROK_HOME`; shared leader use and automatic updating are disabled in
the private configuration. The original home, settings and login files are not
modified. Home-level managed or requirements policy files are refused until an
adapter can preserve their semantics; they are never silently omitted.

Grok formal submissions require a configured, supported `managedReviewIsolation`
read-only lane and admitted private provider state. Unconfigured projects are
refused before creating run artifacts; they never fall back to ambient Grok state.

Both providers use the existing opaque input snapshot, keyed execution identity,
refreshed private seed, admission and owned-scratch cleanup mechanisms. A missing
login, malformed or symlinked credential file, failed provider, missing terminal
structured result, duplicate result, source drift or invalid receipt still
prevents formal evidence intake. Isolation does not authorize credential export
to a repository, shared directory, prompt or arbitrary endpoint.

Use `host_run --host=grok --managedReview` with the ordinary exact Story/run/lane
bindings, and assign `grok` explicitly in `reviewer_batch_admit`. Grok also accepts
the existing acceptance-amendment review schema. Ordinary prompt runs and managed
dispatch are refused before submission or spawn; this adapter supports only these
formal review profiles. It is attributed to `xai`, never
to Anthropic. The protected prompt-file launcher uses Grok's documented Messages
stream and accepts only a successful structured terminal proposal. Raw usage
remains in the process transcript; aggregate usage is marked unavailable because
this compatibility stream can contain placeholder zero counters. Validated live
counters provide only a lower bound for the existing burn limit.

Verification: `node scripts/verify-managed-provider-state.mjs` covers captured
credential immutability, private modes, malformed/missing/symlink refusal,
default-account-only Keychain access with sanitized failures, exclusion of MCP
credentials, private Grok state, protected prompt transport and structured result
intake. These local fixtures do not create Story evidence. Real provider probes
are recorded separately and do not substitute for independent candidate review.

Provider references: [Grok headless mode](https://docs.x.ai/build/cli/headless-scripting)
and [Grok settings](https://docs.x.ai/build/settings). Exact installed CLI help and
successful runtime observations remain necessary when provider behavior changes.
