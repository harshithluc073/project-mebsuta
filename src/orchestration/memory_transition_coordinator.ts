/**
 * Memory transition coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.5, 8.7, 8.9.11, 8.10, 8.14, 8.16, 8.17, 8.18, and
 * 8.19.
 *
 * This module implements the executable `MemoryTransitionCoordinator`. It
 * admits memory writes only after appropriate observation, verification,
 * correction, audio, safety, or task-completion evidence; enforces provenance
 * and staleness policy; reconciles contradictions; defers non-critical memory
 * timeouts; and emits File 08 memory lifecycle events without exposing hidden
 * simulator truth to cognition.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventSeverity,
  OrchestrationEventEnvelope,
  PayloadProvenanceClass,
  PrimaryState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";
import type { StatePayloadFirewallReport } from "./state_payload_firewall";

export const MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION = "mebsuta.memory_transition_coordinator.v1" as const;
export const MEMORY_TRANSITION_COORDINATOR_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#MemoryTransitionCoordinator" as const;
const SUPPORTING_MEMORY_BLUEPRINT_REF = "architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md" as const;
const DEFAULT_MEMORY_WRITE_TIMEOUT_MS = 1_000;
const DEFAULT_EVIDENCE_FRESHNESS_MS = 10_000;
const DEFAULT_MAX_STALENESS_SCORE = 0.72;
const DEFAULT_CONTRADICTION_THRESHOLD = 0.62;
const DEFAULT_MIN_VERIFIED_CONFIDENCE = 0.82;
const DEFAULT_MIN_OBSERVED_CONFIDENCE = 0.52;
const DEFAULT_MIN_SEARCH_HINT_CONFIDENCE = 0.22;
const MAX_MEMORY_SUMMARY_CHARS = 900;
const FORBIDDEN_MEMORY_TEXT_PATTERN = /(mujoco|babylon|simulator|physics engine|render engine|world_truth|ground_truth|hidden state|hidden_state|hidden pose|oracle state|qa_|backend|object_id|rigid_body_handle|physics_body|joint_handle|scene_graph|collision_mesh|contact solver internal|debug buffer|segmentation truth|depth truth|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|apply force|apply impulse|reward policy|policy gradient|reinforcement learning)/i;

export type MemoryRecordClass =
  | "verified"
  | "observed"
  | "search_hint"
  | "contradiction"
  | "task_episode"
  | "oops_episode"
  | "tool"
  | "acoustic"
  | "safety";

export type MemoryConfidenceClass =
  | "verified"
  | "high_observed"
  | "medium_observed"
  | "low_hypothesis"
  | "contradicted"
  | "quarantined";

export type MemoryLifecycleState =
  | "candidate"
  | "active"
  | "stale"
  | "contradicted"
  | "superseded"
  | "archived"
  | "quarantined";

export type MemoryRetrievalPermission = "cognition" | "planning_prior" | "search_only" | "qa_only" | "audit_only";
export type MemoryEvidenceKind = "observation" | "verification_certificate" | "correction_outcome" | "audio_event" | "safety_event" | "operator_note" | "validator_report" | "execution_telemetry";
export type MemoryWriteOutcome = "commit_verified_record" | "commit_observation_note" | "commit_search_hint" | "commit_contradiction" | "commit_episode_only" | "deny_write" | "quarantine_record";
export type MemoryWriteDisposition = "write_ready" | "defer" | "reject" | "safe_hold_required" | "human_review_required";
export type MemoryWriteOperation = "upsert_verified" | "append_observation" | "append_search_hint" | "commit_contradiction" | "append_episode" | "quarantine";
export type MemoryTransitionDecision = "write_batch_ready" | "all_deferred" | "blocked" | "safe_hold_required" | "human_review_required" | "nothing_to_write";
export type MemoryContradictionType = "absent" | "moved" | "identity_mismatch" | "relation_mismatch" | "orientation_mismatch" | "unsafe_change";

export interface MemoryTransitionPolicy {
  readonly final_memory_requires_verification_certificate: boolean;
  readonly allow_verified_to_observed_downgrade: boolean;
  readonly allow_observation_notes_without_verification: boolean;
  readonly allow_audio_memory_without_verification: boolean;
  readonly allow_safety_memory_without_verification: boolean;
  readonly defer_noncritical_on_timeout: boolean;
  readonly min_verified_confidence: number;
  readonly min_observed_confidence: number;
  readonly min_search_hint_confidence: number;
  readonly max_staleness_score: number;
  readonly evidence_freshness_ms: number;
  readonly contradiction_strength_threshold: number;
  readonly memory_write_timeout_ms: number;
}

export interface MemoryEvidenceManifest {
  readonly manifest_ref: Ref;
  readonly evidence_kind: MemoryEvidenceKind;
  readonly evidence_refs: readonly Ref[];
  readonly provenance_classes: readonly PayloadProvenanceClass[];
  readonly captured_at_ms: number;
  readonly source_component_ref: Ref;
  readonly prompt_safe_summary: string;
  readonly confidence: number;
}

export interface MemoryWriteCandidate {
  readonly candidate_ref: Ref;
  readonly record_class: MemoryRecordClass;
  readonly source_state: PrimaryState;
  readonly source_event_ref: Ref;
  readonly created_at_ms: number;
  readonly content_summary: string;
  readonly evidence_manifests: readonly MemoryEvidenceManifest[];
  readonly source_evidence_refs: readonly Ref[];
  readonly provenance_manifest_ref: Ref;
  readonly confidence: number;
  readonly staleness_score: number;
  readonly final_task_memory: boolean;
  readonly required_for_task_integrity: boolean;
  readonly verification_certificate_ref?: Ref;
  readonly latest_observation_ref?: Ref;
  readonly related_memory_refs?: readonly Ref[];
  readonly supersedes_memory_refs?: readonly Ref[];
  readonly contradiction_record_ref?: Ref;
  readonly contradiction_type?: MemoryContradictionType;
  readonly contradiction_strength?: number;
  readonly current_evidence_refs?: readonly Ref[];
  readonly correction_episode_ref?: Ref;
  readonly audio_event_ref?: Ref;
  readonly safety_event_ref?: Ref;
  readonly task_outcome_ref?: Ref;
  readonly retrieval_permissions?: readonly MemoryRetrievalPermission[];
}

export interface MemoryCandidateDecision {
  readonly candidate_ref: Ref;
  readonly record_class: MemoryRecordClass;
  readonly outcome: MemoryWriteOutcome;
  readonly disposition: MemoryWriteDisposition;
  readonly confidence_class: MemoryConfidenceClass;
  readonly lifecycle_state: MemoryLifecycleState;
  readonly reason: string;
  readonly target_state: PrimaryState;
  readonly write_order?: MemoryWriteOrder;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface MemoryWriteOrder {
  readonly schema_version: typeof MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION;
  readonly write_order_ref: Ref;
  readonly operation: MemoryWriteOperation;
  readonly outcome: MemoryWriteOutcome;
  readonly memory_record_ref: Ref;
  readonly candidate_ref: Ref;
  readonly record_class: MemoryRecordClass;
  readonly confidence_class: MemoryConfidenceClass;
  readonly lifecycle_state: MemoryLifecycleState;
  readonly content_summary: string;
  readonly source_event_refs: readonly Ref[];
  readonly source_evidence_refs: readonly Ref[];
  readonly provenance_manifest_ref: Ref;
  readonly truth_boundary_status: "prompt_safe_provenance_checked";
  readonly staleness_score: number;
  readonly retrieval_permissions: readonly MemoryRetrievalPermission[];
  readonly verification_certificate_ref?: Ref;
  readonly contradiction_record_ref?: Ref;
  readonly supersedes_memory_refs: readonly Ref[];
  readonly audit_replay_refs: readonly Ref[];
  readonly created_at_ms: number;
  readonly determinism_hash: string;
}

export interface MemoryTransitionCoordinatorReport {
  readonly schema_version: typeof MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION;
  readonly coordinator_version: typeof MEMORY_TRANSITION_COORDINATOR_VERSION;
  readonly decision: MemoryTransitionDecision;
  readonly transition_event?: OrchestrationEventEnvelope;
  readonly candidate_decisions: readonly MemoryCandidateDecision[];
  readonly write_orders: readonly MemoryWriteOrder[];
  readonly deferred_candidate_refs: readonly Ref[];
  readonly rejected_candidate_refs: readonly Ref[];
  readonly required_write_blocked: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly supporting_memory_blueprint: typeof SUPPORTING_MEMORY_BLUEPRINT_REF;
  readonly determinism_hash: string;
}

export interface MemoryTransitionRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly trigger_event: OrchestrationEventEnvelope;
  readonly candidates: readonly MemoryWriteCandidate[];
  readonly occurred_at_ms: number;
  readonly policy?: Partial<MemoryTransitionPolicy>;
  readonly firewall_reports?: readonly StatePayloadFirewallReport[];
}

export interface MemoryCommitReceipt {
  readonly memory_record_ref: Ref;
  readonly write_order_ref: Ref;
  readonly committed: boolean;
  readonly committed_at_ms: number;
  readonly store_receipt_ref: Ref;
  readonly error_summary?: string;
}

export interface MemoryStorePort {
  readonly commitMemoryRecord: (order: MemoryWriteOrder) => MemoryCommitReceipt | Promise<MemoryCommitReceipt>;
}

export interface MemoryCommitReport {
  readonly schema_version: typeof MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION;
  readonly committed_receipts: readonly MemoryCommitReceipt[];
  readonly failed_receipts: readonly MemoryCommitReceipt[];
  readonly source_write_order_refs: readonly Ref[];
  readonly all_required_writes_satisfied: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Coordinates File 08 memory update entry actions. The class evaluates write
 * candidates, prepares deterministic write orders, and can call an injected
 * memory store port for actual persistence without coupling orchestration to a
 * database implementation.
 */
