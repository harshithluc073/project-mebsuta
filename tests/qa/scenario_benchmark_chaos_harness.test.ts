import { describe, expect, it } from "vitest";

import { buildChaosInjectionRecord, normalizeChaosInjectionRecord, type ChaosInjectionRecord } from "../../src/qa/chaos_injection_record";
import { buildRegressionComparisonReport, type RegressionComparisonReport } from "../../src/qa/regression_comparison_report";
import { buildScenarioBenchmarkSpec, type OfflineMetricClass, type ScenarioBenchmarkSpec, type ScoringPolicy } from "../../src/qa/scenario_benchmark_spec";
import {
  assertValidScenarioBenchmarkChaosHarnessReport,
  executeScenarioBenchmarkChaosHarness,
  normalizeGoldenScenarioEvidence,
  validateScenarioBenchmarkChaosHarnessReport,
  type GoldenScenarioEvidenceInput,
} from "../../src/qa/scenario_benchmark_chaos_harness";
import type { BenchmarkMetricsInput } from "../../src/qa/benchmark_scorecard";

describe("PIT-B11 scenario benchmark and chaos harness", () => {
  it("builds scorecard, chaos, regression, replay, and release evidence for a green benchmark run", () => {
    const report = executeScenarioBenchmarkChaosHarness({
      harness_run_ref: "qa-run:pit-b11:green",
      milestone_ref: "milestone:pit-b11",
      scenario_spec: scenarioSpec(),
      scenario_run_refs: ["scenario-run:pit-b11:green"],
      benchmark_metrics: greenMetrics(),
      chaos_records: [greenChaosRecord()],
      regression_reports: [greenRegressionReport()],
      golden_evidence: goldenEvidence(),
      started_at_ms: 10_000,
      ended_at_ms: 10_480,
      operator_summary: "PIT-B11 benchmark and chaos evidence is complete with replay closure.",
    });

    expect(report.overall_status).toBe("ok");
    expect(report.benchmark_scorecard.release_gate_status).toBe("green");
    expect(report.benchmark_scorecard.aggregate_score).toBeGreaterThan(0.9);
    expect(report.golden_evidence.replay_completeness_rate).toBe(1);
    expect(report.golden_evidence.truth_isolated).toBe(true);
    expect(report.test_run_record.collection_mode).toBe("benchmark_sweep");
    expect(report.test_run_record.qa_truth_artifact_refs).toEqual(["qa-scope:pit-b11:score"]);
    expect(report.release_readiness_report.decision).toBe("go");
    expect(report.no_go_conditions).toEqual([]);

    assertValidScenarioBenchmarkChaosHarnessReport(report);
  });

  it("routes chaos detection and golden regression blockers to no-go release evidence", () => {
    const report = executeScenarioBenchmarkChaosHarness({
      harness_run_ref: "qa-run:pit-b11:blocking",
      milestone_ref: "milestone:pit-b11",
      scenario_spec: scenarioSpec(),
      scenario_run_refs: ["scenario-run:pit-b11:blocking"],
      benchmark_metrics: greenMetrics(),
      chaos_records: [blockingChaosRecord()],
      regression_reports: [blockingRegressionReport()],
      golden_evidence: goldenEvidence(),
      started_at_ms: 11_000,
      ended_at_ms: 11_340,
      operator_summary: "PIT-B11 benchmark run carries blocking chaos and golden comparison evidence.",
    });

    expect(report.overall_status).toBe("fail");
    expect(report.no_go_conditions).toContain("chaos_release_block");
    expect(report.no_go_conditions).toContain("golden_regression_release_block");
    expect(report.release_readiness_report.decision).toBe("no_go");
    expect(report.assertion_results.find((assertion) => assertion.assertion_ref.endsWith("chaos_detection_records"))?.status).toBe("fail");
    expect(report.assertion_results.find((assertion) => assertion.assertion_ref.endsWith("golden_regression_comparison"))?.status).toBe("fail");
    expect(validateScenarioBenchmarkChaosHarnessReport(report).ok).toBe(true);
  });

  it("fails replay completeness and QA-scoped evidence isolation when refs overlap runtime evidence", () => {
    const evidence = normalizeGoldenScenarioEvidence({
      ...goldenEvidence(),
      qa_scoped_artifact_refs: ["artifact:pit-b11:runtime-certificate"],
      observed_replay_refs: ["replay:pit-b11:timeline"],
    });

    expect(evidence.truth_isolated).toBe(false);
    expect(evidence.missing_replay_refs).toEqual(["replay:pit-b11:certificate"]);

    const report = executeScenarioBenchmarkChaosHarness({
      harness_run_ref: "qa-run:pit-b11:isolation-fail",
      milestone_ref: "milestone:pit-b11",
      scenario_spec: scenarioSpec(),
      scenario_run_refs: ["scenario-run:pit-b11:isolation-fail"],
      benchmark_metrics: greenMetrics(),
      chaos_records: [greenChaosRecord()],
      regression_reports: [greenRegressionReport()],
      golden_evidence: {
        ...goldenEvidence(),
        qa_scoped_artifact_refs: ["artifact:pit-b11:runtime-certificate"],
        observed_replay_refs: ["replay:pit-b11:timeline"],
      },
      started_at_ms: 12_000,
      ended_at_ms: 12_220,
      operator_summary: "PIT-B11 benchmark run intentionally lacks replay closure and evidence isolation.",
    });

    expect(report.overall_status).toBe("fail");
    expect(report.no_go_conditions).toContain("replay_evidence_incomplete");
    expect(report.no_go_conditions).toContain("qa_truth_isolation_failed");
    expect(report.release_readiness_report.decision).toBe("no_go");
    expect(report.assertion_results.find((assertion) => assertion.assertion_ref.endsWith("replay_completeness"))?.status).toBe("fail");
    expect(report.assertion_results.find((assertion) => assertion.assertion_ref.endsWith("qa_truth_isolation"))?.status).toBe("fail");
  });

  it("red scorecard metrics block release even when replay and regression evidence are complete", () => {
    const report = executeScenarioBenchmarkChaosHarness({
      harness_run_ref: "qa-run:pit-b11:red-scorecard",
      milestone_ref: "milestone:pit-b11",
      scenario_spec: scenarioSpec(),
      scenario_run_refs: ["scenario-run:pit-b11:red-scorecard"],
      benchmark_metrics: {
        ...greenMetrics(),
        false_success_rate: 0.04,
        hidden_truth_leak_count: 1,
      },
      chaos_records: [greenChaosRecord()],
      regression_reports: [greenRegressionReport()],
      golden_evidence: goldenEvidence(),
      started_at_ms: 13_000,
      ended_at_ms: 13_160,
      operator_summary: "PIT-B11 benchmark metrics intentionally carry release-blocking scorecard defects.",
    });

    expect(report.benchmark_scorecard.release_gate_status).toBe("red");
    expect(report.overall_status).toBe("fail");
    expect(report.no_go_conditions).toContain("benchmark_scorecard_red");
    expect(report.release_readiness_report.decision).toBe("no_go");
  });
});

