/**
 * Simulation world service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.7, 3.10, 3.17, 3.18, 3.19, and 3.20.
 *
 * This service is the first executable owner of physics-authoritative world
 * state. It does not expose simulator truth to Gemini Robotics-ER 1.6; callers
 * must use `buildCognitiveSafeWorldStatus` for model-facing summaries. Internal
 * snapshots may contain exact object transforms, object refs, material refs,
 * replay refs, and determinism hashes, and are therefore QA/validator/runtime
 * only.
 */

import { MaterialProfileRegistry } from "./material_profile_registry";
import { ObjectPhysicsCatalog } from "./object_physics_catalog";
import { computeDeterminismHash, validateLifecycleTransition, validateWorldManifest, validateWorldManifestBundle } from "./world_manifest";
import type {
  DisturbanceSchedule,
  EmbodimentManifestRef,
  MaterialProfile,
  ObjectPhysicsDescriptor,
  Ref,
  ReplaySeed,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
  WorldLifecycleState,
  WorldManifest,
  WorldManifestBundle,
} from "./world_manifest";

export const SIMULATION_WORLD_SERVICE_SCHEMA_VERSION = "mebsuta.simulation_world_service.v1" as const;
const ZERO_VECTOR: Vector3 = [0, 0, 0];

export type PhysicsAuthority = "internal_deterministic_reference";
export type WorldEventKind =
  | "WorldManifestAccepted"
  | "WorldInitialized"
  | "WorldPaused"
  | "WorldResumed"
  | "WorldReplayEntered"
  | "WorldShutdown"
  | "ObjectStateUpdated"
  | "SnapshotCreated";

export interface ObjectRuntimeState {
  readonly object_ref: Ref;
  readonly transform: Transform;
  readonly linear_velocity_m_per_s: Vector3;
  readonly angular_velocity_rad_per_s: Vector3;
  readonly mass_kg: number;
  readonly material_profile_ref: Ref;
  readonly movability_policy: ObjectPhysicsDescriptor["movability_policy"];
  readonly hidden_truth_visibility: "runtime_internal_only";
}

export interface WorldEvent {
  readonly event_id: Ref;
  readonly event_kind: WorldEventKind;
  readonly from_state?: WorldLifecycleState;
  readonly to_state?: WorldLifecycleState;
  readonly timestamp_s: number;
  readonly detail: string;
  readonly determinism_hash: string;
}

export interface PhysicsTimingConfiguration {
  readonly physics_hz: number;
  readonly fixed_dt_s: number;
  readonly max_step_jitter_s: number;
  readonly snapshot_clock_s: number;
}

export interface PhysicsWorldInitializationReport {
  readonly ok: boolean;
  readonly world_ref: Ref;
  readonly lifecycle_state: WorldLifecycleState;
  readonly object_count: number;
  readonly material_count: number;
  readonly dynamic_object_count: number;
  readonly fixed_object_count: number;
  readonly timing: PhysicsTimingConfiguration;
  readonly replay_seed_ref?: Ref;
  readonly disturbance_schedule_ref?: Ref;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PhysicsWorldSnapshot {
  readonly snapshot_ref: Ref;
  readonly world_ref: Ref;
  readonly lifecycle_state: WorldLifecycleState;
  readonly timestamp_s: number;
  readonly physics_tick: number;
  readonly authority: PhysicsAuthority;
  readonly object_states: readonly ObjectRuntimeState[];
  readonly material_profile_refs: readonly Ref[];
  readonly event_log_tail: readonly WorldEvent[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "forbidden_to_cognition";
}

export interface CognitiveSafeWorldStatus {
  readonly lifecycle_state: WorldLifecycleState;
  readonly physical_reality_summary: "bounded_3d_world_available_through_declared_sensors";
  readonly object_access: "objects_available_only_as_sensor_evidence";
  readonly timing_summary: "fixed_step_physics_internal";
  readonly hidden_fields_removed: readonly string[];
}

export interface SimulationWorldServiceConfig {
  readonly manifest: WorldManifest;
  readonly material_registry: MaterialProfileRegistry;
  readonly object_catalog: ObjectPhysicsCatalog;
  readonly embodiment: EmbodimentManifestRef;
  readonly disturbance_schedule?: DisturbanceSchedule;
  readonly replay_seed?: ReplaySeed;
  readonly max_event_log_entries?: number;
}

export class SimulationWorldServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SimulationWorldServiceError";
    this.issues = issues;
  }
}

export class SimulationWorldService {
  private lifecycleState: WorldLifecycleState = "WorldUninitialized";
  private readonly objectStates: Map<Ref, ObjectRuntimeState> = new Map();
  private readonly eventLog: WorldEvent[] = [];
  private physicsTick = 0;
  private clockS = 0;

