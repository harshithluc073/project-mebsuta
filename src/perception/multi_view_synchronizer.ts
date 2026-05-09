/**
 * Multi-view synchronizer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.4, 9.5.1, 9.6.1, 9.7, 9.17, 9.18, 9.19, and 9.20.
 *
 * The synchronizer turns accepted camera records into a File 09
 * `MultiViewObservationBundle`. It groups views for one task phase, computes
 * capture intervals and temporal skew, records missing and degraded views
 * explicitly, and marks desynchronized bundles before they can reach prompt
 * packaging or visual verification.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { HardwareTimestampInterval } from "../virtual_hardware/virtual_hardware_adapter";
import type { AcceptedCameraPacketRecord } from "./camera_packet_ingestor";
import type { CanonicalViewName, ViewNameRegistryReport } from "./view_name_registry";

export const MULTI_VIEW_SYNCHRONIZER_SCHEMA_VERSION = "mebsuta.multi_view_synchronizer.v1" as const;

export type PerceptionTaskPhase = "observe" | "reobserve" | "planning" | "grasp" | "place" | "verify" | "correct" | "tool_assess";
export type MultiViewSyncQuality = "tight" | "acceptable" | "loose" | "desynchronized";
export type ViewInventoryStatus = "included" | "missing" | "stale" | "degraded" | "duplicate_omitted";
export type SynchronizerRecommendedAction = "continue" | "reobserve" | "recapture_tight_sync" | "safe_hold" | "human_review";
export type MultiViewSynchronizerIssueCode =
  | "PacketSetEmpty"
  | "PacketViewUnregistered"
  | "DuplicateCanonicalView"
  | "RequiredViewMissing"
  | "PrimaryViewMissing"
  | "TimestampInvalid"
  | "TemporalSkewLoose"
  | "TemporalSkewDesynchronized"
  | "DegradedViewIncluded"
  | "StaleViewIncluded";

/**
 * Synchronization policy for one File 09 multi-view capture event.
 */
export interface MultiViewSyncPolicy {
  readonly required_views?: readonly CanonicalViewName[];
  readonly tight_skew_ms?: number;
  readonly acceptable_skew_ms?: number;
  readonly loose_skew_ms?: number;
  readonly allow_degraded_views?: boolean;
  readonly allow_stale_views?: boolean;
  readonly reference_time_s?: number;
  readonly bundle_ref_prefix?: string;
}

/**
 * Included packet mapped to a canonical view name.
 */
export interface SynchronizedViewPacket {
  readonly canonical_view_name: CanonicalViewName;
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly camera_role: AcceptedCameraPacketRecord["camera_role"];
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly midpoint_s: number;
  readonly offset_from_bundle_center_ms: number;
  readonly age_ms: number;
  readonly health_status: AcceptedCameraPacketRecord["health_status"];
  readonly packet_status: AcceptedCameraPacketRecord["packet_status"];
  readonly confidence: number;
  readonly calibration_ref: Ref;
  readonly determinism_hash: string;
}

/**
 * View inventory row required by File 09 so missing, stale, degraded, and
 * duplicate views remain visible to Gemini-facing prompt assembly.
 */
export interface MultiViewInventoryRecord {
  readonly canonical_view_name: CanonicalViewName;
  readonly status: ViewInventoryStatus;
  readonly packet_ref?: Ref;
  readonly sensor_ref?: Ref;
  readonly reason: string;
  readonly recommended_action: SynchronizerRecommendedAction;
}

/**
 * Deterministic multi-view observation bundle consumed by later perception
 * stages.
 */
