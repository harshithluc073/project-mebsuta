import { describe, expect, it } from "vitest";

import { TelemetryReplayFoundation } from "../../src/observability/telemetry_replay_foundation";

describe("PIT-B06 observability telemetry replay foundation", () => {
  it("emits structured telemetry events, logs, metrics, traces, and dashboard-safe replay evidence", () => {
    const foundation = new TelemetryReplayFoundation();
    const perception = foundation.recordTelemetry({
      artifact_ref: "artifact:perception:summary",
      event_time_ms: 7_000,
      event_class: "perception",
      subsystem_ref: "perception:multi_view",
      severity: "info",
      summary: "Camera evidence shows the target with partial occlusion.",
      artifact_refs: ["evidence:camera:front", "evidence:view_quality"],
      task_ref: "task:observability",
      state_ref: "state:observe",
      provenance_status: "runtime_embodied",
      dashboard_visibility: "operator",
      metric_name: "perception.view_quality.count",
      metric_value: 2,
      trace_start_ms: 6_990,
      trace_end_ms: 7_000,
      policy_refs: ["policy:pit-b06:observability"],
    });
    const verification = foundation.recordTelemetry({
      artifact_ref: "artifact:verification:certificate",
      event_time_ms: 7_050,
      event_class: "verification",
      subsystem_ref: "verification:coordinator",
      severity: "info",
      summary: "Verification certificate confirms placement using embodied evidence.",
      artifact_refs: ["certificate:placement", "evidence:camera:side"],
      task_ref: "task:observability",
      state_ref: "state:verify",
      provenance_status: "runtime_embodied",
      dashboard_visibility: "operator",
      metric_name: "verification.latency_ms",
      metric_value: 42.25,
      trace_start_ms: 7_010,
      trace_end_ms: 7_050,
      policy_refs: ["policy:pit-b06:observability"],
      verification_certificate_refs: ["certificate:placement"],
    });
    const projection = foundation.projectTelemetryEvidence({
      projection_ref: "projection:observability:runtime",
      task_ref: "task:observability",
      projection_time_ms: 7_100,
      packets: [perception, verification],
      visibility_mode: "operator",
      replay_policy: { visibility_mode: "operator", include_qa_events: false, preserve_safety_events: true },
    });

    expect(perception.event.summary).toContain("Camera evidence");
    expect(perception.log_record.event_ref).toBe(perception.event.observability_event_ref);
    expect(verification.metric_sample.metric_kind).toBe("latency_ms");
    expect(verification.trace_span.duration_ms).toBe(40);
    expect(projection.dashboard_snapshot.visibility_mode).toBe("operator");
    expect(projection.replay_bundle.completeness_score).toBe(1);
    expect(projection.boundary_label).toBe("runtime");
  });

  it("redacts secrets, hidden truth, prompt internals, and QA truth from telemetry surfaces", () => {
    const foundation = new TelemetryReplayFoundation();
    const packet = foundation.recordTelemetry({
      artifact_ref: "artifact:redaction:unsafe",
      event_time_ms: 8_000,
      event_class: "cognition",
      subsystem_ref: "cognitive:adapter",
      severity: "warning",
      summary: "Raw prompt included bearer abcdefghijklmnopqrstuvwxyz012345 and scene graph object_id plus qa_label details.",
      artifact_refs: ["artifact:prompt:redaction"],
      task_ref: "task:redaction",
      state_ref: "state:plan",
      provenance_status: "runtime_embodied",
      dashboard_visibility: "developer",
      metric_name: "cognition.redaction.count",
      metric_value: 1,
      trace_start_ms: 7_990,
      trace_end_ms: 8_000,
      policy_refs: ["policy:pit-b06:redaction"],
    });

    expect(packet.redaction_manifest.rules_applied).toContain("secret_redaction");
    expect(packet.redaction_manifest.rules_applied).toContain("hidden_truth_redaction");
    expect(packet.redaction_manifest.rules_applied).toContain("qa_truth_redaction");
    expect(packet.log_record.message).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(packet.log_record.message).not.toContain("object_id");
    expect(packet.alert_records.some((alert) => alert.alert_kind === "secret_redaction")).toBe(true);
    expect(packet.alert_records.some((alert) => alert.alert_kind === "qa_truth_runtime_visibility")).toBe(true);
  });

  it("preserves safety alerts, retention evidence, and release-blocking replay completeness signals", () => {
    const foundation = new TelemetryReplayFoundation();
    const safety = foundation.recordTelemetry({
      artifact_ref: "artifact:safety:safehold",
      event_time_ms: 9_000,
      event_class: "safety",
      subsystem_ref: "safety:runtime_monitor",
      severity: "critical",
      summary: "SafeHold entered after high-force contact evidence.",
      artifact_refs: ["safety_report:force", "safe_hold:state"],
      task_ref: "task:safety",
      state_ref: "state:safe_hold",
      provenance_status: "policy",
      dashboard_visibility: "safety_review",
      metric_name: "safety.safehold.count",
      metric_value: 1,
      trace_start_ms: 8_995,
      trace_end_ms: 9_000,
      policy_refs: ["policy:pit-b06:safety-alert"],
      requires_safety_acknowledgement: true,
    });
    const projection = foundation.projectTelemetryEvidence({
      projection_ref: "projection:observability:safety",
      task_ref: "task:safety",
      projection_time_ms: 20_000,
      packets: [safety],
      visibility_mode: "safety_review",
      replay_policy: { visibility_mode: "safety_review", include_qa_events: false, preserve_safety_events: true },
      retention_policy: {
        retention_policy_ref: "retention_policy:pit-b06",
        routine_ttl_ms: 5_000,
        archive_after_ms: 30_000,
        preserve_safety_and_verification: true,
        preserve_redaction_audits: true,
        preserve_replay_bundles: true,
      },
    });

    expect(safety.alert_records.some((alert) => alert.alert_kind === "safety_acknowledgement_missing")).toBe(true);
    expect(projection.retention_report_ref).toBe("retention_report:retention_policy:pit-b06:20000");
    expect(projection.release_blocking_alert_refs.length).toBeGreaterThan(0);
    expect(projection.replay_bundle.evidence_refs).toContain("safe_hold:state");
  });
});
