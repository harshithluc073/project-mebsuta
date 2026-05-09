/**
 * Embodiment prompt contract provider for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.7, 5.11, 5.12, 5.15, 5.16, 5.19, and 5.20.
 *
 * The provider is the executable boundary between the embodiment layer and
 * Gemini Robotics-ER 1.6 prompt construction. It exposes body self-knowledge:
 * body type, sensors, end effectors, locomotion primitives, manipulation
 * primitives, approximate reach classes, stability limitations, tool-use
 * rules, and current proprioceptive health. It deliberately excludes backend
 * handles, hidden world pose, exact center-of-mass details, collision geometry,
 * scene truth, and QA/test oracle state.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  createEmbodimentModelRegistry,
  EmbodimentModelRegistry,
  EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
} from "./embodiment_model_registry";
import type {
  ContactSiteDescriptor,
  EmbodimentDescriptor,
  EndEffectorDescriptor,
  FrameDescriptor,
  LocomotionCapabilityDescriptor,
  ManipulationCapabilityDescriptor,
  ReachEnvelopeDescriptor,
  SensorMountDescriptor,
  StabilityPolicyDescriptor,
} from "./embodiment_model_registry";

export const EMBODIMENT_PROMPT_CONTRACT_PROVIDER_SCHEMA_VERSION = "mebsuta.embodiment_prompt_contract_provider.v1" as const;

const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|joint_handle|object_id|hidden)/i;
const SAFE_SEPARATOR = "; ";

export type PromptContractDetailLevel = "minimal" | "standard" | "verbose";
export type PromptContractToolState = "absent" | "candidate" | "attached" | "unstable" | "expired" | "unknown";
export type PromptContractHealthClass = "nominal" | "degraded" | "critical" | "unknown";
export type PromptContractStabilityClass = "stable" | "marginal" | "unstable" | "unknown";
export type PromptContractVisibility = "gemini_safe_body_self_knowledge";

export type EmbodimentPromptContractIssueCode =
  | "ActiveEmbodimentMissing"
  | "SelfStateMissing"
  | "VisibilityPolicyMissing"
  | "ForbiddenBodyDetail"
  | "ReachSummaryUnavailable"
  | "SensorSummaryUnavailable"
  | "EndEffectorUnavailable"
  | "StabilitySummaryUnavailable"
  | "ContractSectionSuppressed";

/**
 * Runtime self-state provided by virtual hardware and proprioception before a
 * prompt is assembled. All fields are summaries or body-relative estimates.
 */
export interface EmbodimentPromptSelfState {
  readonly proprioception_health?: PromptContractHealthClass;
  readonly sensor_health?: PromptContractHealthClass;
  readonly actuator_health?: PromptContractHealthClass;
  readonly hardware_health?: PromptContractHealthClass;
  readonly stance_ref?: Ref;
  readonly stability_state?: PromptContractStabilityClass;
  readonly contact_confidence?: "high" | "medium" | "low" | "unknown";
  readonly active_tool_state?: PromptContractToolState;
  readonly current_motion_hint?: "idle" | "observing" | "reaching" | "carrying" | "walking" | "recovering" | "unknown";
}

/**
 * Firewall controls for deciding which body-self sections are allowed into the
 * model-facing contract. The defaults keep all allowed architecture sections on
 * and keep identifiers summarized rather than raw.
 */
export interface EmbodimentPromptVisibilityPolicy {
  readonly detail_level?: PromptContractDetailLevel;
  readonly include_sensor_summary?: boolean;
  readonly include_end_effector_summary?: boolean;
  readonly include_locomotion_summary?: boolean;
  readonly include_manipulation_summary?: boolean;
  readonly include_reach_summary?: boolean;
  readonly include_stability_summary?: boolean;
  readonly include_tool_use_summary?: boolean;
  readonly include_contact_summary?: boolean;
  readonly include_current_self_state?: boolean;
  readonly include_sanitized_reference_labels?: boolean;
  readonly max_items_per_section?: number;
  readonly max_text_length?: number;
  readonly require_current_self_state?: boolean;
}

