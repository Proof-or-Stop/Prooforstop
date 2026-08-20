## Trigger Event
On 2026-08-20, after B-cc10 merged and published as Proof-or-Stop 0.3.266, the operator asked to continue the identity migration: remaining lattice tokens in role IDs, managed-block markers, artifact schemas, the approval schema, the root package name, sibling packages, and the npm bin alias should become proof-or-stop forms.

## Key Insights
B-cc10 and B-cdf6 froze these identifiers because they sit on evidence, spawn, or publish contracts. The freeze was scope, not a permanent product decision. The safe pattern is already proven: read both names, write only the canonical name, never rewrite archived story files or signature salts. Role IDs already have a target map in the agent-prompt consolidation plan (proof-or-stop-*). Schema strings should keep their .vN suffix and only change the lattice. prefix. Root and sibling npm names are publish-level and must move together with imports and the pre-push self-host name set.

## Solution Tradeoffs
Prefer dual-read plus new-write over rewriting historical JSON, which would invalidate signatures and falsify the audit trail. Prefer the existing proof-or-stop-* role map over inventing a second naming scheme. Prefer removing the leftover npm lattice bin alias now that bin/lattice.js is gone, rather than keeping a command that no longer has a repo wrapper. Do not include signature-salt rename in this story; salts remain hashed into persisted _hash fields.

## Conversational Texture
The operator wants the remaining visible lattice identities gone, not another compatibility essay. Success is that new CLI output, new artifacts, new agent spawn IDs, and npm names say proof-or-stop, while old stories and installed CLAUDE.md blocks still load without a tamper storm.
