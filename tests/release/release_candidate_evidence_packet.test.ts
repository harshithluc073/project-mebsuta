import { describe, expect, it } from "vitest";

import {
  defaultDependencyGateRegistry,
  evaluateGateReadiness,
  type DependencyGate,
  type GateReadinessDecision,
} from "../../src/operations/dependency_gate_registry";
import { buildReleaseTrainPlan } from "../../src/operations/release_train_planner";
import { buildMilestoneHealthReport, defaultHealthIndicators } from "../../src/operations/milestone_health_report";
import { buildWbsTask } from "../../src/operations/wbs_task_catalog";
import { buildReleaseReadinessReport, type ReleaseGateEvidence, type ReleaseReadinessReport } from "../../src/qa/release_readiness_report";
import { buildReleaseRiskGateReport, type ReleaseRiskGateReport } from "../../src/risk/release_risk_gate_evaluator";
import { buildRiskScore } from "../../src/risk/risk_scoring_model";
import {
  REQUIRED_RELEASE_SIGN_OFF_ROLES,
  aggregateReleaseReadiness,
  buildReleaseCandidateEvidencePacket,
  evaluateReleaseCandidateDependencyGates,
  summarizeDependencyGateClosure,
  summarizeSignOffCompleteness,
  validateReleaseCandidateEvidencePacket,
  type ReleaseCandidateEvidencePacketInput,
  type ReleaseSignOffInput,
} from "../../src/release/release_candidate_evidence_packet";

describe("PIT-B16 release candidate evidence packet", () => {
  it("aggregates green release readiness evidence without review conditions", () => {
    const readiness = aggregateReleaseReadiness(greenReadinessReport());

    expect(readiness.status).toBe("green");
    expect(readiness.decision).toBe("go");
    expect(readiness.red_gate_count).toBe(0);
    expect(readiness.conditional_gate_count).toBe(0);
    expect(readiness.evidence_refs).toContain("qa:release-readiness:pit-b16");
    expect(readiness.evidence_refs).toContain("evidence:gate:unit");
  });

  it("surfaces risk gate no-go decisions in the final packet", () => {
    const packet = buildReleaseCandidateEvidencePacket({
      ...greenInput(),
      release_risk_gate_report: blockedRiskGate(),
    });

    expect(packet.decision).toBe("no_go");
    expect(packet.release_risk_gate_report.decision).toBe("no_go");
    expect(packet.no_go_conditions.some((condition) => condition.startsWith("risk gate no-go:"))).toBe(true);
  });

  it("evaluates G1-G10 dependency gate closure from required evidence", () => {
    const gates = defaultDependencyGateRegistry();
    const decisions = evaluateReleaseCandidateDependencyGates(gates, allGateEvidence(gates));
    const closure = summarizeDependencyGateClosure(decisions);

    expect(decisions).toHaveLength(10);
    expect(closure.status).toBe("green");
    expect(closure.missing_gate_refs).toEqual([]);
    expect(closure.red_gate_refs).toEqual([]);
    expect(closure.closed_gate_refs).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"]);
  });

  it("blocks the packet when dependency gate closure is incomplete", () => {
    const gates = defaultDependencyGateRegistry();
    const availableEvidence = allGateEvidence(gates).filter((ref) => ref !== "release_readiness_report");
    const packet = buildReleaseCandidateEvidencePacket({
      ...greenInput(),
      dependency_gate_decisions: evaluateReleaseCandidateDependencyGates(gates, availableEvidence),
    });

    expect(packet.decision).toBe("no_go");
    expect(packet.dependency_gate_closure.status).toBe("red");
    expect(packet.dependency_gate_closure.red_gate_refs).toEqual(["G10"]);
    expect(packet.no_go_conditions).toContain("dependency gate closure is red.");
  });

  it("projects milestone health review state into conditional packet decisions", () => {
    const gateDecisions = greenGateDecisions().map((decision) => decision.gate_ref === "G6"
      ? { ...decision, status: "amber" as const, unresolved_issue_refs: ["issue:pit-b16:memory-gate-review"] }
      : decision);
    const packet = buildReleaseCandidateEvidencePacket({
      ...greenInput(),
      milestone_health_report: milestoneHealth(gateDecisions),
    });

    expect(packet.decision).toBe("conditional_go");
    expect(packet.milestone_health.status).toBe("amber");
    expect(packet.conditional_go_conditions).toContain("milestone health requires review.");
  });

  it("requires complete release sign-offs before a go packet", () => {
    const completePacket = buildReleaseCandidateEvidencePacket(greenInput());
    const missingSignOffs = greenSignOffs().filter((signOff) => signOff.role !== "security");
    const blockedPacket = buildReleaseCandidateEvidencePacket({
      ...greenInput(),
      sign_offs: missingSignOffs,
    });
    const completeness = summarizeSignOffCompleteness(completePacket.sign_offs);

    expect(completePacket.decision).toBe("go");
    expect(validateReleaseCandidateEvidencePacket(completePacket).ok).toBe(true);
    expect(completeness.status).toBe("approved");
    expect(blockedPacket.decision).toBe("no_go");
    expect(blockedPacket.sign_off_completeness.status).toBe("missing");
    expect(blockedPacket.sign_off_completeness.missing_roles).toEqual(["security"]);
  });
});

