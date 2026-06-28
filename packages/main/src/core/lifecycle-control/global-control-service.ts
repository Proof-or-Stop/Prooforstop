/**
 * @task B-376c
 * @checklist CHK-002
 * @title Canonical status builders with compatibility projection
 * @type feature
 * @priority high
 * @description
 *   Align control status construction with canonical runtime/consumption/readiness
 *   fields while retaining legacy projections used by existing tests and docs.
 * @changes
 *   - Add canonical control-plane sections for runtime/consumption/readiness.
 *   - Keep legacy lane and queue projections as compatibility outputs.
 *   - Preserve strict read-only semantics and canonical identity shape.
 */

import {
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  type ControlPlaneSection,
  type ControlPlaneCapabilities,
  type ControlQueueStatus,
  type LifecycleControlLaneStatus,
  type ProjectControlStatus,
  type StoryControlStatus,
} from './control-status.js';

export interface BuildStoryControlStatusInput {
  readonly storyId: string;
  readonly phase?: string;
  readonly title?: string;
  readonly lanes?: readonly LifecycleControlLaneStatus[];
  readonly queue?: ControlQueueStatus;
  readonly runtime?: ControlPlaneSection;
  readonly consumption?: ControlPlaneSection;
  readonly readiness?: ControlPlaneSection;
  readonly capabilities?: ControlPlaneCapabilities;
}

export interface BuildProjectControlStatusInput {
  readonly projectRoot?: string;
  readonly stories?: readonly StoryControlStatus[];
  readonly lanes?: readonly LifecycleControlLaneStatus[];
  readonly queues?: readonly ControlQueueStatus[];
  readonly runtime?: ControlPlaneSection;
  readonly consumption?: ControlPlaneSection;
  readonly readiness?: ControlPlaneSection;
  readonly queueSummary?: ControlQueueStatus;
  readonly capabilities?: ControlPlaneCapabilities;
}

function createUnknownSection(): ControlPlaneSection {
  return {
    status: 'unknown',
    reason: 'projection not initialized',
    source: 'legacy-projection',
  };
}

function getUnknownProjectionDefaults() {
  const unknown = createUnknownSection();
  return {
    runtime: unknown,
    consumption: unknown,
    readiness: unknown,
  };
}

export function getDefaultControlPlaneCapabilities(): ControlPlaneCapabilities {
  return DEFAULT_CONTROL_PLANE_CAPABILITIES;
}

export function buildStoryControlStatus(input: BuildStoryControlStatusInput): StoryControlStatus {
  const { runtime, consumption, readiness } = getUnknownProjectionDefaults();
  return {
    storyId: input.storyId,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.title ? { title: input.title } : {}),
    runtime: input.runtime ?? runtime,
    consumption: input.consumption ?? consumption,
    readiness: input.readiness ?? readiness,
    capabilities: input.capabilities ?? DEFAULT_CONTROL_PLANE_CAPABILITIES,
    lanes: input.lanes ?? [],
    queue: input.queue ?? { classification: 'none' },
    compatibilityProjection: {
      source: 'legacy-story-state',
      projectedAt: new Date().toISOString(),
      section: 'legacy-control-lane',
    },
    cp2Projection: {
      source: 'legacy-story-state',
      projectionKind: 'consumption-closure',
    },
  };
}

export function buildProjectControlStatus(input: BuildProjectControlStatusInput = {}): ProjectControlStatus {
  const { runtime, consumption, readiness } = getUnknownProjectionDefaults();
  return {
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    runtime: input.runtime ?? runtime,
    consumption: input.consumption ?? consumption,
    readiness: input.readiness ?? readiness,
    queueSummary: input.queueSummary ?? { classification: 'none' },
    capabilities: input.capabilities ?? DEFAULT_CONTROL_PLANE_CAPABILITIES,
    stories: input.stories ?? [],
    lanes: input.lanes ?? [],
    queues: input.queues ?? [],
  };
}

/**
 * B-376c: read-only contract helper.
 * Returns true only when this is a projection-only control plane profile.
 */
export function isReadOnlyControlPlane(capabilities: ControlPlaneCapabilities): boolean {
  return capabilities.readOnlyStatusProjection === true &&
    capabilities.commandRegistration === true &&
    capabilities.lifecycleGateMutation === false &&
    capabilities.evidenceWrites === false &&
    capabilities.authorityProductionSemantics === false &&
    capabilities.proofM7Enforcement === false &&
    capabilities.queueCleanupEnforcement === false &&
    capabilities.tierCCleanup === false;
}
