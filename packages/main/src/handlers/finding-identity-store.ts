/** Story 2 semantic adapter over Story 3A's existing fenced append port. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalHash, canonicalJson, validateEnvelope, verifyFindingLedgerReceipt, findingLedgerSignerFromWorkspace,
  currentFindingLedgerTrustFromWorkspace, type FindingLedgerReceiptTrust, type FindingLedgerSigner,
  type JsonValue, type LedgerEnvelope, type LedgerRecord } from '../core/finding-ledger.js';
import { appendFindingLedger, exactLedgerRecordHash } from './finding-ledger.js';
import { captureMkdirLockFence, withMkdirLock } from '../core/mkdir-lock.js';
import { mainWriteLockPath, withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signIdentityEnvelope, verifyIdentityEnvelope, identityHash, validateCanonicalDefect, sortedUnique } from '../core/finding-identity.js';
import type { IdentitySemanticEnvelope, IdentitySourceAnchor } from '../core/finding-identity-types.js';
import type { FindingLedgerReceipt, FindingLedgerOperation } from '../core/types.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { StoryStore } from '../core/store.js';
import { resolveStorySignedWorkspace } from '../core/story-signed-workspace-resolution.js';
import { loadConfig } from '../core/config.js';
import { join } from 'node:path';
import { verifyFinding } from '../core/finding-verify.js';
import type { FindingIdentityRef } from '../core/finding-identity-types.js';
import type { CanonicalDefect } from '../core/finding-identity-types.js';
import { validateSupersession, validateHistoryGraph, canonicalCurrent, type HistoryInput, type HistoryNode, type HistorySupersession } from '../core/finding-history.js';
import { PROOF_OR_STOP_STORY_DIR_NAMES, LEGACY_DOCS_STORY_DIR } from '../core/proof-or-stop-paths.js';

/** Serialize catalog-wide identity decisions without inventing a cross-ledger CAS. */
export function withIdentityCatalogLock<T>(ctx: HandlerContext, run: () => T): T {
  return withReentrantMainWriteLock(resolveMainRepoRoot(ctx.root), run, { label: 'canonical identity catalog', onContention: 'wait' });
}
export function historicalStoryContext(ctx: HandlerContext, storyId: string): HandlerContext {
  const main = resolveMainRepoRoot(ctx.root); const mainStore = new StoryStore(main);
  const store = mainStore.storyExists(storyId) ? mainStore : ctx.store;
  const story = store.readStory(storyId);
  // Closed Stories may have intentionally removed their signed worktree. Their
  // canonical metadata is history, not a newly current source snapshot.
  if (story.phase === 'DONE' || story.phase === 'DISCARDED') return { ...ctx, root: store.projectRoot, store };
  return identityStoryContext(ctx, storyId);
}
export function identityCatalogStoryIds(ctx: HandlerContext): string[] {
  return sortedUnique([...new StoryStore(resolveMainRepoRoot(ctx.root)).listStoryIds(), ...ctx.store.listStoryIds()]);
}
/** Absence is inspected through canonical Store ports before requiring a live home. */
export function identityCatalogContributor(ctx: HandlerContext, storyId: string, kinds: readonly string[]): HandlerContext | undefined {
  const mainRoot = resolveMainRepoRoot(ctx.root); const mainStore = new StoryStore(mainRoot);
  const metadata = mainStore.storyExists(storyId) ? mainStore : ctx.store;
  const candidateLedgers: LedgerEnvelope<JsonValue>[] = [metadata.readFindingLedger<JsonValue>(storyId)];
  if (ctx.store.storyExists(storyId) && realpathSync(ctx.store.projectRoot) !== realpathSync(metadata.projectRoot))
    candidateLedgers.push(ctx.store.readFindingLedger<JsonValue>(storyId));
  const contributes = candidateLedgers.some(ledger => {
    validateEnvelope(ledger);
    return ledger.records.some(row => kinds.includes(row.recordType));
  });
  if (!contributes) {
    // Probe the resolved home through the same workspace-resolution and Store
    // ports without loading that workspace's unrelated runtime configuration.
    // This distinguishes an empty foreign worktree from the only live catalog
    // contributor while preserving the fail-closed path for relevant homes.
    const resolution = resolveStorySignedWorkspace({ store: metadata, storyId, metadataRoot: metadata.projectRoot, cwd: ctx.root });
    if (!resolution.resolved || !resolution.signedWorkspaceRoot) return undefined;
    const resolvedStore = new StoryStore(realpathSync(resolution.signedWorkspaceRoot), { trustedStoryDir: metadata.trustedStoryDir });
    const resolvedLedger = resolvedStore.readFindingLedger<JsonValue>(storyId); validateEnvelope(resolvedLedger);
    if (!resolvedLedger.records.some(row => kinds.includes(row.recordType))) return undefined;
  }
  try {
    // Resolve the signed Story workspace even when the main/current mirrors are
    // empty: another active worktree may be the only current contributor. This
    // still reads exclusively through StoryStore and signed-workspace ports.
    const source = historicalStoryContext(ctx, storyId);
    const current = source.store.readFindingLedger<JsonValue>(storyId); validateEnvelope(current);
    return current.records.some(row => kinds.includes(row.recordType)) ? source : undefined;
  } catch (error) {
    // An unrelated not-yet-resolved Story with no signed contribution is not a
    // broken identity catalog. Relevant missing homes and all parse errors refuse.
    if (!contributes && error instanceof Error && error.message === 'identity: unresolved Story workspace') return undefined;
    throw error;
  }
}
export function readCanonicalCatalog(ctx: HandlerContext): { input: HistoryInput; rows: VerifiedIdentityRow<CanonicalDefect>[]; pending: VerifiedIdentityRow<CanonicalDefect>[] } {
  const input: HistoryInput = { nodes: [], links: [], sourceBindings: [] }; const rows: VerifiedIdentityRow<CanonicalDefect>[] = []; const revisions: VerifiedIdentityRow<CanonicalDefect>[] = [];
  for (const storyId of identityCatalogStoryIds(ctx)) {
    const source = identityCatalogContributor(ctx, storyId, ['canonical_defect', 'canonical_revision', 'canonical_defect_supersession']);
    if (!source) continue;
    const ledger = source.store.readFindingLedger<JsonValue>(storyId);
    validateEnvelope(ledger);
    const kinds = ['canonical_defect', 'canonical_revision', 'canonical_defect_supersession'];
    const records = ledger.records.filter(row => kinds.includes(row.recordType));
    input.sourceBindings.push({ storyId, digest: canonicalHash(records) });
    if (!records.length) continue;
    const canonicalRows = readIdentityRows<CanonicalDefect>(source, storyId, ['canonical_defect', 'canonical_revision'], (_kind, value) => validateCanonicalDefect(value)); rows.push(...canonicalRows);
    revisions.push(...canonicalRows.filter(row => row.envelope.kind === 'canonical_revision'));
    for (const row of canonicalRows) {
      const value = row.envelope.payload; const paths = sortedUnique(value.evidenceAnchors.map(anchor => anchor.path));
      input.nodes.push({ observationKey: `canonical:${row.record.recordId}`, kind: 'canonical', storyId, entityId: value.canonicalDefectId,
        ref: { storyId, recordId: row.record.recordId, recordHash: exactLedgerRecordHash(row.record) }, paths,
        packages: historyPackages(paths), symbols: [...value.affectedSymbols], contracts: [...value.affectedContracts], canonicalIds: [value.canonicalDefectId],
        sourceLineageKeys: [...value.sourceLineageKeys], outcome: 'reviewer_confirmed', payload: value, evidenceAnchors: [...value.evidenceAnchors] });
    }
    input.links.push(...readIdentityRows<HistorySupersession>(source, storyId, ['canonical_defect_supersession'], (_kind, value) => validateSupersession(value)).map(row => row.envelope.payload));
  }
  const activated = new Set(input.links.map(link => link.successor.recordId));
  const pending = revisions.filter(row => !activated.has(row.record.recordId)); const pendingIds = new Set(pending.map(row => row.record.recordId));
  input.nodes = input.nodes.filter(node => !pendingIds.has(node.ref!.recordId));
  validateHistoryGraph(input); return { input, rows: rows.filter(row => !pendingIds.has(row.record.recordId)), pending };
}
function historyPackages(paths: string[]): string[] {
  return sortedUnique(paths.flatMap(path => { const match = path.match(/(?:^|\/)packages\/([^/]+)(?:\/|$)/); return match ? [`packages/${match[1]!}`] : []; }));
}
export function historicalFindingRef(ctx: HandlerContext, ref: FindingIdentityRef) {
  const data = ctx.store.readFindings(ref.storyId, { strictMirror: true }); const finding = data.findings.find(row => row.id === ref.findingId && row.recordId === ref.recordId);
  const ledger = ctx.store.readFindingLedger<JsonValue>(ref.storyId); const record = ledger.records.find(row => row.recordId === ref.recordId);
  identityTrust(ctx); return verifyHistoricalFinding(ref, finding, record);
}
/** Resolve only verified linked Findings; unrelated legacy mirrors are not catalog authority. */
export function currentFindingIdentityResolver(ctx: HandlerContext): (ref: FindingIdentityRef) => FindingIdentityRef {
  const input: HistoryInput = { nodes: [], links: [], sourceBindings: [] };
  const refs = new Map<string, FindingIdentityRef>();
  for (const storyId of identityCatalogStoryIds(ctx)) {
    const source = identityCatalogContributor(ctx, storyId, ['finding_supersession']);
    if (!source) continue;
    const ledger = source.store.readFindingLedger<JsonValue>(storyId);
    if (!ledger.records.some(row => row.recordType === 'finding_supersession')) continue;
    for (const row of readIdentityRows<HistorySupersession>(source, storyId, ['finding_supersession'], (_kind, value) => validateSupersession(value))) {
      const link = row.envelope.payload; input.links.push(link);
      for (const [ref, findingId] of [[link.predecessor, link.predecessorEntityId], [link.successor, link.successorEntityId]] as const) {
        const full = { ...ref, findingId }; const prior = refs.get(ref.recordId);
        if (prior && identityHash(prior) !== identityHash(full)) throw new Error('history: linked Finding identity alias');
        refs.set(ref.recordId, full);
      }
    }
  }
  for (const ref of refs.values()) {
    historicalFindingRef(historicalStoryContext(ctx, ref.storyId), ref);
    const { findingId, ...ledgerRef } = ref;
    input.nodes.push({ observationKey: `finding:${ref.recordId}`, kind: 'finding', storyId: ref.storyId, entityId: findingId,
      ref: ledgerRef, findingRef: ref, paths: [], packages: [], symbols: [], contracts: [], canonicalIds: [], sourceLineageKeys: [], outcome: 'verified_history', payload: {}, evidenceAnchors: [] });
  }
  validateHistoryGraph(input);
  return ref => {
    const known = refs.get(ref.recordId);
    if (!known) return ref;
    if (identityHash(known) !== identityHash(ref)) throw new Error('history: Finding reference substitution');
    return canonicalCurrent(input, ref.recordId).current.findingRef!;
  };
}
function verifyHistoricalFinding(ref: FindingIdentityRef, finding: ReturnType<StoryStore['readFindings']>['findings'][number] | undefined, record: LedgerRecord<JsonValue> | undefined) {
  if (!finding || !record || !['finding', 'legacy_identity_binding'].includes(record.recordType) || exactLedgerRecordHash(record) !== ref.recordHash
    || (record.payload as { id?: string; findingId?: string })[record.recordType === 'finding' ? 'id' : 'findingId'] !== ref.findingId
    || finding.id !== ref.findingId || finding.recordId !== ref.recordId || !verifyFinding(ref.storyId, finding)) throw new Error('history: immutable Finding reference missing/substituted/unverified');
  // Store verifies current and explicitly bound legacy carriers; no live/open predicate here.
  return { finding, record };
}
export function readHistoryCatalog(ctx: HandlerContext, storyIds: string[]): { input: HistoryInput; incomplete: string[] } {
  const canonical = readCanonicalCatalog(ctx); const input: HistoryInput = { nodes: [...canonical.input.nodes], links: [...canonical.input.links], sourceBindings: [] };
  const incomplete: string[] = [];
  for (const storyId of sortedUnique(storyIds)) {
    let source: HandlerContext;
    try { source = historicalStoryContext(ctx, storyId); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'identity: unresolved Story workspace') throw error;
      const mainStore = new StoryStore(resolveMainRepoRoot(ctx.root)); const metadata = mainStore.storyExists(storyId) ? mainStore : ctx.store;
      // Canonical metadata can prove an unrelated Story has no observations;
      // it cannot stand in for an unresolved home with contributing history.
      const findings = metadata.readFindings(storyId, { strictMirror: true }); const ledger = metadata.readFindingLedger<JsonValue>(storyId);
      if (findings.findings.length || ledger.records.some(row => ['finding_supersession', 'canonical_defect', 'canonical_revision', 'canonical_defect_supersession'].includes(row.recordType))) throw error;
      source = { ...ctx, root: metadata.projectRoot, store: metadata };
    }
    const ledger = source.store.readFindingLedger<JsonValue>(storyId); validateEnvelope(ledger);
    const findings = source.store.readFindings(storyId, { strictMirror: true }).findings;
    const recordsById = new Map(ledger.records.map(record => [record.recordId, record]));
    if (findings.some(finding => finding.recordId)) identityTrust(source);
    if (!Array.isArray(findings)) throw new Error('history: malformed Finding collection');
    input.sourceBindings.push({ storyId, digest: canonicalHash({ ledger: ledger.committedLedgerDigest, findings }) });
    for (const finding of findings) {
      const record = finding.recordId ? recordsById.get(finding.recordId) : undefined;
      if (finding.recordId && !record) throw new Error('history: claimed durable Finding record is missing');
      const ref = record ? { storyId, findingId: finding.id, recordId: record.recordId, recordHash: exactLedgerRecordHash(record) } : undefined;
      if (ref) verifyHistoricalFinding(ref, finding, record);
      const members = canonical.rows.filter(row => row.envelope.payload.memberFindingRefs.some(member => ref && identityHash(member) === identityHash(ref)));
      const paths = sortedUnique(finding.files ?? []);
      input.nodes.push({ observationKey: `finding:${storyId}:${finding.id}`, kind: 'finding', storyId, entityId: finding.id,
        ...(ref ? { ref: { storyId, recordId: ref.recordId, recordHash: ref.recordHash }, findingRef: ref } : {}), paths, packages: historyPackages(paths),
        symbols: sortedUnique(members.flatMap(row => [...row.envelope.payload.affectedSymbols])), contracts: sortedUnique(members.flatMap(row => [...row.envelope.payload.affectedContracts])),
        canonicalIds: sortedUnique(members.map(row => row.envelope.payload.canonicalDefectId)),
        sourceLineageKeys: sortedUnique([canonicalHash({ storyId, findingId: finding.id, sourceHash: canonicalHash(finding) }), ...members.flatMap(row => [...row.envelope.payload.sourceLineageKeys])]),
        outcome: finding.status, payload: { id: finding.id, desc: finding.desc, severity: finding.severity, status: finding.status, evidenceState: finding.evidenceState ?? 'verified' },
        evidenceAnchors: members.flatMap(row => [...row.envelope.payload.evidenceAnchors]) });
    }
  }
  const selectedRecordIds = new Set(input.nodes.flatMap(node => node.ref ? [node.ref.recordId] : []));
  const globalFindingLinks = identityCatalogStoryIds(ctx).flatMap(storyId => {
    const source = identityCatalogContributor(ctx, storyId, ['finding_supersession']);
    if (!source) return [];
    return readIdentityRows<HistorySupersession>(source, storyId, ['finding_supersession'], (_kind, value) => validateSupersession(value)).map(row => row.envelope.payload);
  });
  const selectedFindingLinks = globalFindingLinks.filter(link => selectedRecordIds.has(link.predecessor.recordId) && selectedRecordIds.has(link.successor.recordId));
  input.links.push(...selectedFindingLinks);
  input.sourceBindings.push({ storyId: 'finding-supersession-catalog', digest: canonicalHash(selectedFindingLinks) });
  validateHistoryGraph(input);
  for (const row of canonical.rows) {
    if (canonicalCurrent(canonical.input, row.record.recordId).superseded) continue;
    const value = row.envelope.payload;
    for (const member of value.memberFindingRefs) {
      if (!input.nodes.some(node => node.ref?.recordId === member.recordId)) continue; // Explicitly selected source subset.
      const finding = canonicalCurrent(input, member.recordId).current;
      finding.symbols = sortedUnique([...finding.symbols, ...value.affectedSymbols]);
      finding.contracts = sortedUnique([...finding.contracts, ...value.affectedContracts]);
      finding.canonicalIds = sortedUnique([...finding.canonicalIds, value.canonicalDefectId,
        ...canonicalCurrent(canonical.input, row.record.recordId).predecessors.map(node => node.entityId)]);
      finding.sourceLineageKeys = sortedUnique([...finding.sourceLineageKeys, ...value.sourceLineageKeys]);
    }
  }
  input.sourceBindings.push({ storyId: 'canonical-catalog', digest: canonicalHash(canonical.input.sourceBindings) });
  return { input, incomplete };
}

