/**
 * Privileged physics query service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.13.3, 3.16, 3.17.5, 3.18.3, 3.19, and 3.20.
 *
 * This module is the runtime boundary for non-cognitive simulator-truth
 * queries. It executes collision sweeps, mesh-proxy intersection checks,
 * clearance checks, contact impulse checks, tool swept-volume checks, reach
 * feasibility, stability checks, timing-health checks, and QA truth inspection
 * while ensuring any model-facing repair output is sanitized before use.
 */

import { ArticulatedBodyRegistry } from "./articulated_body_registry";
import { ObjectPhysicsCatalog } from "./object_physics_catalog";
import { computeDeterminismHash } from "./world_manifest";
import type { IKPointTarget } from "./articulated_body_registry";
import type { ContactEvent, SafetyRelevance as ContactSafetyRelevance } from "./contact_solver_adapter";
import type { CollisionShapeDescriptor } from "./object_physics_catalog";
import type { PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "./world_manifest";

export const PHYSICS_QUERY_SERVICE_SCHEMA_VERSION = "mebsuta.physics_query_service.v1" as const;
const DEFAULT_COLLISION_RADIUS_M = 0.05;
const DEFAULT_CLEARANCE_REQUIRED_M = 0.025;
const DEFAULT_WARNING_CLEARANCE_M = 0.075;
const DEFAULT_HIGH_IMPULSE_N_S = 2.5;
const DEFAULT_SAFE_HOLD_IMPULSE_N_S = 7.5;
const DEFAULT_STABILITY_MARGIN_M = 0.035;

export type PrivilegedQueryComponent =
  | "PlanValidationService"
  | "SafetyManager"
  | "VerificationEngine"
  | "QAReportAssembler"
  | "PhysicsHealthMonitor"
  | "ToolValidator"
  | "OopsLoopSanitizer";

export type PhysicsAuthorizationContext = "validator" | "safety" | "qa" | "replay" | "health" | "tool";
export type PhysicsQueryDestination = "internal_validator" | "safety" | "qa_report" | "sanitized_repair";
export type PhysicsQueryTimeScopeKind = "current_tick" | "interval" | "replay_window";
export type PhysicsQueryType =
  | "pre_motion_collision_sweep"
  | "exact_mesh_intersection"
  | "minimum_distance_to_obstacle"
  | "contact_impulse_check"
  | "tool_swept_volume"
  | "reach_feasibility"
  | "stability_check"
  | "timing_health_check"
  | "qa_truth_inspection";
export type PhysicsQueryDecision = "clear" | "warning" | "blocked" | "safe_hold_required";
export type PhysicsSafetyRelevance = "none" | "warning" | "block" | "safe_hold";
export type HiddenFieldCategory =
  | "target_refs"
  | "body_refs"
  | "object_refs"
  | "collision_shape_refs"
  | "mesh_refs"
  | "exact_hidden_poses"
  | "exact_distances"
  | "contact_impulses"
  | "qa_truth"
  | "determinism_hashes"
  | "replay_refs";

export interface PhysicsQueryTimeScope {
  readonly kind: PhysicsQueryTimeScopeKind;
  readonly physics_tick?: number;
  readonly start_tick?: number;
  readonly end_tick?: number;
  readonly start_s?: number;
  readonly end_s?: number;
}

export interface CollisionSweepPayload {
  readonly moving_ref?: Ref;
  readonly start_m: Vector3;
  readonly end_m: Vector3;
  readonly moving_radius_m?: number;
  readonly clearance_required_m?: number;
  readonly obstacle_refs?: readonly Ref[];
}

export interface ExactMeshIntersectionPayload {
  readonly target_refs: readonly Ref[];
  readonly include_qa_mesh_refs: boolean;
}

export interface MinimumDistancePayload {
  readonly source_ref?: Ref;
  readonly source_point_m?: Vector3;
  readonly source_radius_m?: number;
  readonly obstacle_refs?: readonly Ref[];
  readonly clearance_required_m?: number;
}

export interface ContactImpulsePayload {
  readonly contact_events: readonly ContactEvent[];
  readonly contact_event_ids?: readonly Ref[];
  readonly warning_impulse_n_s?: number;
  readonly safe_hold_impulse_n_s?: number;
}

export interface ToolSweptVolumePayload {
  readonly tool_ref?: Ref;
  readonly path_points_m: readonly Vector3[];
  readonly tool_radius_m?: number;
  readonly clearance_required_m?: number;
  readonly obstacle_refs?: readonly Ref[];
}

export interface ReachFeasibilityPayload {
  readonly embodiment_ref?: Ref;
  readonly chain_ref?: Ref;
  readonly target_position_m: Vector3;
  readonly root_transform?: Transform;
  readonly seed_joint_positions?: Readonly<Record<Ref, number>>;
  readonly local_tip_point_m?: Vector3;
  readonly max_reach_m?: number;
  readonly tolerance_m?: number;
}

export interface StabilityCheckPayload {
  readonly embodiment_ref?: Ref;
  readonly center_of_mass_m?: Vector3;
  readonly support_polygon_points_m?: readonly Vector3[];
  readonly joint_positions?: Readonly<Record<Ref, number>>;
  readonly root_transform?: Transform;
  readonly required_margin_m?: number;
}

export interface TimingHealthPayload {
  readonly jitter_ms: number;
  readonly jitter_limit_ms: number;
  readonly dropped_step_count?: number;
  readonly solver_warning_count?: number;
}

export interface QaTruthInspectionPayload {
  readonly metric_refs: readonly Ref[];
  readonly include_object_state_digest?: boolean;
  readonly include_contact_digest?: boolean;
}

export type PhysicsQueryPayload =
  | { readonly query_type: "pre_motion_collision_sweep"; readonly sweep: CollisionSweepPayload }
  | { readonly query_type: "exact_mesh_intersection"; readonly exact_mesh: ExactMeshIntersectionPayload }
  | { readonly query_type: "minimum_distance_to_obstacle"; readonly minimum_distance: MinimumDistancePayload }
  | { readonly query_type: "contact_impulse_check"; readonly contact_impulse: ContactImpulsePayload }
  | { readonly query_type: "tool_swept_volume"; readonly tool_swept_volume: ToolSweptVolumePayload }
  | { readonly query_type: "reach_feasibility"; readonly reach: ReachFeasibilityPayload }
  | { readonly query_type: "stability_check"; readonly stability: StabilityCheckPayload }
  | { readonly query_type: "timing_health_check"; readonly timing: TimingHealthPayload }
  | { readonly query_type: "qa_truth_inspection"; readonly qa_truth: QaTruthInspectionPayload };

export interface PhysicsQueryRequest {
  readonly query_id: Ref;
  readonly requesting_component: PrivilegedQueryComponent;
  readonly authorization_context: PhysicsAuthorizationContext;
  readonly query_type: PhysicsQueryType;
  readonly target_refs?: readonly Ref[];
  readonly time_scope: PhysicsQueryTimeScope;
  readonly intended_output_destination: PhysicsQueryDestination;
  readonly world_snapshot: PhysicsWorldSnapshot;
  readonly payload: PhysicsQueryPayload;
}

export interface PhysicsAuthorizationPolicy {
  readonly allowed_components: readonly PrivilegedQueryComponent[];
  readonly allowed_query_types: readonly PhysicsQueryType[];
  readonly allowed_destinations: readonly PhysicsQueryDestination[];
  readonly component_query_allowlist?: Partial<Record<PrivilegedQueryComponent, readonly PhysicsQueryType[]>>;
  readonly allow_exact_mesh_queries: boolean;
  readonly allow_qa_truth: boolean;
  readonly require_sanitization_for_model_destinations: boolean;
}

export interface PhysicsSanitizationPolicy {
  readonly destination: PhysicsQueryDestination;
  readonly include_sanitized_summary: boolean;
  readonly remove_internal_refs: boolean;
  readonly remove_exact_hidden_poses: boolean;
  readonly remove_mesh_ids: boolean;
  readonly remove_qa_truth: boolean;
  readonly disclose_distance_bands_only: boolean;
  readonly max_reason_count: number;
}

export interface PhysicsQueryServiceContext {
  readonly object_catalog?: ObjectPhysicsCatalog;
  readonly articulated_registry?: ArticulatedBodyRegistry;
  readonly default_authorization_policy?: Partial<PhysicsAuthorizationPolicy>;
  readonly default_sanitization_policy?: Partial<PhysicsSanitizationPolicy>;
  readonly max_query_log_entries?: number;
}

export interface PhysicsHitRecord {
  readonly target_ref: Ref;
  readonly obstacle_ref: Ref;
  readonly query_geometry: "sphere" | "aabb" | "capsule" | "mesh_proxy";
  readonly nearest_point_m: Vector3;
  readonly clearance_m: number;
  readonly penetration_depth_m: number;
  readonly collision_shape_refs: readonly Ref[];
  readonly qa_mesh_refs: readonly Ref[];
  readonly risk: "clear" | "near" | "intersecting";
}

export interface ReachValidationDetail {
  readonly feasibility: "feasible" | "feasible_with_margin_warning" | "infeasible" | "unsafe" | "ambiguous";
  readonly residual_m: number;
  readonly limit_margin_rad_or_m: number;
  readonly recommended_recovery?: "reposition" | "reobserve" | "use_tool" | "lower_target" | "safe_hold" | "human_review";
}

export interface StabilityValidationDetail {
  readonly center_of_mass_m: Vector3;
  readonly support_polygon_area_m2: number;
  readonly signed_margin_m: number;
  readonly required_margin_m: number;
  readonly stable: boolean;
}

export interface PhysicsValidatorResult {
  readonly decision: PhysicsQueryDecision;
  readonly reason_classes: readonly string[];
  readonly hit_count: number;
  readonly minimum_clearance_m?: number;
  readonly maximum_impulse_n_s?: number;
  readonly reach?: ReachValidationDetail;
  readonly stability?: StabilityValidationDetail;
  readonly timing_health?: "within_tolerance" | "warning" | "safe_hold_required";
}

export interface PhysicsSanitizedSummary {
  readonly destination: "sanitized_repair";
  readonly decision: PhysicsQueryDecision;
  readonly safety_relevance: PhysicsSafetyRelevance;
  readonly prompt_safe_summary: string;
  readonly reason_classes: readonly string[];
  readonly distance_band?: "clear" | "low_clearance" | "collision_risk" | "blocked";
  readonly action_hint: "continue" | "reobserve" | "adjust_path" | "reduce_force" | "reposition" | "safe_hold" | "human_review";
  readonly hidden_fields_removed: readonly HiddenFieldCategory[];
}

export interface PhysicsQaMetrics {
  readonly metric_refs: readonly Ref[];
  readonly object_count: number;
  readonly contact_count?: number;
  readonly determinism_hash: string;
}

export interface PhysicsQueryAuditEntry {
  readonly audit_ref: Ref;
  readonly query_id: Ref;
  readonly requesting_component: PrivilegedQueryComponent;
  readonly query_type: PhysicsQueryType;
  readonly destination: PhysicsQueryDestination;
  readonly sanitized: boolean;
  readonly hidden_fields_removed: readonly HiddenFieldCategory[];
  readonly safety_relevance: PhysicsSafetyRelevance;
  readonly determinism_hash: string;
}

export interface PhysicsQueryResult {
  readonly schema_version: typeof PHYSICS_QUERY_SERVICE_SCHEMA_VERSION;
  readonly query_result_id: Ref;
  readonly query_id: Ref;
  readonly raw_internal_result?: {
    readonly query_type: PhysicsQueryType;
    readonly hits: readonly PhysicsHitRecord[];
    readonly sampled_path_points_m?: readonly Vector3[];
    readonly target_refs: readonly Ref[];
    readonly determinism_hash: string;
  };
  readonly validator_result?: PhysicsValidatorResult;
  readonly safety_relevance: PhysicsSafetyRelevance;
  readonly sanitized_summary?: PhysicsSanitizedSummary;
  readonly hidden_fields_removed?: readonly HiddenFieldCategory[];
  readonly qa_metrics?: PhysicsQaMetrics;
  readonly audit_entry: PhysicsQueryAuditEntry;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "runtime_qa_validator_only";
  readonly determinism_hash: string;
}

export type PhysicsQueryValidationCode =
  | "UnauthorizedPhysicsQuery"
  | "QueryTypeForbidden"
  | "SanitizationRequired"
  | "CannotSanitizeSafely"
  | "QueryRequestInvalid"
  | "QueryPayloadInvalid"
  | "TargetRefMissing";

export class PhysicsQueryServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PhysicsQueryServiceError";
    this.issues = issues;
  }
}

