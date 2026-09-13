# Route reader regression: bounded audit source context

This Lab repairs the stale direct-reader assertion and the native negative-input fixture. Production dependency and refusal semantics are unchanged; official release preparation separately updates the CLI version and package manifests. The existing registered dependency-direction entry now invokes the durable driver, which independently checks the suite's helper registration, prepares and verifies main/utils builds, and executes four-gaps, the complete original dependency suite, and static-edge verification. The original native material/head-only, history, process-fact children and timeouts are retained, with no duplicated native run.

The audited baseline for the excerpts below is `362b421aff21168dce1138afe285638f72a739ff`. For every controlling production path listed, the complete source bytes were compared with the current Lab checkout and with the original `62a5c2b385516541bdb3cd001544b83b783812e9` citation: all are byte-identical. Each source and excerpt is pinned by SHA-256 and exact inclusive lines. These developer-provided excerpts fill the audit snapshot's unchanged-dependency gap; they are not independent audit findings, signed Story evidence, or a substitute for the driver's live positive control.

Original main native modes passed. Historical B-e6d9 candidate `1d62cdb3e4cb24d1c4e70c96b9174b27741c09ee` exposed an internal `sourceCoverage: null` value that public identity JSON rejects before strict-schema unknown keys. The committed compatibility RED modeled that candidate shape only in a negative public input. The final fixture first validates both `routeInput` and the null-free two-field public projection, then adds exactly one null leaf for the null refusal assertion. The same null-free projection retains the exact unknown-property rejection. Signed positive proof and all absence, boolean, substituted, wrong-root, current-reviewer, history and progress controls remain intact.

The live mutation helper checks the actual four-gaps callback on cached current source text, then rejects adapter-body replacement and alternate static/dynamic direct imports. Its adapter mutation locates the initializer structurally. Historical loose behavior is separately characterized against fixed inline source text only; it never binds retired regexes to current production. The fixed callback is an illustrative reconstruction of former loose checks; committed RED revision `cec884ccde` remains the historical evidence, and no runtime Git-provenance check is claimed. The direct-specifier guards expressly do not claim arbitrary transitive or computed-import coverage.

The independent driver parses the sibling suite resolved from its own repository path and demonstrates refusal after removing either helper import or top-level call. Its existing root npm entry and serial-reference membership are checked before any child. Build setup verifies current source/output bindings; failures are unavailable proof, never GREEN. Setup has a maximum of 180 seconds. The driver then gives four-gaps, the original suite and static verification one shared 600-second body budget under the unchanged 900-second Lab ceiling. Each call receives min(remaining body time, its configured child maximum). The suite child maximum is 600 seconds, but preceding four-gaps time reduces its effective cap, and static receives only the remaining time. The suite retains its internal 120/120/420/120-second maxima; these are failure ceilings, not guaranteed additive allowances. The pinned static verifier must report U18_STATIC_PASS and zero needs-review/unexpanded work before the final GREEN selector.

All four rejected vendor audits remain in the tool-owned Lab record: `435bf2b4-ea1c-41a1-8ff5-7fb29ac9cdcd`, `a0679828-9973-48b5-8e46-d8bc7c5f3bc5`, `78ac0073-b89e-4bd7-8d4b-a35b99b22c6c`, and `6becbb72-a29d-4741-851a-0c286490bb29`. This consolidation responds to their concrete coverage and replay findings. No audit PASS or local integration is claimed by this document. The durable pinned command is `node scripts/verify-route-reader-regression.mjs`; its full output, including static counts and native/history selectors, is retained by RED/GREEN and finish.

## Controlling current baseline: packages/main/src/registry.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 235–236. Full-source SHA-256 `25550cb0956c3caddb51157ffba7b55f1c7b5e2648ec9818b9ca8f7850ac1103`; Git blob `1dd29d97bedb1e8b9a277dfc3dd0c9a307108025`; excerpt SHA-256 `fc5331c9296466fe0e2c85e556818e60d8ef98afabc33de9b98f66d469293825`.

```typescript
  registry.registerBatch(createFindingRouteHandlers(ctx, readRouteSourceRestoration));
  registry.registerBatch(createFindingHistoryHandlers(ctx, observeDeferralInvalidation, readRouteSourceRestoration));
```

## Controlling current baseline: packages/main/src/handlers/finding-route.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 81–137. Full-source SHA-256 `a7dcc8a7c4da4903d6585a5bf3360255ec3e2bfecd4bdf39b400516b3854653e`; Git blob `da171c174289b4666f373acc0df3ff11e2c2882a`; excerpt SHA-256 `c493a86c6c902bb6291148330990a86e00bb45fba3294aac92efddfb13c41738`.

