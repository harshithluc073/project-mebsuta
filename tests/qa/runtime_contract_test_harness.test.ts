import { describe, expect, it } from "vitest";

import { buildArtifactEnvelope, type ArtifactEnvelope } from "../../src/api/artifact_envelope";
import { buildProvenanceManifest, type ProvenanceManifest } from "../../src/api/provenance_manifest_contract";
import { evaluateRuntimeQaBoundary, type RuntimeQaBoundaryDecision } from "../../src/api/runtime_qa_boundary_guard";
import {
  executeQaContractSurface,
  runRuntimeContractHarness,
  validateRuntimeContractHarnessResult,
  type QaContractCoverageDomain,
  type RuntimeContractArtifact,
} from "../../src/qa/runtime_contract_test_harness";
import { buildTestCaseSpec, type QaEvidenceClass, type TestCaseSpec } from "../../src/qa/test_case_spec";

describe("PIT-B10 runtime contract test harness", () => {
  it("generates harness, run, and release reports for the authorized contract surface", () => {
    const artifacts = runtimeArtifacts("green");
    const report = executeQaContractSurface({
      harness_run_ref: "qa-run:pit-b10:green",
      test_case: testCase("qa-case:pit-b10:green", "none", ["runtime_artifact", "replay_bundle", "policy_ref"]),
      runtime_contract_artifacts: artifacts,
      required_artifact_refs: artifactRefs(artifacts),
      coverage_domains: allCoverageDomains(),
      started_at_ms: 1_000,
      ended_at_ms: 1_240,
      replay_bundle_ref: "replay:pit-b10:green",
      milestone_ref: "milestone:pit-b10",
      benchmark_scorecard_refs: ["scorecard:pit-b10:contract"],
      operator_summary: "PIT-B10 contract harness evidence is complete and runtime boundary evidence is present.",
    });

    expect(report.overall_status).toBe("ok");
    expect(report.test_case_validation_report.ok).toBe(true);
    expect(report.harness_result.overall_status).toBe("ok");
    expect(report.test_run_record.overall_status).toBe("ok");
    expect(report.test_run_record.timing.duration_ms).toBe(240);
    expect(report.release_readiness_report.decision).toBe("go");
    expect(report.release_readiness_report.red_gate_count).toBe(0);
    expect(report.boundary_protected).toBe(true);
    expect(report.runtime_qa_boundary_artifact_count).toBe(1);
    expect(report.coverage_domains).toEqual(allCoverageDomains());
  });

  it("keeps offline scoring artifacts out of runtime cognition through boundary evidence", () => {
    const artifacts = offlineScoringArtifacts();
    const report = executeQaContractSurface({
      harness_run_ref: "qa-run:pit-b10:offline-boundary",
      test_case: testCase("qa-case:pit-b10:offline-boundary", "offline_only", ["runtime_artifact", "offline_truth", "replay_bundle"]),
      runtime_contract_artifacts: artifacts,
      required_artifact_refs: artifactRefs(artifacts),
      coverage_domains: ["runtime_qa_boundary", "contract", "api"],
      started_at_ms: 2_000,
      ended_at_ms: 2_100,
      replay_bundle_ref: "replay:pit-b10:offline-boundary",
      milestone_ref: "milestone:pit-b10",
      benchmark_scorecard_refs: ["scorecard:pit-b10:offline-boundary"],
      operator_summary: "Offline scoring evidence is represented only by QA scoped artifacts and rejected at runtime boundary.",
    });

    const boundaryDecision = artifacts.find((artifact) => artifact.kind === "runtime_qa_boundary_decision")?.value as RuntimeQaBoundaryDecision | undefined;

    expect(boundaryDecision?.decision).toBe("quarantined");
    expect(boundaryDecision?.approved_visibility_class).toBe("restricted_quarantine");
    expect(report.boundary_protected).toBe(true);
    expect(report.release_readiness_report.decision).toBe("go");
    expect(JSON.stringify(report)).not.toContain("qa truth");
    expect(JSON.stringify(report)).not.toContain("oracle");
  });

  it("fails the contract surface when a required runtime artifact is missing", () => {
    const artifacts = runtimeArtifacts("missing-required");
    const report = executeQaContractSurface({
      harness_run_ref: "qa-run:pit-b10:missing-required",
      test_case: testCase("qa-case:pit-b10:missing-required", "none", ["runtime_artifact", "replay_bundle"]),
      runtime_contract_artifacts: artifacts,
      required_artifact_refs: [...artifactRefs(artifacts), "artifact:pit-b10:required-absent"],
      coverage_domains: ["contract", "integration"],
      started_at_ms: 3_000,
      ended_at_ms: 3_020,
      replay_bundle_ref: "replay:pit-b10:missing-required",
      milestone_ref: "milestone:pit-b10",
      benchmark_scorecard_refs: ["scorecard:pit-b10:missing-required"],
      operator_summary: "Required runtime artifact closure is intentionally incomplete for negative contract coverage.",
    });

    expect(report.overall_status).toBe("fail");
    expect(report.harness_result.missing_required_artifact_refs).toEqual(["artifact:pit-b10:required-absent"]);
    expect(report.release_readiness_report.decision).toBe("no_go");
    expect(report.release_readiness_report.no_go_conditions).toContain("runtime_contract_harness_failed");
  });

  it("fails the harness when a caller-provided restricted runtime term is found", () => {
    const term = "runtime-answer-" + "key";
    const artifacts = runtimeArtifacts("term-hit", term);
    const result = runRuntimeContractHarness({
      harness_run_ref: "qa-run:pit-b10:term-hit",
      test_case_ref: "qa-case:pit-b10:term-hit",
      runtime_contract_artifacts: artifacts,
      required_artifact_refs: artifactRefs(artifacts),
      forbidden_runtime_terms: [term],
    });
    const validation = validateRuntimeContractHarnessResult(result);

    expect(result.overall_status).toBe("fail");
    expect(result.forbidden_term_hits).toEqual([term]);
    expect(validation.ok).toBe(true);
    expect(result.assertion_results.find((assertion) => assertion.assertion_ref.endsWith("runtime_term_boundary"))?.status).toBe("fail");
  });
});

