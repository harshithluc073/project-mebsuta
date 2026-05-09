/**
 * State timeline ledger for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.6, 8.7, 8.15, 8.17, 8.18, and 8.19.
 *
 * This module implements the executable `StateTimelineLedger`. It converts
 * state-machine decisions, transitions, guards, deadlines, retry budget updates,
 * safety entries, human-review requests, command-ownership changes, and stale
 * asynchronous responses into deterministic hash-chained timeline entries that
 * are suitable for dashboard audit, QA replay, and state sequence
 * reconstruction.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  DeadlineStateEntry,
  EventSeverity,
  OrchestrationEventEnvelope,
  OrchestrationEventType,
  PrimaryState,
  RetryBudgetState,
  RuntimeStateSnapshot,
  SafetyMode,
  StateGuardDecision,
  StateTransitionDecision,
  StateTransitionRecord,
} from "./orchestration_state_machine";

export const STATE_TIMELINE_LEDGER_SCHEMA_VERSION = "mebsuta.state_timeline_ledger.v1" as const;
export const STATE_TIMELINE_LEDGER_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#StateTimelineLedger" as const;
const DEFAULT_CLOCK_REF = "runtime_clock:scenario_replay_clock" as const;
const MAX_TIMELINE_SUMMARY_CHARS = 900;
const FORBIDDEN_TIMELINE_TEXT_PATTERN = /(world_truth|ground_truth|hidden state|hidden_state|hidden pose|oracle state|qa_truth|backend object|object_id|rigid_body_handle|physics_body|joint_handle|scene_graph|collision_mesh|debug buffer|segmentation truth|depth truth|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|raw actuator|joint torque|apply force|apply impulse|reward policy|policy gradient|reinforcement learning|skip validation|override safety|ignore safety)/i;

export type TimelineEventType =
  | "StateEntered"
  | "StateExited"
  | "GuardEvaluated"
  | "DeadlineStarted"
  | "DeadlineExpired"
  | "RetryBudgetConsumed"
  | "SafeHoldEntered"
  | "HumanReviewRequested"
  | "CommandOwnershipChanged"
  | "StaleResponseQuarantined";

export type TimelineSeverity = "debug" | "info" | "notice" | "warning" | "error" | "critical";
export type TimelineEventClass = "state" | "guard" | "deadline" | "retry" | "safety" | "operator" | "command" | "async" | "audit";
export type TimelineVisibility = "developer" | "operator" | "qa" | "safety_review" | "demo";
export type ReplayCompleteness = "complete" | "partial" | "insufficient";
export type LedgerAppendDecision = "accepted" | "accepted_with_warnings" | "rejected";

export interface StateTimelineLedgerPolicy {
  readonly require_hash_chain_continuity: boolean;
  readonly reject_forbidden_summary_text: boolean;
  readonly max_summary_chars: number;
  readonly default_clock_ref: Ref;
  readonly include_guard_detail_entries: boolean;
  readonly include_deadline_detail_entries: boolean;
  readonly include_retry_detail_entries: boolean;
  readonly allowed_visibility: readonly TimelineVisibility[];
}

export interface StateTimelineEntry {
  readonly schema_version: typeof STATE_TIMELINE_LEDGER_SCHEMA_VERSION;
  readonly ledger_entry_ref: Ref;
  readonly sequence_index: number;
  readonly event_type: TimelineEventType;
  readonly event_class: TimelineEventClass;
  readonly severity: TimelineSeverity;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly primary_state: PrimaryState;
  readonly from_state?: PrimaryState;
  readonly to_state?: PrimaryState;
  readonly safety_mode?: SafetyMode;
  readonly trigger_event?: OrchestrationEventType;
  readonly source_event_ref?: Ref;
  readonly transition_ref?: Ref;
  readonly snapshot_ref: Ref;
  readonly timestamp_ms: number;
  readonly timestamp_ref: Ref;
  readonly clock_ref: Ref;
  readonly summary: string;
  readonly guard_name?: string;
  readonly guard_decision?: StateGuardDecision["decision"];
  readonly guard_blocking?: boolean;
  readonly deadline_ref?: Ref;
  readonly deadline_class?: DeadlineStateEntry["deadline_class"];
  readonly deadline_duration_ms?: number;
  readonly deadline_elapsed_ms?: number;
  readonly retry_budget_name?: RetryBudgetState["budget_name"];
  readonly retry_remaining_attempts?: number;
  readonly command_owner_before?: PrimaryState;
  readonly command_owner_after?: PrimaryState;
  readonly active_primitive_ref?: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly payload_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly visibility: readonly TimelineVisibility[];
  readonly previous_entry_hash?: string;
  readonly entry_hash: string;
  readonly determinism_hash: string;
}

export interface TimelineAppendRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly transition_decision?: StateTransitionDecision;
  readonly committed_snapshot?: RuntimeStateSnapshot;
  readonly source_event?: OrchestrationEventEnvelope;
  readonly occurred_at_ms: number;
  readonly prior_entries?: readonly StateTimelineEntry[];
  readonly policy?: Partial<StateTimelineLedgerPolicy>;
}

export interface StaleResponseQuarantineRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly stale_event: OrchestrationEventEnvelope;
  readonly response_type: "gemini_planning" | "repair" | "tts_completion" | "validator_report" | "execution_telemetry" | "verification_certificate" | "unknown";
  readonly original_request_ref?: Ref;
  readonly occurred_at_ms: number;
  readonly no_effect_reason: string;
  readonly prior_entries?: readonly StateTimelineEntry[];
  readonly policy?: Partial<StateTimelineLedgerPolicy>;
}

export interface TimelineReplayTrace {
  readonly schema_version: typeof STATE_TIMELINE_LEDGER_SCHEMA_VERSION;
  readonly replay_trace_ref: Ref;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly ordered_entry_refs: readonly Ref[];
  readonly state_sequence: readonly PrimaryState[];
  readonly transition_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly payload_refs: readonly Ref[];
  readonly start_timestamp_ms: number;
  readonly end_timestamp_ms: number;
  readonly replay_completeness: ReplayCompleteness;
  readonly missing_event_types: readonly TimelineEventType[];
  readonly hash_chain_valid: boolean;
  readonly determinism_hash: string;
}

export interface DashboardStateSummary {
  readonly schema_version: typeof STATE_TIMELINE_LEDGER_SCHEMA_VERSION;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly current_state: PrimaryState;
  readonly safety_mode: SafetyMode;
  readonly active_objective: Ref;
  readonly last_transition_reason: string;
  readonly waiting_on: string;
  readonly retry_budget_summary: readonly string[];
  readonly latest_confidence?: string;
  readonly latest_safety_block?: string;
  readonly evidence_refs: readonly Ref[];
  readonly latest_timeline_ref: Ref;
  readonly determinism_hash: string;
}

export interface StateTimelineLedgerReport {
  readonly schema_version: typeof STATE_TIMELINE_LEDGER_SCHEMA_VERSION;
  readonly ledger_version: typeof STATE_TIMELINE_LEDGER_VERSION;
  readonly append_decision: LedgerAppendDecision;
  readonly entries: readonly StateTimelineEntry[];
  readonly replay_trace: TimelineReplayTrace;
  readonly dashboard_summary: DashboardStateSummary;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

export interface LedgerAppendReceipt {
  readonly accepted: boolean;
  readonly receipt_ref: Ref;
  readonly accepted_entry_refs: readonly Ref[];
  readonly rejected_entry_refs: readonly Ref[];
  readonly persisted_at_ms: number;
  readonly error_summary?: string;
}

export interface StateTimelineLedgerSinkPort {
  readonly appendTimelineEntries: (entries: readonly StateTimelineEntry[]) => LedgerAppendReceipt | Promise<LedgerAppendReceipt>;
}

/**
 * Deterministic timeline ledger. It has no global mutable state; callers provide
 * prior entries explicitly so tests, replay tools, and state stores can own
 * persistence policy.
 */
