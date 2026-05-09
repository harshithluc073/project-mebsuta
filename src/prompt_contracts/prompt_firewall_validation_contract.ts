/**
 * Prompt firewall validation contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 7.19, 7.23, and 7.24.
 *
 * This module implements the executable `PromptFirewallValidationContract`.
 * It screens prompt packets, raw model-facing text, structured responses, and
 * validator repair context for simulation-blindness violations, hidden-world
 * leakage, executable-code requests, direct-control requests, private reasoning
 * leakage, and validator authority bypass wording before any Gemini Robotics-ER
 * request or response can leave quarantine.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import {
  COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
  COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
  COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
} from "./cognitive_prompt_packet_contract";
import type {
  CognitivePromptPacketCandidate,
  CognitivePromptPacketSection,
  PromptProvenanceLabel,
} from "./cognitive_prompt_packet_contract";
import { STRUCTURED_RESPONSE_CONTRACT_VERSION } from "./structured_response_contract";
import type { StructuredResponseEnvelope } from "./structured_response_contract";

export const PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION = "mebsuta.prompt_firewall_validation_contract.v1" as const;
export const PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION = "1.0.0" as const;
export const PROMPT_FIREWALL_VALIDATION_CONTRACT_ID = "PROMPT-FIREWALL-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#PromptFirewallValidationContract" as const;
const FIREWALL_POLICY_VERSION = "simulation_blindness_hidden_truth_v1" as const;
const MAX_MODEL_FACING_FIELD_CHARS = 24000;
const SANITIZED_VALIDATOR_REASON_MAX_CHARS = 1600;

export type FirewallScanSurface =
  | "prompt_packet"
  | "prompt_section"
  | "response_payload"
  | "validator_context"
  | "monologue_text"
  | "memory_context"
  | "raw_text";

export type FirewallLeakCategory =
  | "simulation_awareness"
  | "backend_identifier"
  | "scene_graph_reference"
  | "exact_hidden_pose"
  | "collision_or_mesh_truth"
  | "qa_or_oracle_truth"
  | "debug_or_internal_buffer"
  | "private_reasoning"
  | "executable_code_request"
  | "direct_actuator_control"
  | "validator_bypass"
  | "memory_without_provenance"
  | "unsanitized_validator_detail"
  | "unsupported_model_authority";

export type FirewallFindingSeverity = "critical" | "high" | "medium" | "low";
export type FirewallDisposition = "allow" | "allow_with_warnings" | "reject" | "quarantine";
export type SanitizationDisposition = "sanitized" | "unchanged" | "rejected";

export interface FirewallPolicyRule {
  readonly category: FirewallLeakCategory;
  readonly severity: FirewallFindingSeverity;
  readonly description: string;
  readonly remediation: string;
  readonly quarantine_required: boolean;
}

export interface FirewallPolicyDescriptor {
  readonly schema_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_ID;
  readonly contract_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly firewall_policy_version: typeof FIREWALL_POLICY_VERSION;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly rules: readonly FirewallPolicyRule[];
  readonly determinism_hash: string;
}

export interface FirewallFinding {
  readonly finding_ref: Ref;
  readonly surface: FirewallScanSurface;
  readonly category: FirewallLeakCategory;
  readonly severity: FirewallFindingSeverity;
  readonly path: string;
  readonly matched_excerpt: string;
  readonly remediation: string;
  readonly quarantine_required: boolean;
}

export interface FirewallTextScanRequest {
  readonly scan_ref: Ref;
  readonly surface: FirewallScanSurface;
  readonly text: string;
  readonly path?: string;
  readonly provenance_label?: PromptProvenanceLabel;
  readonly allow_sanitized_validator_context?: boolean;
}

export interface PromptFirewallValidationReport {
  readonly schema_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION;
  readonly firewall_policy_version: typeof FIREWALL_POLICY_VERSION;
  readonly decision: FirewallDisposition;
  readonly scan_ref: Ref;
  readonly inspected_surfaces: readonly FirewallScanSurface[];
  readonly finding_count: number;
  readonly critical_count: number;
  readonly high_count: number;
  readonly quarantined: boolean;
  readonly findings: readonly FirewallFinding[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ValidatorContextSanitizationRequest {
  readonly context_ref: Ref;
  readonly source_component_ref: Ref;
  readonly raw_validator_text: string;
  readonly allowed_reason_classes?: readonly string[];
}

export interface ValidatorContextSanitizationReport {
  readonly schema_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION;
  readonly context_ref: Ref;
  readonly disposition: SanitizationDisposition;
  readonly sanitized_text: string;
  readonly removed_categories: readonly FirewallLeakCategory[];
  readonly validation_report: PromptFirewallValidationReport;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Deterministic firewall for cognitive ingress and response quarantine. It is
 * intentionally conservative: model-facing content is rejected whenever hidden
 * truth, private reasoning, direct-control, executable-code, or authority-bypass
 * language is detected in prompt text, response payloads, memory excerpts, or
 * repair context.
 */
