/**
 * Response repair contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.6, 7.7, 7.19, 7.22, 7.23, and 7.24.
 *
 * This module implements bounded repair for malformed, incomplete, unsafe, or
 * overconfident Gemini Robotics-ER responses. It classifies quarantine and
 * validation failures, applies finite retry budgets, builds compact repair-only
 * prompt packets from safe context, and returns terminal rejection or safe-hold
 * decisions when repair would violate simulation-blindness, no-RL, validator
 * authority, or retry discipline.
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
import type { PromptProvenanceLabel } from "./cognitive_prompt_packet_contract";
import {
  STRUCTURED_RESPONSE_CONTRACT_VERSION,
} from "./structured_response_contract";
import type {
  StructuredResponseContractRef,
  StructuredResponseValidationReport,
} from "./structured_response_contract";
import { PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION } from "./prompt_firewall_validation_contract";
import type { PromptFirewallValidationReport } from "./prompt_firewall_validation_contract";
import { NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION } from "./no_rl_prompt_compliance_contract";
import type { NoRLComplianceReport } from "./no_rl_prompt_compliance_contract";
import { UNCERTAINTY_REPORTING_CONTRACT_VERSION } from "./uncertainty_reporting_contract";
import type { UncertaintyReportingReport } from "./uncertainty_reporting_contract";

export const RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION = "mebsuta.response_repair_contract.v1" as const;
export const RESPONSE_REPAIR_CONTRACT_VERSION = "1.0.0" as const;
export const RESPONSE_REPAIR_CONTRACT_ID = "PROMPT-REPAIR-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#ResponseRepairContract" as const;
const RESPONSE_REPAIR_POLICY_VERSION = "bounded_repair_terminal_rejection_v1" as const;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;
const DEFAULT_MAX_SAME_FAILURE_ATTEMPTS = 1;
const MAX_SAFE_CONTEXT_ITEMS = 10;
const MAX_SAFE_CONTEXT_CHARS = 6000;
const MAX_RAW_RESPONSE_EXCERPT_CHARS = 1200;
const MAX_REPAIR_REASON_CHARS = 2400;
const FORBIDDEN_REPAIR_CONTEXT_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold|skip validation|without validation)/i;

export type ResponseRepairFailureCategory =
  | "parse_failure"
  | "schema_mismatch"
  | "missing_required_field"
  | "wrong_contract_id"
  | "unsupported_field"
  | "extra_prose"
  | "low_confidence_without_reobserve"
  | "overconfident_under_ambiguity"
  | "forbidden_content"
  | "unsafe_direct_control"
  | "validator_bypass"
  | "no_rl_violation"
  | "firewall_quarantine"
  | "retry_budget_exhausted"
  | "repeated_malformed_output"
  | "empty_response"
  | "unknown_validation_failure";

export type ResponseRepairEligibility = "repairable" | "not_repairable" | "already_valid" | "budget_exhausted";
export type ResponseRepairDecision = "repair_prompt_ready" | "terminal_rejection" | "safe_hold_required" | "human_review_required" | "no_repair_needed";
export type ResponseRepairAttemptOutcome = "repair_prompt_sent" | "repaired_response_released" | "repaired_response_rejected" | "terminal_rejection" | "safe_hold_required";
export type ResponseRepairPromptSectionKind = "RepairReason" | "OriginalContractSummary" | "SafeContextSubset" | "ForbiddenContentReminder" | "RepairBudgetRemaining" | "OutputOnlyInstruction";

/**
 * Immutable policy describing bounded repair behavior and terminal exits.
 */
export interface ResponseRepairPolicyDescriptor {
  readonly schema_version: typeof RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof RESPONSE_REPAIR_CONTRACT_ID;
  readonly contract_version: typeof RESPONSE_REPAIR_CONTRACT_VERSION;
  readonly repair_policy_version: typeof RESPONSE_REPAIR_POLICY_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly firewall_contract_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION;
  readonly no_rl_contract_version: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION;
  readonly uncertainty_contract_version: typeof UNCERTAINTY_REPORTING_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly max_repair_attempts: number;
  readonly max_same_failure_attempts: number;
  readonly repairable_failure_categories: readonly ResponseRepairFailureCategory[];
  readonly terminal_failure_categories: readonly ResponseRepairFailureCategory[];
  readonly determinism_hash: string;
}

