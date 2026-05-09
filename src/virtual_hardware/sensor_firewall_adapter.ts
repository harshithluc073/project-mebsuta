/**
 * Sensor firewall adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.4, 4.13, 4.16, 4.17, and 4.18, with the information
 * firewall policy imported from
 * `architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md`
 * sections 2.5 through 2.9 and 2.14.
 *
 * The adapter is the final cognitive-ingress boundary for sensor-bus output.
 * It accepts synchronized observation bundles, maps every model-facing field
 * to a declared provenance class, strips or blocks forbidden simulator truth,
 * builds prompt-audit records, and returns only cognitive-safe evidence refs
 * for Gemini-facing planning, verification, Oops Loop, memory, tool-use, or
 * monologue request builders.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  MissingSensorRecord,
  ObservationBundle,
  SensorBusRecommendedAction,
  SensorHealthReport,
  StalePacketRecord,
} from "./sensor_bus";
import { SENSOR_BUS_SCHEMA_VERSION } from "./sensor_bus";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  CalibrationProfile,
  HardwareHealthStatus,
  SensorClass,
  VirtualHardwareManifest,
  VirtualSensorDescriptor,
} from "./virtual_hardware_manifest_registry";

export const SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION = "mebsuta.sensor_firewall_adapter.v1" as const;
export const SENSOR_FIREWALL_POLICY_VERSION = "mebsuta.cognitive_ingress_policy.v1" as const;

const DEFAULT_FORBIDDEN_FIELD_CATEGORIES: readonly ForbiddenFieldCategory[] = Object.freeze([
  "backend_object_id",
  "scene_graph_path",
  "exact_backend_pose",
  "hidden_collision_mesh",
  "qa_truth",
  "benchmark_answer",
  "simulator_seed",
  "debug_overlay",
  "engine_handle",
  "developer_only_symbol",
]);
const OBSERVATION_PROMPT_ARTIFACTS: readonly FirewallArtifactKind[] = Object.freeze(["observation_bundle", "prompt"]);

const STRICT_COORDINATE_KEY_PATTERN = /(^|_)(world|backend|scene|ground_truth|absolute|exact).*(pose|position|coordinate|transform|translation|rotation|xyz)|(^|_)(pose|position|coordinate|transform|translation|rotation|xyz).*(world|backend|scene|ground_truth|absolute|exact)/i;
const INTERNAL_REF_KEY_PATTERN = /(backend|engine|scene_graph|collision_mesh|mesh_id|object_id|qa_|ground_truth|benchmark|simulator_seed|debug_overlay|render_node|physics_snapshot|engine_handle|developer_only)/i;
const INTERNAL_REF_VALUE_PATTERN = /\b(?:object|obj|mesh|shape|body|node|scene|qa|seed|debug|engine|backend|collision)[_-][A-Za-z0-9][A-Za-z0-9_-]*\b|\/(?:World|Scene|Root|Meshes|Collision)\//i;

export type CognitiveDestination =
  | "planning_prompt"
  | "verification_prompt"
  | "oops_loop_prompt"
  | "memory_grounded_prompt"
  | "tool_use_prompt"
  | "monologue_generation";

export type ProvenanceClassId =
  | "P-001"
  | "P-002"
  | "P-003"
  | "P-004"
  | "P-005"
  | "P-006"
  | "P-007"
  | "P-008"
  | "P-009"
  | "P-010"
  | "P-011"
  | "P-012"
  | "P-013"
  | "P-014"
  | "P-015"
  | "P-016"
  | "P-017"
  | "P-018"
  | "P-019"
  | "P-020";

export type FirewallDecisionKind = "allow" | "allow_with_transform" | "redact" | "reject" | "quarantine" | "escalate";
export type FirewallRiskLevel = "low" | "medium" | "high" | "critical";
export type FirewallNextAction = "continue" | "repair" | "regenerate" | "safe_hold" | "human_review";
export type FirewallContainmentAction = "redact" | "reject" | "invalidate" | "safe_hold" | "delete_memory" | "human_review";
export type FirewallArtifactKind = "prompt" | "memory" | "monologue" | "verification_packet" | "log" | "dashboard" | "observation_bundle";

export type ForbiddenFieldCategory =
  | "backend_object_id"
  | "scene_graph_path"
  | "exact_backend_pose"
  | "hidden_collision_mesh"
  | "qa_truth"
  | "benchmark_answer"
  | "simulator_seed"
  | "debug_overlay"
  | "engine_handle"
  | "developer_only_symbol"
  | "unknown";

export type SensorFirewallIssueCode =
  | "BundleSchemaMismatch"
  | "BundleManifestMismatch"
  | "BundleNotFirewallInput"
  | "MissingPromptAuditTrail"
  | "MissingProvenance"
  | "ProvenanceClassForbidden"
  | "DestinationPolicyViolation"
  | "ForbiddenTruthDetected"
  | "CalibrationNotDeclared"
  | "SensorEvidenceNotDeclared"
  | "PacketBlockedBySensorBus"
  | "HealthReportRequiresAction"
  | "CoordinateWithoutEmbodiedEvidence"
  | "UnsupportedDestination"
  | "OutputContractMissing";

/**
 * A candidate payload fragment plus its intended cognitive destination. This
 * is the smallest unit the adapter classifies and scans.
 */
export interface CandidateFirewallField {
  readonly field_path: string;
  readonly field_name: string;
  readonly value: unknown;
  readonly source_component: string;
  readonly evidence_refs: readonly Ref[];
  readonly declared_provenance_class?: ProvenanceClassId;
}

/**
 * Classification record required before any field can enter a prompt packet.
 */
export interface ProvenanceRecord {
  readonly schema_version: typeof SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly provenance_record_id: Ref;
  readonly field_path: string;
  readonly source_component: string;
  readonly provenance_class: ProvenanceClassId;
  readonly allowed_destinations: readonly CognitiveDestination[];
  readonly evidence_refs: readonly Ref[];
  readonly requires_confidence: boolean;
  readonly confidence?: number;
  readonly forbidden_reason?: ForbiddenFieldCategory;
  readonly determinism_hash: string;
}

/**
 * Hidden-truth finding emitted by the recursive classifier.
 */
export interface ForbiddenTruthFinding {
  readonly finding_id: Ref;
  readonly field_path: string;
  readonly contamination_type: ForbiddenFieldCategory;
  readonly severity: FirewallRiskLevel;
  readonly evidence: string;
  readonly recommended_containment: FirewallContainmentAction;
}

