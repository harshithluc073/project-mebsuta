/**
 * Calibration context assembler for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.2, 9.3, 9.5.1, 9.6.1, 9.7, 9.17, 9.18, and 9.20.
 *
 * The assembler attaches declared camera self-knowledge to synchronized visual
 * bundles. It exposes calibration refs, intrinsics, extrinsics refs, mounting
 * role, and view limitations while rejecting hidden scene truth, QA-only
 * profiles, and hardware-internal calibration profiles.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, Transform, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CameraIntrinsics, CalibrationProfile, CameraSensorDescriptor, VirtualHardwareManifest, VirtualSensorDescriptor } from "../virtual_hardware/virtual_hardware_manifest_registry";
import type { MultiViewObservationBundle, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { CanonicalViewName, CanonicalViewRecord, ViewNameRegistryReport } from "./view_name_registry";

export const CALIBRATION_CONTEXT_ASSEMBLER_SCHEMA_VERSION = "mebsuta.calibration_context_assembler.v1" as const;

export type CalibrationContextIssueCode =
  | "ViewRegistryManifestMismatch"
  | "BundleManifestMismatch"
  | "ViewRecordMissing"
  | "CameraDescriptorMissing"
  | "CalibrationProfileMissing"
  | "CalibrationProfileBlocked"
  | "IntrinsicsMissing"
  | "ExtrinsicsMissing"
  | "PacketCalibrationMismatch"
  | "HiddenCalibrationLeak"
  | "DeclaredViewMissing";

export type CalibrationContextAction = "continue" | "reobserve" | "repair_manifest" | "safe_hold" | "human_review";

/**
 * Policy describing which calibration details may be exposed to perception.
 */
export interface CalibrationContextPolicy {
  readonly require_declared_intrinsics?: boolean;
  readonly require_declared_extrinsics?: boolean;
  readonly require_packet_calibration_match?: boolean;
  readonly include_mount_transform?: boolean;
  readonly include_missing_views?: boolean;
}

/**
 * Per-view declared calibration record used by visual prompts and geometry.
 */
export interface CalibrationPromptViewContext {
  readonly canonical_view_name: CanonicalViewName;
  readonly packet_ref?: Ref;
  readonly sensor_ref: Ref;
  readonly camera_role: CameraSensorDescriptor["camera_role"];
  readonly calibration_ref: Ref;
  readonly intrinsics_ref: Ref;
  readonly extrinsics_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly body_ref: Ref;
  readonly mounting_role: string;
  readonly view_limitations: readonly string[];
  readonly supports_depth: boolean;
  readonly declared_resolution_px: CameraSensorDescriptor["resolution"];
  readonly camera_intrinsics?: CameraIntrinsics;
  readonly mount_transform?: Transform;
  readonly profile_version?: string;
  readonly calibration_visibility: CalibrationProfile["cognitive_visibility"];
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

/**
 * Missing or unusable view context, preserved so downstream prompts cannot hide
 * absent calibration.
 */
export interface MissingCalibrationViewContext {
  readonly canonical_view_name: CanonicalViewName;
  readonly reason: string;
  readonly recommended_action: CalibrationContextAction;
}

/**
 * File 09 calibration context attached to a multi-view observation bundle.
 */
export interface CalibrationPromptContext {
  readonly schema_version: typeof CALIBRATION_CONTEXT_ASSEMBLER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly calibration_context_ref: Ref;
  readonly bundle_ref: Ref;
  readonly manifest_id: Ref;
  readonly view_contexts: readonly CalibrationPromptViewContext[];
  readonly missing_view_contexts: readonly MissingCalibrationViewContext[];
  readonly exposed_calibration_refs: readonly Ref[];
  readonly blocked_calibration_refs: readonly Ref[];
  readonly calibration_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly recommended_action: CalibrationContextAction;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_calibration_prompt_context";
}

const DEFAULT_POLICY: Required<CalibrationContextPolicy> = Object.freeze({
  require_declared_intrinsics: true,
  require_declared_extrinsics: true,
  require_packet_calibration_match: true,
  include_mount_transform: true,
  include_missing_views: true,
});

const HIDDEN_CALIBRATION_PATTERN = /(world_truth|ground_truth|qa_|backend|engine|scene_graph|collision|mesh|object_id|simulator|physics_body|debug)/i;

/**
 * Executable File 09 `CalibrationContextAssembler`.
 */
export class CalibrationContextAssembler {
  private readonly policy: Required<CalibrationContextPolicy>;

