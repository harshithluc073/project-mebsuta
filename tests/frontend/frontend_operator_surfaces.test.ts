import { describe, expect, it } from "vitest";

import type { DashboardStateSnapshot, ReplayBundle } from "../../src/observability/observability_event_emitter";
import type { TelemetryAlertRecord } from "../../src/observability/telemetry_replay_foundation";
import { buildActorContext, type ActorContext, type AuthRole, type RuntimeScope } from "../../src/auth/actor_context";
import {
  buildOperatorSurfaceModel,
  isFrontendStateStale,
  listOperatorSurfaceDefinitions,
  sanitizeFrontendText,
  type FrontendConnectionState,
  type OperatorSurfaceInput,
  type OperatorSurfaceMode,
} from "../../src/frontend/operator_surface_foundation";

describe("PIT-B07 frontend operator surfaces", () => {
  it("declares the authorized dashboard, launcher, replay, safety, QA, risk, incident, and release surfaces", () => {
    const routeIds = listOperatorSurfaceDefinitions().map((definition) => definition.route_id);

    expect(routeIds).toEqual([
      "runtime_dashboard",
      "scenario_launcher",
      "replay_review",
      "safety_controls",
      "qa_evidence",
      "risk_board",
      "incident_console",
      "release_status",
    ]);
  });

  it("projects live operator controls with role-safe visibility and runtime labels", () => {
    const model = buildOperatorSurfaceModel(inputFor(actor(["operator"], ["runtime"]), "live_runtime"));
    const routeIds = model.visible_routes.map((route) => route.route_id);
    const launch = model.controls.find((control) => control.control_kind === "launch_scenario");

    expect(routeIds).toContain("runtime_dashboard");
    expect(routeIds).toContain("scenario_launcher");
    expect(routeIds).toContain("safety_controls");
    expect(routeIds).not.toContain("qa_evidence");
    expect(routeIds).not.toContain("release_status");
    expect(launch?.state).toBe("enabled");
    expect(model.panels.find((panel) => panel.panel_kind === "dashboard")?.runtime_labels).toContain("runtime-visible");
    expect(model.panels.find((panel) => panel.panel_kind === "dashboard")?.qa_labels).toContain("qa-truth-excluded");
  });

  it("locks mutating live controls when state is stale or the surface is replay-only", () => {
    const staleModel = buildOperatorSurfaceModel(inputFor(actor(["operator"], ["runtime"]), "live_runtime", {
      now_ms: 30_000,
      event_stream_last_seen_ms: 1_000,
      api_last_seen_ms: 1_000,
      event_stream_gap_detected: true,
      safety_acknowledgement_required: false,
    }));
    const replayModel = buildOperatorSurfaceModel(inputFor(actor(["operator", "developer"], ["offline_replay", "runtime", "developer_observability"]), "offline_replay"));

    expect(isFrontendStateStale(staleModelInputConnection())).toBe(true);
    expect(staleModel.stale).toBe(true);
    expect(staleModel.controls.find((control) => control.control_kind === "launch_scenario")?.state).toBe("disabled_stale");
    expect(replayModel.replay_locked).toBe(true);
    expect(replayModel.controls.find((control) => control.control_kind === "pause_runtime")?.state).toBe("disabled_replay");
  });

  it("keeps QA evidence offline and release risk status role-scoped", () => {
    const qaModel = buildOperatorSurfaceModel(inputFor(actor(["qa_engineer"], ["qa"]), "qa_review"));
    const releaseModel = buildOperatorSurfaceModel(inputFor(actor(["release_owner"], ["release", "offline_replay"]), "release_review"));

    expect(qaModel.visible_routes.map((route) => route.route_id)).toContain("qa_evidence");
    expect(qaModel.panels.find((panel) => panel.panel_kind === "qa")?.boundary_label).toBe("qa_offline");
    expect(qaModel.panels.find((panel) => panel.panel_kind === "qa")?.qa_labels).toContain("runtime-cognition-excluded");
    expect(releaseModel.visible_routes.map((route) => route.route_id)).toContain("release_status");
    expect(releaseModel.panels.find((panel) => panel.panel_kind === "release")?.release_blocking_refs).toContain("risk:critical-release");
    expect(releaseModel.controls.find((control) => control.control_kind === "review_release")?.state).toBe("read_only");
  });

  it("redacts secrets, hidden-state wording, QA truth, prompt internals, and private reasoning from panels", () => {
    const redacted = sanitizeFrontendText(
      "frontend:redaction:test",
      "Use bearer abcdefghijklmnopqrstuvwxyz012345 while viewing hidden pose, object ID, QA truth, raw prompt, and private deliberation.",
    );

    expect(redacted.redacted).toBe(true);
    expect(redacted.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted.text).not.toMatch(/hidden pose|object ID|QA truth|raw prompt|private deliberation/i);
    expect(redacted.rules).toContain("secret_redaction");
    expect(redacted.rules).toContain("frontend_boundary_redaction");
  });

  it("keeps PIT-B07 contract-only frontend scope free of runtime service integration refs", () => {
    const model = buildOperatorSurfaceModel(inputFor(actor(["operator"], ["runtime"]), "live_runtime"));

    expect(model.forbidden_integration_refs).toEqual([]);
    expect(model.coverage.dashboard).toBe(true);
    expect(model.coverage.scenario_launcher).toBe(true);
    expect(model.coverage.safety).toBe(true);
  });
});