export interface ForbiddenDetailAuditSummary {
  readonly audit_ref: Ref;
  readonly scanned_field_count: number;
  readonly blocked_field_count: number;
  readonly removed_detail_categories: readonly string[];
  readonly safe_for_prompt: boolean;
}

export interface EmbodimentPromptContractPacket {
  readonly schema_version: typeof EMBODIMENT_PROMPT_CONTRACT_PROVIDER_SCHEMA_VERSION;
  readonly model_contract_schema_version: typeof EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_summary: string;
  readonly sensor_summary: readonly string[];
  readonly end_effector_summary: readonly string[];
  readonly locomotion_summary: readonly string[];
  readonly manipulation_summary: readonly string[];
  readonly contact_summary: readonly string[];
  readonly reach_summary: string;
  readonly stability_summary: string;
  readonly tool_use_summary?: string;
  readonly current_self_state_summary: readonly string[];
  readonly forbidden_detail_audit: ForbiddenDetailAuditSummary;
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: PromptContractVisibility;
  readonly determinism_hash: string;
}

export interface EmbodimentPromptContractProviderConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
  readonly default_visibility_policy?: EmbodimentPromptVisibilityPolicy;
}

export class EmbodimentPromptContractProviderError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "EmbodimentPromptContractProviderError";
    this.issues = issues;
  }
}

/**
 * Builds Gemini-safe embodiment prompt contracts from the active body model and
 * current self-state without leaking simulator internals.
 */
