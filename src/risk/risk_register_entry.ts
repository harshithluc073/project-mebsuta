/**
 * Risk register entry contract.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.2, 22.3, 22.4, 22.5, 22.9, 22.11, and 22.12.
 *
 * This module turns the architecture risk register into executable, immutable
 * records with deterministic validation. Risk records are intentionally allowed
 * to name critical boundary hazards because this layer is the governance system
 * that detects, routes, and mitigates those hazards before release decisions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const RISK_BLUEPRINT_REF = "architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md" as const;
export const RISK_REGISTER_ENTRY_SCHEMA_VERSION = "mebsuta.risk.risk_register_entry.v1" as const;

export type RiskCategory =
  | "R-CGN"
  | "R-FWL"
  | "R-PER"
  | "R-GEO"
  | "R-CTL"
  | "R-MAN"
  | "R-VER"
  | "R-MEM"
  | "R-AUD"
  | "R-OBS"
  | "R-SAF"
  | "R-QA"
  | "R-OPS";

export type RiskSeverity = "critical" | "high" | "medium" | "low";
export type RiskLikelihood = "frequent" | "likely" | "occasional" | "rare" | "remote";
export type RiskStatus = "open" | "mitigating" | "monitored" | "accepted" | "blocker" | "retired";
export type RiskOwnerCategory =
  | "architecture"
  | "ai_integration"
  | "agent_runtime"
  | "perception"
  | "geometry"
  | "controls"
  | "manipulation"
  | "verification"
  | "recovery"
  | "memory"
  | "acoustic"
  | "observability"
  | "safety"
  | "qa"
  | "program_management";
export type RiskRoute = "continue" | "mitigate" | "review" | "safe_hold" | "release_block";

export interface RiskValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly recommended_route: RiskRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RiskRegisterEntryInput {
  readonly risk_ref: Ref;
  readonly risk_name: string;
  readonly risk_category: RiskCategory;
  readonly risk_statement: string;
  readonly root_causes: readonly string[];
  readonly trigger_signals: readonly string[];
  readonly severity: RiskSeverity;
  readonly likelihood: RiskLikelihood;
  readonly detection_methods: readonly string[];
  readonly primary_mitigations: readonly string[];
  readonly contingency_plan: readonly string[];
  readonly owner_category: RiskOwnerCategory;
  readonly related_architecture_docs: readonly Ref[];
  readonly related_qa_gates: readonly Ref[];
  readonly current_status: RiskStatus;
  readonly no_go_condition?: boolean;
}

export interface RiskRegisterEntry {
  readonly schema_version: typeof RISK_REGISTER_ENTRY_SCHEMA_VERSION;
  readonly risk_ref: Ref;
  readonly risk_name: string;
  readonly risk_category: RiskCategory;
  readonly risk_statement: string;
  readonly root_causes: readonly string[];
  readonly trigger_signals: readonly string[];
  readonly severity: RiskSeverity;
  readonly likelihood: RiskLikelihood;
  readonly detection_methods: readonly string[];
  readonly primary_mitigations: readonly string[];
  readonly contingency_plan: readonly string[];
  readonly owner_category: RiskOwnerCategory;
  readonly related_architecture_docs: readonly Ref[];
  readonly related_qa_gates: readonly Ref[];
  readonly current_status: RiskStatus;
  readonly no_go_condition: boolean;
  readonly priority_rank: number;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable risk record and rejects incomplete governance data.
 */
export function buildRiskRegisterEntry(input: RiskRegisterEntryInput): RiskRegisterEntry {
  const entry = normalizeRiskRegisterEntry(input);
  const report = validateRiskRegisterEntry(entry);
  if (!report.ok) {
    throw new RiskContractError("Risk register entry failed validation.", report.issues);
  }
  return entry;
}