export class StateTimelineLedger {
  /**
   * Builds timeline entries from one state transition decision and optional
   * committed snapshot. Blocked transitions still produce guard and stale-audit
   * entries without claiming state mutation.
   */
  public appendTransitionDecision(request: TimelineAppendRequest): StateTimelineLedgerReport {
    const policy = mergePolicy(request.policy);
    const issues = validateAppendRequest(request, policy);
    const priorEntries = freezeArray(request.prior_entries ?? []);
    const firstIndex = nextSequenceIndex(priorEntries);
    const newEntries = buildEntriesForTransition(request, policy, firstIndex, lastEntryHash(priorEntries));
    const allEntries = freezeArray([...priorEntries, ...newEntries]);
    issues.push(...validateHashChain(allEntries, policy));
    const appendDecision = chooseAppendDecision(issues);
    const replayTrace = buildReplayTrace(allEntries, request.snapshot.session_ref, request.snapshot.task_ref);
    const dashboard = projectDashboardState(allEntries, request.committed_snapshot ?? request.snapshot);
    return makeReport(appendDecision, newEntries, replayTrace, dashboard, issues);
  }

  /**
   * Records a stale asynchronous response that must be visible for QA replay but
   * must not mutate runtime state.
   */
  public recordStaleResponseQuarantine(request: StaleResponseQuarantineRequest): StateTimelineLedgerReport {
    const policy = mergePolicy(request.policy);
    const priorEntries = freezeArray(request.prior_entries ?? []);
    const issues = validateStaleResponseRequest(request, policy);
    const entry = makeEntry({
      sequence_index: nextSequenceIndex(priorEntries),
      event_type: "StaleResponseQuarantined",
      event_class: "async",
      severity: severityFromEvent(request.stale_event.severity),
      snapshot: request.snapshot,
      timestamp_ms: request.occurred_at_ms,
      source_event_ref: request.stale_event.event_ref,
      trigger_event: request.stale_event.event_type,
      summary: `Stale ${request.response_type} response had no state effect: ${request.no_effect_reason}`,
      evidence_refs: uniqueRefs([request.original_request_ref, request.stale_event.context_ref, ...request.stale_event.payload_refs]),
      payload_refs: request.stale_event.payload_refs,
      visibility: freezeArray(["developer", "qa", "operator"]),
      previous_entry_hash: lastEntryHash(priorEntries),
      clock_ref: policy.default_clock_ref,
    });
    const allEntries = freezeArray([...priorEntries, entry]);
    issues.push(...validateHashChain(allEntries, policy));
    return makeReport(chooseAppendDecision(issues), [entry], buildReplayTrace(allEntries, request.snapshot.session_ref, request.snapshot.task_ref), projectDashboardState(allEntries, request.snapshot), issues);
  }

