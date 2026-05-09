/**
 * No-RL prompt compliance contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.2, 7.3, 7.7, 7.8, 7.11, and 7.24.
 *
 * This module implements the executable `NoRLPromptComplianceContract`. It
 * rejects reward optimization, policy-gradient language, learned motor updates,
 * online trial-and-error controller tuning, simulator-trained controller logic,
 * and model-as-policy authority while allowing symbolic plans, validator-bound
 * waypoints, constraints, correction proposals, and explicit no-RL reminders.
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
import { STRUCTURED_RESPONSE_CONTRACT_VERSION } from "./structured_response_contract";
import type { StructuredResponseEnvelope } from "./structured_response_contract";

export const NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION = "mebsuta.no_rl_prompt_compliance_contract.v1" as const;
export const NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION = "1.0.0" as const;
export const NO_RL_PROMPT_COMPLIANCE_CONTRACT_ID = "PROMPT-NO-RL-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#NoRLPromptComplianceContract" as const;
const NO_RL_POLICY_VERSION = "no_rl_symbolic_planning_only_v1" as const;
const MAX_SCANNED_TEXT_CHARS = 32000;

export type NoRLScanSurface =
  | "prompt_packet"
  | "prompt_section"
  | "response_payload"
  | "validator_handoff"
  | "raw_text";

export type NoRLViolationCategory =
  | "reward_optimization"
  | "policy_gradient"
  | "reinforcement_learning_algorithm"
  | "learned_motor_policy"
  | "online_trial_and_error"
  | "simulator_trained_controller"
  | "model_as_execution_policy"
  | "direct_low_level_control"
  | "adaptive_controller_update"
  | "unbounded_exploration";

export type NoRLSeverity = "critical" | "high" | "medium";
export type NoRLComplianceDecision = "compliant" | "compliant_with_warnings" | "non_compliant" | "quarantine_required";

export interface NoRLComplianceRule {
  readonly category: NoRLViolationCategory;
  readonly severity: NoRLSeverity;
  readonly description: string;
  readonly remediation: string;
  readonly quarantine_required: boolean;
}

export interface NoRLPolicyDescriptor {
  readonly schema_version: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_ID;
  readonly contract_version: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly no_rl_policy_version: typeof NO_RL_POLICY_VERSION;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly allowed_output_forms: readonly NoRLAllowedOutputForm[];
  readonly rules: readonly NoRLComplianceRule[];
  readonly determinism_hash: string;
}

export type NoRLAllowedOutputForm =
  | "symbolic_plan"
  | "validator_bound_waypoint"
  | "constraint_set"
  | "correction_proposal"
  | "observation_request"
  | "public_monologue"
  | "memory_candidate";

export interface NoRLViolation {
  readonly violation_ref: Ref;
  readonly surface: NoRLScanSurface;
  readonly category: NoRLViolationCategory;
  readonly severity: NoRLSeverity;
  readonly path: string;
  readonly matched_excerpt: string;
  readonly remediation: string;
  readonly quarantine_required: boolean;
}

export interface NoRLTextScanRequest {
  readonly scan_ref: Ref;
  readonly surface: NoRLScanSurface;
  readonly text: string;
  readonly path?: string;
  readonly invocation_class?: CognitiveInvocationClass;
}

export interface NoRLComplianceReport {
  readonly schema_version: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION;
  readonly no_rl_policy_version: typeof NO_RL_POLICY_VERSION;
  readonly decision: NoRLComplianceDecision;
  readonly scan_ref: Ref;
  readonly inspected_surfaces: readonly NoRLScanSurface[];
  readonly violation_count: number;
  readonly critical_count: number;
  readonly high_count: number;
  readonly quarantine_required: boolean;
  readonly allowed_output_forms_detected: readonly NoRLAllowedOutputForm[];
  readonly violations: readonly NoRLViolation[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Enforces Project Mebsuta's no-RL boundary for prompt and response content.
 * The scanner is context-aware enough to allow phrases such as "no reward
 * optimization" while rejecting instructions to learn reward policies, update
 * movement policies, train controllers, or treat model output as a live policy.
 */
export class NoRLPromptComplianceContract {
  private readonly descriptor: NoRLPolicyDescriptor;
  private readonly rules: Readonly<Record<NoRLViolationCategory, NoRLComplianceRule>>;

  public constructor(rules: readonly NoRLComplianceRule[] = DEFAULT_NO_RL_RULES) {
    this.rules = indexRules(rules);
    this.descriptor = buildDescriptor(Object.values(this.rules));
  }

