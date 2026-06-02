import { readFileSync } from 'node:fs';
import { buildCapabilityProbe, type CapabilityCategory, type CapabilityStatus } from './capabilities.js';
import { buildCanonicalStory, type CanonicalStory } from './canonical-story.js';
import type { StoryStore } from './store.js';

export interface HandoffCapabilityDelta {
  capability: CapabilityCategory;
  from: { host: string; status: CapabilityStatus };
  to: { host: string; status: CapabilityStatus };
  changed: boolean;
  authorityImpact: string;
}

export interface HandoffPack {
  schemaVersion: 'handoff-pack-v0';
  storyId: string;
  fromHost: string;
  toHost: string;
  canonicalStory: CanonicalStory;
  evidenceRefs: string[];
  capabilityDeltas: HandoffCapabilityDelta[];
  degradations: CanonicalStory['degradations'];
  recoveryPoint: {
    id: string;
    kind: 'handoff-pack';
    storyId: string;
    fromHost: string;
    toHost: string;
    phase: string;
    evidenceRefs: string[];
    guidance: string;
  };
  productionDone: false;
  receiptRefs: [];
}

export interface HandoffInspection {
  schemaVersion: 'koala.handoff_inspect.v1';
  storyId: string;
  fromHost: string;
  toHost: string;
  evidenceRefs: string[];
  capabilityDeltaCount: number;
  blockingDegradationCount: number;
  productionDone: false;
  receiptRefs: [];
  authority: {
    handoffCanManufactureProductionDone: false;
    canonicalProductionDone: boolean;
    topLevelProductionDone: false;
  };
  capabilityDeltas: HandoffCapabilityDelta[];
  degradations: CanonicalStory['degradations'];
  recoveryPoint: HandoffPack['recoveryPoint'];
}

export interface HandoffAcceptProjection {
  schemaVersion: 'koala.handoff_accept.v1';
  processEvent: {
    type: 'handoff_accepted';
    action: 'accept';
    storyId: string;
    phase: string;
    fromHost: string;
    toHost: string;
    acceptedByHost: string;
    evidenceRefs: string[];
    recoveryPointId: string;
    authorityChanged: false;
    productionDone: false;
    receiptRefs: [];
  };
  storyId: string;
  fromHost: string;
  toHost: string;
  acceptedByHost: string;
  evidenceRefs: string[];
  lineage: CanonicalStory['lineage'];
  recoveryPoint: HandoffPack['recoveryPoint'];
  authorityChanged: false;
  productionDone: false;
  receiptRefs: [];
  evidenceRefresh: {
    performed: false;
    guidance: string;
  };
}

export interface HandoffResumeProjection {
  schemaVersion: 'koala.handoff_resume.v1';
  processEvent: {
    type: 'handoff_resume_projected';
    action: 'resume';
    storyId: string;
    phase: string;
    fromHost: string;
    toHost: string;
    resumeHost: string;
    evidenceRefs: string[];
    recoveryPointId: string;
    authorityChanged: false;
    productionDone: false;
    receiptRefs: [];
  };
  storyId: string;
  fromHost: string;
  toHost: string;
  resumeHost: string;
  evidenceRefs: string[];
  lineage: CanonicalStory['lineage'];
  recoveryPoint: HandoffPack['recoveryPoint'];
  authorityChanged: false;
  productionDone: false;
  receiptRefs: [];
  nextActions: string[];
  evidenceRefresh: {
    performed: false;
    guidance: string;
  };
}

function evidenceRefs(canonicalStory: CanonicalStory): string[] {
  const refs = new Set<string>();
  for (const evidence of canonicalStory.evidence) {
    const id = evidence.id;
    if (typeof id === 'string' && id.trim()) refs.add(id);
    const intentRef = evidence.intentRef;
    if (typeof intentRef === 'string' && intentRef.trim()) refs.add(intentRef);
  }
  return [...refs].sort();
}

function capabilityDeltas(fromHost: string, toHost: string): HandoffCapabilityDelta[] {
  const fromProbe = buildCapabilityProbe(fromHost);
  const toProbe = buildCapabilityProbe(toHost);
  return fromProbe.profile.capabilities.map((fromCapability) => {
    const toCapability = toProbe.profile.capabilities.find(candidate => candidate.category === fromCapability.category);
    if (!toCapability) {
      throw new Error(`target host profile ${toProbe.host} missing capability ${fromCapability.category}`);
    }
    const targetDegradation = toProbe.degradations.find(candidate => candidate.capability === fromCapability.category);
    return {
      capability: fromCapability.category,
      from: { host: fromProbe.host, status: fromCapability.status },
      to: { host: toProbe.host, status: toCapability.status },
      changed: fromCapability.status !== toCapability.status,
      authorityImpact: targetDegradation?.authorityImpact ?? 'none',
    };
  });
}

