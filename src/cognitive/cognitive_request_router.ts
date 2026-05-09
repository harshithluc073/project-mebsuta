/**
 * Cognitive request router for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.6.2, 6.7.2, 6.12, 6.13, 6.18, 6.19, and 6.20.
 *
 * The router converts orchestrator-level cognitive needs into explicit Gemini
 * Robotics-ER invocation plans. It never emits generic free-form model calls
 * for action-bearing work: each route carries a named invocation class, prompt
 * template reference, output contract reference, queue, timeout, model policy,
 * required evidence list, and deterministic validation report.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  CognitiveInvocationClass,
  CognitiveInvocationPolicy,
  RetryClass,
  TemperatureClass,
  ThinkingBudgetClass,
} from "./gemini_robotics_er_adapter";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "./gemini_robotics_er_adapter";

export const COGNITIVE_REQUEST_ROUTER_SCHEMA_VERSION = "mebsuta.cognitive_request_router.v1" as const;

const FORBIDDEN_CONTEXT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|simulator|hidden)/i;
const UNSUPPORTED_CAPABILITY_PATTERN = /(live api|audio generation|image generation|code execution|computer use|google maps|url context|search grounding|direct actuator|joint torque|joint current|reward policy|reinforcement learning|rl update)/i;
const LOW_LEVEL_CONTROL_PATTERN = /(torque|joint current|motor current|raw actuator|physics step|set joint|apply force|apply impulse|bypass validator|override safety|ignore safe-hold)/i;
const HIDDEN_REASONING_PATTERN = /(chain-of-thought|hidden reasoning|private deliberation|scratchpad|internal prompt|system prompt)/i;

export type CognitiveNeedKind =
  | "observe"
  | "plan"
  | "waypoint"
  | "verify"
  | "correct"
  | "tool"
  | "audio"
  | "memory"
  | "monologue";

export type CognitiveQueue = "SafetyImmediate" | "ExecutionPlanning" | "Verification" | "MemoryMaintenance" | "OfflineQA";
export type CognitiveConfigurationProfile =
  | "StrictPerception"
  | "BalancedPlanning"
  | "SafetyCriticalCorrection"
  | "ToolUseExploration"
  | "FastMonologue"
  | "OfflineBenchmark";
export type DownstreamTarget = "prompt_assembler" | "safe_hold" | "memory_writer" | "tts_filter" | "verification_pipeline" | "validator_stack";
export type RouteDecision = "route_ready" | "route_rejected" | "safe_hold_required";
export type EvidenceKind = "visual" | "audio" | "memory" | "embodiment" | "validator" | "task" | "tool" | "plan" | "uncertainty";
export type EvidenceProvenance = "virtual_sensor" | "perception" | "memory" | "embodiment" | "validator" | "orchestrator" | "safety" | "tts";
export type AmbiguityLevel = "none" | "low" | "medium" | "high" | "conflict";
export type TaskCriticality = "routine" | "execution_bound" | "safety_critical" | "background";

export interface RouterEvidenceItem {
  readonly evidence_ref: Ref;
  readonly kind: EvidenceKind;
  readonly provenance: EvidenceProvenance;
  readonly summary: string;
  readonly confidence: number;
  readonly observed_at_ms?: number;
  readonly current: boolean;
}

export interface AmbiguityReport {
  readonly ambiguity_ref: Ref;
  readonly level: AmbiguityLevel;
  readonly conflicting_evidence_refs?: readonly Ref[];
  readonly missing_observations?: readonly string[];
  readonly requires_reobserve: boolean;
}

export interface TaskStateSnapshot {
  readonly task_ref: Ref;
  readonly active_goal: string;
  readonly phase: "idle" | "observing" | "planning" | "executing" | "verifying" | "correcting" | "safe_hold" | "memory_update";
  readonly criticality: TaskCriticality;
  readonly retry_budget_remaining: number;
  readonly safe_hold_active: boolean;
  readonly validator_gate_required: boolean;
}

export interface ObservationBundle {
  readonly bundle_ref: Ref;
  readonly observations: readonly RouterEvidenceItem[];
  readonly synchronized: boolean;
  readonly memory_only?: boolean;
}

export interface SceneSummary {
  readonly scene_ref: Ref;
  readonly summary: string;
  readonly object_hypothesis_refs: readonly Ref[];
  readonly relation_hypothesis_refs: readonly Ref[];
  readonly evidence: readonly RouterEvidenceItem[];
  readonly ambiguity: AmbiguityReport;
}

export interface EmbodimentContractSummary {
  readonly embodiment_ref: Ref;
  readonly summary: string;
  readonly supported_modes: readonly ("quadruped_locomotion" | "humanoid_locomotion" | "manipulation" | "tool_use" | "audio_orienting")[];
  readonly validator_required: true;
}

export interface MemoryContextSummary {
  readonly memory_ref: Ref;
  readonly snippets: readonly RouterEvidenceItem[];
  readonly contradiction_refs: readonly Ref[];
  readonly oldest_staleness_s: number;
}

export interface AnomalyEvent {
  readonly anomaly_ref: Ref;
  readonly anomaly_type: "slip" | "drop" | "occlusion" | "unreachable" | "grasp_mismatch" | "collision" | "object_motion" | "timeout" | "schema_failure";
  readonly summary: string;
  readonly safety_critical: boolean;
  readonly occurred_at_ms: number;
}

export interface PriorPlanSummary {
  readonly plan_ref: Ref;
  readonly summary: string;
  readonly action_refs: readonly Ref[];
  readonly action_bearing: boolean;
}

export interface ValidatorReportSummary {
  readonly report_ref: Ref;
  readonly accepted: boolean;
  readonly rejection_reasons: readonly string[];
  readonly retry_budget_remaining: number;
}

export interface ReachReportSummary {
  readonly report_ref: Ref;
  readonly reachable: boolean;
  readonly failed_target_refs: readonly Ref[];
  readonly reposition_options: readonly string[];
  readonly validator_confidence: number;
}

export interface ToolHypothesis {
  readonly tool_ref: Ref;
  readonly label: string;
  readonly visible: boolean;
  readonly evidence_refs: readonly Ref[];
  readonly affordance_summary: string;
  readonly confidence: number;
}

export interface SafetySummary {
  readonly safety_ref: Ref;
  readonly safe_hold_active: boolean;
  readonly constraints: readonly string[];
  readonly validator_release_ref?: Ref;
}

export interface UncertaintyReport {
  readonly uncertainty_ref: Ref;
  readonly confidence: "high" | "medium" | "low" | "unknown";
  readonly notes: readonly string[];
  readonly reobserve_required: boolean;
}

export interface AudioEventSummary {
  readonly audio_ref: Ref;
  readonly summary: string;
  readonly direction_hint?: string;
  readonly confidence: number;
  readonly evidence: readonly RouterEvidenceItem[];
}

export interface VerificationNeedSummary {
  readonly verification_ref: Ref;
  readonly relation_or_goal: string;
  readonly visual_evidence: readonly RouterEvidenceItem[];
  readonly spatial_certificate_refs: readonly Ref[];
  readonly uncertainty: UncertaintyReport;
}

export interface CognitiveNeedEvent {
  readonly need_ref: Ref;
  readonly need_kind: CognitiveNeedKind;
  readonly task_state: TaskStateSnapshot;
  readonly task_instruction?: string;
  readonly observation_bundle?: ObservationBundle;
  readonly scene_summary?: SceneSummary;
  readonly embodiment_contract?: EmbodimentContractSummary;
  readonly memory_context?: MemoryContextSummary;
  readonly anomaly_event?: AnomalyEvent;
  readonly prior_plan?: PriorPlanSummary;
  readonly validator_report?: ValidatorReportSummary;
  readonly reach_report?: ReachReportSummary;
  readonly tool_hypotheses?: readonly ToolHypothesis[];
  readonly validated_plan?: PriorPlanSummary;
  readonly safety_summary?: SafetySummary;
  readonly uncertainty_report?: UncertaintyReport;
  readonly audio_event?: AudioEventSummary;
  readonly verification_need?: VerificationNeedSummary;
  readonly requested_capabilities?: readonly string[];
}

export interface CognitiveRouteProfile {
  readonly need_kind: CognitiveNeedKind;
  readonly invocation_class: CognitiveInvocationClass;
  readonly prompt_template_ref: Ref;
  readonly output_contract_ref: Ref;
  readonly queue: CognitiveQueue;
  readonly configuration_profile: CognitiveConfigurationProfile;
  readonly temperature_class: TemperatureClass;
  readonly thinking_budget_class: ThinkingBudgetClass;
  readonly retry_class: RetryClass;
  readonly timeout_ms: number;
  readonly action_bearing: boolean;
  readonly downstream_target: DownstreamTarget;
  readonly required_evidence_kinds: readonly EvidenceKind[];
  readonly forbidden_capabilities: readonly string[];
}

export interface CognitiveInvocationPlan {
  readonly schema_version: typeof COGNITIVE_REQUEST_ROUTER_SCHEMA_VERSION;
  readonly plan_ref: Ref;
  readonly source_need_ref: Ref;
  readonly route_decision: RouteDecision;
  readonly invocation_class: CognitiveInvocationClass;
  readonly prompt_template_ref: Ref;
  readonly output_contract_ref: Ref;
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly queue: CognitiveQueue;
  readonly configuration_profile: CognitiveConfigurationProfile;
  readonly downstream_target: DownstreamTarget;
  readonly required_evidence_kinds: readonly EvidenceKind[];
  readonly selected_evidence_refs: readonly Ref[];
  readonly rejected_evidence_refs: readonly Ref[];
  readonly forbidden_capability_blocks: readonly string[];
  readonly validation_issues: readonly ValidationIssue[];
  readonly safe_hold_required: boolean;
  readonly validator_gate_required: boolean;
  readonly route_summary: string;
  readonly determinism_hash: string;
}

export interface RouterValidationReport {
  readonly schema_version: typeof COGNITIVE_REQUEST_ROUTER_SCHEMA_VERSION;
  readonly route_decision: RouteDecision;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Maps orchestrator needs to Gemini Robotics-ER invocation plans while enforcing
 * the cognitive-layer route matrix, output contracts, queues, and safety gates.
 */