  /**
   * Projects dashboard state from ledger entries. This is exposed as a direct
   * API because the HUD and observability systems should not parse raw entries.
   */
  public projectDashboardState(entries: readonly StateTimelineEntry[], fallbackSnapshot: RuntimeStateSnapshot): DashboardStateSummary {
    return projectDashboardState(freezeArray(entries), fallbackSnapshot);
  }

  /**
   * Assembles a replay trace with deterministic ordering, evidence refs,
   * payload refs, state sequence, transition refs, and hash-chain status.
   */
  public assembleReplayTrace(entries: readonly StateTimelineEntry[], sessionRef: Ref, taskRef: Ref): TimelineReplayTrace {
    return buildReplayTrace(freezeArray(entries), sessionRef, taskRef);
  }

  /**
   * Persists already-built entries through an injected sink. The sink is the API
   * boundary for files, databases, or observability services.
   */
  public async persistReport(report: StateTimelineLedgerReport, sink: StateTimelineLedgerSinkPort, persistedAtMs: number): Promise<LedgerAppendReceipt> {
    try {
      const receipt = await sink.appendTimelineEntries(report.entries);
      return Object.freeze({ ...receipt });
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      return Object.freeze({
        accepted: false,
        receipt_ref: makeRef("timeline_receipt", "failed", persistedAtMs),
        accepted_entry_refs: freezeArray([]),
        rejected_entry_refs: freezeArray(report.entries.map((entry) => entry.ledger_entry_ref)),
        persisted_at_ms: persistedAtMs,
        error_summary: compactText(summary),
      });
    }
  }
}

function buildEntriesForTransition(
  request: TimelineAppendRequest,
  policy: StateTimelineLedgerPolicy,
  firstIndex: number,
  previousHash: string | undefined,
): readonly StateTimelineEntry[] {
  const entries: StateTimelineEntry[] = [];
  let index = firstIndex;
  let prevHash = previousHash;
  const record = request.transition_decision?.transition_record;
  const sourceEvent = request.source_event;
  if (record !== undefined) {
    const exited = makeEntry({
      sequence_index: index,
      event_type: "StateExited",
      event_class: "state",
      severity: "info",
      snapshot: request.snapshot,
      timestamp_ms: request.occurred_at_ms,
      from_state: record.from_state,
      to_state: record.to_state,
      transition_ref: record.transition_ref,
      source_event_ref: request.transition_decision?.event_ref,
      trigger_event: record.trigger_event,
      summary: `State exited ${record.from_state} for ${record.to_state} after ${record.trigger_event}.`,
      evidence_refs: guardEvidenceRefs(record.guard_results),
      payload_refs: record.payload_refs,
      visibility: freezeArray(["developer", "operator", "qa"]),
      previous_entry_hash: prevHash,
      clock_ref: policy.default_clock_ref,
    });
    entries.push(exited);
    index += 1;
    prevHash = exited.entry_hash;
  }
  if (policy.include_guard_detail_entries && request.transition_decision !== undefined) {
    for (const guardResult of request.transition_decision.guard_results) {
      const entry = makeGuardEntry(index, request.snapshot, guardResult, request.transition_decision, record, request.occurred_at_ms, prevHash, policy.default_clock_ref);
      entries.push(entry);
      index += 1;
      prevHash = entry.entry_hash;
    }
  }
  if (request.transition_decision?.consumed_retry_budget !== undefined && policy.include_retry_detail_entries) {
    const retryEntry = makeRetryEntry(index, request.snapshot, request.transition_decision.consumed_retry_budget, request.transition_decision, request.occurred_at_ms, prevHash, policy.default_clock_ref);
    entries.push(retryEntry);
    index += 1;
    prevHash = retryEntry.entry_hash;
  }
  if (request.committed_snapshot !== undefined && record !== undefined) {
    const entered = makeEntry({
      sequence_index: index,
      event_type: "StateEntered",
      event_class: "state",
      severity: severityForStateEntry(request.committed_snapshot.primary_state),
      snapshot: request.committed_snapshot,
      timestamp_ms: request.occurred_at_ms,
      from_state: record.from_state,
      to_state: record.to_state,
      transition_ref: record.transition_ref,
      source_event_ref: request.transition_decision?.event_ref,
      trigger_event: record.trigger_event,
      summary: record.human_visible_summary,
      evidence_refs: uniqueRefs([request.committed_snapshot.latest_observation_ref, request.committed_snapshot.latest_verification_ref, request.committed_snapshot.active_plan_ref, request.committed_snapshot.active_primitive_ref]),
      payload_refs: record.payload_refs,
      visibility: freezeArray(["developer", "operator", "qa", "demo"]),
      previous_entry_hash: prevHash,
      clock_ref: policy.default_clock_ref,
    });
    entries.push(entered);
    index += 1;
    prevHash = entered.entry_hash;
    if (request.snapshot.command_owner_state !== request.committed_snapshot.command_owner_state) {
      const commandEntry = makeCommandOwnershipEntry(index, request.snapshot, request.committed_snapshot, request.occurred_at_ms, record, prevHash, policy.default_clock_ref);
      entries.push(commandEntry);
      index += 1;
      prevHash = commandEntry.entry_hash;
    }
    if ((request.committed_snapshot.primary_state === "SafeHold" || request.committed_snapshot.primary_state === "HumanReview") && sourceEvent !== undefined) {
      const safetyEntry = makeSafetyOrReviewEntry(index, request.committed_snapshot, sourceEvent, record, prevHash, policy.default_clock_ref);
      entries.push(safetyEntry);
      index += 1;
      prevHash = safetyEntry.entry_hash;
    }
    if (policy.include_deadline_detail_entries) {
      for (const deadline of request.committed_snapshot.deadline_state.filter((item) => !request.snapshot.deadline_state.some((prior) => prior.deadline_ref === item.deadline_ref))) {
        const deadlineEntry = makeDeadlineEntry(index, request.committed_snapshot, deadline, "DeadlineStarted", request.occurred_at_ms, record, prevHash, policy.default_clock_ref);
        entries.push(deadlineEntry);
        index += 1;
        prevHash = deadlineEntry.entry_hash;
      }
    }
  }
  if (sourceEvent !== undefined && sourceEvent.event_type === "ModelResponseReceived" && request.transition_decision?.decision === "blocked") {
    const staleEntry = makeEntry({
      sequence_index: index,
      event_type: "StaleResponseQuarantined",
      event_class: "async",
      severity: "warning",
      snapshot: request.snapshot,
      timestamp_ms: request.occurred_at_ms,
      source_event_ref: sourceEvent.event_ref,
      trigger_event: sourceEvent.event_type,
      summary: "Blocked model response was quarantined and did not mutate state.",
      evidence_refs: uniqueRefs([sourceEvent.context_ref, ...sourceEvent.payload_refs]),
      payload_refs: sourceEvent.payload_refs,
      visibility: freezeArray(["developer", "qa"]),
      previous_entry_hash: prevHash,
      clock_ref: policy.default_clock_ref,
    });
    entries.push(staleEntry);
  }
  return freezeArray(entries);
}