export class PromptFirewallValidationContract {
  private readonly descriptor: FirewallPolicyDescriptor;
  private readonly ruleMap: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>;

  public constructor(rules: readonly FirewallPolicyRule[] = DEFAULT_FIREWALL_POLICY_RULES) {
    this.ruleMap = indexRules(rules);
    this.descriptor = buildDescriptor(Object.values(this.ruleMap));
  }

  /**
   * Returns the immutable firewall descriptor used by telemetry and prompt
   * registry surfaces.
   */
  public getDescriptor(): FirewallPolicyDescriptor {
    return this.descriptor;
  }

  /**
   * Validates a complete prompt packet before adapter submission. The scan
   * covers packet refs, task refs, section titles, section content, section
   * source refs, provenance labels, media refs, and telemetry labels.
   */
  public validatePromptPacket(packet: CognitivePromptPacketCandidate): PromptFirewallValidationReport {
    const issues: ValidationIssue[] = [];
    const findings: FirewallFinding[] = [];
    const surfaces: FirewallScanSurface[] = ["prompt_packet"];
    validateRef(packet.packet_ref, "$.packet_ref", issues);
    validateRef(packet.task_state_ref, "$.task_state_ref", issues);
    scanText(packet.packet_ref, "$.packet_ref", "prompt_packet", this.ruleMap, findings, true);
    scanText(packet.task_state_ref, "$.task_state_ref", "prompt_packet", this.ruleMap, findings, true);

    for (const [index, label] of packet.telemetry_labels.entries()) {
      validateRef(label, `$.telemetry_labels[${index}]`, issues);
      scanText(label, `$.telemetry_labels[${index}]`, "prompt_packet", this.ruleMap, findings, true);
    }
    for (const [index, mediaRef] of packet.media_refs.entries()) {
      validateRef(mediaRef, `$.media_refs[${index}]`, issues);
      scanText(mediaRef, `$.media_refs[${index}]`, "prompt_packet", this.ruleMap, findings, true);
    }
    for (const [index, section] of packet.sections.entries()) {
      surfaces.push(sectionSurface(section));
      findings.push(...this.scanPromptSection(section, `$.sections[${index}]`));
      validatePromptSectionProvenance(section, `$.sections[${index}]`, findings, issues, this.ruleMap);
    }
    return makeReport(packet.packet_ref, surfaces, findings, issues);
  }

  /**
   * Scans one prompt section. This is useful when an assembler wants to block
   * a section before building a full packet.
   */
  public validatePromptSection(section: CognitivePromptPacketSection, path: string = "$.section"): PromptFirewallValidationReport {
    const issues: ValidationIssue[] = [];
    validatePromptSectionProvenance(section, path, [], issues, this.ruleMap);
    const findings = this.scanPromptSection(section, path);
    return makeReport(section.section_ref, [sectionSurface(section)], findings, issues);
  }

