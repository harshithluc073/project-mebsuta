/**
 * Uncertainty reporting contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.5, 7.6, 7.8, 7.9, 7.11, 7.19, 7.23, and 7.24.
 *
 * This module implements the executable `UncertaintyReportingContract`. It
 * enforces confidence-scale use, ambiguity categories, missing-evidence
 * declarations, alternate hypotheses, and re-observation requests so model
 * outputs cannot hide uncertainty behind fallback guesses or overconfident
 * action proposals.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import type { CognitiveInvocationClass } from "../cognitive/gemini_robotics_er_adapter";
import {
  COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
  COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
  COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
} from "./cognitive_prompt_packet_contract";
import type { CognitivePromptPacketCandidate, CognitivePromptPacketSection } from "./cognitive_prompt_packet_contract";
import {
  STRUCTURED_RESPONSE_CONTRACT_VERSION,
} from "./structured_response_contract";
import type {
  StructuredConfidenceValue,
  StructuredResponseEnvelope,
  StructuredUncertaintyCategory,
  StructuredUncertaintyEntry,
} from "./structured_response_contract";

export const UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION = "mebsuta.uncertainty_reporting_contract.v1" as const;
export const UNCERTAINTY_REPORTING_CONTRACT_VERSION = "1.0.0" as const;
export const UNCERTAINTY_REPORTING_CONTRACT_ID = "PROMPT-UNCERTAINTY-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#UncertaintyReportingContract" as const;
const UNCERTAINTY_POLICY_VERSION = "confidence_ambiguity_reobserve_v1" as const;
const MAX_PROMPT_SECTION_CHARS = 30000;

export type UncertaintySurface = "prompt_packet" | "prompt_section" | "response_payload" | "raw_text";
export type UncertaintyDecision = "released" | "released_with_warnings" | "repair_required" | "reobserve_required" | "rejected";

export type UncertaintyIssueCategory =
  | "confidence_missing"
  | "confidence_invalid"
  | "confidence_rationale_missing"
  | "uncertainties_missing"
  | "uncertainty_category_invalid"
  | "uncertainty_evidence_missing"
  | "low_confidence_without_reobserve"
  | "blocking_uncertainty_without_reobserve"
  | "overconfident_under_ambiguity"
  | "missing_alternate_hypotheses"
  | "missing_evidence_not_declared"
  | "memory_conflict_not_declared"
  | "action_uncertainty_underreported"
  | "prompt_uncertainty_instruction_missing";

export type UncertaintySeverity = "error" | "warning";

export interface UncertaintyPolicyRule {
  readonly category: UncertaintyIssueCategory;
  readonly severity: UncertaintySeverity;
  readonly description: string;
  readonly remediation: string;
  readonly reobserve_required: boolean;
}

export interface UncertaintyPolicyDescriptor {
  readonly schema_version: typeof UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof UNCERTAINTY_REPORTING_CONTRACT_ID;
  readonly contract_version: typeof UNCERTAINTY_REPORTING_CONTRACT_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly uncertainty_policy_version: typeof UNCERTAINTY_POLICY_VERSION;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly confidence_values: readonly StructuredConfidenceValue[];
  readonly uncertainty_categories: readonly StructuredUncertaintyCategory[];
  readonly rules: readonly UncertaintyPolicyRule[];
  readonly determinism_hash: string;
}

export interface UncertaintyFinding {
  readonly finding_ref: Ref;
  readonly surface: UncertaintySurface;
  readonly category: UncertaintyIssueCategory;
  readonly severity: UncertaintySeverity;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
  readonly reobserve_required: boolean;
}

export interface UncertaintyTextScanRequest {
  readonly scan_ref: Ref;
  readonly surface: UncertaintySurface;
  readonly text: string;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly path?: string;
}

export interface UncertaintyEvidenceContext {
  readonly context_ref: Ref;
  readonly missing_evidence_refs?: readonly Ref[];
  readonly ambiguous_evidence_refs?: readonly Ref[];
  readonly conflicting_evidence_refs?: readonly Ref[];
  readonly alternate_hypothesis_count?: number;
  readonly memory_context_present?: boolean;
  readonly current_sensor_context_present?: boolean;
}

export interface UncertaintyReportingReport {
  readonly schema_version: typeof UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION;
  readonly uncertainty_policy_version: typeof UNCERTAINTY_POLICY_VERSION;
  readonly decision: UncertaintyDecision;
  readonly scan_ref: Ref;
  readonly inspected_surfaces: readonly UncertaintySurface[];
  readonly confidence_value?: StructuredConfidenceValue;
  readonly uncertainty_categories_detected: readonly StructuredUncertaintyCategory[];
  readonly reobserve_required: boolean;
  readonly missing_required_categories: readonly StructuredUncertaintyCategory[];
  readonly finding_count: number;
  readonly findings: readonly UncertaintyFinding[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Validates uncertainty discipline for prompt packets and structured responses.
 * The contract keeps Gemini's outputs humble: low confidence must request more
 * evidence, action-bearing responses must preserve safety uncertainty, and
 * ambiguous evidence must produce explicit categories rather than silent guesses.
 */
