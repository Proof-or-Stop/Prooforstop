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
    canonicalStory: {
      ...canonical,
      lifecycle: {
        ...canonical.lifecycle,
        productionDone: canonical.authority.receiptRefs.length > 0,
      },
    },
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
    productionDone: false,
    receiptRefs: [],
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
