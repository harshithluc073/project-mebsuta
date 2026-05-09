/**
 * Reach envelope service for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.11, 5.12, 5.14, 5.15, 5.16, 5.19, and 5.20.
 *
 * This module is the executable reach authority used by plan validation,
 * manipulation, tool-use planning, Gemini repair hints, and control admission.
 * It evaluates natural static reach, posture-adjusted reach, repositioned
 * reach, tool-extended reach, precision reach, target uncertainty, stance
 * stability, and end-effector availability without exposing simulator truth,
 * backend handles, hidden world poses, collision meshes, or exact hidden COM.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type {
  EmbodimentDescriptor,
  EndEffectorDescriptor,
  EndEffectorRole,
  ManipulationPrimitive,
  PrecisionRating,
  ReachDecisionKind,
  ReachEnvelopeDescriptor,
  StabilityState,
  ToolState,
} from "./embodiment_model_registry";
import type { StanceState, StabilityDecision } from "./stability_policy_service";

export const REACH_ENVELOPE_SERVICE_SCHEMA_VERSION = "mebsuta.reach_envelope_service.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|hidden_com)/i;

export type ReachMode = "natural_static" | "posture_adjusted" | "repositioned" | "tool_extended" | "precision" | "unsafe_exclusion";
export type ReachRecommendedAction = "continue" | "adjust_posture" | "reposition" | "use_tool" | "reject" | "re_observe";
export type ReachAdmission = "admit" | "admit_with_posture_change" | "admit_with_reposition" | "admit_with_tool_validation" | "reject" | "re_observe";
export type ToolAttachmentState = ToolState;

export type ReachEnvelopeIssueCode =
  | "ActiveEmbodimentMissing"
  | "TargetEstimateMissing"
  | "TargetEstimateInvalid"
  | "EndEffectorUnavailable"
  | "ReachSummaryUnavailable"
  | "ReachUnsafe"
  | "ToolAttachmentInvalid"
  | "ToolReachInvalid"
  | "PerceptionUncertain"
  | "StanceStateInvalid"
  | "StabilityGateRejected"
  | "ForbiddenBodyDetail";

export interface ReachEnvelopeServiceConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface ReachTargetEstimate {
  readonly target_ref: Ref;
  readonly position_in_base_frame_m: Vector3;
  readonly confidence: number;
  readonly estimate_source: "camera" | "depth" | "contact" | "memory" | "fused_sensor_estimate";
  readonly uncertainty_radius_m?: number;
}

export interface ToolReachState {
  readonly tool_state: ToolAttachmentState;
  readonly attached_effector_ref?: Ref;
  readonly tool_length_m?: number;
  readonly tool_slip_risk?: number;
  readonly tool_precision_multiplier?: number;
  readonly validated_attachment_ref?: Ref;
}

export interface ReachEnvelopeEvaluationInput {
  readonly active_embodiment_ref?: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly target_estimate?: ReachTargetEstimate;
  readonly stance_state?: StanceState;
  readonly stance_stability?: StabilityState;
  readonly stability_decision?: StabilityDecision;
  readonly tool_state?: ToolReachState;
  readonly required_precision_radius_m?: number;
  readonly required_primitive?: ManipulationPrimitive;
}

export interface ReachEnvelopeBands {
  readonly natural_static_radius_m: number;
  readonly posture_adjusted_radius_m: number;
  readonly reposition_radius_m: number;
  readonly tool_extended_radius_m: number;
  readonly precision_radius_m: number;
  readonly unsafe_margin_m: number;
  readonly active_radius_m: number;
  readonly active_mode: ReachMode;
}

export interface ReachDistanceReport {
  readonly target_distance_m: number;
  readonly target_uncertainty_m: number;
  readonly radial_margin_m: number;
  readonly precision_margin_m: number;
  readonly confidence: number;
}

export interface ReachDecision {
  readonly schema_version: typeof REACH_ENVELOPE_SERVICE_SCHEMA_VERSION;
  readonly decision_id: Ref;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_ref: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly stance_ref: Ref;
  readonly reach_envelope_ref: Ref;
  readonly decision: ReachDecisionKind;
  readonly recommended_action: ReachRecommendedAction;
  readonly validator_admission: ReachAdmission;
  readonly reach_bands: ReachEnvelopeBands;
  readonly distance_report: ReachDistanceReport;
  readonly stability_state: StabilityState;
  readonly precision_rating: PrecisionRating;
  readonly tool_validation_required: boolean;
  readonly reposition_required: boolean;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ReachEnvelopeCatalogReport {
  readonly schema_version: typeof REACH_ENVELOPE_SERVICE_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly envelope_count: number;
  readonly end_effector_count: number;
  readonly natural_reach_max_m: number;
  readonly posture_adjusted_reach_max_m: number;
  readonly reposition_reach_max_m: number;
  readonly tool_extended_reach_max_m: number;
  readonly precision_reach_max_m: number;
  readonly envelope_summaries: readonly ReachEnvelopeSummary[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ReachEnvelopeSummary {
  readonly reach_envelope_ref: Ref;
  readonly end_effector_ref: Ref;
  readonly end_effector_role?: EndEffectorRole;
  readonly stance_ref: Ref;
  readonly natural_radius_m: number;
  readonly posture_adjusted_radius_m: number;
  readonly reposition_radius_m: number;
  readonly tool_extended_radius_m: number;
  readonly precision_radius_m: number;
  readonly workspace_region_summary: string;
  readonly limitation_summary?: string;
}

export interface ReachBatchEvaluationInput {
  readonly active_embodiment_ref?: Ref;
  readonly requests: readonly ReachEnvelopeEvaluationInput[];
}

export interface ReachBatchEvaluationReport {
  readonly schema_version: typeof REACH_ENVELOPE_SERVICE_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly request_count: number;
  readonly reachable_now_count: number;
  readonly posture_change_count: number;
  readonly reposition_count: number;
  readonly tool_count: number;
  readonly rejected_count: number;
  readonly unknown_count: number;
  readonly decisions: readonly ReachDecision[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveReachSummary {
  readonly schema_version: typeof REACH_ENVELOPE_SERVICE_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_role: EndEffectorRole;
  readonly decision: ReachDecisionKind;
  readonly recommended_action: ReachRecommendedAction;
  readonly approximate_reach_class: "inside_natural_reach" | "posture_change_needed" | "reposition_needed" | "tool_may_help" | "unsafe_or_unreachable" | "uncertain";
  readonly summary: string;
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export class ReachEnvelopeServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ReachEnvelopeServiceError";
    this.issues = issues;
  }
}

/**
 * Resolves declared reach envelopes and evaluates target feasibility for the
 * active embodiment and requested end effector.
 */