export class CognitiveRequestRouter {
  private readonly profiles: Readonly<Record<CognitiveNeedKind, CognitiveRouteProfile>>;

  public constructor(profiles: readonly CognitiveRouteProfile[] = DEFAULT_ROUTE_PROFILES) {
    this.profiles = indexProfiles(profiles);
  }

  /**
   * Routes scene observation or ambiguity-resolution requests. Visual or audio
   * evidence is mandatory unless the caller marks the route as memory-only.
   */
  public routeObservationRequest(
    taskState: TaskStateSnapshot,
    observationBundle: ObservationBundle,
    ambiguityReport: AmbiguityReport,
  ): CognitiveInvocationPlan {
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, observationBundle.bundle_ref, ambiguityReport.ambiguity_ref),
      need_kind: ambiguityReport.level === "conflict" || ambiguityReport.requires_reobserve ? "observe" : "observe",
      task_state: taskState,
      observation_bundle: observationBundle,
      uncertainty_report: ambiguityToUncertainty(ambiguityReport),
    });
    const overrideProfile = ambiguityReport.level === "conflict"
      ? profileForMultiView(this.profiles.observe)
      : undefined;
    return this.buildPlan(need, overrideProfile);
  }

  /**
   * Routes task planning. The resulting plan always uses a strict structured
   * contract and marks the downstream validator stack as authoritative.
   */
  public routePlanningRequest(
    taskInstruction: string,
    sceneSummary: SceneSummary,
    embodimentContract: EmbodimentContractSummary,
    memoryContext?: MemoryContextSummary,
  ): CognitiveInvocationPlan {
    const taskState = makeSyntheticTaskState("planning", taskInstruction, "execution_bound");
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, sceneSummary.scene_ref, embodimentContract.embodiment_ref),
      need_kind: "plan",
      task_state: taskState,
      task_instruction: taskInstruction,
      scene_summary: sceneSummary,
      embodiment_contract: embodimentContract,
      memory_context: memoryContext,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes waypoint generation from a validated high-level planning context.
   * Low-level joint or physics commands are rejected before prompt assembly.
   */
  public routeWaypointRequest(
    taskState: TaskStateSnapshot,
    sceneSummary: SceneSummary,
    priorPlan: PriorPlanSummary,
    embodimentContract: EmbodimentContractSummary,
  ): CognitiveInvocationPlan {
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, sceneSummary.scene_ref, priorPlan.plan_ref),
      need_kind: "waypoint",
      task_state: taskState,
      scene_summary: sceneSummary,
      prior_plan: priorPlan,
      embodiment_contract: embodimentContract,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes visual or spatial verification work. The route remains advisory:
   * deterministic certificates and residual checks keep final authority.
   */
  public routeVerificationRequest(taskState: TaskStateSnapshot, verificationNeed: VerificationNeedSummary): CognitiveInvocationPlan {
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, verificationNeed.verification_ref),
      need_kind: "verify",
      task_state: taskState,
      verification_need: verificationNeed,
      uncertainty_report: verificationNeed.uncertainty,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes Oops Loop correction using failure evidence, prior plan context, and
   * validator rejection details. Missing retry-budget status is a hard error.
   */
  public routeCorrectionRequest(
    anomalyEvent: AnomalyEvent,
    evidenceBundle: ObservationBundle,
    priorPlan: PriorPlanSummary,
    validatorReport: ValidatorReportSummary,
  ): CognitiveInvocationPlan {
    const taskState = makeSyntheticTaskState("correcting", anomalyEvent.summary, anomalyEvent.safety_critical ? "safety_critical" : "execution_bound", validatorReport.retry_budget_remaining);
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, anomalyEvent.anomaly_ref, validatorReport.report_ref),
      need_kind: "correct",
      task_state: taskState,
      anomaly_event: anomalyEvent,
      observation_bundle: evidenceBundle,
      prior_plan: priorPlan,
      validator_report: validatorReport,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes tool-use reasoning only when reach evidence and visible tool
   * hypotheses exist. Invisible or ungrounded tools are rejected.
   */
  public routeToolUseRequest(
    reachReport: ReachReportSummary,
    toolHypotheses: readonly ToolHypothesis[],
    taskGoal: string,
    embodimentContract: EmbodimentContractSummary,
  ): CognitiveInvocationPlan {
    const taskState = makeSyntheticTaskState("planning", taskGoal, "execution_bound");
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, reachReport.report_ref, embodimentContract.embodiment_ref),
      need_kind: "tool",
      task_state: taskState,
      task_instruction: taskGoal,
      reach_report: reachReport,
      tool_hypotheses: toolHypotheses,
      embodiment_contract: embodimentContract,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes audio event reasoning. The output is an orienting or investigation
   * proposal, never audio generation from Gemini Robotics-ER.
   */
  public routeAudioEventRequest(taskState: TaskStateSnapshot, audioEvent: AudioEventSummary): CognitiveInvocationPlan {
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, audioEvent.audio_ref),
      need_kind: "audio",
      task_state: taskState,
      audio_event: audioEvent,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes memory assimilation. Memory outputs are write candidates with
   * confidence and staleness labels, never hidden truth.
   */
  public routeMemoryAssimilationRequest(taskState: TaskStateSnapshot, memoryContext: MemoryContextSummary, sceneSummary?: SceneSummary): CognitiveInvocationPlan {
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, memoryContext.memory_ref),
      need_kind: "memory",
      task_state: taskState,
      memory_context: memoryContext,
      scene_summary: sceneSummary,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes public monologue generation after validation. Hidden chain-of-thought,
   * simulator details, and unvalidated claims are rejected.
   */
  public routeMonologueRequest(
    validatedPlan: PriorPlanSummary,
    safetySummary: SafetySummary,
    uncertaintyReport: UncertaintyReport,
  ): CognitiveInvocationPlan {
    const taskState = makeSyntheticTaskState(safetySummary.safe_hold_active ? "safe_hold" : "executing", validatedPlan.summary, safetySummary.safe_hold_active ? "safety_critical" : "execution_bound");
    const need: CognitiveNeedEvent = Object.freeze({
      need_ref: makeRef("need", taskState.task_ref, validatedPlan.plan_ref, safetySummary.safety_ref),
      need_kind: "monologue",
      task_state: taskState,
      validated_plan: validatedPlan,
      safety_summary: safetySummary,
      uncertainty_report: uncertaintyReport,
    });
    return this.buildPlan(need);
  }

  /**
   * Routes a normalized orchestrator event. This method is useful for state
   * machine integration because it accepts the complete discriminated need.
   */
  public routeNeedEvent(need: CognitiveNeedEvent): CognitiveInvocationPlan {
    return this.buildPlan(need);
  }

  /**
   * Validates a completed route and returns deterministic issue counts for
   * telemetry or test harness assertions.
   */
  public validateInvocationPlan(plan: CognitiveInvocationPlan): RouterValidationReport {
    const issues = [...plan.validation_issues];
    if (plan.model_identifier !== GEMINI_ROBOTICS_ER_APPROVED_MODEL) {
      issues.push(issue("error", "RouterModelMismatch", "model_identifier", "Router emitted an unapproved model identifier.", "Use gemini-robotics-er-1.6-preview."));
    }
    if (plan.invocation_policy.require_structured_output !== true) {
      issues.push(issue("error", "StructuredOutputMissing", "invocation_policy.require_structured_output", "Router emitted a route without mandatory structured output.", "Enable structured output for every cognitive route."));
    }
    if (plan.validator_gate_required === false && isActionBearing(plan.invocation_class)) {
      issues.push(issue("error", "ValidatorGateMissing", "validator_gate_required", "Action-bearing cognitive route does not require deterministic validator handoff.", "Set validator_gate_required for action-bearing routes."));
    }
    if (plan.route_decision === "route_ready" && hasError(issues)) {
      issues.push(issue("error", "RouteDecisionInconsistent", "route_decision", "Route is marked ready despite blocking validation issues.", "Reject or safe-hold routes with errors."));
    }
    return makeValidationReport(plan.route_decision, issues);
  }

  private buildPlan(need: CognitiveNeedEvent, profileOverride?: CognitiveRouteProfile): CognitiveInvocationPlan {
    const profile = profileOverride ?? this.profiles[need.need_kind];
    const evidence = collectEvidence(need);
    const rejectedEvidenceRefs = evidence
      .filter((item) => item.current !== true || item.confidence < 0 || item.confidence > 1)
      .map((item) => item.evidence_ref);
    const selectedEvidenceRefs = evidence
      .filter((item) => item.current === true && item.confidence >= 0 && item.confidence <= 1)
      .sort((a, b) => b.confidence - a.confidence || a.evidence_ref.localeCompare(b.evidence_ref))
      .map((item) => item.evidence_ref);
    const issues = [
      ...validateTaskState(need.task_state),
      ...validateRequiredRouteData(need, profile, evidence),
      ...scanNeedForForbiddenContent(need),
      ...scanRequestedCapabilities(need.requested_capabilities ?? [], profile),
      ...validateActionBoundary(need, profile),
      ...validateEvidenceQuality(evidence),
    ];
    if (rejectedEvidenceRefs.length > 0) {
      issues.push(issue("warning", "EvidenceExcluded", "evidence", "One or more stale or invalid-confidence evidence items were excluded from the route.", "Refresh stale evidence and clamp confidence to the 0..1 range."));
    }
    const routeDecision = decideRoute(need, profile, issues);
    const invocationPolicy: CognitiveInvocationPolicy = Object.freeze({
      model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      temperature_class: profile.temperature_class,
      thinking_budget_class: profile.thinking_budget_class,
      retry_class: profile.retry_class,
      timeout_ms: profile.timeout_ms,
      require_structured_output: true,
      allow_preview_model: true,
    });
    const base = {
      schema_version: COGNITIVE_REQUEST_ROUTER_SCHEMA_VERSION,
      plan_ref: makeRef("cognitive_invocation_plan", need.need_ref, profile.invocation_class, profile.output_contract_ref),
      source_need_ref: need.need_ref,
      route_decision: routeDecision,
      invocation_class: profile.invocation_class,
      prompt_template_ref: profile.prompt_template_ref,
      output_contract_ref: profile.output_contract_ref,
      model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      invocation_policy: invocationPolicy,
      queue: profile.queue,
      configuration_profile: profile.configuration_profile,
      downstream_target: routeDecision === "safe_hold_required" ? "safe_hold" : profile.downstream_target,
      required_evidence_kinds: freezeArray(profile.required_evidence_kinds),
      selected_evidence_refs: freezeArray(selectedEvidenceRefs),
      rejected_evidence_refs: freezeArray(rejectedEvidenceRefs),
      forbidden_capability_blocks: freezeArray(profile.forbidden_capabilities),
      validation_issues: freezeArray(issues),
      safe_hold_required: routeDecision === "safe_hold_required" || need.task_state.safe_hold_active,
      validator_gate_required: profile.action_bearing || need.task_state.validator_gate_required,
      route_summary: summarizeRoute(need, profile, routeDecision, selectedEvidenceRefs.length),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export const DEFAULT_ROUTE_PROFILES: readonly CognitiveRouteProfile[] = freezeArray([
  makeProfile("observe", "SceneObservationReasoning", "prompt.scene_observation.v1", "SceneUnderstandingResponse", "Verification", "StrictPerception", "low", "low", "single_repair", 8000, false, "prompt_assembler", ["visual"], ["live api", "image generation", "backend truth"]),
  makeProfile("plan", "TaskPlanningReasoning", "prompt.task_planning.v1", "TaskPlanResponse", "ExecutionPlanning", "BalancedPlanning", "balanced", "high", "single_repair", 14000, true, "validator_stack", ["task", "visual", "embodiment"], ["direct actuator", "joint torque", "backend truth"]),
  makeProfile("waypoint", "WaypointGenerationReasoning", "prompt.waypoint_generation.v1", "WaypointPlanResponse", "ExecutionPlanning", "BalancedPlanning", "low", "moderate", "single_repair", 12000, true, "validator_stack", ["plan", "visual", "embodiment"], ["direct actuator", "joint torque", "physics step"]),
  makeProfile("verify", "SpatialVerificationReasoning", "prompt.spatial_verification.v1", "VisualVerificationResponse", "Verification", "StrictPerception", "low", "low", "single_repair", 7000, false, "verification_pipeline", ["visual", "uncertainty"], ["backend truth", "ground truth", "simulator"]),
  makeProfile("correct", "OopsCorrectionReasoning", "prompt.oops_correction.v1", "CorrectionPlanResponse", "SafetyImmediate", "SafetyCriticalCorrection", "low", "high", "single_repair", 10000, true, "validator_stack", ["visual", "validator", "plan"], ["override safety", "direct actuator", "reward policy"]),
  makeProfile("tool", "ToolUseReasoning", "prompt.tool_use.v1", "ToolUsePlanResponse", "ExecutionPlanning", "ToolUseExploration", "balanced", "high", "single_repair", 12000, true, "validator_stack", ["tool", "visual", "embodiment"], ["invented tool", "direct actuator", "backend truth"]),
  makeProfile("audio", "AudioEventReasoning", "prompt.audio_event.v1", "AudioActionResponse", "SafetyImmediate", "StrictPerception", "low", "low", "single_repair", 5000, true, "validator_stack", ["audio"], ["audio generation", "live api", "direct actuator"]),
  makeProfile("memory", "MemoryAssimilationReasoning", "prompt.memory_assimilation.v1", "MemoryWriteCandidateResponse", "MemoryMaintenance", "OfflineBenchmark", "deterministic", "minimal", "exponential_noncritical", 9000, false, "memory_writer", ["memory"], ["memory as truth", "backend truth", "ground truth"]),
  makeProfile("monologue", "InternalMonologueReasoning", "prompt.internal_monologue.v1", "MonologueResponse", "SafetyImmediate", "FastMonologue", "deterministic", "minimal", "none", 3000, false, "tts_filter", ["plan", "uncertainty"], ["chain-of-thought", "hidden reasoning", "audio generation"]),
]);

function makeProfile(
  needKind: CognitiveNeedKind,
  invocationClass: CognitiveInvocationClass,
  promptTemplateRef: Ref,
  outputContractRef: Ref,
  queue: CognitiveQueue,
  configurationProfile: CognitiveConfigurationProfile,
  temperatureClass: TemperatureClass,
  thinkingBudgetClass: ThinkingBudgetClass,
  retryClass: RetryClass,
  timeoutMs: number,
  actionBearing: boolean,
  downstreamTarget: DownstreamTarget,
  requiredEvidenceKinds: readonly EvidenceKind[],
  forbiddenCapabilities: readonly string[],
): CognitiveRouteProfile {
  return Object.freeze({
    need_kind: needKind,
    invocation_class: invocationClass,
    prompt_template_ref: promptTemplateRef,
    output_contract_ref: outputContractRef,
    queue,
    configuration_profile: configurationProfile,
    temperature_class: temperatureClass,
    thinking_budget_class: thinkingBudgetClass,
    retry_class: retryClass,
    timeout_ms: timeoutMs,
    action_bearing: actionBearing,
    downstream_target: downstreamTarget,
    required_evidence_kinds: freezeArray(requiredEvidenceKinds),
    forbidden_capabilities: freezeArray(forbiddenCapabilities),
  });
}

function indexProfiles(profiles: readonly CognitiveRouteProfile[]): Readonly<Record<CognitiveNeedKind, CognitiveRouteProfile>> {
  const indexed = new Map<CognitiveNeedKind, CognitiveRouteProfile>();
  for (const profile of profiles) {
    indexed.set(profile.need_kind, profile);
  }
  const missing = ALL_NEED_KINDS.filter((kind) => indexed.has(kind) === false);
  if (missing.length > 0) {
    throw new Error(`CognitiveRequestRouter profile set missing route kinds: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_NEED_KINDS.map((kind) => [kind, indexed.get(kind) as CognitiveRouteProfile])) as Record<CognitiveNeedKind, CognitiveRouteProfile>);
}

const ALL_NEED_KINDS: readonly CognitiveNeedKind[] = freezeArray(["observe", "plan", "waypoint", "verify", "correct", "tool", "audio", "memory", "monologue"]);

function profileForMultiView(base: CognitiveRouteProfile): CognitiveRouteProfile {
  return Object.freeze({
    ...base,
    invocation_class: "MultiViewDisambiguationReasoning",
    prompt_template_ref: "prompt.multiview_disambiguation.v1",
    output_contract_ref: "MultiViewConsensusResponse",
    thinking_budget_class: "moderate",
    required_evidence_kinds: freezeArray<EvidenceKind>(["visual", "uncertainty"]),
  });
}

function collectEvidence(need: CognitiveNeedEvent): readonly RouterEvidenceItem[] {
  return freezeArray([
    ...(need.observation_bundle?.observations ?? []),
    ...(need.scene_summary?.evidence ?? []),
    ...(need.memory_context?.snippets ?? []),
    ...(need.audio_event?.evidence ?? []),
    ...(need.verification_need?.visual_evidence ?? []),
    ...toolHypothesesToEvidence(need.tool_hypotheses ?? []),
    ...syntheticEvidenceForNeed(need),
  ]);
}

function syntheticEvidenceForNeed(need: CognitiveNeedEvent): readonly RouterEvidenceItem[] {
  const items: RouterEvidenceItem[] = [];
  if (need.task_instruction !== undefined && need.task_instruction.trim().length > 0) {
    items.push(makeEvidence(`task:${need.task_state.task_ref}`, "task", "orchestrator", need.task_instruction, 1));
  }
  if (need.embodiment_contract !== undefined) {
    items.push(makeEvidence(need.embodiment_contract.embodiment_ref, "embodiment", "embodiment", need.embodiment_contract.summary, 1));
  }
  if (need.validator_report !== undefined) {
    items.push(makeEvidence(need.validator_report.report_ref, "validator", "validator", need.validator_report.rejection_reasons.join("; ") || "Validator report supplied.", need.validator_report.accepted ? 1 : 0.9));
  }
  if (need.prior_plan !== undefined) {
    items.push(makeEvidence(need.prior_plan.plan_ref, "plan", "orchestrator", need.prior_plan.summary, 1));
  }
  if (need.validated_plan !== undefined) {
    items.push(makeEvidence(need.validated_plan.plan_ref, "plan", "validator", need.validated_plan.summary, 1));
  }
  if (need.uncertainty_report !== undefined) {
    items.push(makeEvidence(need.uncertainty_report.uncertainty_ref, "uncertainty", "validator", need.uncertainty_report.notes.join("; ") || need.uncertainty_report.confidence, need.uncertainty_report.confidence === "high" ? 0.9 : 0.65));
  }
  if (need.safety_summary !== undefined) {
    items.push(makeEvidence(need.safety_summary.safety_ref, "validator", "safety", need.safety_summary.constraints.join("; "), 1));
  }
  if (need.reach_report !== undefined) {
    items.push(makeEvidence(need.reach_report.report_ref, "validator", "validator", `reachable=${need.reach_report.reachable}; failed=${need.reach_report.failed_target_refs.join(",")}`, need.reach_report.validator_confidence));
  }
  return freezeArray(items);
}

function toolHypothesesToEvidence(toolHypotheses: readonly ToolHypothesis[]): readonly RouterEvidenceItem[] {
  return freezeArray(toolHypotheses.map((tool) =>
    makeEvidence(tool.tool_ref, "tool", "perception", `${tool.label}: ${tool.affordance_summary}`, tool.visible ? tool.confidence : 0)));
}

function makeEvidence(evidenceRef: Ref, kind: EvidenceKind, provenance: EvidenceProvenance, summary: string, confidence: number): RouterEvidenceItem {
  return Object.freeze({
    evidence_ref: evidenceRef,
    kind,
    provenance,
    summary,
    confidence,
    current: true,
  });
}

function validateTaskState(taskState: TaskStateSnapshot): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (taskState.task_ref.trim().length === 0) {
    issues.push(issue("error", "TaskRefMissing", "task_state.task_ref", "Task state is missing a task reference.", "Provide a stable orchestrator task ref."));
  }
  if (taskState.active_goal.trim().length === 0) {
    issues.push(issue("error", "ActiveGoalMissing", "task_state.active_goal", "Task state is missing an active goal.", "Provide the current sanitized goal."));
  }
  if (taskState.retry_budget_remaining < 0 || Number.isFinite(taskState.retry_budget_remaining) === false) {
    issues.push(issue("error", "RetryBudgetInvalid", "task_state.retry_budget_remaining", "Retry budget must be a finite non-negative number.", "Clamp retry budget before routing."));
  }
  return freezeArray(issues);
}

function validateRequiredRouteData(
  need: CognitiveNeedEvent,
  profile: CognitiveRouteProfile,
  evidence: readonly RouterEvidenceItem[],
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const requiredKind of profile.required_evidence_kinds) {
    if (evidence.some((item) => item.kind === requiredKind && item.current === true && item.confidence > 0) === false) {
      issues.push(issue("error", "RequiredEvidenceMissing", `evidence.${requiredKind}`, `Route requires ${requiredKind} evidence.`, "Attach current sensor, memory, embodiment, validator, or plan evidence before model routing."));
    }
  }
  if (need.need_kind === "observe") {
    const memoryOnly = need.observation_bundle?.memory_only === true;
    const hasVisualOrAudio = evidence.some((item) => (item.kind === "visual" || item.kind === "audio") && item.current === true && item.confidence > 0);
    if (memoryOnly === false && hasVisualOrAudio === false) {
      issues.push(issue("error", "ObservationEvidenceMissing", "observation_bundle.observations", "Observation route needs visual or audio evidence unless explicitly memory-only.", "Attach synchronized camera or audio evidence."));
    }
    if (need.observation_bundle?.synchronized === false) {
      issues.push(issue("warning", "ObservationNotSynchronized", "observation_bundle.synchronized", "Observation evidence is not synchronized.", "Prefer synchronized evidence for multi-view reasoning."));
    }
  }
  if (need.need_kind === "correct" && need.validator_report === undefined) {
    issues.push(issue("error", "ValidatorReportMissing", "validator_report", "Correction route lacks validator rejection or retry status.", "Attach validator report with retry budget."));
  }
  if (need.need_kind === "tool") {
    const groundedTools = (need.tool_hypotheses ?? []).filter((tool) => tool.visible && tool.confidence >= 0.45 && tool.evidence_refs.length > 0);
    if (groundedTools.length === 0) {
      issues.push(issue("error", "ToolHypothesisUngrounded", "tool_hypotheses", "Tool-use route has no visible, evidence-backed tool hypothesis.", "Provide at least one sensor-derived visible tool candidate."));
    }
    if (need.reach_report?.reachable === true) {
      issues.push(issue("warning", "ToolUseWithoutReachFailure", "reach_report.reachable", "Tool-use route was requested even though direct reach is still reported as feasible.", "Prefer direct manipulation unless validator identifies a reach limitation."));
    }
  }
  if (need.need_kind === "monologue" && need.safety_summary?.validator_release_ref === undefined && need.safety_summary?.safe_hold_active !== true) {
    issues.push(issue("error", "MonologueBeforeValidation", "safety_summary.validator_release_ref", "Execution monologue requires a validator release or active safe-hold explanation.", "Attach validator release before TTS-bound monologue routing."));
  }
  if (need.need_kind === "audio" && need.audio_event?.evidence.length === 0) {
    issues.push(issue("error", "AudioEvidenceMissing", "audio_event.evidence", "Audio route lacks microphone-derived evidence.", "Attach audio summary or clip reference from virtual hardware."));
  }
  if (need.need_kind === "memory" && (need.memory_context?.snippets.length ?? 0) === 0) {
    issues.push(issue("error", "MemoryEvidenceMissing", "memory_context.snippets", "Memory assimilation route has no memory snippets.", "Attach current candidate observations or prior snippets with confidence labels."));
  }
  return freezeArray(issues);
}

function scanNeedForForbiddenContent(need: CognitiveNeedEvent): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fields = flattenNeedText(need);
  for (const field of fields) {
    if (FORBIDDEN_CONTEXT_PATTERN.test(field.value)) {
      issues.push(issue("error", "ForbiddenContextDetail", field.path, "Route content contains simulator-truth or hidden implementation terminology.", "Replace it with sensor-derived, prompt-safe language."));
    }
    if (UNSUPPORTED_CAPABILITY_PATTERN.test(field.value)) {
      issues.push(issue("error", "UnsupportedCapabilityRequested", field.path, "Route content requests a capability that Project Mebsuta blocks for Gemini Robotics-ER.", "Use structured text reasoning and deterministic subsystem handoff instead."));
    }
    if (LOW_LEVEL_CONTROL_PATTERN.test(field.value)) {
      issues.push(issue("error", "LowLevelControlRequest", field.path, "Route content attempts low-level control or validator override.", "Request only high-level symbolic plans, waypoints, or orienting proposals."));
    }
    if (need.need_kind === "monologue" && HIDDEN_REASONING_PATTERN.test(field.value)) {
      issues.push(issue("error", "HiddenReasoningRequested", field.path, "Monologue route requests hidden reasoning.", "Ask only for a concise public action rationale."));
    }
  }
  return freezeArray(issues);
}

function scanRequestedCapabilities(requested: readonly string[], profile: CognitiveRouteProfile): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const forbidden = profile.forbidden_capabilities.map((capability) => capability.toLowerCase());
  for (const capability of requested) {
    const normalized = capability.toLowerCase();
    if (forbidden.some((blocked) => normalized.includes(blocked)) || UNSUPPORTED_CAPABILITY_PATTERN.test(capability)) {
      issues.push(issue("error", "CapabilityBlockedByRoute", "requested_capabilities", `Capability '${capability}' is blocked for this route.`, "Use the approved route contract and downstream deterministic subsystem."));
    }
  }
  return freezeArray(issues);
}

function validateActionBoundary(need: CognitiveNeedEvent, profile: CognitiveRouteProfile): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (profile.action_bearing && need.task_state.validator_gate_required === false) {
    issues.push(issue("error", "ActionRouteNeedsValidatorGate", "task_state.validator_gate_required", "Action-bearing route requires deterministic validator handoff.", "Enable validator gate before routing action-bearing cognitive work."));
  }
  if (profile.action_bearing && profile.output_contract_ref.endsWith("Response") === false) {
    issues.push(issue("error", "OutputContractInvalid", "output_contract_ref", "Action-bearing route lacks a named structured response contract.", "Use the architecture-defined response contract."));
  }
  if (need.task_state.safe_hold_active && need.need_kind !== "monologue" && need.need_kind !== "correct" && need.need_kind !== "audio") {
    issues.push(issue("error", "SafeHoldBlocksRoute", "task_state.safe_hold_active", "Safe-hold is active and blocks this route type.", "Route only safe-hold rationale, urgent audio, or correction diagnosis until released."));
  }
  return freezeArray(issues);
}

function validateEvidenceQuality(evidence: readonly RouterEvidenceItem[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<Ref>();
  for (const item of evidence) {
    if (seen.has(item.evidence_ref)) {
      issues.push(issue("warning", "DuplicateEvidenceRef", "evidence.evidence_ref", `Duplicate evidence ref '${item.evidence_ref}' appears in the route.`, "Deduplicate evidence before prompt assembly."));
    }
    seen.add(item.evidence_ref);
    if (item.summary.trim().length === 0) {
      issues.push(issue("error", "EvidenceSummaryMissing", item.evidence_ref, "Evidence item has an empty summary.", "Provide a concise prompt-safe evidence summary."));
    }
    if (item.confidence < 0 || item.confidence > 1 || Number.isFinite(item.confidence) === false) {
      issues.push(issue("error", "EvidenceConfidenceInvalid", item.evidence_ref, "Evidence confidence must be finite and within 0..1.", "Normalize evidence confidence before routing."));
    }
  }
  return freezeArray(issues);
}

function decideRoute(need: CognitiveNeedEvent, profile: CognitiveRouteProfile, issues: readonly ValidationIssue[]): RouteDecision {
  if (need.task_state.safe_hold_active || (need.need_kind === "correct" && need.anomaly_event?.safety_critical === true)) {
    return hasError(issues) ? "route_rejected" : "safe_hold_required";
  }
  if (profile.queue === "SafetyImmediate" && need.task_state.retry_budget_remaining === 0 && profile.action_bearing) {
    return "safe_hold_required";
  }
  return hasError(issues) ? "route_rejected" : "route_ready";
}

function isActionBearing(invocationClass: CognitiveInvocationClass): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function flattenNeedText(need: CognitiveNeedEvent): readonly { readonly path: string; readonly value: string }[] {
  const values: { readonly path: string; readonly value: string }[] = [
    { path: "task_state.active_goal", value: need.task_state.active_goal },
    { path: "task_instruction", value: need.task_instruction ?? "" },
    { path: "scene_summary.summary", value: need.scene_summary?.summary ?? "" },
    { path: "embodiment_contract.summary", value: need.embodiment_contract?.summary ?? "" },
    { path: "anomaly_event.summary", value: need.anomaly_event?.summary ?? "" },
    { path: "prior_plan.summary", value: need.prior_plan?.summary ?? "" },
    { path: "validated_plan.summary", value: need.validated_plan?.summary ?? "" },
    { path: "audio_event.summary", value: need.audio_event?.summary ?? "" },
    { path: "verification_need.relation_or_goal", value: need.verification_need?.relation_or_goal ?? "" },
  ];
  for (const item of collectEvidence(need)) {
    values.push({ path: `evidence.${item.evidence_ref}.summary`, value: item.summary });
  }
  for (const reason of need.validator_report?.rejection_reasons ?? []) {
    values.push({ path: "validator_report.rejection_reasons", value: reason });
  }
  for (const note of need.uncertainty_report?.notes ?? []) {
    values.push({ path: "uncertainty_report.notes", value: note });
  }
  for (const constraint of need.safety_summary?.constraints ?? []) {
    values.push({ path: "safety_summary.constraints", value: constraint });
  }
  return freezeArray(values.filter((entry) => entry.value.trim().length > 0));
}

function summarizeRoute(need: CognitiveNeedEvent, profile: CognitiveRouteProfile, decision: RouteDecision, evidenceCount: number): string {
  return `${decision}: ${need.need_kind} -> ${profile.invocation_class} using ${profile.output_contract_ref}; selected ${evidenceCount} evidence refs for ${profile.queue}.`;
}

function ambiguityToUncertainty(report: AmbiguityReport): UncertaintyReport {
  return Object.freeze({
    uncertainty_ref: report.ambiguity_ref,
    confidence: report.level === "none" || report.level === "low" ? "high" : report.level === "medium" ? "medium" : "low",
    notes: freezeArray([...(report.missing_observations ?? []), ...(report.conflicting_evidence_refs ?? []).map((ref) => `conflict:${ref}`)]),
    reobserve_required: report.requires_reobserve,
  });
}

function makeSyntheticTaskState(
  phase: TaskStateSnapshot["phase"],
  goal: string,
  criticality: TaskCriticality,
  retryBudgetRemaining = 1,
): TaskStateSnapshot {
  return Object.freeze({
    task_ref: makeRef("task", goal.slice(0, 80), phase),
    active_goal: goal,
    phase,
    criticality,
    retry_budget_remaining: retryBudgetRemaining,
    safe_hold_active: phase === "safe_hold",
    validator_gate_required: criticality !== "background",
  });
}

function makeValidationReport(routeDecision: RouteDecision, issues: readonly ValidationIssue[]): RouterValidationReport {
  const base = {
    schema_version: COGNITIVE_REQUEST_ROUTER_SCHEMA_VERSION,
    route_decision: routeDecision,
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function hasError(issues: readonly ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}