function makeGuardEntry(
  sequenceIndex: number,
  snapshot: RuntimeStateSnapshot,
  guardResult: StateGuardDecision,
  decision: StateTransitionDecision,
  record: StateTransitionRecord | undefined,
  timestampMs: number,
  previousHash: string | undefined,
  clockRef: Ref,
): StateTimelineEntry {
  return makeEntry({
    sequence_index: sequenceIndex,
    event_type: "GuardEvaluated",
    event_class: "guard",
    severity: guardResult.blocking ? "error" : guardResult.decision === "warning" ? "warning" : "debug",
    snapshot,
    timestamp_ms: timestampMs,
    from_state: record?.from_state ?? snapshot.primary_state,
    to_state: record?.to_state ?? decision.proposed_to_state,
    transition_ref: record?.transition_ref,
    source_event_ref: decision.event_ref,
    trigger_event: record?.trigger_event,
    guard_name: guardResult.guard_name,
    guard_decision: guardResult.decision,
    guard_blocking: guardResult.blocking,
    summary: `${guardResult.guard_name}: ${guardResult.reason}`,
    evidence_refs: guardResult.evidence_refs,
    payload_refs: record?.payload_refs ?? [],
    visibility: freezeArray(["developer", "qa"]),
    previous_entry_hash: previousHash,
    clock_ref: clockRef,
  });
}

function makeRetryEntry(
  sequenceIndex: number,
  snapshot: RuntimeStateSnapshot,
  budget: RetryBudgetState,
  decision: StateTransitionDecision,
  timestampMs: number,
  previousHash: string | undefined,
  clockRef: Ref,
): StateTimelineEntry {
  return makeEntry({
    sequence_index: sequenceIndex,
    event_type: "RetryBudgetConsumed",
    event_class: "retry",
    severity: budget.remaining_attempts <= 0 ? "warning" : "notice",
    snapshot,
    timestamp_ms: timestampMs,
    source_event_ref: decision.event_ref,
    trigger_event: decision.transition_record?.trigger_event,
    transition_ref: decision.transition_record?.transition_ref,
    retry_budget_name: budget.budget_name,
    retry_remaining_attempts: budget.remaining_attempts,
    summary: `${budget.budget_name} now has ${budget.remaining_attempts} remaining attempt(s).`,
    evidence_refs: uniqueRefs([budget.scope_ref]),
    payload_refs: decision.transition_record?.payload_refs ?? [],
    visibility: freezeArray(["developer", "operator", "qa"]),
    previous_entry_hash: previousHash,
    clock_ref: clockRef,
  });
}

function makeDeadlineEntry(
  sequenceIndex: number,
  snapshot: RuntimeStateSnapshot,
  deadline: DeadlineStateEntry,
  eventType: "DeadlineStarted" | "DeadlineExpired",
  timestampMs: number,
  record: StateTransitionRecord | undefined,
  previousHash: string | undefined,
  clockRef: Ref,
): StateTimelineEntry {
  return makeEntry({
    sequence_index: sequenceIndex,
    event_type: eventType,
    event_class: "deadline",
    severity: eventType === "DeadlineExpired" ? "warning" : "debug",
    snapshot,
    timestamp_ms: timestampMs,
    transition_ref: record?.transition_ref,
    trigger_event: record?.trigger_event,
    deadline_ref: deadline.deadline_ref,
    deadline_class: deadline.deadline_class,
    deadline_duration_ms: deadline.duration_ms,
    deadline_elapsed_ms: deadline.elapsed_ms,
    summary: `${eventType} for ${deadline.owner_state} using ${deadline.deadline_class}; target ${deadline.timeout_target}.`,
    evidence_refs: uniqueRefs([deadline.deadline_ref]),
    payload_refs: record?.payload_refs ?? [],
    visibility: freezeArray(["developer", "qa"]),
    previous_entry_hash: previousHash,
    clock_ref: clockRef,
  });
}