/**
 * Quarantine artifact for contaminated prompt, bundle, or derived evidence.
 */
export interface QuarantineRecord {
  readonly schema_version: typeof SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly quarantine_id: Ref;
  readonly source_component: string;
  readonly contamination_type: ForbiddenFieldCategory;
  readonly affected_artifacts: readonly FirewallArtifactKind[];
  readonly runtime_state: Ref;
  readonly containment_action: FirewallContainmentAction;
  readonly downstream_invalidations: readonly Ref[];
  readonly postmortem_required: boolean;
  readonly finding_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Prompt audit record required before any request can be sent to Gemini.
 */
export interface PromptAuditReport {
  readonly schema_version: typeof SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly audit_report_id: Ref;
  readonly policy_version: typeof SENSOR_FIREWALL_POLICY_VERSION;
  readonly cognitive_destination: CognitiveDestination;
  readonly packet_id: Ref;
  readonly passed: boolean;
  readonly blocked_fields: readonly string[];
  readonly transformed_fields: readonly string[];
  readonly forbidden_findings: readonly ForbiddenTruthFinding[];
  readonly risk_level: FirewallRiskLevel;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly next_action: FirewallNextAction;
  readonly determinism_hash: string;
}

/**
 * Sensor evidence summary that can safely enter a model-facing packet.
 */
export interface CognitiveSensorEvidence {
  readonly evidence_ref: Ref;
  readonly provenance_class: Extract<ProvenanceClassId, "P-002" | "P-003" | "P-004" | "P-005" | "P-006" | "P-007" | "P-009">;
  readonly packet_kind: "camera" | "audio" | "proprioception" | "contact" | "imu" | "actuator_feedback";
  readonly sensor_ref: Ref;
  readonly health_status: HardwareHealthStatus;
  readonly confidence: number;
  readonly timestamp_interval: {
    readonly start_s: number;
    readonly end_s: number;
  };
  readonly field_paths: readonly string[];
}

/**
 * Declared calibration reference that is safe to expose as robot
 * self-knowledge.
 */
export interface CognitiveCalibrationEvidence {
  readonly calibration_ref: Ref;
  readonly provenance_class: "P-008";
  readonly sensor_ref: Ref;
  readonly sensor_class: SensorClass;
  readonly frame_ref: Ref;
  readonly calibration_version: string;
}

/**
 * Sanitized health summary, preserving uncertainty while omitting audit-only
 * blocked categories.
 */
export interface CognitiveHealthSummary {
  readonly health_report_ref: Ref;
  readonly timestamp_interval: SensorHealthReport["timestamp_interval"];
  readonly healthy_sensor_refs: readonly Ref[];
  readonly degraded_sensor_refs: readonly Ref[];
  readonly missing_sensors: readonly {
    readonly sensor_ref: Ref;
    readonly expected_packet_kind: MissingSensorRecord["expected_packet_kind"];
    readonly reason: MissingSensorRecord["reason"];
    readonly recommended_action: SensorBusRecommendedAction;
  }[];
  readonly stale_packets: readonly {
    readonly packet_ref: Ref;
    readonly sensor_ref: Ref;
    readonly age_ms: number;
    readonly stale_after_ms: number;
  }[];
  readonly synchronization_spread_ms: number;
  readonly recommended_action: SensorBusRecommendedAction;
}

/**
 * Final cognitive ingress packet. It contains only embodied sensor evidence,
 * declared calibration, health/uncertainty, safety constraints, and the output
 * contract required by the prompt builder.
 */
export interface CognitiveIngressPacket {
  readonly schema_version: typeof SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly packet_id: Ref;
  readonly source_bundle_id: Ref;
  readonly manifest_id: Ref;
  readonly cognitive_destination: CognitiveDestination;
  readonly task_instruction: string;
  readonly sensor_evidence_refs: readonly CognitiveSensorEvidence[];
  readonly calibration_refs: readonly CognitiveCalibrationEvidence[];
  readonly health_summary: CognitiveHealthSummary;
  readonly safety_constraints: readonly string[];
  readonly output_contract: string;
  readonly blocked_payload_refs: readonly Ref[];
  readonly provenance_records: readonly ProvenanceRecord[];
  readonly audit_event_ref: Ref;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "gemini_ingress_audit_passed";
}

/**
 * Request object used to evaluate a sensor-bus bundle for cognitive ingress.
 */
export interface ObservationIngressRequest {
  readonly observation_bundle: ObservationBundle;
  readonly cognitive_destination: CognitiveDestination;
  readonly runtime_state_ref: Ref;
  readonly task_instruction: string;
  readonly safety_constraints: readonly string[];
  readonly output_contract: string;
  readonly memory_snippet_refs?: readonly Ref[];
  readonly controller_telemetry_refs?: readonly Ref[];
  readonly sanitized_validator_context_refs?: readonly Ref[];
}

/**
 * Decision returned from the sensor firewall. Only `allow` and
 * `allow_with_transform` decisions carry a model-facing packet.
 */
export interface SensorFirewallDecision {
  readonly schema_version: typeof SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly decision_id: Ref;
  readonly decision: FirewallDecisionKind;
  readonly cognitive_destination: CognitiveDestination;
  readonly runtime_state_ref: Ref;
  readonly cognitive_packet?: CognitiveIngressPacket;
  readonly audit_report: PromptAuditReport;
  readonly quarantine_records: readonly QuarantineRecord[];
  readonly blocked_payload_refs: readonly Ref[];
  readonly transformed_fields: readonly string[];
  readonly risk_level: FirewallRiskLevel;
  readonly next_action: FirewallNextAction;
  readonly determinism_hash: string;
}

/**
 * Runtime policy configuration for the sensor firewall adapter.
 */
export interface SensorFirewallAdapterConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly blocked_field_categories?: readonly ForbiddenFieldCategory[];
  readonly allow_degraded_observation_bundles?: boolean;
  readonly allow_sensor_bus_only_evidence_in_oops_loop?: boolean;
  readonly require_task_instruction?: boolean;
  readonly require_output_contract?: boolean;
}

export class SensorFirewallAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SensorFirewallAdapterError";
    this.issues = issues;
  }
}

/**
 * Enforces cognitive visibility rules on sensor-bus observation bundles.
 */