/**
 * Executes privileged physics queries and emits only sanitized repair summaries
 * for model-facing destinations.
 */
export class PhysicsQueryService {
  private readonly queryLog: PhysicsQueryAuditEntry[] = [];
  private readonly maxQueryLogEntries: number;

  public constructor(private readonly context: PhysicsQueryServiceContext = {}) {
    this.maxQueryLogEntries = context.max_query_log_entries ?? 512;
    assertPositiveInteger(this.maxQueryLogEntries, "max_query_log_entries");
  }

  public queryPhysicsForValidation(
    queryRequest: PhysicsQueryRequest,
    authorizationPolicy: Partial<PhysicsAuthorizationPolicy> = {},
    sanitizationPolicy: Partial<PhysicsSanitizationPolicy> = {},
  ): PhysicsQueryResult {
    validateQueryRequest(queryRequest);
    const authorization = mergeAuthorizationPolicy(this.context.default_authorization_policy, authorizationPolicy);
    const sanitization = mergeSanitizationPolicy(queryRequest.intended_output_destination, this.context.default_sanitization_policy, sanitizationPolicy);
    this.assertAuthorized(queryRequest, authorization);

    const evaluation = this.executeQuery(queryRequest);
    const hiddenFields = hiddenFieldsForQuery(queryRequest.query_type);
    const mustSanitize = queryRequest.intended_output_destination === "sanitized_repair";
    if (mustSanitize && authorization.require_sanitization_for_model_destinations && !sanitization.include_sanitized_summary) {
      throw new PhysicsQueryServiceError("Model-facing physics query output requires a sanitized summary.", [
        makeIssue("error", "SanitizationRequired", "$.sanitization_policy.include_sanitized_summary", "Sanitized repair destinations require a safe summary.", "Enable include_sanitized_summary for sanitized_repair output."),
      ]);
    }

    const sanitized = mustSanitize
      ? this.redactPhysicsQueryResultForCognition(evaluation.validator_result, sanitization, queryRequest.query_type)
      : undefined;
    const qaMetrics = this.buildQaMetrics(queryRequest, evaluation);
    const auditEntry = this.createAuditEntry(queryRequest, sanitized !== undefined, hiddenFields, evaluation.safety_relevance);

    const resultBase = {
      schema_version: PHYSICS_QUERY_SERVICE_SCHEMA_VERSION,
      query_result_id: `physics_query_result_${queryRequest.query_id}`,
      query_id: queryRequest.query_id,
      raw_internal_result: queryRequest.intended_output_destination === "qa_report" || queryRequest.intended_output_destination === "internal_validator" || queryRequest.intended_output_destination === "safety"
        ? evaluation.raw_internal_result
        : undefined,
      validator_result: evaluation.validator_result,
      safety_relevance: evaluation.safety_relevance,
      sanitized_summary: sanitized,
      hidden_fields_removed: sanitized?.hidden_fields_removed,
      qa_metrics: qaMetrics,
      audit_entry: auditEntry,
      issues: freezeArray(evaluation.issues),
      cognitive_visibility: "runtime_qa_validator_only" as const,
    };
    const result = Object.freeze({
      ...resultBase,
      determinism_hash: computeDeterminismHash(resultBase),
    });
    this.rememberAuditEntry(auditEntry);
    return result;
  }

