import { describe, expect, it } from "vitest";

import { defaultDependencyGateRegistry, type DependencyGate } from "../../src/operations/dependency_gate_registry";
import { buildReleaseRiskGateReport, type ReleaseRiskGateReport } from "../../src/risk/release_risk_gate_evaluator";
import { buildRiskScore } from "../../src/risk/risk_scoring_model";
import {
  executeCiCdReleaseGateAutomation,
  normalizeRollbackReadiness,
  normalizeWorkflowEvidenceRecord,
  validateCiCdReleaseGateAutomationReport,
  type CiCdWorkflowKind,
  type CiCdReleaseGateAutomationInput,
  type RollbackReadinessInput,
  type WorkflowEvidenceInput,
} from "../../src/release/ci_cd_release_gate_automation";

describe("PIT-B12 CI/CD release gate automation", () => {
  it("generates a go release evidence packet when workflows, dependency gates, risk gates, and rollback evidence are green", () => {
    const report = executeCiCdReleaseGateAutomation(greenInput());

    expect(report.decision).toBe("go");
    expect(report.no_go_conditions).toEqual([]);
    expect(report.conditional_go_conditions).toEqual([]);
    expect(report.workflow_records).toHaveLength(7);
    expect(report.workflow_records.every((workflow) => workflow.route_decision === "continue")).toBe(true);
    expect(report.dependency_gate_decisions.every((gate) => gate.status === "green")).toBe(true);
    expect(report.release_train_plan.decision).toBe("ready");
    expect(report.release_risk_gate_report.decision).toBe("go");
    expect(report.rollback_readiness.status).toBe("green");
    expect(report.release_evidence_packet.workflow_refs).toHaveLength(7);
    expect(report.release_evidence_packet.dependency_gate_refs).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"]);
    expect(validateCiCdReleaseGateAutomationReport(report).ok).toBe(true);
  });

  it("blocks release when workflow evidence is incomplete and dependency gates are red", () => {
    const gates = defaultDependencyGateRegistry();
    const input = {
      ...greenInput(),
      workflow_evidence: workflows().map((workflow) => workflow.workflow_kind === "release_candidate"
        ? { ...workflow, observed_evidence_refs: workflow.observed_evidence_refs.filter((ref) => ref !== "evidence:release_candidate:release-packet") }
        : workflow),
      available_dependency_evidence_refs: allGateEvidence(gates).filter((ref) => ref !== "release_readiness_report"),
    };
    const report = executeCiCdReleaseGateAutomation(input);

    expect(report.decision).toBe("no_go");
    expect(report.workflow_records.find((workflow) => workflow.workflow_kind === "release_candidate")?.route_decision).toBe("release_block");
    expect(report.dependency_gate_decisions.find((gate) => gate.gate_ref === "G10")?.status).toBe("red");
    expect(report.release_train_plan.decision).toBe("blocked");
    expect(report.no_go_conditions).toContain("1 workflow evidence records are red.");
    expect(report.no_go_conditions).toContain("release train plan is blocked.");
    expect(report.release_evidence_packet.decision).toBe("no_go");
  });

  it("routes conditional review when package-script evidence is complete but risk or dependency review remains", () => {
    const report = executeCiCdReleaseGateAutomation({
      ...greenInput(),
      workflow_evidence: workflows().map((workflow) => workflow.workflow_kind === "nightly"
        ? { ...workflow, optional_warning_refs: ["warning:nightly:benchmark-flake-review"] }
        : workflow),
      dependency_issue_refs: { G6: ["issue:g6:memory-label-review"] },
      release_risk_gate_report: conditionalRiskGate(),
    });

    expect(report.decision).toBe("conditional_go");
    expect(report.no_go_conditions).toEqual([]);
    expect(report.conditional_go_conditions).toContain("1 workflow evidence records require conditional review.");
    expect(report.conditional_go_conditions).toContain("release train plan is conditional.");
    expect(report.conditional_go_conditions).toContain("release risk gate is conditional_go.");
    expect(report.workflow_records.find((workflow) => workflow.workflow_kind === "nightly")?.route_decision).toBe("conditional_review");
    expect(report.dependency_gate_decisions.find((gate) => gate.gate_ref === "G6")?.status).toBe("amber");
  });

  it("blocks release when rollback readiness lacks state or smoke evidence", () => {
    const rollback = normalizeRollbackReadiness({
      ...rollbackReadiness(),
      observed_state_snapshot_refs: ["state:preflight:artifact"],
      observed_smoke_refs: ["smoke:rollback:auth"],
    });

    expect(rollback.status).toBe("red");
    expect(rollback.missing_state_snapshot_refs).toEqual(["state:preflight:event-ledger"]);
    expect(rollback.missing_smoke_refs).toEqual(["smoke:rollback:runtime-readiness"]);

    const report = executeCiCdReleaseGateAutomation({
      ...greenInput(),
      rollback_readiness: {
        ...rollbackReadiness(),
        observed_state_snapshot_refs: ["state:preflight:artifact"],
        observed_smoke_refs: ["smoke:rollback:auth"],
      },
    });

    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("rollback readiness is red.");
    expect(report.release_evidence_packet.rollback_report_ref).toBe("rollback:pit-b12:readiness");
  });

  it("normalizes individual workflow route decisions from required command and evidence closure", () => {
    const green = normalizeWorkflowEvidenceRecord(workflow("pull_request"));
    const red = normalizeWorkflowEvidenceRecord({
      ...workflow("main"),
      completed_command_refs: ["cmd:main:typecheck"],
    });
    const amber = normalizeWorkflowEvidenceRecord({
      ...workflow("nightly"),
      optional_warning_refs: ["warning:nightly:trend-review"],
    });

    expect(green.status).toBe("green");
    expect(green.route_decision).toBe("continue");
    expect(red.status).toBe("red");
    expect(red.route_decision).toBe("release_block");
    expect(amber.status).toBe("amber");
    expect(amber.route_decision).toBe("conditional_review");
  });
});