```typescript
/** Internal composition port. Only the Story1 signed reader supplies this full
 * validated projection; no public command input can supply a reader or proof. */
export interface RouteSourceRestoration {
  sourceRoot: string;
  sourceRef: RouteSource;
  record: { storyId: string; proposalRecordId: string; currentBinding: { baseHash: string; headHash: string } };
  current: { storyId: string; headHash: string; materialHash: string; storyFilesHash: string };
  assessment: { proposalRef?: IdentityLedgerRef };
  runtimeReceiptIds: string[];
}
export type RouteSourceRestorationReader = (ctx: HandlerContext, source: RouteSource) => RouteSourceRestoration | undefined;

export function sourceRouteRecord(ctx: HandlerContext, source: RouteSource, requireCurrentReviewerEvidence = true,
  readRestoration?: RouteSourceRestorationReader) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(source.storyId);
  const bound = verifiedIdentityCarrier(ledger, source.storyId, source.recordId, identityTrust(ctx));
  if (exactLedgerRecordHash(bound.record) !== source.recordHash) throw new Error('route: source record hash mismatch');
  if (source.subjectKind === 'candidate_finding') {
    const row = readCandidates(ctx, source.storyId).candidates.find(row => row.record.recordId === source.recordId);
    if (!row || row.envelope.payload.candidateId !== source.subjectId || row.envelope.payload.currentProjectionHash !== source.subjectHash
      || row.envelope.payload.state !== 'pending_verification') throw new Error('route: candidate source moved or substituted');
    assertIdentityAnchorsCurrent(ctx, row.envelope.payload.sourceBindings);
    return { bound, candidate: row.envelope.payload };
  }
  const proposal = bound.record.payload as Record<string, unknown>;
  if (bound.record.recordType !== 'assessment_proposal' || proposal.proposalId !== source.subjectId || proposal.proposalDigest !== source.subjectHash) throw new Error('route: proposal source mismatch');
  const actor = String(proposal.assessedBy); const trust = identityTrust(ctx); const snapshot = identitySourceSnapshot(ctx);
  const restored = !requireCurrentReviewerEvidence && (proposal.materialHash !== snapshot.materialHash || proposal.headHash !== snapshot.headHash)
    ? readRestoration?.(ctx, source) : undefined;
  if (restored && (restored.sourceRoot !== realpathSync(ctx.root)
    || canonicalDigest(restored.sourceRef) !== canonicalDigest(source)
    || restored.record?.storyId !== source.storyId || restored.record.proposalRecordId !== source.recordId
    || canonicalDigest(restored.assessment?.proposalRef) !== canonicalDigest(source)
    || restored.current?.storyId !== source.storyId || restored.current.headHash !== snapshot.headHash
    || restored.current.materialHash !== snapshot.materialHash
    || restored.current.storyFilesHash !== currentStoryFilesHash(ctx.root, 'HEAD', ctx.root)
    || !Array.isArray(restored.runtimeReceiptIds) || restored.runtimeReceiptIds.length === 0)) {
    throw new Error('route: restoration source/root/current binding mismatch');
  }
  const ref = proposal.findingRef as { storyId: string; findingId: string; recordId: string };
  const findingRecord = ledger.records.find(row => row.recordId === ref.recordId);
  if (!findingRecord || ref.storyId !== source.storyId) throw new Error('route: proposal Finding subject missing');
  const currentFinding = currentFindingIdentityResolver(ctx)({ ...ref, recordHash: exactLedgerRecordHash(findingRecord) });
  if (currentFinding.recordId !== ref.recordId) throw new Error('route: source Finding superseded; bind exact current successor');
  const currentFindingHash = proposalFindingHash(ctx, { ...ref, recordHash: exactLedgerRecordHash(findingRecord) });
  if (requireCurrentReviewerEvidence) {
    const reviewerState = collectReviewerEvidenceState(ctx.store, source.storyId, ctx.root);
    if (!reviewerState.valid.some(row => row.kind === 'finding' && row.id === ref.findingId && row.agent === actor && row.reviewRunId === proposal.reviewRunId)) throw new Error('route: proposal reviewer evidence not current/eligible');
  }
  const result = verifyAssessmentProposal(proposal, { publicKey: trust.publicKey, expectedAuthorityDigest: proposalAuthorityDigest(actor),
    expectedFindingHash: currentFindingHash, expectedHeadHash: restored ? String(proposal.headHash) : snapshot.headHash,
    expectedMaterialHash: restored ? String(proposal.materialHash) : snapshot.materialHash,
    expectedStoryFilesHash: currentStoryFilesHash(ctx.root, 'HEAD', ctx.root), receipt: bound.receipt, receiptTrust: trust,
    proposalRecord: bound.record, requireReceipt: true, receiptIsCurrent: true });
  if (!result.valid || Date.parse(String(proposal.issuedAt)) > Date.now() || proposal.scopeDigest !== proposalScopeDigest(ctx, source.storyId)) throw new Error(`route: invalid proposal ${result.rejection ?? 'scope/future issuance'}`);
  return { bound, proposal, restored };
}
```

