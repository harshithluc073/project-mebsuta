/**
 * Contact solver adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.5, 3.12, 3.13, 3.14, 3.16, 3.17.2, 3.18, 3.19, and 3.20,
 * with downstream evidence contracts from files 12, 14, and 16.
 *
 * This adapter converts engine-specific contact manifolds into architecture
 * contact events, impulse summaries, friction-cone diagnostics, acoustic
 * candidates, Oops-ready evidence, and cognitive-safe summaries. Raw body refs,
 * collision shape refs, material coefficients, exact impulse values, and solver
 * diagnostics remain QA/validator/runtime-only simulator truth.
 */

import { MaterialProfileRegistry } from "./material_profile_registry";
import { ObjectPhysicsCatalog } from "./object_physics_catalog";
import { ArticulatedBodyRegistry } from "./articulated_body_registry";
import { computeDeterminismHash } from "./world_manifest";
import type { ContactSiteDescriptor } from "./articulated_body_registry";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "./world_manifest";

export const CONTACT_SOLVER_ADAPTER_SCHEMA_VERSION = "mebsuta.contact_solver_adapter.v1" as const;
const DEFAULT_CONTACT_DT_S = 1 / 240;
const DEFAULT_STATIC_FRICTION = 0.5;
const DEFAULT_DYNAMIC_FRICTION = 0.4;
const DEFAULT_SOLVER_TOLERANCE_M = 0.001;
const DEFAULT_IMPACT_AUDIO_THRESHOLD_N_S = 0.04;
const DEFAULT_HIGH_IMPULSE_THRESHOLD_N_S = 2.5;
const DEFAULT_SAFE_HOLD_IMPULSE_THRESHOLD_N_S = 7.5;
const DEFAULT_SLIP_SPEED_THRESHOLD_M_PER_S = 0.015;

export type ContactClass = "resting_support" | "grasp" | "slip" | "unplanned_collision" | "self_collision" | "stack" | "tool";
export type ContactExpectation = "unknown" | "none" | "resting_support" | "grasp" | "stack" | "tool" | "self_allowed";
export type RelativeMotionSummary = "sticking" | "sliding" | "rolling" | "separating" | "impacting";
export type ImpulseCategory = "none" | "low" | "moderate" | "high" | "impossible";
export type SafetyRelevance = "none" | "monitor" | "warning" | "safe_hold";
export type ContactAcousticClass = "none" | "soft_impact" | "hard_impact" | "scrape" | "slip_sound" | "rolling" | "footstep" | "collision";
export type ContactEndpointKind = "object" | "body" | "tool" | "environment" | "unknown";

export interface EngineContactPoint {
  readonly point_ref?: Ref;
  readonly position_m: Vector3;
  readonly normal_a_to_b: Vector3;
  readonly penetration_depth_m: number;
  readonly normal_impulse_n_s: number;
  readonly tangent_impulse_n_s: number;
  readonly relative_velocity_a_to_b_m_per_s: Vector3;
}

export interface EngineContactManifold {
  readonly manifold_ref: Ref;
  readonly body_a_ref: Ref;
  readonly body_b_ref: Ref;
  readonly endpoint_a_kind?: ContactEndpointKind;
  readonly endpoint_b_kind?: ContactEndpointKind;
  readonly collision_shape_a_ref?: Ref;
  readonly collision_shape_b_ref?: Ref;
  readonly contact_site_a_ref?: Ref;
  readonly contact_site_b_ref?: Ref;
  readonly material_a_ref?: Ref;
  readonly material_b_ref?: Ref;
  readonly expected_contact?: ContactExpectation;
  readonly timestamp_s: number;
  readonly physics_tick: number;
  readonly solver_iteration_count?: number;
  readonly contact_lifetime_s?: number;
  readonly points: readonly EngineContactPoint[];
}

export interface ContactAdapterPolicy {
  readonly contact_dt_s: number;
  readonly impact_audio_threshold_n_s: number;
  readonly high_impulse_threshold_n_s: number;
  readonly safe_hold_impulse_threshold_n_s: number;
  readonly slip_speed_threshold_m_per_s: number;
  readonly impossible_penetration_depth_m: number;
  readonly sustained_contact_lifetime_s: number;
  readonly rolling_tangent_speed_m_per_s: number;
  readonly require_known_materials: boolean;
  readonly allow_unknown_contact_sites: boolean;
}

export interface ContactAdapterContext {
  readonly material_registry: MaterialProfileRegistry;
  readonly object_catalog?: ObjectPhysicsCatalog;
  readonly articulated_registry?: ArticulatedBodyRegistry;
  readonly embodiment_ref?: Ref;
  readonly policy?: Partial<ContactAdapterPolicy>;
}

export interface FrictionConeDiagnostic {
  readonly normal_impulse_n_s: number;
  readonly tangential_impulse_n_s: number;
  readonly static_friction_limit_n_s: number;
  readonly dynamic_friction_limit_n_s: number;
  readonly slip_margin_n_s: number;
  readonly utilization: number;
  readonly cone_half_angle_rad: number;
  readonly regime: "inside_static_cone" | "dynamic_sliding" | "separating" | "degenerate";
  readonly determinism_hash: string;
}

export interface ContactImpulseSummary {
  readonly normal_impulse_n_s: number;
  readonly tangential_impulse_n_s: number;
  readonly estimated_normal_force_n: number;
  readonly estimated_tangential_force_n: number;
  readonly impulse_category: ImpulseCategory;
  readonly peak_penetration_depth_m: number;
  readonly mean_contact_point_m: Vector3;
  readonly effective_restitution: number;
  readonly determinism_hash: string;
}

