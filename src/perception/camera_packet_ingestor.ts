/**
 * Camera packet ingestor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.2, 9.3, 9.5, 9.17, 9.18, 9.19, and 9.20.
 *
 * The ingestor is the perception layer's first executable gate. It accepts only
 * camera packets produced by declared File 04 virtual hardware, verifies packet
 * freshness, declared calibration, route eligibility, and debug-overlay
 * absence, then emits a cognitive-safe ingest report for synchronization and
 * later multi-view processing.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CameraPacket, HardwareTimestampInterval } from "../virtual_hardware/virtual_hardware_adapter";
import { VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION } from "../virtual_hardware/virtual_hardware_adapter";
import type { CameraSensorDescriptor, VirtualHardwareManifest, VirtualSensorDescriptor } from "../virtual_hardware/virtual_hardware_manifest_registry";

export const CAMERA_PACKET_INGESTOR_SCHEMA_VERSION = "mebsuta.camera_packet_ingestor.v1" as const;

const DEFAULT_MAX_PACKET_AGE_MS = 125;
const DEFAULT_MIN_CONFIDENCE = 0.35;
const DEFAULT_EXPECTED_CAMERA_ROLES: readonly CameraSensorDescriptor["camera_role"][] = ["primary_egocentric"];
const FORBIDDEN_PACKET_FIELD_PATTERN = /(debug|overlay|segmentation|backend|engine|scene_graph|object_id|mesh|ground_truth|qa_)/i;

export type CameraIngestIssueCode =
  | "PacketSchemaMismatch"
  | "PacketKindMismatch"
  | "PacketManifestMismatch"
  | "CameraUndeclared"
  | "CameraClassInvalid"
  | "CameraRouteBlocked"
  | "DebugOverlayDetected"
  | "HiddenFieldLeak"
  | "TimestampInvalid"
  | "PacketStale"
  | "PacketBlocked"
  | "PacketConfidenceLow"
  | "CalibrationMissing"
  | "CalibrationNotDeclared"
  | "CalibrationExposureBlocked"
  | "CameraRoleMismatch"
  | "ResolutionMismatch"
  | "DuplicateCameraPacket"
  | "ExpectedCameraMissing";

export type CameraPacketReadiness = "accepted" | "rejected" | "degraded";
export type CameraIngestRecommendedAction = "continue" | "recapture_clean" | "reobserve" | "safe_hold" | "human_review";

/**
 * Firewall options for the first visual-ingestion boundary.
 */
export interface VisualFirewallPolicy {
  readonly max_packet_age_ms?: number;
  readonly reference_time_s?: number;
  readonly minimum_confidence?: number;
  readonly require_prompt_allowed_route?: boolean;
  readonly require_declared_calibration?: boolean;
  readonly reject_degraded_packets?: boolean;
  readonly expected_camera_roles?: readonly CameraSensorDescriptor["camera_role"][];
}

/**
 * Compact accepted packet record; the image payload remains referenced instead
 * of copied into the report.
 */
export interface AcceptedCameraPacketRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly camera_role: CameraSensorDescriptor["camera_role"];
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly midpoint_s: number;
  readonly age_ms: number;
  readonly health_status: CameraPacket["health_status"];
  readonly packet_status: CameraPacket["packet_status"];
  readonly confidence: number;
  readonly calibration_ref: Ref;
  readonly intrinsics_ref: Ref;
  readonly extrinsics_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly resolution_px: CameraPacket["resolution_px"];
  readonly declared_resolution_px: CameraSensorDescriptor["resolution"];
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Rejection detail for an individual camera packet candidate.
 */
export interface RejectedCameraPacketRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly camera_role?: CameraSensorDescriptor["camera_role"];
  readonly issue_codes: readonly CameraIngestIssueCode[];
  readonly messages: readonly string[];
  readonly recommended_action: CameraIngestRecommendedAction;
}

/**
 * Manifest camera that should have contributed evidence but did not.
 */
export interface MissingCameraRecord {
  readonly sensor_ref: Ref;
  readonly camera_role: CameraSensorDescriptor["camera_role"];
  readonly reason: "expected_role_absent" | "declared_camera_absent";
  readonly recommended_action: CameraIngestRecommendedAction;
}

