/**
 * Manipulation capability catalog for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.8, 5.9, 5.11, 5.12, 5.13, 5.14, 5.15, 5.19,
 * and 5.20.
 *
 * This module is the executable catalog for body-specific manipulation
 * affordances. It describes what each mouth, paw, hand, two-hand, wrist, or
 * tool-tip effector can inspect, approach, grasp, lift, carry, place, push,
 * pull, release, retreat, and tool-use while cross-checking declared reach,
 * stability, contacts, actuator limits, precision, occlusion risk, and failure
 * modes. It produces prompt-safe capability summaries only; it never exposes
 * simulator world truth, backend handles, collision meshes, hidden object
 * coordinates, or QA labels.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type {
  EmbodimentDescriptor,
  EndEffectorDescriptor,
  EndEffectorRole,
  ManipulationCapabilityDescriptor,
  ManipulationPrimitive,
  PrecisionRating,
} from "./embodiment_model_registry";
import type { ActuatorCommandLimitReport } from "./actuator_limit_catalog";
import type { ContactEvidenceReport } from "./contact_site_registry";
import type { ReachDecision } from "./reach_envelope_service";
import type { StabilityDecision } from "./stability_policy_service";

export const MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION = "mebsuta.manipulation_capability_catalog.v1" as const;

const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|solver|object_id|hidden)/i;

export type ManipulationAdmission = "admit" | "admit_with_constraints" | "reobserve" | "reposition" | "tool_validation_required" | "safe_hold" | "reject";
export type ManipulationForceProfile = "inspect_only" | "gentle" | "normal" | "cautious" | "tool_contact" | "retreat";
export type ManipulationRiskClass = "low" | "medium" | "high" | "blocked";
export type ManipulationConsumer = "prompt_contract" | "plan_validator" | "manipulation" | "tool_use" | "oops_loop" | "safety" | "qa";
export type ManipulationFailureMode = ManipulationCapabilityDescriptor["failure_modes"][number];

export type ManipulationCapabilityIssueCode =
  | "ActiveEmbodimentMissing"
  | "ManipulationCapabilityMissing"
  | "EndEffectorUnavailable"
  | "PrimitiveUnsupported"
  | "ReachGateRejected"
  | "StabilityGateRejected"
  | "ContactGateRejected"
  | "ActuatorGateRejected"
  | "PrecisionInsufficient"
  | "OcclusionRiskHigh"
  | "ToolValidationRequired"
  | "ForbiddenBodyDetail";

export interface ManipulationCapabilityCatalogConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface ManipulationCapabilitySelectionInput {
  readonly active_embodiment_ref?: Ref;
  readonly end_effector_role?: EndEffectorRole;
  readonly primitive?: ManipulationPrimitive;
  readonly precision_rating_at_least?: PrecisionRating;
  readonly consumer?: ManipulationConsumer;
}

export interface ResolvedManipulationCapability {
  readonly schema_version: typeof MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly capability_ref: Ref;
  readonly end_effector_ref?: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly supported_primitives: readonly ManipulationPrimitive[];
  readonly object_size_range_summary: string;
  readonly grip_force_range_summary?: string;
  readonly precision_rating: PrecisionRating;
  readonly occlusion_risk: ManipulationCapabilityDescriptor["occlusion_risk"];
  readonly failure_modes: readonly ManipulationFailureMode[];
  readonly natural_reach_m?: number;
  readonly tool_extended_reach_m?: number;
  readonly actuator_force_limit_n?: number;
  readonly contact_force_limit_n?: number;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ManipulationCapabilityGroupSummary {
  readonly end_effector_role: EndEffectorRole;
  readonly capability_count: number;
  readonly primitive_count: number;
  readonly supported_primitives: readonly ManipulationPrimitive[];
  readonly highest_precision: PrecisionRating;
  readonly maximum_reach_m: number;
  readonly maximum_force_limit_n: number;
  readonly occlusion_risk: ManipulationCapabilityDescriptor["occlusion_risk"];
}

export interface ManipulationCapabilityCatalogReport {
  readonly schema_version: typeof MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly manipulation_capability_ref: Ref;
  readonly capability_count: number;
  readonly end_effector_count: number;
  readonly supported_primitive_count: number;
  readonly capabilities: readonly ResolvedManipulationCapability[];
  readonly group_summaries: readonly ManipulationCapabilityGroupSummary[];
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly determinism_hash: string;
}

export interface ManipulationPrimitiveFeasibilityInput {
  readonly active_embodiment_ref?: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly primitive: ManipulationPrimitive;
  readonly consumer: ManipulationConsumer;
  readonly required_precision?: PrecisionRating;
  readonly object_size_class?: "small" | "medium" | "large" | "unknown";
  readonly object_fragility?: "fragile" | "normal" | "sturdy" | "unknown";
  readonly expected_payload_kg?: number;
  readonly reach_decision?: ReachDecision;
  readonly stability_decision?: StabilityDecision;
  readonly contact_evidence?: ContactEvidenceReport;
  readonly actuator_report?: ActuatorCommandLimitReport;
  readonly tool_attachment_validated?: boolean;
  readonly verification_view_available?: boolean;
}

export interface ManipulationPrimitiveFeasibilityReport {
  readonly schema_version: typeof MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_role: EndEffectorRole;
  readonly primitive: ManipulationPrimitive;
  readonly admission: ManipulationAdmission;
  readonly risk_class: ManipulationRiskClass;
  readonly force_profile: ManipulationForceProfile;
  readonly speed_scale: number;
  readonly required_followup: readonly ("reobserve" | "reposition" | "validate_tool" | "stabilize" | "reduce_force" | "alternate_view" | "human_review")[];
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveManipulationCapabilitySummary {
  readonly schema_version: typeof MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly manipulation_summary: readonly string[];
  readonly limitation_summary: readonly string[];
  readonly failure_mode_summary: readonly string[];
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export class ManipulationCapabilityCatalogError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ManipulationCapabilityCatalogError";
    this.issues = issues;
  }
}

/**
 * Resolves manipulation affordances and validates primitive admission against
 * reach, stability, contact, and actuator evidence.
 */
