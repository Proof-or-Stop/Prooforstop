# Route reader regression: bounded audit source context

This Lab repairs the stale direct-reader assertion and the native negative-input fixture. Production dependency and refusal semantics are unchanged; official release preparation separately updates the CLI version and package manifests. The existing registered dependency-direction entry now invokes the durable driver, which independently checks the suite's helper registration, prepares and verifies main/utils builds, and executes four-gaps, the complete original dependency suite, and static-edge verification. The original native material/head-only, history, process-fact children and timeouts are retained, with no duplicated native run.

The audited baseline for the excerpts below is `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`. For every controlling production path listed, the complete source bytes were compared with the current Lab checkout and with the original `62a5c2b385516541bdb3cd001544b83b783812e9` citation: all are byte-identical. Each source and excerpt is pinned by SHA-256 and exact inclusive lines. These developer-provided excerpts fill the audit snapshot's unchanged-dependency gap; they are not independent audit findings, signed Story evidence, or a substitute for the driver's live positive control.

Original main native modes passed. Historical B-e6d9 candidate `1d62cdb3e4cb24d1c4e70c96b9174b27741c09ee` exposed an internal `sourceCoverage: null` value that public identity JSON rejects before strict-schema unknown keys. The committed compatibility RED modeled that candidate shape only in a negative public input. The final fixture first validates both `routeInput` and the null-free two-field public projection, then adds exactly one null leaf for the null refusal assertion. The same null-free projection retains the exact unknown-property rejection. Signed positive proof and all absence, boolean, substituted, wrong-root, current-reviewer, history and progress controls remain intact.

The live mutation helper checks the actual four-gaps callback on cached current source text, then rejects adapter-body replacement and alternate static/dynamic direct imports. Its adapter mutation locates the initializer structurally. Historical loose behavior is separately characterized against fixed inline source text only; it never binds retired regexes to current production. Its exact historical callback was extracted from committed RED revision `cec884ccde`, not from an uncommitted intermediate. The direct-specifier guards expressly do not claim arbitrary transitive or computed-import coverage.

The independent driver parses the sibling suite resolved from its own repository path and demonstrates refusal after removing either helper import or top-level call. Its existing root npm entry and serial-reference membership are checked before any child. Build setup verifies current source/output bindings; failures are unavailable proof, never GREEN. The original suite retains its 600-second maximum and its individual child budgets; setup has 180 seconds, with a 600-second shared proof body below the pinned 900-second Lab budget. The pinned static verifier must report U18_STATIC_PASS and zero needs-review/unexpanded work before the final GREEN selector.

All four rejected vendor audits remain in the tool-owned Lab record: `435bf2b4-ea1c-41a1-8ff5-7fb29ac9cdcd`, `a0679828-9973-48b5-8e46-d8bc7c5f3bc5`, `78ac0073-b89e-4bd7-8d4b-a35b99b22c6c`, and `6becbb72-a29d-4741-851a-0c286490bb29`. This consolidation responds to their concrete coverage and replay findings. No audit PASS or local integration is claimed by this document. The durable pinned command is `node scripts/verify-route-reader-regression.mjs`; its full output, including static counts and native/history selectors, is retained by RED/GREEN and finish.

## Controlling current baseline: packages/main/src/registry.ts

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 235–236. Full-source SHA-256 `25550cb0956c3caddb51157ffba7b55f1c7b5e2648ec9818b9ca8f7850ac1103`; Git blob `1dd29d97bedb1e8b9a277dfc3dd0c9a307108025`; excerpt SHA-256 `fc5331c9296466fe0e2c85e556818e60d8ef98afabc33de9b98f66d469293825`.

```typescript
  registry.registerBatch(createFindingRouteHandlers(ctx, readRouteSourceRestoration));
  registry.registerBatch(createFindingHistoryHandlers(ctx, observeDeferralInvalidation, readRouteSourceRestoration));
```

## Controlling current baseline: packages/main/src/handlers/finding-route.ts

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 81–137. Full-source SHA-256 `a7dcc8a7c4da4903d6585a5bf3360255ec3e2bfecd4bdf39b400516b3854653e`; Git blob `da171c174289b4666f373acc0df3ff11e2c2882a`; excerpt SHA-256 `c493a86c6c902bb6291148330990a86e00bb45fba3294aac92efddfb13c41738`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 458–471. Full-source SHA-256 `a7dcc8a7c4da4903d6585a5bf3360255ec3e2bfecd4bdf39b400516b3854653e`; Git blob `da171c174289b4666f373acc0df3ff11e2c2882a`; excerpt SHA-256 `5126d727e550f9416fa69b0a3cc1deabd5cf43feac504db0f0a49fa1454ce0b5`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 126–178. Full-source SHA-256 `52ff4ad7ab47c6585c6cab91ceab681de9e1c2910e6d46ce0e4f50845ea84d1f`; Git blob `42f5e6ad040ee74f2404d8ce861cdd1dafda55d7`; excerpt SHA-256 `4f76e1b2d337fe217d2e538fbed8a1af980aa2b10082a9934eed222cf4df3a87`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 104–117. Full-source SHA-256 `9c3d4a2cbcc82c5d363aeafd66cfbf6963cb886747cf873431cdd7ee621e85d4`; Git blob `6f68afd1a071393b72fab2b7682288bcd9221316`; excerpt SHA-256 `9ab01bedf0fbfaab54d0ad795795616d21e4997e232c06b263713b3d1f58f42b`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 129–155. Full-source SHA-256 `f01d0931a02c8b012b55a9f784aa8a053ca542c73e32d7b71a1ecd9d9c16c26f`; Git blob `19767eaae1bff39e616df2f07140a0a74ef91e1e`; excerpt SHA-256 `3941f0871c4ca429f76b5ef12daf0a45a01c589a4661257d197b4bfd10b62c55`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 5–13. Full-source SHA-256 `8ee540ab0cf6091ede04f27509b32c4648f92e0de4c5143a2742ba2ca197b0b2`; Git blob `8697e561e67213170ff6a7dcc623a2594b5eb4b6`; excerpt SHA-256 `55c472af959964dcf0c7da9507eb67117e164f2c03910a1af09d1a1c9373f9a5`.

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

Commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, lines 28–28. Full-source SHA-256 `8ee540ab0cf6091ede04f27509b32c4648f92e0de4c5143a2742ba2ca197b0b2`; Git blob `8697e561e67213170ff6a7dcc623a2594b5eb4b6`; excerpt SHA-256 `c7810c23e3494d018c75fad6ccbb9974db2da39081610c3ff264925adc8c8245`.

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