/**
 * Safe context item allowed inside a model-facing repair prompt.
 */
export interface RepairSafeContextItem {
  readonly context_ref: Ref;
  readonly provenance_label: PromptProvenanceLabel;
  readonly summary: string;
  readonly priority: number;
}

/**
 * Prior repair attempt used to enforce retry and repeated-failure budgets.
 */
export interface ResponseRepairAttemptRecord {
  readonly attempt_ref: Ref;
  readonly attempt_index: number;
  readonly source_response_ref: Ref;
  readonly failure_categories: readonly ResponseRepairFailureCategory[];
  readonly outcome: ResponseRepairAttemptOutcome;
  readonly repair_prompt_ref?: Ref;
  readonly repaired_response_ref?: Ref;
}

/**
 * Request accepted by `requestResponseRepair`.
 */
export interface ResponseRepairRequest {
  readonly repair_ref: Ref;
  readonly source_response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly raw_response: unknown;
  readonly action_bearing: boolean;
  readonly structured_validation_report?: StructuredResponseValidationReport;
  readonly firewall_report?: PromptFirewallValidationReport;
  readonly no_rl_report?: NoRLComplianceReport;
  readonly uncertainty_report?: UncertaintyReportingReport;
  readonly validator_feedback?: readonly string[];
  readonly safe_context_subset?: readonly RepairSafeContextItem[];
  readonly attempt_history?: readonly ResponseRepairAttemptRecord[];
  readonly max_repair_attempts?: number;
}

/**
 * One section of the compact repair prompt packet.
 */
export interface RepairPromptSection {
  readonly section_ref: Ref;
  readonly section_kind: ResponseRepairPromptSectionKind;
  readonly title: string;
  readonly content: string;
  readonly provenance_label: PromptProvenanceLabel;
  readonly source_refs: readonly Ref[];
  readonly required: boolean;
}

/**
 * Model-facing repair packet defined by architecture section 7.19.2.
 */
export interface RepairPromptPacket {
  readonly schema_version: typeof RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION;
  readonly repair_prompt_ref: Ref;
  readonly source_response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly sections: readonly RepairPromptSection[];
  readonly repair_budget_remaining: number;
  readonly final_repair_attempt: boolean;
  readonly output_only_instruction: string;
  readonly terminal_rejection_if_failed: boolean;
  readonly determinism_hash: string;
}

/**
 * Deterministic result for a repair decision.
 */
export interface ResponseRepairReport {
  readonly schema_version: typeof RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION;
  readonly repair_ref: Ref;
  readonly source_response_ref: Ref;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly decision: ResponseRepairDecision;
  readonly eligibility: ResponseRepairEligibility;
  readonly failure_categories: readonly ResponseRepairFailureCategory[];
  readonly repair_prompt?: RepairPromptPacket;
  readonly repair_budget_remaining: number;
  readonly safe_hold_required: boolean;
  readonly terminal_rejection_reason?: string;
  readonly human_review_reason?: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Implements bounded repair of failed structured responses. Repair is allowed
 * only for schema, formatting, confidence, and missing-field failures. Unsafe,
 * hidden-truth, direct-control, no-RL, validator-bypass, repeated malformed, or
 * exhausted-budget failures terminate into rejection or safe-hold.
 */
export class ResponseRepairContract {
  private readonly descriptor: ResponseRepairPolicyDescriptor;

  public constructor(
    private readonly maxRepairAttempts: number = DEFAULT_MAX_REPAIR_ATTEMPTS,
    private readonly maxSameFailureAttempts: number = DEFAULT_MAX_SAME_FAILURE_ATTEMPTS,
  ) {
    if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
      throw new Error("ResponseRepairContract requires a non-negative integer maxRepairAttempts.");
    }
    if (!Number.isInteger(maxSameFailureAttempts) || maxSameFailureAttempts < 1) {
      throw new Error("ResponseRepairContract requires a positive integer maxSameFailureAttempts.");
    }
    this.descriptor = buildDescriptor(maxRepairAttempts, maxSameFailureAttempts);
  }

  /**
   * Returns immutable repair policy metadata for telemetry and QA regression.
   */
  public getDescriptor(): ResponseRepairPolicyDescriptor {
    return this.descriptor;
  }

