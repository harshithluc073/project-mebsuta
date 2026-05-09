/**
 * Visual information firewall adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.1, 9.3, 9.5, 9.17, 9.19, and 9.20.
 *
 * The adapter is the final File 09 simulation-blindness boundary. It accepts
 * perception artifacts, recursively removes forbidden render/debug/QA/backend
 * fields, redacts hidden-source wording, and emits a deterministic audit report
 * before visual evidence reaches cognition, memory, verification, or external
 * downstream audits.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CalibrationPromptContext } from "./calibration_context_assembler";
import type { CameraIngestReport } from "./camera_packet_ingestor";
import type { MultiViewConsensusReport } from "./cross_view_consensus_engine";
import type { MultiViewObservationBundle } from "./multi_view_synchronizer";
import type { ViewQualityReportSet } from "./view_quality_assessor";
import type { FailureVisualEvidenceBundle } from "./visual_evidence_recorder";
import type { VisualMemoryEvidenceSet } from "./visual_memory_evidence_builder";
import type { VisualPromptPacketSection } from "./visual_prompt_packager";
import type { VerificationObservationBundle } from "./verification_view_assembler";

export const VISUAL_INFORMATION_FIREWALL_ADAPTER_SCHEMA_VERSION = "mebsuta.visual_information_firewall_adapter.v1" as const;

const FORBIDDEN_KEY_PATTERN = /(^|_)(backend|engine|scene_graph|world_truth|ground_truth|truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|exact_pose|world_pose|segmentation|debug|qa_success|qa_label|qa_only|mesh_name|asset_id|render_buffer|depth_truth|label_map)(_|$)/i;
const FORBIDDEN_TEXT_PATTERN = /(backend|engine|scene graph|world truth|ground truth|collision mesh|rigid body handle|physics body|joint handle|object id|exact com|exact pose|world pose|segmentation truth|debug buffer|debug overlay|qa success|qa label|qa-only|simulator truth|mesh name|asset id|render buffer|depth truth|label map)/i;
const SAFE_COGNITIVE_VISIBILITY_PREFIX = "perception_";

export type VisualFirewallSurfaceKind =
  | "camera_ingest_report"
  | "multi_view_observation_bundle"
  | "view_quality_report_set"
  | "calibration_prompt_context"
  | "visual_prompt_packet_section"
  | "multi_view_consensus_report"
  | "verification_observation_bundle"
  | "failure_visual_evidence_bundle"
  | "visual_memory_evidence_set"
  | "ad_hoc_visual_payload";

export type VisualFirewallDestination = "cognition" | "memory" | "verification" | "orchestration" | "audit" | "external_observer";
export type VisualFirewallDecision = "approved" | "approved_with_redactions" | "quarantined" | "rejected";
export type VisualFirewallRecommendedAction = "forward_approved_payload" | "forward_redacted_payload" | "recapture_clean_view" | "repair_upstream_payload" | "safe_hold" | "human_review";
export type VisualFirewallFindingAction = "allowed" | "field_stripped" | "text_redacted" | "payload_quarantined";
export type HiddenVisualSourceClass =
  | "backend_identifier"
  | "render_debug_artifact"
  | "qa_truth"
  | "physics_truth"
  | "segmentation_truth"
  | "asset_identity"
  | "world_pose_truth"
  | "unknown_hidden_source";
export type VisualInformationFirewallIssueCode =
  | "HiddenVisualFieldStripped"
  | "HiddenVisualTextRedacted"
  | "PayloadQuarantined"
  | "PayloadRejected"
  | "UnsafeCognitiveVisibility"
  | "SanitizationDepthExceeded"
  | "PolicyInvalid"
  | "NoFirewallSurfaces";

/**
 * Runtime policy for the visual blindness boundary.
 */
export interface VisualInformationFirewallPolicy {
  readonly hidden_source_action?: "reject" | "redact_with_issue" | "quarantine";
  readonly enforce_cognitive_visibility_prefix?: boolean;
  readonly allow_audit_issue_text?: boolean;
  readonly max_sanitization_depth?: number;
  readonly text_redaction_token?: string;
}

/**
 * Generic firewall surface. This keeps the adapter usable for current File 09
 * artifacts and future visual payloads without weakening the sanitizer.
 */
