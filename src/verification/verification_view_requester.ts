/**
 * Verification view requester for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.5, 13.6.3, 13.8.2, 13.10.3, 13.10.5, 13.14, and
 * 13.18.
 *
 * The requester converts policy-level evidence requirements into a concrete
 * embodied view plan. It chooses camera views, crop targets, safe body
 * adjustments, and reobserve notes without using hidden simulator state.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import type { CanonicalViewName } from "../perception/view_name_registry";
import {
  freezeArray,
  HIDDEN_VERIFICATION_PATTERN,
  makeIssue,
  makeRef,
  sanitizeRef,
  sanitizeText,
  uniqueSorted,
  validateSafeRef,
  type VerificationConstraintClass,
  type VerificationPolicy,
  type VerificationPolicyIssueCode,
  type VerificationRequest,
} from "./verification_policy_registry";

export const VERIFICATION_VIEW_REQUESTER_SCHEMA_VERSION = "mebsuta.verification_view_requester.v1" as const;

export type VerificationViewPlanDecision = "planned" | "planned_with_warnings" | "reobserve_needed" | "safe_hold_required" | "rejected";
export type VerificationViewAction = "capture_views" | "capture_with_adjustment" | "reobserve_target" | "safe_hold" | "repair_view_plan";

export interface AvailableVerificationSensor {
  readonly sensor_ref: Ref;
  readonly view_name: CanonicalViewName;
  readonly sensor_kind: "camera" | "depth_camera" | "wrist_camera" | "head_camera" | "body_camera";
  readonly healthy: boolean;
  readonly supports_depth: boolean;
  readonly supports_crop: boolean;
}

export interface VerificationOcclusionHint {
  readonly hint_ref: Ref;
  readonly constraint_ref?: Ref;
  readonly affected_view?: CanonicalViewName;
  readonly affected_constraint_class?: VerificationConstraintClass;
  readonly severity: "none" | "partial" | "blocking";
  readonly summary: string;
}

export interface VerificationViewRequest {
  readonly request_ref?: Ref;
  readonly verification_request: VerificationRequest;
  readonly policy: VerificationPolicy;
  readonly available_sensors: readonly AvailableVerificationSensor[];
  readonly occlusion_hints?: readonly VerificationOcclusionHint[];
  readonly preferred_crop_refs?: readonly Ref[];
}

export interface VerificationViewPlanItem {
  readonly item_ref: Ref;
  readonly view_name: CanonicalViewName;
  readonly sensor_ref?: Ref;
  readonly required: boolean;
  readonly reason: string;
  readonly supports_constraint_refs: readonly Ref[];
  readonly requires_depth: boolean;
  readonly crop_refs: readonly Ref[];
  readonly body_adjustment?: string;
}

export interface VerificationViewPlan {
  readonly schema_version: typeof VERIFICATION_VIEW_REQUESTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly view_plan_ref: Ref;
  readonly request_ref: Ref;
  readonly required_views: readonly VerificationViewPlanItem[];
  readonly optional_views: readonly VerificationViewPlanItem[];
  readonly missing_required_views: readonly CanonicalViewName[];
  readonly allowed_body_adjustments: readonly string[];
  readonly forbidden_scene_disturbances: readonly string[];
  readonly sync_policy: "tight_sync_required" | "bounded_skew_allowed";
  readonly maximum_capture_latency_ms: number;
  readonly determinism_hash: string;
}

export interface VerificationViewRequesterReport {
  readonly schema_version: typeof VERIFICATION_VIEW_REQUESTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: VerificationViewPlanDecision;
  readonly recommended_action: VerificationViewAction;
  readonly view_plan?: VerificationViewPlan;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "verification_view_requester_report";
  readonly determinism_hash: string;
}

/**
 * Builds deterministic view acquisition plans for verification.
 */
