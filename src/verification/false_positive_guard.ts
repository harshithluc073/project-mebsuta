/**
 * False-positive guard for Project Mebsuta verification.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2.1, 13.2.3, 13.5, 13.6.7, 13.10.10, 13.13, and
 * 13.22.
 *
 * The guard detects visual and physical traps that could make a task look
 * complete while evidence remains weak, occluded, unstable, or contradicted.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  sanitizeText,
  scaleConfidence,
  uniqueSorted,
  type VerificationGuardLevel,
  type VerificationPolicy,
} from "./verification_policy_registry";
import type { SpatialResidualEvaluationReport } from "./spatial_residual_evaluator";
import type { ViewSufficiencyReport } from "./view_sufficiency_evaluator";
import type { VisualVerificationAssessment } from "./visual_verification_adapter";
import type { SettleWindowReport } from "./settle_window_monitor";

export const FALSE_POSITIVE_GUARD_SCHEMA_VERSION = "mebsuta.false_positive_guard.v1" as const;

export type FalsePositiveRiskKind =
  | "container_rim_confusion"
  | "shadow_boundary_confusion"
  | "similar_object_swap"
  | "gripper_or_tool_occlusion"
  | "desynchronized_views"
  | "temporary_instability"
  | "hidden_relation"
  | "residual_visual_conflict"
  | "memory_staleness";

export type FalsePositiveGuardDecision = "clear" | "clear_with_warnings" | "blocked" | "safe_hold_required" | "rejected";
export type FalsePositiveGuardAction = "aggregate_results" | "aggregate_with_guard" | "reobserve" | "safe_hold" | "repair_guard_input";

export interface FalsePositiveRiskRecord {
  readonly risk_ref: Ref;
  readonly risk_kind: FalsePositiveRiskKind;
  readonly severity: "warning" | "blocking" | "unsafe";
  readonly constraint_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly description: string;
  readonly required_prevention: string;
  readonly resolved: boolean;
  readonly confidence_impact: number;
}

export interface FalsePositiveGuardRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly sufficiency_report: ViewSufficiencyReport;
  readonly visual_assessment: VisualVerificationAssessment;
  readonly spatial_report: SpatialResidualEvaluationReport;
  readonly settle_report?: SettleWindowReport;
  readonly memory_candidate_refs?: readonly Ref[];
}

export interface FalsePositiveRiskReport {
  readonly schema_version: typeof FALSE_POSITIVE_GUARD_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: FalsePositiveGuardDecision;
  readonly recommended_action: FalsePositiveGuardAction;
  readonly guard_level: VerificationGuardLevel;
  readonly risks: readonly FalsePositiveRiskRecord[];
  readonly blocking_risk_refs: readonly Ref[];
  readonly confidence: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "false_positive_risk_report";
  readonly determinism_hash: string;
}

/**
 * Detects evidence traps before certification.
 */
