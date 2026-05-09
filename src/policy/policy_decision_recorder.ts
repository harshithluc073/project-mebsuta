/**
 * Append-only policy/audit decision records for PIT-B05.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 10, 16, 19, 20, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeAuthArray,
  makeAuthRef,
  uniqueAuthRefs,
  validateAuthRef,
  validateFiniteAuthNumber,
  validateSafeAuthText,
} from "../auth/actor_context";
import type { AuthorizationDecisionRecord, RuntimeQaBoundaryLabel } from "../auth/authorization_policy_engine";

export const POLICY_DECISION_RECORDER_SCHEMA_VERSION = "mebsuta.policy.policy_decision_recorder.v1" as const;

export type PolicyDecisionKind = "authorization" | "secret_redaction" | "export" | "runtime_qa_boundary" | "service_identity" | "policy_bundle";

export interface PolicyDecisionRecordInput {
  readonly decision_ref: Ref;
  readonly decision_kind: PolicyDecisionKind;
  readonly actor_ref: Ref;
  readonly subject_ref: Ref;
  readonly policy_bundle_ref: Ref;
  readonly decision: "allowed" | "denied" | "redacted" | "quarantined" | "recorded";
  readonly reason: string;
  readonly runtime_qa_boundary_label: RuntimeQaBoundaryLabel;
  readonly evidence_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly recorded_at_ms: number;
}

export interface PolicyDecisionRecord {
  readonly schema_version: typeof POLICY_DECISION_RECORDER_SCHEMA_VERSION;
  readonly decision_ref: Ref;
  readonly sequence: number;
  readonly decision_kind: PolicyDecisionKind;
  readonly actor_ref: Ref;
  readonly subject_ref: Ref;
  readonly policy_bundle_ref: Ref;
  readonly decision: "allowed" | "denied" | "redacted" | "quarantined" | "recorded";
  readonly reason: string;
  readonly runtime_qa_boundary_label: RuntimeQaBoundaryLabel;
  readonly evidence_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly recorded_at_ms: number;
  readonly signature_hash: string;
  readonly determinism_hash: string;
}

export class PolicyDecisionRecorder {
  private readonly records = new Map<Ref, PolicyDecisionRecord>();
  private sequence = 0;

  public recordDecision(input: PolicyDecisionRecordInput): PolicyDecisionRecord {
    if (this.records.has(input.decision_ref)) {
      throw new PolicyDecisionRecorderError("Policy decision ref already exists.", freezeAuthArray([]));
    }
    const record = normalizePolicyDecisionRecord(input, this.sequence + 1);
    const issues = validatePolicyDecisionRecord(record);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new PolicyDecisionRecorderError("Policy decision record failed validation.", issues);
    }
    this.sequence = record.sequence;
    this.records.set(record.decision_ref, record);
    return record;
  }

  public recordAuthorization(decision: AuthorizationDecisionRecord, recordedAtMs: number): PolicyDecisionRecord {
    return this.recordDecision({
      decision_ref: makeAuthRef("policy_decision", decision.decision_ref),
      decision_kind: "authorization",
      actor_ref: decision.actor_ref,
      subject_ref: decision.subject_ref,
      policy_bundle_ref: decision.policy_bundle_ref,
      decision: decision.decision,
      reason: decision.reason,
      runtime_qa_boundary_label: decision.runtime_qa_boundary_label,
      evidence_refs: [decision.request_ref],
      audit_refs: [decision.decision_ref, ...decision.audit_refs],
      recorded_at_ms: recordedAtMs,
    });
  }

  public listRecords(): readonly PolicyDecisionRecord[] {
    return freezeAuthArray([...this.records.values()].sort((left, right) => left.sequence - right.sequence));
  }
}

export class PolicyDecisionRecorderError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PolicyDecisionRecorderError";
    this.issues = freezeAuthArray(issues);
  }
}

export function normalizePolicyDecisionRecord(input: PolicyDecisionRecordInput, sequence: number): PolicyDecisionRecord {
  const unsigned = {
    schema_version: POLICY_DECISION_RECORDER_SCHEMA_VERSION,
    decision_ref: input.decision_ref,
    sequence,
    decision_kind: input.decision_kind,
    actor_ref: input.actor_ref,
    subject_ref: input.subject_ref,
    policy_bundle_ref: input.policy_bundle_ref,
    decision: input.decision,
    reason: input.reason,
    runtime_qa_boundary_label: input.runtime_qa_boundary_label,
    evidence_refs: uniqueAuthRefs(input.evidence_refs),
    audit_refs: uniqueAuthRefs(input.audit_refs),
    recorded_at_ms: input.recorded_at_ms,
  };
  const signed = { ...unsigned, signature_hash: computeDeterminismHash(unsigned) };
  return Object.freeze({ ...signed, determinism_hash: computeDeterminismHash(signed) });
}

export function validatePolicyDecisionRecord(record: PolicyDecisionRecord): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(record.decision_ref, "$.decision_ref", issues);
  validateAuthRef(record.actor_ref, "$.actor_ref", issues);
  validateAuthRef(record.subject_ref, "$.subject_ref", issues);
  validateAuthRef(record.policy_bundle_ref, "$.policy_bundle_ref", issues);
  validateSafeAuthText(record.reason, "$.reason", true, issues);
  validateFiniteAuthNumber(record.recorded_at_ms, "$.recorded_at_ms", 0, undefined, issues);
  validateFiniteAuthNumber(record.sequence, "$.sequence", 1, undefined, issues);
  return freezeAuthArray(issues);
}

export const POLICY_DECISION_RECORDER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: POLICY_DECISION_RECORDER_SCHEMA_VERSION,
  blueprint: "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md",
  sections: freezeAuthArray(["10", "16", "19", "20", "23"]),
  component: "PolicyDecisionRecorder",
});
