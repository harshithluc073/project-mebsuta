/**
 * Gemini Robotics-ER cognitive adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.1 through 6.20.
 *
 * This module is the executable isolation boundary around Gemini Robotics-ER
 * 1.6. It validates the approved preview model profile, audits prompt packets
 * for simulation-blindness violations, budgets context against the documented
 * 131,072-token input limit, submits discrete `generateContent` requests, then
 * quarantines and validates text/structured responses before any downstream
 * validator or orchestrator can consume them.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION = "mebsuta.gemini_robotics_er_adapter.v1" as const;
export const GEMINI_ROBOTICS_ER_APPROVED_MODEL = "gemini-robotics-er-1.6-preview" as const;
export const GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT = 131072;
export const GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT = 65536;
export const DEFAULT_GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT = "https://generativelanguage.googleapis.com" as const;

const FORBIDDEN_PROMPT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|hidden)/i;
const UNSUPPORTED_MODALITY_PATTERN = /(live api|audio generation|image generation|direct actuator|joint torque|reward policy|reinforcement learning|rl update)/i;

export type CognitiveInvocationClass =
  | "SceneObservationReasoning"
  | "TaskPlanningReasoning"
  | "WaypointGenerationReasoning"
  | "MultiViewDisambiguationReasoning"
  | "SpatialVerificationReasoning"
  | "OopsCorrectionReasoning"
  | "ToolUseReasoning"
  | "AudioEventReasoning"
  | "MemoryAssimilationReasoning"
  | "InternalMonologueReasoning";

export type ThinkingBudgetClass = "minimal" | "low" | "moderate" | "high";
export type TemperatureClass = "deterministic" | "low" | "balanced";
export type RetryClass = "none" | "single_repair" | "exponential_noncritical";
export type CognitiveParseStatus = "parsed" | "repaired" | "rejected" | "ambiguous";
export type SemanticValidationStatus = "passed" | "failed" | "warning";
export type QuarantineReleaseDecision = "released" | "rejected" | "repair_needed" | "safe_hold_triggered";
export type CognitiveTelemetryEventType =
  | "CognitiveRequestPrepared"
  | "CognitiveRequestRejected"
  | "ModelCallStarted"
  | "ModelCallCompleted"
  | "ResponseQuarantined"
  | "ResponseReleased"
  | "ResponseRejected"
  | "ModelVersionDriftSignal";

export type GeminiAdapterIssueCode =
  | "ModelIdentifierRejected"
  | "ModelCapabilityMissing"
  | "PreviewProfileRequiresGuardrails"
  | "PromptBudgetExceeded"
  | "RequiredContextMissing"
  | "UnsupportedModality"
  | "PromptProvenanceViolation"
  | "ForbiddenPromptDetail"
  | "OutputContractUnknown"
  | "ApiKeyMissing"
  | "ApiRequestFailed"
  | "ApiTimeout"
  | "MalformedResponse"
  | "StructuredParseFailed"
  | "SemanticValidationFailed"
  | "ResponseRepairFailed";

export interface CognitivePromptSection {
  readonly section_ref: Ref;
  readonly title: string;
  readonly content: string;
  readonly provenance: "sensor" | "memory" | "embodiment" | "validator" | "task" | "safety" | "schema" | "system";
  readonly priority: number;
  readonly required?: boolean;
  readonly estimated_tokens?: number;
}

export interface CognitiveMediaPart {
  readonly media_ref: Ref;
  readonly modality: "image" | "video" | "audio";
  readonly mime_type: string;
  readonly data_base64?: string;
  readonly file_uri?: string;
  readonly provenance: "virtual_sensor" | "perception_excerpt";
  readonly estimated_tokens?: number;
}

export interface CognitiveBudgetReport {
  readonly schema_version: typeof GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly token_limit: number;
  readonly reserved_margin_tokens: number;
  readonly remaining_margin_tokens: number;
  readonly included_sections: readonly Ref[];
  readonly excluded_sections: readonly Ref[];
  readonly included_media: readonly Ref[];
  readonly excluded_media: readonly Ref[];
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveRequestEnvelope {
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL | string;
  readonly task_instruction?: string;
  readonly observation_sections?: readonly CognitivePromptSection[];
  readonly media_parts?: readonly CognitiveMediaPart[];
  readonly embodiment_context: string;
  readonly memory_context?: readonly CognitivePromptSection[];
  readonly validator_context?: readonly CognitivePromptSection[];
  readonly output_contract_ref: Ref;
  readonly budget_report?: CognitiveBudgetReport;
  readonly safety_annotations: readonly string[];
}

export interface CognitiveInvocationPolicy {
  readonly model_identifier?: string;
  readonly temperature_class: TemperatureClass;
  readonly thinking_budget_class: ThinkingBudgetClass;
  readonly retry_class: RetryClass;
  readonly timeout_ms: number;
  readonly max_output_tokens?: number;
  readonly allow_preview_model?: boolean;
  readonly require_structured_output?: boolean;
}

export interface OutputContractDefinition {
  readonly contract_ref: Ref;
  readonly required_fields: readonly string[];
  readonly allowed_action_fields?: readonly string[];
  readonly response_mime_type?: "application/json" | "text/plain";
  readonly json_schema?: Readonly<Record<string, unknown>>;
}

export interface ModelCapabilityProfile {
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly status: "preview";
  readonly input_modalities: readonly ("text" | "image" | "video" | "audio")[];
  readonly output_modalities: readonly "text"[];
  readonly input_token_limit: typeof GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT;
  readonly output_token_limit: typeof GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT;
  readonly structured_outputs: true;
  readonly thinking: true;
  readonly batch_api: true;
  readonly caching: true;
  readonly live_api: false;
  readonly audio_generation: false;
  readonly image_generation: false;
}

export interface CapabilityValidationReport {
  readonly schema_version: typeof GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION;
  readonly model_identifier: string;
  readonly approved: boolean;
  readonly missing_capabilities: readonly string[];
  readonly constrained_capabilities: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ModelIsolationReport {
  readonly schema_version: typeof GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION;
  readonly model_identifier: string;
  readonly approved: boolean;
  readonly profile: ModelCapabilityProfile;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveLatencyReport {
  readonly queue_ms: number;
  readonly generation_ms: number;
  readonly validation_ms: number;
  readonly repair_ms: number;
  readonly total_ms: number;
}

export interface CognitiveConfidenceReport {
  readonly confidence: "high" | "medium" | "low" | "unknown";
  readonly ambiguity_notes: readonly string[];
  readonly requested_reobservation: boolean;
}

export interface CognitiveResponseEnvelope {
  readonly schema_version: typeof GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION;
  readonly request_ref: Ref;
  readonly model_identifier: string;
  readonly raw_response_summary: string;
  readonly structured_parse_status: CognitiveParseStatus;
  readonly contract_ref: Ref;
  readonly semantic_validation_status: SemanticValidationStatus;
  readonly confidence_report: CognitiveConfidenceReport;
  readonly proposed_actions?: readonly string[];
  readonly monologue_candidate?: string;
  readonly memory_write_candidates?: readonly string[];
  readonly latency_report: CognitiveLatencyReport;
  readonly quarantine_release: QuarantineReleaseDecision;
  readonly parsed_payload?: unknown;
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_events: readonly CognitiveTelemetryEvent[];
  readonly determinism_hash: string;
}

export interface ResponseRepairReport {
  readonly schema_version: typeof GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION;
  readonly contract_ref: Ref;
  readonly repaired: boolean;
  readonly parse_status: CognitiveParseStatus;
  readonly repaired_payload?: unknown;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveTelemetryEvent {
  readonly event_ref: Ref;
  readonly event_type: CognitiveTelemetryEventType;
  readonly request_ref?: Ref;
  readonly model_identifier?: string;
  readonly contract_ref?: Ref;
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly timestamp_ms: number;
  readonly determinism_hash: string;
}

export interface GeminiAdapterTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeout_ms: number;
}

export interface GeminiAdapterTransportResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  readonly elapsed_ms: number;
}

export type GeminiAdapterTransport = (request: GeminiAdapterTransportRequest) => Promise<GeminiAdapterTransportResponse>;

export interface GeminiRoboticsERAdapterConfig {
  readonly api_key?: string;
  readonly endpoint?: string;
  readonly transport?: GeminiAdapterTransport;
  readonly output_contracts?: readonly OutputContractDefinition[];
  readonly now_ms?: () => number;
}

export class GeminiRoboticsERAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "GeminiRoboticsERAdapterError";
    this.issues = issues;
  }
}

/**
 * Adapter facade for approved Gemini Robotics-ER requests.
 */
