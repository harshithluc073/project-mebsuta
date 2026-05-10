import { VisualRuntimeVerificationOopsRun } from "./verification_oops_contracts";

export type VisualRuntimeAuditSurfaceKind =
  | "event_stream"
  | "memory_write"
  | "plan_history"
  | "verification_evidence"
  | "oops_episode"
  | "redacted_trace";

export interface VisualRuntimeAuditEvent {
  readonly id: string;
  readonly at: string;
  readonly surface: VisualRuntimeAuditSurfaceKind;
  readonly summary: string;
  readonly sourceRef: string;
  readonly hiddenSimulatorTruthExposed: false;
  readonly browserReceivesProviderKey: false;
}

export interface VisualRuntimeMemoryWriteSurface {
  readonly id: string;
  readonly sourceCertificateId: string;
  readonly summary: string;
  readonly authority: "verification_certificate";
  readonly committed: boolean;
  readonly hiddenSimulatorTruthExposed: false;
  readonly browserReceivesProviderKey: false;
}

export interface VisualRuntimePlanHistoryEntry {
  readonly id: string;
  readonly stepId: string;
  readonly label: string;
  readonly state: "ready" | "running" | "complete";
  readonly sourceRunId: string;
}

export interface VisualRuntimeVerificationEvidenceSurface {
  readonly id: string;
  readonly certificateId: string;
  readonly summary: string;
  readonly source: "visible_execution" | "safe_hold_gate" | "allowed_observation";
  readonly hiddenSimulatorTruthExposed: false;
}

export interface VisualRuntimeOopsEpisodeSurface {
  readonly id: string;
  readonly outcome: "success" | "failed";
  readonly retryBudgetRemaining: number;
  readonly safeHoldActive: boolean;
  readonly correctionSummary: string;
  readonly autoCorrectionAllowed: false;
}

export interface VisualRuntimeReplayControlSurface {
  readonly replayId: string;
  readonly sourceRunId: string;
  readonly stateProgression: readonly string[];
  readonly replayedStateProgression: readonly string[];
  readonly stateProgressionMatches: boolean;
  readonly apiKeyPresentInReplay: false;
  readonly controls: readonly ("rewind" | "step_back" | "play" | "step_forward" | "pause")[];
}

export interface VisualRuntimeRedactedTraceEntry {
  readonly id: string;
  readonly source: "telemetry" | "gate" | "verification" | "oops";
  readonly summary: string;
  readonly redactionApplied: boolean;
  readonly hiddenSimulatorTruthExposed: false;
  readonly browserReceivesProviderKey: false;
}

export interface VisualRuntimeObservabilityAuditSnapshot {
  readonly auditId: string;
  readonly generatedAt: string;
  readonly sourceRun: VisualRuntimeVerificationOopsRun;
  readonly eventStream: readonly VisualRuntimeAuditEvent[];
  readonly memoryWrites: readonly VisualRuntimeMemoryWriteSurface[];
  readonly planHistory: readonly VisualRuntimePlanHistoryEntry[];
  readonly verificationEvidence: readonly VisualRuntimeVerificationEvidenceSurface[];
  readonly oopsEpisode: VisualRuntimeOopsEpisodeSurface;
  readonly replay: VisualRuntimeReplayControlSurface;
  readonly redactedTrace: readonly VisualRuntimeRedactedTraceEntry[];
  readonly browserReceivesProviderKey: false;
}