  /**
   * Scans arbitrary model-facing text such as repair prompts, monologue text,
   * or redacted validator context.
   */
  public scanTextBoundary(request: FirewallTextScanRequest): PromptFirewallValidationReport {
    const issues: ValidationIssue[] = [];
    const findings: FirewallFinding[] = [];
    validateRef(request.scan_ref, "$.scan_ref", issues);
    if (request.text.trim().length === 0) {
      issues.push(issue("error", "FirewallTextEmpty", "$.text", "Firewall scan text must be non-empty.", "Provide the exact model-facing text to scan."));
    }
    if (request.text.length > MAX_MODEL_FACING_FIELD_CHARS) {
      issues.push(issue("warning", "FirewallTextLarge", "$.text", "Model-facing text exceeds the firewall field size target.", "Compact or split context before model submission."));
    }
    const sanitizedAllowed = request.allow_sanitized_validator_context === true && request.surface === "validator_context";
    scanText(request.text, request.path ?? "$.text", request.surface, this.ruleMap, findings, sanitizedAllowed);
    if (request.provenance_label === "memory_prior" && hasMemoryTruthClaim(request.text)) {
      findings.push(makeFinding("memory_context", "memory_without_provenance", request.path ?? "$.text", "memory truth claim", this.ruleMap));
    }
    return makeReport(request.scan_ref, [request.surface], findings, issues);
  }

  /**
   * Validates a structured response envelope or raw parsed payload before
   * release from quarantine. The scan is deep and includes field names because
   * hidden truth often leaks through schema keys, not just values.
   */
  public validateStructuredResponse(responseRef: Ref, payload: unknown): PromptFirewallValidationReport {
    const issues: ValidationIssue[] = [];
    const findings: FirewallFinding[] = [];
    validateRef(responseRef, "$.response_ref", issues);
    scanUnknown(payload, "$.payload", "response_payload", this.ruleMap, findings);
    if (isStructuredResponseEnvelope(payload) && payload.forbidden_content_absent !== true) {
      findings.push(makeFinding("response_payload", "unsupported_model_authority", "$.payload.forbidden_content_absent", "forbidden_content_absent=false", this.ruleMap));
    }
    return makeReport(responseRef, ["response_payload"], findings, issues);
  }

  /**
   * Redacts a validator report into safe model-facing repair context. Hidden
   * details are removed, but high-level reason classes are preserved so the
   * model can repair a proposal without receiving privileged evidence.
   */
  public sanitizeValidatorContext(request: ValidatorContextSanitizationRequest): ValidatorContextSanitizationReport {
    const issues: ValidationIssue[] = [];
    validateRef(request.context_ref, "$.context_ref", issues);
    validateRef(request.source_component_ref, "$.source_component_ref", issues);
    if (request.raw_validator_text.trim().length === 0) {
      issues.push(issue("error", "ValidatorContextEmpty", "$.raw_validator_text", "Validator context must be non-empty before sanitization.", "Provide a human-readable validator reason class."));
    }
    const rawReport = this.scanTextBoundary({
      scan_ref: `${request.context_ref}_raw`,
      surface: "validator_context",
      text: request.raw_validator_text,
      path: "$.raw_validator_text",
    });
    const sanitized = sanitizeText(request.raw_validator_text, request.allowed_reason_classes ?? DEFAULT_VALIDATOR_REASON_CLASSES);
    const sanitizedReport = this.scanTextBoundary({
      scan_ref: `${request.context_ref}_sanitized`,
      surface: "validator_context",
      text: sanitized.text,
      path: "$.sanitized_text",
      allow_sanitized_validator_context: true,
    });
    const combinedIssues = freezeArray([...issues, ...rawReport.issues, ...sanitizedReport.issues]);
    const disposition: SanitizationDisposition = combinedIssues.some((item) => item.severity === "error") || sanitizedReport.decision === "reject" || sanitizedReport.decision === "quarantine"
      ? "rejected"
      : sanitized.removed_categories.length > 0
        ? "sanitized"
        : "unchanged";
    const base = {
      schema_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION,
      context_ref: request.context_ref,
      disposition,
      sanitized_text: disposition === "rejected" ? "" : sanitized.text,
      removed_categories: sanitized.removed_categories,
      validation_report: sanitizedReport,
      issues: combinedIssues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private scanPromptSection(section: CognitivePromptPacketSection, path: string): readonly FirewallFinding[] {
    const findings: FirewallFinding[] = [];
    validateSectionRefs(section, path, this.ruleMap, findings);
    scanText(section.title, `${path}.title`, sectionSurface(section), this.ruleMap, findings, false);
    scanText(section.content, `${path}.content`, sectionSurface(section), this.ruleMap, findings, section.provenance_label === "validator_feedback");
    scanText(section.source_ref, `${path}.source_ref`, sectionSurface(section), this.ruleMap, findings, true);
    if (section.telemetry_label !== undefined) {
      scanText(section.telemetry_label, `${path}.telemetry_label`, sectionSurface(section), this.ruleMap, findings, true);
    }
    if (section.provenance_label === "memory_prior" && hasMemoryTruthClaim(section.content)) {
      findings.push(makeFinding("memory_context", "memory_without_provenance", `${path}.content`, "memory truth claim", this.ruleMap));
    }
    return freezeArray(findings);
  }
}

function scanUnknown(
  value: unknown,
  path: string,
  surface: FirewallScanSurface,
  rules: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>,
  findings: FirewallFinding[],
): void {
  if (typeof value === "string") {
    scanText(value, path, surface, rules, findings, false);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnknown(item, `${path}[${index}]`, surface, rules, findings));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scanText(key, `${path}.${key}:key`, surface, rules, findings, false);
      scanUnknown(entry, `${path}.${key}`, surface, rules, findings);
    }
  }
}