  public redactPhysicsQueryResultForCognition(
    validatorResult: PhysicsValidatorResult,
    sanitizationPolicy: PhysicsSanitizationPolicy,
    queryType: PhysicsQueryType,
  ): PhysicsSanitizedSummary {
    if (queryType === "exact_mesh_intersection" || queryType === "qa_truth_inspection") {
      throw new PhysicsQueryServiceError("This physics query type cannot be safely redacted for cognition.", [
        makeIssue("error", "CannotSanitizeSafely", "$.query_type", "Exact mesh and QA truth queries are QA/internal only.", "Use collision sweep, clearance, contact, reach, or stability summaries for repair prompts."),
      ]);
    }
    if (sanitizationPolicy.remove_internal_refs !== true || sanitizationPolicy.remove_exact_hidden_poses !== true || sanitizationPolicy.remove_mesh_ids !== true || sanitizationPolicy.remove_qa_truth !== true) {
      throw new PhysicsQueryServiceError("Sanitization policy leaves hidden simulator truth exposed.", [
        makeIssue("error", "CannotSanitizeSafely", "$.sanitization_policy", "Model-facing physics summaries must remove refs, exact poses, mesh ids, and QA truth.", "Use the default sanitization policy for sanitized_repair."),
      ]);
    }

    const reasonClasses = freezeArray(validatorResult.reason_classes.slice(0, sanitizationPolicy.max_reason_count));
    const safetyRelevance = safetyFromDecision(validatorResult.decision);
    return Object.freeze({
      destination: "sanitized_repair",
      decision: validatorResult.decision,
      safety_relevance: safetyRelevance,
      prompt_safe_summary: promptSafeSummary(validatorResult),
      reason_classes: reasonClasses,
      distance_band: distanceBand(validatorResult),
      action_hint: actionHint(validatorResult),
      hidden_fields_removed: freezeArray(hiddenFieldsForSanitizedSummary(queryType)),
    });
  }

  public getQueryAuditLog(): readonly PhysicsQueryAuditEntry[] {
    return freezeArray(this.queryLog);
  }

  private assertAuthorized(request: PhysicsQueryRequest, policy: PhysicsAuthorizationPolicy): void {
    if (!policy.allowed_components.includes(request.requesting_component)) {
      throw new PhysicsQueryServiceError(`Unauthorized physics query component: ${request.requesting_component}`, [
        makeIssue("error", "UnauthorizedPhysicsQuery", "$.requesting_component", "Requesting component is not privileged for physics truth.", "Route physics queries through an approved validator, safety, health, or QA component."),
      ]);
    }
    if (!policy.allowed_query_types.includes(request.query_type)) {
      throw new PhysicsQueryServiceError(`Physics query type is forbidden: ${request.query_type}`, [
        makeIssue("error", "QueryTypeForbidden", "$.query_type", "Query type is not enabled by the authorization policy.", "Add the query type to the privileged policy only after safety review."),
      ]);
    }
    if (!policy.allowed_destinations.includes(request.intended_output_destination)) {
      throw new PhysicsQueryServiceError(`Physics query destination is forbidden: ${request.intended_output_destination}`, [
        makeIssue("error", "UnauthorizedPhysicsQuery", "$.intended_output_destination", "Destination is not enabled by the authorization policy.", "Use internal_validator, safety, qa_report, or sanitized_repair."),
      ]);
    }
    const componentAllowlist = policy.component_query_allowlist?.[request.requesting_component] ?? defaultComponentAllowlist()[request.requesting_component];
    if (!componentAllowlist.includes(request.query_type)) {
      throw new PhysicsQueryServiceError(`Component ${request.requesting_component} may not execute ${request.query_type}.`, [
        makeIssue("error", "QueryTypeForbidden", "$.requesting_component", "Component-specific query allowlist rejected the request.", "Use a component authorized for this query family."),
      ]);
    }
    if (request.query_type === "exact_mesh_intersection" && !policy.allow_exact_mesh_queries) {
      throw new PhysicsQueryServiceError("Exact mesh intersection query is disabled by policy.", [
        makeIssue("error", "QueryTypeForbidden", "$.query_type", "Exact mesh intersection is QA/debug only.", "Enable exact mesh queries only for QA or simulation debugging."),
      ]);
    }
    if (request.query_type === "qa_truth_inspection" && !policy.allow_qa_truth) {
      throw new PhysicsQueryServiceError("QA truth inspection query is disabled by policy.", [
        makeIssue("error", "QueryTypeForbidden", "$.query_type", "QA truth requires explicit QA authorization.", "Use qa_report destination and an authorization policy that permits QA truth."),
      ]);
    }
  }

  private executeQuery(request: PhysicsQueryRequest): {
    readonly raw_internal_result?: PhysicsQueryResult["raw_internal_result"];
    readonly validator_result: PhysicsValidatorResult;
    readonly safety_relevance: PhysicsSafetyRelevance;
    readonly issues: readonly ValidationIssue[];
  } {
    const snapshot = request.world_snapshot;
    switch (request.payload.query_type) {
      case "pre_motion_collision_sweep":
        return this.evaluateCollisionSweep(request, snapshot, request.payload.sweep);
      case "exact_mesh_intersection":
        return this.evaluateExactMeshIntersection(request, snapshot, request.payload.exact_mesh);
      case "minimum_distance_to_obstacle":
        return this.evaluateMinimumDistance(request, snapshot, request.payload.minimum_distance);
      case "contact_impulse_check":
        return evaluateContactImpulse(request, request.payload.contact_impulse);
      case "tool_swept_volume":
        return this.evaluateToolSweptVolume(request, snapshot, request.payload.tool_swept_volume);
      case "reach_feasibility":
        return this.evaluateReach(request, request.payload.reach);
      case "stability_check":
        return this.evaluateStability(request, request.payload.stability);
      case "timing_health_check":
        return evaluateTiming(request, request.payload.timing);
      case "qa_truth_inspection":
        return this.evaluateQaTruthInspection(request, snapshot, request.payload.qa_truth);
    }
  }

  private evaluateCollisionSweep(
    request: PhysicsQueryRequest,
    snapshot: PhysicsWorldSnapshot,
    payload: CollisionSweepPayload,
  ): QueryEvaluation {
    validateVector3(payload.start_m, "$.payload.sweep.start_m");
    validateVector3(payload.end_m, "$.payload.sweep.end_m");
    const movingRadius = positiveOrDefault(payload.moving_radius_m, DEFAULT_COLLISION_RADIUS_M);
    const requiredClearance = nonNegativeOrDefault(payload.clearance_required_m, DEFAULT_CLEARANCE_REQUIRED_M);
    const proxies = this.proxiesForSnapshot(snapshot, payload.obstacle_refs).filter((proxy) => proxy.object_ref !== payload.moving_ref);
    const hits = proxies.map((proxy) => {
      const nearest = closestPointOnSegment(proxy.center_m, payload.start_m, payload.end_m);
      const centerDistance = distanceVector(proxy.center_m, nearest);
      const clearance = centerDistance - proxy.radius_m - movingRadius;
      return hitRecord(payload.moving_ref ?? "moving_body", proxy, nearest, clearance, requiredClearance);
    }).filter((hit) => hit.risk !== "clear").sort(compareHits);
    const sampled = sampleSegment(payload.start_m, payload.end_m, 9);
    return evaluationFromHits(request, hits, sampled, requiredClearance, "collision_sweep");
  }

