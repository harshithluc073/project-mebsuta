/**
 * Health and readiness projection for the runtime composition foundation.
 */

export const RUNTIME_READINESS_SCHEMA_VERSION = "mebsuta.runtime_readiness_snapshot.v1" as const;

export type RuntimeHealthState = "starting" | "live" | "degraded" | "stopping" | "stopped";
export type RuntimeReadinessState = "not_ready" | "ready" | "blocked";

export type RuntimeReadinessSurface =
  | "process"
  | "runtime_services"
  | "orchestration"
  | "execution_gatekeeper"
  | "safety"
  | "scenario_admission";

export interface RuntimeSurfaceStatus {
  readonly surface: RuntimeReadinessSurface;
  readonly ready: boolean;
  readonly reason: string;
  readonly evidence_refs: readonly string[];
}

export interface RuntimeReadinessSnapshot {
  readonly schema_version: typeof RUNTIME_READINESS_SCHEMA_VERSION;
  readonly runtime_ref: string;
  readonly health_state: RuntimeHealthState;
  readonly readiness_state: RuntimeReadinessState;
  readonly accepting_scenarios: boolean;
  readonly stopping: boolean;
  readonly surfaces: readonly RuntimeSurfaceStatus[];
  readonly generated_at_ms: number;
}

export function buildReadinessSnapshot(input: {
  readonly runtime_ref: string;
  readonly health_state: RuntimeHealthState;
  readonly stopping: boolean;
  readonly surfaces: readonly RuntimeSurfaceStatus[];
  readonly generated_at_ms: number;
}): RuntimeReadinessSnapshot {
  const allReady = input.surfaces.every((surface) => surface.ready);
  const readinessState: RuntimeReadinessState = input.stopping ? "blocked" : allReady ? "ready" : "not_ready";
  return Object.freeze({
    schema_version: RUNTIME_READINESS_SCHEMA_VERSION,
    runtime_ref: input.runtime_ref,
    health_state: input.health_state,
    readiness_state: readinessState,
    accepting_scenarios: readinessState === "ready",
    stopping: input.stopping,
    surfaces: freezeArray(input.surfaces),
    generated_at_ms: input.generated_at_ms,
  });
}

export function surfaceStatus(
  surface: RuntimeReadinessSurface,
  ready: boolean,
  reason: string,
  evidenceRefs: readonly string[] = [],
): RuntimeSurfaceStatus {
  return Object.freeze({
    surface,
    ready,
    reason,
    evidence_refs: freezeArray(evidenceRefs),
  });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