export interface VisualFirewallSurface<TPayload = unknown> {
  readonly surface_ref: Ref;
  readonly surface_kind: VisualFirewallSurfaceKind;
  readonly intended_destination: VisualFirewallDestination;
  readonly payload: TPayload;
  readonly declared_cognitive_visibility?: string;
}

/**
 * Convenience input for all implemented File 09 perception artifacts.
 */
export interface VisualInformationFirewallInput {
  readonly surfaces?: readonly VisualFirewallSurface[];
  readonly camera_ingest_report?: CameraIngestReport;
  readonly observation_bundle?: MultiViewObservationBundle;
  readonly quality_report_set?: ViewQualityReportSet;
  readonly calibration_context?: CalibrationPromptContext;
  readonly prompt_packet_section?: VisualPromptPacketSection;
  readonly consensus_report?: MultiViewConsensusReport;
  readonly verification_bundle?: VerificationObservationBundle;
  readonly failure_visual_bundles?: readonly FailureVisualEvidenceBundle[];
  readonly visual_memory_evidence_set?: VisualMemoryEvidenceSet;
}

/**
 * Per-field firewall finding with the sanitized destination path preserved for
 * reproducible audits.
 */
export interface VisualFirewallFinding {
  readonly finding_ref: Ref;
  readonly surface_ref: Ref;
  readonly surface_kind: VisualFirewallSurfaceKind;
  readonly destination: VisualFirewallDestination;
  readonly path: string;
  readonly hidden_source_class: HiddenVisualSourceClass;
  readonly action: VisualFirewallFindingAction;
  readonly severity: "warning" | "blocking";
  readonly summary: string;
}

/**
 * Sanitized payload emitted after forbidden fields and hidden wording are
 * removed from the cognitive-visible surface.
 */
export interface FirewallApprovedVisualPayload {
  readonly approved_payload_ref: Ref;
  readonly source_surface_ref: Ref;
  readonly surface_kind: VisualFirewallSurfaceKind;
  readonly destination: VisualFirewallDestination;
  readonly payload: unknown;
  readonly stripped_field_paths: readonly string[];
  readonly redacted_text_paths: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Quarantine envelope retained for audit and repair, never for cognitive use.
 */
export interface FirewallQuarantinedVisualPayload {
  readonly quarantine_ref: Ref;
  readonly source_surface_ref: Ref;
  readonly surface_kind: VisualFirewallSurfaceKind;
  readonly destination: VisualFirewallDestination;
  readonly reason: string;
  readonly blocked_paths: readonly string[];
  readonly recommended_repair: string;
  readonly determinism_hash: string;
}

/**
 * Executable File 09 visual firewall report.
 */
export interface VisualInformationFirewallReport {
  readonly schema_version: typeof VISUAL_INFORMATION_FIREWALL_ADAPTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly firewall_report_ref: Ref;
  readonly surface_count: number;
  readonly approved_payloads: readonly FirewallApprovedVisualPayload[];
  readonly quarantined_payloads: readonly FirewallQuarantinedVisualPayload[];
  readonly findings: readonly VisualFirewallFinding[];
  readonly blocked_field_paths: readonly string[];
  readonly redacted_text_paths: readonly string[];
  readonly destination_summary: Readonly<Record<VisualFirewallDestination, number>>;
  readonly decision: VisualFirewallDecision;
  readonly recommended_action: VisualFirewallRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_visual_information_firewall_report";
}

interface NormalizedVisualInformationFirewallPolicy {
  readonly hidden_source_action: "reject" | "redact_with_issue" | "quarantine";
  readonly enforce_cognitive_visibility_prefix: boolean;
  readonly allow_audit_issue_text: boolean;
  readonly max_sanitization_depth: number;
  readonly text_redaction_token: string;
}

interface SanitizedSurface {
  readonly surface: VisualFirewallSurface;
  readonly payload: unknown;
  readonly findings: readonly VisualFirewallFinding[];
  readonly stripped_field_paths: readonly string[];
  readonly redacted_text_paths: readonly string[];
  readonly depth_exceeded_paths: readonly string[];
  readonly quarantined: boolean;
}

interface SanitizationState {
  readonly surface: VisualFirewallSurface;
  readonly policy: NormalizedVisualInformationFirewallPolicy;
  readonly findings: VisualFirewallFinding[];
  readonly stripped_field_paths: string[];
  readonly redacted_text_paths: string[];
  readonly depth_exceeded_paths: string[];
}

const DEFAULT_POLICY: NormalizedVisualInformationFirewallPolicy = Object.freeze({
  hidden_source_action: "redact_with_issue",
  enforce_cognitive_visibility_prefix: true,
  allow_audit_issue_text: true,
  max_sanitization_depth: 18,
  text_redaction_token: "[redacted hidden visual source]",
});

/**
 * Executable File 09 `VisualInformationFirewallAdapter`.
 */
export class VisualInformationFirewallAdapter {
  private readonly policy: NormalizedVisualInformationFirewallPolicy;