export interface MultiViewObservationBundle {
  readonly schema_version: typeof MULTI_VIEW_SYNCHRONIZER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly bundle_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly capture_interval: HardwareTimestampInterval;
  readonly view_packets: Readonly<Partial<Record<CanonicalViewName, SynchronizedViewPacket>>>;
  readonly missing_views: readonly MultiViewInventoryRecord[];
  readonly view_inventory: readonly MultiViewInventoryRecord[];
  readonly sync_quality: MultiViewSyncQuality;
  readonly max_temporal_skew_ms: number;
  readonly bundle_center_time_s: number;
  readonly calibration_context_ref: Ref;
  readonly view_quality_report_ref: Ref;
  readonly provenance_summary: string;
  readonly included_packet_refs: readonly Ref[];
  readonly omitted_packet_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly recommended_action: SynchronizerRecommendedAction;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_multi_view_observation_bundle";
}

const DEFAULT_POLICY: Required<MultiViewSyncPolicy> = Object.freeze({
  required_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  tight_skew_ms: 16.667,
  acceptable_skew_ms: 33.334,
  loose_skew_ms: 100,
  allow_degraded_views: true,
  allow_stale_views: false,
  reference_time_s: Number.NaN,
  bundle_ref_prefix: "mv_bundle",
});

/**
 * Executable File 09 `MultiViewSynchronizer`.
 */
export class MultiViewSynchronizer {
  private readonly policy: Required<MultiViewSyncPolicy>;