  public constructor(policy: CalibrationContextPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds declared calibration context for the synchronized views in a bundle.
   */
  public assembleCalibrationContext(
    multiViewBundle: MultiViewObservationBundle,
    hardwareManifest: VirtualHardwareManifest,
    viewRegistry: ViewNameRegistryReport,
    policy: CalibrationContextPolicy = {},
  ): CalibrationPromptContext {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    if (viewRegistry.manifest_id !== hardwareManifest.manifest_id) {
      issues.push(makeIssue("error", "ViewRegistryManifestMismatch", "$.view_registry.manifest_id", "View registry manifest differs from the hardware manifest.", "Build view naming and calibration context from the same declared manifest."));
    }
    if (!multiViewBundle.provenance_summary.includes(hardwareManifest.manifest_id)) {
      issues.push(makeIssue("warning", "BundleManifestMismatch", "$.bundle.provenance_summary", "Bundle provenance does not explicitly name the hardware manifest.", "Preserve manifest provenance through camera ingestion and synchronization."));
    }

    const viewContexts: CalibrationPromptViewContext[] = [];
    const missingContexts: MissingCalibrationViewContext[] = [];
    const blockedRefs = new Set<Ref>();
    for (const [viewName, packet] of viewPacketEntries(multiViewBundle.view_packets)) {
      const viewRecord = viewRegistry.view_records.find((record) => record.canonical_view_name === viewName && record.sensor_ref === packet.sensor_ref);
      if (viewRecord === undefined) {
        issues.push(makeIssue("error", "ViewRecordMissing", `$.view_registry.${viewName}`, `No canonical view record found for ${viewName}.`, "Run ViewNameRegistry before assembling calibration context."));
        missingContexts.push(missingContext(viewName, "canonical view record missing", "repair_manifest"));
        continue;
      }
      const context = buildViewContext(packet, viewRecord, hardwareManifest, activePolicy, blockedRefs, issues);
      if (context === undefined) {
        missingContexts.push(missingContext(viewName, "declared calibration context unavailable", "repair_manifest"));
      } else {
        viewContexts.push(context);
      }
    }

    if (activePolicy.include_missing_views) {
      for (const missingView of multiViewBundle.missing_views) {
        missingContexts.push(missingContext(missingView.canonical_view_name, missingView.reason, missingView.recommended_action === "safe_hold" ? "safe_hold" : "reobserve"));
      }
    }

    const exposedRefs = uniqueSorted(viewContexts.map((context) => context.calibration_ref));
    const recommendedAction = chooseRecommendedAction(issues, missingContexts);
    const contextRef = buildCalibrationContextRef(multiViewBundle.bundle_ref, exposedRefs, missingContexts);
    const shell = {
      contextRef,
      bundle_ref: multiViewBundle.bundle_ref,
      manifest_id: hardwareManifest.manifest_id,
      view_contexts: viewContexts.map((context) => [context.canonical_view_name, context.sensor_ref, context.calibration_ref]),
      missing: missingContexts.map((context) => context.canonical_view_name),
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: CALIBRATION_CONTEXT_ASSEMBLER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      calibration_context_ref: contextRef,
      bundle_ref: multiViewBundle.bundle_ref,
      manifest_id: hardwareManifest.manifest_id,
      view_contexts: freezeArray(viewContexts.sort(compareViewContexts)),
      missing_view_contexts: freezeArray(deduplicateMissingContexts(missingContexts)),
      exposed_calibration_refs: freezeArray(exposedRefs),
      blocked_calibration_refs: freezeArray([...blockedRefs].sort()),
      calibration_summary: summarizeCalibration(viewContexts, missingContexts),
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error") && viewContexts.length > 0,
      recommended_action: recommendedAction,
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_calibration_prompt_context",
    });
  }
}

/**
 * Functional API for calibration-context assembly.
 */
export function assembleCalibrationContext(
  multiViewBundle: MultiViewObservationBundle,
  hardwareManifest: VirtualHardwareManifest,
  viewRegistry: ViewNameRegistryReport,
  policy: CalibrationContextPolicy = {},
): CalibrationPromptContext {
  return new CalibrationContextAssembler(policy).assembleCalibrationContext(multiViewBundle, hardwareManifest, viewRegistry, policy);
}

function buildViewContext(
  packet: SynchronizedViewPacket,
  viewRecord: CanonicalViewRecord,
  manifest: VirtualHardwareManifest,
  policy: Required<CalibrationContextPolicy>,
  blockedRefs: Set<Ref>,
  issues: ValidationIssue[],
): CalibrationPromptViewContext | undefined {
  const sensor = findCameraSensor(manifest, viewRecord.sensor_ref);
  if (sensor === undefined) {
    issues.push(makeIssue("error", "CameraDescriptorMissing", `$.sensor_inventory.${viewRecord.sensor_ref}`, `Camera sensor ${viewRecord.sensor_ref} is not declared.`, "Declare the camera descriptor before exposing calibration context."));
    return undefined;
  }
  if (policy.require_packet_calibration_match && packet.calibration_ref !== sensor.calibration_ref) {
    issues.push(makeIssue("error", "PacketCalibrationMismatch", `$.view_packets.${viewRecord.canonical_view_name}.calibration_ref`, "Packet calibration ref differs from the camera descriptor.", "Use camera packets generated from the active declared calibration."));
    return undefined;
  }
  const mountProfile = profileFor(manifest, sensor.calibration_ref);
  const intrinsicsProfile = profileFor(manifest, sensor.intrinsics_ref);
  const extrinsicsProfile = profileFor(manifest, sensor.extrinsics_ref);
  validateProfile(sensor.calibration_ref, mountProfile, "$.calibration_ref", blockedRefs, issues);
  validateProfile(sensor.intrinsics_ref, intrinsicsProfile, "$.intrinsics_ref", blockedRefs, issues);
  validateProfile(sensor.extrinsics_ref, extrinsicsProfile, "$.extrinsics_ref", blockedRefs, issues);
  if (policy.require_declared_intrinsics && intrinsicsProfile?.camera_intrinsics === undefined) {
    issues.push(makeIssue("error", "IntrinsicsMissing", `$.calibration_profiles.${sensor.intrinsics_ref}`, "Declared camera intrinsics are missing.", "Add a declared camera_intrinsics calibration profile."));
  }
  if (policy.require_declared_extrinsics && extrinsicsProfile === undefined && mountProfile?.transform === undefined) {
    issues.push(makeIssue("error", "ExtrinsicsMissing", `$.calibration_profiles.${sensor.extrinsics_ref}`, "Declared camera extrinsics are missing.", "Add declared mount extrinsics or a transform-bearing calibration profile."));
  }
  if (hasHiddenCalibrationText(sensor) || hasHiddenCalibrationText(mountProfile) || hasHiddenCalibrationText(intrinsicsProfile) || hasHiddenCalibrationText(extrinsicsProfile)) {
    issues.push(makeIssue("error", "HiddenCalibrationLeak", `$.sensor_inventory.${sensor.sensor_id}`, "Calibration metadata contains hidden simulator, backend, QA, or debug wording.", "Expose only declared hardware self-knowledge and opaque refs."));
    return undefined;
  }
  const visibility = mountProfile?.cognitive_visibility ?? intrinsicsProfile?.cognitive_visibility ?? "declared_calibration_allowed";
  if (visibility !== "declared_calibration_allowed") {
    blockedRefs.add(sensor.calibration_ref);
    return undefined;
  }
  const shell = {
    view: viewRecord.canonical_view_name,
    sensor: sensor.sensor_id,
    calibration_ref: sensor.calibration_ref,
    intrinsics_ref: sensor.intrinsics_ref,
    extrinsics_ref: sensor.extrinsics_ref,
    mount_frame_ref: sensor.mount_frame_ref,
  };
  return Object.freeze({
    canonical_view_name: viewRecord.canonical_view_name,
    packet_ref: packet.packet_ref,
    sensor_ref: sensor.sensor_id,
    camera_role: sensor.camera_role,
    calibration_ref: sensor.calibration_ref,
    intrinsics_ref: sensor.intrinsics_ref,
    extrinsics_ref: sensor.extrinsics_ref,
    mount_frame_ref: sensor.mount_frame_ref,
    body_ref: sensor.body_ref,
    mounting_role: mountingRole(sensor, viewRecord),
    view_limitations: freezeArray(viewLimitations(sensor, viewRecord)),
    supports_depth: sensor.supports_depth,
    declared_resolution_px: sensor.resolution,
    camera_intrinsics: intrinsicsProfile?.camera_intrinsics,
    mount_transform: policy.include_mount_transform ? (extrinsicsProfile?.transform ?? mountProfile?.transform ?? sensor.mount_transform) : undefined,
    profile_version: mountProfile?.version ?? intrinsicsProfile?.version ?? extrinsicsProfile?.version,
    calibration_visibility: visibility,
    prompt_safe_summary: promptSafeSummary(sensor, viewRecord),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function validateProfile(
  ref: Ref,
  profile: CalibrationProfile | undefined,
  path: string,
  blockedRefs: Set<Ref>,
  issues: ValidationIssue[],
): void {
  if (profile === undefined) {
    issues.push(makeIssue("error", "CalibrationProfileMissing", path, `Calibration profile ${ref} is not declared.`, "Declare the calibration profile in the hardware manifest."));
    blockedRefs.add(ref);
    return;
  }
  if (profile.cognitive_visibility !== "declared_calibration_allowed") {
    issues.push(makeIssue("error", "CalibrationProfileBlocked", path, `Calibration profile ${ref} is not allowed for cognitive perception context.`, "Expose only declared calibration self-knowledge."));
    blockedRefs.add(ref);
  }
}

function viewPacketEntries(
  viewPackets: MultiViewObservationBundle["view_packets"],
): readonly (readonly [CanonicalViewName, SynchronizedViewPacket])[] {
  const entries: (readonly [CanonicalViewName, SynchronizedViewPacket])[] = [];
  for (const viewName of canonicalViewOrder()) {
    const packet = viewPackets[viewName];
    if (packet !== undefined) {
      entries.push([viewName, packet] as const);
    }
  }
  return freezeArray(entries);
}

function findCameraSensor(manifest: VirtualHardwareManifest, sensorRef: Ref): CameraSensorDescriptor | undefined {
  return manifest.sensor_inventory.find((sensor): sensor is CameraSensorDescriptor => isCameraSensor(sensor) && sensor.sensor_id === sensorRef);
}

function profileFor(manifest: VirtualHardwareManifest, calibrationRef: Ref): CalibrationProfile | undefined {
  return manifest.calibration_profiles.find((profile) => profile.calibration_profile_ref === calibrationRef);
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function mountingRole(sensor: CameraSensorDescriptor, viewRecord: CanonicalViewRecord): string {
  return `${viewRecord.canonical_view_name} ${sensor.sensor_class} mounted on ${sensor.mount_frame_ref}`;
}

function viewLimitations(sensor: CameraSensorDescriptor, viewRecord: CanonicalViewRecord): readonly string[] {
  const limitations = [
    `field_of_view_horizontal_deg=${sensor.field_of_view.horizontal_deg}`,
    `field_of_view_vertical_deg=${sensor.field_of_view.vertical_deg}`,
    `resolution=${sensor.resolution.width_px}x${sensor.resolution.height_px}`,
    `main_use=${viewRecord.main_use}`,
  ];
  if (!sensor.supports_depth) {
    limitations.push("no_declared_depth_output");
  }
  if (sensor.camera_role === "wrist_or_gripper") {
    limitations.push("close_view_may_be_self_occluded_by_gripper_or_tool");
  }
  if (sensor.camera_role === "rear_or_body") {
    limitations.push("rear_view_not_primary_for_forward_planning");
  }
  return freezeArray(limitations);
}

function promptSafeSummary(sensor: CameraSensorDescriptor, viewRecord: CanonicalViewRecord): string {
  return `${viewRecord.canonical_view_name} uses declared ${sensor.sensor_class} ${sensor.sensor_id} on ${sensor.mount_frame_ref} with calibration ${sensor.calibration_ref}`;
}

function missingContext(canonicalViewName: CanonicalViewName, reason: string, recommendedAction: CalibrationContextAction): MissingCalibrationViewContext {
  return Object.freeze({
    canonical_view_name: canonicalViewName,
    reason,
    recommended_action: recommendedAction,
  });
}

function chooseRecommendedAction(issues: readonly ValidationIssue[], missingContexts: readonly MissingCalibrationViewContext[]): CalibrationContextAction {
  if (issues.some((issue) => issue.code === "CameraDescriptorMissing" || issue.code === "CalibrationProfileMissing" || issue.code === "CalibrationProfileBlocked" || issue.code === "HiddenCalibrationLeak")) {
    return "repair_manifest";
  }
  if (missingContexts.some((context) => context.recommended_action === "safe_hold")) {
    return "safe_hold";
  }
  if (missingContexts.length > 0) {
    return "reobserve";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "human_review";
  }
  return "continue";
}

function buildCalibrationContextRef(bundleRef: Ref, exposedRefs: readonly Ref[], missingContexts: readonly MissingCalibrationViewContext[]): Ref {
  const digest = computeDeterminismHash({ bundleRef, exposedRefs, missing: missingContexts.map((context) => context.canonical_view_name) }).slice(0, 16);
  return `calibration_context_${digest}`;
}

function summarizeCalibration(viewContexts: readonly CalibrationPromptViewContext[], missingContexts: readonly MissingCalibrationViewContext[]): string {
  const exposed = viewContexts.map((context) => `${context.canonical_view_name}:${context.calibration_ref}`).join(", ");
  const missing = missingContexts.map((context) => context.canonical_view_name).join(", ");
  return `declared calibration contexts=${exposed.length > 0 ? exposed : "none"}; missing=${missing.length > 0 ? missing : "none"}`;
}

function deduplicateMissingContexts(contexts: readonly MissingCalibrationViewContext[]): readonly MissingCalibrationViewContext[] {
  const byView = new Map<CanonicalViewName, MissingCalibrationViewContext>();
  for (const context of contexts) {
    byView.set(context.canonical_view_name, context);
  }
  return freezeArray([...byView.values()].sort((a, b) => viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name)));
}

function compareViewContexts(a: CalibrationPromptViewContext, b: CalibrationPromptViewContext): number {
  return viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name) || a.sensor_ref.localeCompare(b.sensor_ref);
}

function canonicalViewOrder(): readonly CanonicalViewName[] {
  return freezeArray(["front_primary", "left_aux", "right_aux", "wrist_or_mouth", "rear_body", "depth_primary", "verification_aux"] as const);
}

function viewSortRank(viewName: CanonicalViewName): number {
  return canonicalViewOrder().indexOf(viewName);
}

function hasHiddenCalibrationText(value: unknown): boolean {
  return HIDDEN_CALIBRATION_PATTERN.test(JSON.stringify(value ?? ""));
}

function mergePolicy(base: Required<CalibrationContextPolicy>, override: CalibrationContextPolicy): Required<CalibrationContextPolicy> {
  return Object.freeze({
    require_declared_intrinsics: override.require_declared_intrinsics ?? base.require_declared_intrinsics,
    require_declared_extrinsics: override.require_declared_extrinsics ?? base.require_declared_extrinsics,
    require_packet_calibration_match: override.require_packet_calibration_match ?? base.require_packet_calibration_match,
    include_mount_transform: override.include_mount_transform ?? base.include_mount_transform,
    include_missing_views: override.include_missing_views ?? base.include_missing_views,
  });
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(severity: ValidationSeverity, code: CalibrationContextIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
