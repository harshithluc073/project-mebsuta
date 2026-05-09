/**
 * Kinematic chain registry for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.7, 5.10, 5.11, 5.18, 5.19, and 5.20.
 *
 * This module is the executable chain authority consumed by IK, control,
 * manipulation, and validation services. It resolves declared body chains,
 * validates frame/joint/actuator/end-effector coverage, computes planar IK
 * with joint-limit and singularity checks, and exposes cognitive-safe chain
 * summaries without leaking simulator world truth, backend handles, hidden
 * collision meshes, or QA coordinates.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type {
  ActuatorLimitDescriptor,
  ContactSiteDescriptor,
  EmbodimentDescriptor,
  EndEffectorDescriptor,
  EndEffectorRole,
  FrameDescriptor,
  FrameRole,
  JointDescriptor,
  JointGroup,
  KinematicChainDescriptor,
} from "./embodiment_model_registry";

export const KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION = "mebsuta.kinematic_chain_registry.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_FRAME_REFS = new Set<Ref>(["W"]);
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|joint_handle|rigid_body_handle|physics_body)/i;

export type KinematicChainIssueCode =
  | "ActiveEmbodimentMissing"
  | "ChainRefInvalid"
  | "ChainMissing"
  | "ChainDuplicated"
  | "FrameMissing"
  | "ForbiddenWorldFrame"
  | "ForbiddenBodyDetail"
  | "JointMissing"
  | "JointOrderInvalid"
  | "JointLimitInvalid"
  | "ActuatorPathMissing"
  | "EndEffectorMissing"
  | "EndEffectorCoverageMissing"
  | "LinkLengthInvalid"
  | "ReachEnvelopeInvalid"
  | "IKInputInvalid"
  | "IKUnreachable"
  | "IKLimitViolation"
  | "SingularityRisk"
  | "ToolChainInvalid"
  | "LocomotionChainIncomplete";

export type ChainSource = "declared" | "synthesized_locomotion_contact" | "synthesized_tool_attachment";
export type ChainCategory = "gaze" | "locomotion" | "manipulation" | "gripper" | "tool" | "body_stabilization";
export type SingularityClass = "clear" | "near_folded" | "near_extended" | "degenerate" | "not_applicable";

export interface KinematicChainRegistryConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
  readonly synthesize_contact_locomotion_chains?: boolean;
  readonly synthesize_tool_chains?: boolean;
}

export interface ChainSelectionInput {
  readonly embodiment_ref?: Ref;
  readonly chain_ref?: Ref;
  readonly chain_role?: KinematicChainDescriptor["chain_role"];
  readonly end_effector_role?: EndEffectorRole;
  readonly include_synthesized?: boolean;
}

export interface ResolvedJointInChain {
  readonly order_index: number;
  readonly joint_ref: Ref;
  readonly joint_group: JointGroup;
  readonly joint_type: JointDescriptor["joint_type"];
  readonly parent_frame_ref: Ref;
  readonly child_frame_ref: Ref;
  readonly axis_local: Vector3;
  readonly min_position: number;
  readonly max_position: number;
  readonly home_position: number;
  readonly safety_margin: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly actuator_refs: readonly Ref[];
  readonly command_interfaces: readonly string[];
}

export interface ResolvedKinematicChain {
  readonly schema_version: typeof KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly chain_ref: Ref;
  readonly chain_role: KinematicChainDescriptor["chain_role"];
  readonly chain_category: ChainCategory;
  readonly chain_source: ChainSource;
  readonly root_frame_ref: Ref;
  readonly root_frame_role: FrameRole;
  readonly tip_frame_ref: Ref;
  readonly tip_frame_role: FrameRole;
  readonly end_effector_ref?: Ref;
  readonly end_effector_role?: EndEffectorRole;
  readonly active_dof_count: number;
  readonly joint_refs: readonly Ref[];
  readonly joints: readonly ResolvedJointInChain[];
  readonly link_lengths_m: readonly number[];
  readonly link_length_sum_m: number;
  readonly nominal_reach_m: number;
  readonly conservative_reach_m: number;
  readonly min_folded_reach_m: number;
  readonly max_payload_kg: number;
  readonly actuator_refs: readonly Ref[];
  readonly contact_site_refs: readonly Ref[];
  readonly self_collision_policy_ref: Ref;
  readonly preferred_rest_posture_ref: Ref;
  readonly singularity_policy_ref: Ref;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface KinematicChainRegistryReport {
  readonly schema_version: typeof KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly chain_count: number;
  readonly declared_chain_count: number;
  readonly synthesized_chain_count: number;
  readonly gaze_chain_count: number;
  readonly locomotion_chain_count: number;
  readonly manipulation_chain_count: number;
  readonly tool_chain_count: number;
  readonly active_dof_count: number;
  readonly chains: readonly ResolvedKinematicChain[];
  readonly end_effector_coverage: readonly EndEffectorChainCoverage[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export interface EndEffectorChainCoverage {
  readonly end_effector_ref: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly frame_ref: Ref;
  readonly covered_by_chain_refs: readonly Ref[];
  readonly has_actuator_path: boolean;
  readonly natural_reach_radius_m: number;
  readonly tool_extended_reach_radius_m?: number;
  readonly ok: boolean;
}

export interface ChainReachEnvelope {
  readonly schema_version: typeof KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly target_distance_m: number;
  readonly radial_distance_m: number;
  readonly vertical_offset_m: number;
  readonly min_reach_m: number;
  readonly max_reach_m: number;
  readonly conservative_reach_m: number;
  readonly reach_margin_m: number;
  readonly singularity_class: SingularityClass;
  readonly reachable: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ChainPlanarIKInput {
  readonly embodiment_ref?: Ref;
  readonly chain_ref: Ref;
  readonly target_in_root_frame_m: Vector3;
  readonly elbow_preference?: "up" | "down";
  readonly clamp_to_joint_limits?: boolean;
}

export interface ChainPlanarIKReport {
  readonly schema_version: typeof KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION;
  readonly ik_report_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly feasible: boolean;
  readonly root_angle_rad: number;
  readonly elbow_angle_rad: number;
  readonly residual_m: number;
  readonly target_distance_m: number;
  readonly singularity_class: SingularityClass;
  readonly joint_solution: Readonly<Record<Ref, number>>;
  readonly applied_joint_limits: readonly {
    readonly joint_ref: Ref;
    readonly requested_position: number;
    readonly limited_position: number;
    readonly min_safe_position: number;
    readonly max_safe_position: number;
    readonly inside_safe_limits: boolean;
  }[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveChainSummary {
  readonly schema_version: typeof KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly chain_summaries: readonly string[];
  readonly end_effector_coverage_summary: readonly string[];
  readonly reach_summary: readonly string[];
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "body_self_knowledge_without_simulator_world_truth";
  readonly determinism_hash: string;
}

export class KinematicChainRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "KinematicChainRegistryError";
    this.issues = issues;
  }
}

/**
 * Resolves declared and synthesized body chains into a validated control-ready
 * catalog while preserving body-relative simulator blindness.
 */
