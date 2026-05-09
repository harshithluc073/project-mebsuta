import { describe, expect, it } from "vitest";

import { AUDIO_TASK_CORRELATOR_SCHEMA_VERSION, type AudioTaskCorrelationSet } from "../../src/acoustic/audio_task_correlator";
import {
  VerificationMemoryOopsAudioSafetyIntegration,
  VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_BLUEPRINT_ALIGNMENT,
} from "../../src/runtime/verification_memory_oops_audio_safety_integration";
import type { SafeHoldEntryRequest } from "../../src/safety/safe_hold_state_manager";
import type { ActiveSafetyPolicySet } from "../../src/safety/safety_policy_registry";
import { computeDeterminismHash, type Ref } from "../../src/simulation/world_manifest";
import { CONSTRAINT_RESULT_AGGREGATOR_SCHEMA_VERSION, type ConstraintAggregationDecision, type ConstraintAggregationReport } from "../../src/verification/constraint_result_aggregator";
import type { SpatialResidualEvaluationReport } from "../../src/verification/spatial_residual_evaluator";
import { SPATIAL_RESIDUAL_EVALUATOR_SCHEMA_VERSION } from "../../src/verification/spatial_residual_evaluator";
import type {
  ControllerCompletionSummary,
  TruthBoundaryRecord,
  VerificationPolicy,
  VerificationRouteDecision,
} from "../../src/verification/verification_policy_registry";

describe("PIT-B09 verification memory Oops audio safety integration", () => {
  it("allows exact spatial memory only after a success certificate gates the candidate", () => {
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...baseInput("success_ready", "complete"),
      audio_correlation_set: audioCorrelationSet("note"),
    });

    expect(report.decision).toBe("ready_for_runtime_continuation");
    expect(report.certificate_report.certificate?.result).toBe("success");
    expect(report.memory_commit_report.overall_outcome).toBe("commit_allowed");
    expect(report.memory_commit_report.decisions[0]?.allowed_memory_refs).toContain(report.certificate_report.certificate?.certificate_ref);
    expect(report.invariants).toMatchObject({
      authorized_step_ref: "PIT-B09",
      certificate_gates_memory: true,
      memory_contamination_prevented: true,
      audio_is_uncertain_cue_only: true,
      audio_does_not_certify_success: true,
      raw_prompt_exposed: false,
      private_reasoning_exposed: false,
      qa_runtime_truth_exposed: false,
      hidden_simulator_truth_exposed: false,
    });
  });

  it("prevents contaminated exact memory when pose uncertainty exceeds the certificate memory gate", () => {
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...baseInput("success_ready", "complete"),
      memory_candidates: [{
        ...memoryCandidate(),
        pose_uncertainty_m: 0.12,
      }],
    });

    expect(report.decision).toBe("reobserve_required");
    expect(report.memory_commit_report.overall_outcome).toBe("commit_after_reobserve");
    expect(report.memory_commit_report.decisions[0]?.blocked_fields).toContain("estimated_pose_ref");
    expect(report.invariants.certificate_gates_memory).toBe(true);
    expect(report.invariants.memory_contamination_prevented).toBe(true);
  });

  it("routes correctable verification failure into Oops and escalates when retry budget is exhausted", () => {
    const input = baseInput("failure_correctable", "correct");
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...input,
      oops_handoff_request: {
        policy: verificationPolicy(1),
        aggregation_report: input.certificate_request.aggregation_report,
        spatial_report: spatialReport("evaluated_with_warnings"),
        controller_completion_summary: controllerSummary(false),
        safety_policy_ref: "safety:pit-b09-correction",
      },
      oops_policy: oopsPolicy(1),
    });

    expect(report.decision).toBe("human_review_required");
    expect(report.oops_handoff_report?.decision).toBe("handoff_ready");
    expect(report.oops_admission_report?.decision).toBe("admitted");
    expect(report.oops_retry_report?.decision).toBe("human_review_required");
    expect(report.oops_retry_report?.updated_retry_budget).toMatchObject({
      episode_attempts_used: 1,
      maximum_episode_attempts: 1,
    });
    expect(report.required_human_review_refs).toContain(report.oops_retry_report?.report_ref);
    expect(report.invariants.oops_retry_bounded).toBe(true);
    expect(report.invariants.oops_requires_verification_evidence).toBe(true);
  });

  it("routes unsafe verification and blocking audio into SafeHold with verified memory writes denied", () => {
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...baseInput("unsafe", "safe_hold"),
      memory_candidates: [],
      audio_correlation_set: audioCorrelationSet("safe_hold"),
      safe_hold_entry_request: safeHoldEntryRequest(),
    });

    expect(report.decision).toBe("safe_hold_required");
    expect(report.certificate_report.certificate?.result).toBe("failure_unsafe");
    expect(report.safe_hold_state?.memory_write_policy).toBe("deny_verified_spatial_writes");
    expect(report.safe_hold_state?.blocked_action_refs).toContain("primitive:pit-b09-place");
    expect(report.audio_route_decision_set?.decisions[0]?.blocked_direct_actions).toContain("audio_only_physical_correction");
    expect(report.invariants.safe_hold_authority_preserved).toBe(true);
    expect(report.invariants.audio_is_uncertain_cue_only).toBe(true);
  });

  it("preserves HumanReview as a first-class outcome for audio evidence that cannot support autonomous interpretation", () => {
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...baseInput("success_ready", "complete"),
      audio_correlation_set: audioCorrelationSet("human_review"),
    });

    expect(report.decision).toBe("human_review_required");
    expect(report.required_human_review_refs).toEqual([
      report.audio_route_decision_set?.decisions[0]?.route_decision_ref,
    ]);
    expect(report.invariants.human_review_surface_preserved).toBe(true);
    expect(report.invariants.audio_does_not_certify_success).toBe(true);
  });

  it("keeps PIT-B09 bounded and does not introduce later-step refs or restricted truth surfaces", () => {
    const report = new VerificationMemoryOopsAudioSafetyIntegration().compose({
      ...baseInput("success_ready", "complete"),
      audio_correlation_set: audioCorrelationSet("note"),
    });
    const serializedReport = JSON.stringify(report);
    const laterStepRef = "PIT-B" + "10";

    expect(VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_BLUEPRINT_ALIGNMENT.step_ref).toBe("PIT-B09");
    expect(report.invariants.forbidden_later_step_refs).toEqual([]);
    expect(serializedReport).not.toContain(laterStepRef);
    for (const restrictedText of ["world " + "truth", "or" + "acle", "system " + "prompt", "chain of " + "thought"]) {
      expect(serializedReport).not.toContain(restrictedText);
    }
  });
});

