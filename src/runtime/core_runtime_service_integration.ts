/**
 * PIT-B08 core runtime service integration.
 *
 * This composition layer binds the already-implemented runtime contracts for
 * prompt firewall validation, no-RL compliance, execution gating, provenance,
 * artifact envelopes, and service-event evidence. It does not dispatch control,
 * read QA-only surfaces, or start verification, memory, audio, Oops, scenario
 * harness, deployment, operations, performance, or release-packet work.
 */

import { buildArtifactEnvelope, type ArtifactEnvelope, type ArtifactType, type ApiServiceRef } from "../api/artifact_envelope";
import { buildProvenanceManifest, provenanceAllowsCognition, type ProvenanceManifest, type ProvenanceSourceClass } from "../api/provenance_manifest_contract";
import {
  buildServiceEventEnvelope,
  deliveryForEventClass,
  eventClassForArtifact,
  validateServiceEventEnvelope,
  type ServiceEventClass,
  type ServiceEventEnvelope,
  type ServiceEventPriority,
} from "../api/service_event_bus_contract";
import { ExecutionGatekeeper, type ExecuteStateEntryRequest, type ExecutionGatekeeperReport } from "../orchestration/execution_gatekeeper";
import type { RuntimeStateSnapshot } from "../orchestration/orchestration_state_machine";
import { NoRLPromptComplianceContract, type NoRLComplianceReport, type NoRLViolationCategory } from "../prompt_contracts/no_rl_prompt_compliance_contract";
import {
  PromptFirewallValidationContract,
  type FirewallLeakCategory,
  type PromptFirewallValidationReport,
} from "../prompt_contracts/prompt_firewall_validation_contract";
import { computeDeterminismHash, type Ref, type ValidationIssue } from "../simulation/world_manifest";

export const CORE_RUNTIME_SERVICE_INTEGRATION_SCHEMA_VERSION = "mebsuta.runtime.core_service_integration.v1" as const;
export const CORE_RUNTIME_SERVICE_INTEGRATION_STEP_REF = "PIT-B08" as const;

export type CoreRuntimeServiceIntegrationDecision =
  | "ready_for_runtime_service_composition"
  | "blocked_by_prompt_firewall"
  | "blocked_by_no_rl_boundary"
  | "blocked_by_safety_gate"
  | "blocked_by_event_evidence"
  | "blocked_by_provenance_boundary";

export interface CoreRuntimeServiceIntegrationInput {
  readonly integration_ref: Ref;
  readonly runtime_ref: Ref;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly actor_ref: Ref;
  readonly model_profile_ref: Ref;
  readonly prompt_candidate_text: string;
  readonly model_response_payload: unknown;
  readonly orchestration_snapshot: RuntimeStateSnapshot;
  readonly execute_request: ExecuteStateEntryRequest;
  readonly occurred_at_ms: number;
  readonly service_refs?: Partial<CoreRuntimeServiceRefs>;
  readonly policy_refs?: readonly Ref[];
  readonly source_artifact_refs?: readonly Ref[];
}

export interface CoreRuntimeServiceRefs {
  readonly prompt_contract: ApiServiceRef;
  readonly gemini_adapter: ApiServiceRef;
  readonly orchestration: ApiServiceRef;
  readonly safety: ApiServiceRef;
  readonly control_execution: ApiServiceRef;
}

export interface BoundaryContractSummary<TCategory extends string> {
  readonly decision: string;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly critical_count: number;
  readonly high_count: number;
  readonly quarantined: boolean;
  readonly categories: readonly TCategory[];
  readonly scan_ref: Ref;
  readonly determinism_hash: string;
}