export class SensorFirewallAdapter {
  private readonly manifest: VirtualHardwareManifest;
  private readonly blockedFieldCategories: readonly ForbiddenFieldCategory[];
  private readonly allowDegradedObservationBundles: boolean;
  private readonly allowSensorBusOnlyEvidenceInOopsLoop: boolean;
  private readonly requireTaskInstruction: boolean;
  private readonly requireOutputContract: boolean;
  private readonly decisions = new Map<Ref, SensorFirewallDecision>();
  private readonly quarantines = new Map<Ref, QuarantineRecord>();

  public constructor(private readonly config: SensorFirewallAdapterConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.blockedFieldCategories = freezeArray(config.blocked_field_categories ?? DEFAULT_FORBIDDEN_FIELD_CATEGORIES);
    this.allowDegradedObservationBundles = config.allow_degraded_observation_bundles ?? true;
    this.allowSensorBusOnlyEvidenceInOopsLoop = config.allow_sensor_bus_only_evidence_in_oops_loop ?? true;
    this.requireTaskInstruction = config.require_task_instruction ?? true;
    this.requireOutputContract = config.require_output_contract ?? true;
  }

  /**
   * Evaluates a synchronized observation bundle and returns an audited
   * cognitive-ingress decision. Critical contamination blocks the packet and
   * emits quarantine records; clean redaction produces an allow-with-transform
   * decision when nonessential audit-only fields were removed.
   */
  public evaluateObservationBundleIngress(request: ObservationIngressRequest): SensorFirewallDecision {
    const issues: ValidationIssue[] = [];
    const transformedFields: string[] = [];
    const blockedPayloadRefs = new Set<Ref>();
    this.validateRequestShell(request, issues);

    const sourceFields = this.collectCandidateFields(request);
    const provenanceRecords = sourceFields.map((field) => this.classifyDataProvenance(field, request.cognitive_destination));
    for (const record of provenanceRecords) {
      if (!record.allowed_destinations.includes(request.cognitive_destination)) {
        issues.push(makeIssue("error", "DestinationPolicyViolation", record.field_path, `Provenance class ${record.provenance_class} is not allowed for ${request.cognitive_destination}.`, "Remove this field or transform it into an allowed embodied evidence summary."));
      }
      if (isForbiddenProvenance(record.provenance_class)) {
        issues.push(makeIssue("error", "ProvenanceClassForbidden", record.field_path, `Forbidden provenance ${record.provenance_class} cannot enter cognitive ingress.`, "Quarantine the source artifact and rebuild the prompt from sensor evidence."));
      }
    }

    const findings = scanForbiddenTruth(sourceFields, this.blockedFieldCategories);
    for (const finding of findings) {
      blockedPayloadRefs.add(request.observation_bundle.bundle_id);
      issues.push(makeIssue(
        finding.severity === "critical" ? "error" : "warning",
        "ForbiddenTruthDetected",
        finding.field_path,
        `Forbidden ${finding.contamination_type} detected in candidate cognitive ingress field.`,
        "Block or redact the field and quarantine contaminated artifacts before model invocation.",
      ));
    }

    const sensorEvidence = this.buildSensorEvidence(request.observation_bundle, request.cognitive_destination, issues, blockedPayloadRefs, transformedFields);
    const calibrationEvidence = this.buildCalibrationEvidence(request.observation_bundle, issues, transformedFields);
    const healthSummary = buildCognitiveHealthSummary(request.observation_bundle.sensor_health_report, transformedFields);
    const allProvenanceRecords = freezeArray([
      ...provenanceRecords,
      ...sensorEvidence.map((evidence) => makeProvenanceRecord(
        `$.sensor_evidence_refs.${evidence.evidence_ref}`,
        "SensorFirewallAdapter",
        evidence.provenance_class,
        evidence.field_paths,
        evidence.confidence,
      )),
      ...calibrationEvidence.map((evidence) => makeProvenanceRecord(
        `$.calibration_refs.${evidence.calibration_ref}`,
        "SensorFirewallAdapter",
        "P-008",
        [evidence.calibration_ref],
        undefined,
      )),
    ]);
    const quarantineRecords = findings.map((finding) => this.quarantineContaminatedArtifact(
      request.observation_bundle.bundle_id,
      finding,
      [request.observation_bundle.bundle_id],
      request.runtime_state_ref,
    ));
    const riskLevel = computeRiskLevel(issues, findings, request.observation_bundle.recommended_action);
    const nextAction = computeNextAction(riskLevel, issues, request.observation_bundle.recommended_action);
    const decisionKind = computeDecisionKind(issues, findings, transformedFields, this.allowDegradedObservationBundles);
    const packetId = `cognitive_ingress_${request.cognitive_destination}_${request.observation_bundle.bundle_id}`;
    const auditReport = buildPromptAuditReport(packetId, request.cognitive_destination, issues, findings, [...blockedPayloadRefs], transformedFields, riskLevel, nextAction);
    const cognitivePacket = decisionKind === "allow" || decisionKind === "allow_with_transform"
      ? this.buildCognitivePacket(request, packetId, sensorEvidence, calibrationEvidence, healthSummary, [...blockedPayloadRefs], allProvenanceRecords, auditReport.audit_report_id)
      : undefined;
    if (cognitivePacket === undefined) {
      blockedPayloadRefs.add(request.observation_bundle.bundle_id);
    }
    const decisionId = `sensor_firewall_decision_${request.observation_bundle.bundle_id}_${auditReport.determinism_hash.slice(0, 12)}`;
    const decision: SensorFirewallDecision = Object.freeze({
      schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
      decision_id: decisionId,
      decision: decisionKind,
      cognitive_destination: request.cognitive_destination,
      runtime_state_ref: request.runtime_state_ref,
      cognitive_packet: cognitivePacket,
      audit_report: auditReport,
      quarantine_records: freezeArray(quarantineRecords),
      blocked_payload_refs: freezeArray([...blockedPayloadRefs].sort()),
      transformed_fields: freezeArray([...new Set(transformedFields)].sort()),
      risk_level: riskLevel,
      next_action: nextAction,
      determinism_hash: computeDeterminismHash({
        decisionId,
        decisionKind,
        cognitivePacket,
        auditReport,
        quarantineRecords,
        blockedPayloadRefs: [...blockedPayloadRefs].sort(),
        transformedFields,
      }),
    });
    this.decisions.set(decision.decision_id, decision);
    return decision;
  }

