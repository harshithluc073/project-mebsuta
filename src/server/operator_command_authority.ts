/**
 * Operator command authority for PIT-B03.
 *
 * Commands are accepted only after API authorization and runtime readiness.
 * This layer creates command records; it does not perform domain execution.
 */

import type { RuntimeReadinessSnapshot } from "../runtime/runtime_readiness_snapshot";
import { compactPublicText, freezeArray, makeServerRef, type ApiRouteRequest } from "./api_contracts";
import type { ApiAuthorizationDecision } from "./auth_policy_hook";

export const OPERATOR_COMMAND_AUTHORITY_SCHEMA_VERSION = "mebsuta.backend_api.operator_command_authority.v1" as const;

export type OperatorCommandKind = "launch_scenario" | "pause_runtime" | "resume_runtime" | "abort_runtime" | "enter_safe_hold" | "annotate";
export type OperatorCommandDecision = "accepted" | "rejected";

export interface OperatorCommandBody {
  readonly command: OperatorCommandKind;
  readonly reason: string;
  readonly scenario_ref?: string;
  readonly idempotency_ref: string;
}

export interface OperatorCommandRecord {
  readonly schema_version: typeof OPERATOR_COMMAND_AUTHORITY_SCHEMA_VERSION;
  readonly command_ref: string;
  readonly command: OperatorCommandKind;
  readonly decision: OperatorCommandDecision;
  readonly actor_ref: string;
  readonly reason: string;
  readonly rejected_reasons: readonly string[];
  readonly audit_refs: readonly string[];
  readonly decided_at_ms: number;
}

export function evaluateOperatorCommand(
  request: ApiRouteRequest<OperatorCommandBody>,
  authorization: ApiAuthorizationDecision,
  readiness: RuntimeReadinessSnapshot,
): OperatorCommandRecord {
  const rejectedReasons: string[] = [];
  const body = request.body;
  if (body === undefined) {
    rejectedReasons.push("Command body is required.");
  } else {
    if (!isAllowedCommand(body.command)) {
      rejectedReasons.push("Command is not in the PIT-B03 command authority set.");
    }
    if (!isSafeRef(body.idempotency_ref)) {
      rejectedReasons.push("Command idempotency ref must be stable and boundary-safe.");
    }
    if (body.command === "launch_scenario" && readiness.readiness_state !== "ready") {
      rejectedReasons.push("Runtime readiness blocks scenario launch command.");
    }
    if (body.command === "resume_runtime" && readiness.stopping) {
      rejectedReasons.push("Runtime shutdown state blocks resume command.");
    }
  }
  if (authorization.decision !== "allowed") {
    rejectedReasons.push(authorization.reason);
  }
  const accepted = rejectedReasons.length === 0;
  return Object.freeze({
    schema_version: OPERATOR_COMMAND_AUTHORITY_SCHEMA_VERSION,
    command_ref: makeServerRef("operator_command", body?.command ?? "missing", body?.idempotency_ref ?? request.context.request_ref),
    command: body?.command ?? "annotate",
    decision: accepted ? "accepted" : "rejected",
    actor_ref: request.context.actor_ref,
    reason: compactPublicText(body?.reason ?? "Command rejected before body validation."),
    rejected_reasons: freezeArray(rejectedReasons),
    audit_refs: freezeArray([request.context.request_ref, request.context.correlation_ref, authorization.decision_ref]),
    decided_at_ms: request.context.received_at_ms,
  });
}

function isAllowedCommand(value: string): value is OperatorCommandKind {
  return ["launch_scenario", "pause_runtime", "resume_runtime", "abort_runtime", "enter_safe_hold", "annotate"].includes(value);
}

function isSafeRef(value: string): boolean {
  return value.trim().length > 0 && !/\s/.test(value) && !/(ground_truth|scene_graph|hidden|qa_)/i.test(value);
}

