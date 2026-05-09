import {
  VisualRuntimeDemoRunSnapshot,
  VisualRuntimeDemoTask,
  VisualRuntimeExecutionEvent,
  VisualRuntimePlanStep,
  VisualRuntimeTelemetryEvent,
  VisualRuntimeValidationGate,
  VisualRuntimeVerificationResult,
  getVisualRuntimeDemoTask,
} from "../../shared/src/demo_contracts";
import {
  VisualRuntimeVector3,
  VisualRuntimeWorldSnapshot,
  createInitialVisualRuntimeWorldSnapshot,
} from "../../shared/src/world_contracts";

interface DemoRuntimeOptions {
  readonly taskId?: string;
  readonly now?: () => string;
}

const visibleRouteByTask = (task: VisualRuntimeDemoTask): readonly VisualRuntimeVector3[] => {
  if (task.id === "deliver_payload_case") {
    return [
      { x: -2.6, y: 0.04, z: -1.2 },
      { x: -1.2, y: 0.04, z: -0.3 },
      { x: 0, y: 0.04, z: 0 },
      { x: 1.5, y: 0.04, z: 0.8 },
      { x: -2.4, y: 0.04, z: 2.2 },
    ];
  }

  if (task.id === "return_to_charger") {
    return [
      { x: 0, y: 0.04, z: 0 },
      { x: 1.3, y: 0.04, z: 0.4 },
      { x: 2.2, y: 0.04, z: 1.2 },
      { x: 2.8, y: 0.04, z: 2 },
    ];
  }

  return [
    { x: 0, y: 0.04, z: 0 },
    { x: 0.9, y: 0.04, z: -0.8 },
    { x: 1.8, y: 0.04, z: -1.6 },
    { x: 2.6, y: 0.04, z: -2.4 },
  ];
};

const createWorldSnapshotForTask = (
  task: VisualRuntimeDemoTask,
  executionPath: readonly VisualRuntimeVector3[],
): VisualRuntimeWorldSnapshot => {
  const baseSnapshot = createInitialVisualRuntimeWorldSnapshot();
  const finalPose = executionPath[executionPath.length - 1] ?? baseSnapshot.robot.position;

  return {
    ...baseSnapshot,
    snapshotId: `vr-06-demo-${task.id}`,
    robot: {
      position: finalPose,
      headingRadians: task.id === "inspect_work_cell" ? -0.55 : 0.25,
      gaitPhase: 1,
    },
    activityPath: executionPath,
    hiddenSimulatorTruthExposed: false,
  };
};

export const createDeterministicDemoPlan = (
  task: VisualRuntimeDemoTask,
): readonly VisualRuntimePlanStep[] => [
  {
    id: "P1",
    kind: "observe",
    label: "Assemble allowed visual observation packet",
    state: "complete",
  },
  {
    id: "P2",
    kind: "navigate",
    label: `Navigate toward ${task.targetZoneId}`,
    state: "complete",
  },
  {
    id: "P3",
    kind: task.id === "return_to_charger" ? "dock" : task.id === "deliver_payload_case" ? "manipulate" : "inspect",
    label: task.operatorText,
    state: "complete",
  },
  {
    id: "P4",
    kind: "verify",
    label: "Verify outcome from allowed visual evidence",
    state: "complete",
  },
];

export const validateDeterministicDemoPlan = (
  task: VisualRuntimeDemoTask,
  plan: readonly VisualRuntimePlanStep[],
): readonly VisualRuntimeValidationGate[] => [
  {
    gate: "Schema",
    state: plan.length === 4 ? "passed" : "blocked",
    reason: "Deterministic plan has the required four ordered steps.",
  },
  {
    gate: "Task scope",
    state: "passed",
    reason: `Preset task ${task.id} is within the local demo task set.`,
  },
  {
    gate: "Safety policy",
    state: "passed",
    reason: "Execution remains inside the visible workshop route and safe hold remains armed.",
  },
  {
    gate: "Reachability",
    state: "passed",
    reason: `Target zone ${task.targetZoneId} is reachable from the current visible route.`,
  },
  {
    gate: "Evidence boundary",
    state: "passed",
    reason: "Verification uses visible object, route, and zone evidence only.",
  },
];

export const executeDeterministicDemoPlan = (
  task: VisualRuntimeDemoTask,
): readonly VisualRuntimeExecutionEvent[] => [
  { time: "00:00", label: "Demo task accepted", state: "complete" },
  { time: "00:02", label: "Allowed observation packet assembled", state: "complete" },
  { time: "00:05", label: `Robot followed route to ${task.targetZoneId}`, state: "complete" },
  { time: "00:08", label: "Visible verification evidence captured", state: "complete" },
];

export const verifyDeterministicDemoExecution = (
  task: VisualRuntimeDemoTask,
): VisualRuntimeVerificationResult => ({
  certificateId: `vr-06-demo-${task.id}-certificate`,
  result: "passed",
  evidence: [
    `Target object ${task.targetObjectId} remained visible in the allowed world snapshot.`,
    `Robot route ended at visible target zone ${task.targetZoneId}.`,
    "No hidden simulator truth or provider output was used as evidence.",
  ],
  hiddenSimulatorTruthExposed: false,
});

const createTelemetry = (
  task: VisualRuntimeDemoTask,
  timestamp: string,
): readonly VisualRuntimeTelemetryEvent[] => [
  { id: "T1", at: timestamp, message: `demo task selected: ${task.id}` },
  { id: "T2", at: timestamp, message: "deterministic plan generated without LLM" },
  { id: "T3", at: timestamp, message: "validation gates passed" },
  { id: "T4", at: timestamp, message: "visible robot execution completed" },
  { id: "T5", at: timestamp, message: "allowed-evidence verification passed" },
];

export const createVisualRuntimeDemoRun = (
  options: DemoRuntimeOptions = {},
): VisualRuntimeDemoRunSnapshot => {
  const timestamp = options.now?.() ?? new Date().toISOString();
  const task = getVisualRuntimeDemoTask(options.taskId);
  const plan = createDeterministicDemoPlan(task);
  const validation = validateDeterministicDemoPlan(task, plan);
  const execution = executeDeterministicDemoPlan(task);
  const verification = verifyDeterministicDemoExecution(task);
  const executionPath = visibleRouteByTask(task);

  return {
    runId: `vr-06-demo-${task.id}`,
    mode: "demo_ready",
    task,
    plan,
    validation,
    execution,
    verification,
    telemetry: createTelemetry(task, timestamp),
    worldSnapshot: createWorldSnapshotForTask(task, executionPath),
    executionPath,
    browserReceivesProviderKey: false,
  };
};
