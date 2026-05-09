/**
 * Rendering bridge for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.6, 3.10, 3.11, 3.17.3, 3.20, and 3.21.
 *
 * The bridge turns a physics-authoritative snapshot into deterministic camera
 * render packets for declared virtual cameras. It never lets render state
 * become authoritative over physics, blocks debug overlays for cognitive-bound
 * frames, rejects undeclared depth usage, reports render/physics timing
 * integrity, and produces camera evidence that contains only embodied sensor
 * fields after redaction.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { ObjectRuntimeState, PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "./world_manifest";

export const RENDERING_BRIDGE_SCHEMA_VERSION = "mebsuta.rendering_bridge.v1" as const;
const DEFAULT_HORIZONTAL_FOV_RAD = Math.PI / 2;
const DEFAULT_RENDER_BUDGET_MS = 16.667;
const DEFAULT_MAX_RENDER_PHYSICS_DELTA_S = 1 / 240;
const DEFAULT_MIN_VISIBLE_COVERAGE_PX = 4;
const DEFAULT_OBJECT_RADIUS_M = 0.05;
const CAMERA_FORWARD_AXIS_INDEX = 0;
const CAMERA_RIGHT_AXIS_INDEX = 1;
const CAMERA_UP_AXIS_INDEX = 2;
const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];

export type CameraViewName = "egocentric" | "wrist" | "side" | "rear" | "auxiliary" | "verification";
export type CameraHealthStatus = "nominal" | "degraded" | "blocked";
export type RenderPacketStatus = "rendered" | "degraded" | "blocked" | "dropped";
export type DepthMode = "none" | "declared_depth" | "rgb_aligned_depth";
export type DebugOverlayKind = "object_label" | "collision_wireframe" | "hidden_target_marker" | "segmentation_mask" | "contact_normal" | "qa_grid";
export type RenderSynchronizationStatus = "synchronized" | "within_tolerance" | "mismatch";
export type RenderValidationCode =
  | "UndeclaredCamera"
  | "CameraDescriptorInvalid"
  | "RenderPolicyInvalid"
  | "DebugOverlayDetected"
  | "DepthModeNotDeclared"
  | "RenderPhysicsMismatch"
  | "FrameDropped"
  | "SnapshotInvalid"
  | "SceneDescriptorInvalid";

export interface TimestampInterval {
  readonly start_s: number;
  readonly end_s: number;
}

export interface PixelResolution {
  readonly width_px: number;
  readonly height_px: number;
}

export interface CameraIntrinsics {
  readonly fx_px: number;
  readonly fy_px: number;
  readonly cx_px: number;
  readonly cy_px: number;
  readonly skew_px: number;
}

export interface CameraSensorDescriptor {
  readonly sensor_id: Ref;
  readonly view_name: CameraViewName;
  readonly camera_mount_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly mount_transform: Transform;
  readonly calibration_ref: Ref;
  readonly intrinsics_ref: Ref;
  readonly resolution_px: PixelResolution;
  readonly horizontal_fov_rad?: number;
  readonly vertical_fov_rad?: number;
  readonly near_clip_m: number;
  readonly far_clip_m: number;
  readonly depth_mode: DepthMode;
  readonly declared_for_cognitive_use: boolean;
  readonly nominal_capture_hz: number;
  readonly health_status?: CameraHealthStatus;
}

export interface RenderPolicy {
  readonly render_policy_ref: Ref;
  readonly lighting_profile_ref: Ref;
  readonly cognitive_bound: boolean;
  readonly include_depth: boolean;
  readonly requested_overlays: readonly DebugOverlayKind[];
  readonly allow_human_debug_overlay: boolean;
  readonly sample_time_s?: number;
  readonly max_render_physics_delta_s?: number;
  readonly frame_budget_ms?: number;
  readonly resolution_override_px?: PixelResolution;
  readonly min_visible_coverage_px?: number;
}

export interface RenderSceneObjectDescriptor {
  readonly object_ref: Ref;
  readonly visual_shape_ref: Ref;
  readonly visible_radius_m?: number;
  readonly bounding_box_m?: Vector3;
  readonly physically_visible: boolean;
  readonly render_priority?: number;
}

export interface CameraRenderBuffer {
  readonly buffer_ref: Ref;
  readonly buffer_kind: "rgb" | "depth";
  readonly width_px: number;
  readonly height_px: number;
  readonly channel_count: 3 | 1;
  readonly encoding: "deterministic_render_reference";
  readonly checksum: string;
}

export interface RenderedObjectProjection {
  readonly object_ref: Ref;
  readonly visual_shape_ref: Ref;
  readonly center_px: readonly [number, number];
  readonly depth_m: number;
  readonly apparent_radius_px: number;
  readonly visible_coverage_px: number;
  readonly clipped_by_frustum: boolean;
  readonly occlusion_rank: number;
}

export interface RenderSynchronizationRecord {
  readonly snapshot_ref: Ref;
  readonly physics_tick: number;
  readonly physics_timestamp_s: number;
  readonly render_sample_time_s: number;
  readonly render_physics_delta_ms: number;
  readonly status: RenderSynchronizationStatus;
  readonly determinism_hash: string;
}

export interface CameraRenderPacket {
  readonly schema_version: typeof RENDERING_BRIDGE_SCHEMA_VERSION;
  readonly camera_packet_id: Ref;
  readonly sensor_id: Ref;
  readonly view_name: CameraViewName;
  readonly timestamp_interval: TimestampInterval;
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly rgb_buffer: CameraRenderBuffer;
  readonly depth_buffer?: CameraRenderBuffer;
  readonly calibration_ref: Ref;
  readonly intrinsics: CameraIntrinsics;
  readonly render_policy_ref: Ref;
  readonly debug_overlay_present: boolean;
  readonly physics_snapshot_ref: Ref;
  readonly synchronization: RenderSynchronizationRecord;
  readonly packet_status: RenderPacketStatus;
  readonly health_status: CameraHealthStatus;
  readonly projected_object_count: number;
  readonly qa_render_metadata: {
    readonly camera_world_transform: Transform;
    readonly projected_objects: readonly RenderedObjectProjection[];
    readonly lighting_profile_ref: Ref;
    readonly hidden_truth_visibility: "runtime_qa_validator_only";
  };
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "sensor_evidence_after_hardware_firewall";
}

export interface RenderTimingIntegrityReport {
  readonly report_ref: Ref;
  readonly packet_ref: Ref;
  readonly render_physics_delta_ms: number;
  readonly status: RenderSynchronizationStatus;
  readonly frame_budget_ms: number;
  readonly estimated_render_cost_ms: number;
  readonly dropped: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveSafeCameraEvidence {
  readonly camera_packet_id: Ref;
  readonly sensor_id: Ref;
  readonly view_name: CameraViewName;
  readonly timestamp_interval: TimestampInterval;
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly calibration_ref: Ref;
  readonly intrinsics: CameraIntrinsics;
  readonly health_status: CameraHealthStatus;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export interface RenderingBridgeConfig {
  readonly declared_cameras: readonly CameraSensorDescriptor[];
  readonly scene_objects?: readonly RenderSceneObjectDescriptor[];
  readonly default_policy?: Partial<RenderPolicy>;
}

export class RenderingBridgeError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "RenderingBridgeError";
    this.issues = issues;
  }
}

/**
 * Produces architecture-level camera render packets from physics snapshots.
 *
 * A real WebGL or offline renderer can sit behind this contract later; this
 * implementation already performs the required camera math, frustum checks,
 * deterministic buffer references, synchronization validation, and firewall
 * decisions without exposing simulator object refs to cognitive-safe evidence.
 */
