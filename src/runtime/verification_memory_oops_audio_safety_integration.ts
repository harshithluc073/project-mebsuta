/**
 * PIT-B09 verification, memory, Oops, audio, and safety integration.
 *
 * This boundary composes the existing File 13, 14, 15, 16, and 18 contracts.
 * It keeps success certificates as the only exact-memory authority, admits
 * correction through evidence-backed Oops packets, treats acoustic evidence as
 * uncertain context, and preserves SafeHold/HumanReview authority.
 */

import { writeAcousticMemory, type AcousticMemoryWriteSet, type AcousticMemoryWriterPolicy } from "../acoustic/audio_memory_writer";
import { selectAudioReasoningRoutes, type AudioRouteDecisionSet, type AudioRoutingPolicy } from "../acoustic/audio_reasoning_router";
import type { AudioTaskCorrelationSet } from "../acoustic/audio_task_correlator";
import { OopsIntakeRouter, type OopsAdmissionReport, type OopsPolicy, type OopsRouteDecision, type OopsSafetyState, type OopsTrigger } from "../oops/oops_intake_router";
import { OopsRetryBudgetManager, type OopsRetryBudgetReport } from "../oops/oops_retry_budget_manager";
import {
  SafeHoldStateManager,
  type SafeHoldEntryRequest,
  type SafeHoldEvidenceUpdate,
  type SafeHoldExitDecision,
  type SafeHoldRecoveryPolicy,
} from "../safety/safe_hold_state_manager";
import type { SafeHoldState } from "../safety/safety_policy_registry";
import { computeDeterminismHash, type Ref, type ValidationIssue } from "../simulation/world_manifest";
import { MemoryCommitGate, type MemoryCommitGateReport, type VerifiedSpatialMemoryCandidate } from "../verification/memory_commit_gate";
import { OopsHandoffRouter, type OopsHandoffRouterReport, type OopsHandoffRouterRequest } from "../verification/oops_handoff_router";
import {
  TaskSuccessCertificateIssuer,
  type TaskSuccessCertificate,
  type TaskSuccessCertificateIssuerReport,
  type TaskSuccessCertificateRequest,
} from "../verification/task_success_certificate_issuer";
import type { VerificationMemoryPolicy, VerificationRouteDecision } from "../verification/verification_policy_registry";

export const VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_SCHEMA_VERSION = "mebsuta.runtime.verification_memory_oops_audio_safety_integration.v1" as const;
export const VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_STEP_REF = "PIT-B09" as const;

export type VerificationMemoryOopsAudioSafetyDecision =
  | "ready_for_runtime_continuation"
  | "reobserve_required"
  | "safe_hold_required"
  | "human_review_required"
  | "blocked_by_certificate"
  | "blocked_by_memory_gate"
  | "blocked_by_oops_gate"
  | "blocked_by_audio_gate";

export interface VerificationMemoryOopsAudioSafetyInput {
  readonly integration_ref: Ref;
  readonly task_ref: Ref;
  readonly primitive_ref: Ref;
  readonly actor_ref: Ref;
  readonly occurred_at_ms: number;
  readonly certificate_request: TaskSuccessCertificateRequest;
  readonly memory_candidates: readonly VerifiedSpatialMemoryCandidate[];
  readonly memory_policy?: VerificationMemoryPolicy;
  readonly maximum_memory_evidence_age_ms?: number;
  readonly oops_handoff_request?: Omit<OopsHandoffRouterRequest, "certificate">;
  readonly oops_policy?: OopsPolicy;
  readonly oops_safety_state?: OopsSafetyState;
  readonly audio_correlation_set?: AudioTaskCorrelationSet;
  readonly audio_routing_policy?: AudioRoutingPolicy;
  readonly acoustic_memory_policy?: AcousticMemoryWriterPolicy;
  readonly safe_hold_entry_request?: SafeHoldEntryRequest;
  readonly safe_hold_exit_evidence?: readonly SafeHoldEvidenceUpdate[];
  readonly safe_hold_recovery_policy?: SafeHoldRecoveryPolicy;
}

