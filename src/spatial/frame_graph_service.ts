/**
 * Frame graph service for Project Mebsuta spatial geometry.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.3, 10.5, 10.6, 10.14, 10.15, 10.16, and 10.17.
 *
 * This service registers declared body, sensor, end-effector, object, target,
 * memory, contact, and tool frames under the File 10 geometry convention
 * profile. It resolves explicit transform chains, propagates uncertainty and
 * timestamp overlap, and blocks simulator-world or QA-truth frames from
 * cognitive-facing geometry.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  TimestampInterval,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  GeometryConventionProfile,
  GeometryFrameClass,
  GeometryFrameSymbol,
  GeometryProvenanceClass,
} from "./geometry_convention_registry";

export const FRAME_GRAPH_SERVICE_SCHEMA_VERSION = "mebsuta.frame_graph_service.v1" as const;

const EPSILON = 1e-9;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
const HIDDEN_FRAME_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|mesh_name|asset_id)/i;

export type FrameGraphDecision = "registered" | "registered_with_warnings" | "rejected";
export type FrameGraphRecommendedAction = "use_frame_graph" | "repair_missing_frame" | "repair_transform_chain" | "repair_truth_boundary" | "repair_time_window" | "safe_hold" | "human_review";
export type TransformResolutionDecision = "resolved" | "resolved_with_warnings" | "not_resolved" | "rejected";
export type TransformResolutionRecommendedAction = "use_transform" | "refresh_stale_segment" | "declare_missing_frame" | "repair_chain" | "repair_truth_boundary" | "safe_hold";
export type FrameGraphValidityScope = "permanent" | "task_scoped" | "session_scoped" | "memory_scoped";
export type FrameGraphCognitiveVisibility = "cognitive_allowed" | "self_state" | "declared_calibration" | "estimate_with_uncertainty" | "task_scoped" | "forbidden";
export type FrameTransformDirection = "parent_from_child";
export type FrameGraphIssueCode =
  | "ConventionProfileInvalid"
  | "FrameRefInvalid"
  | "FrameMissing"
  | "FrameDuplicate"
  | "FrameClassInvalid"
  | "FrameSymbolMismatch"
  | "FrameParentMissing"
  | "FrameCycleDetected"
  | "FrameDetached"
  | "TransformInvalid"
  | "TransformDirectionInvalid"
  | "TimestampInvalid"
  | "TimestampMismatch"
  | "ProvenanceInvalid"
  | "ForbiddenTruthFrame"
  | "HiddenFrameLeak"
  | "SensorCalibrationMissing"
  | "UncertaintyInvalid"
  | "ResolutionQueryInvalid";

/**
 * File 10 frame descriptor. `transform_from_parent` is explicitly
 * `parent_from_child`, meaning it maps child-frame coordinates into the parent
 * frame as `^parent T_child`.
 */
export interface SpatialFrameDescriptor {
  readonly frame_ref: Ref;
  readonly frame_class: GeometryFrameClass;
  readonly frame_symbol: GeometryFrameSymbol;
  readonly parent_frame_ref?: Ref;
  readonly transform_from_parent?: Transform;
  readonly transform_direction?: FrameTransformDirection;
  readonly validity_scope: FrameGraphValidityScope;
  readonly provenance: GeometryProvenanceClass;
  readonly timestamp_interval?: TimestampInterval;
  readonly uncertainty_m: number;
  readonly cognitive_visibility: FrameGraphCognitiveVisibility;
  readonly source_ref?: Ref;
  readonly label: string;
}

/**
 * Declared calibration edge that may add a sensor frame to the graph or verify
 * an already declared sensor frame.
 */
export interface SensorCalibrationFrameInput {
  readonly calibration_ref: Ref;
  readonly sensor_ref: Ref;
  readonly sensor_frame_ref: Ref;
  readonly parent_frame_ref: Ref;
  readonly transform_parent_from_sensor: Transform;
  readonly timestamp_interval?: TimestampInterval;
  readonly uncertainty_m: number;
  readonly provenance: "declared_calibration";
}

/**
 * Registration input matching File 10's
 * `registerFrameGraph(embodimentFrameGraph, sensorCalibrationSet, conventionProfile)`.
 */
export interface FrameGraphRegistrationInput {
  readonly graph_ref?: Ref;
  readonly convention_profile: GeometryConventionProfile;
  readonly embodiment_frame_graph: readonly SpatialFrameDescriptor[];
  readonly sensor_calibration_set?: readonly SensorCalibrationFrameInput[];
  readonly task_frame_set?: readonly SpatialFrameDescriptor[];
  readonly memory_frame_set?: readonly SpatialFrameDescriptor[];
  readonly tool_frame_set?: readonly SpatialFrameDescriptor[];
}

/**
 * Resolved graph node with transform into the graph root and inherited
 * uncertainty/timestamp metadata.
 */
export interface RegisteredFrameNode {
  readonly frame_ref: Ref;
  readonly frame_class: GeometryFrameClass;
  readonly frame_symbol: GeometryFrameSymbol;
  readonly parent_frame_ref?: Ref;
  readonly child_frame_refs: readonly Ref[];
  readonly transform_from_parent: Transform;
  readonly transform_from_root: Transform;
  readonly depth: number;
  readonly validity_scope: FrameGraphValidityScope;
  readonly provenance_chain: readonly GeometryProvenanceClass[];
  readonly timestamp_interval?: TimestampInterval;
  readonly uncertainty_m: number;
  readonly cognitive_visibility: FrameGraphCognitiveVisibility;
  readonly label: string;
  readonly source_ref?: Ref;
  readonly determinism_hash: string;
}

/**
 * Registered frame graph consumed by transform resolution and later pose,
 * target-frame, residual, and control-handoff services.
 */
