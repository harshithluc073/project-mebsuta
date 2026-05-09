/**
 * Contact site registry for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.7, 5.8, 5.9, 5.12, 5.15, 5.19, and 5.20.
 *
 * This module is the executable registry for declared feet, paws, hands,
 * fingertips, mouth, gripper, tool, and body contact sites. It maps each site
 * to a declared body frame and optional contact sensor, validates support
 * roles and force limits, classifies tactile evidence, computes support
 * geometry for stance checks, and emits prompt-safe contact capability
 * summaries without exposing solver contact refs, backend handles, hidden
 * world poses, collision meshes, or QA truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type { ContactSiteDescriptor, EmbodimentDescriptor, FrameDescriptor } from "./embodiment_model_registry";
import type { ContactSensorDescriptor, VirtualHardwareManifest } from "../virtual_hardware/virtual_hardware_manifest_registry";

export const CONTACT_SITE_REGISTRY_SCHEMA_VERSION = "mebsuta.contact_site_registry.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|solver|contact_manifold|object_id)/i;

export type ContactSiteRole = ContactSiteDescriptor["contact_role"];
export type ContactSiteConsumer = "virtual_hardware" | "stability" | "manipulation" | "tool_use" | "control" | "oops_loop" | "prompt_contract" | "qa";
export type ContactEvidenceClass = "no_contact" | "resting_support" | "grasp" | "tool_contact" | "collision" | "slip" | "unknown";
export type ContactForceClass = "none" | "light" | "nominal" | "high" | "over_limit" | "unknown";
export type ContactSlipClass = "none" | "possible" | "likely" | "unknown";
export type ContactSiteHealthClass = "nominal" | "degraded" | "missing_sensor" | "undeclared_sensor";

export type ContactSiteIssueCode =
  | "ActiveEmbodimentMissing"
  | "ContactSiteMissing"
  | "ContactSiteDuplicate"
  | "ContactSiteRefInvalid"
  | "ContactRoleInvalid"
  | "ContactFrameMissing"
  | "ContactFrameRoleInvalid"
  | "ContactSensorMissing"
  | "ContactSensorClassMismatch"
  | "ContactSensorSiteMismatch"
  | "ContactForceLimitInvalid"
  | "ContactForceOutOfRange"
  | "ContactSlipAmbiguous"
  | "SupportContactInsufficient"
  | "HardwareManifestMismatch"
  | "InternalContactRefLeak"
  | "ForbiddenBodyDetail";

export interface ContactSiteRegistryConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly hardware_manifest?: VirtualHardwareManifest;
  readonly active_embodiment_ref?: Ref;
}

export interface ContactSiteSelectionInput {
  readonly active_embodiment_ref?: Ref;
  readonly contact_site_ref?: Ref;
  readonly contact_role?: ContactSiteRole;
  readonly nominal_support?: boolean;
  readonly sensor_ref?: Ref;
  readonly consumer?: ContactSiteConsumer;
}

export interface ResolvedContactSite {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly contact_site_ref: Ref;
  readonly contact_role: ContactSiteRole;
  readonly frame_ref: Ref;
  readonly frame_role: FrameDescriptor["frame_role"];
  readonly parent_frame_ref?: Ref;
  readonly sensor_ref?: Ref;
  readonly nominal_support: boolean;
  readonly max_contact_force_n: number;
  readonly hardware_declared: boolean;
  readonly hardware_measurement_kind?: ContactSensorDescriptor["measurement_kind"];
  readonly measures_force: boolean;
  readonly measures_slip: boolean;
  readonly support_weight_hint: number;
  readonly health_class: ContactSiteHealthClass;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ContactRoleSummary {
  readonly contact_role: ContactSiteRole;
  readonly site_count: number;
  readonly nominal_support_count: number;
  readonly sensor_backed_count: number;
  readonly force_limit_min_n: number;
  readonly force_limit_max_n: number;
  readonly average_force_limit_n: number;
}

export interface ContactSiteRegistryReport {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly contact_site_table_ref: Ref;
  readonly contact_site_count: number;
  readonly nominal_support_count: number;
  readonly sensor_backed_site_count: number;
  readonly foot_or_paw_count: number;
  readonly hand_or_gripper_count: number;
  readonly mouth_count: number;
  readonly tool_contact_count: number;
  readonly body_contact_count: number;
  readonly contact_sites: readonly ResolvedContactSite[];
  readonly role_summaries: readonly ContactRoleSummary[];
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly determinism_hash: string;
}

export interface ContactEvidenceSample {
  readonly contact_site_ref: Ref;
  readonly in_contact: boolean;
  readonly confidence: number;
  readonly estimated_force_n?: number;
  readonly slip_probability?: number;
  readonly contact_class_hint?: ContactEvidenceClass;
  readonly sensor_ref?: Ref;
  readonly internal_contact_ref?: Ref;
}

export interface ContactEvidenceEvaluationInput {
  readonly active_embodiment_ref?: Ref;
  readonly samples: readonly ContactEvidenceSample[];
  readonly consumer: ContactSiteConsumer;
  readonly require_support_contacts?: boolean;
}

export interface ContactEvidenceDecision {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly contact_site_ref: Ref;
  readonly contact_role: ContactSiteRole;
  readonly sensor_ref?: Ref;
  readonly in_contact: boolean;
  readonly confidence: number;
  readonly force_class: ContactForceClass;
  readonly slip_class: ContactSlipClass;
  readonly contact_class: ContactEvidenceClass;
  readonly force_ratio: number;
  readonly usable_for_support: boolean;
  readonly usable_for_manipulation: boolean;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ContactEvidenceReport {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly consumer: ContactSiteConsumer;
  readonly sample_count: number;
  readonly accepted_contact_count: number;
  readonly support_contact_count: number;
  readonly manipulation_contact_count: number;
  readonly slip_event_count: number;
  readonly over_force_count: number;
  readonly decisions: readonly ContactEvidenceDecision[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface SupportContactGeometryReport {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly support_contact_refs: readonly Ref[];
  readonly support_point_count: number;
  readonly support_polygon_area_m2: number;
  readonly support_span_m: number;
  readonly centroid_in_base_frame_m: Vector3;
  readonly robust_support: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ContactCoverageRequest {
  readonly active_embodiment_ref?: Ref;
  readonly required_roles: readonly ContactSiteRole[];
  readonly require_sensor_backing?: boolean;
  readonly require_nominal_support?: boolean;
}

export interface ContactCoverageReport {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly required_roles: readonly ContactSiteRole[];
  readonly satisfied_roles: readonly ContactSiteRole[];
  readonly missing_roles: readonly ContactSiteRole[];
  readonly usable_contact_site_refs: readonly Ref[];
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveContactSiteSummary {
  readonly schema_version: typeof CONTACT_SITE_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly support_summary: readonly string[];
  readonly manipulation_contact_summary: readonly string[];
  readonly tactile_limit_summary: readonly string[];
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export class ContactSiteRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ContactSiteRegistryError";
    this.issues = issues;
  }
}

/**
 * Resolves contact sites, evaluates tactile evidence, and prepares prompt-safe
 * contact capability summaries for validators and the Oops Loop.
 */