  /**
   * Returns immutable policy metadata for telemetry, prompt regression, and
   * adapter preflight.
   */
  public getDescriptor(): NoRLPolicyDescriptor {
    return this.descriptor;
  }

  /**
   * Validates a full prompt packet for no-RL compliance, including section
   * content, section refs, task-state refs, media refs, and telemetry labels.
   */
  public validatePromptPacket(packet: CognitivePromptPacketCandidate): NoRLComplianceReport {
    const issues: ValidationIssue[] = [];
    const violations: NoRLViolation[] = [];
    const allowedForms: NoRLAllowedOutputForm[] = [];
    const surfaces: NoRLScanSurface[] = ["prompt_packet"];
    validateRef(packet.packet_ref, "$.packet_ref", issues);
    validateRef(packet.task_state_ref, "$.task_state_ref", issues);
    scanText(packet.packet_ref, "$.packet_ref", "prompt_packet", this.rules, violations, allowedForms);
    scanText(packet.task_state_ref, "$.task_state_ref", "prompt_packet", this.rules, violations, allowedForms);

    for (const [index, mediaRef] of packet.media_refs.entries()) {
      validateRef(mediaRef, `$.media_refs[${index}]`, issues);
      scanText(mediaRef, `$.media_refs[${index}]`, "prompt_packet", this.rules, violations, allowedForms);
    }
    for (const [index, label] of packet.telemetry_labels.entries()) {
      validateRef(label, `$.telemetry_labels[${index}]`, issues);
      scanText(label, `$.telemetry_labels[${index}]`, "prompt_packet", this.rules, violations, allowedForms);
    }
    for (const [index, section] of packet.sections.entries()) {
      surfaces.push("prompt_section");
      const report = this.validatePromptSection(section, `$.sections[${index}]`);
      violations.push(...report.violations);
      issues.push(...report.issues);
      allowedForms.push(...report.allowed_output_forms_detected);
    }
    return makeReport(packet.packet_ref, surfaces, violations, issues, allowedForms);
  }

  /**
   * Validates one prompt section and verifies that action-bearing instructions
   * remain symbolic and validator-bound rather than policy-learning requests.
   */
  public validatePromptSection(section: CognitivePromptPacketSection, path: string = "$.section"): NoRLComplianceReport {
    const issues: ValidationIssue[] = [];
    const violations: NoRLViolation[] = [];
    const allowedForms: NoRLAllowedOutputForm[] = [];
    validateRef(section.section_ref, `${path}.section_ref`, issues);
    validateRef(section.source_ref, `${path}.source_ref`, issues);
    if (section.title.trim().length === 0 || section.content.trim().length === 0) {
      issues.push(issue("error", "NoRLPromptSectionEmpty", path, "No-RL compliance cannot approve an empty prompt section.", "Provide explicit symbolic planning, evidence, or contract text."));
    }
    scanText(section.section_ref, `${path}.section_ref`, "prompt_section", this.rules, violations, allowedForms);
    scanText(section.source_ref, `${path}.source_ref`, "prompt_section", this.rules, violations, allowedForms);
    scanText(section.title, `${path}.title`, "prompt_section", this.rules, violations, allowedForms);
    scanText(section.content, `${path}.content`, "prompt_section", this.rules, violations, allowedForms);
    if (isActionBearingSection(section) && hasValidatorBoundary(section.content) === false) {
      violations.push(makeViolation("prompt_section", "model_as_execution_policy", `${path}.content`, "missing validator boundary", this.rules));
    }
    return makeReport(section.section_ref, ["prompt_section"], violations, issues, allowedForms);
  }

  /**
   * Validates arbitrary text such as repair context, prompt templates, or
   * monologue candidates.
   */
  public scanTextBoundary(request: NoRLTextScanRequest): NoRLComplianceReport {
    const issues: ValidationIssue[] = [];
    const violations: NoRLViolation[] = [];
    const allowedForms: NoRLAllowedOutputForm[] = [];
    validateRef(request.scan_ref, "$.scan_ref", issues);
    if (request.text.trim().length === 0) {
      issues.push(issue("error", "NoRLTextEmpty", "$.text", "No-RL scan text must be non-empty.", "Provide the exact model-facing or response text."));
    }
    if (request.text.length > MAX_SCANNED_TEXT_CHARS) {
      issues.push(issue("warning", "NoRLTextLarge", "$.text", "Text exceeds the no-RL field size target.", "Compact context before model submission."));
    }
    scanText(request.text, request.path ?? "$.text", request.surface, this.rules, violations, allowedForms);
    if (isActionBearingInvocation(request.invocation_class) && hasValidatorBoundary(request.text) === false) {
      violations.push(makeViolation(request.surface, "model_as_execution_policy", request.path ?? "$.text", "missing validator boundary", this.rules));
    }
    return makeReport(request.scan_ref, [request.surface], violations, issues, allowedForms);
  }