export class ManipulationCapabilityCatalog {
  private readonly registry: EmbodimentModelRegistry;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: ManipulationCapabilityCatalogConfig = {}) {
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
   * Selects the active body model used by later capability queries.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Builds the complete manipulation capability table for the active body.
   */
  public buildManipulationCapabilityCatalogReport(selection: ManipulationCapabilitySelectionInput = {}): ManipulationCapabilityCatalogReport {
    const model = this.requireEmbodiment(selection.active_embodiment_ref);
    const capabilities = freezeArray(model.manipulation_capabilities
      .filter((capability) => selection.end_effector_role === undefined || capability.end_effector_role === selection.end_effector_role)
      .filter((capability) => selection.primitive === undefined || capability.supported_primitives.includes(selection.primitive))
      .filter((capability) => selection.precision_rating_at_least === undefined || precisionRank(capability.precision_rating) >= precisionRank(selection.precision_rating_at_least))
      .map((capability, index) => resolveCapability(model, capability, `$.manipulation_capabilities[${index}]`))
      .sort((a, b) => a.capability_ref.localeCompare(b.capability_ref)));
    const coverageIssues = validateCapabilityCoverage(model);
    const issues = freezeArray([...coverageIssues, ...capabilities.flatMap((capability) => capability.issues)]);
    const supportedPrimitives = freezeArray([...new Set(capabilities.flatMap((capability) => capability.supported_primitives))].sort());
    const base = {
      schema_version: MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      manipulation_capability_ref: model.manipulation_capability_ref,
      capability_count: capabilities.length,
      end_effector_count: model.end_effectors.length,
      supported_primitive_count: supportedPrimitives.length,
      capabilities,
      group_summaries: buildGroupSummaries(capabilities),
      hidden_fields_removed: hiddenFieldsRemoved(),
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Resolves one capability for an end-effector role.
   */
  public requireManipulationCapability(selection: ManipulationCapabilitySelectionInput): ResolvedManipulationCapability {
    const report = this.buildManipulationCapabilityCatalogReport(selection);
    if (report.capabilities.length !== 1) {
      throw new ManipulationCapabilityCatalogError("Manipulation capability selection must resolve to exactly one capability.", [
        makeIssue("error", "ManipulationCapabilityMissing", "$.selection", `Selection resolved ${report.capabilities.length} capabilities.`, "Select by end_effector_role and, if needed, primitive."),
      ]);
    }
    return report.capabilities[0];
  }

  /**
   * Checks whether a manipulation primitive can be admitted with the currently
   * available reach, stability, contact, and actuator evidence.
   */
  public evaluatePrimitiveFeasibility(input: ManipulationPrimitiveFeasibilityInput): ManipulationPrimitiveFeasibilityReport {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const issues: ValidationIssue[] = [];
    const capability = model.manipulation_capabilities.find((candidate) => candidate.end_effector_role === input.end_effector_role);
    const effector = model.end_effectors.find((candidate) => candidate.role === input.end_effector_role);
    if (capability === undefined) {
      issues.push(makeIssue("error", "ManipulationCapabilityMissing", "$.end_effector_role", `No manipulation capability exists for ${input.end_effector_role}.`, "Choose a declared manipulation effector."));
    }
    if (effector === undefined) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.end_effector_role", `End effector ${input.end_effector_role} is not declared.`, "Use a declared end effector."));
    }
    if (capability !== undefined && !capability.supported_primitives.includes(input.primitive)) {
      issues.push(makeIssue("error", "PrimitiveUnsupported", "$.primitive", `Primitive ${input.primitive} is unsupported by ${input.end_effector_role}.`, "Choose a supported primitive or another end effector."));
    }
    if (capability !== undefined && input.required_precision !== undefined && precisionRank(capability.precision_rating) < precisionRank(input.required_precision)) {
      issues.push(makeIssue("error", "PrecisionInsufficient", "$.required_precision", "Capability precision is below the requested primitive precision.", "Use a higher precision effector or loosen the task."));
    }
    applyReachGate(input, issues);
    applyStabilityGate(input, issues);
    applyContactGate(input, issues);
    applyActuatorGate(input, issues);
    applyToolGate(input, capability, issues);
    applyOcclusionGate(input, capability, issues);

    const admission = chooseAdmission(input, issues);
    const risk = classifyRisk(input, capability, issues);
    const forceProfile = chooseForceProfile(input, capability, risk);
    const speedScale = computeSpeedScale(input, risk, forceProfile);
    const followup = requiredFollowup(admission, input, issues);
    const summary = sanitizeText(buildPrimitiveSummary(model.embodiment_kind, input, admission, risk, forceProfile));
    assertNoForbiddenLeak(summary);
    const base = {
      schema_version: MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      end_effector_role: input.end_effector_role,
      primitive: input.primitive,
      admission,
      risk_class: risk,
      force_profile: forceProfile,
      speed_scale: round6(speedScale),
      required_followup: followup,
      prompt_safe_summary: summary,
      issues: freezeArray(issues),
      ok: admission === "admit" || admission === "admit_with_constraints",
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Produces the model-facing manipulation capability summary allowed by the
   * embodiment prompt contract.
   */
  public buildCognitiveManipulationCapabilitySummary(activeEmbodimentRef?: Ref): CognitiveManipulationCapabilitySummary {
    const report = this.buildManipulationCapabilityCatalogReport({ active_embodiment_ref: activeEmbodimentRef });
    const manipulationSummary = freezeArray(report.capabilities.map((capability) => sanitizeText(
      `${capability.end_effector_role} supports ${capability.supported_primitives.join(", ")} with ${capability.precision_rating} precision.`,
    )));
    const limitationSummary = freezeArray(report.capabilities.map((capability) => sanitizeText(
      `${capability.end_effector_role} handles ${capability.object_size_range_summary}; occlusion risk is ${capability.occlusion_risk}.`,
    )));
    const failureModes = freezeArray([...new Set(report.capabilities.flatMap((capability) => capability.failure_modes))].sort()
      .map((failure) => sanitizeText(`Possible manipulation failure: ${failure}.`)));
    for (const text of [...manipulationSummary, ...limitationSummary, ...failureModes]) {
      assertNoForbiddenLeak(text);
    }
    const hidden = hiddenFieldsRemoved();
    const base = {
      schema_version: MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      manipulation_summary: manipulationSummary,
      limitation_summary: limitationSummary,
      failure_mode_summary: failureModes,
      forbidden_detail_report_ref: `manipulation_hidden_${computeDeterminismHash({ report: report.determinism_hash, hidden }).slice(0, 12)}`,
      hidden_fields_removed: hidden,
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
      throw new ManipulationCapabilityCatalogError("No active embodiment is registered for manipulation capability resolution.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before resolving manipulation capabilities."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createManipulationCapabilityCatalog(config: ManipulationCapabilityCatalogConfig = {}): ManipulationCapabilityCatalog {
  return new ManipulationCapabilityCatalog(config);
}

function resolveCapability(model: EmbodimentDescriptor, capability: ManipulationCapabilityDescriptor, path: string): ResolvedManipulationCapability {
  const issues: ValidationIssue[] = [];
  validateSafeRef(capability.capability_ref, `${path}.capability_ref`, issues, "ManipulationCapabilityMissing");
  const effector = model.end_effectors.find((candidate) => candidate.role === capability.end_effector_role);
  if (effector === undefined) {
    issues.push(makeIssue("error", "EndEffectorUnavailable", `${path}.end_effector_role`, `End effector ${capability.end_effector_role} is not declared.`, "Bind capabilities to declared end effectors."));
  }
  if (capability.supported_primitives.length === 0) {
    issues.push(makeIssue("error", "PrimitiveUnsupported", `${path}.supported_primitives`, "Capability must support at least one primitive.", "Declare inspect, grasp, push, tool_use, or another body-valid primitive."));
  }
  for (const text of [capability.object_size_range_summary, capability.grip_force_range_summary, ...capability.failure_modes]) {
    if (text !== undefined && FORBIDDEN_DETAIL_PATTERN.test(text)) {
      issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Capability text contains forbidden simulator or QA detail.", "Use body-safe capability wording."));
    }
  }
  const reachMax = effector?.tool_extended_reach_radius_m ?? effector?.natural_reach_radius_m;
  const actuatorForce = maxOf(model.actuator_limits
    .filter((actuator) => actuator.actuator_group === "hand" || actuator.actuator_group === "gripper" || actuator.actuator_group === "mouth" || actuator.actuator_group === "tool" || actuator.actuator_group === "front_leg")
    .map((actuator) => actuator.max_effort));
  const contactForce = maxOf(model.contact_sites
    .filter((site) => contactRoleMatchesEffector(site.contact_role, capability.end_effector_role))
    .map((site) => site.max_contact_force_n));
  const summary = sanitizeText(`${capability.end_effector_role} can ${capability.supported_primitives.join(", ")} with ${capability.precision_rating} precision and ${capability.occlusion_risk} occlusion risk.`);
  assertNoForbiddenLeak(summary);
  const base = {
    schema_version: MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    capability_ref: capability.capability_ref,
    end_effector_ref: effector?.effector_ref,
    end_effector_role: capability.end_effector_role,
    supported_primitives: freezeArray(capability.supported_primitives),
    object_size_range_summary: sanitizeText(capability.object_size_range_summary),
    grip_force_range_summary: capability.grip_force_range_summary === undefined ? undefined : sanitizeText(capability.grip_force_range_summary),
    precision_rating: capability.precision_rating,
    occlusion_risk: capability.occlusion_risk,
    failure_modes: freezeArray(capability.failure_modes),
    natural_reach_m: effector?.natural_reach_radius_m,
    tool_extended_reach_m: reachMax,
    actuator_force_limit_n: actuatorForce,
    contact_force_limit_n: contactForce,
    prompt_safe_summary: summary,
    hidden_fields_removed: hiddenFieldsRemoved(),
    issues: freezeArray(issues),
    ok: issues.every((issue) => issue.severity !== "error"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateCapabilityCoverage(model: EmbodimentDescriptor): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (model.manipulation_capabilities.length === 0) {
    issues.push(makeIssue("error", "ManipulationCapabilityMissing", "$.manipulation_capabilities", "Embodiment has no manipulation capabilities.", "Declare body-specific manipulation affordances."));
  }
  for (const effector of model.end_effectors) {
    if (!model.manipulation_capabilities.some((capability) => capability.end_effector_role === effector.role)) {
      issues.push(makeIssue("warning", "ManipulationCapabilityMissing", "$.manipulation_capabilities", `End effector ${effector.role} has no manipulation capability descriptor.`, "Declare a capability or mark the effector non-manipulating."));
    }
  }
  return freezeArray(issues);
}

function buildGroupSummaries(capabilities: readonly ResolvedManipulationCapability[]): readonly ManipulationCapabilityGroupSummary[] {
  const roles = freezeArray([...new Set(capabilities.map((capability) => capability.end_effector_role))].sort());
  return freezeArray(roles.map((role) => {
    const roleCapabilities = capabilities.filter((capability) => capability.end_effector_role === role);
    const primitives = freezeArray([...new Set(roleCapabilities.flatMap((capability) => capability.supported_primitives))].sort());
    return Object.freeze({
      end_effector_role: role,
      capability_count: roleCapabilities.length,
      primitive_count: primitives.length,
      supported_primitives: primitives,
      highest_precision: highestPrecision(roleCapabilities.map((capability) => capability.precision_rating)),
      maximum_reach_m: round6(maxOf(roleCapabilities.map((capability) => capability.tool_extended_reach_m ?? capability.natural_reach_m ?? 0)) ?? 0),
      maximum_force_limit_n: round6(maxOf(roleCapabilities.map((capability) => Math.max(capability.actuator_force_limit_n ?? 0, capability.contact_force_limit_n ?? 0))) ?? 0),
      occlusion_risk: highestOcclusion(roleCapabilities.map((capability) => capability.occlusion_risk)),
    });
  }));
}

function applyReachGate(input: ManipulationPrimitiveFeasibilityInput, issues: ValidationIssue[]): void {
  if (!requiresReachGate(input.primitive)) {
    return;
  }
  if (input.reach_decision === undefined) {
    issues.push(makeIssue("warning", "ReachGateRejected", "$.reach_decision", "Manipulation primitive has no reach decision.", "Evaluate reach before manipulation admission."));
    return;
  }
  if (input.reach_decision.decision === "UnreachableOrUnsafe") {
    issues.push(makeIssue("error", "ReachGateRejected", "$.reach_decision.decision", "Reach service rejected the target as unsafe or unreachable.", "Reposition, use a tool, or reject the primitive."));
  } else if (input.reach_decision.decision === "UnknownDueToPerception") {
    issues.push(makeIssue("warning", "ReachGateRejected", "$.reach_decision.decision", "Reach is uncertain due to perception.", "Reobserve before manipulation."));
  } else if (input.reach_decision.validator_admission !== "admit") {
    issues.push(makeIssue("warning", "ReachGateRejected", "$.reach_decision.validator_admission", "Reach requires posture change, repositioning, or tool validation.", "Complete reach follow-up before execution."));
  }
}

function applyStabilityGate(input: ManipulationPrimitiveFeasibilityInput, issues: ValidationIssue[]): void {
  if (!requiresStabilityGate(input.primitive)) {
    return;
  }
  if (input.stability_decision === undefined) {
    issues.push(makeIssue("warning", "StabilityGateRejected", "$.stability_decision", "Manipulation primitive has no stability decision.", "Evaluate body stability before manipulation admission."));
    return;
  }
  if (input.stability_decision.validator_admission === "safe_hold" || input.stability_decision.safe_hold_required) {
    issues.push(makeIssue("error", "StabilityGateRejected", "$.stability_decision", "Stability policy requires safe-hold.", "Stabilize before manipulation."));
  } else if (input.stability_decision.validator_admission === "reject") {
    issues.push(makeIssue("error", "StabilityGateRejected", "$.stability_decision", "Stability policy rejected this manipulation state.", "Reposition or choose a safer posture."));
  } else if (input.stability_decision.validator_admission === "admit_with_speed_limit") {
    issues.push(makeIssue("warning", "StabilityGateRejected", "$.stability_decision", "Stability policy requires speed or posture constraints.", "Apply stability speed scale."));
  }
}

function applyContactGate(input: ManipulationPrimitiveFeasibilityInput, issues: ValidationIssue[]): void {
  if (!requiresContactGate(input.primitive)) {
    return;
  }
  if (input.contact_evidence === undefined) {
    issues.push(makeIssue("warning", "ContactGateRejected", "$.contact_evidence", "Primitive needs tactile evidence but none is available.", "Acquire contact evidence before execution."));
    return;
  }
  if (!input.contact_evidence.ok) {
    issues.push(makeIssue("error", "ContactGateRejected", "$.contact_evidence", "Contact evidence report contains blocking issues.", "Resolve tactile issues before manipulation."));
  }
  if ((input.primitive === "grasp" || input.primitive === "lift" || input.primitive === "carry") && input.contact_evidence.manipulation_contact_count === 0) {
    issues.push(makeIssue("warning", "ContactGateRejected", "$.contact_evidence.manipulation_contact_count", "No manipulation contact is confirmed for grasp/lift/carry.", "Confirm grasp contact before lifting or carrying."));
  }
}

function applyActuatorGate(input: ManipulationPrimitiveFeasibilityInput, issues: ValidationIssue[]): void {
  if (input.actuator_report === undefined) {
    return;
  }
  if (!input.actuator_report.ok) {
    issues.push(makeIssue("error", "ActuatorGateRejected", "$.actuator_report", "Actuator command report rejected or safe-held the requested command.", "Reduce command or choose another primitive."));
  } else if (input.actuator_report.decision === "clipped") {
    issues.push(makeIssue("warning", "ActuatorGateRejected", "$.actuator_report.decision", "Actuator command was clipped to a limit.", "Use conservative force, speed, or trajectory constraints."));
  }
}

function applyToolGate(input: ManipulationPrimitiveFeasibilityInput, capability: ManipulationCapabilityDescriptor | undefined, issues: ValidationIssue[]): void {
  if (input.primitive !== "tool_use") {
    return;
  }
  if (capability !== undefined && !capability.supported_primitives.includes("tool_use")) {
    issues.push(makeIssue("error", "ToolValidationRequired", "$.primitive", "This end effector does not support tool use.", "Choose a tool-capable effector."));
  }
  if (input.tool_attachment_validated !== true) {
    issues.push(makeIssue("warning", "ToolValidationRequired", "$.tool_attachment_validated", "Tool use requires validated task-scoped attachment or contact.", "Validate tool attachment before execution."));
  }
}

function applyOcclusionGate(input: ManipulationPrimitiveFeasibilityInput, capability: ManipulationCapabilityDescriptor | undefined, issues: ValidationIssue[]): void {
  if (capability === undefined) {
    return;
  }
  if ((input.primitive === "grasp" || input.primitive === "place" || input.primitive === "release" || input.primitive === "tool_use") && capability.occlusion_risk === "high" && input.verification_view_available !== true) {
    issues.push(makeIssue("warning", "OcclusionRiskHigh", "$.verification_view_available", "Primitive has high occlusion risk and no alternate verification view is confirmed.", "Use alternate camera/contact verification."));
  }
}

function chooseAdmission(input: ManipulationPrimitiveFeasibilityInput, issues: readonly ValidationIssue[]): ManipulationAdmission {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "StabilityGateRejected")) {
    return "safe_hold";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "reject";
  }
  if (issues.some((issue) => issue.code === "ReachGateRejected" && issue.message.includes("perception")) || input.reach_decision?.decision === "UnknownDueToPerception") {
    return "reobserve";
  }
  if (input.reach_decision?.decision === "ReachableAfterReposition") {
    return "reposition";
  }
  if (input.primitive === "tool_use" && input.tool_attachment_validated !== true) {
    return "tool_validation_required";
  }
  if (issues.length > 0 || input.stability_decision?.validator_admission === "admit_with_speed_limit") {
    return "admit_with_constraints";
  }
  return "admit";
}

function classifyRisk(input: ManipulationPrimitiveFeasibilityInput, capability: ManipulationCapabilityDescriptor | undefined, issues: readonly ValidationIssue[]): ManipulationRiskClass {
  if (issues.some((issue) => issue.severity === "error")) {
    return "blocked";
  }
  if (capability?.failure_modes.includes("crush") === true && input.object_fragility === "fragile") {
    return "high";
  }
  if (input.primitive === "tool_use" || input.primitive === "lift" || input.primitive === "carry" || capability?.occlusion_risk === "high") {
    return issues.length > 0 ? "high" : "medium";
  }
  if (issues.length > 0 || capability?.occlusion_risk === "medium") {
    return "medium";
  }
  return "low";
}

function chooseForceProfile(input: ManipulationPrimitiveFeasibilityInput, capability: ManipulationCapabilityDescriptor | undefined, risk: ManipulationRiskClass): ManipulationForceProfile {
  if (input.primitive === "inspect" || input.primitive === "approach") {
    return "inspect_only";
  }
  if (input.primitive === "retreat" || input.primitive === "release") {
    return "retreat";
  }
  if (input.primitive === "tool_use" || input.primitive === "push" || input.primitive === "pull") {
    return "tool_contact";
  }
  if (input.object_fragility === "fragile" || capability?.failure_modes.includes("crush") === true) {
    return "gentle";
  }
  if (risk === "high" || risk === "blocked") {
    return "cautious";
  }
  return "normal";
}

function computeSpeedScale(input: ManipulationPrimitiveFeasibilityInput, risk: ManipulationRiskClass, profile: ManipulationForceProfile): number {
  if (risk === "blocked") {
    return 0;
  }
  let scale = input.stability_decision?.speed_scale ?? 1;
  if (risk === "high") {
    scale *= 0.35;
  } else if (risk === "medium") {
    scale *= 0.6;
  }
  if (profile === "gentle" || profile === "tool_contact") {
    scale *= 0.55;
  }
  if (input.primitive === "carry") {
    scale *= 0.5;
  }
  return clamp(scale, 0, 1);
}

function requiredFollowup(admission: ManipulationAdmission, input: ManipulationPrimitiveFeasibilityInput, issues: readonly ValidationIssue[]): ManipulationPrimitiveFeasibilityReport["required_followup"] {
  const followups = new Set<ManipulationPrimitiveFeasibilityReport["required_followup"][number]>();
  if (admission === "reobserve" || issues.some((issue) => issue.code === "OcclusionRiskHigh")) {
    followups.add("reobserve");
  }
  if (admission === "reposition" || input.reach_decision?.decision === "ReachableAfterReposition") {
    followups.add("reposition");
  }
  if (admission === "tool_validation_required" || issues.some((issue) => issue.code === "ToolValidationRequired")) {
    followups.add("validate_tool");
  }
  if (admission === "safe_hold" || issues.some((issue) => issue.code === "StabilityGateRejected")) {
    followups.add("stabilize");
  }
  if (issues.some((issue) => issue.code === "ActuatorGateRejected" || issue.code === "ContactGateRejected")) {
    followups.add("reduce_force");
  }
  if (issues.some((issue) => issue.code === "OcclusionRiskHigh")) {
    followups.add("alternate_view");
  }
  if (admission === "reject") {
    followups.add("human_review");
  }
  return freezeArray([...followups].sort());
}

function buildPrimitiveSummary(kind: EmbodimentKind, input: ManipulationPrimitiveFeasibilityInput, admission: ManipulationAdmission, risk: ManipulationRiskClass, forceProfile: ManipulationForceProfile): string {
  return `${kind} ${input.end_effector_role} ${input.primitive} is ${admission} with ${risk} risk and ${forceProfile} force profile.`;
}

function requiresReachGate(primitive: ManipulationPrimitive): boolean {
  return primitive !== "inspect" && primitive !== "release";
}

function requiresStabilityGate(primitive: ManipulationPrimitive): boolean {
  return primitive === "grasp" || primitive === "lift" || primitive === "carry" || primitive === "place" || primitive === "push" || primitive === "pull" || primitive === "tool_use";
}

function requiresContactGate(primitive: ManipulationPrimitive): boolean {
  return primitive === "grasp" || primitive === "lift" || primitive === "carry" || primitive === "push" || primitive === "pull" || primitive === "tool_use";
}

function contactRoleMatchesEffector(contactRole: string, effectorRole: EndEffectorRole): boolean {
  if (effectorRole === "mouth_gripper") {
    return contactRole === "mouth" || contactRole === "gripper";
  }
  if (effectorRole === "paw" || effectorRole === "forelimb") {
    return contactRole === "paw" || contactRole === "hand";
  }
  if (effectorRole === "left_hand" || effectorRole === "right_hand" || effectorRole === "both_hands" || effectorRole === "wrist") {
    return contactRole === "hand" || contactRole === "fingertip" || contactRole === "gripper";
  }
  return contactRole === "tool";
}

function highestPrecision(values: readonly PrecisionRating[]): PrecisionRating {
  if (values.some((value) => value === "high")) {
    return "high";
  }
  if (values.some((value) => value === "medium")) {
    return "medium";
  }
  return "low";
}

function highestOcclusion(values: readonly ManipulationCapabilityDescriptor["occlusion_risk"][]): ManipulationCapabilityDescriptor["occlusion_risk"] {
  if (values.some((value) => value === "high")) {
    return "high";
  }
  if (values.some((value) => value === "medium")) {
    return "medium";
  }
  return "low";
}

function precisionRank(value: PrecisionRating): number {
  if (value === "high") {
    return 3;
  }
  if (value === "medium") {
    return 2;
  }
  return 1;
}

function maxOf(values: readonly number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? undefined : Math.max(...finite);
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: ManipulationCapabilityIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-safe reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference appears to contain forbidden simulator or QA detail.", "Use declared body capability refs only."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new ManipulationCapabilityCatalogError("Invalid manipulation capability reference.", issues);
  }
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray([
    "backend_handles",
    "collision_mesh_refs",
    "exact_world_pose",
    "hidden_object_coordinates",
    "qa_truth_labels",
  ]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new ManipulationCapabilityCatalogError("Cognitive manipulation summary contains forbidden body detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.prompt_safe_summary", "Summary contains forbidden simulator or QA detail.", "Sanitize exact internals before exposing manipulation summaries."),
    ]);
  }
}

function makeIssue(severity: ValidationSeverity, code: ManipulationCapabilityIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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

export const MANIPULATION_CAPABILITY_CATALOG_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MANIPULATION_CAPABILITY_CATALOG_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.8", "5.9", "5.11", "5.12", "5.13", "5.14", "5.15", "5.19", "5.20"]),
});