export class VerificationViewRequester {
  /**
   * Selects required and optional embodied views for the active policy.
   */
  public planVerificationViews(request: VerificationViewRequest): VerificationViewRequesterReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("verification_view_request", request.verification_request.verification_request_ref));
    validateRequest(request, issues);
    const requiredItems = buildItems(request, true, issues);
    const optionalItems = buildItems(request, false, issues);
    const missing = uniqueSorted(requiredItems.filter((item) => item.sensor_ref === undefined).map((item) => item.view_name));
    const decision = decide(request, missing, issues);
    const viewPlan = decision === "rejected" || decision === "safe_hold_required" ? undefined : buildPlan(request, requestRef, requiredItems, optionalItems, missing);
    const base = {
      schema_version: VERIFICATION_VIEW_REQUESTER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("verification_view_requester_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision, viewPlan),
      view_plan: viewPlan,
      issues: freezeArray(issues),
      ok: viewPlan !== undefined && (decision === "planned" || decision === "planned_with_warnings"),
      cognitive_visibility: "verification_view_requester_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createVerificationViewRequester(): VerificationViewRequester {
  return new VerificationViewRequester();
}

function buildPlan(
  request: VerificationViewRequest,
  requestRef: Ref,
  requiredItems: readonly VerificationViewPlanItem[],
  optionalItems: readonly VerificationViewPlanItem[],
  missing: readonly CanonicalViewName[],
): VerificationViewPlan {
  const adjustments = uniqueSorted(request.policy.view_requirements.flatMap((requirement) => requirement.allowed_body_adjustments));
  const base = {
    schema_version: VERIFICATION_VIEW_REQUESTER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
    view_plan_ref: makeRef("verification_view_plan", requestRef, requiredItems.map((item) => item.view_name).join(":")),
    request_ref: request.verification_request.verification_request_ref,
    required_views: freezeArray(requiredItems),
    optional_views: freezeArray(optionalItems),
    missing_required_views: missing,
    allowed_body_adjustments: freezeArray(adjustments),
    forbidden_scene_disturbances: freezeArray(["move_target_object", "apply_unverified_tool_force", "use_qa_truth"]),
    sync_policy: request.policy.maximum_verification_latency_ms <= 3200 ? "tight_sync_required" as const : "bounded_skew_allowed" as const,
    maximum_capture_latency_ms: request.policy.maximum_verification_latency_ms,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildItems(request: VerificationViewRequest, required: boolean, issues: ValidationIssue[]): readonly VerificationViewPlanItem[] {
  const rows: VerificationViewPlanItem[] = [];
  for (const requirement of request.policy.view_requirements) {
    const viewNames = required ? requirement.required_views : requirement.optional_views;
    for (const viewName of viewNames) {
      const sensor = bestSensorFor(viewName, requirement.requires_depth, request.available_sensors);
      const blocked = isViewBlocked(viewName, requirement.constraint_class, request.occlusion_hints ?? []);
      const constraintRefs = request.policy.required_constraints
        .filter((constraint) => constraint.constraint_class === requirement.constraint_class)
        .map((constraint) => constraint.constraint_ref);
      if (required && sensor === undefined) {
        issues.push(makeIssue("warning", "ViewPolicyMissing", `$.view_requirements.${viewName}`, "Required embodied view is not available from the sensor set.", "Use a safe body adjustment or alternate camera."));
      }
      if (blocked) {
        issues.push(makeIssue("warning", "ViewPolicyMissing", `$.occlusion_hints.${viewName}`, "Required relation is occluded in this view.", "Plan a reobserve view before final certification."));
      }
      rows.push(Object.freeze({
        item_ref: makeRef("verification_view_item", viewName, requirement.constraint_class, required ? "required" : "optional"),
        view_name: viewName,
        sensor_ref: sensor?.sensor_ref,
        required,
        reason: reasonFor(requirement.constraint_class, required, blocked, sensor),
        supports_constraint_refs: freezeArray(constraintRefs.sort()),
        requires_depth: requirement.requires_depth,
        crop_refs: freezeArray((request.preferred_crop_refs ?? []).map(sanitizeRef).sort()),
        body_adjustment: sensor === undefined || blocked ? requirement.allowed_body_adjustments[0] : undefined,
      }));
    }
  }
  return freezeArray(dedupeItems(rows));
}

function validateRequest(request: VerificationViewRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.verification_request.verification_request_ref, "$.verification_request.verification_request_ref", "HiddenVerificationLeak", issues);
  for (const sensor of request.available_sensors) {
    validateSafeRef(sensor.sensor_ref, "$.available_sensors.sensor_ref", "HiddenVerificationLeak", issues);
  }
  for (const hint of request.occlusion_hints ?? []) {
    validateSafeRef(hint.hint_ref, "$.occlusion_hints.hint_ref", "HiddenVerificationLeak", issues);
    if (hint.summary.trim().length === 0 || HIDDEN_VERIFICATION_PATTERN.test(hint.summary)) {
      issues.push(makeIssue("error", "HiddenVerificationLeak", "$.occlusion_hints.summary", "Occlusion hints must be prompt-safe embodied summaries.", "Remove hidden wording from occlusion notes."));
    }
  }
  for (const ref of request.preferred_crop_refs ?? []) validateSafeRef(ref, "$.preferred_crop_refs", "HiddenVerificationLeak", issues);
}

function decide(
  request: VerificationViewRequest,
  missing: readonly CanonicalViewName[],
  issues: readonly ValidationIssue[],
): VerificationViewPlanDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.verification_request.controller_completion_summary.high_force_contact) return "safe_hold_required";
  if (missing.length > 0 || (request.occlusion_hints ?? []).some((hint) => hint.severity === "blocking")) return "reobserve_needed";
  return issues.length > 0 ? "planned_with_warnings" : "planned";
}