export class RenderingBridge {
  private readonly camerasById: ReadonlyMap<Ref, CameraSensorDescriptor>;
  private readonly sceneObjectsByRef: ReadonlyMap<Ref, RenderSceneObjectDescriptor>;
  private readonly defaultPolicy: RenderPolicy;

  public constructor(config: RenderingBridgeConfig) {
    const issues: ValidationIssue[] = [];
    const cameras = new Map<Ref, CameraSensorDescriptor>();
    for (const camera of config.declared_cameras) {
      validateCameraDescriptor(camera, issues, "$.declared_cameras");
      if (cameras.has(camera.sensor_id)) {
        issues.push(makeIssue("error", "CameraDescriptorInvalid", "$.declared_cameras.sensor_id", "Camera sensor ids must be unique.", "Rename or remove the duplicate declared camera."));
      }
      cameras.set(camera.sensor_id, freezeCamera(camera));
    }
    if (cameras.size === 0) {
      issues.push(makeIssue("error", "UndeclaredCamera", "$.declared_cameras", "At least one camera must be declared before rendering sensor frames.", "Register camera hardware descriptors from the virtual hardware spec."));
    }

    const sceneObjects = new Map<Ref, RenderSceneObjectDescriptor>();
    for (const object of config.scene_objects ?? []) {
      validateSceneObjectDescriptor(object, issues, "$.scene_objects");
      sceneObjects.set(object.object_ref, freezeSceneObject(object));
    }

    this.defaultPolicy = Object.freeze({
      render_policy_ref: config.default_policy?.render_policy_ref ?? "default_render_policy",
      lighting_profile_ref: config.default_policy?.lighting_profile_ref ?? "default_scenario_lighting",
      cognitive_bound: config.default_policy?.cognitive_bound ?? true,
      include_depth: config.default_policy?.include_depth ?? false,
      requested_overlays: freezeArray(config.default_policy?.requested_overlays ?? []),
      allow_human_debug_overlay: config.default_policy?.allow_human_debug_overlay ?? false,
      sample_time_s: config.default_policy?.sample_time_s,
      max_render_physics_delta_s: config.default_policy?.max_render_physics_delta_s ?? DEFAULT_MAX_RENDER_PHYSICS_DELTA_S,
      frame_budget_ms: config.default_policy?.frame_budget_ms ?? DEFAULT_RENDER_BUDGET_MS,
      resolution_override_px: config.default_policy?.resolution_override_px === undefined ? undefined : freezeResolution(config.default_policy.resolution_override_px),
      min_visible_coverage_px: config.default_policy?.min_visible_coverage_px ?? DEFAULT_MIN_VISIBLE_COVERAGE_PX,
    });
    validateRenderPolicy(this.defaultPolicy, issues, "$.default_policy");

    if (issues.some((issue) => issue.severity === "error")) {
      throw new RenderingBridgeError("Rendering bridge configuration failed validation.", issues);
    }

    this.camerasById = cameras;
    this.sceneObjectsByRef = sceneObjects;
  }