  private evaluateExactMeshIntersection(
    request: PhysicsQueryRequest,
    snapshot: PhysicsWorldSnapshot,
    payload: ExactMeshIntersectionPayload,
  ): QueryEvaluation {
    if (payload.target_refs.length < 2) {
      throw new PhysicsQueryServiceError("Exact mesh intersection requires at least two target refs.", [
        makeIssue("error", "QueryPayloadInvalid", "$.payload.exact_mesh.target_refs", "At least two target refs are required.", "Supply the objects or bodies being debugged."),
      ]);
    }
    const proxies = this.proxiesForSnapshot(snapshot, payload.target_refs);
    const hits: PhysicsHitRecord[] = [];
    for (let i = 0; i < proxies.length; i += 1) {
      for (let j = i + 1; j < proxies.length; j += 1) {
        const a = proxies[i];
        const b = proxies[j];
        const clearance = aabbSeparation(a, b);
        const nearest = midpoint(a.center_m, b.center_m);
        const collisionShapeRefs = freezeArray([...a.collision_shape_refs, ...b.collision_shape_refs].sort());
        const qaMeshRefs = payload.include_qa_mesh_refs ? freezeArray([...a.qa_mesh_refs, ...b.qa_mesh_refs].sort()) : freezeArray([]);
        if (clearance <= 0) {
          hits.push(Object.freeze({
            target_ref: a.object_ref,
            obstacle_ref: b.object_ref,
            query_geometry: "mesh_proxy",
            nearest_point_m: nearest,
            clearance_m: clearance,
            penetration_depth_m: Math.max(0, -clearance),
            collision_shape_refs: collisionShapeRefs,
            qa_mesh_refs: qaMeshRefs,
            risk: "intersecting",
          }));
        }
      }
    }
    return evaluationFromHits(request, hits.sort(compareHits), undefined, 0, "exact_mesh_intersection");
  }

  private evaluateMinimumDistance(
    request: PhysicsQueryRequest,
    snapshot: PhysicsWorldSnapshot,
    payload: MinimumDistancePayload,
  ): QueryEvaluation {
    const requiredClearance = nonNegativeOrDefault(payload.clearance_required_m, DEFAULT_CLEARANCE_REQUIRED_M);
    const sourceProxy = payload.source_ref === undefined ? undefined : this.proxyForRef(snapshot, payload.source_ref);
    const sourcePoint = payload.source_point_m ?? sourceProxy?.center_m;
    if (sourcePoint === undefined) {
      throw new PhysicsQueryServiceError("Minimum-distance query requires a source ref or source point.", [
        makeIssue("error", "TargetRefMissing", "$.payload.minimum_distance", "No source geometry was provided.", "Provide source_ref or source_point_m."),
      ]);
    }
    validateVector3(sourcePoint, "$.payload.minimum_distance.source_point_m");
    const sourceRadius = positiveOrDefault(payload.source_radius_m, sourceProxy?.radius_m ?? DEFAULT_COLLISION_RADIUS_M);
    const obstacles = this.proxiesForSnapshot(snapshot, payload.obstacle_refs).filter((proxy) => proxy.object_ref !== payload.source_ref);
    const hits = obstacles.map((proxy) => {
      const centerDistance = distanceVector(sourcePoint, proxy.center_m);
      const clearance = centerDistance - sourceRadius - proxy.radius_m;
      return hitRecord(payload.source_ref ?? "query_point", proxy, proxy.center_m, clearance, requiredClearance);
    }).sort(compareHits);
    return evaluationFromHits(request, hits.slice(0, Math.min(8, hits.length)), undefined, requiredClearance, "minimum_distance");
  }

