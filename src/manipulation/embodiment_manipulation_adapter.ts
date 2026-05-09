/**
 * Embodiment manipulation adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12,
 * 12.13, and 12.17.
 *
 * This adapter binds File 12 primitive descriptors to concrete quadruped or
 * humanoid body interfaces. It evaluates catalog support, preferred effector
 * mappings, available sensor evidence, target-frame needs, reach, stability,
 * contact, actuator, verification, and tool constraints before selecting a
 * mouth, paw, forelimb, hand, dual-hand, wrist, or tool-tip execution binding.
 * The output is deterministic and simulation-blind: raw cognitive text,
 * hidden world truth, backend handles, and direct actuator commands are never
 * accepted as authority for manipulation.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  EmbodimentKind,
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  EndEffectorRole,
  ManipulationPrimitive,
} from "../embodiment/embodiment_model_registry";
import {
  createManipulationCapabilityCatalog,
  ManipulationCapabilityCatalog,
} from "../embodiment/manipulation_capability_catalog";
import type {
  ManipulationAdmission,
  ManipulationPrimitiveFeasibilityInput,
  ManipulationPrimitiveFeasibilityReport,
  ManipulationRiskClass,
  ResolvedManipulationCapability,
} from "../embodiment/manipulation_capability_catalog";
import {
  createManipulationPrimitiveCatalog,
  ManipulationPrimitiveCatalog,
} from "./manipulation_primitive_catalog";
import type {
  ManipulationContactExpectation,
  ManipulationFallbackAction,
  ManipulationPrimitiveDescriptor,
  ManipulationPrimitiveName,
  ManipulationSensorEvidence,
  PrimitiveExecutionIntent,
  PrimitiveExecutionIntentReport,
} from "./manipulation_primitive_catalog";

export const EMBODIMENT_MANIPULATION_ADAPTER_SCHEMA_VERSION = "mebsuta.embodiment_manipulation_adapter.v1" as const;

const HIDDEN_ADAPTER_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type EmbodimentManipulationAdapterDecision =
  | "bound"
  | "bound_with_constraints"
  | "reobserve"
  | "reposition"
  | "tool_validation_required"
  | "safe_hold"
  | "rejected";

export type EmbodimentManipulationAdapterAction =
  | "execute_primitive"
  | "collect_sensor_evidence"
  | "reposition_body"
  | "validate_tool"
  | "stabilize_first"
  | "safe_hold"
  | "repair_intent";

export type EmbodimentManipulationAdapterIssueCode =
  | "PrimitiveSelectionMissing"
  | "PrimitiveUnsupportedForEmbodiment"
  | "PrimitiveUnsupportedForEffector"
  | "ValidatedPlanMissing"
  | "ControlWorkOrderMissing"
  | "ValidationDecisionMissing"
  | "TargetFrameMissing"
  | "SubjectObjectMissing"
  | "ToolFrameMissing"
  | "SensorEvidenceMissing"
  | "CapabilityCatalogUnavailable"
  | "CapabilityFeasibilityRejected"
  | "NoBindableEffector"
  | "HiddenAdapterLeak";

export interface EmbodimentManipulationAdapterConfig {
  readonly primitive_catalog?: ManipulationPrimitiveCatalog;
  readonly capability_catalog?: ManipulationCapabilityCatalog;
}

/**
 * Runtime request to bind one validated manipulation primitive to a body
 * interface.
 */