## Controlling current baseline: packages/main/src/handlers/finding-route.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 458–471. Full-source SHA-256 `a7dcc8a7c4da4903d6585a5bf3360255ec3e2bfecd4bdf39b400516b3854653e`; Git blob `da171c174289b4666f373acc0df3ff11e2c2882a`; excerpt SHA-256 `5126d727e550f9416fa69b0a3cc1deabd5cf43feac504db0f0a49fa1454ce0b5`.

```typescript
    finding_route_verify(input: unknown) {
      const args = parseIdentityInput(routeVerifySchema, input); const target = identityStoryContext(ctx, args.storyId);
      if (args.receipt.storyId !== args.storyId) throw new Error('route: target ledger reference mismatch');
      const row = exactReceipt(target, args.receipt); const receipt = row.envelope.payload;
      // The target already accepted the exact signed proposal while its reviewer
      // evidence was current. Later read-only verification must preserve that
      // historical authority across a source phase-only transition; the signed
      // proposal and exact source/head/material bindings below still fail closed.
      const source = identityStoryContext(ctx, receipt.source.storyId); sourceRouteRecord(source, receipt.source, false, readRestoration);
      if (receipt.canonicalDefect) canonicalForRoute(ctx, receipt.canonicalDefect);
      assertReceiptCurrent(receipt, targetRouteSnapshot(target, args.storyId, receipt.target.responsibility.workItemRef));
      if (receipt.initialProgressBaselineSet) baselineSetForReceipt(target, receipt);
      return { ...row, valid: true, gateEvidence: false };
    },
```

## Controlling current baseline: packages/main/src/handlers/finding-material-reattestation.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 126–178. Full-source SHA-256 `52ff4ad7ab47c6585c6cab91ceab681de9e1c2910e6d46ce0e4f50845ea84d1f`; Git blob `42f5e6ad040ee74f2404d8ce861cdd1dafda55d7`; excerpt SHA-256 `4f76e1b2d337fe217d2e538fbed8a1af980aa2b10082a9934eed222cf4df3a87`.

```typescript
/** Used by both the gate and source-route verifier. No stored 'fresh' bit. */
export function readMaterialDriftReattestation(ctx: HandlerContext, storyId: string, proposalRecordId: string) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId); const trust = identityTrust(ctx);
  const row = [...ledger.records].reverse().find(row => row.recordType === 'material_drift_reattestation'
    && (row.payload as Record<string, unknown>).action === 'unrelated_material_reattestation'
    && (row.payload as Record<string, unknown>).proposalRecordId === proposalRecordId);
  if (!row) return undefined;
  verifiedIdentityCarrier(ledger, storyId, row.recordId, trust);
  const record = row.payload as unknown as ReturnType<typeof prepareMaterialDriftReattestation>['record'] & Record<string, unknown>;
  if (!verifyDynamicFindingRecord(record, trust.publicKey) || record.storyId !== storyId || Date.parse(record.expiresAt) <= Date.now()) throw new Error('reattestation: invalid/expired signature');
  const source = verifiedIdentityCarrier(ledger, storyId, record.assessmentRecordId, trust).record;
  const claim = verifiedIdentityCarrier(ledger, storyId, record.claimRecordId, trust).record;
  const assessment = source.payload as unknown as FindingApplicabilityAssessment;
  const latest = [...ledger.records].reverse().find(item => item.recordType === 'finding_applicability_assessment'
    && (item.payload as unknown as FindingApplicabilityAssessment).findingId === assessment.findingId);
  const observer = ctx.store.readFindings(storyId).findings.find(item => item.id === assessment.findingId);
  if (latest?.recordId !== source.recordId || !observer || observer.agent === record.actor) throw new Error('reattestation: superseded assessment or non-independent actor');
  if (exactLedgerRecordHash(source) !== record.assessmentRecordHash || exactLedgerRecordHash(claim) !== record.claimRecordHash
    || assessment.proposalRef?.recordId !== proposalRecordId || assessment.findingId !== record.findingId
    || !verifyApplicabilityAssessment(assessment, trust.publicKey)) throw new Error('reattestation: wrong subject or substituted predecessor');
  const current = currentApplicabilityContext(ctx.store, ctx.root, storyId, assessment.runtimeReceiptIds);
  if (record.driftKind === 'head_only') {
    if (!assessment.integrity.materialHash || assessment.integrity.materialHash !== record.currentBinding.materialHash
      || assessment.integrity.baseHash !== record.currentBinding.baseHash || current.baseHash !== record.currentBinding.baseHash
      || assessment.integrity.headHash === record.currentBinding.headHash) throw new Error('reattestation: head-only recovery binding changed');
    assertDescendantHead(ctx, assessment.integrity.headHash, record.currentBinding.headHash);
    assertDescendantHead(ctx, record.currentBinding.headHash, current.headHash);
  } else if ((record.driftKind !== undefined && record.driftKind !== 'unrelated_material')
    || assessment.integrity.materialHash === record.currentBinding.materialHash) {
    throw new Error('reattestation: invalid material recovery kind');
  }
  if (applicabilityDigest(repairClosureContext(current)) !== applicabilityDigest(repairClosureContext(record.currentBinding))
    || current.storyFilesHash !== assessment.integrity.storyFilesHash || record.priorMaterialHash !== assessment.integrity.materialHash
    || applicabilityDigest(findingMaterialDependencySnapshot(ctx, storyId, assessment)) !== applicabilityDigest(record.dependencies)
    || applicabilityDigest(record.dependencies) !== applicabilityDigest(assessment.dependencySnapshot)
    || applicabilityDigest(checkedReexecution(ctx, storyId, record.runtime.map(row => row.priorId), record.runtime.map(row => row.currentId), true)) !== applicabilityDigest(record.runtime)) {
    throw new Error('reattestation: current dependencies drifted');
  }
  const reviewer = collectReviewerEvidenceState(ctx.store, storyId, ctx.root).valid.find(row => row.kind === 'pass'
    && row.reviewRunId === record.reviewRunId && row.pass?.id === record.reviewPassId && row.agent === record.actor);
  if (!reviewer || applicabilityDigest(reviewer.pass) !== record.reviewPassDigest) throw new Error('reattestation: reviewer authority stale');
  return { record, current, assessment, runtimeReceiptIds: record.runtime.map(row => row.currentId), materialDriftState: 'unrelated_re_attested' as const };
}

/** Composition-root adapter: rederive signed proof for this exact source on every
 * read, including progress transaction revalidation. Never accept a stored bit. */
export const readRouteSourceRestoration: RouteSourceRestorationReader = (ctx, source) => {
  const restored = readMaterialDriftReattestation(ctx, source.storyId, source.recordId);
  if (!restored) return undefined;
  if (applicabilityDigest(restored.assessment.proposalRef) !== applicabilityDigest(source)) {
    throw new Error('reattestation: route source reference mismatch');
  }
  return { ...restored, sourceRoot: realpathSync(ctx.root), sourceRef: source };
```

