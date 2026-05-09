/**
 * Frame graph provider for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.7, 5.8, 5.9, 5.15, 5.16, and 5.19.
 *
 * This module is the executable frame authority for body-relative kinematics.
 * It resolves base, torso, head, sensor, contact, end-effector, task-scoped
 * tool, and estimated-map frames without exposing simulator world truth,
 * backend body handles, exact collision geometry, or QA coordinates.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type {
  ContactSiteDescriptor,
  EmbodimentDescriptor,
  EndEffectorDescriptor,
  FrameDescriptor,
  FrameRole,
  SensorMountDescriptor,
  ValidityScope,
} from "./embodiment_model_registry";

export const FRAME_GRAPH_PROVIDER_SCHEMA_VERSION = "mebsuta.frame_graph_provider.v1" as const;

const EPSILON = 1e-9;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
const FORBIDDEN_FRAME_REFS = new Set<Ref>(["W"]);
const ESTIMATED_WORLD_FRAME_REF: Ref = "W_hat";
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|joint_handle|rigid_body_handle|physics_body)/i;

export type FrameGraphIssueCode =
  | "ActiveEmbodimentMissing"
  | "FrameRefInvalid"
  | "FrameGraphInvalid"
  | "FrameMissing"
  | "FrameCycleDetected"
  | "FrameRoleInvalid"
  | "FrameAttachmentInvalid"
  | "FrameTransformInvalid"
  | "ForbiddenWorldFrame"
  | "ForbiddenBodyDetail"
  | "SensorFrameDetached"
  | "ContactFrameDetached"
  | "EndEffectorFrameDetached"
  | "ToolFrameInvalid"
  | "ToolFrameExpired"
  | "TransformQueryInvalid";

export type ToolFrameExpiryReason = "task_complete" | "release" | "safety_abort" | "manual_clearance";

export interface FrameGraphProviderConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
  readonly allow_estimated_world_frame?: boolean;
}

export interface ResolvedFrameNode {
  readonly frame_id: Ref;
  readonly frame_role: FrameRole;
  readonly parent_frame_ref?: Ref;
  readonly children_frame_refs: readonly Ref[];
  readonly validity_scope: ValidityScope;
  readonly transform_from_parent: Transform;
  readonly transform_from_base: Transform;
  readonly depth: number;
  readonly uncertainty_m: number;
  readonly cognitive_label: string;
  readonly source: "embodiment_descriptor" | "tool_attachment" | "estimated_map";
  readonly cognitive_visibility: "body_relative" | "estimate_relative";
}

export interface FrameGraphResolutionReport {
  readonly schema_version: typeof FRAME_GRAPH_PROVIDER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly frame_graph_ref: Ref;
  readonly frame_count: number;
  readonly sensor_frame_count: number;
  readonly contact_frame_count: number;
  readonly end_effector_frame_count: number;
  readonly tool_frame_count: number;
  readonly estimated_frame_count: number;
  readonly topological_order: readonly Ref[];
  readonly frames: readonly ResolvedFrameNode[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export interface FrameTransformQuery {
  readonly embodiment_ref?: Ref;
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
}

export interface FrameTransformReport {
  readonly schema_version: typeof FRAME_GRAPH_PROVIDER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly transform_source_to_target: Transform;
  readonly path_source_to_base: readonly Ref[];
  readonly path_target_to_base: readonly Ref[];
  readonly uncertainty_m: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface FramePointTransformQuery extends FrameTransformQuery {
  readonly point_in_source_frame_m: Vector3;
}

export interface FramePointTransformReport {
  readonly schema_version: typeof FRAME_GRAPH_PROVIDER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly point_in_source_frame_m: Vector3;
  readonly point_in_target_frame_m: Vector3;
  readonly transform_source_to_target: Transform;
  readonly uncertainty_m: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ToolFrameAttachmentInput {
  readonly embodiment_ref?: Ref;
  readonly tool_frame_ref: Ref;
  readonly parent_frame_ref: Ref;
  readonly transform_from_parent: Transform;
  readonly tool_label: string;
  readonly task_scope_ref: Ref;
  readonly contact_site_ref?: Ref;
  readonly end_effector_ref?: Ref;
  readonly uncertainty_m?: number;
}

export interface ToolFrameAttachmentReport {
  readonly schema_version: typeof FRAME_GRAPH_PROVIDER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly tool_frame_ref: Ref;
  readonly parent_frame_ref: Ref;
  readonly attached: boolean;
  readonly expired: boolean;
  readonly expiry_reason?: ToolFrameExpiryReason;
  readonly resolved_frame?: ResolvedFrameNode;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveFrameSummary {
  readonly schema_version: typeof FRAME_GRAPH_PROVIDER_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly root_body_frame_ref: Ref;
  readonly body_relative_frames: readonly {
    readonly frame_id: Ref;
    readonly frame_role: FrameRole;
    readonly parent_frame_ref?: Ref;
    readonly label: string;
    readonly validity_scope: ValidityScope;
    readonly uncertainty_m: number;
  }[];
  readonly sensor_mount_summary: readonly string[];
  readonly contact_site_summary: readonly string[];
  readonly end_effector_summary: readonly string[];
  readonly tool_frame_summary: readonly string[];
  readonly estimate_frame_summary: readonly string[];
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "body_self_knowledge_without_simulator_world_truth";
  readonly determinism_hash: string;
}

interface ToolFrameRecord {
  readonly descriptor: FrameDescriptor;
  readonly parent_frame_ref: Ref;
  readonly task_scope_ref: Ref;
  readonly contact_site_ref?: Ref;
  readonly end_effector_ref?: Ref;
  readonly expired: boolean;
  readonly expiry_reason?: ToolFrameExpiryReason;
}

export class FrameGraphProviderError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "FrameGraphProviderError";
    this.issues = issues;
  }
}

/**
 * Resolves active embodiment frame graphs and body-relative transforms while
 * enforcing the simulation-blindness rules from the embodiment architecture.
 */