export class MemoryTransitionCoordinator {
  /**
   * Evaluates memory write candidates and returns the MemoryUpdate transition
   * event or a conservative defer, SafeHold, or human-review decision.
   */
  public evaluateMemoryTransition(request: MemoryTransitionRequest): MemoryTransitionCoordinatorReport {
    const policy = mergePolicy(request.policy);
    const structuralIssues = validateRequestShape(request, policy);
    const firewallIssues = issuesFromFirewallReports(request.firewall_reports ?? []);
    const candidateDecisions = freezeArray(request.candidates.map((candidate) => evaluateCandidate(candidate, request, policy)));
    const issues = freezeArray([...structuralIssues, ...firewallIssues, ...candidateDecisions.flatMap((decision) => decision.issues)]);
    const decision = chooseTransitionDecision(candidateDecisions, issues);
    const writeOrders = freezeArray(candidateDecisions.map((decision) => decision.write_order).filter(isWriteOrder));
    const transitionEvent = buildTransitionEvent(request, decision, writeOrders, candidateDecisions, issues);
    return makeReport(decision, transitionEvent, candidateDecisions, writeOrders, issues);
  }

  /**
   * Returns the write batch from a successful coordinator report. Callers may
   * pass the batch to an episodic memory service or use `commitApprovedWrites`.
   */
  public buildMemoryWriteBatch(report: MemoryTransitionCoordinatorReport): readonly MemoryWriteOrder[] {
    return report.decision === "write_batch_ready" ? report.write_orders : freezeArray([]);
  }