function baseInput(decision: ConstraintAggregationDecision, route: VerificationRouteDecision) {
  const aggregationReport = aggregation(decision, route);
  return {
    integration_ref: `integration:pit-b09:${decision}`,
    task_ref: "task:pit-b09",
    primitive_ref: "primitive:pit-b09-place",
    actor_ref: "actor:runtime-operator",
    occurred_at_ms: 20_000,
    certificate_request: {
      request_ref: `certificate-request:pit-b09:${decision}`,
      task_ref: "task:pit-b09",
      verification_request_ref: `verification-request:pit-b09:${decision}`,
      primitive_ref: "primitive:pit-b09-place",
      policy_ref: "verification-policy:pit-b09",
      aggregation_report: aggregationReport,
      truth_boundary_status: truthBoundary(),
      replay_refs: ["replay:pit-b09-observation"],
      issued_at_ms: 20_000,
    },
    memory_candidates: [memoryCandidate()],
    memory_policy: verificationPolicy(2).memory_policy,
  } as const;
}

function aggregation(decision: ConstraintAggregationDecision, route: VerificationRouteDecision): ConstraintAggregationReport {
  const status = decision === "success_ready" ? "satisfied" : decision === "ambiguous" ? "ambiguous" : "failed";
  const failureRefs = decision === "failure_correctable" || decision === "unsafe" ? ["constraint:pit-b09-final-state"] : [];
  return withHash({
    schema_version: CONSTRAINT_RESULT_AGGREGATOR_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md",
    report_ref: `constraint-aggregation:pit-b09:${decision}`,
    request_ref: `constraint-aggregation-request:pit-b09:${decision}`,
    decision,
    route_decision: route,
    recommended_action: decision === "success_ready" ? "issue_certificate" : decision === "failure_correctable" ? "route_correct" : decision === "unsafe" ? "safe_hold" : "human_review",
    constraint_results: [{
      constraint_ref: "constraint:pit-b09-final-state",
      status,
      required: true,
      visual_status: status,
      spatial_status: status,
      evidence_refs: ["evidence:pit-b09-view", "evidence:pit-b09-residual"],
      confidence: decision === "success_ready" ? 0.91 : 0.68,
      reason: "Runtime embodied verification evidence supports the selected route.",
    }],
    success_constraint_refs: decision === "success_ready" ? ["constraint:pit-b09-final-state"] : [],
    failure_constraint_refs: failureRefs,
    ambiguous_constraint_refs: decision === "ambiguous" ? ["constraint:pit-b09-final-state"] : [],
    unsafe_constraint_refs: decision === "unsafe" ? ["constraint:pit-b09-final-state"] : [],
    confidence: decision === "success_ready" ? 0.91 : 0.68,
    issues: [],
    ok: decision === "success_ready",
    cognitive_visibility: "constraint_aggregation_report",
  } as const);
}