export interface RegisteredFrameGraph {
  readonly schema_version: typeof FRAME_GRAPH_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly graph_ref: Ref;
  readonly convention_profile_ref: Ref;
  readonly root_frame_ref: Ref;
  readonly frame_count: number;
  readonly topological_order: readonly Ref[];
  readonly frames: readonly RegisteredFrameNode[];
  readonly sensor_frame_refs: readonly Ref[];
  readonly object_frame_refs: readonly Ref[];
  readonly target_frame_refs: readonly Ref[];
  readonly tool_frame_refs: readonly Ref[];
  readonly forbidden_frame_refs: readonly Ref[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_registered_frame_graph";
}

/**
 * Registration report with explicit validation outcomes.
 */
export interface FrameGraphRegistrationReport {
  readonly schema_version: typeof FRAME_GRAPH_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly registration_ref: Ref;
  readonly graph: RegisteredFrameGraph;
  readonly decision: FrameGraphDecision;
  readonly recommended_action: FrameGraphRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_frame_graph_registration_report";
}

/**
 * Runtime policy for transform resolution.
 */
export interface TransformResolutionPolicy {
  readonly allow_simulator_truth_source?: boolean;
  readonly allow_qa_truth_source?: boolean;
  readonly maximum_segment_age_s?: number;
  readonly require_timestamp_overlap?: boolean;
  readonly destination?: "cognition" | "control" | "verification" | "memory" | "audit";
}

/**
 * File 10 transform-resolution query.
 */
export interface TransformResolutionQuery {
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly timestamp_interval?: TimestampInterval;
  readonly policy?: TransformResolutionPolicy;
}

/**
 * One transform edge used in a resolved chain.
 */
export interface TransformChainSegment {
  readonly segment_ref: Ref;
  readonly from_frame_ref: Ref;
  readonly to_frame_ref: Ref;
  readonly transform_to_from: Transform;
  readonly direction: "up_to_parent" | "down_to_child";
  readonly provenance: GeometryProvenanceClass;
  readonly timestamp_interval?: TimestampInterval;
  readonly uncertainty_m: number;
}

/**
 * Output matching File 10's `resolveTransform(...)` contract.
 */
export interface TransformResolutionReport {
  readonly schema_version: typeof FRAME_GRAPH_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly resolution_ref: Ref;
  readonly graph_ref: Ref;
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly transform_target_from_source: Transform;
  readonly chain_segments: readonly TransformChainSegment[];
  readonly common_ancestor_frame_ref?: Ref;
  readonly timestamp_interval?: TimestampInterval;
  readonly provenance_chain: readonly GeometryProvenanceClass[];
  readonly uncertainty_m: number;
  readonly decision: TransformResolutionDecision;
  readonly recommended_action: TransformResolutionRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_transform_resolution_report";
}

interface GraphResolutionState {
  readonly nodesByRef: ReadonlyMap<Ref, RegisteredFrameNode>;
  readonly topologicalOrder: readonly Ref[];
}

interface NormalizedTransformResolutionPolicy {
  readonly allow_simulator_truth_source: boolean;
  readonly allow_qa_truth_source: boolean;
  readonly maximum_segment_age_s: number;
  readonly require_timestamp_overlap: boolean;
  readonly destination: "cognition" | "control" | "verification" | "memory" | "audit";
}

const DEFAULT_TRANSFORM_POLICY: NormalizedTransformResolutionPolicy = Object.freeze({
  allow_simulator_truth_source: false,
  allow_qa_truth_source: false,
  maximum_segment_age_s: 0.25,
  require_timestamp_overlap: true,
  destination: "cognition",
});

/**
 * Executable File 10 `FrameGraphService`.
 */
export class FrameGraphService {
  private registration: FrameGraphRegistrationReport | undefined;

  /**
   * Registers declared geometry frames and returns a deterministic report.
   */
  public registerFrameGraph(input: FrameGraphRegistrationInput): FrameGraphRegistrationReport {
    const issues: ValidationIssue[] = [];
    validateConventionProfile(input.convention_profile, issues);
    const descriptors = collectFrameDescriptors(input, issues);
    const graphRef = makeRef(input.graph_ref ?? "spatial_frame_graph", input.convention_profile.profile_ref);
    const resolution = resolveGraph(descriptors, input.convention_profile, issues);
    const graph = buildRegisteredGraph(graphRef, input.convention_profile, resolution, issues);
    validateRegisteredGraph(graph, input.convention_profile, issues);

    const decision = decideRegistration(issues);
    const recommendedAction = chooseRegistrationAction(issues, decision);
    const registrationRef = makeRef("frame_graph_registration", graph.graph_ref, decision);
    const base = {
      schema_version: FRAME_GRAPH_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md" as const,
      registration_ref: registrationRef,
      graph,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      cognitive_visibility: "spatial_frame_graph_registration_report" as const,
    };
    const report = Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash({
        registrationRef,
        graph: graph.graph_ref,
        frames: graph.topological_order,
        decision,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
    });
    this.registration = report;
    return report;
  }