  /**
   * Renders one declared sensor frame from one coherent physics snapshot.
   *
   * The packet contains QA metadata for synchronization and debugging, but
   * `redactForCognition` must be used before anything is passed to Gemini or a
   * perception prompt. Blocking firewall violations raise `RenderingBridgeError`.
   */
  public renderDeclaredSensorFrame(
    worldSnapshot: PhysicsWorldSnapshot,
    cameraSensorDescriptor: CameraSensorDescriptor | Ref,
    renderPolicy: Partial<RenderPolicy> = {},
  ): CameraRenderPacket {
    validateSnapshot(worldSnapshot);
    const camera = typeof cameraSensorDescriptor === "string"
      ? this.requireCamera(cameraSensorDescriptor)
      : this.resolveDeclaredCamera(cameraSensorDescriptor);
    const policy = this.mergePolicy(renderPolicy);
    const issues: ValidationIssue[] = [];
    validateRenderPolicy(policy, issues, "$.render_policy");
    validateCameraDescriptor(camera, issues, "$.camera_sensor_descriptor");

    if (policy.cognitive_bound && !camera.declared_for_cognitive_use) {
      issues.push(makeIssue("error", "UndeclaredCamera", "$.camera_sensor_descriptor.declared_for_cognitive_use", "Camera is not declared for cognitive-bound evidence.", "Use a declared cognitive camera or route the frame to QA-only visualization."));
    }
    const debugOverlayPresent = policy.requested_overlays.length > 0;
    if (policy.cognitive_bound && debugOverlayPresent) {
      issues.push(makeIssue("error", "DebugOverlayDetected", "$.render_policy.requested_overlays", "Cognitive-bound camera frames must not contain debug overlays.", "Render a clean sensor frame or keep overlays in human/QA views only."));
    }
    if (!policy.cognitive_bound && debugOverlayPresent && !policy.allow_human_debug_overlay) {
      issues.push(makeIssue("error", "DebugOverlayDetected", "$.render_policy.allow_human_debug_overlay", "Debug overlays were requested but the policy does not permit them.", "Enable human debug overlay policy for QA-only views."));
    }
    if (policy.include_depth && camera.depth_mode === "none") {
      issues.push(makeIssue("error", "DepthModeNotDeclared", "$.render_policy.include_depth", "Depth output was requested for a camera without declared depth mode.", "Use a camera with declared depth or disable depth output."));
    }

    const sampleTimeS = policy.sample_time_s ?? worldSnapshot.timestamp_s;
    const sync = buildSynchronizationRecord(worldSnapshot, sampleTimeS, policy.max_render_physics_delta_s ?? DEFAULT_MAX_RENDER_PHYSICS_DELTA_S);
    if (sync.status === "mismatch") {
      issues.push(makeIssue("error", "RenderPhysicsMismatch", "$.render_policy.sample_time_s", "Render sample time does not match the physics snapshot interval.", "Recapture from the current coherent physics snapshot."));
    }

    const resolution = policy.resolution_override_px ?? camera.resolution_px;
    const intrinsics = computeIntrinsics(camera, resolution);
    const cameraWorldTransform = resolveCameraWorldTransform(worldSnapshot, camera);
    const projectedObjects = this.projectVisibleObjects(worldSnapshot, camera, policy, resolution, intrinsics, cameraWorldTransform);
    const estimatedRenderCostMs = estimateRenderCostMs(resolution, projectedObjects.length, policy.include_depth);
    const frameBudgetMs = policy.frame_budget_ms ?? DEFAULT_RENDER_BUDGET_MS;
    if (estimatedRenderCostMs > frameBudgetMs) {
      issues.push(makeIssue("warning", "FrameDropped", "$.render_policy.frame_budget_ms", "Estimated render cost exceeds the frame budget.", "Lower resolution, reduce scene complexity, or treat this packet as degraded."));
    }

    const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
    if (hasBlockingIssue) {
      throw new RenderingBridgeError("Declared camera render failed firewall or synchronization validation.", freezeArray(issues));
    }

    const timestampInterval = buildTimestampInterval(sampleTimeS, camera.nominal_capture_hz);
    const rgbBuffer = buildBuffer("rgb", camera, resolution, worldSnapshot, policy, projectedObjects, sync);
    const depthBuffer = policy.include_depth
      ? buildBuffer("depth", camera, resolution, worldSnapshot, policy, projectedObjects, sync)
      : undefined;
    const packetStatus: RenderPacketStatus = issues.some((issue) => issue.code === "FrameDropped")
      ? "dropped"
      : sync.status === "within_tolerance"
        ? "degraded"
        : "rendered";
    const packetBase = {
      schema_version: RENDERING_BRIDGE_SCHEMA_VERSION,
      camera_packet_id: `camera_packet_${camera.sensor_id}_${worldSnapshot.physics_tick}_${computeDeterminismHash([camera.sensor_id, sampleTimeS, rgbBuffer.checksum]).slice(0, 8)}`,
      sensor_id: camera.sensor_id,
      view_name: camera.view_name,
      timestamp_interval: timestampInterval,
      image_ref: rgbBuffer.buffer_ref,
      depth_ref: depthBuffer?.buffer_ref,
      rgb_buffer: rgbBuffer,
      depth_buffer: depthBuffer,
      calibration_ref: camera.calibration_ref,
      intrinsics,
      render_policy_ref: policy.render_policy_ref,
      debug_overlay_present: debugOverlayPresent,
      physics_snapshot_ref: worldSnapshot.snapshot_ref,
      synchronization: sync,
      packet_status: packetStatus,
      health_status: packetStatus === "dropped" ? "degraded" as const : camera.health_status ?? "nominal" as const,
      projected_object_count: projectedObjects.length,
      qa_render_metadata: Object.freeze({
        camera_world_transform: cameraWorldTransform,
        projected_objects: freezeArray(projectedObjects),
        lighting_profile_ref: policy.lighting_profile_ref,
        hidden_truth_visibility: "runtime_qa_validator_only" as const,
      }),
      issues: freezeArray(issues),
      cognitive_visibility: "sensor_evidence_after_hardware_firewall" as const,
    };

    return Object.freeze({
      ...packetBase,
      determinism_hash: computeDeterminismHash(packetBase),
    });
  }

