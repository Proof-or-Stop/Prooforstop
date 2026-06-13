## Trigger Event
On 2026-06-13, the user provided /Users/jek/Documents/Work/Koala/cord-team/authority_trust.env and asked to place it at the Lattice CLI root so future Authority Server operations can use it by default. Ref: current Authority readiness failures with missing URL/key.

## Key Insights
The file appears to contain trust/profile variables such as LATTICE_AUTHORITY_LIVE_URL, LATTICE_AUTHORITY_LIVE_PUBLIC_KEY, LATTICE_AUTHORITY_TRUSTED_SERVER_PUBLIC_KEY_DIGEST, and LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE. These should be treated as local secret/trust material and not committed.

## Solution Tradeoffs
Do not add arbitrary dotenv behavior for every command. Load a narrowly scoped root authority_trust.env only inside Authority config resolution, with explicit CLI/env values taking precedence, and keep off mode no-network/no-authority semantics intact unless an Authority command explicitly asks for Authority mode.

## Conversational Texture
The user wants Authority Server setup to become usable by default, but the core Lattice principle still applies: local config can enable connection readiness, not Authority completion claims without verified receipts.