## Controlling current baseline: packages/main/src/core/finding-applicability-projection.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 104–117. Full-source SHA-256 `9c3d4a2cbcc82c5d363aeafd66cfbf6963cb886747cf873431cdd7ee621e85d4`; Git blob `6f68afd1a071393b72fab2b7682288bcd9221316`; excerpt SHA-256 `9ab01bedf0fbfaab54d0ad795795616d21e4997e232c06b263713b3d1f58f42b`.

```typescript
      const context = currentApplicabilityContext(args.store, args.projectRoot, args.storyId, assessment.runtimeReceiptIds);
      let state = verifyAssessmentFreshness(assessment, context, now);
      if ((state === 're_attestation_required' || state === 'mismatched') && assessment.proposalRef) {
        // A mismatch alone never releases a floor. This reader requires a
        // signed recovery, complete unchanged bindings, new executions and PASS.
        const restored = readMaterialDriftReattestation({ store: args.store, root: args.projectRoot, scanRoot: args.projectRoot }, args.storyId, assessment.proposalRef.recordId);
        if (restored?.assessment.assessmentId === assessment.assessmentId) state = 'fresh';
      }
      assessment = { ...assessment, integrity: { ...assessment.integrity, state } };
      if (state === 'fresh') {
        const proof = readApplicabilityProof({ store: args.store, root: args.projectRoot, scanRoot: args.projectRoot }, args.storyId, args.finding, assessment, false);
        assessment = { ...assessment, evidenceVerification: proof.proof };
      }
    } catch { assessment = { ...assessment, integrity: { ...assessment.integrity, state: 'incomplete' } }; }
```

## Controlling current baseline: packages/main/src/core/finding-identity.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 129–155. Full-source SHA-256 `f01d0931a02c8b012b55a9f784aa8a053ca542c73e32d7b71a1ecd9d9c16c26f`; Git blob `19767eaae1bff39e616df2f07140a0a74ef91e1e`; excerpt SHA-256 `3941f0871c4ca429f76b5ef12daf0a45a01c589a4661257d197b4bfd10b62c55`.

```typescript
/** Reject representations the signing canonicalizer would erase or coerce. */
export function assertIdentityJson(value: unknown): void {
  if (value === null || value === undefined) throw new Error('identity: null/undefined fields are forbidden');
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error('identity: sparse/decorated array refused');
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('identity: sparse/accessor array refused');
      assertIdentityJson(value[index]);
    }
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('identity: plain JSON objects required');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error('identity: non-JSON property refused');
    assertIdentityJson((value as Record<string, unknown>)[key]);
  }
}
export function identityHash(value: unknown): string { assertIdentityJson(value); return canonicalDigest(value); }
const canonicalHash = identityHash;
export function parseIdentityInput<T>(schema: z.ZodType<T>, value: unknown): T {
  assertIdentityJson(value);
  return schema.parse(value);
}
```