function makeCommandOwnershipEntry(
  sequenceIndex: number,
  previousSnapshot: RuntimeStateSnapshot,
  nextSnapshot: RuntimeStateSnapshot,
  timestampMs: number,
  record: StateTransitionRecord,
  previousHash: string | undefined,
  clockRef: Ref,
): StateTimelineEntry {
  return makeEntry({
    sequence_index: sequenceIndex,
    event_type: "CommandOwnershipChanged",
    event_class: "command",
    severity: nextSnapshot.command_owner_state === "Execute" ? "notice" : "info",
    snapshot: nextSnapshot,
    timestamp_ms: timestampMs,
    from_state: record.from_state,
    to_state: record.to_state,
    transition_ref: record.transition_ref,
    trigger_event: record.trigger_event,
    command_owner_before: previousSnapshot.command_owner_state,
    command_owner_after: nextSnapshot.command_owner_state,
    active_primitive_ref: nextSnapshot.active_primitive_ref,
    summary: `Command ownership changed from ${previousSnapshot.command_owner_state ?? "none"} to ${nextSnapshot.command_owner_state ?? "none"}.`,
    evidence_refs: uniqueRefs([previousSnapshot.active_primitive_ref, nextSnapshot.active_primitive_ref]),
    payload_refs: record.payload_refs,
    visibility: freezeArray(["developer", "operator", "qa"]),
    previous_entry_hash: previousHash,
    clock_ref: clockRef,
  });
}

function makeSafetyOrReviewEntry(
  sequenceIndex: number,
  snapshot: RuntimeStateSnapshot,
  sourceEvent: OrchestrationEventEnvelope,
  record: StateTransitionRecord,
  previousHash: string | undefined,
  clockRef: Ref,
): StateTimelineEntry {
  const safeHold = snapshot.primary_state === "SafeHold";
  return makeEntry({
    sequence_index: sequenceIndex,
    event_type: safeHold ? "SafeHoldEntered" : "HumanReviewRequested",
    event_class: safeHold ? "safety" : "operator",
    severity: safeHold ? "critical" : "error",
    snapshot,
    timestamp_ms: sourceEvent.occurred_at_ms,
    from_state: record.from_state,
    to_state: record.to_state,
    transition_ref: record.transition_ref,
    source_event_ref: sourceEvent.event_ref,
    trigger_event: sourceEvent.event_type,
    summary: safeHold ? `SafeHold entered after ${sourceEvent.event_type}.` : `Human review requested after ${sourceEvent.event_type}.`,
    evidence_refs: uniqueRefs([snapshot.active_plan_ref, snapshot.active_primitive_ref, snapshot.latest_observation_ref, ...sourceEvent.payload_refs]),
    payload_refs: record.payload_refs,
    visibility: freezeArray(["developer", "operator", "qa", "safety_review"]),
    previous_entry_hash: previousHash,
    clock_ref: clockRef,
  });
}