  private evaluateToolSweptVolume(
    request: PhysicsQueryRequest,
    snapshot: PhysicsWorldSnapshot,
    payload: ToolSweptVolumePayload,
  ): QueryEvaluation {
    if (payload.path_points_m.length < 2) {
      throw new PhysicsQueryServiceError("Tool swept-volume query requires at least two path points.", [
        makeIssue("error", "QueryPayloadInvalid", "$.payload.tool_swept_volume.path_points_m", "Swept-volume path must have at least two points.", "Provide a path segment or polyline for the tool sweep."),
      ]);
    }
    for (let index = 0; index < payload.path_points_m.length; index += 1) {
      validateVector3(payload.path_points_m[index], `$.payload.tool_swept_volume.path_points_m[${index}]`);
    }
    const toolRadius = positiveOrDefault(payload.tool_radius_m, payload.tool_ref === undefined ? DEFAULT_COLLISION_RADIUS_M : this.proxyForRef(snapshot, payload.tool_ref).radius_m);
    const requiredClearance = nonNegativeOrDefault(payload.clearance_required_m, DEFAULT_CLEARANCE_REQUIRED_M);
    const obstacles = this.proxiesForSnapshot(snapshot, payload.obstacle_refs).filter((proxy) => proxy.object_ref !== payload.tool_ref);
    const hits: PhysicsHitRecord[] = [];
    for (const proxy of obstacles) {
      let bestPoint = payload.path_points_m[0];
      let bestClearance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < payload.path_points_m.length - 1; index += 1) {
        const nearest = closestPointOnSegment(proxy.center_m, payload.path_points_m[index], payload.path_points_m[index + 1]);
        const clearance = distanceVector(proxy.center_m, nearest) - proxy.radius_m - toolRadius;
        if (clearance < bestClearance) {
          bestClearance = clearance;
          bestPoint = nearest;
        }
      }
      hits.push(hitRecord(payload.tool_ref ?? "tool_swept_volume", proxy, bestPoint, bestClearance, requiredClearance));
    }
    const relevantHits = hits.filter((hit) => hit.risk !== "clear").sort(compareHits);
    return evaluationFromHits(request, relevantHits, payload.path_points_m, requiredClearance, "tool_swept_volume");
  }

  private evaluateReach(request: PhysicsQueryRequest, payload: ReachFeasibilityPayload): QueryEvaluation {
    validateVector3(payload.target_position_m, "$.payload.reach.target_position_m");
    const registry = this.context.articulated_registry;
    let detail: ReachValidationDetail;
    if (registry !== undefined && payload.embodiment_ref !== undefined && payload.chain_ref !== undefined) {
      const target: IKPointTarget = {
        embodiment_ref: payload.embodiment_ref,
        chain_ref: payload.chain_ref,
        target_position_m: payload.target_position_m,
        seed_joint_positions: payload.seed_joint_positions,
        root_transform: payload.root_transform,
        local_tip_point_m: payload.local_tip_point_m,
        tolerance_m: payload.tolerance_m,
      };
      const report = registry.solvePointIK(target);
      detail = Object.freeze({
        feasibility: report.feasibility,
        residual_m: report.residual_m,
        limit_margin_rad_or_m: report.limit_margin_rad_or_m,
        recommended_recovery: report.recommended_recovery,
      });
    } else {
      const root = payload.root_transform?.position_m ?? [0, 0, 0];
      const maxReach = positiveOrDefault(payload.max_reach_m, 1);
      const residual = Math.max(0, distanceVector(root, payload.target_position_m) - maxReach);
      detail = Object.freeze({
        feasibility: residual <= (payload.tolerance_m ?? 0.01) ? "feasible" : residual <= DEFAULT_WARNING_CLEARANCE_M ? "feasible_with_margin_warning" : "infeasible",
        residual_m: residual,
        limit_margin_rad_or_m: maxReach - distanceVector(root, payload.target_position_m),
        recommended_recovery: residual <= (payload.tolerance_m ?? 0.01) ? undefined : "reposition",
      });
    }
    const decision = detail.feasibility === "feasible"
      ? "clear"
      : detail.feasibility === "feasible_with_margin_warning" || detail.feasibility === "ambiguous"
        ? "warning"
        : detail.feasibility === "unsafe"
          ? "safe_hold_required"
          : "blocked";
    const validator = freezeValidator({
      decision,
      reason_classes: reasonClassesForDecision(decision, "reach_feasibility"),
      hit_count: decision === "clear" ? 0 : 1,
      reach: detail,
    });
    return simpleEvaluation(request, validator);
  }

  private evaluateStability(request: PhysicsQueryRequest, payload: StabilityCheckPayload): QueryEvaluation {
    const requiredMargin = nonNegativeOrDefault(payload.required_margin_m, DEFAULT_STABILITY_MARGIN_M);
    const polygon = payload.support_polygon_points_m ?? this.supportPolygonFromEmbodiment(payload);
    if (polygon.length < 3) {
      throw new PhysicsQueryServiceError("Stability query requires a support polygon.", [
        makeIssue("error", "QueryPayloadInvalid", "$.payload.stability.support_polygon_points_m", "At least three support points are required for a support polygon.", "Provide support contact points or a registered embodiment stability policy."),
      ]);
    }
    const com = payload.center_of_mass_m ?? this.centerOfMassFromEmbodiment(payload);
    validateVector3(com, "$.payload.stability.center_of_mass_m");
    const hull = convexHull2D(polygon);
    const signedMargin = signedDistanceToConvexPolygon2D(com, hull);
    const area = polygonArea2D(hull);
    const stable = signedMargin >= requiredMargin;
    const decision: PhysicsQueryDecision = stable ? "clear" : signedMargin >= 0 ? "warning" : "blocked";
    const detail: StabilityValidationDetail = Object.freeze({
      center_of_mass_m: freezeVector3(com),
      support_polygon_area_m2: area,
      signed_margin_m: signedMargin,
      required_margin_m: requiredMargin,
      stable,
    });
    const validator = freezeValidator({
      decision,
      reason_classes: reasonClassesForDecision(decision, "stability_check"),
      hit_count: stable ? 0 : 1,
      minimum_clearance_m: signedMargin,
      stability: detail,
    });
    return simpleEvaluation(request, validator);
  }

  private evaluateQaTruthInspection(
    request: PhysicsQueryRequest,
    snapshot: PhysicsWorldSnapshot,
    payload: QaTruthInspectionPayload,
  ): QueryEvaluation {
    if (request.intended_output_destination !== "qa_report") {
      throw new PhysicsQueryServiceError("QA truth inspection requires qa_report destination.", [
        makeIssue("error", "UnauthorizedPhysicsQuery", "$.intended_output_destination", "QA truth is developer/QA-only.", "Route QA truth to qa_report only."),
      ]);
    }
    const validator = freezeValidator({
      decision: "clear",
      reason_classes: freezeArray(["qa_truth_available"]),
      hit_count: 0,
    });
    const rawBase = {
      query_type: request.query_type,
      hits: freezeArray([] as PhysicsHitRecord[]),
      target_refs: freezeArray(payload.metric_refs),
    };
    return Object.freeze({
      raw_internal_result: Object.freeze({
        ...rawBase,
        determinism_hash: computeDeterminismHash({ rawBase, snapshot_hash: snapshot.determinism_hash }),
      }),
      validator_result: validator,
      safety_relevance: "none",
      issues: freezeArray([]),
    });
  }

  private supportPolygonFromEmbodiment(payload: StabilityCheckPayload): readonly Vector3[] {
    if (this.context.articulated_registry === undefined || payload.embodiment_ref === undefined) {
      return freezeArray([]);
    }
    const descriptor = this.context.articulated_registry.get(payload.embodiment_ref);
    const fk = this.context.articulated_registry.computeForwardKinematics(payload.embodiment_ref, payload.joint_positions ?? {}, payload.root_transform);
    const bodyTransforms = new Map(fk.body_transforms.map((record) => [record.body_ref, record.transform] as const));
    return freezeArray(descriptor.contact_site_table
      .filter((site) => descriptor.stability_policy.support_contact_site_refs.includes(site.contact_site_ref))
      .map((site) => {
        const body = bodyTransforms.get(site.body_ref);
        return body === undefined ? undefined : transformPoint(body, site.local_transform.position_m);
      })
      .filter(isDefined));
  }

  private centerOfMassFromEmbodiment(payload: StabilityCheckPayload): Vector3 {
    if (this.context.articulated_registry === undefined || payload.embodiment_ref === undefined) {
      throw new PhysicsQueryServiceError("Stability query requires center of mass or articulated registry context.", [
        makeIssue("error", "QueryPayloadInvalid", "$.payload.stability.center_of_mass_m", "No center of mass source was provided.", "Provide center_of_mass_m or configure ArticulatedBodyRegistry."),
      ]);
    }
    return this.context.articulated_registry.computeCenterOfMass(payload.embodiment_ref, payload.joint_positions ?? {}, payload.root_transform).center_of_mass_m;
  }

  private proxiesForSnapshot(snapshot: PhysicsWorldSnapshot, refs: readonly Ref[] | undefined): readonly CollisionProxy[] {
    const selected = refs === undefined ? snapshot.object_states.map((state) => state.object_ref) : refs;
    return freezeArray(selected.map((ref) => this.proxyForRef(snapshot, ref)));
  }

  private proxyForRef(snapshot: PhysicsWorldSnapshot, ref: Ref): CollisionProxy {
    const state = snapshot.object_states.find((candidate) => candidate.object_ref === ref);
    if (state === undefined) {
      throw new PhysicsQueryServiceError(`Physics query target is not present in the snapshot: ${ref}`, [
        makeIssue("error", "TargetRefMissing", "$.target_refs", "Target ref is absent from current physics snapshot.", "Use a ref present in PhysicsWorldSnapshot.object_states."),
      ]);
    }
    const catalogEntry = this.context.object_catalog?.has(ref) === true ? this.context.object_catalog.get(ref) : undefined;
    return proxyFromState(state.transform, ref, catalogEntry?.collision_shape);
  }

  private buildQaMetrics(request: PhysicsQueryRequest, evaluation: QueryEvaluation): PhysicsQaMetrics | undefined {
    if (request.intended_output_destination !== "qa_report") {
      return undefined;
    }
    const metricsBase = {
      metric_refs: freezeArray(request.payload.query_type === "qa_truth_inspection" ? request.payload.qa_truth.metric_refs : [`metric_${request.query_type}`]),
      object_count: request.world_snapshot.object_states.length,
      contact_count: request.payload.query_type === "contact_impulse_check" ? request.payload.contact_impulse.contact_events.length : undefined,
    };
    return Object.freeze({
      ...metricsBase,
      determinism_hash: computeDeterminismHash({ metricsBase, evaluation }),
    });
  }

  private createAuditEntry(
    request: PhysicsQueryRequest,
    sanitized: boolean,
    hiddenFields: readonly HiddenFieldCategory[],
    safetyRelevance: PhysicsSafetyRelevance,
  ): PhysicsQueryAuditEntry {
    const auditBase = {
      audit_ref: `audit_${request.query_id}`,
      query_id: request.query_id,
      requesting_component: request.requesting_component,
      query_type: request.query_type,
      destination: request.intended_output_destination,
      sanitized,
      hidden_fields_removed: freezeArray(sanitized ? hiddenFields : []),
      safety_relevance: safetyRelevance,
    };
    return Object.freeze({
      ...auditBase,
      determinism_hash: computeDeterminismHash(auditBase),
    });
  }

  private rememberAuditEntry(entry: PhysicsQueryAuditEntry): void {
    this.queryLog.push(entry);
    if (this.queryLog.length > this.maxQueryLogEntries) {
      this.queryLog.splice(0, this.queryLog.length - this.maxQueryLogEntries);
    }
  }
}

export function queryPhysicsForValidation(
  queryRequest: PhysicsQueryRequest,
  authorizationPolicy: Partial<PhysicsAuthorizationPolicy> = {},
  sanitizationPolicy: Partial<PhysicsSanitizationPolicy> = {},
  context: PhysicsQueryServiceContext = {},
): PhysicsQueryResult {
  return new PhysicsQueryService(context).queryPhysicsForValidation(queryRequest, authorizationPolicy, sanitizationPolicy);
}

