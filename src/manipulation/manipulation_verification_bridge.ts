/**
 * Manipulation verification bridge for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.9, 12.10, 12.11, 12.13, 12.14, 12.15,
 * 12.17, and 12.18.
 *
 * This bridge converts manipulation postcondition results into verification
 * packets for placement, release, retreat, and tool-effect checks. It keeps
 * the verifier simulation-blind by carrying only sensor-derived evidence refs,
 * residual refs, target frame refs, explicit ambiguity reasons, and bounded
 * success criteria.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  ManipulationPrimitiveDescriptor,
  ManipulationVerificationHook,
} from "./manipulation_primitive_catalog";
import type { PrimitivePostconditionReport } from "./primitive_postcondition_evaluator";

export const MANIPULATION_VERIFICATION_BRIDGE_SCHEMA_VERSION = "mebsuta.manipulation_verification_bridge.v1" as const;

const HIDDEN_VERIFICATION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type ManipulationVerificationBridgeDecision = "verification_packet_ready" | "verification_packet_constrained" | "reobserve_required" | "correct_required" | "safe_hold_required" | "rejected";
export type ManipulationVerificationBridgeAction = "send_to_verifier" | "send_with_ambiguity" | "collect_alternate_view" | "route_to_correct" | "safe_hold" | "repair_verification_packet";
export type ManipulationVerificationIssueCode =
  | "PostconditionNotVerifiable"
  | "VerificationViewMissing"
  | "TargetFrameMissing"
  | "EvidenceMissing"
  | "AmbiguityUnbounded"
  | "HiddenVerificationLeak";

export interface ManipulationVerificationCriterion {
  readonly criterion_ref: Ref;
  readonly name: "placement_residual" | "release_settle" | "retreat_clearance" | "tool_effect" | "grip_or_contact_state";
  readonly required: boolean;
  readonly tolerance_m?: number;
  readonly settle_window_s?: number;
  readonly evidence_refs: readonly Ref[];
  readonly ambiguity_allowed: boolean;
}

export interface ManipulationVerificationBridgeRequest {
  readonly request_ref?: Ref;
  readonly postcondition_report: PrimitivePostconditionReport;
  readonly target_frame_refs: readonly Ref[];
  readonly verification_view_refs: readonly Ref[];
  readonly alternate_view_refs?: readonly Ref[];
  readonly ambiguity_reasons?: readonly string[];
  readonly criterion_overrides?: readonly ManipulationVerificationCriterion[];
}

export interface ManipulationVerificationPacket {
  readonly schema_version: typeof MANIPULATION_VERIFICATION_BRIDGE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly verification_packet_ref: Ref;
  readonly source_postcondition_report_ref: Ref;
  readonly primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveDescriptor["primitive_name"];
  readonly verification_hook: ManipulationVerificationHook;
  readonly target_frame_refs: readonly Ref[];
  readonly visual_evidence_refs: readonly Ref[];
  readonly contact_report_ref?: Ref;
  readonly residual_report_refs: readonly Ref[];
  readonly criteria: readonly ManipulationVerificationCriterion[];
  readonly ambiguity_reasons: readonly string[];
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface ManipulationVerificationBridgeReport {
  readonly schema_version: typeof MANIPULATION_VERIFICATION_BRIDGE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ManipulationVerificationBridgeDecision;
  readonly recommended_action: ManipulationVerificationBridgeAction;
  readonly packet?: ManipulationVerificationPacket;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "manipulation_verification_bridge_report";
  readonly determinism_hash: string;
}

/**
 * Builds verifier-facing packets from manipulation postconditions.
 */
export class ManipulationVerificationBridge {
  /**
   * Routes placement, release, retreat, and tool-effect results to verification.
   */
  public buildVerificationPacket(request: ManipulationVerificationBridgeRequest): ManipulationVerificationBridgeReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `manipulation_verification_bridge_${computeDeterminismHash({
      primitive: request.postcondition_report.primitive_ref,
      postcondition: request.postcondition_report.report_ref,
    })}`);
    validateRequest(request, issues);
    const criteria = freezeArray((request.criterion_overrides ?? defaultCriteria(request)).map((criterion, index) => normalizeCriterion(criterion, index, issues)));
    const decision = decide(request, criteria, issues);
    const packet = decision === "rejected" || decision === "safe_hold_required" || decision === "correct_required"
      ? undefined
      : buildPacket(request, criteria);
    const base = {
      schema_version: MANIPULATION_VERIFICATION_BRIDGE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `manipulation_verification_bridge_report_${computeDeterminismHash({
        requestRef,
        decision,
        packet: packet?.verification_packet_ref,
      })}`,
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      packet,
      issues: freezeArray(issues),
      ok: packet !== undefined && (decision === "verification_packet_ready" || decision === "verification_packet_constrained"),
      cognitive_visibility: "manipulation_verification_bridge_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createManipulationVerificationBridge(): ManipulationVerificationBridge {
  return new ManipulationVerificationBridge();
}