/**
 * Health summary produced for the next multi-view synchronizer stage.
 */
export interface CameraIngestHealthSummary {
  readonly accepted_camera_count: number;
  readonly rejected_camera_count: number;
  readonly degraded_camera_count: number;
  readonly missing_camera_count: number;
  readonly stale_packet_refs: readonly Ref[];
  readonly debug_overlay_packet_refs: readonly Ref[];
  readonly undeclared_sensor_refs: readonly Ref[];
  readonly calibration_issue_refs: readonly Ref[];
  readonly recommended_action: CameraIngestRecommendedAction;
}

/**
 * Full ingestion result matching File 09's
 * `ingestCameraPackets(cameraPackets, hardwareManifest, firewallPolicy)`.
 */
export interface CameraIngestReport {
  readonly schema_version: typeof CAMERA_PACKET_INGESTOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly manifest_id: Ref;
  readonly accepted_packets: readonly AcceptedCameraPacketRecord[];
  readonly rejected_packets: readonly RejectedCameraPacketRecord[];
  readonly missing_cameras: readonly MissingCameraRecord[];
  readonly health_summary: CameraIngestHealthSummary;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_camera_ingest_report";
}

/**
 * Executable File 09 `CameraPacketIngestor`.
 */
export class CameraPacketIngestor {
  private readonly policy: Required<VisualFirewallPolicy>;

  public constructor(policy: VisualFirewallPolicy = {}) {
    this.policy = Object.freeze({
      max_packet_age_ms: policy.max_packet_age_ms ?? DEFAULT_MAX_PACKET_AGE_MS,
      reference_time_s: policy.reference_time_s ?? Number.NaN,
      minimum_confidence: policy.minimum_confidence ?? DEFAULT_MIN_CONFIDENCE,
      require_prompt_allowed_route: policy.require_prompt_allowed_route ?? false,
      require_declared_calibration: policy.require_declared_calibration ?? true,
      reject_degraded_packets: policy.reject_degraded_packets ?? false,
      expected_camera_roles: freezeArray(policy.expected_camera_roles ?? DEFAULT_EXPECTED_CAMERA_ROLES),
    });
  }

  /**
   * Validates declared camera packets and returns accepted packet references for
   * the multi-view synchronizer.
   */
  public ingestCameraPackets(
    cameraPackets: readonly CameraPacket[],
    hardwareManifest: VirtualHardwareManifest,
    firewallPolicy: VisualFirewallPolicy = {},
  ): CameraIngestReport {
    const activePolicy = mergePolicy(this.policy, firewallPolicy);
    const issues: ValidationIssue[] = [];
    const accepted: AcceptedCameraPacketRecord[] = [];
    const rejected: RejectedCameraPacketRecord[] = [];
    const seenPacketRefs = new Set<Ref>();
    const acceptedSensorRefs = new Set<Ref>();
    const referenceTimeS = resolveReferenceTime(cameraPackets, activePolicy.reference_time_s);

    for (const [index, packet] of cameraPackets.entries()) {
      const packetIssues: ValidationIssue[] = [];
      const declaredCamera = findDeclaredCamera(hardwareManifest, packet.sensor_id);
      validatePacketShell(packet, index, hardwareManifest, declaredCamera, activePolicy, referenceTimeS, seenPacketRefs, packetIssues);

      if (packetIssues.some((issue) => issue.severity === "error")) {
        rejected.push(buildRejectedRecord(packet, declaredCamera, packetIssues));
        issues.push(...packetIssues);
        continue;
      }

      if (packetIssues.length > 0) {
        issues.push(...packetIssues);
      }

      if (declaredCamera !== undefined) {
        accepted.push(buildAcceptedRecord(packet, declaredCamera, referenceTimeS, packetIssues));
        acceptedSensorRefs.add(packet.sensor_id);
      }
    }

    const missingCameras = findMissingExpectedCameras(hardwareManifest, activePolicy.expected_camera_roles, acceptedSensorRefs);
    for (const missing of missingCameras) {
      issues.push(makeIssue("warning", "ExpectedCameraMissing", `$.manifest.sensor_inventory.${missing.sensor_ref}`, `Expected camera role ${missing.camera_role} has no accepted packet.`, "Capture the declared camera or mark the view as missing in the multi-view inventory."));
    }

    const healthSummary = buildHealthSummary(accepted, rejected, missingCameras);
    const reportShell = {
      manifest_id: hardwareManifest.manifest_id,
      accepted_packets: accepted.map((packet) => packet.packet_ref),
      rejected_packets: rejected.map((packet) => packet.packet_ref),
      missing_cameras: missingCameras.map((camera) => camera.sensor_ref),
      issues: issues.map((issue) => issue.code),
      recommended_action: healthSummary.recommended_action,
    };
    return Object.freeze({
      schema_version: CAMERA_PACKET_INGESTOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      manifest_id: hardwareManifest.manifest_id,
      accepted_packets: freezeArray(accepted),
      rejected_packets: freezeArray(rejected),
      missing_cameras: freezeArray(missingCameras),
      health_summary: healthSummary,
      issues: freezeArray(issues),
      ok: rejected.length === 0 && accepted.length > 0 && issues.every((issue) => issue.severity !== "error"),
      determinism_hash: computeDeterminismHash(reportShell),
      cognitive_visibility: "perception_camera_ingest_report",
    });
  }
}