function evaluateContactImpulse(request: PhysicsQueryRequest, payload: ContactImpulsePayload): QueryEvaluation {
  const eventIds = new Set(payload.contact_event_ids ?? payload.contact_events.map((event) => event.contact_event_id));
  const selectedEvents = payload.contact_events.filter((event) => eventIds.has(event.contact_event_id));
  const warningLimit = positiveOrDefault(payload.warning_impulse_n_s, DEFAULT_HIGH_IMPULSE_N_S);
  const safeHoldLimit = positiveOrDefault(payload.safe_hold_impulse_n_s, DEFAULT_SAFE_HOLD_IMPULSE_N_S);
  if (warningLimit > safeHoldLimit) {
    throw new PhysicsQueryServiceError("Contact impulse warning limit exceeds safe-hold limit.", [
      makeIssue("error", "QueryPayloadInvalid", "$.payload.contact_impulse", "warning_impulse_n_s must not exceed safe_hold_impulse_n_s.", "Raise safe-hold limit or lower warning limit."),
    ]);
  }
  const maxImpulse = selectedEvents.length === 0 ? 0 : Math.max(...selectedEvents.map((event) => event.impulse_summary.normal_impulse_n_s));
  const contactSafety = selectedEvents.map((event) => event.safety_relevance).reduce(maxContactSafety, "none" as ContactSafetyRelevance);
  const decision: PhysicsQueryDecision = contactSafety === "safe_hold" || maxImpulse >= safeHoldLimit
    ? "safe_hold_required"
    : contactSafety === "warning" || maxImpulse >= warningLimit
      ? "blocked"
      : contactSafety === "monitor"
        ? "warning"
        : "clear";
  const hits = selectedEvents
    .filter((event) => event.impulse_summary.normal_impulse_n_s >= warningLimit || event.safety_relevance !== "none")
    .map((event) => Object.freeze({
      target_ref: event.internal_body_refs[0] ?? "contact_target",
      obstacle_ref: event.internal_body_refs[1] ?? "contact_obstacle",
      query_geometry: "mesh_proxy" as const,
      nearest_point_m: event.impulse_summary.mean_contact_point_m,
      clearance_m: -event.impulse_summary.peak_penetration_depth_m,
      penetration_depth_m: event.impulse_summary.peak_penetration_depth_m,
      collision_shape_refs: freezeArray(event.collision_shape_refs),
      qa_mesh_refs: freezeArray([] as Ref[]),
      risk: event.impulse_summary.peak_penetration_depth_m > 0 ? "intersecting" as const : "near" as const,
    }));
  const validator = freezeValidator({
    decision,
    reason_classes: reasonClassesForDecision(decision, "contact_impulse_check"),
    hit_count: hits.length,
    maximum_impulse_n_s: maxImpulse,
  });
  const rawBase = {
    query_type: request.query_type,
    hits: freezeArray(hits),
    target_refs: freezeArray([...eventIds]),
  };
  return Object.freeze({
    raw_internal_result: Object.freeze({
      ...rawBase,
      determinism_hash: computeDeterminismHash(rawBase),
    }),
    validator_result: validator,
    safety_relevance: safetyFromDecision(decision),
    issues: freezeArray([]),
  });
}

function evaluateTiming(request: PhysicsQueryRequest, payload: TimingHealthPayload): QueryEvaluation {
  if (!Number.isFinite(payload.jitter_ms) || payload.jitter_ms < 0 || !Number.isFinite(payload.jitter_limit_ms) || payload.jitter_limit_ms < 0) {
    throw new PhysicsQueryServiceError("Timing health query requires nonnegative finite jitter values.", [
      makeIssue("error", "QueryPayloadInvalid", "$.payload.timing", "jitter_ms and jitter_limit_ms must be nonnegative finite values.", "Use scheduler timing health values in milliseconds."),
    ]);
  }
  const dropped = payload.dropped_step_count ?? 0;
  const solverWarnings = payload.solver_warning_count ?? 0;
  const decision: PhysicsQueryDecision = payload.jitter_ms > payload.jitter_limit_ms * 2 || dropped > 0
    ? "safe_hold_required"
    : payload.jitter_ms > payload.jitter_limit_ms || solverWarnings > 0
      ? "warning"
      : "clear";
  const validator = freezeValidator({
    decision,
    reason_classes: reasonClassesForDecision(decision, "timing_health_check"),
    hit_count: decision === "clear" ? 0 : 1,
    timing_health: decision === "safe_hold_required" ? "safe_hold_required" : decision === "warning" ? "warning" : "within_tolerance",
  });
  const rawBase = {
    query_type: request.query_type,
    hits: freezeArray([] as PhysicsHitRecord[]),
    target_refs: freezeArray(request.target_refs ?? []),
  };
  return Object.freeze({
    raw_internal_result: Object.freeze({
      ...rawBase,
      determinism_hash: computeDeterminismHash({ rawBase, payload }),
    }),
    validator_result: validator,
    safety_relevance: safetyFromDecision(decision),
    issues: freezeArray([]),
  });
}

type QueryEvaluation = {
  readonly raw_internal_result?: PhysicsQueryResult["raw_internal_result"];
  readonly validator_result: PhysicsValidatorResult;
  readonly safety_relevance: PhysicsSafetyRelevance;
  readonly issues: readonly ValidationIssue[];
};

interface CollisionProxy {
  readonly object_ref: Ref;
  readonly center_m: Vector3;
  readonly half_extents_m: Vector3;
  readonly radius_m: number;
  readonly collision_shape_refs: readonly Ref[];
  readonly qa_mesh_refs: readonly Ref[];
}

function evaluationFromHits(
  request: PhysicsQueryRequest,
  hits: readonly PhysicsHitRecord[],
  sampledPathPoints: readonly Vector3[] | undefined,
  requiredClearance: number,
  reasonClass: string,
): QueryEvaluation {
  const minimumClearance = hits.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...hits.map((hit) => hit.clearance_m));
  const decision: PhysicsQueryDecision = hits.some((hit) => hit.risk === "intersecting")
    ? "blocked"
    : minimumClearance < requiredClearance
      ? "warning"
      : "clear";
  const validator = freezeValidator({
    decision,
    reason_classes: reasonClassesForDecision(decision, reasonClass),
    hit_count: hits.length,
    minimum_clearance_m: Number.isFinite(minimumClearance) ? minimumClearance : undefined,
  });
  const rawBase = {
    query_type: request.query_type,
    hits: freezeArray(hits),
    sampled_path_points_m: sampledPathPoints === undefined ? undefined : freezeArray(sampledPathPoints.map(freezeVector3)),
    target_refs: freezeArray(request.target_refs ?? []),
  };
  return Object.freeze({
    raw_internal_result: Object.freeze({
      ...rawBase,
      determinism_hash: computeDeterminismHash(rawBase),
    }),
    validator_result: validator,
    safety_relevance: safetyFromDecision(decision),
    issues: freezeArray([]),
  });
}

function simpleEvaluation(request: PhysicsQueryRequest, validator: PhysicsValidatorResult): QueryEvaluation {
  const rawBase = {
    query_type: request.query_type,
    hits: freezeArray([] as PhysicsHitRecord[]),
    target_refs: freezeArray(request.target_refs ?? []),
  };
  return Object.freeze({
    raw_internal_result: Object.freeze({
      ...rawBase,
      determinism_hash: computeDeterminismHash({ rawBase, validator }),
    }),
    validator_result: validator,
    safety_relevance: safetyFromDecision(validator.decision),
    issues: freezeArray([]),
  });
}

function proxyFromState(transform: Transform, objectRef: Ref, shape: CollisionShapeDescriptor | undefined): CollisionProxy {
  const center = addVector3(transform.position_m, shape?.local_offset_m ?? [0, 0, 0]);
  const halfExtents = shapeHalfExtents(shape);
  const qaMeshRefs = shape?.qa_only_mesh_ref === undefined ? [] : [shape.qa_only_mesh_ref];
  return Object.freeze({
    object_ref: objectRef,
    center_m: freezeVector3(center),
    half_extents_m: freezeVector3(halfExtents),
    radius_m: vectorNorm(halfExtents),
    collision_shape_refs: freezeArray(shape === undefined ? [] : [shape.collision_shape_ref]),
    qa_mesh_refs: freezeArray(qaMeshRefs),
  });
}

