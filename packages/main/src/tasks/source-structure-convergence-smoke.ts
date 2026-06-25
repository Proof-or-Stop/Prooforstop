#!/usr/bin/env node

import assert from 'node:assert/strict';

import * as legacyArtifactStore from '../core/evidence/artifact-store.js';
import * as artifactEntry from '../core/evidence/artifact/index.js';
import * as storageEntry from '../core/evidence/storage/index.js';
import * as legacyRepro from '../core/repro-intake.js';
import * as reproEntry from '../core/evidence/repro/index.js';
import * as legacyAdmissibility from '../core/proof-admissibility.js';
import * as admissibilityEntry from '../core/evidence/admissibility/index.js';
import {
  buildProjectControlStatus,
  buildStoryControlStatus,
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  isReadOnlyControlPlane,
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES,
  type ProjectControlStatus,
  type StoryControlStatus,
} from '../core/lifecycle-control/index.js';
import * as lifecycleControlStatus from '../core/lifecycle-control/control-status.js';
import * as globalControlService from '../core/lifecycle-control/global-control-service.js';
import * as lifecycleRuntime from '../core/lifecycle-control/runtime/index.js';
import * as lifecycleConsumption from '../core/lifecycle-control/consumption/index.js';
import * as lifecycleQueue from '../core/lifecycle-control/queue/index.js';
import * as lifecycleDashboard from '../core/lifecycle-control/dashboard/index.js';
import type { EvidenceArtifact as LegacyEvidenceArtifact } from '../core/evidence/types.js';
import type { EvidenceArtifact as ArtifactEntryEvidenceArtifact } from '../core/evidence/artifact/index.js';
import type { EvidenceArtifact as StorageEntryEvidenceArtifact } from '../core/evidence/storage/index.js';

const artifactTypeRoundTrip: ArtifactEntryEvidenceArtifact = {} as LegacyEvidenceArtifact;
const storageTypeRoundTrip: StorageEntryEvidenceArtifact = artifactTypeRoundTrip;
void storageTypeRoundTrip;

assert.equal(
  artifactEntry.writeArtifact,
  legacyArtifactStore.writeArtifact,
  'evidence/artifact must re-export the legacy writeArtifact function by identity',
);
assert.equal(
  artifactEntry.readArtifact,
  legacyArtifactStore.readArtifact,
  'evidence/artifact must re-export the legacy readArtifact function by identity',
);
assert.equal(
  storageEntry.writeArtifact,
  legacyArtifactStore.writeArtifact,
  'evidence/storage must re-export the legacy writeArtifact function by identity',
);
assert.equal(
  storageEntry.verifyArtifactDigest,
  legacyArtifactStore.verifyArtifactDigest,
  'evidence/storage must re-export the legacy verifyArtifactDigest function by identity',
);
assert.equal(
  reproEntry.createProbe,
  legacyRepro.createProbe,
  'evidence/repro must re-export the legacy createProbe function by identity',
);
assert.equal(
  reproEntry.createStoryFromRepro,
  legacyRepro.createStoryFromRepro,
  'evidence/repro must re-export the legacy createStoryFromRepro function by identity',
);
assert.equal(
  admissibilityEntry.PROOF_SURFACE_REGISTRY,
  legacyAdmissibility.PROOF_SURFACE_REGISTRY,
  'evidence/admissibility must share the legacy proof surface registry object',
);
assert.equal(
  admissibilityEntry.evaluateProofAdmissibility,
  legacyAdmissibility.evaluateProofAdmissibility,
  'evidence/admissibility must re-export the legacy evaluator by identity',
);

assert.equal(
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES.length,
  5,
  'lifecycle-control migration must remain a five-milestone structural plan',
);
assert.equal(
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES[4]?.subtracks?.map(track => track.id).join(','),
  'CP-5A,CP-5B',
  'CP-5 must keep runtime enforcement and queue governance split',
);
assert.equal(
  LIFECYCLE_CONTROL_MIGRATION_MILESTONES[4]?.subtracks?.[0]?.title,
  'Runtime Enforcement track',
  'CP-5A must be runtime enforcement, not Proof M7 or Authority ownership',
);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.readOnlyStatusProjection, true);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.commandRegistration, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.lifecycleGateMutation, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.evidenceWrites, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.proofM7Enforcement, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.queueCleanupEnforcement, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.authorityProductionSemantics, false);
assert.equal(DEFAULT_CONTROL_PLANE_CAPABILITIES.tierCCleanup, false);

for (const [name, capabilities] of [
  ['control-status', lifecycleControlStatus.DEFAULT_CONTROL_PLANE_CAPABILITIES],
  ['global-control-service', globalControlService.getDefaultControlPlaneCapabilities()],
  ['runtime', lifecycleRuntime.DEFAULT_CONTROL_PLANE_CAPABILITIES],
  ['consumption', lifecycleConsumption.DEFAULT_CONTROL_PLANE_CAPABILITIES],
  ['queue', lifecycleQueue.DEFAULT_CONTROL_PLANE_CAPABILITIES],
  ['dashboard', lifecycleDashboard.DEFAULT_CONTROL_PLANE_CAPABILITIES],
] as const) {
  assert.equal(capabilities, DEFAULT_CONTROL_PLANE_CAPABILITIES, `${name} must share the canonical read-only capabilities object`);
  assert.equal(isReadOnlyControlPlane(capabilities), true, `${name} must preserve read-only/no-gate/no-proof-enforcement flags`);
}

assert.equal(lifecycleRuntime.buildStoryControlStatus, buildStoryControlStatus);
assert.equal(lifecycleConsumption.buildProjectControlStatus, buildProjectControlStatus);
assert.equal(lifecycleDashboard.buildStoryControlStatus, buildStoryControlStatus);
assert.equal(lifecycleQueue.isReadOnlyControlPlane, isReadOnlyControlPlane);

const storyStatus: StoryControlStatus = {
  storyId: 'B-88ae',
  phase: 'DEV',
  capabilities: DEFAULT_CONTROL_PLANE_CAPABILITIES,
  lanes: [
    {
      lane: 'dev',
      state: 'observed',
      source: 'control-plane-projection',
    },
  ],
  queue: {
    classification: 'none',
  },
  cp2Projection: {
    source: 'legacy-story-state',
    projectionKind: 'consumption-closure',
  },
};

const projectStatus: ProjectControlStatus = {
  capabilities: DEFAULT_CONTROL_PLANE_CAPABILITIES,
  stories: [storyStatus],
  lanes: storyStatus.lanes,
  queues: [storyStatus.queue],
};
assert.equal(projectStatus.stories[0]?.storyId, 'B-88ae');

const helperStoryStatus = buildStoryControlStatus({
  storyId: 'B-88ae',
  phase: 'DEV',
  lanes: storyStatus.lanes,
});
assert.equal(helperStoryStatus.cp2Projection?.projectionKind, 'consumption-closure');
assert.equal(isReadOnlyControlPlane(helperStoryStatus.capabilities), true);

const helperProjectStatus = buildProjectControlStatus({ stories: [helperStoryStatus] });
assert.equal(helperProjectStatus.stories[0], helperStoryStatus);

console.log('source-structure convergence smoke passed');
