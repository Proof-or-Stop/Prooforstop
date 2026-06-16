# B-08a1 Execution Plan — usage ledger provider adapters (Slice 2)

Pure provider-usage adapter layer in `packages/main/src/core/usage-ledger/`,
reusing B-253e's record validator / writer / ids. NOT wired into the live
dispatch path (dispatch-runner / lattice-dispatch) — deferred to a later story.

## Approach
Per-provider adapter modules + a shared assembler:
- `adapters/anthropic.ts` — native four-field usage -> canonical {input,output,
  cacheCreation,cacheRead} + raw{providerUnits:'anthropic-usage-v1'}.
- `adapters/openai.ts` — prompt_tokens->input, completion_tokens->output,
  prompt_tokens_details.cached_tokens->cacheRead, cacheCreation=null;
  raw{providerUnits:'openai-usage-v1'}.
- `adapters/gemini.ts` — promptTokenCount->input, candidatesTokenCount->output,
  cachedContentTokenCount->cacheRead, cacheCreation=null;
  raw{providerUnits:'gemini-usage-v1'}.
- `assemble.ts` — buildProviderRecord(provider, response, correlation, attribution):
  pick adapter, assemble a full record (recordId via ids.ts, authority{mode:'local'},
  privacy flags), run the B-253e validator, return a valid record. Correlation ids
  come from ids.ts, never the provider request id.
- `streaming.ts` — extract final usage from a terminal stream event / final message,
  and partial usage on mid-stream error; provider-reported if any count exists, else
  unavailable with a reason.

Per-dimension absence = null (never 0); no usage at all = source=unavailable.

## Checklist order
CHK-001 anthropic -> CHK-002 openai -> CHK-003 gemini -> CHK-004 assembler ->
CHK-005 streaming -> CHK-006 unavailable/null semantics (cross-provider) ->
CHK-007 smoke wired.

## Verification
`packages/main/src/tasks/usage-ledger-adapter-smoke.ts` (npm test:usage-ledger-adapter):
each provider mapping incl. cache-null cases; assembler output passes the B-253e
validator; streaming terminal-event + mid-stream-error extraction; unavailable +
per-dimension null (never 0); assembled record round-trips through the B-253e writer
(opt-in ON, temp dir) and re-validates. `npm --prefix packages/main run build` clean;
`node bin/lattice.js validate --story=B-08a1`. Diff never touches dispatch-runner/
lattice-dispatch.

## Out of scope
Wiring adapters into the live dispatch path; estimate path; budget logic;
server-side signed evidence promotion; default-on. Anything outside packages/main.