function allCoverageDomains(): readonly QaContractCoverageDomain[] {
  return ["unit", "contract", "integration", "runtime_qa_boundary", "api", "storage", "auth", "frontend", "safety"] as const;
}

function testCase(ref: string, truthUsage: TestCaseSpec["qa_truth_usage"], auditArtifacts: readonly QaEvidenceClass[]): TestCaseSpec {
  return buildTestCaseSpec({
    test_case_ref: ref,
    test_name: "PIT-B10 contract surface validation",
    test_layer: "schema_contract",
    subsystem_scope: ["subsystem:qa", "subsystem:api", "subsystem:safety"],
    requirement_refs: ["architecture:20:contract-tests", "production-readiness:10:test-evidence"],
    preconditions: ["Runtime artifacts are supplied through API contracts."],
    stimulus: "Run deterministic contract harness over runtime-safe artifacts.",
    expected_runtime_behavior: ["Harness validates contracts and emits audit evidence."],
    forbidden_runtime_behavior: ["Runtime cognition receives offline scoring evidence."],
    qa_truth_usage: truthUsage,
    acceptance_criteria: [{
      criterion_ref: `${ref}:criterion:contract`,
      description: "Contract reports, run record, and release gate evidence are generated deterministically.",
      severity: "error",
      required_evidence_classes: auditArtifacts,
    }],
    audit_artifacts_required: auditArtifacts,
    release_gate_refs: ["release-gate:pit-b10:contract"],
    deterministic_seed_ref: `${ref}:seed`,
  });
}

function runtimeArtifacts(suffix: string, componentRef = "component:pit-b10-contract-fixture"): readonly RuntimeContractArtifact[] {
  const provenance = runtimeProvenance(suffix);
  const envelope = runtimeEnvelope(suffix, provenance, componentRef);
  const boundary = evaluateRuntimeQaBoundary({
    boundary_request_ref: `boundary-request:pit-b10:${suffix}`,
    destination: "runtime_validator",
    artifact_envelope: envelope,
    provenance_manifest: provenance,
    payload_summary: "Runtime-safe certificate summary.",
    payload_keys: ["certificate_ref", "evidence_refs", "policy_refs"],
  });
  return [
    { kind: "provenance_manifest", value: provenance },
    { kind: "artifact_envelope", value: envelope },
    { kind: "runtime_qa_boundary_decision", value: boundary },
  ];
}