export interface ContactMaterialPairSummary {
  readonly material_a_ref: Ref;
  readonly material_b_ref: Ref;
  readonly effective_static_friction: number;
  readonly effective_dynamic_friction: number;
  readonly effective_restitution: number;
  readonly solver_tolerance_m: number;
  readonly acoustic_profile_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface AcousticContactCandidate {
  readonly acoustic_candidate_ref: Ref;
  readonly contact_event_id: Ref;
  readonly acoustic_class: ContactAcousticClass;
  readonly intensity: "silent" | "low" | "medium" | "high" | "blocking";
  readonly source_time_s: number;
  readonly prompt_safe_hint: string;
  readonly internal_audio_profile_refs: readonly Ref[];
  readonly cognitive_visibility: "prompt_safe_after_audio_packetization";
  readonly determinism_hash: string;
}

export interface ContactEvent {
  readonly contact_event_id: Ref;
  readonly contact_class: ContactClass;
  readonly timestamp_s: number;
  readonly physics_tick: number;
  readonly contact_sites: readonly Ref[];
  readonly internal_body_refs: readonly Ref[];
  readonly collision_shape_refs: readonly Ref[];
  readonly material_pair: ContactMaterialPairSummary;
  readonly impulse_summary: ContactImpulseSummary;
  readonly relative_motion_summary: RelativeMotionSummary;
  readonly friction_diagnostic: FrictionConeDiagnostic;
  readonly audio_candidate?: AcousticContactCandidate;
  readonly safety_relevance: SafetyRelevance;
  readonly oops_relevance: "none" | "possible_failure_evidence" | "strong_failure_evidence" | "safety_evidence";
  readonly hidden_truth_visibility: "runtime_qa_validator_only";
  readonly determinism_hash: string;
}

export interface ContactEventStream {
  readonly schema_version: typeof CONTACT_SOLVER_ADAPTER_SCHEMA_VERSION;
  readonly stream_ref: Ref;
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly contact_events: readonly ContactEvent[];
  readonly rejected_manifolds: readonly ContactAdapterRejection[];
  readonly safe_hold_recommended: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ContactAdapterRejection {
  readonly manifold_ref: Ref;
  readonly reason_code: ContactAdapterValidationCode;
  readonly message: string;
  readonly remediation: string;
}

export interface CognitiveSafeContactSummary {
  readonly contact_event_id: Ref;
  readonly contact_class: ContactClass;
  readonly timestamp_s: number;
  readonly contact_sites: readonly Ref[];
  readonly impulse_summary: "none" | "low" | "moderate" | "high" | "unsafe";
  readonly relative_motion_summary: RelativeMotionSummary;
  readonly safety_relevance: SafetyRelevance;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export interface ContactOopsEvidence {
  readonly evidence_ref: Ref;
  readonly contact_event_ref: Ref;
  readonly failure_family: "slip" | "drop_or_impact" | "unexpected_collision" | "support_failure" | "tool_contact_issue" | "self_collision" | "none";
  readonly confidence: number;
  readonly evidence_summary: string;
  readonly tactile_contact_refs: readonly Ref[];
  readonly audio_candidate_ref?: Ref;
  readonly safety_relevance: SafetyRelevance;
  readonly determinism_hash: string;
}

export class ContactSolverAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ContactSolverAdapterError";
    this.issues = issues;
  }
}

export class ContactSolverAdapter {
  private readonly policy: ContactAdapterPolicy;

  public constructor(private readonly context: ContactAdapterContext) {
    this.policy = Object.freeze({
      contact_dt_s: context.policy?.contact_dt_s ?? DEFAULT_CONTACT_DT_S,
      impact_audio_threshold_n_s: context.policy?.impact_audio_threshold_n_s ?? DEFAULT_IMPACT_AUDIO_THRESHOLD_N_S,
      high_impulse_threshold_n_s: context.policy?.high_impulse_threshold_n_s ?? DEFAULT_HIGH_IMPULSE_THRESHOLD_N_S,
      safe_hold_impulse_threshold_n_s: context.policy?.safe_hold_impulse_threshold_n_s ?? DEFAULT_SAFE_HOLD_IMPULSE_THRESHOLD_N_S,
      slip_speed_threshold_m_per_s: context.policy?.slip_speed_threshold_m_per_s ?? DEFAULT_SLIP_SPEED_THRESHOLD_M_PER_S,
      impossible_penetration_depth_m: context.policy?.impossible_penetration_depth_m ?? 0.05,
      sustained_contact_lifetime_s: context.policy?.sustained_contact_lifetime_s ?? 0.08,
      rolling_tangent_speed_m_per_s: context.policy?.rolling_tangent_speed_m_per_s ?? 0.08,
      require_known_materials: context.policy?.require_known_materials ?? false,
      allow_unknown_contact_sites: context.policy?.allow_unknown_contact_sites ?? true,
    });
    validatePolicy(this.policy);
  }

