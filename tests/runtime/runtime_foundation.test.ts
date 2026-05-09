import { describe, expect, it } from "vitest";

import { OrchestrationStateMachine } from "../../src/orchestration/orchestration_state_machine";
import { loadRuntimeConfig } from "../../src/runtime/runtime_config";
import { MebsutaRuntime } from "../../src/runtime/mebsuta_runtime";
import { ScenarioSessionManager } from "../../src/runtime/scenario_session_manager";

describe("PIT-B02 runtime composition foundation", () => {
  it("loads local validation config and redacts unsupported runtime modes", () => {
    const loaded = loadRuntimeConfig({ MEBSUTA_RUNTIME_MODE: "local_validation" }, ["--validation"]);

    expect(loaded.issues).toEqual([]);
    expect(loaded.config?.mode).toBe("local_validation");
    expect(loaded.config?.admission_requires_safe_hold_clear).toBe(true);
  });

  it("starts, reports readiness, admits a safe runtime-visible scenario, and shuts down gracefully", async () => {
    const runtime = MebsutaRuntime.fromEnvironment({ MEBSUTA_RUNTIME_MODE: "local_validation" }, ["--validation"]);

    const started = await runtime.start(1_000);
    const admitted = runtime.admitScenario({
      scenario_ref: "scenario:runtime-foundation",
      task_ref: started.orchestration_snapshot.task_ref,
      requested_at_ms: 1_001,
      truth_boundary_status: "runtime_embodied_only",
    }, 1_001);
    const shutdown = await runtime.shutdown(1_002);

    expect(started.readiness.readiness_state).toBe("ready");
    expect(started.readiness.accepting_scenarios).toBe(true);
    expect(admitted.decision).toBe("admitted");
    expect(shutdown.graceful).toBe(true);
    expect(shutdown.readiness.health_state).toBe("stopped");
  });

  it("rejects scenario admission when runtime readiness or truth boundary is unsafe", () => {
    const configResult = loadRuntimeConfig({}, ["--validation"]);
    expect(configResult.config).toBeDefined();
    const stateMachine = new OrchestrationStateMachine();
    const snapshot = stateMachine.initializeRuntimeState({
      session_ref: "session:blocked",
      task_ref: "task:blocked",
      embodiment_ref: "embodiment:test",
      initialized_at_ms: 2_000,
      safety_mode: "SafeHoldRequired",
    });
    const manager = new ScenarioSessionManager();
    const record = manager.admitScenario({
      scenario_ref: "scenario:blocked",
      task_ref: "task:blocked",
      requested_at_ms: 2_001,
      truth_boundary_status: "runtime_memory_labeled",
    }, {
      config: configResult.config!,
      readiness: {
        schema_version: "mebsuta.runtime_readiness_snapshot.v1",
        runtime_ref: "runtime:blocked",
        health_state: "live",
        readiness_state: "blocked",
        accepting_scenarios: false,
        stopping: false,
        surfaces: [],
        generated_at_ms: 2_001,
      },
      orchestration_snapshot: snapshot,
      active_safe_hold_ref: "safe_hold:active",
    });

    expect(record.decision).toBe("rejected");
    expect(record.blocked_reasons).toContain("Runtime readiness is not ready.");
    expect(record.blocked_reasons).toContain("Scenario admission accepts only runtime-visible boundary status.");
    expect(record.blocked_reasons).toContain("Active SafeHold blocks scenario admission.");
  });

  it("keeps SafeHold resume aligned to fresh observation instead of direct execution", () => {
    const machine = new OrchestrationStateMachine();
    const initial = machine.initializeRuntimeState({
      session_ref: "session:safehold",
      task_ref: "task:safehold",
      embodiment_ref: "embodiment:test",
      initialized_at_ms: 3_000,
    });
    const safeHoldDecision = machine.interruptForSafety(initial, {
      event_ref: "event:safehold",
      event_type: "SafeHoldCommanded",
      event_family: "safety",
      severity: "warning",
      session_ref: "session:safehold",
      task_ref: "task:safehold",
      context_ref: initial.current_context_ref,
      payload_refs: ["safety:trigger"],
      provenance_classes: ["safety"],
      occurred_at_ms: 3_001,
      human_summary: "Safety hold requested by runtime validation.",
    });
    const safeHoldSnapshot = machine.commitStateTransition(initial, safeHoldDecision);
    const resumeDecision = machine.resumeFromSafeHold(safeHoldSnapshot, "fresh_observation", {
      event_ref: "event:resume",
      event_type: "OperatorResume",
      event_family: "operator",
      severity: "notice",
      session_ref: "session:safehold",
      task_ref: "task:safehold",
      context_ref: safeHoldSnapshot.current_context_ref,
      payload_refs: ["operator:resume"],
      provenance_classes: ["operator"],
      occurred_at_ms: 3_002,
      human_summary: "Operator cleared runtime validation for fresh observation.",
    });

    expect(safeHoldSnapshot.primary_state).toBe("SafeHold");
    expect(resumeDecision.proposed_to_state).toBe("Observe");
  });
});