/**
 * Functional API matching the architecture signature directly.
 */
export function ingestCameraPackets(
  cameraPackets: readonly CameraPacket[],
  hardwareManifest: VirtualHardwareManifest,
  firewallPolicy: VisualFirewallPolicy = {},
): CameraIngestReport {
  return new CameraPacketIngestor(firewallPolicy).ingestCameraPackets(cameraPackets, hardwareManifest, firewallPolicy);
}

function mergePolicy(base: Required<VisualFirewallPolicy>, override: VisualFirewallPolicy): Required<VisualFirewallPolicy> {
  return Object.freeze({
    max_packet_age_ms: override.max_packet_age_ms ?? base.max_packet_age_ms,
    reference_time_s: override.reference_time_s ?? base.reference_time_s,
    minimum_confidence: override.minimum_confidence ?? base.minimum_confidence,
    require_prompt_allowed_route: override.require_prompt_allowed_route ?? base.require_prompt_allowed_route,
    require_declared_calibration: override.require_declared_calibration ?? base.require_declared_calibration,
    reject_degraded_packets: override.reject_degraded_packets ?? base.reject_degraded_packets,
    expected_camera_roles: freezeArray(override.expected_camera_roles ?? base.expected_camera_roles),
  });
}

function validatePacketShell(
  packet: CameraPacket,
  index: number,
  manifest: VirtualHardwareManifest,
  declaredCamera: CameraSensorDescriptor | undefined,
  policy: Required<VisualFirewallPolicy>,
  referenceTimeS: number,
  seenPacketRefs: Set<Ref>,
  issues: ValidationIssue[],
): void {
  const path = `$.camera_packets[${index}]`;
  if (packet.schema_version !== VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION) {
    issues.push(makeIssue("error", "PacketSchemaMismatch", `${path}.schema_version`, "Camera packet schema version does not match the hardware adapter schema.", "Regenerate the packet through the active virtual hardware adapter."));
  }
  if (packet.packet_kind !== "camera") {
    issues.push(makeIssue("error", "PacketKindMismatch", `${path}.packet_kind`, "Perception camera ingestion accepts only camera packets.", "Route non-camera sensor evidence through its dedicated ingestor."));
  }
  if (seenPacketRefs.has(packet.packet_id)) {
    issues.push(makeIssue("error", "DuplicateCameraPacket", `${path}.packet_id`, `Camera packet ${packet.packet_id} was submitted more than once.`, "Deduplicate camera packets before perception ingestion."));
  }
  seenPacketRefs.add(packet.packet_id);
  if (packet.manifest_id !== manifest.manifest_id || packet.provenance.manifest_id !== manifest.manifest_id) {
    issues.push(makeIssue("error", "PacketManifestMismatch", `${path}.manifest_id`, "Camera packet manifest provenance differs from the active hardware manifest.", "Use packets produced from the active manifest only."));
  }
  if (!isValidTimestamp(packet.timestamp_interval)) {
    issues.push(makeIssue("error", "TimestampInvalid", `${path}.timestamp_interval`, "Camera packet timestamp interval must be finite and monotonic.", "Recapture the camera frame with valid simulation-clock timestamps."));
  }
  if (declaredCamera === undefined) {
    issues.push(makeIssue("error", "CameraUndeclared", `${path}.sensor_id`, `Camera sensor ${packet.sensor_id} is not declared in the hardware manifest.`, "Declare the camera and calibration in File 04 hardware before exposing visual evidence."));
    return;
  }
  validateDeclaredCamera(packet, declaredCamera, policy, referenceTimeS, path, issues);
}

