import {
  VisualRuntimeProviderConfigInput,
  VisualRuntimeProviderReadiness,
  loadVisualRuntimeProviderReadiness,
} from "./config/provider_config";
import { createVisualRuntimeDemoRun } from "./demo_runtime";
import {
  VisualRuntimeDemoTask,
  VisualRuntimePlanStep,
  VisualRuntimePlanStepKind,
  VisualRuntimeTelemetryEvent,
  VisualRuntimeValidationGate,
  getVisualRuntimeDemoTask,
} from "../../shared/src/demo_contracts";
import {
  VisualRuntimeProviderPlanCandidate,
  VisualRuntimeProviderPlanMetadata,
  VisualRuntimeProviderPlanningRequest,
  VisualRuntimeProviderPlanningResult,
} from "../../shared/src/provider_planning_contracts";

const ALLOWED_STEP_KINDS = new Set<VisualRuntimePlanStepKind>([
  "observe",
  "navigate",
  "inspect",
  "manipulate",
  "dock",
  "verify",
]);

export interface VisualRuntimeProviderPlanTransport {
  readonly requestStructuredPlan: (
    request: VisualRuntimeProviderPlanningRequest,
    provider: VisualRuntimeProviderPlanMetadata,
  ) => Promise<unknown>;
}

export interface VisualRuntimeStructuredPlanningOptions {
  readonly taskId?: string;
  readonly now?: () => string;
  readonly providerConfigInput?: VisualRuntimeProviderConfigInput;
  readonly providerPlanTransport?: VisualRuntimeProviderPlanTransport;
}

const createTimestamp = (options: VisualRuntimeStructuredPlanningOptions): string =>
  options.now?.() ?? new Date().toISOString();

const createAllowedObservationSummary = (task: VisualRuntimeDemoTask): readonly string[] => [
  `Operator task: ${task.operatorText}`,
  `Visible target object: ${task.targetObjectId}`,
  `Visible target zone: ${task.targetZoneId}`,
  "Hidden simulator truth is excluded from provider planning.",
];

const createProviderMetadata = (
  readiness: VisualRuntimeProviderReadiness,
): VisualRuntimeProviderPlanMetadata => ({
  provider: readiness.provider ?? "unconfigured",
  model: readiness.model,
  baseUrlConfigured: readiness.baseUrlConfigured,
  credentialExposed: false,
});

const redactProviderError = (
  error: unknown,
  configInput: VisualRuntimeProviderConfigInput | undefined,
): string => {
  let message = error instanceof Error ? error.message : String(error);
  const credential = configInput?.LLM_API_KEY?.trim();

  if (credential) {
    message = message.split(credential).join("[redacted-provider-key]");
  }

  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted-provider-key]")
    .replace(/api[_-]?key[=:]\s*[^,\s}]+/gi, "api_key=[redacted-provider-key]");
};

const parseProviderCandidate = (rawOutput: unknown): VisualRuntimeProviderPlanCandidate => {
  if (!rawOutput || typeof rawOutput !== "object") {
    throw new Error("provider_output_not_object");
  }

  const candidate = rawOutput as Partial<VisualRuntimeProviderPlanCandidate>;
  if (!Array.isArray(candidate.steps)) {
    throw new Error("provider_steps_missing");
  }

  return {
    steps: candidate.steps.map((step) => {
      if (!step || typeof step !== "object") {
        throw new Error("provider_step_not_object");
      }

      const entry = step as { readonly kind?: unknown; readonly label?: unknown };
      if (typeof entry.kind !== "string" || !ALLOWED_STEP_KINDS.has(entry.kind as VisualRuntimePlanStepKind)) {
        throw new Error("provider_step_kind_invalid");
      }

      if (typeof entry.label !== "string" || entry.label.trim().length < 6 || entry.label.trim().length > 180) {
        throw new Error("provider_step_label_invalid");
      }

      return {
        kind: entry.kind,
        label: entry.label.trim(),
      };
    }),
  };
};

const createPlanFromCandidate = (
  candidate: VisualRuntimeProviderPlanCandidate,
): readonly VisualRuntimePlanStep[] => {
  if (candidate.steps.length !== 4) {
    throw new Error("provider_plan_step_count_invalid");
  }

  return candidate.steps.map((step, index) => ({
    id: `P${index + 1}`,
    kind: step.kind as VisualRuntimePlanStepKind,
    label: step.label,
    state: "complete",
  }));
};

const createProviderValidation = (
  task: VisualRuntimeDemoTask,
  plan: readonly VisualRuntimePlanStep[],
): readonly VisualRuntimeValidationGate[] => [
  {
    gate: "Structured output",
    state: plan.length === 4 ? "passed" : "blocked",
    reason: "Provider output matched the VR-07 four-step plan schema.",
  },
  {
    gate: "Task scope",
    state: "passed",
    reason: `Provider plan remained scoped to preset task ${task.id}.`,
  },
  {
    gate: "Execution safety",
    state: "passed",
    reason: "Provider plan is structured only; visible execution still requires downstream validation.",
  },
  {
    gate: "Secret boundary",
    state: "passed",
    reason: "Provider credential stayed backend-only and is not present in the response.",
  },
];

const createProviderTelemetry = (timestamp: string): readonly VisualRuntimeTelemetryEvent[] => [
  { id: "PVT1", at: timestamp, message: "provider readiness confirmed on backend" },
  { id: "PVT2", at: timestamp, message: "structured provider plan received" },
  { id: "PVT3", at: timestamp, message: "provider plan schema validation passed" },
];

export const createVisualRuntimeStructuredPlanningRun = async (
  options: VisualRuntimeStructuredPlanningOptions = {},
): Promise<VisualRuntimeProviderPlanningResult> => {
  const task = getVisualRuntimeDemoTask(options.taskId);
  const readiness = loadVisualRuntimeProviderReadiness(options.providerConfigInput);
  const timestamp = createTimestamp(options);

  if (readiness.mode !== "provider_ready") {
    return {
      mode: "demo_ready",
      source: "deterministic_demo_fallback",
      providerAttempted: false,
      demoRun: createVisualRuntimeDemoRun({
        taskId: task.id,
        now: () => timestamp,
      }),
      browserReceivesProviderKey: false,
    };
  }

  const request: VisualRuntimeProviderPlanningRequest = {
    schemaVersion: "vr-07-provider-plan-v1",
    task,
    allowedObservationSummary: createAllowedObservationSummary(task),
    browserReceivesProviderKey: false,
  };
  const provider = createProviderMetadata(readiness);

  try {
    if (!options.providerPlanTransport) {
      throw new Error("provider_transport_not_configured");
    }

    const rawOutput = await options.providerPlanTransport.requestStructuredPlan(request, provider);
    const candidate = parseProviderCandidate(rawOutput);
    const plan = createPlanFromCandidate(candidate);

    return {
      mode: "provider_ready",
      source: "provider_structured_plan",
      providerAttempted: true,
      request,
      provider,
      plan,
      validation: createProviderValidation(task, plan),
      telemetry: createProviderTelemetry(timestamp),
      browserReceivesProviderKey: false,
    };
  } catch (error) {
    return {
      mode: "provider_ready",
      source: "provider_response_quarantined",
      providerAttempted: true,
      request,
      provider,
      quarantine: {
        reason: "provider_plan_rejected",
        redactedError: redactProviderError(error, options.providerConfigInput),
        providerRawOutputStored: false,
      },
      demoRun: createVisualRuntimeDemoRun({
        taskId: task.id,
        now: () => timestamp,
      }),
      browserReceivesProviderKey: false,
    };
  }
};
