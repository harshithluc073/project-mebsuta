/**
 * Stability policy service for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.12, 5.15, 5.16, 5.19, and 5.20.
 *
 * This service evaluates body-specific balance before reach, lift, carry,
 * placement, locomotion, and tool-use motions. It uses only declared
 * embodiment frames, nominal support contacts, contact confidence,
 * body-relative center-of-mass estimates, carried load estimates, and base
 * tilt summaries. Exact hidden COM, simulator world pose, collision geometry,
 * backend handles, and QA truth are never exposed in cognitive summaries.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type {
  ContactSiteDescriptor,
  EmbodimentDescriptor,
  LocomotionPrimitive,
  ManipulationPrimitive,
  MarginClass,
  StabilityPolicyDescriptor,
  StabilityState,
} from "./embodiment_model_registry";

export const STABILITY_POLICY_SERVICE_SCHEMA_VERSION = "mebsuta.stability_policy_service.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|hidden_com)/i;

export type StabilityPlannedMotion = "observe" | "reach" | "lift" | "carry" | "place" | "turn" | "walk" | "tool_use" | "safe_hold";
export type SupportContactRole = ContactSiteDescriptor["contact_role"];
export type BaseTiltClass = "normal" | "warning" | "critical";
export type LoadShiftClass = "none" | "low" | "medium" | "high";
export type StabilityRecommendedAction = "continue" | "slow" | "reposition" | "crouch" | "safe_hold" | "re_observe";
export type StabilityAdmission = "admit" | "admit_with_speed_limit" | "reject" | "safe_hold";

export type StabilityPolicyIssueCode =
  | "ActiveEmbodimentMissing"
  | "StabilityPolicyMissing"
  | "StanceStateInvalid"
  | "ContactStateInvalid"
  | "ContactInsufficient"
  | "ContactConfidenceLow"
  | "ContactSiteMissing"
  | "COMMarginCritical"
  | "COMMarginLow"
  | "BaseTiltCritical"
  | "BaseTiltWarning"
  | "LoadTooHigh"
  | "LoadShiftWarning"
  | "MotionRequiresBrace"
  | "StabilityUnknown"
  | "ForbiddenBodyDetail";

export interface StabilityPolicyServiceConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface StanceState {
  readonly stance_ref: Ref;
  readonly posture_class?: "neutral" | "wide" | "crouch" | "lean" | "stepping" | "tool_brace" | "safe_hold";
  readonly expected_support_contact_refs?: readonly Ref[];
  readonly stance_width_m?: number;
  readonly gait_phase?: "static" | "single_support" | "double_support" | "quad_support" | "transition";
  readonly confidence?: number;
}

export interface SupportContactEvidence {
  readonly contact_ref: Ref;
  readonly contact_role?: SupportContactRole;
  readonly position_in_base_frame_m: Vector3;
  readonly confidence: number;
  readonly normal_force_n?: number;
  readonly slip_risk?: number;
  readonly is_support_contact?: boolean;
}

export interface CarriedLoadEstimate {
  readonly load_ref?: Ref;
  readonly mass_kg: number;
  readonly center_offset_from_base_m?: Vector3;
  readonly confidence: number;
  readonly held_by?: "mouth" | "paw" | "left_hand" | "right_hand" | "both_hands" | "tool" | "body";
}

export interface PlannedMotionContext {
  readonly motion: StabilityPlannedMotion;
  readonly primitive_ref?: Ref;
  readonly expected_speed_m_per_s?: number;
  readonly manipulation_primitive?: ManipulationPrimitive;
  readonly locomotion_primitive?: LocomotionPrimitive;
  readonly requires_body_lean?: boolean;
  readonly lean_angle_rad?: number;
  readonly tool_velocity_m_per_s?: number;
}

export interface StabilityEvaluationInput {
  readonly active_embodiment_ref?: Ref;
  readonly stance_state: StanceState;
  readonly contact_state: readonly SupportContactEvidence[];
  readonly carried_load_estimate?: CarriedLoadEstimate;
  readonly planned_motion: StabilityPlannedMotion | PlannedMotionContext;
  readonly base_tilt_roll_pitch_rad?: readonly [number, number];
  readonly center_of_mass_estimate_m?: Vector3;
}

export interface SupportContactSummary {
  readonly declared_nominal_support_count: number;
  readonly observed_contact_count: number;
  readonly reliable_support_contact_count: number;
  readonly expected_support_contact_count: number;
  readonly missing_expected_support_count: number;
  readonly average_contact_confidence: number;
  readonly maximum_slip_risk: number;
  readonly support_summary_text: string;
}

export interface SupportGeometryReport {
  readonly support_region_kind: "polygon" | "biped_stance_region" | "line_or_point" | "unknown";
  readonly support_polygon_area_m2: number;
  readonly support_span_m: number;
  readonly center_margin_m: number;
  readonly projected_com_inside_support: boolean;
  readonly reliable_contact_refs: readonly Ref[];
}

export interface StabilityDecision {
  readonly schema_version: typeof STABILITY_POLICY_SERVICE_SCHEMA_VERSION;
  readonly decision_id: Ref;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly stability_policy_ref: Ref;
  readonly stance_ref: Ref;
  readonly planned_motion: StabilityPlannedMotion;
  readonly stability_state: StabilityState;
  readonly support_contact_summary: SupportContactSummary;
  readonly support_geometry: SupportGeometryReport;
  readonly com_margin_class: MarginClass;
  readonly base_tilt_class: BaseTiltClass;
  readonly load_shift_class: LoadShiftClass;
  readonly recommended_action: StabilityRecommendedAction;
  readonly validator_admission: StabilityAdmission;
  readonly safe_hold_required: boolean;
  readonly speed_scale: number;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface StabilityBatchEvaluationInput {
  readonly active_embodiment_ref?: Ref;
  readonly scenarios: readonly StabilityEvaluationInput[];
}

export interface StabilityBatchEvaluationReport {
  readonly schema_version: typeof STABILITY_POLICY_SERVICE_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly scenario_count: number;
  readonly admitted_count: number;
  readonly limited_count: number;
  readonly rejected_count: number;
  readonly safe_hold_count: number;
  readonly decisions: readonly StabilityDecision[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveStabilitySummary {
  readonly schema_version: typeof STABILITY_POLICY_SERVICE_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly stability_state: StabilityState;
  readonly com_margin_class: MarginClass;
  readonly base_tilt_class: BaseTiltClass;
  readonly load_shift_class: LoadShiftClass;
  readonly recommended_action: StabilityRecommendedAction;
  readonly summary: string;
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export class StabilityPolicyServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "StabilityPolicyServiceError";
    this.issues = issues;
  }
}

/**
 * Evaluates support contacts, projected COM margin, base tilt, load shift, and
 * motion-specific balance gates for the active quadruped or humanoid model.
 */
