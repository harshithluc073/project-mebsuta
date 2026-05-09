/**
 * PIT-B02 runtime composition root. It wires environment loading, service
 * lifecycle, health/readiness, orchestration state, scenario admission, and
 * graceful shutdown without creating the PIT-B03 API route layer.
 */

import { OrchestrationStateMachine, type RuntimeStateSnapshot } from "../orchestration/orchestration_state_machine";
import { loadRuntimeConfig, type RuntimeConfig, type RuntimeEnvironment } from "./runtime_config";
import { buildReadinessSnapshot, surfaceStatus, type RuntimeReadinessSnapshot } from "./runtime_readiness_snapshot";
import { RuntimeServiceRegistry } from "./runtime_service_registry";
import { ScenarioSessionManager, type ScenarioAdmissionRecord, type ScenarioAdmissionRequest } from "./scenario_session_manager";
import { InMemoryRuntimeService } from "./service_lifecycle";

export const MEBSUTA_RUNTIME_SCHEMA_VERSION = "mebsuta.runtime_composition.v1" as const;

export interface RuntimeStartResult {
  readonly config: RuntimeConfig;
  readonly readiness: RuntimeReadinessSnapshot;
  readonly orchestration_snapshot: RuntimeStateSnapshot;
}

export interface RuntimeShutdownResult {
  readonly runtime_ref: string;
  readonly readiness: RuntimeReadinessSnapshot;
  readonly stopped_at_ms: number;
  readonly graceful: boolean;
}

export class MebsutaRuntime {
  private readonly config: RuntimeConfig;
  private readonly registry: RuntimeServiceRegistry;
  private readonly stateMachine: OrchestrationStateMachine;
  private readonly scenarioSessions = new ScenarioSessionManager();
  private stopping = false;
  private started = false;
  private orchestrationSnapshot?: RuntimeStateSnapshot;

  public constructor(config: RuntimeConfig, registry = defaultRegistry(), stateMachine = new OrchestrationStateMachine()) {
    this.config = config;
    this.registry = registry;
    this.stateMachine = stateMachine;
  }

  public static fromEnvironment(env: RuntimeEnvironment, argv: readonly string[] = []): MebsutaRuntime {
    const result = loadRuntimeConfig(env, argv);
    if (result.config === undefined) {
      throw new Error(`Runtime configuration failed: ${result.issues.join(" ")}`);
    }
    return new MebsutaRuntime(result.config);
  }

  public async start(nowMs = Date.now()): Promise<RuntimeStartResult> {
    if (this.started) {
      return Object.freeze({
        config: this.config,
        readiness: this.readiness(nowMs),
        orchestration_snapshot: this.requiredSnapshot(),
      });
    }
    this.orchestrationSnapshot = this.stateMachine.initializeRuntimeState({
      session_ref: `${this.config.runtime_ref}:session`,
      task_ref: `${this.config.runtime_ref}:task`,
      embodiment_ref: "embodiment:runtime-validation",
      initialized_at_ms: nowMs,
    });
    await this.registry.startAll();
    this.started = true;
    return Object.freeze({
      config: this.config,
      readiness: this.readiness(nowMs),
      orchestration_snapshot: this.requiredSnapshot(),
    });
  }

  public readiness(nowMs = Date.now()): RuntimeReadinessSnapshot {
    const serviceSurfaces = this.registry.surfaces();
    const processReady = this.started && !this.stopping;
    const orchestrationReady = this.orchestrationSnapshot !== undefined && this.orchestrationSnapshot.safety_mode === "Normal";
    return buildReadinessSnapshot({
      runtime_ref: this.config.runtime_ref,
      health_state: this.stopping ? "stopping" : this.started ? "live" : "starting",
      stopping: this.stopping,
      generated_at_ms: nowMs,
      surfaces: Object.freeze([
        surfaceStatus("process", processReady, processReady ? "Runtime process is started." : "Runtime process has not finished startup."),
        ...serviceSurfaces,
        surfaceStatus(
          "orchestration",
          orchestrationReady,
          orchestrationReady ? "Orchestration state initialized with normal safety mode." : "Orchestration state is unavailable or unsafe.",
          this.orchestrationSnapshot === undefined ? [] : [this.orchestrationSnapshot.current_context_ref],
        ),
      ]),
    });
  }

  public health(nowMs = Date.now()): RuntimeReadinessSnapshot {
    return this.readiness(nowMs);
  }

  public admitScenario(request: ScenarioAdmissionRequest, nowMs = Date.now()): ScenarioAdmissionRecord {
    return this.scenarioSessions.admitScenario(request, {
      config: this.config,
      readiness: this.readiness(nowMs),
      orchestration_snapshot: this.requiredSnapshot(),
    });
  }

  public async shutdown(nowMs = Date.now()): Promise<RuntimeShutdownResult> {
    this.stopping = true;
    await this.registry.stopAll();
    this.started = false;
    const readiness = buildReadinessSnapshot({
      runtime_ref: this.config.runtime_ref,
      health_state: "stopped",
      stopping: false,
      generated_at_ms: nowMs,
      surfaces: Object.freeze([
        surfaceStatus("process", false, "Runtime process has stopped."),
        ...this.registry.surfaces(),
        surfaceStatus("scenario_admission", false, "Scenario admission is closed after shutdown."),
      ]),
    });
    return Object.freeze({
      runtime_ref: this.config.runtime_ref,
      readiness,
      stopped_at_ms: nowMs,
      graceful: true,
    });
  }

  public scenarioAuditRecords(): readonly ScenarioAdmissionRecord[] {
    return this.scenarioSessions.auditRecords();
  }

  private requiredSnapshot(): RuntimeStateSnapshot {
    if (this.orchestrationSnapshot === undefined) {
      throw new Error("Runtime has not initialized orchestration state.");
    }
    return this.orchestrationSnapshot;
  }
}

function defaultRegistry(): RuntimeServiceRegistry {
  const registry = new RuntimeServiceRegistry();
  registry.register(new InMemoryRuntimeService({
    service_ref: "service:orchestration",
    surfaceFactory: (ready) => surfaceStatus("orchestration", ready, ready ? "Orchestration service lifecycle is running." : "Orchestration service is not running."),
  }));
  registry.register(new InMemoryRuntimeService({
    service_ref: "service:execution_gatekeeper",
    dependencies: Object.freeze(["service:orchestration"]),
    surfaceFactory: (ready) => surfaceStatus("execution_gatekeeper", ready, ready ? "Execution gatekeeper contract is available." : "Execution gatekeeper contract is unavailable."),
  }));
  registry.register(new InMemoryRuntimeService({
    service_ref: "service:safety",
    dependencies: Object.freeze(["service:orchestration"]),
    surfaceFactory: (ready) => surfaceStatus("safety", ready, ready ? "SafeHold and safety contract surface is available." : "Safety contract surface is unavailable."),
  }));
  registry.register(new InMemoryRuntimeService({
    service_ref: "service:scenario_admission",
    dependencies: Object.freeze(["service:orchestration", "service:execution_gatekeeper", "service:safety"]),
    surfaceFactory: (ready) => surfaceStatus("scenario_admission", ready, ready ? "Scenario admission guard is ready." : "Scenario admission guard is unavailable."),
  }));
  return registry;
}

