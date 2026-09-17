import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { StoryStore } from './store.js';
import type { ManagedHostRunSubmitArgs } from './managed-host-run.js';
import { admitExecutionBatch, consumeExecutionBatch, consumeReviewerBatchAdmission, verifyExecutionBatchBinding, withVerifiedExecutionBatchLaunch, reserveExecutionBatchLaunch, type ExecutionBatchBinding } from './reviewer-batch-producer.js';
import { captureManagedProviderState, managedProviderStateEnvironment, type ManagedProviderStateSnapshot } from './managed-review-provider-state.js';
import { managedReviewLaneEnvironment, type ManagedReviewLane } from './managed-review-lane.js';
import { MANAGED_REVIEW_LANE_ARTIFACT } from './runtime-artifact-registry.js';
import { ACCEPTANCE_REVIEW_PROFILE } from './acceptance-amendment-review.js';

type ManagedHost = 'codex' | 'claude' | 'grok';
type SingletonProfile = typeof ACCEPTANCE_REVIEW_PROFILE | 'cross_host_review_codex';
interface SingletonRequest {
 root:string; storyId:string; profile:SingletonProfile; lane:string; host:ManagedHost;
 subjectIdentity:string; deriveSubjectIdentity():string; effectiveBaseEnvironment:NodeJS.ProcessEnv;
}
declare const singletonBrand:unique symbol;
export interface ManagedSingletonAdmission { readonly [singletonBrand]:true }
const singletons=new WeakMap<ManagedSingletonAdmission,SingletonRequest>();
const submissions=new WeakMap<ManagedHostRunSubmitArgs,ManagedSingletonAdmission>();
export interface ManagedLaunchAdmission {
 binding:{schema:'managed-launch-admission.v1';storyId:string;execution:ExecutionBatchBinding;launchReservation:{runId:string;deadlineAt:string}};
 providerState:ManagedProviderStateSnapshot;
}
/** Called only by the verified amendment/cross-host controller, before scratch creation. */
export async function prepareManagedSingletonAdmission(request:SingletonRequest):Promise<ManagedSingletonAdmission> {
 if(![ACCEPTANCE_REVIEW_PROFILE,'cross_host_review_codex'].includes(request.profile)||!request.storyId)throw new Error('invalid singleton admission subject');
 const record=await admitExecutionBatch({...request,assignments:[{lane:request.lane,kind:'managed',host:request.host}]});
 if(record.state!=='ADMITTED')throw new Error('singleton batch admission blocked: '+('reason' in record?record.reason:record.state));
 const token=Object.freeze({}) as ManagedSingletonAdmission;
 singletons.set(token,{...request,effectiveBaseEnvironment:{...request.effectiveBaseEnvironment}});return token;
}
export function bindManagedSingletonSubmission(args:ManagedHostRunSubmitArgs,token:ManagedSingletonAdmission):ManagedHostRunSubmitArgs {
 const request=singletons.get(token);
 if(!request||realpathSync(args.root)!==realpathSync(request.root)||args.storyId!==request.storyId||args.profile!==request.profile||args.host!==request.host||(args.lane??args.agentType)!==request.lane)throw new Error('singleton admission submission mismatch');
 submissions.set(args,token);return args;
}
export async function consumeManagedLaunchAdmission(args:ManagedHostRunSubmitArgs,effectiveBaseEnvironment:NodeJS.ProcessEnv,launchReservation:{runId:string;deadlineAt:string}):Promise<ManagedLaunchAdmission> {
 if(!args.storyId||!args.profile||(args.host!=='codex'&&args.host!=='claude'&&args.host!=='grok'))throw new Error('managed batch admission subject unavailable');
 let admitted;
 if(args.profile==='managed_reviewer') {
  if(!args.lane||args.agentType!==args.lane||!args.reviewRunId)throw new Error('managed batch admission review lane missing');
  try { admitted=await consumeReviewerBatchAdmission({store:new StoryStore(args.root),root:args.root,storyId:args.storyId,lane:args.lane,host:args.host,profile:args.profile,effectiveBaseEnvironment}); }
  catch(error){throw new Error('reviewer_batch_admit required before managed launch: '+(error instanceof Error?error.message:String(error)));}
 } else {
  const token=submissions.get(args),request=token&&singletons.get(token);
  if(!request)throw new Error('managed singleton admission missing; use its verified controller');
  admitted=await consumeExecutionBatch({...request,effectiveBaseEnvironment});
 }
 reserveExecutionBatchLaunch({root:args.root,binding:admitted.binding,effectiveBaseEnvironment,runId:launchReservation.runId,deadlineAt:Date.parse(launchReservation.deadlineAt)});
 return {binding:{schema:'managed-launch-admission.v1',storyId:args.storyId,execution:admitted.binding,launchReservation},providerState:admitted.providerState};
}
interface LaunchSpec {root:string;host:string;storyId:string|null;profile:string|null;lane:string|null;agentType:string;runId:string;deadlineAt:string}
export async function verifyManagedLaunchAdmission<T = void>(args:{spec:LaunchSpec;binding:ManagedLaunchAdmission['binding'];effectiveBaseEnvironment:NodeJS.ProcessEnv;providerEnvironment:NodeJS.ProcessEnv;readonlyLane:ManagedReviewLane;injectedCapability?:string}, grant?: () => T):Promise<T | void> {
 const {spec,binding,readonlyLane,effectiveBaseEnvironment}=args;
 if(!binding.launchReservation||binding.launchReservation.runId!==spec.runId||binding.launchReservation.deadlineAt!==spec.deadlineAt)throw new Error('managed launch reservation differs from sealed run');
 if(binding.schema!=='managed-launch-admission.v1'||binding.storyId!==spec.storyId||binding.execution.host!==spec.host||binding.execution.profile!==spec.profile||binding.execution.lane!==(spec.lane??spec.agentType))throw new Error('managed launch admission sealed subject mismatch');
 const expected:NodeJS.ProcessEnv={...effectiveBaseEnvironment,...managedReviewLaneEnvironment(readonlyLane),LATTICE_MANAGED_HOST_RUN_ID:spec.runId,PROOF_OR_STOP_AGENT:spec.agentType,
 ...(args.injectedCapability!==undefined?{LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY:args.injectedCapability}:{})};
 delete expected.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;
 expected.PATH=join(dirname(readonlyLane.layout.buildSource),MANAGED_REVIEW_LANE_ARTIFACT.launchers)+':'+(expected.PATH??'');
 if(!isDeepStrictEqual(args.providerEnvironment,expected))throw new Error('managed admission provider environment differs from sealed derivation');
 const providerStateSnapshot=captureManagedProviderState(spec.host,{...effectiveBaseEnvironment,...managedProviderStateEnvironment(readonlyLane.providerState)});
 const verification = {root:spec.root,binding:binding.execution,effectiveBaseEnvironment,providerStateSnapshot,launchReservation:{runId:binding.launchReservation.runId,deadlineAt:Date.parse(binding.launchReservation.deadlineAt)},actualProviderEnvironment:args.providerEnvironment,actualProviderCwd:readonlyLane.layout.source};
 // A managed grant verifies once under the controller lock, then acquires its
 // per-run terminal lock. Read-only callers retain the original verifier path.
 if (grant) return withVerifiedExecutionBatchLaunch(verification, grant);
 verifyExecutionBatchBinding(verification);
}
