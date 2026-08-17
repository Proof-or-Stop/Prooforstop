## CHK-001

Add one canonical liveness-guidance module in the core layer. It must distinguish running/background, unknown/unreachable, and authoritative terminal states. Elapsed time only triggers a host-native status check; it never proves a stall. Continue monitoring the same task identity while running or unknown. Permit at most one replacement only after failed, cancelled, missing/dead, or explicit operator cancellation, with the reason recorded and the former task unable to write. Keep explicit subprocess timeout contracts out of this policy.

## CHK-002

Render the canonical policy from every active dispatch and recovery surface: the shared role dispatch helper, special INIT prompts, story creation guidance, the INIT guard recovery hint, and REVIEW transition guidance. Preserve each role's existing result/reporting duties and aliases while eliminating elapsed-only restart instructions.

## CHK-003

Change focused smoke tests first so the old 4/10-minute restart wording fails. Cover foreground and explicit background work beyond 600 seconds, unknown status, authoritative terminal status, single-replacement behavior, every active guidance surface, and negative scans for residual elapsed-only restart text. Keep the existing provider.codex and cross-host bounded subprocess timeout assertions unchanged, then run build plus focused and routine validation.