  public normalizeContactBatch(input: {
    readonly stream_ref?: Ref;
    readonly physics_tick: number;
    readonly timestamp_s: number;
    readonly manifolds: readonly EngineContactManifold[];
  }): ContactEventStream {
    validateTickAndTimestamp(input.physics_tick, input.timestamp_s);
    const issues: ValidationIssue[] = [];
    const rejected: ContactAdapterRejection[] = [];
    const events: ContactEvent[] = [];

    for (const manifold of [...input.manifolds].sort(compareManifolds)) {
      const validation = validateManifold(manifold);
      if (validation.length > 0) {
        issues.push(...validation);
        rejected.push(...validation.map((issue) => rejectManifold(manifold.manifold_ref, issue.code as ContactAdapterValidationCode, issue.message, issue.remediation)));
        continue;
      }
      try {
        events.push(this.normalizeManifold(manifold));
      } catch (error) {
        const issue = error instanceof ContactSolverAdapterError
          ? error.issues[0]
          : makeIssue("error", "ContactNormalizationFailed", "$.manifold", error instanceof Error ? error.message : "Unknown contact normalization failure.", "Inspect the solver manifold and registry closure.");
        issues.push(issue);
        rejected.push(rejectManifold(manifold.manifold_ref, issue.code as ContactAdapterValidationCode, issue.message, issue.remediation));
      }
    }

    const streamBase = {
      schema_version: CONTACT_SOLVER_ADAPTER_SCHEMA_VERSION,
      stream_ref: input.stream_ref ?? `contact_stream_${input.physics_tick}`,
      physics_tick: input.physics_tick,
      timestamp_s: input.timestamp_s,
      contact_events: freezeArray(events),
      rejected_manifolds: freezeArray(rejected),
      safe_hold_recommended: events.some((event) => event.safety_relevance === "safe_hold"),
      issue_count: issues.length,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...streamBase,
      determinism_hash: computeDeterminismHash(streamBase),
    });
  }

  public normalizeManifold(manifold: EngineContactManifold): ContactEvent {
    const validation = validateManifold(manifold);
    if (validation.length > 0) {
      throw new ContactSolverAdapterError(`Contact manifold ${manifold.manifold_ref} failed validation.`, validation);
    }
    const materialPair = this.resolveMaterialPair(manifold);
    const impulseSummary = computeImpulseSummary(manifold, materialPair, this.policy);
    const relativeMotion = classifyRelativeMotion(manifold, impulseSummary, materialPair, this.policy);
    const frictionDiagnostic = computeFrictionDiagnostic(impulseSummary, materialPair, relativeMotion);
    const contactClass = this.classifyContact(manifold, relativeMotion, impulseSummary, frictionDiagnostic);
    const safetyRelevance = classifySafetyRelevance(contactClass, impulseSummary, frictionDiagnostic, this.policy);
    const contactSites = this.resolveContactSites(manifold);
    const eventId = `contact_${manifold.physics_tick}_${computeDeterminismHash([manifold.manifold_ref, manifold.body_a_ref, manifold.body_b_ref]).slice(0, 10)}`;
    const audioCandidate = this.createAcousticCandidate(eventId, contactClass, relativeMotion, impulseSummary, materialPair, manifold.timestamp_s);
    const eventBase = {
      contact_event_id: eventId,
      contact_class: contactClass,
      timestamp_s: manifold.timestamp_s,
      physics_tick: manifold.physics_tick,
      contact_sites: freezeArray(contactSites),
      internal_body_refs: freezeArray([manifold.body_a_ref, manifold.body_b_ref].sort()),
      collision_shape_refs: freezeArray([manifold.collision_shape_a_ref, manifold.collision_shape_b_ref].filter(isDefined).sort()),
      material_pair: materialPair,
      impulse_summary: impulseSummary,
      relative_motion_summary: relativeMotion,
      friction_diagnostic: frictionDiagnostic,
      audio_candidate: audioCandidate,
      safety_relevance: safetyRelevance,
      oops_relevance: classifyOopsRelevance(contactClass, safetyRelevance, impulseSummary),
      hidden_truth_visibility: "runtime_qa_validator_only" as const,
    };
    return Object.freeze({
      ...eventBase,
      determinism_hash: computeDeterminismHash(eventBase),
    });
  }

  public redactForCognition(event: ContactEvent): CognitiveSafeContactSummary {
    const impulse = event.impulse_summary.impulse_category === "impossible"
      ? "unsafe"
      : event.impulse_summary.impulse_category;
    return Object.freeze({
      contact_event_id: event.contact_event_id,
      contact_class: event.contact_class,
      timestamp_s: event.timestamp_s,
      contact_sites: freezeArray(event.contact_sites),
      impulse_summary: impulse,
      relative_motion_summary: event.relative_motion_summary,
      safety_relevance: event.safety_relevance,
      prompt_safe_summary: buildPromptSafeSummary(event),
      hidden_fields_removed: freezeArray([
        "internal_body_refs",
        "collision_shape_refs",
        "material_pair",
        "friction_diagnostic",
        "normal_impulse_n_s",
        "tangential_impulse_n_s",
        "estimated_normal_force_n",
        "estimated_tangential_force_n",
        "peak_penetration_depth_m",
        "internal_audio_profile_refs",
        "determinism_hash",
      ]),
    });
  }

  public buildOopsEvidence(event: ContactEvent): ContactOopsEvidence {
    const failureFamily = classifyFailureFamily(event);
    const confidence = computeOopsConfidence(event, failureFamily);
    const evidenceBase = {
      evidence_ref: `oops_contact_${event.contact_event_id}`,
      contact_event_ref: event.contact_event_id,
      failure_family: failureFamily,
      confidence,
      evidence_summary: buildOopsEvidenceSummary(event, failureFamily),
      tactile_contact_refs: freezeArray(event.contact_sites),
      audio_candidate_ref: event.audio_candidate?.acoustic_candidate_ref,
      safety_relevance: event.safety_relevance,
    };
    return Object.freeze({
      ...evidenceBase,
      determinism_hash: computeDeterminismHash(evidenceBase),
    });
  }