export interface CoreRuntimeEventEvidenceReport {
  readonly artifact_count: number;
  readonly event_count: number;
  readonly producer_owner_match: boolean;
  readonly strict_safety_ack_count: number;
  readonly contains_prompt_event: boolean;
  readonly contains_response_event: boolean;
  readonly contains_safety_event: boolean;
  readonly contains_execution_event: boolean;
  readonly contains_orchestration_event: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CoreRuntimeIntegrationInvariants {
  readonly authorized_step_ref: typeof CORE_RUNTIME_SERVICE_INTEGRATION_STEP_REF;
  readonly prompt_firewall_preserved: boolean;
  readonly no_rl_boundary_preserved: boolean;
  readonly safety_authority_preserved: boolean;
  readonly api_event_evidence_preserved: boolean;
  readonly runtime_truth_boundary: "runtime_embodied_only";
  readonly raw_prompt_exposed: false;
  readonly private_reasoning_exposed: false;
  readonly qa_runtime_truth_exposed: false;
  readonly hidden_simulator_truth_exposed: false;
  readonly forbidden_later_step_refs: readonly never[];
}

export interface CoreRuntimeServiceIntegrationReport {
  readonly schema_version: typeof CORE_RUNTIME_SERVICE_INTEGRATION_SCHEMA_VERSION;
  readonly integration_ref: Ref;
  readonly runtime_ref: Ref;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly actor_ref: Ref;
  readonly model_profile_ref: Ref;
  readonly decision: CoreRuntimeServiceIntegrationDecision;
  readonly prompt_firewall: BoundaryContractSummary<FirewallLeakCategory>;
  readonly response_firewall: BoundaryContractSummary<FirewallLeakCategory>;
  readonly prompt_no_rl: BoundaryContractSummary<NoRLViolationCategory>;
  readonly response_no_rl: BoundaryContractSummary<NoRLViolationCategory>;
  readonly execution_gatekeeper: ExecutionGatekeeperReport;
  readonly provenance_manifests: readonly ProvenanceManifest[];
  readonly artifact_envelopes: readonly ArtifactEnvelope[];
  readonly service_events: readonly ServiceEventEnvelope[];
  readonly event_evidence: CoreRuntimeEventEvidenceReport;
  readonly invariants: CoreRuntimeIntegrationInvariants;
  readonly blocked_reason_codes: readonly string[];
  readonly occurred_at_ms: number;
  readonly determinism_hash: string;
}

const DEFAULT_SERVICE_REFS: CoreRuntimeServiceRefs = Object.freeze({
  prompt_contract: "prompt_contract",
  gemini_adapter: "gemini_adapter",
  orchestration: "agent_orchestration",
  safety: "safety_guardrail",
  control_execution: "control_execution",
});

const DEFAULT_POLICY_REFS: readonly Ref[] = Object.freeze([
  "policy:pit-b08-runtime-integration",
  "policy:prompt-firewall-preserved",
  "policy:no-rl-symbolic-only",
  "policy:safety-authority-required",
]);

/**
 * Wires core runtime contracts and emits API service evidence only after all
 * boundary, safety, provenance, and event-owner checks have passed.
 */
export class CoreRuntimeServiceIntegration {
  private readonly promptFirewall: PromptFirewallValidationContract;
  private readonly noRl: NoRLPromptComplianceContract;
  private readonly executionGatekeeper: ExecutionGatekeeper;

  public constructor(dependencies: {
    readonly prompt_firewall?: PromptFirewallValidationContract;
    readonly no_rl?: NoRLPromptComplianceContract;
    readonly execution_gatekeeper?: ExecutionGatekeeper;
  } = {}) {
    this.promptFirewall = dependencies.prompt_firewall ?? new PromptFirewallValidationContract();
    this.noRl = dependencies.no_rl ?? new NoRLPromptComplianceContract();
    this.executionGatekeeper = dependencies.execution_gatekeeper ?? new ExecutionGatekeeper();
  }