export interface EmbodimentManipulationBindingRequest {
  readonly request_ref?: Ref;
  readonly active_embodiment_ref?: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly primitive_ref?: Ref;
  readonly primitive_name?: ManipulationPrimitiveName;
  readonly preferred_end_effector_role?: EndEffectorRole;
  readonly source_plan_ref: Ref;
  readonly control_work_order_ref: Ref;
  readonly validation_decision_ref: Ref;
  readonly subject_object_ref?: Ref;
  readonly target_frame_ref?: Ref;
  readonly tool_frame_ref?: Ref;
  readonly available_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly contact_expectation: ManipulationContactExpectation;
  readonly success_condition: string;
  readonly fallback_policy: readonly ManipulationFallbackAction[];
  readonly object_size_class?: ManipulationPrimitiveFeasibilityInput["object_size_class"];
  readonly object_fragility?: ManipulationPrimitiveFeasibilityInput["object_fragility"];
  readonly expected_payload_kg?: number;
  readonly reach_decision?: ManipulationPrimitiveFeasibilityInput["reach_decision"];
  readonly stability_decision?: ManipulationPrimitiveFeasibilityInput["stability_decision"];
  readonly contact_evidence?: ManipulationPrimitiveFeasibilityInput["contact_evidence"];
  readonly actuator_report?: ManipulationPrimitiveFeasibilityInput["actuator_report"];
  readonly tool_attachment_validated?: boolean;
  readonly verification_view_available?: boolean;
}

/**
 * Candidate binding between one primitive and one concrete end effector.
 */
export interface EmbodimentPrimitiveBinding {
  readonly binding_ref: Ref;
  readonly primitive_ref: Ref;
  readonly primitive_name: ManipulationPrimitiveName;
  readonly capability_primitive: ManipulationPrimitive;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_role: EndEffectorRole;
  readonly capability_ref?: Ref;
  readonly preferred_mapping: boolean;
  readonly admission: ManipulationAdmission | "descriptor_only";
  readonly risk_class: ManipulationRiskClass | "unknown";
  readonly binding_score: number;
  readonly speed_scale: number;
  readonly required_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly missing_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly required_followup: readonly EmbodimentManipulationAdapterAction[];
  readonly control_phase_profile: ManipulationPrimitiveDescriptor["control_phase_profile"];
  readonly constraint_summary: string;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

/**
 * Adapter report consumed by primitive preconditions and control planning.
 */
export interface EmbodimentManipulationAdapterReport {
  readonly schema_version: typeof EMBODIMENT_MANIPULATION_ADAPTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: EmbodimentManipulationAdapterDecision;
  readonly recommended_action: EmbodimentManipulationAdapterAction;
  readonly selected_binding?: EmbodimentPrimitiveBinding;
  readonly candidate_bindings: readonly EmbodimentPrimitiveBinding[];
  readonly primitive_intent_report?: PrimitiveExecutionIntentReport;
  readonly feasibility_reports: readonly ManipulationPrimitiveFeasibilityReport[];
  readonly capability_refs_considered: readonly Ref[];
  readonly missing_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly required_followup: readonly EmbodimentManipulationAdapterAction[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "embodiment_manipulation_binding";
  readonly determinism_hash: string;
}

/**
 * Deterministically binds primitive descriptors to embodiment-specific
 * manipulation capabilities.
 */
export class EmbodimentManipulationAdapter {
  private readonly primitiveCatalog: ManipulationPrimitiveCatalog;
  private readonly capabilityCatalog: ManipulationCapabilityCatalog | undefined;

  public constructor(config: EmbodimentManipulationAdapterConfig = {}) {
    this.primitiveCatalog = config.primitive_catalog ?? createManipulationPrimitiveCatalog();
    this.capabilityCatalog = config.capability_catalog ?? createManipulationCapabilityCatalog();
  }