  private resolveMaterialPair(manifold: EngineContactManifold): ContactMaterialPairSummary {
    const materialA = manifold.material_a_ref ?? this.resolveEndpointMaterial(manifold.body_a_ref, manifold.contact_site_a_ref);
    const materialB = manifold.material_b_ref ?? this.resolveEndpointMaterial(manifold.body_b_ref, manifold.contact_site_b_ref);
    if (materialA !== undefined && materialB !== undefined) {
      const pair = this.context.material_registry.resolveContactPair(materialA, materialB);
      return Object.freeze({
        material_a_ref: pair.material_a_ref,
        material_b_ref: pair.material_b_ref,
        effective_static_friction: pair.effective_static_friction,
        effective_dynamic_friction: pair.effective_dynamic_friction,
        effective_restitution: pair.effective_restitution,
        solver_tolerance_m: pair.solver_tolerance_m,
        acoustic_profile_refs: freezeArray(pair.acoustic_profile_refs),
        determinism_hash: pair.determinism_hash,
      });
    }
    if (this.policy.require_known_materials) {
      throw new ContactSolverAdapterError(`Contact manifold ${manifold.manifold_ref} is missing material refs.`, [
        makeIssue("error", "MaterialRefMissing", "$.material_ref", "Contact material refs could not be resolved.", "Provide material refs on the manifold, object catalog, or contact site descriptor."),
      ]);
    }
    const fallbackBase = {
      material_a_ref: materialA ?? "unknown_material_a",
      material_b_ref: materialB ?? "unknown_material_b",
      effective_static_friction: DEFAULT_STATIC_FRICTION,
      effective_dynamic_friction: DEFAULT_DYNAMIC_FRICTION,
      effective_restitution: 0.1,
      solver_tolerance_m: DEFAULT_SOLVER_TOLERANCE_M,
      acoustic_profile_refs: freezeArray([] as Ref[]),
    };
    return Object.freeze({
      ...fallbackBase,
      determinism_hash: computeDeterminismHash(fallbackBase),
    });
  }

  private resolveEndpointMaterial(bodyRef: Ref, contactSiteRef: Ref | undefined): Ref | undefined {
    if (this.context.object_catalog?.has(bodyRef) === true) {
      return this.context.object_catalog.resolveMaterial(bodyRef).material_profile_ref;
    }
    const site = this.resolveContactSite(contactSiteRef);
    return site?.material_profile_ref;
  }

  private resolveContactSites(manifold: EngineContactManifold): readonly Ref[] {
    const declared = [manifold.contact_site_a_ref, manifold.contact_site_b_ref].filter(isDefined);
    if (declared.length > 0 || this.policy.allow_unknown_contact_sites) {
      return freezeArray([...new Set(declared)].sort());
    }
    throw new ContactSolverAdapterError(`Contact manifold ${manifold.manifold_ref} lacks declared contact sites.`, [
      makeIssue("error", "ContactSiteMissing", "$.contact_sites", "Contact event must map to declared contact sites for tactile exposure.", "Attach solver contacts to contact_site_table refs or enable unknown contact site policy for QA-only streams."),
    ]);
  }

  private resolveContactSite(contactSiteRef: Ref | undefined): ContactSiteDescriptor | undefined {
    if (contactSiteRef === undefined || this.context.articulated_registry === undefined || this.context.embodiment_ref === undefined) {
      return undefined;
    }
    const descriptor = this.context.articulated_registry.get(this.context.embodiment_ref);
    return descriptor.contact_site_table.find((site) => site.contact_site_ref === contactSiteRef);
  }

  private classifyContact(
    manifold: EngineContactManifold,
    relativeMotion: RelativeMotionSummary,
    impulseSummary: ContactImpulseSummary,
    frictionDiagnostic: FrictionConeDiagnostic,
  ): ContactClass {
    const expectation = manifold.expected_contact ?? "unknown";
    const endpointA = manifold.endpoint_a_kind ?? inferEndpointKind(manifold.body_a_ref);
    const endpointB = manifold.endpoint_b_kind ?? inferEndpointKind(manifold.body_b_ref);
    const bothBodies = endpointA === "body" && endpointB === "body";
    const anyTool = endpointA === "tool" || endpointB === "tool" || expectation === "tool";

    if (bothBodies && expectation !== "self_allowed") {
      return "self_collision";
    }
    if (relativeMotion === "sliding" && (expectation === "grasp" || expectation === "resting_support" || impulseSummary.impulse_category === "moderate")) {
      return "slip";
    }
    if (anyTool) {
      return frictionDiagnostic.regime === "dynamic_sliding" ? "slip" : "tool";
    }
    if (expectation === "grasp") {
      return "grasp";
    }
    if (expectation === "stack") {
      return relativeMotion === "impacting" && impulseSummary.impulse_category === "high" ? "unplanned_collision" : "stack";
    }
    if (expectation === "resting_support") {
      return relativeMotion === "sliding" ? "slip" : "resting_support";
    }
    if (expectation === "none" || impulseSummary.impulse_category === "high" || impulseSummary.impulse_category === "impossible") {
      return "unplanned_collision";
    }
    if (relativeMotion === "impacting") {
      return "unplanned_collision";
    }
    return "resting_support";
  }