export interface VerificationMemoryOopsAudioSafetyInvariants {
  readonly authorized_step_ref: typeof VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_STEP_REF;
  readonly certificate_gates_memory: boolean;
  readonly memory_contamination_prevented: boolean;
  readonly oops_retry_bounded: boolean;
  readonly oops_requires_verification_evidence: boolean;
  readonly audio_is_uncertain_cue_only: boolean;
  readonly audio_does_not_certify_success: boolean;
  readonly safe_hold_authority_preserved: boolean;
  readonly human_review_surface_preserved: boolean;
  readonly raw_prompt_exposed: false;
  readonly private_reasoning_exposed: false;
  readonly qa_runtime_truth_exposed: false;
  readonly hidden_simulator_truth_exposed: false;
  readonly forbidden_later_step_refs: readonly never[];
}

export interface VerificationMemoryOopsAudioSafetyReport {
  readonly schema_version: typeof VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_SCHEMA_VERSION;
  readonly integration_ref: Ref;
  readonly task_ref: Ref;
  readonly primitive_ref: Ref;
  readonly actor_ref: Ref;
  readonly decision: VerificationMemoryOopsAudioSafetyDecision;
  readonly certificate_report: TaskSuccessCertificateIssuerReport;
  readonly memory_commit_report: MemoryCommitGateReport;
  readonly oops_handoff_report?: OopsHandoffRouterReport;
  readonly oops_admission_report?: OopsAdmissionReport;
  readonly oops_retry_report?: OopsRetryBudgetReport;
  readonly audio_route_decision_set?: AudioRouteDecisionSet;
  readonly acoustic_memory_write_set?: AcousticMemoryWriteSet;
  readonly safe_hold_state?: SafeHoldState;
  readonly safe_hold_exit_decision?: SafeHoldExitDecision;
  readonly required_human_review_refs: readonly Ref[];
  readonly required_reobserve_refs: readonly Ref[];
  readonly blocked_reason_codes: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly invariants: VerificationMemoryOopsAudioSafetyInvariants;
  readonly occurred_at_ms: number;
  readonly determinism_hash: string;
}

/**
 * Composes PIT-B09 contracts without owning any later-step harness behavior.
 */
export class VerificationMemoryOopsAudioSafetyIntegration {
  private readonly certificateIssuer: TaskSuccessCertificateIssuer;
  private readonly memoryCommitGate: MemoryCommitGate;
  private readonly oopsHandoffRouter: OopsHandoffRouter;
  private readonly oopsIntakeRouter: OopsIntakeRouter;
  private readonly oopsRetryBudgetManager: OopsRetryBudgetManager;
  private readonly safeHoldManager: SafeHoldStateManager;

  public constructor(dependencies: {
    readonly certificate_issuer?: TaskSuccessCertificateIssuer;
    readonly memory_commit_gate?: MemoryCommitGate;
    readonly oops_handoff_router?: OopsHandoffRouter;
    readonly oops_intake_router?: OopsIntakeRouter;
    readonly oops_retry_budget_manager?: OopsRetryBudgetManager;
    readonly safe_hold_manager?: SafeHoldStateManager;
  } = {}) {
    this.certificateIssuer = dependencies.certificate_issuer ?? new TaskSuccessCertificateIssuer();
    this.memoryCommitGate = dependencies.memory_commit_gate ?? new MemoryCommitGate();
    this.oopsHandoffRouter = dependencies.oops_handoff_router ?? new OopsHandoffRouter();
    this.oopsIntakeRouter = dependencies.oops_intake_router ?? new OopsIntakeRouter();
    this.oopsRetryBudgetManager = dependencies.oops_retry_budget_manager ?? new OopsRetryBudgetManager();
    this.safeHoldManager = dependencies.safe_hold_manager ?? new SafeHoldStateManager();
  }