  /**
   * Reports whether a rendered packet remains aligned with physics timing.
   */
  public reportTimingIntegrity(packet: CameraRenderPacket): RenderTimingIntegrityReport {
    const estimatedRenderCostMs = estimateRenderCostMs(
      { width_px: packet.rgb_buffer.width_px, height_px: packet.rgb_buffer.height_px },
      packet.projected_object_count,
      packet.depth_buffer !== undefined,
    );
    const frameBudgetMs = this.defaultPolicy.frame_budget_ms ?? DEFAULT_RENDER_BUDGET_MS;
    const issues = packet.issues.filter((issue) => issue.code === "RenderPhysicsMismatch" || issue.code === "FrameDropped");
    const reportBase = {
      report_ref: `render_timing_${packet.camera_packet_id}`,
      packet_ref: packet.camera_packet_id,
      render_physics_delta_ms: packet.synchronization.render_physics_delta_ms,
      status: packet.synchronization.status,
      frame_budget_ms: frameBudgetMs,
      estimated_render_cost_ms: estimatedRenderCostMs,
      dropped: packet.packet_status === "dropped" || estimatedRenderCostMs > frameBudgetMs,
      issue_count: issues.length,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  /**
   * Strips simulator truth from a camera packet before prompt or perception use.
   */
  public redactForCognition(packet: CameraRenderPacket): CognitiveSafeCameraEvidence {
    if (packet.debug_overlay_present || packet.packet_status === "blocked") {
      throw new RenderingBridgeError("Camera packet is not safe for cognitive use.", [
        makeIssue("error", "DebugOverlayDetected", "$.debug_overlay_present", "Overlayed or blocked camera packets cannot be used as cognitive evidence.", "Recapture a clean declared sensor frame."),
      ]);
    }
    return Object.freeze({
      camera_packet_id: packet.camera_packet_id,
      sensor_id: packet.sensor_id,
      view_name: packet.view_name,
      timestamp_interval: packet.timestamp_interval,
      image_ref: packet.image_ref,
      depth_ref: packet.depth_ref,
      calibration_ref: packet.calibration_ref,
      intrinsics: packet.intrinsics,
      health_status: packet.health_status,
      prompt_safe_summary: buildPromptSafeSummary(packet),
      hidden_fields_removed: freezeArray([
        "render_policy_ref",
        "physics_snapshot_ref",
        "synchronization.snapshot_ref",
        "qa_render_metadata.camera_world_transform",
        "qa_render_metadata.projected_objects",
        "object_refs",
        "visual_shape_refs",
        "lighting_profile_ref",
        "determinism_hash",
      ]),
    });
  }

  private requireCamera(sensorId: Ref): CameraSensorDescriptor {
    const camera = this.camerasById.get(sensorId);
    if (camera === undefined) {
      throw new RenderingBridgeError(`Camera ${sensorId} is not declared.`, [
        makeIssue("error", "UndeclaredCamera", "$.sensor_id", "Camera must be declared hardware before rendering.", "Register the camera descriptor in RenderingBridgeConfig."),
      ]);
    }
    return camera;
  }

  private resolveDeclaredCamera(candidate: CameraSensorDescriptor): CameraSensorDescriptor {
    const declared = this.requireCamera(candidate.sensor_id);
    if (computeDeterminismHash(declared) !== computeDeterminismHash(freezeCamera(candidate))) {
      throw new RenderingBridgeError(`Camera ${candidate.sensor_id} descriptor differs from declared hardware.`, [
        makeIssue("error", "CameraDescriptorInvalid", "$.camera_sensor_descriptor", "Runtime camera descriptor must match the declared hardware descriptor.", "Use the registered camera descriptor or update the hardware manifest."),
      ]);
    }
    return declared;
  }

  private mergePolicy(override: Partial<RenderPolicy>): RenderPolicy {
    return Object.freeze({
      ...this.defaultPolicy,
      ...override,
      render_policy_ref: override.render_policy_ref ?? this.defaultPolicy.render_policy_ref,
      lighting_profile_ref: override.lighting_profile_ref ?? this.defaultPolicy.lighting_profile_ref,
      cognitive_bound: override.cognitive_bound ?? this.defaultPolicy.cognitive_bound,
      include_depth: override.include_depth ?? this.defaultPolicy.include_depth,
      requested_overlays: freezeArray(override.requested_overlays ?? this.defaultPolicy.requested_overlays),
      allow_human_debug_overlay: override.allow_human_debug_overlay ?? this.defaultPolicy.allow_human_debug_overlay,
      resolution_override_px: override.resolution_override_px === undefined ? this.defaultPolicy.resolution_override_px : freezeResolution(override.resolution_override_px),
      max_render_physics_delta_s: override.max_render_physics_delta_s ?? this.defaultPolicy.max_render_physics_delta_s,
      frame_budget_ms: override.frame_budget_ms ?? this.defaultPolicy.frame_budget_ms,
      min_visible_coverage_px: override.min_visible_coverage_px ?? this.defaultPolicy.min_visible_coverage_px,
    });
  }

  private projectVisibleObjects(
    worldSnapshot: PhysicsWorldSnapshot,
    camera: CameraSensorDescriptor,
    policy: RenderPolicy,
    resolution: PixelResolution,
    intrinsics: CameraIntrinsics,
    cameraWorldTransform: Transform,
  ): readonly RenderedObjectProjection[] {
    const projections: RenderedObjectProjection[] = [];
    const cameraInverse = invertRigidTransform(cameraWorldTransform);
    const minCoverage = policy.min_visible_coverage_px ?? DEFAULT_MIN_VISIBLE_COVERAGE_PX;
    for (const objectState of worldSnapshot.object_states) {
      const descriptor = this.sceneObjectsByRef.get(objectState.object_ref) ?? fallbackSceneDescriptor(objectState);
      if (!descriptor.physically_visible) {
        continue;
      }
      const centerCamera = transformPoint(cameraInverse, objectState.transform.position_m);
      const depth = centerCamera[CAMERA_FORWARD_AXIS_INDEX];
      const radius = visibleRadiusOf(descriptor);
      const projection = projectSphere(centerCamera, radius, descriptor, camera, resolution, intrinsics);
      if (projection === undefined) {
        continue;
      }
      if (depth < camera.near_clip_m || depth > camera.far_clip_m || projection.visible_coverage_px < minCoverage) {
        continue;
      }
      projections.push(projection);
    }
    return freezeArray(projections.sort(compareProjections).map((projection, index) => Object.freeze({
      ...projection,
      occlusion_rank: index,
    })));
  }
}

export function renderDeclaredSensorFrame(
  worldSnapshot: PhysicsWorldSnapshot,
  cameraSensorDescriptor: CameraSensorDescriptor,
  renderPolicy: Partial<RenderPolicy> = {},
  sceneObjects: readonly RenderSceneObjectDescriptor[] = [],
): CameraRenderPacket {
  return new RenderingBridge({ declared_cameras: [cameraSensorDescriptor], scene_objects: sceneObjects }).renderDeclaredSensorFrame(worldSnapshot, cameraSensorDescriptor.sensor_id, renderPolicy);
}

function buildSynchronizationRecord(worldSnapshot: PhysicsWorldSnapshot, sampleTimeS: number, toleranceS: number): RenderSynchronizationRecord {
  const deltaS = Math.abs(sampleTimeS - worldSnapshot.timestamp_s);
  const status: RenderSynchronizationStatus = deltaS <= toleranceS * 0.25
    ? "synchronized"
    : deltaS <= toleranceS
      ? "within_tolerance"
      : "mismatch";
  const recordBase = {
    snapshot_ref: worldSnapshot.snapshot_ref,
    physics_tick: worldSnapshot.physics_tick,
    physics_timestamp_s: worldSnapshot.timestamp_s,
    render_sample_time_s: sampleTimeS,
    render_physics_delta_ms: secondsToMilliseconds(deltaS),
    status,
  };
  return Object.freeze({
    ...recordBase,
    determinism_hash: computeDeterminismHash(recordBase),
  });
}

function buildTimestampInterval(sampleTimeS: number, captureHz: number): TimestampInterval {
  const halfExposureS = 0.5 / captureHz;
  return Object.freeze({
    start_s: Math.max(0, sampleTimeS - halfExposureS),
    end_s: sampleTimeS + halfExposureS,
  });
}

function buildBuffer(
  kind: "rgb" | "depth",
  camera: CameraSensorDescriptor,
  resolution: PixelResolution,
  snapshot: PhysicsWorldSnapshot,
  policy: RenderPolicy,
  projections: readonly RenderedObjectProjection[],
  sync: RenderSynchronizationRecord,
): CameraRenderBuffer {
  const checksum = computeDeterminismHash({
    kind,
    sensor_id: camera.sensor_id,
    snapshot_ref: snapshot.snapshot_ref,
    physics_tick: snapshot.physics_tick,
    resolution,
    policy_ref: policy.render_policy_ref,
    projection_fingerprint: projections.map((projection) => ({
      object_ref: projection.object_ref,
      center_px: projection.center_px,
      depth_m: round6(projection.depth_m),
      apparent_radius_px: round6(projection.apparent_radius_px),
    })),
    sync_hash: sync.determinism_hash,
  });
  return Object.freeze({
    buffer_ref: `${kind}_buffer_${camera.sensor_id}_${snapshot.physics_tick}_${checksum}`,
    buffer_kind: kind,
    width_px: resolution.width_px,
    height_px: resolution.height_px,
    channel_count: kind === "rgb" ? 3 as const : 1 as const,
    encoding: "deterministic_render_reference" as const,
    checksum,
  });
}

function computeIntrinsics(camera: CameraSensorDescriptor, resolution: PixelResolution): CameraIntrinsics {
  const horizontalFov = camera.horizontal_fov_rad ?? DEFAULT_HORIZONTAL_FOV_RAD;
  const verticalFov = camera.vertical_fov_rad ?? (2 * Math.atan(Math.tan(horizontalFov / 2) * resolution.height_px / resolution.width_px));
  const fx = resolution.width_px / (2 * Math.tan(horizontalFov / 2));
  const fy = resolution.height_px / (2 * Math.tan(verticalFov / 2));
  return Object.freeze({
    fx_px: round6(fx),
    fy_px: round6(fy),
    cx_px: round6((resolution.width_px - 1) / 2),
    cy_px: round6((resolution.height_px - 1) / 2),
    skew_px: 0,
  });
}

function resolveCameraWorldTransform(snapshot: PhysicsWorldSnapshot, camera: CameraSensorDescriptor): Transform {
  if (camera.mount_frame_ref === "W" || camera.mount_frame_ref === snapshot.world_ref) {
    return freezeTransform({
      frame_ref: "W",
      position_m: camera.mount_transform.position_m,
      orientation_xyzw: camera.mount_transform.orientation_xyzw,
    });
  }
  const mountObject = snapshot.object_states.find((object) => object.object_ref === camera.mount_frame_ref);
  if (mountObject === undefined) {
    throw new RenderingBridgeError(`Camera mount frame ${camera.mount_frame_ref} is not present in snapshot ${snapshot.snapshot_ref}.`, [
      makeIssue("error", "UndeclaredCamera", "$.camera_sensor_descriptor.mount_frame_ref", "Camera mount frame must be world or a body/object present in the physics snapshot.", "Declare the mount frame in the embodiment sensor table and ensure it is represented in snapshots."),
    ]);
  }
  return composeTransforms(mountObject.transform, camera.mount_transform, "W");
}

function projectSphere(
  centerCamera: Vector3,
  radiusM: number,
  descriptor: RenderSceneObjectDescriptor,
  camera: CameraSensorDescriptor,
  resolution: PixelResolution,
  intrinsics: CameraIntrinsics,
): RenderedObjectProjection | undefined {
  const depth = centerCamera[CAMERA_FORWARD_AXIS_INDEX];
  if (!Number.isFinite(depth) || depth <= 1e-9) {
    return undefined;
  }
  const xPx = intrinsics.fx_px * (centerCamera[CAMERA_RIGHT_AXIS_INDEX] / depth) + intrinsics.cx_px;
  const yPx = intrinsics.cy_px - intrinsics.fy_px * (centerCamera[CAMERA_UP_AXIS_INDEX] / depth);
  const apparentRadiusPx = Math.max(intrinsics.fx_px, intrinsics.fy_px) * radiusM / depth;
  const clipped = xPx + apparentRadiusPx < 0
    || xPx - apparentRadiusPx >= resolution.width_px
    || yPx + apparentRadiusPx < 0
    || yPx - apparentRadiusPx >= resolution.height_px
    || depth - radiusM > camera.far_clip_m
    || depth + radiusM < camera.near_clip_m;
  if (clipped) {
    return undefined;
  }
  const left = clamp(xPx - apparentRadiusPx, 0, resolution.width_px - 1);
  const right = clamp(xPx + apparentRadiusPx, 0, resolution.width_px - 1);
  const top = clamp(yPx - apparentRadiusPx, 0, resolution.height_px - 1);
  const bottom = clamp(yPx + apparentRadiusPx, 0, resolution.height_px - 1);
  const coverage = Math.max(0, right - left) * Math.max(0, bottom - top);
  return Object.freeze({
    object_ref: descriptor.object_ref,
    visual_shape_ref: descriptor.visual_shape_ref,
    center_px: Object.freeze([round3(xPx), round3(yPx)]) as readonly [number, number],
    depth_m: round6(depth),
    apparent_radius_px: round3(apparentRadiusPx),
    visible_coverage_px: round3(coverage),
    clipped_by_frustum: false,
    occlusion_rank: 0,
  });
}

function fallbackSceneDescriptor(objectState: ObjectRuntimeState): RenderSceneObjectDescriptor {
  return Object.freeze({
    object_ref: objectState.object_ref,
    visual_shape_ref: `runtime_visual_${objectState.object_ref}`,
    visible_radius_m: DEFAULT_OBJECT_RADIUS_M,
    physically_visible: true,
    render_priority: 0,
  });
}

function visibleRadiusOf(descriptor: RenderSceneObjectDescriptor): number {
  if (descriptor.visible_radius_m !== undefined) {
    return descriptor.visible_radius_m;
  }
  if (descriptor.bounding_box_m !== undefined) {
    return 0.5 * vectorNorm(descriptor.bounding_box_m);
  }
  return DEFAULT_OBJECT_RADIUS_M;
}

function compareProjections(a: RenderedObjectProjection, b: RenderedObjectProjection): number {
  return a.depth_m - b.depth_m
    || (b.visible_coverage_px - a.visible_coverage_px)
    || a.object_ref.localeCompare(b.object_ref);
}

function estimateRenderCostMs(resolution: PixelResolution, projectedObjectCount: number, includeDepth: boolean): number {
  const megapixels = (resolution.width_px * resolution.height_px) / 1_000_000;
  const baseCost = 1.2 + megapixels * 2.8;
  const objectCost = projectedObjectCount * 0.18;
  const depthCost = includeDepth ? megapixels * 1.6 + 0.6 : 0;
  return round3(baseCost + objectCost + depthCost);
}

function buildPromptSafeSummary(packet: CameraRenderPacket): string {
  if (packet.packet_status === "dropped") {
    return "A declared camera frame was captured but render timing was degraded; re-observation may improve confidence.";
  }
  if (packet.health_status === "degraded") {
    return "A declared camera frame is available with degraded camera health.";
  }
  return "A synchronized declared camera frame is available as embodied visual evidence.";
}

function validateSnapshot(snapshot: PhysicsWorldSnapshot): void {
  const issues: ValidationIssue[] = [];
  validateRef(snapshot.snapshot_ref, issues, "$.snapshot_ref", "SnapshotInvalid");
  validateRef(snapshot.world_ref, issues, "$.world_ref", "SnapshotInvalid");
  if (!Number.isInteger(snapshot.physics_tick) || snapshot.physics_tick < 0) {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_tick", "Physics tick must be a nonnegative integer.", "Use snapshots emitted by SimulationWorldService."));
  }
  validateNonNegativeFinite(snapshot.timestamp_s, issues, "$.timestamp_s", "SnapshotInvalid");
  for (let index = 0; index < snapshot.object_states.length; index += 1) {
    const object = snapshot.object_states[index];
    validateRef(object.object_ref, issues, `$.object_states[${index}].object_ref`, "SnapshotInvalid");
    validateTransform(object.transform, issues, `$.object_states[${index}].transform`, "SnapshotInvalid");
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new RenderingBridgeError("Physics snapshot is invalid for rendering.", issues);
  }
}

function validateCameraDescriptor(camera: CameraSensorDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(camera.sensor_id, issues, `${path}.sensor_id`, "CameraDescriptorInvalid");
  validateRef(camera.camera_mount_ref, issues, `${path}.camera_mount_ref`, "CameraDescriptorInvalid");
  validateRef(camera.mount_frame_ref, issues, `${path}.mount_frame_ref`, "CameraDescriptorInvalid");
  validateTransform(camera.mount_transform, issues, `${path}.mount_transform`, "CameraDescriptorInvalid");
  validateRef(camera.calibration_ref, issues, `${path}.calibration_ref`, "CameraDescriptorInvalid");
  validateRef(camera.intrinsics_ref, issues, `${path}.intrinsics_ref`, "CameraDescriptorInvalid");
  validateResolution(camera.resolution_px, issues, `${path}.resolution_px`, "CameraDescriptorInvalid");
  validatePositiveFinite(camera.near_clip_m, issues, `${path}.near_clip_m`, "CameraDescriptorInvalid");
  validatePositiveFinite(camera.far_clip_m, issues, `${path}.far_clip_m`, "CameraDescriptorInvalid");
  validatePositiveFinite(camera.nominal_capture_hz, issues, `${path}.nominal_capture_hz`, "CameraDescriptorInvalid");
  if (camera.near_clip_m >= camera.far_clip_m) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.far_clip_m`, "Camera far clip must exceed near clip.", "Use near_clip_m < far_clip_m."));
  }
  if (camera.horizontal_fov_rad !== undefined) {
    validateFov(camera.horizontal_fov_rad, issues, `${path}.horizontal_fov_rad`);
  }
  if (camera.vertical_fov_rad !== undefined) {
    validateFov(camera.vertical_fov_rad, issues, `${path}.vertical_fov_rad`);
  }
  if (!["egocentric", "wrist", "side", "rear", "auxiliary", "verification"].includes(camera.view_name)) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.view_name`, "Camera view_name is unsupported.", "Use a declared architecture camera role."));
  }
  if (!["none", "declared_depth", "rgb_aligned_depth"].includes(camera.depth_mode)) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.depth_mode`, "Depth mode is unsupported.", "Use none, declared_depth, or rgb_aligned_depth."));
  }
}

function validateRenderPolicy(policy: RenderPolicy, issues: ValidationIssue[], path: string): void {
  validateRef(policy.render_policy_ref, issues, `${path}.render_policy_ref`, "RenderPolicyInvalid");
  validateRef(policy.lighting_profile_ref, issues, `${path}.lighting_profile_ref`, "RenderPolicyInvalid");
  if (policy.sample_time_s !== undefined) {
    validateNonNegativeFinite(policy.sample_time_s, issues, `${path}.sample_time_s`, "RenderPolicyInvalid");
  }
  if (policy.max_render_physics_delta_s !== undefined) {
    validateNonNegativeFinite(policy.max_render_physics_delta_s, issues, `${path}.max_render_physics_delta_s`, "RenderPolicyInvalid");
  }
  if (policy.frame_budget_ms !== undefined) {
    validatePositiveFinite(policy.frame_budget_ms, issues, `${path}.frame_budget_ms`, "RenderPolicyInvalid");
  }
  if (policy.min_visible_coverage_px !== undefined) {
    validateNonNegativeFinite(policy.min_visible_coverage_px, issues, `${path}.min_visible_coverage_px`, "RenderPolicyInvalid");
  }
  if (policy.resolution_override_px !== undefined) {
    validateResolution(policy.resolution_override_px, issues, `${path}.resolution_override_px`, "RenderPolicyInvalid");
  }
}

function validateSceneObjectDescriptor(object: RenderSceneObjectDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(object.object_ref, issues, `${path}.object_ref`, "SceneDescriptorInvalid");
  validateRef(object.visual_shape_ref, issues, `${path}.visual_shape_ref`, "SceneDescriptorInvalid");
  if (object.visible_radius_m !== undefined) {
    validatePositiveFinite(object.visible_radius_m, issues, `${path}.visible_radius_m`, "SceneDescriptorInvalid");
  }
  if (object.bounding_box_m !== undefined) {
    validateVector3(object.bounding_box_m, issues, `${path}.bounding_box_m`, "SceneDescriptorInvalid");
    if (object.bounding_box_m.some((value) => value <= 0)) {
      issues.push(makeIssue("error", "SceneDescriptorInvalid", `${path}.bounding_box_m`, "Bounding box dimensions must be positive.", "Use positive meter dimensions for visual bounds."));
    }
  }
}

function validateTransform(transform: Transform, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, code);
  validateVector3(transform.position_m, issues, `${path}.position_m`, code);
  if (!Array.isArray(transform.orientation_xyzw) || transform.orientation_xyzw.length !== 4 || transform.orientation_xyzw.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, `${path}.orientation_xyzw`, "Quaternion must contain exactly four finite values.", "Use normalized [x, y, z, w]."));
    return;
  }
  const norm = Math.sqrt(transform.orientation_xyzw.reduce((sum, component) => sum + component * component, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    issues.push(makeIssue("error", code, `${path}.orientation_xyzw`, "Quaternion must be unit length.", "Normalize the camera or snapshot orientation quaternion."));
  }
}

function validateResolution(resolution: PixelResolution, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  if (!Number.isInteger(resolution.width_px) || resolution.width_px <= 0 || !Number.isInteger(resolution.height_px) || resolution.height_px <= 0) {
    issues.push(makeIssue("error", code, path, "Resolution must contain positive integer width and height.", "Use positive pixel dimensions."));
  }
}

function validateFov(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= Math.PI) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", path, "Field of view must be finite and in radians between 0 and pi.", "Use a physically plausible camera FOV."));
  }
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque trace ref without spaces."));
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite numeric components.", "Use [x, y, z] in canonical units."));
  }
}

function validatePositiveFinite(value: number, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", code, path, "Value must be positive and finite.", "Provide a calibrated positive finite value."));
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: RenderValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", code, path, "Value must be nonnegative and finite.", "Provide a calibrated nonnegative finite value."));
  }
}

function makeIssue(severity: ValidationSeverity, code: RenderValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function composeTransforms(parent: Transform, child: Transform, frameRef: Ref): Transform {
  const rotatedPosition = rotateVector(parent.orientation_xyzw, child.position_m);
  return freezeTransform({
    frame_ref: frameRef,
    position_m: addVector3(parent.position_m, rotatedPosition),
    orientation_xyzw: normalizeQuaternion(multiplyQuaternions(parent.orientation_xyzw, child.orientation_xyzw)),
  });
}

function invertRigidTransform(transform: Transform): Transform {
  const inverseOrientation = quaternionConjugate(transform.orientation_xyzw);
  const inversePosition = rotateVector(inverseOrientation, scaleVector3(transform.position_m, -1));
  return freezeTransform({
    frame_ref: transform.frame_ref,
    position_m: inversePosition,
    orientation_xyzw: inverseOrientation,
  });
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  return addVector3(transform.position_m, rotateVector(transform.orientation_xyzw, point));
}

function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const qv: Quaternion = [v[0], v[1], v[2], 0];
  const rotated = multiplyQuaternions(multiplyQuaternions(q, qv), quaternionConjugate(q));
  return [rotated[0], rotated[1], rotated[2]];
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quaternionConjugate(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const norm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-12) {
    return IDENTITY_QUATERNION;
  }
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVector3(value: Vector3, scalar: number): Vector3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function secondsToMilliseconds(seconds: number): number {
  return round3(seconds * 1000);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeCamera(camera: CameraSensorDescriptor): CameraSensorDescriptor {
  return Object.freeze({
    ...camera,
    mount_transform: freezeTransform(camera.mount_transform),
    resolution_px: freezeResolution(camera.resolution_px),
  });
}

function freezeSceneObject(object: RenderSceneObjectDescriptor): RenderSceneObjectDescriptor {
  return Object.freeze({
    ...object,
    bounding_box_m: object.bounding_box_m === undefined ? undefined : freezeVector3(object.bounding_box_m),
  });
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: Object.freeze([transform.orientation_xyzw[0], transform.orientation_xyzw[1], transform.orientation_xyzw[2], transform.orientation_xyzw[3]]) as unknown as Quaternion,
  });
}

function freezeVector3(value: Vector3): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as unknown as Vector3;
}

function freezeResolution(resolution: PixelResolution): PixelResolution {
  return Object.freeze({
    width_px: resolution.width_px,
    height_px: resolution.height_px,
  });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