  private createAcousticCandidate(
    contactEventId: Ref,
    contactClass: ContactClass,
    relativeMotion: RelativeMotionSummary,
    impulseSummary: ContactImpulseSummary,
    materialPair: ContactMaterialPairSummary,
    timestampS: number,
  ): AcousticContactCandidate | undefined {
    const acousticClass = classifyAcousticContact(contactClass, relativeMotion, impulseSummary, this.policy);
    if (acousticClass === "none") {
      return undefined;
    }
    const intensity = classifyAcousticIntensity(impulseSummary, this.policy);
    const candidateBase = {
      acoustic_candidate_ref: `audio_candidate_${contactEventId}`,
      contact_event_id: contactEventId,
      acoustic_class: acousticClass,
      intensity,
      source_time_s: timestampS,
      prompt_safe_hint: buildAudioPromptHint(acousticClass, intensity),
      internal_audio_profile_refs: freezeArray(materialPair.acoustic_profile_refs),
      cognitive_visibility: "prompt_safe_after_audio_packetization" as const,
    };
    return Object.freeze({
      ...candidateBase,
      determinism_hash: computeDeterminismHash(candidateBase),
    });
  }
}

export function createContactSolverAdapter(context: ContactAdapterContext): ContactSolverAdapter {
  return new ContactSolverAdapter(context);
}

export function normalizeContactBatch(context: ContactAdapterContext, input: {
  readonly stream_ref?: Ref;
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly manifolds: readonly EngineContactManifold[];
}): ContactEventStream {
  return new ContactSolverAdapter(context).normalizeContactBatch(input);
}

function computeImpulseSummary(
  manifold: EngineContactManifold,
  materialPair: ContactMaterialPairSummary,
  policy: ContactAdapterPolicy,
): ContactImpulseSummary {
  const totals = manifold.points.reduce((acc, point) => {
    return {
      normal: acc.normal + Math.max(0, point.normal_impulse_n_s),
      tangent: acc.tangent + Math.abs(point.tangent_impulse_n_s),
      penetration: Math.max(acc.penetration, point.penetration_depth_m),
      weightedPoint: addVector3(acc.weightedPoint, scaleVector3(point.position_m, Math.max(0, point.normal_impulse_n_s))),
    };
  }, { normal: 0, tangent: 0, penetration: 0, weightedPoint: [0, 0, 0] as Vector3 });
  const meanPoint = totals.normal > 1e-12
    ? scaleVector3(totals.weightedPoint, 1 / totals.normal)
    : averagePoint(manifold.points.map((point) => point.position_m));
  const summaryBase = {
    normal_impulse_n_s: totals.normal,
    tangential_impulse_n_s: totals.tangent,
    estimated_normal_force_n: totals.normal / policy.contact_dt_s,
    estimated_tangential_force_n: totals.tangent / policy.contact_dt_s,
    impulse_category: classifyImpulse(totals.normal, totals.penetration, policy),
    peak_penetration_depth_m: totals.penetration,
    mean_contact_point_m: meanPoint,
    effective_restitution: materialPair.effective_restitution,
  };
  return Object.freeze({
    ...summaryBase,
    determinism_hash: computeDeterminismHash(summaryBase),
  });
}

function computeFrictionDiagnostic(
  impulseSummary: ContactImpulseSummary,
  materialPair: ContactMaterialPairSummary,
  relativeMotion: RelativeMotionSummary,
): FrictionConeDiagnostic {
  const staticLimit = materialPair.effective_static_friction * impulseSummary.normal_impulse_n_s;
  const dynamicLimit = materialPair.effective_dynamic_friction * impulseSummary.normal_impulse_n_s;
  const slipMargin = staticLimit - impulseSummary.tangential_impulse_n_s;
  const utilization = staticLimit > 1e-12 ? impulseSummary.tangential_impulse_n_s / staticLimit : Number.POSITIVE_INFINITY;
  const regime: FrictionConeDiagnostic["regime"] = impulseSummary.normal_impulse_n_s <= 1e-12
    ? "degenerate"
    : relativeMotion === "separating"
      ? "separating"
      : slipMargin >= -materialPair.solver_tolerance_m
        ? "inside_static_cone"
        : "dynamic_sliding";
  const diagnosticBase = {
    normal_impulse_n_s: impulseSummary.normal_impulse_n_s,
    tangential_impulse_n_s: impulseSummary.tangential_impulse_n_s,
    static_friction_limit_n_s: staticLimit,
    dynamic_friction_limit_n_s: dynamicLimit,
    slip_margin_n_s: slipMargin,
    utilization,
    cone_half_angle_rad: Math.atan(materialPair.effective_static_friction),
    regime,
  };
  return Object.freeze({
    ...diagnosticBase,
    determinism_hash: computeDeterminismHash(diagnosticBase),
  });
}

function classifyRelativeMotion(
  manifold: EngineContactManifold,
  impulseSummary: ContactImpulseSummary,
  materialPair: ContactMaterialPairSummary,
  policy: ContactAdapterPolicy,
): RelativeMotionSummary {
  const normal = normalizeVector(averageNormal(manifold.points));
  const relativeVelocity = averageVector(manifold.points.map((point) => point.relative_velocity_a_to_b_m_per_s));
  const normalSpeed = dotVector3(relativeVelocity, normal);
  const tangentialVelocity = subtractVector3(relativeVelocity, scaleVector3(normal, normalSpeed));
  const tangentialSpeed = vectorNorm(tangentialVelocity);
  const staticLimit = materialPair.effective_static_friction * impulseSummary.normal_impulse_n_s;

  if (normalSpeed > policy.slip_speed_threshold_m_per_s && impulseSummary.normal_impulse_n_s < policy.impact_audio_threshold_n_s) {
    return "separating";
  }
  if (normalSpeed < -policy.slip_speed_threshold_m_per_s || impulseSummary.impulse_category === "high" || impulseSummary.impulse_category === "impossible") {
    return "impacting";
  }
  if (tangentialSpeed >= policy.rolling_tangent_speed_m_per_s && impulseSummary.tangential_impulse_n_s <= materialPair.effective_dynamic_friction * impulseSummary.normal_impulse_n_s) {
    return "rolling";
  }
  if (tangentialSpeed >= policy.slip_speed_threshold_m_per_s || impulseSummary.tangential_impulse_n_s > staticLimit + materialPair.solver_tolerance_m) {
    return "sliding";
  }
  return "sticking";
}