function makeEntry(input: {
  readonly sequence_index: number;
  readonly event_type: TimelineEventType;
  readonly event_class: TimelineEventClass;
  readonly severity: TimelineSeverity;
  readonly snapshot: RuntimeStateSnapshot;
  readonly timestamp_ms: number;
  readonly from_state?: PrimaryState;
  readonly to_state?: PrimaryState;
  readonly source_event_ref?: Ref;
  readonly transition_ref?: Ref;
  readonly trigger_event?: OrchestrationEventType;
  readonly summary: string;
  readonly guard_name?: string;
  readonly guard_decision?: StateGuardDecision["decision"];
  readonly guard_blocking?: boolean;
  readonly deadline_ref?: Ref;
  readonly deadline_class?: DeadlineStateEntry["deadline_class"];
  readonly deadline_duration_ms?: number;
  readonly deadline_elapsed_ms?: number;
  readonly retry_budget_name?: RetryBudgetState["budget_name"];
  readonly retry_remaining_attempts?: number;
  readonly command_owner_before?: PrimaryState;
  readonly command_owner_after?: PrimaryState;
  readonly active_primitive_ref?: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly payload_refs: readonly Ref[];
  readonly visibility: readonly TimelineVisibility[];
  readonly previous_entry_hash?: string;
  readonly clock_ref: Ref;
}): StateTimelineEntry {
  const safeSummary = sanitizeSummary(input.summary);
  const timestampRef = makeRef("timeline_ts", input.snapshot.session_ref, input.timestamp_ms, input.sequence_index);
  const baseWithoutHashes = {
    schema_version: STATE_TIMELINE_LEDGER_SCHEMA_VERSION,
    ledger_entry_ref: makeRef("timeline_entry", input.snapshot.session_ref, input.snapshot.task_ref, input.sequence_index, input.event_type, input.timestamp_ms),
    sequence_index: input.sequence_index,
    event_type: input.event_type,
    event_class: input.event_class,
    severity: input.severity,
    session_ref: input.snapshot.session_ref,
    task_ref: input.snapshot.task_ref,
    primary_state: input.snapshot.primary_state,
    from_state: input.from_state,
    to_state: input.to_state,
    safety_mode: input.snapshot.safety_mode,
    trigger_event: input.trigger_event,
    source_event_ref: input.source_event_ref,
    transition_ref: input.transition_ref,
    snapshot_ref: input.snapshot.current_context_ref,
    timestamp_ms: input.timestamp_ms,
    timestamp_ref: timestampRef,
    clock_ref: input.clock_ref,
    summary: safeSummary,
    guard_name: input.guard_name,
    guard_decision: input.guard_decision,
    guard_blocking: input.guard_blocking,
    deadline_ref: input.deadline_ref,
    deadline_class: input.deadline_class,
    deadline_duration_ms: input.deadline_duration_ms,
    deadline_elapsed_ms: input.deadline_elapsed_ms,
    retry_budget_name: input.retry_budget_name,
    retry_remaining_attempts: input.retry_remaining_attempts,
    command_owner_before: input.command_owner_before,
    command_owner_after: input.command_owner_after,
    active_primitive_ref: input.active_primitive_ref,
    evidence_refs: freezeArray(uniqueRefs(input.evidence_refs)),
    payload_refs: freezeArray(uniqueRefs(input.payload_refs)),
    audit_refs: freezeArray(input.snapshot.audit_refs),
    visibility: freezeArray(input.visibility),
    previous_entry_hash: input.previous_entry_hash,
  };
  const entryHash = computeDeterminismHash(baseWithoutHashes);
  const full = {
    ...baseWithoutHashes,
    entry_hash: entryHash,
  };
  return Object.freeze({
    ...full,
    determinism_hash: computeDeterminismHash(full),
  });
}

