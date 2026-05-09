import { describe, expect, it } from "vitest";

import {
  evaluateLatencyBudget,
  executePerformanceReliabilityHardening,
  normalizeDegradationEvidence,
  normalizeLoadSoakEvidence,
  normalizeReliabilityEvidence,
  normalizeTimeoutBackpressure,
  validatePerformanceReliabilityHardeningReport,
  type PerformanceBudget,
  type PerformanceBudgetInput,
  type PerformanceReliabilityHardeningInput,
} from "../../src/performance/performance_reliability_hardening";

describe("PIT-B15 performance reliability hardening", () => {
  it("generates a go report when budgets, load/soak, backpressure, degradation, and reliability evidence are green", () => {
    const report = executePerformanceReliabilityHardening(greenInput());

    expect(report.decision).toBe("go");
    expect(report.no_go_conditions).toEqual([]);
    expect(report.conditional_go_conditions).toEqual([]);
    expect(report.latency_evaluations.every((item) => item.status === "green")).toBe(true);
    expect(report.load_soak_evidence.status).toBe("green");
    expect(report.timeout_backpressure.status).toBe("green");
    expect(report.degradation_evidence.every((item) => item.status === "green")).toBe(true);
    expect(report.reliability_evidence.status).toBe("green");
    expect(validatePerformanceReliabilityHardeningReport(report).ok).toBe(true);
  });

  it("blocks release when a hard safety latency budget is exceeded or lacks required evidence", () => {
    const budget = executePerformanceReliabilityHardening(greenInput()).budgets.find((item) => item.budget_ref === "budget:pit-b15:safety-immediate") as PerformanceBudget;
    const evaluation = evaluateLatencyBudget({
      observation_ref: "obs:pit-b15:safety-immediate:red",
      budget_ref: budget.budget_ref,
      observed_value: 130,
      sample_count: 20,
      evidence_refs: ["telemetry:pit-b15:safety-immediate"],
      operator_summary: "Safety immediate queue exceeded the hard deadline.",
    }, budget);
    const report = executePerformanceReliabilityHardening({
      ...greenInput(),
      latency_observations: [{
        observation_ref: "obs:pit-b15:safety-immediate:red",
        budget_ref: "budget:pit-b15:safety-immediate",
        observed_value: 130,
        sample_count: 20,
        evidence_refs: ["telemetry:pit-b15:safety-immediate"],
        operator_summary: "Safety immediate queue exceeded the hard deadline.",
      }],
    });

    expect(evaluation.status).toBe("red");
    expect(evaluation.missing_evidence_refs).toEqual(["replay:pit-b15:safety-immediate"]);
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("performance_budget_red");
  });

  it("marks load and soak evidence red when capacity, duration, queue, or replay evidence misses threshold", () => {
    const load = normalizeLoadSoakEvidence({
      ...greenInput().load_soak_evidence,
      observed_session_count: 3,
      queue_saturation_events: 1,
      replay_completeness_ratio: 0.91,
    });
    const report = executePerformanceReliabilityHardening({
      ...greenInput(),
      load_soak_evidence: {
        ...greenInput().load_soak_evidence,
        observed_session_count: 3,
        queue_saturation_events: 1,
        replay_completeness_ratio: 0.91,
      },
    });

    expect(load.status).toBe("red");
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("load_soak_evidence_red");
  });

  it("routes timeout and backpressure breaches to release block while preserving degraded-mode evidence", () => {
    const backpressure = normalizeTimeoutBackpressure({
      ...greenInput().timeout_backpressure,
      observed_queue_depth: 25,
      timeout_count: 2,
      load_shed_refs: ["shed:pit-b15:background"],
    });
    const report = executePerformanceReliabilityHardening({
      ...greenInput(),
      timeout_backpressure: {
        ...greenInput().timeout_backpressure,
        observed_queue_depth: 25,
        timeout_count: 2,
        load_shed_refs: ["shed:pit-b15:background"],
      },
    });

    expect(backpressure.status).toBe("red");
    expect(backpressure.route).toBe("release_block");
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("timeout_backpressure_red");
  });

  it("fails degradation evidence when the route is unsafe, invisible, or evidence is not preserved", () => {
    const degradation = normalizeDegradationEvidence({
      ...greenInput().degradation_evidence[0],
      observed_route: "continue",
      operator_visible: false,
      evidence_preserved: false,
    });
    const report = executePerformanceReliabilityHardening({
      ...greenInput(),
      degradation_evidence: [{
        ...greenInput().degradation_evidence[0],
        observed_route: "continue",
        operator_visible: false,
        evidence_preserved: false,
      }],
    });

    expect(degradation.status).toBe("red");
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("degradation_route_red");
  });

  it("blocks release when reliability evidence loses safety acknowledgement, replay, audit, or boundary integrity", () => {
    const reliability = normalizeReliabilityEvidence({
      ...greenInput().reliability_evidence,
      safety_ack_rate: 0.98,
      replay_completeness_ratio: 0.9,
      audit_preservation_ratio: 0.99,
      boundary_violation_count: 1,
    });
    const report = executePerformanceReliabilityHardening({
      ...greenInput(),
      reliability_evidence: {
        ...greenInput().reliability_evidence,
        safety_ack_rate: 0.98,
        replay_completeness_ratio: 0.9,
        audit_preservation_ratio: 0.99,
        boundary_violation_count: 1,
      },
    });

    expect(reliability.status).toBe("red");
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("reliability_evidence_red");
  });
});