function classifySafetyRelevance(
  contactClass: ContactClass,
  impulseSummary: ContactImpulseSummary,
  frictionDiagnostic: FrictionConeDiagnostic,
  policy: ContactAdapterPolicy,
): SafetyRelevance {
  if (impulseSummary.impulse_category === "impossible" || impulseSummary.normal_impulse_n_s >= policy.safe_hold_impulse_threshold_n_s) {
    return "safe_hold";
  }
  if (contactClass === "self_collision" || impulseSummary.impulse_category === "high") {
    return "warning";
  }
  if (contactClass === "unplanned_collision" || contactClass === "slip" || frictionDiagnostic.regime === "dynamic_sliding") {
    return "monitor";
  }
  return "none";
}

function classifyOopsRelevance(contactClass: ContactClass, safety: SafetyRelevance, impulse: ContactImpulseSummary): ContactEvent["oops_relevance"] {
  if (safety === "safe_hold" || safety === "warning") {
    return "safety_evidence";
  }
  if (contactClass === "slip" || contactClass === "unplanned_collision" || impulse.impulse_category === "high") {
    return "strong_failure_evidence";
  }
  if (contactClass === "tool" || contactClass === "grasp") {
    return "possible_failure_evidence";
  }
  return "none";
}

function classifyFailureFamily(event: ContactEvent): ContactOopsEvidence["failure_family"] {
  if (event.contact_class === "slip") {
    return "slip";
  }
  if (event.contact_class === "unplanned_collision" && event.impulse_summary.impulse_category === "high") {
    return "drop_or_impact";
  }
  if (event.contact_class === "unplanned_collision") {
    return "unexpected_collision";
  }
  if (event.contact_class === "self_collision") {
    return "self_collision";
  }
  if (event.contact_class === "stack" && event.relative_motion_summary !== "sticking") {
    return "support_failure";
  }
  if (event.contact_class === "tool" || event.audio_candidate?.acoustic_class === "scrape") {
    return "tool_contact_issue";
  }
  return "none";
}

function computeOopsConfidence(event: ContactEvent, family: ContactOopsEvidence["failure_family"]): number {
  if (family === "none") {
    return 0;
  }
  const impulseWeight = event.impulse_summary.impulse_category === "high" || event.impulse_summary.impulse_category === "impossible"
    ? 0.35
    : event.impulse_summary.impulse_category === "moderate"
      ? 0.2
      : 0.1;
  const motionWeight = event.relative_motion_summary === "sliding" || event.relative_motion_summary === "impacting" ? 0.3 : 0.1;
  const safetyWeight = event.safety_relevance === "safe_hold" ? 0.25 : event.safety_relevance === "warning" ? 0.18 : 0.08;
  const audioWeight = event.audio_candidate === undefined ? 0 : 0.12;
  return clamp01(0.25 + impulseWeight + motionWeight + safetyWeight + audioWeight);
}

function classifyAcousticContact(
  contactClass: ContactClass,
  relativeMotion: RelativeMotionSummary,
  impulseSummary: ContactImpulseSummary,
  policy: ContactAdapterPolicy,
): ContactAcousticClass {
  if (impulseSummary.normal_impulse_n_s < policy.impact_audio_threshold_n_s && relativeMotion === "sticking") {
    return "none";
  }
  if (contactClass === "self_collision") {
    return "collision";
  }
  if (contactClass === "slip") {
    return "slip_sound";
  }
  if (relativeMotion === "rolling") {
    return "rolling";
  }
  if (contactClass === "tool" && relativeMotion === "sliding") {
    return "scrape";
  }
  if (contactClass === "unplanned_collision") {
    return "collision";
  }
  if (impulseSummary.normal_impulse_n_s >= policy.high_impulse_threshold_n_s) {
    return "hard_impact";
  }
  return "soft_impact";
}

function classifyAcousticIntensity(impulseSummary: ContactImpulseSummary, policy: ContactAdapterPolicy): AcousticContactCandidate["intensity"] {
  if (impulseSummary.impulse_category === "impossible" || impulseSummary.normal_impulse_n_s >= policy.safe_hold_impulse_threshold_n_s) {
    return "blocking";
  }
  if (impulseSummary.impulse_category === "high") {
    return "high";
  }
  if (impulseSummary.impulse_category === "moderate") {
    return "medium";
  }
  if (impulseSummary.impulse_category === "low") {
    return "low";
  }
  return "silent";
}

function classifyImpulse(normalImpulse: number, penetrationDepth: number, policy: ContactAdapterPolicy): ImpulseCategory {
  if (penetrationDepth >= policy.impossible_penetration_depth_m) {
    return "impossible";
  }
  if (normalImpulse <= 1e-9) {
    return "none";
  }
  if (normalImpulse >= policy.safe_hold_impulse_threshold_n_s) {
    return "impossible";
  }
  if (normalImpulse >= policy.high_impulse_threshold_n_s) {
    return "high";
  }
  if (normalImpulse >= policy.impact_audio_threshold_n_s) {
    return "moderate";
  }
  return "low";
}

