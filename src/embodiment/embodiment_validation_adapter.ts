/**
 * Embodiment validation adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.11, 5.12, 5.15, 5.16, 5.17, 5.18, 5.19, and 5.20.
 *
 * This module converts cognitive plan targets into deterministic body
 * feasibility reports. It coordinates reach, stability, manipulation, contact,
 * actuator, and sensor-coverage services so a Gemini Robotics-ER 1.6 proposal
 * remains a proposal until declared embodiment constraints admit it.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { ActuatorLimitCatalog } from "./actuator_limit_catalog";
import type { ActuatorCommandInput, ActuatorCommandLimitReport } from "./actuator_limit_catalog";
import { ContactSiteRegistry } from "./contact_site_registry";
import type { ContactEvidenceReport, ContactEvidenceSample } from "./contact_site_registry";
import {
  createEmbodimentModelRegistry,
  EmbodimentModelRegistry,
} from "./embodiment_model_registry";
import type {
  ContactSiteDescriptor,
  EmbodimentDescriptor,
  EndEffectorRole,
  LocomotionPrimitive,
  ManipulationPrimitive,
  PrecisionRating,
  StabilityState,
  ToolState,
} from "./embodiment_model_registry";
import { ManipulationCapabilityCatalog } from "./manipulation_capability_catalog";
import type { ManipulationPrimitiveFeasibilityReport } from "./manipulation_capability_catalog";
import { ReachEnvelopeService } from "./reach_envelope_service";
import type { ReachDecision, ReachTargetEstimate, ToolReachState } from "./reach_envelope_service";
import { SensorMountRegistry } from "./sensor_mount_registry";
import type { SensorCoverageReport, SensorMountRole } from "./sensor_mount_registry";
import { StabilityPolicyService } from "./stability_policy_service";
import type {
  CarriedLoadEstimate,
  PlannedMotionContext,
  StanceState,
  StabilityDecision,
  StabilityPlannedMotion,
  SupportContactEvidence,
} from "./stability_policy_service";

export const EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION = "mebsuta.embodiment_validation_adapter.v1" as const;

const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|solver|object_id|hidden)/i;
const EPSILON = 1e-9;

export type EmbodimentPlanAdmission = "admit" | "admit_with_constraints" | "reobserve" | "reposition" | "validate_tool" | "safe_hold" | "reject";
export type EmbodimentValidationRisk = "low" | "medium" | "high" | "blocked";
export type ToolAttachmentAdmission = "accepted" | "needs_regrasp" | "unstable" | "expired" | "rejected";
export type ObstacleDensityClass = "clear" | "sparse" | "cluttered" | "blocked" | "unknown";
export type SensorHealthClass = "nominal" | "degraded" | "missing" | "unknown";

export type EmbodimentValidationIssueCode =
  | "ActiveEmbodimentMissing"
  | "CognitivePlanInvalid"
  | "TargetEstimateMissing"
  | "SensorCoverageInsufficient"
  | "ReachValidationRejected"
  | "StabilityValidationRejected"
  | "ManipulationValidationRejected"
  | "ContactValidationRejected"
  | "ActuatorValidationRejected"
  | "NoSafeReposition"
  | "ObstacleAmbiguous"
  | "EmbodimentPrimitiveUnavailable"
  | "ToolNotGrounded"
  | "GripUnstable"
  | "ToolTooHeavy"
  | "SweepUnsafe"
  | "AttachmentExpired"
  | "ForbiddenBodyDetail";

export interface EmbodimentValidationAdapterConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface EmbodimentCognitivePlanTarget {
  readonly plan_ref: Ref;
  readonly task_phase_ref?: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly manipulation_primitive: ManipulationPrimitive;
  readonly target_estimate?: ReachTargetEstimate;
  readonly required_precision?: PrecisionRating;
  readonly required_precision_radius_m?: number;
  readonly object_size_class?: "small" | "medium" | "large" | "unknown";
  readonly object_fragility?: "fragile" | "normal" | "sturdy" | "unknown";
  readonly expected_payload_kg?: number;
}

export interface EmbodimentValidationInput {
  readonly active_embodiment_ref?: Ref;
  readonly cognitive_target: EmbodimentCognitivePlanTarget;
  readonly stance_state?: StanceState;
  readonly support_contact_state?: readonly SupportContactEvidence[];
  readonly carried_load_estimate?: CarriedLoadEstimate;
  readonly planned_motion?: StabilityPlannedMotion | PlannedMotionContext;
  readonly base_tilt_roll_pitch_rad?: readonly [number, number];
  readonly center_of_mass_estimate_m?: Vector3;
  readonly tool_state?: ToolReachState;
  readonly contact_evidence_samples?: readonly ContactEvidenceSample[];
  readonly actuator_commands?: readonly ActuatorCommandInput[];
  readonly required_sensor_roles?: readonly SensorMountRole[];
  readonly tool_attachment_validated?: boolean;
  readonly verification_view_available?: boolean;
  readonly obstacle_summary?: ObstacleSummary;
  readonly sensor_health?: SensorHealthClass;
}

export interface ObstacleSummary {
  readonly density: ObstacleDensityClass;
  readonly frontal_clearance_m?: number;
  readonly lateral_clearance_m?: number;
  readonly floor_confidence?: number;
  readonly obstacle_evidence_ref?: Ref;
}

export interface RepositionPrimitiveRecommendation {
  readonly schema_version: typeof EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly primitive: LocomotionPrimitive | "re_observe" | "human_review";
  readonly reason: string;
  readonly expected_reach_improvement_class: "none" | "small" | "medium" | "large" | "unknown";
  readonly required_sensor_followup: readonly SensorMountRole[];
  readonly safe_under_current_evidence: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ToolCandidateEstimate {
  readonly tool_candidate_ref: Ref;
  readonly estimated_length_m: number;
  readonly estimated_mass_kg: number;
  readonly confidence: number;
  readonly visual_grounded: boolean;
  readonly sweep_clearance_m?: number;
  readonly handle_width_m?: number;
}

export interface GraspOrContactState {
  readonly end_effector_role: EndEffectorRole;
  readonly contact_confidence: number;
  readonly grip_stable: boolean;
  readonly slip_risk: number;
  readonly contact_report?: ContactEvidenceReport;
}

export interface ToolAttachmentPolicy {
  readonly maximum_tool_mass_fraction_of_body_limit?: number;
  readonly minimum_confidence?: number;
  readonly minimum_contact_confidence?: number;
  readonly maximum_slip_risk?: number;
  readonly minimum_sweep_clearance_m?: number;
  readonly expires_after_release?: boolean;
}

export interface ToolAttachmentDecision {
  readonly schema_version: typeof EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly tool_candidate_ref: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly admission: ToolAttachmentAdmission;
  readonly temporary_tool_frame_ref?: Ref;
  readonly effective_tool_length_m: number;
  readonly mass_fraction_of_limit: number;
  readonly grip_confidence: number;
  readonly sweep_clearance_m: number;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface EmbodimentFeasibilityReport {
  readonly schema_version: typeof EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION;
  readonly plan_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_role: EndEffectorRole;
  readonly manipulation_primitive: ManipulationPrimitive;
  readonly admission: EmbodimentPlanAdmission;
  readonly risk_class: EmbodimentValidationRisk;
  readonly sensor_coverage: SensorCoverageReport;
  readonly contact_evidence?: ContactEvidenceReport;
  readonly stability_decision: StabilityDecision;
  readonly reach_decision: ReachDecision;
  readonly manipulation_feasibility: ManipulationPrimitiveFeasibilityReport;
  readonly actuator_reports: readonly ActuatorCommandLimitReport[];
  readonly reposition_recommendation?: RepositionPrimitiveRecommendation;
  readonly required_followup: readonly ("reobserve" | "reposition" | "validate_tool" | "stabilize" | "reduce_force" | "alternate_view" | "human_review")[];
  readonly validator_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export class EmbodimentValidationAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "EmbodimentValidationAdapterError";
    this.issues = issues;
  }
}

/**
 * Coordinates embodiment validators for a single cognitive plan target.
 */