function scanText(
  text: string,
  path: string,
  surface: FirewallScanSurface,
  rules: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>,
  findings: FirewallFinding[],
  allowSanitizedValidatorContext: boolean,
): void {
  if (text.trim().length === 0) {
    return;
  }
  for (const matcher of FIREWALL_MATCHERS) {
    if (allowSanitizedValidatorContext && matcher.allow_in_sanitized_validator_context) {
      continue;
    }
    const match = text.match(matcher.pattern);
    if (match !== null) {
      findings.push(makeFinding(surface, matcher.category, path, redactExcerpt(match[0]), rules));
    }
  }
}

function validatePromptSectionProvenance(
  section: CognitivePromptPacketSection,
  path: string,
  findings: FirewallFinding[],
  issues: ValidationIssue[],
  rules: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>,
): void {
  validateRef(section.section_ref, `${path}.section_ref`, issues);
  validateRef(section.source_ref, `${path}.source_ref`, issues);
  if (section.content.trim().length === 0 || section.title.trim().length === 0) {
    issues.push(issue("error", "PromptSectionEmpty", path, "Prompt firewall cannot approve an empty section.", "Provide non-empty title and content or omit the section."));
  }
  if (section.section_kind === "CurrentObservation" && !isCurrentSensorEvidence(section.provenance_label)) {
    findings.push(makeFinding("prompt_section", "memory_without_provenance", `${path}.provenance_label`, section.provenance_label, rules));
  }
  if (section.section_kind === "MemoryContext" && section.provenance_label !== "memory_prior") {
    findings.push(makeFinding("memory_context", "memory_without_provenance", `${path}.provenance_label`, section.provenance_label, rules));
  }
  if (section.section_kind === "ValidationFeedback" && section.provenance_label !== "validator_feedback") {
    findings.push(makeFinding("validator_context", "unsanitized_validator_detail", `${path}.provenance_label`, section.provenance_label, rules));
  }
}

function validateSectionRefs(
  section: CognitivePromptPacketSection,
  path: string,
  rules: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>,
  findings: FirewallFinding[],
): void {
  scanText(section.section_ref, `${path}.section_ref`, sectionSurface(section), rules, findings, true);
  scanText(section.source_ref, `${path}.source_ref`, sectionSurface(section), rules, findings, true);
}

