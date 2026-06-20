# Plan — B-2806: Adversarial-review S2 verifier (M-skeptic threshold-confirm) + finding_add ledger mapping

S2 (PARALLEL, MVP) of the adversarial-review build program (docs/adversarial-review-spec.md §2.3 + §4.2). A pure-data + injected-seam module: judge each raw Finding via M injected skeptics under refute-by-default + threshold-confirm (default T=1-of-2), and map each CONFIRMED methodology Finding to finding_add args so an abstract BLOCKER/MAJOR/MINOR never reaches the ledger. NO lens runner (S1), NO completeness critic (S3), NO finding_add/escalation I/O (S4). Imports the frozen S0 contract (core/adversarial-review.ts) verbatim.

New files:
- `packages/main/src/core/adversarial-review-verifier.ts` (the verifier + ledger mapping)
- `packages/main/src/tasks/adversarial-review-verifier-smoke.ts` (hermetic smoke)
Modified:
- `lattice.config.json` (register the smoke)

## CHK-001 — SEVERITY_TO_FINDING_KIND ledger severity map + FindingAddSeverity type
In new `packages/main/src/core/adversarial-review-verifier.ts`, importing S0 `Finding`, `FindingSeverity`, `Verdict` from `core/adversarial-review.js`:
- `export type FindingAddSeverity = 'critical' | 'high' | 'medium' | 'low';` (the finding_add enum).
- `export const SEVERITY_TO_FINDING_KIND: Record<FindingSeverity, FindingAddSeverity> = { BLOCKER: 'critical', MAJOR: 'high', MINOR: 'medium' };` exactly per §4.2 (low is reserved for cosmetic MINOR; the default map uses medium). Typed Record forces a mapping for every abstract severity.
userSees: importing the module exposes SEVERITY_TO_FINDING_KIND whose every value is a valid finding_add severity; BLOCKER->critical, MAJOR->high, MINOR->medium.

## CHK-002 — composeDesc + toFindingAddArgs ledger arg builder
- `composeDesc(finding: Finding): string` = `` `${finding.title} — ${finding.issue} Fix: ${finding.fix} (line ${finding.line})` `` (the §4.2 compose with the line cited inside the desc).
- `export interface FindingAddArgs { severity: FindingAddSeverity; desc: string; files: string[]; category: 'happy'|'edge'|'adversarial'|'missing'; reviewRunId: string; agent: string; }`.
- `export function toFindingAddArgs(finding: Finding, opts: { reviewRunId: string; agent: string; category: FindingAddArgs['category'] }): FindingAddArgs` — severity = SEVERITY_TO_FINDING_KIND[finding.severity]; desc = composeDesc(finding); files = [finding.file]; passes through reviewRunId, agent, category. Pure — returns the arg object, performs NO finding_add call (S4). NEVER emits an abstract severity; agent is caller-supplied (a real lattice-review-* lane), not invented.
userSees: toFindingAddArgs(majorFinding, {reviewRunId, agent, category}) yields {severity:'high', desc:'<title> — <issue> Fix: <fix> (line n)', files:['<file>'], category, reviewRunId, agent} with no BLOCKER/MAJOR/MINOR anywhere.

## CHK-003 — verifyFinding (M skeptics, refute-by-default, threshold-confirm T=1-of-2) + verifyFindings + confirmedFindings
- `export const DEFAULT_SKEPTICS = 2;` `export const DEFAULT_CONFIRM_THRESHOLD = 1;`
- `export interface VerifiedFinding { finding: Finding; verdicts: Verdict[]; confirms: number; confirmed: boolean; }`.
- `export function verifyFinding(finding: Finding, change: string, runSkeptic: (finding: Finding, change: string) => Verdict, opts?: { skeptics?: number; threshold?: number }): VerifiedFinding` — runs runSkeptic `M` (default 2) times collecting Verdict[]; `confirms = verdicts.filter(v => v.isReal === true).length` (STRICT — refute-by-default means only isReal===true counts; undefined/false do not); `confirmed = confirms >= T` (default T=1, threshold-confirm, NOT majority). A confirms=0 finding has confirmed=false (dropped).
- `export function verifyFindings(findings, change, runSkeptic, opts): VerifiedFinding[]` — maps verifyFinding over the array (each finding judged independently).
- `export function confirmedFindings(verified: VerifiedFinding[]): Finding[]` — returns `verified.filter(v => v.confirmed).map(v => v.finding)`.
The injected runSkeptic is the seam for the real skeptic agent (MVP: harness/main agent supplies it); refute-by-default lives in the skeptic role, the module only counts strict isReal===true and applies the threshold.
userSees: verifyFinding with a fake giving 1 isReal of 2 -> confirmed under T=1 (kept), dropped under T=2; all-false -> confirms=0 -> dropped; confirmedFindings returns only survivors.

## CHK-004 — hermetic smoke (fake runSkeptic) + register in lattice.config.json
`packages/main/src/tasks/adversarial-review-verifier-smoke.ts` (check(name,cond)+counter, explicit literals). Asserts:
- SEVERITY_TO_FINDING_KIND maps BLOCKER->critical/MAJOR->high/MINOR->medium and every value ∈ {critical,high,medium,low};
- composeDesc yields the exact `<title> — <issue> Fix: <fix> (line n)` literal;
- toFindingAddArgs returns the right shape (severity mapped, files=[file], category/reviewRunId/agent passed through) and the emitted severity is NEVER an abstract BLOCKER/MAJOR/MINOR (assert it ∈ {critical,high,medium,low});
- verifyFinding with a fake runSkeptic returning k isReal=true of M: T=1-of-2 -> 1 confirm CONFIRMED, 0 confirm DROPPED; T=2-of-2 -> 1 confirm DROPPED, 2 CONFIRMED; default M=2,T=1; refute-by-default: a fake returning isReal=false (and one returning agreedSeverity NOT_A_DEFECT) is NOT counted as confirm;
- verifyFindings over a list yields per-finding verdicts; confirmedFindings filters confirms>=T only.
Print `adversarial-review-verifier smoke passed: N assertions`. Register `node packages/main/dist/tasks/adversarial-review-verifier-smoke.js` in lattice.config.json validate.commands.
userSees: running the smoke prints the pass line with the assertion count and exits 0; lattice validate green.

## Verification
tsc compiles; the smoke passes; `lattice validate` all green. The no-abstract-leak property (severity always in {critical,high,medium,low}) + the threshold-confirm-not-majority logic (T=1 vs T=2 branches) + refute-by-default (only isReal===true counts) are all proven by the smoke. No S1/S3/S4 concerns introduced; no finding_add call.
