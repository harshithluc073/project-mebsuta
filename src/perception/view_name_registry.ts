/**
 * View name registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.4, 9.5.1, 9.5.2, 9.6.1, 9.17, 9.18, and 9.20.
 *
 * The registry converts declared File 04 camera descriptors into the canonical
 * File 09 view vocabulary used by multi-view bundles, prompts, quality reports,
 * verification packets, and visual memory evidence. It never invents hidden
 * scene knowledge; every view name is derived from declared camera role,
 * declared sensor class, mount metadata, and explicit registry policy.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CameraPacket } from "../virtual_hardware/virtual_hardware_adapter";
import type { CameraRole, CameraSensorDescriptor, VirtualHardwareManifest, VirtualSensorDescriptor } from "../virtual_hardware/virtual_hardware_manifest_registry";

export const VIEW_NAME_REGISTRY_SCHEMA_VERSION = "mebsuta.view_name_registry.v1" as const;

export type CanonicalViewName = "front_primary" | "left_aux" | "right_aux" | "wrist_or_mouth" | "rear_body" | "depth_primary" | "verification_aux";
export type ViewNameResolutionStatus = "resolved" | "ambiguous" | "unknown";
export type ViewNameRecommendedAction = "continue" | "rename_alias" | "declare_camera" | "split_view_role" | "human_review";
export type ViewNameIssueCode =
  | "CameraDescriptorMissing"
  | "CameraDescriptorInvalid"
  | "CameraRouteBlocked"
  | "CanonicalViewAmbiguous"
  | "AliasAmbiguous"
  | "AliasInvalid"
  | "RequiredViewMissing"
  | "DepthViewMismatch"
  | "PacketViewUnknown"
  | "VerificationViewUndeclared";

/**
 * Optional naming policy for embodiment-specific or task-specific view roles.
 */
export interface ViewNameRegistryPolicy {
  readonly required_views?: readonly CanonicalViewName[];
  readonly verification_sensor_refs?: readonly Ref[];
  readonly allow_multiple_sensors_per_view?: boolean;
  readonly include_sensor_id_aliases?: boolean;
  readonly include_display_name_aliases?: boolean;
  readonly reject_blocked_cognitive_routes?: boolean;
}

/**
 * One declared camera mapped into File 09 canonical naming.
 */
export interface CanonicalViewRecord {
  readonly canonical_view_name: CanonicalViewName;
  readonly sensor_ref: Ref;
  readonly camera_role: CameraRole;
  readonly sensor_class: CameraSensorDescriptor["sensor_class"];
  readonly embodiment_kind: EmbodimentKind;
  readonly display_name: string;
  readonly mount_frame_ref: Ref;
  readonly body_ref: Ref;
  readonly calibration_ref: Ref;
  readonly intrinsics_ref: Ref;
  readonly extrinsics_ref: Ref;
  readonly resolution_px: CameraSensorDescriptor["resolution"];
  readonly supports_depth: boolean;
  readonly cognitive_route: CameraSensorDescriptor["cognitive_route"];
  readonly aliases: readonly string[];
  readonly main_use: string;
  readonly typical_source: string;
  readonly prompt_safe_label: string;
  readonly determinism_hash: string;
}

/**
 * Alias lookup entry used by prompt packaging and bundle assembly.
 */
export interface ViewAliasRecord {
  readonly alias: string;
  readonly canonical_view_name: CanonicalViewName;
  readonly sensor_ref: Ref;
}

/**
 * Ambiguity detail emitted whenever a prompt-facing name could map to more
 * than one declared camera.
 */
export interface ViewNameAmbiguityRecord {
  readonly key: string;
  readonly candidate_sensor_refs: readonly Ref[];
  readonly candidate_view_names: readonly CanonicalViewName[];
  readonly recommended_action: ViewNameRecommendedAction;
}

/**
 * Result of resolving a free-form view reference or packet source to a
 * canonical view.
 */
export interface ViewNameResolution {
  readonly input: string;
  readonly status: ViewNameResolutionStatus;
  readonly canonical_view_name?: CanonicalViewName;
  readonly sensor_ref?: Ref;
  readonly issue?: ValidationIssue;
}

/**
 * Complete registry report for the active hardware manifest.
 */