export class FrameGraphProvider {
  private readonly registry: EmbodimentModelRegistry;
  private readonly allowEstimatedWorldFrame: boolean;
  private activeEmbodimentRef: Ref | undefined;
  private readonly toolFramesByEmbodiment = new Map<Ref, Map<Ref, ToolFrameRecord>>();

  public constructor(config: FrameGraphProviderConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.allowEstimatedWorldFrame = config.allow_estimated_world_frame ?? true;
    this.activeEmbodimentRef = config.active_embodiment_ref ?? config.embodiment?.embodiment_id;
    if (this.activeEmbodimentRef !== undefined) {
      this.registry.selectActiveEmbodiment({ embodiment_ref: this.activeEmbodimentRef });
    }
  }

  /**
   * Selects the active body model used by transform and summary queries.
   */
  public selectActiveEmbodiment(embodimentRef: Ref): FrameGraphResolutionReport {
    assertSafeFrameRef(embodimentRef, "$.embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: embodimentRef });
    this.activeEmbodimentRef = embodimentRef;
    return this.buildFrameGraphReport(embodimentRef);
  }

  /**
   * Builds a fully resolved, topologically ordered graph for the active model.
   * The report includes validation issues instead of leaking hidden backend
   * state to callers.
   */
  public buildFrameGraphReport(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): FrameGraphResolutionReport {
    const model = this.requireEmbodiment(embodimentRef);
    const issues: ValidationIssue[] = [];
    const descriptors = this.collectActiveFrameDescriptors(model);
    const resolution = resolveFrameGraph(model, descriptors, this.allowEstimatedWorldFrame, issues);
    validateAttachmentClosure(model, resolution.nodesByRef, issues);

    const frames = freezeArray(resolution.topologicalOrder.map((frameRef) => {
      const node = resolution.nodesByRef.get(frameRef);
      if (node === undefined) {
        issues.push(makeIssue("error", "FrameMissing", "$.topological_order", `Resolved frame ${frameRef} is missing.`, "Rebuild the frame graph from declared descriptors."));
        return undefined;
      }
      return node;
    }).filter((node): node is ResolvedFrameNode => node !== undefined));

    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      frame_graph_ref: model.frame_graph_ref,
      frame_count: frames.length,
      sensor_frame_count: frames.filter((frame) => frame.frame_role === "sensor").length,
      contact_frame_count: frames.filter((frame) => frame.frame_role === "contact").length,
      end_effector_frame_count: frames.filter((frame) => frame.frame_role === "end_effector").length,
      tool_frame_count: frames.filter((frame) => frame.frame_role === "tool").length,
      estimated_frame_count: frames.filter((frame) => frame.frame_role === "estimated_map").length,
      topological_order: freezeArray(resolution.topologicalOrder),
      frames,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      hidden_fields_removed: hiddenFieldsRemoved(),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Requires a declared or task-scoped frame and throws when the frame is not
   * available for body-relative use.
   */
  public requireFrame(frameRef: Ref, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ResolvedFrameNode {
    assertSafeFrameRef(frameRef, "$.frame_ref");
    const graph = this.buildFrameGraphReport(embodimentRef);
    const frame = graph.frames.find((candidate) => candidate.frame_id === frameRef);
    if (frame === undefined) {
      throw new FrameGraphProviderError("Frame is not present in the active embodiment graph.", [
        makeIssue("error", "FrameMissing", "$.frame_ref", `Frame ${frameRef} is not declared by embodiment ${embodimentRef}.`, "Use a declared body, sensor, contact, end-effector, tool, or estimated frame."),
      ]);
    }
    if (!graph.ok) {
      throw new FrameGraphProviderError("Frame graph failed validation.", graph.issues);
    }
    return frame;
  }

  /**
   * Resolves the rigid transform that maps coordinates from source frame into
   * target frame. Both frames must be declared body-relative or estimate-relative
   * frames; simulator world frame `W` is always rejected.
   */
  public resolveTransform(query: FrameTransformQuery): FrameTransformReport {
    assertSafeFrameRef(query.source_frame_ref, "$.source_frame_ref");
    assertSafeFrameRef(query.target_frame_ref, "$.target_frame_ref");
    const model = this.requireEmbodiment(query.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const descriptors = this.collectActiveFrameDescriptors(model);
    const resolution = resolveFrameGraph(model, descriptors, this.allowEstimatedWorldFrame, issues);
    const source = resolution.nodesByRef.get(query.source_frame_ref);
    const target = resolution.nodesByRef.get(query.target_frame_ref);
    if (source === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.source_frame_ref", `Source frame ${query.source_frame_ref} is not declared.`, "Choose a declared frame."));
    }
    if (target === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.target_frame_ref", `Target frame ${query.target_frame_ref} is not declared.`, "Choose a declared frame."));
    }

    const transform = source !== undefined && target !== undefined
      ? composeTransforms(invertTransform(target.transform_from_base, target.frame_id), source.transform_from_base, target.frame_id)
      : identityTransform(query.target_frame_ref);
    const uncertainty = source !== undefined && target !== undefined
      ? round6(source.uncertainty_m + target.uncertainty_m)
      : 0;
    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      source_frame_ref: query.source_frame_ref,
      target_frame_ref: query.target_frame_ref,
      transform_source_to_target: freezeTransform(transform),
      path_source_to_base: source === undefined ? freezeArray([] as Ref[]) : pathToBase(source.frame_id, resolution.nodesByRef),
      path_target_to_base: target === undefined ? freezeArray([] as Ref[]) : pathToBase(target.frame_id, resolution.nodesByRef),
      uncertainty_m: uncertainty,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Transforms a point from one body-relative frame into another using the same
   * resolved transform report consumed by perception and controls.
   */
  public transformPoint(query: FramePointTransformQuery): FramePointTransformReport {
    validateVector3(query.point_in_source_frame_m, "$.point_in_source_frame_m");
    const transformReport = this.resolveTransform(query);
    const point = transformPointByTransform(query.point_in_source_frame_m, transformReport.transform_source_to_target);
    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: transformReport.embodiment_ref,
      source_frame_ref: query.source_frame_ref,
      target_frame_ref: query.target_frame_ref,
      point_in_source_frame_m: freezeVector3(query.point_in_source_frame_m),
      point_in_target_frame_m: point,
      transform_source_to_target: transformReport.transform_source_to_target,
      uncertainty_m: transformReport.uncertainty_m,
      issues: transformReport.issues,
      ok: transformReport.ok,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Creates or replaces a validated task-scoped tool attachment frame. The
   * attachment parent must be an existing end-effector, contact, or tool-capable
   * frame, and the resulting frame remains in the graph only until expired.
   */
  public attachToolFrame(input: ToolFrameAttachmentInput): ToolFrameAttachmentReport {
    assertSafeFrameRef(input.tool_frame_ref, "$.tool_frame_ref");
    assertSafeFrameRef(input.parent_frame_ref, "$.parent_frame_ref");
    validateTransform(input.transform_from_parent, "$.transform_from_parent");
    if (input.transform_from_parent.frame_ref !== input.tool_frame_ref) {
      throw new FrameGraphProviderError("Tool transform frame_ref must match tool_frame_ref.", [
        makeIssue("error", "ToolFrameInvalid", "$.transform_from_parent.frame_ref", "Tool transform frame_ref does not match the tool frame.", "Set transform_from_parent.frame_ref to tool_frame_ref."),
      ]);
    }
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const currentGraph = this.buildFrameGraphReport(model.embodiment_id);
    const parent = currentGraph.frames.find((frame) => frame.frame_id === input.parent_frame_ref);
    if (parent === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.parent_frame_ref", `Parent frame ${input.parent_frame_ref} is not declared.`, "Attach tools to a declared end-effector or contact frame."));
    } else if (!isToolAttachmentParent(parent, model, input)) {
      issues.push(makeIssue("error", "ToolFrameInvalid", "$.parent_frame_ref", "Tool parent is not a declared end-effector, contact, or existing tool frame.", "Attach tools through declared manipulation/contact interfaces."));
    }
    if (!input.tool_frame_ref.startsWith("U_")) {
      issues.push(makeIssue("error", "ToolFrameInvalid", "$.tool_frame_ref", "Tool frame refs must use the U_ task-scoped namespace.", "Use a U_ prefixed tool frame reference."));
    }
    if (!isSafeText(input.tool_label)) {
      issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.tool_label", "Tool label contains forbidden simulator/backend detail.", "Use a body-facing tool label only."));
    }
    if (input.uncertainty_m !== undefined && (!Number.isFinite(input.uncertainty_m) || input.uncertainty_m < 0)) {
      issues.push(makeIssue("error", "FrameTransformInvalid", "$.uncertainty_m", "Tool uncertainty must be finite and nonnegative.", "Use calibrated uncertainty in meters."));
    }

    const attached = !issues.some((issue) => issue.severity === "error");
    let resolvedFrame: ResolvedFrameNode | undefined;
    if (attached) {
      const descriptor: FrameDescriptor = Object.freeze({
        frame_id: input.tool_frame_ref,
        frame_role: "tool",
        parent_frame_ref: input.parent_frame_ref,
        transform_from_parent: freezeTransform(input.transform_from_parent),
        validity_scope: "task_scoped",
        uncertainty_m: input.uncertainty_m ?? 0.025,
        cognitive_label: sanitizeText(input.tool_label),
      });
      this.toolFrameMapFor(model.embodiment_id).set(input.tool_frame_ref, Object.freeze({
        descriptor,
        parent_frame_ref: input.parent_frame_ref,
        task_scope_ref: input.task_scope_ref,
        contact_site_ref: input.contact_site_ref,
        end_effector_ref: input.end_effector_ref,
        expired: false,
      }));
      resolvedFrame = this.requireFrame(input.tool_frame_ref, model.embodiment_id);
    }

    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      tool_frame_ref: input.tool_frame_ref,
      parent_frame_ref: input.parent_frame_ref,
      attached,
      expired: false,
      resolved_frame: resolvedFrame,
      issues: freezeArray(issues),
      ok: attached,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Expires a task-scoped tool frame after release, task completion, or safety
   * abort so it cannot silently extend future reach envelopes.
   */
  public expireToolFrame(toolFrameRef: Ref, reason: ToolFrameExpiryReason, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ToolFrameAttachmentReport {
    assertSafeFrameRef(toolFrameRef, "$.tool_frame_ref");
    const model = this.requireEmbodiment(embodimentRef);
    const issues: ValidationIssue[] = [];
    const frameMap = this.toolFrameMapFor(model.embodiment_id);
    const record = frameMap.get(toolFrameRef);
    if (record === undefined) {
      issues.push(makeIssue("error", "FrameMissing", "$.tool_frame_ref", `Tool frame ${toolFrameRef} is not attached.`, "Attach the tool frame before expiring it."));
    } else {
      frameMap.set(toolFrameRef, Object.freeze({ ...record, expired: true, expiry_reason: reason }));
    }
    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      tool_frame_ref: toolFrameRef,
      parent_frame_ref: record?.parent_frame_ref ?? "unknown_parent",
      attached: record !== undefined,
      expired: record !== undefined,
      expiry_reason: record === undefined ? undefined : reason,
      resolved_frame: undefined,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Builds the prompt-safe frame view: declared body, sensor, contact,
   * end-effector, task-scoped tool, and estimated frames with all hidden
   * simulator details removed.
   */
  public buildCognitiveFrameSummary(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): CognitiveFrameSummary {
    const model = this.requireEmbodiment(embodimentRef);
    const report = this.buildFrameGraphReport(model.embodiment_id);
    this.assertNoForbiddenFrameLeak(report);
    const bodyFrames = report.frames
      .filter((frame) => frame.cognitive_visibility === "body_relative" || frame.cognitive_visibility === "estimate_relative")
      .map((frame) => Object.freeze({
        frame_id: frame.frame_id,
        frame_role: frame.frame_role,
        parent_frame_ref: frame.parent_frame_ref,
        label: sanitizeText(frame.cognitive_label),
        validity_scope: frame.validity_scope,
        uncertainty_m: frame.uncertainty_m,
      }));
    const base = {
      schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      root_body_frame_ref: "B",
      body_relative_frames: freezeArray(bodyFrames),
      sensor_mount_summary: freezeArray(model.sensor_mounts.map((mount) => sensorMountSummary(mount)).sort()),
      contact_site_summary: freezeArray(model.contact_sites.map((site) => contactSiteSummary(site)).sort()),
      end_effector_summary: freezeArray(model.end_effectors.map((effector) => endEffectorSummary(effector)).sort()),
      tool_frame_summary: freezeArray(report.frames.filter((frame) => frame.frame_role === "tool").map((frame) => `${frame.frame_id} attached to ${frame.parent_frame_ref ?? "unknown"} for ${frame.validity_scope}`).sort()),
      estimate_frame_summary: freezeArray(report.frames.filter((frame) => frame.frame_role === "estimated_map").map((frame) => `${frame.frame_id} is sensor-derived estimate-relative only`).sort()),
      hidden_fields_removed: hiddenFieldsRemoved(),
      cognitive_visibility: "body_self_knowledge_without_simulator_world_truth" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Rejects any report that contains simulator world frame or backend-handle
   * strings in model-facing fields.
   */
  public assertNoForbiddenFrameLeak(report: FrameGraphResolutionReport = this.buildFrameGraphReport()): void {
    const issues: ValidationIssue[] = [];
    for (const frame of report.frames) {
      if (FORBIDDEN_FRAME_REFS.has(frame.frame_id) || frame.parent_frame_ref === "W" || frame.transform_from_base.frame_ref === "W") {
        issues.push(makeIssue("error", "ForbiddenWorldFrame", "$.frames", "Simulator world frame W is not model-facing body knowledge.", "Use body-relative frames or W_hat estimated frames only."));
      }
      if (!isSafeText(frame.frame_id) || !isSafeText(frame.cognitive_label)) {
        issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.frames", `Frame ${frame.frame_id} contains forbidden backend detail.`, "Strip backend handles before building summaries."));
      }
    }
    if (issues.length > 0) {
      throw new FrameGraphProviderError("Frame graph contains forbidden simulator detail.", issues);
    }
  }

  private requireActiveEmbodiment(): EmbodimentDescriptor {
    if (this.activeEmbodimentRef !== undefined) {
      return this.registry.requireEmbodiment(this.activeEmbodimentRef);
    }
    const model = this.registry.requireActiveEmbodiment();
    this.activeEmbodimentRef = model.embodiment_id;
    return model;
  }

  private requireEmbodiment(embodimentRef: Ref): EmbodimentDescriptor {
    return this.registry.requireEmbodiment(embodimentRef);
  }

  private collectActiveFrameDescriptors(model: EmbodimentDescriptor): readonly FrameDescriptor[] {
    const activeTools = [...(this.toolFramesByEmbodiment.get(model.embodiment_id)?.values() ?? [])]
      .filter((record) => !record.expired)
      .map((record) => record.descriptor);
    return freezeArray([...model.frame_graph, ...activeTools]);
  }

  private toolFrameMapFor(embodimentRef: Ref): Map<Ref, ToolFrameRecord> {
    const existing = this.toolFramesByEmbodiment.get(embodimentRef);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<Ref, ToolFrameRecord>();
    this.toolFramesByEmbodiment.set(embodimentRef, created);
    return created;
  }
}

export function createFrameGraphProvider(config: FrameGraphProviderConfig = {}): FrameGraphProvider {
  return new FrameGraphProvider(config);
}

function resolveFrameGraph(
  model: EmbodimentDescriptor,
  descriptors: readonly FrameDescriptor[],
  allowEstimatedWorldFrame: boolean,
  issues: ValidationIssue[],
): { readonly nodesByRef: ReadonlyMap<Ref, ResolvedFrameNode>; readonly topologicalOrder: readonly Ref[] } {
  const descriptorByRef = new Map<Ref, FrameDescriptor>();
  for (const descriptor of descriptors) {
    validateFrameDescriptor(descriptor, issues);
    if (descriptorByRef.has(descriptor.frame_id)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", `Frame ${descriptor.frame_id} is duplicated.`, "Use unique frame identifiers."));
    }
    descriptorByRef.set(descriptor.frame_id, descriptor);
  }
  if (!descriptorByRef.has("B")) {
    issues.push(makeIssue("error", "FrameMissing", "$.frame_graph", "Base frame B is required.", "Declare B as the root body frame."));
  }
  if (descriptorByRef.has("W")) {
    issues.push(makeIssue("error", "ForbiddenWorldFrame", "$.frame_graph.W", "Simulator world frame W must not enter the embodiment frame graph.", "Keep W in QA/validator-only simulation services."));
  }
  if (descriptorByRef.has(ESTIMATED_WORLD_FRAME_REF) && !allowEstimatedWorldFrame) {
    issues.push(makeIssue("error", "ForbiddenWorldFrame", "$.frame_graph.W_hat", "Estimated world frame is disabled for this provider.", "Enable estimated-map frames or remove W_hat."));
  }

  const childrenByParent = new Map<Ref, Ref[]>();
  for (const descriptor of descriptorByRef.values()) {
    if (descriptor.parent_frame_ref !== undefined) {
      if (!descriptorByRef.has(descriptor.parent_frame_ref)) {
        issues.push(makeIssue("error", "FrameMissing", "$.frame_graph.parent_frame_ref", `Parent frame ${descriptor.parent_frame_ref} for ${descriptor.frame_id} is missing.`, "Declare parent frames before use."));
      }
      const children = childrenByParent.get(descriptor.parent_frame_ref) ?? [];
      children.push(descriptor.frame_id);
      childrenByParent.set(descriptor.parent_frame_ref, children);
    } else if (descriptor.frame_id !== "B" && descriptor.frame_id !== ESTIMATED_WORLD_FRAME_REF) {
      issues.push(makeIssue("error", "FrameAttachmentInvalid", "$.frame_graph.parent_frame_ref", `Frame ${descriptor.frame_id} is rootless.`, "Only B and W_hat may be roots."));
    }
  }

  const nodesByRef = new Map<Ref, ResolvedFrameNode>();
  const visiting = new Set<Ref>();
  const visited = new Set<Ref>();
  const topologicalOrder: Ref[] = [];

  const resolveNode = (frameRef: Ref): ResolvedFrameNode | undefined => {
    const existing = nodesByRef.get(frameRef);
    if (existing !== undefined) {
      return existing;
    }
    const descriptor = descriptorByRef.get(frameRef);
    if (descriptor === undefined) {
      return undefined;
    }
    if (visiting.has(frameRef)) {
      issues.push(makeIssue("error", "FrameCycleDetected", "$.frame_graph", `Cycle detected at frame ${frameRef}.`, "Break the frame parent cycle."));
      return undefined;
    }
    visiting.add(frameRef);
    const parent = descriptor.parent_frame_ref === undefined ? undefined : resolveNode(descriptor.parent_frame_ref);
    const parentTransform = descriptor.transform_from_parent ?? identityTransform(descriptor.frame_id);
    const transformFromBase = parent === undefined
      ? identityTransform(descriptor.frame_id)
      : composeTransforms(parent.transform_from_base, parentTransform, descriptor.frame_id);
    const node: ResolvedFrameNode = Object.freeze({
      frame_id: descriptor.frame_id,
      frame_role: descriptor.frame_role,
      parent_frame_ref: descriptor.parent_frame_ref,
      children_frame_refs: freezeArray((childrenByParent.get(descriptor.frame_id) ?? []).sort()),
      validity_scope: descriptor.validity_scope,
      transform_from_parent: freezeTransform(parentTransform),
      transform_from_base: freezeTransform(transformFromBase),
      depth: parent === undefined ? 0 : parent.depth + 1,
      uncertainty_m: round6((descriptor.uncertainty_m ?? 0) + (parent?.uncertainty_m ?? 0)),
      cognitive_label: sanitizeText(descriptor.cognitive_label),
      source: descriptor.frame_role === "estimated_map" ? "estimated_map" : descriptor.validity_scope === "task_scoped" || descriptor.frame_role === "tool" ? "tool_attachment" : "embodiment_descriptor",
      cognitive_visibility: descriptor.frame_role === "estimated_map" ? "estimate_relative" : "body_relative",
    });
    visiting.delete(frameRef);
    visited.add(frameRef);
    nodesByRef.set(frameRef, node);
    topologicalOrder.push(frameRef);
    return node;
  };

  const sortedRefs = [...descriptorByRef.keys()].sort((a, b) => {
    if (a === "B") {
      return -1;
    }
    if (b === "B") {
      return 1;
    }
    return a.localeCompare(b);
  });
  for (const frameRef of sortedRefs) {
    if (!visited.has(frameRef)) {
      resolveNode(frameRef);
    }
  }

  topologicalOrder.sort((a, b) => (nodesByRef.get(a)?.depth ?? 0) - (nodesByRef.get(b)?.depth ?? 0) || a.localeCompare(b));
  for (const node of nodesByRef.values()) {
    if (node.frame_id !== "B" && node.frame_id !== ESTIMATED_WORLD_FRAME_REF && node.parent_frame_ref === undefined) {
      issues.push(makeIssue("error", "FrameAttachmentInvalid", "$.frames", `Frame ${node.frame_id} is detached from the body graph.`, "Attach it to B or a declared descendant."));
    }
    if (node.frame_role !== "estimated_map" && !isDescendantOfBase(node.frame_id, nodesByRef)) {
      issues.push(makeIssue("error", "FrameAttachmentInvalid", "$.frames", `Frame ${node.frame_id} is not body-relative.`, "Attach body frames beneath B."));
    }
  }
  void model;
  return Object.freeze({ nodesByRef, topologicalOrder: freezeArray(topologicalOrder) });
}

function validateAttachmentClosure(model: EmbodimentDescriptor, nodesByRef: ReadonlyMap<Ref, ResolvedFrameNode>, issues: ValidationIssue[]): void {
  for (const mount of model.sensor_mounts) {
    const mountFrame = nodesByRef.get(mount.mount_frame_ref);
    const bodyFrame = nodesByRef.get(mount.body_frame_ref);
    if (mountFrame === undefined || mountFrame.frame_role !== "sensor") {
      issues.push(makeIssue("error", "SensorFrameDetached", "$.sensor_mounts", `Sensor ${mount.sensor_ref} mount frame ${mount.mount_frame_ref} is not a declared sensor frame.`, "Declare every sensor mount frame in the frame graph."));
    }
    if (bodyFrame === undefined || !isDescendantOfBase(mount.body_frame_ref, nodesByRef)) {
      issues.push(makeIssue("error", "SensorFrameDetached", "$.sensor_mounts", `Sensor ${mount.sensor_ref} body frame ${mount.body_frame_ref} is not body-relative.`, "Attach sensors to declared body frames."));
    }
    if (mountFrame !== undefined && !isDescendantOfBase(mountFrame.frame_id, nodesByRef)) {
      issues.push(makeIssue("error", "SensorFrameDetached", "$.sensor_mounts", `Sensor ${mount.sensor_ref} is not body-relative.`, "Attach sensor frames beneath B."));
    }
  }
  for (const site of model.contact_sites) {
    const contactFrame = nodesByRef.get(site.frame_ref);
    if (contactFrame === undefined || !isDescendantOfBase(site.frame_ref, nodesByRef)) {
      issues.push(makeIssue("error", "ContactFrameDetached", "$.contact_sites", `Contact site ${site.contact_site_ref} frame ${site.frame_ref} is not body-relative.`, "Map every contact to a declared body/contact frame."));
    }
  }
  for (const effector of model.end_effectors) {
    const effectorFrame = nodesByRef.get(effector.frame_ref);
    const chain = model.kinematic_chains.find((candidate) => candidate.end_effector_ref === effector.effector_ref || candidate.tip_frame_ref === effector.frame_ref);
    if (effectorFrame === undefined || !isDescendantOfBase(effector.frame_ref, nodesByRef)) {
      issues.push(makeIssue("error", "EndEffectorFrameDetached", "$.end_effectors", `End effector ${effector.effector_ref} frame ${effector.frame_ref} is not body-relative.`, "Attach every end-effector to a declared body frame."));
    }
    if (effector.frame_ref.startsWith("U_")) {
      continue;
    }
    if (chain === undefined) {
      issues.push(makeIssue("error", "EndEffectorFrameDetached", "$.kinematic_chains", `End effector ${effector.effector_ref} has no kinematic chain.`, "Declare a chain and actuator path for each end-effector."));
    }
  }
}

function validateFrameDescriptor(descriptor: FrameDescriptor, issues: ValidationIssue[]): void {
  validateRefInto(descriptor.frame_id, issues, "$.frame_id", "FrameRefInvalid");
  if (FORBIDDEN_FRAME_REFS.has(descriptor.frame_id) || descriptor.parent_frame_ref === "W") {
    issues.push(makeIssue("error", "ForbiddenWorldFrame", "$.frame_id", "Simulator world frame W is forbidden in embodiment frame graphs.", "Use B-relative frames or W_hat estimates."));
  }
  if (!isSafeText(descriptor.frame_id) || !isSafeText(descriptor.cognitive_label)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.frame_id", "Frame identifier or label contains forbidden backend detail.", "Strip engine handles and QA truth names."));
  }
  if (!["base", "torso", "head", "sensor", "contact", "end_effector", "tool", "estimated_map"].includes(descriptor.frame_role)) {
    issues.push(makeIssue("error", "FrameRoleInvalid", "$.frame_role", "Frame role is not recognized.", "Use a standard role from architecture section 5.7."));
  }
  if (!["permanent", "task_scoped"].includes(descriptor.validity_scope)) {
    issues.push(makeIssue("error", "FrameGraphInvalid", "$.validity_scope", "Validity scope must be permanent or task_scoped.", "Set tool frames to task_scoped and body frames to permanent."));
  }
  if (descriptor.frame_role === "tool" && descriptor.validity_scope !== "task_scoped") {
    issues.push(makeIssue("error", "ToolFrameInvalid", "$.validity_scope", "Tool frames must be task-scoped.", "Expire tool frames after release, task completion, or safety abort."));
  }
  if (descriptor.parent_frame_ref !== undefined) {
    validateRefInto(descriptor.parent_frame_ref, issues, "$.parent_frame_ref", "FrameRefInvalid");
  }
  if (descriptor.uncertainty_m !== undefined && (!Number.isFinite(descriptor.uncertainty_m) || descriptor.uncertainty_m < 0)) {
    issues.push(makeIssue("error", "FrameTransformInvalid", "$.uncertainty_m", "Frame uncertainty must be finite and nonnegative.", "Use calibrated uncertainty in meters."));
  }
  if (descriptor.transform_from_parent !== undefined) {
    try {
      validateTransform(descriptor.transform_from_parent, "$.transform_from_parent");
    } catch (error) {
      const caught = error instanceof FrameGraphProviderError ? error.issues : [makeIssue("error", "FrameTransformInvalid", "$.transform_from_parent", "Frame transform is invalid.", "Use finite position and unit quaternion.")];
      issues.push(...caught);
    }
  }
}

function isToolAttachmentParent(node: ResolvedFrameNode, model: EmbodimentDescriptor, input: ToolFrameAttachmentInput): boolean {
  if (node.frame_role === "tool") {
    return true;
  }
  if (node.frame_role === "end_effector") {
    return input.end_effector_ref === undefined || model.end_effectors.some((effector) => effector.effector_ref === input.end_effector_ref && effector.frame_ref === node.frame_id);
  }
  if (node.frame_role === "contact") {
    return input.contact_site_ref === undefined || model.contact_sites.some((site) => site.contact_site_ref === input.contact_site_ref && site.frame_ref === node.frame_id);
  }
  return model.end_effectors.some((effector) => effector.frame_ref === node.frame_id && (input.end_effector_ref === undefined || input.end_effector_ref === effector.effector_ref));
}

function pathToBase(frameRef: Ref, nodesByRef: ReadonlyMap<Ref, ResolvedFrameNode>): readonly Ref[] {
  const path: Ref[] = [];
  let cursor: Ref | undefined = frameRef;
  const seen = new Set<Ref>();
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = nodesByRef.get(cursor)?.parent_frame_ref;
  }
  return freezeArray(path);
}

function isDescendantOfBase(frameRef: Ref, nodesByRef: ReadonlyMap<Ref, ResolvedFrameNode>): boolean {
  return pathToBase(frameRef, nodesByRef).includes("B");
}

function identityTransform(frameRef: Ref): Transform {
  return freezeTransform({
    frame_ref: frameRef,
    position_m: ZERO_VECTOR,
    orientation_xyzw: IDENTITY_QUATERNION,
  });
}

function composeTransforms(parentToMiddle: Transform, middleToChild: Transform, childFrameRef: Ref): Transform {
  const orientation = normalizeQuaternion(quaternionMultiply(parentToMiddle.orientation_xyzw, middleToChild.orientation_xyzw));
  const rotatedPosition = rotateVector(parentToMiddle.orientation_xyzw, middleToChild.position_m);
  return freezeTransform({
    frame_ref: childFrameRef,
    position_m: addVectors(parentToMiddle.position_m, rotatedPosition),
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

function transformPointByTransform(point: Vector3, transform: Transform): Vector3 {
  return freezeVector3(addVectors(rotateVector(transform.orientation_xyzw, point), transform.position_m));
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
  const norm = Math.hypot(value[0], value[1], value[2], value[3]);
  if (norm < EPSILON) {
    throw new FrameGraphProviderError("Quaternion norm is zero.", [
      makeIssue("error", "FrameTransformInvalid", "$.orientation_xyzw", "Quaternion must have nonzero norm.", "Use a valid orientation quaternion."),
    ]);
  }
  return freezeQuaternion([value[0] / norm, value[1] / norm, value[2] / norm, value[3] / norm]);
}

function rotateVector(orientation: Quaternion, vector: Vector3): Vector3 {
  const q = normalizeQuaternion(orientation);
  const vectorQuaternion = freezeQuaternion([vector[0], vector[1], vector[2], 0]);
  const rotated = quaternionMultiply(quaternionMultiply(q, vectorQuaternion), quaternionConjugate(q));
  return freezeVector3([rotated[0], rotated[1], rotated[2]]);
}

function addVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function scaleVector(value: Vector3, scale: number): Vector3 {
  return freezeVector3([value[0] * scale, value[1] * scale, value[2] * scale]);
}

function validateTransform(value: Transform, path: string): void {
  assertSafeFrameRef(value.frame_ref, `${path}.frame_ref`);
  validateVector3(value.position_m, `${path}.position_m`);
  validateQuaternion(value.orientation_xyzw, `${path}.orientation_xyzw`);
}

function validateVector3(value: Vector3, path: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new FrameGraphProviderError("Vector3 is invalid.", [
      makeIssue("error", "FrameTransformInvalid", path, "Vector3 must contain exactly three finite meter values.", "Use [x, y, z]."),
    ]);
  }
}

function validateQuaternion(value: Quaternion, path: string): void {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    throw new FrameGraphProviderError("Quaternion is invalid.", [
      makeIssue("error", "FrameTransformInvalid", path, "Quaternion must contain exactly four finite values.", "Use [x, y, z, w]."),
    ]);
  }
  const norm = Math.hypot(value[0], value[1], value[2], value[3]);
  if (norm < EPSILON || Math.abs(norm - 1) > 1e-6) {
    throw new FrameGraphProviderError("Quaternion must be unit length.", [
      makeIssue("error", "FrameTransformInvalid", path, "Quaternion must be normalized to unit length.", "Normalize the orientation quaternion."),
    ]);
  }
}

function assertSafeFrameRef(frameRef: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateRefInto(frameRef, issues, path, "FrameRefInvalid");
  if (FORBIDDEN_FRAME_REFS.has(frameRef)) {
    issues.push(makeIssue("error", "ForbiddenWorldFrame", path, "Simulator world frame W is QA/validator-only and cannot be queried here.", "Query B-relative or W_hat estimate-relative frames."));
  }
  if (!isSafeText(frameRef)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Frame ref contains forbidden simulator/backend detail.", "Use sanitized body frame refs."));
  }
  if (issues.length > 0) {
    throw new FrameGraphProviderError("Frame reference is not safe for embodiment use.", issues);
  }
}

function validateRefInto(value: Ref, issues: ValidationIssue[], path: string, code: FrameGraphIssueCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque frame reference."));
  }
}

function sensorMountSummary(mount: SensorMountDescriptor): string {
  return sanitizeText(`${mount.sensor_role}:${mount.sensor_ref} frame ${mount.mount_frame_ref} attached to ${mount.body_frame_ref}`);
}

function contactSiteSummary(site: ContactSiteDescriptor): string {
  return sanitizeText(`${site.contact_role}:${site.contact_site_ref} frame ${site.frame_ref} nominal_support=${site.nominal_support}`);
}

function endEffectorSummary(effector: EndEffectorDescriptor): string {
  return sanitizeText(`${effector.role}:${effector.effector_ref} frame ${effector.frame_ref} reach ${round3(effector.natural_reach_radius_m)}m`);
}

function makeIssue(severity: ValidationSeverity, code: FrameGraphIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray(["simulator_world_frame_W", "backend_body_handles", "engine_frame_handles", "collision_mesh_refs", "exact_hidden_com", "qa_truth_refs"]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function isSafeText(value: string): boolean {
  return !FORBIDDEN_DETAIL_PATTERN.test(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeTransform(value: Transform): Transform {
  return Object.freeze({
    frame_ref: value.frame_ref,
    position_m: freezeVector3(value.position_m),
    orientation_xyzw: freezeQuaternion(value.orientation_xyzw),
  });
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const FRAME_GRAPH_PROVIDER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: FRAME_GRAPH_PROVIDER_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.7", "5.8", "5.9", "5.15", "5.16", "5.19"]),
});