export function normalizeRiskRegisterEntry(input: RiskRegisterEntryInput): RiskRegisterEntry {
  const base = {
    schema_version: RISK_REGISTER_ENTRY_SCHEMA_VERSION,
    risk_ref: normalizeRiskRef(input.risk_ref),
    risk_name: normalizeRiskText(input.risk_name, 180),
    risk_category: input.risk_category,
    risk_statement: normalizeRiskText(input.risk_statement, 900),
    root_causes: uniqueRiskStrings(input.root_causes),
    trigger_signals: uniqueRiskStrings(input.trigger_signals),
    severity: input.severity,
    likelihood: input.likelihood,
    detection_methods: uniqueRiskStrings(input.detection_methods),
    primary_mitigations: uniqueRiskStrings(input.primary_mitigations),
    contingency_plan: uniqueRiskStrings(input.contingency_plan),
    owner_category: input.owner_category,
    related_architecture_docs: uniqueRiskRefs(input.related_architecture_docs),
    related_qa_gates: uniqueRiskRefs(input.related_qa_gates),
    current_status: input.current_status,
    no_go_condition: input.no_go_condition ?? input.severity === "critical",
    priority_rank: riskPriorityRank(input.severity, input.likelihood, input.current_status),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskRegisterEntry(entry: RiskRegisterEntry): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(entry.risk_ref, "$.risk_ref", issues);
  validateRiskText(entry.risk_name, "$.risk_name", true, issues);
  validateRiskText(entry.risk_statement, "$.risk_statement", true, issues);
  validateRiskNonEmptyArray(entry.root_causes, "$.root_causes", "RiskRootCausesMissing", issues);
  validateRiskNonEmptyArray(entry.trigger_signals, "$.trigger_signals", "RiskTriggerSignalsMissing", issues);
  validateRiskNonEmptyArray(entry.detection_methods, "$.detection_methods", "RiskDetectionMethodsMissing", issues);
  validateRiskNonEmptyArray(entry.primary_mitigations, "$.primary_mitigations", "RiskMitigationsMissing", issues);
  validateRiskNonEmptyArray(entry.contingency_plan, "$.contingency_plan", "RiskContingencyMissing", issues);
  validateRiskNonEmptyArray(entry.related_architecture_docs, "$.related_architecture_docs", "RiskArchitectureDocsMissing", issues);
  validateRiskNonEmptyArray(entry.related_qa_gates, "$.related_qa_gates", "RiskQaGatesMissing", issues);
  validateRiskRefs(entry.related_architecture_docs, "$.related_architecture_docs", issues);
  validateRiskRefs(entry.related_qa_gates, "$.related_qa_gates", issues);
  for (const [index, value] of entry.root_causes.entries()) {
    validateRiskText(value, `$.root_causes[${index}]`, true, issues);
  }
  for (const [index, value] of entry.trigger_signals.entries()) {
    validateRiskText(value, `$.trigger_signals[${index}]`, true, issues);
  }
  if (entry.severity === "critical" && entry.no_go_condition === false && entry.current_status !== "retired") {
    issues.push(riskIssue("error", "CriticalRiskNoGoMissing", "$.no_go_condition", "Active critical risks must be release no-go candidates.", "Mark the risk as a no-go condition or retire it with evidence."));
  }
  if (entry.current_status === "blocker" && entry.severity !== "critical" && entry.severity !== "high") {
    issues.push(riskIssue("warning", "LowBlockerReview", "$.current_status", "Blockers are expected to be critical or high severity.", "Confirm that the release gate impact is intentional."));
  }
  return buildRiskValidationReport(makeRiskRef("risk_register_entry_report", entry.risk_ref), issues, riskRouteForIssues(issues, entry));
}

export function buildRiskRegister(inputs: readonly RiskRegisterEntryInput[]): readonly RiskRegisterEntry[] {
  const entries = freezeRiskArray(inputs.map(buildRiskRegisterEntry).sort((left, right) => left.risk_ref.localeCompare(right.risk_ref)));
  const seen = new Set<Ref>();
  for (const entry of entries) {
    if (seen.has(entry.risk_ref)) {
      throw new RiskContractError("Risk register contains duplicate refs.", [
        riskIssue("error", "RiskRefDuplicate", "$.risks", "Risk refs must be unique.", "Rename or merge the duplicate risk."),
      ]);
    }
    seen.add(entry.risk_ref);
  }
  return entries;
}

export function defaultRiskRegister(): readonly RiskRegisterEntry[] {
  return buildRiskRegister([
    risk("R-001", "Hidden Truth Prompt Leakage", "R-FWL", "Prompt assembly includes simulator-only identifiers or exact poses, causing model cognition to receive prohibited backend knowledge.", ["Prompt allowlist drift", "Provenance manifest gap"], ["Prompt provenance rejection", "Restricted field detected in prompt"], "critical", "occasional", ["Prompt firewall contract test", "Provenance scan"], ["Schema allowlist", "Artifact provenance manifest"], ["Block prompt", "Quarantine artifact", "SafeHold if execution is pending"], "safety", ["02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md", "07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md"], ["provenance_contract_tests", "prompt_firewall_tests"]),
    risk("R-002", "QA Truth Runtime Leakage", "R-QA", "Offline benchmark truth enters runtime certificates, memory, or model context, invalidating simulation-blind behavior.", ["QA/runtime boundary drift", "Improper artifact visibility"], ["Runtime artifact references offline scoring source"], "critical", "rare", ["Runtime QA boundary guard", "Visibility-class audit"], ["Offline-only scoring boundary", "Release gate review"], ["Invalidate run", "Quarantine artifacts", "Block release"], "qa", ["20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md"], ["runtime_qa_boundary_guard", "release_readiness_report"]),
    risk("R-003", "Success Without Certificate", "R-VER", "Task completion is declared from controller completion or model assertion without a verification certificate.", ["Orchestrator invariant gap", "Misrouted completion event"], ["Complete state entered without certificate ref"], "critical", "occasional", ["State-machine invariant test", "Verification certificate gate"], ["Completion route requires certificate"], ["Roll back route", "Open incident", "Block milestone"], "agent_runtime", ["08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md", "13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md"], ["verification_certificate_gate", "runtime_contract_tests"]),
    risk("R-004", "Safety Validator Bypass", "R-SAF", "Execution dispatch receives motion or tool command without an accepted safety envelope.", ["Command schema gap", "Safety gate integration drift"], ["Control command lacks safety report ref"], "critical", "rare", ["Safety validator release gate", "Command envelope validation"], ["Mandatory safety report in command contract"], ["Abort execution", "Enter SafeHold", "Block release"], "safety", ["18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"], ["safety_release_gates", "runtime_monitor_chaos_tests"]),
    risk("R-005", "Verified Memory Contamination", "R-MEM", "Failed, ambiguous, stale, or restricted-provenance data is stored as verified memory.", ["Write gate gap", "Certificate not enforced"], ["Memory record lacks certificate or has forbidden provenance"], "critical", "occasional", ["Memory write gate test", "Provenance auditor"], ["Certificate requirement", "Memory quarantine"], ["Quarantine memory", "Rebuild indexes", "Add regression"], "memory", ["15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md"], ["memory_write_gate_tests", "hidden_truth_memory_tests"]),
    risk("R-006", "No-RL Boundary Violation", "R-QA", "Scenario score is used to update behavior policy, violating the project no-RL constraint.", ["Governance drift", "Reward-like metric misuse"], ["Artifact references policy training from outcomes"], "critical", "remote", ["No-RL conformance scan", "Architecture review"], ["Metrics restricted to QA scoring"], ["Freeze affected component", "Remove mechanism", "Block release"], "architecture", ["01_SYSTEM_ARCHITECTURE_OVERVIEW.md", "20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md"], ["no_rl_conformance_tests"]),
    risk("R-007", "Blind Physical Correction", "R-MAN", "Oops correction executes from audio-only or ambiguous evidence without visual or tactile support.", ["Evidence sufficiency gap", "Audio route overreach"], ["Correction plan lacks visual or tactile evidence refs"], "critical", "occasional", ["Oops evidence gate", "Audio safety policy"], ["Require multi-modal support for correction"], ["Abort correction", "Reobserve", "Incident review"], "recovery", ["14_OOPS_LOOP_CORRECTION_ENGINE.md", "16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md"], ["audio_only_correction_tests", "oops_gate_tests"]),
    risk("R-008", "Tool Action Without Envelope", "R-MAN", "Tool primitive executes without swept-volume and contact-point validation.", ["Tool safety envelope missing", "Feature gate drift"], ["Tool command lacks tool safety report"], "critical", "occasional", ["Tool safety validator", "Swept-volume tests"], ["Tool feature gate", "Contact-point validation"], ["Stop tool use", "SafeHold if motion is active", "Disable feature gate"], "manipulation", ["12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md", "18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"], ["tool_use_safety_scenarios"]),
    risk("R-009", "Gemini Structured Output Drift", "R-CGN", "Model response omits required fields or changes format, increasing repair and review load.", ["Preview model drift", "Prompt contract mismatch"], ["Schema validation failure rate rises"], "high", "likely", ["Golden prompt suite", "Schema validation"], ["Versioned prompt contracts"], ["Repair prompt", "Freeze model version", "HumanReview after budget"], "ai_integration", ["06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md", "07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md"], ["golden_prompt_regression_suite"]),
    risk("R-010", "Gemini Overconfident Visual Claim", "R-CGN", "Model states a relation is satisfied while deterministic view sufficiency is weak.", ["Occlusion", "Overconfident visual reasoning"], ["View sufficiency fails while answer claims success"], "high", "likely", ["False-positive guard", "View sufficiency evaluator"], ["Ambiguity instruction in prompt"], ["Override with ambiguity", "Reobserve", "Add prompt regression"], "verification", ["09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md", "13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md"], ["false_positive_scenarios"]),
    risk("R-011", "Unsafe Correction Proposal", "R-SAF", "Model proposes a high-force, blind, or tool-unsafe corrective action.", ["Insufficient safety context", "Malformed plan"], ["Safety output validator rejects proposal"], "high", "occasional", ["Correction safety validator", "Plan normalizer"], ["Safety policy context in prompt"], ["Reject proposal", "Request safer variant", "HumanReview"], "safety", ["14_OOPS_LOOP_CORRECTION_ENGINE.md", "18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"], ["correction_safety_tests"]),
    risk("R-012", "Prompt Context Overload", "R-CGN", "Too many views, memory records, and policies dilute model attention.", ["Token budget overflow", "Poor retrieval ranking"], ["Malformed response rate rises"], "medium", "likely", ["Context budget manager", "Retrieval ranker"], ["Prompt compression"], ["Narrow task context", "Split reasoning phases"], "ai_integration", ["06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md"], ["prompt_budget_tests"], false),
    risk("R-013", "Model Latency Or Rate Limit", "R-CGN", "API latency or rate limiting disrupts the runtime loop.", ["External API pressure", "Timeout policy gap"], ["Gemini timeout or rate-limit event"], "medium", "likely", ["Timeout monitor", "Retry coordinator"], ["Async state handling"], ["Hold state", "Reobserve", "HumanReview"], "ai_integration", ["06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md"], ["rate_limit_tests"], false),
    risk("R-014", "Preview Model Capability Misassumption", "R-CGN", "Architecture assumes unsupported model modality or behavior.", ["Stale model assumptions", "Capability registry gap"], ["Integration test fails against supported API behavior"], "high", "occasional", ["Model capability registry", "Official-doc review cadence"], ["Adapter isolation"], ["Remove unsupported path", "Use deterministic substitute"], "architecture", ["06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md"], ["model_capability_tests"]),
    risk("R-015", "Object Identity Confusion", "R-PER", "Similar objects cause the system to select the wrong target.", ["Low descriptor confidence", "Insufficient crops"], ["Conflicting object hypotheses"], "high", "likely", ["Multi-view crops", "Identity confidence labels"], ["Disambiguation policy"], ["Reobserve close-up", "Block manipulation"], "perception", ["09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md"], ["identity_ambiguity_tests"]),
    risk("R-016", "Occlusion False Positive", "R-VER", "Gripper, tool, rim, or object hides the relation being verified.", ["View coverage gap", "False-positive guard threshold drift"], ["High occlusion with success claim"], "high", "likely", ["Required view matrix", "False-positive guard"], ["Alternate view planning"], ["Reobserve", "Safe retreat if needed"], "verification", ["13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md"], ["occlusion_false_positive_tests"]),
    risk("R-017", "Coordinate Frame Mismatch", "R-GEO", "Pose or target is expressed in the wrong or stale frame.", ["Transform cache drift", "Missing frame ref"], ["Residual direction inconsistent across services"], "high", "occasional", ["Frame graph validity checks", "Transform unit tests"], ["Frame refs on artifacts"], ["Recompute estimates", "Block execution"], "geometry", ["10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md"], ["frame_graph_tests"]),
    risk("R-018", "Pose Uncertainty Underestimated", "R-PER", "Perception reports overconfident pose estimates.", ["Calibration drift", "Weak uncertainty model"], ["Offline benchmark outside uncertainty band"], "high", "occasional", ["Uncertainty calibration benchmark", "Conservative margins"], ["Residual QA"], ["Increase uncertainty", "Tighten success gate"], "perception", ["09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md"], ["uncertainty_calibration_tests"]),
    risk("R-019", "Multi-View Desynchronization", "R-PER", "Camera frames describe different scene states.", ["Timestamp skew", "Async camera capture"], ["Bundle skew exceeds policy"], "medium", "likely", ["Sync policy", "Bundle validation"], ["Desync rejection"], ["Recapture synchronized bundle"], "perception", ["09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md"], ["multi_view_sync_tests"], false),
    risk("R-020", "Spatial Constraint Misclassification", "R-GEO", "Inside, on-top, or aligned relation logic returns the wrong class.", ["Constraint formula defect", "Tolerance mismatch"], ["QA benchmark disagrees with certificate class"], "high", "occasional", ["Constraint unit tests", "Residual QA"], ["Definition review"], ["Patch constraint rule", "Invalidate affected certificates"], "geometry", ["10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md"], ["spatial_constraint_tests"]),
    risk("R-021", "PD Instability", "R-CTL", "Poor gain tuning or timing drift causes oscillation, residual growth, or saturation.", ["Contact stiffness mismatch", "Step jitter"], ["PD residual spike"], "high", "occasional", ["Gain profiles", "Runtime monitors"], ["Stability tests"], ["Abort motion", "SafeHold", "Retune profile"], "controls", ["11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md"], ["pd_unit_tests"]),
    risk("R-022", "IK Feasibility False Positive", "R-CTL", "IK solver reports feasible posture near singularity or collision.", ["Singularity margin too small", "Collision check gap"], ["Runtime joint limit warning"], "high", "occasional", ["Singularity margins", "Collision checks"], ["Feasibility validation"], ["Stop", "Repair plan", "Reobserve"], "controls", ["11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md"], ["ik_feasibility_tests"]),
    risk("R-023", "Object Slip During Grasp Or Release", "R-MAN", "Contact force, friction, or speed is unsuitable for stable manipulation.", ["Friction mismatch", "Fast release"], ["Slip monitor or visual motion"], "high", "likely", ["Cautious profiles", "Tactile monitoring"], ["Settle verification"], ["Oops correction if safe", "SafeHold near edge"], "manipulation", ["12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md"], ["slip_scenarios"]),
    risk("R-024", "Controller Completion Misread", "R-VER", "Primitive completion is interpreted as task success.", ["Routing invariant gap", "Weak verification handoff"], ["Completion event routes directly to Complete"], "critical", "rare", ["Orchestrator invariant", "Verification required after primitive"], ["Route table tests"], ["Block route", "Add regression"], "agent_runtime", ["08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md"], ["runtime_contract_tests"]),
    risk("R-025", "Tool Collateral Contact", "R-SAF", "Tool sweep contacts an unintended object.", ["Swept-volume miss", "View requirement miss"], ["Tool envelope monitor or visual displacement"], "critical", "occasional", ["Swept-volume validation", "Tool view requirements"], ["Cautious force"], ["SafeHold", "HumanReview", "Disable feature gate"], "safety", ["12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md"], ["tool_collision_tests"]),
    risk("R-026", "Embodiment Capability Mismatch", "R-MAN", "Plan assumes a capability that the selected body does not have.", ["Capability summary drift", "Prompt omission"], ["Embodiment validator rejects plan"], "medium", "occasional", ["Embodiment adapter", "Capability summaries"], ["Feature-gate by body type"], ["Repair plan for embodiment"], "manipulation", ["05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md"], ["embodiment_contract_tests"], false),
    risk("R-027", "False Success Certificate", "R-VER", "Verification passes despite the task not actually being complete.", ["Evidence insufficiency", "Tolerance too permissive"], ["Benchmark contradiction"], "critical", "occasional", ["Multi-view evidence", "Residual uncertainty"], ["False-positive guard"], ["Block release", "Inspect replay", "Tighten policy"], "verification", ["13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md"], ["false_success_benchmarks"]),
    risk("R-028", "Excessive Ambiguity Rate", "R-VER", "Verification is too conservative or views are insufficient.", ["View planner weakness", "Sensor placement gap"], ["High cannot-assess metrics"], "medium", "likely", ["View planner improvements", "Crop strategy"], ["Sensor placement review"], ["Add views", "Narrow scenarios"], "verification", ["13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md"], ["ambiguity_rate_tests"], false),
    risk("R-029", "Oops Infinite Retry Loop", "R-VER", "Retry budget is missing or unenforced.", ["Budget manager gap", "Route invariant defect"], ["Attempt count exceeds budget"], "critical", "rare", ["Retry budget manager", "Route invariant tests"], ["Attempt cap"], ["Terminate episode", "SafeHold or HumanReview", "Block release"], "recovery", ["14_OOPS_LOOP_CORRECTION_ENGINE.md"], ["oops_retry_budget_tests"]),
    risk("R-030", "Oops Corrects Wrong Failure Cause", "R-VER", "Failure classification or diagnosis selects the wrong corrective cause.", ["Weak evidence bundle", "Low classifier confidence"], ["Correction worsens residual"], "high", "occasional", ["Evidence sufficiency", "Classification confidence"], ["Post-correction verification"], ["Reclassify", "Reobserve", "Tighten policy"], "recovery", ["14_OOPS_LOOP_CORRECTION_ENGINE.md"], ["wrong_cause_correction_tests"]),
    risk("R-031", "Reobserve Disturbs Scene", "R-PER", "Camera or body movement changes the object state during observation.", ["Contact during view acquisition", "Unsafe camera path"], ["Object pose changes during observation"], "high", "occasional", ["No-contact reobserve policy", "Safe view constraints"], ["Motion envelope review"], ["Treat as new event", "Verify", "SafeHold if needed"], "perception", ["09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md"], ["reobserve_disturbance_tests"]),
    risk("R-032", "Failure Unsafe Routed As Correctable", "R-SAF", "Unsafe evidence is routed into correction instead of SafeHold.", ["Route table defect", "Certificate class gap"], ["Unsafe evidence with correctable route"], "critical", "rare", ["Safety route validator", "Route table tests"], ["SafeHold precedence"], ["SafeHold", "Incident review", "Block release"], "safety", ["18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"], ["unsafe_route_tests"]),
    risk("R-033", "Stale Memory Drives Bad Action", "R-MEM", "Old memory is presented too strongly and influences action without fresh perception.", ["Staleness score too weak", "Retrieval purpose mismatch"], ["Action planned without fresh evidence"], "high", "occasional", ["Staleness labels", "Retrieval filters"], ["Prompt memory formatter"], ["Reobserve", "Record contradiction", "Tune decay"], "memory", ["15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md"], ["memory_staleness_tests"]),
    risk("R-034", "Object Identity Merge Error", "R-MEM", "Memory merges two similar objects into one identity.", ["Conservative split policy missing", "Ambiguous retrieval"], ["Contradictory simultaneous sightings"], "high", "occasional", ["Identity reconciliation", "Split warnings"], ["Quarantine on contradiction"], ["Split records", "Require disambiguation"], "memory", ["15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md"], ["identity_merge_tests"]),
    risk("R-035", "Audio Mislocalized", "R-AUD", "Reflections, noise, or mic geometry produce a wrong direction estimate.", ["Room acoustics", "Low confidence cone"], ["Visual search fails in estimated region"], "medium", "likely", ["Localization uncertainty cone", "Audio as search hint"], ["Self-noise filter"], ["Widen search", "Lower confidence"], "acoustic", ["16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md"], ["audio_localization_tests"], false),
    risk("R-036", "Audio-Only Success Or Correction", "R-AUD", "Audio event is interpreted as final proof or direct action target.", ["Audio route overreach", "Verification gate gap"], ["Success or correction lacks visual or tactile evidence"], "critical", "rare", ["Audio safety rules", "Verification gate"], ["Oops evidence gate"], ["Block action", "Incident review", "Add test"], "acoustic", ["16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md"], ["audio_only_success_tests"]),
    risk("R-037", "TTS Self-Noise Misinterpreted", "R-AUD", "Agent monologue is captured as external voice or sound.", ["Playback marker gap", "Suppression delay"], ["Audio event overlaps TTS playback"], "medium", "occasional", ["TTS playback markers", "Self-noise suppression"], ["Marker timing tests"], ["Suppress event", "Adjust marker timing"], "acoustic", ["17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md"], ["tts_self_noise_tests"], false),
    risk("R-038", "Acoustic Failure Cue Ignored", "R-AUD", "Impact, slide, or roll cue is not routed to verification.", ["Audio route matrix gap", "Dashboard alert miss"], ["Audio event without task-relevant follow-up"], "high", "occasional", ["Audio route matrix", "Safety routing"], ["Dashboard alerts"], ["Trigger delayed reobserve", "Add regression"], "acoustic", ["16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md"], ["audio_failure_cue_tests"]),
    risk("R-039", "Monologue Leaks Restricted Data", "R-OBS", "TTS or dashboard text exposes restricted internal data.", ["Redaction miss", "Visibility mode drift"], ["Redaction audit violation"], "critical", "rare", ["Monologue safety filter", "Visibility modes"], ["Redaction tests"], ["Block TTS", "Quarantine log", "Incident review"], "observability", ["17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md"], ["tts_redaction_tests"]),
    risk("R-040", "Replay Trace Incomplete", "R-OBS", "Missing evidence refs or policy refs prevent QA reconstruction.", ["Instrumentation gap", "Artifact envelope gap"], ["QA cannot reconstruct decision"], "high", "occasional", ["Artifact envelope", "Replay bundle requirements"], ["Observability tests"], ["Mark run invalid", "Add instrumentation"], "qa", ["17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md", "20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md"], ["replay_completeness_tests"]),
    risk("R-041", "Benchmark Flakiness", "R-QA", "Non-deterministic seeds, physics drift, or model variability produce unexplained variance.", ["Seed drift", "Model version drift"], ["Same scenario varies without explanation"], "medium", "likely", ["Fixed seeds", "Replay checkpoints"], ["Model version tracking"], ["Mark flaky", "Isolate source"], "qa", ["20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md"], ["flaky_scenario_tests"], false),
    risk("R-042", "Interface Drift Across Workstreams", "R-OPS", "Service contracts change without downstream updates.", ["Schema version drift", "Weak integration cadence"], ["Contract tests fail"], "high", "likely", ["Schema versioning", "Service-of-record map"], ["Architecture review"], ["Freeze interface", "Migration plan"], "architecture", ["19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md", "21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md"], ["interface_drift_tests"]),
    risk("R-043", "Schedule Compression Skips Safety", "R-OPS", "Delivery pressure defers safety or QA gates.", ["Milestone pressure", "Governance gap"], ["Demo requested before gates are green"], "critical", "occasional", ["Release gate governance", "No-go criteria"], ["Program escalation"], ["De-scope feature", "Block release", "Leadership review"], "program_management", ["21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md"], ["release_readiness_reviews"]),
    risk("R-044", "Documentation Staleness", "R-OPS", "Implementation differs from architecture and traceability docs.", ["Change review miss", "Doc ownership gap"], ["Traceability scan mismatch"], "medium", "likely", ["Doc ownership", "Change review"], ["Traceability scan"], ["Update docs", "Block if safety relevant"], "architecture", ["24_TRACEABILITY_MATRIX_MASTER_PLAN_TO_ARCHITECTURE.md"], ["traceability_scan_tests"], false),
    risk("R-045", "Overly Conservative System Fails To Progress", "R-SAF", "Safety or verification policies are too strict for low-risk progress.", ["Threshold too tight", "View planner weak"], ["High reobserve rate with low hazard"], "medium", "likely", ["Policy tuning with offline QA", "Staged thresholds"], ["Supported-scenario limits"], ["Conditional release", "Improve view planner"], "safety", ["18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"], ["policy_tuning_tests"], false),
    risk("R-046", "Overly Permissive System Appears Impressive But Unsafe", "R-SAF", "Demo pressure lowers gates and hides ambiguity or unsafe behavior.", ["Gate loosening", "Independent QA missing"], ["False success or unsafe action"], "critical", "occasional", ["No-go gates", "Independent QA"], ["False-positive benchmarks"], ["Stop demo path", "Incident review", "Tighten gates"], "safety", ["18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md", "20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md"], ["false_positive_benchmarks"]),
  ]);
}

export class RiskContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "RiskContractError";
    this.issues = freezeRiskArray(issues);
  }
}