  /**
   * Selects the safest available effector for a validated primitive request.
   */
  public bindPrimitive(request: EmbodimentManipulationBindingRequest): EmbodimentManipulationAdapterReport {
    const issues: ValidationIssue[] = [];
    validateRequestShape(request, issues);
    const requestRef = sanitizeRef(request.request_ref ?? `embodiment_manipulation_binding_${computeDeterminismHash({
      primitive: request.primitive_ref ?? request.primitive_name ?? "unspecified",
      plan: request.source_plan_ref,
      workOrder: request.control_work_order_ref,
    })}`);
    const descriptor = resolvePrimitiveDescriptor(this.primitiveCatalog, request, issues);
    const primitiveIntentReport = descriptor === undefined ? undefined : this.primitiveCatalog.validateExecutionIntent(buildIntent(request, descriptor));
    issues.push(...(primitiveIntentReport?.issues ?? []));

    const capabilities = resolveCapabilities(this.capabilityCatalog, request, issues);
    const bindings = descriptor === undefined
      ? freezeArray<EmbodimentPrimitiveBinding>([])
      : freezeArray(chooseCandidateRoles(descriptor, request)
        .map((role) => this.buildBinding(request, descriptor, role, capabilities))
        .sort((a, b) => b.binding_score - a.binding_score || a.end_effector_role.localeCompare(b.end_effector_role)));
    const selectedBinding = bindings.find((binding) => binding.ok);
    if (descriptor !== undefined && bindings.length === 0) {
      issues.push(makeIssue("error", "NoBindableEffector", "$.selected_primitive_ref", "No end-effector role can bind the selected primitive for this embodiment.", "Choose a primitive and body role supported by the active embodiment."));
    }
    const feasibilityReports = freezeArray(bindings.flatMap((binding) => {
      const report = evaluateFeasibility(this.capabilityCatalog, request, descriptor, binding.end_effector_role);
      return report === undefined ? [] : [report];
    }));
    const allIssues = freezeArray([...issues, ...bindings.flatMap((binding) => binding.issues), ...feasibilityReports.flatMap((report) => report.issues)]);
    const missingEvidence = freezeArray([...new Set(bindings.flatMap((binding) => binding.missing_sensor_evidence))].sort());
    const followup = freezeArray([...new Set([
      ...bindings.flatMap((binding) => binding.required_followup),
      ...followupFromIssues(allIssues),
    ])].sort());
    const decision = decideAdapter(selectedBinding, bindings, allIssues, followup);
    const base = {
      schema_version: EMBODIMENT_MANIPULATION_ADAPTER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `embodiment_manipulation_adapter_${computeDeterminismHash({
        requestRef,
        selected: selectedBinding?.binding_ref,
        candidates: bindings.map((binding) => binding.binding_ref),
      })}`,
      request_ref: requestRef,
      decision,
      recommended_action: recommendAction(decision, followup),
      selected_binding: selectedBinding,
      candidate_bindings: bindings,
      primitive_intent_report: primitiveIntentReport,
      feasibility_reports: feasibilityReports,
      capability_refs_considered: freezeArray(capabilities.map((capability) => capability.capability_ref).sort()),
      missing_sensor_evidence: missingEvidence,
      required_followup: followup,
      issues: allIssues,
      ok: selectedBinding !== undefined && (decision === "bound" || decision === "bound_with_constraints"),
      cognitive_visibility: "embodiment_manipulation_binding" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private buildBinding(
    request: EmbodimentManipulationBindingRequest,
    descriptor: ManipulationPrimitiveDescriptor,
    role: EndEffectorRole,
    capabilities: readonly ResolvedManipulationCapability[],
  ): EmbodimentPrimitiveBinding {
    const issues: ValidationIssue[] = [];
    const capability = chooseCapability(capabilities, role, descriptor.capability_primitive);
    if (!descriptor.required_end_effector_roles.includes(role)) {
      issues.push(makeIssue("error", "PrimitiveUnsupportedForEffector", "$.end_effector_role", `Role ${role} is not declared by primitive ${descriptor.primitive_name}.`, "Use an effector role listed by the primitive descriptor."));
    }
    if (!descriptor.embodiment_variants.includes(request.embodiment_kind)) {
      issues.push(makeIssue("error", "PrimitiveUnsupportedForEmbodiment", "$.embodiment_kind", `${descriptor.primitive_name} is not declared for ${request.embodiment_kind}.`, "Choose a primitive variant supported by this embodiment."));
    }
    if (capability === undefined) {
      issues.push(makeIssue("warning", "CapabilityCatalogUnavailable", "$.capability_catalog", `No resolved manipulation capability is available for ${role}.`, "Register an embodiment manipulation capability catalog for full binding validation."));
    } else if (!capability.supported_primitives.includes(descriptor.capability_primitive)) {
      issues.push(makeIssue("error", "PrimitiveUnsupportedForEffector", "$.capability.supported_primitives", `${role} capability does not support ${descriptor.capability_primitive}.`, "Choose a supported primitive or alternate effector."));
    }
    const missingEvidence = missingSensorEvidence(descriptor, request);
    if (missingEvidence.length > 0) {
      issues.push(makeIssue("warning", "SensorEvidenceMissing", "$.available_sensor_evidence", `Missing sensor evidence for ${descriptor.primitive_name}: ${missingEvidence.join(", ")}.`, "Collect required visual, contact, IMU, force, or verification evidence."));
    }
    validateFrameBindings(descriptor, request, issues);
    const feasibility = evaluateFeasibility(this.capabilityCatalog, request, descriptor, role);
    if (feasibility !== undefined && !feasibility.ok) {
      issues.push(makeIssue("error", "CapabilityFeasibilityRejected", "$.feasibility", `Capability feasibility returned ${feasibility.admission}.`, "Resolve reach, stability, contact, actuator, or tool constraints before binding."));
    }
    const preferred = isPreferredEffector(request.embodiment_kind, descriptor.primitive_name, role) || role === request.preferred_end_effector_role;
    const score = computeBindingScore(descriptor, role, capability, feasibility, preferred, missingEvidence.length, issues);
    const requiredFollowup = freezeArray([...new Set([
      ...followupFromIssues(issues),
      ...followupFromFeasibility(feasibility),
    ])].sort());
    const constraintSummary = buildConstraintSummary(descriptor, role, capability, feasibility, missingEvidence);
    const promptSummary = sanitizeText(`${descriptor.primitive_name} can bind to ${role} on ${request.embodiment_kind}; score ${score}; ${constraintSummary}`);
    const base = {
      binding_ref: `binding_${descriptor.primitive_name}_${request.embodiment_kind}_${role}`,
      primitive_ref: descriptor.primitive_ref,
      primitive_name: descriptor.primitive_name,
      capability_primitive: descriptor.capability_primitive,
      embodiment_kind: request.embodiment_kind,
      end_effector_role: role,
      capability_ref: capability?.capability_ref,
      preferred_mapping: preferred,
      admission: feasibility?.admission ?? "descriptor_only" as const,
      risk_class: feasibility?.risk_class ?? "unknown" as const,
      binding_score: score,
      speed_scale: round6(Math.min(descriptor.control_phase_profile.speed_scale, feasibility?.speed_scale ?? descriptor.control_phase_profile.speed_scale)),
      required_sensor_evidence: descriptor.required_sensor_evidence,
      missing_sensor_evidence: missingEvidence,
      required_followup: requiredFollowup,
      control_phase_profile: descriptor.control_phase_profile,
      constraint_summary: constraintSummary,
      prompt_safe_summary: promptSummary,
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createEmbodimentManipulationAdapter(config: EmbodimentManipulationAdapterConfig = {}): EmbodimentManipulationAdapter {
  return new EmbodimentManipulationAdapter(config);
}

function resolvePrimitiveDescriptor(
  catalog: ManipulationPrimitiveCatalog,
  request: EmbodimentManipulationBindingRequest,
  issues: ValidationIssue[],
): ManipulationPrimitiveDescriptor | undefined {
  try {
    if (request.primitive_ref !== undefined) {
      return catalog.requirePrimitive(request.primitive_ref);
    }
    if (request.primitive_name !== undefined) {
      const report = catalog.buildCatalogReport({ primitive_name: request.primitive_name, embodiment_kind: request.embodiment_kind });
      if (report.descriptors.length === 1) {
        return report.descriptors[0];
      }
    }
  } catch (error: unknown) {
    issues.push(makeIssue("error", "PrimitiveSelectionMissing", "$.primitive_ref", error instanceof Error ? error.message : "Primitive selection failed.", "Select a registered primitive_ref or primitive_name."));
    return undefined;
  }
  issues.push(makeIssue("error", "PrimitiveSelectionMissing", "$.primitive_ref", "Request must select exactly one manipulation primitive.", "Provide primitive_ref or primitive_name from ManipulationPrimitiveCatalog."));
  return undefined;
}

function resolveCapabilities(
  catalog: ManipulationCapabilityCatalog | undefined,
  request: EmbodimentManipulationBindingRequest,
  issues: ValidationIssue[],
): readonly ResolvedManipulationCapability[] {
  if (catalog === undefined) {
    issues.push(makeIssue("warning", "CapabilityCatalogUnavailable", "$.capability_catalog", "No manipulation capability catalog is configured.", "Provide an active ManipulationCapabilityCatalog for embodiment-aware binding."));
    return freezeArray([]);
  }
  try {
    const report = catalog.buildManipulationCapabilityCatalogReport({ active_embodiment_ref: request.active_embodiment_ref });
    return report.capabilities;
  } catch (error: unknown) {
    issues.push(makeIssue("warning", "CapabilityCatalogUnavailable", "$.capability_catalog", error instanceof Error ? error.message : "Capability catalog could not be resolved.", "Register and select an active embodiment before binding primitives."));
    return freezeArray([]);
  }
}

function evaluateFeasibility(
  catalog: ManipulationCapabilityCatalog | undefined,
  request: EmbodimentManipulationBindingRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  role: EndEffectorRole,
): ManipulationPrimitiveFeasibilityReport | undefined {
  if (catalog === undefined || descriptor === undefined) {
    return undefined;
  }
  try {
    return catalog.evaluatePrimitiveFeasibility({
      active_embodiment_ref: request.active_embodiment_ref,
      end_effector_role: role,
      primitive: descriptor.capability_primitive,
      consumer: "manipulation",
      object_size_class: request.object_size_class,
      object_fragility: request.object_fragility,
      expected_payload_kg: request.expected_payload_kg,
      reach_decision: request.reach_decision,
      stability_decision: request.stability_decision,
      contact_evidence: request.contact_evidence,
      actuator_report: request.actuator_report,
      tool_attachment_validated: request.tool_attachment_validated,
      verification_view_available: request.verification_view_available,
    });
  } catch {
    return undefined;
  }
}

function buildIntent(request: EmbodimentManipulationBindingRequest, descriptor: ManipulationPrimitiveDescriptor): PrimitiveExecutionIntent {
  return Object.freeze({
    intent_ref: request.request_ref ?? `intent_${descriptor.primitive_name}_${request.embodiment_kind}`,
    source_plan_ref: request.source_plan_ref,
    control_work_order_ref: request.control_work_order_ref,
    selected_primitive_ref: descriptor.primitive_ref,
    embodiment_kind: request.embodiment_kind,
    end_effector_role: request.preferred_end_effector_role ?? descriptor.required_end_effector_roles[0],
    subject_object_ref: request.subject_object_ref,
    target_frame_ref: request.target_frame_ref,
    tool_frame_ref: request.tool_frame_ref,
    available_sensor_evidence: request.available_sensor_evidence,
    contact_expectation: request.contact_expectation,
    success_condition: request.success_condition,
    fallback_policy: request.fallback_policy,
    validation_decision_ref: request.validation_decision_ref,
  });
}

function chooseCandidateRoles(
  descriptor: ManipulationPrimitiveDescriptor,
  request: EmbodimentManipulationBindingRequest,
): readonly EndEffectorRole[] {
  const roles = descriptor.required_end_effector_roles.filter((role) => request.preferred_end_effector_role === undefined || role === request.preferred_end_effector_role);
  return freezeArray(roles.sort((a, b) => rolePreferenceRank(request.embodiment_kind, descriptor.primitive_name, a) - rolePreferenceRank(request.embodiment_kind, descriptor.primitive_name, b) || a.localeCompare(b)));
}

function chooseCapability(
  capabilities: readonly ResolvedManipulationCapability[],
  role: EndEffectorRole,
  primitive: ManipulationPrimitive,
): ResolvedManipulationCapability | undefined {
  return capabilities
    .filter((capability) => capability.end_effector_role === role)
    .sort((a, b) => Number(b.supported_primitives.includes(primitive)) - Number(a.supported_primitives.includes(primitive)) || precisionRank(b.precision_rating) - precisionRank(a.precision_rating) || a.capability_ref.localeCompare(b.capability_ref))[0];
}

function validateRequestShape(request: EmbodimentManipulationBindingRequest, issues: ValidationIssue[]): void {
  validateRef(request.source_plan_ref, "$.source_plan_ref", "ValidatedPlanMissing", issues);
  validateRef(request.control_work_order_ref, "$.control_work_order_ref", "ControlWorkOrderMissing", issues);
  validateRef(request.validation_decision_ref, "$.validation_decision_ref", "ValidationDecisionMissing", issues);
  if (request.request_ref !== undefined) validateRef(request.request_ref, "$.request_ref", "HiddenAdapterLeak", issues);
  if (request.primitive_ref !== undefined) validateRef(request.primitive_ref, "$.primitive_ref", "PrimitiveSelectionMissing", issues);
  if (request.subject_object_ref !== undefined) validateRef(request.subject_object_ref, "$.subject_object_ref", "SubjectObjectMissing", issues);
  if (request.target_frame_ref !== undefined) validateRef(request.target_frame_ref, "$.target_frame_ref", "TargetFrameMissing", issues);
  if (request.tool_frame_ref !== undefined) validateRef(request.tool_frame_ref, "$.tool_frame_ref", "ToolFrameMissing", issues);
  if (request.success_condition.trim().length === 0) {
    issues.push(makeIssue("error", "PrimitiveSelectionMissing", "$.success_condition", "Success condition must be observable.", "Attach the primitive postcondition or verification hook."));
  }
  if (HIDDEN_ADAPTER_PATTERN.test(request.success_condition)) {
    issues.push(makeIssue("error", "HiddenAdapterLeak", "$.success_condition", "Success condition contains hidden simulator, backend, QA, or direct actuator detail.", "Use sensor-derived and validator-approved wording only."));
  }
}

function validateFrameBindings(
  descriptor: ManipulationPrimitiveDescriptor,
  request: EmbodimentManipulationBindingRequest,
  issues: ValidationIssue[],
): void {
  if (descriptor.target_frame_requirements.requires_subject_object && request.subject_object_ref === undefined) {
    issues.push(makeIssue("error", "SubjectObjectMissing", "$.subject_object_ref", "Primitive requires a current subject object reference.", "Bind the request to a current object hypothesis or target memory."));
  }
  if (descriptor.target_frame_requirements.requires_target_frame && request.target_frame_ref === undefined) {
    issues.push(makeIssue("error", "TargetFrameMissing", "$.target_frame_ref", "Primitive requires a validated target frame.", "Attach a File 10 control-candidate frame."));
  }
  if (descriptor.target_frame_requirements.requires_tool_frame && request.tool_frame_ref === undefined) {
    issues.push(makeIssue("error", "ToolFrameMissing", "$.tool_frame_ref", "Primitive requires a current task-scoped tool frame.", "Validate acquisition and tool-frame freshness before binding tool motion."));
  }
}

function missingSensorEvidence(descriptor: ManipulationPrimitiveDescriptor, request: EmbodimentManipulationBindingRequest): readonly ManipulationSensorEvidence[] {
  return freezeArray(descriptor.required_sensor_evidence.filter((evidence) => !request.available_sensor_evidence.includes(evidence)));
}

function computeBindingScore(
  descriptor: ManipulationPrimitiveDescriptor,
  role: EndEffectorRole,
  capability: ResolvedManipulationCapability | undefined,
  feasibility: ManipulationPrimitiveFeasibilityReport | undefined,
  preferred: boolean,
  missingEvidenceCount: number,
  issues: readonly ValidationIssue[],
): number {
  let score = 50;
  score += preferred ? 20 : Math.max(0, 12 - rolePreferenceRank("humanoid", descriptor.primitive_name, role));
  score += capability === undefined ? -8 : precisionRank(capability.precision_rating) * 6;
  score -= missingEvidenceCount * 7;
  score += feasibilityScore(feasibility);
  score -= issues.filter((issue) => issue.severity === "warning").length * 5;
  score -= issues.filter((issue) => issue.severity === "error").length * 35;
  return round6(Math.max(0, Math.min(100, score)));
}

function feasibilityScore(report: ManipulationPrimitiveFeasibilityReport | undefined): number {
  if (report === undefined) return 0;
  if (report.admission === "admit") return 20;
  if (report.admission === "admit_with_constraints") return 10;
  if (report.admission === "reobserve" || report.admission === "reposition" || report.admission === "tool_validation_required") return -8;
  if (report.admission === "safe_hold") return -25;
  return -35;
}

function decideAdapter(
  selected: EmbodimentPrimitiveBinding | undefined,
  bindings: readonly EmbodimentPrimitiveBinding[],
  issues: readonly ValidationIssue[],
  followup: readonly EmbodimentManipulationAdapterAction[],
): EmbodimentManipulationAdapterDecision {
  if (issues.some((issue) => issue.severity === "error") && selected === undefined) return "rejected";
  if (followup.includes("safe_hold")) return "safe_hold";
  if (followup.includes("validate_tool")) return "tool_validation_required";
  if (followup.includes("reposition_body")) return "reposition";
  if (followup.includes("collect_sensor_evidence")) return "reobserve";
  if (selected !== undefined && (selected.issues.length > 0 || selected.admission === "admit_with_constraints" || selected.admission === "descriptor_only")) return "bound_with_constraints";
  return bindings.length === 0 ? "rejected" : "bound";
}

function recommendAction(decision: EmbodimentManipulationAdapterDecision, followup: readonly EmbodimentManipulationAdapterAction[]): EmbodimentManipulationAdapterAction {
  if (decision === "bound" || decision === "bound_with_constraints") return "execute_primitive";
  if (decision === "safe_hold") return "safe_hold";
  if (decision === "tool_validation_required") return "validate_tool";
  if (decision === "reposition") return "reposition_body";
  if (decision === "reobserve") return "collect_sensor_evidence";
  return followup[0] ?? "repair_intent";
}

function followupFromIssues(issues: readonly ValidationIssue[]): readonly EmbodimentManipulationAdapterAction[] {
  const actions: EmbodimentManipulationAdapterAction[] = [];
  for (const issue of issues) {
    if (issue.code === "SensorEvidenceMissing") actions.push("collect_sensor_evidence");
    if (issue.code === "TargetFrameMissing" || issue.code === "SubjectObjectMissing") actions.push("repair_intent");
    if (issue.code === "ToolFrameMissing") actions.push("validate_tool");
    if (issue.code === "CapabilityFeasibilityRejected") actions.push("repair_intent");
  }
  return freezeArray(actions);
}

function followupFromFeasibility(report: ManipulationPrimitiveFeasibilityReport | undefined): readonly EmbodimentManipulationAdapterAction[] {
  if (report === undefined) return freezeArray([]);
  return freezeArray(report.required_followup.map((followup) => {
    if (followup === "reobserve" || followup === "alternate_view") return "collect_sensor_evidence";
    if (followup === "reposition") return "reposition_body";
    if (followup === "validate_tool") return "validate_tool";
    if (followup === "stabilize") return "stabilize_first";
    if (followup === "human_review") return "safe_hold";
    return "repair_intent";
  }));
}

function buildConstraintSummary(
  descriptor: ManipulationPrimitiveDescriptor,
  role: EndEffectorRole,
  capability: ResolvedManipulationCapability | undefined,
  feasibility: ManipulationPrimitiveFeasibilityReport | undefined,
  missingEvidence: readonly ManipulationSensorEvidence[],
): string {
  const capabilityText = capability === undefined
    ? "capability catalog not resolved"
    : `${capability.precision_rating} precision, ${capability.occlusion_risk} occlusion, reach ${formatOptional(capability.tool_extended_reach_m ?? capability.natural_reach_m)} m`;
  const feasibilityText = feasibility === undefined ? "descriptor constraints only" : `admission ${feasibility.admission}, risk ${feasibility.risk_class}`;
  const evidenceText = missingEvidence.length === 0 ? "sensor evidence complete" : `missing ${missingEvidence.join(", ")}`;
  return sanitizeText(`${role} for ${descriptor.primitive_name}: ${capabilityText}; ${feasibilityText}; ${evidenceText}.`);
}

function isPreferredEffector(kind: EmbodimentKind, primitive: ManipulationPrimitiveName, role: EndEffectorRole): boolean {
  return rolePreferenceRank(kind, primitive, role) === 0;
}

function rolePreferenceRank(kind: EmbodimentKind, primitive: ManipulationPrimitiveName, role: EndEffectorRole): number {
  const preferences = preferredRoles(kind, primitive);
  const index = preferences.indexOf(role);
  return index === -1 ? 99 : index;
}

function preferredRoles(kind: EmbodimentKind, primitive: ManipulationPrimitiveName): readonly EndEffectorRole[] {
  if (kind === "quadruped") {
    const table: Readonly<Partial<Record<ManipulationPrimitiveName, readonly EndEffectorRole[]>>> = {
      inspect_target: ["mouth_gripper", "wrist", "paw"],
      approach_target: ["paw", "forelimb", "mouth_gripper"],
      align_end_effector: ["mouth_gripper", "forelimb", "paw", "tool_tip"],
      grasp_object: ["mouth_gripper", "forelimb"],
      contact_push: ["paw", "forelimb", "tool_tip"],
      lift_object: ["mouth_gripper", "forelimb"],
      carry_object: ["mouth_gripper", "forelimb"],
      place_object: ["mouth_gripper", "forelimb", "tool_tip"],
      release_object: ["mouth_gripper", "forelimb"],
      retreat_end_effector: ["mouth_gripper", "forelimb", "paw", "tool_tip"],
      push_object: ["paw", "forelimb", "tool_tip"],
      pull_object: ["mouth_gripper", "forelimb", "tool_tip"],
      slide_object: ["paw", "forelimb", "tool_tip"],
      pin_object: ["paw", "forelimb"],
      nudge_object: ["paw", "forelimb", "tool_tip"],
      acquire_tool: ["mouth_gripper", "paw", "forelimb"],
      use_tool: ["mouth_gripper", "paw", "tool_tip"],
      safe_hold_manipulation: ["mouth_gripper", "paw", "forelimb", "tool_tip"],
    };
    return table[primitive] ?? [];
  }
  const table: Readonly<Partial<Record<ManipulationPrimitiveName, readonly EndEffectorRole[]>>> = {
    inspect_target: ["wrist", "left_hand", "right_hand"],
    approach_target: ["left_hand", "right_hand", "both_hands"],
    align_end_effector: ["left_hand", "right_hand", "both_hands", "tool_tip"],
    grasp_object: ["right_hand", "left_hand", "both_hands"],
    contact_push: ["right_hand", "left_hand", "wrist", "tool_tip"],
    lift_object: ["both_hands", "right_hand", "left_hand"],
    carry_object: ["both_hands", "right_hand", "left_hand"],
    place_object: ["right_hand", "left_hand", "both_hands", "tool_tip"],
    release_object: ["right_hand", "left_hand", "both_hands"],
    retreat_end_effector: ["right_hand", "left_hand", "both_hands", "tool_tip"],
    push_object: ["right_hand", "left_hand", "wrist", "tool_tip"],
    pull_object: ["right_hand", "left_hand", "tool_tip"],
    slide_object: ["right_hand", "left_hand", "wrist", "tool_tip"],
    pin_object: ["left_hand", "right_hand", "wrist"],
    nudge_object: ["right_hand", "left_hand", "tool_tip"],
    acquire_tool: ["right_hand", "left_hand", "both_hands"],
    use_tool: ["right_hand", "left_hand", "both_hands", "tool_tip"],
    safe_hold_manipulation: ["both_hands", "right_hand", "left_hand", "tool_tip"],
  };
  return table[primitive] ?? [];
}

function precisionRank(precision: "low" | "medium" | "high"): number {
  if (precision === "high") return 3;
  if (precision === "medium") return 2;
  return 1;
}

function validateRef(ref: Ref, path: string, code: EmbodimentManipulationAdapterIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque validated manipulation references."));
    return;
  }
  if (HIDDEN_ADAPTER_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenAdapterLeak", path, "Reference contains hidden simulator, backend, QA, or direct actuator detail.", "Use opaque plan, frame, primitive, capability, and evidence refs."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_ADAPTER_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_ADAPTER_PATTERN, "hidden-detail").trim();
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "unknown" : round6(value).toString();
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: EmbodimentManipulationAdapterIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
