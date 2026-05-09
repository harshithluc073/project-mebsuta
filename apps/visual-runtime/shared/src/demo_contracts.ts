import { VisualRuntimeVector3, VisualRuntimeWorldSnapshot } from "./world_contracts";

export type VisualRuntimeDemoTaskId =
  | "inspect_work_cell"
  | "deliver_payload_case"
  | "return_to_charger";

export type VisualRuntimePlanStepKind =
  | "observe"
  | "navigate"
  | "inspect"
  | "manipulate"
  | "dock"
  | "verify";

export type VisualRuntimeGateState = "passed" | "blocked" | "pending";

export interface VisualRuntimeDemoTask {
  readonly id: VisualRuntimeDemoTaskId;
  readonly label: string;
  readonly operatorText: string;
  readonly targetObjectId: string;
  readonly targetZoneId: string;
}

export interface VisualRuntimePlanStep {
  readonly id: string;
  readonly kind: VisualRuntimePlanStepKind;
  readonly label: string;
  readonly state: "ready" | "running" | "complete";
}

export interface VisualRuntimeValidationGate {
  readonly gate: string;
  readonly state: VisualRuntimeGateState;
  readonly reason: string;
}

export interface VisualRuntimeExecutionEvent {
  readonly time: string;
  readonly label: string;
  readonly state: "ready" | "running" | "complete";
}

export interface VisualRuntimeVerificationResult {
  readonly certificateId: string;
  readonly result: "passed";
  readonly evidence: readonly string[];
  readonly hiddenSimulatorTruthExposed: false;
}

export interface VisualRuntimeTelemetryEvent {
  readonly id: string;
  readonly at: string;
  readonly message: string;
}

export interface VisualRuntimeDemoRunSnapshot {
  readonly runId: string;
  readonly mode: "demo_ready";
  readonly task: VisualRuntimeDemoTask;
  readonly plan: readonly VisualRuntimePlanStep[];
  readonly validation: readonly VisualRuntimeValidationGate[];
  readonly execution: readonly VisualRuntimeExecutionEvent[];
  readonly verification: VisualRuntimeVerificationResult;
  readonly telemetry: readonly VisualRuntimeTelemetryEvent[];
  readonly worldSnapshot: VisualRuntimeWorldSnapshot;
  readonly executionPath: readonly VisualRuntimeVector3[];
  readonly browserReceivesProviderKey: false;
}

export const VISUAL_RUNTIME_DEMO_TASKS: readonly VisualRuntimeDemoTask[] = [
  {
    id: "inspect_work_cell",
    label: "Inspect Work Cell",
    operatorText: "Inspect the work cell, visit the inspection zone, and report safe visual evidence.",
    targetObjectId: "sensor-puck-a",
    targetZoneId: "inspection-zone",
  },
  {
    id: "deliver_payload_case",
    label: "Deliver Payload Case",
    operatorText: "Carry the payload case through the visible route and stop at the delivery zone.",
    targetObjectId: "payload-case-a",
    targetZoneId: "delivery-zone",
  },
  {
    id: "return_to_charger",
    label: "Return To Charger",
    operatorText: "Navigate to the charging pad and verify docking from visible contact evidence.",
    targetObjectId: "charging-pad-a",
    targetZoneId: "charging-pad-a",
  },
] as const;

export const DEFAULT_VISUAL_RUNTIME_DEMO_TASK = VISUAL_RUNTIME_DEMO_TASKS[0]!;

export const getVisualRuntimeDemoTask = (taskId?: string): VisualRuntimeDemoTask => {
  const task = VISUAL_RUNTIME_DEMO_TASKS.find((entry) => entry.id === taskId);
  return task ?? DEFAULT_VISUAL_RUNTIME_DEMO_TASK;
};