  /**
   * Resolves an explicit transform from source frame into target frame using
   * `^target T_source` composition through the registered graph.
   */
  public resolveTransform(query: TransformResolutionQuery, graph: RegisteredFrameGraph = this.requireRegisteredGraph()): TransformResolutionReport {
    const issues: ValidationIssue[] = [];
    const policy = normalizeTransformPolicy(query.policy ?? {});
    validateResolutionQuery(query, issues);
    validateTimestamp(query.timestamp_interval, "$.timestamp_interval", issues);

    const nodesByRef = new Map(graph.frames.map((frame) => [frame.frame_ref, frame]));
    const source = nodesByRef.get(query.source_frame_ref);
    const target = nodesByRef.get(query.target_frame_ref);
    if (source === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.source_frame_ref", `Source frame ${query.source_frame_ref} is not registered.`, "Declare the source frame before transform resolution."));
    }
    if (target === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.target_frame_ref", `Target frame ${query.target_frame_ref} is not registered.`, "Declare the target frame before transform resolution."));
    }

    const chain = source !== undefined && target !== undefined ? buildTransformChain(source, target, nodesByRef, issues) : freezeArray([] as readonly TransformChainSegment[]);
    validateChainPolicy(chain, query.timestamp_interval, policy, issues);
    const transform = source !== undefined && target !== undefined
      ? composeTransforms(invertTransform(target.transform_from_root, target.frame_ref), source.transform_from_root, query.target_frame_ref)
      : identityTransform(query.target_frame_ref);
    const provenance = uniqueSorted(chain.map((segment) => segment.provenance));
    const uncertainty = round6(chain.reduce((sum, segment) => sum + segment.uncertainty_m, 0));
    const interval = intersectIntervals(chain.map((segment) => segment.timestamp_interval).filter(isTimestampInterval));
    const decision = decideResolution(issues, chain);
    const recommendedAction = chooseResolutionAction(issues, decision);
    const resolutionRef = makeRef("transform_resolution", graph.graph_ref, query.source_frame_ref, query.target_frame_ref, decision);
    const base = {
      schema_version: FRAME_GRAPH_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md" as const,
      resolution_ref: resolutionRef,
      graph_ref: graph.graph_ref,
      source_frame_ref: query.source_frame_ref,
      target_frame_ref: query.target_frame_ref,
      transform_target_from_source: freezeTransform(transform),
      chain_segments: freezeArray(chain),
      common_ancestor_frame_ref: source !== undefined && target !== undefined ? findCommonAncestor(source.frame_ref, target.frame_ref, nodesByRef) : undefined,
      timestamp_interval: interval,
      provenance_chain: freezeArray(provenance),
      uncertainty_m: uncertainty,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "resolved" || decision === "resolved_with_warnings",
      cognitive_visibility: "spatial_transform_resolution_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash({
        resolutionRef,
        graph: graph.graph_ref,
        source: query.source_frame_ref,
        target: query.target_frame_ref,
        transform: base.transform_target_from_source,
        chain: chain.map((segment) => [segment.from_frame_ref, segment.to_frame_ref, segment.provenance]),
        decision,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
    });
  }

  private requireRegisteredGraph(): RegisteredFrameGraph {
    if (this.registration === undefined || !this.registration.ok) {
      throw new Error("FrameGraphService requires a successful frame graph registration before transform resolution.");
    }
    return this.registration.graph;
  }
}

/**
 * Functional API for File 10 frame graph registration.
 */
export function registerFrameGraph(input: FrameGraphRegistrationInput): FrameGraphRegistrationReport {
  return new FrameGraphService().registerFrameGraph(input);
}

/**
 * Functional API for File 10 transform resolution.
 */
export function resolveTransform(
  graph: RegisteredFrameGraph,
  query: TransformResolutionQuery,
): TransformResolutionReport {
  return new FrameGraphService().resolveTransform(query, graph);
}

function collectFrameDescriptors(
  input: FrameGraphRegistrationInput,
  issues: ValidationIssue[],
): readonly SpatialFrameDescriptor[] {
  const calibrationFrames = (input.sensor_calibration_set ?? []).map((calibration) => frameFromCalibration(calibration, issues));
  const frames = [
    ...input.embodiment_frame_graph,
    ...calibrationFrames,
    ...(input.task_frame_set ?? []),
    ...(input.memory_frame_set ?? []),
    ...(input.tool_frame_set ?? []),
  ].filter(isFrameDescriptor);
  return freezeArray(frames);
}

function frameFromCalibration(
  calibration: SensorCalibrationFrameInput,
  issues: ValidationIssue[],
): SpatialFrameDescriptor | undefined {
  validateSafeRef(calibration.calibration_ref, "$.sensor_calibration_set.calibration_ref", issues);
  validateSafeRef(calibration.sensor_ref, "$.sensor_calibration_set.sensor_ref", issues);
  validateSafeRef(calibration.sensor_frame_ref, "$.sensor_calibration_set.sensor_frame_ref", issues);
  validateSafeRef(calibration.parent_frame_ref, "$.sensor_calibration_set.parent_frame_ref", issues);
  validateTransform(calibration.transform_parent_from_sensor, "$.sensor_calibration_set.transform_parent_from_sensor", issues);
  validateTimestamp(calibration.timestamp_interval, "$.sensor_calibration_set.timestamp_interval", issues);
  if (calibration.transform_parent_from_sensor.frame_ref !== calibration.sensor_frame_ref) {
    issues.push(makeIssue("error", "TransformDirectionInvalid", "$.sensor_calibration_set.transform_parent_from_sensor.frame_ref", "Calibration transform frame_ref must identify the sensor frame being mapped into its parent.", "Set transform.frame_ref to sensor_frame_ref."));
  }
  if (!Number.isFinite(calibration.uncertainty_m) || calibration.uncertainty_m < 0) {
    issues.push(makeIssue("error", "UncertaintyInvalid", "$.sensor_calibration_set.uncertainty_m", "Calibration uncertainty must be finite and nonnegative.", "Use a nonnegative meter uncertainty."));
  }
  if (issues.some((issue) => issue.path.startsWith("$.sensor_calibration_set") && issue.severity === "error")) return undefined;
  return Object.freeze({
    frame_ref: calibration.sensor_frame_ref,
    frame_class: "sensor",
    frame_symbol: "S_i",
    parent_frame_ref: calibration.parent_frame_ref,
    transform_from_parent: freezeTransform(calibration.transform_parent_from_sensor),
    transform_direction: "parent_from_child",
    validity_scope: "permanent",
    provenance: "declared_calibration",
    timestamp_interval: calibration.timestamp_interval,
    uncertainty_m: calibration.uncertainty_m,
    cognitive_visibility: "declared_calibration",
    source_ref: calibration.calibration_ref,
    label: `declared sensor calibration ${calibration.sensor_ref}`,
  });
}