  /**
   * Calls the supplied memory store for each approved write order and returns a
   * deterministic commit report. Failed store calls become receipts and issues;
   * they do not mutate orchestration state on their own.
   */
  public async commitApprovedWrites(
    report: MemoryTransitionCoordinatorReport,
    memoryStore: MemoryStorePort,
    committedAtMs: number,
  ): Promise<MemoryCommitReport> {
    const issues: ValidationIssue[] = [];
    const receipts: MemoryCommitReceipt[] = [];
    for (const order of this.buildMemoryWriteBatch(report)) {
      try {
        const receipt = await memoryStore.commitMemoryRecord(order);
        receipts.push(Object.freeze({ ...receipt }));
        if (!receipt.committed) {
          issues.push(issue("error", "MemoryStoreCommitRejected", `$.write_orders.${order.write_order_ref}`, receipt.error_summary ?? "Memory store rejected write order.", "Retry if transient or route to HumanReview for required memory."));
        }
      } catch (error) {
        const errorSummary = error instanceof Error ? error.message : String(error);
        receipts.push(Object.freeze({
          memory_record_ref: order.memory_record_ref,
          write_order_ref: order.write_order_ref,
          committed: false,
          committed_at_ms: committedAtMs,
          store_receipt_ref: makeRef("memory_store_receipt", "failed", order.write_order_ref, committedAtMs),
          error_summary: compactText(errorSummary),
        }));
        issues.push(issue("error", "MemoryStoreCommitFailed", `$.write_orders.${order.write_order_ref}`, "Memory store commit call failed.", compactText(errorSummary)));
      }
    }
    return makeCommitReport(receipts, report, issues);
  }

  /**
   * Emits the MemoryWritten event consumed by the File 08 state machine after
   * the memory store acknowledges all required writes or a policy skip.
   */
  public buildMemoryWrittenEvent(
    commitReport: MemoryCommitReport,
    snapshot: RuntimeStateSnapshot,
    occurredAtMs: number,
  ): OrchestrationEventEnvelope {
    const allCommitted = commitReport.failed_receipts.length === 0 && commitReport.all_required_writes_satisfied;
    const targetState: PrimaryState = allCommitted ? "Complete" : "HumanReview";
    const base = {
      event_ref: makeRef("event", "memory_written", snapshot.session_ref, snapshot.task_ref, occurredAtMs),
      event_type: "MemoryWritten" as const,
      event_family: "memory" as const,
      severity: allCommitted ? "info" as const : "error" as const,
      session_ref: snapshot.session_ref,
      task_ref: snapshot.task_ref,
      source_state_ref: "MemoryUpdate" as const,
      context_ref: snapshot.current_context_ref,
      payload_refs: uniqueRefs([
        ...commitReport.committed_receipts.map((receipt) => receipt.memory_record_ref),
        ...commitReport.committed_receipts.map((receipt) => receipt.store_receipt_ref),
        ...commitReport.failed_receipts.map((receipt) => receipt.write_order_ref),
      ]),
      provenance_classes: freezeArray(["memory", "schema", "telemetry"] as const),
      occurred_at_ms: occurredAtMs,
      human_summary: allCommitted
        ? "Memory writes completed with provenance-safe receipts."
        : "Memory write completion requires review because required writes failed.",
      target_state_hint: targetState,
    };
    return Object.freeze(base);
  }
}