  /**
   * Classifies the failed response, enforces retry budgets, and either returns
   * a repair prompt packet or a terminal rejection/safe-hold decision.
   */
  public requestResponseRepair(request: ResponseRepairRequest): ResponseRepairReport {
    const issues: ValidationIssue[] = [];
    validateRef(request.repair_ref, "$.repair_ref", issues);
    validateRef(request.source_response_ref, "$.source_response_ref", issues);
    validateSafeContextRefs(request.safe_context_subset ?? [], issues);

    const categories = classifyFailures(request, issues);
    const maxAttempts = request.max_repair_attempts ?? this.maxRepairAttempts;
    const attemptsUsed = countRepairAttempts(request.attempt_history ?? []);
    const budgetRemaining = Math.max(0, maxAttempts - attemptsUsed);
    const repeatedCategories = repeatedFailureCategories(categories, request.attempt_history ?? [], this.maxSameFailureAttempts);
    const enrichedCategories = uniqueCategories([
      ...categories,
      ...(budgetRemaining <= 0 && categories.length > 0 ? ["retry_budget_exhausted" as const] : []),
      ...repeatedCategories,
    ]);

    if (hasReleaseDecision(request) && enrichedCategories.length === 0) {
      return makeReport(request, "no_repair_needed", "already_valid", enrichedCategories, undefined, budgetRemaining, false, undefined, undefined, issues);
    }

    const terminalCategory = enrichedCategories.find((category) => TERMINAL_FAILURE_CATEGORIES.includes(category));
    const safeHoldRequired = request.action_bearing && (terminalCategory !== undefined || hasUnsafeValidationState(request));
    if (terminalCategory !== undefined) {
      const reason = terminalReasonFor(terminalCategory, request.action_bearing);
      return makeReport(
        request,
        safeHoldRequired ? "safe_hold_required" : terminalCategory === "retry_budget_exhausted" ? "human_review_required" : "terminal_rejection",
        terminalCategory === "retry_budget_exhausted" ? "budget_exhausted" : "not_repairable",
        enrichedCategories,
        undefined,
        budgetRemaining,
        safeHoldRequired,
        safeHoldRequired ? reason : reason,
        terminalCategory === "retry_budget_exhausted" ? "Repair budget exhausted; route to human review or orchestrator safe-hold according to task state." : undefined,
        issues,
      );
    }

    if (budgetRemaining <= 0) {
      return makeReport(request, request.action_bearing ? "safe_hold_required" : "human_review_required", "budget_exhausted", enrichedCategories, undefined, 0, request.action_bearing, "Repair budget exhausted before a safe repair prompt could be generated.", "Manual review is required before another model request.", issues);
    }

    const repairableCategories = enrichedCategories.filter((category) => REPAIRABLE_FAILURE_CATEGORIES.includes(category));
    if (repairableCategories.length === 0) {
      return makeReport(request, "human_review_required", "not_repairable", enrichedCategories, undefined, budgetRemaining, request.action_bearing, undefined, "No recognized repairable failure category was available.", issues);
    }

    const prompt = buildRepairPromptPacket(request, repairableCategories, budgetRemaining - 1, budgetRemaining === 1);
    return makeReport(request, "repair_prompt_ready", "repairable", repairableCategories, prompt, budgetRemaining - 1, false, undefined, undefined, issues);
  }

  /**
   * Records a repair attempt outcome as an immutable attempt-history entry for
   * the next invocation of `requestResponseRepair`.
   */
  public makeAttemptRecord(
    attemptIndex: number,
    sourceResponseRef: Ref,
    failureCategories: readonly ResponseRepairFailureCategory[],
    outcome: ResponseRepairAttemptOutcome,
    repairPromptRef?: Ref,
    repairedResponseRef?: Ref,
  ): ResponseRepairAttemptRecord {
    if (!Number.isInteger(attemptIndex) || attemptIndex < 0) {
      throw new Error("attemptIndex must be a non-negative integer.");
    }
    const base = {
      attempt_index: attemptIndex,
      source_response_ref: sourceResponseRef,
      failure_categories: uniqueCategories(failureCategories),
      outcome,
      repair_prompt_ref: repairPromptRef,
      repaired_response_ref: repairedResponseRef,
    };
    return Object.freeze({
      attempt_ref: `repair_attempt_${computeDeterminismHash(base).slice(0, 16)}`,
      ...base,
    });
  }
}