  public constructor(policy: VisualInformationFirewallPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Scrubs perception artifacts before they cross into cognition, memory,
   * verification, orchestration, or external audit channels.
   */
  public scrubVisualInformation(
    input: VisualInformationFirewallInput | readonly VisualFirewallSurface[],
    policy: VisualInformationFirewallPolicy = {},
  ): VisualInformationFirewallReport {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(activePolicy, issues);

    const surfaces = isSurfaceArray(input) ? freezeArray(input) : collectSurfaces(input);
    if (surfaces.length === 0) {
      issues.push(makeIssue("error", "NoFirewallSurfaces", "$.surfaces", "VisualInformationFirewallAdapter received no visual surfaces to scrub.", "Provide at least one perception artifact before forwarding visual evidence."));
    }

    const sanitized = surfaces.map((surface) => sanitizeSurface(surface, activePolicy, issues));
    const approvedPayloads = sanitized
      .filter((item) => !item.quarantined)
      .map((item) => toApprovedPayload(item));
    const quarantinedPayloads = sanitized
      .filter((item) => item.quarantined)
      .map((item) => toQuarantinePayload(item));
    const findings = sanitized.flatMap((item) => item.findings).sort(compareFindings);
    const blockedPaths = uniqueSorted(sanitized.flatMap((item) => item.stripped_field_paths));
    const redactedPaths = uniqueSorted(sanitized.flatMap((item) => item.redacted_text_paths));
    const decision = decideFirewallReport(approvedPayloads, quarantinedPayloads, findings, issues, activePolicy);
    appendDecisionIssue(decision, findings, issues);
    const recommendedAction = chooseRecommendedAction(decision, findings, issues, activePolicy);
    const reportRef = makeRef("visual_information_firewall_report", surfaces.map((surface) => surface.surface_ref).join(":"), decision);
    const shell = {
      reportRef,
      surfaces: surfaces.map((surface) => [surface.surface_ref, surface.surface_kind, surface.intended_destination]),
      approved: approvedPayloads.map((payload) => payload.approved_payload_ref),
      quarantined: quarantinedPayloads.map((payload) => payload.quarantine_ref),
      blockedPaths,
      redactedPaths,
      decision,
    };

    return Object.freeze({
      schema_version: VISUAL_INFORMATION_FIREWALL_ADAPTER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      firewall_report_ref: reportRef,
      surface_count: surfaces.length,
      approved_payloads: freezeArray(approvedPayloads),
      quarantined_payloads: freezeArray(quarantinedPayloads),
      findings: freezeArray(findings),
      blocked_field_paths: freezeArray(blockedPaths),
      redacted_text_paths: freezeArray(redactedPaths),
      destination_summary: destinationSummary(approvedPayloads),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "approved" || decision === "approved_with_redactions",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_visual_information_firewall_report",
    });
  }
}

/**
 * Functional API matching the File 09 simulation-blindness boundary.
 */
export function scrubVisualInformation(
  input: VisualInformationFirewallInput | readonly VisualFirewallSurface[],
  policy: VisualInformationFirewallPolicy = {},
): VisualInformationFirewallReport {
  return new VisualInformationFirewallAdapter(policy).scrubVisualInformation(input, policy);
}

function isSurfaceArray(input: VisualInformationFirewallInput | readonly VisualFirewallSurface[]): input is readonly VisualFirewallSurface[] {
  return Array.isArray(input);
}

function collectSurfaces(input: VisualInformationFirewallInput): readonly VisualFirewallSurface[] {
  const surfaces: VisualFirewallSurface[] = [];
  if (input.surfaces !== undefined) surfaces.push(...input.surfaces);
  if (input.camera_ingest_report !== undefined) surfaces.push(makeSurface("camera_ingest_report", input.camera_ingest_report.manifest_id, "audit", input.camera_ingest_report, input.camera_ingest_report.cognitive_visibility));
  if (input.observation_bundle !== undefined) surfaces.push(makeSurface("multi_view_observation_bundle", input.observation_bundle.bundle_ref, "cognition", input.observation_bundle, input.observation_bundle.cognitive_visibility));
  if (input.quality_report_set !== undefined) surfaces.push(makeSurface("view_quality_report_set", input.quality_report_set.bundle_ref, "cognition", input.quality_report_set, input.quality_report_set.cognitive_visibility));
  if (input.calibration_context !== undefined) surfaces.push(makeSurface("calibration_prompt_context", input.calibration_context.calibration_context_ref, "cognition", input.calibration_context, input.calibration_context.cognitive_visibility));
  if (input.prompt_packet_section !== undefined) surfaces.push(makeSurface("visual_prompt_packet_section", input.prompt_packet_section.packet_ref, "cognition", input.prompt_packet_section, input.prompt_packet_section.cognitive_visibility));
  if (input.consensus_report !== undefined) surfaces.push(makeSurface("multi_view_consensus_report", input.consensus_report.consensus_ref, "orchestration", input.consensus_report, input.consensus_report.cognitive_visibility));
  if (input.verification_bundle !== undefined) surfaces.push(makeSurface("verification_observation_bundle", input.verification_bundle.verification_bundle_ref, "verification", input.verification_bundle, input.verification_bundle.cognitive_visibility));
  for (const bundle of input.failure_visual_bundles ?? []) {
    surfaces.push(makeSurface("failure_visual_evidence_bundle", bundle.failure_visual_bundle_ref, "orchestration", bundle, bundle.cognitive_visibility));
  }
  if (input.visual_memory_evidence_set !== undefined) surfaces.push(makeSurface("visual_memory_evidence_set", input.visual_memory_evidence_set.visual_memory_set_ref, "memory", input.visual_memory_evidence_set, input.visual_memory_evidence_set.cognitive_visibility));
  return freezeArray(surfaces);
}

function makeSurface<TPayload>(
  surfaceKind: VisualFirewallSurfaceKind,
  sourceRef: Ref,
  destination: VisualFirewallDestination,
  payload: TPayload,
  cognitiveVisibility?: string,
): VisualFirewallSurface<TPayload> {
  return Object.freeze({
    surface_ref: makeRef("visual_firewall_surface", surfaceKind, sourceRef),
    surface_kind: surfaceKind,
    intended_destination: destination,
    payload,
    declared_cognitive_visibility: cognitiveVisibility,
  });
}

function sanitizeSurface(
  surface: VisualFirewallSurface,
  policy: NormalizedVisualInformationFirewallPolicy,
  issues: ValidationIssue[],
): SanitizedSurface {
  const state: SanitizationState = {
    surface,
    policy,
    findings: [],
    stripped_field_paths: [],
    redacted_text_paths: [],
    depth_exceeded_paths: [],
  };

  if (policy.enforce_cognitive_visibility_prefix && !hasSafeCognitiveVisibility(surface)) {
    state.findings.push(makeFinding(surface, "$.declared_cognitive_visibility", "unknown_hidden_source", "payload_quarantined", "blocking", "Payload lacks a perception-scoped cognitive visibility marker."));
    issues.push(makeIssue("error", "UnsafeCognitiveVisibility", `$.surfaces.${surface.surface_ref}.declared_cognitive_visibility`, "Visual payload does not declare a perception-scoped cognitive visibility boundary.", "Attach a perception_* cognitive_visibility marker before forwarding."));
  }

  const payload = sanitizeUnknown(surface.payload, "$.payload", 0, state);
  const blockingFindings = state.findings.some((finding) => finding.severity === "blocking");
  const quarantined = policy.hidden_source_action === "quarantine"
    ? state.findings.length > 0
    : policy.hidden_source_action === "reject" && blockingFindings;

  return Object.freeze({
    surface,
    payload,
    findings: freezeArray(state.findings),
    stripped_field_paths: freezeArray(uniqueSorted(state.stripped_field_paths)),
    redacted_text_paths: freezeArray(uniqueSorted(state.redacted_text_paths)),
    depth_exceeded_paths: freezeArray(uniqueSorted(state.depth_exceeded_paths)),
    quarantined,
  });
}

function sanitizeUnknown(value: unknown, path: string, depth: number, state: SanitizationState): unknown {
  if (depth > state.policy.max_sanitization_depth) {
    state.depth_exceeded_paths.push(path);
    state.findings.push(makeFinding(state.surface, path, "unknown_hidden_source", "payload_quarantined", "blocking", "Sanitization depth limit was exceeded before the payload could be proven safe."));
    return undefined;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value, path, state);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") {
    state.stripped_field_paths.push(path);
    state.findings.push(makeFinding(state.surface, path, "unknown_hidden_source", "field_stripped", "warning", `Non-data value at ${path} was stripped before forwarding.`));
    return undefined;
  }
  if (Array.isArray(value)) {
    return freezeArray(value
      .map((item, index) => sanitizeUnknown(item, `${path}[${index}]`, depth + 1, state))
      .filter((item) => item !== undefined));
  }
  return sanitizeRecord(value as Readonly<Record<string, unknown>>, path, depth, state);
}

function sanitizeRecord(
  record: Readonly<Record<string, unknown>>,
  path: string,
  depth: number,
  state: SanitizationState,
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const childPath = `${path}.${key}`;
    const classification = classifyHiddenKey(key);
    if (classification !== undefined) {
      state.stripped_field_paths.push(childPath);
      state.findings.push(makeFinding(state.surface, childPath, classification, "field_stripped", "blocking", `Forbidden visual field ${key} was stripped before ${state.surface.intended_destination} use.`));
      continue;
    }
    const child = sanitizeUnknown(record[key], childPath, depth + 1, state);
    if (child !== undefined) sanitized[key] = child;
  }
  return Object.freeze(sanitized);
}