function resolveGraph(
  descriptors: readonly SpatialFrameDescriptor[],
  convention: GeometryConventionProfile,
  issues: ValidationIssue[],
): GraphResolutionState {
  const byRef = new Map<Ref, SpatialFrameDescriptor>();
  for (const descriptor of descriptors) {
    validateFrameDescriptor(descriptor, convention, issues);
    if (byRef.has(descriptor.frame_ref)) {
      issues.push(makeIssue("error", "FrameDuplicate", `$.frames.${descriptor.frame_ref}`, `Frame ${descriptor.frame_ref} is declared more than once.`, "Use one descriptor per frame ref."));
    }
    byRef.set(descriptor.frame_ref, descriptor);
  }
  ensureCoreFrames(byRef, convention);

  const childrenByParent = new Map<Ref, Ref[]>();
  for (const descriptor of byRef.values()) {
    if (descriptor.parent_frame_ref !== undefined) {
      if (!byRef.has(descriptor.parent_frame_ref)) {
        issues.push(makeIssue("error", "FrameParentMissing", `$.frames.${descriptor.frame_ref}.parent_frame_ref`, `Parent frame ${descriptor.parent_frame_ref} is missing.`, "Declare parent frames before child frames."));
      }
      const children = childrenByParent.get(descriptor.parent_frame_ref) ?? [];
      children.push(descriptor.frame_ref);
      childrenByParent.set(descriptor.parent_frame_ref, children);
    } else if (descriptor.frame_ref !== "W_hat") {
      issues.push(makeIssue("error", "FrameDetached", `$.frames.${descriptor.frame_ref}.parent_frame_ref`, `Frame ${descriptor.frame_ref} is rootless.`, "Only W_hat may be the File 10 graph root."));
    }
  }

  const nodesByRef = new Map<Ref, RegisteredFrameNode>();
  const visiting = new Set<Ref>();
  const visited = new Set<Ref>();
  const order: Ref[] = [];

  const resolveNode = (frameRef: Ref): RegisteredFrameNode | undefined => {
    const existing = nodesByRef.get(frameRef);
    if (existing !== undefined) return existing;
    const descriptor = byRef.get(frameRef);
    if (descriptor === undefined) return undefined;
    if (visiting.has(frameRef)) {
      issues.push(makeIssue("error", "FrameCycleDetected", `$.frames.${frameRef}`, `Cycle detected at frame ${frameRef}.`, "Break the parent chain cycle."));
      return undefined;
    }
    visiting.add(frameRef);
    const parent = descriptor.parent_frame_ref === undefined ? undefined : resolveNode(descriptor.parent_frame_ref);
    const transformFromParent = descriptor.transform_from_parent ?? identityTransform(descriptor.frame_ref);
    const transformFromRoot = parent === undefined
      ? identityTransform(descriptor.frame_ref)
      : composeTransforms(parent.transform_from_root, transformFromParent, descriptor.frame_ref);
    const timestamp = intersectIntervals([
      descriptor.timestamp_interval,
      parent?.timestamp_interval,
    ].filter(isTimestampInterval));
    const provenance = uniqueSorted([descriptor.provenance, ...(parent?.provenance_chain ?? [])]);
    const node = freezeNode({
      frame_ref: descriptor.frame_ref,
      frame_class: descriptor.frame_class,
      frame_symbol: descriptor.frame_symbol,
      parent_frame_ref: descriptor.parent_frame_ref,
      child_frame_refs: freezeArray((childrenByParent.get(descriptor.frame_ref) ?? []).sort()),
      transform_from_parent: transformFromParent,
      transform_from_root: transformFromRoot,
      depth: parent === undefined ? 0 : parent.depth + 1,
      validity_scope: descriptor.validity_scope,
      provenance_chain: provenance,
      timestamp_interval: timestamp,
      uncertainty_m: round6(descriptor.uncertainty_m + (parent?.uncertainty_m ?? 0)),
      cognitive_visibility: descriptor.cognitive_visibility,
      label: sanitizeText(descriptor.label),
      source_ref: descriptor.source_ref,
    });
    visiting.delete(frameRef);
    visited.add(frameRef);
    nodesByRef.set(frameRef, node);
    order.push(frameRef);
    return node;
  };

  for (const frameRef of [...byRef.keys()].sort(compareFrameRefs)) {
    if (!visited.has(frameRef)) resolveNode(frameRef);
  }
  return Object.freeze({
    nodesByRef,
    topologicalOrder: freezeArray(order.sort((a, b) => (nodesByRef.get(a)?.depth ?? 0) - (nodesByRef.get(b)?.depth ?? 0) || compareFrameRefs(a, b))),
  });
}

function ensureCoreFrames(
  byRef: Map<Ref, SpatialFrameDescriptor>,
  convention: GeometryConventionProfile,
): void {
  if (!byRef.has("W_hat")) {
    byRef.set("W_hat", Object.freeze({
      frame_ref: "W_hat",
      frame_class: "agent_estimated_world",
      frame_symbol: "W_hat",
      validity_scope: "session_scoped",
      provenance: "visual_estimate",
      uncertainty_m: 0,
      cognitive_visibility: "estimate_with_uncertainty",
      source_ref: convention.profile_ref,
      label: "agent estimated world frame",
    }));
  }
}