## Controlling current baseline: packages/main/src/core/finding-route.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 5–13. Full-source SHA-256 `8ee540ab0cf6091ede04f27509b32c4648f92e0de4c5143a2742ba2ca197b0b2`; Git blob `8697e561e67213170ff6a7dcc623a2594b5eb4b6`; excerpt SHA-256 `55c472af959964dcf0c7da9507eb67117e164f2c03910a1af09d1a1c9373f9a5`.

```typescript
export const routeText = z.string().trim().min(1);
export const routeHash = z.string().regex(/^[a-f0-9]{64}$/);
export const routeTime = z.string().datetime();
const texts = z.array(routeText).min(1);
export const ledgerRefSchema = z.object({ storyId: routeText, recordId: routeText, recordHash: routeHash }).strict();
export const routeSourceSchema = z.discriminatedUnion('subjectKind', [
  z.object({ ...ledgerRefSchema.shape, subjectKind: z.literal('candidate_finding'), subjectId: routeText, subjectHash: routeHash }).strict(),
  z.object({ ...ledgerRefSchema.shape, subjectKind: z.literal('finding_assessment_proposal'), subjectId: routeText, subjectHash: routeHash }).strict(),
]);
```

## Controlling current baseline: packages/main/src/core/finding-route.ts

Commit `362b421aff21168dce1138afe285638f72a739ff`, lines 28–28. Full-source SHA-256 `8ee540ab0cf6091ede04f27509b32c4648f92e0de4c5143a2742ba2ca197b0b2`; Git blob `8697e561e67213170ff6a7dcc623a2594b5eb4b6`; excerpt SHA-256 `c7810c23e3494d018c75fad6ccbb9974db2da39081610c3ff264925adc8c8245`.

```typescript
export const routeVerifySchema = z.object({ storyId: routeText, receipt: ledgerRefSchema }).strict();
```

## Historical candidate: packages/main/src/handlers/finding-material-reattestation.ts

Commit `1d62cdb3e4cb24d1c4e70c96b9174b27741c09ee`, lines 360–366. Full-source SHA-256 `65d074f0bb61c3afe428d01735ad0264e63ba0035afddbec6f90953af611a428`; Git blob `b32d4c1d84f77ea959efeb0dd031d32b8bda23a6`; excerpt SHA-256 `294f2cbfcd467f208e70bb26e887a2282cf4af3c16f348a1cf1bab341d31ea45`.

```typescript
  return { assessmentRecord: row, claim, record: { schemaVersion: 1, action: 'unrelated_material_reattestation',
    sourceCoverage: (() => {
      const prior = independentSourceRows(ctx, assessment, old.headHash);
      const current = independentSourceRows(ctx, assessment);
      return current.profile ? { profile: current.profile, priorHead: old.headHash, currentHead: currentApplicabilityContext(ctx.store, ctx.root, input.storyId).headHash,
        priorRows: prior.rows, currentRows: current.rows } : null;
    })(),
```

## Retained timeout diagnostics

Repeated official full-suite timeouts exposed a separate diagnostic defect: the shared subprocess helper discarded captured stdout and stderr when throwing its timeout error. The registered driver now runs a small real-child timeout regression before the original suite. The helper retains the bounded buffers and original timeout code/status/signal, and the driver explicitly renders them once before rethrowing. The regression also executes the exact caller catch body and checks normal exit, nonzero exit, ordinary signal and missing-executable behavior. Original verification commands, acceptance assertions and budgets are unchanged. This repair makes incomplete proof diagnosable; it does not turn a timeout into PASS or establish a machine-load cause.

## Fifth audit dispositions

The fifth audit (2a8861f5-7b2c-4578-9871-744168db72e2) is retained as FAIL. Its high budget finding identified an inaccurate allowance description: the original main suite already had a 600-second enclosing limit despite internal maxima totaling 780 seconds. The driver additionally charges four-gaps and static verification to the shared body. The effective caps are now stated above; no cap was increased or reduced, no completion guarantee or performance fix is claimed. Three measured passing runs (593.594, 547.759 and 536.637 seconds) and all preceding failures are retained; a timeout remains unavailable proof.

The startup finding is repaired by checking capture readiness before assertions. An actual child that produces no readiness output before the unchanged 1-second limit is tested as unavailable proof. A started POSIX child retains the known SIGTERM control. The wiring finding is repaired with a mandatory wiring selector and exact driver/helper source digests in the four existing four-gaps dependency closures. Mutation coverage now includes both registry compositions, route consumption and projection consumption as well as the original three cases. The historical callback is described as an illustrative fixed reconstruction, not an executable Git-provenance proof. Diagnostic buffer descriptors remain non-enumerable but are explicitly writable and configurable. Release notes separate initial consolidation, main sync and diagnostic closure counts.

Original main budget witness: `scripts/verify-route-reattestation-dependency-direction.mjs`, main `362b421aff21168dce1138afe285638f72a739ff`, full-source SHA-256 `41277fd1b2c25a8dc93b046c2adc6af6213eb0c9abcb6d3780bb3c035cfe2a0c`.