function sanitizeString(value: string, path: string, state: SanitizationState): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (!FORBIDDEN_TEXT_PATTERN.test(clean) || isPermittedAuditIssueText(path, state)) return clean;
  const sourceClass = classifyHiddenText(clean);
  state.redacted_text_paths.push(path);
  state.findings.push(makeFinding(state.surface, path, sourceClass, "text_redacted", "warning", `Hidden-source wording at ${path} was redacted before ${state.surface.intended_destination} use.`));
  return state.policy.text_redaction_token;
}

function isPermittedAuditIssueText(path: string, state: SanitizationState): boolean {
  return state.policy.allow_audit_issue_text
    && state.surface.intended_destination === "audit"
    && (/\.issues\[\d+\]\.(code|message|remediation)$/u.test(path) || /\.findings\[\d+\]\.(summary|hidden_source_class)$/u.test(path));
}

function classifyHiddenKey(key: string): HiddenVisualSourceClass | undefined {
  if (!FORBIDDEN_KEY_PATTERN.test(key)) return undefined;
  const normalized = key.toLowerCase();
  if (normalized.includes("qa")) return "qa_truth";
  if (normalized.includes("debug") || normalized.includes("render")) return "render_debug_artifact";
  if (normalized.includes("segmentation") || normalized.includes("label_map")) return "segmentation_truth";
  if (normalized.includes("mesh") || normalized.includes("asset")) return "asset_identity";
  if (normalized.includes("pose") || normalized.includes("exact_com")) return "world_pose_truth";
  if (normalized.includes("physics") || normalized.includes("collision") || normalized.includes("rigid") || normalized.includes("joint")) return "physics_truth";
  if (normalized.includes("backend") || normalized.includes("object_id") || normalized.includes("scene_graph") || normalized.includes("engine")) return "backend_identifier";
  return "unknown_hidden_source";
}

