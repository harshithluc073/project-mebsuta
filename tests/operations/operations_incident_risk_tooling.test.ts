import { describe, expect, it } from "vitest";

import { defaultOperationalReadinessRegistry, type OperationalRunbook } from "../../src/operations/operational_runbook_registry";
import { defaultReviewCadences } from "../../src/operations/review_cadence_scheduler";
import {
  executeOperationsIncidentRiskTooling,
  normalizeOnCallCoverageReport,
  normalizeOperationsIncidentLifecycle,
  normalizeRiskAcceptanceRecord,
  normalizeRunbookExecutionReport,
  projectRiskBoard,
  validateReleaseResumptionReport,
  type OnCallCoverageInput,
  type OperationsIncidentLifecycleInput,
  type ReleaseResumptionInput,
  type RiskAcceptanceInput,
  type RunbookExecutionInput,
} from "../../src/operations/operations_incident_risk_tooling";
import { buildReleaseRiskGateReport, type ReleaseRiskGateReport } from "../../src/risk/release_risk_gate_evaluator";
import { buildRiskRegisterEntry, type RiskRegisterEntry } from "../../src/risk/risk_register_entry";
import { buildRiskScore } from "../../src/risk/risk_scoring_model";

describe("PIT-B14 operations incident and risk tooling", () => {
  it("resumes release after incident closure, runbook execution, review coverage, green risk gate, and resumption evidence are complete", () => {
    const report = executeOperationsIncidentRiskTooling(greenInput());

    expect(report.decision).toBe("resume");
    expect(report.no_go_conditions).toEqual([]);
    expect(report.conditional_conditions).toEqual([]);
    expect(report.incident.closure_ready).toBe(true);
    expect(report.runbook_execution.status).toBe("green");
    expect(report.on_call_coverage.status).toBe("green");
    expect(report.release_risk_gate_report.decision).toBe("go");
    expect(report.risk_board_projection.release_blocker_count).toBe(0);
    expect(validateReleaseResumptionReport(report).ok).toBe(true);
  });

  it("routes incident lifecycle to SafeHold when critical response still lacks safety evidence", () => {
    const incident = normalizeOperationsIncidentLifecycle({
      ...incidentInput(),
      severity: "sev0",
      status: "stabilized",
      safehold_required: true,
      safehold_evidence_refs: [],
      preserved_evidence_refs: ["evidence:pit-b14:timeline"],
    });
    const report = executeOperationsIncidentRiskTooling({
      ...greenInput(),
      incident: {
        ...incidentInput(),
        severity: "sev0",
        status: "stabilized",
        safehold_required: true,
        safehold_evidence_refs: [],
        preserved_evidence_refs: ["evidence:pit-b14:timeline"],
      },
    });

    expect(incident.route_decision).toBe("safe_hold");
    expect(incident.closure_ready).toBe(false);
    expect(incident.missing_evidence_refs).toEqual(["evidence:pit-b14:replay", "evidence:pit-b14:safety"]);
    expect(report.decision).toBe("blocked");
    expect(report.no_go_conditions).toContain("incident_lifecycle_not_closed");
    expect(report.no_go_conditions).toContain("safehold_evidence_missing");
  });

  it("marks runbook execution red when required steps or runbook evidence refs are missing", () => {
    const runbookExecution = normalizeRunbookExecutionReport({
      ...runbookExecutionInput(),
      completed_step_refs: ["step:pit-b14:classify"],
      evidence_refs: ["incident_record"],
    });
    const report = executeOperationsIncidentRiskTooling({
      ...greenInput(),
      runbook_execution: {
        ...runbookExecutionInput(),
        completed_step_refs: ["step:pit-b14:classify"],
        evidence_refs: ["incident_record"],
      },
    });

    expect(runbookExecution.status).toBe("red");
    expect(runbookExecution.missing_step_refs).toEqual(["step:pit-b14:preserve", "step:pit-b14:validate"]);
    expect(runbookExecution.missing_runbook_evidence_refs).toContain("runbook_execution_record");
    expect(report.decision).toBe("blocked");
    expect(report.no_go_conditions).toContain("runbook_execution_red");
  });

  it("blocks release resumption when on-call or review evidence is incomplete", () => {
    const coverage = normalizeOnCallCoverageReport({
      ...onCallCoverageInput(),
      primary_responder_refs: [],
      available_review_input_refs: ["safety_reports"],
    });
    const report = executeOperationsIncidentRiskTooling({
      ...greenInput(),
      on_call_coverage: {
        ...onCallCoverageInput(),
        primary_responder_refs: [],
        available_review_input_refs: ["safety_reports"],
      },
    });

    expect(coverage.status).toBe("red");
    expect(coverage.missing_review_input_refs).toContain("risk_updates");
    expect(report.decision).toBe("blocked");
    expect(report.no_go_conditions).toContain("on_call_or_review_coverage_red");
  });

  it("blocks release resumption when the risk gate is no-go and the risk board has stale acceptance evidence", () => {
    const expiredAcceptance = normalizeRiskAcceptanceRecord({
      ...acceptanceInput(),
      expires_at_iso: "2026-05-07T00:00:00.000Z",
      evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    });
    const board = projectRiskBoard("risk-board:pit-b14:stale", risks("monitored"), [expiredAcceptance]);
    const report = executeOperationsIncidentRiskTooling({
      ...greenInput(),
      release_risk_gate_report: noGoRiskGate(),
      risk_acceptances: [{
        ...acceptanceInput(),
        expires_at_iso: "2026-05-07T00:00:00.000Z",
        evaluated_at_iso: "2026-05-08T00:00:00.000Z",
      }],
    });

    expect(board.stale_acceptance_refs).toEqual(["acceptance:pit-b14:frontend-freshness"]);
    expect(report.release_risk_gate_report.decision).toBe("no_go");
    expect(report.decision).toBe("blocked");
    expect(report.no_go_conditions).toContain("release_risk_gate_not_green");
    expect(report.no_go_conditions).toContain("risk_board_has_release_blockers");
  });

  it("routes conditional resumption when an accepted limitation requires monitoring", () => {
    const accepted = normalizeRiskAcceptanceRecord(acceptanceInput());
    const report = executeOperationsIncidentRiskTooling({
      ...greenInput(),
      risk_acceptances: [acceptanceInput()],
    });

    expect(accepted.decision).toBe("accepted");
    expect(report.decision).toBe("conditional_resume");
    expect(report.conditional_conditions).toContain("accepted_limitations_require_monitoring");
    expect(report.risk_board_projection.accepted_risk_refs).toEqual(["R-061"]);
  });
});

