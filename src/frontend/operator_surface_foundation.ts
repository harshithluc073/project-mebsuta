/**
 * PIT-B07 frontend operator surfaces foundation.
 *
 * Blueprint context:
 * - `production_readiness_docs/03_WEB_FRONTEND_ARCHITECTURE.md`
 * - `production_readiness_docs/05_API_AND_SERVICE_INTEGRATION_PLAN.md`
 * - `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * - `production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md`
 * - `production_readiness_docs/17_PRODUCTION_RISK_REGISTER.md`
 * - `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * - `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 *
 * This file defines the typed app-shell, route, panel, visibility, stale-lock,
 * replay-lock, and frontend-safe projection contracts for the operator console.
 * It deliberately avoids runtime service integration, deployment, backend risk
 * workflows, and release automation.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import type { ActorContext, AuthRole, EnvironmentScope, RuntimeScope } from "../auth/actor_context";
import { freezeAuthArray, makeAuthRef } from "../auth/actor_context";
import type { AuthPermission } from "../auth/role_permission_registry";
import { AuthorizationPolicyEngine, type AuthorizationDecisionRecord, type AuthorizationSubjectType } from "../auth/authorization_policy_engine";
import type { DashboardStateSnapshot, DashboardVisibility, ReplayBundle } from "../observability/observability_event_emitter";
import type { TelemetryAlertRecord, TelemetryBoundaryLabel, TelemetryEvidenceProjection } from "../observability/telemetry_replay_foundation";
import { redactSecrets } from "../security/secret_redaction";

export const OPERATOR_SURFACE_FOUNDATION_SCHEMA_VERSION = "mebsuta.frontend.operator_surface_foundation.v1" as const;
export const OPERATOR_SURFACE_BLUEPRINT_REF = "production_readiness_docs/03_WEB_FRONTEND_ARCHITECTURE.md" as const;

const STALE_AFTER_MS = 15_000;
const RESTRICTED_TEXT_PATTERN = /\b(?:backend|scene[_ -]?graph|hidden[_ -]?state|hidden[_ -]?pose|object[_ -]?id|ground[_ -]?truth|oracle|qa[_ -]?truth|qa[_ -]?label|raw[_ -]?prompt|system prompt|developer prompt|private deliberation|chain[_ -]?of[_ -]?thought|scratchpad)\b/gi;

export type OperatorSurfaceRouteId =
  | "runtime_dashboard"
  | "scenario_launcher"
  | "replay_review"
  | "safety_controls"
  | "qa_evidence"
  | "risk_board"
  | "incident_console"
  | "release_status";

export type OperatorSurfacePanelKind =
  | "dashboard"
  | "scenario_launcher"
  | "replay"
  | "safety"
  | "qa"
  | "risk"
  | "incident"
  | "release";

export type OperatorSurfaceMode = "live_runtime" | "offline_replay" | "qa_review" | "release_review";
export type OperatorControlKind = "launch_scenario" | "pause_runtime" | "enter_safe_hold" | "acknowledge_safety" | "annotate_event" | "review_release";
export type OperatorControlState = "enabled" | "disabled_stale" | "disabled_replay" | "disabled_unauthorized" | "disabled_boundary" | "read_only";
export type OperatorSurfaceStatus = "ready" | "degraded" | "locked" | "blocked";
export type FrontendBoundaryLabel = "runtime" | "qa_offline" | "redacted" | "restricted_quarantine";

export interface FrontendConnectionState {
  readonly now_ms: number;
  readonly event_stream_last_seen_ms: number;
  readonly api_last_seen_ms: number;
  readonly replay_cursor_ref?: Ref;
  readonly event_stream_gap_detected: boolean;
  readonly safety_acknowledgement_required: boolean;
}

export interface ScenarioLauncherContract {
  readonly scenario_ref: Ref;
  readonly title: string;
  readonly environment_scope: EnvironmentScope;
  readonly runtime_scope: RuntimeScope;
  readonly policy_refs: readonly Ref[];
  readonly safety_summary: string;
}

export interface RiskStatusContract {
  readonly risk_ref: Ref;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly status: "open" | "mitigating" | "monitored" | "blocked" | "accepted";
  readonly owner_ref: Ref;
  readonly release_blocking: boolean;
  readonly summary: string;
}

export interface IncidentStatusContract {
  readonly incident_ref: Ref;
  readonly incident_class: "safety" | "security" | "redaction" | "qa_boundary" | "event_stream" | "release";
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly status: "triage" | "safe_hold" | "human_review" | "quarantined" | "closed";
  readonly summary: string;
  readonly audit_refs: readonly Ref[];
}

export interface ReleaseStatusContract {
  readonly release_ref: Ref;
  readonly gate_state: "go" | "conditional_go" | "no_go" | "not_evaluated";
  readonly release_blocker_refs: readonly Ref[];
  readonly qa_evidence_refs: readonly Ref[];
  readonly risk_gate_report_ref?: Ref;
  readonly summary: string;
}

export interface OperatorSurfaceInput {
  readonly actor: ActorContext;
  readonly connection: FrontendConnectionState;
  readonly selected_mode: OperatorSurfaceMode;
  readonly dashboard_snapshot?: DashboardStateSnapshot;
  readonly replay_bundle?: ReplayBundle;
  readonly telemetry_projection?: TelemetryEvidenceProjection;
  readonly telemetry_alerts?: readonly TelemetryAlertRecord[];
  readonly scenarios?: readonly ScenarioLauncherContract[];
  readonly risks?: readonly RiskStatusContract[];
  readonly incidents?: readonly IncidentStatusContract[];
  readonly release_status?: ReleaseStatusContract;
  readonly active_task_ref?: Ref;
  readonly policy_bundle_ref: Ref;
}

export interface OperatorRouteContract {
  readonly route_id: OperatorSurfaceRouteId;
  readonly panel_kind: OperatorSurfacePanelKind;
  readonly title: string;
  readonly required_permissions: readonly AuthPermission[];
  readonly allowed_roles: readonly AuthRole[];
  readonly mode: OperatorSurfaceMode;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly lock_reason?: string;
  readonly boundary_label: FrontendBoundaryLabel;
  readonly determinism_hash: string;
}

export interface OperatorControlContract {
  readonly control_ref: Ref;
  readonly control_kind: OperatorControlKind;
  readonly label: string;
  readonly route_id: OperatorSurfaceRouteId;
  readonly required_permission: AuthPermission;
  readonly state: OperatorControlState;
  readonly reason: string;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface FrontendSafePanelProjection {
  readonly panel_ref: Ref;
  readonly route_id: OperatorSurfaceRouteId;
  readonly panel_kind: OperatorSurfacePanelKind;
  readonly status: OperatorSurfaceStatus;
  readonly boundary_label: FrontendBoundaryLabel;
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly alert_refs: readonly Ref[];
  readonly release_blocking_refs: readonly Ref[];
  readonly runtime_labels: readonly string[];
  readonly qa_labels: readonly string[];
  readonly redaction_manifest_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface OperatorSurfaceModel {
  readonly schema_version: typeof OPERATOR_SURFACE_FOUNDATION_SCHEMA_VERSION;
  readonly app_shell_ref: Ref;
  readonly actor_ref: Ref;
  readonly selected_mode: OperatorSurfaceMode;
  readonly stale: boolean;
  readonly replay_locked: boolean;
  readonly event_stream_gap_detected: boolean;
  readonly visible_routes: readonly OperatorRouteContract[];
  readonly panels: readonly FrontendSafePanelProjection[];
  readonly controls: readonly OperatorControlContract[];
  readonly coverage: Readonly<Record<OperatorSurfacePanelKind, boolean>>;
  readonly forbidden_integration_refs: readonly string[];
  readonly determinism_hash: string;
}

interface RouteDefinition {
  readonly route_id: OperatorSurfaceRouteId;
  readonly panel_kind: OperatorSurfacePanelKind;
  readonly title: string;
  readonly required_permissions: readonly AuthPermission[];
  readonly allowed_roles: readonly AuthRole[];
  readonly mode: OperatorSurfaceMode;
  readonly authorization_subject_type: AuthorizationSubjectType;
  readonly boundary_label: FrontendBoundaryLabel;
}

interface ControlDefinition {
  readonly control_kind: OperatorControlKind;
  readonly label: string;
  readonly route_id: OperatorSurfaceRouteId;
  readonly required_permission: AuthPermission;
  readonly authorization_subject_type: AuthorizationSubjectType;
  readonly mutates_runtime: boolean;
  readonly requires_fresh_stream: boolean;
}

const ROUTE_DEFINITIONS: readonly RouteDefinition[] = freezeAuthArray([
  route("runtime_dashboard", "dashboard", "Runtime dashboard", ["route:read_runtime"], ["operator", "safety_operator", "developer", "release_owner", "auditor", "demo_viewer"], "live_runtime", "route", "runtime"),
  route("scenario_launcher", "scenario_launcher", "Scenario launcher", ["command:launch_scenario"], ["operator", "safety_operator"], "live_runtime", "command", "runtime"),
  route("replay_review", "replay", "Replay review", ["export:runtime_replay", "audit:read"], ["developer", "auditor", "release_owner", "safety_operator"], "offline_replay", "export", "redacted"),
  route("safety_controls", "safety", "Safety controls", ["command:pause_stop", "command:enter_safe_hold"], ["operator", "safety_operator", "security_admin"], "live_runtime", "safe_hold", "runtime"),
  route("qa_evidence", "qa", "QA evidence", ["qa_truth:read_offline", "export:qa_report"], ["qa_engineer", "release_owner", "auditor"], "qa_review", "qa_truth", "qa_offline"),
  route("risk_board", "risk", "Risk board", ["release:evaluate_gate", "audit:read"], ["release_owner", "auditor", "security_admin"], "release_review", "release", "redacted"),
  route("incident_console", "incident", "Incident console", ["audit:read", "artifact:review_quarantine"], ["safety_operator", "security_admin", "auditor", "release_owner"], "release_review", "audit", "restricted_quarantine"),
  route("release_status", "release", "Release status", ["release:evaluate_gate"], ["release_owner", "security_admin", "auditor"], "release_review", "release", "redacted"),
]);

const CONTROL_DEFINITIONS: readonly ControlDefinition[] = freezeAuthArray([
  control("launch_scenario", "Launch scenario", "scenario_launcher", "command:launch_scenario", "command", true, true),
  control("pause_runtime", "Pause runtime", "safety_controls", "command:pause_stop", "command", true, false),
  control("enter_safe_hold", "Enter SafeHold", "safety_controls", "command:enter_safe_hold", "safe_hold", true, false),
  control("acknowledge_safety", "Acknowledge safety event", "safety_controls", "command:enter_safe_hold", "safe_hold", true, false),
  control("annotate_event", "Annotate event", "runtime_dashboard", "route:read_runtime", "audit", false, true),
  control("review_release", "Review release gate", "release_status", "release:evaluate_gate", "release", false, false),
]);

export function buildOperatorSurfaceModel(input: OperatorSurfaceInput): OperatorSurfaceModel {
  const authEngine = new AuthorizationPolicyEngine();
  const stale = isFrontendStateStale(input.connection);
  const replayLocked = input.selected_mode === "offline_replay";
  const decisions = new Map<string, AuthorizationDecisionRecord>();
  const routes = ROUTE_DEFINITIONS.map((definition) => buildRouteContract(definition, input, authEngine, decisions, stale));
  const controls = CONTROL_DEFINITIONS.map((definition) => buildControlContract(definition, input, authEngine, decisions, stale, replayLocked));
  const visibleRoutes = routes.filter((candidate) => candidate.visible);
  const panels = visibleRoutes.map((routeContract) => buildPanelProjection(routeContract, input, stale));
  const base = {
    schema_version: OPERATOR_SURFACE_FOUNDATION_SCHEMA_VERSION,
    app_shell_ref: makeAuthRef("frontend", "operator_shell", input.actor.actor_ref, input.selected_mode),
    actor_ref: input.actor.actor_ref,
    selected_mode: input.selected_mode,
    stale,
    replay_locked: replayLocked,
    event_stream_gap_detected: input.connection.event_stream_gap_detected,
    visible_routes: freezeAuthArray(visibleRoutes),
    panels: freezeAuthArray(panels),
    controls: freezeAuthArray(controls.filter((candidate) => visibleRoutes.some((routeContract) => routeContract.route_id === candidate.route_id))),
    coverage: buildCoverage(panels),
    forbidden_integration_refs: freezeAuthArray([]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function isFrontendStateStale(connection: FrontendConnectionState): boolean {
  const streamAge = connection.now_ms - connection.event_stream_last_seen_ms;
  const apiAge = connection.now_ms - connection.api_last_seen_ms;
  return connection.event_stream_gap_detected || streamAge > STALE_AFTER_MS || apiAge > STALE_AFTER_MS;
}

export function sanitizeFrontendText(inputRef: Ref, value: string): { readonly text: string; readonly redacted: boolean; readonly rules: readonly string[] } {
  const secretRedaction = redactSecrets({ input_ref: inputRef, text: value });
  const rules: string[] = secretRedaction.redacted ? ["secret_redaction"] : [];
  const restrictedCleaned = secretRedaction.redacted_text.replace(RESTRICTED_TEXT_PATTERN, () => {
    rules.push("frontend_boundary_redaction");
    return "[redacted_boundary]";
  });
  return Object.freeze({
    text: compactFrontendText(restrictedCleaned),
    redacted: secretRedaction.redacted || restrictedCleaned !== secretRedaction.redacted_text,
    rules: freezeAuthArray([...new Set(rules)]),
  });
}

export function listOperatorSurfaceDefinitions(): readonly RouteDefinition[] {
  return ROUTE_DEFINITIONS;
}

function buildRouteContract(
  definition: RouteDefinition,
  input: OperatorSurfaceInput,
  authEngine: AuthorizationPolicyEngine,
  decisions: Map<string, AuthorizationDecisionRecord>,
  stale: boolean,
): OperatorRouteContract {
  const roleVisible = definition.allowed_roles.some((role) => input.actor.role_refs.includes(role));
  const decision = evaluateAnyPermission(definition.required_permissions, definition.authorization_subject_type, definition.route_id, input, authEngine, decisions);
  const boundaryAllowed = definition.boundary_label !== "qa_offline" || input.actor.runtime_scopes.includes("qa") || input.actor.runtime_scopes.includes("release");
  const visible = roleVisible && decision.decision === "allowed" && boundaryAllowed;
  const locked = stale && definition.mode === "live_runtime";
  const base = {
    route_id: definition.route_id,
    panel_kind: definition.panel_kind,
    title: definition.title,
    required_permissions: definition.required_permissions,
    allowed_roles: definition.allowed_roles,
    mode: definition.mode,
    visible,
    locked,
    lock_reason: locked ? "Frontend state is stale or event stream gap was detected." : undefined,
    boundary_label: definition.boundary_label,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildControlContract(
  definition: ControlDefinition,
  input: OperatorSurfaceInput,
  authEngine: AuthorizationPolicyEngine,
  decisions: Map<string, AuthorizationDecisionRecord>,
  stale: boolean,
  replayLocked: boolean,
): OperatorControlContract {
  const decision = evaluatePermission(definition.required_permission, definition.authorization_subject_type, definition.route_id, input, authEngine, decisions);
  const state = controlState(definition, decision, input, stale, replayLocked);
  const base = {
    control_ref: makeAuthRef("frontend_control", definition.route_id, definition.control_kind),
    control_kind: definition.control_kind,
    label: definition.label,
    route_id: definition.route_id,
    required_permission: definition.required_permission,
    state,
    reason: controlReason(state, decision),
    audit_refs: freezeAuthArray([decision.decision_ref, input.policy_bundle_ref]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildPanelProjection(routeContract: OperatorRouteContract, input: OperatorSurfaceInput, stale: boolean): FrontendSafePanelProjection {
  const summaryInput = panelSummary(routeContract, input);
  const sanitized = sanitizeFrontendText(makeAuthRef("frontend_panel", routeContract.route_id), summaryInput.summary);
  const alerts = input.telemetry_alerts ?? [];
  const releaseBlockingRefs = routeContract.panel_kind === "release" || routeContract.panel_kind === "risk" || routeContract.panel_kind === "incident"
    ? uniqueRefs([
      ...(input.release_status?.release_blocker_refs ?? []),
      ...(input.risks ?? []).filter((risk) => risk.release_blocking).map((risk) => risk.risk_ref),
      ...alerts.filter((alert) => alert.release_blocking).map((alert) => alert.alert_ref),
    ])
    : freezeAuthArray([]);
  const boundary = sanitized.redacted && routeContract.boundary_label === "runtime" ? "redacted" : routeContract.boundary_label;
  const base = {
    panel_ref: makeAuthRef("frontend_panel", routeContract.route_id, boundary),
    route_id: routeContract.route_id,
    panel_kind: routeContract.panel_kind,
    status: panelStatus(routeContract, input, stale, releaseBlockingRefs),
    boundary_label: boundary,
    summary: sanitized.text,
    evidence_refs: summaryInput.evidence_refs,
    alert_refs: uniqueRefs(alerts.map((alert) => alert.alert_ref)),
    release_blocking_refs: releaseBlockingRefs,
    runtime_labels: runtimeLabels(routeContract, input, stale),
    qa_labels: qaLabels(routeContract, input),
    redaction_manifest_refs: uniqueRefs([
      input.dashboard_snapshot?.redaction_manifest_ref,
      input.replay_bundle?.redaction_manifest_ref,
      ...(input.telemetry_projection?.redaction_manifest_refs ?? []),
    ]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function panelSummary(routeContract: OperatorRouteContract, input: OperatorSurfaceInput): { readonly summary: string; readonly evidence_refs: readonly Ref[] } {
  switch (routeContract.panel_kind) {
    case "dashboard":
      return {
        summary: input.dashboard_snapshot?.task_state_summary ?? "Runtime dashboard awaiting a redacted dashboard snapshot.",
        evidence_refs: uniqueRefs(input.dashboard_snapshot?.active_evidence_refs ?? []),
      };
    case "scenario_launcher":
      return {
        summary: `${input.scenarios?.length ?? 0} scenario contracts available for actor-scoped launch.`,
        evidence_refs: uniqueRefs(input.scenarios?.flatMap((scenario) => [scenario.scenario_ref, ...scenario.policy_refs]) ?? []),
      };
    case "replay":
      return {
        summary: input.replay_bundle === undefined ? "Replay review requires an evidence-linked replay bundle." : `Replay bundle ${input.replay_bundle.replay_bundle_ref} has completeness ${input.replay_bundle.completeness_score}.`,
        evidence_refs: uniqueRefs(input.replay_bundle?.evidence_refs ?? []),
      };
    case "safety":
      return {
        summary: input.connection.safety_acknowledgement_required ? "Safety acknowledgement is required before routine controls continue." : "Safety controls are visible with SafeHold and pause actions role-gated.",
        evidence_refs: uniqueRefs(input.telemetry_alerts?.filter((alert) => alert.alert_kind.includes("safety")).map((alert) => alert.source_event_ref) ?? []),
      };
    case "qa":
      return {
        summary: "QA evidence is offline-only and excludes runtime cognition paths.",
        evidence_refs: uniqueRefs(input.release_status?.qa_evidence_refs ?? []),
      };
    case "risk":
      return {
        summary: `${input.risks?.length ?? 0} risk records projected with release blockers redacted by role.`,
        evidence_refs: uniqueRefs(input.risks?.map((risk) => risk.risk_ref) ?? []),
      };
    case "incident":
      return {
        summary: `${input.incidents?.length ?? 0} incident records require audit-preserving review.`,
        evidence_refs: uniqueRefs(input.incidents?.flatMap((incident) => [incident.incident_ref, ...incident.audit_refs]) ?? []),
      };
    case "release":
      return {
        summary: input.release_status?.summary ?? "Release status has not been evaluated for this actor scope.",
        evidence_refs: uniqueRefs([input.release_status?.release_ref, input.release_status?.risk_gate_report_ref, ...(input.release_status?.qa_evidence_refs ?? [])]),
      };
  }
}

function panelStatus(routeContract: OperatorRouteContract, input: OperatorSurfaceInput, stale: boolean, releaseBlockingRefs: readonly Ref[]): OperatorSurfaceStatus {
  if (routeContract.boundary_label === "restricted_quarantine") {
    return "blocked";
  }
  if (routeContract.locked || (stale && routeContract.mode === "live_runtime")) {
    return "locked";
  }
  if (input.connection.event_stream_gap_detected || releaseBlockingRefs.length > 0) {
    return "degraded";
  }
  return "ready";
}

function runtimeLabels(routeContract: OperatorRouteContract, input: OperatorSurfaceInput, stale: boolean): readonly string[] {
  const labels = ["runtime-visible", routeContract.mode, input.connection.event_stream_gap_detected ? "event-stream-gap" : "event-stream-current"];
  if (stale) {
    labels.push("stale-state-lockout");
  }
  if (routeContract.mode === "offline_replay") {
    labels.push("replay-read-only");
  }
  return freezeAuthArray(labels);
}

function qaLabels(routeContract: OperatorRouteContract, input: OperatorSurfaceInput): readonly string[] {
  if (routeContract.boundary_label !== "qa_offline" && input.telemetry_projection?.boundary_label !== "qa") {
    return freezeAuthArray(["qa-truth-excluded"]);
  }
  return freezeAuthArray(["qa-offline-only", "runtime-cognition-excluded"]);
}

function controlState(
  definition: ControlDefinition,
  decision: AuthorizationDecisionRecord,
  input: OperatorSurfaceInput,
  stale: boolean,
  replayLocked: boolean,
): OperatorControlState {
  if (decision.decision !== "allowed") {
    return "disabled_unauthorized";
  }
  if (input.selected_mode === "qa_review" && definition.mutates_runtime) {
    return "disabled_boundary";
  }
  if (replayLocked && definition.mutates_runtime) {
    return "disabled_replay";
  }
  if (definition.requires_fresh_stream && stale) {
    return "disabled_stale";
  }
  if (!definition.mutates_runtime) {
    return "read_only";
  }
  return "enabled";
}

function controlReason(state: OperatorControlState, decision: AuthorizationDecisionRecord): string {
  switch (state) {
    case "enabled":
      return "Control is authorized for the current actor and fresh runtime state.";
    case "disabled_stale":
      return "Control is locked until event stream and API state are fresh.";
    case "disabled_replay":
      return "Replay surfaces cannot issue live runtime commands.";
    case "disabled_unauthorized":
      return decision.reason;
    case "disabled_boundary":
      return "Runtime mutation is blocked from QA or offline boundary scope.";
    case "read_only":
      return "Control is an inspection action and does not mutate runtime state.";
  }
}

function evaluateAnyPermission(
  permissions: readonly AuthPermission[],
  subjectType: AuthorizationSubjectType,
  subjectRef: Ref,
  input: OperatorSurfaceInput,
  authEngine: AuthorizationPolicyEngine,
  decisions: Map<string, AuthorizationDecisionRecord>,
): AuthorizationDecisionRecord {
  const records = permissions.map((permission) => evaluatePermission(permission, subjectType, subjectRef, input, authEngine, decisions));
  return records.find((record) => record.decision === "allowed") ?? records[0];
}

function evaluatePermission(
  permission: AuthPermission,
  subjectType: AuthorizationSubjectType,
  subjectRef: Ref,
  input: OperatorSurfaceInput,
  authEngine: AuthorizationPolicyEngine,
  decisions: Map<string, AuthorizationDecisionRecord>,
): AuthorizationDecisionRecord {
  const key = `${permission}:${subjectType}:${subjectRef}`;
  const existing = decisions.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const boundaryLabel = authorizationBoundaryLabel(input);
  const decision = authEngine.evaluateAuthorization({
    request_ref: makeAuthRef("frontend_auth", input.actor.actor_ref, permission, subjectRef),
    actor: input.actor,
    permission,
    subject_type: subjectType,
    subject_ref: makeAuthRef("frontend_subject", subjectRef),
    environment_scope: selectEnvironmentScope(input.actor.environment_scopes, permission),
    runtime_scope: selectRuntimeScope(input.actor.runtime_scopes, permission),
    policy_bundle_ref: input.policy_bundle_ref,
    safety_state: input.connection.safety_acknowledgement_required ? "safe_hold" : "normal",
    runtime_qa_boundary_label: boundaryLabel,
    correlation_ref: makeAuthRef("frontend_correlation", input.actor.actor_ref, input.active_task_ref, subjectRef),
  });
  decisions.set(key, decision);
  return decision;
}

function authorizationBoundaryLabel(input: OperatorSurfaceInput): "runtime" | "qa" | "offline_replay" | "restricted_quarantine" | "redacted" {
  if (input.selected_mode === "qa_review" || input.telemetry_projection?.boundary_label === "qa") {
    return "qa";
  }
  if (input.selected_mode === "offline_replay") {
    return "offline_replay";
  }
  if (input.telemetry_projection?.boundary_label === "restricted_quarantine") {
    return "restricted_quarantine";
  }
  if (input.telemetry_projection?.boundary_label === "redacted") {
    return "redacted";
  }
  return "runtime";
}

function route(
  routeId: OperatorSurfaceRouteId,
  panelKind: OperatorSurfacePanelKind,
  title: string,
  requiredPermissions: readonly AuthPermission[],
  allowedRoles: readonly AuthRole[],
  mode: OperatorSurfaceMode,
  subjectType: AuthorizationSubjectType,
  boundaryLabel: FrontendBoundaryLabel,
): RouteDefinition {
  return Object.freeze({
    route_id: routeId,
    panel_kind: panelKind,
    title,
    required_permissions: freezeAuthArray(requiredPermissions),
    allowed_roles: freezeAuthArray(allowedRoles),
    mode,
    authorization_subject_type: subjectType,
    boundary_label: boundaryLabel,
  });
}

function control(
  controlKind: OperatorControlKind,
  label: string,
  routeId: OperatorSurfaceRouteId,
  requiredPermission: AuthPermission,
  subjectType: AuthorizationSubjectType,
  mutatesRuntime: boolean,
  requiresFreshStream: boolean,
): ControlDefinition {
  return Object.freeze({
    control_kind: controlKind,
    label,
    route_id: routeId,
    required_permission: requiredPermission,
    authorization_subject_type: subjectType,
    mutates_runtime: mutatesRuntime,
    requires_fresh_stream: requiresFreshStream,
  });
}

function buildCoverage(panels: readonly FrontendSafePanelProjection[]): Readonly<Record<OperatorSurfacePanelKind, boolean>> {
  return Object.freeze({
    dashboard: hasPanel(panels, "dashboard"),
    scenario_launcher: hasPanel(panels, "scenario_launcher"),
    replay: hasPanel(panels, "replay"),
    safety: hasPanel(panels, "safety"),
    qa: hasPanel(panels, "qa"),
    risk: hasPanel(panels, "risk"),
    incident: hasPanel(panels, "incident"),
    release: hasPanel(panels, "release"),
  });
}

function hasPanel(panels: readonly FrontendSafePanelProjection[], panelKind: OperatorSurfacePanelKind): boolean {
  return panels.some((panel) => panel.panel_kind === panelKind);
}

function firstScope<T extends string>(scopes: readonly T[], fallback: T): T {
  return scopes[0] ?? fallback;
}

function selectEnvironmentScope(scopes: readonly EnvironmentScope[], permission: AuthPermission): EnvironmentScope {
  if ((permission === "qa_truth:read_offline" || permission === "export:qa_report") && scopes.includes("qa")) {
    return "qa";
  }
  if ((permission === "release:evaluate_gate" || permission === "audit:read") && scopes.includes("release_candidate")) {
    return "release_candidate";
  }
  if (permission === "export:runtime_replay" && scopes.includes("staging")) {
    return "staging";
  }
  return firstScope(scopes, "development");
}

function selectRuntimeScope(scopes: readonly RuntimeScope[], permission: AuthPermission): RuntimeScope {
  if ((permission === "qa_truth:read_offline" || permission === "export:qa_report") && scopes.includes("qa")) {
    return "qa";
  }
  if (permission === "release:evaluate_gate" && scopes.includes("release")) {
    return "release";
  }
  if (permission === "export:runtime_replay" && scopes.includes("offline_replay")) {
    return "offline_replay";
  }
  if (permission === "route:developer_observability" && scopes.includes("developer_observability")) {
    return "developer_observability";
  }
  if (scopes.includes("runtime")) {
    return "runtime";
  }
  return firstScope(scopes, "runtime");
}

function compactFrontendText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 700);
}

function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeAuthArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function mapTelemetryBoundaryToFrontend(label: TelemetryBoundaryLabel): FrontendBoundaryLabel {
  if (label === "qa") {
    return "qa_offline";
  }
  if (label === "restricted_quarantine") {
    return "restricted_quarantine";
  }
  if (label === "redacted") {
    return "redacted";
  }
  return "runtime";
}

export const OPERATOR_SURFACE_FOUNDATION_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OPERATOR_SURFACE_FOUNDATION_SCHEMA_VERSION,
  blueprint: OPERATOR_SURFACE_BLUEPRINT_REF,
  sections: freezeAuthArray(["03", "05", "07", "12", "17", "architecture-17", "architecture-18"]),
  component: "OperatorSurfaceFoundation",
});
