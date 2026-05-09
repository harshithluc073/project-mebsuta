/**
 * Model version isolation layer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.7.1, 6.8.3, 6.13.3, 6.15, 6.16, 6.18, 6.19,
 * and 6.20.
 *
 * This module keeps Robotics-ER preview-model assumptions behind one stable
 * boundary. It validates model identifiers, capability profiles, request
 * requirements, token limits, unsupported capabilities, drift signals, and
 * migration gates before those assumptions can leak into routing, prompting,
 * memory, safety, or control code.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
  GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
  GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
} from "./gemini_robotics_er_adapter";
import type {
  CapabilityValidationReport,
  CognitiveInvocationClass,
  CognitiveTelemetryEvent,
  CognitiveTelemetryEventType,
  ModelCapabilityProfile,
  ModelIsolationReport,
} from "./gemini_robotics_er_adapter";

export const MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION = "mebsuta.model_version_isolation_layer.v1" as const;
export const MODEL_VERSION_ISOLATION_PROFILE_VERSION = "1.0.0" as const;

const MIN_SCHEMA_SUCCESS_RATE = 0.985;
const MIN_SAFETY_ACCEPTANCE_RATE = 0.995;
const MAX_HALLUCINATION_RATE = 0.01;
const MAX_REPAIR_RATE = 0.08;
const MAX_SAFE_HOLD_DELTA = 0.03;
const MAX_LATENCY_RATIO = 1.25;
const MAX_DRIFT_SCORE_FOR_NONCRITICAL = 0.32;
const MAX_DRIFT_SCORE_FOR_LIVE_LIKE = 0.16;
const DEFAULT_BASELINE_P95_MS = 9000;
const DEFAULT_BASELINE_SCHEMA_RATE = 0.992;
const DEFAULT_BASELINE_REPAIR_RATE = 0.04;

export type IsolationDecision = "approved" | "approved_with_warnings" | "rejected";
export type CapabilityName =
  | "structured_outputs"
  | "thinking"
  | "batch_api"
  | "caching"
  | "live_api"
  | "audio_generation"
  | "image_generation"
  | "function_calling"
  | "code_execution"
  | "computer_use"
  | "input:text"
  | "input:image"
  | "input:video"
  | "input:audio"
  | "output:text";
export type DeploymentLane = "offline_regression" | "noncritical_simulation" | "live_like_simulation" | "motion_critical";
export type DriftSeverity = "none" | "watch" | "blocking";
export type MigrationDecision = "promote" | "promote_behind_flag" | "hold_for_review" | "reject";
export type StableContractSurface =
  | "model_identity"
  | "token_limits"
  | "input_modalities"
  | "output_modalities"
  | "structured_output"
  | "thinking_budget"
  | "batch_usage"
  | "caching"
  | "unsupported_capabilities"
  | "response_quarantine"
  | "deterministic_validation";

export interface AdapterCapabilityProfile {
  readonly profile_ref: Ref;
  readonly profile_version: typeof MODEL_VERSION_ISOLATION_PROFILE_VERSION | string;
  readonly model_identifier: string;
  readonly status: "preview" | "stable" | "deprecated" | "blocked";
  readonly input_modalities: readonly ("text" | "image" | "video" | "audio")[];
  readonly output_modalities: readonly "text"[];
  readonly input_token_limit: number;
  readonly output_token_limit: number;
  readonly structured_outputs: boolean;
  readonly thinking: boolean;
  readonly batch_api: boolean;
  readonly caching: boolean;
  readonly live_api: boolean;
  readonly audio_generation: boolean;
  readonly image_generation: boolean;
  readonly approved_for_lanes: readonly DeploymentLane[];
  readonly unsupported_capabilities: readonly CapabilityName[];
  readonly created_at_ms: number;
  readonly source_ref: Ref;
}

export interface StableCognitiveContractBinding {
  readonly binding_ref: Ref;
  readonly surface: StableContractSurface;
  readonly stable_contract_ref: Ref;
  readonly model_specific_source: Ref;
  readonly isolated_value: unknown;
  readonly owning_component: string;
  readonly mutable_without_migration: boolean;
}

export interface ModelVersionIsolationDecisionReport {
  readonly schema_version: typeof MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION;
  readonly decision: IsolationDecision;
  readonly requested_model_identifier: string;
  readonly active_profile: AdapterCapabilityProfile;
  readonly stable_bindings: readonly StableCognitiveContractBinding[];
  readonly required_capabilities: readonly CapabilityName[];
  readonly missing_capabilities: readonly CapabilityName[];
  readonly blocked_capabilities: readonly CapabilityName[];
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_events: readonly CognitiveTelemetryEvent[];
  readonly determinism_hash: string;
}

export interface InvocationIsolationRequest {
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly model_identifier?: string;
  readonly required_capabilities?: readonly CapabilityName[];
  readonly deployment_lane: DeploymentLane;
  readonly expected_input_tokens?: number;
  readonly expected_output_tokens?: number;
  readonly uses_batch?: boolean;
  readonly uses_cached_context?: boolean;
}

export interface IsolatedInvocationProfile {
  readonly schema_version: typeof MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION;
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly decision: IsolationDecision;
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_token_limit: typeof GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT;
  readonly output_token_limit: typeof GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT;
  readonly allowed_input_modalities: readonly ("text" | "image" | "video" | "audio")[];
  readonly allowed_output_modalities: readonly "text"[];
  readonly structured_outputs_required: true;
  readonly thinking_supported: true;
  readonly batch_allowed: boolean;
  readonly caching_allowed: boolean;
  readonly quarantine_required: true;
  readonly deterministic_validation_required: true;
  readonly stable_bindings: readonly StableCognitiveContractBinding[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ModelBehaviorMetrics {
  readonly model_identifier: string;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly sample_count: number;
  readonly schema_success_rate: number;
  readonly safety_acceptance_rate: number;
  readonly hallucination_rate: number;
  readonly repair_rate: number;
  readonly safe_hold_rate: number;
  readonly average_latency_ms: number;
  readonly p95_latency_ms: number;
  readonly timeout_rate: number;
}

export interface ModelBehaviorBaseline {
  readonly baseline_ref: Ref;
  readonly model_identifier: string;
  readonly schema_success_rate: number;
  readonly repair_rate: number;
  readonly safe_hold_rate: number;
  readonly p95_latency_ms: number;
}

export interface ModelVersionDriftReport {
  readonly schema_version: typeof MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION;
  readonly drift_ref: Ref;
  readonly model_identifier: string;
  readonly severity: DriftSeverity;
  readonly drift_score: number;
  readonly schema_delta: number;
  readonly repair_delta: number;
  readonly safe_hold_delta: number;
  readonly latency_ratio: number;
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_event: CognitiveTelemetryEvent;
  readonly determinism_hash: string;
}

export interface ModelMigrationEvaluationRequest {
  readonly migration_ref: Ref;
  readonly candidate_profile: AdapterCapabilityProfile;
  readonly regression_metrics: ModelBehaviorMetrics;
  readonly benchmark_metrics: ModelBehaviorMetrics;
  readonly closed_loop_metrics: ModelBehaviorMetrics;
  readonly baseline?: ModelBehaviorBaseline;
  readonly target_lane: DeploymentLane;
  readonly safety_review_complete: boolean;
  readonly ethics_review_complete: boolean;
  readonly feature_flag_ref?: Ref;
}

export interface ModelMigrationEvaluationReport {
  readonly schema_version: typeof MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION;
  readonly migration_ref: Ref;
  readonly decision: MigrationDecision;
  readonly candidate_model_identifier: string;
  readonly capability_report: CapabilityValidationReport;
  readonly regression_drift: ModelVersionDriftReport;
  readonly benchmark_drift: ModelVersionDriftReport;
  readonly closed_loop_drift: ModelVersionDriftReport;
  readonly required_exit_gates: readonly string[];
  readonly satisfied_exit_gates: readonly string[];
  readonly failed_exit_gates: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Isolates Robotics-ER model-version assumptions and returns stable contracts
 * for the rest of the cognitive stack. The service is deterministic so router,
 * budget, prompt, quarantine, telemetry, and regression code can all reason
 * from the same profile snapshot.
 */
