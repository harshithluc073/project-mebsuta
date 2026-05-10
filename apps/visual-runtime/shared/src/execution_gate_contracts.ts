import {
  VisualRuntimeDemoRunSnapshot,
  VisualRuntimeExecutionEvent,
  VisualRuntimePlanStep,
  VisualRuntimeTelemetryEvent,
  VisualRuntimeValidationGate,
} from "./demo_contracts";

export type VisualRuntimeExecutionGateStatus = "accepted" | "safe_hold";

export type VisualRuntimeExecutionGateBlockReason =
  | "none"
  | "invalid_plan"
  | "out_of_scope_task"
  | "unsafe_policy"
  | "unreachable_route";

export interface VisualRuntimeExecutionGateDecision {
  readonly status: VisualRuntimeExecutionGateStatus;
  readonly blockReason: VisualRuntimeExecutionGateBlockReason;
  readonly safeHoldEntered: boolean;
  readonly executionPrimitive: "visible_route_following" | "safe_hold";
  readonly summary: string;
}

export interface VisualRuntimeExecutionGateRun extends VisualRuntimeDemoRunSnapshot {
  readonly gateDecision: VisualRuntimeExecutionGateDecision;
  readonly validation: readonly VisualRuntimeValidationGate[];
  readonly execution: readonly VisualRuntimeExecutionEvent[];
  readonly telemetry: readonly VisualRuntimeTelemetryEvent[];
  readonly plan: readonly VisualRuntimePlanStep[];
}