export class UncertaintyReportingContract {
  private readonly descriptor: UncertaintyPolicyDescriptor;
  private readonly rules: Readonly<Record<UncertaintyIssueCategory, UncertaintyPolicyRule>>;

  public constructor(rules: readonly UncertaintyPolicyRule[] = DEFAULT_UNCERTAINTY_RULES) {
    this.rules = indexRules(rules);
    this.descriptor = buildDescriptor(Object.values(this.rules));
  }

  /**
   * Returns immutable descriptor metadata for telemetry and prompt regression.
   */
  public getDescriptor(): UncertaintyPolicyDescriptor {
    return this.descriptor;
  }

  /**
   * Validates that a prompt packet includes explicit uncertainty instruction
   * and does not invite false certainty, over-precision, or memory-as-truth.
   */
  public validatePromptPacket(packet: CognitivePromptPacketCandidate): UncertaintyReportingReport {
    const issues: ValidationIssue[] = [];
    const findings: UncertaintyFinding[] = [];
    const surfaces: UncertaintySurface[] = ["prompt_packet"];
    validateRef(packet.packet_ref, "$.packet_ref", issues);
    validateRef(packet.task_state_ref, "$.task_state_ref", issues);
    if (packet.sections.some((section) => section.section_kind === "UncertaintyInstruction") === false) {
      findings.push(makeFinding("prompt_packet", "prompt_uncertainty_instruction_missing", "$.sections", "Prompt packet is missing UncertaintyInstruction.", this.rules));
    }
    for (const [index, section] of packet.sections.entries()) {
      surfaces.push("prompt_section");
      const report = this.validatePromptSection(section, `$.sections[${index}]`);
      findings.push(...report.findings);
      issues.push(...report.issues);
    }
    return makeReport(packet.packet_ref, surfaces, findings, issues, undefined, [], []);
  }

  /**
   * Validates one prompt section for uncertainty discipline.
   */
  public validatePromptSection(section: CognitivePromptPacketSection, path: string = "$.section"): UncertaintyReportingReport {
    const issues: ValidationIssue[] = [];
    const findings: UncertaintyFinding[] = [];
    validateRef(section.section_ref, `${path}.section_ref`, issues);
    validateRef(section.source_ref, `${path}.source_ref`, issues);
    if (section.content.trim().length === 0 || section.title.trim().length === 0) {
      issues.push(issue("error", "UncertaintyPromptSectionEmpty", path, "Uncertainty contract cannot approve an empty prompt section.", "Provide uncertainty, evidence, or contract text."));
    }
    if (section.content.length > MAX_PROMPT_SECTION_CHARS) {
      issues.push(issue("warning", "UncertaintyPromptSectionLarge", `${path}.content`, "Prompt section exceeds uncertainty scan target size.", "Compact prompt section while preserving ambiguity and evidence gaps."));
    }
    scanPromptText(section.content, path, findings, this.rules);
    if (section.section_kind === "UncertaintyInstruction" && hasUncertaintyInstruction(section.content) === false) {
      findings.push(makeFinding("prompt_section", "prompt_uncertainty_instruction_missing", `${path}.content`, "UncertaintyInstruction omits confidence, ambiguity, or re-observation wording.", this.rules));
    }
    if (section.section_kind === "MemoryContext" && /\b(certain|guaranteed|known fact|ground truth)\b/i.test(section.content)) {
      findings.push(makeFinding("prompt_section", "memory_conflict_not_declared", `${path}.content`, "Memory context overstates certainty.", this.rules));
    }
    return makeReport(section.section_ref, ["prompt_section"], findings, issues, undefined, [], []);
  }