```javascript
const {execFileSync}=await import('node:child_process');
for (const flags of [[], ['--head-continuity']]) {
 const output=execFileSync(process.execPath,['packages/main/dist/tasks/finding-material-reattestation-smoke.js','--route-restoration-port',...flags], {cwd:root,encoding:'utf8',stdio:'pipe',timeout:120000});
 process.stdout.write(output);
 assert(output.includes('ROUTE_RESTORATION_PORT PASS'), 'ROUTE_DIRECTION_REQUIRED native restoration port controls executed');
}
// Unchanged main0.3.331 history PASS82 measured237.373s. The final v0.3.335
// release candidate passed all 82 cases in333.42s, proving the former300s cap
// could kill a green child. Retain a finite420s bound (~26% measured headroom)
// below the registered600s outer command budget; production timeouts are unchanged.
const historyOutput=execFileSync(process.execPath,['packages/main/dist/tasks/finding-identity-lineage-smoke.js','--section=history'],{cwd:root,encoding:'utf8',stdio:'pipe',timeout:420000,killSignal:'SIGKILL'});
process.stdout.write(historyOutput);
assert(historyOutput.includes('FINDING_IDENTITY_ROUTES PASS') && historyOutput.includes('FINDING_IDENTITY_HISTORY PASS'), 'ROUTE_DIRECTION_REQUIRED original route/progress/history regressions execute');
const contractOutput=execFileSync(process.execPath,['scripts/verify-process-fact-contract.mjs','--quiet'],{cwd:root,encoding:'utf8',stdio:'pipe',timeout:120000});
```

Static fail-closed witness: `scripts/verify-validation-static-edges.mjs`, unchanged main/current source SHA-256 `02a99c340cb354bdf55a51cfc338eb450ceb89fa569e03a0f3fae896b4173b9f`.

```javascript
for(const {ex,index,key} of exceptionUses){const required=new Set([...coverage.filter(x=>x.index===index&&x.file).map(x=>x.file),...packageScripts.filter(x=>x.index===index).map(x=>x.file)]);const deps=ex.dependencyDigests;if(!deps||typeof deps!=='object'||Array.isArray(deps)||[...required].some(file=>typeof deps[file]!=='string'||!fs.existsSync(path.join(root,file))||hash(fs.readFileSync(path.join(root,file)))!==deps[file])){for(const row of rows)if(row.index===index&&row.key===key){row.state='NEEDS_REVIEW';row.reason='exception dependency coverage missing or changed';}}}
const currentConfigDigest=hash(JSON.stringify(commands)),stale=manifest.entries.filter(e=>!observed.has(e.id)).map(e=>e.id),configDrift=manifest.configDigest!==currentConfigDigest;
const report={schema:'u18-static-edges.v1',commandCount:commands.length,registeredCount:registered.length,currentConfigDigest,configDrift,staleExceptions:stale,packageScripts,coverage,rows,summary:{needsReview:rows.filter(r=>r.state==='NEEDS_REVIEW').length,nested:rows.filter(r=>r.state==='NESTED_REGISTERED').length,skipped:rows.filter(r=>r.state==='CONFIG_BRANCH_SKIPPED').length,exceptions:rows.filter(r=>r.state==='EXCEPTION').length,unexpandedCommands:coverage.filter(r=>r.state==='NEEDS_REVIEW').length}};
if(process.env.U18_STATIC_REPORT_PATH)fs.writeFileSync(process.env.U18_STATIC_REPORT_PATH,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));console.log('U18_STATIC_'+(configDrift||stale.length||report.summary.needsReview||report.summary.nested||report.summary.unexpandedCommands?'NEEDS_REVIEW':'PASS'));process.exitCode=configDrift||stale.length||report.summary.needsReview||report.summary.nested||report.summary.unexpandedCommands?1:0;
```

## Sixth audit recovery

Audit 05f8d31c-20f9-4451-b74d-d42c65df95ce remains FAIL. Its accepted wiring, null-refusal, budget-description and descriptor repairs remain intact. The driver now binds all five modified members of its verification path: itself, wiring controls, timeout diagnostics, original dependency suite and the shared subprocess helper. The four existing four-gaps entries hold the exact hashes; the registered diagnostic executes the actual driver binding program against current positive bytes and rejects replacement of each of the five members independently. Existing four-gaps and native smoke inputs remain bound in those entries. The shared helper imports unchanged full-suite build-binding code; no claim of a repository-wide import closure is made.

The caller test now finds the unique try statement with the direct spawnSync assignment using the TypeScript AST. An earlier unrelated catch is present in the test input, and removal of the actual spawn call must fail discovery instead of accepting the unrelated handler. Official target RED recorded this lookup defect. The negative no-readiness fixture keeps its one-second timeout and five-second local ceiling. Only the newly introduced positive fault-injection fixture changes to ten seconds with a fifteen-second local ceiling; it still intentionally times out after emitting both streams. These are fixture limits before build setup, not native-suite performance acceptance thresholds. Original setup 180 seconds, shared body 600 seconds, Lab 900 seconds and internal 120/120/420/120-second caps are unchanged.