  /**
   * Classifies a field into the provenance classes defined by the information
   * firewall architecture. Explicit class declarations win only if they remain
   * destination-legal after hidden-truth scanning.
   */
  public classifyDataProvenance(field: CandidateFirewallField, destination: CognitiveDestination): ProvenanceRecord {
    const provenanceClass = field.declared_provenance_class ?? inferProvenanceClass(field);
    return makeProvenanceRecord(field.field_path, field.source_component, provenanceClass, field.evidence_refs, extractConfidence(field.value), destination);
  }

  /**
   * Quarantines a contaminated observation artifact and records the containment
   * action required by the severity of the finding.
   */
  public quarantineContaminatedArtifact(
    artifactRef: Ref,
    contaminationFinding: ForbiddenTruthFinding,
    propagationScope: readonly Ref[],
    runtimeStateRef: Ref,
  ): QuarantineRecord {
    const containmentAction = containmentForFinding(contaminationFinding);
    const quarantineId = `quarantine_${artifactRef}_${contaminationFinding.finding_id}`;
    const record: QuarantineRecord = Object.freeze({
      schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
      quarantine_id: quarantineId,
      source_component: "SensorFirewallAdapter",
      contamination_type: contaminationFinding.contamination_type,
      affected_artifacts: freezeArray(OBSERVATION_PROMPT_ARTIFACTS),
      runtime_state: runtimeStateRef,
      containment_action: containmentAction,
      downstream_invalidations: freezeArray(propagationScope),
      postmortem_required: contaminationFinding.severity === "critical",
      finding_refs: freezeArray([contaminationFinding.finding_id]),
      determinism_hash: computeDeterminismHash({ quarantineId, contaminationFinding, propagationScope, runtimeStateRef, containmentAction }),
    });
    this.quarantines.set(record.quarantine_id, record);
    return record;
  }

  public getDecision(decisionId: Ref): SensorFirewallDecision | undefined {
    return this.decisions.get(decisionId);
  }

  public listDecisionIds(): readonly Ref[] {
    return freezeArray([...this.decisions.keys()].sort());
  }

  public listQuarantineIds(): readonly Ref[] {
    return freezeArray([...this.quarantines.keys()].sort());
  }

  private validateRequestShell(request: ObservationIngressRequest, issues: ValidationIssue[]): void {
    const bundle = request.observation_bundle;
    if (bundle.schema_version !== SENSOR_BUS_SCHEMA_VERSION) {
      issues.push(makeIssue("error", "BundleSchemaMismatch", "$.observation_bundle.schema_version", "Observation bundle schema does not match the SensorBus schema.", "Regenerate the bundle with the current SensorBus."));
    }
    if (bundle.manifest_id !== this.config.manifest_id) {
      issues.push(makeIssue("error", "BundleManifestMismatch", "$.observation_bundle.manifest_id", `Bundle manifest ${bundle.manifest_id} does not match firewall manifest ${this.config.manifest_id}.`, "Route the bundle to a firewall configured for the same manifest."));
    }
    if (bundle.cognitive_visibility !== "firewall_input_observation_bundle") {
      issues.push(makeIssue("error", "BundleNotFirewallInput", "$.observation_bundle.cognitive_visibility", "Bundle has not been marked as firewall input by the SensorBus.", "Only route SensorBus output into the sensor firewall."));
    }
    if (bundle.provenance_report.missing_provenance_packet_refs.length > 0) {
      issues.push(makeIssue("error", "MissingProvenance", "$.observation_bundle.provenance_report", "One or more packet provenance records are incomplete.", "Repair packet provenance before cognitive ingress."));
    }
    if (this.requireTaskInstruction && request.task_instruction.trim().length === 0) {
      issues.push(makeIssue("error", "MissingPromptAuditTrail", "$.task_instruction", "Task instruction is required for prompt audit coverage.", "Provide the human-visible instruction or block prompt construction."));
    }
    if (this.requireOutputContract && request.output_contract.trim().length === 0) {
      issues.push(makeIssue("error", "OutputContractMissing", "$.output_contract", "Output contract is required before model invocation.", "Attach the structured response contract for this cognitive destination."));
    }
    if (bundle.bundle_status === "blocked") {
      issues.push(makeIssue("error", "PacketBlockedBySensorBus", "$.observation_bundle.bundle_status", "SensorBus marked the observation bundle as blocked.", "Do not send blocked sensor evidence to Gemini."));
    } else if (bundle.bundle_status === "degraded" && !this.allowDegradedObservationBundles) {
      issues.push(makeIssue("error", "HealthReportRequiresAction", "$.observation_bundle.bundle_status", "Degraded observation bundles are disallowed by firewall policy.", "Recapture or re-observe before prompt construction."));
    }
    if (bundle.recommended_action === "safe_hold" || bundle.recommended_action === "human_review") {
      issues.push(makeIssue("warning", "HealthReportRequiresAction", "$.observation_bundle.recommended_action", `SensorBus recommended ${bundle.recommended_action}.`, "Preserve the warning in the health summary and let orchestration decide whether to pause."));
    }
  }

  private collectCandidateFields(request: ObservationIngressRequest): readonly CandidateFirewallField[] {
    const bundle = request.observation_bundle;
    return freezeArray([
      makeCandidate("$.task_instruction", "task_instruction", request.task_instruction, "HumanTaskInstruction", [], "P-001"),
      makeCandidate("$.sensor_health_report", "sensor_health_report", buildCognitiveHealthSummary(bundle.sensor_health_report, []), "SensorBus", [bundle.sensor_health_report.sensor_health_report_id], "P-011"),
      makeCandidate("$.safety_constraints", "safety_constraints", request.safety_constraints, "SafetyManager", [], "P-011"),
      makeCandidate("$.output_contract", "output_contract", request.output_contract, "PromptBuilder", [], "P-011"),
      makeCandidate("$.memory_snippet_refs", "memory_snippet_refs", request.memory_snippet_refs ?? [], "MemoryProvenanceValidator", request.memory_snippet_refs ?? [], "P-010"),
      makeCandidate("$.controller_telemetry_refs", "controller_telemetry_refs", request.controller_telemetry_refs ?? [], "ControllerTelemetry", request.controller_telemetry_refs ?? [], "P-009"),
      makeCandidate("$.sanitized_validator_context_refs", "sanitized_validator_context_refs", request.sanitized_validator_context_refs ?? [], "SanitizationService", request.sanitized_validator_context_refs ?? [], "P-011"),
      makeCandidate("$.observation_bundle.provenance_report.provenance_report_ref", "provenance_report_ref", bundle.provenance_report.provenance_report_ref, "SensorBus", [bundle.provenance_report.provenance_report_ref], "P-011"),
    ]);
  }