  public constructor(private readonly config: SimulationWorldServiceConfig) {}

  public get state(): WorldLifecycleState {
    return this.lifecycleState;
  }

  public initialize(): PhysicsWorldInitializationReport {
    this.assertTransition("WorldLoading");
    this.lifecycleState = "WorldLoading";
    this.recordEvent("WorldManifestAccepted", "World manifest accepted for runtime initialization.", "WorldUninitialized", "WorldLoading");

    const issues = this.validateInitializationClosure();
    if (issues.some((issue) => issue.severity === "error")) {
      this.lifecycleState = "WorldUninitialized";
      throw new SimulationWorldServiceError("Simulation world initialization failed.", issues);
    }

    this.objectStates.clear();
    for (const entry of this.config.object_catalog.list()) {
      this.config.object_catalog.assertWithinWorldBounds(entry.descriptor.object_ref, this.config.manifest.world_bounds);
      const massProperties = this.config.object_catalog.resolveMassProperties(entry.descriptor.object_ref);
      this.objectStates.set(entry.descriptor.object_ref, Object.freeze({
        object_ref: entry.descriptor.object_ref,
        transform: freezeTransform(entry.descriptor.initial_transform),
        linear_velocity_m_per_s: ZERO_VECTOR,
        angular_velocity_rad_per_s: ZERO_VECTOR,
        mass_kg: massProperties.mass_kg,
        material_profile_ref: entry.descriptor.material_profile_ref,
        movability_policy: entry.descriptor.movability_policy,
        hidden_truth_visibility: "runtime_internal_only",
      }));
    }

    this.clockS = 0;
    this.physicsTick = 0;
    this.lifecycleState = "WorldReady";
    this.recordEvent("WorldInitialized", "Physics-authoritative runtime object state initialized.", "WorldLoading", "WorldReady");

    const catalogReport = this.config.object_catalog.validate();
    return Object.freeze({
      ok: true,
      world_ref: this.config.manifest.world_manifest_id,
      lifecycle_state: this.lifecycleState,
      object_count: this.objectStates.size,
      material_count: this.config.material_registry.list().length,
      dynamic_object_count: catalogReport.dynamic_object_count,
      fixed_object_count: catalogReport.fixed_object_count,
      timing: this.createTimingConfiguration(),
      replay_seed_ref: this.config.replay_seed?.replay_seed_ref,
      disturbance_schedule_ref: this.config.disturbance_schedule?.disturbance_schedule_ref,
      issues,
      determinism_hash: this.computeWorldStateHash(),
    });
  }

  public startStepping(): void {
    this.assertTransition("WorldStepping");
    const from = this.lifecycleState;
    this.lifecycleState = "WorldStepping";
    this.recordEvent("WorldResumed", "World entered active stepping state.", from, "WorldStepping");
  }

  public pause(detail = "Physics world paused."): void {
    this.assertTransition("WorldPaused");
    const from = this.lifecycleState;
    this.lifecycleState = "WorldPaused";
    this.recordEvent("WorldPaused", detail, from, "WorldPaused");
  }

  public enterReplay(): void {
    this.assertTransition("WorldReplay");
    const from = this.lifecycleState;
    this.lifecycleState = "WorldReplay";
    this.recordEvent("WorldReplayEntered", "World entered deterministic replay mode.", from, "WorldReplay");
  }

  public shutdown(): void {
    this.assertTransition("WorldShutdown");
    const from = this.lifecycleState;
    this.lifecycleState = "WorldShutdown";
    this.recordEvent("WorldShutdown", "World shutdown and final state retained for QA/replay inspection.", from, "WorldShutdown");
  }

  /**
   * Advances the internal reference clock without integrating dynamics.
   *
   * Full solver stepping belongs to `PhysicsStepScheduler`, the next dependency
   * after this service. This method still enforces fixed-tick accounting so
   * snapshots and replay markers are deterministic before a solver adapter is
   * attached.
   */
  public advanceReferenceClock(tickCount = 1): void {
    if (!Number.isInteger(tickCount) || tickCount <= 0) {
      throw new RangeError("tickCount must be a positive integer.");
    }
    if (this.lifecycleState !== "WorldStepping" && this.lifecycleState !== "WorldReplay") {
      throw new SimulationWorldServiceError("Reference clock can advance only while stepping or replaying.", [
        makeIssue("error", "WorldStateInvalid", "$.lifecycle_state", "World must be WorldStepping or WorldReplay.", "Call startStepping or enterReplay first."),
      ]);
    }
    const dt = this.createTimingConfiguration().fixed_dt_s;
    this.physicsTick += tickCount;
    this.clockS += tickCount * dt;
  }