export interface VerifiedIdentityRow<T extends object = Record<string, unknown>> {
  record: LedgerRecord<JsonValue>;
  envelope: IdentitySemanticEnvelope<T>;
  receipt: FindingLedgerReceipt;
}
type Carrier = LedgerEnvelope<JsonValue>['receipts'][number] & { findingLedgerReceipt?: FindingLedgerReceipt; exactRequestDigest?: string };
export function identityStoryContext(ctx: HandlerContext, storyId: string): HandlerContext {
  const main = resolveMainRepoRoot(ctx.root); const mainStore = new StoryStore(main);
  const store = mainStore.storyExists(storyId) ? mainStore : ctx.store;
  store.readStory(storyId);
  if (storyId.startsWith('B-META-')) {
    mainStore.readStory(storyId);
    return { ...ctx, root: realpathSync(main), scanRoot: join(main, loadConfig(main).scanRoot), store: mainStore };
  }
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: store.projectRoot, cwd: ctx.root });
  if (!resolution.resolved || !resolution.signedWorkspaceRoot) throw new Error('identity: unresolved Story workspace');
  const root = realpathSync(resolution.signedWorkspaceRoot); const current = new StoryStore(root); current.readStory(storyId);
  return { ...ctx, root, scanRoot: join(root, loadConfig(root).scanRoot), store: current };
}
const heldIdentityFences = new Map<string, ReturnType<typeof captureMkdirLockFence>>();
export function identityLockPath(ctx: HandlerContext, storyId: string): string {
  return storyId.startsWith('B-META-') ? mainWriteLockPath(resolveMainRepoRoot(ctx.root)) : ctx.store.runtimeLockDirPath(storyId, 'finding', 'findings');
}
/** Acquire every involved real ledger in canonical order; append reuses only
 * fences actually held by this synchronous wrapper, never caller-provided ones. */