function scenarioSpec(): ScenarioBenchmarkSpec {
  return buildScenarioBenchmarkSpec({
    scenario_benchmark_ref: "scenario-benchmark:pit-b11:pick-place",
    scenario_name: "PIT-B11 pick and place benchmark",
    scenario_version: "1.0.0",
    random_seed_policy: "fixed",
    world_setup_ref: "world-setup:pit-b11:tabletop",
    embodiment_profile_refs: ["dual_embodiment"],
    task_sequence: [{
      task_goal_ref: "task-goal:pit-b11:place",
      goal_summary: "Place the target cube on the marked region using embodied evidence.",
      target_refs: ["target:pit-b11:cube", "target:pit-b11:region"],
      ordered_step_index: 0,
    }],
    success_constraints: [{
      constraint_ref: "constraint:pit-b11:spatial",
      constraint_kind: "spatial",
      description: "Final certificate residual stays within the benchmark tolerance.",
      tolerance_m: 0.02,
      required_certificate_ref: "certificate:pit-b11:placement",
    }],
    disturbance_profile: {
      disturbance_profile_ref: "disturbance:pit-b11:sensor-delay",
      categories: ["sensor", "event_bus"],
      description: "Sensor delay is injected during verification and must route to reobserve.",
      expected_runtime_route: "reobserve",
    },
    offline_truth_metrics: metricKeys(),
    runtime_certificate_requirements: [{
      requirement_ref: "requirement:pit-b11:certificate",
      certificate_type: "verification_success",
      required_evidence_refs: ["artifact:pit-b11:runtime-certificate", "artifact:pit-b11:visual-evidence"],
      forbids_memory_only_evidence: true,
    }],
    scoring_policy: scoringPolicy(),
    golden_baseline_ref: "golden:pit-b11:baseline",
  });
}

function scoringPolicy(): ScoringPolicy {
  return {
    scoring_policy_ref: "scoring-policy:pit-b11:weighted",
    scoring_kind: "critical_gate_first",
    metric_weights: {
      task_completion: 0.18,
      spatial_precision: 0.16,
      safety: 0.14,
      robustness: 0.12,
      efficiency: 0.08,
      transparency: 0.12,
      boundary_integrity: 0.08,
      memory_quality: 0.06,
      audio_routing: 0.03,
      tool_use: 0.03,
    },
    critical_violation_penalty: 0.5,
    release_threshold: 0.82,
  };
}