function shapeHalfExtents(shape: CollisionShapeDescriptor | undefined): Vector3 {
  if (shape === undefined) {
    return [DEFAULT_COLLISION_RADIUS_M, DEFAULT_COLLISION_RADIUS_M, DEFAULT_COLLISION_RADIUS_M];
  }
  if (shape.shape_kind === "box" && shape.half_extents_m !== undefined) {
    return shape.half_extents_m;
  }
  if (shape.shape_kind === "sphere" && shape.radius_m !== undefined) {
    return [shape.radius_m, shape.radius_m, shape.radius_m];
  }
  if ((shape.shape_kind === "cylinder" || shape.shape_kind === "capsule") && shape.radius_m !== undefined && shape.height_m !== undefined) {
    const z = shape.shape_kind === "capsule" ? shape.height_m / 2 + shape.radius_m : shape.height_m / 2;
    return [shape.radius_m, shape.radius_m, z];
  }
  return [DEFAULT_COLLISION_RADIUS_M, DEFAULT_COLLISION_RADIUS_M, DEFAULT_COLLISION_RADIUS_M];
}

function hitRecord(targetRef: Ref, obstacle: CollisionProxy, nearestPoint: Vector3, clearance: number, requiredClearance: number): PhysicsHitRecord {
  return Object.freeze({
    target_ref: targetRef,
    obstacle_ref: obstacle.object_ref,
    query_geometry: "capsule",
    nearest_point_m: freezeVector3(nearestPoint),
    clearance_m: clearance,
    penetration_depth_m: Math.max(0, -clearance),
    collision_shape_refs: obstacle.collision_shape_refs,
    qa_mesh_refs: obstacle.qa_mesh_refs,
    risk: clearance < 0 ? "intersecting" : clearance < requiredClearance ? "near" : "clear",
  });
}