export function withIdentityLedgerLocks<T>(subjects: { ctx: HandlerContext; storyId: string }[], run: () => T): T {
  const mainRoots = new Map(subjects.filter(row => row.storyId.startsWith('B-META-')).map(row => {
    const main = resolveMainRepoRoot(row.ctx.root); return [mainWriteLockPath(main), main];
  }));
  const inventoryPaths = new Set(subjects.map(({ ctx, storyId }) => ctx.store.runtimeLockDirPath(storyId, 'review-inventory', 'epochs')));
  const paths = [...new Set([...inventoryPaths, ...subjects.map(({ ctx, storyId }) => identityLockPath(ctx, storyId))])].sort((a, b) =>
    Number(mainRoots.has(b)) - Number(mainRoots.has(a)) || Number(inventoryPaths.has(b)) - Number(inventoryPaths.has(a)) || a.localeCompare(b));
  const enter = (index: number): T => {
    if (index === paths.length) return run();
    const path = paths[index]!;
    if (heldIdentityFences.has(path)) return enter(index + 1);
    const held = () => {
      heldIdentityFences.set(path, captureMkdirLockFence(path));
      try { return enter(index + 1); } finally { heldIdentityFences.delete(path); }
    };
    const main = mainRoots.get(path);
    return main ? withReentrantMainWriteLock(main, held, { label: 'identity ordered canonical transaction', onContention: 'wait' })
      : withMkdirLock(path, held, { label: 'identity ordered source/target transaction', requireHolderToken: true });
  };
  return enter(0);
}
export function identityTrust(ctx: HandlerContext): FindingLedgerReceiptTrust {
  const trust = currentFindingLedgerTrustFromWorkspace(ctx.root);
  if (!trust) throw new Error('identity: signing_key_unavailable');
  return trust;
}
export function verifiedFindingRef(ctx: HandlerContext, ref: FindingIdentityRef) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(ref.storyId);
  const bound = verifiedIdentityCarrier(ledger, ref.storyId, ref.recordId, identityTrust(ctx));
  const finding = ctx.store.readFindings(ref.storyId).findings.find(row => row.id === ref.findingId);
  if (bound.record.recordType !== 'finding' || exactLedgerRecordHash(bound.record) !== ref.recordHash || !finding
    || finding.recordId !== ref.recordId || finding.evidenceState === 'suspected' || finding.evidenceState === 'disproven'
    || finding.status !== 'open' || !verifyFinding(ref.storyId, finding)) throw new Error('identity: invalid current immutable FindingRef');
  return { ...bound, finding };
}
/** Verify exact record and signed carrier; exposes bytes only to semantic callers. */
export function verifiedIdentityCarrier(ledger: LedgerEnvelope<JsonValue>, storyId: string, recordId: string,
  trust: FindingLedgerReceiptTrust): { record: LedgerRecord<JsonValue>; receipt: FindingLedgerReceipt } {
  validateEnvelope(ledger);
  const record = ledger.records.find(row => row.recordId === recordId);
  if (!record) throw new Error('identity: missing ledger record');
  const carriers = (ledger.receipts as Carrier[]).filter(row => row.recordIds.includes(recordId));
  if (carriers.length !== 1) throw new Error('identity: missing/ambiguous ledger carrier');
  const carrier = carriers[0]!; const receipt = carrier.findingLedgerReceipt;
  if (!receipt || !verifyFindingLedgerReceipt(receipt, trust) || receipt.storyId !== storyId
    || receipt.exactRequestDigest !== carrier.exactRequestDigest || !receipt.exactRequestDigest
    || receipt.receiptId !== carrier.receiptId || receipt.operation !== carrier.operation
    || receipt.idempotencyKey !== carrier.idempotencyKey || canonicalJson(receipt.recordIds) !== canonicalJson(carrier.recordIds)
    || receipt.priorLedgerDigest !== carrier.priorLedgerDigest || receipt.committedLedgerDigest !== carrier.committedLedgerDigest
    || receipt.writerSessionId !== carrier.writerSessionId || receipt.writerFenceToken !== carrier.writerFenceToken
    || receipt.committedAt !== carrier.committedAt || receipt.replayed !== false || carrier.replayed !== false) throw new Error('identity: signed ledger carrier invalid');
  // Derive each actual receipt's immutable ledger prefix, not just its claimed hash.
  const priorIds = new Set(ledger.receipts.slice(0, ledger.receipts.indexOf(carrier)).flatMap(row => row.recordIds));
  const committedIds = new Set([...priorIds, ...receipt.recordIds]);
  if (canonicalHash(ledger.records.filter(row => priorIds.has(row.recordId))) !== receipt.priorLedgerDigest
    || canonicalHash(ledger.records.filter(row => committedIds.has(row.recordId))) !== receipt.committedLedgerDigest) throw new Error('identity: carrier ledger prefix mismatch');
  return { record, receipt };
}
export function readIdentityRows<T extends object>(ctx: HandlerContext, storyId: string, kinds: readonly string[],
  validate: (kind: string, payload: unknown) => void): VerifiedIdentityRow<T>[] {
  const trust = identityTrust(ctx); const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  validateEnvelope(ledger);
  return ledger.records.filter(record => kinds.includes(record.recordType)).map(record => {
    const { receipt } = verifiedIdentityCarrier(ledger, storyId, record.recordId, trust);
    verifyIdentityEnvelope(record.payload, trust, payload => validate(record.recordType, payload));
    const envelope = record.payload;
    if (envelope.kind !== record.recordType || envelope.storyId !== storyId || record.payloadHash !== canonicalHash(envelope)) throw new Error('identity: envelope carrier subject mismatch');
    return { record, envelope: envelope as IdentitySemanticEnvelope<T>, receipt };
  });
}
export function identitySourceSnapshot(ctx: HandlerContext): { headHash: string; materialHash: string } {
  const headHash = currentGitHead(ctx.root); const materialHash = currentMaterialHash(ctx.root, 'HEAD', ctx.root);
  if (!headHash || !materialHash) throw new Error('identity: current source snapshot unavailable');
  return { headHash, materialHash };
}
export function assertIdentityAnchorsCurrent(ctx: HandlerContext, anchors: readonly IdentitySourceAnchor[]): void {
  const root = realpathSync(ctx.root);
  for (const anchor of anchors) {
    if (isAbsolute(anchor.path) || anchor.path.split(/[\\/]/).includes('..')) throw new Error('identity: source path escapes workspace');
    const path = realpathSync(resolve(root, anchor.path)); const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('identity: source realpath escapes workspace');
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== anchor.contentDigest) throw new Error(`identity: stale source anchor ${anchor.path}`);
    if (anchor.line !== undefined && anchor.line > bytes.toString('utf8').split('\n').length) throw new Error('identity: source line outside file');
  }
}
export interface IdentityAppendPlan {
  records: Array<{ kind: string; payload: object }>;
  referencedRecords: LedgerRecord<JsonValue>[];
  validate: (kind: string, payload: unknown) => void;
  revalidate?: () => void;
}
/** Reusable fenced append. A retry restores the ORIGINAL signed transaction;
 * normalized caller identity is compared before server timestamps/tips exist. */