export class ReachEnvelopeService {
  private readonly registry: EmbodimentModelRegistry;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: ReachEnvelopeServiceConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    if (config.embodiment !== undefined) {
      this.registry.registerEmbodimentModel(config.embodiment);
    }
    if (config.active_embodiment_ref !== undefined) {
      this.selectActiveEmbodiment(config.active_embodiment_ref);
    } else if (config.embodiment !== undefined) {
      this.activeEmbodimentRef = config.embodiment.embodiment_id;
    }
  }

  /**
   * Selects the embodiment used by later reach evaluations.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Builds a sanitized catalog of declared reach bands for prompt providers,
   * validators, and QA dashboards.
   */
  public buildReachEnvelopeCatalogReport(activeEmbodimentRef?: Ref): ReachEnvelopeCatalogReport {
    const model = this.requireEmbodiment(activeEmbodimentRef);
    const issues = validateEnvelopeCoverage(model);
    const summaries = freezeArray(model.reach_envelopes
      .map((envelope) => summarizeEnvelope(model, envelope))
      .sort((a, b) => a.reach_envelope_ref.localeCompare(b.reach_envelope_ref)));
    const base = {
      schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      envelope_count: model.reach_envelopes.length,
      end_effector_count: model.end_effectors.length,
      natural_reach_max_m: round6(maxOf(model.reach_envelopes.map((envelope) => envelope.natural_radius_m))),
      posture_adjusted_reach_max_m: round6(maxOf(model.reach_envelopes.map((envelope) => envelope.posture_adjusted_radius_m))),
      reposition_reach_max_m: round6(maxOf(model.reach_envelopes.map((envelope) => envelope.reposition_radius_m))),
      tool_extended_reach_max_m: round6(maxOf(model.reach_envelopes.map((envelope) => envelope.tool_extended_radius_m ?? 0))),
      precision_reach_max_m: round6(maxOf(model.reach_envelopes.map((envelope) => envelope.precision_radius_m ?? 0))),
      envelope_summaries: summaries,
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Implements `evaluateReachEnvelope(activeEmbodimentRef, endEffectorRole,
   * targetEstimate, stanceState, toolState) -> ReachDecision`.
   */
  public evaluateReachEnvelope(input: ReachEnvelopeEvaluationInput): ReachDecision {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const issues: ValidationIssue[] = [];
    const effector = model.end_effectors.find((candidate) => candidate.role === input.end_effector_role);
    if (effector === undefined) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.end_effector_role", `End effector ${input.end_effector_role} is not declared for ${model.embodiment_kind}.`, "Choose a declared end effector from the active body model."));
      return buildUnavailableDecision(model, input, issues);
    }

    const stanceRef = input.stance_state?.stance_ref ?? model.stability_policy.default_stance_ref;
    validateSafeRef(stanceRef, "$.stance_state.stance_ref", issues, "StanceStateInvalid");
    validateTarget(input.target_estimate, model, issues);
    validateToolState(input.tool_state, effector, model, issues);
    validateFiniteOptional(input.required_precision_radius_m, "$.required_precision_radius_m", issues, "TargetEstimateInvalid", 0);

    const envelope = selectEnvelope(model, effector, stanceRef, issues);
    if (input.target_estimate === undefined || envelope === undefined) {
      return buildMissingDataDecision(model, effector, stanceRef, envelope, input, issues);
    }

    const targetDistance = vectorNorm(input.target_estimate.position_in_base_frame_m);
    const uncertainty = input.target_estimate.uncertainty_radius_m ?? model.safety_margin_policy.reach_uncertainty_m;
    const stabilityState = input.stability_decision?.stability_state ?? input.stance_stability ?? "stable";
    applyStabilityGate(input.stability_decision, stabilityState, issues);

    const bands = buildReachBands(model, effector, envelope, input.tool_state, stabilityState);
    const distanceReport = buildDistanceReport(input.target_estimate, targetDistance, uncertainty, bands, input.required_precision_radius_m);
    const decisionKind = chooseReachDecision(input, model, envelope, bands, distanceReport, stabilityState, issues);
    const recommendedAction = chooseAction(decisionKind, input.tool_state, stabilityState);
    const admission = chooseAdmission(decisionKind, recommendedAction, issues);
    const safeSummary = sanitizeText(buildPromptSafeReachSummary(model, effector, decisionKind, recommendedAction, distanceReport, bands, stabilityState));
    assertNoForbiddenLeak(safeSummary);
    const base = {
      schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
      decision_id: `reach_${model.embodiment_id}_${effector.effector_ref}_${computeDeterminismHash({
        target: input.target_estimate,
        stanceRef,
        stabilityState,
        tool: input.tool_state,
        bands,
        decisionKind,
      }).slice(0, 12)}`,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      end_effector_ref: effector.effector_ref,
      end_effector_role: effector.role,
      stance_ref: stanceRef,
      reach_envelope_ref: envelope.reach_envelope_id,
      decision: decisionKind,
      recommended_action: recommendedAction,
      validator_admission: admission,
      reach_bands: bands,
      distance_report: distanceReport,
      stability_state: stabilityState,
      precision_rating: effector.precision_rating,
      tool_validation_required: decisionKind === "ReachableWithTool" && input.tool_state?.tool_state !== "attached",
      reposition_required: decisionKind === "ReachableAfterReposition",
      prompt_safe_summary: safeSummary,
      hidden_fields_removed: hiddenFieldsRemoved(input),
      issues: freezeArray(issues),
      ok: admission === "admit",
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates multiple reach candidates while retaining per-request decisions.
   */
  public evaluateBatch(input: ReachBatchEvaluationInput): ReachBatchEvaluationReport {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const decisions = input.requests.map((request) => this.evaluateReachEnvelope({
      ...request,
      active_embodiment_ref: request.active_embodiment_ref ?? model.embodiment_id,
    }));
    const issues = freezeArray(decisions.flatMap((decision, index) => decision.issues.map((issue) => Object.freeze({
      ...issue,
      path: `$.requests[${index}]${issue.path.startsWith("$") ? issue.path.slice(1) : `.${issue.path}`}`,
    }))));
    const base = {
      schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      request_count: decisions.length,
      reachable_now_count: decisions.filter((decision) => decision.decision === "ReachableNow").length,
      posture_change_count: decisions.filter((decision) => decision.decision === "ReachableWithPostureChange").length,
      reposition_count: decisions.filter((decision) => decision.decision === "ReachableAfterReposition").length,
      tool_count: decisions.filter((decision) => decision.decision === "ReachableWithTool").length,
      rejected_count: decisions.filter((decision) => decision.decision === "UnreachableOrUnsafe").length,
      unknown_count: decisions.filter((decision) => decision.decision === "UnknownDueToPerception").length,
      decisions: freezeArray(decisions),
      issues,
      ok: decisions.every((decision) => decision.ok),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Converts a detailed reach decision into a Gemini-safe capability summary.
   */
  public buildCognitiveReachSummary(decision: ReachDecision): CognitiveReachSummary {
    const hiddenFields = freezeArray([...decision.hidden_fields_removed, "distance_report.target_distance_m", "reach_bands.active_radius_m"]);
    const summary = sanitizeText(decision.prompt_safe_summary);
    assertNoForbiddenLeak(summary);
    const base = {
      schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
      embodiment_ref: decision.embodiment_ref,
      embodiment_kind: decision.embodiment_kind,
      end_effector_role: decision.end_effector_role,
      decision: decision.decision,
      recommended_action: decision.recommended_action,
      approximate_reach_class: approximateReachClass(decision.decision),
      summary,
      forbidden_detail_report_ref: `reach_hidden_${computeDeterminismHash({ decision_id: decision.decision_id, hiddenFields }).slice(0, 12)}`,
      hidden_fields_removed: hiddenFields,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireEmbodiment(embodimentRef?: Ref): EmbodimentDescriptor {
    const activeRef = embodimentRef ?? this.activeEmbodimentRef;
    if (activeRef !== undefined) {
      assertSafeRef(activeRef, "$.active_embodiment_ref");
      return this.registry.requireEmbodiment(activeRef);
    }
    const selected = this.registry.listEmbodiments().at(0);
    if (selected === undefined) {
      throw new ReachEnvelopeServiceError("No active embodiment is registered for reach evaluation.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before reach evaluation."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createReachEnvelopeService(config: ReachEnvelopeServiceConfig = {}): ReachEnvelopeService {
  return new ReachEnvelopeService(config);
}

function validateEnvelopeCoverage(model: EmbodimentDescriptor): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const effector of model.end_effectors) {
    if (!model.reach_envelopes.some((envelope) => envelope.end_effector_ref === effector.effector_ref)) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", `End effector ${effector.effector_ref} has no declared reach envelope.`, "Declare a reach envelope for every end effector."));
    }
  }
  for (const envelope of model.reach_envelopes) {
    if (!model.end_effectors.some((effector) => effector.effector_ref === envelope.end_effector_ref)) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.reach_envelopes", `Reach envelope ${envelope.reach_envelope_id} references an undeclared end effector.`, "Bind reach envelopes to declared end effectors."));
    }
    if (envelope.natural_radius_m <= 0 || envelope.posture_adjusted_radius_m < envelope.natural_radius_m || envelope.reposition_radius_m < envelope.posture_adjusted_radius_m) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", `Reach envelope ${envelope.reach_envelope_id} has invalid radius ordering.`, "Use natural <= posture adjusted <= reposition radius."));
    }
    if (FORBIDDEN_DETAIL_PATTERN.test(envelope.workspace_region_summary) || FORBIDDEN_DETAIL_PATTERN.test(envelope.precision_region_summary ?? "") || FORBIDDEN_DETAIL_PATTERN.test(envelope.unsafe_region_summary ?? "")) {
      issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.reach_envelopes", `Reach envelope ${envelope.reach_envelope_id} contains forbidden detail text.`, "Use prompt-safe qualitative reach summaries."));
    }
  }
  return freezeArray(issues);
}

function summarizeEnvelope(model: EmbodimentDescriptor, envelope: ReachEnvelopeDescriptor): ReachEnvelopeSummary {
  const effector = model.end_effectors.find((candidate) => candidate.effector_ref === envelope.end_effector_ref);
  return Object.freeze({
    reach_envelope_ref: envelope.reach_envelope_id,
    end_effector_ref: envelope.end_effector_ref,
    end_effector_role: effector?.role,
    stance_ref: envelope.stance_ref,
    natural_radius_m: round6(envelope.natural_radius_m),
    posture_adjusted_radius_m: round6(envelope.posture_adjusted_radius_m),
    reposition_radius_m: round6(envelope.reposition_radius_m),
    tool_extended_radius_m: round6(envelope.tool_extended_radius_m ?? 0),
    precision_radius_m: round6(envelope.precision_radius_m ?? 0),
    workspace_region_summary: sanitizeText(envelope.workspace_region_summary),
    limitation_summary: envelope.unsafe_region_summary === undefined ? undefined : sanitizeText(envelope.unsafe_region_summary),
  });
}

function buildUnavailableDecision(model: EmbodimentDescriptor, input: ReachEnvelopeEvaluationInput, issues: readonly ValidationIssue[]): ReachDecision {
  const bands = emptyBands("unsafe_exclusion");
  const distance = emptyDistance(input.target_estimate?.confidence ?? 0);
  const base = {
    schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
    decision_id: `reach_${model.embodiment_id}_unavailable_${computeDeterminismHash(input).slice(0, 12)}`,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    end_effector_ref: "unavailable_effector",
    end_effector_role: input.end_effector_role,
    stance_ref: input.stance_state?.stance_ref ?? model.stability_policy.default_stance_ref,
    reach_envelope_ref: "unavailable_envelope",
    decision: "UnknownDueToPerception" as ReachDecisionKind,
    recommended_action: "reject" as ReachRecommendedAction,
    validator_admission: "reject" as ReachAdmission,
    reach_bands: bands,
    distance_report: distance,
    stability_state: input.stance_stability ?? input.stability_decision?.stability_state ?? "unknown" as StabilityState,
    precision_rating: "low" as PrecisionRating,
    tool_validation_required: false,
    reposition_required: false,
    prompt_safe_summary: "Requested end effector is unavailable for the active body.",
    hidden_fields_removed: hiddenFieldsRemoved(input),
    issues: freezeArray(issues),
    ok: false,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildMissingDataDecision(
  model: EmbodimentDescriptor,
  effector: EndEffectorDescriptor,
  stanceRef: Ref,
  envelope: ReachEnvelopeDescriptor | undefined,
  input: ReachEnvelopeEvaluationInput,
  issues: readonly ValidationIssue[],
): ReachDecision {
  const bands = envelope === undefined ? emptyBands("unsafe_exclusion") : buildReachBands(model, effector, envelope, input.tool_state, input.stance_stability ?? input.stability_decision?.stability_state ?? "unknown");
  const distance = emptyDistance(input.target_estimate?.confidence ?? 0);
  const decision = input.target_estimate === undefined ? "UnknownDueToPerception" : "UnreachableOrUnsafe";
  const action = input.target_estimate === undefined ? "re_observe" : "reject";
  const admission = input.target_estimate === undefined ? "re_observe" : "reject";
  const base = {
    schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
    decision_id: `reach_${model.embodiment_id}_${effector.effector_ref}_missing_${computeDeterminismHash({ stanceRef, input }).slice(0, 12)}`,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    end_effector_ref: effector.effector_ref,
    end_effector_role: effector.role,
    stance_ref: stanceRef,
    reach_envelope_ref: envelope?.reach_envelope_id ?? "missing_envelope",
    decision: decision as ReachDecisionKind,
    recommended_action: action as ReachRecommendedAction,
    validator_admission: admission as ReachAdmission,
    reach_bands: bands,
    distance_report: distance,
    stability_state: input.stance_stability ?? input.stability_decision?.stability_state ?? "unknown" as StabilityState,
    precision_rating: effector.precision_rating,
    tool_validation_required: false,
    reposition_required: false,
    prompt_safe_summary: input.target_estimate === undefined ? "Target estimate is missing; re-observe before reaching." : "Reach envelope is unavailable for this end effector.",
    hidden_fields_removed: hiddenFieldsRemoved(input),
    issues: freezeArray(issues),
    ok: false,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function selectEnvelope(model: EmbodimentDescriptor, effector: EndEffectorDescriptor, stanceRef: Ref, issues: ValidationIssue[]): ReachEnvelopeDescriptor | undefined {
  const exact = model.reach_envelopes.find((candidate) => candidate.end_effector_ref === effector.effector_ref && candidate.stance_ref === stanceRef);
  const fallback = exact ?? model.reach_envelopes.find((candidate) => candidate.end_effector_ref === effector.effector_ref);
  if (fallback === undefined) {
    issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", `No reach envelope exists for ${effector.effector_ref}.`, "Declare a reach envelope for every end effector."));
  } else if (exact === undefined) {
    issues.push(makeIssue("warning", "StanceStateInvalid", "$.stance_state.stance_ref", `No reach envelope is declared for stance ${stanceRef}; using declared effector fallback.`, "Declare stance-specific reach envelopes for precision validation."));
  }
  return fallback;
}

function validateTarget(target: ReachTargetEstimate | undefined, model: EmbodimentDescriptor, issues: ValidationIssue[]): void {
  if (target === undefined) {
    issues.push(makeIssue("error", "TargetEstimateMissing", "$.target_estimate", "Reach validation requires a sensor-derived target estimate.", "Re-observe or provide a fused body-relative target estimate."));
    return;
  }
  validateSafeRef(target.target_ref, "$.target_estimate.target_ref", issues, "TargetEstimateInvalid");
  validateVector3(target.position_in_base_frame_m, "$.target_estimate.position_in_base_frame_m", issues, "TargetEstimateInvalid");
  validateUnitInterval(target.confidence, "$.target_estimate.confidence", issues, "TargetEstimateInvalid");
  validateFiniteOptional(target.uncertainty_radius_m, "$.target_estimate.uncertainty_radius_m", issues, "TargetEstimateInvalid", 0);
  if (target.confidence < model.safety_margin_policy.target_confidence_minimum) {
    issues.push(makeIssue("warning", "PerceptionUncertain", "$.target_estimate.confidence", "Target confidence is below the active embodiment safety margin.", "Re-observe before committing to reach or tool-use."));
  }
}

function validateToolState(tool: ToolReachState | undefined, effector: EndEffectorDescriptor, model: EmbodimentDescriptor, issues: ValidationIssue[]): void {
  if (tool === undefined || tool.tool_state === "absent") {
    return;
  }
  validateSafeRef(tool.attached_effector_ref, "$.tool_state.attached_effector_ref", issues, "ToolAttachmentInvalid");
  validateSafeRef(tool.validated_attachment_ref, "$.tool_state.validated_attachment_ref", issues, "ToolAttachmentInvalid");
  validateFiniteOptional(tool.tool_length_m, "$.tool_state.tool_length_m", issues, "ToolReachInvalid", 0);
  if (tool.tool_slip_risk !== undefined) {
    validateUnitInterval(tool.tool_slip_risk, "$.tool_state.tool_slip_risk", issues, "ToolAttachmentInvalid");
  }
  validateFiniteOptional(tool.tool_precision_multiplier, "$.tool_state.tool_precision_multiplier", issues, "ToolReachInvalid", 0);
  if (tool.tool_state === "attached" && tool.attached_effector_ref !== undefined && tool.attached_effector_ref !== effector.effector_ref) {
    issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.tool_state.attached_effector_ref", "Tool is attached to a different end effector than the requested reach effector.", "Use the end effector that owns the validated tool frame."));
  }
  if ((tool.tool_slip_risk ?? 0) > model.safety_margin_policy.tool_slip_maximum) {
    issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.tool_state.tool_slip_risk", "Tool slip risk exceeds the active embodiment limit.", "Regrasp or validate tool attachment before extending reach."));
  }
  if (tool.tool_state === "expired" || tool.tool_state === "unstable") {
    issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.tool_state.tool_state", "Tool state cannot extend reach for execution.", "Refresh or validate the task-scoped tool frame."));
  }
}

function buildReachBands(
  model: EmbodimentDescriptor,
  effector: EndEffectorDescriptor,
  envelope: ReachEnvelopeDescriptor,
  tool: ToolReachState | undefined,
  stabilityState: StabilityState,
): ReachEnvelopeBands {
  const uncertaintyPadding = model.safety_margin_policy.reach_uncertainty_m;
  const stabilityScale = stabilityState === "stable" ? 1 : stabilityState === "marginal" ? 0.88 : 0.7;
  const natural = Math.max(0, Math.min(effector.natural_reach_radius_m, envelope.natural_radius_m) * stabilityScale);
  const posture = Math.max(natural, envelope.posture_adjusted_radius_m * stabilityScale);
  const reposition = Math.max(posture, envelope.reposition_radius_m);
  const toolUsable = tool?.tool_state === "attached" && (tool.tool_slip_risk ?? 0) <= model.safety_margin_policy.tool_slip_maximum;
  const declaredToolReach = Math.max(effector.tool_extended_reach_radius_m ?? 0, envelope.tool_extended_radius_m ?? 0);
  const candidateToolReach = Math.max(declaredToolReach, natural + (tool?.tool_length_m ?? 0) - uncertaintyPadding);
  const toolReach = toolUsable ? Math.max(posture, candidateToolReach) : declaredToolReach;
  const precisionMultiplier = clamp(tool?.tool_precision_multiplier ?? 1, 0.1, 1.5);
  const precision = Math.max(0, (envelope.precision_radius_m ?? natural * precisionDefault(effector.precision_rating)) * precisionMultiplier * stabilityScale);
  const active = toolUsable ? toolReach : natural;
  const activeMode = toolUsable ? "tool_extended" : "natural_static";
  return Object.freeze({
    natural_static_radius_m: round6(natural),
    posture_adjusted_radius_m: round6(posture),
    reposition_radius_m: round6(reposition),
    tool_extended_radius_m: round6(toolReach),
    precision_radius_m: round6(precision),
    unsafe_margin_m: round6(envelope.unsafe_minimum_margin_m),
    active_radius_m: round6(active),
    active_mode: activeMode,
  });
}

function buildDistanceReport(target: ReachTargetEstimate, distance: number, uncertainty: number, bands: ReachEnvelopeBands, requiredPrecision: number | undefined): ReachDistanceReport {
  const totalUncertainty = Math.max(uncertainty, 0);
  const precisionRequirement = requiredPrecision ?? bands.precision_radius_m;
  return Object.freeze({
    target_distance_m: round6(distance),
    target_uncertainty_m: round6(totalUncertainty),
    radial_margin_m: round6(bands.active_radius_m - distance - totalUncertainty - bands.unsafe_margin_m),
    precision_margin_m: round6(bands.precision_radius_m - Math.min(distance, precisionRequirement) - totalUncertainty),
    confidence: clamp(target.confidence, 0, 1),
  });
}

function chooseReachDecision(
  input: ReachEnvelopeEvaluationInput,
  model: EmbodimentDescriptor,
  envelope: ReachEnvelopeDescriptor,
  bands: ReachEnvelopeBands,
  distance: ReachDistanceReport,
  stability: StabilityState,
  issues: ValidationIssue[],
): ReachDecisionKind {
  const targetExtent = distance.target_distance_m + distance.target_uncertainty_m + envelope.unsafe_minimum_margin_m;
  if (input.target_estimate === undefined || input.target_estimate.confidence < model.safety_margin_policy.target_confidence_minimum) {
    return "UnknownDueToPerception";
  }
  if (stability === "unstable") {
    issues.push(makeIssue("error", "StabilityGateRejected", "$.stability_decision.stability_state", "Reach cannot be admitted while body stability is unstable.", "Stabilize, crouch, reposition, or enter safe-hold."));
    return "UnreachableOrUnsafe";
  }
  if (input.required_primitive !== undefined && !effectorSupportsPrimitive(model, input.end_effector_role, input.required_primitive)) {
    issues.push(makeIssue("error", "EndEffectorUnavailable", "$.required_primitive", "Requested manipulation primitive is not supported by this end effector.", "Choose a supported primitive or another end effector."));
    return "UnreachableOrUnsafe";
  }
  if (distance.radial_margin_m >= 0 && stability !== "unknown") {
    return "ReachableNow";
  }
  if (targetExtent <= bands.posture_adjusted_radius_m) {
    return "ReachableWithPostureChange";
  }
  const toolMayHelp = targetExtent <= bands.tool_extended_radius_m && input.tool_state?.tool_state !== "expired";
  if (toolMayHelp) {
    if (input.tool_state?.tool_state !== "attached") {
      issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.tool_state.tool_state", "Tool reach requires candidate discovery and validated attachment before execution.", "Validate a task-scoped tool frame before extending reach."));
    }
    return "ReachableWithTool";
  }
  if (targetExtent <= bands.reposition_radius_m) {
    return "ReachableAfterReposition";
  }
  issues.push(makeIssue("error", "ReachUnsafe", "$.target_estimate.position_in_base_frame_m", "Target is outside declared safe reach envelopes for the requested body state.", "Reposition, choose another effector, use a validated tool, or request help."));
  return "UnreachableOrUnsafe";
}

function applyStabilityGate(decision: StabilityDecision | undefined, state: StabilityState, issues: ValidationIssue[]): void {
  if (decision === undefined) {
    if (state === "unknown") {
      issues.push(makeIssue("warning", "StabilityGateRejected", "$.stance_stability", "Stance stability is unknown for reach validation.", "Run stability policy evaluation before control admission."));
    }
    return;
  }
  if (decision.validator_admission === "safe_hold" || decision.validator_admission === "reject" || decision.safe_hold_required) {
    issues.push(makeIssue("error", "StabilityGateRejected", "$.stability_decision", "Stability policy rejected the planned reach state.", "Follow stability recommendation before reach execution."));
  } else if (decision.validator_admission === "admit_with_speed_limit") {
    issues.push(makeIssue("warning", "StabilityGateRejected", "$.stability_decision", "Reach is only allowed with the stability service speed or posture limit.", "Apply stability speed scale before control execution."));
  }
}

function chooseAction(decision: ReachDecisionKind, tool: ToolReachState | undefined, stability: StabilityState): ReachRecommendedAction {
  if (decision === "ReachableNow") {
    return stability === "marginal" ? "adjust_posture" : "continue";
  }
  if (decision === "ReachableWithPostureChange") {
    return "adjust_posture";
  }
  if (decision === "ReachableAfterReposition") {
    return "reposition";
  }
  if (decision === "ReachableWithTool") {
    return tool?.tool_state === "attached" ? "continue" : "use_tool";
  }
  if (decision === "UnknownDueToPerception") {
    return "re_observe";
  }
  return "reject";
}

function chooseAdmission(decision: ReachDecisionKind, action: ReachRecommendedAction, issues: readonly ValidationIssue[]): ReachAdmission {
  if (decision === "UnknownDueToPerception") {
    return "re_observe";
  }
  if (issues.some((issue) => issue.severity === "error") || decision === "UnreachableOrUnsafe") {
    return "reject";
  }
  if (decision === "ReachableNow" && action === "continue") {
    return "admit";
  }
  if (decision === "ReachableWithPostureChange") {
    return "admit_with_posture_change";
  }
  if (decision === "ReachableAfterReposition") {
    return "admit_with_reposition";
  }
  if (decision === "ReachableWithTool") {
    return action === "continue" ? "admit" : "admit_with_tool_validation";
  }
  return "reject";
}

function buildPromptSafeReachSummary(
  model: EmbodimentDescriptor,
  effector: EndEffectorDescriptor,
  decision: ReachDecisionKind,
  action: ReachRecommendedAction,
  distance: ReachDistanceReport,
  bands: ReachEnvelopeBands,
  stability: StabilityState,
): string {
  const body = model.embodiment_kind === "quadruped" ? "Quadruped" : "Humanoid";
  if (decision === "ReachableNow") {
    return `${body} ${effector.role} appears inside current stable reach with ${distance.confidence.toFixed(2)} target confidence.`;
  }
  if (decision === "ReachableWithPostureChange") {
    return `${body} ${effector.role} may reach after a validated posture change; current stability is ${stability}.`;
  }
  if (decision === "ReachableAfterReposition") {
    return `${body} should reposition before using ${effector.role}; target is beyond current reach.`;
  }
  if (decision === "ReachableWithTool") {
    return `${body} may need a validated task-scoped tool for ${effector.role}; approximate tool reach class is ${bands.active_mode}.`;
  }
  if (decision === "UnknownDueToPerception") {
    return `${body} reach is uncertain because target or stability evidence is insufficient; re-observe before motion.`;
  }
  return `${body} cannot safely reach the target with ${effector.role}; recommended action is ${action}.`;
}

function effectorSupportsPrimitive(model: EmbodimentDescriptor, role: EndEffectorRole, primitive: ManipulationPrimitive): boolean {
  return model.manipulation_capabilities.some((capability) => capability.end_effector_role === role && capability.supported_primitives.includes(primitive));
}

function approximateReachClass(decision: ReachDecisionKind): CognitiveReachSummary["approximate_reach_class"] {
  if (decision === "ReachableNow") {
    return "inside_natural_reach";
  }
  if (decision === "ReachableWithPostureChange") {
    return "posture_change_needed";
  }
  if (decision === "ReachableAfterReposition") {
    return "reposition_needed";
  }
  if (decision === "ReachableWithTool") {
    return "tool_may_help";
  }
  if (decision === "UnknownDueToPerception") {
    return "uncertain";
  }
  return "unsafe_or_unreachable";
}

function precisionDefault(precision: PrecisionRating): number {
  if (precision === "high") {
    return 0.78;
  }
  if (precision === "medium") {
    return 0.62;
  }
  return 0.45;
}

function emptyBands(mode: ReachMode): ReachEnvelopeBands {
  return Object.freeze({
    natural_static_radius_m: 0,
    posture_adjusted_radius_m: 0,
    reposition_radius_m: 0,
    tool_extended_radius_m: 0,
    precision_radius_m: 0,
    unsafe_margin_m: 0,
    active_radius_m: 0,
    active_mode: mode,
  });
}

function emptyDistance(confidence: number): ReachDistanceReport {
  return Object.freeze({
    target_distance_m: 0,
    target_uncertainty_m: 0,
    radial_margin_m: 0,
    precision_margin_m: 0,
    confidence: clamp(confidence, 0, 1),
  });
}

function hiddenFieldsRemoved(input: ReachEnvelopeEvaluationInput): readonly string[] {
  const removed = ["target_estimate.position_in_base_frame_m", "reach_bands.active_radius_m", "distance_report.target_distance_m"];
  if (input.stability_decision !== undefined) {
    removed.push("stability_decision.support_geometry");
  }
  if (input.tool_state?.validated_attachment_ref !== undefined) {
    removed.push("tool_state.validated_attachment_ref");
  }
  return freezeArray(removed);
}

function validateVector3(value: Vector3, path: string, issues: ValidationIssue[], code: ReachEnvelopeIssueCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite numbers.", "Use a body-relative [x, y, z] target estimate in meters."));
  }
}

function validateFiniteOptional(value: number | undefined, path: string, issues: ValidationIssue[], code: ReachEnvelopeIssueCode, minimum?: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    issues.push(makeIssue("error", code, path, "Numeric field must be finite and inside the allowed range.", "Use a validated finite estimate."));
  }
}

function validateUnitInterval(value: number, path: string, issues: ValidationIssue[], code: ReachEnvelopeIssueCode): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", code, path, "Confidence or risk value must be in [0, 1].", "Clamp or recompute the sensor-derived probability."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new ReachEnvelopeServiceError("Invalid reach envelope reference.", issues);
  }
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: ReachEnvelopeIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-safe reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference appears to contain forbidden simulator or QA detail.", "Use an opaque body-safe reference."));
  }
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new ReachEnvelopeServiceError("Cognitive reach summary contains forbidden body detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.prompt_safe_summary", "Summary contains forbidden simulator or hidden body detail.", "Sanitize exact internals before exposing reach summaries."),
    ]);
  }
}

function vectorNorm(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function maxOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values.filter((value) => Number.isFinite(value)));
}

function makeIssue(severity: ValidationSeverity, code: ReachEnvelopeIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const REACH_ENVELOPE_SERVICE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: REACH_ENVELOPE_SERVICE_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.11", "5.12", "5.14", "5.15", "5.16", "5.19", "5.20"]),
});
