/**
 * Operator annotation interface for Project Mebsuta observability.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.10, 17.12.4, 17.14.2, 17.18, and 17.19.
 *
 * Operator annotations are human notes linked to timeline events. This module
 * sanitizes notes, enforces visibility boundaries, and returns immutable audit
 * records that can be retained with replay bundles.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  compactText,
  containsForbiddenRuntimeText,
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  sanitizePublicText,
  uniqueRefs,
  validateRef,
  validateTimestamp,
} from "./observability_event_emitter";
import type {
  DashboardVisibility,
  ObservabilityEvent,
  OperatorAnnotationRecord,
} from "./observability_event_emitter";

export const OPERATOR_ANNOTATION_INTERFACE_SCHEMA_VERSION = "mebsuta.operator_annotation_interface.v1" as const;

export interface OperatorAnnotationRequest {
  readonly source_event_ref: Ref;
  readonly operator_ref: Ref;
  readonly annotation_time_ms: number;
  readonly requested_visibility: DashboardVisibility;
  readonly note_text: string;
  readonly linked_artifact_refs?: readonly Ref[];
}

export interface OperatorAnnotationPolicy {
  readonly allow_qa_annotations: boolean;
  readonly max_note_chars: number;
  readonly audit_on_redaction: boolean;
  readonly allowed_operator_refs?: readonly Ref[];
}

export interface OperatorAnnotationReport {
  readonly annotation_report_ref: Ref;
  readonly annotation?: OperatorAnnotationRecord;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Creates sanitized operator annotation records for observability events.
 */
export class OperatorAnnotationInterface {
  public createOperatorAnnotation(request: OperatorAnnotationRequest, sourceEvent: ObservabilityEvent, policy?: Partial<OperatorAnnotationPolicy>): OperatorAnnotationReport {
    const resolvedPolicy = mergePolicy(policy);
    const issues: ValidationIssue[] = [];
    validateRef(request.source_event_ref, "$.request.source_event_ref", issues);
    validateRef(request.operator_ref, "$.request.operator_ref", issues);
    validateTimestamp(request.annotation_time_ms, "$.request.annotation_time_ms", issues);
    if (request.source_event_ref !== sourceEvent.observability_event_ref) {
      issues.push(makeIssue("error", "OperatorAnnotationSourceMismatch", "$.request.source_event_ref", "Annotation source does not match the supplied event.", "Bind notes to the exact timeline event ref."));
    }
    if (resolvedPolicy.allowed_operator_refs !== undefined && !resolvedPolicy.allowed_operator_refs.includes(request.operator_ref)) {
      issues.push(makeIssue("error", "OperatorAnnotationOperatorDenied", "$.request.operator_ref", "Operator ref is not allowed to annotate this dashboard.", "Use an authorized operator identity."));
    }
    const visibility = request.requested_visibility === "qa" && !resolvedPolicy.allow_qa_annotations ? "developer" : request.requested_visibility;
    const note = sanitizePublicText(request.note_text, true, resolvedPolicy.max_note_chars, issues, "$.request.note_text");
    const redacted = containsForbiddenRuntimeText(request.note_text) || note !== compactText(request.note_text, resolvedPolicy.max_note_chars);
    for (const [index, ref] of (request.linked_artifact_refs ?? []).entries()) {
      validateRef(ref, `$.request.linked_artifact_refs[${index}]`, issues);
    }
    if (issues.some((issue) => issue.severity === "error")) {
      return makeReport(request, undefined, issues);
    }
    const base = {
      annotation_ref: makeObservabilityRef("operator_annotation", request.source_event_ref, request.operator_ref, request.annotation_time_ms),
      source_event_ref: request.source_event_ref,
      operator_ref: request.operator_ref,
      annotation_time_ms: request.annotation_time_ms,
      visibility,
      sanitized_note: note,
      linked_artifact_refs: uniqueRefs([...(request.linked_artifact_refs ?? []), ...sourceEvent.artifact_refs]),
      audit_required: resolvedPolicy.audit_on_redaction && redacted,
    };
    return makeReport(request, Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) }), issues);
  }
}

function makeReport(request: OperatorAnnotationRequest, annotation: OperatorAnnotationRecord | undefined, issues: readonly ValidationIssue[]): OperatorAnnotationReport {
  const base = {
    annotation_report_ref: makeObservabilityRef("operator_annotation_report", request.source_event_ref, request.operator_ref, request.annotation_time_ms),
    annotation,
    issues: freezeArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function mergePolicy(policy?: Partial<OperatorAnnotationPolicy>): OperatorAnnotationPolicy {
  return Object.freeze({
    allow_qa_annotations: policy?.allow_qa_annotations ?? false,
    max_note_chars: policy?.max_note_chars !== undefined && policy.max_note_chars > 0 ? Math.floor(policy.max_note_chars) : 1_200,
    audit_on_redaction: policy?.audit_on_redaction ?? true,
    allowed_operator_refs: policy?.allowed_operator_refs === undefined ? undefined : freezeArray(policy.allowed_operator_refs),
  });
}

export const OPERATOR_ANNOTATION_INTERFACE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OPERATOR_ANNOTATION_INTERFACE_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.10", "17.12.4", "17.14.2", "17.18", "17.19"]),
  component: "OperatorAnnotationInterface",
});