function aabbSeparation(a: CollisionProxy, b: CollisionProxy): number {
  const dx = Math.max(0, Math.abs(a.center_m[0] - b.center_m[0]) - (a.half_extents_m[0] + b.half_extents_m[0]));
  const dy = Math.max(0, Math.abs(a.center_m[1] - b.center_m[1]) - (a.half_extents_m[1] + b.half_extents_m[1]));
  const dz = Math.max(0, Math.abs(a.center_m[2] - b.center_m[2]) - (a.half_extents_m[2] + b.half_extents_m[2]));
  if (dx > 0 || dy > 0 || dz > 0) {
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const overlapX = a.half_extents_m[0] + b.half_extents_m[0] - Math.abs(a.center_m[0] - b.center_m[0]);
  const overlapY = a.half_extents_m[1] + b.half_extents_m[1] - Math.abs(a.center_m[1] - b.center_m[1]);
  const overlapZ = a.half_extents_m[2] + b.half_extents_m[2] - Math.abs(a.center_m[2] - b.center_m[2]);
  return -Math.min(overlapX, overlapY, overlapZ);
}

function closestPointOnSegment(point: Vector3, a: Vector3, b: Vector3): Vector3 {
  const ab = subtractVector3(b, a);
  const denominator = dotVector3(ab, ab);
  if (denominator < 1e-12) {
    return freezeVector3(a);
  }
  const t = Math.max(0, Math.min(1, dotVector3(subtractVector3(point, a), ab) / denominator));
  return addVector3(a, scaleVector3(ab, t));
}

function sampleSegment(a: Vector3, b: Vector3, sampleCount: number): readonly Vector3[] {
  const samples: Vector3[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const t = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    samples.push(addVector3(a, scaleVector3(subtractVector3(b, a), t)));
  }
  return freezeArray(samples.map(freezeVector3));
}

function convexHull2D(points: readonly Vector3[]): readonly Vector3[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Vector3[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross2D(subtractVector3(lower[lower.length - 1], lower[lower.length - 2]), subtractVector3(point, lower[lower.length - 1])) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vector3[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross2D(subtractVector3(upper[upper.length - 1], upper[upper.length - 2]), subtractVector3(point, upper[upper.length - 1])) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  return freezeArray([...lower.slice(0, -1), ...upper.slice(0, -1)].map(freezeVector3));
}

function signedDistanceToConvexPolygon2D(point: Vector3, polygon: readonly Vector3[]): number {
  let inside = true;
  let minimumEdgeDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const edge = subtractVector3(b, a);
    const toPoint = subtractVector3(point, a);
    const cross = cross2D(edge, toPoint);
    if (cross < -1e-10) {
      inside = false;
    }
    minimumEdgeDistance = Math.min(minimumEdgeDistance, distancePointToSegment2D(point, a, b));
  }
  return inside ? minimumEdgeDistance : -minimumEdgeDistance;
}

function distancePointToSegment2D(point: Vector3, a: Vector3, b: Vector3): number {
  const ab = [b[0] - a[0], b[1] - a[1], 0] as Vector3;
  const denominator = dotVector3(ab, ab);
  const t = denominator < 1e-12 ? 0 : Math.max(0, Math.min(1, (((point[0] - a[0]) * ab[0]) + ((point[1] - a[1]) * ab[1])) / denominator));
  const nearest: Vector3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, 0];
  return Math.hypot(point[0] - nearest[0], point[1] - nearest[1]);
}

function polygonArea2D(points: readonly Vector3[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  return addVector3(transform.position_m, point);
}

function promptSafeSummary(validator: PhysicsValidatorResult): string {
  if (validator.decision === "safe_hold_required") {
    return "A high-risk physical condition was detected; pause motion and enter safety review.";
  }
  if (validator.decision === "blocked") {
    return "The proposed physical action is unsafe or infeasible and should be revised.";
  }
  if (validator.decision === "warning") {
    return "The proposed physical action has low margin and should be adjusted or rechecked.";
  }
  return "The privileged validator did not detect a blocking physical issue.";
}

function actionHint(validator: PhysicsValidatorResult): PhysicsSanitizedSummary["action_hint"] {
  if (validator.decision === "safe_hold_required") {
    return "safe_hold";
  }
  if (validator.reach?.recommended_recovery !== undefined) {
    if (validator.reach.recommended_recovery === "safe_hold") {
      return "safe_hold";
    }
    if (validator.reach.recommended_recovery === "human_review") {
      return "human_review";
    }
    if (validator.reach.recommended_recovery === "reobserve") {
      return "reobserve";
    }
    return "reposition";
  }
  if (validator.maximum_impulse_n_s !== undefined && validator.maximum_impulse_n_s >= DEFAULT_HIGH_IMPULSE_N_S) {
    return "reduce_force";
  }
  if (validator.decision === "blocked") {
    return "adjust_path";
  }
  if (validator.decision === "warning") {
    return "reobserve";
  }
  return "continue";
}

function distanceBand(validator: PhysicsValidatorResult): PhysicsSanitizedSummary["distance_band"] | undefined {
  if (validator.minimum_clearance_m === undefined) {
    return undefined;
  }
  if (validator.minimum_clearance_m < 0) {
    return "blocked";
  }
  if (validator.minimum_clearance_m < DEFAULT_CLEARANCE_REQUIRED_M) {
    return "collision_risk";
  }
  if (validator.minimum_clearance_m < DEFAULT_WARNING_CLEARANCE_M) {
    return "low_clearance";
  }
  return "clear";
}

function reasonClassesForDecision(decision: PhysicsQueryDecision, baseReason: string): readonly string[] {
  if (decision === "clear") {
    return freezeArray([`${baseReason}_clear`]);
  }
  if (decision === "warning") {
    return freezeArray([baseReason, "low_physical_margin"]);
  }
  if (decision === "safe_hold_required") {
    return freezeArray([baseReason, "safe_hold_required"]);
  }
  return freezeArray([baseReason, "physical_action_blocked"]);
}

function safetyFromDecision(decision: PhysicsQueryDecision): PhysicsSafetyRelevance {
  if (decision === "safe_hold_required") {
    return "safe_hold";
  }
  if (decision === "blocked") {
    return "block";
  }
  if (decision === "warning") {
    return "warning";
  }
  return "none";
}

function maxContactSafety(a: ContactSafetyRelevance, b: ContactSafetyRelevance): ContactSafetyRelevance {
  const rank: Record<ContactSafetyRelevance, number> = { none: 0, monitor: 1, warning: 2, safe_hold: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function hiddenFieldsForQuery(queryType: PhysicsQueryType): readonly HiddenFieldCategory[] {
  const base: HiddenFieldCategory[] = ["target_refs", "object_refs", "exact_hidden_poses", "determinism_hashes"];
  if (queryType === "exact_mesh_intersection") {
    base.push("mesh_refs", "collision_shape_refs", "qa_truth");
  }
  if (queryType === "contact_impulse_check") {
    base.push("body_refs", "contact_impulses", "collision_shape_refs");
  }
  if (queryType === "qa_truth_inspection") {
    base.push("qa_truth", "replay_refs");
  }
  if (queryType === "minimum_distance_to_obstacle" || queryType === "pre_motion_collision_sweep" || queryType === "tool_swept_volume") {
    base.push("exact_distances", "collision_shape_refs");
  }
  return freezeArray([...new Set(base)]);
}

function hiddenFieldsForSanitizedSummary(queryType: PhysicsQueryType): readonly HiddenFieldCategory[] {
  return freezeArray([...hiddenFieldsForQuery(queryType), "mesh_refs", "qa_truth"]);
}

function mergeAuthorizationPolicy(
  defaults: Partial<PhysicsAuthorizationPolicy> | undefined,
  override: Partial<PhysicsAuthorizationPolicy>,
): PhysicsAuthorizationPolicy {
  return Object.freeze({
    allowed_components: override.allowed_components ?? defaults?.allowed_components ?? freezeArray(Object.keys(defaultComponentAllowlist()) as PrivilegedQueryComponent[]),
    allowed_query_types: override.allowed_query_types ?? defaults?.allowed_query_types ?? freezeArray([
      "pre_motion_collision_sweep",
      "minimum_distance_to_obstacle",
      "contact_impulse_check",
      "tool_swept_volume",
      "reach_feasibility",
      "stability_check",
      "timing_health_check",
    ]),
    allowed_destinations: override.allowed_destinations ?? defaults?.allowed_destinations ?? freezeArray(["internal_validator", "safety", "qa_report", "sanitized_repair"]),
    component_query_allowlist: override.component_query_allowlist ?? defaults?.component_query_allowlist,
    allow_exact_mesh_queries: override.allow_exact_mesh_queries ?? defaults?.allow_exact_mesh_queries ?? false,
    allow_qa_truth: override.allow_qa_truth ?? defaults?.allow_qa_truth ?? false,
    require_sanitization_for_model_destinations: override.require_sanitization_for_model_destinations ?? defaults?.require_sanitization_for_model_destinations ?? true,
  });
}

function mergeSanitizationPolicy(
  destination: PhysicsQueryDestination,
  defaults: Partial<PhysicsSanitizationPolicy> | undefined,
  override: Partial<PhysicsSanitizationPolicy>,
): PhysicsSanitizationPolicy {
  return Object.freeze({
    destination: override.destination ?? defaults?.destination ?? destination,
    include_sanitized_summary: override.include_sanitized_summary ?? defaults?.include_sanitized_summary ?? destination === "sanitized_repair",
    remove_internal_refs: override.remove_internal_refs ?? defaults?.remove_internal_refs ?? true,
    remove_exact_hidden_poses: override.remove_exact_hidden_poses ?? defaults?.remove_exact_hidden_poses ?? true,
    remove_mesh_ids: override.remove_mesh_ids ?? defaults?.remove_mesh_ids ?? true,
    remove_qa_truth: override.remove_qa_truth ?? defaults?.remove_qa_truth ?? true,
    disclose_distance_bands_only: override.disclose_distance_bands_only ?? defaults?.disclose_distance_bands_only ?? true,
    max_reason_count: override.max_reason_count ?? defaults?.max_reason_count ?? 3,
  });
}

function defaultComponentAllowlist(): Readonly<Record<PrivilegedQueryComponent, readonly PhysicsQueryType[]>> {
  return Object.freeze({
    PlanValidationService: freezeArray<PhysicsQueryType>(["pre_motion_collision_sweep", "minimum_distance_to_obstacle", "reach_feasibility", "stability_check"]),
    SafetyManager: freezeArray<PhysicsQueryType>(["pre_motion_collision_sweep", "minimum_distance_to_obstacle", "contact_impulse_check", "tool_swept_volume", "reach_feasibility", "stability_check", "timing_health_check"]),
    VerificationEngine: freezeArray<PhysicsQueryType>(["pre_motion_collision_sweep", "minimum_distance_to_obstacle", "reach_feasibility", "stability_check", "timing_health_check"]),
    QAReportAssembler: freezeArray<PhysicsQueryType>(["pre_motion_collision_sweep", "exact_mesh_intersection", "minimum_distance_to_obstacle", "contact_impulse_check", "tool_swept_volume", "reach_feasibility", "stability_check", "timing_health_check", "qa_truth_inspection"]),
    PhysicsHealthMonitor: freezeArray<PhysicsQueryType>(["exact_mesh_intersection", "contact_impulse_check", "timing_health_check", "qa_truth_inspection"]),
    ToolValidator: freezeArray<PhysicsQueryType>(["tool_swept_volume", "minimum_distance_to_obstacle", "pre_motion_collision_sweep"]),
    OopsLoopSanitizer: freezeArray<PhysicsQueryType>(["contact_impulse_check", "minimum_distance_to_obstacle", "stability_check"]),
  });
}

function validateQueryRequest(request: PhysicsQueryRequest): void {
  const issues: ValidationIssue[] = [];
  validateRef(request.query_id, issues, "$.query_id", "QueryRequestInvalid");
  if (request.query_type !== request.payload.query_type) {
    issues.push(makeIssue("error", "QueryRequestInvalid", "$.payload.query_type", "Request query_type must match payload query_type.", "Use a single declared query type for the request."));
  }
  if (!Number.isInteger(request.world_snapshot.physics_tick) || request.world_snapshot.physics_tick < 0) {
    issues.push(makeIssue("error", "QueryRequestInvalid", "$.world_snapshot.physics_tick", "Snapshot physics tick must be a nonnegative integer.", "Use a current PhysicsWorldSnapshot."));
  }
  if (request.time_scope.kind === "current_tick" && request.time_scope.physics_tick !== undefined && request.time_scope.physics_tick !== request.world_snapshot.physics_tick) {
    issues.push(makeIssue("warning", "QueryRequestInvalid", "$.time_scope.physics_tick", "Current tick scope differs from snapshot tick.", "Use the snapshot tick for current-tick validation."));
  }
  if (request.target_refs !== undefined) {
    for (let index = 0; index < request.target_refs.length; index += 1) {
      validateRef(request.target_refs[index], issues, `$.target_refs[${index}]`, "QueryRequestInvalid");
    }
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new PhysicsQueryServiceError("Physics query request failed validation.", issues);
  }
}

function freezeValidator(input: PhysicsValidatorResult): PhysicsValidatorResult {
  return Object.freeze({
    ...input,
    reason_classes: freezeArray(input.reason_classes),
  });
}

function compareHits(a: PhysicsHitRecord, b: PhysicsHitRecord): number {
  return a.clearance_m - b.clearance_m || a.target_ref.localeCompare(b.target_ref) || a.obstacle_ref.localeCompare(b.obstacle_ref);
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

function distanceVector(a: Vector3, b: Vector3): number {
  return vectorNorm(subtractVector3(a, b));
}

function midpoint(a: Vector3, b: Vector3): Vector3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function cross2D(a: Vector3, b: Vector3): number {
  return a[0] * b[1] - a[1] * b[0];
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Expected a positive finite number.");
  }
  return value;
}

function nonNegativeOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Expected a nonnegative finite number.");
  }
  return value;
}

function validateVector3(value: Vector3, path: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new PhysicsQueryServiceError("Physics query vector failed validation.", [
      makeIssue("error", "QueryPayloadInvalid", path, "Vector3 must contain exactly three finite numeric values.", "Use [x, y, z] in meters."),
    ]);
  }
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: PhysicsQueryValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque simulator ref."));
  }
}

function makeIssue(severity: ValidationSeverity, code: PhysicsQueryValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function freezeVector3(value: Vector3): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as unknown as Vector3;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