export class ContactSiteRegistry {
  private readonly registry: EmbodimentModelRegistry;
  private readonly hardwareManifest: VirtualHardwareManifest | undefined;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: ContactSiteRegistryConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.hardwareManifest = config.hardware_manifest;
    if (config.embodiment !== undefined) {
      this.registry.registerEmbodimentModel(config.embodiment);
    }
    if (config.active_embodiment_ref !== undefined) {
      this.selectActiveEmbodiment(config.active_embodiment_ref);
    } else if (config.embodiment !== undefined) {
      this.activeEmbodimentRef = config.embodiment.embodiment_id;
    }
  }

  /**
   * Selects the embodiment whose contact site table is resolved by default.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Builds the validated contact site table for support, manipulation,
   * collision, tool, and Oops Loop evidence consumers.
   */
  public buildContactSiteRegistryReport(selection: ContactSiteSelectionInput = {}): ContactSiteRegistryReport {
    const model = this.requireEmbodiment(selection.active_embodiment_ref);
    const sites = freezeArray(model.contact_sites
      .filter((site) => selection.contact_site_ref === undefined || site.contact_site_ref === selection.contact_site_ref)
      .filter((site) => selection.contact_role === undefined || site.contact_role === selection.contact_role)
      .filter((site) => selection.nominal_support === undefined || site.nominal_support === selection.nominal_support)
      .filter((site) => selection.sensor_ref === undefined || site.sensor_ref === selection.sensor_ref)
      .map((site, index) => resolveContactSite(model, site, this.hardwareManifest, `$.contact_sites[${index}]`))
      .sort((a, b) => a.contact_site_ref.localeCompare(b.contact_site_ref)));
    const coverageIssues = validateContactCoverage(model, this.hardwareManifest);
    const issues = freezeArray([...coverageIssues, ...sites.flatMap((site) => site.issues)]);
    const base = {
      schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      contact_site_table_ref: model.contact_site_table_ref,
      contact_site_count: sites.length,
      nominal_support_count: sites.filter((site) => site.nominal_support).length,
      sensor_backed_site_count: sites.filter((site) => site.sensor_ref !== undefined).length,
      foot_or_paw_count: sites.filter((site) => site.contact_role === "foot" || site.contact_role === "paw").length,
      hand_or_gripper_count: sites.filter((site) => site.contact_role === "hand" || site.contact_role === "fingertip" || site.contact_role === "gripper").length,
      mouth_count: sites.filter((site) => site.contact_role === "mouth").length,
      tool_contact_count: sites.filter((site) => site.contact_role === "tool").length,
      body_contact_count: sites.filter((site) => site.contact_role === "body").length,
      contact_sites: sites,
      role_summaries: buildRoleSummaries(sites),
      hidden_fields_removed: hiddenFieldsRemoved(),
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Resolves exactly one contact site or throws if the selection is ambiguous.
   */
  public requireContactSite(selection: ContactSiteSelectionInput): ResolvedContactSite {
    const report = this.buildContactSiteRegistryReport(selection);
    if (report.contact_sites.length !== 1) {
      throw new ContactSiteRegistryError("Contact site selection must resolve to exactly one site.", [
        makeIssue("error", "ContactSiteMissing", "$.selection", `Selection resolved ${report.contact_sites.length} contact sites.`, "Select by exact contact_site_ref or unique role/sensor criteria."),
      ]);
    }
    return report.contact_sites[0];
  }

  /**
   * Classifies declared tactile evidence into force, slip, support, and
   * manipulation decisions. Internal solver contact refs are rejected.
   */
  public evaluateContactEvidence(input: ContactEvidenceEvaluationInput): ContactEvidenceReport {
    const model = this.requireEmbodiment(input.active_embodiment_ref);
    const registry = this.buildContactSiteRegistryReport({ active_embodiment_ref: model.embodiment_id });
    const decisions = input.samples.map((sample) => evaluateSample(model, registry.contact_sites, sample, input.consumer));
    const supportContactCount = decisions.filter((decision) => decision.usable_for_support).length;
    const issues = freezeArray([
      ...decisions.flatMap((decision, index) => decision.issues.map((issue) => Object.freeze({
        ...issue,
        path: `$.samples[${index}]${issue.path.startsWith("$") ? issue.path.slice(1) : `.${issue.path}`}`,
      }))),
      ...(input.require_support_contacts === true && supportContactCount < minimumSupportContacts(model.embodiment_kind)
        ? [makeIssue("error", "SupportContactInsufficient", "$.samples", `Only ${supportContactCount} support contacts are usable.`, "Re-observe contacts or move to a stable stance.")]
        : []),
    ]);
    const base = {
      schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      consumer: input.consumer,
      sample_count: input.samples.length,
      accepted_contact_count: decisions.filter((decision) => decision.in_contact && decision.ok).length,
      support_contact_count: supportContactCount,
      manipulation_contact_count: decisions.filter((decision) => decision.usable_for_manipulation).length,
      slip_event_count: decisions.filter((decision) => decision.slip_class === "likely").length,
      over_force_count: decisions.filter((decision) => decision.force_class === "over_limit").length,
      decisions: freezeArray(decisions),
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Computes support polygon area and centroid from nominal support contact
   * frames. This is body-relative geometry, not simulator world truth.
   */
  public buildSupportContactGeometry(activeEmbodimentRef?: Ref): SupportContactGeometryReport {
    const model = this.requireEmbodiment(activeEmbodimentRef);
    const issues: ValidationIssue[] = [];
    const frameByRef = new Map(model.frame_graph.map((frame) => [frame.frame_id, frame] as const));
    const supports = model.contact_sites.filter((site) => site.nominal_support);
    const points = supports.map((site) => framePositionInBase(frameByRef, site.frame_ref, issues, `$.contact_sites.${site.contact_site_ref}`));
    const hull = convexHull2D(points);
    const area = polygonArea2D(hull);
    const centroid = centroid2D(hull.length > 0 ? hull : points);
    const span = maxPairwiseDistance2D(points);
    if (supports.length < minimumSupportContacts(model.embodiment_kind)) {
      issues.push(makeIssue("error", "SupportContactInsufficient", "$.contact_sites", "Nominal support contact count is below the embodiment requirement.", "Declare enough foot/paw support contacts for stable stance validation."));
    }
    const base = {
      schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      support_contact_refs: freezeArray(supports.map((site) => site.contact_site_ref).sort()),
      support_point_count: points.length,
      support_polygon_area_m2: round6(area),
      support_span_m: round6(span),
      centroid_in_base_frame_m: centroid,
      robust_support: issues.length === 0 && area > 0,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Checks that required contact roles are declared and usable.
   */
  public evaluateContactCoverage(request: ContactCoverageRequest): ContactCoverageReport {
    const model = this.requireEmbodiment(request.active_embodiment_ref);
    const report = this.buildContactSiteRegistryReport({ active_embodiment_ref: model.embodiment_id });
    const requiredRoles = freezeArray([...new Set(request.required_roles)].sort());
    const usable = report.contact_sites.filter((site) => {
      const sensorOk = request.require_sensor_backing !== true || site.sensor_ref !== undefined;
      const supportOk = request.require_nominal_support !== true || site.nominal_support;
      return site.ok && sensorOk && supportOk;
    });
    const satisfiedRoles = freezeArray(requiredRoles.filter((role) => usable.some((site) => site.contact_role === role)));
    const missingRoles = freezeArray(requiredRoles.filter((role) => !satisfiedRoles.includes(role)));
    const issues = freezeArray(missingRoles.map((role) => makeIssue("error", "ContactSiteMissing", "$.required_roles", `Required contact role ${role} is not usable.`, "Declare and validate the required contact site.")));
    const base = {
      schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      required_roles: requiredRoles,
      satisfied_roles: satisfiedRoles,
      missing_roles: missingRoles,
      usable_contact_site_refs: freezeArray(usable.map((site) => site.contact_site_ref).sort()),
      ok: missingRoles.length === 0,
      issues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Produces Gemini-safe contact self-knowledge for prompt contracts and Oops
   * Loop evidence packaging.
   */
  public buildCognitiveContactSiteSummary(activeEmbodimentRef?: Ref): CognitiveContactSiteSummary {
    const report = this.buildContactSiteRegistryReport({ active_embodiment_ref: activeEmbodimentRef });
    const supportSummary = freezeArray(report.contact_sites
      .filter((site) => site.nominal_support)
      .map((site) => sanitizeText(`${site.contact_role} contact ${site.contact_site_ref} supports stance and has ${Math.round(site.max_contact_force_n)}N declared force capacity.`)));
    const manipulationSummary = freezeArray(report.contact_sites
      .filter((site) => !site.nominal_support)
      .map((site) => sanitizeText(`${site.contact_role} contact ${site.contact_site_ref} can provide tactile evidence for manipulation or tool use.`)));
    const tactileLimitSummary = freezeArray(report.role_summaries.map((summary) => sanitizeText(`${summary.contact_role} contacts: ${summary.site_count} site(s), force range ${Math.round(summary.force_limit_min_n)}N to ${Math.round(summary.force_limit_max_n)}N.`)));
    for (const text of [...supportSummary, ...manipulationSummary, ...tactileLimitSummary]) {
      assertNoForbiddenLeak(text);
    }
    const hidden = hiddenFieldsRemoved();
    const base = {
      schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      support_summary: supportSummary,
      manipulation_contact_summary: manipulationSummary,
      tactile_limit_summary: tactileLimitSummary,
      forbidden_detail_report_ref: `contact_site_hidden_${computeDeterminismHash({ report: report.determinism_hash, hidden }).slice(0, 12)}`,
      hidden_fields_removed: hidden,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireEmbodiment(embodimentRef?: Ref): EmbodimentDescriptor {
    const activeRef = embodimentRef ?? this.activeEmbodimentRef;
    if (activeRef !== undefined) {
      assertSafeRef(activeRef, "$.active_embodiment_ref");
      return this.registry.requireEmbodiment(activeRef);
    }
    const selected = this.registry.listEmbodiments().at(0);
    if (selected === undefined) {
      throw new ContactSiteRegistryError("No active embodiment is registered for contact site resolution.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before resolving contact sites."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createContactSiteRegistry(config: ContactSiteRegistryConfig = {}): ContactSiteRegistry {
  return new ContactSiteRegistry(config);
}

function resolveContactSite(
  model: EmbodimentDescriptor,
  site: ContactSiteDescriptor,
  hardwareManifest: VirtualHardwareManifest | undefined,
  path: string,
): ResolvedContactSite {
  const issues: ValidationIssue[] = [];
  validateSafeRef(site.contact_site_ref, `${path}.contact_site_ref`, issues, "ContactSiteRefInvalid");
  validateSafeRef(site.frame_ref, `${path}.frame_ref`, issues, "ContactFrameMissing");
  validateSafeRef(site.sensor_ref, `${path}.sensor_ref`, issues, "ContactSensorMissing");
  validateForceLimit(site.max_contact_force_n, `${path}.max_contact_force_n`, issues);
  const frame = model.frame_graph.find((candidate) => candidate.frame_id === site.frame_ref);
  if (frame === undefined) {
    issues.push(makeIssue("error", "ContactFrameMissing", `${path}.frame_ref`, `Contact frame ${site.frame_ref} is not declared.`, "Attach every contact site to a declared body/contact/end-effector/tool frame."));
  } else if (!isFrameRoleCompatible(site.contact_role, frame.frame_role)) {
    issues.push(makeIssue("warning", "ContactFrameRoleInvalid", `${path}.frame_ref`, `Contact role ${site.contact_role} is attached to frame role ${frame.frame_role}.`, "Use contact, end-effector, tool, or body frames for declared contact sites."));
  }
  if (site.nominal_support && !isSupportRole(site.contact_role)) {
    issues.push(makeIssue("warning", "ContactRoleInvalid", `${path}.nominal_support`, "Nominal support contacts should be feet, paws, hands, or body supports.", "Reserve nominal support for physical stance contacts."));
  }
  const hardware = site.sensor_ref === undefined
    ? undefined
    : hardwareManifest?.sensor_inventory.find((sensor): sensor is ContactSensorDescriptor => sensor.sensor_id === site.sensor_ref && (sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque"));
  if (hardwareManifest !== undefined && hardwareManifest.embodiment_kind !== model.embodiment_kind) {
    issues.push(makeIssue("error", "HardwareManifestMismatch", "$.hardware_manifest.embodiment_kind", "Hardware manifest embodiment kind differs from the active embodiment.", "Use the hardware manifest for the active body."));
  }
  if (site.sensor_ref !== undefined && hardwareManifest !== undefined && hardware === undefined) {
    const declaredWrongClass = hardwareManifest.sensor_inventory.find((sensor) => sensor.sensor_id === site.sensor_ref);
    issues.push(makeIssue(declaredWrongClass === undefined ? "warning" : "error", declaredWrongClass === undefined ? "ContactSensorMissing" : "ContactSensorClassMismatch", `${path}.sensor_ref`, `Contact sensor ${site.sensor_ref} is not declared as contact or force-torque hardware.`, "Declare the tactile sensor in the virtual hardware manifest."));
  }
  if (hardware !== undefined) {
    if (hardware.contact_site_ref !== site.contact_site_ref) {
      issues.push(makeIssue("error", "ContactSensorSiteMismatch", `${path}.sensor_ref`, "Hardware contact sensor points at a different contact site.", "Align hardware contact_site_ref with the embodiment contact site."));
    }
    if (hardware.mount_frame_ref !== site.frame_ref) {
      issues.push(makeIssue("warning", "HardwareManifestMismatch", `${path}.frame_ref`, "Hardware contact sensor mount frame differs from the contact site frame.", "Reconcile contact sensor mount frames."));
    }
    if (hardware.max_force_n < site.max_contact_force_n * 0.75) {
      issues.push(makeIssue("warning", "ContactForceLimitInvalid", `${path}.max_contact_force_n`, "Hardware force range is substantially lower than the embodiment contact limit.", "Use the lower hardware force range in control and Oops Loop checks."));
    }
  }
  const measuresForce = hardware?.measurement_kind === "force_estimate" || hardware?.measurement_kind === "combined" || hardware?.sensor_class === "force_torque";
  const measuresSlip = hardware?.measurement_kind === "slip_estimate" || hardware?.measurement_kind === "combined";
  const supportWeight = site.nominal_support ? Math.max(1, site.max_contact_force_n / Math.max(totalNominalSupportForce(model), EPSILON)) : 0;
  const health = classifyHealth(issues, site, hardwareManifest, hardware);
  const summary = sanitizeText(`${site.contact_role} contact ${site.contact_site_ref} maps to ${frame?.frame_role ?? "unknown"} frame ${site.frame_ref} with ${Math.round(site.max_contact_force_n)}N declared force limit.`);
  assertNoForbiddenLeak(summary);
  const base = {
    schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    contact_site_ref: site.contact_site_ref,
    contact_role: site.contact_role,
    frame_ref: site.frame_ref,
    frame_role: frame?.frame_role ?? "contact" as FrameDescriptor["frame_role"],
    parent_frame_ref: frame?.parent_frame_ref,
    sensor_ref: site.sensor_ref,
    nominal_support: site.nominal_support,
    max_contact_force_n: round6(site.max_contact_force_n),
    hardware_declared: hardware !== undefined,
    hardware_measurement_kind: hardware?.measurement_kind,
    measures_force: measuresForce,
    measures_slip: measuresSlip,
    support_weight_hint: round6(supportWeight),
    health_class: health,
    prompt_safe_summary: summary,
    hidden_fields_removed: hiddenFieldsRemoved(),
    issues: freezeArray(issues),
    ok: issues.every((issue) => issue.severity !== "error"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateContactCoverage(model: EmbodimentDescriptor, hardwareManifest: VirtualHardwareManifest | undefined): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<Ref>();
  for (const [index, site] of model.contact_sites.entries()) {
    if (seen.has(site.contact_site_ref)) {
      issues.push(makeIssue("error", "ContactSiteDuplicate", `$.contact_sites[${index}].contact_site_ref`, `Contact site ${site.contact_site_ref} is duplicated.`, "Use one canonical descriptor per physical contact site."));
    }
    seen.add(site.contact_site_ref);
  }
  if (model.contact_sites.length === 0) {
    issues.push(makeIssue("error", "ContactSiteMissing", "$.contact_sites", "Embodiment has no contact sites.", "Declare physical contact sites before enabling contact packets."));
  }
  const supportCount = model.contact_sites.filter((site) => site.nominal_support).length;
  if (supportCount < minimumSupportContacts(model.embodiment_kind)) {
    issues.push(makeIssue("error", "SupportContactInsufficient", "$.contact_sites", "Nominal support contacts are insufficient for the embodiment.", "Declare stable stance support contacts."));
  }
  if (hardwareManifest !== undefined) {
    const contactSensors = hardwareManifest.sensor_inventory.filter((sensor) => sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque") as readonly ContactSensorDescriptor[];
    for (const sensor of contactSensors) {
      if (!model.contact_sites.some((site) => site.contact_site_ref === sensor.contact_site_ref || site.sensor_ref === sensor.sensor_id)) {
        issues.push(makeIssue("warning", "HardwareManifestMismatch", "$.hardware_manifest.sensor_inventory", `Hardware contact sensor ${sensor.sensor_id} has no embodiment contact site.`, "Bind every tactile sensor to a declared contact site."));
      }
    }
  }
  return freezeArray(issues);
}

function evaluateSample(
  model: EmbodimentDescriptor,
  sites: readonly ResolvedContactSite[],
  sample: ContactEvidenceSample,
  consumer: ContactSiteConsumer,
): ContactEvidenceDecision {
  const issues: ValidationIssue[] = [];
  validateSafeRef(sample.contact_site_ref, "$.contact_site_ref", issues, "ContactSiteRefInvalid");
  validateSafeRef(sample.sensor_ref, "$.sensor_ref", issues, "ContactSensorMissing");
  if (sample.internal_contact_ref !== undefined) {
    issues.push(makeIssue("error", "InternalContactRefLeak", "$.internal_contact_ref", "Internal solver contact refs must not enter tactile evidence.", "Strip solver refs and keep declared contact site refs only."));
  }
  validateUnitInterval(sample.confidence, "$.confidence", issues, "ContactSlipAmbiguous");
  validateUnitInterval(sample.slip_probability, "$.slip_probability", issues, "ContactSlipAmbiguous");
  const site = sites.find((candidate) => candidate.contact_site_ref === sample.contact_site_ref);
  if (site === undefined) {
    issues.push(makeIssue("error", "ContactSiteMissing", "$.contact_site_ref", `Contact site ${sample.contact_site_ref} is not declared.`, "Use a declared contact site."));
    return buildSampleDecision(model, sample, "body", undefined, "unknown", "unknown", "unknown", false, false, issues, consumer);
  }
  if (sample.sensor_ref !== undefined && site.sensor_ref !== undefined && sample.sensor_ref !== site.sensor_ref) {
    issues.push(makeIssue("warning", "ContactSensorSiteMismatch", "$.sensor_ref", "Sample sensor ref differs from the declared contact site sensor.", "Use the declared tactile sensor for this contact site."));
  }
  if (sample.estimated_force_n !== undefined && (!Number.isFinite(sample.estimated_force_n) || sample.estimated_force_n < 0)) {
    issues.push(makeIssue("error", "ContactForceOutOfRange", "$.estimated_force_n", "Estimated force must be finite and non-negative.", "Use a sensor-derived approximate force."));
  }
  const forceRatio = sample.estimated_force_n === undefined ? 0 : sample.estimated_force_n / Math.max(site.max_contact_force_n, EPSILON);
  const forceClass = classifyForce(sample.in_contact, sample.estimated_force_n, site.max_contact_force_n);
  if (forceClass === "over_limit") {
    issues.push(makeIssue("error", "ContactForceOutOfRange", "$.estimated_force_n", "Estimated contact force exceeds the declared site limit.", "Stop or reduce force before continuing."));
  }
  const slipClass = classifySlip(sample.slip_probability, sample.in_contact, sample.confidence);
  if (slipClass === "likely") {
    issues.push(makeIssue("warning", "ContactSlipAmbiguous", "$.slip_probability", "Slip is likely at the declared contact site.", "Route to Oops Loop, slow down, or regrasp."));
  }
  const contactClass = classifyContact(sample, site, forceClass, slipClass);
  const usableSupport = sample.in_contact && sample.confidence >= 0.5 && site.nominal_support && forceClass !== "over_limit" && slipClass !== "likely";
  const usableManipulation = sample.in_contact && sample.confidence >= 0.4 && !site.nominal_support && forceClass !== "over_limit";
  return buildSampleDecision(model, sample, site.contact_role, site.sensor_ref, forceClass, slipClass, contactClass, usableSupport, usableManipulation, issues, consumer, site);
}

function buildSampleDecision(
  model: EmbodimentDescriptor,
  sample: ContactEvidenceSample,
  role: ContactSiteRole,
  sensorRef: Ref | undefined,
  forceClass: ContactForceClass,
  slipClass: ContactSlipClass,
  contactClass: ContactEvidenceClass,
  usableForSupport: boolean,
  usableForManipulation: boolean,
  issues: readonly ValidationIssue[],
  consumer: ContactSiteConsumer,
  site?: ResolvedContactSite,
): ContactEvidenceDecision {
  const forceRatio = sample.estimated_force_n === undefined || site === undefined ? 0 : sample.estimated_force_n / Math.max(site.max_contact_force_n, EPSILON);
  const summary = sanitizeText(buildContactEvidenceSummary(role, sample.in_contact, contactClass, forceClass, slipClass, consumer));
  assertNoForbiddenLeak(summary);
  const base = {
    schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    contact_site_ref: sample.contact_site_ref,
    contact_role: role,
    sensor_ref: sample.sensor_ref ?? sensorRef,
    in_contact: sample.in_contact,
    confidence: clamp(sample.confidence, 0, 1),
    force_class: forceClass,
    slip_class: slipClass,
    contact_class: contactClass,
    force_ratio: round6(forceRatio),
    usable_for_support: usableForSupport,
    usable_for_manipulation: usableForManipulation,
    prompt_safe_summary: summary,
    issues: freezeArray(issues),
    ok: issues.every((issue) => issue.severity !== "error"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildRoleSummaries(sites: readonly ResolvedContactSite[]): readonly ContactRoleSummary[] {
  const roles = freezeArray([...new Set(sites.map((site) => site.contact_role))].sort());
  return freezeArray(roles.map((role) => {
    const roleSites = sites.filter((site) => site.contact_role === role);
    const limits = roleSites.map((site) => site.max_contact_force_n);
    return Object.freeze({
      contact_role: role,
      site_count: roleSites.length,
      nominal_support_count: roleSites.filter((site) => site.nominal_support).length,
      sensor_backed_count: roleSites.filter((site) => site.sensor_ref !== undefined).length,
      force_limit_min_n: round6(Math.min(...limits)),
      force_limit_max_n: round6(Math.max(...limits)),
      average_force_limit_n: round6(limits.reduce((sum, value) => sum + value, 0) / Math.max(limits.length, 1)),
    });
  }));
}

function framePositionInBase(frameByRef: ReadonlyMap<Ref, FrameDescriptor>, frameRef: Ref, issues: ValidationIssue[], path: string): Vector3 {
  const positions: Vector3[] = [];
  const visited = new Set<Ref>();
  let cursor = frameByRef.get(frameRef);
  while (cursor !== undefined) {
    if (visited.has(cursor.frame_id)) {
      issues.push(makeIssue("error", "ContactFrameMissing", path, "Frame graph cycle prevents contact position resolution.", "Fix the frame graph."));
      return freezeVector3([0, 0, 0]);
    }
    visited.add(cursor.frame_id);
    if (cursor.transform_from_parent !== undefined) {
      positions.push(cursor.transform_from_parent.position_m);
    }
    if (cursor.parent_frame_ref === undefined) {
      break;
    }
    cursor = frameByRef.get(cursor.parent_frame_ref);
  }
  if (cursor === undefined) {
    issues.push(makeIssue("error", "ContactFrameMissing", path, `Frame ${frameRef} is not connected to the base frame.`, "Declare a connected body-relative frame graph."));
  }
  return freezeVector3([
    positions.reduce((sum, position) => sum + position[0], 0),
    positions.reduce((sum, position) => sum + position[1], 0),
    positions.reduce((sum, position) => sum + position[2], 0),
  ]);
}

function convexHull2D(points: readonly Vector3[]): readonly Vector3[] {
  const unique = [...new Map(points.map((point) => [`${round6(point[0])}:${round6(point[1])}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 2) {
    return freezeArray(unique);
  }
  const lower: Vector3[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vector3[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  return freezeArray([...lower.slice(0, -1), ...upper.slice(0, -1)]);
}

function polygonArea2D(points: readonly Vector3[]): number {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return Math.abs(area) / 2;
}

function centroid2D(points: readonly Vector3[]): Vector3 {
  if (points.length === 0) {
    return freezeVector3([0, 0, 0]);
  }
  return freezeVector3([
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
    points.reduce((sum, point) => sum + point[2], 0) / points.length,
  ]);
}

function maxPairwiseDistance2D(points: readonly Vector3[]): number {
  let maxDistance = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      maxDistance = Math.max(maxDistance, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
    }
  }
  return maxDistance;
}

function cross2D(origin: Vector3, a: Vector3, b: Vector3): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function classifyForce(inContact: boolean, force: number | undefined, limit: number): ContactForceClass {
  if (!inContact) {
    return "none";
  }
  if (force === undefined) {
    return "unknown";
  }
  const ratio = force / Math.max(limit, EPSILON);
  if (ratio > 1) {
    return "over_limit";
  }
  if (ratio >= 0.75) {
    return "high";
  }
  if (ratio >= 0.18) {
    return "nominal";
  }
  return "light";
}

function classifySlip(slipProbability: number | undefined, inContact: boolean, confidence: number): ContactSlipClass {
  if (!inContact) {
    return "none";
  }
  if (slipProbability === undefined) {
    return confidence < 0.35 ? "unknown" : "none";
  }
  if (slipProbability >= 0.65) {
    return "likely";
  }
  if (slipProbability >= 0.35) {
    return "possible";
  }
  return "none";
}

function classifyContact(sample: ContactEvidenceSample, site: ResolvedContactSite, force: ContactForceClass, slip: ContactSlipClass): ContactEvidenceClass {
  if (!sample.in_contact) {
    return "no_contact";
  }
  if (sample.contact_class_hint !== undefined && sample.contact_class_hint !== "unknown") {
    return sample.contact_class_hint;
  }
  if (slip === "likely") {
    return "slip";
  }
  if (force === "over_limit" || site.contact_role === "body") {
    return "collision";
  }
  if (site.contact_role === "tool") {
    return "tool_contact";
  }
  if (site.nominal_support) {
    return "resting_support";
  }
  if (site.contact_role === "hand" || site.contact_role === "fingertip" || site.contact_role === "mouth" || site.contact_role === "gripper") {
    return "grasp";
  }
  return "unknown";
}

function buildContactEvidenceSummary(role: ContactSiteRole, inContact: boolean, contactClass: ContactEvidenceClass, forceClass: ContactForceClass, slipClass: ContactSlipClass, consumer: ContactSiteConsumer): string {
  if (!inContact) {
    return `${role} contact reports no current contact for ${consumer}.`;
  }
  return `${role} contact is classified as ${contactClass} with ${forceClass} force and ${slipClass} slip risk for ${consumer}.`;
}

function isFrameRoleCompatible(role: ContactSiteRole, frameRole: FrameDescriptor["frame_role"]): boolean {
  if (role === "tool") {
    return frameRole === "tool" || frameRole === "end_effector" || frameRole === "contact";
  }
  if (role === "body") {
    return frameRole === "base" || frameRole === "torso" || frameRole === "contact";
  }
  return frameRole === "contact" || frameRole === "end_effector" || frameRole === "base";
}

function isSupportRole(role: ContactSiteRole): boolean {
  return role === "foot" || role === "paw" || role === "hand" || role === "body";
}

function classifyHealth(issues: readonly ValidationIssue[], site: ContactSiteDescriptor, hardwareManifest: VirtualHardwareManifest | undefined, hardware: ContactSensorDescriptor | undefined): ContactSiteHealthClass {
  if (issues.some((issue) => issue.severity === "error")) {
    return "degraded";
  }
  if (site.sensor_ref === undefined) {
    return "missing_sensor";
  }
  if (hardwareManifest !== undefined && hardware === undefined) {
    return "undeclared_sensor";
  }
  if (issues.length > 0) {
    return "degraded";
  }
  return "nominal";
}

function totalNominalSupportForce(model: EmbodimentDescriptor): number {
  return model.contact_sites.filter((site) => site.nominal_support).reduce((sum, site) => sum + site.max_contact_force_n, 0);
}

function minimumSupportContacts(kind: EmbodimentKind): number {
  return kind === "quadruped" ? 3 : 2;
}

function validateForceLimit(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", "ContactForceLimitInvalid", path, "Contact force limit must be positive and finite.", "Declare conservative force capacity in newtons."));
  }
}

function validateUnitInterval(value: number | undefined, path: string, issues: ValidationIssue[], code: ContactSiteIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", code, path, "Confidence or slip probability must be in [0, 1].", "Clamp or recompute the sensor-derived probability."));
  }
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: ContactSiteIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-safe reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference appears to contain forbidden simulator, solver, or QA detail.", "Use declared contact site refs only."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new ContactSiteRegistryError("Invalid contact site registry reference.", issues);
  }
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray([
    "internal_contact_refs",
    "solver_contact_manifolds",
    "backend_body_handles",
    "collision_mesh_refs",
    "exact_world_contact_points",
  ]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new ContactSiteRegistryError("Cognitive contact summary contains forbidden solver or body detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.prompt_safe_summary", "Summary contains forbidden simulator, solver, or QA detail.", "Sanitize exact internals before exposing contact summaries."),
    ]);
  }
}

function makeIssue(severity: ValidationSeverity, code: ContactSiteIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const CONTACT_SITE_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: CONTACT_SITE_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.7", "5.8", "5.9", "5.12", "5.15", "5.19", "5.20"]),
});