export function appendIdentityTransaction(ctx: HandlerContext, args: {
  storyId: string; idempotencyKey: string; operation: FindingLedgerOperation; request: object;
  prepare: (ledger: LedgerEnvelope<JsonValue>, signer: FindingLedgerSigner, signing: { requestDigest: string; producedAt: string }) => IdentityAppendPlan;
  validate: (kind: string, payload: unknown) => void;
}): { rows: VerifiedIdentityRow<object>[]; receipt: FindingLedgerReceipt; replayed: boolean } {
  assertCwdInWorktree(ctx.store, args.storyId);
  const requestDigest = identityHash({ operation: args.operation, request: args.request });
  const run = (fence: ReturnType<typeof captureMkdirLockFence>) => {
    const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId); validateEnvelope(ledger);
    const existing = (ledger.receipts as Carrier[]).find(row => row.idempotencyKey === args.idempotencyKey);
    // Trust reads never manufacture keys. Only a new authorized mutation may.
    const signer = existing ? (() => {
      identityTrust(ctx); return findingLedgerSignerFromWorkspace(ctx.root);
    })() : findingLedgerSignerFromWorkspace(ctx.root);
    const trust = { ...signer, algorithm: 'ed25519' as const };
    const identity = getSessionIdentity();
    const common = { storyId: args.storyId, store: ctx.store, operation: args.operation, idempotencyKey: args.idempotencyKey,
      writerSessionId: identity.sessionId, writerLeaseId: readOwnerLease(ctx.store.storyDirPath(args.storyId))?.sessionId ?? identity.sessionId,
      writerFenceToken: fence.writerFenceToken, fence, signer };
    let receipt: FindingLedgerReceipt;
    if (existing) {
      const original = existing.recordIds.map(recordId => {
        const bound = verifiedIdentityCarrier(ledger, args.storyId, recordId, trust);
        verifyIdentityEnvelope(bound.record.payload, trust, payload => args.validate(bound.record.recordType, payload));
        if (bound.record.payload.requestDigest !== requestDigest || bound.receipt.operation !== args.operation) throw new Error('identity: IDEMPOTENCY_CONFLICT normalized request changed');
        return bound.record;
      });
      const old = existing.findingLedgerReceipt!;
      receipt = appendFindingLedger({ ...common, records: original.map(row => ({ recordType: row.recordType, payload: row.payload,
        ...(row.uniqueBindingKey !== undefined ? { uniqueBindingKey: row.uniqueBindingKey } : {}) })),
        casBindings: old.casBindings, expectedPriorLedgerDigest: old.priorLedgerDigest });
    } else {
      const producedAt = new Date().toISOString();
      const plan = args.prepare(ledger, signer, { requestDigest, producedAt }); const head = ledger.records.at(-1);
      const predicateDigest = identityHash({ requestDigest, refs: plan.referencedRecords.map(row => ({ id: row.recordId, hash: exactLedgerRecordHash(row) })) });
      const casBindings = plan.referencedRecords.map(row => ({ recordType: row.recordType, expectedRecordId: row.recordId,
        expectedRecordHash: exactLedgerRecordHash(row), observedChainHeadId: head?.recordId ?? 'ledger:empty',
        observedChainHeadHash: head ? exactLedgerRecordHash(head) : canonicalHash([]), predicateDigest }));
      const records = plan.records.map(row => ({ recordType: row.kind, payload: signIdentityEnvelope({ kind: row.kind,
        storyId: args.storyId, requestDigest, producedAt, payload: row.payload }, signer, value => plan.validate(row.kind, value)) as unknown as JsonValue }));
      plan.revalidate?.();
      receipt = appendFindingLedger({ ...common, records, casBindings, expectedPriorLedgerDigest: ledger.committedLedgerDigest,
        verifyPredicate: () => { plan.revalidate?.(); return { accepted: true, predicateDigest }; } });
    }
    const after = ctx.store.readFindingLedger<JsonValue>(args.storyId);
    const rows = receipt.recordIds.map(recordId => {
      const { record, receipt: carrier } = verifiedIdentityCarrier(after, args.storyId, recordId, trust);
      verifyIdentityEnvelope(record.payload, trust, payload => args.validate(record.recordType, payload));
      return { record, envelope: record.payload as IdentitySemanticEnvelope<object>, receipt: carrier };
    });
    return { rows, receipt, replayed: !!existing };
  };
  if (args.storyId.startsWith('B-META-')) {
    const main = resolveMainRepoRoot(ctx.root);
    const held = heldIdentityFences.get(mainWriteLockPath(main)); if (held) return run(held);
    return withReentrantMainWriteLock(main, () => run(captureMkdirLockFence(mainWriteLockPath(main))), { label: 'finding identity append', onContention: 'wait' });
  }
  const lock = ctx.store.runtimeLockDirPath(args.storyId, 'finding', 'findings');
  const held = heldIdentityFences.get(lock); if (held) return run(held);
  return withMkdirLock(lock, () => run(captureMkdirLockFence(lock)), { label: 'finding identity append', requireHolderToken: true });
}