function evaluateCandidate(
  candidate: MemoryWriteCandidate,
  request: MemoryTransitionRequest,
  policy: MemoryTransitionPolicy,
): MemoryCandidateDecision {
  const issues = validateCandidate(candidate, request, policy);
  const hiddenTruthIssue = issues.some((item) => item.code === "MemoryTextForbidden" || item.code === "MemoryReferenceForbidden" || item.code === "MemoryProvenanceForbidden");
  const hardError = issues.some((item) => item.severity === "error");
  const timedOut = request.occurred_at_ms - candidate.created_at_ms > policy.memory_write_timeout_ms;
  const confidenceClass = confidenceClassFor(candidate, policy, hiddenTruthIssue);
  const action = chooseCandidateAction(candidate, policy, hiddenTruthIssue, hardError, timedOut);
  const targetState = targetStateForDisposition(action.disposition, candidate);
  const writeOrder = action.disposition === "write_ready"
    ? buildWriteOrder(candidate, action.outcome, confidenceClass, action.lifecycle_state, request)
    : undefined;
  const base = {
    candidate_ref: candidate.candidate_ref,
    record_class: candidate.record_class,
    outcome: action.outcome,
    disposition: action.disposition,
    confidence_class: confidenceClass,
    lifecycle_state: action.lifecycle_state,
    reason: action.reason,
    target_state: targetState,
    write_order: writeOrder,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function chooseCandidateAction(
  candidate: MemoryWriteCandidate,
  policy: MemoryTransitionPolicy,
  hiddenTruthIssue: boolean,
  hardError: boolean,
  timedOut: boolean,
): {
  readonly outcome: MemoryWriteOutcome;
  readonly disposition: MemoryWriteDisposition;
  readonly lifecycle_state: MemoryLifecycleState;
  readonly reason: string;
} {
  if (hiddenTruthIssue) {
    return {
      outcome: "quarantine_record",
      disposition: "safe_hold_required",
      lifecycle_state: "quarantined",
      reason: "Memory candidate contains hidden-truth, backend, prompt-private, or restricted-control content.",
    };
  }
  if (timedOut && policy.defer_noncritical_on_timeout && !candidate.required_for_task_integrity) {
    return {
      outcome: "deny_write",
      disposition: "defer",
      lifecycle_state: "candidate",
      reason: "Non-critical memory write timed out and was deferred by policy.",
    };
  }
  if (hardError && candidate.required_for_task_integrity) {
    return {
      outcome: "deny_write",
      disposition: "human_review_required",
      lifecycle_state: "candidate",
      reason: "Required memory write lacks the evidence or certificate needed for safe completion.",
    };
  }
  if (hardError) {
    return {
      outcome: "deny_write",
      disposition: "reject",
      lifecycle_state: "quarantined",
      reason: "Memory candidate failed schema, provenance, or evidence validation.",
    };
  }
  if (candidate.record_class === "contradiction" || (candidate.contradiction_strength ?? 0) >= policy.contradiction_strength_threshold) {
    return {
      outcome: "commit_contradiction",
      disposition: "write_ready",
      lifecycle_state: "contradicted",
      reason: "Fresh embodied evidence contradicts prior memory and must be recorded.",
    };
  }
  if (candidate.record_class === "verified") {
    if (candidate.verification_certificate_ref !== undefined && candidate.confidence >= policy.min_verified_confidence && candidate.staleness_score <= policy.max_staleness_score) {
      return {
        outcome: "commit_verified_record",
        disposition: "write_ready",
        lifecycle_state: "active",
        reason: "Verified memory has certificate authorization, fresh evidence, and sufficient confidence.",
      };
    }
    if (policy.allow_verified_to_observed_downgrade && hasObservationEvidence(candidate) && candidate.confidence >= policy.min_observed_confidence) {
      return {
        outcome: "commit_observation_note",
        disposition: "write_ready",
        lifecycle_state: candidate.staleness_score > policy.max_staleness_score ? "stale" : "active",
        reason: "Verified write lacked full certificate strength and was downgraded to an observed memory note.",
      };
    }
  }
  if (candidate.record_class === "observed" || candidate.record_class === "tool") {
    if (candidate.confidence >= policy.min_observed_confidence && candidate.staleness_score <= policy.max_staleness_score) {
      return {
        outcome: "commit_observation_note",
        disposition: "write_ready",
        lifecycle_state: "active",
        reason: "Observation memory has embodied evidence and sufficient confidence.",
      };
    }
    if (candidate.confidence >= policy.min_search_hint_confidence) {
      return {
        outcome: "commit_search_hint",
        disposition: "write_ready",
        lifecycle_state: "stale",
        reason: "Low-confidence or stale observation was preserved as a search hint only.",
      };
    }
  }
  if (candidate.record_class === "search_hint" && candidate.confidence >= policy.min_search_hint_confidence) {
    return {
      outcome: "commit_search_hint",
      disposition: "write_ready",
      lifecycle_state: "active",
      reason: "Search hint contains enough embodied evidence for reobserve-only retrieval.",
    };
  }
  if (candidate.record_class === "task_episode" || candidate.record_class === "oops_episode" || candidate.record_class === "acoustic" || candidate.record_class === "safety") {
    return {
      outcome: "commit_episode_only",
      disposition: "write_ready",
      lifecycle_state: "active",
      reason: "Episode memory stores event context without asserting an unverified spatial fact.",
    };
  }
  return {
    outcome: "deny_write",
    disposition: candidate.required_for_task_integrity ? "human_review_required" : "defer",
    lifecycle_state: "candidate",
    reason: "Memory candidate lacks sufficient confidence or freshness for autonomous commit.",
  };
}

function buildWriteOrder(
  candidate: MemoryWriteCandidate,
  outcome: MemoryWriteOutcome,
  confidenceClass: MemoryConfidenceClass,
  lifecycleState: MemoryLifecycleState,
  request: MemoryTransitionRequest,
): MemoryWriteOrder {
  const operation = operationForOutcome(outcome);
  const evidenceRefs = uniqueRefs([
    ...candidate.source_evidence_refs,
    ...candidate.evidence_manifests.flatMap((manifest) => manifest.evidence_refs),
    candidate.latest_observation_ref,
    candidate.verification_certificate_ref,
    candidate.audio_event_ref,
    candidate.safety_event_ref,
    candidate.task_outcome_ref,
    candidate.correction_episode_ref,
    ...(candidate.current_evidence_refs ?? []),
  ]);
  const sourceEventRefs = uniqueRefs([
    candidate.source_event_ref,
    request.trigger_event.event_ref,
    ...candidate.evidence_manifests.map((manifest) => manifest.manifest_ref),
  ]);
  const base = {
    schema_version: MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION,
    write_order_ref: makeRef("memory_write_order", candidate.candidate_ref, operation, request.occurred_at_ms),
    operation,
    outcome,
    memory_record_ref: makeRef("memory_record", candidate.record_class, candidate.candidate_ref),
    candidate_ref: candidate.candidate_ref,
    record_class: candidate.record_class,
    confidence_class: confidenceClass,
    lifecycle_state: lifecycleState,
    content_summary: compactText(candidate.content_summary),
    source_event_refs: sourceEventRefs,
    source_evidence_refs: evidenceRefs,
    provenance_manifest_ref: candidate.provenance_manifest_ref,
    truth_boundary_status: "prompt_safe_provenance_checked" as const,
    staleness_score: roundUnit(candidate.staleness_score),
    retrieval_permissions: retrievalPermissionsFor(candidate, outcome, confidenceClass),
    verification_certificate_ref: candidate.verification_certificate_ref,
    contradiction_record_ref: candidate.contradiction_record_ref,
    supersedes_memory_refs: freezeArray(candidate.supersedes_memory_refs ?? []),
    audit_replay_refs: uniqueRefs([
      request.snapshot.current_context_ref,
      request.trigger_event.event_ref,
      ...request.snapshot.audit_refs,
      ...candidate.evidence_manifests.map((manifest) => manifest.manifest_ref),
    ]),
    created_at_ms: request.occurred_at_ms,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildTransitionEvent(
  request: MemoryTransitionRequest,
  decision: MemoryTransitionDecision,
  writeOrders: readonly MemoryWriteOrder[],
  candidateDecisions: readonly MemoryCandidateDecision[],
  issues: readonly ValidationIssue[],
): OrchestrationEventEnvelope | undefined {
  if (decision === "nothing_to_write") {
    return undefined;
  }
  const targetState = targetStateForReportDecision(decision);
  const eventType = eventTypeForDecision(decision, candidateDecisions);
  const severity = severityForDecision(decision, issues);
  const payloadRefs = uniqueRefs([
    request.trigger_event.event_ref,
    ...writeOrders.map((order) => order.write_order_ref),
    ...writeOrders.map((order) => order.memory_record_ref),
    ...candidateDecisions.map((candidate) => candidate.candidate_ref),
  ]);
  const base = {
    event_ref: makeRef("event", "memory_transition", eventType, request.snapshot.session_ref, request.occurred_at_ms),
    event_type: eventType,
    event_family: "memory" as const,
    severity,
    session_ref: request.snapshot.session_ref,
    task_ref: request.snapshot.task_ref,
    source_state_ref: request.snapshot.primary_state,
    context_ref: request.snapshot.current_context_ref,
    payload_refs: payloadRefs,
    provenance_classes: freezeArray(["memory", "schema", "telemetry"] as const),
    occurred_at_ms: request.occurred_at_ms,
    human_summary: summaryForDecision(decision, writeOrders.length, candidateDecisions.length),
    target_state_hint: targetState,
  };
  return Object.freeze(base);
}

function validateRequestShape(request: MemoryTransitionRequest, policy: MemoryTransitionPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.snapshot.session_ref, "$.snapshot.session_ref", issues);
  validateRef(request.snapshot.task_ref, "$.snapshot.task_ref", issues);
  validateRef(request.snapshot.current_context_ref, "$.snapshot.current_context_ref", issues);
  validateRef(request.trigger_event.event_ref, "$.trigger_event.event_ref", issues);
  if (request.trigger_event.session_ref !== request.snapshot.session_ref || request.trigger_event.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("error", "MemoryEventSessionTaskMismatch", "$.trigger_event", "Memory transition trigger does not match the current runtime snapshot.", "Reject stale or cross-session memory events."));
  }
  if (request.candidates.length === 0 && request.snapshot.primary_state === "MemoryUpdate") {
    issues.push(issue("warning", "MemoryUpdateWithoutCandidates", "$.candidates", "MemoryUpdate entered with no write candidates.", "Emit MemoryWritten only when policy explicitly skips memory."));
  }
  if (policy.min_verified_confidence < policy.min_observed_confidence || policy.min_observed_confidence < policy.min_search_hint_confidence) {
    issues.push(issue("error", "MemoryPolicyThresholdOrderInvalid", "$.policy", "Memory confidence thresholds must descend from verified to observed to search hint.", "Use conservative ordered confidence thresholds."));
  }
  return freezeArray(issues);
}

function validateCandidate(
  candidate: MemoryWriteCandidate,
  request: MemoryTransitionRequest,
  policy: MemoryTransitionPolicy,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(candidate.candidate_ref, "$.candidate.candidate_ref", issues);
  validateRef(candidate.source_event_ref, "$.candidate.source_event_ref", issues);
  validateRef(candidate.provenance_manifest_ref, "$.candidate.provenance_manifest_ref", issues);
  validateSafeText(candidate.content_summary, "$.candidate.content_summary", true, issues);
  validateUnit(candidate.confidence, "$.candidate.confidence", "MemoryConfidenceInvalid", issues);
  validateUnit(candidate.staleness_score, "$.candidate.staleness_score", "MemoryStalenessInvalid", issues);
  if (candidate.created_at_ms < 0 || !Number.isFinite(candidate.created_at_ms)) {
    issues.push(issue("error", "MemoryCandidateTimeInvalid", "$.candidate.created_at_ms", "Candidate creation time must be finite and nonnegative.", "Use the scenario runtime clock."));
  }
  if (request.occurred_at_ms - candidate.created_at_ms > policy.evidence_freshness_ms && candidate.final_task_memory) {
    issues.push(issue("error", "FinalMemoryEvidenceStale", "$.candidate.created_at_ms", "Final-state memory evidence is stale.", "Refresh verification or defer final memory."));
  }
  if (candidate.source_evidence_refs.length === 0 && candidate.evidence_manifests.length === 0) {
    issues.push(issue("error", "MemoryEvidenceMissing", "$.candidate.source_evidence_refs", "Memory write requires embodied evidence references.", "Attach observation, verification, correction, audio, safety, or operator evidence."));
  }
  for (const [index, evidenceRef] of candidate.source_evidence_refs.entries()) {
    validateRef(evidenceRef, `$.candidate.source_evidence_refs[${index}]`, issues);
  }
  for (const [index, manifest] of candidate.evidence_manifests.entries()) {
    validateEvidenceManifest(manifest, index, request, policy, issues);
  }
  validateCandidateClassRequirements(candidate, policy, issues);
  return freezeArray(issues);
}

function validateEvidenceManifest(
  manifest: MemoryEvidenceManifest,
  index: number,
  request: MemoryTransitionRequest,
  policy: MemoryTransitionPolicy,
  issues: ValidationIssue[],
): void {
  const path = `$.candidate.evidence_manifests[${index}]`;
  validateRef(manifest.manifest_ref, `${path}.manifest_ref`, issues);
  validateRef(manifest.source_component_ref, `${path}.source_component_ref`, issues);
  validateSafeText(manifest.prompt_safe_summary, `${path}.prompt_safe_summary`, true, issues);
  validateUnit(manifest.confidence, `${path}.confidence`, "MemoryEvidenceConfidenceInvalid", issues);
  if (manifest.evidence_refs.length === 0) {
    issues.push(issue("error", "MemoryManifestEvidenceMissing", `${path}.evidence_refs`, "Evidence manifest must include embodied evidence refs.", "Attach source evidence refs."));
  }
  for (const [evidenceIndex, evidenceRef] of manifest.evidence_refs.entries()) {
    validateRef(evidenceRef, `${path}.evidence_refs[${evidenceIndex}]`, issues);
  }
  for (const [provenanceIndex, provenanceClass] of manifest.provenance_classes.entries()) {
    if (provenanceClass === "qa_only" || provenanceClass === "restricted") {
      issues.push(issue("error", "MemoryProvenanceForbidden", `${path}.provenance_classes[${provenanceIndex}]`, "Runtime memory cannot be written from QA-only or restricted provenance.", "Use embodied sensor, validator, task, safety, memory, schema, operator, or telemetry provenance."));
    }
  }
  if (request.occurred_at_ms - manifest.captured_at_ms > policy.evidence_freshness_ms && manifest.evidence_kind === "verification_certificate") {
    issues.push(issue("warning", "MemoryManifestStale", `${path}.captured_at_ms`, "Verification evidence is stale relative to memory transition time.", "Refresh verification before verified write when task integrity depends on it."));
  }
}

function validateCandidateClassRequirements(candidate: MemoryWriteCandidate, policy: MemoryTransitionPolicy, issues: ValidationIssue[]): void {
  if (candidate.final_task_memory && policy.final_memory_requires_verification_certificate && candidate.verification_certificate_ref === undefined) {
    issues.push(issue("error", "FinalMemoryCertificateMissing", "$.candidate.verification_certificate_ref", "Final-state memory requires a verification certificate.", "Attach embodied verification certificate or defer completion memory."));
  }
  if (candidate.record_class === "verified" && candidate.verification_certificate_ref === undefined && !policy.allow_verified_to_observed_downgrade) {
    issues.push(issue("error", "VerifiedMemoryCertificateMissing", "$.candidate.verification_certificate_ref", "Verified memory requires certificate authorization.", "Attach a verification certificate or request observed-memory downgrade."));
  }
  if ((candidate.record_class === "observed" || candidate.record_class === "tool") && !policy.allow_observation_notes_without_verification && candidate.verification_certificate_ref === undefined) {
    issues.push(issue("error", "ObservationMemoryNeedsVerification", "$.candidate.record_class", "Observation memory without verification is disabled by policy.", "Attach certificate or enable observation notes."));
  }
  if (candidate.record_class === "contradiction") {
    if ((candidate.related_memory_refs ?? []).length === 0 || (candidate.current_evidence_refs ?? []).length === 0) {
      issues.push(issue("error", "ContradictionEvidenceIncomplete", "$.candidate", "Contradiction memory requires prior memory refs and current evidence refs.", "Attach prior records and fresh evidence."));
    }
    if (candidate.contradiction_strength === undefined || candidate.contradiction_strength < policy.contradiction_strength_threshold) {
      issues.push(issue("warning", "ContradictionStrengthLow", "$.candidate.contradiction_strength", "Contradiction strength is below autonomous commit threshold.", "Prefer reobserve or record a search hint."));
    }
  }
  if (candidate.record_class === "acoustic" && !policy.allow_audio_memory_without_verification && candidate.verification_certificate_ref === undefined) {
    issues.push(issue("error", "AcousticMemoryNeedsVerification", "$.candidate.audio_event_ref", "Acoustic memory without verification is disabled by policy.", "Attach verification or skip acoustic write."));
  }
  if (candidate.record_class === "safety" && !policy.allow_safety_memory_without_verification && candidate.verification_certificate_ref === undefined) {
    issues.push(issue("error", "SafetyMemoryNeedsVerification", "$.candidate.safety_event_ref", "Safety memory without verification is disabled by policy.", "Attach verification or preserve as audit only."));
  }
  if (candidate.record_class === "oops_episode" && candidate.correction_episode_ref === undefined) {
    issues.push(issue("error", "OopsEpisodeRefMissing", "$.candidate.correction_episode_ref", "Oops episode memory requires a correction episode reference.", "Attach the correction episode reference."));
  }
}

function issuesFromFirewallReports(reports: readonly StatePayloadFirewallReport[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, report] of reports.entries()) {
    if (report.guard_result.blocking || report.decision === "block") {
      issues.push(issue("error", "MemoryFirewallReportBlocked", `$.firewall_reports[${index}]`, "State payload firewall blocked memory-facing payload.", "Do not write memory from blocked transition payloads."));
    } else if (report.decision === "quarantine" || report.findings.length > 0) {
      issues.push(issue("warning", "MemoryFirewallReportWarning", `$.firewall_reports[${index}]`, "State payload firewall allowed memory payload only with warnings or quarantine handling.", "Review sanitized payload fields before memory write."));
    }
  }
  return freezeArray(issues);
}

function chooseTransitionDecision(candidateDecisions: readonly MemoryCandidateDecision[], issues: readonly ValidationIssue[]): MemoryTransitionDecision {
  if (candidateDecisions.some((decision) => decision.disposition === "safe_hold_required")) {
    return "safe_hold_required";
  }
  if (candidateDecisions.some((decision) => decision.disposition === "human_review_required")) {
    return "human_review_required";
  }
  if (issues.some((item) => item.severity === "error")) {
    return "blocked";
  }
  if (candidateDecisions.some((decision) => decision.disposition === "write_ready")) {
    return "write_batch_ready";
  }
  if (candidateDecisions.length > 0 && candidateDecisions.every((decision) => decision.disposition === "defer")) {
    return "all_deferred";
  }
  if (candidateDecisions.length === 0) {
    return "nothing_to_write";
  }
  return "blocked";
}

function makeReport(
  decision: MemoryTransitionDecision,
  transitionEvent: OrchestrationEventEnvelope | undefined,
  candidateDecisions: readonly MemoryCandidateDecision[],
  writeOrders: readonly MemoryWriteOrder[],
  issues: readonly ValidationIssue[],
): MemoryTransitionCoordinatorReport {
  const deferred = candidateDecisions.filter((item) => item.disposition === "defer").map((item) => item.candidate_ref);
  const rejected = candidateDecisions.filter((item) => item.disposition === "reject").map((item) => item.candidate_ref);
  const base = {
    schema_version: MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION,
    coordinator_version: MEMORY_TRANSITION_COORDINATOR_VERSION,
    decision,
    transition_event: transitionEvent,
    candidate_decisions: freezeArray(candidateDecisions),
    write_orders: freezeArray(writeOrders),
    deferred_candidate_refs: freezeArray(deferred),
    rejected_candidate_refs: freezeArray(rejected),
    required_write_blocked: candidateDecisions.some((item) => item.disposition !== "write_ready" && candidateRequiredByRef(item.candidate_ref, candidateDecisions)),
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    supporting_memory_blueprint: SUPPORTING_MEMORY_BLUEPRINT_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function candidateRequiredByRef(candidateRef: Ref, decisions: readonly MemoryCandidateDecision[]): boolean {
  return decisions.some((decision) => decision.candidate_ref === candidateRef && decision.disposition === "human_review_required");
}

function makeCommitReport(
  receipts: readonly MemoryCommitReceipt[],
  report: MemoryTransitionCoordinatorReport,
  issues: readonly ValidationIssue[],
): MemoryCommitReport {
  const committed = receipts.filter((receipt) => receipt.committed);
  const failed = receipts.filter((receipt) => !receipt.committed);
  const requiredOrderRefs = new Set(report.write_orders.filter((order) => order.outcome === "commit_verified_record" || order.outcome === "commit_contradiction" || order.record_class === "task_episode").map((order) => order.write_order_ref));
  const failedRequired = failed.some((receipt) => requiredOrderRefs.has(receipt.write_order_ref));
  const base = {
    schema_version: MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION,
    committed_receipts: freezeArray(committed),
    failed_receipts: freezeArray(failed),
    source_write_order_refs: freezeArray(report.write_orders.map((order) => order.write_order_ref)),
    all_required_writes_satisfied: !failedRequired,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function targetStateForDisposition(disposition: MemoryWriteDisposition, candidate: MemoryWriteCandidate): PrimaryState {
  if (disposition === "safe_hold_required") {
    return "SafeHold";
  }
  if (disposition === "human_review_required") {
    return "HumanReview";
  }
  if (disposition === "defer") {
    return candidate.final_task_memory ? "HumanReview" : "Observe";
  }
  if (candidate.final_task_memory) {
    return "Complete";
  }
  return candidate.record_class === "search_hint" || candidate.record_class === "observed" ? "Plan" : "Observe";
}

function targetStateForReportDecision(decision: MemoryTransitionDecision): PrimaryState {
  if (decision === "safe_hold_required") {
    return "SafeHold";
  }
  if (decision === "human_review_required" || decision === "blocked") {
    return "HumanReview";
  }
  if (decision === "all_deferred") {
    return "Observe";
  }
  return "MemoryUpdate";
}

function eventTypeForDecision(decision: MemoryTransitionDecision, candidateDecisions: readonly MemoryCandidateDecision[]): OrchestrationEventEnvelope["event_type"] {
  if (decision === "safe_hold_required") {
    return "SafeHoldCommanded";
  }
  if (candidateDecisions.some((candidate) => candidate.outcome === "commit_contradiction")) {
    return "MemoryContradictionDetected";
  }
  if (decision === "write_batch_ready") {
    return "MemoryWriteCandidateReady";
  }
  return "MemoryWritten";
}

function severityForDecision(decision: MemoryTransitionDecision, issues: readonly ValidationIssue[]): EventSeverity {
  if (decision === "safe_hold_required" || issues.some((item) => item.severity === "error" && item.code.includes("Forbidden"))) {
    return "critical";
  }
  if (decision === "human_review_required" || decision === "blocked") {
    return "error";
  }
  if (decision === "all_deferred" || issues.some((item) => item.severity === "warning")) {
    return "warning";
  }
  return "info";
}

function summaryForDecision(decision: MemoryTransitionDecision, writeCount: number, candidateCount: number): string {
  if (decision === "write_batch_ready") {
    return `MemoryTransitionCoordinator prepared ${writeCount} provenance-safe write order(s) from ${candidateCount} candidate(s).`;
  }
  if (decision === "all_deferred") {
    return "MemoryTransitionCoordinator deferred non-critical memory writes without blocking safety.";
  }
  if (decision === "safe_hold_required") {
    return "MemoryTransitionCoordinator detected hidden-truth or restricted memory content and requires SafeHold.";
  }
  if (decision === "human_review_required") {
    return "MemoryTransitionCoordinator requires human review before task completion memory can proceed.";
  }
  if (decision === "nothing_to_write") {
    return "MemoryTransitionCoordinator found no memory writes required by policy.";
  }
  return "MemoryTransitionCoordinator blocked invalid memory write candidates.";
}

function operationForOutcome(outcome: MemoryWriteOutcome): MemoryWriteOperation {
  switch (outcome) {
    case "commit_verified_record":
      return "upsert_verified";
    case "commit_observation_note":
      return "append_observation";
    case "commit_search_hint":
      return "append_search_hint";
    case "commit_contradiction":
      return "commit_contradiction";
    case "commit_episode_only":
      return "append_episode";
    case "quarantine_record":
    case "deny_write":
      return "quarantine";
  }
}

function retrievalPermissionsFor(
  candidate: MemoryWriteCandidate,
  outcome: MemoryWriteOutcome,
  confidenceClass: MemoryConfidenceClass,
): readonly MemoryRetrievalPermission[] {
  if (candidate.retrieval_permissions !== undefined) {
    return freezeArray(candidate.retrieval_permissions);
  }
  if (outcome === "commit_verified_record") {
    return freezeArray(["cognition", "planning_prior", "audit_only"]);
  }
  if (outcome === "commit_observation_note" && confidenceClass === "high_observed") {
    return freezeArray(["planning_prior", "search_only", "audit_only"]);
  }
  if (outcome === "commit_contradiction") {
    return freezeArray(["planning_prior", "search_only", "audit_only"]);
  }
  if (outcome === "commit_episode_only" && (candidate.record_class === "safety" || candidate.record_class === "oops_episode")) {
    return freezeArray(["planning_prior", "audit_only"]);
  }
  return freezeArray(["search_only", "audit_only"]);
}

function confidenceClassFor(candidate: MemoryWriteCandidate, policy: MemoryTransitionPolicy, hiddenTruthIssue: boolean): MemoryConfidenceClass {
  if (hiddenTruthIssue) {
    return "quarantined";
  }
  if (candidate.record_class === "contradiction" || (candidate.contradiction_strength ?? 0) >= policy.contradiction_strength_threshold) {
    return "contradicted";
  }
  if (candidate.verification_certificate_ref !== undefined && candidate.confidence >= policy.min_verified_confidence && candidate.staleness_score <= policy.max_staleness_score) {
    return "verified";
  }
  if (candidate.confidence >= Math.max(policy.min_observed_confidence, 0.72) && candidate.staleness_score <= policy.max_staleness_score) {
    return "high_observed";
  }
  if (candidate.confidence >= policy.min_observed_confidence) {
    return "medium_observed";
  }
  return "low_hypothesis";
}

function hasObservationEvidence(candidate: MemoryWriteCandidate): boolean {
  return candidate.latest_observation_ref !== undefined
    || candidate.evidence_manifests.some((manifest) => manifest.evidence_kind === "observation")
    || candidate.source_evidence_refs.some((ref) => /observation|sensor|view|camera|contact|audio/i.test(ref));
}

function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "MemoryTextRequired", path, "Memory text summary is required.", "Provide prompt-safe memory text."));
    return;
  }
  if (FORBIDDEN_MEMORY_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "MemoryTextForbidden", path, "Memory text contains hidden truth, backend identifiers, prompt-private material, or restricted control data.", "Use embodied evidence summaries only."));
  }
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (FORBIDDEN_MEMORY_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "MemoryReferenceForbidden", path, "Reference contains hidden truth, backend, prompt-private, or restricted-control wording.", "Use an opaque memory, evidence, certificate, or event reference."));
  }
}