export interface ViewNameRegistryReport {
  readonly schema_version: typeof VIEW_NAME_REGISTRY_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly manifest_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly view_records: readonly CanonicalViewRecord[];
  readonly alias_table: readonly ViewAliasRecord[];
  readonly ambiguities: readonly ViewNameAmbiguityRecord[];
  readonly missing_required_views: readonly CanonicalViewName[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_view_name_registry";
}

const DEFAULT_POLICY: Required<ViewNameRegistryPolicy> = Object.freeze({
  required_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  verification_sensor_refs: freezeArray([] as readonly Ref[]),
  allow_multiple_sensors_per_view: false,
  include_sensor_id_aliases: true,
  include_display_name_aliases: true,
  reject_blocked_cognitive_routes: true,
});

const VIEW_USE: Readonly<Record<CanonicalViewName, string>> = Object.freeze({
  front_primary: "General scene understanding, approach, and navigation.",
  left_aux: "Occlusion reduction and left-side relation checks.",
  right_aux: "Occlusion reduction and right-side relation checks.",
  wrist_or_mouth: "Close manipulation view for grasp, contact, placement, and tool attachment.",
  rear_body: "Backing motion, dragged object awareness, and rear collision checks.",
  depth_primary: "Declared depth evidence for estimated local geometry.",
  verification_aux: "Task-success cross-check from an embodied declared camera.",
});

/**
 * Executable File 09 `ViewNameRegistry`.
 */
export class ViewNameRegistry {
  private readonly policy: Required<ViewNameRegistryPolicy>;

  public constructor(policy: ViewNameRegistryPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds a deterministic canonical view registry from declared camera
   * hardware. Blocked and QA-only cameras are reported because they cannot be
   * safely named for prompt-facing visual evidence.
   */
  public buildViewNameRegistry(hardwareManifest: VirtualHardwareManifest, policy: ViewNameRegistryPolicy = {}): ViewNameRegistryReport {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    const cameraSensors = hardwareManifest.sensor_inventory.filter(isCameraSensor);
    if (cameraSensors.length === 0) {
      issues.push(makeIssue("error", "CameraDescriptorMissing", "$.sensor_inventory", "No declared camera descriptors are available for view naming.", "Declare at least one embodied camera before perception view naming."));
    }

    const viewRecords = cameraSensors
      .map((camera) => buildViewRecord(camera, hardwareManifest.embodiment_kind, activePolicy, issues))
      .filter((record): record is CanonicalViewRecord => record !== undefined)
      .sort(compareViewRecords);
    const aliasTable = buildAliasTable(viewRecords, activePolicy, issues);
    const ambiguities = buildAmbiguities(viewRecords, aliasTable, activePolicy, issues);
    const missingRequiredViews = findMissingRequiredViews(viewRecords, activePolicy.required_views);
    for (const viewName of missingRequiredViews) {
      issues.push(makeIssue("warning", "RequiredViewMissing", `$.required_views.${viewName}`, `Required view ${viewName} has no declared camera mapping.`, "Declare the camera or explicitly mark the view as missing in the multi-view inventory."));
    }

    const shell = {
      manifest_id: hardwareManifest.manifest_id,
      embodiment_kind: hardwareManifest.embodiment_kind,
      view_records: viewRecords.map((record) => [record.canonical_view_name, record.sensor_ref]),
      aliases: aliasTable.map((alias) => [alias.alias, alias.canonical_view_name, alias.sensor_ref]),
      ambiguities: ambiguities.map((ambiguity) => ambiguity.key),
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: VIEW_NAME_REGISTRY_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      manifest_id: hardwareManifest.manifest_id,
      embodiment_kind: hardwareManifest.embodiment_kind,
      view_records: freezeArray(viewRecords),
      alias_table: freezeArray(aliasTable),
      ambiguities: freezeArray(ambiguities),
      missing_required_views: freezeArray(missingRequiredViews),
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error"),
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_view_name_registry",
    });
  }