export function buildRiskValidationReport(reportRef: Ref, issues: readonly ValidationIssue[], recommendedRoute: RiskRoute): RiskValidationReport {
  const frozenIssues = freezeRiskArray(issues);
  const errorCount = frozenIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = frozenIssues.length - errorCount;
  const base = {
    report_ref: reportRef,
    ok: errorCount === 0,
    issue_count: frozenIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    recommended_route: recommendedRoute,
    issues: frozenIssues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function riskRouteForIssues(issues: readonly ValidationIssue[], entry?: Pick<RiskRegisterEntry, "severity" | "current_status" | "no_go_condition">): RiskRoute {
  if (entry?.current_status === "blocker" || (entry?.severity === "critical" && entry.no_go_condition)) {
    return "release_block";
  }
  if (issues.some((issue) => issue.severity === "error" && /Critical|NoGo|Release|Safety/u.test(issue.code))) {
    return "release_block";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "mitigate";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "review";
  }
  return "continue";
}

export function riskIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function severityWeight(severity: RiskSeverity): number {
  const weights: Readonly<Record<RiskSeverity, number>> = { critical: 5, high: 4, medium: 3, low: 1 };
  return weights[severity];
}

export function likelihoodWeight(likelihood: RiskLikelihood): number {
  const weights: Readonly<Record<RiskLikelihood, number>> = { frequent: 5, likely: 4, occasional: 3, rare: 2, remote: 1 };
  return weights[likelihood];
}

export function riskPriorityRank(severity: RiskSeverity, likelihood: RiskLikelihood, status: RiskStatus): number {
  const statusBoost: Readonly<Record<RiskStatus, number>> = { blocker: 10, open: 3, mitigating: 2, monitored: 0, accepted: 0, retired: -10 };
  return Math.max(0, severityWeight(severity) * likelihoodWeight(likelihood) + statusBoost[status]);
}

export function validateRiskRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/u.test(ref)) {
    issues.push(riskIssue("error", "RiskRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque risk ref."));
  }
}