  public updateObjectTransform(objectRef: Ref, transform: Transform, reason: string): void {
    const current = this.requireObjectState(objectRef);
    if (current.movability_policy === "fixed") {
      throw new SimulationWorldServiceError(`Cannot move fixed object ${objectRef}.`, [
        makeIssue("error", "FixedObjectMutationRejected", "$.object_ref", "Fixed environment objects cannot be mutated through runtime transform updates.", "Use a dynamic, constrained, or kinematic object for motion."),
      ]);
    }
    const updated = Object.freeze({
      ...current,
      transform: freezeTransform(transform),
    });
    this.objectStates.set(objectRef, updated);
    this.recordEvent("ObjectStateUpdated", reason);
  }

  public createSnapshot(): PhysicsWorldSnapshot {
    if (this.lifecycleState === "WorldUninitialized" || this.lifecycleState === "WorldLoading" || this.lifecycleState === "WorldShutdown") {
      throw new SimulationWorldServiceError("Snapshots require a ready, stepping, paused, or replay world.", [
        makeIssue("error", "WorldStateInvalid", "$.lifecycle_state", "Current lifecycle state cannot produce a runtime snapshot.", "Initialize the world and avoid snapshotting after shutdown."),
      ]);
    }
    const snapshotWithoutHash = {
      snapshot_ref: `snapshot_${this.config.manifest.world_manifest_id}_${this.physicsTick}`,
      world_ref: this.config.manifest.world_manifest_id,
      lifecycle_state: this.lifecycleState,
      timestamp_s: this.clockS,
      physics_tick: this.physicsTick,
      authority: "internal_deterministic_reference" as const,
      object_states: this.sortedObjectStates(),
      material_profile_refs: this.config.material_registry.refs(),
      event_log_tail: Object.freeze(this.eventLog.slice(-10)),
      cognitive_visibility: "forbidden_to_cognition" as const,
    };
    const snapshot = Object.freeze({
      ...snapshotWithoutHash,
      determinism_hash: computeDeterminismHash(snapshotWithoutHash),
    });
    this.recordEvent("SnapshotCreated", `Snapshot ${snapshot.snapshot_ref} created.`);
    return snapshot;
  }

  public buildCognitiveSafeWorldStatus(): CognitiveSafeWorldStatus {
    return Object.freeze({
      lifecycle_state: this.lifecycleState,
      physical_reality_summary: "bounded_3d_world_available_through_declared_sensors",
      object_access: "objects_available_only_as_sensor_evidence",
      timing_summary: "fixed_step_physics_internal",
      hidden_fields_removed: Object.freeze([
        "world_manifest_id",
        "world_bounds",
        "object_states",
        "material_profile_refs",
        "replay_seed_ref",
        "disturbance_schedule_ref",
        "determinism_hash",
        "physics_tick",
        "event_log_tail",
      ]),
    });
  }

  public getObjectState(objectRef: Ref): ObjectRuntimeState {
    return this.requireObjectState(objectRef);
  }

  public listObjectStates(): readonly ObjectRuntimeState[] {
    return this.sortedObjectStates();
  }

  public getMaterialProfile(materialRef: Ref): MaterialProfile {
    return this.config.material_registry.get(materialRef).profile;
  }

  public createTimingConfiguration(): PhysicsTimingConfiguration {
    const physicsHz = this.config.manifest.nominal_physics_hz;
    return Object.freeze({
      physics_hz: physicsHz,
      fixed_dt_s: 1 / physicsHz,
      max_step_jitter_s: Math.min(0.001, 0.25 / physicsHz),
      snapshot_clock_s: this.clockS,
    });
  }

  public computeWorldStateHash(): string {
    return computeDeterminismHash({
      manifest_ref: this.config.manifest.world_manifest_id,
      lifecycle_state: this.lifecycleState,
      physics_tick: this.physicsTick,
      clock_s: this.clockS,
      objects: this.sortedObjectStates(),
      materials: this.config.material_registry.refs(),
      replay_seed_ref: this.config.replay_seed?.replay_seed_ref,
      disturbance_schedule_ref: this.config.disturbance_schedule?.disturbance_schedule_ref,
    });
  }

  private validateInitializationClosure(): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const manifestReport = validateWorldManifest(this.config.manifest);
    issues.push(...manifestReport.issues);

    const materialReport = this.config.material_registry.validate();
    issues.push(...materialReport.issues.map((issue) => prefixIssuePath(issue, "$.material_registry")));

    const catalogReport = this.config.object_catalog.validate();
    issues.push(...catalogReport.issues.map((issue) => prefixIssuePath(issue, "$.object_catalog")));

    const bundle: WorldManifestBundle = {
      manifest: this.config.manifest,
      materials: this.config.material_registry.list().map((entry) => entry.profile),
      objects: this.config.object_catalog.list().map((entry) => entry.descriptor),
      embodiment: this.config.embodiment,
      disturbance_schedule: this.config.disturbance_schedule,
      replay_seed: this.config.replay_seed,
    };
    const bundleReport = validateWorldManifestBundle(bundle);
    issues.push(...bundleReport.issues.map((issue) => prefixIssuePath(issue, "$.world_manifest_bundle")));