function buildRegisteredGraph(
  graphRef: Ref,
  convention: GeometryConventionProfile,
  resolution: GraphResolutionState,
  issues: ValidationIssue[],
): RegisteredFrameGraph {
  const frames = freezeArray(resolution.topologicalOrder.map((frameRef) => resolution.nodesByRef.get(frameRef)).filter(isRegisteredNode));
  if (!resolution.nodesByRef.has("W_hat")) {
    issues.push(makeIssue("error", "FrameMissing", "$.frames.W_hat", "Registered graph requires W_hat as the agent-estimated root.", "Declare W_hat or allow the service to add the canonical root."));
  }
  const shell = {
    graphRef,
    convention: convention.profile_ref,
    frames: frames.map((frame) => [frame.frame_ref, frame.parent_frame_ref, frame.frame_class, frame.provenance_chain]),
  };
  return Object.freeze({
    schema_version: FRAME_GRAPH_SERVICE_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
    graph_ref: graphRef,
    convention_profile_ref: convention.profile_ref,
    root_frame_ref: "W_hat",
    frame_count: frames.length,
    topological_order: resolution.topologicalOrder,
    frames,
    sensor_frame_refs: refsForClass(frames, "sensor"),
    object_frame_refs: refsForClass(frames, "object"),
    target_frame_refs: refsForClass(frames, "target"),
    tool_frame_refs: refsForClass(frames, "tool"),
    forbidden_frame_refs: freezeArray(frames.filter((frame) => isForbiddenCognitiveFrame(frame)).map((frame) => frame.frame_ref).sort(compareFrameRefs)),
    determinism_hash: computeDeterminismHash(shell),
    cognitive_visibility: "spatial_registered_frame_graph",
  });
}

function validateRegisteredGraph(
  graph: RegisteredFrameGraph,
  convention: GeometryConventionProfile,
  issues: ValidationIssue[],
): void {
  const refs = new Set(graph.frames.map((frame) => frame.frame_ref));
  for (const frame of graph.frames) {
    if (frame.frame_ref !== "W_hat" && frame.parent_frame_ref === undefined) {
      issues.push(makeIssue("error", "FrameDetached", `$.graph.frames.${frame.frame_ref}`, `Frame ${frame.frame_ref} has no parent.`, "Attach every non-root frame to W_hat or a descendant."));
    }
    if (frame.parent_frame_ref !== undefined && !refs.has(frame.parent_frame_ref)) {
      issues.push(makeIssue("error", "FrameParentMissing", `$.graph.frames.${frame.frame_ref}.parent_frame_ref`, "Frame parent is absent from registered graph.", "Declare the parent frame."));
    }
    if (isForbiddenCognitiveFrame(frame) && frame.cognitive_visibility !== "forbidden") {
      issues.push(makeIssue("error", "ForbiddenTruthFrame", `$.graph.frames.${frame.frame_ref}.cognitive_visibility`, "Truth-only frame is not allowed in cognitive-visible geometry.", "Keep W and Q_i out of registered cognitive graphs."));
    }
  }
  for (const requiredSymbol of ["W_hat", "B", "S_i"] as const) {
    if (requiredSymbol === "S_i" && graph.sensor_frame_refs.length > 0) continue;
    const hasSymbol = graph.frames.some((frame) => frame.frame_symbol === requiredSymbol);
    if (!hasSymbol) {
      const severity: ValidationSeverity = requiredSymbol === "S_i" ? "warning" : "error";
      issues.push(makeIssue(severity, requiredSymbol === "S_i" ? "SensorCalibrationMissing" : "FrameMissing", `$.graph.symbols.${requiredSymbol}`, `Frame graph is missing ${requiredSymbol}.`, "Register body root, estimated world, and declared sensor frames before spatial estimation."));
    }
  }
  if (convention.axis_basis.orthonormal !== true) {
    issues.push(makeIssue("error", "ConventionProfileInvalid", "$.convention_profile.axis_basis", "Geometry convention profile axis basis is not valid.", "Register a valid GeometryConventionProfile first."));
  }
}

function validateConventionProfile(profile: GeometryConventionProfile, issues: ValidationIssue[]): void {
  if (profile.schema_version !== "mebsuta.geometry_convention_registry.v1" || profile.blueprint_ref !== "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md") {
    issues.push(makeIssue("error", "ConventionProfileInvalid", "$.convention_profile", "FrameGraphService requires a File 10 GeometryConventionProfile.", "Pass a GeometryConventionRegistry profile."));
  }
  if (!profile.cognitive_allowed_frame_symbols.includes("W_hat") || !profile.forbidden_cognitive_frame_symbols.includes("W")) {
    issues.push(makeIssue("error", "ConventionProfileInvalid", "$.convention_profile.truth_boundary", "Convention profile must allow W_hat and forbid W.", "Repair the geometry convention truth boundary."));
  }
}

function validateFrameDescriptor(
  descriptor: SpatialFrameDescriptor,
  convention: GeometryConventionProfile,
  issues: ValidationIssue[],
): void {
  validateSafeRef(descriptor.frame_ref, "$.frames.frame_ref", issues);
  if (descriptor.parent_frame_ref !== undefined) validateSafeRef(descriptor.parent_frame_ref, "$.frames.parent_frame_ref", issues);
  validateTransform(descriptor.transform_from_parent, "$.frames.transform_from_parent", issues);
  validateTimestamp(descriptor.timestamp_interval, "$.frames.timestamp_interval", issues);
  if (descriptor.transform_from_parent !== undefined && descriptor.transform_from_parent.frame_ref !== descriptor.frame_ref) {
    issues.push(makeIssue("error", "TransformDirectionInvalid", "$.frames.transform_from_parent.frame_ref", "Transform frame_ref must identify the child frame.", "Set transform.frame_ref to frame_ref for explicit parent_from_child transforms."));
  }
  if (descriptor.transform_from_parent !== undefined && descriptor.transform_direction !== "parent_from_child") {
    issues.push(makeIssue("error", "TransformDirectionInvalid", "$.frames.transform_direction", "Transform direction must be explicitly parent_from_child.", "Declare transform_direction: parent_from_child."));
  }
  const policy = convention.frame_class_policies.find((item) => item.symbol === descriptor.frame_symbol && item.frame_class === descriptor.frame_class);
  if (policy === undefined) {
    issues.push(makeIssue("error", "FrameClassInvalid", "$.frames.frame_class", "Frame class and symbol are not approved by the geometry convention profile.", "Use File 10 frame classes and symbols from GeometryConventionRegistry."));
  } else if (!policy.allowed_provenance.includes(descriptor.provenance)) {
    issues.push(makeIssue("error", "ProvenanceInvalid", "$.frames.provenance", `Provenance ${descriptor.provenance} is not allowed for ${descriptor.frame_symbol}.`, "Use declared calibration, self-state, visual estimate, contact estimate, task evidence, or staleness-aware memory as appropriate."));
  }
  if (descriptor.frame_ref === "W" || descriptor.frame_ref.startsWith("Q_") || descriptor.frame_symbol === "W" || descriptor.frame_symbol === "Q_i") {
    issues.push(makeIssue("error", "ForbiddenTruthFrame", "$.frames.frame_ref", "Simulator or QA truth frames are not accepted in the cognitive frame graph.", "Keep truth-only frames outside FrameGraphService."));
  }
  if (!Number.isFinite(descriptor.uncertainty_m) || descriptor.uncertainty_m < 0) {
    issues.push(makeIssue("error", "UncertaintyInvalid", "$.frames.uncertainty_m", "Frame uncertainty must be finite and nonnegative.", "Attach nonnegative uncertainty in meters."));
  }
  if (!isSafeText(`${descriptor.frame_ref} ${descriptor.parent_frame_ref ?? ""} ${descriptor.label} ${descriptor.source_ref ?? ""}`)) {
    issues.push(makeIssue("error", "HiddenFrameLeak", "$.frames", "Frame metadata contains hidden simulator/backend/QA identifiers.", "Strip hidden identifiers before registration."));
  }
  if (descriptor.frame_symbol !== expectedSymbolForClass(descriptor.frame_class) && !(descriptor.frame_class === "torso_or_head" && (descriptor.frame_symbol === "T" || descriptor.frame_symbol === "H"))) {
    issues.push(makeIssue("error", "FrameSymbolMismatch", "$.frames.frame_symbol", "Frame symbol does not match frame class.", "Use the File 10 symbol for the declared class."));
  }
}