function classifyFailures(request: ResponseRepairRequest, issues: ValidationIssue[]): readonly ResponseRepairFailureCategory[] {
  const categories: ResponseRepairFailureCategory[] = [];
  categories.push(...classifyRawResponse(request.raw_response));

  const structured = request.structured_validation_report;
  if (structured !== undefined) {
    if (structured.decision === "released" && structured.issues.length === 0) {
      return freezeArray(categories);
    }
    if (structured.decision === "rejected" || structured.decision === "escalation_required") {
      categories.push("unknown_validation_failure");
    }
    if (structured.missing_required_fields.length > 0) {
      categories.push("missing_required_field");
    }
    if (structured.unsupported_fields.length > 0) {
      categories.push("unsupported_field");
    }
    if (structured.conditional_fields_needed.some((field) => /reobserve/i.test(field))) {
      categories.push("low_confidence_without_reobserve");
    }
    for (const issueItem of structured.issues) {
      categories.push(...classifyIssue(issueItem));
    }
    if (structured.safe_hold_required) {
      categories.push("unsafe_direct_control");
    }
  }

  const firewall = request.firewall_report;
  if (firewall !== undefined) {
    if (firewall.decision === "reject" || firewall.decision === "quarantine" || firewall.quarantined) {
      categories.push("firewall_quarantine");
    }
    if (firewall.critical_count > 0 || firewall.high_count > 0) {
      categories.push("forbidden_content");
    }
  }

  const noRL = request.no_rl_report;
  if (noRL !== undefined) {
    if (noRL.decision === "non_compliant" || noRL.decision === "quarantine_required" || noRL.critical_count > 0 || noRL.quarantine_required) {
      categories.push("no_rl_violation");
    }
  }

  const uncertainty = request.uncertainty_report;
  if (uncertainty !== undefined) {
    for (const finding of uncertainty.findings) {
      if (finding.category === "low_confidence_without_reobserve" || finding.category === "blocking_uncertainty_without_reobserve") {
        categories.push("low_confidence_without_reobserve");
      }
      if (finding.category === "overconfident_under_ambiguity") {
        categories.push("overconfident_under_ambiguity");
      }
    }
  }

  for (const feedback of request.validator_feedback ?? []) {
    const sanitized = sanitizeRepairText(feedback, "validator_feedback", issues);
    categories.push(...classifyText(sanitized));
  }

  return uniqueCategories(categories);
}

function classifyRawResponse(rawResponse: unknown): readonly ResponseRepairFailureCategory[] {
  if (rawResponse === undefined || rawResponse === null) {
    return freezeArray(["empty_response"]);
  }
  if (typeof rawResponse === "string") {
    const text = rawResponse.trim();
    if (text.length === 0) {
      return freezeArray(["empty_response"]);
    }
    const categories = classifyText(text);
    if (!looksLikeJsonObject(text)) {
      return uniqueCategories(["parse_failure", ...categories]);
    }
    try {
      JSON.parse(text);
    } catch {
      return uniqueCategories(["parse_failure", ...categories]);
    }
    return categories;
  }
  return classifyText(safeStringify(rawResponse));
}

function classifyText(text: string): readonly ResponseRepairFailureCategory[] {
  const categories: ResponseRepairFailureCategory[] = [];
  if (FORBIDDEN_REPAIR_CONTEXT_PATTERN.test(text)) {
    categories.push("forbidden_content");
  }
  if (/\b(direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|motor command|servo command|control tick)\b/i.test(text)) {
    categories.push("unsafe_direct_control");
  }
  if (/\b(ignore validators|override safety|disable safe.?hold|bypass validator|skip validation|act without validation|guarantee success)\b/i.test(text)) {
    categories.push("validator_bypass");
  }
  if (/\b(reward function|policy gradient|reinforcement learning|rl update|train the policy|learned controller|q-learning|ppo|sac)\b/i.test(text) && /\b(no|not|never|without|prohibit|reject|forbid|no-rl)\b.{0,80}\b(reward|policy|reinforcement|rl|learned)\b/i.test(text) === false) {
    categories.push("no_rl_violation");
  }
  if (/^[^{[]+[{[][\s\S]*[}\]][^}\]]+$/i.test(text)) {
    categories.push("extra_prose");
  }
  return uniqueCategories(categories);
}