function greenMetrics(): BenchmarkMetricsInput {
  return {
    task_success_rate: 0.96,
    false_success_rate: 0,
    false_failure_rate: 0.02,
    ambiguity_rate: 0.04,
    oops_recovery_rate: 0.92,
    safehold_rate: 0.03,
    hidden_truth_leak_count: 0,
    memory_contamination_count: 0,
    prompt_schema_validity_rate: 0.99,
    replay_completeness_rate: 1,
  };
}

function greenChaosRecord(): ChaosInjectionRecord {
  return buildChaosInjectionRecord({
    chaos_test_ref: "chaos:pit-b11:sensor-delay",
    target_subsystem: "sensor",
    injection_type: "delay",
    injection_time_policy: "during_verification",
    severity_level: "c3",
    expected_detection_signal: "verification timestamp skew monitor fires before route decision.",
    expected_route: "reobserve",
    forbidden_outcomes: ["success without fresh evidence", "blind correction"],
    replay_requirements: ["replay:pit-b11:timeline", "replay:pit-b11:certificate"],
    observed_detection_status: "detected",
    observed_route: "reobserve",
    observed_artifact_refs: ["artifact:pit-b11:runtime-certificate"],
  });
}

function blockingChaosRecord(): ChaosInjectionRecord {
  return normalizeChaosInjectionRecord({
    chaos_test_ref: "chaos:pit-b11:control-route-mismatch",
    target_subsystem: "control",
    injection_type: "threshold_breach",
    injection_time_policy: "during_execution",
    severity_level: "c3",
    expected_detection_signal: "control anomaly monitor emits a stop-class event.",
    expected_route: "reobserve",
    forbidden_outcomes: ["success without evidence", "blind correction"],
    replay_requirements: ["replay:pit-b11:timeline", "replay:pit-b11:certificate"],
    observed_detection_status: "detected",
    observed_route: "continue",
    observed_artifact_refs: ["artifact:pit-b11:runtime-certificate"],
  });
}

function greenRegressionReport(): RegressionComparisonReport {
  return buildRegressionComparisonReport({
    regression_report_ref: "regression:pit-b11:green",
    golden_baseline_ref: "golden:pit-b11:baseline",
    current_run_ref: "scenario-run:pit-b11:green",
    compared_artifact_refs: ["artifact:pit-b11:runtime-certificate", "artifact:pit-b11:route"],
    deltas: [{
      delta_ref: "delta:pit-b11:route",
      artifact_class: "route_decision",
      baseline_artifact_ref: "artifact:pit-b11:baseline-route",
      current_artifact_ref: "artifact:pit-b11:route",
      similarity_score: 1,
      drift_classification: "none",
      severity: "warning",
      explanation: "Route decision matches the golden baseline.",
    }],
    drift_summary: "Current benchmark artifacts match the golden baseline.",
    release_impact: "none",
  });
}

function blockingRegressionReport(): RegressionComparisonReport {
  return buildRegressionComparisonReport({
    regression_report_ref: "regression:pit-b11:blocking",
    golden_baseline_ref: "golden:pit-b11:baseline",
    current_run_ref: "scenario-run:pit-b11:blocking",
    compared_artifact_refs: ["artifact:pit-b11:runtime-certificate", "artifact:pit-b11:route"],
    deltas: [{
      delta_ref: "delta:pit-b11:certificate",
      artifact_class: "certificate",
      baseline_artifact_ref: "artifact:pit-b11:baseline-certificate",
      current_artifact_ref: "artifact:pit-b11:runtime-certificate",
      similarity_score: 0.62,
      drift_classification: "critical",
      severity: "error",
      explanation: "Certificate class changed against the golden baseline.",
    }],
    drift_summary: "Golden benchmark comparison found critical certificate drift.",
    release_impact: "release_block",
    remediation_refs: ["remediation:pit-b11:certificate-drift"],
  });
}

function goldenEvidence(): GoldenScenarioEvidenceInput {
  return {
    golden_baseline_ref: "golden:pit-b11:baseline",
    current_run_ref: "scenario-run:pit-b11:green",
    compared_artifact_refs: ["artifact:pit-b11:runtime-certificate", "artifact:pit-b11:route"],
    runtime_artifact_refs: ["artifact:pit-b11:runtime-certificate", "artifact:pit-b11:visual-evidence", "artifact:pit-b11:route"],
    qa_scoped_artifact_refs: ["qa-scope:pit-b11:score"],
    required_replay_refs: ["replay:pit-b11:timeline", "replay:pit-b11:certificate"],
    observed_replay_refs: ["replay:pit-b11:timeline", "replay:pit-b11:certificate"],
    replay_bundle_ref: "replay-bundle:pit-b11:green",
  };
}

function metricKeys(): readonly OfflineMetricClass[] {
  return [
    "task_completion",
    "spatial_precision",
    "safety",
    "robustness",
    "efficiency",
    "transparency",
    "boundary_integrity",
    "memory_quality",
    "audio_routing",
    "tool_use",
  ];
}