  private buildSensorEvidence(
    bundle: ObservationBundle,
    destination: CognitiveDestination,
    issues: ValidationIssue[],
    blockedPayloadRefs: Set<Ref>,
    transformedFields: string[],
  ): readonly CognitiveSensorEvidence[] {
    const evidence: CognitiveSensorEvidence[] = [];
    for (const record of bundle.packet_records) {
      const sensor = this.resolvePacketSensor(record.sensor_ref, record.packet_kind);
      if (record.readiness === "blocked" || record.route === "blocked") {
        blockedPayloadRefs.add(record.packet_ref);
        issues.push(makeIssue("error", "PacketBlockedBySensorBus", `$.packet_records.${record.packet_ref}`, `Packet ${record.packet_ref} is blocked by SensorBus.`, "Keep blocked packets out of model-facing evidence."));
        continue;
      }
      if (sensor === undefined) {
        blockedPayloadRefs.add(record.packet_ref);
        issues.push(makeIssue("error", "SensorEvidenceNotDeclared", `$.packet_records.${record.packet_ref}.sensor_ref`, `Packet ${record.packet_ref} does not resolve to declared sensor evidence.`, "Declare the source sensor before cognitive ingress."));
        continue;
      }
      if (!isSensorDestinationAllowed(sensor, destination, record.packet_kind, this.allowSensorBusOnlyEvidenceInOopsLoop)) {
        blockedPayloadRefs.add(record.packet_ref);
        issues.push(makeIssue("warning", "DestinationPolicyViolation", `$.packet_records.${record.packet_ref}.route`, `Packet ${record.packet_ref} is not destination-eligible for ${destination}.`, "Route the packet to a non-cognitive or diagnostic-only consumer."));
        continue;
      }
      const provenanceClass = provenanceForPacket(record.packet_kind, sensor.sensor_class);
      const fieldPaths = allowedFieldPathsForPacket(record.packet_kind);
      if (record.packet_kind === "camera" || record.packet_kind === "audio" || record.packet_kind === "contact") {
        transformedFields.push(`$.packet_records.${record.packet_ref}.hidden_fields_removed`);
      }
      evidence.push(Object.freeze({
        evidence_ref: record.packet_ref,
        provenance_class: provenanceClass,
        packet_kind: record.packet_kind,
        sensor_ref: sensor.sensor_id,
        health_status: record.health_status,
        confidence: clamp01(record.confidence),
        timestamp_interval: Object.freeze({
          start_s: record.timestamp_interval.start_s,
          end_s: record.timestamp_interval.end_s,
        }),
        field_paths: freezeArray(fieldPaths),
      }));
    }
    return freezeArray(evidence);
  }

  private buildCalibrationEvidence(bundle: ObservationBundle, issues: ValidationIssue[], transformedFields: string[]): readonly CognitiveCalibrationEvidence[] {
    const packetSensorRefs = new Set(bundle.packet_records.filter((record) => record.route !== "blocked" && record.readiness !== "blocked").map((record) => record.sensor_ref));
    const evidence: CognitiveCalibrationEvidence[] = [];
    for (const sensorRef of packetSensorRefs) {
      const sensor = this.resolvePacketSensor(sensorRef, sensorRef === "proprioception_bus" ? "proprioception" : sensorRef === "contact_sensor_bus" ? "contact" : undefined);
      if (sensor === undefined) {
        continue;
      }
      const calibration = this.manifest.calibration_profiles.find((profile) => profile.calibration_profile_ref === sensor.calibration_ref);
      if (calibration === undefined || calibration.cognitive_visibility !== "declared_calibration_allowed") {
        issues.push(makeIssue("error", "CalibrationNotDeclared", `$.calibration_refs.${sensor.calibration_ref}`, `Calibration ${sensor.calibration_ref} is not declared for cognitive use.`, "Expose only declared physical self-calibration."));
        continue;
      }
      transformedFields.push(`$.calibration_refs.${sensor.calibration_ref}.backend_geometry_removed`);
      evidence.push(Object.freeze({
        calibration_ref: calibration.calibration_profile_ref,
        provenance_class: "P-008",
        sensor_ref: sensor.sensor_id,
        sensor_class: sensor.sensor_class,
        frame_ref: calibration.frame_ref,
        calibration_version: calibration.version,
      }));
    }
    return freezeArray(dedupeCalibrationEvidence(evidence));
  }

  private buildCognitivePacket(
    request: ObservationIngressRequest,
    packetId: Ref,
    sensorEvidence: readonly CognitiveSensorEvidence[],
    calibrationEvidence: readonly CognitiveCalibrationEvidence[],
    healthSummary: CognitiveHealthSummary,
    blockedPayloadRefs: readonly Ref[],
    provenanceRecords: readonly ProvenanceRecord[],
    auditEventRef: Ref,
  ): CognitiveIngressPacket {
    return Object.freeze({
      schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      source_bundle_id: request.observation_bundle.bundle_id,
      manifest_id: this.config.manifest_id,
      cognitive_destination: request.cognitive_destination,
      task_instruction: request.task_instruction,
      sensor_evidence_refs: freezeArray(sensorEvidence),
      calibration_refs: freezeArray(calibrationEvidence),
      health_summary: healthSummary,
      safety_constraints: freezeArray(request.safety_constraints),
      output_contract: request.output_contract,
      blocked_payload_refs: freezeArray(blockedPayloadRefs),
      provenance_records: freezeArray(provenanceRecords),
      audit_event_ref: auditEventRef,
      determinism_hash: computeDeterminismHash({
        packetId,
        bundleId: request.observation_bundle.bundle_id,
        sensorEvidence,
        calibrationEvidence,
        healthSummary,
        blockedPayloadRefs,
        provenanceRecords,
        auditEventRef,
      }),
      cognitive_visibility: "gemini_ingress_audit_passed",
    });
  }