export class EmbodimentValidationAdapter {
  private readonly registry: EmbodimentModelRegistry;
  private readonly reachService: ReachEnvelopeService;
  private readonly stabilityService: StabilityPolicyService;
  private readonly manipulationCatalog: ManipulationCapabilityCatalog;
  private readonly contactRegistry: ContactSiteRegistry;
  private readonly sensorRegistry: SensorMountRegistry;
  private readonly actuatorCatalog: ActuatorLimitCatalog;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: EmbodimentValidationAdapterConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    if (config.embodiment !== undefined) {
      this.registry.registerEmbodimentModel(config.embodiment);
    }
    this.activeEmbodimentRef = config.active_embodiment_ref ?? config.embodiment?.embodiment_id;
    this.reachService = new ReachEnvelopeService({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    this.stabilityService = new StabilityPolicyService({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    this.manipulationCatalog = new ManipulationCapabilityCatalog({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    this.contactRegistry = new ContactSiteRegistry({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    this.sensorRegistry = new SensorMountRegistry({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    this.actuatorCatalog = new ActuatorLimitCatalog({ registry: this.registry, active_embodiment_ref: this.activeEmbodimentRef });
    if (this.activeEmbodimentRef !== undefined) {
      this.selectActiveEmbodiment(this.activeEmbodimentRef);
    }
  }

  /**
   * Selects the active body model across every delegated validation service.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.reachService.selectActiveEmbodiment(activeEmbodimentRef);
    this.stabilityService.selectActiveEmbodiment(activeEmbodimentRef);
    this.manipulationCatalog.selectActiveEmbodiment(activeEmbodimentRef);
    this.contactRegistry.selectActiveEmbodiment(activeEmbodimentRef);
    this.sensorRegistry.selectActiveEmbodiment(activeEmbodimentRef);
    this.actuatorCatalog.selectActiveEmbodiment(activeEmbodimentRef);
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Converts one cognitive target into a full body feasibility report. The
   * report is suitable for downstream plan validation and never exposes
   * simulator world truth.
   */
  public evaluateCognitivePlanTarget(input: EmbodimentValidationInput): EmbodimentFeasibilityReport {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    validatePlanTarget(input.cognitive_target);
    const issues: ValidationIssue[] = [];
    validateSafeRef(input.cognitive_target.plan_ref, "$.cognitive_target.plan_ref", issues, "CognitivePlanInvalid");
    validateSafeRef(input.cognitive_target.task_phase_ref, "$.cognitive_target.task_phase_ref", issues, "CognitivePlanInvalid");

    const requiredSensorRoles = input.required_sensor_roles ?? requiredSensorsFor(input.cognitive_target.manipulation_primitive);
    const sensorCoverage = this.sensorRegistry.evaluateSensorCoverage({
      active_embodiment_ref: model.embodiment_id,
      required_roles: requiredSensorRoles,
      require_cognitive_visible: false,
      require_hardware_declared: false,
    });
    issues.push(...prefixIssues(sensorCoverage.issues, "$.sensor_coverage"));

    const contactEvidence = input.contact_evidence_samples === undefined
      ? undefined
      : this.contactRegistry.evaluateContactEvidence({
        active_embodiment_ref: model.embodiment_id,
        samples: input.contact_evidence_samples,
        consumer: input.cognitive_target.manipulation_primitive === "tool_use" ? "tool_use" : "manipulation",
        require_support_contacts: false,
      });
    if (contactEvidence !== undefined) {
      issues.push(...prefixIssues(contactEvidence.issues, "$.contact_evidence"));
    }

    const stanceState = input.stance_state ?? defaultStanceState(model, input.sensor_health);
    const supportContacts = input.support_contact_state ?? defaultSupportContacts(model, stanceState, input.sensor_health, issues);
    const plannedMotion = input.planned_motion ?? plannedMotionFor(input.cognitive_target.manipulation_primitive);
    const stabilityDecision = this.stabilityService.evaluateEmbodimentStability({
      active_embodiment_ref: model.embodiment_id,
      stance_state: stanceState,
      contact_state: supportContacts,
      carried_load_estimate: input.carried_load_estimate,
      planned_motion: plannedMotion,
      base_tilt_roll_pitch_rad: input.base_tilt_roll_pitch_rad,
      center_of_mass_estimate_m: input.center_of_mass_estimate_m,
    });
    issues.push(...prefixIssues(stabilityDecision.issues, "$.stability_decision"));

    const reachDecision = this.reachService.evaluateReachEnvelope({
      active_embodiment_ref: model.embodiment_id,
      end_effector_role: input.cognitive_target.end_effector_role,
      target_estimate: input.cognitive_target.target_estimate,
      stance_state: stanceState,
      stability_decision: stabilityDecision,
      tool_state: input.tool_state,
      required_precision_radius_m: input.cognitive_target.required_precision_radius_m,
      required_primitive: input.cognitive_target.manipulation_primitive,
    });
    issues.push(...prefixIssues(reachDecision.issues, "$.reach_decision"));

    const actuatorReports = freezeArray((input.actuator_commands ?? []).map((command) => this.actuatorCatalog.evaluateActuatorCommand({
      ...command,
      embodiment_ref: command.embodiment_ref ?? model.embodiment_id,
    })));
    issues.push(...actuatorReports.flatMap((report, index) => prefixIssues(report.issues, `$.actuator_reports[${index}]`)));

    const manipulationFeasibility = this.manipulationCatalog.evaluatePrimitiveFeasibility({
      active_embodiment_ref: model.embodiment_id,
      end_effector_role: input.cognitive_target.end_effector_role,
      primitive: input.cognitive_target.manipulation_primitive,
      consumer: input.cognitive_target.manipulation_primitive === "tool_use" ? "tool_use" : "plan_validator",
      required_precision: input.cognitive_target.required_precision,
      object_size_class: input.cognitive_target.object_size_class,
      object_fragility: input.cognitive_target.object_fragility,
      expected_payload_kg: input.cognitive_target.expected_payload_kg,
      reach_decision: reachDecision,
      stability_decision: stabilityDecision,
      contact_evidence: contactEvidence,
      actuator_report: worstActuatorReport(actuatorReports),
      tool_attachment_validated: input.tool_attachment_validated ?? (input.tool_state?.tool_state === "attached"),
      verification_view_available: input.verification_view_available ?? (sensorCoverage.satisfied_roles.includes("camera") || sensorCoverage.satisfied_roles.includes("depth_camera")),
    });
    issues.push(...prefixIssues(manipulationFeasibility.issues, "$.manipulation_feasibility"));

    const repositionRecommendation = needsReposition(reachDecision, stabilityDecision, manipulationFeasibility)
      ? this.selectEmbodimentRepositionPrimitive(model.embodiment_id, reachDecision, input.obstacle_summary, input.sensor_health)
      : undefined;
    if (repositionRecommendation !== undefined) {
      issues.push(...prefixIssues(repositionRecommendation.issues, "$.reposition_recommendation"));
    }

    addAdapterIssues(sensorCoverage, reachDecision, stabilityDecision, manipulationFeasibility, contactEvidence, actuatorReports, issues);
    const admission = chooseAdmission(sensorCoverage, reachDecision, stabilityDecision, manipulationFeasibility, actuatorReports, repositionRecommendation, issues);
    const risk = classifyValidationRisk(admission, reachDecision, stabilityDecision, manipulationFeasibility, actuatorReports, issues);
    const followup = mergeFollowups(admission, manipulationFeasibility.required_followup, repositionRecommendation);
    const summary = sanitizeSummary(buildValidatorSummary(model, input, admission, risk, reachDecision, stabilityDecision, manipulationFeasibility, repositionRecommendation));
    assertNoForbiddenLeak(summary);
    const base = {
      schema_version: EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION,
      plan_ref: input.cognitive_target.plan_ref,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      end_effector_role: input.cognitive_target.end_effector_role,
      manipulation_primitive: input.cognitive_target.manipulation_primitive,
      admission,
      risk_class: risk,
      sensor_coverage: sensorCoverage,
      contact_evidence: contactEvidence,
      stability_decision: stabilityDecision,
      reach_decision: reachDecision,
      manipulation_feasibility: manipulationFeasibility,
      actuator_reports: actuatorReports,
      reposition_recommendation: repositionRecommendation,
      required_followup: followup,
      validator_summary: summary,
      issues: freezeArray(issues),
      ok: admission === "admit" || admission === "admit_with_constraints",
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Selects a body-valid reposition primitive after a reach or stability
   * failure, using obstacle and sensor health evidence.
   */
  public selectEmbodimentRepositionPrimitive(
    activeEmbodimentRef: Ref,
    reachDecision: ReachDecision,
    obstacleSummary: ObstacleSummary | undefined,
    sensorHealth: SensorHealthClass = "unknown",
  ): RepositionPrimitiveRecommendation {
    const model = this.requireEmbodiment(activeEmbodimentRef);
    const issues: ValidationIssue[] = [];
    const supported = new Set(model.locomotion_capability.supported_primitives);
    const candidates = scoreRepositionCandidates(model, reachDecision, obstacleSummary, sensorHealth, supported, issues);
    const best = [...candidates].sort((a, b) => b.score - a.score || a.primitive.localeCompare(b.primitive))[0];
    if (best === undefined || best.score <= 0) {
      issues.push(makeIssue("error", "NoSafeReposition", "$.reposition", "No supported reposition primitive is safe under current evidence.", "Re-observe, validate a tool, or request human review."));
    }
    const primitive: RepositionPrimitiveRecommendation["primitive"] = best === undefined
      ? (sensorHealth === "missing" ? "human_review" : "re_observe")
      : best.primitive;
    const followup = primitive === "re_observe" || sensorHealth !== "nominal" ? requiredSensorsFor("inspect") : freezeArray([]);
    const reason = sanitizeSummary(best?.reason ?? "Reposition requires better sensor evidence before motion.");
    assertNoForbiddenLeak(reason);
    const base = {
      schema_version: EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      primitive,
      reason,
      expected_reach_improvement_class: best?.improvement ?? "unknown" as const,
      required_sensor_followup: followup,
      safe_under_current_evidence: issues.every((issue) => issue.severity !== "error") && primitive !== "human_review",
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates a task-scoped tool frame attachment. The decision is grounded in
   * visual confidence, grip/contact evidence, tool mass, slip risk, and sweep
   * clearance before any tool reach can be used by the reach service.
   */
  public attachToolFrameToEmbodiment(
    activeEmbodimentRef: Ref,
    toolCandidateEstimate: ToolCandidateEstimate,
    graspOrContactState: GraspOrContactState,
    attachmentPolicy: ToolAttachmentPolicy = {},
  ): ToolAttachmentDecision {
    const model = this.requireEmbodiment(activeEmbodimentRef);
    const issues: ValidationIssue[] = [];
    validateSafeRef(toolCandidateEstimate.tool_candidate_ref, "$.tool_candidate_estimate.tool_candidate_ref", issues, "ToolNotGrounded");
    validateUnitInterval(toolCandidateEstimate.confidence, "$.tool_candidate_estimate.confidence", issues, "ToolNotGrounded");
    validateUnitInterval(graspOrContactState.contact_confidence, "$.grasp_or_contact_state.contact_confidence", issues, "GripUnstable");
    validateUnitInterval(graspOrContactState.slip_risk, "$.grasp_or_contact_state.slip_risk", issues, "GripUnstable");
    validatePositive(toolCandidateEstimate.estimated_length_m, "$.tool_candidate_estimate.estimated_length_m", issues, "ToolNotGrounded");
    validatePositive(toolCandidateEstimate.estimated_mass_kg, "$.tool_candidate_estimate.estimated_mass_kg", issues, "ToolTooHeavy");

    const effector = model.end_effectors.find((candidate) => candidate.role === graspOrContactState.end_effector_role);
    if (effector === undefined || !effector.supported_primitives.includes("tool_use")) {
      issues.push(makeIssue("error", "EmbodimentPrimitiveUnavailable", "$.grasp_or_contact_state.end_effector_role", "Requested end effector cannot use tools.", "Choose a tool-capable mouth, paw, hand, wrist, or tool-tip effector."));
    }
    const massLimit = model.stability_policy.max_carried_load_kg * (attachmentPolicy.maximum_tool_mass_fraction_of_body_limit ?? 0.35);
    const massFraction = massLimit <= EPSILON ? 1 : toolCandidateEstimate.estimated_mass_kg / massLimit;
    if (toolCandidateEstimate.estimated_mass_kg > massLimit) {
      issues.push(makeIssue("error", "ToolTooHeavy", "$.tool_candidate_estimate.estimated_mass_kg", "Tool mass exceeds the task-scoped attachment limit.", "Use a lighter tool or ask for help."));
    }
    if (!toolCandidateEstimate.visual_grounded || toolCandidateEstimate.confidence < (attachmentPolicy.minimum_confidence ?? 0.45)) {
      issues.push(makeIssue("warning", "ToolNotGrounded", "$.tool_candidate_estimate.confidence", "Tool candidate is not sufficiently grounded by visual or memory evidence.", "Re-observe the tool before attachment."));
    }
    if (!graspOrContactState.grip_stable || graspOrContactState.contact_confidence < (attachmentPolicy.minimum_contact_confidence ?? 0.55)) {
      issues.push(makeIssue("warning", "GripUnstable", "$.grasp_or_contact_state", "Grip/contact evidence is not stable enough for tool attachment.", "Regrasp or acquire tactile confirmation."));
    }
    if (graspOrContactState.slip_risk > (attachmentPolicy.maximum_slip_risk ?? model.safety_margin_policy.tool_slip_maximum)) {
      issues.push(makeIssue("warning", "GripUnstable", "$.grasp_or_contact_state.slip_risk", "Tool slip risk exceeds policy.", "Regrasp, slow down, or reject tool use."));
    }
    const sweepClearance = toolCandidateEstimate.sweep_clearance_m ?? 0;
    if (sweepClearance < (attachmentPolicy.minimum_sweep_clearance_m ?? model.safety_margin_policy.reach_uncertainty_m * 2)) {
      issues.push(makeIssue("warning", "SweepUnsafe", "$.tool_candidate_estimate.sweep_clearance_m", "Tool sweep clearance is below the conservative safety margin.", "Reposition or use a smaller tool."));
    }
    if (attachmentPolicy.expires_after_release === false) {
      issues.push(makeIssue("error", "AttachmentExpired", "$.attachment_policy.expires_after_release", "Tool frames must expire after release or task completion.", "Set task-scoped expiration for the tool frame."));
    }

    const admission = chooseToolAdmission(issues, graspOrContactState);
    const frameRef = admission === "accepted" ? `U_tool_${safeRefFragment(toolCandidateEstimate.tool_candidate_ref)}` : undefined;
    const summary = sanitizeSummary(`${model.embodiment_kind} ${graspOrContactState.end_effector_role} tool attachment is ${admission}; tool length class ${reachLengthClass(toolCandidateEstimate.estimated_length_m)}, mass fraction ${round3(massFraction)}, slip risk ${round3(graspOrContactState.slip_risk)}.`);
    assertNoForbiddenLeak(summary);
    const base = {
      schema_version: EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      tool_candidate_ref: toolCandidateEstimate.tool_candidate_ref,
      end_effector_role: graspOrContactState.end_effector_role,
      admission,
      temporary_tool_frame_ref: frameRef,
      effective_tool_length_m: round6(Math.max(0, toolCandidateEstimate.estimated_length_m)),
      mass_fraction_of_limit: round6(massFraction),
      grip_confidence: round6(graspOrContactState.contact_confidence),
      sweep_clearance_m: round6(sweepClearance),
      prompt_safe_summary: summary,
      issues: freezeArray(issues),
      ok: admission === "accepted",
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
      throw new EmbodimentValidationAdapterError("No active embodiment is registered for validation.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before validation."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createEmbodimentValidationAdapter(config: EmbodimentValidationAdapterConfig = {}): EmbodimentValidationAdapter {
  return new EmbodimentValidationAdapter(config);
}

function validatePlanTarget(target: EmbodimentCognitivePlanTarget): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(target.plan_ref, "$.cognitive_target.plan_ref", issues, "CognitivePlanInvalid");
  validateSafeRef(target.task_phase_ref, "$.cognitive_target.task_phase_ref", issues, "CognitivePlanInvalid");
  validatePositiveOptional(target.required_precision_radius_m, "$.cognitive_target.required_precision_radius_m", issues, "CognitivePlanInvalid");
  validatePositiveOptional(target.expected_payload_kg, "$.cognitive_target.expected_payload_kg", issues, "CognitivePlanInvalid");
  if (FORBIDDEN_DETAIL_PATTERN.test(target.plan_ref) || (target.task_phase_ref !== undefined && FORBIDDEN_DETAIL_PATTERN.test(target.task_phase_ref))) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.cognitive_target", "Plan target contains forbidden simulator or QA detail.", "Use cognitive-safe plan references."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new EmbodimentValidationAdapterError("Cognitive plan target is invalid.", issues);
  }
}

function defaultStanceState(model: EmbodimentDescriptor, sensorHealth: SensorHealthClass | undefined): StanceState {
  return Object.freeze({
    stance_ref: model.stability_policy.default_stance_ref,
    posture_class: model.embodiment_kind === "quadruped" ? "neutral" : "wide",
    expected_support_contact_refs: freezeArray(model.stability_policy.nominal_support_contact_refs),
    gait_phase: model.embodiment_kind === "quadruped" ? "quad_support" : "double_support",
    confidence: sensorHealth === "nominal" ? 0.82 : sensorHealth === "degraded" ? 0.62 : 0.52,
  });
}

function defaultSupportContacts(
  model: EmbodimentDescriptor,
  stance: StanceState,
  sensorHealth: SensorHealthClass | undefined,
  issues: ValidationIssue[],
): readonly SupportContactEvidence[] {
  const expected = stance.expected_support_contact_refs ?? model.stability_policy.nominal_support_contact_refs;
  const confidence = sensorHealth === "nominal" ? 0.82 : sensorHealth === "degraded" ? 0.62 : 0.52;
  return freezeArray(expected.map((contactRef) => {
    const site = model.contact_sites.find((candidate) => candidate.contact_site_ref === contactRef);
    if (site === undefined) {
      issues.push(makeIssue("warning", "ContactValidationRejected", "$.stance_state.expected_support_contact_refs", `Expected support contact ${contactRef} is not declared.`, "Use declared support contacts."));
    }
    return Object.freeze({
      contact_ref: contactRef,
      contact_role: site?.contact_role,
      position_in_base_frame_m: framePositionInBase(model, site?.frame_ref ?? contactRef, issues),
      confidence,
      normal_force_n: site === undefined ? undefined : Math.max(0, site.max_contact_force_n * 0.35),
      slip_risk: sensorHealth === "nominal" ? 0.08 : 0.22,
      is_support_contact: true,
    });
  }));
}

function framePositionInBase(model: EmbodimentDescriptor, frameRef: Ref, issues: ValidationIssue[]): Vector3 {
  const frames = new Map(model.frame_graph.map((frame) => [frame.frame_id, frame] as const));
  let cursor = frames.get(frameRef);
  const visited = new Set<Ref>();
  let x = 0;
  let y = 0;
  let z = 0;
  if (cursor === undefined) {
    issues.push(makeIssue("warning", "ContactValidationRejected", "$.frame_graph", `Frame ${frameRef} is not declared; using base origin for conservative validation.`, "Attach support contacts to declared body frames."));
    return freezeVector3([0, 0, 0]);
  }
  while (cursor !== undefined) {
    if (visited.has(cursor.frame_id)) {
      issues.push(makeIssue("warning", "ContactValidationRejected", "$.frame_graph", "Frame graph cycle detected while estimating support contact position.", "Repair frame graph before stability validation."));
      break;
    }
    visited.add(cursor.frame_id);
    const position = cursor.transform_from_parent?.position_m;
    if (position !== undefined) {
      x += position[0];
      y += position[1];
      z += position[2];
    }
    if (cursor.parent_frame_ref === undefined || cursor.frame_id === "B") {
      break;
    }
    cursor = frames.get(cursor.parent_frame_ref);
  }
  return freezeVector3([x, y, z]);
}

function plannedMotionFor(primitive: ManipulationPrimitive): StabilityPlannedMotion | PlannedMotionContext {
  if (primitive === "inspect") {
    return "observe";
  }
  if (primitive === "approach" || primitive === "retreat") {
    return "reach";
  }
  if (primitive === "lift") {
    return "lift";
  }
  if (primitive === "carry") {
    return "carry";
  }
  if (primitive === "place" || primitive === "release") {
    return "place";
  }
  if (primitive === "tool_use") {
    return Object.freeze({ motion: "tool_use", manipulation_primitive: primitive, requires_body_lean: true, tool_velocity_m_per_s: 0.25 });
  }
  return Object.freeze({ motion: "reach", manipulation_primitive: primitive });
}

function requiredSensorsFor(primitive: ManipulationPrimitive): readonly SensorMountRole[] {
  if (primitive === "inspect") {
    return freezeArray(["camera", "imu"]);
  }
  if (primitive === "tool_use") {
    return freezeArray(["camera", "contact_sensor", "imu"]);
  }
  if (primitive === "grasp" || primitive === "lift" || primitive === "carry" || primitive === "place") {
    return freezeArray(["camera", "contact_sensor", "imu"]);
  }
  return freezeArray(["camera", "imu"]);
}

function needsReposition(reach: ReachDecision, stability: StabilityDecision, manipulation: ManipulationPrimitiveFeasibilityReport): boolean {
  return reach.reposition_required
    || reach.decision === "ReachableAfterReposition"
    || stability.recommended_action === "reposition"
    || manipulation.admission === "reposition";
}

function scoreRepositionCandidates(
  model: EmbodimentDescriptor,
  reach: ReachDecision,
  obstacle: ObstacleSummary | undefined,
  sensorHealth: SensorHealthClass,
  supported: Set<LocomotionPrimitive>,
  issues: ValidationIssue[],
): readonly { readonly primitive: LocomotionPrimitive | "re_observe"; readonly score: number; readonly reason: string; readonly improvement: RepositionPrimitiveRecommendation["expected_reach_improvement_class"] }[] {
  const density = obstacle?.density ?? "unknown";
  validateSafeRef(obstacle?.obstacle_evidence_ref, "$.obstacle_summary.obstacle_evidence_ref", issues, "ObstacleAmbiguous");
  validatePositiveOptional(obstacle?.frontal_clearance_m, "$.obstacle_summary.frontal_clearance_m", issues, "ObstacleAmbiguous");
  validatePositiveOptional(obstacle?.lateral_clearance_m, "$.obstacle_summary.lateral_clearance_m", issues, "ObstacleAmbiguous");
  if (sensorHealth === "missing" || density === "unknown") {
    issues.push(makeIssue("warning", "ObstacleAmbiguous", "$.obstacle_summary", "Obstacle or sensor evidence is ambiguous for repositioning.", "Re-observe before moving the body."));
  }
  const frontal = obstacle?.frontal_clearance_m ?? 0;
  const lateral = obstacle?.lateral_clearance_m ?? 0;
  const canStep = supported.has("step_forward") && density !== "blocked" && frontal >= 0.25;
  const canSide = supported.has("sidestep") && density !== "blocked" && lateral >= 0.18;
  const canCrouch = supported.has("crouch");
  const canWide = supported.has("wide_stance");
  const canTurn = supported.has("turn_in_place");
  const basePenalty = sensorHealth === "nominal" ? 0 : sensorHealth === "degraded" ? 1 : 3;
  const rows = [
    { primitive: "step_forward" as const, score: (canStep ? 8 : 0) - basePenalty, reason: "Step forward improves base reach toward the target while preserving body-relative sensing.", improvement: "large" as const },
    { primitive: "sidestep" as const, score: (canSide ? 7 : 0) - basePenalty, reason: "Sidestep improves approach angle when frontal reach is constrained.", improvement: "medium" as const },
    { primitive: "crouch" as const, score: (canCrouch && reach.decision === "ReachableWithPostureChange" ? 6 : canCrouch ? 3 : 0) - basePenalty, reason: "Crouch lowers the body and can improve stability for near reach.", improvement: "small" as const },
    { primitive: "wide_stance" as const, score: (canWide && model.embodiment_kind === "humanoid" ? 6 : canWide ? 2 : 0) - basePenalty, reason: "Wide stance increases balance margin before arm reach or load handling.", improvement: "small" as const },
    { primitive: "turn_in_place" as const, score: (canTurn && density !== "blocked" ? 4 : 0) - basePenalty, reason: "Turn in place may improve camera and end-effector alignment without forward motion.", improvement: "small" as const },
    { primitive: "re_observe" as const, score: sensorHealth === "nominal" && density !== "unknown" ? 1 : 5, reason: "Re-observe improves target, obstacle, and contact confidence before motion.", improvement: "unknown" as const },
  ];
  return freezeArray(rows.filter((row) => row.primitive === "re_observe" || supported.has(row.primitive)));
}

function addAdapterIssues(
  sensorCoverage: SensorCoverageReport,
  reachDecision: ReachDecision,
  stabilityDecision: StabilityDecision,
  manipulationFeasibility: ManipulationPrimitiveFeasibilityReport,
  contactEvidence: ContactEvidenceReport | undefined,
  actuatorReports: readonly ActuatorCommandLimitReport[],
  issues: ValidationIssue[],
): void {
  if (!sensorCoverage.ok) {
    issues.push(makeIssue("error", "SensorCoverageInsufficient", "$.sensor_coverage", "Required body sensors are not available for this validation.", "Reconfigure required sensors or re-observe with available hardware."));
  }
  if (!reachDecision.ok && reachDecision.validator_admission === "reject") {
    issues.push(makeIssue("error", "ReachValidationRejected", "$.reach_decision", "Reach validation rejected the target.", "Reposition, validate a tool, or choose another target."));
  }
  if (!stabilityDecision.ok && stabilityDecision.validator_admission === "safe_hold") {
    issues.push(makeIssue("error", "StabilityValidationRejected", "$.stability_decision", "Stability validation requires safe-hold.", "Stabilize the body before motion."));
  } else if (!stabilityDecision.ok) {
    issues.push(makeIssue("warning", "StabilityValidationRejected", "$.stability_decision", "Stability validation did not fully admit the motion.", "Apply speed, posture, or support constraints."));
  }
  if (!manipulationFeasibility.ok) {
    issues.push(makeIssue(manipulationFeasibility.admission === "reject" ? "error" : "warning", "ManipulationValidationRejected", "$.manipulation_feasibility", "Manipulation capability validation did not fully admit the primitive.", "Follow manipulation feasibility remediation."));
  }
  if (contactEvidence !== undefined && !contactEvidence.ok) {
    issues.push(makeIssue("error", "ContactValidationRejected", "$.contact_evidence", "Contact evidence contains blocking tactile issues.", "Resolve contact or slip evidence before manipulation."));
  }
  if (actuatorReports.some((report) => !report.ok)) {
    issues.push(makeIssue("error", "ActuatorValidationRejected", "$.actuator_reports", "At least one actuator command was rejected or safe-held.", "Reduce command values or re-plan the primitive."));
  } else if (actuatorReports.some((report) => report.decision === "clipped")) {
    issues.push(makeIssue("warning", "ActuatorValidationRejected", "$.actuator_reports", "At least one actuator command required clipping.", "Use clipped limits and reduce trajectory speed."));
  }
}

function chooseAdmission(
  sensorCoverage: SensorCoverageReport,
  reachDecision: ReachDecision,
  stabilityDecision: StabilityDecision,
  manipulationFeasibility: ManipulationPrimitiveFeasibilityReport,
  actuatorReports: readonly ActuatorCommandLimitReport[],
  reposition: RepositionPrimitiveRecommendation | undefined,
  issues: readonly ValidationIssue[],
): EmbodimentPlanAdmission {
  if (stabilityDecision.validator_admission === "safe_hold" || manipulationFeasibility.admission === "safe_hold") {
    return "safe_hold";
  }
  if (issues.some((issue) => issue.severity === "error") || actuatorReports.some((report) => report.decision === "rejected" || report.decision === "safe_hold")) {
    if (reachDecision.decision === "UnknownDueToPerception" || !sensorCoverage.ok) {
      return "reobserve";
    }
    return "reject";
  }
  if (reachDecision.decision === "UnknownDueToPerception" || manipulationFeasibility.admission === "reobserve") {
    return "reobserve";
  }
  if (reposition !== undefined && reposition.safe_under_current_evidence) {
    return "reposition";
  }
  if (reachDecision.tool_validation_required || manipulationFeasibility.admission === "tool_validation_required") {
    return "validate_tool";
  }
  if (issues.length > 0 || stabilityDecision.validator_admission === "admit_with_speed_limit" || manipulationFeasibility.admission === "admit_with_constraints" || actuatorReports.some((report) => report.decision === "clipped")) {
    return "admit_with_constraints";
  }
  return "admit";
}

function classifyValidationRisk(
  admission: EmbodimentPlanAdmission,
  reachDecision: ReachDecision,
  stabilityDecision: StabilityDecision,
  manipulationFeasibility: ManipulationPrimitiveFeasibilityReport,
  actuatorReports: readonly ActuatorCommandLimitReport[],
  issues: readonly ValidationIssue[],
): EmbodimentValidationRisk {
  if (admission === "reject" || admission === "safe_hold" || issues.some((issue) => issue.severity === "error")) {
    return "blocked";
  }
  if (stabilityDecision.stability_state === "marginal" || manipulationFeasibility.risk_class === "high" || actuatorReports.some((report) => report.decision === "clipped")) {
    return "high";
  }
  if (admission !== "admit" || reachDecision.decision !== "ReachableNow" || manipulationFeasibility.risk_class === "medium") {
    return "medium";
  }
  return "low";
}

function mergeFollowups(
  admission: EmbodimentPlanAdmission,
  manipulationFollowups: ManipulationPrimitiveFeasibilityReport["required_followup"],
  reposition: RepositionPrimitiveRecommendation | undefined,
): EmbodimentFeasibilityReport["required_followup"] {
  const followups = new Set<EmbodimentFeasibilityReport["required_followup"][number]>(manipulationFollowups);
  if (admission === "reobserve") {
    followups.add("reobserve");
  }
  if (admission === "reposition" || reposition !== undefined) {
    followups.add("reposition");
  }
  if (admission === "validate_tool") {
    followups.add("validate_tool");
  }
  if (admission === "safe_hold") {
    followups.add("stabilize");
  }
  if (admission === "reject") {
    followups.add("human_review");
  }
  return freezeArray([...followups].sort());
}

function buildValidatorSummary(
  model: EmbodimentDescriptor,
  input: EmbodimentValidationInput,
  admission: EmbodimentPlanAdmission,
  risk: EmbodimentValidationRisk,
  reach: ReachDecision,
  stability: StabilityDecision,
  manipulation: ManipulationPrimitiveFeasibilityReport,
  reposition: RepositionPrimitiveRecommendation | undefined,
): string {
  const repositionText = reposition === undefined ? "no reposition recommendation" : `recommended ${reposition.primitive}`;
  return `${model.embodiment_kind} ${input.cognitive_target.end_effector_role} ${input.cognitive_target.manipulation_primitive} is ${admission} with ${risk} risk; reach ${reach.decision}, stability ${stability.stability_state}, manipulation ${manipulation.admission}, ${repositionText}.`;
}

function worstActuatorReport(reports: readonly ActuatorCommandLimitReport[]): ActuatorCommandLimitReport | undefined {
  const rank = new Map<ActuatorCommandLimitReport["decision"], number>([
    ["accepted", 0],
    ["clipped", 1],
    ["rejected", 2],
    ["safe_hold", 3],
  ]);
  return [...reports].sort((a, b) => (rank.get(b.decision) ?? 0) - (rank.get(a.decision) ?? 0))[0];
}

function chooseToolAdmission(issues: readonly ValidationIssue[], state: GraspOrContactState): ToolAttachmentAdmission {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "AttachmentExpired")) {
    return "expired";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (state.slip_risk > 0.65) {
    return "unstable";
  }
  if (issues.some((issue) => issue.code === "GripUnstable" || issue.code === "ToolNotGrounded")) {
    return "needs_regrasp";
  }
  if (issues.some((issue) => issue.code === "SweepUnsafe")) {
    return "unstable";
  }
  return "accepted";
}

function prefixIssues(issues: readonly ValidationIssue[], prefix: string): readonly ValidationIssue[] {
  return freezeArray(issues.map((issue) => Object.freeze({
    ...issue,
    path: `${prefix}${issue.path.startsWith("$") ? issue.path.slice(1) : `.${issue.path}`}`,
  })));
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: EmbodimentValidationIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque cognitive-safe reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference contains forbidden simulator or QA detail.", "Use a cognitive-safe body or plan reference."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new EmbodimentValidationAdapterError("Invalid embodiment validation reference.", issues);
  }
}

function validatePositive(value: number, path: string, issues: ValidationIssue[], code: EmbodimentValidationIssueCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", code, path, "Numeric value must be positive and finite.", "Use a sensor-derived positive estimate."));
  }
}

function validatePositiveOptional(value: number | undefined, path: string, issues: ValidationIssue[], code: EmbodimentValidationIssueCode): void {
  if (value !== undefined) {
    validatePositive(value, path, issues, code);
  }
}

function validateUnitInterval(value: number, path: string, issues: ValidationIssue[], code: EmbodimentValidationIssueCode): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", code, path, "Probability value must be in [0, 1].", "Clamp or recompute the sensor-derived probability."));
  }
}

function sanitizeSummary(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "internal-detail").replace(/\s+/g, " ").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new EmbodimentValidationAdapterError("Embodiment validation summary contains forbidden detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.validator_summary", "Summary contains forbidden simulator or QA detail.", "Sanitize exact internals before exposing validation summaries."),
    ]);
  }
}

function safeRefFragment(value: Ref): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "safe").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
}

function reachLengthClass(lengthM: number): string {
  if (lengthM < 0.25) {
    return "short";
  }
  if (lengthM < 0.75) {
    return "medium";
  }
  return "long";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function makeIssue(severity: ValidationSeverity, code: EmbodimentValidationIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export const EMBODIMENT_VALIDATION_ADAPTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EMBODIMENT_VALIDATION_ADAPTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.11", "5.12", "5.15", "5.16", "5.17", "5.18", "5.19", "5.20"]),
});
