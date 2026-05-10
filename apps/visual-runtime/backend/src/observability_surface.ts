import {
  VisualRuntimeAuditEvent,
  VisualRuntimeAuditSurfaceKind,
  VisualRuntimeObservabilityAuditSnapshot,
  VisualRuntimePlanHistoryEntry,
  VisualRuntimeRedactedTraceEntry,
  VisualRuntimeReplayControlSurface,
} from "../../shared/src/observability_contracts";
import { VisualRuntimePlanStep } from "../../shared/src/demo_contracts";
import { VisualRuntimeVerificationOopsRun } from "../../shared/src/verification_oops_contracts";
import { createVisualRuntimeVerificationOopsRun } from "./verification_oops";

interface ObservabilitySurfaceOptions {
  readonly taskId?: string;
  readonly now?: () => string;
  readonly retryAttemptsUsed?: number;
  readonly planOverride?: readonly VisualRuntimePlanStep[];
  readonly traceInputs?: readonly string[];
}

const REDACTION_PATTERNS: readonly RegExp[] = [
  /MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY/g,
  /\b[a-z]{2}-[A-Za-z0-9_-]{16,}\b/g,
  /\b(provider|credential|secret|token|key)\s*[:=]\s*[^,;\s]+/gi,
];

export const redactVisualRuntimeTraceText = (value: string): { readonly text: string; readonly redactionApplied: boolean } => {
  let redacted = value;

  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }

  return {
    text: redacted,
    redactionApplied: redacted !== value,
  };
};

const createAuditEvent = (
  index: number,
  at: string,
  surface: VisualRuntimeAuditSurfaceKind,
  summary: string,
  sourceRef: string,
): VisualRuntimeAuditEvent => ({
  id: `VR11-E${index}`,
  at,
  surface,
  summary,
  sourceRef,
  hiddenSimulatorTruthExposed: false,
  browserReceivesProviderKey: false,
});

const createPlanHistory = (run: VisualRuntimeVerificationOopsRun): readonly VisualRuntimePlanHistoryEntry[] =>
  run.sourceRun.plan.map((step) => ({
    id: `VR11-PH-${step.id}`,
    stepId: step.id,
    label: step.label,
    state: step.state,
    sourceRunId: run.sourceRun.runId,
  }));

const createStateProgression = (run: VisualRuntimeVerificationOopsRun): readonly string[] => [
  ...run.sourceRun.plan.map((step) => `plan:${step.id}:${step.state}`),
  ...run.sourceRun.validation.map((gate) => `gate:${gate.gate}:${gate.state}`),
  ...run.sourceRun.execution.map((event) => `execution:${event.time}:${event.state}`),
  `verification:${run.outcome}`,
  `oops:safe_hold:${run.oopsLoop.safeHoldActive}`,
];

const createReplay = (
  run: VisualRuntimeVerificationOopsRun,
  replayedRun: VisualRuntimeVerificationOopsRun,
): VisualRuntimeReplayControlSurface => {
  const stateProgression = createStateProgression(run);
  const replayedStateProgression = createStateProgression(replayedRun);

  return {
    replayId: `vr-11-replay-${run.sourceRun.task.id}`,
    sourceRunId: run.sourceRun.runId,
    stateProgression,
    replayedStateProgression,
    stateProgressionMatches: JSON.stringify(stateProgression) === JSON.stringify(replayedStateProgression),
    apiKeyPresentInReplay: false,
    controls: ["rewind", "step_back", "play", "step_forward", "pause"],
  };
};

const createRedactedTrace = (
  run: VisualRuntimeVerificationOopsRun,
  traceInputs: readonly string[],
): readonly VisualRuntimeRedactedTraceEntry[] => {
  const rows: readonly {
    readonly source: VisualRuntimeRedactedTraceEntry["source"];
    readonly summary: string;
  }[] = [
    ...run.sourceRun.telemetry.map((event) => ({
      source: "telemetry" as const,
      summary: event.message,
    })),
    {
      source: "gate" as const,
      summary: run.sourceRun.gateDecision.summary,
    },
    {
      source: "verification" as const,
      summary: run.failure.message,
    },
    {
      source: "oops" as const,
      summary: run.oopsLoop.correctionProposal.action,
    },
    ...traceInputs.map((summary) => ({
      source: "telemetry" as const,
      summary,
    })),
  ];

  return rows.map((row, index) => {
    const redacted = redactVisualRuntimeTraceText(row.summary);

    return {
      id: `VR11-T${index + 1}`,
      source: row.source,
      summary: redacted.text,
      redactionApplied: redacted.redactionApplied,
      hiddenSimulatorTruthExposed: false,
      browserReceivesProviderKey: false,
    };
  });
};

export const createVisualRuntimeObservabilityAuditSnapshot = (
  options: ObservabilitySurfaceOptions = {},
): VisualRuntimeObservabilityAuditSnapshot => {
  const timestamp = options.now?.() ?? new Date().toISOString();
  const run = createVisualRuntimeVerificationOopsRun(options);
  const replayedRun = createVisualRuntimeVerificationOopsRun(options);
  const replay = createReplay(run, replayedRun);

  return {
    auditId: `vr-11-audit-${run.sourceRun.task.id}`,
    generatedAt: timestamp,
    sourceRun: run,
    eventStream: [
      createAuditEvent(1, timestamp, "event_stream", "Runtime telemetry was normalized into an ordered audit stream.", run.sourceRun.runId),
      createAuditEvent(2, timestamp, "memory_write", "Certificate-authorized memory write was prepared from allowed evidence.", run.certificateId),
      createAuditEvent(3, timestamp, "plan_history", "Plan history captured ordered step states for replay.", run.sourceRun.runId),
      createAuditEvent(4, timestamp, "verification_evidence", "Verification evidence surface uses allowed visual and gate summaries.", run.certificateId),
      createAuditEvent(5, timestamp, "oops_episode", "Oops episode surface keeps retry and safe-hold state operator controlled.", run.runId),
      createAuditEvent(6, timestamp, "redacted_trace", "Trace summary was redacted before browser replay exposure.", replay.replayId),
    ],
    memoryWrites: [
      {
        id: `vr-11-memory-${run.sourceRun.task.id}`,
        sourceCertificateId: run.certificateId,
        summary: `Stored safe task summary for ${run.sourceRun.task.label}; current perception remains required before action.`,
        authority: "verification_certificate",
        committed: run.outcome === "success",
        hiddenSimulatorTruthExposed: false,
        browserReceivesProviderKey: false,
      },
    ],
    planHistory: createPlanHistory(run),
    verificationEvidence: run.evidence.map((evidence) => ({
      id: `VR11-VE-${evidence.id}`,
      certificateId: run.certificateId,
      summary: evidence.summary,
      source: evidence.source,
      hiddenSimulatorTruthExposed: false,
    })),
    oopsEpisode: {
      id: `vr-11-oops-${run.sourceRun.task.id}`,
      outcome: run.outcome,
      retryBudgetRemaining: run.oopsLoop.retryBudgetRemaining,
      safeHoldActive: run.oopsLoop.safeHoldActive,
      correctionSummary: run.oopsLoop.correctionProposal.action,
      autoCorrectionAllowed: false,
    },
    replay,
    redactedTrace: createRedactedTrace(run, options.traceInputs ?? []),
    browserReceivesProviderKey: false,
  };
};