export class EmbodimentPromptContractProvider {
  private readonly registry: EmbodimentModelRegistry;
  private readonly defaultVisibilityPolicy: Required<EmbodimentPromptVisibilityPolicy>;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: EmbodimentPromptContractProviderConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    if (config.embodiment !== undefined) {
      this.registry.registerEmbodimentModel(config.embodiment);
    }
    this.defaultVisibilityPolicy = normalizePolicy(config.default_visibility_policy, []);
    if (config.active_embodiment_ref !== undefined) {
      this.selectActiveEmbodiment(config.active_embodiment_ref);
    } else if (config.embodiment !== undefined) {
      this.activeEmbodimentRef = config.embodiment.embodiment_id;
    }
  }

  /**
   * Selects the active embodiment whose self-knowledge will be exposed to the
   * prompt builder.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Implements `buildEmbodimentPromptContract(activeEmbodimentRef,
   * currentSelfState, visibilityPolicy) -> EmbodimentContractPacket`.
   */
  public buildEmbodimentPromptContract(
    activeEmbodimentRef?: Ref,
    currentSelfState?: EmbodimentPromptSelfState,
    visibilityPolicy?: EmbodimentPromptVisibilityPolicy,
  ): EmbodimentPromptContractPacket {
    const issues: ValidationIssue[] = [];
    const policy = normalizePolicy(visibilityPolicy ?? this.defaultVisibilityPolicy, issues);
    const model = this.requireEmbodiment(activeEmbodimentRef);
    const selfState = normalizeSelfState(model, currentSelfState, policy, issues);

    const sensorSummary = policy.include_sensor_summary ? buildSensorSummary(model.sensor_mounts, model.frame_graph, policy) : suppressed("sensor_summary", issues);
    const endEffectorSummary = policy.include_end_effector_summary ? buildEndEffectorSummary(model.end_effectors, policy) : suppressed("end_effector_summary", issues);
    const locomotionSummary = policy.include_locomotion_summary ? buildLocomotionSummary(model.locomotion_capability, policy) : suppressed("locomotion_summary", issues);
    const manipulationSummary = policy.include_manipulation_summary ? buildManipulationSummary(model.manipulation_capabilities, policy) : suppressed("manipulation_summary", issues);
    const contactSummary = policy.include_contact_summary ? buildContactSummary(model.contact_sites, policy) : suppressed("contact_summary", issues);
    const reachSummary = policy.include_reach_summary ? buildReachSummary(model, policy, issues) : "Reach details are suppressed by the active prompt visibility policy.";
    const stabilitySummary = policy.include_stability_summary ? buildStabilitySummary(model.stability_policy, model.embodiment_kind, selfState, policy, issues) : "Stability details are suppressed by the active prompt visibility policy.";
    const toolUseSummary = policy.include_tool_use_summary ? buildToolUseSummary(model, selfState, policy) : undefined;
    const currentSelfStateSummary = policy.include_current_self_state ? buildSelfStateSummary(selfState, policy) : suppressed("current_self_state_summary", issues);

    const hiddenFieldsRemoved = removedDetailCategories();
    const preliminary = {
      schema_version: EMBODIMENT_PROMPT_CONTRACT_PROVIDER_SCHEMA_VERSION,
      model_contract_schema_version: EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      body_summary: sanitizeText(model.body_summary, policy),
      sensor_summary: sensorSummary,
      end_effector_summary: endEffectorSummary,
      locomotion_summary: locomotionSummary,
      manipulation_summary: manipulationSummary,
      contact_summary: contactSummary,
      reach_summary: sanitizeText(reachSummary, policy),
      stability_summary: sanitizeText(stabilitySummary, policy),
      tool_use_summary: toolUseSummary === undefined ? undefined : sanitizeText(toolUseSummary, policy),
      current_self_state_summary: currentSelfStateSummary,
      hidden_fields_removed: hiddenFieldsRemoved,
      cognitive_visibility: "gemini_safe_body_self_knowledge" as const,
    };
    const audit = auditPromptContract(preliminary, hiddenFieldsRemoved, issues);
    const base = {
      ...preliminary,
      forbidden_detail_audit: audit,
      forbidden_detail_report_ref: audit.audit_ref,
      issues: freezeArray(issues),
      ok: audit.safe_for_prompt && issues.every((issue) => issue.severity !== "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Audits a packet generated elsewhere and reports whether it can be sent to a
   * model-facing prompt builder.
   */
  public validatePromptContract(packet: EmbodimentPromptContractPacket): ForbiddenDetailAuditSummary {
    const issues: ValidationIssue[] = [];
    return auditPromptContract(packet, packet.hidden_fields_removed, issues);
  }

  private requireEmbodiment(embodimentRef?: Ref): EmbodimentDescriptor {
    const activeRef = embodimentRef ?? this.activeEmbodimentRef;
    if (activeRef !== undefined) {
      assertSafeRef(activeRef, "$.active_embodiment_ref");
      return this.registry.requireEmbodiment(activeRef);
    }
    const selected = this.registry.listEmbodiments().at(0);
    if (selected === undefined) {
      throw new EmbodimentPromptContractProviderError("No active embodiment is registered for prompt contract construction.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before prompt construction."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createEmbodimentPromptContractProvider(config: EmbodimentPromptContractProviderConfig = {}): EmbodimentPromptContractProvider {
  return new EmbodimentPromptContractProvider(config);
}

export function buildEmbodimentPromptContract(
  activeEmbodimentRef?: Ref,
  currentSelfState?: EmbodimentPromptSelfState,
  visibilityPolicy?: EmbodimentPromptVisibilityPolicy,
): EmbodimentPromptContractPacket {
  return new EmbodimentPromptContractProvider().buildEmbodimentPromptContract(activeEmbodimentRef, currentSelfState, visibilityPolicy);
}

function normalizePolicy(policy: EmbodimentPromptVisibilityPolicy | undefined, issues: ValidationIssue[]): Required<EmbodimentPromptVisibilityPolicy> {
  if (policy === undefined) {
    issues.push(makeIssue("warning", "VisibilityPolicyMissing", "$.visibilityPolicy", "No explicit prompt visibility policy was supplied.", "Use the strict default policy or pass a scenario-specific firewall policy."));
  }
  const normalized = {
    detail_level: policy?.detail_level ?? "standard",
    include_sensor_summary: policy?.include_sensor_summary ?? true,
    include_end_effector_summary: policy?.include_end_effector_summary ?? true,
    include_locomotion_summary: policy?.include_locomotion_summary ?? true,
    include_manipulation_summary: policy?.include_manipulation_summary ?? true,
    include_reach_summary: policy?.include_reach_summary ?? true,
    include_stability_summary: policy?.include_stability_summary ?? true,
    include_tool_use_summary: policy?.include_tool_use_summary ?? true,
    include_contact_summary: policy?.include_contact_summary ?? true,
    include_current_self_state: policy?.include_current_self_state ?? true,
    include_sanitized_reference_labels: policy?.include_sanitized_reference_labels ?? false,
    max_items_per_section: clampInteger(policy?.max_items_per_section ?? 12, 1, 100),
    max_text_length: clampInteger(policy?.max_text_length ?? 180, 60, 1000),
    require_current_self_state: policy?.require_current_self_state ?? true,
  };
  return Object.freeze(normalized);
}

function normalizeSelfState(
  model: EmbodimentDescriptor,
  selfState: EmbodimentPromptSelfState | undefined,
  policy: Required<EmbodimentPromptVisibilityPolicy>,
  issues: ValidationIssue[],
): Required<EmbodimentPromptSelfState> {
  if (selfState === undefined && policy.require_current_self_state) {
    issues.push(makeIssue("warning", "SelfStateMissing", "$.currentSelfState", "No current self-state was supplied; provider emitted conservative unknown status.", "Pass proprioception, sensor health, contact confidence, stance, and tool state before prompt construction."));
  }
  const stance = selfState?.stance_ref ?? model.stability_policy.default_stance_ref;
  validateSafeRef(stance, "$.currentSelfState.stance_ref", issues, "SelfStateMissing");
  return Object.freeze({
    proprioception_health: selfState?.proprioception_health ?? "unknown",
    sensor_health: selfState?.sensor_health ?? "unknown",
    actuator_health: selfState?.actuator_health ?? "unknown",
    hardware_health: selfState?.hardware_health ?? "unknown",
    stance_ref: stance,
    stability_state: selfState?.stability_state ?? "unknown",
    contact_confidence: selfState?.contact_confidence ?? "unknown",
    active_tool_state: selfState?.active_tool_state ?? "unknown",
    current_motion_hint: selfState?.current_motion_hint ?? "unknown",
  });
}

function buildSensorSummary(
  mounts: readonly SensorMountDescriptor[],
  frames: readonly FrameDescriptor[],
  policy: Required<EmbodimentPromptVisibilityPolicy>,
): readonly string[] {
  const frameRole = new Map(frames.map((frame) => [frame.frame_id, frame.frame_role] as const));
  return limitItems(mounts
    .map((mount) => sanitizeText(`${sensorRoleLabel(mount.sensor_role)} mounted on ${bodyPartLabel(frameRole.get(mount.body_frame_ref), mount.body_frame_ref, policy)} with ${mount.allowed_motion_summary}.`, policy))
    .sort(), policy);
}

function buildEndEffectorSummary(effectors: readonly EndEffectorDescriptor[], policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  return limitItems(effectors
    .map((effector) => {
      const toolClause = effector.tool_extended_reach_radius_m === undefined
        ? "no declared tool extension"
        : `validated tool reach class up to ${reachBand(effector.tool_extended_reach_radius_m)}`;
      return sanitizeText(`${effectorRoleLabel(effector.role)} supports ${joinShort(effector.supported_primitives)} with ${effector.precision_rating} precision, ${reachBand(effector.natural_reach_radius_m)} natural reach, and ${toolClause}.`, policy);
    })
    .sort(), policy);
}

function buildLocomotionSummary(capability: LocomotionCapabilityDescriptor, policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  const base = [
    `Locomotion primitives: ${joinShort(capability.supported_primitives)}.`,
    `Recovery primitives: ${joinShort(capability.recovery_primitives)}.`,
    `Stable speed class is ${speedClass(capability.stable_speed_m_per_s)}; carry speed multiplier class is ${fractionClass(capability.carry_speed_multiplier)}.`,
  ];
  return limitItems(base.map((item) => sanitizeText(item, policy)), policy);
}

function buildManipulationSummary(capabilities: readonly ManipulationCapabilityDescriptor[], policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  return limitItems(capabilities
    .map((capability) => sanitizeText(`${effectorRoleLabel(capability.end_effector_role)} can ${joinShort(capability.supported_primitives)} for ${capability.object_size_range_summary}; precision ${capability.precision_rating}; occlusion risk ${capability.occlusion_risk}; likely failures ${joinShort(capability.failure_modes)}.`, policy))
    .sort(), policy);
}

function buildContactSummary(contacts: readonly ContactSiteDescriptor[], policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  const byRole = new Map<ContactSiteDescriptor["contact_role"], ContactSiteDescriptor[]>();
  for (const contact of contacts) {
    byRole.set(contact.contact_role, [...(byRole.get(contact.contact_role) ?? []), contact]);
  }
  const summaries = [...byRole.entries()].map(([role, sites]) => {
    const supportCount = sites.filter((site) => site.nominal_support).length;
    const maxForce = Math.max(...sites.map((site) => site.max_contact_force_n));
    return sanitizeText(`${role} contact capability has ${sites.length} declared site(s), ${supportCount} nominal support site(s), and ${forceBand(maxForce)} tactile force class.`, policy);
  });
  return limitItems(summaries.sort(), policy);
}

function buildReachSummary(model: EmbodimentDescriptor, policy: Required<EmbodimentPromptVisibilityPolicy>, issues: ValidationIssue[]): string {
  if (model.reach_envelopes.length === 0) {
    issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", "No reach envelopes are declared for the active embodiment.", "Declare reach envelopes before prompt construction."));
    return "Reach is unavailable until declared reach envelopes are registered.";
  }
  const naturalMax = Math.max(...model.reach_envelopes.map((envelope) => envelope.natural_radius_m));
  const postureMax = Math.max(...model.reach_envelopes.map((envelope) => envelope.posture_adjusted_radius_m));
  const repositionMax = Math.max(...model.reach_envelopes.map((envelope) => envelope.reposition_radius_m));
  const toolMax = Math.max(...model.reach_envelopes.map((envelope) => envelope.tool_extended_radius_m ?? envelope.natural_radius_m));
  const envelopeNotes = model.reach_envelopes
    .map((envelope) => reachEnvelopeNote(model, envelope, policy))
    .slice(0, policy.detail_level === "minimal" ? 1 : policy.max_items_per_section)
    .join(SAFE_SEPARATOR);
  return sanitizeText(`${model.embodiment_kind} reach: natural ${reachBand(naturalMax)}, posture-adjusted ${reachBand(postureMax)}, repositioned ${reachBand(repositionMax)}, validated tool ${reachBand(toolMax)}. ${envelopeNotes}`, policy);
}

function buildStabilitySummary(
  policyDescriptor: StabilityPolicyDescriptor,
  kind: EmbodimentKind,
  selfState: Required<EmbodimentPromptSelfState>,
  policy: Required<EmbodimentPromptVisibilityPolicy>,
  issues: ValidationIssue[],
): string {
  if (policyDescriptor.nominal_support_contact_refs.length === 0) {
    issues.push(makeIssue("error", "StabilitySummaryUnavailable", "$.stability_policy.nominal_support_contact_refs", "No nominal support contacts are declared.", "Declare support contacts before exposing stability self-knowledge."));
  }
  const supportClass = kind === "quadruped" ? "four-point low support" : "biped support";
  const tilt = `${angleClass(policyDescriptor.warning_base_tilt_rad)} warning tilt and ${angleClass(policyDescriptor.max_base_tilt_rad)} hard tilt limit`;
  const load = `${massClass(policyDescriptor.max_carried_load_kg)} carried-load class`;
  const action = selfState.stability_state === "unstable" ? "safe-hold or re-observe before motion" : selfState.stability_state === "marginal" ? "slow down and prefer repositioning" : "continue only after normal validators admit the plan";
  return sanitizeText(`${kind} stability uses ${supportClass}, ${policyDescriptor.nominal_support_contact_refs.length} nominal support contacts, ${tilt}, ${load}; current stability summary is ${selfState.stability_state}, so ${action}.`, policy);
}

function buildToolUseSummary(model: EmbodimentDescriptor, selfState: Required<EmbodimentPromptSelfState>, policy: Required<EmbodimentPromptVisibilityPolicy>): string | undefined {
  const naturalMax = Math.max(...model.end_effectors.map((effector) => effector.natural_reach_radius_m));
  const toolMax = Math.max(...model.end_effectors.map((effector) => effector.tool_extended_reach_radius_m ?? effector.natural_reach_radius_m));
  const toolCapable = model.manipulation_capabilities.filter((capability) => capability.supported_primitives.includes("tool_use"));
  if (toolCapable.length === 0 && toolMax <= naturalMax) {
    return undefined;
  }
  const state = selfState.active_tool_state === "attached" ? "a tool is currently attached and still requires task-scoped validation" : `tool state is ${selfState.active_tool_state}`;
  const roles = toolCapable.map((capability) => effectorRoleLabel(capability.end_effector_role)).sort();
  return sanitizeText(`Tool use is allowed only through validated task-scoped attachment; ${joinShort(roles)} can use tools; approximate reach may extend from ${reachBand(naturalMax)} to ${reachBand(toolMax)}; ${state}; tool frames expire after release, unsafe contact, or safety abort.`, policy);
}

function buildSelfStateSummary(selfState: Required<EmbodimentPromptSelfState>, policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  const entries = [
    `Proprioception health is ${selfState.proprioception_health}; sensor health is ${selfState.sensor_health}; actuator health is ${selfState.actuator_health}; hardware health is ${selfState.hardware_health}.`,
    `Current stance summary is ${safeReferenceLabel(selfState.stance_ref, policy)} with contact confidence ${selfState.contact_confidence} and stability ${selfState.stability_state}.`,
    `Current motion hint is ${selfState.current_motion_hint}; active tool state is ${selfState.active_tool_state}.`,
  ];
  return limitItems(entries.map((entry) => sanitizeText(entry, policy)), policy);
}

function reachEnvelopeNote(model: EmbodimentDescriptor, envelope: ReachEnvelopeDescriptor, policy: Required<EmbodimentPromptVisibilityPolicy>): string {
  const effector = model.end_effectors.find((candidate) => candidate.effector_ref === envelope.end_effector_ref);
  const role = effector === undefined ? "declared effector" : effectorRoleLabel(effector.role);
  const precision = envelope.precision_region_summary === undefined ? "precision limits are task-dependent" : envelope.precision_region_summary;
  const unsafe = envelope.unsafe_region_summary === undefined ? "unsafe reach requires validator review" : envelope.unsafe_region_summary;
  return sanitizeText(`${role}: ${envelope.workspace_region_summary}; ${precision}; limitation: ${unsafe}.`, policy);
}

function auditPromptContract(value: unknown, removed: readonly string[], issues: ValidationIssue[]): ForbiddenDetailAuditSummary {
  const scanned: string[] = [];
  const blocked: string[] = [];
  scanPromptValue(value, "$", scanned, blocked);
  for (const path of blocked) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Prompt contract contains forbidden simulator, hidden, or QA detail.", "Remove or sanitize the field before prompt construction."));
  }
  const base = {
    audit_ref: `embodiment_prompt_audit_${computeDeterminismHash({ scanned, blocked, removed }).slice(0, 12)}`,
    scanned_field_count: scanned.length,
    blocked_field_count: blocked.length,
    removed_detail_categories: freezeArray(removed),
    safe_for_prompt: blocked.length === 0,
  };
  return Object.freeze(base);
}

function scanPromptValue(value: unknown, path: string, scanned: string[], blocked: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (path.endsWith(".hidden_fields_removed") || path.includes(".hidden_fields_removed[") || path.includes(".removed_detail_categories")) {
    return;
  }
  if (typeof value === "string") {
    scanned.push(path);
    if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
      blocked.push(path);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    scanned.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanPromptValue(entry, `${path}[${index}]`, scanned, blocked));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      scanPromptValue(entry, `${path}.${key}`, scanned, blocked);
    }
  }
}

function suppressed(section: string, issues: ValidationIssue[]): readonly string[] {
  issues.push(makeIssue("warning", "ContractSectionSuppressed", `$.${section}`, "Prompt contract section was suppressed by visibility policy.", "Confirm the prompt builder does not require this section."));
  return freezeArray([]);
}

function removedDetailCategories(): readonly string[] {
  return freezeArray([
    "backend_handles",
    "hidden_world_pose",
    "exact_center_of_mass",
    "collision_geometry",
    "scene_object_locations",
    "qa_truth",
    "solver_debug_state",
  ]);
}

function sensorRoleLabel(role: SensorMountDescriptor["sensor_role"]): string {
  return role.replace(/_/g, " ");
}

function effectorRoleLabel(role: EndEffectorDescriptor["role"]): string {
  return role.replace(/_/g, " ");
}

function bodyPartLabel(role: FrameDescriptor["frame_role"] | undefined, ref: Ref, policy: Required<EmbodimentPromptVisibilityPolicy>): string {
  if (role !== undefined && role !== "estimated_map") {
    return role.replace(/_/g, " ");
  }
  return safeReferenceLabel(ref, policy);
}

function safeReferenceLabel(ref: Ref, policy: Required<EmbodimentPromptVisibilityPolicy>): string {
  const sanitized = ref.replace(FORBIDDEN_DETAIL_PATTERN, "internal-detail").replace(/[^A-Za-z0-9_-]/g, "_");
  if (policy.include_sanitized_reference_labels) {
    return sanitized;
  }
  if (sanitized.startsWith("quadruped")) {
    return "quadruped body reference";
  }
  if (sanitized.startsWith("humanoid")) {
    return "humanoid body reference";
  }
  if (sanitized.length <= 3) {
    return sanitized;
  }
  return "declared body reference";
}

function reachBand(radiusM: number): string {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    return "unavailable";
  }
  if (radiusM < 0.45) {
    return "very short";
  }
  if (radiusM < 0.8) {
    return "short";
  }
  if (radiusM < 1.15) {
    return "medium";
  }
  return "extended";
}

function speedClass(speedMps: number): string {
  if (speedMps < 0.4) {
    return "very slow";
  }
  if (speedMps < 0.65) {
    return "slow";
  }
  if (speedMps < 1.0) {
    return "moderate";
  }
  return "fast";
}

function fractionClass(value: number): string {
  if (value < 0.4) {
    return "strongly reduced";
  }
  if (value < 0.7) {
    return "reduced";
  }
  return "near normal";
}

function forceBand(forceN: number): string {
  if (forceN < 120) {
    return "light";
  }
  if (forceN < 260) {
    return "moderate";
  }
  return "high";
}

function angleClass(angleRad: number): string {
  if (angleRad < 0.3) {
    return "low";
  }
  if (angleRad < 0.55) {
    return "moderate";
  }
  return "high";
}

function massClass(massKg: number): string {
  if (massKg < 2) {
    return "light";
  }
  if (massKg < 5) {
    return "medium";
  }
  return "heavy";
}

function joinShort(values: readonly string[]): string {
  if (values.length === 0) {
    return "none";
  }
  if (values.length <= 6) {
    return values.join(", ");
  }
  return `${values.slice(0, 6).join(", ")}, and ${values.length - 6} more`;
}

function limitItems(values: readonly string[], policy: Required<EmbodimentPromptVisibilityPolicy>): readonly string[] {
  const limit = policy.detail_level === "minimal" ? Math.min(3, policy.max_items_per_section) : policy.max_items_per_section;
  return freezeArray(values.slice(0, limit));
}

function sanitizeText(value: string, policy: Required<EmbodimentPromptVisibilityPolicy>): string {
  const sanitized = value
    .replace(FORBIDDEN_DETAIL_PATTERN, "internal-detail")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > policy.max_text_length ? `${sanitized.slice(0, policy.max_text_length - 1).trim()}.` : sanitized;
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new EmbodimentPromptContractProviderError("Invalid prompt contract reference.", issues);
  }
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: EmbodimentPromptContractIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use a declared opaque body reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference contains forbidden simulator or QA detail.", "Use a prompt-safe body reference."));
  }
}

function makeIssue(severity: ValidationSeverity, code: EmbodimentPromptContractIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const EMBODIMENT_PROMPT_CONTRACT_PROVIDER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EMBODIMENT_PROMPT_CONTRACT_PROVIDER_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.7", "5.11", "5.12", "5.15", "5.16", "5.19", "5.20"]),
});
