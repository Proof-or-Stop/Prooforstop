## Trigger Event
On 2026-06-19, a developer submitted Authority job B-0717 successfully and verified the server verdict endpoint directly with the customer key, but the CLI authority_job_status command returned 401 because its GET request omitted Authorization.

## Key Insights
Policy discovery should remain keyless, but protected Authority job status reads are not public discovery. They must use the same configured customer API key source as other server-backed Authority traffic without claiming completion from missing receipts.

## Solution Tradeoffs
Keep the fix small by adding an authenticated read path only for protected job verdict/status reads. Do not send customer keys to public policy discovery and do not change receipt/quorum semantics or local fallback behavior.

## Conversational Texture
The user wants staging to be testable with simple credentials, but also wants Lattice to avoid overclaiming. The CLI should make the real server check work, then honestly report no runner receipt or quorum when those are still missing.