function sanitizeText(rawText: string, allowedReasonClasses: readonly string[]): { readonly text: string; readonly removed_categories: readonly FirewallLeakCategory[] } {
  let sanitized = rawText.replace(/\s+/g, " ").trim();
  const removed: FirewallLeakCategory[] = [];
  for (const matcher of FIREWALL_MATCHERS) {
    if (matcher.category === "validator_bypass" || matcher.category === "private_reasoning" || matcher.category === "executable_code_request") {
      continue;
    }
    if (matcher.pattern.test(sanitized)) {
      removed.push(matcher.category);
      sanitized = sanitized.replace(matcher.global_pattern, "[redacted]");
    }
  }
  const reason = allowedReasonClasses.find((item) => new RegExp(`\\b${escapeRegex(item)}\\b`, "i").test(sanitized));
  const reasonPrefix = reason === undefined ? "validator_rejection" : reason.toLowerCase().replace(/\s+/g, "_");
  const clipped = sanitized.slice(0, SANITIZED_VALIDATOR_REASON_MAX_CHARS);
  return Object.freeze({
    text: `sanitized_validator_reason=${reasonPrefix}; detail=${clipped}`,
    removed_categories: freezeArray([...new Set(removed)]),
  });
}

function makeReport(
  scanRef: Ref,
  surfaces: readonly FirewallScanSurface[],
  findings: readonly FirewallFinding[],
  issues: readonly ValidationIssue[],
): PromptFirewallValidationReport {
  const criticalCount = findings.filter((finding) => finding.severity === "critical").length;
  const highCount = findings.filter((finding) => finding.severity === "high").length;
  const quarantined = findings.some((finding) => finding.quarantine_required);
  const hasErrors = issues.some((item) => item.severity === "error");
  const decision: FirewallDisposition = hasErrors || criticalCount > 0
    ? "reject"
    : quarantined
      ? "quarantine"
      : findings.length > 0 || issues.length > 0
        ? "allow_with_warnings"
        : "allow";
  const base = {
    schema_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION,
    firewall_policy_version: FIREWALL_POLICY_VERSION,
    decision,
    scan_ref: scanRef,
    inspected_surfaces: freezeArray([...new Set(surfaces)]),
    finding_count: findings.length,
    critical_count: criticalCount,
    high_count: highCount,
    quarantined,
    findings: freezeArray(findings),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeFinding(
  surface: FirewallScanSurface,
  category: FirewallLeakCategory,
  path: string,
  matchedExcerpt: string,
  rules: Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>>,
): FirewallFinding {
  const rule = rules[category];
  const base = {
    surface,
    category,
    severity: rule.severity,
    path,
    matched_excerpt: redactExcerpt(matchedExcerpt),
    remediation: rule.remediation,
    quarantine_required: rule.quarantine_required,
  };
  return Object.freeze({
    finding_ref: `fw_find_${computeDeterminismHash(base).slice(0, 16)}`,
    ...base,
  });
}

function sectionSurface(section: CognitivePromptPacketSection): FirewallScanSurface {
  if (section.section_kind === "MemoryContext") {
    return "memory_context";
  }
  if (section.section_kind === "ValidationFeedback") {
    return "validator_context";
  }
  return "prompt_section";
}

function isCurrentSensorEvidence(label: PromptProvenanceLabel): boolean {
  return label === "sensor_visual_current"
    || label === "sensor_audio_current"
    || label === "sensor_contact_current"
    || label === "proprioceptive_current"
    || label === "inference_from_evidence";
}

function hasMemoryTruthClaim(text: string): boolean {
  return /\b(memory|previous|prior)\b[\s\S]{0,80}\b(certain|known fact|guaranteed|always true|ground truth|verified by qa)\b/i.test(text);
}

function isStructuredResponseEnvelope(value: unknown): value is StructuredResponseEnvelope {
  return isRecord(value)
    && typeof value.response_contract_id === "string"
    && typeof value.contract_version_ack === "string"
    && "forbidden_content_absent" in value;
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function indexRules(rules: readonly FirewallPolicyRule[]): Readonly<Record<FirewallLeakCategory, FirewallPolicyRule>> {
  const map = new Map<FirewallLeakCategory, FirewallPolicyRule>();
  for (const rule of rules) {
    map.set(rule.category, Object.freeze({ ...rule }));
  }
  const missing = ALL_FIREWALL_CATEGORIES.filter((category) => map.has(category) === false);
  if (missing.length > 0) {
    throw new Error(`PromptFirewallValidationContract missing rules: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_FIREWALL_CATEGORIES.map((category) => [category, map.get(category) as FirewallPolicyRule])) as Record<FirewallLeakCategory, FirewallPolicyRule>);
}

function buildDescriptor(rules: readonly FirewallPolicyRule[]): FirewallPolicyDescriptor {
  const base = {
    schema_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION,
    contract_id: PROMPT_FIREWALL_VALIDATION_CONTRACT_ID,
    contract_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    firewall_policy_version: FIREWALL_POLICY_VERSION,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    rules: freezeArray(rules),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function fieldRule(category: FirewallLeakCategory, severity: FirewallFindingSeverity, description: string, remediation: string, quarantineRequired: boolean): FirewallPolicyRule {
  return Object.freeze({
    category,
    severity,
    description,
    remediation,
    quarantine_required: quarantineRequired,
  });
}

function redactExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

interface FirewallMatcher {
  readonly category: FirewallLeakCategory;
  readonly pattern: RegExp;
  readonly global_pattern: RegExp;
  readonly allow_in_sanitized_validator_context: boolean;
}

function matcher(category: FirewallLeakCategory, pattern: string, flags = "i", allowInSanitizedValidatorContext = false): FirewallMatcher {
  return Object.freeze({
    category,
    pattern: new RegExp(pattern, flags),
    global_pattern: new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`),
    allow_in_sanitized_validator_context: allowInSanitizedValidatorContext,
  });
}

const ALL_FIREWALL_CATEGORIES: readonly FirewallLeakCategory[] = freezeArray([
  "simulation_awareness",
  "backend_identifier",
  "scene_graph_reference",
  "exact_hidden_pose",
  "collision_or_mesh_truth",
  "qa_or_oracle_truth",
  "debug_or_internal_buffer",
  "private_reasoning",
  "executable_code_request",
  "direct_actuator_control",
  "validator_bypass",
  "memory_without_provenance",
  "unsanitized_validator_detail",
  "unsupported_model_authority",
]);

const FIREWALL_MATCHERS: readonly FirewallMatcher[] = freezeArray([
  matcher("simulation_awareness", "\\b(mujoco|babylon|simulator|simulated environment|simulation environment|physics engine|render engine)\\b"),
  matcher("backend_identifier", "\\b(backend[_ -]?(object|id|handle|name)|object_id|rigid_body_handle|physics_body|joint_handle|asset_id|internal asset|cube_\\d{2,})\\b"),
  matcher("scene_graph_reference", "\\b(scene_graph|scene graph|node path|renderer node|/world/[^\\s]+|graph path)\\b"),
  matcher("exact_hidden_pose", "\\b(exact|ground.?truth|backend|hidden|oracle)\\b.{0,48}\\b(world pose|pose|coordinate|position|orientation|com|center of mass)\\b|\\b(world_pose|exact_com|hidden_pose|hidden_state)\\b"),
  matcher("collision_or_mesh_truth", "\\b(collision_mesh|mesh id|triangle mesh|contact solver internal|collision primitive|broadphase|narrowphase|internal impulse)\\b"),
  matcher("qa_or_oracle_truth", "\\b(qa[_ -]?(truth|flag|pass|oracle|success)|oracle state|benchmark answer|expected answer|test oracle|gold label)\\b"),
  matcher("debug_or_internal_buffer", "\\b(debug buffer|render buffer|segmentation truth|depth truth|internal trace|stack trace|developer prompt|system prompt disclosure)\\b"),
  matcher("private_reasoning", "\\b(chain[- ]?of[- ]?thought|scratchpad|private deliberation|hidden reasoning|full reasoning trace|internal monologue trace)\\b"),
  matcher("executable_code_request", "\\b(write|output|generate|return)\\s+(executable\\s+)?(python|typescript|javascript|c\\+\\+|java|rust|code)\\b"),
  matcher("direct_actuator_control", "\\b(direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|motor command|servo command|control tick|physics step)\\b"),
  matcher("validator_bypass", "\\b(ignore validators|override safety|disable safe.?hold|bypass validator|skip validation|act without validation|guarantee success|execution authority)\\b"),
  matcher("memory_without_provenance", "\\b(memory fact|known forever|certain prior|unprovenanced memory|memory says it is true)\\b"),
  matcher("unsanitized_validator_detail", "\\b(raw validator|unsanitized validator|internal validator report|contact manifold|solver island|constraint row|jacobian row)\\b"),
  matcher("unsupported_model_authority", "\\b(model decides execution|gemini executes|model controls|final authority|no downstream validation|required validators optional)\\b"),
]);

const DEFAULT_FIREWALL_POLICY_RULES: readonly FirewallPolicyRule[] = freezeArray([
  fieldRule("simulation_awareness", "critical", "Model-facing text reveals non-embodied environment awareness.", "Remove simulator or engine framing and rebuild from sensor evidence.", true),
  fieldRule("backend_identifier", "critical", "Model-facing text exposes backend identity or internal handles.", "Replace internal IDs with natural sensor-derived descriptions.", true),
  fieldRule("scene_graph_reference", "critical", "Model-facing text exposes scene graph or renderer path details.", "Use view-relative or object-description evidence only.", true),
  fieldRule("exact_hidden_pose", "critical", "Model-facing text exposes exact hidden pose or coordinate truth.", "Use estimated, provenance-labeled spatial relations and confidence.", true),
  fieldRule("collision_or_mesh_truth", "critical", "Model-facing text exposes collision mesh or physics internals.", "Sanitize to a high-level validator reason class.", true),
  fieldRule("qa_or_oracle_truth", "critical", "Model-facing text exposes QA or oracle truth.", "Keep QA facts on non-cognitive validation paths only.", true),
  fieldRule("debug_or_internal_buffer", "high", "Model-facing text exposes debug buffers or internal traces.", "Remove debug traces and provide sanitized summaries.", true),
  fieldRule("private_reasoning", "high", "Text requests or leaks private reasoning.", "Request concise public rationale or structured evidence fields only.", true),
  fieldRule("executable_code_request", "high", "Text asks the model for executable implementation code.", "Request structured plans, fields, waypoints, or repair values instead.", true),
  fieldRule("direct_actuator_control", "critical", "Text asks for direct low-level control.", "Use symbolic plans or validator-bound waypoints only.", true),
  fieldRule("validator_bypass", "critical", "Text bypasses deterministic validator authority.", "Restore validator handoff and safe-hold language.", true),
  fieldRule("memory_without_provenance", "high", "Memory is asserted as truth without provenance discipline.", "Attach confidence, staleness, evidence refs, and contradiction status.", true),
  fieldRule("unsanitized_validator_detail", "high", "Validator context contains internal details instead of a safe reason class.", "Run validator context sanitization before prompt assembly.", true),
  fieldRule("unsupported_model_authority", "critical", "Text grants model execution authority.", "Make model outputs proposals subject to deterministic validators.", true),
]);

const DEFAULT_VALIDATOR_REASON_CLASSES: readonly string[] = freezeArray([
  "collision risk",
  "reach limit",
  "stability risk",
  "tool envelope risk",
  "visibility ambiguity",
  "pose ambiguity",
  "safety uncertainty",
  "retry budget exceeded",
]);

export const PROMPT_FIREWALL_VALIDATION_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprint: "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md",
  sections: freezeArray(["7.2", "7.3", "7.4", "7.5", "7.7", "7.8", "7.19", "7.23", "7.24"]),
});