  public constructor(policy: MultiViewSyncPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds one multi-view observation bundle from accepted camera packets and a
   * canonical view registry.
   */
  public buildMultiViewObservationBundle(
    cameraPacketSet: readonly AcceptedCameraPacketRecord[],
    taskPhase: PerceptionTaskPhase,
    syncPolicy: MultiViewSyncPolicy,
    viewRegistry: ViewNameRegistryReport,
  ): MultiViewObservationBundle {
    const activePolicy = mergePolicy(this.policy, syncPolicy);
    const issues: ValidationIssue[] = [];
    if (cameraPacketSet.length === 0) {
      issues.push(makeIssue("error", "PacketSetEmpty", "$.camera_packet_set", "Multi-view synchronization requires at least one accepted camera packet.", "Run camera ingestion and provide current accepted camera packets."));
    }

    const referenceTimeS = resolveReferenceTime(cameraPacketSet, activePolicy.reference_time_s);
    const resolvedViews = resolvePackets(cameraPacketSet, viewRegistry, referenceTimeS, activePolicy, issues);
    const selectedViews = selectNewestPacketPerView(resolvedViews, issues);
    const interval = captureIntervalFor(selectedViews);
    const centerTimeS = centerTimeFor(selectedViews, interval);
    const maxTemporalSkewMs = temporalSkewMs(selectedViews);
    const syncQuality = classifySyncQuality(maxTemporalSkewMs, activePolicy);
    appendSyncQualityIssues(syncQuality, maxTemporalSkewMs, issues);

    const viewPackets = buildViewPacketMap(selectedViews, centerTimeS);
    const inventory = buildViewInventory(selectedViews, resolvedViews, activePolicy.required_views, issues);
    const missingViews = inventory.filter((record) => record.status === "missing");
    const recommendedAction = chooseRecommendedAction(syncQuality, missingViews, issues);
    const includedPacketRefs = selectedViews.map((record) => record.packet.packet_ref).sort();
    const selectedPacketRefSet = new Set(includedPacketRefs);
    const omittedPacketRefs = resolvedViews
      .filter((record) => !selectedPacketRefSet.has(record.packet.packet_ref))
      .map((record) => record.packet.packet_ref)
      .sort();
    const calibrationContextRef = buildCalibrationContextRef(selectedViews);
    const qualityReportRef = buildQualityReportRef(selectedViews, syncQuality);
    const bundleRef = buildBundleRef(activePolicy.bundle_ref_prefix, taskPhase, includedPacketRefs, missingViews, maxTemporalSkewMs);
    const shell = {
      bundle_ref: bundleRef,
      task_phase: taskPhase,
      capture_interval: interval,
      view_names: selectedViews.map((record) => record.canonical_view_name),
      included_packet_refs: includedPacketRefs,
      omitted_packet_refs: omittedPacketRefs,
      missing_views: missingViews.map((record) => record.canonical_view_name),
      sync_quality: syncQuality,
      max_temporal_skew_ms: roundMs(maxTemporalSkewMs),
      issue_codes: issues.map((issue) => issue.code),
    };

    return Object.freeze({
      schema_version: MULTI_VIEW_SYNCHRONIZER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      bundle_ref: bundleRef,
      task_phase: taskPhase,
      capture_interval: interval,
      view_packets: Object.freeze(viewPackets),
      missing_views: freezeArray(missingViews),
      view_inventory: freezeArray(inventory),
      sync_quality: syncQuality,
      max_temporal_skew_ms: roundMs(maxTemporalSkewMs),
      bundle_center_time_s: roundSeconds(centerTimeS),
      calibration_context_ref: calibrationContextRef,
      view_quality_report_ref: qualityReportRef,
      provenance_summary: buildProvenanceSummary(selectedViews, viewRegistry.manifest_id),
      included_packet_refs: freezeArray(includedPacketRefs),
      omitted_packet_refs: freezeArray(omittedPacketRefs),
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error") && selectedViews.length > 0,
      recommended_action: recommendedAction,
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_multi_view_observation_bundle",
    });
  }
}

/**
 * Functional API matching File 09's synchronizer signature.
 */
export function buildMultiViewObservationBundle(
  cameraPacketSet: readonly AcceptedCameraPacketRecord[],
  taskPhase: PerceptionTaskPhase,
  syncPolicy: MultiViewSyncPolicy,
  viewRegistry: ViewNameRegistryReport,
): MultiViewObservationBundle {
  return new MultiViewSynchronizer(syncPolicy).buildMultiViewObservationBundle(cameraPacketSet, taskPhase, syncPolicy, viewRegistry);
}

interface ResolvedPacketView {
  readonly canonical_view_name: CanonicalViewName;
  readonly packet: AcceptedCameraPacketRecord;
  readonly midpoint_s: number;
  readonly age_ms: number;
}

function resolvePackets(
  packets: readonly AcceptedCameraPacketRecord[],
  registry: ViewNameRegistryReport,
  referenceTimeS: number,
  policy: Required<MultiViewSyncPolicy>,
  issues: ValidationIssue[],
): readonly ResolvedPacketView[] {
  const resolved: ResolvedPacketView[] = [];
  for (const [index, packet] of packets.entries()) {
    const view = registry.view_records.find((record) => record.sensor_ref === packet.sensor_ref && record.camera_role === packet.camera_role);
    if (view === undefined) {
      issues.push(makeIssue("error", "PacketViewUnregistered", `$.camera_packet_set[${index}].sensor_ref`, `Packet ${packet.packet_ref} is not registered to a canonical view.`, "Run ViewNameRegistry against the same hardware manifest used by camera ingestion."));
      continue;
    }
    if (!isValidTimestamp(packet.timestamp_interval)) {
      issues.push(makeIssue("error", "TimestampInvalid", `$.camera_packet_set[${index}].timestamp_interval`, `Packet ${packet.packet_ref} has an invalid timestamp interval.`, "Recapture the view with finite monotonic timestamps."));
      continue;
    }
    if (packet.packet_status === "degraded" || packet.health_status === "degraded") {
      issues.push(makeIssue(policy.allow_degraded_views ? "warning" : "error", "DegradedViewIncluded", `$.camera_packet_set[${index}].packet_status`, `View ${view.canonical_view_name} is degraded.`, "Use it only for low-risk observation or recapture before manipulation or verification."));
    }
    if (packet.health_status === "stale" && !policy.allow_stale_views) {
      issues.push(makeIssue("error", "StaleViewIncluded", `$.camera_packet_set[${index}].health_status`, `View ${view.canonical_view_name} is stale.`, "Recapture a current view or mark it missing."));
    }
    resolved.push(Object.freeze({
      canonical_view_name: view.canonical_view_name,
      packet,
      midpoint_s: midpoint(packet.timestamp_interval),
      age_ms: Math.max(0, (referenceTimeS - packet.timestamp_interval.end_s) * 1000),
    }));
  }
  return freezeArray(resolved.sort(compareResolvedViews));
}

function selectNewestPacketPerView(resolved: readonly ResolvedPacketView[], issues: ValidationIssue[]): readonly ResolvedPacketView[] {
  const byView = new Map<CanonicalViewName, ResolvedPacketView[]>();
  for (const record of resolved) {
    const group = byView.get(record.canonical_view_name);
    if (group === undefined) {
      byView.set(record.canonical_view_name, [record]);
    } else {
      group.push(record);
    }
  }
  const selected: ResolvedPacketView[] = [];
  for (const [viewName, records] of byView) {
    const sorted = [...records].sort((a, b) => b.packet.timestamp_interval.end_s - a.packet.timestamp_interval.end_s || a.packet.packet_ref.localeCompare(b.packet.packet_ref));
    selected.push(sorted[0]);
    if (sorted.length > 1) {
      issues.push(makeIssue("warning", "DuplicateCanonicalView", `$.view_packets.${viewName}`, `Multiple packets mapped to ${viewName}; the newest packet was selected.`, "Keep omitted packet refs in telemetry and avoid using duplicate view names in prompt packets."));
    }
  }
  return freezeArray(selected.sort(compareResolvedViews));
}

function buildViewPacketMap(selected: readonly ResolvedPacketView[], centerTimeS: number): Partial<Record<CanonicalViewName, SynchronizedViewPacket>> {
  const mapped: Partial<Record<CanonicalViewName, SynchronizedViewPacket>> = {};
  for (const record of selected) {
    const packet = record.packet;
    const shell = {
      view: record.canonical_view_name,
      packet_ref: packet.packet_ref,
      sensor_ref: packet.sensor_ref,
      midpoint_s: record.midpoint_s,
      calibration_ref: packet.calibration_ref,
    };
    mapped[record.canonical_view_name] = Object.freeze({
      canonical_view_name: record.canonical_view_name,
      packet_ref: packet.packet_ref,
      sensor_ref: packet.sensor_ref,
      camera_role: packet.camera_role,
      image_ref: packet.image_ref,
      depth_ref: packet.depth_ref,
      timestamp_interval: packet.timestamp_interval,
      midpoint_s: roundSeconds(record.midpoint_s),
      offset_from_bundle_center_ms: roundMs((record.midpoint_s - centerTimeS) * 1000),
      age_ms: roundMs(record.age_ms),
      health_status: packet.health_status,
      packet_status: packet.packet_status,
      confidence: packet.confidence,
      calibration_ref: packet.calibration_ref,
      determinism_hash: computeDeterminismHash(shell),
    });
  }
  return mapped;
}

function buildViewInventory(
  selected: readonly ResolvedPacketView[],
  allResolved: readonly ResolvedPacketView[],
  requiredViews: readonly CanonicalViewName[],
  issues: ValidationIssue[],
): readonly MultiViewInventoryRecord[] {
  const selectedByView = new Map(selected.map((record) => [record.canonical_view_name, record] as const));
  const selectedRefs = new Set(selected.map((record) => record.packet.packet_ref));
  const inventory: MultiViewInventoryRecord[] = [];
  for (const record of selected) {
    const status: ViewInventoryStatus = record.packet.health_status === "stale" ? "stale" : record.packet.packet_status === "degraded" || record.packet.health_status === "degraded" ? "degraded" : "included";
    inventory.push(Object.freeze({
      canonical_view_name: record.canonical_view_name,
      status,
      packet_ref: record.packet.packet_ref,
      sensor_ref: record.packet.sensor_ref,
      reason: status === "included" ? "current accepted packet selected" : `${status} accepted packet selected`,
      recommended_action: status === "included" ? "continue" : "reobserve",
    }));
  }
  for (const record of allResolved.filter((candidate) => !selectedRefs.has(candidate.packet.packet_ref))) {
    inventory.push(Object.freeze({
      canonical_view_name: record.canonical_view_name,
      status: "duplicate_omitted",
      packet_ref: record.packet.packet_ref,
      sensor_ref: record.packet.sensor_ref,
      reason: "newer packet selected for the same canonical view",
      recommended_action: "continue",
    }));
  }
  for (const viewName of uniqueSorted(requiredViews)) {
    if (!selectedByView.has(viewName)) {
      issues.push(makeIssue(viewName === "front_primary" ? "error" : "warning", viewName === "front_primary" ? "PrimaryViewMissing" : "RequiredViewMissing", `$.required_views.${viewName}`, `Required view ${viewName} is missing from the synchronized bundle.`, "Recapture or explicitly route to Reobserve with the missing view named."));
      inventory.push(Object.freeze({
        canonical_view_name: viewName,
        status: "missing",
        reason: "required view absent from accepted camera packet set",
        recommended_action: viewName === "front_primary" ? "safe_hold" : "reobserve",
      }));
    }
  }
  return freezeArray(inventory.sort(compareInventory));
}

function captureIntervalFor(selected: readonly ResolvedPacketView[]): HardwareTimestampInterval {
  if (selected.length === 0) {
    return Object.freeze({ start_s: 0, end_s: 0 });
  }
  return Object.freeze({
    start_s: roundSeconds(Math.min(...selected.map((record) => record.packet.timestamp_interval.start_s))),
    end_s: roundSeconds(Math.max(...selected.map((record) => record.packet.timestamp_interval.end_s))),
  });
}

function centerTimeFor(selected: readonly ResolvedPacketView[], interval: HardwareTimestampInterval): number {
  if (selected.length === 0) {
    return midpoint(interval);
  }
  return selected.reduce((sum, record) => sum + record.midpoint_s, 0) / selected.length;
}

function temporalSkewMs(selected: readonly ResolvedPacketView[]): number {
  if (selected.length <= 1) {
    return 0;
  }
  const midpoints = selected.map((record) => record.midpoint_s);
  return (Math.max(...midpoints) - Math.min(...midpoints)) * 1000;
}

function classifySyncQuality(skewMs: number, policy: Required<MultiViewSyncPolicy>): MultiViewSyncQuality {
  if (skewMs <= policy.tight_skew_ms) {
    return "tight";
  }
  if (skewMs <= policy.acceptable_skew_ms) {
    return "acceptable";
  }
  if (skewMs <= policy.loose_skew_ms) {
    return "loose";
  }
  return "desynchronized";
}

function appendSyncQualityIssues(syncQuality: MultiViewSyncQuality, skewMs: number, issues: ValidationIssue[]): void {
  if (syncQuality === "loose") {
    issues.push(makeIssue("warning", "TemporalSkewLoose", "$.max_temporal_skew_ms", `Bundle temporal skew is ${roundMs(skewMs)} ms, which is loose for dynamic visual reasoning.`, "Use this bundle only for low-risk observation or recapture a tighter set."));
  }
  if (syncQuality === "desynchronized") {
    issues.push(makeIssue("error", "TemporalSkewDesynchronized", "$.max_temporal_skew_ms", `Bundle temporal skew is ${roundMs(skewMs)} ms and cannot support verification or manipulation planning.`, "Recapture a tight-sync multi-view bundle."));
  }
}

function chooseRecommendedAction(syncQuality: MultiViewSyncQuality, missingViews: readonly MultiViewInventoryRecord[], issues: readonly ValidationIssue[]): SynchronizerRecommendedAction {
  if (syncQuality === "desynchronized") {
    return "recapture_tight_sync";
  }
  if (issues.some((issue) => issue.code === "PrimaryViewMissing" || issue.code === "PacketSetEmpty")) {
    return "safe_hold";
  }
  if (missingViews.length > 0 || syncQuality === "loose") {
    return "reobserve";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "human_review";
  }
  return "continue";
}

function buildBundleRef(prefix: string, taskPhase: PerceptionTaskPhase, packetRefs: readonly Ref[], missingViews: readonly MultiViewInventoryRecord[], skewMs: number): Ref {
  const stableHash = computeDeterminismHash({ taskPhase, packetRefs, missing: missingViews.map((view) => view.canonical_view_name), skew: roundMs(skewMs) }).slice(0, 16);
  return `${prefix}_${taskPhase}_${stableHash}`;
}

function buildCalibrationContextRef(selected: readonly ResolvedPacketView[]): Ref {
  const refs = uniqueSorted(selected.map((record) => record.packet.calibration_ref));
  return `calibration_context_${computeDeterminismHash(refs).slice(0, 16)}`;
}

function buildQualityReportRef(selected: readonly ResolvedPacketView[], quality: MultiViewSyncQuality): Ref {
  const shell = selected.map((record) => [record.canonical_view_name, record.packet.packet_status, record.packet.health_status, record.packet.confidence]);
  return `view_quality_seed_${quality}_${computeDeterminismHash(shell).slice(0, 16)}`;
}

function buildProvenanceSummary(selected: readonly ResolvedPacketView[], manifestId: Ref): string {
  const viewNames = selected.map((record) => `${record.canonical_view_name}:${record.packet.packet_ref}`).join(", ");
  return `sensor-derived camera packets from manifest ${manifestId}; included views: ${viewNames.length > 0 ? viewNames : "none"}`;
}

function resolveReferenceTime(records: readonly AcceptedCameraPacketRecord[], configuredReferenceTimeS: number): number {
  if (Number.isFinite(configuredReferenceTimeS)) {
    return configuredReferenceTimeS;
  }
  const latest = records.reduce((maxTime, record) => Math.max(maxTime, record.timestamp_interval.end_s), Number.NEGATIVE_INFINITY);
  return Number.isFinite(latest) ? latest : 0;
}

function midpoint(interval: HardwareTimestampInterval): number {
  return (interval.start_s + interval.end_s) / 2;
}

function isValidTimestamp(interval: HardwareTimestampInterval): boolean {
  return Number.isFinite(interval.start_s) && Number.isFinite(interval.end_s) && interval.start_s <= interval.end_s;
}

function compareResolvedViews(a: ResolvedPacketView, b: ResolvedPacketView): number {
  return viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name) || a.packet.packet_ref.localeCompare(b.packet.packet_ref);
}