function validateDeclaredCamera(
  packet: CameraPacket,
  camera: CameraSensorDescriptor,
  policy: Required<VisualFirewallPolicy>,
  referenceTimeS: number,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isCameraSensor(camera)) {
    issues.push(makeIssue("error", "CameraClassInvalid", `${path}.sensor_id`, "Declared sensor is not an RGB, depth, or stereo camera.", "Route only declared camera hardware into the visual perception layer."));
  }
  if (policy.require_prompt_allowed_route && camera.cognitive_route !== "prompt_allowed") {
    issues.push(makeIssue("error", "CameraRouteBlocked", `${path}.sensor_id`, "Camera route is not prompt allowed under the active firewall policy.", "Use a prompt-allowed visual sensor or relax the policy for non-prompt perception staging."));
  }
  if (camera.cognitive_route === "blocked" || camera.cognitive_route === "qa_only" || camera.cognitive_visibility === "hardware_internal_only" || camera.cognitive_visibility === "qa_only") {
    issues.push(makeIssue("error", "CameraRouteBlocked", `${path}.sensor_id`, "Camera is not eligible for cognitive visual ingestion.", "Use only cameras declared for prompt or sensor-bus cognitive routing."));
  }
  if (packet.camera_role !== camera.camera_role) {
    issues.push(makeIssue("error", "CameraRoleMismatch", `${path}.camera_role`, "Camera packet role does not match the manifest camera role.", "Regenerate packet metadata from the declared camera descriptor."));
  }
  if (packet.resolution_px.width_px !== camera.resolution.width_px || packet.resolution_px.height_px !== camera.resolution.height_px) {
    issues.push(makeIssue("warning", "ResolutionMismatch", `${path}.resolution_px`, "Camera packet resolution differs from the declared camera resolution.", "Attach the declared resolution or record an explicit degraded view."));
  }
  if (packet.provenance.calibration_ref.length === 0 || camera.calibration_ref.length === 0 || packet.calibration_exposure === "blocked") {
    issues.push(makeIssue("error", "CalibrationMissing", `${path}.provenance.calibration_ref`, "Camera packet lacks declared calibration for cognitive-safe visual reasoning.", "Attach declared intrinsics, extrinsics, and mount calibration before perception use."));
  }
  if (policy.require_declared_calibration && packet.provenance.calibration_ref !== camera.calibration_ref) {
    issues.push(makeIssue("error", "CalibrationNotDeclared", `${path}.provenance.calibration_ref`, "Camera packet calibration ref does not match the declared camera calibration.", "Use the calibration profile declared on the camera descriptor."));
  }
  if (packet.calibration_exposure !== "declared_self_knowledge") {
    issues.push(makeIssue("error", "CalibrationExposureBlocked", `${path}.calibration_exposure`, "Camera calibration exposure is not declared self-knowledge.", "Expose only declared hardware calibration to perception."));
  }
  if (packet.overlay_blocked || camera.overlay_policy !== "none" || packet.hidden_fields_removed.some((field) => FORBIDDEN_PACKET_FIELD_PATTERN.test(field))) {
    issues.push(makeIssue("error", "DebugOverlayDetected", `${path}.overlay_blocked`, "Camera packet contains or reports debug overlay, segmentation, backend, QA, or hidden render fields.", "Recapture a clean camera frame without debug or QA-visible visual layers."));
  }
  if (packet.hidden_fields_removed.length === 0) {
    issues.push(makeIssue("warning", "HiddenFieldLeak", `${path}.hidden_fields_removed`, "Camera packet does not list stripped internal fields.", "Emit an explicit hidden-field removal record from the hardware adapter."));
  }
  if (packet.packet_status === "blocked") {
    issues.push(makeIssue("error", "PacketBlocked", `${path}.packet_status`, "Camera packet is blocked and cannot enter perception.", "Recapture or route to SafeHold if visual evidence is required."));
  }
  if (packet.packet_status === "degraded" && policy.reject_degraded_packets) {
    issues.push(makeIssue("error", "PacketBlocked", `${path}.packet_status`, "Camera packet is degraded and rejected by the active firewall policy.", "Recapture or relax the policy for non-critical observation."));
  }
  if (packet.health_status === "stale" || packetAgeMs(packet, referenceTimeS) > policy.max_packet_age_ms) {
    issues.push(makeIssue("error", "PacketStale", `${path}.timestamp_interval`, "Camera packet is stale relative to the perception reference time.", "Capture a fresh view or mark the view as missing."));
  }
  if (!Number.isFinite(packet.confidence) || packet.confidence < policy.minimum_confidence || packet.confidence > 1) {
    issues.push(makeIssue("error", "PacketConfidenceLow", `${path}.confidence`, "Camera packet confidence is outside the accepted cognitive evidence range.", "Recapture or downgrade the view before prompt packaging."));
  }
}