function greenInput(): ReleaseResumptionInput {
  const observedEvidence = ["evidence:pit-b14:incident-closed", "evidence:pit-b14:risk-green", "evidence:pit-b14:on-call"];
  return {
    resumption_ref: "resumption:pit-b14:green",
    incident: incidentInput(),
    runbook_execution: runbookExecutionInput(),
    on_call_coverage: onCallCoverageInput(),
    release_risk_gate_report: greenRiskGate(),
    risk_acceptances: [],
    risk_register_entries: risks("monitored"),
    required_resumption_evidence_refs: observedEvidence,
    observed_resumption_evidence_refs: observedEvidence,
    operator_summary: "PIT-B14 release resumption evidence is closed through incident, runbook, review, and risk gates.",
  };
}

function incidentInput(): OperationsIncidentLifecycleInput {
  return {
    incident_ref: "incident:pit-b14:frontend-stale-state",
    severity: "sev2",
    status: "closed",
    detected_at_iso: "2026-05-08T00:00:00.000Z",
    owner_role_refs: ["owner:operations", "owner:frontend"],
    affected_surface_refs: ["surface:frontend", "surface:release"],
    required_evidence_refs: ["evidence:pit-b14:timeline", "evidence:pit-b14:replay", "evidence:pit-b14:safety"],
    preserved_evidence_refs: ["evidence:pit-b14:timeline", "evidence:pit-b14:replay", "evidence:pit-b14:safety"],
    runbook_ref: "safety_runbook",
    safehold_required: false,
    safehold_evidence_refs: [],
    release_impacting: false,
    operator_summary: "Incident is classified, evidence is preserved, and validation is complete.",
  };
}