  /**
   * Deep-scans a parsed structured response. Action-bearing envelopes must keep
   * `requires_validation` true and must avoid RL, direct-control, or model-policy
   * language in every nested string or field name.
   */
  public validateStructuredResponse(responseRef: Ref, payload: unknown, invocationClass?: CognitiveInvocationClass): NoRLComplianceReport {
    const issues: ValidationIssue[] = [];
    const violations: NoRLViolation[] = [];
    const allowedForms: NoRLAllowedOutputForm[] = [];
    validateRef(responseRef, "$.response_ref", issues);
    scanUnknown(payload, "$.payload", "response_payload", this.rules, violations, allowedForms);
    if (isStructuredResponseEnvelope(payload) && (payload.requires_validation !== true && isActionBearingInvocation(invocationClass))) {
      violations.push(makeViolation("response_payload", "model_as_execution_policy", "$.payload.requires_validation", "requires_validation=false", this.rules));
    }
    return makeReport(responseRef, ["response_payload"], violations, issues, allowedForms);
  }
}

function scanUnknown(
  value: unknown,
  path: string,
  surface: NoRLScanSurface,
  rules: Readonly<Record<NoRLViolationCategory, NoRLComplianceRule>>,
  violations: NoRLViolation[],
  allowedForms: NoRLAllowedOutputForm[],
): void {
  if (typeof value === "string") {
    scanText(value, path, surface, rules, violations, allowedForms);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanUnknown(entry, `${path}[${index}]`, surface, rules, violations, allowedForms));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scanText(key, `${path}.${key}:key`, surface, rules, violations, allowedForms);
      scanUnknown(entry, `${path}.${key}`, surface, rules, violations, allowedForms);
    }
  }
}

function scanText(
  text: string,
  path: string,
  surface: NoRLScanSurface,
  rules: Readonly<Record<NoRLViolationCategory, NoRLComplianceRule>>,
  violations: NoRLViolation[],
  allowedForms: NoRLAllowedOutputForm[],
): void {
  if (text.trim().length === 0) {
    return;
  }
  const normalized = text.replace(/\s+/g, " ");
  for (const detector of NO_RL_DETECTORS) {
    for (const match of normalized.matchAll(detector.pattern)) {
      if (isNegatedNoRLStatement(normalized, match.index ?? 0)) {
        continue;
      }
      violations.push(makeViolation(surface, detector.category, path, match[0], rules));
      break;
    }
  }
  for (const detector of ALLOWED_OUTPUT_FORM_DETECTORS) {
    if (detector.pattern.test(normalized)) {
      allowedForms.push(detector.output_form);
    }
  }
}

function isNegatedNoRLStatement(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - 72);
  const windowEnd = Math.min(text.length, matchIndex + 96);
  const window = text.slice(windowStart, windowEnd);
  return /\b(no|not|never|without|prohibit|prohibits|forbid|forbids|reject|rejects|ban|bans|must not|do not|does not)\b[^.]{0,80}\b(reward|policy gradient|reinforcement learning|rl|learned policy|train|controller update)\b/i.test(window)
    || /\b(no-rl|no rl)\b/i.test(window);
}

function hasValidatorBoundary(text: string): boolean {
  return /\b(validator|validation|validate|validated|requires_validation|handoff|controller gate|deterministic|safe-hold|safe hold)\b/i.test(text);
}

function isActionBearingSection(section: CognitivePromptPacketSection): boolean {
  return section.section_kind === "TaskInstruction"
    || section.section_kind === "OutputContractInstruction"
    || section.section_kind === "ValidationFeedback"
    || section.section_kind === "SafetyPolicySummary";
}

function isActionBearingInvocation(invocationClass: CognitiveInvocationClass | undefined): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function isStructuredResponseEnvelope(value: unknown): value is StructuredResponseEnvelope {
  return isRecord(value)
    && typeof value.response_contract_id === "string"
    && typeof value.contract_version_ack === "string"
    && "requires_validation" in value;
}