  public compose(input: VerificationMemoryOopsAudioSafetyInput): VerificationMemoryOopsAudioSafetyReport {
    const certificateReport = this.certificateIssuer.issueTaskSuccessCertificate(input.certificate_request);
    const certificate = certificateReport.certificate;
    const memoryCommitReport = this.memoryCommitGate.authorizeMemoryCommit({
      request_ref: `${input.integration_ref}:memory-commit`,
      certificate,
      memory_policy: input.memory_policy ?? defaultMemoryPolicy(input),
      candidates: input.memory_candidates,
      current_time_ms: input.occurred_at_ms,
      maximum_evidence_age_ms: input.maximum_memory_evidence_age_ms,
    });
    const oopsHandoffReport = input.oops_handoff_request === undefined
      ? undefined
      : this.oopsHandoffRouter.routeOopsHandoff({ ...input.oops_handoff_request, certificate });
    const oopsTrigger = buildOopsTrigger(input, oopsHandoffReport, certificate);
    const oopsAdmissionReport = input.oops_policy !== undefined && oopsTrigger !== undefined
      ? this.oopsIntakeRouter.admitOopsTrigger(oopsTrigger, input.oops_policy, input.oops_safety_state ?? "normal")
      : undefined;
    const oopsRetryReport = oopsAdmissionReport?.episode === undefined
      ? undefined
      : this.oopsRetryBudgetManager.updateRetryBudget({
        request_ref: `${input.integration_ref}:oops-retry`,
        episode: oopsAdmissionReport.episode,
        latest_failure_mode: oopsAdmissionReport.episode.failure_mode_history[0],
        verification_certificate: certificate,
        safety_state: input.oops_safety_state ?? oopsAdmissionReport.episode.current_safety_state,
      });
    const audioRouteDecisionSet = input.audio_correlation_set === undefined
      ? undefined
      : selectAudioReasoningRoutes(input.audio_correlation_set, input.audio_routing_policy);
    const acousticMemoryWriteSet = audioRouteDecisionSet === undefined
      ? undefined
      : writeAcousticMemory(audioRouteDecisionSet, input.occurred_at_ms, input.acoustic_memory_policy);
    const safeHoldNeeded = shouldEnterSafeHold(certificateReport, oopsHandoffReport, oopsAdmissionReport, oopsRetryReport, audioRouteDecisionSet);
    const safeHoldState = safeHoldNeeded && input.safe_hold_entry_request !== undefined
      ? this.safeHoldManager.enterSafeHold(input.safe_hold_entry_request)
      : undefined;
    const safeHoldExitDecision = safeHoldState !== undefined && input.safe_hold_recovery_policy !== undefined
      ? this.safeHoldManager.evaluateSafeHoldExit(safeHoldState, input.safe_hold_exit_evidence ?? [], input.safe_hold_recovery_policy, input.occurred_at_ms)
      : undefined;
    const requiredHumanReviewRefs = humanReviewRefs(oopsHandoffReport, oopsAdmissionReport, oopsRetryReport, audioRouteDecisionSet, safeHoldExitDecision);
    const requiredReobserveRefs = reobserveRefs(oopsAdmissionReport, oopsRetryReport, audioRouteDecisionSet, safeHoldExitDecision);
    const issues = collectIssues(certificateReport, memoryCommitReport, oopsHandoffReport, oopsAdmissionReport, oopsRetryReport, audioRouteDecisionSet, acousticMemoryWriteSet, safeHoldExitDecision);
    const decision = chooseDecision(
      certificateReport,
      memoryCommitReport,
      oopsHandoffReport,
      oopsAdmissionReport,
      oopsRetryReport,
      audioRouteDecisionSet,
      safeHoldNeeded,
      safeHoldExitDecision,
      requiredHumanReviewRefs,
      requiredReobserveRefs,
    );
    const invariants = buildInvariants(
      input,
      certificateReport,
      memoryCommitReport,
      oopsAdmissionReport,
      oopsRetryReport,
      audioRouteDecisionSet,
      acousticMemoryWriteSet,
      safeHoldState,
      safeHoldExitDecision,
      requiredHumanReviewRefs,
    );
    const base = {
      schema_version: VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_SCHEMA_VERSION,
      integration_ref: input.integration_ref,
      task_ref: input.task_ref,
      primitive_ref: input.primitive_ref,
      actor_ref: input.actor_ref,
      decision,
      certificate_report: certificateReport,
      memory_commit_report: memoryCommitReport,
      oops_handoff_report: oopsHandoffReport,
      oops_admission_report: oopsAdmissionReport,
      oops_retry_report: oopsRetryReport,
      audio_route_decision_set: audioRouteDecisionSet,
      acoustic_memory_write_set: acousticMemoryWriteSet,
      safe_hold_state: safeHoldState,
      safe_hold_exit_decision: safeHoldExitDecision,
      required_human_review_refs: requiredHumanReviewRefs,
      required_reobserve_refs: requiredReobserveRefs,
      blocked_reason_codes: blockedReasonCodes(certificateReport, memoryCommitReport, oopsHandoffReport, oopsAdmissionReport, oopsRetryReport, audioRouteDecisionSet, acousticMemoryWriteSet, safeHoldNeeded, safeHoldState, safeHoldExitDecision),
      issues,
      invariants,
      occurred_at_ms: input.occurred_at_ms,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function defaultMemoryPolicy(input: VerificationMemoryOopsAudioSafetyInput): VerificationMemoryPolicy {
  const ambiguous = input.certificate_request.aggregation_report.decision === "ambiguous";
  return Object.freeze({
    policy_ref: `${input.certificate_request.policy_ref}:memory`,
    minimum_certificate_confidence: 0.72,
    maximum_pose_uncertainty_m: 0.025,
    require_success_certificate: true,
    allow_summary_on_ambiguity: ambiguous,
  });
}

function buildOopsTrigger(
  input: VerificationMemoryOopsAudioSafetyInput,
  handoffReport: OopsHandoffRouterReport | undefined,
  certificate: TaskSuccessCertificate | undefined,
): OopsTrigger | undefined {
  if (input.oops_policy === undefined || handoffReport?.handoff === undefined) {
    return undefined;
  }
  const handoff = handoffReport.handoff;
  return Object.freeze({
    trigger_ref: `${input.integration_ref}:oops-trigger`,
    trigger_source: "verification",
    trigger_class: "correctable_failure",
    task_ref: input.task_ref,
    primitive_ref: input.primitive_ref,
    affected_object_descriptors: [{
      descriptor_ref: `${input.integration_ref}:oops-target`,
      label: "visible target object",
      object_class: "small_rigid" as const,
      confidence: 0.86,
      feature_refs: handoff.evidence_refs,
    }],
    affected_constraint_refs: handoff.failed_constraint_refs,
    evidence_ref_candidates: handoff.evidence_refs,
    initial_route_recommendation: oopsRouteFor(handoffReport.route_decision),
    provenance_manifest_ref: `${input.integration_ref}:oops-provenance`,
    verification_handoff: handoff,
    source_certificate: certificate,
  });
}

function oopsRouteFor(route: VerificationRouteDecision): OopsRouteDecision {
  if (route === "correct" || route === "reobserve" || route === "safe_hold" || route === "human_review") return route;
  return "reject";
}

function shouldEnterSafeHold(
  certificateReport: TaskSuccessCertificateIssuerReport,
  handoff: OopsHandoffRouterReport | undefined,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
): boolean {
  return certificateReport.certificate?.result === "failure_unsafe"
    || handoff?.route_decision === "safe_hold"
    || admission?.route_decision === "safe_hold"
    || retry?.route_decision === "safe_hold"
    || audio?.decisions.some((decision) => decision.selected_route === "safe_hold") === true;
}

function humanReviewRefs(
  handoff: OopsHandoffRouterReport | undefined,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  safeHoldExit: SafeHoldExitDecision | undefined,
): readonly Ref[] {
  return freezeArray([
    handoff?.route_decision === "human_review" ? handoff.report_ref : undefined,
    admission?.route_decision === "human_review" ? admission.report_ref : undefined,
    retry?.route_decision === "human_review" ? retry.report_ref : undefined,
    safeHoldExit?.route_decision.final_route === "HumanReview" ? safeHoldExit.safe_hold_exit_decision_ref : undefined,
    ...(audio?.decisions.filter((decision) => decision.selected_route === "human_review").map((decision) => decision.route_decision_ref) ?? []),
  ].filter(isRef));
}

function reobserveRefs(
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  safeHoldExit: SafeHoldExitDecision | undefined,
): readonly Ref[] {
  return freezeArray([
    admission?.route_decision === "reobserve" ? admission.report_ref : undefined,
    retry?.route_decision === "reobserve" ? retry.report_ref : undefined,
    safeHoldExit?.route_decision.final_route === "Reobserve" ? safeHoldExit.safe_hold_exit_decision_ref : undefined,
    ...(audio?.decisions.filter((decision) => decision.selected_route === "reobserve" || decision.selected_route === "verify").map((decision) => decision.route_decision_ref) ?? []),
  ].filter(isRef));
}

function collectIssues(
  certificate: TaskSuccessCertificateIssuerReport,
  memory: MemoryCommitGateReport,
  handoff: OopsHandoffRouterReport | undefined,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  acousticMemory: AcousticMemoryWriteSet | undefined,
  safeHoldExit: SafeHoldExitDecision | undefined,
): readonly ValidationIssue[] {
  return freezeArray([
    ...certificate.issues,
    ...memory.issues,
    ...(handoff?.issues ?? []),
    ...(admission?.issues ?? []),
    ...(retry?.issues ?? []),
    ...(audio?.issues ?? []),
    ...(acousticMemory?.issues ?? []),
    ...(safeHoldExit?.issues ?? []),
  ]);
}

function chooseDecision(
  certificate: TaskSuccessCertificateIssuerReport,
  memory: MemoryCommitGateReport,
  handoff: OopsHandoffRouterReport | undefined,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  safeHoldNeeded: boolean,
  safeHoldExit: SafeHoldExitDecision | undefined,
  humanReview: readonly Ref[],
  reobserve: readonly Ref[],
): VerificationMemoryOopsAudioSafetyDecision {
  if (!certificate.ok || certificate.certificate === undefined) return "blocked_by_certificate";
  if (safeHoldNeeded || safeHoldExit?.route_decision.final_route === "SafeHold") return "safe_hold_required";
  if (humanReview.length > 0) return "human_review_required";
  if (reobserve.length > 0 || certificate.certificate.route_decision === "reobserve" || memory.overall_outcome === "commit_after_reobserve") return "reobserve_required";
  if (certificate.certificate.result === "success" && !memory.ok) return "blocked_by_memory_gate";
  if (handoff !== undefined && !handoff.ok) return "blocked_by_oops_gate";
  if (admission !== undefined && !admission.ok) return "blocked_by_oops_gate";
  if (retry !== undefined && !retry.ok && retry.route_decision !== "human_review" && retry.route_decision !== "safe_hold") return "blocked_by_oops_gate";
  if (audio !== undefined && audio.issues.some((issue) => issue.severity === "error")) return "blocked_by_audio_gate";
  return "ready_for_runtime_continuation";
}

function buildInvariants(
  input: VerificationMemoryOopsAudioSafetyInput,
  certificate: TaskSuccessCertificateIssuerReport,
  memory: MemoryCommitGateReport,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  acousticMemory: AcousticMemoryWriteSet | undefined,
  safeHold: SafeHoldState | undefined,
  safeHoldExit: SafeHoldExitDecision | undefined,
  humanReview: readonly Ref[],
): VerificationMemoryOopsAudioSafetyInvariants {
  const certificateRef = certificate.certificate?.certificate_ref;
  const commitAllowedOnlyWithSuccess = memory.decisions.every((decision) =>
    decision.outcome !== "commit_allowed"
    || (certificate.certificate?.result === "success" && certificateRef !== undefined && decision.allowed_memory_refs.includes(certificateRef)));
  const noExactWriteWhenNotSuccess = certificate.certificate?.result === "success"
    || memory.decisions.every((decision) => decision.outcome !== "commit_allowed");
  const humanReviewExpected = admission?.route_decision === "human_review"
    || retry?.route_decision === "human_review"
    || audio?.decisions.some((decision) => decision.selected_route === "human_review") === true
    || safeHoldExit?.route_decision.final_route === "HumanReview";

  return Object.freeze({
    authorized_step_ref: VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_STEP_REF,
    certificate_gates_memory: commitAllowedOnlyWithSuccess && noExactWriteWhenNotSuccess,
    memory_contamination_prevented: memory.decisions.every((decision) => decision.outcome !== "commit_allowed" || decision.blocked_fields.length === 0),
    oops_retry_bounded: retry === undefined || retry.updated_retry_budget.episode_attempts_used <= retry.updated_retry_budget.maximum_episode_attempts,
    oops_requires_verification_evidence: admission === undefined || admission.episode === undefined || admission.episode.source_certificate_ref !== undefined || input.oops_handoff_request !== undefined,
    audio_is_uncertain_cue_only: audio === undefined || audio.decisions.every((decision) => decision.blocked_direct_actions.includes("audio_only_success_certification") && decision.blocked_direct_actions.includes("audio_only_physical_correction")),
    audio_does_not_certify_success: acousticMemory === undefined || acousticMemory.records.every((record) => record.limitations.includes("audio_is_a_cue_not_spatial_proof")),
    safe_hold_authority_preserved: safeHold === undefined || (safeHold.memory_write_policy === "deny_verified_spatial_writes" && safeHold.blocked_action_refs.length > 0),
    human_review_surface_preserved: !humanReviewExpected || humanReview.length > 0,
    raw_prompt_exposed: false,
    private_reasoning_exposed: false,
    qa_runtime_truth_exposed: false,
    hidden_simulator_truth_exposed: false,
    forbidden_later_step_refs: freezeArray([] as never[]),
  });
}

function blockedReasonCodes(
  certificate: TaskSuccessCertificateIssuerReport,
  memory: MemoryCommitGateReport,
  handoff: OopsHandoffRouterReport | undefined,
  admission: OopsAdmissionReport | undefined,
  retry: OopsRetryBudgetReport | undefined,
  audio: AudioRouteDecisionSet | undefined,
  acousticMemory: AcousticMemoryWriteSet | undefined,
  safeHoldNeeded: boolean,
  safeHold: SafeHoldState | undefined,
  safeHoldExit: SafeHoldExitDecision | undefined,
): readonly string[] {
  return freezeArray([
    ...certificate.issues.map((issue) => `certificate:${issue.code}`),
    ...memory.issues.map((issue) => `memory_commit:${issue.code}`),
    ...memory.decisions.filter((decision) => decision.outcome !== "commit_allowed").map((decision) => `memory_commit:${decision.outcome}`),
    ...(handoff?.issues.map((issue) => `oops_handoff:${issue.code}`) ?? []),
    ...(handoff !== undefined && handoff.decision !== "handoff_ready" && handoff.decision !== "not_required" ? [`oops_handoff:${handoff.decision}`] : []),
    ...(admission?.issues.map((issue) => `oops_admission:${issue.code}`) ?? []),
    ...(admission !== undefined && admission.decision !== "admitted" ? [`oops_admission:${admission.decision}`] : []),
    ...(retry?.issues.map((issue) => `oops_retry:${issue.code}`) ?? []),
    ...(retry !== undefined && retry.decision !== "continue_correction" && retry.decision !== "complete" ? [`oops_retry:${retry.decision}`] : []),
    ...(audio?.issues.map((issue) => `audio_route:${issue.code}`) ?? []),
    ...(acousticMemory?.records.filter((record) => !record.accepted).map((record) => `acoustic_memory:${record.acoustic_memory_class}`) ?? []),
    ...(safeHoldNeeded && safeHold === undefined ? ["safe_hold:entry_request_missing"] : []),
    ...(safeHoldExit?.blocked_exit_reasons.map((reason) => `safe_hold_exit:${reason}`) ?? []),
  ]);
}

function isRef(value: Ref | undefined): value is Ref {
  return value !== undefined && value.length > 0;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_SCHEMA_VERSION,
  step_ref: VERIFICATION_MEMORY_OOPS_AUDIO_SAFETY_INTEGRATION_STEP_REF,
  production_readiness_docs: freezeArray([
    "production_readiness_docs/06_DATA_STORAGE_MEMORY_AND_STATE_PLAN.md",
    "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md",
    "production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md",
  ]),
  architecture_docs: freezeArray([
    "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md",
    "architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md",
    "architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md",
    "architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md",
    "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  ]),
  integrated_contracts: freezeArray([
    "TaskSuccessCertificateIssuer",
    "MemoryCommitGate",
    "OopsHandoffRouter",
    "OopsIntakeRouter",
    "OopsRetryBudgetManager",
    "AudioReasoningRouter",
    "AudioMemoryWriter",
    "SafeHoldStateManager",
  ]),
});
