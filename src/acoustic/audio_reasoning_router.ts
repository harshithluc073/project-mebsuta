/**
 * Acoustic route selection for attention, verification, Oops, safety, memory,
 * and prompt-safe reasoning.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.7.1, 16.10, 16.11, 16.15, 16.16, 16.17, 16.18, and 16.22.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { AudioRoute, freezeArray, makeAcousticRef, routeRank, uniqueRefs } from "./audio_sensor_bus";
import type { AudioTaskCorrelationReport, AudioTaskCorrelationSet } from "./audio_task_correlator";

export const AUDIO_REASONING_ROUTER_SCHEMA_VERSION = "mebsuta.audio_reasoning_router.v1" as const;

export interface AudioRouteDecision {
  readonly schema_version: typeof AUDIO_REASONING_ROUTER_SCHEMA_VERSION;
  readonly route_decision_ref: Ref;
  readonly correlation_report_ref: Ref;
  readonly selected_route: AudioRoute;
  readonly priority: "low" | "normal" | "high" | "blocking";
  readonly attention_request_ref?: Ref;
  readonly verification_trigger_ref?: Ref;
  readonly oops_trigger_ref?: Ref;
  readonly safety_action_ref?: Ref;
  readonly human_review_ref?: Ref;
  readonly memory_write_requested: boolean;
  readonly prompt_reasoning_requested: boolean;
  readonly required_evidence_refs: readonly Ref[];
  readonly blocked_direct_actions: readonly string[];
  readonly route_reason: string;
  readonly determinism_hash: string;
}

export interface AudioRouteDecisionSet {
  readonly schema_version: typeof AUDIO_REASONING_ROUTER_SCHEMA_VERSION;
  readonly route_decision_set_ref: Ref;
  readonly decisions: readonly AudioRouteDecision[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface AudioRoutingPolicy {
  readonly memory_write_for_routes?: readonly AudioRoute[];
  readonly prompt_reasoning_for_routes?: readonly AudioRoute[];
  readonly require_visual_before_oops?: boolean;
}

const DEFAULT_MEMORY_ROUTES: readonly AudioRoute[] = ["note", "reobserve", "verify", "oops", "safe_hold", "human_review"];
const DEFAULT_PROMPT_ROUTES: readonly AudioRoute[] = ["reobserve", "verify", "oops", "human_review"];

export class AudioReasoningRouter {
  private readonly policy: Required<AudioRoutingPolicy>;

  public constructor(policy: AudioRoutingPolicy = {}) {
    this.policy = Object.freeze({
      memory_write_for_routes: freezeArray(policy.memory_write_for_routes ?? DEFAULT_MEMORY_ROUTES),
      prompt_reasoning_for_routes: freezeArray(policy.prompt_reasoning_for_routes ?? DEFAULT_PROMPT_ROUTES),
      require_visual_before_oops: policy.require_visual_before_oops ?? true,
    });
  }

  /**
   * Selects deterministic acoustic response routes from correlation reports.
   */
  public selectAudioReasoningRoutes(correlationSet: AudioTaskCorrelationSet): AudioRouteDecisionSet {
    const decisions = correlationSet.reports.map((report) => routeOne(report, this.policy));
    const base = {
      schema_version: AUDIO_REASONING_ROUTER_SCHEMA_VERSION,
      route_decision_set_ref: makeAcousticRef("audio_route_decision_set", correlationSet.correlation_set_ref, decisions.length),
      decisions: freezeArray(decisions.sort((a, b) => routeRank(b.selected_route) - routeRank(a.selected_route) || a.route_decision_ref.localeCompare(b.route_decision_ref))),
      issues: correlationSet.issues,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function selectAudioReasoningRoutes(correlationSet: AudioTaskCorrelationSet, policy: AudioRoutingPolicy = {}): AudioRouteDecisionSet {
  return new AudioReasoningRouter(policy).selectAudioReasoningRoutes(correlationSet);
}

function routeOne(report: AudioTaskCorrelationReport, policy: Required<AudioRoutingPolicy>): AudioRouteDecision {
  const selected = policy.require_visual_before_oops && report.recommended_route === "oops" && !report.affected_constraint_refs.includes("constraint:visual_final_state")
    ? "verify"
    : report.recommended_route;
  const priority: AudioRouteDecision["priority"] = selected === "safe_hold" || selected === "human_review"
    ? "blocking"
    : selected === "oops" || report.safety_relevance_score >= 0.68
      ? "high"
      : selected === "verify" || selected === "reobserve"
        ? "normal"
        : "low";
  const base = {
    schema_version: AUDIO_REASONING_ROUTER_SCHEMA_VERSION,
    route_decision_ref: makeAcousticRef("audio_route", report.correlation_report_ref, selected),
    correlation_report_ref: report.correlation_report_ref,
    selected_route: selected,
    priority,
    attention_request_ref: selected === "reobserve" || selected === "verify" || selected === "oops" ? makeAcousticRef("audio_attention", report.audio_event_ref) : undefined,
    verification_trigger_ref: selected === "verify" || selected === "oops" || selected === "safe_hold" ? makeAcousticRef("audio_verification", report.audio_event_ref) : undefined,
    oops_trigger_ref: selected === "oops" ? makeAcousticRef("audio_oops", report.audio_event_ref) : undefined,
    safety_action_ref: selected === "safe_hold" ? makeAcousticRef("audio_safety", report.audio_event_ref) : undefined,
    human_review_ref: selected === "human_review" ? makeAcousticRef("audio_human_review", report.audio_event_ref) : undefined,
    memory_write_requested: policy.memory_write_for_routes.includes(selected),
    prompt_reasoning_requested: policy.prompt_reasoning_for_routes.includes(selected),
    required_evidence_refs: uniqueRefs(report.supporting_evidence_refs),
    blocked_direct_actions: freezeArray(["audio_only_success_certification", "audio_only_physical_correction", "hidden_source_identity_claim"]),
    route_reason: routeReason(report, selected),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function routeReason(report: AudioTaskCorrelationReport, route: AudioRoute): string {
  if (route === "safe_hold") return "Sound and correlated task evidence require a safe pause before further motion.";
  if (route === "human_review") return "Sound may be task-critical, but available evidence cannot support autonomous interpretation.";
  if (route === "oops") return "Sound is linked to a likely failure path and should enter correction intake after evidence review.";
  if (route === "verify") return "Sound is a cue requiring verification before any success claim.";
  if (route === "reobserve") return "Sound direction should guide camera attention while preserving uncertainty.";
  if (route === "note") return "Sound is relevant context but does not require route escalation.";
  return "Sound is ignored because it is expected or self-generated.";
}
