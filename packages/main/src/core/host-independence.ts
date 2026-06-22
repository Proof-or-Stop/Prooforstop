import type { ProcessEvent } from './types.js';

export const REQUIRED_HOST_VERDICT_BINDING_FIELDS = [
  'verdictId',
  'runId',
  'hostId',
  'sessionId',
  'keyId',
  'decision',
  'materialDigest',
  'validationDigest',
  'promptDigest',
] as const;

export interface IgnoredHostVerdict {
  index: number;
  verdictId?: string;
  runId?: string;
  hostId?: string;
  sessionId?: string;
  keyId?: string;
  decision?: string;
  materialDigest?: string;
  reasons: string[];
}

export interface HostVerdictRound {
  runId: string;
  passingHostIds: string[];
  passingVerdictIds: string[];
  reasons: string[];
}

export interface HostVerdictRoundEvaluation {
  validRounds: HostVerdictRound[];
  invalidRounds: HostVerdictRound[];
  ignoredVerdicts: IgnoredHostVerdict[];
}

interface AcceptedHostVerdict {
  index: number;
  verdictId: string;
  runId: string;
  hostId: string;
  sessionId: string;
  keyId: string;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function identityKeys(verdict: AcceptedHostVerdict): string[] {
  return [
    `host:${verdict.hostId}`,
    `session:${verdict.sessionId}`,
    `key:${verdict.keyId}`,
  ];
}

function groupByIndependentHost(verdicts: AcceptedHostVerdict[]): AcceptedHostVerdict[][] {
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = value;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent.set(find(a), find(b));
  };

  verdicts.forEach((_, index) => parent.set(index, index));
  const ownerByKey = new Map<string, number>();
  verdicts.forEach((verdict, index) => {
    for (const key of identityKeys(verdict)) {
      const owner = ownerByKey.get(key);
      if (owner === undefined) ownerByKey.set(key, index);
      else union(owner, index);
    }
  });

  const groups = new Map<number, AcceptedHostVerdict[]>();
  verdicts.forEach((verdict, index) => {
    const root = find(index);
    const existing = groups.get(root);
    if (existing) existing.push(verdict);
    else groups.set(root, [verdict]);
  });
  return [...groups.values()];
}

function ignoredFromEvent(index: number, event: ProcessEvent, reasons: string[]): IgnoredHostVerdict {
  const verdictId = normalizeString(event.verdictId);
  const runId = normalizeString(event.runId);
  const hostId = normalizeIdentity(event.hostId);
  const sessionId = normalizeIdentity(event.sessionId);
  const keyId = normalizeIdentity(event.keyId);
  const decision = normalizeString(event.decision).toLowerCase();
  const materialDigest = normalizeString(event.materialDigest);
  return {
    index,
    ...(verdictId ? { verdictId } : {}),
    ...(runId ? { runId } : {}),
    ...(hostId ? { hostId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(keyId ? { keyId } : {}),
    ...(decision ? { decision } : {}),
    ...(materialDigest ? { materialDigest } : {}),
    reasons,
  };
}

export function evaluateHostVerdictRounds(
  processEvents: ProcessEvent[],
  currentMaterialHash: string,
  requiredPassingHostsPerRound: number,
): HostVerdictRoundEvaluation {
  const acceptedByRun = new Map<string, AcceptedHostVerdict[]>();
  const invalidReasonsByRun = new Map<string, string[]>();
  const ignoredVerdicts: IgnoredHostVerdict[] = [];
  const requiredHosts = Math.max(1, Math.floor(requiredPassingHostsPerRound) || 1);

  processEvents.forEach((event, index) => {
    if (event.type !== 'host_verdict') return;

    const reasons: string[] = [];
    const verdictId = normalizeString(event.verdictId);
    const runId = normalizeString(event.runId);
    const hostId = normalizeIdentity(event.hostId);
    const sessionId = normalizeIdentity(event.sessionId);
    const keyId = normalizeIdentity(event.keyId);
    const decision = normalizeString(event.decision).toLowerCase();
    const materialDigest = normalizeString(event.materialDigest);
    const validationDigest = normalizeString(event.validationDigest);
    const promptDigest = normalizeString(event.promptDigest);

    const missingFields = REQUIRED_HOST_VERDICT_BINDING_FIELDS.filter((field) => !normalizeString(event[field]));
    if (missingFields.length > 0) reasons.push(`missing binding field(s): ${missingFields.join(', ')}`);
    if (decision && decision !== 'pass') reasons.push(`decision is ${decision}`);
    if (materialDigest && materialDigest !== currentMaterialHash) reasons.push('materialDigest is stale');

    if (reasons.length > 0) {
      ignoredVerdicts.push(ignoredFromEvent(index, event, reasons));
      if (runId && materialDigest === currentMaterialHash && decision && decision !== 'pass') {
        const existing = invalidReasonsByRun.get(runId) ?? [];
        existing.push(`non-pass verdict ${verdictId || `event#${index}`} decision=${decision}`);
        invalidReasonsByRun.set(runId, existing);
      }
      return;
    }

    const verdict: AcceptedHostVerdict = {
      index,
      verdictId,
      runId,
      hostId,
      sessionId,
      keyId,
    };
    const existing = acceptedByRun.get(runId);
    if (existing) existing.push(verdict);
    else acceptedByRun.set(runId, [verdict]);

    void validationDigest;
    void promptDigest;
  });

  const validRounds: HostVerdictRound[] = [];
  const invalidRounds: HostVerdictRound[] = [];
  const allRunIds = uniqueSorted([
    ...acceptedByRun.keys(),
    ...invalidReasonsByRun.keys(),
  ]);

  for (const runId of allRunIds) {
    const accepted = acceptedByRun.get(runId) ?? [];
    const groups = groupByIndependentHost(accepted);
    const duplicateGroups = groups.filter(group => group.length > 1);
    const passingHostIds = uniqueSorted(groups.map(group => group[0]?.hostId ?? ''));
    const passingVerdictIds = uniqueSorted(groups.map(group => group[0]?.verdictId ?? ''));
    const missingHosts = Math.max(0, requiredHosts - passingHostIds.length);
    const reasons = [
      ...(invalidReasonsByRun.get(runId) ?? []),
      ...duplicateGroups.map(group =>
        `duplicate host/session/key identity: ${group.map(v => v.verdictId).join(', ')}`,
      ),
      ...(missingHosts > 0 ? [`missing ${missingHosts} passing independent host(s)`] : []),
    ];
    const round = { runId, passingHostIds, passingVerdictIds, reasons };
    if (reasons.length === 0) validRounds.push(round);
    else invalidRounds.push(round);
  }

  return { validRounds, invalidRounds, ignoredVerdicts };
}