export function validateRiskRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  refs.forEach((ref, index) => validateRiskRef(ref, `${path}[${index}]`, issues));
}

export function validateRiskText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(riskIssue("error", "RiskTextRequired", path, "Required risk text is empty.", "Provide concise risk governance text."));
  }
}

export function validateRiskNonEmptyArray<T>(items: readonly T[], path: string, code: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(riskIssue("error", code, path, "Array must contain at least one item.", "Attach the required risk governance entries."));
  }
}

export function validateRiskRatio(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(riskIssue("error", "RiskRatioInvalid", path, "Ratio must be finite and within [0, 1].", "Clamp or recompute the metric deterministically."));
  }
}

export function normalizeRiskRef(value: Ref): Ref {
  return value.trim().toUpperCase();
}

export function normalizeRiskText(value: string, maxChars = 1200): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function makeRiskRef(...parts: readonly (string | number | undefined)[]): Ref {
  const value = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return value.length > 0 ? `risk:${value}` : "risk:empty";
}

export function uniqueRiskRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeRiskArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0).map((item) => item.trim()))]);
}

export function uniqueRiskStrings(items: readonly string[]): readonly string[] {
  return freezeRiskArray([...new Set(items.map((item) => normalizeRiskText(item)).filter((item) => item.length > 0))]);
}