function validateResolutionQuery(query: TransformResolutionQuery, issues: ValidationIssue[]): void {
  validateSafeRef(query.source_frame_ref, "$.source_frame_ref", issues);
  validateSafeRef(query.target_frame_ref, "$.target_frame_ref", issues);
  if (query.source_frame_ref === "W" || query.target_frame_ref === "W" || query.source_frame_ref.startsWith("Q_") || query.target_frame_ref.startsWith("Q_")) {
    issues.push(makeIssue("error", "ForbiddenTruthFrame", "$.query", "Transform resolution cannot expose simulator or QA truth frames.", "Query W_hat, body, sensor, object, target, contact, or tool frames."));
  }
}

function validateChainPolicy(
  chain: readonly TransformChainSegment[],
  queryInterval: TimestampInterval | undefined,
  policy: NormalizedTransformResolutionPolicy,
  issues: ValidationIssue[],
): void {
  for (const segment of chain) {
    if ((segment.provenance === "simulator_truth" && !policy.allow_simulator_truth_source) || (segment.provenance === "qa_truth" && !policy.allow_qa_truth_source)) {
      issues.push(makeIssue("error", "ForbiddenTruthFrame", `$.chain_segments.${segment.segment_ref}.provenance`, "Forbidden truth provenance appears in the transform chain.", "Use W_hat and sensor-derived estimates for cognitive geometry."));
    }
    if (queryInterval !== undefined && segment.timestamp_interval !== undefined) {
      const overlap = intersectInterval(queryInterval, segment.timestamp_interval);
      if (policy.require_timestamp_overlap && overlap === undefined) {
        issues.push(makeIssue("error", "TimestampMismatch", `$.chain_segments.${segment.segment_ref}.timestamp_interval`, "Transform segment does not overlap the requested timestamp interval.", "Refresh stale transform evidence or resolve for a compatible time interval."));
      }
      const age = Math.max(Math.abs(queryInterval.end_s - segment.timestamp_interval.end_s), Math.abs(queryInterval.start_s - segment.timestamp_interval.start_s));
      if (age > policy.maximum_segment_age_s) {
        issues.push(makeIssue("warning", "TimestampMismatch", `$.chain_segments.${segment.segment_ref}.timestamp_interval`, "Transform segment is older than the resolution freshness policy.", "Refresh proprioception, calibration, or visual estimates."));
      }
    }
  }
}

function buildTransformChain(
  source: RegisteredFrameNode,
  target: RegisteredFrameNode,
  nodesByRef: ReadonlyMap<Ref, RegisteredFrameNode>,
  issues: ValidationIssue[],
): readonly TransformChainSegment[] {
  const sourcePath = pathToRoot(source.frame_ref, nodesByRef);
  const targetPath = pathToRoot(target.frame_ref, nodesByRef);
  const common = sourcePath.find((frameRef) => targetPath.includes(frameRef));
  if (common === undefined) {
    issues.push(makeIssue("error", "FrameDetached", "$.chain", "Source and target frames do not share a registered ancestor.", "Register both frames under W_hat."));
    return freezeArray([]);
  }
  const segments: TransformChainSegment[] = [];
  let cursor = source.frame_ref;
  while (cursor !== common) {
    const node = nodesByRef.get(cursor);
    if (node === undefined || node.parent_frame_ref === undefined) break;
    segments.push(makeChainSegment(node.frame_ref, node.parent_frame_ref, node.transform_from_parent, "up_to_parent", node));
    cursor = node.parent_frame_ref;
  }
  const downward: TransformChainSegment[] = [];
  cursor = target.frame_ref;
  while (cursor !== common) {
    const node = nodesByRef.get(cursor);
    if (node === undefined || node.parent_frame_ref === undefined) break;
    downward.push(makeChainSegment(node.parent_frame_ref, node.frame_ref, invertTransform(node.transform_from_parent, node.parent_frame_ref), "down_to_child", node));
    cursor = node.parent_frame_ref;
  }
  return freezeArray([...segments, ...downward.reverse()]);
}

