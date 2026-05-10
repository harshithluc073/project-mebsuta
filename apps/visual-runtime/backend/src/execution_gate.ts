import {
  VisualRuntimeDemoTask,
  VisualRuntimePlanStep,
  VisualRuntimePlanStepKind,
  VisualRuntimeTelemetryEvent,
  VisualRuntimeValidationGate,
  getVisualRuntimeDemoTask,
} from "../../shared/src/demo_contracts";
import {
  VisualRuntimeExecutionGateBlockReason,
  VisualRuntimeExecutionGateDecision,
  VisualRuntimeExecutionGateRun,
} from "../../shared/src/execution_gate_contracts";
import { VisualRuntimeVector3 } from "../../shared/src/world_contracts";
import {
  createDeterministicDemoPlan,
  createVisualRuntimeDemoRun,
} from "./demo_runtime";

interface ExecutionGateOptions {
  readonly taskId?: string;
  readonly now?: () => string;
  readonly planOverride?: readonly VisualRuntimePlanStep[];
}

const ALLOWED_STEP_KINDS = new Set<VisualRuntimePlanStepKind>([
  "observe",
  "navigate",
  "inspect",
  "manipulate",
  "dock",
  "verify",
]);

const REQUIRED_GATE_NAMES = [
  "Schema",
  "Task scope",
  "Safety policy",
  "Reachability",
  "Execution primitive",
] as const;

const UNSAFE_TEXT_PATTERNS = [
  /\bexit\b/i,
  /\boutside\b/i,
  /\bcollision\b/i,
  /\bcollide\b/i,
  /\boverride\b/i,
  /\bbypass\b/i,
  /\bdisable safe hold\b/i,
  /\bhuman\b/i,
];

const createGate = (
  gate: (typeof REQUIRED_GATE_NAMES)[number],
  passed: boolean,
  reason: string,
): VisualRuntimeValidationGate => ({
  gate,
  state: passed ? "passed" : "blocked",
  reason,
});

const isOrderedFourStepSchema = (plan: readonly VisualRuntimePlanStep[]): boolean =>
  plan.length === 4 &&
  plan.every((step, index) => {
    const expectedId = `P${index + 1}`;

    return (
      step.id === expectedId &&
      ALLOWED_STEP_KINDS.has(step.kind) &&
      typeof step.label === "string" &&
      step.label.trim().length >= 6 &&
      (step.state === "ready" || step.state === "running" || step.state === "complete")
    );
  });

const staysInsideTaskScope = (
  task: VisualRuntimeDemoTask,
  plan: readonly VisualRuntimePlanStep[],
): boolean => {
  const joinedPlan = plan.map((step) => `${step.kind} ${step.label}`).join(" ").toLowerCase();
  const hasRequiredPrimitive =
    task.id === "return_to_charger"
      ? joinedPlan.includes("dock") || joinedPlan.includes("charging")
      : task.id === "deliver_payload_case"
        ? joinedPlan.includes("payload") || joinedPlan.includes("deliver")
        : joinedPlan.includes("inspect") || joinedPlan.includes("visual");

  return hasRequiredPrimitive && plan.some((step) => step.kind === "verify");
};

const passesSafetyPolicy = (plan: readonly VisualRuntimePlanStep[]): boolean => {
  const joinedPlan = plan.map((step) => step.label).join(" ");

  return !UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(joinedPlan));
};

const routePointIsReachable = (point: VisualRuntimeVector3): boolean =>
  point.x >= -3.8 && point.x <= 3.8 && point.z >= -3 && point.z <= 3 && point.y >= 0 && point.y <= 0.25;

const routeIsReachable = (path: readonly VisualRuntimeVector3[]): boolean =>
  path.length >= 2 && path.every(routePointIsReachable);

const firstBlockedReason = (
  gates: readonly VisualRuntimeValidationGate[],
): VisualRuntimeExecutionGateBlockReason => {
  const blocked = gates.find((gate) => gate.state === "blocked");

  if (!blocked) {
    return "none";
  }

  if (blocked.gate === "Schema") {
    return "invalid_plan";
  }

  if (blocked.gate === "Task scope") {
    return "out_of_scope_task";
  }

  if (blocked.gate === "Safety policy") {
    return "unsafe_policy";
  }

  return "unreachable_route";
};