  /**
   * Validates arbitrary text for confidence, ambiguity, and re-observation
   * instructions.
   */
  public scanTextBoundary(request: UncertaintyTextScanRequest): UncertaintyReportingReport {
    const issues: ValidationIssue[] = [];
    const findings: UncertaintyFinding[] = [];
    validateRef(request.scan_ref, "$.scan_ref", issues);
    if (request.text.trim().length === 0) {
      issues.push(issue("error", "UncertaintyTextEmpty", "$.text", "Uncertainty scan text must be non-empty.", "Provide the exact prompt or response text."));
    }
    scanPromptText(request.text, request.path ?? "$.text", findings, this.rules);
    if (isActionBearingInvocation(request.invocation_class) && /\b(confidence|uncertain|ambiguity|re-?observe|validation)\b/i.test(request.text) === false) {
      findings.push(makeFinding(request.surface, "prompt_uncertainty_instruction_missing", request.path ?? "$.text", "Action-bearing text lacks uncertainty or validation language.", this.rules));
    }
    return makeReport(request.scan_ref, [request.surface], findings, issues, undefined, [], []);
  }

  /**
   * Validates a structured response envelope against confidence scale,
   * uncertainty categories, evidence references, re-observation rules, and
   * evidence-context expectations.
   */
  public validateStructuredResponse(
    responseRef: Ref,
    payload: unknown,
    invocationClass?: CognitiveInvocationClass,
    evidenceContext: UncertaintyEvidenceContext = { context_ref: "uncertainty_context_unspecified" },
  ): UncertaintyReportingReport {
    const issues: ValidationIssue[] = [];
    const findings: UncertaintyFinding[] = [];
    validateRef(responseRef, "$.response_ref", issues);
    validateRef(evidenceContext.context_ref, "$.evidence_context.context_ref", issues);
    if (!isRecord(payload)) {
      issues.push(issue("error", "UncertaintyResponseNotObject", "$.payload", "Structured response must be a JSON object.", "Repair response with the common structured envelope."));
      return makeReport(responseRef, ["response_payload"], findings, issues, undefined, [], requiredCategoriesFor(invocationClass));
    }

    const confidenceValue = parseConfidenceValue(payload.confidence);
    if (confidenceValue === undefined) {
      findings.push(makeFinding("response_payload", isRecord(payload.confidence) ? "confidence_invalid" : "confidence_missing", "$.confidence.value", "Confidence value missing or invalid.", this.rules));
    }
    if (!isRecord(payload.confidence) || typeof payload.confidence.rationale !== "string" || payload.confidence.rationale.trim().length === 0) {
      findings.push(makeFinding("response_payload", "confidence_rationale_missing", "$.confidence.rationale", "Confidence rationale is missing.", this.rules));
    }

    const uncertainties = parseUncertainties(payload.uncertainties, findings, this.rules);
    const detectedCategories = freezeArray([...new Set(uncertainties.valid_entries.map((entry) => entry.category))]);
    const requiredCategories = requiredCategoriesFor(invocationClass);
    const missingCategories = requiredCategories.filter((category) => shouldRequireCategory(category, evidenceContext) && detectedCategories.includes(category) === false);
    for (const category of missingCategories) {
      findings.push(makeFinding("response_payload", "uncertainties_missing", "$.uncertainties", `Required uncertainty category ${category} is missing for current evidence context.`, this.rules));
    }

    if ((confidenceValue === "very_low" || confidenceValue === "low") && hasReobserveRequest(payload) === false) {
      findings.push(makeFinding("response_payload", "low_confidence_without_reobserve", "$.reobserve_request", "Low confidence requires a re-observation request.", this.rules));
    }
    if (uncertainties.valid_entries.some((entry) => entry.requires_reobserve) && hasReobserveRequest(payload) === false) {
      findings.push(makeFinding("response_payload", "blocking_uncertainty_without_reobserve", "$.reobserve_request", "Blocking uncertainty requires a re-observation request.", this.rules));
    }
    if ((confidenceValue === "high" || confidenceValue === "very_high") && hasBlockingEvidenceContext(evidenceContext)) {
      findings.push(makeFinding("response_payload", "overconfident_under_ambiguity", "$.confidence.value", "High confidence conflicts with missing, ambiguous, or conflicting evidence context.", this.rules));
    }
    if ((evidenceContext.alternate_hypothesis_count ?? 0) > 0 && hasAlternateHypotheses(payload) === false) {
      findings.push(makeFinding("response_payload", "missing_alternate_hypotheses", "$.primary_result", "Evidence context indicates alternate hypotheses, but response did not preserve them.", this.rules));
    }
    if ((evidenceContext.missing_evidence_refs?.length ?? 0) > 0 && mentionsMissingEvidence(payload) === false) {
      findings.push(makeFinding("response_payload", "missing_evidence_not_declared", "$.uncertainties", "Missing evidence was not declared in uncertainties or reobserve request.", this.rules));
    }
    if ((evidenceContext.memory_context_present ?? false) && (evidenceContext.current_sensor_context_present ?? false) === false && confidenceValue !== undefined && confidenceRank(confidenceValue) > confidenceRank("medium")) {
      findings.push(makeFinding("response_payload", "memory_conflict_not_declared", "$.confidence.value", "Memory-only context cannot support high confidence current-scene claims.", this.rules));
    }
    if (isActionBearingInvocation(invocationClass) && uncertainties.valid_entries.length === 0) {
      findings.push(makeFinding("response_payload", "action_uncertainty_underreported", "$.uncertainties", "Action-bearing response should explicitly state relevant uncertainty or why none blocks validation.", this.rules));
    }

    return makeReport(responseRef, ["response_payload"], findings, issues, confidenceValue, detectedCategories, missingCategories);
  }
}