    const closureReport = this.config.object_catalog.validateAgainstWorldManifest(this.config.manifest);
    if (!closureReport.ok) {
      for (const ref of closureReport.missing_object_refs) {
        issues.push(makeIssue("error", "ManifestObjectMissing", "$.manifest.object_manifest_refs", `Manifest references missing object ${ref}.`, "Add the object to ObjectPhysicsCatalog or remove it from the manifest."));
      }
      for (const ref of closureReport.missing_material_refs) {
        issues.push(makeIssue("error", "ManifestMaterialMissing", "$.manifest.material_profile_refs", `Catalog object references material ${ref} not declared by manifest.`, "Add the material to the world manifest material refs."));
      }
    }

    for (const entry of this.config.object_catalog.list()) {
      try {
        this.config.object_catalog.assertWithinWorldBounds(entry.descriptor.object_ref, this.config.manifest.world_bounds);
      } catch (error) {
        if (error instanceof SimulationWorldServiceError) {
          issues.push(...error.issues);
        } else if (error instanceof Error) {
          issues.push(makeIssue("error", "WorldBoundsValidationFailed", "$.world_bounds", error.message, "Review object initial transforms and world bounds."));
        }
      }
    }

    if (this.config.disturbance_schedule !== undefined && !this.config.disturbance_schedule.qa_authorized) {
      issues.push(makeIssue("error", "DisturbanceScheduleUnauthorized", "$.disturbance_schedule", "Disturbance schedules must be QA-authorized.", "Authorize the schedule before initialization."));
    }

    return Object.freeze(issues);
  }

  private assertTransition(to: WorldLifecycleState): void {
    if (!validateLifecycleTransition(this.lifecycleState, to)) {
      throw new SimulationWorldServiceError(`Invalid world lifecycle transition ${this.lifecycleState} -> ${to}.`, [
        makeIssue("error", "LifecycleTransitionInvalid", "$.lifecycle_state", `Transition ${this.lifecycleState} -> ${to} is not permitted.`, "Follow the lifecycle state machine from architecture section 3.7.2."),
      ]);
    }
  }

  private requireObjectState(objectRef: Ref): ObjectRuntimeState {
    const state = this.objectStates.get(objectRef);
    if (state === undefined) {
      throw new SimulationWorldServiceError(`Runtime object state not found: ${objectRef}`, [
        makeIssue("error", "ObjectStateMissing", "$.object_ref", "Object is not present in initialized runtime state.", "Initialize the world and confirm the object exists in the catalog and manifest."),
      ]);
    }
    return state;
  }

  private sortedObjectStates(): readonly ObjectRuntimeState[] {
    return Object.freeze([...this.objectStates.values()].sort((a, b) => a.object_ref.localeCompare(b.object_ref)));
  }

  private recordEvent(kind: WorldEventKind, detail: string, fromState?: WorldLifecycleState, toState?: WorldLifecycleState): void {
    const eventBase = {
      event_id: `event_${this.eventLog.length + 1}_${kind}`,
      event_kind: kind,
      from_state: fromState,
      to_state: toState,
      timestamp_s: this.clockS,
      detail,
    };
    const event = Object.freeze({
      ...eventBase,
      determinism_hash: computeDeterminismHash(eventBase),
    });
    this.eventLog.push(event);
    const maxEntries = this.config.max_event_log_entries ?? 512;
    if (this.eventLog.length > maxEntries) {
      this.eventLog.splice(0, this.eventLog.length - maxEntries);
    }
  }
}

export function createSimulationWorldService(config: SimulationWorldServiceConfig): SimulationWorldService {
  return new SimulationWorldService(config);
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: Object.freeze([...transform.position_m] as unknown as Vector3),
    orientation_xyzw: Object.freeze([...transform.orientation_xyzw] as unknown as Transform["orientation_xyzw"]),
  });
}

function prefixIssuePath(issue: ValidationIssue, prefix: string): ValidationIssue {
  return Object.freeze({
    ...issue,
    path: `${prefix}${issue.path.startsWith("$") ? issue.path.slice(1) : `.${issue.path}`}`,
  });
}

type SimulationWorldValidationCode =
  | "LifecycleTransitionInvalid"
  | "WorldStateInvalid"
  | "FixedObjectMutationRejected"
  | "ObjectStateMissing"
  | "ManifestObjectMissing"
  | "ManifestMaterialMissing"
  | "WorldBoundsValidationFailed"
  | "DisturbanceScheduleUnauthorized";

function makeIssue(severity: ValidationSeverity, code: SimulationWorldValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