function buildReplayTrace(entries: readonly StateTimelineEntry[], sessionRef: Ref, taskRef: Ref): TimelineReplayTrace {
  const ordered = orderEntries(entries).filter((entry) => entry.session_ref === sessionRef && entry.task_ref === taskRef);
  const eventTypes = new Set(ordered.map((entry) => entry.event_type));
  const missing = REQUIRED_REPLAY_EVENT_TYPES.filter((eventType) => !eventTypes.has(eventType));
  const states = ordered.reduce<PrimaryState[]>((accumulator, entry) => {
    const nextState = entry.to_state ?? entry.primary_state;
    if (accumulator[accumulator.length - 1] !== nextState) {
      accumulator.push(nextState);
    }
    return accumulator;
  }, []);
  const hashChainValid = validateHashChain(ordered, { ...DEFAULT_POLICY, require_hash_chain_continuity: true }).length === 0;
  const completeness: ReplayCompleteness = missing.length === 0 && hashChainValid ? "complete" : ordered.length > 0 ? "partial" : "insufficient";
  const base = {
    schema_version: STATE_TIMELINE_LEDGER_SCHEMA_VERSION,
    replay_trace_ref: makeRef("replay_trace", sessionRef, taskRef, ordered[0]?.timestamp_ms, ordered[ordered.length - 1]?.timestamp_ms),
    session_ref: sessionRef,
    task_ref: taskRef,
    ordered_entry_refs: freezeArray(ordered.map((entry) => entry.ledger_entry_ref)),
    state_sequence: freezeArray(states),
    transition_refs: uniqueRefs(ordered.map((entry) => entry.transition_ref)),
    evidence_refs: uniqueRefs(ordered.flatMap((entry) => entry.evidence_refs)),
    payload_refs: uniqueRefs(ordered.flatMap((entry) => entry.payload_refs)),
    start_timestamp_ms: ordered[0]?.timestamp_ms ?? 0,
    end_timestamp_ms: ordered[ordered.length - 1]?.timestamp_ms ?? 0,
    replay_completeness: completeness,
    missing_event_types: freezeArray(missing),
    hash_chain_valid: hashChainValid,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function projectDashboardState(entries: readonly StateTimelineEntry[], fallbackSnapshot: RuntimeStateSnapshot): DashboardStateSummary {
  const ordered = orderEntries(entries).filter((entry) => entry.session_ref === fallbackSnapshot.session_ref && entry.task_ref === fallbackSnapshot.task_ref);
  const latest = ordered[ordered.length - 1];
  const stateEntry = [...ordered].reverse().find((entry) => entry.event_type === "StateEntered" || entry.event_type === "SafeHoldEntered" || entry.event_type === "HumanReviewRequested");
  const lastGuardBlock = [...ordered].reverse().find((entry) => entry.event_type === "GuardEvaluated" && entry.guard_blocking === true);
  const retrySummaries = fallbackSnapshot.retry_budget_state.map((budget) => `${budget.budget_name}:${budget.remaining_attempts}`);
  const waitingOn = waitingOnForState(latest?.to_state ?? latest?.primary_state ?? fallbackSnapshot.primary_state);
  const base = {
    schema_version: STATE_TIMELINE_LEDGER_SCHEMA_VERSION,
    session_ref: fallbackSnapshot.session_ref,
    task_ref: fallbackSnapshot.task_ref,
    current_state: stateEntry?.to_state ?? latest?.primary_state ?? fallbackSnapshot.primary_state,
    safety_mode: latest?.safety_mode ?? fallbackSnapshot.safety_mode,
    active_objective: fallbackSnapshot.task_ref,
    last_transition_reason: stateEntry?.summary ?? latest?.summary ?? fallbackSnapshot.substate ?? "No timeline entries available.",
    waiting_on: waitingOn,
    retry_budget_summary: freezeArray(retrySummaries),
    latest_confidence: latestConfidenceLabel(ordered),
    latest_safety_block: lastGuardBlock?.summary,
    evidence_refs: uniqueRefs([...(latest?.evidence_refs ?? []), fallbackSnapshot.latest_observation_ref, fallbackSnapshot.latest_verification_ref]),
    latest_timeline_ref: latest?.ledger_entry_ref ?? makeRef("timeline_entry", fallbackSnapshot.session_ref, "empty"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateAppendRequest(request: TimelineAppendRequest, policy: StateTimelineLedgerPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateSnapshot(request.snapshot, "$.snapshot", issues);
  if (request.committed_snapshot !== undefined) {
    validateSnapshot(request.committed_snapshot, "$.committed_snapshot", issues);
  }
  if (request.occurred_at_ms < 0 || !Number.isFinite(request.occurred_at_ms)) {
    issues.push(issue("error", "TimelineTimestampInvalid", "$.occurred_at_ms", "Timeline timestamp must be finite and nonnegative.", "Use the scenario replay clock."));
  }
  if (request.transition_decision !== undefined) {
    validateRef(request.transition_decision.event_ref, "$.transition_decision.event_ref", issues);
    for (const [index, guardResult] of request.transition_decision.guard_results.entries()) {
      validateSafeText(guardResult.reason, `$.transition_decision.guard_results[${index}].reason`, true, policy, issues);
      for (const [refIndex, ref] of guardResult.evidence_refs.entries()) {
        validateRef(ref, `$.transition_decision.guard_results[${index}].evidence_refs[${refIndex}]`, issues);
      }
    }
  }
  if (request.source_event !== undefined) {
    validateRef(request.source_event.event_ref, "$.source_event.event_ref", issues);
    validateSafeText(request.source_event.human_summary, "$.source_event.human_summary", true, policy, issues);
  }
  return issues;
}

function validateStaleResponseRequest(request: StaleResponseQuarantineRequest, policy: StateTimelineLedgerPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateSnapshot(request.snapshot, "$.snapshot", issues);
  validateRef(request.stale_event.event_ref, "$.stale_event.event_ref", issues);
  validateSafeText(request.no_effect_reason, "$.no_effect_reason", true, policy, issues);
  if (request.stale_event.session_ref !== request.snapshot.session_ref || request.stale_event.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("warning", "StaleResponseSessionTaskMismatch", "$.stale_event", "Stale event does not match the current snapshot.", "Preserve for audit but do not mutate state."));
  }
  return issues;
}

function validateSnapshot(snapshot: RuntimeStateSnapshot, path: string, issues: ValidationIssue[]): void {
  validateRef(snapshot.session_ref, `${path}.session_ref`, issues);
  validateRef(snapshot.task_ref, `${path}.task_ref`, issues);
  validateRef(snapshot.current_context_ref, `${path}.current_context_ref`, issues);
  validateRef(snapshot.embodiment_ref, `${path}.embodiment_ref`, issues);
}

function validateHashChain(entries: readonly StateTimelineEntry[], policy: Pick<StateTimelineLedgerPolicy, "require_hash_chain_continuity">): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!policy.require_hash_chain_continuity) {
    return issues;
  }
  const ordered = orderEntries(entries);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].previous_entry_hash !== ordered[index - 1].entry_hash) {
      issues.push(issue("error", "TimelineHashChainBroken", `$.entries[${index}].previous_entry_hash`, "Timeline hash chain is not continuous.", "Append entries in deterministic sequence and preserve previous entry hashes."));
    }
  }
  return issues;
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (FORBIDDEN_TIMELINE_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "TimelineReferenceForbidden", path, "Reference contains hidden-truth, prompt-private, or restricted-control wording.", "Use prompt-safe opaque references."));
  }
}

function validateSafeText(value: string, path: string, required: boolean, policy: StateTimelineLedgerPolicy, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "TimelineTextRequired", path, "Timeline text is required.", "Provide a concise redacted timeline summary."));
    return;
  }
  if (policy.reject_forbidden_summary_text && FORBIDDEN_TIMELINE_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "TimelineTextForbidden", path, "Timeline text contains hidden-truth, prompt-private, or restricted-control wording.", "Redact the text before writing to the ledger."));
  }
}