function greenInput(): CiCdReleaseGateAutomationInput {
  const gates = defaultDependencyGateRegistry();
  return {
    automation_run_ref: "release-auto:pit-b12:green",
    release_candidate_ref: "rc:pit-b12:2026-05-08",
    source_revision_ref: "source:pit-b12:revision",
    package_lock_fingerprint_ref: "lock:pit-b12:npm",
    build_metadata_refs: ["build:metadata:pit-b12"],
    workflow_evidence: workflows(),
    dependency_gates: gates,
    available_dependency_evidence_refs: allGateEvidence(gates),
    candidate_artifact_refs: ["artifact:pit-b12:runtime", "artifact:pit-b12:frontend", "artifact:pit-b12:qa"],
    release_risk_gate_report: greenRiskGate(),
    rollback_readiness: rollbackReadiness(),
    qa_evidence_refs: ["qa:scorecard:pit-b12", "qa:runtime-contract:pit-b12"],
    security_evidence_refs: ["security:secret-scan:pit-b12", "security:dependency-audit:pit-b12"],
    operator_summary: "PIT-B12 release gate automation evidence is complete and ready for release-owner review.",
  };
}

function workflows(): readonly WorkflowEvidenceInput[] {
  return [
    workflow("pull_request"),
    workflow("main"),
    workflow("nightly"),
    workflow("release_candidate"),
    workflow("staging"),
    workflow("production"),
    workflow("rollback"),
  ];
}

function workflow(kind: CiCdWorkflowKind): WorkflowEvidenceInput {
  const evidence = requiredEvidenceFor(kind);
  return {
    workflow_ref: `workflow:pit-b12:${kind}`,
    workflow_kind: kind,
    required_command_refs: [`cmd:${kind}:typecheck`, `cmd:${kind}:test`, `cmd:${kind}:scan`],
    completed_command_refs: [`cmd:${kind}:typecheck`, `cmd:${kind}:test`, `cmd:${kind}:scan`],
    required_evidence_refs: evidence,
    observed_evidence_refs: evidence,
    artifact_refs: [`artifact:pit-b12:${kind}`],
    started_at_ms: 1_000,
    ended_at_ms: 1_300,
    operator_summary: `${kind} workflow evidence is closed through package-script gates.`,
  };
}

function requiredEvidenceFor(kind: CiCdWorkflowKind): readonly string[] {
  const common = [`evidence:${kind}:script-results`, `evidence:${kind}:secret-scan`];
  if (kind === "release_candidate") {
    return [...common, "evidence:release_candidate:release-packet"];
  }
  if (kind === "rollback") {
    return [...common, "evidence:rollback:readiness"];
  }
  return common;
}

function allGateEvidence(gates: readonly DependencyGate[]): readonly string[] {
  return gates.flatMap((gate) => gate.required_evidence_refs);
}

function rollbackReadiness(): RollbackReadinessInput {
  return {
    rollback_report_ref: "rollback:pit-b12:readiness",
    candidate_artifact_ref: "artifact:pit-b12:runtime",
    previous_artifact_ref: "artifact:pit-b11:runtime",
    rollback_runbook_ref: "runbook:rollback:pit-b12",
    required_state_snapshot_refs: ["state:preflight:artifact", "state:preflight:event-ledger"],
    observed_state_snapshot_refs: ["state:preflight:artifact", "state:preflight:event-ledger"],
    required_smoke_refs: ["smoke:rollback:auth", "smoke:rollback:runtime-readiness"],
    observed_smoke_refs: ["smoke:rollback:auth", "smoke:rollback:runtime-readiness"],
    evidence_preservation_refs: ["evidence:preserve:release-packet", "evidence:preserve:replay"],
  };
}

function greenRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b12:green",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    operator_summary: "No release-blocking risk conditions are present in this PIT-B12 fixture.",
  });
}

function conditionalRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b12:conditional",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [buildRiskScore({
      score_ref: "risk-score:pit-b12:conditional",
      risk_ref: "risk:pit-b12:residual-review",
      severity: "high",
      likelihood: "frequent",
      mitigation_efficacy_ratio: 0.3,
      detection_confidence_ratio: 0.3,
      no_go_condition: false,
    })],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    acknowledged_limitation_refs: ["limitation:pit-b12:conditional-review"],
    operator_summary: "High residual risk requires monitored release constraints.",
  });
}