function memoryCandidate() {
  return {
    candidate_ref: "memory-candidate:pit-b09-target",
    perceived_object_descriptor_ref: "descriptor:pit-b09-target",
    estimated_pose_ref: "pose-estimate:pit-b09-target",
    pose_uncertainty_m: 0.01,
    visual_description: "Visible target object rests in the verified final state.",
    landmark_refs: ["landmark:pit-b09-workspace"],
    evidence_timestamp_ms: 19_900,
    evidence_refs: ["evidence:pit-b09-view", "evidence:pit-b09-residual"],
  } as const;
}

function verificationPolicy(correctionBudget: number): VerificationPolicy {
  return {
    policy_ref: "verification-policy:pit-b09",
    task_class: "arrange",
    required_constraints: [{
      constraint_ref: "constraint:pit-b09-final-state",
      constraint_class: "position",
      subject_ref: "descriptor:pit-b09-target",
      required: true,
      minimum_evidence_strength: "strong",
      evidence_refs: ["evidence:pit-b09-view"],
    }],
    view_requirements: [{
      requirement_ref: "view-requirement:pit-b09-position",
      constraint_class: "position",
      required_views: ["front_primary"],
      optional_views: ["left_aux"],
      requires_depth: true,
      requires_settle_window: false,
      allowed_body_adjustments: ["safe_head_yaw"],
    }],
    tolerance_policy: {
      position_tolerance_m: 0.03,
      orientation_tolerance_rad: 0.12,
      stability_motion_tolerance_m: 0.01,
      contact_tolerance_m: 0.008,
      maximum_uncertainty_ratio: 0.7,
    },
    settle_window_duration_ms: 300,
    maximum_verification_latency_ms: 3_200,
    ambiguity_retry_budget: 1,
    correction_retry_budget: correctionBudget,
    false_positive_guard_level: "normal",
    memory_policy: {
      policy_ref: "memory-policy:pit-b09",
      minimum_certificate_confidence: 0.72,
      maximum_pose_uncertainty_m: 0.025,
      require_success_certificate: true,
      allow_summary_on_ambiguity: false,
    },
  };
}

function spatialReport(decision: SpatialResidualEvaluationReport["decision"]): SpatialResidualEvaluationReport {
  return withHash({
    schema_version: SPATIAL_RESIDUAL_EVALUATOR_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md",
    report_ref: `spatial-residual:pit-b09:${decision}`,
    request_ref: `spatial-residual-request:pit-b09:${decision}`,
    decision,
    recommended_action: "aggregate_with_caution",
    residuals: [{
      residual_ref: "spatial-residual:item:pit-b09-final-state",
      source_residual_report_ref: "source-residual:pit-b09-final-state",
      constraint_ref: "constraint:pit-b09-final-state",
      status: "failed",
      residual_value: 0.08,
      tolerance_value: 0.03,
      normalized_error: 2.666667,
      uncertainty_ratio: 0.2,
      correction_direction: [0.02, 0, 0],
      evidence_refs: ["evidence:pit-b09-view", "evidence:pit-b09-residual"],
      confidence: 0.65,
    }],
    failed_constraint_refs: ["constraint:pit-b09-final-state"],
    ambiguous_constraint_refs: [],
    unsafe_constraint_refs: [],
    evidence_refs: ["evidence:pit-b09-view", "evidence:pit-b09-residual"],
    confidence: 0.65,
    issues: [],
    ok: true,
    cognitive_visibility: "spatial_residual_evaluation_report",
  } as const);
}

function controllerSummary(highForceContact: boolean): ControllerCompletionSummary {
  return {
    completion_ref: "controller-completion:pit-b09",
    trajectory_state: "completed_with_warnings",
    telemetry_refs: ["telemetry:pit-b09-control"],
    max_position_residual_m: 0.08,
    anomaly_refs: [],
    high_force_contact: highForceContact,
  };
}