function classifyIssue(issueItem: ValidationIssue): readonly ResponseRepairFailureCategory[] {
  const raw = `${issueItem.code} ${issueItem.path} ${issueItem.message} ${issueItem.remediation}`.toLowerCase();
  const categories: ResponseRepairFailureCategory[] = [];
  if (/contract.*mismatch|wrong contract|response_contract_id/.test(raw)) {
    categories.push("wrong_contract_id");
  }
  if (/missing|required/.test(raw)) {
    categories.push("missing_required_field");
  }
  if (/unsupported/.test(raw)) {
    categories.push("unsupported_field");
  }
  if (/schema|envelope|object|array|type|json|parse|malformed/.test(raw)) {
    categories.push("schema_mismatch");
  }
  if (/low confidence|re-?observation|reobserve/.test(raw)) {
    categories.push("low_confidence_without_reobserve");
  }
  if (/very high confidence|overconfident|ambigu/.test(raw)) {
    categories.push("overconfident_under_ambiguity");
  }
  if (/forbidden|hidden|backend|simulator|scene graph|private reasoning/.test(raw)) {
    categories.push("forbidden_content");
  }
  if (/actuator|joint torque|motor command|direct control|safe-hold/.test(raw)) {
    categories.push("unsafe_direct_control");
  }
  if (/validator.*bypass|without validation|requires_validation/.test(raw)) {
    categories.push("validator_bypass");
  }
  return uniqueCategories(categories.length > 0 ? categories : ["unknown_validation_failure"]);
}

function buildRepairPromptPacket(
  request: ResponseRepairRequest,
  categories: readonly ResponseRepairFailureCategory[],
  budgetRemainingAfterPrompt: number,
  finalAttempt: boolean,
): RepairPromptPacket {
  const reason = buildRepairReason(request, categories);
  const contractSummary = buildContractSummary(request.expected_contract_ref, request.invocation_class);
  const safeContext = buildSafeContextText(request.safe_context_subset ?? []);
  const sourceRefs = freezeArray([request.source_response_ref, ...(request.safe_context_subset ?? []).map((item) => item.context_ref)]);
  const sections: readonly RepairPromptSection[] = freezeArray([
    makeSection("RepairReason", "Repair reason", reason, "validator_feedback", sourceRefs),
    makeSection("OriginalContractSummary", "Original contract summary", contractSummary, "schema_instruction", [request.expected_contract_ref]),
    makeSection("SafeContextSubset", "Safe context subset", safeContext, "validator_feedback", sourceRefs),
    makeSection("ForbiddenContentReminder", "Forbidden content reminder", forbiddenContentReminder(), "system_contract", [RESPONSE_REPAIR_CONTRACT_ID]),
    makeSection("RepairBudgetRemaining", "Repair budget remaining", `repair_budget_remaining=${budgetRemainingAfterPrompt}; final_repair_attempt=${finalAttempt ? "true" : "false"}`, "telemetry_label", [request.repair_ref]),
    makeSection("OutputOnlyInstruction", "Output only instruction", outputOnlyInstruction(request.expected_contract_ref), "schema_instruction", [request.expected_contract_ref]),
  ]);
  const base = {
    schema_version: RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION,
    source_response_ref: request.source_response_ref,
    invocation_class: request.invocation_class,
    expected_contract_ref: request.expected_contract_ref,
    sections,
    repair_budget_remaining: budgetRemainingAfterPrompt,
    final_repair_attempt: finalAttempt,
    output_only_instruction: outputOnlyInstruction(request.expected_contract_ref),
    terminal_rejection_if_failed: finalAttempt,
  };
  const repairPromptRef = `repair_prompt_${computeDeterminismHash(base).slice(0, 16)}`;
  const withRef = {
    repair_prompt_ref: repairPromptRef,
    ...base,
  };
  return Object.freeze({
    ...withRef,
    determinism_hash: computeDeterminismHash(withRef),
  });
}

function buildRepairReason(request: ResponseRepairRequest, categories: readonly ResponseRepairFailureCategory[]): string {
  const reasonParts: string[] = [
    `expected_contract=${request.expected_contract_ref}`,
    `invocation_class=${request.invocation_class}`,
    `failure_categories=${categories.join(",")}`,
  ];
  const structured = request.structured_validation_report;
  if (structured !== undefined) {
    if (structured.missing_required_fields.length > 0) {
      reasonParts.push(`missing_required_fields=${structured.missing_required_fields.join(",")}`);
    }
    if (structured.conditional_fields_needed.length > 0) {
      reasonParts.push(`conditional_fields_needed=${structured.conditional_fields_needed.join(",")}`);
    }
    const issueSummary = structured.issues.slice(0, 8).map((item) => `${item.code}:${item.path}`).join(",");
    if (issueSummary.length > 0) {
      reasonParts.push(`validation_issues=${issueSummary}`);
    }
  }
  const rawExcerpt = rawResponseExcerpt(request.raw_response);
  if (rawExcerpt.length > 0) {
    reasonParts.push(`raw_response_excerpt=${rawExcerpt}`);
  }
  return reasonParts.join("; ").slice(0, MAX_REPAIR_REASON_CHARS);
}