function greenInput(): ReleaseCandidateEvidencePacketInput {
  const gateDecisions = greenGateDecisions();
  return {
    packet_ref: "release-packet:pit-b16:green",
    release_candidate_ref: "rc:pit-b16:2026-05-08",
    source_revision_ref: "source:pit-b16:revision",
    generated_at_iso: "2026-05-08T00:00:00.000Z",
    release_readiness_report: greenReadinessReport(),
    release_risk_gate_report: greenRiskGate(),
    dependency_gate_decisions: gateDecisions,
    milestone_health_report: milestoneHealth(gateDecisions),
    sign_offs: greenSignOffs(),
    release_manifest_refs: ["manifest:pit-b16:release-candidate"],
    build_metadata_refs: ["build:pit-b16:metadata"],
    test_report_refs: ["test:pit-b16:full-suite"],
    security_evidence_refs: ["security:pit-b16:secret-scan"],
    operations_evidence_refs: ["operations:pit-b16:readiness"],
    rollback_evidence_refs: ["rollback:pit-b16:readiness"],
    operator_summary: "PIT-B16 final release candidate evidence packet is complete for release-owner review.",
  };
}

function greenReadinessReport(): ReleaseReadinessReport {
  return buildReleaseReadinessReport({
    release_report_ref: "qa:release-readiness:pit-b16",
    milestone_ref: "M9",
    gate_evidence: greenReleaseGates(),
    benchmark_scorecard_refs: ["qa:scorecard:pit-b16"],
    regression_report_refs: ["qa:regression:pit-b16"],
    chaos_record_refs: ["qa:chaos:pit-b16"],
    no_go_conditions: [],
    operator_summary: "Release readiness evidence is green across release candidate gates.",
  });
}

function greenReleaseGates(): readonly ReleaseGateEvidence[] {
  return [
    gateEvidence("gate:architecture:pit-b16", "architecture_contract", "evidence:gate:architecture"),
    gateEvidence("gate:unit:pit-b16", "unit_test", "evidence:gate:unit"),
    gateEvidence("gate:integration:pit-b16", "integration", "evidence:gate:integration"),
    gateEvidence("gate:scenario:pit-b16", "scenario_benchmark", "evidence:gate:scenario"),
    gateEvidence("gate:safety:pit-b16", "safety", "evidence:gate:safety"),
    gateEvidence("gate:observability:pit-b16", "observability", "evidence:gate:observability"),
  ];
}

function gateEvidence(gateRef: string, gateClass: ReleaseGateEvidence["gate_class"], evidenceRef: string): ReleaseGateEvidence {
  return {
    gate_ref: gateRef,
    gate_class: gateClass,
    status: "green",
    evidence_refs: [evidenceRef],
    summary: `${gateClass} release candidate evidence is green.`,
  };
}

function greenRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b16:green",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    operator_summary: "Risk gate is green with no release-blocking conditions.",
  });
}

function blockedRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b16:blocked",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [buildRiskScore({
      score_ref: "risk-score:pit-b16:blocker",
      risk_ref: "risk:pit-b16:blocker",
      severity: "critical",
      likelihood: "occasional",
      mitigation_efficacy_ratio: 0.2,
      detection_confidence_ratio: 0.5,
      no_go_condition: true,
    })],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    operator_summary: "Release-blocking risk remains active.",
  });
}

function greenGateDecisions(): readonly GateReadinessDecision[] {
  const gates = defaultDependencyGateRegistry();
  return gates.map((gate) => evaluateGateReadiness({
    gate,
    available_evidence_refs: allGateEvidence(gates),
    unresolved_issue_refs: [],
  }));
}

function allGateEvidence(gates: readonly DependencyGate[]): readonly string[] {
  return gates.flatMap((gate) => gate.required_evidence_refs);
}

function milestoneHealth(gateDecisions: readonly GateReadinessDecision[]) {
  const releasePlan = buildReleaseTrainPlan({
    release_plan_ref: "release-plan:pit-b16",
    release_type: "release_candidate",
    milestone_window: ["M9"],
    candidate_artifact_refs: ["artifact:pit-b16:candidate"],
    gate_decisions: gateDecisions,
  });
  return buildMilestoneHealthReport({
    health_report_ref: "milestone-health:pit-b16",
    milestone_ref: "M9",
    generated_at_iso: "2026-05-08T00:00:00.000Z",
    wbs_tasks: [
      buildWbsTask({
        wbs_task_ref: "wbs:pit-b16:release-packet",
        package_ref: "16.0",
        task_title: "Close release candidate evidence packet",
        owning_workstream_ref: "WS-Q",
        milestone_refs: ["M9"],
        dependency_refs: [],
        expected_challenge: "Keeping release evidence complete and scoped.",
        acceptance_criteria: ["Release packet captures readiness, risk, gates, health, and sign-offs."],
        status: "complete",
      }),
    ],
    gate_decisions: gateDecisions,
    release_plan: releasePlan,
    qa_signal_refs: ["qa:pit-b16:release-readiness"],
    risk_refs: [],
    operational_readiness_refs: ["operations:pit-b16:release-review"],
    indicators: defaultHealthIndicators(["evidence:pit-b16:milestone"]),
  });
}

function greenSignOffs(): readonly ReleaseSignOffInput[] {
  return REQUIRED_RELEASE_SIGN_OFF_ROLES.map((role) => ({
    role,
    signer_ref: `signer:pit-b16:${role}`,
    status: "approved",
    evidence_refs: [`signoff:pit-b16:${role}`],
    signed_at_iso: "2026-05-08T00:00:00.000Z",
    summary: `${role} owner approved the release candidate evidence packet.`,
  }));
}
