/**
 * Decision record contract.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.2, 21.9.2, 21.10, 21.11, and 21.15.
 *
 * Decision records preserve architecture governance by tying context, options,
 * selected direction, affected docs, workstreams, risks, and review dates into
 * a deterministic auditable artifact.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OPERATIONS_BLUEPRINT_REF,
  OperationsContractError,
  buildOperationsValidationReport,
  freezeOperationsArray,
  makeOperationsRef,
  normalizeOperationsText,
  operationsIssue,
  operationsRouteForIssues,
  uniqueOperationsRefs,
  uniqueOperationsStrings,
  validateOperationsNonEmptyArray,
  validateOperationsRef,
  validateOperationsRefs,
  validateOperationsText,
} from "./milestone_registry";
import type { OperationsValidationReport } from "./milestone_registry";
import type { WorkstreamRef } from "./workstream_registry";

export const DECISION_RECORD_CONTRACT_SCHEMA_VERSION = "mebsuta.operations.decision_record_contract.v1" as const;

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected" | "needs_review";

export interface DecisionOption {
  readonly option_ref: Ref;
  readonly title: string;
  readonly tradeoff_summary: string;
}

export interface DecisionRecordInput {
  readonly decision_ref: Ref;
  readonly decision_title: string;
  readonly status: DecisionStatus;
  readonly context: string;
  readonly options_considered: readonly DecisionOption[];
  readonly selected_option_ref: Ref;
  readonly rationale: string;
  readonly affected_documents: readonly Ref[];
  readonly affected_workstreams: readonly WorkstreamRef[];
  readonly risks_created_or_reduced: readonly Ref[];
  readonly review_date_iso: string;
}

export interface DecisionRecord {
  readonly schema_version: typeof DECISION_RECORD_CONTRACT_SCHEMA_VERSION;
  readonly decision_ref: Ref;
  readonly decision_title: string;
  readonly status: DecisionStatus;
  readonly context: string;
  readonly options_considered: readonly DecisionOption[];
  readonly selected_option_ref: Ref;
  readonly rationale: string;
  readonly affected_documents: readonly Ref[];
  readonly affected_workstreams: readonly WorkstreamRef[];
  readonly risks_created_or_reduced: readonly Ref[];
  readonly review_date_iso: string;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable decision record and validates selected-option closure.
 */
export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const record = normalizeDecisionRecord(input);
  const report = validateDecisionRecord(record);
  if (!report.ok) {
    throw new OperationsContractError("Decision record failed validation.", report.issues);
  }
  return record;
}

export function normalizeDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const base = {
    schema_version: DECISION_RECORD_CONTRACT_SCHEMA_VERSION,
    decision_ref: input.decision_ref,
    decision_title: normalizeOperationsText(input.decision_title, 220),
    status: input.status,
    context: normalizeOperationsText(input.context),
    options_considered: freezeOperationsArray(input.options_considered.map(normalizeDecisionOption)),
    selected_option_ref: input.selected_option_ref,
    rationale: normalizeOperationsText(input.rationale),
    affected_documents: uniqueOperationsRefs(input.affected_documents),
    affected_workstreams: freezeOperationsArray([...new Set(input.affected_workstreams)]),
    risks_created_or_reduced: uniqueOperationsRefs(input.risks_created_or_reduced),
    review_date_iso: input.review_date_iso,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateDecisionRecord(record: DecisionRecord): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(record.decision_ref, "$.decision_ref", issues);
  validateOperationsText(record.decision_title, "$.decision_title", true, issues);
  validateOperationsText(record.context, "$.context", true, issues);
  validateOperationsText(record.rationale, "$.rationale", record.status === "accepted", issues);
  validateOperationsRef(record.selected_option_ref, "$.selected_option_ref", issues);
  validateOperationsNonEmptyArray(record.options_considered, "$.options_considered", "DecisionOptionsMissing", issues);
  validateOperationsNonEmptyArray(record.affected_documents, "$.affected_documents", "DecisionDocumentsMissing", issues);
  validateOperationsNonEmptyArray(record.affected_workstreams, "$.affected_workstreams", "DecisionWorkstreamsMissing", issues);
  validateOperationsRefs(record.affected_documents, "$.affected_documents", issues);
  validateOperationsRefs(record.risks_created_or_reduced, "$.risks_created_or_reduced", issues);
  record.options_considered.forEach((option, index) => validateDecisionOption(option, `$.options_considered[${index}]`, issues));
  const optionRefs = new Set(record.options_considered.map((option) => option.option_ref));
  if (!optionRefs.has(record.selected_option_ref)) {
    issues.push(operationsIssue("error", "DecisionSelectedOptionMissing", "$.selected_option_ref", "Selected option must be present in options_considered.", "Add the selected option to the decision record."));
  }
  if (!Number.isFinite(new Date(record.review_date_iso).getTime())) {
    issues.push(operationsIssue("error", "DecisionReviewDateInvalid", "$.review_date_iso", "Review date must be a valid ISO timestamp.", "Use an ISO-8601 date string."));
  }
  if (record.status === "accepted" && record.risks_created_or_reduced.length === 0) {
    issues.push(operationsIssue("warning", "DecisionRiskLinksMissing", "$.risks_created_or_reduced", "Accepted decisions should link risk effects.", "Attach risk refs or record an explicit no-risk decision."));
  }
  return buildOperationsValidationReport(makeOperationsRef("decision_record_report", record.decision_ref), issues, operationsRouteForIssues(issues));
}

export function decisionTouchesDocument(record: DecisionRecord, documentRef: Ref): boolean {
  return record.affected_documents.includes(documentRef);
}

export function summarizeDecisionImpact(record: DecisionRecord): readonly string[] {
  return uniqueOperationsStrings([
    `documents=${record.affected_documents.length}`,
    `workstreams=${record.affected_workstreams.length}`,
    `risk_refs=${record.risks_created_or_reduced.length}`,
    `status=${record.status}`,
  ]);
}

function normalizeDecisionOption(option: DecisionOption): DecisionOption {
  return Object.freeze({
    option_ref: option.option_ref,
    title: normalizeOperationsText(option.title, 180),
    tradeoff_summary: normalizeOperationsText(option.tradeoff_summary, 700),
  });
}

function validateDecisionOption(option: DecisionOption, path: string, issues: ValidationIssue[]): void {
  validateOperationsRef(option.option_ref, `${path}.option_ref`, issues);
  validateOperationsText(option.title, `${path}.title`, true, issues);
  validateOperationsText(option.tradeoff_summary, `${path}.tradeoff_summary`, true, issues);
}

export const DECISION_RECORD_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: DECISION_RECORD_CONTRACT_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.2", "21.9.2", "21.10", "21.11", "21.15"]),
  component: "DecisionRecordContract",
});