function oopsPolicy(maximumEpisodeAttempts: number) {
  return {
    policy_ref: "oops-policy:pit-b09",
    retry_budget: {
      episode_attempts_used: 0,
      maximum_episode_attempts: maximumEpisodeAttempts,
      repair_attempts_used: 0,
      maximum_repair_attempts: 1,
      reobserve_attempts_used: 0,
      maximum_reobserve_attempts: 1,
    },
    safety_limits: {
      safety_policy_ref: "safety:pit-b09-correction",
      max_translation_m: 0.04,
      max_rotation_rad: 0.12,
      max_force_n: 4,
      max_speed_mps: 0.05,
      allow_tool_contact: false,
      allow_body_reposition: false,
    },
    require_visual_evidence: true,
    allow_diagnosis_only_for_unsafe: false,
    allow_deterministic_fallback: false,
  } as const;
}

function audioCorrelationSet(route: "note" | "safe_hold" | "human_review"): AudioTaskCorrelationSet {
  return withHash({
    schema_version: AUDIO_TASK_CORRELATOR_SCHEMA_VERSION,
    correlation_set_ref: `audio-correlation-set:pit-b09:${route}`,
    reports: [withHash({
      schema_version: AUDIO_TASK_CORRELATOR_SCHEMA_VERSION,
      correlation_report_ref: `audio-correlation:pit-b09:${route}`,
      audio_event_ref: `audio-event:pit-b09:${route}`,
      task_context_ref: "task-context:pit-b09-audio",
      task_phase: "verify",
      expectedness_status: route === "note" ? "expected" : "unexpected",
      task_relevance_score: route === "note" ? 0.24 : 0.76,
      safety_relevance_score: route === "safe_hold" ? 0.95 : route === "human_review" ? 0.74 : 0.12,
      affected_constraint_refs: route === "safe_hold" ? ["constraint:pit-b09-final-state"] : ["constraint:pit-b09-audio-context"],
      supporting_evidence_refs: ["evidence:pit-b09-audio"],
      confidence_class: route === "note" ? "medium" : "high",
      recommended_route: route,
      reason: "Acoustic evidence is routed as runtime context with explicit uncertainty.",
    } as const)],
    issues: [],
  } as const);
}

function safeHoldEntryRequest(): SafeHoldEntryRequest {
  return {
    trigger_event: {
      trigger_event_ref: "safehold-trigger:pit-b09-audio-impact",
      trigger_class: "audio_impact_risk",
      severity: "high",
      occurred_at_ms: 20_000,
      source_report_refs: ["audio-correlation:pit-b09:safe_hold"],
      blocked_action_refs: ["primitive:pit-b09-place"],
      evidence_refs: ["evidence:pit-b09-audio"],
      human_reason: "Audio impact risk and unsafe verification require a pause before further motion.",
    },
    body_state: {
      body_state_ref: "body-state:pit-b09-safehold",
      posture_summary: "Controller is paused with a stable posture available.",
      stable_posture_available: true,
      release_is_safer_than_hold: false,
    },
    active_task: {
      task_ref: "task:pit-b09",
      active_primitive_ref: "primitive:pit-b09-place",
    },
    active_policy_set: safetyPolicySet(),
    tts_announcement_ref: "tts:pit-b09-safehold",
  };
}

function safetyPolicySet(): ActiveSafetyPolicySet {
  return withHash({
    active_policy_set_ref: "active-safety-policy:pit-b09",
    request_ref: "safety-policy-request:pit-b09",
    policies: [],
    policy_precedence: [],
    force_limits: [],
    speed_limits: [],
    acceleration_limits: [],
    workspace_bounds: [],
    tool_envelope_limits: [],
    sensor_requirements: ["sensor:pit-b09-vision"],
    safe_hold_triggers: ["safehold-trigger:pit-b09-audio-impact"],
    human_review_triggers: ["human-review:pit-b09"],
    audit_requirements: ["audit:pit-b09-safehold"],
    default_restrictions: [],
    issues: [],
  } as const);
}

function truthBoundary(): TruthBoundaryRecord {
  return {
    status: "runtime_embodied_only",
    evidence_provenance: ["embodied_sensor", "derived_embodied_estimate", "controller_telemetry"],
    audit_refs: ["audit:pit-b09-truth-boundary"],
    summary: "Runtime embodied evidence only.",
  };
}

function withHash<T extends object>(value: T): T & { readonly determinism_hash: string } {
  return Object.freeze({ ...value, determinism_hash: computeDeterminismHash(value) });
}