function localAuthorityOnlyCanonicalStory(canonical: CanonicalStory): CanonicalStory {
  return {
    ...canonical,
    lifecycle: {
      ...canonical.lifecycle,
      productionDone: false,
    },
    authority: {
      ...canonical.authority,
      tier: 'local-evidence',
    },
  };
}

export function createHandoffPack(
  store: StoryStore,
  root: string,
  args: { storyId: string; fromHost: string; toHost: string },
): HandoffPack {
  const canonical = buildCanonicalStory(store, root, args.storyId).story;
  const targetProbe = buildCapabilityProbe(args.toHost);
  const refs = evidenceRefs(canonical);
  const deltas = capabilityDeltas(args.fromHost, args.toHost);
  const degradations = [
    ...canonical.degradations,
    ...targetProbe.degradations,
  ];

  return {
    schemaVersion: 'handoff-pack-v0',
    storyId: args.storyId,
    fromHost: buildCapabilityProbe(args.fromHost).host,
    toHost: targetProbe.host,
    canonicalStory: localAuthorityOnlyCanonicalStory(canonical),
    evidenceRefs: refs,
    capabilityDeltas: deltas,
    degradations,
    recoveryPoint: {
      id: `${args.storyId}:handoff:${args.fromHost}:to:${args.toHost}`,
      kind: 'handoff-pack',
      storyId: args.storyId,
      fromHost: args.fromHost,
      toHost: args.toHost,
      phase: canonical.lifecycle.phase,
      evidenceRefs: refs,
      guidance: 'Accept the handoff in the target host, inspect visible degradations, then rerun required validation before claiming new evidence or authority.',
    },
    productionDone: false,
    receiptRefs: [],
  };
}