function recommend(decision: VerificationViewPlanDecision, plan: VerificationViewPlan | undefined): VerificationViewAction {
  if (decision === "planned") return "capture_views";
  if (decision === "planned_with_warnings") return plan?.allowed_body_adjustments.length ? "capture_with_adjustment" : "capture_views";
  if (decision === "reobserve_needed") return "reobserve_target";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_view_plan";
}

function bestSensorFor(
  viewName: CanonicalViewName,
  requiresDepth: boolean,
  sensors: readonly AvailableVerificationSensor[],
): AvailableVerificationSensor | undefined {
  return sensors
    .filter((sensor) => sensor.view_name === viewName && sensor.healthy && (!requiresDepth || sensor.supports_depth))
    .sort((a, b) => Number(b.supports_crop) - Number(a.supports_crop) || a.sensor_ref.localeCompare(b.sensor_ref))[0];
}

function isViewBlocked(
  viewName: CanonicalViewName,
  constraintClass: VerificationConstraintClass,
  hints: readonly VerificationOcclusionHint[],
): boolean {
  return hints.some((hint) =>
    hint.severity === "blocking" &&
    (hint.affected_view === undefined || hint.affected_view === viewName) &&
    (hint.affected_constraint_class === undefined || hint.affected_constraint_class === constraintClass),
  );
}

function reasonFor(
  constraintClass: VerificationConstraintClass,
  required: boolean,
  blocked: boolean,
  sensor: AvailableVerificationSensor | undefined,
): string {
  if (sensor === undefined) return sanitizeText(`${constraintClass} ${required ? "required" : "optional"} view needs a safe camera adjustment.`);
  if (blocked) return sanitizeText(`${constraintClass} view is available but relation occlusion requires reobserve.`);
  return sanitizeText(`${constraintClass} view selected from ${sensor.sensor_kind}.`);
}

function dedupeItems(items: readonly VerificationViewPlanItem[]): readonly VerificationViewPlanItem[] {
  const byKey = new Map<string, VerificationViewPlanItem>();
  for (const item of items) {
    const key = `${item.view_name}:${item.required}:${item.requires_depth}`;
    const existing = byKey.get(key);
    if (existing === undefined || (existing.sensor_ref === undefined && item.sensor_ref !== undefined)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => a.view_name.localeCompare(b.view_name) || Number(b.required) - Number(a.required));
}

type _IssueCodeCheck = VerificationPolicyIssueCode;