function greenInput(): PerformanceReliabilityHardeningInput {
  return {
    hardening_report_ref: "performance:pit-b15:green",
    budgets: budgets(),
    latency_observations: [
      {
        observation_ref: "obs:pit-b15:safety-immediate",
        budget_ref: "budget:pit-b15:safety-immediate",
        observed_value: 40,
        sample_count: 120,
        evidence_refs: ["telemetry:pit-b15:safety-immediate", "replay:pit-b15:safety-immediate"],
        operator_summary: "Safety immediate queue remained inside the hard deadline.",
      },
      {
        observation_ref: "obs:pit-b15:dashboard-freshness",
        budget_ref: "budget:pit-b15:dashboard-freshness",
        observed_value: 450,
        sample_count: 90,
        evidence_refs: ["telemetry:pit-b15:dashboard", "replay:pit-b15:dashboard"],
        operator_summary: "Operator dashboard freshness remained within the experience budget.",
      },
    ],
    load_soak_evidence: {
      load_report_ref: "load:pit-b15:green",
      expected_session_count: 4,
      observed_session_count: 4,
      expected_duration_min: 60,
      observed_duration_min: 60,
      queue_saturation_events: 0,
      replay_completeness_ratio: 1,
      evidence_refs: ["load:pit-b15:sessions", "soak:pit-b15:duration", "replay:pit-b15:load"],
      operator_summary: "Load and soak evidence met session, duration, queue, and replay targets.",
    },
    timeout_backpressure: {
      backpressure_report_ref: "backpressure:pit-b15:green",
      queue_ref: "queue:pit-b15:model-execution",
      max_queue_depth: 12,
      observed_queue_depth: 6,
      timeout_count: 0,
      retry_suppression_count: 0,
      load_shed_refs: [],
      operator_summary: "Model execution queue stayed bounded without timeout or shedding.",
    },
    degradation_evidence: [{
      degradation_ref: "degradation:pit-b15:model-timeout",
      trigger_ref: "trigger:pit-b15:model-timeout",
      observed_route: "human_review",
      expected_routes: ["human_review", "safe_hold"],
      operator_visible: true,
      evidence_preserved: true,
      safety_preserved: true,
      evidence_refs: ["event:pit-b15:model-timeout", "replay:pit-b15:model-timeout"],
      operator_summary: "Model timeout used visible degraded routing and preserved evidence.",
    }],
    reliability_evidence: {
      reliability_report_ref: "reliability:pit-b15:green",
      safety_ack_rate: 1,
      replay_completeness_ratio: 1,
      audit_preservation_ratio: 1,
      boundary_violation_count: 0,
      unsafe_action_count: 0,
      memory_contamination_count: 0,
      evidence_refs: ["reliability:pit-b15:safety", "reliability:pit-b15:audit", "reliability:pit-b15:replay"],
      operator_summary: "Reliability evidence preserves safety acknowledgement, replay, audit, and boundary integrity.",
    },
    operator_summary: "PIT-B15 performance reliability hardening evidence is green across budgets, load, soak, degradation, and reliability.",
  };
}

function budgets(): readonly PerformanceBudgetInput[] {
  return [
    {
      budget_ref: "budget:pit-b15:safety-immediate",
      subsystem: "model_queue",
      budget_class: "hard_safety_deadline",
      metric_kind: "latency_ms",
      threshold_value: 80,
      warning_value: 60,
      required_evidence_refs: ["telemetry:pit-b15:safety-immediate", "replay:pit-b15:safety-immediate"],
      operator_summary: "Safety immediate model queue must fit the hard deadline or route without model assistance.",
    },
    {
      budget_ref: "budget:pit-b15:dashboard-freshness",
      subsystem: "frontend",
      budget_class: "operator_experience_budget",
      metric_kind: "freshness_ms",
      threshold_value: 1_000,
      warning_value: 750,
      required_evidence_refs: ["telemetry:pit-b15:dashboard", "replay:pit-b15:dashboard"],
      operator_summary: "Operator dashboard freshness must remain visible and bounded.",
    },
  ];
}