function classifyHiddenText(value: string): HiddenVisualSourceClass {
  const normalized = value.toLowerCase();
  if (normalized.includes("qa")) return "qa_truth";
  if (normalized.includes("debug") || normalized.includes("render")) return "render_debug_artifact";
  if (normalized.includes("segmentation") || normalized.includes("label map")) return "segmentation_truth";
  if (normalized.includes("mesh") || normalized.includes("asset")) return "asset_identity";
  if (normalized.includes("world pose") || normalized.includes("exact pose") || normalized.includes("exact com")) return "world_pose_truth";
  if (normalized.includes("physics") || normalized.includes("collision") || normalized.includes("rigid body") || normalized.includes("joint handle")) return "physics_truth";
  if (normalized.includes("backend") || normalized.includes("object id") || normalized.includes("scene graph") || normalized.includes("engine")) return "backend_identifier";
  return "unknown_hidden_source";
}

function toApprovedPayload(surface: SanitizedSurface): FirewallApprovedVisualPayload {
  const approvedRef = makeRef("firewall_approved_visual_payload", surface.surface.surface_ref, surface.surface.intended_destination);
  const shell = {
    approvedRef,
    source: surface.surface.surface_ref,
    kind: surface.surface.surface_kind,
    stripped: surface.stripped_field_paths,
    redacted: surface.redacted_text_paths,
    payload: surface.payload,
  };
  return Object.freeze({
    approved_payload_ref: approvedRef,
    source_surface_ref: surface.surface.surface_ref,
    surface_kind: surface.surface.surface_kind,
    destination: surface.surface.intended_destination,
    payload: surface.payload,
    stripped_field_paths: surface.stripped_field_paths,
    redacted_text_paths: surface.redacted_text_paths,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function toQuarantinePayload(surface: SanitizedSurface): FirewallQuarantinedVisualPayload {
  const blockedPaths = uniqueSorted([...surface.stripped_field_paths, ...surface.redacted_text_paths, ...surface.depth_exceeded_paths]);
  const quarantineRef = makeRef("firewall_quarantine", surface.surface.surface_ref, surface.surface.intended_destination);
  const shell = {
    quarantineRef,
    source: surface.surface.surface_ref,
    kind: surface.surface.surface_kind,
    blockedPaths,
  };
  return Object.freeze({
    quarantine_ref: quarantineRef,
    source_surface_ref: surface.surface.surface_ref,
    surface_kind: surface.surface.surface_kind,
    destination: surface.surface.intended_destination,
    reason: "Visual payload contained hidden-source fields or wording that policy does not allow to be forwarded.",
    blocked_paths: freezeArray(blockedPaths),
    recommended_repair: "Recapture clean declared-camera evidence or rebuild the perception artifact from firewall-approved sensor-derived fields.",
    determinism_hash: computeDeterminismHash(shell),
  });
}

function decideFirewallReport(
  approved: readonly FirewallApprovedVisualPayload[],
  quarantined: readonly FirewallQuarantinedVisualPayload[],
  findings: readonly VisualFirewallFinding[],
  issues: readonly ValidationIssue[],
  policy: NormalizedVisualInformationFirewallPolicy,
): VisualFirewallDecision {
  if (issues.some((issue) => issue.code === "PolicyInvalid" || issue.code === "NoFirewallSurfaces")) return "rejected";
  if (policy.hidden_source_action === "reject" && findings.some((finding) => finding.severity === "blocking")) return "rejected";
  if (quarantined.length > 0 && approved.length === 0) return "quarantined";
  if (quarantined.length > 0 || findings.length > 0 || issues.some((issue) => issue.severity === "warning")) return "approved_with_redactions";
  return "approved";
}

function appendDecisionIssue(
  decision: VisualFirewallDecision,
  findings: readonly VisualFirewallFinding[],
  issues: ValidationIssue[],
): void {
  if (decision === "rejected") {
    issues.push(makeIssue("error", "PayloadRejected", "$.decision", "Visual firewall rejected the payload under current policy.", "Repair upstream hidden-source contamination before forwarding."));
  } else if (decision === "quarantined") {
    issues.push(makeIssue("error", "PayloadQuarantined", "$.decision", "Visual firewall quarantined all supplied payloads.", "Recapture or rebuild clean perception artifacts before cognitive use."));
  }
  for (const finding of findings.filter((item) => item.action === "field_stripped")) {
    issues.push(makeIssue(finding.severity === "blocking" ? "error" : "warning", "HiddenVisualFieldStripped", finding.path, finding.summary, "Remove hidden-source fields upstream or keep them outside cognitive-visible payloads."));
  }
  for (const finding of findings.filter((item) => item.action === "text_redacted")) {
    issues.push(makeIssue("warning", "HiddenVisualTextRedacted", finding.path, finding.summary, "Rewrite the text from view evidence only."));
  }
  for (const finding of findings.filter((item) => item.summary.includes("depth limit"))) {
    issues.push(makeIssue("error", "SanitizationDepthExceeded", finding.path, finding.summary, "Flatten or reduce nested payload depth before firewall inspection."));
  }
}

function chooseRecommendedAction(
  decision: VisualFirewallDecision,
  findings: readonly VisualFirewallFinding[],
  issues: readonly ValidationIssue[],
  policy: NormalizedVisualInformationFirewallPolicy,
): VisualFirewallRecommendedAction {
  if (decision === "approved") return "forward_approved_payload";
  if (decision === "approved_with_redactions" && policy.hidden_source_action === "redact_with_issue") return "forward_redacted_payload";
  if (findings.some((finding) => finding.hidden_source_class === "render_debug_artifact")) return "recapture_clean_view";
  if (issues.some((issue) => issue.code === "UnsafeCognitiveVisibility" || issue.code === "SanitizationDepthExceeded")) return "repair_upstream_payload";
  if (decision === "quarantined") return "human_review";
  return "safe_hold";
}

function destinationSummary(approved: readonly FirewallApprovedVisualPayload[]): Readonly<Record<VisualFirewallDestination, number>> {
  const destinations: Record<VisualFirewallDestination, number> = {
    cognition: 0,
    memory: 0,
    verification: 0,
    orchestration: 0,
    audit: 0,
    external_observer: 0,
  };
  for (const payload of approved) {
    destinations[payload.destination] += 1;
  }
  return Object.freeze(destinations);
}

function hasSafeCognitiveVisibility(surface: VisualFirewallSurface): boolean {
  if (surface.intended_destination === "audit") return true;
  return surface.declared_cognitive_visibility !== undefined
    && surface.declared_cognitive_visibility.startsWith(SAFE_COGNITIVE_VISIBILITY_PREFIX);
}

function validatePolicy(policy: NormalizedVisualInformationFirewallPolicy, issues: ValidationIssue[]): void {
  if (policy.max_sanitization_depth < 1 || policy.max_sanitization_depth > 64 || policy.text_redaction_token.trim().length === 0) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy", "Visual firewall policy depth and redaction token must be bounded and non-empty.", "Use max_sanitization_depth in [1, 64] and a visible redaction token."));
  }
}

function mergePolicy(
  base: NormalizedVisualInformationFirewallPolicy,
  override: VisualInformationFirewallPolicy,
): NormalizedVisualInformationFirewallPolicy {
  return Object.freeze({
    hidden_source_action: override.hidden_source_action ?? base.hidden_source_action,
    enforce_cognitive_visibility_prefix: override.enforce_cognitive_visibility_prefix ?? base.enforce_cognitive_visibility_prefix,
    allow_audit_issue_text: override.allow_audit_issue_text ?? base.allow_audit_issue_text,
    max_sanitization_depth: positiveIntOrDefault(override.max_sanitization_depth, base.max_sanitization_depth),
    text_redaction_token: override.text_redaction_token?.trim() || base.text_redaction_token,
  });
}

function makeFinding(
  surface: VisualFirewallSurface,
  path: string,
  sourceClass: HiddenVisualSourceClass,
  action: VisualFirewallFindingAction,
  severity: "warning" | "blocking",
  summary: string,
): VisualFirewallFinding {
  const findingRef = makeRef("visual_firewall_finding", surface.surface_ref, path, sourceClass, action);
  return Object.freeze({
    finding_ref: findingRef,
    surface_ref: surface.surface_ref,
    surface_kind: surface.surface_kind,
    destination: surface.intended_destination,
    path,
    hidden_source_class: sourceClass,
    action,
    severity,
    summary,
  });
}

function compareFindings(a: VisualFirewallFinding, b: VisualFirewallFinding): number {
  return Number(b.severity === "blocking") - Number(a.severity === "blocking")
    || a.surface_ref.localeCompare(b.surface_ref)
    || a.path.localeCompare(b.path)
    || a.finding_ref.localeCompare(b.finding_ref);
}

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: VisualInformationFirewallIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:[\]-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