function inputFor(actorContext: ActorContext, mode: OperatorSurfaceMode, connection: FrontendConnectionState = freshConnection()): OperatorSurfaceInput {
  return {
    actor: actorContext,
    connection,
    selected_mode: mode,
    dashboard_snapshot: dashboardSnapshot(),
    replay_bundle: replayBundle(),
    telemetry_alerts: [releaseBlockingAlert()],
    scenarios: [
      {
        scenario_ref: "scenario:pick-place-red-cube",
        title: "Pick Place Red Cube",
        environment_scope: "production",
        runtime_scope: "runtime",
        policy_refs: ["policy:safety:gently-place"],
        safety_summary: "Low force placement with verification certificate requirement.",
      },
    ],
    risks: [
      {
        risk_ref: "risk:critical-release",
        severity: "critical",
        status: "blocked",
        owner_ref: "owner:safety",
        release_blocking: true,
        summary: "Release blocked until safety acknowledgement is complete.",
      },
    ],
    incidents: [
      {
        incident_ref: "incident:redaction-review",
        incident_class: "redaction",
        severity: "critical",
        status: "quarantined",
        summary: "Restricted observability event is quarantined.",
        audit_refs: ["audit:redaction-review"],
      },
    ],
    release_status: {
      release_ref: "release:candidate-1",
      gate_state: "no_go",
      release_blocker_refs: ["risk:critical-release"],
      qa_evidence_refs: ["qa:evidence:scorecard"],
      risk_gate_report_ref: "risk:gate-report:candidate-1",
      summary: "Release gate is blocked by unresolved critical risk.",
    },
    active_task_ref: "task:operator-surface",
    policy_bundle_ref: "policy_bundle:pit-b07:frontend-operator:v1",
  };
}

function actor(roles: readonly AuthRole[], runtimeScopes: readonly RuntimeScope[]): ActorContext {
  return buildActorContext({
    actor_ref: `actor:${roles.join("-")}:${runtimeScopes.join("-")}`,
    actor_type: "human",
    display_name: `${roles.join(" ")} actor`,
    role_refs: roles,
    environment_scopes: ["production", "release_candidate", "qa", "staging", "development"],
    runtime_scopes: runtimeScopes,
    session_ref: `session:${roles.join("-")}`,
    authenticated_at_ms: 7_000,
    authentication_strength: "mfa",
    mfa_verified: true,
    audit_attribute_refs: [`audit:${roles.join("-")}`],
  });
}

function freshConnection(): FrontendConnectionState {
  return {
    now_ms: 20_000,
    event_stream_last_seen_ms: 19_500,
    api_last_seen_ms: 19_400,
    event_stream_gap_detected: false,
    safety_acknowledgement_required: false,
  };
}

function staleModelInputConnection(): FrontendConnectionState {
  return {
    now_ms: 30_000,
    event_stream_last_seen_ms: 1_000,
    api_last_seen_ms: 1_000,
    event_stream_gap_detected: true,
    safety_acknowledgement_required: false,
  };
}

function dashboardSnapshot(): DashboardStateSnapshot {
  return {
    dashboard_snapshot_ref: "dashboard:snapshot:operator",
    snapshot_time_ms: 20_000,
    visibility_mode: "operator",
    task_state_summary: "task:operator-surface | state:running | Runtime evidence is current and redacted.",
    active_evidence_refs: ["evidence:runtime:camera", "evidence:runtime:safety-policy"],
    active_decision_refs: ["decision:plan-preview"],
    active_alerts: ["warning:safety:operator acknowledgement pending"],
    tts_queue_summary: "0 active playback records; queue empty.",
    redaction_manifest_ref: "redaction:dashboard:operator",
    determinism_hash: "dashhash",
  };
}

function replayBundle(): ReplayBundle {
  return {
    replay_bundle_ref: "replay:bundle:operator",
    task_ref: "task:operator-surface",
    window_start_ms: 10_000,
    window_end_ms: 20_000,
    event_refs: ["event:runtime", "event:safety"],
    evidence_refs: ["evidence:runtime:camera", "evidence:runtime:safety-policy"],
    decision_traces: [],
    redaction_manifest_ref: "redaction:replay:operator",
    completeness_score: 0.98,
    determinism_hash: "replayhash",
  };
}

function releaseBlockingAlert(): TelemetryAlertRecord {
  return {
    schema_version: "mebsuta.observability.telemetry_replay_foundation.v1",
    alert_ref: "alert:safety-ack",
    alert_kind: "safety_acknowledgement_missing",
    severity: "critical",
    source_event_ref: "event:safety",
    boundary_label: "runtime",
    summary: "Safety-critical event requires acknowledgement.",
    required_action: "Acknowledge safety event before release review.",
    release_blocking: true,
    acknowledged: false,
    audit_refs: ["audit:safety-ack"],
    determinism_hash: "alerthash",
  };
}