const createDecision = (
  blockReason: VisualRuntimeExecutionGateBlockReason,
): VisualRuntimeExecutionGateDecision => {
  if (blockReason === "none") {
    return {
      status: "accepted",
      blockReason,
      safeHoldEntered: false,
      executionPrimitive: "visible_route_following",
      summary: "All VR-09 gates passed; visible route execution is authorized.",
    };
  }

  return {
    status: "safe_hold",
    blockReason,
    safeHoldEntered: true,
    executionPrimitive: "safe_hold",
    summary: `Execution blocked by ${blockReason}; robot remains in safe hold.`,
  };
};

const createExecutionEvents = (
  decision: VisualRuntimeExecutionGateDecision,
  run: ReturnType<typeof createVisualRuntimeDemoRun>,
) => {
  if (decision.status === "accepted") {
    return run.execution.map((event) =>
      event.label === "Allowed observation packet assembled"
        ? {
            ...event,
            label: "VR-09 gates passed and allowed observation packet assembled",
          }
        : event,
    );
  }

  return [
    { time: "00:00", label: "Task accepted for validation", state: "complete" },
    { time: "00:01", label: decision.summary, state: "complete" },
    { time: "00:02", label: "Visible execution primitive not started", state: "complete" },
  ] as const;
};

const createGateTelemetry = (
  timestamp: string,
  decision: VisualRuntimeExecutionGateDecision,
): readonly VisualRuntimeTelemetryEvent[] => [
  { id: "G1", at: timestamp, message: "schema validation evaluated" },
  { id: "G2", at: timestamp, message: "task-scope validation evaluated" },
  { id: "G3", at: timestamp, message: "safety policy validation evaluated" },
  { id: "G4", at: timestamp, message: "reachability and zone constraints evaluated" },
  { id: "G5", at: timestamp, message: `execution gate decision: ${decision.status}` },
];

export const createVisualRuntimeExecutionGateRun = (
  options: ExecutionGateOptions = {},
): VisualRuntimeExecutionGateRun => {
  const timestamp = options.now?.() ?? new Date().toISOString();
  const task = getVisualRuntimeDemoTask(options.taskId);
  const baseRun = createVisualRuntimeDemoRun({
    taskId: task.id,
    now: () => timestamp,
  });
  const plan = options.planOverride ?? createDeterministicDemoPlan(task);
  const schemaPassed = isOrderedFourStepSchema(plan);
  const taskScopePassed = schemaPassed && staysInsideTaskScope(task, plan);
  const safetyPassed = schemaPassed && passesSafetyPolicy(plan);
  const reachabilityPassed = routeIsReachable(baseRun.executionPath);
  const executionPrimitivePassed = schemaPassed && taskScopePassed && safetyPassed && reachabilityPassed;
  const validation = [
    createGate("Schema", schemaPassed, "Plan must contain four ordered allowed steps P1 through P4."),
    createGate("Task scope", taskScopePassed, `Plan must remain scoped to preset task ${task.id}.`),
    createGate("Safety policy", safetyPassed, "Plan must not request unsafe motion, collision, bypass, or human interaction."),
    createGate("Reachability", reachabilityPassed, "Visible route must stay inside the local work-cell bounds and known target zones."),
    createGate("Execution primitive", executionPrimitivePassed, "Visible route-following primitive may run only after all prior gates pass."),
  ];
  const decision = createDecision(firstBlockedReason(validation));
  const execution = createExecutionEvents(decision, baseRun);

  return {
    ...baseRun,
    runId: `vr-09-gated-${task.id}`,
    plan,
    validation,
    execution,
    telemetry: [...baseRun.telemetry, ...createGateTelemetry(timestamp, decision)],
    gateDecision: decision,
    executionPath: decision.status === "accepted" ? baseRun.executionPath : [],
    browserReceivesProviderKey: false,
  };
};