export function readHandoffPack(file: string): HandoffPack {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as HandoffPack;
  if (parsed.schemaVersion !== 'handoff-pack-v0') {
    throw new Error(`handoff_inspect expected schemaVersion handoff-pack-v0, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return {
    ...parsed,
    canonicalStory: localAuthorityOnlyCanonicalStory(parsed.canonicalStory),
    productionDone: false,
    receiptRefs: [],
  };
}

export function readHandoffAcceptProjection(file: string): HandoffAcceptProjection {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as HandoffAcceptProjection;
  if (parsed.schemaVersion !== 'koala.handoff_accept.v1') {
    throw new Error(`handoff_resume expected schemaVersion koala.handoff_accept.v1, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return {
    ...parsed,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    processEvent: {
      ...parsed.processEvent,
      authorityChanged: false,
      productionDone: false,
      receiptRefs: [],
    },
    evidenceRefresh: {
      performed: false,
      guidance: parsed.evidenceRefresh?.guidance ?? handoffEvidenceRefreshGuidance(),
    },
  };
}

export function inspectHandoffPack(pack: HandoffPack): HandoffInspection {
  return {
    schemaVersion: 'koala.handoff_inspect.v1',
    storyId: pack.storyId,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    evidenceRefs: pack.evidenceRefs,
    capabilityDeltaCount: pack.capabilityDeltas.length,
    blockingDegradationCount: pack.degradations.filter(d => d.severity === 'block').length,
    productionDone: false,
    receiptRefs: [],
    authority: {
      handoffCanManufactureProductionDone: false,
      canonicalProductionDone: pack.canonicalStory.lifecycle.productionDone,
      topLevelProductionDone: false,
    },
    capabilityDeltas: pack.capabilityDeltas,
    degradations: pack.degradations,
    recoveryPoint: pack.recoveryPoint,
  };
}

function handoffEvidenceRefreshGuidance(): string {
  return 'This projection preserves prior evidence refs only. Rerun validation in the target host before recording fresh evidence; do not refresh hashes or claim authority from handoff accept/resume.';
}

export function buildHandoffAcceptProjection(
  pack: HandoffPack,
  args: { acceptedByHost?: string } = {},
): HandoffAcceptProjection {
  const acceptedByHost = args.acceptedByHost ? buildCapabilityProbe(args.acceptedByHost).host : pack.toHost;
  const processEvent = {
    type: 'handoff_accepted' as const,
    action: 'accept' as const,
    storyId: pack.storyId,
    phase: pack.recoveryPoint.phase,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    acceptedByHost,
    evidenceRefs: pack.evidenceRefs,
    recoveryPointId: pack.recoveryPoint.id,
    authorityChanged: false as const,
    productionDone: false as const,
    receiptRefs: [] as [],
  };
  return {
    schemaVersion: 'koala.handoff_accept.v1',
    processEvent,
    storyId: pack.storyId,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    acceptedByHost,
    evidenceRefs: pack.evidenceRefs,
    lineage: pack.canonicalStory.lineage,
    recoveryPoint: pack.recoveryPoint,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    evidenceRefresh: {
      performed: false,
      guidance: handoffEvidenceRefreshGuidance(),
    },
  };
}

export function buildHandoffResumeProjection(
  source: HandoffPack | HandoffAcceptProjection,
  args: { resumeHost?: string } = {},
): HandoffResumeProjection {
  const isAccept = source.schemaVersion === 'koala.handoff_accept.v1';
  const storyId = source.storyId;
  const fromHost = source.fromHost;
  const toHost = source.toHost;
  const evidenceRefs = source.evidenceRefs;
  const lineage = isAccept ? source.lineage : source.canonicalStory.lineage;
  const recoveryPoint = source.recoveryPoint;
  const resumeHost = args.resumeHost
    ? buildCapabilityProbe(args.resumeHost).host
    : (isAccept ? source.acceptedByHost : toHost);
  const processEvent = {
    type: 'handoff_resume_projected' as const,
    action: 'resume' as const,
    storyId,
    phase: recoveryPoint.phase,
    fromHost,
    toHost,
    resumeHost,
    evidenceRefs,
    recoveryPointId: recoveryPoint.id,
    authorityChanged: false as const,
    productionDone: false as const,
    receiptRefs: [] as [],
  };
  return {
    schemaVersion: 'koala.handoff_resume.v1',
    processEvent,
    storyId,
    fromHost,
    toHost,
    resumeHost,
    evidenceRefs,
    lineage,
    recoveryPoint,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    nextActions: [
      `Resume ${storyId} from recovery point ${recoveryPoint.id} at phase ${recoveryPoint.phase}.`,
      'Inspect capability degradations and keep any missing authority visible.',
      'Rerun target-host validation before recording new verification evidence.',
      'Require a verified receipt before any productionDone claim.',
    ],
    evidenceRefresh: {
      performed: false,
      guidance: handoffEvidenceRefreshGuidance(),
    },
  };
}

export function renderHandoffInspectionText(inspection: HandoffInspection): string {
  return [
    `Handoff inspect (${inspection.schemaVersion})`,
    `storyId: ${inspection.storyId}`,
    `fromHost: ${inspection.fromHost}`,
    `toHost: ${inspection.toHost}`,
    `evidenceRefs: ${inspection.evidenceRefs.length}`,
    `capabilityDeltas: ${inspection.capabilityDeltaCount}`,
    `blockingDegradations: ${inspection.blockingDegradationCount}`,
    `productionDone: ${inspection.productionDone}`,
    `receiptRefs: ${inspection.receiptRefs.length}`,
    `handoffCanManufactureProductionDone: ${inspection.authority.handoffCanManufactureProductionDone}`,
    `recoveryPoint: ${inspection.recoveryPoint.id}`,
  ].join('\n');
}

export function renderHandoffAcceptText(projection: HandoffAcceptProjection): string {
  return [
    `Handoff accept (${projection.schemaVersion})`,
    `storyId: ${projection.storyId}`,
    `fromHost: ${projection.fromHost}`,
    `toHost: ${projection.toHost}`,
    `acceptedByHost: ${projection.acceptedByHost}`,
    `phase: ${projection.recoveryPoint.phase}`,
    `evidenceRefs: ${projection.evidenceRefs.length}`,
    `authorityChanged: ${projection.authorityChanged}`,
    `productionDone: ${projection.productionDone}`,
    `receiptRefs: ${projection.receiptRefs.length}`,
    `recoveryPoint: ${projection.recoveryPoint.id}`,
  ].join('\n');
}

export function renderHandoffResumeText(projection: HandoffResumeProjection): string {
  return [
    `Handoff resume (${projection.schemaVersion})`,
    `storyId: ${projection.storyId}`,
    `fromHost: ${projection.fromHost}`,
    `toHost: ${projection.toHost}`,
    `resumeHost: ${projection.resumeHost}`,
    `phase: ${projection.recoveryPoint.phase}`,
    `evidenceRefs: ${projection.evidenceRefs.length}`,
    `authorityChanged: ${projection.authorityChanged}`,
    `productionDone: ${projection.productionDone}`,
    `receiptRefs: ${projection.receiptRefs.length}`,
    `recoveryPoint: ${projection.recoveryPoint.id}`,
    `nextActions: ${projection.nextActions.length}`,
  ].join('\n');
}