export function freezeRiskArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function risk(
  riskRef: Ref,
  riskName: string,
  riskCategory: RiskCategory,
  riskStatement: string,
  rootCauses: readonly string[],
  triggerSignals: readonly string[],
  severity: RiskSeverity,
  likelihood: RiskLikelihood,
  detectionMethods: readonly string[],
  primaryMitigations: readonly string[],
  contingencyPlan: readonly string[],
  ownerCategory: RiskOwnerCategory,
  relatedArchitectureDocs: readonly Ref[],
  relatedQaGates: readonly Ref[],
  noGoCondition?: boolean,
): RiskRegisterEntryInput {
  return {
    risk_ref: riskRef,
    risk_name: riskName,
    risk_category: riskCategory,
    risk_statement: riskStatement,
    root_causes: rootCauses,
    trigger_signals: triggerSignals,
    severity,
    likelihood,
    detection_methods: detectionMethods,
    primary_mitigations: primaryMitigations,
    contingency_plan: contingencyPlan,
    owner_category: ownerCategory,
    related_architecture_docs: relatedArchitectureDocs,
    related_qa_gates: relatedQaGates,
    current_status: "open",
    no_go_condition: noGoCondition,
  };
}

export const RISK_REGISTER_ENTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_REGISTER_ENTRY_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.2", "22.3", "22.4", "22.5", "22.9", "22.11", "22.12"]),
  component: "RiskRegisterEntry",
});