export class StabilityPolicyService {
  private readonly registry: EmbodimentModelRegistry;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: StabilityPolicyServiceConfig = {}) {
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
   * Selects the embodiment whose stability policy will be used by default.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Implements `evaluateEmbodimentStability(activeEmbodimentRef, stanceState,
   * contactState, carriedLoadEstimate, plannedMotion) -> StabilityDecision`.
   */
  public evaluateEmbodimentStability(input: StabilityEvaluationInput): StabilityDecision {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const motion = normalizePlannedMotion(input.planned_motion);
    const issues: ValidationIssue[] = [];

    validateSafeRef(input.stance_state.stance_ref, "$.stance_state.stance_ref", issues, "StanceStateInvalid");
    validateFiniteOptional(input.stance_state.stance_width_m, "$.stance_state.stance_width_m", issues, "StanceStateInvalid", 0);
    validateUnitInterval(input.stance_state.confidence, "$.stance_state.confidence", issues, "StanceStateInvalid");
    validateMotionContext(input.planned_motion, issues);
    validateLoad(input.carried_load_estimate, model, issues);

    const contactSummary = summarizeContacts(model, input.stance_state, input.contact_state, motion.motion, issues);
    const reliableContacts = filterReliableContacts(model, input.contact_state, motion.motion);
    const projectedCom = input.center_of_mass_estimate_m ?? computeBodyRelativeCom(model, input.carried_load_estimate);
    const supportGeometry = buildSupportGeometry(model, input.stance_state, reliableContacts, projectedCom);
    const baseTiltClass = classifyBaseTilt(model.stability_policy, input.base_tilt_roll_pitch_rad, motion);
    const loadShiftClass = classifyLoadShift(model, input.carried_load_estimate);
    const comMarginClass = classifyComMargin(model.stability_policy, supportGeometry.center_margin_m, supportGeometry.support_region_kind, contactSummary.reliable_support_contact_count);

    addMotionSpecificIssues(model, motion, input.stance_state, contactSummary, supportGeometry, comMarginClass, baseTiltClass, loadShiftClass, issues);

    const stabilityState = classifyStabilityState(model, motion.motion, contactSummary, supportGeometry, comMarginClass, baseTiltClass, loadShiftClass, issues);
    const recommendedAction = chooseRecommendedAction(model, motion, stabilityState, comMarginClass, baseTiltClass, loadShiftClass, contactSummary);
    const validatorAdmission = chooseAdmission(stabilityState, recommendedAction, issues);
    const speedScale = computeSpeedScale(model, motion, stabilityState, comMarginClass, loadShiftClass, baseTiltClass);
    const hiddenFields = hiddenFieldsRemoved(input);
    const safeSummary = sanitizeText(buildPromptSafeSummary(model, motion, stabilityState, contactSummary, comMarginClass, baseTiltClass, loadShiftClass, recommendedAction));
    assertNoForbiddenLeak(safeSummary);

    const base = {
      schema_version: STABILITY_POLICY_SERVICE_SCHEMA_VERSION,
      decision_id: `stability_${model.embodiment_id}_${computeDeterminismHash({
        stance: input.stance_state,
        motion,
        contactSummary,
        supportGeometry,
        comMarginClass,
        baseTiltClass,
        loadShiftClass,
      }).slice(0, 12)}`,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      stability_policy_ref: model.stability_policy.stability_policy_ref,
      stance_ref: input.stance_state.stance_ref,
      planned_motion: motion.motion,
      stability_state: stabilityState,
      support_contact_summary: contactSummary,
      support_geometry: supportGeometry,
      com_margin_class: comMarginClass,
      base_tilt_class: baseTiltClass,
      load_shift_class: loadShiftClass,
      recommended_action: recommendedAction,
      validator_admission: validatorAdmission,
      safe_hold_required: validatorAdmission === "safe_hold" || recommendedAction === "safe_hold",
      speed_scale: round6(speedScale),
      prompt_safe_summary: safeSummary,
      hidden_fields_removed: hiddenFields,
      issues: freezeArray(issues),
      ok: validatorAdmission === "admit" || validatorAdmission === "admit_with_speed_limit",
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates a batch of candidate motion states and preserves per-scenario
   * decisions for validators, QA, and control admission.
   */
  public evaluateBatch(input: StabilityBatchEvaluationInput): StabilityBatchEvaluationReport {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const decisions = input.scenarios.map((scenario) => this.evaluateEmbodimentStability({
      ...scenario,
      active_embodiment_ref: scenario.active_embodiment_ref ?? model.embodiment_id,
    }));
    const issues = freezeArray(decisions.flatMap((decision, index) => decision.issues.map((issue) => Object.freeze({
      ...issue,
      path: `$.scenarios[${index}]${issue.path.startsWith("$") ? issue.path.slice(1) : `.${issue.path}`}`,
    }))));
    const base = {
      schema_version: STABILITY_POLICY_SERVICE_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      scenario_count: decisions.length,
      admitted_count: decisions.filter((decision) => decision.validator_admission === "admit").length,
      limited_count: decisions.filter((decision) => decision.validator_admission === "admit_with_speed_limit").length,
      rejected_count: decisions.filter((decision) => decision.validator_admission === "reject").length,
      safe_hold_count: decisions.filter((decision) => decision.validator_admission === "safe_hold").length,
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
   * Converts a decision into the Gemini-safe stability summary allowed by the
   * embodiment prompt contract.
   */
  public buildCognitiveStabilitySummary(decision: StabilityDecision): CognitiveStabilitySummary {
    const hiddenFields = freezeArray([...decision.hidden_fields_removed, "support_geometry.reliable_contact_refs", "support_geometry.center_margin_m"]);
    const summary = sanitizeText(decision.prompt_safe_summary);
    assertNoForbiddenLeak(summary);
    const base = {
      schema_version: STABILITY_POLICY_SERVICE_SCHEMA_VERSION,
      embodiment_ref: decision.embodiment_ref,
      embodiment_kind: decision.embodiment_kind,
      stability_state: decision.stability_state,
      com_margin_class: decision.com_margin_class,
      base_tilt_class: decision.base_tilt_class,
      load_shift_class: decision.load_shift_class,
      recommended_action: decision.recommended_action,
      summary,
      forbidden_detail_report_ref: `stability_hidden_${computeDeterminismHash({ decision_id: decision.decision_id, hiddenFields }).slice(0, 12)}`,
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
      throw new StabilityPolicyServiceError("No active embodiment is registered for stability evaluation.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before stability evaluation."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createStabilityPolicyService(config: StabilityPolicyServiceConfig = {}): StabilityPolicyService {
  return new StabilityPolicyService(config);
}

function normalizePlannedMotion(input: StabilityEvaluationInput["planned_motion"]): PlannedMotionContext {
  if (typeof input === "string") {
    return Object.freeze({ motion: input });
  }
  return Object.freeze({ ...input });
}

function validateMotionContext(input: StabilityEvaluationInput["planned_motion"], issues: ValidationIssue[]): void {
  if (typeof input === "string") {
    return;
  }
  validateSafeRef(input.primitive_ref, "$.planned_motion.primitive_ref", issues, "StanceStateInvalid");
  validateFiniteOptional(input.expected_speed_m_per_s, "$.planned_motion.expected_speed_m_per_s", issues, "StanceStateInvalid", 0);
  validateFiniteOptional(input.lean_angle_rad, "$.planned_motion.lean_angle_rad", issues, "StanceStateInvalid", 0);
  validateFiniteOptional(input.tool_velocity_m_per_s, "$.planned_motion.tool_velocity_m_per_s", issues, "StanceStateInvalid", 0);
}

function validateLoad(load: CarriedLoadEstimate | undefined, model: EmbodimentDescriptor, issues: ValidationIssue[]): void {
  if (load === undefined) {
    return;
  }
  validateSafeRef(load.load_ref, "$.carried_load_estimate.load_ref", issues, "LoadShiftWarning");
  validateVector3Optional(load.center_offset_from_base_m, "$.carried_load_estimate.center_offset_from_base_m", issues, "LoadShiftWarning");
  validateUnitInterval(load.confidence, "$.carried_load_estimate.confidence", issues, "LoadShiftWarning");
  if (!Number.isFinite(load.mass_kg) || load.mass_kg < 0) {
    issues.push(makeIssue("error", "LoadTooHigh", "$.carried_load_estimate.mass_kg", "Carried load mass must be finite and non-negative.", "Use a sensor-derived load estimate in kilograms."));
  } else if (load.mass_kg > model.stability_policy.max_carried_load_kg) {
    issues.push(makeIssue("error", "LoadTooHigh", "$.carried_load_estimate.mass_kg", "Carried load exceeds the declared stability policy maximum.", "Set the object down, split the load, or request help."));
  } else if (load.mass_kg >= model.stability_policy.max_carried_load_kg * model.safety_margin_policy.load_warning_fraction) {
    issues.push(makeIssue("warning", "LoadShiftWarning", "$.carried_load_estimate.mass_kg", "Carried load is large enough to affect balance.", "Slow the motion and keep the load close to the body."));
  }
}

function summarizeContacts(
  model: EmbodimentDescriptor,
  stance: StanceState,
  contacts: readonly SupportContactEvidence[],
  motion: StabilityPlannedMotion,
  issues: ValidationIssue[],
): SupportContactSummary {
  if (contacts.length === 0) {
    issues.push(makeIssue("error", "ContactInsufficient", "$.contact_state", "No support contact evidence is available.", "Re-observe contact sensors before moving."));
  }
  const declaredContactRefs = new Set(model.contact_sites.map((site) => site.contact_site_ref));
  const nominalSupportRefs = new Set(model.stability_policy.nominal_support_contact_refs);
  const expectedRefs = new Set(stance.expected_support_contact_refs ?? model.stability_policy.nominal_support_contact_refs);
  let confidenceSum = 0;
  let maximumSlipRisk = 0;
  let reliableSupportCount = 0;
  for (const [index, contact] of contacts.entries()) {
    const path = `$.contact_state[${index}]`;
    validateSafeRef(contact.contact_ref, `${path}.contact_ref`, issues, "ContactStateInvalid");
    validateVector3(contact.position_in_base_frame_m, `${path}.position_in_base_frame_m`, issues, "ContactStateInvalid");
    validateUnitInterval(contact.confidence, `${path}.confidence`, issues, "ContactStateInvalid");
    validateFiniteOptional(contact.normal_force_n, `${path}.normal_force_n`, issues, "ContactStateInvalid", 0);
    validateUnitInterval(contact.slip_risk, `${path}.slip_risk`, issues, "ContactStateInvalid");
    if (!declaredContactRefs.has(contact.contact_ref)) {
      issues.push(makeIssue("warning", "ContactSiteMissing", `${path}.contact_ref`, `Contact ${contact.contact_ref} is not declared by the active embodiment.`, "Use declared contact sites from the embodiment model."));
    }
    const isSupport = contact.is_support_contact ?? nominalSupportRefs.has(contact.contact_ref);
    const isReliable = isSupport && contact.confidence >= model.safety_margin_policy.support_contact_confidence_minimum && (contact.slip_risk ?? 0) < 0.65;
    if (isReliable) {
      reliableSupportCount += 1;
    } else if (isSupport) {
      issues.push(makeIssue("warning", "ContactConfidenceLow", `${path}.confidence`, `Support contact ${contact.contact_ref} is below confidence or slip limits.`, "Re-observe or enter a more stable stance."));
    }
    confidenceSum += clamp(contact.confidence, 0, 1);
    maximumSlipRisk = Math.max(maximumSlipRisk, clamp(contact.slip_risk ?? 0, 0, 1));
  }
  const missingExpected = [...expectedRefs].filter((ref) => !contacts.some((contact) => contact.contact_ref === ref && contact.confidence >= model.safety_margin_policy.support_contact_confidence_minimum));
  if (missingExpected.length > 0) {
    issues.push(makeIssue("warning", "ContactInsufficient", "$.stance_state.expected_support_contact_refs", "One or more expected stance supports are missing reliable contact evidence.", "Re-establish stance or re-observe contact sensors."));
  }
  const required = minimumRequiredSupportContacts(model.embodiment_kind, motion, stance);
  if (reliableSupportCount < required) {
    issues.push(makeIssue("error", "ContactInsufficient", "$.contact_state", `Only ${reliableSupportCount} reliable support contacts are available; ${required} are required for this motion.`, "Choose safe-hold, crouch, widen stance, or re-observe contacts."));
  }
  const text = `${reliableSupportCount}/${Math.max(required, expectedRefs.size)} required supports reliable; ${contacts.length} contacts observed.`;
  return Object.freeze({
    declared_nominal_support_count: model.stability_policy.nominal_support_contact_refs.length,
    observed_contact_count: contacts.length,
    reliable_support_contact_count: reliableSupportCount,
    expected_support_contact_count: expectedRefs.size,
    missing_expected_support_count: missingExpected.length,
    average_contact_confidence: round6(contacts.length === 0 ? 0 : confidenceSum / contacts.length),
    maximum_slip_risk: round6(maximumSlipRisk),
    support_summary_text: sanitizeText(text),
  });
}

function filterReliableContacts(model: EmbodimentDescriptor, contacts: readonly SupportContactEvidence[], motion: StabilityPlannedMotion): readonly SupportContactEvidence[] {
  const nominalSupportRefs = new Set(model.stability_policy.nominal_support_contact_refs);
  const threshold = motion === "safe_hold"
    ? Math.max(0.35, model.safety_margin_policy.support_contact_confidence_minimum - 0.15)
    : model.safety_margin_policy.support_contact_confidence_minimum;
  return freezeArray(contacts.filter((contact) => {
    const isSupport = contact.is_support_contact ?? nominalSupportRefs.has(contact.contact_ref);
    return isSupport && contact.confidence >= threshold && (contact.slip_risk ?? 0) < 0.65;
  }).sort((a, b) => a.contact_ref.localeCompare(b.contact_ref)));
}

function buildSupportGeometry(
  model: EmbodimentDescriptor,
  stance: StanceState,
  reliableContacts: readonly SupportContactEvidence[],
  projectedCom: Vector3,
): SupportGeometryReport {
  const supportPoints = reliableContacts.map((contact) => contact.position_in_base_frame_m);
  if (supportPoints.length >= 3) {
    const hull = convexHull2D(supportPoints);
    const area = polygonArea2D(hull);
    const inside = pointInPolygon2D(projectedCom, hull);
    const margin = signedDistanceToPolygon(projectedCom, hull, inside);
    return Object.freeze({
      support_region_kind: "polygon",
      support_polygon_area_m2: round6(area),
      support_span_m: round6(maxPairwiseDistance2D(hull)),
      center_margin_m: round6(margin),
      projected_com_inside_support: inside,
      reliable_contact_refs: freezeArray(reliableContacts.map((contact) => contact.contact_ref)),
    });
  }
  if (model.embodiment_kind === "humanoid" && supportPoints.length === 2) {
    const stanceRadius = Math.max(model.stability_policy.support_polygon_margin_m, (stance.stance_width_m ?? 0.18) * 0.5, 0.04);
    const distance = distancePointToSegment2D(projectedCom, supportPoints[0], supportPoints[1]);
    const margin = stanceRadius - distance;
    const span = distance2D(supportPoints[0], supportPoints[1]);
    return Object.freeze({
      support_region_kind: "biped_stance_region",
      support_polygon_area_m2: round6(Math.PI * stanceRadius * stanceRadius + 2 * stanceRadius * span),
      support_span_m: round6(span),
      center_margin_m: round6(margin),
      projected_com_inside_support: margin >= 0,
      reliable_contact_refs: freezeArray(reliableContacts.map((contact) => contact.contact_ref)),
    });
  }
  return Object.freeze({
    support_region_kind: supportPoints.length > 0 ? "line_or_point" : "unknown",
    support_polygon_area_m2: 0,
    support_span_m: round6(maxPairwiseDistance2D(supportPoints)),
    center_margin_m: 0,
    projected_com_inside_support: false,
    reliable_contact_refs: freezeArray(reliableContacts.map((contact) => contact.contact_ref)),
  });
}

function computeBodyRelativeCom(model: EmbodimentDescriptor, load: CarriedLoadEstimate | undefined): Vector3 {
  let totalMass = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedZ = 0;
  for (const body of model.body_masses) {
    totalMass += body.mass_kg;
    weightedX += body.local_center_of_mass_m[0] * body.mass_kg;
    weightedY += body.local_center_of_mass_m[1] * body.mass_kg;
    weightedZ += body.local_center_of_mass_m[2] * body.mass_kg;
  }
  if (load !== undefined && Number.isFinite(load.mass_kg) && load.mass_kg > 0) {
    const offset = load.center_offset_from_base_m ?? Object.freeze([0, 0, model.stability_policy.nominal_center_of_mass_height_m]) as Vector3;
    const trustedMass = load.mass_kg * clamp(load.confidence, 0, 1);
    totalMass += trustedMass;
    weightedX += offset[0] * trustedMass;
    weightedY += offset[1] * trustedMass;
    weightedZ += offset[2] * trustedMass;
  }
  if (totalMass <= EPSILON) {
    return Object.freeze([0, 0, model.stability_policy.nominal_center_of_mass_height_m]) as Vector3;
  }
  return Object.freeze([weightedX / totalMass, weightedY / totalMass, weightedZ / totalMass]) as Vector3;
}

function classifyComMargin(policy: StabilityPolicyDescriptor, margin: number, regionKind: SupportGeometryReport["support_region_kind"], reliableContactCount: number): MarginClass {
  if (regionKind === "unknown" || reliableContactCount === 0 || !Number.isFinite(margin)) {
    return "unknown";
  }
  if (margin <= policy.critical_support_margin_m) {
    return "critical";
  }
  if (margin <= policy.support_polygon_margin_m) {
    return "low";
  }
  return "safe";
}

function classifyBaseTilt(policy: StabilityPolicyDescriptor, rollPitch: readonly [number, number] | undefined, motion: PlannedMotionContext): BaseTiltClass {
  const measuredTilt = Math.hypot(rollPitch?.[0] ?? 0, rollPitch?.[1] ?? 0);
  const requestedLean = motion.requires_body_lean === true ? Math.abs(motion.lean_angle_rad ?? 0) : 0;
  const combinedTilt = measuredTilt + requestedLean * 0.5;
  if (combinedTilt >= policy.max_base_tilt_rad) {
    return "critical";
  }
  if (combinedTilt >= policy.warning_base_tilt_rad) {
    return "warning";
  }
  return "normal";
}

function classifyLoadShift(model: EmbodimentDescriptor, load: CarriedLoadEstimate | undefined): LoadShiftClass {
  if (load === undefined || load.mass_kg <= 0 || load.confidence <= 0) {
    return "none";
  }
  const effectiveFraction = (load.mass_kg * clamp(load.confidence, 0, 1)) / Math.max(model.stability_policy.max_carried_load_kg, EPSILON);
  if (effectiveFraction >= model.safety_margin_policy.load_critical_fraction) {
    return "high";
  }
  if (effectiveFraction >= model.safety_margin_policy.load_warning_fraction) {
    return "medium";
  }
  return "low";
}

function addMotionSpecificIssues(
  model: EmbodimentDescriptor,
  motion: PlannedMotionContext,
  stance: StanceState,
  contactSummary: SupportContactSummary,
  geometry: SupportGeometryReport,
  margin: MarginClass,
  tilt: BaseTiltClass,
  load: LoadShiftClass,
  issues: ValidationIssue[],
): void {
  if (margin === "critical" || geometry.projected_com_inside_support === false && geometry.support_region_kind !== "unknown") {
    issues.push(makeIssue("error", "COMMarginCritical", "$.stability.com_margin_class", "Projected center of mass is at or outside the safe support margin.", "Reposition, crouch, widen stance, or enter safe-hold."));
  } else if (margin === "low") {
    issues.push(makeIssue("warning", "COMMarginLow", "$.stability.com_margin_class", "Projected center of mass margin is low.", "Slow the motion and prefer a more stable posture."));
  }
  if (tilt === "critical") {
    issues.push(makeIssue("error", "BaseTiltCritical", "$.base_tilt_roll_pitch_rad", "Base tilt is above the critical stability threshold.", "Enter safe-hold and stabilize the body."));
  } else if (tilt === "warning") {
    issues.push(makeIssue("warning", "BaseTiltWarning", "$.base_tilt_roll_pitch_rad", "Base tilt is near the stability limit.", "Slow or reduce body lean."));
  }
  if (load === "high") {
    issues.push(makeIssue("error", "LoadTooHigh", "$.carried_load_estimate", "Load shift is high for the declared body stability policy.", "Set down the load or use a safer carry posture."));
  }
  if ((motion.motion === "lift" || motion.motion === "carry" || motion.motion === "tool_use") && stance.posture_class !== "wide" && stance.posture_class !== "tool_brace" && stance.posture_class !== "crouch") {
    issues.push(makeIssue("warning", "MotionRequiresBrace", "$.stance_state.posture_class", "This motion should use a brace, wide, or crouched stance.", "Select a body-valid stabilizing stance before execution."));
  }
  if (model.embodiment_kind === "quadruped" && (motion.motion === "reach" || motion.motion === "tool_use") && contactSummary.reliable_support_contact_count < 3) {
    issues.push(makeIssue("error", "ContactInsufficient", "$.contact_state", "Quadruped manipulation requires at least three reliable support contacts.", "Stabilize with paws before manipulation."));
  }
  if (model.embodiment_kind === "humanoid" && (motion.motion === "reach" || motion.motion === "lift" || motion.motion === "tool_use") && contactSummary.reliable_support_contact_count < 2) {
    issues.push(makeIssue("error", "ContactInsufficient", "$.contact_state", "Humanoid manipulation requires both feet or an explicitly validated support phase.", "Widen stance or re-establish foot contacts."));
  }
  if ((motion.expected_speed_m_per_s ?? 0) > model.locomotion_capability.stable_speed_m_per_s && motion.motion !== "safe_hold") {
    issues.push(makeIssue("warning", "MotionRequiresBrace", "$.planned_motion.expected_speed_m_per_s", "Requested speed exceeds stable embodiment speed.", "Use the service speed scale before control execution."));
  }
  if ((motion.tool_velocity_m_per_s ?? 0) > model.locomotion_capability.stable_speed_m_per_s * 0.75 && motion.motion === "tool_use") {
    issues.push(makeIssue("warning", "MotionRequiresBrace", "$.planned_motion.tool_velocity_m_per_s", "Tool motion is fast for a stability-gated tool-use action.", "Limit tool velocity and brace the stance."));
  }
}

function classifyStabilityState(
  model: EmbodimentDescriptor,
  motion: StabilityPlannedMotion,
  contacts: SupportContactSummary,
  geometry: SupportGeometryReport,
  margin: MarginClass,
  tilt: BaseTiltClass,
  load: LoadShiftClass,
  issues: readonly ValidationIssue[],
): StabilityState {
  const required = minimumRequiredSupportContacts(model.embodiment_kind, motion, { stance_ref: model.stability_policy.default_stance_ref });
  if (contacts.reliable_support_contact_count < required || geometry.support_region_kind === "unknown" || margin === "unknown") {
    return "unknown";
  }
  if (issues.some((issue) => issue.severity === "error") || margin === "critical" || tilt === "critical" || load === "high") {
    return "unstable";
  }
  if (issues.length > 0 || margin === "low" || tilt === "warning" || load === "medium" || contacts.maximum_slip_risk > 0.35) {
    return "marginal";
  }
  return "stable";
}

function chooseRecommendedAction(
  model: EmbodimentDescriptor,
  motion: PlannedMotionContext,
  state: StabilityState,
  margin: MarginClass,
  tilt: BaseTiltClass,
  load: LoadShiftClass,
  contacts: SupportContactSummary,
): StabilityRecommendedAction {
  if (state === "unstable" || tilt === "critical" || load === "high") {
    return "safe_hold";
  }
  if (state === "unknown") {
    return "re_observe";
  }
  if (margin === "critical") {
    return model.stability_policy.prefers_low_center_of_mass ? "crouch" : "reposition";
  }
  if (state === "marginal") {
    if (motion.motion === "walk" || motion.motion === "turn" || contacts.maximum_slip_risk > 0.35) {
      return "slow";
    }
    if (model.stability_policy.prefers_low_center_of_mass && (motion.motion === "reach" || motion.motion === "lift" || motion.motion === "tool_use")) {
      return "crouch";
    }
    return "reposition";
  }
  if ((motion.motion === "carry" || motion.motion === "tool_use") && load === "medium") {
    return "slow";
  }
  return "continue";
}

function chooseAdmission(state: StabilityState, action: StabilityRecommendedAction, issues: readonly ValidationIssue[]): StabilityAdmission {
  if (action === "safe_hold") {
    return "safe_hold";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "reject";
  }
  if (state === "marginal" || action === "slow" || action === "crouch" || action === "reposition") {
    return "admit_with_speed_limit";
  }
  if (state === "unknown") {
    return "reject";
  }
  return "admit";
}

function computeSpeedScale(
  model: EmbodimentDescriptor,
  motion: PlannedMotionContext,
  state: StabilityState,
  margin: MarginClass,
  load: LoadShiftClass,
  tilt: BaseTiltClass,
): number {
  if (state === "unstable" || state === "unknown") {
    return 0;
  }
  let scale = 1;
  if (state === "marginal") {
    scale *= 0.45;
  }
  if (margin === "low") {
    scale *= 0.65;
  }
  if (load === "medium") {
    scale *= model.locomotion_capability.carry_speed_multiplier;
  } else if (load === "low") {
    scale *= Math.max(0.75, model.locomotion_capability.carry_speed_multiplier);
  }
  if (tilt === "warning") {
    scale *= 0.65;
  }
  if (motion.motion === "tool_use") {
    scale *= 0.55;
  } else if (motion.motion === "lift" || motion.motion === "place") {
    scale *= 0.7;
  }
  return clamp(scale, 0, 1);
}

function buildPromptSafeSummary(
  model: EmbodimentDescriptor,
  motion: PlannedMotionContext,
  state: StabilityState,
  contacts: SupportContactSummary,
  margin: MarginClass,
  tilt: BaseTiltClass,
  load: LoadShiftClass,
  action: StabilityRecommendedAction,
): string {
  const body = model.embodiment_kind === "quadruped" ? "Quadruped" : "Humanoid";
  if (state === "stable") {
    return `${body} stability is acceptable for ${motion.motion}; ${contacts.support_summary_text}; support margin is ${margin}, tilt is ${tilt}, load shift is ${load}.`;
  }
  if (state === "marginal") {
    return `${body} stability is marginal for ${motion.motion}; ${contacts.support_summary_text}; recommended action is ${action}.`;
  }
  if (state === "unknown") {
    return `${body} stability is uncertain for ${motion.motion}; contact evidence should be refreshed before motion continues.`;
  }
  return `${body} stability is unsafe for ${motion.motion}; recommended action is ${action}.`;
}

function minimumRequiredSupportContacts(kind: EmbodimentKind, motion: StabilityPlannedMotion, stance: StanceState): number {
  if (kind === "quadruped") {
    if (motion === "walk" || motion === "turn") {
      return stance.gait_phase === "transition" ? 2 : 3;
    }
    if (motion === "safe_hold") {
      return 3;
    }
    return 3;
  }
  if ((motion === "walk" || motion === "turn") && stance.gait_phase === "single_support") {
    return 1;
  }
  return 2;
}

function convexHull2D(points: readonly Vector3[]): readonly Vector3[] {
  const unique = [...new Map(points.map((point) => [`${round6(point[0])}:${round6(point[1])}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 2) {
    return freezeArray(unique);
  }
  const lower: Vector3[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vector3[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  return freezeArray([...lower.slice(0, -1), ...upper.slice(0, -1)]);
}

function polygonArea2D(points: readonly Vector3[]): number {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return Math.abs(area) / 2;
}

function pointInPolygon2D(point: Vector3, polygon: readonly Vector3[]): boolean {
  if (polygon.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / Math.max(yj - yi, EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function signedDistanceToPolygon(point: Vector3, polygon: readonly Vector3[], inside: boolean): number {
  if (polygon.length < 3) {
    return 0;
  }
  const distance = Math.min(...polygon.map((vertex, index) => distancePointToSegment2D(point, vertex, polygon[(index + 1) % polygon.length])));
  return inside ? distance : -distance;
}

function distancePointToSegment2D(point: Vector3, a: Vector3, b: Vector3): number {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const lengthSquared = abX * abX + abY * abY;
  if (lengthSquared <= EPSILON) {
    return distance2D(point, a);
  }
  const t = clamp(((point[0] - a[0]) * abX + (point[1] - a[1]) * abY) / lengthSquared, 0, 1);
  return Math.hypot(point[0] - (a[0] + t * abX), point[1] - (a[1] + t * abY));
}

function maxPairwiseDistance2D(points: readonly Vector3[]): number {
  let maxDistance = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      maxDistance = Math.max(maxDistance, distance2D(points[i], points[j]));
    }
  }
  return maxDistance;
}

function distance2D(a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function cross2D(origin: Vector3, a: Vector3, b: Vector3): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function validateVector3(value: Vector3, path: string, issues: ValidationIssue[], code: StabilityPolicyIssueCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite numbers.", "Use a body-relative [x, y, z] vector in meters."));
  }
}

function validateVector3Optional(value: Vector3 | undefined, path: string, issues: ValidationIssue[], code: StabilityPolicyIssueCode): void {
  if (value !== undefined) {
    validateVector3(value, path, issues, code);
  }
}

function validateFiniteOptional(value: number | undefined, path: string, issues: ValidationIssue[], code: StabilityPolicyIssueCode, minimum?: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    issues.push(makeIssue("error", code, path, "Numeric field must be finite and inside the allowed range.", "Provide a finite validated estimate."));
  }
}

function validateUnitInterval(value: number | undefined, path: string, issues: ValidationIssue[], code: StabilityPolicyIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", code, path, "Confidence or risk value must be in [0, 1].", "Clamp or recompute the sensor-derived probability."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new StabilityPolicyServiceError("Invalid stability policy reference.", issues);
  }
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: StabilityPolicyIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque embodiment reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference appears to contain forbidden simulator or QA detail.", "Use an opaque body-safe reference."));
  }
}

function hiddenFieldsRemoved(input: StabilityEvaluationInput): readonly string[] {
  const removed = ["exact_hidden_com", "simulator_world_pose", "support_polygon_vertices", "backend_contact_handles"];
  if (input.center_of_mass_estimate_m !== undefined) {
    removed.push("center_of_mass_estimate_m");
  }
  if (input.contact_state.length > 0) {
    removed.push("contact_state.position_in_base_frame_m");
  }
  return freezeArray(removed);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new StabilityPolicyServiceError("Cognitive stability summary contains forbidden body detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.prompt_safe_summary", "Summary contains forbidden simulator or hidden body detail.", "Sanitize exact internals before exposing summaries."),
    ]);
  }
}

function makeIssue(severity: ValidationSeverity, code: StabilityPolicyIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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

export const STABILITY_POLICY_SERVICE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STABILITY_POLICY_SERVICE_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.12", "5.15", "5.16", "5.19", "5.20"]),
});