function scanPromptText(text: string, path: string, findings: UncertaintyFinding[], rules: Readonly<Record<UncertaintyIssueCategory, UncertaintyPolicyRule>>): void {
  if (/\b(certain|guaranteed|definitely|must be|exactly)\b.{0,80}\b(occluded|blurred|ambiguous|uncertain|not visible|partially visible|single view|memory only)\b/i.test(text)) {
    findings.push(makeFinding("prompt_section", "overconfident_under_ambiguity", `${path}.content`, "Overconfident wording near ambiguity terms.", rules));
  }
  if (/\b(ignore ambiguity|assume success|guess if missing|proceed despite uncertainty|no need to reobserve)\b/i.test(text)) {
    findings.push(makeFinding("prompt_section", "prompt_uncertainty_instruction_missing", `${path}.content`, "Prompt invites guessing or ignores ambiguity.", rules));
  }
}

function parseUncertainties(
  value: unknown,
  findings: UncertaintyFinding[],
  rules: Readonly<Record<UncertaintyIssueCategory, UncertaintyPolicyRule>>,
): { readonly valid_entries: readonly StructuredUncertaintyEntry[] } {
  const validEntries: StructuredUncertaintyEntry[] = [];
  if (!Array.isArray(value)) {
    findings.push(makeFinding("response_payload", "uncertainties_missing", "$.uncertainties", "Uncertainties must be an array.", rules));
    return Object.freeze({ valid_entries: freezeArray(validEntries) });
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      findings.push(makeFinding("response_payload", "uncertainty_category_invalid", `$.uncertainties[${index}]`, "Uncertainty entry must be an object.", rules));
      continue;
    }
    if (!isUncertaintyCategory(entry.category)) {
      findings.push(makeFinding("response_payload", "uncertainty_category_invalid", `$.uncertainties[${index}].category`, "Uncertainty category is not recognized.", rules));
      continue;
    }
    if (!Array.isArray(entry.evidence_refs) || entry.evidence_refs.length === 0 || entry.evidence_refs.some((item) => typeof item !== "string" || item.trim().length === 0)) {
      findings.push(makeFinding("response_payload", "uncertainty_evidence_missing", `$.uncertainties[${index}].evidence_refs`, "Uncertainty entry requires evidence refs.", rules));
    }
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
      findings.push(makeFinding("response_payload", "missing_evidence_not_declared", `$.uncertainties[${index}].description`, "Uncertainty entry requires a description.", rules));
    }
    validEntries.push(Object.freeze({
      category: entry.category,
      description: typeof entry.description === "string" ? entry.description : "",
      evidence_refs: freezeArray(Array.isArray(entry.evidence_refs) ? entry.evidence_refs.filter((item): item is string => typeof item === "string") : []),
      requires_reobserve: entry.requires_reobserve === true,
    }));
  }
  return Object.freeze({ valid_entries: freezeArray(validEntries) });
}