  public compose(input: CoreRuntimeServiceIntegrationInput): CoreRuntimeServiceIntegrationReport {
    const serviceRefs = Object.freeze({ ...DEFAULT_SERVICE_REFS, ...(input.service_refs ?? {}) });
    const policyRefs = freezeArray([...(input.policy_refs ?? DEFAULT_POLICY_REFS)]);
    const promptFirewall = this.promptFirewall.scanTextBoundary({
      scan_ref: `${input.integration_ref}:prompt-firewall`,
      surface: "raw_text",
      text: input.prompt_candidate_text,
      path: "$.prompt_candidate_text",
    });
    const responseFirewall = this.promptFirewall.validateStructuredResponse(`${input.integration_ref}:response-firewall`, input.model_response_payload);
    const promptNoRl = this.noRl.scanTextBoundary({
      scan_ref: `${input.integration_ref}:prompt-no-rl`,
      surface: "raw_text",
      text: input.prompt_candidate_text,
      path: "$.prompt_candidate_text",
      invocation_class: "TaskPlanningReasoning",
    });
    const responseNoRl = this.noRl.validateStructuredResponse(`${input.integration_ref}:response-no-rl`, input.model_response_payload, "TaskPlanningReasoning");
    const executionGatekeeper = this.executionGatekeeper.evaluateExecuteState(input.execute_request);

    const boundaryDecision = decideBoundary(promptFirewall, responseFirewall, promptNoRl, responseNoRl, executionGatekeeper);
    const provenance = boundaryDecision === "ready_for_runtime_service_composition"
      ? buildRuntimeProvenance(input, policyRefs)
      : [];
    const provenanceBlocked = provenance.some((manifest) => provenanceAllowsCognition(manifest) === false);
    const artifactEnvelopes = boundaryDecision === "ready_for_runtime_service_composition" && !provenanceBlocked
      ? buildArtifacts(input, serviceRefs, policyRefs, provenance)
      : [];
    const serviceEvents = artifactEnvelopes.length > 0
      ? buildEvents(input, serviceRefs, artifactEnvelopes)
      : [];
    const eventEvidence = summarizeEventEvidence(artifactEnvelopes, serviceEvents);
    const eventBlocked = artifactEnvelopes.length > 0 && !eventEvidenceReady(eventEvidence);
    const decision = provenanceBlocked
      ? "blocked_by_provenance_boundary"
      : eventBlocked
        ? "blocked_by_event_evidence"
        : boundaryDecision;
    const invariants = buildInvariants(decision, eventEvidence);
    const base = {
      schema_version: CORE_RUNTIME_SERVICE_INTEGRATION_SCHEMA_VERSION,
      integration_ref: input.integration_ref,
      runtime_ref: input.runtime_ref,
      session_ref: input.session_ref,
      task_ref: input.task_ref,
      actor_ref: input.actor_ref,
      model_profile_ref: input.model_profile_ref,
      decision,
      prompt_firewall: summarizeFirewall(promptFirewall),
      response_firewall: summarizeFirewall(responseFirewall),
      prompt_no_rl: summarizeNoRl(promptNoRl),
      response_no_rl: summarizeNoRl(responseNoRl),
      execution_gatekeeper: executionGatekeeper,
      provenance_manifests: freezeArray(provenance),
      artifact_envelopes: freezeArray(artifactEnvelopes),
      service_events: freezeArray(serviceEvents),
      event_evidence: eventEvidence,
      invariants,
      blocked_reason_codes: buildBlockedReasonCodes(promptFirewall, responseFirewall, promptNoRl, responseNoRl, executionGatekeeper, eventEvidence, provenanceBlocked),
      occurred_at_ms: input.occurred_at_ms,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function decideBoundary(
  promptFirewall: PromptFirewallValidationReport,
  responseFirewall: PromptFirewallValidationReport,
  promptNoRl: NoRLComplianceReport,
  responseNoRl: NoRLComplianceReport,
  executionGatekeeper: ExecutionGatekeeperReport,
): CoreRuntimeServiceIntegrationDecision {
  if (promptFirewall.decision === "reject" || promptFirewall.decision === "quarantine" || responseFirewall.decision === "reject" || responseFirewall.decision === "quarantine") {
    return "blocked_by_prompt_firewall";
  }
  if (promptNoRl.decision === "non_compliant" || promptNoRl.decision === "quarantine_required" || responseNoRl.decision === "non_compliant" || responseNoRl.decision === "quarantine_required") {
    return "blocked_by_no_rl_boundary";
  }
  if (executionGatekeeper.decision !== "work_order_ready" || executionGatekeeper.work_order === undefined) {
    return "blocked_by_safety_gate";
  }
  return "ready_for_runtime_service_composition";
}

function buildRuntimeProvenance(
  input: CoreRuntimeServiceIntegrationInput,
  policyRefs: readonly Ref[],
): readonly ProvenanceManifest[] {
  const sourceRefs = freezeArray([
    input.orchestration_snapshot.current_context_ref,
    input.execute_request.approved_plan.approved_plan_ref,
    input.execute_request.safety_envelope.safety_envelope_ref,
    input.execute_request.controller_readiness.readiness_ref,
    ...(input.source_artifact_refs ?? []),
  ]);
  const common = {
    cognitive_visibility: "allowed" as const,
    memory_visibility: "forbidden" as const,
    qa_visibility: "not_allowed" as const,
    truth_boundary_status: "runtime_embodied_only" as const,
    source_artifact_refs: sourceRefs,
    policy_refs: policyRefs,
  };
  return freezeArray([
    buildProvenanceManifest({
      ...common,
      provenance_manifest_ref: `${input.integration_ref}:provenance:prompt`,
      source_classes: ["policy_config", "validator_output"],
      audit_notes: ["Runtime prompt contract source uses policy and validator evidence only."],
    }),
    buildProvenanceManifest({
      ...common,
      provenance_manifest_ref: `${input.integration_ref}:provenance:response`,
      source_classes: ["validator_output"],
      audit_notes: ["Runtime response contract source uses validated cognitive output only."],
    }),
    buildProvenanceManifest({
      ...common,
      provenance_manifest_ref: `${input.integration_ref}:provenance:safety`,
      source_classes: ["policy_config", "validator_output", "controller_telemetry"],
      audit_notes: ["Runtime safety source uses current policy, validation, and controller readiness evidence."],
    }),
    buildProvenanceManifest({
      ...common,
      provenance_manifest_ref: `${input.integration_ref}:provenance:execution`,
      source_classes: ["validator_output", "controller_telemetry"],
      audit_notes: ["Runtime execution source uses validator-approved control evidence only."],
    }),
    buildProvenanceManifest({
      ...common,
      provenance_manifest_ref: `${input.integration_ref}:provenance:orchestration`,
      source_classes: ["policy_config", "validator_output"],
      audit_notes: ["Runtime orchestration source uses state and validation refs only."],
    }),
  ]);
}

function buildArtifacts(
  input: CoreRuntimeServiceIntegrationInput,
  serviceRefs: CoreRuntimeServiceRefs,
  policyRefs: readonly Ref[],
  provenance: readonly ProvenanceManifest[],
): readonly ArtifactEnvelope[] {
  return freezeArray([
    artifact(input, "prompt_bundle", serviceRefs.prompt_contract, provenance[0], policyRefs),
    artifact(input, "model_response", serviceRefs.gemini_adapter, provenance[1], policyRefs),
    artifact(input, "safety_validation_report", serviceRefs.safety, provenance[2], policyRefs),
    artifact(input, "execution_command", serviceRefs.control_execution, provenance[3], policyRefs, [
      input.execute_request.approved_plan.approved_plan_ref,
      input.execute_request.safety_envelope.safety_envelope_ref,
      input.execute_request.controller_readiness.readiness_ref,
    ]),
    artifact(input, "route_decision", serviceRefs.orchestration, provenance[4], policyRefs, [
      input.orchestration_snapshot.current_context_ref,
      input.execute_request.approved_plan.validation_decision_ref,
    ]),
  ]);
}

function artifact(
  input: CoreRuntimeServiceIntegrationInput,
  artifactType: ArtifactType,
  serviceOfRecord: ApiServiceRef,
  provenance: ProvenanceManifest,
  policyRefs: readonly Ref[],
  parents: readonly Ref[] = [],
): ArtifactEnvelope {
  return buildArtifactEnvelope({
    artifact_ref: `${input.integration_ref}:artifact:${artifactType}`,
    artifact_type: artifactType,
    schema_ref: `${CORE_RUNTIME_SERVICE_INTEGRATION_SCHEMA_VERSION}:${artifactType}`,
    service_of_record: serviceOfRecord,
    created_at_ms: input.occurred_at_ms,
    created_by_component: "runtime:core-service-integration",
    task_ref: input.task_ref,
    episode_ref: input.session_ref,
    parent_artifact_refs: parents,
    provenance_manifest_ref: provenance.provenance_manifest_ref,
    policy_refs: policyRefs,
    validation_status: "valid",
    visibility_class: provenance.recommended_visibility_class,
    audit_replay_refs: [provenance.provenance_manifest_ref, input.orchestration_snapshot.current_context_ref],
  });
}

function buildEvents(
  input: CoreRuntimeServiceIntegrationInput,
  serviceRefs: CoreRuntimeServiceRefs,
  artifactEnvelopes: readonly ArtifactEnvelope[],
): readonly ServiceEventEnvelope[] {
  return freezeArray(artifactEnvelopes.map((envelope) => {
    const eventClass = eventClassForArtifact(envelope.artifact_type);
    return buildServiceEventEnvelope({
      service_event_ref: `${input.integration_ref}:event:${envelope.artifact_type}`,
      event_class: eventClass,
      producer_service: envelope.service_of_record,
      consumer_services: consumersFor(eventClass, serviceRefs),
      artifact_envelope: envelope,
      occurred_at_ms: input.occurred_at_ms,
      delivery_requirement: deliveryForEventClass(eventClass),
      priority: priorityFor(eventClass),
      ordering_key_ref: eventClass === "ControlExecutionEvent" ? input.execute_request.control_policy.command_owner_ref : input.task_ref,
      acknowledgement_required: acknowledgementFor(eventClass),
      audit_refs: [
        envelope.artifact_ref,
        envelope.provenance_manifest_ref,
        input.execute_request.approved_plan.validation_decision_ref,
      ],
    });
  }));
}

function consumersFor(eventClass: ServiceEventClass, serviceRefs: CoreRuntimeServiceRefs): readonly ApiServiceRef[] {
  if (eventClass === "PromptRequestEvent") {
    return freezeArray([serviceRefs.gemini_adapter, serviceRefs.orchestration]);
  }
  if (eventClass === "CognitiveResponseEvent") {
    return freezeArray([serviceRefs.prompt_contract, serviceRefs.safety, serviceRefs.orchestration]);
  }
  if (eventClass === "SafetyValidationEvent") {
    return freezeArray([serviceRefs.orchestration, serviceRefs.control_execution]);
  }
  if (eventClass === "ControlExecutionEvent") {
    return freezeArray([serviceRefs.orchestration, serviceRefs.safety]);
  }
  return freezeArray([serviceRefs.orchestration]);
}

function priorityFor(eventClass: ServiceEventClass): ServiceEventPriority {
  if (eventClass === "SafetyValidationEvent" || eventClass === "SafeHoldEvent") {
    return "safety_critical";
  }
  if (eventClass === "ControlExecutionEvent" || eventClass === "ContractErrorEvent") {
    return "important";
  }
  return "routine";
}

function acknowledgementFor(eventClass: ServiceEventClass): boolean {
  return eventClass === "SafetyValidationEvent"
    || eventClass === "SafeHoldEvent"
    || eventClass === "ControlExecutionEvent"
    || eventClass === "ContractErrorEvent";
}

function summarizeEventEvidence(
  artifactEnvelopes: readonly ArtifactEnvelope[],
  serviceEvents: readonly ServiceEventEnvelope[],
): CoreRuntimeEventEvidenceReport {
  const eventReports = serviceEvents.map(validateServiceEventEnvelope);
  const issues = freezeArray(eventReports.flatMap((report) => report.issues));
  const eventClasses = new Set(serviceEvents.map((event) => event.event_class));
  const strictSafetyAckCount = serviceEvents.filter((event) =>
    event.priority === "safety_critical"
    && event.acknowledgement_required
    && event.delivery_requirement !== "best_effort").length;
  const base = {
    artifact_count: artifactEnvelopes.length,
    event_count: serviceEvents.length,
    producer_owner_match: serviceEvents.every((event) => event.producer_service === event.artifact_envelope.service_of_record),
    strict_safety_ack_count: strictSafetyAckCount,
    contains_prompt_event: eventClasses.has("PromptRequestEvent"),
    contains_response_event: eventClasses.has("CognitiveResponseEvent"),
    contains_safety_event: eventClasses.has("SafetyValidationEvent"),
    contains_execution_event: eventClasses.has("ControlExecutionEvent"),
    contains_orchestration_event: serviceEvents.some((event) => event.producer_service === "agent_orchestration"),
    issue_count: issues.length,
    issues,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function eventEvidenceReady(eventEvidence: CoreRuntimeEventEvidenceReport): boolean {
  return eventEvidence.artifact_count === 5
    && eventEvidence.event_count === 5
    && eventEvidence.producer_owner_match
    && eventEvidence.strict_safety_ack_count >= 1
    && eventEvidence.contains_prompt_event
    && eventEvidence.contains_response_event
    && eventEvidence.contains_safety_event
    && eventEvidence.contains_execution_event
    && eventEvidence.contains_orchestration_event
    && eventEvidence.issue_count === 0;
}

function buildInvariants(
  decision: CoreRuntimeServiceIntegrationDecision,
  eventEvidence: CoreRuntimeEventEvidenceReport,
): CoreRuntimeIntegrationInvariants {
  const ready = decision === "ready_for_runtime_service_composition";
  return Object.freeze({
    authorized_step_ref: CORE_RUNTIME_SERVICE_INTEGRATION_STEP_REF,
    prompt_firewall_preserved: ready,
    no_rl_boundary_preserved: ready,
    safety_authority_preserved: ready,
    api_event_evidence_preserved: ready && eventEvidenceReady(eventEvidence),
    runtime_truth_boundary: "runtime_embodied_only",
    raw_prompt_exposed: false,
    private_reasoning_exposed: false,
    qa_runtime_truth_exposed: false,
    hidden_simulator_truth_exposed: false,
    forbidden_later_step_refs: freezeArray([] as never[]),
  });
}

function buildBlockedReasonCodes(
  promptFirewall: PromptFirewallValidationReport,
  responseFirewall: PromptFirewallValidationReport,
  promptNoRl: NoRLComplianceReport,
  responseNoRl: NoRLComplianceReport,
  executionGatekeeper: ExecutionGatekeeperReport,
  eventEvidence: CoreRuntimeEventEvidenceReport,
  provenanceBlocked: boolean,
): readonly string[] {
  return freezeArray([
    ...promptFirewall.issues.map((issue) => `prompt_firewall:${issue.code}`),
    ...promptFirewall.findings.map((finding) => `prompt_firewall:${finding.category}`),
    ...responseFirewall.issues.map((issue) => `response_firewall:${issue.code}`),
    ...responseFirewall.findings.map((finding) => `response_firewall:${finding.category}`),
    ...promptNoRl.issues.map((issue) => `prompt_no_rl:${issue.code}`),
    ...promptNoRl.violations.map((violation) => `prompt_no_rl:${violation.category}`),
    ...responseNoRl.issues.map((issue) => `response_no_rl:${issue.code}`),
    ...responseNoRl.violations.map((violation) => `response_no_rl:${violation.category}`),
    ...executionGatekeeper.issues.map((issue) => `execution_gatekeeper:${issue.code}`),
    ...eventEvidence.issues.map((issue) => `event_evidence:${issue.code}`),
    ...(provenanceBlocked ? ["provenance_boundary:cognition_not_allowed"] : []),
  ]);
}

function summarizeFirewall(report: PromptFirewallValidationReport): BoundaryContractSummary<FirewallLeakCategory> {
  return boundarySummary(
    report.decision,
    report.scan_ref,
    report.issues,
    report.critical_count,
    report.high_count,
    report.quarantined,
    report.findings.map((finding) => finding.category),
  );
}

function summarizeNoRl(report: NoRLComplianceReport): BoundaryContractSummary<NoRLViolationCategory> {
  return boundarySummary(
    report.decision,
    report.scan_ref,
    report.issues,
    report.critical_count,
    report.high_count,
    report.quarantine_required,
    report.violations.map((violation) => violation.category),
  );
}

function boundarySummary<TCategory extends string>(
  decision: string,
  scanRef: Ref,
  issues: readonly ValidationIssue[],
  criticalCount: number,
  highCount: number,
  quarantined: boolean,
  categories: readonly TCategory[],
): BoundaryContractSummary<TCategory> {
  const base = {
    decision,
    issue_count: issues.length,
    error_count: issues.filter((issue) => issue.severity === "error").length,
    warning_count: issues.filter((issue) => issue.severity === "warning").length,
    critical_count: criticalCount,
    high_count: highCount,
    quarantined,
    categories: freezeArray([...new Set(categories)]),
    scan_ref: scanRef,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const CORE_RUNTIME_SERVICE_INTEGRATION_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: CORE_RUNTIME_SERVICE_INTEGRATION_SCHEMA_VERSION,
  step_ref: CORE_RUNTIME_SERVICE_INTEGRATION_STEP_REF,
  production_readiness_docs: freezeArray([
    "production_readiness_docs/02_PRODUCT_SCOPE_AND_RUNTIME_REQUIREMENTS.md",
    "production_readiness_docs/04_BACKEND_RUNTIME_ARCHITECTURE.md",
    "production_readiness_docs/05_API_AND_SERVICE_INTEGRATION_PLAN.md",
    "production_readiness_docs/08_RUNTIME_COMPOSITION_AND_ENTRYPOINT_PLAN.md",
  ]),
  architecture_docs: freezeArray([
    "architecture_docs/01_SYSTEM_ARCHITECTURE_OVERVIEW.md",
    "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md",
    "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  ]),
  integrated_contracts: freezeArray([
    "PromptFirewallValidationContract",
    "NoRLPromptComplianceContract",
    "ExecutionGatekeeper",
    "ArtifactEnvelope",
    "ProvenanceManifest",
    "ServiceEventEnvelope",
  ]),
});