function makeChainSegment(
  fromFrame: Ref,
  toFrame: Ref,
  transform: Transform,
  direction: TransformChainSegment["direction"],
  node: RegisteredFrameNode,
): TransformChainSegment {
  return Object.freeze({
    segment_ref: makeRef("transform_segment", fromFrame, toFrame, direction),
    from_frame_ref: fromFrame,
    to_frame_ref: toFrame,
    transform_to_from: freezeTransform(transform),
    direction,
    provenance: node.provenance_chain[0] ?? "visual_estimate",
    timestamp_interval: node.timestamp_interval,
    uncertainty_m: node.uncertainty_m,
  });
}

function pathToRoot(frameRef: Ref, nodesByRef: ReadonlyMap<Ref, RegisteredFrameNode>): readonly Ref[] {
  const path: Ref[] = [];
  const seen = new Set<Ref>();
  let cursor: Ref | undefined = frameRef;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = nodesByRef.get(cursor)?.parent_frame_ref;
  }
  return freezeArray(path);
}

function findCommonAncestor(sourceFrame: Ref, targetFrame: Ref, nodesByRef: ReadonlyMap<Ref, RegisteredFrameNode>): Ref | undefined {
  const targetPath = pathToRoot(targetFrame, nodesByRef);
  return pathToRoot(sourceFrame, nodesByRef).find((frameRef) => targetPath.includes(frameRef));
}

function decideRegistration(issues: readonly ValidationIssue[]): FrameGraphDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  return issues.length > 0 ? "registered_with_warnings" : "registered";
}

function decideResolution(issues: readonly ValidationIssue[], chain: readonly TransformChainSegment[]): TransformResolutionDecision {
  if (issues.some((issue) => issue.code === "ResolutionQueryInvalid" || issue.code === "ForbiddenTruthFrame")) return "rejected";
  if (issues.some((issue) => issue.severity === "error")) return "not_resolved";
  return issues.length > 0 || chain.length === 0 ? "resolved_with_warnings" : "resolved";
}

function chooseRegistrationAction(issues: readonly ValidationIssue[], decision: FrameGraphDecision): FrameGraphRecommendedAction {
  if (decision === "registered") return "use_frame_graph";
  if (issues.some((issue) => issue.code === "FrameMissing" || issue.code === "FrameParentMissing" || issue.code === "SensorCalibrationMissing")) return "repair_missing_frame";
  if (issues.some((issue) => issue.code === "TransformInvalid" || issue.code === "FrameCycleDetected" || issue.code === "FrameDetached")) return "repair_transform_chain";
  if (issues.some((issue) => issue.code === "ForbiddenTruthFrame" || issue.code === "HiddenFrameLeak")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "TimestampInvalid" || issue.code === "TimestampMismatch")) return "repair_time_window";
  return decision === "registered_with_warnings" ? "human_review" : "safe_hold";
}

function chooseResolutionAction(issues: readonly ValidationIssue[], decision: TransformResolutionDecision): TransformResolutionRecommendedAction {
  if (decision === "resolved") return "use_transform";
  if (issues.some((issue) => issue.code === "TimestampMismatch" || issue.code === "TimestampInvalid")) return "refresh_stale_segment";
  if (issues.some((issue) => issue.code === "FrameMissing" || issue.code === "FrameParentMissing")) return "declare_missing_frame";
  if (issues.some((issue) => issue.code === "ForbiddenTruthFrame" || issue.code === "HiddenFrameLeak")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "TransformInvalid" || issue.code === "FrameDetached" || issue.code === "FrameCycleDetected")) return "repair_chain";
  return "safe_hold";
}

function normalizeTransformPolicy(policy: TransformResolutionPolicy): NormalizedTransformResolutionPolicy {
  return Object.freeze({
    allow_simulator_truth_source: policy.allow_simulator_truth_source ?? DEFAULT_TRANSFORM_POLICY.allow_simulator_truth_source,
    allow_qa_truth_source: policy.allow_qa_truth_source ?? DEFAULT_TRANSFORM_POLICY.allow_qa_truth_source,
    maximum_segment_age_s: positiveOrDefault(policy.maximum_segment_age_s, DEFAULT_TRANSFORM_POLICY.maximum_segment_age_s),
    require_timestamp_overlap: policy.require_timestamp_overlap ?? DEFAULT_TRANSFORM_POLICY.require_timestamp_overlap,
    destination: policy.destination ?? DEFAULT_TRANSFORM_POLICY.destination,
  });
}

function expectedSymbolForClass(frameClass: GeometryFrameClass): GeometryFrameSymbol {
  const symbols: Readonly<Record<GeometryFrameClass, GeometryFrameSymbol>> = {
    simulator_world: "W",
    agent_estimated_world: "W_hat",
    base: "B",
    torso_or_head: "T",
    sensor: "S_i",
    end_effector: "E_i",
    contact: "C_i",
    object: "O_j",
    target: "T_k",
    tool: "U_i",
    qa_truth: "Q_i",
  };
  return symbols[frameClass];
}

function refsForClass(frames: readonly RegisteredFrameNode[], frameClass: GeometryFrameClass): readonly Ref[] {
  return freezeArray(frames.filter((frame) => frame.frame_class === frameClass).map((frame) => frame.frame_ref).sort(compareFrameRefs));
}