function runbookExecutionInput(): RunbookExecutionInput {
  return {
    execution_ref: "runbook-execution:pit-b14:frontend-stale-state",
    incident_ref: "incident:pit-b14:frontend-stale-state",
    runbook: runbook(),
    required_step_refs: ["step:pit-b14:classify", "step:pit-b14:preserve", "step:pit-b14:validate"],
    completed_step_refs: ["step:pit-b14:classify", "step:pit-b14:preserve", "step:pit-b14:validate"],
    evidence_refs: ["incident_record", "runbook_execution_record", "post_incident_review", "risk_update"],
    reviewer_refs: ["reviewer:operations"],
    operator_summary: "Runbook execution completed required classification, preservation, and validation steps.",
  };
}

function onCallCoverageInput(): OnCallCoverageInput {
  return {
    coverage_ref: "coverage:pit-b14:release-window",
    active_window_ref: "window:pit-b14:release",
    primary_responder_refs: ["responder:primary:operations"],
    secondary_responder_refs: ["responder:secondary:safety"],
    escalation_owner_refs: ["owner:release"],
    review_cadences: defaultReviewCadences().filter((cadence) => cadence.meeting_kind === "safety_review"),
    available_review_input_refs: ["safety_reports", "risk_updates"],
    scheduled_from_iso: "2026-05-08T00:00:00.000Z",
    operator_summary: "On-call and safety review coverage are present for the release window.",
  };
}

function acceptanceInput(): RiskAcceptanceInput {
  return {
    acceptance_ref: "acceptance:pit-b14:frontend-freshness",
    risk_ref: "R-061",
    owner_ref: "owner:frontend",
    accepted_limitation_ref: "limitation:pit-b14:frontend-refresh-monitoring",
    evidence_refs: ["evidence:pit-b14:monitoring"],
    release_scope_refs: ["scope:pit-b14:operator-dashboard"],
    expires_at_iso: "2026-05-15T00:00:00.000Z",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    revoked: false,
    operator_summary: "Frontend freshness limitation is accepted with monitoring and release-scope constraints.",
  };
}

function runbook(): OperationalRunbook {
  const safetyRunbook = defaultOperationalReadinessRegistry().runbooks.find((item) => item.runbook_ref === "safety_runbook");
  if (safetyRunbook === undefined) {
    throw new Error("safety_runbook missing from default registry");
  }
  return {
    ...safetyRunbook,
    evidence_refs: ["incident_record", "runbook_execution_record", "post_incident_review", "risk_update"],
  };
}

function greenRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b14:green",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    operator_summary: "PIT-B14 operations risk gate has no unresolved release-blocking conditions.",
  });
}

function noGoRiskGate(): ReleaseRiskGateReport {
  return buildReleaseRiskGateReport({
    gate_report_ref: "risk-gate:pit-b14:no-go",
    milestone_ref: "M9",
    evaluated_at_iso: "2026-05-08T00:00:00.000Z",
    risk_scores: [buildRiskScore({
      score_ref: "score:pit-b14:r-061",
      risk_ref: "R-061",
      severity: "critical",
      likelihood: "occasional",
      no_go_condition: true,
    })],
    monitoring_events: [],
    mitigation_coverage_reports: [],
    operator_summary: "Critical frontend operations risk remains release-blocking.",
  });
}

function risks(status: RiskRegisterEntry["current_status"]): readonly RiskRegisterEntry[] {
  return [buildRiskRegisterEntry({
    risk_ref: "R-061",
    risk_name: "Frontend stale operational state",
    risk_category: "R-OPS",
    risk_statement: "If operator status is stale, then release resumption can proceed with outdated incident evidence.",
    root_causes: ["Dashboard refresh gap"],
    trigger_signals: ["Freshness monitor warning"],
    severity: status === "blocker" ? "critical" : "medium",
    likelihood: "occasional",
    detection_methods: ["Operations dashboard freshness test"],
    primary_mitigations: ["Stale-state lockout"],
    contingency_plan: ["Pause release resumption"],
    owner_category: "program_management",
    related_architecture_docs: ["21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md", "22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md"],
    related_qa_gates: ["operations_incident_risk_tooling_tests"],
    current_status: status,
    no_go_condition: status === "blocker",
  })];
}