function offlineScoringArtifacts(): readonly RuntimeContractArtifact[] {
  const provenance = buildProvenanceManifest({
    provenance_manifest_ref: "provenance:pit-b10:offline-score",
    source_classes: ["qa_truth"],
    cognitive_visibility: "forbidden",
    memory_visibility: "forbidden",
    qa_visibility: "offline_only",
    truth_boundary_status: "qa_truth_only",
    source_artifact_refs: ["offline-score:pit-b10"],
    policy_refs: ["policy:pit-b10:truth-isolation"],
    audit_notes: ["Offline scoring evidence remains QA scoped."],
  });
  const envelope = buildArtifactEnvelope({
    artifact_ref: "artifact:pit-b10:offline-score",
    artifact_type: "qa_scorecard",
    schema_ref: "schema:pit-b10:offline-score",
    service_of_record: "qa_scenario",
    created_at_ms: 2_000,
    created_by_component: "component:pit-b10-qa-scorer",
    provenance_manifest_ref: provenance.provenance_manifest_ref,
    validation_status: "valid",
    visibility_class: "qa_offline",
    policy_refs: ["policy:pit-b10:truth-isolation"],
    audit_replay_refs: ["replay:pit-b10:offline-score"],
  });
  const boundary = evaluateRuntimeQaBoundary({
    boundary_request_ref: "boundary-request:pit-b10:offline-score",
    destination: "runtime_cognition",
    artifact_envelope: envelope,
    provenance_manifest: provenance,
    payload_summary: "Offline scoring payload is not runtime evidence.",
    payload_keys: ["offline_score_ref", "aggregate_gate"],
  });
  return [
    { kind: "provenance_manifest", value: provenance },
    { kind: "artifact_envelope", value: envelope },
    { kind: "runtime_qa_boundary_decision", value: boundary },
  ];
}

function runtimeProvenance(suffix: string): ProvenanceManifest {
  return buildProvenanceManifest({
    provenance_manifest_ref: `provenance:pit-b10:${suffix}`,
    source_classes: ["embodied_sensor", "validator_output", "policy_config"],
    cognitive_visibility: "summarized",
    memory_visibility: "forbidden",
    qa_visibility: "not_allowed",
    truth_boundary_status: "runtime_embodied_only",
    source_artifact_refs: [`sensor:pit-b10:${suffix}`, `validation:pit-b10:${suffix}`],
    policy_refs: ["policy:pit-b10:contract"],
    audit_notes: ["Runtime-safe evidence is summarized for contract validation."],
  });
}

function runtimeEnvelope(suffix: string, provenance: ProvenanceManifest, componentRef: string): ArtifactEnvelope {
  return buildArtifactEnvelope({
    artifact_ref: `artifact:pit-b10:${suffix}`,
    artifact_type: "verification_certificate",
    schema_ref: `schema:pit-b10:${suffix}`,
    service_of_record: "verification",
    created_at_ms: 1_000,
    created_by_component: componentRef,
    task_ref: "task:pit-b10",
    provenance_manifest_ref: provenance.provenance_manifest_ref,
    validation_status: "valid",
    visibility_class: "runtime_deterministic",
    policy_refs: ["policy:pit-b10:contract"],
    audit_replay_refs: [`replay:pit-b10:${suffix}`],
  });
}

function artifactRefs(artifacts: readonly RuntimeContractArtifact[]): readonly string[] {
  return artifacts.map((artifact) => {
    if (artifact.kind === "artifact_envelope") return artifact.value.artifact_ref;
    if (artifact.kind === "provenance_manifest") return artifact.value.provenance_manifest_ref;
    return artifact.value.boundary_decision_ref;
  });
}