function buildContractSummary(contractRef: StructuredResponseContractRef, invocationClass: CognitiveInvocationClass): string {
  const primaryFields = PRIMARY_RESULT_FIELDS_BY_CONTRACT[contractRef];
  return [
    `Return exactly one JSON object for ${contractRef}.`,
    `The invocation class is ${invocationClass}.`,
    `Top-level required fields: response_contract_id, contract_version_ack, task_state_ref, evidence_used, primary_result, confidence, uncertainties, requires_validation, safety_notes, forbidden_content_absent.`,
    `primary_result required fields: ${primaryFields.join(", ")}.`,
    `Use contract_version_ack=${STRUCTURED_RESPONSE_CONTRACT_VERSION}.`,
    "Use confidence.value from very_low, low, medium, high, very_high.",
    "Every uncertainty must include category, description, evidence_refs, and requires_reobserve.",
  ].join(" ");
}

function buildSafeContextText(items: readonly RepairSafeContextItem[]): string {
  const sorted = [...items]
    .filter((item) => item.summary.trim().length > 0)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_SAFE_CONTEXT_ITEMS);
  if (sorted.length === 0) {
    return "No additional context is available. Repair only the response shape and uncertainty discipline using the original contract summary.";
  }
  const lines: string[] = [];
  let charBudget = MAX_SAFE_CONTEXT_CHARS;
  for (const item of sorted) {
    const sanitized = sanitizeRepairText(item.summary, item.context_ref, []);
    const line = `${item.context_ref} [${item.provenance_label}]: ${sanitized}`;
    if (charBudget - line.length < 0) {
      break;
    }
    lines.push(line);
    charBudget -= line.length;
  }
  return lines.length === 0 ? "Safe context was removed because it contained disallowed repair-context content." : lines.join("\n");
}

function forbiddenContentReminder(): string {
  return "Do not include hidden world data, backend identifiers, simulator or engine references, QA-only truth, private reasoning, executable code, direct actuator commands, reward-policy language, validator bypass language, or claims of execution authority.";
}

function outputOnlyInstruction(contractRef: StructuredResponseContractRef): string {
  return `Output only the corrected ${contractRef} JSON object. Do not add markdown, prose, explanations, code fences, or alternate formats. If evidence is insufficient, lower confidence and include reobserve_request rather than guessing.`;
}

function makeSection(
  sectionKind: ResponseRepairPromptSectionKind,
  title: string,
  content: string,
  provenanceLabel: PromptProvenanceLabel,
  sourceRefs: readonly Ref[],
): RepairPromptSection {
  const base = {
    section_kind: sectionKind,
    title,
    content,
    provenance_label: provenanceLabel,
    source_refs: freezeArray(sourceRefs),
    required: true,
  };
  return Object.freeze({
    section_ref: `repair_section_${sectionKind}_${computeDeterminismHash(base).slice(0, 12)}`,
    ...base,
  });
}