export class GeminiRoboticsERAdapter {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly transport: GeminiAdapterTransport;
  private readonly contracts = new Map<Ref, OutputContractDefinition>();
  private readonly nowMs: () => number;

  public constructor(config: GeminiRoboticsERAdapterConfig = {}) {
    this.apiKey = config.api_key;
    this.endpoint = (config.endpoint ?? DEFAULT_GOOGLE_GENERATIVE_LANGUAGE_ENDPOINT).replace(/\/$/, "");
    this.transport = config.transport ?? defaultFetchTransport;
    this.nowMs = config.now_ms ?? (() => Date.now());
    for (const contract of [...defaultOutputContracts(), ...(config.output_contracts ?? [])]) {
      this.contracts.set(contract.contract_ref, freezeContract(contract));
    }
  }

  /**
   * Submits a sanitized multimodal prompt packet to the approved Robotics-ER
   * model, then quarantines and validates the returned text.
   */
  public async submitCognitiveRequest(
    requestEnvelope: CognitiveRequestEnvelope,
    invocationPolicy: CognitiveInvocationPolicy,
    outputContractRef: Ref,
  ): Promise<CognitiveResponseEnvelope> {
    const startedMs = this.nowMs();
    const telemetry: CognitiveTelemetryEvent[] = [];
    const issues: ValidationIssue[] = [];
    const modelIdentifier = invocationPolicy.model_identifier ?? requestEnvelope.model_identifier;
    const isolation = this.isolateModelVersion(modelIdentifier);
    issues.push(...isolation.issues);
    const contract = this.requireOutputContract(outputContractRef, issues);
    const budget = this.estimatePromptBudget(requestEnvelope, budgetProfileFor(requestEnvelope.invocation_class));
    issues.push(...budget.issues);
    auditRequestEnvelope(requestEnvelope, issues);
    validateInvocationPolicy(invocationPolicy, requestEnvelope, issues);

    if (issues.some((issue) => issue.severity === "error")) {
      telemetry.push(makeTelemetry("CognitiveRequestRejected", requestEnvelope.request_ref, modelIdentifier, outputContractRef, "error", "Cognitive request failed adapter preflight.", this.nowMs()));
      return buildRejectedEnvelope(requestEnvelope, modelIdentifier, outputContractRef, issues, telemetry, startedMs, this.nowMs());
    }

    telemetry.push(makeTelemetry("CognitiveRequestPrepared", requestEnvelope.request_ref, modelIdentifier, outputContractRef, "info", "Cognitive request passed firewall and budget checks.", this.nowMs()));
    telemetry.push(makeTelemetry("ModelCallStarted", requestEnvelope.request_ref, modelIdentifier, outputContractRef, "info", "Adapter is submitting request to approved model.", this.nowMs()));

    let rawText = "";
    let generationMs = 0;
    try {
      const response = await this.callGenerateContent(requestEnvelope, invocationPolicy, contract, modelIdentifier);
      generationMs = response.elapsed_ms;
      rawText = extractGeminiText(response.body);
      if (!response.ok) {
        issues.push(makeIssue("error", "ApiRequestFailed", "$.api_response", `Gemini API returned HTTP ${response.status}.`, "Retry according to policy or enter safe-hold/degraded mode."));
      }
      if (rawText.trim().length === 0) {
        issues.push(makeIssue("error", "MalformedResponse", "$.api_response", "Model response did not contain text output.", "Quarantine and repair or reject the response."));
      }
      telemetry.push(makeTelemetry("ModelCallCompleted", requestEnvelope.request_ref, modelIdentifier, outputContractRef, response.ok ? "info" : "error", `Model call completed with status ${response.status}.`, this.nowMs()));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Gemini transport failure.";
      const code: GeminiAdapterIssueCode = /timeout/i.test(message) ? "ApiTimeout" : "ApiRequestFailed";
      issues.push(makeIssue("error", code, "$.transport", message, "Retry according to policy or pause the cognitive task safely."));
      telemetry.push(makeTelemetry("ModelCallCompleted", requestEnvelope.request_ref, modelIdentifier, outputContractRef, "error", "Model call failed before a usable response was produced.", this.nowMs()));
    }

    const quarantinedAt = this.nowMs();
    telemetry.push(makeTelemetry("ResponseQuarantined", requestEnvelope.request_ref, modelIdentifier, outputContractRef, "info", "Raw response entered quarantine.", quarantinedAt));
    const repairStarted = this.nowMs();
    const repair = this.repairStructuredResponse(rawText, outputContractRef, { max_attempts: invocationPolicy.retry_class === "none" ? 0 : 1 });
    const repairMs = this.nowMs() - repairStarted;
    issues.push(...repair.issues);
    const parsedPayload = repair.repaired_payload;
    validateSemanticResponse(parsedPayload, contract, issues);
    const validationMs = this.nowMs() - quarantinedAt - repairMs;
    const release = chooseReleaseDecision(issues, repair.parse_status, requestEnvelope.invocation_class);
    telemetry.push(makeTelemetry(release === "released" ? "ResponseReleased" : "ResponseRejected", requestEnvelope.request_ref, modelIdentifier, outputContractRef, release === "released" ? "info" : "error", `Response quarantine decision: ${release}.`, this.nowMs()));

    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      request_ref: requestEnvelope.request_ref,
      model_identifier: modelIdentifier,
      raw_response_summary: redactResponseSummary(rawText),
      structured_parse_status: repair.parse_status,
      contract_ref: outputContractRef,
      semantic_validation_status: semanticStatus(issues),
      confidence_report: extractConfidenceReport(parsedPayload, issues),
      proposed_actions: extractStringArray(parsedPayload, "proposed_actions"),
      monologue_candidate: extractString(parsedPayload, "monologue_candidate"),
      memory_write_candidates: extractStringArray(parsedPayload, "memory_write_candidates"),
      latency_report: Object.freeze({
        queue_ms: 0,
        generation_ms: Math.max(0, generationMs),
        validation_ms: Math.max(0, validationMs),
        repair_ms: Math.max(0, repairMs),
        total_ms: Math.max(0, this.nowMs() - startedMs),
      }),
      quarantine_release: release,
      parsed_payload: parsedPayload,
      issues: freezeArray(issues),
      telemetry_events: freezeArray(telemetry),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates model identity and required capability assumptions.
   */
  public validateModelCapabilityProfile(modelIdentifier: string, requiredCapabilities: readonly string[]): CapabilityValidationReport {
    const profile = approvedModelProfile();
    const issues: ValidationIssue[] = [];
    if (modelIdentifier !== profile.model_identifier) {
      issues.push(makeIssue("error", "ModelIdentifierRejected", "$.model_identifier", "Only gemini-robotics-er-1.6-preview is approved for this adapter.", "Use the approved Robotics-ER preview profile or run a formal migration."));
    }
    const missing = requiredCapabilities.filter((capability) => !capabilityAvailable(profile, capability));
    for (const capability of missing) {
      issues.push(makeIssue("error", "ModelCapabilityMissing", "$.required_capabilities", `Capability ${capability} is unavailable or unsupported by policy.`, "Remove unsupported capability assumptions or use a deterministic subsystem."));
    }
    const constrained = requiredCapabilities.filter((capability) => capability === "function_calling" || capability === "code_execution" || capability === "computer_use");
    if (profile.status === "preview") {
      issues.push(makeIssue("warning", "PreviewProfileRequiresGuardrails", "$.model_profile.status", "Approved model is preview and requires regression gates.", "Keep response quarantine, telemetry, and deterministic validators active."));
    }
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      model_identifier: modelIdentifier,
      approved: issues.every((issue) => issue.severity !== "error"),
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
   * Estimates input budget with a deterministic character-to-token heuristic
   * and excludes optional low-priority sections if the request is too large.
   */
  public estimatePromptBudget(requestEnvelope: CognitiveRequestEnvelope, budgetProfile: BudgetProfile): CognitiveBudgetReport {
    const issues: ValidationIssue[] = [];
    const sections = [...collectSections(requestEnvelope)].sort((a: CognitivePromptSection, b: CognitivePromptSection) =>
      b.priority - a.priority || a.section_ref.localeCompare(b.section_ref));
    const required = sections.filter((section) => section.required === true);
    const optional = sections.filter((section) => section.required !== true);
    const media = [...(requestEnvelope.media_parts ?? [])].sort((a, b) => (b.estimated_tokens ?? estimateMediaTokens(b)) - (a.estimated_tokens ?? estimateMediaTokens(a)));
    const includedSections: Ref[] = [];
    const excludedSections: Ref[] = [];
    const includedMedia: Ref[] = [];
    const excludedMedia: Ref[] = [];
    let estimated = estimateTextTokens(requestEnvelope.embodiment_context)
      + estimateTextTokens(requestEnvelope.task_instruction ?? "")
      + requestEnvelope.safety_annotations.reduce((sum, item) => sum + estimateTextTokens(item), 0)
      + budgetProfile.adapter_overhead_tokens
      + budgetProfile.output_contract_tokens;
    for (const section of required) {
      estimated += section.estimated_tokens ?? estimateTextTokens(`${section.title}\n${section.content}`);
      includedSections.push(section.section_ref);
    }
    const maxAllowed = budgetProfile.input_token_limit - budgetProfile.reserved_margin_tokens;
    for (const section of optional) {
      const cost = section.estimated_tokens ?? estimateTextTokens(`${section.title}\n${section.content}`);
      if (estimated + cost <= maxAllowed) {
        estimated += cost;
        includedSections.push(section.section_ref);
      } else {
        excludedSections.push(section.section_ref);
      }
    }
    for (const part of media) {
      const cost = part.estimated_tokens ?? estimateMediaTokens(part);
      if (estimated + cost <= maxAllowed && mediaSupported(part.modality)) {
        estimated += cost;
        includedMedia.push(part.media_ref);
      } else {
        excludedMedia.push(part.media_ref);
      }
      if (!mediaSupported(part.modality)) {
        issues.push(makeIssue("error", "UnsupportedModality", "$.media_parts", `Media modality ${part.modality} is not supported.`, "Use text, image, video, or audio evidence only."));
      }
    }
    for (const section of required) {
      if (!includedSections.includes(section.section_ref)) {
        issues.push(makeIssue("error", "RequiredContextMissing", "$.prompt_sections", `Required section ${section.section_ref} is missing from the prompt budget.`, "Compact optional context before dropping required context."));
      }
    }
    const remaining = budgetProfile.input_token_limit - estimated;
    if (remaining < budgetProfile.reserved_margin_tokens) {
      issues.push(makeIssue("error", "PromptBudgetExceeded", "$.budget_report", "Estimated prompt budget exceeds the reserved model input limit.", "Compact history, reduce media, or drop optional memory."));
    }
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      estimated_input_tokens: estimated,
      estimated_output_tokens: budgetProfile.output_token_target,
      token_limit: budgetProfile.input_token_limit,
      reserved_margin_tokens: budgetProfile.reserved_margin_tokens,
      remaining_margin_tokens: remaining,
      included_sections: freezeArray(includedSections.sort()),
      excluded_sections: freezeArray(excludedSections.sort()),
      included_media: freezeArray(includedMedia.sort()),
      excluded_media: freezeArray(excludedMedia.sort()),
      ok: issues.every((issue) => issue.severity !== "error"),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Parses, minimally repairs, and validates structured model output under the
   * chosen output contract.
   */
  public repairStructuredResponse(rawResponse: string, contractRef: Ref, repairPolicy: { readonly max_attempts: number }): ResponseRepairReport {
    const issues: ValidationIssue[] = [];
    const contract = this.contracts.get(contractRef);
    if (contract === undefined) {
      issues.push(makeIssue("error", "OutputContractUnknown", "$.contract_ref", `Output contract ${contractRef} is not registered.`, "Register the structured response contract before invocation."));
      return buildRepairReport(contractRef, false, "rejected", undefined, issues);
    }
    const direct = parseJson(rawResponse);
    if (direct.ok) {
      return buildRepairReport(contractRef, true, "parsed", direct.value, issues);
    }
    if (repairPolicy.max_attempts <= 0) {
      issues.push(makeIssue("error", "StructuredParseFailed", "$.raw_response", "Response is not valid JSON and repair is disabled.", "Enable one repair attempt or reject the model response."));
      return buildRepairReport(contractRef, false, "rejected", undefined, issues);
    }
    const extracted = extractJsonCandidate(rawResponse);
    const repaired = parseJson(extracted);
    if (!repaired.ok) {
      issues.push(makeIssue("error", "ResponseRepairFailed", "$.raw_response", "Response repair could not recover a valid JSON object.", "Reject response and request a schema-restated retry."));
      return buildRepairReport(contractRef, false, "rejected", undefined, issues);
    }
    return buildRepairReport(contractRef, true, "repaired", repaired.value, issues);
  }

  /**
   * Isolates model-specific assumptions from stable internal contracts.
   */
  public isolateModelVersion(modelIdentifier: string): ModelIsolationReport {
    const profile = approvedModelProfile();
    const issues: ValidationIssue[] = [];
    if (modelIdentifier !== profile.model_identifier) {
      issues.push(makeIssue("error", "ModelIdentifierRejected", "$.model_identifier", "Requested model is not approved for this adapter.", "Use gemini-robotics-er-1.6-preview or run migration review."));
    }
    issues.push(makeIssue("warning", "PreviewProfileRequiresGuardrails", "$.model_profile.status", "Gemini Robotics-ER 1.6 is a preview model.", "Keep response quarantine, telemetry, and regression testing enabled."));
    const base = {
      schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
      model_identifier: modelIdentifier,
      approved: issues.every((issue) => issue.severity !== "error"),
      profile,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireOutputContract(contractRef: Ref, issues: ValidationIssue[]): OutputContractDefinition {
    const contract = this.contracts.get(contractRef);
    if (contract === undefined) {
      issues.push(makeIssue("error", "OutputContractUnknown", "$.output_contract_ref", `Output contract ${contractRef} is unknown.`, "Register the output contract before request submission."));
      return defaultOutputContracts()[0];
    }
    return contract;
  }

  private async callGenerateContent(
    envelope: CognitiveRequestEnvelope,
    policy: CognitiveInvocationPolicy,
    contract: OutputContractDefinition,
    modelIdentifier: string,
  ): Promise<GeminiAdapterTransportResponse> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) {
      throw new GeminiRoboticsERAdapterError("Gemini API key is missing.", [
        makeIssue("error", "ApiKeyMissing", "$.api_key", "No API key was configured for Gemini generateContent.", "Provide an API key through adapter configuration."),
      ]);
    }
    const body = buildGenerateContentBody(envelope, policy, contract);
    return this.transport({
      url: `${this.endpoint}/v1beta/models/${encodeURIComponent(modelIdentifier)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      headers: Object.freeze({ "Content-Type": "application/json" }),
      body,
      timeout_ms: policy.timeout_ms,
    });
  }
}

export function createGeminiRoboticsERAdapter(config: GeminiRoboticsERAdapterConfig = {}): GeminiRoboticsERAdapter {
  return new GeminiRoboticsERAdapter(config);
}

async function defaultFetchTransport(request: GeminiAdapterTransportRequest): Promise<GeminiAdapterTransportResponse> {
  const started = Date.now();
  const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), request.timeout_ms);
  try {
    if (typeof fetch === "undefined") {
      throw new Error("Global fetch is unavailable; provide a GeminiAdapterTransport.");
    }
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller?.signal,
    });
    const text = await response.text();
    const parsedBody = parseJson(text);
    return Object.freeze({
      status: response.status,
      ok: response.ok,
      body: parsedBody.ok === true ? parsedBody.value : text,
      elapsed_ms: Date.now() - started,
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function buildGenerateContentBody(
  envelope: CognitiveRequestEnvelope,
  policy: CognitiveInvocationPolicy,
  contract: OutputContractDefinition,
): Readonly<Record<string, unknown>> {
  const parts = [
    { text: stableSystemInstruction(envelope.invocation_class) },
    { text: renderPromptEnvelope(envelope) },
    ...((envelope.media_parts ?? []).map(renderMediaPart)),
  ];
  const generationConfig: Record<string, unknown> = {
    temperature: temperatureFor(policy.temperature_class),
    maxOutputTokens: Math.min(policy.max_output_tokens ?? GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT, GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT),
    responseMimeType: contract.response_mime_type ?? "application/json",
  };
  if (contract.json_schema !== undefined) {
    generationConfig.responseSchema = contract.json_schema;
  }
  return Object.freeze({
    contents: freezeArray([{ role: "user", parts }]),
    generationConfig,
  });
}

function renderMediaPart(part: CognitiveMediaPart): Readonly<Record<string, unknown>> {
  if (part.data_base64 !== undefined) {
    return Object.freeze({
      inline_data: Object.freeze({
        mime_type: part.mime_type,
        data: part.data_base64,
      }),
    });
  }
  return Object.freeze({
    file_data: Object.freeze({
      mime_type: part.mime_type,
      file_uri: part.file_uri ?? "",
    }),
  });
}

function renderPromptEnvelope(envelope: CognitiveRequestEnvelope): string {
  const sections = collectSections(envelope)
    .map((section) => `[${section.provenance}:${section.title}]\n${section.content}`)
    .join("\n\n");
  return [
    `request_ref: ${envelope.request_ref}`,
    `invocation_class: ${envelope.invocation_class}`,
    `output_contract_ref: ${envelope.output_contract_ref}`,
    `task_instruction: ${envelope.task_instruction ?? "none"}`,
    `embodiment_context: ${envelope.embodiment_context}`,
    `safety_annotations:\n${envelope.safety_annotations.map((item) => `- ${item}`).join("\n")}`,
    sections,
    "Return only the requested structured output. Do not include direct actuator commands, simulator internals, hidden chain-of-thought, or unvalidated execution claims.",
  ].filter((item) => item.trim().length > 0).join("\n\n");
}

function stableSystemInstruction(invocationClass: CognitiveInvocationClass): string {
  return [
    "You are reasoning for an embodied robot using only provided sensor evidence, memory beliefs, validator feedback, and body capability summaries.",
    "You do not know backend simulator truth, engine handles, scene graph IDs, collision meshes, exact hidden COM, or QA oracle state.",
    "You produce structured text proposals only; deterministic validators and controllers own execution.",
    `Current invocation class: ${invocationClass}. State uncertainty, request re-observation when evidence is weak, and prefer safe-hold over unsafe guessing.`,
  ].join(" ");
}

function auditRequestEnvelope(envelope: CognitiveRequestEnvelope, issues: ValidationIssue[]): void {
  validateSafeRef(envelope.request_ref, "$.request_ref", issues);
  validateSafeRef(envelope.output_contract_ref, "$.output_contract_ref", issues);
  scanPromptText(envelope.task_instruction ?? "", "$.task_instruction", issues);
  scanPromptText(envelope.embodiment_context, "$.embodiment_context", issues);
  for (const [index, annotation] of envelope.safety_annotations.entries()) {
    scanPromptText(annotation, `$.safety_annotations[${index}]`, issues);
  }
  for (const [index, section] of collectSections(envelope).entries()) {
    validateSafeRef(section.section_ref, `$.sections[${index}].section_ref`, issues);
    scanPromptText(section.title, `$.sections[${index}].title`, issues);
    scanPromptText(section.content, `$.sections[${index}].content`, issues);
    if (section.provenance === "system" && section.required !== true) {
      issues.push(makeIssue("warning", "PromptProvenanceViolation", `$.sections[${index}].provenance`, "System context should be explicit and required.", "Mark system context as required or lower its authority."));
    }
  }
  for (const [index, part] of (envelope.media_parts ?? []).entries()) {
    validateSafeRef(part.media_ref, `$.media_parts[${index}].media_ref`, issues);
    if (part.provenance !== "virtual_sensor" && part.provenance !== "perception_excerpt") {
      issues.push(makeIssue("error", "PromptProvenanceViolation", `$.media_parts[${index}].provenance`, "Media must originate from virtual sensors or perception excerpts.", "Use sensor-derived media only."));
    }
  }
}

function scanPromptText(value: string, path: string, issues: ValidationIssue[]): void {
  if (FORBIDDEN_PROMPT_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenPromptDetail", path, "Prompt text contains simulator, backend, hidden, or QA-only detail.", "Replace with sensor-derived or prompt-safe summary."));
  }
  if (UNSUPPORTED_MODALITY_PATTERN.test(value)) {
    issues.push(makeIssue("error", "UnsupportedModality", path, "Prompt text requests unsupported or prohibited Robotics-ER behavior.", "Use text output proposals and deterministic subsystems for execution, TTS, and rendering."));
  }
}

function validateInvocationPolicy(policy: CognitiveInvocationPolicy, envelope: CognitiveRequestEnvelope, issues: ValidationIssue[]): void {
  if (policy.allow_preview_model !== true) {
    issues.push(makeIssue("warning", "PreviewProfileRequiresGuardrails", "$.invocation_policy.allow_preview_model", "Preview model use should be explicitly acknowledged.", "Set allow_preview_model when regression gates and quarantine are enabled."));
  }
  if (policy.timeout_ms <= 0 || !Number.isFinite(policy.timeout_ms)) {
    issues.push(makeIssue("error", "ApiTimeout", "$.invocation_policy.timeout_ms", "Timeout must be positive and finite.", "Set a state-appropriate request timeout."));
  }
  if (policy.require_structured_output !== false && envelope.output_contract_ref.trim().length === 0) {
    issues.push(makeIssue("error", "OutputContractUnknown", "$.output_contract_ref", "Structured output requires a contract reference.", "Provide a registered output contract reference."));
  }
}

function validateSemanticResponse(payload: unknown, contract: OutputContractDefinition, issues: ValidationIssue[]): void {
  if (!isRecord(payload)) {
    issues.push(makeIssue("error", "SemanticValidationFailed", "$.parsed_payload", "Parsed response must be a JSON object.", "Reject or repair the response."));
    return;
  }
  for (const field of contract.required_fields) {
    if (!(field in payload)) {
      issues.push(makeIssue("error", "SemanticValidationFailed", `$.parsed_payload.${field}`, `Required response field ${field} is missing.`, "Repair with schema restatement or reject."));
    }
  }
  const raw = JSON.stringify(payload);
  if (UNSUPPORTED_MODALITY_PATTERN.test(raw) || FORBIDDEN_PROMPT_PATTERN.test(raw)) {
    issues.push(makeIssue("error", "SemanticValidationFailed", "$.parsed_payload", "Response contains unsafe, unsupported, or simulator-specific content.", "Reject response and request safe structured output."));
  }
}

function extractGeminiText(body: unknown): string {
  if (!isRecord(body)) {
    return typeof body === "string" ? body : "";
  }
  const candidates = body.candidates;
  if (!Array.isArray(candidates)) {
    return "";
  }
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

function parseJson(value: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced !== null) {
    return fenced[1].trim();
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1);
  }
  return raw.trim();
}

function extractConfidenceReport(payload: unknown, issues: readonly ValidationIssue[]): CognitiveConfidenceReport {
  if (isRecord(payload) && isRecord(payload.confidence_report)) {
    const report = payload.confidence_report;
    return Object.freeze({
      confidence: isConfidence(report.confidence) ? report.confidence : issues.some((issue) => issue.severity === "error") ? "low" : "unknown",
      ambiguity_notes: freezeArray(Array.isArray(report.ambiguity_notes) ? report.ambiguity_notes.filter((item): item is string => typeof item === "string").map(redactResponseSummary) : []),
      requested_reobservation: typeof report.requested_reobservation === "boolean" ? report.requested_reobservation : false,
    });
  }
  return Object.freeze({
    confidence: issues.some((issue) => issue.severity === "error") ? "low" : "unknown",
    ambiguity_notes: freezeArray([]),
    requested_reobservation: false,
  });
}

function extractStringArray(payload: unknown, field: string): readonly string[] | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return freezeArray(value.filter((item): item is string => typeof item === "string").map(redactResponseSummary));
}

function extractString(payload: unknown, field: string): string | undefined {
  if (!isRecord(payload) || typeof payload[field] !== "string") {
    return undefined;
  }
  return redactResponseSummary(payload[field]);
}

function redactResponseSummary(value: string): string {
  return value.replace(FORBIDDEN_PROMPT_PATTERN, "redacted-detail").replace(/\s+/g, " ").trim().slice(0, 2000);
}

function chooseReleaseDecision(issues: readonly ValidationIssue[], parseStatus: CognitiveParseStatus, invocationClass: CognitiveInvocationClass): QuarantineReleaseDecision {
  if (issues.some((issue) => issue.severity === "error")) {
    return invocationClass === "WaypointGenerationReasoning" || invocationClass === "ToolUseReasoning" || invocationClass === "OopsCorrectionReasoning"
      ? "safe_hold_triggered"
      : "rejected";
  }
  if (parseStatus === "ambiguous") {
    return "repair_needed";
  }
  return "released";
}

function semanticStatus(issues: readonly ValidationIssue[]): SemanticValidationStatus {
  if (issues.some((issue) => issue.severity === "error")) {
    return "failed";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "warning";
  }
  return "passed";
}

function buildRejectedEnvelope(
  request: CognitiveRequestEnvelope,
  modelIdentifier: string,
  contractRef: Ref,
  issues: readonly ValidationIssue[],
  telemetry: readonly CognitiveTelemetryEvent[],
  startedMs: number,
  nowMs: number,
): CognitiveResponseEnvelope {
  const base = {
    schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
    request_ref: request.request_ref,
    model_identifier: modelIdentifier,
    raw_response_summary: "",
    structured_parse_status: "rejected" as const,
    contract_ref: contractRef,
    semantic_validation_status: "failed" as const,
    confidence_report: Object.freeze({ confidence: "low" as const, ambiguity_notes: freezeArray(["Adapter preflight rejected the request."]), requested_reobservation: true }),
    latency_report: Object.freeze({ queue_ms: 0, generation_ms: 0, validation_ms: 0, repair_ms: 0, total_ms: Math.max(0, nowMs - startedMs) }),
    quarantine_release: "rejected" as const,
    issues: freezeArray(issues),
    telemetry_events: freezeArray(telemetry),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildRepairReport(contractRef: Ref, repaired: boolean, parseStatus: CognitiveParseStatus, payload: unknown, issues: readonly ValidationIssue[]): ResponseRepairReport {
  const base = {
    schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
    contract_ref: contractRef,
    repaired,
    parse_status: parseStatus,
    repaired_payload: payload,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

interface BudgetProfile {
  readonly input_token_limit: number;
  readonly reserved_margin_tokens: number;
  readonly output_token_target: number;
  readonly adapter_overhead_tokens: number;
  readonly output_contract_tokens: number;
}

function budgetProfileFor(invocationClass: CognitiveInvocationClass): BudgetProfile {
  const large = invocationClass === "TaskPlanningReasoning" || invocationClass === "OopsCorrectionReasoning" || invocationClass === "ToolUseReasoning";
  return Object.freeze({
    input_token_limit: GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
    reserved_margin_tokens: large ? 14000 : 20000,
    output_token_target: large ? 12000 : 6000,
    adapter_overhead_tokens: 1500,
    output_contract_tokens: large ? 2500 : 1200,
  });
}

function collectSections(envelope: CognitiveRequestEnvelope): readonly CognitivePromptSection[] {
  return freezeArray([
    ...(envelope.observation_sections ?? []),
    ...(envelope.memory_context ?? []),
    ...(envelope.validator_context ?? []),
  ]);
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimateMediaTokens(part: CognitiveMediaPart): number {
  if (part.estimated_tokens !== undefined) {
    return part.estimated_tokens;
  }
  if (part.modality === "audio") {
    return 1200;
  }
  if (part.modality === "video") {
    return 8000;
  }
  return 1800;
}

function mediaSupported(modality: CognitiveMediaPart["modality"]): boolean {
  return modality === "image" || modality === "video" || modality === "audio";
}

function temperatureFor(value: TemperatureClass): number {
  if (value === "deterministic") {
    return 0;
  }
  if (value === "low") {
    return 0.2;
  }
  return 0.45;
}

function approvedModelProfile(): ModelCapabilityProfile {
  return Object.freeze({
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
  });
}

function capabilityAvailable(profile: ModelCapabilityProfile, capability: string): boolean {
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
  if (capability.startsWith("input:")) {
    return profile.input_modalities.includes(capability.slice("input:".length) as ModelCapabilityProfile["input_modalities"][number]);
  }
  if (capability.startsWith("output:")) {
    return profile.output_modalities.includes(capability.slice("output:".length) as "text");
  }
  return true;
}

function defaultOutputContracts(): readonly OutputContractDefinition[] {
  return freezeArray([
    {
      contract_ref: "generic_structured_response_v1",
      required_fields: freezeArray(["confidence_report"]),
      allowed_action_fields: freezeArray(["proposed_actions", "monologue_candidate", "memory_write_candidates"]),
      response_mime_type: "application/json",
      json_schema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          confidence_report: Object.freeze({
            type: "object",
            properties: Object.freeze({
              confidence: Object.freeze({ type: "string" }),
              ambiguity_notes: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
              requested_reobservation: Object.freeze({ type: "boolean" }),
            }),
            required: freezeArray(["confidence", "ambiguity_notes", "requested_reobservation"]),
          }),
          proposed_actions: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
          monologue_candidate: Object.freeze({ type: "string" }),
          memory_write_candidates: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
        }),
        required: freezeArray(["confidence_report"]),
      }),
    },
  ]);
}

function freezeContract(contract: OutputContractDefinition): OutputContractDefinition {
  return Object.freeze({
    ...contract,
    required_fields: freezeArray(contract.required_fields),
    allowed_action_fields: contract.allowed_action_fields === undefined ? undefined : freezeArray(contract.allowed_action_fields),
    json_schema: contract.json_schema === undefined ? undefined : Object.freeze({ ...contract.json_schema }),
  });
}

function makeTelemetry(
  eventType: CognitiveTelemetryEventType,
  requestRef: Ref | undefined,
  modelIdentifier: string | undefined,
  contractRef: Ref | undefined,
  severity: CognitiveTelemetryEvent["severity"],
  summary: string,
  timestampMs: number,
): CognitiveTelemetryEvent {
  const base = {
    event_ref: `cog_evt_${computeDeterminismHash({ eventType, requestRef, modelIdentifier, contractRef, severity, summary, timestampMs }).slice(0, 12)}`,
    event_type: eventType,
    request_ref: requestRef,
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

function validateSafeRef(value: Ref, path: string, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", "PromptProvenanceViolation", path, "Reference must be non-empty and whitespace-free.", "Use stable opaque references."));
  }
  if (FORBIDDEN_PROMPT_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenPromptDetail", path, "Reference appears to contain simulator or hidden detail.", "Use prompt-safe opaque references."));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfidence(value: unknown): value is CognitiveConfidenceReport["confidence"] {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

function makeIssue(severity: ValidationSeverity, code: GeminiAdapterIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const GEMINI_ROBOTICS_ER_ADAPTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  sections: freezeArray(["6.1", "6.2", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9", "6.10", "6.12", "6.18", "6.19", "6.20"]),
});