function freezeNode(input: Omit<RegisteredFrameNode, "determinism_hash">): RegisteredFrameNode {
  const shell = {
    frame: input.frame_ref,
    parent: input.parent_frame_ref,
    cls: input.frame_class,
    symbol: input.frame_symbol,
    transform: input.transform_from_root,
    provenance: input.provenance_chain,
    uncertainty: input.uncertainty_m,
  };
  return Object.freeze({
    ...input,
    child_frame_refs: freezeArray(input.child_frame_refs),
    transform_from_parent: freezeTransform(input.transform_from_parent),
    transform_from_root: freezeTransform(input.transform_from_root),
    provenance_chain: freezeArray(input.provenance_chain),
    timestamp_interval: input.timestamp_interval,
    uncertainty_m: round6(input.uncertainty_m),
    label: sanitizeText(input.label),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (value === undefined || value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", "FrameRefInvalid", path, "Frame references must be non-empty and whitespace-free.", "Use opaque frame refs such as B, camera_front_frame, or object_hypothesis_frame."));
    return;
  }
  if (!isSafeText(value)) {
    issues.push(makeIssue("error", "HiddenFrameLeak", path, "Frame reference contains hidden simulator/backend/QA identifiers.", "Use sanitized local frame references."));
  }
}

function validateTransform(transform: Transform | undefined, path: string, issues: ValidationIssue[]): void {
  if (transform === undefined) return;
  validateSafeRef(transform.frame_ref, `${path}.frame_ref`, issues);
  validateVector3(transform.position_m, `${path}.position_m`, issues);
  validateQuaternion(transform.orientation_xyzw, `${path}.orientation_xyzw`, issues);
}

function validateVector3(value: Vector3, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "TransformInvalid", path, "Vector3 must contain exactly three finite meter values.", "Use [x, y, z] in meters."));
  }
}

function validateQuaternion(value: Quaternion, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "TransformInvalid", path, "Quaternion must contain exactly four finite values.", "Use [x, y, z, w]."));
    return;
  }
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON || Math.abs(length - 1) > 1e-6) {
    issues.push(makeIssue("error", "TransformInvalid", path, "Quaternion must be normalized to unit length.", "Normalize orientation quaternions before registration."));
  }
}

function validateTimestamp(interval: TimestampInterval | undefined, path: string, issues: ValidationIssue[]): void {
  if (interval === undefined) return;
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.end_s < interval.start_s) {
    issues.push(makeIssue("error", "TimestampInvalid", path, "Timestamp interval must contain finite ordered seconds.", "Use { start_s <= end_s } in seconds."));
  }
}

function identityTransform(frameRef: Ref): Transform {
  return freezeTransform({
    frame_ref: frameRef,
    position_m: ZERO_VECTOR,
    orientation_xyzw: IDENTITY_QUATERNION,
  });
}

function composeTransforms(parentFromMiddle: Transform, middleFromChild: Transform, childFrameRef: Ref): Transform {
  const orientation = normalizeQuaternion(quaternionMultiply(parentFromMiddle.orientation_xyzw, middleFromChild.orientation_xyzw));
  const translated = addVectors(parentFromMiddle.position_m, rotateVector(parentFromMiddle.orientation_xyzw, middleFromChild.position_m));
  return freezeTransform({
    frame_ref: childFrameRef,
    position_m: translated,
    orientation_xyzw: orientation,
  });
}

function invertTransform(transform: Transform, targetFrameRef: Ref): Transform {
  const inverseOrientation = quaternionConjugate(normalizeQuaternion(transform.orientation_xyzw));
  return freezeTransform({
    frame_ref: targetFrameRef,
    position_m: rotateVector(inverseOrientation, scaleVector(transform.position_m, -1)),
    orientation_xyzw: inverseOrientation,
  });
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return freezeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function quaternionConjugate(value: Quaternion): Quaternion {
  return freezeQuaternion([-value[0], -value[1], -value[2], value[3]]);
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON) return IDENTITY_QUATERNION;
  return freezeQuaternion([value[0] / length, value[1] / length, value[2] / length, value[3] / length]);
}

function rotateVector(orientation: Quaternion, vector: Vector3): Vector3 {
  const q = normalizeQuaternion(orientation);
  const vq = freezeQuaternion([vector[0], vector[1], vector[2], 0]);
  const rotated = quaternionMultiply(quaternionMultiply(q, vq), quaternionConjugate(q));
  return freezeVector3([rotated[0], rotated[1], rotated[2]]);
}

function addVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function scaleVector(vector: Vector3, scale: number): Vector3 {
  return freezeVector3([vector[0] * scale, vector[1] * scale, vector[2] * scale]);
}

function intersectIntervals(intervals: readonly TimestampInterval[]): TimestampInterval | undefined {
  if (intervals.length === 0) return undefined;
  return intervals.reduce<TimestampInterval | undefined>((current, interval) => current === undefined ? undefined : intersectInterval(current, interval), intervals[0]);
}

function intersectInterval(a: TimestampInterval, b: TimestampInterval): TimestampInterval | undefined {
  const start = Math.max(a.start_s, b.start_s);
  const end = Math.min(a.end_s, b.end_s);
  return end >= start ? Object.freeze({ start_s: round6(start), end_s: round6(end) }) : undefined;
}

function isTimestampInterval(value: TimestampInterval | undefined): value is TimestampInterval {
  return value !== undefined;
}

function isFrameDescriptor(value: SpatialFrameDescriptor | undefined): value is SpatialFrameDescriptor {
  return value !== undefined;
}

function isRegisteredNode(value: RegisteredFrameNode | undefined): value is RegisteredFrameNode {
  return value !== undefined;
}

function isForbiddenCognitiveFrame(frame: RegisteredFrameNode): boolean {
  return frame.frame_ref === "W" || frame.frame_ref.startsWith("Q_") || frame.frame_symbol === "W" || frame.frame_symbol === "Q_i" || frame.provenance_chain.some((item) => item === "simulator_truth" || item === "qa_truth");
}

function isSafeText(value: string): boolean {
  return !HIDDEN_FRAME_PATTERN.test(value);
}

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(HIDDEN_FRAME_PATTERN, "hidden-detail").slice(0, 240);
}

function compareFrameRefs(a: Ref, b: Ref): number {
  if (a === "W_hat") return -1;
  if (b === "W_hat") return 1;
  if (a === "B") return -1;
  if (b === "B") return 1;
  return a.localeCompare(b);
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: freezeQuaternion(transform.orientation_xyzw),
  });
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function makeIssue(
  severity: ValidationSeverity,
  code: FrameGraphIssueCode,
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
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