function compareInventory(a: MultiViewInventoryRecord, b: MultiViewInventoryRecord): number {
  return viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name) || a.status.localeCompare(b.status) || (a.packet_ref ?? "").localeCompare(b.packet_ref ?? "");
}

function viewSortRank(viewName: CanonicalViewName): number {
  const ranks: Readonly<Record<CanonicalViewName, number>> = {
    front_primary: 0,
    left_aux: 1,
    right_aux: 2,
    wrist_or_mouth: 3,
    rear_body: 4,
    depth_primary: 5,
    verification_aux: 6,
  };
  return ranks[viewName];
}

function mergePolicy(base: Required<MultiViewSyncPolicy>, override: MultiViewSyncPolicy): Required<MultiViewSyncPolicy> {
  return Object.freeze({
    required_views: freezeArray(override.required_views ?? base.required_views),
    tight_skew_ms: override.tight_skew_ms ?? base.tight_skew_ms,
    acceptable_skew_ms: override.acceptable_skew_ms ?? base.acceptable_skew_ms,
    loose_skew_ms: override.loose_skew_ms ?? base.loose_skew_ms,
    allow_degraded_views: override.allow_degraded_views ?? base.allow_degraded_views,
    allow_stale_views: override.allow_stale_views ?? base.allow_stale_views,
    reference_time_s: override.reference_time_s ?? base.reference_time_s,
    bundle_ref_prefix: override.bundle_ref_prefix ?? base.bundle_ref_prefix,
  });
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(severity: ValidationSeverity, code: MultiViewSynchronizerIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