export class FalsePositiveGuard {
  /**
   * Evaluates visual, residual, and stability conflicts.
   */
  public evaluateFalsePositiveRisk(request: FalsePositiveGuardRequest): FalsePositiveRiskReport {
    const issues: ValidationIssue[] = [];
    const risks = freezeArray([...buildRisks(request, issues)].sort((a, b) => a.risk_kind.localeCompare(b.risk_kind) || a.risk_ref.localeCompare(b.risk_ref)));
    const blockers = freezeArray(risks.filter((risk) => (risk.severity === "blocking" || risk.severity === "unsafe") && !risk.resolved).map((risk) => risk.risk_ref).sort());
    const decision = decide(risks, issues);
    const confidence = confidenceFor(risks, request);
    const requestRef = request.request_ref ?? makeRef("false_positive_guard", request.policy.policy_ref, request.visual_assessment.assessment_ref);
    const base = {
      schema_version: FALSE_POSITIVE_GUARD_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("false_positive_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      guard_level: request.policy.false_positive_guard_level,
      risks,
      blocking_risk_refs: blockers,
      confidence,
      issues: freezeArray(issues),
      ok: decision === "clear" || decision === "clear_with_warnings",
      cognitive_visibility: "false_positive_risk_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createFalsePositiveGuard(): FalsePositiveGuard {
  return new FalsePositiveGuard();
}

function buildRisks(request: FalsePositiveGuardRequest, issues: ValidationIssue[]): readonly FalsePositiveRiskRecord[] {
  const risks: FalsePositiveRiskRecord[] = [];
  if (request.policy.false_positive_guard_level === "container" && request.sufficiency_report.required_new_views.length > 0) {
    risks.push(risk("container_rim_confusion", "blocking", request.sufficiency_report.required_new_views, request.sufficiency_report.missing_evidence_refs, "Container or rim relation needs additional embodied view evidence.", "Collect overhead, wrist, or side view before certification.", false, 0.28));
  }
  if (request.policy.false_positive_guard_level === "tool_use" && request.visual_assessment.overall_status !== "satisfied") {
    risks.push(risk("gripper_or_tool_occlusion", "blocking", request.visual_assessment.recommended_new_evidence, request.visual_assessment.constraint_assessments.flatMap((item) => item.evidence_refs), "Tool or effector may be hiding the target relation.", "Retreat safely and reacquire tool-axis evidence.", false, 0.35));
  }
  if (request.settle_report !== undefined && !request.settle_report.ok) {
    risks.push(risk("temporary_instability", request.settle_report.decision === "unsafe_contact" ? "unsafe" : "blocking", [request.settle_report.target_ref], request.settle_report.evidence_refs, "Object stability is not settled enough for certification.", "Extend settle monitoring or reobserve after motion stops.", false, 0.4));
  }
  if (request.visual_assessment.overall_status === "satisfied" && request.spatial_report.failed_constraint_refs.length > 0) {
    risks.push(risk("residual_visual_conflict", "blocking", request.spatial_report.failed_constraint_refs, request.spatial_report.evidence_refs, "Visual assessment and spatial residuals disagree.", "Let deterministic residuals govern and route to correction.", false, 0.42));
  }
  if (request.sufficiency_report.decision === "recapture_required") {
    risks.push(risk("desynchronized_views", "blocking", request.sufficiency_report.required_new_views, request.sufficiency_report.evidence_refs, "Views are not synchronized tightly enough for final state verification.", "Recapture the verification bundle.", false, 0.32));
  }
  if (request.policy.false_positive_guard_level === "strict" && request.visual_assessment.confidence < 0.62) {
    risks.push(risk("hidden_relation", "warning", request.visual_assessment.recommended_new_evidence, request.visual_assessment.constraint_assessments.flatMap((item) => item.evidence_refs), "Visual confidence is low under strict policy.", "Add another embodied view or route ambiguity.", false, 0.16));
  }
  if ((request.memory_candidate_refs ?? []).length > 0 && (request.spatial_report.ambiguous_constraint_refs.length > 0 || request.sufficiency_report.confidence < 0.55)) {
    risks.push(risk("memory_staleness", "warning", request.spatial_report.ambiguous_constraint_refs, request.memory_candidate_refs ?? [], "Memory update candidate is weaker than verification evidence requirements.", "Store summary only or wait for a certificate.", false, 0.18));
  }
  if (request.sufficiency_report.evidence_refs.some((ref) => /shadow|glare|reflection/iu.test(ref))) {
    risks.push(risk("shadow_boundary_confusion", "warning", [], request.sufficiency_report.evidence_refs, "Lighting artifact may mimic an object boundary.", "Prefer depth or alternate angle evidence.", false, 0.12));
  }
  if (request.visual_assessment.constraint_assessments.some((item) => item.ambiguity_reason !== undefined && /similar|identity|distractor/iu.test(item.ambiguity_reason))) {
    risks.push(risk("similar_object_swap", "blocking", request.visual_assessment.constraint_assessments.map((item) => item.constraint_ref), request.visual_assessment.constraint_assessments.flatMap((item) => item.evidence_refs), "Identity ambiguity may swap the target with a distractor.", "Acquire distinguishing crop evidence.", false, 0.34));
  }
  if (risks.some((item) => item.severity === "unsafe")) {
    issues.push(makeIssue("warning", "ViewPolicyMissing", "$.false_positive_risks", "Unsafe false-positive risk requires SafeHold routing.", "Block certification until safety review."));
  }
  return freezeArray(risks);
}

function risk(
  kind: FalsePositiveRiskKind,
  severity: FalsePositiveRiskRecord["severity"],
  constraintRefs: readonly string[],
  evidenceRefs: readonly Ref[],
  description: string,
  requiredPrevention: string,
  resolved: boolean,
  confidenceImpact: number,
): FalsePositiveRiskRecord {
  return Object.freeze({
    risk_ref: makeRef("false_positive_risk", kind, constraintRefs.join(":"), severity),
    risk_kind: kind,
    severity,
    constraint_refs: uniqueSorted(constraintRefs.map(sanitizeText)),
    evidence_refs: uniqueSorted(evidenceRefs),
    description: sanitizeText(description),
    required_prevention: sanitizeText(requiredPrevention),
    resolved,
    confidence_impact: Math.max(0, Math.min(1, confidenceImpact)),
  });
}

function decide(risks: readonly FalsePositiveRiskRecord[], issues: readonly ValidationIssue[]): FalsePositiveGuardDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (risks.some((risk) => risk.severity === "unsafe" && !risk.resolved)) return "safe_hold_required";
  if (risks.some((risk) => risk.severity === "blocking" && !risk.resolved)) return "blocked";
  if (risks.some((risk) => risk.severity === "warning" && !risk.resolved) || issues.length > 0) return "clear_with_warnings";
  return "clear";
}

function recommend(decision: FalsePositiveGuardDecision): FalsePositiveGuardAction {
  if (decision === "clear") return "aggregate_results";
  if (decision === "clear_with_warnings") return "aggregate_with_guard";
  if (decision === "blocked") return "reobserve";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_guard_input";
}

function confidenceFor(risks: readonly FalsePositiveRiskRecord[], request: FalsePositiveGuardRequest): number {
  const riskScore = risks.reduce((score, riskItem) => riskItem.resolved ? score : score * (1 - riskItem.confidence_impact), 1);
  return scaleConfidence(riskScore, request.sufficiency_report.confidence, request.visual_assessment.confidence, request.spatial_report.confidence, request.settle_report?.stability_confidence ?? 1);
}