function makeReport(
  request: ResponseRepairRequest,
  decision: ResponseRepairDecision,
  eligibility: ResponseRepairEligibility,
  categories: readonly ResponseRepairFailureCategory[],
  prompt: RepairPromptPacket | undefined,
  budgetRemaining: number,
  safeHoldRequired: boolean,
  terminalRejectionReason: string | undefined,
  humanReviewReason: string | undefined,
  issues: readonly ValidationIssue[],
): ResponseRepairReport {
  const base = {
    schema_version: RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION,
    repair_ref: request.repair_ref,
    source_response_ref: request.source_response_ref,
    expected_contract_ref: request.expected_contract_ref,
    decision,
    eligibility,
    failure_categories: uniqueCategories(categories),
    repair_prompt: prompt,
    repair_budget_remaining: Math.max(0, budgetRemaining),
    safe_hold_required: safeHoldRequired,
    terminal_rejection_reason: terminalRejectionReason,
    human_review_reason: humanReviewReason,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function countRepairAttempts(history: readonly ResponseRepairAttemptRecord[]): number {
  return history.filter((attempt) => attempt.outcome === "repair_prompt_sent" || attempt.outcome === "repaired_response_rejected").length;
}

function repeatedFailureCategories(
  categories: readonly ResponseRepairFailureCategory[],
  history: readonly ResponseRepairAttemptRecord[],
  maxSameFailureAttempts: number,
): readonly ResponseRepairFailureCategory[] {
  const repeated: ResponseRepairFailureCategory[] = [];
  for (const category of categories) {
    const priorCount = history.filter((attempt) => attempt.failure_categories.includes(category)).length;
    if (priorCount >= maxSameFailureAttempts) {
      repeated.push("repeated_malformed_output");
    }
  }
  return uniqueCategories(repeated);
}

function hasReleaseDecision(request: ResponseRepairRequest): boolean {
  return request.structured_validation_report?.decision === "released"
    && request.firewall_report?.decision !== "reject"
    && request.firewall_report?.decision !== "quarantine"
    && request.no_rl_report?.decision !== "non_compliant"
    && request.no_rl_report?.decision !== "quarantine_required"
    && request.uncertainty_report?.decision !== "repair_required"
    && request.uncertainty_report?.decision !== "reobserve_required";
}

function hasUnsafeValidationState(request: ResponseRepairRequest): boolean {
  return request.structured_validation_report?.safe_hold_required === true
    || request.firewall_report?.decision === "reject"
    || request.firewall_report?.decision === "quarantine"
    || request.no_rl_report?.decision === "non_compliant"
    || request.no_rl_report?.decision === "quarantine_required";
}

function terminalReasonFor(category: ResponseRepairFailureCategory, actionBearing: boolean): string {
  const suffix = actionBearing ? " Action-bearing output must route to safe-hold before any retry." : "";
  switch (category) {
    case "forbidden_content":
      return `Repair rejected because the response or context contains hidden-truth, private-reasoning, direct-control, or validator-bypass content.${suffix}`;
    case "unsafe_direct_control":
      return `Repair rejected because the response attempted direct actuator or low-level control.${suffix}`;
    case "validator_bypass":
      return `Repair rejected because the response bypassed deterministic validator authority.${suffix}`;
    case "no_rl_violation":
      return `Repair rejected because the response violated the no-RL symbolic-planning boundary.${suffix}`;
    case "firewall_quarantine":
      return `Repair rejected because the firewall quarantined the response or repair context.${suffix}`;
    case "retry_budget_exhausted":
      return `Repair budget is exhausted.${suffix}`;
    case "repeated_malformed_output":
      return `Repair rejected because the same malformed output class repeated after the allowed repair attempt.${suffix}`;
    default:
      return `Repair rejected for non-repairable category ${category}.${suffix}`;
  }
}

function validateSafeContextRefs(items: readonly RepairSafeContextItem[], issues: ValidationIssue[]): void {
  for (const [index, item] of items.entries()) {
    validateRef(item.context_ref, `$.safe_context_subset[${index}].context_ref`, issues);
    if (!Number.isFinite(item.priority)) {
      issues.push(issue("error", "SafeContextPriorityInvalid", `$.safe_context_subset[${index}].priority`, "Safe context priority must be finite.", "Use a numeric priority for deterministic repair prompt ordering."));
    }
    if (FORBIDDEN_REPAIR_CONTEXT_PATTERN.test(item.summary)) {
      issues.push(issue("warning", "SafeContextSanitized", `$.safe_context_subset[${index}].summary`, "Safe context contains disallowed repair-boundary wording and will be redacted.", "Provide prompt-safe validator reason classes only."));
    }
  }
}

function sanitizeRepairText(text: string, sourceRef: Ref, issues: ValidationIssue[]): string {
  let sanitized = text.replace(/\s+/g, " ").trim();
  if (FORBIDDEN_REPAIR_CONTEXT_PATTERN.test(sanitized)) {
    issues.push(issue("warning", "RepairContextRedacted", sourceRef, "Repair context contained disallowed model-facing content.", "Use compact validator reason classes rather than internal details."));
    sanitized = sanitized.replace(FORBIDDEN_REPAIR_CONTEXT_PATTERN, "[redacted]");
  }
  return sanitized;
}

function rawResponseExcerpt(rawResponse: unknown): string {
  const text = typeof rawResponse === "string" ? rawResponse : safeStringify(rawResponse);
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_RAW_RESPONSE_EXCERPT_CHARS);
}

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_REPAIR_CONTEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden repair-boundary terminology.", "Use a prompt-safe opaque reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "" : text;
  } catch {
    return "";
  }
}