## Inherited main baseline closure and canonical proof

Main `362b421aff21168dce1138afe285638f72a739ff` independently reproduced 115 static needs-review rows and 14 nested rows. All twelve old source preimages were recovered from Git. The reviewed static repair changes 80 existing entries while preserving 266 rows, IDs, duplicate IDs, ordering, classifications and invocation membership. Fifty report rows retain their exact call digest with relocated source/line evidence; four contexts refer to the one EX-0178 spawn whose sole AST-call delta is the canonical watchdog environment property shown below. Removing only that property reconstructs the old call. The remaining drift is dependency binding. Twenty-six runtime-policy keys bind entries already dependent on the changed executor/isolated fixture; no new exception is granted. Review confirmed the configured inventory consumers still do not execute the full-suite executor.

The canonical fixture separately restores the exact store-to-causal-evidence imported origin, keeps its two uses, and updates the reviewed process-fact registry import context from 23 to 24 after its new default-parameter use. It retains source/emitted totality and central-literal, added-reference and same-count mutation refusal. Main certification count remains 65. The official identity-sites group RED exposed the registry pin drift; the causal-specific oracle RED is separate evidence. Actual identity-sites group GREEN passed in 20.185 seconds after both bounded fixes, and combined static GREEN passed in 1.288 seconds with 326 exceptions and zero pending work. These focused results do not replace full official Lab GREEN.

The original pinned driver now requires the exact identity-sites group selector before the unchanged native suite, followed by static verification. The added child has a maximum of 180 seconds capped by remaining shared body time; overall budgets are unchanged. Four existing closure entries bind 23 explicit source/context paths and include the actual driver invocation as structured source evidence. This list covers the six modified verification members, controlled context/data imports and causal inputs; it does not claim every recursively loaded module. Broader source/emitted coverage remains the canonical census and current build binding. Every listed member is independently replaced by the registered diagnostic refusal control.

Incoming main witness `packages/main/src/tasks/full-suite-runner.ts`, lines 684–692, full-source SHA-256 `56d468ece510aff2cbc082ce4a36c6f756c029814acea4601928381c29f0e058`, excerpt SHA-256 `9aa587771bb6d2623c25b1f393f435088dbcd9b8019536554dbd28e5349364f8`.

```typescript
    const usePosixTime = process.platform !== 'win32' && existsSync('/usr/bin/time') && npmCommand === 'npm';
    const command = usePosixTime ? '/usr/bin/time' : npmCommand;
    const timingPath = join(tempRoot, 'cpu.time');
    const commandArgs = usePosixTime ? ['-p', '-o', timingPath, npmCommand, 'run', entry.name] : ['run', entry.name];
    const child = spawn(command, commandArgs, {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY.environmentKey]: JSON.stringify({entry:entry.name,timeoutMs:entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,deadlineAt:outerDeadlineAt}), PROOF_OR_STOP_FULL_SUITE_TEMP_ROOT: tempRoot, PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN: ownershipToken, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
    });
    // B-137a: capture the child's kernel start identity BEFORE any cleanup can
```

Incoming main witness `packages/main/src/tasks/isolated-finding-fixture.ts`, lines 10–29, full-source SHA-256 `5a1232af7d0e9d216207b3bd11908081452b5786bb70ff06119ceaa914ef4997`, excerpt SHA-256 `9af4fd593c007d5d4037bcaf417eee9531895906d6aba44e59c54c51db3585ab`.

```typescript
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';

/** Bound the inner watchdog by the scheduler's actual remaining outer deadline. */
export function reviewEpochFixtureBudgetMs(environment: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const raw = environment[epochBudget.environmentKey];
  if (raw === undefined) return epochBudget.standaloneMs;
  const value = JSON.parse(raw) as {entry?:unknown;timeoutMs?:unknown;deadlineAt?:unknown};
  if (!value || typeof value !== 'object' || typeof value.entry !== 'string') throw new Error('Malformed review epoch fixture budget envelope');
  // A descendant may inherit another member's envelope; it is not this fixture's budget.
  if (value.entry !== epochBudget.entry) return epochBudget.standaloneMs;
  if (!Number.isFinite(value.timeoutMs) || !Number.isFinite(value.deadlineAt)
    || Number(value.timeoutMs) <= 0) throw new Error(`Invalid review epoch fixture outer budget for ${epochBudget.entry}`);
  const outerMs = Math.min(Number(value.timeoutMs), epochBudget.maxOuterMs);
  if (Number(value.timeoutMs) > epochBudget.maxOuterMs) process.stderr.write(`Review epoch fixture ${epochBudget.entry}: outer timeoutMs=${value.timeoutMs} exceeds REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY.maxOuterMs=${epochBudget.maxOuterMs}; clamping watchdog input to ${outerMs} ms\n`);
  const scaled = Math.min(epochBudget.maxConcurrentMs, epochBudget.standaloneMs * outerMs / epochBudget.outerStandaloneMs);
  const remaining = Math.min(outerMs, Number(value.deadlineAt) - now) - epochBudget.cleanupMarginMs;
  const budget = Math.floor(Math.min(scaled, remaining));
  if (budget <= 0) throw new Error('Review epoch fixture outer deadline exhausted');
  return budget;
}
```