function buildAcceptedRecord(
  packet: CameraPacket,
  declaredCamera: CameraSensorDescriptor,
  referenceTimeS: number,
  packetIssues: readonly ValidationIssue[],
): AcceptedCameraPacketRecord {
  const shell = {
    packet_id: packet.packet_id,
    sensor_id: packet.sensor_id,
    camera_role: packet.camera_role,
    image_ref: packet.image_ref,
    timestamp_interval: packet.timestamp_interval,
    health_status: packet.health_status,
    packet_status: packet.packet_status,
    issue_codes: packetIssues.map((issue) => issue.code),
  };
  return Object.freeze({
    packet_ref: packet.packet_id,
    sensor_ref: packet.sensor_id,
    camera_role: packet.camera_role,
    image_ref: packet.image_ref,
    depth_ref: packet.depth_ref,
    timestamp_interval: packet.timestamp_interval,
    midpoint_s: midpoint(packet.timestamp_interval),
    age_ms: packetAgeMs(packet, referenceTimeS),
    health_status: packet.health_status,
    packet_status: packet.packet_status,
    confidence: packet.confidence,
    calibration_ref: packet.provenance.calibration_ref,
    intrinsics_ref: declaredCamera.intrinsics_ref,
    extrinsics_ref: declaredCamera.extrinsics_ref,
    mount_frame_ref: packet.mount_frame_ref,
    resolution_px: packet.resolution_px,
    declared_resolution_px: declaredCamera.resolution,
    hidden_fields_removed: freezeArray(packet.hidden_fields_removed),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildRejectedRecord(
  packet: CameraPacket,
  declaredCamera: CameraSensorDescriptor | undefined,
  packetIssues: readonly ValidationIssue[],
): RejectedCameraPacketRecord {
  return Object.freeze({
    packet_ref: packet.packet_id,
    sensor_ref: packet.sensor_id,
    camera_role: declaredCamera?.camera_role ?? packet.camera_role,
    issue_codes: freezeArray(packetIssues.map((issue) => issue.code as CameraIngestIssueCode)),
    messages: freezeArray(packetIssues.map((issue) => issue.message)),
    recommended_action: recommendedActionForIssues(packetIssues),
  });
}

function findMissingExpectedCameras(
  manifest: VirtualHardwareManifest,
  expectedRoles: readonly CameraSensorDescriptor["camera_role"][],
  acceptedSensorRefs: ReadonlySet<Ref>,
): readonly MissingCameraRecord[] {
  const expected = new Set(expectedRoles);
  const missing = manifest.sensor_inventory
    .filter(isCameraSensor)
    .filter((sensor) => expected.has(sensor.camera_role))
    .filter((sensor) => sensor.cognitive_route === "prompt_allowed" || sensor.cognitive_route === "sensor_bus_only")
    .filter((sensor) => !acceptedSensorRefs.has(sensor.sensor_id))
    .map((sensor) => Object.freeze({
      sensor_ref: sensor.sensor_id,
      camera_role: sensor.camera_role,
      reason: "expected_role_absent" as const,
      recommended_action: "reobserve" as const,
    }));
  return freezeArray(missing);
}

function buildHealthSummary(
  accepted: readonly AcceptedCameraPacketRecord[],
  rejected: readonly RejectedCameraPacketRecord[],
  missing: readonly MissingCameraRecord[],
): CameraIngestHealthSummary {
  const stalePacketRefs = rejected.filter((record) => record.issue_codes.includes("PacketStale")).map((record) => record.packet_ref).sort();
  const debugOverlayPacketRefs = rejected.filter((record) => record.issue_codes.includes("DebugOverlayDetected")).map((record) => record.packet_ref).sort();
  const undeclaredSensorRefs = rejected.filter((record) => record.issue_codes.includes("CameraUndeclared")).map((record) => record.sensor_ref).sort();
  const calibrationIssueRefs = rejected
    .filter((record) => record.issue_codes.includes("CalibrationMissing") || record.issue_codes.includes("CalibrationNotDeclared") || record.issue_codes.includes("CalibrationExposureBlocked"))
    .map((record) => record.packet_ref)
    .sort();
  return Object.freeze({
    accepted_camera_count: accepted.length,
    rejected_camera_count: rejected.length,
    degraded_camera_count: accepted.filter((record) => record.packet_status === "degraded" || record.health_status === "degraded").length,
    missing_camera_count: missing.length,
    stale_packet_refs: freezeArray(stalePacketRefs),
    debug_overlay_packet_refs: freezeArray(debugOverlayPacketRefs),
    undeclared_sensor_refs: freezeArray(undeclaredSensorRefs),
    calibration_issue_refs: freezeArray(calibrationIssueRefs),
    recommended_action: chooseSummaryAction(accepted, rejected, missing),
  });
}

function chooseSummaryAction(
  accepted: readonly AcceptedCameraPacketRecord[],
  rejected: readonly RejectedCameraPacketRecord[],
  missing: readonly MissingCameraRecord[],
): CameraIngestRecommendedAction {
  if (rejected.some((record) => record.issue_codes.includes("DebugOverlayDetected") || record.issue_codes.includes("CameraUndeclared"))) {
    return "recapture_clean";
  }
  if (accepted.length === 0) {
    return "safe_hold";
  }
  if (missing.length > 0 || rejected.some((record) => record.issue_codes.includes("PacketStale"))) {
    return "reobserve";
  }
  if (rejected.length > 0) {
    return "human_review";
  }
  return "continue";
}

function recommendedActionForIssues(issues: readonly ValidationIssue[]): CameraIngestRecommendedAction {
  const codes = new Set(issues.map((issue) => issue.code));
  if (codes.has("DebugOverlayDetected") || codes.has("CameraUndeclared") || codes.has("HiddenFieldLeak")) {
    return "recapture_clean";
  }
  if (codes.has("PacketStale") || codes.has("ExpectedCameraMissing")) {
    return "reobserve";
  }
  if (codes.has("PacketBlocked") || codes.has("CameraRouteBlocked")) {
    return "safe_hold";
  }
  return "human_review";
}

function findDeclaredCamera(manifest: VirtualHardwareManifest, sensorId: Ref): CameraSensorDescriptor | undefined {
  return manifest.sensor_inventory.find((sensor): sensor is CameraSensorDescriptor => isCameraSensor(sensor) && sensor.sensor_id === sensorId);
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function resolveReferenceTime(cameraPackets: readonly CameraPacket[], configuredReferenceTimeS: number): number {
  if (Number.isFinite(configuredReferenceTimeS)) {
    return configuredReferenceTimeS;
  }
  const latestEnd = cameraPackets.reduce((latest, packet) => Math.max(latest, packet.timestamp_interval.end_s), Number.NEGATIVE_INFINITY);
  return Number.isFinite(latestEnd) ? latestEnd : 0;
}

function packetAgeMs(packet: CameraPacket, referenceTimeS: number): number {
  return Math.max(0, (referenceTimeS - packet.timestamp_interval.end_s) * 1000);
}

function midpoint(interval: HardwareTimestampInterval): number {
  return (interval.start_s + interval.end_s) / 2;
}

function isValidTimestamp(interval: HardwareTimestampInterval): boolean {
  return Number.isFinite(interval.start_s) && Number.isFinite(interval.end_s) && interval.start_s <= interval.end_s;
}

function makeIssue(severity: ValidationSeverity, code: CameraIngestIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