export class KinematicChainRegistry {
  private readonly registry: EmbodimentModelRegistry;
  private readonly synthesizeContactLocomotionChains: boolean;
  private readonly synthesizeToolChains: boolean;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: KinematicChainRegistryConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.activeEmbodimentRef = config.active_embodiment_ref ?? config.embodiment?.embodiment_id;
    this.synthesizeContactLocomotionChains = config.synthesize_contact_locomotion_chains ?? true;
    this.synthesizeToolChains = config.synthesize_tool_chains ?? true;
    if (this.activeEmbodimentRef !== undefined) {
      this.registry.selectActiveEmbodiment({ embodiment_ref: this.activeEmbodimentRef });
    }
  }

  /**
   * Selects the active body model and immediately returns the resolved chain
   * report for deterministic handoff into controls.
   */
  public selectActiveEmbodiment(embodimentRef: Ref): KinematicChainRegistryReport {
    assertSafeRef(embodimentRef, "$.embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: embodimentRef });
    this.activeEmbodimentRef = embodimentRef;
    return this.buildRegistryReport({ embodiment_ref: embodimentRef });
  }

  /**
   * Builds a complete chain catalog for an embodiment, including optional
   * contact locomotion and task-scoped tool attachment chains synthesized from
   * declared frames, contacts, and end effectors.
   */
  public buildRegistryReport(selection: ChainSelectionInput = {}): KinematicChainRegistryReport {
    const model = this.requireEmbodiment(selection.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const chains = this.resolveChains(model, selection, issues);
    const coverage = buildEndEffectorCoverage(model, chains, issues);
    validateRequiredChainCategories(model, chains, issues);

    const base = {
      schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      chain_count: chains.length,
      declared_chain_count: chains.filter((chain) => chain.chain_source === "declared").length,
      synthesized_chain_count: chains.filter((chain) => chain.chain_source !== "declared").length,
      gaze_chain_count: chains.filter((chain) => chain.chain_role === "gaze").length,
      locomotion_chain_count: chains.filter((chain) => chain.chain_role === "locomotion").length,
      manipulation_chain_count: chains.filter((chain) => chain.chain_role === "manipulation" || chain.chain_role === "gripper").length,
      tool_chain_count: chains.filter((chain) => chain.chain_role === "tool").length,
      active_dof_count: chains.reduce((sum, chain) => sum + chain.active_dof_count, 0),
      chains,
      end_effector_coverage: coverage,
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
   * Returns a single resolved chain and throws if the chain is missing or the
   * resolved chain catalog has validation errors.
   */
  public requireChain(chainRef: Ref, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ResolvedKinematicChain {
    assertSafeRef(chainRef, "$.chain_ref");
    const report = this.buildRegistryReport({ embodiment_ref: embodimentRef, include_synthesized: true });
    const chain = report.chains.find((candidate) => candidate.chain_ref === chainRef);
    if (chain === undefined) {
      throw new KinematicChainRegistryError("Kinematic chain is not declared for the embodiment.", [
        makeIssue("error", "ChainMissing", "$.chain_ref", `Chain ${chainRef} is not available on ${embodimentRef}.`, "Choose a chain from the active kinematic chain report."),
      ]);
    }
    if (!chain.ok) {
      throw new KinematicChainRegistryError("Kinematic chain failed validation.", chain.issues);
    }
    return chain;
  }

  /**
   * Estimates body-relative reach for a chain target using link-length geometry.
   * The report is conservative because it subtracts declared safety margins and
   * classifies near-folded or near-extended singular configurations.
   */
  public evaluateChainReach(chainRef: Ref, targetInRootFrameM: Vector3, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ChainReachEnvelope {
    validateVector3(targetInRootFrameM, "$.target_in_root_frame_m");
    const chain = this.requireChain(chainRef, embodimentRef);
    const issues: ValidationIssue[] = [...chain.issues];
    const radial = Math.hypot(targetInRootFrameM[0], targetInRootFrameM[1]);
    const vertical = targetInRootFrameM[2];
    const distance = Math.hypot(radial, vertical);
    const singularity = classifySingularity(distance, chain.min_folded_reach_m, chain.link_length_sum_m);
    if (distance > chain.conservative_reach_m + EPSILON) {
      issues.push(makeIssue("warning", "IKUnreachable", "$.target_in_root_frame_m", "Target is outside conservative chain reach.", "Use posture adjustment, repositioning, or a validated tool."));
    }
    if (distance < chain.min_folded_reach_m - EPSILON) {
      issues.push(makeIssue("warning", "SingularityRisk", "$.target_in_root_frame_m", "Target is inside the chain folded reach boundary.", "Back the target away from the root frame or choose another effector."));
    }
    if (singularity !== "clear" && singularity !== "not_applicable") {
      issues.push(makeIssue("warning", "SingularityRisk", "$.target_in_root_frame_m", `Target is ${singularity.replace("_", " ")} for chain ${chain.chain_ref}.`, "Keep the target away from fully folded or fully extended postures."));
    }
    const base = {
      schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: chain.embodiment_ref,
      chain_ref: chain.chain_ref,
      target_distance_m: round6(distance),
      radial_distance_m: round6(radial),
      vertical_offset_m: round6(vertical),
      min_reach_m: round6(chain.min_folded_reach_m),
      max_reach_m: round6(chain.link_length_sum_m),
      conservative_reach_m: chain.conservative_reach_m,
      reach_margin_m: round6(chain.conservative_reach_m - distance),
      singularity_class: singularity,
      reachable: distance <= chain.conservative_reach_m + EPSILON && distance >= chain.min_folded_reach_m - EPSILON,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Solves a two-link planar IK problem in the chain root frame using the law
   * of cosines. The first two chain joints receive root and elbow angles, then
   * the solution is checked against declared safety margins and optionally
   * clamped to safe joint limits for control initialization.
   */
  public solvePlanarTwoLinkIK(input: ChainPlanarIKInput): ChainPlanarIKReport {
    validateVector3(input.target_in_root_frame_m, "$.target_in_root_frame_m");
    const chain = this.requireChain(input.chain_ref, input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [...chain.issues];
    if (chain.link_lengths_m.length < 2 || chain.joints.length < 2) {
      issues.push(makeIssue("error", "IKInputInvalid", "$.chain_ref", "Planar two-link IK requires at least two links and two actuated joints.", "Use an arm, mouth, paw, or tool chain with two controllable joints."));
      return buildIKReport(chain, input.target_in_root_frame_m, 0, 0, vectorNorm(input.target_in_root_frame_m), "not_applicable", {}, [], issues);
    }

    const l1 = chain.link_lengths_m[0];
    const l2 = chain.link_lengths_m[1];
    const radial = Math.hypot(input.target_in_root_frame_m[0], input.target_in_root_frame_m[1]);
    const vertical = input.target_in_root_frame_m[2];
    const targetDistance = Math.hypot(radial, vertical);
    if (!Number.isFinite(targetDistance) || targetDistance < EPSILON) {
      issues.push(makeIssue("error", "IKInputInvalid", "$.target_in_root_frame_m", "IK target must be a finite nonzero body-relative point.", "Use a sensor-derived target in the chain root frame."));
      return buildIKReport(chain, input.target_in_root_frame_m, 0, 0, 0, "degenerate", {}, [], issues);
    }

    const maxReach = l1 + l2;
    const minReach = Math.abs(l1 - l2);
    const clampedDistance = clamp(targetDistance, minReach, maxReach);
    const residual = Math.abs(targetDistance - clampedDistance);
    if (targetDistance > maxReach + EPSILON || targetDistance < minReach - EPSILON) {
      issues.push(makeIssue("warning", "IKUnreachable", "$.target_in_root_frame_m", "Target falls outside exact two-link reach bounds.", "Move the base, adjust posture, or choose another chain."));
    }

    const elbowSign = input.elbow_preference === "down" ? -1 : 1;
    const cosElbow = clamp((clampedDistance * clampedDistance - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
    const elbow = elbowSign * Math.acos(cosElbow);
    const shoulder = Math.atan2(vertical, radial) - Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));
    const singularity = classifySingularity(clampedDistance, minReach, maxReach);

    const rawSolution: Record<Ref, number> = {
      [chain.joints[0].joint_ref]: round6(shoulder),
      [chain.joints[1].joint_ref]: round6(elbow),
    };
    const appliedLimits = chain.joints.slice(0, 2).map((joint) => {
      const requested = rawSolution[joint.joint_ref] ?? 0;
      const minSafe = joint.min_position + joint.safety_margin;
      const maxSafe = joint.max_position - joint.safety_margin;
      const insideSafe = requested >= minSafe - EPSILON && requested <= maxSafe + EPSILON;
      if (!insideSafe) {
        issues.push(makeIssue("warning", "IKLimitViolation", `$.joint_solution.${joint.joint_ref}`, `Joint ${joint.joint_ref} is outside safe limits for this IK solution.`, "Reposition, choose another posture, or enable clamped initialization."));
      }
      const limited = input.clamp_to_joint_limits === true ? clamp(requested, minSafe, maxSafe) : requested;
      return Object.freeze({
        joint_ref: joint.joint_ref,
        requested_position: round6(requested),
        limited_position: round6(limited),
        min_safe_position: round6(minSafe),
        max_safe_position: round6(maxSafe),
        inside_safe_limits: insideSafe,
      });
    });
    const solution = appliedLimits.reduce<Record<Ref, number>>((accumulator, limit) => {
      accumulator[limit.joint_ref] = limit.limited_position;
      return accumulator;
    }, {});
    if (singularity !== "clear") {
      issues.push(makeIssue("warning", "SingularityRisk", "$.target_in_root_frame_m", `IK solution is ${singularity.replace("_", " ")}.`, "Prefer a target with more elbow bend and margin from reach limits."));
    }

    return buildIKReport(chain, input.target_in_root_frame_m, shoulder, elbow, residual, singularity, solution, appliedLimits, issues);
  }

  /**
   * Returns a prompt-safe chain summary with only body capability, reach, and
   * limitation information. Internal collision, backend, and world-truth fields
   * are omitted by construction.
   */
  public buildCognitiveChainSummary(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): CognitiveChainSummary {
    const report = this.buildRegistryReport({ embodiment_ref: embodimentRef, include_synthesized: true });
    assertNoForbiddenLeak(report);
    const base = {
      schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      chain_summaries: freezeArray(report.chains.map((chain) => sanitizeText(`${chain.chain_category}:${chain.chain_ref} ${chain.active_dof_count}DOF reach ${round3(chain.conservative_reach_m)}m payload ${round3(chain.max_payload_kg)}kg`)).sort()),
      end_effector_coverage_summary: freezeArray(report.end_effector_coverage.map((coverage) => sanitizeText(`${coverage.end_effector_role}:${coverage.end_effector_ref} chains=${coverage.covered_by_chain_refs.join(",") || "none"} actuator_path=${coverage.has_actuator_path}`)).sort()),
      reach_summary: freezeArray(report.chains.map((chain) => sanitizeText(`${chain.chain_ref} min ${round3(chain.min_folded_reach_m)}m max ${round3(chain.link_length_sum_m)}m conservative ${round3(chain.conservative_reach_m)}m`)).sort()),
      hidden_fields_removed: hiddenFieldsRemoved(),
      cognitive_visibility: "body_self_knowledge_without_simulator_world_truth" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
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

  private resolveChains(model: EmbodimentDescriptor, selection: ChainSelectionInput, issues: ValidationIssue[]): readonly ResolvedKinematicChain[] {
    const includeSynthesized = selection.include_synthesized ?? true;
    const descriptors = [
      ...model.kinematic_chains.map((descriptor) => ({ descriptor, source: "declared" as const })),
      ...(includeSynthesized && this.synthesizeContactLocomotionChains ? synthesizeLocomotionChains(model) : []),
      ...(includeSynthesized && this.synthesizeToolChains ? synthesizeToolChains(model) : []),
    ];
    const seen = new Set<Ref>();
    const resolved = descriptors
      .filter(({ descriptor }) => selection.chain_ref === undefined || descriptor.chain_ref === selection.chain_ref)
      .filter(({ descriptor }) => selection.chain_role === undefined || descriptor.chain_role === selection.chain_role)
      .filter(({ descriptor }) => selection.end_effector_role === undefined || endEffectorForChain(model, descriptor)?.role === selection.end_effector_role)
      .map(({ descriptor, source }) => {
        if (seen.has(descriptor.chain_ref)) {
          issues.push(makeIssue("error", "ChainDuplicated", "$.chain_ref", `Chain ${descriptor.chain_ref} is duplicated.`, "Use unique chain references."));
        }
        seen.add(descriptor.chain_ref);
        return resolveChain(model, descriptor, source, issues);
      });
    if (selection.chain_ref !== undefined && resolved.length === 0) {
      issues.push(makeIssue("error", "ChainMissing", "$.chain_ref", `Chain ${selection.chain_ref} is not available.`, "Choose a declared or synthesized chain from the active embodiment."));
    }
    return freezeArray(resolved.sort((a, b) => a.chain_ref.localeCompare(b.chain_ref)));
  }
}

export function createKinematicChainRegistry(config: KinematicChainRegistryConfig = {}): KinematicChainRegistry {
  return new KinematicChainRegistry(config);
}

function resolveChain(model: EmbodimentDescriptor, descriptor: KinematicChainDescriptor, source: ChainSource, sharedIssues: ValidationIssue[]): ResolvedKinematicChain {
  const issues: ValidationIssue[] = [];
  validateChainDescriptor(model, descriptor, source, issues);
  const frames = new Map(model.frame_graph.map((frame) => [frame.frame_id, frame]));
  const jointsByRef = new Map(model.joints.map((joint) => [joint.joint_ref, joint]));
  const actuatorsByJoint = groupActuatorsByJoint(model.actuator_limits);
  const root = frames.get(descriptor.root_frame_ref);
  const tip = frames.get(descriptor.tip_frame_ref);
  const effector = endEffectorForChain(model, descriptor);
  const joints = descriptor.joint_refs.map((jointRef, index) => {
    const joint = jointsByRef.get(jointRef);
    if (joint === undefined) {
      issues.push(makeIssue("error", "JointMissing", `$.kinematic_chains.${descriptor.chain_ref}.joint_refs`, `Joint ${jointRef} is not declared.`, "Declare every chain joint in the embodiment joint catalog."));
      return undefined;
    }
    const actuators = actuatorsByJoint.get(jointRef) ?? [];
    if (actuators.length === 0) {
      issues.push(makeIssue("error", "ActuatorPathMissing", `$.kinematic_chains.${descriptor.chain_ref}.joint_refs.${jointRef}`, `Joint ${jointRef} has no actuator path.`, "Bind every chain joint to an actuator limit descriptor."));
    }
    return resolveJoint(index, joint, actuators);
  }).filter((joint): joint is ResolvedJointInChain => joint !== undefined);
  const linkSum = descriptor.link_lengths_m.reduce((sum, value) => sum + value, 0);
  const minFolded = foldedReach(descriptor.link_lengths_m);
  const safetyMargin = Math.max(...joints.map((joint) => joint.safety_margin), 0.015);
  const conservativeReach = Math.max(0, Math.min(descriptor.nominal_reach_m, linkSum) - safetyMargin);
  const contacts = model.contact_sites
    .filter((site) => site.frame_ref === descriptor.tip_frame_ref || site.frame_ref === effector?.frame_ref)
    .map((site) => site.contact_site_ref);
  const actuatorRefs = [...new Set(joints.flatMap((joint) => joint.actuator_refs))].sort();
  const base = {
    schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    chain_ref: descriptor.chain_ref,
    chain_role: descriptor.chain_role,
    chain_category: chainCategory(descriptor, source, model),
    chain_source: source,
    root_frame_ref: descriptor.root_frame_ref,
    root_frame_role: root?.frame_role ?? "base",
    tip_frame_ref: descriptor.tip_frame_ref,
    tip_frame_role: tip?.frame_role ?? "end_effector",
    end_effector_ref: effector?.effector_ref,
    end_effector_role: effector?.role,
    active_dof_count: joints.filter((joint) => joint.joint_type !== "fixed").length,
    joint_refs: freezeArray(descriptor.joint_refs),
    joints: freezeArray(joints),
    link_lengths_m: freezeArray(descriptor.link_lengths_m.map(round6)),
    link_length_sum_m: round6(linkSum),
    nominal_reach_m: round6(descriptor.nominal_reach_m),
    conservative_reach_m: round6(conservativeReach),
    min_folded_reach_m: round6(minFolded),
    max_payload_kg: round6(descriptor.max_payload_kg),
    actuator_refs: freezeArray(actuatorRefs),
    contact_site_refs: freezeArray(contacts.sort()),
    self_collision_policy_ref: `${model.embodiment_kind}_${descriptor.chain_ref}_self_collision_policy`,
    preferred_rest_posture_ref: `${model.embodiment_kind}_${descriptor.chain_ref}_rest_posture`,
    singularity_policy_ref: `${model.embodiment_kind}_${descriptor.chain_ref}_singularity_policy`,
    issues: freezeArray(issues),
    ok: !issues.some((issue) => issue.severity === "error"),
  };
  sharedIssues.push(...issues);
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateChainDescriptor(model: EmbodimentDescriptor, descriptor: KinematicChainDescriptor, source: ChainSource, issues: ValidationIssue[]): void {
  validateSafeRef(descriptor.chain_ref, issues, "$.chain_ref", "ChainRefInvalid");
  validateSafeRef(descriptor.root_frame_ref, issues, `$.kinematic_chains.${descriptor.chain_ref}.root_frame_ref`, "FrameMissing");
  validateSafeRef(descriptor.tip_frame_ref, issues, `$.kinematic_chains.${descriptor.chain_ref}.tip_frame_ref`, "FrameMissing");
  const frameRefs = new Set(model.frame_graph.map((frame) => frame.frame_id));
  if (!frameRefs.has(descriptor.root_frame_ref) || !frameRefs.has(descriptor.tip_frame_ref)) {
    issues.push(makeIssue("error", "FrameMissing", `$.kinematic_chains.${descriptor.chain_ref}`, "Chain root and tip frames must be declared body frames.", "Attach chains to declared base, torso, head, sensor, contact, end-effector, or tool frames."));
  }
  if (descriptor.link_lengths_m.length === 0 || descriptor.link_lengths_m.some((length) => !Number.isFinite(length) || length <= 0)) {
    issues.push(makeIssue("error", "LinkLengthInvalid", `$.kinematic_chains.${descriptor.chain_ref}.link_lengths_m`, "Link lengths must be finite positive meters.", "Declare calibrated link lengths for reach and IK."));
  }
  if (!Number.isFinite(descriptor.nominal_reach_m) || descriptor.nominal_reach_m <= 0) {
    issues.push(makeIssue("error", "ReachEnvelopeInvalid", `$.kinematic_chains.${descriptor.chain_ref}.nominal_reach_m`, "Nominal reach must be finite and positive.", "Declare a positive chain reach."));
  }
  if (!Number.isFinite(descriptor.max_payload_kg) || descriptor.max_payload_kg < 0) {
    issues.push(makeIssue("error", "ReachEnvelopeInvalid", `$.kinematic_chains.${descriptor.chain_ref}.max_payload_kg`, "Payload must be finite and nonnegative.", "Declare a safe payload bound."));
  }
  if (descriptor.end_effector_ref !== undefined && !model.end_effectors.some((effector) => effector.effector_ref === descriptor.end_effector_ref)) {
    issues.push(makeIssue("error", "EndEffectorMissing", `$.kinematic_chains.${descriptor.chain_ref}.end_effector_ref`, "Chain end effector is not declared.", "Bind chain to a declared end effector."));
  }
  if (descriptor.joint_refs.length === 0 && source !== "synthesized_locomotion_contact") {
    issues.push(makeIssue("error", "JointMissing", `$.kinematic_chains.${descriptor.chain_ref}.joint_refs`, "Non-contact chain must contain at least one actuated joint.", "Declare ordered joints for gaze, manipulation, gripper, and tool chains."));
  }
  validateJointOrdering(model, descriptor, issues);
}

function validateJointOrdering(model: EmbodimentDescriptor, descriptor: KinematicChainDescriptor, issues: ValidationIssue[]): void {
  const joints = descriptor.joint_refs
    .map((jointRef) => model.joints.find((joint) => joint.joint_ref === jointRef))
    .filter((joint): joint is JointDescriptor => joint !== undefined);
  for (let index = 1; index < joints.length; index += 1) {
    const previous = joints[index - 1];
    const current = joints[index];
    if (previous.child_frame_ref !== current.parent_frame_ref && previous.child_frame_ref !== current.child_frame_ref && previous.parent_frame_ref !== current.parent_frame_ref) {
      issues.push(makeIssue("warning", "JointOrderInvalid", `$.kinematic_chains.${descriptor.chain_ref}.joint_refs`, `Joint ${current.joint_ref} is not directly contiguous with ${previous.joint_ref}.`, "Keep joint sequence ordered from root toward tip when model topology permits it."));
    }
  }
}

function resolveJoint(index: number, joint: JointDescriptor, actuators: readonly ActuatorLimitDescriptor[]): ResolvedJointInChain {
  return Object.freeze({
    order_index: index,
    joint_ref: joint.joint_ref,
    joint_group: joint.joint_group,
    joint_type: joint.joint_type,
    parent_frame_ref: joint.parent_frame_ref,
    child_frame_ref: joint.child_frame_ref,
    axis_local: freezeVector3(joint.axis_local),
    min_position: round6(joint.min_position),
    max_position: round6(joint.max_position),
    home_position: round6(joint.home_position),
    safety_margin: round6(joint.safety_margin),
    max_velocity: round6(joint.max_velocity),
    max_effort: round6(joint.max_effort),
    actuator_refs: freezeArray(actuators.map((actuator) => actuator.actuator_ref).sort()),
    command_interfaces: freezeArray([...new Set(actuators.flatMap((actuator) => actuator.command_interfaces))].sort()),
  });
}

function synthesizeLocomotionChains(model: EmbodimentDescriptor): readonly { readonly descriptor: KinematicChainDescriptor; readonly source: ChainSource }[] {
  const supportContacts = model.contact_sites.filter((site) => site.nominal_support);
  return freezeArray(supportContacts.map((site) => {
    const supportJoints = locomotionJointsForContact(model, site);
    const nominal = site.frame_ref.startsWith("C_") ? 0.34 : Math.max(model.stability_policy.nominal_center_of_mass_height_m, 0.1);
    return Object.freeze({
      source: "synthesized_locomotion_contact" as const,
      descriptor: freezeChain({
        chain_ref: `${model.embodiment_kind}_${site.contact_site_ref}_locomotion_chain`,
        chain_role: "locomotion",
        root_frame_ref: "B",
        tip_frame_ref: site.frame_ref,
        joint_refs: supportJoints,
        link_lengths_m: supportJoints.length >= 2 ? [nominal * 0.55, nominal * 0.45] : [nominal],
        nominal_reach_m: nominal,
        max_payload_kg: 0,
      }),
    });
  }));
}

function synthesizeToolChains(model: EmbodimentDescriptor): readonly { readonly descriptor: KinematicChainDescriptor; readonly source: ChainSource }[] {
  const toolEffectors = model.end_effectors.filter((effector) => effector.role === "tool_tip");
  return freezeArray(toolEffectors.map((effector) => {
    const parentChain = bestToolParentChain(model, effector);
    const parentJoints = parentChain?.joint_refs ?? [];
    const natural = effector.natural_reach_radius_m;
    const declaredParentReach = parentChain?.nominal_reach_m ?? natural;
    const extension = Math.max(0.05, natural - declaredParentReach);
    return Object.freeze({
      source: "synthesized_tool_attachment" as const,
      descriptor: freezeChain({
        chain_ref: `${model.embodiment_kind}_${effector.effector_ref}_tool_chain`,
        chain_role: "tool",
        root_frame_ref: parentChain?.root_frame_ref ?? "B",
        tip_frame_ref: effector.frame_ref,
        joint_refs: parentJoints,
        end_effector_ref: effector.effector_ref,
        link_lengths_m: parentChain === undefined ? [natural] : freezeArray([...parentChain.link_lengths_m, extension]),
        nominal_reach_m: natural,
        max_payload_kg: Math.max(parentChain?.max_payload_kg ?? 0, 0.25),
      }),
    });
  }));
}

function locomotionJointsForContact(model: EmbodimentDescriptor, site: ContactSiteDescriptor): readonly Ref[] {
  if (model.embodiment_kind === "quadruped") {
    const isFront = site.contact_site_ref.includes("front");
    const group = isFront ? "front_leg" : "rear_leg";
    const preferred = model.joints.filter((joint) => joint.joint_group === group).map((joint) => joint.joint_ref);
    if (preferred.length > 0) {
      return freezeArray(preferred);
    }
  }
  const fallbackGroups: readonly JointGroup[] = model.embodiment_kind === "humanoid" ? ["base", "torso"] : ["front_leg", "rear_leg", "torso"];
  return freezeArray(model.joints.filter((joint) => fallbackGroups.includes(joint.joint_group)).map((joint) => joint.joint_ref).slice(0, 2));
}

function bestToolParentChain(model: EmbodimentDescriptor, toolEffector: EndEffectorDescriptor): KinematicChainDescriptor | undefined {
  const parentFrame = model.frame_graph.find((frame) => frame.frame_id === toolEffector.frame_ref)?.parent_frame_ref;
  return model.kinematic_chains
    .filter((chain) => chain.chain_role === "manipulation" || chain.chain_role === "gripper")
    .sort((a, b) => {
      const aParentMatch = a.tip_frame_ref === parentFrame || a.end_effector_ref === parentFrame ? 0 : 1;
      const bParentMatch = b.tip_frame_ref === parentFrame || b.end_effector_ref === parentFrame ? 0 : 1;
      return aParentMatch - bParentMatch || b.nominal_reach_m - a.nominal_reach_m;
    })[0];
}

function buildEndEffectorCoverage(model: EmbodimentDescriptor, chains: readonly ResolvedKinematicChain[], issues: ValidationIssue[]): readonly EndEffectorChainCoverage[] {
  return freezeArray(model.end_effectors.map((effector) => {
    const coveringChains = chains.filter((chain) => chain.end_effector_ref === effector.effector_ref || chain.tip_frame_ref === effector.frame_ref);
    const hasActuatorPath = coveringChains.some((chain) => chain.actuator_refs.length > 0 || chain.chain_source === "synthesized_locomotion_contact");
    const ok = coveringChains.length > 0 && hasActuatorPath;
    if (!ok) {
      issues.push(makeIssue("error", "EndEffectorCoverageMissing", `$.end_effectors.${effector.effector_ref}`, `End effector ${effector.effector_ref} has no complete kinematic chain and actuator path.`, "Declare or synthesize a chain that reaches this end-effector frame."));
    }
    return Object.freeze({
      end_effector_ref: effector.effector_ref,
      end_effector_role: effector.role,
      frame_ref: effector.frame_ref,
      covered_by_chain_refs: freezeArray(coveringChains.map((chain) => chain.chain_ref).sort()),
      has_actuator_path: hasActuatorPath,
      natural_reach_radius_m: round6(effector.natural_reach_radius_m),
      tool_extended_reach_radius_m: effector.tool_extended_reach_radius_m === undefined ? undefined : round6(effector.tool_extended_reach_radius_m),
      ok,
    });
  }));
}

function validateRequiredChainCategories(model: EmbodimentDescriptor, chains: readonly ResolvedKinematicChain[], issues: ValidationIssue[]): void {
  const hasGaze = chains.some((chain) => chain.chain_role === "gaze");
  const hasLocomotion = chains.some((chain) => chain.chain_role === "locomotion");
  const hasManipulation = chains.some((chain) => chain.chain_role === "manipulation" || chain.chain_role === "gripper");
  const hasTool = chains.some((chain) => chain.chain_role === "tool") || model.end_effectors.every((effector) => effector.role !== "tool_tip");
  if (!hasGaze) {
    issues.push(makeIssue("warning", "ChainMissing", "$.kinematic_chains", "No gaze chain is available.", "Declare a neck/head gaze chain for camera orientation."));
  }
  if (!hasLocomotion) {
    issues.push(makeIssue("warning", "LocomotionChainIncomplete", "$.kinematic_chains", "No locomotion chain is available.", "Declare support-contact locomotion chains."));
  }
  if (!hasManipulation) {
    issues.push(makeIssue("error", "ChainMissing", "$.kinematic_chains", "No manipulation chain is available.", "Declare mouth, paw, arm, hand, or gripper manipulation chains."));
  }
  if (!hasTool) {
    issues.push(makeIssue("warning", "ToolChainInvalid", "$.kinematic_chains", "Tool-tip end effectors require a tool chain.", "Attach task-scoped tool tips through a manipulation chain."));
  }
}

function endEffectorForChain(model: EmbodimentDescriptor, descriptor: KinematicChainDescriptor): EndEffectorDescriptor | undefined {
  return descriptor.end_effector_ref === undefined
    ? model.end_effectors.find((effector) => effector.frame_ref === descriptor.tip_frame_ref)
    : model.end_effectors.find((effector) => effector.effector_ref === descriptor.end_effector_ref);
}

function chainCategory(descriptor: KinematicChainDescriptor, source: ChainSource, model: EmbodimentDescriptor): ChainCategory {
  if (source === "synthesized_locomotion_contact" || descriptor.chain_role === "locomotion") {
    return "locomotion";
  }
  if (source === "synthesized_tool_attachment" || descriptor.chain_role === "tool") {
    return "tool";
  }
  if (descriptor.chain_role === "gaze") {
    return "gaze";
  }
  if (descriptor.chain_role === "gripper") {
    return "gripper";
  }
  const effector = endEffectorForChain(model, descriptor);
  if (effector?.role === "mouth_gripper") {
    return "gripper";
  }
  return descriptor.joint_refs.some((jointRef) => model.joints.find((joint) => joint.joint_ref === jointRef)?.joint_group === "torso")
    ? "body_stabilization"
    : "manipulation";
}

function groupActuatorsByJoint(actuators: readonly ActuatorLimitDescriptor[]): ReadonlyMap<Ref, readonly ActuatorLimitDescriptor[]> {
  const grouped = new Map<Ref, ActuatorLimitDescriptor[]>();
  for (const actuator of actuators) {
    const entries = grouped.get(actuator.target_joint_ref) ?? [];
    entries.push(actuator);
    grouped.set(actuator.target_joint_ref, entries);
  }
  return new Map([...grouped.entries()].map(([jointRef, entries]) => [jointRef, freezeArray(entries.sort((a, b) => a.actuator_ref.localeCompare(b.actuator_ref)))]));
}

function foldedReach(lengths: readonly number[]): number {
  if (lengths.length === 0) {
    return 0;
  }
  const sorted = [...lengths].sort((a, b) => b - a);
  const longest = sorted[0];
  const rest = sorted.slice(1).reduce((sum, value) => sum + value, 0);
  return Math.max(0, longest - rest);
}

function classifySingularity(distance: number, minReach: number, maxReach: number): SingularityClass {
  if (!Number.isFinite(distance) || maxReach <= EPSILON) {
    return "degenerate";
  }
  const tolerance = Math.max(0.015, maxReach * 0.03);
  if (Math.abs(distance - minReach) <= tolerance) {
    return "near_folded";
  }
  if (Math.abs(distance - maxReach) <= tolerance) {
    return "near_extended";
  }
  return "clear";
}

function buildIKReport(
  chain: ResolvedKinematicChain,
  target: Vector3,
  shoulder: number,
  elbow: number,
  residual: number,
  singularity: SingularityClass,
  solution: Readonly<Record<Ref, number>>,
  appliedLimits: readonly ChainPlanarIKReport["applied_joint_limits"][number][],
  issues: readonly ValidationIssue[],
): ChainPlanarIKReport {
  const targetDistance = vectorNorm(target);
  const feasible = residual <= 0.01 && !issues.some((issue) => issue.severity === "error") && appliedLimits.every((limit) => limit.inside_safe_limits);
  const base = {
    schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
    ik_report_ref: `ik_${chain.embodiment_ref}_${chain.chain_ref}_${computeDeterminismHash({ target, shoulder, elbow, residual, solution }).slice(0, 12)}`,
    embodiment_ref: chain.embodiment_ref,
    chain_ref: chain.chain_ref,
    feasible,
    root_angle_rad: round6(shoulder),
    elbow_angle_rad: round6(elbow),
    residual_m: round6(residual),
    target_distance_m: round6(targetDistance),
    singularity_class: singularity,
    joint_solution: Object.freeze({ ...solution }),
    applied_joint_limits: freezeArray(appliedLimits),
    issues: freezeArray(issues),
    ok: feasible,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateVector3(value: Vector3, path: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new KinematicChainRegistryError("Vector3 input is invalid.", [
      makeIssue("error", "IKInputInvalid", path, "Vector must contain exactly three finite numeric components.", "Use a body-relative [x, y, z] vector in meters."),
    ]);
  }
}

function assertSafeRef(ref: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(ref, issues, path, "ChainRefInvalid");
  if (issues.length > 0) {
    throw new KinematicChainRegistryError("Reference is not safe for kinematic chain use.", issues);
  }
}

function validateSafeRef(ref: Ref, issues: ValidationIssue[], path: string, code: KinematicChainIssueCode): void {
  if (typeof ref !== "string" || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-relative reference."));
  }
  if (FORBIDDEN_FRAME_REFS.has(ref)) {
    issues.push(makeIssue("error", "ForbiddenWorldFrame", path, "Simulator world frame W is QA/validator-only and cannot be used in kinematic chains.", "Use body-relative frames such as B, T, H, contacts, or end effectors."));
  }
  if (!isSafeText(ref)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference contains forbidden simulator/backend detail.", "Use sanitized body, joint, frame, or chain refs."));
  }
}

function assertNoForbiddenLeak(report: KinematicChainRegistryReport): void {
  const issues: ValidationIssue[] = [];
  for (const chain of report.chains) {
    for (const value of [chain.chain_ref, chain.root_frame_ref, chain.tip_frame_ref, chain.self_collision_policy_ref, chain.preferred_rest_posture_ref, chain.singularity_policy_ref]) {
      if (!isSafeText(value) || FORBIDDEN_FRAME_REFS.has(value)) {
        issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.chains", `Chain field ${value} contains forbidden simulator detail.`, "Strip backend handles and world-truth refs before model-facing output."));
      }
    }
  }
  if (issues.length > 0) {
    throw new KinematicChainRegistryError("Kinematic chain report contains forbidden simulator detail.", issues);
  }
}

function freezeChain(value: KinematicChainDescriptor): KinematicChainDescriptor {
  return Object.freeze({
    ...value,
    joint_refs: freezeArray(value.joint_refs),
    link_lengths_m: freezeArray(value.link_lengths_m),
  });
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray(["simulator_world_frame_W", "backend_body_handles", "engine_joint_handles", "collision_mesh_refs", "exact_hidden_com", "qa_truth_refs"]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function isSafeText(value: string): boolean {
  return !FORBIDDEN_DETAIL_PATTERN.test(value);
}

function makeIssue(severity: ValidationSeverity, code: KinematicChainIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function vectorNorm(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const KINEMATIC_CHAIN_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: KINEMATIC_CHAIN_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.7", "5.10", "5.11", "5.18", "5.19", "5.20"]),
  responsibilities: freezeArray([
    "resolve locomotion, gaze, manipulation, gripper, mouth, and tool chains",
    "validate root and tip frame refs without simulator world truth",
    "bind ordered joints to actuator paths and end effectors",
    "compute reach and two-link IK feasibility with singularity checks",
    "publish cognitive-safe body capability summaries",
  ]),
});