Incoming main witness `packages/main/src/core/runtime-fact-registry.ts`, lines 12–21, full-source SHA-256 `2a50979405c7a3a56466c259f02591c83aa6c678f9c1db6a25fe670c6d4d8231`, excerpt SHA-256 `18c755ac3a951eb64141ffe27112c868b6c39059ba9ad091b54e90ef066f029c`.

```typescript
export const REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY = {
  environmentKey: 'PROOF_OR_STOP_FULL_SUITE_ENTRY_BUDGET',
  entry: 'test:review-epoch-certification-continuity',
  standaloneMs: 420000, maxConcurrentMs: 540000, outerStandaloneMs: 450000,
  maxOuterMs: 675000, cleanupMarginMs: 30000,
} as const;
export const MACHINE_HEAVY_RESOURCE_POLICY = { cpuKey: 'heavy', processKey: 'fanout', access: 'exclusive', admission: 'one-heavy-member-per-os-user' } as const;
export const MACHINE_FIXED_PORT_RUNTIME_POLICY = { directoryMode: 0o700, probeTimeoutMs: 1000, queueDeadlineMs: 300000, scope: 'same-os-user-across-repositories', admissionBoundary: 'actual-command-child', unknownResources: 'exclusive-machine-queue', classifiedEmptyResources: 'shared-machine-barrier', barrierKey: 'admission' } as const;
export const MANAGED_REVIEW_TEMP_RUNTIME_POLICY = { environmentKeys: ['TMPDIR', 'TMP', 'TEMP'], directoryMode: 0o700, isolation: 'per-managed-review-scratch' } as const;
export const OWNER_SESSION_IDENTITY_RUNTIME_POLICY = {
```

Incoming main witness `packages/main/src/core/causal-evidence.ts`, lines 28–33, full-source SHA-256 `414a2f3a612b4b10601c3c6d071c3ab67440c68305e2c4d2bbc8760d1ca2df9f`, excerpt SHA-256 `d86e435b069b221b31f9b9d29aebbd9541fa3dce3a1ef3d9c701d4554827331a`.

```typescript
export const CAUSAL_LEDGER_SCHEMA = 'proof-or-stop.causal-evidence-ledger.v1' as const;
export const CAUSAL_PREFLIGHT_SCHEMA = 'proof-or-stop.causal-evidence-preflight.v1' as const;
export const CAUSAL_DEPENDENCY_SCHEMA = 'proof-or-stop.causal-dependency-decision.v1' as const;
export const CAUSAL_EVIDENCE_INDEX_SCHEMA = 'proof-or-stop.causal-evidence-index.v1' as const;
export const CAUSAL_RECEIPT_DIRECTORY = 'causal-evidence/receipts';
export const CAUSAL_OUTPUT_DIRECTORY = 'causal-evidence/outputs';
```

Incoming main witness `packages/main/src/core/store.ts`, lines 870–878, full-source SHA-256 `be0cbd652539eb44ecc66a435d909e632a551f25c6e64efeff72b7c502d2a5d6`, excerpt SHA-256 `c73efa627679f616423a166b5d6dd2efd7c409e49e6dd54903f961b6499a1b03`.

```typescript
    const indexPath = this.storyFilePath(storyId, CAUSAL_RECEIPT_INDEX_FILE);
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        if (index.schemaVersion === CAUSAL_EVIDENCE_INDEX_SCHEMA
          && index.receipts && typeof index.receipts === 'object' && !Array.isArray(index.receipts)
          && Object.entries(index.receipts).every(([key, hash]) => verified.get(key) === hash)) outputs.push(indexPath);
      } catch { /* Invalid index remains workspace pollution. */ }
    }
```

Incoming main witness `packages/main/src/core/process-fact-registry.ts`, lines 2673–2683, full-source SHA-256 `885d7a13f1d8b2d37dcf6ed320e71854c6b18dfc32b8f25cdd2b491abbe447bc`, excerpt SHA-256 `d560d4cb2b792f4a571d8e01233b21fcc95aa895ac523dab5be3b4c38d3c08b4`.

```typescript
 * malformed entries contribute no validation authority.
 */
export function collectRepositoryFullProcessFactPaths(
  entries: readonly unknown[] = PROCESS_FACT_REGISTRY,
): { paths: string[]; rejectedEntryCount: number; floorOwnerIds: string[] } {
  const paths = new Set<string>();
  const floorOwnerIds = new Set<string>();
  let rejectedEntryCount = 0;
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== 'object') {
      rejectedEntryCount += 1;
```