function buildPromptSafeSummary(event: ContactEvent): string {
  if (event.safety_relevance === "safe_hold") {
    return "A high-risk contact was detected; motion should pause for safety review.";
  }
  if (event.contact_class === "slip") {
    return "Contact evidence suggests slipping or sliding during the interaction.";
  }
  if (event.contact_class === "unplanned_collision") {
    return "An unexpected contact occurred and should be checked before continuing.";
  }
  if (event.contact_class === "grasp") {
    return "Declared contact evidence is consistent with a grasp interaction.";
  }
  if (event.contact_class === "tool") {
    return "Declared contact evidence is consistent with tool contact.";
  }
  if (event.contact_class === "stack" || event.contact_class === "resting_support") {
    return "Contact evidence is consistent with support.";
  }
  return "Body contact evidence requires validator review.";
}

function buildOopsEvidenceSummary(event: ContactEvent, family: ContactOopsEvidence["failure_family"]): string {
  if (family === "slip") {
    return "Contact moved outside the static friction envelope, consistent with slip evidence for Oops intake.";
  }
  if (family === "drop_or_impact") {
    return "High impulse contact indicates a drop-like impact or hard collision that needs visual verification.";
  }
  if (family === "unexpected_collision") {
    return "Unexpected contact was detected and should be routed as collision evidence.";
  }
  if (family === "support_failure") {
    return "Support contact is not stable, indicating possible stack or placement failure.";
  }
  if (family === "tool_contact_issue") {
    return "Tool contact or scrape evidence indicates the tool interaction may need correction.";
  }
  if (family === "self_collision") {
    return "Robot body contact indicates a body-motion safety issue.";
  }
  return "Contact event does not currently indicate a failure family.";
}

function buildAudioPromptHint(acousticClass: ContactAcousticClass, intensity: AcousticContactCandidate["intensity"]): string {
  if (acousticClass === "collision" || acousticClass === "hard_impact") {
    return `A ${intensity} impact-like sound may be available through microphone evidence.`;
  }
  if (acousticClass === "slip_sound") {
    return "A slip-like sound may be available through microphone evidence.";
  }
  if (acousticClass === "scrape") {
    return "A scrape-like contact sound may be available through microphone evidence.";
  }
  if (acousticClass === "rolling") {
    return "A rolling contact sound may be available through microphone evidence.";
  }
  return "A soft contact sound may be available through microphone evidence.";
}

function validateManifold(manifold: EngineContactManifold): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(manifold.manifold_ref, issues, "$.manifold_ref", "ManifoldRefInvalid");
  validateRef(manifold.body_a_ref, issues, "$.body_a_ref", "BodyRefInvalid");
  validateRef(manifold.body_b_ref, issues, "$.body_b_ref", "BodyRefInvalid");
  if (!Number.isInteger(manifold.physics_tick) || manifold.physics_tick < 0) {
    addIssue(issues, "error", "TimestampInvalid", "$.physics_tick", "Physics tick must be a nonnegative integer.", "Pass the scheduler tick associated with this contact.");
  }
  if (!Number.isFinite(manifold.timestamp_s) || manifold.timestamp_s < 0) {
    addIssue(issues, "error", "TimestampInvalid", "$.timestamp_s", "Timestamp must be finite and nonnegative.", "Use simulation time in seconds.");
  }
  if (manifold.points.length === 0) {
    addIssue(issues, "error", "ContactPointMissing", "$.points", "Contact manifold requires at least one point.", "Pass solver contact points before normalization.");
  }
  for (let index = 0; index < manifold.points.length; index += 1) {
    validatePoint(manifold.points[index], issues, `$.points[${index}]`);
  }
  return freezeArray(issues);
}

function validatePoint(point: EngineContactPoint, issues: ValidationIssue[], path: string): void {
  validateVector3(point.position_m, issues, `${path}.position_m`, "ContactVectorInvalid");
  validateVector3(point.normal_a_to_b, issues, `${path}.normal_a_to_b`, "ContactVectorInvalid");
  validateVector3(point.relative_velocity_a_to_b_m_per_s, issues, `${path}.relative_velocity_a_to_b_m_per_s`, "ContactVectorInvalid");
  const normalNorm = vectorNorm(point.normal_a_to_b);
  if (Number.isFinite(normalNorm) && Math.abs(normalNorm - 1) > 1e-5) {
    addIssue(issues, "error", "ContactNormalInvalid", `${path}.normal_a_to_b`, "Contact normal must be unit length.", "Normalize engine contact normals before adaptation.");
  }
  validateNonNegativeFinite(point.penetration_depth_m, issues, `${path}.penetration_depth_m`, "ContactScalarInvalid");
  validateNonNegativeFinite(point.normal_impulse_n_s, issues, `${path}.normal_impulse_n_s`, "ContactScalarInvalid");
  validateNonNegativeFinite(Math.abs(point.tangent_impulse_n_s), issues, `${path}.tangent_impulse_n_s`, "ContactScalarInvalid");
}