  /**
   * Resolves user-, prompt-, or subsystem-provided view text through the report
   * alias table. Ambiguous names return an explicit ambiguity result.
   */
  public resolveViewName(input: string, report: ViewNameRegistryReport): ViewNameResolution {
    const normalized = normalizeAlias(input);
    const matches = report.alias_table.filter((record) => record.alias === normalized);
    if (matches.length === 1) {
      return Object.freeze({
        input,
        status: "resolved",
        canonical_view_name: matches[0].canonical_view_name,
        sensor_ref: matches[0].sensor_ref,
      });
    }
    if (matches.length > 1) {
      return Object.freeze({
        input,
        status: "ambiguous",
        issue: makeIssue("error", "AliasAmbiguous", "$.view_alias", `View alias ${input} matches multiple declared cameras.`, "Use the canonical view name plus sensor ref for this observation."),
      });
    }
    return Object.freeze({
      input,
      status: "unknown",
      issue: makeIssue("error", "AliasInvalid", "$.view_alias", `View alias ${input} is not registered.`, "Use a canonical File 09 view name or a declared sensor alias."),
    });
  }

  /**
   * Resolves an accepted camera packet into the canonical view namespace.
   */
  public resolvePacketView(packet: CameraPacket, report: ViewNameRegistryReport): ViewNameResolution {
    const record = report.view_records.find((candidate) => candidate.sensor_ref === packet.sensor_id && candidate.camera_role === packet.camera_role);
    if (record === undefined) {
      return Object.freeze({
        input: packet.packet_id,
        status: "unknown",
        issue: makeIssue("error", "PacketViewUnknown", "$.camera_packet.sensor_id", `Camera packet ${packet.packet_id} does not match a registered canonical view.`, "Run camera ingestion and view naming against the same declared hardware manifest."),
      });
    }
    return Object.freeze({
      input: packet.packet_id,
      status: "resolved",
      canonical_view_name: record.canonical_view_name,
      sensor_ref: record.sensor_ref,
    });
  }
}

/**
 * Functional API for callers that do not need to retain a registry instance.
 */
export function buildViewNameRegistry(hardwareManifest: VirtualHardwareManifest, policy: ViewNameRegistryPolicy = {}): ViewNameRegistryReport {
  return new ViewNameRegistry(policy).buildViewNameRegistry(hardwareManifest, policy);
}

function buildViewRecord(
  camera: CameraSensorDescriptor,
  embodimentKind: EmbodimentKind,
  policy: Required<ViewNameRegistryPolicy>,
  issues: ValidationIssue[],
): CanonicalViewRecord | undefined {
  if (policy.reject_blocked_cognitive_routes && (camera.cognitive_route === "blocked" || camera.cognitive_route === "qa_only" || camera.cognitive_visibility === "hardware_internal_only" || camera.cognitive_visibility === "qa_only")) {
    issues.push(makeIssue("error", "CameraRouteBlocked", `$.sensor_inventory.${camera.sensor_id}`, `Camera ${camera.sensor_id} is not eligible for canonical prompt-facing view naming.`, "Expose only prompt-allowed or sensor-bus camera routes to perception view naming."));
    return undefined;
  }
  const canonical = canonicalNameForCamera(camera, policy);
  if (camera.sensor_class === "depth_camera" && canonical !== "depth_primary") {
    issues.push(makeIssue("warning", "DepthViewMismatch", `$.sensor_inventory.${camera.sensor_id}.sensor_class`, "Depth camera is mapped to an RGB-style canonical view.", "Use camera_role depth for primary depth evidence or document the RGB/depth pairing explicitly."));
  }
  if (canonical === "verification_aux" && !policy.verification_sensor_refs.includes(camera.sensor_id)) {
    issues.push(makeIssue("warning", "VerificationViewUndeclared", `$.sensor_inventory.${camera.sensor_id}`, "Verification view should be explicitly declared by policy.", "Add this camera to verification_sensor_refs when it is intended for success cross-checks."));
  }
  const aliases = aliasesForCamera(camera, canonical, policy);
  const shell = {
    canonical,
    sensor_id: camera.sensor_id,
    camera_role: camera.camera_role,
    mount_frame_ref: camera.mount_frame_ref,
    calibration_ref: camera.calibration_ref,
    aliases,
  };
  return Object.freeze({
    canonical_view_name: canonical,
    sensor_ref: camera.sensor_id,
    camera_role: camera.camera_role,
    sensor_class: camera.sensor_class,
    embodiment_kind: embodimentKind,
    display_name: camera.display_name,
    mount_frame_ref: camera.mount_frame_ref,
    body_ref: camera.body_ref,
    calibration_ref: camera.calibration_ref,
    intrinsics_ref: camera.intrinsics_ref,
    extrinsics_ref: camera.extrinsics_ref,
    resolution_px: camera.resolution,
    supports_depth: camera.supports_depth,
    cognitive_route: camera.cognitive_route,
    aliases: freezeArray(aliases),
    main_use: VIEW_USE[canonical],
    typical_source: typicalSourceForView(canonical, embodimentKind),
    prompt_safe_label: `${canonical} camera ${camera.sensor_id}`,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function canonicalNameForCamera(camera: CameraSensorDescriptor, policy: Required<ViewNameRegistryPolicy>): CanonicalViewName {
  if (policy.verification_sensor_refs.includes(camera.sensor_id)) {
    return "verification_aux";
  }
  if (camera.camera_role === "depth" || camera.sensor_class === "depth_camera") {
    return "depth_primary";
  }
  switch (camera.camera_role) {
    case "primary_egocentric":
      return "front_primary";
    case "left_auxiliary":
      return "left_aux";
    case "right_auxiliary":
      return "right_aux";
    case "wrist_or_gripper":
      return "wrist_or_mouth";
    case "rear_or_body":
      return "rear_body";
  }
}

function aliasesForCamera(camera: CameraSensorDescriptor, canonical: CanonicalViewName, policy: Required<ViewNameRegistryPolicy>): readonly string[] {
  const aliases = new Set<string>([canonical, camera.camera_role, canonical.replace(/_/g, "-"), camera.camera_role.replace(/_/g, "-")].map(normalizeAlias));
  if (policy.include_sensor_id_aliases) {
    aliases.add(normalizeAlias(camera.sensor_id));
  }
  if (policy.include_display_name_aliases) {
    aliases.add(normalizeAlias(camera.display_name));
  }
  aliases.add(normalizeAlias(camera.mount_frame_ref));
  return freezeArray([...aliases].filter((alias) => alias.length > 0).sort());
}

function buildAliasTable(
  viewRecords: readonly CanonicalViewRecord[],
  policy: Required<ViewNameRegistryPolicy>,
  issues: ValidationIssue[],
): readonly ViewAliasRecord[] {
  const aliasRows = viewRecords.flatMap((record) =>
    record.aliases.map((alias) => Object.freeze({
      alias,
      canonical_view_name: record.canonical_view_name,
      sensor_ref: record.sensor_ref,
    })),
  );
  const byAlias = groupBy(aliasRows, (record) => record.alias);
  for (const [alias, records] of byAlias) {
    const uniqueSensors = uniqueSorted(records.map((record) => record.sensor_ref));
    if (uniqueSensors.length > 1 && !policy.allow_multiple_sensors_per_view) {
      issues.push(makeIssue("error", "AliasAmbiguous", `$.aliases.${alias}`, `Alias ${alias} maps to multiple camera sensors.`, "Use distinct display names or disable ambiguous aliases for this embodiment."));
    }
  }
  return freezeArray(aliasRows.sort((a, b) => a.alias.localeCompare(b.alias) || a.sensor_ref.localeCompare(b.sensor_ref)));
}

function buildAmbiguities(
  viewRecords: readonly CanonicalViewRecord[],
  aliasTable: readonly ViewAliasRecord[],
  policy: Required<ViewNameRegistryPolicy>,
  issues: ValidationIssue[],
): readonly ViewNameAmbiguityRecord[] {
  const ambiguities: ViewNameAmbiguityRecord[] = [];
  const byCanonical = groupBy(viewRecords, (record) => record.canonical_view_name);
  for (const [canonical, records] of byCanonical) {
    const canonicalView = canonical as CanonicalViewName;
    if (records.length > 1 && !policy.allow_multiple_sensors_per_view) {
      issues.push(makeIssue("error", "CanonicalViewAmbiguous", `$.views.${canonicalView}`, `Canonical view ${canonicalView} has multiple declared camera sensors.`, "Split roles, declare one verification auxiliary, or allow multiple sensors explicitly."));
      ambiguities.push(makeAmbiguity(canonicalView, records));
    }
  }
  const byAlias = groupBy(aliasTable, (record) => record.alias);
  for (const [alias, records] of byAlias) {
    const uniqueSensors = uniqueSorted(records.map((record) => record.sensor_ref));
    if (uniqueSensors.length > 1) {
      ambiguities.push(Object.freeze({
        key: `alias:${alias}`,
        candidate_sensor_refs: freezeArray(uniqueSensors),
        candidate_view_names: freezeArray(uniqueSorted(records.map((record) => record.canonical_view_name)) as CanonicalViewName[]),
        recommended_action: "rename_alias",
      }));
    }
  }
  return freezeArray(deduplicateAmbiguities(ambiguities));
}

function makeAmbiguity(canonical: CanonicalViewName, records: readonly CanonicalViewRecord[]): ViewNameAmbiguityRecord {
  return Object.freeze({
    key: `canonical:${canonical}`,
    candidate_sensor_refs: freezeArray(uniqueSorted(records.map((record) => record.sensor_ref))),
    candidate_view_names: freezeArray([canonical]),
    recommended_action: "split_view_role",
  });
}

function deduplicateAmbiguities(records: readonly ViewNameAmbiguityRecord[]): readonly ViewNameAmbiguityRecord[] {
  const byKey = new Map<string, ViewNameAmbiguityRecord>();
  for (const record of records) {
    byKey.set(record.key, record);
  }
  return freezeArray([...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)));
}

function findMissingRequiredViews(records: readonly CanonicalViewRecord[], requiredViews: readonly CanonicalViewName[]): readonly CanonicalViewName[] {
  const present = new Set(records.map((record) => record.canonical_view_name));
  return freezeArray(uniqueSorted(requiredViews.filter((viewName) => !present.has(viewName))) as CanonicalViewName[]);
}

function typicalSourceForView(viewName: CanonicalViewName, embodimentKind: EmbodimentKind): string {
  if (embodimentKind === "quadruped") {
    switch (viewName) {
      case "front_primary":
        return "head or snout camera";
      case "left_aux":
        return "left head or shoulder camera";
      case "right_aux":
        return "right head or shoulder camera";
      case "wrist_or_mouth":
        return "mouth gripper, forelimb, or arm-mounted camera";
      case "rear_body":
        return "rear torso or body camera";
      case "depth_primary":
        return "declared depth sensor aligned to front or wrist";
      case "verification_aux":
        return "declared embodied camera reserved for verification";
    }
  }
  switch (viewName) {
    case "front_primary":
      return "head or eye-line camera";
    case "left_aux":
      return "left temple or shoulder camera";
    case "right_aux":
      return "right temple or shoulder camera";
    case "wrist_or_mouth":
      return "wrist or palm camera";
    case "rear_body":
      return "rear torso or waist camera";
    case "depth_primary":
      return "declared depth sensor aligned to head, chest, or wrist";
    case "verification_aux":
      return "declared embodied camera reserved for verification";
  }
}

function mergePolicy(base: Required<ViewNameRegistryPolicy>, override: ViewNameRegistryPolicy): Required<ViewNameRegistryPolicy> {
  return Object.freeze({
    required_views: freezeArray(override.required_views ?? base.required_views),
    verification_sensor_refs: freezeArray(override.verification_sensor_refs ?? base.verification_sensor_refs),
    allow_multiple_sensors_per_view: override.allow_multiple_sensors_per_view ?? base.allow_multiple_sensors_per_view,
    include_sensor_id_aliases: override.include_sensor_id_aliases ?? base.include_sensor_id_aliases,
    include_display_name_aliases: override.include_display_name_aliases ?? base.include_display_name_aliases,
    reject_blocked_cognitive_routes: override.reject_blocked_cognitive_routes ?? base.reject_blocked_cognitive_routes,
  });
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function compareViewRecords(a: CanonicalViewRecord, b: CanonicalViewRecord): number {
  return viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name) || a.sensor_ref.localeCompare(b.sensor_ref);
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

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [value]);
    } else {
      existing.push(value);
    }
  }
  return grouped;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function makeIssue(severity: ValidationSeverity, code: ViewNameIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