function makeReport(
  appendDecision: LedgerAppendDecision,
  entries: readonly StateTimelineEntry[],
  replayTrace: TimelineReplayTrace,
  dashboardSummary: DashboardStateSummary,
  issues: readonly ValidationIssue[],
): StateTimelineLedgerReport {
  const base = {
    schema_version: STATE_TIMELINE_LEDGER_SCHEMA_VERSION,
    ledger_version: STATE_TIMELINE_LEDGER_VERSION,
    append_decision: appendDecision,
    entries: freezeArray(entries),
    replay_trace: replayTrace,
    dashboard_summary: dashboardSummary,
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function chooseAppendDecision(issues: readonly ValidationIssue[]): LedgerAppendDecision {
  if (issues.some((item) => item.severity === "error")) {
    return "rejected";
  }
  return issues.some((item) => item.severity === "warning") ? "accepted_with_warnings" : "accepted";
}

function severityFromEvent(severity: EventSeverity): TimelineSeverity {
  if (severity === "critical") {
    return "critical";
  }
  if (severity === "error") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  if (severity === "notice") {
    return "notice";
  }
  return "info";
}

function severityForStateEntry(state: PrimaryState): TimelineSeverity {
  if (state === "SafeHold" || state === "Abort") {
    return "critical";
  }
  if (state === "HumanReview") {
    return "error";
  }
  return "info";
}

function waitingOnForState(state: PrimaryState): string {
  switch (state) {
    case "Observe":
    case "Reobserve":
      return "sensor";
    case "Plan":
    case "PlanRepair":
    case "Correct":
    case "ToolAssess":
    case "AudioAttend":
      return "model";
    case "Validate":
      return "validator";
    case "Monologue":
      return "tts";
    case "Execute":
      return "controller";
    case "Verify":
      return "verification";
    case "MemoryUpdate":
      return "memory";
    case "SafeHold":
    case "HumanReview":
      return "operator";
    default:
      return "none";
  }
}

function latestConfidenceLabel(entries: readonly StateTimelineEntry[]): string | undefined {
  const latestWarning = [...entries].reverse().find((entry) => /confidence|ambiguous|uncertain/i.test(entry.summary));
  return latestWarning?.summary;
}

function guardEvidenceRefs(guards: readonly StateGuardDecision[]): readonly Ref[] {
  return uniqueRefs(guards.flatMap((guard) => guard.evidence_refs));
}

function orderEntries(entries: readonly StateTimelineEntry[]): readonly StateTimelineEntry[] {
  return freezeArray([...entries].sort((left, right) => left.sequence_index - right.sequence_index || left.timestamp_ms - right.timestamp_ms || left.ledger_entry_ref.localeCompare(right.ledger_entry_ref)));
}

function nextSequenceIndex(entries: readonly StateTimelineEntry[]): number {
  return entries.length === 0 ? 0 : Math.max(...entries.map((entry) => entry.sequence_index)) + 1;
}

function lastEntryHash(entries: readonly StateTimelineEntry[]): string | undefined {
  return orderEntries(entries)[entries.length - 1]?.entry_hash;
}

function sanitizeSummary(summary: string): string {
  const compact = compactText(summary);
  return FORBIDDEN_TIMELINE_TEXT_PATTERN.test(compact)
    ? compact.replace(FORBIDDEN_TIMELINE_TEXT_PATTERN, "[redacted_timeline_content]")
    : compact;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TIMELINE_SUMMARY_CHARS);
}

function mergePolicy(policy: Partial<StateTimelineLedgerPolicy> | undefined): StateTimelineLedgerPolicy {
  return Object.freeze({
    require_hash_chain_continuity: policy?.require_hash_chain_continuity ?? DEFAULT_POLICY.require_hash_chain_continuity,
    reject_forbidden_summary_text: policy?.reject_forbidden_summary_text ?? DEFAULT_POLICY.reject_forbidden_summary_text,
    max_summary_chars: positiveInteger(policy?.max_summary_chars, DEFAULT_POLICY.max_summary_chars),
    default_clock_ref: policy?.default_clock_ref ?? DEFAULT_POLICY.default_clock_ref,
    include_guard_detail_entries: policy?.include_guard_detail_entries ?? DEFAULT_POLICY.include_guard_detail_entries,
    include_deadline_detail_entries: policy?.include_deadline_detail_entries ?? DEFAULT_POLICY.include_deadline_detail_entries,
    include_retry_detail_entries: policy?.include_retry_detail_entries ?? DEFAULT_POLICY.include_retry_detail_entries,
    allowed_visibility: freezeArray(policy?.allowed_visibility ?? DEFAULT_POLICY.allowed_visibility),
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
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

const REQUIRED_REPLAY_EVENT_TYPES: readonly TimelineEventType[] = freezeArray(["StateEntered", "StateExited", "GuardEvaluated"]);

const DEFAULT_POLICY: StateTimelineLedgerPolicy = Object.freeze({
  require_hash_chain_continuity: true,
  reject_forbidden_summary_text: true,
  max_summary_chars: MAX_TIMELINE_SUMMARY_CHARS,
  default_clock_ref: DEFAULT_CLOCK_REF,
  include_guard_detail_entries: true,
  include_deadline_detail_entries: true,
  include_retry_detail_entries: true,
  allowed_visibility: freezeArray(["developer", "operator", "qa", "safety_review", "demo"] as readonly TimelineVisibility[]),
});

export const STATE_TIMELINE_LEDGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STATE_TIMELINE_LEDGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.6", "8.7", "8.15", "8.17", "8.18", "8.19"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  required_timeline_events: freezeArray([
    "StateEntered",
    "StateExited",
    "GuardEvaluated",
    "DeadlineStarted",
    "DeadlineExpired",
    "RetryBudgetConsumed",
    "SafeHoldEntered",
    "HumanReviewRequested",
    "CommandOwnershipChanged",
    "StaleResponseQuarantined",
  ] as readonly TimelineEventType[]),
});