function validatePolicy(policy: ContactAdapterPolicy): void {
  const issues: ValidationIssue[] = [];
  validatePositiveFinite(policy.contact_dt_s, issues, "$.contact_dt_s", "PolicyInvalid");
  validateNonNegativeFinite(policy.impact_audio_threshold_n_s, issues, "$.impact_audio_threshold_n_s", "PolicyInvalid");
  validatePositiveFinite(policy.high_impulse_threshold_n_s, issues, "$.high_impulse_threshold_n_s", "PolicyInvalid");
  validatePositiveFinite(policy.safe_hold_impulse_threshold_n_s, issues, "$.safe_hold_impulse_threshold_n_s", "PolicyInvalid");
  validateNonNegativeFinite(policy.slip_speed_threshold_m_per_s, issues, "$.slip_speed_threshold_m_per_s", "PolicyInvalid");
  validatePositiveFinite(policy.impossible_penetration_depth_m, issues, "$.impossible_penetration_depth_m", "PolicyInvalid");
  validateNonNegativeFinite(policy.sustained_contact_lifetime_s, issues, "$.sustained_contact_lifetime_s", "PolicyInvalid");
  validateNonNegativeFinite(policy.rolling_tangent_speed_m_per_s, issues, "$.rolling_tangent_speed_m_per_s", "PolicyInvalid");
  if (policy.high_impulse_threshold_n_s > policy.safe_hold_impulse_threshold_n_s) {
    addIssue(issues, "error", "PolicyInvalid", "$.safe_hold_impulse_threshold_n_s", "Safe-hold threshold must be at least high-impulse threshold.", "Raise safe-hold threshold or lower high-impulse threshold.");
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ContactSolverAdapterError("Contact adapter policy failed validation.", issues);
  }
}

function validateTickAndTimestamp(physicsTick: number, timestampS: number): void {
  if (!Number.isInteger(physicsTick) || physicsTick < 0 || !Number.isFinite(timestampS) || timestampS < 0) {
    throw new ContactSolverAdapterError("Contact stream tick or timestamp is invalid.", [
      makeIssue("error", "TimestampInvalid", "$.contact_stream", "Stream physics tick and timestamp must be finite and nonnegative.", "Pass scheduler tick and simulation timestamp."),
    ]);
  }
}

function inferEndpointKind(ref: Ref): ContactEndpointKind {
  if (ref.includes("tool")) {
    return "tool";
  }
  if (ref.includes("floor") || ref.includes("wall") || ref.includes("table") || ref.includes("shelf")) {
    return "environment";
  }
  if (ref.includes("body") || ref.includes("hand") || ref.includes("paw") || ref.includes("foot") || ref.includes("mouth") || ref.includes("gripper")) {
    return "body";
  }
  if (ref.includes("object") || ref.includes("cube") || ref.includes("ball") || ref.includes("block") || ref.includes("bowl")) {
    return "object";
  }
  return "unknown";
}

function compareManifolds(a: EngineContactManifold, b: EngineContactManifold): number {
  return a.physics_tick - b.physics_tick || a.timestamp_s - b.timestamp_s || a.manifold_ref.localeCompare(b.manifold_ref);
}

function rejectManifold(manifoldRef: Ref, reasonCode: ContactAdapterValidationCode, message: string, remediation: string): ContactAdapterRejection {
  return Object.freeze({
    manifold_ref: manifoldRef,
    reason_code: reasonCode,
    message,
    remediation,
  });
}

function averagePoint(points: readonly Vector3[]): Vector3 {
  return points.length === 0 ? [0, 0, 0] : scaleVector3(points.reduce(addVector3, [0, 0, 0] as Vector3), 1 / points.length);
}

function averageNormal(points: readonly EngineContactPoint[]): Vector3 {
  return normalizeVector(points.map((point) => point.normal_a_to_b).reduce(addVector3, [0, 0, 0] as Vector3));
}

function averageVector(points: readonly Vector3[]): Vector3 {
  return points.length === 0 ? [0, 0, 0] : scaleVector3(points.reduce(addVector3, [0, 0, 0] as Vector3), 1 / points.length);
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVector3(value: Vector3, scalar: number): Vector3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function dotVector3(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(dotVector3(value, value));
}

function normalizeVector(value: Vector3): Vector3 {
  const norm = vectorNorm(value);
  if (norm < 1e-12) {
    return [0, 0, 0];
  }
  return [value[0] / norm, value[1] / norm, value[2] / norm];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

type ContactAdapterValidationCode =
  | "ManifoldRefInvalid"
  | "BodyRefInvalid"
  | "ContactPointMissing"
  | "ContactVectorInvalid"
  | "ContactNormalInvalid"
  | "ContactScalarInvalid"
  | "MaterialRefMissing"
  | "ContactSiteMissing"
  | "TimestampInvalid"
  | "PolicyInvalid"
  | "ContactNormalizationFailed";

function makeIssue(severity: ValidationSeverity, code: ContactAdapterValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function addIssue(issues: ValidationIssue[], severity: ValidationSeverity, code: ContactAdapterValidationCode, path: string, message: string, remediation: string): void {
  issues.push(makeIssue(severity, code, path, message, remediation));
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: ContactAdapterValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    addIssue(issues, "error", code, path, "Reference must be non-empty and whitespace-free.", "Use opaque refs such as contact_cube_floor_001.");
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: ContactAdapterValidationCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Vector3 must contain exactly three finite numeric values.", "Use [x, y, z] in canonical units.");
  }
}

function validatePositiveFinite(value: number, issues: ValidationIssue[], path: string, code: ContactAdapterValidationCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    addIssue(issues, "error", code, path, "Value must be positive and finite.", "Provide a calibrated positive value.");
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: ContactAdapterValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    addIssue(issues, "error", code, path, "Value must be nonnegative and finite.", "Provide a calibrated nonnegative value.");
  }
}