function uniqueCategories(items: readonly ResponseRepairFailureCategory[]): readonly ResponseRepairFailureCategory[] {
  return freezeArray([...new Set(items)]);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function buildDescriptor(maxRepairAttempts: number, maxSameFailureAttempts: number): ResponseRepairPolicyDescriptor {
  const base = {
    schema_version: RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION,
    contract_id: RESPONSE_REPAIR_CONTRACT_ID,
    contract_version: RESPONSE_REPAIR_CONTRACT_VERSION,
    repair_policy_version: RESPONSE_REPAIR_POLICY_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    firewall_contract_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION,
    no_rl_contract_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION,
    uncertainty_contract_version: UNCERTAINTY_REPORTING_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    max_repair_attempts: maxRepairAttempts,
    max_same_failure_attempts: maxSameFailureAttempts,
    repairable_failure_categories: REPAIRABLE_FAILURE_CATEGORIES,
    terminal_failure_categories: TERMINAL_FAILURE_CATEGORIES,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

const REPAIRABLE_FAILURE_CATEGORIES: readonly ResponseRepairFailureCategory[] = freezeArray([
  "parse_failure",
  "schema_mismatch",
  "missing_required_field",
  "wrong_contract_id",
  "unsupported_field",
  "extra_prose",
  "low_confidence_without_reobserve",
  "overconfident_under_ambiguity",
  "empty_response",
  "unknown_validation_failure",
]);

const TERMINAL_FAILURE_CATEGORIES: readonly ResponseRepairFailureCategory[] = freezeArray([
  "forbidden_content",
  "unsafe_direct_control",
  "validator_bypass",
  "no_rl_violation",
  "firewall_quarantine",
  "retry_budget_exhausted",
  "repeated_malformed_output",
]);

const PRIMARY_RESULT_FIELDS_BY_CONTRACT: Readonly<Record<StructuredResponseContractRef, readonly string[]>> = Object.freeze({
  SceneUnderstandingResponse: freezeArray(["visible_object_hypotheses", "object_relationships", "affordance_hypotheses", "occlusion_report", "safety_relevant_observations"]),
  TaskPlanResponse: freezeArray(["task_interpretation", "assumptions", "ordered_phases", "object_roles", "embodiment_considerations", "validation_checkpoints", "fallback_strategy", "requires_waypoint_generation"]),
  WaypointPlanResponse: freezeArray(["waypoint_intent", "reference_evidence", "target_relation", "candidate_waypoints", "preconditions", "postconditions", "risk_notes", "validator_handoff"]),
  MultiViewConsensusResponse: freezeArray(["view_inventory", "consensus_objects", "conflicting_hypotheses", "occlusion_explanation", "pose_confidence", "planning_readiness"]),
  VisualVerificationResponse: freezeArray(["target_constraint_summary", "visual_evidence_for_success", "visual_evidence_against_success", "constraint_status", "memory_update_readiness"]),
  CorrectionPlanResponse: freezeArray(["failure_summary", "ranked_cause_hypotheses", "immediate_safety_action", "corrective_strategy", "changed_assumptions", "new_validation_requirements"]),
  ToolUsePlanResponse: freezeArray(["reach_limitation_summary", "tool_candidates", "swept_volume_concerns", "verification_plan"]),
  AudioActionResponse: freezeArray(["audio_event_interpretation", "visual_reconciliation", "recommended_action", "safety_relevance"]),
  MemoryWriteCandidateResponse: freezeArray(["episode_summary", "contradictions_detected", "staleness_policy", "write_readiness", "retrieval_tags"]),
  MonologueResponse: freezeArray(["speech_text", "action_summary", "evidence_summary", "interrupt_policy"]),
});

export const RESPONSE_REPAIR_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RESPONSE_REPAIR_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprints: freezeArray([
    "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
    "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
    "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  ]),
  sections: freezeArray(["7.3", "7.6", "7.7", "7.19", "7.22", "7.23", "7.24"]),
});