function makeReport(
  scanRef: Ref,
  surfaces: readonly NoRLScanSurface[],
  violations: readonly NoRLViolation[],
  issues: readonly ValidationIssue[],
  allowedForms: readonly NoRLAllowedOutputForm[],
): NoRLComplianceReport {
  const criticalCount = violations.filter((violation) => violation.severity === "critical").length;
  const highCount = violations.filter((violation) => violation.severity === "high").length;
  const quarantineRequired = violations.some((violation) => violation.quarantine_required);
  const hasErrors = issues.some((item) => item.severity === "error");
  const decision: NoRLComplianceDecision = hasErrors || criticalCount > 0
    ? "non_compliant"
    : quarantineRequired
      ? "quarantine_required"
      : violations.length > 0 || issues.length > 0
        ? "compliant_with_warnings"
        : "compliant";
  const base = {
    schema_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION,
    no_rl_policy_version: NO_RL_POLICY_VERSION,
    decision,
    scan_ref: scanRef,
    inspected_surfaces: freezeArray([...new Set(surfaces)]),
    violation_count: violations.length,
    critical_count: criticalCount,
    high_count: highCount,
    quarantine_required: quarantineRequired,
    allowed_output_forms_detected: freezeArray([...new Set(allowedForms)]),
    violations: freezeArray(violations),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeViolation(
  surface: NoRLScanSurface,
  category: NoRLViolationCategory,
  path: string,
  matchedExcerpt: string,
  rules: Readonly<Record<NoRLViolationCategory, NoRLComplianceRule>>,
): NoRLViolation {
  const rule = rules[category];
  const base = {
    surface,
    category,
    severity: rule.severity,
    path,
    matched_excerpt: matchedExcerpt.replace(/\s+/g, " ").trim().slice(0, 180),
    remediation: rule.remediation,
    quarantine_required: rule.quarantine_required,
  };
  return Object.freeze({
    violation_ref: `no_rl_${computeDeterminismHash(base).slice(0, 16)}`,
    ...base,
  });
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function indexRules(rules: readonly NoRLComplianceRule[]): Readonly<Record<NoRLViolationCategory, NoRLComplianceRule>> {
  const map = new Map<NoRLViolationCategory, NoRLComplianceRule>();
  for (const rule of rules) {
    map.set(rule.category, Object.freeze({ ...rule }));
  }
  const missing = ALL_NO_RL_CATEGORIES.filter((category) => map.has(category) === false);
  if (missing.length > 0) {
    throw new Error(`NoRLPromptComplianceContract missing rules: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_NO_RL_CATEGORIES.map((category) => [category, map.get(category) as NoRLComplianceRule])) as Record<NoRLViolationCategory, NoRLComplianceRule>);
}

function buildDescriptor(rules: readonly NoRLComplianceRule[]): NoRLPolicyDescriptor {
  const base = {
    schema_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION,
    contract_id: NO_RL_PROMPT_COMPLIANCE_CONTRACT_ID,
    contract_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    no_rl_policy_version: NO_RL_POLICY_VERSION,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    allowed_output_forms: ALLOWED_OUTPUT_FORMS,
    rules: freezeArray(rules),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function rule(category: NoRLViolationCategory, severity: NoRLSeverity, description: string, remediation: string, quarantineRequired: boolean): NoRLComplianceRule {
  return Object.freeze({
    category,
    severity,
    description,
    remediation,
    quarantine_required: quarantineRequired,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

interface NoRLDetector {
  readonly category: NoRLViolationCategory;
  readonly pattern: RegExp;
}

interface AllowedOutputDetector {
  readonly output_form: NoRLAllowedOutputForm;
  readonly pattern: RegExp;
}

const ALL_NO_RL_CATEGORIES: readonly NoRLViolationCategory[] = freezeArray([
  "reward_optimization",
  "policy_gradient",
  "reinforcement_learning_algorithm",
  "learned_motor_policy",
  "online_trial_and_error",
  "simulator_trained_controller",
  "model_as_execution_policy",
  "direct_low_level_control",
  "adaptive_controller_update",
  "unbounded_exploration",
]);

const ALLOWED_OUTPUT_FORMS: readonly NoRLAllowedOutputForm[] = freezeArray([
  "symbolic_plan",
  "validator_bound_waypoint",
  "constraint_set",
  "correction_proposal",
  "observation_request",
  "public_monologue",
  "memory_candidate",
]);

const NO_RL_DETECTORS: readonly NoRLDetector[] = freezeArray([
  { category: "reward_optimization", pattern: /\b(reward (function|signal|model|optimization|maximization|shaping|weight|return)|optimize rewards?|maximize cumulative reward|train from reward)\b/gi },
  { category: "policy_gradient", pattern: /\b(policy gradient|ppo|proximal policy optimization|sac|soft actor critic|actor critic|reinforce algorithm|q-learning|deep q network|dqn|td learning|temporal difference)\b/gi },
  { category: "reinforcement_learning_algorithm", pattern: /\b(reinforcement learning|rl agent|rl policy|rl update|rl rollout|exploration bonus|epsilon greedy|markov decision process|mdp)\b/gi },
  { category: "learned_motor_policy", pattern: /\b(learned motor policy|learned controller|neural controller|imitation policy|behavior cloning|train the policy|update the movement policy)\b/gi },
  { category: "online_trial_and_error", pattern: /\b(trial and error|try random actions|random exploration|learn from failed attempts|self-improve through attempts|explore until success)\b/gi },
  { category: "simulator_trained_controller", pattern: /\b(simulator-trained|trained in simulation|train in the physics environment|domain randomization|sim-to-real policy|rollout training)\b/gi },
  { category: "model_as_execution_policy", pattern: /\b(model policy|gemini policy|use the model as controller|model decides motion|model controls execution|unvalidated command stream|execute model action directly)\b/gi },
  { category: "direct_low_level_control", pattern: /\b(joint torque|joint current|raw actuator|direct actuator|motor command|servo command|set joint|apply force|apply impulse|controller tick)\b/gi },
  { category: "adaptive_controller_update", pattern: /\b(update controller gains from outcome|adapt gains from reward|learn gains online|automatic reward tuning|online controller update|policy update)\b/gi },
  { category: "unbounded_exploration", pattern: /\b(unbounded exploration|open-ended exploration|keep trying until it works|no retry limit|infinite retry|ignore retry budget)\b/gi },
]);

const ALLOWED_OUTPUT_FORM_DETECTORS: readonly AllowedOutputDetector[] = freezeArray([
  { output_form: "symbolic_plan", pattern: /\b(symbolic plan|ordered phases|task decomposition|high-level plan|plan proposal)\b/i },
  { output_form: "validator_bound_waypoint", pattern: /\b(waypoint|object-relative target|image-normalized|validator handoff|requires validation)\b/i },
  { output_form: "constraint_set", pattern: /\b(constraint|tolerance|precondition|postcondition|safety note)\b/i },
  { output_form: "correction_proposal", pattern: /\b(correction proposal|corrective strategy|failure summary|retry budget)\b/i },
  { output_form: "observation_request", pattern: /\b(re-observe|reobserve|observation request|additional evidence|next view)\b/i },
  { output_form: "public_monologue", pattern: /\b(public rationale|speech text|monologue|tts)\b/i },
  { output_form: "memory_candidate", pattern: /\b(memory candidate|episode summary|retrieval tag|write readiness)\b/i },
]);

const DEFAULT_NO_RL_RULES: readonly NoRLComplianceRule[] = freezeArray([
  rule("reward_optimization", "critical", "Content requests reward optimization or reward-policy behavior.", "Use symbolic plans, explicit constraints, and deterministic validation instead.", true),
  rule("policy_gradient", "critical", "Content references policy-gradient or value-learning algorithms.", "Remove RL algorithm language and route through no-RL prompt repair.", true),
  rule("reinforcement_learning_algorithm", "critical", "Content requests reinforcement-learning behavior.", "State that the architecture is no-RL and request structured proposals only.", true),
  rule("learned_motor_policy", "critical", "Content asks for learned motor policy behavior.", "Use IK, trajectory, PD, and validator-bound waypoint contracts.", true),
  rule("online_trial_and_error", "high", "Content asks the agent to learn by open trial and error.", "Use bounded retry budgets, Oops Loop correction, and safe-hold.", true),
  rule("simulator_trained_controller", "critical", "Content depends on simulator-trained controller logic.", "Use deterministic controllers and inspected gain schedules.", true),
  rule("model_as_execution_policy", "critical", "Content treats model output as execution policy or controller authority.", "Route model outputs to deterministic validators before control.", true),
  rule("direct_low_level_control", "critical", "Content asks for low-level actuator or controller commands.", "Request high-level symbolic actions or validated waypoints.", true),
  rule("adaptive_controller_update", "high", "Content updates controllers from reward or outcome feedback.", "Use reviewed deterministic parameter changes outside model prompts.", true),
  rule("unbounded_exploration", "high", "Content permits unbounded exploration or retry behavior.", "Use finite steps, retry limits, validation checkpoints, and safe-hold.", true),
]);

export const NO_RL_PROMPT_COMPLIANCE_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprints: freezeArray([
    "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
    "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md",
  ]),
  sections: freezeArray(["7.2", "7.3", "7.7", "7.8", "7.11", "7.24"]),
});