function buildPacket(
  request: ManipulationVerificationBridgeRequest,
  criteria: readonly ManipulationVerificationCriterion[],
): ManipulationVerificationPacket {
  const visualRefs = freezeArray(uniqueSorted([
    ...request.postcondition_report.visual_evidence_refs,
    ...request.verification_view_refs,
    ...request.alternate_view_refs ?? [],
  ].map(sanitizeRef)));
  const ambiguity = freezeArray(uniqueSorted((request.ambiguity_reasons ?? []).map(sanitizeText)));
  const base = {
    schema_version: MANIPULATION_VERIFICATION_BRIDGE_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
    verification_packet_ref: `manipulation_verification_packet_${computeDeterminismHash({
      postcondition: request.postcondition_report.report_ref,
      frames: request.target_frame_refs,
      criteria: criteria.map((criterion) => criterion.criterion_ref),
    })}`,
    source_postcondition_report_ref: request.postcondition_report.report_ref,
    primitive_ref: request.postcondition_report.primitive_ref,
    primitive_name: request.postcondition_report.primitive_name,
    verification_hook: request.postcondition_report.verification_hook,
    target_frame_refs: freezeArray(uniqueSorted(request.target_frame_refs.map(sanitizeRef))),
    visual_evidence_refs: visualRefs,
    contact_report_ref: request.postcondition_report.contact_report_ref,
    residual_report_refs: request.postcondition_report.residual_report_refs,
    criteria,
    ambiguity_reasons: ambiguity,
    prompt_safe_summary: sanitizeText(`${request.postcondition_report.primitive_name ?? request.postcondition_report.primitive_ref} verification packet uses hook ${request.postcondition_report.verification_hook} with ${criteria.length} criteria.`),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function defaultCriteria(request: ManipulationVerificationBridgeRequest): readonly ManipulationVerificationCriterion[] {
  const hook = request.postcondition_report.verification_hook;
  const refs = freezeArray(uniqueSorted([
    ...request.postcondition_report.visual_evidence_refs,
    ...request.postcondition_report.residual_report_refs,
    ...request.verification_view_refs,
  ]));
  if (hook === "placement_candidate" || hook === "release_settled") {
    return freezeArray([
      criterion("placement_residual", true, refs, 0.035, hook === "release_settled" ? 0.45 : 0.25),
      criterion("release_settle", hook === "release_settled", refs, 0.025, 0.45),
      criterion("retreat_clearance", hook === "release_settled", refs, 0.04, 0.2),
    ]);
  }
  if (hook === "tool_effect_verified") {
    return freezeArray([
      criterion("tool_effect", true, refs, 0.04, 0.3),
      criterion("retreat_clearance", false, refs, 0.04, 0.2),
    ]);
  }
  if (hook === "grasp_confirmed" || hook === "contact_confirmed" || hook === "lift_settled" || hook === "carry_stable") {
    return freezeArray([criterion("grip_or_contact_state", true, refs, undefined, 0.28)]);
  }
  return freezeArray([criterion("retreat_clearance", false, refs, 0.05, 0.2)]);
}

function criterion(
  name: ManipulationVerificationCriterion["name"],
  required: boolean,
  refs: readonly Ref[],
  toleranceM: number | undefined,
  settleWindowS: number | undefined,
): ManipulationVerificationCriterion {
  return Object.freeze({
    criterion_ref: `verification_${name}`,
    name,
    required,
    tolerance_m: toleranceM,
    settle_window_s: settleWindowS,
    evidence_refs: freezeArray(uniqueSorted(refs.map(sanitizeRef))),
    ambiguity_allowed: !required,
  });
}

function normalizeCriterion(
  criterionInput: ManipulationVerificationCriterion,
  index: number,
  issues: ValidationIssue[],
): ManipulationVerificationCriterion {
  validateRef(criterionInput.criterion_ref, `$.criteria.${index}.criterion_ref`, "HiddenVerificationLeak", issues);
  for (const ref of criterionInput.evidence_refs) validateRef(ref, `$.criteria.${index}.evidence_refs`, "HiddenVerificationLeak", issues);
  if (criterionInput.required && criterionInput.evidence_refs.length === 0) {
    issues.push(makeIssue("warning", "EvidenceMissing", `$.criteria.${index}.evidence_refs`, "Required verification criterion has no evidence refs.", "Attach visual, residual, or contact evidence before verification."));
  }
  if (criterionInput.tolerance_m !== undefined && (!Number.isFinite(criterionInput.tolerance_m) || criterionInput.tolerance_m <= 0)) {
    issues.push(makeIssue("error", "AmbiguityUnbounded", `$.criteria.${index}.tolerance_m`, "Verification tolerance must be positive when provided.", "Use a finite manipulation tolerance."));
  }
  return Object.freeze({
    ...criterionInput,
    criterion_ref: sanitizeRef(criterionInput.criterion_ref),
    evidence_refs: freezeArray(uniqueSorted(criterionInput.evidence_refs.map(sanitizeRef))),
  });
}

function validateRequest(request: ManipulationVerificationBridgeRequest, issues: ValidationIssue[]): void {
  validateRef(request.postcondition_report.report_ref, "$.postcondition_report.report_ref", "HiddenVerificationLeak", issues);
  validateRef(request.postcondition_report.primitive_ref, "$.postcondition_report.primitive_ref", "HiddenVerificationLeak", issues);
  for (const ref of request.target_frame_refs) validateRef(ref, "$.target_frame_refs", "HiddenVerificationLeak", issues);
  for (const ref of request.verification_view_refs) validateRef(ref, "$.verification_view_refs", "HiddenVerificationLeak", issues);
  for (const ref of request.alternate_view_refs ?? []) validateRef(ref, "$.alternate_view_refs", "HiddenVerificationLeak", issues);
  for (const reason of request.ambiguity_reasons ?? []) {
    if (HIDDEN_VERIFICATION_PATTERN.test(reason)) {
      issues.push(makeIssue("error", "HiddenVerificationLeak", "$.ambiguity_reasons", "Ambiguity reason contains forbidden hidden detail.", "Use sensor-derived ambiguity wording."));
    }
  }
  if (request.postcondition_report.decision === "correct_required") {
    issues.push(makeIssue("error", "PostconditionNotVerifiable", "$.postcondition_report.decision", "Postcondition report requires correction before verification.", "Route to correction instead of verification."));
  }
  if (request.postcondition_report.decision === "safe_hold_required" || request.postcondition_report.decision === "rejected") {
    issues.push(makeIssue("error", "PostconditionNotVerifiable", "$.postcondition_report.decision", "Postcondition report is not verifiable.", "Repair or safe-hold before verification."));
  }
  if (request.target_frame_refs.length === 0 && request.postcondition_report.verification_hook !== "none") {
    issues.push(makeIssue("warning", "TargetFrameMissing", "$.target_frame_refs", "Verification hook has no target frame refs.", "Attach target or placement frame refs."));
  }
  if (request.verification_view_refs.length === 0 && request.alternate_view_refs?.length !== undefined && request.alternate_view_refs.length === 0) {
    issues.push(makeIssue("warning", "VerificationViewMissing", "$.verification_view_refs", "No verification or alternate view refs are available.", "Collect unobstructed or explicitly ambiguous verification evidence."));
  }
}

function decide(
  request: ManipulationVerificationBridgeRequest,
  criteria: readonly ManipulationVerificationCriterion[],
  issues: readonly ValidationIssue[],
): ManipulationVerificationBridgeDecision {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "PostconditionNotVerifiable")) {
    if (request.postcondition_report.decision === "safe_hold_required" || request.postcondition_report.decision === "rejected") return "safe_hold_required";
    return "correct_required";
  }
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (issues.some((issue) => issue.code === "VerificationViewMissing" || issue.code === "EvidenceMissing") || criteria.some((item) => item.required && item.evidence_refs.length === 0)) return "reobserve_required";
  return issues.length > 0 || (request.ambiguity_reasons ?? []).length > 0 ? "verification_packet_constrained" : "verification_packet_ready";
}

function recommend(decision: ManipulationVerificationBridgeDecision): ManipulationVerificationBridgeAction {
  if (decision === "verification_packet_ready") return "send_to_verifier";
  if (decision === "verification_packet_constrained") return "send_with_ambiguity";
  if (decision === "reobserve_required") return "collect_alternate_view";
  if (decision === "correct_required") return "route_to_correct";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_verification_packet";
}

function validateRef(ref: Ref, path: string, code: ManipulationVerificationIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque verification refs."));
    return;
  }
  if (HIDDEN_VERIFICATION_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenVerificationLeak", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived refs only."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_VERIFICATION_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_VERIFICATION_PATTERN, "hidden-detail").trim();
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ManipulationVerificationIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