function validateUnit(value: number, path: string, code: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(issue("error", code, path, "Value must be finite in [0, 1].", "Clamp or recompute the memory score."));
  }
}

function mergePolicy(policy: Partial<MemoryTransitionPolicy> | undefined): MemoryTransitionPolicy {
  return Object.freeze({
    final_memory_requires_verification_certificate: policy?.final_memory_requires_verification_certificate ?? true,
    allow_verified_to_observed_downgrade: policy?.allow_verified_to_observed_downgrade ?? true,
    allow_observation_notes_without_verification: policy?.allow_observation_notes_without_verification ?? true,
    allow_audio_memory_without_verification: policy?.allow_audio_memory_without_verification ?? true,
    allow_safety_memory_without_verification: policy?.allow_safety_memory_without_verification ?? true,
    defer_noncritical_on_timeout: policy?.defer_noncritical_on_timeout ?? true,
    min_verified_confidence: unitOr(policy?.min_verified_confidence, DEFAULT_MIN_VERIFIED_CONFIDENCE),
    min_observed_confidence: unitOr(policy?.min_observed_confidence, DEFAULT_MIN_OBSERVED_CONFIDENCE),
    min_search_hint_confidence: unitOr(policy?.min_search_hint_confidence, DEFAULT_MIN_SEARCH_HINT_CONFIDENCE),
    max_staleness_score: unitOr(policy?.max_staleness_score, DEFAULT_MAX_STALENESS_SCORE),
    evidence_freshness_ms: positive(policy?.evidence_freshness_ms, DEFAULT_EVIDENCE_FRESHNESS_MS),
    contradiction_strength_threshold: unitOr(policy?.contradiction_strength_threshold, DEFAULT_CONTRADICTION_THRESHOLD),
    memory_write_timeout_ms: positive(policy?.memory_write_timeout_ms, DEFAULT_MEMORY_WRITE_TIMEOUT_MS),
  });
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function unitOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function roundUnit(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_SUMMARY_CHARS);
}

function isWriteOrder(value: MemoryWriteOrder | undefined): value is MemoryWriteOrder {
  return value !== undefined;
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const MEMORY_TRANSITION_COORDINATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MEMORY_TRANSITION_COORDINATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  supporting_blueprint: SUPPORTING_MEMORY_BLUEPRINT_REF,
  sections: freezeArray(["8.3", "8.5", "8.7", "8.9.11", "8.10", "8.14", "8.16", "8.17", "8.18", "8.19"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  normal_exits: freezeArray(["Complete", "Observe", "Plan", "SafeHold"] as readonly PrimaryState[]),
});