export class ModelVersionIsolationLayer {
  private readonly activeProfile: AdapterCapabilityProfile;
  private readonly baseline: ModelBehaviorBaseline;
  private readonly nowMs: () => number;

  public constructor(
    activeProfile: AdapterCapabilityProfile = createApprovedAdapterProfile(),
    baseline: ModelBehaviorBaseline = createDefaultBaseline(),
    nowMs: () => number = () => Date.now(),
  ) {
    this.activeProfile = freezeProfile(activeProfile);
    this.baseline = Object.freeze({ ...baseline });
    this.nowMs = nowMs;
  }

  /**
   * Validates that the requested model can be bound to Project Mebsuta's stable
   * cognitive contracts. Unsupported profile changes become explicit issues
   * instead of leaking into downstream components.
   */
  public isolateModelVersion(
    modelIdentifier: string = GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    requiredCapabilities: readonly CapabilityName[] = DEFAULT_REQUIRED_CAPABILITIES,
  ): ModelVersionIsolationDecisionReport {
    const issues = [
      ...validateProfileShape(this.activeProfile),
      ...validateModelIdentifier(modelIdentifier, this.activeProfile),
    ];
    const capabilityReport = this.validateModelCapabilityProfile(modelIdentifier, requiredCapabilities);
    issues.push(...capabilityReport.issues);
    if (this.activeProfile.status === "preview") {
      issues.push(issue("warning", "PreviewProfileRequiresGuardrails", "$.profile.status", "The active Robotics-ER profile is preview and requires quarantine, telemetry, and regression gates.", "Keep response quarantine and prompt regression active for every cognitive route."));
    }
    const stableBindings = buildStableBindings(this.activeProfile);
    const telemetry = [
      makeTelemetry(
        "ModelVersionDriftSignal",
        modelIdentifier,
        undefined,
        issues.some((item) => item.severity === "error") ? "error" : "warning",
        `Model version isolation checked ${modelIdentifier}.`,
        this.nowMs(),
      ),
    ];
    const decision = decideIsolation(issues);
    const base = {
      schema_version: MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION,
      decision,
      requested_model_identifier: modelIdentifier,
      active_profile: this.activeProfile,
      stable_bindings: stableBindings,
      required_capabilities: freezeArray(requiredCapabilities),
      missing_capabilities: freezeArray(capabilityReport.missing_capabilities as readonly CapabilityName[]),
      blocked_capabilities: freezeArray(capabilityReport.constrained_capabilities as readonly CapabilityName[]),
      issues: freezeArray(issues),
      telemetry_events: freezeArray(telemetry),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Creates an invocation-scoped profile that downstream code can consume
   * without needing to know preview-model details or platform caveats.
   */
  public isolateInvocation(request: InvocationIsolationRequest): IsolatedInvocationProfile {
    const required = request.required_capabilities ?? requiredCapabilitiesForInvocation(request);
    const isolation = this.isolateModelVersion(request.model_identifier ?? GEMINI_ROBOTICS_ER_APPROVED_MODEL, required);
    const issues = [...isolation.issues, ...validateInvocationIsolationRequest(request, this.activeProfile)];
    const decision = decideIsolation(issues);
    const base = {
      schema_version: MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION,
      request_ref: request.request_ref,
      invocation_class: request.invocation_class,
      decision,
      model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      input_token_limit: GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT as typeof GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
      output_token_limit: GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT as typeof GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
      allowed_input_modalities: freezeArray(["text", "image", "video", "audio"] as const),
      allowed_output_modalities: freezeArray(["text"] as const),
      structured_outputs_required: true as const,
      thinking_supported: true as const,
      batch_allowed: request.deployment_lane === "offline_regression" && this.activeProfile.batch_api,
      caching_allowed: request.uses_cached_context === true && this.activeProfile.caching,
      quarantine_required: true as const,
      deterministic_validation_required: true as const,
      stable_bindings: isolation.stable_bindings,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates model capabilities using the architecture vocabulary. Positive
   * capabilities must exist; blocked capabilities such as live API and audio
   * generation are reported as constrained assumptions.
   */
  public validateModelCapabilityProfile(modelIdentifier: string, requiredCapabilities: readonly CapabilityName[]): CapabilityValidationReport {
    const issues: ValidationIssue[] = [];
    if (modelIdentifier !== this.activeProfile.model_identifier) {
      issues.push(issue("error", "ModelIdentifierRejected", "$.model_identifier", "Requested model is not the active approved Robotics-ER profile.", "Use gemini-robotics-er-1.6-preview or complete a model migration review."));
    }
    const missing = requiredCapabilities.filter((capability) => capabilityAvailable(this.activeProfile, capability) === false);
    for (const capability of missing) {
      issues.push(issue("error", "ModelCapabilityMissing", "$.required_capabilities", `Capability ${capability} is unavailable on the active profile.`, "Remove the assumption or route through a deterministic subsystem."));
    }
    const constrained = requiredCapabilities.filter((capability) => isBlockedCapability(capability) || this.activeProfile.unsupported_capabilities.includes(capability));
    for (const capability of constrained) {
      issues.push(issue("error", "UnsupportedCapabilityAssumption", "$.required_capabilities", `Capability ${capability} is blocked by the cognitive-layer architecture.`, "Do not route this behavior through Robotics-ER."));
    }
    if (this.activeProfile.status === "preview") {
      issues.push(issue("warning", "PreviewProfileRequiresGuardrails", "$.profile.status", "Preview model use requires regression, telemetry, and response quarantine.", "Keep guardrails enabled for all routes."));
    }
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      model_identifier: modelIdentifier,
      approved: issues.every((item) => item.severity !== "error"),
      missing_capabilities: freezeArray(missing),
      constrained_capabilities: freezeArray(constrained),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Produces the adapter-compatible isolation report while using the richer
   * model-version boundary checks in this module.
   */
  public toAdapterIsolationReport(modelIdentifier: string = GEMINI_ROBOTICS_ER_APPROVED_MODEL): ModelIsolationReport {
    const isolation = this.isolateModelVersion(modelIdentifier, DEFAULT_REQUIRED_CAPABILITIES);
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      model_identifier: modelIdentifier,
      approved: isolation.decision !== "rejected",
      profile: toAdapterProfile(this.activeProfile),
      issues: isolation.issues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Scores behavior drift against the active baseline. The formula deliberately
   * weights schema reliability and safety more heavily than latency so preview
   * behavior changes are caught before they reach live-like simulation.
   */
  public detectModelVersionDrift(metrics: ModelBehaviorMetrics, baseline: ModelBehaviorBaseline = this.baseline): ModelVersionDriftReport {
    const issues: ValidationIssue[] = [];
    issues.push(...validateMetrics(metrics));
    const schemaDelta = Math.max(0, baseline.schema_success_rate - metrics.schema_success_rate);
    const repairDelta = Math.max(0, metrics.repair_rate - baseline.repair_rate);
    const safeHoldDelta = Math.max(0, metrics.safe_hold_rate - baseline.safe_hold_rate);
    const latencyRatio = metrics.p95_latency_ms / Math.max(1, baseline.p95_latency_ms);
    const latencyPressure = Math.max(0, latencyRatio - 1);
    const hallucinationPressure = Math.max(0, metrics.hallucination_rate - MAX_HALLUCINATION_RATE);
    const safetyPressure = Math.max(0, MIN_SAFETY_ACCEPTANCE_RATE - metrics.safety_acceptance_rate);
    const driftScore = round3(
      schemaDelta * 3.5
      + repairDelta * 1.7
      + safeHoldDelta * 1.4
      + latencyPressure * 0.8
      + hallucinationPressure * 5
      + safetyPressure * 4,
    );
    if (metrics.schema_success_rate < MIN_SCHEMA_SUCCESS_RATE) {
      issues.push(issue("error", "SchemaReliabilityRegression", "$.schema_success_rate", "Schema reliability is below the safety-critical threshold.", "Block live-like use and run prompt regression."));
    }
    if (metrics.safety_acceptance_rate < MIN_SAFETY_ACCEPTANCE_RATE) {
      issues.push(issue("error", "SafetyAcceptanceRegression", "$.safety_acceptance_rate", "Safety acceptance rate is below migration threshold.", "Review safety proposals and deterministic validator rejects."));
    }
    if (metrics.hallucination_rate > MAX_HALLUCINATION_RATE) {
      issues.push(issue("error", "HallucinationRateRegression", "$.hallucination_rate", "Hallucination rate exceeds the preview-model threshold.", "Block promotion and inspect evidence grounding prompts."));
    }
    if (metrics.repair_rate > MAX_REPAIR_RATE) {
      issues.push(issue("warning", "RepairRateElevated", "$.repair_rate", "Response repair rate indicates schema drift or prompt weakness.", "Review contract prompts and response quarantine telemetry."));
    }
    if (latencyRatio > MAX_LATENCY_RATIO) {
      issues.push(issue("warning", "LatencyRegression", "$.p95_latency_ms", "P95 latency exceeds the accepted preview-model ratio.", "Mitigate with budget changes or hold migration."));
    }
    const severity = decideDriftSeverity(driftScore, issues);
    const event = makeTelemetry(
      "ModelVersionDriftSignal",
      metrics.model_identifier,
      undefined,
      severity === "blocking" ? "error" : severity === "watch" ? "warning" : "info",
      `Model drift score ${driftScore} for ${metrics.model_identifier}.`,
      this.nowMs(),
    );
    const base = {
      schema_version: MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION,
      drift_ref: makeRef("model_drift", metrics.model_identifier, metrics.invocation_class ?? "all", String(metrics.sample_count)),
      model_identifier: metrics.model_identifier,
      severity,
      drift_score: driftScore,
      schema_delta: round3(schemaDelta),
      repair_delta: round3(repairDelta),
      safe_hold_delta: round3(safeHoldDelta),
      latency_ratio: round3(latencyRatio),
      issues: freezeArray(issues),
      telemetry_event: event,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates a candidate model profile against the documented migration
   * procedure: profile review, offline regression, multi-view benchmarks,
   * closed-loop simulation, latency comparison, safety and ethics review, and
   * feature-flag readiness.
   */
  public evaluateMigrationCandidate(request: ModelMigrationEvaluationRequest): ModelMigrationEvaluationReport {
    const issues: ValidationIssue[] = [];
    issues.push(...validateProfileShape(request.candidate_profile));
    const capabilityReport = this.validateCandidateCapabilities(request.candidate_profile);
    issues.push(...capabilityReport.issues);
    const baseline = request.baseline ?? this.baseline;
    const regressionDrift = this.detectModelVersionDrift(request.regression_metrics, baseline);
    const benchmarkDrift = this.detectModelVersionDrift(request.benchmark_metrics, baseline);
    const closedLoopDrift = this.detectModelVersionDrift(request.closed_loop_metrics, baseline);
    issues.push(...regressionDrift.issues, ...benchmarkDrift.issues, ...closedLoopDrift.issues);
    if (request.safety_review_complete !== true) {
      issues.push(issue("error", "SafetyReviewMissing", "$.safety_review_complete", "Safety review is required before model promotion.", "Complete safety review and update guardrails."));
    }
    if (request.ethics_review_complete !== true) {
      issues.push(issue("error", "EthicsReviewMissing", "$.ethics_review_complete", "Legal and ethics review is required before model promotion.", "Complete review for new model capabilities."));
    }
    if ((request.target_lane === "noncritical_simulation" || request.target_lane === "live_like_simulation") && request.feature_flag_ref === undefined) {
      issues.push(issue("error", "FeatureFlagMissing", "$.feature_flag_ref", "Promotion beyond offline regression requires a feature flag.", "Create a feature flag for staged rollout."));
    }
    const gates = requiredMigrationGates(request.target_lane);
    const satisfied = satisfiedMigrationGates(request, capabilityReport, regressionDrift, benchmarkDrift, closedLoopDrift);
    const failed = gates.filter((gate) => satisfied.includes(gate) === false);
    const decision = decideMigration(request.target_lane, issues, regressionDrift, benchmarkDrift, closedLoopDrift, failed);
    const base = {
      schema_version: MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION,
      migration_ref: request.migration_ref,
      decision,
      candidate_model_identifier: request.candidate_profile.model_identifier,
      capability_report: capabilityReport,
      regression_drift: regressionDrift,
      benchmark_drift: benchmarkDrift,
      closed_loop_drift: closedLoopDrift,
      required_exit_gates: freezeArray(gates),
      satisfied_exit_gates: freezeArray(satisfied),
      failed_exit_gates: freezeArray(failed),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private validateCandidateCapabilities(candidate: AdapterCapabilityProfile): CapabilityValidationReport {
    const issues = validateProfileShape(candidate);
    const required = DEFAULT_REQUIRED_CAPABILITIES;
    const missing = required.filter((capability) => capabilityAvailable(candidate, capability) === false);
    for (const capability of missing) {
      issues.push(issue("error", "CandidateCapabilityMissing", "$.candidate_profile", `Candidate lacks required capability ${capability}.`, "Do not migrate until capability is supported or the architecture is revised."));
    }
    const constrained = candidate.unsupported_capabilities.filter((capability) => required.includes(capability));
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      model_identifier: candidate.model_identifier,
      approved: issues.every((item) => item.severity !== "error"),
      missing_capabilities: freezeArray(missing),
      constrained_capabilities: freezeArray(constrained),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function createApprovedAdapterProfile(createdAtMs = 0): AdapterCapabilityProfile {
  return Object.freeze({
    profile_ref: "model_profile:gemini_robotics_er_1_6_preview",
    profile_version: MODEL_VERSION_ISOLATION_PROFILE_VERSION,
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    status: "preview",
    input_modalities: freezeArray(["text", "image", "video", "audio"] as const),
    output_modalities: freezeArray(["text"] as const),
    input_token_limit: GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
    output_token_limit: GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
    structured_outputs: true,
    thinking: true,
    batch_api: true,
    caching: true,
    live_api: false,
    audio_generation: false,
    image_generation: false,
    approved_for_lanes: freezeArray(["offline_regression", "noncritical_simulation", "live_like_simulation", "motion_critical"] as const),
    unsupported_capabilities: freezeArray(["live_api", "audio_generation", "image_generation", "function_calling", "code_execution", "computer_use"] as const),
    created_at_ms: createdAtMs,
    source_ref: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md#6.8.3",
  });
}

function createDefaultBaseline(): ModelBehaviorBaseline {
  return Object.freeze({
    baseline_ref: "model_baseline:gemini_robotics_er_1_6_preview",
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    schema_success_rate: DEFAULT_BASELINE_SCHEMA_RATE,
    repair_rate: DEFAULT_BASELINE_REPAIR_RATE,
    safe_hold_rate: 0.05,
    p95_latency_ms: DEFAULT_BASELINE_P95_MS,
  });
}

function buildStableBindings(profile: AdapterCapabilityProfile): readonly StableCognitiveContractBinding[] {
  const rows: readonly [StableContractSurface, Ref, unknown, string, boolean][] = [
    ["model_identity", "stable.model_identifier", profile.model_identifier, "GeminiRoboticsERAdapter", false],
    ["token_limits", "stable.token_limits", { input_token_limit: profile.input_token_limit, output_token_limit: profile.output_token_limit }, "ContextBudgetManager", false],
    ["input_modalities", "stable.input_modalities", profile.input_modalities, "PromptPacketAssembler", false],
    ["output_modalities", "stable.output_modalities", profile.output_modalities, "StructuredOutputContractRegistry", false],
    ["structured_output", "stable.structured_outputs", profile.structured_outputs, "ResponseQuarantineService", false],
    ["thinking_budget", "stable.thinking", profile.thinking, "ThinkingBudgetPolicyManager", false],
    ["batch_usage", "stable.batch_api", profile.batch_api, "PromptRegressionHarness", true],
    ["caching", "stable.caching", profile.caching, "PromptPacketAssembler", true],
    ["unsupported_capabilities", "stable.unsupported_capabilities", profile.unsupported_capabilities, "CognitiveRequestRouter", false],
    ["response_quarantine", "stable.response_quarantine", true, "ResponseQuarantineService", false],
    ["deterministic_validation", "stable.deterministic_validation", true, "ValidatorStack", false],
  ];
  return freezeArray(rows.map(([surface, stableRef, isolatedValue, owner, mutable]) => Object.freeze({
    binding_ref: makeRef("binding", surface, profile.model_identifier),
    surface,
    stable_contract_ref: stableRef,
    model_specific_source: profile.profile_ref,
    isolated_value: isolatedValue,
    owning_component: owner,
    mutable_without_migration: mutable,
  })));
}

function requiredCapabilitiesForInvocation(request: InvocationIsolationRequest): readonly CapabilityName[] {
  const capabilities: CapabilityName[] = ["structured_outputs", "thinking", "output:text", "input:text"];
  if (request.invocation_class === "SceneObservationReasoning"
    || request.invocation_class === "MultiViewDisambiguationReasoning"
    || request.invocation_class === "SpatialVerificationReasoning"
    || request.invocation_class === "WaypointGenerationReasoning"
    || request.invocation_class === "TaskPlanningReasoning"
    || request.invocation_class === "OopsCorrectionReasoning"
    || request.invocation_class === "ToolUseReasoning") {
    capabilities.push("input:image");
  }
  if (request.invocation_class === "MultiViewDisambiguationReasoning" || request.invocation_class === "OopsCorrectionReasoning") {
    capabilities.push("input:video");
  }
  if (request.invocation_class === "AudioEventReasoning" || request.invocation_class === "OopsCorrectionReasoning") {
    capabilities.push("input:audio");
  }
  if (request.deployment_lane === "offline_regression" || request.uses_batch === true) {
    capabilities.push("batch_api");
  }
  if (request.uses_cached_context === true) {
    capabilities.push("caching");
  }
  return freezeArray(uniqueCapabilities(capabilities));
}

function validateInvocationIsolationRequest(request: InvocationIsolationRequest, profile: AdapterCapabilityProfile): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (request.request_ref.trim().length === 0) {
    issues.push(issue("error", "RequestRefMissing", "$.request_ref", "Invocation isolation requires a stable request reference.", "Provide an orchestrator request ref."));
  }
  if (profile.approved_for_lanes.includes(request.deployment_lane) === false) {
    issues.push(issue("error", "DeploymentLaneNotApproved", "$.deployment_lane", `Profile is not approved for ${request.deployment_lane}.`, "Use an approved lane or complete migration review."));
  }
  if (request.deployment_lane !== "offline_regression" && request.uses_batch === true) {
    issues.push(issue("error", "BatchUsedInRuntimeLane", "$.uses_batch", "Batch API is reserved for offline regression and benchmarks.", "Use discrete request/response invocation for runtime lanes."));
  }
  if ((request.expected_input_tokens ?? 0) > profile.input_token_limit) {
    issues.push(issue("error", "ExpectedInputExceedsProfileLimit", "$.expected_input_tokens", "Expected input tokens exceed isolated model profile limit.", "Compact context before model invocation."));
  }
  if ((request.expected_output_tokens ?? 0) > profile.output_token_limit) {
    issues.push(issue("error", "ExpectedOutputExceedsProfileLimit", "$.expected_output_tokens", "Expected output tokens exceed isolated model profile limit.", "Reduce output contract or max output tokens."));
  }
  if (request.deployment_lane === "motion_critical" && (request.invocation_class === "MemoryAssimilationReasoning" || request.invocation_class === "InternalMonologueReasoning")) {
    issues.push(issue("warning", "NoncriticalInvocationInMotionLane", "$.invocation_class", "Memory and monologue requests should usually yield to motion-critical work.", "Defer noncritical requests when motion timing is constrained."));
  }
  return freezeArray(issues);
}

function validateProfileShape(profile: AdapterCapabilityProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (profile.profile_ref.trim().length === 0) {
    issues.push(issue("error", "ProfileRefMissing", "$.profile_ref", "Model capability profile needs a stable reference.", "Create a deterministic profile ref."));
  }
  if (profile.model_identifier.trim().length === 0) {
    issues.push(issue("error", "ProfileModelMissing", "$.model_identifier", "Model capability profile needs a model identifier.", "Set the approved model identifier."));
  }
  if (profile.input_token_limit <= 0 || Number.isFinite(profile.input_token_limit) === false) {
    issues.push(issue("error", "InputTokenLimitInvalid", "$.input_token_limit", "Input token limit must be finite and positive.", "Use the official profile token limit."));
  }
  if (profile.output_token_limit <= 0 || Number.isFinite(profile.output_token_limit) === false) {
    issues.push(issue("error", "OutputTokenLimitInvalid", "$.output_token_limit", "Output token limit must be finite and positive.", "Use the official profile output limit."));
  }
  if (profile.structured_outputs !== true) {
    issues.push(issue("error", "StructuredOutputsRequired", "$.structured_outputs", "Structured outputs are required for Project Mebsuta cognitive safety.", "Do not use this model profile for cognitive routes."));
  }
  if (profile.output_modalities.includes("text") === false) {
    issues.push(issue("error", "TextOutputRequired", "$.output_modalities", "Text output is required for structured plans and monologues.", "Use a text-output model profile."));
  }
  if (profile.live_api || profile.audio_generation || profile.image_generation) {
    issues.push(issue("warning", "UnsupportedCapabilityPresent", "$.unsupported_capabilities", "Profile exposes capabilities this architecture blocks for cognitive routes.", "Keep blocked capabilities in router and isolation policy."));
  }
  return issues;
}

function validateModelIdentifier(modelIdentifier: string, profile: AdapterCapabilityProfile): readonly ValidationIssue[] {
  if (modelIdentifier === profile.model_identifier && modelIdentifier === GEMINI_ROBOTICS_ER_APPROVED_MODEL) {
    return freezeArray([]);
  }
  return freezeArray([
    issue("error", "ModelIdentifierRejected", "$.model_identifier", "Only the approved Robotics-ER profile may enter production-like cognitive routes.", "Run the migration procedure before using a new model identifier."),
  ]);
}

function capabilityAvailable(profile: AdapterCapabilityProfile, capability: CapabilityName): boolean {
  if (capability === "structured_outputs") {
    return profile.structured_outputs;
  }
  if (capability === "thinking") {
    return profile.thinking;
  }
  if (capability === "batch_api") {
    return profile.batch_api;
  }
  if (capability === "caching") {
    return profile.caching;
  }
  if (capability === "live_api") {
    return profile.live_api;
  }
  if (capability === "audio_generation") {
    return profile.audio_generation;
  }
  if (capability === "image_generation") {
    return profile.image_generation;
  }
  if (capability === "function_calling" || capability === "code_execution" || capability === "computer_use") {
    return false;
  }
  if (capability.startsWith("input:")) {
    return profile.input_modalities.includes(capability.slice("input:".length) as AdapterCapabilityProfile["input_modalities"][number]);
  }
  if (capability.startsWith("output:")) {
    return profile.output_modalities.includes(capability.slice("output:".length) as "text");
  }
  return false;
}

function isBlockedCapability(capability: CapabilityName): boolean {
  return capability === "live_api"
    || capability === "audio_generation"
    || capability === "image_generation"
    || capability === "function_calling"
    || capability === "code_execution"
    || capability === "computer_use";
}

function validateMetrics(metrics: ModelBehaviorMetrics): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ratios: readonly [keyof ModelBehaviorMetrics, number][] = [
    ["schema_success_rate", metrics.schema_success_rate],
    ["safety_acceptance_rate", metrics.safety_acceptance_rate],
    ["hallucination_rate", metrics.hallucination_rate],
    ["repair_rate", metrics.repair_rate],
    ["safe_hold_rate", metrics.safe_hold_rate],
    ["timeout_rate", metrics.timeout_rate],
  ];
  if (metrics.sample_count < 1 || Number.isFinite(metrics.sample_count) === false) {
    issues.push(issue("error", "MetricSampleCountInvalid", "$.sample_count", "Metric sample count must be finite and positive.", "Collect regression samples before evaluating model drift."));
  }
  for (const [field, value] of ratios) {
    if (value < 0 || value > 1 || Number.isFinite(value) === false) {
      issues.push(issue("error", "MetricRatioInvalid", `$.${String(field)}`, "Metric ratios must be finite values in 0..1.", "Normalize metrics before drift scoring."));
    }
  }
  if (metrics.average_latency_ms < 0 || metrics.p95_latency_ms < 0 || Number.isFinite(metrics.average_latency_ms) === false || Number.isFinite(metrics.p95_latency_ms) === false) {
    issues.push(issue("error", "LatencyMetricInvalid", "$.latency_ms", "Latency metrics must be finite non-negative milliseconds.", "Measure adapter latency before drift scoring."));
  }
  return freezeArray(issues);
}

function decideIsolation(issues: readonly ValidationIssue[]): IsolationDecision {
  if (issues.some((item) => item.severity === "error")) {
    return "rejected";
  }
  if (issues.some((item) => item.severity === "warning")) {
    return "approved_with_warnings";
  }
  return "approved";
}

function decideDriftSeverity(driftScore: number, issues: readonly ValidationIssue[]): DriftSeverity {
  if (issues.some((item) => item.severity === "error") || driftScore > MAX_DRIFT_SCORE_FOR_NONCRITICAL) {
    return "blocking";
  }
  if (issues.some((item) => item.severity === "warning") || driftScore > MAX_DRIFT_SCORE_FOR_LIVE_LIKE) {
    return "watch";
  }
  return "none";
}

function requiredMigrationGates(targetLane: DeploymentLane): readonly string[] {
  const common = [
    "capability_profile_reviewed",
    "offline_prompt_regression_clean",
    "multi_view_benchmark_acceptable",
    "latency_slo_accepted",
    "safety_review_complete",
    "ethics_review_complete",
  ];
  if (targetLane === "offline_regression") {
    return freezeArray(common.slice(0, 2));
  }
  if (targetLane === "noncritical_simulation") {
    return freezeArray([...common, "feature_flag_ready"]);
  }
  return freezeArray([...common, "closed_loop_safe_hold_validated", "feature_flag_ready"]);
}

function satisfiedMigrationGates(
  request: ModelMigrationEvaluationRequest,
  capabilityReport: CapabilityValidationReport,
  regressionDrift: ModelVersionDriftReport,
  benchmarkDrift: ModelVersionDriftReport,
  closedLoopDrift: ModelVersionDriftReport,
): readonly string[] {
  const satisfied: string[] = [];
  if (capabilityReport.approved) {
    satisfied.push("capability_profile_reviewed");
  }
  if (regressionDrift.severity !== "blocking") {
    satisfied.push("offline_prompt_regression_clean");
  }
  if (benchmarkDrift.severity !== "blocking") {
    satisfied.push("multi_view_benchmark_acceptable");
  }
  if (regressionDrift.latency_ratio <= MAX_LATENCY_RATIO && benchmarkDrift.latency_ratio <= MAX_LATENCY_RATIO && closedLoopDrift.latency_ratio <= MAX_LATENCY_RATIO) {
    satisfied.push("latency_slo_accepted");
  }
  if (request.safety_review_complete) {
    satisfied.push("safety_review_complete");
  }
  if (request.ethics_review_complete) {
    satisfied.push("ethics_review_complete");
  }
  if (closedLoopDrift.severity !== "blocking" && closedLoopDrift.safe_hold_delta <= MAX_SAFE_HOLD_DELTA) {
    satisfied.push("closed_loop_safe_hold_validated");
  }
  if (request.feature_flag_ref !== undefined && request.feature_flag_ref.trim().length > 0) {
    satisfied.push("feature_flag_ready");
  }
  return freezeArray(satisfied);
}

function decideMigration(
  lane: DeploymentLane,
  issues: readonly ValidationIssue[],
  regressionDrift: ModelVersionDriftReport,
  benchmarkDrift: ModelVersionDriftReport,
  closedLoopDrift: ModelVersionDriftReport,
  failedGates: readonly string[],
): MigrationDecision {
  if (issues.some((item) => item.severity === "error") || failedGates.length > 0) {
    return lane === "motion_critical" || closedLoopDrift.severity === "blocking" ? "reject" : "hold_for_review";
  }
  if (regressionDrift.severity === "watch" || benchmarkDrift.severity === "watch" || closedLoopDrift.severity === "watch") {
    return "promote_behind_flag";
  }
  return lane === "offline_regression" ? "promote" : "promote_behind_flag";
}

function toAdapterProfile(profile: AdapterCapabilityProfile): ModelCapabilityProfile {
  return Object.freeze({
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    status: "preview",
    input_modalities: freezeArray(profile.input_modalities),
    output_modalities: freezeArray(["text"] as const),
    input_token_limit: GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
    output_token_limit: GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
    structured_outputs: true,
    thinking: true,
    batch_api: true,
    caching: true,
    live_api: false,
    audio_generation: false,
    image_generation: false,
  });
}

function freezeProfile(profile: AdapterCapabilityProfile): AdapterCapabilityProfile {
  return Object.freeze({
    ...profile,
    input_modalities: freezeArray(profile.input_modalities),
    output_modalities: freezeArray(profile.output_modalities),
    approved_for_lanes: freezeArray(profile.approved_for_lanes),
    unsupported_capabilities: freezeArray(profile.unsupported_capabilities),
  });
}

function uniqueCapabilities(items: readonly CapabilityName[]): readonly CapabilityName[] {
  return freezeArray([...new Set(items)]);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeTelemetry(
  eventType: CognitiveTelemetryEventType,
  modelIdentifier: string | undefined,
  contractRef: Ref | undefined,
  severity: CognitiveTelemetryEvent["severity"],
  summary: string,
  timestampMs: number,
): CognitiveTelemetryEvent {
  const base = {
    event_ref: `model_version_evt_${computeDeterminismHash({ eventType, modelIdentifier, contractRef, severity, summary, timestampMs }).slice(0, 12)}`,
    event_type: eventType,
    model_identifier: modelIdentifier,
    contract_ref: contractRef,
    severity,
    summary,
    timestamp_ms: timestampMs,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const DEFAULT_REQUIRED_CAPABILITIES: readonly CapabilityName[] = freezeArray([
  "structured_outputs",
  "thinking",
  "input:text",
  "output:text",
]);

if (GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT !== 131072 || GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT !== 65536) {
  throw new Error("Model version isolation layer requires the documented Robotics-ER token limits.");
}

export const MODEL_VERSION_ISOLATION_LAYER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MODEL_VERSION_ISOLATION_LAYER_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  sections: freezeArray(["6.6.1", "6.7.1", "6.8.3", "6.13.3", "6.15", "6.16", "6.18", "6.19", "6.20"]),
});
