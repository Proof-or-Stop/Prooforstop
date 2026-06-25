import {
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
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
  readonly capabilities?: ControlPlaneCapabilities;
}

export interface BuildProjectControlStatusInput {
  readonly projectRoot?: string;
  readonly stories?: readonly StoryControlStatus[];
  readonly lanes?: readonly LifecycleControlLaneStatus[];
  readonly queues?: readonly ControlQueueStatus[];
  readonly capabilities?: ControlPlaneCapabilities;
}

export function getDefaultControlPlaneCapabilities(): ControlPlaneCapabilities {
  return DEFAULT_CONTROL_PLANE_CAPABILITIES;
}

export function buildStoryControlStatus(input: BuildStoryControlStatusInput): StoryControlStatus {
  return {
    storyId: input.storyId,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.title ? { title: input.title } : {}),
    capabilities: input.capabilities ?? DEFAULT_CONTROL_PLANE_CAPABILITIES,
    lanes: input.lanes ?? [],
    queue: input.queue ?? { classification: 'none' },
    cp2Projection: {
      source: 'legacy-story-state',
      projectionKind: 'consumption-closure',
    },
  };
}

export function buildProjectControlStatus(input: BuildProjectControlStatusInput = {}): ProjectControlStatus {
  return {
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    capabilities: input.capabilities ?? DEFAULT_CONTROL_PLANE_CAPABILITIES,
    stories: input.stories ?? [],
    lanes: input.lanes ?? [],
    queues: input.queues ?? [],
  };
}

export function isReadOnlyControlPlane(capabilities: ControlPlaneCapabilities): boolean {
  return capabilities.readOnlyStatusProjection === true &&
    capabilities.commandRegistration === false &&
    capabilities.lifecycleGateMutation === false &&
    capabilities.evidenceWrites === false &&
    capabilities.authorityProductionSemantics === false &&
    capabilities.proofM7Enforcement === false &&
    capabilities.queueCleanupEnforcement === false &&
    capabilities.tierCCleanup === false;
}