  private resolvePacketSensor(sensorRef: Ref, packetKind?: ObservationBundle["packet_records"][number]["packet_kind"]): VirtualSensorDescriptor | undefined {
    if (sensorRef === "proprioception_bus" || packetKind === "proprioception") {
      return this.manifest.sensor_inventory.find((sensor) => sensor.sensor_class === "joint_encoder" && sensor.declared_for_cognitive_use);
    }
    if (sensorRef === "contact_sensor_bus" || packetKind === "contact") {
      return this.manifest.sensor_inventory.find((sensor) => (sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque") && sensor.declared_for_cognitive_use);
    }
    return this.manifest.sensor_inventory.find((sensor) => sensor.sensor_id === sensorRef);
  }
}

export function createSensorFirewallAdapter(config: SensorFirewallAdapterConfig): SensorFirewallAdapter {
  return new SensorFirewallAdapter(config);
}

export function evaluateCognitiveIngress(
  request: ObservationIngressRequest,
  config: SensorFirewallAdapterConfig,
): SensorFirewallDecision {
  return new SensorFirewallAdapter(config).evaluateObservationBundleIngress(request);
}

function buildCognitiveHealthSummary(report: SensorHealthReport, transformedFields: string[]): CognitiveHealthSummary {
  transformedFields.push("$.sensor_health_report.firewall_blocked_fields");
  return Object.freeze({
    health_report_ref: report.sensor_health_report_id,
    timestamp_interval: report.timestamp_interval,
    healthy_sensor_refs: freezeArray(report.healthy_sensors),
    degraded_sensor_refs: freezeArray(report.degraded_sensors.map((sensor) => sensor.sensor_ref).sort()),
    missing_sensors: freezeArray(report.missing_sensors.map((record) => Object.freeze({
      sensor_ref: record.sensor_ref,
      expected_packet_kind: record.expected_packet_kind,
      reason: record.reason,
      recommended_action: record.recommended_action,
    }))),
    stale_packets: freezeArray(report.stale_packets.map((packet) => sanitizeStalePacket(packet))),
    synchronization_spread_ms: report.synchronization_spread_ms,
    recommended_action: report.recommended_action,
  });
}

function sanitizeStalePacket(packet: StalePacketRecord): CognitiveHealthSummary["stale_packets"][number] {
  return Object.freeze({
    packet_ref: packet.packet_ref,
    sensor_ref: packet.sensor_ref,
    age_ms: packet.age_ms,
    stale_after_ms: packet.stale_after_ms,
  });
}

function makeCandidate(
  fieldPath: string,
  fieldName: string,
  value: unknown,
  sourceComponent: string,
  evidenceRefs: readonly Ref[],
  provenanceClass?: ProvenanceClassId,
): CandidateFirewallField {
  return Object.freeze({
    field_path: fieldPath,
    field_name: fieldName,
    value,
    source_component: sourceComponent,
    evidence_refs: freezeArray(evidenceRefs),
    declared_provenance_class: provenanceClass,
  });
}

function makeProvenanceRecord(
  fieldPath: string,
  sourceComponent: string,
  provenanceClass: ProvenanceClassId,
  evidenceRefs: readonly Ref[],
  confidence?: number,
  destination?: CognitiveDestination,
): ProvenanceRecord {
  const allowedDestinations = allowedDestinationsForClass(provenanceClass);
  const recordId = `provenance_${computeDeterminismHash({ fieldPath, sourceComponent, provenanceClass, evidenceRefs, confidence, destination }).slice(0, 16)}`;
  const forbiddenReason = forbiddenReasonForClass(provenanceClass);
  return Object.freeze({
    schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
    provenance_record_id: recordId,
    field_path: fieldPath,
    source_component: sourceComponent,
    provenance_class: provenanceClass,
    allowed_destinations: freezeArray(allowedDestinations),
    evidence_refs: freezeArray(evidenceRefs),
    requires_confidence: requiresConfidence(provenanceClass),
    confidence: confidence === undefined ? undefined : clamp01(confidence),
    forbidden_reason: forbiddenReason,
    determinism_hash: computeDeterminismHash({ recordId, fieldPath, sourceComponent, provenanceClass, allowedDestinations, evidenceRefs, confidence, destination, forbiddenReason }),
  });
}

function inferProvenanceClass(field: CandidateFirewallField): ProvenanceClassId {
  const name = field.field_name.toLowerCase();
  const path = field.field_path.toLowerCase();
  const combined = `${name} ${path}`;
  if (/(backend|object_id|objectref)/.test(combined)) {
    return "P-012";
  }
  if (/scene_graph|scene_path|node_path/.test(combined)) {
    return "P-013";
  }
  if (STRICT_COORDINATE_KEY_PATTERN.test(combined)) {
    return "P-014";
  }
  if (/mesh|collision/.test(combined)) {
    return "P-015";
  }
  if (/qa|ground_truth|success_flag/.test(combined)) {
    return "P-016";
  }
  if (/benchmark|expected_answer/.test(combined)) {
    return "P-017";
  }
  if (/seed/.test(combined)) {
    return "P-018";
  }
  if (/calibration/.test(combined)) {
    return "P-008";
  }
  if (/memory/.test(combined)) {
    return "P-010";
  }
  if (/validator|safety|output_contract|health_report/.test(combined)) {
    return "P-011";
  }
  if (/telemetry|actuator/.test(combined)) {
    return "P-009";
  }
  if (/task_instruction|instruction/.test(combined)) {
    return "P-001";
  }
  return "P-020";
}

function allowedDestinationsForClass(provenanceClass: ProvenanceClassId): readonly CognitiveDestination[] {
  switch (provenanceClass) {
    case "P-001":
    case "P-002":
    case "P-003":
    case "P-004":
    case "P-005":
    case "P-006":
    case "P-007":
    case "P-008":
    case "P-010":
    case "P-011":
      return freezeArray(["planning_prompt", "verification_prompt", "oops_loop_prompt", "memory_grounded_prompt", "tool_use_prompt", "monologue_generation"]);
    case "P-009":
      return freezeArray(["planning_prompt", "verification_prompt", "oops_loop_prompt", "memory_grounded_prompt", "tool_use_prompt"]);
    case "P-012":
    case "P-013":
    case "P-014":
    case "P-015":
    case "P-016":
    case "P-017":
    case "P-018":
    case "P-019":
    case "P-020":
      return freezeArray([]);
  }
}

function forbiddenReasonForClass(provenanceClass: ProvenanceClassId): ForbiddenFieldCategory | undefined {
  switch (provenanceClass) {
    case "P-012":
      return "backend_object_id";
    case "P-013":
      return "scene_graph_path";
    case "P-014":
      return "exact_backend_pose";
    case "P-015":
      return "hidden_collision_mesh";
    case "P-016":
      return "qa_truth";
    case "P-017":
      return "benchmark_answer";
    case "P-018":
      return "simulator_seed";
    case "P-019":
      return "developer_only_symbol";
    case "P-001":
    case "P-002":
    case "P-003":
    case "P-004":
    case "P-005":
    case "P-006":
    case "P-007":
    case "P-008":
    case "P-009":
    case "P-010":
    case "P-011":
    case "P-020":
      return undefined;
  }
}

function requiresConfidence(provenanceClass: ProvenanceClassId): boolean {
  return provenanceClass === "P-003" || provenanceClass === "P-004" || provenanceClass === "P-010" || provenanceClass === "P-011";
}

function isForbiddenProvenance(provenanceClass: ProvenanceClassId): boolean {
  return allowedDestinationsForClass(provenanceClass).length === 0;
}

function scanForbiddenTruth(fields: readonly CandidateFirewallField[], blockedCategories: readonly ForbiddenFieldCategory[]): readonly ForbiddenTruthFinding[] {
  const findings: ForbiddenTruthFinding[] = [];
  for (const field of fields) {
    scanValue(field.value, field.field_path, field.field_name, blockedCategories, findings);
  }
  return freezeArray(findings);
}

function scanValue(
  value: unknown,
  path: string,
  key: string,
  blockedCategories: readonly ForbiddenFieldCategory[],
  findings: ForbiddenTruthFinding[],
): void {
  const keyCategory = classifyForbiddenKey(key);
  if (keyCategory !== undefined && blockedCategories.includes(keyCategory)) {
    findings.push(makeFinding(path, keyCategory, "critical", `blocked_key:${key}`));
  }
  if (typeof value === "string") {
    const valueCategory = classifyForbiddenStringValue(value);
    if (valueCategory !== undefined && blockedCategories.includes(valueCategory)) {
      findings.push(makeFinding(path, valueCategory, severityForCategory(valueCategory), `blocked_value:${value.slice(0, 80)}`));
    }
    return;
  }
  if (typeof value === "number") {
    if (STRICT_COORDINATE_KEY_PATTERN.test(key) && Number.isFinite(value) && blockedCategories.includes("exact_backend_pose")) {
      findings.push(makeFinding(path, "exact_backend_pose", "critical", `coordinate_like_number:${value}`));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValue(entry, `${path}[${index}]`, key, blockedCategories, findings));
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      scanValue(childValue, `${path}.${childKey}`, childKey, blockedCategories, findings);
    }
  }
}

function classifyForbiddenKey(key: string): ForbiddenFieldCategory | undefined {
  if (/object_id|object_ref|backend_object/.test(key) && INTERNAL_REF_KEY_PATTERN.test(key)) {
    return "backend_object_id";
  }
  if (/scene_graph|scene_path|node_path/.test(key)) {
    return "scene_graph_path";
  }
  if (STRICT_COORDINATE_KEY_PATTERN.test(key)) {
    return "exact_backend_pose";
  }
  if (/collision_mesh|mesh_id|hidden_mesh/.test(key)) {
    return "hidden_collision_mesh";
  }
  if (/qa_|ground_truth|success_flag/.test(key)) {
    return "qa_truth";
  }
  if (/benchmark|expected_answer/.test(key)) {
    return "benchmark_answer";
  }
  if (/simulator_seed|replay_seed|seed_u32/.test(key)) {
    return "simulator_seed";
  }
  if (/debug_overlay|segmentation_label|projected_objects/.test(key)) {
    return "debug_overlay";
  }
  if (/engine_handle|engine_ref|physics_handle/.test(key)) {
    return "engine_handle";
  }
  if (/implementation_file|code_symbol|developer_only/.test(key)) {
    return "developer_only_symbol";
  }
  return undefined;
}

function classifyForbiddenStringValue(value: string): ForbiddenFieldCategory | undefined {
  if (/(qa[-_ ]?truth|ground[-_ ]?truth|benchmark[-_ ]?expected|success[-_ ]?flag|failure[-_ ]?flag)/i.test(value)) {
    return "qa_truth";
  }
  if (/(simulation seed|simulator seed|replay seed)/i.test(value)) {
    return "simulator_seed";
  }
  if (/(scene graph|\/Scene\/|\/World\/|node path)/i.test(value)) {
    return "scene_graph_path";
  }
  if (/(collision mesh|mesh id|mesh_ref|collision_shape)/i.test(value)) {
    return "hidden_collision_mesh";
  }
  if (/(debug overlay|segmentation label|projected object)/i.test(value)) {
    return "debug_overlay";
  }
  if (/(engine handle|physics handle|backend ref)/i.test(value)) {
    return "engine_handle";
  }
  if (INTERNAL_REF_VALUE_PATTERN.test(value)) {
    return "backend_object_id";
  }
  return undefined;
}

function makeFinding(path: string, category: ForbiddenFieldCategory, severity: FirewallRiskLevel, evidence: string): ForbiddenTruthFinding {
  const findingId = `finding_${computeDeterminismHash({ path, category, severity, evidence }).slice(0, 16)}`;
  return Object.freeze({
    finding_id: findingId,
    field_path: path,
    contamination_type: category,
    severity,
    evidence,
    recommended_containment: category === "debug_overlay" ? "redact" : "reject",
  });
}

function severityForCategory(category: ForbiddenFieldCategory): FirewallRiskLevel {
  switch (category) {
    case "debug_overlay":
    case "developer_only_symbol":
      return "high";
    case "backend_object_id":
    case "scene_graph_path":
    case "exact_backend_pose":
    case "hidden_collision_mesh":
    case "qa_truth":
    case "benchmark_answer":
    case "simulator_seed":
    case "engine_handle":
    case "unknown":
      return "critical";
  }
}

function containmentForFinding(finding: ForbiddenTruthFinding): FirewallContainmentAction {
  if (finding.severity === "critical") {
    return "safe_hold";
  }
  return finding.recommended_containment;
}

function provenanceForPacket(packetKind: CognitiveSensorEvidence["packet_kind"], sensorClass: SensorClass): CognitiveSensorEvidence["provenance_class"] {
  if (packetKind === "camera" && sensorClass === "depth_camera") {
    return "P-003";
  }
  switch (packetKind) {
    case "camera":
      return "P-002";
    case "audio":
      return "P-004";
    case "proprioception":
      return "P-005";
    case "contact":
      return "P-006";
    case "imu":
      return "P-007";
    case "actuator_feedback":
      return "P-009";
  }
}

function allowedFieldPathsForPacket(packetKind: CognitiveSensorEvidence["packet_kind"]): readonly string[] {
  switch (packetKind) {
    case "camera":
      return freezeArray(["packet_ref", "image_ref", "camera_role", "timestamp_interval", "resolution_px", "declared_calibration_ref", "health_status", "confidence"]);
    case "audio":
      return freezeArray(["packet_ref", "event_candidates", "dominant_bearing_estimate", "intensity_estimate", "timestamp_interval", "health_status", "confidence"]);
    case "proprioception":
      return freezeArray(["packet_ref", "encoder_readings", "body_motion_estimate", "timestamp_interval", "health_status", "confidence"]);
    case "contact":
      return freezeArray(["packet_ref", "contact_readings", "unsafe_contact_count", "noisy_contact_count", "timestamp_interval", "health_status", "confidence"]);
    case "imu":
      return freezeArray(["packet_ref", "orientation_xyzw", "angular_velocity_rad_per_s", "linear_acceleration_m_per_s2", "timestamp_interval", "health_status", "confidence"]);
    case "actuator_feedback":
      return freezeArray(["packet_ref", "command_ref", "applied_status", "saturation_flags", "latency_ms", "prompt_safe_summary", "health_status", "confidence"]);
  }
}

function isSensorDestinationAllowed(
  sensor: VirtualSensorDescriptor,
  destination: CognitiveDestination,
  packetKind: CognitiveSensorEvidence["packet_kind"],
  allowSensorBusOnlyEvidenceInOopsLoop: boolean,
): boolean {
  if (sensor.cognitive_route === "blocked" || sensor.cognitive_route === "qa_only") {
    return false;
  }
  if (sensor.cognitive_route === "prompt_allowed") {
    return true;
  }
  if (sensor.cognitive_route === "sensor_bus_only") {
    return allowSensorBusOnlyEvidenceInOopsLoop && destination === "oops_loop_prompt" && (packetKind === "contact" || packetKind === "audio" || packetKind === "actuator_feedback");
  }
  return false;
}

function buildPromptAuditReport(
  packetId: Ref,
  destination: CognitiveDestination,
  issues: readonly ValidationIssue[],
  findings: readonly ForbiddenTruthFinding[],
  blockedPayloadRefs: readonly Ref[],
  transformedFields: readonly string[],
  riskLevel: FirewallRiskLevel,
  nextAction: FirewallNextAction,
): PromptAuditReport {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const auditId = `prompt_audit_${packetId}_${computeDeterminismHash({ issues, findings, blockedPayloadRefs, transformedFields }).slice(0, 12)}`;
  return Object.freeze({
    schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
    audit_report_id: auditId,
    policy_version: SENSOR_FIREWALL_POLICY_VERSION,
    cognitive_destination: destination,
    packet_id: packetId,
    passed: errorCount === 0 && findings.every((finding) => finding.severity !== "critical"),
    blocked_fields: freezeArray([...new Set([...blockedPayloadRefs, ...findings.map((finding) => finding.field_path)])].sort()),
    transformed_fields: freezeArray([...new Set(transformedFields)].sort()),
    forbidden_findings: freezeArray(findings),
    risk_level: riskLevel,
    issue_count: issues.length,
    issues: freezeArray(issues),
    next_action: nextAction,
    determinism_hash: computeDeterminismHash({ auditId, destination, packetId, issues, findings, blockedPayloadRefs, transformedFields, riskLevel, nextAction }),
  });
}

function computeRiskLevel(
  issues: readonly ValidationIssue[],
  findings: readonly ForbiddenTruthFinding[],
  recommendedAction: SensorBusRecommendedAction,
): FirewallRiskLevel {
  if (findings.some((finding) => finding.severity === "critical") || issues.some((issue) => issue.severity === "error") || recommendedAction === "safe_hold") {
    return "critical";
  }
  if (findings.some((finding) => finding.severity === "high") || recommendedAction === "human_review") {
    return "high";
  }
  if (issues.length > 0 || recommendedAction === "re_capture" || recommendedAction === "re_observe") {
    return "medium";
  }
  return "low";
}

function computeNextAction(
  riskLevel: FirewallRiskLevel,
  issues: readonly ValidationIssue[],
  recommendedAction: SensorBusRecommendedAction,
): FirewallNextAction {
  if (riskLevel === "critical" || recommendedAction === "safe_hold") {
    return "safe_hold";
  }
  if (riskLevel === "high" || recommendedAction === "human_review") {
    return "human_review";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "repair";
  }
  if (recommendedAction === "re_capture" || recommendedAction === "re_observe") {
    return "regenerate";
  }
  return "continue";
}

function computeDecisionKind(
  issues: readonly ValidationIssue[],
  findings: readonly ForbiddenTruthFinding[],
  transformedFields: readonly string[],
  allowDegradedObservationBundles: boolean,
): FirewallDecisionKind {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "quarantine";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "reject";
  }
  if (!allowDegradedObservationBundles && issues.length > 0) {
    return "reject";
  }
  if (transformedFields.length > 0 || findings.length > 0 || issues.length > 0) {
    return "allow_with_transform";
  }
  return "allow";
}

function dedupeCalibrationEvidence(values: readonly CognitiveCalibrationEvidence[]): readonly CognitiveCalibrationEvidence[] {
  const byRef = new Map<Ref, CognitiveCalibrationEvidence>();
  for (const value of values) {
    byRef.set(value.calibration_ref, value);
  }
  return freezeArray([...byRef.values()].sort((a, b) => a.calibration_ref.localeCompare(b.calibration_ref)));
}

function extractConfidence(value: unknown): number | undefined {
  if (isRecord(value) && typeof value.confidence === "number") {
    return value.confidence;
  }
  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeIssue(severity: ValidationSeverity, code: SensorFirewallIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const SENSOR_FIREWALL_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  sensor_bus_schema_version: SENSOR_BUS_SCHEMA_VERSION,
  sensor_firewall_schema_version: SENSOR_FIREWALL_ADAPTER_SCHEMA_VERSION,
  firewall_policy_version: SENSOR_FIREWALL_POLICY_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  firewall_blueprint: "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md",
  sections: freezeArray(["4.3", "4.13", "4.16", "4.17", "4.18", "2.5", "2.7", "2.8", "2.9", "2.14"]),
});