function makeReport(
  scanRef: Ref,
  surfaces: readonly UncertaintySurface[],
  findings: readonly UncertaintyFinding[],
  issues: readonly ValidationIssue[],
  confidenceValue: StructuredConfidenceValue | undefined,
  detectedCategories: readonly StructuredUncertaintyCategory[],
  missingCategories: readonly StructuredUncertaintyCategory[],
): UncertaintyReportingReport {
  const reobserveRequired = findings.some((finding) => finding.reobserve_required);
  const hasErrors = issues.some((item) => item.severity === "error") || findings.some((finding) => finding.severity === "error");
  const decision: UncertaintyDecision = hasErrors && reobserveRequired
    ? "reobserve_required"
    : hasErrors
      ? "repair_required"
      : findings.length > 0
        ? "released_with_warnings"
        : "released";
  const base = {
    schema_version: UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION,
    uncertainty_policy_version: UNCERTAINTY_POLICY_VERSION,
    decision,
    scan_ref: scanRef,
    inspected_surfaces: freezeArray([...new Set(surfaces)]),
    confidence_value: confidenceValue,
    uncertainty_categories_detected: freezeArray(detectedCategories),
    reobserve_required: reobserveRequired,
    missing_required_categories: freezeArray(missingCategories),
    finding_count: findings.length,
    findings: freezeArray(findings),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeFinding(
  surface: UncertaintySurface,
  category: UncertaintyIssueCategory,
  path: string,
  message: string,
  rules: Readonly<Record<UncertaintyIssueCategory, UncertaintyPolicyRule>>,
): UncertaintyFinding {
  const rule = rules[category];
  const base = {
    surface,
    category,
    severity: rule.severity,
    path,
    message,
    remediation: rule.remediation,
    reobserve_required: rule.reobserve_required,
  };
  return Object.freeze({
    finding_ref: `uncertainty_${computeDeterminismHash(base).slice(0, 16)}`,
    ...base,
  });
}

function requiredCategoriesFor(invocationClass: CognitiveInvocationClass | undefined): readonly StructuredUncertaintyCategory[] {
  switch (invocationClass) {
    case "SceneObservationReasoning":
      return freezeArray(["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity"]);
    case "TaskPlanningReasoning":
      return freezeArray(["visibility_ambiguity", "identity_ambiguity", "reach_ambiguity", "safety_uncertainty"]);
    case "WaypointGenerationReasoning":
      return freezeArray(["pose_ambiguity", "reach_ambiguity", "safety_uncertainty"]);
    case "MultiViewDisambiguationReasoning":
      return freezeArray(["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity"]);
    case "SpatialVerificationReasoning":
      return freezeArray(["visibility_ambiguity", "pose_ambiguity", "memory_conflict"]);
    case "OopsCorrectionReasoning":
      return freezeArray(["visibility_ambiguity", "pose_ambiguity", "reach_ambiguity", "safety_uncertainty"]);
    case "ToolUseReasoning":
      return freezeArray(["reach_ambiguity", "safety_uncertainty", "visibility_ambiguity"]);
    case "AudioEventReasoning":
      return freezeArray(["audio_ambiguity", "visibility_ambiguity", "safety_uncertainty"]);
    case "MemoryAssimilationReasoning":
      return freezeArray(["memory_conflict", "visibility_ambiguity"]);
    case "InternalMonologueReasoning":
      return freezeArray(["safety_uncertainty", "visibility_ambiguity"]);
    default:
      return freezeArray([]);
  }
}

function shouldRequireCategory(category: StructuredUncertaintyCategory, context: UncertaintyEvidenceContext): boolean {
  const ambiguous = (context.ambiguous_evidence_refs?.length ?? 0) > 0;
  const conflicting = (context.conflicting_evidence_refs?.length ?? 0) > 0;
  const missing = (context.missing_evidence_refs?.length ?? 0) > 0;
  if (category === "memory_conflict") {
    return conflicting || (context.memory_context_present ?? false);
  }
  if (category === "safety_uncertainty") {
    return ambiguous || missing || conflicting;
  }
  return ambiguous || missing || conflicting || (context.alternate_hypothesis_count ?? 0) > 0;
}

function hasReobserveRequest(payload: Readonly<Record<string, unknown>>): boolean {
  return isRecord(payload.reobserve_request)
    && typeof payload.reobserve_request.reason === "string"
    && payload.reobserve_request.reason.trim().length > 0
    && Array.isArray(payload.reobserve_request.requested_evidence)
    && payload.reobserve_request.requested_evidence.length > 0;
}

function hasBlockingEvidenceContext(context: UncertaintyEvidenceContext): boolean {
  return (context.missing_evidence_refs?.length ?? 0) > 0
    || (context.ambiguous_evidence_refs?.length ?? 0) > 0
    || (context.conflicting_evidence_refs?.length ?? 0) > 0;
}

function hasAlternateHypotheses(payload: Readonly<Record<string, unknown>>): boolean {
  const raw = safeStringify(payload.primary_result).toLowerCase();
  return /\b(alternate|alternative|hypotheses|hypothesis|candidate|conflicting)\b|alternate_hypotheses/.test(raw);
}

function mentionsMissingEvidence(payload: Readonly<Record<string, unknown>>): boolean {
  const raw = safeStringify({ uncertainties: payload.uncertainties, reobserve_request: payload.reobserve_request }).toLowerCase();
  return /\b(missing|insufficient|not visible|occluded|additional evidence|re-?observe|cannot assess)\b/.test(raw);
}

function hasUncertaintyInstruction(text: string): boolean {
  return /\b(confidence|uncertain|uncertainty|ambiguity|ambiguous|missing evidence|re-?observe|additional evidence)\b/i.test(text);
}

function parseConfidenceValue(value: unknown): StructuredConfidenceValue | undefined {
  if (!isRecord(value) || typeof value.value !== "string") {
    return undefined;
  }
  return isConfidenceValue(value.value) ? value.value : undefined;
}

function confidenceRank(value: StructuredConfidenceValue): number {
  return CONFIDENCE_VALUES.indexOf(value);
}

function isConfidenceValue(value: string): value is StructuredConfidenceValue {
  return CONFIDENCE_VALUES.includes(value as StructuredConfidenceValue);
}

function isUncertaintyCategory(value: unknown): value is StructuredUncertaintyCategory {
  return typeof value === "string" && UNCERTAINTY_CATEGORIES.includes(value as StructuredUncertaintyCategory);
}

function isActionBearingInvocation(invocationClass: CognitiveInvocationClass | undefined): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function indexRules(rules: readonly UncertaintyPolicyRule[]): Readonly<Record<UncertaintyIssueCategory, UncertaintyPolicyRule>> {
  const map = new Map<UncertaintyIssueCategory, UncertaintyPolicyRule>();
  for (const rule of rules) {
    map.set(rule.category, Object.freeze({ ...rule }));
  }
  const missing = ALL_UNCERTAINTY_ISSUE_CATEGORIES.filter((category) => map.has(category) === false);
  if (missing.length > 0) {
    throw new Error(`UncertaintyReportingContract missing rules: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_UNCERTAINTY_ISSUE_CATEGORIES.map((category) => [category, map.get(category) as UncertaintyPolicyRule])) as Record<UncertaintyIssueCategory, UncertaintyPolicyRule>);
}

function buildDescriptor(rules: readonly UncertaintyPolicyRule[]): UncertaintyPolicyDescriptor {
  const base = {
    schema_version: UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION,
    contract_id: UNCERTAINTY_REPORTING_CONTRACT_ID,
    contract_version: UNCERTAINTY_REPORTING_CONTRACT_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    uncertainty_policy_version: UNCERTAINTY_POLICY_VERSION,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    confidence_values: CONFIDENCE_VALUES,
    uncertainty_categories: UNCERTAINTY_CATEGORIES,
    rules: freezeArray(rules),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function policyRule(category: UncertaintyIssueCategory, severity: UncertaintySeverity, description: string, remediation: string, reobserveRequired: boolean): UncertaintyPolicyRule {
  return Object.freeze({
    category,
    severity,
    description,
    remediation,
    reobserve_required: reobserveRequired,
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const CONFIDENCE_VALUES: readonly StructuredConfidenceValue[] = freezeArray(["very_low", "low", "medium", "high", "very_high"]);
const UNCERTAINTY_CATEGORIES: readonly StructuredUncertaintyCategory[] = freezeArray(["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity", "reach_ambiguity", "audio_ambiguity", "memory_conflict", "safety_uncertainty"]);

const ALL_UNCERTAINTY_ISSUE_CATEGORIES: readonly UncertaintyIssueCategory[] = freezeArray([
  "confidence_missing",
  "confidence_invalid",
  "confidence_rationale_missing",
  "uncertainties_missing",
  "uncertainty_category_invalid",
  "uncertainty_evidence_missing",
  "low_confidence_without_reobserve",
  "blocking_uncertainty_without_reobserve",
  "overconfident_under_ambiguity",
  "missing_alternate_hypotheses",
  "missing_evidence_not_declared",
  "memory_conflict_not_declared",
  "action_uncertainty_underreported",
  "prompt_uncertainty_instruction_missing",
]);

const DEFAULT_UNCERTAINTY_RULES: readonly UncertaintyPolicyRule[] = freezeArray([
  policyRule("confidence_missing", "error", "Response does not provide confidence.", "Return confidence.value and confidence.rationale.", false),
  policyRule("confidence_invalid", "error", "Response confidence does not use the approved scale.", "Use very_low, low, medium, high, or very_high.", false),
  policyRule("confidence_rationale_missing", "error", "Confidence lacks a concise evidence rationale.", "Explain the evidence basis without private reasoning.", false),
  policyRule("uncertainties_missing", "error", "Response does not provide required uncertainty entries.", "Return uncertainties with category, description, evidence refs, and reobserve flag.", false),
  policyRule("uncertainty_category_invalid", "error", "Uncertainty category is not recognized.", "Use the approved uncertainty category vocabulary.", false),
  policyRule("uncertainty_evidence_missing", "error", "Uncertainty lacks evidence references.", "Attach evidence_refs to each uncertainty entry.", false),
  policyRule("low_confidence_without_reobserve", "error", "Low confidence did not request re-observation.", "Provide reobserve_request with reason and requested evidence.", true),
  policyRule("blocking_uncertainty_without_reobserve", "error", "Blocking uncertainty did not request re-observation.", "Route to re-observe, safe-hold, or human review.", true),
  policyRule("overconfident_under_ambiguity", "error", "Confidence is too high for ambiguous or missing evidence.", "Downgrade confidence and declare ambiguity.", true),
  policyRule("missing_alternate_hypotheses", "warning", "Alternate hypotheses were not preserved.", "List plausible alternatives with evidence and confidence.", false),
  policyRule("missing_evidence_not_declared", "error", "Missing evidence was not declared.", "Add missing evidence to uncertainties and reobserve request.", true),
  policyRule("memory_conflict_not_declared", "error", "Memory conflict or memory-only uncertainty was not declared.", "Treat memory as prior belief with confidence and staleness.", true),
  policyRule("action_uncertainty_underreported", "warning", "Action-bearing output underreports uncertainty.", "State relevant uncertainty or why none blocks validator handoff.", false),
  policyRule("prompt_uncertainty_instruction_missing", "error", "Prompt lacks uncertainty reporting instructions.", "Add confidence, ambiguity, missing evidence, and re-observation requirements.", false),
]);

export const UNCERTAINTY_REPORTING_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: UNCERTAINTY_REPORTING_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprints: freezeArray([
    "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
    "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md",
  ]),
  sections: freezeArray(["7.3", "7.5", "7.6", "7.8", "7.9", "7.11", "7.19", "7.23", "7.24"]),
});
