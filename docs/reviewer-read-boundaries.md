# Independent reviewer reads and owner publication

Independent readers can inspect a Story while another session owns its lease.
They must use observational commands; producing dispatch records or signed gate
evidence remains a separate operation.

| Intent | Reader command | Protected writer |
|---|---|---|
| Read a canonical role prompt with current Story/checklist context | `proof-or-stop agent_prompt --role=ROLE --storyId=B-xxxx --readOnly` | Omit `--readOnly` only when the owner intentionally prepares and records dispatch context |
| Inspect current review inventory and drift | `proof-or-stop review_inventory_status --storyId=B-xxxx` | `--refresh` persists detected invalidation under the owner and inventory lock |
| Inspect managed asset drift | `proof-or-stop check --json` | `--apply` / `--upgrade` modify managed assets and remain unavailable in advisory read-only reviewer mode |

`agent_prompt --readOnly --format=json` returns `readOnly: true`,
`canMintReviewEvidence: false`, and `envelope: null`. Its current Task Context
passes the same schema and reviewer authority-content checks. It acquires no
Story owner lease and publishes no dispatch event, Prompt Envelope or ReviewRun.
For migrated REVIEW lanes, the canonical bootstrap still requires
`review_run_start`; fetching a prompt does not replace independent review or its
required signed evidence. The INIT and product reviewer must still record their
results through their normal reviewer commands.

`dispatch` is an owner publication operation. Its non-owner refusal supplies an
executable `agent_prompt --readOnly` recovery command for registered Story-only
roles. This advice is not issued for checklist/finding/cluster targets or
purpose-bound inventory dispatches: removing those bindings would change the
review task. Those readers consume the owner's prepared dispatch. No recovery
path automatically takes over a lease.

Inventory status verifies the existing epoch and recomputes current material,
acceptance scope, reviewer roster and candidate-routing drift. A default read
may display INVALIDATED while the persisted epoch is still OPEN. This is an
unsigned observation, not a new signed fact. Explicit refresh signs and stores
the invalidation. Existing producer and gate paths continue checking live
lineage under their mutation lock and refuse stale inventory even when nobody
has refreshed its status. Corrupt signed input is never converted into a pass.

The read-only boundary concerns Story state, leases, managed assets and gate
evidence. CLI runtime diagnostics may still record activity/cache information
under the existing runtime policy. It is not a promise of zero filesystem IO.

## Regression proof

Run `npm run test:reviewer-read-boundaries`. The same executable also runs from
the process-fact contract check. It creates an isolated temporary repository,
uses production StoryStore/handlers to seed test state, and invokes this Lab's
actual CLI in distinct owner/reviewer sessions. It tests the two historical INIT
roles, inventory drift, actionable dispatch refusal and default managed checks,
alongside protected write attempts and unchanged Story bytes. It never mutates
real Story state or leases.

The historical investigation found 28 Story-aware prompt owner refusals across
8 Stories, 115 inventory-status refusals across 7 Stories, and 17 dispatch
refusals across 4 Stories in the retained 2026-08-30 through 2026-09-11 logs.
The default managed-check reviewer refusal was a separate isolated reproduction.
These are invocation counts, not defect counts or measured delay. The regression
replays the failure classes with current production code, not the old Story
state, and does not establish end-to-end Story speedup.
